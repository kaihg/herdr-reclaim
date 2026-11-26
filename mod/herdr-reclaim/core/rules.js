// 規則表（proposal §7.4、§8、§10；#22 之後只有共用城市）：匯率、配方、工期與揭開半徑。
// 這一層是純資料，沒有 I/O；每一次操作都會把當時的 `RULES_VERSION` 存進快照（§8.2），
// 之後調整數值不會改寫已經落帳的結果。
//
// 版本歷程：
//   4  ticket #23 共用城市的基本收入：每 10,000 個有效 token 收木 3、石 2、鐵 1
//   5  ticket #24 明確成果的額外收成：每個歸屬確定、帶來新內容的 commit 另收木 3、石 2、鐵 1
//   6  ticket #25 共用城市的建築占地與配方（市場、書庫、工坊、民居）；選址不動庫存
//   7  ticket #26 共用城市的工期與完工揭開半徑；備齊自動開工、到期完工
//   8  ticket #27 哨站：沿用選址、備料與施工，完工揭開比一般建築更大片的土地
//   9  停止 commit 加碼（#28、ADR 0002）：不再產生成果收成；已落帳的照常重播
//   10 建設佇列（ADR 0003）：同時多項預定（上限 3）、預定不動庫存、排到隊首才付料、未開工可取消（不退款）
//   11 新城：開城時將地形版本、道路臂長與起始庫存寫進帳本。
//   12 工期改以份計；每筆收入與它引發的施工變化同一次提交。
export const UNIT_CONSTRUCTION_VERSION = 12;
export const RULES_VERSION = UNIT_CONSTRUCTION_VERSION;
export const TERRAIN_VERSION = 1;
export const START_ROAD_LENGTH = 3;
export const START_RESOURCES = { wood: 70, stone: 35, iron: 6 };

/**
 * 建設佇列的上限（規則版本 10，試玩參數）：同時最多這麼多項預定（含施工中的那一項）。
 * 上限只擋新的預定，不會擋完工與取消；佇列的內容寫在帳本裡，重開、換 space 都一樣。
 */
export const BUILD_QUEUE_LIMIT = 3;

/** 庫存裡的資源種類。羊皮卷已不再生產（舊玩法移除），保留鍵名讓舊快照重播時不變形。 */
export const RESOURCES = ["wood", "stone", "iron", "parchment"];

export const RESOURCE_LABELS = { wood: "木材", stone: "石材", iron: "鐵料", parchment: "羊皮卷" };

/**
 * #25：共用城市的建築表——占地是整片土地（不是屋頂大小），配方是備齊後才一次支付的完整材料。
 * `buildUnits` 是開工後還需的工作份數；`reveal` 是完工後往占地外揭開幾格（切比雪夫距離）。
 * #27：哨站（`outpost`）沿用同一套流程，只是完工揭開的範圍更大。
 * 配方與工期只看建築種類，不看占地上是草地、疏林還是碎石（試玩參數）。
 */
export const BUILDINGS_V12 = {
  house: { label: "民居", footprint: { w: 1, h: 1 }, costs: { wood: 20, stone: 10 }, buildUnits: 14, reveal: 2 },
  workshop: { label: "工坊", footprint: { w: 2, h: 1 }, costs: { wood: 30, iron: 5 }, buildUnits: 21, reveal: 2 },
  market: { label: "市場", footprint: { w: 2, h: 2 }, costs: { wood: 40, stone: 20 }, buildUnits: 12, reveal: 2 },
  library: { label: "書庫", footprint: { w: 2, h: 2 }, costs: { wood: 20, stone: 20, iron: 5 }, buildUnits: 14, reveal: 2 },
  outpost: { label: "哨站", footprint: { w: 1, h: 1 }, costs: { wood: 25, stone: 15, iron: 5 }, buildUnits: 4, reveal: 5 },
};
export const CITY_BUILDINGS = BUILDINGS_V12;

/** 舊 journal 的開工記號是時刻；新版是份數（第零份也能下令開工）。 */
export const isBuilding = (item) => item.startedUnit != null || item.startedAt != null;

/** 庫存足以支付完整配方（§7.6：畫面只列這些）。 */
export function affordable(costs, resources = {}) {
  return Object.entries(costs ?? {}).every(([key, need]) => Number(resources?.[key] ?? 0) >= Number(need));
}

/** #23：共用城市的基本收入——每 WORK_TOKENS_PER_UNIT 個有效 token 收成一份建材（試玩參數）。 */
export const WORK_TOKENS_PER_UNIT = 10_000;

/** 一份收成的建材。羊皮卷不在其中：日常工作只供應基本建材。 */
export const WORK_YIELD = { wood: 3, stone: 2, iron: 1 };

/**
 * 一批有效工作的收成：整份的建材（計量器餘數由帳本的 work.tokens 另外保留）。
 * 長短對話、換 provider、換專案只改變 token 從哪裡來，收成只依 token 總量。
 */
export function workYieldOf(tokens = 0) {
  const units = Math.floor(Number(tokens ?? 0) / WORK_TOKENS_PER_UNIT);
  return Object.fromEntries(Object.entries(WORK_YIELD).map(([key, amount]) => [key, amount * units]));
}

