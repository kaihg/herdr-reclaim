// S3 spike: 可延長前綴的雜湊分頁 (§13.1) — extendible-prefix hash pages.
//
// A page for prefix P lives at <dir>/<P>.json and is either
//   {"e":{key:value,...}}          an entry page (<= limit bytes), or
//   {"s":1,"l":<childLen>}         a split marker: look under prefixes one hex char longer.
// Queries start at `startLen` hex chars and descend while they keep meeting split markers, so
// the level count grows logarithmically with the data instead of any single page growing.
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, byteLen, readText } from "./cas";
import { hashOf } from "./content";

export interface PageBuildStats {
  pages: number;
  splits: number;
  maxDepth: number;
  maxPageBytes: number;
  maxPagePath: string;
  totalEntries: number;
}

type Page = { e: Record<string, string> } | { s: 1; l: number };

export class PrefixIndex {
  constructor(
    readonly dir: string,
    readonly limit = 256 * 1024,
    readonly startLen = 2,
    readonly maxLen = 48,
  ) {}

  fileFor(prefix: string): string {
    return path.join(this.dir, prefix + ".json");
  }

  readPage(prefix: string): Page | null {
    const t = readText(this.fileFor(prefix));
    return t === null ? null : (JSON.parse(t) as Page);
  }

  private writePage(prefix: string, page: Page): number {
    const text = JSON.stringify(page);
    const bytes = byteLen(text);
    if (bytes > this.limit) throw new Error(`page ${prefix} is ${bytes} > limit ${this.limit}`);
    atomicWrite(this.fileFor(prefix), text);
    return bytes;
  }

  /** Bulk build: group by prefix, write once per page (a checkpoint does this, not the hot path). */
  buildFrom(entries: Map<string, string>): PageBuildStats {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    const stats: PageBuildStats = {
      pages: 0,
      splits: 0,
      maxDepth: 0,
      maxPageBytes: 0,
      maxPagePath: "",
      totalEntries: entries.size,
    };
    const group = (map: Map<string, string>, len: number): Map<string, Map<string, string>> => {
      const out = new Map<string, Map<string, string>>();
      for (const [k, v] of map) {
        const p = hashOf(k).slice(0, len);
        (out.get(p) ?? out.set(p, new Map()).get(p)!).set(k, v);
      }
      return out;
    };
    const queue: { prefix: string; entries: Map<string, string>; len: number }[] = [];
    for (const [prefix, map] of group(entries, this.startLen)) queue.push({ prefix, entries: map, len: this.startLen });
    while (queue.length) {
      const { prefix, entries: map, len } = queue.pop()!;
      const payload: Record<string, string> = {};
      for (const k of [...map.keys()].sort()) payload[k] = map.get(k)!;
      const text = JSON.stringify({ e: payload });
      if (byteLen(text) <= this.limit || len >= this.maxLen) {
        const bytes = this.writePage(prefix, { e: payload });
        stats.pages++;
        stats.maxDepth = Math.max(stats.maxDepth, len);
        if (bytes > stats.maxPageBytes) {
          stats.maxPageBytes = bytes;
          stats.maxPagePath = this.fileFor(prefix);
        }
      } else {
        if (len + 1 > this.maxLen) throw new Error(`cannot split ${prefix} further`);
        this.writePage(prefix, { s: 1, l: len + 1 });
        stats.pages++;
        stats.splits++;
        stats.maxDepth = Math.max(stats.maxDepth, len + 1);
        for (const [childPrefix, childMap] of group(map, len + 1))
          queue.push({ prefix: childPrefix, entries: childMap, len: len + 1 });
      }
    }
    return stats;
  }

  get(key: string): string | undefined {
    const h = hashOf(key);
    for (let len = this.startLen; len <= this.maxLen; len++) {
      const page = this.readPage(h.slice(0, len));
      if (!page) return undefined;
      if ("s" in page) {
        if (page.l !== len + 1) throw new Error(`page ${h.slice(0, len)}: split points at ${page.l}, at depth ${len}`);
        continue;
      }
      return page.e[key] === undefined ? undefined : page.e[key];
    }
    throw new Error(`index descent exceeded maxLen for ${key}`);
  }

  /** Every key/value in the index (used to load a checkpoint). */
  all(): Map<string, string> {
    const out = new Map<string, string>();
    if (!fs.existsSync(this.dir)) return out;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const page = JSON.parse(readText(path.join(this.dir, name))!) as Page;
      if ("s" in page) continue;
      for (const [k, v] of Object.entries(page.e)) out.set(k, v);
    }
    return out;
  }

  /** Incremental upsert (single writer). Splits the page in place when it overflows. */
  put(key: string, value: string): void {
    const h = hashOf(key);
    for (let len = this.startLen; len <= this.maxLen; len++) {
      const prefix = h.slice(0, len);
      const page = this.readPage(prefix);
      if (page && "s" in page) continue;
      const payload = page ? { ...page.e } : {};
      payload[key] = value;
      const text = JSON.stringify({ e: Object.fromEntries(Object.entries(payload).sort()) });
      if (byteLen(text) <= this.limit || len >= this.maxLen) {
        this.writePage(prefix, { e: payload });
        return;
      }
      // split: write 16 children (only the ones with data), then the marker in place of the page
      const children = new Map<string, Map<string, string>>();
      for (const [k, v] of Object.entries(payload)) {
        const cp = hashOf(k).slice(0, len + 1);
        (children.get(cp) ?? children.set(cp, new Map()).get(cp)!).set(k, v);
      }
      for (const [cp, map] of children) {
        const childPayload: Record<string, string> = {};
        for (const k of [...map.keys()].sort()) childPayload[k] = map.get(k)!;
        const childText = JSON.stringify({ e: childPayload });
        if (byteLen(childText) <= this.limit) this.writePage(cp, { e: childPayload });
        else this.writePage(cp, { s: 1, l: len + 2 });
      }
      this.writePage(prefix, { s: 1, l: len + 1 });
      return;
    }
    throw new Error(`index descent exceeded maxLen for ${key}`);
  }
}
