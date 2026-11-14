import defaults from './runner-config.json' with { type: 'json' };
import { digest, json } from './runner-state.mjs';

export const DEFAULT_ATTEMPT_MODEL = 'luna-6-high';
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Friendly profiles encode both the real Codex model ID and reasoning effort.
// Raw model IDs remain usable, including through the existing --model flag.
export function modelProfile(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /\s/.test(value)) {
    throw new Error('Model profile must be a nonempty model name without whitespace');
  }
  const alias = value.match(/^(luna|sol|astra|terra)-(\d+(?:\.\d+)*?)-([a-z]+)$/);
  if (alias) {
    if (!efforts.includes(alias[3])) throw new Error(`Invalid reasoning effort in model profile: ${value}`);
    return { model: `gpt-${alias[2]}-${alias[1]}`, reasoningEffort: alias[3], modelProfile: value };
  }
  const suffix = value.match(new RegExp(`^(.+)-(${efforts.join('|')})$`));
  return { model: suffix?.[1] ?? value, reasoningEffort: suffix?.[2] ?? 'high', modelProfile: value };
}

export function validateAttemptModels(value) {
  if (!Array.isArray(value)) throw new Error('attemptModels must be an array of model profiles');
  for (const entry of value) modelProfile(entry);
  return [...value];
}

export function validateIncompleteEscalation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('incompleteEscalation must be an object');
  for (const key of Object.keys(value)) if (!['after', 'model', 'maxAttempts'].includes(key)) throw new Error(`Unknown incompleteEscalation setting: ${key}`);
  const policy = { after: 2, model: 'sol-6.1-high', maxAttempts: null, ...value };
  if (!Number.isSafeInteger(policy.after) || policy.after < 0) throw new Error('incompleteEscalation.after must be a nonnegative integer');
  if (policy.maxAttempts !== null && (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 0)) {
    throw new Error('incompleteEscalation.maxAttempts must be null or a nonnegative integer');
  }
  modelProfile(policy.model);
  return policy;
}

function escalationPolicy(options) {
  return validateIncompleteEscalation({ ...defaults.incompleteEscalation,
    ...options.pipeline?.incompleteEscalation, ...options.incompleteEscalation,
    ...options.runtimeSettings?.incompleteEscalation });
}

export const isSolModel = model => /^gpt-\d+(?:\.\d+)?-sol$/.test(model);

// Ignore commentary and formatting, but preserve all executable tokens and
// string contents. Incomplete files often contain revised research notes only.
export function proofProgressHash(source) {
  if (source === null) return digest(json(null));
  if (typeof source !== 'string') return undefined;
  const tokens = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('--', i)) { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (source.startsWith('/-', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/-', i)) { depth++; i += 2; }
        else if (source.startsWith('-/', i)) { depth--; i += 2; }
        else i++;
      }
      // An unfinished comment is a changed artifact, not evidence of a stall.
      if (depth) return undefined;
      continue;
    }
    const raw = source.slice(i).match(/^r(#+)?"/);
    if (raw) {
      const end = source.indexOf('"' + (raw[1] ?? ''), i + raw[0].length);
      if (end < 0) return undefined;
      const length = end + 1 + (raw[1]?.length ?? 0);
      tokens.push(source.slice(i, length)); i = length; continue;
    }
    if (source[i] === '"') {
      const start = i++; let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i++] === '"') { closed = true; break; }
      }
      if (!closed) return undefined;
      tokens.push(source.slice(start, i)); continue;
    }
    if (source[i] === '«') {
      const end = source.indexOf('»', i + 1);
      if (end < 0) return undefined;
      tokens.push(source.slice(i, end + 1)); i = end + 1; continue;
    }
    const token = source.slice(i).match(/^[\p{L}\p{N}_'][\p{L}\p{N}_'.]*|^[!#$%&*+\-/:<=>?@\\^|~]+/u)?.[0];
    tokens.push(token ?? source[i]); i += token?.length ?? 1;
  }
  return digest(json(tokens));
}

const blockerStopWords = new Set(('about after again also argument available been before being both bounded cannot checked complete could current does each either enough exact existing family first formal found from have here independent inspected into itself lemma lemmas local mathematical missing neither needed obligation obligations other parent plausible previous proof prove proved proving provide remains remaining required result results same should source statement still such supplied target than that their them then there these they this those through under unchanged unproved using validation verified which while with without would').split(' '));
for (const word of ('actual alone appears artifact asserting because candidate central certificate certify checked child children claim conclusion concrete core corresponding counterexample declaration decomposition derivation derive deriving describe direct earlier establish every explanatory grounded honestly identifies imported incomplete independently inhabitant inspection instead itself lean leaving merely meaningful most named natural needs negation notes obstacle outline pinned placeholders propose proposed provide rather records reduction refined repeat requires requested reviewed route saved showing simply sketch sol solution solutions specifically step submit supply theorem unavailable uniform uniformly unresolved updated useful vacuity when workspace').split(' ')) blockerStopWords.add(word);

function blockerTerms(explanation) {
  // Only sentences explicitly describing an unresolved obligation contribute.
  const sentences = explanation.split(/(?<=[.!?])\s+|\n+/).filter(sentence =>
    /\b(?:unresolved|unproved|missing|obstacle|incomplete|requires?|needs?|lacks?|remaining|cannot|not (?:prove|establish|supply|provide))\b/i.test(sentence));
  return [...new Set((sentences.join(' ').toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])
    .filter(term => !blockerStopWords.has(term) && !term.startsWith('sol_'))
    .map(term => term.endsWith('s') && !/(?:ss|ous|is)$/.test(term) && term.length > 4 && !term.includes('_') ? term.slice(0, -1) : term))].sort().slice(0, 256);
}

// Keep the original identity for exact-output and legacy comparisons. The
// additional evidence permits conservative comparisons of reworded blockers.
export function incompleteEvidence(candidate, sourceHash, model, source) {
  const explanation = candidate.explanation?.trim().replace(/\s+/g, ' ');
  if (!explanation) return undefined;
  const progress = proofProgressHash(source);
  return { schema_version: progress ? 2 : 1, model, source_hash: sourceHash,
    ...(progress ? { progress_fingerprint: digest(json({ source: progress, kind: candidate.kind ?? 'proof',
      children: candidate.children ?? [], definitions: candidate.definitions ?? [] })),
      blocker_terms: blockerTerms(explanation) } : {}),
    fingerprint: digest(json({ kind: candidate.kind ?? 'proof', explanation,
      source_hash: sourceHash, children: candidate.children ?? [], definitions: candidate.definitions ?? [] })) };
}

function sameBlocker(previous, current) {
  if (previous.progress_fingerprint !== current.progress_fingerprint) return false;
  const a = previous.blocker_terms, b = current.blocker_terms;
  if (!Array.isArray(a) || !Array.isArray(b) || Math.min(a.length, b.length) < 6) return false;
  const shared = a.filter(term => b.includes(term)).length;
  // High overlap and unchanged code are evidence, not a semantic equivalence
  // claim. Short generic refusals and unrelated obstacles fail closed.
  return shared >= 6 && shared / Math.min(a.length, b.length) >= 0.6;
}

// Exact repetition uses the configured threshold. Reworded blockers require
// at least three outcomes with unchanged code and pairwise strong overlap.
// Legacy incomplete counters alone cannot authorize a paid rescue.
// Once confirmed, keep the rescue active until recorded proof/declaration
// progress or acceptance. Failed calls and changed diagnostics are not progress.
export function incompleteEscalation(state = {}, options = {}) {
  const policy = escalationPolicy(options);
  if (!policy.after || policy.maxAttempts === 0) return null;
  const excluded = new Set((state.history ?? []).filter(e => e.event_type === 'attempt_exclusion').map(e => e.attempt));
  const seen = new Set();
  const rescues = new Set();
  let count = 0, exactTrigger = null, active = null, fingerprint = null, repeated = [];
  for (const event of state.history ?? []) {
    if (event.event_type !== 'attempt' || excluded.has(event.attempt) || event.context_id !== (state.context_id ?? 'initial')) continue;
    if (event.result === 'started') {
      if (active && event.escalation?.reason === 'repeated_incomplete' && event.escalation.automatic !== false &&
          event.model !== 'gpt-6-luna') rescues.add(event.attempt_id);
      continue;
    }
    if (seen.has(event.attempt_id)) continue;
    seen.add(event.attempt_id);
    const evidence = event.failure?.stagnation;
    if (active) {
      const progress = ['sketch_accepted', 'proof_accepted', 'disproof_accepted'].includes(event.result) ||
        event.result === 'incomplete' && event.failure?.category === 'incomplete_argument' &&
        evidence?.schema_version === 2 && /^[a-f0-9]{64}$/.test(evidence.progress_fingerprint) &&
        evidence.progress_fingerprint !== active.progress_fingerprint;
      if (!progress) continue;
      active = null; count = 0; exactTrigger = null; fingerprint = null; repeated = []; rescues.clear();
    }
    // Baseline workers establish stalls; a rescue's changed proof must return
    // to the base profile before a new stall episode can be established.
    if (event.result === 'incomplete' && event.failure?.category === 'incomplete_argument' &&
        evidence?.schema_version === 2 && ['gpt-6-luna', 'gpt-6.1-terra'].includes(evidence.model) &&
        /^[a-f0-9]{64}$/.test(evidence.fingerprint) &&
        /^[a-f0-9]{64}$/.test(evidence.progress_fingerprint) && Array.isArray(evidence.blocker_terms) && evidence.blocker_terms.length >= 6) {
      if (fingerprint !== evidence.fingerprint) { count = 0; exactTrigger = null; }
      fingerprint = evidence.fingerprint;
      count++;
      if (!exactTrigger && count >= policy.after) exactTrigger = event;
      const comparable = evidence.schema_version === 2 && /^[a-f0-9]{64}$/.test(evidence.progress_fingerprint);
      if (!comparable) repeated = [];
      else {
        // Keep a consecutive suffix; an intervening different obstacle resets
        // the sequence even if the same older blocker appears again later.
        while (repeated.length && !repeated.every(row => sameBlocker(row.failure.stagnation, evidence))) repeated.shift();
        repeated.push(event);
        repeated = repeated.slice(-Math.max(3, policy.after));
      }
      const sharedTerms = repeated.length ? repeated[0].failure.stagnation.blocker_terms
        .filter(term => repeated.every(row => row.failure.stagnation.blocker_terms.includes(term))) : [];
      const trigger = exactTrigger ?? (repeated.length >= Math.max(3, policy.after) && sharedTerms.length >= 6 ? repeated.at(-1) : null);
      if (trigger) active = { trigger_attempt: trigger.attempt, trigger_attempt_id: trigger.attempt_id,
        stagnation_fingerprint: fingerprint, progress_fingerprint: evidence.progress_fingerprint,
        evidence_kind: exactTrigger ? 'identical_output' : 'unchanged_code_repeated_blocker',
        evidence_attempts: exactTrigger ? count : repeated.length };
    } else if (event.result !== 'interrupted') {
      count = 0; exactTrigger = null; fingerprint = null; repeated = []; rescues.clear();
    }
  }
  return active ? { reason: 'repeated_incomplete', after: policy.after, model_profile: policy.model,
    ...active, context_id: state.context_id ?? 'initial',
    attempts: rescues.size, max_attempts: policy.maxAttempts,
    pending: policy.maxAttempts === null || rescues.size < policy.maxAttempts } : null;
}

function strongerProfile(base, elevated) {
  if (base.model === elevated.model) return efforts.indexOf(base.reasoningEffort) >= efforts.indexOf(elevated.reasoningEffort) ? base : elevated;
  // Preserve custom/future profiles and higher configured model families.
  const tiers = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'];
  const current = tiers.indexOf(base.model), next = tiers.indexOf(elevated.model);
  return current >= 0 && (next < 0 || next > current) ? elevated : base;
}

export function attemptModel(attempt, options = {}, state = {}) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Model attempt must be a positive integer');
  const override = options.runtimeSettings?.attemptModels;
  const schedule = validateAttemptModels(override ?? options.attemptModels ?? options.pipeline?.attemptModels ?? defaults.attemptModels ?? []);
  const explicit = override ? undefined : options.model;
  const base = modelProfile(explicit ?? schedule[Math.min(attempt - 1, schedule.length - 1)] ?? DEFAULT_ATTEMPT_MODEL);
  const escalation = incompleteEscalation(state, options);
  if (!escalation) return base;
  // A quota continuation is the same rescue, not a new paid attempt, even
  // when an operator explicitly configures a finite rescue cap.
  const resume = state.codex_quota_wait && (escalation.max_attempts === null || escalation.attempts <= escalation.max_attempts) &&
    state.history?.some(e => e.attempt_id === state.attempt_id && e.result === 'started' &&
      e.escalation?.reason === 'repeated_incomplete' && e.model !== 'gpt-6-luna');
  if (!escalation.pending && !resume) return base;
  const selected = explicit ? base : strongerProfile(base, modelProfile(escalation.model_profile));
  return { ...selected, escalation: { ...escalation, automatic: !explicit &&
    (selected.model !== base.model || selected.reasoningEffort !== base.reasoningEffort) } };
}
