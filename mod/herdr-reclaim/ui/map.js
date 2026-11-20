// 中央的 3/4 城市地圖（proposal §4、§14.1）：固定格大小＋原生雙軸捲動，
// 邏輯座標與投影分開（core/grid.js），命中一律回到地面菱形。
//
// 命中：**每一格自己收事件**（on_mouse_down 的 local_position 是那一格方框內的座標），
// 再用 core/grid.js 的 cellAtOffset 換成「相對這一格的邏輯位移」——所以
// 「不同高度的建築不攔截地面格點擊」（建築、標籤沒有事件）與「相鄰格不因外接矩形重疊點錯」
// （角上的點會算到隔壁那一格）同時成立。
//
// 效能：361 格的底層（迷霧填色、全部格線）是**靜態幾何**，快取起來重複使用；
// 每次重繪只重建「已揭開」的少量格與真的有遠征的格子。
import { Background, PathBuilder, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { MAP_RADIUS, cellAtEvent, contentSize, keyOf, originInContent, projectTile } from "../core/grid.js";
import { GROUND_MOCK, PLOT_DIAMOND, buildingOf, buildingPolygons, factionStyle, groundOf, legendGroups } from "./assets.js";

const LOCAL = { left: 0, top: 0 };
/** 靜態底層快取：key 只有幾何（半徑與格大小），值是不可變的原生路徑。 */
let baseCache = { key: null, fog: null, outline: null };

const LOCAL_CELL = { x: 0, y: 0 };
/**
 * 地圖：內容區是 361 格的投影外框（`contentSize`）。`focus` 是要帶進畫面的那一格
 * （選取或歷程跳轉），由呼叫端設定一次、這裡消費一次。
 */
export function mapView({
  city, tiles, revealed, selection, theme: t, tile, legendOpen, camera,
  radius = MAP_RADIUS, onToggleLegend, onPick, onPan, onLegendSize,
}) {
  const size = contentSize(radius, tile);
  const origin = originInContent(radius, tile);
  const base = basePaths(radius, tile);
  const open = [];
  const occupied = [];
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      const entry = tiles.get(keyOf({ x, y }));
      if (entry) occupied.push(entry);
      else if (revealed.has(keyOf({ x, y }))) open.push({ x, y });
    }
  }
  // 地圖自己擁有平移（相機）：滾輪／觸控板的事件直接改相機，重繪時把整張圖平移。
  // 這比「原生捲動容器 + scroll_to_item」可靠：那個 API 對絕對定位的子元素沒有作用，
  // 而且容器自己的偏移與相機同時存在時，畫面會看起來完全沒有動。
  const children = [
    fullPath(base.fog, Background.pattern_slash(t.dim, 1, 4), size, camera),
    fullPath(stroked(open, tile, origin), t.background, size, camera),
    fullPath(base.outline, t.border, size, camera),
    centerCell(city, t, tile, origin, radius, onPick, camera),
    ...occupied.map((entry) => cell(entry, selection, t, tile, origin, radius, onPick, camera)),
  ];
  return div()
    .id("map")
    .size_full()
    .relative()
    .overflow_hidden()
    .bg(t.background)
    // 雙軸捲動：滾輪與觸控板的事件都在這裡收（delta 是裝置回報的像素）。
    .on_scroll_wheel((event, cx) => onPan(event.delta, cx))
    .child(div().id("map-view").relative().size_full().children(children))
    .child(legendPanel(t, legendOpen, onToggleLegend, onLegendSize));
}

/** 圖例（§14 的素材與狀態）：只解釋畫面看得到的 mock，不新增玩法。 */
function legendPanel(t, open, onToggle, onSize) {
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
    // 圖例不超過地圖視窗：窄 pane（600 UI px）不會被右緣裁掉。
    .max_w("100%")
    .gap(2)
    .p(6)
    .rounded(4)
    .bg(t.chrome)
    .border(1)
    .border_color(t.border)
    .cursor_pointer()
    .on_click((_event, cx) => onToggle(cx))
    // 圖例自己回報量到的大小：可見區的判定要用實際覆蓋層尺寸，不能用假設值。
    .on_size_change((size, cx) => onSize(size, cx))
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

/** 靜態底層：整片迷霧與整張格線只有幾何（半徑、格大小），所以只建一次。 */
function basePaths(radius, tile) {
  const key = `${radius}|${tile.w}|${tile.h}`;
  if (baseCache.key === key) return baseCache;
  const origin = originInContent(radius, tile);
  const all = [];
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) all.push({ x, y });
  }
  const fog = PathBuilder.fill();
  const outline = PathBuilder.stroke(1);
  for (const spot of all) {
    const points = diamondPoints(spot, tile, origin);
    fog.add_polygon(points).close();
    outline.add_polygon(points).close();
  }
  baseCache = { key, fog: fog.build(), outline: outline.build() };
  return baseCache;
}

/** 已揭開的格子（少數）：每次重繪重建一條路徑。 */
function stroked(cells, tile, origin, dash) {
  const builder = dash ? PathBuilder.stroke(1).dash_array(dash) : PathBuilder.stroke(1);
  for (const spot of cells) builder.add_polygon(diamondPoints(spot, tile, origin)).close();
  return builder.build();
}

/** 內容區大小的路徑（座標就是內容座標）。 */
function fullPath(path, color, size, camera) {
  return window.paint_path(path, color).absolute().left(camera.x).top(camera.y).w(size.width).h(size.height);
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

/**
 * 一格的方框（絕對定位在它的投影位置）＋它自己的點擊。
 * `cellAtOffset` 把方框內的點換成「相對這一格」的邏輯位移，所以角上的點會算給隔壁那一格。
 */
function cellBox(cell, tile, origin, radius, onPick, camera) {
  const spot = projectTile(cell, tile);
  return div()
    .id(`map-${cell.x}-${cell.y}`)
    .absolute()
    .left(camera.x + origin.left + spot.left)
    .top(camera.y + origin.top + spot.top)
    .w(tile.w)
    .h(tile.h)
    .on_mouse_down("left", (event, cx) => {
      const offset = cellAtEvent(event, tile);
      if (!offset) return;
      const x = cell.x + offset.dx;
      const y = cell.y + offset.dy;
      if (Math.abs(x) > radius || Math.abs(y) > radius) return;
      onPick({ x, y }, cx);
    });
}

function centerCell(city, t, tile, origin, radius, onPick, camera) {
  const points = localDiamond(tile);
  return cellBox(city.center, tile, origin, radius, onPick, camera).children([
    tilePath(fillPath(points), t.selected, tile),
    tilePath(PathBuilder.stroke(2.5).add_polygon(points).close().build(), t.accent, tile),
    markBox(city.center.label, t, tile, t.accent),
  ]);
}

function cell(entry, selection, t, tile, origin, radius, onPick, camera) {
  const selected = (selection?.kind === "expedition" && selection.rootSessionId === entry.rootSessionId) ||
    (selection?.kind === "tile" && selection.x === entry.x && selection.y === entry.y);
  const faction = factionStyle(entry.faction);
  const factionColor = t[faction.token] ?? t.muted;
  const ground = GROUND_MOCK[groundOf(entry)];
  const building = buildingOf(entry);
  const points = localDiamond(tile);
  const outline = entry.landStage === "reserved"
    ? stroked([LOCAL_CELL], tile, LOCAL, [4, 3])
    : selected
      ? PathBuilder.stroke(2.5).add_polygon(points).close().build()
      : stroked([LOCAL_CELL], tile, LOCAL);
  return cellBox(entry, tile, origin, radius, onPick, camera).children([
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
