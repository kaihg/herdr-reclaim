// 內容檔與索引分頁的容量驗收（ticket #4 AC2、AC4 的儲存層）。
//
// 驗證的是使用者可觀察的結果：檔案大小、讀回來的內容與順序、查得到每一筆。
// 這兩個模組是純 JS（io 由呼叫端給），mod runtime 用的是同一支程式。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { BlobStore, splitToLeaves } from "../core/blobs.js";
import { PrefixIndex } from "../core/pages.js";
import { byteLen } from "../core/bytes.js";
import { CasConflict } from "../core/cas.js";
import { createFileIo } from "./fs-io.js";

const LIMIT = 256 * 1024;
const dirOf = (name) => `/tmp/reclaim-4-blobs/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

/** 一個「改了兩萬個路徑」的成果內容：跟 S3 spike 用的是同一個量級。 */
function twentyThousandPaths() {
  return Array.from({ length: 20_000 }, (_, i) => ({
    path: `src/路徑-${i}.ts`,
    resultBlob: `blob-${i.toString(16)}`,
    claim: `claim-${i}`,
  }));
}

function sizesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push({ path: path.slice(dir.length + 1), bytes: fs.statSync(path).size });
    }
  };
  walk(dir);
  return out;
}

/**
 * 資料頁都 ≤ limit；根頁是固定大小的入口（列出最多 256 個前綴），不隨資料量成長。
 */
function expectBounded(dir, limit) {
  for (const size of sizesUnder(dir)) {
    if (size.path === "root.json") expect(size.bytes).toBeLessThanOrEqual(2048);
    else expect(size.bytes).toBeLessThan(limit);
  }
}

describe("內容檔：切塊與多層 manifest", () => {
  test("兩萬個路徑的內容切塊後完整讀回，內容與順序都不變", async () => {
    const dir = dirOf("roundtrip");
    const store = new BlobStore({ io: createFileIo(), dir, limit: LIMIT });
    const paths = twentyThousandPaths();
    const text = JSON.stringify(paths);

    const written = await store.putText(text);
    expect(written.chunked).toBe(true); // 原始內容遠大於單檔上限
    expect(written.bytes).toBeGreaterThan(LIMIT);
    expect(written.bytes).toBe(byteLen(text));

    expect(await store.getText(written.hash)).toBe(text); // 位元組與順序都一樣
    expect(await store.getValue(written.hash)).toEqual(paths);
    expectBounded(dir, LIMIT);
  });

  test("讀回的是內容，不是 manifest（S3 spike 的失敗：2.4 MB 讀成 369 bytes）", async () => {
    const dir = dirOf("not-manifest");
    const store = new BlobStore({ io: createFileIo(), dir, limit: LIMIT });
    const paths = twentyThousandPaths();
    const text = JSON.stringify(paths);
    const written = await store.putText(text);

    const root = JSON.parse(fs.readFileSync(`${dir}/${written.hash}.json`, "utf8"));
    expect(root.t).toBe("m"); // 最上層是 manifest
    expect(root.n).toBe(byteLen(text));
    const read = await store.getText(written.hash);
    expect(byteLen(read)).toBe(byteLen(text));
    expect(read).not.toBe(JSON.stringify(root)); // 不是把 manifest 當成內容回傳
    expect(JSON.parse(read)).toHaveLength(20_000);
    // 每一個檔案都是合法的內容檔（leaf 或 manifest），沒有第二種格式混進來。
    for (const size of sizesUnder(dir)) {
      const doc = JSON.parse(fs.readFileSync(`${dir}/${size.path}`, "utf8"));
      expect(["l", "m"]).toContain(doc.t);
    }
  });

  test("單檔上限很小時仍然完整讀回：manifest 自己也會分層", async () => {
    const dir = dirOf("layered");
    const store = new BlobStore({ io: createFileIo(), dir, limit: 1024 });
    const text = JSON.stringify(twentyThousandPaths());
    const written = await store.putText(text);

    expect(written.depth).toBeGreaterThan(1); // 多層 manifest
    expect(await store.getText(written.hash)).toBe(text);
    expectBounded(dir, 1024);
  });

  test("同樣的內容只寫一次：重送沿用同一份檔案", async () => {
    const dir = dirOf("idempotent");
    const io = createFileIo();
    const store = new BlobStore({ io, dir, limit: LIMIT });
    const first = await store.putValue({ events: [{ eventSeq: 1, kind: "interval_open" }] });
    const again = await store.putValue({ events: [{ eventSeq: 1, kind: "interval_open" }] });

    expect(again.hash).toBe(first.hash);
    expect(sizesUnder(dir)).toHaveLength(1);
  });

  test("emoji 落在片段邊界時仍完整讀回：切點不會落在代理對中間", async () => {
    const dir = dirOf("surrogate");
    const store = new BlobStore({ io: createFileIo(), dir, limit: 1024 });
    // 999 個 ASCII ＋ 一個 emoji ＋ 100 個 ASCII：emoji 剛好跨過 1 KiB 的片段邊界
    // （舊版的 takeEscaped 先 index++ 才檢查預算，切點就落在高低代理之間）。
    const text = `${"a".repeat(999)}😀${"b".repeat(100)}`;
    const written = await store.putText(text);
    expect(written.chunked).toBe(true);
    expect(await store.getText(written.hash)).toBe(text);
    expectBounded(dir, 1024);

    // 每一個邊界位置都成立：emoji 在片段裡的任何位置，切點都不切開它。
    const limit = 64;
    const budget = limit - 24;
    for (let offset = 0; offset <= 40; offset++) {
      const sample = `${"a".repeat(offset)}😀${"z".repeat(60 - offset)}`;
      const pieces = splitToLeaves(sample, limit);
      expect(pieces.join("")).toBe(sample);
      for (const piece of pieces) {
        expect(byteLen(piece)).toBeLessThanOrEqual(budget);
        // 片段結尾不會留著代理對的前半，開頭也不會是後半。
        const last = piece.charCodeAt(piece.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        const first = piece.charCodeAt(0);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      }
    }
  });

  test("byteLen 不會讓不成對的代理吃掉下一個字元", () => {
    expect(byteLen("😀")).toBe(4);
    expect(byteLen("\ud800a")).toBe(4); // 不成對的高代理 3 + "a" 1
    expect(byteLen("\udc00a")).toBe(4);
    expect(byteLen("a\ud800")).toBe(4);
  });

  test("兩個 pane 同時建立同一份內容：輸家沿用贏家的檔案，不會讓讀城失敗", async () => {
    const dir = dirOf("create-race");
    const base = createFileIo();
    let raced = false;
    const io = {
      read: (file) => base.read(file),
      // 模擬另一個 pane 搶先在 expected=null 建立同一個內容檔：真的寫入，再回報「已經存在」。
      async write(file, text, expected) {
        if (!raced && expected === null) {
          raced = true;
          await base.write(file, text, null);
          throw new CasConflict(file, "exists");
        }
        return base.write(file, text, expected);
      },
    };
    const store = new BlobStore({ io, dir, limit: LIMIT });
    const value = { events: [{ eventSeq: 1, kind: "interval_open" }] };

    const written = await store.putValue(value);
    expect(raced).toBe(true);
    expect(await store.getValue(written.hash)).toEqual(value);
  });
});

describe("索引頁：寫滿就延長前綴，每一筆都查得回來", () => {
  test("一萬筆在 1 KiB 的頁面上限下拆分，每一筆都查得到", async () => {
    const dir = dirOf("pages-large");
    const index = new PrefixIndex({ io: createFileIo(), dir, limit: 1024 });
    const entries = new Map(Array.from({ length: 10_000 }, (_, i) => [`claim-${i}`, i]));

    await index.build([...entries]);
    const markers = sizesUnder(dir).filter((file) => JSON.parse(fs.readFileSync(`${dir}/${file.path}`, "utf8")).t === "s");
    expect(markers.length).toBeGreaterThan(0); // 真的拆過

    for (const [key, value] of entries) expect(await index.get(key)).toBe(value);
    expect(await index.get("沒有這一筆")).toBeNull();

    const all = await index.all();
    expect(all.size).toBe(entries.size);
    for (const [key, value] of entries) expect(all.get(key)).toBe(value);
    expectBounded(dir, 1024);
  });

  test("增量新增也會拆分：先放幾筆，再一筆一筆加到超過一頁", async () => {
    const dir = dirOf("pages-incremental");
    const index = new PrefixIndex({ io: createFileIo(), dir, limit: 512 });

    for (let i = 0; i < 400; i++) await index.put(`op-${i}`, `seq-${i}`);
    for (let i = 0; i < 400; i++) expect(await index.get(`op-${i}`)).toBe(`seq-${i}`);

    // 更新既有鍵：值換掉，鍵不會消失。
    await index.put("op-7", "seq-7-new");
    expect(await index.get("op-7")).toBe("seq-7-new");
    expect((await index.all()).size).toBe(400);
    expectBounded(dir, 512);
  });
});
