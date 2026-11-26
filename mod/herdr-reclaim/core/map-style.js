// 共用城市地圖每一格的樣式（#25–#27）：純資料，不碰 gpui，也不改任何數值。
//
// 一格的填色與框線聚成同一條路徑：已揭開的格子會隨建築一直長（哨站一次 11×11），每格各畫
// 一條路徑會讓每一幀都在畫幾百條。只有預覽這種「少數且各自不同」的格子另外列成 marks。
//
// 顏色只給 token（主題色名），由畫面換成實際顏色；所以這一支可以在 bun 下直接測。
import { groundAt, TERRAIN } from "./city-map.js";
import { keyOf } from "./grid.js";

/** 形狀樣式：`solid` 是實心填色、`slash` 是斜線（工地）。 */
const solid = (token, opacity) => ({ kind: "solid", token, opacity });
const slash = (token, width, gap) => ({ kind: "slash", token, width, gap });

/**
 * 回傳 `{ open, fills, outlines, marks, preview }`：
 *   open     已揭開的格子（先鋪一層背景，蓋掉迷霧的斜線）
 *   fills    同一種填色的格子（`cells` 是格座標）
 *   outlines 同一種框線的格子（`token`、`dash`，虛線用 `[on, off]`）
 *   marks    預覽格（`{ spot, blocked }`）與完工建築（`{ spot, recipe }`）：各自畫
 *   preview  整片預覽（畫面用來把伸進迷霧的那一角畫成阻擋色）
 */
export function mapCells({ revealed, queue = [], buildings = [], terrainVersion, roadArmLength, legal = [], preview = null, selected = null, radius }) {
  const city = { queue, buildings, terrainVersion, roadArmLength };
  const planCells = new Set((queue ?? []).flatMap((item) => (item.cells ?? []).map((cell) => keyOf(cell))));
  const previewCells = new Map((preview?.cells ?? []).map((cell) => [keyOf(cell), cell]));
  const legalAnchors = new Set(legal.map((site) => keyOf(site)));
  const fills = new Map();
  const outlines = new Map();
  const open = [];
  const marks = [];
  const fillOf = (key, style, spot) => {
    if (!fills.has(key)) fills.set(key, { ...style, cells: [] });
    fills.get(key).cells.push(spot);
  };
  const outlineOf = (key, token, dash, spot) => {
    if (!outlines.has(key)) outlines.set(key, { token, dash, cells: [] });
    outlines.get(key).cells.push(spot);
  };
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      const spot = { x, y };
      const key = keyOf(spot);
      if (!revealed.has(key)) continue;
      open.push(spot);
      const marked = previewCells.get(key);
      if (marked) {
        // 預覽最多一整棟（≤ 4 格），照舊一格一條，才能逐格顯示「為什麼不能放」。
        marks.push({ kind: "preview", spot, blocked: Boolean(marked.problem) });
        continue;
      }
      const ground = groundAt(city, spot);
      if (ground === "building") {
        fillOf("done", solid("done", 0.3), spot);
        outlineOf("done", "done", null, spot);
        const done = buildings.find((building) => building.cells.some((cell) => keyOf(cell) === key));
        if (done) marks.push({ kind: "building", spot, recipe: done.building });
        continue;
      }
      if (ground === "site") {
        fillOf("site", slash("working", 1, 5), spot);
        outlineOf("site", "working", null, spot);
        continue;
      }
      if (planCells.has(key)) {
        fillOf("plan", solid("accent", 0.22), spot);
        outlineOf("plan", "accent", [4, 3], spot);
        continue;
      }
      const terrain = TERRAIN[ground];
      fillOf(`terrain:${ground}`, solid(terrain?.token ?? "raised", 0.5), spot);
      if (selected && selected.x === x && selected.y === y) outlineOf("selected", "accent", null, spot);
      else if (legalAnchors.has(key)) outlineOf("legal", "accent", [2, 4], spot);
      else outlineOf(`border:${terrain?.token ?? "border"}`, terrain?.buildable === false ? terrain.token : "border", null, spot);
    }
  }
  return {
    open,
    fills: [...fills.values()],
    outlines: [...outlines.values()],
    marks,
    preview: [...previewCells.values()],
  };
}
