// 底部動作列（蓋房、市集、加速）的純邏輯：按鈕能不能按、為什麼不能、市集的數量與預覽。
// 不碰 host、不碰帳本；畫面在 ui/dock.js，真正的扣款仍由帳本的 processBuild／processTrade／processBoost 檢查。

import { RECIPES, RESOURCE_LABELS, affordable, tradeTerms } from "./rules.js";

export const RESOURCE_KEYS = Object.keys(RESOURCE_LABELS);

const stock = (resources, key) => Number(resources?.[key] ?? 0);

/**
 * 市集的次數（`amount`）以配對的費率為準（rules.js 的 tradeTerms）：木／石／鐵之間 3 換 1，
 * 畫面以 10 次為單位；牽涉羊皮卷的配對一次就搬動 10 個或 30 個，以 1 次為單位。
 * 帳本本身接受任何正整數次，這裡只決定畫面開放哪些。
 */
function termsOf(from, to) {
  return tradeTerms(from, to) ?? tradeTerms(from, RESOURCE_KEYS.find((key) => key !== from));
}

/** 這一種資源換成 `to` 理論上最多可以換幾次。 */
export function maxTradeAmount(resources, from, to) {
  return Math.floor(stock(resources, from) / termsOf(from, to).give);
}

/** 畫面上真正能選的最大次數：理論上限往下取到 step 的倍數；湊不出一個 step 就是 0。 */
export function tradeCap(resources, from, to) {
  const { step } = termsOf(from, to);
  return Math.floor(maxTradeAmount(resources, from, to) / step) * step;
}

/** 這一種資源能不能拿來付（換成任何一種其他資源至少有一個 step）。 */
export function canPay(resources, from) {
  return RESOURCE_KEYS.some((to) => to !== from && tradeCap(resources, from, to) > 0);
}

/** 次數是 step 的倍數、夾在 [step, 上限]；湊不出一個 step 時是 0。 */
function clampAmount(resources, from, to, amount) {
  const cap = tradeCap(resources, from, to);
  if (cap <= 0) return 0;
  const { step } = termsOf(from, to);
  const wanted = Number.isInteger(amount) ? Math.round(amount / step) * step : step;
  return Math.min(cap, Math.max(step, wanted));
}

/** 預設：付出庫存最多（而且付得起）的資源，換成庫存最少的另一種；次數一個 step。 */
export function defaultTrade(resources) {
  const byStock = [...RESOURCE_KEYS].sort((a, b) => stock(resources, b) - stock(resources, a));
  const from = byStock.find((key) => canPay(resources, key)) ?? byStock[0];
  const to = [...RESOURCE_KEYS].filter((key) => key !== from).sort((a, b) => stock(resources, a) - stock(resources, b))[0];
  return { from, to, amount: clampAmount(resources, from, to, termsOf(from, to).step) };
}

/** 庫存變動（交易後、新的收成）時讓選擇仍然有效：不能換成自己，次數不超過現有庫存。 */
export function normalizeTrade(trade, resources) {
  const base = trade && RESOURCE_KEYS.includes(trade.from) && RESOURCE_KEYS.includes(trade.to) && trade.from !== trade.to
    ? trade
    : defaultTrade(resources);
  return { ...base, amount: clampAmount(resources, base.from, base.to, base.amount) };
}

export function setTradeFrom(trade, resources, from) {
  const to = trade.to === from ? RESOURCE_KEYS.find((key) => key !== from) : trade.to;
  return normalizeTrade({ from, to, amount: termsOf(from, to).step }, resources);
}

export function setTradeTo(trade, resources, to) {
  const from = trade.from === to ? RESOURCE_KEYS.find((key) => key !== to) : trade.from;
  return normalizeTrade({ from, to, amount: termsOf(from, to).step }, resources);
}

/** 每按一次＋／−調整的次數。 */
export function tradeStep(trade) {
  return termsOf(trade.from, trade.to).step;
}

export function stepTrade(trade, resources, delta) {
  return normalizeTrade({ ...trade, amount: trade.amount + delta * tradeStep(trade) }, resources);
}

export function maxTrade(trade, resources) {
  return normalizeTrade({ ...trade, amount: tradeCap(resources, trade.from, trade.to) }, resources);
}

/** 「付出 木材 90 → 得到 石材 30」的數字；次數 0 代表換不出來。 */
export function tradePreview(trade) {
  const { give, get } = termsOf(trade.from, trade.to);
  return { give: trade.amount * give, get: trade.amount * get };
}

/** 付出一個 step 需要的數量（換不出來時的提示用）。 */
export function minPay(trade) {
  const { give, step } = termsOf(trade.from, trade.to);
  return give * step;
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
