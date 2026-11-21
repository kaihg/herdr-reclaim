// 邏輯格與 3/4 投影分開（proposal §4、§1）：BFS 選地只看邏輯座標，
// 螢幕位置由 projectTile 另外算，之後換投影不用動規則。

/**
 * 城鎮中心：2×2 共四格，不分配給任何遠征，固定是城市的心臟。
 * `CENTER` 是這一塊的錨點（左上角的邏輯座標），標籤與詳情都掛在它身上。
 */
export const CENTER = { x: 0, y: 0 };
export const CENTER_CELLS = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

export function isCenterCell({ x, y }) {
  return (x === 0 || x === 1) && (y === 0 || y === 1);
}

/**
 * 中心塊上下左右相接的 8 格（§4 的相鄰只算 4 向，斜角不算）：開城就是已揭開的空地，
 * 依北、東、南、西排，同一側由左到右、由上到下；這個順序也是 BFS 選地的起點順序。
 */
export const CENTER_RING = [
  { x: 0, y: -1 }, { x: 1, y: -1 },
  { x: 2, y: 0 }, { x: 2, y: 1 },
  { x: 1, y: 2 }, { x: 0, y: 2 },
  { x: -1, y: 1 }, { x: -1, y: 0 },
];

/** 中心塊四個斜角的格子：不算相鄰、不是選地起點，但開城就揭開（看得到地面）。 */
export const CENTER_CORNERS = [
  { x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 2 }, { x: -1, y: 2 },
];

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
 * 最近的未佔用格：從中心塊相接的 8 格起 BFS，距離相同時依北、東、南、西（§4）。
 * 中心的四格永遠不算可用格；空城的第一支遠征因此拿到 (0, -1)。
 */
export function bfsNextTile(isTaken) {
  const seen = new Set(CENTER_CELLS.map(keyOf));
  const queue = [];
  for (const spot of CENTER_RING) {
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

/**
 * 已揭開（看得到地面）的格子鍵：中心塊、相接的 8 格與四個斜角（共 16 格＝4×4）從開城就是；
 * 之後每一格達到 100 點（已開墾／已建）時，它自己和上下左右 4 格也揭開（§4）。
 * 只回傳「看得到」的集合：有沒有遠征在上面是另一件事。
 */
export function revealedKeys(tiles = []) {
  const revealed = new Set([...CENTER_CELLS, ...CENTER_RING, ...CENTER_CORNERS].map(keyOf));
  for (const tile of tiles) {
    if (tile.landStage !== "cleared" && tile.landStage !== "built") continue;
    revealed.add(keyOf(tile));
    for (const step of DIRECTIONS) revealed.add(keyOf({ x: tile.x + step.x, y: tile.y + step.y }));
  }
  return revealed;
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
  const axis = (value, sizeValue, viewportValue) => {
    const limit = Math.min(0, viewportValue - sizeValue);
    return Math.max(limit, Math.min(0, value));
  };
  return {
    x: axis(camera.x, size.width, viewport.width),
    y: axis(camera.y, size.height, viewport.height),
  };
}

/**
 * 捲動／平移：把相機往 delta 的反方向移（往下捲＝內容往上），再夾範圍。
 */
export function panCamera(camera, delta, size, viewport) {
  return clampCamera({ x: camera.x - delta.x, y: camera.y - delta.y }, size, viewport);
}

/**
 * 選取／跳轉的保證：那一格的**整個菱形**要落在視窗內。在相機上做最小位移；
 * 視窗比一格還小的時候（極窄 pane）就把它置中（至少整格看得到）。
 */
export function ensureVisible(cell, camera, rect, radius = MAP_RADIUS, tile = TILE, margin = 0) {
  const origin = originInContent(radius, tile);
  const spot = projectTile(cell, tile);
  // 入畫的外框＝格子方框再加 margin：mock 地物與標籤畫在方框內，但留有幾 px 的安全邊，
  // 邊緣的建築才不會看起來被切掉（`margin` 由呼叫端給，測試用同一個值）。
  const width = tile.w + margin * 2;
  const height = tile.h + margin * 2;
  const axis = (start, size, from, limit) => {
    if (size >= limit - from) return from + (limit - from) / 2 - (start + size / 2); // 比可見區大：置中
    if (start < from) return from - start;
    if (start + size > limit) return limit - (start + size);
    return 0;
  };
  const x0 = rect.x ?? 0;
  const y0 = rect.y ?? 0;
  return {
    x: camera.x + axis(camera.x + origin.left + spot.left - margin, width, x0, x0 + rect.width),
    y: camera.y + axis(camera.y + origin.top + spot.top - margin, height, y0, y0 + rect.height),
  };
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
 * 兩者都靠左緣，所以保守地把整條高度扣掉——寧可把選取格放低／放高，也不要被蓋住或被上緣裁掉。
 */
export function visibleRect(area, legendSize, metricsSize) {
  const top = 6 + (legendSize?.height ?? 0) + 6;
  const bottom = area.height - (metricsSize ? metricsSize.height + 12 : 0);
  return { x: 0, y: top, width: area.width, height: Math.max(24, bottom - top) };
}
