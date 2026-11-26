import { describe, expect, test } from "bun:test";

import { CENTER, CENTER_CELLS, cellsWithin, gridDistance, isCenterCell, keyOf, neighbors } from "../core/grid.js";

describe("城鎮中心", () => {
  test("九格中心", () => {
    expect(CENTER_CELLS).toHaveLength(9);
    for (const cell of CENTER_CELLS) expect(isCenterCell(cell)).toBe(true);
    for (const cell of [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: -2 }, { x: 0, y: 2 }]) {
      expect(isCenterCell(cell)).toBe(false);
    }
  });

  test("鄰居與方圈距離", () => {
    const spot = { x: 2, y: -1 };
    expect(neighbors(spot).map(keyOf)).toEqual(["2,-2", "3,-1", "2,0", "1,-1"]);
    expect(gridDistance(CENTER, spot)).toBe(2);
    expect(gridDistance(spot, { x: -1, y: 2 })).toBe(3);
    expect([...cellsWithin(spot, 1)].map(keyOf).sort()).toEqual(
      ["1,-2", "1,-1", "1,0", "2,-2", "2,-1", "2,0", "3,-2", "3,-1", "3,0"].sort(),
    );
  });
});
