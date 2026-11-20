// QA 回歸（真 UI 歷程搜尋 0 筆）：搜尋的查詢狀態機在 UI 層斷了，模型層是好的。
//
// 這支測試走 UI 層用的同一段狀態機（core/history-search.js），資料用與 QA 相同的固定情境
// （seed + UI 操作 + 研究結算 → 帳本 history records），驗證：
//   * 五種查詢的筆數 2／1／5／4／1（與 QA 的 history-fixture.json 相同）；
import { formatHistoryTime, historyResultLines, searchHistory, usableTime } from "../core/history.js";
//   * Enter／Return／NumpadEnter 三種鍵名與「搜尋」按鈕走同一個送出函式；
//   * 狀態列看得到筆數與查詢，讀取失敗看得到原因。
import { describe, expect, test } from "bun:test";
import { CityLedger, cityDir } from "../core/ledger.js";
import { ingestScenario, processBuild, processBoost, processLand, processTrade, ingestResearch, redispatch } from "../core/ingest.js";
import { commitContexts, ingestCommits } from "../core/commit-evidence.js";
import { historyChanged, historyLoadFailed, historyLoaded, historyOpened, historyStatusLine, historySubmitted, isSubmitKeystroke } from "../core/history-search.js";
import { RECIPES } from "../core/rules.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/qa-ui-fixture/repo/.git";
const AT = Date.parse("2026-11-18T09:00:00Z");
const T = (minutes) => AT + minutes * 60_000;
const RECIPE = Object.keys(RECIPES)[0];

const activity = (sessionId, minutes) => ({
  schema: 1,
  sessionId,
  writerEpoch: "ui-fixed",
  role: "root",
  interactive: true,
  cli: "omp",
  updatedAt: T(minutes),
  events: [
    { eventSeq: 1, kind: "visit_start", at: AT, visit: { visitId: sessionId, cwd: "/tmp/qa-ui-fixture/repo", checkout: "/tmp/qa-ui-fixture/repo", commonDir: CITY } },
    { eventSeq: 2, kind: "interval_open", at: AT },
    { eventSeq: 3, kind: "usage", at: AT + 1, usage: { anthropic: { inputNonCache: 300, output: 50, cacheRead: 0, cacheWrite: 0, costKnown: 0.02, unknownFields: [] } } },
    { eventSeq: 4, kind: "interval_close", at: T(minutes) },
  ],
});

/** QA 的固定情境：五支互動遠征、一筆收成供應、一筆只有 terminal ID 的提交。 */
async function historyFixture(dir) {
  const activities = [["withdraw-ui", 5], ["archive-ui", 100], ["build-ui", 100], ["boost-ui", 95], ["harvest-ui", 80]]
    .map(([id, minutes]) => activity(id, minutes));
  const ledger = await new CityLedger({ io: createFileIo(), dir: cityDir(dir, CITY), cityId: CITY }).open();
  await ingestScenario(ledger, { activities }, CITY);
  await ledger.submit(() => ({
    kind: "harvest", opId: "ui-fixture-supply", cityId: CITY, rootSessionId: "harvest-ui", generation: 1,
    at: T(81), points: 20, resources: { wood: 20, stone: 10, parchment: 4 },
    paths: ["src/ui-telescope.js"], claims: ["qa-ui-fixture"], sha: "a".repeat(40), subject: "UI silver telescope",
  }));
  const hook = { schema: 1, sha: "b".repeat(40), hook: "post-commit", commonDir: CITY, toplevel: "/tmp/qa-ui-fixture/repo", at: T(60), env: { HC_TERMINAL_ID: "qa-isolated-terminal" } };
  await ingestCommits({
    ledger, hooks: [hook], sources: [], activities,
    diffForCommit: async () => [{ status: "A", path: "src/unknown-ui.js", resultBlob: "ui-blob" }],
    subjectForCommit: async () => "UI unknown comet",
  });
  // QA 在真 UI 做過的操作與研究結算，都在同一份帳本上。
  await processLand(ledger, { rootSessionId: "withdraw-ui", generation: 1, action: "withdraw", at: T(90) });
  await redispatch(ledger, { rootSessionId: "withdraw-ui", at: T(91) });
  await processLand(ledger, { rootSessionId: "archive-ui", generation: 1, action: "archive", at: T(92) });
  await processBuild(ledger, { rootSessionId: "build-ui", generation: 1, recipe: RECIPE, at: T(93) });
  await processBoost(ledger, { rootSessionId: "boost-ui", generation: 1, scrolls: 1, at: T(94) });
  await processTrade(ledger, { from: "parchment", to: "wood", amount: 1, at: T(95) });
  const beforeResearch = await ledger.state();
  await ingestResearch(ledger, {
    activities: [...beforeResearch.activities.values()],
    commits: commitContexts({ hooks: [hook], activities: [...beforeResearch.activities.values()] }),
    cityId: CITY,
  });
  const state = await ledger.state();
  return {
    records: await ledger.historyRecords(),
    tiles: state.tiles,
    cityNames: { [CITY]: "repo" },
    unresolvedActivities: [],
  };
}

/** 開面板、載入、輸入、送出的完整 UI 路徑；回傳最後的狀態。 */
function runQuery(data, value) {
  const opened = historyOpened();
  const loaded = historyLoaded(opened, data);
  const typed = historyChanged(loaded, value);
  return historySubmitted(typed, value);
}

describe("歷程搜尋的 UI 查詢狀態機（#9 QA 回歸）", () => {
  test("五種查詢的筆數是 2／1／5／4／1", async () => {
    const dir = `/tmp/reclaim-history-search-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const data = await historyFixture(dir);

    expect(runQuery(data, "path:ui-telescope.js").total).toBe(2);
    expect(runQuery(data, "commit:telescope").total).toBe(1);
    expect(runQuery(data, "session:withdraw-ui").total).toBe(5);
    expect(runQuery(data, "session:archive-ui").total).toBe(4);
    const comet = runQuery(data, "commit:comet");
    expect(comet.total).toBe(1);
    expect(comet.results[0].reason).toBe("terminal-only");
  }, 60_000);


  test("壞掉的時間戳記（20 位數的舊證據 at）不會讓搜尋丟例外", () => {
    // 真實案例：隔離 home 裡的舊 hook 證據把 at 寫成 "17951377930001800000"（1.8e19，超出
    // Date 範圍）。舊版在 matches() 裡 new Date(1.8e19).toISOString() 直接 RangeError，
    // 整個搜尋中斷，UI 看起來就是「每一種查詢都 0 筆」。
    const poisoned = {
      seq: 99, at: "17951377930001800000", kind: "commit", cityId: "/tmp/other/.git",
      rootSessionId: null, generation: null, sha: "c".repeat(40), subject: "legacy", reason: "no-session-source",
    };
    const records = [
      poisoned,
      { seq: 10, at: 1_795_000_000_000, kind: "commit", cityId: CITY, rootSessionId: null, generation: null, sha: "b".repeat(40), subject: "UI unknown comet", reason: "terminal-only" },
      { seq: 11, at: 1_795_000_000_001, kind: "harvest", cityId: CITY, rootSessionId: "harvest-ui", generation: 1, sha: "a".repeat(40), subject: "UI silver telescope", paths: ["src/ui-telescope.js"] },
    ];
    const tiles = [{ cityId: CITY, rootSessionId: "harvest-ui", generation: 1, activatedAt: 1_795_000_000_000, harvestedPaths: ["src/ui-telescope.js"] }];
    const search = (query) => searchHistory({ records, tiles, cityNames: { [CITY]: "repo" }, query });

    expect(usableTime(poisoned.at)).toBeNull();
    expect(usableTime(1_795_000_000_000)).toBe(1_795_000_000_000);
    expect(formatHistoryTime(poisoned.at)).toBe("時間未知");
    for (const query of ["path:ui-telescope.js", "commit:comet", "commit:telescope", "no-session-source", "date:2026-11"]) {
      expect(search(query).total).toBeGreaterThan(0);
    }
    expect(historyResultLines(search("commit:comet").results[0]).reasonLine).toBe("未收成原因：只有 terminal ID");
  });
  test("資料還沒載入完就先送出查詢：載入完成後自動重跑，不會停在 0 筆", async () => {
    const dir = `/tmp/reclaim-history-search-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const data = await historyFixture(dir);

    // 打開面板 → 立刻打字送出（此時 records 還是空的）→ 才是載入完成。
    const opened = historyOpened();
    const typed = historyChanged(opened, "path:ui-telescope.js");
    const early = historySubmitted(typed, "path:ui-telescope.js");
    expect(early.total).toBe(0);
    expect(historyStatusLine(early)).toBe("正在讀取歷程紀錄…");

    const loaded = historyLoaded(early, data);
    expect(loaded.loading).toBe(false);
    expect(loaded.total).toBe(2);
    expect(historyStatusLine(loaded)).toContain("2 筆符合「path:ui-telescope.js」");
  }, 60_000);

  test("Enter／Return／NumpadEnter 與搜尋按鈕都會送出查詢", () => {
    for (const event of [{ key: "Enter" }, { key: "Return" }, { key: "NumpadEnter" }, { keystroke: "enter" }, { keystroke: "return" }]) {
      expect(isSubmitKeystroke(event)).toBe(true);
    }
    for (const event of [{ key: "a" }, { key: "Escape" }, { keystroke: "shift-tab" }, null]) {
      expect(isSubmitKeystroke(event)).toBe(false);
    }
    // 沒有資料也要有看得見的狀態，不是安靜的 0 筆。
    const empty = historyLoaded(historyOpened(), {});
    expect(historyStatusLine(historySubmitted(empty, "commit:comet"))).toContain("0 筆符合「commit:comet」");
  });

  test("讀取失敗時狀態列說得出原因，不是安靜的 0 筆", () => {
    const failed = historyLoadFailed(historyOpened(), new Error("head 不見了"));
    expect(failed.loading).toBe(false);
    expect(historyStatusLine(failed)).toContain("歷程讀取失敗");
    expect(historySubmitted(failed, "commit:comet").total).toBe(0);
  });
});
