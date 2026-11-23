// ticket #12：額度、投入與建築派系（proposal §9、§15.2、§15.5、§14.1）。
//
// 固定事件重播 → 公開城鎮讀取模型。額度用 S5 已觀察、去識別的回報樣本
// （spikes/s5/observed.json，`omp usage --json --redact` 的形狀）；測試不讀任何 provider 憑證。
import { describe, expect, test } from "bun:test";
import observed from "../../../spikes/s5/observed.json";
import { CityLedger } from "../core/ledger.js";
import { ingestScenario } from "../core/ingest.js";
import { QUOTA_TTL_MS, basisNote, factionOf, factionOfProvider, formatClock, investmentRows, quotaLines, readQuotas } from "../core/provider-stats.js";
import { CLEAR_POINTS, RECIPES, TRADE_RATE } from "../core/rules.js";
import { readTown, readTownFromLedger, selectionDetail } from "../core/town.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/reclaim-12/.git";
const CHECKOUT = "/tmp/reclaim-12";
const AT = 1_800_000_000_000;
const T = (ms) => AT + ms;
const MINUTE = 60_000;
const ROOT = "root-12";
const CHILD = "child-12";
const ROOT2 = "root-12b";

/** 一筆 §6.1 的用量事件；欄位預設全 0 已知，測試只填它关心的那幾欄。 */
function usageEvent(at, provider, fields = {}) {
  return {
    kind: "usage",
    at,
    sourceEntryId: `${provider}-${at}`,
    usage: {
      [provider]: {
        sourceKey: `${provider}#${at}`,
        inputNonCache: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        costKnown: 0,
        costUnknownEntries: 0,
        ...fields,
      },
    },
  };
}

function activity({ sessionId, role = "root", interactive = true, parentSessionId, events }) {
  const withSeq = events.map((event, index) => ({ eventSeq: index + 1, ...event }));
  return {
    schema: 1,
    cli: "omp",
    cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
    sessionId,
    role,
    interactive,
    ...(parentSessionId ? { parentSessionId } : {}),
    writerEpoch: `${sessionId}-1`,
    events: withSeq,
    updatedAt: withSeq.reduce((latest, event) => Math.max(latest, event.at), AT),
  };
}

const visitStart = (at, commonDir = CITY) => ({
  kind: "visit_start",
  at,
  visit: { visitId: `v-${at}`, cwd: CHECKOUT, commonDir, checkout: CHECKOUT },
});
const intervalOpen = (at) => ({ kind: "interval_open", at });
const intervalClose = (at) => ({ kind: "interval_close", at });

const repoFacts = { [CITY]: { hadHead: true } };
const tileOf = (town, rootSessionId) => town.cities.flatMap((city) => city.tiles)
  .find((tile) => tile.rootSessionId === rootSessionId);
const providersOf = (tile) => tile.investment.providers.map((entry) => entry.provider);

/** 一支 root 在城裡工作 `minutes` 分鐘，事件中間夾 usage。 */
function rootWithUsage(sessionId, minutes, events = []) {
  return activity({
    sessionId,
    events: [visitStart(T(0)), intervalOpen(T(0)), ...events, intervalClose(T(minutes * MINUTE))],
  });
}

describe("額度：保留 provider 原始回報（§9、§15.2）", () => {
  const now = observed.generatedAt + 60_000;

  test("原始 used／limit／remaining／unit、重置週期與擷取時間都保留", () => {
    const quotas = readQuotas(observed, { now });

    const codex = quotas.entries.find((entry) => entry.provider === "openai-codex");
    expect(codex.raw).toEqual({ used: 12, limit: 100, remaining: 88, unit: "percent" });
    expect(codex.windowId).toBe("7d");
    expect(codex.durationMs).toBe(604_800_000);
    expect(codex.resetsAt).toBe(1_795_420_897_000);
    expect(codex.fetchedAt).toBe(1_795_082_918_586);
    expect(codex.unknown).toBe(false);

    const fiveHour = quotas.entries.find((entry) => entry.provider === "anthropic" && entry.windowId === "5h");
    expect(fiveHour.raw.remaining).toBe(84);
    expect(fiveHour.durationMs).toBe(18_000_000);
    expect(quotas.generatedAt).toBe(observed.generatedAt);
    expect(quotas.stale).toBe(false);
  });

  test("整份快照過期時顯示未知，但原始值與擷取時間仍保留", () => {
    const quotas = readQuotas(observed, { now: observed.generatedAt + QUOTA_TTL_MS + 1 });

    expect(quotas.stale).toBe(true);
    expect(quotas.entries.every((entry) => entry.unknown && entry.reason === "資料過期")).toBe(true);
    expect(quotas.entries[0].raw.remaining).toBe(88);
    expect(quotas.entries[0].fetchedAt).toBe(1_795_082_918_586);
  });

  test("整份快照還新鮮，但某個窗口已經過重置時間：那一筆未知，其餘照舊", () => {
    const snapshot = {
      generatedAt: AT,
      reports: [{
        provider: "anthropic",
        fetchedAt: AT,
        limits: [
          { window: { id: "10m", label: "10 Min", durationMs: 600_000, resetsAt: AT + 600_000 }, amount: { used: 5, limit: 100, remaining: 95, unit: "percent" } },
          { window: { id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt: AT + 604_800_000 }, amount: { used: 20, limit: 100, remaining: 80, unit: "percent" } },
        ],
      }],
    };
    const quotas = readQuotas(snapshot, { now: AT + 700_000 });

    const rolled = quotas.entries.find((entry) => entry.windowId === "10m");
    expect(quotas.stale).toBe(false); // 整份快照還在 TTL 內
    expect(rolled.unknown).toBe(true);
    expect(rolled.reason).toBe("已過重置時間");
    expect(quotas.entries.find((entry) => entry.windowId === "7d").unknown).toBe(false);
  });

  test("拿不到回報檔時全部未知，不捏造數字", () => {
    const quotas = readQuotas(null, { now });

    expect(quotas.available).toBe(false);
    expect(quotas.entries).toEqual([]);
    expect(quotas.unknowns).toEqual([]);
    expect(quotaLines(quotas)).toEqual([{ provider: null, known: false, text: "未知（拿不到額度回報）" }]);
  });
});

describe("額度：未知不被解讀成 0 或 100，也不被錯誤合併（§15.2）", () => {
  const now = observed.generatedAt + 60_000;

  test("沒有額度的帳號另列未知，與同 provider 的已知回報分開", () => {
    const quotas = readQuotas(observed, { now });

    const knownCodex = quotas.entries.filter((entry) => entry.provider === "openai-codex");
    const unknownCodex = quotas.unknowns.filter((entry) => entry.provider === "openai-codex");
    expect(knownCodex).toHaveLength(1);
    expect(knownCodex[0].raw.remaining).toBe(88); // 不是 0，也不是 100
    expect(unknownCodex).toEqual([{ provider: "openai-codex", reason: "帳號沒有回報額度", fetchedAt: null }]);
  });

  test("完全沒有 report 的 provider 顯示未知，不和其他 provider 合併", () => {
    const lines = quotaLines(readQuotas(observed, { now }), { providers: ["anthropic", "databricks"] });

    expect(lines.some((line) => line.provider === "databricks" && line.text === "databricks · 未知（沒有 provider report）")).toBe(true);
    const anthropic = lines.filter((line) => line.provider === "anthropic");
    expect(anthropic).toHaveLength(2); // 5h 與 7d 各一行
    expect(anthropic.every((line) => line.known)).toBe(true);
    expect(anthropic.map((line) => line.text)).toContain("anthropic · 5 Hour · 84 / 100 percent · 重置 11-19 22:20 · 擷取 11-19 18:08");
  });

  test("完全沒有回報的 provider 也帶著未知的行會人力一行", () => {
    const lines = quotaLines(readQuotas(null, { now }), { providers: ["databricks"] });
    expect(lines.map((line) => line.text)).toEqual(["databricks · 未知（沒有 provider report）"]);
  });
});

describe("投入：只算自己的 visit 與可歸戶 child（§9）", () => {
  test("同一座城的兩支遠征各算各的；child 的用量歸到它追到的 root", () => {
    const first = rootWithUsage(ROOT, 10, [usageEvent(T(60_000), "anthropic", { inputNonCache: 10 })]);
    const second = rootWithUsage(ROOT2, 10, [usageEvent(T(60_000), "openai-codex", { inputNonCache: 20 })]);
    const child = activity({
      sessionId: CHILD,
      role: "child",
      interactive: false,
      parentSessionId: ROOT,
      events: [visitStart(T(120_000)), intervalOpen(T(120_000)), usageEvent(T(180_000), "anthropic", { inputNonCache: 5 }), intervalClose(T(180_000))],
    });

    const town = readTown({ repoFacts, activities: [first, second, child] });
    const one = tileOf(town, ROOT);
    const two = tileOf(town, ROOT2);

    expect(providersOf(one)).toEqual(["anthropic"]);
    expect(one.investment.providers[0].inputNonCache).toBe(15); // 自己 10 ＋ child 5
    expect(providersOf(two)).toEqual(["openai-codex"]);
    expect(two.investment.providers[0].inputNonCache).toBe(20); // 不含另一支遠征的用量
  });

  test("別座城的用量不加到這座城的格子上", () => {
    const OTHER = "/tmp/reclaim-12-other/.git";
    const one = activity({
      sessionId: ROOT,
      events: [
        visitStart(T(0)),
        intervalOpen(T(0)),
        usageEvent(T(30_000), "anthropic", { inputNonCache: 7 }),
        intervalClose(T(30_000)),
        visitStart(T(600_000), OTHER),
        intervalOpen(T(600_000)),
        usageEvent(T(630_000), "anthropic", { inputNonCache: 99 }),
        intervalClose(T(630_000)),
      ],
    });

    const town = readTown({ repoFacts: { ...repoFacts, [OTHER]: { hadHead: false } }, activities: [one] });
    const here = tileOf(town, ROOT);
    expect(here.investment.providers[0].inputNonCache).toBe(7);
    const other = town.cities.find((city) => city.cityId === OTHER);
    expect(other.tiles[0].investment.providers[0].inputNonCache).toBe(99);
  });
});

describe("派系：投入最多的 provider（§9）", () => {
  test("費用全部已知時以 API 等值比較", () => {
    const root = rootWithUsage(ROOT, 10, [
      usageEvent(T(60_000), "anthropic", { inputNonCache: 100, costKnown: 5 }),
      usageEvent(T(120_000), "openai-codex", { inputNonCache: 400, costKnown: 1 }),
    ]);
    const tile = tileOf(readTown({ repoFacts, activities: [root] }), ROOT);

    expect(tile.investment.basis).toBe("cost");
    expect(tile.faction.name).toBe("Anthropic");
    expect(tile.faction.basis).toBe("cost");
    expect(basisNote(tile.investment)).toBe("費用以 API 等值比較");
  });

  test("任一部分成本未知就改用 non-cache input 加 output，並標示限制", () => {
    const root = rootWithUsage(ROOT, 10, [
      usageEvent(T(60_000), "anthropic", { inputNonCache: 100, costKnown: 5 }),
      usageEvent(T(120_000), "openai-codex", { inputNonCache: 400, costKnown: 0, costUnknownEntries: 1 }),
    ]);
    const tile = tileOf(readTown({ repoFacts, activities: [root] }), ROOT);

    expect(tile.investment.basis).toBe("tokens");
    expect(tile.faction.name).toBe("OpenAI"); // 進 400 ＋ 出 0 > 進 100 ＋ 出 0
    expect(basisNote(tile.investment)).toBe("成本未知：改用 non-cache input + output 比較");
    expect(investmentRows(tile.investment).map((row) => row.value)).toEqual(["進 400 + 出 0", "進 100 + 出 0"]);
  });

  test("未知欄位會標在派系比較的基準上（#11 的 usage.unknownFields）", () => {
    const root = rootWithUsage(ROOT, 10, [
      usageEvent(T(60_000), "anthropic", { inputNonCache: 100, costKnown: 5, unknownFields: ["output"] }),
    ]);
    const tile = tileOf(readTown({ repoFacts, activities: [root] }), ROOT);

    expect(tile.investment.basis).toBe("tokens");
    expect(tile.investment.providers[0].unknownFields).toEqual(["output"]);
    expect(tile.investment.total.unknownFields).toEqual(["output"]);
  });

  test("同分取 root session 的 provider；完全未知時用無派系", () => {
    const root = rootWithUsage(ROOT, 10, [
      usageEvent(T(60_000), "anthropic", { inputNonCache: 10 }),
      usageEvent(T(120_000), "openai-codex", { inputNonCache: 10 }),
    ]);
    const tied = tileOf(readTown({ repoFacts, activities: [root] }), ROOT);
    // 兩邊同分（各 10）：取 root 自己的 provider；root 自己也同分時用固定排序。
    expect(tied.faction.provider).toBe("anthropic");

    const childHeavy = activity({
      sessionId: CHILD,
      role: "child",
      interactive: false,
      parentSessionId: ROOT,
      events: [visitStart(T(30_000)), intervalOpen(T(30_000)), usageEvent(T(60_000), "openai-codex", { inputNonCache: 40 }), intervalClose(T(60_000))],
    });
    const rootSmall = rootWithUsage(ROOT, 10, []);
    const town = readTown({ repoFacts, activities: [rootSmall, childHeavy] });
    expect(tileOf(town, ROOT).faction.name).toBe("OpenAI"); // 沒有同分，child 的投入最多

    const none = tileOf(readTown({ repoFacts, activities: [rootWithUsage(ROOT, 10)] }), ROOT);
    expect(none.faction).toEqual({ id: "none", name: "無派系", provider: null, basis: "tokens", reason: "沒有可歸戶的 provider 用量" });
  });

  test("同分且 root 沒有用量時，取決於固定的排序（可重播）", () => {
    const tied = {
      basis: "tokens",
      providers: [
        { provider: "openai-codex", inputNonCache: 10, output: 0, costKnown: 0, costUnknownEntries: 0 },
        { provider: "anthropic", inputNonCache: 10, output: 0, costKnown: 0, costUnknownEntries: 0 },
      ],
    };
    expect(factionOf(tied, "openai-codex").provider).toBe("openai-codex");
    expect(factionOf(tied, null).provider).toBe("anthropic");
    expect(factionOfProvider("openai-codex")).toBe("OpenAI");
    expect(factionOfProvider("anthropic")).toBe("Anthropic");
    expect(factionOfProvider(null)).toBe("無派系");
  });
});

describe("右側詳情：選取遠征的投入與限制（§14.1）", () => {
  test("遠征詳情帶派系與依 provider 分開的投入", () => {
    const root = rootWithUsage(ROOT, 10, [
      usageEvent(T(60_000), "anthropic", { inputNonCache: 100, costKnown: 5 }),
      usageEvent(T(120_000), "openai-codex", { inputNonCache: 400, costKnown: 1 }),
    ]);
    const town = readTown({ repoFacts, activities: [root] });
    const detail = selectionDetail(town, { kind: "expedition", cityId: CITY, rootSessionId: ROOT, generation: 1 });

    expect(detail.fields).toContainEqual({ label: "派系", value: "Anthropic（anthropic）" });
    expect(detail.investment.basis).toBe("cost");
    expect(detail.investment.providers.map((entry) => entry.provider)).toEqual(["anthropic", "openai-codex"]);
    expect(detail.investmentNote).toBe("費用以 API 等值比較");
  });

  test("中央格詳情列出城裡每個 provider 的行會人力", () => {
    const root = rootWithUsage(ROOT, 10, [usageEvent(T(60_000), "anthropic", { inputNonCache: 10 })]);
    const town = readTown({
      repoFacts,
      activities: [root],
      quotas: readQuotas(observed, { now: observed.generatedAt + 60_000 }),
    });
    const detail = selectionDetail(town, { kind: "tile", cityId: CITY, x: 0, y: 0 });

    expect(detail.kind).toBe("center");
    const texts = detail.quota.map((line) => line.text);
    expect(texts).toContain("anthropic · 5 Hour · 84 / 100 percent · 重置 11-19 22:20 · 擷取 11-19 18:08");
    expect(texts).toContain("openai-codex · 未知（帳號沒有回報額度）");
  });

  test("主要行會取城裡投入最多的 provider，沒有用量時為未知", () => {
    const heavy = rootWithUsage(ROOT, 10, [usageEvent(T(60_000), "anthropic", { inputNonCache: 10 })]);
    const light = rootWithUsage(ROOT2, 10, [usageEvent(T(60_000), "openai-codex", { inputNonCache: 1 })]);
    const town = readTown({ repoFacts, activities: [heavy, light] });
    expect(town.cities[0].guild).toMatchObject({ name: "Anthropic", provider: "anthropic" });

    const none = readTown({ repoFacts, activities: [rootWithUsage(ROOT, 10)] });
    expect(none.cities[0].guild).toBe(null);
  });
});

describe("派系與額度不改變數值（§9、§17.1 情境 8）", () => {
  const dir = (name) => `/tmp/reclaim-12/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;

  /** 一支 root 工作 `minutes` 分鐘；usage 由呼叫端決定，其他事件完全相同。 */
  async function town(name, usageEvents) {
    const ledger = await new CityLedger({ io: createFileIo(), dir: dir(name), cityId: CITY }).open();
    await ingestScenario(ledger, { activities: [rootWithUsage(ROOT, 100, usageEvents)] }, CITY);
    const state = await ledger.state();
    const tile = state.tiles.find((candidate) => candidate.rootSessionId === ROOT);
    await ledger.submit(() => ({
      opId: `seed-${name}`,
      kind: "harvest",
      at: Number(tile.activatedAt) + 1_000,
      cityId: CITY,
      rootSessionId: ROOT,
      generation: tile.generation,
      claims: [`seed-${name}`],
      paths: [],
      points: 0,
      resources: { wood: 20, stone: 20, iron: 5 },
    }));
    const after = await ledger.state();
    return readTownFromLedger({
      activities: [...after.activities.values()],
      expeditions: after.tiles,
      resources: { [CITY]: after.resources },
      research: { [CITY]: after.research },
      market: { [CITY]: after.market },
    });
  }

  test("有派系與沒有派系的遠征：開墾點、資源、匯率與配方完全相同", async () => {
    const withFaction = await town("faction", [usageEvent(T(60_000), "anthropic", { inputNonCache: 1_000, costKnown: 9 })]);
    const without = await town("plain", []);
    const detailOf = (town) => selectionDetail(town, { kind: "expedition", cityId: CITY, rootSessionId: ROOT, generation: 1 });

    const a = detailOf(withFaction);
    const b = detailOf(without);
    expect(a.points).toBe(b.points);
    expect(a.points).toBe(CLEAR_POINTS);
    expect(a.buildable).toEqual(b.buildable);
    expect(a.buildBlocked).toEqual(b.buildBlocked);
    expect(a.boost).toEqual(b.boost);
    expect(withFaction.cities[0].resources).toEqual(without.cities[0].resources);
    expect(withFaction.cities[0].resources).toEqual({ wood: 20, stone: 20, iron: 5, parchment: 0 });
    expect(a.buildable.map((recipe) => recipe.costs)).toEqual(a.buildable.map((recipe) => RECIPES[recipe.name].costs));
    expect(TRADE_RATE).toBe(3);
    expect(a.faction.name).toBe("Anthropic");
    expect(b.faction.name).toBe("無派系");
    expect(formatClock(0)).toBe("未知");
  });
});

describe("完全未知的用量不算投入（QA 回歸：欄位全未知的佔位 0）", () => {
  /** §6.1 的用量事件，但四個 token 欄位都沒有回報：值是正規化的 0 佔位。 */
  const allUnknown = (at, provider) => usageEvent(at, provider, {
    unknownFields: ["inputNonCache", "output", "cacheRead", "cacheWrite"],
    costUnknownEntries: 1,
  });
  const detailOf = (activities, rootSessionId = ROOT) =>
    selectionDetail(readTown({ repoFacts, activities }), { kind: "expedition", cityId: CITY, rootSessionId, generation: 1 });

  test("只有完全未知的用量時：無派系、投入標成未知、主要行會也是無派系", () => {
    const root = rootWithUsage(ROOT, 10, [allUnknown(T(60_000), "anthropic")]);
    const town = readTown({ repoFacts, activities: [root] });

    expect(tileOf(town, ROOT).faction).toEqual({
      id: "none",
      name: "無派系",
      provider: null,
      basis: "tokens",
      reason: "沒有可歸戶的 provider 用量",
    });
    expect(tileOf(town, ROOT).investment.providers[0].measured).toBe(false);
    expect(town.cities[0].guild).toMatchObject({ name: "無派系", provider: null });

    const detail = detailOf([root]);
    expect(detail.faction.name).toBe("無派系");
    expect(detail.investmentNote).toBe("還沒有可歸戶的 provider 用量");
    expect(investmentRows(tileOf(town, ROOT).investment)).toEqual([
      { provider: "anthropic", name: "Anthropic", value: "未知（欄位未回報）", share: 0, measured: false, unknownFields: ["cacheRead", "cacheWrite", "inputNonCache", "output"] },
    ]);
  });

  test("一個全未知、另一個全已知時，已知的那個勝出（不會因為同分而取 root provider）", () => {
    const root = rootWithUsage(ROOT, 10, [
      allUnknown(T(60_000), "anthropic"),
      usageEvent(T(120_000), "openai-codex", { inputNonCache: 400, output: 20, costKnown: 1 }),
    ]);
    const tile = tileOf(readTown({ repoFacts, activities: [root] }), ROOT);

    expect(tile.faction.name).toBe("OpenAI");
    expect(tile.faction.provider).toBe("openai-codex");
    // 有一筆未知（另一個 provider 的欄位沒回報）時整組就用 token 基準，但勝出的仍是有數字的 OpenAI。
    expect(tile.faction.basis).toBe("tokens");
    expect(investmentRows(tile.investment).find((row) => row.provider === "openai-codex")).toMatchObject({ measured: true, share: 100 });
  });

  test("全未知的 root ＋ 已知的 child：child 的 provider 才是派系（反過來也一樣）", () => {
    const root = rootWithUsage(ROOT, 10, [allUnknown(T(60_000), "anthropic")]);
    const child = activity({
      sessionId: CHILD,
      role: "child",
      interactive: false,
      parentSessionId: ROOT,
      events: [visitStart(T(30_000)), intervalOpen(T(30_000)), usageEvent(T(60_000), "openai-codex", { inputNonCache: 40, costKnown: 0, costUnknownEntries: 1 }), intervalClose(T(60_000))],
    });
    expect(tileOf(readTown({ repoFacts, activities: [root, child] }), ROOT).faction.name).toBe("OpenAI");

    const knownRoot = rootWithUsage(ROOT, 10, [usageEvent(T(60_000), "anthropic", { inputNonCache: 50, costKnown: 0, costUnknownEntries: 1 })]);
    const unknownChild = activity({
      sessionId: CHILD,
      role: "child",
      interactive: false,
      parentSessionId: ROOT,
      events: [visitStart(T(30_000)), intervalOpen(T(30_000)), allUnknown(T(60_000), "openai-codex"), intervalClose(T(60_000))],
    });
    expect(tileOf(readTown({ repoFacts, activities: [knownRoot, unknownChild] }), ROOT).faction.name).toBe("Anthropic");
  });

  test("未知與已知混合時，比較基準與限制的文字正確", () => {
    const mixed = rootWithUsage(ROOT, 10, [
      allUnknown(T(30_000), "anthropic"),
      usageEvent(T(60_000), "anthropic", { inputNonCache: 500, costKnown: 5 }),
      usageEvent(T(120_000), "openai-codex", { inputNonCache: 400, costKnown: 0, costUnknownEntries: 1 }),
    ]);
    const tile = tileOf(readTown({ repoFacts, activities: [mixed] }), ROOT);
    expect(tile.investment.basis).toBe("tokens");
    expect(basisNote(tile.investment)).toBe("成本未知：改用 non-cache input + output 比較");
    // 同一個 provider 的已知與未知相加：500（已知）＋ 0（未知佔位），有數字的 anthropic 勝過 400 的 openai-codex。
    expect(tile.faction.name).toBe("Anthropic");
    expect(tile.investment.providers.map((entry) => entry.measured)).toEqual([true, true]);

    const allKnown = rootWithUsage(ROOT, 10, [usageEvent(T(60_000), "anthropic", { inputNonCache: 100, costKnown: 5 })]);
    expect(basisNote(tileOf(readTown({ repoFacts, activities: [allKnown] }), ROOT).investment)).toBe("費用以 API 等值比較");
    const none = rootWithUsage(ROOT, 10, [allUnknown(T(60_000), "anthropic")]);
    expect(basisNote(tileOf(readTown({ repoFacts, activities: [none] }), ROOT).investment)).toBe("還沒有可歸戶的 provider 用量");
  });
});
