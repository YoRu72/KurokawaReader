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
/** The ids made in this run of the app (a stream made one in memory); what the list holds beyond them was made before a restart. */
const thisRun = new Set<string>();
export function markMade(id: string): void { thisRun.add(id); const m = readMade(); if (!m.includes(id)) { m.push(id); writeMade(m); } }
/** Made by a stream only when both say so: this device's list (kept in step by markMade/unmark) and the marker the download carries from the moment it was created. Anything older is never touched. */
export const isMade = (id: string, x?: Task): boolean => readMade().includes(id) && (!x || (x.meta as { streamMade?: boolean } | undefined)?.streamMade === true);
export function unmark(id: string): void { const m = readMade(); if (m.includes(id)) writeMade(m.filter((x) => x !== id)); }

/** The episodes streamed in this sitting (the player left, or going on to the next episode). */
const sitting = new Set<string>();
let asking = false;
/** A streamed episode is being left. `continues`: another player opens at once (the next episode), so nothing is asked yet. */
export function left(task: Task | undefined, continues: boolean): void {
  if (task && isMade(task.id, task)) sitting.add(task.id);
  if (!continues && (sitting.size || readMade().some((id) => !thisRun.has(id)))) void ask();
}
async function drop(ids: string[]): Promise<void> { for (const id of ids) { try { await getEngine().remove(id, true); } catch { /* gone already */ } unmark(id); } }
async function ask(): Promise<void> {
  if (asking) return; asking = true;
  try {
    const ids = [...sitting]; sitting.clear();
    // (Made by a stream before the app was closed and never settled — it carries the marker still: asked about now, with no data or some, never removed unasked.)
    const older = readMade().filter((id) => !thisRun.has(id) && !ids.includes(id));
    // (The list not to be had: nothing is decided and no marker lost; the question comes at the next leaving.)
    let all: Task[]; try { all = await getEngine().list(); } catch { for (const id of ids) sitting.add(id); return; }
    const orphans = older.map((id) => all.find((x) => x.id === id)).filter((x): x is Task => !!x && isMade(x.id, x));
    for (const id of older) if (!orphans.some((x) => x.id === id)) unmark(id);
    const mine = ids.map((id) => all.find((x) => x.id === id)).filter((x): x is Task => !!x && isMade(x.id, x));
    const tasks = [...mine.filter((x) => (x.done ?? 0) > 0), ...orphans];
    // (A stream that never got data leaves nothing worth asking about: what it made is removed quietly.)
    const empty = mine.filter((x) => !tasks.includes(x)).map((x) => x.id); if (empty.length) await drop(empty);
    for (const id of ids) if (!mine.some((x) => x.id === id)) unmark(id);
    if (!tasks.length) return;
    const mode = getSettings().streamKeep ?? 'ask';
    // (One left over from before a restart is never settled by a remembered choice: it is asked about, whatever the choice.)
    const own = tasks.filter((x) => !orphans.includes(x));
    if (mode === 'keep') { for (const x of own) unmark(x.id); if (!orphans.length) return; await sheet(orphans); return; }
    if (mode === 'delete') { if (own.length) { await drop(own.map((x) => x.id)); toast(t('keepDeleted')); } if (orphans.length) await sheet(orphans); return; }
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
