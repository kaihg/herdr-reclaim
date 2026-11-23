// 城鎮讀取模型：把 adapter 的活動紀錄（§6.1）重播成可觀察的城鎮狀態（§4、§5）。
//
// 兩個接點共用同一段重播規則：
//   readTown({ activities, repoFacts })        直接重播活動，格子位置由 §4 的 BFS 決定（#2）
//   readTownFromLedger({ activities, expeditions, repoFacts })  格子位置由 journal 的
//                                              「遠征取得土地」entry 決定（#3）
// 土地生命週期、commit 收成、建築與額度由 #4／#5 接上；庫存與行會在這裡先固定成
// 「還沒有收成」與「沒有額度來源」。
import { CENTER, CENTER_CELLS, bfsNextTile, isCenterCell, keyOf, revealedKeys } from "./grid.js";
import { BOOST_POINTS_PER_PARCHMENT, CLEAR_POINTS, RECIPES, RESEARCH_TOKENS_PER_PARCHMENT, RESOURCE_LABELS, TRADE_RATE, buildableRecipes } from "./rules.js";
import { allTokensUnknown, basisNote, factionOf, formatFaction, investmentsOf, mergeInvestments, quotaLines } from "./provider-stats.js";

export const SCHEMA = 1;

/** §10：開墾完成的門檻（試玩參數）；規則表在 core/rules.js。 */
export { CLEAR_POINTS } from "./rules.js";

const MINUTE_MS = 60_000;

/**
 * 合併同一個寫入者（sessionId + writerEpoch）的紀錄：事件取聯集、updatedAt 取最新。
 * 同一個檔案被讀到兩次、或兩份快照重疊時，都不會讓重播多算一次（§6.2）。
 * 未知 schema 的紀錄不猜，直接略過。
 */
export function mergeActivities(records) {
  const byWriter = new Map();
  for (const record of records ?? []) {
    if (!record || record.schema !== SCHEMA || typeof record.sessionId !== "string") continue;
    const key = `${record.sessionId}@@${record.writerEpoch ?? ""}`;
    const merged = byWriter.get(key);
    const events = dedupeEvents(record.events ?? []);
    if (!merged) {
      byWriter.set(key, { ...record, events });
      continue;
    }
    merged.events = dedupeEvents([...merged.events, ...events]);
    if ((record.updatedAt ?? 0) >= (merged.updatedAt ?? 0) && record.sessionName) merged.sessionName = record.sessionName;
    merged.updatedAt = Math.max(merged.updatedAt ?? 0, record.updatedAt ?? 0);
  }
  return [...byWriter.values()].sort((a, b) =>
    a.sessionId === b.sessionId
      ? String(a.writerEpoch ?? "").localeCompare(String(b.writerEpoch ?? ""))
      : a.sessionId.localeCompare(b.sessionId),
  );
}

/** 同一個 epoch 內 eventSeq 不會重複；重複出現時留時間較晚的那一筆。 */
function dedupeEvents(events) {
  const bySeq = new Map();
  for (const event of events) {
    const previous = bySeq.get(event.eventSeq);
    if (!previous || (event.at ?? 0) >= (previous.at ?? 0)) bySeq.set(event.eventSeq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.eventSeq - b.eventSeq);
}

/** 一支 session 重播後的樣子：身份、每個 visit、工作區間、用量。 */
function sessionOf(records) {
  const first = records[0];
  // 每個 epoch 有自己的時間軸（§6.2）：interval 分開算，再跟其他 epoch 取聯集，
  // 這樣晚到的 heartbeat 只會延長自己 epoch 內的區間。
  const intervals = records.flatMap((record) => intervalsOf(record.events));
  const visits = visitsOf(records.flatMap((record) => record.events));
  return {
    sessionId: first.sessionId,
    role: first.role ?? "root",
    cli: first.cli ?? null,
    parentSessionId: first.parentSessionId ?? null,
    interactive: records.some((record) => record.interactive === true),
    startedAt: earliestAt(intervals, visits),
    visits,
    intervals,
    usage: usageBySource(records),
  };
}

/**
 * 用量 key 為（cli、sessionId、來源 entry id）。每筆資料也保留發生時的 cityId，
 * 不能把跨城工作加到每個 visit 的格子裡。
 */
function usageBySource(records) {
  const bySource = new Map();
  for (const record of records) {
    const origin = `${record.cli ?? "unknown"}#${record.sessionId}`;
    let cityId = null;
    for (const event of record.events) {
      if (event.kind === "visit_start") {
        cityId = event.visit?.commonDir ?? null;
        continue;
      }
      if (event.kind === "visit_end") {
        cityId = null;
        continue;
      }
      if (event.kind !== "usage") continue;
      for (const [provider, usage] of Object.entries(event.usage ?? {})) {
        const source = usage.sourceKey ?? (event.sourceEntryId ? `${origin}#${event.sourceEntryId}` : `${origin}#${record.writerEpoch ?? ""}#${event.eventSeq}`);
        bySource.set(`${source}#${provider}`, { ...usage, provider, cityId, at: event.at });
      }
    }
  }
  return bySource;
}

function earliestAt(intervals, visits) {
  const times = [...intervals.map((interval) => interval.start), ...visits.map((visit) => visit.startedAt)];
  return times.length ? Math.min(...times) : 0;
}

/** visit 依時間排序；換 checkout 就是新的一段（§6.1）。 */
function visitsOf(events) {
  const visits = [];
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const previous = visits[visits.length - 1];
    if (event.kind === "visit_start" && event.visit) {
      if (previous) previous.endedAt = event.at;
      visits.push({
        visitId: event.visit.visitId,
        cwd: event.visit.cwd,
        commonDir: event.visit.commonDir ?? null,
        checkout: event.visit.checkout ?? null,
        startedAt: event.at,
        endedAt: null,
      });
    } else if (event.kind === "visit_end" && previous && previous.endedAt === null) {
      previous.endedAt = event.at;
    }
  }
  return visits;
}

/** §6.2：heartbeat 只延長自己 epoch 內尚未關閉、且屬於目前 visit 的 interval。 */
function intervalsOf(events) {
  const intervals = [];
  let cityId = null;
  let open = null;
  for (const event of events) {
    if (event.kind === "visit_start") {
      if (open) {
        open.end = Math.max(open.end, event.at);
        open.open = false;
        open = null;
      }
      cityId = event.visit?.commonDir ?? null;
    } else if (event.kind === "visit_end") {
      if (open) {
        open.end = Math.max(open.end, event.at);
        open.open = false;
        open = null;
      }
      cityId = null;
    } else if (event.kind === "interval_open") {
      open = { start: event.at, end: event.at, open: true, cityId };
      intervals.push(open);
    } else if (event.kind === "heartbeat") {
      if (open) open.end = Math.max(open.end, event.at);
    } else if (event.kind === "interval_close" && open) {
      open.end = Math.max(open.end, event.at);
      open.open = false;
      open = null;
    }
  }
  return intervals;
}

/** 聯集後的工作毫秒數：平行的 session 不會重複計算（§5.3）。 */
export function unionMs(intervals) {
  const sorted = intervals.filter((interval) => interval.end > interval.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let from = null;
  let to = null;
  for (const interval of sorted) {
    if (from === null) {
      from = interval.start;
      to = interval.end;
    } else if (interval.start > to) {
      total += to - from;
      from = interval.start;
      to = interval.end;
    } else {
      to = Math.max(to, interval.end);
    }
  }
  return from === null ? 0 : total + (to - from);
}

/** 城名取 canonical common dir 的 repo 名，不是某個 checkout 的名字：worktree 不換城名（§1）。 */
function cityNameOf(cityId, checkout) {
  const repoPath = cityId.endsWith("/.git") ? cityId.slice(0, -"/.git".length) : null;
  return (repoPath ?? checkout ?? cityId).split("/").filter(Boolean).pop() ?? cityId;
}

/**
 * 城鎮中心一律叫「城鎮中心」。`kind` 仍記得開城時 repo 有沒有 HEAD（舊 repo／新 repo，
 * 將來可能換圖），但它不是顯示給玩家的名字（§4）。
 */
function centerOf(cityId, repoFacts) {
  const hadHead = repoFacts[cityId]?.hadHead;
  const kind = hadHead === true ? "oldtown" : hadHead === false ? "founded" : "unknown";
  return { x: CENTER.x, y: CENTER.y, kind, label: "城鎮中心" };
}

/**
 * 還沒有任何遠征的空城：space 一開始就看得到城鎮中心與周圍揭開的格子，只是沒有任何格子
 * 在開墾。它不進帳本；第一支遠征出現後由帳本重建的真城取代它。
 */
export function emptyCity(cityId, name) {
  return {
    cityId,
    name,
    center: centerOf(cityId, {}),
    resources: { wood: 0, stone: 0, iron: 0, parchment: 0 },
    research: { tokens: 0 },
    market: { in: { wood: 0, stone: 0, iron: 0, parchment: 0 }, out: { wood: 0, stone: 0, iron: 0, parchment: 0 } },
    guild: null,
    investment: null,
    tiles: [],
    unharvestedCommits: [],
  };
}

/**
 * 重播接點：`{ activities, repoFacts }` → 公開城鎮讀取模型 `{ schema, cities }`。
 * 同一組事件重播幾次、紀錄在陣列裡怎麼排，結果都一樣。
 */
export function readTown(replay = {}) {
  return replayTown(replay, autoPlace);
}

/**
 * 帳本模式的重播接點（ticket #3）：格子位置由 journal 的「遠征取得土地」entry 決定，
 * activities 只提供身份、visit 與工作區間。沒有 entry 的遠征不會出現在地圖上。
 */
export function readTownFromLedger(replay = {}) {
  const expeditions = replay.expeditions ?? [];
  // 格子鍵要含 generation（#4）：重新派遣（#7）之後，新的一代不能蓋掉上一代。
  // 活動紀錄沒有 generation，所以它算到這支遠征**現役的那一代**頭上；
  // 其餘每一代各自是一格（工作 0、駐紮）。
  const spots = new Map();
  for (const entry of expeditions) {
    const key = `${entry.rootSessionId}@@${entry.cityId}`;
    const generation = entry.generation ?? 1;
    const current = spots.get(key);
    if (!current || generation > (current.generation ?? 1)) spots.set(key, { ...entry, generation });
  }
  const town = replayTown({ activities: replay.activities, repoFacts: replay.repoFacts }, (session, visit) => {
    const entry = spots.get(`${session.sessionId}@@${visit.commonDir}`);
    return entry
      ? {
          x: entry.x,
          y: entry.y,
          generation: entry.generation ?? 1,
          activatedAt: entry.activatedAt,
          deactivatedAt: entry.deactivatedAt,
          landStage: entry.landStage,
          harvestPoints: entry.harvestPoints ?? 0,
          workPoints: entry.workPoints ?? 0,
          boostPoints: entry.boostPoints ?? 0,
          building: entry.building ?? null,
          scrollsUsed: entry.scrollsUsed ?? 0,
          harvests: entry.harvests ?? [],
          // 有過 commit 收成的格不能撤回或封存（§5.2）：旗標要跟著盤面傳進公開模型。
          harvested: entry.harvested === true,
        }
      : null;
  });

  // 帳本有 entry、活動紀錄還沒到的格子也要畫出來（工作時間 0、狀態駐紮）。
  for (const entry of expeditions) {
    let city = town.cities.find((candidate) => candidate.cityId === entry.cityId);
    if (!city) {
      city = {
        cityId: entry.cityId,
        name: cityNameOf(entry.cityId, entry.repo?.checkout ?? null),
        center: centerOf(entry.cityId, replay.repoFacts ?? {}),
        resources: { wood: 0, stone: 0, iron: 0, parchment: 0 },
        research: { tokens: 0 },
        market: { in: { wood: 0, stone: 0, iron: 0, parchment: 0 }, out: { wood: 0, stone: 0, iron: 0, parchment: 0 } },
        guild: null,
        tiles: [],
        unharvestedCommits: replay.unharvestedCommits?.[entry.cityId] ?? [],
      };
      town.cities.push(city);
    }
    const generation = entry.generation ?? 1;
    if (city.tiles.some((tile) => tile.rootSessionId === entry.rootSessionId && tile.generation === generation)) {
      continue;
    }
    city.tiles.push(
      finishTile({
        cityId: entry.cityId,
        x: entry.x,
        y: entry.y,
        rootSessionId: entry.rootSessionId,
        generation,
        activatedAt: entry.activatedAt ?? entry.at ?? 0,
        deactivatedAt: entry.deactivatedAt ?? null,
        landStage: entry.landStage ?? null,
        cli: entry.cli ?? null,
        repo: entry.repo ?? { commonDir: entry.cityId, checkout: null },
        visits: [],
        sources: [],
        harvestPoints: entry.harvestPoints ?? 0,
        workPoints: entry.workPoints ?? 0,
        boostPoints: entry.boostPoints ?? 0,
        building: entry.building ?? null,
        scrollsUsed: entry.scrollsUsed ?? 0,
        harvests: entry.harvests ?? [],
        harvested: entry.harvested === true,
      }),
    );
  }
  const recordsById = new Map();
  for (const record of mergeActivities(replay.activities ?? [])) {
    if (!recordsById.has(record.sessionId)) recordsById.set(record.sessionId, []);
    recordsById.get(record.sessionId).push(record);
  }
  const sessions = [...recordsById.values()].map(sessionOf);
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const rootOf = (session) => {
    const seen = new Set();
    let current = session;
    while (current?.role === "child" && current.parentSessionId && !seen.has(current.sessionId)) {
      seen.add(current.sessionId);
      current = sessionById.get(current.parentSessionId);
    }
    return current?.sessionId ?? session.sessionId;
  };
  for (const city of town.cities) {
    city.tiles = city.tiles.map((tile) => {
      const root = sessionById.get(tile.rootSessionId);
      const sources = sessions.filter((session) =>
        rootOf(session) === tile.rootSessionId && session.visits.some((visit) => visit.commonDir === tile.cityId));
      const visits = root?.visits.filter((visit) => visit.commonDir === tile.cityId) ?? [];
      return finishTile({ ...tile, sources, visits, sessionName: replay.sessionNames?.[tile.rootSessionId] ?? null });
    });
  }
  for (const city of town.cities) {
    city.resources = replay.resources?.[city.cityId] ?? city.resources;
    city.research = replay.research?.[city.cityId] ?? city.research;
    city.market = replay.market?.[city.cityId] ?? city.market;
    city.unharvestedCommits = replay.unharvestedCommits?.[city.cityId] ?? [];
  }
  // 城的「主要行會」（§9）：把每一格的投資併起來，投入最多的 provider 就是這座城的行會。
  for (const city of town.cities) {
    city.investment = mergeInvestments(city.tiles.map((tile) => tile.investment));
    city.guild = city.investment.providers.length ? factionOf(city.investment) : null;
  }
  // 額度是帳號層級（同一帳號的多個 pane 共用一份），所以放在城鎮模型的最上層（§9）。
  // 沒有回報檔時不憑空多一個欄位（#11 的慣例）：畫面看到的就是「未知」。
  if (replay.quotas) town.quotas = replay.quotas;
  town.unresolvedActivities = replay.unresolvedActivities ?? [];
  return town;
}

/**
 * 帳本要寫的「取得土地」清單：順序與 `readTown` 的建格順序相同，
 * 帳本因此可以用同一套 BFS 規則重建出同一座城。
 */
export function planExpeditions(replay = {}) {
  const plans = [];
  replayTown(replay, (session, visit, cities) => {
    const spot = autoPlace(session, visit, cities);
    plans.push({
      cityId: visit.commonDir,
      rootSessionId: session.sessionId,
      at: visit.startedAt ?? session.startedAt,
      generation: spot.generation,
      x: spot.x,
      y: spot.y,
      cli: session.cli,
      repo: { commonDir: visit.commonDir, checkout: visit.checkout },
    });
    return spot;
  });
  return plans;
}

/** §4 的自動選地：從中心起 BFS，距離相同時依北、東、南、西。 */
function autoPlace(_session, visit, cities) {
  const city = cityFor(cities, visit.commonDir, visit.checkout);
  const spot = bfsNextTile((candidate) => city.taken.has(keyOf(candidate)));
  city.taken.add(keyOf(spot));
  return { x: spot.x, y: spot.y, generation: 1, activatedAt: visit.startedAt ?? 0 };
}

/**
 * 重播的核心。`place(session, visit, cities)` 決定這一格在哪裡；回 null 代表
 * 「這一次不算建格」（帳本裡沒有這筆 entry）。兩個接點共用同一段規則。
 */
function replayTown(replay, place) {
  const repoFacts = replay.repoFacts ?? {};
  const byId = new Map();
  for (const record of mergeActivities(replay.activities)) {
    const family = byId.get(record.sessionId);
    if (family) family.push(record);
    else byId.set(record.sessionId, [record]);
  }

  // 建格的順序依「這支 session 最早的事件」，跟紀錄在陣列裡的順序無關。
  const sessions = [...byId.values()].map(sessionOf);
  sessions.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));

  const cities = new Map();
  const tiles = new Map(); // `${sessionId}@@${cityId}` → 格子

  for (const session of sessions) {
    if (!createsTile(session)) continue;
    for (const visit of session.visits) {
      if (!visit.commonDir) continue; // 非 git 的 cwd 不建城（§4）
      const key = `${session.sessionId}@@${visit.commonDir}`;
      let tile = tiles.get(key);
      if (!tile) {
        const planned = place(session, visit, cities);
        if (!planned) continue;
        const city = cityFor(cities, visit.commonDir, visit.checkout);
        tile = newTile(session, city, visit, planned);
        tiles.set(key, tile);
        city.tiles.push(tile);
      }
      tile.repo.checkout = visit.checkout ?? tile.repo.checkout;
      tile.visits.push(visit);
    }
  }

  // child 的工作併入它往上追到的 root（§1）：區間取聯集，不另建格。
  for (const session of sessions) {
    if (session.role !== "child") continue;
    const tile = ancestorTile(tiles, sessionById, session);
    if (tile) tile.sources.push(session);
  }

  for (const city of cities.values()) {
    city.tiles = city.tiles.map(finishTile);
    city.name = cityNameOf(city.cityId, city.checkout);
    city.unharvestedCommits = replay.unharvestedCommits?.[city.cityId] ?? [];
    // 城的「主要行會」（§9）：併起每一格的投資，投入最多的 provider。
    city.investment = mergeInvestments(city.tiles.map((tile) => tile.investment));
    city.guild = city.investment.providers.length ? factionOf(city.investment) : null;
  }
  // 額度是帳號層級（§9）：replay 有帶回報檔才出現這個欄位，沒有就是未知。
  return {
    schema: SCHEMA,
    unresolvedActivities: replay.unresolvedActivities ?? [],
    ...(replay.quotas ? { quotas: replay.quotas } : {}),
    cities: [...cities.values()].map((city) => ({
      cityId: city.cityId,
      name: city.name,
      center: centerOf(city.cityId, repoFacts),
      // 收成（#4／#5）之前，庫存是空的（§10）。
      resources: { wood: 0, stone: 0, iron: 0, parchment: 0 },
      // 研究計量器與市集統計由帳本模式的 replay 帶進來（#8）。
      research: { tokens: 0 },
      market: { in: { wood: 0, stone: 0, iron: 0, parchment: 0 }, out: { wood: 0, stone: 0, iron: 0, parchment: 0 } },
      guild: city.guild,
      investment: city.investment,
      unharvestedCommits: city.unharvestedCommits,
      tiles: city.tiles,
    })),
  };
}

/** 只有互動的 root 與互動的 fork 建格；child 與 print／headless 不建格（§1、§6.1）。 */
function createsTile(session) {
  return session.interactive && session.role !== "child";
}

function cityFor(cities, cityId, checkout) {
  let city = cities.get(cityId);
  if (!city) {
    city = { cityId, name: null, checkout, taken: new Set(CENTER_CELLS.map(keyOf)), tiles: [] };
    cities.set(cityId, city);
  }
  if (!city.checkout) city.checkout = checkout;
  return city;
}

function newTile(session, city, visit, planned) {
  return {
    cityId: city.cityId,
    x: planned.x,
    y: planned.y,
    rootSessionId: session.sessionId,
    generation: planned.generation ?? 1,
    activatedAt: planned.activatedAt ?? session.startedAt,
    deactivatedAt: planned.deactivatedAt ?? null,
    landStage: planned.landStage ?? null,
    cli: session.cli,
    repo: { commonDir: city.cityId, checkout: visit.checkout },
    visits: [],
    sources: [session],
    harvestPoints: planned.harvestPoints ?? 0,
    workPoints: planned.workPoints ?? 0,
    boostPoints: planned.boostPoints ?? 0,
    building: planned.building ?? null,
    scrollsUsed: planned.scrollsUsed ?? 0,
    harvests: planned.harvests ?? [],
    harvested: planned.harvested === true,
  };
}

/** 還沒有任何用量時的加總起點。 */
export const ZERO_USAGE = { inputNonCache: 0, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 0 };

/**
 * 依城與遠征區間彙總 provider 投入。
 * 與派系／投資共用同一份聚合（core/provider-stats.js）：正規化留下的 0 佔位與未知欄位
 * 只算一次，不然「投入」與「派系」會看到兩套不同的未知狀態（§9）。
 */
function providerUsage(sources, cityId, startedAt, endedAt) {
  return investmentsOf(sources, cityId, startedAt, endedAt).providers.map((entry) => {
    const { provider, measured, unknownFields, ...usage } = entry;
    return { provider, usage: unknownFields?.length ? { ...usage, unknownFields } : usage };
  });
}

/** §10：自然工作、收成與加速點分開保存，再加總判斷開墾。 */
function finishTile(tile) {
  const startedAt = Number(tile.activatedAt ?? -Infinity);
  const endedAt = tile.deactivatedAt == null ? Infinity : Number(tile.deactivatedAt);
  const intervals = tile.sources.flatMap((session) => session.intervals
    .filter((interval) => interval.cityId === tile.cityId)
    .map((interval) => ({
      ...interval,
      start: Math.max(interval.start, startedAt),
      end: Math.min(interval.end, endedAt),
      open: interval.open && endedAt === Infinity,
    }))
    .filter((interval) => interval.end >= interval.start));
  const measuredWorkMs = unionMs(intervals);
  const workPoints = Math.max(Math.floor(measuredWorkMs / MINUTE_MS), tile.workPoints ?? 0);
  const workMs = Math.max(measuredWorkMs, workPoints * MINUTE_MS);
  const harvestPoints = tile.harvestPoints ?? 0;
  const boostPoints = tile.boostPoints ?? 0;
  const points = workPoints + harvestPoints + boostPoints;
  const derivedStage = points >= CLEAR_POINTS ? "cleared" : "reserved";
  // §9 的投資：一格只算自己的 visit 與可歸戶 child 的用量，並依 provider 分開。
  const investment = investmentsOf(tile.sources, tile.cityId, startedAt, endedAt);
  const rootInvestment = investmentsOf(
    tile.sources.filter((session) => session.sessionId === tile.rootSessionId),
    tile.cityId,
    startedAt,
    endedAt,
  );
  // 投入最多的 provider 決定派系；同分時取 root session 的 provider（§9）。
  const faction = factionOf(investment, factionOf(rootInvestment).provider);
  return {
    cityId: tile.cityId,
    x: tile.x,
    y: tile.y,
    rootSessionId: tile.rootSessionId,
    sessionName: tile.sessionName ?? null,
    generation: tile.generation,
    activatedAt: tile.activatedAt,
    deactivatedAt: tile.deactivatedAt,
    cli: tile.cli,
    repo: tile.repo,
    visits: tile.visits,
    workMs,
    workPoints,
    harvestPoints,
    boostPoints,
    points,
    // 蓋房與加速的實際支付（§7.6、§10 的造價顯示）：建築保留在格子上，收成照常發生。
    building: tile.building ?? null,
    scrollsUsed: tile.scrollsUsed ?? 0,
    harvests: tile.harvests ?? [],
    providerUsage: providerUsage(tile.sources, tile.cityId, startedAt, endedAt),
    investment,
    faction,
    usage: investment.total,
    harvested: tile.harvested === true,
    landStage: tile.landStage ?? derivedStage,
    status: intervals.some((interval) => interval.open) ? "active" : "idle",
  };
}

/** child → 執行中的上層 → … → 實際建格的那支 root。 */
function ancestorTile(tiles, sessionById, session) {
  let parentId = session.parentSessionId;
  for (let depth = 0; depth < 16 && parentId; depth++) {
    const matches = [...tiles.values()].filter((tile) => tile.rootSessionId === parentId);
    if (matches.length) {
      const cityId = session.visits.find((visit) => visit.commonDir)?.commonDir;
      return matches.find((tile) => tile.cityId === cityId) ?? matches[0];
    }
    const parent = sessionById.get(parentId);
    if (!parent) return null;
    parentId = parent.parentSessionId;
  }
  return null;
}

/**
 * 右側詳情：遠征與它的地圖格給同一份資料，所以點哪一邊都同步（§14.1）。
 * 沒有選取、選到迷霧或選不到遠征時，還是回一份可以畫的資料。
 */
export function selectionDetail(town, selection) {
  const cities = town?.cities ?? [];
  const city = (selection?.cityId ? cities.find((c) => c.cityId === selection.cityId) : cities[0]) ?? null;
  if (!city) return detail("none", null, null, "沒有城鎮", null, []);

  if (selection?.kind === "expedition") {
    const matches = city.tiles.filter((candidate) => candidate.rootSessionId === selection.rootSessionId);
    const tile = matches.find((candidate) => candidate.generation === selection.generation) ??
      matches.reduce((latest, candidate) =>
        !latest || candidate.generation > latest.generation ? candidate : latest, null);
    return tile ? expeditionDetail(city, tile) : detail("none", city, null, "找不到這支遠征", null, []);
  }

  if (selection?.kind === "tile") {
    const tile = city.tiles.find((candidate) => candidate.x === selection.x && candidate.y === selection.y);
    if (tile) return expeditionDetail(city, tile);
    if (isCenterCell(selection)) return centerDetail(city, town.quotas);
    const spot = { x: selection.x, y: selection.y };
    // 看得到地面但還沒有遠征進駐的空地（中心塊旁邊與已開墾格的鄰格），和還罩著迷霧的格子分開。
    return revealedKeys(city.tiles).has(keyOf(spot))
      ? detail("open", city, spot, "空地", null, [])
      : detail("fog", city, spot, "迷霧", null, []);
  }

  return detail("none", city, null, "未選取", null, []);
}

function detail(kind, city, tile, title, statusLabel, fields) {
  return {
    kind,
    // §12、§14.1：歷程搜尋由「選取遠征或格子（含中心格、迷霧格）的詳情」進入，
    // 不常駐擠壓地圖；只有「沒有城」時沒有入口。
    historyEntry: kind !== "none",
    cityId: city?.cityId ?? null,
    cityName: city?.name ?? null,
    tile,
    title,
    statusLabel,
    points: null,
    pointsTarget: null,
    // 蓋房、加速的條件（§7.6）；操作入口在底部動作列。
    buildable: [],
    buildBlocked: null,
    boost: null,
    harvests: [],
    // 派系、投入與行會人力只影響顯示（§9）：遠征給自己的，中央格給整座城與帳號額度。
    faction: null,
    investment: null,
    investmentNote: null,
    quota: [],
    fields,
  };
}

/** 這一格現在不能蓋房的原因；null＝可以蓋（庫存夠不夠由動作列的面板另外標示）。 */
function buildBlockedReason(tile) {
  if (tile.landStage === "withdrawn" || tile.landStage === "archived") return "這一格已撤回或封存";
  if (tile.landStage === "built") return "這一格已經蓋了房";
  if (tile.landStage !== "cleared") return "這一格還沒開墾完成（要滿 100 點）";
  return null;
}

function expeditionDetail(city, tile) {
  const actions = tile.landStage === "withdrawn" || tile.landStage === "archived"
    ? ["redispatch"]
    : !tile.harvested && tile.landStage === "reserved"
      ? ["withdraw"]
      : !tile.harvested && tile.landStage === "cleared"
        ? ["archive"]
        : [];
  const stageLabel = ({
    reserved: "預留",
    cleared: "已開墾",
    built: "已建",
    withdrawn: "已撤回",
    archived: "已封存",
  })[tile.landStage] ?? "預留";
  return {
    kind: "expedition",
    historyEntry: true,
    cityId: city.cityId,
    cityName: city.name,
    rootSessionId: tile.rootSessionId,
    generation: tile.generation,
    tile: { x: tile.x, y: tile.y, landStage: tile.landStage ?? "reserved", harvested: tile.harvested === true },
    title: tile.sessionName?.trim() ? `${tileLabel(tile)}${tile.generation > 1 ? ` · 第 ${tile.generation} 代` : ""}` : `遠征 ${shortId(tile.rootSessionId)} · 第 ${tile.generation} 代`,
    statusLabel: tile.status === "active" ? "探索中" : "駐紮",
    points: tile.points,
    pointsTarget: CLEAR_POINTS,
    actions,
    actionUnavailableReason: tile.harvested ? "已有 commit 收成，不能撤回或封存" : null,
    // §7.6：蓋房與加速的入口在底部動作列；這裡只提供這一格的條件（不能做的原因）。
    buildable: tile.landStage === "cleared" ? buildableRecipes(city.resources) : [],
    buildBlocked: buildBlockedReason(tile),
    boost: boostDetail(city, tile),
    harvests: harvestList(tile),
    // §9：這一格的投資（依 provider 分開）決定建築派系；畫面要標明比較基準的限制。
    faction: tile.faction,
    investment: tile.investment,
    investmentNote: basisNote(tile.investment),
    fields: [
      { label: "工作時間", value: formatDuration(tile.workMs) },
      { label: "工作區間", value: `${formatTimestamp(tile.activatedAt)} – ${tile.deactivatedAt == null ? "進行中" : formatTimestamp(tile.deactivatedAt)}`, dev: true },
      ...(tile.visits ?? []).map((visit, index) => ({
        label: `Visit ${index + 1}`,
        value: `${formatTimestamp(visit.startedAt)} – ${visit.endedAt == null ? "進行中" : formatTimestamp(visit.endedAt)} · ${visit.checkout ?? visit.cwd ?? "路徑未知"}`,
        dev: true,
      })),
      ...(tile.providerUsage ?? []).map(({ provider, usage }) => ({
        label: `投入 ${provider}`,
        // 每個欄位各自判斷未知（formatUsage）：部分未知時只有那個欄位是「未知」，不是 0。
        value: formatUsage(usage),
        dev: true,
      })),
      { label: "點數", value: `工作 ${tile.workPoints} · 收成 ${tile.harvestPoints} · 加速 ${tile.boostPoints}`, dev: true },
      { label: "用量", value: formatUsage(tile.usage), dev: true },
      { label: "派系", value: formatFaction(tile.faction) },
      { label: "土地", value: stageLabel },
      ...(tile.building ? [{
        label: "建築",
        value: `${RECIPES[tile.building.recipe]?.label ?? tile.building.recipe}（實付 ${formatCosts(tile.building.costs)}）`,
      }] : []),
      ...(tile.scrollsUsed ? [{ label: "加速用量", value: `${tile.scrollsUsed} 張羊皮卷` }] : []),
      { label: "座標", value: `${tile.x}, ${tile.y}`, dev: true },
      { label: "CLI", value: tile.cli ?? "未知", dev: true },
      { label: "session", value: tile.rootSessionId, dev: true },
      { label: "checkout", value: tile.repo.checkout ?? tile.repo.commonDir, dev: true },
    ],
  };
}

/**
 * 加速（§7.6）：目標必須是同城、現役的那一代、沒有撤回或封存、未滿 100 點，而且庫存足夠。
 * 畫面一次用掉「還差多少就滿 100」與庫存中較小的那個張數，超出的點數不退。
 */
function boostDetail(city, tile) {
  const stock = Number(city.resources?.parchment ?? 0);
  const current = city.tiles.reduce(
    (latest, candidate) => candidate.rootSessionId === tile.rootSessionId && candidate.generation > (latest?.generation ?? 0)
      ? candidate
      : latest,
    null,
  );
  const reason = tile.landStage === "withdrawn" || tile.landStage === "archived"
    ? "已撤回或封存"
    : tile.generation !== (current?.generation ?? tile.generation) ? "不是現役的那一代"
      : tile.points >= CLEAR_POINTS ? "已滿 100 點"
        : stock <= 0 ? "沒有羊皮卷"
          : null;
  const toClear = Math.max(1, Math.ceil((CLEAR_POINTS - tile.points) / BOOST_POINTS_PER_PARCHMENT));
  return {
    available: reason === null,
    reason,
    stock,
    scrolls: Math.min(stock, toClear),
    pointsPerScroll: BOOST_POINTS_PER_PARCHMENT,
  };
}

/** 配方的實付資源一行（§10 的造價顯示）。 */
function formatCosts(costs = {}) {
  return Object.entries(costs).map(([key, amount]) => `${RESOURCE_LABELS[key] ?? key}${amount}`).join("・");
}

function centerDetail(city, quotas = null) {
  const stock = city.resources;
  const inventory = `木材 ${stock.wood} · 石材 ${stock.stone} · 鐵料 ${stock.iron} · 羊皮卷 ${stock.parchment}`;
  // 行會人力（§9）：這座城投入過的 provider，加上回報檔裡的其他 provider；沒有的顯示未知。
  const providers = (city.investment?.providers ?? []).map((entry) => entry.provider);
  return {
    kind: "center",
    historyEntry: true,
    cityId: city.cityId,
    cityName: city.name,
    tile: { x: city.center.x, y: city.center.y },
    title: `${city.name} · ${city.center.label}`,
    statusLabel: null,
    points: null,
    pointsTarget: null,
    quota: quotaLines(quotas, { providers }),
    // 市集、蓋房與加速在底部動作列（core/dock.js）：中心格只放城的資訊。
    buildable: [],
    boost: null,
    buildBlocked: null,
    fields: [
      { label: "身份", value: city.center.label },
      { label: "座標", value: `${city.center.x}, ${city.center.y}（2×2）`, dev: true },
      { label: "遠征", value: `${city.tiles.length} 支` },
      { label: "來源不明", value: `${city.unharvestedCommits?.length ?? 0} 筆（不發資源，無人工補領）` },
      { label: "主要行會", value: city.guild ? formatFaction(city.guild) : "未知" },
      { label: "研究", value: formatResearch(city.research) },
      { label: "市集", value: formatMarket(city.market) },
      { label: "城的身份", value: city.cityId, dev: true },
    ],
  };
}

/** §7.4：這座城還沒換成羊皮卷的研究進度（計量器餘數）。 */
export function formatResearch(research = {}) {
  const tokens = Number(research?.tokens ?? 0);
  return `${tokens} / ${RESEARCH_TOKENS_PER_PARCHMENT}（每 ${RESEARCH_TOKENS_PER_PARCHMENT.toLocaleString("en-US")} 換 1 張）`;
}

/** §11：市集轉入與轉出跟 commit 的直接發放分開顯示。 */
export function formatMarket(market = {}) {
  const entries = (side) => Object.entries(market?.[side] ?? {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([key, amount]) => `${RESOURCE_LABELS[key] ?? key} ${amount}`);
  const inSide = entries("in");
  const outSide = entries("out");
  if (!inSide.length && !outSide.length) return "還沒有交易";
  return `轉入 ${inSide.join("・") || "無"} · 轉出 ${outSide.join("・") || "無"}`;
}

/**
 * 土地的顯示名稱：綁定的 session 的名稱（omp 的 session title，使用者可以改）；
 * 還沒有名稱時退回短 id，不讓畫面出現空白。
 */
export function tileLabel(tile) {
  const name = typeof tile.sessionName === "string" ? tile.sessionName.trim() : "";
  return name || `遠征 ${shortId(tile.rootSessionId)}`;
}

function shortId(sessionId) {
  return String(sessionId).slice(0, 8);
}

export function formatDuration(ms) {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分` : `${hours} 小時`;
}

/** Date 的可表示上限：超出範圍的 `at`（壞掉的證據檔）顯示未知，不讓 render 丟例外。 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

function formatTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= MAX_EPOCH_MS
    ? new Date(timestamp).toLocaleString("zh-TW")
    : "時間未知";
}

/**
 * 右側詳情的用量一行：進／出與快取，價格未知時明說，不假裝是 0。
 * `usage.unknownFields` 裡的欄位是正規化留下的 0 佔位，逐欄顯示「未知」；已知欄位照常。
 */
export function formatUsage(usage = ZERO_USAGE) {
  const cost = usage.costKnown > 0 ? ` · 成本 ${usage.costKnown.toFixed(4)}` : "";
  const unknown = usage.costUnknownEntries > 0 ? ` · ${usage.costUnknownEntries} 筆價格未知` : "";
  // 四個 token 欄位都沒有回報時，數字是正規化的 0 佔位，不是「用量 0」（§9）。
  if (allTokensUnknown(usage)) return `未知（欄位未回報）${cost}${unknown}`;
  const missing = new Set(usage.unknownFields ?? []);
  const field = (key, label, value) => `${label} ${missing.has(key) ? "未知" : value}`;
  const parts = [
    field("inputNonCache", "進", usage.inputNonCache),
    field("output", "出", usage.output),
    field("cacheRead", "快取讀", usage.cacheRead),
    field("cacheWrite", "快取寫", usage.cacheWrite),
  ];
  return `${parts.join(" · ")}${cost}${unknown}`;
}

/**
 * 這一格收成過的 commit 清單（右側詳情只顯示筆數，清單在「成果」面板）。
 * `detail` 是 sha、claim、路徑與規則版本，只有開發模式才顯示。
 */
function harvestList(tile) {
  return (tile.harvests ?? []).map((harvest) => ({
    subject: harvest.subject || "commit",
    sha: harvest.sha ?? null,
    resources: formatCosts(harvest.resources),
    detail: `claim ${(harvest.claims ?? []).slice(0, 2).join(", ") || "已記錄"}${(harvest.claimCount ?? 0) > 2 ? "…" : ""} · 路徑 ${(harvest.paths ?? []).slice(0, 2).join(", ") || `${harvest.pathCount ?? 0} 筆`} · 規則 v${harvest.rulesVersion ?? "?"}`,
  }));
}
