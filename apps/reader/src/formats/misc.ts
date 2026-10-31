// FictionBook (FB2), OpenDocument Text (ODT), comic archives (CBZ) and images.
import JSZip from 'jszip';
import type { FlowHandler, FlowRender, ImageRef, TocItem } from './types';
import { titleFromFileName } from './types';
import { UrlPool, collectImages, decodeText, el, markDirections, mimeFor, parseXml, resolveZipPath, sanitize, tocFromHeadings, zipFile } from './shared';

/* ---------- FB2 ---------- */
const XLINK = 'http://www.w3.org/1999/xlink';

async function fb2Doc(file: Blob): Promise<Document> {
  let text = await decodeText(file);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return parseXml(text);
}

export const fb2Handler: FlowHandler = {
  kind: 'flow',
  format: 'fb2',
  async readMeta(file, fileName) {
    const doc = await fb2Doc(file);
    const ti = doc.querySelector('description > title-info');
    const title = ti?.querySelector('book-title')?.textContent?.trim();
    const a = ti?.querySelector('author');
    const author = a ? [a.querySelector('first-name')?.textContent, a.querySelector('middle-name')?.textContent, a.querySelector('last-name')?.textContent].filter(Boolean).join(' ') : undefined;
    let cover: Blob | undefined;
    const coverHref = ti?.querySelector('coverpage > image')?.getAttributeNS(XLINK, 'href')?.replace(/^#/, '');
    if (coverHref) {
      const bin = [...doc.querySelectorAll('binary')].find((b) => b.getAttribute('id') === coverHref);
      if (bin) cover = b64ToBlob(bin.textContent ?? '', bin.getAttribute('content-type') ?? 'image/jpeg');
    }
    return { title: title || titleFromFileName(fileName), author: author || undefined, language: ti?.querySelector('lang')?.textContent?.trim(), cover };
  },
  async render(file, ctx): Promise<FlowRender> {
    const doc = await fb2Doc(file);
    const pool = new UrlPool();
    const binaries = new Map<string, string>();
    doc.querySelectorAll('binary').forEach((b) => {
      const id = b.getAttribute('id');
      if (id) binaries.set(id, pool.fromBlob(id, b64ToBlob(b.textContent ?? '', b.getAttribute('content-type') ?? 'image/jpeg')));
    });
    const root = el('div', 'kr-content kr-fb2');
    const toc: TocItem[] = [];
    let n = 0;
    const convert = (node: Element, target: HTMLElement, depth: number) => {
      for (const c of node.children) {
        switch (c.localName) {
          case 'title': {
            const hd = el(`h${Math.min(6, depth + 1)}` as 'h1');
            hd.textContent = [...c.querySelectorAll('p')].map((p) => p.textContent?.trim()).filter(Boolean).join(' — ') || c.textContent?.trim() || '';
            hd.id = ctx.id(`fb2-t${n++}`);
            target.appendChild(hd);
            if (hd.textContent) toc.push({ label: hd.textContent, depth: Math.max(0, depth - 1), anchor: hd.id });
            break;
          }
          case 'section': { const s = el('section'); target.appendChild(s); convert(c, s, depth + 1); break; }
          case 'epigraph': case 'cite': case 'annotation': { const q = el('blockquote'); target.appendChild(q); convert(c, q, depth); break; }
          case 'poem': { const d = el('div', 'kr-poem'); target.appendChild(d); convert(c, d, depth); break; }
          case 'stanza': { const p = el('p'); for (const v of c.children) { if (v.localName === 'v') { inline(v, p); p.appendChild(el('br')); } } target.appendChild(p); break; }
          case 'subtitle': { const h = el('h4'); inline(c, h); target.appendChild(h); break; }
          case 'p': case 'text-author': case 'v': { const p = el('p'); inline(c, p); target.appendChild(p); break; }
          case 'empty-line': target.appendChild(el('br')); break;
          case 'image': {
            const href = c.getAttributeNS(XLINK, 'href')?.replace(/^#/, '') ?? '';
            const url = binaries.get(href);
            if (url) { const img = el('img'); img.src = url; target.appendChild(img); }
            break;
          }
          case 'table': {
            const table = el('table');
            for (const tr of c.children) { const row = el('tr'); for (const td of tr.children) { const cell = el(td.localName === 'th' ? 'th' : 'td'); inline(td, cell); row.appendChild(cell); } table.appendChild(row); }
            target.appendChild(table);
            break;
          }
          default: convert(c, target, depth);
        }
      }
    };
    const inline = (node: Element, target: HTMLElement) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) target.appendChild(document.createTextNode(ch.textContent ?? ''));
        else if (ch.nodeType === 1) {
          const e = ch as Element;
          const map: Record<string, string> = { strong: 'strong', emphasis: 'em', strikethrough: 's', sup: 'sup', sub: 'sub', code: 'code', a: 'a', style: 'span' };
          const tag = map[e.localName];
          if (e.localName === 'image') { const url = binaries.get(e.getAttributeNS(XLINK, 'href')?.replace(/^#/, '') ?? ''); if (url) { const img = el('img', 'inline'); img.src = url; target.appendChild(img); } continue; }
          const w = el((tag ?? 'span') as 'span');
          if (tag === 'a') { const href = e.getAttributeNS(XLINK, 'href') ?? ''; if (/^https?:/.test(href)) { (w as HTMLAnchorElement).href = href; (w as HTMLAnchorElement).target = '_blank'; } }
          inline(e, w);
          target.appendChild(w);
        }
      }
    };
    doc.querySelectorAll('body').forEach((b, i) => {
      const bodyEl = el('section', i > 0 ? 'kr-notes-body' : undefined);
      if (b.getAttribute('name') === 'notes' && i > 0) { bodyEl.appendChild(el('hr')); }
      convert(b, bodyEl, 0);
      root.appendChild(bodyEl);
    });
    const rtl = markDirections(root);
    return { element: root, toc: toc.length ? toc : tocFromHeadings(root, ctx, 'fb2'), images: collectImages(root, ctx, 'fb2'), rtl, dispose: () => pool.dispose() };
  },
};

function b64ToBlob(b64: string, type: string): Blob {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

/* ---------- ODT ---------- */
const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const DRAW_NS = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';

export const odtHandler: FlowHandler = {
  kind: 'flow',
  format: 'odt',
  async readMeta(file, fileName) {
    try {
      const zip = await JSZip.loadAsync(file);
      const meta = zipFile(zip, 'meta.xml');
      if (meta) {
        const md = parseXml(await meta.async('text'));
        const title = md.getElementsByTagName('dc:title')[0]?.textContent?.trim();
        const author = md.getElementsByTagName('meta:initial-creator')[0]?.textContent?.trim() || md.getElementsByTagName('dc:creator')[0]?.textContent?.trim();
        return { title: title || titleFromFileName(fileName), author: author || undefined };
      }
    } catch { /* ignore */ }
    return { title: titleFromFileName(fileName) };
  },
  async render(file, ctx): Promise<FlowRender> {
    const zip = await JSZip.loadAsync(file);
    const pool = new UrlPool();
    const doc = parseXml(await zipFile(zip, 'content.xml')!.async('text'));
    const root = el('div', 'kr-content kr-odt');
    const tasks: Promise<void>[] = [];
    const inline = (node: Element, target: HTMLElement) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) target.appendChild(document.createTextNode(ch.textContent ?? ''));
        else if (ch.nodeType === 1) {
          const e = ch as Element;
          if (e.namespaceURI === TEXT_NS) {
            if (e.localName === 's') target.appendChild(document.createTextNode(' '.repeat(Number(e.getAttributeNS(TEXT_NS, 'c') ?? 1))));
            else if (e.localName === 'tab') target.appendChild(document.createTextNode('\t'));
            else if (e.localName === 'line-break') target.appendChild(el('br'));
            else if (e.localName === 'a') { const a = el('a'); inline(e, a); target.appendChild(a); }
            else if (e.localName === 'note') { const sup = el('sup'); sup.textContent = `[${e.querySelector('note-citation')?.textContent ?? '*'}]`; target.appendChild(sup); const nb = e.getElementsByTagNameNS(TEXT_NS, 'note-body')[0]; if (nb) { const q = el('blockquote'); blocks(nb, q); target.appendChild(q); } }
            else { const span = el('span'); inline(e, span); target.appendChild(span); }
          } else if (e.namespaceURI === DRAW_NS && e.localName === 'frame') {
            const im = e.getElementsByTagNameNS(DRAW_NS, 'image')[0];
            const href = im?.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
            if (href) { const img = el('img'); target.appendChild(img); tasks.push(pool.fromZip(zip, resolveZipPath('content.xml', href)).then((u) => { if (u) img.src = u; else img.remove(); })); }
          } else inline(e, target);
        }
      }
    };
    const blocks = (node: Element, target: HTMLElement) => {
      for (const c of node.children) {
        if (c.namespaceURI === TEXT_NS && c.localName === 'h') { const lvl = Math.min(6, Number(c.getAttributeNS(TEXT_NS, 'outline-level') ?? 1)); const hd = el(`h${lvl}` as 'h1'); inline(c, hd); target.appendChild(hd); }
        else if (c.namespaceURI === TEXT_NS && c.localName === 'p') { const p = el('p'); inline(c, p); target.appendChild(p); }
        else if (c.namespaceURI === TEXT_NS && c.localName === 'list') { const ul = el('ul'); for (const li of c.children) { const item = el('li'); blocks(li, item); ul.appendChild(item); } target.appendChild(ul); }
        else if (c.namespaceURI === TABLE_NS && c.localName === 'table') {
          const table = el('table');
          for (const tr of c.getElementsByTagNameNS(TABLE_NS, 'table-row')) { const row = el('tr'); for (const td of tr.children) { const cell = el('td'); blocks(td, cell); row.appendChild(cell); } table.appendChild(row); }
          target.appendChild(table);
        } else blocks(c, target);
      }
    };
    const body = doc.getElementsByTagNameNS(TEXT_NS, 'section')[0]?.parentElement ?? doc.getElementsByTagName('office:text')[0] ?? doc.documentElement;
    blocks(body, root);
    await Promise.all(tasks);
    sanitize(root, false);
    const rtl = markDirections(root);
    return { element: root, toc: tocFromHeadings(root, ctx, 'odt'), images: collectImages(root, ctx, 'odt'), rtl, dispose: () => pool.dispose() };
  },
};

/* ---------- CBZ ---------- */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export const cbzHandler: FlowHandler = {
  kind: 'flow',
  format: 'cbz',
  async readMeta(file, fileName) {
    try {
      const zip = await JSZip.loadAsync(file);
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.(jpe?g|png|gif|webp|avif)$/i.test(n)).sort(naturalCompare);
      const first = names[0] ? zipFile(zip, names[0]) : null;
      const cover = first ? new Blob([await first.async('blob')], { type: mimeFor(names[0]) }) : undefined;
      return { title: titleFromFileName(fileName), cover, pageCount: names.length };
    } catch { return { title: titleFromFileName(fileName) }; }
  },
  async render(file, ctx): Promise<FlowRender> {
    const zip = await JSZip.loadAsync(file);
    const pool = new UrlPool();
    const root = el('div', 'kr-content kr-pages');
    root.setAttribute('dir', 'ltr');
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.(jpe?g|png|gif|webp|avif)$/i.test(n)).sort(naturalCompare);
    const images: ImageRef[] = [];
    const toc: TocItem[] = [];
    for (let i = 0; i < names.length; i++) {
      const url = await pool.fromZip(zip, names[i]);
      if (!url) continue;
      const img = el('img');
      img.src = url; img.loading = 'lazy'; img.decoding = 'async'; img.id = ctx.id(`page${i + 1}`); img.alt = `${i + 1}`;
      root.appendChild(img);
      images.push({ src: url, anchor: img.id, bookId: ctx.bookId, bookTitle: ctx.bookTitle, alt: `${i + 1}` });
      if (i % 10 === 0) toc.push({ label: `${i + 1}`, depth: 0, anchor: img.id });
    }
    return { element: root, toc, images, rtl: false, dispose: () => pool.dispose() };
  },
};

/* ---------- single image ---------- */
export const imageHandler: FlowHandler = {
  kind: 'flow',
  format: 'image',
  async readMeta(file, fileName) { return { title: titleFromFileName(fileName), cover: file }; },
  async render(file, ctx): Promise<FlowRender> {
    const pool = new UrlPool();
    const url = pool.fromBlob('img', file);
    const root = el('div', 'kr-content kr-pages');
    const img = el('img'); img.src = url; img.id = ctx.id('img'); root.appendChild(img);
    return { element: root, toc: [], images: [{ src: url, anchor: img.id, bookId: ctx.bookId, bookTitle: ctx.bookTitle }], rtl: false, dispose: () => pool.dispose() };
  },
};
