// 建築 mock 與規則表的對應：每一種能蓋的建築都有畫法，畫出來的輪廓在格子方框內。
import { describe, expect, test } from "bun:test";

import { CITY_BUILDINGS } from "../core/rules.js";
import { BUILDING_MOCK, buildingOf, buildingPolygons } from "../ui/assets.js";

describe("建築 mock", () => {
  test("規則表裡的每一種建築都有 mock；名稱與規則表一致", () => {
    expect(Object.keys(BUILDING_MOCK).sort()).toEqual(Object.keys(CITY_BUILDINGS).sort());
    for (const [name, def] of Object.entries(CITY_BUILDINGS)) {
      expect(BUILDING_MOCK[name].label).toBe(def.label);
    }
  });

  test("buildingOf：共用城市的建築讀種類，未知種類用民居的輪廓表示", () => {
    expect(buildingOf({ building: "outpost" })).toMatchObject({ recipe: "outpost", label: "哨站" });
    expect(buildingOf({ building: "castle" })).toMatchObject({ recipe: "castle", label: "castle", top: BUILDING_MOCK.house.top });
    expect(buildingOf({})).toBeNull();
  });

  test("輪廓在方框內、屋脊高於屋簷、牆腳在下方；沒有屋頂的種類（哨站）靠上緣表示", () => {
    for (const mock of Object.values(BUILDING_MOCK)) {
      const { roof, body } = buildingPolygons(mock);
      for (const [x, y] of [...roof, ...body]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(100);
      }
      expect(mock.top).toBeLessThan(mock.eave);
      expect(mock.eave).toBeLessThan(mock.base);
      expect(Math.max(...body.map(([, y]) => y))).toBe(mock.base);
      expect(Math.min(...body.map(([, y]) => y))).toBe(mock.eave);
    }
    expect(BUILDING_MOCK.outpost.roof).toBe(false);
  });
});
