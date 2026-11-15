// Settings → Advanced (the Rust port, docs/RUST-PORT.md §5), phones only — never on a computer (its downloads are
// aria2's, its torrents its own) — and only when the app carries a Rust library. One row per engine, each the same:
// a name, a one-line hint, the choice, and «in use · handed back» under it; in this order, each shown only when the
// library it needs is here:
//  - Download engine (M2): Classic (Java) / Rust — the core (libkt_android);
//  - Torrent engine (M3): Classic always, Director with the core, Rust with the torrent library (libkt_torrent);
//  - Screen translator engine (M4): Classic / Rust — the core;
//  - File jobs engine (M5): Classic / Rust — the core;
// then the «Rust core status» block (views/rustStatus.ts). Every default is Classic. Each choice goes to the engine
// (configure({ dlEngine | torEngine | screenEngine | fileEngine })), which keeps it in its own preferences.
import { h, pickButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getSettings, updateSettings, type Settings } from '../settings';
import { nativePlatform, ktPlugin } from '../native';
import { rustStatusCard, type CoreInfo } from './rustStatus';
import { S, type Api } from './engineInfo';

// (What deviceInfo said is kept in engineInfo.ts, shared with the torrent rows' badge, which the start of the app loads —
// so this file and the status card stay in the settings' own chunk.)
export { resetEngineInfo } from './engineInfo';

/** The «Advanced» card, or null (a computer, the web, a build without the core, or deviceInfo not answered yet — then
 *  asked, and `rerender` called once it has answered). */
export function advancedCard(rerender: () => void): HTMLElement | null {
  if (nativePlatform() !== 'android') return null;
  const api = ktPlugin() as unknown as Api | null;
  if (!api?.deviceInfo) return null;
  if (S.info === undefined) {
    if (!S.asking) { S.asking = true; void api.deviceInfo().then((r) => { S.info = r ?? null; }, () => { S.info = null; }).finally(() => { S.asking = false; if (S.info?.rustCore || S.info?.rustTorrent) rerender(); }); }   // (M3: either library)
    return null;
  }
  if (!S.info?.rustCore && !S.info?.rustTorrent) return null;
  const core = !!S.info.rustCore;
  const rows: HTMLElement[] = [];
  if (core) rows.push(engineRow(api, rerender, 'dl', 'dlEngine', [['java', t('dlEngineJava')], ['rust', t('dlEngineRust')]], getSettings().dlEngine === 'rust' ? 'rust' : 'java', S.info.dlEngine, S.info.dlEngineFallbacks));
  rows.push(torEngineRow(api, rerender));
  if (core) rows.push(engineRow(api, rerender, 'screen', 'screenEngine', [['classic', t('screenEngineClassic')], ['rust', t('screenEngineRust')]], getSettings().screenEngine === 'rust' ? 'rust' : 'classic', S.info.screenEngine, S.info.screenEngineFallbacks));
  if (core) rows.push(engineRow(api, rerender, 'file', 'fileEngine', [['classic', t('fileEngineClassic')], ['rust', t('fileEngineRust')]], getSettings().fileEngine === 'rust' ? 'rust' : 'classic', S.info.fileEngine, S.info.fileEngineFallbacks));
  return h('section', { class: 'card', id: 'advanced' }, h('h3', null, t('advancedSection')),
    h('p', { class: 'hint' }, t('advancedHint')),
    ...rows, rustStatusCard(S.info as CoreInfo, api as never));
}

type Key = 'dlEngine' | 'torEngine' | 'screenEngine' | 'fileEngine';
/** One engine row, the same for every engine: `<area>-engine` holding the row (name, hint, choice) and its status line. */
function engineRow<V extends string>(api: Api, rerender: () => void, area: string, key: Key, opts: [V, string][], cur: V, inUse: string | undefined, fallbacks: number | undefined): HTMLElement {
  const pick = pickButton(t(key), opts, cur, (v) => {
    updateSettings({ [key]: v } as Partial<Settings>);
    void api.configure({ [key]: v }).catch(() => undefined).then(() => api.deviceInfo?.()).then((r) => { if (r) { S.info = r as typeof S.info; rerender(); } }).catch(() => undefined);
  }, t('close'));
  const used = opts.find((o) => o[0] === inUse)?.[1] ?? opts[0][1];
  return h('div', { class: `engine ${area}-engine` },
    h('div', { class: `row ${area}-engine-row` }, h('span', null, t(key), h('small', { class: 'src' }, t(`${key}Hint` as never))), pick),
    h('small', { class: `src ${area}-engine-status` }, t('engineStatus', { engine: used, n: localDigits(fallbacks ?? 0) })));
}

/* ---------- stage M3: the torrent engine (Classic / Director / Rust), chosen per torrent when it is added ---------- */

type TorEngine = 'classic' | 'director' | 'rust';
/** The «Torrent engine» row: Classic always; Director when the core is here (libkt_android); Rust when the torrent
 *  library is (libkt_torrent). Default Classic. The choice goes to the engine (configure({ torEngine })), which reads it
 *  when a torrent is added — a torrent keeps the engine it was added with. */
function torEngineRow(api: Api, rerender: () => void): HTMLElement {
  const opts: [TorEngine, string][] = [['classic', t('torEngineClassic')]];
  if (S.info?.rustCore) opts.push(['director', t('torEngineDirector')]);
  if (S.info?.rustTorrent) opts.push(['rust', t('torEngineRust')]);
  const want = getSettings().torEngine ?? 'classic';
  const cur: TorEngine = opts.some((o) => o[0] === want) ? want : 'classic';
  return engineRow(api, rerender, 'tor', 'torEngine', opts, cur, S.info?.torEngine, S.info?.torEngineFallbacks);
}
