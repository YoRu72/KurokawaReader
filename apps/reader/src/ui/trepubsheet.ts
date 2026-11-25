// «Save the translation as EPUB» (the Saved translations tab, a book's sheet in the library): the small sheet that asks what the file
// holds — the language (when more than one is saved), the translation alone or with the original beneath, what to do with the chapters
// not translated yet, the glossary at the end, the book added to the library — and makes it (src/translatedepub.ts).
import { h, icon, openSheet, toast, pickButton, stackWhenCramped } from './dom';
import { t, localDigits, formatBytes } from '../i18n';
import { db, type Book } from '../db';
import { switchRow } from './gather';
import { downloadBlob } from './share';
import { runJob } from '../jobs';
import type { Contents, Missing, Loaded } from '../translatedepub';

export interface TrEpubHooks { /** The whole book translated first (the reader of the book is open): the sheet closes and the question about the names comes as for any start by hand. */ translateWhole?: () => void }

/** Whether a book can have the action at all (a book the reader lays out) and has translations kept. */
export async function canSaveTranslation(bookId: string): Promise<boolean> {
  const b = await db.getBook(bookId); if (!b) return false;
  const { exportable } = await import('../translatedepub'); if (!exportable(b)) return false;
  return Object.keys((await db.getMeta<Record<string, string>>(`tr:${bookId}`)) ?? {}).length > 0;
}

export function translatedEpubSheet(book: Book, hooks: TrEpubHooks = {}): void {
  const sh = openSheet(t('teAction'), t('close'), { stack: true, onClose: () => { closed = true; sig.stop = true; } });
  sh.el.classList.add('confirm-sheet', 'tre-sheet'); sh.body.style.fontFamily = 'var(--font-ui)';
  let L: Loaded | null = null; let lang = ''; let contents: Contents = 'only'; let missing: Missing = 'original'; let glossary = false; let library = false; let busy = false;
  let sig = { stop: false }; let closed = false;
  const status = h('p', { class: 'hint tre-status', role: 'status' }, t('teReading'));
  const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
  const form = h('div', { class: 'tre-form', hidden: true });
  const cancel = h('button', { type: 'button', class: 'btn text tre-cancel', onclick: () => { if (busy) { sig.stop = true; return; } sh.close(); } }, t('cancel')) as HTMLButtonElement;
  const save = h('button', { type: 'button', class: 'btn primary tre-save', disabled: true, onclick: () => void go() }, icon('download'), t('teSaveGo')) as HTMLButtonElement;
  sh.actions.append(cancel, save); stackWhenCramped(sh.actions);
  sh.body.append(status, track, form);

  const progress = (_m: string, pct?: number): void => { if (pct !== undefined) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`; };
  const states = (): ('done' | 'missing' | 'plain')[] => L?.states.get(lang) ?? [];
  const missingN = (): number => states().filter((x) => x === 'missing').length;

  async function draw(): Promise<void> {
    const m = await import('../translatedepub');
    form.replaceChildren();
    if (!L || !L.langs.length) { status.textContent = t('teNoneLang'); status.hidden = false; save.disabled = true; form.hidden = true; return; }
    if (!L.langs.includes(lang)) lang = L.langs[0];
    status.hidden = true; form.hidden = false; save.disabled = false;
    // the language
    if (L.langs.length > 1) {
      const pick = pickButton(t('teLang'), L.langs.map((c): [string, string] => [c, m.langLabel(c)]), lang, (v) => { lang = v; void draw(); }, t('close'));
      form.append(h('div', { class: 'field' }, h('span', { class: 'label' }, t('teLang')), pick));
    } else form.append(h('div', { class: 'field' }, h('span', { class: 'label' }, t('teLang')), h('p', { class: 'tre-lang', dir: 'auto' }, m.langLabel(lang))));
    // what the file holds
    const seg = <T extends string>(label: string, opts: [T, string][], value: T, set: (v: T) => void, cls: string): HTMLElement => {
      const g = h('div', { class: `segmented tre-seg ${cls}`, role: 'group', 'aria-label': label }, ...opts.map(([k, l]) => h('button', { type: 'button', dataset: { v: k }, 'aria-pressed': String(k === value), onclick: () => { g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === k))); set(k); } }, l)));
      return g;
    };
    form.append(h('div', { class: 'field' }, h('span', { class: 'label' }, t('teContents')), seg<Contents>(t('teContents'), [['only', t('teOnly')], ['both', t('teBoth')]], contents, (v) => { contents = v; }, 'tre-contents')));
    // the chapters not translated yet
    const n = missingN();
    if (n > 0) {
      form.append(h('div', { class: 'field tre-missing' },
        h('span', { class: 'label' }, t('teMissing', { n: localDigits(n) })),
        seg<Missing>(t('teMissing', { n: localDigits(n) }), [['original', t('teKeepOrig')], ['leave', t('teLeaveOut')]], missing, (v) => { missing = v; }, 'tre-missing-seg'),
        ...(hooks.translateWhole ? [h('button', { type: 'button', class: 'btn tonal tre-first', onclick: () => { sh.close(); hooks.translateWhole!(); } }, icon('translate'), t('teTranslateFirst'))] : [])));
    } else missing = 'original';
    form.append(switchRow(t('teGlossary'), glossary, (v) => { glossary = v; }, undefined, 'tre-gloss'), switchRow(t('teLibrary'), library, (v) => { library = v; }, undefined, 'tre-lib'));
  }

  async function load(): Promise<void> {
    status.hidden = false; status.textContent = t('teReading'); track.hidden = false; bar.style.width = '4%'; form.hidden = true; save.disabled = true;
    try {
      const m = await import('../translatedepub');
      const l = await m.loadForExport(book, progress);
      if (closed) return; L = l; track.hidden = true; if (!lang) lang = l.langs[0] ?? '';
      await draw();
    } catch (e) {
      if (closed) return; track.hidden = true; status.textContent = `${t('convertFailed')} — ${String((e as Error).message ?? e)}`; console.warn('[kurokawa] translated EPUB: reading failed', e);
    }
  }

  async function go(): Promise<void> {
    if (busy || !lang) return; busy = true; sig = { stop: false }; save.disabled = true; form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((x) => { x.disabled = true; });
    track.hidden = false; bar.style.width = '4%'; status.hidden = false; status.textContent = t('teBuilding');
    const o = { lang, contents, missing, glossary };
    const withLibrary = library; let ok = false;
    try {
      const m = await import('../translatedepub');
      // (The loaded book is consumed by the making of the file — a second making reads it again.)
      const l = L && !L.used ? L : await m.loadForExport(book, progress); L = l;
      const out = await runJob(`${book.title} → EPUB`, async (report) => {
        try { return await m.makeTranslatedEpub(l, o, (msg, pct) => { progress(msg, pct); if (pct !== undefined) report(pct); }, sig); }
        catch (e) { if ((e as Error).message === 'cancel') return null; throw e; }
      }, () => sh.el.isConnected, { cancel: () => { sig.stop = true; } });
      if (!out) { status.textContent = t('cancelled'); return; }
      downloadBlob(out.blob, out.name);
      toast(t('teDone', { name: `\u2068${out.name}\u2069`, size: `\u2068${formatBytes(out.blob.size)}\u2069` }), 'info', 5000);
      if (withLibrary) { await m.addToLibrary(book, out.blob, out.name, lang); toast(t('addedToLibrary')); }
      ok = true; sh.close();
    } catch (e) {
      if (closed) return; status.textContent = `${t('convertFailed')} — ${String((e as Error).message ?? e)}`; console.warn('[kurokawa] translated EPUB failed', e);
    } finally {
      busy = false;
      if (!closed && !ok) { track.hidden = true; form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((x) => { x.disabled = false; }); save.disabled = false; }
    }
  }
  void load();
}
