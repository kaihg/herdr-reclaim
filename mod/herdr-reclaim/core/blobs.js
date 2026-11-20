// 內容檔：以內容雜湊命名的分塊儲存（proposal §13.1 內容檔，ticket #4）。
//
// 契約：**這個儲存寫出的每一個檔案都 ≤ limit**（herdr 一次只讀 1 MiB，帳本自訂每檔 256 KiB）。
// 大型內容先依內容雜湊切成小塊，再寫一份 manifest 依序列出子節點；manifest 自己也超過上限時，
// 用同一套規則再分一層（fan-out 固定），所以層數隨資料量對數成長，每一層都還在限制內。
//
// 每個檔案是一行 JSON，型別寫在檔案裡，不靠檔名或階層猜：
//   leaf     {"t":"l","d":"<文字片段>"}
//   manifest {"t":"m","n":<原始位元組數>,"c":[{"h":<雜湊>,"t":"l"|"m","n":<位元組數>}, ...]}
// 讀取端從參考端帶著型別往下走，讀到的檔案型別不符就報錯——S3 spike 那個「manifest 被當成
// 內容回傳」的失敗（原始 2,428,891 bytes、讀回 369-byte manifest）因此不可能發生。
//
// 檔名是「檔案內容」的雜湊，所以同一份內容只寫一次；重試時直接沿用，不重寫。
import { byteLen, canonicalJson, hashText } from "./bytes.js";

export const BLOB_LIMIT = 256 * 1024;

/**
 * 一份 leaf 除了跳脫後的內容之外還要的字元數：`{"t":"l","d":`（13）＋ 內容的兩個引號（2）
 * ＋ `}`（1）＝ 16。留一點餘裕（24）讓每一份寫出的檔案都**嚴格小於**上限。
 */
const LEAF_OVERHEAD = 24;
/** manifest 一個子節點的保守大小：`{"h":"<16 hex>","t":"l","n":<n>},`。 */
const CHILD_BYTES = 56;
/** manifest 自己的固定開銷。 */
const MANIFEST_OVERHEAD = 64;

export class BlobStore {
  /**
   * @param {{ read(path: string): Promise<string|null>, write(path: string, text: string, expected: string|null): Promise<void> }} io
   * @param {string} dir 這個城的 `blobs/` 目錄
   * @param {number} limit 每個檔案的位元組上限
   */
  constructor({ io, dir, limit = BLOB_LIMIT }) {
    this.io = io;
    this.dir = dir;
    this.limit = limit;
  }

  path(hash) {
    return `${this.dir}/${hash}.json`;
  }

  async has(hash) {
    return (await this.io.read(this.path(hash))) !== null;
  }

  /** 寫入一份文字內容；回傳最上層的參考。所有寫出的檔案都 < limit。 */
  async putText(text) {
    const bytes = byteLen(text);
    const leaf = leafFile(text);
    if (byteLen(leaf) < this.limit) {
      const hash = await this.store(hashText(leaf), leaf);
      return { hash, chunked: false, bytes, files: 1, depth: 0 };
    }
    if (this.limit <= 2 * LEAF_OVERHEAD) throw new Error(`內容上限太小：${this.limit}`);
    const children = [];
    for (const piece of splitToLeaves(text, this.limit)) {
      const pieceLeaf = leafFile(piece);
      // 切塊的前提是每一片都放得進一個檔案：不放心的話寧可報錯，也不要寫出超限的檔案。
      if (byteLen(pieceLeaf) >= this.limit) throw new Error(`內容片段超過上限：${byteLen(pieceLeaf)}`);
      children.push({ h: await this.store(hashText(pieceLeaf), pieceLeaf), t: "l", n: byteLen(piece) });
    }
    const root = await this.manifest(children, bytes);
    return { hash: root.hash, chunked: true, bytes, files: root.files + children.length, depth: root.depth };
  }

  /** 寫入一份（可序列化的）值：先做穩定序列化再切塊。 */
  async putValue(value) {
    return this.putText(canonicalJson(value));
  }

  /** 讀回最上層雜湊代表的完整文字內容；位元組與順序都與寫入時相同。 */
  async getText(hash) {
    const text = await this.io.read(this.path(hash));
    if (text === null) throw new Error(`內容檔不見了：${hash}`);
    const doc = JSON.parse(text);
    if (doc?.t === "l") return String(doc.d ?? "");
    if (doc?.t !== "m") throw new Error(`不是內容檔：${hash}`);
    return this.reassemble({ h: hash, n: doc.n, t: "m" }, doc);
  }

  async getValue(hash) {
    return JSON.parse(await this.getText(hash));
  }

  /** 走完一份 manifest（子節點可能是另一份 manifest）。型別與位元組數都逐一核對。 */
  async reassemble(node, doc) {
    let out = "";
    let bytes = 0;
    for (const child of doc.c ?? []) {
      const childText = await this.io.read(this.path(child.h));
      if (childText === null) throw new Error(`內容檔不見了：${child.h}`);
      const childDoc = JSON.parse(childText);
      if (childDoc?.t !== child.t) throw new Error(`manifest 的子節點型別不符：${child.h}`);
      const part = child.t === "l" ? String(childDoc.d ?? "") : await this.reassemble(child, childDoc);
      if (byteLen(part) !== child.n) throw new Error(`內容對不起來：${child.h}`);
      out += part;
      bytes += child.n;
    }
    if (bytes !== node.n) throw new Error(`內容對不起來：${node.h}`);
    return out;
  }

  /** 已經有同樣的內容就不重寫（重試不會多寫檔案）。 */
  async store(hash, text) {
    if ((await this.io.read(this.path(hash))) === null) await this.io.write(this.path(hash), text, null);
    return hash;
  }

  /**
   * 一層 manifest；子節點太多、manifest 自己超過上限時，先分組再往上收一層。
   * 每一層的子節點數都由 fan-out 決定，所以層數是 O(log n)。
   */
  async manifest(children, totalBytes) {
    const fanout = Math.max(2, Math.floor((this.limit - MANIFEST_OVERHEAD) / CHILD_BYTES));
    if (children.length <= fanout) {
      const text = manifestFile(children, totalBytes);
      if (byteLen(text) >= this.limit) throw new Error(`manifest 超過上限：${byteLen(text)}`);
      const hash = await this.store(hashText(text), text);
      return { hash, bytes: totalBytes, files: 1, depth: 1 };
    }
    const parents = [];
    for (let index = 0; index < children.length; index += fanout) {
      const group = children.slice(index, index + fanout);
      const bytes = group.reduce((total, child) => total + child.n, 0);
      const node = await this.manifest(group, bytes);
      parents.push({ h: node.hash, t: "m", n: bytes });
    }
    const above = await this.manifest(parents, totalBytes);
    return { hash: above.hash, bytes: totalBytes, files: above.files + parents.length, depth: above.depth + 1 };
  }
}

function leafFile(text) {
  return `{"t":"l","d":${JSON.stringify(text)}}`;
}

function manifestFile(children, totalBytes) {
  return JSON.stringify({ t: "m", n: totalBytes, c: children });
}

/**
 * 把文字切成一片片「放得進一格 leaf」的片段。
 * 跳脫長度逐字元算（`"`、`\`、控制字元與不成對的代理會變長），所以不會切出超過上限的檔案，
 * 也不會切斷一對代理。
 */
export function splitToLeaves(text, limit) {
  const budget = limit - LEAF_OVERHEAD;
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    const end = takeEscaped(text, start, budget);
    if (end <= start) throw new Error(`內容上限太小，切不出一個片段：${limit}`);
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces.length ? pieces : [""];
}

/** 從 `start` 起最多能取幾個字元，使其 JSON 跳脫後的位元組數 ≤ budget。 */
function takeEscaped(text, start, budget) {
  let used = 0;
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    let size;
    if (code === 0x22 || code === 0x5c) size = 2; // " 與 \
    else if (code >= 0x08 && code <= 0x0d) size = 2; // \b \t \n \f \r
    else if (code < 0x20) size = 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size = 4;
        index++; // 代理對是一個字元
      } else size = 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) size = 6;
    else if (code < 0x80) size = 1;
    else if (code < 0x800) size = 2;
    else size = 3;
    if (used + size > budget) break;
    used += size;
    index++;
  }
  return index;
}
