// The Add sheet's smart part: a link that is a page rather than a file is shown to yt-dlp (the Video add-on), and
// what it finds — the title and picture, the qualities, the audio, the subtitles, a playlist's videos — appears in
// the same sheet to pick from. A page yt-dlp cannot read is downloaded as an ordinary link; a video site's page
// without the add-on offers to add it there and then.
import { h, icon, closeSheets } from '../ui/dom';
import { t, formatBytes, localDigits, countVideos } from '../i18n';
import { getSettings } from '../settings';
import { nativePlatform as getPlatform, ktPlugin } from '../native';
import { noteChanges } from '../video/snapshots';
import type { AddOptions } from '../engine/types';
import { VIDEO_ADDON, isVideoHost, looksLikeFile, pageInfo, videoEnabled, videoSupported, type PageInfo, type VideoChoice } from '../video/ytdlp';

export type VideoPick = NonNullable<AddOptions['video']>;
export interface VideoPanel {
  el: HTMLElement;
  /** Looks at one link (or clears the panel for anything else). */
  check(url: string | null): void;
  /** What to add for the link checked: one video, a playlist's videos, or null (an ordinary download). */
  picks(): { url: string; video: VideoPick }[] | null;
  /** Whether a check is still running (the Download button waits for it). */
  busy(): Promise<void>;
}

const dur = (s?: number) => { if (!s || !isFinite(s)) return ''; s = Math.round(s); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits((hh ? `${hh}:${String(m).padStart(2, '0')}:` : `${m}:`) + String(sec).padStart(2, '0')); };
/** The preferred quality as a yt-dlp format (for links added without a look, and a playlist's videos). */
export function preferredFormat(): Pick<VideoPick, 'format' | 'audioOnly' | 'label'> {
  const q = getSettings().videoQuality;
  if (q === 'audio') return { format: 'bestaudio/best', audioOnly: true, label: t('videoAudioOnly') };
  if (q === 'best') return { format: undefined, label: t('videoBest') };
  return { format: `bestvideo[height<=${q}]+bestaudio/best[height<=${q}]`, label: `${q}p` };
}
/** A link worth asking yt-dlp about: a web page (a video site's, or any page not naming a file). */
export const pageLike = (url: string): boolean => /^https?:\/\//i.test(url) && (isVideoHost(url) || (/\.(m3u8|mpd)(\?|$)/i.test(url) && !nativeHls(url)) || !looksLikeFile(url));
/** An HLS playlist the app fetches itself (pieces joined here), unless yt-dlp was chosen for streams. */
export const nativeHls = (url: string): boolean => getPlatform() === 'android' && !!ktPlugin() && getSettings().hlsNative !== false && /\.m3u8(\?|#|$)/i.test(url);

export function videoPanel(onChange: () => void): VideoPanel {
  const el = h('div', { class: 'video-panel', hidden: true });
  const part = { on: false, from: '', to: '', more: '' as string }; const chap = { split: false, match: '' }; let bilingual = false; let changeNote: string | null = null;
  let url: string | null = null; let info: PageInfo | null = null; let chosen: VideoChoice | null = null; let subs = false; let token = 0; let running: Promise<void> = Promise.resolve();
  const s = getSettings();
  const pickDefault = (i: PageInfo) => {
    if (i.kind !== 'video') return;
    const q = s.videoQuality;
    if (q === 'audio') chosen = i.audio[0] ?? null;
    else if (q === 'best') chosen = i.choices[0] ?? null;
    else chosen = i.choices.find((c) => (c.height ?? 0) <= Number(q)) ?? i.choices[i.choices.length - 1] ?? null;
    subs = s.subLangs.some((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
  };
  const draw = () => {
    if (!info) return;
    if (info.kind === 'playlist') {
      const pf = preferredFormat();
      el.replaceChildren(h('div', { class: 'video-card' }, h('span', { class: 'video-thumb none' }, icon('list')),
        h('div', { class: 'video-text' }, h('b', { dir: 'auto' }, info.title || url || ''), h('small', { class: 'src' }, `${countVideos(info.count)} · ${pf.label}`))));
      return;
    }
    const i = info;
    const chip = (c: VideoChoice) => h('button', { type: 'button', class: `chip small${chosen?.id === c.id ? ' on' : ''}`, 'aria-pressed': String(chosen?.id === c.id), onclick: () => { chosen = c; draw(); onChange(); } },
      c.kind === 'audio' ? icon('music') : null, h('span', { dir: 'ltr' }, c.label), c.size ? h('small', { class: 'src' }, formatBytes(c.size)) : null);
    const meta = [i.uploader, dur(i.duration), i.site].filter(Boolean).join(' · '); const changed = changeNote;
    const langs = s.subLangs.filter((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
    el.replaceChildren(...[
      h('p', { class: 'video-ready' }, icon('check'), t('videoYtdlpReadyShort')),
      // (Seen before and not the same: said before it is fetched again.)
      changed ? h('p', { class: 'src danger video-changed', dir: 'auto' }, icon('alert'), ' ', t('mediaChanged'), ': ', changed) : null,
      h('div', { class: 'video-card' },
        i.thumbnail ? h('img', { class: 'video-thumb', src: i.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'video-thumb none' }, icon('film')),
        h('div', { class: 'video-text' }, h('b', { dir: 'auto' }, i.title), meta ? h('small', { class: 'src', dir: 'auto' }, meta) : null, i.live ? h('span', { class: 'badge live' }, t('videoLive')) : null)),
      i.choices.length ? h('div', { class: 'video-choices' }, h('span', { class: 'label' }, t('videoQuality')), h('div', { class: 'chip-row wrap' }, ...i.choices.map(chip))) : null,
      i.audio.length ? h('div', { class: 'video-choices' }, h('span', { class: 'label' }, t('videoAudioOnly')), h('div', { class: 'chip-row wrap' }, ...i.audio.map(chip))) : null,
      langs.length ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: subs, onchange: (e: Event) => { subs = (e.target as HTMLInputElement).checked; } }), h('span', null, t('videoSubs', { langs: langs.join('، ') }))) : null,
      // (Which of the wanted languages the page has, which only as automatic captions, which not at all — before any is asked for.)
      s.subLangs.length ? h('div', { class: 'chip-row wrap video-sub-probe' }, ...s.subLangs.map((l) => { const has = langs.includes(l); const auto = !has && (i.autoSubs ?? []).some((x) => x === l || x.startsWith(`${l}-`)); return h('span', { class: 'chip small' + (has ? ' on' : auto ? ' auto' : ' off'), title: has ? t('subHave') : auto ? t('subAuto') : t('subMissing') }, icon(has ? 'check' : auto ? 'alert' : 'close'), ' ', l, auto ? ` (${t('subAutoShort')})` : ''); })) : null,
      langs.length >= 2 ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: bilingual, onchange: (e: Event) => { bilingual = (e.target as HTMLInputElement).checked; } }), h('span', null, t('videoBilingual', { a: langs[0], b: langs[1] }), h('small', { class: 'src' }, t('videoBilingualHint')))) : null,
      // Only a part (Prism's): from–to, as 1:30 or 1:02:00.
      i.duration && !i.live ? h('div', { class: 'video-part' }, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: part.on, onchange: (e: Event) => { part.on = (e.target as HTMLInputElement).checked; draw(); onChange(); } }), h('span', null, t('videoPart'))),
        part.on ? h('span', { class: 'video-part-range', dir: 'ltr' }, h('input', { type: 'text', inputmode: 'numeric', value: part.from || '0:00', placeholder: '0:00', 'aria-label': t('videoPartFrom'), oninput: (e: Event) => { part.from = (e.target as HTMLInputElement).value; } }), '–', h('input', { type: 'text', inputmode: 'numeric', value: part.to || dur(i.duration).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))), placeholder: '1:00', 'aria-label': t('videoPartTo'), oninput: (e: Event) => { part.to = (e.target as HTMLInputElement).value; } })) : null,
        part.on ? h('input', { type: 'text', class: 'video-part-more', dir: 'ltr', value: part.more, placeholder: t('videoPartMoreHint'), 'aria-label': t('videoPartMore'), oninput: (e: Event) => { part.more = (e.target as HTMLInputElement).value; } }) : null) : null,
      // Chapters: the file split into one file a chapter, or only the chapters whose names match a pattern.
      i.duration && !i.live ? h('div', { class: 'video-part' }, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: chap.split, onchange: (e: Event) => { chap.split = (e.target as HTMLInputElement).checked; } }), h('span', null, t('videoSplitChapters'))),
        h('input', { type: 'text', class: 'video-part-more', dir: 'auto', value: chap.match, placeholder: t('videoChapterMatchHint'), 'aria-label': t('videoChapterMatch'), oninput: (e: Event) => { chap.match = (e.target as HTMLInputElement).value; } })) : null].filter((x): x is NonNullable<typeof x> => !!x));
  };
  const offerAddon = () => {
    el.hidden = false;
    el.replaceChildren(h('div', { class: 'video-card offer' }, h('span', { class: 'video-thumb none' }, icon('film')), h('div', { class: 'video-text' }, h('span', null, t('videoYtdlpMissingLong'))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; const { needAddon } = await import('../addons/need'); if (await needAddon(VIDEO_ADDON, t('addonWhyVideo'), { start: true })) { const u = url; url = null; check(u); } else b.disabled = false; } }, t('videoAddIt')),
      h('button', { type: 'button', class: 'btn text small', onclick: () => { closeSheets(); void import('../router').then((r) => r.navigate('/settings/addons')); } }, t('videoOpenAddons'))));
  };
  const check = (u: string | null) => {
    if (u === url) return; url = u; info = null; chosen = null; const my = ++token;
    if (!u || !pageLike(u)) { el.hidden = true; el.replaceChildren(); onChange(); return; }
    if (!videoEnabled()) { if (videoSupported() && isVideoHost(u)) offerAddon(); else { el.hidden = true; el.replaceChildren(); } onChange(); return; }
    el.hidden = false; el.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('videoChecking')}`));
    const playlist = /[?&]list=|\/playlist\b|\/sets\/|\/album\//i.test(u) && !/[?&]v=/.test(u);
    running = pageInfo(u, playlist).then((got) => { if (my !== token) return; info = got; changeNote = got.kind === 'video' ? noteChanges(got) : null; pickDefault(got); draw(); onChange(); }, () => {
      if (my !== token) return;
      // Not a page yt-dlp reads: an ordinary download, said quietly only when a video site was expected.
      if (isVideoHost(u)) { el.replaceChildren(h('p', { class: 'src small' }, t('videoFallback'))); } else { el.hidden = true; el.replaceChildren(); }
      onChange();
    });
  };
  const base = (audio = false): Omit<VideoPick, 'format' | 'audioOnly' | 'label'> => ({ container: audio ? undefined : s.videoContainer, embedThumb: s.videoEmbedThumb, sponsorblock: s.videoSponsor, sponsorMode: s.videoSponsorMode ?? (s.videoSponsor ? 'remove' : 'off'), sponsorCats: (s.videoSponsorCats ?? ['sponsor']).join(','), infoJson: s.sidecarNfo || undefined, cover: s.sidecarCover || undefined, chapters: s.videoChapters !== false, template: s.videoTemplate || undefined, cookies: s.videoCookies || undefined });
  return {
    el, check, busy: () => running,
    picks() {
      if (!url || !info) return null;
      if (info.kind === 'playlist') return info.entries.filter((e) => e.url).map((e, n) => ({ url: e.url, video: { ...base(preferredFormat().audioOnly), ...preferredFormat(), title: e.title, playlistIndex: s.videoNumber === false ? undefined : n + 1 } }));
      const i = info; const c = chosen;
      const langs = s.subLangs.filter((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
      const sec = part.on && part.from.trim() && part.to.trim() ? [`${part.from.trim()}-${part.to.trim()}`, ...part.more.split(/[,;\s]+/).filter((r) => /^[\d:.]+-[\d:.]+$/.test(r))].join(',') : undefined;
      const chapterMatch = chap.match.trim() ? chap.match.trim() : undefined;
      return [{ url: i.url || url, video: { ...base(c?.kind === 'audio'), format: c?.id, audioOnly: c?.kind === 'audio', label: c?.label, title: i.title, site: i.site, thumbnail: i.thumbnail, subs: subs && langs.length ? langs.join(',') : undefined, section: sec, chapterMatch, splitChapters: chap.split || undefined, bilingual: subs && bilingual && langs.length >= 2 ? `${langs[0]},${langs[1]}` : undefined } }];
    },
  };
}
