// The chooser inside the Add sheet's video panel: what to get — the video (quality, format, and under «Advanced» the frame rate and
// the codec), or the audio alone (MP3, M4A, Opus, FLAC, WAV) — and the extras (subtitles, thumbnail, chapters, SponsorBlock, playlist,
// file name). It only edits an options object (src/downloads/videoArgs.ts); the arguments are built from it elsewhere.
import { h, icon } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { HEIGHTS, SPONSOR_CATS, buildVideoArgs, normaliseOptions, safeRange, safeTemplate, type AudioFormat, type VideoOptions } from '../downloads/videoArgs';
import type { VideoInfo, PlaylistInfo } from '../video/ytdlp';
import { BUILT_IN, deletePreset, presetsList, savePreset } from '../video/choice';

export interface ChooserCtx {
  info: VideoInfo | PlaylistInfo; o: VideoOptions; ffmpeg: boolean;
  /** The link has a list beside the video (a watch?v=…&list=… link): «this video» is offered next to the whole list and a range. */
  withList: boolean;
  change(): void; redraw(): void;
  /** The user's languages for subtitles (those the page has are offered first). */
  want: string[];
  /** Which folds are open (kept by the panel: a choice redraws the chooser, and a fold the reader opened stays open). */
  folds: { adv: boolean; extras: boolean };
}

const chip = (label: string | Node, on: boolean, onclick: () => void, sub?: string, extra = '') => h('button', { type: 'button', class: `chip small${on ? ' on' : ''}${extra}`, 'aria-pressed': String(on), onclick }, typeof label === 'string' ? h('span', { dir: 'auto' }, label) : label, sub ? h('small', { class: 'src' }, sub) : null);
const block = (label: string, ...kids: (Node | null)[]) => h('div', { class: 'video-choices' }, h('span', { class: 'label' }, label), ...kids.filter((x): x is Node => !!x));
const check = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null));
const sizeText = (n?: number) => (n ? `~${formatBytes(n)}` : undefined);
const FORMATS: AudioFormat[] = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
const HINT: Record<AudioFormat, 'vcHintMp3' | 'vcHintM4a' | 'vcHintOpus' | 'vcHintFlac' | 'vcHintWav'> = { mp3: 'vcHintMp3', m4a: 'vcHintM4a', opus: 'vcHintOpus', flac: 'vcHintFlac', wav: 'vcHintWav' };

/** The heights this video has (the standard ones, and any other), tallest first, with the approximate size of each (the stream with sound added). */
export function heightsOf(info: VideoInfo | PlaylistInfo): { h: number; size?: number }[] {
  if (info.kind !== 'video') return HEIGHTS.filter((x) => x >= 360).map((x) => ({ h: x }));
  const seen = new Map<number, number | undefined>(); for (const c of info.choices) { const hh = c.height ?? 0; if (hh >= 144 && (!seen.has(hh) || (c.size ?? 0) > (seen.get(hh) ?? 0))) seen.set(hh, c.size); }
  return [...seen].map(([hh, size]) => ({ h: hh, size })).sort((a, b) => b.h - a.h);
}
/** A short line for what is chosen: «MP4 · 1080p», «MP3 · 320 kbps». */
export function summary(o: VideoOptions): string {
  if (o.mode === 'audio') return [o.audio.toUpperCase(), o.audio === 'mp3' ? (o.mp3Rate === 'vbr' ? 'VBR' : `${localDigits(o.mp3Rate)} kbps`) : ''].filter(Boolean).join(' · ');
  return [o.container.toUpperCase(), o.height ? `${localDigits(o.height)}p` : t('videoBest')].join(' · ');
}

export function chooser(c: ChooserCtx): HTMLElement {
  const o = c.o; const info = c.info; const v = info.kind === 'video' ? info : null; const set = (fn: () => void) => () => { fn(); c.change(); c.redraw(); };
  const audio = o.mode === 'audio'; const heights = heightsOf(info);
  const fold = (k: 'adv' | 'extras', cls: string, title: string, ...kids: (Node | null)[]) => { const d = h('details', { class: cls, ontoggle: () => { c.folds[k] = d.open; } }, h('summary', null, title), ...kids.filter((x): x is Node => !!x)) as HTMLDetailsElement; if (c.folds[k]) d.open = true; return d; };
  // (What this choice needs ffmpeg for, and what an audio file taken as it is would lose without it.)
  const probe = buildVideoArgs(o, { ffmpeg: false }); const needsNote = !c.ffmpeg && probe.needs.length ? h('p', { class: 'src small video-ffmpeg', dir: 'auto' }, icon('alert'), ' ', t('vcNeedsFfmpegNote')) : !c.ffmpeg && probe.dropped.length ? h('p', { class: 'src small video-ffmpeg', dir: 'auto' }, icon('alert'), ' ', t('vcDroppedNote')) : null;

  // Presets: the four built in, and the reader's own (a name over saved options).
  const mine = presetsList(); let naming = false;
  const apply = (p: Partial<VideoOptions>) => { Object.assign(o, normaliseOptions({ ...o, ...p, playlist: o.playlist, range: o.range, subs: p.subs ?? o.subs })); c.change(); c.redraw(); };
  const nameRow = h('div', { class: 'video-preset-name', hidden: true }, h('input', { type: 'text', 'aria-label': t('vcPresetName'), placeholder: t('vcPresetName'), maxlength: '40', dir: 'auto' }), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const i = nameRow.querySelector('input')!; if (!i.value.trim()) return; savePreset(i.value, o); c.redraw(); } }, t('save')));
  const presets = h('div', { class: 'chip-row wrap video-presets' }, ...BUILT_IN.map((p) => h('button', { type: 'button', class: 'chip small', onclick: () => apply(p.opts) }, icon(p.icon), ' ', t(p.label))),
    ...mine.map((p) => h('span', { class: 'chip small preset-own' }, h('button', { type: 'button', class: 'plain', onclick: () => apply(p.opts) }, icon('bookmark'), ' ', p.name), h('button', { type: 'button', class: 'plain', 'aria-label': t('remove'), onclick: () => { deletePreset(p.name); c.redraw(); } }, icon('close')))),
    h('button', { type: 'button', class: 'chip small', onclick: () => { naming = !naming; nameRow.hidden = !naming; if (naming) nameRow.querySelector('input')?.focus(); } }, icon('plus'), ' ', t('vcSavePreset')));

  const mode = h('div', { class: 'chip-row wrap' }, chip(h('span', null, icon('film'), ' ', t('vcVideo')), !audio, set(() => { o.mode = 'video'; })), chip(h('span', null, icon('music'), ' ', t('videoAudioOnly')), audio, set(() => { o.mode = 'audio'; o.subs.on = false; })));

  let body: (Node | null)[];
  if (!audio) {
    const eff = o.height && heights.some((x) => x.h === o.height) ? o.height : 0;
    body = [
      block(t('videoQuality'), h('div', { class: 'chip-row wrap video-qualities' }, chip(t('videoBest'), eff === 0, set(() => { o.height = 0; })), ...heights.map((x) => chip(`${localDigits(x.h)}p`, eff === x.h, set(() => { o.height = x.h; }), sizeText(x.size))))),
      block(t('videoContainer'), h('div', { class: 'chip-row wrap' }, ...(['mp4', 'mkv', 'webm'] as const).map((k) => chip(k === 'webm' ? 'WebM' : k.toUpperCase(), o.container === k, set(() => { o.container = k; })))), h('small', { class: 'src video-hint' }, t(o.container === 'mp4' ? 'vcHintMp4' : o.container === 'mkv' ? 'vcHintMkv' : 'vcHintWebm'))),
      fold('adv', 'video-fold', t('vcAdvanced'),
        check(t('vcFps60'), o.fps60, (x) => { o.fps60 = x; c.change(); }),
        block(t('vcCodec'), h('div', { class: 'chip-row wrap' }, chip(t('vcCodecCompat'), o.codec === 'compat', set(() => { o.codec = 'compat'; })), chip(t('vcCodecSmall'), o.codec === 'small', set(() => { o.codec = 'small'; }))))),
    ];
  } else {
    const a0 = v?.audio[0];
    body = [
      block(t('vcAudioFormat'), h('div', { class: 'chip-row wrap' }, ...FORMATS.map((f) => chip(f === 'm4a' ? 'M4A' : f.toUpperCase(), o.audio === f, set(() => { o.audio = f; }), f === 'm4a' || f === 'opus' ? t('vcAsIsShort') : undefined))), h('small', { class: 'src video-hint' }, t(HINT[o.audio]), a0?.size ? ` · ${t('vcApprox', { size: formatBytes(a0.size) })}` : '')),
      o.audio === 'mp3' ? block(t('vcMp3Rate'), h('div', { class: 'chip-row wrap' }, ...(['320', '256', '192', '128', 'vbr'] as const).map((r) => chip(r === 'vbr' ? t('vcVbr') : `${localDigits(r)} kbps`, o.mp3Rate === r, set(() => { o.mp3Rate = r; }))))) : null,
      check(t('vcEmbedCover'), o.embedThumb, (x) => { o.embedThumb = x; c.change(); c.redraw(); }, o.audio === 'wav' ? t('vcNoCoverWav') : undefined),
      check(t('vcEmbedMeta'), o.embedMeta, (x) => { o.embedMeta = x; c.change(); c.redraw(); }),
      c.withList || info.kind === 'playlist' ? check(t('vcTrackNo'), o.trackNo, (x) => { o.trackNo = x; c.change(); }) : null,
    ];
  }

  // Extras.
  const subsHave = v ? v.subtitles : []; const autoOnly = v ? (v.autoSubs ?? []) : [];
  const wantAuto = autoOnly.filter((l) => c.want.some((w) => l === w || l.startsWith(`${w}-`)) || o.subs.langs.includes(l)).slice(0, 8);
  const toggleLang = (l: string) => { const i = o.subs.langs.indexOf(l); if (i >= 0) o.subs.langs.splice(i, 1); else if (o.subs.langs.length < 12) o.subs.langs.push(l); o.subs.auto = o.subs.langs.some((x) => !subsHave.includes(x) && autoOnly.includes(x)); c.change(); c.redraw(); };
  const subs = v && (subsHave.length || autoOnly.length) ? [
    check(t('vcSubs'), o.subs.on, (x) => { o.subs.on = x; if (x && !o.subs.langs.length) o.subs.langs = [...subsHave, ...wantAuto].filter((l) => c.want.some((w) => l === w || l.startsWith(`${w}-`))).slice(0, 2); c.change(); c.redraw(); }),
    o.subs.on ? h('div', { class: 'video-sub-opts' },
      h('div', { class: 'chip-row wrap video-sub-langs' }, ...subsHave.slice(0, 40).map((l) => chip(l, o.subs.langs.includes(l), () => toggleLang(l))), ...wantAuto.filter((l) => !subsHave.includes(l)).map((l) => chip(`${l} (${t('subAutoShort')})`, o.subs.langs.includes(l), () => toggleLang(l), undefined, ' auto'))),
      audio ? h('small', { class: 'src' }, t('vcSubsAudio')) : h('div', { class: 'chip-row wrap' }, chip(t('vcSubsEmbed'), o.subs.how === 'embed', set(() => { o.subs.how = 'embed'; })), chip(t('vcSubsFile'), o.subs.how === 'file', set(() => { o.subs.how = 'file'; }))),
      audio || o.subs.how === 'file' ? h('div', { class: 'chip-row wrap' }, ...(['srt', 'vtt', 'ass'] as const).map((f) => chip(`.${f}`, o.subs.fmt === f, set(() => { o.subs.fmt = f; })))) : null) : null,
  ] : [];
  const chapters = block(t('vcChapters'), h('div', { class: 'chip-row wrap' }, chip(t('vcChOff'), o.chapters === 'off', set(() => { o.chapters = 'off'; })), chip(t('vcChEmbed'), o.chapters === 'embed', set(() => { o.chapters = 'embed'; })), chip(t('vcChSplit'), o.chapters === 'split', set(() => { o.chapters = 'split'; }))));
  const sponsor = block(t('videoSponsorMode'), h('div', { class: 'chip-row wrap' }, ...(['off', 'remove', 'mark'] as const).map((m) => chip(t(m === 'off' ? 'videoSponsorOff' : m === 'remove' ? 'videoSponsorRemove' : 'videoSponsorMark'), o.sponsor === m, set(() => { o.sponsor = m; })))),
    o.sponsor !== 'off' ? h('div', { class: 'chip-row wrap' }, ...SPONSOR_CATS.map((k) => chip(k, o.sponsorCats.includes(k), set(() => { const i = o.sponsorCats.indexOf(k); if (i >= 0) { if (o.sponsorCats.length > 1) o.sponsorCats.splice(i, 1); } else o.sponsorCats.push(k); })))) : null);
  const listed = c.withList || info.kind === 'playlist';
  const rangeBad = o.playlist === 'range' && !!o.range.trim() && !safeRange(o.range);
  const playlist = listed ? block(t('vcPlaylist'), h('div', { class: 'chip-row wrap' }, ...([...(c.withList ? ['one'] : []), 'all', 'range'] as const).map((m) => chip(t(m === 'one' ? 'vcPlOne' : m === 'all' ? 'vcPlAll' : 'vcPlRange'), o.playlist === m, set(() => { o.playlist = m as VideoOptions['playlist']; })))),
    o.playlist === 'range' ? h('input', { type: 'text', class: 'video-part-more video-range', dir: 'ltr', value: o.range, placeholder: t('vcPlRangeHint'), 'aria-label': t('vcPlRange'), 'aria-invalid': String(rangeBad), oninput: (e: Event) => { o.range = (e.target as HTMLInputElement).value; c.change(); } }) : null,
    o.playlist === 'range' && rangeBad ? h('small', { class: 'src danger' }, t('vcRangeBad')) : null) : null;
  const names = (['title', 'uploader', 'playlist', 'custom'] as const);
  const customBad = o.name === 'custom' && !!o.custom.trim() && !safeTemplate(o.custom);
  const nameBlock = block(t('videoTemplate'), h('div', { class: 'chip-row wrap' }, ...names.map((k) => chip(t(k === 'title' ? 'vcNameTitle' : k === 'uploader' ? 'vcNameUploader' : k === 'playlist' ? 'vcNamePlaylist' : 'vcNameCustom'), o.name === k, set(() => { o.name = k; })))),
    o.name === 'custom' ? h('input', { type: 'text', class: 'video-part-more', dir: 'ltr', value: o.custom, placeholder: '%(title)s [%(id)s]', 'aria-label': t('vcNameCustom'), 'aria-invalid': String(customBad), oninput: (e: Event) => { o.custom = (e.target as HTMLInputElement).value; c.change(); } }) : null,
    o.name === 'custom' && customBad ? h('small', { class: 'src danger' }, t('vcTemplateBad')) : null,
    listed ? check(t('videoNumber'), o.number, (x) => { o.number = x; c.change(); }) : null);
  const extras = fold('extras', 'video-fold video-extras', t('vcExtras'), ...subs, check(t('vcThumbFile'), o.thumbFile, (x) => { o.thumbFile = x; c.change(); }), chapters, sponsor, playlist, nameBlock);
  return h('div', { class: 'video-chooser' }, h('span', { class: 'label' }, t('vcPresets')), presets, nameRow, mode, ...body, needsNote, extras);
}
