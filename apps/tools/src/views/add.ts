// A new download: links or magnets typed or pasted (several at once), a .torrent file chosen; the folder, the
// name, the connections; for a torrent, its files picked once the metadata is here.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t, formatBytes, localDigits, countFiles } from '../i18n';
import { getEngine, parseSources, isVideo, magnetName } from '../engine';
import type { TaskSource, TorrentInfo } from '../engine/types';
import { canArchive, pickFiles } from '../archives';
import { categoryOf, categoryDir } from '../downloads/categories';
import { getSettings, updateSettings } from '../settings';
import { ktPlugin } from '../native';
import { videoPanel, preferredFormat } from './addVideo';
import { videoEnabled, isVideoHost } from '../video/ytdlp';

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
  const pick = async () => { try { let d: string | null = null; if (window.kurokawaTools?.pickDir) d = await window.kurokawaTools.pickDir(); else if (ktPlugin()) d = (await ktPlugin()!.pickDir()).dir; if (d) { updateSettings({ downloadDir: d }); dir.textContent = d; dirChosen = true; } } catch (e) { toast(String((e as Error).message ?? e), 'error'); } };
  const name = h('input', { type: 'text', dir: 'auto', placeholder: t('fileName'), value: how.name ?? '' }) as HTMLInputElement;
  const seq = h('input', { type: 'checkbox', checked: s.sequentialVideo }) as HTMLInputElement;
  const paused = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const later = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const conn = h('input', { type: 'number', min: '1', max: '16', value: '16', style: { width: '5em' } }) as HTMLInputElement;
  const filesBox = h('div', { class: 'add-files', hidden: true });
  let info: TorrentInfo | null = null; let chosen = new Set<number>(); let metaToken = 0;
  const opts = h('details', { class: 'add-options' }, h('summary', null, t('addAdvanced')),
    h('div', { class: 'dest-row static' }, icon('folder'), h('span', { class: 'label' }, t('saveTo')), dir, (window.kurokawaTools || ktPlugin()) ? h('button', { type: 'button', class: 'btn text small', onclick: () => void pick() }, t('changeFolder')) : null),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('fileName')), name),
    h('label', { class: 'check-row' }, seq, h('span', null, t('sequential'))),
    h('label', { class: 'check-row' }, paused, h('span', null, t('startPaused'))),
    ...(getSettings().schedule.enabled ? [h('label', { class: 'check-row' }, later, h('span', null, t('downloadLater')))] : []),
    h('label', { class: 'field row' }, h('span', { class: 'label' }, t('connections')), conn));
  // Through a debrid service (the Debrid add-on with a key): the cloud fetches it, the app downloads the result.
  const viaDebrid = h('input', { type: 'checkbox', checked: getSettings().debridDefault }) as HTMLInputElement;
  const debridRow = h('label', { class: 'check-row debrid-row', hidden: true }, viaDebrid, h('span', null, t('viaDebrid')));
  void import('../debrid').then(async (m) => { const svc = await m.preferredDebrid(); if (svc) { debridRow.hidden = false; debridRow.lastChild!.textContent = t('viaDebridNamed', { service: svc.name }); } });
  const video = videoPanel(() => undefined);
  const zipBox = h('div', { class: 'add-files', hidden: true }); let zipFor = '';
  // A Hugging Face model's page: offered to the model window, where its files can be picked.
  const hfBox = h('div', { class: 'plan-note hf-offer', hidden: true });
  const peekHf = (u: string | null) => void import('../hf/hf').then((HF) => {
    if (!u || !HF.isHfLink(u)) { hfBox.hidden = true; void import('../downloads/social').then((S) => { if (!u || !S.socialOf(u)) return; hfBox.hidden = false; hfBox.replaceChildren(icon('images'), h('span', { class: 'grow' }, t('socialOffer')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void import('../downloads/prism').then((m) => m.grabberSheet(u)); } }, t('socialOpen'))); }); return; }
    hfBox.hidden = false; hfBox.replaceChildren(icon('puzzle'), h('span', { class: 'grow' }, t('hfOffer')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void import('./models').then((m) => m.modelsSheet(u)); } }, t('hfOpen')));
  });
  sh.body.append(ta, hfBox, video.el, tools, fileNote, fileIn, filesBox, zipBox, debridRow, opts);
  const go = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('addStart')) as HTMLButtonElement;
  sh.actions.append(go);
  // (One torrent typed or chosen: its files, to pick from, once the engine has read its metadata.)
  const peekZip = async (u: string | null) => { if (!u || !/\.(zip|cbz|apks|xapk|apkm)(\?|$)/i.test(u)) { zipBox.hidden = true; zipFor = ''; return; } if (zipFor === u) return; zipFor = u; zipBox.hidden = false; zipBox.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('zipPeeking')}`)); const m = await import('../downloads/prism'); const r = await m.remoteZipEntries(u).catch(() => null); if (zipFor !== u) return; if (!r) { zipBox.hidden = true; return; } zipBox.replaceChildren(h('details', null, h('summary', null, `${t('archiveContents')} · ${countFiles(r.entries.length)} · ${formatBytes(r.total)}`), h('div', { class: 'file-rows' }, ...r.entries.slice(0, 300).map((e) => h('div', { class: 'file-row' }, h('span', { class: 'grow', dir: 'ltr' }, e.path), h('small', { class: 'src' }, formatBytes(e.size))))))); };
  const metadata = async () => {
    { const one = sources(); video.check(one.length === 1 && one[0].url ? one[0].url : null); void peekZip(one.length === 1 && one[0].url ? one[0].url : null); peekHf(one.length === 1 && one[0].url ? one[0].url : null); }
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
  const sources = (): TaskSource[] => { const out = parseSources(ta.value).map((x) => (how.headers && x.url && x.url === initial.trim() ? { ...x, headers: how.headers } : x)); if (torrentFile) out.push({ torrent: torrentFile.b64 }); return out; };
  let typeTimer = 0; ta.addEventListener('input', () => { clearTimeout(typeTimer); typeTimer = window.setTimeout(() => void metadata(), 600); });
  if (initial) void metadata();
  go.addEventListener('click', async () => {
    const srcs = sources();
    if (!srcs.length) { toast(t('invalidLink'), 'error'); ta.focus(); return; }
    if (!debridRow.hidden && viaDebrid.checked) {
      go.disabled = true;
      try { const { sendToDebrid } = await import('../debrid/transfers'); for (const src of srcs) { const r = await sendToDebrid(src, { dir: getSettings().downloadDir || undefined, name: srcs.length === 1 && name.value.trim() ? name.value.trim() : undefined }); toast(r.kind === 'cloud' ? t('debridSent', { name: r.name }) : t('taskAdded', { name: r.name })); } sh.close(); }
      catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); go.disabled = false; }
      return;
    }
    if (!eng.can.torrents && srcs.some((x) => x.magnet || x.torrent)) { toast(t('noEngine'), 'error'); return; }
    go.disabled = true;
    // A page yt-dlp read (one video, or a playlist's videos), and video-site links among several: video tasks.
    const videoDir = dirChosen ? (getSettings().downloadDir || undefined) : (categoryDir(categoryOf('x.mp4')) ?? (getSettings().downloadDir || undefined));
    try {
      await video.busy();
      const picks = video.picks();
      if (picks) { for (const p of picks) await eng.add({ source: { url: p.url }, dir: videoDir, paused: paused.checked, video: p.video }); toast(t('taskAdded', { name: picks.length === 1 ? (picks[0].video.title ?? picks[0].url) : picks[0].video.title ?? '' })); sh.close(); return; }
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); go.disabled = false; return; }
    try {
      for (const src of srcs) {
        if (srcs.length > 1 && src.url && videoEnabled() && isVideoHost(src.url)) { const tk = await eng.add({ source: src, dir: videoDir, paused: paused.checked, video: { ...preferredFormat(), container: preferredFormat().audioOnly ? undefined : getSettings().videoContainer, embedThumb: getSettings().videoEmbedThumb, sponsorblock: getSettings().videoSponsor } }); toast(t('taskAdded', { name: tk.name || src.url })); continue; }
        const videoish = !!src.magnet || !!src.torrent || isVideo(src.url ?? '');
        if (info && srcs.length === 1 && !chosen.size) { toast(t('pickNoneChosen'), 'error'); go.disabled = false; return; }
        const files = info && srcs.length === 1 && chosen.size < info.files.length ? [...chosen] : undefined;
        const catDir = !getSettings().downloadDir ? undefined : categoryDir(categoryOf(src.url ? decodeURIComponent(src.url.split('?')[0].split('/').pop() ?? '') : magnetName(src.magnet ?? '') ?? '', src.magnet || src.torrent ? 'torrent' : 'http'));
        const wait = later.checked && !(await import('../downloads/prism')).inWindow();
        const tk = await eng.add({ source: src, dir: dirChosen ? (getSettings().downloadDir || undefined) : (catDir ?? getSettings().downloadDir ?? undefined), name: srcs.length === 1 && name.value.trim() ? name.value.trim() : undefined, sequential: videoish && seq.checked, paused: paused.checked || wait, connections: Number(conn.value) || 8, files, ...(later.checked ? { meta: { later: true } as never } : {}) });
        toast(t('taskAdded', { name: tk.name || magnetName(src.magnet ?? '') || src.url || '' }));
      }
      sh.close();
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); go.disabled = false; }
  });
  if (how.video) ta.placeholder = t('fabVideoHint');
  if (how.torrent) { const f = how.torrent; void f.arrayBuffer().then((b) => { torrentFile = { name: f.name, b64: toBase64(b) }; fileNote.textContent = f.name; fileNote.hidden = false; void metadata(); }); }
  else if (how.pickTorrent) fileIn.click(); else setTimeout(() => ta.focus(), 60);
}
