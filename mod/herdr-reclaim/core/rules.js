// 規則表（proposal §7.4、§7.6、§8、§10、§11）：分類之外的匯率、配方、門檻與市集費率。
// 這一層是純資料，沒有 I/O；每一次操作都會把當時的 `RULES_VERSION` 存進快照（§8.2），
// 之後調整數值不會改寫已經落帳的結果。
//
// 版本歷程：
//   1  ticket #7 的土地生命週期（撤回、封存、重新派遣）
//   2  ticket #8 的研究匯率、加速點數、市集費率與建築配方

export const RULES_VERSION = 2;

/** 庫存裡的資源種類；羊皮卷同時是市集商品與加速材料（§11）。 */
export const RESOURCES = ["wood", "stone", "iron", "parchment"];

export const RESOURCE_LABELS = { wood: "木材", stone: "石材", iron: "鐵料", parchment: "羊皮卷" };

/** §10：開墾完成的門檻（試玩參數）。 */
export const CLEAR_POINTS = 100;

/** §7.4：每 100,000 個 non-cache input + output token 換 1 張羊皮卷，餘數按城保留。 */
export const RESEARCH_TOKENS_PER_PARCHMENT = 100_000;

/** §7.6：每張羊皮卷 +10 開墾點；超過 100 的部分不退還、也不會轉到其他格。 */
export const BOOST_POINTS_PER_PARCHMENT = 10;

/** §7.6：市集任兩種資源 3 換 1。 */
export const TRADE_RATE = 3;

/** §8.1 的暫定建築配方；建材不合理時改這裡，不動帳本。 */
export const RECIPES = {
  workshop: { label: "工坊", costs: { wood: 30, iron: 5 } },
  wall: { label: "城牆", costs: { stone: 40 } },
  library: { label: "圖書館", costs: { wood: 20, stone: 20, iron: 5 } },
  warehouse: { label: "倉庫", costs: { wood: 20, stone: 20, iron: 10 } },
  house: { label: "民居", costs: { wood: 20, stone: 10 } },
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
