import { AUTO_INTERVAL_UNITS, BUILDINGS_V12, CITY_BUILDINGS, POPULATION_VERSION, WORK_TOKENS_PER_UNIT, affordable, isBuilding, recipeOf } from "./rules.js";
import { buildingCount, creditUnits, grossYield } from "./economy.js";
import { footprintCells } from "./city-map.js";
import { needs, roadsideSites } from "./roadside.js";
import { keyOf } from "./grid.js";

const definition = item => (item.rulesVersion >= POPULATION_VERSION ? CITY_BUILDINGS : BUILDINGS_V12)[item.building];
export const constructionUnits = item => item.building === "road" ? item.buildUnits : definition(item).buildUnits;

/** 只套用已落帳的決定；重播不查地圖、不排種類，也不重算工期。 */
export function applyConstruction(city, event) {
  if (event.kind === "autoStart") {
    const { building, x, y, w, h, costs, unit, label, rulesVersion } = event;
    city.queue.unshift({ building, x, y, w, h, costs, label, rulesVersion, auto: true, at: unit,
      paid: false, cells: footprintCells(building, event, { w, h }) });
  }
  const item = city.queue[0];
  if (event.kind === "autoComplete" || event.kind === "manualComplete") {
    city.queue.shift();
    if (item.building === "road") {
      for (const cell of item.cells) city.roads[keyOf(cell)] = cell.terrain === "water" ? "bridge" : "road";
      return;
    }
    const { building, label, x, y, w, h, costs, cells, startedUnit } = item;
    city.buildings.push({ building, label, x, y, w, h, costs, cells, startedUnit,
      ...(item.auto ? { auto: true } : {}), completedUnit: event.unit, reveal: event.reveal, rulesVersion: event.rulesVersion });
  } else {
    if (!item.paid) for (const [k, n] of Object.entries(item.costs)) city.resources[k] -= n;
    item.paid = true;
    item.startedUnit = event.unit;
  }
}

/** 一筆收入的候選交易。呼叫端以同一次 CAS 刊登收入及所有施工 entry。 */
export function constructionIncome(state, tokens, rulesVersion) {
  const metered = state.work.tokens + tokens;
  const units = Math.floor(metered / WORK_TOKENS_PER_UNIT);
  const income = { wood: 0, stone: 0, iron: 0 }, events = [];
  const work = { ...state.work, tokens: metered % WORK_TOKENS_PER_UNIT };
  if (!units) return { income, work, events };
  const city = { ...state, resources: { ...state.resources }, buildings: state.buildings.slice(), queue: state.queue.map(i => ({ ...i })) };
  const carry = { ...work.carry };
  let unit = work.units ?? 0, count = buildingCount(city.buildings), gross = grossYield(city), sites;
  const end = unit + units;
  const record = (kind, atUnit, details) => {
    const event = { kind, unit: atUnit, rulesVersion, opId: `${kind}:${city.cityId}:${atUnit}`, ...details };
    events.push(event);
    applyConstruction(city, event);
  };
  while (unit < end) {
    let head = city.queue[0];
    // 舊時制工地：第一次收到份數時接軌，不重扣已支付的配方。
    if (head?.startedAt != null && head.startedUnit == null) record("manualStart", unit, {});
    const running = head && isBuilding(head);
    const finish = running ? head.startedUnit + constructionUnits(head) : null;
    const span = running ? Math.min(end, finish) - unit : !head && state.work.since == null ? end - unit : 1;
    creditUnits(city.resources, income, carry, count, span, gross);
    unit += span;
    if (running) {
      if (unit < finish) continue;
      const road = head.building === "road";
      // 模擬交易時不能修改 CAS 前的城市；首次通車才複製道路表。
      if (road && city.roads === state.roads) city.roads = { ...state.roads };
      record(head.auto ? "autoComplete" : "manualComplete", unit, { building: head.building, reveal: road ? 0 : definition(head).reveal });
      if (!road) count++;
      gross = grossYield(city); sites = null;
      head = city.queue[0];
    }
    if (head && (head.paid || affordable(head.costs, city.resources))) {
      work.roadsideFull = false;
      record("manualStart", unit, { building: head.building });
      continue;
    }
    if (state.work.since == null) continue; // 尚未開城，沒有已啟用的沿線土地。
    if (AUTO_INTERVAL_UNITS && city.buildings.some(b => b.auto && unit - b.completedUnit < AUTO_INTERVAL_UNITS)) continue;
    sites ??= roadsideSites(city);
    const site = sites(needs(city, gross));
    work.roadsideFull = !site;
    if (!site) {
      // 四種占地至少 2×1，沒有民居位置就是全滿。無手動隊首時，後續只會增加庫存。
      if (!head && unit < end) { creditUnits(city.resources, income, carry, count, end - unit, gross); unit = end; }
      continue;
    }
    const costs = recipeOf(city, site.building);
    if (!Object.entries(costs).every(([k, n]) => city.resources[k] - (head?.costs[k] ?? 0) >= n)) continue;
    record("autoStart", unit, { ...site, label: CITY_BUILDINGS[site.building].label, costs });
    gross = grossYield(city); sites = null;
  }
  work.units = end; work.carry = carry;
  return { income, work, events };
}
