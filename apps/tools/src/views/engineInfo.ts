// What the phone's engine said of its Rust libraries (deviceInfo), kept once for Settings → Advanced (engineSettings.ts,
// in the settings' chunk) and for the torrent rows' engine badge (the downloads list, loaded at the start) — so the
// start of the app carries this small file and not the Advanced card or the «Rust core status» block.
import { t } from '../i18n';
import { nativePlatform, ktPlugin } from '../native';

export type Info = { rustCore?: string | null; dlEngine?: string; dlEngineChoice?: string; dlEngineFallbacks?: number;
  /* (stage M3) */ rustTorrent?: string | null; torEngine?: string; torEngineChoice?: string; torEngineFallbacks?: number; torDirectorPlans?: number; debuggable?: boolean;
  /* (stage M4) */ screenEngine?: string; screenEngineChoice?: string; screenEngineFallbacks?: number;
  /* (stage M5) */ fileEngine?: string; fileEngineChoice?: string; fileEngineFallbacks?: number };
export type Api = { deviceInfo?(): Promise<Info>; configure(o: Record<string, unknown>): Promise<void> };

/** undefined: not asked yet; null: asked, nothing came. */
export const S: { info: Info | null | undefined; asking: boolean } = { info: undefined, asking: false };

/** (Tests: forget what deviceInfo said.) */
export function resetEngineInfo(): void { S.info = undefined; S.asking = false; }

/** A torrent row's engine, for debuggable builds only (deviceInfo().debuggable): «Rust» / «Director», or null (Classic,
 *  a released build, a computer, or deviceInfo not asked yet — asked here once, in the background). */
export function torEngineBadge(x: { kind?: string; meta?: unknown }): string | null {
  if (x.kind !== 'torrent' || nativePlatform() !== 'android') return null;
  const api = ktPlugin() as unknown as Api | null;
  if (S.info === undefined && !S.asking && api?.deviceInfo) { S.asking = true; void api.deviceInfo().then((r) => { S.info = r ?? null; }, () => { S.info = null; }).finally(() => { S.asking = false; }); }
  if (!S.info?.debuggable) return null;
  const e = (x.meta as { torEngine?: string } | undefined)?.torEngine;
  return e === 'rust' ? t('torEngineBadge', { e: t('torEngineRust') }) : e === 'director' ? t('torEngineBadge', { e: t('torEngineDirector') }) : null;
}
