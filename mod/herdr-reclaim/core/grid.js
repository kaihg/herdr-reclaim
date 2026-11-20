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

/** 畫出來的地圖半徑：邏輯座標是無限平面（§4），只畫出看得到的這一塊。 */
export const MAP_RADIUS = 9;

/**
 * 一格在畫面上的大小（2:1，斜俯視 3/4）。地圖用固定格大小＋原生雙軸捲動，
 * 不再依 pane 寬度縮格子：窄 pane 只會看到比較小的一塊，格子標籤不會擠在一起。
 */
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
/**
 * 地圖內容（可捲動區）的像素大小：`(2r+1)²` 格的斜俯視投影外框。
 * 半徑 9 是 19×19＝361 格（驗收的「300 格」情境）。
 */
export function contentSize(radius = MAP_RADIUS, tile = TILE) {
  return { width: (2 * radius + 1) * tile.w, height: (2 * radius + 1) * tile.h };
}

/** 邏輯座標 (0,0) 那一格的左上角，在內容座標裡的位置（投影的外框置中）。 */
export function originInContent(radius = MAP_RADIUS, tile = TILE) {
  const size = contentSize(radius, tile);
  return { left: size.width / 2 - tile.w / 2, top: size.height / 2 - tile.h / 2 };
}

/**
 * 格子內的點 → 相對這一格的位移：命中範圍就是那格的**菱形**（不是外接矩形）。
 * 相鄰格的菱形只共邊、不互相包含，所以「不同高度的建築不攔截地面格點擊」與
 * 「相鄰格不會因為外接矩形重疊而點錯」都只靠這一個函式；建築是純裝飾，沒有事件。
 *
 * 畫面上每一格自己收事件（`on_mouse_down` 的 local_position 是那一格方框內的座標），
 * 所以這裡只回相對於該格的位移；菱形之間的角屬於隔壁那格時也一併算對（距離小的贏）。
 */
export function cellAtOffset(point, tile = TILE) {
  // 一格的中心在方框的正中央；u、v 以「半格」為單位，菱形就是 |Δu| + |Δv| ≤ 1。
  const u = (point.x - tile.w / 2) / (tile.w / 2); // u = x - y
  const v = (point.y - tile.h / 2) / (tile.h / 2); // v = x + y
  const around = { x: Math.round((u + v) / 2), y: Math.round((v - u) / 2) };
  let best = null;
  // 方框內只可能落在自己或四鄰；距離 ≤ 1 才是真的落在菱形裡（順序固定所以決定性）。
  for (let ddx = -1; ddx <= 1; ddx++) {
    for (let ddy = -1; ddy <= 1; ddy++) {
      const dx = around.x + ddx;
      const dy = around.y + ddy;
      const distance = Math.abs(u - (dx - dy)) + Math.abs(v - (dx + dy));
      if (distance > 1) continue;
      if (!best || distance < best.distance) best = { dx, dy, distance };
    }
  }
  return best ? { dx: best.dx, dy: best.dy } : { dx: 0, dy: 0 };
}

/**
 * 內容座標的點 → 邏輯格（`projectTile` 的反解）：等於把點搬到 (0,0) 那一格再看落點。
 * 回傳 `{x, y}`；點在 361 格之外回 null，畫面不改選取。
 */
export function cellAtPoint(point, radius = MAP_RADIUS, tile = TILE) {
  const origin = originInContent(radius, tile);
  const { dx, dy } = cellAtOffset({ x: point.x - origin.left, y: point.y - origin.top }, tile);
  if (Math.abs(dx) > radius || Math.abs(dy) > radius) return null;
  return { x: dx, y: dy };
}

/**
 * 畫面的相機：把某一格擺到視窗中央時，整張圖要平移多少（絕對定位的子元素都加上它）。
 * 這樣「地圖一打開就在這座城身上」與「選取／跳轉的那一格帶進畫面」都不必依賴
 * 捲動容器自己的偏移（scroll_to_item 對絕對定位的子元素沒有作用）。
 */
export function cameraFor(cell, viewport, radius = MAP_RADIUS, tile = TILE) {
  const origin = originInContent(radius, tile);
  const spot = projectTile(cell, tile);
  return {
    x: Math.round(viewport.width / 2 - (origin.left + spot.left + tile.w / 2)),
    y: Math.round(viewport.height / 2 - (origin.top + spot.top + tile.h / 2)),
  };
}
