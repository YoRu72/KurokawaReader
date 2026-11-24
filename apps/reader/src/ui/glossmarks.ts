// The glossary's names in the text being read: found chapter by chapter (src/glossmatch.ts), marked with a quiet dotted
// underline through the CSS Custom Highlight API — the page itself is not touched (no wrapping, no new nodes), so the
// reader's highlights, notes, search hits and place keep their offsets — and a tap on one opens its entry (glosscard.ts).
// Where the API is missing nothing is marked; the tap works all the same.
import { foldKey, glossaryVersion, onGlossaryChange } from '../glossary';
import { getSettings, onSettingsChange } from '../settings';
import { bookScopeTerms, buildMatcher, findNames, foldText, nameEntries, type Found, type Matcher, type NameEntry } from '../glossmatch';

export interface MarkDoc { bookId: string; title: string; language?: string; root: Element; units: Element[] }
export interface MarkHost {
  docs(): MarkDoc[];
  /** A chapter's text nodes, and before which of them a block (or a line) begins. */
  textNodes(unit: Element): { nodes: Text[]; brk: Uint8Array };
}
/** A name found: where it stands (a range, across the nodes it spans), and what it is. */
export interface NameHit { dead?: boolean; range: Range; entry: NameEntry; mode: 'orig' | 'tr'; bookId: string; title: string; language?: string; rects(): DOMRect[] }
interface Seg { from: number; to: number; hit: NameHit }
interface Unit { ver: string; hits: NameHit[] }
interface Pack { ver: string; orig: Matcher; tr: Matcher }

const NAME = 'kr-gloss';
type Reg = { set(k: string, v: unknown): void; delete(k: string): void; get(k: string): { size: number } | undefined };
const registry = (): Reg | undefined => (CSS as unknown as { highlights?: Reg }).highlights;
const HL = (): (new (...r: Range[]) => unknown) | undefined => (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
const baseLang = (c: string): string => (c || '').split('-')[0];
const wanted = (): { marks: boolean; tap: boolean } => { const s = getSettings(); return { marks: s.glossMarks !== false, tap: s.glossTap !== false }; };

export interface GlossMarks {
  /** Look again at what is shown (a chapter turned, a layout made). */
  refresh(): void;
  /** The name under a point (a tap or a click), if any. */
  hitAt(x: number, y: number): NameHit | null;
  /** The name a text is (a selection), by the key of a name. */
  entryFor(text: string, bookId?: string): { entry: NameEntry; bookId: string } | null;
  /** How many names are marked now, and how many chapters have been read for them. */
  stats(): { marked: number; scans: number };
  dispose(): void;
}

export function attachGlossMarks(flow: HTMLElement, host: MarkHost): GlossMarks {
  const packs = new Map<string, Pack>();
  const state = new Map<Element, Unit>();
  const byNode = new WeakMap<Text, Seg[]>();
  const watched = new WeakSet<Element>(); const observers: MutationObserver[] = [];
  const dirty = new Set<Element>();
  let scans = 0; let timer = 0; let disposed = false; let queued = false;
  const version = (): string => `${glossaryVersion()}|${baseLang(getSettings().aiTarget || '')}`;

  function packFor(bookId: string): Pack {
    const ver = version(); let p = packs.get(bookId);
    if (p && p.ver === ver) return p;
    const list = bookScopeTerms(bookId); const lang = getSettings().aiTarget || '';
    p = { ver, orig: buildMatcher(nameEntries(list, 'orig')), tr: buildMatcher(nameEntries(list, 'tr', lang)) };
    packs.set(bookId, p); return p;
  }
  const hidden = (u: Element): boolean => !!(u as HTMLElement).hidden || !!u.closest('[hidden]');

  /** One chapter read for names: its text taken block by block (a name never runs across blocks), the translated parts
   *  and the originals each with their own list of names. */
  function scanUnit(doc: MarkDoc, unit: Element): NameHit[] {
    const hits: NameHit[] = []; const pack = packFor(doc.bookId);
    if (!pack.orig.size && !pack.tr.size) return hits;
    const { nodes, brk } = host.textNodes(unit);
    const translated = !!unit.querySelector('.kr-tr-out');
    const modeOf = (n: Text): 'orig' | 'tr' | null => { const p = n.parentElement; if (!p || p.closest('a')) return null; return translated && p.closest('.kr-tr-out') ? 'tr' : 'orig'; };
    let i = 0;
    while (i < nodes.length) {
      const mode = modeOf(nodes[i]);
      if (!mode) { i++; continue; }
      let j = i + 1;
      while (j < nodes.length && !brk[j] && modeOf(nodes[j]) === mode) j++;
      const m = mode === 'orig' ? pack.orig : pack.tr;
      if (m.size) segment(doc, nodes, i, j, m, mode, hits);
      i = j;
    }
    return hits;
  }
  function segment(doc: MarkDoc, nodes: Text[], a: number, b: number, m: Matcher, mode: 'orig' | 'tr', out: NameHit[]): void {
    let text = ''; const starts: number[] = [];
    for (let k = a; k < b; k++) { starts.push(text.length); text += nodes[k].data; }
    if (text.length < 2) return;
    const found: Found[] = findNames(m, text, foldText(text));
    const at = (pos: number): number => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
    for (const f of found) {
      const ks = at(f.s), ke = at(f.e - 1); const ns = nodes[a + ks], ne = nodes[a + ke];
      const so = f.s - starts[ks], eo = f.e - starts[ke];
      if (so > ns.length || eo > ne.length) continue;
      const range = document.createRange(); range.setStart(ns, so); range.setEnd(ne, eo);
      const hit: NameHit = { range, entry: f.entry, mode, bookId: doc.bookId, title: doc.title, language: doc.language, rects: () => Array.from(range.getClientRects()) };
      out.push(hit);
      for (let k = ks; k <= ke; k++) { const n = nodes[a + k]; const seg: Seg = { from: k === ks ? so : 0, to: k === ke ? eo : n.length, hit }; const l = byNode.get(n)?.filter((x) => !x.hit.dead); if (l) { l.push(seg); byNode.set(n, l); } else byNode.set(n, [seg]); }
    }
  }

  /* ---------- what is marked ---------- */
  let painted: boolean | null = null;
  function paint(): void {
    const reg = registry(); const H = HL(); if (!reg || !H) return;
    const { marks } = wanted(); const all: Range[] = []; painted = marks;
    if (marks) for (const [u, s] of state) { if (!u.isConnected) { state.delete(u); continue; } for (const h of s.hits) if (!h.range.collapsed) all.push(h.range); }
    if (all.length) reg.set(NAME, new H(...all)); else reg.delete(NAME);
  }
  const pending = (): { doc: MarkDoc; unit: Element }[] => {
    const ver = version(); const out: { doc: MarkDoc; unit: Element }[] = [];
    for (const doc of host.docs()) {
      if (!watched.has(doc.root)) {
        watched.add(doc.root);
        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            const el = m.target instanceof Element ? m.target : m.target.parentElement; if (!el) continue;
            if (m.type === 'attributes') { schedule(); continue; }
            for (const d of host.docs()) for (const u of d.units) if (u.contains(el)) dirty.add(u);
          }
          if (dirty.size) schedule(250);
        });
        obs.observe(doc.root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] }); observers.push(obs);
      }
      for (const unit of doc.units) { if (hidden(unit)) continue; const s = state.get(unit); if (!s || s.ver !== ver || dirty.has(unit)) out.push({ doc, unit }); }
    }
    return out;
  };
  function run(): void {
    queued = false; if (disposed) return;
    const w = wanted();
    if (!w.marks && !w.tap) { state.clear(); registry()?.delete(NAME); return; }
    const todo = pending(); if (!todo.length) { if (painted !== w.marks) paint(); return; }
    // (The chapter nearest the screen first; as many as the time allows, the rest after a breath.)
    const mid = innerHeight / 2; const dist = (u: Element): number => { const r = u.getBoundingClientRect(); return r.bottom < mid ? mid - r.bottom : r.top > mid ? r.top - mid : 0; };
    todo.sort((x, y) => dist(x.unit) - dist(y.unit));
    const until = performance.now() + 24; const ver = version(); let did = 0;
    for (const { doc, unit } of todo) {
      if (performance.now() > until && did > 0) break; did++;
      for (const h of state.get(unit)?.hits ?? []) h.dead = true;
      state.set(unit, { ver, hits: scanUnit(doc, unit) }); dirty.delete(unit); scans++;
    }
    flow.dataset.glossScans = String(scans);
    paint();
    if (pending().length) schedule(30);
  }
  function schedule(ms = 0): void {
    if (disposed) return;
    if (queued && ms === 0) return;
    window.clearTimeout(timer); queued = true; timer = window.setTimeout(run, ms);
  }

  const offGloss = onGlossaryChange(() => schedule(60));
  const offSet = onSettingsChange(() => schedule(60));
  schedule(0);

  /* ---------- a tap ---------- */
  function hitAt(x: number, y: number): NameHit | null {
    if (!wanted().tap) return null;
    const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null; caretRangeFromPoint?(x: number, y: number): Range | null };
    let node: Node | null = null, off = 0;
    const cp = d.caretPositionFromPoint?.(x, y); if (cp) { node = cp.offsetNode; off = cp.offset; }
    else { const r = d.caretRangeFromPoint?.(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const segs = byNode.get(node as Text); if (!segs) return null;
    for (const s of segs) {
      if (s.hit.dead || off < s.from || off > s.to || s.hit.range.collapsed) continue;
      // (Where the caret falls is the nearest letter; the finger must be on the name itself.)
      if (s.hit.rects().some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)) return s.hit;
    }
    return null;
  }
  function entryFor(text: string, bookId?: string): { entry: NameEntry; bookId: string } | null {
    const k = foldKey(text, true); if (k.length < 2) return null;
    const ids = bookId ? [bookId] : host.docs().map((d) => d.bookId);
    for (const id of ids) { const p = packFor(id); const e = p.orig.byKey.get(k) ?? p.tr.byKey.get(k); if (e) return { entry: e, bookId: id }; }
    return null;
  }
  return {
    refresh: () => schedule(0), hitAt, entryFor,
    stats: () => ({ marked: registry()?.get(NAME)?.size ?? 0, scans }),
    dispose: () => { disposed = true; window.clearTimeout(timer); offGloss(); offSet(); for (const o of observers) o.disconnect(); registry()?.delete(NAME); state.clear(); },
  };
}
