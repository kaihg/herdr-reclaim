import { Input } from "gpui-base";
import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

const REASON_LABELS = {
  "no-session-source": "沒有 session 證據",
  "terminal-only": "只有 terminal ID",
  "ambiguous-session-source": "session 證據不唯一",
  "ambiguous-repository": "repo 證據不唯一",
  "no-hook-repository-evidence": "沒有 repo 證據",
  "no-matching-expedition": "沒有匹配遠征",
  "no-matching-adapter-session": "對不到 adapter session",
  "no-eligible-changes": "沒有可收成變更",
  "remote-merge": "遠端合併",
};
/** Search panel mounted only when opened from the selected expedition/tile details. */
export function historyPanel({ state, input, theme, onClose, onQuery, onJump }) {
  const results = state.results ?? [];
  return v_flex().id("history-panel").size_full().gap(8).p(14).bg(theme.chrome)
    .border(1).border_color(theme.border)
    .child(h_flex().items_center().justify_between()
      .child(div().text_size(16).font_semibold().child("城鎮歷程搜尋"))
      .child(action("返回詳情", theme, onClose)))
    .child(div().text_size(10).text_color(theme.dim)
      .child("可輸入 date:、city:、session:、commit:、path:；未解析活動也會列出。"))
    .child(Input.new(input))
    .child(div().text_size(10).text_color(theme.muted).child(`${state.total ?? results.length} 筆符合 · 輸入後按 Enter 搜尋`))
    .child(v_flex().id("history-results").flex_1().min_h(0).gap(4).overflow_y_scrollbar()
      .children(results.map((item, index) => resultRow(item, index, theme, (cx) => onJump(item, cx)))))
    .when(Boolean(state.error), (element) => element.child(div().text_size(10).text_color(theme.ansi1).child(state.error)));
}

function resultRow(item, index, theme, onClick) {
  const date = Number(item.at) > 0 ? new Date(Number(item.at)).toLocaleString("zh-TW") : "時間未知";
  const text = [item.subject, item.sha, REASON_LABELS[item.reason] ?? item.reason]
    .filter(Boolean).join(" · ") || (item.paths ?? []).join(", ") || item.sessionId || item.rootSessionId || "";
  return v_flex().id(`history-result-${index}`).role("button").tab_index(0).accessibility_label(`${item.label ?? item.kind}: ${text}`).gap(2).p(7).rounded(4).bg(theme.surface)
    .cursor_pointer().hover((style) => style.bg(theme.hover)).on_click((_event, cx) => onClick(cx))
    .child(h_flex().gap(6).items_center()
      .child(div().text_size(11).font_semibold().child(item.label ?? item.kind))
      .child(div().text_size(9).text_color(theme.dim).child(date)))
    .child(div().text_size(10).truncate().child(text))
    .child(div().text_size(9).text_color(theme.muted).truncate().child(
      item.jump ? `${item.cityName} · ${item.rootSessionId} · 第 ${item.generation ?? 1} 代` : "無對應地格",
    ));
}

function action(label, theme, handler) {
  return div().px(8).py(4).rounded(4).cursor_pointer().bg(theme.surface)
    .hover((style) => style.bg(theme.hover)).on_click((_event, cx) => handler(cx)).child(label);
}
