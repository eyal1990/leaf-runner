// A real IPC child, with no credentials, model requests, or platform traffic.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { save } from '../../runner-state.mjs';
import { MissionCommands } from '../../mission-control-commands.mjs';

const runs = process.argv[2], runId = randomUUID();
const name = process.argv[3] ?? 'Browser smoke mission';
const suffix = process.argv[3] ? `-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
const target = { kind: 'mission', id: `browser-mission${suffix}`, name, root: `browser-root${suffix}` };
const operator = new MissionCommands({ options: { runs }, target, runId,
  signal: new AbortController().signal, stopAgents: async () => {}, wake() {} });
await operator.load();
const checkpoint = { run_id: runId, target, status: 'RUNNING', started_at: new Date().toISOString(),
  runner_pid: process.pid, preserved_marker: 'browser-checkpoint',
  operator: operator.snapshot() };
process.on('message', async message => {
  if (message.type === 'command' && ['stop-agents', 'resume-agents'].includes(message.command.action)) {
    const command = message.command;
    const receipt = await operator.execute(command);
    checkpoint.operator = operator.snapshot();
    await save(join(runs, 'last-run.json'), checkpoint);
    process.send({ type: 'receipt', id: command.id, receipt });
    return;
  }
  if (message.type !== 'stop') throw new Error(`Unexpected fixture message: ${message.type}`);
  await save(join(runs, 'last-run.json'), { ...checkpoint, status: 'INTERRUPTED', finished_at: new Date().toISOString() });
  process.disconnect();
});
await save(join(runs, 'last-run.json'), checkpoint);
process.send({ type: 'target', target });
process.send({ type: 'ready', runId });
