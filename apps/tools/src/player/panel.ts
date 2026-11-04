// The player's preferences, grouped as REX Player groups them (Gestures, Controls, Playback, Subtitles, Audio,
// Video): one panel, shown in the player's own sheet and on the Player add-on's page in Settings.
import { h, pickButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getPrefs, updatePrefs, resetPrefs, DEFAULT_PREFS, type PlayerPrefs, type TapAction } from './prefs';
import { getSettings, updateSettings } from '../settings';
import { nativePlatform } from '../native';

type K = keyof PlayerPrefs;
export function playerPrefsPanel(onChange: (keys: K[]) => void = () => undefined): HTMLElement {
  const p = getPrefs();
  const set = (o: Partial<PlayerPrefs>) => { updatePrefs(o); onChange(Object.keys(o) as K[]); };
  const num = (label: string, key: K, min: number, max: number, step = 1, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), h('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(p[key]), style: { width: '6em' }, onchange: (e: Event) => { const v = Math.max(min, Math.min(max, Number((e.target as HTMLInputElement).value) || 0)); set({ [key]: v } as Partial<PlayerPrefs>); } }));
  const sw = (label: string, key: K, hint?: string) => h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), h('input', { type: 'checkbox', checked: !!p[key], onchange: (e: Event) => set({ [key]: (e.target as HTMLInputElement).checked } as Partial<PlayerPrefs>) }));
  const pick = <T extends string>(label: string, key: K, opts: [T, string][]) => h('div', { class: 'row' }, h('span', null, label), pickButton(label, opts, String(p[key]) as T, (v) => set({ [key]: (/^\d+$/.test(v) && typeof DEFAULT_PREFS[key] === 'number' ? Number(v) : v) } as Partial<PlayerPrefs>), t('close')));
  const colour = (label: string, key: K) => h('div', { class: 'row' }, h('span', null, label), h('input', { type: 'color', value: String(p[key]), oninput: (e: Event) => set({ [key]: (e.target as HTMLInputElement).value } as Partial<PlayerPrefs>) }));
  const langList = (label: string, hint: string, get: () => string[], put: (v: string[]) => void) => h('div', { class: 'row' }, h('span', null, label, h('small', { class: 'src' }, hint)), h('input', { type: 'text', dir: 'ltr', value: get().join(', '), placeholder: 'ar, en, ja', style: { width: '10em' }, onchange: (e: Event) => put((e.target as HTMLInputElement).value.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{2,3}$/.test(x))) }));
  const taps: [TapAction, string][] = [['seek', t('tapSeek')], ['playpause', t('tapPlayPause')], ['chapter', t('tapChapter')], ['none', t('tapNothing')]];
  const group = (title: string, keys: K[], ...rows: HTMLElement[]) => h('details', { class: 'pp-group' }, h('summary', null, h('b', null, title)), ...rows,
    h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: (e: Event) => { resetPrefs(keys); onChange(keys); const d = (e.currentTarget as HTMLElement).closest('.pp-group') as HTMLDetailsElement; const fresh = playerPrefsPanel(onChange); d.closest('.pp-panel')?.replaceWith(fresh); } }, t('reset'))));
  return h('div', { class: 'pp-panel' },
    group(t('ppGestures'), ['doubleTapSeek', 'tapLeft', 'tapCentre', 'tapRight', 'doubleTapArea', 'swipeSeek', 'swipeVolume', 'swipeBrightness', 'swapSides', 'swipeSensitivity', 'pinchZoom', 'longPressSpeed', 'holdSwipeSpeed', 'rememberHoldSpeed'],
      num(t('doubleTapSeek'), 'doubleTapSeek', 3, 120), pick(t('tapLeft'), 'tapLeft', taps), pick(t('tapCentre'), 'tapCentre', taps), pick(t('tapRight'), 'tapRight', taps), num(t('doubleTapArea'), 'doubleTapArea', 15, 45, 5),
      sw(t('swipeSeek'), 'swipeSeek'), num(t('swipeSensitivity'), 'swipeSensitivity', 25, 400, 25, t('swipeSensitivityHint')), sw(t('swipeVolume'), 'swipeVolume'), sw(t('swipeBrightness'), 'swipeBrightness'), sw(t('swapSides'), 'swapSides', t('swapSidesHint')), sw(t('pinchZoom'), 'pinchZoom'),
      num(t('longPressSpeed'), 'longPressSpeed', 1.25, 8, 0.25), sw(t('holdSwipeSpeed'), 'holdSwipeSpeed', t('holdSwipeSpeedHint')), sw(t('rememberHoldSpeed'), 'rememberHoldSpeed')),
    group(t('ppControls'), ['controlsTimeout', 'seekPreview', 'showClock', 'showRemaining', 'skipAmount', 'autoSkip'],
      num(t('controlsTimeout'), 'controlsTimeout', 1, 30, 0.5, t('secondsUnit')), sw(t('seekPreview'), 'seekPreview', t('seekPreviewHint')), sw(t('showClock'), 'showClock'), sw(t('showRemaining'), 'showRemaining'),
      num(t('skipAhead'), 'skipAmount', 5, 300, 5), pick(t('autoSkip'), 'autoSkip', [['button', t('autoSkipButton')], ['auto', t('autoSkipAuto')], ['off', t('autoSkipOff')]])),
    group(t('ppPlayback'), ['resume', 'defaultSpeed', 'autoplayNext', 'repeat', 'closeAtEnd', 'watchedAt', 'markWatched', 'keepScreenOn', 'backgroundPlay', 'orientation', 'rememberBrightness', 'pitchCorrection'],
      pick(t('resumePlayback'), 'resume', [['always', t('resumeAlways')], ['ask', t('resumeAsk')], ['never', t('resumeNever')]]), num(t('defaultSpeed'), 'defaultSpeed', 0.25, 4, 0.05), sw(t('pitchCorrection'), 'pitchCorrection'),
      sw(t('autoplayNext'), 'autoplayNext'), pick(t('repeatMode'), 'repeat', [['off', t('repeatOff')], ['all', t('repeatAll')], ['one', t('repeatOne')]]), sw(t('closeAtEnd'), 'closeAtEnd'),
      num(t('watchedAt'), 'watchedAt', 50, 100, 5), sw(t('markWatchedAuto'), 'markWatched'), sw(t('keepScreenOn'), 'keepScreenOn'), sw(t('backgroundPlay'), 'backgroundPlay', t('backgroundPlayHint')), sw(t('rememberBrightness'), 'rememberBrightness'),
      pick(t('orientation'), 'orientation', [['auto', t('orientationAuto')], ['landscape', t('orientationLandscape')], ['sensor', t('orientationSensor')]])),
    group(t('ppSubtitles'), ['autoSubs', 'subSize', 'subColor', 'subOutline', 'subOutlineWidth', 'subBackground', 'subBgOpacity', 'subBold', 'subItalic', 'subPos', 'sub2Pos', 'sub2Size', 'subSpeed', 'subForceLtr', 'subAssOverride', 'subCodepage'],
      langList(t('subPreferredLangs'), t('subPreferredLangsHint'), () => getSettings().subLangs ?? [], (v) => updateSettings({ subLangs: v })),
      sw(t('autoSubs'), 'autoSubs', t('autoSubsHint')),
      num(t('subSize'), 'subSize', 40, 250, 5, '%'), colour(t('subColor'), 'subColor'), colour(t('subOutlineColor'), 'subOutline'), num(t('subOutlineWidth'), 'subOutlineWidth', 0, 8, 0.5),
      pick(t('subBackground'), 'subBackground', [['none', t('subBgNone')], ['shadow', t('subBgShadow')], ['box', t('subBgBox')]]), num(t('subBgOpacity'), 'subBgOpacity', 0, 100, 5, '%'),
      sw(t('subBold'), 'subBold'), sw(t('subItalic'), 'subItalic'), num(t('subPosition'), 'subPos', 0, 100, 1, '%'), num(t('sub2Position'), 'sub2Pos', 0, 100, 1, '%'), num(t('sub2Size'), 'sub2Size', 40, 200, 5, '%'),
      num(t('subSpeed'), 'subSpeed', 0.5, 2, 0.001, t('subSpeedHint')), sw(t('subForceLtr'), 'subForceLtr'), sw(t('subAssOverride'), 'subAssOverride', t('subAssOverrideHint'))),
    group(t('ppAudio'), ['audioLangs', 'audioChannels', 'volumeBoost', 'normalize', 'mono', 'balance', 'audioDelay'],
      langList(t('audioPreferredLangs'), t('audioPreferredLangsHint'), () => getPrefs().audioLangs, (v) => set({ audioLangs: v })), pick(t('audioChannels'), 'audioChannels', [['auto', t('audioChannelsAuto')], ['stereo', t('audioChannelsStereo')]]),
      num(t('volumeBoost'), 'volumeBoost', 0, 200, 10, '%'), sw(t('normalizeAudio'), 'normalize', t('normalizeAudioHint')), sw(t('monoAudio'), 'mono'), num(t('audioBalance'), 'balance', -100, 100, 5, t('audioBalanceHint')), num(t('audioDelay'), 'audioDelay', 0, 5, 0.05, t('audioDelayHint'))),
    ...(nativePlatform() === 'android' ? [group(t('toolDecoder'), ['hwdec', 'deband', 'gpuNext'],
      h('label', { class: 'row switch-row' }, h('span', null, t('playerEngine') + ' — mpv', h('small', { class: 'src' }, t('playerEngineHint'))), h('input', { type: 'checkbox', checked: getSettings().playerEngine !== 'web', onchange: (e: Event) => updateSettings({ playerEngine: (e.target as HTMLInputElement).checked ? 'mpv' : 'web' }) })),
      pick(t('toolDecoder'), 'hwdec', [['hw', t('decoderHw')], ['hwcopy', t('decoderHwCopy')], ['sw', t('decoderSoftware')]]), sw(t('decoderDeband'), 'deband', t('decoderDebandHint')), sw(t('decoderGpuNext'), 'gpuNext', t('decoderGpuNextHint')))] : []),
    group(t('ppVideo'), ['aspect', 'ambient'],
      pick(t('defaultAspect'), 'aspect', (['fit', 'fill', 'stretch', '16:9', '4:3', '21:9'] as PlayerPrefs['aspect'][]).map((a) => [a, a === 'fit' ? t('aspectFit') : a === 'fill' ? t('aspectFill') : a === 'stretch' ? t('aspectStretch') : localDigits(a)] as [string, string])),
      sw(t('ambientMode'), 'ambient', t('ambientModeHint'))),
  );
}
