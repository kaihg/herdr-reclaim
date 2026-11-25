// View 層：真的跑 `main.js` 的 `Town`，只用資料看畫面與互動。
//
// 這裡釘住的事：`herdr-app check` 只看得到 render 不炸，看不到「畫面上是哪些字、按下某個
// 東西之後狀態怎麼變、pane 變窄時欄寬怎麼算」。這三件都在這個檔案裡，不需要視窗、螢幕或
// 指標事件。
import { describe, expect, test } from "bun:test";

import { selectionOf } from "../core/selection.js";
import { RULES_VERSION } from "../core/rules.js";
import {
  findByText, findById, installHost, makeCx, mapTiles, resize, text, texts,
} from "./view-harness.js";

installHost({ checking: true });
const { default: Town } = await import("../main.js");

/** 每個測試都自己開一個實例：兩個實例共用同一份模組狀態（地圖的靜態路徑快取），但狀態互不影響。 */
function open() {
  const cx = makeCx();
  const town = new Town();
  town.init({}, cx);
  return { cx, town, tree: () => town.render(cx) };
}

describe("固定情境的分區與庫存", () => {
  test("三個區塊都在，庫存與唯一的目標照模型顯示", () => {
    const { tree } = open();
    const screen = text(tree());
    expect(screen).toContain("共用倉庫|12|木材|8|石材|3|鐵料");
    expect(screen).toContain("建設目標（一次一項）|施工中：哨站");
    expect(screen).toContain("選址與建設");
    // 地圖真的有格子（菱形命中由 core/grid.js 的測試釘住，這裡只確認它們被接到畫面上）。
    expect(mapTiles(tree()).length).toBeGreaterThan(20);
  });

  test("沒有共用城市時說清楚原因，不是空畫面", () => {
    const { town, cx } = open();
    town.town = null;
    expect(texts(town.render(cx)).join("")).toContain("共用城市");
  });
});

describe("按下之後", () => {
  test("開發模式：按鈕翻狀態，重繪才出現工程資訊", () => {
    const { cx, town, tree } = open();
    expect(text(tree())).not.toContain("規則 v");
    const chip = findByText(tree(), "開發模式");
    expect(chip).not.toBeNull();
    chip.handlers.click({}, cx);
    expect(town.devMode).toBe(true);
    const after = text(tree());
    expect(after).toContain("開發模式 ✓");
    expect(after).toContain(`規則 v${RULES_VERSION}`);
  });

  test("地圖格：按自己的中心就選到自己，並存進 ui 狀態", () => {
    const { cx, town, tree } = open();
    const tile = mapTiles(tree()).find((node) => /^map-(-?\d+)-(-?\d+)$/.test(node.props.id));
    const [, x, y] = tile.props.id.match(/^map-(-?\d+)-(-?\d+)$/).map(Number);
    tile.handlers.mouseDown.left({ local_position: { x: tile.props.w / 2, y: tile.props.h / 2 }, bounds: {} }, cx);
    expect(town.selection).toEqual({ kind: "site", cityId: "shared", x, y });
    expect(selectionOf(town.ui, "shared")).toEqual({ kind: "site", cityId: "shared", x, y });
  });

  test("已經有建設目標時點建築：只給一句提示，不進入選址", () => {
    const { cx, town, tree } = open();
    const card = findById(tree(), "building-house");
    expect(card).not.toBeNull();
    card.handlers.click({}, cx);
    expect(town.picking).toBeNull();
    expect(town.toast?.text).toContain("一次只有一個建設目標");
    expect(town.toast?.text).toContain("哨站");
  });
});

describe("pane 寬度", () => {
  test("左右欄依 clamp 變寬，窄 pane 不會把地圖擠到沒有", () => {
    const { cx, town, tree } = open();
    const widths = [400, 640, 940, 1600].map((width) => {
      resize(tree(), { width, height: 800 }, cx);
      const screen = tree();
      return {
        width,
        left: findById(screen, "city-panel").props.w,
        right: findById(screen, "detail").props.w,
      };
    });
    expect(widths).toEqual([
      { width: 400, left: 96, right: 108 },
      { width: 640, left: 122, right: 166 },
      { width: 940, left: 179, right: 244 },
      { width: 1600, left: 240, right: 292 },
    ]);
  });
});
