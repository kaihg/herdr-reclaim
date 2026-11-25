// OMP adapter 的事件重播接點：活動檔 → journal → 共用城市。
//
// 這一支釘住的是「重播」本身：同一份事件不管分幾次、重播幾次，帳本裡的 activity 都是完整
// 的事件序列（visit、區間、用量），而且只有互動 root／fork 的已結束回合會進共用庫存計量器。
// 走的是正式載入路徑（`loadCity`），不是直接組 entry。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { loadCity } from "../core/city-load.js";
import { CityLedger } from "../core/ledger.js";
import { SHARED_CITY_ID, sharedCityDir } from "../core/shared-city.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/omp-adapter-fixture/.git";
const ROOT = "root-session";
const at = (ms) => ms;

function activity({ sessionId, role = "root", interactive = true, parentSessionId, writerEpoch, events }) {
  return {
    schema: 1,
    cli: "omp",
    cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true },
    sessionId,
    role,
    interactive,
    ...(parentSessionId ? { parentSessionId } : {}),
    writerEpoch,
    events: events.map((event, index) => ({ eventSeq: index + 1, ...event })),
    updatedAt: Math.max(...events.map((event) => event.at)),
  };
}

function visit(session, startedAt, commonDir = CITY) {
  return { kind: "visit_start", at: at(startedAt), visit: { visitId: session, cwd: "/tmp/omp-adapter-fixture", commonDir, checkout: "/tmp/omp-adapter-fixture" } };
}

function usage(sessionId, sourceEntryId, inputNonCache, time = 60_000) {
  return {
    kind: "usage",
    at: time,
    sourceEntryId,
    usage: {
      openai: {
        sourceKey: `omp#${sessionId}#${sourceEntryId}`,
        inputNonCache,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        costKnown: 0,
        costUnknownEntries: 1,
      },
    },
  };
}

/** 五支 session：root 的兩個 epoch、child、互動 fork、print。 */
function replay() {
  const rootOld = activity({
    sessionId: ROOT,
    writerEpoch: "root-old",
    // 用量事件落在回合內（open 之後、close 之前）：共用城市只結算已結束回合裡的用量。
    events: [visit("root-v1", 0), { kind: "interval_open", at: 0 }, { kind: "heartbeat", at: 60_000 }, usage(ROOT, "entry-1", 10), { kind: "interval_close", at: 60_000 }],
  });
  const rootResumed = activity({
    sessionId: ROOT,
    writerEpoch: "root-resumed",
    events: [visit("root-v2", 100_000), { kind: "interval_open", at: 100_000 }, usage(ROOT, "entry-1", 10), usage(ROOT, "entry-2", 5), { kind: "heartbeat", at: 120_000 }, { kind: "interval_close", at: 120_000 }],
  });
  const child = activity({
    sessionId: "task-child",
    role: "child",
    interactive: false,
    parentSessionId: ROOT,
    writerEpoch: "child-one",
    events: [visit("child-v1", 30_000), { kind: "interval_open", at: 30_000 }, { kind: "heartbeat", at: 90_000 }, usage("task-child", "child-entry", 3, 90_000), { kind: "interval_close", at: 90_000 }],
  });
  const fork = activity({
    sessionId: "fork-session",
    role: "fork",
    parentSessionId: ROOT,
    writerEpoch: "fork-one",
    events: [visit("fork-v1", 10_000), { kind: "interval_open", at: 10_000 }, usage("fork-session", "fork-own", 2, 20_000), { kind: "interval_close", at: 20_000 }],
  });
  const print = activity({
    sessionId: "print-session",
    interactive: false,
    writerEpoch: "print-one",
    events: [visit("print-v1", 0), { kind: "interval_open", at: 0 }, { kind: "interval_close", at: 30_000 }, usage("print-session", "print-entry", 99, 30_000)],
  });
  return [rootOld, rootResumed, child, fork, print];
}

const root = () => fs.mkdtempSync("/tmp/reclaim-omp-adapter-");
const list = async () => [];
/** 正式載入路徑；活動直接給（這一支測的是重播，不測 adapter 寫檔）。 */
const load = (base, activities, { activateAt = 0 } = {}) =>
  loadCity(createFileIo(), { root: base, list, activities, now: 200_000, activateAt });
const openShared = (base) => new CityLedger({ io: createFileIo(), dir: sharedCityDir(base), cityId: SHARED_CITY_ID }).open();

describe("OMP 活動重播到共用城市", () => {
  test("互動 root 與 fork 算工作；print 不算；child 併進 root；resume 的用量來源只算一次", async () => {
    const base = root();
    try {
      const loaded = await load(base, replay());
      // entry-1 在 root 的兩個 epoch 都出現，只發一次：10 + 5 + child 3 + fork 2 = 20。
      // print 的 99 不計（非互動）。
      expect(loaded.city.city.work.tokens).toBe(20);
      expect(loaded.city.city.resources).toEqual({ wood: 0, stone: 0, iron: 0 });
      // 五個 writer epoch 都有一筆 activity entry。
      const state = await (await openShared(base)).state();
      expect([...state.activities.keys()].sort()).toEqual([
        "fork-session@@fork-one",
        "print-session@@print-one",
        "root-session@@root-old",
        "root-session@@root-resumed",
        "task-child@@child-one",
      ]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("ack compact 後的新尾巴接回 journal，不會失去原 visit、interval 或用量", async () => {
    const base = root();
    try {
      const full = activity({
        sessionId: ROOT,
        writerEpoch: "root-compact",
        events: [
          visit("root-v1", 0),
          { kind: "interval_open", at: 0 },
          { kind: "heartbeat", at: 60_000 },
          usage(ROOT, "entry-1", 10, 60_000),
          { kind: "interval_close", at: 60_000 },
        ],
      });
      // 第一次只送前半段（模擬 adapter 在中途寫入）：回合還沒結束，不結算。
      const head = { ...full, events: full.events.slice(0, 3) };
      const first = await load(base, [head]);
      expect(first.city.city.work.tokens).toBe(0);
      // 帳本寫了 ack：adapter 下一次會把已入帳的事件砍掉。
      const acked = await (await openShared(base)).readAck(ROOT, "root-compact");
      expect(acked.ackedEventSeq).toBe(3);

      // 第二次只送尾巴（visit／interval_open 已經被砍掉）：帳本要把事件併回舊快照。
      const tail = { ...full, events: full.events.slice(3) };
      const second = await load(base, [tail]);
      expect(second.city.city.work.tokens).toBe(10); // 回合在尾巴才關起來，只結算一次
      const state = await (await openShared(base)).state();
      const stored = state.activities.get(`${ROOT}@@root-compact`);
      expect(stored.events.map((event) => event.kind)).toEqual([
        "visit_start", "interval_open", "heartbeat", "usage", "interval_close",
      ]);
      expect(stored.events[0].visit.commonDir).toBe(CITY);
      const ackedAgain = await (await openShared(base)).readAck(ROOT, "root-compact");
      expect(ackedAgain.ackedEventSeq).toBe(5);

      // 重開帳本（herdr 關掉再開）：重播得到同一份事件與同一個計量器。
      const reopened = await load(base, []);
      expect(reopened.city.city.work.tokens).toBe(10);
      expect((await (await openShared(base)).state()).activities.get(`${ROOT}@@root-compact`).events).toHaveLength(5);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("同一份活動重播兩次結果相同，也不會重寫 journal", async () => {
    const base = root();
    try {
      const records = replay();
      const first = await load(base, records);
      const afterFirst = await (await openShared(base)).state();
      const second = await load(base, records);
      const afterSecond = await (await openShared(base)).state();
      expect(second.city).toEqual(first.city);
      expect(afterSecond.lastSeq).toBe(afterFirst.lastSeq);
      expect([...afterSecond.activities]).toEqual([...afterFirst.activities]);
      expect([...afterSecond.claims]).toEqual([...afterFirst.claims]);
      expect(afterSecond.resources).toEqual(afterFirst.resources);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
