// CAS 接縫：什麼叫「快照不符」，以及怎麼重試（proposal §13.1）。
//
// 這一支是帳本、分頁索引與 host 適配層共用的最小介面：`read`／`write(path, text, expected)`
// 兩個函式的儲存層，衝突一律是 `CasConflict`，其他錯誤原樣往上丟。

/**
 * 快照不符：呼叫端要重讀、重新檢查前提、再試（§13.1）。
 * `kind`：`"stale"`＝指定的 `expected` 已經不是現在的內容；`"exists"`＝要建立的新檔已經有了。
 */
export class CasConflict extends Error {
  constructor(path, kind = "stale") {
    super(kind === "exists" ? `檔案已經存在：${path}` : `快照已過期：${path}`);
    this.name = "CasConflict";
    this.kind = kind;
    this.path = path;
  }
}

/** 真實 host 的 CAS 衝突訊息；host 的錯誤只有 message，所以這是主要線索。 */
const HOST_CONFLICT = /changed outside Herdr|Reload before saving/i;

/**
 * 把儲存層的錯誤認成 `CasConflict`（回傳它），或回 null（不是 CAS 衝突，呼叫端原樣丟出）。
 *
 * 兩個線索互補：host 的訊息說「這是衝突」（`herdr.writeTextFile` 的錯誤只有 message 欄位，
 * 建立既有檔案／過期更新／對不存在的檔案指定 expected 都是同一句）；實際內容與 `expected`
 * 的關係決定是哪一種衝突。`current` 由呼叫端重讀後傳進來（讀不到就傳 undefined，只看訊息）。
 */
export function casConflictOf(error, { path, expected, current } = {}) {
  const byMessage = HOST_CONFLICT.test(String(error?.message ?? ""));
  const byContent = expected === null ? current != null : current !== undefined && current !== expected;
  if (!byMessage && !byContent) return null;
  return new CasConflict(path, expected === null ? "exists" : "stale");
}

/** 只有 CAS 衝突可以重試；其他錯誤原樣丟出，不要吞掉。 */
export function rejectUnlessConflict(error) {
  if (!(error instanceof CasConflict)) throw error;
}

/**
 * CAS-upsert：內容已經一樣就沿用，否則用讀到的快照當 `expected` 寫回去；
 * 被別人插隊就重讀再試。衍生資料（checkpoint 的每一頁）都走這裡，所以
 * 「重做同一個 checkpoint」「兩個視窗同時做 checkpoint」都不會失敗。
 */
export async function casWrite(io, path, text, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const expected = await io.read(path);
    if (expected === text) return;
    try {
      await io.write(path, text, expected);
      return;
    } catch (error) {
      rejectUnlessConflict(error);
    }
  }
  throw new CasConflict(path);
}


