// 事件的座標系與地圖平移（ticket #13 第二輪 QA 的兩個失敗）：
// (A) 邊界內側 3 px 的點擊選到隔壁那一格——根因是事件座標帶著畫面縮放（zoom），
//     而格子的寬高是版面 px；兩者差一個係數時，越靠菱形外側的點就越會被算成鄰格。
//     修法：用事件自己的 bounds.width / 格寬 校正（不猜 zoom），見 cellAtEvent。
// (B) 地圖的平移（滾輪／觸控板）改由相機負責：往下捲＝內容往上，並夾在畫得出來的範圍。
import { describe, expect, test } from "bun:test";

import { TILE, cameraFor, cellAtEvent, cellAtOffset, clampCamera, contentSize, ensureVisible, eventPoint, originInContent, panCamera } from "../core/grid.js";

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

// QA4 的失敗：600 UI px 窄 pane 選了圖書館（建築）卻沒有入畫。
// 這一組要求：任何視窗寬高 × 任何選取格（含靠邊的格）→ 那一格的菱形完整落在視窗內。
describe("選取入畫（cameraFor + clampCamera + ensureVisible）", () => {
  // main.js 的欄寬規則：左 clamp(96, 19%, 240)、右 clamp(108, 26%, 292)，其餘給地圖。
  const mapAreaOf = (paneWidthUi, paneHeightUi = 700) => {
    const clamp = (min, value, max) => Math.max(min, Math.min(max, value));
    const leftW = Math.round(clamp(96, paneWidthUi * 0.19, 240));
    const rightW = Math.round(clamp(108, paneWidthUi * 0.26, 292));
    return { width: Math.max(80, paneWidthUi - leftW - rightW), height: paneHeightUi - 104 };
  };
  const viewports = {
    "600 UI px": mapAreaOf(599),
    "820 UI px": mapAreaOf(819),
    "寬版 1200 UI px": mapAreaOf(1200),
    "極窄（比一格還小）": { width: 40, height: 24 },
  };
  const cells = [
    { x: 0, y: 0 }, { x: 1, y: -1 }, { x: -1, y: 0 },
    { x: 9, y: -9 }, { x: -9, y: 9 }, { x: 9, y: 9 }, { x: 0, y: -9 }, { x: -9, y: 0 },
  ];
  const radius = 9;
  // main.js 的格子大小：寬度除以 5.4、夾在 56–84；600 UI px 的 pane 約 60 px 一格。
  const tileOf = (viewport) => {
    const w = Math.max(56, Math.min(84, Math.floor(viewport.width / 5.4)));
    return { w, h: Math.round(w / 1.909) };
  };

  /** 相機定好之後，某一格的方框（視窗內的版面 px）。 */
  const boxOf = (cell, camera, tile) => {
    const origin = originInContent(radius, tile);
    const spot = { left: ((cell.x - cell.y) * tile.w) / 2, top: ((cell.x + cell.y) * tile.h) / 2 };
    return { left: camera.x + origin.left + spot.left, top: camera.y + origin.top + spot.top, width: tile.w, height: tile.h };
  };

  for (const [name, viewport] of Object.entries(viewports)) {
    test(`${name}：任何選取格都完整落在視窗內`, () => {
      const tile = tileOf(viewport);
      const size = contentSize(radius, tile);
      for (const cell of cells) {
        const centred = cameraFor(cell, viewport, radius, tile);
        const camera = ensureVisible(cell, clampCamera(centred, size, viewport), viewport, radius, tile);
        const box = boxOf(cell, camera, tile);
        if (box.width >= viewport.width || box.height >= viewport.height) {
          // 視窗比一格還小：做不到「整格入畫」，至少把它擺在視窗中央。
          expect(Math.abs(box.left + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(box.top + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(0.5);
          continue;
        }
        expect(box.left).toBeGreaterThanOrEqual(-0.5);
        expect(box.top).toBeGreaterThanOrEqual(-0.5);
        expect(box.left + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(box.top + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
      }
    });
  }

  test("視窗比一格大時，置中就是把那一格擺在正中央", () => {
    const viewport = { width: 323, height: 596 };
    const tile = tileOf(viewport);
    const camera = cameraFor({ x: 1, y: -1 }, viewport, radius, tile);
    const box = boxOf({ x: 1, y: -1 }, camera, tile);
    // cameraFor 會把相機取整（版面像素），所以允許 0.5 px 內的差。
    expect(Math.abs(box.left + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.top + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(0.5);
  });
});
