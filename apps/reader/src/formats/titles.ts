// A book's own layout of its lines, and its chapter titles, found as each chapter is made.
//
// 1. markBookLayout (before a chapter is cleaned): what the book's stylesheet and inline styles say about each block's
//    alignment (centred / right — not justified or left: the reader's own alignment rules body text), and, unless the
//    publisher's styles are used as they are, its relative sizes, bold and italic — kept as data-kr-* marks the reader's
//    stylesheet acts on (the cleaner drops `style` and the book's CSS; the marks survive). Nothing of the text changes.
// 2. markChapterTitles (after it is cleaned): the chapter's title block(s) — a heading, or the short opening lines that
//    say the contents' title, carry a title class, or read «Chapter 1» / «الفصل الأول» / «第一話»… — marked data-kr-title,
//    the leading label of a one-block title («Chapter 1:» + <br>) wrapped in span.kr-title-label (hidden by CSS when
//    asked; the text and the blocks stay as they are, so positions, search and highlights do not move); short bold lines
//    standing alone under the title or after a scene break (a point-of-view name) marked as sub-headings; runs of empty
//    spacer paragraphs marked so they make one modest gap.
import { BLOCK_SELECTOR, resolveZipPath } from './shared';
import { searchFormOf } from './types';

/* ------------------------------------------------------------------ */
/* The book's own layout                                              */
/* ------------------------------------------------------------------ */

type Align = 'center' | 'right' | 'end' | 'none';
interface Rule { sel: string; spec: number; order: number; align?: Align; size?: number; bold?: boolean; italic?: boolean; need: { cls: string[]; tag: string; id: string } }
interface Sheet { rules: Rule[]; basePx: number }

const sheetCache = new WeakMap<object, Map<string, Promise<Sheet>>>();
const SIZE_WORDS: Record<string, number> = { 'xx-small': 0.6, 'x-small': 0.75, small: 0.89, medium: 1, large: 1.2, 'x-large': 1.5, 'xx-large': 2, 'xxx-large': 3, larger: 1.2, smaller: 0.83 };

function alignOf(v: string): Align | undefined {
  v = v.trim().toLowerCase(); if (!v) return undefined;
  if (v === 'center' || v === '-webkit-center') return 'center';
  if (v === 'right' || v === '-webkit-right') return 'right';
  if (v === 'end') return 'end';
  return 'none';
}
/** A font-size as a ratio to the parent's (em, %, keywords), or to the book's body (rem, px, pt). */
function sizeOf(v: string, basePx: number): number | undefined {
  v = v.trim().toLowerCase(); if (!v || v === 'inherit' || v === 'initial' || v === 'unset') return undefined;
  if (v in SIZE_WORDS) return SIZE_WORDS[v];
  const m = /^(-?[\d.]+)(em|%|rem|px|pt)$/.exec(v); if (!m) return undefined;
  const n = parseFloat(m[1]); if (!(n > 0)) return undefined;
  switch (m[2]) { case 'em': case 'rem': return n; case '%': return n / 100; case 'px': return n / basePx; case 'pt': return (n * 4 / 3) / basePx; }
  return undefined;
}
const boldOf = (v: string): boolean | undefined => { v = v.trim().toLowerCase(); if (!v) return undefined; if (v === 'bold' || v === 'bolder') return true; const n = parseInt(v, 10); if (n) return n >= 600; return v === 'normal' || v === 'lighter' ? false : undefined; };
const italicOf = (v: string): boolean | undefined => { v = v.trim().toLowerCase(); if (!v) return undefined; return v === 'italic' || v === 'oblique' ? true : v === 'normal' ? false : undefined; };

function specificity(sel: string): number {
  const s = sel.replace(/::?[a-z-]+\([^)]*\)/gi, ' ').replace(/::[a-z-]+/gi, '');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:[a-z-]+/gi) ?? []).length;
  const tags = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[a-z-]+/gi, ' ').match(/[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + cls * 100 + tags;
}
/** What the rightmost part of a selector needs to be present in a document (to skip the rules a chapter cannot match). */
function needOf(sel: string): Rule['need'] {
  const last = sel.trim().split(/[\s>+~]+/).pop() ?? '';
  const cls = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const id = /#([\w-]+)/.exec(last)?.[1] ?? '';
  const tag = /^([a-z][\w-]*)/i.exec(last)?.[1]?.toLowerCase() ?? '';
  return { cls, tag, id };
}

function parseSheet(css: string): Sheet {
  const out: Rule[] = []; let basePx = 16;
  let sheet: CSSStyleSheet;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(css.replace(/@import[^;]*;/gi, '')); } catch { return { rules: out, basePx }; }
  const styleRules = [...sheet.cssRules].filter((r): r is CSSStyleRule => r instanceof CSSStyleRule);
  // (Pixel sizes are measured against the body's own size.)
  for (const r of styleRules) if (/^\s*(html|body)\s*$/i.test(r.selectorText) && /px$/.test(r.style.fontSize)) basePx = parseFloat(r.style.fontSize) || 16;
  let order = 0;
  for (const r of styleRules) {
    const st = r.style;
    const align = alignOf(st.textAlign), fs = st.fontSize, bold = boldOf(st.fontWeight), italic = italicOf(st.fontStyle);
    if (!align && !fs && bold === undefined && italic === undefined) continue;
    const sels = /[()]/.test(r.selectorText) ? [r.selectorText] : r.selectorText.split(',');
    for (const raw of sels) {
      const sel = raw.trim(); if (!sel || /::|:(hover|active|focus|visited|link|before|after|first-letter|first-line)\b/i.test(sel)) continue;
      // (The body's own size is the reader's: a ratio from it would only scale the whole book.)
      const size = fs && !/^(html|body)$/i.test(sel) ? sizeOf(fs, basePx) : undefined;
      out.push({ sel, spec: specificity(sel), order: order++, align, size, bold, italic, need: needOf(sel) });
    }
  }
  return { rules: out, basePx };
}

function sheetFor(cacheKey: object, path: string, read: () => Promise<string | null>): Promise<Sheet> {
  let m = sheetCache.get(cacheKey); if (!m) { m = new Map(); sheetCache.set(cacheKey, m); }
  let p = m.get(path);
  if (!p) { p = read().then((css) => parseSheet(css ?? '')).catch(() => ({ rules: [], basePx: 16 })); m.set(path, p); }
  return p;
}

const SIZE_STEPS = [70, 75, 80, 85, 90, 95, 105, 110, 117, 125, 133, 150, 175, 200, 250, 300, 350];
const sizeStep = (f: number, max = 200): number | null => {
  if (f > 0.97 && f < 1.03) return null;
  const pct = Math.min(max, Math.max(70, f * 100));
  let best = SIZE_STEPS[0]; for (const s of SIZE_STEPS) if (Math.abs(s - pct) < Math.abs(best - pct)) best = s;
  return best;
};

interface Decl { align?: [number, Align]; size?: [number, number]; bold?: [number, boolean]; italic?: [number, boolean] }

/**
 * Read what a chapter's own stylesheets and inline styles say of its blocks' alignment and of its sizes, bold and italic,
 * and keep it as marks (data-kr-align, data-kr-fs, data-kr-b, data-kr-i, data-kr-strong). Called on the parsed chapter
 * before it is cleaned. `keepStyles`: the publisher's styles are used as they are (only the alignment marked then).
 * A chapter that centres most of its long paragraphs (a badly made book centring everything) has them left to the
 * reader's own alignment. The language of an XHTML chapter (xml:lang) is kept as `lang`.
 */
export async function markBookLayout(doc: Document, itemHref: string, readCss: (path: string) => Promise<string | null>, cacheKey: object, keepStyles: boolean): Promise<void> {
  const html = doc.documentElement, body = doc.body; if (!body) return;
  const xl = html.getAttribute('xml:lang') || html.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang');
  if (xl && !html.getAttribute('lang') && !body.getAttribute('lang')) html.setAttribute('lang', xl);

  const sheets: Sheet[] = [];
  const links = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
  for (const l of links) { const path = resolveZipPath(itemHref, l.getAttribute('href')!); sheets.push(await sheetFor(cacheKey, path, () => readCss(path))); }
  doc.querySelectorAll('style').forEach((s) => sheets.push(parseSheet(s.textContent ?? '')));
  const basePx = sheets.find((s) => s.basePx !== 16)?.basePx ?? 16;

  const decl = new Map<Element, Decl>();
  const put = <K extends keyof Decl>(el: Element, k: K, spec: number, v: NonNullable<Decl[K]>[1]) => {
    let d = decl.get(el); if (!d) { d = {}; decl.set(el, d); }
    const cur = d[k] as [number, unknown] | undefined;
    if (!cur || spec >= cur[0]) (d as Record<string, unknown>)[k] = [spec, v];
  };
  // (Rules whose last part names a class, id or tag the chapter does not have are skipped without a query.)
  const classes = new Set<string>(); const tags = new Set<string>(['html', 'body']); const ids = new Set<string>();
  for (const e of body.querySelectorAll('*')) { tags.add(e.localName.toLowerCase()); for (const c of e.classList) classes.add(c); if (e.id) ids.add(e.id); }
  for (const c of body.classList) classes.add(c);
  for (const sh of sheets) for (const r of sh.rules) {
    if (r.need.cls.some((c) => !classes.has(c)) || (r.need.tag && !tags.has(r.need.tag)) || (r.need.id && !ids.has(r.need.id))) continue;
    let hits: Element[];
    try { hits = [...doc.querySelectorAll(r.sel)]; } catch { continue; }
    for (const el of hits) {
      if (el !== body && el !== html && !body.contains(el)) continue;
      if (r.align) put(el, 'align', r.spec, r.align);
      if (!keepStyles) {
        if (r.size) put(el, 'size', r.spec, r.size);
        if (r.bold !== undefined) put(el, 'bold', r.spec, r.bold);
        if (r.italic !== undefined) put(el, 'italic', r.spec, r.italic);
      }
    }
  }
  const probe = document.createElement('span');
  for (const el of [body, ...body.querySelectorAll('[style]')]) {
    const s = el.getAttribute('style'); if (!s) continue;
    probe.setAttribute('style', s); const st = probe.style;
    const a = alignOf(st.textAlign); if (a) put(el, 'align', 1e9, a);
    if (!keepStyles) {
      const fs = st.fontSize ? sizeOf(st.fontSize, basePx) : undefined; if (fs) put(el, 'size', 1e9, fs);
      const b = boldOf(st.fontWeight); if (b !== undefined) put(el, 'bold', 1e9, b);
      const i = italicOf(st.fontStyle); if (i !== undefined) put(el, 'italic', 1e9, i);
    }
  }

  // A paragraph's large first letter (a drop or raised initial): its first one or two letters (an opening quote mark
  // allowed) in an element of their own, ≥ 1.8 times the size around them or classed as an initial. Shown bold at the
  // text's size by default (the reader's «First letter of a chapter»); its own size up to 3.5× when asked.
  const initials = new Set<Element>();
  for (const b of body.querySelectorAll(BLOCK_SELECTOR)) {
    const w = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT); let first: Node | null = w.nextNode();
    while (first && !/\S/.test(first.textContent ?? '')) first = w.nextNode();
    if (!first) continue;
    for (let e = first.parentElement; e && e !== b; e = e.parentElement) {
      const letters = (e.textContent ?? '').trim().replace(/^["'“‘«„「『(\[]+/, '');
      if (!letters || letters.length > 2) break;
      if ((decl.get(e)?.size?.[1] ?? 1) >= 1.8 || /drop|initial|first-?letter|dropcap|big-?letter|lettrine/i.test(e.getAttribute('class') ?? '')) { e.setAttribute('data-kr-initial', ''); initials.add(e); break; }
    }
  }

  // Sizes, bold and italic: on the element that says them (sizes compound as em do), from 0.7 to 2 times (an initial: 3.5).
  if (!keepStyles) for (const [el, d] of decl) {
    if (el === html || el === body) continue;
    if (d.size) { const step = sizeStep(d.size[1], initials.has(el) ? 350 : 200); if (step) el.setAttribute('data-kr-fs', String(step)); }
    if (d.bold?.[1] && !/^(b|strong|h[1-6]|th)$/i.test(el.localName)) el.setAttribute('data-kr-b', '');
    if (d.italic?.[1] && !/^(i|em|cite|var|dfn)$/i.test(el.localName)) el.setAttribute('data-kr-i', '');
  }

  // Alignment: a block's own, else the nearest ancestor's that says one.
  const alignFor = (el: Element): Align | undefined => {
    for (let e: Element | null = el; e && e !== html; e = e.parentElement) { const a = decl.get(e)?.align?.[1]; if (a) return a; }
    return decl.get(html)?.align?.[1];
  };
  const blocks = [...body.querySelectorAll(BLOCK_SELECTOR)];
  const long: Element[] = []; let longCentred = 0;
  for (const b of blocks) {
    const a = alignFor(b); const len = (b.textContent ?? '').trim().length;
    if (len > 120) { long.push(b); if (a === 'center') longCentred++; }
    if (a && a !== 'none') b.setAttribute('data-kr-align', a);
  }
  if (long.length >= 4 && longCentred / long.length > 0.25) for (const b of long) if (b.getAttribute('data-kr-align') === 'center') b.removeAttribute('data-kr-align');

  // Short blocks whose every letter is bold or larger: heading-like lines (a title, a point-of-view name).
  for (const b of blocks) {
    const text = (b.textContent ?? '').trim(); if (!text || text.length > 80) continue;
    const w = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT); let all = true, any = false;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!/\S/.test(n.textContent ?? '')) continue; any = true;
      let strong = false;
      for (let e = n.parentElement; e; e = e.parentElement) {
        if (/^(b|strong|h[1-6])$/i.test(e.localName) || decl.get(e)?.bold?.[1] || (decl.get(e)?.size?.[1] ?? 1) >= 1.1) { strong = true; break; }
        if (e === b) break;
      }
      if (!strong) { all = false; break; }
    }
    if (any && all) b.setAttribute('data-kr-strong', '');
  }
}

/* ------------------------------------------------------------------ */
/* Chapter titles                                                     */
/* ------------------------------------------------------------------ */

const NUM_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final';
const ROMAN = '(?=[ivxlcdm]+(?![\\p{L}\\p{N}]))m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})';
const NUM = `(?:\\d+(?:[.\\-]\\d+)*|${ROMAN}|(?:${NUM_WORDS})(?:[\\s-](?:${NUM_WORDS}))*)(?![\\p{L}\\p{N}])`;
const EN_NUMBERED = `(?:(?:extra|bonus|side|special|final|short|secret|main)\\s+)?(?:chapter|chap\\.?|ch\\.|part|volume|vol\\.|book|act|episode|ep\\.|section|arc|stage|scene|canto|lesson|story|day)\\s*${NUM}`;
const EN_ALONE = `(?:(?:extra|bonus|side|special|short)\\s+(?:chapter|story|episode)|prologue|epilogue|interlude|afterword|foreword|preface|intermission|introduction|postscript|appendix|prelude|finale|coda|side\\s+story|bonus\\s+story|short\\s+story)(?:\\s*${NUM})?`;
const AR_ORD = '(?:الأول|الاول|الأولى|الاولى|الثاني|الثانية|الثالث|الثالثة|الرابع|الرابعة|الخامس|الخامسة|السادس|السادسة|السابع|السابعة|الثامن|الثامنة|التاسع|التاسعة|العاشر|العاشرة|الحادي|الحادية|الأخير|الأخيرة)(?:\\s+(?:عشر|عشرة|والعشرون|والعشرين|والثلاثون|والثلاثين))?';
const AR_NUMBERED = `(?:ال)?(?:فصل|باب|جزء|قسم|كتاب|مجلد|حلقة|مقالة|درس|مبحث|مطلب|فن|مقام|مشهد)\\s+(?:[0-9٠-٩]+|${AR_ORD})`;
const AR_ALONE = '(?:ال)?(?:مقدمة|مقدّمة|خاتمة|تمهيد|استهلال|مدخل|توطئة|فاتحة|تقديم|ملحق|تذييل|خلاصة)';
const CJK_NUMBERED = '第\\s*[0-9０-９一二三四五六七八九十百千零〇两兩]+\\s*[章話话回节節部巻卷幕篇集夜]';
const CJK_ALONE = '(?:序章|終章|终章|序幕|終幕|閑話|间章|間章|幕間|番外編|番外篇|番外|外伝|後日談|あとがき|まえがき|プロローグ|エピローグ|インタールード|楔子|尾声|後記|后记|前言|序言)';
const KO = '(?:제\\s*[0-9]+\\s*[장화부권편막]|[0-9]+\\s*[장화](?![가-힣])|프롤로그|에필로그|후기|외전|막간|서장|종장)';
const BARE = '(?:\\d+|[IVXLCDM]+)';
const LABEL = `(?:${EN_NUMBERED}|${EN_ALONE}|${AR_NUMBERED}|${AR_ALONE}|${CJK_NUMBERED}|${CJK_ALONE}|${KO})`;
const SEP = '[\\s:：.．、,،\\-–—|·ـ]';
const LABEL_ONLY = new RegExp(`^(?:${LABEL}|${BARE})${SEP}*$`, 'iu');
/** A label at the start and something after it: [whole match of label + separator]. */
const CJK_NEXT = '(?=[\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef])';
const LABEL_PLUS = new RegExp(`^(${LABEL})(?:(${SEP}+)|${CJK_NEXT})(?=\\S)`, 'iu');

const fold = (s: string): string => searchFormOf(s).replace(/[^\p{L}\p{N}]+/gu, '');
const sentences = (t: string): number => (t.match(/[.!?。！？؟](?=\s|$|["”’»」』)])/g) ?? []).length;
const endsSentence = (t: string): boolean => /[.!?。！？؟…]["”’»」』)]*$/.test(t.trim()) && !/^(?:\d+|[IVXLCDM]+)\.$/i.test(t.trim());
const TITLE_CLASS = /^(?:title|chapter|chap|heading|head|headline|chapter[-_]?(?:title|number|num|no|label|head|heading|name)|chap[-_]?(?:title|num|no|head)|ch[-_]?(?:title|num|head)|title[-_]?\w*|\w*[-_]title|part[-_]?title|book[-_]?title)$/i;
const TITLE_TYPE = /\b(?:title|chapter|subtitle|label|ordinal|halftitle|fulltitle)\b/i;

/** A block's text with line breaks as "\n", and the text pieces it is made of (to wrap the label's). */
function walkText(b: Element): { text: string; parts: { node: Node; start: number; end: number }[] } {
  const parts: { node: Node; start: number; end: number }[] = []; let text = '';
  const w = b.ownerDocument.createTreeWalker(b, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) { const s = n.textContent ?? ''; parts.push({ node: n, start: text.length, end: text.length + s.length }); text += s; }
    else if ((n as Element).localName === 'br') { parts.push({ node: n, start: text.length, end: text.length + 1 }); text += '\n'; }
  }
  return { text, parts };
}
const isSpacer = (b: Element): boolean => !/\S/.test((b.textContent ?? '').replace(/ /g, ' ')) && !b.querySelector('img, svg, image, video, audio, hr');
const titleClassed = (b: Element, section: Element): boolean => {
  for (let e: Element | null = b; e && e !== section; e = e.parentElement) {
    if (e !== b && (e.textContent ?? '').length > 200) break;
    if ([...e.classList].some((c) => TITLE_CLASS.test(c))) return true;
    const ty = e.getAttribute('epub:type') ?? ''; if (ty && TITLE_TYPE.test(ty)) return true;
  }
  return false;
};
const isSceneBreak = (b: Element): boolean => { const t = (b.textContent ?? '').trim(); return b.localName === 'hr' || (!!t && t.length <= 24 && /^[\s*•·◆◇○●■□☆★#~⁂※—–\-_=+.♦◈❖✦✧❦❧§]+$/u.test(t)); };

/** Wrap the first `len` characters of a block (a label and its separator, a line break included) in span.kr-title-label. */
function wrapLabel(b: Element, len: number): void {
  const { parts } = walkText(b);
  for (const p of parts) {
    if (p.start >= len) break;
    if (p.node.nodeType !== Node.TEXT_NODE) { (p.node as Element).classList.add('kr-title-label'); continue; }
    const node = p.node as Text;
    if (p.end > len) { node.splitText(len - p.start); }
    if (!(node.textContent ?? '').length) continue;
    const span = b.ownerDocument.createElement('span'); span.className = 'kr-title-label';
    node.replaceWith(span); span.append(node);
  }
}

/**
 * Mark a chapter's title (data-kr-title = "label" | "title" | "sub") and its spacer paragraphs (data-kr-spacer). `toc`:
 * the contents' titles that lead into this chapter (none: found by headings, title classes and labels alone).
 * Block counts and the text stay as they are. Marked once (section[data-kr-titles]).
 */
export function markChapterTitles(section: HTMLElement, toc: string[] = []): void {
  if (section.hasAttribute('data-kr-titles')) return;
  section.setAttribute('data-kr-titles', '');
  const blocks = [...section.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter((b) => !b.closest('table, nav'));
  const spacers = new Set<Element>();
  for (const b of blocks) if (isSpacer(b) && !b.querySelector(BLOCK_SELECTOR)) { b.setAttribute('data-kr-spacer', ''); spacers.add(b); }
  // The opening: the chapter's first text blocks, up to the first long paragraph.
  const opening: HTMLElement[] = [];
  for (const b of blocks) {
    if (spacers.has(b) || !(b.textContent ?? '').trim() || b.querySelector(BLOCK_SELECTOR)) continue;
    opening.push(b); if (opening.length >= 4) break;
  }
  const tocParts = toc.map((l) => l.split(/\s*[:：|—–]\s*|\s+-\s+|\n/).map(fold).filter(Boolean)).filter((p) => p.length);
  const ptr = tocParts.map(() => 0);
  /** The contents' parts this block says next (whole parts only): the pointers it moves to, or null. */
  const tocStep = (f: string): number[] | null => {
    let hit = false; const next = ptr.slice();
    tocParts.forEach((parts, k) => {
      let acc = ''; for (let j = ptr[k]; j < parts.length; j++) { acc += parts[j]; if (acc === f) { next[k] = j + 1; hit = true; return; } if (acc.length >= f.length) return; }
    });
    return hit ? next : null;
  };
  type Pick = { b: HTMLElement; text: string; only: boolean; plus: RegExpExecArray | null; lead: number };
  const run: Pick[] = []; let prevLabel = false;
  for (const b of opening) {
    if (run.length >= 3) break;
    const { text: raw } = walkText(b); const text = raw.trim();
    const heading = /^h[1-6]$/i.test(b.localName);
    if (!heading && (text.length > 120 || sentences(text) >= 2)) break;
    const f = fold(text); if (!f) break;
    const step = tocStep(f);
    const only = LABEL_ONLY.test(text);
    let plus = LABEL_PLUS.exec(raw.replace(/^\s+/, ''));
    if (plus) { const rest = raw.replace(/^\s+/, '').slice(plus[0].length).trim(); const spaceOnly = !plus[2] || !/[^\s]/.test(plus[2]); if (!rest || (endsSentence(rest) && !step) || (spaceOnly && /^[a-z]/.test(rest))) plus = null; }
    const classed = titleClassed(b, section);
    const ok = heading || !!step || (classed && !endsSentence(text)) || only || (run.length === 0 && !!plus) || (prevLabel && !endsSentence(text) && text.length <= 100);
    if (!ok) break;
    if (step) step.forEach((v, k) => { ptr[k] = v; });
    run.push({ b, text, only, plus, lead: raw.length - raw.replace(/^\s+/, '').length }); prevLabel = only;
    if (tocParts.some((p, k) => ptr[k] === p.length)) break;
  }
  // A lone bare number is not a title.
  if (run.length === 1 && /^(?:\d+|[IVXLCDM]+)\.?$/i.test(run[0].text) && !/^h[1-6]$/i.test(run[0].b.localName)) run.length = 0;
  const hasTitle = run.some((p) => !p.only);
  for (const p of run) {
    p.b.setAttribute('data-kr-title', p.only && hasTitle ? 'label' : 'title');
    if (!p.only && p.plus) wrapLabel(p.b, p.lead + p.plus[0].length);
  }
  // Heading-like lines: short, bold or larger, standing alone right under the title or after a scene break.
  const subOk = (b: HTMLElement): boolean => {
    const t = (b.textContent ?? '').trim();
    return !!t && t.length <= 40 && t.split(/\s+/).length <= 6 && !endsSentence(t) && b.hasAttribute('data-kr-strong') && !b.hasAttribute('data-kr-title');
  };
  const nextText = (i: number): number => { let j = i + 1; while (j < blocks.length && (spacers.has(blocks[j]) || blocks[j].querySelector(BLOCK_SELECTOR))) j++; return j; };
  const standsAlone = (j: number): boolean => { const n = j + 1; return n >= blocks.length || spacers.has(blocks[n]) || isSceneBreak(blocks[n]) || !blocks[n].hasAttribute('data-kr-strong'); };
  if (run.length) {
    const j = nextText(blocks.indexOf(run[run.length - 1].b));
    if (j < blocks.length && subOk(blocks[j]) && standsAlone(j)) blocks[j].setAttribute('data-kr-title', 'sub');
  }
  for (let i = 0; i < blocks.length; i++) {
    // (A centred bold line alone between two spacers, mid-chapter: a change of point of view.)
    if (spacers.has(blocks[i - 1]) && spacers.has(blocks[i + 1]) && blocks[i].getAttribute('data-kr-align') === 'center' && subOk(blocks[i])) { blocks[i].setAttribute('data-kr-title', 'sub'); continue; }
    if (!isSceneBreak(blocks[i])) continue;
    const j = nextText(i);
    if (j < blocks.length && subOk(blocks[j]) && standsAlone(j)) blocks[j].setAttribute('data-kr-title', 'sub');
  }
}

/* ------------------------------------------------------------------ */
/* Names shown, settings, language                                    */
/* ------------------------------------------------------------------ */

const STRIP = new RegExp(`^\\s*(?:${LABEL})(?:${SEP}+|${CJK_NEXT})(?=\\S)`, 'iu');
/** A chapter's name without its leading label («Chapter 1: The Holy Country» → «The Holy Country»); a name that is a
 *  label alone is kept as it is. Only for showing: stored names, matching and search use the name as it is. */
export function stripChapterLabel(name: string): string {
  const m = STRIP.exec(name); if (!m) return name;
  const rest = name.slice(m[0].length).trim();
  return rest ? rest : name;
}

/** The chapter-title settings on the reader's root. */
export function applyTitleSettings(root: HTMLElement, s: { chapterTitles?: string; hideChapterWord?: boolean; bookSizes?: boolean; firstLetter?: string }): void {
  root.dataset.titles = s.chapterTitles || 'center';
  root.dataset.firstLetter = s.firstLetter || 'bold';
  root.classList.toggle('hide-chapter-word', !!s.hideChapterWord);
  root.classList.toggle('book-sizes', s.bookSizes !== false);
}

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;
/**
 * What a flowing book needs before its blocks are counted: a language for hyphenation where it has none (the book's
 * own, else the interface's when the text is in the same script — Latin text with an English interface), and the
 * chapter titles of formats that are not marked as they are made (each chapter once; EPUB chapters are already).
 */
export function prepareFlow(el: HTMLElement, bookLang: string | undefined, uiLang: string): void {
  if (!el.getAttribute('lang') && !el.querySelector('[lang]')) {
    // (The first few thousand letters, not the whole book's text: a long novel's is megabytes.)
    let sample = ''; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && sample.length < 3000; n = w.nextNode()) sample += n.textContent ?? '';
    const latin = !!sample.trim() && el.getAttribute('dir') !== 'rtl' && !CJK_RE.test(sample) && !/[֐-ࣿ]/.test(sample);
    const lang = bookLang || (uiLang === 'en' && latin ? 'en' : '');
    if (lang) el.setAttribute('lang', lang.split('-')[0]);
  }
  const sections = [...el.querySelectorAll<HTMLElement>(':scope > .kr-chapter')];
  for (const s of sections.length ? sections : [el]) if (!s.classList.contains('kr-shell')) markChapterTitles(s);
}
