// 公開讀取模型的驗收接點（ticket #3）：帳本 → readTownFromLedger 必須和直接重播
// 固定事件情境的 readTown 得到同一座城，而且關掉再開、重播同一份情境都不會改變它。
// 只斷言使用者看得到的城鎮狀態：城市、格子、遠征、右側詳情。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { CityLedger, cityDir } from "../core/ledger.js";
import { readTown, readTownFromLedger, selectionDetail } from "../core/town.js";
import { ingestActivities, ingestExpeditions, ingestScenario } from "../core/ingest.js";
import {
  defaultSelection,
  parseUi,
  resolveSelection,
  selectionOf,
  serializeUi,
  withSelection,
} from "../core/selection.js";
import { CITY, ROOT_SESSION_ID, firstExpedition } from "../scenarios/first-expedition.js";
import { createFileIo } from "./fs-io.js";

const newDir = () => cityDir(fs.mkdtempSync("/tmp/reclaim-3-"), CITY.commonDir);

async function open(dir, io = createFileIo()) {
  return new CityLedger({ io, dir, cityId: CITY.commonDir }).open();
}

/** 帳本 → 公開讀取模型。 */
async function townOfLedger(ledger) {
  const state = await ledger.state();
  return readTownFromLedger({
    activities: [...state.activities.values()],
    expeditions: state.tiles,
    repoFacts: firstExpedition.repoFacts,
  });
}

/** 帳本裡目前有幾筆 entry（重播兩次不該變多）。 */
async function entryCount(ledger) {
  const segments = await ledger.scanSegments();
  return segments.reduce((total, segment) => total + segment.entries.length, 0);
}

/** 把整座城複製一份，但 head 的 checkpoint 歸零：這是「從頭重播」。 */
function copyWithoutCheckpoint(source, target) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  const headPath = `${target}/head.json`;
  const head = JSON.parse(fs.readFileSync(headPath, "utf8"));
  head.checkpoint = -1;
  fs.writeFileSync(headPath, `${JSON.stringify(head)}\n`);
}

describe("帳本重建城鎮", () => {
  test("帳本重建的城鎮和直接重播固定情境完全相同", async () => {
    const ledger = await open(newDir());
    await ingestScenario(ledger, firstExpedition, CITY.commonDir);

    expect(await townOfLedger(ledger)).toEqual(readTown(firstExpedition));
  });

  test("關閉 herdr 再開：同一份帳本重建出同樣的格子與狀態", async () => {
    const dir = newDir();
    const first = await open(dir);
    await ingestScenario(first, firstExpedition, CITY.commonDir);
    const before = await townOfLedger(first);

    // 新的一個帳本實例讀同一份檔案，像另一個視窗／重開後的 herdr。
    const reopened = await open(dir);
    const after = await townOfLedger(reopened);

    expect(after).toEqual(before);
    expect(after.cities[0].tiles.map((tile) => [tile.x, tile.y])).toEqual([
      [0, -1],
      [1, 0],
    ]);
  });

  test("同一份情境重播兩次：格子不變、不重複入帳", async () => {
    const dir = newDir();
    const ledger = await open(dir);
    await ingestScenario(ledger, firstExpedition, CITY.commonDir);
    const entries = await entryCount(ledger);
    const before = await townOfLedger(ledger);

    const again = await ingestScenario(ledger, firstExpedition, CITY.commonDir);
    expect(again.activities.every((result) => result.status === "duplicate")).toBe(true);
    expect(again.expeditions.every((result) => result.status === "duplicate")).toBe(true);
    expect(await entryCount(ledger)).toBe(entries);
    expect(await townOfLedger(ledger)).toEqual(before);
  });

  test("checkpoint 加後續 journal 的重播結果，和從頭重播完全相同", async () => {
    const dir = newDir();
    const ledger = await open(dir);
    // 先寫一半（活動紀錄），做 checkpoint，再寫另一半（取得土地）。
    await ingestActivities(ledger, firstExpedition.activities, CITY.commonDir);
    const mid = await ledger.checkpoint();
    expect(mid.seq).toBeGreaterThanOrEqual(0);

    await ingestScenario(ledger, firstExpedition, CITY.commonDir);
    const withCheckpoint = await townOfLedger(ledger);

    const freshDir = cityDir(fs.mkdtempSync("/tmp/reclaim-3-"), CITY.commonDir);
    copyWithoutCheckpoint(dir, freshDir);
    const replayed = await open(freshDir);

    expect(await townOfLedger(replayed)).toEqual(withCheckpoint);
    expect(await townOfLedger(ledger)).toEqual(readTown(firstExpedition));
  });

  test("選取內容也重建得出來：同一支遠征的詳情在重開後不變", async () => {
    const dir = newDir();
    const ledger = await open(dir);
    await ingestScenario(ledger, firstExpedition, CITY.commonDir);
    const town = await townOfLedger(ledger);
    const selection = { kind: "expedition", cityId: town.cities[0].cityId, rootSessionId: ROOT_SESSION_ID };

    const reopened = await townOfLedger(await open(dir));
    expect(selectionDetail(reopened, selection)).toEqual(selectionDetail(town, selection));
    expect(selectionDetail(reopened, selection).title).toBe(`遠征 ${ROOT_SESSION_ID.slice(0, 8)}`);
  });

  test("只有活動紀錄、沒有取得土地的 entry 時，城鎮不會出現格子", async () => {
    const ledger = await open(newDir());
    await ingestActivities(ledger, firstExpedition.activities, CITY.commonDir);
    const state = await ledger.state();
    expect(state.activities.size).toBe(5); // 活動紀錄與內容檔都寫進去了
    expect(state.tiles).toHaveLength(0); // 但沒有取得土地的 entry
    expect(await townOfLedger(ledger)).toEqual({ schema: 1, cities: [] });
  });

  test("選取存在 mod 的 ui.json，重開後還原成同一個選取；城鎮帳本不記選取", async () => {
    const io = createFileIo();
    const uiPath = `${fs.mkdtempSync("/tmp/reclaim-3-ui-")}/ui.json`;
    const ledger = await open(newDir(), io);
    await ingestScenario(ledger, firstExpedition, CITY.commonDir);
    const town = await townOfLedger(ledger);

    // 使用者改了選取：第二支遠征。
    const chosen = {
      kind: "expedition",
      cityId: town.cities[0].cityId,
      rootSessionId: town.cities[0].tiles[1].rootSessionId,
    };
    const before = await io.read(uiPath);
    const saved = withSelection(parseUi(before), chosen.cityId, chosen);
    await io.write(uiPath, serializeUi(saved), before);

    // 重開：城市由帳本重建，選取由 ui.json 還原。
    expect(resolveSelection(town, selectionOf(parseUi(await io.read(uiPath)), chosen.cityId))).toEqual(chosen);
    // 壞掉的 UI 檔不會影響城鎮，只回到預設選取。
    expect(resolveSelection(town, selectionOf(parseUi("{ 這不是 json"), chosen.cityId))).toEqual(defaultSelection(town));
    // 帳本裡沒有選取這回事：journal entry 只有活動與取得土地。
    const entries = (await ledger.scanSegments()).flatMap((segment) => segment.entries);
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(new Set(["activity", "expedition"]));
  });
});
