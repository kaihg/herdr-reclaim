// 城鎮中心是 2×2；中心旁邊一格開城就是已揭開的空地（看得到地面、還沒有人開墾）。
import { describe, expect, test } from "bun:test";
import { CENTER_CELLS, CENTER_RING, bfsNextTile, isCenterCell, keyOf, revealedKeys } from "../core/grid.js";

const allocate = (count) => {
  const taken = new Set();
  const spots = [];
  for (let index = 0; index < count; index++) {
    const spot = bfsNextTile((candidate) => taken.has(keyOf(candidate)));
    taken.add(keyOf(spot));
    spots.push([spot.x, spot.y]);
  }
  return spots;
};

describe("2×2 城鎮中心", () => {
  test("四格都是中心；旁邊與斜角不是", () => {
    for (const cell of CENTER_CELLS) expect(isCenterCell(cell)).toBe(true);
    expect(isCenterCell({ x: 2, y: 0 })).toBe(false);
    expect(isCenterCell({ x: -1, y: -1 })).toBe(false);
    expect(isCenterCell({ x: 1, y: 2 })).toBe(false);
  });

  test("相接的 8 格：每一格都只和中心塊共一條邊（斜角不算）", () => {
    expect(CENTER_RING).toHaveLength(8);
    for (const spot of CENTER_RING) {
      expect(isCenterCell(spot)).toBe(false);
      const touching = CENTER_CELLS.filter((cell) => Math.abs(cell.x - spot.x) + Math.abs(cell.y - spot.y) === 1);
      expect(touching).toHaveLength(1);
    }
    expect(new Set(CENTER_RING.map(keyOf)).size).toBe(8);
  });

  test("選地：中心四格永遠不分配；先填滿相接的 8 格（北、東、南、西），再往外一圈", () => {
    const spots = allocate(12);
    expect(spots.slice(0, 8)).toEqual([[0, -1], [1, -1], [2, 0], [2, 1], [1, 2], [0, 2], [-1, 1], [-1, 0]]);
    for (const [x, y] of spots) expect(isCenterCell({ x, y })).toBe(false);
    expect(new Set(spots.map(([x, y]) => `${x},${y}`)).size).toBe(12);
    // 第 9 支起離中心塊 2 格以上。
    for (const [x, y] of spots.slice(8)) {
      expect(CENTER_RING.some((spot) => spot.x === x && spot.y === y)).toBe(false);
    }
  });

  test("撤回釋放的格子下一支遠征會拿回來（最近的空格）", () => {
    const taken = new Set(["0,-1", "1,-1", "2,0"]);
    taken.delete("1,-1");
    expect(bfsNextTile((spot) => taken.has(keyOf(spot)))).toEqual({ x: 1, y: -1 });
  });
});

describe("已揭開的格子", () => {
  test("空城：中心四格加相接的 8 格，其餘都在迷霧裡", () => {
    const revealed = revealedKeys([]);
    expect(revealed.size).toBe(12);
    expect(revealed.has("2,0") && revealed.has("-1,1") && revealed.has("1,2")).toBe(true);
    expect(revealed.has("-1,-1")).toBe(false); // 斜角
    expect(revealed.has("3,0")).toBe(false);
  });

  test("預留的遠征不揭開鄰格；達到 100 點（已開墾／已建）才揭開自己與上下左右", () => {
    const reserved = revealedKeys([{ x: 2, y: 0, landStage: "reserved" }]);
    expect(reserved.has("3,0")).toBe(false);
    const cleared = revealedKeys([{ x: 2, y: 0, landStage: "cleared" }, { x: 0, y: -1, landStage: "built" }]);
    for (const key of ["3,0", "2,-1", "0,-2", "-1,-1", "1,-1"]) expect(cleared.has(key)).toBe(true);
    expect(cleared.has("3,1")).toBe(false);
    expect(revealedKeys([{ x: 5, y: 5, landStage: "withdrawn" }]).has("5,5")).toBe(false);
  });
});
