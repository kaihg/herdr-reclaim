// 地圖每一格的填色、框線與記號（#25–#27）：純資料，不碰 gpui。
// 這裡釘住「地形、預定地、工地、建築、合法錨點、選取」各自落在哪一個樣式桶，
// 以及預覽格不會同時被算成地形（否則預覽的紅綠會被下面的地形蓋掉）。
import { describe, expect, test } from "bun:test";

import { footprintCells, legalSites, revealedCells, siteCheck } from "../core/city-map.js";
import { mapCells } from "../core/map-style.js";

const RADIUS = 6;
const PLAN = {
  building: "outpost", label: "哨站", x: 4, y: 0,
  cells: [{ x: 4, y: 0 }], stage: "queued",
};
const MARKET = { building: "market", cells: footprintCells("market", { x: -3, y: 2 }) };
const CITY = { queue: [PLAN], buildings: [MARKET] };
const REVEALED = revealedCells(CITY);

const bucketOf = (layout, key, spotKey) => layout[key].find((bucket) => bucket.cells.some((cell) => `${cell.x},${cell.y}` === spotKey));

describe("地圖樣式（mapCells）", () => {
  test("已揭開的每一格都有一個填色與一個框線；迷霧不算", () => {
    const layout = mapCells({ ...CITY, revealed: REVEALED, radius: RADIUS });
    expect(layout.open).toHaveLength(REVEALED.size);
    const filled = layout.fills.flatMap((bucket) => bucket.cells.map((cell) => `${cell.x},${cell.y}`));
    const outlined = layout.outlines.flatMap((bucket) => bucket.cells.map((cell) => `${cell.x},${cell.y}`));
    expect(new Set(filled)).toEqual(new Set([...REVEALED]));
    expect(new Set(outlined)).toEqual(new Set([...REVEALED]));
    // 迷霧裡沒有填色。
    const fog = [...layout.fills.flatMap((bucket) => bucket.cells)].filter((cell) => !REVEALED.has(`${cell.x},${cell.y}`));
    expect(fog).toEqual([]);
  });

  test("地形依種類分桶；深水的框線用深水色，其餘是邊框色", () => {
    const layout = mapCells({ ...CITY, revealed: REVEALED, radius: RADIUS });
    // (-2, -3) 是手繪的深水；它與草地不會在同一個填色桶。
    const water = bucketOf(layout, "fills", "-2,-3");
    const grass = bucketOf(layout, "fills", "0,0");
    expect(water.token).toBe("ansi4");
    expect(grass.token).not.toBe("ansi4");
    expect(bucketOf(layout, "outlines", "-2,-3").token).toBe("ansi4");
    expect(bucketOf(layout, "outlines", "0,0").token).toBe("border");
  });

  test("預定地是強調色虛線、不在地形桶；完成建築是完成色並各自帶一個記號", () => {
    const layout = mapCells({ ...CITY, revealed: REVEALED, radius: RADIUS });
    const planFill = bucketOf(layout, "fills", "4,0");
    expect(planFill).toMatchObject({ kind: "solid", token: "accent", opacity: 0.22 });
    expect(bucketOf(layout, "outlines", "4,0")).toMatchObject({ token: "accent", dash: [4, 3] });
    expect(layout.marks.filter((mark) => mark.kind === "building").map((mark) => mark.recipe)).toEqual(["market", "market", "market", "market"]);
  });

  test("施工中（已開工）的預定地畫成工地斜線，不是預定地虛線", () => {
    const building = { ...PLAN, stage: "building", startedAt: 1, completesAt: 2 };
    const layout = mapCells({ queue: [building], buildings: [], revealed: revealedCells({ queue: [building], buildings: [] }), radius: RADIUS });
    expect(bucketOf(layout, "fills", "4,0")).toMatchObject({ kind: "slash", token: "working" });
    expect(bucketOf(layout, "outlines", "4,0")).toMatchObject({ token: "working", dash: null });
  });

  test("合法錨點與選取用強調色；預覽格只出一個記號，不重複算成地形", () => {
    const preview = siteCheck(CITY, "market", { x: 2, y: 2 });
    const [anchor] = legalSites(CITY, "market");
    expect(anchor).toBeDefined();
    const layout = mapCells({
      ...CITY,
      revealed: REVEALED,
      legal: [anchor],
      preview,
      selected: { x: 0, y: 2 },
      radius: RADIUS,
    });
    expect(bucketOf(layout, "outlines", `${anchor.x},${anchor.y}`)).toMatchObject({ token: "accent", dash: [2, 4] });
    expect(bucketOf(layout, "outlines", "0,2")).toMatchObject({ token: "accent", dash: null });
    const previewCells = layout.marks.filter((mark) => mark.kind === "preview");
    expect(previewCells.map((mark) => `${mark.spot.x},${mark.spot.y}`).sort()).toEqual(["2,2", "2,3", "3,2", "3,3"]);
    for (const mark of previewCells) {
      expect(bucketOf(layout, "fills", `${mark.spot.x},${mark.spot.y}`)).toBeUndefined();
    }
  });
});
