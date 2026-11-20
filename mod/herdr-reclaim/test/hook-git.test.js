import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installHooks } from "../core/hooks.js";

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
