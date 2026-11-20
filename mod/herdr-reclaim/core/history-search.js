// 歷程搜尋的查詢狀態機（§12）：畫面與測試共用同一段事件處理，搜尋不再只能在 render 裡猜。
//
// 修掉的兩個可見缺陷（QA 在真 UI 上遇到）：
//   * 資料還沒載入完就送出查詢，會安靜地得到 0 筆，載入完成後也不會重算 → 載入完成時若有查詢就重跑。
//   * 送出只綁在輸入框的 submit 事件（鍵名依平台而異）→ 加上 Enter／Return／NumpadEnter 的
//     keydown 判斷與畫面上的「搜尋」按鈕，三條路都走同一個 `historySubmitted`。
//
// 純函式、沒有 host API：`herdr-app check` 與 bun 測試都直接跑這一段。
import { searchHistory } from "./history.js";

/** 沒有查詢結果以前的資料來源（records／tiles／未解析活動／城名）。 */
export function emptyHistoryData() {
  return { records: [], tiles: [], unresolvedActivities: [], cityNames: {} };
}

/** 打開面板：先顯示「讀取中」，不要讓使用者以為已經搜過。 */
export function historyOpened() {
  return {
    open: true,
    query: "",
    submitted: "",
    results: [],
    total: 0,
    loading: true,
    loaded: false,
    error: null,
    data: emptyHistoryData(),
  };
}

/**
 * 資料載入完成。已經打好的查詢會立刻重跑一次，所以「先打字、後載入」不會停在 0 筆。
 */
export function historyLoaded(state, data) {
  const next = {
    ...state,
    data: { ...emptyHistoryData(), ...(data ?? {}) },
    loading: false,
    loaded: true,
    error: null,
  };
  return String(next.query ?? "").trim() ? historySubmitted(next) : next;
}

export function historyLoadFailed(state, error) {
  return { ...state, loading: false, loaded: false, error: `歷程讀取失敗：${error}`, results: [], total: 0 };
}

/** 輸入框內容改變：只更新查詢字串，不急著搜尋（查詢成本隨紀錄數成長）。 */
export function historyChanged(state, value) {
  return { ...state, query: String(value ?? "") };
}

/** 送出查詢（Enter／Return／NumpadEnter 或「搜尋」按鈕都走這裡）。 */
export function historySubmitted(state, value) {
  const query = String(value ?? state.query ?? "");
  try {
    const found = searchHistory({ ...emptyHistoryData(), ...state.data, query });
    return { ...state, query, submitted: query, results: found.results, total: found.total, error: null };
  } catch (error) {
    return { ...state, query, submitted: query, results: [], total: 0, error: `搜尋失敗：${error}` };
  }
}

/** 跳格的結果被點走之後：面板關掉、資料留著，下次開同一份不用再讀一次帳本。 */
export function historyJumped(state) {
  return { ...state, open: false };
}

/**
 * 這是不是「送出搜尋」的鍵。平台的鍵名不一致（macOS 的主 Enter 常被寫成 Return，
 * GPUI 的 keystroke 是 "enter"），所以 key 與 keystroke 都認。
 */
export function isSubmitKeystroke(event) {
  if (!event) return false;
  if (["Enter", "Return", "NumpadEnter"].includes(String(event.key ?? ""))) return true;
  const keystroke = String(event.keystroke ?? "").toLowerCase();
  return keystroke === "enter" || keystroke === "return" || keystroke === "numpadenter";
}

/** 面板上方那一行狀態：載入中、錯誤、或查詢筆數都要看得見（不放在會被捲掉的底部）。 */
export function historyStatusLine(state) {
  if (!state) return "";
  if (state.loading) return "正在讀取歷程紀錄…";
  if (state.error) return state.error;
  if (!state.loaded) return "還沒有讀到歷程紀錄";
  const count = (state.data?.records?.length ?? 0);
  const submitted = String(state.submitted ?? "").trim();
  return submitted
    ? `${state.total} 筆符合「${submitted}」 · 共 ${count} 筆紀錄`
    : `共 ${count} 筆紀錄 · 輸入查詢後按 Enter 或「搜尋」`;
}
