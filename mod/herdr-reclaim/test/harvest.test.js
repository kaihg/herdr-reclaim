import { describe, expect, test } from "bun:test";
import { classifyPath } from "../core/harvest.js";
import { harvestForCommit } from "../core/harvest.js";

describe("commit 收成", () => {
  test("依測試、文件、設定、程式優先序分類並排除產物與依賴", () => {
    expect(classifyPath("tests/README.md")).toBe("test");
    expect(classifyPath("docs/guide.md")).toBe("document");
    expect(classifyPath("config/app.json")).toBe("config");
    expect(classifyPath("src/main.js")).toBe("code");
    expect(classifyPath("vendor/pkg/index.js")).toBe(null);
    expect(classifyPath("package-lock.json")).toBe(null);
  });

  test("首次收成依路徑結果 blob 給資源、+20 點，已收路徑與城級 claim 不再重複", () => {
    const state = { claims: new Map(), tileById: new Map() };
    const tile = { harvestedPaths: [] };
    const result = harvestForCommit({
      cityId: "/repo/.git", rootSessionId: "s1", generation: 1, sha: "abc",
      changes: [
        { status: "M", path: "src/a.js", resultBlob: "code1" },
        { status: "A", path: "tests/a.test.js", resultBlob: "test1" },
        { status: "A", path: "tests/b.test.js", resultBlob: "test2" },
        { status: "A", path: "docs/readme.md", resultBlob: "doc1" },
      ], state, tile,
    });
    expect(result.resources).toEqual({ wood: 10, stone: 20, iron: 0, parchment: 1 });
    expect(result.points).toBe(20);
    expect(result.claims).toHaveLength(4);
    tile.harvestedPaths = result.paths;
    const repeat = harvestForCommit({
      cityId: "/repo/.git", rootSessionId: "s1", generation: 1, sha: "def",
      changes: [{ status: "M", path: "src/a.js", resultBlob: "code2" }], state, tile,
    });
    expect(repeat.points).toBe(0);
    expect(repeat.units).toHaveLength(0);
  });

  test("刪除以 first-parent blob 作 claim，內容不變 rename 不計", () => {
    const result = harvestForCommit({
      cityId: "/repo/.git", rootSessionId: "s1", generation: 1, sha: "del",
      changes: [
        { status: "D", path: "src/old.js", oldBlob: "prior" },
        { status: "R100", path: "src/new.js", oldPath: "src/old.js", oldBlob: "same", resultBlob: "same" },
      ], state: { claims: new Map() }, tile: { harvestedPaths: [] },
    });
    expect(result.claims).toEqual(["src/old.js|prior"]);
  });
});
