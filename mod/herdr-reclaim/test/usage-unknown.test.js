// QA 回歸（#9 的 providerUsage／#12 的投入列）：部分欄位未知時，不能把正規化留下的
// 0 佔位顯示成 0。每一欄各自判斷未知；已知欄位照常顯示。全未知維持「未知（欄位未回報）」。
//
// 只走公開讀取模型：固定事件重播 → readTown → selectionDetail 的詳情欄位。
import { describe, expect, test } from "bun:test";
import { investmentRows } from "../core/provider-stats.js";
import { readTown, selectionDetail } from "../core/town.js";

const CITY = "/tmp/reclaim-usage-unknown/.git";
const CHECKOUT = "/tmp/reclaim-usage-unknown";
const AT = 1_800_500_000_000;
const T = (ms) => AT + ms;
const MINUTE = 60_000;
const SESSION = "usage-unknown-root";

function activity({ sessionId, events }) {
  const withSeq = events.map((event, index) => ({ eventSeq: index + 1, ...event }));
  return {
    schema: 1,
    cli: "omp",
    cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
    sessionId,
    role: "root",
    interactive: true,
    writerEpoch: `${sessionId}-1`,
    events: withSeq,
    updatedAt: withSeq.reduce((latest, event) => Math.max(latest, event.at), AT),
  };
}

const visitStart = (at) => ({
  kind: "visit_start",
  at,
  visit: { visitId: `v-${at}`, cwd: CHECKOUT, commonDir: CITY, checkout: CHECKOUT },
});
const intervalOpen = (at) => ({ kind: "interval_open", at });
const intervalClose = (at) => ({ kind: "interval_close", at });

/** §6.1 的用量事件；只填測試關心的欄位，其餘是正規化的 0。 */
const usageEvent = (at, provider, fields = {}) => ({
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
});

const townWith = (events) => readTown({ activities: [activity({ sessionId: SESSION, events })] });
const detailOf = (town) => {
  const tile = town.cities[0].tiles[0];
  return { tile, detail: selectionDetail(town, { kind: "expedition", cityId: CITY, rootSessionId: SESSION, generation: tile.generation }) };
};
const fieldOf = (detail, label) => detail.fields.find((field) => field.label === label)?.value;
const providerUsageOf = (tile, provider) => tile.providerUsage.find((entry) => entry.provider === provider).usage;

describe("用量的未知欄位不被當成 0（#9／#12 回歸）", () => {
  test("全已知：每一欄顯示原始數字，沒有未知標記", () => {
    const town = townWith([
      visitStart(T(0)), intervalOpen(T(0)),
      usageEvent(T(1000), "anthropic", { inputNonCache: 40, output: 10, costKnown: 1 }),
      intervalClose(T(MINUTE)),
    ]);
    const { tile, detail } = detailOf(town);

    expect(providerUsageOf(tile, "anthropic").unknownFields).toBeUndefined();
    expect(fieldOf(detail, "投入 anthropic")).toBe("進 40 · 出 10 · 快取讀 0 · 快取寫 0 · 成本 1.0000");
    expect(fieldOf(detail, "用量")).toBe("進 40 · 出 10 · 快取讀 0 · 快取寫 0 · 成本 1.0000");
    expect(investmentRows(tile.investment).map((row) => row.value)).toEqual(["API 等值 1.0000"]);
  });

  test("部分未知：未知欄位顯示未知，輸入仍顯示已知的 40", () => {
    const town = townWith([
      visitStart(T(0)), intervalOpen(T(0)),
      usageEvent(T(1000), "anthropic", { inputNonCache: 40, costKnown: 0, costUnknownEntries: 1, unknownFields: ["output", "cacheRead", "cacheWrite"] }),
      intervalClose(T(MINUTE)),
    ]);
    const { tile, detail } = detailOf(town);

    expect(providerUsageOf(tile, "anthropic").unknownFields).toEqual(["cacheRead", "cacheWrite", "output"]);
    expect(fieldOf(detail, "投入 anthropic")).toBe("進 40 · 出 未知 · 快取讀 未知 · 快取寫 未知 · 1 筆價格未知");
    expect(fieldOf(detail, "用量")).toBe("進 40 · 出 未知 · 快取讀 未知 · 快取寫 未知 · 1 筆價格未知");
    expect(investmentRows(tile.investment).map((row) => row.value)).toEqual(["進 40 + 出 未知"]);
    expect(tile.investment.total.unknownFields).toEqual(["cacheRead", "cacheWrite", "output"]);
  });

  test("全未知：維持未知（欄位未回報），不是投入 0", () => {
    const town = townWith([
      visitStart(T(0)), intervalOpen(T(0)),
      usageEvent(T(1000), "anthropic", { costUnknownEntries: 1, unknownFields: ["inputNonCache", "output", "cacheRead", "cacheWrite"] }),
      intervalClose(T(MINUTE)),
    ]);
    const { tile, detail } = detailOf(town);

    expect(fieldOf(detail, "投入 anthropic")).toBe("未知（欄位未回報） · 1 筆價格未知");
    expect(fieldOf(detail, "用量")).toBe("未知（欄位未回報） · 1 筆價格未知");
    expect(investmentRows(tile.investment).map((row) => row.value)).toEqual(["未知（欄位未回報）"]);
  });

  test("跨 visit 聚合：任何一段工作未知，該欄位就是未知", () => {
    const town = townWith([
      visitStart(T(0)), intervalOpen(T(0)),
      usageEvent(T(1000), "anthropic", { inputNonCache: 100, output: 20, costKnown: 2 }),
      intervalClose(T(MINUTE)),
      // 第二段換了 checkout（worktree），同一個 provider 的 output 沒有回報。
      visitStart(T(MINUTE)), intervalOpen(T(MINUTE)),
      usageEvent(T(MINUTE + 1000), "anthropic", { inputNonCache: 40, costKnown: 0, costUnknownEntries: 1, unknownFields: ["output"] }),
      intervalClose(T(2 * MINUTE)),
    ]);
    const { tile, detail } = detailOf(town);

    expect(tile.visits).toHaveLength(2);
    expect(providerUsageOf(tile, "anthropic").inputNonCache).toBe(140);
    expect(providerUsageOf(tile, "anthropic").unknownFields).toEqual(["output"]);
    expect(fieldOf(detail, "投入 anthropic")).toBe("進 140 · 出 未知 · 快取讀 0 · 快取寫 0 · 成本 2.0000 · 1 筆價格未知");
  });
});
