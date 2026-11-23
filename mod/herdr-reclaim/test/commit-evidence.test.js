import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bfsNextTile } from "../core/grid.js";
import { CityLedger } from "../core/ledger.js";
import { ingestScenario, processLand, redispatch } from "../core/ingest.js";
import { ingestCommits, parseRawDiff, parseReflogEvidence, unharvestedCommitReasons } from "../core/commit-evidence.js";
import { harvestForCommit } from "../core/harvest.js";
import { readTownFromLedger, selectionDetail } from "../core/town.js";
import { activity, visitStart } from "../scenarios/first-expedition.js";
import { searchHistory } from "../core/history.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/reclaim-commit-evidence/.git";
const base = (rootSessionId, cityId = CITY) => ({ opId: `expedition:${rootSessionId}`, kind: "expedition", at: 0, activatedAt: 0, cityId, rootSessionId, generation: 1, ...bfsNextTile(() => false), cli: "omp", repo: { commonDir: cityId, checkout: cityId.slice(0, -5) } });
const hook = (sha, env = {}) => ({ schema: 1, sha, hook: "post-commit", commonDir: CITY, toplevel: CITY.slice(0, -5), at: 1, env });
const docs = (name, blob) => [{ status: "A", path: `docs/${name}.md`, resultBlob: blob }];

describe("commit 證據 replay", () => {
  test("terminal-only reason 後晚到 exact SHA 自動補算；remote merge 只記理由；重播不倒扣庫存", async () => {
    const dir = `/tmp/reclaim-commit-evidence/${process.pid}-${Math.random().toString(36).slice(2)}`;
    const ledger = await new CityLedger({ io: createFileIo(), dir, cityId: CITY }).open();
    await ledger.submit(() => base("session-1"));
    const baselineSha = "c".repeat(40);
    const baselineHook = hook(baselineSha, { PI_SESSION_ID: "session-1" });
    const sources = [{ schema: 1, sha: baselineSha, cli: "omp", sessionId: "session-1", at: 1 }];
    const initialHook = hook("a".repeat(40), { HC_TERMINAL_ID: "terminal-1" });
    const diffForCommit = async (sha) => sha === baselineSha ? docs("prior", "blob-prior") : [{ status: "A", path: "src/app.js", resultBlob: "code" }, { status: "A", path: "tests/app.test.js", resultBlob: "test-1" }, { status: "A", path: "tests/other.test.js", resultBlob: "test-2" }, { status: "A", path: "docs/new.md", resultBlob: "doc" }];
    await ingestCommits({ ledger, hooks: [baselineHook], sources, activities: [], diffForCommit });
    sources.length = 0;
    await ingestCommits({ ledger, hooks: [initialHook], sources, activities: [], diffForCommit, subjectForCommit: async () => "History marker" });
    const afterUnattributed = await ledger.state();
    expect(afterUnattributed.resources).toEqual({ wood: 0, stone: 0, iron: 0, parchment: 1 });
    const unattributed = afterUnattributed.opSeqs.has(`commit:${initialHook.sha}:terminal-only:unknown`);
    expect(unattributed).toBe(true);
    const terminalReasons = unharvestedCommitReasons({ cityId: CITY, hooks: [initialHook], sources, activities: [], state: afterUnattributed });
    expect(readTownFromLedger({ expeditions: afterUnattributed.tiles, unharvestedCommits: { [CITY]: terminalReasons } }).cities[0].unharvestedCommits)
      .toEqual([{ sha: initialHook.sha, repo: CITY, reason: "terminal-only" }]);

    sources.push({ schema: 1, sha: initialHook.sha, cli: "omp", sessionId: "session-1", at: 2 });
    await ingestCommits({ ledger, hooks: [initialHook], sources, activities: [], diffForCommit, subjectForCommit: async () => "History marker" });
    const late = await ledger.state();
    expect(late.resources).toEqual({ wood: 10, stone: 20, iron: 0, parchment: 2 });
    expect(late.tileById.get(`${CITY}@@session-1@@1`).harvestPoints).toBe(40);
    expect(unharvestedCommitReasons({ cityId: CITY, hooks: [initialHook], sources, activities: [], state: late })).toEqual([]);
    const historyRecords = await ledger.historyRecords();
    const targetRecords = historyRecords.filter((record) => record.sha === initialHook.sha);
    expect(targetRecords.filter((record) => record.kind === "commit").map((record) => record.reason)).toEqual(["terminal-only", "verified"]);
    expect(targetRecords.filter((record) => record.kind === "harvest")).toHaveLength(1);
    expect(searchHistory({ records: historyRecords, tiles: late.tiles, query: "commit:history marker" }).total).toBe(3);
    const detail = selectionDetail(readTownFromLedger({ expeditions: late.tiles }), {
      kind: "expedition", cityId: CITY, rootSessionId: "session-1", generation: 1,
    });
    expect(detail.harvests.some((item) => item.subject === "History marker")).toBe(true);
    expect(detail.harvests.every((item) => item.detail.includes("規則 v2"))).toBe(true);
    // 詳情的欄位不再逐筆列出 commit（清單在「成果」面板）。
    expect(detail.fields.some((field) => field.label.startsWith("收成") || field.label.startsWith("成果"))).toBe(false);

    const remoteSha = "b".repeat(40);
    const remoteHook = { ...hook(remoteSha), hook: "reflog", reflog: "pull origin/main: Fast-forward" };
    await ingestCommits({ ledger, hooks: [...[initialHook, remoteHook]], sources, remoteMerges: new Set([remoteSha]), activities: [], diffForCommit });
    const afterRemote = await ledger.state();
    expect(afterRemote.resources).toEqual(late.resources);
    expect(afterRemote.opSeqs.has(`commit:${remoteSha}:remote-merge:unknown`)).toBe(true);
    await ingestCommits({ ledger, hooks: [initialHook, remoteHook], sources, remoteMerges: new Set([remoteSha]), activities: [], diffForCommit });
    const replayed = await ledger.state();
    expect(replayed.resources).toEqual(late.resources);
    expect(replayed.tileById.get(`${CITY}@@session-1@@1`).harvestPoints).toBe(40);
    const ideSha = "d".repeat(40);
    await ingestCommits({ ledger, hooks: [initialHook, remoteHook, hook(ideSha)], sources, remoteMerges: new Set([remoteSha]), activities: [], diffForCommit });
    const afterIde = await ledger.state();
    expect(afterIde.opSeqs.has(`commit:${ideSha}:no-session-source:unknown`)).toBe(true);
    expect(afterIde.resources).toEqual(late.resources);
    const visibleReasons = unharvestedCommitReasons({
      cityId: CITY, hooks: [initialHook, remoteHook, hook(ideSha)], sources,
      remoteMerges: new Set([remoteSha]), activities: [], state: afterIde,
    });
    const view = readTownFromLedger({ expeditions: afterIde.tiles, unharvestedCommits: { [CITY]: visibleReasons } });
    expect(view.cities[0].unharvestedCommits).toContainEqual({ sha: remoteSha, repo: CITY, reason: "remote-merge" });
    expect(view.cities[0].unharvestedCommits).toContainEqual({ sha: ideSha, repo: CITY, reason: "no-session-source" });
  });
  test("世代一撤回並重新派遣後才掃描：舊 commit 不得把點數算進世代二", async () => {
    const dir = `/tmp/reclaim-commit-evidence/${process.pid}-${Math.random().toString(36).slice(2)}`;
    const ledger = await new CityLedger({ io: createFileIo(), dir, cityId: CITY }).open();
    const checkout = CITY.slice(0, -5);
    const sessionId = "late-generation-session";
    const activatedAt = 1_000;
    const deactivatedAt = 3_000;
    const committedAt = 2_000;
    const record = activity({
      sessionId,
      writerEpoch: "late-generation",
      events: [
        visitStart("late-generation-visit", activatedAt, { commonDir: CITY, checkout }),
        { kind: "interval_open", at: activatedAt },
        { kind: "interval_close", at: deactivatedAt },
      ],
    });
    await ingestScenario(ledger, { activities: [record], repoFacts: { [CITY]: { hadHead: true } } }, CITY);
    expect((await ledger.state()).tileById.get(`${CITY}@@${sessionId}@@1`).activatedAt).toBe(activatedAt);

    expect((await processLand(ledger, {
      rootSessionId: sessionId, generation: 1, action: "withdraw", at: deactivatedAt,
    })).status).toBe("applied");
    expect((await redispatch(ledger, { rootSessionId: sessionId, at: 4_000 })).status).toBe("applied");

    // Gen 1 的 commit 證據直到 gen 2 已建立後才進入收成掃描；其事件時間仍在 gen 1。
    const sha = "e".repeat(40);
    const commitHook = { ...hook(sha, { PI_SESSION_ID: sessionId }), at: committedAt };
    const sources = [{ schema: 1, sha, cli: "omp", sessionId, at: committedAt }];
    const results = await ingestCommits({
      ledger,
      hooks: [commitHook],
      sources,
      activities: [record],
      diffForCommit: async () => [{ status: "A", path: "src/late.js", resultBlob: "late-blob" }],
    });

    expect(results).toContainEqual(expect.objectContaining({ status: "applied", opId: `harvest:${sha}` }));
    const state = await ledger.state();
    expect(state.tileById.get(`${CITY}@@${sessionId}@@1`).harvestPoints).toBe(20);
    expect(state.tileById.get(`${CITY}@@${sessionId}@@2`).harvestPoints).toBe(0);
    expect(state.resources).toEqual({ wood: 10, stone: 0, iron: 0, parchment: 0 });
  });
  test("真實 git pull reflog 只產生 SHA/repo 原因證據", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "reclaim-reflog-"));
    const bare = path.join(root, "origin.git");
    const source = path.join(root, "source");
    const local = path.join(root, "local");
    const run = (args) => {
      const result = spawnSync("git", args, { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      mkdirSync(source);
      run(["init", "--bare", bare]);
      run(["init", "-q", source]);
      run(["-C", source, "config", "user.email", "reflog@example.invalid"]);
      run(["-C", source, "config", "user.name", "Reflog"]);
      run(["-C", source, "branch", "-M", "main"]);
      writeFileSync(path.join(source, "base.txt"), "base\n");
      run(["-C", source, "add", "base.txt"]);
      run(["-C", source, "commit", "-qm", "initial"]);
      run(["-C", source, "remote", "add", "origin", bare]);
      run(["-C", source, "push", "-qu", "origin", "main"]);
      run(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
      run(["clone", "-q", bare, local]);
      run(["-C", local, "config", "user.email", "reflog@example.invalid"]);
      run(["-C", local, "config", "user.name", "Reflog"]);
      writeFileSync(path.join(source, "remote.txt"), "remote\n");
      run(["-C", source, "add", "remote.txt"]);
      run(["-C", source, "commit", "-qm", "remote merge candidate"]);
      run(["-C", source, "push", "-q", "origin", "main"]);
      run(["-C", local, "pull", "--ff-only"]);
      const sha = run(["-C", local, "rev-parse", "HEAD"]);
      const reflog = run(["-C", local, "reflog", "-n", "64", "--format=%H%x09%gs"]);
      const parsed = parseReflogEvidence(reflog, "/tmp/city/.git", local);
      expect(parsed.remoteMerges.has(sha)).toBe(true);
      expect(parsed.records.find((record) => record.sha === sha)).toMatchObject({
        hook: "reflog", commonDir: "/tmp/city/.git", toplevel: local, env: {},
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("新增→刪除→同內容新增→再刪除：每種 claim 只發一次，first-parent blob 不同的刪除不互相去重", async () => {
    const cityId = "/tmp/reclaim-deletion-claim/.git";
    const dir = `/tmp/reclaim-deletion-claim/${process.pid}-${Math.random().toString(36).slice(2)}`;
    const ledger = await new CityLedger({ io: createFileIo(), dir, cityId }).open();
    const spots = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [-1, -1]];
    const sessions = spots.map((_, index) => `claim-session-${index + 1}`);
    for (const [index, [x, y]] of spots.entries()) {
      await ledger.submit(() => ({ opId: `expedition:${sessions[index]}`, kind: "expedition", at: 0, activatedAt: 0, cityId, rootSessionId: sessions[index], generation: 1, x, y, cli: "omp", repo: { commonDir: cityId, checkout: "/tmp/reclaim-deletion-claim" } }));
    }
    const plan = {
      c1: { session: 0, changes: [{ status: "A", path: "src/x.ts", resultBlob: "blob-A" }] },
      c2: { session: 1, changes: [{ status: "D", path: "src/x.ts", resultBlob: null, oldBlob: "blob-A" }] },
      c3: { session: 2, changes: [{ status: "A", path: "src/x.ts", resultBlob: "blob-A" }] },
      c4: { session: 3, changes: [{ status: "D", path: "src/x.ts", resultBlob: null, oldBlob: "blob-A" }] },
      c5: { session: 4, changes: [{ status: "M", path: "src/x.ts", resultBlob: "blob-B" }] },
      c6: { session: 5, changes: [{ status: "D", path: "src/x.ts", resultBlob: null, oldBlob: "blob-B" }] },
    };
    const diffForCommit = async (sha) => plan[sha].changes;
    const ingest = async (sha) => {
      const state = await ledger.state();
      await ingestCommits({
        ledger,
        // repo 身分來自 Git hook；session 身分來自精確 SHA 的 OMP artifact（hook env 不帶 session）。
        hooks: [{ schema: 1, sha, hook: "post-commit", commonDir: cityId, toplevel: "/tmp/reclaim-deletion-claim", at: 1, env: {} }],
        sources: [{ schema: 1, sha, cli: "omp", sessionId: sessions[plan[sha].session], at: 2 }],
        activities: [...state.activities.values()],
        diffForCommit,
      });
      return (await ledger.state()).resources.wood;
    };
    const woodPerCommit = {};
    for (const sha of Object.keys(plan)) woodPerCommit[sha] = await ingest(sha);
    // 新增 blob-A 與刪除 blob-A 是兩份不同的成果；同內容重複新增、同 first-parent blob 重複刪除都不再發。
    expect(woodPerCommit).toEqual({ c1: 10, c2: 20, c3: 20, c4: 20, c5: 30, c6: 40 });

    const state = await ledger.state();
    const town = readTownFromLedger({ expeditions: state.tiles, resources: { [cityId]: state.resources } });
    expect(town.cities[0].resources).toEqual({ wood: 40, stone: 0, iron: 0, parchment: 0 });
    expect(state.claims.has(`${cityId}@@src/x.ts|blob-A`)).toBe(true);
    expect(state.claims.has(`${cityId}@@src/x.ts|deleted|blob-A`)).toBe(true);
    expect(state.claims.has(`${cityId}@@src/x.ts|blob-B`)).toBe(true);
    expect(state.claims.has(`${cityId}@@src/x.ts|deleted|blob-B`)).toBe(true);
    expect(await ledger.lookupClaim("src/x.ts|deleted|blob-B")).not.toBeNull();

    // 重播整份證據不得再發任何資源。
    for (const sha of Object.keys(plan)) await ingest(sha);
    const replayed = await ledger.state();
    expect(replayed.resources.wood).toBe(40);
    expect(readTownFromLedger({ expeditions: replayed.tiles, resources: { [cityId]: replayed.resources } }).cities[0].resources.wood).toBe(40);
  });
  test("真實 Git 的新增／刪除 blob 走 parseRawDiff 後，刪除仍算新單位", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "reclaim-deletion-git-"));
    const repo = path.join(root, "repo");
    const run = (args) => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      mkdirSync(repo);
      run(["init", "-q"]);
      run(["config", "user.email", "deletion@example.invalid"]);
      run(["config", "user.name", "Deletion"]);
      writeFileSync(path.join(repo, "x.ts"), "content A\n");
      run(["add", "x.ts"]);
      run(["commit", "-qm", "add A"]);
      const addSha = run(["rev-parse", "HEAD"]);
      const blobA = run(["rev-parse", `HEAD:x.ts`]);
      run(["rm", "-q", "x.ts"]);
      run(["commit", "-qm", "delete A"]);
      const deleteSha = run(["rev-parse", "HEAD"]);
      const addBlob = spawnSync("git", ["-C", repo, "diff-tree", "--root", "-r", "-M", "--raw", "-z", addSha], { encoding: "utf8" }).stdout;
      const deleteBlob = spawnSync("git", ["-C", repo, "diff-tree", "-r", "-M", "--raw", "-z", `${deleteSha}^1`, deleteSha], { encoding: "utf8" }).stdout;
      // 真實 diff-tree：新增帶 resultBlob、刪除帶 first-parent blob 且 resultBlob 為 null。
      expect(parseRawDiff(addBlob)).toEqual([{ status: "A", path: "x.ts", oldBlob: null, resultBlob: blobA }]);
      expect(parseRawDiff(deleteBlob)).toEqual([{ status: "D", path: "x.ts", oldBlob: blobA, resultBlob: null }]);
      const addHarvest = harvestForCommit({ cityId: "/tmp/city/.git", rootSessionId: "s1", generation: 1, sha: addSha, changes: parseRawDiff(addBlob), state: { claims: new Map() }, tile: { harvestedPaths: [] } });
      const deleteHarvest = harvestForCommit({ cityId: "/tmp/city/.git", rootSessionId: "s2", generation: 1, sha: deleteSha, changes: parseRawDiff(deleteBlob), state: { claims: new Map() }, tile: { harvestedPaths: [] } });
      expect(addHarvest.claims).toEqual([`x.ts|${blobA}`]);
      expect(deleteHarvest.claims).toEqual([`x.ts|deleted|${blobA}`]);
      expect(addHarvest.resources.wood + deleteHarvest.resources.wood).toBe(20);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("commit 證據只落在它真正屬於的那座城", () => {
  test("同一支 root 在兩座城都有遠征時，A 城的 commit 不會在 B 城再收成一次", async () => {
    const cityA = "/tmp/reclaim-two-cities-a/.git";
    const cityB = "/tmp/reclaim-two-cities-b/.git";
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const ledgerA = await new CityLedger({ io: createFileIo(), dir: `/tmp/reclaim-two-cities/a-${stamp}`, cityId: cityA }).open();
    const ledgerB = await new CityLedger({ io: createFileIo(), dir: `/tmp/reclaim-two-cities/b-${stamp}`, cityId: cityB }).open();
    const sessionId = "sess-two-cities";
    const at = (ms) => 1_700_000_000_000 + ms;
    // 同一支遠征先在 A 城工作、再到 B 城工作：兩邊都有重疊時間窗的格子。
    const record = (cityId, epoch) => activity({
      sessionId,
      writerEpoch: epoch,
      events: [
        visitStart(`v-${epoch}`, at(0), { commonDir: cityId, checkout: cityId.slice(0, -5) }),
        { kind: "interval_open", at: at(0) },
        { kind: "interval_close", at: at(60_000) },
      ],
    });
    await ingestScenario(ledgerA, { activities: [record(cityA, "a1")], repoFacts: { [cityA]: { hadHead: true } } }, cityA);
    await ingestScenario(ledgerB, { activities: [record(cityB, "b1")], repoFacts: { [cityB]: { hadHead: true } } }, cityB);

    const sha = "f".repeat(40);
    const hooks = [{ schema: 1, sha, hook: "post-commit", commonDir: cityA, toplevel: cityA.slice(0, -5), at: at(30_000), env: { PI_SESSION_ID: sessionId } }];
    const sources = [{ schema: 1, sha, cli: "omp", sessionId, at: at(30_000) }];
    const diffForCommit = async () => [{ status: "A", path: "src/a.js", resultBlob: "blob-a" }];

    const appliedA = await ingestCommits({
      ledger: ledgerA, hooks, sources, diffForCommit,
      activities: [...(await ledgerA.state()).activities.values()],
    });
    expect(appliedA.some((result) => result.status === "applied")).toBe(true);
    expect((await ledgerA.state()).resources.wood).toBe(10);

    const beforeB = await ledgerB.state();
    const appliedB = await ingestCommits({
      ledger: ledgerB, hooks, sources, diffForCommit,
      activities: [...beforeB.activities.values()],
    });
    // B 城的庫存、去重與歷程都不動：同一份證據不是它的。
    expect(appliedB).toEqual([]);
    const afterB = await ledgerB.state();
    expect(afterB.resources).toEqual(beforeB.resources);
    expect(afterB.claims.size).toBe(0);
    expect((await ledgerB.historyRecords()).filter((record_) => record_.sha === sha)).toEqual([]);
  });
});

describe("沒有可信時間的提交", () => {
  test("舊 recorder 的 at=0：記下來但不收成，也不用重播當下冒充", async () => {
    const cityId = "/tmp/reclaim-unknown-time/.git";
    const dir = `/tmp/reclaim-unknown-time/${process.pid}-${Math.random().toString(36).slice(2)}`;
    const ledger = await new CityLedger({ io: createFileIo(), dir, cityId }).open();
    const sessionId = "sess-unknown-time";
    await ingestScenario(ledger, {
      activities: [activity({
        sessionId,
        writerEpoch: "u1",
        events: [
          visitStart("v-unknown", 1_700_000_000_000, { commonDir: cityId, checkout: "/tmp/reclaim-unknown-time" }),
          { kind: "interval_open", at: 1_700_000_000_000 },
          { kind: "interval_close", at: 1_700_000_060_000 },
        ],
      })],
      repoFacts: { [cityId]: { hadHead: true } },
    }, cityId);

    const sha = "e".repeat(40);
    // 舊 recorder 寫的證據：at = 0（沒有時間）。
    const hooks = [{ schema: 1, sha, hook: "post-commit", commonDir: cityId, toplevel: "/tmp/reclaim-unknown-time", at: 0, env: { PI_SESSION_ID: sessionId } }];
    const diffForCommit = async () => [{ status: "A", path: "src/app.js", resultBlob: "blob-unknown" }];
    const state = await ledger.state();
    const results = await ingestCommits({ ledger, hooks, sources: [], activities: [...state.activities.values()], diffForCommit });
    expect(results).toContainEqual(expect.objectContaining({ status: "applied" }));
    const after = await ledger.state();
    // 記在歷程裡（看得到），但沒有資源、沒有格子、沒有 claim。
    expect(after.resources.wood).toBe(0);
    expect(after.claims.size).toBe(0);
    expect(after.tileById.get(`${cityId}@@${sessionId}@@1`).harvestPoints).toBe(0);
    expect((await ledger.historyRecords()).filter((record) => record.sha === sha).map((record) => record.reason)).toContain("unknown-commit-time");
    expect(unharvestedCommitReasons({ cityId, hooks, sources: [], activities: [...after.activities.values()], state: after }))
      .toEqual([{ sha, repo: cityId, reason: "unknown-commit-time" }]);

    // 重播同一份證據：結果一模一樣（沒有用「現在」補時間）。
    await ingestCommits({ ledger, hooks, sources: [], activities: [...(await ledger.state()).activities.values()], diffForCommit });
    const replayed = await ledger.state();
    expect(replayed.resources).toEqual(after.resources);
    expect(replayed.claims.size).toBe(0);
    const entries = (await ledger.scanSegments()).flatMap((segment) => segment.entries).filter((entry) => entry.sha === sha);
    expect(entries).toHaveLength(1);
    expect(entries[0].at).toBe(0);
  });

  test("reflog 證據帶真正的提交時間（%ct），舊的兩欄格式仍讀得懂", () => {
    const sha = "a".repeat(40);
    const parsed = parseReflogEvidence(`${sha}\t1700000000\tpull origin/main: Fast-forward\n`, "/tmp/city/.git", "/tmp/city");
    expect(parsed.records[0]).toMatchObject({ sha, at: 1_700_000_000_000, reflog: "pull origin/main: Fast-forward" });
    expect(parsed.remoteMerges.has(sha)).toBe(true);
    // 舊格式（沒有時間欄）：at = 0，訊息不被誤判成時間。
    const legacy = parseReflogEvidence(`${sha}\tcommit: 訊息\n`, "/tmp/city/.git", "/tmp/city");
    expect(legacy.records[0]).toMatchObject({ sha, at: 0, reflog: "commit: 訊息" });
  });
});
