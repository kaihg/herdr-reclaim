// ticket #23 共用城市的基本收入：固定的工作事件 → 實際隔離帳本 → 公開的共用城市讀取模型。
// 斷言的是玩家看得到的庫存與工作進度；不測私有欄位或寫入順序。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CityLedger, emptyState, workYieldOf } from "../core/ledger.js";
import { hashText } from "../core/bytes.js";
import { BUILD_QUEUE_LIMIT, CITY_BUILDINGS, START_RESOURCES, WORK_TOKENS_PER_UNIT, WORK_YIELD } from "../core/rules.js";
import { SHARED_CITY_ID, cancelPlan, ingestIncome, placePlan, readSharedCity, sharedCityDir } from "../core/shared-city.js";
import { footprintCells, groundAt, legalSites, revealedCells, siteCheck, terrainAt } from "../core/city-map.js";
import { createFileIo } from "./fs-io.js";

const REPO_A = "/tmp/reclaim-23-a/.git";
const REPO_B = "/tmp/reclaim-23-b/.git";
const AT = 1_800_000_000_000;
const TERRAIN_BUILDABLE = new Set(["grass", "scrub", "rubble"]);
const T = (ms) => AT + ms;

const root = (name) => `/tmp/reclaim-23-shared/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

function activity({ sessionId, role = "root", interactive = true, parentSessionId, writerEpoch, events }) {
  return {
    schema: 1,
    cli: "omp",
    cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true },
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
// 開城後的前十四份：第一份付民居，工地尚未完工，不影響毛產。
const times = (n) => perUnit.map((amount, i) => stock({ resources: START_RESOURCES })[i] + amount * n - (n ? [20, 10, 6][i] : 0));

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
    expect(city.queue[0]).toMatchObject({ building: "house", auto: true, startedUnit: 1 });
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
    // 共用城市沒有「遠征格」：切對話不會多工地，帳本狀態與公開模型都沒有格子。
    expect((await many.state()).tiles).toBeUndefined();
    expect((await one.state()).tiles).toBeUndefined();
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
    expect(stock(await cityAt(dir))).toEqual(times(0));
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

  test("同一來源的用量被修正：以最後一份快照為準，缺欄位的早期快照不會讓整回合落空", async () => {
    const dir = root("correction");
    const ledger = await sharedLedger(dir);
    const key = { sessionId: "claude", sourceKey: "anthropic#msg-1" };
    const corrected = activity({
      sessionId: "claude",
      events: round(REPO_A, T(0), T(60_000), [
        usageEvent(T(1_000), "msg-1", { inputNonCache: 100, unknownFields: ["output"] }, { ...key, provider: "anthropic" }),
        usageEvent(T(2_000), "msg-1", TEN_K, { ...key, provider: "anthropic" }),
      ]),
    });
    await settle(ledger, [corrected]);
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 重播同一份紀錄不再入帳；最後一份快照仍是未知時，整回合仍不結算。
    await settle(await sharedLedger(dir), [corrected]);
    expect(stock(await cityAt(dir))).toEqual(times(1));
    const stillUnknown = activity({
      sessionId: "claude2",
      events: round(REPO_A, T(100_000), T(160_000), [
        usageEvent(T(101_000), "msg-2", TEN_K, { sessionId: "claude2", sourceKey: "anthropic#msg-2", provider: "anthropic" }),
        usageEvent(T(102_000), "msg-2", { ...TEN_K, unknownFields: ["output"] }, { sessionId: "claude2", sourceKey: "anthropic#msg-2", provider: "anthropic" }),
      ]),
    });
    await settle(await sharedLedger(dir), [stillUnknown]);
    expect(stock(await cityAt(dir))).toEqual(times(1));
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

  test("共用帳本不建立、也不讀寫 `cities/`：磁碟上既有的舊帳本原封不動，新資料只進新帳本", async () => {
    const dir = root("legacy-untouched");
    // 使用者磁碟上可能留著舊版各 repo 城的帳本：程式不再讀它，也不該刪它。
    const legacyFile = `${dir}/cities/deadbeef/head.json`;
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, "keep me\n");
    const before = fs.readFileSync(legacyFile, "utf8");

    const work = [activity({ sessionId: "old", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "o1", TEN_K, { sessionId: "old" })]) })];
    const shared = await sharedLedger(dir);
    await settle(shared, work);
    expect(stock(await cityAt(dir))).toEqual(times(1));
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(before);
    expect(fs.readdirSync(`${dir}/cities`)).toEqual(["deadbeef"]);
    expect(fs.existsSync(sharedCityDir(dir))).toBe(true);
  });
});

// 建設佇列（#25、ADR 0003）：固定地圖（core/city-map.js 的起始揭開區）＋玩家操作寫進實際
// 隔離帳本，再從公開的共用城市讀取模型核對合法位置、整棟預覽、預扣與佇列；不測私有欄位。
const at = (x, y) => ({ x, y });
const keysOf = (cells) => cells.map((cell) => `${cell.x},${cell.y}`).sort();
const problemsOf = (preview) => preview.cells.map((cell) => cell.problem).filter(Boolean);

/** 每一筆下令都像玩家在某個視窗按下「預定這裡」：帶自己的時間。 */
let clock = 0;
const order = (ledger, building, { x, y }) => placePlan(ledger, { building, x, y, at: T(900_000 + ++clock) });
/** 一支只做研究的 session：在 `repo` 連續 n 個回合，每回合正好一單位工作，沒有 commit。 */
const research = (sessionId, repo, n, from) => activity({
  sessionId,
  events: Array.from({ length: n }, (_, i) => round(repo, from + i * 100_000, from + i * 100_000 + 60_000,
    [usageEvent(from + i * 100_000 + 1_000, `${sessionId}-${i}`, TEN_K, { sessionId })])).flat(),
});
/** 同一回合可帶多份或不足一份，用來測試整筆入帳的交易邊界。 */
const workload = (id, tokens) => activity({ sessionId: id, events: round(REPO_A, T(0), T(60_000), [
  usageEvent(T(1_000), id, { output: tokens }, { sessionId: id }),
]) });
// 手動施工、維護與產量的固定情境沒有沿線土地，以隔離手動操作，不更換規則版本。
const emptyStart = (ledger) => ledger.submit(() => ({
  opId: `work-start:${ledger.cityId}`, kind: "workStart", cityId: ledger.cityId, at: T(0),
  terrainVersion: 1, roadArmLength: 0, resources: { wood: 0, stone: 0, iron: 0 },
}));
const fund = async (ledger, units, from = T(0)) => {
  await emptyStart(ledger);
  return settle(ledger, [research(`fund-${units}-${from}`, REPO_A, units, from)]);
};

/**
 * 會在 journal 寫入前互相等待的兩個 IO：兩個視窗讀到同一份狀態才各自寫，真的撞在一起。
 * 另一邊沒有跟上時最多等 2 秒就放行（回歸時是「競爭沒成立」的失敗，不是整個測試卡住）。
 */
function racingIos() {
  let armed = false;
  let waiting = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const beforeWrite = async (file) => {
    if (!armed || !file.includes("/journal/")) return;
    waiting += 1;
    if (waiting === 2) { armed = false; release(); }
    await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  };
  return { ios: [createFileIo({ beforeWrite }), createFileIo({ beforeWrite })], arm: () => { armed = true; } };
}

describe("選址與預定佇列（#25、ADR 0003）", () => {
  test("起始揭開區可以隔一格蓋市場；不同占地的建築各有自己的合法位置；過往工作不影響選址", async () => {
    const dir = root("start-area");
    const ledger = await sharedLedger(dir);
    await settle(ledger, []); // 先開城，後續對照的是同一版本與種子的土地。
    const fresh = readSharedCity(await ledger.state()).city;

    // 城鎮中心是 (-1..1, -1..1)；市場 2×2 放在 (3..4, 1..2)，中間隔著 x = 2 那一行空地。
    expect(CITY_BUILDINGS.market.footprint).toEqual({ w: 2, h: 2 });
    expect(keysOf(legalSites(fresh, "market"))).toContain("3,1");
    const market = siteCheck(fresh, "market", at(3, 1));
    expect(market.ok).toBe(true);
    expect(keysOf(market.cells)).toEqual(["3,1", "3,2", "4,1", "4,2"]);

    // 2×1 的民居能貼著南邊界；2×2 的市場會伸進迷霧。
    const houses = keysOf(legalSites(fresh, "house"));
    const markets = keysOf(legalSites(fresh, "market"));
    expect(houses).toContain("2,4");
    expect(markets).not.toContain("2,4");
    expect(houses.length).toBeGreaterThan(markets.length);
    // 每一個合法位置的整棟占地都在已揭開的土地上。
    const revealed = revealedCells(fresh);
    for (const site of legalSites(fresh, "market")) {
      expect(siteCheck(fresh, "market", site).cells.every((cell) => revealed.has(`${cell.x},${cell.y}`))).toBe(true);
    }
    // 進帳只改動自動工地的占地；既有地圖不因工作來源改變。
    await settle(ledger, [
      activity({ sessionId: "a", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "a1", TEN_K, { sessionId: "a" })]) }),
      activity({ sessionId: "b", events: round(REPO_B, T(70_000), T(90_000), [usageEvent(T(71_000), "b1", TEN_K, { sessionId: "b" })]) }),
    ]);
    const worked = await cityAt(dir);
    expect(stock(worked)).toEqual(times(2));
    expect(worked.queue[0]).toMatchObject({ building: "house", auto: true });
    for (const type of ["market", "house"]) {
      const expected = legalSites(fresh, type).filter(site => !footprintCells(type, site).some(c =>
        worked.queue[0].cells.some(p => p.x === c.x && p.y === c.y)));
      expect(legalSites(worked, type)).toEqual(expected);
    }
  });

  test("整棟占地落在草地、疏林、碎石就合法；一角碰到深水、峭壁、迷霧、城鎮中心或佇列中的預定地整棟都不能放", async () => {
    const dir = root("footprint");
    const ledger = await sharedLedger(dir);
    const city = readSharedCity(await ledger.state()).city;

    // 疏林與碎石混合的 2×2：跟草地一樣合法。
    const mixed = siteCheck(city, "library", at(1, -3));
    expect(new Set(mixed.cells.map((cell) => cell.terrain))).toEqual(new Set(["scrub", "rubble"]));
    expect(mixed.ok).toBe(true);

    // 碰到任何一角不合法，整棟都不能放。空帳本也一樣擋在選址這一關（選址先於付款）。
    const corners = [
      [at(-2, -3), "water"],
      [at(3, -2), "cliff"],
      [at(4, 3), "fog"],
      [at(-2, -2), "center"],
    ];
    for (const [anchor, problem] of corners) {
      const preview = siteCheck(city, "library", anchor);
      expect(preview.ok).toBe(false);
      expect(problemsOf(preview)).toEqual(problem === "fog" ? ["fog", "fog"] : [problem]);
      // 迷霧裡的地形還沒揭開：預覽不洩漏它是什麼地。
      if (problem === "fog") expect(preview.cells.find((cell) => cell.problem === "fog").terrain).toBeNull();
      const result = await order(ledger, "library", anchor);
      expect(result.status).toBe("rejected");
      expect(result.reason).toBe(`site_${problem}`);
    }
    expect((await cityAt(dir)).queue).toEqual([]); // 被拒的下令不留任何占地

    // 佇列裡的第一項占著它的地：碰到它一角的第二項整筆被拒（`site_plan`，不是「已經有目標」）。
    // 空帳本也能先佔位：指定位置不動庫存，排到隊首才付料。
    expect((await order(ledger, "market", at(3, 1))).status).toBe("applied");
    const planned = await cityAt(dir);
    expect(problemsOf(siteCheck(planned, "house", at(2, 1)))).toEqual(["plan"]);
    expect(problemsOf(siteCheck(planned, "library", at(2, 2)))).toEqual(["plan"]);
    expect(await order(ledger, "house", at(2, 1))).toMatchObject({ status: "rejected", reason: "site_plan" });
    expect(keysOf(legalSites(planned, "house"))).not.toContain("2,1");
  });

  test("預覽與實際下令一致：預覽合法的位置下令會被接受，不合法的位置在第一關就被擋下", async () => {
    for (const building of Object.keys(CITY_BUILDINGS)) {
      const dir = root(`agree-${building}`);
      const ledger = await sharedLedger(dir);
      const city = readSharedCity(await ledger.state()).city;
      const legal = new Set(keysOf(legalSites(city, building)));
      expect(legal.size).toBeGreaterThan(0);
      for (let x = -5; x <= 6; x++) {
        for (let y = -5; y <= 6; y++) {
          const preview = siteCheck(city, building, at(x, y));
          expect(preview.ok).toBe(legal.has(`${x},${y}`));
          if (preview.ok) continue; // 合法的位置另外用乾淨的帳本驗（一次只能排 3 項）
          const result = await order(ledger, building, at(x, y));
          expect(result.status).toBe("rejected");
          expect(result.reason).toBe(`site_${problemsOf(preview)[0]}`);
        }
      }
      expect((await cityAt(dir)).queue).toEqual([]); // 被拒的下令不留任何占地
      // 合法的每一處都真的進得了佇列，而且就是預覽的那整片占地。
      for (const key of legal) {
        const [x, y] = key.split(",").map(Number);
        const acceptDir = root(`accept-${building}`);
        expect((await order(await sharedLedger(acceptDir), building, at(x, y))).status).toBe("applied");
        const plan = (await cityAt(acceptDir)).queue[0];
        expect(keysOf(plan.cells)).toEqual(keysOf(siteCheck(city, building, at(x, y)).cells));
      }
    }
  });

  test("缺料時先指定位置：整片占地保留、庫存不預扣；材料到齊才付料開工，取消不扣任何東西", async () => {
    const dir = root("short-of-stock");
    const ledger = await sharedLedger(dir);
    await fund(ledger, 1);
    const before = await cityAt(dir);
    expect(stock(before)).toEqual(perUnit);
    const costs = CITY_BUILDINGS.library.costs;
    expect(Object.entries(costs).some(([key, need]) => before.resources[key] < need)).toBe(true);

    expect((await order(ledger, "library", at(-2, 2))).status).toBe("applied");
    const reserved = await cityAt(dir);
    expect(stock(reserved)).toEqual(perUnit); // 指定位置不動庫存
    expect(reserved.queue[0]).toMatchObject({
      building: "library", label: CITY_BUILDINGS.library.label, x: -2, y: 2, costs, stage: "queued",
    });
    expect(reserved.queue[0].paid).not.toBe(true);
    expect(keysOf(reserved.queue[0].cells)).toEqual(["-1,2", "-1,3", "-2,2", "-2,3"]);
    // 還缺多少：配方減掉現在的庫存（不會是負數）。
    expect(reserved.queue[0].missing).toEqual(Object.fromEntries(Object.entries(costs)
      .map(([key, need]) => [key, Math.max(0, need - reserved.resources[key])])
      .filter(([, amount]) => amount > 0)));

    // 取消：那一項還沒付料，庫存原封不動，占地交還。
    expect((await cancelPlan(ledger, reserved.queue[0])).status).toBe("applied");
    const cancelled = await cityAt(dir);
    expect(cancelled.queue).toEqual([]);
    expect(stock(cancelled)).toEqual(perUnit);
    expect(siteCheck(cancelled, "library", at(-2, 2)).ok).toBe(true);

    // 之後的工作照常進倉庫，不被任何預定地吃掉；排到隊首、材料備齊才一次付清。
    expect((await order(ledger, "library", at(-2, 2))).status).toBe("applied");
    await fund(ledger, 19, T(1_000_000));
    const started = await cityAt(dir);
    expect(started.queue[0]).toMatchObject({ stage: "building", paid: true });
    expect(stock(started)).toEqual([20, 0, 15]); // 20 份毛產減書庫 20/20/5

    // 另一個 space（另一個帳本實例）、重開、做 checkpoint 之後：同一個項目、同一片占地。
    const otherSpace = await cityAt(dir);
    expect(otherSpace.queue).toEqual(started.queue);
    const reopened = await sharedLedger(dir);
    await reopened.checkpoint();
    const afterCheckpoint = await cityAt(dir);
    expect(afterCheckpoint.queue).toEqual(otherSpace.queue);
    expect(stock(afterCheckpoint)).toEqual([20, 0, 15]);
    expect(siteCheck(afterCheckpoint, "house", at(-1, 3)).ok).toBe(false);
  });

  test("兩個視窗同時送出：重疊的位置最多一個生效；分開的位置兩項都進佇列、各扣一次", async () => {
    const overlapDir = root("race-overlap");
    await fund(await sharedLedger(overlapDir), 20);
    const overlap = racingIos();
    const [windowA, windowB] = await Promise.all(overlap.ios.map((io) => sharedLedger(overlapDir, { io })));
    overlap.arm();
    const overlapped = await Promise.all([
      order(windowA, "market", at(3, 1)),
      order(windowB, "house", at(2, 1)),
    ]);
    expect(overlapped.filter((result) => result.status === "applied")).toHaveLength(1);
    const lost = overlapped.find((result) => result.status !== "applied");
    expect(lost.reason).toBe("site_plan");
    expect(lost.attempts).toBeGreaterThan(1); // 真的撞在一起：輸的那一邊重讀之後才被拒
    const overlapCity = await cityAt(overlapDir);
    expect(overlapCity.queue).toHaveLength(1);
    expect(overlapCity.queue[0].building).toBe(overlapped[0].status === "applied" ? "market" : "house");
    // 輸家沒有留下半片占地。
    expect(siteCheck(overlapCity, "house", at(2, 1)).ok).toBe(false);

    // 分開的位置：兩項都進佇列，庫存各扣一次配方（沒有 lost update）。
    const apartDir = root("race-apart");
    await fund(await sharedLedger(apartDir), 20);
    const apart = racingIos();
    const [first, second] = await Promise.all(apart.ios.map((io) => sharedLedger(apartDir, { io })));
    apart.arm();
    const both = await Promise.all([
      order(first, "market", at(3, 1)),
      order(second, "library", at(-2, 2)),
    ]);
    expect(both.map((result) => result.status)).toEqual(["applied", "applied"]);
    const apartCity = await cityAt(apartDir);
    expect(apartCity.queue.map((item) => item.building).sort()).toEqual(["library", "market"]);
    // 只有排在最前面那一項先付料，第二項等它完工才付。
    expect(apartCity.queue[1].paid).not.toBe(true);
    const paid = apartCity.queue[0].costs;
    expect(stock(apartCity)).toEqual([40 - paid.wood, 20 - paid.stone, 20 - (paid.iron ?? 0)]);
  });

  test("固定地圖的地形：起始區的格子都看得到地形，迷霧外也有確定的地形（重算一樣）", () => {
    expect(terrainAt(at(0, 0))).toBe("grass");
    expect(terrainAt(at(-2, -3))).toBe("water");
    expect(terrainAt(at(4, -2))).toBe("cliff");
    expect(terrainAt(at(1, -3))).toBe("scrub");
    expect(terrainAt(at(2, -2))).toBe("rubble");
    for (const [x, y] of [[12, -7], [-30, 41], [5, 5]]) expect(terrainAt(at(x, y))).toBe(terrainAt(at(x, y)));
  });
});

describe("備料、施工與完工（#26、ADR 0003）", () => {
  test("庫存足夠時下令：同一刻開工，材料才在那一刻付清", async () => {
    const dir = root("direct");
    const ledger = await sharedLedger(dir);
    await fund(ledger, 20);
    expect(stock(await cityAt(dir))).toEqual([40, 20, 20]);

    const orderedAt = T(5_000_000);
    expect((await placePlan(ledger, { building: "library", x: -2, y: 2, at: orderedAt })).status).toBe("applied");
    const city = await cityAt(dir);
    expect(city.queue[0]).toMatchObject({ building: "library", stage: "building", paid: true, startedUnit: 20, remainingUnits: 14 });
    expect(city.queue[0].missing).toEqual({});
    expect(stock(city)).toEqual([20, 0, 15]);
  });

  test("大筆進帳中的備料不算工期", async () => {
    const dir = root("fund-then-build");
    const ledger = await sharedLedger(dir);
    await emptyStart(ledger);
    await order(ledger, "library", at(-2, 2));
    await settle(ledger, [workload("fund", 250_000)]);
    const city = await cityAt(dir);
    // 第二十份石材才夠付配方，只有後五份真的施工。
    expect(city.queue[0]).toMatchObject({ startedUnit: 20, remainingUnits: 9 });
    expect(stock(city)).toEqual([30, 5, 20]);
  });

  test("完工接棒，開工那份不推進", async () => {
    const dir = root("queue-order");
    const ledger = await sharedLedger(dir);
    await fund(ledger, 30);
    const from = T(10_000_000);
    expect((await placePlan(ledger, { building: "house", x: 2, y: 3, at: from })).status).toBe("applied");
    expect((await placePlan(ledger, { building: "market", x: 3, y: 1, at: from + 1 })).status).toBe("applied");
    expect((await placePlan(ledger, { building: "library", x: -2, y: 2, at: from + 2 })).status).toBe("applied");

    const queued = await cityAt(dir);
    expect(queued.queue.map((item) => [item.building, item.stage])).toEqual([
      ["house", "building"], ["market", "queued"], ["library", "queued"],
    ]);
    expect(queued.queue[0].remainingUnits).toBe(14);
    expect(groundAt(queued, at(3, 1))).toBe(terrainAt(at(3, 1)));
    expect(groundAt(queued, at(2, 3))).toBe("site");
    expect(stock(queued)).toEqual([40, 20, 24]); // 只有隊首付料
    await settle(ledger, [workload("first", 140_000)]);
    const next = await cityAt(dir);
    expect(next.queue.map((item) => item.stage)).toEqual(["building", "queued"]);
    expect(next.buildings.map((entry) => entry.building)).toEqual(["house"]);
    expect(next.queue[0]).toMatchObject({ building: "market", startedUnit: 44, remainingUnits: 12 });
    await settle(ledger, [workload("rest", 260_000)]);
    const done = await cityAt(dir);
    expect(done.queue).toEqual([]);
    expect(done.buildings.map((entry) => [entry.building, entry.x, entry.y])).toEqual([
      ["house", 2, 3], ["market", 3, 1], ["library", -2, 2],
    ]);
    expect(stock(done)).toEqual([57, 18, 57]);

    // 重送、重開、再做一次 checkpoint：不會重扣、重蓋。
    const reopened = await sharedLedger(dir);
    await settle(reopened, [workload("rest", 260_000)]);
    await reopened.checkpoint();
    expect(await cityAt(dir)).toEqual(done);
  });

  test("取消還沒開工的一項：不扣任何材料、占地交還；已開工的一項不能取消", async () => {
    const dir = root("cancel");
    const ledger = await sharedLedger(dir);
    await fund(ledger, 20);
    const from = T(10_000_000);
    expect((await placePlan(ledger, { building: "house", x: 2, y: 3, at: from })).status).toBe("applied");
    expect((await placePlan(ledger, { building: "market", x: 3, y: 1, at: from + 1 })).status).toBe("applied");
    const before = await cityAt(dir);
    expect(before.queue.map((item) => item.stage)).toEqual(["building", "queued"]);
    expect(stock(before)).toEqual([20, 10, 14]); // 只有施工中的民居付過料

    const market = before.queue[1];
    expect(market.paid).not.toBe(true);
    expect((await cancelPlan(ledger, market)).status).toBe("applied");
    const after = await cityAt(dir);
    expect(after.queue.map((item) => item.building)).toEqual(["house"]);
    expect(stock(after)).toEqual(stock(before)); // 那一項還沒付料，取消不動庫存
    // 占地交還：同一處可以再預定（新的項目、新的 opId）。
    expect(siteCheck(after, "market", at(3, 1)).ok).toBe(true);
    expect((await order(ledger, "market", at(3, 1))).status).toBe("applied");
    expect((await cityAt(dir)).queue.map((item) => item.building)).toEqual(["house", "market"]);

    // 已經開工的項目不能取消：帳本原樣不動。
    const beforeReject = await cityAt(dir);
    expect(await cancelPlan(ledger, beforeReject.queue[0])).toMatchObject({ status: "rejected", reason: "already_started" });
    expect(await cityAt(dir)).toEqual(beforeReject);
  });

  test("佇列上限：滿了就擋新的預定，完工釋出名額", async () => {
    const dir = root("queue-limit");
    const ledger = await sharedLedger(dir);
    await fund(ledger, 60);
    const from = T(10_000_000);
    const sites = [at(3, 1), at(-2, 2), at(2, 3)];
    for (const [index, site] of sites.entries()) {
      expect((await placePlan(ledger, { building: "market", ...site, at: from + index })).status).toBe("applied");
    }
    const full = await cityAt(dir);
    expect(full.queue).toHaveLength(BUILD_QUEUE_LIMIT);
    expect(await order(ledger, "market", at(-3, -2))).toMatchObject({ status: "rejected", reason: "queue_full" });
    expect((await cityAt(dir)).queue).toHaveLength(BUILD_QUEUE_LIMIT);

    // 最前面那一項完工就釋出一個名額（不必先取消）。
    await settle(ledger, [workload("finish-market", 120_000)]);
    const room = await cityAt(dir);
    expect(room.queue).toHaveLength(BUILD_QUEUE_LIMIT - 1);
    expect((await order(ledger, "market", at(-3, -2))).status).toBe("applied");
    expect((await cityAt(dir)).queue).toHaveLength(BUILD_QUEUE_LIMIT);
  });

  test("雙窗同筆只推一次", async () => {
    const dir = root("race-build");
    const ledger = await sharedLedger(dir);
    await fund(ledger, 20);
    const from = T(10_000_000);
    expect((await placePlan(ledger, { building: "library", x: -2, y: 2, at: from })).status).toBe("applied");
    expect((await placePlan(ledger, { building: "house", x: 2, y: 3, at: from + 1 })).status).toBe("applied");
    const building = await cityAt(dir);
    expect(building.queue.map((item) => item.stage)).toEqual(["building", "queued"]);

    const finishing = racingIos();
    const [windowA, windowB] = await Promise.all(finishing.ios.map((io) => sharedLedger(dir, { io })));
    finishing.arm();
    const work = workload("finish-library", 150_000);
    const results = await Promise.all([windowA, windowB].map((window) => settle(window, [work])));
    expect(results.flatMap((result) => result.results.map((r) => r.status)).sort()).toEqual(["applied", "duplicate"]);
    const after = await cityAt(dir);
    expect(after.queue).toHaveLength(1);
    expect(after.queue[0]).toMatchObject({ building: "house", stage: "building", startedUnit: 34, remainingUnits: 13 });
    expect(after.buildings.map((entry) => entry.building)).toEqual(["library"]);
    expect(stock(after)).toEqual([29, 4, 23]);

    // 重開、重送同樣的推進、再 checkpoint：不再扣料、不再多一棟。
    const reopened = await sharedLedger(dir);
    await settle(reopened, [work]);
    await reopened.checkpoint();
    expect(await cityAt(dir)).toEqual(after);
  });

  test("舊版施工依原本的完工紀錄重播", async () => {
    const dir = root("clock-journal");
    await sharedLedger(dir);
    const path = `${sharedCityDir(dir)}/journal/0.json`;
    const costs = { wood: 20, stone: 10 };
    const plan = "house:4,1:1";
    const append = (journalSeq, op) => fs.appendFileSync(path, JSON.stringify({
      cityId: SHARED_CITY_ID, opId: `old-${journalSeq}`, rulesVersion: 11, journalSeq, ...op,
    }) + "\n");
    append(0, { kind: "workStart", at: 0, resources: { wood: 20, stone: 10 } });
    append(1, { kind: "plan", building: "house", x: 4, y: 1, w: 1, h: 1, at: 1, costs });
    append(2, { kind: "construct", at: 1, plan, buildMs: 180_000, costs });
    append(3, { kind: "income", at: 2, tokens: 200_000, sources: ["old"], resources: { wood: 60, stone: 40, iron: 20 } });
    const running = await cityAt(dir);
    expect(running.buildings).toEqual([]);
    expect(running.queue[0]).toMatchObject({ startedAt: 1, completesAt: 180_001 });
    expect(stock(running)).toEqual([60, 40, 20]);
    append(4, { kind: "complete", at: 180_001, plan, reveal: 2 });
    const done = await cityAt(dir);
    expect(done.queue).toEqual([]);
    expect(done.buildings[0]).toMatchObject({ building: "house", startedAt: 1, completedAt: 180_001, reveal: 2 });
    expect(stock(done)).toEqual(stock(running));
  });

  test("競寫重算餘數，拒絕錯誤匯率", async () => {
    const dir = root("race-fractions");
    const ledger = await sharedLedger(dir);
    await settle(ledger, []);
    await order(ledger, "house", at(3, 1));
    const race = racingIos();
    const windows = await Promise.all(race.ios.map((io) => sharedLedger(dir, { io })));
    race.arm();
    const results = await Promise.all(windows.map((w, i) => settle(w, [workload(`half-${i}`, 5_000)])));
    expect(results.map((r) => r.results[0].status)).toEqual(["applied", "applied"]);
    expect(Math.max(...results.map((r) => r.results[0].attempts))).toBeGreaterThan(1);
    const city = await cityAt(dir);
    expect(city.queue[0].remainingUnits).toBe(13);
    expect(city.work.tokens).toBe(0);
    expect(stock(city)).toEqual([52, 26, 1]);
    const bad = await ledger.submit(() => ({
      kind: "income", opId: "bad", cityId: ledger.cityId, sources: ["bad"], tokens: 10_000,
      resources: { wood: 6, stone: 4, iron: 2 },
    }));
    expect(bad).toMatchObject({ status: "rejected", reason: "rate_mismatch" });
    expect(await cityAt(dir)).toEqual(city);
  });

  test("配方與工期只看建築種類：同一種多格建築放在草地或疏林碎石混合地都一樣；施工中是工地、完工後是建築", async () => {
    // 草地上的書庫。
    const grassDir = root("grass-library");
    const grass = await sharedLedger(grassDir);
    await fund(grass, 20);
    expect(new Set(siteCheck(await cityAt(grassDir), "library", at(-2, 2)).cells.map((cell) => cell.terrain))).toEqual(new Set(["grass"]));
    await placePlan(grass, { building: "library", x: -2, y: 2, at: T(5_000_000) });
    const onGrass = await cityAt(grassDir);

    // 疏林與碎石混合地上的書庫。
    const mixedDir = root("mixed-library");
    const mixed = await sharedLedger(mixedDir);
    const cells = siteCheck(await cityAt(mixedDir), "library", at(1, -3)).cells;
    expect(new Set(cells.map((cell) => cell.terrain))).toEqual(new Set(["scrub", "rubble"]));
    await fund(mixed, 20);
    await placePlan(mixed, { building: "library", x: 1, y: -3, at: T(-1_000) });
    const onMixed = await cityAt(mixedDir);
    expect(onMixed.queue[0].costs).toEqual(onGrass.queue[0].costs);
    expect(onMixed.queue[0].remainingUnits).toBe(onGrass.queue[0].remainingUnits);
    expect(stock(onMixed)).toEqual(stock(onGrass));
    // 施工中：整片占地都是工地，看不到原本的植被或碎石。
    expect(cells.map((cell) => groundAt(onMixed, cell))).toEqual(["site", "site", "site", "site"]);

    await settle(mixed, [workload("finish-library", 140_000)]);
    const built = await cityAt(mixedDir);
    expect(cells.map((cell) => groundAt(built, cell))).toEqual(["building", "building", "building", "building"]);
    // 占地外的地形不受影響。
    expect(groundAt(built, at(3, -3))).toBe(terrainAt(at(3, -3)));
  });

  test("普通建築完工才揭開附近（預定與施工時不揭）；重開後新揭開的合法位置可直接預定，建築本身占著地", async () => {
    const dir = root("reveal");
    const ledger = await sharedLedger(dir);
    const start = new Set(revealedCells(await cityAt(dir)));
    expect(start.has("5,0")).toBe(false); // 民居右邊一格起就是迷霧

    // 民居右側那一格貼著東緣，付清首棟配方後開始施工。
    await fund(ledger, 10);
    expect((await order(ledger, "house", at(3, 1))).status).toBe("applied");
    const building = await cityAt(dir);
    expect(building.queue[0].stage).toBe("building");
    expect(revealedCells(building)).toEqual(start); // 預定與施工都不揭圖

    await settle(ledger, [workload("finish-house", 140_000)]);
    // 重開帳本：完工的民居、揭開的土地都還在。
    const after = await cityAt(dir);
    expect(after.buildings.map((b) => [b.building, b.x, b.y])).toEqual([["house", 3, 1]]);
    const revealed = revealedCells(after);
    const fresh = [...revealed].filter((key) => !start.has(key)).sort();
    // 占地往外兩格：x 5..6、y -1..3 是新揭開的土地（原本就看得到的不重算）。
    expect(fresh).toEqual(["5,-1", "5,3", "5,0", "5,1", "5,2", "6,-1", "6,3", "6,0", "6,1", "6,2"].sort());

    // 建築占著它的地：同一格不能再放。
    const occupied = siteCheck(after, "house", at(3, 1));
    expect(problemsOf(occupied)).toEqual(["building", "building"]);
    expect(await order(ledger, "house", at(3, 1))).toMatchObject({ status: "rejected", reason: "site_building" });

    // 新揭開的土地裡，地形合法的位置不必另外取得建造權，直接預定。
    const newSites = legalSites(after, "house").filter((site) => !start.has(`${site.x},${site.y}`));
    expect(newSites.length).toBeGreaterThan(0);
    for (const site of newSites) expect(TERRAIN_BUILDABLE.has(terrainAt(site))).toBe(true);
    await fund(ledger, 10, T(5_000_000));
    const target = newSites[0];
    expect((await order(ledger, "house", target)).status).toBe("applied");
    expect((await cityAt(dir)).queue[0]).toMatchObject({ building: "house", x: target.x, y: target.y });
  });

  test("舊版帳本（單一 plan、沒有預扣）重播成佇列的第一項：材料齊了才付料開工，舊 checkpoint 丟棄重播", async () => {
    const dir = root("legacy-plan");
    const legacyDir = sharedCityDir(dir);
    fs.mkdirSync(`${legacyDir}/journal`, { recursive: true });
    const plan = {
      journalSeq: 0, opId: "plan:shared:library:-1,2:1", at: 1, kind: "plan", cityId: SHARED_CITY_ID,
      building: "library", x: -2, y: 2, w: 2, h: 2, costs: { wood: 20, stone: 20, iron: 5 }, rulesVersion: 9,
    };
    fs.writeFileSync(`${legacyDir}/head.json`, `${JSON.stringify({ schemaVersion: 2, rulesVersion: 9, cityId: SHARED_CITY_ID, segment: 0, checkpoint: -1 })}\n`);
    fs.writeFileSync(`${legacyDir}/journal/0.json`, `${JSON.stringify(plan)}\n`);

    // 舊 entry 沒有 `paid`：收成佇列的第一項、還沒付料，庫存不動；head 的版本號升到 3。
    const ledger = await sharedLedger(dir);
    expect(JSON.parse(fs.readFileSync(`${legacyDir}/head.json`, "utf8"))).toMatchObject({ schemaVersion: 3, checkpoint: -1 });
    const legacy = await cityAt(dir);
    expect(legacy.queue).toHaveLength(1);
    expect(legacy.queue[0]).toMatchObject({ building: "library", stage: "queued", paid: false });
    expect(stock(legacy)).toEqual([0, 0, 0]);

    // 舊語意保留：哪一筆收入讓庫存足以支付配方，就從那一刻付料開工（含工期）。
    await emptyStart(ledger);
    const from = T(1_000_000);
    await settle(ledger, [research("b", REPO_B, 19, from)]);
    expect((await cityAt(dir)).queue[0].stage).toBe("queued"); // 還缺一份石材
    await settle(ledger, [research("b", REPO_B, 20, from)]);
    const started = await cityAt(dir);
    expect(started.queue[0]).toMatchObject({ stage: "building", paid: true, startedUnit: 20, remainingUnits: 14 });
    expect(stock(started)).toEqual([20, 0, 15]);

    await settle(ledger, [workload("finish-legacy", 140_000)]);
    const done = await cityAt(dir);
    expect(done.queue).toEqual([]);
    expect(done.buildings.map((entry) => [entry.building, entry.completedUnit])).toEqual([["library", 34]]);

    // 舊版 checkpoint（schema 2）不可信：整份丟棄、從 journal 重播，畫面看到的城市不變。
    const manifest = {
      t: "ckpt", schema: 2, rulesVersion: 9, cityId: SHARED_CITY_ID, seq: 0, segment: 0,
      resources: {}, work: {}, plan: null, buildings: null,
      digests: { ops: "0", claims: "0", activities: "0" }, counts: { ops: 0, claims: 0, activities: 0 },
    };
    const manifestText = JSON.stringify(manifest);
    fs.mkdirSync(`${legacyDir}/checkpoints/0`, { recursive: true });
    fs.writeFileSync(`${legacyDir}/checkpoints/0/manifest.json`, manifestText);
    const head = JSON.parse(fs.readFileSync(`${legacyDir}/head.json`, "utf8"));
    fs.writeFileSync(`${legacyDir}/head.json`, `${JSON.stringify({ ...head, checkpoint: 0, checkpointDigest: hashText(manifestText) })}\n`);
    expect(await cityAt(dir)).toEqual(done);
    expect(JSON.parse(fs.readFileSync(`${legacyDir}/head.json`, "utf8")).checkpoint).toBe(-1);
  });
});

// ticket #27：哨站。同樣從相同的起始地圖與同一個邊緣位置出發，在兩座各自隔離的帳本裡分別蓋
// 普通建築與哨站，揭圖結果都從重新打開的帳本經公開讀取模型比較。
describe("哨站揭開較大範圍（#27）", () => {
  /**
   * 在一座新城的東緣走完「缺料預定 → 備料 → 施工 → 完工」，
   * 回傳每個階段重開帳本讀到的城市。
   */
  async function buildAtEdge(name, building) {
    const dir = root(name);
    const ledger = await sharedLedger(dir);
    await emptyStart(ledger);
    const start = await cityAt(dir);
    const site = at(5 - CITY_BUILDINGS[building].footprint.w, 1);
    expect(siteCheck(start, building, site).ok).toBe(true);
    // 缺料也能先預定：整片占地保留、庫存不動，排到隊首、材料備齊才付料開工。
    expect((await order(ledger, building, site)).status).toBe("applied");
    const reserved = await cityAt(dir);
    // 研究一直做到庫存能支付隊首的配方。
    let units = 0;
    let constructing = reserved;
    while (constructing.queue[0].stage !== "building") {
      units += 1;
      await settle(ledger, [research("a", REPO_A, units, T(1_000_000))]);
      constructing = await cityAt(dir);
    }
    await settle(ledger, [workload("edge-build", CITY_BUILDINGS[building].buildUnits * WORK_TOKENS_PER_UNIT)]);
    const done = await cityAt(dir);
    return { dir, ledger, start, reserved, constructing, done, units };
  }

  test("哨站在已揭開的邊緣預定：缺料不扣、備齊才付；預定與施工都不揭圖", async () => {
    const { dir, ledger, start, reserved, constructing, done, units } = await buildAtEdge("outpost-flow", "outpost");
    const startKeys = revealedCells(start);
    // (4, 1) 右邊一格起就是迷霧：這是邊緣位置。
    expect(startKeys.has("5,0")).toBe(false);

    // 預定：整片占地保留給哨站，庫存沒有動，也沒有揭開任何土地。
    expect(reserved.queue[0]).toMatchObject({ building: "outpost", x: 4, y: 1, stage: "queued" });
    expect(reserved.queue[0].missing).toEqual(CITY_BUILDINGS.outpost.costs);
    expect(stock(reserved)).toEqual([0, 0, 0]);
    expect(problemsOf(siteCheck(reserved, "house", at(3, 1)))).toEqual(["plan"]);
    expect(revealedCells(reserved)).toEqual(startKeys);

    // 第十五份石材到齊，付清哨站 25/15/5。
    expect(units).toBe(15);
    expect(constructing.queue[0]).toMatchObject({ stage: "building", paid: true });
    expect(stock(constructing)).toEqual([5, 0, 10]);
    expect(revealedCells(constructing)).toEqual(startKeys);

    // 完工：哨站啟用，土地揭開；重開、重送工作、再推進、checkpoint 都不重扣、不重蓋。
    expect(done.queue).toEqual([]);
    expect(done.buildings.map((b) => [b.building, b.x, b.y])).toEqual([["outpost", 4, 1]]);
    expect(stock(done)).toEqual([13, 4, 14]);
    const reopened = await sharedLedger(dir);
    await settle(reopened, [research("a", REPO_A, units, T(1_000_000))]);
    await reopened.checkpoint();
    expect(await cityAt(dir)).toEqual(done);
    expect(ledger.cityId).toBe(SHARED_CITY_ID);
  });

  test("同一張起始地圖、同一個邊緣位置：哨站完工後永久揭開的土地比普通建築大，且涵蓋普通建築揭開的全部", async () => {
    const house = await buildAtEdge("edge-house", "house");
    const outpost = await buildAtEdge("edge-outpost", "outpost");
    expect(revealedCells(house.start)).toEqual(revealedCells(outpost.start));

    const byHouse = revealedCells(house.done);
    const byOutpost = revealedCells(outpost.done);
    for (const key of byHouse) expect(byOutpost.has(key)).toBe(true);
    expect(byOutpost.size).toBeGreaterThan(byHouse.size);

    // 永久：重開帳本、checkpoint 之後揭開的土地不變。
    await (await sharedLedger(outpost.dir)).checkpoint();
    expect(revealedCells(await cityAt(outpost.dir))).toEqual(byOutpost);
  });

  test("重開城市後，哨站才揭開的合法占地可直接預定下一棟；揭開的深水、峭壁仍不能放，沒有另外取得土地的步驟", async () => {
    const house = await buildAtEdge("next-house", "house");
    const outpost = await buildAtEdge("next-outpost", "outpost");
    const byHouse = revealedCells(house.done);
    const city = await cityAt(outpost.dir);
    const onlyOutpost = [...revealedCells(city)].filter((key) => !byHouse.has(key)).map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    });

    // 不可建的地景：哨站揭開了，但仍是深水或峭壁，整棟都不能放，下令也被拒（選址先於付款）。
    const blocked = onlyOutpost.filter((cell) => !TERRAIN_BUILDABLE.has(terrainAt(cell)));
    expect(blocked.length).toBeGreaterThan(0);
    for (const cell of blocked) {
      expect(siteCheck(city, "house", cell).cells[0].problem).toBe(terrainAt(cell));
      expect(await order(await sharedLedger(outpost.dir), "house", cell)).toMatchObject({ status: "rejected", reason: `site_${terrainAt(cell)}` });
    }

    // 合法的新土地：普通建築揭不到、哨站揭得到；備齊材料之後在重開的城市直接預定。
    const fresh = legalSites(city, "house").filter((site) => !byHouse.has(`${site.x},${site.y}`));
    expect(fresh.length).toBeGreaterThan(0);
    for (const site of fresh) expect(TERRAIN_BUILDABLE.has(terrainAt(site))).toBe(true);
    const reopened = await sharedLedger(outpost.dir);
    await fund(reopened, 10, T(5_000_000));
    const target = fresh[0];
    expect((await order(reopened, "house", target)).status).toBe("applied");
    expect((await cityAt(outpost.dir)).queue[0]).toMatchObject({ building: "house", x: target.x, y: target.y });
  });
});

describe("人口、人力與維護（#35）", () => {
  test("維護只從進帳扣，道路不計且低於上限", async () => {
    for (const roadArmLength of [1, 3]) {
      const dir = root("maintenance");
      const ledger = await sharedLedger(dir);
      await ledger.submit(() => ({ opId: "found", kind: "workStart", cityId: ledger.cityId, at: T(0), roadArmLength, resources: START_RESOURCES }));
      expect((await cityAt(dir)).maintenance).toBe(0);
      await order(ledger, "outpost", at(4, 1));
      await settle(ledger, [workload("finish", 40_000)]);
      const before = await cityAt(dir);
      expect(before.maintenance).toBe(1 / 32);
      await settle(ledger, [], { activateAt: T(7 * 86_400_000) });
      expect(await cityAt(dir)).toEqual(before);
      await settle(ledger, [workload("income", 320_000)]);
      // 第 6 份開始民居，第 20 份完工：32 份有一半按 N=1，一半按 N=2。
      // 看實際入庫，不把同一筆內另付的建築配方算成維護。
      const entries = (await ledger.scanSegments()).flatMap(s => s.entries);
      expect(entries.filter(e => e.kind === "income").at(-1).resources).toEqual({ wood: 61, stone: 30, iron: 30 });
    }
    const buildings = Array.from({ length: 1500 }, () => ({ building: "outpost", cells: [] }));
    expect(readSharedCity({ buildings }).city.maintenance).toBe(50 / 101);
    expect(readSharedCity({ buildings }).city.maintenance).toBeLessThan(0.5);
  });

  test("完工順序分人，民居補足後復工", async () => {
    const dir = root("staff");
    const ledger = await sharedLedger(dir);
    await ledger.submit(() => ({ opId: "found", kind: "workStart", cityId: ledger.cityId, at: AT, roadArmLength: 0, resources: START_RESOURCES }));
    await settle(ledger, [workload("備料", 200_000)]);
    await order(ledger, "market", at(3, 1));
    await order(ledger, "workshop", at(1, -2));
    await order(ledger, "house", at(2, 3));
    await settle(ledger, [workload("finish-jobs", 330_000)]);
    const before = await cityAt(dir);
    expect(before.population).toEqual({ assigned: 2, capacity: 2 });
    expect(before.buildings.map(b => [b.building, b.understaffed])).toEqual([["market", false], ["workshop", true]]);
    await settle(ledger, [workload("finish-house", 140_000)]);
    const after = await cityAt(dir);
    expect(after.population).toEqual({ assigned: 5, capacity: 6 });
    expect(after.buildings.map(b => b.understaffed)).toEqual([false, false, false]);
  });

  test("雙窗跨完工重算，等同依序入帳", async () => {
    const ready = async (dir) => {
      const ledger = await sharedLedger(dir);
      await settle(ledger, []);
      await placePlan(ledger, { building: "house", x: 3, y: 1, at: T(1) });
      await settle(ledger, [workload("build", 130_000)]);
      return ledger;
    };
    const dir = root("parallel"), serialDir = root("serial");
    await ready(dir);
    const serial = await ready(serialDir);
    const race = racingIos();
    const windows = await Promise.all(race.ios.map(io => sharedLedger(dir, { io })));
    const incomes = [workload("a", 10_000), workload("b", 10_000)];
    race.arm();
    const results = await Promise.all(windows.map((window, i) => settle(window, [incomes[i]])));
    expect(results.map(r => r.results[0].status)).toEqual(["applied", "applied"]);
    expect(results.some(r => r.results[0].attempts > 1)).toBe(true);
    for (const income of incomes) await settle(serial, [income]);
    const city = await cityAt(dir);
    expect(city).toEqual(await cityAt(serialDir));
    expect(stock(city)).toEqual([19, 24, 14]); // 村落最缺石，採石場付清 60 木、15 石。
    const entries = (await serial.scanSegments()).flatMap(s => s.entries).filter(e => e.kind === "income");
    expect(entries.slice(-2).map(e => e.resources)).toEqual([{ wood: 2, stone: 1, iron: 1 }, { wood: 1, stone: 0, iron: 0 }]);
  });

  test("長序列保留各材餘數", async () => {
    const dir = root("carry");
    let ledger = await sharedLedger(dir);
    await ledger.submit(() => ({ opId: "found", kind: "workStart", cityId: ledger.cityId, at: AT, roadArmLength: 0, resources: START_RESOURCES }));
    await order(ledger, "house", at(3, 1));
    await order(ledger, "house", at(2, 3));
    const ordered = await cityAt(dir);
    expect(ordered.queue.map(i => i.costs)).toEqual([{ wood: 20, stone: 10, iron: 6 }, { wood: 23, stone: 12, iron: 7 }]);
    await settle(ledger, [workload("finish", 280_000)]);
    const before = await cityAt(dir);
    expect(before.population.capacity).toBe(10);
    // N=2：每 17 份恰收 32/16/16。跨筆、跨 checkpoint 與整數邊界。
    for (let i = 0; i < 100; i++) {
      await settle(ledger, [workload(`chunk-${i}`, (i % 2 ? 35 : 33) * WORK_TOKENS_PER_UNIT)]);
      if (i === 50) { await ledger.checkpoint(); ledger = await sharedLedger(dir); }
    }
    expect(stock(await cityAt(dir))).toEqual(stock(before).map((v, i) => v + [6400, 3200, 3200][i]));
  });

  test("v12 民居與收入照舊重播", async () => {
    const dir = root("v12");
    await sharedLedger(dir);
    const entries = [
      { kind: "workStart", resources: START_RESOURCES, roadArmLength: 3 },
      { kind: "plan", building: "house", w: 1, h: 1, x: 4, y: 1, costs: { wood: 20, stone: 10 } },
      { kind: "income", tokens: 160_000, sources: ["old"], resources: { wood: 48, stone: 32, iron: 16 } },
    ];
    fs.writeFileSync(`${sharedCityDir(dir)}/journal/0.json`, entries.map((op, journalSeq) =>
      JSON.stringify({ ...op, rulesVersion: 12, opId: `v12-${journalSeq}`, cityId: SHARED_CITY_ID, at: AT, journalSeq }) + "\n").join(""));
    const city = await cityAt(dir);
    expect(stock(city)).toEqual([98, 57, 22]);
    expect(city.buildings[0]).toMatchObject({ cells: [at(4, 1)], completedUnit: 14 });
    expect(groundAt(city, at(4, 0))).toBe("road");
  });
});

describe("產出建築（#37）", () => {
  test("地形上限、迷霧、道路與占地", () => {
    const producer = (building, x, y, reveal = 2) => ({
      building, x, y, ...CITY_BUILDINGS[building].footprint, reveal, cells: footprintCells(building, at(x, y)),
    });
    const income = (buildings, extra = {}) => workYieldOf({
      ...emptyState("fixture"), terrainVersion: 1, buildings, ...extra,
    }, WORK_TOKENS_PER_UNIT);
    // 一份扣維護後取整。四格疏林只加三；兩格被預定後只剩兩格。
    const mill = producer("lumberyard", 2, -3);
    expect(income([mill]).wood).toBe(5);
    const reserved = producer("house", 1, -4);
    const queued = [reserved, producer("outpost", 1, -2)].map(p => ({ ...p, costs: CITY_BUILDINGS[p.building].costs }));
    expect(income([mill], { queue: queued }).wood).toBe(4);
    expect(income([mill, ...queued]).wood).toBe(4);

    expect(income([producer("quarry", 1, -9)]).stone).toBe(4); // 四格碎石，上限三格
    // (-9) 區不在初始範圍。只揭占地、外圈仍在迷霧時只產基本石材。
    expect(income([producer("quarry", 1, -9, 0)]).stone).toBe(1);
    const pit = producer("quarry", 1, -4);
    expect(income([pit], { roadArmLength: 1 }).stone).toBe(3);
    expect(income([pit], { roadArmLength: 3 }).stone).toBe(2); // (0,-4) 的碎石變成道路
    const forge = producer("workshop", 3, -3); // 碎石兩格、峭壁一格
    expect(income([producer("house", 2, 3), forge]).iron).toBe(3);
  });

  test("共用格歸先完工者", async () => {
    for (const quarryFirst of [true, false]) {
      const ledger = await sharedLedger(root("first-producer"));
      await emptyStart(ledger);
      await settle(ledger, [workload("stock", 2_000_000)]);
      const plans = [["quarry", at(1, -4)], ["workshop", at(3, -3)]];
      if (!quarryFirst) plans.reverse();
      for (const [type, site] of [["house", at(2, 3)], ...plans]) {
        expect((await order(ledger, type, site)).status).toBe("applied");
      }
      await settle(ledger, [workload("finish", 530_000)]);
      const before = stock(readSharedCity(await ledger.state()).city);
      await settle(ledger, [workload("produce", 120_000)]);
      const after = stock(readSharedCity(await ledger.state()).city);
      // 兩產場共用 (2,-2) 的碎石；12 份恰留下 11 份毛產。
      expect(after.map((v, i) => v - before[i])).toEqual(quarryFirst ? [22, 44, 33] : [22, 33, 44]);
    }
  });

  test("缺人停產，補人復工", async () => {
    const ledger = await sharedLedger(root("idle-forge"));
    await emptyStart(ledger);
    await settle(ledger, [workload("stock", 1_000_000)]);
    await order(ledger, "workshop", at(3, -3));
    await settle(ledger, [workload("finish", 210_000)]);
    const iron = async () => (await ledger.state()).resources.iron;
    const before = await iron();
    await settle(ledger, [workload("idle", 320_000)]);
    expect(await iron() - before).toBe(31); // 只有城鎮中心
    await order(ledger, "house", at(2, 3));
    await settle(ledger, [workload("house", 140_000)]);
    const staffed = await iron();
    await settle(ledger, [workload("resume", 170_000)]);
    expect(await iron() - staffed).toBe(64);
  });

  test("雙窗跨產場完工與重播", async () => {
    const dir = root("production-race");
    const ledger = await sharedLedger(dir);
    await ledger.submit(() => ({ kind: "workStart", opId: "found", at: AT, cityId: ledger.cityId,
      terrainVersion: 1, roadArmLength: 1, resources: START_RESOURCES }));
    await order(ledger, "quarry", at(1, -4));
    await settle(ledger, [workload("build", 170_000)]);
    const race = racingIos();
    const windows = await Promise.all(race.ios.map(io => sharedLedger(dir, { io })));
    race.arm();
    const results = await Promise.all(windows.map((w, i) => settle(w, [workload(`race-${i}`, 10_000)])));
    expect(results.map(r => r.results[0].status)).toEqual(["applied", "applied"]);
    expect(results.some(r => r.results[0].attempts > 1)).toBe(true);
    const live = readSharedCity(await windows[0].state()).city;
    expect(stock(live)).toEqual([27, 31, 18]); // 採石場完工後，民居接著付料。
    expect(await cityAt(dir)).toEqual(live);
  });

  test("v13 工坊不回補，只從新版進帳產鐵", async () => {
    const dir = root("old-forge");
    await sharedLedger(dir);
    const entries = [
      { kind: "workStart", terrainVersion: 1, roadArmLength: 1, resources: { wood: 200, stone: 100, iron: 20 } },
      { kind: "plan", building: "house", x: 2, y: 3, w: 2, h: 1, costs: { wood: 20, stone: 10, iron: 6 } },
      { kind: "income", tokens: 140_000, resources: { wood: 28, stone: 14, iron: 14 } },
      { kind: "plan", building: "workshop", x: 3, y: -3, w: 2, h: 1, costs: { wood: 30, iron: 5 } },
      { kind: "income", tokens: 210_000, resources: { wood: 40, stone: 20, iron: 20 } },
      { kind: "income", tokens: 170_000, resources: { wood: 32, stone: 16, iron: 16 } },
    ];
    fs.writeFileSync(`${sharedCityDir(dir)}/journal/0.json`, entries.map((op, journalSeq) =>
      JSON.stringify({ ...op, sources: [`old-${journalSeq}`], rulesVersion: 13, opId: `old-${journalSeq}`,
        cityId: SHARED_CITY_ID, at: AT, journalSeq }) + "\n").join(""));
    expect(stock(await cityAt(dir))).toEqual([250, 140, 59]);
    await settle(await sharedLedger(dir, { rulesVersion: 14 }), [workload("upgraded", 170_000)]);
    expect(stock(await cityAt(dir))).toEqual([282, 156, 123]);
  });

  test("手動預定採同種棟次配方", async () => {
    for (const [type, first, second] of [
      ["lumberyard", [50, 25], [58, 29]], ["quarry", [60, 15], [69, 18]], ["workshop", [60, 30], [69, 35]],
    ]) {
      const dir = root(type), ledger = await sharedLedger(dir);
      await emptyStart(ledger);
      for (const site of [at(3, 1), at(-3, 2)]) expect((await order(ledger, type, site)).status).toBe("applied");
      expect((await cityAt(dir)).queue.map(p => p.costs)).toEqual([first, second].map(([wood, stone]) => ({ wood, stone })));
    }
  });
});
