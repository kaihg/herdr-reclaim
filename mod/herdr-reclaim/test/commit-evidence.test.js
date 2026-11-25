// commit 的來源證據：解析 git 輸出、讀 hook／session 產物，以及「這個 commit 是誰的工作」。
// 共用城市只拿這條判定來決定要不要發成果加成（#24）；判不出來就不發。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitContexts, loadCommitEvidence, parseRawDiff, parseReflogEvidence } from "../core/commit-evidence.js";
import { createFileIo } from "./fs-io.js";

const sha = (digit) => String(digit).repeat(40);
const COMMON = "/tmp/reclaim-repo/.git";

/** 一筆 hook 記錄：commit 當下看得到哪些 session 變數。 */
const hookRecord = (commit, at, env = {}, { hook = "post-commit", commonDir = COMMON } = {}) => ({
  schema: 1, sha: commit, hook, commonDir, toplevel: "/tmp/reclaim-repo", at, env,
});

/** 一支互動的 root session（adapter 活動檔的形狀；只有判斷需要的欄位）。 */
const activity = (sessionId, { cli = "omp", role = "root", interactive = true, parentSessionId } = {}) => ({
  schema: 1, sessionId, writerEpoch: `${sessionId}-1`, cli, role, interactive, parentSessionId, events: [],
});

describe("git 輸出解析", () => {
  test("diff-tree --raw -z：新增、修改、刪除與改名", () => {
    const fields = [
      ":000000 100644 0000000 aaaa1111 A\0src/new.js\0",
      ":100644 100644 bbbb2222 cccc3333 M\0src/mod.js\0",
      ":100644 000000 dddd4444 0000000 D\0src/gone.js\0",
      ":100644 100644 eeee5555 eeee5555 R100\0src/old.js\0src/renamed.js\0",
      ":100644 100644 ffff6666 1111aaaa R087\0src/old2.js\0src/renamed2.js\0",
    ].join("");
    expect(parseRawDiff(fields)).toEqual([
      { status: "A", path: "src/new.js", oldBlob: null, resultBlob: "aaaa1111" },
      { status: "M", path: "src/mod.js", oldBlob: "bbbb2222", resultBlob: "cccc3333" },
      { status: "D", path: "src/gone.js", oldBlob: "dddd4444", resultBlob: null },
      { status: "R100", oldPath: "src/old.js", path: "src/renamed.js", oldBlob: "eeee5555", resultBlob: "eeee5555" },
      { status: "R087", oldPath: "src/old2.js", path: "src/renamed2.js", oldBlob: "ffff6666", resultBlob: "1111aaaa" },
    ]);
  });

  test("reflog：提交時間取 %ct、遠端合併另外標記，訊息本身不能當歸屬證據", () => {
    const output = [
      `${sha("a")}\t1700000000\tcommit: add feature`,
      `${sha("b")}\t1700000100\tpull: fast-forward`,
      `${sha("c")}\t1700000200\tcommit (amend): fix`,
      "not-a-sha\t1700000300\tcommit: noise",
    ].join("\n");
    const parsed = parseReflogEvidence(output, COMMON, "/tmp/reclaim-repo");
    expect(parsed.records.map((record) => [record.sha, record.hook, record.at, record.commonDir])).toEqual([
      [sha("a"), "reflog", 1_700_000_000_000, COMMON],
      [sha("b"), "reflog", 1_700_000_100_000, COMMON],
      [sha("c"), "reflog", 1_700_000_200_000, COMMON],
    ]);
    expect(parsed.remoteMerges).toEqual(new Set([sha("b")]));
  });
});

describe("證據檔與歸屬", () => {
  test("loadCommitEvidence 讀 commits/ 與 sources/ 的合法紀錄，壞檔與不合法 sha 跳過", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "reclaim-evidence-"));
    try {
      mkdirSync(`${root}/commits`, { recursive: true });
      mkdirSync(`${root}/sources`, { recursive: true });
      writeFileSync(`${root}/commits/a.json`, JSON.stringify(hookRecord(sha("a"), 1)));
      writeFileSync(`${root}/commits/broken.json`, "{");
      writeFileSync(`${root}/sources/not-a-sha.json`, JSON.stringify({ schema: 1, sha: "xyz" }));
      writeFileSync(`${root}/sources/s.json`, JSON.stringify({ schema: 1, sha: sha("b"), sessionId: "s-b", cli: "omp", at: 2 }));
      const files = new Map([
        [`${root}/commits`, [`${root}/commits/a.json`, `${root}/commits/broken.json`]],
        [`${root}/sources`, [`${root}/sources/not-a-sha.json`, `${root}/sources/s.json`]],
      ]);
      const evidence = await loadCommitEvidence(createFileIo(), root, async (dir) => files.get(dir) ?? []);
      expect(evidence.hooks.map((record) => record.sha)).toEqual([sha("a")]);
      expect(evidence.sources.map((record) => record.sha)).toEqual([sha("b")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hook 的 session 變數與 adapter 活動檔對得上才算歸屬；對不上或證據衝突都不發", () => {
    const mine = hookRecord(sha("a"), 1_000, { PI_SESSION_ID: "omp-1" });
    const conflict = hookRecord(sha("b"), 2_000, { PI_SESSION_ID: "omp-1", CODEX_THREAD_ID: "cx-1" });
    const terminalOnly = hookRecord(sha("c"), 3_000, { HC_TERMINAL_ID: "t-9" }, { hook: "post-commit" });
    const claude = hookRecord(sha("d"), 4_000, { CLAUDE_CODE_SESSION_ID: "cl-1" });
    const contexts = commitContexts({
      hooks: [mine, conflict, terminalOnly, claude],
      sources: [{ schema: 1, sha: sha("e"), sessionId: "s-artifact", cli: "omp", at: 5_000 }],
      activities: [activity("omp-1"), activity("s-artifact")],
    });
    const bySha = Object.fromEntries(contexts.map((context) => [context.sha, context]));
    expect(bySha[sha("a")]).toMatchObject({ attributed: true, rootId: "omp-1", cityId: COMMON, reason: null });
    expect(bySha[sha("b")]).toMatchObject({ attributed: false, reason: "ambiguous-session-source" });
    expect(bySha[sha("c")]).toMatchObject({ attributed: false, reason: "terminal-only" });
    // Claude 的 hook 變數要與 adapter 的活動檔完全相等；這裡沒有那支 session。
    expect(bySha[sha("d")]).toMatchObject({ attributed: false, reason: "no-matching-adapter-session" });
    // 只有 session 產物、沒有 hook 記錄：不知道是哪個 repo 的 commit，先當成待核對（不發）。
    expect(bySha[sha("e")]).toMatchObject({ attributed: false, pending: true, reason: "no-hook-repository-evidence" });
  });

  test("child 併進 root；沒有可信時間的證據留著但不發（at 是 null，不是讀取當下）", () => {
    const child = hookRecord(sha("a"), 1_000, { PI_SESSION_ID: "child-1" });
    const old = hookRecord(sha("b"), 0, { PI_SESSION_ID: "omp-1" });
    const contexts = commitContexts({
      hooks: [child, old],
      activities: [activity("omp-1"), activity("child-1", { role: "child", parentSessionId: "omp-1" })],
    });
    const bySha = Object.fromEntries(contexts.map((context) => [context.sha, context]));
    expect(bySha[sha("a")]).toMatchObject({ attributed: true, rootId: "omp-1", at: 1_000 });
    // 舊 recorder 留下 at=0：時間不可信，入帳之前就被跳過（成果收成只發有時間的）。
    expect(bySha[sha("b")]).toMatchObject({ attributed: true, at: null, reason: "unknown-commit-time" });
  });
});
