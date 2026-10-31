// Settings → Other Kurokawa apps: Kurokawa Tools opened when it is on this device, or fetched from the
// repository's `tools-v*` releases and installed from here with its progress (the APK on Android, the installer
// on Windows), the releases page elsewhere.
import { h, icon, toast } from './dom';
import { t, localDigits } from '../i18n';
import { nativePlatform } from '../native';
import { fetchLatestOf, suitableAsset, installAsset, fmtMB, REPO, type Progress } from '../updates';

const TOOLS_PKG = 'app.kurokawa.tools';
type Kr = { isInstalled?(o: { pkg: string }): Promise<{ installed: boolean }>; launch?(o: { pkg: string }): Promise<void> };
const kr = (): Kr | null => ((window.Capacitor as { Plugins?: { Kurokawa?: Kr } } | undefined)?.Plugins?.Kurokawa ?? null);

export function otherAppsCard(): HTMLElement {
  const actions = h('div', { class: 'app-actions' }, h('div', { class: 'spinner small' }));
  const card = h('section', { class: 'card' }, h('h3', null, t('otherApps')), h('p', null, t('otherAppsHint')),
    h('div', { class: 'app-row' }, h('div', { class: 'app-icon-box' }, icon('download')), h('div', { class: 'grow' }, h('b', null, t('appTools')), h('small', { class: 'hint' }, t('appToolsDesc'))), actions));
  void (async () => {
    const platform = nativePlatform(); const releases = `https://github.com/${REPO}/releases`;
    if (platform === 'android') { const p = kr(); const on = (await p?.isInstalled?.({ pkg: TOOLS_PKG }).catch(() => ({ installed: false })))?.installed; if (on) { actions.replaceChildren(h('button', { type: 'button', class: 'btn small tonal', onclick: () => void p!.launch?.({ pkg: TOOLS_PKG }) }, icon('external'), t('appInstalled'))); return; } }
    if (platform === 'android' || platform === 'desktop') {
      const btn = h('button', { type: 'button', class: 'btn small primary' }, icon('download'), t('appGet')) as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        btn.disabled = true; const bar = h('div', { class: 'task-bar' }, h('i', { style: { width: '0%' } })); const line = h('small', { class: 'hint' }, t('checking'));
        actions.replaceChildren(h('div', { class: 'app-progress' }, line, bar));
        try {
          const rel = await fetchLatestOf('tools-v'); const asset = await suitableAsset(rel);
          if (!asset) { window.open(releases, '_blank', 'noopener'); actions.replaceChildren(btn); btn.disabled = false; return; }
          line.textContent = `${t('appTools')} ${rel.version} · ${fmtMB(asset.size)}`;
          await installAsset(asset, (p: Progress) => { (bar.firstChild as HTMLElement).style.width = `${p.pct}%`; line.textContent = `${t('appTools')} ${rel.version} · ${localDigits(p.pct)}%${p.speed ? ` · ${fmtMB(p.speed)}/s` : ''}`; }, undefined, () => true, true);
          toast(t('appInstallerOpened'));
        } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
        actions.replaceChildren(btn); btn.disabled = false;
      });
      actions.replaceChildren(btn); return;
    }
    actions.replaceChildren(h('a', { class: 'btn small', href: releases, target: '_blank', rel: 'noopener' }, icon('external'), t('appOpenReleases')));
  })();
  return card;
}
