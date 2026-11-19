// Independent assertions against the interrupted S3 prototype; failures are findings.
// Run: bun spikes/s3/verify.ts. All state is disposable; no herdr/user settings changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger, CrashAfterContent, stateHashOf, type OpInput } from './lib/ledger';
import { PrefixIndex } from './lib/paging';
import { hashOf } from './lib/content';

const root = fs.mkdtempSync('/tmp/reclaim-s3-');
const results: Array<{name: string; ok: boolean; detail?: unknown; error?: string}> = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { results.push({name, ok: true, detail: await fn()}); }
  catch (e) { results.push({name, ok: false, error: String(e)}); }
  console.log(JSON.stringify(results.at(-1)));
}
function ledger(name: string, limit?: number) {
  const l = new Ledger(path.join(root, name), {limit});
  l.init('city-fixture');
  return l;
}
function put(l: Ledger, op: OpInput) { const r = l.submit(op); assert.equal(r.ok, true, JSON.stringify(r)); return r; }
function barrier(count: number) {
  let n = 0;
  const {promise: wait, resolve: release} = Promise.withResolvers<void>();
  return async (attempt: number) => { if (attempt !== 1) return; if (++n === count) release(); await wait; };
}
function files(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
try {
  await check('city claim and operation idempotency', () => {
    const l = ledger('claims');
    for (const exp of ['a', 'b']) put(l, {op: 'dispatch-' + exp, k: 'dispatch', exp, gen: 1});
    const claim = hashOf('city-fixture\0src/a.ts\0same-result-blob');
    put(l, {op: 'harvest-a', k: 'harvest', exp: 'a', gen: 1, claim, d: {wood: 10}});
    assert.equal(l.submit({op: 'harvest-b', k: 'harvest', exp: 'b', gen: 1, claim, d: {wood: 10}}).reason, 'claim_exists');
    assert.equal(l.submit({op: 'harvest-a', k: 'harvest', exp: 'a', gen: 1, claim, d: {wood: 10}}).reason, 'duplicate_operation');
    assert.equal(new Ledger(l.dir).rebuildDirect().state.inventory.wood, 10);
  });
  await check('competing inventory spending', async () => {
    const a = ledger('race');
    put(a, {op: 'seed', k: 'genesis', d: {wood: 1}});
    const b = new Ledger(a.dir);
    const gate = barrier(2);
    const r = await Promise.all([
      a.submitAsync({op: 'buy-a', k: 'market', d: {wood: -1, stone: 1}}, {}, gate),
      b.submitAsync({op: 'buy-b', k: 'market', d: {wood: -1, stone: 1}}, {}, gate),
    ]);
    assert.equal(r.filter(x => x.ok).length, 1);
    assert.equal(a.rebuildDirect().state.inventory.wood, 0);
    assert.equal(a.rebuildDirect().state.inventory.stone, 1);
    return r;
  });
  await check('crash after content before journal', () => {
    const l = ledger('crash');
    const op: OpInput = {op: 'credit', k: 'genesis', d: {wood: 10}, content: {proof: 'durable content'}};
    assert.throws(() => l.submit(op, {crashAfterContent: true}), CrashAfterContent);
    const restarted = new Ledger(l.dir);
    assert.equal(restarted.rebuildDirect().state.inventory.wood, 0);
    assert.equal(restarted.rebuildDirect().state.ops.credit, undefined);
    const result = put(restarted, op);
    assert.equal(result.contentReused, true);
    assert.equal(restarted.rebuildDirect().state.inventory.wood, 10);
  });
  await check('20k-path content exact roundtrip', () => {
    const l = ledger('blob');
    const data = Buffer.from(JSON.stringify(Array.from({length: 20_000}, (_, i) => ({path: `src/路徑-${i}.ts`, resultBlob: hashOf(String(i)), claim: hashOf('claim-' + i)}))));
    const r = l.blobs.put(data);
    assert.equal(r.chunked, true);
    assert.deepEqual(l.readContent(r.hash), data);
    const max = Math.max(...files(l.blobs.dir).map(p => fs.statSync(p).size));
    assert.ok(max <= 256 * 1024);
    return {bytes: data.length, files: r.files, depth: r.depth, max};
  });
  await check('prefix splitting and lookup', () => {
    const index = new PrefixIndex(path.join(root, 'index'), 1024);
    const input = new Map(Array.from({length: 10_000}, (_, i) => [`key-${i}`, `value-${i}`]));
    const stats = index.buildFrom(input);
    assert.ok(stats.splits > 0);
    for (const [k, v] of input) assert.equal(index.get(k), v);
    assert.deepEqual(index.all(), input);
    return stats;
  });
  await check('seal versus stale writer inventory recheck', async () => {
    const a = ledger('rotation', 1024);
    put(a, {op: 'seed', k: 'genesis', d: {wood: 1}});
    const b = new Ledger(a.dir, {limit: 1024});
    // b holds an old snapshot while a fills and rotates the segment, then spends.
    const result = await b.submitAsync({op: 'late-spend', k: 'market', d: {wood: -1}}, {}, async attempt => {
      if (attempt !== 1) return;
      for (let i = 0; i < 15; i++) put(a, {op: 'pad-' + i, k: 'research'});
      put(a, {op: 'first-spend', k: 'market', d: {wood: -1}});
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insufficient_wood');
    assert.equal(a.rebuildDirect().state.inventory.wood, 0);
    assert.ok(a.journalStats().seals > 0);
    return result;
  });
  await check('seal stays under configured byte cap', () => {
    const limit = 1024;
    const l = ledger('seal-size', limit);
    const empty = JSON.stringify({seq: 0, op: '', k: 'genesis', d: {}, rv: 1, t: 1}) + '\n';
    put(l, {op: 'x'.repeat(limit - 5 - Buffer.byteLength(empty)), k: 'genesis', t: 1});
    put(l, {op: 'next', k: 'research'});
    assert.ok(l.journalStats().maxSegmentBytes <= limit, JSON.stringify(l.journalStats()));
  });
  await check('harvest points follow v6.1 +20', () => {
    const l = ledger('points');
    put(l, {op: 'dispatch', k: 'dispatch', exp: 'a', gen: 1});
    put(l, {op: 'harvest', k: 'harvest', exp: 'a', gen: 1, claim: 'c', d: {wood: 10}});
    assert.equal(l.rebuildDirect().state.expeditions.a.points, 20);
  });
  await check('closed generation rejects stale harvest after redispatch', () => {
    const l = ledger('generation');
    put(l, {op: 'dispatch', k: 'dispatch', exp: 'a', gen: 1});
    put(l, {op: 'withdraw', k: 'withdraw', exp: 'a', gen: 1});
    put(l, {op: 'redispatch', k: 'redispatch', exp: 'a', gen: 2});
    const stale = l.submit({op: 'old-harvest', k: 'harvest', exp: 'a', gen: 1, claim: 'old', d: {wood: 10}});
    assert.equal(stale.ok, false, 'old-generation harvest was accepted');
  });
  await check('10k expeditions / 100k operations capacity and checkpoint', () => {
    const started = performance.now();
    const l = ledger('capacity');
    const headStart = fs.statSync(l.headPath()).size;
    for (let i = 0; i < 10_000; i++) put(l, {op: `dispatch-${i}`, k: 'dispatch', exp: `e-${i}`, gen: 1, c: [i % 100, Math.floor(i / 100)]});
    for (let i = 0; i < 5_000; i++) put(l, {op: `withdraw-${i}`, k: 'withdraw', exp: `e-${i}`, gen: 1});
    for (let i = 5_000; i < 10_000; i++) {
      put(l, {op: `reclaim-${i}`, k: 'accelerate', exp: `e-${i}`, gen: 1, p: 100});
      put(l, {op: `archive-${i}`, k: 'archive', exp: `e-${i}`, gen: 1});
    }
    for (let i = 25_000; i < 100_000; i++) put(l, {op: `research-${i}`, k: 'research', d: {parchment: 1}});
    const direct = l.rebuildDirect();
    assert.equal(direct.entries, 100_000);
    assert.equal(Object.keys(direct.state.expeditions).length, 10_000);
    assert.equal(direct.state.inventory.parchment, 75_000);
    const checkpoint = l.saveCheckpoint(direct.state.lastSeq, direct.state);
    assert.equal(stateHashOf(new Ledger(l.dir).rebuildViaHead().state), stateHashOf(direct.state));
    const sizes = files(l.dir).map(p => ({path: path.relative(l.dir, p), bytes: fs.statSync(p).size}));
    const over = sizes.filter(p => p.bytes > 256 * 1024);
    const stats = {ms: performance.now() - started, ...l.journalStats(), checkpointMax: checkpoint.maxBytes, headStart, headEnd: fs.statSync(l.headPath()).size, files: sizes.length, over};
    console.log(JSON.stringify({capacity: stats}));
    assert.deepEqual(over, []);
    return stats;
  });
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
console.log(JSON.stringify({passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length}));
process.exitCode = results.some(r => !r.ok) ? 1 : 0;
