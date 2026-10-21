// KurokawaReader's own EPUB engine. Every spine item is parsed, sanitised and
// flowed into one continuous column, so several books can be read one after
// another in the same scroll, with the reader's own typography in charge.
import JSZip from 'jszip';
import type { BookMeta, FlowHandler, FlowRender, ImageRef, RenderContext, TocItem } from './types';
import { titleFromFileName } from './types';
import { UrlPool, collectImages, markDirections, mimeFor, parseXml, resolveZipPath, sanitize, tocFromHeadings, zipFile } from './shared';

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
    meta: { title: dc('title') ?? '', author: dc('creator'), language: dc('language'), cover },
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
            out.push({ label, depth, path: resolveZipPath(pkg.navItem!.href, p), frag });
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
          if (label) out.push({ label, depth, path: resolveZipPath(pkg.ncxItem!.href, p), frag });
          walk(np, depth + 1);
        }
      };
      const navMap = doc.querySelector('navMap');
      if (navMap) walk(navMap, 0);
    }
  }
  return out;
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

async function renderChapter(pkg: Package, item: ManifestItem, index: number, ctx: RenderContext, pool: UrlPool, idMap: Map<string, string>): Promise<HTMLElement> {
  const section = document.createElement('section');
  section.className = 'kr-chapter';
  section.id = ctx.id(`c${index}`);
  section.dataset.path = item.href;
  idMap.set(item.href, section.id);

  const f = zipFile(pkg.zip, item.href);
  if (!f) return section;
  const raw = await f.async('text');
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
      if (cf) parts.push(cf.async('text').then((css) => scopeCss(css, path, `#${section.id}`, pkg, pool)));
    });
    doc.querySelectorAll('style').forEach((s) => parts.push(scopeCss(s.textContent ?? '', item.href, `#${section.id}`, pkg, pool)));
    styleText = (await Promise.all(parts)).join('\n');
  }

  const body = doc.body;
  // Internal links: keep them, resolve to our prefixed ids after all chapters render.
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')!;
    if (/^(https?:|mailto:|tel:)/i.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); return; }
    const [p, frag] = href.split('#');
    const path = p ? resolveZipPath(item.href, p) : item.href;
    a.setAttribute('data-kr-link', frag ? `${path}#${frag}` : path);
    a.removeAttribute('href');
  });

  sanitize(body, ctx.publisherStyles);
  // Strip empty wrapper structure that EPUB producers love.
  body.querySelectorAll('div, span').forEach((e) => { if (!e.textContent?.trim() && !e.querySelector('img, svg, image, video, audio, hr')) e.remove(); });
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

    // Render chapters a few at a time to keep the UI responsive.
    const sections: HTMLElement[] = new Array(pkg.spine.length);
    const CONCURRENCY = 4;
    let next = 0;
    const worker = async () => {
      while (next < pkg.spine.length) {
        const i = next++;
        sections[i] = await renderChapter(pkg, pkg.spine[i], i, ctx, pool, idMap);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pkg.spine.length) }, worker));
    sections.forEach((s) => root.appendChild(s));

    // Resolve internal links now that every id is known.
    root.querySelectorAll<HTMLElement>('[data-kr-link]').forEach((a) => {
      const key = a.dataset.krLink!;
      const target = idMap.get(key) ?? idMap.get(key.split('#')[0]);
      if (target) { a.setAttribute('href', `#${target}`); a.setAttribute('data-kr-anchor', target); }
      a.removeAttribute('data-kr-link');
    });

    // TOC
    const raw = await readToc(pkg);
    let toc: TocItem[] = raw
      .map((r) => ({ label: r.label, depth: r.depth, anchor: idMap.get(r.frag ? `${r.path}#${r.frag}` : r.path) ?? idMap.get(r.path) ?? '' }))
      .filter((t) => t.anchor);
    if (!toc.length) toc = tocFromHeadings(root, ctx, 'epub', 2);

    const rtl = markDirections(root) || pkg.rtlProgression || /^(ar|he|fa|ur)/i.test(pkg.meta.language ?? '');
    if (rtl) root.setAttribute('dir', 'rtl');
    const images: ImageRef[] = collectImages(root, ctx, 'epub', pool, pkg.zip);
    return { element: root, toc, images, rtl, dispose: () => pool.dispose() };
  },
};
