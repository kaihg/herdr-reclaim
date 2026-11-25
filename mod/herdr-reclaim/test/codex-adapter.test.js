// Codex adapter 的固定事件重播接點：Codex hook 事件 → 活動檔 → 共用城市。
//
// 這裡餵的是真實 Codex hook 的 payload 形狀（隔離環境實測，見
// `/tmp/herdr-reclaim-handoff/evidence-10/`），由**真正的 adapter 程式**
// `codex-adapter/codex-activity.sh` 產生活動檔，再走正式載入路徑（`loadCity`）進共用城市。
// 只斷言使用者看得到的結果：活動事件、ack compact 與共用庫存計量器。
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { activityDir, adapterRoot } from "../core/adapter.js";
import { loadCity } from "../core/city-load.js";
import { CityLedger } from "../core/ledger.js";
import { SHARED_CITY_ID, sharedCityDir } from "../core/shared-city.js";
import { createFileIo } from "./fs-io.js";

// 真正的 adapter 程式：測試跑的是產品碼，不是另一份重寫。
const ADAPTER = path.join(import.meta.dir, "..", "..", "..", "codex-adapter", "codex-activity.sh");

async function listActivityFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "t@example.invalid"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "hi\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function commonDirOf(dir) {
  return git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

/** 隔離的 adapter 環境：獨立的 HERDR_APP_HOME 與固定的時間／writer epoch。 */
function makeHome(name) {
  const home = fs.mkdtempSync(`/tmp/reclaim-codex-${name}-`);
  return {
    home,
    appHome: path.join(home, "app"),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

/** 一個 rollout 檔：真的照 Codex 的形狀寫，adapter 才讀得到身分與用量。 */
function makeRollout(home, sessionId, meta) {
  const file = path.join(home, "sessions", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "0.156.1", source: "cli", ...meta } })}\n`,
  );
  return file;
}

function appendUsage(rollout, responseId, usage) {
  fs.appendFileSync(rollout, `${JSON.stringify({ type: "token_usage_record", payload: { response_id: responseId, usage } })}\n`);
}

/** 送出一個 Codex hook 事件；回傳 adapter 這次寫下的活動檔路徑與內容。 */
function hook(appHome, epoch, at, payload) {
  const result = spawnSync("sh", [ADAPTER], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HERDR_APP_HOME: appHome,
      HERDR_RECLAIM_EPOCH: epoch,
      HERDR_RECLAIM_NOW_MS: String(at),
    },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const file = path.join(activityDir(appHome), payload.session_id, `${epoch}.json`);
  return { status: result.status, file, record: readRecord(file) };
}

function readRecord(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

const ioWithList = async (dir) => listActivityFiles(dir);
/** 正式載入路徑：活動檔 → 共用帳本 → 公開讀取模型。 */
async function cityOf(appHome) {
  const loaded = await loadCity(
    { ...createFileIo(), list: ioWithList },
    { root: adapterRoot(appHome), list: ioWithList, now: 1_900_000_000_000, activateAt: 0 },
  );
  return loaded.city.city;
}

const openShared = (appHome) =>
  new CityLedger({ io: createFileIo(), dir: sharedCityDir(adapterRoot(appHome)), cityId: SHARED_CITY_ID }).open();

const SESSION = "01a1f69b-f2b8-7a43-b174-cd98a2af6c67";

describe("Codex 活動重播到共用城市", () => {
  test("純文字回合與工具回合都進同一個計量器；resume 的 epoch 不重算先前用量", async () => {
    const { home, appHome, cleanup } = makeHome("resume");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const rollout = makeRollout(home, SESSION, {});
      const base = { session_id: SESSION, transcript_path: rollout, cwd: repo };

      hook(appHome, "e1", 1_000, { ...base, hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "e1", 2_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "hi" });
      appendUsage(rollout, "resp_a", { input_tokens: 1_000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 12 });
      const first = hook(appHome, "e1", 3_000, { ...base, hook_event_name: "Stop", turn_id: "t1" });

      // resume：新的 Codex process（新的 writer epoch），同一個 rollout 被接續寫入。
      hook(appHome, "e2", 10_000, { ...base, hook_event_name: "SessionStart", source: "resume" });
      hook(appHome, "e2", 11_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t2", prompt: "again" });
      appendUsage(rollout, "resp_b", { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7 });
      const second = hook(appHome, "e2", 13_000, { ...base, hook_event_name: "PostToolUse", turn_id: "t2", tool_name: "Bash" });
      const final = hook(appHome, "e2", 14_000, { ...base, hook_event_name: "Stop", turn_id: "t2" });

      // 純文字回合：Stop 就有用量；工具回合：PostToolUse 的用量不會等到 Stop。
      expect(first.record.events.filter((event) => event.kind === "usage").map((event) => event.sourceEntryId)).toEqual(["resp_a"]);
      expect(second.record.events.filter((event) => event.kind === "usage").map((event) => event.sourceEntryId)).toEqual(["resp_b"]);
      expect(second.record.events.filter((event) => event.kind === "heartbeat")).toHaveLength(1);
      expect(final.record.events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
      // resume 的 epoch 只帶自己的來源：前一個 epoch 的 resp_a 不重發。
      expect(final.record.events.filter((event) => event.kind === "usage").map((event) => event.sourceEntryId)).toEqual(["resp_b"]);

      // resp_a：1000 − 400 cached + 12 output = 612；resp_b：500 + 7 = 507。
      const city = await cityOf(appHome);
      expect(city.work.tokens).toBe(1_119);
      expect(city.resources).toEqual({ wood: 0, stone: 0, iron: 0 });

      // 兩個 epoch 都保存成 activity entry；重讀得到同一個計量器。
      const state = await (await openShared(appHome)).state();
      expect([...state.activities.keys()].sort()).toEqual([`${SESSION}@@e1`, `${SESSION}@@e2`]);
      expect((await cityOf(appHome)).work.tokens).toBe(1_119);
    } finally {
      cleanup();
    }
  });

  test("Codex 的 input 扣掉已含的 cached input；缺漏或矛盾的值算未知、不補零", async () => {
    const { home, appHome, cleanup } = makeHome("usage");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const session = "01a1f69b-0000-7000-0000-00000000000a";
      const rollout = makeRollout(home, session, {});
      const base = { session_id: session, transcript_path: rollout, cwd: repo };

      hook(appHome, "u1", 0, { ...base, hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "u1", 1_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
      // 20,000 − 8,000 cached − 2,000 cache write + 12 output = 10,012。
      appendUsage(rollout, "resp_ok", { input_tokens: 20_000, cached_input_tokens: 8_000, cache_write_input_tokens: 2_000, output_tokens: 12 });
      // 少 output_tokens：未知，不補零、也不發這一筆。
      appendUsage(rollout, "resp_unknown", { input_tokens: 9_000, cached_input_tokens: 0, cache_write_input_tokens: 0 });
      // cache read + write 超過 input：矛盾的值，一樣當未知。
      appendUsage(rollout, "resp_bad", { input_tokens: 10, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 1 });
      hook(appHome, "u1", 2_000, { ...base, hook_event_name: "Stop", turn_id: "t1" });

      const city = await cityOf(appHome);
      // 只有 resp_ok 進計量器：一份建材 + 餘數 12。
      expect(city.work.tokens).toBe(12);
      expect(city.resources).toEqual({ wood: 3, stone: 2, iron: 1 });

      const record = readRecord(path.join(activityDir(appHome), session, "u1.json"));
      // 未知的來源記進 usageSeen，下一次不會再試著發一次。
      expect(record.usageSeen.sort()).toEqual(["resp_bad", "resp_ok", "resp_unknown"]);
      expect(record.events.filter((event) => event.kind === "usage").map((event) => event.sourceEntryId)).toEqual(["resp_ok"]);
      expect(record.events.find((event) => event.kind === "usage").usage.codex).toMatchObject({
        inputNonCache: 10_000,
        cacheRead: 8_000,
        cacheWrite: 2_000,
        output: 12,
      });
    } finally {
      cleanup();
    }
  });
});

describe("ack 之後的 compact 不會讓 Codex adapter 遺失狀態", () => {
  const recordOf = (appHome, sessionId, epoch) => readRecord(path.join(activityDir(appHome), sessionId, `${epoch}.json`));

  test("已入帳的事件被 compact 之後：visit 與區間狀態留著，序號接著遞增、Stop 不漏", async () => {
    const { home, appHome, cleanup } = makeHome("ack");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const session = "01a1f69b-0000-7000-0000-00000000000d";
      const rollout = makeRollout(home, session, {});
      const base = { session_id: session, transcript_path: rollout, cwd: repo };

      // 第一個回合：SessionStart → Prompt → usage → Stop。
      hook(appHome, "k1", 0, { ...base, hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "k1", 1_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
      appendUsage(rollout, "resp_a", { input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 });
      hook(appHome, "k1", 2_000, { ...base, hook_event_name: "Stop", turn_id: "t1" });
      const firstRound = recordOf(appHome, session, "k1");
      const ackedUpTo = Math.max(...firstRound.events.map((event) => event.eventSeq));

      // 正式路徑會寫 ack（共用帳本）；下一次 hook 會把所有已入帳的事件砍掉。
      expect((await cityOf(appHome)).work.tokens).toBe(1_010);
      const acked = await (await openShared(appHome)).readAck(session, "k1");
      expect(acked.ackedEventSeq).toBe(ackedUpTo);

      // 第二個回合：Prompt（要開區間）→ PreToolUse（要 heartbeat）→ Stop。
      hook(appHome, "k1", 10_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t2" });
      const afterCompact = recordOf(appHome, session, "k1");
      // visit 還開著：不能因為事件被砍掉就重開一個新的 visit（那會多一段 visit_end/visit_start）。
      expect(afterCompact.control.visit).not.toBeNull();
      expect(afterCompact.events.filter((event) => event.kind === "visit_start")).toHaveLength(0);

      hook(appHome, "k1", 11_000, { ...base, hook_event_name: "PreToolUse", turn_id: "t2", tool_name: "Bash" });
      hook(appHome, "k1", 12_000, { ...base, hook_event_name: "Stop", turn_id: "t2" });
      const secondRound = recordOf(appHome, session, "k1");
      // 舊碼：ack 掉 interval_open 之後 openNow=false → PreToolUse 不發 heartbeat、Stop 不關區間。
      expect(secondRound.events.filter((event) => event.kind === "heartbeat")).toHaveLength(1);
      expect(secondRound.events.filter((event) => event.kind === "interval_close")).toHaveLength(1);
      // 序號嚴格遞增，而且都大於已 ack 的（舊碼從 1 重編 → 帳本 stale_activity 拒絕）。
      const seqs = secondRound.events.map((event) => event.eventSeq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(Math.min(...seqs)).toBeGreaterThan(acked.ackedEventSeq);
      expect(secondRound.control.lastEventSeq).toBe(Math.max(...seqs));
      expect(secondRound.control.intervalOpen).toBe(false);

      // 第二次載入必須被帳本接受；兩段工作都在，重開帳本也一樣。
      const city = await cityOf(appHome);
      expect(city.work.tokens).toBe(1_010);
      const reopened = await (await openShared(appHome)).state();
      const stored = reopened.activities.get(`${session}@@k1`);
      expect(stored.events.filter((event) => event.kind === "interval_close")).toHaveLength(2);
      expect(stored.events.filter((event) => event.kind === "visit_start")).toHaveLength(1);
      expect((await cityOf(appHome)).work.tokens).toBe(1_010);
    } finally {
      cleanup();
    }
  });

  test("compact 之後重掃同一份 rollout：舊用量不會以現在的 visit／時間重發", async () => {
    const { home, appHome, cleanup } = makeHome("usage-compact");
    try {
      const repoA = makeRepo(path.join(home, "repo-a"));
      const repoB = makeRepo(path.join(home, "repo-b"));
      const session = "01a1f69b-0000-7000-0000-00000000000e";
      const rollout = makeRollout(home, session, {});
      const cityA = commonDirOf(repoA);

      hook(appHome, "m1", 0, { session_id: session, transcript_path: rollout, cwd: repoA, hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "m1", 1_000, { session_id: session, transcript_path: rollout, cwd: repoA, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
      appendUsage(rollout, "resp_a", { input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 });
      hook(appHome, "m1", 3_000, { session_id: session, transcript_path: rollout, cwd: repoA, hook_event_name: "Stop", turn_id: "t1" });

      expect((await cityOf(appHome)).work.tokens).toBe(1_010);

      // 換到另一個 repo（/cd 或切 worktree）再工作：同一份 rollout 會被重掃。
      hook(appHome, "m1", 10_000, { session_id: session, transcript_path: rollout, cwd: repoB, hook_event_name: "SessionStart", source: "resume" });
      hook(appHome, "m1", 11_000, { session_id: session, transcript_path: rollout, cwd: repoB, hook_event_name: "UserPromptSubmit", turn_id: "t2" });
      appendUsage(rollout, "resp_b", { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7 });
      hook(appHome, "m1", 12_000, { session_id: session, transcript_path: rollout, cwd: repoB, hook_event_name: "PostToolUse", turn_id: "t2", tool_name: "Bash" });
      const moved = recordOf(appHome, session, "m1");
      // 舊碼把已 ack 的 resp_a 從 usageSeen 扣掉，這裡會再發一次（時間變成 12000、visit 是 repo B）。
      expect(moved.events.filter((event) => event.kind === "usage").map((event) => event.sourceEntryId)).toEqual(["resp_b"]);
      expect(moved.usageSeen).toEqual(expect.arrayContaining(["resp_a", "resp_b"]));

      // 帳本裡 resp_a 只有原本那一筆，時間與 visit 都還是第一個 repo 的。第二個回合沒有 Stop，
      // 回合還開著，所以 resp_b 只留在活動檔、不進計量器（共用城市只結算已結束的回合）。
      const city = await cityOf(appHome);
      expect(city.work.tokens).toBe(1_010);
      const stored = (await (await openShared(appHome)).state()).activities.get(`${session}@@m1`);
      const original = stored.events.filter((event) => event.kind === "usage" && event.sourceEntryId === "resp_a");
      expect(original).toHaveLength(1);
      expect(original[0].at).toBe(3_000);
      const visitBefore = [...stored.events.slice(0, stored.events.indexOf(original[0]))]
        .reverse().find((event) => event.kind === "visit_start" || event.kind === "visit_end");
      expect(visitBefore.kind).toBe("visit_start");
      expect(visitBefore.visit.commonDir).toBe(cityA);
    } finally {
      cleanup();
    }
  });
});
