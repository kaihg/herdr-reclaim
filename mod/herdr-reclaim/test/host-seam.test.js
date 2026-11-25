// host 接縫：mod 端的儲存層（herdr 的 readTextFile／writeTextFile）與帳本之間的介面。
//
// 真實 host 的 CAS 衝突是原生 `Error`，訊息固定是
//   `herdr.writeTextFile`: The file changed outside Herdr. Reload before saving; your draft is still here.
// （2026-11-20 在隔離 HERDR_APP_HOME 的 herdr 0.1.16 實測：建立既有檔案、過期更新、對不存在的
// 檔案指定 expected，三種都是同一句；非衝突的錯誤（例如權限）是另一句。）
//
// 這裡用一個行為相同的假 host 逼出這個接縫：帳本只認 CasConflict，其他錯誤原樣往上丟。
import { describe, expect, test } from "bun:test";
import { CasConflict, CityLedger } from "../core/ledger.js";
import { hostIo } from "../core/host-io.js";
import { workYieldOf } from "../core/rules.js";

const HOST_CONFLICT =
  "`herdr.writeTextFile`: The file changed outside Herdr. Reload before saving; your draft is still here.";
const HOST_PERMISSION = "`herdr.writeTextFile`: Operation not permitted (os error 1)";

const AT = 1_800_000_000_000;
const cityIdOf = (name) => `/reclaim/${name}`;

/** 一筆基本收入：一份有效工作（10k token）換一份建材，來源鍵讓兩筆收入互不重複。 */
function incomeOp(state, source, cityId) {
  const tokens = 10_000;
  return {
    opId: `income:${cityId}:${source}`,
    kind: "income",
    at: AT,
    cityId,
    tokens,
    sources: [source],
    resources: workYieldOf(Number(state.work.tokens ?? 0) + tokens),
  };
}

/** 行為與 herdr 的檔案 API 相同的假 host（記憶體檔案系統）。 */
function fakeHost() {
  const files = new Map();
  const failures = new Map(); // path → { message, onlyUpdates }
  return {
    files,
    failures,
    beforeWrite: null,
    async readTextFile(path) {
      return files.has(path) ? files.get(path) : null;
    },
    async writeTextFile(path, text, expected) {
      if (this.beforeWrite) await this.beforeWrite(path, expected);
      const failure = failures.get(path);
      if (failure && (!failure.onlyUpdates || expected !== null)) {
        failures.delete(path);
        throw new Error(failure.message);
      }
      const current = files.has(path) ? files.get(path) : null;
      if (current !== expected) throw new Error(HOST_CONFLICT); // 跟真實 host 一樣：只換掉訊息
      files.set(path, text);
    },
  };
}

const ioOf = (host) => hostIo({ readTextFile: (path) => host.readTextFile(path), writeTextFile: (path, text, expected) => host.writeTextFile(path, text, expected) });

describe("host 接縫：真實 host 的 CAS 衝突", () => {
  test("過期更新與建立既有檔案都被認成 CAS 失敗，而不是一般錯誤", async () => {
    const host = fakeHost();
    const io = ioOf(host);
    await io.write("/city/a.json", "a", null);

    const stale = await io.write("/city/a.json", "b", "wrong").catch((error) => error);
    expect(stale).toBeInstanceOf(CasConflict);
    expect(stale.kind).toBe("stale");
    expect(await io.read("/city/a.json")).toBe("a"); // 沒有被寫進去

    const exists = await io.write("/city/a.json", "b", null).catch((error) => error);
    expect(exists).toBeInstanceOf(CasConflict);
    expect(exists.kind).toBe("exists");
    expect(await io.read("/city/a.json")).toBe("a");
  });

  test("不是 CAS 衝突的錯誤原樣丟出，不被吞掉也不被當成重試", async () => {
    const host = fakeHost();
    const io = ioOf(host);
    host.failures.set("/city/a.json", { message: HOST_PERMISSION, onlyUpdates: false });

    const failure = await io.write("/city/a.json", "a", null).catch((error) => error);
    expect(failure).not.toBeInstanceOf(CasConflict);
    expect(failure.message).toBe(HOST_PERMISSION);
  });

  test("兩個視窗同時首次開啟：host 的原生衝突錯誤也讓輸家重讀後成功", async () => {
    const host = fakeHost();
    const io = ioOf(host);
    const dir = "/city";
    const cityId = cityIdOf("race");
    const gate = Promise.withResolvers();
    let arrivals = 0;
    let released = false;
    host.beforeWrite = async (path, expected) => {
      if (released || !path.endsWith("/journal/0.json") || expected === null) return;
      arrivals += 1;
      if (arrivals === 2) {
        released = true;
        gate.resolve();
        return;
      }
      await gate.promise;
    };

    const a = await new CityLedger({ io, dir, cityId }).open();
    const b = await new CityLedger({ io, dir, cityId }).open();
    const results = await Promise.all([
      a.submit((state) => incomeOp(state, "sess-a", cityId)),
      b.submit((state) => incomeOp(state, "sess-b", cityId)),
    ]);

    expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
    const state = await a.state();
    expect(state.claims.size).toBe(2); // 兩筆來源都入帳，沒有重複附加
    const appends = [...host.files.values()].join("\n").trim().split("\n").filter((line) => line.includes('"kind":"income"'));
    expect(appends).toHaveLength(2);
  });

  test("帳本的附加遇到非衝突錯誤時原樣丟出（畫面才能說讀取失敗）", async () => {
    const host = fakeHost();
    const io = ioOf(host);
    const dir = "/city";
    const cityId = cityIdOf("boom");
    const ledger = await new CityLedger({ io, dir, cityId }).open();
    host.failures.set(`${dir}/journal/0.json`, { message: HOST_PERMISSION, onlyUpdates: true });

    await expect(ledger.submit((state) => incomeOp(state, "sess-a", cityId))).rejects.toThrow(/Operation not permitted/);
    expect((await ledger.state()).claims.size).toBe(0);
  });
});
