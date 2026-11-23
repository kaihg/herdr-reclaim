// 底部動作列（蓋房、市集、加速）的純邏輯：按鈕能不能按、為什麼不能、市集的數量與預覽。
// 不碰 host、不碰帳本；畫面在 ui/dock.js，真正的扣款仍由帳本的 processBuild／processTrade／processBoost 檢查。

import { RECIPES, RESOURCE_LABELS, TRADE_RATE, affordable } from "./rules.js";

export const RESOURCE_KEYS = Object.keys(RESOURCE_LABELS);

const stock = (resources, key) => Number(resources?.[key] ?? 0);

/** 畫面上一次至少換 10 份、以 10 為單位（單份太細，操作不便）；帳本本身仍接受任何正整數。 */
export const TRADE_STEP = 10;

/** 這一種資源理論上最多可以換幾份（3 換 1，無條件捨去）。 */
export function maxTradeAmount(resources, from) {
  return Math.floor(stock(resources, from) / TRADE_RATE);
}

/** 畫面上真正能選的最大數量：理論上限往下取到 10 的倍數；不到 10 就是 0（換不出來）。 */
export function tradeCap(resources, from) {
  return Math.floor(maxTradeAmount(resources, from) / TRADE_STEP) * TRADE_STEP;
}

/** 數量是 10 的倍數、夾在 [10, 上限]；不到 10 份時是 0。 */
function clampAmount(resources, from, amount) {
  const cap = tradeCap(resources, from);
  if (cap <= 0) return 0;
  const wanted = Number.isInteger(amount) ? Math.round(amount / TRADE_STEP) * TRADE_STEP : TRADE_STEP;
  return Math.min(cap, Math.max(TRADE_STEP, wanted));
}

/** 預設：付出庫存最多的資源，換成庫存最少的另一種（同量取清單順序在前的），數量 1。 */
export function defaultTrade(resources) {
  const byStock = [...RESOURCE_KEYS].sort((a, b) => stock(resources, b) - stock(resources, a));
  const from = byStock[0];
  const to = [...RESOURCE_KEYS].filter((key) => key !== from).sort((a, b) => stock(resources, a) - stock(resources, b))[0];
  return { from, to, amount: clampAmount(resources, from, TRADE_STEP) };
}

/** 庫存變動（交易後、新的收成）時讓選擇仍然有效：不能換成自己，數量不超過現有庫存。 */
export function normalizeTrade(trade, resources) {
  const base = trade && RESOURCE_KEYS.includes(trade.from) && RESOURCE_KEYS.includes(trade.to) && trade.from !== trade.to
    ? trade
    : defaultTrade(resources);
  return { ...base, amount: clampAmount(resources, base.from, base.amount) };
}

export function setTradeFrom(trade, resources, from) {
  const to = trade.to === from ? RESOURCE_KEYS.find((key) => key !== from) : trade.to;
  return normalizeTrade({ from, to, amount: trade.amount }, resources);
}

export function setTradeTo(trade, resources, to) {
  const from = trade.from === to ? RESOURCE_KEYS.find((key) => key !== to) : trade.from;
  return normalizeTrade({ from, to, amount: trade.amount }, resources);
}

export function stepTrade(trade, resources, delta) {
  return normalizeTrade({ ...trade, amount: trade.amount + delta * TRADE_STEP }, resources);
}

export function maxTrade(trade, resources) {
  return normalizeTrade({ ...trade, amount: tradeCap(resources, trade.from) }, resources);
}

/** 「付出 木材 6 → 得到 石材 2」的數字；數量 0 代表換不出來。 */
export function tradePreview(trade) {
  return { give: trade.amount * TRADE_RATE, get: trade.amount };
}

/** 所有配方（不只買得起的）：買不起的附上還差多少，面板用「缺 木材 5」標示。 */
export function buildOptions(resources) {
  return Object.entries(RECIPES).map(([name, recipe]) => {
    const missing = {};
    for (const [key, need] of Object.entries(recipe.costs)) {
      const lack = Number(need) - stock(resources, key);
      if (lack > 0) missing[key] = lack;
    }
    return { name, label: recipe.label, costs: { ...recipe.costs }, affordable: affordable(recipe.costs, resources), missing };
  });
}

const NEED_EXPEDITION = "先在左側或地圖選一塊遠征的土地";

/**
 * 三個入口的狀態。`detail` 是目前選取的詳情（core/town.js 的 selectionDetail），
 * `hasLedgerCity` 是這座城是不是已經有帳本（沒有遠征的空城沒有庫存可用）。
 * 不能按時 `reason` 是給玩家看的一句話。
 */
export function dockState({ detail, hasLedgerCity }) {
  const expedition = detail?.kind === "expedition";
  const build = !hasLedgerCity
    ? { enabled: false, reason: "這座城還沒有遠征，沒有可蓋的土地" }
    : !expedition
      ? { enabled: false, reason: NEED_EXPEDITION }
      : detail.buildBlocked
        ? { enabled: false, reason: detail.buildBlocked }
        : { enabled: true, reason: null };
  const market = hasLedgerCity
    ? { enabled: true, reason: null }
    : { enabled: false, reason: "這座城還沒有遠征，沒有庫存可以交易" };
  const boost = !hasLedgerCity
    ? { enabled: false, reason: "這座城還沒有遠征", scrolls: 0 }
    : !expedition || !detail.boost
      ? { enabled: false, reason: NEED_EXPEDITION, scrolls: 0 }
      : detail.boost.available && detail.boost.scrolls > 0
        ? { enabled: true, reason: null, scrolls: detail.boost.scrolls }
        : { enabled: false, reason: `不能加速：${detail.boost.reason ?? "沒有羊皮卷"}`, scrolls: 0 };
  return { build, market, boost };
}
