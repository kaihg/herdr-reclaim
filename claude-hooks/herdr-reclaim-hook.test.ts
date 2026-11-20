// Claude Code adapter 的固定事件重播接點：hook 事件 → 活動檔 → 公開城鎮讀取模型。
// 只斷言使用者可觀察的遠征、工作時間、visit、用量與未知標記，不測函式名稱或私有欄位。
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadActivities, activityDir } from "../mod/herdr-reclaim/core/adapter.js";
import { readTown } from "../mod/herdr-reclaim/core/town.js";
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

/** 走 mod 自己的讀取路徑：活動檔 → 合併 → 公開城鎮模型。 */
async function townOf(appHome) {
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
  const activities = await loadActivities(io, activityDir(appHome));
  return { town: readTown({ activities, repoFacts: {} }), activities };
}

function tileOf(town, rootSessionId = sid) {
  for (const city of town.cities) {
    const tile = city.tiles.find((candidate) => candidate.rootSessionId === rootSessionId);
    if (tile) return tile;
  }
  return null;
}

function usageEvents(appHome) {
  const root = path.join(appHome, "data", "herdr-reclaim", "activity");
  return listJson(root).flatMap((file) =>
    JSON.parse(fs.readFileSync(file, "utf8")).events.filter((event) => event.kind === "usage"),
  );
}

describe("Claude Code adapter：hook 事件重播到城鎮模型", () => {
  test("純文字回合與工具回合更新同一遠征；resume 不重算先前活動或用量", async () => {
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

    const turnOne = await townOf(appHome);
    expect(turnOne.town.cities).toHaveLength(1);
    expect(turnOne.town.cities[0].name).toBe("repo");
    expect(turnOne.town.cities[0].tiles).toHaveLength(1);
    const tile = tileOf(turnOne.town);
    expect(tile.cli).toBe("claude");
    expect(tile.repo.commonDir).toBe(path.join(repo, ".git"));
    expect(tile.visits).toHaveLength(1);
    expect(tile.usage).toMatchObject({ inputNonCache: 150, cacheRead: 2, cacheWrite: 3, output: 17 });
    expect(tile.workMs).toBe(3_500); // 兩個回合的工作時間，中間的閒置不算
    expect(tile.points).toBe(0);

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

    const afterResume = await townOf(appHome);
    const resumedTile = tileOf(afterResume.town);
    expect(afterResume.town.cities[0].tiles).toHaveLength(1); // 同一支遠征、同一格
    expect(resumedTile.usage).toMatchObject({ inputNonCache: 157, cacheRead: 2, cacheWrite: 3, output: 18 });
    expect(usageEvents(appHome).filter((event) => event.sourceEntryId === "msg_c")).toHaveLength(1);
    const epochs = afterResume.activities.map((record) => record.writerEpoch);
    expect(new Set(epochs)).toHaveLength(2);
    expect(epochs.some((epoch) => epoch.startsWith("c1000-"))).toBe(true);
    expect(epochs.some((epoch) => epoch.startsWith("c2000-"))).toBe(true);
  });

  test("child 不另建格、投入歸 root；中途中止只算到最後一次 heartbeat", async () => {
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

    const done = await townOf(appHome);
    expect(done.town.cities[0].tiles).toHaveLength(1);
    const tile = tileOf(done.town);
    expect(tile.workMs).toBe(10_000); // root 0–10000 與 child 2000–9000 取聯集
    expect(tile.usage).toMatchObject({ inputNonCache: 5, output: 1 });
    expect(done.activities.map((record) => record.role).sort()).toEqual(["child", "root"]);
    const child = done.activities.find((record) => record.role === "child");
    expect(child.parentSessionId).toBe(sid);
    expect(child.interactive).toBe(false);

    // 中止：新的行程（pid 4000）只有 heartbeat，沒有 Stop／SessionEnd。
    const aborted = hook(appHome, 4000);
    const t2 = t + 300_000;
    aborted("SessionStart", { source: "startup", cwd: repo }, t2);
    aborted("UserPromptSubmit", { cwd: repo }, t2);
    aborted("PreToolUse", { cwd: repo }, t2 + 4_000);
    aborted("PreToolUse", { cwd: repo }, t2 + 9_000);

    const halt = await townOf(appHome);
    const abortedTile = tileOf(halt.town);
    // 第二次遠征沒有收尾：只算到最後一次寫進磁碟的 heartbeat（9000），不是無限延長。
    expect(abortedTile.workMs).toBe(10_000 + 9_000);
    expect(abortedTile.status).toBe("active");
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
    const publicTown = await townOf(appHome);
    expect(tileOf(publicTown.town).usage.unknownFields).toEqual(["cacheRead", "cacheWrite"]);

    // 只有請求紀錄、沒有 assistant usage 的 session：不產生任何用量事件。
    const empty = writeTranscript(base, "empty", [transcriptLine("user", { at: t - 1 })]);
    const quietHome = path.join(base, "quiet-apphome");
    const quiet = hook(quietHome, 5001);
    quiet("SessionStart", { source: "startup", transcript_path: empty, cwd: repo }, t);
    quiet("Stop", { transcript_path: empty, cwd: repo }, t + 100);
    expect(usageEvents(quietHome)).toHaveLength(0);
    const quietTown = await townOf(quietHome);
    expect(tileOf(quietTown.town).usage).toMatchObject({ inputNonCache: 0, costUnknownEntries: 0 });
  });

  test("worktree 與 /cd 之後的 visit 用工作當下保存的 repo 身分，worktree 刪掉後仍歸同一座城", async () => {
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

    const town = await townOf(appHome);
    expect(town.town.cities).toHaveLength(1);
    expect(town.town.cities[0].cityId).toBe(path.join(repo, ".git"));
    const tile = tileOf(town.town);
    expect(tile.visits).toHaveLength(2);
    expect(tile.visits.map((visit) => visit.checkout).sort()).toEqual([repo, worktree].sort());
    expect(tile.visits.every((visit) => visit.commonDir === path.join(repo, ".git"))).toBe(true);
    expect(tile.workMs).toBe(60_000);
  });

  test("-p（sdk-cli）不建格；互動 cli 才建格", async () => {
    const { base, repo } = setupRepo("print");
    const appHome = path.join(base, "apphome");
    const print = hook(appHome, 7000, "sdk-cli");
    const t = 1_800_000_000_000;
    print("SessionStart", { source: "startup", cwd: repo }, t);
    print("UserPromptSubmit", { cwd: repo }, t);
    print("Stop", { cwd: repo }, t + 60_000);
    const town = await townOf(appHome);
    expect(town.town.cities).toHaveLength(0);
    expect(town.activities[0]).toMatchObject({ interactive: false, role: "root" });
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
