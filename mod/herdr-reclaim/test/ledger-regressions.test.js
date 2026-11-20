// ticket #4 的回歸驗證：§15.3 的五項既有失敗，以及在它們上面重建的能力。
//
//   1. manifest 被當成內容（內容檔切塊後讀回來還是原本的內容）
//   2. segment 超限（封段行要預留空間，封段後每一段都還在單段上限內）
//   3. 收成誤加 100 點（帳本只套 entry 帶的點數，不自己發明）
//   4. 舊 generation 套到新 generation（重新派遣後，舊代的收成整筆拒絕）
//   5. 長期段落超限（大量操作後每一段都還在單檔上限內）
//
// 另外驗證「封段後寫入者改到下一段並重新檢查前提」：別人先封段時，晚到的寫入者
// CAS 失敗、重讀、改寫到下一段，並在重讀後的狀態上重新檢查。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { CityLedger, byteLen } from "../core/ledger.js";
import { readTownFromLedger } from "../core/town.js";
import { AT } from "../scenarios/first-expedition.js";
import { createFileIo } from "./fs-io.js";

const CITY_ID = "/reclaim/capacity-city";
const dirOf = (name) => `/tmp/reclaim-4-regressions/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

const open = (dir, options = {}, io = createFileIo()) =>
  new CityLedger({ io, dir, cityId: CITY_ID, ...options }).open();

/** 遠征取得土地：座標由測試指定（不要用 BFS，這樣才看得出 generation 的差別）。 */
const expeditionOp = (sessionId, generation, x, y) => ({
  opId: `expedition:${sessionId}:${generation}`,
  kind: "expedition",
  at: AT,
  cityId: CITY_ID,
  rootSessionId: sessionId,
  generation,
  x,
  y,
  cli: "omp",
  repo: { commonDir: CITY_ID, checkout: CITY_ID },
});

/** 收成：點數與資源向量由 entry 自己帶（§7.3 的規則屬於收成票，帳本不發明數字）。 */
const harvestOp = (sessionId, generation, claim, { points = 20, resources = { wood: 10 } } = {}) => ({
  opId: `harvest:${claim}`,
  kind: "harvest",
  at: AT,
  cityId: CITY_ID,
  rootSessionId: sessionId,
  generation,
  claim,
  points,
  resources,
  blobs: { claim, paths: [`src/${claim}.ts`] },
});

const segmentsOf = async (ledger) => ledger.scanSegments();
const entriesOf = (segments) => segments.flatMap((segment) => segment.entries);

/** 城鎮讀取模型（使用者看得到的那一面）。 */
const townsOf = async (ledger) => {
  const state = await ledger.state();
  return readTownFromLedger({ activities: [...state.activities.values()], expeditions: state.tiles });
};

const tileOf = async (ledger, sessionId, generation = 1) => {
  const town = await townsOf(ledger);
  return town.cities
    .flatMap((city) => city.tiles)
    .find((tile) => tile.rootSessionId === sessionId && tile.generation === generation);
};

describe("S3 的五項既有失敗", () => {
  test("① 內容檔切塊後讀回來的是內容，不是 manifest", async () => {
    const ledger = await open(dirOf("content"));
    await ledger.submit(() => expeditionOp("sess-content", 1, 0, -1));

    const paths = Array.from({ length: 20_000 }, (_, i) => ({ path: `src/路徑-${i}.ts`, resultBlob: `blob-${i}` }));
    const text = JSON.stringify(paths);
    const applied = await ledger.submit(() => ({
      ...harvestOp("sess-content", 1, "claim-big"),
      blobs: { commit: "sha-big", paths },
    }));
    expect(applied.status).toBe("applied");

    const [entry] = entriesOf(await segmentsOf(ledger)).filter((candidate) => candidate.kind === "harvest");
    const readback = await ledger.blobs.getText(entry.content);
    expect(JSON.parse(readback)).toEqual({ commit: "sha-big", paths }); // 內容與順序都不變
    expect(byteLen(readback)).toBeGreaterThan(256 * 1024);
    for (const file of filesOf(ledger.dir)) expect(fs.statSync(file).size).toBeLessThan(256 * 1024);
  });

  test("② 封段要預留封段行的空間：封段後每一段都在上限內", async () => {
    const limit = 700;
    const ledger = await open(dirOf("seal"), { segmentLimit: limit });
    // 一筆一筆填，直到剛好放不下下一筆（封段行加上去就會超過上限的那個位置）。
    for (let i = 0; i < 8; i++) {
      expect((await ledger.submit(() => expeditionOp(`sess-${i}`, 1, i, -1))).status).toBe("applied");
    }
    const segments = await segmentsOf(ledger);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.slice(0, -1).every((segment) => segment.sealed)).toBe(true);
    for (const segment of segments) expect(byteLen(segment.text)).toBeLessThanOrEqual(limit);
    // 封段標記自己也在上限內（不是把封段行塞爆的那一份）。
    const sealed = segments[0];
    expect(byteLen(sealed.text)).toBeLessThanOrEqual(limit - 1);
  });

  test("③ 收成只加 entry 帶的點數：不會自己發明 +100", async () => {
    const ledger = await open(dirOf("points"));
    await ledger.submit(() => expeditionOp("sess-points", 1, 0, -1));
    expect((await ledger.submit(() => harvestOp("sess-points", 1, "claim-1"))).status).toBe("applied");

    const tile = await tileOf(ledger, "sess-points");
    expect(tile.points).toBe(20);
    expect(tile.harvestPoints).toBe(20);
    expect(tile.points).not.toBe(120);

    // 第二筆收成（另一個 claim）再加 20：自然工作 0 + 收成 40。
    await ledger.submit(() => harvestOp("sess-points", 1, "claim-2"));
    expect((await tileOf(ledger, "sess-points")).points).toBe(40);
  });

  test("④ 重新派遣後，舊 generation 的收成整筆拒絕", async () => {
    const ledger = await open(dirOf("generation"));
    await ledger.submit(() => expeditionOp("sess-gen", 1, 0, -1));
    expect((await ledger.submit(() => harvestOp("sess-gen", 1, "claim-gen1"))).status).toBe("applied");
    // 重新派遣（#7 的條件會更嚴；這一票只要求 generation 是現役的下一代）。
    expect((await ledger.submit(() => expeditionOp("sess-gen", 2, 0, -2))).status).toBe("applied");

    const stale = await ledger.submit(() => harvestOp("sess-gen", 1, "claim-old"));
    expect(stale.status).toBe("rejected");
    expect(stale.reason).toBe("stale_generation");

    // 舊代的格子還在，但沒有多拿到點數；新代照常收成。
    expect((await tileOf(ledger, "sess-gen", 1)).harvestPoints).toBe(20);
    expect((await ledger.submit(() => harvestOp("sess-gen", 2, "claim-old"))).status).toBe("applied");
    expect((await tileOf(ledger, "sess-gen", 2)).harvestPoints).toBe(20);
    // 一格 generation 一個身分：兩代各一張，不會互相蓋掉。
    expect((await townsOf(ledger)).cities[0].tiles).toHaveLength(2);
    // 歷程查詢分得開兩代：指定 generation 才定位得到那一代的格子與它的 entry。
    const second = await ledger.lookupExpedition("sess-gen", 2);
    expect(second.tile).toMatchObject({ generation: 2, x: 0, y: -2, harvestPoints: 20 });
    expect(await ledger.lookupExpedition("sess-gen", 3)).toBeNull();
    expect((await ledger.historyOf("sess-gen", 1)).entries.filter((entry) => entry.kind === "harvest")).toHaveLength(1);
    expect((await ledger.historyOf("sess-gen", 2)).entries.filter((entry) => entry.kind === "harvest")).toHaveLength(1);
  });

  test("⑤ 長期段落超限：大量操作之後每一段、每一個檔案都在上限內", async () => {
    const limit = 4096;
    const ledger = await open(dirOf("long"), { segmentLimit: limit });
    for (let i = 0; i < 400; i++) {
      const result = await ledger.submit(() => expeditionOp(`sess-long-${i}`, 1, i % 20, -Math.floor(i / 20) - 1));
      expect(result.status).toBe("applied");
    }
    const segments = await segmentsOf(ledger);
    expect(segments.length).toBeGreaterThan(10); // 真的換過很多段
    for (const segment of segments) expect(byteLen(segment.text)).toBeLessThanOrEqual(limit);
    expect(entriesOf(segments)).toHaveLength(400);

    // 重開（新的帳本實例）讀回同一座城：換段不會漏 entry。
    const reopened = await open(ledger.dir, { segmentLimit: limit });
    expect((await reopened.state()).tiles).toHaveLength(400);
    expect(await townsOf(reopened)).toEqual(await townsOf(ledger));
  });
});

describe("封段與晚到的寫入者", () => {
  test("別人先封段：晚到的寫入者改寫到下一段，並在重讀後重新檢查前提", async () => {
    // 「長期段落超限」那一條的五項失敗之一：封段與舊 writer 競態。
    const limit = 700;
    const dir = dirOf("rotation-race");
    const a = await open(dir, { segmentLimit: limit });
    const b = await open(dir, { segmentLimit: limit });
    await a.submit(() => expeditionOp("sess-a", 1, 0, -1));
    await b.state(); // b 從此抱著一份舊快照

    // a 把這一段填滿、封段、換到下一段，然後用掉 claim-x。
    for (let i = 0; i < 6; i++) await a.submit(() => expeditionOp(`pad-${i}`, 1, i + 1, -1));
    const before = await a.scanSegments();
    expect(before.length).toBeGreaterThan(1);
    expect(before[0].sealed).toBe(true);
    const sealedText = before[0].text;
    expect((await a.submit(() => harvestOp("sess-a", 1, "claim-x"))).status).toBe("applied");

    // b 想用同一個 claim（不同的 operation ID）：CAS 失敗 → 重讀 → 改到下一段
    // → 前提變成 claim_exists。
    const late = await b.submit(() => ({ ...harvestOp("sess-a", 1, "claim-x"), opId: "harvest:late-writer" }));
    expect(late.status).toBe("rejected");
    expect(late.reason).toBe("claim_exists");
    // 已封的那一段沒有被改寫。
    const after = await b.scanSegments();
    expect(after[0].text).toBe(sealedText);

    // b 換一個 claim：這次要寫進「下一段」（封段之後的那一段）。
    const ok = await b.submit(() => harvestOp("sess-a", 1, "claim-y"));
    expect(ok.status).toBe("applied");
    const segments = await b.scanSegments();
    expect(segments[0].text).toBe(sealedText);
    expect(segments.at(-1).entries.some((entry) => entry.opId === "harvest:claim-y")).toBe(true);
    for (const segment of segments) expect(byteLen(segment.text)).toBeLessThanOrEqual(limit);

    const reopened = await open(dir, { segmentLimit: limit });
    expect((await tileOf(reopened, "sess-a")).harvestPoints).toBe(40); // claim-x + claim-y
  });
});

describe("操作 ID 與 claim 的去重（跨 generation 也要正確）", () => {
  test("同一個 operation ID 重送不會改變狀態；同一個 claim 只發一次", async () => {
    const ledger = await open(dirOf("dedupe"));
    await ledger.submit(() => expeditionOp("sess-dedupe", 1, 0, -1));
    expect((await ledger.submit(() => harvestOp("sess-dedupe", 1, "claim-1"))).status).toBe("applied");
    expect((await ledger.submit(() => harvestOp("sess-dedupe", 1, "claim-1"))).status).toBe("duplicate");

    // 另一個 operation ID、同一份成果：城級去重擋下來（§7.3）。
    const same = await ledger.submit(() => ({ ...harvestOp("sess-dedupe", 1, "claim-1"), opId: "harvest:other-id" }));
    expect(same.status).toBe("rejected");
    expect(same.reason).toBe("claim_exists");
    expect((await tileOf(ledger, "sess-dedupe")).harvestPoints).toBe(20);
  });
});

/** 這個城的目錄底下所有檔案。 */
function filesOf(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(dir);
  return out;
}
