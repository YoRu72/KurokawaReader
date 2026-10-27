// File conversion. Every book is first read into one neutral document (chapters of
// HTML, pictures, embedded fonts, direction), then written out as EPUB (also the
// Kindle route — Send to Kindle takes EPUB), DOCX, PDF, HTML, Markdown or plain text.
//
// PDFs are the hard case: their text comes out as positioned fragments, so lines are
// rebuilt from geometry (right-to-left when the line is Arabic/Hebrew), paragraphs
// from the spacing, headings from the font size — and the fonts the PDF embeds are
// carried over, so an Arabic, Japanese or Chinese PDF keeps its look in the EPUB.
import { joinLine, cleanPdfText } from './pdftext';
import { findVertical, plainVerticalForms } from './pdfvertical';
import JSZip from 'jszip';
import { packDocx, storeCompressed, type ZipLike } from './ziputil';
import { imageSize } from './imagesize';
import { db, type Book } from './db';
import { flowHandlerFor } from './formats';
import { loadPdfjs, offscreen } from './formats/pdf';
import { getSettings } from './settings';
import { isRtlText } from './i18n';

/** Formats the converter can read. */
export const convertible = (f: Book['format']) => !['image', 'cbz', 'anki', 'audio', 'unknown'].includes(f);

export type Target = 'epub' | 'kindle' | 'docx' | 'pdf' | 'html' | 'md' | 'txt' | 'fb2' | 'odt' | 'rtf' | 'cbz';
export interface Chapter { title: string; html: string; rtl: boolean }
export interface ConvDoc {
  title: string; author?: string; lang?: string; rtl: boolean;
  chapters: Chapter[];
  images: Map<string, Blob>;              // url used in html → data
  fonts: Map<string, { blob: Blob; ext: string }>;   // css family → font file
  cover?: Blob;
}
export type Progress = (msg: string, pct?: number) => void;

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export async function readDocument(book: Book, file: Blob, progress: Progress, password?: string): Promise<ConvDoc> {
  if (book.format === 'pdf') return readPdf(book, file, progress, password);
  if (!convertible(book.format)) throw new Error('unsupported');
  const handler = flowHandlerFor(book.format);
  if (!handler) throw new Error('unsupported');
  progress('render', 5);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;visibility:hidden';
  document.body.appendChild(host);
  const render = await handler.render(file, { bookId: book.id, bookTitle: book.title, publisherStyles: false, id: (s) => `cv-${s}` });
  host.appendChild(render.element);
  try {
    await render.resolveImages?.();
    progress('images', 25);
    const images = new Map<string, Blob>();
    const imgs = Array.from(render.element.querySelectorAll<HTMLImageElement>('img'));
    let n = 0;
    for (const img of imgs) {
      const src = img.getAttribute('src'); if (!src || images.has(src)) continue;
      try { const b = await (await fetch(src)).blob(); if (b.size) images.set(src, b); } catch { /* skip */ }
      progress('images', 25 + Math.round((++n / Math.max(1, imgs.length)) * 25));
    }
    const sections = Array.from(render.element.querySelectorAll<HTMLElement>(':scope > .kr-chapter'));
    const parts = sections.length ? sections : [render.element];
    const chapters: Chapter[] = parts.map((el, i) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('style, script, .chapter-nav, [data-kr-lazy]').forEach((x) => x.remove());
      clone.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
      // Namespaced leftovers (epub:type, xlink:…) break XML consumers; drop them along with data-* bookkeeping.
      clone.querySelectorAll('*').forEach((x) => { for (const a of Array.from(x.attributes)) if (a.name.includes(':') || a.name.startsWith('data-') || a.name.startsWith('on')) x.removeAttribute(a.name); });
      clone.querySelectorAll('mark[data-hl]').forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
      const text = clone.textContent ?? '';
      const title = render.toc.find((tI) => el.querySelector(`#${CSS.escape(tI.anchor)}`) || el.id === tI.anchor)?.label || el.querySelector('h1, h2, h3')?.textContent?.trim() || (parts.length > 1 ? `${i + 1}` : book.title);
      return { title: title.trim(), html: clone.innerHTML, rtl: isRtlText(text.slice(0, 2000)) };
    }).filter((c) => c.html.trim());
    return { title: book.title, author: book.author, lang: book.language, rtl: render.rtl, chapters, images, fonts: new Map(), cover: book.cover };
  } finally { render.dispose(); host.remove(); }
}

/** Text items of a PDF page rebuilt into lines and paragraphs with their fonts. */
async function readPdf(book: Book, file: Blob, progress: Progress, password?: string): Promise<ConvDoc> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  // (Protected files: the password given or remembered; a copy decrypted here when pdf.js cannot read it.)
  const { openPdfjs, reopenDecrypted, looksGarbled } = await import('./pdfkeys');
  const jsOpts = { useSystemFonts: false, fontExtraProperties: true };
  let opened = await openPdfjs(pdfjs, data, jsOpts, { password });
  if (opened.encrypted) {
    const tc = await (await opened.doc.getPage(1)).getTextContent();
    const text = (tc.items as { str?: string }[]).map((i) => i.str ?? '').join('');
    if (looksGarbled(text, text.length)) opened = (await reopenDecrypted(pdfjs, opened, jsOpts)) ?? opened;
  }
  const task = { destroy: opened.destroy };
  const doc = opened.doc;
  const fonts = new Map<string, { blob: Blob; ext: string }>();
  const fontFamilies = new Map<string, string>();   // pdf.js font id → css family
  const paragraphs: { text: string; size: number; rtl: boolean; family?: string; heading: boolean; page: number; edgeKey: string; open?: boolean; center?: boolean }[] = [];
  const sizes: number[] = [];
  // Lines at the page's edges, counted across pages: the ones that repeat are running heads and page numbers.
  const edgeSeen = new Map<string, number>();
  const edgeLines: { key: string; text: string; page: number; size: number; rtl: boolean; font?: string }[] = [];
  const notes: { text: string; page: number }[] = [];
  const { pageBlocks, joinBreak } = await import('./pdflayer');
  // The worker reads the next pages' text while this one is put together here.
  const AHEAD = 2;
  const asked = new Map<number, Promise<{ page: import('pdfjs-dist').PDFPageProxy; tc: Awaited<ReturnType<import('pdfjs-dist').PDFPageProxy['getTextContent']>> }>>();
  const ask = (n: number) => doc.getPage(n).then(async (page) => ({ page, tc: await page.getTextContent() }));
  for (let p = 1; p <= doc.numPages; p++) {
    progress('pdfPage', Math.round((p / doc.numPages) * 60));
    for (let k = p; k <= Math.min(doc.numPages, p + AHEAD); k++) if (!asked.has(k)) asked.set(k, ask(k));
    const { page, tc } = await asked.get(p)!; asked.delete(p);
    // A font's file comes over only with a page's drawing (then commonObjs has it): the drawing is read only for
    // a page that brings a font not met before — not for every page, which took most of the time.
    if ((tc.items as { fontName?: string }[]).some((it) => it.fontName && !fontFamilies.has(it.fontName))) { try { await page.getOperatorList(); } catch { /* its text all the same */ } }
    type It = { str: string; x: number; y: number; w: number; h: number; font: string; eol: boolean; keep: boolean };
    const items: It[] = [];
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const [a, b, , , e, f] = it.transform;
      const h = it.height || Math.hypot(a, b) || 10;
      const str = cleanPdfText(it.str);
      items.push({ str: /^\u2009+$/.test(str) ? '\u2009' : str, x: e, y: f, w: it.width, h, font: it.fontName, eol: !!it.hasEOL, keep: !!(it as { krLead?: boolean }).krLead });
      if (it.fontName && !fontFamilies.has(it.fontName)) {
        try {
          const fo = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) as { name?: string; data?: Uint8Array; mimetype?: string; loadedName?: string } : null;
          const family = cleanFamily(fo?.name || it.fontName);
          fontFamilies.set(it.fontName, family);
          if (fo?.data && fo.data.length > 1000 && !fonts.has(family)) {
            const mt = fo.mimetype || 'font/opentype';
            fonts.set(family, { blob: new Blob([fo.data as BlobPart], { type: mt }), ext: mt.includes('woff') ? 'woff' : mt.includes('truetype') || mt.includes('ttf') ? 'ttf' : 'otf' });
          }
        } catch { fontFamilies.set(it.fontName, cleanFamily(it.fontName)); }
      }
    }
    // The page as blocks of lines in reading order (the same layout the viewer selects and searches by), each
    // block its own run of paragraphs. Lines at the very top or bottom that repeat across pages (a running
    // head, a page number) are set aside; smaller lines at the foot of the page are footnotes.
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const blocks = pageBlocks(tc.items as { str: string; transform: number[]; width: number; height: number; fontName?: string; krLead?: boolean }[], vp);
    const pageLines = blocks.flatMap((b) => b.lines);
    const pageMedian = pageLines.length ? [...pageLines.map((l) => l.h)].sort((a, b) => a - b)[pageLines.length >> 1] : 12;
    const edge = (ln: { y: number }) => ln.y < vp.height * 0.08 ? 'top' : ln.y > vp.height * 0.92 ? 'bottom' : '';
    for (const ln of pageLines) { const e = edge(ln); if (e) { const key = ln.text.replace(/[\d٠-٩]+/g, '#').trim(); edgeSeen.set(key, (edgeSeen.get(key) ?? 0) + 1); } }
    let prevBottom: number | null = null; let prevSize = 0; let buf = ''; let bufSize = 0; let bufFont: string | undefined; let bufRtl = false; let bufFull = false; let bufWide = false; let bufCenter = false; let bufLines = 0;
    const flush = (kind: 'para' | 'note' = 'para') => {
      if (buf.trim()) {
        const text = buf.replace(/\s+/g, ' ').trim();
        if (kind === 'note') notes.push({ text, page: p });
        else {
          // (A paragraph left open at the foot of a page or block — its last line full, no stop at its end — goes
          // on with the next body text of the same size.)
          const last = paragraphs[paragraphs.length - 1];
          if (last && last.open && !last.heading && Math.abs(last.size - bufSize) <= last.size * 0.15) { last.text += (/[\u3000-\u9fff]$/.test(last.text) ? '' : ' ') + text; last.open = bufFull && !/[.!?؟。！？:"»”)]$/.test(text); }
          else { paragraphs.push({ text, size: bufSize, rtl: bufRtl, family: bufFont, heading: false, page: p, edgeKey: '', center: bufCenter, open: bufFull && bufWide && !bufCenter && bufLines >= 2 && bufSize <= pageMedian * 1.2 && !/[.!?؟。！？:"»”)]$/.test(text) }); sizes.push(bufSize); }
        }
      }
      buf = '';
    };
    for (const block of blocks) {
      flush(); prevBottom = null;
      const blockBottom = Math.max(...block.lines.map((l) => l.y));
      const isNote = blockBottom > vp.height * 0.6 && block.lines.every((l) => l.h < pageMedian * 0.88) && /^[\s(（\[]*[\d٠-٩]+[)）\]]?/.test(block.lines[0].text);
      const edgeL = Math.min(...block.lines.map((l) => l.l)), edgeR = Math.max(...block.lines.map((l) => l.r));
      // (The block's own leading: a paragraph ends where the next line comes later than that by half a line.)
      const pitches = block.lines.slice(1).map((l, i) => l.y - block.lines[i].y).filter((d) => d > 0).sort((a, b) => a - b);
      const pitch = pitches.length ? pitches[pitches.length >> 1] : 0;
      let prevY: number | null = null; let prevCentered = false;
      for (const ln of block.lines) {
        const e = edge(ln);
        if (e) { const key = ln.text.replace(/[\d٠-٩]+/g, '#').trim(); edgeLines.push({ key, text: ln.text, page: p, size: ln.h, rtl: ln.rtl, font: fontFamilies.get(ln.font ?? '') }); continue; }
        let text = fixArabicLine(ln.text.trim());
        if (!text) continue;
        const size = ln.h, top = ln.y - size, bottom = ln.y;
        const gap = prevBottom === null ? 0 : top - prevBottom;
        // (A new paragraph: a gap of most of a line, a change of size, a sentence ended and the last line short,
        // a first line indented.)
        const shortPrev = !bufFull;
        const wideGap = pitch && prevY !== null ? ln.y - prevY > pitch * 1.45 : gap > size * 0.9;
        // (A short line set in the middle — a heading, a title — stands on its own, as does what follows it.)
        const centered = (ln.r - ln.l) < (edgeR - edgeL) * 0.6 && Math.abs((ln.l + ln.r) / 2 - (edgeL + edgeR) / 2) < size * 0.8 && block.lines.length > 1;
        const newPara = prevBottom === null || wideGap || centered || prevCentered || Math.abs(size - prevSize) > prevSize * 0.25 || (shortPrev && buf.trim() && /[.!?؟。！？:]["»”)]?$/.test(buf.trim())) || (!!buf && (ln.rtl ? edgeR - ln.r : ln.l - edgeL) > size * 1.2 && gap > size * 0.2);
        if ((globalThis as { krDebugPara?: string }).krDebugPara && text.includes((globalThis as { krDebugPara?: string }).krDebugPara!)) console.warn('KR para', JSON.stringify({ text: text.slice(0, 30), newPara, gap: +gap.toFixed(1), size: +size.toFixed(1), prevSize: +prevSize.toFixed(1), shortPrev, bufEnd: buf.trim().slice(-12), indent: +(ln.rtl ? edgeR - ln.r : ln.l - edgeL).toFixed(1) }));
        if (newPara) { flush(isNote ? 'note' : 'para'); bufSize = size; bufFont = fontFamilies.get(ln.font ?? ''); bufRtl = ln.rtl; bufWide = false; bufLines = 0; bufCenter = centered && !/[.!?؟。！？،,;؛]$/.test(text) && text.length <= 80; }
        // (A wrapped line joins the next: a hyphen at its end goes, Chinese and Japanese run on without a space.)
        const sep = buf ? (joinBreak(buf, text) === '' ? '' : ' ') : '';
        if (buf && /[-\u2010\u00ad]$/.test(buf) && /^\p{Ll}/u.test(text)) buf = buf.replace(/[-\u2010\u00ad]$/, '');
        buf += sep + text;
        bufFull = ln.rtl ? ln.l <= edgeL + size * 1.5 : ln.r >= edgeR - size * 1.5;
        if (ln.r - ln.l > vp.width * 0.45) bufWide = true;
        bufLines++;
        prevBottom = bottom; prevSize = size; prevY = ln.y; prevCentered = centered;
      }
      flush(isNote ? 'note' : 'para');
    }
    page.cleanup();
  }
  await task.destroy();
  // Edge lines that do not repeat (a chapter's first line high on the page) go back in as text; a lone number
  // is a page number whatever its count.
  const repeated = (key: string) => (edgeSeen.get(key) ?? 0) >= Math.max(2, Math.min(doc.numPages, 20) * 0.3);
  const lonely = (t: string) => /^[\s\-–—]*[\d٠-٩]+[\s\-–—]*$/.test(t);
  const kept = edgeLines.filter((e) => !repeated(e.key) && !lonely(e.text));
  for (const e of kept) { paragraphs.push({ text: fixArabicLine(e.text.trim()), size: e.size, rtl: e.rtl, family: e.font, heading: false, page: e.page - 0.5, edgeKey: e.key }); sizes.push(e.size); }
  paragraphs.sort((a, b) => a.page - b.page);
  // Footnotes: each page's notes follow that page's text, set small.
  for (const n of notes) paragraphs.push({ text: n.text, size: 0, rtl: /[\u0600-\u06ff]/.test(n.text), family: undefined, heading: false, page: n.page + 0.5, edgeKey: 'note' });
  paragraphs.sort((a, b) => a.page - b.page);
  // (The same words twice in a row — a title drawn with a shadow in two sizes — are one.)
  const bare = (t: string) => t.normalize('NFKD').replace(/[\u064b-\u065f\u0670\s\p{M}]/gu, '');
  for (let i = paragraphs.length - 1; i > 0; i--) if (bare(paragraphs[i].text) === bare(paragraphs[i - 1].text) && Math.abs(paragraphs[i].page - paragraphs[i - 1].page) <= 1) paragraphs.splice(i, 1);
  // Headings: noticeably larger than the common size — the largest a chapter's, the next a section's.
  const median = sizes.length ? [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : 12;
  const big = [...new Set(paragraphs.filter((q) => q.size > median * 1.25 && q.text.length < 140).map((q) => Math.round(q.size)))].sort((a, b) => b - a);
  for (const para of paragraphs) para.heading = para.size > median * 1.25 && para.text.length < 140;
  const level = (size: number) => (big.indexOf(Math.round(size)) === 0 ? 2 : 3);
  // Chapters: split at headings; otherwise one chapter per ~60 paragraphs.
  const chapters: Chapter[] = [];
  let cur: string[] = []; let curTitle = book.title; let curRtl = false; let rtlCount = 0, count = 0;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const pushChapter = () => { if (cur.length) chapters.push({ title: curTitle, html: cur.join('\n'), rtl: rtlCount > count / 2 }); cur = []; rtlCount = 0; count = 0; };
  for (const para of paragraphs) {
    const style = para.family && fonts.has(para.family) ? ` style="font-family:'${para.family}'"` : '';
    const dir = para.rtl ? ' dir="rtl"' : ' dir="ltr"';
    if (para.heading && level(para.size) === 2) { pushChapter(); curTitle = para.text; cur.push(`<h2${dir}${style}>${esc(para.text)}</h2>`); }
    else if (para.heading || para.center) cur.push(`<h3${dir}${style}>${esc(para.text)}</h3>`);
    else if (para.edgeKey === 'note') cur.push(`<p class="footnote"${dir}><small>${esc(para.text)}</small></p>`);
    else cur.push(`<p${dir}${style}>${esc(para.text)}</p>`);
    count++; if (para.rtl) rtlCount++;
    if (cur.length >= 400) { pushChapter(); curTitle = `${book.title} · ${chapters.length + 1}`; }
  }
  pushChapter();
  curRtl = chapters.filter((c) => c.rtl).length > chapters.length / 2;
  progress('build', 65);
  return { title: book.title, author: book.author, lang: book.language, rtl: curRtl, chapters, images: new Map(), fonts, cover: book.cover };
}

function cleanFamily(name: string): string {
  // "ABCDEF+Amiri-Regular" → "Amiri"
  return name.replace(/^[A-Z]{6}\+/, '').replace(/[-_,](Regular|Bold|Italic|BoldItalic|Medium|Light|MT|PS|Identity-H)$/i, '').replace(/[^\w\s؀-ۿ぀-鿿-]/g, '').trim() || 'PdfFont';
}
const COMMON_AR = /\b(في|من|على|إلى|الى|أن|ان|كان|هذا|هذه|التي|الذي|ما|لا|قال|عن|ثم|أو|او|كل|بين|عند|حتى|إذا|اذا|لم|قد|هو|هي|ذلك|بعد|قبل|غير|مع|يا|إن|لكن)\b/g;
function fixArabicLine(line: string): string {
  if (!/[؀-ۿﭐ-﷿ﹰ-﻿]/.test(line)) return line;
  const t = line.normalize('NFKC').replace(/ـ/g, '');
  const rev = t.split(' ').reverse().map((w) => (/^[؀-ۿ\s؛،؟.!:«»()]+$/.test(w) ? [...w].reverse().map((c) => ({ '(': ')', ')': '(', '«': '»', '»': '«' }[c] ?? c)).join('') : w)).join(' ');
  const hits = (s: string) => (s.match(COMMON_AR) ?? []).length;
  return hits(rev) > hits(t) ? rev : t;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const slug = (s: string) => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'book';

/** HTML fragment → well-formed XHTML (EPUB needs XML). */
function toXhtml(html: string): string {
  const doc = document.implementation.createHTMLDocument('');
  const body = doc.body; body.innerHTML = html;
  body.querySelectorAll('script, iframe, object, embed, form, input, button').forEach((e) => e.remove());
  // XHTML-safe: no bare attributes, void elements closed by the serializer.
  const out = new XMLSerializer().serializeToString(body);
  return out.replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '').replace(/ xmlns="[^"]*"/g, '');
}

export async function buildEpub(d: ConvDoc, progress: Progress): Promise<Blob> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const manifest: string[] = []; const spine: string[] = []; const nav: string[] = [];
  // Pictures
  const imgNames = new Map<string, string>(); let n = 0;
  for (const [url, blob] of d.images) {
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const name = `images/img${++n}.${ext}`; imgNames.set(url, name);
    zip.file(`OEBPS/${name}`, blob); manifest.push(`<item id="img${n}" href="${name}" media-type="${blob.type || 'image/png'}"/>`);
  }
  // Fonts carried over from the source
  let css = `body{line-height:1.6;margin:0 5%}p{margin:0 0 .8em}h1,h2,h3{line-height:1.3}img{max-width:100%;height:auto}[dir=rtl]{text-align:right}\n`;
  let fi = 0;
  for (const [family, f] of d.fonts) {
    const name = `fonts/f${++fi}.${f.ext}`; zip.file(`OEBPS/${name}`, f.blob);
    const mt = f.ext === 'woff' ? 'font/woff' : f.ext === 'ttf' ? 'font/ttf' : 'font/otf';
    manifest.push(`<item id="font${fi}" href="${name}" media-type="${mt}"/>`);
    css += `@font-face{font-family:'${family}';src:url(${name})}\n`;
  }
  zip.file('OEBPS/style.css', css); manifest.push('<item id="css" href="style.css" media-type="text/css"/>');
  if (d.cover) { const ext = (d.cover.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg'); zip.file(`OEBPS/cover.${ext}`, d.cover); manifest.push(`<item id="cover-image" href="cover.${ext}" media-type="${d.cover.type || 'image/jpeg'}" properties="cover-image"/>`); }
  d.chapters.forEach((ch, i) => {
    progress('build', 65 + Math.round((i / d.chapters.length) * 30));
    let html = toXhtml(ch.html);
    for (const [url, name] of imgNames) html = html.split(`src="${esc(url)}"`).join(`src="${name}"`).split(`src="${url}"`).join(`src="${name}"`);
    const file = `ch${i + 1}.xhtml`;
    zip.file(`OEBPS/${file}`, `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops"${d.lang ? ` xml:lang="${esc(d.lang)}" lang="${esc(d.lang)}"` : ''}${ch.rtl ? ' dir="rtl"' : ''}><head><title>${esc(ch.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body${ch.rtl ? ' dir="rtl"' : ''}>${html}</body></html>`);
    manifest.push(`<item id="ch${i + 1}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${i + 1}"/>`);
    nav.push(`<li><a href="${file}">${esc(ch.title)}</a></li>`);
  });
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(d.title)}</title></head><body><nav epub:type="toc" id="toc"><h1>${esc(d.title)}</h1><ol>${nav.join('')}</ol></nav></body></html>`);
  const uid = 'urn:uuid:' + crypto.randomUUID();
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"${d.rtl ? ' dir="rtl"' : ''}>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${uid}</dc:identifier><dc:title>${esc(d.title)}</dc:title>${d.author ? `<dc:creator>${esc(d.author)}</dc:creator>` : ''}<dc:language>${esc(d.lang || (d.rtl ? 'ar' : 'en'))}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join('')}</manifest>
<spine${d.rtl ? ' page-progression-direction="rtl"' : ''}>${spine.join('')}</spine></package>`);
  storeCompressed(zip as unknown as ZipLike);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

export async function buildDocx(d: ConvDoc, progress: Progress): Promise<Blob> {
  const docx = await import('docx');
  const { Document, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, ExternalHyperlink, LevelFormat } = docx;
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  // Each picture's kind and size from its first bytes (decoding it only when they do not say: a WebP, which Word
  // does not take, is drawn again as a PNG).
  const imgDims = new Map<string, { w: number; h: number; type: 'png' | 'jpg' | 'gif' | 'bmp' }>();
  const imgData = new Map<string, Uint8Array>();
  for (const [url, blob] of d.images) {
    try {
      let bytes = new Uint8Array(await blob.arrayBuffer());
      let size = imageSize(bytes);
      if (!size || size.kind === 'webp') {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d')!.drawImage(bmp, 0, 0); bmp.close();
        const png = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
        if (!png) continue;
        bytes = new Uint8Array(await png.arrayBuffer()); size = { kind: 'png', w: c.width, h: c.height };
      }
      const scale = Math.min(1, 500 / Math.max(1, size.w));
      imgDims.set(url, { w: Math.round(size.w * scale), h: Math.round(size.h * scale), type: size.kind === 'webp' ? 'png' : size.kind });
      imgData.set(url, bytes);
    } catch { /* left out */ }
  }
  // Lists numbered as the book numbers them (each list counting from its own start), bulleted ones by depth.
  let lists = 0;
  const alignOf = (el: Element, dir: boolean) => {
    const a = (el.getAttribute('align') ?? (el as HTMLElement).style?.textAlign ?? '').toLowerCase();
    return a === 'center' ? AlignmentType.CENTER : a === 'justify' ? AlignmentType.BOTH : a === 'right' ? (dir ? AlignmentType.LEFT : AlignmentType.RIGHT) : dir ? AlignmentType.RIGHT : AlignmentType.LEFT;
  };
  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const walkBlock = (el: Element, rtl: boolean, out: Block[] = children, list?: { ordered: boolean; level: number; instance: number }) => {
    const tag = el.tagName.toLowerCase();
    const dir = el.getAttribute('dir') === 'rtl' ? true : el.getAttribute('dir') === 'ltr' ? false : rtl || isRtlText(el.textContent ?? '');
    const family = (el as HTMLElement).style?.fontFamily?.replace(/['"]/g, '') || undefined;
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? ''; const dim = imgDims.get(src); const data = imgData.get(src);
      if (dim && data) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data, type: dim.type, transformation: { width: dim.w, height: dim.h } })] }));
      return;
    }
    if (/^h[1-6]$/.test(tag)) { out.push(new Paragraph({ heading: tag === 'h1' ? HeadingLevel.HEADING_1 : tag === 'h2' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, bidirectional: dir, alignment: alignOf(el, dir), children: runs(el, dir, family) })); return; }
    // A table as a table: its rows and cells (a cell spanning columns spans them), each cell's text its paragraphs.
    if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'));
      const width = Math.max(1, ...rows.map((tr) => Array.from(tr.children).reduce((n, c) => n + Math.max(1, Number(c.getAttribute('colspan')) || 1), 0)));
      const trs = rows.map((tr) => new TableRow({ tableHeader: tr.parentElement?.tagName.toLowerCase() === 'thead' || undefined, children: Array.from(tr.children).filter((c) => /^t[dh]$/i.test(c.tagName)).map((td) => {
        const inner: Block[] = []; const kids = Array.from(td.children).filter((k) => !/^(b|i|em|strong|span|a|sup|sub|u|s|br|small|code|font)$/i.test(k.tagName));
        if (kids.length) { for (const k of Array.from(td.childNodes)) { if (k.nodeType === 1 && kids.includes(k as Element)) walkBlock(k as Element, dir, inner); } }
        const own = runs(td, dir, family, !!kids.length, [], false, { b: td.tagName.toLowerCase() === 'th' });
        if (own.length) inner.unshift(new Paragraph({ bidirectional: dir, alignment: alignOf(td, dir), children: own }));
        return new TableCell({ columnSpan: Math.max(1, Number(td.getAttribute('colspan')) || 1) > 1 ? Math.max(1, Number(td.getAttribute('colspan'))) : undefined, children: inner.length ? inner.filter((b): b is InstanceType<typeof Paragraph> | InstanceType<typeof Table> => !!b) : [new Paragraph({ children: [] })] });
      }) }));
      if (trs.length) out.push(new Table({ rows: trs, width: { size: 100, type: WidthType.PERCENTAGE }, visuallyRightToLeft: dir || undefined, columnWidths: Array.from({ length: width }, () => Math.floor(9000 / width)) }), new Paragraph({ children: [] }));
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const level = list ? Math.min(8, list.level + 1) : 0;
      const me = { ordered: tag === 'ol', level, instance: tag === 'ol' ? ++lists : 0 };
      for (const k of Array.from(el.children)) walkBlock(k, dir, out, me);
      return;
    }
    if (tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'pre' || tag === 'figcaption' || tag === 'dd' || tag === 'dt' || tag === 'td' || tag === 'th') {
      const imgs = Array.from(el.querySelectorAll('img'));
      // (A list item's own text; a list inside it follows, a level deeper.)
      const subLists = tag === 'li' ? Array.from(el.children).filter((k) => /^(ul|ol)$/i.test(k.tagName)) : [];
      const r = runs(el, dir, family, false, subLists, tag === 'pre');
      const item = tag === 'li' && list ? (list.ordered ? { numbering: { reference: 'kr-ol', level: Math.min(list.level, 2), instance: list.instance } } : { bullet: { level: list.level } }) : tag === 'li' ? { bullet: { level: 0 } } : {};
      if (r.length) out.push(new Paragraph({ bidirectional: dir, alignment: alignOf(el, dir), indent: tag === 'blockquote' ? { start: 720, end: 360 } : tag === 'dd' ? { start: 720 } : undefined, ...item, children: r }));
      for (const sl of subLists) walkBlock(sl, dir, out, list ?? { ordered: false, level: 0, instance: 0 });
      imgs.filter((im) => !subLists.some((sl) => sl.contains(im))).forEach((im) => walkBlock(im, dir, out));
      return;
    }
    // A rule between scenes: a paragraph with a line under it.
    if (tag === 'hr') { out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'auto', space: 1 } }, children: [] })); return; }
    if (tag === 'br') { out.push(new Paragraph({ children: [] })); return; }
    const kids = Array.from(el.children);
    if (!kids.length) { const r = runs(el, dir, family); if (r.length) out.push(new Paragraph({ bidirectional: dir, alignment: alignOf(el, dir), children: r })); return; }
    // Loose text directly inside a container becomes its own paragraph.
    const loose = Array.from(el.childNodes).filter((nd) => nd.nodeType === 3 && nd.textContent?.trim()).map((nd) => nd.textContent!.trim()).join(' ');
    if (loose) out.push(new Paragraph({ bidirectional: dir, children: [new TextRun({ text: loose, rightToLeft: dir, font: family })] }));
    kids.forEach((k) => walkBlock(k, dir, out, list));
  };
  type Inline = InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>;
  /** A block's text as runs: bold, italic, underlined, struck, raised or lowered, set in a fixed-width face, a
   *  link to the web as a link; `skipBlocks` leaves out the block children walked on their own. */
  type St = { b?: boolean; i?: boolean; u?: boolean; s?: boolean; sup?: boolean; sub?: boolean; mono?: boolean };
  const runs = (el: Element, rtl: boolean, family?: string, skipBlocks = false, skip: Element[] = [], keepSpaces = false, base: St = {}): Inline[] => {
    const out: Inline[] = [];
    const run = (text: string, st: St) => new TextRun({ text, bold: st.b || undefined, italics: st.i || undefined, underline: st.u ? {} : undefined, strike: st.s || undefined, superScript: st.sup || undefined, subScript: st.sub || undefined, rightToLeft: rtl || undefined, font: st.mono ? 'Courier New' : family });
    const visit = (node: Node, st: St, into: Inline[]) => {
      if (node.nodeType === 3) {
        // (Preformatted text keeps its spaces and its lines.)
        if (keepSpaces) { (node.textContent ?? '').split('\n').forEach((ln, k) => { if (k) into.push(new TextRun({ break: 1 })); if (ln) into.push(run(ln, { ...st, mono: true })); }); return; }
        // (A space between two styled words is kept: "<b>one</b> <i>two</i>" is not "onetwo".)
        const txt = (node.textContent ?? '').replace(/\s+/g, ' '); if (txt.trim()) into.push(run(txt, st)); else if (txt && into.length) into.push(run(' ', st)); return;
      }
      if (node.nodeType !== 1) return;
      const e = node as Element; const tg = e.tagName.toLowerCase();
      if (tg === 'img' || tg === 'rt' || tg === 'rp' || skip.includes(e)) return;
      if (skipBlocks && /^(p|div|table|ul|ol|li|h[1-6]|blockquote|pre|figure|section|hr)$/.test(tg)) return;
      if (tg === 'br') { into.push(new TextRun({ break: 1 })); return; }
      const next: St = { ...st, b: st.b || tg === 'b' || tg === 'strong' || tg === 'th', i: st.i || tg === 'i' || tg === 'em' || tg === 'cite', u: st.u || tg === 'u' || tg === 'ins', s: st.s || tg === 's' || tg === 'strike' || tg === 'del', sup: st.sup || tg === 'sup', sub: st.sub || tg === 'sub', mono: st.mono || tg === 'code' || tg === 'kbd' || tg === 'tt' || tg === 'samp' };
      const href = tg === 'a' ? e.getAttribute('href') ?? '' : '';
      if (/^(https?|mailto):/i.test(href)) {
        const inner: Inline[] = []; e.childNodes.forEach((c) => visit(c, { ...next, u: true }, inner));
        const textRuns = inner.filter((x): x is InstanceType<typeof TextRun> => x instanceof TextRun);
        if (textRuns.length) into.push(new ExternalHyperlink({ link: href, children: textRuns }));
        return;
      }
      node.childNodes.forEach((c) => visit(c, next, into));
    };
    el.childNodes.forEach((c) => visit(c, base, out));
    return out;
  };
  d.chapters.forEach((ch, i) => {
    progress('build', 65 + Math.round((i / d.chapters.length) * 30));
    const host = globalThis.document.createElement('div'); host.innerHTML = ch.html;
    if (d.chapters.length > 1 && !/<h[1-3][\s>]/i.test(ch.html.slice(0, 600))) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: ch.rtl, alignment: ch.rtl ? AlignmentType.RIGHT : AlignmentType.LEFT, pageBreakBefore: i > 0, children: [new TextRun({ text: ch.title, rightToLeft: ch.rtl || undefined })] }));
    Array.from(host.children).forEach((el: Element) => walkBlock(el, ch.rtl));
  });
  const fontNames = [...d.fonts.keys()];
  const wordDoc = new Document({ creator: d.author ?? 'KurokawaReader', title: d.title, description: fontNames.length ? `Fonts used in the source: ${fontNames.join(', ')}` : undefined, styles: { default: { document: { run: { font: d.rtl ? 'Arial' : 'Calibri', size: 24 } } } },
    numbering: { config: [{ reference: 'kr-ol', levels: [0, 1, 2].map((level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level], text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ properties: { page: { textDirection: undefined } }, children }] });
  return packDocx(wordDoc);
}

export function buildHtml(d: ConvDoc, inlineImages: Map<string, string>): string {
  const body = d.chapters.map((ch) => { let html = ch.html; for (const [url, data] of inlineImages) html = html.split(`src="${url}"`).join(`src="${data}"`); return `<section${ch.rtl ? ' dir="rtl"' : ''}>${d.chapters.length > 1 && !/<h[1-3][\s>]/i.test(html.slice(0, 600)) ? `<h2>${esc(ch.title)}</h2>` : ''}${html}</section>`; }).join('\n');
  return `<!doctype html>\n<html${d.lang ? ` lang="${esc(d.lang)}"` : ''}${d.rtl ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(d.title)}</title><style>body{max-width:760px;margin:2em auto;padding:0 1em;line-height:1.7;font-family:Georgia,'Noto Naskh Arabic',serif;font-size:18px}img{max-width:100%;height:auto}h1,h2,h3{line-height:1.3}[dir=rtl]{text-align:right}.verse{display:flex;justify-content:space-between;gap:2em;margin:.2em 0}.verse>span{flex:1 1 0}.verse>.h2{text-align:end}</style></head><body><h1>${esc(d.title)}</h1>${d.author ? `<p><i>${esc(d.author)}</i></p>` : ''}${body}</body></html>`;
}

export function buildText(d: ConvDoc, markdown: boolean): string {
  const out: string[] = [];
  if (markdown) { out.push(`# ${d.title}`); if (d.author) out.push(`*${d.author}*`); out.push(''); }
  else { out.push(d.title); if (d.author) out.push(d.author); out.push(''); }
  for (const ch of d.chapters) {
    const host = document.createElement('div'); host.innerHTML = ch.html;
    host.querySelectorAll('rt, rp').forEach((e) => e.remove());
    // (A chapter that opens with its own title as a heading is not titled twice.)
    const first = host.querySelector('h1, h2, h3');
    const titled = first && first === host.firstElementChild && (first.textContent ?? '').replace(/\s+/g, ' ').trim() === ch.title.replace(/\s+/g, ' ').trim();
    if (d.chapters.length > 1 && !titled) out.push(markdown ? `## ${ch.title}` : `\n${ch.title}\n`);
    if (titled) { if (markdown) out.push(`## ${ch.title}`); else out.push(`\n${ch.title}\n`); out.push(''); first.remove(); }
    for (const el of Array.from(host.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, td, th, figcaption, dd, dt'))) {
      if (el.querySelector('p, li, h1, h2, h3')) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim(); if (!text) continue;
      const tag = el.tagName.toLowerCase();
      if (markdown) out.push(/^h[1-4]$/.test(tag) ? `${'#'.repeat(Math.min(6, Number(tag[1]) + 1))} ${text}` : tag === 'li' ? `- ${text}` : tag === 'blockquote' || el.classList.contains('footnote') ? `> ${text}` : text);
      else out.push(text);
      out.push('');
    }
    if (!host.querySelector('p, li, h1, h2, h3')) { const t = (host.textContent ?? '').trim(); if (t) { out.push(t); out.push(''); } }
  }
  return out.join('\n');
}

/** PDF: real text on the desktop (Chromium's printer), pictures of pages elsewhere. */
export type PdfPaper = 'a4' | 'a5' | 'letter' | 'phone';
const PAPER: Record<PdfPaper, { css: string; pt: [number, number] }> = { a4: { css: 'A4', pt: [595.28, 841.89] }, a5: { css: 'A5', pt: [419.53, 595.28] }, letter: { css: 'Letter', pt: [612, 792] }, phone: { css: '90mm 160mm', pt: [255.1, 453.5] } };
/** What the reader can set for a conversion: the paper and type size of a PDF, whether pictures go along. */
export interface ConvOptions { paper?: PdfPaper; fontSize?: number; images?: boolean }

export async function buildPdf(d: ConvDoc, progress: Progress, opts: ConvOptions = {}): Promise<Blob> {
  const paper = PAPER[opts.paper ?? 'a4'];
  const inline = new Map<string, string>();
  for (const [url, blob] of d.images) inline.set(url, await blobToDataUrl(blob));
  if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves) console.warn('KR stage start', d.chapters.length, 'chapters');
  const fontCss = await readerFontCss(d);
  if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves) console.warn('KR stage fonts', fontCss.length);
  const desk = (window as unknown as { kurokawaDesktop?: { printToPdf?(html: string, o?: { pageSize?: string }): Promise<string> } }).kurokawaDesktop;
  // (Every picture loaded before printing: one left to load lazily would be missing from a printed page.)
  const html = buildHtml(d, inline).replace(/\sloading=(["'])lazy\1/gi, '').replace('</style>', `${fontCss}\nbody{font-family:'Merriweather','Uthman TN1','Noto Naskh Arabic',Georgia,serif${opts.fontSize ? `;font-size:${opts.fontSize}px` : ''}}@page{size:${paper.css};margin:${opts.paper === 'phone' ? '8mm' : '16mm'}}section{page-break-before:always}section:first-of-type{page-break-before:auto}img{break-inside:avoid}</style>`);
  if (desk?.printToPdf) {
    progress('build', 70);
    const b64 = await desk.printToPdf(html, { pageSize: paper.css });
    return b64ToBlob(b64, 'application/pdf');
  }
  // The system's own print on a phone (Android, iOS): real text and pictures — sharp, small, searchable — in a
  // fraction of the time; the pages drawn here as pictures only if it cannot.
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: { printToPdf?(o: { html: string; width: number; height: number; margin: number }): Promise<{ data?: string }> } } } }).Capacitor;
  const plugin = cap?.getPlatform?.() === 'android' || cap?.getPlatform?.() === 'ios' ? cap.Plugins?.Kurokawa : undefined;
  if (plugin?.printToPdf) {
    progress('build', 70);
    try {
      const r = await plugin.printToPdf({ html, width: paper.pt[0], height: paper.pt[1], margin: opts.paper === 'phone' ? 22.68 : 45.35 });
      if (r?.data) return b64ToBlob(r.data, 'application/pdf');
    } catch (e) { console.warn('[kurokawa] the system could not print it; pages drawn here', e); }
  }
  // Pictures of pages: lay the HTML out at the paper's width, slice by page height, rasterise each slice; the
  // words go on each page as invisible text where they stand, so the PDF can be searched, selected and copied.
  const { PDFDocument } = await import('pdf-lib');
  const [PW, PH] = paper.pt;
  const W = Math.round(PW * 96 / 72), H = Math.round(PH * 96 / 72), SCALE = 2;
  const frame = document.createElement('iframe');
  frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;height:${H}px;visibility:hidden;border:0`;
  document.body.appendChild(frame);
  try {
    const fdoc = frame.contentDocument!; fdoc.open(); fdoc.write(html.replace('<style>', `<style>html,body{margin:0}body{max-width:none;padding:1px 56px;width:${W - 112}px}`)); fdoc.close();
    // Every picture loaded before anything is measured: a book's lazy pictures, never shown in this hidden frame,
    // would otherwise be measured as nothing, and the pages cut and the words placed for a book without them.
    fdoc.querySelectorAll('img').forEach((im) => { im.removeAttribute('loading'); (im as HTMLImageElement).loading = 'eager'; });
    await Promise.race([Promise.all(Array.from(fdoc.images).map((im) => im.decode().catch(() => undefined))), new Promise((r) => setTimeout(r, 15000))]);
    await new Promise((r) => setTimeout(r, 300));
    if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves) console.warn('KR stage pictures', fdoc.images.length);
    await (fdoc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
    if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves) console.warn('KR stage laid out', fdoc.documentElement.scrollHeight);
    const total = fdoc.documentElement.scrollHeight;
    // Pages are cut between lines, never through a line, a picture or a table row, and a new section starts a
    // new page; each page keeps a margin above and below.
    const M = 48, CH = H - 2 * M;
    const all = wordBoxes(fdoc);
    if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves) console.warn('KR stage words', all.length);
    const solid: [number, number][] = all.map((w) => [w.y, w.y + w.h]);
    fdoc.querySelectorAll('img, svg, canvas, video, tr, hr, pre, figure, blockquote > p').forEach((el) => { const r = el.getBoundingClientRect(); if (r.height > 0 && r.height < CH * 0.9) solid.push([r.top, r.bottom]); });
    const forced: number[] = [];
    fdoc.querySelectorAll('section').forEach((el, i) => { if (i) forced.push(el.getBoundingClientRect().top); });
    const cuts: number[] = [0];
    for (let st = 0; st < total - 1;) {
      let e = st + CH;
      if (e >= total) { cuts.push(total); break; }
      const f = forced.find((y) => y > st + 4 && y < e); if (f !== undefined) e = f;
      for (let moved = true; moved;) { moved = false; for (const [a, b] of solid) if (a < e - 0.5 && b > e + 0.5 && a > st + 4) { e = a; moved = true; } }
      if (e <= st + CH * 0.15) e = st + CH;
      cuts.push(e); st = e;
    }
    const pages = cuts.length - 1;
    const words = all.flatMap((w) => { const c = w.y + w.h / 2; const page = cuts.findIndex((y, i) => i < pages && c >= y && c < cuts[i + 1]); return page < 0 ? [] : [{ ...w, page, y: w.y - cuts[page] + M }]; });
    const pdf = await PDFDocument.create();
    pdf.setTitle(d.title); if (d.author) pdf.setAuthor(d.author);
    // What goes into each page picture: the page's CSS (CDATA-wrapped for XML) and the body as XHTML.
    // (A page picture is drawn in an image, where the viewport units of the book's CSS (a full-page figure at
    // 98vh) would measure the app's window instead of the page: they are set in pixels of the page laid out here.)
    // (Only in CSS: style sheets and style attributes, outside url(…), whose data may hold anything.)
    const unitsIn = (css: string) => css.split(/(url\([^)]*\))/).map((part, i) => (i % 2 ? part : part.replace(/(^|[^\w.-])(-?\d*\.?\d+)(vh|vw|vmin|vmax)\b/g, (_m, pre: string, n: string, u: string) => `${pre}${((+n) * (u === 'vh' ? H : u === 'vw' ? W : u === 'vmin' ? Math.min(W, H) : Math.max(W, H)) / 100).toFixed(2)}px`))).join('');
    const fixedUnits = (html: string) => html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_m, a: string, css: string, b: string) => a + unitsIn(css) + b).replace(/(\sstyle=")([^"]*)(")/g, (_m, a: string, css: string, b: string) => a + unitsIn(css) + b);
    const cssText = unitsIn(Array.from(fdoc.querySelectorAll('style')).map((st) => st.textContent ?? '').join('\n'));
    // Each page picture is the whole document laid out again (that is how a page of HTML becomes a picture), so
    // every block away from the page is emptied first — kept at its exact size, so nothing moves — and only the
    // page's own blocks carry their words and pictures. (Laying out the whole book for every page made a long
    // book take minutes.)
    if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves) console.warn('KR measured', pages, 'pages', all.length, 'words');
    const leaves = pageLeaves(fdoc);
    const near = 40;
    leaves.forEach(emptyLeaf);
    const filled = new Set<Leaf>();
    if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves) { let n = 0; for (const l of leaves) { const r = l.el.getBoundingClientRect(); if (Math.abs(r.top - l.top) > 1 && n++ < 8) console.warn('KR leaf moved', l.el.tagName, l.el.className, Math.round(l.top), '→', Math.round(r.top), Math.round(l.h), '→', Math.round(r.height), (l.el.outerHTML || '').slice(0, 120)); } }
    const T = (globalThis as { krTiming?: Record<string, number> }).krTiming; let t0 = performance.now();
    const lap = (k: string) => { if (T) { const n = performance.now(); T[k] = (T[k] ?? 0) + n - t0; t0 = n; } };
    if (T) { T.pages = pages; T.leaves = leaves.length; }
    // (Pages are encoded to JPEG a few at a time while the next ones are drawn.)
    const encoding: Promise<Uint8Array>[] = [];
    const embedDone = async (n: number) => { const image = await pdf.embedJpg(await encoding[n]); const page = pdf.addPage([PW, PH]); page.drawImage(image, { x: 0, y: 0, width: PW, height: PH }); };
    let embedded = 0;
    for (let p = 0; p < pages; p++) {
      lap('between');
      if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves && p % 20 === 0) console.warn('KR page', p, '/', pages, JSON.stringify(T));
      progress('pdfPage', 65 + Math.round((p / pages) * 32));
      const top = cuts[p], tall = cuts[p + 1] - top;
      // The page's blocks get their content back; those of the pages before are emptied again.
      const want = new Set<Leaf>();
      for (let i = 0; i < leaves.length && leaves[i].top < top + tall + near; i++) if (leaves[i].bottom >= top - near) want.add(leaves[i]);
      for (const l of filled) if (!want.has(l)) { emptyLeaf(l); filled.delete(l); }
      for (const l of want) if (!filled.has(l)) { fillLeaf(l); filled.add(l); }
      const bodyX = fixedUnits(new XMLSerializer().serializeToString(fdoc.body).replace(/^<body[^>]*>|<\/body>$/g, ''));
      if (T) T.bodyChars = Math.max(T.bodyChars ?? 0, bodyX.length);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="${W}" height="${H}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;overflow:hidden;background:#fff"><style><![CDATA[${cssText.replace(/\]\]>/g, '')}]]></style><div style="position:relative;top:${M}px;height:${Math.ceil(tall)}px;overflow:hidden"><div style="transform:translateY(-${top}px)"><body${d.rtl ? ' dir="rtl"' : ''} style="display:block">${bodyX}</body></div></div></div></foreignObject></svg>`;
      const img = new Image(); img.decoding = 'async';
      // A data: URL (not blob:) keeps the canvas untainted so it can be exported.
      if ((globalThis as { krDebugLeaves?: boolean }).krDebugLeaves && p === 3) (globalThis as { krDebugSvg?: string }).krDebugSvg = svg;
      lap('svg');
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => { const perr = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')?.textContent; rej(new Error('page render' + (perr ? ': ' + perr.slice(0, 200) : ''))); }; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      lap('load');
      const c = document.createElement('canvas'); c.width = W * SCALE; c.height = H * SCALE;
      const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      lap('draw');
      encoding.push(new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.8)).then(async (b) => new Uint8Array(await b.arrayBuffer())));
      while (encoding.length - embedded > 3) await embedDone(embedded++);
      lap('jpeg');
    }
    while (embedded < encoding.length) await embedDone(embedded++);
    lap('embed');
    await addInvisibleText(pdf, words, PW / W);
    const bytes = await pdf.save();
    return new Blob([bytes as BlobPart], { type: 'application/pdf' });
  } finally { frame.remove(); }
}

type WordBox = { page: number; text: string; x: number; y: number; w: number; h: number };

/** A smallest block of a laid-out document (a paragraph, a heading, a list item, a table, a picture), with its
 *  place, and while it is emptied, what it held. */
type Leaf = { el: HTMLElement; top: number; bottom: number; w: number; h: number; style: string | null; kids: Node[] | null; src: string | null };

function pageLeaves(doc: Document): Leaf[] {
  const win = doc.defaultView!;
  const blockish = (e: Element) => { const d = win.getComputedStyle(e).display; return d !== 'none' && d !== 'contents' && !d.startsWith('inline'); };
  const out: Leaf[] = [];
  const visit = (el: Element) => {
    for (const ch of Array.from(el.children)) {
      if (!(ch instanceof win.HTMLElement) || !blockish(ch)) continue;
      const atomic = /^(TABLE|FIGURE|PRE|IMG|HR|VIDEO|CANVAS)$/.test(ch.tagName);
      const ownText = Array.from(ch.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
      if (!atomic && !ownText && Array.from(ch.children).some(blockish)) { visit(ch); continue; }
      const r = ch.getBoundingClientRect();
      out.push({ el: ch, top: r.top, bottom: r.bottom, w: r.width, h: r.height, style: ch.getAttribute('style'), kids: null, src: null });
    }
  };
  visit(doc.body);
  return out.sort((a, b) => a.top - b.top);
}
function emptyLeaf(l: Leaf): void {
  if (l.kids) return;
  l.kids = Array.from(l.el.childNodes); l.el.replaceChildren();
  if (l.el.tagName === 'IMG') { l.src = l.el.getAttribute('src'); l.el.removeAttribute('src'); l.el.removeAttribute('srcset'); }
  const st = l.el.style;
  st.setProperty('box-sizing', 'border-box', 'important'); st.setProperty('width', `${l.w}px`, 'important'); st.setProperty('height', `${l.h}px`, 'important');
  st.setProperty('min-height', '0', 'important'); st.setProperty('max-height', 'none', 'important');
}
function fillLeaf(l: Leaf): void {
  if (!l.kids) return;
  l.el.replaceChildren(...l.kids); l.kids = null;
  if (l.src !== null) { l.el.setAttribute('src', l.src); l.src = null; }
  if (l.style === null) l.el.removeAttribute('style'); else l.el.setAttribute('style', l.style);
}

/** Every word of a laid-out document with its box (CSS px, in the document). Each word is wrapped in a span of its
 *  own first and the spans measured after one layout: measuring words as ranges inside long text nodes made the
 *  browser shape a whole paragraph again for every word (minutes for an Arabic book). */
function wordBoxes(doc: Document): WordBox[] {
  const spans: HTMLElement[] = [];
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && /^(STYLE|SCRIPT)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes: Text[] = [];
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) if (/\S/.test(n.data)) nodes.push(n);
  for (const n of nodes) {
    const frag = doc.createDocumentFragment();
    for (const part of n.data.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { frag.appendChild(doc.createTextNode(part)); continue; }
      const sp = doc.createElement('span'); sp.className = 'krw'; sp.textContent = part; frag.appendChild(sp); spans.push(sp);
    }
    n.replaceWith(frag);
  }
  const out: WordBox[] = [];
  for (const sp of spans) {
    const r = sp.getClientRects()[0]; if (!r || !r.width || !r.height) continue;
    out.push({ page: 0, text: sp.textContent ?? '', x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
}

/** Words as invisible text (render mode 3) over the page pictures: a font with no outlines of its own — every
 *  character its own code, read back through its ToUnicode map — stretched to each word's box. A
 *  right-to-left word is written in drawing order, as readers expect of a PDF. */
async function addInvisibleText(pdf: import('pdf-lib').PDFDocument, words: WordBox[], k: number): Promise<void> {
  if (!words.length) return;
  const { PDFName, PDFString } = await import('pdf-lib');
  const ctx = pdf.context; const pages = pdf.getPages();
  const cid = new Map<number, number>();
  const code = (c: number) => { let v = cid.get(c); if (v === undefined) { v = cid.size + 1; cid.set(c, v); } return v.toString(16).padStart(4, '0'); };
  const ops: string[][] = pages.map(() => []);
  for (const w of words) {
    if (w.page < 0 || w.page >= pages.length) continue;
    const ph = pages[w.page].getHeight();
    let chars = [...w.text];
    if (/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/.test(w.text) && !/[A-Za-z0-9]/.test(w.text)) chars = chars.reverse();
    const size = Math.max(1, w.h * k * 0.8);
    const tz = Math.max(1, Math.min(1000, (w.w * k) / (chars.length * size) * 100));
    const x = w.x * k, y = ph - (w.y + w.h * 0.78) * k;
    ops[w.page].push(`BT 3 Tr /KRInv ${size.toFixed(2)} Tf ${tz.toFixed(1)} Tz 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <${chars.map((c) => code(c.codePointAt(0)!)).join('')}> Tj ET`);
  }
  // ToUnicode: each code the character it stands for.
  const entries = [...cid.entries()];
  let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /KRInv-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    cmap += `${part.length} beginbfchar\n`;
    for (const [c, v] of part) { const u = String.fromCodePoint(c); let hex = ''; for (let j = 0; j < u.length; j++) hex += u.charCodeAt(j).toString(16).padStart(4, '0'); cmap += `<${v.toString(16).padStart(4, '0')}> <${hex}>\n`; }
    cmap += 'endbfchar\n';
  }
  cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  const toUnicode = ctx.register(ctx.flateStream(cmap));
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'KRInvisible', Flags: 4, FontBBox: [0, -200, 1000, 800], ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80 }));
  const cidFont = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'KRInvisible', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: descriptor, DW: 1000, CIDToGIDMap: 'Identity' }));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'KRInvisible', Encoding: 'Identity-H', DescendantFonts: [cidFont], ToUnicode: toUnicode }));
  pages.forEach((page, i) => {
    if (!ops[i].length) return;
    page.node.setFontDictionary(PDFName.of('KRInv'), font);
    page.node.addContentStream(ctx.register(ctx.flateStream(ops[i].join('\n'))));
  });
}

/** The reader's own fonts (and the source's) inlined, so the printed page looks like the app. */
async function readerFontCss(d: ConvDoc): Promise<string> {
  let css = '';
  for (const [family, f] of d.fonts) css += `@font-face{font-family:'${family}';src:url(${await blobToDataUrl(f.blob)})}\n`;
  // (Only the faces the document uses: every page picture carries them again.)
  const all = d.chapters.map((c) => c.html).join('');
  const want = new Set<string>(['Merriweather', ...(/[\u0600-\u06ff]/.test(all + d.title) ? ['Uthman TN1'] : [])]);
  const italic = /<(i|em|cite|var|dfn)[\s>]|font-style:\s*italic/i.test(all);
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList; try { rules = sheet.cssRules; } catch { continue; }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const fam = r.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
      if (!want.has(fam) || (!italic && /italic/i.test(r.style.getPropertyValue('font-style')))) continue;
      const m = /url\(["']?([^"')]+)["']?\)/.exec(r.style.getPropertyValue('src')); if (!m) continue;
      // (Relative to the stylesheet, not the page; and only a font, never a page served in its place.)
      try { const res = await fetch(new URL(m[1], sheet.href ?? document.baseURI)); const blob = await res.blob(); if (!res.ok || /html/.test(blob.type)) continue; css += `@font-face{font-family:'${fam}';src:url(${await blobToDataUrl(blob)});font-weight:${r.style.getPropertyValue('font-weight') || 'normal'};font-style:${r.style.getPropertyValue('font-style') || 'normal'}}\n`; } catch { /* skip */ }
    }
  }
  return css;
}

export function blobToDataUrl(blob: Blob): Promise<string> { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
function b64ToBlob(b64: string, type: string): Blob { const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new Blob([bytes], { type }); }

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export const TARGETS: { id: Target; label: string; ext: string; mime: string; from: (f: Book['format']) => boolean }[] = [
  { id: 'epub', label: 'EPUB', ext: 'epub', mime: 'application/epub+zip', from: (f) => f !== 'epub' || true },
  { id: 'kindle', label: 'Kindle (EPUB)', ext: 'epub', mime: 'application/epub+zip', from: () => true },
  { id: 'docx', label: 'Word (DOCX)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', from: () => true },
  { id: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', from: (f) => f !== 'pdf' },
  { id: 'html', label: 'HTML', ext: 'html', mime: 'text/html', from: () => true },
  { id: 'md', label: 'Markdown', ext: 'md', mime: 'text/markdown', from: () => true },
  { id: 'txt', label: 'Text', ext: 'txt', mime: 'text/plain', from: () => true },
  { id: 'fb2', label: 'FictionBook (FB2)', ext: 'fb2', mime: 'application/x-fictionbook+xml', from: () => true },
  { id: 'odt', label: 'OpenDocument (ODT)', ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', from: () => true },
  { id: 'rtf', label: 'Rich Text (RTF)', ext: 'rtf', mime: 'application/rtf', from: () => true },
  { id: 'cbz', label: 'Comic (CBZ)', ext: 'cbz', mime: 'application/vnd.comicbook+zip', from: (f) => f === 'pdf' || f === 'cbz' || f === 'image' },
];

/* ------------------------------------------------------------------ */
/* FB2, ODT, RTF: the chapters' blocks, with their headings, lists, emphasis and pictures as each format has them */
/* ------------------------------------------------------------------ */

type Run = { text: string; b?: boolean; i?: boolean; sup?: boolean };
type Blk = { kind: 'h' | 'p' | 'li' | 'quote' | 'pre' | 'img'; level?: number; runs: Run[]; src?: string; rtl?: boolean };

/** A chapter's HTML as plain blocks of runs. */
function blocksOf(html: string): Blk[] {
  const host = document.createElement('div'); host.innerHTML = html;
  host.querySelectorAll('rt, rp, script, style').forEach((e) => e.remove());
  const out: Blk[] = [];
  const runsOf = (el: Element, st: { b?: boolean; i?: boolean; sup?: boolean } = {}): Run[] => {
    const rs: Run[] = [];
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) { const t = (n.textContent ?? '').replace(/\s+/g, ' '); if (t) rs.push({ text: t, ...st }); }
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as Element; const tag = e.tagName.toLowerCase();
        if (tag === 'br') { rs.push({ text: '\n', ...st }); continue; }
        if (tag === 'img') { const src = e.getAttribute('src'); if (src) out.push({ kind: 'img', runs: [], src }); continue; }
        rs.push(...runsOf(e, { b: st.b || tag === 'b' || tag === 'strong', i: st.i || tag === 'i' || tag === 'em', sup: st.sup || tag === 'sup' }));
      }
    }
    return rs;
  };
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      const tag = c.tagName.toLowerCase();
      const rtl = c.getAttribute('dir') === 'rtl' || undefined;
      if (/^h[1-6]$/.test(tag)) out.push({ kind: 'h', level: Number(tag[1]), runs: runsOf(c), rtl });
      else if (tag === 'p' || tag === 'dd' || tag === 'dt' || tag === 'figcaption') out.push({ kind: 'p', runs: runsOf(c), rtl });
      else if (tag === 'li') { if (c.querySelector('p, ul, ol')) walk(c); else out.push({ kind: 'li', runs: runsOf(c), rtl }); }
      else if (tag === 'blockquote') { if (c.querySelector('p')) { const at = out.length; walk(c); for (let k = at; k < out.length; k++) out[k].kind = 'quote'; } else out.push({ kind: 'quote', runs: runsOf(c), rtl }); }
      else if (tag === 'pre') out.push({ kind: 'pre', runs: [{ text: c.textContent ?? '' }], rtl });
      else if (tag === 'img') { const src = c.getAttribute('src'); if (src) out.push({ kind: 'img', runs: [], src }); }
      else if (tag === 'table') { for (const tr of Array.from(c.querySelectorAll('tr'))) out.push({ kind: 'p', runs: Array.from(tr.children).flatMap((td, i) => [...(i ? [{ text: ' | ' }] : []), ...runsOf(td)]), rtl }); }
      else if (c.children.length && !c.querySelector('img') && !/^(ul|ol|div|section|article|header|footer|main|aside|nav|figure|details)$/.test(tag) && !c.querySelector('p, li, h1, h2, h3, h4')) out.push({ kind: 'p', runs: runsOf(c), rtl });
      else walk(c);
    }
  };
  walk(host);
  return out.filter((b) => b.kind === 'img' || b.runs.some((r) => r.text.trim()));
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function buildFb2(d: ConvDoc, progress: Progress): Promise<Blob> {
  progress('build', 10);
  const imgIds = new Map<string, string>(); let k = 0;
  const bins: string[] = [];
  for (const [url, blob] of d.images) { const id = `img${++k}.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`; imgIds.set(url, id); bins.push(`<binary id="${id}" content-type="${blob.type || 'image/png'}">${(await blobToDataUrl(blob)).split(',')[1]}</binary>`); }
  const runs = (rs: Run[]) => rs.map((r) => { let t = xml(r.text).replace(/\n/g, '<empty-line/>'); if (r.sup) t = `<sup>${t}</sup>`; if (r.i) t = `<emphasis>${t}</emphasis>`; if (r.b) t = `<strong>${t}</strong>`; return t; }).join('');
  const sections = d.chapters.map((ch) => {
    const body = blocksOf(ch.html).map((b) => b.kind === 'img' ? (imgIds.get(b.src!) ? `<image l:href="#${imgIds.get(b.src!)}"/>` : '') : b.kind === 'h' ? `<subtitle>${runs(b.runs)}</subtitle>` : b.kind === 'quote' ? `<cite><p>${runs(b.runs)}</p></cite>` : b.kind === 'pre' ? `<p><code>${runs(b.runs)}</code></p>` : `<p>${b.kind === 'li' ? '• ' : ''}${runs(b.runs)}</p>`).join('\n');
    return `<section><title><p>${xml(ch.title)}</p></title>\n${body}\n</section>`;
  });
  const cover = d.cover ? `<coverpage><image l:href="#cover.${(d.cover.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}"/></coverpage>` : '';
  if (d.cover) bins.push(`<binary id="cover.${(d.cover.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}" content-type="${d.cover.type || 'image/jpeg'}">${(await blobToDataUrl(d.cover)).split(',')[1]}</binary>`);
  const [first = '', ...rest] = (d.author ?? '').split(' ');
  const out = `<?xml version="1.0" encoding="UTF-8"?>\n<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">\n<description><title-info>${d.author ? `<author><first-name>${xml(first)}</first-name><last-name>${xml(rest.join(' '))}</last-name></author>` : ''}<book-title>${xml(d.title)}</book-title>${d.lang ? `<lang>${xml(d.lang)}</lang>` : ''}${cover}</title-info><document-info><program-used>KurokawaReader</program-used></document-info></description>\n<body>\n${sections.join('\n')}\n</body>\n${bins.join('\n')}\n</FictionBook>`;
  return new Blob([out], { type: 'application/x-fictionbook+xml' });
}

export async function buildOdt(d: ConvDoc, progress: Progress): Promise<Blob> {
  progress('build', 10);
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  const pics: string[] = []; const picOf = new Map<string, string>(); let k = 0;
  for (const [url, blob] of d.images) { const name = `Pictures/img${++k}.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`; picOf.set(url, name); zip.file(name, blob); pics.push(`<manifest:file-entry manifest:full-path="${name}" manifest:media-type="${blob.type || 'image/png'}"/>`); }
  const runs = (rs: Run[]) => rs.map((r) => { const st = r.b && r.i ? 'BI' : r.b ? 'B' : r.i ? 'I' : r.sup ? 'Sup' : ''; const t = xml(r.text).replace(/\n/g, '<text:line-break/>'); return st ? `<text:span text:style-name="${st}">${t}</text:span>` : t; }).join('');
  const body: string[] = [];
  d.chapters.forEach((ch, i) => {
    if (d.chapters.length > 1) body.push(`<text:h text:style-name="${i ? 'H1' : 'H1First'}" text:outline-level="1">${xml(ch.title)}</text:h>`);
    for (const b of blocksOf(ch.html)) {
      const dir = b.rtl ?? d.rtl;
      if (b.kind === 'img') { const n = picOf.get(b.src!); if (n) body.push(`<text:p text:style-name="P"><draw:frame text:anchor-type="as-char" svg:width="12cm" svg:height="9cm"><draw:image xlink:href="${n}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`); continue; }
      if (b.kind === 'h') body.push(`<text:h text:style-name="H${Math.min(3, (b.level ?? 1) + 1)}" text:outline-level="${Math.min(3, (b.level ?? 1) + 1)}">${runs(b.runs)}</text:h>`);
      else if (b.kind === 'li') body.push(`<text:list text:style-name="L1"><text:list-item><text:p text:style-name="${dir ? 'PR' : 'P'}">${runs(b.runs)}</text:p></text:list-item></text:list>`);
      else body.push(`<text:p text:style-name="${b.kind === 'quote' ? 'Q' : b.kind === 'pre' ? 'Pre' : dir ? 'PR' : 'P'}">${runs(b.runs)}</text:p>`);
    }
  });
  const styles = `<office:styles><style:default-style style:family="paragraph"><style:paragraph-properties fo:line-height="150%"/><style:text-properties fo:font-size="12pt" style:font-name-complex="Traditional Arabic" style:font-size-complex="14pt"/></style:default-style>
<style:style style:name="P" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.2cm" fo:text-align="justify"/></style:style>
<style:style style:name="PR" style:family="paragraph" style:parent-style-name="P"><style:paragraph-properties style:writing-mode="rl-tb" fo:text-align="justify"/></style:style>
<style:style style:name="Q" style:family="paragraph" style:parent-style-name="P"><style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm"/><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Pre" style:family="paragraph"><style:text-properties style:font-name="Liberation Mono" fo:font-size="10pt"/></style:style>
<style:style style:name="H1" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.6cm" fo:margin-bottom="0.3cm" fo:break-before="page"/><style:text-properties fo:font-size="20pt" fo:font-weight="bold" style:font-weight-complex="bold"/></style:style>
<style:style style:name="H1First" style:family="paragraph" style:parent-style-name="H1"><style:paragraph-properties fo:break-before="auto"/></style:style>
<style:style style:name="H2" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.5cm" fo:margin-bottom="0.2cm"/><style:text-properties fo:font-size="16pt" fo:font-weight="bold" style:font-weight-complex="bold"/></style:style>
<style:style style:name="H3" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.4cm" fo:margin-bottom="0.2cm"/><style:text-properties fo:font-size="14pt" fo:font-weight="bold" style:font-weight-complex="bold"/></style:style>
<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold" style:font-weight-complex="bold"/></style:style>
<style:style style:name="I" style:family="text"><style:text-properties fo:font-style="italic" style:font-style-complex="italic"/></style:style>
<style:style style:name="BI" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/></style:style>
<style:style style:name="Sup" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:space-before="0.5cm" text:min-label-width="0.5cm"/></text:list-level-style-bullet></text:list-style></office:styles>`;
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2"';
  zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:font-face-decls><style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-family-generic="modern"/><style:font-face style:name="Traditional Arabic" svg:font-family="'Traditional Arabic'"/></office:font-face-decls><office:automatic-styles/><office:body><office:text>${body.join('\n')}</office:text></office:body></office:document-content>`);
  zip.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}><office:font-face-decls><style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-family-generic="modern"/><style:font-face style:name="Traditional Arabic" svg:font-family="'Traditional Arabic'"/></office:font-face-decls>${styles}</office:document-styles>`);
  zip.file('meta.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS}><office:meta><dc:title>${xml(d.title)}</dc:title>${d.author ? `<meta:initial-creator>${xml(d.author)}</meta:initial-creator><dc:creator>${xml(d.author)}</dc:creator>` : ''}${d.lang ? `<dc:language>${xml(d.lang)}</dc:language>` : ''}<meta:generator>KurokawaReader</meta:generator></office:meta></office:document-meta>`);
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>${pics.join('')}</manifest:manifest>`);
  storeCompressed(zip as unknown as ZipLike);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.oasis.opendocument.text', compression: 'DEFLATE' });
}

export function buildRtf(d: ConvDoc, progress: Progress): Blob {
  progress('build', 10);
  // (RTF is 7-bit: every character beyond ASCII goes as \uN with a '?' fallback; Arabic and the rest read back as Unicode.)
  const enc = (s: string) => Array.from(s).map((ch) => { const c = ch.codePointAt(0)!; if (c === 0x5c || c === 0x7b || c === 0x7d) return '\\' + ch; if (c < 0x80) return ch; if (c > 0xffff) { const hi = 0xd800 + ((c - 0x10000) >> 10), lo = 0xdc00 + ((c - 0x10000) & 0x3ff); return `\\u${hi - 0x10000}?\\u${lo - 0x10000}?`; } return `\\u${c > 0x7fff ? c - 0x10000 : c}?`; }).join('');
  const runs = (rs: Run[]) => rs.map((r) => { let t = enc(r.text).replace(/\n/g, '\\line '); if (r.b) t = `{\\b ${t}}`; if (r.i) t = `{\\i ${t}}`; if (r.sup) t = `{\\super ${t}}`; return t; }).join('');
  const out: string[] = ['{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}{\\f1 Traditional Arabic;}}\\viewkind4\\uc1'];
  out.push(`{\\pard\\qc\\fs40\\b ${enc(d.title)}\\par}`); if (d.author) out.push(`{\\pard\\qc\\fs24 ${enc(d.author)}\\par}`);
  d.chapters.forEach((ch, i) => {
    if (d.chapters.length > 1) out.push(`{\\pard${i ? '\\pagebb' : ''}\\sb360\\sa180\\fs32\\b ${enc(ch.title)}\\par}`);
    for (const b of blocksOf(ch.html)) {
      if (b.kind === 'img') continue;
      const rtl = b.rtl ?? d.rtl; const pd = rtl ? '\\rtlpar\\qr' : '\\ltrpar\\ql';
      if (b.kind === 'h') out.push(`{\\pard${pd}\\sb240\\sa120\\fs${b.level && b.level > 1 ? 28 : 32}\\b ${runs(b.runs)}\\par}`);
      else if (b.kind === 'li') out.push(`{\\pard${pd}\\li360\\fi-220\\sa100 \\u8226?  ${runs(b.runs)}\\par}`);
      else if (b.kind === 'quote') out.push(`{\\pard${pd}\\li500\\ri500\\sa120\\i ${runs(b.runs)}\\par}`);
      else if (b.kind === 'pre') out.push(`{\\pard${pd}\\f1\\fs18 ${runs(b.runs).replace(/\n/g, '\\line ')}\\par}`);
      else out.push(`{\\pard${pd}\\sa120\\fs24 ${runs(b.runs)}\\par}`);
    }
  });
  out.push('}');
  return new Blob([out.join('\n')], { type: 'application/rtf' });
}

/** A comic archive of the pages as pictures (a PDF's pages drawn; a book of pictures as they are). */
export async function buildCbz(book: Book, file: Blob, progress: Progress, password?: string): Promise<Blob> {
  const zip = new JSZip();
  if (book.format === 'pdf') {
    const pdfjs = await loadPdfjs();
    const { openPdfjs } = await import('./pdfkeys');
    const RES = new URL('./pdfjs/', import.meta.url).href;
    const o = await openPdfjs(pdfjs, new Uint8Array(await file.arrayBuffer()), { cMapUrl: `${RES}cmaps/`, cMapPacked: true, standardFontDataUrl: `${RES}standard_fonts/`, wasmUrl: `${RES}wasm/`, isEvalSupported: false, password });
    try {
      const n = o.doc.numPages; const digits = String(n).length;
      for (let i = 1; i <= n; i++) {
        const page = await o.doc.getPage(i); const vp = page.getViewport({ scale: 1600 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1]) });
        const c = offscreen(document.createElement('canvas')); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvas: c, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;
        const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('image'))), 'image/jpeg', 0.9));
        zip.file(`${String(i).padStart(digits, '0')}.jpg`, blob); page.cleanup(); c.width = c.height = 0;
        progress('render', (i / n) * 90);
      }
    } finally { o.destroy(); }
  } else {
    // (A comic archive or a picture: its pictures in order.)
    const src = await JSZip.loadAsync(file).catch(() => null);
    if (src) { const names = Object.keys(src.files).filter((nm) => /\.(jpe?g|png|webp|gif)$/i.test(nm) && !src.files[nm].dir).sort(); let k = 0; for (const nm of names) zip.file(`${String(++k).padStart(String(names.length).length, '0')}${nm.slice(nm.lastIndexOf('.'))}`, await src.files[nm].async('blob')); }
    else zip.file(`1.${(file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`, file);
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

export async function convertBook(book: Book, target: Target, progress: Progress, password?: string, opts: ConvOptions = {}): Promise<{ blob: Blob; name: string }> {
  const file = await db.getFile(book.id);
  if (!file) throw new Error('missing');
  const tg = TARGETS.find((x) => x.id === target)!;
  // PDF → Word keeps the page layout (its own path); other routes go through the reflowed document.
  if (book.format === 'pdf' && target === 'docx') {
    try {
      const { pdfToDocx } = await import('./pdf2docx');
      const blob = await pdfToDocx(book, file, progress, password);
      progress('done', 100);
      return { blob, name: `${slug(book.title)}.${tg.ext}` };
    } catch (err) {
      if ((err as Error).message === 'password') throw err;
      console.warn('[kurokawa] layout PDF → DOCX failed, using the reflowed route', err);
    }
  }
  if (target === 'cbz') { const blob = await buildCbz(book, file, progress, password); progress('done', 100); return { blob, name: `${slug(book.title)}.cbz` }; }
  const d = await readDocument(book, file, progress, password);
  // (Without pictures: a much smaller file, the text alone.)
  if (opts.images === false) { for (const url of d.images.keys()) for (const ch of d.chapters) ch.html = ch.html.replace(new RegExp(`<img[^>]*src="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'g'), ''); d.images.clear(); delete d.cover; }
  let blob: Blob;
  if (target === 'fb2') blob = await buildFb2(d, progress);
  else if (target === 'odt') blob = await buildOdt(d, progress);
  else if (target === 'rtf') blob = buildRtf(d, progress);
  else if (target === 'epub' || target === 'kindle') {
    if (target === 'kindle') { d.fonts.clear(); }   // Kindle prefers its own typefaces; embedded fonts often fail its import
    blob = await buildEpub(d, progress);
  } else if (target === 'docx') blob = await buildDocx(d, progress);
  else if (target === 'pdf') blob = await buildPdf(d, progress, opts);
  else if (target === 'html') { const inline = new Map<string, string>(); for (const [u, b] of d.images) inline.set(u, await blobToDataUrl(b)); blob = new Blob([buildHtml(d, inline)], { type: 'text/html' }); }
  else blob = new Blob([buildText(d, target === 'md')], { type: tg.mime + ';charset=utf-8' });
  progress('done', 100);
  void getSettings;
  return { blob, name: `${slug(book.title)}.${tg.ext}` };
}
