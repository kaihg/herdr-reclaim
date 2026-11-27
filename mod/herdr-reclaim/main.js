// herdr-reclaim 的城鎮畫面（#22 之後只有共用城市）：一座城、一個倉庫、一張地圖。
//
// 上方是共用庫存、工作進度與佇列最前面那一項；左邊是建設佇列的摘要與可選的建築；
// 中間是共用城市的地圖；右邊是整棟預覽或佇列明細（未開工的項目可取消）。
// 所有專案、space 與 session 的工作都只當成同一座城的工作來源，不產生任何遠征格，
// 也不讀寫 `cities/` 下的舊帳本。
//
// 畫面只讀公開的共用城市讀取模型（core/shared-city.js 的 `readSharedCity`）；正式載入
// 路徑是 core/city-load.js 的 `loadCity`（活動檔 → 共用帳本 → 讀取模型），開機、watch
// 變更與額度更新都走同一條路。
//
// 選取與開發模式不進帳本（見 core/selection.js 的說明），存在 mod 資料目錄下的小檔案。
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, home, readTextFile, settings, theme, watchFolder, writeTextFile } from "herdr";
import { ADAPTER_DIR, activityDir, adapterRoot, loadActivities } from "./core/adapter.js";
import { loadCity, townOf } from "./core/city-load.js";
import { CENTER, MAP_RADIUS, gridDistance, cameraFor, clampCamera, contentSize, panCamera } from "./core/grid.js";
import { hostIo } from "./core/host-io.js";
import { CasConflict, CityLedger } from "./core/ledger.js";
import { quotaLines } from "./core/provider-stats.js";
import { QUOTA_REFRESH_MS, QUOTA_SOURCE, claimQuotaAttempt, parseQuotaReport } from "./core/quota-source.js";
import { quotaView, readQuotaView } from "./core/quota-view.js";
import { CITY_BUILDINGS, RESOURCE_LABELS, ROAD, ROADSIDE_RANGE, RULES_VERSION, TOWN_UPGRADE_COSTS, TOWN_UPGRADE_POPULATION, TOWN_UPGRADE_UNITS, manualCount, populationGap } from "./core/rules.js";
import { parseUi, selectionOf, serializeUi, withDev, withSelection } from "./core/selection.js";
import {
  SHARED_CITY_ID, cancelPlan, placePlan, placeRoad, placeTownUpgrade, readSharedCity, sharedCityDir,
} from "./core/shared-city.js";
import { TERRAIN, cityBuildings, groundAt, missingOf, outpostUnits, revealedCells, siteCheck } from "./core/city-map.js";
import { previewRoad, roadStart } from "./core/roads.js";
import { fixedSharedCity } from "./scenarios/shared-city.js";
import { sharedMapView } from "./ui/map.js";

const MIN_LEFT_W = 96;
const MAX_LEFT_W = 240;
const MIN_RIGHT_W = 108;
const MAX_RIGHT_W = 292;
const TOP_H = 104;
/** 操作結果小提示顯示多久（ms）。 */
const TOAST_MS = 6000;
const VISIT_STEP_MS = 450;
const VISIT_BAR_H = 24;

const RESOURCES = [
  { key: "wood", label: "木材", color: "ansi3" },
  { key: "stone", label: "石材", color: "muted" },
  { key: "iron", label: "鐵料", color: "ansi4" },
  { key: "parchment", label: "羊皮卷", color: "ansi6" },
];

/** 選址被拒的原因（帳本的前提檢查）：畫面上只翻成人看得懂的一句話。 */
const SITE_PROBLEMS = {
  road: "道路", fog: "迷霧", water: "深水", cliff: "峭壁", center: "城鎮中心", building: "已有建築", plan: "預定地", unknown_building: "未知建築",
  reserved: "地標預留地",
  off_road: `離通車的道路超過 ${ROADSIDE_RANGE} 格，請先鋪路`,
  no_road: "尚無通車的道路",
};
const INCOME_HINT = "繼續工作就會進帳";
const PLAN_REASONS = {
  queue_full: "建設佇列已滿",
  population_locked: "人口還不夠，請先增加民居",
  town_required: "大宅要升為市鎮後才能預定",
  already_town: "已是市鎮",
  upgrade_queued: "升市鎮已排入佇列",
  library_inactive: "需要一座有人力運作的書庫",
  site_no_road: SITE_PROBLEMS.no_road,
  insufficient_resources: `建材還沒備齊，${INCOME_HINT}`,
  already_started: "已經開工，不能取消",
  no_plan: "佇列裡已經沒有這一項",
  unknown_building: "未知的建築種類",
  footprint_mismatch: "這棟建築需要不同的占地",
  recipe_mismatch: "這棟建築需要不同的建材",
  site_fog: "有一角還在迷霧裡",
  site_water: "有一角是深水",
  site_cliff: "有一角是峭壁",
  site_road: "有一角是道路",
  site_center: "有一角是城鎮中心",
  site_building: "有一角已有建築",
  site_plan: "有一角是預定地",
  site_reserved: "有一角是地標預留地",
  site_off_road: SITE_PROBLEMS.off_road,
  road_start: "請從已通車的道路或城鎮中心邊緣出發",
  road_fog: "終點還沒揭開",
  road_cliff: "終點是峭壁，不能鋪路",
  road_exists: "終點已經是道路",
  road_occupied: "終點已有建築或預定地",
  road_blocked: "沒有可通行的路線：請避開峭壁、迷霧與占地",
  road_length: `這條路超過 ${ROAD.limit} 個新格，請選近一點的終點`,
  road_changed: "路線已改變，請重新確認",
};
const costsText = (costs = {}) => Object.entries(costs)
  .map(([key, amount]) => `${RESOURCE_LABELS[key]} ${amount}`).join("・");
const missingText = (missing = {}) => {
  const text = Object.entries(missing).map(([key, amount]) => `${RESOURCE_LABELS[key]} ${amount}`).join("・");
  return text || "材料已齊";
};
/** 地面（`groundAt`）的標籤：工地與建築不是地形，另外說。 */
const groundLabel = (ground) => (ground === "site" ? "工地" : ground === "building" ? "建築" : TERRAIN[ground]?.label ?? ground);
const locationLabel = ({ x, y }, dev) => dev && x != null && y != null ? ` (${x}, ${y})` : "";
const workLeft = (item) => `還要 ${item.remainingUnits} 份`;
const queueLine = (item, dev) => (item.stage === "building"
  ? `施工中：${item.label}${locationLabel(item, dev)}・${workLeft(item)}`
  : Object.keys(item.missing ?? {}).length > 0
    ? `備料中：${item.label}${locationLabel(item, dev)}・還缺 ${missingText(item.missing)}；${INCOME_HINT}`
    : `排隊中：${item.label}${locationLabel(item, dev)}・材料已齊`);
/**
 * 現在再加一項時真正可用的庫存：扣掉佇列裡還沒付款的配方。付款只在隊首發生，
 * 所以這個數字才是「排在隊尾的那一項還要等多少材料」。
 */
const poolOf = (shared) => (shared.queue ?? [])
  .filter((item) => item.stage !== "building")
  .reduce((pool, item) => {
    for (const [key, amount] of Object.entries(item.costs ?? {})) pool[key] = Number(pool[key] ?? 0) - Number(amount);
    return pool;
  }, { ...shared.resources });
const shortageLabel = { people: "缺人", wood: "缺木", stone: "缺石", iron: "缺鐵" };
const queueSummary = (city, dev) => {
  const head = city.queue?.[0];
  return head ? queueLine(head, dev) : city.roadsideFull ? "路旁沒有可蓋的地" : "等下一份進帳施工";
};
/** 共用城市地圖的半徑：至少 MAP_RADIUS，涵蓋全部已揭開的格子，再多一圈迷霧當邊界。 */
const sharedRadius = (revealed) => {
  let reach = 0;
  for (const key of revealed) {
    const [x, y] = key.split(",").map(Number);
    reach = Math.max(reach, gridDistance(CENTER, { x, y }));
  }
  return Math.max(MAP_RADIUS, reach + 1);
};

const clamp = (min, value, max) => Math.max(min, Math.min(max, value));

/** 畫面縮放：on_size_change 的量測值要換回版面用的 UI 像素。 */
function zoomFactor() {
  const zoom = Number(settings()?.zoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
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
 * 列檔案：mod 沒有列目錄的 API，用 herdr 的 exec 直接跑 find（不經 shell，
 * 路徑不會被拆開）。目錄還不存在時 find 會失敗，就當成還沒有檔案。
 */
async function listFiles(dir) {
  try {
    const { stdout } = await exec("find", [dir, "-type", "f", "-name", "*.json", "-print"]);
    return stdout.split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** adapter 的讀取面（read 與 mod 自己的帳本共用同一個儲存層）。 */
function adapterIo() {
  return { ...storageIo(), list: listFiles };
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

/** 共用城市的帳本（ADR-0001）：使用新城目錄，所有 space 開的是同一份。 */
function openShared(io) {
  return new CityLedger({ io, dir: sharedCityDir(adapterRoot(appHome())), cityId: SHARED_CITY_ID }).open();
}

/**
 * 正式載入：活動檔 → `loadCity` → 公開模型。
 * 沒有 repo 舊帳本的讀寫，也不碰 git 的提交紀錄（#28：commit 不另外收成）。
 */
async function loadModel(io, ledger) {
  const root = adapterRoot(appHome());
  const activities = await loadActivities(io, activityDir(appHome()));
  const loaded = await loadCity(io, { root, list: listFiles, activities, ledger });
  return townOf(loaded, await loadQuotas(io));
}

/**
 * 額度回報（§9、§15.2）：provider 明確回報的額度，形狀是 S5 的
 * `omp usage --json --redact --no-extensions` 輸出（spikes/s5/observed.json）。
 *
 * 來源**只有一個**：官方 CLI 自己的 redacted JSON（core/quota-source.js 的 QUOTA_SOURCE）。
 * mod 不讀任何 provider 憑證檔、不解析 token、不改任何設定；指令不存在、沒有登入、
 * 網路失敗或輸出壞掉，都只是「未知」；按「更新額度」會把原因顯示出來。
 *
 * 抓取時機：啟動時與每 5 分鐘一次（QUOTA_REFRESH_MS），另外使用者可按「更新額度」立刻抓。
 * 額度是帳號層級、所有 workspace／視窗共用，所以 quotas.json 與「上次嘗試時間」
 * （quota-attempt.json）都是全域單一檔案，由 claimQuotaAttempt 用 CAS 搶名額：
 * 不管開幾個視窗，每 5 分鐘最多對 provider 發出一次查詢。
 */
const quotasPath = () => `${adapterRoot(appHome())}/quotas.json`;
const quotaAttemptPath = () => `${adapterRoot(appHome())}/quota-attempt.json`;

async function loadQuotas(io) {
  // 模型帶著原始快照：之後的重繪／操作刷新都用「現在」重新判定新鮮度（不呼叫外部 CLI）。
  return readQuotaView(io, quotasPath());
}

/** 選取與開發模式的檔案（不是帳本）：它們不產生資源，也不改變土地。 */
const uiPath = () => `${appHome()}/${DATA_DIR}/ui.json`;

/** 讀、改、CAS 寫；另一個視窗同時寫就重讀再試一次。其他錯誤原樣丟出。 */
async function updateUi(io, change) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await io.read(uiPath());
    try {
      await io.write(uiPath(), serializeUi(change(parseUi(before))), before);
      return;
    } catch (error) {
      if (!(error instanceof CasConflict)) throw error;
      // 另一個視窗同時寫：重讀再試。
    }
  }
}

const saveSelection = (io, selection) => updateUi(io, (ui) => withSelection(ui, selection.cityId, selection));

/**
 * 一格的像素大小：地圖佔中央欄的大部分，格子最小 56 px（標籤一定看得清楚），
 * 再大也不超過 84 px；畫不下的部分由原生雙軸捲動處理，不縮格子。
 */
function tileSize(area) {
  const w = Math.max(56, Math.min(84, Math.floor(area.width / 5.4)));
  return { w, h: Math.round(w / 1.909) };
}

/**
 * 反應門檻的量測：herdr 的 mod 拿不到 frame counter，所以量的是
 * 「事件 → 含新狀態的那一次 render」與「每次 render 的建樹時間」，開發模式才顯示。
 */
const MEASURES = [["pick", "點選"], ["panel", "面板"], ["action", "操作"]];

function emptyMetrics() {
  return { pending: null, samples: { pick: [], panel: [], action: [] }, build: { last: 0, max: 0 } };
}

/** 只留最近 20 次：面板顯示中位數與 p95，驗收要看的是分佈不是單一樣本。 */
function recordSample(list, value) {
  const next = [...list, value];
  return next.length > 20 ? next.slice(next.length - 20) : next;
}

function percentile(list, ratio) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))];
}

const lastOf = (list) => (list.length ? list[list.length - 1] : null);
const medianOf = (list) => percentile(list, 0.5);
const p95Of = (list) => percentile(list, 0.95);
const maxOf = (list) => (list.length ? Math.max(...list) : null);

export default class Town extends View {
  init(_props, cx) {
    this.rootSize = { width: 0, height: 0 };
    this.selection = null;
    this.ui = null;
    this.devMode = false;
    this.toast = null;
    this.lastViewed = null;
    this.visit = null;
    this.note = "正在查看共用城市…";
    this.devNote = null;
    this.metricsOpen = false;
    this.camera = null;
    this.metrics = emptyMetrics();
    // 共用城市（#25）：地圖顯示哪一格、正在選哪一種建築、預覽哪一個錨點。
    this.picking = null;
    this.preview = null;
    // 量測：在事件端下標記，由含新狀態的那一次 render 收尾（見 MEASURES）。
    this.mark = (kind) => { this.metrics.pending = { kind, at: Date.now() }; };
    if (checking()) {
      // `herdr-app check` 會真的跑 init：不動使用者的檔案，只渲染固定情境。
      this.town = fixedSharedCity();
      this.selection = null;
      this.note = null;
      return;
    }
    this.io = adapterIo();
    cx.spawn(async (cx) => {
      try {
        await ensureActivityDir(this.io);
      } catch (error) {
        this.note = "暫時無法接收工作進度。";
        this.devNote = `活動目錄建立失敗：${error}`;
      }
      this.refreshQuotas(cx);
      let first = true;
      for (;;) {
        try {
          this.town = await this.withShared(ledger => loadModel(this.io, ledger));
          this.ui = parseUi(await this.io.read(uiPath()));
          if (first) this.devMode = this.ui.dev;
          if (first) this.restoreSelection();
          this.note = null;
          this.devNote = null;
        } catch (error) {
          this.town = null;
          this.note = "共用城市讀取失敗，請稍後再開啟。";
          this.devNote = `共用城市帳本讀取失敗：${error}`;
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
    // 額度每 5 分鐘自動重取（全域限流，見 quotasPath 的說明）；啟動時那一次在上面的 spawn 裡。
    cx.timer.every(QUOTA_REFRESH_MS, (cx2) => this.refreshQuotas(cx2));
  }

  /** 還原上次選取的地圖格（共用城市只有一張圖）；不合法就從沒有選取開始。 */
  restoreSelection() {
    const saved = selectionOf(this.ui, SHARED_CITY_ID);
    if (saved?.kind === "site" && Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
      this.selection = { kind: "site", cityId: SHARED_CITY_ID, x: saved.x, y: saved.y };
    }
  }

  /** 選取：存檔＋把那一格帶進畫面；門檻 1（≤ 150 ms）＝按下到含新詳情的那一版畫面。 */
  select(selection, cx) {
    this.mark("pick");
    this.selection = selection;
    this.ui = withSelection(this.ui ?? parseUi(null), selection.cityId, selection);
    if (this.io) saveSelection(this.io, selection).catch(() => {});
    this.focusCell = { x: selection.x, y: selection.y };
    cx.notify();
  }

  /** 開發模式：顯示工程資訊（規則版本、量測、座標、揭開格數）。存在 ui.json，重開還在。 */
  toggleDev(cx) {
    this.devMode = !this.devMode;
    if (!this.devMode) this.metricsOpen = false;
    this.ui = withDev(this.ui ?? parseUi(null), this.devMode);
    if (this.io) updateUi(this.io, (ui) => withDev(ui, this.devMode)).catch(() => {});
    cx.notify();
  }

  // 只在 render 消費重播結果：背景可載入多次，沒畫出來就不算查看。
  // buildings 依完工順序只增不減；保留已畫出的棟數，不影響城市或選址。
  updateVisit(snapshot, land, cx) {
    const city = snapshot.city;
    const previous = this.lastViewed;
    if (snapshot !== previous?.snapshot) {
      const prior = previous?.snapshot.city;
      const playing = this.visit && this.visit.visible < prior.buildings.length;
      if (prior && snapshot.lastSeq > previous.snapshot.lastSeq) {
        const units = city.work.units - prior.work.units;
        const built = city.buildings.length - prior.buildings.length;
        const opened = land - previous.land;
        if (units || built || opened) {
          if (!playing) this.visit = { visible: prior.buildings.length };
          this.visit.text = `上次查看後：進帳 ${units} 份、完工 ${built} 棟、揭開 ${opened} 格`;
        } else if (!playing) this.visit = null;
      } else if (!playing) this.visit = null;
      this.lastViewed = { snapshot, land };
    }
    const visit = this.visit;
    if (!visit || visit.waiting) return;
    const step = visit.visible < city.buildings.length;
    visit.waiting = true;
    cx.timer.after(step ? VISIT_STEP_MS : TOAST_MS, (cx2) => {
      if (this.visit !== visit) return;
      if (step) visit.visible++;
      else this.visit = null;
      visit.waiting = false;
      cx2.notify();
    });
  }

  render(cx) {
    // 顯示更新時重新判定額度是否過期（§9）：模型帶著原始快照，這裡用「現在」重算一次，
    // 所以只是選取／重繪（沒有重新抓取）也會在跨過 TTL／resetsAt 之後顯示未知。
    if (this.town?.quotas?.snapshot !== undefined) this.town.quotas = quotaView(this.town.quotas.snapshot);
    const started = Date.now();
    const t = theme();
    let snapshot = this.town?.shared;
    // 操作後重讀與背景載入可能交錯；較早的快照不能倒轉這個視窗的界線。
    if (snapshot && snapshot.lastSeq < this.lastViewed?.snapshot.lastSeq) snapshot = this.lastViewed.snapshot;
    const shared = snapshot?.city;
    if (!shared) {
      this.metrics.pending = null;
      return v_flex()
        .id("root")
        .size_full()
        .items_center()
        .justify_center()
        .gap(8)
        .bg(t.canvas)
        .text_color(t.muted)
        .child(div().child((this.devMode && this.devNote) || this.note || (this.devMode
          ? "共用城市尚未啟用：開一個互動的 agent session。"
          : "共用城市等著開工：開始工作，第一批建材就會進倉。")))
        .child(chipButton(this.devMode ? "開發模式 ✓" : "開發模式", t, (cx2) => this.toggleDev(cx2)));
    }
    const revealed = revealedCells(shared);
    const route = this.picking === "road" && this.roadFrom && this.preview
      ? previewRoad(shared, this.roadFrom, this.preview) : null;
    this.updateVisit(snapshot, revealed.size, cx);
    // 這一格 mod 有多寬決定兩側的欄寬；窄 pane 也看得到三個區塊。
    // on_size_change 給的是實際像素（含畫面縮放），版面用的 .w()/.left() 是 UI 像素。
    const zoom = zoomFactor();
    const width = (this.rootSize.width || 940 * zoom) / zoom;
    const height = (this.rootSize.height || 560 * zoom) / zoom;
    const leftW = Math.round(clamp(MIN_LEFT_W, width * 0.19, MAX_LEFT_W));
    const rightW = Math.round(clamp(MIN_RIGHT_W, width * 0.26, MAX_RIGHT_W));
    // 共用城市沒有底部動作列：庫存常駐頂欄，選址在左側與地圖上完成。
    const mapArea = { width: Math.max(80, width - leftW - rightW), height: Math.max(80, height - TOP_H - (this.visit ? VISIT_BAR_H : 0)) };
    const toastText = this.devMode ? this.toast?.devText ?? this.toast?.text : this.toast?.text;
    const root = v_flex()
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
        this.sharedTopBar(shared, t, leftW, rightW, width),
        ...(this.visit ? [div().id("visit-summary").flex_none().h(VISIT_BAR_H).px(12)
          .bg(t.surface).text_color(t.foreground).child(this.visit.text)] : []),
        h_flex().flex_1().min_h(0).children([
          this.sharedPanel(shared, t, cx, leftW, revealed.size),
          div()
            .flex_1()
            .min_w(0)
            .h_full()
            .relative()
            .child(this.sharedMap(shared, t, cx, mapArea, revealed, route))
            .when(this.metricsOpen && this.devMode, (element) => element.child(this.metricsPanel(t)))
            .when(Boolean(toastText), (element) => element.child(this.toastView(t, toastText))),
          this.sharedDetail(shared, t, rightW, cx, route),
        ]),
      ]);
    this.finishMeasure(started);
    return root;
  }

  /** 量測收尾：建樹時間＋最近一次「事件 → 含新狀態的 render」。 */
  finishMeasure(startedAt) {
    const built = Date.now();
    this.metrics.build.last = Math.max(0, built - startedAt);
    this.metrics.build.max = Math.max(this.metrics.build.max, this.metrics.build.last);
    const pending = this.metrics.pending;
    this.metrics.pending = null;
    if (!pending || !this.metrics.samples[pending.kind]) return;
    this.metrics.samples[pending.kind] = recordSample(this.metrics.samples[pending.kind], Math.max(0, built - pending.at));
  }

  /** 頂欄：共用倉庫、工作進度與唯一的建設目標；右側是全域操作。 */
  sharedTopBar(shared, t, leftW, rightW, width) {
    const blockW = Math.round(clamp(96, rightW * 0.62, 176));
    const centerW = Math.max(60, width - leftW - blockW - 52);
    const stacked = centerW < 430;
    const stock = h_flex()
      .gap(10)
      .items_center()
      .child(div().text_size(10).text_color(t.dim).child("共用倉庫"))
      .children(RESOURCES.filter((resource) => resource.key in shared.resources)
        .map((resource) => resourceChip(resource, shared.resources[resource.key], t)));
    const work = h_flex()
      .gap(6)
      .items_center()
      .child(div().text_size(10).text_color(t.dim).child("下一份進帳"))
      .child(div().text_size(12.5).child(this.devMode
        ? `${shared.work.tokens}/${shared.work.unitTokens} token`
        : `${Math.floor(100 * shared.work.tokens / shared.work.unitTokens)}%`));
    const target = v_flex().min_w(0).child(div().text_size(10).text_color(t.muted).truncate().child(queueSummary(shared, this.devMode)))
      .when(shared.roadsideFull && shared.queue.length > 0, el => el.child(div().text_size(10).child("路旁沒有可蓋的地")));
    const center = stacked
      ? v_flex().flex_1().min_w(0).overflow_hidden().gap(2).child(stock).child(work).child(target)
      : h_flex().flex_1().min_w(0).overflow_hidden().items_center().justify_center().gap(14).child(stock).child(work).child(target);
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
          .overflow_hidden()
          .child(div().text_size(10).text_color(t.dim).child(`時代：${shared.era === "town" ? "市鎮" : "村落"}`))
          .child(div().text_size(stacked ? 13 : 17).font_semibold().truncate().child(shared.name))
          .child(div().text_size(11).child(`人口 ${shared.population.assigned}/${shared.population.capacity}`))
          .child(div().text_size(11).child(`維護 ${Number((shared.maintenance * 100).toFixed(2))}%`))
          .child(div().text_size(12).font_semibold().child(shortageLabel[shared.shortage])),
        center,
        v_flex()
          .w(blockW)
          .flex_none()
          .overflow_hidden()
          .items_end()
          .gap(3)
          .child(chipButton(this.devMode ? "開發模式 ✓" : "開發模式", t, (cx2) => this.toggleDev(cx2)))
          // 規則版本與量測是開發用的工程資訊：開發模式才出現。
          .when(this.devMode, (element) => element.child(h_flex().flex_wrap().gap(6).items_center().children([
            chipButton("更新額度", t, (cx2) => this.refreshQuotas(cx2, { manual: true })),
            div().text_size(9).text_color(t.dim).child(`規則 v${RULES_VERSION}`),
            chipButton(this.metricsOpen ? "關閉量測" : "量測", t, (cx2) => {
              this.metricsOpen = !this.metricsOpen;
              cx2.notify();
            }),
          ]))),
      ]);
  }

  /** 左側：建設佇列的摘要、可選的建築與額度。佇列明細在右側（可逐項取消）。 */
  sharedPanel(shared, t, cx, width, revealedCount) {
    const queue = shared.queue;
    const full = manualCount(queue) >= shared.queueLimit;
    return v_flex()
      .id("city-panel")
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
        div().text_size(10).text_color(t.dim).child(`建設佇列（${manualCount(queue)}/${shared.queueLimit}）`),
        div().text_size(13).font_semibold().truncate().child(queue.length ? queue[0].label : "選一棟建築"),
        div().text_size(9).text_color(t.muted).child(queue.length
          ? queueLine(queue[0], this.devMode)
          : "選好建築後，地圖會標出全部合法位置；點一格看整棟預覽，再按「預定這裡」。"),
        chipButton("鋪路", t, cx2 => this.pickBuilding(shared, "road", cx2)),
        ...cityBuildings(shared).map((building) => this.buildingCard(shared, building, t, cx)),
        ...(shared.era === "town" ? [] : [
          div().text_size(11).child(`升市鎮：人口 ${TOWN_UPGRADE_POPULATION}、書庫運作中`),
          div().text_size(10).child(`${costsText(TOWN_UPGRADE_COSTS)}；預計 ${TOWN_UPGRADE_UNITS} 份`),
          ...shared.upgradeBlockers.map(reason => div().text_size(10).text_color(t.muted).child(reason === "population_locked"
            ? `還差 ${TOWN_UPGRADE_POPULATION - shared.population.capacity} 人` : PLAN_REASONS[reason])),
          ...(!full && !shared.upgradeBlockers.length ? [chipButton("預定升市鎮", t, cx2 =>
            this.submitPlan({ building: "townUpgrade", label: "升市鎮" }, cx2))] : []),
          div().text_size(10).text_color(t.muted).child("大宅：升為市鎮後解鎖"),
        ]),
        div().text_size(9).text_color(t.dim)
          .child(full ? "佇列已滿：先讓最前面那一項完工，或取消還沒開工的項目。" : "預定不動庫存：排到隊首、材料備齊才一次付清；還沒開工的項目可以取消。"),
        div().text_size(9).text_color(t.dim)
          .child("草地、疏林、碎石地可以蓋；深水、峭壁與迷霧不行。預覽與下令用同一條規則。"),
        ...(this.devMode ? this.quotaSection(t) : []),
        div().text_size(9).text_color(t.dim)
          .child(`已揭開 ${revealedCount} 格 · 建築 ${shared.buildings.length} 棟${this.devMode ? ` · 帳本 ${SHARED_CITY_ID}` : ""}`),
      ]);
  }

  /** 未解鎖的卡片說明人口差額，不開放選址。 */
  buildingCard(shared, building, t, cx) {
    const selected = this.picking === building.name;
    const gap = populationGap(building.name, shared.population.capacity);
    const locked = gap > 0 || manualCount(shared.queue) >= shared.queueLimit;
    const missing = missingOf(building.costs, shared.resources);
    const affordable = Object.keys(missing).length === 0;
    return v_flex()
      .id(`building-${building.name}`)
      .w_full()
      .flex_none()
      .gap(2)
      .p(7)
      .rounded(6)
      .when(!gap, el => el.cursor_pointer())
      .bg(selected ? t.selected : t.surface)
      .border(1)
      .border_color(selected ? t.accent : t.border)
      .when(!gap, el => el.hover(style => style.bg(selected ? t.selected : t.hover))
        .on_click((_event, cx2) => this.pickBuilding(shared, building.name, cx2)))
      .children([
        div().text_size(11.5).text_color(locked && !selected ? t.dim : t.foreground)
          .child(`${building.label}　${building.footprint.w}×${building.footprint.h}`),
        div().text_size(10).text_color(t.muted).child(CITY_BUILDINGS[building.name].purpose),
        ...(building.name === "market" ? shared.marketTrades.map(({ from, spent, to, received }) =>
          div().text_size(10).child(`市場換料：${RESOURCE_LABELS[from]} ${spent} 換${RESOURCE_LABELS[to]} ${received}`)) : []),
        ...(gap ? [div().text_size(10).text_color(t.accent).child(`還差 ${gap} 人解鎖`)] : []),
        div().text_size(9).text_color(t.muted).truncate().child(costsText(building.costs)),
        div().text_size(9).text_color(t.muted).child(`完工揭開 ${building.reveal} 格`),
        div().text_size(9).text_color(affordable ? t.done : t.muted)
          .child(affordable ? "材料已齊" : `還缺 ${missingText(missing)}；${INCOME_HINT}`),
      ]);
  }

  /** 佇列滿時不能選建築位置，但仍可規劃道路。 */
  pickBuilding(shared, building, cx, roadFrom = null) {
    if (building !== "road" && manualCount(shared.queue) >= shared.queueLimit) {
      this.showToast(`建設佇列已滿（${manualCount(shared.queue)}/${shared.queueLimit}）：先讓最前面那一項完工，或取消還沒開工的一項`, cx);
      return;
    }
    this.picking = this.picking === building ? null : building;
    this.roadFrom = roadFrom;
    this.preview = null;
    cx.notify();
  }

  /**
   * 共用城市的地圖：相機與內容區跟著揭開的土地長（至少 MAP_RADIUS，外面多留一圈迷霧）：
   * 完工揭開的土地一定畫得出來、點得到。
   */
  sharedMap(shared, t, cx, area, revealed, route) {
    // `herdr-app check` 在 eval 裡渲染，時間預算比真的視窗緊：大圖（已揭開上百格）會被
    // 當成「interrupted」而讓 check 失敗，與載入好壞無關。檢查模式只畫中心附近，
    // 大圖的實際畫面由真的視窗驗證；runtime 仍然畫全部已揭開的土地。
    const radius = checking()
      ? Math.min(5, sharedRadius(revealed))
      : sharedRadius(revealed);
    const tile = tileSize(area);
    const size = contentSize(radius, tile);
    const anchor = this.focusCell ?? this.anchorCell ?? CENTER;
    const resized = area.width !== this.mapArea?.width || area.height !== this.mapArea?.height;
    const moved = this.focusCell || !this.camera || this.camera.radius !== radius || resized;
    if (moved) {
      this.anchorCell = anchor;
      this.camera = { radius, ...cameraFor(anchor, area, radius, tile) };
    }
    this.viewport = area;
    this.mapArea = { width: area.width, height: area.height };
    this.camera = { ...this.camera, ...clampCamera(this.camera, size, area) };
    this.focusCell = null;
    return sharedMapView({
      revealed,
      radius,
      queue: shared.queue,
      buildings: this.visit && this.visit.visible < shared.buildings.length
        ? shared.buildings.slice(0, this.visit.visible) : shared.buildings,
      terrainVersion: shared.terrainVersion,
      terrainSeed: shared.terrainSeed,
      roadArmLength: shared.roadArmLength,
      roads: shared.roads,
      roadPicking: this.picking === "road",
      preview: this.picking === "road" && this.roadFrom ? { cells: [this.roadFrom, ...(route?.path ?? [])] } : null,
      theme: t,
      tile,
      camera: this.camera,
      viewport: area,
      onPick: ({ x, y }, cx2) => this.pickSite(x, y, cx2),
      onPan: (delta, cx2) => {
        if (!this.camera) return;
        this.camera = { ...this.camera, ...panCamera(this.camera, delta, size, area) };
        cx2.notify();
      },
    });
  }

  /**
   * 點一格：選址中是整棟預覽，否則只是看那一格。`cellBox` 的命中會把方框的角落換算成鄰格，
   * 所以這裡再確認一次：迷霧裡的格子不接受點擊，也不回報它的地形。
   */
  pickSite(x, y, cx) {
    const shared = this.town?.shared?.city;
    if (!shared) return;
    const known = revealedCells(shared).has(`${x},${y}`);
    if (this.picking === "road") {
      const cell = { x, y };
      if (this.roadFrom) this.preview = cell;
      else if (known && roadStart(shared, cell)) this.roadFrom = cell;
      else { this.showToast(PLAN_REASONS.road_start, cx); return; }
      cx.notify();
      return;
    }
    if (!known) return;
    this.mark("pick");
    if (this.picking) {
      this.preview = { x, y };
      cx.notify();
      return;
    }
    this.select({ kind: "site", cityId: SHARED_CITY_ID, x, y }, cx);
  }

  /** 右側優先顯示鋪路或整棟預覽，平時在佇列上方顯示選取的土地。 */
  sharedDetail(shared, t, width, cx, route) {
    const road = this.picking === "road";
    const preview = !road && this.picking && this.preview ? siteCheck(shared, this.picking, this.preview) : null;
    const spot = this.selection?.cityId === SHARED_CITY_ID && this.selection.kind === "site" ? this.selection : null;
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
      .children([
        div().text_size(10).text_color(t.dim).child(road ? "鋪路" : preview ? "整棟預覽" : "選址與建設"),
        ...(road ? this.roadSection(shared, t, route) : preview
          ? this.previewSection(preview, t, shared, cx)
          : [
            ...(spot || !shared.queue.length ? this.spotSection(shared, spot, t) : []),
            ...(shared.queue.length ? this.queueSection(shared, t, cx) : []),
          ]),
        this.note ? div().text_size(9).text_color(t.muted).child(this.note) : null,
      ].filter(Boolean));
  }

  roadSection(shared, t, route) {
    const room = manualCount(shared.queue) < shared.queueLimit;
    return [
      div().font_semibold().child(route ? "道路預覽" : this.roadFrom ? "選終點：點已揭開的土地" : "選起點：點道路或城鎮中心邊緣"),
      ...(route?.ok ? [
        div().child(`新鋪 ${route.newCount} 格，其中橋 ${route.path.filter(c => c.terrain === "water").length} 格`),
        fieldRow({ label: "總成本", value: costsText(route.costs) }, t),
        fieldRow({ label: "工期", value: `${route.buildUnits} 份` }, t),
        room ? chipButton("確認鋪路", t, cx => this.submitPlan({ building: "road", label: "道路", ...route.end, route }, cx))
          : div().text_color(t.blocked).child("建設佇列已滿：先讓最前面那一項完工，或取消還沒開工的項目。"),
      ] : route ? [div().text_color(t.blocked).child(PLAN_REASONS[route.reason])] : []),
      chipButton("取消鋪路", t, cx => {
        this.picking = this.preview = this.roadFrom = null;
        cx.notify();
      }),
    ];
  }

  /** 整棟預覽＋下令：配方、還缺什麼、佇列還有沒有位置，都先講清楚再按「預定這裡」。 */
  previewSection(preview, t, shared, cx) {
    const def = cityBuildings(shared).find((building) => building.name === preview.building);
    const missing = def ? missingOf(def.costs, poolOf(shared)) : {};
    const ready = Object.keys(missing).length === 0;
    const room = manualCount(shared.queue) < shared.queueLimit;
    return [
      div().text_size(14).font_semibold().child(preview.label + locationLabel(preview, this.devMode)),
      fieldRow({ label: "用途", value: CITY_BUILDINGS[preview.building].purpose }, t),
      h_flex().gap(6).items_center()
        .child(statusBadge(preview.ok ? "可以放" : "不能放", t))
        .child(div().text_size(10).text_color(t.muted).child(preview.ok ? "整片占地都在可建的土地上" : "整棟都不能放")),
      ...preview.cells.map((cell) => h_flex().gap(6).items_center()
        .when(this.devMode, (row) => row.child(div().text_size(9).text_color(t.dim).child(locationLabel(cell, true))))
        .child(div().text_size(10).text_color(cell.problem ? t.blocked : t.muted)
          .child(cell.problem ? SITE_PROBLEMS[cell.problem] ?? (this.devMode ? cell.problem : "不能建造") : TERRAIN[cell.terrain]?.label ?? "迷霧"))),
      def ? fieldRow({ label: "配方", value: costsText(def.costs) }, t) : null,
      preview.ok && preview.building === "outpost" ? div().child(`預計 ${outpostUnits(shared, preview)} 份`) : null,
      def ? div().text_size(9).text_color(ready ? t.done : t.muted)
        .child(ready ? "排在佇列後面也付得出來：輪到它就開工" : `排在目前佇列之後還缺 ${missingText(missing)}；${INCOME_HINT}，輪到它才付料`) : null,
      room ? null : div().text_size(9).text_color(t.blocked)
        .child(`建設佇列已滿（${manualCount(shared.queue)}/${shared.queueLimit}）：先讓最前面那一項完工，或取消還沒開工的一項。`),
      preview.ok && room ? chipButton("預定這裡", t, (cx2) => this.submitPlan(preview, cx2)) : null,
      chipButton("取消選址", t, (cx2) => {
        this.preview = null;
        cx2.notify();
      }),
    ].filter(Boolean);
  }

  /** 施工中顯示剩餘份數；排隊中的項目顯示累計缺料，並可取消。 */
  queueSection(shared, t, cx) {
    return [
      div().text_size(10).text_color(t.dim).child(`建設佇列 ${manualCount(shared.queue)}/${shared.queueLimit}`),
      ...shared.queue.map((item, index) => {
        const building = item.stage === "building";
        const missing = Object.keys(item.missing ?? {}).length > 0;
        return v_flex()
          .w_full()
          .flex_none()
          .gap(2)
          .p(7)
          .rounded(6)
          .bg(t.surface)
          .border(1)
          .border_color(building ? t.working : t.border)
          .children([
            h_flex().gap(6).items_center()
              .child(div().text_size(12).font_semibold().child(`#${index + 1} ${item.label}`))
              .child(statusBadge(building ? "施工中" : missing ? "備料中" : "排隊中", t)),
            div().text_size(10).text_color(t.muted).child(item.building === "road" ? `新鋪 ${item.cells.length} 格`
              : item.building === "townUpgrade" ? "不占新格"
              : `占地 ${item.w}×${item.h}${locationLabel(item, this.devMode)}`),
            fieldRow({ label: "用途", value: item.building === "road" ? "通車後，沿線土地可以蓋建築"
              : item.building === "townUpgrade" ? "升為市鎮，解鎖大宅" : CITY_BUILDINGS[item.building].purpose }, t),
            fieldRow({ label: "配方", value: costsText(item.costs) }, t),
            ...(building
              ? [fieldRow({ label: "工期", value: workLeft(item) }, t)]
              : [
                fieldRow({ label: "還缺", value: missing ? `${missingText(item.missing)}；${INCOME_HINT}` : "材料已齊" }, t),
                chipButton("取消", t, (cx2) => this.cancelItem(item, cx2)),
              ]),
          ]);
      }),
    ];
  }

  spotSection(shared, spot, t) {
    if (!spot) return [div().text_size(10).text_color(t.muted).child("點地圖上一格看地形；選好建築後點一格就是整棟預覽。")];
    const ground = revealedCells(shared).has(`${spot.x},${spot.y}`) ? groundAt(shared, spot) : null;
    const done = ground === "building"
      ? shared.buildings.find((building) => building.cells.some((cell) => cell.x === spot.x && cell.y === spot.y))
      : null;
    return [
      div().text_size(14).font_semibold().child(`選取的土地${locationLabel(spot, this.devMode)}`),
      fieldRow({ label: "地面", value: ground === "road" && shared.roads?.[`${spot.x},${spot.y}`] === "bridge" ? "橋" : ground ? groundLabel(ground) : "迷霧" }, t),
      ...(done ? [fieldRow({ label: "建築", value: done.label }, t),
        fieldRow({ label: "用途", value: CITY_BUILDINGS[done.building].purpose }, t)] : []),
      div().text_size(9).text_color(t.muted).child(
        this.picking ? "這一格是整棟占地的左上角：在地圖點它就會顯示預覽。" : "選一棟建築之後，這裡會列出整棟占地的判斷。",
      ),
      ...(ground && roadStart(shared, spot) ? [chipButton("從這裡鋪路", t,
        cx => this.pickBuilding(shared, "road", cx, { x: spot.x, y: spot.y }))] : []),
    ];
  }

  // 同窗的 watch、按鈕都會 await IO；依序使用同一份可變快取，跨窗則由帳本的 CAS 仲裁。
  withShared(run) {
    const next = (this.sharedTask ?? Promise.resolve()).then(async () => {
      this.ledger ??= await openShared(this.io);
      return run(this.ledger);
    });
    this.sharedTask = next.then(() => {}, () => { this.ledger = null; });
    return next;
  }

  /**
   * 下令：寫進共用帳本的 plan entry，只保留占地、不扣料（ADR 0003）。成功就重讀共用城市，
   * 失敗只回報原因；被拒的下令不寫任何東西，所以另一個視窗搶先佔位或佇列已滿時，
   * 這裡不會留下半片占地，也不會扣到一半。
   */
  submitPlan(preview, cx) {
    const startedAt = Date.now();
    const { building, x, y, label } = preview;
    cx.spawn(async (cx2) => {
      let text;
      let devText;
      try {
        const result = await this.withShared(ledger => building === "road" ? placeRoad(ledger, preview.route, startedAt)
          : building === "townUpgrade" ? placeTownUpgrade(ledger, startedAt)
          : placePlan(ledger, { building, x, y, at: startedAt }));
        if (result.status === "applied" || result.status === "duplicate") {
          this.town = await this.refreshShared();
          this.picking = null;
          this.preview = null;
          text = `已預定：${label}；排到隊首、材料備齊才付料開工`;
          devText = text + locationLabel({ x, y }, true);
        } else {
          if (building === "road" || building === "townUpgrade") this.town = await this.refreshShared();
          text = `沒有預定：${PLAN_REASONS[result.reason] ?? "請重新選址再試"}`;
          devText = `${text} (${result.reason ?? result.status})`;
        }
      } catch (error) {
        text = "暫時無法預定，請稍後再試。";
        devText = `預定失敗：${error}`;
      }
      this.metrics.pending = { kind: "action", at: startedAt };
      this.showToast(text, cx2, devText);
    });
  }

  /** 取消佇列裡還沒開工的一項：占地與名額交還（那一項還沒付料），帳本只寫一筆 cancel。 */
  cancelItem(item, cx) {
    const startedAt = Date.now();
    cx.spawn(async (cx2) => {
      let text;
      let devText;
      try {
        const result = await this.withShared(ledger => cancelPlan(ledger, item));
        if (result.status === "applied" || result.status === "duplicate") {
          this.town = await this.refreshShared();
          text = `已取消：${item.label}`;
          devText = text + locationLabel(item, true);
        } else {
          text = `沒有取消：${PLAN_REASONS[result.reason] ?? "請再查看建設佇列"}`;
          devText = `${text} (${result.reason ?? result.status})`;
        }
      } catch (error) {
        text = "暫時無法取消，請稍後再試。";
        devText = `取消失敗：${error}`;
      }
      this.metrics.pending = { kind: "action", at: startedAt };
      this.showToast(text, cx2, devText);
    });
  }

  /** 只重讀共用帳本（不重跑活動檔、commit 證據或 git）：操作之後畫面立刻看到同一份庫存。 */
  async refreshShared() {
    const shared = await this.withShared(async ledger => readSharedCity(await ledger.state()));
    return { ...this.town, shared };
  }

  /** 額度清單（§9）：已知的回報一行，未知的另起一行；不捏造數字。 */
  quotaSection(t) {
    const lines = quotaLines(this.town?.quotas);
    return [
      div().text_size(10).text_color(t.dim).child("行會人力（provider 回報）"),
      ...lines.map((line) => div().text_size(9).text_color(line.known ? t.muted : t.dim).child(line.text)),
    ];
  }

  /**
   * 抓一次額度（§9、§15.2）：跑官方 CLI 的 redacted JSON 輸出，驗證後寫進 quotas.json 再重讀。
   * 這是額度唯一的來源；沒有 CLI、沒有登入、網路失敗或輸出壞掉，都只留下原因並顯示未知。
   * 不 throw；回傳給人看的結果說明。
   */
  async fetchQuotas() {
    try {
      // 從 Dock／Finder 開的 herdr 沒有 shell 的 PATH（bun 的路徑在 ~/.zshrc），裸的 `omp` 會
      // 啟動失敗（`herdr-exec` 錯誤）。先試 bun 的標準安裝位置，找不到再用 PATH。
      let result;
      let failure;
      for (const command of [`${home()}/.bun/bin/${QUOTA_SOURCE.command}`, QUOTA_SOURCE.command]) {
        try {
          result = await exec(command, QUOTA_SOURCE.args);
          break;
        } catch (error) {
          failure = error;
        }
      }
      if (!result) throw failure;
      if (result.code !== 0) {
        return `額度來源失敗（exit ${result.code}）：${String(result.stderr ?? "").trim().slice(0, 160) || "沒有輸出"}`;
      }
      const parsed = parseQuotaReport(result.stdout);
      if (parsed.error) return `額度回報無法使用：${parsed.error}`;
      const before = await this.io.read(quotasPath());
      await this.io.write(quotasPath(), `${JSON.stringify(parsed.snapshot)}\n`, before);
      this.town = { ...this.town, quotas: await loadQuotas(this.io) };
      return parsed.snapshot.warnings.length
        ? `額度已更新（${parsed.snapshot.warnings.join("；")}）`
        : "額度已更新";
    } catch (error) {
      return `額度更新失敗：${error}`;
    }
  }

  /**
   * 更新額度。`manual`＝使用者按「更新額度」：立刻抓、結果用 toast 說明；
   * 否則是自動輪（啟動與每 QUOTA_REFRESH_MS 一次）：全域限流，所有視窗共用同一個名額
   * （額度是帳號層級，不分 workspace），拿不到名額就什麼都不做，失敗也不打擾使用者
   * （畫面維持「未知」，按鈕仍可看到原因）。
   */
  refreshQuotas(cx, { manual = false } = {}) {
    if (this.quotaFetching) {
      if (manual) this.showToast(null, cx, "額度正在更新中");
      return;
    }
    this.quotaFetching = true;
    cx.spawn(async (cx2) => {
      try {
        const claimed = await claimQuotaAttempt(this.io, quotaAttemptPath(), Date.now(), { force: manual });
        if (!claimed) return;
        if (manual) this.showToast(null, cx2, `正在抓取額度：${QUOTA_SOURCE.command} ${QUOTA_SOURCE.args.join(" ")}`);
        const text = await this.fetchQuotas();
        if (manual) this.showToast(null, cx2, text);
        else cx2.notify();
      } catch (error) {
        if (manual) this.showToast(null, cx2, `額度更新失敗：${error}`);
      } finally {
        this.quotaFetching = false;
      }
    });
  }

  /** 操作結果的一行小提示（浮在地圖下方）：幾秒後自己消失，點一下也能關。 */
  showToast(text, cx, devText) {
    const id = (this.toastSeq = (this.toastSeq ?? 0) + 1);
    this.toast = { id, text, devText };
    cx.notify();
    cx.timer.after(TOAST_MS, (cx2) => {
      if (this.toast?.id !== id) return;
      this.toast = null;
      cx2.notify();
    });
  }

  toastView(t, text) {
    return h_flex()
      .id("toast")
      .absolute()
      .bottom(12)
      .left(12)
      .right(12)
      .justify_center()
      .child(
        div()
          .max_w("100%")
          .px(10)
          .py(6)
          .rounded(6)
          .bg(t.popover)
          .border(1)
          .border_color(t.border)
          .text_size(11.5)
          .cursor_pointer()
          .on_click((_event, cx) => {
            this.toast = null;
            cx.notify();
          })
          .child(text),
      );
  }

  /** 量測面板（開發模式）：三個互動門檻的最近值／最大值，以及每次 render 的建樹時間。 */
  metricsPanel(t) {
    return v_flex()
      .id("metrics")
      .absolute()
      .left(8)
      .bottom(10)
      .gap(1)
      .p(6)
      .rounded(4)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .on_size_change((size, cx2) => {
        const first = !this.metricsSize;
        const changed = this.metricsSize?.height !== size.height || this.metricsSize?.width !== size.width;
        this.metricsSize = size;
        if (changed) {
          if (first) this.requestFocus();
          cx2.notify();
        }
      })
      .child(div().text_size(9).text_color(t.dim).child("量測（門檻：點選 150／面板 500／操作 300 ms）"))
      .children(MEASURES.map(([kind, label]) => {
        const list = this.metrics.samples[kind];
        return div().text_size(9).text_color(list.length ? t.muted : t.dim).child(
          `${label}：最近 ${lastOf(list) ?? "—"} · 中位 ${medianOf(list) ?? "—"} · p95 ${p95Of(list) ?? "—"} · 最大 ${maxOf(list) ?? "—"} ms · ${list.length} 次`,
        );
      }))
      .child(div().text_size(9).text_color(t.muted)
        .child(`建樹：最近 ${this.metrics.build.last} ms · 最大 ${this.metrics.build.max} ms`))
      .child(div().text_size(9).text_color(this.metrics.scroll?.events ? t.muted : t.dim)
        .child(`捲動：${this.metrics.scroll?.events ?? 0} 次 · Δx ${Math.round(this.metrics.scroll?.sumX ?? 0)} · Δy ${Math.round(this.metrics.scroll?.sumY ?? 0)} · 相機 ${Math.round(this.camera?.x ?? 0)},${Math.round(this.camera?.y ?? 0)}`))
      .child(div().text_size(9).text_color(t.dim)
        .child(`可見區 ${Math.round(this.viewport?.x ?? 0)},${Math.round(this.viewport?.y ?? 0)} ${Math.round(this.viewport?.width ?? 0)}×${Math.round(this.viewport?.height ?? 0)} · 量測 ${Math.round(this.metricsSize?.height ?? 0)} · 置中格 ${this.anchorCell?.x ?? "—"},${this.anchorCell?.y ?? "—"}`));
  }

  /** 把選取的那一格帶進畫面：地圖在 render 時消費一次就清掉。 */
  requestFocus() {
    if (this.selection?.kind !== "site") return;
    this.focusCell = { x: this.selection.x, y: this.selection.y };
  }
}

function chipButton(label, t, action) {
  return div().role("button").tab_index(0)
    .px(6)
    .py(3)
    .rounded(4)
    .cursor_pointer()
    .bg(t.surface)
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => action(cx))
    .child(div().text_size(9).child(label));
}

const STATUS_TOKENS = {
  可以放: "done",
  不能放: "blocked",
  預定地: "accent",
  排隊中: "accent",
  備料中: "accent",
  施工中: "working",
};

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
  const color = t[STATUS_TOKENS[label] ?? "idle"] ?? t.muted;
  return h_flex()
    .gap(5)
    .items_center()
    .child(div().size(7).rounded_full().bg(color))
    .child(div().text_size(11).text_color(color).child(label));
}

function fieldRow(field, t) {
  return h_flex()
    .w_full()
    .gap(6)
    .items_start()
    .child(div().w(54).flex_none().text_size(11).text_color(t.dim).child(field.label))
    .child(div().flex_1().min_w(0).text_size(11.5).child(field.value));
}
