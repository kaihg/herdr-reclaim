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
// 資料來源（ticket #3）：開啟時把活動紀錄寫進城帳本（core/ledger.js，journal 是唯一完成
// 依據），再從帳本重建城鎮；關掉再開就得到同一座城。這一票的活動來源是固定事件情境
// （scenarios/first-expedition.js），#5 之後改成讀 adapter 寫的活動檔，畫面不需要跟著改。
//
// 選取狀態不進城的帳本（見 core/selection.js 的說明），存在 mod 資料目錄下的小檔案。
import { Background, PathBuilder, View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, readTextFile, settings, theme, watchFolder, writeTextFile } from "herdr";
import { ADAPTER_DIR, activityDir, adapterRoot, citiesOf, loadActivities, repoFactsOf } from "./core/adapter.js";
import { loadCommitEvidence, parseRawDiff, ingestCommits } from "./core/commit-evidence.js";
import { MAP_RADIUS, keyOf, projectTile } from "./core/grid.js";
import { ingestScenario } from "./core/ingest.js";
import { hostIo } from "./core/host-io.js";
import { CasConflict, CityLedger, cityDir } from "./core/ledger.js";
import { installHooks, removeHooks } from "./core/hooks.js";
import { defaultSelection, parseUi, resolveSelection, selectionOf, serializeUi, withSelection } from "./core/selection.js";
import { CLEAR_POINTS, readTown, readTownFromLedger, selectionDetail } from "./core/town.js";
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

/** mod 的資料目錄（在 herdr 的 appHome 底下）；adapter 也寫在同一個根目錄（§6.1）。 */
const DATA_DIR = ADAPTER_DIR;

/**
 * mod 端的儲存層：herdr 的 readTextFile 與 writeTextFile，經過 host 適配層，
 * 讓原生 host 的 CAS 衝突（原生 Error）在帳本眼裡也是 CasConflict（core/host-io.js）。
 */
function storageIo() {
  return hostIo({ readTextFile, writeTextFile });
}

/**
 * 列活動檔：mod 沒有列目錄的 API，用 herdr 的 exec 直接跑 find（不經 shell，
 * 路徑不會被拆開）。目錄還不存在時 find 會失敗，就當成還沒有活動。
 */
async function listActivityFiles(dir) {
  try {
    const { stdout } = await exec("find", [dir, "-type", "f", "-name", "*.json", "-print"]);
    return stdout.split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** compact 後活動檔可能只剩尾巴；從已存在的 head 找回沒有出現在尾巴裡的舊城。 */
async function cityIdsFromLedgers(io) {
  const root = `${adapterRoot(appHome())}/cities`;
  let stdout = "";
  try {
    ({ stdout } = await exec("find", [root, "-type", "f", "-name", "head.json", "-print"]));
  } catch {
    return [];
  }
  const ids = new Set();
  for (const file of stdout.split("\n").filter(Boolean)) {
    const text = await io.read(file);
    if (text === null) continue;
    const head = JSON.parse(text);
    if (typeof head.cityId === "string") ids.add(head.cityId);
  }
  return [...ids];
}

/** adapter 的讀取面（read 與 mod 自己的帳本共用同一個儲存層）。 */
function adapterIo() {
  return { ...storageIo(), list: listActivityFiles };
}

/**
 * 讓活動目錄存在（watchFolder 需要）：adapter 還沒跑過時也看得到它之後寫的檔案。
 * 已經在了就不是錯（CAS 建立既有檔案）。
 */
async function ensureActivityDir(io) {
  const file = `${activityDir(appHome())}/.keep`;
  try {
    if ((await io.read(file)) === null) await io.write(file, "herdr-reclaim\n", null);
  } catch (error) {
    if (!(error instanceof CasConflict)) throw error;
  }
}

/**
 * 活動檔 → 城帳本 → 城鎮；開機時也讓帳本檢查是否需要分頁 checkpoint（#4）。
 * 活動按 visit 的 commonDir 分城寫入，帳本 journal 是唯一完成依據（§13）。
 */

async function loadTown(io) {
  const activities = await loadActivities(io, activityDir(appHome()));
  const cityIds = [...new Set([...citiesOf(activities), ...(await cityIdsFromLedgers(io))])].sort();
  const repoFacts = await repoFactsOf(io, cityIds);
  const replay = { activities, repoFacts };
  const evidence = await loadCommitEvidence(io, adapterRoot(appHome()), listActivityFiles);
  const stored = [];
  const expeditions = [];
  const resources = {};
  for (const cityId of cityIds) {
    const ledger = await new CityLedger({ io, dir: cityDir(adapterRoot(appHome()), cityId), cityId }).open();
    await ingestScenario(ledger, replay, cityId);
    await ledger.maybeCheckpoint();
    const before = await ledger.state();
    await ingestCommits({
      ledger,
      ...evidence,
      activities: [...before.activities.values()],
      diffForCommit: async (sha, hook) => {
        if (!hook?.toplevel) return [];
        let result = await exec("git", ["-C", hook.toplevel, "diff-tree", "-r", "-M", "--raw", "-z", `${sha}^1`, sha]);
        if (result.code !== 0) result = await exec("git", ["-C", hook.toplevel, "diff-tree", "--root", "-r", "-M", "--raw", "-z", sha]);
        return result.code === 0 ? parseRawDiff(result.stdout) : [];
      },
    });
    const state = await ledger.state();
    resources[cityId] = state.resources;
    stored.push(...state.activities.values());
    expeditions.push(...state.tiles);
  }
  return readTownFromLedger({ activities: stored, expeditions, repoFacts, resources });
}

/** 選取狀態的檔案（不是城的帳本）：選取不產生資源，也不改變土地。 */
const uiPath = () => `${appHome()}/${DATA_DIR}/ui.json`;

/** 讀回上一次的選取；沒有記過就回預設。 */
async function loadSelection(io, town) {
  const cityId = town.cities[0]?.cityId ?? null;
  const saved = cityId ? selectionOf(parseUi(await io.read(uiPath())), cityId) : null;
  return { selection: resolveSelection(town, saved), saved: Boolean(saved) };
}

/** 讀、改、CAS 寫；另一個視窗同時寫就重讀再試一次。其他錯誤原樣丟出。 */
async function saveSelection(io, selection) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await io.read(uiPath());
    try {
      await io.write(uiPath(), serializeUi(withSelection(parseUi(before), selection.cityId, selection)), before);
      return;
    } catch (error) {
      if (!(error instanceof CasConflict)) throw error;
      // 另一個視窗同時寫：重讀再試。
    }
  }
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
  init(_props, cx) {
    this.rootSize = { width: 0, height: 0 };
    this.selection = null;
    this.note = "正在讀取城鎮帳本…";
    this.hookNotice = null;
    // `herdr-app check` 會真的跑 init：不要動使用者的檔案，只渲染固定情境。
    if (checking()) {
      this.town = readTown(firstExpedition);
      this.selection = defaultSelection(this.town);
      this.note = null;
      return;
    }
    this.io = adapterIo();
    cx.spawn(async (cx) => {
      try {
        await ensureActivityDir(this.io);
      } catch (error) {
        this.note = `活動目錄建立失敗：${error}`;
      }
      let first = true;
      for (;;) {
        try {
          this.town = await loadTown(this.io);
          const loaded = await loadSelection(this.io, this.town);
          this.selection = loaded.selection;
          // 第一次開這座城：把當下顯示的選取記下來，重開後回到同一個位置。
          if (first && !loaded.saved && this.selection) await saveSelection(this.io, this.selection);
          this.note = null;
        } catch (error) {
          this.town = null;
          this.note = `城鎮帳本讀取失敗：${error}`;
        }
        cx.notify();
        first = false;
        try {
          await watchFolder(adapterRoot(appHome()));
        } catch {
          return; // host 不支援這條 watch 時保留最後一次重播結果
        }
      }
    });
  }

  city() {
    const cities = this.town?.cities ?? [];
    const wanted = this.selection?.cityId;
    return (wanted ? cities.find((city) => city.cityId === wanted) : cities[0]) ?? null;
  }

  select(selection, cx) {
    this.selection = selection;
    if (this.io) saveSelection(this.io, selection).catch(() => {});
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
        .child(this.note ?? "還沒有任何城市：互動的 root session 進到一個 Git repo 之後就會出現。");
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

  manageHooks(city, remove, cx) {
    const repo = city.tiles.find((tile) => tile.repo?.checkout)?.repo.checkout;
    if (!repo) {
      this.hookNotice = "沒有可用的 checkout";
      cx.notify();
      return;
    }
    cx.spawn(async (cx2) => {
      try {
        const result = remove
          ? await removeHooks({ repo, exec })
          : await installHooks({ repo, exec, io: storageIo(), appHome: appHome() });
        this.hookNotice = result.status === "needs-confirmation"
          ? `需先確認：${result.reason}`
          : result.status === "installed" ? "收成 hook 已安裝"
          : result.status === "removed" ? "收成 hook 已移除"
          : result.status === "not-installed" ? "目前沒有已安裝的 hook"
          : `操作未完成：${result.reason ?? result.status}`;
      } catch (error) {
        this.hookNotice = `hook 操作失敗：${error}`;
      }
      cx2.notify();
    });
  }
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
          .w(176)
          .flex_none()
          .items_end()
          .gap(4)
          .child(div().text_size(10).text_color(t.dim).child("主要行會"))
          .child(div().text_size(12.5).child(city.guild ? city.guild.name : "未知"))
          .child(h_flex().gap(5).children([
            hookButton("安裝收成", t, (cx2) => this.manageHooks(city, false, cx2)),
            hookButton("移除", t, (cx2) => this.manageHooks(city, true, cx2)),
          ]))
          .child(this.hookNotice ? div().text_size(9).text_color(t.muted).truncate().child(this.hookNotice) : div()),
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

function hookButton(label, t, action) {
  return div()
    .px(6)
    .py(3)
    .rounded(4)
    .cursor_pointer()
    .bg(t.surface)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => action(cx))
    .child(div().text_size(9).child(label));
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
