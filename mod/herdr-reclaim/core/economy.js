import { CITY_BUILDINGS, WORK_YIELD } from "./rules.js";
import { revealedCells, surfaceAt } from "./city-map.js";
import { CENTER_CELLS, cellsWithin, keyOf } from "./grid.js";

// 只有完工實體建築有規模；城鎮中心、道路與時代都不是建築表裡的項目。
export const buildingCount = (buildings) => buildings.reduce((n, b) => n + Number(Object.hasOwn(CITY_BUILDINGS, b.building)), 0);
const denominator = (n) => 2 * (n + 15);
export const maintenanceRate = (n) => n / denominator(n);

export function workforce(buildings) {
  const capacity = buildings.reduce((n, b) => n + (CITY_BUILDINGS[b.building]?.residents ?? 0), 2);
  let demand = 0, assigned = 0;
  const understaffed = new Set();
  // 清單是 journal 的完工順序。早完工的需求優先；晚完工的小棟也不能插隊。
  for (const b of buildings) {
    const jobs = CITY_BUILDINGS[b.building]?.jobs ?? 0;
    demand += jobs;
    if (jobs && demand > capacity) understaffed.add(b);
    else assigned += jobs;
  }
  return { capacity, assigned, understaffed };
}

/** 每個相符格歸第一棟，即使它已達上限也不轉給後來的產場。 */
export function grossYield(city) {
  if (!city.buildings.some(b => CITY_BUILDINGS[b.building]?.production)) return WORK_YIELD;
  const gross = { ...WORK_YIELD };
  const { understaffed } = workforce(city.buildings);
  const available = revealedCells(city);
  for (const cell of CENTER_CELLS) available.delete(keyOf(cell));
  for (const list of [city.buildings, city.queue]) {
    for (const item of list) for (const cell of item.cells) available.delete(keyOf(cell));
  }
  for (const b of city.buildings) {
    const producer = CITY_BUILDINGS[b.building]?.production;
    if (!producer || understaffed.has(b)) continue;
    let bonus = 0;
    for (const cell of cellsWithin(b, 1)) {
      const key = keyOf(cell);
      if (!available.has(key) || !producer.terrain.includes(surfaceAt(city, cell))) continue;
      available.delete(key);
      bonus++;
    }
    gross[producer.material] += 1 + Math.min(bonus, producer.cap);
  }
  return gross;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 規模不變時可以合算數份。分母會隨完工改變；用最簡分數跨份累積，
 * checkpoint 存十進位字串，不讓浮點誤差把剛好達到整數的一份延到下筆。 */
export function creditUnits(stock, total, carry, n, units, yieldPerUnit) {
  const d = BigInt(denominator(n));
  const net = (d - BigInt(n)) * BigInt(units);
  for (const [key, gross] of Object.entries(yieldPerUnit)) {
    const previous = carry[key];
    const p = previous ? BigInt(previous[0]) : 0n;
    const q = previous ? BigInt(previous[1]) : 1n;
    const numerator = net * BigInt(gross) * q + p * d;
    const divisor = d * q;
    const whole = Number(numerator / divisor);
    stock[key] += whole;
    total[key] += whole;
    const rest = numerator % divisor;
    if (!rest) delete carry[key];
    else {
      const factor = gcd(rest, divisor);
      carry[key] = [String(rest / factor), String(divisor / factor)];
    }
  }
}
