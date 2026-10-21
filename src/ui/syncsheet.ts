// Account & sync sheet: choose where the sync file lives, connect, sync now.
import { h, icon, openSheet, pickButton, toast } from './dom';
import { t, formatDate } from '../i18n';
import { getSettings, updateSettings, type VisualSettings } from '../settings';
import { nativePlatform } from '../native';
import { syncNow, syncConfigured, onSyncStatus, dropboxConnect, dropboxRedirectUri, disconnectSync, pickSyncFolder, type SyncResult } from '../sync';

export function syncSheet(): void {
  const s = getSettings();
  const sh = openSheet(t('sync'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const field = (label: string, control: HTMLElement, hint?: HTMLElement | string) => h('div', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  const desktop = nativePlatform() === 'desktop';
  const options: [VisualSettings['syncProvider'], string, string?][] = [['none', t('syncNone')], ['dropbox', t('syncDropbox'), 'external'], ['webdav', t('syncWebdav'), 'folder'], ...(desktop ? [['folder', t('syncFolderOpt'), 'folder'] as [VisualSettings['syncProvider'], string, string]] : [])];

  const dbxKey = h('input', { type: 'text', value: s.syncDropboxKey, dir: 'ltr', spellcheck: 'false', placeholder: 'abc123xyz', onchange: () => updateSettings({ syncDropboxKey: dbxKey.value.trim() }) }) as HTMLInputElement;
  const dbxBox = h('div', { class: 'sync-box' },
    h('p', { class: 'src' }, t('syncDropboxHelp')),
    h('code', { class: 'sync-uri', dir: 'ltr' }, dropboxRedirectUri()),
    field(t('syncDropboxKey'), dbxKey),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { class: 'btn small primary', type: 'button', onclick: () => dropboxConnect().catch((e) => toast(String((e as Error).message ?? e), 'error')) }, icon('external'), t('syncConnect')),
      s.syncDropboxRefresh ? h('button', { class: 'btn small', type: 'button', onclick: () => { disconnectSync(); sh.close(); syncSheet(); } }, t('syncDisconnect')) : null));
  const davUrl = h('input', { type: 'url', value: s.syncWebdavUrl, dir: 'ltr', spellcheck: 'false', placeholder: 'https://cloud.example.com/remote.php/dav/files/me/KurokawaReader', onchange: () => updateSettings({ syncWebdavUrl: davUrl.value.trim() }) }) as HTMLInputElement;
  const davUser = h('input', { type: 'text', value: s.syncWebdavUser, dir: 'ltr', autocomplete: 'username', onchange: () => updateSettings({ syncWebdavUser: davUser.value.trim() }) }) as HTMLInputElement;
  const davPass = h('input', { type: 'password', value: s.syncWebdavPass, dir: 'ltr', autocomplete: 'current-password', onchange: () => updateSettings({ syncWebdavPass: davPass.value }) }) as HTMLInputElement;
  const davBox = h('div', { class: 'sync-box' }, field(t('syncWebdavUrl'), davUrl), field(t('syncUser'), davUser), field(t('syncPass'), davPass));
  const folderLabel = h('code', { class: 'sync-uri', dir: 'ltr' }, s.syncFolder || '—');
  const folderBox = h('div', { class: 'sync-box' }, folderLabel, h('button', { class: 'btn small', type: 'button', onclick: async () => { await pickSyncFolder(); folderLabel.textContent = getSettings().syncFolder || '—'; } }, icon('folder'), t('syncPickFolder')));

  const showBoxes = (p: VisualSettings['syncProvider']) => { dbxBox.hidden = p !== 'dropbox'; davBox.hidden = p !== 'webdav'; folderBox.hidden = p !== 'folder'; };
  const prov = pickButton(t('syncProvider'), options, s.syncProvider, (v) => { updateSettings({ syncProvider: v }); showBoxes(v); }, t('close'));
  showBoxes(s.syncProvider);

  const auto = h('input', { type: 'checkbox', checked: s.syncAuto, onchange: () => updateSettings({ syncAuto: auto.checked }) }) as HTMLInputElement;
  const status = h('p', { class: 'src sync-status' }, s.syncLastAt ? t('syncLast', { d: formatDate(s.syncLastAt) }) : t('syncNever'));
  const syncBtn = h('button', { class: 'btn small primary', type: 'button', onclick: () => void syncNow() }, icon('rotate'), t('syncNow')) as HTMLButtonElement;
  const paint = (r: SyncResult | 'running') => {
    if (r === 'running') { status.textContent = t('syncing'); syncBtn.disabled = true; return; }
    syncBtn.disabled = false;
    status.textContent = r.ok ? t('syncDone', { n: r.changed }) : `${t('syncFailed')} — ${r.error ?? ''}`;
  };
  const off = onSyncStatus(paint);
  const obs = new MutationObserver(() => { if (!document.body.contains(sh.el)) { off(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });

  sh.body.append(
    h('p', { class: 'src' }, t('syncBody')),
    field(t('syncProvider'), prov),
    dbxBox, davBox, folderBox,
    h('label', { class: 'row', style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px' } }, h('span', { class: 'switch' }, auto, h('i')), h('span', null, t('syncAuto'))),
    status);
  sh.actions.append(syncBtn);
  syncBtn.disabled = !syncConfigured();
  const refreshBtn = () => { syncBtn.disabled = !syncConfigured(); };
  sh.body.addEventListener('change', refreshBtn);
}

/** Small prompt after reading offline: sync now or later. */
export function askSyncSheet(): void {
  const sh = openSheet(t('syncAsk'), t('later'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.body.append(h('p', { class: 'src' }, t('syncAskBody')));
  const auto = h('input', { type: 'checkbox', checked: false, onchange: () => updateSettings({ syncAuto: auto.checked }) }) as HTMLInputElement;
  sh.body.append(h('label', { class: 'row', style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' } }, h('span', { class: 'switch' }, auto, h('i')), h('span', null, t('syncAuto'))));
  sh.actions.append(
    h('button', { class: 'btn small', type: 'button', onclick: () => sh.close() }, t('later')),
    h('button', { class: 'btn small primary', type: 'button', onclick: () => { sh.close(); void syncNow().then((r) => toast(r.ok ? t('syncDone', { n: r.changed }) : `${t('syncFailed')} — ${r.error ?? ''}`, r.ok ? 'info' : 'error')); } }, icon('rotate'), t('syncNow')));
}
