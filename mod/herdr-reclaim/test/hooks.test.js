import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hookScript, installHooks, removeHooks } from "../core/hooks.js";

const exec = async (command, args = [], options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const io = {
  async read(file) { try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
  async write(file, text) { writeFileSync(file, text); },
};
const git = (cwd, ...args) => { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); if (result.status) throw new Error(result.stderr); return result.stdout.trim(); };

describe("Git hook 收成記錄器", () => {
  test("選擇安裝到 repo-local hooksPath、串接既有 hook，並可安全移除還原", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "reclaim-hook-"));
    try {
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.invalid");
      git(repo, "config", "user.name", "Test");
      const custom = path.join(repo, "custom-hooks");
      git(repo, "config", "--local", "core.hooksPath", custom);
      mkdirSync(custom, { recursive: true });
      const prior = path.join(custom, "post-commit");
      await Bun.write(prior, "#!/bin/sh\necho prior >> \"$S8_CHAIN_LOG\"\n");
      chmodSync(prior, 0o755);
      const result = await installHooks({ repo, io, exec, appHome: path.join(repo, "app") });
      expect(result.status).toBe("installed");
      expect(result.hooksPath).toBe(realpathSync(custom));
      expect(readFileSync(prior, "utf8")).toContain("herdr-reclaim");
      expect(readFileSync(`${prior}.herdr-reclaim-original`, "utf8")).toContain("S8_CHAIN_LOG");
      const removed = await removeHooks({ repo, exec });
      expect(removed.status).toBe("removed");
      expect(readFileSync(prior, "utf8")).toContain("S8_CHAIN_LOG");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("偵測 tracked hooks path，不覆寫版控 hook", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "reclaim-hook-tracked-"));
    try {
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.invalid");
      git(repo, "config", "user.name", "Test");
      git(repo, "config", "--local", "core.hooksPath", "hooks");
      const hooksDir = path.join(repo, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(path.join(hooksDir, "post-commit"), "#!/bin/sh\nexit 0\n");
      git(repo, "add", "hooks/post-commit"); git(repo, "commit", "-qm", "tracked hook");
      const result = await installHooks({ repo, io, exec, appHome: path.join(repo, "app") });
      expect(result.status).toBe("needs-confirmation");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("繼承自 global 的共用 hooksPath：拒絕安裝，不碰共用目錄", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "reclaim-hook-global-"));
    const previous = { global: process.env.GIT_CONFIG_GLOBAL, noSystem: process.env.GIT_CONFIG_NOSYSTEM };
    try {
      const repo = path.join(root, "repo");
      const shared = path.join(root, "shared-hooks");
      mkdirSync(shared, { recursive: true });
      const sharedHook = path.join(shared, "post-commit");
      writeFileSync(sharedHook, "#!/bin/sh\necho shared >> \"$SHARED_LOG\"\n");
      chmodSync(sharedHook, 0o755);
      // 隔離的全域設定：不碰使用者的 ~/.gitconfig。
      const globalConfig = path.join(root, "global.gitconfig");
      writeFileSync(globalConfig, `[core]\n\thooksPath = ${shared}\n`);
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      mkdirSync(repo, { recursive: true });
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.invalid");
      git(repo, "config", "user.name", "Test");

      const result = await installHooks({ repo, io, exec, appHome: path.join(repo, "app") });
      expect(result.status).toBe("refused");
      expect(result.reason).toBe("inherited-hooks-path");
      // 共用目錄完全沒被動：既有的 hook 還在，也沒有多出 recorder 或備份檔。
      expect(readFileSync(sharedHook, "utf8")).toContain("SHARED_LOG");
      expect(readdirSync(shared).sort()).toEqual(["post-commit"]);

      // repo-local 自己設定的路徑（這裡就是那個共用目錄）才照舊安裝。
      git(repo, "config", "--local", "core.hooksPath", shared);
      const local = await installHooks({ repo, io, exec, appHome: path.join(repo, "app") });
      expect(local.status).toBe("installed");
      expect(readFileSync(sharedHook, "utf8")).toContain("HERDR_RECLAIM");
    } finally {
      if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous.global;
      if (previous.noSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previous.noSystem;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("記錄器把真正的提交事件時間寫進證據（不是 0）", () => {
    const script = hookScript({ hook: "post-commit", appHome: "/tmp/reclaim-app" });
    expect(script).toContain("date +%s");
    expect(script).not.toContain("at=0\n");
    expect(script).not.toMatch(/node|python/i);
  });

  test("記錄器包含 offline-safe post-rewrite stdin chaining", () => {
    const script = hookScript({ hook: "post-rewrite", appHome: "/tmp/reclaim-app" });
    expect(script).toContain("post-rewrite");
    expect(script).toContain("HERDR_RECLAIM");
    expect(script).toContain("exit 0");
    expect(script).not.toMatch(/node|python/i);
  });
});
