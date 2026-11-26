// 共用城市的地圖（#25–#27）：固定地形、已揭開的土地、建設佇列、已完工的建築，
// 以及選址時的合法位置與整棟預覽。
//
// 固定格大小＋原生雙軸捲動；邏輯座標與投影分開（core/grid.js），命中一律回到地面菱形。
// 只有已揭開的格子收點擊（迷霧裡不能選址）；每一格自己收事件，命中同樣回到地面菱形。
//
// 佇列裡的每一項都畫出自己的占地：排隊中（還沒開工）是強調色虛線、地面仍是原本的地形；
// 施工中（同時只有一項）是工作色虛線＋工地（植被、碎石讓位）；完工是完成色實線＋建築。
// `legal` 是選好建築之後全部合法錨點；`preview` 是 `siteCheck` 的結果——預覽與下令共用
// 同一份判準，所以畫成綠色的整片占地就是下令會成功的那一片。
//
// 效能：整片底層（迷霧填色、全部格線）是**靜態幾何**，快取起來重複使用；已揭開的格子依
// 樣式聚成幾條路徑（core/map-style.js 決定每一格落哪一桶），每一幀不是一格一條路徑。
import { Background, PathBuilder, div } from "gpui-kit";

import { CENTER, CENTER_CELLS, MAP_RADIUS, cellAtEvent, contentSize, isCenterCell, keyOf, neighbors, originInContent, projectTile } from "../core/grid.js";
import { mapCells } from "../core/map-style.js";
import { buildingOf, buildingPolygons } from "./assets.js";

/** 靜態底層快取：key 只有幾何（半徑與格大小），值是不可變的原生路徑。 */
let baseCache = { key: null, fog: null, outline: null };

/** 樣式 → gpui 的背景。 */
const paintOf = (style, t) => (style.kind === "slash"
  ? Background.pattern_slash(t[style.token], style.width, style.gap)
  : Background.solid(t[style.token]).opacity(style.opacity));

export function sharedMapView({
  revealed, queue = [], buildings = [], legal = [], preview = null, selected = null, theme: t, tile, camera,
  terrainVersion, roadArmLength,
  radius = MAP_RADIUS, onPick, onPan, viewport = null,
}) {
  const origin = originInContent(radius, tile);
  const base = basePaths(radius, tile);
  const layout = mapCells({ revealed, queue, buildings, terrainVersion, roadArmLength, legal, preview, selected, radius });
  const spotOf = (cell) => projectTile(cell, tile);
  const marks = layout.marks.map((mark) => {
    if (mark.kind === "building") {
      return buildingMarkAt(buildingOf({ building: mark.recipe }), tile, t.done, mark.spot, origin, camera);
    }
    // 預覽：可以放是完成色、不能放是阻擋色。
    const color = t[mark.blocked ? "blocked" : "done"];
    const spot = spotOf(mark.spot);
    return div()
      .absolute()
      .left(camera.x + origin.left + spot.left)
      .top(camera.y + origin.top + spot.top)
      .w(tile.w)
      .h(tile.h)
      .children([
        tilePath(fillPath(localDiamond(tile)), Background.solid(color).opacity(0.42), tile),
        tilePath(PathBuilder.stroke(1.5).add_polygon(localDiamond(tile)).close().build(), color, tile),
      ]);
  });
  const click = layout.open.filter((spot) => !isCenterCell(spot)).map((spot) => cellBox(spot, tile, origin, radius, onPick, camera));
  // 預覽伸進迷霧的那一角：不揭開地形，只把「這一格不能放」畫出來（不建立點擊區）。
  const veil = [];
  for (const cell of layout.preview) {
    if (revealed.has(keyOf(cell))) continue;
    const spot = projectTile(cell, tile);
    veil.push(div()
      .absolute()
      .left(camera.x + origin.left + spot.left)
      .top(camera.y + origin.top + spot.top)
      .w(tile.w)
      .h(tile.h)
      .children([
        tilePath(fillPath(localDiamond(tile)), Background.solid(t.blocked).opacity(0.35), tile),
        tilePath(PathBuilder.stroke(1.5).add_polygon(localDiamond(tile)).close().build(), t.blocked, tile),
      ]));
  }
  const size = contentSize(radius, tile);
  const children = [
    fullPath(base.fog, Background.pattern_slash(t.dim, 1, 4), size, camera),
    // 已揭開的土地先蓋掉迷霧的斜線：揭開就是看得到地面，不是隔著霧看。
    fullPath(filled(layout.open, tile, origin), t.background, size, camera),
    ...layout.fills.map(({ cells, ...style }) => fullPath(filled(cells, tile, origin), paintOf(style, t), size, camera)),
    fullPath(base.outline, t.border, size, camera),
    ...layout.outlines.map(({ token, dash, cells }) => fullPath(stroked(cells, tile, origin, dash), t[token] ?? t.border, size, camera)),
    ...centerBlock(t, tile, origin, radius, onPick, camera),
    ...marks,
    ...click,
    ...veil,
  ];
  // 預定地／工地與完工建築的標籤掛在錨點那一格（沒有事件，不擋點擊）。
  const label = (anchor, text, color) => {
    const spot = projectTile(anchor, tile);
    return div()
      .absolute()
      .left(Math.max(0, Math.min(camera.x + origin.left + spot.left - tile.w / 2, (viewport?.width ?? size.width) - tile.w * 2)))
      .top(camera.y + origin.top + spot.top + Math.round(tile.h * 0.6))
      .w(tile.w * 2)
      .text_center()
      .text_size(labelSize(tile))
      .text_color(color)
      .child(text);
  };
  for (const building of buildings) children.push(label(building, building.label, t.done));
  for (const item of queue) {
    children.push(item.stage === "building"
      ? label(item, `施工·${item.label}`, t.working)
      : label(item, `預定·${item.label}`, t.accent));
  }
  return div()
    .id("map")
    .size_full()
    .relative()
    .overflow_hidden()
    .bg(t.background)
    .on_scroll_wheel((event, cx) => onPan(event.delta, cx))
    .child(div().id("map-view").relative().size_full().children(children));
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
  const fog = PathBuilder.fill();
  const outline = PathBuilder.stroke(1);
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      const points = diamondPoints({ x, y }, tile, origin);
      fog.add_polygon(points).close();
      outline.add_polygon(points).close();
    }
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

/** 一整片格子填成同一個顏色（已揭開的土地把迷霧的斜線蓋掉，露出來的是地面）。 */
function filled(cells, tile, origin) {
  const builder = PathBuilder.fill();
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

/** 一格自己的菱形（格子方框內的座標；方框由 cellBox 定位）。 */
function localDiamond(tile) {
  return [[tile.w / 2, 0], [tile.w, tile.h / 2], [tile.w / 2, tile.h], [0, tile.h / 2]];
}

function fillPath(points) {
  return PathBuilder.fill().add_polygon(points).close().build();
}

/**
 * mock 圖形（建築）的座標是格子方框的百分比（assets.js），但路徑吃的是像素：
 * 沒換算時 50 就是 50 px，圖形會比格子大、跑到菱形外面。
 */
function percentToBox(points, tile) {
  return points.map(([x, y]) => [(x * tile.w) / 100, (y * tile.h) / 100]);
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

/** 每格只描與中心以外的土地相接的邊；東西南北四個角各有兩條外框。 */
function centerBlock(t, tile, origin, radius, onPick, camera) {
  const points = localDiamond(tile);
  const cells = CENTER_CELLS.map((spot) => {
    const box = cellBox(spot, tile, origin, radius, onPick, camera)
      .child(tilePath(fillPath(points), t.selected, tile))
      .child(tilePath(PathBuilder.stroke(1).add_polygon(points).close().build(), t.muted, tile));
    neighbors(spot).forEach((neighbor, i) => {
      if (!isCenterCell(neighbor)) box.child(tilePath(
        PathBuilder.stroke(2.5).add_polygon([points[i], points[(i + 1) % 4]], false).build(), t.accent, tile,
      ));
    });
    return box;
  });
  const anchor = projectTile(CENTER, tile);
  const label = div()
    .absolute()
    .left(camera.x + origin.left + anchor.left)
    .top(camera.y + origin.top + anchor.top + (tile.h - labelSize(tile)) / 2)
    .w(tile.w)
    .text_center()
    .text_size(labelSize(tile) + 1)
    .font_semibold()
    .text_color(t.accent)
    .child("城鎮中心");
  return [...cells, label];
}

/** 建築 mock：牆＋屋頂（屋頂與牆用完成色）。沒有事件，所以不擋點擊。 */
function buildingMark(mock, tile, color) {
  if (!mock) return null;
  const { roof, body } = buildingPolygons(mock);
  const layers = [
    tilePath(fillPath(percentToBox(body, tile)), Background.solid(color).opacity(0.55), tile),
  ];
  if (mock.roof) {
    layers.push(tilePath(fillPath(percentToBox(roof, tile)), color, tile));
  } else {
    // 沒有屋頂的種類（哨站）：用上緣一條亮線表示。
    layers.push(tilePath(fillPath(percentToBox([[24, mock.eave], [76, mock.eave], [76, mock.top], [24, mock.top]], tile)), color, tile));
  }
  return div().absolute().left(0).top(0).w(tile.w).h(tile.h).children(layers);
}

/** 完工建築的 mark 定位在自己的格子上（內容座標）。 */
function buildingMarkAt(mock, tile, color, spot, origin, camera) {
  const projected = projectTile(spot, tile);
  return div()
    .absolute()
    .left(camera.x + origin.left + projected.left)
    .top(camera.y + origin.top + projected.top)
    .w(tile.w)
    .h(tile.h)
    .child(buildingMark(mock, tile, color));
}

/** 格子最小 56 px，所以標籤一定看得清楚（不再隨 pane 縮小而互相重疊）。 */
function labelSize(tile) {
  return Math.max(8, Math.min(10, Math.round(tile.w / 9)));
}
