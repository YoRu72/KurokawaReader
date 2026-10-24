// PDF tools: pictures into a PDF, PDFs merged, pages organised (deleted, extracted, reordered, turned),
// protection removed, pages saved as pictures. Every tool makes a new file; the ones it starts from are
// left as they are. The work itself is in ../pdftools.ts (pdf-lib) and ../pdfcrypt.ts.
import { runJob } from '../jobs';
import { h, icon, openSheet, toast, pickButton } from './dom';
import { t, formatBytes, localDigits } from '../i18n';
import { db, type Book } from '../db';
import { importFiles } from '../library';
import { shareFile, downloadBlob } from './share';
import type { Source, PageSize } from '../pdftools';

type Tool = 'docs' | 'images' | 'scan' | 'merge' | 'extract' | 'organize' | 'unlock' | 'toImages';
const TOOLS: [Tool, string, string, string][] = [
  ['docs', 'toolDocsToPdf', 'note', 'toolDocsToPdfSub'],
  ['scan', 'toolScan', 'camera', 'toolScanSub'],
  ['images', 'toolImagesToPdf', 'images', 'toolImagesToPdfSub'],
  ['extract', 'toolExtract', 'file', 'toolExtractSub'],
  ['merge', 'toolMerge', 'books', 'toolMergeSub'],
  ['organize', 'toolOrganize', 'grid', 'toolOrganizeSub'],
  ['unlock', 'toolUnlock', 'target', 'toolUnlockSub'],
  ['toImages', 'toolToImages', 'download', 'toolToImagesSub'],
];

const tools = () => import('../pdftools');
export const baseName = (name: string) => name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 60) || 'document';

/** The tools sheet. `book`: a PDF of the library the tools start from (its context menu). */
export function pdfToolsSheet(books: Book[], book?: Book, onDone?: () => void): void {
  const sh = openSheet(t('pdfTools'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const grid = h('div', { class: 'convert-targets' });
  for (const [id, label, ic, sub] of TOOLS) {
    if (book && (id === 'images' || id === 'docs' || id === 'scan')) continue;
    grid.append(h('button', { class: 'convert-target', type: 'button', onclick: () => open(id) }, icon(ic), h('b', null, t(label as 'pdfTools')), h('small', null, t(sub as 'pdfTools'))));
  }
  sh.body.append(h('p', { class: 'src' }, t('pdfToolsBody')), grid, h('p', { class: 'hint' }, t('pdfToolsHint')));
  const open = (id: Tool) => {
    const pdfs = books.filter((b) => b.format === 'pdf');
    if (id === 'images') imagesSheet(onDone);
    else if (id === 'docs') docsSheet(books, onDone);
    else if (id === 'scan') void import('./scanner').then((m) => m.scannerSheet(onDone));
    else if (id === 'merge') mergeSheet(pdfs, book, onDone);
    else void chooseSource(pdfs, book, (src) => (id === 'organize' || id === 'extract' ? organizeSheet(src, onDone, id === 'extract') : id === 'unlock' ? unlockSheet(src, onDone) : toImagesSheet(src)));
  };
}

/** "Save pages as PDF" straight from a PDF being read. */
export async function extractFromBook(book: Book): Promise<void> {
  const s = await bookSource(book); if (s) await organizeSheet(s, undefined, true);
}

/* ---------- shared pieces ---------- */

/** A library PDF's bytes as a source. */
async function bookSource(b: Book): Promise<Source | null> {
  const f = await db.getFile(b.id);
  return f ? { name: b.title, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
}

/** Files picked from the device. */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((res) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', () => { res([...(input.files ?? [])]); input.remove(); });
    document.body.append(input); input.click();
  });
}

/** Ask for a PDF: one of the library's, or a file from the device. */
async function chooseSource(pdfs: Book[], preset: Book | undefined, then: (s: Source) => void): Promise<void> {
  if (preset) { const s = await bookSource(preset); if (s) then(s); return; }
  const sh = openSheet(t('choosePdf'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const list = h('div', { class: 'dest-list' });
  for (const b of pdfs) list.append(h('button', { type: 'button', class: 'dest-row', onclick: async () => { sh.close(); const s = await bookSource(b); if (s) then(s); } }, icon('file'), h('span', { class: 'name', dir: 'auto' }, b.title)));
  if (!pdfs.length) list.append(h('p', { class: 'hint' }, t('noPdfs')));
  sh.body.append(list);
  sh.actions.append(h('button', { class: 'btn small tonal', type: 'button', onclick: async () => { const [f] = await pickFiles('application/pdf,.pdf', false); if (!f) return; sh.close(); then({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); } }, icon('folder'), t('fromDevice')));
}

/** Run `fn` on a source, asking for its password when it needs one (and again when it was wrong). */
async function withPassword<T>(src: Source, fn: (s: Source) => Promise<T>): Promise<T | null> {
  const { fingerprint, knownPassword, rememberPassword } = await import('../pdfkeys');
  const fp = fingerprint(src.bytes);
  src.password ??= await knownPassword(fp);
  for (let wrong = false; ;) {
    try { const out = await fn(src); void rememberPassword(fp, src.password); return out; } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (msg !== 'password') throw err;
      const pw = window.prompt(wrong || src.password ? t('pdfPasswordWrong') : t('pdfPasswordPrompt'));
      if (!pw) { toast(t('cancelled')); return null; }
      src.password = pw; wrong = true;
    }
  }
}

/** Progress line, bar and the finished file's actions, in a sheet. */
export function runner(body: HTMLElement, onDone?: () => void) {
  const status = h('p', { class: 'src', hidden: true });
  const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
  const result = h('div', { class: 'convert-result', hidden: true });
  body.append(status, track, result);
  let report: ((pct: number) => void) | null = null;
  return {
    progress(pct: number) { track.hidden = false; bar.style.width = `${Math.round(pct)}%`; report?.(pct); },
    async run(buttons: HTMLButtonElement[], work: () => Promise<{ blob: Blob; name: string } | null>) {
      buttons.forEach((b) => { b.disabled = true; });
      status.hidden = false; status.textContent = t('working'); track.hidden = false; bar.style.width = '0%'; result.hidden = true;
      try {
        // A job: it goes on (with a notification) when this sheet is closed or the app is left.
        const title = body.closest('.sheet')?.querySelector('.sheet-head h3')?.textContent ?? t('convertFile');
        const out = await runJob(title, (r) => { report = r; return work(); }, () => body.isConnected).finally(() => { report = null; });
        if (!out) { status.textContent = t('cancelled'); return; }
        const { blob, name } = out;
        bar.style.width = '100%';
        status.textContent = t('convertDone', { name, size: formatBytes(blob.size) });
        const isPdf = /\.pdf$/i.test(name);
        result.replaceChildren(
          h('button', { class: 'btn small primary', type: 'button', onclick: () => void shareFile(blob, name, name) }, icon('external'), t('shareFile')),
          h('button', { class: 'btn small', type: 'button', onclick: () => downloadBlob(blob, name) }, icon('download'), t('saveFile')),
          ...(isPdf ? [h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; await importFiles([new File([blob], name, { type: 'application/pdf' })]); toast(t('addedToLibrary')); onDone?.(); } }, icon('import'), t('addToLibrary'))] : []),
        );
        result.hidden = false;
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        status.textContent = msg === 'unsupported-encryption' ? t('convertUnsupported') : `${t('convertFailed')} — ${msg}`;
        console.error(err);
      } finally { buttons.forEach((b) => { b.disabled = false; }); }
    },
  };
}

export const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'application/pdf' });

/** A labelled input (the label in the interface's language, the input left to right for page numbers). */
const field = (label: string, input: HTMLInputElement) => h('label', { class: 'tool-field' }, h('span', null, label), input);

/** Up / down / remove buttons for one row of an ordered list. */
function rowControls(i: number, n: number, move: (from: number, to: number) => void, remove: () => void): HTMLElement {
  return h('span', { class: 'tool-row-actions' },
    h('button', { type: 'button', class: 'icon-btn small', title: t('moveUp'), 'aria-label': t('moveUp'), disabled: i === 0, onclick: () => move(i, i - 1) }, icon('chevronUp')),
    h('button', { type: 'button', class: 'icon-btn small', title: t('moveDown'), 'aria-label': t('moveDown'), disabled: i === n - 1, onclick: () => move(i, i + 1) }, icon('chevronDown')),
    h('button', { type: 'button', class: 'icon-btn small', title: t('removeItem'), 'aria-label': t('removeItem'), onclick: remove }, icon('close')));
}

/** Rows that can also be dragged into place (mouse or touch). */
export function draggable(row: HTMLElement, i: number, move: (from: number, to: number) => void): void {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/plain', String(i)); row.classList.add('dragging'); });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drop-target'); const from = Number(e.dataTransfer?.getData('text/plain')); if (Number.isFinite(from) && from !== i) move(from, i); });
}

/* ---------- pictures → PDF ---------- */

function imagesSheet(onDone?: () => void): void {
  const sh = openSheet(t('toolImagesToPdf'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const files: { file: File; url: string }[] = [];
  const list = h('div', { class: 'tool-list' });
  let size: PageSize = 'fit'; let margin = 0;
  const render = () => {
    list.replaceChildren();
    if (!files.length) list.append(h('p', { class: 'hint' }, t('nothingAdded')));
    files.forEach((f, i) => {
      const row = h('div', { class: 'tool-row' }, h('img', { class: 'tool-thumb', src: f.url, alt: '' }), h('span', { class: 'name', dir: 'auto' }, f.file.name),
        rowControls(i, files.length, move, () => { URL.revokeObjectURL(f.url); files.splice(i, 1); render(); }));
      draggable(row, i, move); list.append(row);
    });
    go.disabled = !files.length;
  };
  const move = (a: number, b: number) => { const [x] = files.splice(a, 1); files.splice(b, 0, x); render(); };
  const add = h('button', { class: 'btn small tonal', type: 'button', onclick: async () => { for (const f of await pickFiles('image/*', true)) files.push({ file: f, url: URL.createObjectURL(f) }); render(); } }, icon('plus'), t('addImages'));
  const opts = h('div', { class: 'tool-opts' },
    h('label', null, h('span', null, t('pageSize')), pickButton(t('pageSize'), [['fit', t('sizeFit')], ['a4', t('sizeA4')], ['letter', t('sizeLetter')]], size, (v) => { size = v; }, t('close'))),
    h('label', null, h('span', null, t('pageMargin')), pickButton(t('pageMargin'), [['0', t('marginNone')], ['18', t('marginSmall')], ['36', t('marginNormal')]], '0', (v) => { margin = +v; }, t('close'))));
  sh.body.append(h('div', { class: 'tool-bar' }, add), list, opts);
  const r = runner(sh.body, onDone);
  const go = h('button', { class: 'btn small primary', type: 'button', onclick: () => void r.run([go], async () => {
    const { imagesToPdf } = await tools();
    const bytes = await imagesToPdf(files.map((f) => f.file), { size, margin }, (n) => r.progress((n / files.length) * 100));
    return { blob: pdfBlob(bytes), name: `${baseName(files[0].file.name.replace(/\.\w+$/, ''))}.pdf` };
  }) }, icon('file'), t('createPdf')) as HTMLButtonElement;
  sh.actions.append(go);
  render();
}

/* ---------- documents → PDF ---------- */

/** Documents of any kind the app reads (Word, EPUB, text, Markdown, web pages, spreadsheets, slides,
 *  pictures, comics, PDFs) into one PDF, in the order given. */
function docsSheet(books: Book[], onDone?: () => void): void {
  const sh = openSheet(t('toolDocsToPdf'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  type Part = { name: string; file: Blob; format?: Book['format'] };
  const parts: Part[] = [];
  const list = h('div', { class: 'tool-list' });
  let paper: 'a4' | 'letter' = 'a4';
  const render = () => {
    list.replaceChildren();
    if (!parts.length) list.append(h('p', { class: 'hint' }, t('nothingAdded')));
    parts.forEach((p, i) => {
      const row = h('div', { class: 'tool-row' }, icon(p.format === 'image' ? 'images' : p.format === 'pdf' ? 'file' : 'note'),
        h('span', { class: 'name' }, h('bdi', null, p.name), p.format ? h('small', null, ` · ${p.format.toUpperCase()}`) : null),
        rowControls(i, parts.length, move, () => { parts.splice(i, 1); render(); }));
      draggable(row, i, move); list.append(row);
    });
    go.disabled = !parts.length;
  };
  const move = (a: number, b: number) => { const [x] = parts.splice(a, 1); parts.splice(b, 0, x); render(); };
  const addFiles = async (files: File[]) => {
    const { sniffFormat } = await import('../formats');
    for (const f of files) { const format = await sniffFormat(f, f.name).catch(() => 'unknown' as const); if (format === 'unknown' || format === 'audio' || format === 'anki') { toast(t('convertUnsupported')); continue; } parts.push({ name: f.name, file: f, format }); }
    render();
  };
  const fromDev = h('button', { class: 'btn small tonal', type: 'button', onclick: async () => addFiles(await pickFiles('', true)) }, icon('folder'), t('fromDevice'));
  const fromLib = h('button', { class: 'btn small tonal', type: 'button', onclick: () => {
    const usable = books.filter((b) => !['audio', 'anki', 'unknown'].includes(b.format));
    const pick = openSheet(t('fromLibrary'), t('close'), { stack: true }); pick.body.style.fontFamily = 'var(--font-ui)';
    const chosen = new Set<Book>();
    pick.body.append(usable.length ? h('div', { class: 'dest-list' }, ...usable.map((b) => h('label', { class: 'dest-row' }, h('input', { type: 'checkbox', onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(b); else chosen.delete(b); } }), icon('books'), h('span', { class: 'name' }, h('bdi', null, b.title), h('small', null, ` · ${b.format.toUpperCase()}`))))) : h('p', { class: 'hint' }, t('nothingAdded')));
    pick.actions.append(h('button', { class: 'btn small primary', type: 'button', onclick: async () => { pick.close(); for (const b of usable.filter((x) => chosen.has(x))) { const f = await db.getFile(b.id); if (f) parts.push({ name: b.title, file: f, format: b.format }); } render(); } }, icon('check'), t('addPdfs')));
  } }, icon('books'), t('fromLibrary'));
  sh.body.append(h('p', { class: 'src' }, t('toolDocsBody')), h('div', { class: 'tool-bar' }, fromDev, fromLib), list,
    h('div', { class: 'tool-opts' }, h('label', null, h('span', null, t('pageSize')), pickButton(t('pageSize'), [['a4', t('sizeA4')], ['letter', t('sizeLetter')]], paper, (v) => { paper = v; }, t('close')))));
  const r = runner(sh.body, onDone);
  const go = h('button', { class: 'btn small primary', type: 'button', onclick: () => void r.run([go], async () => {
    const { imagesToPdf, mergePdfs } = await tools();
    const { readDocument, buildPdf } = await import('../convert');
    const pdfs: Source[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]; const base = (n: number) => r.progress(((i + n) / parts.length) * 100);
      if (p.format === 'pdf') pdfs.push({ name: p.name, bytes: new Uint8Array(await p.file.arrayBuffer()) });
      else if (p.format === 'image') {
        // (Pictures next to each other share one run of pages.)
        const run: Blob[] = [p.file]; while (parts[i + 1]?.format === 'image') run.push(parts[++i].file);
        pdfs.push({ name: p.name, bytes: await imagesToPdf(run, { size: paper, margin: 0 }) });
      } else if (p.format === 'cbz') {
        const JSZip = (await import('jszip')).default; const zip = await JSZip.loadAsync(p.file);
        const names = Object.keys(zip.files).filter((n) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(n) && !zip.files[n].dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const pics: Blob[] = []; for (const n of names) pics.push(await zip.files[n].async('blob'));
        if (pics.length) pdfs.push({ name: p.name, bytes: await imagesToPdf(pics, { size: 'fit', margin: 0 }) });
      } else {
        const temp = { id: `tmp-${Date.now()}-${i}`, title: p.name.replace(/\.[^.]+$/, ''), format: p.format!, fileName: p.name, size: p.file.size, addedAt: Date.now(), bookmarks: [], highlights: [] } as Book;
        const d = await readDocument(temp, p.file, (_m, pct) => base((pct ?? 0) / 200));
        const blob = await buildPdf(d, (_m, pct) => base(0.5 + (pct ?? 0) / 200), { paper });
        pdfs.push({ name: p.name, bytes: new Uint8Array(await blob.arrayBuffer()) });
      }
      base(1);
    }
    if (!pdfs.length) return null;
    const bytes = pdfs.length === 1 ? pdfs[0].bytes : await mergePdfs(pdfs);
    return { blob: pdfBlob(bytes), name: `${baseName(parts[0].name.replace(/\.[^.]+$/, ''))}${parts.length > 1 ? ` +${parts.length - 1}` : ''}.pdf` };
  }) }, icon('file'), t('createPdf')) as HTMLButtonElement;
  sh.actions.append(go);
  render();
}

/* ---------- merge ---------- */

function mergeSheet(pdfs: Book[], preset: Book | undefined, onDone?: () => void): void {
  const sh = openSheet(t('toolMerge'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const parts: (Source & { range: string; count?: number })[] = [];
  const list = h('div', { class: 'tool-list' });
  const render = () => {
    list.replaceChildren();
    if (!parts.length) list.append(h('p', { class: 'hint' }, t('nothingAdded')));
    parts.forEach((p, i) => {
      const range = field(t('pagesOptional'), h('input', { type: 'text', dir: 'ltr', class: 'tool-range', placeholder: '1-3, 7', value: p.range, oninput: (e: Event) => { p.range = (e.target as HTMLInputElement).value; } }) as HTMLInputElement);
      const row = h('div', { class: 'tool-row' }, icon('file'), h('span', { class: 'name' }, h('bdi', null, p.name), p.count ? h('small', null, ' · ', t('pageCount', { n: p.count })) : null), rowControls(i, parts.length, move, () => { parts.splice(i, 1); render(); }), range);
      draggable(row, i, move); list.append(row);
    });
    go.disabled = parts.length < 2;
  };
  const move = (a: number, b: number) => { const [x] = parts.splice(a, 1); parts.splice(b, 0, x); render(); };
  const push = async (s: Source) => {
    const part = { ...s, range: '' as string, count: undefined as number | undefined };
    parts.push(part); render();
    try { const { pageCount } = await tools(); const n = await withPassword(part, pageCount); if (n) { part.count = n; render(); } } catch { /* counted when merged */ }
  };
  const fromLib = h('button', { class: 'btn small tonal', type: 'button', onclick: () => {
    const pick = openSheet(t('fromLibrary'), t('close'), { stack: true }); pick.body.style.fontFamily = 'var(--font-ui)';
    const chosen = new Set<Book>();
    const rows = h('div', { class: 'dest-list' }, ...pdfs.map((b) => h('label', { class: 'dest-row' }, h('input', { type: 'checkbox', onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(b); else chosen.delete(b); } }), icon('file'), h('span', { class: 'name', dir: 'auto' }, b.title))));
    pick.body.append(pdfs.length ? rows : h('p', { class: 'hint' }, t('noPdfs')));
    pick.actions.append(h('button', { class: 'btn small primary', type: 'button', onclick: async () => { pick.close(); for (const b of pdfs.filter((x) => chosen.has(x))) { const s = await bookSource(b); if (s) await push(s); } } }, icon('check'), t('addPdfs')));
  } }, icon('books'), t('fromLibrary'));
  const fromDev = h('button', { class: 'btn small tonal', type: 'button', onclick: async () => { for (const f of await pickFiles('application/pdf,.pdf', true)) await push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); } }, icon('folder'), t('fromDevice'));
  sh.body.append(h('div', { class: 'tool-bar' }, fromLib, fromDev), list);
  const r = runner(sh.body, onDone);
  const go = h('button', { class: 'btn small primary', type: 'button', onclick: () => void r.run([go], async () => {
    const { mergePdfs, parseRanges, pageCount } = await tools();
    const ready: (Source & { pages?: number[] })[] = [];
    for (const p of parts) {
      const n = p.count ?? await withPassword(p, pageCount); if (n === null) return null;
      ready.push({ ...p, pages: p.range.trim() ? parseRanges(p.range, n) : undefined });
    }
    const bytes = await mergePdfs(ready, (n) => r.progress((n / ready.length) * 100));
    return { blob: pdfBlob(bytes), name: `${baseName(parts[0].name)} +${parts.length - 1}.pdf` };
  }) }, icon('books'), t('toolMerge')) as HTMLButtonElement;
  sh.actions.append(go);
  render();
  if (preset) void bookSource(preset).then((s) => s && push(s));
}

/* ---------- organise pages ---------- */

async function organizeSheet(src: Source, onDone?: () => void, extractOnly = false): Promise<void> {
  const sh = openSheet(t(extractOnly ? 'toolExtract' : 'toolOrganize'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const { pageCount } = await tools();
  const n = await withPassword(src, pageCount).catch((e) => { toast(String((e as Error).message ?? e), 'error'); return null; });
  if (!n) { sh.close(); return; }
  // The pages in their new order, each with its turn and whether it is selected.
  const pages = Array.from({ length: n }, (_, i) => ({ i, rot: 0, sel: false }));
  const gridEl = h('div', { class: 'page-grid' });
  const count = h('span', { class: 'src' });
  const thumbs = new Map<number, string>();
  // Thumbnails drawn by pdf.js as they come into view.
  const { loadPdfjs } = await import('../formats/pdf');
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: src.bytes.slice(), password: src.password } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise.catch(() => null);
  const drawn = new Set<number>();
  const draw = async (i: number, img: HTMLImageElement) => {
    if (!doc || drawn.has(i)) return; drawn.add(i);
    const page = await doc.getPage(i + 1);
    const vp0 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: 160 / Math.max(vp0.width, vp0.height) });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: vp } as Parameters<typeof page.render>[0]).promise;
    const url = c.toDataURL('image/jpeg', 0.7); thumbs.set(i, url); img.src = url;
  };
  const seen = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { const img = e.target as HTMLImageElement; void draw(+img.dataset.i!, img); seen.unobserve(img); } }, { root: sh.body, rootMargin: '200px' });
  // Two ways to choose, kept in step: tapping pages writes their numbers in the field, and numbers typed there
  // select the pages.
  const sync = () => {
    const k = pages.filter((p) => p.sel).length; count.textContent = t('selectedCount', { n: k }); extract.disabled = del.disabled = !k;
    if (document.activeElement !== range) void tools().then(({ formatRanges }) => { range.value = formatRanges(pages.filter((p) => p.sel).map((p) => p.i)); });
  };
  // (Earlier is to the left in a left-to-right interface, to the right in a right-to-left one.)
  const rtlUi = document.documentElement.dir === 'rtl';
  const render = () => {
    gridEl.replaceChildren();
    pages.forEach((p, k) => {
      const img = h('img', { class: 'page-thumb', alt: '', 'data-i': String(p.i), style: { transform: `rotate(${p.rot}deg)` } }) as HTMLImageElement;
      if (thumbs.has(p.i)) img.src = thumbs.get(p.i)!; else seen.observe(img);
      const tile = h('div', { class: 'page-tile' + (p.sel ? ' on' : ''), role: 'checkbox', 'aria-checked': String(p.sel), tabindex: 0,
        onclick: (e: Event) => { if ((e.target as HTMLElement).closest('button')) return; p.sel = !p.sel; tile.classList.toggle('on', p.sel); tile.setAttribute('aria-checked', String(p.sel)); sync(); } },
        h('div', { class: 'page-frame' }, img),
        h('div', { class: 'page-meta' },
          h('b', null, localDigits(String(p.i + 1))),
          h('button', { type: 'button', class: 'icon-btn small', title: t('moveEarlier'), 'aria-label': t('moveEarlier'), disabled: k === 0, onclick: () => { pages.splice(k - 1, 0, pages.splice(k, 1)[0]); render(); } }, icon(rtlUi ? 'chevronRight' : 'chevronLeft')),
          h('button', { type: 'button', class: 'icon-btn small', title: t('rotatePage'), 'aria-label': t('rotatePage'), onclick: () => { p.rot = (p.rot + 90) % 360; img.style.transform = `rotate(${p.rot}deg)`; } }, icon('rotate')),
          h('button', { type: 'button', class: 'icon-btn small', title: t('moveLater'), 'aria-label': t('moveLater'), disabled: k === pages.length - 1, onclick: () => { pages.splice(k + 1, 0, pages.splice(k, 1)[0]); render(); } }, icon(rtlUi ? 'chevronLeft' : 'chevronRight'))));
      draggable(tile, k, (a, b) => { pages.splice(b, 0, pages.splice(a, 1)[0]); render(); });
      gridEl.append(tile);
    });
    sync();
  };
  const range = h('input', { type: 'text', dir: 'ltr', class: 'tool-range', placeholder: '1-3, 7, 10-', 'aria-label': t('selectPages') }) as HTMLInputElement;
  range.addEventListener('blur', () => sync());
  range.addEventListener('input', async () => { const { parseRanges } = await tools(); const want = new Set(parseRanges(range.value, n)); for (const p of pages) p.sel = want.has(p.i); render(); });
  sh.body.append(
    h('p', { class: 'src' }, h('bdi', null, src.name), ' · ', t('pageCount', { n })),
    h('div', { class: 'tool-bar' }, field(t('selectPages'), range),
      h('button', { class: 'chip small', type: 'button', onclick: () => { for (const p of pages) p.sel = true; render(); } }, h('span', null, t('selectAll'))),
      h('button', { class: 'chip small', type: 'button', onclick: () => { for (const p of pages) p.sel = false; range.value = ''; render(); } }, h('span', null, t('clearSelection'))), count),
    h('p', { class: 'hint' }, t('pagesPickHint')),
    gridEl);
  const r = runner(sh.body, onDone);
  const save = (which: 'selected' | 'rest' | 'all') => r.run([extract, del, all], async () => {
    const { pickPages } = await tools();
    const keep = pages.filter((p) => (which === 'selected' ? p.sel : which === 'rest' ? !p.sel : true));
    if (!keep.length) return null;
    const rot: Record<number, number> = {}; for (const p of keep) if (p.rot) rot[p.i] = p.rot;
    const bytes = await pickPages(src, keep.map((p) => p.i), rot);
    return { blob: pdfBlob(bytes), name: `${baseName(src.name)} (${keep.length}).pdf` };
  });
  const extract = h('button', { class: 'btn small primary', type: 'button', onclick: () => void save('selected') }, icon('file'), t('saveSelected')) as HTMLButtonElement;
  const del = h('button', { class: 'btn small tonal', type: 'button', onclick: () => void save('rest') }, icon('trash'), t('deleteSelected')) as HTMLButtonElement;
  const all = h('button', { class: 'btn small tonal', type: 'button', onclick: () => void save('all') }, icon('check'), t('saveChanges')) as HTMLButtonElement;
  if (extractOnly) sh.actions.append(extract); else sh.actions.append(all, del, extract);
  render();
  const obs = new MutationObserver(() => { if (!sh.el.isConnected) { seen.disconnect(); void task.destroy(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
}

/* ---------- remove protection ---------- */

async function unlockSheet(src: Source, onDone?: () => void): Promise<void> {
  const { looksEncrypted } = await import('../pdfcrypt');
  if (!looksEncrypted(src.bytes)) { toast(t('notProtected')); return; }
  const sh = openSheet(t('toolUnlock'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.body.append(h('p', { class: 'src', dir: 'auto' }, src.name));
  const r = runner(sh.body, onDone);
  const go = h('button', { class: 'btn small primary', type: 'button', onclick: () => void r.run([go], async () => {
    const { unlockPdf } = await tools();
    const bytes = await withPassword(src, unlockPdf); if (!bytes) return null;
    return { blob: pdfBlob(bytes), name: `${baseName(src.name)}.pdf` };
  }) }, icon('target'), t('toolUnlock')) as HTMLButtonElement;
  sh.actions.append(go);
  go.click();
}

/* ---------- pages → pictures ---------- */

async function toImagesSheet(src: Source): Promise<void> {
  const sh = openSheet(t('toolToImages'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const { loadPdfjs } = await import('../formats/pdf');
  const pdfjs = await loadPdfjs();
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null;
  for (let wrong = false; !doc;) {
    try { doc = await pdfjs.getDocument({ data: src.bytes.slice(), password: src.password } as Parameters<typeof pdfjs.getDocument>[0]).promise; } catch (err) {
      if ((err as { name?: string }).name !== 'PasswordException') { toast(String((err as Error).message ?? err), 'error'); sh.close(); return; }
      const pw = window.prompt(wrong ? t('pdfPasswordWrong') : t('pdfPasswordPrompt')); if (!pw) { sh.close(); return; }
      src.password = pw; wrong = true;
    }
  }
  const n = doc.numPages;
  let fmt: 'png' | 'jpeg' = 'png'; let dpi = '150';
  const range = h('input', { type: 'text', dir: 'ltr', class: 'tool-range', placeholder: '1-3, 7' }) as HTMLInputElement;
  sh.body.append(h('p', { class: 'src' }, h('bdi', null, src.name), ' · ', t('pageCount', { n })), field(t('pagesOptional'), range),
    h('div', { class: 'tool-opts' },
      h('label', null, h('span', null, t('imageFormat')), pickButton(t('imageFormat'), [['png', 'PNG'], ['jpeg', 'JPEG']], fmt, (v) => { fmt = v; }, t('close'))),
      h('label', null, h('span', null, t('resolution')), pickButton(t('resolution'), [['96', '96 dpi'], ['150', '150 dpi'], ['300', '300 dpi']], dpi, (v) => { dpi = v; }, t('close')))));
  const r = runner(sh.body);
  const go = h('button', { class: 'btn small primary', type: 'button', onclick: () => void r.run([go], async () => {
    const { parseRanges } = await tools();
    const list = range.value.trim() ? parseRanges(range.value, n) : Array.from({ length: n }, (_, i) => i);
    if (!list.length) return null;
    const ext = fmt === 'png' ? 'png' : 'jpg'; const base = baseName(src.name);
    const one = async (i: number) => {
      const page = await doc!.getPage(i + 1); const vp = page.getViewport({ scale: +dpi / 72 });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;
      return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('image'))), `image/${fmt}`, 0.9));
    };
    if (list.length === 1) { const blob = await one(list[0]); return { blob, name: `${base} - p${list[0] + 1}.${ext}` }; }
    const JSZip = (await import('jszip')).default; const zip = new JSZip();
    for (let k = 0; k < list.length; k++) { zip.file(`${base} - p${String(list[k] + 1).padStart(String(n).length, '0')}.${ext}`, await one(list[k])); r.progress(((k + 1) / list.length) * 100); }
    return { blob: await zip.generateAsync({ type: 'blob', compression: 'STORE' }), name: `${base} - ${t('pagesFile', { n: list.length })}.zip` };
  }) }, icon('download'), t('toolToImages')) as HTMLButtonElement;
  sh.actions.append(go);
}
