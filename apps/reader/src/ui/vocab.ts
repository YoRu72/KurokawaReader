// The vocabulary notebook: every word looked up while reading is kept with the sentence it was found in and
// the book it came from, to be reviewed later and taken into Anki (its TSV import makes a deck of them:
// word on the front, sentence and definition on the back).
import { h, icon, openSheet, toast, clear } from './dom';
import { t, localDigits, isRtlText } from '../i18n';
import { activeBookId, getSettings } from '../settings';
import { downloadBlob } from './share';
import { db } from '../db';

export interface VocabEntry { w: string; ctx: string; def?: string; book?: string; title?: string; at: number }
const KEY = 'kr.vocab';
const MAX = 3000;
const listeners = new Set<() => void>();

export function vocab(): VocabEntry[] { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as VocabEntry[]; } catch { return []; } }
function write(list: VocabEntry[]): void { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch { /* full */ } listeners.forEach((fn) => fn()); }
export function onVocabChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/** Keep a word (once; a second lookup refreshes its definition and sentence). */
export async function saveWord(word: string, ctx = '', def?: string): Promise<void> {
  const w = word.trim(); if (!w || !getSettings().vocabSave) return;
  const list = vocab();
  const i = list.findIndex((e) => e.w.toLowerCase() === w.toLowerCase());
  const book = activeBookId() ?? undefined;
  const title = book ? (await db.getBook(book))?.title : undefined;
  const entry: VocabEntry = { ...(i >= 0 ? list[i] : {}), w, ctx: ctx.trim().slice(0, 300) || (i >= 0 ? list[i].ctx : ''), def: def ?? (i >= 0 ? list[i].def : undefined), book, title, at: Date.now() };
  if (i >= 0) list.splice(i, 1);
  list.push(entry); write(list);
}
export function forgetWord(w: string): void { write(vocab().filter((e) => e.w !== w)); }

const tsvCell = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();
/** Anki's tab-separated import: front, back (sentence + definition), tags. */
export function vocabTsv(list = vocab()): string {
  const lines = ['#separator:tab', '#html:true', '#tags column:3'];
  for (const e of list) {
    const back = [e.ctx ? `<i>${esc(e.ctx)}</i>` : '', e.def ? esc(e.def) : '', e.title ? `<small>${esc(e.title)}</small>` : ''].filter(Boolean).join('<br>');
    lines.push([tsvCell(e.w), tsvCell(back), 'kurokawa' + (e.title ? ' ' + tsvCell(e.title).replace(/\s+/g, '_').slice(0, 40) : '')].join('\t'));
  }
  return lines.join('\n') + '\n';
}
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** The notebook, as a sheet: the words newest first, each with its sentence; export and forget. */
export function vocabSheet(): void {
  const sh = openSheet(t('vocabulary'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const list = h('div', { class: 'vocab-list' });
  const q = h('input', { type: 'search', placeholder: t('search'), class: 'track-search', dir: 'auto' }) as HTMLInputElement;
  const draw = () => {
    clear(list);
    const needle = q.value.trim().toLowerCase();
    const items = vocab().reverse().filter((e) => !needle || e.w.toLowerCase().includes(needle) || e.ctx.toLowerCase().includes(needle) || (e.title ?? '').toLowerCase().includes(needle));
    if (!items.length) { list.append(h('p', { class: 'src' }, t('vocabEmpty'))); return; }
    for (const e of items) list.append(h('div', { class: 'vocab-row' },
      h('div', { class: 'vocab-word', dir: isRtlText(e.w) ? 'rtl' : 'ltr' }, e.w),
      e.ctx ? h('div', { class: 'vocab-ctx', dir: 'auto' }, e.ctx) : null,
      e.def ? h('div', { class: 'vocab-def', dir: 'auto' }, e.def) : null,
      h('div', { class: 'vocab-meta' }, h('span', null, [e.title, new Date(e.at).toLocaleDateString()].filter(Boolean).join(' · ')),
        h('button', { type: 'button', class: 'icon-btn small', title: t('delete'), 'aria-label': t('delete'), onclick: () => { forgetWord(e.w); draw(); } }, icon('trash')))));
  };
  q.addEventListener('input', draw);
  sh.body.append(h('div', { class: 'tool-bar' }, q, h('span', { class: 'src' }, t('wordsCount', { n: localDigits(String(vocab().length)) }))), list);
  sh.actions.append(
    h('button', { type: 'button', class: 'btn small', onclick: () => { downloadBlob(new Blob([vocabTsv()], { type: 'text/tab-separated-values' }), 'vocabulary-anki.txt'); toast(t('vocabExported')); } }, icon('download'), t('exportAnki')),
    h('button', { type: 'button', class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(vocabTsv()); toast(t('copied')); } catch { toast(t('copyFailed'), 'error'); } } }, icon('copy'), t('copySelected')),
    h('button', { type: 'button', class: 'btn small danger', onclick: () => { if (!vocab().length || !confirm(t('vocabClearConfirm'))) return; write([]); draw(); } }, icon('trash'), t('clearAll')));
  draw();
}
