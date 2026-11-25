// 畫面自己的狀態：選取與開發模式。不是共用城市的帳本的一部分。
//
// 決策（ticket #3）：選取不寫進帳本。它不產生資源、不改變土地，寫進 append-only 的帳本
// 只會讓帳本多出純 UI 噪音，並讓「重播 = 同一座城」的驗證多一個無關變數。改存在 mod 資料
// 目錄下的小檔案（ui.json）；重開 herdr 後還原同一個選取。
//
// 共用城市只有一張地圖（#22：舊版各 repo 城的指揮桌已移除），選取就是地圖上的一格。

export const UI_SCHEMA = 1;

export function emptyUi() {
  return { schema: UI_SCHEMA, selections: {}, dev: false };
}

export function parseUi(text) {
  if (!text) return emptyUi();
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !data.selections || typeof data.selections !== "object") return emptyUi();
    return { schema: UI_SCHEMA, selections: data.selections, dev: data.dev === true };
  } catch {
    return emptyUi(); // 壞掉的 UI 檔不影響城市，回到預設選取
  }
}

export function withSelection(ui, cityId, selection) {
  return { ...ui, schema: UI_SCHEMA, selections: { ...ui.selections, [cityId]: selection } };
}

/** 開發模式（顯示工程資訊）也是畫面自己的狀態，跟選取放在同一個檔案。 */
export function withDev(ui, dev) {
  return { ...ui, schema: UI_SCHEMA, dev: dev === true };
}

export function selectionOf(ui, cityId) {
  return ui?.selections?.[cityId] ?? null;
}

export function serializeUi(ui) {
  return `${JSON.stringify(ui)}\n`;
}
