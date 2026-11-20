import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
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

  test("記錄器包含 offline-safe post-rewrite stdin chaining", () => {
    const script = hookScript({ hook: "post-rewrite", appHome: "/tmp/reclaim-app" });
    expect(script).toContain("post-rewrite");
    expect(script).toContain("HERDR_RECLAIM");
    expect(script).toContain("exit 0");
    expect(script).not.toMatch(/node|python/i);
  });
});
