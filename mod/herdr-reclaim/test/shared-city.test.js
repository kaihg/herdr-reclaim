// ticket #23 共用城市的基本收入：固定的工作事件 → 實際隔離帳本 → 公開的共用城市讀取模型。
// 斷言的是玩家看得到的庫存與工作進度；不測私有欄位或寫入順序。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CityLedger, cityDir } from "../core/ledger.js";
import { ingestScenario } from "../core/ingest.js";
import { RECIPES, WORK_TOKENS_PER_UNIT, WORK_YIELD } from "../core/rules.js";
import { SHARED_CITY_ID, ingestIncome, readSharedCity, sharedCityDir } from "../core/shared-city.js";
import { createFileIo } from "./fs-io.js";

const REPO_A = "/tmp/reclaim-23-a/.git";
const REPO_B = "/tmp/reclaim-23-b/.git";
const AT = 1_800_000_000_000;
const T = (ms) => AT + ms;

const root = (name) => `/tmp/reclaim-23-shared/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

function activity({ sessionId, role = "root", interactive = true, parentSessionId, writerEpoch, events }) {
  return {
    schema: 1,
    cli: "omp",
    cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
    sessionId,
    role,
    interactive,
    ...(parentSessionId ? { parentSessionId } : {}),
    writerEpoch: writerEpoch ?? `${sessionId}-1`,
    events: events.map((event, index) => ({ eventSeq: index + 1, ...event })),
    updatedAt: Math.max(...events.map((event) => event.at)),
  };
}

const visitStart = (commonDir, at) => ({
  kind: "visit_start",
  at,
  visit: { visitId: `v-${commonDir}-${at}`, cwd: commonDir.replace(/\/\.git$/, ""), commonDir, checkout: commonDir.replace(/\/\.git$/, "") },
});
const open = (at) => ({ kind: "interval_open", at });
const close = (at) => ({ kind: "interval_close", at });

/** 一筆用量事件；`sourceKey: null` 代表 adapter 沒有給來源 key。 */
const usageEvent = (at, entryId, fields = {}, { provider = "openai", sessionId = "s", sourceKey } = {}) => ({
  kind: "usage",
  at,
  sourceEntryId: entryId,
  usage: {
    [provider]: {
      ...(sourceKey === null ? {} : { sourceKey: sourceKey ?? `omp#${sessionId}#${entryId}` }),
      inputNonCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      costKnown: 0,
      costUnknownEntries: 0,
      ...fields,
    },
  },
});

/** 一個完整回合：在 `repo` 開始工作、這些用量、結束。 */
const round = (repo, openAt, closeAt, usages) => [visitStart(repo, openAt), open(openAt), ...usages, close(closeAt)];

const TEN_K = { inputNonCache: 7_000, output: 3_000 };

async function sharedLedger(dir, options = {}) {
  return new CityLedger({ io: createFileIo(), dir: sharedCityDir(dir), cityId: SHARED_CITY_ID, ...options }).open();
}

/** 啟用邊界固定在固定情境的最前面（正式 runtime 用第一次啟用的當下），測試結果不依牆上時鐘。 */
const settle = (ledger, activities, options = {}) => ingestIncome(ledger, { activities, activateAt: T(0), ...options });

/** 一個「space」從共用帳本讀到的公開城市（每次都重新開帳本，像另一個視窗）。 */
async function cityAt(dir) {
  return readSharedCity(await (await sharedLedger(dir)).state()).city;
}

const stock = (city) => [city.resources.wood, city.resources.stone, city.resources.iron];
const perUnit = [WORK_YIELD.wood, WORK_YIELD.stone, WORK_YIELD.iron];
const times = (n) => perUnit.map((amount) => amount * n);

describe("共用城市的基本收入（#23）", () => {
  test("兩個專案的研究、沒有 commit 與交易，逐步取得各種基本建材；兩個 space 看到同一份庫存", async () => {
    const dir = root("two-projects");
    const ledger = await sharedLedger(dir);
    expect(stock(readSharedCity(await ledger.state()).city)).toEqual([0, 0, 0]);

    const inA = activity({ sessionId: "a", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "a1", TEN_K)]) });
    await settle(ledger, [inA]);
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 未滿一單位的工作先累積在進度條，庫存不變。
    const half = activity({ sessionId: "b", events: round(REPO_B, T(100_000), T(160_000), [usageEvent(T(101_000), "b1", { output: 5_000 }, { sessionId: "b" })]) });
    await settle(ledger, [inA, half]);
    const partial = await cityAt(dir);
    expect(stock(partial)).toEqual(times(1));
    expect(partial.work).toEqual({ tokens: 5_000, unitTokens: WORK_TOKENS_PER_UNIT });

    // 下一個回合跨過門檻：收成依計量器餘數補齊，不是只看這一回合的 token。
    const moreB = activity({
      sessionId: "b",
      writerEpoch: "b-2",
      events: round(REPO_B, T(200_000), T(260_000), [usageEvent(T(201_000), "b2", { inputNonCache: 15_000 }, { sessionId: "b" })]),
    });
    await settle(ledger, [inA, half, moreB]);
    const city = await cityAt(dir);
    expect(stock(city)).toEqual(times(3));
    expect(city.work.tokens).toBe(0);
    // 沒有指定任何建築，也不會有人替玩家花掉庫存。
    expect(Object.keys(RECIPES).length).toBeGreaterThan(0);
    expect(stock(await cityAt(dir))).toEqual(times(3));
  });

  test("同樣的工作切成長短不同的對話、換 provider、/new 與恢復，收入相同且不產生遠征格", async () => {
    const oneDir = root("one-session");
    const one = await sharedLedger(oneDir);
    await settle(one, [activity({
      sessionId: "long",
      events: [
        ...round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "l1", TEN_K, { sessionId: "long" })]),
        ...round(REPO_A, T(100_000), T(160_000), [usageEvent(T(101_000), "l2", TEN_K, { sessionId: "long" })]),
        ...round(REPO_A, T(200_000), T(260_000), [usageEvent(T(201_000), "l3", TEN_K, { sessionId: "long" })]),
      ],
    })]);

    const manyDir = root("many-sessions");
    const many = await sharedLedger(manyDir);
    await settle(many, [
      activity({ sessionId: "new-1", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "n1", TEN_K, { sessionId: "new-1", provider: "anthropic" })]) }),
      // /new：另一支 session，另一個專案，另一個 provider。
      activity({ sessionId: "new-2", events: round(REPO_B, T(100_000), T(160_000), [usageEvent(T(101_000), "n2", TEN_K, { sessionId: "new-2", provider: "google" })]) }),
      // 恢復對話：同一支 session 的新 writer epoch。
      activity({ sessionId: "new-1", writerEpoch: "new-1-2", events: round(REPO_B, T(200_000), T(260_000), [usageEvent(T(201_000), "n3", TEN_K, { sessionId: "new-1" })]) }),
    ]);

    expect(stock(await cityAt(manyDir))).toEqual(stock(await cityAt(oneDir)));
    expect(stock(await cityAt(manyDir))).toEqual(times(3));
    // 共用城市沒有「遠征格」：切對話不會多工地，帳本裡也沒有格子。
    expect((await many.state()).tiles).toEqual([]);
    expect((await one.state()).tiles).toEqual([]);
    expect(readSharedCity(await many.state()).city.tiles).toBeUndefined();
  });

  test("兩個 space 重送同一份工作只入帳一次；不同工作不會被誤判成重播；關閉再開庫存不變", async () => {
    const dir = root("replay");
    const record = () => activity({ sessionId: "s", writerEpoch: "s-1", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "e1", TEN_K)]) });

    // 兩個視窗各自開帳本，同時送同一份紀錄。
    const [windowA, windowB] = await Promise.all([sharedLedger(dir), sharedLedger(dir)]);
    await Promise.all([settle(windowA, [record()]), settle(windowB, [record()])]);
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 恢復對話後的新 epoch 又回報同一筆來源 entry。
    const resumed = activity({ sessionId: "s", writerEpoch: "s-2", events: round(REPO_A, T(500_000), T(560_000), [usageEvent(T(1_000), "e1", TEN_K)]) });
    await settle(windowA, [record(), resumed]);
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 同 token 量、同時間、不同來源 entry：是另一份工作。
    const other = activity({ sessionId: "s", writerEpoch: "s-3", events: round(REPO_A, T(600_000), T(660_000), [usageEvent(T(1_000), "e2", TEN_K)]) });
    await settle(windowB, [record(), resumed, other]);
    expect(stock(await cityAt(dir))).toEqual(times(2));

    // 沒有來源 key 的用量，不同 session 的同一個事件序號仍是不同的工作。
    const keyless = (sessionId) => activity({ sessionId, events: round(REPO_B, T(700_000), T(760_000), [usageEvent(T(701_000), "k", TEN_K, { sessionId, sourceKey: null })]) });
    await settle(windowA, [keyless("x"), keyless("y")]);
    expect(stock(await cityAt(dir))).toEqual(times(4));
    await settle(windowB, [keyless("x"), keyless("y")]);
    expect(stock(await cityAt(dir))).toEqual(times(4));

    // 關閉再開：重播 journal 與 checkpoint 都是同一份庫存，再送一次也不重領。
    const reopened = await sharedLedger(dir);
    await reopened.checkpoint();
    const afterCheckpoint = await sharedLedger(dir);
    await settle(afterCheckpoint, [record(), resumed, other, keyless("x"), keyless("y")]);
    expect(stock(await cityAt(dir))).toEqual(times(4));
  });

  test("只有互動工作的已結束回合才有收入：print、快取、未結束的回合與未知用量都不算；子 session 併入上層", async () => {
    const dir = root("effective");
    const ledger = await sharedLedger(dir);
    const printed = activity({ sessionId: "print", interactive: false, events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "p1", TEN_K, { sessionId: "print" })]) });
    const cached = activity({ sessionId: "cache", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "c1", { cacheRead: 900_000, cacheWrite: 90_000 }, { sessionId: "cache" })]) });
    const unknown = activity({
      sessionId: "unknown",
      events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "u1", { ...TEN_K, unknownFields: ["output"] }, { sessionId: "unknown" })]),
    });
    const running = activity({ sessionId: "run", events: [visitStart(REPO_A, T(0)), open(T(0)), usageEvent(T(1_000), "r1", TEN_K, { sessionId: "run" })] });
    await settle(ledger, [printed, cached, unknown, running]);
    expect(stock(await cityAt(dir))).toEqual([0, 0, 0]);
    expect((await cityAt(dir)).work.tokens).toBe(0);

    // 回合結束之後才入帳。
    const finished = activity({
      sessionId: "run",
      events: [visitStart(REPO_A, T(0)), open(T(0)), usageEvent(T(1_000), "r1", TEN_K, { sessionId: "run" }), close(T(60_000))],
    });
    const child = activity({
      sessionId: "kid",
      role: "child",
      interactive: false,
      parentSessionId: "run",
      events: round(REPO_A, T(10_000), T(50_000), [usageEvent(T(11_000), "kid1", TEN_K, { sessionId: "kid" })]),
    });
    await settle(ledger, [finished, child]);
    expect(stock(await cityAt(dir))).toEqual(times(2));
  });

  test("啟用邊界：啟用前已結束的舊城歷史不重發，之後的工作照常入帳", async () => {
    const dir = root("boundary");
    const ledger = await sharedLedger(dir);
    const before = activity({ sessionId: "old", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "old1", { inputNonCache: 20_000 }, { sessionId: "old" })]) });
    const during = activity({ sessionId: "now", events: round(REPO_B, T(200_000), T(260_000), [usageEvent(T(201_000), "now1", TEN_K, { sessionId: "now" })]) });

    await settle(ledger, [before, during], { activateAt: T(150_000) });
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 邊界記在帳本裡：重開帳本（或重播、做 checkpoint）仍然只算啟用之後的工作。
    const reopened = await sharedLedger(dir);
    await reopened.checkpoint();
    expect((await reopened.state()).work.since).toBe(T(150_000));
    await settle(await sharedLedger(dir), [before, during]);
    expect(stock(await cityAt(dir))).toEqual(times(1));
  });

  test("共用帳本不碰舊版各城帳本：舊城檔案逐位元不變，共用帳本也不會被當成一座舊城", async () => {
    const dir = root("legacy-untouched");
    const legacyId = REPO_A;
    const legacy = await new CityLedger({ io: createFileIo(), dir: cityDir(dir, legacyId), cityId: legacyId }).open();
    const work = [activity({ sessionId: "old", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "o1", TEN_K, { sessionId: "old" })]) })];
    await ingestScenario(legacy, { activities: work }, legacyId);

    const snapshot = (base) => {
      const files = {};
      const walk = (current) => {
        if (!fs.existsSync(current)) return;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const file = path.join(current, entry.name);
          if (entry.isDirectory()) walk(file);
          else files[path.relative(base, file)] = fs.readFileSync(file, "utf8");
        }
      };
      walk(base);
      return files;
    };
    const legacyFiles = snapshot(`${dir}/cities`);
    expect(Object.keys(legacyFiles).length).toBeGreaterThan(0);

    const shared = await sharedLedger(dir);
    await settle(shared, work);
    expect(stock(await cityAt(dir))).toEqual(times(1));
    expect(snapshot(`${dir}/cities`)).toEqual(legacyFiles);
    expect(Object.keys(snapshot(sharedCityDir(dir))).length).toBeGreaterThan(0);
    // 掃 `cities/` 找舊城的地方（main.js）因此看不到共用帳本。
    expect(Object.values(snapshot(`${dir}/cities`)).some((text) => text.includes(SHARED_CITY_ID))).toBe(false);
  });
});
