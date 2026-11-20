// 儲存層的驗收：journal entry 是唯一完成依據、CAS 競爭、checkpoint、ack（ticket #3）。
// 故障只注入 ticket 指定的兩個點：「內容已寫、journal 未附加」與「journal 已附加、回覆前」。
// 這一層用 node fs 的後端（test/fs-io.js）；mod 端走的是 herdr 的 writeTextFile。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { bfsNextTile } from "../core/grid.js";
import { CrashAfterContent, CrashAfterJournal, CityLedger, byteLen } from "../core/ledger.js";
import { ingestActivities } from "../core/ingest.js";
import { readTownFromLedger } from "../core/town.js";
import { AT } from "../scenarios/first-expedition.js";
import { createFileIo } from "./fs-io.js";

const CITY_ID = "city-durable";
const dirOf = (name) => `/tmp/reclaim-3-ledger/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

async function open(dir, io = createFileIo(), options = {}) {
  return new CityLedger({ io, dir, cityId: CITY_ID, ...options }).open();
}

/** 一筆活動紀錄（帶內容檔）。 */
const activityOp = (sessionId, { lastEventSeq = 1, events = [{ eventSeq: 1, kind: "interval_open", at: AT }] } = {}) => ({
  opId: `activity:${sessionId}:epoch-1:${lastEventSeq}`,
  kind: "activity",
  at: AT,
  sessionId,
  writerEpoch: "epoch-1",
  role: "root",
  interactive: true,
  parentSessionId: null,
  cli: "omp",
  updatedAt: AT,
  lastEventSeq,
  blobs: { events },
});

/** 「遠征取得土地」：座標依當下的狀態用 BFS 算，像 mod 那一端。 */
const expeditionOp = (state, sessionId, cityId = CITY_ID) => {
  const taken = new Set(state.tiles.filter((tile) => tile.cityId === cityId).map((tile) => `${tile.x},${tile.y}`));
  const spot = bfsNextTile((candidate) => taken.has(`${candidate.x},${candidate.y}`));
  return {
    opId: `expedition:${cityId}:${sessionId}:1`,
    kind: "expedition",
    at: AT,
    cityId,
    rootSessionId: sessionId,
    generation: 1,
    x: spot.x,
    y: spot.y,
    cli: "omp",
    repo: { commonDir: cityId, checkout: `/reclaim/${cityId}` },
  };
};

const townsOf = async (ledger) => {
  const state = await ledger.state();
  return readTownFromLedger({ activities: [...state.activities.values()], expeditions: state.tiles });
};

function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** 複製一座城，但 head 的 checkpoint 歸零：從頭重播。 */
function copyWithoutCheckpoint(source, target) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(`${source}/journal`, `${target}/journal`, { recursive: true });
  if (fs.existsSync(`${source}/blobs`)) fs.cpSync(`${source}/blobs`, `${target}/blobs`, { recursive: true });
  const head = JSON.parse(fs.readFileSync(`${source}/head.json`, "utf8"));
  head.checkpoint = -1;
  fs.writeFileSync(`${target}/head.json`, `${JSON.stringify(head)}\n`);
}

describe("城帳本：完成、重試與 CAS", () => {
  test("內容檔已寫、journal 未附加時中斷：重開後未完成、可重試且只算一次", async () => {
    const dir = dirOf("crash-content");
    const ledger = await open(dir);
    const crashed = await ledger.submit(() => activityOp("sess-a"), { crash: "after-content" }).catch((error) => error);
    expect(crashed).toBeInstanceOf(CrashAfterContent);

    // 只有內容檔，沒有 entry：狀態不變。
    expect(filesUnder(`${dir}/blobs`)).toHaveLength(1);
    const reopened = await open(dir);
    expect((await reopened.state()).activities).toHaveLength(0);

    // 重試同一筆：這次完成，而且沒有多寫內容檔。
    const retry = await reopened.submit(() => activityOp("sess-a"));
    expect(retry.status).toBe("applied");
    expect((await reopened.state()).activities).toHaveLength(1);
    expect(filesUnder(`${dir}/blobs`)).toHaveLength(1);
    expect(await townsOf(reopened)).toEqual(await townsOf(ledger));
  });

  test("journal 已附加、回覆前中斷：重開後視為完成，重送不重複", async () => {
    const dir = dirOf("crash-journal");
    const ledger = await open(dir);
    const crashed = await ledger
      .submit((state) => expeditionOp(state, "sess-a"), { crash: "after-journal" })
      .catch((error) => error);
    expect(crashed).toBeInstanceOf(CrashAfterJournal);

    const reopened = await open(dir);
    expect((await reopened.state()).tiles).toHaveLength(1);

    const again = await reopened.submit((state) => expeditionOp(state, "sess-a"));
    expect(again.status).toBe("duplicate");
    expect((await reopened.state()).tiles).toHaveLength(1);
    expect((await townsOf(reopened)).cities[0].tiles).toHaveLength(1);
  });

  test("兩個畫面同時搶同一格：CAS 只讓一方成功，另一方重讀後重新選地", async () => {
    const dir = dirOf("race");
    const gate = Promise.withResolvers();
    let arrivals = 0;
    let released = false;
    const io = createFileIo({
      async beforeWrite(file, expected) {
        // 只在「附加到第 0 段」時排隊：兩個寫入者都從同一份空快照出發。
        if (released || !file.endsWith("/journal/0.json") || expected === null) return;
        arrivals += 1;
        if (arrivals === 2) {
          released = true;
          gate.resolve();
          return;
        }
        await gate.promise;
      },
    });
    const a = await open(dir, io);
    const b = await open(dir, io);

    const results = await Promise.all([
      a.submit((state) => expeditionOp(state, "sess-a")),
      b.submit((state) => expeditionOp(state, "sess-b")),
    ]);

    expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
    const state = await a.state();
    expect(state.tiles).toHaveLength(2);
    expect(new Set(state.tiles.map((tile) => `${tile.x},${tile.y}`))).toEqual(new Set(["0,-1", "1,0"]));
    expect((await townsOf(a)).cities[0].tiles).toHaveLength(2);
  });

  test("同樣的 operation ID 再送一次（即使內容不同）不會改變狀態", async () => {
    const dir = dirOf("dedupe");
    const ledger = await open(dir);
    expect((await ledger.submit(() => activityOp("sess-a"))).status).toBe("applied");

    const again = await ledger.submit(() => activityOp("sess-a", { events: [] }));
    expect(again.status).toBe("duplicate");
    const state = await ledger.state();
    expect([...state.activities.values()][0].events).toHaveLength(1);
  });

  test("前提不符：座標已被別的遠征佔走時整筆拒絕，不寫入", async () => {
    const dir = dirOf("precheck");
    const ledger = await open(dir);
    expect((await ledger.submit((state) => expeditionOp(state, "sess-a"))).status).toBe("applied");

    // 直接指定一個已經被佔用的座標。
    const conflict = await ledger.submit(() => ({
      opId: "expedition:manual:sess-b:1",
      kind: "expedition",
      at: AT,
      cityId: CITY_ID,
      rootSessionId: "sess-b",
      generation: 1,
      x: 0,
      y: -1,
    }));
    expect(conflict.status).toBe("rejected");
    expect(conflict.reason).toBe("tile_taken");
    expect((await ledger.state()).tiles).toHaveLength(1);
  });

  test("ack 在 journal 成功之後才寫；有 ack 與沒有 ack 的重播結果相同", async () => {
    const dir = dirOf("ack");
    const ledger = await open(dir);
    const applied = await ledger.submit((state) => expeditionOp(state, "sess-a"));
    await ledger.submit(() => activityOp("sess-a", { lastEventSeq: 3 }));
    await ledger.writeAck({ sessionId: "sess-a", writerEpoch: "epoch-1", ackedEventSeq: 3, journalSeq: applied.journalSeq });

    expect(await ledger.readAck("sess-a", "epoch-1")).toMatchObject({ ackedEventSeq: 3 });
    const withAck = await townsOf(ledger);

    // 另一座城只有 journal、沒有 ack 檔：重播結果一樣。
    const otherDir = dirOf("ack-none");
    copyWithoutCheckpoint(dir, otherDir);
    fs.rmSync(`${otherDir}/checkpoints`, { recursive: true, force: true });
    expect(filesUnder(otherDir).some((file) => file.includes("/acks/"))).toBe(false);

    expect(await townsOf(await open(otherDir))).toEqual(withAck);
  });

  test("兩個視窗同時寫同一個 epoch 的 ack：兩個都成功，內容一致", async () => {
    const dir = dirOf("ack-race");
    const gate = Promise.withResolvers();
    let arrivals = 0;
    let released = false;
    const io = createFileIo({
      async beforeWrite(file, expected) {
        if (released || !file.includes("/acks/") || expected === null) return;
        arrivals += 1;
        if (arrivals === 2) {
          released = true;
          gate.resolve();
          return;
        }
        await gate.promise;
      },
    });
    const a = await open(dir, io);
    const b = await open(dir, io);
    const applied = await a.submit((state) => expeditionOp(state, "sess-a"));
    const ack = { sessionId: "sess-a", writerEpoch: "epoch-1", ackedEventSeq: 3, journalSeq: applied.journalSeq };

    // 先把 ack 檔準備成「兩個視窗都讀到同一份舊內容」，逼出競態。
    await a.writeAck({ ...ack, ackedEventSeq: 1 });
    await Promise.all([a.writeAck(ack), b.writeAck(ack)]);
    expect(await a.readAck("sess-a", "epoch-1")).toEqual(ack);
  });

  test("ack 只跟在 journal 後面：回覆前中斷時 ack 晚到，重播補上而且城鎮不變", async () => {
    const dir = dirOf("ack-late");
    const ledger = await open(dir);
    const crashed = await ledger.submit(() => activityOp("sess-a"), { crash: "after-journal" }).catch((error) => error);
    expect(crashed).toBeInstanceOf(CrashAfterJournal);

    // 崩潰在回覆前：ack 還沒寫，但這筆操作已經完成。
    expect(await ledger.readAck("sess-a", "epoch-1")).toBeNull();
    const committed = await ledger.state();

    // 重播同一筆：entry 已經在（duplicate），ack 用 entry 的位置補上；狀態不變。
    const retry = await ledger.submit(() => activityOp("sess-a"));
    expect(retry.status).toBe("duplicate");
    expect(retry.journalSeq).toBe(0);
    await ledger.writeAck({ sessionId: "sess-a", writerEpoch: "epoch-1", ackedEventSeq: 1, journalSeq: retry.journalSeq });
    expect(await ledger.readAck("sess-a", "epoch-1")).toEqual({
      sessionId: "sess-a",
      writerEpoch: "epoch-1",
      ackedEventSeq: 1,
      journalSeq: 0,
    });
    expect(await ledger.state()).toEqual(committed);
  });

  test("寫入者送活動紀錄時，只有已提交的紀錄會被 ack", async () => {
    const dir = dirOf("ack-ingest");
    const ledger = await open(dir);
    const record = {
      schema: 1,
      cli: "omp",
      sessionId: "sess-a",
      role: "root",
      interactive: true,
      writerEpoch: "epoch-1",
      updatedAt: AT,
      events: [
        { eventSeq: 1, kind: "visit_start", at: AT, visit: { visitId: "v1", cwd: "/reclaim", commonDir: CITY_ID, checkout: "/reclaim" } },
        { eventSeq: 2, kind: "interval_open", at: AT },
      ],
    };
    await ingestActivities(ledger, [record], CITY_ID);
    expect(await ledger.readAck("sess-a", "epoch-1")).toEqual({
      sessionId: "sess-a",
      writerEpoch: "epoch-1",
      ackedEventSeq: 2,
      journalSeq: 0,
    });
  });

  test("單段放不下就封段換下一段：所有 entry 都讀得回來，每一段都在上限內", async () => {
    const dir = dirOf("rotate");
    const ledger = await open(dir, createFileIo(), { segmentLimit: 600 });
    for (const sessionId of ["sess-a", "sess-b", "sess-c"]) {
      expect((await ledger.submit((state) => expeditionOp(state, sessionId))).status).toBe("applied");
    }

    const segments = await ledger.scanSegments();
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) expect(byteLen(segment.text)).toBeLessThanOrEqual(600);
    expect(segments.slice(0, -1).every((segment) => segment.sealed)).toBe(true);

    const reopened = await open(dir, createFileIo(), { segmentLimit: 600 });
    expect((await reopened.state()).tiles).toHaveLength(3);
    expect(await townsOf(reopened)).toEqual(await townsOf(ledger));
  });

  test("checkpoint 只讓讀取變快：狀態與 checkpoint 無關", async () => {
    const dir = dirOf("checkpoint");
    const ledger = await open(dir);
    await ledger.submit((state) => expeditionOp(state, "sess-a"));
    await ledger.checkpoint();
    await ledger.submit((state) => expeditionOp(state, "sess-b"));
    const afterCheckpoint = await ledger.state();

    const scratch = dirOf("checkpoint-scratch");
    copyWithoutCheckpoint(dir, scratch);
    expect(await (await open(scratch)).state()).toEqual(afterCheckpoint);
  });
});
