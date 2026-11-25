// Codex（#10）與 Claude Code（#11）的 commit 來源接線：固定情境重播。
//
// 配對規則（§7.2、ticket #10／#11）：只認 commit hook 當下記到的 `CODEX_THREAD_ID`／
// `CLAUDE_CODE_SESSION_ID` 與 adapter 活動檔的 `sessionId` **完全相等**，而且 CLI 相同。
// 對不到＝來源不明，不發資源、不用 terminal ID、時間或 HEAD 差異補猜；
// 多重證據衝突（兩個不同身分）也不發。
//
// 舊版這裡發的是遠征格的收成點數；現在唯一會發的是共用城市的成果加成（#24），
// 所以斷言改成「共用庫存有沒有多一份 ACHIEVEMENT_YIELD」，以及 commitContexts 的理由。
import { describe, expect, test } from "bun:test";
import { commitContexts } from "../core/commit-evidence.js";
import { CityLedger } from "../core/ledger.js";
import { ACHIEVEMENT_YIELD } from "../core/rules.js";
import { ingestAchievements, ingestIncome, readSharedCity, SHARED_CITY_ID, sharedCityDir } from "../core/shared-city.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/reclaim-adapter-sources/.git";
const CHECKOUT = "/tmp/reclaim-adapter-sources";
const TOOL_CALL = "call_resp_1795139896423";
const YIELD = [ACHIEVEMENT_YIELD.wood, ACHIEVEMENT_YIELD.stone, ACHIEVEMENT_YIELD.iron];

/** 一個互動 root（或 child）的活動檔：一個已結束、沒有用量的回合。 */
const sessionActivity = (sessionId, cli, { role = "root", parentSessionId = null } = {}) => ({
  schema: 1,
  sessionId,
  writerEpoch: `epoch-${sessionId}`,
  cli,
  role,
  interactive: role !== "child",
  parentSessionId,
  updatedAt: 10,
  lastEventSeq: 3,
  events: [
    { eventSeq: 1, kind: "visit_start", at: 1, visit: { visitId: `v-${sessionId}`, cwd: CHECKOUT, commonDir: CITY, checkout: CHECKOUT } },
    { eventSeq: 2, kind: "interval_open", at: 1 },
    { eventSeq: 3, kind: "interval_close", at: 2 },
  ],
});

const hookRecord = (sha, env) => ({ schema: 1, sha, hook: "post-commit", commonDir: CITY, toplevel: CHECKOUT, at: 10, env });
const textChange = (path, blob) => [{ status: "A", path, resultBlob: blob }];
const stockOf = (state) => [state.resources.wood, state.resources.stone, state.resources.iron];

function openShared(name) {
  const dir = sharedCityDir(`/tmp/reclaim-adapter-sources/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return new CityLedger({ io: createFileIo(), dir, cityId: SHARED_CITY_ID }).open();
}

/**
 * 一次載入：活動（收入先建立啟用邊界）＋成果加成。回傳庫存與每一條 commit 證據的判定，
 * 這樣「為什麼沒發」也有可觀察的答案（舊版的 unharvestedCommits 換成 commitContexts）。
 */
async function ingestOnce(ledger, { hooks = [], sources = [], activities = [], diffForCommit, remoteMerges = new Set() } = {}) {
  await ingestIncome(ledger, { activities, activateAt: 0 });
  await ingestAchievements(ledger, { activities, hooks, sources, remoteMerges, diffForCommit, activateAt: 0 });
  const state = await ledger.state();
  const contexts = commitContexts({ hooks, sources, activities, remoteMerges });
  return {
    stock: stockOf(state),
    city: readSharedCity(state).city,
    reasons: Object.fromEntries(contexts.map((context) => [context.sha, context.reason])),
  };
}

describe("Codex／Claude 的 commit 來源接線", () => {
  test("Codex：精確配對才發；錯誤 session、只有 terminal ID 不發；晚到活動自動補算；重播不重複", async () => {
    const ledger = await openShared("codex");
    const codexSession = "01a1f6ad-0341-79f2-89bb-fb86a7763ddc";
    const otherSession = "01a1f6ad-ffff-0000-0000-000000000000";
    const lateSession = "01a1f6ad-0000-1111-2222-333344445555";
    const codexActivity = sessionActivity(codexSession, "codex");

    const matchedSha = "a1".repeat(20);
    const wrongSha = "a2".repeat(20);
    const terminalSha = "a3".repeat(20);
    const lateSha = "a4".repeat(20);
    const diffForCommit = async (sha) => textChange(`src/${sha.slice(0, 2)}.ts`, `blob-${sha.slice(0, 2)}`);
    // mod 每次載入都重讀目錄裡的所有 hook 檔，所以這裡也把累積的紀錄一起餵進去。
    const records = [];
    const ingest = (extra) => ingestOnce(ledger, { hooks: [...records], ...extra });

    // ① 精確配對：hook 的 CODEX_THREAD_ID 與 adapter 活動檔 sessionId 完全相等 → 發一份成果加成。
    records.push(hookRecord(matchedSha, { CODEX_THREAD_ID: codexSession, CODEX_TOOL_CALL_ID: TOOL_CALL }));
    const matched = await ingest({ activities: [codexActivity], diffForCommit });
    expect(matched.stock).toEqual(YIELD);
    expect(matched.reasons[matchedSha]).toBeNull();

    // ② 錯誤 session：hook 記到的 thread id 沒有任何 adapter 活動 → 來源不明，不發。
    records.push(hookRecord(wrongSha, { CODEX_THREAD_ID: otherSession }));
    const wrong = await ingest({ activities: [codexActivity], diffForCommit });
    expect(wrong.stock).toEqual(YIELD);
    expect(wrong.reasons[wrongSha]).toBe("no-matching-adapter-session");

    // ③ 只有 terminal ID：連 session 都沒有 → terminal-only，不發。
    records.push(hookRecord(terminalSha, { HC_TERMINAL_ID: "t5f" }));
    const terminal = await ingest({ activities: [codexActivity], diffForCommit });
    expect(terminal.stock).toEqual(YIELD);
    expect(terminal.reasons[terminalSha]).toBe("terminal-only");

    // ④ 晚到 adapter 活動：先只有 hook 紀錄（來源不明、不發），活動檔之後才出現 → 自動補算。
    records.push(hookRecord(lateSha, { CODEX_THREAD_ID: lateSession }));
    const beforeActivity = await ingest({ activities: [codexActivity], diffForCommit });
    expect(beforeActivity.stock).toEqual(YIELD);
    expect(beforeActivity.reasons[lateSha]).toBe("no-matching-adapter-session");
    const late = await ingest({ activities: [codexActivity, sessionActivity(lateSession, "codex")], diffForCommit });
    expect(late.stock).toEqual(YIELD.map((amount) => amount * 2));
    expect(late.reasons[lateSha]).toBeNull();

    // ⑤ 重播同一份證據：不再發、庫存不變。
    const replayed = await ingest({ activities: [codexActivity, sessionActivity(lateSession, "codex")], diffForCommit });
    expect(replayed.stock).toEqual(YIELD.map((amount) => amount * 2));
  });

  test("Claude：精確配對才發；多重證據衝突不發；child 的活動併進 root 仍算同一個工作", async () => {
    const ledger = await openShared("claude");
    const rootSession = "7e247495-27e2-4a67-bf5b-c6078ae1719e";
    const childSession = `${rootSession}~sub~af9975d7758d7b308`;
    const rootActivity = sessionActivity(rootSession, "claude");

    const matchedSha = "b1".repeat(20);
    const conflictSha = "b2".repeat(20);
    const childSha = "b3".repeat(20);
    const diffForCommit = async (sha) => textChange(`lib/${sha.slice(0, 2)}.js`, `blob-${sha.slice(0, 2)}`);

    // ① 精確配對：CLAUDE_CODE_SESSION_ID 與 Claude adapter 活動檔 sessionId 完全相等。
    const matched = await ingestOnce(ledger, {
      hooks: [hookRecord(matchedSha, { CLAUDE_CODE_SESSION_ID: rootSession })],
      activities: [rootActivity],
      diffForCommit,
    });
    expect(matched.stock).toEqual(YIELD);
    expect(matched.reasons[matchedSha]).toBeNull();

    // ② 多重證據衝突：同一個 SHA 同時對到兩支不同 session（OMP 與 Claude）→ 不發。
    const conflict = await ingestOnce(ledger, {
      hooks: [hookRecord(conflictSha, { PI_SESSION_ID: "omp-session-1" }), hookRecord(conflictSha, { CLAUDE_CODE_SESSION_ID: rootSession })],
      activities: [rootActivity, sessionActivity("omp-session-1", "omp")],
      diffForCommit,
    });
    expect(conflict.stock).toEqual(YIELD);
    expect(conflict.reasons[conflictSha]).toBe("ambiguous-session-source");

    // ③ child 的活動是 `root~sub~agentId`；commit hook 記的是 root session id，
    //    因此仍然精確配對到 root 活動，成果算在 root 那一棵樹。
    const child = await ingestOnce(ledger, {
      hooks: [hookRecord(childSha, { CLAUDE_CODE_SESSION_ID: rootSession })],
      activities: [rootActivity, sessionActivity(childSession, "claude", { role: "child", parentSessionId: rootSession })],
      diffForCommit,
    });
    expect(child.stock).toEqual(YIELD.map((amount) => amount * 2));
    expect(child.reasons[childSha]).toBeNull();
  });

  test("Claude 的活動若屬於別的 CLI（session id 巧合相同）不算配對", async () => {
    const ledger = await openShared("cross-cli");
    const session = "c0ffee00-1111-2222-3333-444455556666";
    const sha = "c1".repeat(20);
    const result = await ingestOnce(ledger, {
      hooks: [hookRecord(sha, { CLAUDE_CODE_SESSION_ID: session })],
      activities: [sessionActivity(session, "codex")],
      diffForCommit: async () => textChange("src/cross.ts", "blob-cross"),
    });
    expect(result.stock).toEqual([0, 0, 0]);
    expect(result.reasons[sha]).toBe("no-matching-adapter-session");
  });

  test("同一個紀錄帶多個 CLI 的 session 變數時，session id 與 cli 必須來自同一支變數；混用不算配對", async () => {
    const ledger = await openShared("mixed-env");
    const ompSession = "01a1f699-7f0f-7332-8bb8-870d53a3a220";
    const claudeSession = "9b68ce79-8d92-4ecf-8ff2-040a87512f31";
    const mixed = "d1".repeat(20);
    const ompOnly = "d2".repeat(20);
    const activities = [sessionActivity(ompSession, "omp"), sessionActivity(claudeSession, "claude")];
    const diffForCommit = async (sha) => textChange(`src/${sha.slice(0, 2)}.ts`, `blob-${sha.slice(0, 2)}`);

    // 一個 hook 紀錄同時帶 PI_SESSION_ID 與 CLAUDE_CODE_SESSION_ID → 兩個候選 → 衝突，不發。
    const conflicted = await ingestOnce(ledger, {
      hooks: [hookRecord(mixed, { PI_SESSION_ID: ompSession, CLAUDE_CODE_SESSION_ID: claudeSession })],
      activities,
      diffForCommit,
    });
    expect(conflicted.stock).toEqual([0, 0, 0]);
    expect(conflicted.reasons[mixed]).toBe("ambiguous-session-source");

    // 只有 PI_SESSION_ID 的 OMP 紀錄仍照舊：精確配對到自己的活動並發一份；衝突的那筆仍不發。
    const ompResult = await ingestOnce(ledger, {
      hooks: [hookRecord(mixed, { PI_SESSION_ID: ompSession, CLAUDE_CODE_SESSION_ID: claudeSession }), hookRecord(ompOnly, { PI_SESSION_ID: ompSession })],
      activities,
      diffForCommit,
    });
    expect(ompResult.stock).toEqual(YIELD);
    expect(ompResult.reasons[mixed]).toBe("ambiguous-session-source");
    expect(ompResult.reasons[ompOnly]).toBeNull();
  });

  test("遠端合併與沒有可信提交時間的證據不發成果加成", async () => {
    const ledger = await openShared("no-time");
    const session = "01a1f6ad-0000-7000-0000-00000000beef";
    const remoteSha = "e1".repeat(20);
    const noTimeSha = "e2".repeat(20);
    const activity = sessionActivity(session, "omp");
    const result = await ingestOnce(ledger, {
      hooks: [hookRecord(remoteSha, { PI_SESSION_ID: session }), { ...hookRecord(noTimeSha, { PI_SESSION_ID: session }), at: 0 }],
      activities: [activity],
      remoteMerges: new Set([remoteSha]),
      diffForCommit: async (sha) => textChange(`src/${sha.slice(0, 2)}.ts`, `blob-${sha.slice(0, 2)}`),
    });
    expect(result.stock).toEqual([0, 0, 0]);
    expect(result.reasons[remoteSha]).toBe("remote-merge");
    expect(result.reasons[noTimeSha]).toBe("unknown-commit-time");
  });
});
