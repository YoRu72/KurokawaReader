// Anki decks (.apkg / .colpkg): reading the package, rendering cards from their
// note types' templates, and a spaced-repetition scheduler (Anki's SM-2 rules,
// simplified) whose state is kept per deck in the library database.
//
// Packages come in two generations:
//   - legacy: collection.anki2 / collection.anki21 (SQLite), note types as JSON in
//     `col.models`, media map as JSON;
//   - current (Anki 2.1.50+): collection.anki21b, the SQLite file zstd-compressed,
//     note types / fields / templates in their own tables with protobuf configs,
//     media map as zstd-compressed protobuf and each media file zstd-compressed.
import JSZip from 'jszip';
import DOMPurify from 'dompurify';
import { decompress as unzstd } from './vendor/fzstd';
import { db } from './db';

/* ------------------------------------------------------------------ */
/* SQLite (sql.js, loaded on demand from /vendor)                      */
/* ------------------------------------------------------------------ */

interface SqlDb { exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[]; close(): void }
interface SqlJs { Database: new (data: Uint8Array) => SqlDb }
let sqlPromise: Promise<SqlJs> | null = null;
function loadSql(): Promise<SqlJs> {
  sqlPromise ??= new Promise<SqlJs>((res, rej) => {
    const w = window as unknown as { initSqlJs?: (o: { locateFile: (f: string) => string }) => Promise<SqlJs> };
    const go = () => w.initSqlJs!({ locateFile: (f) => `/vendor/${f}` }).then(res, rej);
    if (w.initSqlJs) { go(); return; }
    const s = document.createElement('script'); s.src = '/vendor/sql-wasm.js';
    s.onload = go; s.onerror = () => rej(new Error('sql.js')); document.head.appendChild(s);
  });
  sqlPromise.catch(() => { sqlPromise = null; });
  return sqlPromise;
}
const rows = (d: SqlDb, sql: string): unknown[][] => d.exec(sql)[0]?.values ?? [];

/* ------------------------------------------------------------------ */
/* Tiny protobuf reader (only what Anki's configs need)                */
/* ------------------------------------------------------------------ */

type PbField = { no: number; wire: number; v: number | Uint8Array };
function pbRead(buf: Uint8Array): PbField[] {
  const out: PbField[] = []; let i = 0;
  const varint = (): number => { let r = 0, s = 0, b: number; do { b = buf[i++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80 && i < buf.length); return r; };
  while (i < buf.length) {
    const key = varint(); const no = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) out.push({ no, wire, v: varint() });
    else if (wire === 2) { const len = varint(); out.push({ no, wire, v: buf.subarray(i, i + len) }); i += len; }
    else if (wire === 1) { i += 8; } else if (wire === 5) { i += 4; } else break;
  }
  return out;
}
const pbStr = (f: PbField[], no: number): string => { const x = f.find((y) => y.no === no && y.wire === 2); return x ? new TextDecoder().decode(x.v as Uint8Array) : ''; };
const pbNum = (f: PbField[], no: number): number => { const x = f.find((y) => y.no === no && y.wire === 0); return x ? (x.v as number) : 0; };

const isZstd = (b: Uint8Array) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
const maybeZstd = (b: Uint8Array) => (isZstd(b) ? unzstd(b) : b);

/* ------------------------------------------------------------------ */
/* Deck model                                                          */
/* ------------------------------------------------------------------ */

export interface Template { name: string; ord: number; q: string; a: string }
export interface NoteType { id: number; name: string; cloze: boolean; css: string; fields: string[]; templates: Template[] }
export interface Note { id: number; mid: number; fields: string[]; tags: string }
export interface Card { id: number; nid: number; did: number; ord: number; pos: number }
export interface Deck {
  name: string;
  decks: Map<number, string>;
  types: Map<number, NoteType>;
  notes: Map<number, Note>;
  cards: Card[];
  /** Media file name → loader (decompresses on first use). */
  media: Map<string, () => Promise<Blob>>;
}

const deckCache = new Map<string, Promise<Deck>>();
export function openDeck(bookId: string, file: Blob): Promise<Deck> {
  let p = deckCache.get(bookId);
  if (!p) { p = parseApkg(file); deckCache.set(bookId, p); p.catch(() => deckCache.delete(bookId)); while (deckCache.size > 2) deckCache.delete(deckCache.keys().next().value!); }
  return p;
}

export async function parseApkg(file: Blob): Promise<Deck> {
  const zip = await JSZip.loadAsync(file);
  const pick = zip.file('collection.anki21b') ?? zip.file('collection.anki21') ?? zip.file('collection.anki2');
  if (!pick) throw new Error('Not an Anki package');
  const raw = maybeZstd(new Uint8Array(await pick.async('uint8array')));
  const SQL = await loadSql();
  const d = new SQL.Database(raw);
  try {
    const types = new Map<number, NoteType>();
    const decks = new Map<number, string>();
    const hasTable = (n: string) => rows(d, `select name from sqlite_master where type='table' and name='${n}'`).length > 0;
    const colModels = rows(d, 'select models, decks from col')[0] as [string, string] | undefined;
    if (colModels && colModels[0] && colModels[0].length > 2) {
      // legacy JSON
      const models = JSON.parse(colModels[0]) as Record<string, { id: number; name: string; type: number; css: string; flds: { name: string; ord: number }[]; tmpls: { name: string; ord: number; qfmt: string; afmt: string }[] }>;
      for (const m of Object.values(models)) types.set(Number(m.id), { id: Number(m.id), name: m.name, cloze: m.type === 1, css: m.css ?? '', fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name), templates: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((x) => ({ name: x.name, ord: x.ord, q: x.qfmt, a: x.afmt })) });
      try { for (const dk of Object.values(JSON.parse(colModels[1] || '{}') as Record<string, { id: number; name: string }>)) decks.set(Number(dk.id), dk.name); } catch { /* ignore */ }
    }
    if (!types.size && hasTable('notetypes')) {
      for (const [id, name, config] of rows(d, 'select id, name, config from notetypes') as [number, string, Uint8Array][]) {
        const cf = pbRead(config ?? new Uint8Array());
        types.set(Number(id), { id: Number(id), name, cloze: pbNum(cf, 1) === 1, css: pbStr(cf, 3), fields: [], templates: [] });
      }
      for (const [ntid, ord, name] of rows(d, 'select ntid, ord, name from fields order by ntid, ord') as [number, number, string][]) types.get(Number(ntid))?.fields.push(name);
      for (const [ntid, ord, name, config] of rows(d, 'select ntid, ord, name, config from templates order by ntid, ord') as [number, number, string, Uint8Array][]) {
        const cf = pbRead(config ?? new Uint8Array());
        types.get(Number(ntid))?.templates.push({ name, ord: Number(ord), q: pbStr(cf, 1), a: pbStr(cf, 2) });
      }
    }
    if (!decks.size && hasTable('decks')) for (const [id, name] of rows(d, 'select id, name from decks') as [number, string][]) decks.set(Number(id), String(name).replace(/\x1f/g, '::'));
    const notes = new Map<number, Note>();
    for (const [id, mid, flds, tags] of rows(d, 'select id, mid, flds, tags from notes') as [number, number, string, string][]) notes.set(Number(id), { id: Number(id), mid: Number(mid), fields: String(flds).split('\x1f'), tags: String(tags ?? '').trim() });
    const cards: Card[] = (rows(d, 'select id, nid, did, ord, type, due from cards order by did, case when type = 0 then due else 1e12 + due end, id') as number[][])
      .map(([id, nid, did, ord, , due], i) => ({ id: Number(id), nid: Number(nid), did: Number(did), ord: Number(ord), pos: Number(due) || i }))
      .filter((c) => notes.has(c.nid));
    // Media
    const media = new Map<string, () => Promise<Blob>>();
    const mf = zip.file('media');
    if (mf) {
      const bytes = new Uint8Array(await mf.async('uint8array'));
      const load = (entry: string) => async () => { const f = zip.file(entry); if (!f) throw new Error('missing media'); return new Blob([maybeZstd(new Uint8Array(await f.async('uint8array'))) as BlobPart], { type: mimeOf(entry) }); };
      let map: Record<string, string> | null = null;
      try { const txt = new TextDecoder().decode(bytes); if (txt.trimStart().startsWith('{')) map = JSON.parse(txt); } catch { /* not JSON */ }
      if (map) for (const [idx, name] of Object.entries(map)) media.set(name, wrapMime(load(idx), name));
      else {
        const entries = pbRead(maybeZstd(bytes)).filter((f) => f.no === 1 && f.wire === 2);
        entries.forEach((e, i) => { const f = pbRead(e.v as Uint8Array); const name = pbStr(f, 1); const legacy = f.find((x) => x.no === 255); media.set(name, wrapMime(load(String(legacy ? legacy.v : i)), name)); });
      }
    }
    const used = new Set(cards.map((c) => c.did));
    const named = [...decks].filter(([id, n]) => used.has(id) && n !== 'Default').map(([, n]) => n);
    const name = named.length === 1 ? named[0] : commonPrefix(named) || named[0] || 'Anki';
    return { name: name.replace(/::$/, ''), decks, types, notes, cards, media };
  } finally { d.close(); }
}
function wrapMime(fn: () => Promise<Blob>, name: string) { let p: Promise<Blob> | null = null; return () => (p ??= fn().then((b) => (b.type ? b : new Blob([b], { type: mimeOf(name) })))); }
function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', css: 'text/css' } as Record<string, string>)[ext] ?? '';
}
function commonPrefix(names: string[]): string {
  if (!names.length) return '';
  const parts = names.map((n) => n.split('::'));
  const out: string[] = [];
  for (let i = 0; i < parts[0].length; i++) { const p = parts[0][i]; if (parts.every((x) => x[i] === p)) out.push(p); else break; }
  return out.join('::');
}

/** Title and card count for the library (cheap enough at import time). */
export async function deckMeta(file: Blob): Promise<{ title: string; cards: number }> {
  const d = await parseApkg(file);
  return { title: d.name.split('::').pop() || d.name, cards: d.cards.length };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
const furiganaRe = / ?([^ >\[\]]+?)\[([^\]]+)\]/g;   // 漢字[かんじ] (a leading space separates words)
function applyFilter(filter: string, value: string, card: Card, side: 'q' | 'a'): string {
  switch (filter.toLowerCase()) {
    case 'text': return stripHtml(value);
    case 'furigana': return value.replace(furiganaRe, (_m, base: string, rd: string) => (base === rd ? base : `<ruby>${base}<rt>${rd}</rt></ruby>`));
    case 'kana': return value.replace(furiganaRe, (_m, _b: string, rd: string) => rd);
    case 'kanji': return value.replace(furiganaRe, (_m, b: string) => b);
    case 'cloze': return cloze(value, card.ord + 1, side);
    case 'hint': { const id = `h${Math.random().toString(36).slice(2, 8)}`; return value.trim() ? `<a class="hint" href="#" data-hint="${id}">Show hint</a><div id="${id}" class="hint-body" hidden>${value}</div>` : ''; }
    case 'type': return '';
    default: if (filter.toLowerCase().startsWith('tts')) return ''; return value;
  }
}
function cloze(text: string, n: number, side: 'q' | 'a'): string {
  return text.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_m, num: string, body: string, hint?: string) => {
    if (Number(num) !== n) return body;
    return side === 'q' ? `<span class="cloze">[${hint ?? '...'}]</span>` : `<span class="cloze">${body}</span>`;
  });
}
function renderTemplate(tpl: string, fields: Record<string, string>, card: Card, side: 'q' | 'a', extra: Record<string, string>): string {
  let out = tpl;
  // Sections: {{#Field}}…{{/Field}} and {{^Field}}…{{/Field}} (innermost first)
  for (let guard = 0; guard < 20; guard++) {
    const before = out;
    out = out.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/g, (_m, kind: string, name: string, body: string) => {
      const key = name.includes(':') ? name.split(':').pop()!.trim() : name;
      const val = key in fields ? fields[key] : (extra[key] ?? '');
      const has = key.startsWith('c') && /^c\d+$/.test(key) ? false : stripHtml(val).length > 0 || /<img|\[sound:/i.test(val);
      return (kind === '#') === has ? body : '';
    });
    if (out === before) break;
  }
  return out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, inner: string) => {
    const parts = inner.split(':').map((x) => x.trim());
    const name = parts.pop()!;
    let value = name in extra ? extra[name] : (fields[name] ?? '');
    for (const f of parts.reverse()) value = applyFilter(f, value, card, side);
    if (!parts.length && fields[name] === undefined && !(name in extra)) return '';
    return value;
  });
}

export interface Rendered { html: string; css: string; sounds: string[] }
export function renderCard(deck: Deck, card: Card, side: 'q' | 'a', night: boolean): Rendered {
  const note = deck.notes.get(card.nid)!; const type = deck.types.get(note.mid);
  if (!type) return { html: `<div>${note.fields.join('<br>')}</div>`, css: '', sounds: [] };
  const tpl = type.cloze ? type.templates[0] : (type.templates.find((x) => x.ord === card.ord) ?? type.templates[0]);
  const fields: Record<string, string> = {}; type.fields.forEach((f, i) => { fields[f] = note.fields[i] ?? ''; });
  const extra: Record<string, string> = { Tags: note.tags, Deck: deck.decks.get(card.did) ?? deck.name, Subdeck: (deck.decks.get(card.did) ?? '').split('::').pop() ?? '', Card: tpl?.name ?? '', Type: type.name };
  const q = renderTemplate(tpl?.q ?? '', fields, card, 'q', extra);
  let html = side === 'q' ? q : renderTemplate(tpl?.a ?? '', fields, card, 'a', { ...extra, FrontSide: q.replace(/\[sound:[^\]]+\]/g, '') });
  // Sounds become play buttons; the side's sounds are listed for autoplay.
  const sounds: string[] = [];
  html = html.replace(/\[sound:([^\]]+)\]/g, (_m, f: string) => { sounds.push(f); return `<button class="anki-sound" type="button" data-sound="${f.replace(/"/g, '&quot;')}" aria-label="Play">▶</button>`; });
  html = DOMPurify.sanitize(html, { ADD_TAGS: ['ruby', 'rt', 'rp', 'audio', 'source'], ADD_ATTR: ['data-sound', 'data-hint', 'hidden'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'], ALLOW_UNKNOWN_PROTOCOLS: false });
  return { html: `<div class="card card${(tpl?.ord ?? 0) + 1}${night ? ' nightMode night_mode' : ''}">${html}</div>`, css: type.css, sounds };
}

/** Replace media file names in rendered HTML with object URLs (only what this card uses). */
export async function attachMedia(deck: Deck, root: ParentNode, urls: Map<string, string>): Promise<void> {
  const get = async (name: string) => {
    if (urls.has(name)) return urls.get(name)!;
    const loader = deck.media.get(name) ?? deck.media.get(decodeURIComponent(name));
    if (!loader) return '';
    const u = URL.createObjectURL(await loader()); urls.set(name, u); return u;
  };
  for (const el of Array.from(root.querySelectorAll<HTMLImageElement | HTMLSourceElement | HTMLAudioElement | HTMLVideoElement>('img[src], audio[src], source[src], video[src]'))) {
    const src = el.getAttribute('src') ?? ''; if (!src || /^(https?:|data:|blob:)/.test(src)) continue;
    const u = await get(src); if (u) el.setAttribute('src', u);
  }
}
export async function soundUrl(deck: Deck, name: string, urls: Map<string, string>): Promise<string> {
  if (urls.has(name)) return urls.get(name)!;
  const loader = deck.media.get(name); if (!loader) return '';
  const u = URL.createObjectURL(await loader()); urls.set(name, u); return u;
}

/** Plain sort-field text of a note (browser list). */
export function noteSummary(deck: Deck, note: Note): string {
  return stripHtml((note.fields[0] ?? '').replace(furiganaRe, (_m, b: string) => b).replace(/\[sound:[^\]]+\]/g, '')).slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

export interface CardState { s: 0 | 1 | 2 | 3; due: number; ivl: number; ease: number; reps: number; lapses: number; step: number }
export interface Progress { cards: Record<string, CardState>; day: number; newToday: number; reviewsToday: number; newPerDay: number; autoplay: boolean; deckFilter?: number | null }
export const LEARN_STEPS = [1, 10];   // minutes
const RELEARN_STEPS = [10];
const DAY = 86_400_000;
/** Anki's day starts at 4 a.m. local time. */
export function today(): number { const d = new Date(Date.now() - 4 * 3600_000); return Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / DAY); }

export async function loadProgress(bookId: string): Promise<Progress> {
  const p = (await db.getMeta<Progress>(`anki:${bookId}`)) ?? { cards: {}, day: today(), newToday: 0, reviewsToday: 0, newPerDay: 20, autoplay: true };
  if (p.day !== today()) { p.day = today(); p.newToday = 0; p.reviewsToday = 0; }
  p.newPerDay ??= 20; p.autoplay ??= true;
  return p;
}
export const saveProgress = (bookId: string, p: Progress) => db.setMeta(`anki:${bookId}`, p);

export type Grade = 1 | 2 | 3 | 4;   // again, hard, good, easy
/** The state after answering, plus a short label of when the card comes back. */
export function schedule(st: CardState | undefined, g: Grade, now = Date.now()): CardState {
  const s: CardState = st ? { ...st } : { s: 0, due: now, ivl: 0, ease: 2500, reps: 0, lapses: 0, step: 0 };
  s.reps++;
  const learn = (steps: number[]) => {
    if (g === 1) { s.step = 0; s.due = now + steps[0] * 60_000; return; }
    if (g === 2) { s.due = now + (steps.length > 1 && s.step === 0 ? (steps[0] + steps[1]) / 2 : steps[s.step] ?? steps[0]) * 60_000; return; }
    if (g === 3 && s.step + 1 < steps.length) { s.step++; s.due = now + steps[s.step] * 60_000; return; }
    // graduate
    const days = g === 4 ? (s.s === 3 ? Math.max(s.ivl + 1, 4) : 4) : (s.s === 3 ? Math.max(1, s.ivl) : 1);
    s.s = 2; s.ivl = days; s.step = 0; s.due = today() + days;
  };
  if (s.s === 0) { s.s = 1; learn(LEARN_STEPS); return s; }
  if (s.s === 1) { learn(LEARN_STEPS); return s; }
  if (s.s === 3) { learn(RELEARN_STEPS); return s; }
  // review
  const overdue = Math.max(0, today() - s.due);
  if (g === 1) { s.lapses++; s.ease = Math.max(1300, s.ease - 200); s.ivl = Math.max(1, Math.round(s.ivl * 0.5)); s.s = 3; s.step = 0; s.due = now + RELEARN_STEPS[0] * 60_000; return s; }
  let ivl: number;
  if (g === 2) { ivl = Math.max(s.ivl + 1, Math.round(s.ivl * 1.2)); s.ease = Math.max(1300, s.ease - 150); }
  else if (g === 3) ivl = Math.max(s.ivl + 1, Math.round((s.ivl + overdue / 2) * s.ease / 1000));
  else { ivl = Math.max(s.ivl + 2, Math.round((s.ivl + overdue) * s.ease / 1000 * 1.3)); s.ease += 150; }
  s.ivl = Math.min(36500, ivl); s.due = today() + s.ivl;
  return s;
}
/** "1m", "10m", "3d", "2mo" — how long until the card returns. */
export function dueLabel(st: CardState, now = Date.now()): string {
  if (st.s === 1 || st.s === 3) { const m = Math.max(1, Math.round((st.due - now) / 60_000)); return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; }
  const d = st.ivl; return d < 30 ? `${d}d` : d < 365 ? `${Math.round(d / 30)}mo` : `${(d / 365).toFixed(1)}y`;
}

export interface Queue { learning: Card[]; review: Card[]; fresh: Card[] }
export function buildQueue(deck: Deck, p: Progress, now = Date.now()): Queue {
  const learning: Card[] = [], review: Card[] = [], fresh: Card[] = [];
  const td = today();
  const inDeck = (c: Card) => p.deckFilter == null || c.did === p.deckFilter || (deck.decks.get(c.did) ?? '').startsWith((deck.decks.get(p.deckFilter) ?? '\u0000') + '::');
  for (const c of deck.cards) {
    if (!inDeck(c)) continue;
    const st = p.cards[c.id];
    if (!st) { fresh.push(c); continue; }
    if ((st.s === 1 || st.s === 3) && st.due <= now + 20 * 60_000) learning.push(c);
    else if (st.s === 2 && st.due <= td) review.push(c);
  }
  learning.sort((a, b) => p.cards[a.id].due - p.cards[b.id].due);
  review.sort((a, b) => p.cards[a.id].due - p.cards[b.id].due);
  // One card per note among new cards on the same day (siblings wait), like Anki's bury option.
  const seen = new Set<number>(); const freshOk: Card[] = [];
  for (const c of fresh.sort((a, b) => a.pos - b.pos)) { if (seen.has(c.nid)) continue; seen.add(c.nid); freshOk.push(c); if (freshOk.length >= Math.max(0, p.newPerDay - p.newToday)) break; }
  return { learning, review, fresh: freshOk };
}
export function nextCard(q: Queue, p: Progress, now = Date.now()): Card | null {
  const dueLearn = q.learning.find((c) => p.cards[c.id].due <= now);
  if (dueLearn) return dueLearn;
  if (q.review.length) return q.review[0];
  if (q.fresh.length) return q.fresh[0];
  return q.learning[0] ?? null;   // learn ahead (within 20 minutes)
}
