import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-5-extension-"));
process.env.HERDR_APP_HOME = isolatedHome;
process.env.OMP_VERSION = "fixture-omp";
// 動態匯入是必要的：extension 在 module load 時讀 HERDR_APP_HOME，測試需先指向隔離目錄。
const { default: install } = await import("./herdr-reclaim.ts");

const activityRoot = path.join(isolatedHome, "data", "herdr-reclaim", "activity");
function context({
  sessionId,
  hasUI = true,
  kind = "main",
  parentSession,
  cwd = isolatedHome,
  entries = [],
  artifactsDir = path.join(isolatedHome, "artifacts", sessionId),
} = {}) {
  const timers = [];
  return {
    timers,
    entries,
    mode: hasUI ? "tui" : "print",
    hasUI,
    cwd,
    agent: { kind, id: kind === "main" ? "Main" : "Task", name: kind, depth: kind === "main" ? 0 : 1 },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getArtifactsDir: () => artifactsDir,
      getCwd: () => cwd,
      getHeader: () => parentSession ? { parentSession } : null,
      getEntries: () => entries,
    },
    setInterval(callback, ms) {
      timers.push(callback);
      return callback;
    },
    clearTimer() {},
  };
}

function readActivity(sessionId) {
  const dir = path.join(activityRoot, sessionId);
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  return files.map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
}

function entry(id, input = 5) {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      provider: "openai",
      usage: { input, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0 } },
    },
  };
}

afterAll(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

describe("OMP extension 寫入遠征活動檔", () => {
  test("root、print、child、fork、resume、heartbeat 與 ack compact 都保留正確來源", () => {
    const handlers = new Map();
    install({ on: (name, handler) => handlers.set(name, handler) });
    const fire = (name, payload, ctx) => handlers.get(name)(payload, ctx);

    const root = context({ sessionId: "root-id" });
    fire("session_start", {}, root);
    fire("agent_start", {}, root);
    root.entries.push(entry("source-1"));
    root.timers[0]();
    fire("agent_end", {}, root);

    const [rootFirst] = readActivity("root-id");
    expect(rootFirst.role).toBe("root");
    expect(rootFirst.interactive).toBe(true);
    expect(rootFirst.events.map((event) => event.kind)).toContain("heartbeat");
    const usage = rootFirst.events.find((event) => event.kind === "usage");
    expect(usage.usage.openai.sourceKey).toBe("omp#root-id#source-1");
    expect(usage.usage.openai.inputNonCache).toBe(5);

    const ack = path.join(isolatedHome, "data", "herdr-reclaim", "cities", "fixture", "acks", "root-id", `${rootFirst.writerEpoch}.json`);
    fs.mkdirSync(path.dirname(ack), { recursive: true });
    fs.writeFileSync(ack, JSON.stringify({ ackedEventSeq: usage.eventSeq, journalSeq: 3 }));
    fire("agent_start", {}, root);
    const compacted = readActivity("root-id")[0];
    expect(compacted.events.every((event) => event.eventSeq > usage.eventSeq)).toBe(true);

    const print = context({ sessionId: "print-id", hasUI: false });
    fire("session_start", {}, print);
    expect(readActivity("print-id")[0]).toMatchObject({ role: "root", interactive: false });

    const child = context({ sessionId: "child-id", hasUI: false, kind: "sub", parentSession: "root-id" });
    fire("session_switch", { reason: "new" }, child);
    expect(readActivity("child-id")[0]).toMatchObject({ role: "child", parentSessionId: "root-id", interactive: false });

    const fork = context({ sessionId: "fork-id", parentSession: "/tmp/sessions/2026_fork-id.jsonl", entries: [entry("inherited")] });
    fire("session_switch", { reason: "fork" }, fork);
    fork.entries.push(entry("fork-own"));
    fire("agent_end", {}, fork);
    const forkActivity = readActivity("fork-id")[0];
    expect(forkActivity).toMatchObject({ role: "fork", parentSessionId: "fork-id" });
    expect(forkActivity.events.filter((event) => event.kind === "usage").map((event) => event.sourceEntryId)).toEqual(["fork-own"]);

    const newSession = context({ sessionId: "new-id" });
    fire("session_switch", { reason: "new" }, newSession);
    fire("session_switch", { reason: "resume" }, root);
    expect(readActivity("root-id")).toHaveLength(2);
    expect(readActivity("root-id").map((record) => record.writerEpoch).sort()).toHaveLength(2);
  });
  test("selective commit 的 artifacts 只寫入同一個精確 SHA 的來源憑證", () => {
    const handlers = new Map();
    install({ on: (name, handler) => handlers.set(name, handler) });
    const artifactsDir = path.join(isolatedHome, "artifacts", "selective-session");
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, "changes.jsonl"), [
      JSON.stringify({ type: "commit", sha: "0123456789abcdef0123456789abcdef01234567", paths: ["src/app.js"] }),
      JSON.stringify({ type: "commit", sha: "89abcdef0123456789abcdef0123456789abcdef", paths: ["test/app.test.js"] }),
    ].join("\n"));
    handlers.get("turn_end")({}, context({ sessionId: "selective-session", cwd: "/tmp/selective-repo", artifactsDir }));
    const evidenceDir = path.join(isolatedHome, "data", "herdr-reclaim", "sources");
    const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, "0123456789abcdef0123456789abcdef01234567.omp.selective-session.json"), "utf8"));
    expect(evidence).toMatchObject({ sha: "0123456789abcdef0123456789abcdef01234567", sessionId: "selective-session", cli: "omp" });
    expect(evidence.paths).toEqual(["src/app.js"]);
    expect(fs.existsSync(path.join(evidenceDir, "89abcdef0123456789abcdef0123456789abcdef.omp.selective-session.json"))).toBe(true);
  });
});
