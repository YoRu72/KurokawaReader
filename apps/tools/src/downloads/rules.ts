// Rules (OmniGet's): «when the link's host is X / the link contains Y / it is a video, torrent or file — then save
// it in this folder, as audio only, with these subtitle languages, later, over Wi‑Fi only». The first rule that
// fits wins; a link can be tested against them. Kept in the settings. Also each download's own clock (its start
// and stop times), minded by the scheduler beside the global window.
import { getSettings, updateSettings } from '../settings';
import { getEngine } from '../engine';
import type { Task } from '../engine/types';

export interface Rule {
  id: string; name: string; on: boolean;
  when: { host?: string; contains?: string; kind?: 'video' | 'torrent' | 'file' | 'any'; /** At least this many MB (the browser's probe knows sizes). */ minMb?: number };
  then: { dir?: string; audioOnly?: boolean; subs?: string; later?: boolean; wifiOnly?: boolean; connections?: number; quality?: string; /** A capture rule: what the app's browser sees that matches is added on sight, no sheet. */ capture?: boolean };
}
export const rules = (): Rule[] => ((getSettings() as { rules?: Rule[] }).rules ?? []);
export const saveRules = (rs: Rule[]): void => { updateSettings({ rules: rs } as never); };
export const newRule = (): Rule => ({ id: `r${Date.now().toString(36)}`, name: '', on: true, when: { kind: 'any' }, then: {} });

/** The kind a source is for the rules: a torrent, a video site's page, or a plain file. */
export function kindOf(src: { url?: string; magnet?: string; torrent?: unknown }, videoHost: boolean): 'video' | 'torrent' | 'file' { return src.magnet || src.torrent ? 'torrent' : videoHost ? 'video' : 'file'; }
const hostOf = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
/** The first rule that fits, or null. */
export function match(src: { url?: string; magnet?: string; torrent?: unknown; size?: number }, kind: 'video' | 'torrent' | 'file'): Rule | null {
  const u = src.url ?? src.magnet ?? ''; const host = hostOf(u);
  for (const r of rules()) {
    if (!r.on) continue; const w = r.when;
    if (w.kind && w.kind !== 'any' && w.kind !== kind) continue;
    if (w.host && !(host === w.host.toLowerCase() || host.endsWith('.' + w.host.toLowerCase()))) continue;
    if (w.contains && !u.toLowerCase().includes(w.contains.toLowerCase())) continue;
    if (w.minMb && !(src.size && src.size >= w.minMb * 1048576)) continue;
    return r;
  }
  return null;
}
/** Which rule a link would fall under, in words — the «test a link» box. */
export const describe = (r: Rule): string => [r.when.kind && r.when.kind !== 'any' ? r.when.kind : '', r.when.host ? `host ${r.when.host}` : '', r.when.contains ? `“${r.when.contains}”` : '', r.when.minMb ? `≥ ${r.when.minMb} MB` : ''].filter(Boolean).join(' · ') + ' → ' + [r.then.capture ? 'capture' : '', r.then.dir ? r.then.dir.split('/').pop() : '', r.then.audioOnly ? 'audio' : '', r.then.subs ? `subs ${r.then.subs}` : '', r.then.later ? 'later' : '', r.then.wifiOnly ? 'Wi‑Fi' : '', r.then.quality ? r.then.quality : ''].filter(Boolean).join(' · ');

/* ---------- a download's own clock ---------- */
/** Each minute: a download whose start time came is resumed, one whose stop time came is paused (then unmarked). */
export async function tickClocks(tasks?: Task[]): Promise<void> {
  const eng = getEngine(); const list = tasks ?? await eng.list().catch(() => [] as Task[]); const now = Date.now();
  for (const x of list) {
    const m = x.meta as { startAt?: number; stopAt?: number } | undefined; if (!m || x.state === 'done') continue;
    if (m.stopAt && now >= m.stopAt && (x.state === 'downloading' || x.state === 'queued')) { try { await eng.pause(x.id); } catch { /* next time */ } await setClock(x.id, { stopAt: undefined }); continue; }
    if (m.startAt && now >= m.startAt && x.state === 'paused') { try { await eng.resume(x.id); } catch { /* next time */ } await setClock(x.id, { startAt: undefined }); }
  }
}
type ClockPlug = { setTaskMeta?(o: { id: string; patch: Record<string, unknown> }): Promise<void> };
/** The clock written on the task (the phone's engine keeps meta; elsewhere it lives here, in the page's memory). */
const local = new Map<string, { startAt?: number; stopAt?: number }>();
export async function setClock(id: string, patch: { startAt?: number; stopAt?: number }): Promise<void> {
  const { ktPlugin } = await import('../native'); const p = ktPlugin() as unknown as ClockPlug | null;
  if (p?.setTaskMeta) { try { await p.setTaskMeta({ id, patch: { startAt: patch.startAt ?? null, stopAt: patch.stopAt ?? null } }); return; } catch { /* below */ } }
  local.set(id, { ...local.get(id), ...patch });
}
export const clockOf = (x: Task): { startAt?: number; stopAt?: number } => ({ ...local.get(x.id), ...(x.meta as { startAt?: number; stopAt?: number } | undefined) });
/** The presets: in an hour, tonight at 23:00, tomorrow at 8:00. */
export function presets(): [string, number][] {
  const now = new Date(); const inHour = now.getTime() + 3600_000;
  const tonight = new Date(now); tonight.setHours(23, 0, 0, 0); if (tonight.getTime() <= now.getTime()) tonight.setDate(tonight.getDate() + 1);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  return [['inHour', inHour], ['tonight', tonight.getTime()], ['tomorrow', tomorrow.getTime()]];
}

/* ---------- the sheets ---------- */
import { h, icon, iconButton, openSheet, toast, pickButton } from '../ui/dom';
import { t, dateLocale } from '../i18n';
/** The rules, listed, each editable; a link typed is matched against them. */
export function rulesSheet(): void {
  const sh = openSheet(t('rulesTitle'), t('close')); const list = h('div', { class: 'dest-list' });
  const test = h('input', { type: 'url', dir: 'ltr', placeholder: t('rulesTestHint'), autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement; const verdict = h('p', { class: 'hint', dir: 'auto' });
  const draw = () => {
    const rs = rules();
    list.replaceChildren(...(rs.length ? rs.map((r, i) => h('div', { class: 'dest-row' + (r.on ? '' : ' off') }, h('input', { type: 'checkbox', checked: r.on, 'aria-label': r.name, onchange: (e: Event) => { const all = rules(); all[i].on = (e.target as HTMLInputElement).checked; saveRules(all); } }), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, r.name || t('ruleUnnamed')), h('small', { class: 'src', dir: 'auto' }, describe(r))), iconButton('pen', t('rename'), () => ruleSheet(r, draw)), iconButton('trash', t('delete'), () => { saveRules(rules().filter((x) => x.id !== r.id)); draw(); }))) : [h('p', { class: 'hint' }, t('rulesNone'))]));
  };
  const check = () => { const u = test.value.trim(); if (!u) { verdict.textContent = ''; return; } const m = match({ url: u }, /^magnet:/i.test(u) ? 'torrent' : /youtube\.com|youtu\.be|vimeo|twitch|tiktok|instagram|x\.com|twitter|dailymotion|bilibili/i.test(u) ? 'video' : 'file'); verdict.textContent = m ? t('rulesTestHit', { name: m.name || t('ruleUnnamed'), what: describe(m) }) : t('rulesTestNone'); };
  test.addEventListener('input', check);
  sh.body.append(h('p', { class: 'hint' }, t('rulesHint')), list, h('label', { class: 'field' }, h('span', null, t('rulesTest')), test), verdict);
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => ruleSheet(newRule(), draw) }, icon('plus'), t('ruleAdd')));
  draw();
}
function ruleSheet(r: Rule, done: () => void): void {
  const sh = openSheet(r.name ? r.name : t('ruleAdd'), t('cancel'), { stack: true });
  const name = h('input', { type: 'text', value: r.name, dir: 'auto', placeholder: t('ruleNameHint') }) as HTMLInputElement;
  const host = h('input', { type: 'text', value: r.when.host ?? '', dir: 'ltr', placeholder: 'example.com', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const contains = h('input', { type: 'text', value: r.when.contains ?? '', dir: 'ltr', placeholder: t('ruleContainsHint'), autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  let kind: 'any' | 'video' | 'torrent' | 'file' = r.when.kind ?? 'any'; const kindBtn = pickButton(t('ruleKind'), [['any', t('ruleKindAny')], ['video', t('ruleKindVideo')], ['torrent', t('ruleKindTorrent')], ['file', t('ruleKindFile')]], kind, (v) => { kind = v; }, t('close'));
  const dir = h('input', { type: 'text', value: r.then.dir ?? '', dir: 'ltr', placeholder: t('ruleDirHint'), autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const subs = h('input', { type: 'text', value: r.then.subs ?? '', dir: 'ltr', placeholder: 'en,ar', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const conns = h('input', { type: 'number', value: r.then.connections ? String(r.then.connections) : '', min: '1', max: '32', placeholder: '8' }) as HTMLInputElement;
  const minMb = h('input', { type: 'number', value: r.when.minMb ? String(r.when.minMb) : '', min: '0', placeholder: '0' }) as HTMLInputElement; const capture = h('input', { type: 'checkbox', checked: !!r.then.capture }) as HTMLInputElement;
  const audio = h('input', { type: 'checkbox', checked: !!r.then.audioOnly }) as HTMLInputElement; const later = h('input', { type: 'checkbox', checked: !!r.then.later }) as HTMLInputElement; const wifi = h('input', { type: 'checkbox', checked: !!r.then.wifiOnly }) as HTMLInputElement;
  const field = (label: string, el: HTMLElement) => h('label', { class: 'field' }, h('span', null, label), el);
  sh.body.append(field(t('ruleName'), name), h('p', { class: 'files-sec' }, t('ruleWhen')), h('div', { class: 'chip-row files-filters' }, kindBtn), field(t('ruleHost'), host), field(t('ruleContains'), contains), field(t('ruleMinMb'), minMb),
    h('p', { class: 'files-sec' }, t('ruleThen')), field(t('ruleDir'), dir), field(t('ruleSubs'), subs), field(t('connections'), conns),
    h('label', { class: 'check-row' }, audio, h('span', null, t('ruleAudioOnly'))), h('label', { class: 'check-row' }, later, h('span', null, t('ruleLater'))), h('label', { class: 'check-row' }, wifi, h('span', null, t('ruleWifi'))), h('label', { class: 'check-row' }, capture, h('span', null, t('ruleCapture'), h('small', { class: 'src' }, t('ruleCaptureHint')))));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => {
    const next: Rule = { ...r, name: name.value.trim(), when: { kind: kind as Rule['when']['kind'], host: host.value.trim() || undefined, contains: contains.value.trim() || undefined, minMb: Number(minMb.value) || undefined }, then: { capture: capture.checked || undefined, dir: dir.value.trim() || undefined, subs: subs.value.trim() || undefined, connections: Number(conns.value) || undefined, audioOnly: audio.checked || undefined, later: later.checked || undefined, wifiOnly: wifi.checked || undefined } };
    const all = rules(); const i = all.findIndex((x) => x.id === r.id); if (i >= 0) all[i] = next; else all.push(next); saveRules(all); sh.close(); done(); toast(t('ruleSaved'));
  } }, icon('check'), t('save')));
}
/** A download's own clock: when to start, when to stop (presets, or a time typed). */
export function clockSheet(x: Task): void {
  const sh = openSheet(t('clockTitle'), t('close')); const c = clockOf(x); const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString(dateLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : t('clockNone'));
  const startLine = h('p', { class: 'src' }, `${t('clockStart')}: ${fmt(c.startAt)}`); const stopLine = h('p', { class: 'src' }, `${t('clockStop')}: ${fmt(c.stopAt)}`);
  const row = (which: 'startAt' | 'stopAt', line: HTMLElement) => {
    const when = h('input', { type: 'datetime-local' }) as HTMLInputElement;
    const set = async (ms?: number) => { await setClock(x.id, { [which]: ms } as { startAt?: number }); line.textContent = `${which === 'startAt' ? t('clockStart') : t('clockStop')}: ${fmt(ms)}`; if (which === 'startAt' && ms && x.state !== 'paused') { try { await getEngine().pause(x.id); } catch { /* none */ } } toast(ms ? t('clockSet') : t('clockCleared')); };
    return h('div', { class: 'clock-row' }, line, h('div', { class: 'chip-row wrap' }, ...presets().map(([k, ms]) => h('button', { type: 'button', class: 'chip small', onclick: () => void set(ms) }, t(('clock_' + k) as 'clock_inHour'))), when, h('button', { type: 'button', class: 'chip small', onclick: () => { const ms = new Date(when.value).getTime(); if (ms > Date.now()) void set(ms); } }, t('apply')), h('button', { type: 'button', class: 'chip small', onclick: () => void set(undefined) }, t('clockClear'))));
  };
  sh.body.append(h('p', { class: 'hint' }, t('clockHint')), row('startAt', startLine), row('stopAt', stopLine));
}
