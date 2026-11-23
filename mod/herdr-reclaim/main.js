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
import { View, div } from "gpui-kit";
import { InputState, h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, home, panes, props, readTextFile, settings, spaces, theme, watchFolder, writeTextFile } from "herdr";
import { ADAPTER_DIR, activityDir, adapterRoot, citiesOf, loadActivities, repoFactsOf, sessionNamesOf } from "./core/adapter.js";
import { commitContexts, ingestCommits, loadCommitEvidence, parseRawDiff, parseReflogEvidence, unharvestedCommitReasons } from "./core/commit-evidence.js";
import { MAP_RADIUS, cameraFor, clampCamera, contentSize, ensureVisible, isCenterCell, keyOf, panCamera, revealedKeys, visibleRect } from "./core/grid.js";
import { ingestResearch, ingestScenario, processBoost, processBuild, processLand, processTrade, redispatch } from "./core/ingest.js";
import { hostIo } from "./core/host-io.js";
import { CasConflict, CityLedger, cityDir } from "./core/ledger.js";
import { hooksStatus, installHooks, removeHooks } from "./core/hooks.js";
import { RESEARCH_TOKENS_PER_PARCHMENT, RESOURCE_LABELS, RULES_VERSION } from "./core/rules.js";
import { defaultSelection, parseUi, resolveSelection, selectionOf, serializeUi, withDev, withHookChoice, withSelection } from "./core/selection.js";
import { QUOTA_SOURCE, parseQuotaReport } from "./core/quota-source.js";
import { quotaView, readQuotaView } from "./core/quota-view.js";
import { CLEAR_POINTS, emptyCity, formatResearch, readTown, readTownFromLedger, selectionDetail, tileLabel } from "./core/town.js";
import { cityForFolders } from "./core/space-city.js";
import { firstExpedition } from "./scenarios/first-expedition.js";
import {
  historyChanged, historyJumped, historyLoadFailed, historyLoaded, historyOpened, historySubmitted,
  isSubmitKeystroke,
} from "./core/history-search.js";
import { historyPanel } from "./ui/history.js";
import { mapView } from "./ui/map.js";
import { stageCounts, stageOf } from "./ui/assets.js";
import { factionTag, guildBlock, investmentSection, quotaSection } from "./ui/standing.js";

const MIN_LEFT_W = 96;
const MAX_LEFT_W = 240;
const MIN_RIGHT_W = 108;
const MAX_RIGHT_W = 292;
const TOP_H = 104;
/** 選取入畫時，格子方框再加這個安全邊（mock 地物與標籤的視覺外框）。 */
const CELL_MARGIN = 6;
/** 操作結果小提示顯示多久（ms）。 */
const TOAST_MS = 6000;

/** 自動收成要先請使用者確認的原因（白話）。 */
const HOOK_CONFIRM_LABELS = {
  husky: "這個 repo 的 hook 由 husky 管理，自動開啟可能改到版控內的檔案，所以沒有動。",
  "tracked-hooks": "這個 repo 的 hook 目錄已納入版本控制，自動開啟會弄髒工作樹，所以沒有動。",
  "backup-exists": "hook 目錄裡已有 *.herdr-reclaim-original 備份檔，為免蓋掉你的 hook，所以沒有動。請先確認那些檔案。",
};

const RESOURCES = [
  { key: "wood", label: "木材", color: "ansi3" },
  { key: "stone", label: "石材", color: "muted" },
  { key: "iron", label: "鐵料", color: "ansi4" },
  { key: "parchment", label: "羊皮卷", color: "ansi6" },
];
const COMMIT_REASON_LABELS = {
  "remote-merge": "GitHub 遠端合併",
  "terminal-only": "只有 terminal ID",
  "no-session-source": "沒有 session 證據",
  "ambiguous-session-source": "session 證據不唯一",
  "ambiguous-repository": "repo 證據不唯一",
  "no-hook-repository-evidence": "沒有 repo 證據",
  "no-matching-expedition": "沒有匹配遠征",
  "no-matching-adapter-session": "對不到 adapter session",
  "no-eligible-changes": "沒有可收成變更",
};

/** 操作失敗時的一行訊息（§7.6 的三種操作）。 */
const ECONOMY_LABELS = { boost: "加速", build: "蓋房", trade: "市集" };

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

async function retryUnresolvedActivities(activities) {
  return Promise.all((activities ?? []).map(async (record) => {
    const events = await Promise.all((record.events ?? []).map(async (event) => {
      if (event.kind !== "visit_start" || !event.visit?.cwd || event.visit.commonDir) return event;
      const [commonDir, checkout] = await Promise.all([
        exec("git", ["-C", event.visit.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
        exec("git", ["-C", event.visit.cwd, "rev-parse", "--show-toplevel"]),
      ]);
      if (commonDir.code !== 0 || checkout.code !== 0) return event;
      return { ...event, visit: { ...event.visit, commonDir: commonDir.stdout.trim(), checkout: checkout.stdout.trim() } };
    }));
    return { ...record, events };
  }));
}

async function loadTown(io) {
  const rawActivities = await loadActivities(io, activityDir(appHome()));
  const activities = await retryUnresolvedActivities(rawActivities);
  const unresolvedCandidates = activities.flatMap((record) => (record.events ?? [])
    .filter((event) => event.kind === "visit_start" && event.visit?.cwd && !event.visit.commonDir)
    .map((event) => ({
      sessionId: record.sessionId,
      writerEpoch: record.writerEpoch,
      eventSeq: event.eventSeq,
      cli: record.cli ?? "未知",
      cwd: event.visit.cwd,
      at: event.at,
      status: "unresolved",
    })));
  const cityIds = [...new Set([...citiesOf(activities), ...(await cityIdsFromLedgers(io))])].sort();
  const repoFacts = await repoFactsOf(io, cityIds);
  const replay = { activities, repoFacts };
  const evidence = await loadCommitEvidence(io, adapterRoot(appHome()), listActivityFiles);
  const remoteMerges = new Map(cityIds.map((cityId) => [cityId, new Set()]));
  for (const cityId of cityIds) {
    const checkouts = new Set(activities.flatMap((record) => (record.events ?? [])
      .filter((event) => event.visit?.commonDir === cityId && event.visit.checkout)
      .map((event) => event.visit.checkout)));
    for (const checkout of checkouts) {
      // %ct＝提交時間（秒）：沒有 hook env 的城仍要有一個真實事件時間，不能用讀取當下。
      const reflog = await exec("git", ["-C", checkout, "reflog", "-n", "64", "--format=%H%x09%ct%x09%gs"]);
      if (reflog.code !== 0) continue;
      const parsed = parseReflogEvidence(reflog.stdout, cityId, checkout);
      for (const sha of parsed.remoteMerges) remoteMerges.get(cityId).add(sha);
      for (const record of parsed.records) {
        if (!evidence.hooks.some((existing) => existing.sha === record.sha && existing.commonDir === cityId && existing.hook === "reflog")) {
          evidence.hooks.push(record);
        }
      }
    }
  }
  const stored = [];
  const expeditions = [];
  const unharvested = {};
  const resources = {};
  const research = {};
  const market = {};
  for (const cityId of cityIds) {
    const ledger = await new CityLedger({ io, dir: cityDir(adapterRoot(appHome()), cityId), cityId }).open();
    await ingestScenario(ledger, replay, cityId);
    await ledger.maybeCheckpoint();
    const before = await ledger.state();
    await ingestCommits({
      ledger,
      ...evidence,
      activities: [...before.activities.values()],
      remoteMerges: remoteMerges.get(cityId),
      diffForCommit: async (sha, hook) => {
        if (!hook?.toplevel) return [];
        let result = await exec("git", ["-C", hook.toplevel, "diff-tree", "-r", "-M", "--raw", "-z", `${sha}^1`, sha]);
        if (result.code !== 0) result = await exec("git", ["-C", hook.toplevel, "diff-tree", "--root", "-r", "-M", "--raw", "-z", sha]);
        return result.code === 0 ? parseRawDiff(result.stdout) : [];
      },
      subjectForCommit: async (sha, hook) => {
        if (!hook?.toplevel) return null;
        const result = await exec("git", ["-C", hook.toplevel, "show", "-s", "--format=%s", sha]);
        return result.code === 0 ? result.stdout.trim() : null;
      },
    });
    // 研究羊皮卷（§7.4）排在收成之後：這個回合有沒有歸屬確定的 commit 要用同一份來源核對。
    const state = await ledger.state();
    await ingestResearch(ledger, {
      activities: [...state.activities.values()],
      commits: commitContexts({ ...evidence, activities: [...state.activities.values()], remoteMerges: remoteMerges.get(cityId) }),
      cityId,
    });
    unharvested[cityId] = unharvestedCommitReasons({
      cityId,
      ...evidence,
      activities: [...state.activities.values()],
      remoteMerges: remoteMerges.get(cityId),
      state,
    });
    resources[cityId] = state.resources;
    research[cityId] = state.research;
    market[cityId] = state.market;
    stored.push(...state.activities.values());
    expeditions.push(...state.tiles);
  }
  const resolvedEventKeys = new Set(stored.flatMap((record) => (record.events ?? [])
    .filter((event) => event.visit?.commonDir)
    .map((event) => `${record.sessionId}@@${record.writerEpoch}@@${event.eventSeq}`)));
  const unresolvedActivities = unresolvedCandidates.filter((event) =>
    !resolvedEventKeys.has(`${event.sessionId}@@${event.writerEpoch}@@${event.eventSeq}`));
  return readTownFromLedger({
    activities: stored,
    expeditions,
    sessionNames: sessionNamesOf(activities),
    repoFacts,
    resources,
    research,
    market,
    unresolvedActivities,
    unharvestedCommits: unharvested,
    quotas: await loadQuotas(io),
  });
}
/**
 * 操作之後的最小重讀（門檻 4 的關鍵）：只把各城的帳本狀態重讀一次，不重跑
 * 活動檔掃描、commit 證據、reflog 或 `git diff-tree`（那些是開機與 watch 變更才需要的）。
 * 城鎮模型的其他欄位（未解析活動、未收成提交、額度）沿用上一份，不再問 git。
 */
async function refreshTown(io, previous) {
  const stored = [];
  const expeditions = [];
  const resources = {};
  const research = {};
  const market = {};
  const repoFacts = {};
  const unharvestedCommits = {};
  for (const city of previous?.cities ?? []) {
    const ledger = await new CityLedger({
      io,
      dir: cityDir(adapterRoot(appHome()), city.cityId),
      cityId: city.cityId,
    }).open();
    const state = await ledger.state();
    stored.push(...state.activities.values());
    expeditions.push(...state.tiles);
    resources[city.cityId] = state.resources;
    research[city.cityId] = state.research;
    market[city.cityId] = state.market;
    // 中心的種類（舊 repo／新 repo）只依「開城時有沒有 HEAD」，上一份已經算過，不再開 git。
    repoFacts[city.cityId] = { hadHead: city.center?.kind === "oldtown" ? true : city.center?.kind === "founded" ? false : undefined };
    unharvestedCommits[city.cityId] = city.unharvestedCommits ?? [];
  }
  return readTownFromLedger({
    activities: stored,
    expeditions,
    repoFacts,
    resources,
    // 名稱不進帳本：沿用上一份城鎮模型裡各格的名稱（重讀活動檔時才會更新）。
    sessionNames: Object.fromEntries((previous?.cities ?? []).flatMap((city) => city.tiles)
      .filter((tile) => tile.sessionName).map((tile) => [tile.rootSessionId, tile.sessionName])),
    research,
    market,
    unresolvedActivities: previous?.unresolvedActivities ?? [],
    unharvestedCommits,
    // 額度依「現在」重新判定是不是過期（§9）：沿用上一次的解析結果，畫面開著跨過
    // TTL／resetsAt 之後還會顯示舊的 remaining。重算只用已存的原始快照，不打 provider。
    ...(previous?.quotas ? { quotas: quotaView(previous.quotas.snapshot) } : {}),
  });
}
/**
 * 額度回報（§9、§15.2）：provider 明確回報的額度，形狀是 S5 的
 * `omp usage --json --redact --no-extensions` 輸出（spikes/s5/observed.json）。
 *
 * 來源**只有一個**：官方 CLI 自己的 redacted JSON（core/quota-source.js 的 QUOTA_SOURCE）。
 * mod 不讀任何 provider 憑證檔、不解析 token、不改任何設定；指令不存在、沒有登入、
 * 網路失敗或輸出壞掉，都只是「未知」，原因顯示在畫面上。抓取是**使用者按「更新額度」才跑**
 * （不在啟動時自動呼叫外部 CLI：避免每次開 herdr 都打 provider API）。
 */
const quotasPath = () => `${adapterRoot(appHome())}/quotas.json`;

async function loadQuotas(io) {
  // 模型帶著原始快照：之後的重繪／操作刷新都用「現在」重新判定新鮮度（不呼叫外部 CLI）。
  return readQuotaView(io, quotasPath());
}

/** 選取與開發模式的檔案（不是城的帳本）：它們不產生資源，也不改變土地。 */
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
 * 反應門檻的量測（ticket #13 §0）：herdr 的 mod 拿不到 frame counter，
 * 所以量的是「事件 → 含新狀態的那一次 render」與「每次 render 的建樹時間」，
 * 由畫面上的「量測」面板顯示，驗收以截圖上的數字為準。
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
    this.shownCityId = null;
    this.syncedCityId = null;
    this.missingFolder = null;
    this.placeholder = null;
    this.hookStates = {};
    this.toast = null;
    this.note = "正在讀取城鎮帳本…";
    this.legendOpen = true;
    this.metricsOpen = false;
    this.camera = null;
    this.metrics = emptyMetrics();
    // `herdr-app check` 會真的跑 init：不要動使用者的檔案，只渲染固定情境。
    this.historyOpen = false;
    this.historyState = historyOpened();
    this.historyInput = InputState.new({ placeholder: "搜尋日期、城、session、commit 或成果路徑" });
    // 三條送出查詢的路都走同一個狀態機：輸入框的 submit 事件、Enter／Return 的 keydown，
    // 以及面板上的「搜尋」按鈕（見 ui/history.js）。鍵名依平台而異，不再只認一種。
    this.historyInput.on("change", () => { this.historyState = historyChanged(this.historyState, this.historyInput.value()); });
    // 量測：在事件端下標記，由含新狀態的那一次 render 收尾（見 MEASURES）。
    this.mark = (kind) => { this.metrics.pending = { kind, at: Date.now() }; };
    this.historyInput.on("submit", (_event, cx2) => this.submitHistoryQuery(cx2));
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
          this.ui = parseUi(await this.io.read(uiPath()));
          if (first) this.devMode = this.ui.dev;
          // 畫面顯示哪一座城由目前的 space 決定（見 syncCity）；這裡只讓已選的遠征／格子
          // 在帳本變動後仍然有效（不在了就退回那座城的預設）。
          if (this.selection && !this.selection.cityId.startsWith("placeholder:")) this.selection = resolveSelection(this.town, this.selection, this.selection.cityId);
          this.note = null;
        } catch (error) {
          this.town = null;
          this.note = `城鎮帳本讀取失敗：${error}`;
        }
        await this.refreshHookStates();
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

  /** 目前顯示的城（由 syncCity 在每次 render 時依 space 決定）。 */
  city() {
    const cities = this.town?.cities ?? [];
    return (this.shownCityId ? cities.find((city) => city.cityId === this.shownCityId) : null) ??
      (this.placeholder?.cityId === this.shownCityId ? this.placeholder : null);
  }

  /** 選取：存檔＋把那一格帶進畫面；門檻 1（≤ 150 ms）＝按下到含新詳情的那一版畫面。 */
  select(selection, cx) {
    this.mark("pick");
    this.selection = selection;
    this.ui = withSelection(this.ui ?? parseUi(null), selection.cityId, selection);
    if (this.io) saveSelection(this.io, selection).catch(() => {});
    this.requestFocus(selection);
    cx.notify();
  }

  /** 開發模式：顯示工程資訊（規則版本、量測、座標、session、claim…）。存在 ui.json，重開還在。 */
  toggleDev(cx) {
    this.devMode = !this.devMode;
    if (!this.devMode) this.metricsOpen = false;
    this.ui = withDev(this.ui ?? parseUi(null), this.devMode);
    if (this.io) updateUi(this.io, (ui) => withDev(ui, this.devMode)).catch(() => {});
    cx.notify();
  }

  /**
   * 要把哪一格帶進畫面（地圖在 render 時消費一次就清掉）：已撤回與已封存依 §7.1
   * 不畫在圖上，所以它們只更新右側詳情、不動地圖。
   */
  requestFocus(selection) {
    const city = this.city();
    if (!city) return;
    // 中心 2×2 的任何一格都把整塊中心帶進畫面（對準四格的正中央）。
    if (selection?.kind === "tile" && isCenterCell(selection)) {
      this.focusCell = { x: city.center.x + 0.5, y: city.center.y + 0.5 };
      return;
    }
    const tile = selection?.kind === "expedition"
      ? city.tiles.find((entry) => entry.rootSessionId === selection.rootSessionId && entry.generation === selection.generation)
      : selection?.kind === "tile" ? { x: selection.x, y: selection.y, landStage: null } : null;
    if (!tile || tile.landStage === "archived" || tile.landStage === "withdrawn") return;
    if (Math.abs(tile.x) > MAP_RADIUS || Math.abs(tile.y) > MAP_RADIUS) return;
    this.focusCell = { x: tile.x, y: tile.y };
  }

  openHistory(cx) {
    this.mark("panel");
    this.historyOpen = true;
    this.historyState = historyOpened();
    this.historyInput.set_value("");
    cx.notify();
    cx.spawn(async (cx2) => {
      try {
        const records = [];
        const tiles = [];
        const cityNames = {};
        const shown = this.city();
        for (const city of shown && shown !== this.placeholder ? [shown] : []) {
          cityNames[city.cityId] = city.name;
          const ledger = await new CityLedger({
            io: this.io,
            dir: cityDir(adapterRoot(appHome()), city.cityId),
            cityId: city.cityId,
          }).open();
          const state = await ledger.state();
          records.push(...await ledger.historyRecords());
          tiles.push(...state.tiles);
        }
        // 已經打好的查詢會在這裡立刻重跑：先打字、後載入不會停在 0 筆。
        this.historyState = historyLoaded(this.historyState, {
          records, tiles, cityNames, unresolvedActivities: this.town?.unresolvedActivities ?? [],
        });
      } catch (error) {
        this.historyState = historyLoadFailed(this.historyState, error);
      }
      cx2.notify();
    });
  }

  /** Enter／Return 的 keydown 與「搜尋」按鈕；沒有資料時也只回一個看得見的狀態。 */
  submitHistoryQuery(cx) {
    this.historyState = historySubmitted(this.historyState, this.historyInput.value());
    cx.notify();
  }


  jumpHistory(item, cx) {
    if (item.jump) {
      this.select(item.jump, cx);
      this.historyState = historyJumped(this.historyState);
      this.historyOpen = false;
      return;
    }
    this.historyState = { ...this.historyState, error: "這筆歷程沒有對應的地格。" };
    cx.notify();
  }

  closeHistory(cx) {
    this.historyOpen = false;
    cx.notify();
  }


  /** 撤回／封存／重新派遣（§7）：帳本的一筆 CAS 操作；量測從按下到狀態更新（門檻 300 ms）。 */
  operateLand(detail, action, cx) {
    if (!detail?.cityId || !detail.rootSessionId) return;
    const startedAt = Date.now();
    cx.spawn(async (cx2) => {
      try {
        const ledger = await new CityLedger({
          io: this.io,
          dir: cityDir(adapterRoot(appHome()), detail.cityId),
          cityId: detail.cityId,
        }).open();
        const result = action === "redispatch"
          ? await redispatch(ledger, { rootSessionId: detail.rootSessionId, at: Date.now() })
          : await processLand(ledger, {
              rootSessionId: detail.rootSessionId,
              generation: detail.generation,
              action,
              at: Date.now(),
            });
        if (result.status !== "applied" && result.status !== "duplicate") {
          this.note = `土地操作未完成：${result.reason ?? result.status}`;
        } else {
          this.town = await refreshTown(this.io, this.town);
          const latest = this.town.cities.find((city) => city.cityId === detail.cityId)?.tiles
            .filter((tile) => tile.rootSessionId === detail.rootSessionId)
            .reduce((current, tile) => !current || tile.generation > current.generation ? tile : current, null);
          this.selection = {
            kind: "expedition",
            cityId: detail.cityId,
            rootSessionId: detail.rootSessionId,
            generation: latest?.generation,
          };
          this.note = null;
          await saveSelection(this.io, this.selection);
        }
      } catch (error) {
        this.note = `土地操作失敗：${error}`;
      }
      this.metrics.pending = { kind: "action", at: startedAt };
      cx2.notify();
    });
  }
  /**
   * 加速、蓋房與市集（§7.6）：每一筆都是帳本的一筆 CAS 操作。同一次點擊只產生一個
   * operation ID，重送（中斷後重試）不會重複扣卷或重複扣料；前提不符就整筆不成立。
   */
  operateEconomy(kind, detail, payload, cx) {
    if (!detail?.cityId) return;
    const startedAt = Date.now();
    cx.spawn(async (cx2) => {
      try {
        const ledger = await new CityLedger({
          io: this.io,
          dir: cityDir(adapterRoot(appHome()), detail.cityId),
          cityId: detail.cityId,
        }).open();
        const at = Date.now();
        const operation = kind === "boost"
          ? processBoost(ledger, { rootSessionId: detail.rootSessionId, generation: detail.generation, scrolls: payload.scrolls, at })
          : kind === "build"
            ? processBuild(ledger, { rootSessionId: detail.rootSessionId, generation: detail.generation, recipe: payload.recipe, at })
            : processTrade(ledger, { from: payload.from, to: payload.to, amount: payload.amount, at });
        const result = await operation;
        if (result.status !== "applied" && result.status !== "duplicate") {
          this.note = `${ECONOMY_LABELS[kind]}未完成：${result.reason ?? result.status}`;
        } else {
          this.town = await refreshTown(this.io, this.town);
          this.note = null;
        }
      } catch (error) {
        this.note = `${ECONOMY_LABELS[kind]}失敗：${error}`;
      }
      this.metrics.pending = { kind: "action", at: startedAt };
      cx2.notify();
    });
  }


  retryTown(cx) {
    cx.spawn(async (cx2) => {
      try {
        this.town = await loadTown(this.io);
        this.note = null;
      } catch (error) {
        this.note = `城鎮讀取失敗：${error}`;
      }
      cx2.notify();
    });
  }

  /**
   * 這個 mod 所在的 space 的候選資料夾，依優先序：被指定的資料夾（props）→ 有焦點的終端
   * → 目前分頁的終端 → 其他分頁的終端 → space 記錄的起始資料夾（它跟著焦點走，所以放最後）。
   * 遠端機器的 space 與固定情境（herdr-app check）沒有本機資料夾，回空陣列。
   */
  spaceFolders() {
    if (checking()) return [];
    const wanted = props()?.space;
    const space = spaces().find((entry) => (wanted ? entry.id === wanted : entry.active)) ?? null;
    if (space?.machine) return [];
    const folders = [];
    if (typeof props()?.folder === "string") folders.push(props().folder);
    if (space) {
      const tabs = new Map(space.tabs.map((tab) => [tab.id, tab]));
      const rank = (pane) => (pane.focused ? 0 : tabs.get(pane.tab)?.active ? 1 : 2);
      const mine = panes()
        .filter((pane) => tabs.has(pane.tab) && pane.terminal && pane.cwd)
        .sort((a, b) => rank(a) - rank(b));
      folders.push(...mine.map((pane) => pane.cwd), space.folder);
    }
    return folders.filter((folder) => typeof folder === "string" && folder);
  }

  /**
   * 畫面顯示哪一座城：跟著目前的 space 走（切換 space，城就換）。對不上任何城時回 null，
   * 畫面說明這個 space 還沒有城；拿不到 space 資訊時才退回選取過的那座城。
   * 換城時選取還原成那座城上次的選取，地圖對位到它的中心（或選取的格子）。
   */
  syncCity() {
    const cities = this.town?.cities ?? [];
    const folders = this.spaceFolders();
    let target;
    if (folders.length) {
      target = cityForFolders(cities, folders);
      this.missingFolder = null;
      this.placeholder = null;
      if (!target) {
        // 這個 space 還沒有任何遠征：照樣顯示城鎮中心與周圍的空地，只是沒有格子在開墾。
        const folder = folders[0];
        this.placeholder = emptyCity(`placeholder:${folder}`, folder.split("/").filter(Boolean).pop() ?? folder);
        target = this.placeholder;
      }
    } else {
      this.placeholder = null;
      target = (this.selection?.cityId ? cities.find((city) => city.cityId === this.selection.cityId) : null) ?? cities[0] ?? null;
      this.missingFolder = null;
    }
    this.shownCityId = target?.cityId ?? null;
    if (target && this.syncedCityId !== target.cityId) {
      this.syncedCityId = target.cityId;
      if (this.selection?.cityId !== target.cityId) {
        this.selection = target === this.placeholder
          ? { kind: "tile", cityId: target.cityId, x: target.center.x, y: target.center.y }
          : resolveSelection(this.town, selectionOf(this.ui, target.cityId), target.cityId);
      }
      this.requestFocus(this.selection);
      if (!this.focusCell) this.focusCell = { x: target.center.x + 0.5, y: target.center.y + 0.5 };
    }
    return target;
  }

  render(cx) {
    // 顯示更新時重新判定額度是否過期（S4）：模型帶著原始快照，這裡用「現在」重算一次，
    // 所以只是選取／重繪（沒有重新抓取）也會在跨過 TTL／resetsAt 之後顯示未知。
    if (this.town?.quotas?.snapshot !== undefined) this.town.quotas = quotaView(this.town.quotas.snapshot);
    const started = Date.now();
    const t = theme();
    const city = this.syncCity();
    if (!city) {
      // 沒有城時也看得到未解析的活動（§4：不當成非 git，活動資料保留、可以重試）。
      const unresolved = this.town?.unresolvedActivities ?? [];
      this.metrics.pending = null;
      return v_flex()
        .id("root")
        .size_full()
        .items_center()
        .justify_center()
        .gap(8)
        .bg(t.canvas)
        .text_color(t.muted)
        .child(div().child(this.note ?? (this.missingFolder
          ? `這個 space（${this.missingFolder}）還沒有城鎮：在這個 repo 裡開一個互動的 agent session 就會出現。`
          : "還沒有任何城市：互動的 root session 進到一個 Git repo 之後就會出現。")))
        .children(unresolved.map((activity) =>
          div().text_size(10).child(this.devMode ? `未解析 · ${activity.sessionId} · ${activity.cwd}` : "未解析的活動")))
        .when(unresolved.length > 0, (element) =>
          element.child(hookButton("重試歸戶", t, (cx2) => this.retryTown(cx2))));
    }
    // 這一格 mod 有多寬決定兩側的欄寬；窄 pane 也看得到四個區塊。
    // on_size_change 給的是實際像素（含畫面縮放），版面用的 .w()/.left() 是 UI 像素。
    const zoom = zoomFactor();
    const width = (this.rootSize.width || 940 * zoom) / zoom;
    const height = (this.rootSize.height || 560 * zoom) / zoom;
    const leftW = Math.round(clamp(MIN_LEFT_W, width * 0.19, MAX_LEFT_W));
    const rightW = Math.round(clamp(MIN_RIGHT_W, width * 0.26, MAX_RIGHT_W));
    // 地圖就是列裡剩下的那一塊；用 root 的尺寸算，不另外量自己。
    const mapArea = { width: Math.max(80, width - leftW - rightW), height: Math.max(80, height - TOP_H) };
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
        this.topBar(city, t, leftW, rightW, width),
        h_flex().flex_1().min_h(0).children([
          this.expeditionList(city, t, cx, leftW),
          this.mapColumn(city, t, cx, mapArea),
          this.detailPanel(selectionDetail(this.placeholder && city === this.placeholder ? { ...this.town, cities: [this.placeholder] } : this.town, this.selection), t, rightW, cx),
        ]),
      ]);
    this.finishMeasure(started);
    return root;
  }

  /** 量測收尾（§0）：建樹時間＋最近一次「事件 → 含新狀態的 render」。 */
  finishMeasure(startedAt) {
    const built = Date.now();
    this.metrics.build.last = Math.max(0, built - startedAt);
    this.metrics.build.max = Math.max(this.metrics.build.max, this.metrics.build.last);
    const pending = this.metrics.pending;
    this.metrics.pending = null;
    if (!pending || !this.metrics.samples[pending.kind]) return;
    this.metrics.samples[pending.kind] = recordSample(this.metrics.samples[pending.kind], Math.max(0, built - pending.at));
  }

  // ---- 上方：城鎮庫存與主要行會（§9、§14.1）

  /** 這座城的自動收成開著嗎（讀 hook 檔，不是記憶）。已經確定的城不重查。 */
  async refreshHookStates() {
    for (const city of this.town?.cities ?? []) {
      if (this.hookStates[city.cityId] === "installed") continue;
      const repo = city.tiles.find((tile) => tile.repo?.checkout)?.repo.checkout;
      if (!repo) continue;
      try {
        this.hookStates[city.cityId] = (await hooksStatus({ repo, exec, io: storageIo() })).status;
      } catch {
        this.hookStates[city.cityId] = "unknown";
      }
    }
  }

  hookToggle(city, t) {
    const on = this.hookStates[city.cityId] === "installed";
    return hookButton(on ? "停止自動收成" : "開啟自動收成", t, (cx2) => this.manageHooks(city, on, cx2));
  }

  /**
   * 第一次看到一座還沒開自動收成的城，先問使用者（寫進 repo 的 .git/hooks，不能默默做）。
   * 回答「先不要」會記在 ui.json，之後不再跳出；頂欄的按鈕隨時可以開。
   */
  hookBanner(city, t) {
    if (city === this.placeholder) return [];
    const state = this.hookStates[city.cityId];
    if (state !== "missing" && state !== "partial") return [];
    if (this.ui?.hooks?.[city.cityId] === "declined") return [];
    return [v_flex().gap(4).p(7).rounded(6).bg(t.surface).border(1).border_color(t.accent).children([
      div().text_size(11).font_semibold().child("開啟自動收成？"),
      div().text_size(9).text_color(t.muted).child(
        "agent 在這個 repo 的 commit 要換成資源，需要在 .git/hooks 加入三個記錄用的小檔案。只在本機記一筆，不連網、不改你的 commit，隨時可以停止。沒開的話這座城不會收成。",
      ),
      h_flex().gap(6).children([
        hookButton("開啟", t, (cx2) => this.manageHooks(city, false, cx2)),
        hookButton("先不要", t, (cx2) => this.declineHooks(city, cx2)),
      ]),
    ])];
  }

  declineHooks(city, cx) {
    this.ui = withHookChoice(this.ui ?? parseUi(null), city.cityId, "declined");
    if (this.io) updateUi(this.io, (ui) => withHookChoice(ui, city.cityId, "declined")).catch(() => {});
    cx.notify();
  }

  manageHooks(city, remove, cx) {
    const repo = city.tiles.find((tile) => tile.repo?.checkout)?.repo.checkout;
    if (!repo) {
      this.showToast("沒有可用的 checkout", cx);
      return;
    }
    cx.spawn(async (cx2) => {
      let text;
      try {
        const result = remove
          ? await removeHooks({ repo, exec })
          : await installHooks({ repo, exec, io: storageIo(), appHome: appHome() });
        if (result.status === "installed") this.hookStates[city.cityId] = "installed";
        if (result.status === "removed" || result.status === "not-installed") this.hookStates[city.cityId] = "missing";
        text = result.status === "refused"
          ? `沒有開啟自動收成：${result.message ?? result.reason}`
          : result.status === "needs-confirmation"
            ? HOOK_CONFIRM_LABELS[result.reason] ?? `需先確認：${result.reason}`
            : result.status === "installed" ? "已開啟自動收成"
            : result.status === "removed" ? "已停止自動收成"
            : result.status === "not-installed" ? "目前沒有開啟自動收成"
            : `操作未完成：${result.reason ?? result.status}`;
      } catch (error) {
        text = `自動收成操作失敗：${error}`;
      }
      this.showToast(text, cx2);
    });
  }

  /**
   * 更新額度（§9、§15.2）：跑官方 CLI 的 redacted JSON 輸出，驗證後寫進 quotas.json 再重播城鎮。
   * 這是額度唯一的來源；沒有 CLI、沒有登入、網路失敗或輸出壞掉，都只留下原因並顯示未知。
   */
  refreshQuotas(cx) {
    cx.spawn(async (cx2) => {
      this.showToast(`正在抓取額度：${QUOTA_SOURCE.command} ${QUOTA_SOURCE.args.join(" ")}`, cx2);
      let text;
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
          text = `額度來源失敗（exit ${result.code}）：${String(result.stderr ?? "").trim().slice(0, 160) || "沒有輸出"}`;
        } else {
          const parsed = parseQuotaReport(result.stdout);
          if (parsed.error) {
            text = `額度回報無法使用：${parsed.error}`;
          } else {
            const before = await this.io.read(quotasPath());
            await this.io.write(quotasPath(), `${JSON.stringify(parsed.snapshot)}\n`, before);
            text = parsed.snapshot.warnings.length
              ? `額度已更新（${parsed.snapshot.warnings.join("；")}）`
              : "額度已更新";
            this.town = await loadTown(this.io);
          }
        }
      } catch (error) {
        text = `額度更新失敗：${error}`;
      }
      this.showToast(text, cx2);
    });
  }
  topBar(city, t, leftW, rightW, width) {
    // 窄 pane：中央那塊的內容比剩下的寬度還寬時，會蓋到左右兩塊。改成上下兩排，
    // 並且一律 overflow_hidden，寧可裁掉也不畫在別人上面（§14.1 的四個區塊都要在）。
    const blockW = Math.round(clamp(96, rightW * 0.62, 176));
    const centerW = Math.max(60, width - leftW - blockW - 52);
    const stacked = centerW < 430;
    const stock = h_flex()
      .gap(10)
      .items_center()
      .child(div().text_size(10).text_color(t.dim).child("庫存"))
      .children(RESOURCES.map((resource) => resourceChip(resource, city.resources[resource.key], t)));
    // §7.4 的研究計量器：每滿 100,000 換 1 張羊皮卷，餘數按城保留。
    const research = h_flex()
      .gap(6)
      .items_center()
      .child(div().text_size(10).text_color(t.dim).child("研究"))
      .child(div().text_size(12.5).child(`${city.research?.tokens ?? 0} / ${RESEARCH_TOKENS_PER_PARCHMENT}`));
    const center = stacked
      ? v_flex().flex_1().min_w(0).overflow_hidden().gap(2).child(stock).child(research)
      : h_flex().flex_1().min_w(0).overflow_hidden().items_center().justify_center().gap(14).child(stock).child(research);
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
          .child(div().text_size(10).text_color(t.dim).child("遠征指揮桌"))
          .child(div().text_size(stacked ? 13 : 17).font_semibold().truncate().child(city.name)),
        center,
        v_flex()
          // 窄 pane 不跟中央那塊搶寬度：右側區塊也有下限，文字自己 truncate。
          .w(blockW)
          .flex_none()
          .overflow_hidden()
          .items_end()
          .gap(3)
          .children(guildBlock(city, this.town?.quotas, t))
          .child(h_flex().flex_wrap().gap(6).items_center().children([
            ...(city === this.placeholder ? [] : [this.hookToggle(city, t)]),
            hookButton("更新額度", t, (cx2) => this.refreshQuotas(cx2)),
            hookButton(this.devMode ? "開發模式 ✓" : "開發模式", t, (cx2) => this.toggleDev(cx2)),
          ]))
          // 規則版本與量測是開發用的工程資訊：開發模式才出現。
          .when(this.devMode, (element) => element.child(h_flex().flex_wrap().gap(6).items_center().children([
            div().text_size(9).text_color(t.dim).child(`規則 v${RULES_VERSION}`),
            hookButton(this.metricsOpen ? "關閉量測" : "量測", t, (cx2) => {
              this.metricsOpen = !this.metricsOpen;
              cx2.notify();
            }),
          ])))
      ]);
  }

  // ---- 左側：現役遠征

  /**
   * 左側：每一格土地就是一支遠征（§14.1）。狀態分兩層顯示（§5.1）：土地階段（預留／已開墾／
   * 已建／已撤回／已封存）與遠征狀態（探索中／駐紮）；來源不明的提交與未解析的活動各有自己的區塊，
   * 所以五種狀態在畫面上都認得出來（其餘兩處：地圖圖例、右側詳情）。
   */
  expeditionList(city, t, cx, width) {
    const unresolved = this.town?.unresolvedActivities ?? [];
    const summary = stageCounts(city.tiles).map((entry) => `${entry.label} ${entry.count}`).join(" · ");
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
        div().text_size(10).text_color(t.dim).child("遠征（每格一支）"),
        div().text_size(13).font_semibold().child(`${city.tiles.length} 格土地`),
        div().text_size(9).text_color(t.muted).truncate().child(summary || "還沒有土地"),
        ...this.hookBanner(city, t),
        // 來源不明與未解析是診斷資訊：一般只看到狀態與數量，原因、sha、cwd 在開發模式才展開。
        ...(city.unharvestedCommits?.length ? [
          h_flex().gap(5).items_center().child(statusBadge("來源不明", t))
            .child(div().text_size(9).text_color(t.dim).child(
              this.devMode ? "不發資源、無人工補領" : `${city.unharvestedCommits.length} 筆`,
            )),
          ...(this.devMode ? city.unharvestedCommits.map((commit) => div().text_size(9).text_color(t.muted).truncate()
            .child(`⚑ ${commit.sha.slice(0, 8)} · ${COMMIT_REASON_LABELS[commit.reason] ?? commit.reason}`)) : []),
        ] : []),
        ...(unresolved.length ? [
          h_flex().gap(5).items_center().child(statusBadge("未解析", t))
            .child(div().text_size(9).text_color(t.dim).child(`${unresolved.length} 筆活動`)),
          ...(this.devMode ? [
            div().text_size(9).text_color(t.muted).child("cwd 不在、不是 git，或 repo 身份無法正規化；活動保留，可以重試。"),
            ...unresolved.map((activity) => v_flex().gap(1).p(5).rounded(4).bg(t.surface)
              .border(1).border_color(t.border)
              .child(div().text_size(9).text_color(t.muted).truncate().child(activity.sessionId))
              .child(div().text_size(9).text_color(t.dim).truncate().child(activity.cwd))),
          ] : []),
          hookButton("重試歸戶", t, (cx2) => this.retryTown(cx2)),
        ] : []),
        ...city.tiles.map((tile) => this.expeditionCard(city, tile, t, cx)),
      ]);
  }

  expeditionCard(city, tile, t, cx) {
    const status = statusOf(tile, t);
    const selected = this.selection?.kind === "expedition" &&
      this.selection.rootSessionId === tile.rootSessionId && this.selection.generation === tile.generation;
    return v_flex()
      .id(`expedition-${tile.rootSessionId}-${tile.generation}`)
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
        this.select({
          kind: "expedition",
          cityId: city.cityId,
          rootSessionId: tile.rootSessionId,
          generation: tile.generation,
        }, cx2),
      )
      .children([
        h_flex().gap(5).items_center()
          .child(div().size(7).rounded_full().bg(status.color))
          .child(div().text_size(11).text_color(status.color).child(status.label))
          .child(stageBadge(tile, t)),
        div().text_size(12.5).font_semibold().truncate().child(
          tile.sessionName?.trim() ? `${tileLabel(tile)}${tile.generation > 1 ? ` · 第 ${tile.generation} 代` : ""}` : `遠征 ${shortId(tile.rootSessionId)} · 第 ${tile.generation} 代`,
        ),
        div().text_size(11).text_color(t.muted).truncate().child(
          this.devMode ? `${tile.points} / ${CLEAR_POINTS} · ${tile.cli ?? "未知"}` : `${tile.points} / ${CLEAR_POINTS}`,
        ),
        factionTag(tile, t),
      ]);
  }

  // ---- 中央：3/4 城市地圖

  /**
   * 中央欄＝地圖＋（開啟時）量測面板。地圖本身是 ui/map.js 的原生雙軸捲動內容區：
   * 格子的邏輯座標與投影分開，點擊由 `cellAtPoint` 反解回地面菱形，建築只是裝飾。
   */
  mapColumn(city, t, cx, area) {
    return div()
      .flex_1()
      .min_w(0)
      .h_full()
      .relative()
      .child(this.map(city, t, cx, area))
      .when(this.metricsOpen && this.devMode, (element) => element.child(this.metricsPanel(t)))
      .when(this.toast !== null, (element) => element.child(this.toastView(t)));
  }

  map(city, t, cx, area) {
    const tiles = new Map(city.tiles
      .filter((entry) => entry.landStage !== "archived" && entry.landStage !== "withdrawn")
      .map((entry) => [keyOf(entry), entry]));
    // 看得到地面的格子：中心 2×2 與它旁邊一格從開城就是；開墾完成的格子再往外揭開（§4）。
    const revealed = revealedKeys(city.tiles);
    const tile = tileSize(area);
    const size = contentSize(MAP_RADIUS, tile);
    // **真正可見的地圖區域**＝地圖框扣掉覆蓋層：頂部的圖例（左上角，實測高度）與
    // 開啟時的量測面板（左下角）。選取入畫用的是這一塊，不是整個地圖框——
    // 這就是 600 UI px 的四角格「在框內卻被圖例蓋住／被上緣裁掉」的原因。
    const metricsShown = this.metricsOpen && this.devMode;
    const visible = visibleRect(area, this.legendSize, metricsShown ? this.metricsSize : null);
    const anchor = this.focusCell ?? this.anchorCell ?? { x: city.center.x + 0.5, y: city.center.y + 0.5 };
    // 地圖只在「要帶一格進畫面」、換城、或地圖框本身變大小時重新對位。圖例展開／收合只改
    // 覆蓋層的大小，**不能**讓整張圖跳動：那種情況只由下面的 ensureVisible 在選取格被蓋住時最小位移。
    const resized = area.width !== this.mapArea?.width || area.height !== this.mapArea?.height;
    const moved = this.focusCell || !this.camera || this.camera.cityId !== city.cityId || resized;
    if (moved) {
      this.anchorCell = anchor;
      this.camera = { cityId: city.cityId, ...cameraFor(anchor, visible, MAP_RADIUS, tile) };
    }
    this.viewport = visible;
    this.mapArea = { width: area.width, height: area.height };
    // 先夾在畫得出來的範圍（用整個地圖框，平移不被圖例限制），再保證選取的那一格
    // （含最高的 mock 建築外框，它畫在格子方框內）完整落在**可見區**裡。
    this.camera = { ...this.camera, ...clampCamera(this.camera, size, area) };
    this.camera = { ...this.camera, ...ensureVisible(this.anchorCell, this.camera, visible, MAP_RADIUS, tile, CELL_MARGIN) };
    this.focusCell = null;
    return mapView({
      city,
      tiles,
      revealed,
      selection: this.selection,
      theme: t,
      tile,
      viewport: area,
      legendOpen: this.legendOpen,
      devMode: this.devMode,
      camera: this.camera,
      // 圖例（左上覆蓋層）把**量到的大小**回報給畫面。只有第一次量到時重新對位（開啟時圖例
      // 才有高度）；之後展開／收合不重新置中，地圖不會跳。
      onLegendSize: (size, cx2) => {
        const first = !this.legendSize;
        const changed = this.legendSize?.height !== size.height || this.legendSize?.width !== size.width;
        this.legendSize = size;
        if (changed) {
          if (first) this.requestFocus(this.selection);
          cx2.notify();
        }
      },
      onToggleLegend: (cx2) => {
        this.legendOpen = !this.legendOpen;
        cx2.notify();
      },
      // 雙軸捲動：滾輪／觸控板的 delta 直接改相機（往下捲＝內容往上），並夾在畫得出來的範圍內。
      onPan: (delta, cx2) => {
        if (!this.camera) return; // 城還沒載入時沒有相機
        const next = panCamera(this.camera, delta, size, area);
        this.metrics.scroll = {
          events: (this.metrics.scroll?.events ?? 0) + 1,
          sumX: (this.metrics.scroll?.sumX ?? 0) + delta.x,
          sumY: (this.metrics.scroll?.sumY ?? 0) + delta.y,
        };
        this.camera = { ...this.camera, ...next };
        cx2.notify();
      },
      onPick: ({ x, y }, cx2) => {
        // 門檻 1（≤ 150 ms）：按下 → 含新詳情的那一版畫面。
        this.mark("pick");
        const entry = tiles.get(keyOf({ x, y }));
        this.select(
          entry
            ? { kind: "expedition", cityId: city.cityId, rootSessionId: entry.rootSessionId, generation: entry.generation }
            : { kind: "tile", cityId: city.cityId, x, y },
          cx2,
        );
      },
    });
  }

  /** 操作結果的一行小提示（浮在地圖下方）：幾秒後自己消失，點一下也能關。 */
  showToast(text, cx) {
    const id = (this.toastSeq = (this.toastSeq ?? 0) + 1);
    this.toast = { id, text };
    cx.notify();
    cx.timer.after(TOAST_MS, (cx2) => {
      if (this.toast?.id !== id) return;
      this.toast = null;
      cx2.notify();
    });
  }

  toastView(t) {
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
          .child(this.toast.text),
      );
  }

  /** 量測面板（§0，開發模式）：三個互動門檻的最近值／最大值，以及每次 render 的建樹時間。 */
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
          if (first) this.requestFocus(this.selection);
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
        .child(`可見區 ${Math.round(this.viewport?.x ?? 0)},${Math.round(this.viewport?.y ?? 0)} ${Math.round(this.viewport?.width ?? 0)}×${Math.round(this.viewport?.height ?? 0)} · 圖例 ${Math.round(this.legendSize?.width ?? 0)}×${Math.round(this.legendSize?.height ?? 0)} · 量測 ${Math.round(this.metricsSize?.height ?? 0)} · 置中格 ${this.anchorCell?.x ?? "—"},${this.anchorCell?.y ?? "—"}`))
  }

  // ---- 右側：選取遠征或格子的詳情（§12 的入口）

  detailPanel(detail, t, width, cx) {
    if (this.historyOpen) {
      return historyPanel({
        state: this.historyState,
        input: this.historyInput,
        theme: t,
        onClose: (cx2) => this.closeHistory(cx2),
        onKeyDown: (cx2) => this.submitHistoryQuery(cx2),
        onJump: (item, cx2) => this.jumpHistory(item, cx2),
      }).w(width).flex_none().min_h(0).overflow_y_scrollbar().bg(t.chrome).border_l(1).border_color(t.border);
    }
    const actionLabels = { withdraw: "撤回", archive: "封存", redispatch: "重新派遣" };
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
          // §12：歷程搜尋的入口（遠征／格子／中心格的詳情都有；面板只在按下去時佔右欄）。
          detail.historyEntry
            ? hookButton("歷程搜尋", t, (cx2) => this.openHistory(cx2))
            : null,
          div().text_size(14).font_semibold().child(detail.title),
          detail.statusLabel || detail.tile?.landStage
            ? h_flex().gap(6).items_center().flex_wrap().children([
                detail.statusLabel ? statusBadge(detail.statusLabel, t) : null,
                detail.tile?.landStage ? stageBadge(detail.tile, t) : null,
                detail.tile?.harvested ? div().text_size(10).text_color(t.done).child("✔ 已收成") : null,
              ].filter(Boolean))
            : null,
          detail.kind === "fog"
            ? div().text_size(9).text_color(t.muted).child("迷霧：還沒有人到過這裡；達到 100 點的格子會揭開它自己和上下左右的鄰格。")
            : null,
          detail.kind === "open"
            ? div().text_size(9).text_color(t.muted).child("已揭開的空地：看得到地面，還沒有遠征進駐。新的遠征會從離城鎮中心最近的空地開始。")
            : null,
          detail.pointsTarget ? progress(detail, t) : null,
          ...detail.fields.filter((field) => this.devMode || !field.dev).map((field) => fieldRow(field, t)),
          ...(detail.investment ? investmentSection(detail, t, this.devMode) : []),
          ...(detail.quota?.length ? quotaSection(detail, t) : []),
          ...(detail.actions ?? []).map((action) =>
            hookButton(actionLabels[action], t, (cx2) => this.operateLand(detail, action, cx2))),
          detail.actionUnavailableReason
            ? div().text_size(9).text_color(t.muted).child(detail.actionUnavailableReason)
            : null,
          ...this.economySection(detail, t, cx),
          this.note ? div().text_size(9).text_color(t.muted).child(this.note) : null,
        ].filter(Boolean),
      );
  }

  /**
   * §7.6 的操作區（右側詳情）：只列出現在做得到的操作 —— 庫存足以支付完整配方的建築、
   * 這一格用得起的加速張數，以及庫存換得起的市集配對。做得到的才畫按鈕。
   */
  economySection(detail, t, cx) {
    const rows = [];
    const boost = detail.boost;
    if (boost?.available && boost.scrolls > 0) {
      rows.push(hookButton(
        `加速 ${boost.scrolls} 卷（+${boost.scrolls * boost.pointsPerScroll} 點）`,
        t,
        (cx2) => this.operateEconomy("boost", detail, { scrolls: boost.scrolls }, cx2),
      ));
    }
    if (detail.buildable?.length) {
      rows.push(div().text_size(10).text_color(t.dim).child("蓋房（一次扣除整份配方）"));
      for (const recipe of detail.buildable) {
        rows.push(hookButton(`${recipe.label} · ${costsLabel(recipe.costs)}`, t,
          (cx2) => this.operateEconomy("build", detail, { recipe: recipe.name }, cx2)));
      }
    }
    if (detail.market?.length) {
      rows.push(div().text_size(10).text_color(t.dim).child("市集 3 換 1"));
      for (const pair of detail.market) {
        rows.push(hookButton(`${pair.label}（可得 ${pair.amount}）`, t,
          (cx2) => this.operateEconomy("trade", detail, { from: pair.from, to: pair.to, amount: 1 }, cx2)));
      }
    }
    if (boost && !boost.available && boost.reason) {
      rows.push(div().text_size(9).text_color(t.muted).child(`不能加速：${boost.reason}`));
    }
    return rows;
  }
}


/** 配方的實付資源一行（main.js 只負責顯示；扣款與版本在帳本那一層）。 */
function costsLabel(costs = {}) {
  return Object.entries(costs).map(([key, amount]) => `${RESOURCE_LABELS[key] ?? key}${amount}`).join("・");
}

function hookButton(label, t, action) {
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

/** 狀態標記的顏色（§5.1 的狀態與土地分開顯示）：未知來源與未解析用 blocked。 */
const STATUS_TOKENS = {
  探索中: "working",
  駐紮: "idle",
  未解析: "blocked",
  來源不明: "blocked",
};

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
  const color = t[STATUS_TOKENS[label] ?? "idle"] ?? t.muted;
  return h_flex()
    .gap(5)
    .items_center()
    .child(div().size(7).rounded_full().bg(color))
    .child(div().text_size(11).text_color(color).child(label));
}

/** 土地階段的標記（預留／已開墾／已建／已撤回／已封存），左側卡片與圖例共用同一份文字。 */
function stageBadge(tile, t) {
  const mark = stageOf(tile);
  return div().text_size(10).text_color(t[mark.token] ?? t.muted).child(mark.label);
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

