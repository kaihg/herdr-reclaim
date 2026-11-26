import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { groundAt, revealedCells, siteCheck, terrainAt } from "../core/city-map.js";
import { grossYield } from "../core/economy.js";
import { keyOf } from "../core/grid.js";
import { CityLedger } from "../core/ledger.js";
import { previewRoad } from "../core/roads.js";
import { cancelPlan, placePlan, placeRoad, readSharedCity } from "../core/shared-city.js";
import { createFileIo } from "./fs-io.js";

const p = (x, y) => ({ x, y });
const east = p(2, 0);

test("起訖與限長", () => {
  const route = (start, end, city = {}) => previewRoad(city, start, end);
  expect(route(p(1, 1), p(2, 1)).ok).toBe(true);
  expect(route(p(0, 0), p(2, 1)).reason).toBe("road_start");
  expect(route(p(3, 0), p(4, 0)).reason).toBe("road_start");
  expect(route(east, p(5, 0)).reason).toBe("road_fog");
  expect(route(east, p(4, -2)).reason).toBe("road_cliff");
  expect(route(east, p(0, -2)).reason).toBe("road_exists");
  const site = { cells: [p(3, 0), p(2, 1), p(2, -1)] };
  expect(route(east, p(4, 0), { queue: [site] }).reason).toBe("road_blocked");
  expect(route(east, p(3, 0), { queue: [site] }).reason).toBe("road_occupied");
  // 找一段已知地形無峭壁的直線，兩端旁邊即使有繞路也不可能少鋪一格。
  let y = 5;
  while (Array.from({ length: 13 }, (_, i) => terrainAt(p(4 + i, y))).includes("cliff")) y++;
  const city = { roads: { [`3,${y}`]: "road" }, buildings: [{ ...p(10, y + 1), cells: [], reveal: 7 }] };
  expect(route(p(3, y), p(15, y), city).newCount).toBe(12);
  expect(route(p(3, y), p(16, y), city).reason).toBe("road_length");
});

test("最省、平手與橋價", () => {
  for (let i = 0; i < 12; i++) {
    expect(previewRoad({}, east, p(3, -1)).path.map(keyOf)).toEqual(["2,-1", "3,-1"]);
  }
  const coast = { roads: { "-3,-3": "road" } };
  const detour = previewRoad(coast, p(-3, -3), p(-1, -3));
  expect(detour.path).toHaveLength(4); // 直線兩步，但跨水較貴。
  expect(detour.costs).toEqual({ wood: 16, stone: 32 });
  const bridge = previewRoad(coast, p(-3, -3), p(-2, -3));
  expect(bridge.costs).toEqual({ wood: 20, stone: 40 });
  expect(bridge.buildUnits).toBe(1);
  // 繞既有道路也只需付一格；應選一步而非三步。
  const twoWays = { roads: { "2,-1": "road", "3,-1": "road" } };
  expect(previewRoad(twoWays, east, p(3, 0)).path.map(keyOf)).toEqual(["3,0"]);
});

async function withCity(run) {
  const dir = mkdtempSync("/tmp/reclaim-road-");
  const open = () => new CityLedger({ io: createFileIo(), dir, cityId: "road-test" }).open();
  try {
    const ledger = await open();
    const city = async () => readSharedCity(await ledger.state()).city;
    let n = 0;
    const work = units => ledger.submit(() => ({ opId: `income:${++n}`, kind: "income", cityId: ledger.cityId,
      sources: [String(n)], tokens: units * 10000 }));
    await run({ ledger, open, city, work });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("付款、通車減產與重播", () => withCity(async ({ ledger, city, work, open }) => {
  await work(100);
  expect((await placePlan(ledger, { building: "quarry", ...p(1, -4) })).status).toBe("applied");
  await work(18);
  const before = await city(), start = p(0, -2), end = p(0, -4);
  expect(groundAt(before, end)).toBe("rubble");
  const route = previewRoad(before, start, end);
  expect(route).toMatchObject({ costs: { wood: 8, stone: 16 }, newCount: 2, buildUnits: 1 });
  expect((await placeRoad(ledger, route)).status).toBe("applied");
  const running = await city();
  expect(running.queue[0]).toMatchObject({ stage: "building", remainingUnits: 1 });
  expect(running.resources).toEqual({ ...before.resources, wood: before.resources.wood - 8, stone: before.resources.stone - 16 });
  expect(previewRoad(running, end, p(-1, -4)).reason).toBe("road_start");
  expect(grossYield(running)).toEqual(grossYield(before));
  expect((await cancelPlan(ledger, running.queue[0])).reason).toBe("already_started");
  expect((await city()).resources).toEqual(running.resources);
  await work(1);
  const done = await city();
  expect(done.queue).toEqual([]);
  expect(groundAt(done, end)).toBe("road");
  expect(done.maintenance).toBe(before.maintenance);
  expect(revealedCells(done)).toEqual(revealedCells(before));
  expect(grossYield(done).stone).toBe(grossYield(before).stone - 1);
  expect(readSharedCity(await (await open()).state()).city).toEqual(done);
  await ledger.checkpoint();
  expect(readSharedCity(await (await open()).state()).city).toEqual(done);
}));

test("沿線與共用佇列", () => withCity(async ({ ledger, city, work }) => {
  await work(150);
  expect((await placePlan(ledger, { building: "outpost", ...p(4, 1) })).status).toBe("applied");
  await work(4);
  const before = await city();
  // 左格距東臂 3，右格距東臂 4；中心不提供覆蓋。
  const anchor = p(5, 1);
  expect(siteCheck(before, "house", anchor).problems).toContain("off_road");
  expect((await placePlan(ledger, { building: "house", ...anchor })).reason).toBe("site_off_road");
  expect(siteCheck(before, "outpost", p(6, 1)).ok).toBe(true);
  expect(siteCheck({ roadArmLength: 0 }, "house", p(2, 1)).problems).toContain("off_road");
  const route = previewRoad(before, east, p(3, 0));
  expect((await placeRoad(ledger, route)).status).toBe("applied");
  expect(siteCheck(await city(), "house", anchor).ok).toBe(false);
  const held = (await city()).resources;
  const bridge = previewRoad(await city(), p(0, -2), p(-2, -3));
  expect((await placeRoad(ledger, bridge)).status).toBe("applied");
  expect((await placePlan(ledger, { building: "outpost", ...p(-3, 2) })).status).toBe("applied");
  expect((await placeRoad(ledger, previewRoad(await city(), east, p(2, 1)))).reason).toBe("queue_full");
  expect((await city()).resources).toEqual(held);
  await work(1);
  expect(siteCheck(await city(), "house", anchor).ok).toBe(true);
  expect((await city()).queue[0]).toMatchObject({ building: "road", remainingUnits: 2, costs: bridge.costs });
  await work(2);
  expect((await city()).roads["-2,-3"]).toBe("bridge");
}));
