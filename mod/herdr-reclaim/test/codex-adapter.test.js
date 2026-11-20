// Codex adapter 的固定事件重播接點：Codex hook 事件 → 活動檔格式 → 公開城鎮讀取模型。
//
// 這裡餵的是真實 Codex hook 的 payload 形狀（隔離環境實測，見
// `/tmp/herdr-reclaim-handoff/evidence-10/`），由**真正的 adapter 程式**
// `codex-adapter/codex-activity.sh` 產生活動檔，再交給 mod 的公開讀取模型重播。
// 只斷言使用者看得到的結果：遠征、工作時間、visit、用量。
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { activityDir, adapterRoot, loadActivities } from "../core/adapter.js";
import { ingestScenario } from "../core/ingest.js";
import { CityLedger, cityDir } from "../core/ledger.js";
import { readTown, readTownFromLedger } from "../core/town.js";
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

function topLevelOf(dir) {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

/** 隔離的 adapter 環境：獨立的 HERDR_APP_HOME 與固定的時間／writer epoch。 */
function makeHome(name) {
  const home = fs.mkdtempSync(`/tmp/reclaim-10-${name}-`);
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
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, cli_version: "0.156.1", source: "cli", ...meta },
    })}\n`,
  );
  return file;
}

function appendUsage(rollout, responseId, usage) {
  fs.appendFileSync(rollout, `${JSON.stringify({ type: "token_usage_record", payload: { response_id: responseId, usage } })}\n`);
}

/** 送出一個 Codex hook 事件；回傳 adapter 這次寫下的活動檔路徑。 */
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

/** 活動檔 → 公開城鎮讀取模型。 */
async function townOf(appHome) {
  const activities = await loadActivities(
    { read: async (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null), list: listActivityFiles },
    activityDir(appHome),
  );
  return { activities, town: readTown({ activities, repoFacts: {} }) };
}

const SESSION = "01a1f69b-f2b8-7a43-b174-cd98a2af6c67";

describe("Codex 活動重播到城鎮模型", () => {
  test("純文字回合與工具回合更新同一遠征；resume 不重算先前活動或用量", async () => {
    const { home, appHome, cleanup } = makeHome("codex-resume");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const rollout = makeRollout(home, SESSION, {});
      const base = { session_id: SESSION, transcript_path: rollout, cwd: repo };

      hook(appHome, "e1", 1_000, { ...base, hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "e1", 2_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "hi" });
      appendUsage(rollout, "resp_a", { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 12 });
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

      const { town } = await townOf(appHome);
      expect(town.cities).toHaveLength(1);
      const tiles = town.cities[0].tiles;
      expect(tiles).toHaveLength(1);
      expect(tiles[0].rootSessionId).toBe(SESSION);
      // 兩個回合的區間取聯集：1000–3000 與 11000–14000。
      expect(tiles[0].workMs).toBe(4_000);
      // resp_a 只有在 e1 出現過；resume 的 epoch 不把它再算一次。
      expect(tiles[0].usage).toEqual({
        inputNonCache: 1_100,
        cacheRead: 400,
        cacheWrite: 0,
        output: 19,
        costKnown: 0,
        costUnknownEntries: 2,
      });
    } finally {
      cleanup();
    }
  });

  test("child 不另建格、用量歸 root；被打斷的回合只算到最後可證明的活動與用量", async () => {
    const { home, appHome, cleanup } = makeHome("codex-child");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const root = "01a1f69b-f2b8-7a43-b174-cd98a2af6c67";
      const child = "01a1f69b-fa0e-7000-0000-000000000001";
      const aborted = "01a1f69b-fa0e-7000-0000-000000000002";
      const rootRollout = makeRollout(home, root, {});
      // 真實 subagent 的形狀：source 是物件，thread_source 是 subagent，並帶 parent_thread_id。
      const childRollout = makeRollout(home, child, {
        source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } } },
        thread_source: "subagent",
        parent_thread_id: root,
      });
      const abortedRollout = makeRollout(home, aborted, {});
      const base = (session, rollout) => ({ session_id: session, transcript_path: rollout, cwd: repo });

      hook(appHome, "r1", 0, { ...base(root, rootRollout), hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "r1", 1_000, { ...base(root, rootRollout), hook_event_name: "UserPromptSubmit", turn_id: "t1" });
      appendUsage(rootRollout, "resp_root", { input_tokens: 200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 });
      hook(appHome, "r1", 31_000, { ...base(root, rootRollout), hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash" });
      hook(appHome, "r1", 61_000, { ...base(root, rootRollout), hook_event_name: "Stop", turn_id: "t1" });

      hook(appHome, "c1", 2_000, { ...base(child, childRollout), hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "c1", 2_000, { ...base(child, childRollout), hook_event_name: "UserPromptSubmit", turn_id: "ct1" });
      appendUsage(childRollout, "resp_child", { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 });
      hook(appHome, "c1", 61_000, { ...base(child, childRollout), hook_event_name: "Stop", turn_id: "ct1" });

      // 中止：UserPromptSubmit 之後就沒有事件（實測 SIGINT 不會補 Stop／Interrupt）。
      hook(appHome, "a1", 100_000, { ...base(aborted, abortedRollout), hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "a1", 101_000, { ...base(aborted, abortedRollout), hook_event_name: "UserPromptSubmit", turn_id: "at1" });
      appendUsage(abortedRollout, "resp_aborted", { input_tokens: 900, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 90 });

      const { town } = await townOf(appHome);
      expect(town.cities).toHaveLength(1);
      const tiles = town.cities[0].tiles;
      // child 不另建格：出現的格子只有兩支 root，沒有 child。
      expect(tiles.map((tile) => tile.rootSessionId).sort()).toEqual([root, aborted].sort());
      const tile = tiles.find((candidate) => candidate.rootSessionId === root);
      // root 1000–61000 與 child 2000–61000 取聯集。
      expect(tile.workMs).toBe(60_000);
      expect(tile.usage).toEqual({
        inputNonCache: 300,
        cacheRead: 0,
        cacheWrite: 0,
        output: 15,
        costKnown: 0,
        costUnknownEntries: 2,
      });
      // 中止那一支的事件停在 UserPromptSubmit（visit／區間開著）：時間 0、用量 0。
      const abortedRecord = readRecord(path.join(activityDir(appHome), aborted, "a1.json"));
      expect(abortedRecord.events.filter((event) => event.kind === "usage")).toHaveLength(0);
      const abortedTile = tiles.find((candidate) => candidate.rootSessionId === aborted);
      expect(abortedTile.workMs).toBe(0);
      expect(abortedTile.usage).toEqual({ inputNonCache: 0, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 0 });
    } finally {
      cleanup();
    }
  });

  test("Codex 的 input 扣掉已含的 cached input；欄位缺漏不補零", async () => {
    const { home, appHome, cleanup } = makeHome("codex-usage");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const session = "01a1f69b-0000-7000-0000-00000000000a";
      const rollout = makeRollout(home, session, {});
      const base = { session_id: session, transcript_path: rollout, cwd: repo };

      hook(appHome, "u1", 0, { ...base, hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "u1", 1_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
      appendUsage(rollout, "resp_ok", { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 12 });
      // 少 output_tokens：未知，不補零、也不發這一筆。
      appendUsage(rollout, "resp_unknown", { input_tokens: 900, cached_input_tokens: 0, cache_write_input_tokens: 0 });
      // cache read + write 超過 input：矛盾的值，一樣當未知。
      appendUsage(rollout, "resp_bad", { input_tokens: 10, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 1 });
      hook(appHome, "u1", 2_000, { ...base, hook_event_name: "Stop", turn_id: "t1" });

      const { town } = await townOf(appHome);
      expect(town.cities[0].tiles[0].usage).toEqual({
        inputNonCache: 500,
        cacheRead: 400,
        cacheWrite: 100,
        output: 12,
        costKnown: 0,
        costUnknownEntries: 1,
      });
      const record = readRecord(path.join(activityDir(appHome), session, "u1.json"));
      // 未知的來源記進 usageSeen，下一次不會再試著發一次。
      expect(record.usageSeen.sort()).toEqual(["resp_bad", "resp_ok", "resp_unknown"]);
    } finally {
      cleanup();
    }
  });

  test("worktree／move 之後的 visit 用工作當下保存的 repo 身分；worktree 刪掉仍歸同一座城", async () => {
    const { home, appHome, cleanup } = makeHome("codex-worktree");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const worktree = path.join(home, "repo-wt");
      git(repo, ["worktree", "add", "-q", worktree, "-b", "wt"]);
      const expectedCity = commonDirOf(repo);
      const mainCheckout = topLevelOf(repo);
      const worktreeCheckout = topLevelOf(worktree);
      const session = "01a1f69b-0000-7000-0000-00000000000b";
      const rollout = makeRollout(home, session, {});

      const visit = (epoch, at, cwd, kind) =>
        hook(appHome, epoch, at, { session_id: session, transcript_path: rollout, cwd, hook_event_name: kind, turn_id: "t1" });
      visit("w1", 0, repo, "SessionStart");
      visit("w1", 1_000, repo, "UserPromptSubmit");
      visit("w1", 31_000, repo, "Stop");
      // 同一支遠征在 worktree 繼續：/move 或切到 worktree 之後的下一次 agent_start。
      visit("w2", 40_000, worktree, "SessionStart");
      visit("w2", 41_000, worktree, "UserPromptSubmit");
      visit("w2", 71_000, worktree, "Stop");

      // 工作當下已經問過 git：之後 worktree 被刪掉，重播仍用當時保存下來的身份。
      fs.rmSync(worktree, { recursive: true, force: true });
      const { activities, town } = await townOf(appHome);
      expect(town.cities.map((city) => city.cityId)).toEqual([expectedCity]);
      const tiles = town.cities[0].tiles;
      expect(tiles).toHaveLength(1);
      // 同一個 remote／common dir 就是同一座城：兩個 checkout 的工時都算在同一格。
      expect(tiles[0].workMs).toBe(60_000);
      expect(tiles[0].visits.map((item) => item.checkout)).toEqual([mainCheckout, worktreeCheckout]);
      // checkout 是 visit 當下記下的；目錄已經不存在也還留著。
      expect(tiles[0].repo.checkout).toBe(worktreeCheckout);

      // 帳本重播（herdr 關閉期間寫入、之後才開）要得到同一座城。
      const ledgerHome = fs.mkdtempSync("/tmp/reclaim-10-ledger-");
      try {
        const io = createFileIo();
        const scenario = { activities, repoFacts: {} };
        const ledger = await new CityLedger({ io, dir: cityDir(ledgerHome, expectedCity), cityId: expectedCity }).open();
        await ingestScenario(ledger, scenario, expectedCity);
        const state = await ledger.state();
        const replayed = readTownFromLedger({ activities: [...state.activities.values()], expeditions: state.tiles, repoFacts: {} });
        expect(replayed).toEqual(town);
      } finally {
        fs.rmSync(ledgerHome, { recursive: true, force: true });
      }
    } finally {
      cleanup();
    }
  });
});

describe("ack 之後的 compact 不會讓 Codex adapter 遺失狀態", () => {
  /** 讀目前的活動檔（adapter 每次 hook 都寫同一條 epoch 的檔案）。 */
  const recordOf = (appHome, sessionId, epoch) => readRecord(path.join(activityDir(appHome), sessionId, `${epoch}.json`));

  const activitiesOf = (appHome) => loadActivities(
    { read: async (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null), list: listActivityFiles },
    activityDir(appHome),
  );

  /** 真帳本：ingest 成功會寫 ack，adapter 下一次就把已入帳的事件 compact 掉。 */
  const ledgerOf = (appHome, cityId) =>
    new CityLedger({ io: createFileIo(), dir: cityDir(adapterRoot(appHome), cityId), cityId }).open();

  test("已入帳的事件被 compact 之後：visit 與區間狀態留著，序號接著遞增、Stop 不漏", async () => {
    const { home, appHome, cleanup } = makeHome("codex-ack");
    try {
      const repo = makeRepo(path.join(home, "repo"));
      const session = "01a1f69b-0000-7000-0000-00000000000d";
      const rollout = makeRollout(home, session, {});
      const base = { session_id: session, transcript_path: rollout, cwd: repo };
      const cityId = commonDirOf(repo);

      // 第一個回合：SessionStart → Prompt → usage → Stop。
      hook(appHome, "k1", 0, { ...base, hook_event_name: "SessionStart", source: "startup" });
      hook(appHome, "k1", 1_000, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1" });
      appendUsage(rollout, "resp_a", { input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 });
      hook(appHome, "k1", 2_000, { ...base, hook_event_name: "Stop", turn_id: "t1" });
      const firstRound = recordOf(appHome, session, "k1");
      const ackedUpTo = Math.max(...firstRound.events.map((event) => event.eventSeq));

      const ledger = await ledgerOf(appHome, cityId);
      await ingestScenario(ledger, { activities: await activitiesOf(appHome), repoFacts: {} }, cityId);
      // 帳本寫了 ack：下一次 hook 會把所有已入帳的事件砍掉。
      const acked = await ledger.readAck(session, "k1");
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

      // 第二次 ingest 必須被帳本接受；重開帳本也得到同一座城。
      await ingestScenario(ledger, { activities: await activitiesOf(appHome), repoFacts: {} }, cityId);
      const state = await ledger.state();
      const replayed = readTownFromLedger({ activities: [...state.activities.values()], expeditions: state.tiles, repoFacts: {} });
      const tile = replayed.cities[0].tiles.find((candidate) => candidate.rootSessionId === session);
      // 兩段工作都算到：[1000, 2000] ∪ [10000, 12000]。
      expect(tile.workMs).toBe(3_000);
      const reopened = await openLedgerAgain(appHome, cityId);
      expect(readTownFromLedger({ activities: [...(await reopened.state()).activities.values()], expeditions: (await reopened.state()).tiles, repoFacts: {} })).toEqual(replayed);
    } finally {
      cleanup();
    }
  });

  test("compact 之後重掃同一份 rollout：舊用量不會以現在的 visit／時間重發", async () => {
    const { home, appHome, cleanup } = makeHome("codex-usage-compact");
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

      const ledger = await ledgerOf(appHome, cityA);
      await ingestScenario(ledger, { activities: await activitiesOf(appHome), repoFacts: {} }, cityA);

      // 換到另一座城（/move 或切到另一個 repo）再工作：同一份 rollout 會被重掃。
      hook(appHome, "m1", 10_000, { session_id: session, transcript_path: rollout, cwd: repoB, hook_event_name: "SessionStart", source: "resume" });
      hook(appHome, "m1", 11_000, { session_id: session, transcript_path: rollout, cwd: repoB, hook_event_name: "UserPromptSubmit", turn_id: "t2" });
      appendUsage(rollout, "resp_b", { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7 });
      hook(appHome, "m1", 12_000, { session_id: session, transcript_path: rollout, cwd: repoB, hook_event_name: "PostToolUse", turn_id: "t2", tool_name: "Bash" });
      const moved = recordOf(appHome, session, "m1");
      // 舊碼把已 ack 的 resp_a 從 usageSeen 扣掉，這裡會再發一次（時間變成 12000、visit 是 B 城）。
      expect(moved.events.filter((event) => event.kind === "usage").map((event) => event.sourceEntryId)).toEqual(["resp_b"]);
      expect(moved.usageSeen).toEqual(expect.arrayContaining(["resp_a", "resp_b"]));

      // 帳本裡 resp_a 只有原本那一筆，時間與 visit 都還是第一座城的。
      await ingestScenario(ledger, { activities: await activitiesOf(appHome), repoFacts: {} }, cityA);
      const state = await ledger.state();
      const stored = [...state.activities.values()].find((record) => record.sessionId === session);
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

  /** 重新開一份帳本實例（模擬 herdr 關掉之後再開）。 */
  async function openLedgerAgain(appHome, cityId) {
    return new CityLedger({ io: createFileIo(), dir: cityDir(adapterRoot(appHome), cityId), cityId }).open();
  }
});
