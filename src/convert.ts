// File conversion. Every book is first read into one neutral document (chapters of
// HTML, pictures, embedded fonts, direction), then written out as EPUB (also the
// Kindle route — Send to Kindle takes EPUB), DOCX, PDF, HTML, Markdown or plain text.
//
// PDFs are the hard case: their text comes out as positioned fragments, so lines are
// rebuilt from geometry (right-to-left when the line is Arabic/Hebrew), paragraphs
// from the spacing, headings from the font size — and the fonts the PDF embeds are
// carried over, so an Arabic, Japanese or Chinese PDF keeps its look in the EPUB.
import { joinLine, cleanPdfText } from './pdftext';
import JSZip from 'jszip';
import { db, type Book } from './db';
import { flowHandlerFor } from './formats';
import { loadPdfjs } from './formats/pdf';
import { getSettings } from './settings';
import { isRtlText } from './i18n';

/** Formats the converter can read. */
export const convertible = (f: Book['format']) => !['image', 'cbz', 'anki', 'audio', 'unknown'].includes(f);

export type Target = 'epub' | 'kindle' | 'docx' | 'pdf' | 'html' | 'md' | 'txt';
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
  const task = pdfjs.getDocument({ data, password, useSystemFonts: false, fontExtraProperties: true } as Parameters<typeof pdfjs.getDocument>[0]);
  let doc; try { doc = await task.promise; } catch (e) { if ((e as Error).name === 'PasswordException') throw new Error('password'); throw e; }
  const fonts = new Map<string, { blob: Blob; ext: string }>();
  const fontFamilies = new Map<string, string>();   // pdf.js font id → css family
  const paragraphs: { text: string; size: number; rtl: boolean; family?: string; heading: boolean; page: number }[] = [];
  const sizes: number[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    progress('pdfPage', Math.round((p / doc.numPages) * 60));
    const page = await doc.getPage(p);
    // Fonts are only loaded by rendering the operator list; after that commonObjs has them.
    try { await page.getOperatorList(); } catch { /* ignore */ }
    const tc = await page.getTextContent();
    type It = { str: string; x: number; y: number; w: number; h: number; font: string; eol: boolean };
    const items: It[] = [];
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const [a, b, , , e, f] = it.transform;
      const h = it.height || Math.hypot(a, b) || 10;
      const str = cleanPdfText(it.str);
      items.push({ str: /^\u2009+$/.test(str) ? '\u2009' : str, x: e, y: f, w: it.width, h, font: it.fontName, eol: !!it.hasEOL });
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
    // Lines by vertical position (PDF y grows upwards).
    const sorted = items.filter((i) => i.str.trim() || i.str === '\u2009' || i.eol).sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: It[][] = [];
    for (const it of sorted) { const cur = lines[lines.length - 1]; if (cur && Math.abs(cur[0].y - it.y) < Math.max(cur[0].h, it.h) * 0.5) cur.push(it); else lines.push([it]); }
    let prevBottom: number | null = null; let prevSize = 0; let buf = ''; let bufSize = 0; let bufFont: string | undefined; let bufRtl = false;
    const flush = () => { if (buf.trim()) { paragraphs.push({ text: buf.replace(/\s+/g, ' ').trim(), size: bufSize, rtl: bufRtl, family: bufFont, heading: false, page: p }); sizes.push(bufSize); } buf = ''; };
    for (const line of lines) {
      const joinedLine = joinLine(line.map((i) => ({ text: i.str, l: i.x, r: i.x + i.w, h: i.h })));
      const rtl = joinedLine.rtl;
      let text = joinedLine.text;
      text = fixArabicLine(text.trim());
      if (!text) continue;
      const size = Math.max(...line.map((i) => i.h));
      const top = line[0].y + size; const bottom = line[0].y;
      const gap = prevBottom === null ? 0 : prevBottom - top;
      const newPara = prevBottom === null || gap > size * 0.9 || Math.abs(size - prevSize) > prevSize * 0.25 || /[.!?؟。！？]["»”]?$/.test(buf.trim()) && /^[؀-ۿA-Z一-鿿"«“]/.test(text) && gap > size * 0.3;
      if (newPara) { flush(); bufSize = size; bufFont = fontFamilies.get(line[0].font); bufRtl = rtl; }
      buf += (buf ? ' ' : '') + text;
      prevBottom = bottom; prevSize = size;
    }
    flush();
    page.cleanup();
  }
  await task.destroy();
  // Headings: noticeably larger than the common size.
  const median = sizes.length ? [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : 12;
  for (const para of paragraphs) para.heading = para.size > median * 1.25 && para.text.length < 140;
  // Chapters: split at headings; otherwise one chapter per ~60 paragraphs.
  const chapters: Chapter[] = [];
  let cur: string[] = []; let curTitle = book.title; let curRtl = false; let rtlCount = 0, count = 0;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const pushChapter = () => { if (cur.length) chapters.push({ title: curTitle, html: cur.join('\n'), rtl: rtlCount > count / 2 }); cur = []; rtlCount = 0; count = 0; };
  for (const para of paragraphs) {
    const style = para.family && fonts.has(para.family) ? ` style="font-family:'${para.family}'"` : '';
    const dir = para.rtl ? ' dir="rtl"' : ' dir="ltr"';
    if (para.heading) { pushChapter(); curTitle = para.text; cur.push(`<h2${dir}${style}>${esc(para.text)}</h2>`); }
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
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

export async function buildDocx(d: ConvDoc, progress: Progress): Promise<Blob> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType } = docx;
  const children: InstanceType<typeof Paragraph>[] = [];
  const imgDims = new Map<string, { w: number; h: number; type: 'png' | 'jpg' | 'gif' | 'bmp' }>();
  for (const [url, blob] of d.images) {
    try { const bmp = await createImageBitmap(blob); const scale = Math.min(1, 500 / bmp.width); imgDims.set(url, { w: Math.round(bmp.width * scale), h: Math.round(bmp.height * scale), type: blob.type.includes('png') ? 'png' : blob.type.includes('gif') ? 'gif' : blob.type.includes('bmp') ? 'bmp' : 'jpg' }); } catch { /* skip */ }
  }
  const imgData = new Map<string, Uint8Array>();
  for (const [url, blob] of d.images) imgData.set(url, new Uint8Array(await blob.arrayBuffer()));
  const walkBlock = (el: Element, rtl: boolean) => {
    const tag = el.tagName.toLowerCase();
    const dir = el.getAttribute('dir') === 'rtl' ? true : el.getAttribute('dir') === 'ltr' ? false : rtl || isRtlText(el.textContent ?? '');
    const family = (el as HTMLElement).style?.fontFamily?.replace(/['"]/g, '') || undefined;
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? ''; const dim = imgDims.get(src); const data = imgData.get(src);
      if (dim && data) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data, type: dim.type, transformation: { width: dim.w, height: dim.h } })] }));
      return;
    }
    if (/^h[1-6]$/.test(tag)) { children.push(new Paragraph({ heading: tag === 'h1' ? HeadingLevel.HEADING_1 : tag === 'h2' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, bidirectional: dir, alignment: dir ? AlignmentType.RIGHT : AlignmentType.LEFT, children: runs(el, dir, family) })); return; }
    if (tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'pre' || tag === 'figcaption' || tag === 'dd' || tag === 'dt' || tag === 'td' || tag === 'th') {
      const imgs = Array.from(el.querySelectorAll('img'));
      const r = runs(el, dir, family);
      if (r.length) children.push(new Paragraph({ bidirectional: dir, alignment: dir ? AlignmentType.RIGHT : AlignmentType.LEFT, indent: tag === 'blockquote' ? { left: 720 } : undefined, bullet: tag === 'li' ? { level: 0 } : undefined, children: r }));
      imgs.forEach((im) => walkBlock(im, dir));
      return;
    }
    if (tag === 'hr' || tag === 'br') { children.push(new Paragraph({ children: [] })); return; }
    const kids = Array.from(el.children);
    if (!kids.length) { const r = runs(el, dir, family); if (r.length) children.push(new Paragraph({ bidirectional: dir, alignment: dir ? AlignmentType.RIGHT : AlignmentType.LEFT, children: r })); return; }
    // Loose text directly inside a container becomes its own paragraph.
    const loose = Array.from(el.childNodes).filter((nd) => nd.nodeType === 3 && nd.textContent?.trim()).map((nd) => nd.textContent!.trim()).join(' ');
    if (loose) children.push(new Paragraph({ bidirectional: dir, children: [new TextRun({ text: loose, rightToLeft: dir, font: family })] }));
    kids.forEach((k) => walkBlock(k, dir));
  };
  const runs = (el: Element, rtl: boolean, family?: string): InstanceType<typeof TextRun>[] => {
    const out: InstanceType<typeof TextRun>[] = [];
    const visit = (node: Node, b: boolean, i: boolean) => {
      if (node.nodeType === 3) { const txt = (node.textContent ?? '').replace(/\s+/g, ' '); if (txt.trim()) out.push(new TextRun({ text: txt, bold: b || undefined, italics: i || undefined, rightToLeft: rtl || undefined, font: family })); return; }
      if (node.nodeType !== 1) return;
      const e = node as Element; const tg = e.tagName.toLowerCase();
      if (tg === 'img' || tg === 'rt' || tg === 'rp') return;
      if (tg === 'br') { out.push(new TextRun({ break: 1 })); return; }
      node.childNodes.forEach((c) => visit(c, b || tg === 'b' || tg === 'strong', i || tg === 'i' || tg === 'em'));
    };
    el.childNodes.forEach((c) => visit(c, false, false));
    return out;
  };
  d.chapters.forEach((ch, i) => {
    progress('build', 65 + Math.round((i / d.chapters.length) * 30));
    const host = globalThis.document.createElement('div'); host.innerHTML = ch.html;
    if (d.chapters.length > 1 && !/<h[1-3][\s>]/i.test(ch.html.slice(0, 600))) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: ch.rtl, alignment: ch.rtl ? AlignmentType.RIGHT : AlignmentType.LEFT, pageBreakBefore: i > 0, children: [new TextRun({ text: ch.title, rightToLeft: ch.rtl || undefined })] }));
    Array.from(host.children).forEach((el: Element) => walkBlock(el, ch.rtl));
  });
  const fontNames = [...d.fonts.keys()];
  const wordDoc = new Document({ creator: d.author ?? 'KurokawaReader', title: d.title, description: fontNames.length ? `Fonts used in the source: ${fontNames.join(', ')}` : undefined, styles: { default: { document: { run: { font: d.rtl ? 'Arial' : 'Calibri', size: 24 } } } }, sections: [{ properties: { page: { textDirection: undefined } }, children }] });
  const blob = await Packer.toBlob(wordDoc);
  return blob;
}

export function buildHtml(d: ConvDoc, inlineImages: Map<string, string>): string {
  const body = d.chapters.map((ch) => { let html = ch.html; for (const [url, data] of inlineImages) html = html.split(`src="${url}"`).join(`src="${data}"`); return `<section${ch.rtl ? ' dir="rtl"' : ''}>${d.chapters.length > 1 && !/<h[1-3][\s>]/i.test(html.slice(0, 600)) ? `<h2>${esc(ch.title)}</h2>` : ''}${html}</section>`; }).join('\n');
  return `<!doctype html>\n<html${d.lang ? ` lang="${esc(d.lang)}"` : ''}${d.rtl ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(d.title)}</title><style>body{max-width:760px;margin:2em auto;padding:0 1em;line-height:1.7;font-family:Georgia,'Noto Naskh Arabic',serif;font-size:18px}img{max-width:100%;height:auto}h1,h2,h3{line-height:1.3}[dir=rtl]{text-align:right}</style></head><body><h1>${esc(d.title)}</h1>${d.author ? `<p><i>${esc(d.author)}</i></p>` : ''}${body}</body></html>`;
}

export function buildText(d: ConvDoc, markdown: boolean): string {
  const out: string[] = [];
  if (markdown) { out.push(`# ${d.title}`); if (d.author) out.push(`*${d.author}*`); out.push(''); }
  else { out.push(d.title); if (d.author) out.push(d.author); out.push(''); }
  for (const ch of d.chapters) {
    const host = document.createElement('div'); host.innerHTML = ch.html;
    if (d.chapters.length > 1) out.push(markdown ? `## ${ch.title}` : `\n${ch.title}\n`);
    host.querySelectorAll('rt, rp').forEach((e) => e.remove());
    for (const el of Array.from(host.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, td, th, figcaption, dd, dt'))) {
      if (el.querySelector('p, li, h1, h2, h3')) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim(); if (!text) continue;
      const tag = el.tagName.toLowerCase();
      if (markdown) out.push(/^h[1-4]$/.test(tag) ? `${'#'.repeat(Math.min(6, Number(tag[1]) + 1))} ${text}` : tag === 'li' ? `- ${text}` : tag === 'blockquote' ? `> ${text}` : text);
      else out.push(text);
      out.push('');
    }
    if (!host.querySelector('p, li, h1, h2, h3')) { const t = (host.textContent ?? '').trim(); if (t) { out.push(t); out.push(''); } }
  }
  return out.join('\n');
}

/** PDF: real text on the desktop (Chromium's printer), pictures of pages elsewhere. */
export async function buildPdf(d: ConvDoc, progress: Progress): Promise<Blob> {
  const inline = new Map<string, string>();
  for (const [url, blob] of d.images) inline.set(url, await blobToDataUrl(blob));
  const fontCss = await readerFontCss(d);
  const desk = (window as unknown as { kurokawaDesktop?: { printToPdf?(html: string, o?: { pageSize?: string }): Promise<string> } }).kurokawaDesktop;
  const html = buildHtml(d, inline).replace('</style>', `${fontCss}\nbody{font-family:'Lora','Uthman TN1','Noto Naskh Arabic',Georgia,serif}@page{size:A4;margin:16mm}section{page-break-before:always}section:first-of-type{page-break-before:auto}</style>`);
  if (desk?.printToPdf) {
    progress('build', 70);
    const b64 = await desk.printToPdf(html, { pageSize: 'A4' });
    return b64ToBlob(b64, 'application/pdf');
  }
  // Pictures of pages: lay the HTML out at A4 width, slice by page height, rasterise each slice.
  const { PDFDocument } = await import('pdf-lib');
  const W = 794, H = 1123, SCALE = 1.5;
  const frame = document.createElement('iframe');
  frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;height:${H}px;visibility:hidden;border:0`;
  document.body.appendChild(frame);
  try {
    const fdoc = frame.contentDocument!; fdoc.open(); fdoc.write(html.replace('<style>', `<style>html,body{margin:0}body{max-width:none;padding:48px 56px;width:${W - 112}px}`)); fdoc.close();
    await new Promise((r) => setTimeout(r, 300));
    await (fdoc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
    const total = fdoc.documentElement.scrollHeight;
    const pages = Math.max(1, Math.ceil(total / H));
    const pdf = await PDFDocument.create();
    pdf.setTitle(d.title); if (d.author) pdf.setAuthor(d.author);
    // What goes into each page picture: the page's CSS (CDATA-wrapped for XML) and the body as XHTML.
    const cssText = Array.from(fdoc.querySelectorAll('style')).map((st) => st.textContent ?? '').join('\n');
    const bodyX = new XMLSerializer().serializeToString(fdoc.body).replace(/^<body[^>]*>|<\/body>$/g, '');
    for (let p = 0; p < pages; p++) {
      progress('pdfPage', 65 + Math.round((p / pages) * 32));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="${W}" height="${H}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;overflow:hidden;background:#fff"><style><![CDATA[${cssText.replace(/\]\]>/g, '')}]]></style><div style="transform:translateY(-${p * H}px)"><body${d.rtl ? ' dir="rtl"' : ''} style="display:block">${bodyX}</body></div></div></foreignObject></svg>`;
      const img = new Image(); img.decoding = 'async';
      // A data: URL (not blob:) keeps the canvas untainted so it can be exported.
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => { const perr = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')?.textContent; rej(new Error('page render' + (perr ? ': ' + perr.slice(0, 200) : ''))); }; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const c = document.createElement('canvas'); c.width = W * SCALE; c.height = H * SCALE;
      const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      const jpg = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.8));
      const image = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      const page = pdf.addPage([595.28, 841.89]);
      page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
    }
    const bytes = await pdf.save();
    return new Blob([bytes as BlobPart], { type: 'application/pdf' });
  } finally { frame.remove(); }
}

/** The reader's own fonts (and the source's) inlined, so the printed page looks like the app. */
async function readerFontCss(d: ConvDoc): Promise<string> {
  let css = '';
  for (const [family, f] of d.fonts) css += `@font-face{font-family:'${family}';src:url(${await blobToDataUrl(f.blob)})}\n`;
  const want = new Set<string>(['Lora', 'Uthman TN1', 'Inter']);
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList; try { rules = sheet.cssRules; } catch { continue; }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const fam = r.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
      if (!want.has(fam)) continue;
      const m = /url\(["']?([^"')]+)["']?\)/.exec(r.style.getPropertyValue('src')); if (!m) continue;
      try { const blob = await (await fetch(m[1])).blob(); css += `@font-face{font-family:'${fam}';src:url(${await blobToDataUrl(blob)});font-weight:${r.style.getPropertyValue('font-weight') || 'normal'};font-style:${r.style.getPropertyValue('font-style') || 'normal'}}\n`; } catch { /* skip */ }
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
];

export async function convertBook(book: Book, target: Target, progress: Progress, password?: string): Promise<{ blob: Blob; name: string }> {
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
  const d = await readDocument(book, file, progress, password);
  let blob: Blob;
  if (target === 'epub' || target === 'kindle') {
    if (target === 'kindle') { d.fonts.clear(); }   // Kindle prefers its own typefaces; embedded fonts often fail its import
    blob = await buildEpub(d, progress);
  } else if (target === 'docx') blob = await buildDocx(d, progress);
  else if (target === 'pdf') blob = await buildPdf(d, progress);
  else if (target === 'html') { const inline = new Map<string, string>(); for (const [u, b] of d.images) inline.set(u, await blobToDataUrl(b)); blob = new Blob([buildHtml(d, inline)], { type: 'text/html' }); }
  else blob = new Blob([buildText(d, target === 'md')], { type: tg.mime + ';charset=utf-8' });
  progress('done', 100);
  void getSettings;
  return { blob, name: `${slug(book.title)}.${tg.ext}` };
}
