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

  /** 整批重建（checkpoint 用；不常發生，所以一次寫好每一頁）。 */
  async build(entries) {
    const groups = new Map();
    for (const [key, value] of entries) {
      const prefix = this.hash(key).slice(0, this.startLen);
      const group = groups.get(prefix) ?? new Map();
      group.set(key, value);
      groups.set(prefix, group);
    }
    const prefixes = [...groups.keys()].sort();
    for (const prefix of prefixes) await this.writeSubtree(prefix, this.startLen, groups.get(prefix));
    await this.writeRoot(prefixes);
    return { pages: await this.countPages(), keys: [...entries].length };
  }

  /** 索引裡的全部資料（走訪靠根頁與拆分標記，不列目錄）。 */
  async all() {
    const root = await this.readPage(this.rootPath());
    const out = new Map();
    for (const prefix of root?.c ?? []) {
      for (const [key, value] of await this.collect(prefix)) out.set(key, value);
    }
    return out;
  }

  /** 一個前綴底下的所有資料。 */
  async collect(prefix) {
    const page = await this.readPage(this.pagePath(prefix));
    const out = new Map();
    if (!page) return out;
    if (page.t === "e") {
      for (const [key, value] of Object.entries(page.e)) out.set(key, value);
      return out;
    }
    if (page.t !== "s") throw new Error(`不是索引頁：${prefix}`);
    for (const child of page.c ?? []) {
      for (const [key, value] of await this.collect(child)) out.set(key, value);
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
      await this.writePage(this.pagePath(prefix), { t: "e", e: Object.fromEntries(entries) });
      return;
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
    for (const child of children) await this.writeSubtree(child, len + 1, groups.get(child));
    await this.writePage(this.pagePath(prefix), { t: "s", l: len + 1, c: children });
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
  }

  /**
   * 根頁是**固定大小**的入口：列出的前綴最多 `16 ** startLen` 個（startLen = 2 時 256 個，
   * 約 1.3 KiB），所以它不隨資料量成長，也不受單頁上限約束；仍然留一道 256 KiB 的保險。
   */
  async writeRoot(prefixes) {
    const text = JSON.stringify({ t: "s", l: this.startLen, c: prefixes });
    if (byteLen(text) > PAGE_LIMIT) throw new Error(`索引根頁超過 256 KiB：${this.rootPath()}`);
    await casWrite(this.io, this.rootPath(), text);
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
