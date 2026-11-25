// commit 的內容 claim：共用城市的成果加成（#24）只認首見的路徑與內容版本。
import { describe, expect, test } from "bun:test";

import { changesOfCommit, classifyPath } from "../core/harvest.js";

describe("commit 的內容分類與 claim", () => {
  test("依測試、文件、設定、程式優先序分類並排除產物與依賴", () => {
    expect(classifyPath("tests/README.md")).toBe("test");
    expect(classifyPath("docs/guide.md")).toBe("document");
    expect(classifyPath("config/app.json")).toBe("config");
    expect(classifyPath("src/main.js")).toBe("code");
    expect(classifyPath("vendor/pkg/index.js")).toBe(null);
    expect(classifyPath("package-lock.json")).toBe(null);
  });

  test("同一路徑只算一次；新增用結果 blob 當 claim，刪除用 first-parent blob", () => {
    const units = changesOfCommit([
      { status: "M", path: "src/a.js", resultBlob: "code1" },
      { status: "M", path: "src/a.js", resultBlob: "code2" },
      { status: "A", path: "tests/a.test.js", resultBlob: "test1" },
      { status: "D", path: "src/old.js", oldBlob: "prior" },
    ]);
    expect(units.map((unit) => [unit.path, unit.category, unit.claim])).toEqual([
      ["src/a.js", "code", "src/a.js|code1"],
      ["tests/a.test.js", "test", "tests/a.test.js|test1"],
      ["src/old.js", "code", "src/old.js|deleted|prior"],
    ]);
  });

  test("內容不變的改名不計；排除路徑沒有 claim", () => {
    const units = changesOfCommit([
      { status: "R100", path: "src/new.js", oldPath: "src/old.js", oldBlob: "same", resultBlob: "same" },
      { status: "M", path: "vendor/lib.js", resultBlob: "v1" },
      { status: "M", path: "bun.lockb", resultBlob: "l1" },
    ]);
    expect(units).toEqual([]);
  });
});
