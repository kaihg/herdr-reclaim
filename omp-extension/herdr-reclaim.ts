// herdr-reclaim: omp extension for the herdr 開墾城鎮 mod (spikes S1 / S2).
//
// Writes small JSON files under $HERDR_RECLAIM_STATE (default ~/.local/state/herdr-reclaim):
//   terminals/<HC_TERMINAL_ID>.json  which root session the terminal runs now (S1)
//   sessions/<sessionId>.json        cumulative usage of one session, per provider (S2)
// Only runs inside a herdr terminal (HC_TERMINAL_ID) and never in an omp started from
// another omp's shell (OMPCODE=1). Reads nothing outside omp's own session state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The fields this extension reads from omp's session entries (SessionEntry in
 * omp's session-entries.ts). omp owns and validates this shape before handing it out.
 */
interface SessionEntryView {
  type: string;
  id?: string;
  provider?: string;
  usage?: Usage;
  message?: { role?: string; provider?: string; usage?: Usage };
}

/** The slice of omp's ReadonlySessionManager this extension reads. */
interface SessionManagerView {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getHeader(): { parentSession?: string } | null;
  getEntries(): SessionEntryView[];
}

interface HandlerContext {
  hasUI: boolean;
  sessionManager: SessionManagerView;
}

interface ExtensionApi {
  on(event: string, handler: (event: { reason?: string } | undefined, ctx: HandlerContext) => void): void;
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface ProviderTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  entries: number;
  unknownCostEntries: number;
}

const TERMINAL = process.env.HC_TERMINAL_ID;
const ORDER = process.env.HERDR_RECLAIM_ORDER || null;
const STATE = process.env.HERDR_RECLAIM_STATE || path.join(os.homedir(), ".local", "state", "herdr-reclaim");
const SCHEMA = 1;

function writeAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** File-name-safe form of a terminal or session id. */
function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function num(v: unknown) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// The usage-bearing entries omp records: assistant messages and model_usage side calls
// (titles, auto-thinking). Task tool results carry their children's spend as a summary;
// children write their own files, so tool results are deliberately skipped here.
function usageOf(entry: SessionEntryView): { provider: string; usage: Usage } | null {
  if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
    return { provider: entry.message.provider ?? "unknown", usage: entry.message.usage };
  }
  if (entry.type === "model_usage" && entry.usage) {
    return { provider: entry.provider ?? "unknown", usage: entry.usage };
  }
  return null;
}

function summarize(sm: SessionManagerView) {
  const byProvider: Record<string, ProviderTotals> = {};
  let entries = 0;
  let lastEntryId: string | null = null;
  for (const entry of sm.getEntries()) {
    const hit = usageOf(entry);
    if (!hit) continue;
    const u = hit.usage;
    const p = (byProvider[hit.provider] ??= {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, entries: 0, unknownCostEntries: 0,
    });
    const tokens = num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
    const cost = num(u.cost?.total);
    p.input += num(u.input);
    p.output += num(u.output);
    p.cacheRead += num(u.cacheRead);
    p.cacheWrite += num(u.cacheWrite);
    p.cost += cost;
    p.entries += 1;
    // A zero price with real tokens means the price is not known (e.g. a custom endpoint).
    if (cost === 0 && tokens > 0) p.unknownCostEntries += 1;
    entries += 1;
    lastEntryId = entry.id ?? lastEntryId;
  }
  return { byProvider, entries, lastEntryId };
}

/** Children live under "<parent file without .jsonl>/<Name>.jsonl", possibly nested. */
function rootSessionFile(file: string | undefined, parentSession: string | undefined): string | null {
  if (!file) return null;
  if (!parentSession) return file;
  let parent = parentSession;
  for (let depth = 0; depth < 16; depth++) {
    const owner = `${path.dirname(parent)}.jsonl`;
    if (!fs.existsSync(owner)) break;
    parent = owner;
  }
  return parent;
}

/**
 * Root session files are named "<timestamp>_<sessionId>.jsonl". The id survives /move,
 * which rewrites the path, so consumers group a family by this id, not by path.
 */
function sessionIdFromFile(file: string | null): string | null {
  const match = file ? /_([^_/]+)\.jsonl$/.exec(file) : null;
  return match ? match[1] : null;
}

function logError(where: string, err: unknown) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(path.join(STATE, "errors.log"), `${new Date().toISOString()} ${where} ${String(err)}\n`);
  } catch {
    // Logging must never break the agent.
  }
}

export default function (pi: ExtensionApi) {
  if (!TERMINAL || process.env.OMPCODE === "1") return;
  let generation = 0;

  function writeSession(ctx: HandlerContext, reason: string) {
    try {
      const sm = ctx.sessionManager;
      const id = sm.getSessionId();
      if (!id) return;
      const file = sm.getSessionFile();
      const parentSession = sm.getHeader()?.parentSession;
      writeAtomic(path.join(STATE, "sessions", `${safeName(id)}.json`), {
        schema: SCHEMA,
        sessionId: id,
        sessionFile: file ?? null,
        parentSessionFile: parentSession ?? null,
        rootSessionFile: rootSessionFile(file, parentSession),
        rootSessionId: parentSession ? sessionIdFromFile(rootSessionFile(file, parentSession)) : id,
        root: ctx.hasUI === true,
        terminal: TERMINAL,
        order: ORDER,
        cwd: sm.getCwd(),
        reason,
        updatedAt: Date.now(),
        ...summarize(sm),
      });
    } catch (err) {
      logError("session", err);
    }
  }

  function writeTerminal(ctx: HandlerContext, reason: string) {
    if (ctx.hasUI !== true) return; // subagents never own the terminal
    try {
      const sm = ctx.sessionManager;
      const id = sm.getSessionId();
      if (!id) return;
      generation += 1;
      writeAtomic(path.join(STATE, "terminals", `${safeName(TERMINAL!)}.json`), {
        schema: SCHEMA,
        terminal: TERMINAL,
        order: ORDER,
        sessionId: id,
        sessionFile: sm.getSessionFile() ?? null,
        cwd: sm.getCwd(),
        pid: process.pid,
        generation,
        reason,
        updatedAt: Date.now(),
      });
    } catch (err) {
      logError("terminal", err);
    }
  }

  for (const event of ["session_start", "session_switch", "agent_start", "agent_end"]) {
    pi.on(event, (payload, ctx) => {
      const reason = payload?.reason ? `${event}:${payload.reason}` : event;
      writeTerminal(ctx, reason);
      writeSession(ctx, reason);
    });
  }
  pi.on("turn_end", (_payload, ctx) => writeSession(ctx, "turn_end"));
  pi.on("session_shutdown", (_payload, ctx) => writeSession(ctx, "session_shutdown"));
}
