// Settings → Advanced (stage M2 of the Rust port, docs/RUST-PORT.md §5): the phone's file-download engine, Java's or
// the Rust core's. Phones only — a computer's downloads are aria2's, so the card never shows there — and only when the
// app carries the core (deviceInfo().rustCore; absent → no card, the Java engine as always). The default is Java until
// the owner has tried the Rust one on a phone. The choice goes to the engine (configure({ dlEngine })), which keeps it
// in its own preferences and reads it when a download starts.
import { h, pickButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { nativePlatform, ktPlugin } from '../native';

type Info = { rustCore?: string | null; dlEngine?: string; dlEngineChoice?: string; dlEngineFallbacks?: number;
  /* (stage M4) */ screenEngine?: string; screenEngineChoice?: string; screenEngineFallbacks?: number };
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
    if (!asking) { asking = true; void api.deviceInfo().then((r) => { info = r ?? null; }, () => { info = null; }).finally(() => { asking = false; if (info?.rustCore) rerender(); }); }
    return null;
  }
  if (!info?.rustCore) return null;
  const cur = getSettings().dlEngine === 'rust' ? 'rust' : 'java';
  const status = h('small', { class: 'src dl-engine-status' }, t('dlEngineStatus', { version: info.rustCore, engine: info.dlEngine === 'rust' ? t('dlEngineRust') : t('dlEngineJava'), n: localDigits(info.dlEngineFallbacks ?? 0) }));
  const pick = pickButton(t('dlEngine'), [['java', t('dlEngineJava')], ['rust', t('dlEngineRust')]], cur, (v) => {
    updateSettings({ dlEngine: v });
    void api.configure({ dlEngine: v }).catch(() => undefined).then(() => api.deviceInfo?.()).then((r) => { if (r) { info = r; rerender(); } }).catch(() => undefined);
  }, t('close'));
  // (Stage M4: the screen translator's engine — Classic (Java) or Rust; the jobs Rust takes and its fallbacks are the
  // engine's (KtScreenRs). The same card, the same conditions: a phone carrying the core.)
  const scur = getSettings().screenEngine === 'rust' ? 'rust' : 'classic';
  const sstatus = h('small', { class: 'src screen-engine-status' }, t('screenEngineStatus', { engine: info.screenEngine === 'rust' ? t('screenEngineRust') : t('screenEngineClassic'), n: localDigits(info.screenEngineFallbacks ?? 0) }));
  const spick = pickButton(t('screenEngine'), [['classic', t('screenEngineClassic')], ['rust', t('screenEngineRust')]], scur, (v) => {
    updateSettings({ screenEngine: v });
    void api.configure({ screenEngine: v }).catch(() => undefined).then(() => api.deviceInfo?.()).then((r) => { if (r) { info = r; rerender(); } }).catch(() => undefined);
  }, t('close'));
  return h('section', { class: 'card', id: 'advanced' }, h('h3', null, t('advancedSection')),
    h('p', { class: 'hint' }, t('advancedHint')),
    h('div', { class: 'row dl-engine-row' }, h('span', null, t('dlEngine'), h('small', { class: 'src' }, t('dlEngineHint'))), pick),
    status,
    h('div', { class: 'row screen-engine-row' }, h('span', null, t('screenEngine'), h('small', { class: 'src' }, t('screenEngineHint'))), spick),
    sstatus);
}
