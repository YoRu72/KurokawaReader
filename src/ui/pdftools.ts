// PDF tools: pictures into a PDF, PDFs merged, pages organised (deleted, extracted, reordered, turned),
// protection removed, pages saved as pictures. Every tool makes a new file; the ones it starts from are
// left as they are. The work itself is in ../pdftools.ts (pdf-lib) and ../pdfcrypt.ts.
import { runJob } from '../jobs';
import { h, icon, openSheet, toast, pickButton } from './dom';
import { t, formatBytes, localDigits } from '../i18n';
import { db, type Book } from '../db';
import { importFiles } from '../library';
import { shareFile, downloadBlob, fileNameField } from './share';
import { sortable, placeNumber } from './sortable';
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
    input.addEventListener('cancel', () => { res([]); input.remove(); });
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
/** Run `dispose` once the sheet's element has left the document (its close): listeners, URLs, documents. */
export function onSheetClosed(el: HTMLElement, dispose: () => void): void {
  const obs = new MutationObserver(() => { if (el.isConnected) return; obs.disconnect(); dispose(); });
  obs.observe(document.body, { childList: true });
}

export function runner(body: HTMLElement, onDone?: () => void) {
  const status = h('p', { class: 'src', hidden: true });
  const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
  const result = h('div', { class: 'convert-result', hidden: true });
  // Progress and the finished file's buttons stay in view above the sheet's own buttons, however long its list
  // of pages is (they used to come after it, a thousand pages down).
  // The file's name: the user's own, or else one made for it. It can be changed after the file is made too — Save
  // and Share take the name as it is then.
  const nf = fileNameField(); const nameField = nf.el, nameInput = nf.input;
  let autoName = '';
  const finalName = () => nf.name(autoName);
  const panel = h('div', { class: 'runner-panel' }, nameField, status, track, result);
  const sheet = body.parentElement; const actions = sheet?.querySelector(':scope > .sheet-actions');
  if (sheet && actions) sheet.insertBefore(panel, actions); else body.append(panel);
  // (Anything changed in the sheet — a field, a choice, the list — and the file made before is not this one.)
  const changed = (e: Event) => { if (!(e.target as HTMLElement).closest?.('.organize-jump, .organize-slider, .page-pos-input')) api.stale(); };
  for (const ev of ['input', 'change', 'kr-changed']) body.addEventListener(ev, changed);
  let report: ((pct: number) => void) | null = null;
  let running = false;
  const api = {
    /** What it was made from has changed: the file made before is no longer this one, so its buttons go. */
    stale() { if (running || result.hidden) return; result.hidden = true; status.hidden = true; track.hidden = true; result.replaceChildren(); },
    get running() { return running; },
    progress(pct: number) { track.hidden = false; bar.style.width = `${Math.round(pct)}%`; report?.(pct); },
    async run(buttons: HTMLButtonElement[], work: () => Promise<{ blob: Blob; name: string } | null>) {
      buttons.forEach((b) => { b.disabled = true; });
      running = true;
      status.hidden = false; status.textContent = t('working'); track.hidden = false; bar.style.width = '0%'; result.hidden = true;
      try {
        // A job: it goes on (with a notification) when this sheet is closed or the app is left.
        const title = body.closest('.sheet')?.querySelector('.sheet-head h3')?.textContent ?? t('convertFile');
        const out = await runJob(title, (r) => { report = r; return work(); }, () => body.isConnected).finally(() => { report = null; });
        if (!out) { status.textContent = t('cancelled'); return; }
        const { blob } = out;
        autoName = out.name; nf.suggest(autoName);
        bar.style.width = '100%';
        const tell = () => { status.textContent = t('convertDone', { name: `\u2068${finalName()}\u2069`, size: `\u2068${formatBytes(blob.size)}\u2069` }); };
        tell(); nameInput.oninput = () => { if (!result.hidden) tell(); };
        const isPdf = /\.pdf$/i.test(autoName);
        result.replaceChildren(
          h('button', { class: 'btn small primary', type: 'button', onclick: () => { const n = finalName(); void shareFile(blob, n, n); } }, icon('external'), t('shareFile')),
          h('button', { class: 'btn small', type: 'button', onclick: () => downloadBlob(blob, finalName()) }, icon('download'), t('saveFile')),
          ...(isPdf ? [h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; await importFiles([new File([blob], finalName(), { type: 'application/pdf' })]); toast(t('addedToLibrary')); onDone?.(); } }, icon('import'), t('addToLibrary'))] : []),
        );
        result.hidden = false;
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        status.textContent = msg === 'unsupported-encryption' ? t('convertUnsupported') : `${t('convertFailed')} — ${msg}`;
        console.error(err);
      } finally { running = false; buttons.forEach((b) => { b.disabled = false; }); }
    },
  };
  return api;
}

/** Tell a sheet's runner that what it makes from has changed. */
export const changedIn = (el: HTMLElement) => el.dispatchEvent(new Event('kr-changed', { bubbles: true }));

export const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'application/pdf' });

/** A labelled input (the label in the interface's language, the input left to right for page numbers). */
const field = (label: string, input: HTMLInputElement) => h('label', { class: 'tool-field' }, h('span', null, label), input);

/** Up / down / remove buttons for one row of an ordered list. */
function rowControls(i: number, n: number, move: (from: number, to: number) => void, remove: () => void): HTMLElement {
  // Its place, to tap and type over (or hold the row and drag it), and a button to take it out.
  return h('span', { class: 'tool-row-actions' },
    placeNumber(i, n, move),
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
  { const off = sortable(list, '.tool-row', (a, b) => move(a, b), sh.body); onSheetClosed(sh.el, () => { off(); files.forEach((f) => URL.revokeObjectURL(f.url)); }); }
  let size: PageSize = 'fit'; let margin = 0;
  const render = () => {
    list.replaceChildren();
    if (!files.length) list.append(h('p', { class: 'hint' }, t('nothingAdded')));
    files.forEach((f, i) => {
      const row = h('div', { class: 'tool-row' }, h('img', { class: 'tool-thumb', src: f.url, alt: '' }), h('span', { class: 'name', dir: 'auto' }, f.file.name),
        rowControls(i, files.length, move, () => { URL.revokeObjectURL(f.url); files.splice(i, 1); render(); }));
      row.dataset.k = String(i); list.append(row);
    });
    go.disabled = !files.length;
    changedIn(list);
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
  onSheetClosed(sh.el, sortable(list, '.tool-row', (a, b) => move(a, b), sh.body));
  let paper: 'a4' | 'letter' = 'a4';
  const render = () => {
    list.replaceChildren();
    if (!parts.length) list.append(h('p', { class: 'hint' }, t('nothingAdded')));
    parts.forEach((p, i) => {
      const row = h('div', { class: 'tool-row' }, icon(p.format === 'image' ? 'images' : p.format === 'pdf' ? 'file' : 'note'),
        h('span', { class: 'name' }, h('bdi', null, p.name), p.format ? h('small', null, ` · ${p.format.toUpperCase()}`) : null),
        rowControls(i, parts.length, move, () => { parts.splice(i, 1); render(); }));
      row.dataset.k = String(i); list.append(row);
    });
    go.disabled = !parts.length;
    changedIn(list);
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
  onSheetClosed(sh.el, sortable(list, '.tool-row', (a, b) => move(a, b), sh.body));
  const render = () => {
    list.replaceChildren();
    if (!parts.length) list.append(h('p', { class: 'hint' }, t('nothingAdded')));
    parts.forEach((p, i) => {
      const range = field(t('pagesOptional'), h('input', { type: 'text', dir: 'ltr', class: 'tool-range', placeholder: '1-3, 7', value: p.range, oninput: (e: Event) => { p.range = (e.target as HTMLInputElement).value; } }) as HTMLInputElement);
      const row = h('div', { class: 'tool-row' }, icon('file'), h('span', { class: 'name' }, h('bdi', null, p.name), p.count ? h('small', null, ' · ', t('pageCount', { n: p.count })) : null), rowControls(i, parts.length, move, () => { parts.splice(i, 1); render(); }), range);
      row.dataset.k = String(i); list.append(row);
    });
    go.disabled = parts.length < 2;
    changedIn(list);
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

/**
 * Pages of a PDF to choose, put in order, turn, delete or save as a new PDF. Two views: all pages as small
 * pictures (tap to choose, hold and drag to move, tap a number to type a new place), and one page at a time,
 * large, like the reader — leafed through, or jumped to by number or with the slider — to choose it there.
 * Made for long books: a thousand tiles are built once and only repainted; pictures are drawn as they come into
 * view; the buttons and the finished file stay in sight.
 */
async function organizeSheet(src: Source, onDone?: () => void, extractOnly = false): Promise<void> {
  const sh = openSheet(t(extractOnly ? 'toolExtract' : 'toolOrganize'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.el.classList.add('organize-sheet');
  const { pageCount } = await tools();
  const n = await withPassword(src, pageCount).catch((e) => { toast(String((e as Error).message ?? e), 'error'); return null; });
  if (!n) { sh.close(); return; }
  // The pages in their new order, each with its turn and whether it is chosen.
  type P = { i: number; rot: number; sel: boolean };
  const pages: P[] = Array.from({ length: n }, (_, i) => ({ i, rot: 0, sel: false }));
  const gridEl = h('div', { class: 'page-grid organize-grid' });
  const count = h('span', { class: 'src organize-count' });
  const thumbs = new Map<number, string>();
  const { loadPdfjs } = await import('../formats/pdf');
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: src.bytes.slice(), password: src.password } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise.catch(() => null);
  // Thumbnails drawn one after another as they come into view (the newest asked first: those are on screen).
  const want: number[] = []; const asked = new Set<number>(); let drawing = false;
  const pump = async () => {
    if (drawing || !doc) return; drawing = true;
    while (want.length && sh.el.isConnected) {
      const i = want.pop()!;
      try {
        const page = await doc.getPage(i + 1);
        const vp0 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: 180 / Math.max(vp0.width, vp0.height) });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: vp } as Parameters<typeof page.render>[0]).promise;
        const url = await new Promise<string>((res) => c.toBlob((bl) => res(bl ? URL.createObjectURL(bl) : ''), 'image/jpeg', 0.72));
        thumbs.set(i, url); page.cleanup();
        gridEl.querySelectorAll<HTMLImageElement>(`img[data-i="${i}"]`).forEach((im) => { im.src = url; });
      } catch { /* left blank */ }
    }
    drawing = false;
  };
  const seen = new IntersectionObserver((es) => {
    for (const e of es) {
      const i = +(e.target as HTMLElement).dataset.i!;
      if (e.isIntersecting && !thumbs.has(i) && !asked.has(i)) { asked.add(i); want.push(i); }
      else if (!e.isIntersecting && asked.has(i) && !thumbs.has(i)) { asked.delete(i); const at = want.indexOf(i); if (at >= 0) want.splice(at, 1); }
    }
    void pump();
  }, { root: sh.body, rootMargin: '300px' });

  // Tiles: made once each, repainted in place.
  const tiles = new Map<P, HTMLElement>();
  const tileOf = (p: P) => {
    let tile = tiles.get(p); if (tile) return tile;
    const img = h('img', { class: 'page-thumb', alt: '', 'data-i': String(p.i), draggable: false }) as HTMLImageElement;
    if (thumbs.has(p.i)) img.src = thumbs.get(p.i)!; else seen.observe(img);
    tile = h('div', { class: 'page-tile', role: 'checkbox', tabindex: 0,
      onclick: (e: Event) => { if ((e.target as HTMLElement).closest('button, input')) return; p.sel = !p.sel; paint(p); sync(); },
      onkeydown: (e: KeyboardEvent) => { if ((e.key === ' ' || e.key === 'Enter') && !(e.target as HTMLElement).closest('input, button')) { e.preventDefault(); p.sel = !p.sel; paint(p); sync(); } } },
      h('div', { class: 'page-frame' }, img, h('span', { class: 'page-check' }, icon('check'))),
      h('div', { class: 'page-meta' }));
    tiles.set(p, tile);
    return tile;
  };
  const paint = (p: P) => {
    const tile = tileOf(p); const k = pages.indexOf(p);
    tile.dataset.k = String(k);
    tile.classList.toggle('on', p.sel); tile.setAttribute('aria-checked', String(p.sel));
    tile.setAttribute('aria-label', t('pageN', { n: localDigits(String(p.i + 1)) }));
    (tile.querySelector('.page-thumb') as HTMLElement).style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
    tile.querySelector('.page-meta')!.replaceChildren(...[
      placeNumber(k, pages.length, moveTo),
      // (The page's own number, when it no longer stands at its place.)
      p.i !== k ? h('small', { class: 'page-orig', title: t('pageN', { n: localDigits(String(p.i + 1)) }) }, localDigits(String(p.i + 1))) : null,
      h('button', { type: 'button', class: 'icon-btn small', title: t('rotatePage'), 'aria-label': t('rotatePage'), onclick: () => { p.rot = (p.rot + 90) % 360; paint(p); } }, icon('rotate'))].filter((x): x is HTMLElement => !!x));
  };
  const order = () => { gridEl.replaceChildren(...pages.map(tileOf)); pages.forEach(paint); sync(); };
  const moveTo = (a: number, b: number) => { if (a === b) return; pages.splice(b, 0, pages.splice(a, 1)[0]); order(); };
  onSheetClosed(sh.el, sortable(gridEl, '.page-tile', moveTo, sh.body));

  // Two ways to choose, kept in step: tapping pages writes their numbers in the field, and numbers typed there
  // choose the pages.
  const sync = () => {
    const k = pages.filter((p) => p.sel).length; count.textContent = t('selectedCount', { n: k });
    extract.disabled = del.disabled = moveSel.disabled = !k;
    changedIn(gridEl);
    if (document.activeElement !== range) void tools().then(({ formatRanges }) => { range.value = formatRanges(pages.filter((p) => p.sel).map((p) => p.i)); });
    if (view === 'pages') paintViewer();
  };
  const range = h('input', { type: 'text', dir: 'ltr', class: 'tool-range organize-range', placeholder: '1-3, 7, 10-', 'aria-label': t('selectPages') }) as HTMLInputElement;
  range.addEventListener('blur', () => sync());
  range.addEventListener('input', async () => { const { parseRanges } = await tools(); const chosen = new Set(parseRanges(range.value, n)); for (const p of pages) { if (p.sel !== chosen.has(p.i)) { p.sel = chosen.has(p.i); paint(p); } } sync(); });
  const setAll = (v: boolean) => { for (const p of pages) if (p.sel !== v) { p.sel = v; paint(p); } if (!v) range.value = ''; sync(); };
  // Many pages moved at once: the chosen ones, in their order, to the place typed.
  const moveSel = h('button', { class: 'chip small', type: 'button', onclick: () => {
    const to = window.prompt(t('moveChosenTo', { n: localDigits(String(pages.length)) }));
    const v = parseInt((to ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), 10); if (!Number.isFinite(v)) return;
    const chosen = pages.filter((p) => p.sel); const rest = pages.filter((p) => !p.sel);
    const at = Math.max(0, Math.min(rest.length, rest.filter((p, idx) => idx < v - 1).length));
    pages.splice(0, pages.length, ...rest.slice(0, at), ...chosen, ...rest.slice(at)); order();
  } }, icon('sort'), h('span', null, t('moveChosen'))) as HTMLButtonElement;

  // Jump to a page in the grid.
  const jump = h('input', { type: 'text', inputmode: 'numeric', dir: 'ltr', class: 'tool-range organize-jump', placeholder: t('goToPageShort'), 'aria-label': t('goToPage') }) as HTMLInputElement;
  jump.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return; e.preventDefault();
    const v = parseInt(jump.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), 10); if (!Number.isFinite(v)) return;
    const p = pages.find((x) => x.i === v - 1) ?? pages[Math.max(0, Math.min(pages.length - 1, v - 1))];
    if (view === 'pages') { cur = pages.indexOf(p); showPage(); return; }
    const tile = tiles.get(p); tile?.scrollIntoView({ block: 'center' }); tile?.classList.add('flash'); setTimeout(() => tile?.classList.remove('flash'), 1200);
  });

  /* One page at a time, large. */
  let view: 'grid' | 'pages' = 'grid'; let cur = 0; let viewTask: { cancel(): void } | null = null;
  const vCanvas = h('canvas', { class: 'organize-page' }) as HTMLCanvasElement;
  const vPos = h('input', { type: 'text', inputmode: 'numeric', dir: 'ltr', class: 'tool-range organize-pos', 'aria-label': t('goToPage') }) as HTMLInputElement;
  const vTotal = h('span', { class: 'src' });
  const vSlider = h('input', { type: 'range', min: '1', max: String(n), value: '1', class: 'organize-slider', 'aria-label': t('goToPage') }) as HTMLInputElement;
  const vSel = h('button', { type: 'button', class: 'btn organize-select' }) as HTMLButtonElement;
  const step = (d: number) => { cur = Math.max(0, Math.min(pages.length - 1, cur + d)); showPage(); };
  const paintViewer = () => {
    const p = pages[cur]; if (!p) return;
    vPos.value = String(cur + 1); vSlider.value = String(cur + 1); vTotal.textContent = `/ ${localDigits(String(pages.length))}`;
    vSel.classList.toggle('primary', p.sel); vSel.classList.toggle('tonal', !p.sel);
    vSel.replaceChildren(icon(p.sel ? 'check' : 'plus'), h('span', null, p.sel ? t('pageChosen') : t('choosePage')));
    vCanvas.style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
  };
  const showPage = async () => {
    paintViewer();
    if (!doc) return;
    const p = pages[cur]; viewTask?.cancel();
    const page = await doc.getPage(p.i + 1);
    const box = viewer.getBoundingClientRect();
    const vp0 = page.getViewport({ scale: 1 });
    const fit = Math.min((box.width || 360) / vp0.width, ((box.height || 520) - 8) / vp0.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: fit * dpr });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const rt = page.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: vp } as Parameters<typeof page.render>[0]);
    viewTask = rt;
    try { await rt.promise; } catch { return; }
    if (pages[cur] !== p) return;
    vCanvas.width = c.width; vCanvas.height = c.height; vCanvas.getContext('2d')!.drawImage(c, 0, 0);
    vCanvas.style.width = `${c.width / dpr}px`; vCanvas.style.height = `${c.height / dpr}px`;
  };
  vSel.addEventListener('click', () => { const p = pages[cur]; p.sel = !p.sel; paint(p); sync(); });
  vPos.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = parseInt(vPos.value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), 10); if (Number.isFinite(v)) { cur = Math.max(0, Math.min(pages.length - 1, v - 1)); void showPage(); } } });
  vSlider.addEventListener('input', () => { cur = +vSlider.value - 1; paintViewer(); });
  vSlider.addEventListener('change', () => void showPage());
  const rtlUi = document.documentElement.dir === 'rtl';
  const viewer = h('div', { class: 'organize-viewer', hidden: true }, vCanvas);
  // Swipes leaf through the pages (toward the next page as a book in the interface's direction turns).
  { let x0 = 0, y0 = 0; viewer.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; }); viewer.addEventListener('pointerup', (e) => { const dx = e.clientX - x0, dy = e.clientY - y0; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step((dx < 0) !== rtlUi ? 1 : -1); }); }
  const vBar = h('div', { class: 'organize-vbar', hidden: true },
    h('button', { type: 'button', class: 'icon-btn', title: t('previousPage'), 'aria-label': t('previousPage'), onclick: () => void step(-1) }, icon(rtlUi ? 'chevronRight' : 'chevronLeft')),
    h('span', { class: 'organize-of' }, vPos, vTotal),
    h('button', { type: 'button', class: 'icon-btn', title: t('nextPage'), 'aria-label': t('nextPage'), onclick: () => void step(1) }, icon(rtlUi ? 'chevronLeft' : 'chevronRight')),
    h('button', { type: 'button', class: 'icon-btn', title: t('rotatePage'), 'aria-label': t('rotatePage'), onclick: () => { const p = pages[cur]; p.rot = (p.rot + 90) % 360; paint(p); paintViewer(); } }, icon('rotate')),
    vSel);
  const vFoot = h('div', { class: 'organize-vfoot', hidden: true }, vSlider);
  sh.el.addEventListener('keydown', (e) => { if (view !== 'pages' || (e.target as HTMLElement).closest('input')) return; if (e.key === 'ArrowRight') { e.preventDefault(); step(rtlUi ? -1 : 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); step(rtlUi ? 1 : -1); } else if (e.key === ' ') { e.preventDefault(); vSel.click(); } });
  const seg = h('div', { class: 'segmented organize-views', role: 'tablist' });
  const setView = (v: typeof view) => {
    view = v;
    seg.replaceChildren(...([['grid', t('viewPagesGrid'), 'grid'], ['pages', t('viewOnePage'), 'file']] as [typeof view, string, string][]).map(([id, label, ic]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(view === id), 'aria-selected': String(view === id), onclick: () => setView(id) }, icon(ic), h('span', null, label))));
    gridEl.hidden = v !== 'grid'; hint.hidden = v !== 'grid';
    viewer.hidden = vBar.hidden = vFoot.hidden = v !== 'pages';
    if (v === 'pages') { requestAnimationFrame(() => void showPage()); }
  };
  const hint = h('p', { class: 'hint' }, t('organizeHint'));
  sh.body.append(
    h('div', { class: 'organize-head' },
      h('p', { class: 'src' }, h('bdi', null, src.name), ' · ', t('pageCount', { n })),
      seg),
    h('div', { class: 'organize-tools' },
      h('div', { class: 'organize-row' }, range, jump),
      h('div', { class: 'organize-row chips' },
        h('button', { class: 'chip small', type: 'button', onclick: () => setAll(true) }, h('span', null, t('selectAll'))),
        h('button', { class: 'chip small', type: 'button', onclick: () => setAll(false) }, h('span', null, t('clearSelection'))),
        ...(extractOnly ? [] : [moveSel]), count)),
    hint, gridEl, vBar, viewer, vFoot);
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
  setView('grid');
  order();
  const obs = new MutationObserver(() => { if (!sh.el.isConnected) { seen.disconnect(); viewTask?.cancel(); thumbs.forEach((u) => URL.revokeObjectURL(u)); void task.destroy(); obs.disconnect(); } });
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
  { const d = doc; onSheetClosed(sh.el, () => void d.loadingTask.destroy()); }
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
