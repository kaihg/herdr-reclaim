// herdr-reclaim — spike S1 的文字面板（ticket #2 之後不再是 mod 的畫面）。
//
// 保留原因：proposal §15.1 的 S1／S2 證據就是這個面板加上 omp-extension；派工、綁定
// session 與用量對帳的讀取方式（$HERDR_RECLAIM_STATE 底下的檔案）之後由 #5 的真實
// adapter 重寫。mod 的入口現在是 main.js（C 版城鎮畫面），這個檔案沒有被載入。
//
// 原本的說明：dispatch an omp tab for a test order and show how the order, tab,
// terminal and omp session bind through the herdr-reclaim omp extension. Text only.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, appHome, checking, exec, home, nextCommand, panes, props, readTextFile, run, spaces, theme, watchFolder, writeTextFile } from "herdr";

const STATE = `${home()}/.local/state/herdr-reclaim`;
const ORDERS_FILE = `${appHome()}/data/herdr-reclaim/spike-orders.json`;
const BIND_TIMEOUT_MS = 90_000;

export default class Reclaim extends View {
  init(_props, cx) {
    this.orders = [];
    this.terminalsByAddr = {};
    this.sessions = {};
    this.cityId = null;
    this.error = null;
    if (checking()) return;
    this.loadOrders(cx);
    this.loadBridge(cx);
    this.loadCity(cx);
    this.watch(cx, `${STATE}/terminals`);
    this.watch(cx, `${STATE}/sessions`);
    // Watches can be reclaimed; this keeps the panel honest without a tight loop.
    cx.timer.every(15_000, (cx) => this.loadBridge(cx));
    // `herdr-app do herdr-reclaim.dispatch` (or a keys.json binding) does what the button does.
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "dispatch") this.dispatch(cx);
    });
  }

  space() {
    const id = props()?.space;
    return spaces().find((s) => (id ? s.id === id : s.active)) ?? null;
  }

  // The city's checkout is recorded when the town tab opens (props.folder). SpaceInfo.folder is
  // only where the space's next terminal would start, which follows whatever pane had focus.
  checkout() {
    return props()?.folder ?? this.space()?.folder ?? null;
  }

  watch(cx, dir) {
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", dir]);
      for (;;) {
        const started = Date.now();
        const changed = await watchFolder(dir).catch(() => null);
        if (!changed || (changed.length === 0 && Date.now() - started < 500)) break;
        this.loadBridge(cx);
      }
    });
  }

  loadCity(cx) {
    const folder = this.checkout();
    if (!folder) return;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder }).catch(() => null);
      this.cityId = r && r.code === 0 ? r.stdout.trim() : "（不是 git repo：沒有城）";
      cx.notify();
    });
  }

  loadOrders(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(ORDERS_FILE);
      this.orders = text ? JSON.parse(text) : [];
      cx.notify();
    });
  }

  // Every change to the orders file goes through here: one at a time within this copy, and
  // compare-and-swap against the file so another copy's write is re-read, never overwritten.
  // `apply` gets the current orders and returns the next list, or null for "nothing to do".
  mutateOrders(apply) {
    const attempt = async () => {
      await exec("mkdir", ["-p", `${appHome()}/data/herdr-reclaim`]);
      for (let tries = 0; ; tries++) {
        const text = await readTextFile(ORDERS_FILE);
        const current = text ? JSON.parse(text) : [];
        const next = apply(current);
        if (!next) {
          this.orders = current; // another copy may have written; show what is on disk
          return;
        }
        try {
          await writeTextFile(ORDERS_FILE, JSON.stringify(next, null, 2), text);
          this.orders = next;
          return;
        } catch (err) {
          if (tries >= 4) throw err;
        }
      }
    };
    this.writes = (this.writes ?? Promise.resolve()).then(attempt, attempt);
    return this.writes;
  }

  loadBridge(cx) {
    cx.spawn(async (cx) => {
      const read = async (sub) => {
        const ls = await exec("ls", [`${STATE}/${sub}`]).catch(() => null);
        const names = ls && ls.code === 0 ? ls.stdout.split("\n").filter((n) => n.endsWith(".json")) : [];
        const out = [];
        for (const name of names) {
          const text = await readTextFile(`${STATE}/${sub}/${name}`).catch(() => null);
          try {
            if (text) out.push(JSON.parse(text));
          } catch {
            // A file mid-rename; the next change reloads it.
          }
        }
        return out;
      };
      this.terminalsByAddr = Object.fromEntries((await read("terminals")).map((t) => [t.terminal, t]));
      this.sessions = Object.fromEntries((await read("sessions")).map((s) => [s.sessionId, s]));
      await this.bindPending();
      cx.notify();
    });
  }

  // An order binds to the first root session the extension reports for it, and stays bound:
  // a later /resume in the same terminal reports another session id and is not this order's.
  async bindPending() {
    const mappings = Object.values(this.terminalsByAddr);
    await this.mutateOrders((orders) => {
      let changed = false;
      const next = orders.map((o) => {
        if (o.state !== "pending") return o;
        const t = mappings.find((m) => m.order === o.id && m.updatedAt >= o.createdAt);
        if (t) {
          changed = true;
          return { ...o, state: "bound", terminal: t.terminal, sessionId: t.sessionId, boundAt: Date.now() };
        }
        if (Date.now() - o.createdAt > BIND_TIMEOUT_MS) {
          changed = true;
          return { ...o, state: "failed", failure: "逾時：extension 沒有回報這張工單的 session" };
        }
        return o;
      });
      return changed ? next : null;
    }).catch((err) => (this.error = String(err)));
  }

  dispatch(cx) {
    const space = this.space();
    if (!space) return;
    const id = `o${Date.now().toString(36)}`;
    const folder = this.checkout();
    const order = { id, state: "pending", space: space.id, folder, tabName: `開墾-${id}`, createdAt: Date.now() };
    cx.spawn(async (cx) => {
      try {
        await this.mutateOrders((orders) => [...orders, order]);
        run("tab.new", {
          space: space.id,
          folder,
          name: order.tabName,
          argv: ["env", `HERDR_RECLAIM_ORDER=${id}`, "omp"],
          focus: false,
        });
      } catch (err) {
        this.error = String(err);
      }
      cx.notify();
    });
  }

  // Everything the bound session and its subagents spent, from the extension's summaries.
  usageFor(sessionId) {
    const root = this.sessions[sessionId];
    if (!root) return null;
    const family = Object.values(this.sessions).filter((s) => s.sessionId === sessionId || s.rootSessionId === sessionId);
    const total = { cost: 0, unknown: 0, sessions: family.length, providers: {} };
    for (const s of family) {
      for (const [provider, p] of Object.entries(s.byProvider ?? {})) {
        total.cost += p.cost;
        total.unknown += p.unknownCostEntries;
        total.providers[provider] = (total.providers[provider] ?? 0) + p.input + p.output;
      }
    }
    return total;
  }

  render(cx) {
    const t = theme();
    const space = this.space();
    const live = Object.fromEntries(agents().map((a) => [a.address, a]));
    const row = (label, value) =>
      h_flex().gap(8).child(div().w(120).text_color(t.dim).child(label)).child(div().flex_1().truncate().child(String(value ?? "—")));
    const orderCard = (o) => {
      const tab = space?.tabs.find((tb) => tb.name === o.tabName);
      const viaPane = tab ? panes().find((p) => p.tab === tab.id && p.terminal)?.terminal : null;
      const mapping = o.terminal ? this.terminalsByAddr[o.terminal] : null;
      const usage = o.sessionId ? this.usageFor(o.sessionId) : null;
      return v_flex().id(`order-${o.id}`).gap(2).p(8).border(1).border_color(t.border).children([
        row("工單", `${o.id}  ${o.state}${o.failure ? `（${o.failure}）` : ""}`),
        row("checkout", o.folder),
        row("tab", tab ? `${tab.name}（${tab.id}）` : "找不到同名 tab"),
        row("terminal", `${o.terminal ?? "—"}  pane 對照：${viaPane ?? "—"}${o.terminal && viaPane && o.terminal !== viaPane ? "  ⚠ 不一致" : ""}`),
        row("綁定 session", o.sessionId),
        row("terminal 現在", mapping ? `${mapping.sessionId}  gen ${mapping.generation}  ${mapping.reason}${mapping.sessionId !== o.sessionId ? "  ⚠ 已切換，不計入本工單" : ""}` : "—"),
        row("agent 狀態", o.terminal ? (live[o.terminal]?.status ?? "（不在 agents()）") : "—"),
        row("API 等值", usage ? `$${usage.cost.toFixed(4)}  未知價格筆數 ${usage.unknown}  session 數 ${usage.sessions}` : "—"),
        row("派系投資", usage ? Object.entries(usage.providers).map(([p, n]) => `${p}:${n}`).join("  ") : "—"),
      ]);
    };
    return v_flex().id("root").size_full().bg(t.surface).p(12).gap(8).text_size(13).text_color(t.foreground).overflow_y_scrollbar().children([
      div().font_semibold().text_size(15).child("開墾城鎮 · S1/S2 spike"),
      row("space", space ? `${space.name}（${space.id}）` : "—"),
      row("checkout", this.checkout()),
      row("城 (common dir)", this.cityId),
      row("bridge", `${Object.keys(this.terminalsByAddr).length} terminals · ${Object.keys(this.sessions).length} sessions`),
      div()
        .id("dispatch")
        .px(10).py(4).border(1).border_color(t.accent).text_color(t.accent)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.dispatch(cx))
        .child("派工（開一個 omp tab）"),
      this.error ? div().text_color(t.blocked).child(this.error) : null,
      ...[...this.orders].reverse().map(orderCard),
    ].filter(Boolean));
  }
}
