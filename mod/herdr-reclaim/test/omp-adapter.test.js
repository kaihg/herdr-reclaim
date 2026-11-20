// OMP adapter 的固定事件重播接點：活動檔格式 → journal → 公開城鎮讀取模型。
// 只斷言可觀察到的遠征、工作時間、visit 與用量，不測私有實作細節。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { CityLedger, cityDir } from "../core/ledger.js";
import { ingestActivities, ingestExpeditions, ingestScenario } from "../core/ingest.js";
import { readTown, readTownFromLedger } from "../core/town.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/omp-adapter-fixture/.git";
const ROOT = "root-session";
const at = (ms) => ms;

function activity({ sessionId, role = "root", interactive = true, parentSessionId, writerEpoch, events }) {
  return {
    schema: 1,
    cli: "omp",
    cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
    sessionId,
    role,
    interactive,
    ...(parentSessionId ? { parentSessionId } : {}),
    writerEpoch,
    events: events.map((event, index) => ({ eventSeq: index + 1, ...event })),
    updatedAt: Math.max(...events.map((event) => event.at)),
  };
}

function visit(session, startedAt) {
  return { kind: "visit_start", at: at(startedAt), visit: { visitId: session, cwd: "/tmp/omp-adapter-fixture", commonDir: CITY, checkout: "/tmp/omp-adapter-fixture" } };
}

function usage(sourceEntryId, inputNonCache) {
  return {
    kind: "usage",
    at: 60_000,
    sourceEntryId,
    usage: {
      openai: {
        sourceKey: `omp#${ROOT}#${sourceEntryId}`,
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

function replay() {
  const root = activity({
    sessionId: ROOT,
    writerEpoch: "root-old",
    events: [visit("root-v1", 0), { kind: "interval_open", at: 0 }, { kind: "heartbeat", at: 60_000 }, { kind: "interval_close", at: 60_000 }, usage("entry-1", 10)],
  });
  const resumed = activity({
    sessionId: ROOT,
    writerEpoch: "root-resumed",
    events: [visit("root-v2", 100_000), { kind: "interval_open", at: 100_000 }, usage("entry-1", 10), usage("entry-2", 5), { kind: "heartbeat", at: 120_000 }, { kind: "interval_close", at: 120_000 }],
  });
  const child = activity({
    sessionId: "task-child",
    role: "child",
    interactive: false,
    parentSessionId: ROOT,
    writerEpoch: "child-one",
    events: [visit("child-v1", 30_000), { kind: "interval_open", at: 30_000 }, { kind: "heartbeat", at: 90_000 }, { kind: "interval_close", at: 90_000 }, { ...usage("child-entry", 3), usage: { openai: { sourceKey: "omp#task-child#child-entry", inputNonCache: 3, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 1 } } }],
  });
  const fork = activity({
    sessionId: "fork-session",
    role: "fork",
    parentSessionId: ROOT,
    writerEpoch: "fork-one",
    events: [visit("fork-v1", 10_000), { kind: "interval_open", at: 10_000 }, { kind: "interval_close", at: 20_000 }, { ...usage("fork-own", 2), usage: { openai: { sourceKey: "omp#fork-session#fork-own", inputNonCache: 2, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 1 } } }],
  });
  const print = activity({
    sessionId: "print-session",
    interactive: false,
    writerEpoch: "print-one",
    events: [visit("print-v1", 0), { kind: "interval_open", at: 0 }, { kind: "interval_close", at: 30_000 }, { ...usage("print-entry", 99), usage: { openai: { sourceKey: "omp#print-session#print-entry", inputNonCache: 99, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 1 } } }],
  });
  return { repoFacts: {}, activities: [root, resumed, child, fork, print] };
}

describe("OMP 活動重播到城鎮模型", () => {
  test("互動 root 與 fork 建格；print 不建格；child 合併且 resume 用量去重", () => {
    const town = readTown(replay());
    expect(town.cities).toHaveLength(1);
    const tiles = town.cities[0].tiles;
    expect(tiles.map(({ rootSessionId }) => rootSessionId).sort()).toEqual(["fork-session", ROOT].sort());
    const root = tiles.find((tile) => tile.rootSessionId === ROOT);
    expect(root.workMs).toBe(110_000); // root + child 區間聯集，重疊部分只算一次
    expect(root.usage).toEqual({ inputNonCache: 18, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 3 });
    expect(root.visits).toHaveLength(2);
    const fork = tiles.find((tile) => tile.rootSessionId === "fork-session");
    expect(fork.usage.inputNonCache).toBe(2); // fixture 只包含 fork 自己的新來源，不含繼承歷史
  });

  test("herdr 關閉期間的 main checkout → worktree → 另一座城，在 worktree 刪除後仍按 city 分帳", async () => {
    const root = fs.mkdtempSync("/tmp/reclaim-5-offline-");
    const main = `${root}/main`;
    const worktree = `${root}/temporary-worktree`;
    const other = `${root}/other`;
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const cityA = `${main}/.git`;
    const cityB = `${other}/.git`;
    const visit = (visitId, cwd, commonDir, start) => ({ kind: "visit_start", at: start, visit: { visitId, cwd, commonDir, checkout: cwd } });
    const usageAt = (sourceEntryId, sessionId, inputNonCache, time) => ({
      kind: "usage",
      at: time,
      sourceEntryId,
      usage: { openai: { sourceKey: `omp#${sessionId}#${sourceEntryId}`, inputNonCache, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 1 } },
    });
    const record = activity({
      sessionId: ROOT,
      writerEpoch: "offline",
      events: [
        visit("main-visit", main, cityA, 0), { kind: "interval_open", at: 0 }, { kind: "heartbeat", at: 60_000 }, usageAt("a-main", ROOT, 4, 60_000), { kind: "interval_close", at: 60_000 }, { kind: "visit_end", at: 60_000 },
        visit("worktree-visit", worktree, cityA, 100_000), { kind: "interval_open", at: 100_000 }, { kind: "heartbeat", at: 160_000 }, usageAt("a-worktree", ROOT, 6, 160_000), { kind: "interval_close", at: 160_000 }, { kind: "visit_end", at: 160_000 },
        visit("other-visit", other, cityB, 200_000), { kind: "interval_open", at: 200_000 }, { kind: "heartbeat", at: 260_000 }, usageAt("b-main", ROOT, 5, 260_000), { kind: "interval_close", at: 260_000 }, { kind: "visit_end", at: 260_000 },
      ],
    });
    fs.rmSync(worktree, { recursive: true, force: true });
    try {
      const scenario = { activities: [record], repoFacts: {} };
      const expected = readTown(scenario);
      const io = createFileIo();
      const activities = [];
      const expeditions = [];
      for (const cityId of [cityA, cityB]) {
        const ledger = await new CityLedger({ io, dir: cityDir(root, cityId), cityId }).open();
        await ingestScenario(ledger, scenario, cityId);
        const state = await ledger.state();
        activities.push(...state.activities.values());
        expeditions.push(...state.tiles);
      }
      const actual = readTownFromLedger({ activities, expeditions, repoFacts: {} });
      expect(actual).toEqual(expected);
      const cityAExpedition = actual.cities.find((city) => city.cityId === cityA).tiles[0];
      expect(cityAExpedition.workMs).toBe(120_000);
      expect(cityAExpedition.usage.inputNonCache).toBe(10);
      expect(cityAExpedition.visits.map((item) => item.checkout)).toEqual([main, worktree]);
      const cityBExpedition = actual.cities.find((city) => city.cityId === cityB).tiles[0];
      expect(cityBExpedition.workMs).toBe(60_000);
      expect(cityBExpedition.usage.inputNonCache).toBe(5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("journal 重播保留 source-key 去重後的公開城鎮狀態", async () => {
    const scenario = replay();
    const rootDir = fs.mkdtempSync("/tmp/reclaim-5-ledger-");
    const io = createFileIo();
    const cityLedger = await new CityLedger({ io, dir: cityDir(rootDir, CITY), cityId: CITY }).open();
    await ingestScenario(cityLedger, scenario, CITY);
    const state = await cityLedger.state();
    const town = readTownFromLedger({ activities: [...state.activities.values()], expeditions: state.tiles, repoFacts: scenario.repoFacts });
    expect(town).toEqual(readTown(scenario));
    expect(town.cities[0].tiles.find((tile) => tile.rootSessionId === ROOT).usage.inputNonCache).toBe(18);
  });

  test("ack compact 後的新尾巴接回 journal，不會失去原 visit、interval 或用量", async () => {
    const scenario = replay();
    const full = scenario.activities.find((record) => record.sessionId === ROOT);
    const rootDir = fs.mkdtempSync("/tmp/reclaim-5-compact-");
    const io = createFileIo();
    try {
      const ledger = await new CityLedger({ io, dir: cityDir(rootDir, CITY), cityId: CITY }).open();
      await ingestActivities(ledger, [{ ...full, events: full.events.slice(0, 3) }], CITY);
      await ingestActivities(ledger, [{ ...full, events: full.events.slice(3) }], CITY);
      await ingestExpeditions(ledger, { activities: [full], repoFacts: {} }, CITY);
      const state = await ledger.state();
      const town = readTownFromLedger({ activities: [...state.activities.values()], expeditions: state.tiles, repoFacts: {} });
      expect(town).toEqual(readTown({ activities: [full], repoFacts: {} }));
      expect([...state.activities.values()][0].events).toHaveLength(full.events.length);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
