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

export async function docxToHtml(file: Blob, ctx: RenderContext, pool: UrlPool): Promise<{ root: HTMLElement; meta: { title?: string; author?: string } }> {
  const zip = await JSZip.loadAsync(file);
  const docPath = 'word/document.xml';
  const docFile = zipFile(zip, docPath);
  if (!docFile) throw new Error('document.xml missing');
  const doc = parseXml(await docFile.async('text'));
  const rels = await readRels(zip, docPath);

  // Styles: map style ids to heading levels / names.
  const styleMap = new Map<string, { name: string; outline?: number; bold?: boolean }>();
  const stylesFile = zipFile(zip, 'word/styles.xml');
  if (stylesFile) {
    const sd = parseXml(await stylesFile.async('text'));
    sd.querySelectorAll('style').forEach((s) => {
      const id = attr(s, W, 'styleId') ?? '';
      const name = attr(child(s, W, 'name'), W, 'val') ?? id;
      const outline = attr(child(child(s, W, 'pPr'), W, 'outlineLvl'), W, 'val');
      styleMap.set(id, { name, outline: outline != null ? Number(outline) : undefined, bold: !!child(child(s, W, 'rPr'), W, 'b') });
    });
  }

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
        case 'br': dest.appendChild(document.createElement('br')); break;
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
            imageTasks.push(pool.fromZip(zip, path).then((u) => { if (u) img.src = u; else img.remove(); }));
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
            imageTasks.push(pool.fromZip(zip, path).then((u) => { if (u) img.src = u; else img.remove(); }));
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

  let currentList: HTMLElement | null = null;
  let currentListLevel = -1;

  const renderParagraph = (p: Element, target: HTMLElement) => {
    const pPr = child(p, W, 'pPr');
    const numPr = child(pPr, W, 'numPr');
    const styleName = styleMap.get(attr(child(pPr, W, 'pStyle'), W, 'val') ?? '')?.name ?? '';
    const isList = !!numPr || /\blist\b/i.test(styleName);
    const level = headingLevel(p);
    let elNode: HTMLElement;
    if (isList && target === root) {
      const ilvl = Number(attr(child(numPr, W, 'ilvl'), W, 'val') ?? 0);
      if (!currentList || ilvl !== currentListLevel) {
        currentList = el('ul'); currentListLevel = ilvl;
        root.appendChild(currentList);
      }
      elNode = el('li');
      currentList.appendChild(elNode);
    } else {
      currentList = null; currentListLevel = -1;
      elNode = el(level ? (`h${level}` as 'h1') : 'p');
      const jc = attr(child(pPr, W, 'jc'), W, 'val');
      if (jc === 'center') elNode.style.textAlign = 'center';
      if (attr(child(pPr, W, 'bidi'), W, 'val') !== '0' && child(pPr, W, 'bidi')) elNode.setAttribute('dir', 'rtl');
      target.appendChild(elNode);
    }
    renderInline(p, elNode);
    if (!elNode.textContent?.trim() && !elNode.querySelector('img')) elNode.remove();
  };

  const renderTable = (tbl: Element, target: HTMLElement) => {
    const table = el('table');
    for (const tr of tbl.children) {
      if (tr.localName !== 'tr') continue;
      const row = el('tr');
      for (const tc of tr.children) {
        if (tc.localName !== 'tc') continue;
        const cell = el('td');
        const span = attr(child(child(tc, W, 'tcPr'), W, 'gridSpan'), W, 'val');
        if (span) cell.colSpan = Number(span);
        renderBlocks(tc, cell);
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    target.appendChild(table);
  };

  const renderBlocks = (parent: Element, target: HTMLElement) => {
    for (const c of parent.children) {
      if (c.localName === 'p') renderParagraph(c, target);
      else if (c.localName === 'tbl') { currentList = null; renderTable(c, target); }
      else if (c.localName === 'sdt') renderBlocks(child(c, W, 'sdtContent') ?? c, target);
      else if (c.localName === 'sectPr') continue;
    }
  };

  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  if (body) renderBlocks(body, root);
  if (fnOut.length) {
    const hr = el('hr'); root.appendChild(hr);
    const ol = el('ol', 'kr-footnotes'); fnOut.forEach((li) => ol.appendChild(li)); root.appendChild(ol);
  }
  await Promise.all(imageTasks);
  return { root, meta };
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
    const { root } = await docxToHtml(file, ctx, pool);
    const rtl = markDirections(root);
    return { element: root, toc: tocFromHeadings(root, ctx, 'docx'), images: collectImages(root, ctx, 'docx'), rtl, dispose: () => pool.dispose() };
  },
};
