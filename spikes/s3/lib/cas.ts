// S3 spike: emulation of herdr's `writeTextFile(path, text, expected)` CAS.
//
// The real call (herdr.d.ts:30-32) is server-side: it rejects on a stale snapshot and
// replaces the file atomically. To reproduce that here we guard read-compare-rename with an
// exclusive mkdir lock, so "compare" and "swap" cannot interleave (that is exactly what the
// server gives us). Writers that hold a *stale* expected text must lose the CAS, which is
// what the concurrency tests force by re-reading the snapshot then waiting before writing.
import fs from "node:fs";
import path from "node:path";

export interface IoStats {
  casAttempts: number;
  casFailures: number;
  writes: number;
  bytesWritten: number;
  reads: number;
  bytesRead: number;
  creates: number;
  seals: number;
  translations: number;
  blobWrites: number;
  blobReused: number;
}

export const newIoStats = (): IoStats => ({
  casAttempts: 0,
  casFailures: 0,
  writes: 0,
  bytesWritten: 0,
  reads: 0,
  bytesRead: 0,
  creates: 0,
  seals: 0,
  translations: 0,
  blobWrites: 0,
  blobReused: 0,
});

export const byteLen = (text: string): number => Buffer.byteLength(text, "utf8");

/** Synchronous sleep (Atomics.wait needs integer ms; 0 would mean "wait forever"). */
export function sleepMs(ms: number): void {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, Math.max(1, Math.round(ms)));
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readBuffer(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export function atomicWrite(file: string, data: string | Buffer, fsync = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data as never);
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Create-only (herdr's `expected: null`). O_EXCL, so two racers never both win. */
export function createExclusive(file: string, text: string, opts: { fsync?: boolean; stats?: IoStats } = {}): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (opts.stats) {
    opts.stats.casAttempts++;
    opts.stats.creates++;
  }
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeSync(fd, text);
      if (opts.fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (opts.stats) {
      opts.stats.writes++;
      opts.stats.bytesWritten += byteLen(text);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (opts.stats) opts.stats.casFailures++;
      return false;
    }
    throw err;
  }
}

const lockDirOf = (file: string) => `${file}.lock`;

/** Exclusive lock for the critical section of one CAS (cross-process via mkdir). */
export function acquire(file: string, timeoutMs = 30_000, staleMs = 20_000): void {
  const dir = lockDirOf(file);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const start = Date.now();
  for (let spin = 0; ; spin++) {
    try {
      fs.mkdirSync(dir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(dir);
        if (Date.now() - st.mtimeMs > staleMs) {
          try {
            fs.rmdirSync(dir);
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`CAS lock timeout: ${dir}`);
      // 40 busy retries (no syscall sleep), then back off to 1 ms / 4 ms.
      if (spin > 40) sleepMs(spin > 300 ? 4 : 1);
    }
  }
}

export function release(file: string): void {
  try {
    fs.rmdirSync(lockDirOf(file));
  } catch {}
}

/** herdr's writeTextFile: swap only if the current text still equals `expected`. */
export function casWrite(
  file: string,
  text: string,
  expected: string | null,
  opts: { fsync?: boolean; stats?: IoStats } = {},
): boolean {
  if (expected === null) return createExclusive(file, text, opts);
  const stats = opts.stats;
  if (stats) stats.casAttempts++;
  acquire(file);
  try {
    const cur = stats ? readTextCounted(file, stats) : readText(file);
    if (cur === null || cur !== expected) {
      if (stats) stats.casFailures++;
      return false;
    }
    atomicWrite(file, text, opts.fsync);
    if (stats) {
      stats.writes++;
      stats.bytesWritten += byteLen(text);
    }
    return true;
  } finally {
    release(file);
  }
}

export function readTextCounted(file: string, stats: IoStats): string | null {
  const text = readText(file);
  stats.reads++;
  if (text !== null) stats.bytesRead += byteLen(text);
  return text;
}
