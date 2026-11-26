// 建築 mock 素材（proposal §14）：正式美術還沒到位，這一層用「明確標示的向量 mock」代替，
// 讓共用城市（#25–#27）的建築可以完整試玩，不因缺圖而擋住。
//
// 這一支是純資料＋純函式（不 import gpui-kit／herdr），所以 bun 可以直接測它。
// 只影響顯示，不影響任何數值。

/**
 * 建築 mock 的輪廓：百分比的座標（相對於那一格的方框），
 * `top` 是屋脊、`eave` 是屋簷、`base` 是牆腳；不同種類高度不同。
 * 種類與 `core/rules.js` 的 `CITY_BUILDINGS` 一一對應。
 */
export const BUILDING_MOCK = {
  house: { label: "民居", top: 30, eave: 45, base: 60, roof: true },
  lumberyard: { label: "伐木場", top: 29, eave: 46, base: 60, roof: true },
  quarry: { label: "採石場", top: 33, eave: 48, base: 60, roof: false },
  workshop: { label: "工坊", top: 26, eave: 43, base: 60, roof: true },
  market: { label: "市場", top: 24, eave: 42, base: 60, roof: true },
  library: { label: "書庫", top: 14, eave: 39, base: 60, roof: true },
  outpost: { label: "哨站", top: 18, eave: 36, base: 60, roof: false },
};

/** 一個建築種類的 mock（沒有建築回 null）：未知種類用民居的輪廓表示。 */
export function buildingOf(entry) {
  const recipe = entry?.building ?? null;
  if (!recipe) return null;
  return { recipe, ...(BUILDING_MOCK[recipe] ?? { ...BUILDING_MOCK.house, label: recipe }) };
}

/** 建築的兩個多邊形（百分比座標）：尺寸隨格子撐開，所以任何格子大小都成立。 */
export function buildingPolygons(mock) {
  const { top, eave, base } = mock;
  return {
    roof: [[50, top], [78, eave], [22, eave]],
    body: [[24, eave], [76, eave], [76, base], [24, base]],
  };
}
