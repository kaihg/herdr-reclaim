// Codex（#10）與 Claude Code（#11）的 commit 來源接線：固定情境重播。
//
// 配對規則（§7.2、ticket #10／#11 的證據格式草案）：只認 commit hook 當下記到的
// `CODEX_THREAD_ID`／`CLAUDE_CODE_SESSION_ID` 與 adapter 活動檔的 `sessionId` **完全相等**。
// 對不到＝來源不明，不發資源、不用 terminal ID、時間或 HEAD 差異補猜；
// 多重證據衝突（兩個不同身分）也不收成。
//
// 所有斷言都走公開的城鎮讀取模型 `readTownFromLedger`（資源、格子）。
import { describe, expect, test } from "bun:test";
import { CityLedger } from "../core/ledger.js";
import { ingestActivities } from "../core/ingest.js";
import { ingestCommits, unharvestedCommitReasons } from "../core/commit-evidence.js";
import { readTownFromLedger } from "../core/town.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/reclaim-adapter-sources/.git";
const TOOL_CALL = "call_resp_1795139896423";

const sessionActivity = (sessionId, cli, { role = "root", parentSessionId = null, interactive = false } = {}) => ({
  schema: 1,
  seq: 1,
  sessionId,
  writerEpoch: `epoch-${sessionId}`,
  cli,
  role,
  parentSessionId,
  interactive,
  updatedAt: 1,
  lastEventSeq: 1,
  events: [{ eventSeq: 1, kind: "interval_open", at: 1, visit: { visitId: `v-${sessionId}`, cwd: CITY.slice(0, -5), commonDir: CITY, checkout: CITY.slice(0, -5) } }],
});

const hookRecord = (sha, env) => ({ schema: 1, sha, hook: "post-commit", commonDir: CITY, toplevel: CITY.slice(0, -5), at: 10, env });
const textChange = (path, blob) => [{ status: "A", path, resultBlob: blob }];

async function openCity(name) {
  const dir = `/tmp/reclaim-adapter-sources/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return new CityLedger({ io: createFileIo(), dir, cityId: CITY }).open();
}

const expeditionOp = (rootSessionId, x, y) => ({ opId: `expedition:${rootSessionId}`, kind: "expedition", cityId: CITY, rootSessionId, generation: 1, x, y, cli: "omp", repo: { commonDir: CITY, checkout: CITY.slice(0, -5) } });

async function ingestOnce(ledger, { hooks = [], sources = [], activities = [], diffForCommit, remoteMerges }) {
  if (activities.length) await ingestActivities(ledger, activities, CITY);
  const state = await ledger.state();
  await ingestCommits({
    ledger,
    hooks,
    sources,
    activities: [...state.activities.values()],
    diffForCommit,
    remoteMerges,
  });
  const after = await ledger.state();
  const town = readTownFromLedger({
    activities: [...after.activities.values()],
    expeditions: after.tiles,
    resources: { [CITY]: after.resources },
    unharvestedCommits: { [CITY]: unharvestedCommitReasons({ cityId: CITY, hooks, sources, activities: [...after.activities.values()], remoteMerges, state: after }) },
  });
  return { resources: after.resources, city: town.cities[0], reasons: town.cities[0].unharvestedCommits };
}

describe("Codex／Claude 的 commit 來源接線", () => {
  test("Codex：精確配對收成；錯誤 session、只有 terminal ID 不收成；晚到活動自動補算；重播不重複", async () => {
    const ledger = await openCity("codex");
    const codexSession = "01a1f6ad-0341-79f2-89bb-fb86a7763ddc";
    const otherSession = "01a1f6ad-ffff-0000-0000-000000000000";
    const lateSession = "01a1f6ad-0000-1111-2222-333344445555";
    await ledger.submit(() => expeditionOp(codexSession, 0, -1));
    await ledger.submit(() => expeditionOp(lateSession, 1, 0));

    const matchedSha = "a1".repeat(20);
    const wrongSha = "a2".repeat(20);
    const terminalSha = "a3".repeat(20);
    const lateSha = "a4".repeat(20);
    const diffForCommit = async (sha) => textChange(`src/${sha.slice(0, 2)}.ts`, `blob-${sha.slice(0, 2)}`);
    // mod 每次載入都重讀目錄裡的所有 hook 檔，所以這裡也把累積的紀錄一起餵進去。
    const records = [];
    const ingest = (extra) => ingestOnce(ledger, { hooks: [...records], ...extra });

    // ① 精確配對：hook 的 CODEX_THREAD_ID 與 adapter 活動檔 sessionId 完全相等 → 收成。
    records.push(hookRecord(matchedSha, { CODEX_THREAD_ID: codexSession, CODEX_TOOL_CALL_ID: TOOL_CALL }));
    const matched = await ingest({ activities: [sessionActivity(codexSession, "codex")], diffForCommit });
    expect(matched.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
    expect(matched.city.tiles[0].harvestPoints).toBe(20);
    expect(matched.reasons).toEqual([]);

    // ② 錯誤 session：hook 記到的 thread id 沒有任何 adapter 活動 → 來源不明，不發資源。
    records.push(hookRecord(wrongSha, { CODEX_THREAD_ID: otherSession }));
    const wrong = await ingest({ activities: [sessionActivity(codexSession, "codex")], diffForCommit });
    expect(wrong.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
    expect(wrong.reasons).toEqual([{ sha: wrongSha, repo: CITY, reason: "no-matching-adapter-session" }]);

    // ③ 只有 terminal ID：連 session 都沒有 → terminal-only，不發資源。
    records.push(hookRecord(terminalSha, { HC_TERMINAL_ID: "t5f" }));
    const terminal = await ingest({ activities: [sessionActivity(codexSession, "codex")], diffForCommit });
    expect(terminal.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
    expect(terminal.reasons).toEqual([
      { sha: wrongSha, repo: CITY, reason: "no-matching-adapter-session" },
      { sha: terminalSha, repo: CITY, reason: "terminal-only" },
    ]);

    // ④ 晚到 adapter 活動：先只有 hook 紀錄（來源不明、不發），活動檔之後才出現 → 自動補算。
    records.push(hookRecord(lateSha, { CODEX_THREAD_ID: lateSession }));
    const beforeActivity = await ingest({ activities: [sessionActivity(codexSession, "codex")], diffForCommit });
    expect(beforeActivity.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
    expect(beforeActivity.reasons).toEqual([
      { sha: wrongSha, repo: CITY, reason: "no-matching-adapter-session" },
      { sha: terminalSha, repo: CITY, reason: "terminal-only" },
      { sha: lateSha, repo: CITY, reason: "no-matching-adapter-session" },
    ]);
    const late = await ingest({ activities: [sessionActivity(codexSession, "codex"), sessionActivity(lateSession, "codex")], diffForCommit });
    expect(late.resources).toEqual({ wood: 20, stone: 0, iron: 0, parchment: 0 });
    expect(late.reasons).toEqual([
      { sha: wrongSha, repo: CITY, reason: "no-matching-adapter-session" },
      { sha: terminalSha, repo: CITY, reason: "terminal-only" },
    ]);

    // ⑤ 重播同一份證據：不再發資源、點數不變。
    const replayed = await ingest({ activities: [sessionActivity(codexSession, "codex"), sessionActivity(lateSession, "codex")], diffForCommit });
    expect(replayed.resources).toEqual({ wood: 20, stone: 0, iron: 0, parchment: 0 });
    expect(replayed.reasons).toEqual([
      { sha: wrongSha, repo: CITY, reason: "no-matching-adapter-session" },
      { sha: terminalSha, repo: CITY, reason: "terminal-only" },
    ]);
    expect(replayed.city.tiles.map((tile) => tile.harvestPoints).sort()).toEqual([20, 20]);
  });

  test("Claude：精確配對收成；多重證據衝突不收成；child（~sub~）投入歸 root", async () => {
    const ledger = await openCity("claude");
    const rootSession = "7e247495-27e2-4a67-bf5b-c6078ae1719e";
    const childSession = `${rootSession}~sub~af9975d7758d7b308`;
    await ledger.submit(() => expeditionOp(rootSession, 0, -1));

    const matchedSha = "b1".repeat(20);
    const conflictSha = "b2".repeat(20);
    const childSha = "b3".repeat(20);
    const diffForCommit = async (sha) => textChange(`lib/${sha.slice(0, 2)}.js`, `blob-${sha.slice(0, 2)}`);

    // ① 精確配對：CLAUDE_CODE_SESSION_ID 與 Claude adapter 活動檔 sessionId 完全相等。
    const matched = await ingestOnce(ledger, {
      hooks: [hookRecord(matchedSha, { CLAUDE_CODE_SESSION_ID: rootSession })],
      activities: [sessionActivity(rootSession, "claude")],
      diffForCommit,
    });
    expect(matched.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
    expect(matched.reasons).toEqual([]);

    // ② 多重證據衝突：同一個 SHA 同時對到兩支不同 session（OMP 與 Claude）→ 不收成。
    const conflict = await ingestOnce(ledger, {
      hooks: [hookRecord(conflictSha, { PI_SESSION_ID: "omp-session-1" }), hookRecord(conflictSha, { CLAUDE_CODE_SESSION_ID: rootSession })],
      activities: [sessionActivity(rootSession, "claude"), sessionActivity("omp-session-1", "omp")],
      diffForCommit,
    });
    expect(conflict.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
    expect(conflict.reasons).toEqual([{ sha: conflictSha, repo: CITY, reason: "ambiguous-session-source" }]);

    // ③ child 的 activity 是 `root~sub~agentId`；commit hook 記的是 root session id，
    //    因此仍然精確配對到 root 活動，投入算在 root 那一格。
    const child = await ingestOnce(ledger, {
      hooks: [hookRecord(childSha, { CLAUDE_CODE_SESSION_ID: rootSession })],
      activities: [sessionActivity(rootSession, "claude"), sessionActivity(childSession, "claude", { role: "child", parentSessionId: rootSession })],
      diffForCommit,
    });
    expect(child.resources).toEqual({ wood: 20, stone: 0, iron: 0, parchment: 0 });
    expect(child.city.tiles).toHaveLength(1);
    expect(child.city.tiles[0].rootSessionId).toBe(rootSession);
    expect(child.city.tiles[0].harvestPoints).toBe(40);
    expect(child.reasons).toEqual([]);
  });

  test("Claude 的活動若屬於別的 CLI（session id 巧合相同）不算配對", async () => {
    const ledger = await openCity("cross-cli");
    const session = "c0ffee00-1111-2222-3333-444455556666";
    await ledger.submit(() => expeditionOp(session, 0, -1));
    const sha = "c1".repeat(20);
    const result = await ingestOnce(ledger, {
      hooks: [hookRecord(sha, { CLAUDE_CODE_SESSION_ID: session })],
      activities: [sessionActivity(session, "codex")],
      diffForCommit: async () => textChange("src/cross.ts", "blob-cross"),
    });
    expect(result.resources).toEqual({ wood: 0, stone: 0, iron: 0, parchment: 0 });
    expect(result.reasons).toEqual([{ sha, repo: CITY, reason: "no-matching-adapter-session" }]);
  });
  test("同一個紀錄帶多個 CLI 的 session 變數時，session id 與 cli 必須來自同一支變數；混用不算配對", async () => {
    const ledger = await openCity("mixed-env");
    const ompSession = "01a1f699-7f0f-7332-8bb8-870d53a3a220";
    const claudeSession = "9b68ce79-8d92-4ecf-8ff2-040a87512f31";
    await ledger.submit(() => expeditionOp(ompSession, 0, -1));
    await ledger.submit(() => expeditionOp(claudeSession, 1, 0));
    const mixed = "d1".repeat(20);
    const ompOnly = "d2".repeat(20);
    const activities = [sessionActivity(ompSession, "omp"), sessionActivity(claudeSession, "claude")];

    // 一個 hook 紀錄同時帶 PI_SESSION_ID 與 CLAUDE_CODE_SESSION_ID → 兩個候選 → 衝突，不收成。
    const conflicted = await ingestOnce(ledger, {
      hooks: [hookRecord(mixed, { PI_SESSION_ID: ompSession, CLAUDE_CODE_SESSION_ID: claudeSession })],
      activities,
      diffForCommit: async () => textChange("src/mixed.ts", "blob-mixed"),
    });
    expect(conflicted.resources).toEqual({ wood: 0, stone: 0, iron: 0, parchment: 0 });
    expect(conflicted.reasons).toEqual([{ sha: mixed, repo: CITY, reason: "ambiguous-session-source" }]);

    // 只有 PI_SESSION_ID 的 OMP 紀錄仍照舊：精確配對到自己的活動並收成；衝突的那筆仍不收成。
    const ompResult = await ingestOnce(ledger, {
      hooks: [hookRecord(mixed, { PI_SESSION_ID: ompSession, CLAUDE_CODE_SESSION_ID: claudeSession }), hookRecord(ompOnly, { PI_SESSION_ID: ompSession })],
      activities,
      diffForCommit: async (sha) => textChange(`src/${sha.slice(0, 2)}.ts`, `blob-${sha.slice(0, 2)}`),
    });
    expect(ompResult.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
    expect(ompResult.reasons).toEqual([{ sha: mixed, repo: CITY, reason: "ambiguous-session-source" }]);
  });
});
