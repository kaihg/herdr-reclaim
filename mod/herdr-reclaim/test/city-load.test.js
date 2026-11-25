// 正式整合路徑（#22 缺陷 3）：固定的 adapter 活動檔 → `loadCity`（main.js 用的那一條）→
// 公開的共用城市讀取模型。不是直接呼叫 `ingestIncome`：這裡走的是列目錄、讀活動檔、
// 合併帳本保存的那一份、入帳、推進施工的完整流程。
//
// 要證明的是：多個 repo、多個 session、`/new` 與 resume 只讓共用庫存增加，不產生任何
// 遠征格，也不建立或改動 `cities/` 下的舊帳本；重新載入與重送同一份紀錄不雙算。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCity, repositoriesOf, townOf } from "../core/city-load.js";
import { WORK_TOKENS_PER_UNIT, WORK_YIELD } from "../core/rules.js";
import { revealedCells } from "../core/city-map.js";
import { createFileIo } from "./fs-io.js";

const AT = 1_800_000_000_000;
const REPO_A = "/tmp/reclaim-load-a/.git";
const REPO_B = "/tmp/reclaim-load-b/.git";
const CHECKOUT_A = "/tmp/reclaim-load-a";
const CHECKOUT_B = "/tmp/reclaim-load-b";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-city-load-"));

/** adapter 的活動檔：一支 session 一個 writer epoch 一個檔。 */
const record = (sessionId, writerEpoch, { cli = "omp", role = "root", parentSessionId, repo = REPO_A, checkout = CHECKOUT_A, rounds = 1, from = AT, name } = {}) => {
  const events = [];
  for (let i = 0; i < rounds; i++) {
    const at = from + i * 100_000;
    events.push(
      { kind: "visit_start", at, visit: { visitId: `${sessionId}-${i}`, cwd: checkout, commonDir: repo, checkout } },
      { kind: "interval_open", at },
      { kind: "usage", at: at + 1_000, sourceEntryId: `${sessionId}-${i}`, usage: { openai: { sourceKey: `omp#${sessionId}#${i}`, inputNonCache: 7_000, cacheRead: 0, cacheWrite: 0, output: 3_000, costKnown: 0, costUnknownEntries: 0 } } },
      { kind: "interval_close", at: at + 1_500 },
    );
  }
  return {
    schema: 1, cli, cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
    sessionId, role, interactive: true, parentSessionId, writerEpoch,
    ...(name ? { sessionName: name } : {}),
    events: events.map((event, index) => ({ eventSeq: index + 1, ...event })),
    updatedAt: from + rounds * 100_000,
  };
};

/** 把活動檔寫進 adapter 的目錄（`<root>/activity/<session>/<epoch>.json`）。 */
function writeActivity(base, data) {
  const dir = `${base}/activity/${data.sessionId}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${data.writerEpoch}.json`, JSON.stringify(data));
}

/** herdr 的 mod 沒有 listdir，正式路徑由 host 注入：這裡用 fs 遞迴列檔（活動檔在子目錄）。 */
const list = async (dir) => {
  const found = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".json")) found.push(file);
    }
  };
  walk(dir);
  return found;
};

/**
 * 正式載入，並且經過 main.js 實際使用的 `townOf`：測試讀的就是畫面讀的那個形狀
 * （`town.shared.city`）。`activateAt` 固定在活動之前：正式 runtime 由第一次啟用的當下決定
 * （之前的歷史不補發），這裡要驗的是「活動進得來」，不是啟用邊界（那一條在 shared-city.test.js）。
 */
const load = async (base) => {
  const loaded = await loadCity(createFileIo(), { root: base, list, now: AT + 1_000_000, activateAt: AT - 1_000 });
  const town = townOf(loaded, null);
  expect(town.city).toBeUndefined(); // 畫面不讀 `town.city`；讀到 undefined 才不會被誤用
  return { ...town, city: town.shared.city };
};
const stock = (city) => [city.resources.wood, city.resources.stone, city.resources.iron];
const times = (n) => [WORK_YIELD.wood * n, WORK_YIELD.stone * n, WORK_YIELD.iron * n];

describe("正式載入路徑：活動檔 → 共用城市", () => {
  test("多個 repo、多個 session、/new 與 resume 只增加共用庫存：沒有遠征格，也不建立 `cities/`", async () => {
    const base = root();
    try {
      // repo A：一支長對話（兩個回合）。
      writeActivity(base, record("a-root", "a-root-1", { repo: REPO_A, checkout: CHECKOUT_A, rounds: 2, name: "長對話" }));
      // 同一個 repo 的 `/new`：另一支 root，一個回合。
      writeActivity(base, record("a-new", "a-new-1", { repo: REPO_A, checkout: CHECKOUT_A, from: AT + 10_000 }));
      // resume：同一支 session 的另一個 writer epoch（adapter 恢復後換 epoch），一個回合。
      writeActivity(base, record("a-root", "a-root-2", { repo: REPO_A, checkout: CHECKOUT_A, from: AT + 20_000 }));
      // 另一個 repo 的工作：同一個共用城市。
      writeActivity(base, record("b-root", "b-root-1", { repo: REPO_B, checkout: CHECKOUT_B, rounds: 2, from: AT + 30_000 }));
      // child session 併進 parent：回合算在同一棵樹，庫存照收。
      writeActivity(base, record("b-child", "b-child-1", { repo: REPO_B, checkout: CHECKOUT_B, role: "child", parentSessionId: "b-root", from: AT + 40_000 }));

      // 磁碟上先放一份舊版各 repo 的帳本：程式不讀、不寫、也不刪。
      const legacy = `${base}/cities/legacy/head.json`;
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, "{\"schemaVersion\":2}\n");

      const first = await load(base);
      // 六個回合，每回合一份基本收入。
      expect(stock(first.city)).toEqual(times(6));
      expect(first.city.work.tokens).toBe((6 * (7_000 + 3_000)) % WORK_TOKENS_PER_UNIT);
      // 沒有遠征格、沒有預定地、沒有建築：只有共用城市的起始土地。
      expect(first.city.plan).toBeNull();
      expect(first.city.buildings).toEqual([]);
      expect(first.city.tiles).toBeUndefined();
      expect(revealedCells(first.city).size).toBe(63); // 起始 8×8 扣掉東北角的迷霧
      // 活動碰到的 repo 都在（同意流程要對每一個 repo 問一次）。
      expect(first.repositories.map((repo) => repo.checkout).sort()).toEqual([CHECKOUT_A, CHECKOUT_B]);

      // `cities/` 只有原本那一份，內容逐位元不變；新資料只在 `shared/`。
      expect(fs.readFileSync(legacy, "utf8")).toBe("{\"schemaVersion\":2}\n");
      expect(fs.readdirSync(`${base}/cities`)).toEqual(["legacy"]);
      expect(fs.readdirSync(`${base}/shared`).length).toBeGreaterThan(0);
      expect(fs.readdirSync(base).sort()).toEqual(["activity", "cities", "shared"]);

      // 重新載入（同一個視窗重開）：不會重算、也不會憑空多出東西。
      const second = await load(base);
      expect(second.city).toEqual(first.city);

      // 重送同一份紀錄（watch 觸發、另一個 space 同時讀到同一批檔案）：還是不重算。
      const third = await load(base);
      expect(third.city).toEqual(first.city);
      expect(stock(third.city)).toEqual(times(6));

      // 活動檔在 ack 後被 compact 成更短的尾巴（只剩最後一個回合）：帳本保存的那一份補回來，
      // 庫存不會掉，也不會因為尾巴被重讀再發一次。
      writeActivity(base, record("a-root", "a-root-1", { repo: REPO_A, checkout: CHECKOUT_A, rounds: 1, from: AT + 100_000 }));
      const compacted = await load(base);
      expect(compacted.city).toEqual(first.city);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("只做研究、沒有 commit 與交易也能備齊材料並蓋完：正式路徑會自動開工與完工", async () => {
    const base = root();
    try {
      const { placePlan, advanceConstruction } = await import("../core/shared-city.js");
      const { CityLedger } = await import("../core/ledger.js");
      const { SHARED_CITY_ID, sharedCityDir } = await import("../core/shared-city.js");
      const openShared = () => new CityLedger({ io: createFileIo(), dir: sharedCityDir(base), cityId: SHARED_CITY_ID }).open();
      // 十個回合＝木 30、石 20、鐵 10：民居（木 20、石 10）的配方備得齊。
      writeActivity(base, record("solo", "solo-1", { rounds: 10 }));
      const first = await load(base);
      expect(stock(first.city)).toEqual(times(10));

      const ledger = await openShared();
      expect((await placePlan(ledger, { building: "house", x: 4, y: 0, at: AT + 900_000 })).status).toBe("applied");
      const building = await load(base);
      expect(building.city.plan).toMatchObject({ building: "house", stage: "building" });

      await advanceConstruction(await openShared(), { now: building.city.plan.completesAt });
      const done = await load(base);
      expect(done.city.plan).toBeNull();
      expect(done.city.buildings.map((entry) => [entry.building, entry.x, entry.y])).toEqual([["house", 4, 0]]);
      // 完工揭開新土地：正式路徑重讀之後，那一格是看得到的。
      expect(revealedCells(done.city).has("5,0")).toBe(true);
      // 只做研究、沒有 commit：庫存只扣一次配方，沒有成果加成。
      expect(stock(done.city)).toEqual([10, 10, 10]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("repositoriesOf：同一份 repo 只列一次，最近用過的在前面", () => {
    const repos = repositoriesOf([
      { events: [{ at: 10, visit: { checkout: "/a", commonDir: "/a/.git" } }] },
      { events: [{ at: 30, visit: { checkout: "/b", commonDir: "/b/.git" } }] },
      { events: [{ at: 20, visit: { checkout: "/a", commonDir: "/a/.git" } }, { at: 5, visit: { cwd: "/x" } }] },
    ]);
    expect(repos).toEqual([
      { checkout: "/b", at: 30 },
      { checkout: "/a", at: 20 },
    ]);
  });
});
