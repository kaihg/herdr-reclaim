// 城鎮讀取模型：把 adapter 的活動紀錄（§6.1）重播成可觀察的城鎮狀態（§4、§5）。
//
// 兩個接點共用同一段重播規則：
//   readTown({ activities, repoFacts })        直接重播活動，格子位置由 §4 的 BFS 決定（#2）
//   readTownFromLedger({ activities, expeditions, repoFacts })  格子位置由 journal 的
//                                              「遠征取得土地」entry 決定（#3）
// 土地生命週期、commit 收成、建築與額度由 #4／#5 接上；庫存與行會在這裡先固定成
// 「還沒有收成」與「沒有額度來源」。
import { CENTER, bfsNextTile, keyOf } from "./grid.js";

export const SCHEMA = 1;

/** §10：開墾完成的門檻（試玩參數）。 */
export const CLEAR_POINTS = 100;

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
        bySource.set(`${source}#${provider}`, { ...usage, cityId });
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

function centerOf(cityId, repoFacts) {
  const hadHead = repoFacts[cityId]?.hadHead;
  const label = hadHead === true ? "舊城區" : hadHead === false ? "新村" : "城鎮中心";
  const kind = hadHead === true ? "oldtown" : hadHead === false ? "founded" : "unknown";
  return { x: CENTER.x, y: CENTER.y, kind, label };
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
      ? { x: entry.x, y: entry.y, generation: entry.generation ?? 1, harvestPoints: entry.harvestPoints ?? 0 }
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
        cli: entry.cli ?? null,
        repo: entry.repo ?? { commonDir: entry.cityId, checkout: null },
        visits: [],
        sources: [],
        harvestPoints: entry.harvestPoints ?? 0,
      }),
    );
  }
  for (const city of town.cities) {
    city.resources = replay.resources?.[city.cityId] ?? city.resources;
    city.unharvestedCommits = replay.unharvestedCommits?.[city.cityId] ?? [];
  }
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
      at: session.startedAt,
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
  return { x: spot.x, y: spot.y, generation: 1 };
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
  }

  return {
    schema: SCHEMA,
    cities: [...cities.values()].map((city) => ({
      cityId: city.cityId,
      name: city.name,
      center: centerOf(city.cityId, repoFacts),
      // 收成（#4／#5）之前，庫存是空的；行會沒有額度來源時顯示未知（§9）。
      resources: { wood: 0, stone: 0, iron: 0, parchment: 0 },
      guild: null,
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
    city = { cityId, name: null, checkout, taken: new Set([keyOf(CENTER)]), tiles: [] };
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
    generation: planned.generation ?? 1, // 重新派遣（#7）才會往上加
    cli: session.cli,
    repo: { commonDir: city.cityId, checkout: visit.checkout },
    visits: [],
    sources: [session],
    // 收成點數由帳本帶進來（§10：自然工作、收成、加速三種點數分開保存）。
    harvestPoints: planned.harvestPoints ?? 0,
  };
}

/** 還沒有任何用量時的加總起點。 */
export const ZERO_USAGE = { inputNonCache: 0, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 0 };

/**
 * 一格（或一支遠征）的用量：root 加上併進來的 child，同一把來源 key 只算一次（§6.1、§15.6）。
 * 每筆用量依發生時的 cityId 歸城；child 的用量依 S1 歸到 root 遠征。
 */
function sumUsage(sources, cityId) {
  const total = { ...ZERO_USAGE };
  const unknownFields = new Set();
  for (const session of sources) {
    for (const usage of session.usage.values()) {
      if (usage.cityId !== cityId) continue;
      for (const key of Object.keys(total)) total[key] += Number(usage[key]) || 0;
      for (const field of usage.unknownFields ?? []) unknownFields.add(field);
    }
  }
  if (unknownFields.size) total.unknownFields = [...unknownFields].sort();
  return total;
}

/** §10：總點數 = floor(自然工作毫秒 / 60_000) + 收成點數。 */
function finishTile(tile) {
  const intervals = tile.sources.flatMap((session) => session.intervals.filter((interval) => interval.cityId === tile.cityId));
  const workMs = unionMs(intervals);
  const harvestPoints = tile.harvestPoints ?? 0;
  const points = Math.floor(workMs / MINUTE_MS) + harvestPoints;
  return {
    cityId: tile.cityId,
    x: tile.x,
    y: tile.y,
    rootSessionId: tile.rootSessionId,
    generation: tile.generation,
    cli: tile.cli,
    repo: tile.repo,
    visits: tile.visits,
    workMs,
    points,
    usage: sumUsage(tile.sources, tile.cityId),
    harvestPoints,
    landStage: points >= CLEAR_POINTS ? "cleared" : "reserved",
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
    const tile = city.tiles.find((candidate) => candidate.rootSessionId === selection.rootSessionId);
    return tile ? expeditionDetail(city, tile) : detail("none", city, null, "找不到這支遠征", null, []);
  }

  if (selection?.kind === "tile") {
    const tile = city.tiles.find((candidate) => candidate.x === selection.x && candidate.y === selection.y);
    if (tile) return expeditionDetail(city, tile);
    if (selection.x === city.center.x && selection.y === city.center.y) return centerDetail(city);
    return detail("fog", city, { x: selection.x, y: selection.y }, "迷霧", null, []);
  }

  return detail("none", city, null, "未選取", null, []);
}

function detail(kind, city, tile, title, statusLabel, fields) {
  return {
    kind,
    cityId: city?.cityId ?? null,
    cityName: city?.name ?? null,
    tile,
    title,
    statusLabel,
    points: null,
    pointsTarget: null,
    fields,
  };
}

function expeditionDetail(city, tile) {
  return {
    kind: "expedition",
    cityId: city.cityId,
    cityName: city.name,
    tile: { x: tile.x, y: tile.y },
    title: `遠征 ${shortId(tile.rootSessionId)}`,
    statusLabel: tile.status === "active" ? "探索中" : "駐紮",
    points: tile.points,
    pointsTarget: CLEAR_POINTS,
    fields: [
      { label: "工作時間", value: formatDuration(tile.workMs) },
      { label: "用量", value: formatUsage(tile.usage) },
      { label: "土地", value: tile.landStage === "cleared" ? "已開墾" : "預留" },
      { label: "座標", value: `${tile.x}, ${tile.y}` },
      { label: "CLI", value: tile.cli ?? "未知" },
      { label: "session", value: tile.rootSessionId },
      { label: "checkout", value: tile.repo.checkout ?? tile.repo.commonDir },
    ],
  };
}

function centerDetail(city) {
  const stock = city.resources;
  const inventory = `木材 ${stock.wood} · 石材 ${stock.stone} · 鐵料 ${stock.iron} · 羊皮卷 ${stock.parchment}`;
  return {
    kind: "center",
    cityId: city.cityId,
    cityName: city.name,
    tile: { x: city.center.x, y: city.center.y },
    title: `${city.name} · ${city.center.label}`,
    statusLabel: null,
    points: null,
    pointsTarget: null,
    fields: [
      { label: "身份", value: city.center.label },
      { label: "座標", value: `${city.center.x}, ${city.center.y}` },
      { label: "遠征", value: `${city.tiles.length} 支` },
      { label: "庫存", value: inventory },
      { label: "城的身份", value: city.cityId },
    ],
  };
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

/** 右側詳情的用量一行：進／出與快取，價格未知時明說，不假裝是 0。 */
export function formatUsage(usage = ZERO_USAGE) {
  const parts = [
    `進 ${usage.inputNonCache}`,
    `出 ${usage.output}`,
    `快取讀 ${usage.cacheRead}`,
    `快取寫 ${usage.cacheWrite}`,
  ];
  const cost = usage.costKnown > 0 ? ` · 成本 ${usage.costKnown.toFixed(4)}` : "";
  const unknown = usage.costUnknownEntries > 0 ? ` · ${usage.costUnknownEntries} 筆價格未知` : "";
  return `${parts.join(" · ")}${cost}${unknown}`;
}
