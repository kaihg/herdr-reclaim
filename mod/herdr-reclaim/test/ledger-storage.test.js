// 帳本的儲存契約（#4）：完成依據、崩潰恢復、CAS 競爭、封段、checkpoint 的完整性與 ack。
// 只用共用城市的 entry（收入、活動合併），所以這些語意都還是現在的產品需要的那一些。
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
  CityLedger, CrashAfterContent, CrashAfterJournal, byteLen, hashText, workYieldOf,
} from "../core/ledger.js";
import { createFileIo } from "./fs-io.js";

const AT = 1_800_000_000_000;
const T = (ms) => AT + ms;
const root = (name) => `/tmp/reclaim-ledger/${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;
const open = (dir, options = {}) => new CityLedger({ io: createFileIo(), dir, cityId: "shared", ...options }).open();

/** 一筆基本收入：一份有效工作（預設 10k token）換一份建材；來源鍵是去重依據。 */
function incomeOp(state, source, { tokens = 10_000, at = T(0) } = {}) {
  return {
    opId: `income:shared:${source}`,
    kind: "income",
    at,
    cityId: "shared",
    tokens,
    sources: [source],
    resources: workYieldOf(state, tokens),
  };
}

/** 一支活動紀錄的合併 entry（內容檔存事件）。 */
function activityOp({ sessionId = "s1", writerEpoch = "e1", events = [{ eventSeq: 1, kind: "interval_open", at: T(0) }] } = {}) {
  return {
    opId: `activity:shared:${sessionId}@@${writerEpoch}@@${events.at(-1)?.eventSeq ?? 0}`,
    kind: "activity",
    at: T(0),
    cityId: "shared",
    sessionId,
    writerEpoch,
    role: "root",
    interactive: true,
    lastEventSeq: events.at(-1)?.eventSeq ?? 0,
    updatedAt: T(0),
    blobs: { events },
  };
}

const stock = (state) => [state.resources.wood, state.resources.stone, state.resources.iron];

describe("完成依據與崩潰恢復", () => {
  test("內容檔已寫、journal 未附加時中斷：重開後未完成、可重試且只算一次", async () => {
    const dir = root("crash-content");
    const ledger = await open(dir);
    const op = activityOp();
    await expect(ledger.submit(() => op, { crash: "after-content" })).rejects.toBeInstanceOf(CrashAfterContent);

    // 內容檔在，但 journal 沒有 entry：這筆不算完成。
    const reopened = await open(dir);
    expect((await reopened.state()).activities.size).toBe(0);

    expect((await reopened.submit(() => op)).status).toBe("applied");
    const afterCrash = await (await open(dir)).state();
    expect(afterCrash.lastSeq).toBe(0);
    expect([...afterCrash.activities.keys()]).toEqual(["s1@@e1"]);
  });

  test("journal 已附加、回覆前中斷：重開後視為完成，重送不重複", async () => {
    const dir = root("crash-journal");
    const ledger = await open(dir);
    await expect(ledger.submit((state) => incomeOp(state, "a"), { crash: "after-journal" })).rejects.toBeInstanceOf(CrashAfterJournal);

    const reopened = await open(dir);
    const state = await reopened.state();
    expect(stock(state)).toEqual([2, 1, 1]);
    expect((await reopened.submit((current) => incomeOp(current, "a"))).status).toBe("duplicate");
    expect(stock(await (await open(dir)).state())).toEqual([2, 1, 1]);
  });

  test("同樣的 operation ID 再送一次（即使內容不同）不會改變狀態", async () => {
    const dir = root("same-op");
    const ledger = await open(dir);
    await ledger.submit((state) => incomeOp(state, "a", { tokens: 10_000 }));
    const again = await ledger.submit((state) => incomeOp(state, "a", { tokens: 20_000 }));
    expect(again.status).toBe("duplicate");
    expect(stock(await ledger.state())).toEqual([2, 1, 1]);
  });

  test("前提不符整筆拒絕：同一筆來源不可能再入帳一次", async () => {
    const dir = root("reject");
    const ledger = await open(dir);
    await ledger.submit((state) => incomeOp(state, "a"));
    const rejected = await ledger.submit(() => ({
      opId: "income:shared:second-attempt",
      kind: "income",
      at: T(1),
      cityId: "shared",
      tokens: 10_000,
      sources: ["a"],
      resources: { wood: 2, stone: 1, iron: 1 },
    }));
    expect(rejected).toMatchObject({ status: "rejected", reason: "source_exists" });
    expect((await ledger.state()).lastSeq).toBe(0);
  });
});

describe("CAS 競爭與封段", () => {
  test("兩個畫面同時提交不同的收入：兩筆都成立，同一個來源不會被寫兩次", async () => {
    const dir = root("race");
    const [a, b] = await Promise.all([open(dir), open(dir)]);
    const results = await Promise.all([
      a.submit((state) => incomeOp(state, "space-a")),
      b.submit((state) => incomeOp(state, "space-b")),
    ]);
    expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
    const state = await (await open(dir)).state();
    expect(state.claims.size).toBe(2);
    expect(state.lastSeq).toBe(1);

    // 同一個來源從另一個視窗重送：整筆被拒（去重鍵已經在帳上）。
    const duplicate = await (await open(dir)).submit((current) => incomeOp(current, "space-a"));
    expect(duplicate.status).toBe("duplicate");
  });

  test("單段放不下就封段換下一段：所有 entry 都讀得回來，每一段都在上限內", async () => {
    const dir = root("seal");
    const limit = 900;
    const ledger = await open(dir, { segmentLimit: limit });
    for (let i = 0; i < 12; i++) {
      const result = await ledger.submit((state) => incomeOp(state, `s-${i}`, { tokens: 10_000 + i, at: T(i) }));
      expect(result.status).toBe("applied");
    }
    const segments = fs.readdirSync(`${dir}/journal`).map((name) => fs.readFileSync(`${dir}/journal/${name}`, "utf8"));
    expect(segments.length).toBeGreaterThan(1);
    for (const text of segments) expect(byteLen(text)).toBeLessThanOrEqual(limit);
    const state = await (await open(dir, { segmentLimit: limit })).state();
    expect(state.claims.size).toBe(12);
    expect(state.lastSeq).toBe(11);
  });

  test("封段完成、下一段還沒建立就中斷：重開後由讀到 seal 的寫入者補上，仍可提交", async () => {
    const dir = root("crash-seal");
    const ledger = await open(dir, { segmentLimit: 900 });
    let crashed = false;
    for (let i = 0; i < 40 && !crashed; i++) {
      try {
        await ledger.submit((state) => incomeOp(state, `s-${i}`, { tokens: 10_000 + i, at: T(i) }), { crash: "after-seal" });
      } catch (error) {
        crashed = error?.name === "CrashAfterSeal";
      }
    }
    expect(crashed).toBe(true);
    const reopened = await open(dir, { segmentLimit: 900 });
    expect((await reopened.submit((state) => incomeOp(state, "after-crash", { at: T(99) }))).status).toBe("applied");
    expect((await reopened.state()).claims.has("shared@@after-crash")).toBe(true);
  });
});

describe("checkpoint 是衍生索引：不完整就整份丟棄、從 journal 重建", () => {
  const filled = async (dir) => {
    const ledger = await open(dir);
    for (let i = 0; i < 3; i++) await ledger.submit((state) => incomeOp(state, `s-${i}`, { tokens: 10_000 + i, at: T(i) }));
    await ledger.checkpoint();
    return ledger;
  };

  test("checkpoint 只讓讀取變快：狀態與 checkpoint 無關", async () => {
    const dir = root("checkpoint-equal");
    const ledger = await filled(dir);
    const withCheckpoint = await ledger.state();
    const fresh = await open(dir, { segmentLimit: 256 * 1024 });
    const fromJournal = await fresh.state();
    expect(withCheckpoint.resources).toEqual(fromJournal.resources);
    expect(withCheckpoint.lastSeq).toBe(fromJournal.lastSeq);
  });

  test("manifest 的數值被改成合法 JSON（庫存 30→98765）：摘要不符就從頭重播", async () => {
    const dir = root("checkpoint-tamper");
    const ledger = await filled(dir);
    const before = await ledger.state();
    const head = JSON.parse(fs.readFileSync(`${dir}/head.json`, "utf8"));
    const manifestPath = `${dir}/checkpoints/${head.checkpoint}/manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.resources = { ...manifest.resources, wood: 98_765 };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect((await (await open(dir)).state()).resources).toEqual(before.resources);
  });

  test("claims 子頁內容被換掉（筆數不變）：已入帳的來源仍被擋下", async () => {
    const dir = root("checkpoint-claims");
    await filled(dir);
    const head = JSON.parse(fs.readFileSync(`${dir}/head.json`, "utf8"));
    const pageDir = `${dir}/checkpoints/${head.checkpoint}/claims`;
    const page = fs.readdirSync(pageDir, { withFileTypes: true }).find((entry) => entry.isFile());
    if (page) {
      const file = `${pageDir}/${page.name}`;
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("shared@@s-0", "shared@@s-x"));
    }
    const state = await (await open(dir)).state();
    expect(state.claims.has("shared@@s-0")).toBe(true);
    expect(state.claims.has("shared@@s-1")).toBe(true);
  });

  test("內容檔（blob）被改過：checkpoint 不可信，改用完整重播", async () => {
    const dir = root("checkpoint-blob");
    const ledger = await open(dir);
    await ledger.submit(() => activityOp({
      events: [{ eventSeq: 1, kind: "interval_open", at: T(0) }, { eventSeq: 2, kind: "interval_close", at: T(1) }],
    }));
    await ledger.checkpoint();
    const head = JSON.parse(fs.readFileSync(`${dir}/head.json`, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(`${dir}/checkpoints/${head.checkpoint}/manifest.json`, "utf8"));
    const blob = fs.readdirSync(`${dir}/blobs`).find((name) => name.endsWith(".json"));
    fs.writeFileSync(`${dir}/blobs/${blob}`, JSON.stringify({ events: [{ eventSeq: 9, kind: "interval_open", at: 1 }] }));
    const state = await (await open(dir)).state();
    expect([...state.activities.get("s1@@e1").events.map((event) => event.eventSeq)]).toEqual([1, 2]);
    expect(manifest.seq).toBe(head.checkpoint);
  });
});

describe("adapter 的 ack", () => {
  test("ack 可以重寫（內容不同就 CAS 更新），重播不讀它", async () => {
    const dir = root("ack");
    const ledger = await open(dir);
    await ledger.submit((state) => incomeOp(state, "a"));
    await ledger.writeAck({ sessionId: "s1", writerEpoch: "e1", ackedEventSeq: 1, journalSeq: 0 });
    await ledger.writeAck({ sessionId: "s1", writerEpoch: "e1", ackedEventSeq: 2, journalSeq: 0 });
    expect(await (await open(dir)).readAck("s1", "e1")).toMatchObject({ ackedEventSeq: 2, journalSeq: 0 });
    // ack 不進 journal：帳本狀態只由 entry 決定。
    expect((await (await open(dir)).state()).lastSeq).toBe(0);
    expect(hashText(fs.readFileSync(`${dir}/acks/s1/e1.json`, "utf8"))).toHaveLength(16);
  });
});

describe("commit 收成退場（#28、ADR 0002）：只重播、不再產生", () => {
  const LEGACY = {
    at: T(10), rulesVersion: 8, opId: "achievement:shared:abc", kind: "achievement", cityId: "shared",
    sha: "abc", repo: "/tmp/repo", claims: ["/tmp/repo|src/a.js:blob1"], resources: { wood: 3, stone: 2, iron: 1 },
  };

  test("帳本裡已落帳的 achievement 照常重播，庫存與升級前一致", async () => {
    const dir = root("legacy-achievement");
    const ledger = await open(dir);
    await ledger.submit((state) => incomeOp(state, "w"));
    // 舊版（v8）寫下的成果收成：直接寫進 journal，模擬磁碟上既有的帳本。
    fs.appendFileSync(`${dir}/journal/0.json`, `${JSON.stringify({ journalSeq: 1, ...LEGACY })}\n`);
    const state = await (await open(dir)).state();
    expect(stock(state)).toEqual([5, 3, 2]); // 基本收入 2/1/1 ＋ 舊成果 3/2/1
    expect(state.claims.has("shared@@/tmp/repo|src/a.js:blob1")).toBe(true);
    expect(state.opSeqs.has("achievement:shared:abc")).toBe(true);
  });

  test("新的 achievement 一律被拒：帳本不再發得出這一種收成", async () => {
    const dir = root("retired-achievement");
    const ledger = await open(dir);
    const result = await ledger.submit(() => ({ ...LEGACY, opId: "achievement:shared:def", sha: "def" }));
    expect(result).toMatchObject({ status: "rejected", reason: "retired" });
    expect(stock(await (await open(dir)).state())).toEqual([0, 0, 0]);
  });
});
