// bun 測試用的儲存後端：node fs 模擬 herdr 的
// `writeTextFile(path, text, expected)`（expected 不符就拒絕，而且整段比較與替換不會被打斷）。
//
// 這一層只在測試裡；mod 載入的程式用 herdr 的 API，不碰 node。
import fs from "node:fs";
import path from "node:path";
import { StaleWrite } from "../core/ledger.js";

const readSync = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** 比較與替換在同一個 JS 時段內完成，所以兩個寫入者不會同時過關。 */
function swap(file, text, expected) {
  if (readSync(file) !== expected) throw new StaleWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, file);
}

/**
 * @param {object} [hooks]
 * @param {(file: string, expected: string|null) => Promise<void>} [hooks.beforeWrite]
 */
export function createFileIo(hooks = {}) {
  return {
    async read(file) {
      return readSync(file);
    },
    async write(file, text, expected) {
      if (hooks.beforeWrite) await hooks.beforeWrite(file, expected);
      swap(file, text, expected);
    },
  };
}
