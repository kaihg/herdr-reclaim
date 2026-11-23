// ticket #13：額度自動來源（proposal §15.2、§15.5）。
//
// 真實樣本是 S5 已觀察的 CLI 輸出（spikes/s5/observed.json，
// `omp usage --json --redact --no-extensions`）；測試不讀任何 provider 憑證檔。
import { describe, expect, test } from "bun:test";
import observed from "../../../spikes/s5/observed.json";
import { QUOTA_TTL_MS, quotaLines, readQuotas } from "../core/provider-stats.js";
import { QUOTA_REFRESH_MS, QUOTA_SOURCE, claimQuotaAttempt, parseQuotaReport, refreshDue } from "../core/quota-source.js";
import { CasConflict } from "../core/ledger.js";

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

describe("refreshDue", () => {
  test("沒有紀錄、不是有限數字、或紀錄在未來（時鐘被調回）→ 到期", () => {
    for (const attemptedAt of [null, undefined, "x", 0 / 0, NOW + 1]) {
      expect(refreshDue(attemptedAt, NOW)).toBe(true);
    }
  });

  test("5 分鐘內不到期，剛好滿 5 分鐘才到期", () => {
    expect(QUOTA_REFRESH_MS).toBe(5 * 60_000);
    expect(refreshDue(NOW, NOW)).toBe(false);
    expect(refreshDue(NOW, NOW + QUOTA_REFRESH_MS - 1)).toBe(false);
    expect(refreshDue(NOW, NOW + QUOTA_REFRESH_MS)).toBe(true);
  });
});

describe("claimQuotaAttempt：全域只有一個視窗搶到這一輪", () => {
  const PATH = "/tmp/quota-attempt.json";
  /** 只放一個檔案的 CAS 後端（語意與 test/fs-io.js 相同）。 */
  function memoryIo(initial = null) {
    const box = { text: initial };
    return {
      box,
      read: async () => box.text,
      write: async (_path, text, expected) => {
        if (box.text !== expected) throw new CasConflict(PATH, expected === null ? "exists" : "stale");
        box.text = text;
      },
    };
  }

  test("第一次拿到名額並記下時間；5 分鐘內第二個呼叫者（任何視窗）拿不到", async () => {
    const io = memoryIo();
    expect(await claimQuotaAttempt(io, PATH, NOW)).toBe(true);
    expect(JSON.parse(io.box.text)).toEqual({ attemptedAt: NOW });
    expect(await claimQuotaAttempt(io, PATH, NOW + 1_000)).toBe(false);
    expect(await claimQuotaAttempt(io, PATH, NOW + QUOTA_REFRESH_MS - 1)).toBe(false);
    expect(await claimQuotaAttempt(io, PATH, NOW + QUOTA_REFRESH_MS)).toBe(true);
  });

  test("同時搶：兩個視窗讀到同一份舊內容，只有一個過關", async () => {
    const io = memoryIo();
    const results = await Promise.all([claimQuotaAttempt(io, PATH, NOW), claimQuotaAttempt(io, PATH, NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("紀錄壞掉當作沒有；CAS 以外的寫入錯誤不吞掉", async () => {
    const io = memoryIo("not json");
    expect(await claimQuotaAttempt(io, PATH, NOW)).toBe(true);
    const broken = { read: async () => null, write: async () => { throw new Error("EACCES"); } };
    await expect(claimQuotaAttempt(broken, PATH, NOW)).rejects.toThrow("EACCES");
  });

  test("force（使用者按更新額度）：5 分鐘內也照抓，並重新起算自動輪", async () => {
    const io = memoryIo();
    expect(await claimQuotaAttempt(io, PATH, NOW)).toBe(true);
    expect(await claimQuotaAttempt(io, PATH, NOW + 1_000, { force: true })).toBe(true);
    expect(JSON.parse(io.box.text)).toEqual({ attemptedAt: NOW + 1_000 });
    expect(await claimQuotaAttempt(io, PATH, NOW + 1_000 + QUOTA_REFRESH_MS - 1)).toBe(false);
  });
});
