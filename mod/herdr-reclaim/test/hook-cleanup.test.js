// 一次性清掉舊版裝在各 repo 的 commit 記錄器（#28、ADR 0002）：只列有殘留的 repo，
// 按下才動；被串接的使用者 hook 內容與權限原樣還原，沒裝的 repo 不碰。
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { leftoverHooks, removeLeftoverHooks } from "../core/hooks.js";

const exec = async (command, args = [], options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const io = {
  async read(file) { try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
};
const git = (cwd, ...args) => { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); if (result.status) throw new Error(result.stderr); return result.stdout.trim(); };

/** 舊版記錄器的樣子：帶 marker、一律 exit 0（真的舊腳本也是如此）。 */
const RECORDER = "#!/bin/sh\n# HERDR_RECLAIM_HOOK_V1\nexit 0\n";
const USER_HOOK = "#!/bin/sh\necho mine >> \"$HOME/.mine\"\n";

function repoIn(base, name) {
  const repo = path.join(base, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  return repo;
}

function plantRecorders(repo, { chainPostCommit = false } = {}) {
  const hooks = path.join(repo, ".git", "hooks");
  for (const hook of ["post-commit", "post-merge", "post-rewrite"]) {
    const file = path.join(hooks, hook);
    if (chainPostCommit && hook === "post-commit") {
      writeFileSync(`${file}.herdr-reclaim-original`, USER_HOOK);
      chmodSync(`${file}.herdr-reclaim-original`, 0o751);
    }
    writeFileSync(file, RECORDER);
    chmodSync(file, 0o700);
  }
  return hooks;
}

const postHooks = (hooks) => readdirSync(hooks).filter((name) => name.startsWith("post-") && !name.endsWith(".sample")).sort();

describe("清理舊版 commit 記錄器", () => {
  test("只列出有殘留的 repo；全部移除後記錄器消失、串接的原 hook 完整還原、沒裝的不動", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "reclaim-cleanup-"));
    try {
      const plain = repoIn(base, "plain");
      const chained = repoIn(base, "chained");
      const untouched = repoIn(base, "untouched");
      const plainHooks = plantRecorders(plain);
      const chainedHooks = plantRecorders(chained, { chainPostCommit: true });
      const ownHook = path.join(untouched, ".git", "hooks", "post-commit");
      writeFileSync(ownHook, USER_HOOK);
      chmodSync(ownHook, 0o755);
      const repos = [plain, chained, untouched, path.join(base, "not-a-repo")];

      const found = await leftoverHooks({ repos, io, exec });
      expect(found.map((item) => item.repo)).toEqual([plain, chained]);

      const results = await removeLeftoverHooks({ repos: found.map((item) => item.repo), exec });
      expect(results).toEqual([{ repo: plain, ok: true }, { repo: chained, ok: true }]);

      expect(postHooks(plainHooks)).toEqual([]);
      expect(postHooks(chainedHooks)).toEqual(["post-commit"]);
      const restored = path.join(chainedHooks, "post-commit");
      expect(readFileSync(restored, "utf8")).toBe(USER_HOOK);
      expect(statSync(restored).mode & 0o777).toBe(0o751);
      expect(readFileSync(ownHook, "utf8")).toBe(USER_HOOK);
      expect(statSync(ownHook).mode & 0o777).toBe(0o755);

      // 重新檢查（等同重新載入）：已經沒有殘留，清理卡不再出現。
      expect(await leftoverHooks({ repos, io, exec })).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test("移除失敗的 repo 附上原因，其他 repo 照樣清掉", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "reclaim-cleanup-fail-"));
    const locked = path.join(base, "locked");
    try {
      const ok = repoIn(base, "ok");
      repoIn(base, "locked");
      plantRecorders(ok);
      const lockedHooks = plantRecorders(locked);
      chmodSync(lockedHooks, 0o500); // 不能刪也不能搬

      const results = await removeLeftoverHooks({ repos: [locked, ok], exec });
      expect(results[0].repo).toBe(locked);
      expect(results[0].ok).toBe(false);
      expect(typeof results[0].reason).toBe("string");
      expect(results[0].reason.length).toBeGreaterThan(0);
      expect(results[1]).toEqual({ repo: ok, ok: true });
      expect((await leftoverHooks({ repos: [locked, ok], io, exec })).map((item) => item.repo)).toEqual([locked]);
    } finally {
      chmodSync(path.join(locked, ".git", "hooks"), 0o755);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("讀不到某一座的 hook 目錄：不影響其他 repo 的殘留清單", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "reclaim-cleanup-scan-"));
    const broken = repoIn(base, "broken");
    try {
      const good = repoIn(base, "good");
      plantRecorders(good);
      const brokenHooks = plantRecorders(broken);
      chmodSync(brokenHooks, 0o300); // 不能列、也不能讀
      const found = await leftoverHooks({ repos: [broken, good], io, exec });
      expect(found.map((item) => item.repo)).toEqual([broken, good]);
    } finally {
      chmodSync(path.join(broken, ".git", "hooks"), 0o755);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
