// A stream in the app's own player (a download watched while it comes, an online episode — never a finished file):
// the viewer is never left with a black screen, a spinner for ever or a bare «Failed». Loaded with the player for a
// stream only (the web view's engine; mpv watches its own network). The rules, one per kind of trouble:
//   · start and stalls: the spinner from the first moment, a line that says what is happening and how many seconds
//     of the video are ready (player.ts's waitTick asks `line()`);
//   · nothing new for 10 s — no byte, no frame — while the video should be moving (the page seen, online, not paused
//     by the viewer): the same place asked again, twice; then an error with Retry and Back (a torrent with its swarm
//     line is asked again but never given up on: its line already tells how many peers there are);
//   · a network error: the address checked with a one-byte request — 401/403/404/410 is an expired link, a new
//     address asked of the opener (`renew`) and played from the same place; any other answer the same address asked
//     again, twice; still nothing → the error with its way out;
//   · offline: said at once, nothing counted while offline, asked again at the place it was when the connection is back;
//   · a seek the source cannot do (it ignores ranges): said, instead of nothing happening;
//   · an early end (the time jumping to the end with no seek): asked again once at the last place played, then
//     said with Retry and Back — never counted as watched.
// Everything it starts (one interval, its listeners, a sheet) ends with `stop()` (the player's close).
import { h, icon, openSheet } from '../ui/dom';
import { t } from '../i18n';

export interface GuardHost {
  video: HTMLVideoElement;
  /** The player shows its spinner and line (busy) or not. */
  busy(): boolean; setBusy(on: boolean): void;
  /** A short notice over the picture. */
  notice(text: string): void;
  /** The player's source address now, and a new one taken (src.url kept in step). */
  url(): string; setUrl(u: string): void;
  /** A fresh address for this stream from its opener (the download's stream address, the episode's server again). */
  renew?: () => Promise<string>;
  torrent: boolean;
  /** Back: the player closed. */
  back(): void;
  /** Another stream to choose (the chooser again), when there is one: a third action on the failure sheet. */
  another?: () => void;
  /** The address answers but the file cannot be played: the player's own handling of a file it cannot read. */
  fileError(): void;
  fmt(s: number): string;
}
export interface Guard { stop(): void; line(): string | null; onError(): boolean; earlyEnd(): boolean; started(): boolean; /** The last place played in order (a jump with no seek not counted). */ played(): number }

// (A stream with no length — the computer's HLS turned into MP4 as it comes — cannot be asked again at a place: a new
// request starts it over. Its own reader skips a segment that never comes after about 25 s, so it is waited for
// longer and then said, never restarted behind the viewer's back.)
const QUIET_MS = 10000; const QUIET_LIVE_MS = 40000; const TRIES = 2;

export function guardStream(o: GuardHost): Guard {
  const v = o.video; let gone = false; let started = false; let tries = 0; let renewTries = 0; let endTries = 0;
  // (lastGood: the last place played in order; want: where the viewer wants to be — a seek not done yet counts;
  // settledAt: tries are counted again only once the video has played 5 s past a new request.)
  let say: string | null = null; let lastSig = ''; let quietSince = Date.now(); let lastGood = 0; let want = 0; let prevT = 0; let seekingTo = -1; let settledAt = Infinity;
  let reopening = false; let sheetClose: (() => void) | null = null; let offline = !navigator.onLine; let viewerPaused = false;
  const offs: (() => void)[] = [];
  const on = (tg: EventTarget, ty: string, fn: EventListener) => { tg.addEventListener(ty, fn); offs.push(() => tg.removeEventListener(ty, fn)); };
  const ahead = () => { let a = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.25) a = Math.max(a, v.buffered.end(i) - v.currentTime); return Math.max(0, a); };
  const sig = () => { let s = `${v.readyState}|${Math.round(v.currentTime * 4)}`; for (let i = 0; i < v.buffered.length; i++) s += `|${v.buffered.end(i).toFixed(2)}`; return s; };

  on(v, 'playing', () => { started = true; say = null; quietSince = Date.now(); });
  // (A pause the viewer made — not the one an end, an error or a new request makes.)
  on(v, 'pause', () => { if (started && !reopening && !v.ended && !v.error) viewerPaused = true; });
  on(v, 'play', () => { viewerPaused = false; quietSince = Date.now(); });
  on(v, 'seeking', () => {
    seekingTo = v.currentTime; prevT = v.currentTime; quietSince = Date.now(); if (reopening) return; want = seekingTo;
    // (A source that ignores ranges cannot jump: said, instead of a seek that does nothing.)
    if (started && v.duration > 0) { let ok = false; for (let i = 0; i < v.seekable.length; i++) if (v.seekable.start(i) <= seekingTo + 0.5 && v.seekable.end(i) >= seekingTo - 0.5) ok = true; if (!ok) o.notice(t('streamNoSeek')); }
  });
  on(v, 'timeupdate', () => {
    if (v.readyState < 1 || reopening) return; const c = v.currentTime;
    if (seekingTo >= 0 || (c >= prevT && c - prevT < 2.5)) { lastGood = c; if (!v.seeking) want = c; }
    seekingTo = -1; prevT = c;
    if (c > settledAt) { settledAt = Infinity; tries = 0; renewTries = 0; }
  });
  on(window, 'offline', () => { offline = true; o.notice(t('streamOffline')); });
  on(window, 'online', () => { offline = false; quietSince = Date.now(); if (v.error || o.busy()) void reopen(o.url(), 'asking'); });

  // The watchdog: once a second, has anything moved?
  const timer = window.setInterval(() => {
    if (gone || reopening) return;
    const s = sig(); if (s !== lastSig) { lastSig = s; quietSince = Date.now(); if (say === 'asking' && v.readyState >= 3) say = null; return; }
    const waiting = o.busy() || (!started && !viewerPaused);
    if (!waiting || document.hidden || offline || (viewerPaused && started) || v.error) { quietSince = Date.now(); return; }
    const live = started && !isFinite(v.duration);
    if (Date.now() - quietSince < (live ? QUIET_LIVE_MS : QUIET_MS)) return;
    quietSince = Date.now();
    if (live) { if (!o.torrent) giveUp(); return; }
    if (tries < TRIES) { tries++; void reopen(o.url(), 'asking'); return; }
    if (!o.torrent) giveUp(); else void reopen(o.url(), 'asking');
  }, 1000);

  /** The same place asked again (a new request), from `url`. */
  async function reopen(url: string, why: 'asking' | 'renewing') {
    if (gone) return; say = why; o.setBusy(true); reopening = true;
    const at = started ? Math.max(want, 0) : v.currentTime; const wasPaused = viewerPaused && started; settledAt = at + 5; const t0 = Date.now(); let heard = false;
    try {
      if (url !== o.url()) o.setUrl(url);
      v.src = url; v.load();
      // (Its head, its error, or nothing for as long as the watchdog waits: the watchdog then takes it from there.)
      await new Promise<void>((res) => { let tm = 0; const done = (e?: Event) => { heard = !!e; window.clearTimeout(tm); v.removeEventListener('loadedmetadata', done); v.removeEventListener('error', done); res(); }; tm = window.setTimeout(() => done(), QUIET_MS); v.addEventListener('loadedmetadata', done); v.addEventListener('error', done); });
      if (gone) return;
      if (!v.error) { if (at > 0.5) v.currentTime = at; if (!wasPaused) void v.play().catch(() => undefined); }
    // (Nothing heard while it waited: that wait counts as quiet time, so the next step comes at once.)
    } finally { reopening = false; quietSince = heard ? Date.now() : t0; lastSig = sig(); }
  }
  /** What the address answers now: its status, or 0 when nothing answers. */
  async function status(): Promise<number> {
    try { const r = await fetch(o.url(), { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: AbortSignal.timeout(8000) }); void r.body?.cancel().catch(() => undefined); return r.status; } catch { return 0; }
  }
  function giveUp(detail?: string, ended?: number) {
    if (gone || sheetClose) return; o.setBusy(false); say = null;
    const sh = openSheet(t('streamDeadTitle'), t('close'), { stack: true, onClose: () => { sheetClose = null; } }); sheetClose = sh.close;
    sh.body.classList.add('kt-problem');
    sh.body.append(h('p', { class: 'kt-problem-msg' }, ended !== undefined ? t('streamEndedEarly', { t: o.fmt(ended) }) : t('streamDead')), detail ? h('p', { class: 'hint', dir: 'ltr' }, detail) : '',
      h('div', { class: 'ext-error-actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); tries = 0; renewTries = 0; void (o.renew && detail && /\b(401|403|404|410)\b/.test(detail) ? o.renew().then((u) => reopen(u, 'renewing'), () => reopen(o.url(), 'asking')) : reopen(o.url(), 'asking')); } }, icon('refresh'), t('streamRetry')),
        h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); o.back(); } }, icon('back'), t('streamBack')),
        ...(o.another ? [h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); o.another!(); } }, icon('list'), t('streamAnother'))] : [])));
  }

  return {
    started: () => started,
    played: () => lastGood,
    line() {
      if (offline) return t('streamOffline');
      if (say === 'renewing') return t('streamRenewing');
      if (say === 'asking') return t('streamAsking');
      if (o.torrent) return null;
      const a = Math.floor(ahead());
      return !started && a < 1 ? t('streamStarting') : t('streamReady', { n: a });
    },
    /** A media error: handled here (true) when it is the network's or the address's, not the file's. */
    onError() {
      if (gone) return false; const code = v.error?.code ?? 0;
      if (code === 1) return true;
      if (code !== 2 && code !== 4) return false;
      void (async () => {
        if (offline || !navigator.onLine) { offline = true; o.setBusy(true); return; }
        const st = await status(); if (gone) return;
        if ([401, 403, 404, 410].includes(st)) {
          if (o.renew && renewTries < TRIES) { renewTries++; say = 'renewing'; o.setBusy(true); await new Promise((r) => setTimeout(r, renewTries === 1 ? 1200 : 3500)); if (gone) return; try { await reopen(await o.renew(), 'renewing'); } catch { giveUp(`HTTP ${st}`); } return; }
          giveUp(`HTTP ${st}`); return;
        }
        if (st >= 200 && st < 300 && code !== 2) { o.setBusy(false); o.fileError(); return; }
        if (tries < TRIES) { tries++; await new Promise((r) => setTimeout(r, 800 * tries)); if (!gone) await reopen(o.url(), 'asking'); return; }
        giveUp(st ? `HTTP ${st}` : undefined);
      })();
      return true;
    },
    /** `ended` with the time jumped to the end: asked again once, then said; true when it was such an end. */
    earlyEnd() {
      const d = v.duration; if (gone || !isFinite(d) || d <= 0 || lastGood >= d - 8) return false;
      if (endTries < 1) { endTries++; void reopen(o.url(), 'asking'); return true; }
      giveUp(undefined, lastGood); return true;
    },
    stop() { gone = true; window.clearInterval(timer); for (const f of offs.splice(0)) f(); sheetClose?.(); sheetClose = null; },
  };
}
