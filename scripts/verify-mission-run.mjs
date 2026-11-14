#!/usr/bin/env node
// Independent readback: local journals are evidence to check, never a verdict.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '../prove2me.mjs';
import { digest, enc, idOf, save } from '../runner-state.mjs';
import { reduceHistory, terminalResults, validHistory } from '../attempt-history.mjs';
import { leanEqual } from '../lean-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  root: { type: 'string' },
  since: { type: 'string' },
} });
if (!values.root?.trim()) throw new Error('Required: --root ROOT_THEOREM_ID');
if (values.since && !Number.isFinite(Date.parse(values.since))) throw new Error('Invalid --since timestamp');
const key = process.env.PROVE2ME_API_KEY ?? JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8')).api_key;
const client = new Client(key);
const runs = join(root, '.runs');
const evidence = { checked_at: new Date().toISOString(), root_id: values.root,
  root_status: (await client.request(`theorems/${enc(values.root)}`)).status, jobs: [], errors: [] };
for (const directory of await readdir(runs, { withFileTypes: true })) {
  if (!directory.isDirectory() || !/^[a-z0-9-]+$/i.test(directory.name)) continue;
  let state;
  try { state = JSON.parse(await readFile(join(runs, directory.name, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (state.root_id !== values.root || values.since && Date.parse(state.updated_at) < Date.parse(values.since)) continue;
  const job = { theorem_id: state.theorem_id, job_id: state.job_id, local_status: state.status,
    attempts: state.attempt_count, attempts_used_in_job: state.attempts_used_in_job,
    attempt_budget: state.attempt_budget, publications: [] };
  if (state.schema_version >= 2) {
    const starts = state.history.filter(e => e.event_type === 'attempt' && e.result === 'started');
    const outcomes = state.history.filter(e => e.event_type === 'attempt' && terminalResults.has(e.result));
    job.scored_attempts = reduceHistory(state).totalAttempts;
    if (!validHistory(state) ||
        new Set(starts.map(e => e.attempt)).size !== starts.length ||
        starts.some((e, i) => e.attempt !== state.legacy_baseline.attempts + i + 1) ||
        new Set(outcomes.map(e => e.attempt_id)).size !== outcomes.length) evidence.errors.push(
      state.theorem_id + ': invalid monotonic attempt history');
  }
  if (new Set(state.submissions ?? []).size !== (state.submissions ?? []).length) evidence.errors.push(`${state.theorem_id}: duplicate submission journal ID`);
  for (const record of Object.values(state.publications ?? {})) {
    if (!record.theorem_id && !record.job_id) continue;
    const remoteJob = record.job_id ? await client.request(`publish-jobs/${enc(record.job_id)}`) : null;
    const publishedId = record.theorem_id ?? remoteJob?.theorem_id;
    const publication = { name: record.payload.theorem_name ?? record.payload.definition_name,
      job_id: record.job_id, theorem_id: publishedId, server_status: remoteJob?.status };
    if (publishedId) {
      const row = await client.request(`theorems/${enc(publishedId)}`), payload = record.payload;
      publication.server_status ??= row.status === 'Definition' || ['Open', 'Proved'].includes(row.status) ? 'PUBLISHED' : row.status;
      publication.identity_matches = idOf(row) === publishedId && row.mathlib_rev === state.mathlib_rev &&
        (row.theorem_name ?? row.definition_name) === publication.name && !row.deprecated_at &&
        (payload.definition ? leanEqual(payload.definition, row.definition)
          : leanEqual(payload.formal_statement, row.formal_statement) && leanEqual(payload.preamble, row.preamble));
      if (!publication.identity_matches) evidence.errors.push(`${state.theorem_id}: publication identity mismatch for ${publication.name}`);
      publication.created_at = row.created_at;
    }
    job.publications.push(publication);
  }
  if (state.submission_id) {
    const verdict = await client.request(`verify?submission_id=${enc(state.submission_id)}`);
    const uploaded = await client.request(`submissions/${enc(state.submission_id)}/solution`);
    job.submission = { id: state.submission_id, server_status: verdict.status,
      source_hash_matches: typeof uploaded.content === 'string' && digest(uploaded.content) === state.source_hash };
    if (!job.submission.source_hash_matches) evidence.errors.push(`${state.theorem_id}: uploaded proof bytes differ from the journal`);
    const live = await client.request(`theorems/${enc(state.theorem_id)}`);
    job.theorem_status = live.status;
    if (verdict.status === 'SKETCH_ACCEPTED') {
      const graph = await client.request(`theorems/${enc(state.theorem_id)}/decompositions`);
      job.reduction_linked = graph.decompositions.some(reduction => reduction.submission_id === state.submission_id);
      if (!job.reduction_linked) evidence.errors.push(`${state.theorem_id}: accepted reduction missing from decompositions`);
    }
  }
  evidence.jobs.push(job);
}
evidence.confirmed_submissions = evidence.jobs.filter(job => job.submission?.source_hash_matches &&
  ['ACCEPTED', 'SKETCH_ACCEPTED'].includes(job.submission.server_status)).length;
evidence.confirmed_publications = evidence.jobs.flatMap(job => job.publications).filter(row => row.identity_matches).length;
if (values.since) evidence.new_confirmed_publications = evidence.jobs.flatMap(job => job.publications)
  .filter(row => row.identity_matches && Date.parse(row.created_at) >= Date.parse(values.since)).length;
await save(join(runs, 'diagnostics/live-server-validation.json'), evidence);
console.log(JSON.stringify(evidence, null, 2));
if (evidence.errors.length) process.exitCode = 1;
