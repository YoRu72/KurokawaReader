// One download's page, laid out as Prism's details window: the file and its address (copied with a tap) with its
// state, the meter (the percentage large, done of the whole, speed, time left, connections), the file map, then
// the connections at work beside the speed chart (Now · Average · Peak · Time left); its files (each to download,
// skip or put first), Info, the log; and what can be done with it.
import { swarmCard } from './swarm';
import { filesCard, type FilesCard } from './taskFiles';
import { canArchive, isArchiveName } from '../archives';
import { h, icon, iconButton, toast } from '../ui/dom';
import { t } from '../i18n';
import { getEngine, displayName, isVideo } from '../engine';
import { trailOf, autoRelinkOn, setAutoRelink, expired, replayTrail } from '../downloads/relink';
import type { Task } from '../engine/types';
import { back } from '../router';
import { stateLabel } from './downloads';
import { historyOf, fileMap, lanes, speedChart, logList, meter, infoList } from './taskmap';
import { categoryOf } from '../downloads/categories';

export function taskView(id: string): HTMLElement & { dispose?: () => void } {
  const eng = getEngine();
  const title = h('div', { class: 'title' }, h('span', { dir: 'auto' }, '…'));
  const body = h('div', { class: 'body task-detail' });
  const root = h('div', { class: 'view task-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/')), title), body) as HTMLElement & { dispose?: () => void };
  let task: Task | null = null; let filesOpen = true;
  const draw = () => {
    if (!task) return;
    const x = task; const name = displayName(x); const hst = historyOf(x);
    (title.firstChild as HTMLElement).textContent = name;
    const link = x.source.url ?? x.source.magnet ?? '';
    const live = x.state === 'downloading' || x.state === 'metadata';
    const hero = h('section', { class: 'card kt-hero' },
      h('span', { class: 'task-kind big' }, icon(x.kind === 'torrent' ? 'magnet' : categoryOf(name, x.kind).icon)),
      h('div', { class: 'grow' }, h('div', { class: 'kt-name', dir: 'auto' }, name),
        link ? h('div', { class: 'kt-url' }, icon('link'), h('span', { class: 'sel', dir: 'ltr' }, link), h('button', { type: 'button', class: 'kt-copy', 'aria-label': t('copyLink'), onclick: () => void navigator.clipboard?.writeText(link).then(() => toast(t('copied'))) }, icon('copy'))) : null,
        h('div', { class: 'kt-badges' }, h('span', { class: `kt-badge state-${x.state}` }, live ? h('span', { class: 'kt-live' }) : null, stateLabel(x.state)),
          x.kind !== 'torrent' && (x.segments?.length ?? 0) > 1 ? h('span', { class: 'kt-badge ok' }, icon('check'), t('badgeResumable')) : null)));
    const acts = h('div', { class: 'task-detail-actions' });
    if (x.state === 'paused' || x.state === 'failed') acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void eng.resume(x.id) }, icon('play'), t('resume')));
    else if (x.state !== 'done' && eng.can.pause) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void eng.pause(x.id) }, icon('pause'), t('pause')));
    if (x.state === 'done' && eng.open) acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void eng.open!(x.id) }, icon('external'), t('open')), h('button', { type: 'button', class: 'btn tonal', onclick: () => void eng.open!(x.id, -1) }, icon('folder'), t('openFolder')));
    const video = x.files.find((f) => isVideo(f.path) && f.priority > 0);
    if (video && (eng.streamUrl || x.state === 'done')) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('./player').then((m) => m.playTaskFile(x, video.index)).catch((e) => toast(String(e.message ?? e), 'error')) }, icon('play'), t(x.state === 'done' ? 'play' : 'stream')));
    if (x.state === 'done' && x.dir && !x.dir.startsWith('content:') && x.kind !== 'torrent') {
      const fp = `${x.dir.replace(/[\\/]$/, '')}/${name}`;
      acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('../downloads/prism').then((m) => m.verifySheet(fp)) }, icon('check'), t('verifyTitle')));
      void import('./convert').then((m) => { if (m.canConvert() && m.kindOf(name)) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void m.convertSheet(fp, 'convert') }, icon('convert'), t('convertTitle')), h('button', { type: 'button', class: 'btn tonal', onclick: () => void m.convertSheet(fp, 'shrink') }, icon('archive'), t('shrinkTitle'))); });
    }
    if (x.state === 'done' && x.kind !== 'torrent' && x.dir && !x.dir.startsWith('content:') && isArchiveName(name) && canArchive()) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('./archiveBrowse').then((m) => m.browseArchive(`${x.dir.replace(/[\\/]$/, '')}/${name}`)) }, icon('folder'), t('archiveBrowse')));
    acts.append(h('button', { type: 'button', class: 'btn text danger', onclick: () => void import('./downloads').then((m) => m.removeSheet([x], () => back('/'))) }, icon('trash'), t('removeTask')));
    const files = x.files.length > 1 || (x.files.length === 1 && x.kind === 'torrent') ? filesEl(x) : null;
    const panel = h('section', { class: 'card kt-panel' },
      x.kind !== 'torrent' ? h('div', { class: 'kt-conn' }, h('div', { class: 'kt-ph' }, t('connectionsTitle')), lanes(x)) : null,
      speedChart(hst, x));
    body.replaceChildren(hero, h('section', { class: 'card' }, meter(x), fileMap(x) ?? h('span'), x.state === 'failed' && x.error ? h('p', { class: 'plan-note bad' }, errorText(x.error), /^HTTP (401|403|410)$/.test(x.error) && x.kind === 'http' ? h('span', { class: 'row-actions wrap expired-acts' },
        h('small', { class: 'src' }, t('errExpiredHint')),
        h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'relink', onclick: () => void import('../browser').then((m) => m.relinkFromBrowser(x)) }, icon('globe'), t('relinkBrowser')),
        h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'paste', onclick: () => void import('./downloads').then((m) => m.newUrlSheet(x)) }, icon('link'), t('newUrl'))) : x.error === 'noFolderAccess' ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('./folderAccess').then(async (m) => { if (await m.ensureFolderAccess(x.dir)) await getEngine().resume(x.id).catch(() => undefined); }) }, icon('key'), t('folderFix')) : (x.error === 'page' || isCut(x.error)) && x.source.url ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('../browser').then((m) => m.openBrowser(x.source.url!)) }, icon('globe'), t('openInBrowser')) : null) : h('span'), acts),
      panel, (x.kind === 'torrent' ? swarmEl() : null) ?? h('span'), files ?? h('span'), (x.kind === 'http' ? relinkCard(x) : null) ?? h('span'), h('section', { class: 'card' }, h('h3', null, t('infoTitle')), infoList(x)), h('section', { class: 'card' }, h('h3', null, t('logTitle')), logList(hst)));
  };
  // (The files' card: made once and kept, so a search typed or a folder opened survives the redraws.)
  let filesBox: FilesCard | undefined;
  function filesEl(x: Task): HTMLElement { if (!filesBox) filesBox = filesCard(x, eng, { open: filesOpen, onToggle: (o) => { filesOpen = o; }, browse: (path) => void import('./archiveBrowse').then((m) => m.browseArchive(path)), play: (i) => void import('./player').then((m) => m.playTaskFile(task ?? x, i)).catch((er) => toast(String(er.message ?? er), 'error')) }); else filesBox.update(x); return filesBox.el; }
  // (The swarm's card: made once and kept across redraws — it refreshes itself.)
  let swarm: ReturnType<typeof swarmCard> | undefined;
  function swarmEl(): HTMLElement | null { if (swarm === undefined) swarm = swarmCard(id, eng); return swarm?.el ?? null; }
  const off = eng.onChange((ts) => { const found = ts.find((x) => x.id === id); if (!found) { if (task) back('/'); return; } task = found; draw(); });
  root.dispose = () => { off(); swarm?.dispose(); };
  return root;
}
/** A download's error in words: «page» is the site's page sent instead of the file (its check, a sign-in). */
/** A connection the server cut (as sites behind a visitor check do to apps they have not seen pass it). */
export const isCut = (e: string): boolean => /connection reset|reset by peer|closed early|unexpected end of stream|broken pipe|handshake|ssl/i.test(e);
/** «Get a new link by itself»: off by default; only for a download caught in the app's browser (its way is known). */
function relinkCard(x: Task): HTMLElement {
  const has = !!trailOf(x); const on = has && autoRelinkOn(x.id);
  const box = h('input', { type: 'checkbox', checked: on, disabled: !has, 'data-act': 'auto-relink', onchange: (e: Event) => { setAutoRelink(x.id, (e.target as HTMLInputElement).checked); if ((e.target as HTMLInputElement).checked && expired(x)) replayTrail(x); } });
  return h('section', { class: 'card relink-card' }, h('label', { class: 'row switch-row' }, h('span', null, t('autoRelink'), h('small', { class: 'src' }, has ? t('autoRelinkHint') : t('autoRelinkNoWay'))), box));
}
export const errorText = (e: string): string => (e === 'page' ? t('errPage') : e === 'noFolderAccess' ? t('errNoFolderAccess') : isCut(e) ? `${e} — ${t('errCut')}` : e);
