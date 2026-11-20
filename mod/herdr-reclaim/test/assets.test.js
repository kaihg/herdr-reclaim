// mock 素材測試（ticket #13 AC6、§14）：建築、地面、資源與派系缺正式美術時，
// 畫面用「明確標示的向量 mock」呈現。這支測試釘住 mock 的規則（純資料，不碰畫面）：
// 派的顏色與代號、地面怎麼從收成推出來、建築高度依種類不同、狀態標記與圖例完整。
import { describe, expect, test } from "bun:test";

import {
  BUILDING_MOCK, FACTION_MOCK, GROUND_MOCK, NO_FACTION, STAGE_MARKS,
  buildingOf, buildingPolygons, factionStyle, groundOf, legendGroups, stageCounts, stageOf,
} from "../ui/assets.js";

// herdr 主題提供的顏色名稱（herdr.d.ts 的 theme() 說明）；mock 只能用這些。
const THEME_TOKENS = new Set([
  "background", "surface", "canvas", "chrome", "popover", "raised", "hover", "selected", "border", "input",
  "foreground", "muted", "dim", "accent", "accent_foreground", "solid", "solid_foreground", "selection",
  "working", "blocked", "done", "idle", "unknown",
  ...Array.from({ length: 16 }, (_value, index) => `ansi${index}`),
]);

describe("派系 mock", () => {
  test("四個 provider 各有一種顏色與代號，沒有用量時是無派系", () => {
    expect(Object.keys(FACTION_MOCK)).toEqual(["anthropic", "openai-codex", "google", "databricks"]);
    expect(factionStyle({ provider: "google" })).toMatchObject({ label: "Google", token: "ansi4" });
    expect(factionStyle(null)).toMatchObject({ id: "none", label: "無派系" });
    expect(factionStyle({ provider: null })).toMatchObject({ label: "無派系" });
  });

  test("沒見過的 provider 不會消失：沿用它的名字，顏色回到安全值", () => {
    const style = factionStyle({ provider: "newco" });
    expect(style.label).toBe("newco");
    expect(THEME_TOKENS.has(style.token)).toBe(true);
  });
});

describe("地面 mock", () => {
  const harvest = (resources) => ({ harvests: [{ resources }] });

  test("依收成過的資源決定地，最多者優先", () => {
    expect(groundOf(harvest({ wood: 20, stone: 10 }))).toBe("wood");
    expect(groundOf(harvest({ wood: 1, stone: 30 }))).toBe("stone");
    expect(groundOf(harvest({ iron: 4 }))).toBe("iron");
    expect(groundOf(harvest({ parchment: 2 }))).toBe("parchment");
    expect(groundOf({ harvests: [{ resources: { wood: 10 } }, { resources: { parchment: 30 } }] })).toBe("parchment");
  });

  test("還沒有收成是勘查地，不是猜的", () => {
    expect(groundOf({})).toBe("survey");
    expect(groundOf(null)).toBe("survey");
    expect(groundOf(harvest({ wood: 0, stone: 0 }))).toBe("survey");
  });
});

describe("建築 mock", () => {
  test("配方名對到 mock，而且高度看得出差別（城牆最矮、圖書館最高）", () => {
    const tops = ["wall", "house", "workshop", "warehouse", "library"].map((name) => BUILDING_MOCK[name].top);
    expect(tops).toEqual([...tops].sort((a, b) => b - a)); // 數字愈大＝愈矮
    expect(new Set(tops).size).toBe(tops.length);
    expect(BUILDING_MOCK.wall.roof).toBe(false);
    expect(Object.values(BUILDING_MOCK).filter((mock) => !mock.roof).length).toBe(1);
  });

  test("沒有建築回 null；沒見過的配方用民居的輪廓但保留原配方名", () => {
    expect(buildingOf({})).toBeNull();
    expect(buildingOf({ building: { recipe: "house" } })).toMatchObject({ recipe: "house", label: "民居" });
    expect(buildingOf({ building: { recipe: "tower" } })).toMatchObject({ recipe: "tower", label: "tower", top: BUILDING_MOCK.house.top });
  });

  test("輪廓是百分比座標，屋脊在屋簷之上、牆腳在屋簷之下", () => {
    const { roof, body } = buildingPolygons(BUILDING_MOCK.library);
    expect(roof[0][1]).toBe(BUILDING_MOCK.library.top);
    expect(roof[0][1]).toBeLessThan(roof[1][1]);
    expect(body[0][1]).toBe(BUILDING_MOCK.library.eave);
    expect(body[2][1]).toBe(BUILDING_MOCK.library.base);
    expect(body[2][1]).toBeGreaterThan(body[0][1]);
  });
});

describe("狀態與圖例", () => {
  test("五種土地階段各有文字，沒有階段的舊資料當預留", () => {
    expect(Object.keys(STAGE_MARKS)).toEqual(["reserved", "cleared", "built", "withdrawn", "archived"]);
    expect(stageOf({ landStage: "archived" }).label).toBe("▨ 已封存");
    expect(stageOf({ landStage: "withdrawn" }).label).toBe("⊘ 已撤回");
    expect(stageOf({}).label).toBe("◇ 預留");
    expect(stageOf({ landStage: "奇怪的值" }).label).toBe("◇ 預留");
  });

  test("左側摘要只列真的有出現的階段，順序固定", () => {
    const tiles = [{ landStage: "cleared" }, { landStage: "reserved" }, { landStage: "cleared" }, { landStage: "archived" }];
    expect(stageCounts(tiles).map((entry) => [entry.stage, entry.count]))
      .toEqual([["reserved", 1], ["cleared", 2], ["archived", 1]]);
    expect(stageCounts([])).toEqual([]);
  });

  test("圖例涵蓋所有地面、派系（含無派系）與會出現在圖上的三個階段", () => {
    const groups = legendGroups();
    expect(groups.ground.map((entry) => entry.key)).toEqual(Object.keys(GROUND_MOCK));
    expect(groups.faction).toHaveLength(Object.keys(FACTION_MOCK).length + 1);
    expect(groups.faction.at(-1)).toEqual(NO_FACTION);
    expect(groups.stage.map((mark) => mark.label)).toEqual(["◇ 預留", "◆ 已開墾", "▲ 已建", "⊘ 已撤回", "▨ 已封存"]);
  });

  test("mock 只用主題真的有的顏色名稱（打錯字會在畫面上靜靜變成灰色）", () => {
    const tokens = [
      ...Object.values(FACTION_MOCK), NO_FACTION, ...Object.values(GROUND_MOCK), ...Object.values(STAGE_MARKS),
    ].map((entry) => entry.token);
    expect(tokens).not.toContain(undefined);
    for (const token of tokens) expect(THEME_TOKENS.has(token)).toBe(true);
  });
});
