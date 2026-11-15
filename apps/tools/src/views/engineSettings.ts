// Settings → Advanced (stage M2 of the Rust port, docs/RUST-PORT.md §5): the phone's file-download engine, Java's or
// the Rust core's. Phones only — a computer's downloads are aria2's, so the card never shows there — and only when the
// app carries the core (deviceInfo().rustCore; absent → no card, the Java engine as always). The default is Java until
// the owner has tried the Rust one on a phone. The choice goes to the engine (configure({ dlEngine })), which keeps it
// in its own preferences and reads it when a download starts.
// Stage M3: «Torrent engine» (Classic / Director / Rust) on the same card — shown when either Rust library is here.
import { h, pickButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { nativePlatform, ktPlugin } from '../native';

type Info = { rustCore?: string | null; dlEngine?: string; dlEngineChoice?: string; dlEngineFallbacks?: number;
  /* (stage M3) */ rustTorrent?: string | null; torEngine?: string; torEngineChoice?: string; torEngineFallbacks?: number; torDirectorPlans?: number; debuggable?: boolean };
type Api = { deviceInfo?(): Promise<Info>; configure(o: Record<string, unknown>): Promise<void> };

let info: Info | null | undefined;   // undefined: not asked yet; null: asked, nothing came
let asking = false;

/** (Tests: forget what deviceInfo said.) */
export function resetEngineInfo(): void { info = undefined; asking = false; }

/** The «Advanced» card, or null (a computer, the web, a build without the core, or deviceInfo not answered yet — then
 *  asked, and `rerender` called once it has answered). */
export function advancedCard(rerender: () => void): HTMLElement | null {
  if (nativePlatform() !== 'android') return null;
  const api = ktPlugin() as unknown as Api | null;
  if (!api?.deviceInfo) return null;
  if (info === undefined) {
    if (!asking) { asking = true; void api.deviceInfo().then((r) => { info = r ?? null; }, () => { info = null; }).finally(() => { asking = false; if (info?.rustCore || info?.rustTorrent) rerender(); }); }   // (M3: either library)
    return null;
  }
  if (!info?.rustCore && !info?.rustTorrent) return null;
  const tor = torEngineRow(api, rerender);
  if (!info?.rustCore) return h('section', { class: 'card', id: 'advanced' }, h('h3', null, t('advancedSection')), h('p', { class: 'hint' }, t('advancedHint')), tor);
  const cur = getSettings().dlEngine === 'rust' ? 'rust' : 'java';
  const status = h('small', { class: 'src dl-engine-status' }, t('dlEngineStatus', { version: info.rustCore, engine: info.dlEngine === 'rust' ? t('dlEngineRust') : t('dlEngineJava'), n: localDigits(info.dlEngineFallbacks ?? 0) }));
  const pick = pickButton(t('dlEngine'), [['java', t('dlEngineJava')], ['rust', t('dlEngineRust')]], cur, (v) => {
    updateSettings({ dlEngine: v });
    void api.configure({ dlEngine: v }).catch(() => undefined).then(() => api.deviceInfo?.()).then((r) => { if (r) { info = r; rerender(); } }).catch(() => undefined);
  }, t('close'));
  return h('section', { class: 'card', id: 'advanced' }, h('h3', null, t('advancedSection')),
    h('p', { class: 'hint' }, t('advancedHint')),
    h('div', { class: 'row dl-engine-row' }, h('span', null, t('dlEngine'), h('small', { class: 'src' }, t('dlEngineHint'))), pick),
    status, tor);
}

/* ---------- stage M3: the torrent engine (Classic / Director / Rust), chosen per torrent when it is added ---------- */

type TorEngine = 'classic' | 'director' | 'rust';
/** The «Torrent engine» row: Classic always; Director when the core is here (libkt_android); Rust when the torrent
 *  library is (libkt_torrent). Default Classic. The choice goes to the engine (configure({ torEngine })), which reads it
 *  when a torrent is added — a torrent keeps the engine it was added with. */
function torEngineRow(api: Api, rerender: () => void): HTMLElement {
  const opts: [TorEngine, string][] = [['classic', t('torEngineClassic')]];
  if (info?.rustCore) opts.push(['director', t('torEngineDirector')]);
  if (info?.rustTorrent) opts.push(['rust', t('torEngineRust')]);
  const want = getSettings().torEngine ?? 'classic';
  const cur: TorEngine = opts.some((o) => o[0] === want) ? want : 'classic';
  const name = (e?: string) => (e === 'rust' ? t('torEngineRust') : e === 'director' ? t('torEngineDirector') : t('torEngineClassic'));
  const pick = pickButton(t('torEngine'), opts, cur, (v) => {
    updateSettings({ torEngine: v });
    void api.configure({ torEngine: v }).catch(() => undefined).then(() => api.deviceInfo?.()).then((r) => { if (r) { info = r; rerender(); } }).catch(() => undefined);
  }, t('close'));
  const line = t('torEngineStatus', { engine: name(info?.torEngine), version: info?.rustTorrent ?? '—', n: localDigits(info?.torEngineFallbacks ?? 0) });
  return h('div', { class: 'tor-engine' }, h('div', { class: 'row tor-engine-row' }, h('span', null, t('torEngine'), h('small', { class: 'src' }, t('torEngineHint'))), pick),
    h('small', { class: 'src tor-engine-status' }, line));
}

/** A torrent row's engine, for debuggable builds only (deviceInfo().debuggable): «Rust» / «Director», or null (Classic,
 *  a released build, a computer, or deviceInfo not asked yet — asked here once, in the background). */
export function torEngineBadge(x: { kind?: string; meta?: unknown }): string | null {
  if (x.kind !== 'torrent' || nativePlatform() !== 'android') return null;
  const api = ktPlugin() as unknown as Api | null;
  if (info === undefined && !asking && api?.deviceInfo) { asking = true; void api.deviceInfo().then((r) => { info = r ?? null; }, () => { info = null; }).finally(() => { asking = false; }); }
  if (!info?.debuggable) return null;
  const e = (x.meta as { torEngine?: string } | undefined)?.torEngine;
  return e === 'rust' ? t('torEngineBadge', { e: t('torEngineRust') }) : e === 'director' ? t('torEngineBadge', { e: t('torEngineDirector') }) : null;
}
