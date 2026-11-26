import { cellsWithin, keyOf } from "./grid.js";
import { siteChecker, surfaceAt } from "./city-map.js";
import { grossYield, workforce } from "./economy.js";
import { CITY_BUILDINGS, ROADSIDE_RANGE, TOWN_UPGRADE_COSTS, isBuilding, populationCapacity, populationGap, recipeOf } from "./rules.js";

const producers = { wood: "lumberyard", stone: "quarry", iron: "workshop" };

export function needs(city, gross) {
  const { capacity, demand } = workforce(city.buildings);
  if (capacity - demand < 3) return ["people"];
  const target = city.queue.find(item => !isBuilding(item))?.costs
    ?? (city.era === "town" ? recipeOf(city, "house") : TOWN_UPGRADE_COSTS);
  gross ??= grossYield(city);
  // 三材的維護乘數相同，不改變排序。帶號交叉相乘，平手維持木、石、鐵順序。
  const deficit = k => (target[k] ?? 0) - city.resources[k];
  return Object.keys(producers).sort((a, b) => deficit(b) * gross[a] - deficit(a) * gross[b]);
}

/** 土地只在占地或揭開範圍變動時重算；等料的每一份仍按當下庫存重排種類。 */
export function roadsideSites(city, range = ROADSIDE_RANGE, capacity = populationCapacity(city.buildings)) {
  const { revealed, covered, check } = siteChecker(city, range);
  const anchors = [];
  for (const key of revealed) if (covered.has(key)) {
    const [x, y] = key.split(",").map(Number);
    anchors.push({ x, y });
  }
  anchors.sort((a, b) => a.y - b.y || a.x - b.x);
  const available = new Set(revealed);
  grossYield(city, available); // 去除既有占地與產場已取得的資源
  const cache = new Map();
  function best(building) {
    if (cache.has(building)) return cache.get(building);
    const { production, footprint } = CITY_BUILDINGS[building];
    let winner = null, bestBonus = -1, leastDamage = Infinity, leastAxis = Infinity;
    for (const anchor of anchors) {
      const { ok, cells } = check(building, anchor);
      if (!ok) continue;
      const site = { building, ...anchor, ...footprint };
      let bonus = 0, damage = 0, axis = 0;
      for (const cell of cells) {
        if (cell.terrain === "scrub" || cell.terrain === "rubble") damage++;
        if (cell.x === 0 || cell.y === 0) axis++;
      }
      if (production) {
        for (const c of cellsWithin(site, 1)) {
          if (c.x >= site.x && c.x < site.x + site.w && c.y >= site.y && c.y < site.y + site.h) continue;
          if (available.has(keyOf(c)) && production.terrain.includes(surfaceAt(city, c))) bonus++;
        }
        if (!bonus) continue;
        bonus = Math.min(bonus, production.cap);
      }
      if (bonus < bestBonus || (bonus === bestBonus && (damage > leastDamage || (damage === leastDamage && axis >= leastAxis)))) continue;
      winner = site; bestBonus = bonus; leastDamage = damage; leastAxis = axis;
    }
    cache.set(building, winner);
    return winner;
  }
  return priority => {
    for (const key of priority) if (producers[key] && !populationGap(producers[key], capacity)) {
      const site = best(producers[key]);
      if (site) return site;
    }
    return best("house");
  };
}
