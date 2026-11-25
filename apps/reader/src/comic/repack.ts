// A comic in a RAR, 7z or tar archive made into a CBZ — once, when it is added: the pictures are read out of the
// archive in one pass (src/comic/archive.worker.ts) and written, as they come, into a zip that stores them as they are
// (no second compression: a picture is already compressed), built as a Blob of parts — each entry's header, the
// entry's own bytes, then the directory. That zip is what the library keeps, and the reader pages through it lazily
// like any CBZ. Never more in hand than the entry being written. Folders are kept (they are the chapters), pages and a
// ComicInfo.xml are kept, everything else is left out. An archive holding only one archive is opened through (once).
import { sniffArchive, ARCHIVE_NAME, type ArchiveKind } from './archives';

export class RepackError extends Error { constructor(public code: 'nopictures' | 'cancelled' | 'password' | 'memory' | 'failed', message?: string) { super(message ?? code); } }

/* ---------- the zip written ---------- */

const u16 = (v: DataView, o: number, n: number) => v.setUint16(o, n, true);
const u32 = (v: DataView, o: number, n: number) => v.setUint32(o, n >>> 0, true);
const enc = new TextEncoder();
interface Done { name: Uint8Array; crc: number; size: number; offset: number }

/** A zip that stores its entries; parts are Blobs (the browser may keep them off the heap), Zip64 when it must. */
export class StoredZip {
  private parts: BlobPart[] = []; private done: Done[] = []; private offset = 0;
  private stamp = (() => { const d = new Date(); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; })();
  add(path: string, data: Blob, crc: number): void {
    const name = enc.encode(path); const h = new DataView(new ArrayBuffer(30));
    u32(h, 0, 0x04034b50); u16(h, 4, 20); u16(h, 6, 0x0800); u16(h, 8, 0); u16(h, 10, this.stamp.time); u16(h, 12, this.stamp.date);
    u32(h, 14, crc); u32(h, 18, data.size); u32(h, 22, data.size); u16(h, 26, name.length); u16(h, 28, 0);
    this.parts.push(h.buffer, name as unknown as BlobPart, data);
    this.done.push({ name, crc, size: data.size, offset: this.offset });
    this.offset += 30 + name.length + data.size;
  }
  get count(): number { return this.done.length; }
  finish(): Blob {
    const cdStart = this.offset; const dir: BlobPart[] = []; let cdSize = 0;
    for (const e of this.done) {
      const big = e.offset >= 0xffffffff; const extra = big ? 12 : 0;
      const h = new DataView(new ArrayBuffer(46));
      u32(h, 0, 0x02014b50); u16(h, 4, big ? 45 : 20); u16(h, 6, big ? 45 : 20); u16(h, 8, 0x0800); u16(h, 10, 0); u16(h, 12, this.stamp.time); u16(h, 14, this.stamp.date);
      u32(h, 16, e.crc); u32(h, 20, e.size); u32(h, 24, e.size); u16(h, 28, e.name.length); u16(h, 30, extra); u16(h, 32, 0); u16(h, 34, 0); u16(h, 36, 0); u32(h, 38, 0);
      u32(h, 42, big ? 0xffffffff : e.offset);
      dir.push(h.buffer, e.name as unknown as BlobPart); cdSize += 46 + e.name.length;
      if (big) { const x = new DataView(new ArrayBuffer(12)); u16(x, 0, 1); u16(x, 2, 8); x.setBigUint64(4, BigInt(e.offset), true); dir.push(x.buffer); cdSize += 12; }
    }
    const n = this.done.length; const needZip64 = n >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (needZip64) {
      const r = new DataView(new ArrayBuffer(56 + 20));
      u32(r, 0, 0x06064b50); r.setBigUint64(4, 44n, true); u16(r, 12, 45); u16(r, 14, 45); u32(r, 16, 0); u32(r, 20, 0);
      r.setBigUint64(24, BigInt(n), true); r.setBigUint64(32, BigInt(n), true); r.setBigUint64(40, BigInt(cdSize), true); r.setBigUint64(48, BigInt(cdStart), true);
      u32(r, 56, 0x07064b50); u32(r, 60, 0); r.setBigUint64(64, BigInt(cdStart + cdSize), true); u32(r, 72, 1);
      dir.push(r.buffer);
    }
    const end = new DataView(new ArrayBuffer(22));
    u32(end, 0, 0x06054b50); u16(end, 4, 0); u16(end, 6, 0); u16(end, 8, needZip64 ? 0xffff : n); u16(end, 10, needZip64 ? 0xffff : n);
    u32(end, 12, needZip64 ? 0xffffffff : cdSize); u32(end, 16, needZip64 ? 0xffffffff : cdStart); u16(end, 20, 0);
    dir.push(end.buffer);
    return new Blob([...this.parts, ...dir], { type: 'application/vnd.comicbook+zip' });
  }
}

/* ---------- the worker's end ---------- */

type Msg = { id: number; op: 'scanned'; entries: { path: string; size: number }[]; encrypted: boolean | null } | { id: number; op: 'entry'; path: string; crc: number; data: ArrayBuffer } | { id: number; op: 'done'; peakMB: number } | { id: number; op: 'error'; code: string; message: string };

class Lane {
  worker: Worker | null = null; private seq = 0; private on: ((m: Msg) => void) | null = null; private dead: ((e: Error) => void) | null = null;
  start(): void {
    this.worker = new Worker(new URL('./archiveworker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Msg>) => this.on?.(e.data);
    this.worker.onerror = (e) => { this.dead?.(new RepackError('failed', e.message || 'worker')); };
  }
  stop(): void { this.worker?.terminate(); this.worker = null; this.on = null; this.dead?.(new RepackError('cancelled')); this.dead = null; }
  /** Send a job; `each` sees every message of it (an extraction sends many), until the one that ends it. */
  run(msg: Record<string, unknown>, each: (m: Msg) => Promise<void> | void): Promise<Msg> {
    const id = ++this.seq; const w = this.worker; if (!w) return Promise.reject(new RepackError('cancelled'));
    return new Promise<Msg>((resolve, reject) => {
      this.dead = reject; let chain: Promise<void> = Promise.resolve();
      this.on = (m) => {
        if (m.id !== id) return;
        if (m.op === 'entry') { chain = chain.then(async () => { await each(m); w.postMessage({ op: 'next' }); }).catch((e) => { this.on = null; reject(e); }); return; }
        chain = chain.then(() => { this.on = null; if (m.op === 'error') reject(new RepackError(m.code === 'password' ? 'password' : m.code === 'memory' ? 'memory' : 'failed', m.message)); else resolve(m); });
      };
      w.postMessage({ ...msg, id });
    });
  }
}

export interface RepackOptions {
  /** Pages read so far, of how many. */
  progress(done: number, total: number): void;
  /** Asked when the archive wants a password (`wrong`: the last one did not fit); null: given up. Never kept. */
  password(wrong: boolean): Promise<string | null>;
  /** Called with the function that gives the work up (the worker stopped, nothing kept). */
  onCancel?(cancel: () => void): void;
}
export interface Repacked { blob: Blob; label: string; pages: number; peakMB: number }

const PAGE_OR_INFO = /(^|\/)comicinfo\.xml$/i;
/** The archive made into a stored zip. Rejects with a RepackError ('nopictures', 'cancelled', 'password', 'memory', 'failed'). */
export async function repackToCbz(file: Blob, name: string, kind: ArchiveKind, o: RepackOptions, depth = 0): Promise<Repacked> {
  const { isPageEntry } = await import('./pages');
  const lane = new Lane(); let cancelled = false;
  o.onCancel?.(() => { cancelled = true; lane.stop(); });
  try {
    lane.start();
    let password: string | null = null; let wrong = false;
    let scan: Extract<Msg, { op: 'scanned' }> | null = null;
    for (;;) {
      try { scan = (await lane.run({ op: 'scan', file, password }, () => undefined)) as Extract<Msg, { op: 'scanned' }>; }
      catch (e) {
        // (A header that is itself protected says so only when read: asked for the word, then again.)
        if ((e as RepackError).code !== 'password') throw e;
        const pw = await o.password(wrong); if (pw === null) throw new RepackError('cancelled'); password = pw; wrong = true; continue;
      }
      // (A protected archive with no word yet: asked now rather than at the first picture.)
      if (scan.encrypted && password === null) { const pw = await o.password(false); if (pw === null) throw new RepackError('cancelled'); password = pw; }
      if (!scan.entries.length && password === null && kind.kind !== 'tar') { const pw = await o.password(false); if (pw === null) throw new RepackError('cancelled'); password = pw; continue; }
      break;
    }
    const entries = scan.entries;
    const pages = entries.filter((e) => isPageEntry(e.path)); const info = entries.find((e) => PAGE_OR_INFO.test(e.path) && !e.path.split('/').some((s) => s.startsWith('.') || s === '__MACOSX'));
    // (Nothing but one archive inside: opened through, once.)
    if (!pages.length) {
      const files = entries.filter((e) => !e.path.split('/').some((s) => s.startsWith('.') || s === '__MACOSX' || /^(thumbs\.db|desktop\.ini)$/i.test(s)));
      if (depth === 0 && files.length === 1 && ARCHIVE_NAME.test(files[0].path)) {
        let inner: Blob | null = null;
        await runExtract([files[0].path], async (_p, data) => { inner = new Blob([data]); });
        if (inner) {
          lane.stop(); const innerName = files[0].path.split('/').pop() as string; const ik = await sniffArchive(inner, innerName);
          if (ik && ik.kind === 'zip') { const { zipIsProtected } = await import('./pages'); if (!(await zipIsProtected(inner))) { const dir = await import('./pages').then((m) => m.openPages(inner as Blob, 'cbz', innerName)); const n = dir.pages.length; dir.dispose(); if (n) return { blob: inner, label: kind.label, pages: n, peakMB: 0 }; throw new RepackError('nopictures'); } }
          if (ik) return repackToCbz(inner, innerName, ik, o, 1);
        }
      }
      throw new RepackError('nopictures');
    }
    const wanted = [...pages.map((p) => p.path), ...(info ? [info.path] : [])];
    const zip = new StoredZip(); let n = 0;
    o.progress(0, pages.length);
    const done = await runExtract(wanted, async (p, data, crc) => {
      zip.add(p, new Blob([data]), crc);
      if (isPageEntry(p)) o.progress(++n, pages.length);
    });
    if (!n) throw new RepackError('nopictures');
    return { blob: zip.finish(), label: kind.label, pages: n, peakMB: done };

    /** Extract `paths`; asks (again) for a password when the first picture does not come out; returns the wasm heap's peak. */
    async function runExtract(paths: string[], take: (path: string, data: ArrayBuffer, crc: number) => Promise<void> | void): Promise<number> {
      for (;;) {
        let got = 0;
        try {
          const end = await lane.run({ op: 'extract', wanted: paths, password }, async (m) => { if (m.op !== 'entry') return; got++; await take(m.path, m.data, m.crc); });
          return (end as Extract<Msg, { op: 'done' }>).peakMB;
        } catch (e) {
          // (A word that does not fit: nothing has come out yet — the pictures are read with it; asked again.)
          if (got === 0 && scan?.encrypted && password !== null && (e as RepackError).code !== 'cancelled' && (e as RepackError).code !== 'memory') {
            const pw = await o.password(true); if (pw === null) throw new RepackError('cancelled'); password = pw; continue;
          }
          if ((e as RepackError).code === 'password') { const pw = await o.password(password !== null); if (pw === null) throw new RepackError('cancelled'); password = pw; continue; }
          throw e;
        }
      }
    }
  } catch (e) {
    if (cancelled) throw new RepackError('cancelled');
    throw e instanceof RepackError ? e : new RepackError('failed', String((e as Error)?.message ?? e));
  } finally { lane.stop(); }
}
