// One download's page, laid out as Prism's details window: the file and its address (copied with a tap) with its
// state, the meter (the percentage large, done of the whole, speed, time left, connections), the file map, then
// the connections at work beside the speed chart (Now · Average · Peak · Time left); its files (each to download,
// skip or put first), Info, the log; and what can be done with it.
import { swarmCard } from './swarm';
import { filesCard, type FilesCard } from './taskFiles';
import { canArchive, isArchiveName } from '../archives';
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { ktPlugin, nativePlatform } from '../native';
import { getSettings } from '../settings';
import { t, localDigits } from '../i18n';
import { liveLine } from '../downloads/live';
import { getEngine, displayName, isVideo, mainFilePath } from '../engine';
import { trailOf, autoRelinkOn, setAutoRelink, expired, replayTrail } from '../downloads/relink';
import type { Task } from '../engine/types';
import { back, navigate } from '../router';
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
    // (A file download's own speed limit, in KB/s; 0 lifts it. The engine's global limit still caps everything.)
    const limitRow = x.kind === 'http' && eng.setTaskLimits && x.state !== 'done' ? h('label', { class: 'field row task-limit' }, h('span', { class: 'label' }, t('taskSpeedLimit')), h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(Math.round(((x as Task & { limitDown?: number }).limitDown ?? 0) / 1024)), placeholder: '0', onchange: (e: Event) => void eng.setTaskLimits!(x.id, Math.max(0, Number((e.target as HTMLInputElement).value) || 0) * 1024, 0).then(() => toast(t('done'))).catch(() => undefined) })) : null;
    const hlsLine = (x.meta?.hls || x.kind === 'video') && (x.state === 'downloading' || x.state === 'metadata') ? h('p', { class: 'src' }, icon('film'), ' ', liveLine(x)) : null;
    const acts = h('div', { class: 'task-detail-actions' });
    if (x.state === 'paused' || x.state === 'failed') acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void eng.resume(x.id) }, icon('play'), t('resume')));
    if (x.state !== 'done') acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('../downloads/rules').then((m) => m.clockSheet(x)) }, icon('clock'), t('clockTitle')));
    else if (x.state !== 'done' && eng.can.pause) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void eng.pause(x.id) }, icon('pause'), t('pause')));
    // What the main file is decides the first button: a video or a sound plays in the app, an app installs, an
    // archive opens inside, anything else goes to the system's viewer; «Open with…» offers every app; «Show in
    // folder» shows the folder itself — never a file picker.
    const video = x.files.find((f) => isVideo(f.path) && f.priority > 0) ?? (isVideo(name) ? { index: 0, path: name } : undefined);
    const audio = !video && /\.(mp3|m4a|flac|ogg|opus|wav|aac)$/i.test(x.files.find((f) => f.priority > 0)?.path ?? name);
    const mainPath = mainFilePath(x);
    const isApk = /\.(apk|apks|xapk|apkm)$/i.test(mainPath || name);
    const ready = x.readyFile !== undefined && x.readyFile >= 0;
    if (video && (eng.streamUrl || x.state === 'done')) acts.append(h('button', { type: 'button', class: x.state === 'done' || ready ? 'btn primary' : 'btn tonal', onclick: () => void import('./player').then((m) => m.playTaskFile(x, ready ? x.readyFile! : video.index)).catch((e) => toast(String(e.message ?? e), 'error')) }, icon('play'), t(x.state === 'done' ? 'play' : ready ? 'readyToPlay' : 'stream')));
    if (x.state === 'done' && eng.open) {
      if (audio && mainPath) acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void import('./player').then((m) => m.playTaskFile(x, x.files[0]?.index ?? 0)).catch((e) => toast(String(e.message ?? e), 'error')) }, icon('play'), t('play')));
      else if (isApk && nativePlatform() === 'android' && mainPath) acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void import('./apk').then((m) => m.installSheet(mainPath)) }, icon('apps'), t('install')));
      else if (!video) acts.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void eng.open!(x.id).catch((e) => toast(String((e as Error).message ?? e) === 'notFound' ? t('fileGone') : String((e as Error).message ?? e), 'error')) }, icon('external'), t('open')));
      if (nativePlatform() === 'android' && mainPath) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void (ktPlugin() as unknown as { openChooser?(o: { path: string; title: string }): Promise<void> } | null)?.openChooser?.({ path: mainPath, title: name }).catch((e) => toast(String((e as Error).message ?? e) === 'notFound' ? t('fileGone') : String((e as Error).message ?? e), 'error')) }, icon('external'), t('openWith')));
      acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('./folder').then((m) => m.showInFolder(x)) }, icon('folder'), t('showInFolder')));
    }
    // (Renamed — the extension too — once it is here: the file on disk follows.)
    if (x.state === 'done' && eng.rename) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('./folder').then((m) => m.renameSheet(x)) }, icon('pen'), t('rename')));
    if (x.state === 'done' && x.dir && !x.dir.startsWith('content:') && x.kind !== 'torrent') {
      const fp = `${x.dir.replace(/[\\/]$/, '')}/${name}`;
      acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('../downloads/prism').then((m) => m.verifySheet(fp)) }, icon('check'), t('verifyTitle')));
      void import('./convert').then((m) => { if (m.canConvert() && m.kindOf(name)) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void m.convertSheet(fp, 'convert') }, icon('convert'), t('convertTitle')), h('button', { type: 'button', class: 'btn tonal', onclick: () => void m.convertSheet(fp, 'shrink') }, icon('archive'), t('shrinkTitle'))); });
    }
    if (x.state === 'done' && x.kind !== 'torrent' && x.dir && !x.dir.startsWith('content:') && isArchiveName(name) && canArchive()) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('./archiveBrowse').then((m) => m.browseArchive(`${x.dir.replace(/[\\/]$/, '')}/${name}`)) }, icon('folder'), t('archiveBrowse')));
    // (Shared to another app — Android's share sheet —, the page it came from opened again, a note of one's own.)
    if (x.state === 'done' && mainPath) void import('../ui/shareMany').then((m) => { if (m.canShareFiles()) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void m.shareFiles([mainPath]).catch((e) => toast(String((e as Error).message ?? e), 'error')) }, icon('share'), t('share'))); });
    if (x.state === 'done' && x.dir && !x.dir.startsWith('content:')) void import('../downloads/wifishare').then((m) => { if (m.canShareWifi()) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void m.shareWifiSheet([x]) }, icon('wifi'), t('wifiShare'))); });
    { const ref = x.source.headers?.Referer ?? x.source.headers?.referer; if (ref && /^https?:/.test(ref)) acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('../browser').then((m) => m.openBrowser(ref)) }, icon('globe'), t('openSourcePage'))); }
    acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('../downloads/extras').then((m) => { const sh = openSheet(t('taskNote'), t('close')); const area = h('textarea', { class: 'text-input', rows: '3', dir: 'auto', value: m.noteOf(x.id), placeholder: t('taskNoteHint') }) as HTMLTextAreaElement; area.value = m.noteOf(x.id); sh.body.append(area); sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { m.setNote(x.id, area.value); sh.close(); toast(t('saved')); } }, icon('check'), t('save'))); }) }, icon('pen'), t('taskNote')));
    acts.append(h('button', { type: 'button', class: 'btn text danger', onclick: () => void import('./downloads').then((m) => m.removeSheet([x], () => back('/'))) }, icon('trash'), t('removeTask')));
    const files = x.files.length > 1 || (x.files.length === 1 && x.kind === 'torrent') ? filesEl(x) : null;
    const panel = h('section', { class: 'card kt-panel' },
      x.kind !== 'torrent' ? h('div', { class: 'kt-conn' }, h('div', { class: 'kt-ph' }, t('connectionsTitle')), lanes(x)) : null,
      speedChart(hst, x));
    body.replaceChildren(hero, h('section', { class: 'card' }, meter(x), fileMap(x) ?? h('span'), x.state === 'failed' && x.error ? h('p', { class: 'plan-note bad' }, errorText(x.error), /^HTTP (401|403|410)$/.test(x.error) && x.kind === 'http' ? h('span', { class: 'row-actions wrap expired-acts' },
        h('small', { class: 'src' }, t('errExpiredHint')),
        h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'relink', onclick: () => void import('../browser').then((m) => m.relinkFromBrowser(x)) }, icon('globe'), t('relinkBrowser')),
        h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'paste', onclick: () => void import('./downloads').then((m) => m.newUrlSheet(x)) }, icon('link'), t('newUrl'))) : x.error === 'noFolderAccess' ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('./folderAccess').then(async (m) => { if (await m.ensureFolderAccess(x.dir)) await getEngine().resume(x.id).catch(() => undefined); }) }, icon('key'), t('folderFix')) : (x.error === 'page' || isCut(x.error)) && x.source.url ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('../browser').then((m) => m.openBrowser(x.source.url!)) }, icon('globe'), t('openInBrowser')) : remedies(x)) : h('span'), hlsLine ?? h('span'), limitRow ?? h('span'), acts),
      panel, (x.kind === 'torrent' ? swarmEl() : null) ?? h('span'), files ?? h('span'), (x.kind === 'http' ? relinkCard(x) : null) ?? h('span'), h('section', { class: 'card' }, h('h3', null, t('infoTitle')), infoList(x)), (x.kind === 'video' && ktPlugin() ? commandCard(x) : null) ?? h('span'), h('section', { class: 'card' }, h('h3', null, t('logTitle')), logList(hst)));
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
/** A video download's exact yt-dlp command (its last attempt), and the reader's own arguments added to the next
 *  one — «edit and try again» (OmniGet's command record). */
function commandCard(x: Task): HTMLElement {
  const p = ktPlugin() as unknown as { videoCommand(o: { id: string }): Promise<{ command: string; extraArgs: string }>; videoExtraArgs(o: { id: string; extraArgs: string }): Promise<void> } | null;
  const pre = h('pre', { class: 'files-text cmd-text', dir: 'ltr' }, '…'); const extra = h('input', { type: 'text', dir: 'ltr', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: '--cookies-from-browser chrome  --proxy socks5://…' }) as HTMLInputElement;
  void p?.videoCommand({ id: x.id }).then((r) => { pre.textContent = r.command || t('cmdNone'); extra.value = r.extraArgs; }).catch(() => { pre.textContent = t('cmdNone'); });
  const card = h('section', { class: 'card cmd-card' }, h('h3', null, t('cmdTitle')), pre,
    h('label', { class: 'field' }, h('span', null, t('cmdExtra')), extra), h('p', { class: 'hint' }, t('cmdExtraHint')),
    h('div', { class: 'row-actions wrap' },
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => void navigator.clipboard?.writeText(pre.textContent ?? '').then(() => toast(t('copied'))) }, icon('copy'), t('copy')),
      h('button', { type: 'button', class: 'btn primary small', onclick: async () => { try { await p?.videoExtraArgs({ id: x.id, extraArgs: extra.value.trim() }); await getEngine().resume(x.id); toast(t('cmdRetrying')); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, icon('refresh'), t('cmdRetry'))));
  return card;
}
/** The rest of the failures classified, each with the one thing that mends it (OmniGet's root-cause buttons):
 *  no room → the storage analyzer or another folder; busy (429 / 5xx) → tried again after a wait; a name the
 *  network will not resolve, or an unreachable site → tried through the resolver (DoH); a cut-short file → tried again. */
function remedies(x: Task): HTMLElement | null {
  const e = x.error ?? ''; const eng = getEngine(); const again = (label: string) => h('button', { type: 'button', class: 'btn tonal small', onclick: () => void eng.resume(x.id).catch(() => undefined) }, icon('refresh'), label);
  if (/ENOSPC|No space|noSpace/i.test(e)) return h('span', { class: 'row-actions wrap' }, h('small', { class: 'src' }, t('errNoSpaceHint')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => navigate('/files') }, icon('chart'), t('filesAnalyzer')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => navigate('/settings/downloads') }, icon('folder'), t('changeFolder')));
  if (/^HTTP (429|50\d)$/.test(e)) { const wait = /429/.test(e) ? 60 : 20; const b = again(t('errRetryIn', { s: localDigits(wait) })); setTimeout(() => { if (b.isConnected) b.click(); }, wait * 1000); return h('span', { class: 'row-actions wrap' }, h('small', { class: 'src' }, t('errBusyHint')), b); }
  if (/UnknownHost|Unable to resolve|ENETUNREACH|EHOSTUNREACH|No address|timed out|Connection refused|incomplete/i.test(e)) return h('span', { class: 'row-actions wrap' }, h('small', { class: 'src' }, /incomplete/i.test(e) ? t('errIncompleteHint') : t('errNetHint')), again(t('retry')), ...(/UnknownHost|Unable to resolve|No address/i.test(e) && getSettings().doh === 'off' ? [h('button', { type: 'button', class: 'btn tonal small', onclick: () => navigate('/settings/downloads') }, icon('globe'), t('errTurnOnDoh'))] : []));
  // (A DRM-protected lecture or stream: nothing to retry; the app does not go around protection.)
  if (/DRM|drm:|SAMPLE-AES|Widevine|protected/i.test(e)) return h('span', { class: 'row-actions wrap' }, h('small', { class: 'src' }, t('errDrmHint')));
  if (/^HTTP 4(04|10)$/.test(e)) return null;
  return again(t('retry'));
}
export const errorText = (e: string): string => (e === 'page' ? t('errPage') : e === 'noFolderAccess' ? t('errNoFolderAccess') : isCut(e) ? `${e} — ${t('errCut')}` : e);

