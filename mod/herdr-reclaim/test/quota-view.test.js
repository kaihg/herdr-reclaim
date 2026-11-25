// S4 的回歸測試：額度模型帶著原始快照，重繪／刷新時依「現在」重新判定過期（§9、§15.2）。
//
// 使用者看得到的結果：同一座已開啟的城鎮，跨過 TTL 或 resetsAt 之後，畫面顯示的是
// 「未知」而不是舊的 remaining。重新判定不呼叫外部 CLI、不碰 provider API。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUOTA_TTL_MS } from "../core/provider-stats.js";
import { quotaLines } from "../core/provider-stats.js";
import { quotaView, readQuotaView } from "../core/quota-view.js";
import { createFileIo } from "./fs-io.js";

const AT = 1_795_082_918_586;
const RESETS = AT + 3_600_000;
/** omp usage --json --redact 的形狀（見 spikes/s5/observed.json）。 */
const observed = {
  generatedAt: AT,
  reports: [{
    provider: "anthropic",
    fetchedAt: AT,
    limits: [{ id: "5h", window: { id: "5h", label: "5 小時", resetsAt: RESETS, durationMs: 18_000_000 }, amount: { used: 12, limit: 100, remaining: 88, unit: "percent" } }],
  }],
};

describe("額度模型依「現在」重新判定新鮮度", () => {
  test("同一份已開啟的模型：跨過 TTL 與 resetsAt 之後顯示未知，原始值仍留著", () => {
    const view = quotaView(observed, AT);
    expect(quotaLines(view)).toEqual([{ provider: "anthropic", known: true, text: expect.stringContaining("88 / 100") }]);
    expect(view.snapshot).toBe(observed);

    // 舊行為：refreshTown／重繪沿用上一次已解析的模型（時間停在 AT），過了 TTL 還說已知。
    expect(quotaLines(view).every((line) => line.known)).toBe(true);
    // 但也只有原始快照還留著，才可能用「現在」重新判定。
    expect(view.snapshot).toBe(observed);
    // 畫面開著超過 TTL：重繪時用同一個模型重新判定 → 未知。
    const stale = quotaView(view.snapshot, AT + QUOTA_TTL_MS + 1);
    expect(stale.stale).toBe(true);
    expect(stale.entries.every((entry) => entry.unknown && entry.reason === "資料過期")).toBe(true);
    expect(stale.entries[0].raw.remaining).toBe(88); // 原始回報原樣保留（§9）
    expect(quotaLines(stale).every((line) => line.known === false)).toBe(true);

    // 跨過重置時間：同一份快照也要失效（即使還沒到 TTL）。
    const rolled = quotaView(view.snapshot, RESETS + 1);
    expect(rolled.entries[0].unknown).toBe(true);
    expect(rolled.entries[0].reason).toBe("已過重置時間");

    // 還沒到期時重繪不會無故變成未知。
    expect(quotaView(view.snapshot, AT + 60_000).entries[0].unknown).toBe(false);
  });

  test("回報檔不存在或壞掉：模型仍是可重算的「未知」，不影響城鎮", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reclaim-quota-view-"));
    try {
      const io = createFileIo();
      const missing = await readQuotaView(io, `${dir}/quotas.json`, AT);
      expect(missing.available).toBe(false);
      expect(missing.snapshot).toBeNull();
      expect(quotaLines(quotaView(missing.snapshot, AT + QUOTA_TTL_MS + 1))).toEqual([{ provider: null, known: false, text: "未知（拿不到額度回報）" }]);

      writeFileSync(`${dir}/quotas.json`, "{ 壞掉");
      expect((await readQuotaView(io, `${dir}/quotas.json`, AT)).available).toBe(false);

      writeFileSync(`${dir}/quotas.json`, `${JSON.stringify(observed)}\n`);
      const loaded = await readQuotaView(io, `${dir}/quotas.json`, AT);
      expect(loaded.entries[0].raw.remaining).toBe(88);
      // 重新開啟（或重繪）時拿同一份快照重算：過期就未知。
      expect(quotaView(loaded.snapshot, AT + QUOTA_TTL_MS + 1).entries[0].unknown).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
