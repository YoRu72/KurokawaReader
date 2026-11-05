// A new download: links or magnets typed or pasted (several at once), a .torrent file chosen; the folder, the
// name, the connections; for a torrent, its files picked once the metadata is here.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t, formatBytes, countFiles } from '../i18n';
import { getEngine, parseSources, isVideo, magnetName } from '../engine';
import type { Task, TaskSource, TorrentInfo } from '../engine/types';
import { canArchive, pickFiles } from '../archives';
import { isIos } from './ipa';
import { categoryOf, categoryDir } from '../downloads/categories';
import { getSettings, updateSettings } from '../settings';
import { ktPlugin } from '../native';
import { videoPanel, preferredFormat } from './addVideo';
import { videoEnabled, isVideoHost } from '../video/ytdlp';
import { probeUrl, splitName, type Probe } from '../downloads/probe';
import { freeSpaceAt } from '../archives';
import { nativePlatform } from '../native';

const toBase64 = (buf: ArrayBuffer): string => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

/** The Add sheet; `pickTorrent` opens the file picker at once, `video` says a video page is wanted (from the + menu). */
export function addSheet(initial = '', how: { pickTorrent?: boolean; video?: boolean; torrent?: File; headers?: Record<string, string>; name?: string } = {}): void {
  const eng = getEngine();
  const sh = openSheet(t('addTitle'), t('close'));
  sh.el.classList.add('add-sheet');
  const ta = h('textarea', { rows: 3, class: 'add-input', dir: 'ltr', placeholder: t('addHint'), spellcheck: 'false', autocapitalize: 'off' }) as HTMLTextAreaElement; ta.value = initial;
  const fileIn = h('input', { type: 'file', accept: '.torrent,application/x-bittorrent', hidden: true }) as HTMLInputElement;
  let torrentFile: { name: string; b64: string } | null = null;
  const fileNote = h('p', { class: 'src', hidden: true });
  fileIn.addEventListener('change', async () => { const f = fileIn.files?.[0]; if (!f) return; torrentFile = { name: f.name, b64: toBase64(await f.arrayBuffer()) }; fileNote.textContent = f.name; fileNote.hidden = false; void metadata(); });
  const tools = h('div', { class: 'add-tools' },
    h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { try { const s = await navigator.clipboard.readText(); if (!parseSources(s).length) { toast(t('nothingToPaste'), 'error'); return; } ta.value = (ta.value ? ta.value + '\n' : '') + s.trim(); void metadata(); } catch { toast(t('nothingToPaste'), 'error'); } } }, icon('copy'), t('pasteLink')),
    ...(eng.can.torrents ? [h('button', { type: 'button', class: 'btn tonal small', onclick: () => fileIn.click() }, icon('file'), t('pickTorrentFile'))] : []),
    h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const one = parseSources(ta.value)[0]?.url ?? ''; sh.close(); void import('../downloads/prism').then((m) => m.grabberSheet(one)); } }, icon('link'), t('grabTitle')),
    ...(getSettings().addons.includes('archives') && canArchive() ? [h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { const fs = await pickFiles(true); if (!fs.length) return; sh.close(); if (fs.length === 1) void import('./archiveBrowse').then((m) => m.browseArchive(fs[0])); else void import('./extract').then((m) => m.extractMany(fs)); } }, icon('archive'), t('openArchive')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void import('./extract').then((m) => m.createZipSheet()); } }, icon('plus'), t('createZip'))] : []));
  // Options
  const s = getSettings();
  const dir = h('span', { class: 'grow', dir: 'ltr' }, s.downloadDir || t('defaultFolder'));
  let dirChosen = false;
  const pick = async () => { try { let d: string | null = null; if (window.kurokawaTools?.pickDir) d = await window.kurokawaTools.pickDir(); else if (ktPlugin()) d = (await ktPlugin()!.pickDir()).dir; if (d) { updateSettings({ downloadDir: d, recentDirs: [d, ...(getSettings().recentDirs ?? []).filter((x) => x !== d)].slice(0, 8) }); drawDirs(); void showStorage(); if (!(await import('./folderAccess').then((m) => m.ensureFolderAccess(d!)))) { dir.textContent = t('defaultFolder'); return; } dir.textContent = d; dirChosen = true; } } catch (e) { toast(String((e as Error).message ?? e), 'error'); } };
  // «Save as»: the name and the extension apart, filled from the link once it is looked at (the site's name for it,
  // its size, what its bytes say it is), both free to change; the folder, with the ones used lately to pick from.
  const given = splitName(how.name ?? '');
  const name = h('input', { type: 'text', dir: 'auto', placeholder: t('fileName'), value: given.stem, class: 'grow' }) as HTMLInputElement;
  const ext = h('input', { type: 'text', dir: 'ltr', placeholder: t('extension'), value: given.ext, class: 'ext-in', spellcheck: 'false', autocapitalize: 'off' }) as HTMLInputElement;
  const sizeLine = h('div', { class: 'src add-size' }); const storageLine = h('div', { class: 'src add-storage' });
  let probed: Probe | null = null; let probeToken = 0; let nameTouched = !!how.name;
  name.addEventListener('input', () => { nameTouched = true; }); ext.addEventListener('input', () => { nameTouched = true; });
  const showStorage = async () => { const free = await freeSpaceAt(getSettings().downloadDir || '').catch(() => -1); if (free < 0) { storageLine.hidden = true; return; } storageLine.hidden = false; const need = probed?.size ?? 0; storageLine.replaceChildren(icon('storage'), h('span', null, t('storageFree', { free: formatBytes(free) }))); if (need && need > free) storageLine.append(h('b', { class: 'danger' }, ` · ${t('storageShort')}`)); };
  const lookAt = async (u: string | null, hdrs?: Record<string, string>) => {
    const my = ++probeToken; probed = null;
    if (!u || !/^https?:/i.test(u)) { sizeLine.hidden = true; void showStorage(); return; }
    sizeLine.hidden = false; sizeLine.replaceChildren(h('div', { class: 'spinner small' }), ` ${t('lookingAtLink')}`);
    const r = await probeUrl(u, hdrs).catch(() => null); if (my !== probeToken) return;
    if (!r) { sizeLine.hidden = true; void showStorage(); return; }
    probed = r;
    if (!nameTouched) { name.value = r.stem; ext.value = r.ext; }
    const bits: (string | HTMLElement)[] = [];
    if (r.size) bits.push(formatBytes(r.size)); else bits.push(t('sizeUnknown'));
    if (r.resumable === false) bits.push(t('notResumable'));
    if (r.extFrom) bits.push(t(r.extFrom === 'bytes' ? 'extFromBytes' : 'extFromType', { ext: r.ext }));
    sizeLine.replaceChildren(icon('info'), h('span', null, `${t('size')}: ${bits.join(' · ')}`));
    if (r.page) sizeLine.append(h('b', { class: 'danger' }, ` · ${t('linkIsPage')}`));
    void showStorage();
  };
  // (Folders used before, for one tap; the newest first.)
  const recent = (): string[] => (getSettings().recentDirs ?? []).filter((d) => d && d !== getSettings().downloadDir).slice(0, 5);
  const dirMenu = h('div', { class: 'folder-chips', hidden: !recent().length }, ...recent().map((d) => h('button', { type: 'button', class: 'chip', dir: 'ltr', title: d, onclick: () => { updateSettings({ downloadDir: d }); dir.textContent = d; dirChosen = true; drawDirs(); void showStorage(); } }, icon('history'), d.split(/[\\/]/).filter(Boolean).pop() ?? d)));
  const drawDirs = () => { const r = recent(); dirMenu.hidden = !r.length; dirMenu.replaceChildren(...r.map((d) => h('button', { type: 'button', class: 'chip', dir: 'ltr', title: d, onclick: () => { updateSettings({ downloadDir: d }); dir.textContent = d; dirChosen = true; drawDirs(); void showStorage(); } }, icon('history'), d.split(/[\\/]/).filter(Boolean).pop() ?? d))); };
  const referer = h('input', { type: 'url', dir: 'ltr', placeholder: t('refererHint'), spellcheck: 'false', autocapitalize: 'off', value: how.headers?.Referer ?? how.headers?.referer ?? '' }) as HTMLInputElement;
  const seq = h('input', { type: 'checkbox', checked: s.sequentialVideo }) as HTMLInputElement;
  const paused = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const later = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const wifi = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const retry = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const hidden = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const conn = h('input', { type: 'number', min: '1', max: '32', value: '24', style: { width: '5em' } }) as HTMLInputElement;
  const filesBox = h('div', { class: 'add-files', hidden: true });
  let info: TorrentInfo | null = null; let chosen = new Set<number>(); let metaToken = 0;
  const saveAs = h('div', { class: 'save-as' },
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('saveAs')), h('div', { class: 'save-as-row' }, name, h('span', { class: 'dot' }, '.'), ext)),
    sizeLine, storageLine,
    h('div', { class: 'dest-row static' }, icon('folder'), h('span', { class: 'label' }, t('saveTo')), dir, (window.kurokawaTools || ktPlugin()) ? h('button', { type: 'button', class: 'btn text small', onclick: () => void pick() }, t('changeFolder')) : null),
    dirMenu);
  const quick = h('div', { class: 'check-grid' },
    ...(nativePlatform() === 'android' ? [h('label', { class: 'check-row' }, wifi, h('span', null, t('wifiOnlyThis')))] : []),
    h('label', { class: 'check-row' }, retry, h('span', null, t('retryOnFail'))),
    h('label', { class: 'check-row' }, hidden, h('span', null, t('hiddenFile'))),
    h('label', { class: 'check-row' }, paused, h('span', null, t('startPaused'))));
  const opts = h('details', { class: 'add-options' }, h('summary', null, t('addAdvanced')),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('refererPage')), referer),
    h('label', { class: 'check-row' }, seq, h('span', null, t('sequential'))),
    ...(getSettings().schedule.enabled ? [h('label', { class: 'check-row' }, later, h('span', null, t('downloadLater')))] : []),
    h('label', { class: 'field row' }, h('span', { class: 'label' }, t('connections')), conn));
  void showStorage();
  // Through a debrid service (the Debrid add-on with a key): the cloud fetches it, the app downloads the result.
  const viaDebrid = h('input', { type: 'checkbox', checked: getSettings().debridDefault }) as HTMLInputElement;
  const debridRow = h('label', { class: 'check-row debrid-row', hidden: true }, viaDebrid, h('span', null, t('viaDebrid')));
  void import('../debrid').then(async (m) => { const svc = await m.preferredDebrid(); if (svc) { debridRow.hidden = false; debridRow.lastChild!.textContent = t('viaDebridNamed', { service: svc.name }); } });
  const video = videoPanel(() => undefined);
  const zipBox = h('div', { class: 'add-files', hidden: true }); let zipFor = '';
  // A Hugging Face model's page: offered to the model window, where its files can be picked.
  const hfBox = h('div', { class: 'plan-note hf-offer', hidden: true });
  // (A link to an iOS app, on an iPhone: offered to the installer — SideStore, AltStore, TrollStore.)
  const peekIpa = (u: string | null): boolean => { if (!u || !/\.ipa(\?|$)/i.test(u) || !isIos()) return false; hfBox.hidden = false; hfBox.replaceChildren(icon('apps'), h('span', { class: 'grow' }, t('ipaOffer')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void import('./ipa').then((m) => m.ipaSheet({ url: u })); } }, t('ipaInstallIt'))); return true; };
  const peekHf = (u: string | null) => peekIpa(u) || void import('../hf/hf').then((HF) => {
    if (!u || !HF.isHfLink(u)) { hfBox.hidden = true; void import('../downloads/social').then((S) => { if (!u || !S.socialOf(u)) return; hfBox.hidden = false; hfBox.replaceChildren(icon('images'), h('span', { class: 'grow' }, t('socialOffer')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void import('../downloads/prism').then((m) => m.grabberSheet(u)); } }, t('socialOpen'))); }); return; }
    hfBox.hidden = false; hfBox.replaceChildren(icon('puzzle'), h('span', { class: 'grow' }, t('hfOffer')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void import('./models').then((m) => m.modelsSheet(u)); } }, t('hfOpen')));
  });
  sh.body.append(ta, hfBox, video.el, tools, fileNote, fileIn, filesBox, zipBox, saveAs, quick, debridRow, opts);
  const go = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('addStart')) as HTMLButtonElement;
  sh.actions.append(go);
  // (One torrent typed or chosen: its files, to pick from, once the engine has read its metadata.)
  const peekZip = async (u: string | null) => { if (!u || !/\.(zip|cbz|apks|xapk|apkm)(\?|$)/i.test(u)) { zipBox.hidden = true; zipFor = ''; return; } if (zipFor === u) return; zipFor = u; zipBox.hidden = false; zipBox.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('zipPeeking')}`)); const m = await import('../downloads/prism'); const r = await m.remoteZipEntries(u).catch(() => null); if (zipFor !== u) return; if (!r) { zipBox.hidden = true; return; } zipBox.replaceChildren(h('details', null, h('summary', null, `${t('archiveContents')} · ${countFiles(r.entries.length)} · ${formatBytes(r.total)}`), h('div', { class: 'file-rows' }, ...r.entries.slice(0, 300).map((e) => h('div', { class: 'file-row' }, h('span', { class: 'grow', dir: 'ltr' }, e.path), h('small', { class: 'src' }, formatBytes(e.size))))))); };
  const metadata = async () => {
    { const one = sources(); const u = one.length === 1 && one[0].url ? one[0].url : null; video.check(u); void peekZip(u); peekHf(u); void lookAt(u, one[0]?.headers); saveAs.classList.toggle('many', one.length > 1 || !!(one[0]?.magnet || one[0]?.torrent)); }
    if (!eng.torrentInfo || !eng.can.pickFiles) return;
    const srcs = sources(); if (srcs.length !== 1 || !(srcs[0].magnet || srcs[0].torrent)) { filesBox.hidden = true; info = null; return; }
    const my = ++metaToken;
    filesBox.hidden = false; filesBox.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('fetchingMetadata')}`));
    try {
      const got = await eng.torrentInfo(srcs[0]); if (my !== metaToken) return;
      info = got; const pf = await import('./pickFiles'); const fs = pf.guess(got); chosen = new Set(pf.defaultPick(fs)); drawFiles(fs, pf.fileChooser);
    } catch { if (my === metaToken) filesBox.hidden = true; }
  };
  // (Each file's episode read from its name; extras — creditless openings, previews, samples — left unticked.)
  const drawFiles = (fs: import('./pickFiles').FileGuess[], chooser: typeof import('./pickFiles').fileChooser) => {
    if (!info) return;
    filesBox.replaceChildren(h('div', { class: 'add-files-head' }, h('b', { dir: 'auto' }, info.name)), chooser(fs, chosen, () => undefined));
  };
  // (A link handed over by the app's browser: the site's cookies, page and identity go with it.)
  const sources = (): TaskSource[] => { const ref = referer.value.trim(); const out = parseSources(ta.value).map((x) => (how.headers && x.url && x.url === initial.trim() ? { ...x, headers: how.headers } : x)).map((x) => (ref && x.url ? { ...x, headers: { ...(x.headers ?? {}), Referer: ref } } : x)); if (torrentFile) out.push({ torrent: torrentFile.b64 }); return out; };
  let typeTimer = 0; ta.addEventListener('input', () => { clearTimeout(typeTimer); typeTimer = window.setTimeout(() => void metadata(), 600); });
  if (initial) void metadata();
  go.addEventListener('click', async () => {
    const srcs = sources();
    if (!srcs.length) { toast(t('invalidLink'), 'error'); ta.focus(); return; }
    if (!debridRow.hidden && viaDebrid.checked) {
      go.disabled = true;
      try { const { sendToDebrid } = await import('../debrid/transfers'); for (const src of srcs) { const r = await sendToDebrid(src, { dir: getSettings().downloadDir || undefined, name: srcs.length === 1 && name.value.trim() ? `${name.value.trim()}${ext.value.trim() ? `.${ext.value.trim()}` : ''}` : undefined }); toast(r.kind === 'cloud' ? t('debridSent', { name: r.name }) : t('taskAdded', { name: r.name })); } sh.close(); }
      catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); go.disabled = false; }
      return;
    }
    if (!eng.can.torrents && srcs.some((x) => x.magnet || x.torrent)) { toast(t('noEngine'), 'error'); return; }
    // (Already in the list — the same link, or the same torrent by its info-hash —: asked before adding it again.)
    { const { duplicateOf } = await import('../downloads/extras'); const have = await eng.list().catch(() => []); const dup = srcs.map((x) => duplicateOf(x, have)).find(Boolean);
      if (dup && !(await askDuplicate(dup.name))) return; }
    go.disabled = true;
    // A page yt-dlp read (one video, or a playlist's videos), and video-site links among several: video tasks.
    const videoDir = dirChosen ? (getSettings().downloadDir || undefined) : (categoryDir(categoryOf('x.mp4')) ?? (getSettings().downloadDir || undefined));
    try {
      await video.busy();
      const picks = video.picks();
      if (picks) { const { match } = await import('../downloads/rules'); for (const p of picks) { const rule = match({ url: p.url }, 'video'); await eng.add({ source: { url: p.url }, dir: dirChosen ? videoDir : (rule?.then.dir || videoDir), paused: paused.checked, video: { ...p.video, ...(rule?.then.audioOnly ? { audioOnly: true, format: undefined, container: undefined } : {}), ...(rule?.then.subs ? { subs: rule.then.subs } : {}) }, ...(rule?.then.wifiOnly || rule?.then.later ? { meta: { ...(rule.then.wifiOnly ? { wifiOnly: true } : {}), ...(rule.then.later ? { later: true } : {}) } } : {}) }); } toast(t('taskAdded', { name: picks.length === 1 ? (picks[0].video.title ?? picks[0].url) : picks[0].video.title ?? '' })); sh.close(); return; }
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); go.disabled = false; return; }
    try {
      for (const src of srcs) {
        if (srcs.length > 1 && src.url && videoEnabled() && isVideoHost(src.url)) { const tk = await eng.add({ source: src, dir: videoDir, paused: paused.checked, video: { ...preferredFormat(), container: preferredFormat().audioOnly ? undefined : getSettings().videoContainer, embedThumb: getSettings().videoEmbedThumb, sponsorblock: getSettings().videoSponsor } }); toast(t('taskAdded', { name: tk.name || src.url })); continue; }
        const videoish = !!src.magnet || !!src.torrent || isVideo(src.url ?? '');
        if (info && srcs.length === 1 && !chosen.size) { toast(t('pickNoneChosen'), 'error'); go.disabled = false; return; }
        const files = info && srcs.length === 1 && chosen.size < info.files.length ? [...chosen] : undefined;
        const catDir = !getSettings().downloadDir ? undefined : categoryDir(categoryOf(src.url ? decodeURIComponent(src.url.split('?')[0].split('/').pop() ?? '') : magnetName(src.magnet ?? '') ?? '', src.magnet || src.torrent ? 'torrent' : 'http'));
        const wait = later.checked && !(await import('../downloads/prism')).inWindow();
        const fullName = srcs.length === 1 && name.value.trim() ? `${hidden.checked && !name.value.trim().startsWith('.') ? '.' : ''}${name.value.trim()}${ext.value.trim() ? `.${ext.value.trim().replace(/^\.+/, '')}` : ''}` : undefined;
        const meta: NonNullable<Task['meta']> = {}; if (later.checked) meta.later = true; if (wifi.checked) meta.wifiOnly = true; if (!retry.checked) meta.noRetry = true; if (hidden.checked) meta.hidden = true;
        // (A rule that fits the link: its folder, its «later» and «Wi‑Fi only», its connections — unless the reader chose otherwise here.)
        const { match, kindOf } = await import('../downloads/rules'); const rule = match(src, kindOf(src, !!src.url && isVideoHost(src.url)));
        if (rule?.then.later) meta.later = true; if (rule?.then.wifiOnly) meta.wifiOnly = true;
        const tk = await eng.add({ source: src, dir: dirChosen ? (getSettings().downloadDir || undefined) : (rule?.then.dir || catDir || getSettings().downloadDir || undefined), name: fullName, sequential: videoish && seq.checked, paused: paused.checked || wait || (!!rule?.then.later && !(await import('../downloads/prism')).inWindow()), connections: rule?.then.connections || Number(conn.value) || 8, files, ...(Object.keys(meta).length ? { meta } : {}) });
        toast(t('taskAdded', { name: tk.name || magnetName(src.magnet ?? '') || src.url || '' }));
      }
      sh.close();
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); go.disabled = false; }
  });
  if (how.video) ta.placeholder = t('fabVideoHint');
  if (how.torrent) { const f = how.torrent; void f.arrayBuffer().then((b) => { torrentFile = { name: f.name, b64: toBase64(b) }; fileNote.textContent = f.name; fileNote.hidden = false; void metadata(); }); }
  else if (how.pickTorrent) fileIn.click(); else setTimeout(() => ta.focus(), 60);
}

/** «Already in your downloads»: added again, or not. */
function askDuplicate(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false; const sh = openSheet(t('dupTitle'), t('cancel'), { stack: true }); const end = (v: boolean) => { if (done) return; done = true; sh.close(); resolve(v); };
    sh.body.append(h('p', null, t('dupBody')), h('p', { class: 'src', dir: 'auto' }, name));
    sh.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => end(false) }, t('cancel')), h('button', { type: 'button', class: 'btn primary', onclick: () => end(true) }, t('dupAddAgain')));
    const mo = new MutationObserver(() => { if (!sh.el.isConnected) { mo.disconnect(); if (!done) { done = true; resolve(false); } } }); mo.observe(document.body, { childList: true });
  });
}
