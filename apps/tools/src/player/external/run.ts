// Another app plays the video — the page's side (logic.ts is the plain part): the player chosen (the default for
// this kind of source, or asked), the relay opened when the source needs it, the subtitles and the start handed
// over, the app or program started, and what it tells back (where it stopped, whether it played to the end) fed to
// the same «watched» hook the app's own player uses — the player's memory, the episode cache, AniList / the TV list,
// the return to the show's page and its review prompt. Where the app tells nothing, «Mark as watched?» when the user
// comes back. The stream (the torrent's, the relay) lives while the player runs and is let go when it ends. Loaded
// only when another app is chosen.
import { h, icon, toast, openSheet } from '../../ui/dom';
import { t, localDigits } from '../../i18n';
import { getSettings, updateSettings } from '../../settings';
import { ktPlugin, nativePlatform } from '../../native';
import { getPrefs, memoryOf, remember } from '../prefs';
import type { Task } from '../../engine/types';
import { PLAYERS, playerById, playersFor, plan, androidIntent, androidResult, desktopCommand, isWatched, type ExtSource, type PlayerDef, type Platform, type Service, type Ready, type Command, type AndroidIntent } from './logic';

type Meta = Task['meta'];
export interface ExtRequest { src: ExtSource; service: Service; key: string; task?: Task; fileIndex?: number; meta?: Meta; /** the app's own player instead */ fallback: () => void }

type Desk = {
  os?: string; relayOpen?(o: unknown): Promise<{ token: string; url: string; subs: string[] }>; relayClose?(o: { token: string }): Promise<unknown>;
  extPlayers?(o: { cands: { id: string; paths: string[] }[] }): Promise<{ found: { id: string; path: string }[] }>;
  extPlayerStart?(o: Command): Promise<{ id: string }>; extPlayerStatus?(o: { id: string }): Promise<{ running: boolean; code: number | null; pos: number | null; dur: number | null; eof: boolean; error?: string }>;
  extPlayerStop?(o: { id: string }): Promise<unknown>; writeTemp?(o: { name: string; text: string }): Promise<{ path: string } | string>; streamDone?(o: { id: string }): Promise<unknown>;
};
type Plug = {
  relayOpen?(o: unknown): Promise<{ token: string; url: string; subs: string[] }>; relayClose?(o: { token: string }): Promise<unknown>;
  playerApps?(o: { pkgs: string[] }): Promise<{ installed: string[] }>;
  openPlayerApp?(o: AndroidIntent): Promise<{ code?: number; extras?: Record<string, unknown> | null }>;
};
const desk = (): Desk | undefined => window.kurokawaTools as unknown as Desk | undefined;
const plug = (): Plug | null => ktPlugin() as unknown as Plug | null;

export function platform(): Platform | null {
  const p = nativePlatform(); if (p === 'android') return 'android'; if (p !== 'desktop') return null;
  const os = desk()?.os ?? (navigator.platform.startsWith('Mac') ? 'darwin' : /Linux/.test(navigator.platform) ? 'linux' : 'win32');
  return os === 'darwin' ? 'mac' : os === 'linux' ? 'linux' : 'win';
}
const side = (p: Platform) => (p === 'android' ? 'android' : 'desktop') as 'android' | 'desktop';
export function defaultFor(p: Platform, s: Service): string { return getSettings().extPlayers?.[side(p)]?.[s] ?? 'ask'; }
export function setDefault(p: Platform, s: Service, id: string): void { const all = { ...(getSettings().extPlayers ?? {}) }; all[side(p)] = { ...(all[side(p)] ?? {}), [s]: id }; updateSettings({ extPlayers: all }); }

/** The players here: on a phone the installed apps (and «any app»); on a computer each program found, with its path. */
export async function installed(p: Platform): Promise<{ def: PlayerDef; path?: string; pkg?: string }[]> {
  const defs = playersFor(p); const out: { def: PlayerDef; path?: string; pkg?: string }[] = [];
  if (p === 'android') {
    const pk = plug(); const all = defs.flatMap((d) => d.pkgs ?? []);
    let have: string[] = []; try { have = (await pk?.playerApps?.({ pkgs: all }))?.installed ?? []; } catch { /* none known */ }
    for (const d of defs) { if (d.dialect === 'any') { out.push({ def: d }); continue; } const pkg = d.pkgs?.find((x) => have.includes(x)); if (pkg) out.push({ def: d, pkg }); }
    return out;
  }
  const d = desk(); let found: { id: string; path: string }[] = [];
  try { found = (await d?.extPlayers?.({ cands: defs.filter((x) => x.paths?.[p]).map((x) => ({ id: x.id, paths: x.paths![p as 'win'] ?? [] })) }))?.found ?? []; } catch { /* none */ }
  for (const x of defs) { const f = found.find((y) => y.id === x.id); if (f) out.push({ def: x, path: f.path }); }
  if ((getSettings().extCustom ?? '').trim()) out.push({ def: playerById('custom')! });
  return out;
}
export const nameOf = (d: PlayerDef): string => (d.id === 'any' ? t('extAnyApp') : d.id === 'custom' ? t('extCustom') : d.name);
const svcName = (s: Service) => ({ torrent: t('extSvcTorrent'), online: t('extSvcOnline'), http: t('extSvcHttp'), local: t('extSvcLocal') })[s];

/** The chooser: the players here, «always for this kind of source» as a switch. Null when closed. */
export function choose(p: Platform, s: Service, list: { def: PlayerDef }[], title = t('extChooseTitle')): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false; const answer = (v: string | null) => { if (done) return; done = true; if (v && always.checked) setDefault(p, s, v); sh.close(); resolve(v); };
    const sh = openSheet(title, t('close'), { stack: true, onClose: () => { if (!done) { done = true; resolve(null); } } });
    const always = h('input', { type: 'checkbox' }) as HTMLInputElement;
    sh.body.classList.add('ext-chooser');
    if (!list.length) sh.body.append(h('p', { class: 'hint ext-none' }, p === 'android' ? t('extNoPlayersPhone') : t('extNoPlayers')));
    sh.body.append(h('div', { class: 'watch-choices' }, ...list.map(({ def }) => h('button', { type: 'button', class: 'watch-choice', 'data-player': def.id, onclick: () => answer(def.id) },
      h('span', { class: 'watch-ic' }, icon(def.id === 'any' ? 'apps' : def.id === 'custom' ? 'terminal' : 'external')),
      h('span', { class: 'grow' }, h('b', null, nameOf(def)), h('small', null, def.id === 'any' ? t('extAnyAppHint') : def.reports ? t('extReports') : t('extNoReport'))))),
    h('button', { type: 'button', class: 'watch-choice ext-inapp', 'data-player': 'app', onclick: () => answer('app') }, h('span', { class: 'watch-ic' }, icon('play')), h('span', { class: 'grow' }, h('b', null, t('watchInApp')), h('small', null, t('watchInAppHint'))))),
    h('label', { class: 'row switch-row' }, h('span', null, t('extAlways', { what: svcName(s) })), always));
  });
}

/** An error the user can act on: the in-app player at once, or another app. */
function failed(msg: string, req: ExtRequest, p: Platform, again: () => void, detail?: string): void {
  const sh = openSheet(t('extFailedTitle'), t('close'), { stack: true });
  sh.body.classList.add('ext-error');
  sh.body.append(h('p', { class: 'ext-error-msg' }, msg), detail ? h('p', { class: 'hint ext-error-why', dir: 'ltr' }, detail) : '',
    h('div', { class: 'ext-error-actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); req.fallback(); } }, icon('play'), t('extFallback')),
      h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); again(); } }, icon('external'), t('extOther'))));
  void p;
}

/** «Mark as watched?» when the app said nothing (only for an episode the app keeps track of, or when asked to in Settings). */
export function askWatched(appName: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false; const answer = (v: boolean) => { if (done) return; done = true; sh.close(); resolve(v); };
    const sh = openSheet(t('extMarkTitle'), t('close'), { stack: true, onClose: () => { if (!done) { done = true; resolve(false); } } });
    sh.body.classList.add('ext-mark');
    sh.body.append(h('p', null, t('extMarkBody', { app: appName, name })),
      h('div', { class: 'ext-error-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => answer(true) }, icon('check'), t('extMarkYes')), h('button', { type: 'button', class: 'btn tonal', onclick: () => answer(false) }, t('extMarkNo'))));
  });
}

/** What came back, through the same hook as the in-app player's. `watched` once at most per playback. */
export async function applyResult(req: ExtRequest, r: { pos?: number; dur?: number; ended: boolean }, appName: string, reports: boolean): Promise<boolean> {
  const P = getPrefs(); const m = req.task?.meta ?? req.meta;
  if (r.dur && r.dur > 0 && r.pos !== undefined) remember(req.key, { pos: r.ended ? 0 : r.pos, duration: r.dur, ...(m?.anilistId || m?.imdbId ? { anilistId: m.anilistId, imdbId: m.imdbId, season: m.season, episode: m.episode, show: m.title, cover: m.cover } : {}) });
  let watched = P.markWatched !== false && isWatched(r, P.watchedAt);
  const tracked = !!(m?.anilistId && m.episode) || !!m?.imdbId;
  const ask = getSettings().extAskWatched;
  if ((!reports || (r.pos === undefined && !r.ended)) && (ask === true || (ask !== false && tracked))) watched = await askWatched(appName, req.src.name);
  if (watched) {
    remember(req.key, { watched: true });
    void import('../../downloads/episodeCache').then((c) => c.noteWatched(req.task)).catch(() => undefined);
    if (m?.anilistId && m.episode) void import('../../anime/progress').then((pr) => pr.markWatched(m.anilistId!, m.episode!, m.title));
    if (m?.imdbId) void import('../../tv/library').then((l) => l.markWatched(m.imdbId!, m.season, m.episode));
  } else if (r.pos && r.dur) { toast(t('extStoppedAt', { time: fmtTime(r.pos) })); }
  const at = location.hash; await import('../returnTo').then((rt) => rt.playerClosed({ watched, meta: m, at }));
  return watched;
}

/** The whole hand-over. False when this device has no way (the app's own player then). */
export async function playExternally(req: ExtRequest, forceAsk = false): Promise<boolean> {
  const p = platform(); if (!p) return false;
  const here = await installed(p);
  let id = forceAsk ? 'ask' : defaultFor(p, req.service);
  if (id === 'app') { req.fallback(); return true; }
  if (id !== 'ask' && !here.some((x) => x.def.id === id)) id = 'ask';
  if (id === 'ask') { const c = await choose(p, req.service, here); if (!c) return true; if (c === 'app') { req.fallback(); return true; } id = c; }
  const got = here.find((x) => x.def.id === id); const def = got?.def ?? playerById(id); if (!def) return false;
  const again = () => void playExternally(req, true);
  const pl = plan(req.src, def, p);
  if (pl.problem === 'hls') { failed(t('extCantHls', { app: nameOf(def) }), req, p, again); return true; }
  // ---- the relay, and subtitles a player reads only from disk
  let relay: { token: string; url: string; subs: string[] } | null = null;
  const relayer = p === 'android' ? plug() : desk();
  const subs = req.src.subs ?? [];
  try {
    if (pl.relay) {
      if (!relayer?.relayOpen) { if (pl.main === 'relay') { failed(t('extNoRelay', { app: nameOf(def) }), req, p, again); return true; } }
      else relay = await relayer.relayOpen({ url: pl.main === 'relay' ? req.src.url : '', headers: req.src.headers ?? {}, name: req.src.name, subs: subs.map((s, i) => (pl.subs[i] === 'relay' ? { url: s.url, path: s.path, name: s.name, headers: s.headers } : { name: s.name })) });
    }
    const readySubs: Ready['subs'] = [];
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i]; const how = pl.subs[i]; let at = '';
      if (how === 'relay') at = relay?.subs[i] ?? ''; else if (how === 'path') at = s.path ?? ''; else if (how === 'direct') at = s.url ?? '';
      else if (how === 'temp') at = await saveSub(s);
      if (at) readySubs.push({ at, name: s.name, isDefault: s.isDefault });
    }
    const start = req.src.start && req.src.start > 1 ? req.src.start : undefined;
    const ready: Ready = { target: pl.main === 'relay' ? relay?.url ?? req.src.url : pl.main === 'path' ? req.src.localPath ?? req.src.url : req.src.url, isPath: pl.main === 'path', title: req.src.name, start: def.start ? start : undefined, subs: readySubs, headers: pl.headerArgs ? req.src.headers : undefined, alang: def.langs ? req.src.alang : undefined, slang: def.langs ? req.src.slang : undefined };
    const r = p === 'android' ? await runAndroid(def, ready, got?.pkg) : await runDesktop(def, ready, got?.path ?? '', p);
    await applyResult(req, r, nameOf(def), def.reports);
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    failed(/not installed|ENOENT|ActivityNotFound/i.test(why) ? t('extNotInstalled', { app: nameOf(def) }) : t('extFailed', { app: nameOf(def) }), req, p, again, why);
  } finally {
    if (relay) void relayer?.relayClose?.({ token: relay.token }).catch(() => undefined);
    if (req.task?.kind === 'torrent' && p !== 'android') void desk()?.streamDone?.({ id: req.task.id }).catch(() => undefined);
  }
  return true;
}
async function saveSub(s: { url?: string; path?: string; name: string; headers?: Record<string, string> }): Promise<string> {
  if (s.path) return s.path; if (!s.url) return '';
  try { const text = await (await fetch(s.url, { headers: s.headers })).text(); const name = `kt-sub-${Date.now().toString(36)}-${s.name.replace(/[^\w.-]+/g, '_').slice(0, 40)}${/\.(ass|ssa|srt|vtt)$/i.test(s.name) ? '' : /^\s*\[Script Info\]/i.test(text) ? '.ass' : /^WEBVTT/.test(text) ? '.vtt' : '.srt'}`; const r = await desk()?.writeTemp?.({ name, text }); return typeof r === 'string' ? r : r?.path ?? ''; } catch { return ''; }
}

/** The phone: the app opened for its result (VLC, MX, mpv, Just answer with where they stopped); «any app» by the
 *  phone's chooser, then «Mark as watched?» when the user is back. */
async function runAndroid(def: PlayerDef, r: Ready, pkg?: string): Promise<{ pos?: number; dur?: number; ended: boolean }> {
  const pk = plug(); if (!pk?.openPlayerApp) throw new Error('openPlayerApp');
  const intent = androidIntent(def, r, pkg);
  const res = await pk.openPlayerApp(intent);
  if (!intent.result) await backHere();
  return androidResult(def, res?.extras);
}
/** Resolved when the page is seen again after it was hidden (the other app in front), or after eight hours. */
function backHere(): Promise<void> {
  return new Promise((resolve) => {
    let hidden = document.hidden; const end = () => { document.removeEventListener('visibilitychange', on); window.clearTimeout(tm); resolve(); };
    const on = () => { if (document.hidden) hidden = true; else if (hidden) end(); };
    document.addEventListener('visibilitychange', on); const tm = window.setTimeout(end, 8 * 3600e3);
  });
}
/** The computer: the program started; asked how it goes every two seconds while it runs (mpv's own position told
 *  by its IPC in the shell), the stream released when it has ended. */
async function runDesktop(def: PlayerDef, r: Ready, exe: string, p: Platform): Promise<{ pos?: number; dur?: number; ended: boolean }> {
  const d = desk(); if (!d?.extPlayerStart || !d.extPlayerStatus) throw new Error('extPlayerStart');
  const cmd = desktopCommand(def, r, exe, getSettings().extCustom); if (!cmd.exe) throw new Error(t('extNoCommand'));
  void p;
  const { id } = await d.extPlayerStart(cmd);
  toast(t('extPlaying', { app: nameOf(def) }));
  let last: { pos: number | null; dur: number | null; eof: boolean } = { pos: null, dur: null, eof: false };
  for (;;) {
    await new Promise((ok) => window.setTimeout(ok, DESK_POLL_MS));
    const st = await d.extPlayerStatus({ id });
    if (st.pos !== null && st.pos !== undefined) last.pos = st.pos; if (st.dur !== null && st.dur !== undefined) last.dur = st.dur; if (st.eof) last.eof = true;
    if (!st.running) { if (st.error && st.error !== 'unknown') throw new Error(st.error); if (st.code && st.code !== 0 && last.pos === null && def.reports) throw new Error(`exit ${st.code}`); break; }
  }
  last = { ...last }; return { pos: last.pos ?? undefined, dur: last.dur ?? undefined, ended: last.eof };
}
let DESK_POLL_MS = 2000;
const fmtTime = (x: number): string => { const v = Math.max(0, Math.round(x)); const hh = Math.floor(v / 3600), mm = Math.floor((v % 3600) / 60), ss = v % 60; return localDigits((hh ? `${hh}:${String(mm).padStart(2, '0')}:` : `${mm}:`) + String(ss).padStart(2, '0')); };
/** (Tests: a shorter wait between questions.) */
export function setPollMs(ms: number): void { DESK_POLL_MS = ms; }

/** The source as the app's own player would get it, made ready for another app. */
export function sourceFor(o: { url: string; name: string; localPath?: string; headers?: Record<string, string>; hls?: boolean; subtitles?: { url: string; name: string; lang?: string; isDefault?: boolean }[]; startAt?: number; key: string }): ExtSource {
  const P = getPrefs(); const mem = memoryOf(o.key);
  const start = o.startAt ?? (mem && !mem.watched && P.resume !== 'never' && mem.pos > 5 && (!mem.duration || mem.pos < mem.duration - 10) ? mem.pos : undefined);
  const local = (u: string) => /^(file:|\/|[A-Za-z]:\\)/.test(u);
  return { url: o.url, name: o.name, localPath: o.localPath, headers: o.headers, hls: o.hls ?? /\.m3u8(\?|$)/i.test(o.url), start,
    subs: (o.subtitles ?? []).map((s) => (local(s.url) ? { path: s.url.replace(/^file:\/\//, ''), name: s.name, lang: s.lang, isDefault: s.isDefault } : { url: s.url, name: s.name, lang: s.lang, isDefault: s.isDefault, headers: o.headers })),
    slang: getSettings().subLangs ?? [], alang: P.audioLangs };
}
export { PLAYERS };
