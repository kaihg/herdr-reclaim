// 城鎮讀取模型的固定情境測試（ticket #2）。
// 只斷言可觀察的城鎮狀態：城市、格子座標、遠征、右側詳情；不碰內部函式或檔案排列。
import { describe, expect, test } from "bun:test";
import { projectTile } from "../core/grid.js";
import { readTown, selectionDetail } from "../core/town.js";
import {
  AT,
  CHILD_SESSION_ID,
  CITY,
  FORK_SESSION_ID,
  HEADLESS_SESSION_ID,
  PRINT_SESSION_ID,
  ROOT_SESSION_ID,
  activity,
  firstExpedition,
  heartbeat,
  intervalClose,
  intervalOpen,
  visitStart,
} from "../scenarios/first-expedition.js";

/** 一支 session：在某個 checkout 開一段工作區間。 */
function session({
  sessionId,
  role = "root",
  interactive = true,
  parentSessionId = null,
  repo = CITY,
  openMs = 0,
  closeMs = null,
  heartbeatMs = null,
  writerEpoch,
}) {
  const events = [visitStart(`v-${sessionId}-${openMs}`, AT + openMs, repo), intervalOpen(AT + openMs)];
  if (heartbeatMs !== null) events.push(heartbeat(AT + heartbeatMs));
  if (closeMs !== null) events.push(intervalClose(AT + closeMs));
  return activity({ sessionId, role, interactive, parentSessionId, writerEpoch, events });
}

const cityId = (n) => `01a1f900-0000-7000-8000-00000000000${n}`;
const tileIn = (city, x, y) => city.tiles.find((tile) => tile.x === x && tile.y === y);
const tileAt = (town, x, y) => tileIn(town.cities[0], x, y);
const repoFacts = { [CITY.commonDir]: { hadHead: true } };

describe("城鎮讀取模型", () => {
  test("互動 root 進入 Git 城後自動取得中心北側的土地", () => {
    const town = readTown({ repoFacts, activities: [session({ sessionId: ROOT_SESSION_ID })] });

    expect(town.cities.length).toBe(1);
    const city = town.cities[0];
    expect(city.name).toBe("herdr-reclaim");
    expect(city.center).toMatchObject({ x: 0, y: 0, kind: "oldtown" });
    expect(city.tiles.map((tile) => [tile.x, tile.y])).toEqual([[0, -1]]);
    expect(city.tiles[0].rootSessionId).toBe(ROOT_SESSION_ID);
    expect(city.tiles[0].status).toBe("active");
  });

  test("同一組固定事件重播兩次，只產生一座城、一支遠征，不多出格子", () => {
    const once = readTown(firstExpedition);
    expect(readTown(firstExpedition)).toEqual(once);

    // 同一個寫入者的紀錄被讀到兩次（兩份重疊的快照），格子與工作量都不變。
    const doubled = readTown({
      ...firstExpedition,
      activities: [...firstExpedition.activities, ...firstExpedition.activities],
    });
    expect(doubled).toEqual(once);

    // 紀錄在陣列裡的順序不同（例如先讀到新檔），結果仍然一樣。
    const reversed = readTown({ ...firstExpedition, activities: [...firstExpedition.activities].reverse() });
    expect(reversed).toEqual(once);
  });

  test("空城依序加入五個 root：從中心 2×2 相接的 8 格依北、東、南、西開始，中心四格不會被佔走", () => {
    const town = readTown({
      repoFacts: { [CITY.commonDir]: { hadHead: false } },
      activities: [1, 2, 3, 4, 5].map((n) => session({ sessionId: cityId(n) })),
    });

    const city = town.cities[0];
    expect(city.tiles.map((tile) => [tile.x, tile.y])).toEqual([
      [0, -1],
      [1, -1],
      [2, 0],
      [2, 1],
      [1, 2],
    ]);
    // 新 repo 與舊 repo 的中心同名「城鎮中心」；kind 只記得開城時有沒有 HEAD。
    expect(city.center).toEqual({ x: 0, y: 0, kind: "founded", label: "城鎮中心" });
  });

  test("print、headless 與 task child 不建格；互動 fork 建立自己的格", () => {
    const town = readTown(firstExpedition);

    expect(town.cities.length).toBe(1);
    expect(town.cities[0].tiles.map((tile) => [tile.x, tile.y, tile.rootSessionId])).toEqual([
      [0, -1, ROOT_SESSION_ID],
      [1, -1, FORK_SESSION_ID],
    ]);
    const owners = town.cities[0].tiles.map((tile) => tile.rootSessionId);
    expect(owners).not.toContain(CHILD_SESSION_ID);
    expect(owners).not.toContain(PRINT_SESSION_ID);
    expect(owners).not.toContain(HEADLESS_SESSION_ID);
  });

  test("child 的區間併入 root、平行的區間不重複計算；開著的區間只算到最後一次 heartbeat", () => {
    const town = readTown(firstExpedition);
    const root = tileAt(town, 0, -1);
    expect(root.workMs).toBe(4_440_000); // 74 分鐘；child 那段落在裡面，不重複計算
    expect(root.points).toBe(74);
    expect(root.status).toBe("active");

    const fork = tileAt(town, 1, -1);
    expect(fork.workMs).toBe(600_000); // fork 自己的 10 分鐘
    expect(fork.points).toBe(10);
    expect(fork.status).toBe("idle");
  });

  test("child 的區間不重疊時，root 的工作時間跟著延長", () => {
    const town = readTown({
      repoFacts,
      activities: [
        session({ sessionId: "root-1", closeMs: 5_000_000 }),
        session({
          sessionId: "child-1",
          role: "child",
          interactive: false,
          parentSessionId: "root-1",
          openMs: 5_400_000,
          closeMs: 6_000_000,
        }),
      ],
    });

    expect(town.cities[0].tiles.length).toBe(1);
    expect(tileAt(town, 0, -1).points).toBe(93); // 83 分 + 不重疊的 10 分
  });

  test("同一個 repo 的不同 checkout 是同一座城、visit 分開；不同的城各是一座城", () => {
    const worktree = { commonDir: CITY.commonDir, checkout: "/tmp/herdr-reclaim-worktrees/impl-2" };
    const other = { commonDir: "/Users/kk/projects/api-kb/.git", checkout: "/Users/kk/projects/api-kb" };
    const town = readTown({
      activities: [
        session({ sessionId: "root-1", repo: CITY, closeMs: 600_000, heartbeatMs: 600_000 }),
        session({ sessionId: "root-1", repo: worktree, openMs: 600_000, closeMs: 1_200_000, writerEpoch: "pid-2" }),
        session({ sessionId: "root-2", repo: other }),
      ],
    });

    expect(town.cities.map((city) => [city.cityId, city.name])).toEqual([
      [CITY.commonDir, "herdr-reclaim"],
      [other.commonDir, "api-kb"],
    ]);
    const first = town.cities[0];
    expect(first.tiles.length).toBe(1);
    expect(first.tiles[0].visits.map((visit) => visit.checkout)).toEqual([CITY.checkout, worktree.checkout]);
    expect(first.tiles[0].points).toBe(20); // 兩段工作時間聯集
    expect(town.cities[1].tiles.map((tile) => [tile.x, tile.y, tile.rootSessionId])).toEqual([[0, -1, "root-2"]]);
  });
});

describe("C 版遠征指揮桌要用的資料", () => {
  test("讀取模型帶著四個區塊要的資料：城名、庫存、行會、遠征與中央格", () => {
    const city = readTown(firstExpedition).cities[0];

    expect(city.name).toBe("herdr-reclaim");
    expect(city.resources).toEqual({ wood: 0, stone: 0, iron: 0, parchment: 0 }); // 收成（#3）之前是空的
    expect(city.guild).toBe(null); // 沒有額度來源時畫面顯示未知（§9）
    expect(city.center).toEqual({ x: 0, y: 0, kind: "oldtown", label: "城鎮中心" });
    expect(city.tiles.length).toBe(2);
  });

  test("選取遠征或它的地圖格，右側詳情相同", () => {
    const town = readTown(firstExpedition);
    const byExpedition = selectionDetail(town, {
      kind: "expedition",
      cityId: CITY.commonDir,
      rootSessionId: ROOT_SESSION_ID,
    });
    const byTile = selectionDetail(town, { kind: "tile", cityId: CITY.commonDir, x: 0, y: -1 });

    expect(byTile).toEqual(byExpedition);
    expect(byExpedition.kind).toBe("expedition");
    expect(byExpedition.cityName).toBe("herdr-reclaim");
    expect(byExpedition.statusLabel).toBe("探索中");
    expect(byExpedition.points).toBe(74);
    expect(byExpedition.pointsTarget).toBe(100);
    expect(byExpedition.fields).toContainEqual({ label: "工作時間", value: "1 小時 14 分" });

    const fork = selectionDetail(town, { kind: "tile", cityId: CITY.commonDir, x: 1, y: -1 });
    expect(fork.title).toBe(`遠征 ${FORK_SESSION_ID.slice(0, 8)} · 第 1 代`);
    expect(fork.statusLabel).toBe("駐紮");
  });

  test("選取中心 2×2 的任一格都顯示城鎮中心；旁邊一格是已揭開的空地；更遠是迷霧", () => {
    const town = readTown(firstExpedition);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const center = selectionDetail(town, { kind: "tile", cityId: CITY.commonDir, x, y });
      expect(center.kind).toBe("center");
      expect(center.title).toBe("herdr-reclaim · 城鎮中心");
      expect(center.fields).toContainEqual({ label: "遠征", value: "2 支" });
    }
    // 中心塊上下左右相接的 8 格：沒有遠征的 6 格看得到地面（北側兩格被這兩支遠征佔了）。
    for (const [x, y] of [[2, 0], [2, 1], [1, 2], [0, 2], [-1, 1], [-1, 0]]) {
      expect(selectionDetail(town, { kind: "tile", cityId: CITY.commonDir, x, y })).toMatchObject({
        kind: "open",
        title: "空地",
        fields: [],
      });
    }
    // 斜角不算相鄰；更遠的格子還在迷霧裡。
    for (const [x, y] of [[-1, -1], [2, 2], [3, 3]]) {
      expect(selectionDetail(town, { kind: "tile", cityId: CITY.commonDir, x, y })).toMatchObject({
        kind: "fog",
        title: "迷霧",
        fields: [],
      });
    }
  });

  test("工程資訊的欄位帶 dev 旗標，玩家看得懂的欄位沒有", () => {
    const town = readTown(firstExpedition);
    const byExpedition = selectionDetail(town, { kind: "expedition", cityId: CITY.commonDir, rootSessionId: ROOT_SESSION_ID });
    const plain = byExpedition.fields.filter((field) => !field.dev).map((field) => field.label);
    const dev = byExpedition.fields.filter((field) => field.dev).map((field) => field.label);
    expect(plain).toEqual(expect.arrayContaining(["工作時間", "派系", "土地"]));
    expect(dev).toEqual(expect.arrayContaining(["座標", "CLI", "session", "checkout", "點數"]));
    expect(plain).not.toContain("session");
  });

  test("3/4 投影與邏輯座標分開：中心在原點，北邊在北、東邊在東", () => {
    const town = readTown(firstExpedition);
    const center = town.cities[0].center;
    const north = projectTile({ x: 0, y: -1 });
    const east = projectTile({ x: 1, y: 0 });
    const south = projectTile({ x: 0, y: 1 });
    const west = projectTile({ x: -1, y: 0 });

    expect(projectTile(center)).toEqual({ left: 0, top: 0 });
    // 斜俯視 3/4：北方在上、東方在右下、南方在左下、西方在左上。
    expect(north.top).toBeLessThan(0);
    expect(east.top).toBeGreaterThan(0);
    expect(east.left).toBeGreaterThan(0);
    expect(west.left).toBeLessThan(0);
    expect(west.top).toBeLessThan(0);
    // 相反的兩邊互為鏡射。
    expect(south).toEqual({ left: -north.left, top: -north.top });
    expect(west).toEqual({ left: -east.left, top: -east.top });
    // 投影只決定位置：空城第一支遠征（BFS 選到的北側格）畫在中心上方。
    expect(projectTile(tileAt(town, 0, -1)).top).toBeLessThan(projectTile(center).top);
  });
});
