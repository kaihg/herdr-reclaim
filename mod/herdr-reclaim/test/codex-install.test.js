// codex-adapter/install.sh 的保護網：**不得寫進使用者的真實 Codex 設定**。
//
// 這一組測試在 /tmp 隔離，`HOME` 一律改成臨時目錄；被判定為「真實 home」的樣本
// 也用隔離目錄與假的 `dscl` 造出來，所以任何情況下都不會指到、也不會動到
// 使用者的 `~/.codex`。
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INSTALL = path.join(import.meta.dir, "..", "..", "..", "codex-adapter", "install.sh");

// 刻意用 `/tmp`（不是 os.tmpdir）：在 macOS 上 `/tmp` 是 `/private/tmp` 的 symlink，
// 所以「$HOME 給的字串」與「正規化後的路徑」不同 —— 正是 QA 抓到的繞過形狀。
function makeTemp(name) {
  return fs.mkdtempSync(`/tmp/reclaim-10-install-${name}-`);
}
/** 跑安裝器；env 疊在現有環境上。 */
function run(args, env = {}) {
  const result = spawnSync("sh", [INSTALL, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function refuse(...args) {
  const result = run(args.slice(0, -1), args.at(-1));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("refusing to install into the real Codex home");
  return result;
}

function listing(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return null;
  }
}

describe("codex-adapter 安裝器的真實 Codex home 守衛", () => {
  test("$HOME 被改到 /tmp 時，$HOME/.codex 一樣拒絕（尾斜線、symlink 等價路徑都算）", () => {
    const home = makeTemp("home");
    try {
      fs.mkdirSync(path.join(home, "home", ".codex"), { recursive: true });
      fs.mkdirSync(path.join(home, "home", ".codex", "hooks"), { recursive: true });
      fs.mkdirSync(path.join(home, "home", "sub"), { recursive: true });
      // 走 symlink 進去的同一個目錄：canonicalize 之後必須還是被拒絕。
      fs.symlinkSync(path.join(home, "home"), path.join(home, "alias"));
      const env = { ...process.env, HOME: path.join(home, "home"), XDG_CONFIG_HOME: undefined };

      refuse("--codex-home", path.join(home, "home", "sub", "..", ".codex"), env);
      // 子路徑也不能碰。
      refuse("--codex-home", path.join(home, "home", ".codex", "hooks"), env);

      // 安裝器一個檔案都沒寫進去（`hooks` 是 fixture 自己建的）。
      expect(listing(path.join(home, "home", ".codex"))).toEqual(["hooks"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("TARGET 等於使用者匯出的 $CODEX_HOME 時拒絕", () => {
    const home = makeTemp("env");
    try {
      const codexDir = path.join(home, "codex-home");
      fs.mkdirSync(codexDir, { recursive: true });
      refuse("--codex-home", codexDir, { ...process.env, HOME: home, CODEX_HOME: codexDir });
      refuse("--codex-home", `${codexDir}/`, { ...process.env, HOME: home, CODEX_HOME: `${codexDir}/` });
      expect(listing(codexDir)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("$HOME 被改掉時，仍拒絕系統記錄的真實 home 的 ~/.codex", () => {
    const home = makeTemp("real");
    try {
      const realHome = path.join(home, "real-home");
      fs.mkdirSync(path.join(realHome, ".codex"), { recursive: true });
      // 假的 dscl：讓安裝器問到的「真實 home」指向隔離目錄，測試才不會碰真檔案。
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin, { recursive: true });
      const dscl = path.join(bin, "dscl");
      fs.writeFileSync(dscl, `#!/bin/sh\nprintf 'NFSHomeDirectory: %s\\n' '${realHome}'\n`);
      fs.chmodSync(dscl, 0o755);
      const env = { ...process.env, HOME: path.join(home, "redirected"), PATH: `${bin}:${process.env.PATH}` };
      fs.mkdirSync(env.HOME, { recursive: true });

      refuse("--codex-home", path.join(realHome, ".codex"), env);
      refuse("--codex-home", `${path.join(realHome, ".codex")}/`, env);
      // HOME 換到別處，也不能因此放行真實 home。
      expect(listing(path.join(realHome, ".codex"))).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("一般隔離路徑照常安裝（沒有過度拒絕）", () => {
    const home = makeTemp("ok");
    try {
      const target = path.join(home, "codex-home");
      fs.mkdirSync(target, { recursive: true });
      const env = { ...process.env, HOME: home };
      const installed = run(["--codex-home", target], env);
      expect(installed.status).toBe(0);
      expect(fs.existsSync(path.join(target, "herdr-reclaim", "codex-activity.sh"))).toBe(true);
      const hooks = JSON.parse(fs.readFileSync(path.join(target, "hooks.json"), "utf8"));
      expect(Object.keys(hooks.hooks).sort()).toEqual(
        [
          "Interrupt",
          "PermissionRequest",
          "PostCompact",
          "PostToolUse",
          "PreCompact",
          "PreToolUse",
          "SessionEnd",
          "SessionStart",
          "Stop",
          "SubagentStart",
          "SubagentStop",
          "UserPromptSubmit",
        ].sort(),
      );
      // 重複安裝不會長出第二份。
      expect(run(["--codex-home", target], env).status).toBe(0);
      const again = JSON.parse(fs.readFileSync(path.join(target, "hooks.json"), "utf8"));
      expect(Object.keys(again.hooks)).toHaveLength(12);
      expect(again.hooks.Stop).toHaveLength(1);
      // 卸載也走同一道守衛，而且會清乾淨。
      expect(run(["--codex-home", target, "--uninstall"], env).status).toBe(0);
      expect(fs.existsSync(path.join(target, "herdr-reclaim"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
