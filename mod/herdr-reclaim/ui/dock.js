// 底部動作列（蓋房、市集、加速）與它彈出的面板。邏輯在 core/dock.js；這裡只畫。
// 做不到的入口只變灰、不隱藏：入口永遠看得到，按下去用提示說明原因（由呼叫端的 onBlocked 顯示）。
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { RESOURCE_LABELS } from "../core/rules.js";
import { RESOURCE_KEYS, buildOptions, maxTradeAmount, tradePreview } from "../core/dock.js";

export const DOCK_H = 40;

function pill(label, t, { selected = false, disabled = false, onClick }) {
  return div().role("button").tab_index(0)
    .px(8).py(4).rounded(4)
    .cursor_pointer()
    .bg(selected ? t.selected : t.surface)
    .border(1).border_color(selected ? t.accent : t.border)
    .hover((style) => (disabled ? style : style.bg(t.hover)))
    .on_click((_event, cx) => onClick(cx))
    .child(div().text_size(10.5).text_color(disabled ? t.dim : selected ? t.accent : t.foreground).child(label));
}

/** 底部列：三個入口。`panel` 是目前展開的面板（'build'／'market'／null）。 */
export function dockBar({ t, state, panel, onToggle, onBoost, onBlocked }) {
  const entry = (kind, label) => {
    const info = state[kind];
    return pill(label, t, {
      selected: panel === kind,
      disabled: !info.enabled,
      onClick: (cx) => (info.enabled ? onToggle(kind, cx) : onBlocked(info.reason, cx)),
    });
  };
  const boost = state.boost;
  return h_flex().id("dock").h(DOCK_H).flex_none().items_center().gap(8).px(12)
    .bg(t.chrome).border_t(1).border_color(t.border)
    .children([
      entry("build", "蓋房"),
      entry("market", "市集"),
      pill(boost.enabled ? `加速 ×${boost.scrolls}` : "加速", t, {
        disabled: !boost.enabled,
        onClick: (cx) => (boost.enabled ? onBoost(cx) : onBlocked(boost.reason, cx)),
      }),
    ]);
}

const costText = (costs) => Object.entries(costs).map(([key, amount]) => `${RESOURCE_LABELS[key]} ${amount}`).join("・");

function panelFrame(t, title, children) {
  return v_flex().id("dock-panel").gap(8).p(10).rounded(8)
    .bg(t.popover).border(1).border_color(t.border).max_w(440)
    .child(div().text_size(11).font_semibold().child(title))
    .children(children);
}

/** 蓋房面板：全部配方；買不起的標「缺 …」。 */
export function buildPanel({ t, resources, onBuild }) {
  return panelFrame(t, "蓋房（一次扣除整份配方）", buildOptions(resources).map((option) =>
    h_flex().gap(8).items_center().justify_between()
      .child(v_flex().gap(1)
        .child(div().text_size(11).text_color(option.affordable ? t.foreground : t.dim).child(option.label))
        .child(div().text_size(9).text_color(t.muted).child(
          option.affordable ? costText(option.costs) : `${costText(option.costs)} · 缺 ${costText(option.missing)}`,
        )))
      .child(pill("蓋", t, {
        disabled: !option.affordable,
        onClick: (cx) => (option.affordable ? onBuild(option, cx) : null),
      }))));
}

/** 市集面板：選付出與換成的資源、調數量、看預覽、交換。 */
export function marketPanel({ t, resources, trade, handlers }) {
  const stock = (key) => Number(resources?.[key] ?? 0);
  const preview = tradePreview(trade);
  const max = maxTradeAmount(resources, trade.from);
  const row = (title, current, onPick, disabledOf) =>
    h_flex().gap(6).items_center()
      .child(div().w(34).text_size(10).text_color(t.dim).child(title))
      .children(RESOURCE_KEYS.map((key) => pill(`${RESOURCE_LABELS[key]} ${stock(key)}`, t, {
        selected: current === key,
        disabled: disabledOf(key),
        onClick: (cx) => onPick(key, cx),
      })));
  const canTrade = trade.amount > 0;
  return panelFrame(t, "市集（3 換 1）", [
    row("付出", trade.from, handlers.onFrom, (key) => maxTradeAmount(resources, key) <= 0),
    row("換成", trade.to, handlers.onTo, (key) => key === trade.from),
    h_flex().gap(6).items_center()
      .child(div().w(34).text_size(10).text_color(t.dim).child("數量"))
      .child(pill("−", t, { disabled: trade.amount <= 1, onClick: (cx) => handlers.onStep(-1, cx) }))
      .child(div().w(30).text_center().text_size(12).font_semibold().child(String(trade.amount)))
      .child(pill("＋", t, { disabled: trade.amount >= max, onClick: (cx) => handlers.onStep(1, cx) }))
      .child(pill(`最多 ${max}`, t, { disabled: max <= 0 || trade.amount >= max, onClick: (cx) => handlers.onMax(cx) })),
    h_flex().gap(8).items_center().justify_between()
      .child(div().text_size(10.5).text_color(canTrade ? t.foreground : t.dim).child(
        canTrade
          ? `付出 ${RESOURCE_LABELS[trade.from]} ${preview.give} → 得到 ${RESOURCE_LABELS[trade.to]} ${preview.get}`
          : `${RESOURCE_LABELS[trade.from]}不到 3，換不出來`,
      ))
      .child(pill("交換", t, { disabled: !canTrade, selected: canTrade, onClick: (cx) => (canTrade ? handlers.onConfirm(cx) : null) })),
  ]);
}
