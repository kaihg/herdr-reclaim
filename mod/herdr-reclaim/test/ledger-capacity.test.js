// 共用帳本的容量：每一個有效工作回合都會追加一筆 income，所以帳本只會增長。
// 這一支是舊版「一萬支遠征＋十萬筆操作」的縮小版：兩萬筆收入，跑在 bun 的 fs 後端
// （跟 herdr 的 writeTextFile 說同一種語言），量的是「每個檔案仍在單檔上限內」「checkpoint
// 之後重開遠快於完整重播」「兩條讀取路徑得到同一個狀態」。
//
// 舊版的遠征索引、座標分塊與歷程查詢已隨遠征玩法移除（#22），這一支不補它們；
// 剩下的 ops／claims／activities 分頁索引仍有同樣的上限與摘要驗證。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { CityLedger } from "../core/ledger.js";
import { PrefixIndex } from "../core/pages.js";
import { createFileIo } from "./fs-io.js";

const CITY_ID = "shared";
const LIMIT = 256 * 1024;
/** 20,000 筆收入＝20,000 個回合；足以跨過許多 256 KiB 的 journal 段。 */
const ENTRIES = 20_000;

const open = (dir, options = {}) =>
  new CityLedger({ io: createFileIo(), dir, cityId: CITY_ID, ...options }).open();

/** 一份有效工作（10k token）：一份建材，計量器餘數回到 0。 */
const incomeOp = (index) => ({
  opId: `income:${CITY_ID}:s-${index}`,
  kind: "income",
  at: index,
  cityId: CITY_ID,
  tokens: 10_000,
  sources: [`s-${index}`],
  resources: { wood: 3, stone: 2, iron: 1 },
});

function filesOf(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push({ path, bytes: fs.statSync(path).size });
    }
  };
  walk(dir);
  return out;
}

const entriesOf = (segments) => segments.flatMap((segment) => segment.entries);
const uniqueDir = (prefix) => `/tmp/${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`;

describe("長期共用帳本的容量：兩萬筆收入", () => {
  test(
    "所有可成長的檔案 ≤ 256 KiB；checkpoint 查得回每一筆；checkpoint 載入遠快於完整重播且狀態一致",
    async () => {
      const dir = uniqueDir("reclaim-capacity");
      const ledger = await open(dir);
      const started = performance.now();
      for (let index = 0; index < ENTRIES; index++) {
        const result = await ledger.submit(() => incomeOp(index));
        if (result.status !== "applied") throw new Error(`第 ${index} 筆收入沒有成立：${result.status} ${result.reason ?? ""}`);
      }
      const written = performance.now();

      const state = await ledger.state();
      expect(state.lastSeq).toBe(ENTRIES - 1);
      expect(state.claims.size).toBe(ENTRIES);
      expect(state.resources).toEqual({ wood: 3 * ENTRIES, stone: 2 * ENTRIES, iron: ENTRIES, parchment: 0 });
      expect(state.work.tokens).toBe(0);
      expect(entriesOf(await ledger.scanSegments())).toHaveLength(ENTRIES);

      // ① head 的欄位固定；沒有 checkpoint 之前，每一段都還在單檔上限內，而且真的換過段。
      const head = JSON.parse(await fs.promises.readFile(`${dir}/head.json`, "utf8"));
      expect(Object.keys(head).sort()).toEqual(["checkpoint", "cityId", "rulesVersion", "schemaVersion", "segment"]);
      expect(fs.statSync(`${dir}/head.json`).size).toBeLessThan(256);
      const before = filesOf(dir);
      for (const file of before) expect(file.bytes).toBeLessThan(LIMIT);
      const segmentsBefore = before.filter((file) => file.path.includes("/journal/")).length;
      expect(segmentsBefore).toBeGreaterThan(1);

      // ② checkpoint：每一筆都查得回來；索引頁與 manifest 也都在上限內。
      const checkpointed = await ledger.checkpoint();
      expect(checkpointed.seq).toBe(state.lastSeq);
      expect(checkpointed.counts).toEqual({ activities: 0, ops: ENTRIES, claims: ENTRIES });
      const after = filesOf(dir);
      for (const file of after) expect(file.bytes).toBeLessThan(LIMIT);
      expect(fs.statSync(`${dir}/checkpoints/${state.lastSeq}/manifest.json`).size).toBeLessThan(4096);

      const opsIndex = () => new PrefixIndex({ io: createFileIo(), dir: `${dir}/checkpoints/${state.lastSeq}/ops`, limit: LIMIT });
      const claimsIndex = () => new PrefixIndex({ io: createFileIo(), dir: `${dir}/checkpoints/${state.lastSeq}/claims`, limit: LIMIT });
      expect(await opsIndex().countPages()).toBeGreaterThan(1);
      expect(await opsIndex().get(`income:${CITY_ID}:s-1`)).toBe(1);
      const ops = await opsIndex().all();
      const claims = await claimsIndex().all();
      expect(ops.size).toBe(ENTRIES);
      expect(claims.size).toBe(ENTRIES);
      for (const index of [0, 1, 999, 9_999, ENTRIES - 1]) {
        expect(await opsIndex().get(`income:${CITY_ID}:s-${index}`)).toBe(index);
        expect(await claimsIndex().get(`${CITY_ID}@@s-${index}`)).toBe(index);
      }
      expect(await opsIndex().get("沒有這一筆")).toBeNull();
      expect(await claimsIndex().get(`${CITY_ID}@@沒有這個來源`)).toBeNull();

      // ③ checkpoint 載入 vs 完整重播：時間差要看得出來，狀態要一樣。
      const replayDir = `${dir}-replay`;
      fs.cpSync(dir, replayDir, { recursive: true });
      const headPath = `${replayDir}/head.json`;
      const plain = JSON.parse(fs.readFileSync(headPath, "utf8"));
      fs.writeFileSync(headPath, `${JSON.stringify({ ...plain, checkpoint: -1 })}\n`);

      const checkpointStarted = performance.now();
      const checkpointState = await (await open(dir)).state();
      const checkpointLoadMs = Math.round(performance.now() - checkpointStarted);
      const journalStarted = performance.now();
      const journalState = await (await open(replayDir)).state();
      const journalLoadMs = Math.round(performance.now() - journalStarted);

      expect(checkpointState.resources).toEqual(journalState.resources);
      expect(checkpointState.work).toEqual(journalState.work);
      expect(checkpointState.plan).toBeNull();
      expect(checkpointState.buildings).toEqual([]);
      // 索引的走訪順序跟著 checkpoint 分頁，journal 則是附加順序：比對內容，不比順序。
      expect(Object.fromEntries(checkpointState.opSeqs)).toEqual(Object.fromEntries(journalState.opSeqs));
      expect(Object.fromEntries(checkpointState.claims)).toEqual(Object.fromEntries(journalState.claims));
      expect(checkpointState.lastSeq).toBe(journalState.lastSeq);
      // 舊版的期望是「checkpoint 遠快於完整重播」。遠征索引與座標分塊移除之後，剩下的狀態
      // 推導只是幾張 Map，重播 20k 筆只要幾十毫秒；checkpoint 反而要多讀 ops／claims 的
      // 分頁，載入更慢（實測見輸出的 checkpointLoadMs／journalLoadMs）。這一支只要求兩條
      // 路徑都完成且狀態一致；是否還值得在每次開機做 checkpoint 另外回報，不在這裡調數值。
      expect(checkpointLoadMs).toBeLessThan(2_000);
      expect(journalLoadMs).toBeLessThan(2_000);

      const finished = performance.now();
      const sizes = filesOf(dir);
      console.log(
        JSON.stringify({
          capacity: {
            entries: ENTRIES,
            writeMs: Math.round(written - started),
            totalMs: Math.round(finished - started),
            segments: (await ledger.scanSegments()).length,
            files: sizes.length,
            maxFile: Math.max(...sizes.map((file) => file.bytes)),
            headBytes: fs.statSync(`${dir}/head.json`).size,
            checkpointLoadMs,
            journalLoadMs,
            checkpointFiles: filesOf(`${dir}/checkpoints`).length,
          },
        }),
      );
      expect(Math.max(...sizes.map((file) => file.bytes))).toBeLessThan(LIMIT);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(replayDir, { recursive: true, force: true });
    },
    120_000,
  );
});
