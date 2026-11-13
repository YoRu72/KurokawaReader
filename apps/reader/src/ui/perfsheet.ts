// The Performance page (Settings → About): what the app's own recorder (src/diag.ts) saw on this device, in plain
// words — the start-up, the last book opened, the slow moments, how the last sessions ended, why the reader was left —
// and the whole of it as a short report in English, for the developer: copied, saved as a file, or cleared. Nothing
// is sent anywhere; the report holds times, counts and kinds only.
import { h, icon, openSheet, toast } from './dom';
import { t, localDigits, dateLocale } from '../i18n';
import { diagData, diagClear, diagFlush, type DiagSession, type DiagEvent } from '../diag';
import { copyText, shareFile } from './share';
import type { Strings } from '../i18n/en';

type Data = ReturnType<typeof diagData>;

/* ---------- the report (English, for the developer) ---------- */
const ms = (n?: number) => (n === undefined ? '-' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const dur = (n: number) => (n < 60000 ? `${Math.round(n / 1000)} s` : n < 3600000 ? `${Math.round(n / 60000)} min` : `${(n / 3600000).toFixed(1)} h`);
const stamp = (at: number) => { const d = new Date(at); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const END_EN: Record<string, string> = { left: 'closed normally', bg: 'ended in the background, not seen again', unexpected: 'ENDED UNEXPECTEDLY' };
/** How an unexpected end is told apart (src/diag.ts `why`). */
const WHY_EN: Record<string, string> = { 'renderer-crash': 'renderer crashed', 'renderer-killed': 'renderer killed by the system (memory)', 'app-memory': 'app process killed for memory', 'app-crash': 'app process crashed', anr: 'app not responding (ANR)', 'anr?': 'ANR suspected', 'app-killed': 'app process ended by the system', unknown: 'cause unknown' };
const fields = (e: DiagEvent) => Object.entries(e).filter(([k]) => k !== 't' && k !== 'k').map(([k, v]) => `${k}=${v}`).join(' ');

export function diagReport(d: Data = diagData()): string {
  const now = d.sessions[d.sessions.length - 1];
  const L: string[] = [];
  L.push('KurokawaReader performance report', `Made ${stamp(Date.now())}. Times, counts and kinds only: no titles, file names, text or addresses.`);
  if (now) {
    const e = now.env;
    L.push(`App ${e.v} · ${e.plat} · ${e.wv} · screen ${e.scr} · lang ${e.lang} · reader mode ${e.mode} · reduced motion ${e.rm ? 'on' : 'off'}${e.dm ? ` · device memory ${e.dm} GB` : ''}${e.sto ? ` · storage ${e.sto}` : ''}${now.mem ? ` · JS heap peak ${now.mem} MB` : ''}`);
    L.push(`Recorder's own time: ${d.overhead.toFixed(1)} ms over ${dur(now.ran)} (${now.ran ? ((d.overhead / now.ran) * 100).toFixed(3) : '0'} %)`);
  }
  L.push('', 'Sessions (newest first):');
  for (const s of d.sessions.slice().reverse()) L.push('  ' + sessionLine(s, s === now));
  const opens = d.events.filter((e) => e.k === 'open').slice(-10).reverse();
  L.push('', `Book opens (last ${opens.length}):`);
  for (const e of opens) L.push(`  ${stamp(e.t)} ${e.kind}${e.books ? ` x${e.books}` : ''} [${e.mode}] ${[e.pages && `${e.pages} pages`, e.paras && `${e.paras} paragraphs`, e.bytes && `${e.bytes} bytes`].filter(Boolean).join(', ')}: first content ${ms(e.first as number)}, place ${ms(e.placed as number)}${e.failed ? `, failed: ${e.failed}` : ''}${e.left ? `, left ${e.left}` : ''}`);
  const leaves = d.events.filter((e) => e.k === 'leave').slice(-15).reverse();
  L.push('', `Reader left (last ${leaves.length}):`);
  for (const e of leaves) L.push(`  ${stamp(e.t)} ${e.why} -> ${e.to}${e.inBook !== undefined ? ` after ${e.inBook} s` : ''}${e.edge && e.edge !== 'none' ? ` · touch at ${e.edge} edge ${e.edgeAgo} ms before` : e.edge ? ' · no edge touch' : ''}${e.touching ? ' · finger down' : ''}`);
  const held = d.events.filter((e) => e.k === 'backheld').slice(-15).reverse();
  if (held.length) {
    L.push('', `Back held, book kept (last ${held.length}):`);
    for (const e of held) L.push(`  ${stamp(e.t)} ${heldWhy(e)}${e.edge && e.edge !== 'none' ? ` · touch at ${e.edge} edge ${e.edgeAgo} ms before` : e.edge ? ' · no edge touch' : ''}${e.touching ? ' · finger down' : ''}`);
  }
  // (Whether the edges were kept from Back in the books opened: the setting as each opened.)
  const guards = d.events.filter((e) => e.k === 'edgeguard');
  const g = guards[guards.length - 1];
  L.push('', g ? `Edge guard ("Protect page-turn swipes at the screen edges") at the last book open: ${g.on ? 'ON' : 'off'}${g.on && !g.sideways ? ' (not used: no sideways swipes in that mode)' : ''}; on at ${guards.filter((e) => e.on).length} of the last ${guards.length} opens.` : 'Edge guard: no book opened on Android since the record began.');
  const rest = d.events.filter((e) => e.k !== 'open' && e.k !== 'leave' && e.k !== 'backheld' && e.k !== 'edgeguard').slice(-25).reverse();
  L.push('', `Other events (last ${rest.length}):`);
  for (const e of rest) L.push(`  ${stamp(e.t)} ${e.k} ${fields(e)}`.trimEnd());
  return L.join('\n') + '\n';
}
/** Why a Back was held, for the report. */
function heldWhy(e: DiagEvent): string {
  if (e.why === 'twice') return 'Back twice to leave: reminder shown, book kept';
  if (e.why === 'selection') return 'Back twice to leave: selection cleared, book kept';
  if (e.why === 'swipe') return `IGNORED AS PART OF A PAGE-TURN SWIPE (${e.how === 'after-turn' ? `${e.ms} ms after the chapter turned` : e.how === 'down' ? 'came with the finger down; that touch then turned the chapter' : e.how}; the touch began ${e.edge0 && e.edge0 !== 'none' ? `at the ${e.edge0} edge` : 'away from the edges'})`;
  return String(e.why);
}
function sessionLine(s: DiagSession, running: boolean): string {
  const st = s.st; const how = (running ? 'running' : END_EN[s.end ?? ''] ?? '?') + (!running && s.why ? `: ${WHY_EN[s.why] ?? s.why}${s.det ? ` (${s.det})` : ''}` : '');
  const parts = [`${stamp(s.at)} ${how} after ${dur(s.ran)} on ${s.scr}${s.hid && s.end !== 'left' ? ' (in background)' : ''}${s.book && !running ? ' (book open)' : ''}`, `app ${s.env.v} ${s.env.plat}`];
  if (st.js !== undefined) parts.push(`start: script ${ms(st.js)}, library shown ${ms(st.shown)}, usable ${ms(st.usable)}`);
  if (s.opens || s.leaves) parts.push(`opens ${s.opens}, reader left ${s.leaves}`);
  if (s.lt.some(Boolean)) parts.push(`long tasks >50/100/250/1000ms ${s.lt.join('/')} (while reading ${s.ltRead})`);
  if (s.laf.some(Boolean)) parts.push(`slow frames ${s.laf.join('/')}`);
  if (s.worst.length) parts.push(`worst ${s.worst.map(([m, scr, k]) => `${m}ms ${k}@${scr}`).join(', ')}`);
  if (s.ev.slow || s.ev.maxDelay > 50) parts.push(`slow taps ${s.ev.slow}, max input delay ${s.ev.maxDelay} ms, max to paint ${s.ev.maxDur} ms`);
  if (s.mem) parts.push(`heap ${s.mem} MB`);
  if (s.ms?.length) parts.push(`memory while reading [s: heap MB/elements k/chapters made/pictures] ${s.ms.map(([at, hp, el, ch, pic]) => `${at}: ${hp < 0 ? '-' : hp}/${el}/${ch}/${pic}`).join(', ')}`);
  if (s.rlt?.length) parts.push(`last long tasks ${s.rlt.map(([m, at]) => `${ms(m)} at ${at} s`).join(', ')}`);
  if (s.errs && Object.keys(s.errs).length) parts.push(`uncaught ${Object.entries(s.errs).map(([k, n]) => `${k} x${n}`).join(', ')}`);
  return parts.join(' · ');
}

/* ---------- the page (the interface's language) ---------- */
const fmtMs = (n?: number) => (n === undefined ? '—' : n < 1000 ? t('perfMs', { n: Math.round(n) }) : t('perfSec', { n: Math.round(n / 100) / 10 }));
const fmtDur = (n: number) => (n < 60000 ? t('perfSec', { n: Math.round(n / 1000) }) : t('perfMin', { n: Math.round(n / 60000) }));
const when = (at: number) => localDigits(new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)));
const SCREEN: Record<string, keyof Strings> = { library: 'library', read: 'perfScrReader', settings: 'settings' };
const screenName = (s: string) => t(SCREEN[s] ?? 'perfScrOther');
const KIND: Record<string, keyof Strings> = { text: 'perfKindText', 'web novel': 'perfKindNovel', other: 'perfKindOther', shamela: 'perfKindOther' };
const kindName = (k: string) => (KIND[k] ? t(KIND[k]) : k.toUpperCase());
const WHY: Record<string, keyof Strings> = { 'back-button': 'perfWhyBackButton', 'top-back': 'perfWhyTopBack', link: 'perfWhyLink', missing: 'perfWhyMissing', error: 'perfWhyError', code: 'perfWhyCode', history: 'perfWhyHistory', 'next-book': 'perfWhyNextBook', 'to-caller': 'perfWhyToCaller', key: 'perfWhyKey', 'back-pc': 'perfWhyBackPc', series: 'perfWhySeries' };
const END: Record<string, keyof Strings> = { left: 'perfEndLeft', bg: 'perfEndBg', unexpected: 'perfEndUnexpected' };
const CAUSE: Record<string, keyof Strings> = { 'renderer-crash': 'perfCauseRendererCrash', 'renderer-killed': 'perfCauseRendererKilled', 'app-memory': 'perfCauseAppMemory', 'app-crash': 'perfCauseAppCrash', anr: 'perfCauseAnr', 'anr?': 'perfCauseAnrSuspected', 'app-killed': 'perfCauseAppKilled' };

export function perfSheet(): void {
  diagFlush();
  const sh = openSheet(t('perfTitle'), t('close'));
  sh.el.classList.add('perf-sheet');
  const draw = () => {
    const d = diagData(); const now = d.sessions[d.sessions.length - 1];
    const started = [...d.sessions].reverse().find((s) => s.st.usable !== undefined || s.st.shown !== undefined);
    const lastOpen = [...d.events].reverse().find((e) => e.k === 'open');
    const tile = (value: string, label: string) => h('div', { class: 'stats-tile' }, h('b', { dir: 'auto' }, value), h('span', null, label));
    const tiles = h('div', { class: 'stats-grid perf-tiles' },
      tile(started ? fmtMs(started.st.usable ?? started.st.shown) : '—', t('perfStartup')),
      tile(lastOpen ? fmtMs((lastOpen.placed ?? lastOpen.first) as number | undefined) : '—', t('perfLastOpen')),
      tile(localDigits(now ? now.lt[1] + now.laf[1] : 0, 'prose'), t('perfSlow')),
      tile(fmtMs(d.overhead), t('perfOverheadShort')));
    const rows: HTMLElement[] = [];
    const row = (head: string, ...lines: (string | null)[]) => rows.push(h('div', { class: 'perf-row' }, h('h4', null, head), ...lines.filter((x): x is string => !!x).map((x) => h('p', { dir: 'auto' }, x))));
    row(t('perfStartup'), started ? t('perfStartupVal', { shown: fmtMs(started.st.shown), usable: fmtMs(started.st.usable) }) : t('perfNotYet'));
    row(t('perfLastOpen'), lastOpen ? t('perfLastOpenVal', { kind: kindName(String(lastOpen.kind)), first: fmtMs(lastOpen.first as number | undefined), placed: fmtMs(lastOpen.placed as number | undefined) }) : t('perfNoOpen'));
    if (now) row(t('perfSlow'), t('perfSlowVal', { t1: fmtMs(100), a: now.lt[1] + now.laf[1], t2: fmtMs(250), b: now.lt[2] + now.laf[2], t3: fmtMs(1000), c: now.lt[3] + now.laf[3] }), now.ltRead ? t('perfSlowReading', { n: now.ltRead }) : null, now.ev.slow || now.ev.maxDelay ? t('perfSlowTaps', { n: now.ev.slow, ms: fmtMs(now.ev.maxDelay) }) : null);
    row(t('perfSessions'), ...d.sessions.slice(-6).reverse().map((s) => `${when(s.at)} · ${s === now ? t('perfRunning') : t(END[s.end ?? 'unexpected'])}${s !== now && s.why && CAUSE[s.why] ? ` — ${t(CAUSE[s.why])}` : ''}${s.hid && s !== now && s.end !== 'left' ? ` (${t('perfInBg')})` : ''} · ${t('perfSessionVal', { dur: fmtDur(s.ran), screen: screenName(s.scr) })}`));
    const leaves = d.events.filter((e) => e.k === 'leave');
    const by = new Map<string, number>(); for (const e of leaves) by.set(String(e.why), (by.get(String(e.why)) ?? 0) + 1);
    const edged = leaves.filter((e) => e.edge && e.edge !== 'none').length;
    const held = d.events.filter((e) => e.k === 'backheld' && e.why !== 'swipe').length;
    const swiped = d.events.filter((e) => e.k === 'backheld' && e.why === 'swipe').length;
    row(t('perfLeft'), ...(leaves.length ? [...by].sort((a, b) => b[1] - a[1]).map(([w, n]) => t('perfWhyCount', { why: WHY[w] ? t(WHY[w]) : w, n })) : [t('perfLeftNone')]), edged ? t('perfEdgeNote', { n: edged }) : null, held ? t('perfBackHeld', { n: held }) : null, swiped ? t('backSwipeHeldPerf', { n: swiped }) : null);
    row(t('perfOverheadShort'), t('perfOverhead', { ms: fmtMs(d.overhead), dur: fmtDur(now?.ran ?? 0) }));
    sh.body.replaceChildren(h('p', { class: 'hint perf-note' }, t('perfNote')), tiles, ...rows);
  };
  draw();
  sh.actions.append(
    h('button', { type: 'button', class: 'btn tonal small', onclick: () => void copyText(diagReport()) }, icon('copy'), t('perfCopy')),
    h('button', { type: 'button', class: 'btn small', onclick: () => void shareFile(new Blob([diagReport()], { type: 'text/plain' }), `kurokawa-performance-${new Date().toISOString().slice(0, 10)}.txt`, t('perfTitle')).catch((e) => toast(String((e as Error)?.message ?? e), 'error')) }, icon('download'), t('perfSave')),
    h('button', { type: 'button', class: 'btn small danger', onclick: () => { diagClear(); draw(); toast(t('perfCleared')); } }, icon('trash'), t('perfClear')));
}
