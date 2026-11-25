// 載入鏈與操作：真的帳本、真的 CAS 寫入，只把 herdr 的檔案 API 換成 node fs。
//
// 這一層抓的是「只有真視窗才看得到」那類錯誤：模型接錯欄位、載入後畫面是空的、按下按鈕
// 之後帳本沒有真的動。`herdr-app check` 做不到（它在 init 的第一個 await 就結束，見
// mod/herdr-reclaim/README.md），電腦操作也做不到（它只看到像素，看不到帳本）。
import { describe, expect, test } from "bun:test";

import { legalSites } from "../core/city-map.js";
import { RESOURCE_LABELS, workYieldOf } from "../core/rules.js";
import {
  findByText, findById, installHost, ledgerState, makeCx, mapTiles, submitOp, text, waitFor,
} from "./view-harness.js";

const host = installHost({ checking: false });
const { default: Town } = await import("../main.js");

/** 開一個視窗的等價物：`init` 之後等第一次載入完成（成功或失敗都會 notify 一次）。 */
async function open() {
  const cx = makeCx();
  const town = new Town();
  town.init({}, cx);
  await waitFor(() => Boolean(town.town?.shared) || Boolean(town.note?.includes("失敗")), {
    describe: () => `note=${town.note}`,
  });
  return { cx, town, tree: () => town.render(cx) };
}

const incomeOp = (tokens) => (state) => ({
  opId: "income:shared:test",
  kind: "income",
  at: 1_800_000_000_000,
  cityId: "shared",
  tokens,
  sources: ["test"],
  resources: workYieldOf(Number(state.work.tokens ?? 0) + tokens),
});

describe("載入鏈", () => {
  test("空 home：帳本自己開一份空的城，畫面沒有讀取失敗", async () => {
    const { tree } = await open();
    const screen = text(tree());
    expect(screen).toContain("共用倉庫|0|木材|0|石材|0|鐵料");
    expect(screen).not.toContain("讀取失敗");
    expect(screen).toContain("沒有建設目標");
  });

  test("帳本裡的一筆收入：重開就變成畫面上的庫存", async () => {
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
  test("點建築 → 點合法的一格 → 預定這裡：帳本多了同一個目標", async () => {
    const { cx, town, tree } = await open();
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

    findByText(tree(), "預定這裡").handlers.click({}, cx);
    const plan = await waitFor(() => town.town?.shared?.city?.plan, {
      describe: () => `toast=${town.toast?.text} note=${town.note}`,
    });
    expect(plan).toMatchObject({ building: "house", label: "民居", x: site.x, y: site.y });
    expect(town.toast?.text).toContain("已預定：民居");
    expect(town.picking).toBeNull();

    const state = await ledgerState(host.home);
    expect(state.plan).toMatchObject({ building: "house", x: site.x, y: site.y });
    expect(text(tree())).toContain("預定：民居");
  });
});
