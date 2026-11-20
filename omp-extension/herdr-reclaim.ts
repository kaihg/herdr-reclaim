// herdr-reclaim：omp 遠征 adapter（proposal §6.1／§6.2／§6.3；ticket #5）。
//
// 一個寫入者（sessionId + writerEpoch）寫一個活動檔，mod 讀它、寫進城帳本，成功之後才寫 ack：
//   <root>/activity/<sessionId>/<writerEpoch>.json             這裡寫
//   <root>/cities/<城的雜湊>/acks/<sessionId>/<epoch>.json     mod 寫；這裡只讀自己的 epoch
// root = $HERDR_APP_HOME/data/herdr-reclaim，$HERDR_APP_HOME 預設 ~/.config/herdr-app
// ——跟 mod 讀的是同一個根目錄，不設分離的 adapter state path。
// 舊 epoch 的檔案留著（不刪），mod 之後仍可以離線重播（§6.2）。
//
// 身分：用 ctx.agent.kind 分 main／sub（不看 depth、PID 或 hasUI）；sub 是 child，
// main 且有 header.parentSession 的是 fork，其餘是 root。hasUI 只決定 interactive
// （只有互動的 root 與 fork 會建格）。child 的 parentSessionId 取 header.parentSession
// （可能是 session ID 或檔案路徑，兩種都正規化成 session ID）。
// 用量：每個來源 entry 一個事件，帶 sourceEntryId（＝omp 的 entry id）。游標起點排除
// 「這個 epoch 開始前就有的 entry」——fork 繼承的歷史與 resume 之前的舊帳都不重算，
// 而且 mod 端還有同一把 key 的防重（§15.6 的歧義反例）。
// 時間：agent_start 開一段 interval，agent_end 關；ctx.setInterval 每 60 秒寫一次
// heartbeat。沒有正常關閉的 interval 只算到最後一次寫入磁碟的 heartbeat（§6.2）。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Kind =
  | "visit_start"
  | "visit_end"
  | "interval_open"
  | "heartbeat"
  | "interval_close"
  | "usage"
  | "turn_end";
type Role = "root" | "child" | "fork";

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface NormalizedUsage {
  /** 穩定的跨 epoch 去重 key：cli + sessionId + omp source entry id（§15.6）。 */
  sourceKey: string;
  inputNonCache: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costKnown: number;
  costUnknownEntries: number;
}

interface Visit {
  visitId: string;
  cwd: string;
  commonDir: string | null;
  checkout: string | null;
}

interface ActivityEvent {
  eventSeq: number;
  kind: Kind;
  at: number;
  visit?: Visit;
  usage?: Record<string, NormalizedUsage>;
  /** 這一筆用量來自哪一個 omp session entry（穩定來源 key 的一部分）。 */
  sourceEntryId?: string;
  turnId?: string;
}

interface Activity {
  schema: 1;
  cli: "omp";
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

/** 這個 extension 讀的 session entry 欄位（omp 的 SessionEntry）。 */
interface SessionEntryView {
  type: string;
  id?: string;
  provider?: string;
  usage?: Usage;
  message?: { role?: string; provider?: string; usage?: Usage };
}

/** 這個 extension 讀的 ReadonlySessionManager 切片。 */
interface SessionManagerView {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getArtifactsDir?(): string | undefined;
  getCwd(): string;
  getHeader(): { parentSession?: string } | null;
  getEntries(): SessionEntryView[];
}

interface HandlerContext {
  mode: string;
  hasUI: boolean;
  cwd: string;
  agent: { kind: "main" | "sub"; id: string; name: string; depth: number; parentId?: string } | undefined;
  sessionManager: SessionManagerView;
  setInterval(callback: () => void, ms?: number): unknown;
  clearTimer(timer: unknown): void;
}

interface ExtensionApi {
  on(event: string, handler: (event: { reason?: string; turnIndex?: number } | undefined, ctx: HandlerContext) => void): void;
}

const SCHEMA = 1;
const CLI = "omp";
const HEARTBEAT_MS = 60_000;

/** 跟 mod 共用的根目錄（見檔頭）。 */
const HERDR_APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const ROOT = path.join(HERDR_APP_HOME, "data", "herdr-reclaim");
const ACTIVITY_DIR = path.join(ROOT, "activity");
const CITIES_DIR = path.join(ROOT, "cities");
const SOURCES_DIR = path.join(ROOT, "sources");
function detectCliVersion() {
  if (process.env.OMP_VERSION) return process.env.OMP_VERSION;
  try {
    return execFileSync("omp", ["--version"], { timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}
const CLI_VERSION = detectCliVersion();

/** 這個 process 的寫入者 base 身分（§6.1：pid + 啟動時間）；session 切換時另加序號。 */
const WRITER_EPOCH_BASE = `${process.pid}-${Date.now().toString(36)}`;
let writerCount = 0;

function nextWriterEpoch() {
  writerCount += 1;
  return `${WRITER_EPOCH_BASE}-${writerCount}`;
}

/** 檔名安全的 id。 */
function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** header.parentSession 可能是 session ID（fork）或檔案路徑（branch）；統一成 ID。 */
function sessionIdOf(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const match = /_([^_/]+)\.jsonl$/.exec(value);
  return match ? match[1] : value;
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** omp 的 Usage → §6.1 的 NormalizedUsage。價格 0 又有 token 就是「未知」，不填 0當已知。 */
function normalize(usage: Usage, sourceKey: string): NormalizedUsage {
  const inputNonCache = num(usage.input);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const output = num(usage.output);
  const cost = num(usage.cost?.total);
  const tokens = inputNonCache + cacheRead + cacheWrite + output;
  return { sourceKey, inputNonCache, cacheRead, cacheWrite, output, costKnown: cost, costUnknownEntries: cost === 0 && tokens > 0 ? 1 : 0 };
}

/** omp 記用量的兩種 entry：assistant message 與 model_usage 的側呼叫（標題、自動思考）。 */
function usageOf(entry: SessionEntryView): { provider: string; usage: Usage } | null {
  if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
    return { provider: entry.message.provider ?? "unknown", usage: entry.message.usage };
  }
  if (entry.type === "model_usage" && entry.usage) {
    return { provider: entry.provider ?? "unknown", usage: entry.usage };
  }
  return null;
}

/** visit 開始當下自己問 git：之後 worktree 被刪掉，mod 仍能歸到正確的城（§6.1）。 */
function gitFacts(cwd: string): { commonDir: string | null; checkout: string | null } {
  const ask = (args: string[]) => {
    try {
      const out = execFileSync("git", args, { cwd, timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
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

function writeAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), "utf8");
  fs.renameSync(temp, file);
}

/** OMP selective commit records the exact SHA in this session's artifacts journal. */
function syncCommitEvidence(ctx: HandlerContext) {
  try {
    const artifactsDir = ctx.sessionManager.getArtifactsDir?.();
    if (!artifactsDir) return;
    const journal = path.join(artifactsDir, "changes.jsonl");
    if (!fs.existsSync(journal)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    for (const line of fs.readFileSync(journal, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== "object" || !("type" in value) || !("sha" in value)) continue;
      const entry = value as { type?: unknown; sha?: unknown; at?: unknown; parent?: unknown; paths?: unknown };
      if (entry.type !== "commit" || typeof entry.sha !== "string" || !/^[0-9a-f]{40,64}$/i.test(entry.sha)) continue;
      writeAtomic(path.join(SOURCES_DIR, `${entry.sha}.omp.${safeName(sessionId)}.json`), {
        schema: 1,
        sha: entry.sha,
        cli: CLI,
        sessionId,
        at: typeof entry.at === "number" ? entry.at : Date.now(),
        parent: typeof entry.parent === "string" ? entry.parent : null,
        paths: Array.isArray(entry.paths) ? entry.paths.filter((path): path is string => typeof path === "string") : [],
      });
    }
  } catch (error) {
    logError("commit-evidence", error);
  }
}

function logError(where: string, error: unknown) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.appendFileSync(path.join(ROOT, "errors.log"), `${new Date().toISOString()} ${where} ${String(error)}\n`);
  } catch {
    // 記錄錯誤不能弄壞 agent。
  }
}

/**
 * mod 的 ack：只讀自己 epoch 的。ack 檔在每一座城的目錄底下（一座城一個帳本），
 * 所以要掃 cities/；掃不到、讀壞了都當成「還沒有 ack」。
 */
function ackedEventSeq(sessionId: string, writerEpoch: string): number {
  let acked = 0;
  let cities: string[];
  try {
    cities = fs.readdirSync(CITIES_DIR);
  } catch {
    return 0;
  }
  for (const city of cities) {
    try {
      const text = fs.readFileSync(path.join(CITIES_DIR, city, "acks", sessionId, `${writerEpoch}.json`), "utf8");
      const ack = JSON.parse(text) as { ackedEventSeq?: number };
      if (typeof ack.ackedEventSeq === "number") acked = Math.max(acked, ack.ackedEventSeq);
    } catch {
      continue;
    }
  }
  return acked;
}
type EventPayload = { reason?: string; turnIndex?: number } | undefined;

/**
 * 一個寫入者。事件先累積在記憶體，handler 結束時一次寫檔（heartbeat 例外：它自己寫，
 * 而且必須寫進磁碟才算數）。
 */
class Writer {
  readonly sessionId: string;
  readonly role: Role;
  readonly parentSessionId?: string;
  readonly interactive: boolean;
  readonly file: string;
  readonly activity: Activity;
  private seq = 0;
  private visit: Visit | null = null;
  private intervalOpen = false;
  private cursor = 0;
  private acked = 0;
  private startedAt = Date.now();

  constructor(ctx: HandlerContext, epoch: string) {
    this.sessionId = ctx.sessionManager.getSessionId();
    const header = ctx.sessionManager.getHeader();
    const parent = sessionIdOf(header?.parentSession);
    this.role = ctx.agent?.kind === "sub" ? "child" : parent ? "fork" : "root";
    this.parentSessionId = parent;
    this.interactive = ctx.hasUI === true;
    this.file = path.join(ACTIVITY_DIR, safeName(this.sessionId), `${safeName(epoch)}.json`);
    // 這個 epoch 開始前就有的 entry 不算這個 epoch 的用量：fork 的繼承歷史、
    // resume 之前已經由舊 epoch 報過的紀錄（舊 epoch 的檔案還在，mod 會讀到）。
    this.cursor = ctx.sessionManager.getEntries().length;
    this.acked = ackedEventSeq(safeName(this.sessionId), safeName(epoch));
    this.activity = {
      schema: SCHEMA,
      cli: CLI,
      cliVersion: CLI_VERSION,
      capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
      sessionId: this.sessionId,
      role: this.role,
      ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
      interactive: this.interactive,
      writerEpoch: epoch,
      events: [],
      updatedAt: this.startedAt,
    };
  }

  emit(kind: Kind, at: number, extra: Partial<ActivityEvent> = {}) {
    this.activity.events.push({ eventSeq: ++this.seq, kind, at, ...extra });
    this.activity.updatedAt = Math.max(this.activity.updatedAt, at);
  }

  /** 寫檔；順便把已經 ack 的事件刪掉（§6.2：只能刪 eventSeq ≤ ackedEventSeq）。 */
  flush() {
    try {
      const acked = ackedEventSeq(safeName(this.sessionId), this.activity.writerEpoch);
      if (acked > this.acked) {
        this.acked = acked;
        this.activity.events = this.activity.events.filter((event) => event.eventSeq > acked);
      }
      writeAtomic(this.file, this.activity);
    } catch (error) {
      logError("flush", error);
    }
  }

  /** cwd 改變就切一段新的 visit（§6.3：worktree 切換、/move 之後的下一次 agent_start）。 */
  private syncVisit(ctx: HandlerContext, at: number) {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    if (this.visit && this.visit.cwd === cwd) return;
    if (this.visit) {
      this.closeInterval(at);
      this.emit("visit_end", at);
    }
    const facts = gitFacts(cwd);
    this.visit = { visitId: randomUUID(), cwd, commonDir: facts.commonDir, checkout: facts.checkout };
    this.emit("visit_start", at, { visit: this.visit });
  }

  /** visit 開始／切換，但不把 session 閒置時間算成工作時間。 */
  startVisit(ctx: HandlerContext, at: number) {
    this.syncVisit(ctx, at);
  }

  /** 使用者送出 prompt：先確保 visit 是對的（ctx.cwd 會跟著 /move 變），再開區間。 */
  openInterval(ctx: HandlerContext, at: number) {
    this.syncVisit(ctx, at);
    if (this.intervalOpen) return;
    this.intervalOpen = true;
    this.emit("interval_open", at);
  }

  closeInterval(at: number) {
    if (!this.intervalOpen) return;
    this.intervalOpen = false;
    this.emit("interval_close", at);
  }

  heartbeat(at: number) {
    if (!this.intervalOpen) return;
    this.emit("heartbeat", at);
    this.flush();
  }

  /** 掃到目前為止的新 entry，一個來源 entry 一筆用量事件。 */
  flushUsage(ctx: HandlerContext, at: number) {
    const entries = ctx.sessionManager.getEntries();
    if (entries.length < this.cursor) this.cursor = entries.length; // 檔案被別的程序改小：不猜
    for (let index = this.cursor; index < entries.length; index++) {
      const hit = usageOf(entries[index]);
      if (!hit) continue;
      const sourceEntryId = entries[index].id ?? `${entries[index].type}#${index}`;
      this.emit("usage", at, { usage: { [hit.provider]: normalize(hit.usage, `${CLI}#${this.sessionId}#${sourceEntryId}`) }, sourceEntryId });
    }
    this.cursor = entries.length;
  }

  /** 關一段：先關區間、報完用量，最後才結束 visit。 */
  end(ctx: HandlerContext | null, at: number) {
    if (ctx) this.flushUsage(ctx, at);
    this.closeInterval(at);
    if (this.visit) {
      this.emit("visit_end", at);
      this.visit = null;
    }
  }
}

export default function (pi: ExtensionApi) {
  if (process.env.HERDR_RECLAIM_DISABLE === "1") return;
  let writer: Writer | null = null;
  let timer: { timer: unknown; ctx: HandlerContext } | null = null;

  function stopTimer() {
    if (!timer) return;
    try {
      timer.ctx.clearTimer(timer.timer);
    } catch (error) {
      logError("clearTimer", error);
    }
    timer = null;
  }

  function ensure(ctx: HandlerContext): Writer | null {
    let id: string;
    try {
      id = ctx.sessionManager.getSessionId();
    } catch (error) {
      logError("sessionId", error);
      return null;
    }
    if (!id) return null;
    if (writer && writer.sessionId !== id) close(null, Date.now()); // /new、/resume、/fork 換 session
    if (!writer) {
      try {
        writer = new Writer(ctx, nextWriterEpoch());
      } catch (error) {
        logError("open", error);
        return null;
      }
      try {
        const started = writer;
        timer = {
          ctx,
          timer: ctx.setInterval(() => {
            if (writer !== started) return; // 換手之後舊 timer 不再寫
            started.heartbeat(Date.now());
          }, HEARTBEAT_MS),
        };
      } catch (error) {
        logError("setInterval", error);
      }
    }
    return writer;
  }

  /** 這一個 writer 收尾：用量報完、區間關掉、visit 結束、寫檔、清 timer。 */
  function close(ctx: HandlerContext | null, at: number) {
    const current = writer;
    writer = null;
    stopTimer();
    if (!current) return;
    try {
      current.end(ctx, at);
      current.flush();
    } catch (error) {
      logError("close", error);
    }
  }

  /** 所有 handler 的殼：一定寫檔，而且絕不讓例外跑進 agent。 */
  function guard(step: (payload: EventPayload, ctx: HandlerContext) => void) {
    return (payload: EventPayload, ctx: HandlerContext) => {
      try {
        step(payload, ctx);
      } catch (error) {
        logError("handler", error);
      }
    };
  }

  pi.on(
    "session_start",
    guard((_payload, ctx) => {
      const current = ensure(ctx);
      if (!current) return;
      current.startVisit(ctx, Date.now());
      current.flush();
    }),
  );

  pi.on(
    "session_switch",
    guard((_payload, ctx) => {
      const current = ensure(ctx);
      if (!current) return;
      current.startVisit(ctx, Date.now());
      current.flush();
    }),
  );

  pi.on(
    "agent_start",
    guard((_payload, ctx) => {
      const current = ensure(ctx);
      if (!current) return;
      current.openInterval(ctx, Date.now());
      current.flush();
    }),
  );


  pi.on(
    "turn_end",
    guard((payload, ctx) => {
      syncCommitEvidence(ctx);
      const current = ensure(ctx);
      if (!current) return;
      const at = Date.now();
      current.flushUsage(ctx, at);
      current.emit("turn_end", at, { turnId: payload?.turnIndex === undefined ? undefined : String(payload.turnIndex) });
      current.flush();
    }),
  );

  pi.on(
    "agent_end",
    guard((_payload, ctx) => {
      syncCommitEvidence(ctx);
      const current = ensure(ctx);
      if (!current) return;
      const at = Date.now();
      current.flushUsage(ctx, at);
      current.closeInterval(at);
      current.flush();
    }),
  );

  pi.on(
    "session_shutdown",
    guard((_payload, ctx) => {
      syncCommitEvidence(ctx);
      close(ctx, Date.now());
    }),
  );
}
