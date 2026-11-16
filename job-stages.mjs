import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicationStore, publicationEntries } from './publication-store.mjs';
import { withBuildSlot } from './shared-resources.mjs';
import { restoreCompiledDependencies } from './compiled-dependencies.mjs';
import { serverOnly } from './verification-mode.mjs';
import { isCodexQuotaError } from './codex-quota.mjs';
import { ProofStoragePaused } from './proof-storage-recovery.mjs';
import { AgentsStopped } from './agent-control.mjs';
import { JobPersistenceError } from './job-store.mjs';
import { retrievalDependencyHints } from './theorem-library.mjs';
import { digest, enc, exists, idOf, json, progress, save, readJson, targetFingerprint, writeIfChanged } from './runner-state.mjs';
import { gate, imports, moduleFor, typeCheckSource, normalizeAnswer, validateAnswer,
  assertFormatOnlyRepair, answerPayload, AnswerFormatError, scopeArtifactNames } from './lean-artifacts.mjs';

function proofOnlyFeedback(candidate, promptExperiment) {
  if (promptExperiment?.variant !== 'proofOnly') return null;
  if (((candidate.kind === 'proof' && candidate.ready === true) ||
       (candidate.kind === 'counterexample' && candidate.ready === false)) &&
      Array.isArray(candidate.children) && candidate.children.length === 0 &&
      Array.isArray(candidate.definitions) && candidate.definitions.length === 0) return null;
  return 'proofOnly requires either kind=proof with ready=true or kind=counterexample with ready=false, always with children=[] and definitions=[], before submission. Complete every helper inside the solution and prove the entire target or its exact full negation. If neither is complete, return kind=proof, ready=false and explain the obstacle.';
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// A validated artifact owns the exact bytes and explanation sent remotely.
// Workspace files are checked for changes, but are never reread for an upload.
async function artifactManifest(candidate, source, target, dir, attempt) {
  const counterexample = candidate.kind === 'counterexample';
  const snapshot = join(dir, `${counterexample ? 'counterexample' : 'solution'}-${attempt}.lean`);
  const explanationPath = join(dir, `${counterexample ? 'counterexample' : 'explanation'}-${attempt}.md`);
  const manifest = freeze({ attempt, kind: candidate.kind ?? 'proof', target_hash: targetFingerprint(target),
    source_hash: digest(source), explanation_hash: digest(candidate.explanation), source,
    snapshot, explanation: candidate.explanation, explanation_path: explanationPath, candidate: structuredClone(candidate) });
  const manifestPath = join(dir, `artifacts-${attempt}.json`);
  if (await exists(manifestPath)) {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (previous.source_hash !== manifest.source_hash || previous.explanation_hash !== manifest.explanation_hash ||
        previous.target_hash !== manifest.target_hash || previous.kind !== manifest.kind ||
        digest(await readFile(previous.snapshot, 'utf8')) !== previous.source_hash ||
        digest(await readFile(previous.explanation_path, 'utf8')) !== previous.explanation_hash) {
      throw new JobPersistenceError('Saved validated artifact changed');
    }
    return freeze({ ...previous, candidate: structuredClone(candidate) });
  }
  await writeFile(snapshot, source);
  await writeFile(explanationPath, candidate.explanation);
  await save(manifestPath, manifest);
  return manifest;
}

// Dependencies are supplied by the serial adapter so process supervision and
// existing public hooks remain in the runner. Stages have no private retry loop.
export function createJobStages({ client, target, context, environment, options, dir, hooks = {},
  ensureWorkspace, mirror, agent, repairAnswer, command, pins, releaseWorkspace }) {
  const mirrorSource = (...args) => (hooks.mirror ?? mirror)(...args);

  async function prepare() {
    const workspace = await (hooks.workspace ?? ensureWorkspace)(environment, {
      ...options, apiVersion: client.version ?? options.apiVersion, workspaceOwner: idOf(target),
      onWorkspaceProgress: hooks.workspaceProgress ?? options.onWorkspaceProgress,
    });
    const notify = hooks.workspaceProgress ?? options.onWorkspaceProgress;
    const started_at = new Date().toISOString();
    const reportDependencies = () => notify?.({ phase: 'dependencies', message: 'Preparing theorem dependencies',
      started_at, updated_at: new Date().toISOString() });
    const heartbeat = notify ? setInterval(reportDependencies, 5000) : null;
    try {
      reportDependencies();
      const knownDependencies = (context.decompositions?.decompositions ?? []).flatMap(reduction => reduction.children ?? []);
      const referenceModules = knownDependencies.filter(row => !row.deprecated_at &&
        (row.definition_id || ['Definition', 'Open', 'Proved'].includes(row.status)))
        .map(row => moduleFor(row.definition_id ? { ...row, status: 'Definition' } : row))
        .filter(module => module !== moduleFor(target));
      const mirroredModules = await mirrorSource(client, workspace, `${target.preamble ?? ''}\n${referenceModules.map(module => `import ${module}`).join('\n')}`,
        target, { knownDependencies });
      try { if (!serverOnly(options)) await restoreCompiledDependencies(workspace, mirroredModules, { ...options, workspaceOwner: idOf(target) }); }
      catch (error) {
        options.signal?.throwIfAborted();
        progress(`[${idOf(target)}] Compiled dependency cache unavailable; Lean will build normally: ${error.message}`);
      }
      return { type: 'PREPARED', workspace, knownDependencies };
    } catch (error) {
      if (!hooks.workspace && releaseWorkspace) await releaseWorkspace(workspace, options);
      throw error;
    } finally { clearInterval(heartbeat); }
  }

  async function invokeModel(input) {
    if (!hooks.invokeAgent) return invokeModelAction(input);
    return hooks.invokeAgent(signal => invokeModelAction({ ...input,
      attemptOptions: { ...(input.attemptOptions ?? options), signal } }));
  }

  async function invokeModelAction({ workspace, attempt, feedback, attemptOptions = options,
    operation = 'implement', candidate, source }) {
    if (!['implement', 'repair', 'repair_candidate', 'repair_artifacts', 'reconsider_argument', 'reconsider_reduction', 'certify_counterexample', 'format_repair'].includes(operation)) throw new Error(`Unknown model operation: ${operation}`);
    hooks.assertModelSlot?.(operation === 'format_repair' ? 'gpt-6-luna' : attemptOptions.model);
    if (operation !== 'format_repair') {
      return { type: 'CANDIDATE', candidate: await (hooks.agent ?? agent)(target, workspace, dir, attempt, feedback,
        { ...attemptOptions, theoremLibraryClient: client }) };
    }
    progress(`Attempt ${attempt}: repairing answer formatting once with Luna; ${feedback}`);
    await save(join(dir, `answer-${attempt}-repair-input.json`), answerPayload(candidate));
    let repaired;
    try {
      repaired = await (hooks.repairAnswer ?? repairAnswer)(target, workspace, dir, attempt, feedback, candidate, attemptOptions);
      assertFormatOnlyRepair(candidate, repaired);
      if (await readFile(candidate.solution, 'utf8') !== source) throw new Error('Repair changed the solution file');
    } catch (failure) {
      await writeFile(candidate.solution, source);
      if (attemptOptions.signal?.aborted || isCodexQuotaError(failure) || failure instanceof ProofStoragePaused || failure instanceof AgentsStopped) throw failure;
      throw new AnswerFormatError(`Answer formatting repair failed: ${failure.message}`);
    }
    repaired = { ...normalizeAnswer(repaired), solution: candidate.solution, module: candidate.module };
    await save(join(dir, `answer-${attempt}-repaired.json`), answerPayload(repaired));
    return { type: 'CANDIDATE', candidate: repaired };
  }

  async function restorePins(workspace) {
    await writeIfChanged(join(workspace, 'lakefile.lean'), pins(environment));
    await writeIfChanged(join(workspace, 'lean-toolchain'), environment.toolchain + '\n');
  }

  async function compile(workspace, candidate, checkedChildren, attempt, suffix = '') {
    if (serverOnly(options)) return;
    const counterexample = candidate.kind === 'counterexample';
    const checkFile = join(dir, counterexample ? 'CheckCounterexample.lean' : 'CheckType.lean');
    const prefix = counterexample ? 'counterexample-' : '';
    await writeFile(checkFile, typeCheckSource(target, candidate.module, checkedChildren, { counterexample }));
    // Finish both checks under one permit. Otherwise a queued readiness build
    // can delay the type check for minutes after the candidate already compiled.
    await withBuildSlot(async () => {
      for (const [args, log] of [
        [['build', candidate.module], join(dir, `${prefix}lean-${attempt}${suffix}.log`)],
        [['env', 'lean', '-DautoImplicit=false', checkFile], join(dir, `${prefix}type-${attempt}${suffix}.log`)],
      ]) {
        const label = `[${idOf(target)}] Lean ${args[0] === 'build' ? 'build' : 'type check'} for attempt ${attempt}${suffix}`;
        try { await (hooks.command ?? command)(options.lake, args, {
          cwd: workspace, log, timeout: (options.leanTimeout ?? 3600) * 1000, signal: options.signal, label, showOutput: true,
        }); }
        catch (error) {
          error.failure = { origin: 'local_validation', category: error.code === 'COMMAND_TIMEOUT' ? 'elaboration_timeout'
            : args[0] === 'build' ? 'compile_error' : 'type_mismatch', diagnostic_path: log };
          if (await exists(log)) error.message += `\n${(await readFile(log, 'utf8')).slice(-20000)}`;
          throw error;
        }
      }
    }, `[${idOf(target)}] Lean validation for attempt ${attempt}${suffix}`);
  }

  async function checkTarget(candidate, source, checkWorkspace = true) {
    const latest = await client.request(`theorems/${enc(idOf(target))}`);
    if (latest.status !== 'Open' || latest.deprecated_at) return { type: 'SKIPPED', status: `SKIPPED (${latest.status})` };
    if (targetFingerprint(latest) !== targetFingerprint(target)) {
      throw new Error(candidate.kind === 'counterexample' ? 'Target changed during counterexample verification' : 'Target changed before submission');
    }
    if (checkWorkspace && await readFile(candidate.solution, 'utf8') !== source) {
      throw new Error(candidate.kind === 'counterexample' ? 'Counterexample changed during verification' : 'Solution changed during verification; retry with stable source');
    }
  }

  async function mirrorProof(workspace, artifact, plan, knownDependencies, localModules, resolvedDependencies = new Map()) {
    const checkedChildren = new Map(plan.children.map(child => [child.theorem_name, child]));
    await mirrorSource(client, workspace, artifact.source, target, {
      direct: plan.kind === 'proof', knownDependencies, localModules, resolvedDependencies,
      onDependency: row => { if (plan.kind === 'sketch' && row.status === 'Open') checkedChildren.set(row.theorem_name, row); },
    });
    return [...checkedChildren.values()];
  }

  async function validate({ workspace, knownDependencies, candidate, attempt, promptExperiment }) {
    const violation = proofOnlyFeedback(candidate, promptExperiment);
    if (violation) return { type: 'INCOMPLETE', feedback: violation + '\n' + candidate.explanation };
    if (candidate.kind !== 'counterexample' && candidate.ready === false) {
      return { type: 'INCOMPLETE', feedback: candidate.explanation };
    }
    const rawSource = await readFile(candidate.solution, 'utf8');
    let source = rawSource.replace(/^\uFEFF/, '');
    if (source !== rawSource) {
      await writeFile(candidate.solution, source, 'utf8');
      progress(`Attempt ${attempt}: removed UTF-8 BOM from solution`);
    }
    gate(source, target);
    const normalized = normalizeAnswer(candidate);
    if (json(answerPayload(normalized)) !== json(answerPayload(candidate))) {
      await save(join(dir, `answer-${attempt}-normalized.json`), answerPayload(normalized));
      progress(`Attempt ${attempt}: corrected answer formatting locally`);
    }
    // Detach the candidate from any model/hook-owned mutable answer object.
    candidate = structuredClone(normalized);
    let plan;
    try { plan = validateAnswer(candidate, target, source); }
    catch (error) {
      if (!(error instanceof AnswerFormatError)) throw error;
      return { type: 'NEEDS_FORMAT_REPAIR', candidate: normalized, source, feedback: error.message, error };
    }
    // Reserve names before freezing. A different statement racing for the same
    // name is deterministically scoped; identical declarations remain reusable.
    const owner = options.runs && (await readJson(join(dir, 'state.json')))?.job_id;
    if (owner && plan.ordered?.length) {
      const reservations = new PublicationStore(options.runs);
      try { await reservations.reserve(publicationEntries(plan, target), owner); }
      catch (error) {
        if (!error.message.startsWith('Conflicting cross-job dependency declaration:')) throw error;
        ({ candidate, source } = scopeArtifactNames(candidate, source, target, attempt));
        gate(source, target);
        plan = validateAnswer(candidate, target, source);
        await reservations.reserve(publicationEntries(plan, target), owner);
        await writeFile(candidate.solution, source);
        await save(join(dir, `answer-${attempt}-scoped.json`), answerPayload(candidate));
        progress(`[${idOf(target)}] Scoped proposed declaration names to avoid a cross-job conflict`);
      }
    }
    candidate = freeze(candidate);
    knownDependencies = [...(knownDependencies ?? []), ...await retrievalDependencyHints(dir, attempt, target)];
    await restorePins(workspace);
    if (candidate.kind === 'counterexample') {
      if (imports(source).some(module => module.startsWith('Theorems.'))) {
        throw new Error('Disproof submissions cannot import platform theorem modules (Theorems.*); use Definitions.* and Mathlib only');
      }
      await mirrorSource(client, workspace, source, target, { direct: true, knownDependencies });
      await compile(workspace, candidate, [], attempt);
    } else {
      // Share live dependency reads within this validation only. Publication
      // validation uses a new map so server changes are still checked afresh.
      const resolvedDependencies = new Map();
      // Reconstruct publishable declarations from the structured answer.
      for (const row of plan.ordered) await mirrorSource(client, workspace, row.definition ?? row.preamble, target,
        { direct: true, knownDependencies, localModules: plan.modules, resolvedDependencies });
      const checkedChildren = await mirrorProof(workspace, { source }, plan, knownDependencies, plan.modules, resolvedDependencies);
      await compile(workspace, candidate, checkedChildren, attempt);
    }
    const skipped = await checkTarget(candidate, source);
    if (skipped) return skipped;
    return { type: 'VALIDATED', artifact: await artifactManifest(candidate, source, target, dir, attempt), plan };
  }

  async function validatePublished({ workspace, knownDependencies, artifact, plan }) {
    if (serverOnly(options)) {
      // The publication boundary checks fresh declaration details and identity.
      return { type: 'VALIDATED', artifact, plan };
    }
    const checkedChildren = await mirrorProof(workspace, artifact, plan, knownDependencies, new Map());
    await compile(workspace, artifact.candidate, checkedChildren, artifact.attempt, '-published');
    return { type: 'VALIDATED', artifact, plan };
  }

  async function checkSubmission(artifact, publishedDependencies = [], promptExperiment) {
    const violation = proofOnlyFeedback(artifact.candidate, promptExperiment);
    if (violation) throw new Error(violation);
    if (serverOnly(options)) await mirrorSource(client, undefined, artifact.source, target, {
      sourceOnly: true, direct: artifact.kind !== 'sketch',
      knownDependencies: [...(context.decompositions?.decompositions ?? []).flatMap(row => row.children ?? []), ...publishedDependencies,
        ...await retrievalDependencyHints(dir, artifact.attempt, target)],
    });
    return checkTarget(artifact.candidate, artifact.source, !serverOnly(options));
  }

  return { prepare, invokeModel, validate, validatePublished, checkSubmission };
}
