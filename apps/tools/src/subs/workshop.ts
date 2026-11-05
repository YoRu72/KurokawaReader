// The subtitle workshop: a subtitle file opened (.srt, .ass/.ssa, .vtt, .sub), its lines shown and edited, shifted
// in time or stretched, translated whole (the screen translator's engine: Google, DeepL or an AI), made bilingual
// with a second file, saved as .srt or .vtt beside the original — and, on a phone with the ffmpeg pack, spoken by
// the phone's own voice into a dub muxed into a copy of the video.
import { h, icon, iconButton, openSheet, toast, pickButton } from '../ui/dom';
import { t, localDigits, countItems } from '../i18n';
import { ktPlugin, nativePlatform } from '../native';
import { parseCues, sniffFormat, decodeSubtitle, cuesToSrt, type Cue } from '../player/subs';
import { readLocal } from '../player/files';
import { pickFiles } from '../archives';

type Plug = { filesWrite(o: { path: string; text: string }): Promise<unknown>; dubMake?(o: { id: string; lang: string; video: string; out: string; cues: string }): Promise<{ path: string }>; dubCancel?(o: { id: string }): Promise<void>; addListener?(ev: string, fn: (e: { id: string; done: number; total: number; phase: string }) => void): Promise<{ remove(): void }> };
type Desk = { writeText?(o: { path: string; text: string }): Promise<unknown> };
const fmtTime = (s: number) => { const ms = Math.round(s * 1000); const hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000), ss = Math.floor((ms % 60000) / 1000), f = ms % 1000; return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(f).padStart(3, '0')}`; };
const cuesToVtt = (cues: Cue[]): string => `WEBVTT\n\n${cues.map((c) => `${fmtTime(c.start).replace(',', '.')} --> ${fmtTime(c.end).replace(',', '.')}\n${c.text}\n`).join('\n')}`;
async function writeText(path: string, text: string): Promise<boolean> { const p = ktPlugin() as unknown as Plug | null; if (p?.filesWrite) { await p.filesWrite({ path, text }); return true; } const d = window.kurokawaTools as unknown as Desk | undefined; if (d?.writeText) { await d.writeText({ path, text }); return true; } return false; }

/** The workshop on a subtitle file (picked when none given); `video` the file it belongs to, when known (for the dub). */
export async function workshopSheet(path?: string, video?: string): Promise<void> {
  if (!path) { const ps = await pickFiles(false); path = ps[0]; if (!path) return; }
  const bytes = await readLocal(path); if (!bytes) { toast(t('wsCantRead'), 'error'); return; }
  const name = path.split('/').pop() ?? path; const text = decodeSubtitle(bytes); const fmt = sniffFormat(name, text); let cues = parseCues(text, fmt);
  if (!cues.length) { toast(t('wsNoCues'), 'error'); return; }
  const sh = openSheet(name, t('close')); sh.el.classList.add('subs-workshop');
  const list = h('div', { class: 'ws-list' }); const info = h('p', { class: 'hint' });
  const draw = () => {
    info.textContent = `${countItems(cues.length)} · ${fmtTime(cues[0].start)} → ${fmtTime(cues[cues.length - 1].end)} · ${fmt.toUpperCase()}`;
    list.replaceChildren(...cues.slice(0, 400).map((c, i) => h('div', { class: 'ws-cue' }, h('small', { class: 'src', dir: 'ltr' }, `${localDigits(i + 1)} · ${fmtTime(c.start)} → ${fmtTime(c.end)}`), h('div', { class: 'ws-text', contenteditable: 'true', dir: 'auto', onblur: (e: Event) => { c.text = (e.target as HTMLElement).innerText.trim(); } }, c.text))), cues.length > 400 ? h('p', { class: 'hint' }, t('wsMore', { n: localDigits(cues.length - 400) })) : h('span'));
  };
  // ---- time: shift by seconds, stretch by a factor (a subtitle for another cut of the film)
  const shift = h('input', { type: 'number', step: '0.1', value: '0', style: { width: '6em' } }) as HTMLInputElement; const stretch = h('input', { type: 'number', step: '0.001', value: '1', style: { width: '6em' } }) as HTMLInputElement;
  const applyTime = () => { const d = Number(shift.value) || 0, k = Number(stretch.value) || 1; cues = cues.map((c) => ({ ...c, start: Math.max(0, c.start * k + d), end: Math.max(0, c.end * k + d) })); shift.value = '0'; stretch.value = '1'; draw(); toast(t('wsApplied')); };
  // ---- translate whole, through the screen translator's engine
  let target = ''; const translateBtn = h('button', { type: 'button', class: 'btn tonal small', onclick: async () => {
    const { loadScreen, SCREEN_LANGS, engineReady } = await import('../screen/config'); const { translateTexts } = await import('../screen/translate');
    const cfg = loadScreen(); if (!target) target = cfg.target; if (!engineReady(cfg)) cfg.engine = 'google'; cfg.target = target;
    const label = SCREEN_LANGS.find(([c]) => c === target)?.[1] ?? target; translateBtn.disabled = true; const busy = toast(t('wsTranslating', { lang: label }), undefined, 60000); void busy;
    try { const out: string[] = []; for (let k = 0; k < cues.length; k += 40) { const part = cues.slice(k, k + 40).map((c) => c.text); out.push(...(await translateTexts(part, cfg))); } cues = cues.map((c, i) => ({ ...c, text: out[i] || c.text })); draw(); toast(t('wsTranslated')); }
    catch (e) { toast(String((e as Error).message ?? e), 'error', 5000); } translateBtn.disabled = false;
  } }, icon('translate'), t('wsTranslate'));
  const langBtn = (async () => { const { SCREEN_LANGS, loadScreen } = await import('../screen/config'); target = loadScreen().target; return pickButton(t('wsTarget'), SCREEN_LANGS.map(([c, l]) => [c, l] as [string, string]), target, (v) => { target = v; }, t('close')); })();
  // ---- bilingual with a second file
  const bilingualBtn = h('button', { type: 'button', class: 'btn tonal small', onclick: async () => {
    const ps = await pickFiles(false); if (!ps[0]) return; const b = await readLocal(ps[0]); if (!b) return; const other = parseCues(decodeSubtitle(b), sniffFormat(ps[0], decodeSubtitle(b)));
    cues = cues.map((c) => { const o = other.filter((x) => { const ov = Math.min(c.end, x.end) - Math.max(c.start, x.start); return ov > 0 && ov * 2 >= Math.min(c.end - c.start, x.end - x.start); }).map((x) => x.text.replace(/\n/g, ' ')).join(' '); return o ? { ...c, text: `${c.text}\n${o}` } : c; }); draw(); toast(t('wsMerged'));
  } }, icon('subtitles'), t('wsBilingual'));
  // ---- save as .srt / .vtt beside the original
  const saveAs = async (ext: 'srt' | 'vtt') => { const stem = path!.replace(/\.[^./]+$/, ''); const suffix = target && cues.some((c) => c.text) ? '' : ''; const out = `${stem}${suffix}.kurokawa.${ext}`; const ok = await writeText(out, ext === 'srt' ? cuesToSrt(cues) : cuesToVtt(cues)); toast(ok ? t('wsSaved', { name: out.split('/').pop() ?? out }) : t('wsCantWrite'), ok ? undefined : 'error', 5000); };
  // ---- the dub (Android, ffmpeg pack): the phone's voice, into a copy of the video
  const p = ktPlugin() as unknown as Plug | null; let dubLang = '';
  const dubBtn = p?.dubMake ? h('button', { type: 'button', class: 'btn tonal small', onclick: async () => {
    const { SCREEN_LANGS } = await import('../screen/config'); if (!dubLang) dubLang = target || 'en';
    const d = openSheet(t('wsDub'), t('cancel'), { stack: true }); const status = h('p', { class: 'src' }); const id = `dub-${Date.now()}`;
    d.body.append(h('p', { class: 'hint' }, t('wsDubHint')), h('div', { class: 'row' }, h('span', null, t('wsDubVoice')), pickButton(t('wsDubVoice'), SCREEN_LANGS.map(([c, l]) => [c, l] as [string, string]), dubLang, (v) => { dubLang = v; }, t('close'))), status);
    d.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async (e: Event) => {
      (e.currentTarget as HTMLButtonElement).disabled = true; const out = video ? video.replace(/\.[^./]+$/, '') + `.dub-${dubLang}.` + (/\.mp4$/i.test(video) ? 'mp4' : 'mkv') : path!.replace(/\.[^./]+$/, '') + `.dub-${dubLang}.m4a`;
      const sub = await p.addListener?.('dub', (ev) => { if (ev.id === id) status.textContent = `${ev.phase === 'speak' ? t('wsDubSpeaking') : ev.phase === 'mix' ? t('wsDubMixing') : t('wsDubMuxing')} ${localDigits(ev.done)} / ${localDigits(ev.total)}`; });
      try { const r = await p.dubMake!({ id, lang: dubLang, video: video ?? '', out, cues: JSON.stringify(cues.map((c) => ({ start: c.start, end: c.end, text: c.text }))) }); toast(t('wsDubDone', { name: r.path.split('/').pop() ?? r.path }), undefined, 6000); d.close(); }
      catch (err) { const m = String((err as Error).message ?? err); toast(/ttsNoVoice/.test(m) ? t('wsDubNoVoice') : /ttsUnavailable/.test(m) ? t('wsDubNoTts') : /pack:ffmpeg/.test(m) ? t('packWhyVideo') : m, 'error', 6000); (e.currentTarget as HTMLButtonElement).disabled = false; }
      sub?.remove();
    } }, icon('music'), t('wsDubMake')));
    d.el.addEventListener('transitionend', () => undefined); const origClose = d.close; d.close = () => { void p.dubCancel?.({ id }); origClose(); };
  } }, icon('music'), t('wsDub')) : null;
  sh.body.append(info,
    h('div', { class: 'row wrap ws-tools' }, h('label', { class: 'field row' }, h('span', { class: 'label' }, t('wsShift')), shift), h('label', { class: 'field row' }, h('span', { class: 'label' }, t('wsStretch')), stretch), h('button', { type: 'button', class: 'btn tonal small', onclick: applyTime }, icon('check'), t('apply'))),
    h('div', { class: 'row wrap ws-tools' }, await langBtn, translateBtn, bilingualBtn, dubBtn ?? h('span')),
    list);
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => void saveAs('vtt') }, icon('download'), 'VTT'), h('button', { type: 'button', class: 'btn primary', onclick: () => void saveAs('srt') }, icon('download'), t('wsSaveSrt')));
  draw(); void nativePlatform; void iconButton;
}
