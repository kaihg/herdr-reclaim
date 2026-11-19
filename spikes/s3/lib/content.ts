// S3 spike: content-addressed blob store with chunking + manifest layering (§13.1 內容檔).
//
// - blobs/<hash>.l  : a leaf, exactly the payload bytes (a chunk never exceeds `limit`).
// - blobs/<hash>.m  : a manifest, JSON `{"c":[hashes],"n":bytes}` listing children in order.
// The journal entry references only the top hash; a manifest that would itself exceed the
// limit is chunked again by the same code (recursion), so the depth is data-driven.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite, byteLen, newIoStats, readBuffer, type IoStats } from "./cas";

export const hashOf = (data: Buffer | string): string =>
  crypto.createHash("sha256").update(data).digest("hex").slice(0, 32);

/** Stable JSON (sorted keys) so the same value always hashes to the same blob. */
export function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Split a UTF-8 buffer on codepoint boundaries so every piece is <= limit bytes. */
export function splitBuffer(buf: Buffer, limit: number): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    if (end < buf.length) while (end > start && (buf[end] & 0xc0) === 0x80) end--; // don't cut a codepoint
    out.push(buf.subarray(start, end));
    start = end;
  }
  return out.length ? out : [Buffer.alloc(0)];
}

export interface PutResult {
  hash: string;
  chunked: boolean;
  bytes: number;
  reused: boolean;
  files: number;
  depth: number;
}

export class BlobStore {
  stats: IoStats;
  /** bytes of the largest blob file this store produced */
  maxFileBytes = 0;
  maxFilePath = "";

  constructor(
    readonly dir: string,
    readonly limit = 256 * 1024,
    stats: IoStats = newIoStats(),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.stats = stats;
  }

  private putBuf(buf: Buffer, ext: ".l" | ".m"): { hash: string; reused: boolean } {
    const hash = hashOf(buf);
    const file = path.join(this.dir, hash + ext);
    if (fs.existsSync(file)) {
      this.stats.blobReused++;
      return { hash, reused: true };
    }
    atomicWrite(file, buf);
    this.stats.blobWrites++;
    this.stats.writes++;
    this.stats.bytesWritten += buf.length;
    const size = fs.statSync(file).size;
    if (size > this.maxFileBytes) {
      this.maxFileBytes = size;
      this.maxFilePath = file;
    }
    return { hash, reused: false };
  }

  /** Store arbitrary bytes; chunk + layer until every file is <= limit. */
  put(buf: Buffer): PutResult {
    if (buf.length <= this.limit) {
      const r = this.putBuf(buf, ".l");
      return { hash: r.hash, chunked: false, bytes: buf.length, reused: r.reused, files: 1, depth: 0 };
    }
    const parts = splitBuffer(buf, this.limit);
    const children: PutResult[] = parts.map((p) => this.put(p));
    const manifest = Buffer.from(canonical({ c: children.map((c) => c.hash), n: buf.length }), "utf8");
    const top = this.put(manifest);
    return {
      hash: top.hash,
      chunked: true,
      bytes: buf.length,
      reused: top.reused,
      files: 1 + children.reduce((a, c) => a + c.files, 0),
      depth: 1 + Math.max(...children.map((c) => c.depth)),
    };
  }

  putValue(value: unknown): PutResult {
    return this.put(Buffer.from(canonical(value), "utf8"));
  }

  /** Read a top-level hash back, following manifests. Returns the original bytes. */
  get(hash: string): Buffer {
    const leaf = readBuffer(path.join(this.dir, hash + ".l"));
    if (leaf) return leaf;
    const man = readBuffer(path.join(this.dir, hash + ".m"));
    if (!man) throw new Error(`missing blob ${hash}`);
    const parsed = JSON.parse(man.toString("utf8")) as { c: string[]; n: number };
    const out = Buffer.concat(parsed.c.map((h) => this.get(h)));
    if (out.length !== parsed.n) throw new Error(`blob ${hash}: reassembled ${out.length} != manifest ${parsed.n}`);
    return out;
  }

  getValue(hash: string): unknown {
    return JSON.parse(this.get(hash).toString("utf8"));
  }

  fileCount(): number {
    return fs.readdirSync(this.dir).filter((n) => !n.endsWith(".tmp")).length;
  }
}

export { byteLen };
