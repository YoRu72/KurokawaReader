// DNS over HTTPS on the phone as the reader sees it: a card that says what the resolver is doing — off, ready,
// asking, answering (from which address, in how long), failed — with the counters and the last events, live as they
// come from the phone's resolver (the «doh» event). (0.21 P9: the resolvers' health and «Check now» moved to
// ui/dohSettings.ts, the same on every shell; a computer has no live feed, so no card.)
import { h, icon } from './dom';
import { t, localDigits, formatBytes } from '../i18n';
import { ktPlugin, listen, nativePlatform } from '../native';
import { getSettings } from '../settings';

export type DohEvent = { at: number; kind: string; host?: string; ip?: string; ms?: number; msg?: string; state?: string };
export type DohResolver = { id: string; url: string; ok: boolean; ms: number; shape: string; error: string };
export type DohStatus = { ways?: { host: string; way: string; failures: number }[]; proxy?: { running: boolean; port: number; tunnels: number; open: number; up: number; down: number }; split?: string; lastShape?: string; forced?: number; resolvers?: DohResolver[]; provider: string; state: 'off' | 'idle' | 'resolving' | 'ok' | 'failed'; queries: number; hits: number; fails: number; unblocked: number; lastResolver: string; lastMs: number; lastAt: number; lastError: string; cached: number; log: DohEvent[]; probe?: { ok: boolean; resolver?: string; ms?: number; why?: string; tries?: { resolver: string; ok: boolean; ms?: number; error?: string; shape?: string; from?: string }[]; shape?: string } };
type Plug = { dohStatus(o: { probe?: boolean }): Promise<DohStatus>; addListener(ev: 'doh', fn: (e: DohEvent) => void): Promise<{ remove(): void }> };

const plug = (): Plug | null => { const p = ktPlugin() as unknown as Partial<Plug> | null; return p?.dohStatus ? (p as Plug) : null; };
export const canShowDoh = (): boolean => !!plug();

const ago = (at: number): string => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? t('secondsAgo', { n: localDigits(s) }) : s < 3600 ? t('minutesAgo', { n: localDigits(Math.floor(s / 60)) }) : t('hoursAgo', { n: localDigits(Math.floor(s / 3600)) }); };
const kindLabel = (k: string): string => ({ resolve: t('dohEvResolve'), hit: t('dohEvHit'), retry: t('dohEvRetry'), fail: t('dohEvFail'), unblock: t('dohEvUnblock'), direct: t('dohEvDirect'), probe: t('dohEvProbe'), way: t('dohEvWay'), stale: t('dohEvStale'), none: t('dohEvNone'), force: t('dohEvForce'), system: t('dohEvSystem'), nosystem: t('dohEvNoSystem') } as Record<string, string>)[k] ?? k;

/** The card; it keeps itself fresh while it is on the page. */
export function dohStatusCard(): HTMLElement {
  const light = h('span', { class: 'doh-light' }); const title = h('b', null, '…'); const line = h('small', { class: 'src' }); const counts = h('div', { class: 'doh-counts' }); const feed = h('div', { class: 'doh-feed' });
  const table = h('div', { class: 'doh-resolvers' });
  const el = h('div', { class: 'doh-card' }, h('div', { class: 'doh-head' }, light, h('div', { class: 'grow' }, title, h('br'), line)), counts, table, feed);
  let last: DohStatus | null = null; let sub: { remove(): void } | null = null;
  const paint = (st: DohStatus) => {
    last = st; const prov = getSettings().doh; const name = prov === 'off' ? t('dohOff') : /^https:/.test(prov) ? t('dohCustom') : prov[0].toUpperCase() + prov.slice(1);
    const state = prov === 'off' ? 'off' : st.state; el.dataset.state = state;
    title.textContent = `${t('dohTitle')} — ${name}`;
    line.textContent = state === 'off' ? t('dohStateOff') : state === 'resolving' ? t('dohStateResolving') : state === 'ok' ? t('dohStateOk', { resolver: st.lastResolver || name, ms: localDigits(Math.max(0, st.lastMs)) }) : state === 'failed' ? t('dohStateFailed', { error: st.lastError || '' }) : t('dohStateIdle');
    counts.replaceChildren(...(state === 'off' ? [] : [[t('dohQueries'), st.queries], [t('dohCached'), st.hits], [t('dohFailed'), st.fails], [t('dohUnblocked'), st.unblocked], ...(st.forced ? [[t('dohForced'), st.forced]] : [])].map(([k, v]) => h('span', { class: 'chip small' }, `${k}: ${localDigits(Number(v))}`))));
    // (Each resolver and how it last fared: answered (by which shape, in how long), failed (why), or not asked yet.)
    // (The app's own proxy, which every page's connection goes through while the resolver is on.)
    const px = st.proxy; const proxyLine = state === 'off' || !px ? null : h('div', { class: `doh-ev ${px.running ? 'k-resolve' : 'k-fail'}` }, h('span', { class: 'doh-kind' }, px.running ? '✓' : '✕'), h('span', { class: 'grow', dir: 'auto' }, px.running ? t('dohProxyOn', { port: String(px.port), n: localDigits(px.tunnels), up: formatBytes(px.up), down: formatBytes(px.down) }) : t('dohProxyOff')));
    const rs = state === 'off' ? [] : (st.resolvers ?? []).filter((r) => r.ms >= 0 || r.ok);
    table.replaceChildren(...(proxyLine ? [proxyLine] : []), ...(rs.length ? [h('small', { class: 'src' }, t('dohResolvers')), ...rs.map((r) => h('div', { class: `doh-ev ${r.ok ? 'k-resolve' : 'k-fail'}` }, h('span', { class: 'doh-kind' }, r.ok ? '✓' : '✕'), h('span', { dir: 'ltr', class: 'grow' }, `${r.id}${r.ok ? ` · ${r.shape} · ${localDigits(r.ms)} ms` : r.error ? ` · ${r.error}` : ''}`)))] : []));
    // (Sites whose hello had to go out another way — the ladder's memory.)
    const ways = state === 'off' ? [] : (st.ways ?? []).filter((w) => w.way !== 'plain' || w.failures > 0);
    if (ways.length) table.append(h('small', { class: 'src' }, t('dohWays')), ...ways.slice(0, 12).map((w) => h('div', { class: 'doh-ev k-way' }, h('span', { class: 'doh-kind' }, '⇄'), h('span', { dir: 'ltr', class: 'grow' }, `${w.host} · ${t(('dohWay_' + w.way) as 'dohWay_split')}${w.failures ? ` · ${t('dohWayFailures', { n: localDigits(w.failures) })}` : ''}`))));
    const log = (st.log ?? []).slice(-10).reverse();
    feed.replaceChildren(...log.map((e) => h('div', { class: `doh-ev k-${e.kind}` }, h('small', { class: 'src' }, ago(e.at)), h('span', { class: 'doh-kind' }, kindLabel(e.kind)), h('span', { dir: 'ltr', class: 'grow' }, [e.host, e.ip ? `→ ${e.ip}` : '', e.ms !== undefined && e.ms >= 0 ? `${localDigits(e.ms)} ms` : '', e.msg && e.msg !== 'ok' && e.msg !== 'start' ? e.msg : ''].filter(Boolean).join(' ')))));
    if (!log.length && state !== 'off') feed.replaceChildren(h('p', { class: 'hint' }, t('dohNoEvents')));
  };
  const refresh = async () => { const p = plug(); if (p) { try { paint(await p.dohStatus({})); } catch { /* left */ } } else paint({ provider: getSettings().doh, state: getSettings().doh === 'off' ? 'off' : 'idle', queries: 0, hits: 0, fails: 0, unblocked: 0, lastResolver: '', lastMs: -1, lastAt: 0, lastError: '', cached: 0, log: [] }); };
  void refresh();
  const p = plug(); if (p) void listen<DohEvent>(p as never, 'doh', () => { void refresh(); }).then((s) => { sub = s as { remove(): void }; });
  // (The phone's status read every 15 s while the card is on screen and the app in front — no timer otherwise.)
  let timer = 0;
  const arm = () => { const want = el.isConnected && nativePlatform() === 'android' && document.visibilityState === 'visible'; if (want && !timer) timer = window.setInterval(() => { if (!el.isConnected) { stop(); return; } void refresh(); }, 15000); else if (!want && timer) { window.clearInterval(timer); timer = 0; } };
  const stop = () => { window.clearInterval(timer); timer = 0; sub?.remove(); document.removeEventListener('visibilitychange', onVis); };
  const onVis = () => { if (!el.isConnected) { stop(); return; } arm(); if (document.visibilityState === 'visible' && nativePlatform() === 'android') void refresh(); };
  document.addEventListener('visibilitychange', onVis); setTimeout(arm, 0);
  return el;
}
