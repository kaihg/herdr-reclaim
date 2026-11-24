// ticket #23 共用城市的基本收入：固定的工作事件 → 實際隔離帳本 → 公開的共用城市讀取模型。
// 斷言的是玩家看得到的庫存與工作進度；不測私有欄位或寫入順序。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CityLedger, cityDir } from "../core/ledger.js";
import { ingestScenario } from "../core/ingest.js";
import { ACHIEVEMENT_YIELD, CITY_BUILDINGS, RECIPES, WORK_TOKENS_PER_UNIT, WORK_YIELD } from "../core/rules.js";
import { SHARED_CITY_ID, ingestAchievements, ingestIncome, placePlan, readSharedCity, sharedCityDir } from "../core/shared-city.js";
import { legalSites, revealedCells, siteCheck, terrainAt } from "../core/city-map.js";
import { createFileIo } from "./fs-io.js";

const REPO_A = "/tmp/reclaim-23-a/.git";
const REPO_B = "/tmp/reclaim-23-b/.git";
const AT = 1_800_000_000_000;
const T = (ms) => AT + ms;

const root = (name) => `/tmp/reclaim-23-shared/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

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

const visitStart = (commonDir, at) => ({
  kind: "visit_start",
  at,
  visit: { visitId: `v-${commonDir}-${at}`, cwd: commonDir.replace(/\/\.git$/, ""), commonDir, checkout: commonDir.replace(/\/\.git$/, "") },
});
const open = (at) => ({ kind: "interval_open", at });
const close = (at) => ({ kind: "interval_close", at });

/** 一筆用量事件；`sourceKey: null` 代表 adapter 沒有給來源 key。 */
const usageEvent = (at, entryId, fields = {}, { provider = "openai", sessionId = "s", sourceKey } = {}) => ({
  kind: "usage",
  at,
  sourceEntryId: entryId,
  usage: {
    [provider]: {
      ...(sourceKey === null ? {} : { sourceKey: sourceKey ?? `omp#${sessionId}#${entryId}` }),
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

/** 一個完整回合：在 `repo` 開始工作、這些用量、結束。 */
const round = (repo, openAt, closeAt, usages) => [visitStart(repo, openAt), open(openAt), ...usages, close(closeAt)];

const TEN_K = { inputNonCache: 7_000, output: 3_000 };

async function sharedLedger(dir, options = {}) {
  return new CityLedger({ io: createFileIo(), dir: sharedCityDir(dir), cityId: SHARED_CITY_ID, ...options }).open();
}

/** 啟用邊界固定在固定情境的最前面（正式 runtime 用第一次啟用的當下），測試結果不依牆上時鐘。 */
const settle = (ledger, activities, options = {}) => ingestIncome(ledger, { activities, activateAt: T(0), ...options });

/** 一個「space」從共用帳本讀到的公開城市（每次都重新開帳本，像另一個視窗）。 */
async function cityAt(dir) {
  return readSharedCity(await (await sharedLedger(dir)).state()).city;
}

const stock = (city) => [city.resources.wood, city.resources.stone, city.resources.iron];
const perUnit = [WORK_YIELD.wood, WORK_YIELD.stone, WORK_YIELD.iron];
const times = (n) => perUnit.map((amount) => amount * n);

describe("共用城市的基本收入（#23）", () => {
  test("兩個專案的研究、沒有 commit 與交易，逐步取得各種基本建材；兩個 space 看到同一份庫存", async () => {
    const dir = root("two-projects");
    const ledger = await sharedLedger(dir);
    expect(stock(readSharedCity(await ledger.state()).city)).toEqual([0, 0, 0]);

    const inA = activity({ sessionId: "a", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "a1", TEN_K)]) });
    await settle(ledger, [inA]);
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 未滿一單位的工作先累積在進度條，庫存不變。
    const half = activity({ sessionId: "b", events: round(REPO_B, T(100_000), T(160_000), [usageEvent(T(101_000), "b1", { output: 5_000 }, { sessionId: "b" })]) });
    await settle(ledger, [inA, half]);
    const partial = await cityAt(dir);
    expect(stock(partial)).toEqual(times(1));
    expect(partial.work).toEqual({ tokens: 5_000, unitTokens: WORK_TOKENS_PER_UNIT });

    // 下一個回合跨過門檻：收成依計量器餘數補齊，不是只看這一回合的 token。
    const moreB = activity({
      sessionId: "b",
      writerEpoch: "b-2",
      events: round(REPO_B, T(200_000), T(260_000), [usageEvent(T(201_000), "b2", { inputNonCache: 15_000 }, { sessionId: "b" })]),
    });
    await settle(ledger, [inA, half, moreB]);
    const city = await cityAt(dir);
    expect(stock(city)).toEqual(times(3));
    expect(city.work.tokens).toBe(0);
    // 沒有指定任何建築，也不會有人替玩家花掉庫存。
    expect(Object.keys(RECIPES).length).toBeGreaterThan(0);
    expect(stock(await cityAt(dir))).toEqual(times(3));
  });

  test("同樣的工作切成長短不同的對話、換 provider、/new 與恢復，收入相同且不產生遠征格", async () => {
    const oneDir = root("one-session");
    const one = await sharedLedger(oneDir);
    await settle(one, [activity({
      sessionId: "long",
      events: [
        ...round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "l1", TEN_K, { sessionId: "long" })]),
        ...round(REPO_A, T(100_000), T(160_000), [usageEvent(T(101_000), "l2", TEN_K, { sessionId: "long" })]),
        ...round(REPO_A, T(200_000), T(260_000), [usageEvent(T(201_000), "l3", TEN_K, { sessionId: "long" })]),
      ],
    })]);

    const manyDir = root("many-sessions");
    const many = await sharedLedger(manyDir);
    await settle(many, [
      activity({ sessionId: "new-1", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "n1", TEN_K, { sessionId: "new-1", provider: "anthropic" })]) }),
      // /new：另一支 session，另一個專案，另一個 provider。
      activity({ sessionId: "new-2", events: round(REPO_B, T(100_000), T(160_000), [usageEvent(T(101_000), "n2", TEN_K, { sessionId: "new-2", provider: "google" })]) }),
      // 恢復對話：同一支 session 的新 writer epoch。
      activity({ sessionId: "new-1", writerEpoch: "new-1-2", events: round(REPO_B, T(200_000), T(260_000), [usageEvent(T(201_000), "n3", TEN_K, { sessionId: "new-1" })]) }),
    ]);

    expect(stock(await cityAt(manyDir))).toEqual(stock(await cityAt(oneDir)));
    expect(stock(await cityAt(manyDir))).toEqual(times(3));
    // 共用城市沒有「遠征格」：切對話不會多工地，帳本裡也沒有格子。
    expect((await many.state()).tiles).toEqual([]);
    expect((await one.state()).tiles).toEqual([]);
    expect(readSharedCity(await many.state()).city.tiles).toBeUndefined();
  });

  test("兩個 space 重送同一份工作只入帳一次；不同工作不會被誤判成重播；關閉再開庫存不變", async () => {
    const dir = root("replay");
    const record = () => activity({ sessionId: "s", writerEpoch: "s-1", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "e1", TEN_K)]) });

    // 兩個視窗各自開帳本，同時送同一份紀錄。
    const [windowA, windowB] = await Promise.all([sharedLedger(dir), sharedLedger(dir)]);
    await Promise.all([settle(windowA, [record()]), settle(windowB, [record()])]);
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 恢復對話後的新 epoch 又回報同一筆來源 entry。
    const resumed = activity({ sessionId: "s", writerEpoch: "s-2", events: round(REPO_A, T(500_000), T(560_000), [usageEvent(T(1_000), "e1", TEN_K)]) });
    await settle(windowA, [record(), resumed]);
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 同 token 量、同時間、不同來源 entry：是另一份工作。
    const other = activity({ sessionId: "s", writerEpoch: "s-3", events: round(REPO_A, T(600_000), T(660_000), [usageEvent(T(1_000), "e2", TEN_K)]) });
    await settle(windowB, [record(), resumed, other]);
    expect(stock(await cityAt(dir))).toEqual(times(2));

    // 沒有來源 key 的用量，不同 session 的同一個事件序號仍是不同的工作。
    const keyless = (sessionId) => activity({ sessionId, events: round(REPO_B, T(700_000), T(760_000), [usageEvent(T(701_000), "k", TEN_K, { sessionId, sourceKey: null })]) });
    await settle(windowA, [keyless("x"), keyless("y")]);
    expect(stock(await cityAt(dir))).toEqual(times(4));
    await settle(windowB, [keyless("x"), keyless("y")]);
    expect(stock(await cityAt(dir))).toEqual(times(4));

    // 關閉再開：重播 journal 與 checkpoint 都是同一份庫存，再送一次也不重領。
    const reopened = await sharedLedger(dir);
    await reopened.checkpoint();
    const afterCheckpoint = await sharedLedger(dir);
    await settle(afterCheckpoint, [record(), resumed, other, keyless("x"), keyless("y")]);
    expect(stock(await cityAt(dir))).toEqual(times(4));
  });

  test("只有互動工作的已結束回合才有收入：print、快取、未結束的回合與未知用量都不算；子 session 併入上層", async () => {
    const dir = root("effective");
    const ledger = await sharedLedger(dir);
    const printed = activity({ sessionId: "print", interactive: false, events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "p1", TEN_K, { sessionId: "print" })]) });
    const cached = activity({ sessionId: "cache", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "c1", { cacheRead: 900_000, cacheWrite: 90_000 }, { sessionId: "cache" })]) });
    const unknown = activity({
      sessionId: "unknown",
      events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "u1", { ...TEN_K, unknownFields: ["output"] }, { sessionId: "unknown" })]),
    });
    const running = activity({ sessionId: "run", events: [visitStart(REPO_A, T(0)), open(T(0)), usageEvent(T(1_000), "r1", TEN_K, { sessionId: "run" })] });
    await settle(ledger, [printed, cached, unknown, running]);
    expect(stock(await cityAt(dir))).toEqual([0, 0, 0]);
    expect((await cityAt(dir)).work.tokens).toBe(0);

    // 回合結束之後才入帳。
    const finished = activity({
      sessionId: "run",
      events: [visitStart(REPO_A, T(0)), open(T(0)), usageEvent(T(1_000), "r1", TEN_K, { sessionId: "run" }), close(T(60_000))],
    });
    const child = activity({
      sessionId: "kid",
      role: "child",
      interactive: false,
      parentSessionId: "run",
      events: round(REPO_A, T(10_000), T(50_000), [usageEvent(T(11_000), "kid1", TEN_K, { sessionId: "kid" })]),
    });
    await settle(ledger, [finished, child]);
    expect(stock(await cityAt(dir))).toEqual(times(2));
  });

  test("啟用邊界：啟用前已結束的舊城歷史不重發，之後的工作照常入帳", async () => {
    const dir = root("boundary");
    const ledger = await sharedLedger(dir);
    const before = activity({ sessionId: "old", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "old1", { inputNonCache: 20_000 }, { sessionId: "old" })]) });
    const during = activity({ sessionId: "now", events: round(REPO_B, T(200_000), T(260_000), [usageEvent(T(201_000), "now1", TEN_K, { sessionId: "now" })]) });

    await settle(ledger, [before, during], { activateAt: T(150_000) });
    expect(stock(await cityAt(dir))).toEqual(times(1));

    // 邊界記在帳本裡：重開帳本（或重播、做 checkpoint）仍然只算啟用之後的工作。
    const reopened = await sharedLedger(dir);
    await reopened.checkpoint();
    expect((await reopened.state()).work.since).toBe(T(150_000));
    await settle(await sharedLedger(dir), [before, during]);
    expect(stock(await cityAt(dir))).toEqual(times(1));
  });

  test("共用帳本不碰舊版各城帳本：舊城檔案逐位元不變，共用帳本也不會被當成一座舊城", async () => {
    const dir = root("legacy-untouched");
    const legacyId = REPO_A;
    const legacy = await new CityLedger({ io: createFileIo(), dir: cityDir(dir, legacyId), cityId: legacyId }).open();
    const work = [activity({ sessionId: "old", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "o1", TEN_K, { sessionId: "old" })]) })];
    await ingestScenario(legacy, { activities: work }, legacyId);

    const snapshot = (base) => {
      const files = {};
      const walk = (current) => {
        if (!fs.existsSync(current)) return;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const file = path.join(current, entry.name);
          if (entry.isDirectory()) walk(file);
          else files[path.relative(base, file)] = fs.readFileSync(file, "utf8");
        }
      };
      walk(base);
      return files;
    };
    const legacyFiles = snapshot(`${dir}/cities`);
    expect(Object.keys(legacyFiles).length).toBeGreaterThan(0);

    const shared = await sharedLedger(dir);
    await settle(shared, work);
    expect(stock(await cityAt(dir))).toEqual(times(1));
    expect(snapshot(`${dir}/cities`)).toEqual(legacyFiles);
    expect(Object.keys(snapshot(sharedCityDir(dir))).length).toBeGreaterThan(0);
    // 掃 `cities/` 找舊城的地方（main.js）因此看不到共用帳本。
    expect(Object.values(snapshot(`${dir}/cities`)).some((text) => text.includes(SHARED_CITY_ID))).toBe(false);
  });
});

// ticket #24：明確成果的額外收成。同樣走「固定事件 → 實際隔離帳本 → 公開共用城市」，
// commit 證據的形狀與 hook／adapter 寫的檔案相同；斷言只看共用倉庫的庫存。
const sha = (digit) => String(digit).repeat(40);
const checkoutOf = (repo) => repo.replace(/\/\.git$/, "");

/** 一筆 commit hook 證據（post-commit 或 reflog）；`env` 是 commit 當下看得到的 session 變數。 */
const hookRecord = (commit, at, env = {}, { repo = REPO_A, hook = "post-commit", toplevel = checkoutOf(repo) } = {}) => ({
  schema: 1,
  sha: commit,
  hook,
  commonDir: repo,
  toplevel,
  at,
  env,
});

/** 每個 commit 的第一父節點差異（`git diff-tree --raw` 解析後的形狀）。 */
const diffsOf = (table) => async (commit) => table[commit] ?? [];
const modified = (file, blob) => ({ status: "M", path: file, oldBlob: "0".repeat(40), resultBlob: blob });

/** 一個 space 完整重載：先入帳基本收入，再核對成果。 */
async function harvestAll(ledger, { activities, hooks = [], sources = [], diffs = {}, remoteMerges = new Set(), activateAt } = {}) {
  await settle(ledger, activities, activateAt == null ? {} : { activateAt });
  return ingestAchievements(ledger, { activities, hooks, sources, remoteMerges, diffForCommit: diffsOf(diffs) });
}

const bonus = (n) => [ACHIEVEMENT_YIELD.wood * n, ACHIEVEMENT_YIELD.stone * n, ACHIEVEMENT_YIELD.iron * n];
const plus = (a, b) => a.map((amount, index) => amount + b[index]);

/** 同量的有效工作：session `w` 在 repo A 的一個回合，正好一單位。 */
const workIn = (sessionId = "w") => activity({
  sessionId,
  events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), `${sessionId}1`, TEN_K, { sessionId })]),
});

describe("明確成果的額外收成（#24）", () => {
  test("同量有效工作：有可核對成果的倉庫多一份成果加成，沒有成果只有基本收入", async () => {
    const withDir = root("with-commit");
    await harvestAll(await sharedLedger(withDir), {
      activities: [workIn()],
      hooks: [hookRecord(sha(1), T(30_000), { PI_SESSION_ID: "w" })],
      diffs: { [sha(1)]: [modified("src/town.js", "b".repeat(40))] },
    });

    const withoutDir = root("without-commit");
    await harvestAll(await sharedLedger(withoutDir), { activities: [workIn()] });

    expect(stock(await cityAt(withoutDir))).toEqual(times(1));
    expect(stock(await cityAt(withDir))).toEqual(plus(times(1), bonus(1)));
  });

  test("只有同 terminal、時間接近、環境變數衝突或對不到活動檔的線索：不發成果加成，基本收入照發", async () => {
    const cases = {
      // hook 當下只看到 terminal（同一台 pane），沒有任何 CLI 的 session 變數。
      "terminal-only": { env: { HC_TERMINAL_ID: "term-1" } },
      // 有 session 變數，但活動檔裡沒有這支 codex session（對不到來源）。
      "no-matching-adapter-session": { env: { CODEX_THREAD_ID: "cx-1" } },
      // 兩個 CLI 的變數同時在環境裡（OMP 的 bash 底下又開了別的 CLI）：來源衝突。
      "ambiguous-session-source": { env: { PI_SESSION_ID: "w", CODEX_THREAD_ID: "cx-1" } },
    };
    for (const [name, { env }] of Object.entries(cases)) {
      const repo = root(name);
      await harvestAll(await sharedLedger(repo), {
        activities: [workIn()],
        hooks: [hookRecord(sha(2), T(30_000), env)],
        diffs: { [sha(2)]: [modified("src/town.js", "c".repeat(40))] },
      });
      // 提交時間落在同一個回合裡——時間接近不能用來補猜歸屬。
      expect(stock(await cityAt(repo))).toEqual(times(1));
    }

    // 反例對照：同一組事件把 session 變數換成對得上的值，就拿到加成。
    const verified = root("verified");
    await harvestAll(await sharedLedger(verified), {
      activities: [workIn()],
      hooks: [hookRecord(sha(3), T(30_000), { PI_SESSION_ID: "w" })],
      diffs: { [sha(3)]: [modified("src/town.js", "c".repeat(40))] },
    });
    expect(stock(await cityAt(verified))).toEqual(plus(times(1), bonus(1)));
  });

  test("同一成果從兩個 space 抵達、重開重播、rebase 換 sha 都不重複發；第二個不同成果仍入帳", async () => {
    const repo = root("dedupe");
    const work = [workIn()];
    const first = sha(4);
    const firstDiffs = { [first]: [modified("src/town.js", "d".repeat(40))] };
    const hooks = [hookRecord(first, T(30_000), { PI_SESSION_ID: "w" })];
    await harvestAll(await sharedLedger(repo), { activities: work, hooks, diffs: firstDiffs });
    expect(stock(await cityAt(repo))).toEqual(plus(times(1), bonus(1)));

    // 第二個 space：同一份證據，外加同一支 commit 被兩處 checkout 各記一筆（reflog 也看到它）。
    await harvestAll(await sharedLedger(repo), {
      activities: work,
      hooks: [...hooks, hookRecord(first, T(30_000), { PI_SESSION_ID: "w" }, { hook: "reflog" })],
      diffs: firstDiffs,
    });
    expect(stock(await cityAt(repo))).toEqual(plus(times(1), bonus(1)));

    // 重開再重播：同一份紀錄再跑一次，庫存不變。
    await harvestAll(await sharedLedger(repo), { activities: work, hooks, diffs: firstDiffs });
    expect(stock(await cityAt(repo))).toEqual(plus(times(1), bonus(1)));

    // 改寫（amend／rebase）換了 sha、內容沒變：不是新的成果。
    const rewritten = sha(5);
    await harvestAll(await sharedLedger(repo), {
      activities: work,
      hooks: [...hooks, hookRecord(rewritten, T(40_000), { PI_SESSION_ID: "w" })],
      diffs: { ...firstDiffs, [rewritten]: firstDiffs[first] },
    });
    expect(stock(await cityAt(repo))).toEqual(plus(times(1), bonus(1)));

    // 第二個不同且合格的成果：自己的新內容，照發一份。
    const second = sha(6);
    await harvestAll(await sharedLedger(repo), {
      activities: work,
      hooks: [...hooks, hookRecord(second, T(50_000), { PI_SESSION_ID: "w" })],
      diffs: { ...firstDiffs, [second]: [modified("src/grid.js", "e".repeat(40))] },
    });
    expect(stock(await cityAt(repo))).toEqual(plus(times(1), bonus(2)));

    // 另一個專案的同名檔案剛好內容相同（同路徑、同 blob）：仍是兩個不同的成果，各自入帳。
    const elsewhere = sha(11);
    await harvestAll(await sharedLedger(repo), {
      activities: work,
      hooks: [...hooks, hookRecord(second, T(50_000), { PI_SESSION_ID: "w" }), hookRecord(elsewhere, T(60_000), { PI_SESSION_ID: "w" }, { repo: REPO_B })],
      diffs: { ...firstDiffs, [second]: [modified("src/grid.js", "e".repeat(40))], [elsewhere]: firstDiffs[first] },
    });
    expect(stock(await cityAt(repo))).toEqual(plus(times(1), bonus(3)));
  });

  test("啟用之前的提交、沒有可信時間的證據、空 commit 與非互動 session 都不是成果；基本收入不受影響", async () => {
    // 啟用邊界之後才成立：同一段工作之前（上一版舊城歷史）的提交不補發。
    const beforeDir = root("before-activation");
    await harvestAll(await sharedLedger(beforeDir), {
      activities: [workIn()],
      hooks: [hookRecord(sha(7), T(-1), { PI_SESSION_ID: "w" })],
      diffs: { [sha(7)]: [modified("src/town.js", "f".repeat(40))] },
    });
    expect(stock(await cityAt(beforeDir))).toEqual(times(1));

    // 舊 recorder 留下的 at=0：沒有可信提交時間，不用讀取當下冒充。
    const noTimeDir = root("no-time");
    await harvestAll(await sharedLedger(noTimeDir), {
      activities: [workIn()],
      hooks: [hookRecord(sha(8), 0, { PI_SESSION_ID: "w" })],
      diffs: { [sha(8)]: [modified("src/town.js", "f".repeat(40))] },
    });
    expect(stock(await cityAt(noTimeDir))).toEqual(times(1));

    // 空 commit、只改 lockfile：沒有可核對的新內容。
    const emptyDir = root("empty-commit");
    await harvestAll(await sharedLedger(emptyDir), {
      activities: [workIn()],
      hooks: [hookRecord(sha(9), T(30_000), { PI_SESSION_ID: "w" })],
      diffs: { [sha(9)]: [modified("bun.lock", "a".repeat(40))] },
    });
    expect(stock(await cityAt(emptyDir))).toEqual(times(1));

    // print／headless 的 session 不建格，也就不是工作成果。
    const headlessDir = root("headless");
    const headless = activity({
      sessionId: "w",
      interactive: false,
      events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "h1", TEN_K, { sessionId: "w" })]),
    });
    await harvestAll(await sharedLedger(headlessDir), {
      activities: [headless],
      hooks: [hookRecord(sha(10), T(30_000), { PI_SESSION_ID: "w" })],
      diffs: { [sha(10)]: [modified("src/town.js", "f".repeat(40))] },
    });
    // 連基本收入也不發：這不是互動工作（與 #23 同一條判準）。
    expect(stock(await cityAt(headlessDir))).toEqual([0, 0, 0]);
  });
});

// ticket #25：選址與預定地。固定地圖（core/city-map.js 的起始揭開區）＋玩家操作寫進實際隔離帳本，
// 再從公開的共用城市讀取模型核對合法位置、整棟預覽與預定地；不測私有欄位或寫入順序。
const at = (x, y) => ({ x, y });
const keysOf = (cells) => cells.map((cell) => `${cell.x},${cell.y}`).sort();
const problemsOf = (preview) => preview.cells.map((cell) => cell.problem).filter(Boolean);

/** 每一筆下令都像玩家在某個視窗按下「預定這裡」：帶自己的時間。 */
let clock = 0;
const order = (ledger, building, { x, y }) => placePlan(ledger, { building, x, y, at: T(900_000 + ++clock) });

/**
 * 會在 journal 寫入前互相等待的兩個 IO：兩個視窗讀到同一份狀態才各自寫，真的撞在一起。
 * 另一邊沒有跟上時最多等 2 秒就放行（回歸時是「競爭沒成立」的失敗，不是整個測試卡住）。
 */
function racingIos() {
  let armed = false;
  let waiting = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const beforeWrite = async (file) => {
    if (!armed || !file.includes("/journal/")) return;
    waiting += 1;
    if (waiting === 2) { armed = false; release(); }
    await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  };
  return { ios: [createFileIo({ beforeWrite }), createFileIo({ beforeWrite })], arm: () => { armed = true; } };
}

describe("選址與預定地（#25）", () => {
  test("起始揭開區可以隔一格蓋市場；不同占地的建築各有自己的合法位置；過往工作不影響選址", async () => {
    const dir = root("start-area");
    const ledger = await sharedLedger(dir);
    const fresh = readSharedCity(await ledger.state()).city;

    // 城鎮中心是 (0..1, 0..1)；市場 2×2 放在 (3..4, 0..1)，中間隔著 x = 2 那一行空地。
    expect(CITY_BUILDINGS.market.footprint).toEqual({ w: 2, h: 2 });
    expect(keysOf(legalSites(fresh, "market"))).toContain("3,0");
    const market = siteCheck(fresh, "market", at(3, 0));
    expect(market.ok).toBe(true);
    expect(keysOf(market.cells)).toEqual(["3,0", "3,1", "4,0", "4,1"]);

    // 1×1 的民居可以貼著揭開區的邊（右邊一格就是迷霧），2×2 的市場不行：合法位置依占地而定。
    const houses = keysOf(legalSites(fresh, "house"));
    const markets = keysOf(legalSites(fresh, "market"));
    expect(houses).toContain("4,0");
    expect(markets).not.toContain("4,0");
    expect(houses.length).toBeGreaterThan(markets.length);
    // 每一個合法位置的整棟占地都在已揭開的土地上。
    const revealed = revealedCells(fresh);
    for (const site of legalSites(fresh, "market")) {
      expect(siteCheck(fresh, "market", site).cells.every((cell) => revealed.has(`${cell.x},${cell.y}`))).toBe(true);
    }

    // 不同專案、不同對話的工作入帳之後，選址還是同一張地圖：不依 session 配地、不另占格。
    await settle(ledger, [
      activity({ sessionId: "a", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "a1", TEN_K, { sessionId: "a" })]) }),
      activity({ sessionId: "b", events: round(REPO_B, T(70_000), T(90_000), [usageEvent(T(71_000), "b1", TEN_K, { sessionId: "b" })]) }),
    ]);
    const worked = await cityAt(dir);
    expect(stock(worked)).toEqual(times(2));
    expect(worked.plan).toBeNull();
    expect(keysOf(legalSites(worked, "market"))).toEqual(markets);
    expect(keysOf(legalSites(worked, "house"))).toEqual(houses);
  });

  test("整棟占地落在草地、疏林、碎石就合法；一角碰到深水、峭壁、迷霧、城鎮中心或預定地整棟都不能放", async () => {
    const dir = root("footprint");
    const ledger = await sharedLedger(dir);
    const city = readSharedCity(await ledger.state()).city;

    // 疏林與碎石混合的 2×2：跟草地一樣合法。
    const mixed = siteCheck(city, "library", at(1, -3));
    expect(new Set(mixed.cells.map((cell) => cell.terrain))).toEqual(new Set(["scrub", "rubble"]));
    expect(mixed.ok).toBe(true);

    // 只有一角不合法：其他三格都是可建的空地。
    const corners = [
      [at(-2, -3), "water"],
      [at(3, -2), "cliff"],
      [at(3, 3), "fog"],
      [at(-1, -1), "center"],
    ];
    for (const [anchor, problem] of corners) {
      const preview = siteCheck(city, "library", anchor);
      expect(preview.ok).toBe(false);
      expect(problemsOf(preview)).toEqual([problem]);
      // 迷霧裡的地形還沒揭開：預覽不洩漏它是什麼地。
      if (problem === "fog") expect(preview.cells.find((cell) => cell.problem === "fog").terrain).toBeNull();
      const result = await order(ledger, "library", anchor);
      expect(result.status).toBe("rejected");
      expect(result.reason).toBe(`site_${problem}`);
    }
    expect((await cityAt(dir)).plan).toBeNull(); // 被拒的下令不留任何占地

    // 已有預定地：碰到它一角的位置也不能放（同時也因為一次只能有一個目標）。
    expect((await order(ledger, "market", at(3, 0))).status).toBe("applied");
    const planned = await cityAt(dir);
    const touching = siteCheck(planned, "house", at(3, 0));
    expect(problemsOf(touching)).toEqual(["plan"]);
    expect(problemsOf(siteCheck(planned, "library", at(2, -1)))).toEqual(["plan"]);
    expect(keysOf(legalSites(planned, "house"))).not.toContain("4,1");
  });

  test("預覽與實際下令一致：預覽合法的位置下令成功，預覽不合法的位置下令被拒且不留占地", async () => {
    for (const building of Object.keys(CITY_BUILDINGS)) {
      const rejectDir = root(`agree-${building}`);
      const rejecter = await sharedLedger(rejectDir);
      const city = readSharedCity(await rejecter.state()).city;
      const legal = new Set(keysOf(legalSites(city, building)));
      expect(legal.size).toBeGreaterThan(0);
      for (let x = -5; x <= 6; x++) {
        for (let y = -5; y <= 6; y++) {
          const preview = siteCheck(city, building, at(x, y));
          expect(preview.ok).toBe(legal.has(`${x},${y}`));
          if (preview.ok) continue;
          const result = await order(rejecter, building, at(x, y));
          expect(result.status).toBe("rejected");
          expect(result.reason).toBe(`site_${problemsOf(preview)[0]}`);
        }
      }
      expect((await cityAt(rejectDir)).plan).toBeNull();
      // 合法的每一處都真的下得了令（各自在一座新城，因為一次只能有一個目標）。
      for (const key of legal) {
        const [x, y] = key.split(",").map(Number);
        const acceptDir = root(`accept-${building}`);
        const result = await order(await sharedLedger(acceptDir), building, at(x, y));
        expect(result.status).toBe("applied");
        const plan = (await cityAt(acceptDir)).plan;
        expect(keysOf(plan.cells)).toEqual(keysOf(siteCheck(city, building, at(x, y)).cells));
      }
    }
  });

  test("缺料時指定位置：整片占地保留、庫存不預扣；換 space、重開與 checkpoint 後仍是同一個目標", async () => {
    const dir = root("short-of-stock");
    const ledger = await sharedLedger(dir);
    await settle(ledger, [
      activity({ sessionId: "a", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "a1", TEN_K, { sessionId: "a" })]) }),
    ]);
    const before = await cityAt(dir);
    expect(stock(before)).toEqual(times(1));
    const costs = CITY_BUILDINGS.library.costs;
    expect(Object.entries(costs).some(([key, need]) => before.resources[key] < need)).toBe(true);

    expect((await order(ledger, "library", at(-1, 2))).status).toBe("applied");
    const reserved = await cityAt(dir);
    expect(stock(reserved)).toEqual(times(1)); // 庫存不預扣
    expect(reserved.plan).toMatchObject({ building: "library", label: CITY_BUILDINGS.library.label, x: -1, y: 2, costs });
    expect(keysOf(reserved.plan.cells)).toEqual(["-1,2", "-1,3", "0,2", "0,3"]);
    // 還缺多少：配方減掉現在的庫存（不會是負數）。
    expect(reserved.plan.missing).toEqual(Object.fromEntries(Object.entries(costs)
      .map(([key, need]) => [key, Math.max(0, need - reserved.resources[key])])
      .filter(([, amount]) => amount > 0)));

    // 之後的工作照常進倉庫，不被預定地吃掉；一次只有一個目標，第二個下令被拒。
    await settle(ledger, [
      activity({ sessionId: "a", events: round(REPO_A, T(0), T(60_000), [usageEvent(T(1_000), "a1", TEN_K, { sessionId: "a" })]) }),
      activity({ sessionId: "b", events: round(REPO_B, T(70_000), T(90_000), [usageEvent(T(71_000), "b1", TEN_K, { sessionId: "b" })]) }),
    ]);
    expect(stock(await cityAt(dir))).toEqual(times(2));
    const second = await order(ledger, "house", at(3, 0));
    expect(second).toMatchObject({ status: "rejected", reason: "plan_exists" });

    // 另一個 space（另一個帳本實例）、重開、做 checkpoint 之後：同一個目標、同一片占地。
    const otherSpace = await cityAt(dir);
    expect(otherSpace.plan).toEqual((await cityAt(dir)).plan);
    const reopened = await sharedLedger(dir);
    await reopened.checkpoint();
    const afterCheckpoint = await cityAt(dir);
    expect(afterCheckpoint.plan).toEqual(otherSpace.plan);
    expect(stock(afterCheckpoint)).toEqual(times(2));
    expect(siteCheck(afterCheckpoint, "house", at(0, 3)).ok).toBe(false);
  });

  test("兩個視窗同時送出目標：最多一個生效，未成功的位置不殘留占地", async () => {
    const cases = [
      { name: "apart", a: ["market", at(3, 0)], b: ["library", at(-1, 2)] },
      { name: "overlap", a: ["market", at(3, 0)], b: ["house", at(4, 1)] },
    ];
    for (const { name, a, b } of cases) {
      const dir = root(`race-${name}`);
      const { ios, arm } = racingIos();
      const [windowA, windowB] = await Promise.all(ios.map((io) => sharedLedger(dir, { io })));
      arm();
      const results = await Promise.all([order(windowA, ...a), order(windowB, ...b)]);
      const won = results.filter((result) => result.status === "applied");
      expect(won).toHaveLength(1);
      const lost = results.find((result) => result.status !== "applied");
      expect(lost.reason).toBe("plan_exists");
      // 兩個視窗確實撞在一起：輸的那一邊是重讀之後才被拒。
      expect(lost.attempts).toBeGreaterThan(1);

      const city = await cityAt(dir);
      const [winner, loser] = results[0].status === "applied" ? [a, b] : [b, a];
      expect(city.plan).toMatchObject({ building: winner[0], ...winner[1] });
      expect(keysOf(city.plan.cells)).toEqual(keysOf(siteCheck({ plan: null }, winner[0], winner[1]).cells));
      expect(stock(city)).toEqual([0, 0, 0]);
      // 輸家的位置沒有殘留占地：預定地只有贏家那一片，輸家自己那幾格（如果不在贏家占地裡）
      // 仍是空地；重疊的情況由上一行的「預定地＝贏家整棟占地」保證沒有多出來的格子。
      const winnerCells = new Set(keysOf(city.plan.cells));
      const leftover = siteCheck(city, loser[0], loser[1]).cells.filter((cell) => !winnerCells.has(`${cell.x},${cell.y}`));
      if (name === "apart") expect(leftover.length).toBeGreaterThan(0);
      for (const cell of leftover) expect(cell.problem).toBeNull();
    }
  });

  test("固定地圖的地形：起始區的格子都看得到地形，迷霧外也有確定的地形（重算一樣）", () => {
    expect(terrainAt(at(0, 0))).toBe("grass");
    expect(terrainAt(at(-2, -3))).toBe("water");
    expect(terrainAt(at(4, -2))).toBe("cliff");
    expect(terrainAt(at(1, -3))).toBe("scrub");
    expect(terrainAt(at(2, -2))).toBe("rubble");
    for (const [x, y] of [[12, -7], [-30, 41], [5, 5]]) expect(terrainAt(at(x, y))).toBe(terrainAt(at(x, y)));
  });
});
