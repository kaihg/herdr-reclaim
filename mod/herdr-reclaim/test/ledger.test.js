// 儲存層的驗收：journal entry 是唯一完成依據、CAS 競爭、checkpoint、ack（ticket #3）。
// 故障只注入 ticket 指定的兩個點：「內容已寫、journal 未附加」與「journal 已附加、回覆前」。
// 這一層用 node fs 的後端（test/fs-io.js）；mod 端走的是 herdr 的 writeTextFile。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { bfsNextTile } from "../core/grid.js";
import { CasConflict, CityLedger, CrashAfterContent, CrashAfterJournal, CrashAfterSeal, byteLen, claimKey, hashText, tileId } from "../core/ledger.js";
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
    expect(new Set(state.tiles.map((tile) => `${tile.x},${tile.y}`))).toEqual(new Set(["0,-1", "1,-1"]));
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

describe("journal 快照的一致性與封段後的中斷恢復", () => {
  test("掃描與 CAS 用同一份快照：兩次讀取之間別人附加的 entry 不會造成重複序號", async () => {
    const dir = dirOf("snapshot-race");
    const base = createFileIo();
    // 另一個寫入者（另一個 pane）在 A 掃完最後一段、還在讀第二次之前，附加了它的 entry。
    const otherEntry = {
      journalSeq: 0,
      opId: "expedition:other:sess-other:1",
      kind: "expedition",
      at: AT,
      cityId: CITY_ID,
      rootSessionId: "sess-other",
      generation: 1,
      x: 1,
      y: 0,
      cli: "omp",
      repo: { commonDir: CITY_ID, checkout: "/reclaim/city-durable" },
    };
    let injected = false;
    const io = {
      async read(file) {
        const text = await base.read(file);
        // 讀到「第 1 段不存在」＝掃描走到尾端了；就在這個時候讓別人附加。
        if (!injected && file === `${dir}/journal/1.json` && text === null) {
          injected = true;
          fs.appendFileSync(`${dir}/journal/0.json`, `${JSON.stringify(otherEntry)}\n`);
        }
        return text;
      },
      write: (file, text, expected) => base.write(file, text, expected),
    };
    const ledger = await open(dir, io);
    expect((await ledger.submit((state) => expeditionOp(state, "sess-a"))).status).toBe("applied");
    expect(injected).toBe(true);

    // 序號單調遞增、不重複；即時記憶體與完整重播說同一件事。
    const seqs = (await ledger.scanSegments()).flatMap((segment) => segment.entries).map((entry) => entry.journalSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(await townsOf(await open(dir))).toEqual(await townsOf(ledger));
  });

  test("封段完成、下一段還沒建立就中斷：重開後由讀到 seal 的寫入者補上，仍可提交", async () => {
    const dir = dirOf("crash-seal");
    const limit = 600;
    const ledger = await open(dir, createFileIo(), { segmentLimit: limit });
    // 先注入一次「封段 CAS 成功、建立下一段之前」的中斷（head 也還沒更新）。
    let crashed = null;
    for (let index = 0; index < 12 && crashed === null; index++) {
      const result = await ledger
        .submit((state) => expeditionOp(state, `sess-${index}`), { crash: "after-seal" })
        .catch((error) => error);
      if (result instanceof CrashAfterSeal) crashed = result;
      else expect(result.status).toBe("applied");
    }
    expect(crashed).toBeInstanceOf(CrashAfterSeal);

    // 重開（open 只會補第 0 段）：讀到 seal 的寫入者補上下一段，之後照常提交。
    const reopened = await open(dir, createFileIo(), { segmentLimit: limit });
    expect((await reopened.submit((state) => expeditionOp(state, "sess-after-crash"))).status).toBe("applied");
    const after = await reopened.scanSegments();
    expect(after.slice(0, -1).every((segment) => segment.sealed)).toBe(true);
    for (const segment of after) expect(byteLen(segment.text)).toBeLessThanOrEqual(limit);
    expect(await townsOf(await open(dir, createFileIo(), { segmentLimit: limit }))).toEqual(await townsOf(reopened));
  });

  test("中斷留下的檔案狀態（seal 已寫、下一段不在、head 還指著 seal）不再讓提交永遠失敗", async () => {
    const dir = dirOf("sealed-gap");
    const limit = 600;
    const ledger = await open(dir, createFileIo(), { segmentLimit: limit });
    let index = 0;
    while (fs.readdirSync(`${dir}/journal`).length < 2) {
      expect((await ledger.submit((state) => expeditionOp(state, `sess-${index}`))).status).toBe("applied");
      index += 1;
    }
    // 把「封段之後才建立的那一段」拿掉，並把 head 退回已封的那一段：這就是中斷留下的現場。
    const highest = Math.max(...fs.readdirSync(`${dir}/journal`).map((file) => Number(file.replace(".json", ""))));
    fs.rmSync(`${dir}/journal/${highest}.json`);
    const head = JSON.parse(fs.readFileSync(`${dir}/head.json`, "utf8"));
    fs.writeFileSync(`${dir}/head.json`, `${JSON.stringify({ ...head, segment: highest - 1 })}\n`);
    expect(JSON.parse(fs.readFileSync(`${dir}/journal/${highest - 1}.json`, "utf8").trimEnd().split("\n").at(-1)).seal).toBeGreaterThanOrEqual(0);

    const reopened = await open(dir, createFileIo(), { segmentLimit: limit });
    const next = await reopened.submit((state) => expeditionOp(state, "sess-recovered"));
    // 舊碼會對不存在的檔案反覆 CAS 失敗：{status:"stale", attempts:8}。
    expect(next.status).toBe("applied");
    const entries = (await reopened.scanSegments()).flatMap((segment) => segment.entries);
    expect(entries.at(-1).opId).toBe(`expedition:${CITY_ID}:sess-recovered:1`);
    expect(await townsOf(await open(dir, createFileIo(), { segmentLimit: limit }))).toEqual(await townsOf(reopened));
  });

  test("兩個畫面同時第一次寫入同一份內容：兩邊都成功，內容只寫一次", async () => {
    const dir = dirOf("blob-race");
    const base = createFileIo();
    let racerWon = false;
    const io = {
      read: (file) => base.read(file),
      // 另一個 pane 搶先在 expected=null 建立同一個內容檔（檔名就是內容雜湊）。
      async write(file, text, expected) {
        if (!racerWon && expected === null && file.includes("/blobs/")) {
          racerWon = true;
          await base.write(file, text, null);
          throw new CasConflict(file, "exists");
        }
        return base.write(file, text, expected);
      },
    };
    const ledger = await open(dir, io);
    expect((await ledger.submit(() => activityOp("sess-a"))).status).toBe("applied");
    expect(racerWon).toBe(true);
    expect([...(await ledger.state()).activities.values()][0].events).toHaveLength(1);
    expect(filesUnder(`${dir}/blobs`)).toHaveLength(1);
    expect(await townsOf(await open(dir))).toEqual(await townsOf(ledger));
  });
});

describe("checkpoint 是衍生索引：不完整就整份丟棄、從 journal 重建", () => {
  const harvestAt = (sessionId, claim) => ({
    opId: `harvest:${sessionId}:${claim}`,
    kind: "harvest",
    at: AT,
    cityId: CITY_ID,
    rootSessionId: sessionId,
    generation: 1,
    claim,
    points: 20,
    resources: { wood: 10 },
    blobs: { claim, paths: [`src/${claim}.ts`] },
  });

  test("manifest 壞掉：從 journal 重建，不是整座城讀不出來", async () => {
    const dir = dirOf("ckpt-manifest");
    const ledger = await open(dir);
    await ledger.submit((state) => expeditionOp(state, "sess-a"));
    await ledger.submit(() => harvestAt("sess-a", "claim-1"));
    const expected = await townsOf(ledger);
    const { seq } = await ledger.checkpoint();
    fs.writeFileSync(`${dir}/checkpoints/${seq}/manifest.json`, "{ 壞掉的 JSON");

    const reopened = await open(dir);
    expect(await townsOf(reopened)).toEqual(expected);
    expect((await reopened.state()).claims.size).toBe(1);
  });

  test("索引頁不見了：庫存與去重資料不會跟著少，已領過的 claim 仍被擋下", async () => {
    const dir = dirOf("ckpt-missing-page");
    const ledger = await open(dir, createFileIo(), { pageLimit: 700 });
    const sessions = ["sess-a", "sess-b", "sess-c", "sess-d"];
    for (const sessionId of sessions) {
      expect((await ledger.submit((state) => expeditionOp(state, sessionId))).status).toBe("applied");
      expect((await ledger.submit(() => harvestAt(sessionId, `claim-${sessionId}`))).status).toBe("applied");
    }
    const { seq } = await ledger.checkpoint();
    const claimsDir = `${dir}/checkpoints/${seq}/claims`;
    const lostClaim = `claim-${sessions[0]}`;
    const prefix = hashText(claimKey(CITY_ID, lostClaim)).slice(0, 2);
    const root = JSON.parse(fs.readFileSync(`${claimsDir}/root.json`, "utf8"));
    expect(root.c).toContain(prefix); // 這個 claim 真的在這一頁
    fs.rmSync(`${claimsDir}/${prefix}.json`);

    const reopened = await open(dir, createFileIo(), { pageLimit: 700 });
    const state = await reopened.state();
    expect(state.claims.size).toBe(sessions.length);
    expect(state.opSeqs.size).toBe(sessions.length * 2);
    // 已經領過的成果再送一次（不同 operation ID）：城級去重仍然擋得住。
    const duplicate = await reopened.submit(() => ({ ...harvestAt(sessions[0], lostClaim), opId: "harvest:other-id" }));
    expect(duplicate.status).toBe("rejected");
    expect(duplicate.reason).toBe("claim_exists");
    expect((await reopened.state()).resources.wood).toBe(sessions.length * 10);
    // 壞掉的 checkpoint 已經從 head 拿掉，讀取端不會每次都再讀一次。
    expect(JSON.parse(fs.readFileSync(`${dir}/head.json`, "utf8")).checkpoint).toBe(-1);
  });

  test("同一個座標大量撤回重用：checkpoint 不再因座標分塊超限而失敗，歷程仍完整", async () => {
    const dir = dirOf("chunk-reuse");
    const pageLimit = 512;
    const ledger = await open(dir, createFileIo(), { pageLimit });
    const generations = 40;
    const repo = { commonDir: CITY_ID, checkout: "/reclaim/city-durable" };
    const reclaim = (generation) => ({
      opId: `expedition:${CITY_ID}:sess-cycle:${generation}`,
      kind: "expedition",
      at: AT + generation,
      activatedAt: AT + generation,
      cityId: CITY_ID,
      rootSessionId: "sess-cycle",
      generation,
      x: 0,
      y: -1,
      cli: "omp",
      repo,
    });
    for (let generation = 1; generation <= generations; generation++) {
      expect((await ledger.submit(() => reclaim(generation))).status).toBe("applied");
      expect((await ledger.submit(() => ({
        opId: `withdraw:${CITY_ID}:sess-cycle:${generation}`,
        kind: "landAction",
        at: AT + generation,
        cityId: CITY_ID,
        rootSessionId: "sess-cycle",
        generation,
        action: "withdraw",
      }))).status).toBe("applied");
    }

    // 同一格已經全部撤回：沒有「畫得出來、佔得住」的格子，分塊是空的（不會被撐爆）。
    const checkpointed = await ledger.checkpoint();
    expect(checkpointed.counts.chunks).toBe(0);
    expect(checkpointed.counts.tiles).toBe(generations);
    for (const file of filesUnder(`${dir}/blobs`)) expect(fs.statSync(file).size).toBeLessThan(pageLimit);
    // manifest 是固定欄位的小索引（resources／counts／digests），不受分頁上限約束；
    // 其餘衍生檔案（索引頁、座標分塊）都還在 pageLimit 內。
    for (const file of filesUnder(`${dir}/checkpoints`)) {
      expect(fs.statSync(file).size).toBeLessThan(file.endsWith("/manifest.json") ? 256 * 1024 : pageLimit);
    }
    for (const file of filesUnder(dir)) expect(fs.statSync(file).size).toBeLessThan(256 * 1024);

    // 歷程與遠征索引仍然查得到每一代（包含已撤回的那些）。
    expect((await ledger.lookupExpedition("sess-cycle", 1)).tile.landStage).toBe("withdrawn");
    expect((await ledger.lookupExpedition("sess-cycle", generations)).tile.generation).toBe(generations);
    const history = await ledger.historyOf("sess-cycle", 7);
    expect(history.entries.filter((entry) => entry.kind === "expedition")).toHaveLength(1);
    expect(history.entries.filter((entry) => entry.kind === "landAction")).toHaveLength(1);
    expect(await ledger.tilesInChunk(0, -1)).toEqual([]);

    // 重新派遣之後：分塊只列活著的那一代。
    expect((await ledger.submit(() => reclaim(generations))).status).toBe("duplicate");
    expect((await ledger.submit(() => reclaim(generations + 1))).status).toBe("applied");
    await ledger.checkpoint();
    expect((await ledger.tilesInChunk(0, -1)).map((tile) => tile.generation)).toEqual([generations + 1]);
    const reopened = await open(dir, createFileIo(), { pageLimit });
    expect(await townsOf(reopened)).toEqual(await townsOf(ledger));
  });
});

describe("摘要驗證只在載入發生一次", () => {
  test("載入之後的 state／submit 不會再讀 checkpoint 的每一頁", async () => {
    const dir = dirOf("verify-once");
    const base = createFileIo();
    let checkpointReads = 0;
    const io = {
      read: async (file) => {
        if (file.includes("/checkpoints/")) checkpointReads += 1;
        return base.read(file);
      },
      write: (file, text, expected) => base.write(file, text, expected),
    };
    const ledger = await open(dir, io);
    expect((await ledger.submit((state) => expeditionOp(state, "sess-a"))).status).toBe("applied");
    expect((await ledger.submit((state) => expeditionOp(state, "sess-b"))).status).toBe("applied");
    await ledger.checkpoint();

    const reopened = await open(dir, io);
    await reopened.state(); // 第一次載入：完整驗一次（head 摘要＋各組索引摘要）
    const afterLoad = checkpointReads;
    expect(afterLoad).toBeGreaterThan(0);

    for (let index = 0; index < 5; index++) {
      await reopened.state(); // 強制重讀：只讀 journal 尾段
      expect((await reopened.submit((state) => expeditionOp(state, `sess-x-${index}`))).status).toBe("applied");
    }
    expect(checkpointReads).toBe(afterLoad);
  });
});

describe("checkpoint 的內容完整性：被改過就不能當資料", () => {
  const harvestAt = (sessionId, claim) => ({
    opId: `harvest:${sessionId}:${claim}`,
    kind: "harvest",
    at: AT + 100,
    cityId: CITY_ID,
    rootSessionId: sessionId,
    generation: 1,
    claim,
    points: 20,
    resources: { wood: 10 },
    blobs: { claim, paths: [`src/${claim}.ts`] },
  });

  /** 一座有格子、有 claim、有庫存的城，並做過一次 checkpoint。 */
  async function checkpointedCity(name, options = {}) {
    const dir = dirOf(name);
    const ledger = await open(dir, createFileIo(), options);
    const sessions = ["sess-a", "sess-b", "sess-c"];
    for (const [index, sessionId] of sessions.entries()) {
      expect((await ledger.submit(() => ({
        opId: `expedition:${CITY_ID}:${sessionId}:1`,
        kind: "expedition",
        at: AT,
        activatedAt: AT + index,
        cityId: CITY_ID,
        rootSessionId: sessionId,
        generation: 1,
        x: index,
        y: -1,
        cli: "omp",
        repo: { commonDir: CITY_ID, checkout: "/reclaim/city-durable" },
      }))).status).toBe("applied");
      expect((await ledger.submit(() => harvestAt(sessionId, `claim-${sessionId}`))).status).toBe("applied");
    }
    const { seq } = await ledger.checkpoint();
    // 從頭重播的答案（不碰 checkpoint）：竄改之後重開必須等於這一份。
    const replayDir = `${dir}-replay`;
    fs.cpSync(dir, replayDir, { recursive: true });
    const headPath = `${replayDir}/head.json`;
    const head = JSON.parse(fs.readFileSync(headPath, "utf8"));
    fs.writeFileSync(headPath, `${JSON.stringify({ ...head, checkpoint: -1, checkpointDigest: null })}\n`);
    const fresh = await open(replayDir, createFileIo(), options);
    return { dir, seq, options, expected: await townsOf(fresh), expectedState: await fresh.state() };
  }

  /** 重開同一座城：等於「從頭重播」，而且 checkpoint 已被丟棄。 */
  async function expectRebuilt({ dir, expected, expectedState, options }, check) {
    const reopened = await open(dir, createFileIo(), options);
    const state = await reopened.state();
    expect(state.resources).toEqual(expectedState.resources);
    expect([...state.claims]).toEqual([...expectedState.claims]);
    expect([...state.opSeqs]).toEqual([...expectedState.opSeqs]);
    expect(state.tiles).toEqual(expectedState.tiles);
    expect(await townsOf(reopened)).toEqual(expected);
    if (check) await check(reopened);
    expect(JSON.parse(fs.readFileSync(`${dir}/head.json`, "utf8")).checkpoint).toBe(-1);
  }

  test("manifest 的數值被改成合法 JSON（庫存 30→98765）：重開等於從頭重播", async () => {
    const city = await checkpointedCity("tamper-manifest");
    const path = `${city.dir}/checkpoints/${city.seq}/manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(manifest.resources.wood).toBe(30);
    manifest.resources.wood = 98765;
    fs.writeFileSync(path, JSON.stringify(manifest));

    await expectRebuilt(city, async (reopened) => {
      const duplicate = await reopened.submit(() => ({ ...harvestAt("sess-a", "claim-sess-a"), opId: "harvest:other-id" }));
      expect(duplicate).toMatchObject({ status: "rejected", reason: "claim_exists" });
    });
  });

  test("claims 子頁內容被換掉（筆數不變）：已領過的 claim 仍被擋下", async () => {
    const city = await checkpointedCity("tamper-claims", { pageLimit: 700 });
    const prefix = hashText(claimKey(CITY_ID, "claim-sess-a")).slice(0, 2);
    const pagePath = `${city.dir}/checkpoints/${city.seq}/claims/${prefix}.json`;
    const page = JSON.parse(fs.readFileSync(pagePath, "utf8"));
    const lostKey = claimKey(CITY_ID, "claim-sess-a");
    expect(Object.keys(page.e)).toContain(lostKey);
    // 筆數不變、內容換掉：把這個 claim 換成一個沒人領過的鍵。
    page.e[claimKey(CITY_ID, "claim-not-real")] = page.e[lostKey];
    delete page.e[lostKey];
    fs.writeFileSync(pagePath, JSON.stringify(page));

    await expectRebuilt(city, async (reopened) => {
      const duplicate = await reopened.submit(() => ({ ...harvestAt("sess-a", "claim-sess-a"), opId: "harvest:other-id" }));
      expect(duplicate).toMatchObject({ status: "rejected", reason: "claim_exists" });
      expect((await reopened.state()).resources.wood).toBe(30);
    });
  });

  test("ops 子頁內容被換掉（筆數不變）：已落帳的操作不會再執行一次", async () => {
    const city = await checkpointedCity("tamper-ops", { pageLimit: 700 });
    const trade = { opId: "trade:one", kind: "trade", at: AT, cityId: CITY_ID, from: "wood", to: "stone", amount: 2, rate: 3 };
    const ledger = await open(city.dir, createFileIo(), city.options);
    expect((await ledger.submit(() => trade)).status).toBe("applied");
    const { seq } = await ledger.checkpoint();
    const prefix = hashText(trade.opId).slice(0, 2);
    const pagePath = `${city.dir}/checkpoints/${seq}/ops/${prefix}.json`;
    const page = JSON.parse(fs.readFileSync(pagePath, "utf8"));
    expect(Object.keys(page.e)).toContain(trade.opId);
    page.e["trade:not-real"] = page.e[trade.opId];
    delete page.e[trade.opId];
    fs.writeFileSync(pagePath, JSON.stringify(page));

    const before = (await ledger.state()).resources;
    const reopened = await open(city.dir, createFileIo(), city.options);
    expect((await reopened.state()).resources).toEqual(before);
    // 這筆操作已經在 journal 裡：不能因為 checkpoint 被丟棄就再執行一次（市集會重複扣料）。
    expect((await reopened.submit(() => trade)).status).toBe("duplicate");
    expect((await reopened.state()).resources).toEqual(before);
  });

  test("expeditions 子頁內容被換掉（筆數不變）：格子與遠征身份仍等於從頭重播", async () => {
    const city = await checkpointedCity("tamper-expeditions", { pageLimit: 512 });
    const id = tileId(CITY_ID, "sess-a", 1);
    const pagePath = `${city.dir}/checkpoints/${city.seq}/expeditions/${hashText(id).slice(0, 2)}.json`;
    const page = JSON.parse(fs.readFileSync(pagePath, "utf8"));
    expect(Object.keys(page.e)).toContain(id);
    page.e[tileId(CITY_ID, "sess-not-real", 1)] = page.e[id];
    delete page.e[id];
    fs.writeFileSync(pagePath, JSON.stringify(page));

    await expectRebuilt(city, async (reopened) => {
      expect(await reopened.lookupExpedition("sess-a", 1)).toMatchObject({ tile: { rootSessionId: "sess-a" } });
    });
  });

  test("內容檔（blob）被改過：checkpoint 不可信，改用完整重播", async () => {
    const city = await checkpointedCity("tamper-blob", { pageLimit: 512 });
    // pageLimit 小 → 遠征紀錄以 blob 形式放進內容檔；改掉其中一個 blob 的內容。
    const blobs = filesUnder(`${city.dir}/blobs`);
    expect(blobs.length).toBeGreaterThan(0);
    fs.writeFileSync(blobs[0], JSON.stringify({ t: "l", d: "被改過的內容" }));

    await expectRebuilt(city, async (reopened) => {
      expect((await reopened.state()).resources.wood).toBe(30);
    });
  });
});
