// 邏輯座標與 3/4 投影：共用城市的地圖（#25）用這一支，規則與 __drawing__ 分開。
//
// 地圖是固定格大小＋原生雙軸捲動：內容區是整片投影外框，相機決定看到哪一塊。
// 命中一律回到地面菱形（`cellAtOffset`）：相鄰格的菱形只共邊、不互相包含。
//
// 這裡不再有遠征配地（BFS 選格、起始揭開圈）：共用城市的地形、揭開與占地判準在
// core/city-map.js，這一支只留投影與相機。

export const CENTER = { x: 0, y: 0 };

/** 城鎮中心 2×2 的四格（左上角 (0, 0)）：每一格自己收事件，點哪一格都算中心。 */
export const CENTER_CELLS = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

/** 這一格是不是城鎮中心（帳本的選址前提與畫面共用同一個判斷）。 */
export function isCenterCell({ x, y }) {
  return x >= CENTER.x && x < CENTER.x + 2 && y >= CENTER.y && y < CENTER.y + 2;
}

/** 地圖至少畫到這個半徑（共用城市會隨揭開範圍長大，見 main.js 的 sharedRadius）。 */
export const MAP_RADIUS = 9;

/** 預設格大小（實際大小依 pane 寬度調整，見 main.js 的 tileSize）。 */
export const TILE = { w: 84, h: 44 };

export function keyOf({ x, y }) {
  return `${x},${y}`;
}

/** 邏輯座標 → 畫面上的位移（相對於中心那格）。 */
export function projectTile({ x, y }, tile = TILE) {
  return { left: ((x - y) * tile.w) / 2, top: ((x + y) * tile.h) / 2 };
}

/** 地圖內容（可捲動區）的像素大小：`(2r+1)²` 格的斜俯視投影外框。 */
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
 * 相鄰格的菱形只共邊、不互相包含，所以「建築不攔截地面格點擊」與
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
 * 滑鼠事件 → 這一格方框內的**版面像素**座標。事件給的座標與 bounds 是同一個單位
 * （可能含畫面縮放），所以用 bounds.width / 格寬 自己校正，不猜 zoom、不怕每個元素
 * 的 local_position 原點不同。bounds 沒有寬度時當成已經是版面 px。
 */
export function eventPoint(position, bounds, tile = TILE) {
  if (!position) return null;
  const width = Number(bounds?.width) || tile.w;
  const scale = width / tile.w;
  return { x: position.x / scale, y: position.y / scale };
}

/** 事件 → 相對這一格的邏輯位移（`cellAtOffset` 的事件版；命中範圍仍是菱形）。 */
export function cellAtEvent(event, tile = TILE) {
  const point = eventPoint(event?.local_position, event?.bounds, tile);
  return point ? cellAtOffset(point, tile) : null;
}

/** 把相機夾在畫得出來的範圍內（`[viewport - size, 0]`；內容比視窗小的那一軸固定在 0）。 */
export function clampCamera(camera, size, viewport) {
  const x = viewport.width >= size.width ? 0 : Math.max(viewport.width - size.width, Math.min(0, camera.x));
  const y = viewport.height >= size.height ? 0 : Math.max(viewport.height - size.height, Math.min(0, camera.y));
  return { x, y };
}

/** 捲動：delta 是裝置回報的像素；結果同樣夾在畫得出來的範圍內。 */
export function panCamera(camera, delta, size, viewport) {
  return clampCamera({ x: camera.x + Number(delta?.x ?? 0), y: camera.y + Number(delta?.y ?? 0) }, size, viewport);
}

/** 讓某一格落在視窗中央的相機位置（地圖重畫時用，例如還原上次的選取）。 */
export function cameraFor(cell, rect, radius = MAP_RADIUS, tile = TILE) {
  const origin = originInContent(radius, tile);
  const spot = projectTile(cell, tile);
  const x0 = rect.x ?? 0;
  const y0 = rect.y ?? 0;
  return {
    x: Math.round(x0 + rect.width / 2 - (origin.left + spot.left + tile.w / 2)),
    y: Math.round(y0 + rect.height / 2 - (origin.top + spot.top + tile.h / 2)),
  };
}

/**
 * 地圖框扣掉覆蓋層之後「真正看得見」的區域。
 * 覆蓋層（左上角的圖例、左下角的量測面板）尺寸是 render 量到後回報的實測值，不是假設值。
 * 兩者都靠左緣，所以保守地把整條高度扣掉——寧可把選取格放低／放高，也不要被蓋住或被上緣裁切。
 */
export function visibleRect(area, legendSize, metricsSize) {
  const top = 6 + (legendSize?.height ?? 0) + 6;
  const bottom = area.height - (metricsSize ? metricsSize.height + 12 : 0);
  return { x: 0, y: top, width: area.width, height: Math.max(24, bottom - top) };
}
