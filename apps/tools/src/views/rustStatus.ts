// Settings → Advanced (stage M5 of the Rust port, docs/RUST-PORT.md §5; the engine rows are engineSettings.ts's): the
// «Rust core status» block the Advanced card ends with on a phone that carries a Rust library — never on a computer.
// The core's version, every engine in use and chosen (download, torrent, screen translator, HLS, file jobs, network
// storages) with its fallbacks, checks and mismatches, the torrent director's plans and the Rust torrent library, the
// screen translator's Rust calls and patch cache, the shadow's totals, the file jobs' journal (jobs that can be resumed
// or undone), and «Copy report» — one text the owner can send. It reads deviceInfo() as it comes and shows what is
// there (ANDROID-PORT.md «M6 — what removal needs» lists the fields each stage reports).
import { h, toast } from '../ui/dom';
import { t, localDigits } from '../i18n';

export type CoreInfo = Record<string, unknown> & { rustCore?: string | null };
type Api = {
  deviceInfo?(): Promise<CoreInfo>; configure(o: Record<string, unknown>): Promise<void>;
  filesJournals?(): Promise<{ items?: Journal[] }>; filesJournalResume?(o: { journal: string }): Promise<unknown>; filesJournalRollback?(o: { journal: string; undo?: boolean }): Promise<unknown>;
};
type Journal = { id: string; op?: string; dest?: string; steps?: number; done?: number; resumable?: boolean; undoable?: boolean; finished?: boolean; at?: number };

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The engines deviceInfo reports: every «<area>Engine» field (dlEngine, fileEngine, and the sister stages' when they
 *  come), and any rows of a `rustEngines` list. */
export function enginesOf(info: CoreInfo): { area: string; inUse: string; choice: string; fallbacks: number; checks: number; mismatches: number }[] {
  const out: { area: string; inUse: string; choice: string; fallbacks: number; checks: number; mismatches: number }[] = [];
  for (const k of Object.keys(info)) {
    const m = /^([a-z][A-Za-z0-9]*)Engine$/.exec(k); if (!m) continue; const a = m[1];
    out.push({ area: a, inUse: str(info[k]), choice: str(info[`${a}EngineChoice`]), fallbacks: num(info[`${a}EngineFallbacks`]), checks: num(info[`${a}Checks`]), mismatches: num(info[`${a}Mismatches`]) });
  }
  const list = Array.isArray(info.rustEngines) ? (info.rustEngines as Record<string, unknown>[]) : [];
  for (const e of list) { const area = str(e?.area); if (!area || out.some((o) => o.area === area)) continue; out.push({ area, inUse: str(e.inUse), choice: str(e.choice), fallbacks: num(e.fallbacks), checks: num(e.checks), mismatches: num(e.mismatches) }); }
  return out;
}
const AREAS: Record<string, () => string> = { dl: () => t('dlEngine'), file: () => t('fileEngine'), remote: () => t('rustAreaRemote'), tor: () => t('rustAreaTor'), screen: () => t('rustAreaScreen'), hls: () => t('rustAreaHls') };
const areaName = (a: string): string => AREAS[a]?.() ?? a;
const engineName = (v: string): string => (v === 'rust' ? 'Rust' : v === 'java' || v === 'classic' ? t('fileEngineClassic') : v === 'director' ? t('torEngineDirector') : v || t('rustStatusNone'));

/** The report «Copy report» puts on the clipboard: plain text, every field deviceInfo gave (no secret is among them). */
export function reportText(info: CoreInfo): string {
  const lines = [`Kurokawa Tools — ${t('rustStatusTitle')}`, `core: ${str(info.rustCore) || 'absent'} (${str(info.rustCoreStatus)})`, `torrent library: ${str(info.rustTorrent) || 'absent'}${info.rustTorrentStatus ? ` (${str(info.rustTorrentStatus)})` : ''}`];
  for (const e of enginesOf(info)) lines.push(`${e.area}: in use ${e.inUse || '?'}, chosen ${e.choice || '?'}, fallbacks ${e.fallbacks}, checks ${e.checks}, mismatches ${e.mismatches}`);
  if ('torDirectorPlans' in info) lines.push(`tor director: plans ${num(info.torDirectorPlans)}, fallbacks ${num(info.torDirectorFallbacks)}, held by the Rust engine ${num(info.torEngineHeld)}`);
  const sc = (info.screenCache ?? {}) as Record<string, unknown>;
  if ('screenEngineCalls' in info) lines.push(`screen: Rust calls ${num(info.screenEngineCalls)}, patch cache hits ${num(sc.cacheHits)}, misses ${num(sc.cacheMisses)}, ${num(sc.cacheItems)} items, ${num(sc.cacheBytes)} bytes`);
  lines.push('', JSON.stringify(info, null, 1));
  return lines.join('\n');
}

/** The «Rust core status» block. */
export function rustStatusCard(info: CoreInfo, api: Api): HTMLElement {
  const box = h('div', { class: 'rust-status', id: 'rust-status' });
  const shadow = (info.rustShadow ?? {}) as Record<string, unknown>;
  const rows: (HTMLElement | string)[] = [h('h4', null, t('rustStatusTitle'))];
  if (info.rustCore) rows.push(h('div', { class: 'src' }, t('rustStatusCore', { version: str(info.rustCore) })));
  for (const e of enginesOf(info)) {
    rows.push(h('div', { class: 'rust-engine', 'data-area': e.area }, h('b', null, areaName(e.area)), ' ', h('span', null, t('rustStatusEngine', { engine: engineName(e.inUse), choice: engineName(e.choice) })),
      h('small', { class: 'src' }, ' · ', t('rustStatusCounts', { fallbacks: localDigits(e.fallbacks), checks: localDigits(e.checks), mismatches: localDigits(e.mismatches) }))));
  }
  if ('torDirectorPlans' in info || info.rustTorrent) rows.push(h('div', { class: 'src rust-tor' }, t('rustStatusTor', { plans: localDigits(num(info.torDirectorPlans)), fallbacks: localDigits(num(info.torDirectorFallbacks)), version: str(info.rustTorrent) || '—' })));
  const cache = (info.screenCache ?? {}) as Record<string, unknown>;
  if ('screenEngineCalls' in info) rows.push(h('div', { class: 'src rust-screen' }, t('rustStatusScreen', { calls: localDigits(num(info.screenEngineCalls)), hits: localDigits(num(cache.cacheHits)), misses: localDigits(num(cache.cacheMisses)) })));
  if (typeof shadow.calls === 'number') rows.push(h('div', { class: 'src rust-shadow' }, t('rustStatusShadow', { checks: localDigits(num(shadow.calls)), mismatches: localDigits(num(shadow.mismatches)) })));
  if ('fileJournalResumable' in info) rows.push(h('div', { class: 'src rust-journal' }, t('rustStatusJournal', { n: localDigits(num(info.fileJournalResumable)), u: localDigits(num(info.fileJournalUndoable)) })));
  if ('fileDisputed' in info && num(info.fileDisputed) > 0) rows.push(h('div', { class: 'src rust-disputed' }, t('rustStatusDisputed', { n: localDigits(num(info.fileDisputed)) })));
  const jobs = h('div', { class: 'rust-jobs' });
  const copy = h('button', { type: 'button', class: 'btn small tonal rust-copy', onclick: () => {
    const text = reportText(info);
    const done = () => toast(t('rustStatusCopied'));
    try { void navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); } catch { fallbackCopy(text, done); }
  } }, t('rustStatusCopy'));
  const actions: HTMLElement[] = [copy];
  if (num(info.fileJournalResumable) > 0 && api.filesJournals) actions.push(h('button', { type: 'button', class: 'btn small tonal rust-jobs-open', onclick: () => void listJobs(api, jobs) }, t('rustJobsTitle')));
  rows.push(h('div', { class: 'row rust-actions' }, ...actions), jobs);
  box.append(...rows);
  return box;
}

function fallbackCopy(text: string, done: () => void): void {
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }) as HTMLTextAreaElement; ta.value = text; document.body.append(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* nothing more to try */ } ta.remove();
}

async function listJobs(api: Api, into: HTMLElement): Promise<void> {
  let items: Journal[] = [];
  try { items = (await api.filesJournals?.())?.items ?? []; } catch { items = []; }
  const cut = items.filter((j) => j.resumable);
  into.replaceChildren(...cut.map((j) => h('div', { class: 'row rust-job' },
    h('span', { class: 'grow', dir: 'auto' }, t('rustJobLine', { op: j.op === 'move' ? t('rustOpMove') : j.op === 'delete' ? t('rustOpDelete') : t('rustOpCopy'), dest: str(j.dest), done: localDigits(num(j.done)), steps: localDigits(num(j.steps)) })),
    h('button', { type: 'button', class: 'btn small tonal', onclick: () => void api.filesJournalResume?.({ journal: j.id }).then(() => toast(t('rustJobsStarted')), () => toast(t('rustJobsFailed'))) }, t('rustJobsResume')),
    h('button', { type: 'button', class: 'btn small', onclick: () => void api.filesJournalRollback?.({ journal: j.id }).then(() => { toast(t('rustJobsRolledBack')); void listJobs(api, into); }, () => toast(t('rustJobsFailed'))) }, t('rustJobsRollback')))));
}
