// 共用城市的地圖（#25）：固定地形、起始揭開區、建築占地與選址判準。
//
// 這一支是純函式（不碰 I/O、不 import 帳本），所以預覽與帳本前提檢查用的是**同一個**
// `siteCheck`：畫面說可以放，下令就不會被拒；畫面說不行，下令也進不了帳本。
// 地圖本身固定（不依 repo、space、session 生成），玩家看到的是同一座城。
import { CENTER, cellsWithin, gridDistance, isCenterCell, keyOf } from "./grid.js";
import { CITY_BUILDINGS, START_ROAD_LENGTH, isBuilding, recipeOf } from "./rules.js";
import { terrainV1 } from "./terrain-v1.js";
import { mixedTerrain, specialSiteAt } from "./terrain-v2.js";

/** 地形種類；`buildable` 的三種可以蓋，深水與峭壁不行（#22 的選址規則）。 */
export const TERRAIN = {
  grass: { label: "草地", buildable: true, token: "raised" },
  scrub: { label: "疏林", buildable: true, token: "ansi2" },
  rubble: { label: "碎石地", buildable: true, token: "ansi3" },
  water: { label: "深水", buildable: false, token: "ansi4" },
  cliff: { label: "峭壁", buildable: false, token: "ansi8" },
  road: { label: "道路", buildable: false, token: "muted" },
};

const START_KEYS = [...cellsWithin(CENTER, 4)].map(keyOf);

/** 一格的地形（不看迷霧；迷霧由 `siteCheck` 另外判斷，不洩漏迷霧裡有什麼）。 */
export function terrainAt(cell, version = 1, seed) {
  if (version === 1) return terrainV1(cell);
  if (version === 2) return mixedTerrain(seed, cell);
  throw new Error(`不支援的地形版本：${version}`);
}

export function surfaceAt(city, cell) {
  if (cell.x === CENTER.x || cell.y === CENTER.y) {
    const distance = gridDistance(CENTER, cell);
    if (distance > 1 && distance <= 1 + (city?.roadArmLength ?? START_ROAD_LENGTH)) return "road";
  }
  return terrainAt(cell, city?.terrainVersion, city?.terrainSeed);
}

/**
 * 已揭開的格子鍵（`x,y`）：起始揭開區，加上每棟已完工建築的占地往外 `reveal` 格（#26）。
 * 預定與施工中都不揭開；揭開之後永久可見，不必另外取得建造權。呼叫端（畫面、預覽、帳本前提）
 * 都只透過這一個集合判斷迷霧，所以 `city` 可以是帳本狀態或公開的讀取模型（兩者的 `buildings` 同形）。
 */
export function revealedCells(city) {
  const keys = new Set(START_KEYS);
  for (const building of city?.buildings ?? []) {
    for (const cell of cellsWithin(building, building.reveal ?? 0)) keys.add(keyOf(cell));
  }
  return keys;
}

const covers = (cells, { x, y }) => (cells ?? []).some((cell) => cell.x === x && cell.y === y);

/**
 * 一格現在的地面（畫面用）：已完工建築的占地是 `building`，施工中的那一項是 `site`——植被與
 * 碎石在開工時讓位，所以工地看不到原本的疏林或碎石地；還在排隊、沒開工的預定地不動地面，
 * 仍是原本的地形。其餘格子回原本的地形（不看迷霧，迷霧由呼叫端用 `revealedCells` 判斷）。
 */
export function groundAt(city, cell) {
  if ((city?.buildings ?? []).some((building) => covers(building.cells, cell))) return "building";
  if ((city?.queue ?? []).some((item) => isBuilding(item) && covers(item.cells, cell))) return "site";
  return surfaceAt(city, cell);
}

/** 一棟建築在某個錨點（左上角）佔用的整片格子，順序固定：先 x 再 y。 */
export function footprintCells(building, { x, y }, footprint = CITY_BUILDINGS[building]?.footprint) {
  if (!footprint) return [];
  const cells = [];
  for (let dy = 0; dy < footprint.h; dy++) {
    for (let dx = 0; dx < footprint.w; dx++) cells.push({ x: x + dx, y: y + dy });
  }
  return cells;
}

/**
 * 一座城的選址判準：揭開範圍與占用格只算一次，之後每個錨點共用（`legalSites` 要問上百個錨點）。
 * 回傳 `(building, anchor) => 預覽`；`siteCheck` 與 `legalSites` 都走這一個函式。
 * 占用只看已完工的建築與**整條佇列**（施工中與排隊中的預定地都算），所以佇列裡的兩項不會重疊。
 */
export function siteChecker(city) {
  const revealed = revealedCells(city);
  const built = new Set((city?.buildings ?? []).flatMap((done) => done.cells.map(keyOf)));
  const planned = new Set((city?.queue ?? []).flatMap((item) => (item.cells ?? []).map(keyOf)));
  const check = (building, anchor) => {
    const def = CITY_BUILDINGS[building];
    if (!def) return { ok: false, building, x: anchor?.x, y: anchor?.y, cells: [], problems: ["unknown_building"] };
    const cells = footprintCells(building, anchor).map((cell) => {
      const key = keyOf(cell);
      if (!revealed.has(key)) return { ...cell, terrain: null, problem: "fog" };
      const terrain = surfaceAt(city, cell);
      if (!TERRAIN[terrain].buildable) return { ...cell, terrain, problem: terrain };
      if (isCenterCell(cell)) return { ...cell, terrain, problem: "center" };
      if (built.has(key)) return { ...cell, terrain, problem: "building" };
      if (planned.has(key)) return { ...cell, terrain, problem: "plan" };
      if (city?.terrainVersion === 2 && specialSiteAt(city.terrainSeed, cell)) return { ...cell, terrain, problem: "reserved" };
      return { ...cell, terrain, problem: null };
    });
    const problems = cells.map((cell) => cell.problem).filter(Boolean);
    return { ok: problems.length === 0, building, label: def.label, x: anchor?.x, y: anchor?.y, cells, problems };
  };
  return { revealed, check };
}

/**
 * 選址預覽：整片占地的每一格回報地形與「不能放的原因」。
 * 迷霧只回 `fog`；已揭開才回報地形、道路、中心、建築、預定地或地標預留地的阻擋原因。
 */
export function siteCheck(city, building, anchor) {
  return siteChecker(city).check(building, anchor);
}

/** 全部合法錨點：把已揭開的範圍往外擴一個占地，逐點用同一個判準判斷（與預覽同一條規則）。 */
export function legalSites(city, building) {
  const def = CITY_BUILDINGS[building];
  if (!def) return [];
  const { revealed, check } = siteChecker(city);
  if (revealed.size === 0) return [];
  const xs = [];
  const ys = [];
  for (const key of revealed) {
    const [x, y] = key.split(",").map(Number);
    xs.push(x);
    ys.push(y);
  }
  const minX = Math.min(...xs) - def.footprint.w + 1;
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys) - def.footprint.h + 1;
  const maxY = Math.max(...ys);
  const sites = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (check(building, { x, y }).ok) sites.push({ x, y });
    }
  }
  return sites;
}

/** 配方還缺多少（>= 0）：庫存不足時說明還缺什麼；新規則在預定時就付清，只有舊版預定地會用到。 */
export function missingOf(costs = {}, resources = {}) {
  return Object.fromEntries(Object.entries(costs)
    .map(([key, need]) => [key, Math.max(0, Number(need) - Number(resources?.[key] ?? 0))])
    .filter(([, amount]) => amount > 0));
}

/** 建築清單（畫面左側）：種類、標籤、占地、配方與完工揭開半徑，順序就是帳本規則表的順序。 */
export function cityBuildings(city) {
  return Object.entries(CITY_BUILDINGS).map(([name, def]) => ({
    name,
    label: def.label,
    footprint: { ...def.footprint },
    costs: recipeOf(city, name),
    reveal: Number(def.reveal ?? 0),
  }));
}
