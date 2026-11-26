// View 層：真的跑 `main.js` 的 `Town`，只用資料看畫面與互動。
//
// 這裡釘住的事：`herdr-app check` 只看得到 render 不炸，看不到「畫面上是哪些字、按下某個
// 東西之後狀態怎麼變、pane 變窄時欄寬怎麼算」。這三件都在這個檔案裡，不需要視窗、螢幕或
// 指標事件。
import { describe, expect, spyOn, test } from "bun:test";

import { selectionOf } from "../core/selection.js";
import { SHARED_CITY_ID, readSharedCity } from "../core/shared-city.js";
import { RULES_VERSION } from "../core/rules.js";
import { createFileIo } from "./fs-io.js";
import {
  findByText, findById, installHost, makeCx, mapTiles, resize, text, texts, waitFor,
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

// 列舉整棵 render 樹，而非只檢查預期藏起來的欄位；也抓沒有「座標」字樣的數字對。
function playerScreen(root) {
  const lines = texts(root);
  expect(lines.filter((line) =>
    /provider|session|agent|token|CLI|exit|omp usage|--json|openai-codex|shared-v2|帳本|座標|行會人力|額度|規則 v|量測|[（(]\s*-?\d+\s*[,，]\s*-?\d+\s*[)）]/i.test(line)
  )).toEqual([]);
  return lines.join("|");
}

test("新城外框與道路", () => {
  const { town, cx, tree } = open();
  town.town.shared = readSharedCity({ terrainVersion: 1 });
  const screen = tree();
  const tiles = mapTiles(screen);
  expect(tiles).toHaveLength(81);
  const map = findById(screen, "map-view");
  const roads = map.kids.find((node) => node.color?.token === "muted");
  const roadCenters = roads.path.map((polygon) => {
    const [x, y] = polygon[0];
    return [x + roads.props.left, y + roads.props.top];
  });
  const expectedRoads = [];
  for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) {
    const tile = findById(map, `map-${x}-${y}`);
    expect(tile).not.toBeNull();
    if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
      const p = [[tile.props.w / 2, 0], [tile.props.w, tile.props.h / 2], [tile.props.w / 2, tile.props.h], [0, tile.props.h / 2]];
      const exposed = [y === -1, x === 1, y === 1, x === -1];
      expect(tile.kids.filter((edge) => edge.color === "accent").map((edge) => edge.path[0]))
        .toEqual(p.flatMap((point, i) => exposed[i] ? [[point, p[(i + 1) % 4]]] : []));
      town.picking = "house";
      town.pickSite(x, y, cx);
      expect(text(tree())).toContain("不能放");
      expect(findByText(tree(), "預定這裡")).toBeNull();
    } else if (Math.abs(x) + Math.abs(y) === 2 && (x === 0 || y === 0)) {
      expectedRoads.push([tile.props.left + tile.props.w / 2, tile.props.top]);
    }
  }
  expect(roadCenters.sort()).toEqual(expectedRoads.sort());
});

test("道路文字", () => {
  const { town, cx, tree } = open();
  town.town.shared = readSharedCity({ terrainVersion: 1 });
  const tile = findById(tree(), "map-0--2");
  tile.handlers.mouseDown.left({ local_position: { x: tile.props.w / 2, y: tile.props.h / 2 }, bounds: {} }, cx);
  expect(text(tree())).toContain("地面|道路");
  findById(tree(), "building-house").handlers.click({}, cx);
  town.pickSite(0, -2, cx);
  const screen = text(tree());
  expect(screen).toContain("道路");
  expect(screen).toContain("不能放");
  expect(screen).not.toMatch(/provider|session|token|shared-v2|帳本|座標|\(-?\d+, ?-?\d+\)/i);
});

test("產場清單與詳情只用玩家用語", () => {
  for (const [type, label, purpose] of [
    ["lumberyard", "伐木場", /木材.*疏林/], ["quarry", "採石場", /石材.*碎石/], ["workshop", "工坊", /鐵料.*碎石.*峭壁/],
  ]) {
    const { town, cx, tree } = open();
    town.town.shared = readSharedCity({ terrainVersion: 1 });
    const card = findById(tree(), `building-${type}`);
    expect(playerScreen(card)).toContain(label);
    expect(playerScreen(card)).toMatch(purpose);
    card.handlers.click({}, cx);
    town.pickSite(3, 1, cx);
    expect(playerScreen(findById(tree(), "detail"))).toMatch(purpose);
    expect(playerScreen(tree())).toContain("預定這裡");
    town.town.shared = readSharedCity({ buildings: [{ building: type, label, x: 3, y: 1, cells: [{ x: 3, y: 1 }] }] });
    town.picking = null;
    town.pickSite(3, 1, cx);
    expect(playerScreen(findById(tree(), "detail"))).toMatch(purpose);
  }
});

test("人口維護與缺人只用玩家用語", () => {
  const { town, tree } = open();
  const building = (type, label, x, y) => ({ building: type, label, x, y, w: 2, h: 2, cells: [{ x, y }], reveal: 2 });
  const buildings = [building("market", "市場", 2, 1), building("library", "書庫", -3, 2)];
  town.town.shared = readSharedCity({ buildings });
  expect(playerScreen(findById(tree(), "top"))).toContain("人口 2/2|維護 5.88%");
  expect(playerScreen(tree())).toContain("書庫・缺人");
  expect(text(findById(tree(), "map"))).not.toContain("市場・缺人");
  buildings.push(building("house", "民居", 2, 3));
  town.town.shared = readSharedCity({ buildings });
  expect(playerScreen(findById(tree(), "top"))).toContain("人口 5/6|維護 8.33%");
  expect(playerScreen(tree())).not.toContain("缺人");
});

describe("固定情境的分區與庫存", () => {
  test("三個區塊都在，庫存、佇列與施工中的那一項照模型顯示", () => {
    const { tree } = open();
    const screen = text(tree());
    expect(screen).toContain("共用倉庫|12|木材|8|石材|3|鐵料");
    expect(screen).toContain("建設佇列（2/3）");
    expect(screen).toContain("施工中：哨站");
    expect(screen).toContain("選址與建設");
    // 地圖真的有格子（菱形命中由 core/grid.js 的測試釘住，這裡只確認它們被接到畫面上）。
    expect(mapTiles(tree()).length).toBeGreaterThan(20);
  });

  test("工期用份，不顯示時刻或工程詞", () => {
    const { tree } = open();
    const screen = text(tree());
    expect(screen).toContain("#1 哨站");
    expect(screen).toContain("#2 民居");
    expect(screen).toContain("施工中：哨站・還要 3 份");
    expect(screen).toContain("工期|還要 3 份");
    expect(screen).not.toMatch(/預計開工|\d{1,2}:\d{2}|provider|session|token|shared-v2|帳本|座標|\(-?\d+, ?-?\d+\)/i);
    // 第一棟民居缺木 8、石 2、鐵 3。
    expect(screen).toContain("備料中");
    expect(screen).toContain("還缺|木材 8・石材 2");
    // 只有還沒開工的那一項有取消按鈕；按鈕文字就是「取消」（施工中的哨站沒有）。
    expect(text(findByText(tree(), "取消"))).toBe("取消");
  });

  test("空城指引", () => {
    const { town, cx, tree } = open();
    town.town = null;
    expect(playerScreen(tree())).toContain("開始工作，第一批建材就會進倉");
    findByText(tree(), "開發模式").handlers.click({}, cx);
    expect(text(tree())).toContain("互動的 agent session");
  });

  test("全畫面模式切換與缺料", () => {
    const { town, cx, tree } = open();
    town.town.quotas = { unknowns: [{ provider: "openai-codex", reason: "尚未回報" }] };
    const toggle = () => findByText(tree(), "開發模式").handlers.click({}, cx);
    const queued = playerScreen(tree());
    expect(queued).toContain("下一份進帳|40%");
    expect(queued).toContain("還缺|木材 8・石材 2・鐵料 3；繼續工作就會進帳");
    expect(text(findById(tree(), "building-house"))).toContain("還缺 木材 11・石材 4・鐵料 4；繼續工作就會進帳");
    toggle();
    const dev = text(tree());
    for (const detail of ["provider 回報", "openai-codex", "更新額度", `帳本 ${SHARED_CITY_ID}`, "(4, 1)", "4000/10000 token"]) {
      expect(dev).toContain(detail);
    }
    toggle();
    findById(tree(), "building-house").handlers.click({}, cx);
    town.pickSite(-2, -2, cx);
    expect(playerScreen(tree())).toMatch(/排在目前佇列之後還缺 [^|]+繼續工作就會進帳/);
    toggle();
    expect(text(findById(tree(), "detail"))).toContain("民居 (-2, -2)");
    toggle();
    town.town.shared = readSharedCity({ terrainVersion: 1, roadArmLength: 3 });
    town.picking = null;
    town.pickSite(-2, -2, cx);
    expect(playerScreen(tree())).toContain("選取的土地");
    toggle();
    expect(text(tree())).toContain("選取的土地 (-2, -2)");
  });

  test("更新途中切換模式", async () => {
    const { cx, town, tree } = open();
    town.io = createFileIo();
    const toggle = () => findByText(tree(), "開發模式").handlers.click({}, cx);
    const reply = Promise.withResolvers();
    const command = spyOn(await import("herdr"), "exec").mockImplementation(() => reply.promise);
    try {
      toggle();
      findByText(tree(), "更新額度").handlers.click({}, cx);
      await waitFor(() => command.mock.calls.length > 0);
      expect(text(tree())).toContain("omp usage");
      toggle();
      playerScreen(tree());
      reply.resolve({ code: 7, stderr: "CLI provider unavailable" });
      await Promise.all(cx.running);
      playerScreen(tree());
      toggle();
      expect(text(tree())).toContain("exit 7）：CLI provider unavailable");
    } finally {
      reply.resolve({ code: 7, stderr: "" });
      command.mockRestore();
    }
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
    expect(town.selection).toEqual({ kind: "site", cityId: SHARED_CITY_ID, x, y });
    expect(selectionOf(town.ui, SHARED_CITY_ID)).toEqual({ kind: "site", cityId: SHARED_CITY_ID, x, y });
  });

  test("佇列還沒滿時點建築：進入選址（不用先等前一項蓋完）", () => {
    const { cx, town, tree } = open();
    const card = findById(tree(), "building-house");
    expect(card).not.toBeNull();
    card.handlers.click({}, cx);
    expect(town.picking).toBe("house");
    expect(town.toast).toBeNull();
  });

  test("佇列已滿時點建築：只給一句提示，不進入選址", () => {
    const { cx, town, tree } = open();
    const city = town.town.shared.city;
    city.queueLimit = city.queue.length; // 2/2：滿了
    const card = findById(tree(), "building-house");
    card.handlers.click({}, cx);
    expect(town.picking).toBeNull();
    expect(town.toast?.text).toContain("建設佇列已滿");
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
