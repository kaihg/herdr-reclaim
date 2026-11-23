// 這一格的成果清單（commit 收成）：右側詳情只放一個「成果 N 筆」按鈕，點了才換成這個面板。
// 清單自己捲動，不會把詳情欄越撐越長；sha、claim、路徑與規則版本只有開發模式才顯示。
import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

export function harvestPanel({ title, harvests, theme, dev, onClose }) {
  return v_flex().id("harvest-panel").size_full().gap(8).p(10)
    .child(h_flex().items_center().justify_between().gap(6)
      .child(div().text_size(14).font_semibold().child(`成果 ${harvests.length} 筆`))
      .child(div().role("button").tab_index(0).px(6).py(3).rounded(4).cursor_pointer().bg(theme.surface)
        .hover((style) => style.bg(theme.hover)).on_click((_event, cx) => onClose(cx))
        .child(div().text_size(9).child("返回詳情"))))
    .child(div().text_size(10).text_color(theme.dim).truncate().child(title))
    .child(v_flex().id("harvest-list").flex_1().min_h(0).gap(4).overflow_y_scrollbar()
      .children(harvests.map((item, index) => v_flex().id(`harvest-${index}`).gap(2).p(7).rounded(4).bg(theme.surface)
        .child(div().text_size(11).font_semibold().child(item.subject))
        .child(div().text_size(10).text_color(theme.muted).child(item.resources))
        .when(dev, (element) => element
          .child(div().text_size(9).text_color(theme.dim).child(item.sha ?? "commit"))
          .child(div().text_size(9).text_color(theme.dim).child(item.detail))))));
}
