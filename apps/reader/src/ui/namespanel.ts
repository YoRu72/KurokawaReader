// «Names found»: the names and terms the model proposes for the open book's glossary, grouped by the file each goes
// to (Characters, Places, Skills…); each accepted (its rendering changed first, if wished), or rejected. Nothing enters
// the glossary without being accepted — unless «Add names on their own» is on (then they are put in, marked auto).
import { h, icon, iconButton, pickButton, toast } from './dom';
import { t, localDigits } from '../i18n';
import { getSettings } from '../settings';
import { addTerms, folders, linkedFolders, setLinked, namesTarget, kindOf, kindOrder, KINDS, type TermKind } from '../glossary';
import { aiHooks } from './aisheet';
import { kindLabel, kindIcon, langLabel } from './glossarysheet';
import type { Found } from '../ai';

/** The proposals waiting, for each book (kept while the app is open: the sheet closed and opened again has them). */
const waiting = new Map<string, Found[]>();
export const pendingKinds = (bookId?: string): TermKind[] => (bookId ? [...new Set((waiting.get(bookId) ?? []).map((x) => kindOf(x.kind)))] : []);

export function namesPanel(book: { id: string; title: string } | undefined, changed: () => void): { el: HTMLElement; actions: HTMLElement[] } {
  const el = h('div', { class: 'names-panel' });
  const hk = () => { const x = aiHooks(); return x && book && x.bookId === book.id ? x : null; };
  if (!book) { el.append(h('p', { class: 'src ai-empty' }, t('aiOpenBook'))); return { el, actions: [] }; }
  const target = () => getSettings().aiTarget;
  // (Where accepted names go: the book's own place — its list, or the folder it shares —, every book, or a folder.)
  let dest = 'book';
  const destPick = pickButton(t('glossToFolder'), [['book', t('trAddThisBook')], ['all', t('trAddAllBooks')], ...folders().map((f) => [`f:${f.id}`, `📁 ${f.name}`] as [string, string])], dest, (v) => { dest = v; }, t('close'));
  const scopeOf = (): { book?: string; folder?: string } => { if (dest === 'all') return {}; if (dest.startsWith('f:')) { const id = dest.slice(2); if (!linkedFolders(book.id).includes(id)) setLinked(book.id, [...linkedFolders(book.id), id]); return { folder: id }; } return namesTarget(book.id, book.title); };
  const status = h('p', { class: 'src names-status', role: 'status' });
  const list = h('div', { class: 'names-list' });
  const find = h('button', { type: 'button', class: 'btn tonal small names-find', onclick: () => void run() }, icon('search'), t('trSuggestTerms')) as HTMLButtonElement;
  const scan = h('button', { type: 'button', class: 'btn tonal small names-scan', onclick: () => { const x = hk(); if (x) x.scan(); else toast(t('aiOpenBook')); } }, icon('books'), t('glossScanBook'));
  el.append(h('p', { class: 'src' }, t('trSuggestBody', { lang: langLabel(target()) })), h('div', { class: 'names-tools' }, find, scan), status, list);
  if (!hk()) { find.disabled = true; scan.disabled = true; status.textContent = t('aiOpenBook'); }

  async function run(): Promise<void> {
    const x = hk(); if (!x) return;
    find.disabled = true; status.replaceChildren(h('span', { class: 'spinner', style: { width: '16px', height: '16px' } }), ' ', t('working'));
    try {
      const found = await x.findNames();
      if (!el.isConnected) return;
      const had = waiting.get(book!.id) ?? []; const seen = new Set(had.map((y) => y.from.toLowerCase()));
      waiting.set(book!.id, [...had, ...found.filter((y) => !seen.has(y.from.toLowerCase()))]);
      status.textContent = found.length ? '' : t('trSuggestNone');
      if (found.refused) status.textContent = t('glossRefused', { n: localDigits(found.refused), lang: langLabel(target()) });
      draw(); changed();
    } catch (e) { status.textContent = String((e as Error).message ?? e); }
    finally { find.disabled = false; }
  }
  const accept = (items: Found[]) => {
    if (!items.length) return;
    const n = addTerms(items.map((f) => ({ from: f.from, to: f.to, kind: kindOf(f.kind), lang: target(), ...scopeOf() })));
    const gone = new Set(items.map((f) => f.from.toLowerCase())); waiting.set(book.id, (waiting.get(book.id) ?? []).filter((f) => !gone.has(f.from.toLowerCase())));
    toast(t('trTermsAdded', { n: localDigits(n) })); draw(); changed(); hk()?.added();
  };
  const reject = (items: Found[]) => { const gone = new Set(items.map((f) => f.from.toLowerCase())); waiting.set(book.id, (waiting.get(book.id) ?? []).filter((f) => !gone.has(f.from.toLowerCase()))); draw(); changed(); };
  function draw(): void {
    const all = waiting.get(book!.id) ?? [];
    if (!all.length) { list.replaceChildren(h('p', { class: 'src ai-empty' }, t('namesNone'))); acceptAll.disabled = true; rejectAll.disabled = true; return; }
    acceptAll.disabled = false; rejectAll.disabled = false;
    const by = new Map<TermKind, Found[]>(); for (const f of all) { const k = kindOf(f.kind); by.set(k, [...(by.get(k) ?? []), f]); }
    list.replaceChildren(h('div', { class: 'row names-dest' }, h('span', { class: 'label' }, t('glossToFolder')), destPick),
      ...kindOrder(by.keys()).map((k) => h('section', { class: 'names-group', dataset: { kind: k } },
        h('h4', { class: 'names-head' }, icon(kindIcon(k)), h('span', null, kindLabel(k)), h('small', null, t('glossCount', { n: localDigits(by.get(k)!.length) }))),
        ...by.get(k)!.map((f) => {
          const to = h('input', { type: 'text', dir: 'auto', class: 'tr-term-to', value: f.to, onchange: () => { f.to = to.value.trim() || f.to; } }) as HTMLInputElement;
          const kind = h('select', { class: 'gloss-kind', 'aria-label': t('glossKind') }, ...KINDS.map((x) => h('option', { value: x, selected: kindOf(f.kind) === x }, kindLabel(x)))) as HTMLSelectElement;
          kind.addEventListener('change', () => { f.kind = kind.value; draw(); });
          return h('div', { class: 'tr-term names-row' }, h('span', { class: 'tr-term-from', dir: 'auto' }, f.from), h('span', { class: 'upd-arrow' }, icon('arrowRight')), to,
            h('div', { class: 'names-row-acts' }, kind, iconButton('check', t('namesAccept'), () => { f.to = to.value.trim() || f.to; accept([f]); }), iconButton('close', t('namesReject'), () => reject([f]))));
        }))));
  }
  const acceptAll = h('button', { type: 'button', class: 'btn small primary names-accept-all', onclick: () => { list.querySelectorAll<HTMLInputElement>('.tr-term-to').forEach((x) => x.dispatchEvent(new Event('change'))); accept(waiting.get(book.id) ?? []); } }, icon('check'), t('namesAcceptAll')) as HTMLButtonElement;
  const rejectAll = h('button', { type: 'button', class: 'btn small names-reject-all', onclick: () => reject(waiting.get(book.id) ?? []) }, icon('close'), t('namesRejectAll')) as HTMLButtonElement;
  draw();
  return { el, actions: [rejectAll, acceptAll] };
}
/** Proposals put in the waiting list from elsewhere (the translator, when names are not added on their own). */
export function addWaiting(bookId: string, found: Found[]): void { const had = waiting.get(bookId) ?? []; const seen = new Set(had.map((y) => y.from.toLowerCase())); waiting.set(bookId, [...had, ...found.filter((y) => !seen.has(y.from.toLowerCase()))]); }
