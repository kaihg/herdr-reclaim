// 中央的 3/4 城市地圖（proposal §4、§14.1）：固定格大小＋原生雙軸捲動，
// 邏輯座標與投影分開（core/grid.js），命中一律回到地面菱形。
//
// 點擊只在**內容層**收一次（on_mouse_down + local_position → cellAtPoint）：
// 建築與標籤都是沒有事件的純裝飾，所以「不同高度的建築不攔截地面格點擊」，
// 相鄰格也不會因為外接矩形重疊而點錯。格子本身沒有事件，捲動是原生 retained scroll。
//
// 361 格的底層（迷霧／已揭開／空格框線）合成少數幾個向量路徑，
// 只有真的有遠征的格子才逐一畫（常見的小城元素很少，大城也不會爆）。
import { Background, PathBuilder, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { MAP_RADIUS, cellAtPoint, contentSize, keyOf, originInContent, projectTile } from "../core/grid.js";
import { GROUND_MOCK, PLOT_DIAMOND, buildingOf, buildingPolygons, factionStyle, groundOf, legendGroups } from "./assets.js";

const LOCAL = { left: 0, top: 0 };

/**
 * 地圖：內容區是 361 格的投影外框（`contentSize`），格子依 `cellIndex` 的順序排，
 * 所以 `scroll.scroll_to_item(cellIndex(...))` 就能把選取或跳轉的那一格帶進畫面。
 */
export function mapView({
  city, tiles, revealed, selection, theme: t, tile, scroll, legendOpen,
  radius = MAP_RADIUS, onToggleLegend, onPick,
}) {
  const size = contentSize(radius, tile);
  const origin = originInContent(radius, tile);
  const fog = [];
  const open = [];
  const outlines = [];
  const occupied = [];
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      const entry = tiles.get(keyOf({ x, y }));
      if (entry) {
        occupied.push(entry);
        continue;
      }
      (revealed.has(keyOf({ x, y })) ? open : fog).push({ x, y });
      outlines.push({ x, y });
    }
  }
  const content = div()
    .id("map-content")
    .relative()
    .flex_none()
    .w(size.width)
    .h(size.height)
    .children([
      fullPath(batched(fog, tile, origin), Background.pattern_slash(t.dim, 1, 4), size),
      fullPath(batched(open, tile, origin), t.background, size),
      fullPath(stroked(outlines, tile, origin), t.border, size),
      centerCell(city, t, tile, origin),
      ...occupied.map((entry) => cell(entry, selection, t, tile, origin)),
    ])
    // 命中的唯一入口：local_position 是內容座標，反解成邏輯格（建築、標籤都攔不到）。
    .on_mouse_down("left", (event, cx) => {
      const local = event.local_position;
      if (!local) return;
      const hit = cellAtPoint(local, radius, tile);
      if (hit) onPick(hit, cx);
    });
  return div()
    .id("map")
    .size_full()
    .relative()
    .overflow_hidden()
    .bg(t.background)
    .child(
      div()
        .id("map-scroll")
        .size_full()
        .overflow_scrollbar()
        .track_scroll(scroll)
        .child(content),
    )
    .child(legendPanel(t, legendOpen, onToggleLegend));
}

/** 圖例（§14 的素材與狀態）：只解釋畫面看得到的 mock，不新增玩法。 */
function legendPanel(t, open, onToggle) {
  const groups = legendGroups();
  const row = (text, color) => div().text_size(9).text_color(color).truncate().child(text);
  const swatch = (token) => div().size(8).flex_none().rounded(2).bg(t[token] ?? t.muted);
  const entry = (token, label) => h_flex().gap(3).items_center().flex_none()
    .child(swatch(token)).child(row(label, t.muted));
  return v_flex()
    .id("map-legend")
    .absolute()
    .left(8)
    .top(6)
    .max_w(620)
    .gap(2)
    .p(6)
    .rounded(4)
    .bg(t.chrome)
    .border(1)
    .border_color(t.border)
    .cursor_pointer()
    .on_click((_event, cx) => onToggle(cx))
    .child(h_flex().gap(6).items_center()
      .child(row("城市地圖 · 素材 mock（向量）", t.dim))
      .child(row(open ? "▾ 收合" : "▸ 展開", t.accent)))
    .when(open, (element) => element.children([
      h_flex().gap(8).items_center().flex_wrap()
        .child(row("狀態", t.dim))
        .child(row("● 探索中 · ○ 駐紮", t.muted))
        .children(groups.stage.map((mark) => entry(mark.token, mark.label))),
      h_flex().gap(8).items_center().flex_wrap()
        .child(row("地面", t.dim))
        .children(groups.ground.map((ground) => entry(ground.token, ground.label))),
      h_flex().gap(8).items_center().flex_wrap()
        .child(row("派系", t.dim))
        .children(groups.faction.map((faction) => entry(faction.token, faction.label))),
      row("其他：▨ 迷霧 · ⚑ 來源不明（左側）· 已撤回／已封存只留在左側與詳情", t.dim),
    ]));
}

// ---- 向量路徑

/** 一格的菱形四個角（內容座標）。 */
function diamondPoints({ x, y }, tile, origin) {
  const spot = projectTile({ x, y }, tile);
  const left = origin.left + spot.left;
  const top = origin.top + spot.top;
  return [
    [left + tile.w / 2, top],
    [left + tile.w, top + tile.h / 2],
    [left + tile.w / 2, top + tile.h],
    [left, top + tile.h / 2],
  ];
}

/** 許多格合成一條填色路徑（迷霧、已揭開、空格的框線都只有幾個元素）。 */
function batched(cells, tile, origin) {
  const builder = PathBuilder.fill();
  for (const spot of cells) builder.add_polygon(diamondPoints(spot, tile, origin)).close();
  return builder.build();
}

function stroked(cells, tile, origin, dash) {
  const builder = dash ? PathBuilder.stroke(1).dash_array(dash) : PathBuilder.stroke(1);
  for (const spot of cells) builder.add_polygon(diamondPoints(spot, tile, origin)).close();
  return builder.build();
}

/** 內容區大小的路徑（座標就是內容座標）。 */
function fullPath(path, color, size) {
  return window.paint_path(path, color).absolute().left(0).top(0).w(size.width).h(size.height);
}

/** 一格方框內的路徑（百分比座標的 mock 圖形用）。 */
function tilePath(path, color, tile) {
  return window.paint_path(path, color).absolute().left(0).top(0).w(tile.w).h(tile.h);
}

// ---- 中心格與有遠征的格子

/** 一格自己的菱形（格子方框內的座標；方框由 cellBox 定位）。 */
function localDiamond(tile) {
  return [[tile.w / 2, 0], [tile.w, tile.h / 2], [tile.w / 2, tile.h], [0, tile.h / 2]];
}

function fillPath(points) {
  return PathBuilder.fill().add_polygon(points).close().build();
}

/** 一格的方框（絕對定位在它的投影位置）。 */
function cellBox({ x, y }, tile, origin) {
  const spot = projectTile({ x, y }, tile);
  return div()
    .id(`map-${x}-${y}`)
    .absolute()
    .left(origin.left + spot.left)
    .top(origin.top + spot.top)
    .w(tile.w)
    .h(tile.h);
}

function centerCell(city, t, tile, origin) {
  const points = localDiamond(tile);
  return cellBox(city.center, tile, origin).children([
    tilePath(fillPath(points), t.selected, tile),
    tilePath(PathBuilder.stroke(2.5).add_polygon(points).close().build(), t.accent, tile),
    markBox(city.center.label, t, tile, t.accent),
  ]);
}

function cell(entry, selection, t, tile, origin) {
  const selected = (selection?.kind === "expedition" && selection.rootSessionId === entry.rootSessionId) ||
    (selection?.kind === "tile" && selection.x === entry.x && selection.y === entry.y);
  const faction = factionStyle(entry.faction);
  const factionColor = t[faction.token] ?? t.muted;
  const ground = GROUND_MOCK[groundOf(entry)];
  const building = buildingOf(entry);
  const points = localDiamond(tile);
  const outline = entry.landStage === "reserved"
    ? stroked([{ x: 0, y: 0 }], tile, LOCAL, [4, 3])
    : selected
      ? PathBuilder.stroke(2.5).add_polygon(points).close().build()
      : stroked([{ x: 0, y: 0 }], tile, LOCAL);
  return cellBox(entry, tile, origin).children([
    tilePath(fillPath(points), selected ? t.selected : t.raised, tile),
    ground ? tilePath(fillPath(PLOT_DIAMOND), Background.solid(t[ground.token] ?? t.muted).opacity(0.35), tile) : null,
    building ? buildingMark(building, tile, factionColor) : null,
    tilePath(outline, entry.landStage === "built" ? factionColor : selected ? t.accent : t.muted, tile),
    markBox(`${entry.status === "active" ? "●" : "○"} ${String(entry.rootSessionId).slice(0, 8)}`, t, tile, t.foreground),
  ].filter(Boolean));
}

/** 建築 mock：牆＋屋頂（屋頂顏色就是派系）；種類不同高度不同。沒有事件，所以不擋點擊。 */
function buildingMark(mock, tile, factionColor) {
  const { roof, body } = buildingPolygons(mock);
  const layers = [
    tilePath(fillPath(body), Background.solid(factionColor).opacity(0.55), tile),
  ];
  if (mock.roof) {
    layers.push(tilePath(fillPath(roof), factionColor, tile));
  } else {
    // 城牆沒有屋頂：用上緣一條亮線表示，高度仍然最矮。
    layers.push(tilePath(fillPath([[24, mock.eave], [76, mock.eave], [76, mock.top], [24, mock.top]]), factionColor, tile));
  }
  return div().absolute().left(0).top(0).w(tile.w).h(tile.h).children(layers);
}

/** 遠征標記（● 探索中／○ 駐紮）：放在菱形的下半部，不會蓋到中段的建築。 */
function markBox(label, t, tile, color) {
  return div()
    .absolute()
    .left(0)
    .top(Math.round(tile.h * 0.62))
    .w_full()
    .text_center()
    .text_size(labelSize(tile))
    .text_color(color)
    .child(label);
}

/** 格子最小 56 px，所以標籤一定看得清楚（不再隨 pane 縮小而互相重疊）。 */
function labelSize(tile) {
  return Math.max(8, Math.min(10, Math.round(tile.w / 9)));
}
