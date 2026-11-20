// 切換 space 時城要跟著換：用資料夾找城，不開 git，也不把別的 repo 的資料夾當成這座城。
import { describe, expect, test } from "bun:test";
import { cityForFolders } from "../core/space-city.js";

const city = (repo, checkouts = []) => ({
  cityId: `${repo}/.git`,
  tiles: checkouts.map((checkout) => ({ repo: { checkout }, visits: [{ checkout }] })),
});
const A = city("/work/api");
const B = city("/work/web", ["/wt/web-feature"]);

describe("space → 城", () => {
  test("space 的資料夾在 repo 底下（含子資料夾）就是那座城", () => {
    expect(cityForFolders([A, B], ["/work/api"])).toBe(A);
    expect(cityForFolders([A, B], ["/work/web/src/ui"])).toBe(B);
    expect(cityForFolders([A, B], ["/work/web/"])).toBe(B);
  });

  test("同名前綴的另一個資料夾不算：/work/api-2 不是 /work/api", () => {
    expect(cityForFolders([A, B], ["/work/api-2"])).toBe(null);
  });

  test("worktree 是同一座城：帳本記過的 checkout 也認得", () => {
    expect(cityForFolders([A, B], ["/wt/web-feature/lib"])).toBe(B);
    expect(cityForFolders([A, B], ["/wt/unknown"])).toBe(null);
  });

  test("候選資料夾依序找：第一個對得上的算；對不上的（例如家目錄）略過", () => {
    expect(cityForFolders([A, B], ["/Users/kk", "/work/web", "/work/api"])).toBe(B);
    expect(cityForFolders([A, B], ["/Users/kk", "/tmp"])).toBe(null);
    expect(cityForFolders([A, B], [])).toBe(null);
  });

  test("巢狀 repo：取最深的那座城", () => {
    const outer = city("/work");
    expect(cityForFolders([outer, A], ["/work/api/src"])).toBe(A);
    expect(cityForFolders([outer, A], ["/work/other"])).toBe(outer);
  });
});
