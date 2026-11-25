// 真 git hook：在暫存 repo 上安裝 hook，真的 commit／amend／cherry-pick／merge，看 recorder 寫出
// 什麼；再用同一份 hook 證據走成果加成（#24）——歸屬確定才發、重播只發一次。
//
// 舊版這一支還驗了「改成當時的 generation」「不誤發研究」；那兩件事屬於已移除的遠征／研究系統，
// 這裡刻意不補（見交接說明）。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { adapterRoot, activityDir } from "../core/adapter.js";
import { loadCity } from "../core/city-load.js";
import { installHooks, removeHooks } from "../core/hooks.js";
import { ACHIEVEMENT_YIELD } from "../core/rules.js";
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
  async read(file) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  async write(file, text) {
    writeFileSync(file, text);
  },
};

const recordsOf = (appHome) => {
  const dir = path.join(appHome, "data/herdr-reclaim/commits");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")));
};

async function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function setupRepo(prefix) {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  run("git", ["init", "-q", repo]);
  run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  run("git", ["-C", repo, "config", "user.name", "Test"]);
  return { repo, appHome: path.join(repo, "isolated-home") };
}

describe("Git commit hook 線上證據", () => {
  test("初始與一般 OMP bash commit 產生可配對的 repo/SHA 證據；移除時還原 hook", async () => {
    const { repo, appHome } = setupRepo("reclaim-git-live-");
    try {
      const customHooks = path.join(repo, "custom-hooks");
      run("git", ["-C", repo, "config", "--local", "core.hooksPath", customHooks]);
      expect((await installHooks({ repo, appHome, io, exec })).status).toBe("installed");
      // 安裝後三個 hook 都在自訂目錄裡。
      expect(readdirSync(customHooks).sort()).toEqual(["post-commit", "post-merge", "post-rewrite"]);

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

      // 移除：三個 hook 都拿掉，自訂目錄回到空的。
      expect((await removeHooks({ repo, exec })).status).toBe("removed");
      expect(readdirSync(customHooks)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("Git 操作矩陣記錄 amend/rebase/cherry-pick/revert/conflict/no-ff merge", async () => {
    const { repo, appHome } = setupRepo("reclaim-git-matrix-");
    try {
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

      const records = recordsOf(appHome);
      expect(records.some((record) => record.sha === amended && record.hook === "post-rewrite")).toBe(true);
      expect(records.some((record) => record.hook === "post-rewrite" && record.rewrite.includes(" "))).toBe(true);
      expect(records.some((record) => record.hook === "post-merge")).toBe(true);
      expect(records.some((record) => record.hook === "post-commit" && record.sha === picked)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("真 hook 的提交時間與成果加成", () => {
  test("記錄真正的提交時間；歸屬確定才發成果加成，重播只發一次", async () => {
    const { repo, appHome } = setupRepo("reclaim-git-time-");
    try {
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

      const commonDir = run("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const checkout = realpathSync(repo);
      const commitAt = record.at;
      // 一支互動 root 的活動檔：一個在提交之前就結束的回合（否則收入會把 token 也算進來）。
      const activity = {
        schema: 1,
        cli: "omp",
        cliVersion: "test",
        capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
        sessionId,
        role: "root",
        interactive: true,
        writerEpoch: "time-1",
        events: [
          { eventSeq: 1, kind: "visit_start", at: commitAt - 120_000, visit: { visitId: "v-time", cwd: checkout, commonDir, checkout } },
          { eventSeq: 2, kind: "interval_open", at: commitAt - 120_000 },
          { eventSeq: 3, kind: "usage", at: commitAt - 60_000, sourceEntryId: "time-entry", usage: { openai: { sourceKey: `omp#${sessionId}#time-entry`, inputNonCache: 100, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 0 } } },
          { eventSeq: 4, kind: "interval_close", at: commitAt + 300 },
        ],
        updatedAt: commitAt + 300,
      };
      const dir = activityDir(appHome);
      mkdirSync(path.join(dir, sessionId), { recursive: true });
      writeFileSync(path.join(dir, sessionId, "time-1.json"), JSON.stringify(activity));

      const load = () => loadCity(
        { ...createFileIo(), list: listFiles },
        {
          root: adapterRoot(appHome),
          list: listFiles,
          now: commitAt + 10_000,
          activateAt: commitAt - 120_000,
          diffForCommit: async () => [{ status: "A", path: "src/app.js", resultBlob: "blob-time" }],
        },
      );
      const first = await load();
      expect(first.city.city.resources).toEqual(ACHIEVEMENT_YIELD);
      // 只有 100 token：不到一份建材，工作計量器只留餘數。
      expect(first.city.city.work.tokens).toBe(100);
      expect(first.city.city.resources).not.toHaveProperty("parchment", 1);

      // 重播同一份證據：不再發、計量器不變。
      const replayed = await load();
      expect(replayed.city.city.resources).toEqual(ACHIEVEMENT_YIELD);
      expect(replayed.city.city.work.tokens).toBe(100);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("沒有 session 證據的 commit 不發成果加成；啟用邊界之前的 commit 不補發", async () => {
    const { repo, appHome } = setupRepo("reclaim-git-unknown-");
    try {
      run("git", ["-C", repo, "config", "--local", "core.hooksPath", path.join(repo, "hooks")]);
      expect((await installHooks({ repo, appHome, io, exec })).status).toBe("installed");
      const sessionId = "session-boundary";
      writeFileSync(path.join(repo, "a.txt"), "a\n");
      run("git", ["-C", repo, "add", "a.txt"]);
      // 只有 terminal id：來源不明。
      run("git", ["-C", repo, "commit", "-m", "terminal only"], { env: { ...process.env, HC_TERMINAL_ID: "t1" } });
      const unknown = run("git", ["-C", repo, "rev-parse", "HEAD"]);
      // 正常 commit（有 session）：但啟用邊界在之後，屬於「啟用前」。
      writeFileSync(path.join(repo, "b.txt"), "b\n");
      run("git", ["-C", repo, "add", "b.txt"]);
      run("git", ["-C", repo, "commit", "-m", "before activation"], { env: { ...process.env, PI_SESSION_ID: sessionId } });
      const before = run("git", ["-C", repo, "rev-parse", "HEAD"]);

      const commonDir = run("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const checkout = realpathSync(repo);
      const activity = {
        schema: 1, cli: "omp", cliVersion: "test",
        capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
        sessionId, role: "root", interactive: true, writerEpoch: "b-1",
        events: [
          { eventSeq: 1, kind: "visit_start", at: 1, visit: { visitId: "v", cwd: checkout, commonDir, checkout } },
          { eventSeq: 2, kind: "interval_open", at: 1 },
          { eventSeq: 3, kind: "interval_close", at: 2 },
        ],
        updatedAt: 2,
      };
      mkdirSync(path.join(activityDir(appHome), sessionId), { recursive: true });
      writeFileSync(path.join(activityDir(appHome), sessionId, "b-1.json"), JSON.stringify(activity));

      const loaded = await loadCity(
        { ...createFileIo(), list: listFiles },
        {
          root: adapterRoot(appHome),
          list: listFiles,
          now: Date.now(),
          activateAt: Date.now() + 60_000, // 啟用邊界在兩個 commit 之後
          diffForCommit: async (sha) => [{ status: "A", path: `src/${sha.slice(0, 2)}.js`, resultBlob: `blob-${sha.slice(0, 2)}` }],
        },
      );
      expect(loaded.city.city.resources).toEqual({ wood: 0, stone: 0, iron: 0 });
      // 兩筆都記在 commits/ 裡（帳本沒有它們的 entry，但證據都在）。
      const records = recordsOf(appHome);
      expect(records.some((record) => record.sha === unknown)).toBe(true);
      expect(records.some((record) => record.sha === before)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
