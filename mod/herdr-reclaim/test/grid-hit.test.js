// 地圖命中測試（ticket #13 AC3、§4「點擊以地面格子為準，屋頂只是裝飾」）：
// 螢幕點 → 邏輯格只靠 core/grid.js 的反解，命中範圍是菱形，不是外接矩形。
// 這支測試釘住三件事：每一格的中心回到自己、菱形內部回到自己、
// 外接矩形互相重疊的那塊角落**不**屬於相鄰格（舊行為會點錯）。
import { describe, expect, test } from "bun:test";

import { MAP_RADIUS, TILE, cellAtOffset, cellAtPoint, contentSize, originInContent, projectTile } from "../core/grid.js";

const radius = 3; // 固定情境用小的地圖；真實畫面是 MAP_RADIUS（19×19＝361 格）
const tile = { w: 84, h: 44 };

/** 某一格的中心點（內容座標）。 */
function centerOf({ x, y }) {
  const origin = originInContent(radius, tile);
  const spot = projectTile({ x, y }, tile);
  return { x: origin.left + spot.left + tile.w / 2, y: origin.top + spot.top + tile.h / 2 };
}

describe("cellAtPoint：地面菱形命中", () => {
  test("每一格的中心都回到自己（含最外圈與四個角）", () => {
    for (let x = -radius; x <= radius; x++) {
      for (let y = -radius; y <= radius; y++) {
        expect(cellAtPoint(centerOf({ x, y }), radius, tile)).toEqual({ x, y });
      }
    }
  });

  test("菱形內部（中心偏 40% 半寬／半高）也回到自己", () => {
    for (const [dx, dy] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4], [0.2, 0.2], [-0.2, -0.2]]) {
      const center = centerOf({ x: 1, y: 0 });
      const point = { x: center.x + dx * (tile.w / 2), y: center.y + dy * (tile.h / 2) };
      expect(cellAtPoint(point, radius, tile)).toEqual({ x: 1, y: 0 });
    }
  });

  test("方框重疊處不再點錯：確實存在「最後畫的方框 ≠ 菱形命中的格」的點，而且以菱形為準", () => {
    const origin = originInContent(radius, tile);
    const boxOf = (cell) => {
      const spot = projectTile(cell, tile);
      return { left: origin.left + spot.left, top: origin.top + spot.top };
    };
    const boxHit = (point) => {
      // 舊版行為：格子的方框就是命中區，重疊時最後畫的（x 外層、y 內層遞增）贏。
      let winner = null;
      for (let x = -radius; x <= radius; x++) {
        for (let y = -radius; y <= radius; y++) {
          const box = boxOf({ x, y });
          if (point.x >= box.left && point.x <= box.left + tile.w && point.y >= box.top && point.y <= box.top + tile.h) {
            winner = { x, y };
          }
        }
      }
      return winner;
    };
    const size = contentSize(radius, tile);
    let disagreements = 0;
    for (let px = 1; px < size.width; px += 3) {
      for (let py = 1; py < size.height; py += 3) {
        const point = { x: px, y: py };
        const hit = cellAtPoint(point, radius, tile);
        if (!hit) continue;
        if (boxHit(point)?.x !== hit.x || boxHit(point)?.y !== hit.y) disagreements++;
      }
    }
    // 舊行為確實會點錯一批點（不然這支測試就沒有辨識力）。
    expect(disagreements).toBeGreaterThan(50);
  });

  test("命中一定是菱形真的蓋到的那一格（唯一）", () => {
    const size = contentSize(radius, tile);
    const origin = originInContent(radius, tile);
    const distance = (point, cell) => {
      const u = (point.x - origin.left - tile.w / 2) / (tile.w / 2);
      const v = (point.y - origin.top - tile.h / 2) / (tile.h / 2);
      return Math.abs(u - (cell.x - cell.y)) + Math.abs(v - (cell.x + cell.y));
    };
    for (let px = 1; px < size.width; px += 7) {
      for (let py = 1; py < size.height; py += 7) {
        const point = { x: px, y: py };
        const hit = cellAtPoint(point, radius, tile);
        if (!hit) continue;
        expect(distance(point, hit)).toBeLessThanOrEqual(1);
        for (let x = -radius; x <= radius; x++) {
          for (let y = -radius; y <= radius; y++) {
            if (x === hit.x && y === hit.y) continue;
            expect(distance(point, { x, y })).toBeGreaterThan(1);
          }
        }
      }
    }
  });

  test("地圖外的點回 null（不改選取），地圖內每一點都有格", () => {
    const size = contentSize(radius, tile);
    expect(cellAtPoint({ x: -30, y: -30 }, radius, tile)).toBeNull();
    expect(cellAtPoint({ x: size.width + 30, y: size.height + 30 }, radius, tile)).toBeNull();
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 20; j++) {
        const point = { x: (size.width * i) / 40 + 0.5, y: (size.height * j) / 20 + 0.5 };
        const hit = cellAtPoint(point, radius, tile);
        if (!hit) continue; // 內容框的四個角落在 361 格之外，本來就沒有格
        expect(Math.abs(hit.x)).toBeLessThanOrEqual(radius);
        expect(Math.abs(hit.y)).toBeLessThanOrEqual(radius);
      }
    }
  });

  test("同一個點問兩次得到同一格（決定性）", () => {
    const point = { x: 123.4, y: 56.7 };
    expect(cellAtPoint(point, radius, tile)).toEqual(cellAtPoint(point, radius, tile));
  });
});

describe("投影與內容區", () => {
  test("內容區是 (2r+1)² 格的投影外框，格子剛好貼滿四個邊", () => {
    const size = contentSize(radius, tile);
    const origin = originInContent(radius, tile);
    expect(size).toEqual({ width: (2 * radius + 1) * tile.w, height: (2 * radius + 1) * tile.h });
    const last = projectTile({ x: radius, y: -radius }, tile);
    expect(origin.left + last.left + tile.w).toBe(size.width);
    const bottom = projectTile({ x: radius, y: radius }, tile);
    expect(origin.top + bottom.top + tile.h).toBe(size.height);
  });

  test("真實半徑是 19×19＝361 格（驗收的 300 格情境）", () => {
    expect((2 * MAP_RADIUS + 1) ** 2).toBe(361);
    expect(TILE.w).toBeGreaterThan(TILE.h); // 2:1 的斜俯視菱形
  });

  test("cellAtOffset：每一格自己的座標系，與內容座標的 cellAtPoint 完全一致", () => {
    const origin = originInContent(radius, tile);
    for (let px = 0; px < tile.w; px += 7) {
      for (let py = 0; py < tile.h; py += 5) {
        const offset = cellAtOffset({ x: px, y: py }, tile);
        // 把「這一格方框內的點」搬到內容座標，兩條路徑必須得到同一格。
        expect(cellAtPoint({ x: origin.left + px, y: origin.top + py }, radius, tile))
          .toEqual({ x: offset.dx, y: offset.dy });
      }
    }
  });

  test("cellAtOffset：方框的角屬於隔壁那一格（相鄰格不因外接矩形重疊點錯）", () => {
    // 右上角的點：仍在這一格的方框內，但菱形屬於 (x, y-1)（畫面上的右上鄰格）。
    expect(cellAtOffset({ x: tile.w - 2, y: 2 }, tile)).toEqual({ dx: 0, dy: -1 });
    expect(cellAtOffset({ x: 2, y: tile.h - 2 }, tile)).toEqual({ dx: 0, dy: 1 });
    expect(cellAtOffset({ x: tile.w - 2, y: tile.h - 2 }, tile)).toEqual({ dx: 1, dy: 0 });
    expect(cellAtOffset({ x: 2, y: 2 }, tile)).toEqual({ dx: -1, dy: 0 });
    expect(cellAtOffset({ x: tile.w / 2, y: tile.h / 2 }, tile)).toEqual({ dx: 0, dy: 0 });
  });
});
