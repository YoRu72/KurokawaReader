// This app's updates: its releases are the tools-v* ones of the repository; checked at start (when the setting
// says so), offered in a sheet, fetched and installed through installer.ts.
import { h, icon, openSheet, toast } from './ui/dom';
import { t, dateLocale, formatBytes, localDigits, countConnections } from './i18n';
import { getSettings } from './settings';
import { APP_VERSION, TAG_PREFIX } from './repo';
import { latestRelease, suitableAsset, fetchAndInstall, cmpVersion, type Release, type Progress } from './installer';
import { openExternal } from './native';

const LAST = 'kt.update.lastCheck';
export const lastChecked = (): number => Number(localStorage.getItem(LAST) ?? 0);

export async function checkForUpdate(ignoreSkipped = false): Promise<Release | null> {
  const rel = await latestRelease(TAG_PREFIX, getSettings().updateChannel === 'beta');
  localStorage.setItem(LAST, String(Date.now()));
  if (!rel || cmpVersion(rel.version, APP_VERSION) <= 0) return null;
  if (!ignoreSkipped && localStorage.getItem('kt.update.skip') === rel.version) return null;
  return rel;
}
export function scheduleAutoCheck(): void {
  const s = getSettings();
  if (!s.autoUpdateCheck || !navigator.onLine || Date.now() - lastChecked() < 30 * 60 * 1000) return;
  setTimeout(() => { checkForUpdate().then((rel) => { if (rel) offerUpdate(rel); }).catch(() => undefined); }, 3000);
}
function offerUpdate(rel: Release): void {
  const el = h('div', { class: 'toast update-toast', role: 'status' }, h('span', null, t('updateAvailableShort', { v: rel.version })),
    h('button', { type: 'button', class: 'btn small primary', onclick: () => { el.remove(); showUpdateSheet(rel); } }, icon('download'), t('updateNow')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: () => el.remove() }, icon('close')));
  document.body.appendChild(el); setTimeout(() => el.remove(), 15000);
}
/** What a release's notes say, as plain lines (the Markdown's headings and tables left out). */
export function notesText(md: string): string {
  return md.split('\n').filter((l) => !/^\s*(#|\||_`latest)/.test(l) && !/^## Files/.test(l)).map((l) => l.replace(/\*\*/g, '').replace(/^- /, '• ')).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}
export function showUpdateSheet(rel: Release): void {
  const sh = openSheet(t('updateAvailable', { v: rel.version }), t('close'));
  const notes = h('pre', { class: 'release-notes', dir: 'auto' }, notesText(rel.notes));
  const status = h('p', { class: 'src' });
  const bar = h('div', { class: 'task-bar' }, h('i')); bar.hidden = true;
  sh.body.append(h('p', { class: 'src' }, rel.publishedAt ? new Date(rel.publishedAt).toLocaleDateString(dateLocale()) : ''), h('h4', null, t('whatsNew')), notes, bar, status);
  const go = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('downloadInstall')) as HTMLButtonElement;
  go.addEventListener('click', async () => {
    go.disabled = true; bar.hidden = false;
    try {
      const asset = await suitableAsset(rel);
      if (!asset) { await openExternal(rel.url); sh.close(); return; }
      const r = await fetchAndInstall(asset, (p: Progress) => { (bar.firstChild as HTMLElement).style.width = `${p.pct}%`; status.textContent = `${t('downloading', { p: localDigits(p.pct) })} · ${formatBytes(p.got)} / ${formatBytes(p.total)}${p.speed ? ` · ${t('perSecond', { n: formatBytes(p.speed) })}` : ''}${p.connections && p.connections > 1 ? ` · ${countConnections(p.connections)}` : ''}`; });
      toast(r === 'installing' ? t('installStarted') : t('openReleasePage')); sh.close();
    } catch (e) { status.textContent = t('installFailed', { error: String((e as Error).message ?? e) }); go.disabled = false; }
  });
  sh.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => void openExternal(rel.url) }, icon('external'), t('openReleasePage')), h('button', { type: 'button', class: 'btn text', onclick: () => { localStorage.setItem('kt.update.skip', rel.version); sh.close(); } }, t('later')), go);
}
