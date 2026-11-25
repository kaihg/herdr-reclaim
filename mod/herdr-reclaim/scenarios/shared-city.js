// `herdr-app check` 與固定情境用的共用城市：一份寫死的公開讀取模型，不碰任何檔案、不跑帳本。
//
// 只給「載入一次並渲染」用（proposal §15.4）：check 會在 init 的第一個 await 之後就結束，
// 真的帳本與施工計時要在真的視窗裡跑一次。這裡的數值只用來確認三個區塊畫得出來。
import { footprintCells } from "../core/city-map.js";
import { quotaView } from "../core/quota-view.js";
import { RULES_VERSION } from "../core/rules.js";
import { readSharedCity } from "../core/shared-city.js";

const MARKET = { building: "market", label: "市場", x: -3, y: 2, w: 2, h: 2 };
const OUTPOST = { building: "outpost", label: "哨站", x: 4, y: 0, w: 1, h: 1 };

const STATE = {
  cityId: "shared",
  resources: { wood: 12, stone: 8, iron: 3, parchment: 0 },
  work: { tokens: 4_000, since: 1, stockedAt: 1_000 },
  plan: {
    ...OUTPOST,
    costs: { wood: 25, stone: 15, iron: 5 },
    cells: footprintCells("outpost", OUTPOST).map((cell) => ({ x: cell.x, y: cell.y })),
    at: 1_000,
    startedAt: 2_000,
    buildMs: 6 * 60_000,
    completesAt: 2_000 + 6 * 60_000,
  },
  buildings: [{
    ...MARKET,
    cells: footprintCells("market", MARKET).map((cell) => ({ x: cell.x, y: cell.y })),
    costs: { wood: 40, stone: 20 },
    reveal: 2,
    startedAt: 0,
    completedAt: 500,
    rulesVersion: RULES_VERSION,
  }],
};

export function fixedSharedCity() {
  return {
    shared: readSharedCity(STATE),
    quotas: quotaView(null),
    repositories: [{ checkout: "/example/herdr-reclaim", at: 0 }],
  };
}
