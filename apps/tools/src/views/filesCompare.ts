// «Compare» two files (a lazy chunk): identical or different — the size first, then the content a chunk at a time (stopping
// at the first difference), or by checksum where the shell cannot hand out chunks — and, for two small text files, the
// lines that differ as a unified diff with calm tints and a +/− mark (never colour alone).
import { h, icon, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import type { Entry } from './files';

export interface FileHost {
  /** The names in a folder (hidden ones too). */ list(dir: string): Promise<Entry[]>;
  /** The SHA-256 of a file (the shell reads it in chunks on its own side). */ hash(path: string): Promise<string>;
  /** A part of a file (the phone's uriRead), or null where the shell has none. */ read?(path: string, offset: number, max: number): Promise<Uint8Array | null>;
  /** A whole small file (a computer's readFile), for the text diff. */ readSmall?(path: string): Promise<Uint8Array | null>;
}
export type Op = { t: ' ' | '+' | '-'; text: string; a?: number; b?: number };
export const DIFF_MAX_BYTES = 1_000_000;
const CHUNK = 1_048_576;

/** The lines that differ (Myers' O(ND), the common start and end trimmed first); null when there are too many differences to list. */
export function diffLines(a: string[], b: string[], maxD = 1500): Op[] | null {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb); const n = A.length, m = B.length; const max = Math.min(n + m, maxD); const off = max + 1;
  const v = new Int32Array(2 * max + 3); const trace: Int32Array[] = []; let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1; let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x; if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  if (found < 0) return null;
  const mid: Op[] = []; let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const p = trace[d]; const at = (k: number) => p[k + d + 1]; const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1; const px = at(pk), py = px - pk;
    while (x > px && y > py) { mid.push({ t: ' ', text: A[x - 1] }); x--; y--; }
    if (x === px) mid.push({ t: '+', text: B[py] }); else mid.push({ t: '-', text: A[px] });
    x = px; y = py;
  }
  while (x > 0 && y > 0) { mid.push({ t: ' ', text: A[x - 1] }); x--; y--; }
  mid.reverse();
  const ops: Op[] = []; for (let i = 0; i < s; i++) ops.push({ t: ' ', text: a[i] }); ops.push(...mid); for (let i = ea; i < a.length; i++) ops.push({ t: ' ', text: a[i] });
  let la = 0, lb = 0; for (const o of ops) { if (o.t !== '+') o.a = ++la; if (o.t !== '-') o.b = ++lb; }
  return ops;
}
/** Whether bytes read as UTF-8 text (no NUL, valid UTF-8): the lines, or null. */
export function textLines(bytes: Uint8Array): string[] | null {
  const head = bytes.subarray(0, 8192); for (let i = 0; i < head.length; i++) if (head[i] === 0) return null;
  try { const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const lines = s.split(/\r\n|\n|\r/); if (lines.length && lines[lines.length - 1] === '') lines.pop(); return lines; } catch { return null; }
}
/** The diff rows with the unchanged runs far from a change folded into one «N lines unchanged» row. */
export function foldedRows(ops: Op[], ctx = 2): ({ op: Op } | { skip: number })[] {
  const near = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== ' ') for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) near[j] = true; });
  const out: ({ op: Op } | { skip: number })[] = []; let run = 0;
  ops.forEach((o, i) => { if (near[i]) { if (run) { out.push({ skip: run }); run = 0; } out.push({ op: o }); } else run++; });
  if (run) out.push({ skip: run }); return out;
}

/** Compare by content: the first byte that differs (-1: none), reading both a chunk at a time. `stop` is polled between chunks. */
async function sameBytes(host: FileHost, a: Entry, b: Entry, onProgress: (done: number) => void, stop: () => boolean): Promise<number | 'stopped' | 'unknown'> {
  if (!host.read) return 'unknown';
  for (let off = 0; off < a.size; off += CHUNK) {
    if (stop()) return 'stopped';
    const [x, y] = await Promise.all([host.read(a.path, off, CHUNK), host.read(b.path, off, CHUNK)]);
    if (!x || !y) return 'unknown';
    const n = Math.min(x.length, y.length); for (let i = 0; i < n; i++) if (x[i] !== y[i]) return off + i;
    if (x.length !== y.length) return off + n;
    onProgress(Math.min(a.size, off + CHUNK));
  }
  return -1;
}

export async function compareSheet(a: Entry, b: Entry, host: FileHost): Promise<void> {
  let stopped = false; let closed = false; const sh = openSheet(t('filesCompare'), t('close'), { onClose: () => { closed = true; } });
  const file = (e: Entry) => h('div', { class: 'files-cmp-file' }, icon('file'), h('span', { class: 'grow files-main' }, h('span', { dir: 'auto' }, e.name), h('small', { class: 'src', dir: 'auto' }, formatBytes(e.size))));
  const verdict = h('div', { class: 'files-cmp-verdict', role: 'status' }); const bar = h('div', { class: 'files-job-bar' }, h('i')); const prog = h('div', { class: 'files-cmp-prog' }, bar, h('small', { class: 'src files-cmp-meta' }));
  const stop = h('button', { type: 'button', class: 'btn tonal small', onclick: () => { stopped = true; } }, t('cancel'));
  const diffBox = h('div', { class: 'files-cmp-diff', hidden: true, dir: 'ltr' });
  sh.body.append(h('div', { class: 'files-cmp-files' }, file(a), file(b)), verdict, prog, h('div', { class: 'row files-cmp-acts' }, stop), diffBox);
  const say = (ok: boolean, title: string, why: string) => { prog.hidden = true; stop.parentElement?.setAttribute('hidden', ''); verdict.className = `files-cmp-verdict ${ok ? 'same' : 'diff'}`; verdict.replaceChildren(icon(ok ? 'check' : 'swap'), h('span', { class: 'grow' }, h('b', null, title), why ? h('small', { class: 'src' }, why) : null)); };
  const meta = prog.querySelector('.files-cmp-meta') as HTMLElement; const fill = bar.firstChild as HTMLElement;
  verdict.replaceChildren(h('span', { class: 'grow' }, t('filesCompareChecking')));
  const sizesEqual = a.size === b.size;
  let firstDiff: number | 'unknown' | 'stopped' = -2; let identical = false;
  try {
    if (!sizesEqual) { firstDiff = -3; }
    else if (a.size === 0) identical = true;
    else {
      const r = await sameBytes(host, a, b, (d) => { fill.style.width = `${Math.round((d / a.size) * 100)}%`; meta.textContent = `${formatBytes(d)} / ${formatBytes(a.size)}`; }, () => stopped || closed);
      if (r === -1) identical = true; else if (r === 'unknown') {
        // (No chunks from this shell: the checksums, one file at a time; Cancel lets the wait go.)
        meta.textContent = t('filesCompareSumming'); fill.style.width = '40%';
        let iv = 0; const gone = new Promise<never>((_, rej) => { iv = window.setInterval(() => { if (stopped || closed) rej(new Error('stopped')); }, 150); });
        try { const [x, y] = await Promise.race([Promise.all([host.hash(a.path), host.hash(b.path)]), gone]); identical = !!x && x === y; firstDiff = identical ? -1 : 'unknown'; } finally { clearInterval(iv); }
      } else firstDiff = r;
    }
  } catch (e) { if (closed) return; if (stopped || /stopped/.test(String((e as Error).message))) { say(false, t('filesCompareStopped'), ''); return; } say(false, t('filesCompareFailed'), String((e as Error).message ?? e)); return; }
  if (closed) return;
  if (firstDiff === 'stopped') { say(false, t('filesCompareStopped'), ''); return; }
  if (identical) { say(true, t('filesCompareSame'), t('filesCompareSameWhy', { size: formatBytes(a.size) })); return; }
  say(false, t('filesCompareDifferent'), !sizesEqual ? t('filesCompareSizes', { a: formatBytes(a.size), b: formatBytes(b.size) }) : typeof firstDiff === 'number' && firstDiff >= 0 ? t('filesCompareAtByte', { n: localDigits(firstDiff) }) : t('filesCompareContent'));
  // ---- two small text files: the lines
  if (a.size > DIFF_MAX_BYTES || b.size > DIFF_MAX_BYTES) { diffBox.hidden = false; diffBox.replaceChildren(h('p', { class: 'hint', dir: 'auto' }, t('filesCompareTooBig'))); return; }
  const get = async (e: Entry): Promise<Uint8Array | null> => host.readSmall ? host.readSmall(e.path) : host.read ? host.read(e.path, 0, DIFF_MAX_BYTES + 1) : null;
  const [x, y] = await Promise.all([get(a).catch(() => null), get(b).catch(() => null)]); if (closed || !x || !y) return;
  const la = textLines(x), lb = textLines(y); if (!la || !lb) { diffBox.hidden = false; diffBox.replaceChildren(h('p', { class: 'hint', dir: 'auto' }, t('filesCompareNotText'))); return; }
  const ops = diffLines(la, lb); diffBox.hidden = false;
  if (!ops) { diffBox.replaceChildren(h('p', { class: 'hint', dir: 'auto' }, t('filesCompareManyDiffs'))); return; }
  const add = ops.filter((o) => o.t === '+').length, del = ops.filter((o) => o.t === '-').length;
  const rows = foldedRows(ops); const shown = rows.slice(0, 1500);
  diffBox.replaceChildren(h('p', { class: 'files-cmp-count' }, h('span', { class: 'cmp-add-n' }, h('b', { 'aria-hidden': 'true' }, '+'), ' ', t('filesCompareAdded', { n: localDigits(add) })), h('span', { class: 'cmp-del-n' }, h('b', { 'aria-hidden': 'true' }, '−'), ' ', t('filesCompareRemoved', { n: localDigits(del) }))),
    h('div', { class: 'files-cmp-lines' }, ...shown.map((r) => 'skip' in r ? h('div', { class: 'cmp-row skip' }, h('span', { class: 'cmp-no' }), h('span', { class: 'cmp-mark' }), h('span', { class: 'cmp-text', dir: 'auto' }, t('filesCompareSkipped', { n: localDigits(r.skip) })))
      : h('div', { class: `cmp-row ${r.op.t === '+' ? 'add' : r.op.t === '-' ? 'del' : 'eq'}` }, h('span', { class: 'cmp-no' }, String(r.op.t === '+' ? r.op.b : r.op.a)), h('span', { class: 'cmp-mark', 'aria-label': r.op.t === '+' ? t('filesCompareAddedMark') : r.op.t === '-' ? t('filesCompareRemovedMark') : '' }, r.op.t === ' ' ? '' : r.op.t === '+' ? '+' : '−'), h('span', { class: 'cmp-text', dir: 'auto' }, r.op.text || ' ')))),
    ...(rows.length > shown.length ? [h('p', { class: 'hint' }, '…')] : []));
}
