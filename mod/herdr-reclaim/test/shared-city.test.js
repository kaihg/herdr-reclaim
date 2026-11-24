// ticket #23 共用城市的基本收入：固定的工作事件 → 實際隔離帳本 → 公開的共用城市讀取模型。
// 斷言的是玩家看得到的庫存與工作進度；不測私有欄位或寫入順序。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CityLedger, cityDir } from "../core/ledger.js";
import { ingestScenario } from "../core/ingest.js";
import { ACHIEVEMENT_YIELD, RECIPES, WORK_TOKENS_PER_UNIT, WORK_YIELD } from "../core/rules.js";
import { SHARED_CITY_ID, ingestAchievements, ingestIncome, readSharedCity, sharedCityDir } from "../core/shared-city.js";
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
