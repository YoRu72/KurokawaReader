// The reading-aid dictionaries on screen (src/readingdict.ts does the work):
//  - dictPanel(): where they are managed — state, Download, Cancel, Remove — shown in Settings and in the reader's
//    text options, the same component in both;
//  - readingAid(): what a book with furigana / pinyin does with them — the readings when the dictionary is on the device,
//    else a notice that offers the download (with progress, the result, a way to try again), and the readings in the
//    open book as soon as it is there;
//  - dictNeeded(): the same offer inside a sheet (the selection's readings).
import { h, icon, toast } from './dom';
import { t, formatBytes } from '../i18n';
import { getSettings, onSettingsChange } from '../settings';
import { getDictState, onDictChange, refreshDictState, downloadDict, cancelDict, removeDict, markDictFailed, dictSize, type DictKind, type DictState, type DictFail } from '../readingdict';

const NAME: Record<DictKind, 'dictName_ja' | 'dictName_zh'> = { ja: 'dictName_ja', zh: 'dictName_zh' };
const OFFER: Record<DictKind, 'dictNotice_ja' | 'dictNotice_zh'> = { ja: 'dictNotice_ja', zh: 'dictNotice_zh' };
/** A size as the interface writes it, its number and unit held together on one line. */
const sz = (n: number): string => formatBytes(n).replace(/ (?=[^ ]+\u2069?$)/, '\u00a0');
const pctOf = (s: DictState): number => (s.total ? Math.min(99, Math.floor((s.done / s.total) * 100)) : 0);
export const dictFailText = (f: DictFail | undefined, code?: number): string => t(`dictFail_${f ?? 'network'}` as 'dictFail_network', { code: code ?? 0 });
const stateText = (s: DictState, kind: DictKind): string => {
  if (s.phase === 'unknown') return t('dictChecking');
  if (s.phase === 'downloading') return t('dictDownloading', { p: pctOf(s), done: sz(Math.min(s.done, s.total)), size: sz(s.total) });
  if (s.phase === 'ready') return t('dictReady', { size: sz(s.bytes || dictSize(kind)) });
  return t('dictNone', { size: sz(dictSize(kind)) });
};

/** Listens to the dictionaries for as long as `el` is on the page: let go once it has been, and is not any more
 *  (a panel drawn again leaves its old one behind — it must not go on listening). Those left behind are let go of
 *  when the next one is made, too, and one that never reached the page within a few seconds of being made. */
const GRACE = 3000; // ms a new one has to reach the page
const live = new Set<{ el: HTMLElement; off: () => void; seen: boolean; at: number }>();
function liveSubscribe(el: HTMLElement, fn: (kind: DictKind, s: DictState) => void): void {
  const now = Date.now();
  for (const l of [...live]) { if (l.el.isConnected) l.seen = true; else if (l.seen || now - l.at > GRACE) { l.off(); live.delete(l); } }
  const rec = { el, seen: false, at: now, off: () => {} };
  rec.off = onDictChange((k, s) => {
    if (el.isConnected) rec.seen = true; else if (rec.seen || Date.now() - rec.at > GRACE) { rec.off(); live.delete(rec); return; }
    fn(k, s);
  });
  live.add(rec);
}

/** The buttons for a state: Download / Try again, Cancel, Remove. */
function actionsFor(kind: DictKind, s: DictState, after?: () => void): HTMLElement[] {
  const go = () => { void downloadDict(kind).then((ok) => { if (ok) after?.(); }); };
  if (s.phase === 'downloading') return [h('button', { type: 'button', class: 'btn small outlined', 'data-act': 'cancel', onclick: () => cancelDict(kind) }, t('cancel'))];
  if (s.phase === 'ready') return [h('button', { type: 'button', class: 'btn small outlined', 'data-act': 'remove', onclick: () => { void removeDict(kind).then(() => toast(t('dictRemoved'))); } }, icon('trash'), t('remove'))];
  if (s.phase === 'unknown') return [];
  const main = h('button', { type: 'button', class: 'btn small primary', 'data-act': s.phase === 'error' ? 'retry' : 'download', onclick: go }, icon(s.phase === 'error' ? 'refresh' : 'download'), t(s.phase === 'error' ? 'dictTryAgain' : 'dictDownload'));
  // (A copy that is on the device but would not load: it may be damaged — removed and fetched again.)
  if (s.phase === 'error' && s.fail === 'load') return [main, h('button', { type: 'button', class: 'btn small outlined', 'data-act': 'redownload', onclick: () => { void removeDict(kind).then(() => downloadDict(kind)).then((ok) => { if (ok) after?.(); }); } }, icon('trash'), t('dictRedownload'))];
  return [main];
}

/** One dictionary's row: its name and state, a bar while it downloads, the buttons. */
function dictRow(kind: DictKind, after?: () => void): HTMLElement {
  const row = h('div', { class: 'kr-dict-row', 'data-kind': kind });
  const draw = (s: DictState) => {
    row.dataset.phase = s.phase;
    const bar = s.phase === 'downloading' ? h('div', { class: 'kr-dict-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctOf(s)) }, h('span', { style: { width: `${pctOf(s)}%` } })) : null;
    row.replaceChildren(
      h('div', { class: 'kr-dict-info' },
        h('b', { class: 'kr-dict-name' }, t(NAME[kind])),
        h('small', { class: 'kr-dict-state' }, stateText(s, kind)),
        bar,
        s.phase === 'error' ? h('small', { class: 'kr-dict-fail', role: 'alert' }, dictFailText(s.fail, s.code)) : null),
      h('div', { class: 'kr-dict-actions' }, ...actionsFor(kind, s, after)));
  };
  draw(getDictState(kind));
  liveSubscribe(row, (k, s) => { if (k === kind) draw(s); });
  void refreshDictState(kind).then((s) => { if (row.isConnected && s.phase !== getDictState(kind).phase) draw(s); else draw(getDictState(kind)); });
  return row;
}

/** Where the dictionaries are managed: Settings, and the reader's text options. */
export function dictPanel(): HTMLElement {
  return h('div', { class: 'kr-dict-panel field', 'data-dicts': '' },
    h('span', { class: 'label' }, t('readingDicts')),
    h('p', { class: 'hint' }, t('readingDictsHint')),
    h('div', { class: 'kr-dict-rows' }, dictRow('ja'), dictRow('zh')));
}

/** The offer inside a sheet (a selection's readings need a dictionary that is not on the device): says so, with the button. */
export function dictNeeded(kind: DictKind, onReady: () => void): HTMLElement {
  return h('div', { class: 'kr-dict-needed' }, h('p', { class: 'hint' }, t(OFFER[kind], { size: sz(dictSize(kind)) })), dictRow(kind, onReady));
}

/* ---------------------------------------------------------------- the notice over a book */
/** A sheet, dialog or panel is open (over the page). */
const sheetOpen = (): boolean => !!document.querySelector('.sheet, .panel.open, .sheet-scrim');
export interface ReadingAid { start(): void; refresh(): void; dispose(): void }
/** Furigana or pinyin in an open book. `attach` puts the readings on the book (once the dictionary is on the device) and
 *  hands back how to take them off; when it fails because the dictionary is missing or bad it calls `onError`.
 *  Shows one notice at a time, and none again once it was closed — until the option is turned on again. */
export function readingAid(kind: DictKind, attach: (onError: (e: Error) => void) => (() => void) & { refresh?: () => void }): ReadingAid {
  let att: ((() => void) & { refresh?: () => void }) | null = null;
  let notice: { el: HTMLElement; close(): void } | null = null;
  let dismissed = false; let disposed = false; let wasOn = getSettings().furigana; let autoHide = 0;
  let waiting = false; // wanted on screen, but a sheet is open: shown (in its own dictionary row) there, the notice comes back after
  const enabled = () => getSettings().furigana;
  const attachNow = () => {
    if (att || disposed || !enabled()) return;
    const a = attach((e) => { if (att === a) att = null; if (disposed) return; void onAttachFailed(e); });
    att = a;
  };
  const onAttachFailed = async (e: Error) => {
    // (Missing, or on the device but not loading — the state says which; the notice shows it with its buttons.)
    if (e.message !== 'dict-missing' && e.message !== 'dict-load') markDictFailed(kind, 'load');
    if (!dismissed) show();
  };
  const closeNotice = () => { waiting = false; window.clearTimeout(autoHide); autoHide = 0; const n = notice; notice = null; n?.close(); };
  const show = () => {
    if (notice || disposed || dismissed || !enabled()) return;
    if (sheetOpen()) { waiting = true; return; }
    waiting = false;
    const el = h('div', { class: 'kr-notice', role: 'status', 'aria-live': 'polite', 'data-kind': kind }) as HTMLElement;
    const x = h('button', { type: 'button', class: 'icon-btn kr-notice-x', title: t('close'), 'aria-label': t('close'), onclick: () => { dismissed = true; closeNotice(); } }, icon('close'));
    const draw = (s: DictState) => {
      el.dataset.phase = s.phase;
      const msg = s.phase === 'downloading' ? t('dictProgress', { p: pctOf(s) }) : s.phase === 'error' ? dictFailText(s.fail, s.code) : t(OFFER[kind], { size: sz(dictSize(kind)) });
      const bar = s.phase === 'downloading' ? h('div', { class: 'kr-dict-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctOf(s)) }, h('span', { style: { width: `${pctOf(s)}%` } })) : null;
      el.replaceChildren(h('div', { class: 'kr-notice-text' }, h('span', { class: 'kr-notice-msg' }, msg), bar), h('div', { class: 'kr-notice-actions' }, ...actionsFor(kind, s).filter((b) => b.dataset.act !== 'remove'), x));
      // (An offer that is not taken up goes away by itself; a download going on or a failure stays until it is dealt with.)
      window.clearTimeout(autoHide); autoHide = 0;
      if (s.phase === 'none' || s.phase === 'unknown') autoHide = window.setTimeout(() => { dismissed = true; closeNotice(); }, 25000);
    };
    document.body.querySelectorAll('.kr-notice').forEach((n) => n.remove());
    document.body.appendChild(el);
    draw(getDictState(kind));
    const off = onDictChange((k, s) => { if (k === kind && notice) draw(s); });
    notice = { el, close: () => { off(); el.remove(); } };
  };
  // A notice never floats over an open sheet or panel: while one is open it is taken away (the dictionary's own row in
  // the options shows the state), and brought back after, if still wanted and not closed by the reader.
  const sync = () => {
    if (disposed) return;
    if (sheetOpen()) { if (notice) { closeNotice(); waiting = true; } } else if (waiting && !dismissed && enabled()) show();
  };
  const mo = new MutationObserver((muts) => { if (muts.some((m) => m.type === 'childList' || (m.target as Element).matches?.('.panel'))) sync(); });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  const off = onDictChange((k, s) => {
    if (k !== kind || disposed) return;
    if (s.phase === 'ready') { const had = !!notice; closeNotice(); if (!att) { attachNow(); if (had) toast(t('dictDone')); } }
  });
  const offSettings = onSettingsChange((st) => {
    if (st.furigana && !wasOn) dismissed = false;
    if (!st.furigana) closeNotice();
    wasOn = st.furigana;
    if (st.furigana) start();
  });
  const start = () => {
    if (disposed || !enabled() || att || notice) return;
    void refreshDictState(kind).then((s) => {
      if (disposed || !enabled() || att) return;
      if (s.phase === 'ready') attachNow(); else if (!dismissed) show();
    });
  };
  return {
    start,
    refresh: () => att?.refresh?.(),
    dispose: () => { disposed = true; closeNotice(); mo.disconnect(); off(); offSettings(); att?.(); att = null; },
  };
}
