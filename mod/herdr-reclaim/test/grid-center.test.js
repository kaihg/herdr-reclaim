// 城鎮中心的 2×2：帳本的選址前提（`siteCheck` 的 center 原因）與畫面共用同一個判斷。
import { describe, expect, test } from "bun:test";

import { CENTER, CENTER_CELLS, isCenterCell, keyOf } from "../core/grid.js";

describe("城鎮中心", () => {
  test("2×2 的四格都是中心，緊鄰的格子不是", () => {
    expect(CENTER_CELLS).toHaveLength(4);
    expect(new Set(CENTER_CELLS.map(keyOf))).toEqual(new Set(["0,0", "1,0", "0,1", "1,1"]));
    for (const cell of CENTER_CELLS) expect(isCenterCell(cell)).toBe(true);
    for (const cell of [{ x: -1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 2 }]) {
      expect(isCenterCell(cell)).toBe(false);
    }
  });

  test("中心從 (0, 0) 起算；畫面與帳本用的是同一個常數", () => {
    expect(CENTER).toEqual({ x: 0, y: 0 });
  });
});
