// 城帳本：append-only journal + CAS + checkpoint（proposal §13.1，ticket #3）。
//
// 這一層是純 JS：所有檔案 I/O 都走呼叫端給的 `io`（`read`／`write` 兩個非同步函式）。
//
// **儲存介面的契約**：`io.write(path, text, expected)` 只在快照不符（`expected` 不是現在
// 的內容，`expected === null` 代表建立新檔）時拒絕，而且**一律拒絕成 `CasConflict`**；
// 其他錯誤（權限、磁碟…）原樣往上丟。mod 端由 `core/host-io.js` 把 herdr 的原生錯誤
// 轉成 `CasConflict`；bun 測試的後端（test/fs-io.js）直接說同一種語言。
//
// 檔案（每個城的目錄）：
//   head.json                      固定大小：schemaVersion、rulesVersion、cityId、segment、checkpoint
//   journal/<n>.json               ndjson；每段有大小上限，滿了先 CAS 附加封段行，再換下一段
//   blobs/<hash>.json              內容檔，以內容雜湊命名；先寫內容，再附加 journal entry
//   checkpoints/<seq>.json         衍生狀態快照；讀取 = checkpoint + 之後的 journal
//   acks/<sessionId>/<epoch>.json  adapter 的 ack；journal 成功之後才寫
//
// 唯一完成依據是 journal entry：只有內容檔、沒有 entry 的操作不算完成（§13.1）。

export const SCHEMA = 1;
export const RULES_VERSION = 1;

/** §13.1：每段上限 256 KiB；herdr 單檔讀取上限是 1 MiB。 */
export const SEGMENT_LIMIT = 256 * 1024;

/** 每段預留封段行的空間，讓「封段」一定還在單段上限之內。 */
export const SEAL_RESERVE = 96;

/** CAS 失敗就重讀、重新檢查、再試；連續失敗到這個次數才放棄。 */
const MAX_ATTEMPTS = 8;

/**
 * 快照不符：呼叫端要重讀、重新檢查前提、再試（§13.1）。
 * `kind`：`"stale"`＝指定的 `expected` 已經不是現在的內容；`"exists"`＝要建立的新檔已經有了。
 */
export class CasConflict extends Error {
  constructor(path, kind = "stale") {
    super(kind === "exists" ? `檔案已經存在：${path}` : `快照已過期：${path}`);
    this.name = "CasConflict";
    this.kind = kind;
    this.path = path;
  }
}

/** 真實 host 的 CAS 衝突訊息；host 的錯誤只有 message，所以這是主要線索。 */
const HOST_CONFLICT = /changed outside Herdr|Reload before saving/i;

/**
 * 把儲存層的錯誤認成 `CasConflict`（回傳它），或回 null（不是 CAS 衝突，呼叫端原樣丟出）。
 *
 * 兩個線索互補：host 的訊息說「這是衝突」（`herdr.writeTextFile` 的錯誤只有 message 欄位，
 * 建立既有檔案／過期更新／對不存在的檔案指定 expected 都是同一句）；實際內容與 `expected`
 * 的關係決定是哪一種衝突。`current` 由呼叫端重讀後傳進來（讀不到就傳 undefined，只看訊息）。
 */
export function casConflictOf(error, { path, expected, current } = {}) {
  const byMessage = HOST_CONFLICT.test(String(error?.message ?? ""));
  const byContent = expected === null ? current != null : current !== undefined && current !== expected;
  if (!byMessage && !byContent) return null;
  return new CasConflict(path, expected === null ? "exists" : "stale");
}

/** 只有 CAS 衝突可以重試；其他錯誤原樣丟出，不要吞掉。 */
function rejectUnlessConflict(error) {
  if (!(error instanceof CasConflict)) throw error;
}

/** 故障注入用：內容檔已寫、journal 還沒附加時中斷。 */
export class CrashAfterContent extends Error {
  constructor(opId) {
    super(`內容已寫、journal 未附加：${opId}`);
    this.name = "CrashAfterContent";
    this.opId = opId;
  }
}

/** 故障注入用：journal 已附加、還沒回覆時中斷。 */
export class CrashAfterJournal extends Error {
  constructor(opId) {
    super(`journal 已附加、回覆前中斷：${opId}`);
    this.name = "CrashAfterJournal";
    this.opId = opId;
  }
}

/** 內容雜湊：FNV-1a 的兩段 32 位，換成 16 個十六進位字元。 */
export function hashText(text) {
  let low = 0x811c9dc5;
  let high = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ (code & 0xff), 0x01000193) >>> 0;
    high = Math.imul(high ^ ((code >>> 8) & 0xff) ^ index, 0x01000193) >>> 0;
  }
  return low.toString(16).padStart(8, "0") + high.toString(16).padStart(8, "0");
}

/** 城的目錄名：cityId 是絕對路徑，不能直接當檔名。 */
export function cityDir(baseDir, cityId) {
  return `${baseDir}/cities/${hashText(cityId)}`;
}

/** UTF-8 長度，不配置暫存字串（跟 JavaScript 字串的碼元數不同）。 */
export function byteLen(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** 一個 journal 段的內容：entry 陣列，最後可能有一行封段標記。 */
export function parseSegment(text) {
  const entries = [];
  let sealed = false;
  let sealSeq = null;
  let sealNext = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line === "") continue;
    if (sealed) throw new Error("封段標記之後還有 entry");
    const parsed = JSON.parse(line);
    if (parsed.seal !== undefined) {
      sealed = true;
      sealSeq = parsed.seal;
      sealNext = parsed.next;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, sealed, sealSeq, sealNext };
}

export const tileKey = (cityId, x, y) => `${cityId}@@${x},${y}`;
export const activityKey = (record) => `${record.sessionId}@@${record.writerEpoch ?? ""}`;

/**
 * 空狀態。`tiles`／`activities` 的順序就是 journal 的附加順序，重播結果因此可重現。
 * `opSeqs` 是 operation ID → journalSeq 的索引（§13.2）：判斷重複與回報 ack 都要用。
 */
function emptyState(cityId) {
  return {
    cityId,
    rulesVersion: RULES_VERSION,
    lastSeq: -1,
    tiles: [],
    taken: new Set(),
    activities: new Map(),
    opSeqs: new Map(),
    resources: { wood: 0, stone: 0, iron: 0, parchment: 0 },
  };
}

/** 狀態 → 可序列化的物件（checkpoint 與測試比對用）。 */
export function serializeState(state) {
  return {
    cityId: state.cityId,
    rulesVersion: state.rulesVersion,
    lastSeq: state.lastSeq,
    tiles: state.tiles,
    activities: [...state.activities.values()],
    opSeqs: [...state.opSeqs],
    resources: state.resources,
  };
}

export function deserializeState(data) {
  const state = emptyState(data.cityId);
  state.rulesVersion = data.rulesVersion ?? RULES_VERSION;
  state.lastSeq = data.lastSeq ?? -1;
  state.tiles = data.tiles ?? [];
  for (const tile of state.tiles) state.taken.add(tileKey(tile.cityId, tile.x, tile.y));
  for (const record of data.activities ?? []) state.activities.set(activityKey(record), record);
  for (const [opId, seq] of data.opSeqs ?? []) state.opSeqs.set(opId, seq);
  state.resources = data.resources ?? { wood: 0, stone: 0, iron: 0, parchment: 0 };
  return state;
}

/**
 * 每一種 operation 的套用與前提檢查。之後的票（#4／#5）在這裡加新的 kind，
 * entry 只要帶上自己的欄位即可，格式不用改。
 */
export const KINDS = {
  /**
   * 遠征取得土地（§4 的自動選地）：座標由呼叫端在 `make` 裡用 BFS 算出來；
   * 前提是那一格還空著、而且這支遠征在這座城還沒有格。
   */
  expedition: {
    precheck(state, op) {
      if (state.tiles.some((tile) => tile.cityId === op.cityId && tile.rootSessionId === op.rootSessionId)) {
        return "tile_exists";
      }
      if (state.taken.has(tileKey(op.cityId, op.x, op.y))) return "tile_taken";
      return null;
    },
    apply(state, entry) {
      state.tiles.push({
        cityId: entry.cityId,
        rootSessionId: entry.rootSessionId,
        generation: entry.generation ?? 1,
        x: entry.x,
        y: entry.y,
        cli: entry.cli ?? null,
        repo: entry.repo ?? null,
      });
      state.taken.add(tileKey(entry.cityId, entry.x, entry.y));
    },
  },
  /**
   * 活動合併（§6.2）：以 (sessionId, writerEpoch) 為鍵。adapter 收到 ack 後會 compact
   * 磁碟快照，後續 entry 只含未 ack 的尾巴；帳本重播時必須把事件併回舊快照，不能覆蓋它。
   */
  activity: {
    precheck(state, op, blobs) {
      if (!blobs || !Array.isArray(blobs.events)) return "missing_events";
      const current = state.activities.get(activityKey(op));
      if (current && (current.lastEventSeq ?? -1) > (op.lastEventSeq ?? -1)) return "stale_activity";
      return null;
    },
    apply(state, entry, blobs) {
      const key = activityKey(entry);
      const current = state.activities.get(key);
      const bySeq = new Map((current?.events ?? []).map((event) => [event.eventSeq, event]));
      for (const event of blobs?.events ?? []) bySeq.set(event.eventSeq, event);
      const events = [...bySeq.values()].sort((a, b) => a.eventSeq - b.eventSeq);
      state.activities.set(key, {
        schema: SCHEMA,
        sessionId: entry.sessionId,
        writerEpoch: entry.writerEpoch,
        role: entry.role ?? current?.role ?? "root",
        interactive: entry.interactive === true || current?.interactive === true,
        parentSessionId: entry.parentSessionId ?? current?.parentSessionId ?? null,
        cli: entry.cli ?? current?.cli ?? null,
        updatedAt: Math.max(current?.updatedAt ?? 0, entry.updatedAt ?? entry.at ?? 0),
        lastEventSeq: Math.max(current?.lastEventSeq ?? -1, entry.lastEventSeq ?? -1),
        events,
      });
    },
  },
};

export class CityLedger {
  /**
   * @param {object} options
   * @param {{ read(path: string): Promise<string|null>, write(path: string, text: string, expected: string|null): Promise<void> }} options.io
   * @param {string} options.dir 這個城的目錄
   * @param {string} options.cityId canonical git common dir
   */
  constructor({ io, dir, cityId, segmentLimit = SEGMENT_LIMIT, rulesVersion = RULES_VERSION }) {
    if (!io || typeof io.read !== "function" || typeof io.write !== "function") {
      throw new Error("帳本需要 { read, write } 的 io");
    }
    this.io = io;
    this.dir = dir;
    this.cityId = cityId;
    this.limit = segmentLimit;
    this.rulesVersion = rulesVersion;
  }

  headPath() {
    return `${this.dir}/head.json`;
  }

  segmentPath(index) {
    return `${this.dir}/journal/${index}.json`;
  }

  blobPath(hash) {
    return `${this.dir}/blobs/${hash}.json`;
  }

  checkpointPath(seq) {
    return `${this.dir}/checkpoints/${seq}.json`;
  }

  ackPath(sessionId, writerEpoch) {
    return `${this.dir}/acks/${sessionId}/${writerEpoch}.json`;
  }

  /** 第一次開這個城時建立 head 與第 0 段；已經有就沿用。 */
  async open() {
    const headText = await this.io.read(this.headPath());
    if (headText === null) {
      await this.create(
        this.headPath(),
        `${JSON.stringify({
          schemaVersion: SCHEMA,
          rulesVersion: this.rulesVersion,
          cityId: this.cityId,
          segment: 0,
          checkpoint: -1,
        })}\n`,
      );
    }
    if ((await this.io.read(this.segmentPath(0))) === null) await this.create(this.segmentPath(0), "");
    return this;
  }

  /**
   * expected = null 的建立；別人在前面建好了就沿用（不是錯）。
   * 只有 CAS 衝突才這樣處理：其他錯誤（權限、磁碟…）原樣丟出，不吞。
   */
  async create(path, text) {
    try {
      await this.io.write(path, text, null);
    } catch (error) {
      rejectUnlessConflict(error);
      if ((await this.io.read(path)) === null) throw error; // 衝突但檔案還是不在：讓呼叫端知道
    }
  }

  async head() {
    const text = await this.io.read(this.headPath());
    if (text === null) throw new Error(`帳本沒有 head：${this.headPath()}`);
    return { text, head: JSON.parse(text) };
  }

  /** head 指到的尾段；head 落後時跟著封段標記往前。 */
  async tailView() {
    const { text: headText, head } = await this.head();
    let index = head.segment;
    let text = await this.io.read(this.segmentPath(index));
    let parsed = parseSegment(text ?? "");
    let guard = 0;
    while (parsed.sealed) {
      if (guard++ > 4096) throw new Error("封段鏈太長");
      index = parsed.sealNext;
      text = await this.io.read(this.segmentPath(index));
      parsed = parseSegment(text ?? "");
    }
    return { head, headText, index, text, entries: parsed.entries };
  }

  /** 第 0 段起連續存在的所有段（讀取與 checkpoint 重播都走這裡）。 */
  async scanSegments(from = 0) {
    const segments = [];
    for (let index = from; ; index++) {
      const text = await this.io.read(this.segmentPath(index));
      if (text === null) break;
      if (byteLen(text) > this.limit) throw new Error(`第 ${index} 段超過上限`);
      segments.push({ index, text, ...parseSegment(text) });
    }
    return segments;
  }

  /** checkpoint + 之後的 journal → 狀態。 */
  async rebuild() {
    const { head } = await this.head();
    let state = emptyState(this.cityId);
    let from = 0;
    if (head.checkpoint >= 0) {
      const text = await this.io.read(this.checkpointPath(head.checkpoint));
      if (text !== null) {
        const snapshot = JSON.parse(text);
        state = deserializeState(snapshot.state);
        from = snapshot.segment ?? 0;
      }
    }
    // checkpoint 指到的段被刪掉時不能靜靜地少讀後面的 entry。
    if (from > 0 && (await this.io.read(this.segmentPath(from))) === null) {
      throw new Error(`checkpoint 指到的第 ${from} 段不見了`);
    }
    let lastSegment = from;
    for (const segment of await this.scanSegments(from)) {
      for (const entry of segment.entries) {
        if (entry.journalSeq <= state.lastSeq) continue;
        await this.applyEntry(state, entry);
        lastSegment = segment.index;
      }
    }
    return { state, segment: lastSegment };
  }

  async applyEntry(state, entry) {
    const kind = KINDS[entry.kind];
    if (!kind) throw new Error(`未知的 entry kind：${entry.kind}`);
    const text = entry.content ? await this.io.read(this.blobPath(entry.content)) : null;
    if (entry.content && text === null) throw new Error(`內容檔不見了：${entry.content}`);
    kind.apply(state, entry, text === null ? null : JSON.parse(text));
    state.opSeqs.set(entry.opId, entry.journalSeq);
    state.lastSeq = entry.journalSeq;
  }

  /** 讀取用：checkpoint 加後續 journal。 */
  async state() {
    return (await this.rebuild()).state;
  }

  /**
   * 提交一筆操作（§13.1 的提交流程）：讀尾段 → 重建狀態 → `make(state)` 產生 op
   * → 檢查前提 → 先寫內容檔 → CAS 附加 entry。CAS 失敗或有別人先換段就重讀再試，
   * `make` 因此會在新的狀態上重新判定（例如重新選地）。
   *
   * `make` 回 null 代表沒有事要做。回傳 `{ status, journalSeq?, reason?, attempts }`。
   */
  async submit(make, options = {}) {
    let last = { status: "nothing" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const view = await this.tailView();
      const { state } = await this.rebuild();
      const op = make(state);
      if (!op) return { status: "nothing", attempts: attempt };
      const blobs = op.blobs ?? null;
      if (state.opSeqs.has(op.opId)) {
        return { status: "duplicate", opId: op.opId, journalSeq: state.opSeqs.get(op.opId), attempts: attempt };
      }
      const reason = KINDS[op.kind]?.precheck?.(state, op, blobs);
      if (reason) return { status: "rejected", reason, attempts: attempt };

      const content = blobs ? await this.writeBlob(blobs) : null;
      if (options.crash === "after-content") throw new CrashAfterContent(op.opId);

      const { blobs: _ignored, ...fields } = op;
      const entry = {
        journalSeq: state.lastSeq + 1,
        at: op.at ?? Date.now(),
        rulesVersion: this.rulesVersion,
        ...fields,
        content,
      };
      const line = `${JSON.stringify(entry)}\n`;
      const current = view.text ?? "";

      // 這一段放不下下一筆：先 CAS 附加封段行，再換段；別人先封就重讀。
      if (byteLen(current) + byteLen(line) + SEAL_RESERVE > this.limit) {
        if (view.entries.length === 0) throw new Error(`單筆 entry 超過單段上限：${op.opId}`);
        try {
          await this.io.write(
            this.segmentPath(view.index),
            `${current}${JSON.stringify({ seal: state.lastSeq, next: view.index + 1 })}\n`,
            view.text,
          );
        } catch (error) {
          rejectUnlessConflict(error);
          last = { status: "rotated" };
          continue; // 別人先封了（或有新的 entry）：重讀再試
        }
        await this.create(this.segmentPath(view.index + 1), "");
        await this.updateHead(view, { segment: view.index + 1 });
        last = { status: "rotated" };
        continue;
      }

      // CAS：快照不符就重讀、重新檢查前提、再試（§13.1）。其他錯誤原樣丟出。
      try {
        await this.io.write(this.segmentPath(view.index), `${current}${line}`, view.text);
      } catch (error) {
        rejectUnlessConflict(error);
        last = { status: "stale" };
        continue;
      }
      if (options.crash === "after-journal") throw new CrashAfterJournal(op.opId);
      return { status: "applied", journalSeq: entry.journalSeq, opId: entry.opId, attempts: attempt };
    }
    return { ...last, attempts: MAX_ATTEMPTS };
  }

  /** 內容檔以雜湊命名；已經有同樣的內容就沿用（重試不會多寫）。 */
  async writeBlob(content) {
    const text = JSON.stringify(content);
    const hash = hashText(text);
    if ((await this.io.read(this.blobPath(hash))) === null) await this.create(this.blobPath(hash), text);
    return hash;
  }

  /** CAS 寫入：只有快照不符才失敗，交給呼叫端決定要不要重試。 */
  async write(path, text, expected) {
    await this.io.write(path, text, expected);
  }

  async updateHead(view, changes) {
    const head = { ...view.head, ...changes };
    try {
      await this.io.write(this.headPath(), `${JSON.stringify(head)}\n`, view.headText);
    } catch (error) {
      // head 只是快取：讀取端跟著封段標記走，下次提交會再更新一次。
      // 但只有 CAS 衝突可以吞；其他錯誤要讓呼叫端看到。
      rejectUnlessConflict(error);
    }
  }

  /** 衍生狀態快照；讀取時 = checkpoint + 之後的 journal（§13.1）。 */
  async checkpoint() {
    const { state, segment } = await this.rebuild();
    const seq = state.lastSeq;
    if (seq < 0) return { seq, segment };
    await this.create(
      this.checkpointPath(seq),
      JSON.stringify({ seq, segment, cityId: this.cityId, rulesVersion: this.rulesVersion, state: serializeState(state) }),
    );
    const { text, head } = await this.head();
    await this.updateHead({ head, headText: text }, { checkpoint: seq });
    return { seq, segment };
  }

  /**
   * adapter 的 ack（§6.2）：journal 提交成功之後才寫；內容只給 adapter 用來清掉已收的事件。
   * 帳本重播不讀它，所以 ack 延遲或重播都不會改變最終狀態。
   */
  async writeAck({ sessionId, writerEpoch, ackedEventSeq, journalSeq }) {
    const path = this.ackPath(sessionId, writerEpoch);
    const expected = await this.io.read(path);
    const body = `${JSON.stringify({ sessionId, writerEpoch, ackedEventSeq, journalSeq })}\n`;
    if (expected === body) return path; // 已經寫過同樣的內容
    try {
      if (expected === null) await this.create(path, body);
      else await this.write(path, body, expected);
    } catch (error) {
      rejectUnlessConflict(error); // 兩個視窗同時寫同一個 epoch 的 ack
      const current = await this.io.read(path);
      if (current === body) return path;
      if (current === null) await this.create(path, body);
      else await this.write(path, body, current);
    }
    return path;
  }

  async readAck(sessionId, writerEpoch) {
    const text = await this.io.read(this.ackPath(sessionId, writerEpoch));
    return text === null ? null : JSON.parse(text);
  }
}
