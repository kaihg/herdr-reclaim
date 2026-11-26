// 第一版的手繪範圍是 -3…4，不是整個起始 9×9；x 或 y 為 -4 的邊仍用原雜湊。
const PAINTED = new Map([
  ["-2,-3", "water"],
  ["4,-2", "cliff"],
  ["1,-3", "scrub"],
  ["1,-2", "scrub"],
  ["2,-2", "rubble"],
  ["2,-3", "rubble"],
]);

export function terrainV1({ x, y }) {
  if (x >= -3 && x <= 4 && y >= -3 && y <= 4) return PAINTED.get(`${x},${y}`) ?? "grass";
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  const roll = (h ^ (h >>> 16)) >>> 0;
  const bucket = roll % 100;
  if (bucket < 6) return "water";
  if (bucket < 11) return "cliff";
  if (bucket < 26) return "scrub";
  if (bucket < 36) return "rubble";
  return "grass";
}
