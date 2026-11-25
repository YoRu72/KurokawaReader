// A comic in a RAR, 7z or tar archive, read off the page's thread (libarchive.js's wasm: libarchive, BSD 2-Clause; the
// library itself MIT). Two jobs, sent by src/comic/repack.ts:
//   scan     the archive is loaded into the wasm heap (in slices — never twice in memory) and its entries listed (nothing
//            decompressed), with whether it is protected;
//   extract  the wanted entries, one at a time, each handed over (moved, not copied) with its CRC-32 and the next one
//            waited for until the page says it has taken it — so no more than one picture is ever in hand here.
// The library's own worker keeps every extracted entry until the end and copies them all across: not used for that reason.
import { ArchiveReader } from 'libarchive.js/src/webworker/archive-reader.js';
import { WasmModule } from 'libarchive.js/src/webworker/wasm-module.js';
import libarchive from 'libarchive.js/src/webworker/wasm-gen/libarchive.js';

const ctx = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const wm = Object.assign(new WasmModule(), { locateFile: (name: string) => new URL('libarchive/' + name, import.meta.url).href });
const ready = libarchive(wm).then((m) => { m.initFunctions(); return m; });
let reader: ArchiveReader | null = null;
let peak = 0;

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b: Uint8Array): number => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

async function load(file: Blob): Promise<ArchiveReader> {
  const mod = await ready;
  if (reader) { if (reader._archive) reader._runCode.closeArchive(reader._archive); if (reader._filePtr) reader._runCode.free(reader._filePtr); reader = null; }
  const r = new ArchiveReader(mod); const ptr = r._runCode.malloc(file.size);
  if (!ptr) throw Object.assign(new Error('memory'), { code: 'memory' });
  // (Slices of 8 MB: the heap's view is read again after each, as the heap may have grown.)
  for (let at = 0; at < file.size; at += 8 << 20) { const part = new Uint8Array(await file.slice(at, Math.min(file.size, at + (8 << 20))).arrayBuffer()); (r._wasmModule as unknown as { HEAPU8: Uint8Array }).HEAPU8.set(part, ptr + at); }
  r._filePtr = ptr; r._fileLength = file.size; reader = r; peak = Math.max(peak, mod.HEAPU8.length);
  return r;
}

const PASS = /pass|encrypt|decrypt/i;
/** Open the archive again (from the first entry) and walk it: `take(entry)` says whether to read its data. */
function* walk(r: ArchiveReader, password: string | null, take: (path: string) => boolean): Generator<{ path: string; size: number; data?: Uint8Array }> {
  const rc = r._runCode; const mod = r._wasmModule;
  if (r._archive) rc.closeArchive(r._archive);
  const a = rc.openArchive(r._filePtr as number, r._fileLength, password, 'en_US.UTF-8'); r._archive = a;
  if (!a) throw Object.assign(new Error('notArchive'), { code: 'failed' });
  for (;;) {
    const e = rc.getNextEntry(a);
    if (!e) { const why = rc.getError(a); if (why && PASS.test(why)) throw Object.assign(new Error(why), { code: 'password' }); break; }
    // (Regular files only: 32768 is a file, 16384 a folder.)
    if (rc.getEntryType(e) !== 32768) { rc.skipEntry(a); continue; }
    const path = rc.getEntryName(e); const size = rc.getEntrySize(e);
    if (!take(path) || size <= 0) { rc.skipEntry(a); yield { path, size }; continue; }
    const ptr = rc.getFileData(a, size);
    if (ptr < 0) throw Object.assign(new Error(rc.getError(a) || 'read'), { code: PASS.test(rc.getError(a) ?? '') ? 'password' : 'read' });
    const data = mod.HEAPU8.slice(ptr, ptr + size); rc.free(ptr);
    peak = Math.max(peak, mod.HEAPU8.length);
    yield { path, size, data };
  }
}

let go: (() => void) | null = null;
const fail = (id: number, e: unknown) => { const code = (e as { code?: string })?.code; ctx.postMessage({ id, op: 'error', code: code ?? 'failed', message: String((e as Error)?.message ?? e) }); };

ctx.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { op: string; id: number; file?: Blob; password?: string | null; wanted?: string[] };
  if (m.op === 'next') { go?.(); return; }
  try {
    if (m.op === 'scan') {
      const r = await load(m.file as Blob);
      const entries: { path: string; size: number }[] = [];
      for (const e of walk(r, m.password ?? null, () => false)) entries.push({ path: e.path, size: e.size });
      // (Protected: said by the format once an entry has been read — a header, with a zip or a 7z.)
      let enc: number | null = null;
      if (r._archive) { r._runCode.closeArchive(r._archive); r._archive = null; }
      const a = r._runCode.openArchive(r._filePtr as number, r._fileLength, m.password ?? null, 'en_US.UTF-8'); r._archive = a;
      if (a) { r._runCode.getNextEntry(a); enc = r._runCode.hasEncryptedEntries(a); }
      ctx.postMessage({ id: m.id, op: 'scanned', entries, encrypted: enc === null ? null : enc > 0 });
    } else if (m.op === 'extract') {
      const r = reader; if (!r) throw new Error('not loaded');
      const want = new Set(m.wanted); let n = 0;
      for (const e of walk(r, m.password ?? null, (p) => want.has(p))) {
        if (!e.data) continue;
        const crc = crc32(e.data); const buf = e.data.buffer as ArrayBuffer;
        ctx.postMessage({ id: m.id, op: 'entry', path: e.path, crc, data: buf, n: ++n }, [buf]);
        await new Promise<void>((res) => { go = res; });
      }
      ctx.postMessage({ id: m.id, op: 'done', peakMB: Math.round(peak / 1048576) });
    }
  } catch (e) { fail(m.id, e); }
};
