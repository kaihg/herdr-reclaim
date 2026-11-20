// 儲存介面的 host 適配層：把 herdr 的檔案 API 包成帳本要的 `{ read, write }`。
//
// 只有一件事要在這裡做對：**真實 host 的 CAS 衝突是原生 `Error`**（沒有 code、沒有 kind，
// 只有 message），而帳本只認 `CasConflict`。三種衝突形狀——建立既有的檔案、過期更新、
// 對不存在的檔案指定 expected——在 herdr 0.1.16 都是同一句：
//   `herdr.writeTextFile`: The file changed outside Herdr. Reload before saving; your draft is still here.
// 所以判準是「訊息像衝突」**加上**「重讀之後內容真的和 expected 不符」（見 casConflictOf）；
// 兩個都不成立就原樣丟出，不吞掉權限之類的錯誤。
//
// 這一支是純 JS（host 的兩個函式由 main.js 餵進來），所以 bun 測試可以用假 host 直接測這個接縫。
import { casConflictOf } from "./ledger.js";

/**
 * @param {{ readTextFile: (path: string) => Promise<string|null>, writeTextFile: (path: string, text: string, expected: string|null) => Promise<unknown> }} host
 */
export function hostIo(host) {
  const read = async (path) => host.readTextFile(path);
  return {
    read,
    async write(path, text, expected) {
      try {
        await host.writeTextFile(path, text, expected);
      } catch (error) {
        let current;
        try {
          current = await read(path);
        } catch {
          current = undefined; // 連重讀都失敗：只靠 host 的訊息判斷
        }
        throw casConflictOf(error, { path, expected, current }) ?? error;
      }
    },
  };
}
