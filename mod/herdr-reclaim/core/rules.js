// 規則表（proposal §7.4、§7.6、§8、§10、§11）：分類之外的匯率、配方、門檻與市集費率。
// 這一層是純資料，沒有 I/O；每一次操作都會把當時的 `RULES_VERSION` 存進快照（§8.2），
// 之後調整數值不會改寫已經落帳的結果。
//
// 版本歷程：
//   1  ticket #7 的土地生命週期（撤回、封存、重新派遣）
//   2  ticket #8 的研究匯率、加速點數、市集費率與建築配方
//   3  市集依資源配對訂不同費率：羊皮卷 → 其他 1 換 10；其他 → 羊皮卷 30 換 1；其他之間仍是 3 換 1
//   4  ticket #23 共用城市的基本收入：每 10,000 個有效 token 收木 3、石 2、鐵 1
//   5  ticket #24 明確成果的額外收成：每個歸屬確定、帶來新內容的 commit 另收木 3、石 2、鐵 1
//   6  ticket #25 共用城市的建築占地與配方（市場、書庫、工坊、民居）；選址不動庫存
export const RULES_VERSION = 6;

/** 庫存裡的資源種類；羊皮卷同時是市集商品與加速材料（§11）。 */
export const RESOURCES = ["wood", "stone", "iron", "parchment"];

export const RESOURCE_LABELS = { wood: "木材", stone: "石材", iron: "鐵料", parchment: "羊皮卷" };

/** §10：開墾完成的門檻（試玩參數）。 */
export const CLEAR_POINTS = 100;

/** §7.4：每 100,000 個 non-cache input + output token 換 1 張羊皮卷，餘數按城保留。 */
export const RESEARCH_TOKENS_PER_PARCHMENT = 100_000;

/** §7.6：每張羊皮卷 +10 開墾點；超過 100 的部分不退還、也不會轉到其他格。 */
export const BOOST_POINTS_PER_PARCHMENT = 10;

/**
 * §7.6：市集的費率依資源配對而不同，一筆交易的 `amount` 是「換幾次」。
 *   - 羊皮卷 → 木／石／鐵：1 張換 10 個（羊皮卷產出少，值錢）
 *   - 木／石／鐵 → 羊皮卷：30 個換 1 張（往返只剩 1/3，不能無損耗互換；附錄 A）
 *   - 木／石／鐵之間：3 換 1
 * `give`／`get` 是一次交換付出與取得的數量；`step` 是畫面一次調整的次數（3:1 太細，以 10 為單位）。
 */
export function tradeTerms(from, to) {
  if (from === to || !RESOURCES.includes(from) || !RESOURCES.includes(to)) return null;
  if (from === "parchment") return { give: 1, get: 10, step: 1 };
  if (to === "parchment") return { give: 30, get: 1, step: 1 };
  return { give: 3, get: 1, step: 10 };
}

/** 規則版本 2 以前的市集一律 3 換 1，舊紀錄重播時沿用（紀錄裡沒有 give／get）。 */
export const LEGACY_TRADE_GIVE = 3;

/** §8.1 的暫定建築配方；建材不合理時改這裡，不動帳本。 */
export const RECIPES = {
  workshop: { label: "工坊", costs: { wood: 30, iron: 5 } },
  wall: { label: "城牆", costs: { stone: 40 } },
  library: { label: "圖書館", costs: { wood: 20, stone: 20, iron: 5 } },
  warehouse: { label: "倉庫", costs: { wood: 20, stone: 20, iron: 10 } },
  house: { label: "民居", costs: { wood: 20, stone: 10 } },
};

/**
 * #25：共用城市的建築表——占地是整片土地（不是屋頂大小），配方是備齊後才一次支付的完整材料。
 * 這張表只給共用城市用；舊版各城的配方（`RECIPES`）照舊，兩邊不互相改寫。
 */
export const CITY_BUILDINGS = {
  house: { label: "民居", footprint: { w: 1, h: 1 }, costs: { wood: 20, stone: 10 } },
  workshop: { label: "工坊", footprint: { w: 2, h: 1 }, costs: { wood: 30, iron: 5 } },
  market: { label: "市場", footprint: { w: 2, h: 2 }, costs: { wood: 40, stone: 20 } },
  library: { label: "書庫", footprint: { w: 2, h: 2 }, costs: { wood: 20, stone: 20, iron: 5 } },
};

/** 庫存足以支付完整配方（§7.6：市集與畫面只列這些）。 */
export function affordable(costs, resources = {}) {
  return Object.entries(costs ?? {}).every(([key, need]) => Number(resources?.[key] ?? 0) >= Number(need));
}

/** 這一次的庫存可以蓋的建築；`costs` 是配方本身，扣款時照它一次扣完。 */
export function buildableRecipes(resources = {}) {
  return Object.entries(RECIPES)
    .filter(([, recipe]) => affordable(recipe.costs, resources))
    .map(([name, recipe]) => ({ name, label: recipe.label, costs: { ...recipe.costs } }));
}

/** #23：共用城市的基本收入——每 WORK_TOKENS_PER_UNIT 個有效 token 收成一份建材（試玩參數）。 */
export const WORK_TOKENS_PER_UNIT = 10_000;

/** 一份收成的建材。羊皮卷不在其中：它是成果收成與加速材料，不是日常工作收入。 */
export const WORK_YIELD = { wood: 3, stone: 2, iron: 1 };

/**
 * 一批有效工作的收成：整份的建材（計量器餘數由帳本的 work.tokens 另外保留）。
 * 長短對話、換 provider、換專案只改變 token 從哪裡來，收成只依 token 總量。
 */
export function workYieldOf(tokens = 0) {
  const total = Math.max(0, Math.floor(Number(tokens) || 0));
  const units = Math.floor(total / WORK_TOKENS_PER_UNIT);
  return Object.fromEntries(Object.entries(WORK_YIELD).map(([key, amount]) => [key, amount * units]));
}

/**
 * #24：一個可核對成果的額外收成——歸屬確定的 commit 另外發一份建材，基本收入照發。
 * 只發基本建材（羊皮卷仍是研究與加速材料），確認收穫不看 commit 大小（試玩參數）。
 */
export const ACHIEVEMENT_YIELD = { wood: 3, stone: 2, iron: 1 };
