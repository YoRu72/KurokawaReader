// Kindle books: MOBI, AZW, AZW3 (KF8) and PRC, read with foliate-js's parser.
// DRM-protected files cannot be opened (the text is encrypted).
import type { FlowHandler, FlowRender, TocItem } from './types';
import { titleFromFileName } from './types';
import { collectImages, markDirections, sanitize, tocFromHeadings } from './shared';
import { MOBI, type MobiBook } from '../vendor/mobi';

async function unzlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const out = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function open(file: Blob): Promise<MobiBook> {
  // Encryption flag in the PalmDOC header (record 0, offset 12): 1 = old PID DRM, 2 = Mobipocket DRM.
  const head = new DataView(await file.slice(0, 96).arrayBuffer());
  const rec0 = head.getUint32(78);
  const enc = new DataView(await file.slice(rec0, rec0 + 16).arrayBuffer()).getUint16(12);
  if (enc === 1 || enc === 2) throw new Error(DRM_MSG);
  try { return await new MOBI({ unzlib }).open(file); }
  catch (e) { throw new Error(/DataView|bounds/i.test(String((e as Error).message)) ? DRM_MSG : String((e as Error).message ?? e)); }
}
const DRM_MSG = 'This Kindle book is DRM-protected, so its text cannot be read outside Amazon\'s apps.';
function langOf(v: unknown): string | undefined { const s = Array.isArray(v) ? v[0] : v; return typeof s === 'string' && s ? s : undefined; }

export const mobiHandler: FlowHandler = {
  kind: 'flow',
  format: 'mobi',
  async readMeta(file, fileName) {
    const book = await open(file);
    const m = book.metadata ?? {};
    let cover: Blob | undefined;
    try { cover = await book.getCover(); } catch { /* none */ }
    if (cover && !cover.type) cover = new Blob([cover], { type: 'image/jpeg' });
    return { title: String(m.title || titleFromFileName(fileName)).trim(), author: (Array.isArray(m.author) ? m.author : m.author ? [m.author] : []).filter(Boolean).join(', ') || undefined, language: langOf(m.language), cover };
  },
  async render(file, ctx): Promise<FlowRender> {
    const book = await open(file);
    const root = document.createElement('div');
    root.className = 'kr-content kr-mobi';
    const lang = langOf(book.metadata?.language);
    if (lang) root.setAttribute('lang', lang.split('-')[0]);
    const docs: (Document | null)[] = [];
    const urls: string[] = [];
    for (let i = 0; i < book.sections.length; i++) {
      const sec = book.sections[i];
      if (!sec.load) { docs.push(null); continue; }
      const url = await sec.load();
      urls.push(url);
      const text = await (await fetch(url)).text();
      let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
      if (doc.querySelector('parsererror') || !doc.body) doc = new DOMParser().parseFromString(text, 'text/html');
      docs.push(doc);
    }
    // TOC: resolve each entry against the section documents before they are moved into the page.
    const toc: TocItem[] = [];
    let n = 0;
    const walk = async (items: MobiBook['toc'], depth: number) => {
      for (const it of items ?? []) {
        try {
          const r = await book.resolveHref(it.href);
          const doc = r ? docs[r.index] : null;
          const el = doc && r ? (r.anchor(doc) ?? doc.body?.firstElementChild) : null;
          if (el) { const id = ctx.id(`toc${n++}`); (el as HTMLElement).id = id; toc.push({ label: it.label.trim(), anchor: id, depth }); }
        } catch { /* unresolvable entry */ }
        await walk(it.subitems, depth + 1);
      }
    };
    await walk(book.toc, 0);
    // Pages → chapters.
    docs.forEach((doc, i) => {
      if (!doc?.body) return;
      const section = document.createElement('section');
      section.className = 'kr-chapter';
      section.id = ctx.id(`c${i}`);
      const body = doc.body;
      // Inline styles from the book (KF8 ships CSS) only when publisher styles are on.
      if (ctx.publisherStyles) for (const st of Array.from(doc.querySelectorAll('style'))) { const s = document.createElement('style'); s.textContent = scope(st.textContent ?? '', `#${section.id}`); section.appendChild(s); }
      body.querySelectorAll('a[href]').forEach((a) => { const href = a.getAttribute('href') ?? ''; if (/^https?:/i.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); } else a.removeAttribute('href'); });
      sanitize(body, ctx.publisherStyles);
      while (body.firstChild) section.appendChild(body.firstChild);
      if ((section.textContent ?? '').trim() || section.querySelector('img')) root.appendChild(section);
    });
    if (!root.childElementCount) throw new Error('This Kindle book has no readable text — it may be DRM-protected.');
    const rtl = markDirections(root) || book.dir === 'rtl';
    if (rtl) root.setAttribute('dir', 'rtl');
    return {
      element: root,
      toc: toc.length ? toc : tocFromHeadings(root, ctx, 'mobi', 2),
      images: collectImages(root, ctx, 'mobi'),
      rtl,
      dispose: () => { urls.forEach((u) => URL.revokeObjectURL(u)); book.destroy?.(); },
    };
  },
};

function scope(css: string, sel: string): string {
  return css.replace(/(^|\})\s*([^{}@]+)\{/g, (_m, brace: string, selectors: string) => `${brace} ${selectors.split(',').map((s) => `${sel} ${s.trim().replace(/^(html|body)\b/, '')}`).join(', ')}{`);
}
