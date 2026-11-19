// Spike S2: compare the herdr-reclaim extension's per-session usage summaries with a
// direct parse of the omp session files (root + every subagent file under its folder).
// Usage: bun spikes/s2-reconcile.ts <root session .jsonl> [state dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  entries: number;
  unknownCostEntries: number;
}

interface Summary {
  sessionId: string;
  sessionFile: string | null;
  rootSessionId: string | null;
  root: boolean;
  byProvider: Record<string, Totals>;
}

const rootFile = process.argv[2];
const stateDir = process.argv[3] ?? path.join(os.homedir(), ".local", "state", "herdr-reclaim");
if (!rootFile) throw new Error("usage: bun spikes/s2-reconcile.ts <root session .jsonl> [state dir]");
// Root files are "<timestamp>_<sessionId>.jsonl"; /move changes the path but not the id.
const rootId = /_([^_/]+)\.jsonl$/.exec(rootFile)?.[1] ?? null;

const blank = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, entries: 0, unknownCostEntries: 0 });

function sessionFiles(root: string): string[] {
  const files = [root];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith(".jsonl")) {
        files.push(full);
        walk(full.slice(0, -".jsonl".length));
      }
    }
  };
  walk(root.slice(0, -".jsonl".length));
  return files;
}

/** Same counting rule as the extension: assistant message usage + model_usage, nothing else. */
function parseFile(file: string): { sessionId: string | null; totals: Record<string, Totals> } {
  const totals: Record<string, Totals> = {};
  let sessionId: string | null = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e: { type?: string; id?: string; provider?: string; usage?: Record<string, number> & { cost?: { total?: number } }; message?: { role?: string; provider?: string; usage?: Record<string, number> & { cost?: { total?: number } } } };
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a half-written last line
    }
    if (e.type === "session" && e.id) sessionId = e.id;
    const hit =
      e.type === "message" && e.message?.role === "assistant" && e.message.usage
        ? { provider: e.message.provider ?? "unknown", usage: e.message.usage }
        : e.type === "model_usage" && e.usage
          ? { provider: e.provider ?? "unknown", usage: e.usage }
          : null;
    if (!hit) continue;
    const t = (totals[hit.provider] ??= blank());
    const u = hit.usage;
    const cost = u.cost?.total ?? 0;
    t.input += u.input ?? 0;
    t.output += u.output ?? 0;
    t.cacheRead += u.cacheRead ?? 0;
    t.cacheWrite += u.cacheWrite ?? 0;
    t.cost += cost;
    t.entries += 1;
    if (cost === 0 && (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0) t.unknownCostEntries += 1;
  }
  return { sessionId, totals };
}

const summaries = new Map<string, Summary>();
const sessionsDir = path.join(stateDir, "sessions");
for (const name of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
  if (!name.endsWith(".json")) continue;
  const s: Summary = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8"));
  summaries.set(s.sessionId, s);
}

let mismatches = 0;
const rows: string[] = [];
for (const file of sessionFiles(rootFile)) {
  const parsed = parseFile(file);
  const summary = parsed.sessionId ? summaries.get(parsed.sessionId) : undefined;
  const label = path.relative(path.dirname(rootFile), file);
  if (!summary) {
    rows.push(`MISSING  ${label}  (session ${parsed.sessionId}) has no extension summary`);
    mismatches += 1;
    continue;
  }
  if (summary.rootSessionId !== rootId) {
    rows.push(`ROOT?    ${label}  rootSessionId=${summary.rootSessionId} expected ${rootId}`);
    mismatches += 1;
  }
  for (const provider of new Set([...Object.keys(parsed.totals), ...Object.keys(summary.byProvider)])) {
    const a = parsed.totals[provider] ?? blank();
    const b = summary.byProvider[provider] ?? blank();
    const same = (Object.keys(a) as (keyof Totals)[]).every((k) => Math.abs(a[k] - b[k]) < 1e-9);
    if (!same) mismatches += 1;
    rows.push(`${same ? "OK      " : "DIFF    "} ${label}  ${provider}  file=${JSON.stringify(a)}  ext=${JSON.stringify(b)}`);
  }
}
console.log(rows.join("\n"));
console.log(mismatches === 0 ? "S2 reconcile: all match" : `S2 reconcile: ${mismatches} mismatch(es)`);
process.exit(mismatches === 0 ? 0 : 1);
