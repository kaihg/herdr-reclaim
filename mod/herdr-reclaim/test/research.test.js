// ticket #8 的研究羊皮卷（proposal §7.4、§17.1 情境 5）：固定事件重播 → 公開城鎮讀取模型。
// 接點只用 adapter 活動紀錄、commit 證據與帳本；斷言的是使用者看得到的計量器與庫存。
import { describe, expect, test } from "bun:test";
import { CityLedger } from "../core/ledger.js";
import { commitContexts, ingestCommits } from "../core/commit-evidence.js";
import { ingestResearch, ingestScenario } from "../core/ingest.js";
import { readTownFromLedger } from "../core/town.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/reclaim-8-research/.git";
const OTHER = "/tmp/reclaim-8-research-other/.git";
const CHECKOUT = "/tmp/reclaim-8-research";
const AT = 1_800_000_000_000;
const T = (ms) => AT + ms;
const ROOT = "sess-root-1";
const ROOT2 = "sess-root-2";
const PRINT = "sess-print";

const dir = (name) => `/tmp/reclaim-8-research/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

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
    writerEpoch: writerEpoch ?? `${sessionId}-1`,
    events: events.map((event, index) => ({ eventSeq: index + 1, ...event })),
    updatedAt: Math.max(...events.map((event) => event.at)),
  };
}

const visitStart = (cityId, at) => ({
  kind: "visit_start",
  at,
  visit: { visitId: `v-${cityId}-${at}`, cwd: CHECKOUT, commonDir: cityId, checkout: CHECKOUT },
});
const visitEnd = (at) => ({ kind: "visit_end", at });
const open = (at) => ({ kind: "interval_open", at });
const close = (at) => ({ kind: "interval_close", at });

/** 一筆用量事件（§6.1）：sourceKey 讓重播可以跨 epoch 去重。 */
const usageEvent = (sessionId, sourceEntryId, at, fields = {}) => ({
  kind: "usage",
  at,
  sourceEntryId,
  usage: {
    openai: {
      sourceKey: `omp#${sessionId}#${sourceEntryId}`,
      inputNonCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      costKnown: 0,
      costUnknownEntries: 0,
      ...fields,
    },
  },
});

/** 一個回合：visit 開始、開區間、用量、關區間（adapter 的 agent_start → agent_end）。 */
const round = (sessionId, cityId, openAt, closeAt, usages) => [
  visitStart(cityId, openAt),
  open(openAt),
  ...usages,
  close(closeAt),
];

const hookRecord = (sha, at, env = {}) => ({
  schema: 1,
  sha,
  hook: "post-commit",
  commonDir: CITY,
  toplevel: CHECKOUT,
  at,
  env,
});

async function ledgerOf(name, cityId = CITY) {
  return new CityLedger({ io: createFileIo(), dir: dir(name), cityId }).open();
}

/** 公開讀取模型：只有帳本裡的活動、格子與庫存。 */
async function townOf(ledger, cityId = CITY) {
  const state = await ledger.state();
  return readTownFromLedger({
    activities: [...state.activities.values()],
    expeditions: state.tiles,
    resources: { [cityId]: state.resources },
    research: { [cityId]: state.research },
    market: { [cityId]: state.market },
  });
}

const cityOf = async (ledger, cityId = CITY) => (await townOf(ledger, cityId)).cities[0];

/** 帳本裡的活動（研究要用帳本保存的那一份：adapter 的快照會被 ack compact）。 */
async function activitiesOf(ledger) {
  return [...(await ledger.state()).activities.values()];
}

/** 收成＋研究的固定重播順序：活動與格子 → commit 證據 → 研究結算。 */
async function replay(ledger, { activities, hooks = [], sources = [], diffForCommit = async () => [], remoteMerges = new Set() }) {
  for (const record of activities ?? []) await ingestScenario(ledger, { activities: [record] }, ledger.cityId);
  const stored = await activitiesOf(ledger);
  const commits = commitContexts({ hooks, sources, activities: stored, remoteMerges });
  const commitsResult = await ingestCommits({ ledger, hooks, sources, activities: stored, diffForCommit, remoteMerges });
  const research = await ingestResearch(ledger, { activities: stored, commits });
  return { commits, commitsResult, research };
}

describe("研究羊皮卷（§7.4）", () => {
  test("沒有 commit 的回合累加 non-cache input + output；每 100,000 一張、餘數按城保留", async () => {
    const ledger = await ledgerOf("meter");
    const root = activity({
      sessionId: ROOT,
      writerEpoch: "root-1",
      events: [
        ...round(ROOT, CITY, T(0), T(60_000), [
          usageEvent(ROOT, "a", T(30_000), { inputNonCache: 50_000, output: 10_000 }),
        ]),
        visitEnd(T(60_000)),
        // 同一支 session 到另一座城工作：那一段算另一座城的計量器。
        ...round(ROOT, OTHER, T(120_000), T(180_000), [
          usageEvent(ROOT, "b", T(150_000), { inputNonCache: 70_000 }),
        ]),
      ],
    });
    // 另一支遠征在同一座城的第二個回合：補到 100,000，換出 1 張羊皮卷。
    const second = activity({
      sessionId: ROOT2,
      writerEpoch: "root2-1",
      events: round(ROOT2, CITY, T(240_000), T(300_000), [
        usageEvent(ROOT2, "c", T(270_000), { inputNonCache: 30_000, output: 10_000 }),
      ]),
    });
    await replay(ledger, { activities: [root, second] });
    const city = await cityOf(ledger);
    expect(city.research).toEqual({ tokens: 0 });
    expect(city.resources.parchment).toBe(1);

    // 另一座城的計量器不受影響（各自一個帳本）：70,000 還不到一張。
    const other = await ledgerOf("meter-other", OTHER);
    await replay(other, { activities: [root] });
    const otherCity = await cityOf(other, OTHER);
    expect(otherCity.research).toEqual({ tokens: 70_000 });
    expect(otherCity.resources.parchment).toBe(0);
  });

  test("cache 用量不算；沒有結束的回合、非互動 session 的回合也不計", async () => {
    const ledger = await ledgerOf("cache");
    const root = activity({
      sessionId: ROOT,
      writerEpoch: "root-1",
      events: [
        ...round(ROOT, CITY, T(0), T(60_000), [
          usageEvent(ROOT, "cache-only", T(30_000), { cacheRead: 500_000, cacheWrite: 400_000 }),
        ]),
        // 沒有 interval_close（行程被中止）：尚未結束的回合不結算。
        visitStart(CITY, T(120_000)), open(T(120_000)), usageEvent(ROOT, "unfinished", T(150_000), { inputNonCache: 90_000 }),
      ],
    });
    const print = activity({
      sessionId: PRINT,
      interactive: false,
      writerEpoch: "print-1",
      events: round(PRINT, CITY, T(0), T(60_000), [
        usageEvent(PRINT, "print", T(30_000), { inputNonCache: 999_999 }),
      ]),
    });
    await replay(ledger, { activities: [root, print] });
    const city = await cityOf(ledger);
    expect(city.research).toEqual({ tokens: 0 });
    expect(city.resources.parchment).toBe(0);
  });

  test("用量未知（unknownFields）的回合不累加", async () => {
    const ledger = await ledgerOf("unknown");
    const root = activity({
      sessionId: ROOT,
      writerEpoch: "root-1",
      events: round(ROOT, CITY, T(0), T(60_000), [
        usageEvent(ROOT, "known", T(10_000), { inputNonCache: 40_000 }),
        usageEvent(ROOT, "unknown", T(20_000), { output: 60_000, unknownFields: ["output"] }),
      ]),
    });
    await replay(ledger, { activities: [root] });
    const city = await cityOf(ledger);
    expect(city.research).toEqual({ tokens: 0 }); // 未知的 60,000 不會被補 0 後計入
    expect(city.resources.parchment).toBe(0);
  });

  test("有 commit 的回合不累加（就算那個 commit 沒有產生新單位）", async () => {
    const ledger = await ledgerOf("attributed");
    const root = activity({
      sessionId: ROOT,
      writerEpoch: "root-1",
      events: [
        ...round(ROOT, CITY, T(0), T(60_000), [usageEvent(ROOT, "a", T(30_000), { inputNonCache: 60_000 })]),
        ...round(ROOT, CITY, T(120_000), T(180_000), [usageEvent(ROOT, "b", T(150_000), { inputNonCache: 40_000 })]),
      ],
    });
    // 第一個回合裡有一個歸屬確定的 commit，但它的變更不可收成（沒有單位）。
    const sha = "1".repeat(40);
    await replay(ledger, { activities: [root], hooks: [hookRecord(sha, T(30_000), { PI_SESSION_ID: ROOT })] });
    const city = await cityOf(ledger);
    expect(city.research).toEqual({ tokens: 40_000 }); // 只有沒有 commit 的那個回合
    expect(city.resources.parchment).toBe(0);
  });

  test("待核對來源的回合暫不結算；確認歸屬後不發研究；核對結果為來源不明則視為沒有歸屬", async () => {
    const ledger = await ledgerOf("pending");
    const root = activity({
      sessionId: ROOT,
      writerEpoch: "root-1",
      events: [
        // 回合 1：來源還可能晚到的提交落在回合內。
        ...round(ROOT, CITY, T(0), T(60_000), [usageEvent(ROOT, "a", T(30_000), { inputNonCache: 60_000 })]),
        // 回合 2：hook 只有 terminal ID，是已完成的核對結果（來源不明）。
        ...round(ROOT, CITY, T(120_000), T(180_000), [usageEvent(ROOT, "b", T(150_000), { inputNonCache: 30_000 })]),
      ],
    });
    const pendingSha = "2".repeat(40);
    const terminalSha = "3".repeat(40);
    const hooks = [
      { ...hookRecord(pendingSha, T(30_000), {}), hook: "reflog" },
      hookRecord(terminalSha, T(150_000), { HC_TERMINAL_ID: "terminal-1" }),
    ];
    const first = await replay(ledger, { activities: [root], hooks });
    const afterFirst = await cityOf(ledger);
    expect(afterFirst.research).toEqual({ tokens: 30_000 }); // 來源不明的那個回合照算
    expect(afterFirst.resources.parchment).toBe(0);

    // 來源晚到、確認這個 commit 屬於該 session：回合 1 不發研究羊皮卷，計量器不動。
    const sources = [{ schema: 1, sha: pendingSha, cli: "omp", sessionId: ROOT, at: T(30_000) }];
    await replay(ledger, {
      activities: [],
      hooks,
      sources,
      diffForCommit: async () => [{ status: "A", path: "docs/note.md", resultBlob: "blob-note" }],
    });
    const after = await cityOf(ledger);
    expect(after.research).toEqual({ tokens: 30_000 }); // 待核對的 60,000 沒有被結算
    expect(after.resources.parchment).toBe(1); // 晚到的文件 commit 換到 1 張羊皮卷
    expect(after.resources.wood).toBe(0);
  });

  test("來源不明時已發的研究羊皮卷：晚到的 commit 自動補算收成，不倒扣已發獎勵、不產生欠款", async () => {
    const ledger = await ledgerOf("late-source");
    const root = activity({
      sessionId: ROOT,
      writerEpoch: "root-1",
      events: round(ROOT, CITY, T(0), T(60_000), [usageEvent(ROOT, "a", T(30_000), { inputNonCache: 100_000 })]),
    });
    // 先把格子開起來（重新派遣與收成都需要有現役的 generation）。
    await ingestScenario(ledger, { activities: [root] }, CITY);
    await ledger.submit(() => ({
      opId: `expedition:${CITY}:${ROOT}:1`,
      kind: "expedition",
      at: T(0),
      activatedAt: T(0),
      cityId: CITY,
      rootSessionId: ROOT,
      generation: 1,
      x: 0,
      y: -1,
      cli: "omp",
      repo: { commonDir: CITY, checkout: CHECKOUT },
    }));
    // 沒有 commit 證據的回合：先發出 1 張羊皮卷。
    await ingestResearch(ledger, { activities: await activitiesOf(ledger), commits: [] });
    let city = await cityOf(ledger);
    expect(city.resources.parchment).toBe(1);
    expect(city.research).toEqual({ tokens: 0 });

    // 來源晚到：同一段時間內的 commit 歸屬確定，補算收成（木材 10、+20 點）。
    const sha = "4".repeat(40);
    const hooks = [hookRecord(sha, T(30_000), { PI_SESSION_ID: ROOT })];
    await replay(ledger, {
      activities: [],
      hooks,
      diffForCommit: async () => [{ status: "A", path: "src/app.js", resultBlob: "blob-app" }],
    });
    city = await cityOf(ledger);
    const tile = city.tiles.find((candidate) => candidate.rootSessionId === ROOT);
    expect(tile.harvestPoints).toBe(20);
    expect(city.resources.wood).toBe(10);
    expect(city.resources.parchment).toBe(1); // 已發的研究羊皮卷沒有被倒扣
    expect(city.research).toEqual({ tokens: 0 }); // 計量器也沒有被倒扣

    // 羊皮卷用掉（加速）之後再重播同一份證據：不補發、不倒扣、不產生負數。
    const boost = await ledger.submit(() => ({
      opId: `boost:${CITY}:${ROOT}:1:1`,
      kind: "boost",
      at: T(200_000),
      cityId: CITY,
      rootSessionId: ROOT,
      generation: 1,
      scrolls: 1,
    }));
    expect(boost.status).toBe("applied");
    await replay(ledger, {
      activities: [],
      hooks,
      diffForCommit: async () => [{ status: "A", path: "src/app.js", resultBlob: "blob-app" }],
    });
    city = await cityOf(ledger);
    expect(city.resources.parchment).toBe(0);
    expect(city.resources.wood).toBe(10);
    expect(city.research).toEqual({ tokens: 0 });
    expect(city.tiles.find((candidate) => candidate.rootSessionId === ROOT).boostPoints).toBe(10);
  });

  test("重播同一份活動與證據不會再次發放研究羊皮卷", async () => {
    const ledger = await ledgerOf("replay");
    const root = activity({
      sessionId: ROOT,
      writerEpoch: "root-1",
      events: round(ROOT, CITY, T(0), T(60_000), [usageEvent(ROOT, "a", T(30_000), { inputNonCache: 100_000 })]),
    });
    const first = await replay(ledger, { activities: [root] });
    expect(first.research.results.map((result) => result.status)).toEqual(["applied"]);
    const second = await replay(ledger, { activities: [root] });
    expect(second.research.results).toEqual([]); // 已經在 journal 裡：不再送一次
    const city = await cityOf(ledger);
    expect(city.resources.parchment).toBe(1);
    expect(city.research).toEqual({ tokens: 0 });
    const entries = (await ledger.scanSegments()).flatMap((segment) => segment.entries);
    expect(entries.filter((entry) => entry.kind === "research")).toHaveLength(1);
  });
});
