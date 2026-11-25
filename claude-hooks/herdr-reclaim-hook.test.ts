// Claude Code adapter 的固定事件重播接點：hook 事件 → 活動檔 → 共用城市讀得到的工作回合。
// 只斷言 adapter 寫出來的可觀察資料（session、visit、回合、用量與未知標記），不測畫面模型。
// #22 之後沒有各 repo 的遠征格：這些活動就是共用城市的工作來源。
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activityDir, loadActivities } from "../mod/herdr-reclaim/core/adapter.js";
import { createsTile, roundsOf } from "../mod/herdr-reclaim/core/research.js";
import { handleHook, interactiveOf, normalizeUsage, transcriptUsage } from "./herdr-reclaim-hook.ts";

const testRoots: string[] = [];

afterAll(() => {
  for (const root of testRoots) fs.rmSync(root, { recursive: true, force: true });
});
const sid = "11111111-2222-3333-4444-555555555555";

const nextSid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const childId = "deadbeefdeadbeef";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

function setupRepo(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hrc11-${label}-`)));
  testRoots.push(base);
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], repo);
  return { base, repo };
}

function transcriptLine(type, { id, usage, at, version = "2.1.317", sidechain = false } = {}) {
  return JSON.stringify({
    type,
    uuid: `${type}-${id ?? "none"}`,
    isSidechain: sidechain,
    timestamp: new Date(at).toISOString(),
    sessionId: sid,
    version,
    cwd: "/tmp",
    ...(type === "assistant" ? { message: { id, role: "assistant", usage } } : { message: { role: "user", content: "hi" } }),
  });
}

function writeTranscript(base, name, lines, dir) {
  const folder = dir ?? path.join(base, "transcripts");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function hook(appHome, pid, entrypoint = "cli") {
  return (name, extra = {}, now = 0) =>
    handleHook(
      { hook_event_name: name, session_id: sid, cwd: "/tmp/placeholder", ...extra },
      { appHome, pid, entrypoint, now },
    );
}

function listJson(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.endsWith(".lock")) walk(full);
      } else if (entry.name.endsWith(".json")) out.push(full);
    }
  };
  try {
    walk(dir);
  } catch {
    // 目錄還不存在：沒有活動
  }
  return out.sort();
}

/** 走 mod 自己的讀取路徑：活動檔 → 合併（與共用城市入帳時看到的是同一份）。 */
async function activitiesOf(appHome) {
  const io = {
    list: async (dir) => listJson(dir),
    read: async (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
  };
  return loadActivities(io, activityDir(appHome));
}

function usageEvents(appHome) {
  const root = path.join(appHome, "data", "herdr-reclaim", "activity");
  return listJson(root).flatMap((file) =>
    JSON.parse(fs.readFileSync(file, "utf8")).events.filter((event) => event.kind === "usage"),
  );
}

/** 同一把來源鍵只留最後一次（adapter 的 flush 會用完整快照取代 partial）。 */
function usageTotals(appHome) {
  const latest = new Map();
  for (const event of usageEvents(appHome)) {
    const key = event.usage?.anthropic?.sourceKey ?? event.sourceEntryId;
    if (!latest.has(key) || (event.at ?? 0) >= (latest.get(key).at ?? 0)) latest.set(key, event);
  }
  const totals = { inputNonCache: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const event of latest.values()) {
    for (const field of Object.keys(totals)) totals[field] += Number(event.usage.anthropic[field] ?? 0);
  }
  return totals;
}


describe("Claude Code adapter：hook 事件重播到活動檔", () => {
  test("純文字回合與工具回合更新同一支 session；resume 不重算先前活動或用量", async () => {
    const { base, repo } = setupRepo("turns");
    const appHome = path.join(base, "apphome");
    const fire = hook(appHome, 1000);

    // 第一個回合：只有純文字（一個 assistant 紀錄）。
    const t1 = 1_800_000_000_000;
    const first = writeTranscript(base, "turn-1", [
      transcriptLine("user", { at: t1 - 1_000 }),
      transcriptLine("assistant", { id: "msg_a", at: t1 + 1_000, usage: { input_tokens: 100, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 10 } }),
    ]);
    fire("SessionStart", { source: "startup", transcript_path: first, cwd: repo }, t1);
    fire("UserPromptSubmit", { transcript_path: first, cwd: repo }, t1 + 500);
    fire("Stop", { transcript_path: first, cwd: repo, prompt_id: "p1" }, t1 + 2_000);

    // 第二個回合：工具回合（多一個 assistant 紀錄）。
    const t2 = t1 + 60_000;
    const second = writeTranscript(base, "turn-2", [
      transcriptLine("user", { at: t1 - 1_000 }),
      transcriptLine("assistant", { id: "msg_a", at: t1 + 1_000, usage: { input_tokens: 100, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 10 } }),
      transcriptLine("assistant", { id: "msg_b", at: t2 + 1_000, usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 } }),
    ]);
    fire("UserPromptSubmit", { transcript_path: second, cwd: repo }, t2);
    fire("PreToolUse", { transcript_path: second, cwd: repo }, t2 + 500);
    fire("Stop", { transcript_path: second, cwd: repo, prompt_id: "p2" }, t2 + 2_000);

    const turnOne = await activitiesOf(appHome);
    expect(turnOne).toHaveLength(1);
    const record = turnOne[0];
    expect(createsTile(record)).toBe(true); // 互動的 root：這棵樹的工作算進共用城市
    expect(record.cli).toBe("claude");
    const visits = record.events.filter((event) => event.kind === "visit_start");
    expect(visits).toHaveLength(1);
    expect(visits[0].visit.commonDir).toBe(path.join(repo, ".git"));
    // 每個回合各關一次：共用城市的收入只結算已結束的回合。
    expect(roundsOf(record).rounds).toHaveLength(2);
    expect(roundsOf(record).open).toBeNull();
    expect(usageTotals(appHome)).toMatchObject({ inputNonCache: 150, cacheRead: 2, cacheWrite: 3, output: 17 });

    // resume：新行程（新 pid）接續同一個 session，transcript 裡已經有舊帳。
    const resumed = hook(appHome, 2000);
    const t3 = t2 + 120_000;
    const third = writeTranscript(base, "turn-3", [
      transcriptLine("user", { at: t1 - 1_000 }),
      transcriptLine("assistant", { id: "msg_a", at: t1 + 1_000, usage: { input_tokens: 100, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 10 } }),
      transcriptLine("assistant", { id: "msg_b", at: t2 + 1_000, usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 } }),
      transcriptLine("assistant", { id: "msg_c", at: t3 + 1_000, usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }),
    ]);
    resumed("SessionStart", { source: "resume", transcript_path: third, cwd: repo }, t3);
    resumed("UserPromptSubmit", { transcript_path: third, cwd: repo }, t3 + 500);
    resumed("Stop", { transcript_path: third, cwd: repo, prompt_id: "p3" }, t3 + 2_000);

    const afterResume = await activitiesOf(appHome);
    // 同一支 session 的兩個 writer epoch：合併之後是兩份紀錄，不是兩支工作樹。
    expect(afterResume).toHaveLength(2);
    expect(afterResume.every((entry) => createsTile(entry))).toBe(true);
    expect(usageTotals(appHome)).toMatchObject({ inputNonCache: 157, cacheRead: 2, cacheWrite: 3, output: 18 });
    expect(usageEvents(appHome).filter((event) => event.sourceEntryId === "msg_c")).toHaveLength(1);
    const epochs = afterResume.map((entry) => entry.writerEpoch);
    expect(new Set(epochs)).toHaveLength(2);
    expect(epochs.some((epoch) => epoch.startsWith("c1000-"))).toBe(true);
    expect(epochs.some((epoch) => epoch.startsWith("c2000-"))).toBe(true);
  });

  test("child 併進 root；中途中止只算到最後一次 heartbeat", async () => {
    const { base, repo } = setupRepo("child");
    const appHome = path.join(base, "apphome");
    const fire = hook(appHome, 3000);
    const t = 1_800_000_000_000;
    const childTranscript = writeTranscript(base, "child", [
      transcriptLine("assistant", { id: "msg_child", at: t + 1_001, usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, sidechain: true }),
    ]);

    fire("SessionStart", { source: "startup", cwd: repo }, t);
    fire("UserPromptSubmit", { cwd: repo }, t);
    fire("PreToolUse", { cwd: repo }, t + 1_000);
    fire("SubagentStart", { cwd: repo, agent_id: childId, agent_type: "general-purpose" }, t + 2_000);
    fire("SubagentStop", { cwd: repo, agent_id: childId, agent_transcript_path: childTranscript }, t + 9_000);
    fire("Stop", { cwd: repo }, t + 10_000);

    const done = await activitiesOf(appHome);
    expect(done.map((entry) => entry.role).sort()).toEqual(["child", "root"]);
    const child = done.find((entry) => entry.role === "child");
    expect(child.parentSessionId).toBe(sid);
    expect(child.interactive).toBe(false);
    expect(createsTile(child)).toBe(false); // child 的回合併進 root，不另外算一份工作
    expect(usageTotals(appHome)).toMatchObject({ inputNonCache: 5, output: 1 });

    // 中止：新的行程（pid 4000）只有 heartbeat，沒有 Stop／SessionEnd。
    const aborted = hook(appHome, 4000);
    const t2 = t + 300_000;
    aborted("SessionStart", { source: "startup", cwd: repo }, t2);
    aborted("UserPromptSubmit", { cwd: repo }, t2);
    aborted("PreToolUse", { cwd: repo }, t2 + 4_000);
    aborted("PreToolUse", { cwd: repo }, t2 + 9_000);

    const halt = await activitiesOf(appHome);
    const openEpoch = halt.find((entry) => entry.writerEpoch?.startsWith("c4000-"));
    // 第二次遠征沒有收尾：回合沒有 close（共用城市不結算未結束的回合），最後一次寫進磁碟的
    // heartbeat 就是它的最後活動。
    expect(roundsOf(openEpoch).open).not.toBeNull();
    expect(Math.max(...openEpoch.events.map((event) => event.at))).toBe(t2 + 9_000);
    expect(halt.reduce((sum, entry) => sum + roundsOf(entry).rounds.length, 0)).toBeGreaterThanOrEqual(2);
  });

  test("同一個 message ID 只留一次；欄位不完整標 unknown 不補零；沒有 assistant usage 不當成零消耗", async () => {
    const { base, repo } = setupRepo("usage");
    const appHome = path.join(base, "apphome");
    const fire = hook(appHome, 5000);
    const t = 1_800_000_000_000;
    const full = { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 5 };
    const later = { ...full, output_tokens: 9 };
    const partial = { input_tokens: 4, output_tokens: 2 };
    const transcript = writeTranscript(base, "usage", [
      transcriptLine("user", { at: t - 1 }),
      transcriptLine("assistant", { id: "msg_x", at: t + 1, usage: full }),
      transcriptLine("assistant", { id: "msg_x", at: t + 2, usage: later }),
      transcriptLine("assistant", { id: "msg_y", at: t + 3, usage: partial }),
    ]);
    fire("SessionStart", { source: "startup", transcript_path: transcript, cwd: repo }, t);
    fire("UserPromptSubmit", { transcript_path: transcript, cwd: repo }, t);
    fire("Stop", { transcript_path: transcript, cwd: repo }, t + 100);

    const events = usageEvents(appHome);
    expect(events.map((event) => event.sourceEntryId)).toEqual(["msg_x", "msg_y"]);
    const [x, y] = events;
    expect(x.usage.anthropic).toMatchObject({ sourceKey: `claude#${sid}#msg_x`, inputNonCache: 1, output: 9 });
    expect(y.usage.anthropic.unknownFields).toEqual(["cacheRead", "cacheWrite"]);
    expect("cacheRead" in y.usage.anthropic).toBe(false); // 不補 0
    expect("cacheWrite" in y.usage.anthropic).toBe(false);
    expect(y.usage.anthropic).toMatchObject({ inputNonCache: 4, output: 2, costUnknownEntries: 1 });

    // 只有請求紀錄、沒有 assistant usage 的 session：不產生任何用量事件。
    const empty = writeTranscript(base, "empty", [transcriptLine("user", { at: t - 1 })]);
    const quietHome = path.join(base, "quiet-apphome");
    const quiet = hook(quietHome, 5001);
    quiet("SessionStart", { source: "startup", transcript_path: empty, cwd: repo }, t);
    quiet("Stop", { transcript_path: empty, cwd: repo }, t + 100);
    expect(usageEvents(quietHome)).toHaveLength(0);
  });

  test("同 message ID 的 usage 在 flush 與 compact 邊界以完整快照取代 partial，亂序不回退", async () => {
    const t = 1_800_000_000_000;
    const full = { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 9 };
    const partial = { input_tokens: 11, output_tokens: 1 };

    const first = setupRepo("usage-flush-replacement");
    const firstHome = path.join(first.base, "apphome");
    const firstFire = hook(firstHome, 5500);
    const incremental = writeTranscript(first.base, "incremental", [
      transcriptLine("assistant", { id: "msg_incremental", at: t + 1, usage: partial }),
    ]);
    firstFire("SessionStart", { source: "startup", transcript_path: incremental, cwd: first.repo }, t);
    firstFire("UserPromptSubmit", { transcript_path: incremental, cwd: first.repo }, t + 1);
    firstFire("PreCompact", { transcript_path: incremental, cwd: first.repo }, t + 2);
    firstFire("SessionStart", { source: "compact", transcript_path: incremental, cwd: first.repo }, t + 3);
    fs.writeFileSync(incremental, [
      transcriptLine("assistant", { id: "msg_incremental", at: t + 1, usage: partial }),
      transcriptLine("assistant", { id: "msg_incremental", at: t + 4, usage: full }),
    ].join("\n") + "\n");
    firstFire("Stop", { transcript_path: incremental, cwd: first.repo }, t + 5);

    expect(usageTotals(firstHome)).toMatchObject({ inputNonCache: 11, cacheRead: 3, cacheWrite: 2, output: 9 });
    const corrections = usageEvents(firstHome);
    expect(corrections.map((event) => event.sourceEntryId)).toEqual(["msg_incremental", "msg_incremental"]);
    expect(new Set(corrections.map((event) => event.usage.anthropic.sourceKey))).toHaveLength(1);

    const second = setupRepo("usage-reversed-snapshot");
    const secondHome = path.join(second.base, "apphome");
    const secondFire = hook(secondHome, 5501);
    const reversed = writeTranscript(second.base, "reversed", [
      transcriptLine("assistant", { id: "msg_reversed", at: t + 4, usage: full }),
      transcriptLine("assistant", { id: "msg_reversed", at: t + 1, usage: partial }),
    ]);
    secondFire("SessionStart", { source: "startup", transcript_path: reversed, cwd: second.repo }, t);
    secondFire("UserPromptSubmit", { transcript_path: reversed, cwd: second.repo }, t + 1);
    secondFire("Stop", { transcript_path: reversed, cwd: second.repo }, t + 5);

    // 亂序的 partial 不會蓋掉完整快照：最後留下的仍是完整的那一筆。
    expect(usageTotals(secondHome)).toMatchObject({ inputNonCache: 11, cacheRead: 3, cacheWrite: 2, output: 9 });
  });

  test("worktree 與 /cd 之後的 visit 用工作當下保存的 repo 身分，worktree 刪掉後仍歸同一個 repo", async () => {
    const { base, repo } = setupRepo("worktree");
    const appHome = path.join(base, "apphome");
    const fire = hook(appHome, 6000);
    const worktree = path.join(base, "wt");
    git(["worktree", "add", "-q", worktree, "-b", "side"], repo);
    const t = 1_800_000_000_000;

    fire("SessionStart", { source: "startup", cwd: repo }, t);
    fire("UserPromptSubmit", { cwd: repo }, t);
    fire("PreToolUse", { cwd: worktree }, t + 30_000);
    fire("Stop", { cwd: worktree }, t + 60_000);

    fs.rmSync(worktree, { recursive: true, force: true }); // herdr 關著、worktree 已刪

    const records = await activitiesOf(appHome);
    expect(records).toHaveLength(1);
    const visits = records[0].events.filter((event) => event.kind === "visit_start").map((event) => event.visit);
    expect(visits).toHaveLength(2);
    expect(visits.map((visit) => visit.checkout).sort()).toEqual([repo, worktree].sort());
    expect(visits.every((visit) => visit.commonDir === path.join(repo, ".git"))).toBe(true);
    // 換 checkout 會收掉前一個 visit 的回合、開一個新的：兩個 visit、兩個已結束的回合，
    // 共用城市只看到同一支 session 的工作。
    expect(roundsOf(records[0]).rounds).toHaveLength(2);
  });

  test("-p（sdk-cli）不是互動工作：不產生可結算的回合", async () => {
    const { base, repo } = setupRepo("print");
    const appHome = path.join(base, "apphome");
    const print = hook(appHome, 7000, "sdk-cli");
    const t = 1_800_000_000_000;
    print("SessionStart", { source: "startup", cwd: repo }, t);
    print("UserPromptSubmit", { cwd: repo }, t);
    print("Stop", { cwd: repo }, t + 60_000);
    const records = await activitiesOf(appHome);
    expect(records[0]).toMatchObject({ interactive: false, role: "root" });
    expect(createsTile(records[0])).toBe(false); // 共用城市不把 print 的回合算成工作
    expect(interactiveOf("sdk-cli")).toBe(false);
    expect(interactiveOf("cli")).toBe(true);
  });
});

describe("Claude Code adapter：用量與 transcript 解析", () => {
  test("欄位正規化：完整、部分未知與負數都不補零", () => {
    const full = normalizeUsage(
      { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
      "key",
    );
    expect(full).toEqual({ sourceKey: "key", inputNonCache: 1, cacheRead: 2, cacheWrite: 3, output: 4, costKnown: 0, costUnknownEntries: 1 });
    const broken = normalizeUsage({ input_tokens: 1, output_tokens: -1 }, "key");
    expect(broken.unknownFields).toEqual(["cacheRead", "cacheWrite", "output"]);
    expect(broken.inputNonCache).toBe(1);
    expect("output" in broken).toBe(false);
  });

  test("transcript：同一 message ID 留最後一次、主 transcript 略過 sidechain", () => {
    const lines = [
      transcriptLine("assistant", { id: "m1", at: 1, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }),
      transcriptLine("assistant", { id: "m1", at: 2, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 } }),
      transcriptLine("assistant", { id: "m2", at: 3, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, sidechain: true }),
    ];
    const main = transcriptUsage(lines, { sessionId: sid, includeSidechain: false });
    expect(main.entries.map((entry) => entry.messageId)).toEqual(["m1"]);
    expect(main.entries[0].usage.output).toBe(9);
    const child = transcriptUsage(lines, { sessionId: sid, includeSidechain: true });
    expect(child.entries.map((entry) => entry.messageId).sort()).toEqual(["m1", "m2"]);
    const since = transcriptUsage(lines, { sessionId: sid, includeSidechain: false, since: 10 });
    expect(since.entries).toHaveLength(0);
  });
});
