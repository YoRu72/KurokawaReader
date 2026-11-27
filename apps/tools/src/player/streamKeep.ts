// What becomes of an episode that was only downloaded to be watched now (a stream): when the player is left, a small
// question — keep it or delete it from the cache — unless a choice was remembered (Settings → Streaming). Only a
// download the stream itself made is asked about, never a finished download the user started on purpose, and never one
// that got no data. Several episodes streamed in one sitting (the next one playing on) are asked about once, at the end.
import { h, openSheet, toast } from '../ui/dom';
import { t, formatBytes } from '../i18n';
import { getEngine } from '../engine';
import { getSettings, updateSettings } from '../settings';
import type { Task } from '../engine/types';

const MADE = 'kt.stream.made';
const readMade = (): string[] => { try { const v = JSON.parse(localStorage.getItem(MADE) ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : []; } catch { return []; } };
const writeMade = (ids: string[]) => { try { localStorage.setItem(MADE, JSON.stringify(ids.slice(-200))); } catch { /* full */ } };
/** A download made for a stream (not one the user started): the question may be asked about it. */
export function markMade(id: string): void { const m = readMade(); if (!m.includes(id)) { m.push(id); writeMade(m); } }
export const isMade = (id: string): boolean => readMade().includes(id);
export function unmark(id: string): void { const m = readMade(); if (m.includes(id)) writeMade(m.filter((x) => x !== id)); }

/** The episodes streamed in this sitting (the player left, or going on to the next episode). */
const sitting = new Set<string>();
let asking = false;
/** A streamed episode is being left. `continues`: another player opens at once (the next episode), so nothing is asked yet. */
export function left(task: Task | undefined, continues: boolean): void {
  if (task && isMade(task.id)) sitting.add(task.id);
  if (!continues && sitting.size) void ask();
}
async function drop(ids: string[]): Promise<void> { for (const id of ids) { try { await getEngine().remove(id, true); } catch { /* gone already */ } unmark(id); } }
async function ask(): Promise<void> {
  if (asking) return; asking = true;
  try {
    const ids = [...sitting]; sitting.clear();
    let all: Task[] = []; try { all = await getEngine().list(); } catch { /* none */ }
    const tasks = ids.map((id) => all.find((x) => x.id === id)).filter((x): x is Task => !!x && (x.done ?? 0) > 0);
    // (A stream that never got data leaves nothing worth asking about: what it made is removed quietly.)
    const empty = ids.filter((id) => all.some((x) => x.id === id) && !tasks.some((x) => x.id === id)); if (empty.length) await drop(empty);
    for (const id of ids) if (!all.some((x) => x.id === id)) unmark(id);
    if (!tasks.length) return;
    const mode = getSettings().streamKeep ?? 'ask';
    if (mode === 'keep') { for (const x of tasks) unmark(x.id); return; }
    if (mode === 'delete') { await drop(tasks.map((x) => x.id)); toast(t('keepDeleted')); return; }
    await sheet(tasks);
  } finally { asking = false; }
}
/** The question: one episode (two equal buttons and «Remember my choice» as a switch), or a list with a switch each. */
function sheet(tasks: Task[]): Promise<void> {
  return new Promise((done) => {
    const many = tasks.length > 1; const keepIt = new Map<string, boolean>(tasks.map((x) => [x.id, true]));
    let remember = false; let finished = false;
    const sh = openSheet(many ? t('keepEpisodesTitle') : t('keepEpisodeTitle'), t('close'), { stack: true, onClose: () => { if (!finished) { finished = true; for (const x of tasks) unmark(x.id); done(); } } });
    sh.el.classList.add('kt-keep');
    const finish = async (choice: 'keep' | 'delete' | 'each') => {
      if (finished) return; finished = true;
      if (remember && choice !== 'each') updateSettings({ streamKeep: choice });
      const del = choice === 'delete' ? tasks.map((x) => x.id) : choice === 'each' ? tasks.filter((x) => !keepIt.get(x.id)).map((x) => x.id) : [];
      for (const x of tasks) if (!del.includes(x.id)) unmark(x.id);
      sh.close(); if (del.length) { await drop(del); toast(t('keepDeleted')); }
      done();
    };
    sh.body.append(h('p', { class: 'hint' }, t('keepEpisodeHint')));
    if (many) {
      sh.body.append(h('div', { class: 'kt-keep-list' }, ...tasks.map((x) => h('label', { class: 'row switch-row kt-keep-row' }, h('span', { class: 'grow' }, h('span', { class: 'kt-keep-name', dir: 'auto' }, x.name || ''), h('small', { class: 'src' }, formatBytes(x.done ?? 0))), h('span', { class: 'kt-keep-word' }, t('keepEpisodeKeep')),
        h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => keepIt.set(x.id, (e.target as HTMLInputElement).checked) })))));
      sh.body.append(h('div', { class: 'kt-keep-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => void finish('each') }, t('done'))));
    } else {
      const rem = h('input', { type: 'checkbox', onchange: (e: Event) => { remember = (e.target as HTMLInputElement).checked; } });
      sh.body.append(h('p', { class: 'kt-keep-name one', dir: 'auto' }, tasks[0].name || ''), h('label', { class: 'row switch-row' }, h('span', null, t('keepRemember')), rem),
        h('div', { class: 'kt-keep-actions' }, h('button', { type: 'button', class: 'btn tonal', onclick: () => void finish('keep') }, t('keepEpisodeKeep')), h('button', { type: 'button', class: 'btn tonal danger', onclick: () => void finish('delete') }, t('keepEpisodeDelete'))));
    }
  });
}
