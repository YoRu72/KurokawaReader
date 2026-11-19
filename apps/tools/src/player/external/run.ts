// Another app plays the video — the page's side (logic.ts is the plain part). Two ways only: the app's own player,
// or the outside way — «Another app» on a phone (the phone's own list), «A player on this PC» on a computer (Settings
// → Player says which: the first known player found, one of them, or a program picked in the shell's own dialog).
// The relay is opened when the source needs it, subtitles and the start handed over, and what comes back (where it
// stopped, played to the end) is fed to the same «watched» hook as the app's own player: the memory, the episode
// cache, AniList / the TV list, the return to the show's page and its review prompt — once. Where nothing comes
// back, «Mark as watched?» when the person is back. The stream (the torrent's, the relay) is let go when the player
// has finished with it: at once for one that tells (mpv, a phone app's answer); for one that does not, only once the
// relay has not been read for a while — a player may hand the address to an instance already open and exit at once. Loaded only when the outside way is chosen.
import { h, icon, toast, openSheet } from '../../ui/dom';
import { t, localDigits } from '../../i18n';
import { getSettings, updateSettings } from '../../settings';
import { ktPlugin, nativePlatform } from '../../native';
import { getPrefs, memoryOf, remember } from '../prefs';
import type { Task } from '../../engine/types';
import { plan, androidIntent, androidResult, isWatched, autoPick, pcCaps, chosenCaps, wayOf, isLoopback, type ExtSource, type Platform, type Service, type Ready, type AndroidIntent, type Caps, type Way } from './logic';

type Meta = Task['meta'];
export interface ExtRequest { src: ExtSource; service: Service; key: string; task?: Task; fileIndex?: number; meta?: Meta; /** the app's own player instead */ fallback: () => void; /** opened from inside the app's own player (closed for the hand-over): cancelling reopens it */ fromPlayer?: boolean; /** the app's own player has already counted it watched */ alreadyWatched?: boolean }
type Found = { found: { id: string; name: string }[]; chosen: { path: string; args: string; there: boolean } | null };
type Desk = {
  os?: string; relayOpen?(o: unknown): Promise<{ token: string; url: string; subs: string[] }>; relayClose?(o: { token: string }): Promise<unknown>; relayStatus?(o: { token: string }): Promise<{ open: boolean; lastRead?: number; reading?: number }>;
  extPlayers?(): Promise<Found>; extPlayerChoose?(o: { title: string }): Promise<{ path: string } | null>; extPlayerArgs?(o: { args: string }): Promise<unknown>;
  extPlayerStart?(o: unknown): Promise<{ id: string; reports: boolean }>; extPlayerStatus?(o: { id: string }): Promise<{ running: boolean; code: number | null; pos: number | null; dur: number | null; eof: boolean; error?: string }>;
  writeTemp?(name: string, text: string): Promise<string>; extPlayerDropSub?(o: { path: string }): Promise<unknown>; streamDone?(o: { id: string }): Promise<unknown>; fileUrl?(p: string): Promise<string>;
};
type Plug = {
  relayOpen?(o: unknown): Promise<{ token: string; url: string; subs: string[] }>; relayClose?(o: { token: string }): Promise<unknown>;
  openPlayerApp?(o: AndroidIntent): Promise<{ code?: number; action?: string; extras?: Record<string, unknown> | null }>; localUrl?(o: { path: string }): Promise<{ url: string }>;
};
const desk = (): Desk | undefined => window.kurokawaTools as unknown as Desk | undefined;
const plug = (): Plug | null => ktPlugin() as unknown as Plug | null;

export function platform(): Platform | null {
  const p = nativePlatform(); if (p === 'android') return 'android'; if (p !== 'desktop') return null;
  const os = desk()?.os ?? (navigator.platform.startsWith('Mac') ? 'darwin' : /Linux/.test(navigator.platform) ? 'linux' : 'win32');
  return os === 'darwin' ? 'mac' : os === 'linux' ? 'linux' : 'win';
}
const side = (p: Platform) => (p === 'android' ? 'android' : 'desktop') as 'android' | 'desktop';
/** The way for this kind of video: its own choice if one was made, else what «Watch videos with» says. */
export function defaultFor(p: Platform, s: Service): Way {
  const own = getSettings().extPlayers?.[side(p)]?.[s]; if (own) return wayOf(own);
  const w = getSettings().playerWith; return w === 'app' ? 'app' : w === 'external' ? 'out' : 'ask';
}
export function setDefault(p: Platform, s: Service, w: Way): void { const all = { ...(getSettings().extPlayers ?? {}) }; all[side(p)] = { ...(all[side(p)] ?? {}), [s]: w }; updateSettings({ extPlayers: all }); }
export const outName = (p: Platform): string => (p === 'android' ? t('extAnyApp') : t('extPcPlayer'));
const svcName = (s: Service) => ({ torrent: t('extSvcTorrent'), online: t('extSvcOnline'), http: t('extSvcHttp'), local: t('extSvcLocal') })[s];

/** The computer's player as the setting says, resolved against what the shell found. */
export async function pcPlayer(): Promise<{ caps?: Caps; list: Found; want: string }> {
  let list: Found = { found: [], chosen: null };
  try { list = (await desk()?.extPlayers?.()) ?? list; } catch { /* none */ }
  const want = getSettings().extPcPlayer ?? 'auto';
  if (want === 'chosen' && list.chosen?.there) return { caps: chosenCaps(list.chosen.args, list.chosen.path.split(/[\\/]/).pop() ?? ''), list, want };
  const named = want !== 'auto' && want !== 'chosen' && list.found.some((f) => f.id === want) ? pcCaps(want) : undefined;
  const caps = named ?? autoPick(list.found) ?? (list.chosen?.there ? chosenCaps(list.chosen.args, list.chosen.path.split(/[\\/]/).pop() ?? '') : undefined);
  return { caps, list, want };
}
/** The shell's own dialog: the program picked is kept by the shell; here only «chosen». */
export async function chooseProgram(): Promise<boolean> {
  let r: { path: string } | null = null;
  try { r = (await desk()?.extPlayerChoose?.({ title: t('extPickTitle') })) ?? null; }
  catch (e) { const m = String((e as Error)?.message ?? e); toast(/kt-ext:batch/.test(m) ? t('extProgramBatch') : t('extProgramBad'), 'error', 6000); return false; }
  if (!r?.path) return false; updateSettings({ extPcPlayer: 'chosen' }); return true;
}

/** The chooser: two ways, and «always for this kind of video» as a switch. Null when closed. */
export function choose(p: Platform, s: Service, outHint: string): Promise<Way | null> {
  return new Promise((resolve) => {
    let done = false; const answer = (v: Way | null) => { if (done) return; done = true; if (v && always.checked) setDefault(p, s, v); sh.close(); resolve(v); };
    const sh = openSheet(t('extChooseTitle'), t('close'), { stack: true, onClose: () => { if (!done) { done = true; resolve(null); } } });
    const always = h('input', { type: 'checkbox' }) as HTMLInputElement;
    sh.body.classList.add('ext-chooser');
    const choice = (ic: string, title: string, sub: string, v: Way) => h('button', { type: 'button', class: 'watch-choice', 'data-way': v, onclick: () => answer(v) }, h('span', { class: 'watch-ic' }, icon(ic)), h('span', { class: 'grow' }, h('b', null, title), h('small', null, sub)));
    sh.body.append(h('div', { class: 'watch-choices' },
      choice('play', t('watchInApp'), t('watchInAppHint'), 'app'),
      choice(p === 'android' ? 'apps' : 'external', outName(p), outHint, 'out')),
    h('label', { class: 'row switch-row' }, h('span', null, t('extAlways', { what: svcName(s) })), always));
  });
}

/** An error the person can act on: the in-app player at once, or (phone) the list again / (computer) a program. */
function failed(msg: string, req: ExtRequest, p: Platform, again: () => void, detail?: string, dismissed?: () => void): void {
  let acted = false;
  const sh = openSheet(t('extFailedTitle'), t('close'), { stack: true, onClose: () => { if (!acted) dismissed?.(); } });
  sh.body.classList.add('ext-error');
  const act = (fn: () => void) => () => { acted = true; sh.close(); fn(); };
  sh.body.append(h('p', { class: 'ext-error-msg' }, msg), detail ? h('p', { class: 'hint ext-error-why', dir: 'ltr' }, detail) : '',
    h('div', { class: 'ext-error-actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: act(() => req.fallback()) }, icon('play'), t('extFallback')),
      p === 'android'
        ? h('button', { type: 'button', class: 'btn tonal', onclick: act(again) }, icon('apps'), t('extOther'))
        : h('button', { type: 'button', class: 'btn tonal', onclick: act(() => void chooseProgram().then((ok) => { if (ok) again(); else dismissed?.(); })) }, icon('folder'), t('extChooseProgram'))));
}
/** «Mark as watched?» when nothing came back. */
export function askWatched(appName: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false; const answer = (v: boolean) => { if (done) return; done = true; sh.close(); resolve(v); };
    const sh = openSheet(t('extMarkTitle'), t('close'), { stack: true, onClose: () => { if (!done) { done = true; resolve(false); } } });
    sh.body.classList.add('ext-mark');
    sh.body.append(h('p', null, t('extMarkBody', { app: appName, name })),
      h('div', { class: 'ext-error-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => answer(true) }, icon('check'), t('extMarkYes')), h('button', { type: 'button', class: 'btn tonal', onclick: () => answer(false) }, t('extMarkNo'))));
  });
}
/** Whether «Mark as watched?» is asked: never when the player's «mark watched» is off or the setting says never;
 *  always when it says always; otherwise for an episode the app keeps track of. */
export function shouldAsk(m?: Meta): boolean {
  if (getPrefs().markWatched === false) return false;
  const a = getSettings().extAskWatched; if (a === false) return false; if (a === true) return true;
  return !!(m?.anilistId && m.episode) || !!m?.imdbId;
}

/** What came back, through the same hook as the in-app player's; watched at most once (and not again when the app's
 *  own player already counted it). */
export async function applyResult(req: ExtRequest, r: { pos?: number; dur?: number; ended: boolean; told: boolean }, appName: string): Promise<boolean> {
  const P = getPrefs(); const m = req.task?.meta ?? req.meta;
  if (r.dur && r.dur > 0 && r.pos !== undefined) remember(req.key, { pos: r.ended ? 0 : r.pos, duration: r.dur, ...(m?.anilistId || m?.imdbId ? { anilistId: m.anilistId, imdbId: m.imdbId, season: m.season, episode: m.episode, show: m.title, cover: m.cover } : {}) });
  let watched = P.markWatched !== false && isWatched(r, P.watchedAt);
  if (!r.told && !req.alreadyWatched && shouldAsk(m)) watched = await askWatched(appName, req.src.name);
  if (watched && !req.alreadyWatched) {
    remember(req.key, { watched: true });
    void import('../../downloads/episodeCache').then((c) => c.noteWatched(req.task)).catch(() => undefined);
    if (m?.anilistId && m.episode) void import('../../anime/progress').then((pr) => pr.markWatched(m.anilistId!, m.episode!, m.title));
    if (m?.imdbId) void import('../../tv/library').then((l) => l.markWatched(m.imdbId!, m.season, m.episode));
  } else if (!watched && r.pos && r.dur) toast(t('extStoppedAt', { time: fmtTime(r.pos) }));
  const at = location.hash; await import('../returnTo').then((rt) => rt.playerClosed({ watched: watched && !req.alreadyWatched, meta: m, at }));
  return watched;
}

/** The whole hand-over. False when this device has no way (the app's own player then).
 *  The torrent's stream is let go only when nothing will play it any more: after the outside player is done with it,
 *  or when the person gives up (the chooser or an error closed without the app's own player); «Watch in the in-app
 *  player» keeps it (that player lets it go when it closes). Cancelling a hand-over started from inside the app's own
 *  player reopens it where it was. */
export async function playExternally(req: ExtRequest, forceAsk = false): Promise<boolean> {
  const p = platform(); if (!p) return false;
  const giveUp = () => { if (req.fromPlayer) req.fallback(); else releaseStream(req, p); };
  let pc: Awaited<ReturnType<typeof pcPlayer>> | null = p === 'android' ? null : await pcPlayer();
  let way: Way = forceAsk ? 'ask' : defaultFor(p, req.service);
  if (way === 'ask') { const c = await choose(p, req.service, p === 'android' ? t('extHintPhone') : outHint(pc!.caps)); if (!c) { giveUp(); return true; } way = c; }
  if (way === 'app') { req.fallback(); return true; }
  // (A computer with no player found and none picked: pick the program now.)
  if (pc && !pc.caps) { toast(t('extNothingFound'), 'info', 4000); if (!(await chooseProgram())) { giveUp(); return true; } pc = await pcPlayer(); if (!pc.caps) { giveUp(); return true; } }
  const name = p === 'android' ? t('extAnyApp') : pc!.caps!.name;
  const again = () => void playExternally(req, true);
  const pl = plan(req.src, p, pc?.caps);
  if (pl.problem === 'hls') { failed(t('extCantHls', { app: name }), req, p, again, undefined, giveUp); return true; }
  const relayer = p === 'android' ? plug() : desk();
  let relay: { token: string; url: string; subs: string[] } | null = null;
  const temps: string[] = [];
  let keep = false;
  // (Everything this playback holds — the relay session, the subtitle copies, and once the outside player is done the
  // torrent's stream — let go once, BEFORE «Mark as watched?» is asked: an unanswered question holds nothing.)
  let cleaned = false;
  const letGo = (stream: boolean): void => { if (cleaned) return; cleaned = true; closeRelay(relay, relayer); dropTemps(temps); if (stream) releaseStream(req, p); };
  try {
    const subs = await localSubs(p, req.src.subs ?? []);
    if (pl.relay) {
      if (!relayer?.relayOpen) { failed(t('extNoRelay', { app: name }), req, p, again, undefined, giveUp); return true; }
      const file = p !== 'android' && req.src.localPath ? req.src.localPath : undefined;
      relay = await relayer.relayOpen({ url: pl.main === 'relay' && !file ? req.src.url : '', file, headers: req.src.headers ?? {}, name: req.src.name, subs: subs.map((s, i) => (pl.subs[i] === 'relay' ? { url: s.url, name: s.name, headers: s.headers } : { name: s.name })) });
    }
    const readySubs: Ready['subs'] = [];
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i]; const how = pl.subs[i]; let at = '';
      if (how === 'relay') at = relay?.subs[i] ?? ''; else if (how === 'direct') at = s.url ?? ''; else if (how === 'temp') { at = await saveSub(s); if (at) temps.push(at); }
      if (at) readySubs.push({ at, name: s.name, isDefault: s.isDefault });
    }
    const start = req.src.start && req.src.start > 1 ? req.src.start : undefined;
    const target = pl.main === 'relay' ? relay?.url ?? req.src.url : pl.main === 'path' ? req.src.localPath ?? req.src.url : req.src.url;
    if (p === 'android') {
      const pk = plug(); if (!pk?.openPlayerApp) throw new Error('openPlayerApp');
      noteLaunch(req);
      const res = await pk.openPlayerApp(androidIntent({ target, isPath: pl.main === 'path', title: req.src.name, start, subs: readySubs }));
      clearLaunch();
      letGo(true);
      await applyResult(req, androidResult(res), name);
    } else {
      const caps = pc!.caps!;
      const hd = Object.fromEntries(Object.entries(req.src.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const headers = pl.headerArgs ? { ua: hd['user-agent'], referer: hd.referer } : {};
      const r = await runDesktop({ player: caps.id, target, title: req.src.name, start, subs: readySubs.map((s) => ({ at: s.at, isDefault: !!s.isDefault })), headers, slang: req.src.slang ?? [], alang: req.src.alang ?? [] }, name);
      if (!r.reports) { keep = true; void afterUntold(req, name, relay, relayer, temps); return true; }
      letGo(true);
      await applyResult(req, { pos: r.pos, dur: r.dur, ended: r.ended, told: r.pos !== undefined || r.ended }, name);
    }
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    failed(/not installed|ENOENT|ActivityNotFound/i.test(why) ? t('extNotInstalled', { app: name }) : t('extFailed', { app: name }), req, p, again, /^\s*not installed\s*$/i.test(why) ? undefined : why, giveUp); // (a bare «not installed» is what the message already says)
  } finally {
    if (!keep) letGo(false);
  }
  return true;
}
function closeRelay(relay: { token: string } | null, relayer: Desk | Plug | null | undefined): void { if (relay) void relayer?.relayClose?.({ token: relay.token }).catch(() => undefined); }
function releaseStream(req: ExtRequest, p: Platform): void { if (req.task?.kind === 'torrent' && p !== 'android') void desk()?.streamDone?.({ id: req.task.id }).catch(() => undefined); }
/** The subtitle copies saved for this playback: removed by the shell once the player is done (only kt-sub-* files there). */
function dropTemps(temps: string[]): void { for (const f of temps) void desk()?.extPlayerDropSub?.({ path: f }).catch(() => undefined); }
/** A computer's player that tells nothing ended its process: it may have handed the address to an instance already
 *  open (a single-instance player, a wrapper), so the relay and the stream stay until the relay has not been read for
 *  ten minutes (nothing reading — a paused or fully buffered film keeps nothing reading, hence the long wait); then
 *  the relay, the stream and the subtitle copies go, and only then «Mark as watched?» is asked where it is.
 *  At most eight hours. */
async function afterUntold(req: ExtRequest, name: string, relay: { token: string } | null, relayer: Desk | Plug | null | undefined, temps: string[]): Promise<void> {
  const d = desk(); const until = Date.now() + 8 * 3600e3;
  for (;;) {
    if (Date.now() > until) break;
    const st = relay ? await d?.relayStatus?.({ token: relay.token }).catch(() => null) : null;
    const quiet = !st || !st.open || (!(st.reading ?? 0) && Date.now() - (st.lastRead ?? 0) > UNTOLD_QUIET_MS);
    if (quiet) break;
    await new Promise((ok) => window.setTimeout(ok, UNTOLD_POLL_MS));
  }
  closeRelay(relay, relayer); releaseStream(req, 'win'); dropTemps(temps);
  await applyResult(req, { ended: false, told: false }, name).catch(() => undefined);
}
let UNTOLD_QUIET_MS = 10 * 60e3; let UNTOLD_POLL_MS = 5000; let DESK_POLL_MS = 2000;
/** (Tests: shorter waits.) */
export function setWaits(o: { poll?: number; quiet?: number; untoldPoll?: number }): void { if (o.poll) DESK_POLL_MS = o.poll; if (o.quiet) UNTOLD_QUIET_MS = o.quiet; if (o.untoldPoll) UNTOLD_POLL_MS = o.untoldPoll; }
const outHint = (c?: Caps): string => (!c ? t('extHintPick') : c.reports ? t('extHintReports') : t('extHintAsks'));

/** Local subtitles made addresses, one for one (the plan's places kept): a phone's by the app's loopback address (only
 *  files outside the app's own folders); a computer's read here through the app's own file address and handed over
 *  as a saved copy (the plan saves every local one), so that address and its run token never leave the app. */
async function localSubs(p: Platform, subs: NonNullable<ExtSource['subs']>): Promise<NonNullable<ExtSource['subs']>> {
  const out: NonNullable<ExtSource['subs']> = [];
  for (const s of subs) {
    if (!s.path) { out.push(s); continue; }
    let url = '';
    try {
      if (p === 'android') { if (!/^\/data\//.test(s.path)) url = (await plug()?.localUrl?.({ path: s.path }))?.url ?? ''; }
      else url = (await desk()?.fileUrl?.(s.path)) ?? '';
    } catch { url = ''; }
    out.push({ url, name: s.name, isDefault: s.isDefault });
  }
  return out;
}
/** A subtitle saved for a player that reads them only from disk (the shell takes only a file in its temp folder). */
async function saveSub(s: { url?: string; name: string; headers?: Record<string, string> }): Promise<string> {
  if (!s.url) return '';
  try {
    const text = await (await fetch(s.url, isLoopback(s.url) ? undefined : { headers: s.headers })).text();
    const ext = /\.(ass|ssa|srt|vtt)$/i.exec(s.name)?.[0] ?? (/^\s*\[Script Info\]/i.test(text) ? '.ass' : /^WEBVTT/.test(text) ? '.vtt' : '.srt');
    // (The bridge's writeTemp takes the name and the text, as cut.ts and embedded.ts call it.)
    const r = await desk()?.writeTemp?.(`kt-sub-${Date.now().toString(36)}${ext}`, text); return typeof r === 'string' ? r : '';
  } catch { return ''; }
}

/** The computer: the shell starts the player from the typed request; asked how it goes every two seconds while it
 *  runs (mpv's position told by its IPC in the shell). */
async function runDesktop(o: unknown, name: string): Promise<{ pos?: number; dur?: number; ended: boolean; reports: boolean }> {
  const d = desk(); if (!d?.extPlayerStart || !d.extPlayerStatus) throw new Error('extPlayerStart');
  const { id, reports } = await d.extPlayerStart(o);
  toast(t('extPlaying', { app: name }));
  const last: { pos: number | null; dur: number | null; eof: boolean } = { pos: null, dur: null, eof: false };
  for (;;) {
    await new Promise((ok) => window.setTimeout(ok, DESK_POLL_MS));
    const st = await d.extPlayerStatus({ id });
    if (st.pos !== null && st.pos !== undefined) last.pos = st.pos; if (st.dur !== null && st.dur !== undefined) last.dur = st.dur; if (st.eof) last.eof = true;
    if (!st.running) { if (st.error && st.error !== 'unknown') throw new Error(st.error); if (reports && st.code && st.code !== 0 && last.pos === null) throw new Error(`exit ${st.code}`); break; }
  }
  return { pos: last.pos ?? undefined, dur: last.dur ?? undefined, ended: last.eof, reports };
}
const fmtTime = (x: number): string => { const v = Math.max(0, Math.round(x)); const hh = Math.floor(v / 3600), mm = Math.floor((v % 3600) / 60), ss = v % 60; return localDigits((hh ? `${hh}:${String(mm).padStart(2, '0')}:` : `${mm}:`) + String(ss).padStart(2, '0')); };

/* ---------- a phone app's answer after Android let the app go (Capacitor's appRestoredResult) ---------- */
const PENDING = 'kt.tmp.extPending';
function noteLaunch(req: ExtRequest): void { try { localStorage.setItem(PENDING, JSON.stringify({ key: req.key, name: req.src.name, meta: req.task?.meta ?? req.meta, alreadyWatched: !!req.alreadyWatched, at: Date.now() })); } catch { /* full */ } }
function clearLaunch(): void { try { localStorage.removeItem(PENDING); } catch { /* */ } }
/** main.ts, on a restored result of openPlayerApp: the answer applied to the playback noted before the app went. */
export async function restoredResult(data: { code?: number; action?: string; extras?: Record<string, unknown> } | undefined): Promise<void> {
  let n: { key: string; name: string; meta?: Meta; alreadyWatched?: boolean; at: number } | null = null;
  try { n = JSON.parse(localStorage.getItem(PENDING) ?? 'null'); } catch { /* */ } clearLaunch();
  if (!n || Date.now() - n.at > 12 * 3600e3) return;
  await applyResult({ src: { url: '', name: n.name }, service: 'http', key: n.key, meta: n.meta, alreadyWatched: n.alreadyWatched, fallback: () => undefined }, androidResult(data), t('extAnyApp'));
}

/** The source as the app's own player would get it, made ready for another app. */
export function sourceFor(o: { url: string; name: string; localPath?: string; headers?: Record<string, string>; hls?: boolean; subtitles?: { url: string; name: string; lang?: string; isDefault?: boolean }[]; startAt?: number; key: string }): ExtSource {
  const P = getPrefs(); const mem = memoryOf(o.key);
  const start = o.startAt ?? (mem && !mem.watched && P.resume !== 'never' && mem.pos > 5 && (!mem.duration || mem.pos < mem.duration - 10) ? mem.pos : undefined);
  const local = (u: string) => /^(file:|\/|[A-Za-z]:\\)/.test(u);
  return { url: o.url, name: o.name, localPath: o.localPath, headers: o.headers, hls: o.hls ?? /\.m3u8(\?|$)/i.test(o.url), start,
    subs: (o.subtitles ?? []).map((s) => (local(s.url) ? { path: s.url.replace(/^file:\/\//, ''), name: s.name, lang: s.lang, isDefault: s.isDefault } : { url: s.url, name: s.name, lang: s.lang, isDefault: s.isDefault, headers: o.headers })),
    slang: getSettings().subLangs ?? [], alang: P.audioLangs };
}
