import { describe, expect, test } from "bun:test";
import { searchHistory } from "../core/history.js";
import { CityLedger } from "../core/ledger.js";
import { createFileIo } from "./fs-io.js";

const cityId = "/repos/orchard/.git";
const tiles = [
  { cityId, rootSessionId: "session-archived", generation: 1, x: 0, y: -1, landStage: "archived", harvestedPaths: ["docs/old-town.md"] },
  { cityId, rootSessionId: "session-withdrawn", generation: 2, x: 1, y: 0, landStage: "withdrawn", harvestedPaths: [] },
];
const records = [
  { seq: 10, at: Date.parse("2026-11-20T09:00:00Z"), kind: "commit", cityId, rootSessionId: "session-archived", generation: 1, sha: "abc123", subject: "Build orchard history search", reason: "no-session-source" },
  { seq: 11, at: Date.parse("2026-11-20T09:01:00Z"), kind: "harvest", cityId, rootSessionId: "session-archived", generation: 1, sha: "abc123", subject: "Build orchard history search", resources: { wood: 10 }, claims: ["docs/old-town.md|blob"], rulesVersion: 2 },
  { seq: 12, at: Date.parse("2026-11-20T09:02:00Z"), kind: "expedition", cityId, rootSessionId: "session-withdrawn", generation: 2, x: 1, y: 0 },
];

describe("歷程搜尋", () => {
  test("日期、城、session、commit 訊息與成果路徑都能搜尋並保留 generation 跳轉", () => {
    const search = (query) => searchHistory({ records, tiles, cityNames: { [cityId]: "orchard" }, query });
    expect(search("date:2026-11-20").total).toBe(3);
    expect(search("city:orchard session:archived").results).toHaveLength(3);
    expect(search("commit:history").results[0].sha).toBe("abc123");
    expect(search("path:docs/old-town.md").results[0].jump).toEqual({
      kind: "expedition", cityId, rootSessionId: "session-archived", generation: 1,
    });
    expect(search("session:withdrawn").results[0].jump.generation).toBe(2);
  });

  test("未解析活動可按 session 與 cwd 搜尋", () => {
    const result = searchHistory({ unresolvedActivities: [{ sessionId: "lost-session", cwd: "/tmp/lost-repo", at: 123 }], query: "session:lost" });
    expect(result.results).toMatchObject([{ label: "未解析活動", reason: "unresolved", jump: null }]);
    expect(searchHistory({ unresolvedActivities: [{ sessionId: "lost-session", cwd: "/tmp/lost-repo", at: 123 }], query: "lost-repo" }).total).toBe(1);
  });

  test("checkpoint 歷程索引保留 withdrawn generation 與 checkpoint 後尾端", async () => {
    const dir = `/tmp/reclaim-history-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const io = createFileIo();
    const ledger = await new CityLedger({ io, dir, cityId }).open();
    await ledger.submit(() => ({ opId: "e1", kind: "expedition", cityId, rootSessionId: "archived", generation: 1, x: 0, y: -1, at: 100 }));
    await ledger.submit(() => ({ opId: "a1", kind: "landAction", cityId, rootSessionId: "archived", generation: 1, action: "withdraw", at: 200 }));
    await ledger.checkpoint();
    await ledger.submit(() => ({ opId: "e2", kind: "expedition", cityId, rootSessionId: "new", generation: 1, x: 1, y: 0, at: 300 }));
    const history = await ledger.historyRecords();
    expect(history.map((entry) => entry.kind)).toEqual(["expedition", "landAction", "expedition"]);
    expect((await ledger.historyOf("archived", 1)).entries.map((entry) => entry.kind)).toEqual(["expedition", "landAction"]);
  });
});
