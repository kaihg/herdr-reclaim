// 選取狀態：畫面自己的狀態，不是城鎮帳本的一部分。
//
// 決策（ticket #3）：選取不寫進城的 journal。它不產生資源、不改變土地或 claim，
// 寫進 append-only 的帳本只會讓每個城多出純 UI 噪音，並讓「重播 = 同一座城」的
// 驗證多一個無關變數。改存在 mod 資料目錄下的小檔案（ui.json），以 cityId 為鍵；
// 重開 herdr 後還原同一個選取。
//
// 純 JS：解析、合併與「還原後的選取還有效嗎」都放在這裡，檔案 I/O 由呼叫端做。

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
    return emptyUi(); // 壞掉的 UI 檔不影響城鎮，回到預設選取
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

/**
 * 指揮桌一打開右邊就有東西：預設選第一支遠征。畫面一次顯示一座城（由目前的 space 決定），
 * `cityId` 指定要看哪一座；沒指定或找不到就用第一座。
 */
export function defaultSelection(town, cityId) {
  const cities = town?.cities ?? [];
  const city = (cityId ? cities.find((candidate) => candidate.cityId === cityId) : null) ?? cities[0] ?? null;
  const first = city?.tiles?.reduce((latest, tile) =>
    !latest || tile.generation > latest.generation ? tile : latest, null) ?? null;
  return first
    ? { kind: "expedition", cityId: city.cityId, rootSessionId: first.rootSessionId, generation: first.generation }
    : null;
}

/**
 * 還原後的選取：城或格子已經不在（例如帳本換了一座城）就回到預設，
 * 不讓畫面停在一個永遠找不到的選取上。
 */
export function resolveSelection(town, saved, cityId) {
  if (saved && typeof saved === "object") {
    const city = (town?.cities ?? []).find((candidate) => candidate.cityId === saved.cityId) ?? null;
    if (city) {
      if (saved.kind === "expedition") {
        const candidates = city.tiles.filter((tile) => tile.rootSessionId === saved.rootSessionId);
        const selected = candidates.find((tile) => tile.generation === saved.generation) ??
          candidates.reduce((latest, tile) => !latest || tile.generation > latest.generation ? tile : latest, null);
        if (selected) {
          return {
            kind: "expedition",
            cityId: city.cityId,
            rootSessionId: saved.rootSessionId,
            generation: selected.generation,
          };
        }
      }
      if (saved.kind === "tile" && Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
        return { kind: "tile", cityId: city.cityId, x: saved.x, y: saved.y };
      }
    }
  }
  return defaultSelection(town, cityId ?? saved?.cityId);
}

export function serializeUi(ui) {
  return `${JSON.stringify(ui)}\n`;
}
