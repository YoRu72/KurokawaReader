// KurokawaReader's own EPUB engine. Every spine item is parsed, sanitised and
// flowed into one continuous column, so several books can be read one after
// another in the same scroll, with the reader's own typography in charge.
import JSZip from 'jszip';
import type { BookMeta, FlowHandler, FlowRender, ImageRef, RenderContext, TocItem } from './types';
import { titleFromFileName } from './types';
import { UrlPool, afterFrame, breath, collectImages, markBlockDirections, mimeFor, parseXml, resolveZipPath, safeDecode, sanitize, tocFromHeadings, zipFile, zipText } from './shared';

interface ManifestItem { id: string; href: string; type: string; properties: string }

interface Package {
  zip: JSZip;
  opfPath: string;
  meta: BookMeta;
  manifest: Map<string, ManifestItem>;
  spine: ManifestItem[];
  rtlProgression: boolean;
  navItem?: ManifestItem;
  ncxItem?: ManifestItem;
}

// The unzipped package of the last few opened books, so coming back to a book
// (or re-rendering it after a settings change) skips the zip directory parse.
const pkgCache = new Map<string, { size: number; pkg: Promise<Package> }>();
function cachedPackage(file: Blob, bookId: string): Promise<Package> {
  const hit = pkgCache.get(bookId);
  if (hit && hit.size === file.size) return hit.pkg;
  const pkg = loadPackage(file);
  pkg.catch(() => pkgCache.delete(bookId));
  pkgCache.set(bookId, { size: file.size, pkg });
  while (pkgCache.size > 3) pkgCache.delete(pkgCache.keys().next().value!);
  return pkg;
}

/** What a book's page shows before the book is opened: its blurb and its contents (labels and depths). */
export async function epubOutline(file: Blob, bookId: string): Promise<{ description?: string; language?: string; toc: { label: string; depth: number }[] }> {
  const pkg = await cachedPackage(file, bookId);
  // (Only the entries the reader keeps — tocOf — so the n-th chapter here is the n-th the reader opens.)
  const raw = resolvableToc(await readToc(pkg), pkg);
  const desc = pkg.meta.description ? pkg.meta.description.replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim() : undefined;
  return { description: desc, language: pkg.meta.language, toc: raw.map((r) => ({ label: r.label, depth: r.depth })) };
}

/** Parse a book's package ahead of time (the library does this for the book most likely to be opened next). */
export function prewarmEpub(file: Blob, bookId: string): void { void cachedPackage(file, bookId).catch(() => {}); }

async function loadPackage(file: Blob): Promise<Package> {
  const zip = await JSZip.loadAsync(file);
  const container = zipFile(zip, 'META-INF/container.xml');
  let opfPath = '';
  if (container) {
    const doc = parseXml(await container.async('text'));
    opfPath = doc.querySelector('rootfile')?.getAttribute('full-path') ?? '';
  }
  if (!opfPath) {
    opfPath = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith('.opf')) ?? '';
    if (!opfPath) throw new Error('No OPF package found');
  }
  const opf = parseXml(await zipFile(zip, opfPath)!.async('text'));
  const dc = (name: string) => {
    const n = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', name)[0] ?? opf.getElementsByTagName(`dc:${name}`)[0];
    return n?.textContent?.trim() || undefined;
  };
  const manifest = new Map<string, ManifestItem>();
  opf.querySelectorAll('manifest > item').forEach((it) => {
    const id = it.getAttribute('id') ?? '';
    manifest.set(id, { id, href: resolveZipPath(opfPath, it.getAttribute('href') ?? ''), type: it.getAttribute('media-type') ?? '', properties: it.getAttribute('properties') ?? '' });
  });
  const spineEl = opf.querySelector('spine');
  const spine: ManifestItem[] = [];
  spineEl?.querySelectorAll('itemref').forEach((ref) => {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (item && ref.getAttribute('linear') !== 'no') spine.push(item);
  });
  // Non-linear items still deserve to be readable; append them at the end.
  spineEl?.querySelectorAll('itemref[linear="no"]').forEach((ref) => {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (item) spine.push(item);
  });

  // Cover: EPUB3 property, EPUB2 <meta name="cover">, or a guess by id/name.
  let coverItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes('cover-image'));
  if (!coverItem) {
    const coverId = opf.querySelector('meta[name="cover"]')?.getAttribute('content');
    if (coverId) coverItem = manifest.get(coverId);
  }
  if (!coverItem) coverItem = [...manifest.values()].find((m) => m.type.startsWith('image/') && /cover/i.test(m.id + ' ' + m.href));
  let cover: Blob | undefined;
  if (coverItem) {
    const f = zipFile(zip, coverItem.href);
    if (f) cover = new Blob([await f.async('blob')], { type: coverItem.type || mimeFor(coverItem.href) });
  }

  const navItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes('nav'));
  const ncxId = spineEl?.getAttribute('toc');
  const ncxItem = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');

  return {
    zip, opfPath, manifest, spine, navItem, ncxItem,
    rtlProgression: spineEl?.getAttribute('page-progression-direction') === 'rtl',
    meta: { title: dc('title') ?? '', author: dc('creator'), language: dc('language'), cover, description: dc('description') },
  };
}

/** TOC entries keyed by resolved zip path (+ fragment). */
interface RawToc { label: string; depth: number; path: string; frag: string }

async function readToc(pkg: Package): Promise<RawToc[]> {
  const out: RawToc[] = [];
  if (pkg.navItem) {
    const f = zipFile(pkg.zip, pkg.navItem.href);
    if (f) {
      const doc = new DOMParser().parseFromString(await f.async('text'), 'application/xhtml+xml');
      let nav = [...doc.querySelectorAll('nav')].find((n) => (n.getAttribute('epub:type') ?? n.getAttributeNS('http://www.idpf.org/2007/ops', 'type')) === 'toc') ?? doc.querySelector('nav');
      const walk = (ol: Element | null, depth: number) => {
        if (!ol) return;
        for (const li of ol.children) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          const a = li.querySelector(':scope > a, :scope > span');
          const href = a?.getAttribute('href') ?? '';
          const label = (a?.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (label) {
            const [p, frag = ''] = href.split('#');
            out.push({ label, depth, path: resolveZipPath(pkg.navItem!.href, p), frag: safeDecode(frag) });
          }
          walk(li.querySelector(':scope > ol'), depth + 1);
        }
      };
      walk(nav?.querySelector('ol') ?? null, 0);
      if (out.length) return out;
    }
  }
  if (pkg.ncxItem) {
    const f = zipFile(pkg.zip, pkg.ncxItem.href);
    if (f) {
      const doc = parseXml(await f.async('text'));
      const walk = (parent: Element, depth: number) => {
        for (const np of parent.children) {
          if (np.localName !== 'navPoint') continue;
          const label = np.querySelector('navLabel > text')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          const src = np.querySelector('content')?.getAttribute('src') ?? '';
          const [p, frag = ''] = src.split('#');
          if (label) out.push({ label, depth, path: resolveZipPath(pkg.ncxItem!.href, p), frag: safeDecode(frag) });
          walk(np, depth + 1);
        }
      };
      const navMap = doc.querySelector('navMap');
      if (navMap) walk(navMap, 0);
    }
  }
  return out;
}

/** The contents entries that lead into the book: those pointing at a chapter of its spine (every chapter gets an
 *  anchor, and an entry whose fragment is missing falls back to its chapter's start). The reader's contents and
 *  the book's page are both built from this list, so their indexes agree. */
function resolvableToc(raw: RawToc[], pkg: Package): RawToc[] {
  const inSpine = new Set(pkg.spine.map((s) => s.href));
  return raw.filter((r) => inSpine.has(r.path));
}

/** Rewrite a publisher stylesheet so it only applies inside one chapter. */
async function scopeCss(css: string, cssPath: string, scope: string, pkg: Package, pool: UrlPool): Promise<string> {
  // Resolve url(...) references (fonts, background images) to blob URLs.
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const tasks: Promise<void>[] = [];
  const replacements = new Map<string, string>();
  css.replace(urlRe, (_m, _q, ref: string) => {
    if (/^(data:|https?:|blob:)/i.test(ref)) return _m;
    const path = resolveZipPath(cssPath, ref);
    tasks.push(pool.fromZip(pkg.zip, path).then((u) => { if (u) replacements.set(ref, u); }));
    return _m;
  });
  await Promise.all(tasks);
  css = css.replace(urlRe, (m, _q, ref: string) => (replacements.has(ref) ? `url("${replacements.get(ref)}")` : m));

  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  const out: string[] = [];
  const scopeSelector = (sel: string) =>
    sel.split(',').map((s) => {
      s = s.trim();
      if (!s) return s;
      if (/^(html|body)\b/i.test(s)) return s.replace(/^(html|body)\b\s*/i, scope + ' ');
      return `${scope} ${s}`;
    }).join(', ');
  const emit = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        // Publisher page-level backgrounds fight the theme; drop them.
        r.style.removeProperty('background');
        r.style.removeProperty('background-color');
        out.push(`${scopeSelector(r.selectorText)}{${r.style.cssText}}`);
      } else if (r instanceof CSSMediaRule) {
        const inner: string[] = [];
        for (const rr of r.cssRules) if (rr instanceof CSSStyleRule) inner.push(`${scopeSelector(rr.selectorText)}{${rr.style.cssText}}`);
        out.push(`@media ${r.conditionText}{${inner.join('')}}`);
      } else if (r instanceof CSSFontFaceRule) {
        out.push(r.cssText);
      }
    }
  };
  emit(sheet.cssRules);
  return out.join('\n');
}

/** A chapter's section, empty: its id and path known before its text is read (the contents and links point at it). */
function chapterShell(item: ManifestItem, index: number, ctx: RenderContext, idMap: Map<string, string>): HTMLElement {
  const section = document.createElement('section');
  section.className = 'kr-chapter';
  section.id = ctx.id(`c${index}`);
  section.dataset.path = item.href;
  idMap.set(item.href, section.id);
  return section;
}

async function renderChapter(pkg: Package, item: ManifestItem, section: HTMLElement, ctx: RenderContext, pool: UrlPool, idMap: Map<string, string>): Promise<HTMLElement> {
  const f = zipFile(pkg.zip, item.href);
  if (!f) return section;
  const raw = await zipText(f);
  let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
  if (doc.querySelector('parsererror') || !doc.body) doc = new DOMParser().parseFromString(raw, 'text/html');

  // Prefix every id so chapters never collide, and remember them for links/TOC.
  doc.querySelectorAll('[id]').forEach((e) => {
    const old = e.id;
    const fresh = `${section.id}-${old}`;
    idMap.set(`${item.href}#${old}`, fresh);
    e.id = fresh;
  });

  // Images, SVG images, audio/video sources → blob URLs.
  const mediaTasks: Promise<void>[] = [];
  const fix = (e: Element, attr: string) => {
    const v = e.getAttribute(attr);
    if (!v || /^(data:|https?:|blob:)/i.test(v)) return;
    const path = resolveZipPath(item.href, v);
    mediaTasks.push(pool.fromZip(pkg.zip, path).then((u) => { if (u) e.setAttribute(attr, u); else e.removeAttribute(attr); }));
  };
  // Pictures are resolved as they scroll near; everything else up front.
  const lazyImg = (e: Element, attr: string) => {
    const v = e.getAttribute(attr);
    if (!v || /^(data:|https?:|blob:)/i.test(v)) return;
    const path = resolveZipPath(item.href, v);
    if (!zipFile(pkg.zip, path)) { e.removeAttribute(attr); return; }
    pool.lazy(pkg.zip, path, e, attr);
  };
  // Pictures in the forms books give them, made plain <img> so each is shown, found, tapped and saved alike:
  // the largest candidate of a srcset (an <img> with no src, or a <picture>'s <source>); an <object>/<embed> of an
  // image; and a page illustration wrapped in SVG (one <image> and nothing drawn beside it — the usual way
  // light novels place a full-page picture).
  const best = (set: string | null): string | null => {
    if (!set) return null; let pick: string | null = null, score = -1;
    for (const part of set.split(',')) { const [u, d] = part.trim().split(/\s+/); if (!u) continue; const n = d ? parseFloat(d) * (/w$/i.test(d) ? 1 : 1000) : 1; if (n > score) { score = n; pick = u; } }
    return pick;
  };
  doc.querySelectorAll('picture').forEach((pic) => {
    const img = pic.querySelector('img'); const src = img?.getAttribute('src') || best(pic.querySelector('source[srcset]')?.getAttribute('srcset') ?? null);
    if (!src) return; const out = img ?? doc.createElement('img'); out.setAttribute('src', src); out.removeAttribute('srcset'); pic.replaceWith(out);
  });
  doc.querySelectorAll('img[srcset]').forEach((img) => { if (!img.getAttribute('src')) { const u = best(img.getAttribute('srcset')); if (u) img.setAttribute('src', u); } img.removeAttribute('srcset'); });
  doc.querySelectorAll('object[data], embed[src]').forEach((o) => {
    const u = o.getAttribute('data') ?? o.getAttribute('src') ?? ''; const type = o.getAttribute('type') ?? '';
    if (!/^image\//i.test(type) && !/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(u)) return;
    const img = doc.createElement('img'); img.setAttribute('src', u); img.setAttribute('alt', (o.getAttribute('title') ?? o.textContent ?? '').trim()); o.replaceWith(img);
  });
  doc.querySelectorAll('svg').forEach((svg) => {
    const imgs = svg.querySelectorAll('image'); if (imgs.length !== 1) return;
    if (svg.querySelector('text, path, rect, circle, ellipse, line, polyline, polygon, use, foreignObject')) return;
    const im = imgs[0]; const u = im.getAttribute('xlink:href') ?? im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? im.getAttribute('href'); if (!u) return;
    const img = doc.createElement('img'); img.setAttribute('src', u); img.setAttribute('alt', svg.getAttribute('aria-label') ?? im.getAttribute('alt') ?? ''); img.className = 'kr-svgpage';
    const id = svg.getAttribute('id') ?? im.getAttribute('id'); if (id) img.id = id;
    svg.replaceWith(img);
  });
  doc.querySelectorAll('img').forEach((e) => lazyImg(e, 'src'));
  doc.querySelectorAll('image').forEach((e) => { fix(e, 'xlink:href'); fix(e, 'href'); });
  doc.querySelectorAll('source, video, audio').forEach((e) => fix(e, 'src'));
  await Promise.all(mediaTasks);

  // Publisher styles, when requested.
  let styleText = '';
  if (ctx.publisherStyles) {
    const parts: Promise<string>[] = [];
    doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((l) => {
      const path = resolveZipPath(item.href, l.getAttribute('href')!);
      const cf = zipFile(pkg.zip, path);
      if (cf) parts.push(zipText(cf).then((css) => scopeCss(css, path, `#${section.id}`, pkg, pool)));
    });
    doc.querySelectorAll('style').forEach((s) => parts.push(scopeCss(s.textContent ?? '', item.href, `#${section.id}`, pkg, pool)));
    styleText = (await Promise.all(parts)).join('\n');
  }

  const body = doc.body;
  // Internal links: keep them, resolve to our prefixed ids after all chapters render.
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')!;
    if (/^(https?:|mailto:|tel:)/i.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); return; }
    const [p, rawFrag] = href.split('#');
    const frag = rawFrag ? safeDecode(rawFrag) : rawFrag;
    const path = p ? resolveZipPath(item.href, p) : item.href;
    a.setAttribute('data-kr-link', frag ? `${path}#${frag}` : path);
    a.removeAttribute('href');
  });

  sanitize(body, ctx.publisherStyles);
  // Strip empty wrapper structure that EPUB producers love — but not an empty element that is a link's or the
  // contents' target (<span id="…"/>, common in converted books), nor one holding such a target.
  body.querySelectorAll('div, span').forEach((e) => { if (!e.id && !e.textContent?.trim() && !(e.localName === 'span' && e.textContent) && !e.querySelector('img, svg, image, video, audio, hr, [id]')) e.remove(); });
  // (A span holding only a space — or a no-break or thin space — is the space between two words: books made from
  // InDesign put the space between two differently styled runs in a span of its own. Removed, the words were glued:
  // «My name’sRudeus». A div is a block: its blank text separates nothing, so an empty-looking div still goes.)
  // Mark inline images so they don't get block layout.
  body.querySelectorAll('p img, span img, a img').forEach((img) => { if (img.parentElement && (img.parentElement.textContent ?? '').trim()) img.classList.add('inline'); });

  if (styleText) {
    const st = document.createElement('style');
    st.textContent = styleText;
    section.appendChild(st);
  }
  while (body.firstChild) section.appendChild(body.firstChild);
  if (doc.body?.getAttribute('lang') || doc.documentElement.getAttribute('lang')) section.setAttribute('lang', (doc.body.getAttribute('lang') || doc.documentElement.getAttribute('lang'))!);
  return section;
}

export const epubHandler: FlowHandler = {
  kind: 'flow',
  format: 'epub',

  async readMeta(file, fileName) {
    const pkg = await loadPackage(file);
    return { ...pkg.meta, title: pkg.meta.title || titleFromFileName(fileName) };
  },

  async render(file, ctx): Promise<FlowRender> {
    const pkg = await cachedPackage(file, ctx.bookId);
    const pool = new UrlPool();
    const idMap = new Map<string, string>();
    const root = document.createElement('div');
    root.className = 'kr-content kr-epub';
    if (pkg.meta.language) root.setAttribute('lang', pkg.meta.language.split('-')[0]);
    const n = pkg.spine.length;
    // Every chapter's section first, empty: its id is known to the contents and to links before its text is read.
    const sections = pkg.spine.map((item, i) => chapterShell(item, i, ctx, idMap));
    // Each chapter's blocks weighed for the book's direction as it is made (markBlockDirections): the whole book's
    // share once the last is made, as markDirections took it over the whole.
    const dirs: [number, number][] = new Array(n);
    let gone = false;
    const make = async (i: number) => {
      await renderChapter(pkg, pkg.spine[i], sections[i], ctx, pool, idMap);
      dirs[i] = markBlockDirections(sections[i]);
      sections[i].classList.remove('kr-shell');
    };
    // Chapters made in slices of a few milliseconds with a breath between: the spinner turns, a tap answers. Those made
    // while the book is already shown (rest) take a slice a frame, after it is drawn: the reader scrolls on smoothly.
    const makeAll = async (list: number[], paced = false): Promise<void> => {
      let since = performance.now();
      for (const i of list) {
        if (gone) return;
        await make(i);
        if (performance.now() - since > (paced ? 8 : 12)) { await (paced ? afterFrame() : breath()); since = performance.now(); }
      }
    };
    const out: FlowRender = { element: root, toc: [], images: [], rtl: false, dispose: () => { gone = true; pool.dispose(); }, resolveImages: () => pool.resolveAll(root) };
    const rtlOf = (blocksRtl: number, blocks: number) => (blocks > 0 && blocksRtl / blocks > 0.5) || pkg.rtlProgression || /^(ar|he|fa|ur)/i.test(pkg.meta.language ?? '');
    // The whole book's parts once every chapter is made: links resolved (every id known), the contents, the direction,
    // the pictures numbered in their order — as they were when the book was made in one go.
    const finish = async (): Promise<void> => {
      root.querySelectorAll<HTMLElement>('[data-kr-link]').forEach((a) => {
        const key = a.dataset.krLink!;
        const target = idMap.get(key) ?? idMap.get(key.split('#')[0]);
        if (target) { a.setAttribute('href', `#${target}`); a.setAttribute('data-kr-anchor', target); }
        a.removeAttribute('data-kr-link');
      });
      const raw = resolvableToc(await readToc(pkg), pkg);
      let toc: TocItem[] = raw
        .map((r) => ({ label: r.label, depth: r.depth, anchor: idMap.get(r.frag ? `${r.path}#${r.frag}` : r.path) ?? idMap.get(r.path) ?? '' }))
        .filter((t) => t.anchor);
      if (!toc.length) toc = tocFromHeadings(root, ctx, 'epub', 2);
      let r = 0, b = 0; for (const d of dirs) if (d) { r += d[0]; b += d[1]; }
      const byText = b > 0 && r / b > 0.5;
      const rtl = rtlOf(r, b);
      root.setAttribute('dir', rtl || byText ? 'rtl' : 'ltr');
      out.toc = toc; out.rtl = rtl;
      out.images = collectImages(root, ctx, 'epub', pool, pkg.zip);
    };
    const first = ctx.first;
    if (first === undefined || n <= 6) {
      await makeAll(sections.map((_, i) => i));
      sections.forEach((s) => root.appendChild(s));
      await finish();
      return out;
    }
    // Asked for one chapter first (the one the reader is at): it and its neighbours are made now, the others stay empty
    // sections (class kr-shell) until rest() — the book shows at once, not after every chapter has been read.
    const k = Math.max(0, Math.min(n - 1, first));
    const now = [k - 1, k, k + 1].filter((i) => i >= 0 && i < n);
    sections.forEach((s, i) => { if (!now.includes(i)) s.classList.add('kr-shell'); root.appendChild(s); });
    await makeAll(now);
    { let r = 0, b = 0; for (const i of now) { r += dirs[i][0]; b += dirs[i][1]; }
      // (The direction the book was found to have last time, else that of the chapters made: the rest may change it.)
      const rtl = ctx.rtl ?? rtlOf(r, b); out.rtl = rtl; root.setAttribute('dir', rtl ? 'rtl' : 'ltr'); }
    out.rest = async () => {
      // (Outward from the chapter read, the ones ahead first: what a scroll reaches next is made next.)
      const order: number[] = []; for (let d = 2; d < n; d++) for (const i of [k + d, k - d]) if (i >= 0 && i < n) order.push(i);
      await makeAll(order, true);
      if (gone) return false;
      await finish();
      return !gone;
    };
    return out;
  },
};
