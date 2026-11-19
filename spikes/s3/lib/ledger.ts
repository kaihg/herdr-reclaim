// S3 spike: pure-filesystem emulation of the §13 帳本協定 (journal / head / blobs / paging /
// checkpoint). No herdr involved: every write goes through `casWrite` from ./cas, which
// reproduces `herdr.writeTextFile(path, text, expected)`.
//
// Layout of one city:
//   head.json                     fixed size: schemaVersion, rulesVersion, cityId,
//                                 journalSegment, checkpoint            (§13.2 head)
//   journal/<n>.json              ndjson entries, <= limit; optional last line is the seal
//                                 marker {"seal":lastSeq,"next":n+1}     (§13.1 換段)
//   blobs/<hash>.l|.m             content files, chunked + manifest layered (§13.1 內容檔)
//   checkpoints/<seq>/            derived snapshot: state, index pages, chunks (§13.1 checkpoint)
import fs from "node:fs";
import path from "node:path";
import { BlobStore, canonical, hashOf } from "./content";
import { PrefixIndex } from "./paging";
import { atomicWrite, byteLen, casWrite, createExclusive, IoStats, newIoStats, readText } from "./cas";

export const SEG_LIMIT = 256 * 1024; // §13.1: 每段上限 256 KiB
export const READ_LIMIT = 1024 * 1024; // herdr.d.ts:27 readTextFile cap
export const CHUNK_SIDE = 32; // §13.1: 座標分塊 32×32

export type Res = "wood" | "stone" | "iron" | "parchment" | "research";
export const RES: Res[] = ["wood", "stone", "iron", "parchment", "research"];
export type Kind =
  | "genesis"
  | "dispatch"
  | "harvest"
  | "accelerate"
  | "build"
  | "market"
  | "withdraw"
  | "archive"
  | "redispatch"
  | "research";

export type Vec = Partial<Record<Res, number>>;

export interface Entry {
  seq: number;
  op: string; // operation ID (idempotency key)
  k: Kind;
  exp?: string;
  gen?: number;
  blob?: string;
  ch?: 1; // blob is chunked (manifest root)
  claim?: string;
  d: Vec;
  p?: number;
  c?: [number, number];
  rv: number;
  t: number;
}

export interface OpInput {
  op: string;
  k: Kind;
  exp?: string;
  gen?: number;
  content?: unknown;
  contentBytes?: Buffer;
  claim?: string;
  d?: Vec;
  p?: number;
  c?: [number, number];
  t?: number;
}

export interface Exp {
  gen: number;
  state: "unclaimed" | "reclaimed" | "built" | "withdrawn" | "archived";
  harvested: boolean;
  points: number;
  cx: number;
  cy: number;
  faction: string;
}

export interface Cell {
  cx: number;
  cy: number;
  exp: string;
  gen: number;
  stage: string;
  points: number;
  harvested: boolean;
  faction: string;
  rootSessionId: string;
}

export interface CityState {
  cityId: string;
  inventory: Record<Res, number>;
  ops: Record<string, number>;
  claims: Record<string, number>;
  expeditions: Record<string, Exp>;
  cells: Record<string, Cell>;
  lastSeq: number;
}

export interface Head {
  schemaVersion: number;
  rulesVersion: number;
  cityId: string;
  journalSegment: number;
  checkpoint: number;
}

export const emptyState = (cityId = ""): CityState => ({
  cityId,
  inventory: { wood: 0, stone: 0, iron: 0, parchment: 0, research: 0 },
  ops: {},
  claims: {},
  expeditions: {},
  cells: {},
  lastSeq: -1,
});

export const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;
export const chunkKey = (cx: number, cy: number): string =>
  `${Math.floor(cx / CHUNK_SIDE)}_${Math.floor(cy / CHUNK_SIDE)}`;

/** Deterministic reduction. Also used to rebuild from a checkpoint + replayed journal. */
export function applyEntry(st: CityState, e: Entry): void {
  st.ops[e.op] = e.seq;
  if (e.claim) st.claims[e.claim] = e.seq;
  if (e.d) for (const r of RES) {
    const v = e.d[r];
    if (v) st.inventory[r] += v;
  }
  if (e.exp) {
    let x = st.expeditions[e.exp];
    if (e.k === "dispatch" || e.k === "redispatch") {
      x = st.expeditions[e.exp] = {
        gen: e.gen ?? (x ? x.gen + 1 : 1),
        state: "unclaimed",
        harvested: false,
        points: 0,
        cx: e.c ? e.c[0] : (x?.cx ?? 0),
        cy: e.c ? e.c[1] : (x?.cy ?? 0),
        faction: x?.faction ?? "none",
      };
    }
    if (x) {
      if (e.p) x.points += e.p;
      if (e.k === "harvest") {
        x.harvested = true;
        x.points += 100;
      } else if (e.k === "build") x.state = "built";
      else if (e.k === "withdraw") x.state = "withdrawn";
      else if (e.k === "archive") x.state = "archived";
      else if (x.state === "unclaimed" && x.points >= 100) x.state = "reclaimed";
      st.cells[cellKey(x.cx, x.cy)] = {
        cx: x.cx,
        cy: x.cy,
        exp: e.exp,
        gen: x.gen,
        stage: x.state,
        points: x.points,
        harvested: x.harvested,
        faction: x.faction,
        rootSessionId: `sess-${e.exp}`,
      };
    }
  }
  st.lastSeq = e.seq;
}

/** The write-side precondition check from §13.1 提交流程, run against the journal tail. */
export function precheck(st: CityState, op: OpInput): { ok: true } | { ok: false; reason: string } {
  if (st.ops[op.op] !== undefined) return { ok: false, reason: "duplicate_operation" };
  if (op.claim && st.claims[op.claim] !== undefined) return { ok: false, reason: "claim_exists" };
  const d = op.d ?? {};
  for (const r of RES) {
    const v = d[r];
    if (v !== undefined && v < 0 && st.inventory[r] + v < 0) return { ok: false, reason: `insufficient_${r}` };
  }
  if (op.k === "withdraw" || op.k === "archive") {
    const e = st.expeditions[op.exp!];
    if (!e) return { ok: false, reason: "no_expedition" };
    if (e.harvested) return { ok: false, reason: "already_harvested" };
    if (e.state === "withdrawn" || e.state === "archived") return { ok: false, reason: "already_closed" };
  } else if (op.k === "redispatch") {
    const e = st.expeditions[op.exp!];
    if (!e) return { ok: false, reason: "no_expedition" };
    if (e.state !== "withdrawn" && e.state !== "archived") return { ok: false, reason: "not_closed" };
    if ((op.gen ?? 0) !== e.gen + 1) return { ok: false, reason: "bad_generation" };
  } else if (op.k === "harvest" || op.k === "accelerate" || op.k === "build") {
    const e = st.expeditions[op.exp!];
    if (!e) return { ok: false, reason: "no_expedition" };
    if (e.state === "withdrawn" || e.state === "archived") return { ok: false, reason: "generation_closed" };
    if (op.k === "build" && e.state === "built") return { ok: false, reason: "already_built" };
  }
  return { ok: true };
}

export interface SegParse {
  index: number;
  bytes: number;
  entries: Entry[];
  sealed: boolean;
  sealNext: number | null;
  sealSeq: number | null;
}

export function parseSegment(index: number, text: string): SegParse {
  const entries: Entry[] = [];
  let sealed = false;
  let sealNext: number | null = null;
  let sealSeq: number | null = null;
  let sawSeal = false;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (sawSeal) throw new Error(`segment ${index}: entry after seal marker`);
    const obj = JSON.parse(line) as Entry & { seal?: number; next?: number };
    if (obj.seal !== undefined) {
      sealed = true;
      sealSeq = obj.seal;
      sealNext = obj.next!;
      sawSeal = true;
    } else entries.push(obj as Entry);
  }
  return { index, bytes: byteLen(text), entries, sealed, sealNext, sealSeq };
}

export interface View {
  head: Head;
  headText: string;
  segIndex: number;
  segText: string | null;
  segEntries: Entry[];
}

export interface SubmitResult {
  ok: boolean;
  seq: number;
  attempts: number;
  reason?: string;
  bytesWritten: number;
  reads: number;
  ms: number;
  contentReused?: boolean;
}

export interface Mode {
  /** counterexample A: on CAS failure refresh the text but do NOT re-read/re-check state */
  bugStaleReuse?: boolean;
  /** counterexample B: no seal — rotate by creating the next segment while the old one stays open */
  bugNoSeal?: boolean;
  /** crash between writing the content file and appending the journal entry */
  crashAfterContent?: boolean;
}

export class CrashAfterContent extends Error {}

export interface CommitRec {
  seg: number;
  seq: number;
  t0: number;
  t1: number;
  bytes: number;
  bug: string | null;
}

export interface LedgerOpts {
  limit?: number;
  fsync?: boolean;
  stats?: IoStats;
  commitLog?: CommitRec[];
  rulesVersion?: number;
  trace?: boolean;
}

export class Ledger {
  readonly dir: string;
  readonly limit: number;
  readonly fsync: boolean;
  readonly stats: IoStats;
  readonly blobs: BlobStore;
  rulesVersion: number;
  commitLog: CommitRec[] | null;
  trace: boolean;
  private clock = 1_700_000_000_000;
  private cache: { headText: string; segIndex: number; segLen: number; state: CityState } | null = null;
  private casOpts: { fsync: boolean; stats: IoStats };

  constructor(cityDir: string, opts: LedgerOpts = {}) {
    this.dir = cityDir;
    this.limit = opts.limit ?? SEG_LIMIT;
    this.fsync = opts.fsync ?? false;
    this.stats = opts.stats ?? newIoStats();
    this.rulesVersion = opts.rulesVersion ?? 1;
    this.commitLog = opts.commitLog ?? null;
    this.trace = opts.trace ?? false;
    this.blobs = new BlobStore(path.join(cityDir, "blobs"), this.limit, this.stats);
    this.casOpts = { fsync: this.fsync, stats: this.stats };
    fs.mkdirSync(path.join(cityDir, "journal"), { recursive: true });
  }

  headPath(): string {
    return path.join(this.dir, "head.json");
  }
  segPath(i: number): string {
    return path.join(this.dir, "journal", `${i}.json`);
  }
  checkpointDir(seq: number): string {
    return path.join(this.dir, "checkpoints", String(seq));
  }

  // ---- head / journal -------------------------------------------------------------------

  init(cityId: string): void {
    if (readText(this.headPath()) === null) {
      const head: Head = {
        schemaVersion: 1,
        rulesVersion: this.rulesVersion,
        cityId,
        journalSegment: 0,
        checkpoint: 0,
      };
      createExclusive(this.headPath(), JSON.stringify(head) + "\n", this.casOpts);
    }
    if (readText(this.segPath(0)) === null) createExclusive(this.segPath(0), "", this.casOpts);
  }

  readHead(): { text: string; head: Head } {
    const text = readText(this.headPath());
    if (text === null) throw new Error(`no head at ${this.headPath()}`);
    return { text, head: JSON.parse(text) as Head };
  }

  /** Read the current tail: head's segment, following a seal marker if the head lags. */
  readView(): View {
    const { text: headText, head } = this.readHead();
    let segIndex = head.journalSegment;
    let segText = readText(this.segPath(segIndex));
    if (segText === null && segIndex > 0) throw new Error(`head points at missing segment ${segIndex}`);
    let parsed = parseSegment(segIndex, segText ?? "");
    if (parsed.sealed) {
      segIndex = parsed.sealNext!;
      segText = readText(this.segPath(segIndex));
      parsed = parseSegment(segIndex, segText ?? "");
    }
    return { head, headText, segIndex, segText, segEntries: parsed.entries };
  }

  /** Every segment on disk, in numeric order (the "read all journal" path). */
  readAllSegments(): SegParse[] {
    const out: SegParse[] = [];
    for (let i = 0; ; i++) {
      const text = readText(this.segPath(i));
      if (text === null) break;
      out.push(parseSegment(i, text));
    }
    return out;
  }

  /** Segments reachable from head by following seal markers. */
  chainFromHead(): SegParse[] {
    const { head } = this.readHead();
    const out: SegParse[] = [];
    let k = head.journalSegment;
    for (;;) {
      const text = readText(this.segPath(k));
      if (text === null) break;
      const p = parseSegment(k, text);
      out.push(p);
      if (!p.sealed) break;
      k = p.sealNext!;
    }
    return out;
  }

  /** Contiguity + seal-chain validation; returns the flattened entries. */
  validateJournal(): { entries: Entry[]; segments: SegParse[] } {
    const segs = this.readAllSegments();
    const entries: Entry[] = [];
    let expected = 0;
    for (const s of segs) {
      if (s.bytes > this.limit) throw new Error(`segment ${s.index} is ${s.bytes} > limit ${this.limit}`);
      for (const e of s.entries) {
        if (e.seq !== expected) throw new Error(`seq gap: got ${e.seq}, expected ${expected}`);
        expected++;
        entries.push(e);
      }
      if (s.sealed) {
        if (s.sealSeq !== entries[entries.length - 1]!.seq) throw new Error(`segment ${s.index}: seal seq mismatch`);
        if (s.sealNext !== s.index + 1) throw new Error(`segment ${s.index}: seal next is ${s.sealNext}`);
      } else if (s.index !== segs.length - 1) {
        throw new Error(`segment ${s.index} is not sealed but is not the tail`);
      }
    }
    // the seal chain reachable from head must cover exactly the same entries
    const chained = this.chainFromHead().flatMap((s) => s.entries);
    if (chained.length !== entries.length) {
      throw new Error(`head chain has ${chained.length} entries, journal has ${entries.length}`);
    }
    return { entries, segments: segs };
  }

  journalStats(): { segments: number; entries: number; bytes: number; maxSegmentBytes: number; seals: number } {
    const segs = this.readAllSegments();
    let entries = 0;
    let bytes = 0;
    let maxSegmentBytes = 0;
    let seals = 0;
    for (const s of segs) {
      entries += s.entries.length;
      bytes += s.bytes;
      maxSegmentBytes = Math.max(maxSegmentBytes, s.bytes);
      if (s.sealed) seals++;
    }
    return { segments: segs.length, entries, bytes, maxSegmentBytes, seals };
  }

  // ---- state reconstruction -------------------------------------------------------------

  rebuildDirect(): { state: CityState; entries: number; ms: number } {
    const t0 = performance.now();
    const { head } = this.readHead();
    const st = emptyState(head.cityId);
    let n = 0;
    for (const s of this.readAllSegments()) for (const e of s.entries) {
      applyEntry(st, e);
      n++;
    }
    return { state: st, entries: n, ms: performance.now() - t0 };
  }

  /** head -> checkpoint -> replay the journal after the checkpoint. */
  rebuildViaHead(): { state: CityState; entries: number; ms: number } {
    const t0 = performance.now();
    const { head } = this.readHead();
    const st = head.checkpoint > 0 ? this.loadCheckpoint(head.checkpoint) : emptyState(head.cityId);
    let n = 0;
    for (const s of this.readAllSegments()) for (const e of s.entries) {
      if (e.seq > st.lastSeq) {
        applyEntry(st, e);
        n++;
      }
    }
    return { state: st, entries: n, ms: performance.now() - t0 };
  }

  private stateFor(view: View): CityState {
    const segLen = view.segText === null ? -1 : view.segText.length;
    if (this.cache && this.cache.headText === view.headText && this.cache.segIndex === view.segIndex && this.cache.segLen === segLen) {
      return this.cache.state;
    }
    const st = this.rebuildViaHead().state;
    this.cache = { headText: view.headText, segIndex: view.segIndex, segLen, state: st };
    return st;
  }

  stateHash(): string {
    const st = this.rebuildViaHead().state;
    return stateHashOf(st);
  }

  // ---- checkpoint -----------------------------------------------------------------------

  saveCheckpoint(seq: number, st: CityState): { dir: string; files: number; maxBytes: number } {
    const dir = this.checkpointDir(seq);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let files = 0;
    let maxBytes = 0;
    const note = (p: string) => {
      files++;
      maxBytes = Math.max(maxBytes, fs.statSync(p).size);
    };
    const write = (rel: string, text: string) => {
      const p = path.join(dir, rel);
      atomicWrite(p, text);
      note(p);
      return p;
    };
    write("state.json", canonical({ cityId: st.cityId, inventory: st.inventory, lastSeq: seq }));
    const ops = new PrefixIndex(path.join(dir, "ops"), this.limit);
    const opPages = new Map<string, string>();
    for (const [k, v] of Object.entries(st.ops)) opPages.set(k, String(v));
    files += ops.buildFrom(opPages).pages;
    maxBytes = Math.max(maxBytes, ops.buildFrom(opPages).maxPageBytes);
    const claims = new PrefixIndex(path.join(dir, "claims"), this.limit);
    const claimPages = new Map<string, string>();
    for (const [k, v] of Object.entries(st.claims)) claimPages.set(k, String(v));
    claims.buildFrom(claimPages);
    const exps = new PrefixIndex(path.join(dir, "expeditions"), this.limit);
    const expPages = new Map<string, string>();
    for (const [k, v] of Object.entries(st.expeditions)) expPages.set(k, canonical(v));
    exps.buildFrom(expPages);
    const groups = new Map<string, Cell[]>();
    for (const c of Object.values(st.cells)) {
      const g = chunkKey(c.cx, c.cy);
      (groups.get(g) ?? groups.set(g, []).get(g)!).push(c);
    }
    for (const [g, cells] of groups) {
      cells.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
      write(`cells/${g}.json`, canonical(cells));
    }
    // head is updated last (CAS): a checkpoint that fails to publish is just an orphan dir.
    const { text, head } = this.readHead();
    casWrite(this.headPath(), JSON.stringify({ ...head, checkpoint: seq }) + "\n", text, this.casOpts);
    for (const p of ["ops", "claims", "expeditions"]) {
      const d = path.join(dir, p);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        files++;
        maxBytes = Math.max(maxBytes, fs.statSync(path.join(d, f)).size);
      }
    }
    return { dir, files, maxBytes };
  }

  loadCheckpoint(seq: number): CityState {
    const dir = this.checkpointDir(seq);
    const st = emptyState();
    const meta = JSON.parse(readText(path.join(dir, "state.json"))!) as {
      cityId: string;
      inventory: Record<Res, number>;
      lastSeq: number;
    };
    st.cityId = meta.cityId;
    st.inventory = meta.inventory;
    st.lastSeq = meta.lastSeq;
    for (const [k, v] of new PrefixIndex(path.join(dir, "ops"), this.limit).all()) st.ops[k] = Number(v);
    for (const [k, v] of new PrefixIndex(path.join(dir, "claims"), this.limit).all()) st.claims[k] = Number(v);
    for (const [k, v] of new PrefixIndex(path.join(dir, "expeditions"), this.limit).all())
      st.expeditions[k] = JSON.parse(v) as Exp;
    const cellsDir = path.join(dir, "cells");
    if (fs.existsSync(cellsDir)) {
      for (const f of fs.readdirSync(cellsDir)) {
        for (const c of JSON.parse(readText(path.join(cellsDir, f))!) as Cell[]) st.cells[cellKey(c.cx, c.cy)] = c;
      }
    }
    return st;
  }

  // ---- the writer -----------------------------------------------------------------------

  submit(op: OpInput, mode: Mode = {}): SubmitResult {
    const stats0 = this.stats.bytesWritten;
    const reads0 = this.stats.reads;
    const t0 = performance.now();
    for (let attempt = 1; attempt <= 64; attempt++) {
      const b = this.beginAttempt(op);
      if ("rejected" in b) return this.result(false, -1, attempt, b.rejected, stats0, reads0, t0);
      const r = this.finishAttempt(b.attempt, op, mode);
      if (r.done) return this.result(r.ok, r.seq, attempt, r.reason, stats0, reads0, t0, r.reused);
    }
    return this.result(false, -1, 64, "max_attempts", stats0, reads0, t0);
  }

  /** Async variant: `hook` runs after the snapshot is taken and before the CAS, which is what
   *  makes two writers hold stale snapshots (herdr's writeTextFile is off-thread). */
  async submitAsync(op: OpInput, mode: Mode = {}, hook?: (attempt: number) => Promise<void>): Promise<SubmitResult> {
    const stats0 = this.stats.bytesWritten;
    const reads0 = this.stats.reads;
    const t0 = performance.now();
    for (let attempt = 1; attempt <= 64; attempt++) {
      const b = this.beginAttempt(op);
      if ("rejected" in b) return this.result(false, -1, attempt, b.rejected, stats0, reads0, t0);
      if (hook) await hook(attempt);
      const r = this.finishAttempt(b.attempt, op, mode);
      if (r.done) return this.result(r.ok, r.seq, attempt, r.reason, stats0, reads0, t0, r.reused);
    }
    return this.result(false, -1, 64, "max_attempts", stats0, reads0, t0);
  }

  private result(
    ok: boolean,
    seq: number,
    attempts: number,
    reason: string | undefined,
    stats0: number,
    reads0: number,
    t0: number,
    reused?: boolean,
  ): SubmitResult {
    return {
      ok,
      seq,
      attempts,
      reason,
      bytesWritten: this.stats.bytesWritten - stats0,
      reads: this.stats.reads - reads0,
      ms: performance.now() - t0,
      contentReused: reused,
    };
  }

  private beginAttempt(op: OpInput): { attempt: { view: View; state: CityState } } | { rejected: string } {
    const view = this.readView();
    const state = this.stateFor(view);
    const pre = precheck(state, op);
    if (!pre.ok) return { rejected: pre.reason };
    return { attempt: { view, state } };
  }

  private finishAttempt(
    a: { view: View; state: CityState },
    op: OpInput,
    mode: Mode,
  ): { done: true; ok: boolean; seq: number; reason?: string; reused?: boolean } | { done: false } {
    const { view, state } = a;
    const seq = state.lastSeq + 1;
    const entry: Entry = { seq, op: op.op, k: op.k, d: op.d ?? {}, rv: this.rulesVersion, t: op.t ?? this.clock++ };
    if (op.exp !== undefined) entry.exp = op.exp;
    if (op.gen !== undefined) entry.gen = op.gen;
    if (op.claim !== undefined) entry.claim = op.claim;
    if (op.p !== undefined) entry.p = op.p;
    if (op.c !== undefined) entry.c = op.c;
    // §13.1: content files are written before the entry that references them.
    let reused: boolean | undefined;
    if (op.content !== undefined || op.contentBytes !== undefined) {
      const put = op.contentBytes !== undefined ? this.blobs.put(op.contentBytes) : this.blobs.putValue(op.content);
      entry.blob = put.hash;
      if (put.chunked) entry.ch = 1;
      reused = put.reused;
    }
    if (mode.crashAfterContent) throw new CrashAfterContent(`crash after content for ${op.op}`);
    const line = JSON.stringify(entry) + "\n";
    const segFile = this.segPath(view.segIndex);
    const curLen = view.segText === null ? 0 : byteLen(view.segText);
    const needSeal = curLen + byteLen(line) > this.limit;

    if (needSeal && mode.bugNoSeal) {
      // counterexample B: no seal; open the next segment while the old one stays writable.
      const next = view.segIndex + 1;
      casWrite(this.segPath(next), line, null, this.casOpts);
      casWrite(this.headPath(), JSON.stringify({ ...view.head, journalSegment: next }) + "\n", view.headText, this.casOpts);
      this.appendCommit(view.segIndex, entry, 0, byteLen(line), "no_seal");
      return { done: true, ok: true, seq, reused };
    }

    if (needSeal) {
      // §13.1 換段: CAS the seal marker first, then create the next segment, then head.
      const sealLine = JSON.stringify({ seal: state.lastSeq, next: view.segIndex + 1 }) + "\n";
      if (!casWrite(segFile, (view.segText ?? "") + sealLine, view.segText, this.casOpts)) {
        if (this.trace) console.error(`[s3] seal CAS lost seg=${view.segIndex}`);
        return { done: false };
      }
      this.stats.seals++;
      createExclusive(this.segPath(view.segIndex + 1), "", this.casOpts);
      casWrite(
        this.headPath(),
        JSON.stringify({ ...view.head, journalSegment: view.segIndex + 1 }) + "\n",
        view.headText,
        this.casOpts,
      );
      this.stats.translations++;
      return { done: false }; // re-read: append to the new segment after re-checking
    }

    const expected = view.segText;
    const text = (expected ?? "") + line;
    if (!casWrite(segFile, text, expected, this.casOpts)) {
      if (mode.bugStaleReuse) {
        // counterexample A: refresh the text but skip the state re-read / precondition re-check.
        const cur = readText(segFile);
        if (cur !== null && byteLen(cur) + byteLen(line) <= this.limit) {
          if (casWrite(segFile, cur + line, cur, this.casOpts)) {
            applyEntry(state, entry);
            this.appendCommit(view.segIndex, entry, 0, byteLen(line), "stale_reuse");
            return { done: true, ok: true, seq, reused };
          }
        }
      }
      if (this.trace) console.error(`[s3] append CAS lost seg=${view.segIndex} seq=${seq}`);
      return { done: false };
    }
    applyEntry(state, entry);
    this.cache = {
      headText: view.headText,
      segIndex: view.segIndex,
      segLen: text.length,
      state,
    };
    this.appendCommit(view.segIndex, entry, 0, byteLen(text), null);
    return { done: true, ok: true, seq, reused };
  }

  private appendCommit(seg: number, entry: Entry, t0: number, bytes: number, bug: string | null): void {
    if (this.commitLog) this.commitLog.push({ seg, seq: entry.seq, t0, t1: performance.now(), bytes, bug });
  }

  // ---- blob helpers ----------------------------------------------------------------------

  readContent(hash: string, chunked?: boolean): Buffer {
    return this.blobs.get(hash);
  }

  /** Content files that no journal entry references (candidates for reuse or cleanup). */
  orphans(): { hash: string; file: string }[] {
    const referenced = new Set<string>();
    for (const s of this.readAllSegments()) for (const e of s.entries) if (e.blob) referenced.add(e.blob);
    const out: { hash: string; file: string }[] = [];
    for (const name of fs.readdirSync(this.blobs.dir)) {
      if (name.endsWith(".tmp")) continue;
      const hash = name.replace(/\.(l|m)$/, "");
      if (!referenced.has(hash)) out.push({ hash, file: path.join(this.blobs.dir, name) });
    }
    return out;
  }
}

export function stateHashOf(st: CityState): string {
  return hashOf(
    canonical({
      cityId: st.cityId,
      inventory: st.inventory,
      ops: st.ops,
      claims: st.claims,
      expeditions: st.expeditions,
      cells: st.cells,
      lastSeq: st.lastSeq,
    }),
  );
}
