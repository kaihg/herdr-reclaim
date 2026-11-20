// ticket #8 的加速、市集與蓋房（proposal §7.6、§8.1、§10、§11、§17.1 情境 6、7）。
// 固定事件重播 → 公開城鎮讀取模型；斷言庫存、格子與操作結果，不碰私有欄位。
import { describe, expect, test } from "bun:test";
import { commitContexts, ingestCommits } from "../core/commit-evidence.js";
import { CityLedger } from "../core/ledger.js";
import { ingestScenario, processBoost, processBuild, processLand, processTrade, redispatch } from "../core/ingest.js";
import { RECIPES, RULES_VERSION } from "../core/rules.js";
import { readTownFromLedger, selectionDetail } from "../core/town.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/reclaim-8-economy/.git";
const OTHER = "/tmp/reclaim-8-economy-other/.git";
const CHECKOUT = "/tmp/reclaim-8-economy";
const AT = 1_800_000_000_000;
const T = (ms) => AT + ms;
const MINUTE = 60_000;
const ROOT = "sess-econ-1";

let seed = 0;
const dir = (name) => `/tmp/reclaim-8-economy/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

/** 一支互動 root 在城裡工作 `minutes` 分鐘；格子由 BFS 自動選地（§4）。 */
function workingActivity(sessionId, minutes, cityId = CITY) {
  const events = [
    { kind: "visit_start", at: T(0), visit: { visitId: `v-${sessionId}`, cwd: CHECKOUT, commonDir: cityId, checkout: CHECKOUT } },
    { kind: "interval_open", at: T(0) },
    { kind: "heartbeat", at: T(minutes * MINUTE) },
    { kind: "interval_close", at: T(minutes * MINUTE) },
  ];
  return {
    schema: 1,
    cli: "omp",
    cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
    sessionId,
    role: "root",
    interactive: true,
    writerEpoch: `${sessionId}-1`,
    events: events.map((event, index) => ({ eventSeq: index + 1, ...event })),
    updatedAt: T(minutes * MINUTE),
  };
}

async function open(name, cityId = CITY) {
  return new CityLedger({ io: createFileIo(), dir: dir(name), cityId }).open();
}

/** 一座城、一支遠征，工作 `minutes` 分鐘。 */
async function townWith(name, minutes, cityId = CITY) {
  const ledger = await open(name, cityId);
  await ingestScenario(ledger, { activities: [workingActivity(ROOT, minutes, cityId)] }, cityId);
  return ledger;
}

/** 用一筆收成把資源放進庫存（測試的固定情境；點數 0，不算 commit 收成）。 */
async function credit(ledger, resources, rootSessionId = ROOT) {
  const state = await ledger.state();
  const tile = state.tiles.find((candidate) => candidate.rootSessionId === rootSessionId);
  return ledger.submit(() => ({
    opId: `harvest:seed-${++seed}`,
    kind: "harvest",
    at: Number(tile.activatedAt) + 1_000,
    cityId: ledger.cityId,
    rootSessionId,
    generation: tile.generation,
    claims: [`seed-claim-${seed}`],
    paths: [],
    points: 0,
    resources,
  }));
}

async function townOf(ledger, cityId = CITY) {
  const state = await ledger.state();
  return readTownFromLedger({
    activities: [...state.activities.values()],
    expeditions: state.tiles,
    resources: { [cityId]: state.resources },
    research: { [cityId]: state.research },
    market: { [cityId]: state.market },
  });
}

const detailOf = async (ledger, rootSessionId = ROOT, cityId = CITY) =>
  selectionDetail(await townOf(ledger, cityId), { kind: "expedition", cityId, rootSessionId, generation: 1 });

describe("加速（§7.6、§17.1 情境 6）", () => {
  test("每張羊皮卷 +10 點：5 點的格子用 3 張變 35；95 點用 1 張完成開墾且超出不退", async () => {
    const low = await townWith("boost-low", 5);
    await credit(low, { parchment: 3 });
    const applied = await processBoost(low, { rootSessionId: ROOT, generation: 1, scrolls: 3, at: T(600_000) });
    expect(applied.status).toBe("applied");
    let tile = await detailOf(low);
    expect([tile.points, tile.boost.pointsPerScroll]).toEqual([35, 10]);
    let city = await townOf(low);
    expect(city.cities[0].resources.parchment).toBe(0);

    const high = await townWith("boost-high", 95);
    await credit(high, { parchment: 1 });
    expect((await processBoost(high, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(600_000) })).status).toBe("applied");
    city = await townOf(high);
    tile = city.cities[0].tiles[0];
    expect([tile.points, tile.landStage, city.cities[0].resources.parchment]).toEqual([105, "cleared", 0]); // 超過 100 不退
  });

  test("目標不符時整筆拒絕、不扣卷：已撤回、已封存、舊 generation、別的城、已滿 100 點", async () => {
    // 已撤回：座標釋放，撤回後的加速不成立。
    const withdrawn = await townWith("boost-withdrawn", 5);
    await credit(withdrawn, { parchment: 2 });
    await processLand(withdrawn, { rootSessionId: ROOT, generation: 1, action: "withdraw", at: T(600_000) });
    const rejected = await processBoost(withdrawn, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(700_000) });
    expect(rejected.status).toBe("rejected");
    expect((await townOf(withdrawn)).cities[0].resources.parchment).toBe(2);

    // 舊 generation：重新派遣之後只有第 2 代是現役。
    await processBoost(withdrawn, { rootSessionId: ROOT, generation: 1, scrolls: 0, at: T(700_000) });
    await redispatch(withdrawn, { rootSessionId: ROOT, at: T(800_000) });
    const stale = await processBoost(withdrawn, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(900_000) });
    expect(stale).toMatchObject({ status: "rejected", reason: "stale_generation" });
    expect((await townOf(withdrawn)).cities[0].resources.parchment).toBe(2);

    // 已封存。
    const archived = await townWith("boost-archived", 100);
    await credit(archived, { parchment: 1 });
    expect((await processLand(archived, { rootSessionId: ROOT, generation: 1, action: "archive", at: T(7_000_000) })).status).toBe("applied");
    const noArchive = await processBoost(archived, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(7_100_000) });
    expect(noArchive.status).toBe("rejected");
    expect((await townOf(archived)).cities[0].resources.parchment).toBe(1);

    // 已滿 100 點（自然工作就滿了）。
    const full = await townWith("boost-full", 100);
    await credit(full, { parchment: 1 });
    const noFull = await processBoost(full, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(7_000_000) });
    expect(noFull).toMatchObject({ status: "rejected", reason: "already_cleared" });
    expect((await townOf(full)).cities[0].resources.parchment).toBe(1);

    // 別的城：這座城的帳本裡沒有這支遠征的那一代。
    const here = await townWith("boost-other-city", 5);
    await credit(here, { parchment: 1 });
    const foreign = await processBoost(here, { rootSessionId: "sess-in-another-city", generation: 1, scrolls: 1, at: T(700_000) });
    expect(foreign).toMatchObject({ status: "rejected", reason: "stale_generation" });
    expect((await townOf(here)).cities[0].resources.parchment).toBe(1);
  });
});

describe("市集（§7.6、§11）", () => {
  test("同城任兩種資源 3 換 1；庫存不足時整筆不執行，不會有部分交易", async () => {
    const ledger = await townWith("trade", 5);
    await credit(ledger, { parchment: 3, wood: 2 });
    const traded = await processTrade(ledger, { from: "parchment", to: "wood", amount: 1, at: T(600_000) });
    expect(traded.status).toBe("applied");
    let city = (await townOf(ledger)).cities[0];
    expect({ ...city.resources }).toEqual({ wood: 3, stone: 0, iron: 0, parchment: 0 });
    expect(city.market.in.wood).toBe(1); // 市集轉入與 commit 直接發放分開記錄
    expect(city.market.out.parchment).toBe(3);
    // 從 0 的庫存換不出東西；從 3 想換 2 份需要 6，也整筆拒絕（不會先扣 3 再補）。
    const short = await processTrade(ledger, { from: "iron", to: "stone", amount: 1, at: T(700_000) });
    expect(short).toMatchObject({ status: "rejected", reason: "insufficient_resources" });
    const partial = await processTrade(ledger, { from: "wood", to: "stone", amount: 2, at: T(750_000) });
    expect(partial).toMatchObject({ status: "rejected", reason: "insufficient_resources" });
    city = (await townOf(ledger)).cities[0];
    expect({ ...city.resources }).toEqual({ wood: 3, stone: 0, iron: 0, parchment: 0 }); // 整筆不執行

    const invalid = await processTrade(ledger, { from: "wood", to: "wood", amount: 1, at: T(800_000) });
    expect(invalid).toMatchObject({ status: "rejected", reason: "invalid_trade" });
  });
});

describe("蓋房（§7.6、§8.1、§17.1 情境 7）", () => {
  test("只列庫存足夠的配方；一次扣完整份、保存規則版本與實付資源；已建不能再蓋", async () => {
    const ledger = await townWith("build", 100);
    await credit(ledger, { wood: 30, stone: 10, iron: 5 });
    let detail = await detailOf(ledger);
    expect(detail.buildable.map((recipe) => recipe.name).sort()).toEqual(["house", "workshop"]); // 圖書館、倉庫、城牆不足

    const built = await processBuild(ledger, { rootSessionId: ROOT, generation: 1, recipe: "house", at: T(7_000_000) });
    expect(built.status).toBe("applied");
    let city = (await townOf(ledger)).cities[0];
    expect({ ...city.resources }).toEqual({ wood: 10, stone: 0, iron: 5, parchment: 0 });
    expect(city.tiles[0].landStage).toBe("built");
    expect(city.tiles[0].building).toEqual({ recipe: "house", costs: { wood: 20, stone: 10 }, rulesVersion: RULES_VERSION });
    const entries = (await ledger.scanSegments()).flatMap((segment) => segment.entries);
    const buildEntry = entries.find((entry) => entry.kind === "build");
    expect([buildEntry.recipe, buildEntry.costs, buildEntry.rulesVersion]).toEqual(["house", { wood: 20, stone: 10 }, RULES_VERSION]);

    const again = await processBuild(ledger, { rootSessionId: ROOT, generation: 1, recipe: "house", at: T(7_100_000) });
    expect(again).toMatchObject({ status: "rejected", reason: "already_built" });
    city = (await townOf(ledger)).cities[0];
    expect({ ...city.resources }).toEqual({ wood: 10, stone: 0, iron: 5, parchment: 0 }); // 沒有再扣一次
    expect((await detailOf(ledger)).buildable).toEqual([]); // 剩下的木材連民居都不夠，畫面沒有可蓋的
  });

  test("配方由規則表決定：不存在的配方與不符的實付資源都拒絕", async () => {
    const ledger = await townWith("build-guard", 100);
    await credit(ledger, { wood: 40, stone: 40, iron: 10 });
    expect((await processBuild(ledger, { rootSessionId: ROOT, generation: 1, recipe: "castle", at: T(7_000_000) })))
      .toMatchObject({ status: "rejected", reason: "unknown_recipe" });
    const tampered = await ledger.submit(() => ({
      opId: "build:tampered",
      kind: "build",
      at: T(7_100_000),
      cityId: CITY,
      rootSessionId: ROOT,
      generation: 1,
      recipe: "wall",
      costs: { stone: 1 },
    }));
    expect(tampered).toMatchObject({ status: "rejected", reason: "recipe_mismatch" });
    expect((await townOf(ledger)).cities[0].resources.stone).toBe(40);
  });

  test("已建的格子 resume 後又有新的 commit：建築保留、收成照常", async () => {
    const ledger = await townWith("build-harvest", 100);
    await credit(ledger, { wood: 20, stone: 10 });
    expect((await processBuild(ledger, { rootSessionId: ROOT, generation: 1, recipe: "house", at: T(7_000_000) })).status).toBe("applied");

    const sha = "9".repeat(40);
    const hooks = [{ schema: 1, sha, hook: "post-commit", commonDir: CITY, toplevel: CHECKOUT, at: T(7_200_000), env: { PI_SESSION_ID: ROOT } }];
    const activities = [...(await ledger.state()).activities.values()];
    await ingestCommits({
      ledger,
      hooks,
      sources: [],
      activities,
      diffForCommit: async () => [{ status: "A", path: "src/app.js", resultBlob: "blob-app" }],
    });
    const city = (await townOf(ledger)).cities[0];
    const tile = city.tiles[0];
    expect([tile.landStage, tile.harvestPoints, tile.building.recipe]).toEqual(["built", 20, "house"]);
    expect(city.resources.wood).toBe(10); // 新 commit 的木材照常發
  });
});

describe("兩個畫面競爭同一筆操作（CAS）", () => {
  test("加速只有一筆成功：庫存一張、兩個畫面同時送出", async () => {
    const ledger = await townWith("race-boost", 5);
    await credit(ledger, { parchment: 1 });
    const paneA = await open("race-boost", CITY) && null; // 佔位：下面的兩個畫面共用同一個帳本目錄
    const dirName = ledger.dir;
    const a = await new CityLedger({ io: createFileIo(), dir: dirName, cityId: CITY }).open();
    const b = await new CityLedger({ io: createFileIo(), dir: dirName, cityId: CITY }).open();
    const results = await Promise.all([
      processBoost(a, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(600_000) }),
      processBoost(b, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(600_001) }),
    ]);
    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => result.reason))
      .toEqual(["insufficient_parchment"]);
    const city = (await townOf(a)).cities[0];
    expect([city.resources.parchment, city.tiles[0].boostPoints]).toEqual([0, 10]);
    expect(paneA).toBeNull();
  });

  test("蓋房與市集同樣只有一筆成功；撤回後座標被別的遠征佔走時，另一個畫面的加速不成立", async () => {
    // 蓋房：庫存剛好一份民居。
    const building = await townWith("race-build", 100);
    await credit(building, { wood: 20, stone: 10 });
    const dirName = building.dir;
    const a = await new CityLedger({ io: createFileIo(), dir: dirName, cityId: CITY }).open();
    const b = await new CityLedger({ io: createFileIo(), dir: dirName, cityId: CITY }).open();
    const builds = await Promise.all([
      processBuild(a, { rootSessionId: ROOT, generation: 1, recipe: "house", at: T(7_000_000) }),
      processBuild(b, { rootSessionId: ROOT, generation: 1, recipe: "house", at: T(7_000_001) }),
    ]);
    expect(builds.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(builds.find((result) => result.status === "rejected").reason).toMatch(/^(already_built|insufficient_resources)$/);
    const city = (await townOf(a)).cities[0];
    expect([city.resources.wood, city.resources.stone, city.tiles[0].landStage]).toEqual([0, 0, "built"]);

    // 市集：庫存剛好 3 張羊皮卷，兩個畫面同時想換木材。
    const market = await townWith("race-trade", 5);
    await credit(market, { parchment: 3 });
    const marketDir = market.dir;
    const c = await new CityLedger({ io: createFileIo(), dir: marketDir, cityId: CITY }).open();
    const d = await new CityLedger({ io: createFileIo(), dir: marketDir, cityId: CITY }).open();
    const trades = await Promise.all([
      processTrade(c, { from: "parchment", to: "wood", amount: 1, at: T(600_000) }),
      processTrade(d, { from: "parchment", to: "wood", amount: 1, at: T(600_001) }),
    ]);
    expect(trades.filter((result) => result.status === "applied")).toHaveLength(1);
    const marketCity = (await townOf(c)).cities[0];
    expect([marketCity.resources.parchment, marketCity.resources.wood]).toEqual([0, 1]);

    // 撤回後座標被別的遠征佔走：舊的一代不再佔著座標，加速整筆不成立。
    const racing = await townWith("race-withdraw", 5);
    await credit(racing, { parchment: 1 });
    const racingDir = racing.dir;
    const paneA = await new CityLedger({ io: createFileIo(), dir: racingDir, cityId: CITY }).open();
    const paneB = await new CityLedger({ io: createFileIo(), dir: racingDir, cityId: CITY }).open();
    expect((await processLand(paneA, { rootSessionId: ROOT, generation: 1, action: "withdraw", at: T(600_000) })).status).toBe("applied");
    const other = await new CityLedger({ io: createFileIo(), dir: racingDir, cityId: CITY }).open();
    const takenState = await other.state();
    const spot = { x: 0, y: -1 }; // 撤回釋放的座標（§17.1 情境 6 的固定情境）
    expect(takenState.taken.has(`${CITY}@@${spot.x},${spot.y}`)).toBe(false);
    await other.submit(() => ({
      opId: `expedition:${CITY}:sess-late:1`,
      kind: "expedition",
      at: T(650_000),
      activatedAt: T(650_000),
      cityId: CITY,
      rootSessionId: "sess-late",
      generation: 1,
      x: spot.x,
      y: spot.y,
      cli: "omp",
      repo: { commonDir: CITY, checkout: CHECKOUT },
    }));
    const late = await processBoost(paneB, { rootSessionId: ROOT, generation: 1, scrolls: 1, at: T(700_000) });
    expect(late.status).toBe("rejected");
    const final = (await townOf(other)).cities[0];
    expect(final.resources.parchment).toBe(1); // 沒扣卷
    expect(final.tiles.find((tile) => tile.rootSessionId === ROOT).boostPoints).toBe(0);
    expect(final.tiles.find((tile) => tile.rootSessionId === "sess-late").points).toBe(0); // 也沒有改到新的遠征
  });
});

describe("規則表（§8.2）", () => {
  test("配方與版本號是外部來源：每一筆操作都存下當時的版本", async () => {
    expect(RECIPES.house.costs).toEqual({ wood: 20, stone: 10 });
    const ledger = await townWith("rules-version", 100);
    await credit(ledger, { wood: 20, stone: 10 });
    await processBuild(ledger, { rootSessionId: ROOT, generation: 1, recipe: "house", at: T(7_000_000) });
    await processBoost(ledger, { rootSessionId: ROOT, generation: 1, scrolls: 0, at: T(7_100_000) });
    const entries = (await ledger.scanSegments()).flatMap((segment) => segment.entries);
    for (const entry of entries) expect(entry.rulesVersion).toBe(RULES_VERSION);
  });
});
