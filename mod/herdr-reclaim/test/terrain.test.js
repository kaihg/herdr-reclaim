import { expect, test } from "bun:test";
import { groundAt, revealedCells, siteCheck, terrainAt } from "../core/city-map.js";
import { CENTER, gridDistance, keyOf, neighbors } from "../core/grid.js";
import { riverCenterX, specialSites } from "../core/terrain-v2.js";

const seeds = [32, 1, 1013904242, 3668340011, 2027808484, 387276957, 3041712726, 0xffffffff];
const cityOf = terrainSeed => ({ terrainVersion: 2, terrainSeed, roadArmLength: 1 });

// 只從未走過且合條件的格子前進，不能從對角接上另一岸。
function flood(unvisited, first) {
  const reached = new Set();
  if (!unvisited.delete(keyOf(first))) return reached;
  const queue = [first];
  for (let i = 0; i < queue.length; i++) {
    reached.add(keyOf(queue[i]));
    for (const cell of neighbors(queue[i])) if (unvisited.delete(keyOf(cell))) queue.push(cell);
  }
  return reached;
}

test("無界同格重算", () => {
  const cells = [];
  for (const origin of [-1_000_000, 0, 1_000_000]) {
    for (let y = -16; y <= 16; y++) for (let x = -16; x <= 16; x++) cells.push({ x: origin + x, y: -origin + y });
  }
  const samples = seeds.map(seed => cells.map(cell => terrainAt(cell, 2, seed)));
  cells.reverse();
  for (const [i, seed] of seeds.entries()) expect(cells.map(cell => terrainAt(cell, 2, seed))).toEqual(samples[i].slice().reverse());
  expect(new Set(samples.map(row => row.join(","))).size).toBe(seeds.length);
  // 相鄰的列不得與橫跨原型 1024 格後的位置混為同一格。
  const row = (x, y) => Array.from({ length: 48 }, (_, dx) => terrainAt({ x: x + dx, y }, 2, 32));
  expect(row(0, 1)).not.toEqual(row(1024, 0));
  expect(terrainAt({ x: 10 + 48 * 1024, y: 0 }, 2, 32)).toBe("water");
  expect(terrainAt({ x: 10 - 48 * 1024, y: 0 }, 2, 32)).toBe("water");
});

test("上游連通與林石成片", () => {
  for (const seed of seeds) {
    const blocks = { scrub: new Set(), rubble: new Set(), water: new Set() };
    for (let y = -64; y <= 64; y++) for (let x = -64; x <= 64; x++) {
      const cell = { x, y };
      blocks[terrainAt(cell, 2, seed)]?.add(keyOf(cell));
    }
    for (const lane of [-1, 0, 1]) {
      const center = 10 + 48 * lane;
      const water = new Set([...blocks.water].filter(key => Math.abs(Number(key.split(",")[0]) - center) <= 3));
      const connected = flood(water, { x: center, y: -64 });
      for (let y = -64; y <= 64; y++) expect(connected.has(keyOf({ x: riverCenterX(seed, lane, y), y }))).toBe(true);
    }
    for (const remaining of [blocks.scrub, blocks.rubble]) {
      let largest = 0;
      while (remaining.size) {
        const [x, y] = remaining.values().next().value.split(",").map(Number);
        largest = Math.max(largest, flood(remaining, { x, y }).size);
      }
      expect(largest).toBeGreaterThanOrEqual(8); // 至少成片，不把原型分位數當規則。
    }
  }
});

test("兩時代預留地", () => {
  for (const seed of seeds) {
    const sites = specialSites(seed);
    expect(new Set(sites.map(keyOf)).size).toBe(6);
    for (const [age, lo, hi] of [["village", 12, 18], ["town", 27, 36]]) {
      const era = sites.filter(s => s.age === age);
      expect(era.map(s => s.type).sort()).toEqual(["harbor", "ruins", "vein"]);
      for (const site of era) {
        const radius = gridDistance(CENTER, site);
        expect(radius).toBeGreaterThanOrEqual(lo);
        expect(radius).toBeLessThanOrEqual(hi);
        const terrain = terrainAt(site, 2, seed);
        expect(["grass", "scrub", "rubble"]).toContain(terrain);
        if (site.type === "vein") expect(terrain).toBe("rubble");
        if (site.type === "harbor") expect(neighbors(site).some(cell => terrainAt(cell, 2, seed) === "water")).toBe(true);
        const city = cityOf(seed);
        expect(siteCheck(city, "outpost", site).cells[0]).toMatchObject({ terrain: null, problem: "fog" });
        const scout = { x: site.x + 2, y: site.y, w: 1, h: 1 };
        city.buildings = [{ ...scout, cells: [scout], reveal: 5 }];
        expect(siteCheck(city, "house", { x: site.x - 1, y: site.y }).cells[1].problem).toBe("reserved");
      }
    }
  }
});

test("起始 81 格地形與道路逐格等於第一版", () => {
  const first = { terrainVersion: 1, roadArmLength: 1 };
  for (const seed of seeds) {
    const city = cityOf(seed);
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const cell = { x, y };
      expect(terrainAt(cell, 2, seed)).toBe(terrainAt(cell, 1));
      expect(groundAt(city, cell)).toBe(groundAt(first, cell));
    }
  }
});

test("起始揭開、四臂與外側河岸", () => {
  for (const seed of seeds) {
    const city = cityOf(seed), revealed = revealedCells(city);
    expect(revealed.size).toBe(81);
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const cell = { x, y };
      expect(revealed.has(keyOf(cell))).toBe(true);
      const arm = (x === 0 || y === 0) && Math.abs(x) + Math.abs(y) === 2;
      expect(groundAt(city, cell) === "road").toBe(arm);
      if (Math.abs(x) <= 1 && Math.abs(y) <= 1) expect(siteCheck(city, "outpost", cell).problems).toEqual(["center"]);
    }
    for (let y = -4; y <= 4; y++) expect(["water", "rubble"]).toContain(terrainAt({ x: 7, y }, 2, seed));
  }
});
