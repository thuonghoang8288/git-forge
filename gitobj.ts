// gitobj.ts — git object model: SHA-1 ids, loose-object bytes, packfile
// write (no deltas) and read (OFS/REF deltas resolved), pkt-lines, and the
// commit/tree/tag parsers the forge and the suite's client both agree on.
// Stdlib only: node:crypto, node:zlib.

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: sha1("<type> <len>\0<data>"). */
export function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function encodePktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (line === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (line === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole pkt-line stream. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { out.push({ kind: 'flush' }); off += 4; continue; }
    if (head === '0001') { out.push({ kind: 'delim' }); off += 4; continue; }
    if (head === '0002') { out.push({ kind: 'response-end' }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------- object parsing

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Raw header lines (key value), in order, for byte-exact rebuilds. */
  headers: Array<[string, string]>;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const headers: Array<[string, string]> = [];
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    headers.push([key, value]);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message, headers };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  type: ObjType;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    const type: ObjType = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    entries.push({ mode, name, oid, type });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  // Git sorts tree entries by name, directories as if suffixed with '/'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

const PACK_MAX_SIDEBAND = 65000;

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  return { ok: actual === expected, expected, actual };
}

/** Write a packfile (version 2, no deltas) for the given objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    // type+size varint: first byte holds 4 size bits, continuation bytes 7 bits.
    const sizeBytes: number[] = [];
    let remaining = size >> 4;
    let first = (typeNum << 4) | (size & 0x0f);
    while (remaining > 0) {
      sizeBytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining >>= 7;
    }
    sizeBytes.push(first);
    parts.push(Buffer.from(sizeBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

interface RawPackEntry {
  type: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
  version: number;
}

/** Read a packfile, resolving OFS_DELTA and REF_DELTA against the pack itself
 *  (and `resolveBase` for thin packs). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let off = 12;
  const readVarint = (): { value: number; type: number } => {
    let byte = pack[off++];
    const type = (byte >> 4) & 0x07;
    let value = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { value, type };
  };
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const { value: _size, type } = readVarint();
    void _size;
    if (type === 6) {
      // OFS_DELTA: negative offset varint.
      let byte = pack[off++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = start - offset;
      const { data: inflated, consumed } = inflateOne(pack, off);
      off += consumed;
      const entry: RawPackEntry = { type, data: inflated, baseOffset };
      raw.push(entry);
      byOffset.set(start, entry);
    } else if (type === 7) {
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data: inflated, consumed } = inflateOne(pack, off);
      off += consumed;
      const entry: RawPackEntry = { type, data: inflated, baseOid };
      raw.push(entry);
      byOffset.set(start, entry);
    } else {
      const { data: inflated, consumed } = inflateOne(pack, off);
      off += consumed;
      const entry: RawPackEntry = { type, data: inflated };
      raw.push(entry);
      byOffset.set(start, entry);
    }
  }
  // Resolve deltas (recursively, with memoisation).
  const resolved = new Map<number, GitObject>();
  const resolveEntry = (entry: RawPackEntry, start: number): GitObject => {
    if (resolved.has(start)) return resolved.get(start)!;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | undefined;
      if (entry.type === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolveEntry(baseEntry, entry.baseOffset!);
      } else {
        base = resolveBase?.(entry.baseOid!);
        if (!base) {
          // Base may be inside this same pack: find it by oid.
          for (const [offKey, cand] of byOffset) {
            if (cand.type === 6 || cand.type === 7) continue;
            const t = cand.type === 1 ? 'commit' : cand.type === 2 ? 'tree' : cand.type === 3 ? 'blob' : 'tag';
            if (objectId(t as ObjType, cand.data) === entry.baseOid) { base = resolveEntry(cand, offKey); break; }
          }
        }
        if (!base) throw new Error(`ref-delta base ${entry.baseOid} missing`);
      }
      const out = applyDelta(base.data, entry.data);
      const obj: GitObject = { type: base.type, data: out };
      resolved.set(start, obj);
      return obj;
    }
    const type: ObjType = entry.type === 1 ? 'commit' : entry.type === 2 ? 'tree' : entry.type === 3 ? 'blob' : 'tag';
    const obj: GitObject = { type, data: entry.data };
    resolved.set(start, obj);
    return obj;
  };
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  for (const [start, entry] of byOffset) {
    if (entry.type === 6 || entry.type === 7) deltaCount += 1;
    const obj = resolveEntry(entry, start);
    objects.set(objectId(obj.type, obj.data), obj);
  }
  return { objects, deltaCount, declaredCount: count, version };
}

/** Inflate one zlib stream starting at `off`; returns the data and the
 *  input bytes the stream consumed. */
function inflateOne(pack: Buffer, off: number): { data: Buffer; consumed: number } {
  const res = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: number } };
  const n = res.engine?.bytesWritten;
  if (typeof n === 'number' && n > 0 && n <= pack.length - off) return { data: res.buffer, consumed: n };
  // Fallback: binary-search the shortest inflating prefix.
  let lo = 2;
  let hi = pack.length - off;
  try {
    inflateSync(pack.subarray(off));
    return { data: res.buffer, consumed: hi };
  } catch {
    // Not the last entry.
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(off, off + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(pack.subarray(off, off + lo)), consumed: lo };
}

/** Apply a git delta (base size, result size, copy/insert ops) to a base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

/** Split pack bytes into sideband pkt-lines (band 1 = data). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += PACK_MAX_SIDEBAND) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + PACK_MAX_SIDEBAND));
    const framed = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(encodePktLine(framed));
  }
  return out;
}

/** A fresh request id (non-empty, unique). */
export function newRequestId(): string {
  return randomUUID();
}
