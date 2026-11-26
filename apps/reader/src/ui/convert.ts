// The converter sheet: pick a target, watch the progress, then save / share /
// add the result to the library or send it to a Kindle.
import { h, icon, openSheet, toast, pickSheet, askPassword } from './dom';
import { t, formatBytes } from '../i18n';
import { TARGETS, convertBook, convertible, type Target, type ConvOptions, type PdfPaper } from '../convert';
import { db, stampAfter, type Book } from '../db';
import { importFiles } from '../library';
import { shareFile, downloadBlob, fileNameField } from './share';
import { runJob } from '../jobs';
import { fontCount, resultFile, folderFiles, folderName } from '../fontfolder';

/** Choose which book to convert (library tools button), then open the sheet for it. */
export async function convertPicker(books: Book[], pickFile: () => void): Promise<void> {
  const eligible = books.filter((b) => convertible(b.format));
  if (!eligible.length) { pickFile(); return; }
  pickSheet(t('convertFile'), [...eligible.map((b): [string, string, string?] => [b.id, `${b.title} · ${b.format.toUpperCase()}`, 'books']), ['__file', t('pickAFile'), 'folder']], '', (id) => {
    if (id === '__file') { pickFile(); return; }
    const book = eligible.find((b) => b.id === id); if (book) convertSheet(book);
  }, t('close'));
}

/** The options row: the paper and type size (for a PDF), and whether pictures come along; for a PDF made into
 *  Word, the result — easy to edit or the page's exact look; remembered. */
function optionsRow(): { el: HTMLElement; get(): ConvOptions; showPdf(v: boolean): void; showDocx(v: boolean): void } {
  const KEY = 'kr.convert';
  let o: ConvOptions = { paper: 'a4', images: true };
  try { o = { ...o, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as ConvOptions) }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private mode */ } };
  const paper = h('select', { 'aria-label': t('pageSize') }, ...([['a4', 'A4'], ['a5', 'A5'], ['letter', 'Letter'], ['phone', t('paperPhone')]] as [PdfPaper, string][]).map(([v, l]) => h('option', { value: v, selected: o.paper === v }, l))) as HTMLSelectElement;
  paper.addEventListener('change', () => { o.paper = paper.value as PdfPaper; save(); });
  const size = h('select', { 'aria-label': t('fontSize') }, ...[['', t('fontSizeDefault')], ['15', '15'], ['18', '18'], ['21', '21'], ['24', '24']].map(([v, l]) => h('option', { value: v, selected: String(o.fontSize ?? '') === v }, l))) as HTMLSelectElement;
  size.addEventListener('change', () => { o.fontSize = size.value ? Number(size.value) : undefined; save(); });
  const images = h('input', { type: 'checkbox', role: 'switch', checked: o.images !== false }) as HTMLInputElement;
  images.addEventListener('change', () => { o.images = images.checked; save(); });
  const pdfOnly = h('span', { class: 'conv-pdf-opts' }, h('label', { class: 'chip small check' }, h('span', null, t('pageSize')), paper), h('label', { class: 'chip small check' }, h('span', null, t('fontSize')), size));
  // (PDF → Word: «Easy to edit» — real paragraphs, headings, lists, links and notes — or «Exact look», every line
  // where the page has it.)
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('docxResult') });
  const drawSeg = () => seg.replaceChildren(...([['edit', t('docxResultEdit')], ['exact', t('docxResultExact')]] as ['edit' | 'exact', string][]).map(([v, l]) => {
    const on = (o.docxResult ?? 'edit') === v;
    return h('button', { type: 'button', role: 'radio', 'aria-pressed': String(on), 'aria-checked': String(on), onclick: () => { o.docxResult = v; save(); drawSeg(); } }, l);
  }));
  drawSeg();
  // (PDF → Word's «Fonts»: the PDF's own fonts inside the file — as it has always been — or as files in a folder
  // beside it; the line under it only while «In a folder» is chosen.)
  const fontsSeg = h('div', { class: 'segmented conv-fonts', role: 'radiogroup', 'aria-label': t('docxFonts') });
  const fontsHint = h('p', { class: 'hint conv-fonts-hint', hidden: true }, t('docxFontsHint'));
  const drawFonts = () => {
    fontsSeg.replaceChildren(...([['embed', t('docxFontsInside')], ['folder', t('docxFontsFolder')]] as ['embed' | 'folder', string][]).map(([v, l]) => {
      const on = (o.docxFonts ?? 'embed') === v;
      return h('button', { type: 'button', role: 'radio', 'aria-pressed': String(on), 'aria-checked': String(on), onclick: () => { o.docxFonts = v; save(); drawFonts(); } }, l);
    }));
    fontsHint.hidden = (o.docxFonts ?? 'embed') !== 'folder';
  };
  drawFonts();
  const docxOnly = h('div', { class: 'field conv-docx-opts', hidden: true }, h('span', { class: 'label' }, t('docxResult')), seg, h('span', { class: 'label', style: { marginTop: '6px' } }, t('docxFonts')), fontsSeg, fontsHint);
  // (Keep pictures: a switch, as the app's on/off settings are.)
  const el = h('div', { class: 'conv-opts-wrap' }, h('label', { class: 'row conv-images' }, h('span', { class: 'label' }, t('convKeepImages')), h('span', { class: 'switch' }, images, h('i'))), h('div', { class: 'scan-filters conv-opts' }, pdfOnly), docxOnly);
  return { el, get: () => ({ ...o }), showPdf: (v) => { pdfOnly.hidden = !v; }, showDocx: (v) => { docxOnly.hidden = !v; } };
}

/** Several books to one format, one after the other; the results saved one by one or together as a ZIP. */
export function convertManySheet(books: Book[], onDone?: () => void): void {
  const list = books.filter((b) => convertible(b.format));
  if (!list.length) { toast(t('convertUnsupported'), 'error'); return; }
  const sh = openSheet(t('convertFile'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const targets = TARGETS.filter((x) => list.every((b) => x.from(b.format)));
  const status = h('p', { class: 'src' }, t('convertManyBody', { n: list.length }));
  const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
  const result = h('div', { class: 'convert-result', hidden: true });
  const opts = optionsRow();
  const grid = h('div', { class: 'convert-targets' });
  let busy = false;
  const run = async (target: Target) => {
    if (busy) return; busy = true; grid.querySelectorAll('button').forEach((b) => { b.disabled = true; }); track.hidden = false; result.hidden = true;
    const outs: { blob: Blob; name: string; book: Book; fonts?: import('../fontfolder').FolderFont[] }[] = []; const failed: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const book = list[i];
      status.textContent = `${i + 1}/${list.length} · ${book.title}`;
      try { const out = await convertBook(book, target, (_m, pct) => { if (pct !== undefined) bar.style.width = `${((i + pct / 100) / list.length) * 100}%`; }, undefined, opts.get()); outs.push({ ...out, book }); }
      catch (e) { failed.push(book.title); console.warn('[kurokawa] convert failed', book.title, e); }
    }
    status.textContent = t('convertManyDone', { n: outs.length }) + (failed.length ? ` — ${t('convertFailed')}: ${failed.join('، ')}` : '');
    const tg = TARGETS.find((x) => x.id === target)!;
    result.replaceChildren(
      h('button', { class: 'btn small primary', type: 'button', onclick: async () => { const { default: JSZip } = await import('jszip'); const zip = new JSZip(); for (const o of outs) { zip.file(o.name, o.blob); if (o.fonts?.length) for (const f of folderFiles(o.fonts)) zip.file(`${folderName(o.name)}/${f.name}`, f.data); } downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), `${tg.label}.zip`); } }, icon('download'), t('saveZip')),
      h('button', { class: 'btn small', type: 'button', onclick: async () => { for (const o of outs) { const f = await resultFile(o); downloadBlob(f.blob, f.name); } } }, icon('download'), t('saveEach')),
      h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; await importFiles(outs.map((o) => new File([o.blob], o.name, { type: o.blob.type }))); toast(t('addedToLibrary')); onDone?.(); } }, icon('import'), t('addToLibrary')));
    result.hidden = false; busy = false; grid.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  };
  for (const tg of targets) grid.append(h('button', { class: 'convert-target', type: 'button', onclick: () => { opts.showPdf(tg.id === 'pdf'); void run(tg.id); } }, icon(tg.id === 'pdf' ? 'file' : 'type'), h('b', null, tg.label), h('small', null, `.${tg.ext}`)));
  opts.showDocx(list.every((b) => b.format === 'pdf') && targets.some((x) => x.id === 'docx'));
  sh.body.append(status, track, opts.el, grid, result);
}

export function convertSheet(book: Book, onDone?: () => void): void {
  const sh = openSheet(t('convertFile'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const opts = optionsRow();
  const targets = TARGETS.filter((x) => x.from(book.format) && !(x.id === 'epub' && book.format === 'epub'));
  const status = h('p', { class: 'src' }, t('convertBody', { title: book.title, format: book.format.toUpperCase() }));
  const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
  const result = h('div', { class: 'convert-result', hidden: true });
  const nf = fileNameField(); nf.el.hidden = true;
  const grid = h('div', { class: 'convert-targets' });
  let busy = false;
  const run = async (target: Target, password?: string) => {
    if (busy) return; busy = true;
    grid.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    track.hidden = false; result.hidden = true;
    const progress = (msg: string, pct?: number) => { status.textContent = t(`conv_${msg}` as 'loading') || msg; if (pct !== undefined) bar.style.width = `${pct}%`; };
    try {
      const label = TARGETS.find((x) => x.id === target)?.label ?? target;
      // A job: it goes on (with a notification) when this sheet is closed or the app is left.
      const out = await runJob(`${book.title} → ${label}`, (report) => convertBook(book, target, (msg, pct) => { if (sh.el.isConnected) progress(msg, pct); if (pct !== undefined) report(pct); }, password, opts.get()), () => sh.el.isConnected);
      if (!out) return;
      const { blob } = out;
      // (Its name can be chosen: the field shows the one made for it.)
      nf.suggest(out.name); nf.el.hidden = false;
      const name = () => nf.name(out.name);
      // (A document with its fonts is one result: what is shared or saved is the document and its fonts folder in one ZIP.)
      const nFonts = fontCount(out); const whole = () => resultFile({ blob, name: name(), fonts: out.fonts });
      const total = blob.size + (nFonts ? out.fonts!.reduce((a, f) => a + f.data.length, 0) : 0);
      const tell = () => { status.textContent = t('convertDone', { name: `\u2068${name()}\u2069`, size: `\u2068${formatBytes(total)}\u2069` }) + (nFonts ? ` · ${t('docxWithFonts', { n: nFonts })}` : ''); };
      tell(); nf.input.oninput = tell;
      result.replaceChildren(
        h('button', { class: 'btn small primary', type: 'button', onclick: async () => { const f = await whole(); void shareFile(f.blob, f.name, book.title); } }, icon('external'), target === 'kindle' ? t('sendToKindle') : t('shareFile')),
        h('button', { class: 'btn small', type: 'button', onclick: async () => { const f = await whole(); downloadBlob(f.blob, f.name); } }, icon('download'), t('saveFile')),
        h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; const file = new File([blob], name(), { type: blob.type }); const added = await importFiles([file]); if (added.length) { const folder = (await db.getBook(book.id))?.folderId; if (folder) await db.updateBook(added[0].id, (b) => { b.folderId = folder; b.folderAt = stampAfter(b.folderAt); }); } toast(t('addedToLibrary')); onDone?.(); } }, icon('import'), t('addToLibrary')),
      );
      result.hidden = false;
      if (target === 'kindle') result.append(h('p', { class: 'hint', style: { marginTop: '8px' } }, t('kindleHint')));
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (msg === 'password') {
        // Asked again (with the right wording) when a password was given and was wrong.
        const pw = (await askPassword({ title: t('pdfProtected'), hint: password ? t('pdfPasswordWrong') : t('pdfPasswordPrompt'), wrong: !!password, label: t('password'), open: t('open'), cancel: t('cancel') })) ?? '';
        if (pw) { busy = false; queueMicrotask(() => void run(target, pw)); return; }
        status.textContent = t('cancelled');
      } else if (msg === 'unsupported') status.textContent = t('convertUnsupported');
      else if (msg === 'memory') status.textContent = t('convertNoMemory');
      else { status.textContent = `${t('convertFailed')} — ${msg}`; console.error(err); }
    } finally { busy = false; grid.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
  };
  for (const tg of targets) {
    grid.append(h('button', { class: 'convert-target', type: 'button', onclick: () => void run(tg.id) },
      icon(tg.id === 'pdf' ? 'file' : tg.id === 'kindle' ? 'books' : tg.id === 'docx' || tg.id === 'odt' || tg.id === 'rtf' ? 'note' : tg.id === 'epub' || tg.id === 'fb2' ? 'library' : tg.id === 'cbz' ? 'images' : 'type'),
      h('b', null, tg.label),
      h('small', null, `.${tg.ext}`)));
  }
  opts.showPdf(targets.some((x) => x.id === 'pdf'));
  opts.showDocx(book.format === 'pdf' && targets.some((x) => x.id === 'docx'));
  sh.body.append(status, track, opts.el, grid, nf.el, result);
  if (book.format === 'pdf') sh.body.append(h('p', { class: 'hint', style: { marginTop: '10px' } }, t('pdfConvertHint')));
  if (!('kurokawaDesktop' in window) && targets.some((x) => x.id === 'pdf')) sh.body.append(h('p', { class: 'hint' }, t('pdfImageHint')));
}
