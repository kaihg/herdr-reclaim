// 行會、額度與建築派系的畫面（proposal §9、§14.1；ticket #12）。
//
// 這一層只把 core/provider-stats.js 算好的資料畫出來：上方的主要行會、右側遠征的投入排行，
// 以及中央格的行會人力清單。沒有儲存、沒有規則，也不改任何數值。
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { formatFaction, guildQuotaLine, investmentRows } from "../core/provider-stats.js";

/** 上方右側：主要行會與它明確回報的額度；拿不到就顯示未知（§9）。 */
export function guildBlock(city, quotas, t) {
  const guild = city.guild;
  const line = guild?.provider ? guildQuotaLine(quotas, guild.provider) : null;
  // 沒有主要行會（例如全部用量都未知）時，額度一行不能借用整份快照的理由。
  const fallback = guild?.provider ? `未知（${quotas?.reason ?? "拿不到額度回報"}）` : "未知（沒有主要行會）";
  return [
    div().text_size(10).text_color(t.dim).child("主要行會"),
    div().text_size(12.5).truncate().child(guild ? formatFaction(guild) : "未知"),
    div()
      .text_size(9)
      .text_color(line?.known === true ? t.muted : t.dim)
      .truncate()
      .child(line ? line.text : fallback),
  ];
}

/**
 * 右側詳情的投入區（§9）：依 provider 排行的投入、比較用的基準、限制與未知欄位。
 * 未知欄位來自 #11 的 usage.unknownFields；這裡明講「未知」，不當成 0。
 * 比較基準的限制與未知欄位清單是工程說明，`dev`（開發模式）才顯示。
 */
export function investmentSection(detail, t, dev = false) {
  const rows = investmentRows(detail.investment).map((row) =>
    h_flex()
      .w_full()
      .gap(6)
      .items_center()
      .child(div().flex_1().min_w(0).text_size(9.5).truncate().child(`${row.name} · ${row.value}`))
      .child(div().text_size(9).text_color(t.dim).child(row.share > 0 ? `${row.share}%` : "")),
  );
  const unknownFields = detail.investment?.total?.unknownFields ?? [];
  return [
    div().text_size(10).text_color(t.dim).child("投入（依 provider）"),
    ...(rows.length ? rows : [div().text_size(9).text_color(t.muted).child("沒有可歸戶的 provider 用量")]),
    dev ? div().text_size(9).text_color(t.muted).child(detail.investmentNote) : null,
    dev && unknownFields.length
      ? div().text_size(9).text_color(t.muted).child(`未知欄位：${unknownFields.join("・")}（不補 0）`)
      : null,
    div().text_size(10).text_color(t.dim).child("建築派系"),
    div().text_size(11).truncate().child(formatFaction(detail.faction)),
  ].filter(Boolean);
}

/** 中央格的「行會人力」清單：provider 原始回報、重置與擷取時間，或未知的原因（§9）。 */
export function quotaSection(detail, t) {
  return [
    div().text_size(10).text_color(t.dim).child("行會人力（provider 回報）"),
    ...detail.quota.map((line) =>
      div()
        .text_size(9)
        .text_color(line.known ? t.muted : t.dim)
        .child(line.text)),
  ];
}

/** 左側遠征卡的一行：有歸戶就用派系名，沒有就用「無派系」。 */
export function factionTag(tile, t) {
  return div()
    .text_size(9)
    .text_color(tile.faction?.provider ? t.muted : t.dim)
    .truncate()
    .child(formatFaction(tile.faction));
}
