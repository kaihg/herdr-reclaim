// herdr-reclaim：Claude Code 遠征 adapter（proposal §6.1／§6.2／§6.3；ticket #11）。
//
// Claude Code 的生命週期只有 hooks 會通知外部（transcript 讀取不是生命週期訊號，只是用量來源），
// 所以這支程式是「一個 hook 一個行程」：每次由 claude 以 hook 指令叫起來，讀 stdin 的 JSON，
// 把事件接到同一個寫入者檔案。一個寫入者＝一個 claude 行程（CLAUDE_PID）；舊檔留著供離線重播。
//   <root>/activity/<sessionId>/<writerEpoch>.json        這裡寫（跟 omp adapter 同一份協定）
//   <root>/claude-state/<sessionId>/<writerEpoch>.json    這裡只放 adapter 自己的游標狀態
// root = $HERDR_APP_HOME/data/herdr-reclaim（預設 ~/.config/herdr-app）
//
// 生命週期訊號（live 實測 2.1.317，見 spikes/s7 與交接筆記）：
//   SessionStart(startup|resume|clear|compact|fork) → 開 writer、visit_start
//   UserPromptSubmit → visit（cwd 可能變了）、interval_open
//   PreToolUse → heartbeat（工具回合也延長同一段工作時間）
//   SubagentStart／SubagentStop → child writer（role=child，parentSessionId=主 session）
//   Stop → 讀 transcript 的用量、interval_close、turn_end
//   PreCompact → 壓縮前先把用量收乾淨
//   SessionEnd(reason) → 收尾：用量、interval_close、visit_end
//
// 用量：同一個 message ID 會在多筆紀錄、不同 epoch（resume）重複出現；以 message ID 當穩定來源，
// 只保留最後一次看到的快照（§6.1）。欄位不完整的紀錄標進 unknownFields，不補 0；
// 沒有 assistant usage 的紀錄不會產生用量事件（不是 0 消耗）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Kind =
  | "visit_start"
  | "visit_end"
  | "interval_open"
  | "heartbeat"
  | "interval_close"
  | "usage"
  | "turn_end";
export type Role = "root" | "child" | "fork";

export const USAGE_FIELDS = ["inputNonCache", "cacheRead", "cacheWrite", "output"] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];

/** §6.1 的共同用量格式；unknownFields 是 ticket #11 的向後相容新增欄位。 */
export interface NormalizedUsage {
  sourceKey: string;
  inputNonCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  costKnown: number;
  costUnknownEntries: number;
  unknownFields?: UsageField[];
}

export interface Visit {
  visitId: string;
  cwd: string;
  commonDir: string | null;
  checkout: string | null;
}

export interface ActivityEvent {
  eventSeq: number;
  kind: Kind;
  at: number;
  visit?: Visit;
  usage?: Record<string, NormalizedUsage>;
  sourceEntryId?: string;
  turnId?: string;
}

export interface Activity {
  schema: 1;
  cli: "claude";
  cliVersion: string;
  capabilities: { usage: boolean; parent: boolean; heartbeat: boolean; commitEnv: boolean };
  sessionId: string;
  role: Role;
  parentSessionId?: string;
  interactive: boolean;
  writerEpoch: string;
  events: ActivityEvent[];
  updatedAt: number;
}

/** Claude Code hook 的 stdin（只列這個 adapter 用得到的欄位）。 */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  prompt_id?: string;
  permission_mode?: string;
}

export interface HookEnv {
  appHome: string;
  pid: number;
  entrypoint: string;
  now: number;
}

export const SCHEMA = 1;
export const CLI = "claude";

/** adapter 自己的寫入者狀態（private，mod 不讀）。 */
interface WriterState {
  seq: number;
  startedAt: number;
  role: Role;
  interactive: boolean;
  parentSessionId?: string;
  visit: Visit | null;
  intervalOpen: boolean;
}

export function rootOf(appHome: string) {
  return path.join(appHome, "data", "herdr-reclaim");
}

export function activityFileOf(root: string, sessionId: string, epoch: string) {
  return path.join(root, "activity", safeName(sessionId), `${safeName(epoch)}.json`);
}

function stateFileOf(root: string, sessionId: string, epoch: string) {
  return path.join(root, "claude-state", safeName(sessionId), `${safeName(epoch)}.json`);
}

export function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** child 的 session 身分：與主 session 分開一個寫入者，但 parent 指回主 session（§6.1）。 */
export function childSessionId(parentSessionId: string, agentId: string) {
  return `${parentSessionId}~sub~${agentId}`;
}

/** writerEpoch identifies one Claude process lifetime; pid reuse must not merge resumed epochs. */
export function writerEpochOf(pid: number, startedAt: number) {
  return `c${pid}-${startedAt.toString(36)}-${randomUUID()}`;
}

/** 只有互動 claude（entrypoint=cli）會建格；-p 這種 SDK 入口不建格（§16）。 */
export function interactiveOf(entrypoint: string | undefined) {
  return entrypoint !== "sdk-cli";
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Claude 的 `message.usage` → §6.1 的 NormalizedUsage。
 * 四個 token 欄位任一個不是非負整數，就不寫那個欄位（不補 0），記進 unknownFields。
 */
export function normalizeUsage(usage: Record<string, unknown>, sourceKey: string): NormalizedUsage {
  const inputNonCache = numOrNull(usage.input_tokens);
  const cacheRead = numOrNull(usage.cache_read_input_tokens);
  const cacheWrite = numOrNull(usage.cache_creation_input_tokens);
  const output = numOrNull(usage.output_tokens);
  const known: Record<UsageField, number | null> = { inputNonCache, cacheRead, cacheWrite, output };
  const unknownFields = USAGE_FIELDS.filter((field) => known[field] === null);
  const tokens = USAGE_FIELDS.reduce((total, field) => total + (known[field] ?? 0), 0);
  const normalized: NormalizedUsage = {
    sourceKey,
    costKnown: 0,
    // Claude 的 transcript 沒有價格；有 token 就代表這筆的價格未知，不當成 0。
    costUnknownEntries: tokens > 0 || unknownFields.length > 0 ? 1 : 0,
  };
  for (const field of USAGE_FIELDS) {
    const value = known[field];
    if (value !== null) normalized[field] = value;
  }
  if (unknownFields.length) normalized.unknownFields = unknownFields;
  return normalized;
}

export interface TranscriptUsage {
  messageId: string;
  usage: NormalizedUsage;
}

/**
 * 從 transcript 的行裡挑出 assistant usage。同一個 message ID 只留最後一次看到的快照。
 * `since` 之後才有紀錄屬於這個 epoch：resume 時舊帳不重算（§6.2）。
 */
export function transcriptUsage(
  lines: string[],
  options: { sessionId: string; includeSidechain: boolean; since?: number; cliVersion?: string },
): { entries: TranscriptUsage[]; seenVersion: string | null } {
  const byId = new Map<string, TranscriptUsage>();
  let seenVersion: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 寫到一半的行：下一次 hook 再讀
    }
    if (!record || typeof record !== "object") continue;
    if (typeof record.version === "string" && record.version) seenVersion ??= record.version;
    if (record.type !== "assistant") continue;
    if (!options.includeSidechain && record.isSidechain === true) continue;
    const message = record.message as { id?: unknown; usage?: unknown } | undefined;
    if (!message || typeof message !== "object") continue;
    const messageId = typeof message.id === "string" ? message.id : "";
    if (!messageId) continue;
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    if (options.since !== undefined && Number.isFinite(at) && at < options.since) continue;
    byId.set(messageId, {
      messageId,
      usage: normalizeUsage(usage as Record<string, unknown>, `${CLI}#${options.sessionId}#${messageId}`),
    });
  }
  return { entries: [...byId.values()], seenVersion };
}

/** visit 開始當下自己問 git：之後 worktree 被刪掉，mod 仍能歸到正確的城（§6.1）。 */
export function gitFacts(cwd: string, run: typeof execFileSync = execFileSync) {
  const ask = (args: string[]) => {
    try {
      const out = run("git", args, { cwd, timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      return out || null;
    } catch {
      return null;
    }
  };
  return {
    commonDir: ask(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    checkout: ask(["rev-parse", "--show-toplevel"]),
  };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), "utf8");
  fs.renameSync(temp, file);
}

function logError(root: string, where: string, error: unknown) {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, "errors.log"), `${new Date().toISOString()} claude:${where} ${String(error)}\n`);
  } catch {
    // 記錄錯誤不能弄壞 agent。
  }
}

/**
 * mod 的 ack：只讀自己 epoch 的。ack 檔在每一座城的目錄底下，所以要掃 cities/。
 * 讀不到、讀壞了都當成「還沒有 ack」。
 */
function ackedEventSeq(root: string, sessionId: string, epoch: string): number {
  const citiesDir = path.join(root, "cities");
  let acked = 0;
  let cities: string[];
  try {
    cities = fs.readdirSync(citiesDir);
  } catch {
    return 0;
  }
  for (const city of cities) {
    const file = path.join(citiesDir, city, "acks", safeName(sessionId), `${safeName(epoch)}.json`);
    const ack = readJson(file);
    if (ack && typeof ack.ackedEventSeq === "number") acked = Math.max(acked, ack.ackedEventSeq);
  }
  return acked;
}

/** 取得寫入者層級的鎖：hook 是獨立行程，讀改寫不能互相蓋掉。 */
function acquireLock(file: string) {
  const lockDir = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      return true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > 5_000) fs.rmdirSync(lockDir); // 前一個行程死在鎖裡
      } catch {
        // 別人的鎖，繼續等
      }
      const wait = Date.now() + 5;
      while (Date.now() < wait) {
        /* 短暫等待；hook 的 timeout 遠大於此 */
      }
    }
  }
  return false;
}

function releaseLock(file: string) {
  try {
    fs.rmdirSync(`${file}.lock`);
  } catch {
    // 已經被清掉就算了
  }
}

function epochMapFileOf(root: string, sessionId: string, pid: number) {
  return path.join(root, "claude-state", safeName(sessionId), `pid-${pid}.json`);
}

/** SessionStart on a new process rotates the epoch; compact/clear retain this process's writer. */
function writerEpochFor(root: string, sessionId: string, input: HookInput, env: HookEnv) {
  const file = epochMapFileOf(root, sessionId, env.pid);
  const saved = readJson(file);
  const startsProcess = input.hook_event_name === "SessionStart" &&
    ["startup", "resume", "fork"].includes(input.source ?? "");
  if (!startsProcess && typeof saved?.writerEpoch === "string") return saved.writerEpoch;
  const epoch = writerEpochOf(env.pid, env.now);
  writeAtomic(file, { writerEpoch: epoch });
  return epoch;
}

/** 一次 hook 呼叫的寫入者。事件先在記憶體累積，最後一次寫檔。 */
export class HookRun {
  readonly root: string;
  readonly sessionId: string;
  readonly epoch: string;
  readonly file: string;
  private readonly stateFile: string;
  private state: WriterState;
  private activity: Activity;
  private pending: ActivityEvent[] = [];

  constructor(root: string, input: HookInput, env: HookEnv) {
    this.root = root;
    this.sessionId = sessionIdOf(input, env);
    this.epoch = writerEpochFor(root, this.sessionId, input, env);
    this.file = activityFileOf(root, this.sessionId, this.epoch);
    this.stateFile = stateFileOf(root, this.sessionId, this.epoch);
    const existing = readJson(this.file);
    const existingEvents = Array.isArray(existing?.events) ? (existing.events as ActivityEvent[]) : [];
    const state: WriterState = {
      seq: 0,
      startedAt: env.now,
      role: roleOf(input, this.sessionId),
      interactive: interactiveOf(env.entrypoint),
      ...(parentOf(input) ? { parentSessionId: parentOf(input) } : {}),
      visit: null,
      intervalOpen: false,
    };
    const saved = readJson(this.stateFile) as Partial<WriterState> | null;
    if (saved) Object.assign(state, saved);
    else {
      // 沒有狀態檔（例如第一次遇到、或狀態檔被清掉）：從既有活動回復。
      state.seq = existingEvents.reduce((latest, event) => Math.max(latest, event.eventSeq ?? 0), 0);
      state.visit = lastVisit(existingEvents);
      state.intervalOpen = intervalIsOpen(existingEvents);
      if (existing?.interactive === true) state.interactive = true;
      if (typeof existing?.role === "string") state.role = existing.role as Role;
      if (typeof existing?.parentSessionId === "string") state.parentSessionId = existing.parentSessionId;
    }
    state.seq = Math.max(state.seq, existingEvents.reduce((latest, event) => Math.max(latest, event.eventSeq ?? 0), 0));
    if (input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop") {
      state.role = "child";
      state.interactive = false;
      state.parentSessionId = parentOf(input) ?? undefined;
    }
    this.state = state;
    this.activity = {
      schema: SCHEMA,
      cli: CLI,
      cliVersion: typeof existing?.cliVersion === "string" ? existing.cliVersion : "unknown",
      capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
      sessionId: this.sessionId,
      role: state.role,
      ...(state.parentSessionId ? { parentSessionId: state.parentSessionId } : {}),
      interactive: state.interactive,
      writerEpoch: this.epoch,
      events: existingEvents,
      updatedAt: typeof existing?.updatedAt === "number" ? existing.updatedAt : env.now,
    };
  }

  get events(): ActivityEvent[] {
    return this.activity.events;
  }

  private emit(kind: Kind, at: number, extra: Partial<ActivityEvent> = {}) {
    const event: ActivityEvent = { eventSeq: ++this.state.seq, kind, at, ...extra };
    this.activity.events.push(event);
    this.pending.push(event);
    this.activity.updatedAt = Math.max(this.activity.updatedAt, at);
  }

  /** cwd 改變就切一段新的 visit（§6.3：worktree、/cd、/move 之後）。 */
  syncVisit(input: HookInput, at: number) {
    const cwd = input.cwd || process.cwd();
    if (this.state.visit && this.state.visit.cwd === cwd) return;
    const wasOpen = this.state.intervalOpen;
    if (this.state.visit) {
      this.closeInterval(at);
      this.emit("visit_end", at);
    }
    const facts = gitFacts(cwd);
    this.state.visit = { visitId: randomUUID(), cwd, commonDir: facts.commonDir, checkout: facts.checkout };
    this.emit("visit_start", at, { visit: this.state.visit });
    if (wasOpen) this.openInterval(at);
  }

  openInterval(at: number) {
    if (this.state.intervalOpen) return;
    this.state.intervalOpen = true;
    this.emit("interval_open", at);
  }

  closeInterval(at: number) {
    if (!this.state.intervalOpen) return;
    this.state.intervalOpen = false;
    this.emit("interval_close", at);
  }

  heartbeat(at: number) {
    if (!this.state.intervalOpen) return;
    this.emit("heartbeat", at);
  }

  turnEnd(at: number, input: HookInput) {
    this.emit("turn_end", at, { turnId: input.prompt_id });
  }

  /** 讀某一份 transcript 的新用量，一個 message ID 一筆事件。 */
  flushUsage(at: number, input: HookInput, file: string | undefined, includeSidechain: boolean) {
    if (!file) return;
    if (includeSidechain) {
      // SubagentStop can fire before the final transcript append becomes visible. Wait for
      // the file to appear and then remain unchanged for one poll before reading it.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      let previous = "";
      for (let attempt = 0; attempt < 12; attempt++) {
        let current = "";
        try {
          const stat = fs.statSync(file);
          current = `${stat.size}:${stat.mtimeMs}`;
        } catch {
          // The runtime may create agent_transcript_path after the stop hook begins.
        }
        if (current && current === previous) break;
        previous = current;
        Atomics.wait(wait, 0, 0, 20);
      }
    }
    let lines: string[];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      return; // transcript 還沒出現：不是 0 消耗，只是還沒有可證明的用量
    }
    const already = new Set(
      this.activity.events.filter((event) => event.kind === "usage" && event.sourceEntryId).map((event) => event.sourceEntryId as string),
    );
    const { entries, seenVersion } = transcriptUsage(lines, {
      sessionId: this.sessionId,
      includeSidechain,
      ...(includeSidechain ? {} : { since: this.state.startedAt }),
    });
    if (seenVersion && this.activity.cliVersion === "unknown") this.activity.cliVersion = seenVersion;
    for (const entry of entries) {
      if (already.has(entry.messageId)) continue;
      already.add(entry.messageId);
      this.emit("usage", at, { usage: { anthropic: entry.usage }, sourceEntryId: entry.messageId });
    }
  }
  /** 收尾 visit：區間還開著就先關，再結束這一段。 */
  visitEnd(at: number) {
    this.closeInterval(at);
    if (!this.state.visit) return;
    this.emit("visit_end", at);
    this.state.visit = null;
  }

  /** 寫檔；順便把已經 ack 的事件刪掉（只能刪 eventSeq ≤ ackedEventSeq，§6.2）。 */
  save() {
    const locked = acquireLock(this.file);
    try {
      // 別的程序（同一個 epoch 的另一個 hook）可能在中間寫過：重讀後把自己的事件接上去。
      const onDisk = readJson(this.file);
      const diskEvents = Array.isArray(onDisk?.events) ? (onDisk.events as ActivityEvent[]) : [];
      const bySeq = new Map(diskEvents.map((event) => [event.eventSeq, event]));
      for (const event of this.activity.events) bySeq.set(event.eventSeq, event);
      let events = [...bySeq.values()].sort((a, b) => a.eventSeq - b.eventSeq);
      const acked = ackedEventSeq(this.root, this.sessionId, this.epoch);
      if (acked > 0) events = events.filter((event) => event.eventSeq > acked);
      this.activity.events = events;
      writeAtomic(this.file, this.activity);
      writeAtomic(this.stateFile, this.state);
    } catch (error) {
      logError(this.root, "save", error);
    } finally {
      if (locked) releaseLock(this.file);
    }
  }
}

function sessionIdOf(input: HookInput, env: HookEnv): string {
  const parent = typeof input.session_id === "string" ? input.session_id : "";
  if (input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop") {
    const agentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : `${env.pid}`;
    return childSessionId(parent || `unknown-${env.pid}`, agentId);
  }
  return parent || `unknown-${env.pid}`;
}

function parentOf(input: HookInput): string | undefined {
  if (input.hook_event_name !== "SubagentStart" && input.hook_event_name !== "SubagentStop") return undefined;
  return typeof input.session_id === "string" && input.session_id ? input.session_id : undefined;
}

function roleOf(input: HookInput, sessionId: string): Role {
  if (input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop") return "child";
  if (sessionId.includes("~sub~")) return "child";
  if (input.hook_event_name === "SessionStart" && input.source === "fork") return "fork";
  return "root";
}

function lastVisit(events: ActivityEvent[]): Visit | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind === "visit_start" && event.visit) return event.visit;
    if (event.kind === "visit_end") return null;
  }
  return null;
}

function intervalIsOpen(events: ActivityEvent[]): boolean {
  let open = false;
  for (const event of events) {
    if (event.kind === "visit_start" || event.kind === "visit_end" || event.kind === "interval_close") open = false;
    else if (event.kind === "interval_open") open = true;
  }
  return open;
}

/** 一個 hook 呼叫要接的事件。分開成純函式，測試不用真的開子行程。 */
export function handleHook(input: HookInput, env: HookEnv): { sessionId: string; writerEpoch: string; eventCount: number } {
  const run = new HookRun(rootOf(env.appHome), input, env);
  const at = env.now;
  try {
    switch (input.hook_event_name ?? "") {
      case "SessionStart":
        run.syncVisit(input, at);
        break;
      case "UserPromptSubmit":
        run.syncVisit(input, at);
        run.openInterval(at);
        run.heartbeat(at);
        break;
      case "PreToolUse":
        run.syncVisit(input, at);
        run.heartbeat(at);
        break;
      case "SubagentStart":
        run.syncVisit(input, at);
        run.openInterval(at);
        break;
      case "SubagentStop":
        run.flushUsage(at, input, input.agent_transcript_path, true);
        run.visitEnd(at);
        break;
      case "Stop":
        run.flushUsage(at, input, input.transcript_path, false);
        run.closeInterval(at);
        run.turnEnd(at, input);
        break;
      case "PreCompact":
        run.flushUsage(at, input, input.transcript_path, false);
        run.heartbeat(at);
        break;
      case "SessionEnd":
        run.flushUsage(at, input, input.transcript_path, false);
        run.visitEnd(at);
        break;
      default:
        break;
    }
  } finally {
    run.save();
  }
  return { sessionId: run.sessionId, writerEpoch: run.epoch, eventCount: run.events.length };
}

const HERDR_APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");

function main() {
  const raw = fs.readFileSync(0, "utf8");
  let input: HookInput;
  try {
    input = JSON.parse(raw || "{}") as HookInput;
  } catch (error) {
    logError(rootOf(HERDR_APP_HOME), "stdin", error);
    return;
  }
  const env: HookEnv = {
    appHome: HERDR_APP_HOME,
    pid: Number(process.env.CLAUDE_PID) || process.ppid,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? "",
    now: Date.now(),
  };
  try {
    handleHook(input, env);
  } catch (error) {
    logError(rootOf(HERDR_APP_HOME), input.hook_event_name ?? "hook", error);
  }
}

if (import.meta.main) main();
