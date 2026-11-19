// Source-API probe: bun spikes/s6/usage-cost.ts /absolute/path/to/session/session-manager.ts
// Runs real OMP source methods in memory, with isolated settings. No model or session writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const source = process.argv[2];
if (!source) throw new Error('Pass the installed OMP session-manager.ts source path');
const tmp = fs.mkdtempSync('/tmp/reclaim-s6-cost-');
process.env.PI_CODING_AGENT_DIR = tmp;
interface Usage {input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: {input: number; output: number; cacheRead: number; cacheWrite: number; total: number}}
interface Entry {type: string; usage?: Usage; message?: {role: string; usage?: Usage}}
interface Manager {
  getSessionId(): string;
  getEntries(): Entry[];
  getUsageStatistics(): {input: number; output: number; cacheRead: number; cacheWrite: number};
  appendMessage(message: unknown): string;
  appendModelUsage(usage: unknown, owner: {sessionId: string; parentId: null}): string | undefined;
}
try {
  // Runtime-selected installed source; the narrow shape is asserted before use.
  const module = await import(pathToFileURL(path.resolve(source)).href);
  assert.equal(typeof module.SessionManager?.inMemory, 'function');
  const SessionManager: {inMemory(cwd: string): Manager} = module.SessionManager;
  const usage: Usage = {input: 2, output: 1, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  for (const n of [10_000, 100_000]) {
    const sm = SessionManager.inMemory(tmp);
    const owner = {sessionId: sm.getSessionId(), parentId: null};
    const api = 'openai-responses', provider = 'fixture', model = 'fixture';
    for (let i = 0; i < n; i++) {
      if (i % 2) sm.appendMessage({role: 'assistant', content: [], api, provider, model, usage, stopReason: 'stop', timestamp: i});
      else sm.appendModelUsage({purpose: 'fixture', role: 'default', api, provider, model, usage, stopReason: 'stop'}, owner);
    }
    const full = () => {
      const total = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
      for (const e of sm.getEntries()) {
        const u = e.type === 'model_usage' ? e.usage : e.message?.role === 'assistant' ? e.message.usage : undefined;
        if (!u) continue;
        total.input += u.input; total.output += u.output; total.cacheRead += u.cacheRead; total.cacheWrite += u.cacheWrite;
      }
      return total;
    };
    const indexed = sm.getUsageStatistics();
    const expected = {input: 2*n, output: n, cacheRead: 3*n, cacheWrite: 4*n};
    assert.deepEqual(full(), expected);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) assert.equal(indexed[key], expected[key]);
    const samples: Record<string, {medianMs: number; maxMs: number; heapDelta: number}> = {};
    for (const [name, fn] of [['full', full], ['indexed', () => sm.getUsageStatistics()]] as const) {
      fn();
      const before = process.memoryUsage().heapUsed;
      const times: number[] = [];
      for (let i = 0; i < 20; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
      const heapDelta = process.memoryUsage().heapUsed - before;
      times.sort((a,b) => a-b);
      samples[name] = {medianMs: (times[9]+times[10])/2, maxMs: times[19], heapDelta};
    }
    const copies = sm.getEntries();
    assert.notEqual(copies, sm.getEntries());
    assert.equal(copies.length, n);
    sm.appendModelUsage({purpose: 'fixture-new', role: 'default', api, provider, model, usage, stopReason: 'stop'}, owner);
    assert.equal(sm.getUsageStatistics().input, 2*(n+1));
    assert.deepEqual(full(), {input: 2*(n+1), output: n+1, cacheRead: 3*(n+1), cacheWrite: 4*(n+1)});
    console.log(JSON.stringify({entries: n, samples, copiedReferencesPerFullRead: n, samplesPerMethod: 20, indexedMatchesFull: true, newEntryIncluded: true, limitations: 'heapDelta is not allocation volume; indexed totals have no provider/entry identity and include task summaries'}));
  }
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
