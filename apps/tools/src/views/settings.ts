// Settings: the look and the language, the downloads (folder, limits, seeding, port), a remote aria2, the
// add-ons from the Kurokawa repository, the other Kurokawa apps (installed, or fetched from here), updates, about.
import { h, icon, iconButton, toast, openSheet, pickButton } from '../ui/dom';
import { t, getLang, getLangPref, setLangPref, LANGS, formatBytes, localDigits, dateLocale, countAddons, getDirPref, setDirPref, digitsPref, type DirPref } from '../i18n';
import { getSettings, updateSettings, type Accent, type UiMode, type DarkTone } from '../settings';
import { back, navigate } from '../router';
import { APP_VERSION, REPO, SITE_URL } from '../repo';
import { nativePlatform, ktPlugin, openExternal } from '../native';
import { Aria2Rpc } from '../engine/aria2';
import { getEngine } from '../engine';
import { animeSettingsCard } from './animeSettings';
import { loadIndex, install, uninstall, installed, nameOf, descOf, updatesAvailable, addonSettings, setAddonSettings, type AddonEntry } from '../addons';
import { checkForUpdate, showUpdateSheet, lastChecked } from '../updates';
import { latestRelease, suitableAsset, fetchAndInstall } from '../installer';

const card = (id: string, title: string, ...kids: (Node | null)[]) => h('section', { class: 'card', id }, h('h3', null, title), ...kids);
const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const toggle = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => { const c = h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }); return h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), c); };
const numberField = (value: number, set: (v: number) => void, o: { min?: number; max?: number; step?: number; width?: string } = {}) => h('input', { type: 'number', value: String(value), min: String(o.min ?? 0), max: o.max !== undefined ? String(o.max) : undefined, step: String(o.step ?? 1), style: { width: o.width ?? '6em' }, onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value) || 0) });

export function settingsView(section?: string): HTMLElement & { dispose?: () => void } {
  const s = getSettings();
  const body = h('div', { class: 'body settings-body' });
  const root = h('div', { class: 'view settings-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/')), h('div', { class: 'title' }, h('span', null, t('settings')))), body) as HTMLElement & { dispose?: () => void };
  // The reader's way: every card folded to its heading (a short page of sections), chips to jump to one, a
  // search box that opens and filters the rows that mention what is typed. What is open stays open on redraw.
  const open = new Set<string>(section ? [section] : ['updates']);
  const search = h('input', { type: 'search', class: 'settings-search', placeholder: t('searchSettings'), 'aria-label': t('searchSettings') }) as HTMLInputElement;
  const nav = h('div', { class: 'folder-chips settings-nav', role: 'tablist' });
  const head = h('div', { class: 'settings-head' }, search, nav);
  const decorate = () => {
    nav.replaceChildren();
    for (const card of Array.from(body.querySelectorAll<HTMLElement>(':scope > .card'))) {
      const title = card.querySelector<HTMLElement>(':scope > h3'); if (!title) continue;
      title.classList.add('card-title'); title.setAttribute('role', 'button'); title.setAttribute('tabindex', '0'); title.setAttribute('aria-expanded', String(open.has(card.id)));
      if (!title.querySelector('svg')) title.prepend(icon('chevronDown'));
      card.classList.toggle('collapsed', !open.has(card.id));
      const flip = () => { const on = card.classList.toggle('collapsed'); if (on) open.delete(card.id); else open.add(card.id); title.setAttribute('aria-expanded', String(!on)); };
      title.onclick = flip; title.onkeydown = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
      nav.append(h('button', { type: 'button', class: 'chip small', onclick: () => { open.add(card.id); card.classList.remove('collapsed'); title.setAttribute('aria-expanded', 'true'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, h('span', null, title.textContent ?? '')));
    }
    applySearch();
  };
  const applySearch = () => {
    const q = search.value.trim().toLowerCase();
    for (const card of Array.from(body.querySelectorAll<HTMLElement>(':scope > .card'))) {
      const rows = Array.from(card.children).filter((r) => !r.matches('h3')) as HTMLElement[];
      if (!q) { card.hidden = false; rows.forEach((r) => { r.hidden = false; }); card.classList.toggle('collapsed', !open.has(card.id)); continue; }
      const titleHit = (card.querySelector(':scope > h3')?.textContent ?? '').toLowerCase().includes(q);
      let any = false; for (const r of rows) { const hit = titleHit || (r.textContent ?? '').toLowerCase().includes(q); r.hidden = !hit; if (hit) any = true; }
      card.hidden = !any; card.classList.remove('collapsed');
    }
  };
  search.addEventListener('input', applySearch);
  const rerender = () => { body.replaceChildren(head, ...sections()); decorate(); };

  const sections = (): HTMLElement[] => {
    const s = getSettings();
    const langOpts: [string, string][] = [['system', t('languageSystem')], ...LANGS.map(([c, n]) => [c, n] as [string, string])];
    const general = card('general', t('general'),
      row(t('language'), pickButton(t('language'), langOpts, getLangPref(), (v) => { setLangPref(v as 'system'); }, t('close'))),
      row(t('direction'), pickButton(t('direction'), [['auto', t('dirAuto')], ['ltr', t('dirLtr')], ['rtl', t('dirRtl')]], getDirPref(), (v) => { setDirPref(v as DirPref); rerender(); }, t('close'))),
      row(t('uiScale'), pickButton(t('uiScale'), [['75', '75%'], ['85', '85%'], ['90', '90%'], ['100', '100%'], ['110', '110%'], ['125', '125%']], String(s.uiScale), (v) => { updateSettings({ uiScale: Number(v) }); rerender(); }, t('close')), t('uiScaleHint')),
      row(t('uiMode'), pickButton(t('uiMode'), [['system', t('uiSystem')], ['light', t('uiLight')], ['dark', t('uiDark')]], s.uiMode, (v) => { updateSettings({ uiMode: v as UiMode }); rerender(); }, t('close'))),
      row(t('darkTone'), pickButton(t('darkTone'), [['default', t('darkToneDefault')], ['grey', t('darkToneGrey')], ['black', t('darkToneBlack')]], s.darkTone, (v) => { updateSettings({ darkTone: v as DarkTone }); rerender(); }, t('close'))),
      row(t('accent'), h('div', { class: 'accent-swatches' }, ...(['graphite', 'mono', 'teal', 'aqua', 'mint', 'olive', 'gold', 'sand', 'coral', 'rose', 'violet'] as Accent[]).map((a) => h('button', { type: 'button', class: 'swatch' + (s.accent === a ? ' on' : ''), 'data-accent': a, 'aria-label': a, onclick: () => { updateSettings({ accent: a }); rerender(); } })),
        h('label', { class: 'swatch custom' + (s.accent === 'custom' ? ' on' : ''), title: 'custom' }, h('input', { type: 'color', value: s.accentCustom, oninput: (e: Event) => updateSettings({ accent: 'custom', accentCustom: (e.target as HTMLInputElement).value }) })))));
    const eng = getEngine();
    const dirLabel = h('span', { class: 'src', dir: 'ltr' }, s.downloadDir || t('defaultFolder'));
    const canPick = !!(window.kurokawaTools?.pickDir || ktPlugin());
    // Connection (Prism's): the name given to servers, tries, how long to wait, a proxy, a file already there.
    const NET = { uaMode: 'app' as const, ua: '', retries: 5, timeout: 60, proxy: '', conflict: 'rename' as const, ...(s.net ?? {}) };
    const setNet = (o: Partial<typeof NET>) => { const n = { ...NET, ...(getSettings().net ?? {}), ...o }; updateSettings({ net: n }); void import('../downloads/net').then((m) => m.applyNet(n)); };
    const hostsLine = h('small', { class: 'src' });
    const connection = eng.can.http && eng.id !== 'browser' ? card('connection', t('netSection'), h('p', { class: 'hint' }, t('netHint')),
      row(t('netUa'), pickButton(t('netUa'), [['app', t('netUaApp')], ['browser', t('netUaBrowser')], ['custom', t('netUaCustom')]], NET.uaMode, (v) => { setNet({ uaMode: v }); rerender(); }, t('close'))),
      NET.uaMode === 'custom' ? h('input', { type: 'text', dir: 'ltr', class: 'wide-input', value: NET.ua, placeholder: 'Mozilla/5.0 …', onchange: (e: Event) => setNet({ ua: (e.target as HTMLInputElement).value }) }) : null,
      row(t('netRetries'), numberField(NET.retries, (v) => setNet({ retries: Math.max(0, Math.min(30, v)) }), { min: 0, max: 30 }), t('netRetriesHint')),
      row(t('netTimeout'), numberField(NET.timeout, (v) => setNet({ timeout: Math.max(5, Math.min(600, v)) }), { min: 5, max: 600, width: '6em' }), t('netTimeoutHint')),
      row(t('netProxy'), h('input', { type: 'text', dir: 'ltr', value: NET.proxy, placeholder: 'socks5://127.0.0.1:9050', autocomplete: 'off', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); void import('../downloads/net').then((m) => { if (!m.validProxy(v)) { toast(t('netProxyBad'), 'error'); return; } setNet({ proxy: v }); }); } }), t('netProxyHint')),
      row(t('netConflict'), pickButton(t('netConflict'), [['rename', t('netConflictRename'), t('netConflictRenameHint')], ['overwrite', t('netConflictOverwrite')], ['skip', t('netConflictSkip')]], NET.conflict, (v) => setNet({ conflict: v }), t('close'))),
      eng.id === 'native' ? h('div', { class: 'row' }, h('span', null, t('netHosts'), hostsLine), h('button', { type: 'button', class: 'btn text small', onclick: () => { void ktPlugin()?.configure({ forgetHosts: true }).then(() => { hostsLine.textContent = ''; toast(t('netHostsForgot')); }); } }, t('netHostsForget'))) : null) : null;
    if (connection && eng.id === 'native') void (ktPlugin() as unknown as { hosts?(): Promise<{ hosts: Record<string, number> }> } | null)?.hosts?.().then((r) => { const e = Object.entries(r.hosts ?? {}); hostsLine.textContent = e.length ? ' ' + e.slice(0, 4).map(([k, v]) => `${k} ≤ ${localDigits(v)}`).join(' · ') + (e.length > 4 ? ' …' : '') : ' ' + t('netHostsNone'); }).catch(() => undefined);
    const downloads = card('downloads', t('downloadsSection'),
      row(t('downloadFolder'), canPick ? h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { try { let d: string | null = null; if (window.kurokawaTools?.pickDir) d = await window.kurokawaTools.pickDir(); else if (ktPlugin()) d = (await ktPlugin()!.pickDir()).dir; if (d) { updateSettings({ downloadDir: d }); rerender(); toast(t('folderPicked', { dir: d })); } } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, icon('folder'), t('changeFolder')) : h('span'), s.downloadDir || t('defaultFolder')),
      row(t('maxActive'), numberField(s.maxActive, (v) => { updateSettings({ maxActive: Math.max(1, Math.min(10, v)) }); void (window.kurokawaTools?.configure?.({ maxConnections: v }) ?? ktPlugin()?.configure({ maxActive: v })); }, { min: 1, max: 10 })),
      eng.can.limits ? row(t('downLimit'), numberField(Math.round(s.limits.down / 1024), (v) => { const l = { ...s.limits, down: v * 1024 }; updateSettings({ limits: l }); void eng.setLimits?.(l); }, { width: '7em' }), 'KB/s · 0 = ' + t('unlimited')) : null,
      eng.can.limits ? row(t('upLimit'), numberField(Math.round(s.limits.up / 1024), (v) => { const l = { ...s.limits, up: v * 1024 }; updateSettings({ limits: l }); void eng.setLimits?.(l); }, { width: '7em' }), 'KB/s · 0 = ' + t('unlimited')) : null,
      (window.kurokawaTools as unknown as { mini?: unknown } | undefined)?.mini ? toggle(t('miniAuto'), !!s.miniAuto, (v) => { updateSettings({ miniAuto: v }); void (window.kurokawaTools as unknown as { mini(o: { action: string; on: boolean }): Promise<unknown> }).mini({ action: 'auto', on: v }); }, t('miniAutoHint')) : null,
      eng.can.seeding ? toggle(t('seedAfterDone'), s.seedAfterDone, (v) => { updateSettings({ seedAfterDone: v }); void (window.kurokawaTools?.configure?.({ seed: v }) ?? ktPlugin()?.configure({ seed: v })); }) : null,
      eng.can.torrents && eng.id === 'native' ? row(t('listenPort'), numberField(s.listenPort, (v) => { updateSettings({ listenPort: v }); void (window.kurokawaTools?.configure?.({ listenPort: v }) ?? ktPlugin()?.configure({ listenPort: v })); }, { min: 0, max: 65535, width: '7em' }), `0 = ${t('portRandom')}`) : null,
      toggle(t('sequential'), s.sequentialVideo, (v) => updateSettings({ sequentialVideo: v })),
      toggle(t('useCategoryFolders'), s.useCategoryFolders, (v) => updateSettings({ useCategoryFolders: v }), t('useCategoryFoldersHint')),
      ...(s.addons.includes('debrid') ? [toggle(t('debridDefault'), s.debridDefault, (v) => updateSettings({ debridDefault: v }), t('debridDefaultHint'))] : []),
      ...(eng.can.torrents && eng.id === 'native' ? (() => { const tor = s.torrent; const set = (o: Partial<typeof tor>) => { const n = { ...getSettings().torrent, ...o }; updateSettings({ torrent: n }); void (window.kurokawaTools?.configure?.(n as never) ?? ktPlugin()?.configure(n)); }; return [
        h('details', { class: 'more-options' }, h('summary', null, t('torrentOptions')),
          ...(s.seedAfterDone ? [row(t('seedRatio'), numberField(tor.seedRatio, (v) => set({ seedRatio: Math.max(0, v) }), { min: 0, max: 100, step: 0.1, width: '6em' }), t('zeroUnlimited')), row(t('seedMinutes'), numberField(tor.seedMinutes, (v) => set({ seedMinutes: Math.max(0, v) }), { min: 0, max: 100000, width: '6em' }), t('zeroUnlimited'))] : []),
          row(t('encryption'), pickButton(t('encryption'), [['enabled', t('encEnabled')], ['forced', t('encForced')], ['disabled', t('encDisabled')]], tor.enc, (v) => set({ enc: v }), t('close'))),
          toggle('DHT', tor.dht, (v) => set({ dht: v })), toggle(t('lsdLabel'), tor.lsd, (v) => set({ lsd: v })), toggle('UPnP', tor.upnp, (v) => set({ upnp: v })), toggle('NAT-PMP', tor.natpmp, (v) => set({ natpmp: v })))]; })() : []),
      toggle(t('clipboardWatch'), s.clipboardWatch, (v) => updateSettings({ clipboardWatch: v }), t('clipboardWatchHint')),
      toggle(t('scheduleOn'), s.schedule.enabled, (v) => { updateSettings({ schedule: { ...getSettings().schedule, enabled: v } }); rerender(); void import('../downloads/prism').then((m) => m.startScheduler()); }, t('scheduleHint')),
      ...(s.schedule.enabled ? [h('div', { class: 'row' }, h('span', null, t('scheduleHours')), h('span', { class: 'row-actions', dir: 'ltr' }, h('input', { type: 'time', value: s.schedule.start, onchange: (e: Event) => updateSettings({ schedule: { ...getSettings().schedule, start: (e.target as HTMLInputElement).value } }) }), ' – ', h('input', { type: 'time', value: s.schedule.stop, onchange: (e: Event) => updateSettings({ schedule: { ...getSettings().schedule, stop: (e.target as HTMLInputElement).value } }) }))),
        h('div', { class: 'chip-row wrap' }, ...[0, 1, 2, 3, 4, 5, 6].map((d) => h('button', { type: 'button', class: 'chip small' + (s.schedule.days.includes(d) ? ' on' : ''), onclick: () => { const cur = getSettings().schedule.days; updateSettings({ schedule: { ...getSettings().schedule, days: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d] } }); rerender(); } }, new Intl.DateTimeFormat(dateLocale('prose'), { weekday: 'short' }).format(new Date(2026, 10, 1 + d)))))] : []),
      );
    void dirLabel;
    // Remote aria2
    const url = h('input', { type: 'url', value: s.aria2.url, dir: 'ltr', placeholder: 'http://192.168.1.10:6800/jsonrpc' }) as HTMLInputElement;
    const secret = h('input', { type: 'password', value: s.aria2.secret, dir: 'ltr' }) as HTMLInputElement;
    const saveAria = () => updateSettings({ aria2: { ...getSettings().aria2, url: url.value.trim(), secret: secret.value } });
    url.addEventListener('change', saveAria); secret.addEventListener('change', saveAria);
    const testOut = h('p', { class: 'src' });
    const aria2 = card('aria2', t('remoteAria2'), h('p', { class: 'hint' }, t('remoteAria2Hint')),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('aria2Url')), url), h('label', { class: 'field' }, h('span', { class: 'label' }, t('aria2Secret')), secret),
      toggle(t('aria2Use'), s.aria2.use, (v) => { saveAria(); updateSettings({ aria2: { ...getSettings().aria2, use: v } }); rerender(); }),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { saveAria(); testOut.textContent = t('checking'); try { const v = await new Aria2Rpc(url.value.trim(), secret.value).version(); testOut.textContent = t('aria2Ok', { v: v.version }); } catch (e) { testOut.textContent = t('aria2Fail', { error: String((e as Error).message ?? e) }); } } }, icon('wifi'), t('aria2Test'))), testOut);
    // Add-ons
    const addonsBox = h('div', { class: 'addons-list' }, h('div', { class: 'center small' }, h('div', { class: 'spinner small' })));
    const addons = card('addons', t('addons'), h('p', { class: 'hint' }, t('addonsHint')), addonsBox, h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: () => void drawAddons(true) }, icon('refresh'), t('addonsRefresh'))));
    const drawAddons = async (fresh = false) => {
      try {
        const ix = await loadIndex(fresh); const lang = getLang();
        const parents = ix.addons.filter((a) => !a.parent); const plat = nativePlatform();
        const upd = fresh ? await updatesAvailable().catch(() => []) : [];
        if (!parents.length) { addonsBox.replaceChildren(h('p', { class: 'src' }, t('addonsNone'))); return; }
        const rowOf = (a: AddonEntry, child = false): HTMLElement => {
          const ok = !a.platforms || a.platforms.includes(plat === 'ios' ? 'ios' : plat);
          const on = installed(a.id); const btn = h('button', { type: 'button', class: `btn small ${on ? 'tonal' : 'primary'}`, disabled: !ok }, icon(on ? (upd.includes(a.id) ? 'refresh' : 'trash') : 'download'), on ? (upd.includes(a.id) ? t('addonUpdate') : t('addonRemove')) : t('addonInstall')) as HTMLButtonElement;
          btn.addEventListener('click', async () => { btn.disabled = true; try { if (on && !upd.includes(a.id)) { await uninstall(a.id); toast(t('addonRemovedToast', { name: nameOf(a, lang) })); } else { await install(a.id); toast(t('addonInstalledToast', { name: nameOf(a, lang) })); } await drawAddons(); } catch (e) { toast(String((e as Error).message ?? e), 'error'); btn.disabled = false; } });
          const kids = (a.children ?? []).map((id) => ix.addons.find((x) => x.id === id)).filter(Boolean) as AddonEntry[];
          const withSettings = [a, ...kids].filter((x) => x.settings?.length && installed(x.id));
          const gear = withSettings.length ? iconButton('settings', t('addonSettings'), () => addonSettingsSheet(withSettings, lang)) : null;
          return h('div', { class: 'addon-row' + (child ? ' child' : ''), dataset: { id: a.id } }, icon(a.icon ?? 'puzzle'), h('div', { class: 'grow' }, h('b', { dir: 'auto' }, nameOf(a, lang)), h('small', { class: 'src', dir: 'auto' }, descOf(a, lang)), kids.length ? h('small', { class: 'src' }, `${t('addonChildren')}: ${kids.map((k) => nameOf(k, lang)).join(' · ')}`) : null), gear, btn);
        };
        addonsBox.replaceChildren(...parents.map((a) => rowOf(a)));
      } catch (e) { addonsBox.replaceChildren(h('p', { class: 'src' }, t('addonsFailed', { error: String((e as Error).message ?? e) }))); }
    };
    void drawAddons();
    // Other apps
    const readerBox = h('div', { class: 'app-row' }, h('img', { src: `${SITE_URL}icons/icon.svg`, alt: '', class: 'app-icon' }), h('div', { class: 'grow' }, h('b', null, t('appReader')), h('small', { class: 'src' }, t('appReaderDesc'))), h('span', { class: 'app-actions' }));
    const otherApps = card('apps', t('otherApps'), h('p', { class: 'hint' }, t('otherAppsHint')), readerBox);
    void drawOtherApp(readerBox.querySelector('.app-actions') as HTMLElement);
    // Updates
    const updStatus = h('p', { class: 'src' }, lastChecked() ? t('lastChecked', { d: new Date(lastChecked()).toLocaleString(dateLocale()) }) : '');
    const updates = card('updates', t('updates'), row(t('version', { v: APP_VERSION }), h('button', { type: 'button', class: 'btn tonal small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; updStatus.textContent = t('checking'); try { const rel = await checkForUpdate(true); if (rel) { showUpdateSheet(rel); updStatus.textContent = t('updateAvailable', { v: rel.version }); } else updStatus.textContent = t('upToDate'); } catch { updStatus.textContent = t('updateFailed'); } b.disabled = false; } }, icon('refresh'), t('checkUpdates'))),
      toggle(t('autoCheck'), s.autoUpdateCheck, (v) => updateSettings({ autoUpdateCheck: v })), updStatus);
    const about = card('about', t('about'), h('p', { class: 'hint' }, t('aboutBody')), h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn text small', onclick: () => void openExternal(`https://github.com/${REPO}`) }, icon('external'), t('sourceCode')),
      h('button', { type: 'button', class: 'btn text small', onclick: () => void openExternal(`https://github.com/${REPO}/issues`) }, icon('note'), t('reportIssue'))));
    const anime = s.addons.includes('anime') ? animeSettingsCard(rerender) : null;
    // Privacy (from the reader): DNS over HTTPS — sites blocked by the network's resolver reached through another —
    // and screenshots blocked; the Arabic digits; a backup of the settings.
    const dohOut = h('small', { class: 'src', dir: 'ltr' });
    const setDoh = async (provider: string, test?: string) => { const d = window.kurokawaTools as unknown as { setDoh?(o: { provider: string }): Promise<unknown> } | undefined; const p = ktPlugin() as unknown as { setDoh?(o: { provider?: string; test?: string }): Promise<{ ips?: string[] }> } | null; if (d?.setDoh) await d.setDoh({ provider }); else if (p?.setDoh) { const r = await p.setDoh({ provider, test }); if (test) dohOut.textContent = (r.ips ?? []).join(', '); } };
    const dohCustom = h('input', { type: 'url', dir: 'ltr', placeholder: 'https://…/dns-query', value: /^https:/.test(s.doh) ? s.doh : '', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (/^https:\/\//.test(v)) { updateSettings({ doh: v }); void setDoh(v).catch((er) => toast(String((er as Error).message ?? er), 'error')); } } }) as HTMLInputElement;
    const dohWrap = h('div', { hidden: !/^https:/.test(s.doh) }, dohCustom);
    const privacy = card('privacy', t('privacy'),
      row(t('dohTitle'), pickButton(t('dohTitle'), [['off', t('dohOff')], ['cloudflare', 'Cloudflare'], ['google', 'Google'], ['quad9', 'Quad9'], ['adguard', 'AdGuard'], ['custom', t('dohCustom')]], /^https:/.test(s.doh) ? 'custom' : s.doh, (v) => { if (v === 'custom') { dohWrap.hidden = false; dohCustom.focus(); return; } updateSettings({ doh: v }); void setDoh(v).then(() => toast(v === 'off' ? t('dohOff') : t('dohOn', { name: v }))).catch((er) => toast(String((er as Error).message ?? er), 'error')); rerender(); }, t('close')), t('dohHint')),
      dohWrap,
      ...(ktPlugin() && s.doh !== 'off' ? [h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn text small', onclick: () => { dohOut.textContent = '…'; void setDoh(getSettings().doh, 'nyaa.si').catch((er) => { dohOut.textContent = String((er as Error).message ?? er); }); } }, icon('check'), t('dohTest')), dohOut)] : []),
      ...(ktPlugin() ? [toggle(t('secureScreen'), s.secureScreen, (v) => { updateSettings({ secureScreen: v }); void (ktPlugin() as unknown as { secureScreen?(o: { on: boolean }): Promise<void> } | null)?.secureScreen?.({ on: v }); }, t('secureScreenHint'))] : []),
      ...(getLang() === 'ar' ? [row(t('digitsPref'), pickButton(t('digitsPref'), [['auto', t('digitsAuto')], ['western', '123'], ['eastern', '١٢٣']], digitsPref(), (v) => { try { const o = JSON.parse(localStorage.getItem('kr.visual') ?? '{}') as Record<string, string>; o.arDigits = v; localStorage.setItem('kr.visual', JSON.stringify(o)); } catch { /* none */ } location.reload(); }, t('close')))] : []));
    const backup = card('backup', t('backup'), h('p', { class: 'hint' }, t('backupHint')), h('div', { class: 'row-actions wrap' },
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const data: Record<string, string> = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (/^(kt\.|kr\.)/.test(k)) data[k] = localStorage.getItem(k) ?? ''; } const b = new Blob([JSON.stringify({ kurokawa: 'tools-backup', version: APP_VERSION, at: new Date().toISOString(), data }, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `kurokawa-tools-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast(t('backupMade')); } }, icon('download'), t('backupSave')),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const fi = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement; fi.onchange = async () => { const f = fi.files?.[0]; if (!f) return; try { const j = JSON.parse(await f.text()) as { kurokawa?: string; data?: Record<string, string> }; if (j.kurokawa !== 'tools-backup' || !j.data) throw new Error(t('backupNotOurs')); for (const [k, v] of Object.entries(j.data)) if (/^(kt\.|kr\.)/.test(k)) localStorage.setItem(k, v); toast(t('backupRestored')); setTimeout(() => location.reload(), 800); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }; fi.click(); } }, icon('upload'), t('backupRestore'))));
    // The Archives add-on (HatchZip): unpacking downloads, the space margin, verify first, closing when done.
    let archives: HTMLElement | null = null;
    if (s.addons.includes('archives')) { archives = card('archives', t('archivesSection'), toggle(t('autoUnpackSubs'), s.autoUnpackSubs, (v) => updateSettings({ autoUnpackSubs: v })), toggle(t('autoUnpackAll'), s.autoUnpackAll, (v) => updateSettings({ autoUnpackAll: v }), t('autoUnpackAllHint'))); void import('./extract').then((m) => archives!.append(...m.archiveSettingsRows(row, toggle))); }
    // The Video add-on: yt-dlp's version and an update now, the quality and format taken by default.
    let video: HTMLElement | null = null;
    if (s.addons.includes('video')) {
      const ver = h('small', { class: 'src', dir: 'ltr' }, '…');
      void import('../video/ytdlp').then(async (m) => { const v = await m.videoVersion(); ver.textContent = v ?? t('videoGetting'); });
      const upd = h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { upd.disabled = true; ver.textContent = t('videoGetting'); try { const m = await import('../video/ytdlp'); const v = await m.updateVideo(); ver.textContent = v ?? ''; toast(t('videoUpdated', { v: v ?? '' })); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } upd.disabled = false; } }, icon('refresh'), t('videoUpdate')) as HTMLButtonElement;
      video = card('video', t('videoKind'),
        h('div', { class: 'row' }, h('span', null, 'yt-dlp', ver), upd),
        row(t('videoDefaultQuality'), pickButton(t('videoDefaultQuality'), [['best', t('videoBest')], ['2160', '2160p'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['audio', t('videoAudioOnly')]], s.videoQuality, (v) => { updateSettings({ videoQuality: v as 'best' }); rerender(); }, t('close'))),
        row(t('videoContainer'), pickButton(t('videoContainer'), [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM']], s.videoContainer, (v) => { updateSettings({ videoContainer: v as 'mp4' }); rerender(); }, t('close'))),
        toggle(t('videoEmbedThumb'), s.videoEmbedThumb, (v) => updateSettings({ videoEmbedThumb: v })),
        toggle(t('videoSponsor'), s.videoSponsor, (v) => updateSettings({ videoSponsor: v })),
        toggle(t('videoChapters'), s.videoChapters !== false, (v) => updateSettings({ videoChapters: v })),
        toggle(t('videoNumber'), s.videoNumber !== false, (v) => updateSettings({ videoNumber: v }), t('videoNumberHint')),
        row(t('videoTemplate'), h('input', { type: 'text', dir: 'ltr', value: s.videoTemplate ?? '', placeholder: '%(title)s [%(id)s]', onchange: (e: Event) => updateSettings({ videoTemplate: (e.target as HTMLInputElement).value.trim() }) }), t('videoTemplateHint')),
        ...(nativePlatform() === 'desktop' ? [row(t('videoCookies'), pickButton(t('videoCookies'), [['', t('videoCookiesNone')], ['chrome', 'Chrome'], ['edge', 'Edge'], ['firefox', 'Firefox'], ['brave', 'Brave'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi'], ['chromium', 'Chromium'], ['safari', 'Safari']], s.videoCookies ?? '', (v) => { updateSettings({ videoCookies: v }); rerender(); }, t('close')), t('videoCookiesHint'))] : []));
    }
    // The player: how videos are watched (another app, or the in-app player of the Player add-on).
    const plat = nativePlatform();
    const player = plat === 'android' || plat === 'desktop' ? card('player', t('playerSection'),
      row(t('playerWithLabel'), pickButton(t('playerWithLabel'), [['ask', t('playerAsk')], ['app', t('playerApp')], ['external', t('playerExternal')]], s.playerWith, (v) => { updateSettings({ playerWith: v as 'ask' }); rerender(); }, t('close')))) : null;
    // Sounds (Prism's): when a download finishes or fails and when all are done; the «Download complete» card.
    const sp = (s.sounds ?? {}) as Partial<import('../downloads/done').SoundPrefs>; const SP = { on: true, complete: 'classic', failed: true, allDone: true, volume: 0.7, card: true, ...sp };
    const setSp = (o: Partial<typeof SP>) => { updateSettings({ sounds: { ...SP, ...o } }); };
    const playIt = (k: 'complete' | 'failed' | 'queue', which?: string) => void import('../downloads/done').then((m) => m.playSound(k, which));
    const soundNames: [string, string][] = [['classic', t('soundClassic')], ['prism', 'Prism'], ['pop', t('soundPop')], ['kalimba', t('soundKalimba')], ['snap', t('soundSnap')], ['cascade', t('soundCascade')], ['glide', t('soundGlide')], ['harp', t('soundHarp')], ['droplet', t('soundDroplet')], ['music-box', t('soundMusicBox')], ['sparkle', t('soundSparkle')]];
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(SP.volume), onchange: (e: Event) => { setSp({ volume: Number((e.target as HTMLInputElement).value) }); playIt('complete'); } }) as HTMLInputElement;
    const sounds = card('sounds', t('soundsSection'),
      toggle(t('soundsOn'), SP.on, (v) => { setSp({ on: v }); rerender(); }),
      ...(SP.on ? [
        row(t('soundComplete'), h('span', { class: 'row-actions' }, pickButton(t('soundComplete'), soundNames, SP.complete, (v) => { setSp({ complete: v }); playIt('complete', v); rerender(); }, t('close')), iconButton('play', t('soundPreview'), () => playIt('complete', getSettings().sounds?.complete ?? 'classic')))),
        toggle(t('soundFailed'), SP.failed, (v) => { setSp({ failed: v }); if (v) playIt('failed'); }),
        toggle(t('soundAllDone'), SP.allDone, (v) => { setSp({ allDone: v }); if (v) playIt('queue'); }),
        row(t('soundVolume'), vol)] : []),
      toggle(t('doneCardSetting'), SP.card, (v) => setSp({ card: v }), t('doneCardHint')));
    // The antivirus check after a download (Prism's): on a computer.
    const AV = { on: false, kind: 'auto' as const, command: '', args: '{file}', extensions: '', ...(s.av ?? {}) } as NonNullable<typeof s.av>;
    const setAv = (o: Partial<typeof AV>) => updateSettings({ av: { ...AV, ...o } });
    const avBox = nativePlatform() === 'desktop' ? card('antivirus', t('avSection'), h('p', { class: 'hint' }, t('avHint')),
      toggle(t('avOn'), AV.on, (v) => { setAv({ on: v, extensions: AV.extensions || 'exe msi zip rar 7z apk dmg pkg deb rpm appimage bat cmd ps1 jar iso' }); rerender(); }),
      ...(AV.on ? [row(t('avScanner'), pickButton(t('avScanner'), [['auto', t('avAuto')], ['defender', 'Microsoft Defender'], ['clamav', 'ClamAV'], ['custom', t('avCustom')]], AV.kind, (v) => { setAv({ kind: v as 'auto' }); rerender(); }, t('close'))),
        ...(AV.kind === 'custom' ? [row(t('avCommand'), h('input', { type: 'text', dir: 'ltr', value: AV.command, placeholder: '/usr/bin/clamdscan', onchange: (e: Event) => setAv({ command: (e.target as HTMLInputElement).value }) })), row(t('avArgs'), h('input', { type: 'text', dir: 'ltr', value: AV.args, placeholder: '--no-summary {file}', onchange: (e: Event) => setAv({ args: (e.target as HTMLInputElement).value }) }), t('avArgsHint'))] : []),
        row(t('avExtensions'), h('input', { type: 'text', dir: 'ltr', value: AV.extensions, onchange: (e: Event) => setAv({ extensions: (e.target as HTMLInputElement).value }) }), t('avExtensionsHint'))] : [])) : null;
    // AI models from Hugging Face (Prism's): the server or a mirror, the access token, the folder.
    const HFP = { endpoint: 'https://huggingface.co', token: '', folder: '', ...(s.hf ?? {}) };
    const setHf = (o: Partial<typeof HFP>) => updateSettings({ hf: { ...HFP, ...o } });
    const models = card('models', t('hfTitle'), h('p', { class: 'hint' }, t('hfHint')),
      row(t('hfServer'), pickButton(t('hfServer'), [['https://huggingface.co', 'huggingface.co'], ['https://hf-mirror.com', 'hf-mirror.com']], HFP.endpoint, (v) => { setHf({ endpoint: v }); rerender(); }, t('close'))),
      row(t('hfToken'), h('input', { type: 'password', dir: 'ltr', value: HFP.token, placeholder: 'hf_…', autocomplete: 'off', onchange: (e: Event) => setHf({ token: (e.target as HTMLInputElement).value.trim() }) }), t('hfTokenHint')),
      row(t('hfFolder'), h('input', { type: 'text', dir: 'ltr', value: HFP.folder, placeholder: t('hfFolderDefault'), onchange: (e: Event) => setHf({ folder: (e.target as HTMLInputElement).value.trim() }) }), t('hfFolderHint')),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('./models').then((m) => m.modelsSheet()) }, icon('search'), t('hfBrowse'))));
    // Storage: the packs (Python, ffmpeg) fetched for add-ons, with their sizes, removable.
    const packsBox = h('div'); void import('../packs').then((m) => { const c = m.packsCard(); if (c) packsBox.replaceChildren(c); });
    const storage = plat === 'android' || plat === 'desktop' ? card('storage', t('storageSection'), packsBox) : null;
    return [general, downloads, connection, sounds, player, video, models, archives, avBox, privacy, aria2, addons, anime, storage, backup, otherApps, updates, about].filter(Boolean) as HTMLElement[];
  };
  rerender();
  if (section) setTimeout(() => body.querySelector(`#${CSS.escape(section)}`)?.scrollIntoView({ block: 'start' }), 50);
  void decorate;
  void s; void navigate; void localDigits; void formatBytes; void openSheet; void countAddons;
  return root;
}

/** The reader on this device: open it when installed (Android: its package; desktop: not known), else fetch
 *  its release — the APK installed from here with its progress, the installer run on Windows. */
async function drawOtherApp(box: HTMLElement): Promise<void> {
  const plat = nativePlatform();
  const p = ktPlugin() as (ReturnType<typeof ktPlugin> & { isInstalled?(o: { pkg: string }): Promise<{ installed: boolean }>; launch?(o: { pkg: string }): Promise<void> }) | null;
  const pkg = 'app.kurokawa.reader';
  const has = p?.isInstalled ? (await p.isInstalled({ pkg }).catch(() => ({ installed: false }))).installed : false;
  if (has) { box.replaceChildren(h('button', { type: 'button', class: 'btn tonal small', onclick: () => void p!.launch?.({ pkg }) }, icon('external'), t('appInstalled'))); return; }
  const get = h('button', { type: 'button', class: 'btn primary small' }, icon('download'), plat === 'android' ? t('appDownloadApk') : t('appGet')) as HTMLButtonElement;
  get.addEventListener('click', async () => {
    get.disabled = true;
    try {
      const rel = await latestRelease('v'); if (!rel) throw new Error('no release');
      const asset = await suitableAsset(rel);
      if (!asset || plat === 'web' || plat === 'ios') { await openExternal(rel.url); return; }
      const sh = openSheet(`${t('appReader')} ${rel.version}`, t('close'));
      const bar = h('div', { class: 'task-bar' }, h('i')); const status = h('p', { class: 'src' }, formatBytes(asset.size));
      sh.body.append(h('p', { class: 'src', dir: 'ltr' }, asset.name), bar, status);
      const r = await fetchAndInstall(asset, (pr) => { (bar.firstChild as HTMLElement).style.width = `${pr.pct}%`; status.textContent = `${t('downloading', { p: localDigits(pr.pct) })} · ${formatBytes(pr.got)} / ${formatBytes(pr.total)}${pr.speed ? ` · ${t('perSecond', { n: formatBytes(pr.speed) })}` : ''}`; });
      toast(r === 'installing' ? t('installStarted') : t('openReleasePage')); sh.close();
    } catch (e) { toast(t('installFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
    finally { get.disabled = false; }
  });
  box.replaceChildren(get, h('button', { type: 'button', class: 'btn text small', onclick: () => void openExternal(`https://github.com/${REPO}/releases`) }, icon('external'), t('appOpenReleases')));
}

/** The settings of installed add-ons that have any: a field per declared setting, saved as typed. */
export function addonSettingsSheet(list: AddonEntry[], lang: string, opts: { note?: Node; done?: () => void } = {}): void {
  const sh = openSheet(t('addonSettings'), t('close'));
  if (opts.note) sh.body.append(opts.note);
  if (opts.done) sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); opts.done!(); } }, icon('search'), t('searchAgain')));
  for (const a of list) {
    const cur = addonSettings(a);
    sh.body.append(h('h4', { dir: 'auto' }, nameOf(a, lang)));
    for (const f of a.settings ?? []) {
      const label = f.labels?.[lang] ?? f.label;
      const save = (v: string | number | boolean) => setAddonSettings(a.id, { ...addonSettings(a), [f.id]: v });
      if (f.type === 'toggle') sh.body.append(h('label', { class: 'switch-row' }, h('span', { class: 'grow' }, label), h('input', { type: 'checkbox', checked: !!cur[f.id], onchange: (e: Event) => save((e.target as HTMLInputElement).checked) })));
      else if (f.type === 'select') sh.body.append(h('label', { class: 'field' }, h('span', null, label), h('select', { onchange: (e: Event) => save((e.target as HTMLSelectElement).value) }, ...(f.options ?? []).map((o) => h('option', { value: o, selected: String(cur[f.id] ?? '') === o }, o || '—')))));
      else sh.body.append(h('label', { class: 'field' }, h('span', null, label), h('input', { type: f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text', value: String(cur[f.id] ?? ''), autocomplete: 'off', spellcheck: 'false', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; save(f.type === 'number' ? Number(v) : v); } })));
    }
  }
}
