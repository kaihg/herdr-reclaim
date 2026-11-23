// 額度快照 → 畫面模型（§9、§15.2）。
//
// 新鮮度是**讀取當下**的判斷：`readQuotas(snapshot, { now })` 依 now 決定「資料過期」與
// 「已過重置時間」。所以模型不能只留解析結果——原始快照要一起留著，任何重繪或操作後的
// 刷新都用「現在」重新判定一次；不然畫面開著跨過 TTL／resetsAt 之後，仍會把舊的
// remaining 當成已知數字顯示（§9 要求過期就顯示未知）。
//
// 重新判定不呼叫外部 CLI、不碰 provider API：抓取另有排程（見 core/quota-source.js 的 claimQuotaAttempt）。
import { readQuotas } from "./provider-stats.js";

/** 原始快照 → 模型；`snapshot` 留在模型上，之後可以再依新的「現在」重算。 */
export function quotaView(snapshot, now = Date.now()) {
  const view = readQuotas(snapshot ?? null, { now });
  view.snapshot = snapshot ?? null;
  return view;
}

/** 讀額度回報檔（`quotas.json`）→ 模型；檔案不存在或壞掉都只是「未知」，不影響城鎮。 */
export async function readQuotaView(io, path, now = Date.now()) {
  const text = await io.read(path);
  if (text === null) return quotaView(null, now);
  try {
    return quotaView(JSON.parse(text), now);
  } catch {
    return quotaView(null, now);
  }
}
