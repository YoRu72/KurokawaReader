// PPTX → a stack of slide cards: titles, text paragraphs (with bullets),
// pictures and speaker notes, in slide order.
import JSZip from 'jszip';
import type { FlowHandler, FlowRender, TocItem } from './types';
import { titleFromFileName } from './types';
import { UrlPool, collectImages, el, markDirections, parseXml, resolveZipPath, zipFile } from './shared';
import { t } from '../i18n';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

async function rels(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const name = partPath.split('/').pop();
  const out = new Map<string, string>();
  const f = zipFile(zip, `${dir}/_rels/${name}.rels`);
  if (!f) return out;
  parseXml(await f.async('text')).querySelectorAll('Relationship').forEach((r) => {
    out.set(r.getAttribute('Id') ?? '', resolveZipPath(partPath, r.getAttribute('Target') ?? ''));
  });
  return out;
}

async function slidePaths(zip: JSZip): Promise<string[]> {
  const presPath = 'ppt/presentation.xml';
  const pres = zipFile(zip, presPath);
  if (!pres) return Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/g)?.pop()) - Number(b.match(/\d+/g)?.pop()));
  const doc = parseXml(await pres.async('text'));
  const r = await rels(zip, presPath);
  const ids = [...doc.getElementsByTagNameNS(P, 'sldId')].map((s) => s.getAttributeNS(R, 'id') ?? '');
  return ids.map((id) => r.get(id)).filter((p): p is string => !!p);
}

function paragraphsOf(shape: Element, target: HTMLElement, asTitle: boolean): void {
  const txBody = shape.getElementsByTagNameNS(P, 'txBody')[0] ?? shape.getElementsByTagNameNS(A, 'txBody')[0];
  if (!txBody) return;
  let list: HTMLElement | null = null;
  for (const p of txBody.children) {
    if (p.localName !== 'p') continue;
    const text: HTMLElement = asTitle ? el('h2') : el('p');
    let hasText = false;
    for (const run of p.children) {
      if (run.localName === 'r' || run.localName === 'fld') {
        const tEl = run.getElementsByTagNameNS(A, 't')[0];
        const s = tEl?.textContent ?? '';
        if (!s) continue;
        hasText = true;
        const rPr = run.getElementsByTagNameNS(A, 'rPr')[0];
        let node: Node = document.createTextNode(s);
        if (rPr?.getAttribute('b') === '1') { const b = el('strong'); b.appendChild(node); node = b; }
        if (rPr?.getAttribute('i') === '1') { const i = el('em'); i.appendChild(node); node = i; }
        text.appendChild(node);
      } else if (run.localName === 'br') text.appendChild(el('br'));
    }
    if (!hasText) continue;
    const pPr = p.getElementsByTagNameNS(A, 'pPr')[0];
    const bulleted = !asTitle && pPr && !pPr.getElementsByTagNameNS(A, 'buNone').length && (Number(pPr.getAttribute('lvl') ?? 0) > 0 || pPr.getElementsByTagNameNS(A, 'buChar').length || pPr.getElementsByTagNameNS(A, 'buAutoNum').length);
    if (bulleted) {
      if (!list) { list = el('ul'); target.appendChild(list); }
      const li = el('li');
      while (text.firstChild) li.appendChild(text.firstChild);
      list.appendChild(li);
    } else {
      list = null;
      target.appendChild(text);
    }
  }
}

export const pptxHandler: FlowHandler = {
  kind: 'flow',
  format: 'pptx',
  async readMeta(file, fileName) {
    try {
      const zip = await JSZip.loadAsync(file);
      const core = zipFile(zip, 'docProps/core.xml');
      const paths = await slidePaths(zip);
      let title = '', author: string | undefined;
      if (core) {
        const cd = parseXml(await core.async('text'));
        title = cd.getElementsByTagName('dc:title')[0]?.textContent?.trim() ?? '';
        author = cd.getElementsByTagName('dc:creator')[0]?.textContent?.trim() || undefined;
      }
      // No stored title: use the first slide's title, as people would.
      if (!title && paths[0]) {
        const f = zipFile(zip, paths[0]);
        if (f) {
          const doc = parseXml(await f.async('text'));
          for (const sp of doc.getElementsByTagNameNS(P, 'sp')) {
            const type = sp.getElementsByTagNameNS(P, 'ph')[0]?.getAttribute('type');
            if (type === 'title' || type === 'ctrTitle') { title = [...sp.getElementsByTagNameNS(A, 't')].map((x) => x.textContent).join('').trim(); break; }
          }
        }
      }
      return { title: title || titleFromFileName(fileName), author, pageCount: paths.length };
    } catch {
      return { title: titleFromFileName(fileName) };
    }
  },
  async render(file, ctx): Promise<FlowRender> {
    const zip = await JSZip.loadAsync(file);
    const pool = new UrlPool();
    const root = el('div', 'kr-content kr-pptx');
    const toc: TocItem[] = [];
    const paths = await slidePaths(zip);
    const imageTasks: Promise<void>[] = [];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const f = zipFile(zip, path);
      if (!f) continue;
      const doc = parseXml(await f.async('text'));
      const r = await rels(zip, path);
      const card = el('section', 'kr-slide');
      card.id = ctx.id(`slide${i + 1}`);
      card.appendChild(el('div', 'kr-slide-n', `${t('slide')} ${i + 1}`));
      let title = '';
      const spTree = doc.getElementsByTagNameNS(P, 'spTree')[0];
      if (spTree) {
        for (const node of spTree.children) {
          if (node.localName === 'sp') {
            const ph = node.getElementsByTagNameNS(P, 'ph')[0];
            const type = ph?.getAttribute('type') ?? '';
            const isTitle = type === 'title' || type === 'ctrTitle';
            const before = card.childElementCount;
            paragraphsOf(node, card, isTitle);
            if (isTitle && !title && card.childElementCount > before) title = card.children[before].textContent ?? '';
          } else if (node.localName === 'pic' || node.localName === 'graphicFrame' || node.localName === 'grpSp') {
            for (const blip of node.getElementsByTagNameNS(A, 'blip')) {
              const rid = blip.getAttributeNS(R, 'embed');
              const target = rid ? r.get(rid) : undefined;
              if (!target) continue;
              const img = el('img');
              card.appendChild(img);
              imageTasks.push(pool.fromZip(zip, target).then((u) => { if (u) img.src = u; else img.remove(); }));
            }
            if (node.localName === 'grpSp') for (const sp of node.getElementsByTagNameNS(P, 'sp')) paragraphsOf(sp, card, false);
            // Tables inside graphic frames
            for (const tbl of node.getElementsByTagNameNS(A, 'tbl')) {
              const table = el('table');
              for (const tr of tbl.getElementsByTagNameNS(A, 'tr')) {
                const row = el('tr');
                for (const tc of tr.getElementsByTagNameNS(A, 'tc')) {
                  const cell = el('td');
                  cell.textContent = [...tc.getElementsByTagNameNS(A, 't')].map((x) => x.textContent).join('');
                  row.appendChild(cell);
                }
                table.appendChild(row);
              }
              card.appendChild(table);
            }
          }
        }
      }
      // Speaker notes
      const notesPath = [...r.values()].find((p) => /notesSlides\/notesSlide\d+\.xml$/.test(p));
      if (notesPath) {
        const nf = zipFile(zip, notesPath);
        if (nf) {
          const nd = parseXml(await nf.async('text'));
          const notes = el('div', 'kr-notes');
          for (const sp of nd.getElementsByTagNameNS(P, 'sp')) {
            const ph = sp.getElementsByTagNameNS(P, 'ph')[0];
            if (ph?.getAttribute('type') === 'sldNum') continue;
            paragraphsOf(sp, notes, false);
          }
          if (notes.textContent?.trim()) card.appendChild(notes);
        }
      }
      root.appendChild(card);
      toc.push({ label: title.trim() || `${t('slide')} ${i + 1}`, depth: 0, anchor: card.id });
    }
    await Promise.all(imageTasks);
    const rtl = markDirections(root);
    return { element: root, toc, images: collectImages(root, ctx, 'pptx'), rtl, dispose: () => pool.dispose() };
  },
};
