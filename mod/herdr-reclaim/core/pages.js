// 可延長前綴的雜湊分頁（proposal §13.1 索引，ticket #4）。
//
// 一個索引就是一堆有上限的頁面，加上一個固定大小的根頁：
//   root.json            {"t":"s","l":2,"c":["ab","cd",...]}   有資料的前 2 碼（最多 256 個）
//   <prefix>.json        {"t":"e","e":{key:value,...}}        資料頁
//                  或    {"t":"s","l":len+1,"c":[...]}        拆分標記，往下一層找
//
// **查詢不需要列出目錄**：herdr 的 mod 只有 `readTextFile`／`writeTextFile`，沒有 listdir，所以
// 走訪一律靠根頁與拆分標記自己記的子前綴，而不是掃資料夾。層數隨資料量對數成長，
// 每一頁都在上限內（頁面寫滿就拆成前綴更長的子頁面）。
//
// 拆分的規則是「先收集這個前綴底下的所有鍵，再從上往下重寫子樹」：舊的子頁面留在檔案系統裡，
// 但不再被任何標記列到，因此查詢與走訪都不會讀到它們（帳本沒有刪檔案的 API）。
import { byteLen, hashText } from "./bytes.js";
import { casWrite } from "./cas.js";

export const PAGE_LIMIT = 256 * 1024;

export class PrefixIndex {
  /**
   * @param {object} options
   * @param {{ read(path: string): Promise<string|null>, write(path: string, text: string, expected: string|null): Promise<void> }} options.io
   * @param {string} options.dir 這個索引的目錄
   * @param {number} [options.limit] 每一頁的位元組上限
   * @param {number} [options.startLen] 根頁列出的前綴長度（hex 字元數）
   * @param {(key: string) => string} [options.hash] 鍵 → hex 字串
   */
  constructor({ io, dir, limit = PAGE_LIMIT, startLen = 2, hash = hashText }) {
    this.io = io;
    this.dir = dir;
    this.limit = limit;
    this.startLen = startLen;
    this.hash = hash;
    this.maxLen = hash("").length;
  }

  rootPath() {
    return `${this.dir}/root.json`;
  }

  pagePath(prefix) {
    return `${this.dir}/${prefix}.json`;
  }

  /** 一次查詢：從根頁列出的前 2 碼開始，遇到拆分標記就往下一層。 */
  async get(key) {
    const root = await this.readPage(this.rootPath());
    if (!root || !root.c?.length) return null;
    const hex = this.hash(key);
    let prefix = hex.slice(0, this.startLen);
    if (!root.c.includes(prefix)) return null;
    for (let len = this.startLen; len <= this.maxLen; len++) {
      const page = await this.readPage(this.pagePath(prefix));
      if (!page) return null;
      if (page.t === "e") return Object.hasOwn(page.e, key) ? page.e[key] : null;
      if (page.t !== "s") throw new Error(`不是索引頁：${prefix}`);
      if (len === this.maxLen) throw new Error(`索引太深：${prefix}`);
      prefix = hex.slice(0, len + 1);
      if (!page.c?.includes(prefix)) return null;
    }
    return null;
  }

  /** 增量新增／更新一筆（單一寫入者）：只重寫這個前綴底下的子樹。 */
  async put(key, value) {
    const root = (await this.readPage(this.rootPath())) ?? { t: "s", l: this.startLen, c: [] };
    const prefix = this.hash(key).slice(0, this.startLen);
    const entries = root.c.includes(prefix) ? await this.collect(prefix) : new Map();
    entries.set(key, value);
    await this.writeSubtree(prefix, this.startLen, entries);
    const children = new Set(root.c);
    children.add(prefix);
    await this.writeRoot([...children].sort());
  }

  /**
   * 整批重建（checkpoint 用；不常發生，所以一次寫好每一頁）。
   * 回傳 `digest`：這一組頁面（根頁＋每一頁）的內容摘要，寫進 checkpoint manifest，
   * 載入時用來確認「頁面內容沒有被改過」（筆數不變但內容被換掉也要看得出來）。
   */
  async build(entries) {
    const groups = new Map();
    for (const [key, value] of entries) {
      const prefix = this.hash(key).slice(0, this.startLen);
      const group = groups.get(prefix) ?? new Map();
      group.set(key, value);
      groups.set(prefix, group);
    }
    const prefixes = [...groups.keys()].sort();
    const chain = [];
    for (const prefix of prefixes) chain.push(...await this.writeSubtree(prefix, this.startLen, groups.get(prefix)));
    chain.push(`root:${await this.writeRoot(prefixes)}`);
    return { pages: await this.countPages(), keys: [...entries].length, digest: digestOfPages(chain) };
  }

  /**
   * 索引裡的全部資料（走訪靠根頁與拆分標記，不列目錄），同時算出**內容摘要**。
   *
   * `strict`：遇到「根頁／拆分標記列到、檔案卻不在」就報錯。checkpoint 這種衍生索引
   * 壞掉時必須看得見（否則缺頁會被當成「沒有資料」，庫存與去重資料靜靜地少掉）。
   * `digest` 的定義與 `build()` 一致：把每一頁的「前綴:內容雜湊」排序後串起來再雜湊，
   * 所以任何一頁的內容、多一頁少一頁都會讓摘要不同。
   */
  async scan({ strict = false } = {}) {
    const rootText = await this.io.read(this.rootPath());
    if (rootText === null) {
      if (strict) throw new Error(`索引根頁不見了：${this.rootPath()}`);
      return { entries: new Map(), digest: digestOfPages([]) };
    }
    const chain = [`root:${hashText(rootText)}`];
    const entries = new Map();
    const walk = async (prefix) => {
      const text = await this.io.read(this.pagePath(prefix));
      if (text === null) {
        if (strict) throw new Error(`索引頁不見了：${this.pagePath(prefix)}`);
        return;
      }
      chain.push(`${prefix}:${hashText(text)}`);
      const page = JSON.parse(text);
      if (page.t === "e") {
        for (const [key, value] of Object.entries(page.e)) entries.set(key, value);
        return;
      }
      if (page.t !== "s") throw new Error(`不是索引頁：${prefix}`);
      for (const child of page.c ?? []) await walk(child);
    };
    for (const prefix of JSON.parse(rootText)?.c ?? []) await walk(prefix);
    return { entries, digest: digestOfPages(chain) };
  }

  /** 索引裡的全部資料（走訪靠根頁與拆分標記，不列目錄）。 */
  async all(options = {}) {
    return (await this.scan(options)).entries;
  }

  /** 一個前綴底下的所有資料。 */
  async collect(prefix, { strict = false } = {}) {
    const page = await this.readPage(this.pagePath(prefix));
    const out = new Map();
    if (!page) {
      if (strict) throw new Error(`索引頁不見了：${this.pagePath(prefix)}`);
      return out;
    }
    if (page.t === "e") {
      for (const [key, value] of Object.entries(page.e)) out.set(key, value);
      return out;
    }
    if (page.t !== "s") throw new Error(`不是索引頁：${prefix}`);
    for (const child of page.c ?? []) {
      for (const [key, value] of await this.collect(child, { strict })) out.set(key, value);
    }
    return out;
  }

  /**
   * 把 `entries` 寫成 `prefix` 這一頁；放不下就照下一個 hex 字元分組，往下收一層。
   * 超過最大前綴長度還是放不下時直接報錯，不寫出超過上限的頁面。
   */
  async writeSubtree(prefix, len, entries) {
    const text = JSON.stringify({ t: "e", e: Object.fromEntries(entries) });
    if (byteLen(text) < this.limit) {
      return [`${prefix}:${await this.writePage(this.pagePath(prefix), { t: "e", e: Object.fromEntries(entries) })}`];
    }
    if (len >= this.maxLen) throw new Error(`索引頁超過上限（${byteLen(text)} >= ${this.limit}）：${prefix}`);
    const groups = new Map();
    for (const [key, value] of entries) {
      const child = this.hash(key).slice(0, len + 1);
      const group = groups.get(child) ?? new Map();
      group.set(key, value);
      groups.set(child, group);
    }
    const children = [...groups.keys()].sort();
    const chain = [];
    for (const child of children) chain.push(...await this.writeSubtree(child, len + 1, groups.get(child)));
    chain.push(`${prefix}:${await this.writePage(this.pagePath(prefix), { t: "s", l: len + 1, c: children })}`);
    return chain;
  }

  async readPage(path) {
    const text = await this.io.read(path);
    return text === null ? null : JSON.parse(text);
  }

  /**
   * 頁面是衍生資料：用 CAS-upsert 寫，另一個寫入者剛好也在寫同一頁時重讀再寫。
   * 已經有同樣的內容就直接沿用（重做同一個 checkpoint 不會失敗）。
   */
  async writePage(path, page) {
    const text = JSON.stringify(page);
    if (byteLen(text) >= this.limit) throw new Error(`索引頁超過上限（${byteLen(text)} >= ${this.limit}）：${path}`);
    await casWrite(this.io, path, text);
    return hashText(text);
  }

  /**
   * 根頁是**固定大小**的入口：列出的前綴最多 `16 ** startLen` 個（startLen = 2 時 256 個，
   * 約 1.3 KiB），所以它不隨資料量成長，也不受單頁上限約束；仍然留一道 256 KiB 的保險。
   */
  async writeRoot(prefixes) {
    const text = JSON.stringify({ t: "s", l: this.startLen, c: prefixes });
    if (byteLen(text) > PAGE_LIMIT) throw new Error(`索引根頁超過 256 KiB：${this.rootPath()}`);
    await casWrite(this.io, this.rootPath(), text);
    return hashText(text);
  }

  /** 這個索引目前有幾個頁面（測試與統計用）。 */
  async countPages() {
    const root = await this.readPage(this.rootPath());
    let pages = root ? 1 : 0;
    const walk = async (prefix) => {
      const page = await this.readPage(this.pagePath(prefix));
      pages++;
      for (const child of page?.c ?? []) await walk(child);
    };
    for (const prefix of root?.c ?? []) await walk(prefix);
    return pages;
  }
}

/** 一組頁面的內容摘要：把「前綴:內容雜湊」排序後串起來再雜湊一次（與走訪順序無關）。 */
function digestOfPages(chain) {
  return hashText([...chain].sort().join("|"));
}
