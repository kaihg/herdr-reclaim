// ticket #13：額度自動來源（proposal §15.2、§15.5）。
//
// 真實樣本是 S5 已觀察的 CLI 輸出（spikes/s5/observed.json，
// `omp usage --json --redact --no-extensions`）；測試不讀任何 provider 憑證檔。
import { describe, expect, test } from "bun:test";
import observed from "../../../spikes/s5/observed.json";
import { QUOTA_TTL_MS, quotaLines, readQuotas } from "../core/provider-stats.js";
import { QUOTA_SOURCE, parseQuotaReport, shouldRefresh } from "../core/quota-source.js";

const SAMPLE = JSON.stringify(observed);
const NOW = observed.generatedAt + 60_000;

describe("額度來源指令", () => {
  test("只允許官方 CLI 的 redacted 唯讀輸出", () => {
    expect(QUOTA_SOURCE).toEqual({ command: "omp", args: ["usage", "--json", "--redact", "--no-extensions"] });
    expect(QUOTA_SOURCE.args).toContain("--redact");
  });
});

describe("parseQuotaReport", () => {
  test("真實樣本：parse 成功、warnings 空、欄位原樣保留", () => {
    const { snapshot, error } = parseQuotaReport(SAMPLE);
    expect(error).toBeUndefined();
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.generatedAt).toBe(observed.generatedAt);
    expect(snapshot.command).toBe(observed.command);
    expect(snapshot.accountsWithoutUsage).toEqual(observed.accountsWithoutUsage);
    expect(snapshot.disabledCredentials).toEqual([]);
    // 合格 report 整筆照原樣：與樣本逐欄相同（沒有補 0、沒有改數字、沒有加欄位）。
    expect(snapshot.reports).toEqual(observed.reports);
  });

  test("真實樣本餵 readQuotas：至少三筆已知額度，都在 TTL 內", () => {
    const { snapshot } = parseQuotaReport(SAMPLE);
    const now = snapshot.generatedAt + 1_000;
    const quotas = readQuotas(snapshot, { now });
    expect(quotas.available).toBe(true);
    expect(quotas.stale).toBe(false);
    expect(quotas.entries.length).toBeGreaterThanOrEqual(3);

    const byWindow = new Map(quotas.entries.map((entry) => [`${entry.provider}/${entry.windowId}`, entry]));
    for (const [key, remaining] of [["openai-codex/7d", 88], ["anthropic/5h", 84], ["anthropic/7d", 19]]) {
      const entry = byWindow.get(key);
      expect(entry).toBeDefined();
      expect(entry.unknown).toBe(false);
      expect(entry.raw.remaining).toBe(remaining); // 原樣，不是 0 也不是 100
    }

    const known = quotaLines(quotas).filter((line) => line.known);
    expect(known.length).toBeGreaterThanOrEqual(3);
    expect(known.map((line) => line.provider)).toEqual(["openai-codex", "anthropic", "anthropic"]);
    // 沒有額度的 Codex 帳號另列未知，不合併、也不解讀成 0（§15.2）。
    expect(quotas.unknowns).toEqual([{ provider: "openai-codex", reason: "帳號沒有回報額度", fetchedAt: null }]);
  });

  test("樣本過期時，已知額度變未知（TTL 由 generatedAt 決定）", () => {
    const { snapshot } = parseQuotaReport(SAMPLE);
    const quotas = readQuotas(snapshot, { now: snapshot.generatedAt + QUOTA_TTL_MS + 1 });
    expect(quotas.stale).toBe(true);
    expect(quotas.entries.every((entry) => entry.unknown)).toBe(true);
    expect(quotaLines(quotas).filter((line) => line.known)).toEqual([]);
  });

  test("stdout 不是 JSON 或不是文字：回 error，不 throw", () => {
    const cases = [
      [undefined, "stdout 不是字串"],
      [null, "stdout 不是字串"],
      [{ reports: [] }, "stdout 不是字串"],
      ["這不是 JSON", "不是 JSON"],
      ["{\"generatedAt\":1,", "不是 JSON"],
      ["[1,2]", "最上層不是物件"],
      ["\"x\"", "最上層不是物件"],
      ["null", "最上層不是物件"],
    ];
    for (const [stdout, hint] of cases) {
      let result;
      expect(() => { result = parseQuotaReport(stdout); }).not.toThrow();
      expect(typeof result.error).toBe("string");
      expect(result.error).toContain(hint);
      expect(result.snapshot).toBeUndefined();
    }
  });

  test("缺 generatedAt／generatedAt 不是有限數字：回 error", () => {
    for (const raw of [
      { reports: [] },
      { generatedAt: null, reports: [] },
      { generatedAt: "1795082919780", reports: [] },
      { generatedAt: 0 / 0, reports: [] },
    ]) {
      const { error, snapshot } = parseQuotaReport(JSON.stringify(raw));
      expect(error).toContain("generatedAt");
      expect(snapshot).toBeUndefined();
    }
  });

  test("reports 不是陣列：回 error，不 throw", () => {
    for (const raw of [{ generatedAt: 1 }, { generatedAt: 1, reports: {} }, { generatedAt: 1, reports: "x" }]) {
      const { error, snapshot } = parseQuotaReport(JSON.stringify(raw));
      expect(error).toContain("reports 不是陣列");
      expect(snapshot).toBeUndefined();
    }
  });

  test("混一筆壞 report：好的照留、warnings 一筆、壞的不出現", () => {
    const bad = { provider: "anthropic", limits: [] }; // 缺 fetchedAt
    const { snapshot, error } = parseQuotaReport(JSON.stringify({
      command: observed.command,
      generatedAt: observed.generatedAt,
      reports: [observed.reports[0], bad],
      accountsWithoutUsage: [],
      disabledCredentials: [],
    }));
    expect(error).toBeUndefined();
    expect(snapshot.reports).toHaveLength(1);
    expect(snapshot.reports[0]).toEqual(observed.reports[0]);
    expect(snapshot.warnings).toEqual(["第 2 筆 report 沒有 fetchedAt"]);
    expect(snapshot.reports).not.toContainEqual(bad);

    // 剔除壞的之後仍然可以進 UI：好的一筆是已知額度。
    const quotas = readQuotas(snapshot, { now: snapshot.generatedAt + 1_000 });
    expect(quotas.entries.map((entry) => `${entry.provider}/${entry.windowId}`)).toEqual(["openai-codex/7d"]);
    expect(quotas.entries[0].unknown).toBe(false);
  });

  test("provider 空字串／limits 不是陣列各自剔除並記 warning", () => {
    const { snapshot } = parseQuotaReport(JSON.stringify({
      generatedAt: observed.generatedAt,
      reports: [
        { provider: "", fetchedAt: observed.generatedAt, limits: [] },
        { provider: "anthropic", fetchedAt: observed.generatedAt, limits: "x" },
        { provider: "openai-codex", fetchedAt: observed.generatedAt, limits: [] },
      ],
      accountsWithoutUsage: [],
      disabledCredentials: [],
    }));
    expect(snapshot.warnings).toEqual([
      "第 1 筆 report 沒有 provider",
      "第 2 筆 report limits 不是陣列",
    ]);
    expect(snapshot.reports.map((report) => report.provider)).toEqual(["openai-codex"]);
  });

  test("缺少 accountsWithoutUsage／disabledCredentials：當空陣列並記 warning", () => {
    const { snapshot, error } = parseQuotaReport(JSON.stringify({ generatedAt: observed.generatedAt, reports: [] }));
    expect(error).toBeUndefined();
    expect(snapshot.accountsWithoutUsage).toEqual([]);
    expect(snapshot.disabledCredentials).toEqual([]);
    expect(snapshot.warnings).toEqual([
      "accountsWithoutUsage 不是陣列，當成空陣列",
      "disabledCredentials 不是陣列，當成空陣列",
    ]);
    const quotas = readQuotas(snapshot, { now: observed.generatedAt + 1_000 });
    expect(quotas.available).toBe(true);
    expect(quotas.unknowns).toEqual([]);
  });
});

describe("shouldRefresh", () => {
  test("沒有快照或 generatedAt 不合法 → 要重抓", () => {
    for (const existing of [null, undefined, {}, { generatedAt: null }, { generatedAt: "x" }, { generatedAt: 0 / 0 }, "snapshot"]) {
      expect(shouldRefresh(existing, NOW, QUOTA_TTL_MS)).toBe(true);
    }
  });

  test("TTL 內不重抓，超過才重抓（邊界值算新鮮）", () => {
    const generatedAt = observed.generatedAt;
    expect(shouldRefresh({ generatedAt }, generatedAt, QUOTA_TTL_MS)).toBe(false);
    expect(shouldRefresh({ generatedAt }, generatedAt + QUOTA_TTL_MS, QUOTA_TTL_MS)).toBe(false);
    expect(shouldRefresh({ generatedAt }, generatedAt + QUOTA_TTL_MS + 1, QUOTA_TTL_MS)).toBe(true);
    expect(shouldRefresh({ generatedAt }, generatedAt + 9 * 60 * 60_000, QUOTA_TTL_MS)).toBe(true);
  });

  test("解析出來的快照直接判斷：剛抓的不重抓，過期才重抓", () => {
    const { snapshot } = parseQuotaReport(SAMPLE);
    expect(shouldRefresh(snapshot, snapshot.generatedAt + 60_000, QUOTA_TTL_MS)).toBe(false);
    expect(shouldRefresh(snapshot, snapshot.generatedAt + QUOTA_TTL_MS + 1, QUOTA_TTL_MS)).toBe(true);
    expect(shouldRefresh(null, snapshot.generatedAt, QUOTA_TTL_MS)).toBe(true);
  });
});
