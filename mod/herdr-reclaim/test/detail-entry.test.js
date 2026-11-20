// 詳情的入口（§12、§14.1；#9 的 AC）：歷程搜尋只從「選取遠征或格子的詳情」進入。
// QA 抓到的缺陷是這顆按鈕在 UI 重寫時整顆不見了；入口的存在改成讀取模型的一個欄位
// （`historyEntry`），所以固定情境測試可以直接釘住它，UI 只是照著畫。
import { describe, expect, test } from "bun:test";

import { readTown, selectionDetail } from "../core/town.js";
import { firstExpedition } from "../scenarios/first-expedition.js";

const town = readTown(firstExpedition);
const city = town.cities[0];
const first = city.tiles[0];

describe("詳情的歷程入口（§12）", () => {
  test("遠征詳情有入口", () => {
    const detail = selectionDetail(town, {
      kind: "expedition",
      cityId: city.cityId,
      rootSessionId: first.rootSessionId,
      generation: first.generation,
    });
    expect(detail.kind).toBe("expedition");
    expect(detail.historyEntry).toBe(true);
  });

  test("遠征佔的那一格、中心格與迷霧格都有入口", () => {
    const occupied = selectionDetail(town, { kind: "tile", cityId: city.cityId, x: first.x, y: first.y });
    expect(occupied.kind).toBe("expedition");
    expect(occupied.historyEntry).toBe(true);

    const center = selectionDetail(town, { kind: "tile", cityId: city.cityId, x: city.center.x, y: city.center.y });
    expect(center.kind).toBe("center");
    expect(center.historyEntry).toBe(true);

    const fog = selectionDetail(town, { kind: "tile", cityId: city.cityId, x: 3, y: 3 });
    expect(fog.kind).toBe("fog");
    expect(fog.historyEntry).toBe(true);
  });

  test("沒有選取或沒有城時沒有入口", () => {
    expect(selectionDetail(town, null).historyEntry).toBe(false);
    expect(selectionDetail({ cities: [] }, null).historyEntry).toBe(false);
    expect(selectionDetail({ cities: [{ cityId: city.cityId, name: city.name, center: city.center, tiles: [] }] }, {
      kind: "expedition",
      cityId: city.cityId,
      rootSessionId: "不存在的遠征",
      generation: 1,
    }).historyEntry).toBe(false);
  });
});
