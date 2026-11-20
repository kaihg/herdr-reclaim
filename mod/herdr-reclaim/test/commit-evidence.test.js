import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bfsNextTile } from "../core/grid.js";
import { CityLedger } from "../core/ledger.js";
import { ingestCommits, parseReflogEvidence, unharvestedCommitReasons } from "../core/commit-evidence.js";
import { readTownFromLedger } from "../core/town.js";
import { createFileIo } from "./fs-io.js";

const CITY = "/tmp/reclaim-commit-evidence/.git";
const base = (rootSessionId, cityId = CITY) => ({ opId: `expedition:${rootSessionId}`, kind: "expedition", cityId, rootSessionId, generation: 1, ...bfsNextTile(() => false), cli: "omp", repo: { commonDir: cityId, checkout: cityId.slice(0, -5) } });
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
    await ingestCommits({ ledger, hooks: [initialHook], sources, activities: [], diffForCommit });
    const afterUnattributed = await ledger.state();
    expect(afterUnattributed.resources).toEqual({ wood: 0, stone: 0, iron: 0, parchment: 1 });
    const unattributed = afterUnattributed.opSeqs.has(`commit:${initialHook.sha}:terminal-only:unknown`);
    expect(unattributed).toBe(true);
    const terminalReasons = unharvestedCommitReasons({ cityId: CITY, hooks: [initialHook], sources, activities: [], state: afterUnattributed });
    expect(readTownFromLedger({ expeditions: afterUnattributed.tiles, unharvestedCommits: { [CITY]: terminalReasons } }).cities[0].unharvestedCommits)
      .toEqual([{ sha: initialHook.sha, repo: CITY, reason: "terminal-only" }]);

    sources.push({ schema: 1, sha: initialHook.sha, cli: "omp", sessionId: "session-1", at: 2 });
    await ingestCommits({ ledger, hooks: [initialHook], sources, activities: [], diffForCommit });
    const late = await ledger.state();
    expect(late.resources).toEqual({ wood: 10, stone: 20, iron: 0, parchment: 2 });
    expect(late.tileById.get(`${CITY}@@session-1@@1`).harvestPoints).toBe(40);
    expect(unharvestedCommitReasons({ cityId: CITY, hooks: [initialHook], sources, activities: [], state: late })).toEqual([]);

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
});
