// The Add sheet's smart part: a link that is a page rather than a file is shown to yt-dlp (the Video add-on), and
// what it finds — the title and picture, the qualities, the audio, the subtitles, a playlist's videos — appears in
// the same sheet to pick from. A page yt-dlp cannot read is downloaded as an ordinary link; a video site's page
// without the add-on offers to add it there and then.
import { h, icon, closeSheets } from '../ui/dom';
import { t, formatBytes, localDigits, countVideos } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { nativePlatform as getPlatform, ktPlugin } from '../native';
import { noteChanges } from '../video/snapshots';
import { defaultOptions, hasSavedChoice, saveDefaults, ffmpegHere, gateFfmpeg, build, audioName } from '../video/choice';
import { chooser, summary, heightsOf } from './videoChooser';
import { safeRange, type VideoOptions } from '../downloads/videoArgs';
import type { AddOptions } from '../engine/types';
import { VIDEO_ADDON, isVideoHost, looksLikeFile, pageInfo, videoEnabled, videoSupported, type PageInfo, type PlaylistInfo, type VideoInfo } from '../video/ytdlp';

export type VideoPick = NonNullable<AddOptions['video']>;
export interface VideoPanel {
  el: HTMLElement;
  /** Looks at one link (or clears the panel for anything else). */
  check(url: string | null): void;
  /** What to add for the link checked: one video, a playlist's videos, or null (an ordinary download) — non-null
   *  once yt-dlp has read the page, so the sheet can drop an ordinary file's parts. */
  picks(): { url: string; video: VideoPick }[] | null;
  /** Whether a check is still running (the Download button waits for it, a setup and the read after it included). */
  busy(): Promise<void>;
  /** The sign-in (a cookie jar) the page is read with; a change reads it again. */
  setJar(id: string): void;
  /** A video site's link the panel could not read (yt-dlp missing or refusing it): not to be saved as a page. */
  unread(): boolean;
  /** Just before adding: the choice kept as the default, and ffmpeg offered when the choice needs it (false: declined, add nothing). */
  gate(): Promise<boolean>;
}

const dur = (s?: number) => { if (!s || !isFinite(s)) return ''; s = Math.round(s); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits((hh ? `${hh}:${String(m).padStart(2, '0')}:` : `${m}:`) + String(sec).padStart(2, '0')); };
/** What the default says in short (for the links added without a look: a hotkey, a follow, a course): audio or video, and how it is named. */
export function preferredFormat(): Pick<VideoPick, 'format' | 'audioOnly' | 'label'> {
  const o = defaultOptions();
  return { format: undefined, audioOnly: o.mode === 'audio', label: summary(o) };
}
/** A link worth asking yt-dlp about: a web page (a video site's, or any page not naming a file). */
export const pageLike = (url: string): boolean => /^https?:\/\//i.test(url) && (isVideoHost(url) || (/\.(m3u8|mpd)(\?|$)/i.test(url) && !nativeHls(url)) || !looksLikeFile(url));
/** An HLS playlist the app fetches itself (pieces joined here), unless yt-dlp was chosen for streams. */
export const nativeHls = (url: string): boolean => getPlatform() === 'android' && !!ktPlugin() && getSettings().hlsNative !== false && /\.m3u8(\?|#|$)/i.test(url);

/** Whether sign-ins (cookie jars) can be kept here: the Android app's. */
const hasCookieJars = (): boolean => !!(window as unknown as { Capacitor?: { isNativePlatform?(): boolean } }).Capacitor?.isNativePlatform?.();
export function videoPanel(onChange: () => void): VideoPanel {
  const el = h('div', { class: 'video-panel', hidden: true });
  const part = { on: false, from: '', to: '', more: '' as string }; const chap = { match: '' }; let bilingual = false; let changeNote: string | null = null;
  let url: string | null = null; let info: PageInfo | null = null; let token = 0; let running: Promise<void> = Promise.resolve();
  const s = getSettings();
  // What to get: the default (the last choice) to begin with; a playlist's videos (a link with a list beside the video: read once, when asked for).
  let opts: VideoOptions = defaultOptions(); let ff = true; let listInfo: PlaylistInfo | null = null; let open = s.videoAsk !== false; let withList = false;
  const entriesOf = (): PlaylistInfo | null => (info?.kind === 'playlist' ? info : listInfo);
  const pickDefault = (i: PageInfo) => {
    opts = defaultOptions();
    if (i.kind !== 'video') { opts.playlist = 'all'; return; }
    opts.playlist = 'one'; opts.range = '';
    // (A height this video does not have: the tallest below it — the chooser shows only what is there.)
    const hs = heightsOf(i).map((x) => x.h); if (opts.height && !hs.includes(opts.height)) opts.height = hs.find((x) => x <= opts.height) ?? 0;
    // (Before any choice was kept: the subtitles of the wanted languages are on when the page has them, as before.)
    const have = s.subLangs.filter((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
    if (!hasSavedChoice()) opts.subs = { ...opts.subs, on: have.length > 0 && opts.mode === 'video', langs: have };
    else opts.subs.langs = opts.subs.langs.filter((l) => i.subtitles.includes(l) || (i.autoSubs ?? []).includes(l));
    if (opts.subs.on && !opts.subs.langs.length) opts.subs.on = false;
  };
  /** The videos a playlist choice means: all, or those the range names (their places in the list kept). */
  const chosenEntries = (): { e: PlaylistInfo['entries'][number]; n: number }[] => {
    const pl = entriesOf(); if (!pl) return []; const all = pl.entries.map((e, k) => ({ e, n: k + 1 })).filter((x) => x.e.url);
    if (opts.playlist !== 'range') return all;
    const r = safeRange(opts.range); if (!r) return []; const want = new Set<number>();
    for (const part of r.split(',')) { const [a, b] = part.split('-').map(Number); for (let k = a; k <= (b ?? a) && k - a < 5000; k++) want.add(k); }
    return all.filter((x) => want.has(x.n));
  };
  const loadList = () => {
    if (!url || listInfo || !withList) return; const u = url; const my = token;
    running = pageInfo(u, true, jar ? { cookieJar: jar } : {}).then((got) => { if (my !== token) return; if (got.kind === 'playlist') listInfo = got; draw(); onChange(); }, () => { if (my !== token) return; opts.playlist = 'one'; draw(); onChange(); });
  };
  /** The chooser (or, once the reader has said «use my default», one line with what it is and «Change»). */
  const folds = { adv: false, extras: false };
  const chooserEl = (i: PageInfo): HTMLElement => {
    if (!open) return h('div', { class: 'video-using' }, h('span', { dir: 'auto' }, t('vcUsing', { what: summary(opts) })), h('button', { type: 'button', class: 'btn text small', onclick: () => { open = true; draw(); } }, t('vcChange')));
    return chooser({ info: i, o: opts, ffmpeg: ff, withList, want: s.subLangs, folds, change: () => { onChange(); if (withList && opts.playlist !== 'one') loadList(); }, redraw: () => { draw(); } });
  };
  const askRow = (): HTMLElement | null => (open ? h('label', { class: 'check-row video-ask' }, h('input', { type: 'checkbox', checked: getSettings().videoAsk !== false, onchange: (e: Event) => { updateSettings({ videoAsk: (e.target as HTMLInputElement).checked }); } }), h('span', null, t('vcAlwaysAsk'), h('small', { class: 'src' }, t('vcAlwaysAskHint')))) : null);
  const draw = () => {
    if (!info) return;
    if (info.kind === 'playlist') {
      el.replaceChildren(h('div', { class: 'video-card' }, h('span', { class: 'video-thumb none' }, icon('list')),
        h('div', { class: 'video-text' }, h('b', { dir: 'auto' }, info.title || url || ''), h('small', { class: 'src' }, `${countVideos(chosenEntries().length || info.count)} · ${summary(opts)}`))), chooserEl(info), ...(open ? [askRow()!] : []));
      return;
    }
    const i = info;
    const meta = [i.uploader, dur(i.duration), i.site].filter(Boolean).join(' · '); const changed = changeNote;
    // (Return YouTube Dislike: likes and dislikes of a YouTube video from its open API, when the setting asks.)
    const rydLine = h('p', { class: 'src video-ryd', dir: 'ltr', hidden: true }); if (s.videoRyd !== false && /youtube/i.test(i.site ?? '') && i.id) void import('../http').then(({ request }) => request(`https://returnyoutubedislikeapi.com/votes?videoId=${encodeURIComponent(i.id)}`).then((r) => { if (r.status !== 200) return; const j = JSON.parse(r.body) as { likes?: number; dislikes?: number }; if (j.likes === undefined) return; rydLine.hidden = false; rydLine.textContent = `👍 ${localDigits(j.likes)} · 👎 ${localDigits(j.dislikes ?? 0)}`; }).catch(() => undefined));
    const langs = s.subLangs.filter((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
    const wanted = opts.subs.on ? opts.subs.langs : langs;
    el.replaceChildren(...[
      h('p', { class: 'video-ready' }, icon('check'), t(i.choices.length || i.audio.length ? 'videoYtdlpReadyShort' : 'videoYtdlpBestOnly')),
      // (Seen before and not the same: said before it is fetched again.)
      changed ? h('p', { class: 'src danger video-changed', dir: 'auto' }, icon('alert'), ' ', t('mediaChanged'), ': ', changed) : null,
      rydLine,
      h('div', { class: 'video-card' },
        i.thumbnail ? h('img', { class: 'video-thumb', src: i.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'video-thumb none' }, icon('film')),
        h('div', { class: 'video-text' }, h('b', { dir: 'auto' }, i.title), meta ? h('small', { class: 'src', dir: 'auto' }, meta) : null, i.live ? h('span', { class: 'badge live' }, t('videoLive')) : null)),
      chooserEl(i),
      // (Which of the wanted languages the page has, which only as automatic captions, which not at all — before any is asked for.)
      s.subLangs.length ? h('div', { class: 'chip-row wrap video-sub-probe' }, ...s.subLangs.map((l) => { const has = langs.includes(l); const auto = !has && (i.autoSubs ?? []).some((x) => x === l || x.startsWith(`${l}-`)); return h('span', { class: 'chip small' + (has ? ' on' : auto ? ' auto' : ' off'), title: has ? t('subHave') : auto ? t('subAuto') : t('subMissing') }, icon(has ? 'check' : auto ? 'alert' : 'close'), ' ', l, auto ? ` (${t('subAutoShort')})` : ''); })) : null,
      opts.subs.on && wanted.length >= 2 && opts.mode === 'video' ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: bilingual, onchange: (e: Event) => { bilingual = (e.target as HTMLInputElement).checked; } }), h('span', null, t('videoBilingual', { a: wanted[0], b: wanted[1] }), h('small', { class: 'src' }, t('videoBilingualHint')))) : null,
      // Only a part (Prism's): from–to, as 1:30 or 1:02:00.
      i.duration && !i.live ? h('div', { class: 'video-part' }, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: part.on, onchange: (e: Event) => { part.on = (e.target as HTMLInputElement).checked; draw(); onChange(); } }), h('span', null, t('videoPart'))),
        part.on ? h('span', { class: 'video-part-range', dir: 'ltr' }, h('input', { type: 'text', inputmode: 'numeric', value: part.from || '0:00', placeholder: '0:00', 'aria-label': t('videoPartFrom'), oninput: (e: Event) => { part.from = (e.target as HTMLInputElement).value; } }), '–', h('input', { type: 'text', inputmode: 'numeric', value: part.to || dur(i.duration).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), placeholder: '1:00', 'aria-label': t('videoPartTo'), oninput: (e: Event) => { part.to = (e.target as HTMLInputElement).value; } })) : null,
        part.on ? h('input', { type: 'text', class: 'video-part-more', dir: 'ltr', value: part.more, placeholder: t('videoPartMoreHint'), 'aria-label': t('videoPartMore'), oninput: (e: Event) => { part.more = (e.target as HTMLInputElement).value; } }) : null) : null,
      // Chapters: only those whose names match a pattern (splitting into files is the chooser's «Chapters»).
      i.duration && !i.live ? h('div', { class: 'video-part' }, h('input', { type: 'text', class: 'video-part-more', dir: 'auto', value: chap.match, placeholder: t('videoChapterMatchHint'), 'aria-label': t('videoChapterMatch'), oninput: (e: Event) => { chap.match = (e.target as HTMLInputElement).value; } })) : null,
      askRow()].filter((x): x is NonNullable<typeof x> => !!x));
  };
  let autoTried = false;
  const offerAddon = () => {
    el.hidden = false;
    el.replaceChildren(h('div', { class: 'video-card offer' }, h('span', { class: 'video-thumb none' }, icon('film')), h('div', { class: 'video-text' }, h('span', null, t('videoYtdlpMissingLong'))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; const { needAddon } = await import('../addons/need'); if (await needAddon(VIDEO_ADDON, t('addonWhyVideo'), { start: true })) { const u = url; url = null; check(u); } else b.disabled = false; } }, t('videoAddIt')),
      h('button', { type: 'button', class: 'btn text small', onclick: () => { closeSheets(); void import('../router').then((r) => r.navigate('/settings/addons')); } }, t('videoOpenAddons'))));
  };
  let jar = '';
  const check = (u: string | null) => {
    if (u === url) return; url = u; info = null; listInfo = null; withList = false; open = getSettings().videoAsk !== false; const my = ++token; void ffmpegHere().then((v) => { ff = v; });
    if (!u || !pageLike(u)) { el.hidden = true; el.replaceChildren(); onChange(); return; }
    // (A video site's link with the video add-on off: it is set up at once — yt-dlp fetched — and the link read, once a
    // session; turned down, the offer stays. What was asked for is a video, never the site's page.)
    if (!videoEnabled()) {
      if (!videoSupported() || !isVideoHost(u)) { el.hidden = true; el.replaceChildren(); onChange(); return; }
      if (autoTried) { offerAddon(); onChange(); return; }
      autoTried = true; el.hidden = false; el.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('videoSettingUp')}`)); onChange();
      running = import('../addons/need').then((m) => m.needAddon(VIDEO_ADDON, t('addonWhyVideo'), { start: true })).then((ok) => { if (my !== token) return; if (ok) { url = null; check(u); } else offerAddon(); }, () => { if (my === token) offerAddon(); });
      return;
    }
    el.hidden = false; el.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('videoChecking')}`));
    const playlist = /[?&]list=|\/playlist\b|\/sets\/|\/album\//i.test(u) && !/[?&]v=/.test(u);
    running = pageInfo(u, playlist, jar ? { cookieJar: jar } : {}).then((got) => { if (my !== token) return; info = got; withList = got.kind === 'video' && /[?&]list=/.test(u) && /[?&]v=|youtu\.be\//.test(u); changeNote = got.kind === 'video' ? noteChanges(got) : null; pickDefault(got); draw(); onChange(); }, (e: unknown) => {
      if (my !== token) return;
      // Not a page yt-dlp reads: an ordinary download, said quietly only when a video site was expected — with
      // yt-dlp's own reason, and, when the site wants a sign-in (Instagram, a YouTube «not a bot» check, a private
      // post), a way to read it with the user's own sign-in: their cookies for it, taken from the app's browser.
      if (isVideoHost(u)) {
        const why = String((e as Error)?.message ?? e ?? '').replace(/^ERROR:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const signIn = /sign ?in|log ?in|login|cookies|rate.?limit|private|not a bot|age.?restrict|members|account/i.test(why);
        el.replaceChildren(h('div', { class: 'video-failed' }, h('p', { class: 'src small' }, t(signIn ? 'videoNeedsSignIn' : 'videoFallback')), why ? h('p', { class: 'src small video-why', dir: 'ltr' }, why) : null,
          signIn && hasCookieJars() ? h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('../downloads/cookies').then((m) => m.signInFor(u, () => { url = null; check(u); })) }, icon('globe'), t('videoUseSignIn')) : null));
      } else { el.hidden = true; el.replaceChildren(); }
      onChange();
    });
  };
  return {
    el, check, setJar: (id: string) => { if (id === jar) return; jar = id; if (url) { const u = url; url = null; check(u); } }, busy: async () => { let r: Promise<void>; do { r = running; await r.catch(() => undefined); } while (r !== running); },
    unread: () => !!url && isVideoHost(url) && !info,
    // (Just before adding: the choice kept as the default — a playlist's part and range belong to one link, not kept —, and ffmpeg asked for when the choice needs it.)
    async gate() {
      if (!url || !info) return true;
      if (getSettings().videoRememberPreset !== false) saveDefaults(opts);
      const more = { playlistIndex: isListMode() ? 1 : undefined, extras: extras() };
      const ok = await gateFfmpeg(build(opts, false, more).needs); ff = await ffmpegHere(); if (!ok) { draw(); onChange(); }
      return ok;
    },
    picks() {
      if (!url || !info) return null;
      const isList = info.kind === 'playlist' || (withList && opts.playlist !== 'one');
      if (isList) {
        const pl = entriesOf(); if (!pl) return null;
        // (A list's videos one task each, so each has its own bar: a task per video, numbered by its place in the list — which also keeps the host's
        // work to the one video, not the list again. The range, when there is one, picks which.)
        return chosenEntries().map(({ e, n }) => ({ url: e.url, video: pick(e.title, undefined, { ...opts, playlist: 'one' }, { playlistIndex: n, playlistTitle: pl.title }) }));
      }
      const i = info as VideoInfo; return [{ url: i.url || url, video: pick(i.title, i, opts, { extras: extras() }, { site: i.site, thumbnail: i.thumbnail }) }];
    },
  };
  /** One pick for the engine: the argument list (the one pure builder) and the few fields the list shows. */
  function pick(title: string | undefined, i: VideoInfo | undefined, o: VideoOptions, more: { playlistIndex?: number; playlistTitle?: string; extras?: NonNullable<Parameters<typeof build>[2]>['extras'] }, shown: Partial<VideoPick> = {}): VideoPick {
    const b = build(o, ff, { playlistIndex: more.playlistIndex, playlistTitle: more.playlistTitle, extras: more.extras });
    const choice = i ? (o.mode === 'audio' ? i.audio[0] : (o.height ? i.choices.find((c) => c.height === o.height) : i.choices[0])) : undefined;
    return { ...shown, title, args: b.args, audioFmt: audioName(o), expect: choice?.size, audioOnly: o.mode === 'audio', container: o.mode === 'audio' ? undefined : o.container, label: summary(o), chapters: o.chapters !== 'off', splitChapters: o.chapters === 'split' || undefined, playlistIndex: more.playlistIndex, playlistTitle: more.playlistTitle, section: more.extras?.section, chapterMatch: more.extras?.chapterMatch, bilingual: more.extras?.bilingual ? o.subs.langs.slice(0, 2).join(',') : undefined, subs: o.subs.on && o.subs.langs.length ? o.subs.langs.join(',') : undefined, cookies: s.videoCookies || undefined };
  }
  function isListMode(): boolean { return !!info && (info.kind === 'playlist' || (withList && opts.playlist !== 'one')); }
  /** The parts the sheet asks for (a time range, chapters by name, two languages in one file). */
  function extras() {
    const sec = part.on && part.from.trim() && part.to.trim() ? [`${part.from.trim()}-${part.to.trim()}`, ...part.more.split(/[,;\s]+/).filter((r) => /^[\d:.]+-[\d:.]+$/.test(r))].join(',') : undefined;
    return { section: sec, chapterMatch: chap.match.trim() || undefined, bilingual: bilingual && opts.subs.on && opts.subs.langs.length >= 2 };
  }
}
