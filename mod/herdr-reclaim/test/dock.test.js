// 底部動作列：按鈕狀態與不能按的原因、市集的預設值／數量邊界／預覽。
import { describe, expect, test } from "bun:test";
import { buildOptions, canPay, defaultTrade, dockState, maxTrade, maxTradeAmount, minPay, normalizeTrade, setTradeFrom, setTradeTo, stepTrade, tradeCap, tradePreview } from "../core/dock.js";

const stock = (wood, stone, iron, parchment) => ({ wood, stone, iron, parchment });

describe("市集費率與次數", () => {
  test("羊皮卷 → 其他：1 張換 10；其他 → 羊皮卷：30 換 1；其他之間：3 換 1", () => {
    const resources = stock(300, 300, 300, 300);
    expect(tradePreview({ from: "parchment", to: "wood", amount: 2 })).toEqual({ give: 2, get: 20 });
    expect(tradePreview({ from: "wood", to: "parchment", amount: 2 })).toEqual({ give: 60, get: 2 });
    expect(tradePreview({ from: "wood", to: "stone", amount: 10 })).toEqual({ give: 30, get: 10 });
    expect(maxTradeAmount(resources, "parchment", "wood")).toBe(300);
    expect(maxTradeAmount(resources, "wood", "parchment")).toBe(10);
  });

  test("往返有損耗：1 羊皮卷換成木材再換回來，拿不回 1 張", () => {
    const out = tradePreview({ from: "parchment", to: "wood", amount: 1 }).get; // 10 木材
    const back = Math.floor(out / 30); // 木材 → 羊皮卷要 30 個換 1
    expect(back).toBe(0);
  });

  test("預設付出庫存最多而且付得起的資源，換成庫存最少的另一種", () => {
    expect(defaultTrade(stock(90, 60, 30, 30))).toEqual({ from: "wood", to: "iron", amount: 10 });
    // 羊皮卷庫存最多：付得起（1 張就能換），預設以它付出，一次 1 張
    expect(defaultTrade(stock(0, 0, 0, 5))).toMatchObject({ from: "parchment", amount: 1 });
  });

  test("庫存湊不出一個 step：次數 0（木／石／鐵之間要 30；換進羊皮卷要 30）", () => {
    const resources = stock(29, 3, 0, 0);
    expect(tradeCap(resources, "wood", "stone")).toBe(0);
    expect(maxTradeAmount(resources, "wood", "stone")).toBe(9); // 帳本接受，但畫面不開放
    expect(canPay(resources, "wood")).toBe(false);
    expect(defaultTrade(resources).amount).toBe(0);
    expect(minPay({ from: "wood", to: "stone" })).toBe(30);
    expect(minPay({ from: "wood", to: "parchment" })).toBe(30);
    expect(minPay({ from: "parchment", to: "wood" })).toBe(1);
  });

  test("步進與最多：木／石／鐵之間以 10 次為單位，羊皮卷的配對以 1 次為單位", () => {
    const resources = stock(100, 0, 0, 7);
    expect(tradeCap(resources, "wood", "stone")).toBe(30); // 理論 33，畫面 30
    let trade = { from: "wood", to: "stone", amount: 10 };
    expect(stepTrade(trade, resources, -1).amount).toBe(10);
    trade = maxTrade(stepTrade(trade, resources, 1), resources);
    expect(trade.amount).toBe(30);
    expect(stepTrade(trade, resources, 1).amount).toBe(30);
    expect(tradePreview(trade)).toEqual({ give: 90, get: 30 });

    let scrolls = { from: "parchment", to: "wood", amount: 1 };
    scrolls = stepTrade(scrolls, resources, 1);
    expect(scrolls.amount).toBe(2);
    expect(maxTrade(scrolls, resources).amount).toBe(7);
    expect(tradePreview(maxTrade(scrolls, resources))).toEqual({ give: 7, get: 70 });
    // 換進羊皮卷：木材 100 → 3 張（付 90）
    expect(tradeCap(resources, "wood", "parchment")).toBe(3);
  });

  test("換成自己的選項會自動讓開；換資源後次數回到那一對的一個 step", () => {
    const resources = stock(300, 60, 0, 5);
    let trade = { from: "wood", to: "stone", amount: 70 };
    trade = setTradeFrom(trade, resources, "stone");
    expect(trade.from).toBe("stone");
    expect(trade.to).not.toBe("stone");
    trade = setTradeTo(trade, resources, "stone");
    expect(trade.to).toBe("stone");
    expect(trade.from).not.toBe("stone");
    expect(setTradeTo({ from: "wood", to: "stone", amount: 70 }, resources, "parchment").amount).toBe(1);
  });

  test("庫存在交易後變少：次數跟著收斂；選到的資源不存在就退回預設", () => {
    expect(normalizeTrade({ from: "wood", to: "stone", amount: 90 }, stock(70, 0, 0, 0)).amount).toBe(20);
    expect(normalizeTrade({ from: "gold", to: "stone", amount: 10 }, stock(70, 0, 0, 0)).from).toBe("wood");
  });
});

describe("蓋房選項", () => {
  test("列出全部配方；買不起的標出還差多少", () => {
    const options = buildOptions(stock(20, 10, 0, 0));
    expect(options.map((option) => option.name).sort()).toEqual(["house", "library", "wall", "warehouse", "workshop"]);
    const house = options.find((option) => option.name === "house");
    expect(house).toMatchObject({ affordable: true, missing: {} });
    const wall = options.find((option) => option.name === "wall");
    expect(wall).toMatchObject({ affordable: false, missing: { stone: 30 } });
    const library = options.find((option) => option.name === "library");
    expect(library.missing).toEqual({ stone: 10, iron: 5 });
  });
});

describe("動作列的按鈕狀態", () => {
  const expedition = (over = {}) => ({ kind: "expedition", buildBlocked: null, boost: { available: true, scrolls: 3, reason: null }, ...over });

  test("沒有帳本的空城：三個都不能按，並說明原因", () => {
    const state = dockState({ detail: null, hasLedgerCity: false });
    for (const key of ["build", "market", "boost"]) expect(state[key].enabled).toBe(false);
    expect(state.market.reason).toContain("沒有庫存");
  });

  test("市集是整座城的功能：不選任何格子也能用；選到中心、空地、迷霧都一樣", () => {
    for (const detail of [null, { kind: "center" }, { kind: "open" }, { kind: "fog" }]) {
      expect(dockState({ detail, hasLedgerCity: true }).market.enabled).toBe(true);
    }
  });

  test("蓋房與加速要選到遠征：選到中心或空地時變灰並說明", () => {
    const state = dockState({ detail: { kind: "center" }, hasLedgerCity: true });
    expect(state.build).toMatchObject({ enabled: false, reason: "先在左側或地圖選一塊遠征的土地" });
    expect(state.boost).toMatchObject({ enabled: false, reason: "先在左側或地圖選一塊遠征的土地" });
  });

  test("蓋房：只在這一格已開墾且沒蓋過時可按；其餘原因照詳情給的", () => {
    expect(dockState({ detail: expedition(), hasLedgerCity: true }).build.enabled).toBe(true);
    const blocked = dockState({ detail: expedition({ buildBlocked: "這一格還沒開墾完成（要滿 100 點）" }), hasLedgerCity: true });
    expect(blocked.build).toEqual({ enabled: false, reason: "這一格還沒開墾完成（要滿 100 點）" });
  });

  test("加速：可按時帶張數；不能時說明原因（沒羊皮卷、已滿 100 點…）", () => {
    expect(dockState({ detail: expedition(), hasLedgerCity: true }).boost).toEqual({ enabled: true, reason: null, scrolls: 3 });
    const none = dockState({ detail: expedition({ boost: { available: false, scrolls: 0, reason: "沒有羊皮卷" } }), hasLedgerCity: true });
    expect(none.boost).toEqual({ enabled: false, reason: "不能加速：沒有羊皮卷", scrolls: 0 });
  });
});
