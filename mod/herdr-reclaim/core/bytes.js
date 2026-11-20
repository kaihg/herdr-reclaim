// 純文字工具：內容雜湊、UTF-8 長度與穩定序列化（ticket #4）。
//
// 這一支不碰任何 host API，也不 import 其他 core 模組：blobs.js、pages.js、ledger.js 都用它，
// 帳本再把它轉出去（`export { byteLen, hashText }`），所以舊的 import 路徑不用改。

/** 內容雜湊：FNV-1a 的兩段 32 位，換成 16 個十六進位字元。 */
export function hashText(text) {
  let low = 0x811c9dc5;
  let high = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ (code & 0xff), 0x01000193) >>> 0;
    high = Math.imul(high ^ ((code >>> 8) & 0xff) ^ index, 0x01000193) >>> 0;
  }
  return low.toString(16).padStart(8, "0") + high.toString(16).padStart(8, "0");
}

/** UTF-8 長度，不配置暫存字串（跟 JavaScript 字串的碼元數不同）。 */
export function byteLen(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * 穩定序列化：物件的鍵排序，所以同一份值永遠得到同一份文字，內容雜湊才穩定。
 * 讀不回來的值（undefined、函式）不屬於帳本的一部分。
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}
