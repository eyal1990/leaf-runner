import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { buildSupportReport, sanitizeSupport } from '../support-report.mjs';

test('diagnostics include bounded selected-job logs and state while excluding source files and secrets', async t => {
  const runs = await mkdtemp(join(tmpdir(), 'leaf-support-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  for (const id of ['leaf', 'other']) await mkdir(join(runs, id));
  const secret = 'custom-private-credential';
  await writeFile(join(runs, 'leaf', 'codex-2.log'), 'x'.repeat(40000) + `\nHTTP 500 Bearer bearer-value ${secret} ${homedir()}\n`);
  await writeFile(join(runs, 'leaf', 'prompt-2.txt'), 'PRIVATE PROMPT');
  await writeFile(join(runs, 'leaf', 'solution-2.lean'), 'PRIVATE SOURCE');
  await writeFile(join(runs, 'other', 'codex-3.log'), 'OTHER MISSION');
  const { filename, content } = await buildSupportReport({ runs, secrets: [secret], view: {
    mission: { id: 'mission', target: { root: 'root' }, argv: ['PRIVATE ARGUMENT'], error: secret },
    summary: { run_id: 'run', error: 'HTTP 500' }, configSettings: { path: 'PRIVATE CONFIG PATH', values: { model: 'test' } },
    jobs: [{ theorem_id: 'leaf', root_id: 'root', theorem_name: 'PRIVATE NAME', stage: 'CODEX', failure: { message: 'HTTP 500' },
      history: [{ attempt: 1, root_id: 'other-root', result: 'PRIVATE HISTORY' }] },
    { theorem_id: 'other', root_id: 'other-root', failure: { message: 'OTHER MISSION FAILURE' } }],
  } });
  assert.equal(filename, 'leaf-runner-diagnostics.txt');
  const report = JSON.parse(content);
  assert.equal(report.checkpoint.run_id, 'run');
  assert.equal(report.jobs[0].failure.message, 'HTTP 500');
  assert.equal(report.jobs.length, 1);
  assert.equal(report.jobs[0].history.length, 0);
  assert.equal(report.coverage.jobsFromOtherRootsExcluded, 1);
  assert.equal(report.logs[0].truncated, true);
  assert.equal(report.logs[0].source, '.runs/leaf/codex-2.log');
  assert.ok(report.logs[0].content.length <= 32768);
  assert.match(report.logs[0].content, /HTTP 500 Bearer \[REDACTED\]/);
  assert.match(content, /\[HOME\]/);
  for (const excluded of [secret, 'bearer-value', 'PRIVATE', 'OTHER MISSION']) assert.ok(!content.includes(excluded), excluded);
  assert.match(report.runtime.node, /^v/);
});

test('support redaction covers nested secrets, session URLs, tokens, home paths and oversized data', () => {
  const report = sanitizeSupport({ nested: { api_key: 'unrecognized-value', password: 'password-value' },
    text: 'password=raw-password https://localhost/#session=local-session ghp_exampletoken',
    short: 'short-key', huge: 'x'.repeat(100000), items: Array.from({ length: 150 }, (_, i) => i) }, ['short-key']);
  const content = JSON.stringify(report);
  for (const secret of ['unrecognized-value', 'password-value', 'raw-password', 'local-session', 'ghp_exampletoken', 'short-key']) assert.ok(!content.includes(secret), secret);
  assert.match(report.huge, /TRUNCATED/);
  assert.equal(report.items.length, 101);
  assert.match(report.items.at(-1), /OMITTED: 50 items/);
});

test('diagnostic logs cannot follow a job-directory link into another mission', async t => {
  const runs = await mkdtemp(join(tmpdir(), 'leaf-support-link-'));
  t.after(() => rm(runs, { recursive: true, force: true }));
  await mkdir(join(runs, 'other'));
  await writeFile(join(runs, 'other', 'codex-1.log'), 'OTHER MISSION SECRET');
  try { await symlink(join(runs, 'other'), join(runs, 'leaf'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
  const { content } = await buildSupportReport({ runs, view: { mission: { id: 'm' }, jobs: [{ theorem_id: 'leaf' }] } });
  assert.ok(!content.includes('OTHER MISSION SECRET'));
  assert.equal(JSON.parse(content).logs.length, 0);
  assert.match(content, /Logs unavailable/);
});
