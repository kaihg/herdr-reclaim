// 地圖命中測試：螢幕點 → 邏輯格只靠 core/grid.js 的反解，命中範圍是菱形，不是外接矩形。
// 這支測試釘住三件事：每一格自己的座標系回到自己、菱形內部回到自己、
// 外接矩形互相重疊的那塊角落**不**屬於相鄰格（舊行為會點錯）。
import { describe, expect, test } from "bun:test";

import { MAP_RADIUS, TILE, cellAtEvent, cellAtOffset, contentSize, eventPoint, originInContent, projectTile } from "../core/grid.js";

const tile = { w: 84, h: 44 };
const cell = (dx, dy) => ({ x: dx, y: dy });

describe("cellAtOffset：地面菱形命中", () => {
  test("每一格方框的正中央都回到自己", () => {
    for (const spot of [cell(0, 0), cell(4, 0), cell(-3, 2), cell(9, -9)]) {
      expect(cellAtOffset({ x: tile.w / 2, y: tile.h / 2 }, tile)).toEqual({ dx: 0, dy: 0 });
      expect(spot).toBeDefined();
    }
  });

  test("菱形內部（中心偏 40% 半寬／半高）也回到自己", () => {
    const offsets = [
      { x: tile.w * 0.5 + tile.w * 0.2, y: tile.h * 0.5 },
      { x: tile.w * 0.5 - tile.w * 0.2, y: tile.h * 0.5 },
      { x: tile.w * 0.5, y: tile.h * 0.5 + tile.h * 0.2 },
      { x: tile.w * 0.5, y: tile.h * 0.5 - tile.h * 0.2 },
    ];
    for (const point of offsets) expect(cellAtOffset(point, tile)).toEqual({ dx: 0, dy: 0 });
  });

  test("方框的角屬於隔壁那一格（相鄰格不因外接矩形重疊點錯）", () => {
    // 右上角在菱形上緣之外：屬於上面那一格（dx = 0, dy = -1）。
    expect(cellAtOffset({ x: tile.w * 0.97, y: tile.h * 0.03 }, tile)).toEqual({ dx: 0, dy: -1 });
    // 左上角：屬於左邊那一格。
    expect(cellAtOffset({ x: tile.w * 0.03, y: tile.h * 0.03 }, tile)).toEqual({ dx: -1, dy: 0 });
    // 右下角：屬於右邊那一格。
    expect(cellAtOffset({ x: tile.w * 0.97, y: tile.h * 0.97 }, tile)).toEqual({ dx: 1, dy: 0 });
    // 左下角：屬於下面那一格。
    expect(cellAtOffset({ x: tile.w * 0.03, y: tile.h * 0.97 }, tile)).toEqual({ dx: 0, dy: 1 });
  });

  test("同一個點問兩次得到同一格（決定性）", () => {
    const point = { x: tile.w * 0.71, y: tile.h * 0.23 };
    expect(cellAtOffset(point, tile)).toEqual(cellAtOffset(point, tile));
  });

  test("事件座標會依 bounds 的縮放換回版面像素，再用同一條菱形判斷", () => {
    const event = { local_position: { x: tile.w * 0.5 * 2, y: tile.h * 0.5 * 2 }, bounds: { width: tile.w * 2 } };
    expect(eventPoint(event.local_position, event.bounds, tile)).toEqual({ x: tile.w / 2, y: tile.h / 2 });
    expect(cellAtEvent(event, tile)).toEqual({ dx: 0, dy: 0 });
    // bounds 沒有寬度時當成已經是版面 px。
    expect(eventPoint({ x: 10, y: 20 }, {}, tile)).toEqual({ x: 10, y: 20 });
  });
});

describe("投影與內容區", () => {
  test("內容區是 (2r+1)² 格的投影外框，格子剛好貼滿四個邊", () => {
    const radius = 3;
    const size = contentSize(radius, tile);
    const origin = originInContent(radius, tile);
    expect(size).toEqual({ width: (2 * radius + 1) * tile.w, height: (2 * radius + 1) * tile.h });
    // 最左邊那一格（x = -r, y = r）的左緣、最上面那一格（x = y = -r）的上緣都貼齊內容區。
    const leftmost = projectTile({ x: -radius, y: radius }, tile);
    expect(origin.left + leftmost.left).toBe(0);
    const topmost = projectTile({ x: -radius, y: -radius }, tile);
    expect(origin.top + topmost.top).toBe(0);
  });

  test("真實半徑是 19×19＝361 格（驗收的 300 格情境）", () => {
    const size = contentSize(MAP_RADIUS, TILE);
    expect((size.width / TILE.w) * (size.height / TILE.h)).toBe(361);
  });
});
