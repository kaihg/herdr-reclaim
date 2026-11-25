// View 層的測試替身：不用視窗、螢幕、點擊或真的 herdr，就能把 `main.js` 的 render 樹當資料走。
//
// `main.js` 只匯入三個 host 模組（`gpui-kit`、`gpui-base`、`herdr`）。測試檔先在這裡
// `installHost(...)` 換掉它們，再 `await import("../main.js")`；順序反了就拿到真的模組。
//
// render 樹真的只是資料：`.child()`／`.children()`／`.when()` 收子節點，`on_click`／
// `on_mouse_down`／`on_scroll_wheel`／`on_size_change` 收處理器，其餘鏈式方法（`.w()`、
// `.text_size()`…）記在 props。事件處理器是普通的函式，呼叫它就等於按下，不用合成指標事件。
//
// 這裡不驗證「未知的 element 方法」：沒實作的鏈式方法會靜默通過。那一層由
// `herdr-app check` 負責（它會指名未知的 element 方法），所以兩者都要跑。
//
// `window.paint_path`（地圖的原生路徑）換成一個什麼都接、什麼都回自己的替身：路徑內容屬於
// 像素層，這裡只確認它有沒有被呼叫，不看畫出來的形狀。
import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { adapterRoot } from "../core/adapter.js";
import { CityLedger } from "../core/ledger.js";
import { SHARED_CITY_ID, sharedCityDir } from "../core/shared-city.js";
import { createFileIo } from "./fs-io.js";

/** 一個什麼都接的替身：任何方法、屬性都回自己，可以無限鏈式呼叫。 */
function chainable() {
  const self = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : () => self),
    apply: () => self,
    construct: () => self,
  });
  return self;
}

/**
 * 一個 element：`kids` 是子節點（字串就是文字），`props` 是樣式與版面，`handlers` 是事件。
 * 只實作 mod 真的用到的四個事件；其他事件名當成一般 prop 記下來。
 */
function element(tag) {
  const node = {
    tag,
    props: {},
    kids: [],
    handlers: {},
    when(cond, build) {
      if (cond) build(self);
      return self;
    },
    child(value) {
      if (value !== null && value !== undefined) node.kids.push(value);
      return self;
    },
  };
  const self = new Proxy(node, {
    get(target, key) {
      const value = target[key];
      if (typeof value === "function") {
        return (...args) => {
          const result = value.apply(target, args);
          return result === target ? self : result;
        };
      }
      if (key in target) return value;
      if (typeof key !== "string") return undefined;
      return (...args) => {
        if (key === "children") {
          for (const item of args[0].flat()) if (item !== null && item !== undefined) target.kids.push(item);
          return self;
        }
        if (key === "on_click") { target.handlers.click = args[0]; return self; }
        if (key === "on_mouse_down") { (target.handlers.mouseDown ??= {})[args[0]] = args[1]; return self; }
        if (key === "on_scroll_wheel") { target.handlers.wheel = args[0]; return self; }
        if (key === "on_size_change") { target.handlers.size = args[0]; return self; }
        target.props[key] = args.length <= 1 ? args[0] : args;
        return self;
      };
    },
  });
  return self;
}

const readFile = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** `exec("find", [dir, "-type", "f", ...])`：mod 只有這個方式列目錄（core/adapter.js）。 */
function findJson(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) found.push(full);
    }
  };
  walk(dir);
  return found.join("\n");
}

/**
 * 換掉 `gpui-kit`、`gpui-base`、`herdr`。必須在 `import("../main.js")` 之前呼叫。
 *
 * - `checking: true`：`herdr-app check` 的模式，mod 渲染 `scenarios/shared-city.js` 的固定情境，
 *   不碰任何檔案。
 * - `checking: false`：真的載入鏈。檔案 API 是真的 node fs（CAS 語意與 `test/fs-io.js` 相同），
 *   `watchFolder` 永遠不回來，所以載入迴圈停在「等下一次變更」，測試不必關掉它。
 *
 * @param {{ checking?: boolean, home?: string }} [options]
 * @returns {{ home: string, file: string }} `file(path)` 給測試看同一份資料。
 */
export function installHost({ checking = true, home } = {}) {
  const root = home ?? path.join("/tmp", "herdr-reclaim-view", `${process.pid}-${Math.random().toString(36).slice(2)}`);
  if (!home) fs.rmSync(root, { recursive: true, force: true });

  globalThis.window = new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : chainable()) });
  // 主題只當成「每個 token 都是一個顏色字串」：畫面文字與版面才是測試要看的東西。
  const theme = new Proxy({}, { get: (_target, key) => String(key) });

  mock.module("gpui-kit", () => ({
    View: class {},
    div: () => element("div"),
    Background: { solid: () => ({ opacity() { return this; } }), pattern_slash: () => ({}) },
    PathBuilder: chainable(),
  }));
  mock.module("gpui-base", () => ({
    h_flex: () => element("h"),
    v_flex: () => element("v"),
  }));
  mock.module("herdr", () => ({
    checking: () => checking,
    theme: () => theme,
    // 沒有縮放設定：zoomFactor() 就是 1（版面 px 等於量到的 px）。
    settings: () => ({}),
    home: () => root,
    appHome: () => root,
    readTextFile: async (file) => readFile(file),
    writeTextFile: async (file, text, expected) => {
      const current = readFile(file);
      if (expected !== undefined && current !== expected) {
        throw new Error("`herdr.writeTextFile`: The file changed outside Herdr. Reload before saving; your draft is still here.");
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    },
    exec: async (command, args) => {
      if (command !== "find") throw new Error(`exec: ${command}: command not found`);
      return { code: 0, stdout: findJson(args[0]), stderr: "" };
    },
    // 真的視窗下一次變更才回來；測試用「重開一個 Town」取代等檔案變更。
    watchFolder: () => new Promise(() => {}),
  }));

  return { home: root, read: (file) => readFile(file) };
}

/**
 * `Town` 的 `cx`：只實作 mod 用到的三件事（spawn／notify／timer）。
 * `spawn` 的 promise 留著，`settle()` 可以等它們跑完；`timer.after` 不排程（測試不驗時間）。
 */
export function makeCx() {
  const cx = {
    notifies: 0,
    waiters: [],
    running: new Set(),
    spawn(run) {
      const promise = Promise.resolve()
        .then(() => run(cx))
        .catch((error) => { cx.error = error; })
        .finally(() => cx.running.delete(promise));
      cx.running.add(promise);
      return promise;
    },
    notify() {
      cx.notifies += 1;
      for (const resolve of cx.waiters.splice(0)) resolve();
    },
    timer: { every() {}, after() {} },
  };
  return cx;
}

/** 等到 `predicate()` 成立（預設 2 秒）；不成立就把目前畫面文字一起丟出來，不必猜哪裡卡住。 */
export async function waitFor(predicate, { timeout = 2000, describe = () => "" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到預期狀態。${describe()}`);
    await Bun.sleep(5);
  }
}

/** 樹裡的所有文字，依畫面順序。 */
export function texts(node) {
  const out = [];
  const walk = (current) => {
    if (typeof current === "string") {
      out.push(current);
      return;
    }
    if (current === null || current === undefined || typeof current !== "object") return;
    if (typeof current.props?.child === "string") out.push(current.props.child);
    if (!Array.isArray(current.kids)) return;
    for (const kid of current.kids) walk(kid);
  };
  walk(node);
  return out;
}

/** 樹裡的文字接成一行，方便 `toContain` 比對順序（例如「共用倉庫|12|木材」）。 */
export function text(node) {
  return texts(node).join("|");
}

/** 依 id 找節點（`root`、`city-panel`、`detail`、`map-3--2`…）。 */
export function findById(node, id) {
  let hit = null;
  walkTree(node, (current) => {
    if (!hit && current.props?.id === id) hit = current;
  });
  return hit;
}

/**
 * 找「按下去會做那件事」的節點：子樹文字包含 `needle`，而且自己收了點擊。
 * chipButton 的文字包在內層 div，所以要比對整棵子樹而不是節點自己的 child。
 */
export function findByText(node, needle) {
  let hit = null;
  walkTree(node, (current) => {
    if (hit || !current.handlers?.click) return;
    if (texts(current).some((line) => line.includes(needle))) hit = current;
  });
  return hit;
}

/** 所有收左鍵按下的地圖格（`cellBox` 的 id 是 `map-x-y`）。 */
export function mapTiles(node) {
  const out = [];
  walkTree(node, (current) => {
    const id = current.props?.id;
    if (current.handlers?.mouseDown?.left && typeof id === "string" && id.startsWith("map-")) out.push(current);
  });
  return out;
}

/** 模擬 pan 尺寸變化：呼叫 root 的 `on_size_change`，等同真的拉動 pane。 */
export function resize(node, { width, height }, cx) {
  const root = findById(node, "root");
  if (!root?.handlers?.size) throw new Error("root 沒有 on_size_change：畫面沒有回報尺寸");
  root.handlers.size({ width, height }, cx);
}

function walkTree(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkTree(item, visit);
    return;
  }
  visit(node);
  if (!Array.isArray(node.kids)) return;
  for (const kid of node.kids) walkTree(kid, visit);
}

/** 帳本在測試 home 的位置（等同 mod 執行時 `openShared` 開的那一份）。 */
export const ledgerDir = (home) => sharedCityDir(adapterRoot(home));

/** 直接寫一筆共用城市的帳本 entry（同一份 CAS 語意，見 `test/fs-io.js`）。 */
export async function submitOp(home, makeOp) {
  const ledger = await new CityLedger({ io: createFileIo(), dir: ledgerDir(home), cityId: SHARED_CITY_ID }).open();
  return ledger.submit(makeOp);
}

/** 讀回帳本狀態（庫存、建築、唯一的建設目標）。 */
export async function ledgerState(home) {
  return new CityLedger({ io: createFileIo(), dir: ledgerDir(home), cityId: SHARED_CITY_ID }).open().then((ledger) => ledger.state());
}
