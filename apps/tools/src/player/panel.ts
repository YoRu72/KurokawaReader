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
  // (The bar's tools — REX Player's Layout page —: ticked on or off, moved up or down, as in the player's own sheet.)
  const TOOL_NAMES: [string, string][] = [['chapters', t('toolChaptersBookmarks')], ['speed', t('playbackSpeed')], ['decoder', t('toolDecoder')], ['rotation', t('toolScreenRotation')], ['frames', t('toolFrames')], ['zoom', t('toolZoom')], ['pip', t('pip')], ['aspect', t('toolAspect')], ['lock', t('lockScreen')], ['audio', t('audioTracks')], ['subs', t('navSubs')], ['chapter', t('toolCurrentChapter')], ['repeat', t('repeatMode')], ['shuffle', t('toolShuffle')], ['flipH', t('toolFlipH')], ['flipV', t('toolFlipV')], ['ab', t('toolAbLoop')], ['skip', t('toolCustomSkip')], ['background', t('backgroundPlay')], ['ambient', t('ambientMode')], ['sleep', t('sleepTimer')], ['quality', t('toolQuality')], ['cut', t('toolCut')], ['shot', t('screenshot')], ['bookmark', t('addBookmark')], ['jump', t('jumpToTime')], ['info', t('mediaInfo')], ['stats', t('statsOverlay')], ['keys', t('shortcutsTitle')], ['copyTime', t('copyTime')]];
  const layoutList = h('div', { class: 'dest-list pp-layout' });
  const drawLayout = () => { const bar = getPrefs().bar; const all = [...bar.map((id) => TOOL_NAMES.find((x) => x[0] === id)).filter((x): x is [string, string] => !!x), ...TOOL_NAMES.filter((x) => !bar.includes(x[0]))];
    layoutList.replaceChildren(...all.map(([id, label]) => { const on = bar.includes(id); const i = bar.indexOf(id);
      return h('div', { class: 'dest-row' + (on ? ' on' : '') }, h('input', { type: 'checkbox', checked: on, 'aria-label': label, onchange: () => { set({ bar: on ? bar.filter((y) => y !== id) : [...bar, id] }); drawLayout(); } }), h('span', { class: 'name grow' }, label),
        on ? h('button', { type: 'button', class: 'icon-btn small', 'aria-label': t('moveUp'), disabled: i <= 0, onclick: () => { const b2 = [...bar]; [b2[i - 1], b2[i]] = [b2[i], b2[i - 1]]; set({ bar: b2 }); drawLayout(); } }, '↑') : null,
        on ? h('button', { type: 'button', class: 'icon-btn small', 'aria-label': t('moveDown'), disabled: i >= bar.length - 1, onclick: () => { const b2 = [...bar]; [b2[i + 1], b2[i]] = [b2[i], b2[i + 1]]; set({ bar: b2 }); drawLayout(); } }, '↓') : null); })); };
  drawLayout();
  const accentRow = h('div', { class: 'row' }, h('span', null, t('ppAccent'), h('small', { class: 'src' }, t('ppAccentHint'))), h('div', { class: 'row-actions' }, h('input', { type: 'color', value: p.accent || '#6750a4', oninput: (e: Event) => set({ accent: (e.target as HTMLInputElement).value }) }), h('button', { type: 'button', class: 'btn text small', onclick: () => { set({ accent: '' }); } }, t('ppAccentApp'))));
  // (REX Player's settings search: the rows whose words match are shown, their groups opened; the rest hidden.)
  const search = h('input', { type: 'search', class: 'pp-search', placeholder: t('settingsSearch'), oninput: () => { const q = search.value.trim().toLowerCase(); const panel = search.closest('.pp-panel'); if (!panel) return; for (const g of panel.querySelectorAll<HTMLDetailsElement>('.pp-group')) { let any = false; for (const row of g.querySelectorAll<HTMLElement>(':scope > .row, :scope > .switch-row, :scope > .dest-list > .dest-row, :scope > .hint')) { const hit = !q || (row.textContent ?? '').toLowerCase().includes(q); row.classList.toggle('pp-hidden', !hit); any ||= hit; } g.classList.toggle('pp-hidden', !!q && !any); if (q && any) g.open = true; } } }) as HTMLInputElement;
  return h('div', { class: 'pp-panel' }, search,
    group(t('ppAppearance'), ['accent', 'seekStyle', 'controlsDim', 'showTitle', 'chapterMarks', 'controlSize', 'showClock', 'showRemaining'],
      accentRow, pick(t('ppSeekStyle'), 'seekStyle', [['thin', t('ppSeekThin')], ['thick', t('ppSeekThick')], ['wave', t('ppSeekWave')]]), num(t('ppControlsDim'), 'controlsDim', 0, 100, 5, '%'),
      pick(t('ppControlSize'), 'controlSize', [['small', t('ppSizeSmall')], ['normal', t('ppSizeNormal')], ['large', t('ppSizeLarge')]]), sw(t('ppShowTitle'), 'showTitle'), sw(t('ppChapterMarks'), 'chapterMarks'), sw(t('showClock'), 'showClock'), sw(t('showRemaining'), 'showRemaining')),
    group(t('ppLayout'), ['bar'], h('p', { class: 'hint' }, t('playerLayoutHint')), layoutList),
    group(t('ppGestures'), ['doubleTapSeek', 'tapLeft', 'tapCentre', 'tapRight', 'doubleTapArea', 'swipeSeek', 'swipeVolume', 'swipeBrightness', 'swapSides', 'swipeSensitivity', 'pinchZoom', 'longPressSpeed', 'holdSwipeSpeed', 'rememberHoldSpeed'],
      num(t('doubleTapSeek'), 'doubleTapSeek', 3, 120), pick(t('tapLeft'), 'tapLeft', taps), pick(t('tapCentre'), 'tapCentre', taps), pick(t('tapRight'), 'tapRight', taps), num(t('doubleTapArea'), 'doubleTapArea', 15, 45, 5),
      sw(t('swipeSeek'), 'swipeSeek'), num(t('swipeSensitivity'), 'swipeSensitivity', 25, 400, 25, t('swipeSensitivityHint')), sw(t('swipeVolume'), 'swipeVolume'), sw(t('swipeBrightness'), 'swipeBrightness'), sw(t('swapSides'), 'swapSides', t('swapSidesHint')), sw(t('pinchZoom'), 'pinchZoom'),
      num(t('longPressSpeed'), 'longPressSpeed', 1.25, 8, 0.25), sw(t('holdSwipeSpeed'), 'holdSwipeSpeed', t('holdSwipeSpeedHint')), sw(t('rememberHoldSpeed'), 'rememberHoldSpeed')),
    group(t('ppControls'), ['controlsTimeout', 'seekPreview', 'skipAmount', 'autoSkip', 'skipSponsor', 'skipSilence', 'heatmap'],
      num(t('controlsTimeout'), 'controlsTimeout', 1, 30, 0.5, t('secondsUnit')), sw(t('seekPreview'), 'seekPreview', t('seekPreviewHint')),
      num(t('skipAhead'), 'skipAmount', 5, 300, 5), pick(t('autoSkip'), 'autoSkip', [['button', t('autoSkipButton')], ['auto', t('autoSkipAuto')], ['off', t('autoSkipOff')]]), pick(t('skipSponsor'), 'skipSponsor', [['button', t('autoSkipButton')], ['auto', t('autoSkipAuto')], ['off', t('autoSkipOff')]]), sw(t('skipSilence'), 'skipSilence', t('skipSilenceHint')), sw(t('heatmap'), 'heatmap', t('heatmapHint'))),
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
