// mock 素材（proposal §14）：正式美術（5 種建築 × 4 套派系風格等約 39 張圖）還沒到位，
// 這一層用「明確標示的向量 mock」代替，讓功能可以完整試玩，不因缺圖而擋住。
//
// 這一支是純資料＋純函式（不 import gpui-kit／herdr），所以 bun 可以直接測它；
// 畫面在 ui/map.js 與 main.js，兩邊的對應由 test/assets.test.js 釘住。
//
// 規則（只影響顯示，不影響任何數值）：
// - 派系：沿用 core/provider-stats.js 的 provider；顏色用主題的 token，深淺主題都對比夠。
// - 地面：依這一格**收成過的資源**（最多者）決定 mock 的「地」；還沒有收成 → 勘查地。
// - 建築：帳本裡的配方名（core/rules.js），高度依種類不同（城牆最矮、圖書館最高）。

/** 派系 mock：provider → 顏色 token 與代號。沒有可歸戶用量時是「無派系」。 */
export const FACTION_MOCK = {
  anthropic: { label: "Anthropic", token: "ansi3", glyph: "A" },
  "openai-codex": { label: "OpenAI", token: "ansi2", glyph: "O" },
  google: { label: "Google", token: "ansi4", glyph: "G" },
  databricks: { label: "Databricks", token: "ansi5", glyph: "D" },
};
export const NO_FACTION = { id: "none", label: "無派系", token: "muted", glyph: "–" };

/** 地面 mock：收成過的資源 → 地。`survey` 是「還沒有收成」的勘查地，不是猜測。 */
export const GROUND_MOCK = {
  wood: { label: "伐木地", token: "ansi2" },
  stone: { label: "採石地", token: "muted" },
  iron: { label: "礦地", token: "ansi4" },
  parchment: { label: "抄寫地", token: "ansi3" },
  survey: { label: "勘查地", token: "ansi6" },
};

/** 土地階段（§5.1：狀態與土地分開記）→ 畫面標記；圖例、左側卡片與詳情共用同一份文字。 */
export const STAGE_MARKS = {
  reserved: { label: "◇ 預留", token: "working" },
  cleared: { label: "◆ 已開墾", token: "done" },
  built: { label: "▲ 已建", token: "accent" },
  withdrawn: { label: "⊘ 已撤回", token: "dim" },
  archived: { label: "▨ 已封存", token: "dim" },
};

/**
 * 建築 mock 的輪廓：百分比的座標（相對於那一格的方框），
 * `top` 是屋脊、`eave` 是屋簷、`base` 是牆腳；不同種類高度不同（驗收要看得出高矮）。
 * 位置落在格子的中段，所以不會蓋到下半部的遠征標籤。
 */
export const BUILDING_MOCK = {
  wall: { label: "城牆", top: 40, eave: 46, base: 60, roof: false },
  house: { label: "民居", top: 30, eave: 45, base: 60, roof: true },
  workshop: { label: "工坊", top: 26, eave: 43, base: 60, roof: true },
  warehouse: { label: "倉庫", top: 21, eave: 41, base: 60, roof: true },
  library: { label: "圖書館", top: 14, eave: 39, base: 60, roof: true },
};

/** 一格的地面「地盤」菱形（百分比座標）：鋪在地面顏色上，建築站在它上面。 */
export const PLOT_DIAMOND = [[50, 26], [86, 50], [50, 74], [14, 50]];

/** 一格的土地階段標記；沒有階段（舊資料）當成預留。 */
export function stageOf(tile) {
  return STAGE_MARKS[tile?.landStage] ?? STAGE_MARKS.reserved;
}

/** 派系的畫面樣式：沒有可歸戶的 provider 就用「無派系」，不猜。 */
export function factionStyle(faction) {
  const provider = faction?.provider ?? null;
  if (!provider) return { ...NO_FACTION };
  return {
    id: provider,
    ...(FACTION_MOCK[provider] ?? { label: provider, token: "ansi6", glyph: provider.slice(0, 1).toUpperCase() }),
  };
}

/** 這一格的地：收成過的資源裡最多的那一種；沒有收成 → 勘查地。 */
export function groundOf(tile) {
  const totals = { wood: 0, stone: 0, iron: 0, parchment: 0 };
  for (const harvest of tile?.harvests ?? []) {
    for (const key of Object.keys(totals)) totals[key] += Number(harvest.resources?.[key] ?? 0);
  }
  let best = null;
  for (const key of Object.keys(totals)) {
    if (totals[key] <= 0) continue;
    if (!best || totals[key] > totals[best]) best = key;
  }
  return best ?? "survey";
}

/** 這一格的建築 mock（沒有建築回 null）：配方名 → 輪廓；未知配方用民居的輪廓表示。 */
export function buildingOf(tile) {
  const recipe = tile?.building?.recipe ?? null;
  if (!recipe) return null;
  return { recipe, ...(BUILDING_MOCK[recipe] ?? { ...BUILDING_MOCK.house, label: recipe }) };
}

/** 建築的兩個多邊形（百分比座標）：`painted` 用尺寸撐開，所以任何格子大小都成立。 */
export function buildingPolygons(mock) {
  const { top, eave, base } = mock;
  return {
    roof: [[50, top], [78, eave], [22, eave]],
    body: [[24, eave], [76, eave], [76, base], [24, base]],
  };
}

/** 圖例的資料（地圖左上角）：狀態、地面與派系全部來自上面的表，測試對的就是這一組。 */
export function legendGroups() {
  return {
    stage: Object.values(STAGE_MARKS),
    ground: Object.entries(GROUND_MOCK).map(([key, entry]) => ({ key, ...entry })),
    faction: [...Object.values(FACTION_MOCK), NO_FACTION],
  };
}

/** 左側摘要用的土地階段計數：依 STAGE_MARKS 的順序，只列真的有出現的階段。 */
export function stageCounts(tiles = []) {
  const counts = new Map();
  for (const tile of tiles) {
    const stage = tile?.landStage && STAGE_MARKS[tile.landStage] ? tile.landStage : "reserved";
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  return Object.keys(STAGE_MARKS)
    .filter((stage) => counts.has(stage))
    .map((stage) => ({ stage, count: counts.get(stage), ...STAGE_MARKS[stage] }));
}
