// Test the actual S1/S2 extension against the proposed S6 contract, without agents/models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const tmp = fs.mkdtempSync('/tmp/reclaim-s6-baseline-');
process.env.HERDR_RECLAIM_STATE = path.join(tmp, 'state');
process.env.HC_TERMINAL_ID = 'fixture-terminal';
delete process.env.OMPCODE;
// Test loading boundary: the baseline captures environment variables at module initialization.
const {default: extension} = await import('../../omp-extension/herdr-reclaim');
type Api = Parameters<typeof extension>[0];
type Handler = Parameters<Api['on']>[1];
type Context = Parameters<Handler>[1];
const handlers = new Map<string, Handler>();
extension({on: (event, handler) => { handlers.set(event, handler); }});
const results: Array<{name: string; ok: boolean; detail?: unknown; error?: string}> = [];
function check(name: string, fn: () => unknown) {
  try { results.push({name, ok: true, detail: fn()}); }
  catch (e) { results.push({name, ok: false, error: String(e)}); }
}
interface FixtureEntry {
  type: string;
  id?: string;
  provider: string;
  usage: {input: number; output?: number; cacheRead?: number};
}
function context(id: string, file: string, parent?: string, entries: FixtureEntry[] = []): Context {
  return {hasUI: true, sessionManager: {
    getSessionId: () => id, getSessionFile: () => file, getHeader: () => ({parentSession: parent}),
    getCwd: () => tmp, getEntries: () => entries,
  }};
}
function read(id: string) { return JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'sessions', id + '.json'), 'utf8')); }
try {
  const rootFile = path.join(tmp, '2026_root.jsonl');
  fs.writeFileSync(rootFile, JSON.stringify({type: 'session', id: 'root'}) + '\n');
  check('interactive top-level fork is a new root', () => {
    handlers.get('session_start')!(undefined, context('fork', path.join(tmp, '2026_fork.jsonl'), rootFile));
    assert.equal(read('fork').rootSessionId, 'fork');
  });
  check('same session writers retain independent histories', () => {
    const first = [{type: 'model_usage', provider: 'fixture', usage: {input: 7}}];
    const second = [{type: 'model_usage', provider: 'fixture', usage: {input: 3}}];
    handlers.get('agent_end')!(undefined, context('same-session', rootFile, undefined, first));
    handlers.get('agent_end')!(undefined, context('same-session', rootFile, undefined, second));
    // The S6 protocol needs both epoch records; the baseline only retains the last snapshot.
    const activity = path.join(tmp, 'state', 'activity', 'same-session');
    assert.ok(fs.existsSync(activity), 'per-epoch activity directory is absent; last snapshot input=' + read('same-session').byProvider.fixture.input);
  });
  check('baseline does not emit the S6 durable event protocol', () => {
    const output = read('same-session');
    return {writerEpoch: 'writerEpoch' in output, events: 'events' in output, registeredEvents: [...handlers.keys()]};
  });
  for (const n of [10_000, 100_000]) check(`full rescan ${n} entries`, () => {
    const entries = Array.from({length: n}, (_, i) => ({type: 'model_usage', id: String(i), provider: 'fixture', usage: {input: 2, output: 1, cacheRead: 3}}));
    const ctx = context('perf', rootFile, undefined, entries);
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    handlers.get('turn_end')!(undefined, ctx);
    const ms = performance.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heap;
    const actual = read('perf').byProvider.fixture;
    assert.equal(actual.input, 2 * n);
    assert.equal(actual.output, n);
    assert.equal(actual.cacheRead, 3 * n);
    return {entries: n, ms, heapDelta, note: 'single full rescan plus atomic JSON write; heap delta is not allocation count; no incremental implementation exists'};
  });
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
for (const r of results) console.log(JSON.stringify(r));
process.exitCode = results.some(r => !r.ok) ? 1 : 0;
