// Read-only audit of saved runner artifacts and Codex rollouts. Does not invoke a model.
// Usage: node scripts/analyze-agent-usage.mjs [Codex home] [output JSON]
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const root = process.cwd();
const codex = process.argv[2] ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
const destination = process.argv[3] ?? '.runs/usage-audit.json';
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const json = p => parse(read(p));
const chars = value => value === undefined ? 0 : JSON.stringify(value).length;
const size = p => { try { return fs.statSync(p).size; } catch { return 0; } };
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const logs = new Map();
const artifacts = process.argv.includes('--reuse-artifacts') ? (json(destination)?.artifacts ?? []) : [];
for (const artifact of artifacts) if (artifact.thread) logs.set(artifact.thread, artifact);
for (const entry of artifacts.length ? [] : fs.readdirSync('.runs', { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
  const dir = path.join('.runs', entry.name), state = json(path.join(dir, 'state.json')) ?? {};
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^codex-(\d+)(-repair)?\.log$/);
    if (!match) continue;
    const attempt = Number(match[1]), text = read(path.join(dir, name));
    const events = text.split('\n').map(parse).filter(Boolean);
    const thread = events.find(e => e.type === 'thread.started')?.thread_id;
    const timing = json(path.join(dir, name + '.timing.json'));
    const manifest = json(path.join(dir, `attempt-context-${attempt}.json`));
    const start = state.history?.find(e => e.event_type === 'attempt' && e.attempt === attempt && e.result === 'started');
    const end = state.history?.find(e => e.event_type === 'attempt' && e.attempt === attempt && e.result !== 'started');
    const commands = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => ({ command: e.item.command, output_chars: e.item.aggregated_output?.length ?? 0 }));
    const artifact = {
      target_id: entry.name, attempt, repair: !!match[2], thread, log: path.join(dir, name),
      model: start?.model ?? timing?.label?.match(/\((gpt-[^)]+)\)/)?.[1], started: start?.observed_at,
      result: end?.result, failure: end?.failure, timing, log_bytes: size(path.join(dir, name)),
      prompt_bytes: size(path.join(dir, `prompt-${attempt}${match[2] ?? ''}.txt`)),
      context_bytes: size(path.join(dir, 'context.json')), manifest_bytes: size(path.join(dir, `attempt-context-${attempt}.json`)),
      manifest_fields_chars: Object.fromEntries(Object.entries(manifest ?? {}).map(([k,v]) => [k, chars(v)])),
      operation: manifest?.operation, mission_research: manifest?.mission_research,
      outcome_usage: events.findLast(e => e.type === 'turn.completed')?.usage,
      error: events.findLast(e => e.type === 'turn.failed')?.error,
      command_count: commands.length, command_output_chars: commands.reduce((s,c) => s+c.output_chars,0),
      largest_commands: commands.toSorted((a,b) => b.output_chars-a.output_chars).slice(0,8),
    };
    artifacts.push(artifact);
    if (thread) logs.set(thread, artifact);
  }
}
console.error(`Indexed ${artifacts.length} saved attempt logs; scanning rollouts.`);

const sessions = [];
const sessionDirectory = path.join(codex, 'sessions');
for (const file of files(sessionDirectory).filter(f => f.endsWith('.jsonl'))) {
  const content = read(file), first = parse(content.split('\n',1)[0]);
  if (!first || first.type !== 'session_meta') continue;
  const meta = first.payload, artifact = logs.get(meta.id);
  if (!artifact && !meta.cwd?.toLowerCase().includes(path.basename(root).toLowerCase())) continue;
  const events = content.split('\n').map(parse).filter(Boolean);
  const turn = events.find(e => e.type === 'turn_context')?.payload ?? {};
  const user = events.find(e => e.type === 'response_item' && e.payload?.role === 'user' &&
    e.payload.content?.some(c=>/^(Prove the exact attached Lean 4 theorem|Repair only this answer)/.test(c.text??'')))?.payload ??
    events.filter(e => e.type === 'response_item' && e.payload?.role === 'user')
      .toSorted((a,b)=>chars(b.payload.content)-chars(a.payload.content))[0]?.payload;
  const prompt = user?.content?.map(c => c.text ?? '').join('\n') ?? '';
  const records = events.filter(e => e.type === 'token_usage_record');
  const unique = [...new Map(records.map(e => [e.payload.response_id, e])).values()];
  const tokens = events.filter(e => e.type === 'event_msg' && e.payload.type === 'token_count');
  const usage = unique.length ? unique.reduce((s,e) => {
    for (const [k,v] of Object.entries(e.payload.usage)) s[k]=(s[k]??0)+v;
    return s;
  }, {}) : tokens.findLast(e => e.payload.info)?.payload.info.total_token_usage;
  const perCall = unique.length ? unique.map(e => ({ timestamp: e.timestamp, ...e.payload.usage })) :
    tokens.filter((e,i) => e.payload.info && (i===0 || JSON.stringify(e.payload.info.total_token_usage)!==JSON.stringify(tokens[i-1].payload.info?.total_token_usage)))
      .map(e => ({ timestamp: e.timestamp, ...e.payload.info.last_token_usage }));
  const limits = tokens.filter(e => e.payload.rate_limits).map(e => ({ timestamp:e.timestamp, ...e.payload.rate_limits }));
  const calls = new Map();
  const outputs = [];
  for (const e of events) if (e.type === 'response_item') {
    const p = e.payload;
    if (p.type === 'function_call' || p.type === 'custom_tool_call') calls.set(p.call_id, { name:p.name, args:parse(p.arguments) ?? p.arguments ?? p.input });
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const call = calls.get(p.call_id), command = call?.args?.cmd ?? call?.args?.command ?? JSON.stringify(call?.args ?? '');
      const category = /codex-\d+\.log/.test(command) ? 'prior_transcript' : /references[\\/]?(prove|lean-setup)|prove\.md|lean-setup\.md/.test(command) ? 'reference_docs' :
        /attempt-context|context\.json/.test(command) ? 'context_manifest' : /mission-research|research-\d|notes\.md|manifest\.json/.test(command) ? 'mission_research' :
        /Mathlib|Theorems[\\/]|Definitions[\\/]|\.lean/.test(command) ? 'lean_source' : 'other';
      const output = typeof p.output === 'string' ? p.output : (p.output??[]).map(c=>c.text??'').join('\n');
      outputs.push({ name:call?.name, category, command, chars:output.length });
    }
  }
  const inputSizes = perCall.map(e=>e.input_tokens??0);
  sessions.push({ id:meta.id, file, started:meta.timestamp, ended:events.at(-1)?.timestamp, cwd:meta.cwd,
    cli_version:meta.cli_version, source:meta.source, model:turn.model??meta.model??artifact?.model, effort:turn.effort,
    service_tier:turn.service_tier, originator:meta.originator,
    is_runner:turn.model !== 'codex-auto-review' && (!!artifact || /^(Prove the exact attached Lean 4 theorem|Repair only this answer)/.test(prompt)),
    is_mission_review:/mission-research/.test(meta.cwd??''), artifact,
    initial_prompt_chars:prompt.length, base_instruction_chars:chars(meta.base_instructions),
    developer_message_chars:events.filter(e=>e.type==='response_item'&&e.payload.role==='developer').map(e=>chars(e.payload.content)),
    usage, calls:perCall.length, first_input:inputSizes[0], last_input:inputSizes.at(-1), max_input:Math.max(0,...inputSizes), per_call:perCall,
    first_limit:limits.find(l=>l.limit_id==='codex')??limits[0],
    last_limit:limits.findLast(l=>l.limit_id==='codex')??limits.at(-1), limits,
    outputs_by_category:outputs.reduce((s,o)=>{s[o.category]=(s[o.category]??0)+o.chars;return s;},{}),
    output_chars:outputs.reduce((s,o)=>s+o.chars,0), largest_outputs:outputs.toSorted((a,b)=>b.chars-a.chars).slice(0,8),
  });
  if (sessions.length % 500 === 0) console.error(`Read ${sessions.length} project rollouts.`);
}
sessions.sort((a,b)=>a.started.localeCompare(b.started));
const sum=(rows,fn)=>rows.reduce((s,r)=>s+(fn(r)??0),0);
const median=xs=>{xs=xs.filter(Number.isFinite).toSorted((a,b)=>a-b);return xs.length?xs[Math.floor(xs.length/2)]:null;};
function aggregate(rows) {
  const input=sum(rows,r=>r.usage?.input_tokens),cached=sum(rows,r=>r.usage?.cached_input_tokens),output=sum(rows,r=>r.usage?.output_tokens);
  return {sessions:rows.length,with_usage:rows.filter(r=>r.usage).length,input,cached,uncached:input-cached,output,
    reasoning:sum(rows,r=>r.usage?.reasoning_output_tokens),cache_pct:input?100*cached/input:null,
    median_first_input:median(rows.map(r=>r.first_input)),median_max_input:median(rows.map(r=>r.max_input)),
    median_calls:median(rows.map(r=>r.calls)),median_prompt_chars:median(rows.map(r=>r.initial_prompt_chars)),
    median_manifest_bytes:median(rows.map(r=>r.artifact?.manifest_bytes)),
    output_chars:sum(rows,r=>r.output_chars),prior_transcript_chars:sum(rows,r=>r.outputs_by_category.prior_transcript),
    refs_chars:sum(rows,r=>r.outputs_by_category.reference_docs),
    models:Object.fromEntries([...new Set(rows.map(r=>r.model))].map(m=>[m,rows.filter(r=>r.model===m).length]))};
}
const runner=sessions.filter(s=>s.is_runner);
const group=(rows,key)=>Object.fromEntries([...new Set(rows.map(key))].sort().map(k=>[k,aggregate(rows.filter(r=>key(r)===k))]));
const summary={ runner_sessions:runner.length, artifacts:artifacts.length, matched:runner.filter(r=>r.artifact).length,
  by_day:group(runner,r=>new Date(new Date(r.started).getTime()+3*3600000).toISOString().slice(0,10)),
  by_model:group(runner,r=>r.model),
  recent:runner.slice(-12).map(r=>({id:r.id,date:r.started,model:r.model,attempt:r.artifact?.attempt,result:r.artifact?.result,error:r.artifact?.error,
    usage:r.usage,first:r.first_input,max:r.max_input,calls:r.calls,prompt_chars:r.initial_prompt_chars,manifest:r.artifact?.manifest_bytes,
    output_chars:r.output_chars,prior_log:r.outputs_by_category.prior_transcript,first_limit:r.first_limit,last_limit:r.last_limit})),
  other_sessions:group(sessions.filter(s=>!s.is_runner),r=>r.model??'unknown') };
fs.writeFileSync(destination, JSON.stringify({generated_at:new Date().toISOString(),summary,sessions,artifacts},null,2));
console.log(JSON.stringify(summary,null,2));
