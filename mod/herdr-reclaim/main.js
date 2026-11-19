// herdr-reclaim 的城鎮畫面：C 版「遠征指揮桌」（proposal §14.1）。
//
// 上方是城鎮庫存與主要行會，左邊是現役遠征，中間是 3/4 城市地圖，右邊是選取的遠征
// 或格子的詳情；點遠征或點地圖格都會換右邊那一欄。
//
// 畫面只讀公開的城鎮讀取模型（core/town.js）；邏輯座標、BFS 與投影都在 core/grid.js，
// 所以這一票不需要任何 HTML 或 throwaway 原型的程式碼。
//
// 兩側的寬度與格子大小都依這一格 mod 的實際大小算：mod 可以是一整頁，也可以是分割出來
// 的窄 pane，四個區塊都要在。
//
// 資料來源：這一票是固定事件情境（scenarios/first-expedition.js）；#5 之後改成讀
// adapter 寫的活動檔。畫面本身不需要跟著改。
import { Background, PathBuilder, View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings, theme } from "herdr";
import { MAP_RADIUS, keyOf, projectTile } from "./core/grid.js";
import { CLEAR_POINTS, readTown, selectionDetail } from "./core/town.js";
import { firstExpedition } from "./scenarios/first-expedition.js";

const MIN_LEFT_W = 96;
const MAX_LEFT_W = 240;
const MIN_RIGHT_W = 108;
const MAX_RIGHT_W = 292;
const TOP_H = 84;

const RESOURCES = [
  { key: "wood", label: "木材", color: "ansi3" },
  { key: "stone", label: "石材", color: "muted" },
  { key: "iron", label: "鐵料", color: "ansi4" },
  { key: "parchment", label: "羊皮卷", color: "ansi6" },
];

const clamp = (min, value, max) => Math.max(min, Math.min(max, value));

/** 畫面縮放：on_size_change 的量測值要換回版面用的 UI 像素。 */
function zoomFactor() {
  const zoom = Number(settings()?.zoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function shortId(sessionId) {
  return String(sessionId).slice(0, 8);
}

/**
 * 一格的地面：2:1 的菱形（等角 3/4）。邏輯範圍固定是 7×7 格，像素大小跟著地圖區域縮放，
 * 所以窄 pane 不會把最外圈裁掉。
 */
function tileSize(area) {
  const w = Math.max(34, Math.min(84, Math.floor(area.width / 7.4)));
  return { w, h: Math.round(w / 1.909) };
}


function diamondPaths(tile) {
  const points = [
    [tile.w / 2, 0],
    [tile.w, tile.h / 2],
    [tile.w / 2, tile.h],
    [0, tile.h / 2],
  ];
  return {
    fill: PathBuilder.fill().add_polygon(points).close().build(),
    edge: PathBuilder.stroke(1).add_polygon(points).close().build(),
    edgeSelected: PathBuilder.stroke(2).add_polygon(points).close().build(),
  };
}

export default class Town extends View {
  init() {
    this.town = readTown(firstExpedition);
    this.rootSize = { width: 0, height: 0 };
    const city = this.town.cities[0] ?? null;
    const first = city?.tiles[0] ?? null;
    // 預設選第一支遠征，指揮桌一打開右邊就有東西。
    this.selection = first ? { kind: "expedition", cityId: city.cityId, rootSessionId: first.rootSessionId } : null;
  }

  city() {
    const cities = this.town.cities;
    const wanted = this.selection?.cityId;
    return (wanted ? cities.find((city) => city.cityId === wanted) : cities[0]) ?? null;
  }

  select(selection, cx) {
    this.selection = selection;
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const city = this.city();
    if (!city) {
      return v_flex()
        .id("root")
        .size_full()
        .items_center()
        .justify_center()
        .bg(t.canvas)
        .text_color(t.muted)
        .child("還沒有任何城市：互動的 root session 進到一個 Git repo 之後就會出現。");
    }
    // 這一格 mod 有多寬決定兩側的欄寬；窄 pane 也看得到四個區塊。
    // on_size_change 給的是實際像素（含畫面縮放），版面用的 .w()/.left() 是 UI 像素。
    const zoom = zoomFactor();
    const width = (this.rootSize.width || 940 * zoom) / zoom;
    const height = (this.rootSize.height || 560 * zoom) / zoom;
    const leftW = Math.round(clamp(MIN_LEFT_W, width * 0.24, MAX_LEFT_W));
    const rightW = Math.round(clamp(MIN_RIGHT_W, width * 0.3, MAX_RIGHT_W));
    // 地圖就是列裡剩下的那一塊；用 root 的尺寸算，不另外量自己。
    const mapArea = { width: Math.max(80, width - leftW - rightW), height: Math.max(80, height - TOP_H) };
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.canvas)
      .text_size(12.5)
      .text_color(t.foreground)
      .on_size_change((size, cx2) => {
        if (size.width === this.rootSize.width && size.height === this.rootSize.height) return;
        this.rootSize = size;
        cx2.notify();
      })
      .children([
        this.topBar(city, t, leftW),
        h_flex().flex_1().min_h(0).children([
          this.expeditionList(city, t, cx, leftW),
          this.map(city, t, cx, mapArea),
          this.detailPanel(selectionDetail(this.town, this.selection), t, rightW),
        ]),
      ]);
  }

  // ---- 上方：城鎮庫存與主要行會（§9、§14.1）

  topBar(city, t, leftW) {
    return h_flex()
      .id("top")
      .flex_none()
      .h(TOP_H)
      .px(14)
      .gap(12)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .children([
        v_flex()
          .w(leftW)
          .flex_none()
          .child(div().text_size(10).text_color(t.dim).child("遠征指揮桌"))
          .child(div().text_size(17).font_semibold().truncate().child(city.name)),
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .justify_center()
          .gap(14)
          .child(div().text_size(10).text_color(t.dim).child("庫存"))
          .children(RESOURCES.map((resource) => resourceChip(resource, city.resources[resource.key], t))),
        v_flex()
          .w(120)
          .flex_none()
          .items_end()
          .child(div().text_size(10).text_color(t.dim).child("主要行會"))
          .child(div().text_size(12.5).child(city.guild ? city.guild.name : "未知")),
      ]);
  }

  // ---- 左側：現役遠征

  expeditionList(city, t, cx, width) {
    return v_flex()
      .id("expeditions")
      .w(width)
      .flex_none()
      .min_h(0)
      .gap(6)
      .p(10)
      .overflow_y_scrollbar()
      .bg(t.chrome)
      .border_r(1)
      .border_color(t.border)
      .children([
        div().text_size(10).text_color(t.dim).child("現役遠征"),
        div().text_size(13).font_semibold().child(`${city.tiles.length} 支隊伍`),
        ...city.tiles.map((tile) => this.expeditionCard(city, tile, t, cx)),
      ]);
  }

  expeditionCard(city, tile, t, cx) {
    const status = statusOf(tile, t);
    const selected = this.selection?.kind === "expedition" && this.selection.rootSessionId === tile.rootSessionId;
    return v_flex()
      .id(`expedition-${tile.rootSessionId}`)
      .w_full()
      .flex_none()
      .gap(3)
      .p(8)
      .rounded(6)
      .cursor_pointer()
      .bg(selected ? t.selected : t.surface)
      .border(1)
      .border_color(selected ? t.accent : t.border)
      .hover((style) => style.bg(selected ? t.selected : t.hover))
      .on_click((_event, cx2) =>
        this.select({ kind: "expedition", cityId: city.cityId, rootSessionId: tile.rootSessionId }, cx2),
      )
      .children([
        h_flex()
          .gap(5)
          .items_center()
          .child(div().size(7).rounded_full().bg(status.color))
          .child(div().text_size(11).text_color(status.color).child(status.label)),
        div().text_size(12.5).font_semibold().truncate().child(`遠征 ${shortId(tile.rootSessionId)}`),
        div().text_size(11).text_color(t.muted).truncate().child(`${tile.points} / ${CLEAR_POINTS} · ${tile.cli ?? "未知"}`),
      ]);
  }

  // ---- 中央：3/4 城市地圖

  map(city, t, cx, area) {
    const tile = tileSize(area);
    const paths = diamondPaths(tile);
    const tiles = new Map(city.tiles.map((entry) => [keyOf(entry), entry]));
    const cells = [];
    for (let x = -MAP_RADIUS; x <= MAP_RADIUS; x++) {
      for (let y = -MAP_RADIUS; y <= MAP_RADIUS; y++) cells.push(this.cell(city, tiles, x, y, t, cx, tile, paths, area));
    }
    return div()
      .id("map")
      .flex_1()
      .min_w(80)
      // 只有絕對定位的子元素撐不出高度，要靠 h_full 拿到列高。
      .h_full()
      .relative()
      .overflow_hidden()
      .bg(t.background)
      .child(div().absolute().left(8).top(5).text_size(10).text_color(t.dim).child("城市地圖"))
      .children(cells);
  }

  cell(city, tiles, x, y, t, cx, tile, paths, area) {
    const entry = tiles.get(keyOf({ x, y }));
    const isCenter = x === city.center.x && y === city.center.y;
    const selected =
      (this.selection?.kind === "tile" && this.selection.x === x && this.selection.y === y) ||
      (Boolean(entry) && this.selection?.kind === "expedition" && this.selection.rootSessionId === entry.rootSessionId);
    const spot = projectTile({ x, y }, tile);
    // 迷霧用斜線紋（各主題都看得出來），遠征格用底色與外框、選取再粗一圈。
    const fill = isCenter
      ? t.raised
      : entry
        ? selected
          ? t.selected
          : t.raised
        : Background.pattern_slash(t.dim, 1, 4);
    const edge = isCenter ? t.foreground : entry ? (selected ? t.accent : t.muted) : t.border;
    const stroke = isCenter ? paths.edgeSelected : selected ? paths.edgeSelected : paths.edge;
    const label = isCenter
      ? city.center.label
      : entry
        ? `${entry.status === "active" ? "●" : "○"} ${shortId(entry.rootSessionId)}`
        : null;

    return div()
      .id(`map-${x}-${y}`)
      .absolute()
      .left((area.width - tile.w) / 2 + spot.left)
      .top((area.height - tile.h) / 2 + spot.top)
      .w(tile.w)
      .h(tile.h)
      .cursor_pointer()
      .on_click((_event, cx2) => this.select({ kind: "tile", cityId: city.cityId, x, y }, cx2))
      .child(painted(paths.fill, fill, tile))
      .child(painted(stroke, edge, tile))
      .when(Boolean(label), (element) =>
        element.child(
          div()
            .absolute()
            .left(0)
            .top(Math.round(tile.h * 0.3))
            .w_full()
            .text_center()
            .text_size(Math.max(7.5, Math.min(9.5, tile.w / 9)))
            .text_color(entry ? (selected ? t.foreground : t.muted) : t.foreground)
            .child(label),
        ),
      );
  }

  // ---- 右側：選取遠征或格子的詳情（§12 的入口）

  detailPanel(detail, t, width) {
    return v_flex()
      .id("detail")
      .w(width)
      .flex_none()
      .min_h(0)
      .gap(9)
      .p(10)
      .overflow_y_scrollbar()
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .children(
        [
          div().text_size(10).text_color(t.dim).child("遠征詳情"),
          div().text_size(14).font_semibold().child(detail.title),
          detail.statusLabel ? statusBadge(detail.statusLabel, t) : null,
          detail.pointsTarget ? progress(detail, t) : null,
          ...detail.fields.map((field) => fieldRow(field, t)),
        ].filter(Boolean),
      );
  }
}

function painted(path, color, tile) {
  return window.paint_path(path, color).absolute().left(0).top(0).w(tile.w).h(tile.h);
}

function statusOf(tile, t) {
  return tile.status === "active"
    ? { label: "探索中", color: t.working }
    : { label: "駐紮", color: t.idle };
}

function resourceChip(resource, value, t) {
  const color = typeof t[resource.color] === "string" ? t[resource.color] : t.muted;
  return h_flex()
    .gap(5)
    .items_center()
    .child(div().size(9).rounded(2).bg(color))
    .child(
      v_flex()
        .child(div().text_size(12.5).font_semibold().child(String(value)))
        .child(div().text_size(10).text_color(t.dim).child(resource.label)),
    );
}

function statusBadge(label, t) {
  const color = label === "探索中" ? t.working : t.idle;
  return h_flex()
    .gap(5)
    .items_center()
    .child(div().size(7).rounded_full().bg(color))
    .child(div().text_size(11).text_color(color).child(label));
}

function progress(detail, t) {
  const ratio = Math.max(0, Math.min(1, detail.points / detail.pointsTarget));
  return v_flex()
    .gap(4)
    .child(
      h_flex()
        .justify_between()
        .text_size(11)
        .child(div().text_color(t.muted).child("開墾點"))
        .child(div().child(`${detail.points} / ${detail.pointsTarget}`)),
    )
    .child(
      div()
        .relative()
        .w_full()
        .h(6)
        .rounded(3)
        .bg(t.raised)
        .child(div().absolute().left(0).top(0).h_full().rounded(3).w(`${Math.round(ratio * 100)}%`).bg(t.accent)),
    );
}

function fieldRow(field, t) {
  return h_flex()
    .w_full()
    .gap(6)
    .items_start()
    .child(div().w(54).flex_none().text_size(11).text_color(t.dim).child(field.label))
    .child(div().flex_1().min_w(0).text_size(11.5).child(field.value));
}
