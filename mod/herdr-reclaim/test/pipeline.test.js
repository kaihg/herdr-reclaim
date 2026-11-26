// 載入鏈與操作：真的帳本、真的 CAS 寫入，只把 herdr 的檔案 API 換成 node fs。
//
// 這一層抓的是「只有真視窗才看得到」那類錯誤：模型接錯欄位、載入後畫面是空的、按下按鈕
// 之後帳本沒有真的動。`herdr-app check` 做不到（它在 init 的第一個 await 就結束，見
// mod/herdr-reclaim/README.md），電腦操作也做不到（它只看到像素，看不到帳本）。
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import { legalSites } from "../core/city-map.js";
import { RESOURCE_LABELS, START_RESOURCES, workYieldOf } from "../core/rules.js";
import {
  findByText, findById, installHost, ledgerState, makeCx, mapTiles, submitOp, text, waitFor,
} from "./view-harness.js";

const host = installHost({ checking: false });
const { default: Town } = await import("../main.js");
beforeEach(() => fs.rmSync(host.home, { recursive: true, force: true }));

/** 開一個視窗的等價物：`init` 之後等第一次載入完成（成功或失敗都會 notify 一次）。 */
async function open(cx = makeCx()) {
  const town = new Town();
  town.init({}, cx);
  await waitFor(() => Boolean(town.town?.shared) || Boolean(town.note?.includes("失敗")), {
    describe: () => `note=${town.note}`,
  });
  return { cx, town, tree: () => town.render(cx) };
}

const incomeOp = (tokens, id = "test") => (state) => ({
  opId: `income:${state.cityId}:${id}`,
  kind: "income",
  at: 1_800_000_000_000,
  cityId: state.cityId,
  tokens,
  sources: [id],
  resources: workYieldOf(Number(state.work.tokens ?? 0) + tokens),
});

describe("載入鏈", () => {
  test("空 home：帳本自己開一份空的城，畫面沒有讀取失敗", async () => {
    const { tree } = await open();
    const screen = text(tree());
    expect(screen).toContain(`共用倉庫|${START_RESOURCES.wood}|木材|${START_RESOURCES.stone}|石材|${START_RESOURCES.iron}|鐵料`);
    expect(screen).not.toContain("讀取失敗");
    expect(screen).toContain("沒有建設目標");
  });

  test("帳本裡的一筆收入：重開就變成畫面上的庫存", async () => {
    await open();
    const result = await submitOp(host.home, incomeOp(10_000));
    expect(result.status).toBe("applied");
    const state = await ledgerState(host.home);
    const { tree } = await open();
    const screen = text(tree());
    for (const key of ["wood", "stone", "iron"]) {
      expect(screen).toContain(`${state.resources[key]}|${RESOURCE_LABELS[key]}`);
    }
    expect(screen).not.toContain("讀取失敗");
  });
});

describe("選址到下令（真的寫進帳本）", () => {
  test("點選預定付料，重開工地不排完工計時器", async () => {
    // 先備料：七單位工作（木 21、石 14、鐵 7）足夠民居的 20/10。
    await open();
    const before = await ledgerState(host.home);
    expect((await submitOp(host.home, incomeOp(70_000, "seed-house"))).status).toBe("applied");
    const funded = await ledgerState(host.home);
    expect(funded.resources.wood).toBe(before.resources.wood + 21);
    const { cx, town, tree } = await open();
    expect(text(tree())).toContain(`共用倉庫|${funded.resources.wood}|木材|${funded.resources.stone}|石材|${funded.resources.iron}|鐵料`);

    const card = findById(tree(), "building-house");
    card.handlers.click({}, cx);
    expect(town.picking).toBe("house");

    const site = legalSites(town.town.shared.city, "house")[0];
    expect(site).toBeDefined();
    const tile = mapTiles(tree()).find((node) => node.props.id === `map-${site.x}-${site.y}`);
    expect(tile).toBeDefined();
    tile.handlers.mouseDown.left({ local_position: { x: tile.props.w / 2, y: tile.props.h / 2 }, bounds: {} }, cx);
    expect(town.preview).toEqual({ x: site.x, y: site.y });

    const preview = text(tree());
    expect(preview).toContain("整棟預覽");
    expect(preview).toContain("可以放");
    expect(preview).toContain("排在佇列後面也付得出來");

    findByText(tree(), "預定這裡").handlers.click({}, cx);
    const queue = await waitFor(() => town.town?.shared?.city?.queue?.[0], {
      describe: () => `toast=${town.toast?.text} note=${town.note}`,
    });
    expect(queue).toMatchObject({ building: "house", label: "民居", x: site.x, y: site.y, paid: true });
    expect(town.toast?.text).toContain("已預定：民居");
    expect(town.picking).toBeNull();

    // 帳本真的動了：一項預定、配方扣一次、佇列最前面那一項已開工。
    const state = await ledgerState(host.home);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({ building: "house", x: site.x, y: site.y, paid: true });
    expect(state.queue[0].startedUnit).toBe(7);
    expect([state.resources.wood, state.resources.stone]).toEqual([funded.resources.wood - 20, funded.resources.stone - 10]);
    const after = text(tree());
    expect(after).toContain("建設佇列（1/3）");
    expect(after).toContain("#1 民居");
    expect(after).toContain("施工中：民居・還要 14 份");
    const reopened = makeCx();
    const timers = [];
    reopened.timer.after = (delay) => timers.push(delay);
    expect(text((await open(reopened)).tree())).toContain("還要 14 份");
    expect(timers).toEqual([]); // 載入施工中的城市，不應排程完工。
  });

  test("庫存不夠也能先排進佇列：帳本不扣料，畫面寫還缺；取消之後乾乾淨淨", async () => {
    const { cx, town, tree } = await open();
    // 起始材料可建第一座市場，付完之後不夠蓋第二座。
    const buildMarket = () => findById(tree(), "building-market").handlers.click({}, cx);
    buildMarket();
    const firstSite = legalSites(town.town.shared.city, "market")[0];
    town.pickSite(firstSite.x, firstSite.y, cx);
    findByText(tree(), "預定這裡").handlers.click({}, cx);
    await waitFor(() => town.town.shared.city.queue[0]?.stage === "building");
    const before = await ledgerState(host.home);
    expect(before.resources.wood).toBeLessThan(40);
    buildMarket();
    const site = legalSites(town.town.shared.city, "market")[0];
    const tile = mapTiles(tree()).find((node) => node.props.id === `map-${site.x}-${site.y}`);
    tile.handlers.mouseDown.left({ local_position: { x: tile.props.w / 2, y: tile.props.h / 2 }, bounds: {} }, cx);
    const preview = text(tree());
    expect(preview).toContain(`排在目前佇列之後還缺`);
    expect(findByText(tree(), "預定這裡")).not.toBeNull(); // 缺料不擋預定

    findByText(tree(), "預定這裡").handlers.click({}, cx);
    const queued = await waitFor(() => town.town?.shared?.city?.queue?.[1], {
      describe: () => `toast=${town.toast?.text} note=${town.note}`,
    });
    expect(queued.stage).toBe("queued");
    expect(queued.paid).not.toBe(true);
    expect(queued.missing).toEqual({
      wood: 40 - before.resources.wood,
      stone: 20 - before.resources.stone,
    });
    // 指定位置不動庫存。
    const placed = await ledgerState(host.home);
    expect(placed.resources).toEqual(before.resources);
    expect(placed.queue).toHaveLength(2);
    expect(text(tree())).toContain("備料中");
    expect(text(tree())).toContain("還缺");

    // 取消還沒開工的那一項：佇列回到一項，庫存不動。
    findByText(tree(), "取消").handlers.click({}, cx);
    await waitFor(() => town.town?.shared?.city?.queue?.length === 1, {
      describe: () => `toast=${town.toast?.text} note=${town.note}`,
    });
    const cancelled = await ledgerState(host.home);
    expect(cancelled.queue).toHaveLength(1);
    expect(cancelled.resources).toEqual(before.resources);
    expect(text(tree())).toContain("建設佇列（1/3）");
  });
});
