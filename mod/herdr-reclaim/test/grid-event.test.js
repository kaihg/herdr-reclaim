// 事件的座標系與地圖平移（ticket #13 第二輪 QA 的兩個失敗）：
// (A) 邊界內側 3 px 的點擊選到隔壁那一格——根因是事件座標帶著畫面縮放（zoom），
//     而格子的寬高是版面 px；兩者差一個係數時，越靠菱形外側的點就越會被算成鄰格。
//     修法：用事件自己的 bounds.width / 格寬 校正（不猜 zoom），見 cellAtEvent。
// (B) 地圖的平移（滾輪／觸控板）改由相機負責：往下捲＝內容往上，並夾在畫得出來的範圍。
import { describe, expect, test } from "bun:test";

import { BUILDING_MOCK, PLOT_DIAMOND, buildingPolygons } from "../ui/assets.js";
import { MAP_RADIUS, TILE, cameraFor, cellAtEvent, cellAtOffset, clampCamera, contentSize, ensureVisible, eventPoint, originInContent, panCamera, projectTile, visibleRect } from "../core/grid.js";

const tile = { w: 84, h: 44 };
const zoom = 1.2; // 真視窗的預設縮放（settings.zoom）

/** 一格方框內（版面 px）的點 → 事件會給的座標（含縮放）。 */
const device = (point) => ({ x: point.x * zoom, y: point.y * zoom });
const bounds = { x: 100, y: 200, width: tile.w * zoom, height: tile.h * zoom };

describe("事件座標 → 版面座標（cellAtEvent 的校正）", () => {
  test("bounds.width 就是格寬時（沒有縮放）原樣使用", () => {
    expect(eventPoint({ x: 21, y: 11 }, { width: tile.w }, tile)).toEqual({ x: 21, y: 11 });
    expect(eventPoint({ x: 21, y: 11 }, null, tile)).toEqual({ x: 21, y: 11 });
  });

  test("bounds.width 含縮放時換回版面 px", () => {
    const scaled = eventPoint({ x: 21 * 1.6, y: 11 * 1.6 }, { width: tile.w * 1.6 }, tile);
    expect(scaled.x).toBeCloseTo(21, 6);
    expect(scaled.y).toBeCloseTo(11, 6);
  });
});

describe("邊界命中（QA 的 ±3px 測點）", () => {
  test("四個頂點往內 3 px（事件座標含 1.2 縮放）都選到自己", () => {
    const inside = [
      { x: tile.w - 3, y: tile.h / 2 }, // 右頂點
      { x: 3, y: tile.h / 2 }, // 左頂點
      { x: tile.w / 2, y: 3 }, // 上頂點
      { x: tile.w / 2, y: tile.h - 3 }, // 下頂點
    ];
    for (const point of inside) {
      expect(cellAtEvent({ local_position: device(point), bounds }, tile)).toEqual({ dx: 0, dy: 0 });
    }
  });

  test("四條共邊中點往內 3 px 也選到自己", () => {
    const middle = 3 / Math.SQRT2; // 3 px 的內法線分量
    const edges = [
      { x: tile.w / 4 + middle, y: tile.h / 4 + middle }, // 左上邊（鄰格 (0,-1)）
      { x: (3 * tile.w) / 4 - middle, y: tile.h / 4 + middle }, // 右上邊（鄰格 (1,0)）
      { x: (3 * tile.w) / 4 - middle, y: (3 * tile.h) / 4 - middle }, // 右下邊（鄰格 (0,1)）
      { x: tile.w / 4 + middle, y: (3 * tile.h) / 4 - middle }, // 左下邊（鄰格 (-1,0)）
    ];
    for (const point of edges) {
      expect(cellAtEvent({ local_position: device(point), bounds }, tile)).toEqual({ dx: 0, dy: 0 });
    }
  });

  test("方框的角（菱形之外）仍然歸隔壁那一格", () => {
    expect(cellAtEvent({ local_position: device({ x: tile.w - 2, y: 2 }), bounds }, tile)).toEqual({ dx: 0, dy: -1 });
    expect(cellAtEvent({ local_position: device({ x: 2, y: 2 }), bounds }, tile)).toEqual({ dx: -1, dy: 0 });
    expect(cellAtEvent({ local_position: device({ x: 2, y: tile.h - 2 }), bounds }, tile)).toEqual({ dx: 0, dy: 1 });
    expect(cellAtEvent({ local_position: device({ x: tile.w - 2, y: tile.h - 2 }), bounds }, tile)).toEqual({ dx: 1, dy: 0 });
  });

  test("辨識力：不校正縮放（舊行為）會把這些邊界內側的點算成鄰格", () => {
    const near = device({ x: tile.w - 3, y: tile.h / 2 });
    expect(cellAtEvent({ local_position: near, bounds }, tile)).toEqual({ dx: 0, dy: 0 });
    // 同一點直接餵給 cellAtOffset（等於沒有校正）就會跑到鄰格。
    expect(cellAtOffset(near, tile)).not.toEqual({ dx: 0, dy: 0 });
  });

  test("沒有座標時回 null，不亂選", () => {
    expect(cellAtEvent({}, tile)).toBeNull();
    expect(cellAtEvent({ local_position: null }, tile)).toBeNull();
    expect(eventPoint(null, bounds, tile)).toBeNull();
  });
});

describe("平移（panCamera）", () => {
  const size = contentSize(9, tile); // 1596 × 836
  const viewport = { width: 600, height: 500 };
  const mid = cameraFor({ x: 0, y: 0 }, viewport);

  test("往下／往右捲＝內容往上／往左（相機減去 delta）", () => {
    const next = panCamera(mid, { x: 30, y: 40 }, size, viewport);
    // 相機設在中間時，往上／往左都還有空間。
    expect(next.y).toBe(mid.y - 40);
    expect(next.x).toBe(mid.x - 30);
  });

  test("夾在畫得出來的範圍：不會捲到看不見圖", () => {
    const far = panCamera(mid, { x: 10_000, y: 10_000 }, size, viewport);
    expect(far.x).toBe(viewport.width - size.width);
    expect(far.y).toBe(viewport.height - size.height);
    const back = panCamera(mid, { x: -10_000, y: -10_000 }, size, viewport);
    expect(back.x).toBe(0);
    expect(back.y).toBe(0);
  });

  test("內容比視窗小的那一軸固定在 0", () => {
    const small = { width: 100, height: 80 };
    const next = panCamera({ x: 0, y: 0 }, { x: 50, y: 50 }, small, viewport);
    expect(next).toEqual({ x: 0, y: 0 });
  });
});

// QA4／final-smoke 的失敗：600 UI px 的**四角格**「在框內卻沒有完整可見」——
// (-9,-9) 被頂部圖例蓋住／落在上緣外、(9,9) 落下緣、(9,-9) 地物被裁。
// 根因是「可見區」的判定用了整個地圖框，沒有扣掉覆蓋層（圖例、量測面板）。
// 這一組把可見區換成 `visibleRect`（覆蓋層尺寸由 render 實測回報），並要求：
// 任何視窗寬高 × 四角＋四邊中點 × 最高建築的格子外框，全部落在可見區裡。
describe("選取入畫（可見區＝地圖框扣掉覆蓋層）", () => {
  // main.js 的欄寬規則：左 clamp(96, 19%, 240)、右 clamp(108, 26%, 292)，其餘給地圖。
  const mapAreaOf = (paneWidthUi, paneHeightUi = 700) => {
    const clamp = (min, value, max) => Math.max(min, Math.min(max, value));
    const leftW = Math.round(clamp(96, paneWidthUi * 0.19, 240));
    const rightW = Math.round(clamp(108, paneWidthUi * 0.26, 292));
    return { width: Math.max(80, paneWidthUi - leftW - rightW), height: paneHeightUi - 104 };
  };
  // 圖例與量測面板的尺寸是 render 量到的（窄 pane 文字換行 → 比較高）。
  const legends = { "圖例 62px": { width: 300, height: 62 }, "圖例 104px（窄 pane 換行）": { width: 280, height: 104 } };
  const viewports = { "600 UI px": mapAreaOf(599), "820 UI px": mapAreaOf(819), "寬版 1200 UI px": mapAreaOf(1200) };
  const cells = [
    { x: -9, y: -9 }, { x: 9, y: -9 }, { x: -9, y: 9 }, { x: 9, y: 9 }, // 四角
    { x: 0, y: -9 }, { x: 0, y: 9 }, { x: -9, y: 0 }, { x: 9, y: 0 }, // 四邊中點
    { x: 1, y: -1 }, { x: 0, y: 0 }, // 最高建築（圖書館）與中心
  ];
  const tileOf = (area) => {
    const w = Math.max(56, Math.min(84, Math.floor(area.width / 5.4)));
    return { w, h: Math.round(w / 1.909) };
  };
  const boxOf = (cell, camera, tile) => {
    const origin = { left: contentSize(MAP_RADIUS, tile).width / 2 - tile.w / 2, top: contentSize(MAP_RADIUS, tile).height / 2 - tile.h / 2 };
    const spot = projectTile(cell, tile);
    return { left: camera.x + origin.left + spot.left, top: camera.y + origin.top + spot.top, width: tile.w, height: tile.h };
  };
  /** 與 main.js 同一條路徑：夾範圍（整個地圖框）→ ensureVisible（可見區）。 */
  const cameraOf = (cell, area, visible, tile) => {
    const size = contentSize(MAP_RADIUS, tile);
    const centred = cameraFor(cell, visible, MAP_RADIUS, tile);
    return ensureVisible(cell, clampCamera(centred, size, area), visible, MAP_RADIUS, tile);
  };

  for (const [areaName, area] of Object.entries(viewports)) {
    for (const [legendName, legend] of Object.entries(legends)) {
      test(`${areaName}／${legendName}：四角＋四邊中點＋最高建築格都完整落在可見區內`, () => {
        const tile = tileOf(area);
        const visible = visibleRect(area, legend, null);
        for (const cell of cells) {
          const box = boxOf(cell, cameraOf(cell, area, visible, tile), tile);
          expect(box.left).toBeGreaterThanOrEqual(visible.x - 0.5);
          expect(box.top).toBeGreaterThanOrEqual(visible.y - 0.5);
          expect(box.left + box.width).toBeLessThanOrEqual(visible.x + visible.width + 0.5);
          expect(box.top + box.height).toBeLessThanOrEqual(visible.y + visible.height + 0.5);
        }
      });
    }
  }

  test("辨識力：可見區若用整個地圖框（舊假設），(-9,-9) 這種上緣格就會落在圖例下面", () => {
    const area = mapAreaOf(599);
    const tile = tileOf(area);
    const legend = legends["圖例 104px（窄 pane 換行）"];
    const visible = visibleRect(area, legend, null);
    // 舊假設：可見區＝整個地圖框。內容區最上面那一列（y=-9）本來就貼著內容上緣，
    // 相機最多只能到 0，所以那一列的格子會被釘在框頂＝圖例底下。
    const naive = ensureVisible({ x: -9, y: -9 }, clampCamera(cameraFor({ x: -9, y: -9 }, area, MAP_RADIUS, tile), contentSize(MAP_RADIUS, tile), area), area, MAP_RADIUS, tile);
    const naiveBox = boxOf({ x: -9, y: -9 }, naive, tile);
    expect(naiveBox.top).toBeLessThan(visible.y); // ← 會被圖例蓋住（舊行為）
    const fixedBox = boxOf({ x: -9, y: -9 }, cameraOf({ x: -9, y: -9 }, area, visible, tile), tile);
    expect(fixedBox.top).toBeGreaterThanOrEqual(visible.y - 0.5); // 修好後在圖例下方
  });

  test("最高的 mock 建築（圖書館）畫在格子方框內，所以「格＋地物外框」＝格子方框", () => {
    const inUnitBox = (points) => points.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 100);
    const library = buildingPolygons(BUILDING_MOCK.library);
    expect(inUnitBox(library.roof)).toBe(true);
    expect(inUnitBox(library.body)).toBe(true);
    expect(inUnitBox(PLOT_DIAMOND)).toBe(true);
    for (const mock of Object.values(BUILDING_MOCK)) {
      const shape = buildingPolygons(mock);
      expect(inUnitBox(shape.roof)).toBe(true);
      expect(inUnitBox(shape.body)).toBe(true);
    }
  });
});
