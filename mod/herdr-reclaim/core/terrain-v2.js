// 第二版只用種子與世界格座標取樣；沒有地圖邊界，也不需要先生成鄰格。
import { CENTER, gridDistance, neighbors } from "./grid.js";
import { terrainV1 } from "./terrain-v1.js";

const mod = (n, period) => ((n % period) + period) % period;
function hash(x, y, seed) {
  const h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 144269);
  const mixed = Math.imul(h ^ (h >>> 13), 1274126177);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

const BENDS = [[0, 0, 1, 1, 2, 2, 1, 0], [0, -1, -2, -2, -1, 0, 0, 0], [0, 1, 1, 0, 0, -1, -1, 0]];
export function riverCenterX(seed, lane, y) {
  return 10 + 48 * lane + BENDS[hash(lane, Math.floor(y / 8), seed) % BENDS.length][mod(y, 8)];
}
const PATCHES = [
  { terrain: "water", shift: 0, mask: [".###.", "#####", ".###."] },
  { terrain: "rubble", shift: 7, mask: ["....##", "..###.", ".###..", "##...."] },
  { terrain: "scrub", shift: 14, mask: ["..###..", ".#####.", "#######", "#####..", "..##..."] },
];
function baseTerrain(seed, x, y) {
  const pattern = hash(Math.floor(x / 16), Math.floor(y / 16), seed);
  const sx = mod(x, 16), sy = mod(y, 16);
  for (const { terrain, shift, mask } of PATCHES) {
    const placement = pattern >>> shift;
    const dx = sx - placement % 9, dy = sy - (placement >>> 3) % 10;
    if (mask[dy]?.[placement & 1 ? mask[0].length - 1 - dx : dx] === "#") return terrain;
  }
  const i = Math.floor(x / 7), j = Math.floor(y / 7), a = mod(x, 7) / 7, b = mod(y, 7) / 7;
  const top = (1 - a) * hash(i, j, seed) + a * hash(i + 1, j, seed);
  const bottom = (1 - a) * hash(i, j + 1, seed) + a * hash(i + 1, j + 1, seed);
  const value = ((1 - b) * top + b * bottom) / 2 ** 32;
  return value < .28 ? "scrub" : value > .88 ? "cliff" : value > .69 ? "rubble" : "grass";
}
const ROTATIONS = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
function district(seed, x, y, terrain) {
  const [cos, sin] = ROTATIONS[seed & 7];
  const west = Math.sin((-2 * Math.PI / 48) * (x * cos - y * sin));
  const north = Math.sin((-2 * Math.PI / 48) * (x * sin + y * cos));
  if (north < -.45 && west < .5) return "grass";
  if (north > .84 && Math.abs(west) < .18) return "cliff";
  if (terrain === "scrub" || terrain === "rubble") {
    if (west > .35 && west > north) return "scrub";
    if (north > .35) return "rubble";
  }
  if (terrain === "grass" && Math.max(west, north) > .70) return west > north ? "scrub" : "rubble";
  return terrain;
}

export function mixedTerrain(seed, cell) {
  const { x, y } = cell;
  const radius = gridDistance(CENTER, cell);
  if (radius <= 4) return terrainV1(cell);
  const lane = Math.round((x - 10) / 48), offset = x - (10 + lane * 48);
  // 水平補上前一列的轉折；八列一次的窄渡點仍是水格，不是免費道路。
  if (offset >= -2 && offset <= 3) {
    const here = riverCenterX(seed, lane, y), prev = riverCenterX(seed, lane, y - 1);
    if (x >= Math.min(here, prev) && x <= Math.max(here, prev) + (y % 8 === 0 ? 0 : 1)) return "water";
  }
  const base = baseTerrain(seed, x, y);
  if (base === "water") return base;
  if (x === 7 && Math.abs(y) <= 4) return "rubble";
  const terrain = radius > 5 ? district(seed, x, y, base) : base;
  return radius <= 6 && (terrain === "rubble" || terrain === "cliff") ? "grass" : terrain;
}

const AGES = [["village", 12, 18], ["town", 27, 36]];
const TYPES = ["ruins", "vein", "harbor"];
function chooseSite(seed, age, lo, hi, index, sites) {
  const h = hash(index, lo, seed), width = hi - lo + 1;
  for (let dr = 0; dr < width; dr++) {
    const r = lo + (h + dr) % width, span = 2 * r + 1;
    for (let turn = 0; turn < 4; turn++) {
      const side = (index + seed + turn) & 3;
      for (let step = 0; step < span; step++) {
        const q = (Math.floor(h / 31) + step) % span - r;
        const x = side === 0 ? r : side === 2 ? -r : q;
        const y = side === 1 ? r : side === 3 ? -r : q;
        if (sites.some(s => s.x === x && s.y === y)) continue;
        const terrain = mixedTerrain(seed, { x, y });
        if (terrain === "water" || terrain === "cliff") continue;
        const type = TYPES[index];
        if (type === "vein" && terrain !== "rubble") continue;
        if (type === "harbor" && !neighbors({ x, y }).some(n => mixedTerrain(seed, n) === "water")) continue;
        return Object.freeze({ x, y, age, type });
      }
    }
  }
  throw new Error(`無法預留特殊地點：${age}/${TYPES[index]}`);
}

// 預留地是地形上的註記，不取代地面。只記住最近一座城的六格，不快取整張地圖。
let lastSeed, lastSites;
export function specialSites(seed) {
  if (lastSites && seed === lastSeed) return lastSites;
  const sites = [];
  for (const [age, lo, hi] of AGES) {
    for (let i = 0; i < TYPES.length; i++) sites.push(chooseSite(seed, age, lo, hi, i, sites));
  }
  lastSeed = seed;
  lastSites = Object.freeze(sites);
  return lastSites;
}

export function specialSiteAt(seed, cell) {
  const r = gridDistance(CENTER, cell);
  if (!AGES.some(([, lo, hi]) => r >= lo && r <= hi)) return null;
  return specialSites(seed).find(site => site.x === cell.x && site.y === cell.y) ?? null;
}
