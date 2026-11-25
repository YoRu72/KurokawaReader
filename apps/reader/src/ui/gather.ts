// «Gather the names first?» — before a book's translation starts, the part to be translated is searched for names (the
// characters, places and terms) so that each gets one rendering throughout. This file holds the answer kept for each book
// (ask / gather by itself / never: kept with the book, so a backup carries it), the choice of starting by itself (per book:
// follow the setting / always / never), what was asked in this session, and the small sheet that asks.
import { h, openSheet, stackWhenCramped } from './dom';
import { t } from '../i18n';
import { db } from '../db';
import { getSettings } from '../settings';

export type GatherMode = 'ask' | 'always' | 'never';
export type AutoMode = 'follow' | 'always' | 'never';
const isGather = (x: unknown): x is GatherMode => x === 'ask' || x === 'always' || x === 'never';
const isAuto = (x: unknown): x is AutoMode => x === 'follow' || x === 'always' || x === 'never';

/** This book's own choice about gathering names before translating (undefined: it has none — the setting's default stands). */
export async function bookGather(bookId: string): Promise<GatherMode | undefined> { const v = await db.getMeta<string>(`trGather:${bookId}`); return isGather(v) ? v : undefined; }
export async function setBookGather(bookId: string, v: GatherMode | null): Promise<void> { if (v) await db.setMeta(`trGather:${bookId}`, v); else await db.deleteMeta(`trGather:${bookId}`); }
/** The mode in force for a book: its own, else the global default (Ask unless changed). */
export async function gatherModeOf(bookId: string): Promise<GatherMode> { return (await bookGather(bookId)) ?? getSettings().aiGatherNames ?? 'ask'; }
/** This book's own choice about starting to translate by itself when it opens. */
export async function bookAuto(bookId: string): Promise<AutoMode> { const v = await db.getMeta<string>(`trAuto:${bookId}`); return isAuto(v) ? v : 'follow'; }
export async function setBookAuto(bookId: string, v: AutoMode): Promise<void> { if (v === 'follow') await db.deleteMeta(`trAuto:${bookId}`); else await db.setMeta(`trAuto:${bookId}`, v); }

/* ---------- this session ---------- */
/** The parts already asked about (a chapter once, whatever the answer), the books whose reader answered «gather» or
 *  «without» (moving on to another chapter does not ask again), and the books whose automatic start was stopped. */
const asked = new Set<string>();
export const askedKey = (bookId: string, idx: number | '*'): string => `${bookId}:${idx}`;
export const wasAsked = (k: string): boolean => asked.has(k);
export const markAsked = (k: string): void => { asked.add(k); };
const sessionPick = new Map<string, 'gather' | 'skip'>();
export const sessionChoice = (bookId: string): 'gather' | 'skip' | undefined => sessionPick.get(bookId);
export const setSessionChoice = (bookId: string, v: 'gather' | 'skip'): void => { sessionPick.set(bookId, v); };
const stopped = new Set<string>();
export const autoStopped = (bookId: string): boolean => stopped.has(bookId);
export const stopAuto = (bookId: string): void => { stopped.add(bookId); };
/** (Tests: the session forgotten.) */
export const _forgetSession = (): void => { asked.clear(); sessionPick.clear(); stopped.clear(); };

/* ---------- the question ---------- */
export type GatherScope = 'chapter' | 'book';
export interface GatherAsk {
  /** What is to be translated: one chapter, several, or the whole book — which scope is chosen first. */
  scope: GatherScope; chapters: 'one' | 'many';
  /** Whether the other scope is offered (a whole-book translation offers none: the whole book is what is read). */
  both: boolean;
  /** The glossary of a former volume in use (its title): the sheet says so and asks to check for new names. */
  volume?: string;
  /** The names are found by a model on this device (no requests spent). */
  local?: boolean;
  /** The gathering itself, run inside the sheet once «Gather» is pressed (it shows the progress, and on a failure says so in
   *  one line and offers «Translate without»). Resolves whether it went through; `sig.stop` is set when the sheet is closed. */
  work: (scope: GatherScope, report: (i: number, n: number) => void, sig: { stop: boolean }) => Promise<boolean>;
}
export type GatherAnswer = { answer: 'gather' | 'skip' | 'never' | 'cancel'; scope: GatherScope };
const iso = (x: string) => `⁨${x}⁩`;

/** The sheet: «Gather the names first?» — the scope and three actions. Closed any other way, the
 *  answer is «cancel» and nothing starts. */
export function askGather(o: GatherAsk): Promise<GatherAnswer> {
  return new Promise((resolve) => {
    let scope = o.scope; let done = false; const sig = { stop: false };
    const finish = (answer: GatherAnswer['answer']): void => { if (done) return; done = true; resolve({ answer, scope }); sh.close(); };
    const sh = openSheet(t('gatherTitle'), t('close'), { stack: true, onClose: () => { sig.stop = true; if (!done) { done = true; resolve({ answer: 'cancel', scope }); } } });
    sh.el.classList.add('gather-sheet'); sh.body.style.fontFamily = 'var(--font-ui)';
    // (Only a model on this device is told of; the service's cost is not stated.)
    const local = o.local ? h('p', { class: 'hint gather-cost' }, t('gatherUsesLocal')) : null;
    const seg = h('div', { class: 'segmented gather-scope', role: 'group', 'aria-label': t('gatherScopeLabel') });
    const opts: [GatherScope, string][] = [['chapter', o.chapters === 'many' ? t('gatherTheseChapters') : t('gatherThisChapter')], ['book', t('gatherWholeBook')]];
    const paintSeg = (): void => { seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.scope === scope))); };
    for (const [k, l] of opts) seg.append(h('button', { type: 'button', dataset: { scope: k }, 'aria-pressed': String(k === scope), onclick: () => { scope = k; paintSeg(); } }, l));
    // (Gathering: the sheet shows its progress; failed, it says so in one line and offers «Translate without».)
    const gather = async (): Promise<void> => {
      const line = h('span', null, t('gatherWorking'));
      sh.body.replaceChildren(h('p', { class: 'gather-working', role: 'status' }, h('span', { class: 'spinner', style: { width: '18px', height: '18px' } }), ' ', line));
      sh.actions.replaceChildren();
      let ok = false; try { ok = await o.work(scope, (i, n) => { if (n > 1) line.textContent = `${t('gatherWorking')} ${i}/${n}`; }, sig); } catch { ok = false; }
      if (done) return;
      if (ok) { finish('gather'); return; }
      sh.body.replaceChildren(h('p', { class: 'gather-failed', role: 'alert' }, t('gatherFailed')));
      sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary gather-skip', onclick: () => finish('skip') }, t('gatherSkip')));
    };
    sh.body.append(
      ...(o.volume ? [h('p', { class: 'gather-volume', role: 'status' }, t('gatherVolumeInUse', { title: iso(o.volume) }))] : []),
      ...(o.both ? [seg] : []), ...(local ? [local] : []));
    sh.actions.classList.add('gather-actions');
    const actsRow = h('div', { class: 'gather-acts-row' },
        h('button', { type: 'button', class: 'btn primary gather-go', onclick: () => void gather() }, o.volume ? t('gatherCheckVolume') : t('gatherGo')),
        h('button', { type: 'button', class: 'btn tonal gather-skip', onclick: () => finish('skip') }, t('gatherSkip')));
    sh.actions.append(actsRow,
      h('button', { type: 'button', class: 'btn text gather-never', onclick: () => finish('never') }, t('gatherNever')));
    stackWhenCramped(actsRow);
  });
}

/* ---------- the three-way choices (the AI settings, the Glossary options, the Translation tab) ---------- */
/** A label over a row of buttons of equal width, one pressed — a choice among three that fits a phone's width. */
export function threeWay<T extends string>(label: string, opts: [T, string][], value: T, set: (v: T) => void, hint?: string, cls = ''): HTMLElement {
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': label }, ...opts.map(([k, l]) => h('button', { type: 'button', dataset: { v: k }, 'aria-pressed': String(k === value), onclick: () => { seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === k))); set(k); } }, l)));
  return h('div', { class: `field tr-three ${cls}`.trim() }, h('span', { class: 'label' }, label), seg, hint ? h('span', { class: 'hint' }, hint) : null);
}
/** A switch with its label and, under it, one hint line. */
export function switchRow(label: string, on: boolean, set: (v: boolean) => void, hint?: string, cls = ''): HTMLElement {
  const cb = h('input', { type: 'checkbox', checked: on, onchange: () => set(cb.checked) }) as HTMLInputElement;
  return h('label', { class: `row tr-opt ${cls}`.trim() }, h('span', { class: 'label' }, label, hint ? h('small', { class: 'hint' }, hint) : null), h('span', { class: 'switch' }, cb, h('i')));
}
export const GATHER_OPTS = (): [GatherMode, string][] => [['ask', t('gatherModeAsk')], ['always', t('gatherModeAlways')], ['never', t('gatherModeNever')]];
export const AUTO_OPTS = (): [AutoMode, string][] => [['follow', t('autoBookFollow')], ['always', t('autoBookAlways')], ['never', t('autoBookNever')]];
