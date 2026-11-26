// `herdr-app check` 與固定情境用的共用城市：一份寫死的公開讀取模型，不碰任何檔案、不跑帳本。
//
// 只給「載入一次並渲染」用（proposal §15.4）：check 會在 init 的第一個 await 之後就結束，
// 這裡只確認三個區塊畫得出來；真的帳本與施工進度由載入鏈測試驗證。
import { footprintCells } from "../core/city-map.js";
import { quotaView } from "../core/quota-view.js";
import { RULES_VERSION, START_ROAD_LENGTH, TERRAIN_VERSION } from "../core/rules.js";
import { SHARED_CITY_ID, readSharedCity } from "../core/shared-city.js";

const MARKET = { building: "market", label: "市場", x: -3, y: 2, w: 2, h: 2 };
const OUTPOST = { building: "outpost", label: "哨站", x: 4, y: 1, w: 1, h: 1 };
const HOUSE = { building: "house", label: "民居", x: 2, y: -1, w: 2, h: 1 };

/** 佇列的第一項在施工、第二項備料中：check 看得到兩種階段與「取消」按鈕。 */
const QUEUE = [
  {
    ...OUTPOST,
    costs: { wood: 25, stone: 15, iron: 5 },
    cells: footprintCells("outpost", OUTPOST).map((cell) => ({ x: cell.x, y: cell.y })),
    at: 1_000,
    paid: true,
    startedUnit: 12,
  },
  {
    ...HOUSE,
    costs: { wood: 20, stone: 10, iron: 6 },
    cells: footprintCells("house", HOUSE).map((cell) => ({ x: cell.x, y: cell.y })),
    at: 1_500,
  },
];

const STATE = {
  cityId: SHARED_CITY_ID,
  terrainVersion: TERRAIN_VERSION,
  terrainSeed: 32,
  roadArmLength: START_ROAD_LENGTH,
  resources: { wood: 12, stone: 8, iron: 3, parchment: 0 },
  work: { tokens: 4_000, units: 13, since: 1 },
  queue: QUEUE,
  buildings: [{
    ...MARKET,
    cells: footprintCells("market", MARKET).map((cell) => ({ x: cell.x, y: cell.y })),
    costs: { wood: 40, stone: 20 },
    reveal: 2,
    startedUnit: 0,
    completedUnit: 12,
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
