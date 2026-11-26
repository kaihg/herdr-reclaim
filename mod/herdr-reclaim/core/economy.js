import { CITY_BUILDINGS, WORK_YIELD } from "./rules.js";

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

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 規模不變時可以合算數份。分母會隨完工改變；用最簡分數跨份累積，
 * checkpoint 存十進位字串，不讓浮點誤差把剛好達到整數的一份延到下筆。 */
export function creditUnits(stock, total, carry, n, units) {
  const d = BigInt(denominator(n));
  const net = (d - BigInt(n)) * BigInt(units);
  for (const [key, gross] of Object.entries(WORK_YIELD)) {
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
