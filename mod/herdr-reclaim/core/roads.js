import { revealedCells, surfaceAt } from "./city-map.js";
import { CENTER, gridDistance, isCenterCell, keyOf, neighbors } from "./grid.js";
import { ROAD } from "./rules.js";

const validCell = c => Number.isSafeInteger(c?.x) && Number.isSafeInteger(c?.y);

export function roadStart(city, cell) {
  return validCell(cell) && (gridDistance(CENTER, cell) === 1 || surfaceAt(city, cell) === "road");
}

/** 依步數分層、同層依北東南西；保留較便宜或用較少新格的路線。
 * 同格先到且成本與新格數均不較高，就能取代後到者的整段後路。 */
export function previewRoad(city, start, end) {
  const reject = reason => ({ ok: false, reason });
  const revealed = revealedCells(city);
  if (!validCell(start) || !revealed.has(keyOf(start)) || !roadStart(city, start)) return reject("road_start");
  if (!validCell(end) || !revealed.has(keyOf(end))) return reject("road_fog");
  const goal = keyOf(end), terrain = surfaceAt(city, end);
  if (terrain === "cliff") return reject("road_cliff");
  if (terrain === "road") return reject("road_exists");
  const occupied = new Set();
  for (const list of [city.buildings, city.queue]) for (const item of list ?? []) {
    for (const cell of item.cells ?? []) occupied.add(keyOf(cell));
  }
  if (occupied.has(goal) || isCenterCell(end)) return reject("road_occupied");
  const tile = cell => {
    const k = keyOf(cell);
    if (!revealed.has(k) || occupied.has(k) || isCenterCell(cell)) return null;
    const t = surfaceAt(city, cell);
    return t === "cliff" ? null : t;
  };
  const first = { cell: start, weight: 0, count: 0 };
  const queue = [first], labels = new Map([[keyOf(start), [first]]]);
  let best, truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (best && node.weight >= best.weight) continue;
    for (const cell of neighbors(node.cell)) {
      const t = tile(cell);
      if (!t) continue;
      const count = node.count + Number(t !== "road");
      if (count > ROAD.limit) { truncated = true; continue; }
      const weight = node.weight + (t === "road" ? 0 : t === "water" ? ROAD.bridgeWeight : ROAD.landWeight);
      if (best && weight >= best.weight) continue;
      const k = keyOf(cell), prior = labels.get(k);
      if (prior?.some(n => n.weight <= weight && n.count <= count)) continue;
      const next = { cell, terrain: t, count, weight, parent: node };
      if (k === goal) { best = next; continue; }
      if (prior) prior.push(next); else labels.set(k, [next]);
      queue.push(next);
    }
  }
  if (!best) {
    // 只有碰到長度上限才查不限長的連通性，避免把峭壁隔開的終點誤報為太遠。
    if (truncated) {
      const seen = new Set([keyOf(start)]), todo = [start];
      while (todo.length) for (const cell of neighbors(todo.pop())) {
        const k = keyOf(cell);
        if (seen.has(k) || !tile(cell)) continue;
        if (k === goal) return reject("road_length");
        seen.add(k); todo.push(cell);
      }
    }
    return reject("road_blocked");
  }
  const path = [];
  for (let n = best; n.parent; n = n.parent) path.push({ ...n.cell, terrain: n.terrain });
  path.reverse();
  return { ok: true, start, end, path, costs: { wood: best.weight * ROAD.wood, stone: best.weight * ROAD.stone },
    buildUnits: Math.ceil(best.count / ROAD.cellsPerUnit), newCount: best.count };
}
