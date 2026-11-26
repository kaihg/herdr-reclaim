// 載入鏈與操作：真的帳本、真的 CAS 寫入，只把 herdr 的檔案 API 換成 node fs。
//
// 這一層抓的是「只有真視窗才看得到」那類錯誤：模型接錯欄位、載入後畫面是空的、按下按鈕
// 之後帳本沒有真的動。`herdr-app check` 做不到（它在 init 的第一個 await 就結束，見
// mod/herdr-reclaim/README.md），電腦操作也做不到（它只看到像素，看不到帳本）。
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";

import { TERRAIN, groundAt, legalSites } from "../core/city-map.js";
import { RESOURCE_LABELS, START_RESOURCES } from "../core/rules.js";
import { workYieldOf } from "../core/ledger.js";
import {
  findByText, findById, installHost, ledgerDir, ledgerState, makeCx, mapTiles, submitOp, text, texts, waitFor,
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
  resources: workYieldOf(state, tokens),
});

describe("載入鏈", () => {
  test("空 home：帳本自己開一份空的城，畫面沒有讀取失敗", async () => {
    const { tree } = await open();
    const screen = text(tree());
    expect(screen).toContain(`共用倉庫|${START_RESOURCES.wood}|木材|${START_RESOURCES.stone}|石材|${START_RESOURCES.iron}|鐵料`);
    expect(screen).not.toContain("讀取失敗");
    expect(screen).toContain("缺人");
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

  test("重播回訪不寫帳本", async () => {
    const { town, tree, cx } = await open();
    tree(); // 建立這個視窗的查看界線。
    expect((await submitOp(host.home, incomeOp(150_000))).status).toBe("applied");
    const writes = spyOn(fs, "writeFileSync");
    try {
      town.town = await town.refreshShared();
      const before = tree();
      expect(text(findById(before, "visit-summary"))).toMatch(/^上次查看後：進帳 15 份、完工 1 棟、揭開 \d+ 格$/);
      expect(texts(findById(before, "map-view"))).not.toContain("民居");
      cx.nextTimer();
      expect(texts(findById(tree(), "map-view"))).toContain("民居");
      cx.nextTimer();
      expect(findById(tree(), "visit-summary")).toBeNull();
      expect(writes.mock.calls.filter(([file]) => String(file).startsWith(ledgerDir(host.home) + "/"))).toEqual([]);
    } finally { writes.mockRestore(); }
  });
});

describe("選址到下令（真的寫進帳本）", () => {
  test("霧中河道不外洩", async () => {
    await submitOp(host.home, state => ({
      kind: "workStart", opId: "found", at: 32, cityId: state.cityId,
      terrainVersion: 2, terrainSeed: 32, roadArmLength: 1, resources: START_RESOURCES,
    }));
    const first = await open();
    findById(first.tree(), "building-outpost").handlers.click({}, first.cx);
    first.town.pickSite(4, 1, first.cx);
    findByText(first.tree(), "預定這裡").handlers.click({}, first.cx);
    await waitFor(() => first.town.town.shared.city.queue[0]?.stage === "building");
    await submitOp(host.home, incomeOp(40_000, "scout"));
    const { town, cx, tree } = await open();
    const city = town.town.shared.city;
    expect(groundAt(city, { x: 10, y: 0 })).toBe("water");
    expect(findById(tree(), "map-10-0")).toBeNull();
    findById(tree(), "building-house").handlers.click({}, cx);
    town.pickSite(10, 0, cx);
    expect(town.preview).toBeNull();
    const edge = findById(tree(), "map-9-0");
    edge.handlers.mouseDown.left({ local_position: { x: edge.props.w / 2, y: edge.props.h / 2 }, bounds: {} }, cx);
    const edgeTerrain = TERRAIN[groundAt(city, { x: 9, y: 0 })];
    expect(text(findById(tree(), "detail"))).toContain(`${edgeTerrain.buildable ? "離通車的道路超過 3 格，請先鋪路" : edgeTerrain.label}|迷霧|配方`);
    expect(findByText(tree(), "預定這裡")).toBeNull();
    // 即使繞過按鈕直接送出，帳本的拒絕原因也只能提到迷霧。
    town.submitPlan({ building: "outpost", x: 10, y: 0, label: "哨站" }, cx);
    await waitFor(() => town.toast?.text?.includes("沒有預定"));
    expect(town.toast.text).toBe("沒有預定：有一角還在迷霧裡");
    expect((await ledgerState(host.home)).queue).toEqual([]); // 哨站付料後僅剩 5 鐵，民居不能開工。
  });

  test("鋪路操作", async () => {
    const { cx, town, tree } = await open();
    const click = label => findByText(tree(), label).handlers.click({}, cx);
    const pick = (x, y) => {
      const tile = findById(tree(), `map-${x}-${y}`);
      tile.handlers.mouseDown.left({ local_position: { x: tile.props.w / 2, y: tile.props.h / 2 }, bounds: {} }, cx);
    };
    const screen = () => {
      const words = text(tree());
      expect(words).not.toMatch(/provider|session|token|shared-v2|帳本|座標|journal|\(-?\d+,\s*-?\d+\)/i);
      return words;
    };
    const before = await ledgerState(host.home);
    click("鋪路");
    expect(screen()).toContain("選起點");
    pick(3, 1);
    expect(screen()).toContain("請從已通車");
    pick(0, -2);
    expect(screen()).toContain("選終點");
    pick(4, -2);
    expect(screen()).toContain("終點是峭壁");
    expect(findByText(tree(), "確認鋪路")).toBeNull();
    pick(-2, -3);
    expect(screen()).toContain("新鋪 3 格，其中橋 1 格");
    expect(screen()).toContain("木材 28・石材 56");
    expect(screen()).toContain("工期|2 份");
    for (const id of ["preview-0--2", "preview-0--3", "preview--1--3", "preview--2--3"]) {
      expect(findById(tree(), id)).not.toBeNull();
    }
    click("取消鋪路");
    expect((await ledgerState(host.home)).lastSeq).toBe(before.lastSeq);
    click("鋪路"); pick(0, -2); pick(-2, -3); click("確認鋪路");
    await waitFor(() => town.town.shared.city.queue[0]?.building === "road");
    expect(screen()).toContain("#1 道路");
    expect(screen()).toContain("還缺 石材 21");
    expect((await ledgerState(host.home)).resources).toEqual(before.resources);
    click("取消");
    await waitFor(() => !town.town.shared.city.queue.length);
    expect(screen()).toContain("已取消：道路");
    expect((await ledgerState(host.home)).resources).toEqual(before.resources);
  });

  test("點選預定付料，重開工地不排完工計時器", async () => {
    // 起始庫存已能支付首棟；尚未進帳，不會先啟動沿線工地。
    const funded = (await open()).town.town.shared.city;
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
    expect(state.queue[0].startedUnit).toBe(0);
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
