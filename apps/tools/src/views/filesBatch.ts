// Renaming many files at once — the pure side (tests/filesnames.cjs runs it in node): a recipe (name, number, extension,
// clash policy) turned into the list «old → new» with each row's problems, the steps that carry it out without ever
// putting a file over another (a name freed first; a swap or a ring by way of a hidden temporary name in the same
// folder), the run itself against any storage that can rename one item (`IO`), a journal written before the first rename
// so a run cut short can be finished or taken back, and the Undo (the same engine, the names the other way). Planned
// here so that it can move behind a native «rename» job unchanged.
import { splitExt } from './filesNames';
import { clipName } from '../downloads/direct';
import NAMES from '../../desktop/namesafe.json';

export type BItem = { path: string; name: string; dir: boolean; size: number; mtime: number };
export type NameMode = 'keep' | 'replace' | 'before' | 'after' | 'pattern';
export type ExtMode = 'keep' | 'set' | 'add' | 'remove' | 'lower' | 'upper';
export type NumOrder = 'selected' | 'sort' | 'name' | 'date';
export type ClashPolicy = 'stop' | 'skip' | 'number';
export type Recipe = {
  nameMode: NameMode; nameText: string;
  find: string; replace: string; regex: boolean; matchCase: boolean;
  /** `case`: lower / upper / title; `spaces`: spaces → underscores or underscores → spaces. */
  tf: { case: '' | 'lower' | 'upper' | 'title'; trim: boolean; collapse: boolean; spaces: '' | 'toUnderscore' | 'toSpace'; tags: boolean };
  num: { on: boolean; start: number; step: number; pad: number; /** 0: from the count */ end: number | null; pos: 'before' | 'after'; sep: string; order: NumOrder };
  ext: { mode: ExtMode; value: string };
  clash: ClashPolicy;
};
export const defaultRecipe = (order: NumOrder = 'sort'): Recipe => ({
  nameMode: 'keep', nameText: '', find: '', replace: '', regex: false, matchCase: false,
  tf: { case: '', trim: false, collapse: false, spaces: '', tags: false },
  num: { on: false, start: 1, step: 1, pad: 0, end: null, pos: 'after', sep: ' - ', order },
  ext: { mode: 'keep', value: '' }, clash: 'stop',
});
export type Flags = {
  unchanged?: boolean; empty?: boolean; clashExisting?: boolean; clashResult?: boolean; illegal?: boolean; tooLong?: boolean; hidden?: boolean;
  /** A folder asked for an extension: left without one. */ folderExt?: boolean; /** The clash policy settled it (skipped, or numbered). */ resolved?: 'skip' | 'number'; kindChange?: boolean;
};
export type Row = { i: number; item: BItem; dir: string; from: string; to: string; /** 1-based place in the order picked. */ picked: number; /** The number given (or 0). */ num: number; flags: Flags; action: 'rename' | 'skip' };
export type Plan = {
  rows: Row[]; error: string; /** To rename, left as they are (unchanged, skipped), with a blocking problem, with a warning. */ summary: { rename: number; skipped: number; blocking: number; warnings: number; unchanged: number };
  last: number; padW: number; folderExt: string[]; kindChanges: number; endShort: boolean;
};
export type Ctx = { existing?: (dir: string) => Set<string> | undefined; sortIndex?: Map<string, number>; fmtSize?: (n: number) => string; now?: number };

// (The characters no portable name holds: the one name table's set, desktop/namesafe.json, and the control characters.)
const ILLEGAL = new RegExp(`[${NAMES.portableIllegal.replace(/[\\\]^-]/g, '\\$&')}\\u0000-\\u001f]+`, 'g');
const lc = (s: string): string => s.toLowerCase();
export const dirOf = (p: string): string => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : i === 0 ? '/' : p.slice(0, i); };
export const joinPath = (dir: string, name: string): string => (!dir ? name : dir === '/' ? `/${name}` : `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`);
const pad = (n: number, w: number): string => { const s = String(Math.abs(n)).padStart(w, '0'); return n < 0 ? `-${s}` : s; };
const ymd = (x: Date): string => `${x.getFullYear()}-${pad(x.getMonth() + 1, 2)}-${pad(x.getDate(), 2)}`;
const hm = (x: Date): string => `${pad(x.getHours(), 2)}${pad(x.getMinutes(), 2)}`;
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The kinds an extension says (for the «this does not convert» warning); text covers subtitles. */
const KIND_OF: [string, RegExp][] = [['image', /^(jpe?g|png|gif|webp|bmp|heic|heif|avif|svg|tiff?|ico|jfif|apng)$/i], ['audio', /^(mp3|m4a|flac|ogg|opus|wav|aac|wma|mka)$/i], ['video', /^(mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv|3gp)$/i], ['text', /^(txt|md|log|nfo|ass|ssa|srt|vtt|sub|json|xml|csv|ini|cfg|lrc)$/i], ['doc', /^(pdf|epub|mobi|azw3?|docx?|xlsx?|pptx?|rtf|odt|cbz|cbr)$/i], ['archive', /^(zip|7z|rar|tar|gz|tgz|xz|bz2|zst)$/i], ['app', /^(apk|apks|xapk|apkm)$/i]];
export const extKind = (ext: string): string => { const last = ext.split('.').pop() ?? ''; return KIND_OF.find(([, re]) => re.test(last))?.[0] ?? 'other'; };
/** The usual endings offered for the kinds in a selection. */
export const EXT_CHIPS: Record<string, string[]> = { image: ['jpg', 'png', 'webp'], text: ['ass', 'srt', 'vtt', 'txt', 'md'], video: ['mkv', 'mp4'], audio: ['mp3', 'flac', 'm4a'] };
export const chipsFor = (items: BItem[]): string[] => { const kinds = new Set<string>(); for (const it of items) if (!it.dir) kinds.add(extKind(splitExt(it.name)[1])); const out: string[] = []; for (const k of ['image', 'text', 'video', 'audio']) if (kinds.has(k)) out.push(...EXT_CHIPS[k]); return out.length ? out : ['txt', 'jpg', 'mp4']; };
/** An extension as typed made fit: no leading dots, no spaces or forbidden characters. */
export const cleanExt = (v: string): string => v.replace(ILLEGAL, '').replace(/\s+/g, '').replace(/^\.+/, '').replace(/\.+$/, '');

const title = (s: string): string => s.toLowerCase().replace(/(^|[\s_\-.(\[{])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
const stripTags = (s: string): string => s.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g, '');

/** The order the numbers follow: the rank (0-based) of each item. */
function ranks(items: BItem[], order: NumOrder, sortIndex?: Map<string, number>): number[] {
  const n = items.length; const idx = items.map((_, i) => i);
  if (order === 'selected') return idx;
  const col = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const cmp = order === 'name' ? (a: number, b: number) => col.compare(items[a].name, items[b].name) || a - b
    : order === 'date' ? (a: number, b: number) => (items[a].mtime - items[b].mtime) || col.compare(items[a].name, items[b].name) || a - b
      : (a: number, b: number) => ((sortIndex?.get(items[a].path) ?? a) - (sortIndex?.get(items[b].path) ?? b)) || a - b;
  const sorted = idx.slice().sort(cmp); const r = new Array<number>(n); sorted.forEach((x, k) => { r[x] = k; }); return r;
}
export const lastNumber = (count: number, r: Recipe['num']): number => r.start + Math.max(0, count - 1) * r.step;
export const padWidth = (count: number, r: Recipe['num']): number => (r.pad > 0 ? r.pad : String(Math.max(Math.abs(r.start), Math.abs(lastNumber(count, r)), Math.abs(r.end ?? 0))).length);

/** The text of `pattern` with its tokens: {name} {ext} {name.ext} {n} {n:3} {size} {date} {time} {now}. */
function expand(pattern: string, it: BItem, stem: string, ext: string, numStr: string, w: number, ctx: Ctx): string {
  const d = new Date(it.mtime); const now = new Date(ctx.now ?? Date.now()); const fmt = ctx.fmtSize ?? String;
  return pattern.replace(/\{n(?::(\d))?\}/g, (_, x) => (x ? pad(Number(numStr), Number(x)) : pad(Number(numStr), w))).replace(/\{name\.ext\}/g, it.name).replace(/\{name\}/g, stem).replace(/\{ext\}/g, ext).replace(/\{size\}/g, fmt(it.size).replace(/\s/g, '')).replace(/\{date\}/g, ymd(d)).replace(/\{time\}/g, hm(d)).replace(/\{now\}/g, ymd(now));
}
/** What the find-and-replace asks for, or an error text (a regular expression that does not parse). */
function finder(r: Recipe): { re: RegExp | null; error: string } {
  if (!r.find) return { re: null, error: '' };
  try { return { re: new RegExp(r.regex ? r.find : escRe(r.find), r.matchCase ? 'g' : 'gi'), error: '' }; } catch (e) { return { re: null, error: String((e as Error).message ?? e) }; }
}

/** The new name of one item, before the storage's rules (cleanName) and before clashes. */
function compose(it: BItem, k: number, r: Recipe, re: RegExp | null, w: number, ctx: Ctx): { stem: string; ext: string; whole: boolean; folderExt: boolean } {
  const [stem0, ext0] = splitExt(it.name, it.dir); const nv = r.num.start + k * r.num.step; const numStr = String(nv);
  let stem = stem0; let whole = false; const hasN = r.nameMode === 'pattern' && /\{n(?::\d)?\}/.test(r.nameText);
  if (r.nameMode === 'replace') stem = r.nameText; else if (r.nameMode === 'before') stem = r.nameText + stem0; else if (r.nameMode === 'after') stem = stem0 + r.nameText;
  else if (r.nameMode === 'pattern') { const own = /\{(ext|name\.ext)\}/.test(r.nameText); stem = expand(r.nameText, it, stem0, ext0, numStr, w, ctx); whole = own && !it.dir; }
  if (re) stem = r.regex ? stem.replace(re, r.replace) : stem.replace(re, () => r.replace);
  const f = r.tf;
  if (f.tags) stem = stripTags(stem);
  if (f.spaces === 'toUnderscore') stem = stem.replace(/\s+/g, '_'); else if (f.spaces === 'toSpace') stem = stem.replace(/_/g, ' ');
  if (f.collapse) stem = stem.replace(/\s{2,}/g, ' ');
  if (f.trim) stem = stem.trim();
  if (f.case === 'lower') stem = stem.toLowerCase(); else if (f.case === 'upper') stem = stem.toUpperCase(); else if (f.case === 'title') stem = title(stem);
  if (r.num.on && !hasN) { const ns = pad(nv, w); stem = !stem ? ns : r.num.pos === 'before' ? ns + r.num.sep + stem : stem + r.num.sep + ns; }
  let ext = ext0; let folderExt = false;
  if (it.dir) folderExt = r.ext.mode !== 'keep';
  else { const v = cleanExt(r.ext.value); switch (r.ext.mode) { case 'set': if (v) ext = v; break; case 'add': if (v) ext = ext0 ? `${ext0}.${v}` : v; break; case 'remove': ext = ''; break; case 'lower': ext = ext0.toLowerCase(); break; case 'upper': ext = ext0.toUpperCase(); break; default: break; } }
  return { stem, ext, whole, folderExt };
}

/** The list «old → new» for `items` (in the order they were picked) by `r`. */
export function planBatch(items: BItem[], r: Recipe, ctx: Ctx = {}): Plan {
  const n = items.length; const w = padWidth(n, r.num); const rk = ranks(items, r.num.order, ctx.sortIndex); const fd = finder(r);
  const rows: Row[] = []; const folderExt: string[] = []; let kindChanges = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i]; const c = compose(it, rk[i], r, fd.re, w, ctx); const flags: Flags = {}; const dir = dirOf(it.path);
    let to: string;
    const raw = c.whole ? c.stem : c.stem + (c.ext ? `.${c.ext}` : '');
    if (raw === it.name) to = it.name;
    else {
      const clean = (s: string) => s.replace(ILLEGAL, ' '); let stem = c.stem; let ext = c.ext;
      if (c.whole) { const x = clean(stem); if (x !== stem) flags.illegal = true; stem = x.replace(/^\s+/, '').replace(/[\s.]+$/, ''); ext = ''; }
      else { const x = clean(stem); const y = clean(ext).replace(/\s+/g, ''); if (x !== stem || y !== ext) flags.illegal = true; stem = x.replace(/^\s+/, '').replace(/[\s.]+$/, ''); ext = y; }
      to = !stem && !ext ? '' : stem + (ext ? `.${ext}` : '');
      if (to === '.' || to === '..') to = '';
      if (!to) flags.empty = true;
      else if (new TextEncoder().encode(to).length > 255) { to = clipName(to, 255); flags.tooLong = true; }
    }
    if (to === it.name) flags.unchanged = true;
    if (to && to.startsWith('.') && !it.name.startsWith('.')) flags.hidden = true;
    if (c.folderExt) { flags.folderExt = true; folderExt.push(it.name); }
    if (!it.dir && to && (r.ext.mode === 'set' || r.ext.mode === 'add')) { const a = extKind(splitExt(it.name)[1]); const b = extKind(splitExt(to)[1]); if (a !== 'other' && b !== 'other' && a !== b) { flags.kindChange = true; kindChanges++; } }
    rows.push({ i, item: it, dir, from: it.name, to, picked: i + 1, num: r.num.on ? r.num.start + rk[i] * r.num.step : 0, flags, action: flags.unchanged || flags.empty ? 'skip' : 'rename' });
  }
  settle(rows, r.clash, ctx);
  const sum = { rename: 0, skipped: 0, blocking: 0, warnings: 0, unchanged: 0 };
  for (const x of rows) { if (x.action === 'rename') sum.rename++; else if (x.flags.unchanged) sum.unchanged++; else sum.skipped++; if (blocks(x, r.clash)) sum.blocking++; else if (x.flags.illegal || x.flags.tooLong || x.flags.hidden || x.flags.resolved) sum.warnings++; }
  const last = lastNumber(n, r.num);
  return { rows, error: fd.error, summary: sum, last, padW: w, folderExt, kindChanges, endShort: r.num.on && r.num.end !== null && r.num.end < last };
}
/** A row that holds the rename back (a name that is nothing; a clash the policy «stop» does not settle). */
export const blocks = (x: Row, policy: ClashPolicy): boolean => !!x.flags.empty || (policy === 'stop' && !!(x.flags.clashExisting || x.flags.clashResult));

/** Clashes with the folder's own names and with each other; a name freed by another item's rename is not a clash (swaps, chains). */
function settle(rows: Row[], policy: ClashPolicy, ctx: Ctx): void {
  const byDir = new Map<string, Row[]>(); for (const x of rows) { const a = byDir.get(x.dir); if (a) a.push(x); else byDir.set(x.dir, [x]); }
  for (const [dir, rs] of byDir) {
    const have = new Set<string>(ctx.existing?.(dir) ?? []); for (const x of rs) have.add(lc(x.from));
    // (A row that stays or is skipped keeps its name; one that goes frees it. A skip makes its name held again: looked at once more.)
    for (let pass = 0; pass < 30; pass++) {
      const held = new Set<string>(have); for (const x of rs) if (x.action === 'rename') held.delete(lc(x.from));
      let again = false; const claimed = new Map<string, Row>();
      for (const x of rs) {
        x.flags.clashExisting = x.flags.clashResult = undefined; if (x.action !== 'rename') continue; const k = lc(x.to);
        const other = claimed.get(k);
        if (held.has(k)) x.flags.clashExisting = true; else if (other) { x.flags.clashResult = true; if (policy === 'stop') other.flags.clashResult = true; }
        else claimed.set(k, x);
        if (!x.flags.clashExisting && !x.flags.clashResult) continue;
        if (policy === 'skip') { x.action = 'skip'; x.flags.resolved = 'skip'; x.flags.clashExisting = x.flags.clashResult = undefined; again = true; }
        else if (policy === 'number') {
          const [s, e] = splitExt(x.to, x.item.dir); let j = 2; let cand = ''; do { cand = `${s} (${j++})${e ? `.${e}` : ''}`; } while (held.has(lc(cand)) || claimed.has(lc(cand)));
          x.to = cand; x.flags.resolved = 'number'; x.flags.clashExisting = x.flags.clashResult = undefined; claimed.set(lc(cand), x); again = true;
        }
      }
      if (!again) break;
    }
  }
}

/* ---------- the steps: no file ever put over another ---------- */
export type Ren = { dir: string; from: string; to: string };
export type Leg = 'direct' | 'toTemp' | 'fromTemp';
export type Step = { i: number; dir: string; from: string; to: string; leg: Leg };
/** The renames in an order where each target is free when its turn comes; a ring (a→b, b→a), or a name changed only in
 *  letter case, goes by way of a hidden temporary name in the same folder (`.ktren-<id>-<k>`). `present(dir)`: the
 *  names (lower-cased) in the folder now. */
export function planSteps(rens: Ren[], present: (dir: string) => Set<string> | undefined, id: string): Step[] {
  const out: Step[] = []; const byDir = new Map<string, number[]>(); rens.forEach((r, i) => { const a = byDir.get(r.dir); if (a) a.push(i); else byDir.set(r.dir, [i]); });
  let tmpN = 0;
  for (const [dir, ix] of byDir) {
    const cur = new Set<string>(present(dir) ?? []); const at = new Map<number, string>(); for (const i of ix) { at.set(i, rens[i].from); cur.add(lc(rens[i].from)); }
    const waiting = new Map<string, number>(); const ready: number[] = [];
    for (const i of ix) { const tk = lc(rens[i].to); if (cur.has(tk)) waiting.set(tk, i); else ready.push(i); }
    const wake = (freed: string) => { const j = waiting.get(freed); if (j !== undefined) { waiting.delete(freed); ready.push(j); } };
    let qi = 0; let left = ix.length;
    const total = ix.length * 3 + 5;
    for (let guard = 0; left > 0 && guard < total; guard++) {
      if (qi < ready.length) {
        const i = ready[qi++]; const from = at.get(i)!; const to = rens[i].to; const leg: Leg = from === rens[i].from ? 'direct' : 'fromTemp';
        out.push({ i, dir, from, to, leg }); cur.delete(lc(from)); cur.add(lc(to)); at.set(i, to); left--; wake(lc(from)); continue;
      }
      // (Nothing free: a ring, or a case-only change. The first one waiting steps aside.)
      let i = -1; for (const j of waiting.values()) if (!at.get(j)!.startsWith('.ktren-')) { i = j; break; }
      if (i < 0) break; let tmp = ''; do { tmp = `.ktren-${id}-${++tmpN}`; } while (cur.has(tmp));
      const from = at.get(i)!; out.push({ i, dir, from, to: tmp, leg: 'toTemp' }); cur.delete(lc(from)); cur.add(tmp); at.set(i, tmp); wake(lc(from));
    }
  }
  return out;
}

/* ---------- the run ---------- */
export type IO = { rename(dir: string, from: string, to: string): Promise<void>; list(dir: string): Promise<string[] | null> };
export type RunOpts = { id: string; progress?: (done: number, total: number) => void; cancelled?: () => boolean; journal?: Journal | null };
export type RunResult = { /** The name each item has now (its own old one, a temporary one, or its new one). */ at: string[]; moved: number[]; failed: { i: number; why: string }[]; stranded: number[]; cancelled: boolean; untouched: number[]; ms: number };
const errText = (e: unknown): string => String((e as Error)?.message ?? e);

/** Does the renames: first a fresh look at each folder (a name that appeared since the preview is a failure of that
 *  item only, listed), then the steps, one at a time, the storage itself refusing a taken target or a missing source;
 *  a failing step stops that item and the rest go on. Cancel: no new step is begun, except those that bring an item
 *  standing at a temporary name to its end. */
export async function runRenames(rens: Ren[], io: IO, o: RunOpts): Promise<RunResult> {
  const t0 = Date.now(); const n = rens.length; const at = rens.map((r) => r.from); const failed: { i: number; why: string }[] = []; const bad = new Set<number>();
  const dirs = [...new Set(rens.map((r) => r.dir))]; const present = new Map<string, Set<string>>(); const known = new Set<string>();
  for (const d of dirs) { const l = await io.list(d).catch(() => null); if (l) { present.set(d, new Set(l.map(lc))); known.add(d); } }
  const fail = (i: number, why: string) => { if (!bad.has(i)) { bad.add(i); failed.push({ i, why }); } };
  // (Before anything moves: a source gone, a target taken by what is not in this run — those items are out.)
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (bad.has(i)) continue; const r = rens[i]; const p = present.get(r.dir); if (!p) continue;
      if (!p.has(lc(r.from))) { fail(i, 'not found'); changed = true; continue; }
      if (lc(r.to) !== lc(r.from) && p.has(lc(r.to))) { const frees = rens.some((x, j) => !bad.has(j) && x.dir === r.dir && lc(x.from) === lc(r.to) && lc(x.to) !== lc(x.from)); if (!frees) { fail(i, 'exists'); changed = true; } }
    }
    if (!changed) break;
  }
  const ok = rens.map((r, i) => ({ r, i })).filter((x) => !bad.has(x.i));
  const steps = planSteps(ok.map((x) => x.r), (d) => present.get(d), o.id).map((s) => ({ ...s, i: ok[s.i].i }));
  o.journal?.begin(rens, steps);
  const state = { atTemp: new Set<number>() }; let cancelled = false; let k = 0;
  for (; k < steps.length; k++) {
    if (!cancelled && o.cancelled?.()) cancelled = true;
    if (cancelled && !state.atTemp.size) break;
    const s = steps[k]; o.progress?.(k, steps.length);
    if (bad.has(s.i)) { o.journal?.mark(k, false); continue; }
    try { await io.rename(s.dir, s.from, s.to); at[s.i] = s.to; if (s.leg === 'toTemp') state.atTemp.add(s.i); else state.atTemp.delete(s.i); o.journal?.mark(k, true); }
    catch (e) {
      o.journal?.mark(k, false);
      if (s.leg === 'fromTemp') { try { await io.rename(s.dir, s.from, rens[s.i].from); at[s.i] = rens[s.i].from; state.atTemp.delete(s.i); } catch { /* left at its temporary name: told */ } }
      else if (s.leg === 'toTemp') { /* still where it was */ }
      fail(s.i, errText(e));
    }
    if (k % 25 === 24) await new Promise((r) => setTimeout(r, 0));
  }
  o.progress?.(steps.length, steps.length);
  // (A last look: what was said done is on the disk.)
  for (const d of dirs) { const l = await io.list(d).catch(() => null); if (!l) continue; const have = new Set(l.map(lc)); rens.forEach((r, i) => { if (r.dir === d && !bad.has(i) && at[i] !== r.from && !have.has(lc(at[i]))) fail(i, 'missing after the rename'); }); }
  const moved: number[] = []; const stranded: number[] = []; const untouched: number[] = [];
  rens.forEach((r, i) => { if (at[i] === r.to && r.to !== r.from) moved.push(i); else if (at[i].startsWith('.ktren-')) stranded.push(i); else if (at[i] === r.from && !bad.has(i)) untouched.push(i); });
  o.journal?.end(stranded.length === 0);
  return { at, moved, failed, stranded, cancelled, untouched, ms: Date.now() - t0 };
}

/* ---------- the journal: written before the first rename, kept until the run ends cleanly ---------- */
const KEY = 'kt.files.renamejob'; const KEYP = 'kt.files.renamejob.p';
export type JournalData = { id: string; at: number; dirs: string[]; items: [number, string, string][]; steps: number[]; tmps: Record<number, string> };
export type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const LEG = { direct: 0, toTemp: 1, fromTemp: 2 } as const; const LEGS: Leg[] = ['direct', 'toTemp', 'fromTemp'];
export class Journal {
  constructor(readonly id: string, private store: Store | null) {}
  /** Bytes the plan took (measured, for the report). */ size = 0; private bads: number[] = [];
  begin(rens: Ren[], steps: Step[]): void {
    const dirs = [...new Set(rens.map((r) => r.dir))]; const tmps: Record<number, string> = {}; for (const s of steps) if (s.leg === 'toTemp') tmps[s.i] = s.to;
    const d: JournalData = { id: this.id, at: Date.now(), dirs, items: rens.map((r) => [dirs.indexOf(r.dir), r.from, r.to]), steps: steps.map((s) => s.i * 3 + LEG[s.leg]), tmps };
    const text = JSON.stringify(d); this.size = text.length;
    try { this.store?.setItem(KEY, text); this.store?.setItem(KEYP, JSON.stringify({ id: this.id, k: 0, bad: [] })); } catch { /* too big for the store: the run goes on, not resumable */ this.store = null; }
  }
  /** Step `k` has ended (`ok` false: it failed, or was skipped): a small record, written at each one. */
  mark(k: number, ok: boolean): void {
    if (!this.store) return; if (!ok) this.bads.push(k);
    try { this.store.setItem(KEYP, JSON.stringify({ id: this.id, k: k + 1, bad: this.bads })); } catch { /* none */ }
  }
  end(clean: boolean): void { if (clean) { try { this.store?.removeItem(KEY); this.store?.removeItem(KEYP); } catch { /* none */ } } }
}
export const readJournal = (store: Store | null): { data: JournalData; k: number; bad: number[] } | null => {
  try { const a = store?.getItem(KEY); const b = store?.getItem(KEYP); if (!a) return null; const data = JSON.parse(a) as JournalData; const p = b ? (JSON.parse(b) as { id: string; k: number; bad: number[] }) : { id: data.id, k: 0, bad: [] }; return { data, k: p.id === data.id ? p.k : 0, bad: p.bad ?? [] }; } catch { return null; }
};
export const dropJournal = (store: Store | null): void => { try { store?.removeItem(KEY); store?.removeItem(KEYP); } catch { /* none */ } };

/** Where each item of an interrupted run stands: replayed from the journal's steps — those ended, and the one under way
 *  if its target is on the disk (the plan had it free). */
export function whereNow(j: { data: JournalData; k: number; bad: number[] }, has: (dir: string, name: string) => boolean): { at: string[]; problems: { i: number; why: string }[] } {
  const d = j.data; const at = d.items.map((x) => x[1]); const bad = new Set(j.bad); const problems: { i: number; why: string }[] = [];
  const apply = (s: number) => { const code = d.steps[s]; const i = Math.floor(code / 3); const leg = LEGS[code % 3]; const [di, from, to] = d.items[i]; void from; at[i] = leg === 'toTemp' ? d.tmps[i] : to; void di; };
  for (let s = 0; s < j.k && s < d.steps.length; s++) if (!bad.has(s)) apply(s);
  const next = j.k; if (next < d.steps.length && !bad.has(next)) { const code = d.steps[next]; const i = Math.floor(code / 3); const leg = LEGS[code % 3]; const dir = d.dirs[d.items[i][0]]; const target = leg === 'toTemp' ? d.tmps[i] : d.items[i][2]; if (has(dir, target)) apply(next); }
  d.items.forEach((x, i) => { if (!has(d.dirs[x[0]], at[i])) problems.push({ i, why: 'not found' }); });
  return { at, problems };
}
/** The renames that bring an interrupted run to its end (`finish`) or take it back (`undo`), from where each item stands. */
export function recoveryRens(j: { data: JournalData }, at: string[], way: 'finish' | 'undo'): Ren[] {
  const out: Ren[] = []; j.data.items.forEach((x, i) => { const dir = j.data.dirs[x[0]]; const want = way === 'finish' ? x[2] : x[1]; if (at[i] !== want) out.push({ dir, from: at[i], to: want }); }); return out;
}
/** The renames that take a finished (or partial) run back: every item not at its own old name goes there. */
export function undoRens(rens: Ren[], res: RunResult): { rens: Ren[]; of: number[] } {
  const out: Ren[] = []; const of: number[] = []; rens.forEach((r, i) => { if (res.at[i] !== r.from) { out.push({ dir: r.dir, from: res.at[i], to: r.from }); of.push(i); } }); return { rens: out, of };
}
