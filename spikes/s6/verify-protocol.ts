// S6 isolated protocol experiment, NOT the installed adapter.
// bun spikes/s6/verify-protocol.ts
// Real files/CAS/Git worktrees; no model, child agent, user config, or herdr UI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { casWrite } from '../s3/lib/cas';

type Role = 'root' | 'child' | 'fork';
type Kind = 'visit_start' | 'visit_end' | 'interval_open' | 'heartbeat' | 'interval_close' | 'usage' | 'turn_end';
interface Usage { inputNonCache: number; cacheRead: number; cacheWrite: number; output: number; costKnown: number; costUnknownEntries: number }
interface Visit { visitId: string; cwd: string; commonDir: string | null; checkout: string | null }
interface ActivityEvent { eventSeq: number; kind: Kind; at: number; visit?: Visit; usage?: Record<string, Usage>; turnId?: string }
interface Identity { sessionId: string; role: Role; parentSessionId?: string; interactive: boolean; writerEpoch: string }
interface Activity extends Identity { schema: 1; cli: 'omp'; cliVersion: string; capabilities: {usage: boolean; parent: boolean; heartbeat: boolean; commitEnv: boolean}; events: ActivityEvent[]; updatedAt: number }
interface JournalEntry { journalSeq: number; identity: Identity; event: ActivityEvent }
interface Ack { ackedEventSeq: number; journalSeq: number }

function atomic(file: string, data: unknown, beforeRename = false) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  if (beforeRename) throw new Error('injected crash before rename');
  fs.renameSync(temp, file);
}
function load<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as T : fallback;
}
const streamKey = (id: Identity) => `${id.sessionId}/${id.writerEpoch}`;
function tokens(input: number): Usage { return {inputNonCache: input, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 1}; }

class Writer {
  readonly file: string;
  readonly ackFile: string;
  readonly activity: Activity;
  private seq = 0;
  constructor(readonly dir: string, identity: Identity) {
    for (const part of [identity.sessionId, identity.writerEpoch]) assert.match(part, /^[A-Za-z0-9._-]+$/);
    this.file = path.join(dir, 'activity', `${streamKey(identity)}.json`);
    this.ackFile = path.join(dir, 'acks', `${streamKey(identity)}.json`);
    assert.equal(fs.existsSync(this.file), false, 'new writer must use a fresh epoch');
    this.activity = {...identity, schema: 1, cli: 'omp', cliVersion: '18.22.0', capabilities: {usage: true, parent: true, heartbeat: true, commitEnv: false}, events: [], updatedAt: 0};
  }
  emit(kind: Kind, at: number, extra: Pick<ActivityEvent, 'visit' | 'usage' | 'turnId'> = {}) {
    this.activity.events.push({eventSeq: ++this.seq, kind, at, ...extra});
    this.activity.updatedAt = at;
    atomic(this.file, this.activity);
  }
  visit(cwd: string, at: number) {
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], {cwd, stderr: 'pipe'});
      return r.exitCode === 0 ? r.stdout.toString().trim() : null;
    };
    this.emit('visit_start', at, {visit: {visitId: randomUUID(), cwd, commonDir: git('rev-parse', '--path-format=absolute', '--git-common-dir'), checkout: git('rev-parse', '--show-toplevel')}});
  }
  snapshot(): Activity { return load<Activity>(this.file, this.activity); }
  compact(crash: 'beforeRename' | 'afterRename' | null = null) {
    const ack = load<Ack | null>(this.ackFile, null);
    if (!ack) return;
    assert.ok(ack.ackedEventSeq <= this.seq, 'ack cannot acknowledge unwritten events');
    const next = {...this.activity, events: this.activity.events.filter(e => e.eventSeq > ack.ackedEventSeq)};
    atomic(this.file, next, crash === 'beforeRename');
    if (crash === 'afterRename') throw new Error('injected crash after rename');
    this.activity.events = next.events;
  }
}

class Reader {
  readonly journal: string;
  constructor(readonly dir: string) { this.journal = path.join(dir, 'journal.json'); }
  entries() { return load<JournalEntry[]>(this.journal, []); }
  commit(activity: Activity, crash: 'beforeJournal' | 'afterJournal' | null = null) {
    const old = fs.existsSync(this.journal) ? fs.readFileSync(this.journal, 'utf8') : null;
    const entries: JournalEntry[] = old === null ? [] : JSON.parse(old);
    const own = entries.filter(e => streamKey(e.identity) === streamKey(activity));
    const seen = new Set(own.map(e => e.event.eventSeq));
    const high = Math.max(0, ...seen);
    const fresh = activity.events.filter(e => !seen.has(e.eventSeq));
    let next = high;
    for (const event of fresh) assert.equal(event.eventSeq, ++next, 'stream has a gap');
    const {sessionId, role, parentSessionId, interactive, writerEpoch} = activity;
    const identity = {sessionId, role, parentSessionId, interactive, writerEpoch};
    for (const event of fresh) entries.push({journalSeq: entries.length + 1, identity, event});
    if (crash === 'beforeJournal') throw new Error('injected crash before journal');
    if (fresh.length) assert.ok(casWrite(this.journal, JSON.stringify(entries), old), 'journal CAS lost');
    if (crash === 'afterJournal') throw new Error('injected crash after journal');
    const ack: Ack = {ackedEventSeq: next, journalSeq: entries.length};
    atomic(path.join(this.dir, 'acks', `${streamKey(activity)}.json`), ack);
  }
  project() {
    const rows = this.entries();
    const identities = new Map(rows.map(r => [r.identity.sessionId, r.identity]));
    const owner = (identity: Identity): string | null => {
      const visited = new Set<string>();
      let id: Identity | undefined = identity;
      while (id?.role === 'child') {
        if (visited.has(id.sessionId)) throw new Error('parent cycle');
        visited.add(id.sessionId);
        id = identities.get(id.parentSessionId ?? '');
      }
      return id?.interactive ? id.sessionId : null;
    };
    const states = new Map<string, {city: string | null; key: string | null; active: {start: number; end: number} | null}>();
    const tiles = new Set<string>();
    const ranges = new Map<string, Array<[number, number]>>();
    const input = new Map<string, number>();
    const visits: Visit[] = [];
    const flush = (state: {key: string | null; active: {start: number; end: number} | null}) => {
      if (!state.key || !state.active) return;
      const list = ranges.get(state.key) ?? [];
      list.push([state.active.start, state.active.end]);
      ranges.set(state.key, list);
    };
    for (const {identity, event} of rows) {
      const sk = streamKey(identity);
      let state = states.get(sk);
      if (!state) { state = {city: null, key: null, active: null}; states.set(sk, state); }
      if (event.kind === 'visit_start') {
        flush(state);
        const visit = event.visit!;
        visits.push(visit);
        state.city = visit.commonDir;
        const root = owner(identity);
        state.key = root && state.city ? `${state.city}\0${root}` : null;
        state.active = null;
        if (state.key && identity.role !== 'child' && identity.interactive) tiles.add(state.key);
      } else if (event.kind === 'visit_end') {
        flush(state); state.active = null; state.city = null; state.key = null;
      } else if (event.kind === 'interval_open') {
        assert.equal(state.active, null, 'writer opened overlapping intervals');
        state.active = {start: event.at, end: event.at};
      } else if (event.kind === 'heartbeat') {
        // No active interval => a late heartbeat cannot reopen a closed one.
        if (state.active && event.at >= state.active.start) state.active.end = Math.max(state.active.end, event.at);
      } else if (event.kind === 'interval_close') {
        if (state.active) {
          state.active.end = Math.max(state.active.end, event.at);
          flush(state); state.active = null;
        }
      } else if (event.kind === 'usage' && state.key) {
        const delta = Object.values(event.usage ?? {}).reduce((sum, u) => sum + u.inputNonCache, 0);
        input.set(state.key, (input.get(state.key) ?? 0) + delta);
      }
    }
    for (const state of states.values()) flush(state);
    const duration: Record<string, number> = {};
    for (const [key, intervals] of ranges) {
      intervals.sort((a, b) => a[0] - b[0]);
      let start = -1, end = -1, total = 0;
      for (const [a, b] of intervals) {
        if (a > end) { if (start >= 0) total += end - start; start = a; end = b; }
        else end = Math.max(end, b);
      }
      if (start >= 0) total += end - start;
      duration[key] = total;
    }
    return {tiles: [...tiles].sort(), duration, input: Object.fromEntries(input), visits};
  }
}

function identity(sessionId: string, writerEpoch: string, role: Role = 'root', interactive = true, parentSessionId?: string): Identity {
  return {sessionId, writerEpoch, role, interactive, parentSessionId};
}
function fakeVisit(city: string): Visit { return {visitId: city, cwd: city, commonDir: city, checkout: city}; }

// A plain OS worker only writes fixture events: no OMP instance or model involved.
if (process.argv[2] === '--writer') {
  const w = new Writer(process.argv[3], identity('same', `${process.pid}-${Date.now()}`));
  w.emit('visit_start', 0, {visit: fakeVisit('city')});
  w.emit('interval_open', Number(process.argv[4]));
  w.emit('heartbeat', Number(process.argv[5]));
  process.exit(0);
}

const root = fs.mkdtempSync('/tmp/reclaim-s6-protocol-');
const results: Array<{name: string; detail: unknown}> = [];
function test(name: string, run: () => unknown) { const detail = run(); results.push({name, detail}); console.log(JSON.stringify({name, ok: true, detail})); }
try {
  test('root / print / RPC / fork / child tile projection', () => {
    const dir = path.join(root, 'roles');
    const reader = new Reader(dir);
    const ids = [identity('main', 'one'), identity('print', 'one', 'root', false), identity('rpc', 'one', 'root', false), identity('fork', 'one', 'fork', true, 'main'), identity('child', 'one', 'child', false, 'main')];
    for (const id of ids) {
      const w = new Writer(dir, id);
      w.emit('visit_start', 0, {visit: fakeVisit('city')});
      w.emit('usage', 1, {usage: {fixture: tokens(10)}});
      reader.commit(w.snapshot());
    }
    const p = reader.project();
    assert.deepEqual(p.tiles, ['city\0fork', 'city\0main']);
    assert.deepEqual(p.input, {'city\0main': 20, 'city\0fork': 10});
    return {tiles: p.tiles.length, childCreatesTile: false, printRpcCreateTile: false};
  });
  const multiDir = path.join(root, 'two-processes');
  const workers = [[0, 60], [30, 90]].map(([start, end]) => Bun.spawn([process.execPath, import.meta.path, '--writer', multiDir, String(start), String(end)], {stdout: 'pipe', stderr: 'pipe'}));
  for (const worker of workers) assert.equal(await worker.exited, 0, await new Response(worker.stderr).text());
  test('two OS writers share a session without overwrites', () => {
    const dir = path.join(multiDir, 'activity', 'same');
    const names = fs.readdirSync(dir);
    assert.equal(names.length, 2);
    const reader = new Reader(multiDir);
    for (const name of names) reader.commit(load<Activity>(path.join(dir, name), null!));
    const p = reader.project();
    assert.equal(p.tiles.length, 1);
    assert.equal(p.duration['city\0same'], 90);
    return {epochFiles: names.length, unionDuration: 90};
  });
  test('ack delay / journal crash / compact crash replay equivalence', () => {
    const dir = path.join(root, 'ack');
    const w = new Writer(dir, identity('main', 'old'));
    w.emit('visit_start', 0, {visit: fakeVisit('city')});
    w.emit('interval_open', 0);
    w.emit('heartbeat', 60);
    w.emit('usage', 60, {usage: {fixture: tokens(7)}});
    const reader = new Reader(dir);
    assert.throws(() => reader.commit(w.snapshot(), 'beforeJournal'));
    assert.equal(fs.existsSync(w.ackFile), false);
    assert.equal(reader.entries().length, 0);
    assert.throws(() => reader.commit(w.snapshot(), 'afterJournal'));
    assert.equal(fs.existsSync(w.ackFile), false);
    const expected = new Reader(dir).project();
    new Reader(dir).commit(w.snapshot());
    reader.commit(w.snapshot());
    assert.equal(reader.entries().length, 4);
    w.emit('usage', 65, {usage: {fixture: tokens(5)}});
    assert.throws(() => w.compact('beforeRename'));
    assert.equal(w.snapshot().events.length, 5);
    assert.deepEqual(new Reader(dir).project(), expected);
    assert.throws(() => w.compact('afterRename'));
    assert.deepEqual(w.snapshot().events.map(e => e.eventSeq), [5]);
    assert.deepEqual(new Reader(dir).project(), expected);
    reader.commit(w.snapshot());
    assert.deepEqual(reader.project().input, {'city\0main': 12});
    // A restarted process uses a new epoch. The old ack must not delete new events.
    const next = new Writer(dir, identity('main', 'new'));
    next.emit('visit_start', 70, {visit: fakeVisit('city')});
    next.compact();
    assert.equal(next.snapshot().events.length, 1);
    reader.commit(next.snapshot());
    assert.deepEqual(reader.project().input, {'city\0main': 12});
    return {journalEventsBeforeNewEpoch: 5, inputAfterRepeatedReplay: 12, unackedTailSurvives: true, oldAckDoesNotCompactNewEpoch: true};
  });
  test('only own open epoch interval extends to last persisted heartbeat', () => {
    const dir = path.join(root, 'heartbeats');
    const a = new Writer(dir, identity('main', 'a'));
    const b = new Writer(dir, identity('main', 'b'));
    a.emit('visit_start', 0, {visit: fakeVisit('city')});
    a.emit('interval_open', 0); a.emit('heartbeat', 60); a.emit('interval_close', 70); a.emit('heartbeat', 999);
    b.emit('visit_start', 20, {visit: fakeVisit('city')});
    b.emit('interval_open', 20); b.emit('heartbeat', 50);
    const reader = new Reader(dir);
    reader.commit(a.snapshot()); reader.commit(b.snapshot());
    assert.equal(reader.project().duration['city\0main'], 70);
    // a wall-clock jump, crash, or replay time never changes the persisted endpoint.
    assert.deepEqual(new Reader(dir).project(), reader.project());
    return {unionDuration: 70, ignoredLateHeartbeat: 999};
  });
  test('offline A -> temporary worktree -> B survives worktree deletion', () => {
    const dir = path.join(root, 'offline');
    const a = path.join(root, 'repo-a'), b = path.join(root, 'repo-b'), wt = path.join(root, 'worktree');
    const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], {cwd, env, stderr: 'pipe'});
      assert.equal(r.exitCode, 0, r.stderr.toString());
      return r.stdout.toString().trim();
    };
    for (const repo of [a, b]) {
      fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
      git(repo, '-c', 'user.name=S6', '-c', 'user.email=s6@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
    }
    git(a, 'worktree', 'add', '-q', '-b', 'temporary', wt);
    const w = new Writer(dir, identity('main', 'one'));
    let at = 0;
    for (const repo of [a, wt, b]) {
      w.visit(repo, at); w.emit('interval_open', at); w.emit('heartbeat', at + 60);
      w.emit('usage', at + 60, {usage: {fixture: tokens(5)}});
      w.emit('interval_close', at + 60); w.emit('visit_end', at + 60); at += 100;
    }
    git(a, 'worktree', 'remove', wt);
    assert.equal(fs.existsSync(wt), false);
    const reader = new Reader(dir);
    reader.commit(w.snapshot());
    const p = reader.project();
    assert.equal(p.visits.length, 3);
    assert.equal(p.visits[0].commonDir, p.visits[1].commonDir);
    assert.notEqual(p.visits[0].checkout, p.visits[1].checkout);
    assert.notEqual(p.visits[0].commonDir, p.visits[2].commonDir);
    assert.equal(p.tiles.length, 2);
    assert.deepEqual(Object.values(p.duration).sort((x, y) => x - y), [60, 120]);
    assert.deepEqual(Object.values(p.input).sort((x, y) => x - y), [5, 10]);
    return {visits: 3, cities: 2, durations: [60, 120], usage: [5, 10]};
  });
  test('counterexample: usage payload lacks a cross-epoch idempotency identity', () => {
    const event: ActivityEvent = {eventSeq: 1, kind: 'usage', at: 60, usage: {fixture: tokens(100)}};
    // History A: both writers observe the same source entry; correct total=100.
    // History B: each observes a different source entry of 100; correct total=200.
    // Source entry identity is absent from §6.1, so both histories serialize identically.
    const historyA = [{epoch: 'a', sourceEntryId: 'source-1', event}, {epoch: 'b', sourceEntryId: 'source-1', event}];
    const historyB = [{epoch: 'a', sourceEntryId: 'source-1', event}, {epoch: 'b', sourceEntryId: 'source-2', event}];
    const wireA = historyA.map(({epoch, event}) => ({epoch, event}));
    const wireB = historyB.map(({epoch, event}) => ({epoch, event}));
    const totalA = [...new Map(historyA.map(e => [e.sourceEntryId, e.event.usage!.fixture.inputNonCache])).values()].reduce((a, b) => a + b, 0);
    const totalB = [...new Map(historyB.map(e => [e.sourceEntryId, e.event.usage!.fixture.inputNonCache])).values()].reduce((a, b) => a + b, 0);
    assert.deepEqual(wireA, wireB);
    assert.notEqual(totalA, totalB);
    return {sameWirePayload: true, correctTotalA: totalA, correctTotalB: totalB, verdict: 'S6 cannot pass cross-epoch usage accounting without a stable source usage key or explicit single-writer ownership'};
  });
} finally { fs.rmSync(root, {recursive: true, force: true}); }
console.log(JSON.stringify({checks: results.length, status: 'Protocol scenarios executed; usage identity counterexample blocks full S6 acceptance', limits: ['fixture implementation, not installed adapter', 'child role replay only; no live subagent launched', 'journal segmentation/capacity is S3, not retested here']}));
