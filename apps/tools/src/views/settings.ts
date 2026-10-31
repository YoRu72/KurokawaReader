// Settings: the look and the language, the downloads (folder, limits, seeding, port), a remote aria2, the
// add-ons from the Kurokawa repository, the other Kurokawa apps (installed, or fetched from here), updates, about.
import { h, icon, iconButton, toast, openSheet, pickButton } from '../ui/dom';
import { t, getLang, getLangPref, setLangPref, LANGS, formatBytes, localDigits, dateLocale, countAddons, getDirPref, setDirPref, type DirPref } from '../i18n';
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
    const downloads = card('downloads', t('downloadsSection'),
      row(t('downloadFolder'), canPick ? h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { try { let d: string | null = null; if (window.kurokawaTools?.pickDir) d = await window.kurokawaTools.pickDir(); else if (ktPlugin()) d = (await ktPlugin()!.pickDir()).dir; if (d) { updateSettings({ downloadDir: d }); rerender(); toast(t('folderPicked', { dir: d })); } } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, icon('folder'), t('changeFolder')) : h('span'), s.downloadDir || t('defaultFolder')),
      row(t('maxActive'), numberField(s.maxActive, (v) => { updateSettings({ maxActive: Math.max(1, Math.min(10, v)) }); void (window.kurokawaTools?.configure?.({ maxConnections: v }) ?? ktPlugin()?.configure({ maxActive: v })); }, { min: 1, max: 10 })),
      eng.can.limits ? row(t('downLimit'), numberField(Math.round(s.limits.down / 1024), (v) => { const l = { ...s.limits, down: v * 1024 }; updateSettings({ limits: l }); void eng.setLimits?.(l); }, { width: '7em' }), 'KB/s · 0 = ' + t('unlimited')) : null,
      eng.can.limits ? row(t('upLimit'), numberField(Math.round(s.limits.up / 1024), (v) => { const l = { ...s.limits, up: v * 1024 }; updateSettings({ limits: l }); void eng.setLimits?.(l); }, { width: '7em' }), 'KB/s · 0 = ' + t('unlimited')) : null,
      eng.can.seeding ? toggle(t('seedAfterDone'), s.seedAfterDone, (v) => { updateSettings({ seedAfterDone: v }); void (window.kurokawaTools?.configure?.({ seed: v }) ?? ktPlugin()?.configure({ seed: v })); }) : null,
      eng.can.torrents && eng.id === 'native' ? row(t('listenPort'), numberField(s.listenPort, (v) => { updateSettings({ listenPort: v }); void (window.kurokawaTools?.configure?.({ listenPort: v }) ?? ktPlugin()?.configure({ listenPort: v })); }, { min: 0, max: 65535, width: '7em' }), `0 = ${t('portRandom')}`) : null,
      toggle(t('sequential'), s.sequentialVideo, (v) => updateSettings({ sequentialVideo: v })),
      toggle(t('useCategoryFolders'), s.useCategoryFolders, (v) => updateSettings({ useCategoryFolders: v }), t('useCategoryFoldersHint')),
      ...(s.addons.includes('debrid') ? [toggle(t('debridDefault'), s.debridDefault, (v) => updateSettings({ debridDefault: v }), t('debridDefaultHint'))] : []),
      ...(s.addons.includes('archives') ? [toggle(t('autoUnpackSubs'), s.autoUnpackSubs, (v) => updateSettings({ autoUnpackSubs: v })), toggle(t('autoUnpackAll'), s.autoUnpackAll, (v) => updateSettings({ autoUnpackAll: v }), t('autoUnpackAllHint'))] : []));
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
        toggle(t('videoSponsor'), s.videoSponsor, (v) => updateSettings({ videoSponsor: v })));
    }
    return [general, downloads, video, aria2, addons, anime, otherApps, updates, about].filter(Boolean) as HTMLElement[];
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
function addonSettingsSheet(list: AddonEntry[], lang: string): void {
  const sh = openSheet(t('addonSettings'), t('close'));
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
