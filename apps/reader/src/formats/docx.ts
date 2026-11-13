// Minimal DOCX → HTML conversion: paragraphs, headings, lists, basic run
// formatting, tables, images, footnotes. Enough for comfortable reading.
import JSZip from 'jszip';
import type { FlowHandler, FlowRender, RenderContext } from './types';
import { titleFromFileName } from './types';
import { UrlPool, collectImages, el, markDirections, parseXml, resolveZipPath, tocFromHeadings, zipFile } from './shared';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const V = 'urn:schemas-microsoft-com:vml';

type Rels = Map<string, string>;

async function readRels(zip: JSZip, partPath: string): Promise<Rels> {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const name = partPath.split('/').pop();
  const relPath = `${dir}/_rels/${name}.rels`;
  const rels: Rels = new Map();
  const f = zipFile(zip, relPath);
  if (!f) return rels;
  const doc = parseXml(await f.async('text'));
  doc.querySelectorAll('Relationship').forEach((r) => {
    const target = r.getAttribute('Target') ?? '';
    const mode = r.getAttribute('TargetMode');
    rels.set(r.getAttribute('Id') ?? '', mode === 'External' ? target : resolveZipPath(partPath, target));
  });
  return rels;
}

function child(e: Element | null, ns: string, name: string): Element | null {
  if (!e) return null;
  for (const c of e.children) if (c.localName === name && c.namespaceURI === ns) return c;
  return null;
}
function attr(e: Element | null, ns: string, name: string): string | null {
  return e ? e.getAttributeNS(ns, name) ?? e.getAttribute(`w:${name}`) : null;
}

export async function docxToHtml(file: Blob, ctx: RenderContext, pool: UrlPool): Promise<{ root: HTMLElement; meta: { title?: string; author?: string }; zip: JSZip }> {
  const zip = await JSZip.loadAsync(file);
  const docPath = 'word/document.xml';
  const docFile = zipFile(zip, docPath);
  if (!docFile) throw new Error('document.xml missing');
  const doc = parseXml(await docFile.async('text'));
  const rels = await readRels(zip, docPath);

  // Styles: map style ids to heading levels / names.
  const styleMap = new Map<string, { name: string; outline?: number; bold?: boolean; numId?: string; ilvl?: number }>();
  const stylesFile = zipFile(zip, 'word/styles.xml');
  if (stylesFile) {
    const sd = parseXml(await stylesFile.async('text'));
    sd.querySelectorAll('style').forEach((s) => {
      const id = attr(s, W, 'styleId') ?? '';
      const name = attr(child(s, W, 'name'), W, 'val') ?? id;
      const outline = attr(child(child(s, W, 'pPr'), W, 'outlineLvl'), W, 'val');
      const sNum = child(child(s, W, 'pPr'), W, 'numPr');
      const numId = attr(child(sNum, W, 'numId'), W, 'val');
      const ilvl = attr(child(sNum, W, 'ilvl'), W, 'val');
      styleMap.set(id, { name, outline: outline != null ? Number(outline) : undefined, bold: !!child(child(s, W, 'rPr'), W, 'b'), numId: numId ?? undefined, ilvl: ilvl != null ? Number(ilvl) : undefined });
    });
  }
  const numbering = await readNumbering(zip);

  // Footnotes.
  const footnotes = new Map<string, Element>();
  const fnFile = zipFile(zip, 'word/footnotes.xml');
  if (fnFile) parseXml(await fnFile.async('text')).querySelectorAll('footnote').forEach((f) => footnotes.set(attr(f, W, 'id') ?? '', f));

  // Metadata
  let meta: { title?: string; author?: string } = {};
  const core = zipFile(zip, 'docProps/core.xml');
  if (core) {
    const cd = parseXml(await core.async('text'));
    meta = { title: cd.getElementsByTagName('dc:title')[0]?.textContent?.trim() || undefined, author: cd.getElementsByTagName('dc:creator')[0]?.textContent?.trim() || undefined };
  }

  const root = el('div', 'kr-content kr-docx');
  const imageTasks: Promise<void>[] = [];
  const fnOut: HTMLElement[] = [];

  const headingLevel = (p: Element): number | null => {
    const pPr = child(p, W, 'pPr');
    const styleId = attr(child(pPr, W, 'pStyle'), W, 'val');
    const st = styleId ? styleMap.get(styleId) : undefined;
    const m = /^(?:heading|Heading|عنوان)\s*(\d)/.exec(st?.name ?? '') ?? /^Heading(\d)$/.exec(styleId ?? '');
    if (m) return Math.min(6, Number(m[1]));
    if (st?.outline != null && st.outline < 6) return st.outline + 1;
    if (st?.name === 'Title' || st?.name === 'Subtitle') return 1;
    return null;
  };

  const renderRun = (r: Element, target: HTMLElement) => {
    const rPr = child(r, W, 'rPr');
    let wrap: HTMLElement | null = null;
    const push = (tag: string) => { const e = document.createElement(tag); (wrap ?? target).appendChild(e); wrap = e; };
    if (rPr) {
      if (child(rPr, W, 'b') && attr(child(rPr, W, 'b'), W, 'val') !== '0' && attr(child(rPr, W, 'b'), W, 'val') !== 'false') push('strong');
      if (child(rPr, W, 'i') && attr(child(rPr, W, 'i'), W, 'val') !== '0') push('em');
      if (child(rPr, W, 'u')) push('u');
      if (child(rPr, W, 'strike') || child(rPr, W, 'dstrike')) push('s');
      const va = attr(child(rPr, W, 'vertAlign'), W, 'val');
      if (va === 'superscript') push('sup'); else if (va === 'subscript') push('sub');
    }
    const dest: HTMLElement = wrap ?? target;
    for (const c of r.children) {
      switch (c.localName) {
        case 't': dest.appendChild(document.createTextNode(c.textContent ?? '')); break;
        case 'tab': dest.appendChild(document.createTextNode('\t')); break;
        case 'br': if (attr(c, W, 'type') === 'page') target.dataset.pageBreak = '1'; else dest.appendChild(document.createElement('br')); break;
        case 'sym': dest.appendChild(document.createTextNode(String.fromCharCode(parseInt(attr(c, W, 'char') ?? '20', 16)))); break;
        case 'footnoteReference': {
          const id = attr(c, W, 'id') ?? '';
          const fn = footnotes.get(id);
          if (fn) {
            const n = fnOut.length + 1;
            const sup = document.createElement('sup');
            const a = document.createElement('a');
            a.href = `#${ctx.id(`fn${n}`)}`; a.textContent = `[${n}]`; a.setAttribute('data-kr-anchor', ctx.id(`fn${n}`));
            sup.appendChild(a); dest.appendChild(sup);
            const li = el('li'); li.id = ctx.id(`fn${n}`);
            for (const p of fn.children) if (p.localName === 'p') renderParagraph(p, li);
            fnOut.push(li);
          }
          break;
        }
        case 'drawing': {
          const blip = c.getElementsByTagNameNS(A, 'blip')[0];
          const rid = blip?.getAttributeNS(R, 'embed');
          const path = rid ? rels.get(rid) : undefined;
          if (path) {
            const img = document.createElement('img');
            const descr = c.getElementsByTagName('wp:docPr')[0]?.getAttribute('descr') ?? '';
            if (descr) img.alt = descr;
            dest.appendChild(img);
            pool.lazy(zip, path, img, 'src');
          }
          break;
        }
        case 'pict': {
          const imagedata = c.getElementsByTagNameNS(V, 'imagedata')[0];
          const rid = imagedata?.getAttributeNS(R, 'id');
          const path = rid ? rels.get(rid) : undefined;
          if (path) {
            const img = document.createElement('img');
            dest.appendChild(img);
            pool.lazy(zip, path, img, 'src');
          }
          break;
        }
      }
    }
  };

  const renderInline = (node: Element, target: HTMLElement) => {
    for (const c of node.children) {
      if (c.localName === 'r') renderRun(c, target);
      else if (c.localName === 'hyperlink') {
        const rid = c.getAttributeNS(R, 'id');
        const href = rid ? rels.get(rid) : undefined;
        const a = document.createElement('a');
        if (href && /^https?:/i.test(href)) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
        renderInline(c, a);
        target.appendChild(a);
      } else if (c.localName === 'smartTag' || c.localName === 'sdt' || c.localName === 'ins' || c.localName === 'fldSimple') {
        renderInline(c.localName === 'sdt' ? child(c, W, 'sdtContent') ?? c : c, target);
      }
    }
  };

  // Lists: each container (the body, a table cell, a footnote) keeps the lists open in it, one per level, nested
  // as Word shows them; the numbers are counted per list (numId) and level, as Word counts them — on across a
  // paragraph between items, a deeper level starting again under each new item above it.
  type Open = { list: HTMLElement; ilvl: number; key: string };
  const openLists = new Map<HTMLElement, Open[]>();
  const counters = new Map<string, number[]>();
  const endLists = (target: HTMLElement) => openLists.delete(target);

  const listItem = (target: HTMLElement, numId: string, ilvl: number, lv: NumLevel | undefined): HTMLElement => {
    const ordered = !!lv && lv.fmt !== 'bullet';
    const key = `${ordered ? 'ol' : 'ul'}:${numId}`;
    let stack = openLists.get(target);
    if (!stack) { stack = []; openLists.set(target, stack); }
    while (stack.length && stack[stack.length - 1].ilvl > ilvl) stack.pop();
    if (stack.length && stack[stack.length - 1].ilvl === ilvl && stack[stack.length - 1].key !== key) stack.pop();
    if (!stack.length || stack[stack.length - 1].ilvl < ilvl) {
      const list = el(ordered ? 'ol' : 'ul');
      if (ordered) list.className = 'kr-wnum';
      const parentLi = stack.length ? (stack[stack.length - 1].list.lastElementChild as HTMLElement | null) : null;
      (parentLi ?? target).appendChild(list);
      stack.push({ list, ilvl, key });
    }
    const li = el('li');
    if (ordered && lv) {
      const def = numbering.get(numId);
      const c = counters.get(numId) ?? []; counters.set(numId, c);
      const startOf = (l: number) => def?.levels.get(l)?.start ?? 1;
      c[ilvl] = c[ilvl] === undefined ? startOf(ilvl) : c[ilvl] + 1;
      c.length = ilvl + 1;
      // "%1." or "%1.%2." — each %n the count of that level in its own format.
      const text = (lv.text ?? `%${ilvl + 1}.`).replace(/%([1-9])/g, (_m, d: string) => {
        const l = Number(d) - 1; const n = c[l] ?? startOf(l);
        return formatNumber(n, l === ilvl ? lv.fmt : def?.levels.get(l)?.fmt ?? 'decimal');
      });
      li.setAttribute('value', String(c[ilvl]));
      li.dataset.krNum = text;
    }
    stack[stack.length - 1].list.appendChild(li);
    return li;
  };

  const renderParagraph = (p: Element, target: HTMLElement) => {
    const pPr = child(p, W, 'pPr');
    const numPr = child(pPr, W, 'numPr');
    const style = styleMap.get(attr(child(pPr, W, 'pStyle'), W, 'val') ?? '');
    const styleName = style?.name ?? '';
    const numId = attr(child(numPr, W, 'numId'), W, 'val') ?? style?.numId;
    const ilvl = Math.max(0, Math.min(8, Number(attr(child(numPr, W, 'ilvl'), W, 'val') ?? style?.ilvl ?? 0) || 0));
    // (numId 0 takes a paragraph out of a list its style would put it in.)
    const isList = numId != null ? numId !== '0' : /\blist\b/i.test(styleName);
    const level = headingLevel(p);
    let elNode: HTMLElement;
    if (isList && !level) {
      // (A list numbering.xml does not describe is shown with bullets, as before; a format this reader does not
      // draw comes out in plain digits — formatNumber.)
      elNode = listItem(target, numId ?? '', ilvl, numId != null ? numbering.get(numId)?.levels.get(ilvl) : undefined);
    } else {
      endLists(target);
      elNode = el(level ? (`h${level}` as 'h1') : 'p');
      if (child(pPr, W, 'pageBreakBefore') || child(pPr, W, 'sectPr')) elNode.dataset.pageBreak = '1';
      const jc = attr(child(pPr, W, 'jc'), W, 'val');
      if (jc === 'center') elNode.style.textAlign = 'center';
      if (attr(child(pPr, W, 'bidi'), W, 'val') !== '0' && child(pPr, W, 'bidi')) elNode.setAttribute('dir', 'rtl');
      target.appendChild(elNode);
    }
    renderInline(p, elNode);
    if (!elNode.textContent?.trim() && !elNode.querySelector('img, ol, ul')) {
      const list = elNode.parentElement;
      elNode.remove();
      if (list && (list.tagName === 'OL' || list.tagName === 'UL') && !list.children.length) {
        list.remove();
        const stack = openLists.get(target); if (stack) { const i = stack.findIndex((o) => o.list === list); if (i >= 0) stack.splice(i); }
      }
    }
  };

  const renderTable = (tbl: Element, target: HTMLElement) => {
    const table = el('table');
    // Vertically merged cells: the first ("restart") cell grows a rowspan; continuation cells are dropped.
    const open = new Map<number, HTMLTableCellElement>();
    for (const tr of tbl.children) {
      if (tr.localName !== 'tr') continue;
      const row = el('tr');
      let col = 0;
      for (const tc of tr.children) {
        if (tc.localName !== 'tc') continue;
        const pr = child(tc, W, 'tcPr');
        const span = Number(attr(child(pr, W, 'gridSpan'), W, 'val') ?? 1);
        const vm = child(pr, W, 'vMerge');
        if (vm && (attr(vm, W, 'val') ?? 'continue') !== 'restart') { const above = open.get(col); if (above) above.rowSpan += 1; col += span; continue; }
        const cell = el('td') as HTMLTableCellElement;
        if (span > 1) cell.colSpan = span;
        renderBlocks(tc, cell);
        row.appendChild(cell);
        if (vm) open.set(col, cell); else open.delete(col);
        col += span;
      }
      table.appendChild(row);
    }
    target.appendChild(table);
  };

  const renderBlocks = (parent: Element, target: HTMLElement) => {
    for (const c of parent.children) {
      if (c.localName === 'p') renderParagraph(c, target);
      else if (c.localName === 'tbl') { endLists(target); renderTable(c, target); }
      else if (c.localName === 'sdt') renderBlocks(child(c, W, 'sdtContent') ?? c, target);
      else if (c.localName === 'sectPr') continue;
    }
  };

  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  if (body) {
    // A long document is rendered a few hundred blocks at a time, letting the page breathe between (the
    // opening spinner keeps turning; a tap still answers), rather than in one long stretch that a phone's
    // web view may give up on.
    const kids = Array.from(body.children); let n = 0;
    for (const c of kids) {
      if (c.localName === 'p') renderParagraph(c, root);
      else if (c.localName === 'tbl') { endLists(root); renderTable(c, root); }
      else if (c.localName === 'sdt') renderBlocks(child(c, W, 'sdtContent') ?? c, root);
      if (++n % 400 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (fnOut.length) {
    const hr = el('hr'); root.appendChild(hr);
    const ol = el('ol', 'kr-footnotes'); fnOut.forEach((li) => ol.appendChild(li)); root.appendChild(ol);
  }
  await Promise.all(imageTasks);
  chapterize(root, ctx);
  return { root, meta, zip };
}

/** One level of a Word list: its number format, its text ("%1.", "(%2)"), and where it starts. */
type NumLevel = { fmt: string; text?: string; start?: number };
type NumDef = { levels: Map<number, NumLevel> };

/** word/numbering.xml: each list (w:num) with its levels, from its abstract definition and its overrides. */
async function readNumbering(zip: JSZip): Promise<Map<string, NumDef>> {
  const out = new Map<string, NumDef>();
  const f = zipFile(zip, 'word/numbering.xml');
  if (!f) return out;
  let nd: Document;
  try { nd = parseXml(await f.async('text')); } catch { return out; }
  const levelOf = (lvl: Element): NumLevel => {
    const start = attr(child(lvl, W, 'start'), W, 'val');
    return { fmt: attr(child(lvl, W, 'numFmt'), W, 'val') ?? 'decimal', text: attr(child(lvl, W, 'lvlText'), W, 'val') ?? undefined, start: start != null && !Number.isNaN(Number(start)) ? Number(start) : undefined };
  };
  const levelsOf = (parent: Element, into: Map<number, NumLevel>) => {
    for (const lvl of parent.children) if (lvl.localName === 'lvl') into.set(Number(attr(lvl, W, 'ilvl') ?? 0), levelOf(lvl));
  };
  const abstracts = new Map<string, Element>();
  for (const c of nd.documentElement?.children ?? []) if (c.localName === 'abstractNum') abstracts.set(attr(c, W, 'abstractNumId') ?? '', c);
  const abstractLevels = (id: string, seen = new Set<string>()): Map<number, NumLevel> => {
    const levels = new Map<number, NumLevel>();
    const a = abstracts.get(id); if (!a || seen.has(id)) return levels; seen.add(id);
    levelsOf(a, levels);
    // (A definition that only points at a numbering style takes that style's levels.)
    if (!levels.size) {
      const link = attr(child(a, W, 'numStyleLink'), W, 'val');
      if (link) for (const [aid, other] of abstracts) if (attr(child(other, W, 'styleLink'), W, 'val') === link && aid !== id) return abstractLevels(aid, seen);
    }
    return levels;
  };
  for (const c of nd.documentElement?.children ?? []) {
    if (c.localName !== 'num') continue;
    const levels = new Map(abstractLevels(attr(child(c, W, 'abstractNumId'), W, 'val') ?? ''));
    for (const o of c.children) {
      if (o.localName !== 'lvlOverride') continue;
      const il = Number(attr(o, W, 'ilvl') ?? 0);
      const lvl = child(o, W, 'lvl'); if (lvl) levels.set(il, levelOf(lvl));
      const so = attr(child(o, W, 'startOverride'), W, 'val');
      if (so != null && !Number.isNaN(Number(so))) levels.set(il, { ...(levels.get(il) ?? { fmt: 'decimal' }), start: Number(so) });
    }
    out.set(attr(c, W, 'numId') ?? '', { levels });
  }
  return out;
}

const ABJAD = 'أبجدهوزحطيكلمنسعفصقرشتثخذضظغ';
const ALPHA = 'أبتثجحخدذرزسشصضطظعغفقكلمنهوي';
const roman = (n: number): string => {
  let out = ''; for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as [number, string][]) while (n >= v) { out += r; n -= v; }
  return out;
};
/** Word's letters: a…z, then aa…zz, aaa… */
const letters = (n: number): string => String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
const digitsIn = (n: number, zero: number): string => String(n).replace(/[0-9]/g, (d) => String.fromCodePoint(zero + Number(d)));

/** A list number in a Word number format; one this reader does not draw is written in plain digits. */
export function formatNumber(n: number, fmt: string): string {
  if (fmt === 'none') return '';
  if (fmt === 'bullet') return '•';
  if (n < 1 && fmt !== 'decimal' && fmt !== 'decimalZero') return String(n);
  switch (fmt) {
    case 'decimalZero': return n < 10 ? `0${n}` : String(n);
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return n < 4000 ? roman(n) : String(n);
    case 'upperRoman': return n < 4000 ? roman(n).toUpperCase() : String(n);
    case 'arabicAbjad': return n <= ABJAD.length ? ABJAD[n - 1] : String(n);
    case 'arabicAlpha': return n <= ALPHA.length ? ALPHA[n - 1] : String(n);
    // (Word calls the Arabic-Indic digits ١٢٣ "Hindi numbers".)
    case 'hindiNumbers': return digitsIn(n, 0x660);
    case 'decimalFullWidth': case 'decimalFullWidth2': return digitsIn(n, 0xff10);
    default: return String(n);
  }
}

/**
 * A long document cut into chapters (`section.kr-chapter`, as an EPUB's), so the reader lays out one at a
 * time: at its top headings when it has a few, else at its page breaks, else every few hundred blocks; a
 * short document stays one piece. The footnotes go with the last chapter.
 */
function chapterize(root: HTMLElement, ctx: RenderContext): void {
  const blocks = Array.from(root.children) as HTMLElement[];
  if (blocks.length < 120) return;
  const text = root.textContent?.length ?? 0;
  if (text < 60_000 && blocks.length < 400) return;
  const isHead = (b: HTMLElement, lv: string) => b.tagName === lv;
  const h1 = blocks.filter((b) => isHead(b, 'H1')).length, h2 = blocks.filter((b) => isHead(b, 'H2')).length;
  const cutAt = (b: HTMLElement) => (h1 >= 3 ? isHead(b, 'H1') : h2 >= 3 ? isHead(b, 'H1') || isHead(b, 'H2') : false);
  const hasCuts = h1 >= 3 || h2 >= 3 || blocks.some((b) => b.dataset.pageBreak);
  const sections: HTMLElement[][] = [[]];
  let since = 0;
  for (const b of blocks) {
    const cut = hasCuts ? (cutAt(b) || (!(h1 >= 3 || h2 >= 3) && !!b.dataset.pageBreak)) : since >= 300;
    const footnotes = b.tagName === 'OL' && b.classList.contains('kr-footnotes') || (b.tagName === 'HR' && b.nextElementSibling?.classList.contains('kr-footnotes'));
    // (A chapter must have something in it; very long chapters without headings are still cut by size.)
    if (!footnotes && (cut || since >= 1200) && sections[sections.length - 1].length) { sections.push([]); since = 0; }
    sections[sections.length - 1].push(b); since++;
  }
  if (sections.length < 2) return;
  sections.forEach((blocksOf, i) => {
    const sec = document.createElement('section'); sec.className = 'kr-chapter'; sec.id = ctx.id(`c${i}`);
    root.appendChild(sec); blocksOf.forEach((b) => sec.appendChild(b));
  });
}

export const docxHandler: FlowHandler = {
  kind: 'flow',
  format: 'docx',
  async readMeta(file, fileName) {
    try {
      const zip = await JSZip.loadAsync(file);
      const core = zipFile(zip, 'docProps/core.xml');
      if (core) {
        const cd = parseXml(await core.async('text'));
        const title = cd.getElementsByTagName('dc:title')[0]?.textContent?.trim();
        const author = cd.getElementsByTagName('dc:creator')[0]?.textContent?.trim();
        return { title: title || titleFromFileName(fileName), author: author || undefined };
      }
    } catch { /* fall through */ }
    return { title: titleFromFileName(fileName) };
  },
  async render(file, ctx): Promise<FlowRender> {
    const pool = new UrlPool();
    const { root, zip } = await docxToHtml(file, ctx, pool);
    const rtl = markDirections(root);
    return { element: root, toc: tocFromHeadings(root, ctx, 'docx'), images: collectImages(root, ctx, 'docx', pool, zip), rtl, dispose: () => pool.dispose(), resolveImages: () => pool.resolveAll(root) };
  },
};
