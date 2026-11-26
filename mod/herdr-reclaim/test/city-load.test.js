// 正式整合路徑（#22 缺陷 3）：固定的 adapter 活動檔 → `loadCity`（main.js 用的那一條）→
// 公開的共用城市讀取模型。不是直接呼叫 `ingestIncome`：這裡走的是列目錄、讀活動檔、
// 合併帳本保存的那一份、入帳、推進施工的完整流程。
//
// 要證明的是：多個 repo、多個 session、`/new` 與 resume 只讓共用庫存增加，不產生任何
// 遠征格，也不建立或改動 `cities/` 下的舊帳本；重新載入與重送同一份紀錄不雙算。
import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { handleHook } from "../../../claude-hooks/herdr-reclaim-hook.ts";
import { CityLedger } from "../core/ledger.js";
import { adapterRoot } from "../core/adapter.js";
import { SHARED_CITY_ID, placePlan, sharedCityDir } from "../core/shared-city.js";
import { loadCity, townOf } from "../core/city-load.js";
import { START_RESOURCES, WORK_TOKENS_PER_UNIT, WORK_YIELD } from "../core/rules.js";
import { groundAt, revealedCells } from "../core/city-map.js";
import { createFileIo } from "./fs-io.js";

const AT = 1_800_000_000_000;
const REPO_A = "/tmp/reclaim-load-a/.git";
const REPO_B = "/tmp/reclaim-load-b/.git";
const CHECKOUT_A = "/tmp/reclaim-load-a";
const CHECKOUT_B = "/tmp/reclaim-load-b";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-city-load-"));

/** adapter 的活動檔：一支 session 一個 writer epoch 一個檔。 */
const record = (sessionId, writerEpoch, { cli = "omp", role = "root", parentSessionId, repo = REPO_A, checkout = CHECKOUT_A, rounds = 1, units = 1, from = AT, name } = {}) => {
  const events = [];
  for (let i = 0; i < rounds; i++) {
    const at = from + i * 100_000;
    events.push(
      { kind: "visit_start", at, visit: { visitId: `${sessionId}-${i}`, cwd: checkout, commonDir: repo, checkout } },
      { kind: "interval_open", at },
      { kind: "usage", at: at + 1_000, sourceEntryId: `${sessionId}-${i}`, usage: { openai: { sourceKey: `omp#${sessionId}#${i}`, inputNonCache: 7_000 * units, cacheRead: 0, cacheWrite: 0, output: 3_000 * units, costKnown: 0, costUnknownEntries: 0 } } },
      { kind: "interval_close", at: at + 1_500 },
    );
  }
  return {
    schema: 1, cli, cliVersion: "test",
    capabilities: { usage: true, parent: true, heartbeat: true },
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
  const loaded = await loadCity(createFileIo(), { root: base, list, activateAt: AT - 1_000 });
  const town = townOf(loaded, null);
  expect(town.city).toBeUndefined(); // 畫面不讀 `town.city`；讀到 undefined 才不會被誤用
  return { ...town, city: town.shared.city };
};
const stock = (city) => [city.resources.wood, city.resources.stone, city.resources.iron];
const times = (n) => ["wood", "stone", "iron"].map((key, i) => START_RESOURCES[key] + WORK_YIELD[key] * n - [20, 10, 6][i]);

const openCity = (base) => new CityLedger({ io: createFileIo(), dir: sharedCityDir(base), cityId: SHARED_CITY_ID }).open();

test("分批同城", async () => {
  async function play(every, rounds = 8, units = 13) {
    const base = root();
    try {
      for (let i = 1; i <= rounds; i++) {
        writeActivity(base, record("work", "e1", { rounds: i, units }));
        if (i % every === 0) await load(base);
      }
      const { city } = await load(base);
      expect(city.buildings[0]).toMatchObject({ auto: true, building: "house", startedUnit: 1, completedUnit: 15 });
      expect(city.buildings[1]).toMatchObject({ auto: true, building: "quarry", startedUnit: 15, completedUnit: 33 });
      await (await openCity(base)).checkpoint();
      expect((await load(base)).city).toEqual(city);
      return city;
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
  const daily = await play(8);
  expect(await play(1)).toEqual(daily);
  expect(await play(3)).toEqual(daily);
  expect(await play(1, 1, 104)).toEqual(daily);
});

test("雙窗與中斷", async () => {
  for (const committed of [false, true]) {
    const base = root();
    try {
      await load(base);
      writeActivity(base, record("work", "e1", { units: 15 }));
      const disk = createFileIo();
      const io = { ...disk, async write(file, text, expected) {
        if (file.includes("/journal/") && text.slice(expected?.length ?? 0).includes('\"kind\":\"autoComplete\"')) {
          if (committed) await disk.write(file, text, expected);
          throw new Error("施工中斷");
        }
        await disk.write(file, text, expected);
      } };
      await expect(loadCity(io, { root: base, list })).rejects.toThrow("施工中斷");
      fs.rmSync(`${base}/activity`, { recursive: true });
      const [a, b] = await Promise.all([load(base), load(base)]);
      expect(a.city).toEqual(b.city);
      expect(a.city.buildings.map(i => [i.building, i.completedUnit])).toEqual([["house", 15]]);
      expect(a.city.queue[0]).toMatchObject({ auto: true, startedUnit: 15 });
      const events = (await (await openCity(base)).scanSegments()).flatMap(s => s.entries).filter(e => e.kind.startsWith("auto"));
      expect(events.map(e => [e.kind, e.unit])).toEqual([["autoStart", 1], ["autoComplete", 15], ["autoStart", 15]]);
      expect(new Set(events.map(e => e.opId)).size).toBe(3);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("逐格沿線與停工", async () => {
  const base = root();
  try {
    writeActivity(base, record("full", "e1", { units: 3000 }));
    const { city } = await load(base);
    expect(city.roadsideFull).toBe(true);
    expect(city.queue).toEqual([]);
    const roads = [[0, -2], [2, 0], [0, 2], [-2, 0]];
    const distances = city.buildings.map(b => b.cells.map(c => Math.min(...roads.map(([x, y]) => Math.max(Math.abs(c.x - x), Math.abs(c.y - y))))));
    expect(distances.every(ds => ds.every(d => d <= 3))).toBe(true);
    expect(distances.some(ds => ds.length >= 2 && Math.min(...ds) >= 2 && Math.max(...ds) === 3)).toBe(true);
    writeActivity(base, record("again", "e2", { units: 100, from: AT + 200_000 }));
    const later = (await load(base)).city;
    expect(later.buildings).toEqual(city.buildings);
    expect(later.resources.wood).toBeGreaterThan(city.resources.wood);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("手動優先與保料", async () => {
  for (const wood of [77, 80]) {
    const base = root();
    try {
      const ledger = await openCity(base);
      // 舊版已完工的民居不需鐵；用真實舊格式建立有人力但缺鐵的新施工線。
      const plan = "house:3,1:0";
      const history = [
        { kind: "workStart", terrainVersion: 1, roadArmLength: 1, resources: { wood: wood + 20, stone: 100, iron: 0 } },
        { kind: "plan", building: "house", x: 3, y: 1, w: 1, h: 1, costs: { wood: 20, stone: 10 } },
        { kind: "construct", plan, buildMs: 1 }, { kind: "complete", plan, reveal: 2 },
      ];
      fs.writeFileSync(ledger.segmentPath(0), history.map((op, i) => JSON.stringify({ ...op, cityId: ledger.cityId,
        rulesVersion: 11, at: 0, journalSeq: i, opId: `legacy-${i}` }) + "\n").join(""));
      expect((await placePlan(ledger, { building: "library", x: -2, y: 2, at: AT })).status).toBe("applied");
      writeActivity(base, record("work", "e1"));
      const first = (await load(base)).city;
      if (wood === 77) {
        expect(first.queue.map(i => i.stage)).toEqual(["queued"]);
        expect(first.resources.wood).toBe(78); // 已夠工坊 60，但不能動用書庫的 20。
        expect(first.roadsideFull).toBe(false);
      } else {
        expect(first.queue.map(i => [i.building, i.stage])).toEqual([["workshop", "building"], ["library", "queued"]]);
        expect(first.resources.wood).toBe(21);
        const player = await openCity(base);
        expect((await placePlan(player, { building: "market", x: 2, y: 2, at: AT + 1 })).status).toBe("applied");
        expect((await load(base)).city.queue.map(i => [i.building, i.stage])).toEqual([
          ["workshop", "building"], ["library", "queued"], ["market", "queued"],
        ]);
        writeActivity(base, record("more", "e2", { units: 10, from: AT + 100_000 }));
        const waiting = (await load(base)).city;
        expect(waiting.queue[1]).toMatchObject({ stage: "queued", missing: {} });
        writeActivity(base, record("finish", "e3", { units: 11, from: AT + 200_000 }));
        const next = (await load(base)).city;
        expect(next.buildings.at(-1)).toMatchObject({ building: "workshop", completedUnit: 22 });
        expect(next.queue[0]).toMatchObject({ building: "library", startedUnit: 22 });
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("整筆與拆份重播相同", async () => {
  async function play(rounds, units) {
    const base = root();
    try {
      await load(base);
      const ledger = await openCity(base);
      for (const [building, x, y] of [["house", 3, 1], ["market", 2, 2], ["library", -2, 2]]) {
        expect((await placePlan(ledger, { building, x, y, at: AT })).status).toBe("applied");
      }
      writeActivity(base, record("work", "e1", { rounds, units }));
      const { city } = await load(base);
      expect((await load(base)).city).toEqual(city);
      return city;
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
  const batch = await play(1, 28);
  expect(await play(28, 1)).toEqual(batch);
  expect(stock(batch)).toEqual([45, 12, 22]);
  expect(batch.buildings.map((b) => [b.building, b.completedUnit])).toEqual([["house", 14], ["market", 26]]);
  expect(batch.queue).toHaveLength(1);
  expect(batch.queue[0]).toMatchObject({ building: "library", remainingUnits: 12 });
  expect(revealedCells(batch).has("5,1")).toBe(true);
});

test("寫入前後中斷可重開", async () => {
  for (const committed of [false, true]) {
    const base = root();
    try {
      await load(base);
      const ledger = await openCity(base);
      await placePlan(ledger, { building: "house", x: 3, y: 1, at: AT });
      await placePlan(ledger, { building: "outpost", x: 2, y: 3, at: AT });
      writeActivity(base, record("work", "e1", { units: 16 }));
      const disk = createFileIo();
      const io = { ...disk, async write(file, text, expected) {
        if (file.includes("/journal/") && text.slice(expected?.length ?? 0).includes('"kind":"income"')) {
          if (committed) await disk.write(file, text, expected);
          throw new Error("模擬中斷");
        }
        await disk.write(file, text, expected);
      } };
      await expect(loadCity(io, { root: base, list })).rejects.toThrow("模擬中斷");
      // 活動可能已 ack 並 compact；只能依 journal 裡留存的工作恢復。
      fs.rmSync(`${base}/activity`, { recursive: true });
      const { city } = await load(base);
      expect(city.buildings.map((b) => b.building)).toEqual(["house"]);
      expect(city.queue).toHaveLength(1);
      expect(city.queue[0]).toMatchObject({ building: "outpost", remainingUnits: 2 });
      expect(stock(city)).toEqual([56, 25, 10]);
      expect((await load(base)).city).toEqual(city);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test("舊帳本隔離", async () => {
  const base = root();
  try {
    const old = `${base}/shared/`;
    const files = { "head.json": Buffer.from([0, 255, 10]), "journal/0.json": Buffer.from("舊城\n"), "acks/s/e.json": Buffer.from('{"ackedEventSeq":99}\n') };
    for (const [name, bytes] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(old + name), { recursive: true });
      fs.writeFileSync(old + name, bytes);
    }
    const disk = createFileIo();
    const io = Object.fromEntries(Object.entries(disk).map(([name, fn]) => [name, (file, ...args) => {
      expect(file.startsWith(old)).toBe(false);
      return fn(file, ...args);
    }]));
    for (let i = 0; i < 2; i++) {
      const loaded = await loadCity(io, { root: base, list, activateAt: 0 });
      expect(loaded.city.city.resources).toEqual(START_RESOURCES);
    }
    expect((await list(old)).sort()).toEqual(Object.keys(files).map((name) => old + name).sort());
    for (const [name, bytes] of Object.entries(files)) expect(fs.readFileSync(old + name)).toEqual(bytes);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("開城參數與地形重播", async () => {
  const base = root();
  try {
    const first = (await load(base)).city;
    expect(first).toMatchObject({ terrainVersion: 2, roadArmLength: 1, resources: { wood: 70, stone: 35, iron: 6 } });
    expect(Number.isInteger(first.terrainSeed)).toBe(true);
    const terrain = (city) => [...revealedCells(city), "10,16", "-19,73", "107,-51"].map((key) => {
      const [x, y] = key.split(",").map(Number);
      return groundAt(city, { x, y });
    });
    const open = (dir) => new CityLedger({ io: createFileIo(), dir: sharedCityDir(dir), cityId: SHARED_CITY_ID }).open();
    const before = terrain(first);
    const replay = (await load(base)).city;
    expect(replay.terrainSeed).toBe(first.terrainSeed);
    expect(terrain(replay)).toEqual(before);
    await (await open(base)).checkpoint();
    const checkpoint = (await load(base)).city;
    expect(checkpoint.terrainSeed).toBe(first.terrainSeed);
    expect(terrain(checkpoint)).toEqual(before);

    // 另一座城創建時的設定與目前規則不同：不可拿現在的參數覆寫歷史。
    const other = `${base}/other`;
    const ledger = await open(other);
    await ledger.submit(() => ({ kind: "workStart", at: 0, cityId: ledger.cityId, opId: "found",
      terrainVersion: 1, roadArmLength: 3, resources: { wood: 8, stone: 5, iron: 2 } }));
    await ledger.checkpoint();
    const saved = (await load(other)).city;
    expect(saved.resources).toEqual({ wood: 8, stone: 5, iron: 2 });
    expect(saved.terrainVersion).toBe(1);
    expect(groundAt(saved, { x: -2, y: -3 })).toBe("water");
    expect(groundAt(saved, { x: 4, y: -2 })).toBe("cliff");
    expect(groundAt(saved, { x: 2, y: 0 })).toBe("road");
    expect(groundAt(saved, { x: 4, y: 0 })).toBe("road");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("三端確認與去重", async () => {
  const home = root();
  const base = adapterRoot(home);
  const previous = process.env.HERDR_APP_HOME;
  try {
    // OMP 是獨立安裝的單檔，匯入時即決定儲存位置。
    process.env.HERDR_APP_HOME = home;
    const { default: install } = await import("../../../omp-extension/herdr-reclaim.ts?city-load");
    const entries = [];
    const ctx = { hasUI: true, cwd: home, setInterval() {}, clearTimer() {},
      sessionManager: { getSessionId: () => "omp-root", getEntries: () => entries, getHeader: () => null } };
    const handlers = new Map();
    install({ on: (name, fn) => handlers.set(name, fn) });
    const omp = (name) => handlers.get(name)({}, ctx);
    omp("session_start");
    const payload = (session_id, file, name) => ({ session_id, cwd: home, transcript_path: `${home}/${file}`, hook_event_name: name });
    const claude = (name, now) => handleHook(payload("claude-root", "claude.jsonl", name), { appHome: home, pid: 1, entrypoint: "cli", now });
    const codex = (name, now) => execFileSync("sh", [path.resolve(import.meta.dir, "../../../codex-adapter/codex-activity.sh")], {
      input: JSON.stringify({ ...payload("codex-root", "codex.jsonl", name), turn_id: "turn" }),
      env: { ...process.env, HERDR_RECLAIM_EPOCH: "ce", HERDR_RECLAIM_NOW_MS: String(now) },
    });
    fs.writeFileSync(`${home}/claude.jsonl`, "");
    fs.writeFileSync(`${home}/codex.jsonl`, '{"type":"session_meta","payload":{"id":"codex-root","source":"cli"}}\n');
    claude("SessionStart", 1000);
    codex("SessionStart", 1000);
    const activityFiles = await list(`${base}/activity`);
    expect(activityFiles).toHaveLength(3);
    for (const file of activityFiles) {
      const oldAck = `${base}/shared/acks/${path.relative(`${base}/activity`, file)}`;
      fs.mkdirSync(path.dirname(oldAck), { recursive: true });
      fs.writeFileSync(oldAck, '{"ackedEventSeq":99999}');
    }
    omp("agent_start");
    entries.push({ type: "message", id: "one", message: { role: "assistant", provider: "openai",
      usage: { input: 9999, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    omp("agent_end");
    claude("UserPromptSubmit", 2000);
    fs.appendFileSync(`${home}/claude.jsonl`, JSON.stringify({ type: "assistant", timestamp: new Date(2500).toISOString(),
      message: { id: "two", role: "assistant", usage: { input_tokens: 9998, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n");
    claude("Stop", 3000);
    codex("UserPromptSubmit", 2000);
    fs.appendFileSync(`${home}/codex.jsonl`, '{"type":"token_usage_record","payload":{"response_id":"three","usage":{"input_tokens":9997,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":3}}}\n');
    codex("Stop", 3000);
    const reload = async () => (await loadCity(createFileIo(), { root: base, list, activateAt: 0 })).city.city;
    const first = await reload();
    expect(stock(first)).toEqual(times(3));
    expect(await reload()).toEqual(first);
    const last = activityFiles.map((file) => JSON.parse(fs.readFileSync(file)).events.at(-1).eventSeq);
    omp("agent_start");
    claude("UserPromptSubmit", 4000);
    codex("UserPromptSubmit", 4000);
    activityFiles.forEach((file, i) => {
      const tail = JSON.parse(fs.readFileSync(file)).events;
      expect(tail.length).toBeGreaterThan(0);
      expect(Math.min(...tail.map((event) => event.eventSeq))).toBeGreaterThan(last[i]);
    });
    expect(await reload()).toEqual(first);
  } finally {
    if (previous === undefined) delete process.env.HERDR_APP_HOME;
    else process.env.HERDR_APP_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

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
      // 第一份只付一次民居配方；完工之前仍只有起始揭開區。
      expect(first.city.queue.map(i => [i.building, i.startedUnit])).toEqual([["house", 1]]);
      expect(first.city.buildings).toEqual([]);
      expect(first.city.tiles).toBeUndefined();
      expect(revealedCells(first.city).size).toBe(81);

      // `cities/` 只有原本那一份，內容逐位元不變；新資料只在 `shared-v2/`。
      expect(fs.readFileSync(legacy, "utf8")).toBe("{\"schemaVersion\":2}\n");
      expect(fs.readdirSync(`${base}/cities`)).toEqual(["legacy"]);
      expect(fs.readdirSync(`${base}/shared-v2`).length).toBeGreaterThan(0);
      expect(fs.readdirSync(base).sort()).toEqual(["activity", "cities", "shared-v2"]);

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

  test("無進帳不完工", async () => {
    const base = root();
    try {
      await load(base);
      const ledger = await openCity(base);
      expect((await placePlan(ledger, { building: "house", x: 3, y: 1, at: AT })).status).toBe("applied");
      writeActivity(base, record("solo", "solo-1", { rounds: 10 }));
      const building = await load(base);
      expect(stock(building.city)).toEqual(times(10));
      expect(building.city.queue[0]).toMatchObject({ building: "house", stage: "building", remainingUnits: 4 });

      const clock = spyOn(Date, "now").mockReturnValue(AT + 365 * 86_400_000);
      try {
        expect((await load(base)).city).toEqual(building.city);
      } finally {
        clock.mockRestore();
      }
      writeActivity(base, record("more", "e1", { units: 4, from: AT + 1_000_000 }));
      const done = await load(base);
      expect(done.city.queue[0]).toMatchObject({ auto: true, startedUnit: 14 });
      expect(done.city.buildings.map((entry) => [entry.building, entry.x, entry.y])).toEqual([["house", 3, 1]]);
      // 完工揭開新土地：正式路徑重讀之後，那一格是看得到的。
      expect(revealedCells(done.city).has("5,0")).toBe(true);
      for (const [i, k] of ["wood", "stone", "iron"].entries()) {
        expect(done.city.resources[k] + (done.city.queue[0].costs[k] ?? 0)).toBe(times(14)[i]);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("磁碟上留著 commits/ 與 sources/ 也不再產生成果收成：庫存只有基本收入", async () => {
    const base = root();
    try {
      writeActivity(base, record("a-root", "a-root-1", { repo: REPO_A, checkout: CHECKOUT_A }));
      // 舊版留下來的證據檔（#28 不刪磁碟資料，只是不再讀）：就算完全可歸屬，也不再換成資源。
      const sha = "a".repeat(40);
      fs.mkdirSync(`${base}/commits`, { recursive: true });
      fs.writeFileSync(`${base}/commits/${sha}.post-commit.1.json`, JSON.stringify({
        schema: 1, sha, hook: "post-commit", commonDir: REPO_A, toplevel: CHECKOUT_A,
        at: AT + 2_000, env: { PI_SESSION_ID: "a-root" },
      }));
      fs.mkdirSync(`${base}/sources`, { recursive: true });
      fs.writeFileSync(`${base}/sources/${sha}.json`, JSON.stringify({
        schema: 1, sha, sessionId: "a-root", cli: "omp", at: AT + 2_000,
      }));

      let diffAsked = 0;
      const loaded = await loadCity(createFileIo(), {
        root: base, list, activateAt: AT - 1_000,
        diffForCommit: async () => { diffAsked++; return [{ status: "M", path: "src/a.js", blob: "blob1" }]; },
      });
      const city = townOf(loaded, null).shared.city;
      expect(stock(city)).toEqual(times(1)); // 一個回合的基本收入，沒有額外加碼
      expect(diffAsked).toBe(0); // 連差異都不必問 git
      // 舊證據檔留在磁碟上，不刪也不改。
      expect(fs.readdirSync(`${base}/commits`)).toHaveLength(1);
      expect(fs.readdirSync(`${base}/sources`)).toHaveLength(1);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
