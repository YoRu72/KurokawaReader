// This app's updates: its releases are the tools-v* ones of the repository. Checked at start and every few hours
// while the app stays open (as often as the setting says); offered in a sheet that lists what is new in every
// version since the one running, the file for this device with its size, and one button that fetches it (shown
// as it comes: speed, time left, connections; tried again when the connection drops; checked against GitHub's
// SHA-256) and opens the installer — or, when chosen, fetched by itself in the background and offered ready.
// After an update, the first start says so, with what changed.
import { h, icon, openSheet, toast } from './ui/dom';
import { t, dateLocale, formatBytes, localDigits, countConnections, countVersions } from './i18n';
import { getSettings, updateSettings } from './settings';
import { APP_VERSION, TAG_PREFIX, REPO } from './repo';
import { releasesOf, suitableAsset, fetchAndInstall, keptDownload, downloadRunning, cmpVersion, installVia, setInstallVia, type Release, type Progress } from './installer';
import { newerThan, whatsNew, versionChange, sha256Of } from './updateCore';
import { openExternal, nativePlatform } from './native';

const LAST = 'kt.update.lastCheck';
export const lastChecked = (): number => Number(localStorage.getItem(LAST) ?? 0);
/** The releases since this build, newest first (their notes shown together). */
let since: Release[] = [];

export async function checkForUpdate(ignoreSkipped = false): Promise<Release | null> {
  const all = await releasesOf(TAG_PREFIX, getSettings().updateChannel === 'beta');
  localStorage.setItem(LAST, String(Date.now()));
  since = newerThan(all, APP_VERSION); const rel = since[0];
  if (!rel) return null;
  if (!ignoreSkipped && localStorage.getItem('kt.update.skip') === rel.version) return null;
  return rel;
}
const everyMs = (): number => { const e = getSettings().updateEvery ?? 'launch'; return e === 'weekly' ? 7 * 86400000 : e === 'daily' ? 86400000 : 30 * 60000; };
let timer = 0;
export function scheduleAutoCheck(): void {
  window.clearInterval(timer);
  const run = (delay: number) => {
    const s = getSettings();
    if (!s.autoUpdateCheck || !navigator.onLine || Date.now() - lastChecked() < everyMs()) return;
    setTimeout(() => { checkForUpdate().then((rel) => { if (rel) void arrived(rel); }).catch(() => undefined); }, delay);
  };
  run(3000);
  // (The app left open for days: looked at again every six hours.)
  timer = window.setInterval(() => run(0), 6 * 3600000);
  afterUpdate();
}
/** A new version found: offered — or, with background fetching on (Android), fetched first and offered ready. */
async function arrived(rel: Release): Promise<void> {
  if (getSettings().updateAutoDownload && nativePlatform() === 'android') {
    const a = await suitableAsset(rel).catch(() => undefined);
    if (a) { try { await fetchAndInstall(a, () => undefined, undefined, { fetchOnly: true }); offerUpdate(rel, true); return; } catch { /* offered as usual */ } }
  }
  offerUpdate(rel, false);
}
function offerUpdate(rel: Release, ready: boolean): void {
  document.querySelector('.update-toast')?.remove();
  const el = h('div', { class: 'toast update-toast', role: 'status' }, h('span', null, ready ? t('updateFetchedShort', { v: rel.version }) : t('updateAvailableShort', { v: rel.version })),
    h('button', { type: 'button', class: 'btn small primary', onclick: () => { el.remove(); showUpdateSheet(rel); } }, icon(ready ? 'check' : 'download'), ready ? t('installNow') : t('updateNow')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: () => el.remove() }, icon('close')));
  document.body.appendChild(el); setTimeout(() => el.remove(), ready ? 60000 : 20000);
}
/** The first start after an update: said once, with the notes of the versions it brought. */
function afterUpdate(): void {
  const before = versionChange('kt.update.ran', APP_VERSION); if (!before) return;
  localStorage.removeItem('kt.update.file');
  setTimeout(() => {
    const el = h('div', { class: 'toast update-toast', role: 'status' }, h('span', null, t('updatedTo', { v: APP_VERSION })),
      h('button', { type: 'button', class: 'btn small tonal', onclick: async () => { el.remove(); try { const all = await releasesOf(TAG_PREFIX, true); const got = all.filter((r) => cmpVersion(r.version, before) > 0 && cmpVersion(r.version, APP_VERSION) <= 0); notesSheet(t('whatsNewIn', { v: APP_VERSION }), got); } catch { toast(t('updateFailed'), 'error'); } } }, icon('info'), t('whatsNew')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: () => el.remove() }, icon('close')));
    document.body.appendChild(el); setTimeout(() => el.remove(), 20000);
  }, 1500);
}
/** What a release's notes say, as plain lines (the Markdown's headings and tables left out). */
export function notesText(md: string): string {
  return md.split('\n').filter((l) => !/^\s*(#|\||_`latest)/.test(l) && !/^## Files/.test(l)).map((l) => l.replace(/\*\*/g, '').replace(/^- /, '• ')).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}
/** The notes of several versions, each under its number (the newest open, the others folded). */
function versionNotes(list: Release[]): HTMLElement {
  return h('div', { class: 'upd-versions' }, ...list.slice(0, 15).map((r, i) => {
    const items = whatsNew(r.notes);
    const body = items.length ? h('ul', { class: 'upd-notes' }, ...items.map((l) => h('li', { dir: 'auto' }, l))) : h('pre', { class: 'release-notes', dir: 'auto' }, notesText(r.notes));
    const d = h('details', { class: 'upd-version', open: i === 0 }, h('summary', null, h('b', { dir: 'ltr' }, r.version), r.publishedAt ? h('small', { class: 'src' }, new Date(r.publishedAt).toLocaleDateString(dateLocale())) : null), body);
    return d;
  }));
}
function notesSheet(title: string, list: Release[]): void { const sh = openSheet(title, t('close')); sh.body.append(list.length ? versionNotes(list) : h('p', { class: 'src' }, t('noNotes'))); }

const shortTime = (sec: number) => (sec < 60 ? t('secShort', { n: localDigits(Math.max(1, Math.round(sec))) }) : t('minShort', { n: localDigits(Math.round(sec / 60)) }));
export function showUpdateSheet(rel: Release): void {
  const sh = openSheet(cmpVersion(rel.version, APP_VERSION) > 0 ? t('updateAvailable', { v: rel.version }) : t('updateLatestIs', { v: rel.version }), t('close')); sh.el.classList.add('update-sheet');
  const list = since.length && since[0].version === rel.version ? since : [rel];
  sh.body.append(h('div', { class: 'upd-head' }, h('span', { class: 'upd-chip', dir: 'ltr' }, APP_VERSION), h('span', { class: 'upd-arrow' }, icon('arrowRight')), h('span', { class: 'upd-chip new', dir: 'ltr' }, rel.version),
    list.length > 1 ? h('small', { class: 'src' }, t('updateVersionsSince', { n: countVersions(list.length) })) : null),
    h('h4', null, t('whatsNew')), versionNotes(list));
  const fileLine = h('p', { class: 'src upd-file', dir: 'auto' });
  const status = h('p', { class: 'src', 'aria-live': 'polite' });
  const bar = h('div', { class: 'task-bar' }, h('i')); bar.hidden = true;
  // (Android: the app's own installer or Android's, chosen here and remembered.)
  const viaBox = nativePlatform() === 'android' ? h('div', { class: 'row upd-via' }, h('span', null, t('updInstallWith'), h('small', { class: 'src' }, t('updInstallWithHint'))),
    h('div', { class: 'segmented', role: 'radiogroup' }, ...(['app', 'system'] as const).map((v) => h('button', { type: 'button', role: 'radio', 'data-v': v, 'aria-checked': String(installVia() === v), 'aria-pressed': String(installVia() === v), class: installVia() === v ? 'on' : '', onclick: (e: Event) => { setInstallVia(v); (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-pressed', String(on)); }); toast(v === 'app' ? t('updViaAppSet') : t('updViaSystemSet')); } }, v === 'app' ? t('updViaApp') : t('updViaSystem'))))) : null;
  sh.body.append(...(viaBox ? [viaBox] : []), fileLine, bar, status);
  let asset: Awaited<ReturnType<typeof suitableAsset>>; let ctl: AbortController | null = null;
  const setBar = (pct: number, indet = false) => { bar.hidden = false; bar.classList.toggle('indet', indet); (bar.firstChild as HTMLElement).style.width = `${pct}%`; };
  const onProgress = (p: Progress) => {
    if (!sh.el.isConnected) return;
    if (p.phase === 'verify') { setBar(100, true); status.textContent = t('updateVerifying'); return; }
    if (p.phase === 'install') { setBar(100); status.textContent = t('updateOpeningInstaller'); return; }
    if (p.phase === 'retry') { setBar(p.pct, true); status.textContent = t('updateRetrying', { n: localDigits(p.attempt ?? 2) }); return; }
    setBar(p.pct, !p.total);
    const parts = [p.total ? `${localDigits(p.pct)}${getLangPct()}` : '', p.total ? `${formatBytes(p.got)} / ${formatBytes(p.total)}` : formatBytes(p.got), p.speed ? t('perSecond', { n: formatBytes(p.speed) }) : '', p.speed && p.total > p.got ? t('timeLeft', { t: shortTime((p.total - p.got) / p.speed) }) : '', p.connections && p.connections > 1 ? countConnections(p.connections) : ''];
    status.textContent = parts.filter(Boolean).map((x) => `⁨${x}⁩`).join(' · ');
  };
  const go = h('button', { type: 'button', class: 'btn primary' }, icon('download'), cmpVersion(rel.version, APP_VERSION) > 0 ? t('downloadInstall') : t('updateReinstall')) as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn tonal', hidden: true, onclick: () => ctl?.abort() }, t('cancel')) as HTMLButtonElement;
  const later = h('button', { type: 'button', class: 'btn text', onclick: () => sh.close() }, t('later'));
  const skip = h('button', { type: 'button', class: 'btn text', onclick: () => { localStorage.setItem('kt.update.skip', rel.version); sh.close(); toast(t('versionSkipped', { v: rel.version })); } }, t('skipVersion'));
  void suitableAsset(rel).then(async (a) => {
    asset = a;
    fileLine.replaceChildren(icon('file'), h('span', { dir: 'ltr' }, a ? a.name : t('noFileForPlatform')), ...(a?.size ? [h('b', null, ` · ${formatBytes(a.size)}`)] : []), ...(a && sha256Of(a) ? [h('small', { class: 'src' }, ` · ${t('updateChecked')}`)] : []));
    if (!a) return;
    if (await keptDownload(a)) { status.textContent = t('updateAlreadyDownloaded'); go.replaceChildren(icon('check'), t('installNow')); }
    else if (downloadRunning(a.name)) go.click();
  });
  go.addEventListener('click', async () => {
    if (!asset) { await openExternal(rel.url); sh.close(); return; }
    go.hidden = true; later.hidden = true; skip.hidden = true; cancel.hidden = false; ctl = new AbortController(); setBar(0, true); status.textContent = t('preparing');
    try {
      const r = await fetchAndInstall(asset, onProgress, ctl.signal, { onPermission: () => { status.textContent = t('allowInstallHint'); } });
      if (r === 'opened') sh.close(); else { setBar(100); status.textContent = t('installStarted'); }
    } catch (e) {
      const err = e as Error & { code?: string };
      bar.hidden = true;
      status.textContent = err.name === 'AbortError' ? t('cancelled') : err.code === 'damaged' ? t('updateDamaged') : err.code === 'permission' ? t('installNotAllowed') : t('installFailed', { error: String(err.message ?? err) });
      go.hidden = false; go.replaceChildren(icon('refresh'), t('tryAgain'));
    } finally { cancel.hidden = true; later.hidden = false; skip.hidden = false; ctl = null; }
  });
  sh.actions.classList.add('upd-actions');
  sh.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => void openExternal(rel.url) }, icon('external'), t('openReleasePage')), skip, later, cancel, go);
}
const getLangPct = () => (document.documentElement.lang === 'ar' ? '٪' : '%');

/** The Updates card's rows: the version, a check now, how often, the channel, fetching in the background. */
export function updateRows(row: (label: string, control: Node, hint?: string) => HTMLElement, toggle: (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => HTMLElement, pick: (label: string, opts: [string, string][], value: string, set: (v: string) => void) => HTMLElement): HTMLElement[] {
  const s = getSettings();
  const status = h('p', { class: 'src' }, lastChecked() ? t('lastChecked', { d: new Date(lastChecked()).toLocaleString(dateLocale()) }) : '');
  const check = h('button', { type: 'button', class: 'btn tonal small', onclick: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true; status.textContent = t('checking');
    try { const rel = await checkForUpdate(true); if (rel) { showUpdateSheet(rel); status.textContent = t('updateAvailable', { v: rel.version }); } else status.textContent = t('upToDate'); }
    catch (er) { status.textContent = /rate/.test(String((er as Error).message)) ? t('updateRateLimited') : navigator.onLine ? t('updateFailed') : t('updateOffline'); }
    b.disabled = false;
  } }, icon('refresh'), t('checkUpdates'));
  // (When the automatic check misses — a cached feed, a skipped version, a rate limit — the newest release is
  // fetched straight from GitHub and offered, even the one already running, to install again.)
  const latest = h('button', { type: 'button', class: 'btn text small', onclick: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true; status.textContent = t('checking');
    try { localStorage.removeItem('kt.update.skip'); const all = await releasesOf(TAG_PREFIX, getSettings().updateChannel === 'beta'); const rel = all[0]; if (!rel) { status.textContent = t('updateFailed'); } else { since = newerThan(all, APP_VERSION); showUpdateSheet(rel); status.textContent = cmpVersion(rel.version, APP_VERSION) > 0 ? t('updateAvailable', { v: rel.version }) : t('updateLatestIs', { v: rel.version }); } }
    catch (er) { status.textContent = /rate/.test(String((er as Error).message)) ? t('updateRateLimited') : navigator.onLine ? t('updateFailed') : t('updateOffline'); }
    b.disabled = false;
  } }, icon('download'), t('updateGetLatest'));
  const page = h('button', { type: 'button', class: 'btn text small', onclick: () => void openExternal(`https://github.com/${REPO}/releases`) }, icon('external'), t('updateReleasesPage'));
  return [row(t('version', { v: APP_VERSION }), check), h('div', { class: 'row-actions' }, latest, page), h('p', { class: 'hint' }, t('updateGetLatestHint')),
    toggle(t('autoCheck'), s.autoUpdateCheck, (v) => { updateSettings({ autoUpdateCheck: v }); scheduleAutoCheck(); }),
    pick(t('updateEvery'), [['launch', t('everyLaunch')], ['daily', t('everyDay')], ['weekly', t('everyWeek')]], s.updateEvery ?? 'launch', (v) => updateSettings({ updateEvery: v as 'launch' })),
    ...(nativePlatform() === 'android' ? [pick(t('updInstallWith'), [['app', t('updViaApp')], ['system', t('updViaSystem')]], installVia(), (v) => setInstallVia(v as 'app' | 'system'))] : []),
    ...(nativePlatform() === 'android' ? [toggle(t('updateAutoDownload'), !!s.updateAutoDownload, (v) => updateSettings({ updateAutoDownload: v }), t('updateAutoDownloadHint'))] : []),
    h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: async () => { try { const all = await releasesOf(TAG_PREFIX, true); notesSheet(t('releaseHistory'), all.filter((r) => cmpVersion(r.version, APP_VERSION) <= 0).slice(0, 15)); } catch { toast(t('updateFailed'), 'error'); } } }, icon('list'), t('releaseHistory'))),
    status];
}
