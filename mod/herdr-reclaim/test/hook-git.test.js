import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installHooks } from "../core/hooks.js";
import { CityLedger } from "../core/ledger.js";
import { ingestScenario, ingestResearch, processLand, redispatch } from "../core/ingest.js";
import { commitContexts, ingestCommits } from "../core/commit-evidence.js";
import { activity, visitStart } from "../scenarios/first-expedition.js";
import { createFileIo } from "./fs-io.js";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const exec = async (command, args = []) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const io = {
  async read(file) { try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
  async write(file, text) { writeFileSync(file, text); },
};

describe("Git commit hook 線上證據", () => {
  test("初始與一般 OMP bash commit 產生可配對的 repo/SHA 證據", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "reclaim-git-live-"));
    const appHome = path.join(repo, "isolated-home");
    try {
      run("git", ["init", "-q", repo]);
      run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
      run("git", ["-C", repo, "config", "user.name", "Test"]);
      const customHooks = path.join(repo, "custom-hooks");
      run("git", ["-C", repo, "config", "--local", "core.hooksPath", customHooks]);
      expect((await installHooks({ repo, appHome, io, exec })).status).toBe("installed");
      writeFileSync(path.join(repo, "README.md"), "first\n");
      run("git", ["-C", repo, "add", "README.md"]);
      const env = { ...process.env, PI_SESSION_ID: "session-exact", PI_TOOL_CALL_ID: "tool-exact", HC_TERMINAL_ID: "terminal" };
      run("git", ["-C", repo, "commit", "-m", "initial"], { env });
      const sha = run("git", ["-C", repo, "rev-parse", "HEAD"]);
      const recordsDir = path.join(appHome, "data/herdr-reclaim/commits");
      const files = readdirSync(recordsDir).filter((file) => file.startsWith(`${sha}.post-commit.`)).map((file) => path.join(recordsDir, file));
      expect(files).toHaveLength(1);
      const record = JSON.parse(readFileSync(files[0], "utf8"));
      expect(record.sha).toBe(sha);
      expect(record.hook).toBe("post-commit");
      expect(record.commonDir).toBe(run("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]));
      expect(record.toplevel).toBe(realpathSync(repo));
      expect(record.env.PI_SESSION_ID).toBe("session-exact");
      expect(record.env.PI_TOOL_CALL_ID).toBe("tool-exact");
      expect(record.reason).toBe("");
      expect(record.env).not.toHaveProperty("HC_TERMINAL_ID");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  test("Git 操作矩陣記錄 amend/rebase/cherry-pick/revert/conflict/no-ff merge", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "reclaim-git-matrix-"));
    const appHome = path.join(repo, "isolated-home");
    try {
      run("git", ["init", "-q", repo]);
      run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
      run("git", ["-C", repo, "config", "user.name", "Test"]);
      const hooks = path.join(repo, "hooks");
      run("git", ["-C", repo, "config", "--local", "core.hooksPath", hooks]);
      expect((await installHooks({ repo, appHome, io, exec })).status).toBe("installed");
      const branch = run("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"]);
      const commitFile = (name, value, message) => {
        writeFileSync(path.join(repo, name), value);
        run("git", ["-C", repo, "add", name]);
        run("git", ["-C", repo, "commit", "-m", message], { env: { ...process.env, PI_SESSION_ID: "matrix-session" } });
        return run("git", ["-C", repo, "rev-parse", "HEAD"]);
      };
      commitFile("base.txt", "base\n", "initial");
      mkdirSync(path.join(repo, "src"), { recursive: true });
      commitFile("src/main.js", "one\n", "normal");
      writeFileSync(path.join(repo, "src/main.js"), "amended\n");
      run("git", ["-C", repo, "add", "src/main.js"]);
      run("git", ["-C", repo, "commit", "--amend", "-qm", "amended"], { env: { ...process.env, PI_SESSION_ID: "matrix-session" } });
      const amended = run("git", ["-C", repo, "rev-parse", "HEAD"]);
      run("git", ["-C", repo, "switch", "-c", "rewrite-branch"]);
      commitFile("branch-a.txt", "a\n", "branch a");
      const cherryPick = commitFile("branch-b.txt", "b\n", "branch b");
      run("git", ["-C", repo, "switch", branch]);
      commitFile("parallel.txt", "main\n", "parallel main");
      run("git", ["-C", repo, "switch", "rewrite-branch"]);
      run("git", ["-C", repo, "rebase", branch]);
      run("git", ["-C", repo, "switch", branch]);
      run("git", ["-C", repo, "cherry-pick", cherryPick]);
      const picked = run("git", ["-C", repo, "rev-parse", "HEAD"]);
      run("git", ["-C", repo, "revert", "--no-edit", picked]);
      run("git", ["-C", repo, "switch", "-c", "conflict-branch"]);
      commitFile("shared.txt", "branch side\n", "branch conflict side");
      run("git", ["-C", repo, "switch", branch]);
      commitFile("shared.txt", "main side\n", "main conflict side");
      const conflict = spawnSync("git", ["-C", repo, "merge", "--no-ff", "conflict-branch"], { encoding: "utf8" });
      expect(conflict.status).not.toBe(0);
      writeFileSync(path.join(repo, "shared.txt"), "resolved\n");
      run("git", ["-C", repo, "add", "shared.txt"]);
      run("git", ["-C", repo, "commit", "-m", "resolve conflict"]);
      run("git", ["-C", repo, "switch", "-c", "no-ff-side"]);
      commitFile("side.txt", "side\n", "no-ff side");
      run("git", ["-C", repo, "switch", branch]);
      commitFile("main.txt", "main\n", "no-ff main");
      run("git", ["-C", repo, "merge", "--no-ff", "no-ff-side", "-m", "no-ff merge"]);
      const recordsDir = path.join(appHome, "data/herdr-reclaim/commits");
      const records = readdirSync(recordsDir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(path.join(recordsDir, file), "utf8")));
      expect(records.some((record) => record.sha === amended && record.hook === "post-rewrite")).toBe(true);
      expect(records.some((record) => record.hook === "post-rewrite" && record.rewrite.includes(" "))).toBe(true);
      expect(records.some((record) => record.hook === "post-merge")).toBe(true);
      expect(records.some((record) => record.hook === "post-commit" && record.sha === picked)).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("真 hook 的提交時間", () => {
  test("記下真正的提交事件時間：離線後才重播仍歸到當時的 generation，也不誤發研究", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "reclaim-git-time-"));
    const appHome = path.join(repo, "isolated-home");
    try {
      run("git", ["init", "-q", repo]);
      run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
      run("git", ["-C", repo, "config", "user.name", "Test"]);
      run("git", ["-C", repo, "config", "--local", "core.hooksPath", path.join(repo, "hooks")]);
      expect((await installHooks({ repo, appHome, io, exec })).status).toBe("installed");

      const sessionId = "session-time";
      writeFileSync(path.join(repo, "README.md"), "first\n");
      run("git", ["-C", repo, "add", "README.md"]);
      run("git", ["-C", repo, "commit", "-m", "initial"], { env: { ...process.env, PI_SESSION_ID: sessionId } });
      const sha = run("git", ["-C", repo, "rev-parse", "HEAD"]);
      const recordsDir = path.join(appHome, "data/herdr-reclaim/commits");
      const [file] = readdirSync(recordsDir).filter((name) => name.startsWith(`${sha}.post-commit.`));
      const record = JSON.parse(readFileSync(path.join(recordsDir, file), "utf8"));
      // 真的事件時間（毫秒）：不是 0，也不是之後才補的讀取時間。
      expect(record.at).toBeGreaterThan(Date.now() - 60_000);
      expect(record.at).toBeLessThanOrEqual(Date.now());

      // 讓「重播當下」明顯晚於提交時間：舊碼（at=0 → 用讀取當下）就會歸到之後才建立的代。
      await Bun.sleep(1_200);

      const cityId = run("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const checkout = realpathSync(repo);
      const commitAt = record.at;
      const ledger = await new CityLedger({ io: createFileIo(), dir: path.join(appHome, "city"), cityId }).open();
      const scenario = activity({
        sessionId,
        writerEpoch: "time-1",
        events: [
          visitStart("v-time", commitAt - 120_000, { commonDir: cityId, checkout }),
          { kind: "interval_open", at: commitAt - 120_000 },
          {
            kind: "usage",
            at: commitAt - 60_000,
            sourceEntryId: "time-entry",
            usage: { openai: { sourceKey: `omp#${sessionId}#time-entry`, inputNonCache: 100_000, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 0 } },
          },
          { kind: "interval_close", at: commitAt + 300 },
        ],
      });
      await ingestScenario(ledger, { activities: [scenario], repoFacts: { [cityId]: { hadHead: false } } }, cityId);
      // 提交之後不久就撤回並重新派遣：重播（下面的 ingest）發生在兩者之後。
      expect((await processLand(ledger, { rootSessionId: sessionId, generation: 1, action: "withdraw", at: commitAt + 500 })).status).toBe("applied");
      expect((await redispatch(ledger, { rootSessionId: sessionId, at: commitAt + 500 })).status).toBe("applied");

      const activities = [...(await ledger.state()).activities.values()];
      await ingestCommits({
        ledger,
        hooks: [record],
        sources: [],
        activities,
        diffForCommit: async () => [{ status: "A", path: "src/app.js", resultBlob: "blob-time" }],
      });
      const state = await ledger.state();
      expect(state.tileById.get(`${cityId}@@${sessionId}@@1`).harvestPoints).toBe(20);
      expect(state.tileById.get(`${cityId}@@${sessionId}@@2`).harvestPoints).toBe(0);

      // 研究結算：這個回合裡有歸屬確定的 commit（時間真的落在回合內），所以不發羊皮卷。
      await ingestResearch(ledger, {
        activities: [...state.activities.values()],
        commits: commitContexts({ hooks: [record], activities: [...state.activities.values()] }),
        cityId,
      });
      expect((await ledger.state()).resources.parchment).toBe(0);
      expect((await ledger.state()).research).toEqual({ tokens: 0 });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }, 30_000);
});
