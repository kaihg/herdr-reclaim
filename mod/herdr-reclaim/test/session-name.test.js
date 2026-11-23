// 土地的名稱＝綁定的 session 名稱（omp 的 session title）；還沒有名稱時退回短 id。
import { describe, expect, test } from "bun:test";
import { mergeActivities, readTownFromLedger, selectionDetail, tileLabel } from "../core/town.js";
import { sessionNamesOf } from "../core/adapter.js";
import { CITY, ROOT_SESSION_ID, firstExpedition } from "../scenarios/first-expedition.js";

const entry = { cityId: CITY.commonDir, rootSessionId: ROOT_SESSION_ID, generation: 1, x: 0, y: -1, at: 0, activatedAt: 0, landStage: "reserved", cli: "omp", repo: CITY };
const town = (sessionNames) => readTownFromLedger({
  activities: firstExpedition.activities,
  repoFacts: firstExpedition.repoFacts,
  expeditions: [entry],
  sessionNames,
});
const selected = { kind: "expedition", cityId: CITY.commonDir, rootSessionId: ROOT_SESSION_ID, generation: 1 };

describe("土地名稱", () => {
  test("有 session 名稱：詳情標題與標籤用名稱；第 1 代不加代數", () => {
    const loaded = town({ [ROOT_SESSION_ID]: "🏘️ TOWN: 修正城鎮中心" });
    const tile = loaded.cities[0].tiles[0];
    expect(tile.sessionName).toBe("🏘️ TOWN: 修正城鎮中心");
    expect(tileLabel(tile)).toBe("🏘️ TOWN: 修正城鎮中心");
    expect(selectionDetail(loaded, selected).title).toBe("🏘️ TOWN: 修正城鎮中心");
  });

  test("重新派遣的第 2 代要看得出代數", () => {
    const loaded = readTownFromLedger({
      activities: firstExpedition.activities,
      repoFacts: firstExpedition.repoFacts,
      expeditions: [{ ...entry, generation: 2 }],
      sessionNames: { [ROOT_SESSION_ID]: "修 bug" },
    });
    expect(selectionDetail(loaded, { ...selected, generation: 2 }).title).toBe("修 bug · 第 2 代");
  });

  test("沒有名稱（或只有空白）：維持原本的短 id 標題", () => {
    for (const names of [undefined, {}, { [ROOT_SESSION_ID]: "  " }]) {
      const loaded = town(names);
      expect(loaded.cities[0].tiles[0].sessionName ?? "").toBe(names?.[ROOT_SESSION_ID] ? "  " : "");
      expect(selectionDetail(loaded, selected).title).toBe(`遠征 ${ROOT_SESSION_ID.slice(0, 8)} · 第 1 代`);
    }
  });

  test("名稱隨使用者改名更新：同一 session 取最後更新的那份活動檔；沒有名稱的舊檔不蓋掉它", () => {
    const records = [
      { ...firstExpedition.activities[0], writerEpoch: "a", updatedAt: 100, sessionName: "舊名稱" },
      { ...firstExpedition.activities[0], writerEpoch: "b", updatedAt: 200, sessionName: "新名稱" },
      { ...firstExpedition.activities[0], writerEpoch: "c", updatedAt: 300 },
    ];
    expect(sessionNamesOf(records)[firstExpedition.activities[0].sessionId]).toBe("新名稱");
  });

  test("同一個寫入者的兩份快照合併後，名稱取較新的那份", () => {
    const base = firstExpedition.activities[0];
    const merged = mergeActivities([
      { ...base, updatedAt: 10, sessionName: "第一版" },
      { ...base, updatedAt: 20, sessionName: "第二版" },
      { ...base, updatedAt: 5, sessionName: "更舊的" },
    ]);
    expect(merged.find((record) => record.sessionId === base.sessionId).sessionName).toBe("第二版");
  });
});
