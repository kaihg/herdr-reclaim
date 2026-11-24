// 共用城市的地圖（#25）：固定地形、起始揭開區、建築占地與選址判準。
//
// 這一支是純函式（不碰 I/O、不 import 帳本），所以預覽與帳本前提檢查用的是**同一個**
// `siteCheck`：畫面說可以放，下令就不會被拒；畫面說不行，下令也進不了帳本。
// 地圖本身固定（不依 repo、space、session 生成），玩家看到的是同一座城。
//
// 起始揭開區是城鎮中心周圍一塊 8×8 的土地（東北角還罩著迷霧），足以在隔一格的位置
// 放下 2×2 的市場。
import { isCenterCell } from "./grid.js";
import { CITY_BUILDINGS } from "./rules.js";

/** 地形種類；`buildable` 的三種可以蓋，深水與峭壁不行（#22 的選址規則）。 */
export const TERRAIN = {
  grass: { label: "草地", buildable: true, token: "raised" },
  scrub: { label: "疏林", buildable: true, token: "ansi2" },
  rubble: { label: "碎石地", buildable: true, token: "ansi3" },
  water: { label: "深水", buildable: false, token: "ansi4" },
  cliff: { label: "峭壁", buildable: false, token: "ansi8" },
};

/**
 * 起始揭開區：城鎮中心周圍 x、y 都在 -3..4 的一塊土地，東北角（x + y > 7）還罩著迷霧。
 * 這塊地開城就看得到，玩家不必先開墾就能選址（#22：起始可見土地足以留白選址）。
 */
const START = { minX: -3, maxX: 4, minY: -3, maxY: 4, fogLine: 7 };

const inStartRect = (x, y) => x >= START.minX && x <= START.maxX && y >= START.minY && y <= START.maxY;

/** 起始區內手繪的地形（其餘是草地）；用固定的座標釘住，測試與畫面看到的是同一份。 */
const PAINTED = new Map([
  ["-2,-3", "water"],
  ["4,-2", "cliff"],
  ["1,-3", "scrub"],
  ["1,-2", "scrub"],
  ["2,-2", "rubble"],
  ["2,-3", "rubble"],
]);

/** 起始區外的地形：座標的決定性雜湊（同一格每次都一樣，不依時間或亂數）。 */
function hashedTerrain(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  const roll = (h ^ (h >>> 16)) >>> 0;
  const bucket = roll % 100;
  if (bucket < 6) return "water";
  if (bucket < 11) return "cliff";
  if (bucket < 26) return "scrub";
  if (bucket < 36) return "rubble";
  return "grass";
}

/** 一格的地形（不看迷霧；迷霧由 `siteCheck` 另外判斷，不洩漏迷霧裡有什麼）。 */
export function terrainAt({ x, y }) {
  if (inStartRect(x, y)) return PAINTED.get(`${x},${y}`) ?? "grass";
  return hashedTerrain(x, y);
}

/** 一格是否已揭開：起始區扣掉東北角的迷霧線。之後完工的建築再往外揭（#26）。 */
export function isRevealed({ x, y }) {
  return inStartRect(x, y) && x + y <= START.fogLine;
}

/**
 * 已揭開的格子鍵（`x,y`）。`city` 目前只需要存在即可；之後的揭圖（#26）從這裡長出來，
 * 呼叫端（畫面、預覽、帳本前提）都只透過這一個集合判斷迷霧。
 */
export function revealedCells(_city) {
  const keys = new Set();
  for (let x = START.minX; x <= START.maxX; x++) {
    for (let y = START.minY; y <= START.maxY; y++) {
      if (isRevealed({ x, y })) keys.add(`${x},${y}`);
    }
  }
  return keys;
}

/** 一棟建築在某個錨點（左上角）佔用的整片格子，順序固定：先 x 再 y。 */
export function footprintCells(building, { x, y }) {
  const def = CITY_BUILDINGS[building];
  if (!def) return [];
  const cells = [];
  for (let dy = 0; dy < def.footprint.h; dy++) {
    for (let dx = 0; dx < def.footprint.w; dx++) cells.push({ x: x + dx, y: y + dy });
  }
  return cells;
}

/**
 * 選址預覽：整片占地的每一格回報地形與「不能放的原因」。
 * 原因只有一種：`fog`（沒揭開，地形不回報）、`water`、`cliff`、`center`（城鎮中心）、
 * `plan`（已經是同一個預定地）。`ok` 是全部格子都沒有原因。
 */
export function siteCheck(city, building, anchor) {
  const def = CITY_BUILDINGS[building];
  if (!def) return { ok: false, building, x: anchor?.x, y: anchor?.y, cells: [], problems: ["unknown_building"] };
  const revealed = revealedCells(city);
  const planned = new Set((city?.plan?.cells ?? []).map((cell) => `${cell.x},${cell.y}`));
  const cells = footprintCells(building, anchor).map((cell) => {
    const key = `${cell.x},${cell.y}`;
    if (!revealed.has(key)) return { ...cell, terrain: null, problem: "fog" };
    const terrain = terrainAt(cell);
    if (!TERRAIN[terrain].buildable) return { ...cell, terrain, problem: terrain };
    if (isCenterCell(cell)) return { ...cell, terrain, problem: "center" };
    if (planned.has(key)) return { ...cell, terrain, problem: "plan" };
    return { ...cell, terrain, problem: null };
  });
  const problems = cells.map((cell) => cell.problem).filter(Boolean);
  return { ok: problems.length === 0, building, label: def.label, x: anchor?.x, y: anchor?.y, cells, problems };
}

/** 全部合法錨點：把已揭開的範圍往外擴一個占地，逐點用 `siteCheck` 判斷（與預覽同一條規則）。 */
export function legalSites(city, building) {
  const def = CITY_BUILDINGS[building];
  if (!def) return [];
  const revealed = revealedCells(city);
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
      if (siteCheck(city, building, { x, y }).ok) sites.push({ x, y });
    }
  }
  return sites;
}

/** 配方還缺多少（>= 0）：預定地顯示「備料中」用，不下令、不預扣。 */
export function missingOf(costs = {}, resources = {}) {
  return Object.fromEntries(Object.entries(costs)
    .map(([key, need]) => [key, Math.max(0, Number(need) - Number(resources?.[key] ?? 0))])
    .filter(([, amount]) => amount > 0));
}

/** 建築清單（畫面左側）：種類、標籤、占地與配方，順序就是帳本規則表的順序。 */
export function cityBuildings() {
  return Object.entries(CITY_BUILDINGS).map(([name, def]) => ({
    name,
    label: def.label,
    footprint: { ...def.footprint },
    costs: { ...def.costs },
  }));
}
