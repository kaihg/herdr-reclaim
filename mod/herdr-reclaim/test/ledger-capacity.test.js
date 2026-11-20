// ticket #4 的容量驗收：長期使用的城鎮，每個檔案都還在 herdr 的單檔讀取上限內。
//
//   一萬支遠征 ＋ 十萬筆操作 ＋ 一個改了兩萬個路徑的成果，全部檔案 ≤ 256 KiB；
//   head 的欄位固定；checkpoint 的分頁索引查得回每一筆；checkpoint 後重播與完整
//   journal 一致，歷程查詢仍定位得到遠征。
//
// 這一支的量級測試跑在 bun（node fs 後端，跟 herdr 的 writeTextFile 說同一種語言），
// 執行時間寫在輸出的 `capacity` 那一行；真實 herdr runtime 只跑代表性的換段與分頁
// （見交接筆記的 runtime 探針）。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { CityLedger } from "../core/ledger.js";
import { PrefixIndex } from "../core/pages.js";
import { readTownFromLedger } from "../core/town.js";
import { AT } from "../scenarios/first-expedition.js";
import { createFileIo } from "./fs-io.js";

const CITY_ID = "/reclaim/capacity-city";
const LIMIT = 256 * 1024;
const EXPEDITIONS = 10_000;
const HARVESTS = 90_000;
/** 這一支的內容是「一次改了兩萬個路徑」的 commit（§15.3 的量級）。 */
const BIG_PATHS = 20_000;

const open = (dir, options = {}) =>
  new CityLedger({ io: createFileIo(), dir, cityId: CITY_ID, ...options }).open();

/** 遠征的座標：一格一格往北排，不會用到城鎮中心 (0,0)。 */
const coordOf = (index) => ({ x: (index % 100) - 50, y: -Math.floor(index / 100) - 1 });

const expeditionOp = (index) => ({
  opId: `expedition:${index}`,
  kind: "expedition",
  at: AT + index,
  cityId: CITY_ID,
  rootSessionId: `sess-${index}`,
  generation: 1,
  ...coordOf(index),
  cli: "omp",
  repo: { commonDir: CITY_ID, checkout: CITY_ID },
});

const harvestOp = (index) => {
  const op = {
    opId: `harvest:${index}`,
    kind: "harvest",
    at: AT + EXPEDITIONS + index,
    cityId: CITY_ID,
    rootSessionId: `sess-${index % EXPEDITIONS}`,
    generation: 1,
    claim: `claim-${index}`,
    points: 20,
    resources: { wood: 10 },
  };
  // 大部份的收成只用 claim 與點數；前幾筆帶一份小型 commit 內容，
  // 其中第 0 筆就是兩萬個路徑的那一個。
  if (index === 0) op.blobs = { commit: "sha-big", paths: bigPaths() };
  else if (index < 200) op.blobs = { commit: `sha-${index}`, paths: [`src/${index}.ts`] };
  return op;
};

const bigPaths = () =>
  Array.from({ length: BIG_PATHS }, (_, i) => ({ path: `src/路徑-${i}.ts`, resultBlob: `blob-${i}`, claim: `claim-${i}` }));

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

const townsOf = async (ledger) => {
  const state = await ledger.state();
  return readTownFromLedger({ activities: [...state.activities.values()], expeditions: state.tiles });
};

describe("長期城鎮的容量：一萬支遠征、十萬筆操作", () => {
  test(
    "所有可成長的檔案都 ≤ 256 KiB，checkpoint 查得回每一筆，重播一致",
    async () => {
      const dir = `/tmp/reclaim-4-capacity-${process.pid}-${Math.random().toString(36).slice(2)}`;
      const ledger = await open(dir);
      const started = performance.now();

      for (let index = 0; index < EXPEDITIONS; index++) {
        expect((await ledger.submit(() => expeditionOp(index))).status).toBe("applied");
      }
      for (let index = 0; index < HARVESTS; index++) {
        expect((await ledger.submit(() => harvestOp(index))).status).toBe("applied");
      }
      const written = performance.now();

      // ② 兩萬個路徑的成果內容切塊之後仍然完整讀回。
      const bigEntry = entriesOf(await ledger.scanSegments()).find((entry) => entry.opId === "harvest:0");
      expect(JSON.parse(await ledger.blobs.getText(bigEntry.content)).paths).toHaveLength(BIG_PATHS);

      const state = await ledger.state();
      expect(state.lastSeq).toBe(EXPEDITIONS + HARVESTS - 1);
      expect(state.tiles).toHaveLength(EXPEDITIONS);
      expect(state.claims.size).toBe(HARVESTS);
      expect(entriesOf(await ledger.scanSegments())).toHaveLength(EXPEDITIONS + HARVESTS);

      // ① head 的欄位固定。
      const head = JSON.parse(await fs.promises.readFile(`${dir}/head.json`, "utf8"));
      expect(Object.keys(head).sort()).toEqual(["checkpoint", "cityId", "rulesVersion", "schemaVersion", "segment"]);
      expect(fs.statSync(`${dir}/head.json`).size).toBeLessThan(256);

      // 沒有 checkpoint 之前：每一段、每一個內容檔都還在單檔上限內。
      const before = filesOf(dir);
      for (const file of before) expect(file.bytes).toBeLessThan(LIMIT);
      expect(before.filter((file) => file.path.includes("/journal/")).length).toBeGreaterThan(1);

      const checkpointed = await ledger.checkpoint();
      expect(checkpointed.seq).toBe(state.lastSeq);
      expect(checkpointed.counts).toMatchObject({ tiles: EXPEDITIONS, ops: EXPEDITIONS + HARVESTS, claims: HARVESTS });

      // ④ 索引頁與座標分塊也都 ≤ 256 KiB，而且真的拆過。
      const after = filesOf(dir);
      for (const file of after) expect(file.bytes).toBeLessThan(LIMIT);
      const ckptPages = new PrefixIndex({ io: createFileIo(), dir: `${dir}/checkpoints/${state.lastSeq}/ops`, limit: LIMIT });
      expect(await ckptPages.countPages()).toBeGreaterThan(1);
      expect(await ckptPages.get("harvest:1")).toBe(EXPEDITIONS + 1);

      // 每一筆都查得回來：整批走訪一次索引，再抽查查詢路徑。
      const ops = await new PrefixIndex({ io: createFileIo(), dir: `${dir}/checkpoints/${state.lastSeq}/ops`, limit: LIMIT }).all();
      const claims = await new PrefixIndex({ io: createFileIo(), dir: `${dir}/checkpoints/${state.lastSeq}/claims`, limit: LIMIT }).all();
      expect(ops.size).toBe(EXPEDITIONS + HARVESTS);
      expect(claims.size).toBe(HARVESTS);
      for (const index of [0, 1, 999, 9_999, 54_321, HARVESTS - 1]) {
        expect(await ledger.lookupOp(`harvest:${index}`)).toEqual({ seq: EXPEDITIONS + index, source: "checkpoint" });
        expect(await ledger.lookupClaim(`claim-${index}`)).toEqual({ seq: EXPEDITIONS + index, source: "checkpoint" });
      }
      expect(await ledger.lookupOp("沒有這一筆")).toBeNull();
      expect(await ledger.lookupClaim("沒有這個 claim")).toBeNull();

      const expedition = await ledger.lookupExpedition("sess-777");
      expect(expedition.source).toBe("checkpoint");
      expect(expedition.tile).toMatchObject({ seq: 777, ...coordOf(777), generation: 1, harvestPoints: 9 * 20 });
      expect(await ledger.lookupExpedition("sess-99999")).toBeNull();

      // 座標分塊：地圖查得到同一個 32×32 格裡的格子。
      const chunk = await ledger.tilesInChunk(coordOf(0).x, coordOf(0).y);
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.every((tile) => Math.floor(tile.x / 32) === Math.floor(coordOf(0).x / 32))).toBe(true);

      // ③ checkpoint 後重播與完整 journal 一致；歷程查詢仍定位得到遠征。
      const replayDir = `${dir}-replay`;
      fs.cpSync(dir, replayDir, { recursive: true });
      const headPath = `${replayDir}/head.json`;
      const plain = JSON.parse(fs.readFileSync(headPath, "utf8"));
      fs.writeFileSync(headPath, `${JSON.stringify({ ...plain, checkpoint: -1 })}\n`);
      const full = await open(replayDir);
      const [withCheckpoint, withoutCheckpoint] = await Promise.all([ledger.state(), full.state()]);
      expect(withoutCheckpoint.tiles).toEqual(withCheckpoint.tiles);
      expect([...withoutCheckpoint.activities]).toEqual([...withCheckpoint.activities]);
      expect([...withoutCheckpoint.opSeqs]).toEqual([...withCheckpoint.opSeqs]);
      expect([...withoutCheckpoint.claims]).toEqual([...withCheckpoint.claims]);
      expect(withoutCheckpoint.resources).toEqual(withCheckpoint.resources);

      const history = await ledger.historyOf("sess-777", 1);
      expect(history.expedition).toMatchObject({ seq: 777, ...coordOf(777) });
      expect(history.entries.filter((entry) => entry.kind === "harvest")).toHaveLength(9);

      const finished = performance.now();
      const sizes = filesOf(dir);
      console.log(
        JSON.stringify({
          capacity: {
            writeMs: Math.round(written - started),
            totalMs: Math.round(finished - started),
            entries: EXPEDITIONS + HARVESTS,
            segments: (await ledger.scanSegments()).length,
            files: sizes.length,
            maxFile: Math.max(...sizes.map((file) => file.bytes)),
            headBytes: fs.statSync(`${dir}/head.json`).size,
          },
        }),
      );
      expect(Math.max(...sizes.map((file) => file.bytes))).toBeLessThan(LIMIT);
      expect((await townsOf(ledger)).cities[0].tiles).toHaveLength(EXPEDITIONS);
    },
    900_000,
  );
});
