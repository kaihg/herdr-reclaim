// 邏輯格與 3/4 投影分開（proposal §4、§1）：BFS 選地只看邏輯座標，
// 螢幕位置由 projectTile 另外算，之後換投影不用動規則。

/** 城鎮中心：不分配給任何遠征，固定是城市的心臟。 */
export const CENTER = { x: 0, y: 0 };

/** 4 鄰居，順序就是「距離相同時依北、東、南、西」（§4）。 */
export const DIRECTIONS = [
  { name: "北", x: 0, y: -1 },
  { name: "東", x: 1, y: 0 },
  { name: "南", x: 0, y: 1 },
  { name: "西", x: -1, y: 0 },
];

/** 地圖畫出來的邏輯範圍：中心加減這個半徑的方格。 */
export const MAP_RADIUS = 3;

/** 一格在畫面上的大小（2:1，斜俯視 3/4）。 */
export const TILE = { w: 84, h: 44 };

export function keyOf({ x, y }) {
  return `${x},${y}`;
}

/**
 * 最近的未佔用格：從中心起 BFS，距離相同時依北、東、南、西（§4）。
 * 中心自己永遠不算可用格；空城的第一支遠征因此拿到 (0, -1)。
 */
export function bfsNextTile(isTaken) {
  const seen = new Set([keyOf(CENTER)]);
  const queue = [];
  for (const step of DIRECTIONS) {
    const spot = { x: CENTER.x + step.x, y: CENTER.y + step.y };
    seen.add(keyOf(spot));
    queue.push(spot);
  }
  for (let index = 0; index < queue.length; index++) {
    const spot = queue[index];
    if (!isTaken(spot)) return spot;
    for (const step of DIRECTIONS) {
      const next = { x: spot.x + step.x, y: spot.y + step.y };
      if (seen.has(keyOf(next))) continue;
      seen.add(keyOf(next));
      queue.push(next);
    }
  }
  throw new Error("找不到可用的格子");
}

/** 邏輯座標 → 畫面上的位移（相對於中心那格）。 */
export function projectTile({ x, y }, tile = TILE) {
  return { left: ((x - y) * tile.w) / 2, top: ((x + y) * tile.h) / 2 };
}
