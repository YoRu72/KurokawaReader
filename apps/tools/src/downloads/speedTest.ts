// The downloader's speed test: the app's own downloader (on a phone, the one every file download goes through)
// fetching a test file from Cloudflare's speed-test server with 1, 2, 4, 8 and 16 connections, a few seconds each —
// how fast this phone's link is, and how many connections suit it. A weak link (some phones' modems, a busy cell)
// is often faster with fewer connections; a fast one with more. The best is offered as the downloads' number.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t, localDigits, formatBytes } from '../i18n';
import { ktPlugin } from '../native';
import { getSettings, updateSettings } from '../settings';

const URL_ = 'https://speed.cloudflare.com/__down?bytes=200000000';
const STEPS = [1, 2, 4, 8, 16];
const SECS = 5;
type Dl = { downloadFile(o: { url: string; name: string; id: string; connections: number }): Promise<unknown>; cancelDownload(o: { id: string }): Promise<void>; addListener(ev: string, cb: (d: { id: string; got: number }) => void): Promise<{ remove(): void }> };

/** Bytes a second fetched with `n` connections over `secs` seconds (the first second, while connections open, not counted). */
async function measure(n: number, secs: number, onTick: (bps: number) => void, stop: () => boolean): Promise<number> {
  const p = ktPlugin() as unknown as Dl | null; const id = `kt-speed-${n}-${Date.now()}`;
  let got = 0; const t0 = performance.now(); let base = -1, baseT = 0;
  const seen = (g: number) => { got = g; const now = performance.now(); if (base < 0 && now - t0 > 1000) { base = g; baseT = now; } if (base >= 0 && now > baseT) onTick(((g - base) * 1000) / (now - baseT)); };
  if (p?.downloadFile) {
    const sub = await p.addListener('downloadProgress', (d) => { if (d.id === id) seen(d.got); });
    const run = p.downloadFile({ url: URL_, name: `speedtest-${n}.bin`, id, connections: n }).catch(() => undefined);
    await new Promise<void>((ok) => { const end = performance.now() + secs * 1000; const tm = setInterval(() => { if (performance.now() > end || stop()) { clearInterval(tm); ok(); } }, 200); void run.then(() => { clearInterval(tm); ok(); }); });
    await p.cancelDownload({ id }).catch(() => undefined); sub.remove();
  } else {
    // (A computer: the page's own requests, `n` at once.)
    const ac = new AbortController(); const counts = new Array(n).fill(0); const tick = () => seen(counts.reduce((a, b) => a + b, 0));
    const one = async (i: number) => { const r = await fetch(URL_, { signal: ac.signal, cache: 'no-store' }); const rd = r.body!.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; counts[i] += value.length; tick(); } };
    const all = Promise.all(counts.map((_, i) => one(i).catch(() => undefined)));
    await Promise.race([all, new Promise((ok) => { const end = performance.now() + secs * 1000; const tm = setInterval(() => { if (performance.now() > end || stop()) { clearInterval(tm); ok(null); } }, 200); })]);
    ac.abort();
  }
  const now = performance.now(); if (base < 0) return got ? (got * 1000) / Math.max(1, now - t0) : 0;
  return ((got - base) * 1000) / Math.max(1, now - baseT);
}

const rate = (bps: number) => t('perSecond', { n: formatBytes(bps) });

export function openSpeedTest(onPicked?: (n: number) => void): void {
  const sh = openSheet(t('speedTest'), t('close')); let stopped = false; const prevClose = sh.close; sh.close = () => { stopped = true; prevClose(); };
  const rows = STEPS.map((n) => { const v = h('b', { class: 'speed-v', dir: 'ltr' }, '—'); const bar = h('div', { class: 'task-bar thin' }, h('i', { style: { width: '0%' } })); return { n, v, bar, el: h('div', { class: 'speed-row' }, h('span', null, n === 1 ? t('speedOneConn') : t('speedConns', { n: localDigits(n) })), v, bar) }; });
  const verdict = h('p', { class: 'hint', dir: 'auto' }, t('speedRunning'));
  const acts = h('div', { class: 'row-actions' });
  sh.body.append(h('p', { class: 'hint' }, t('speedTestHint')), ...rows.map((r) => r.el), verdict, acts);
  void (async () => {
    const res: number[] = []; let max = 1;
    for (const r of rows) {
      if (stopped) return; r.el.classList.add('on');
      const bps = await measure(r.n, SECS, (b) => { r.v.textContent = rate(b); }, () => stopped);
      res.push(bps); max = Math.max(max, ...res); r.el.classList.remove('on'); r.v.textContent = bps ? rate(bps) : t('speedFailed');
      rows.forEach((x, i) => { if (res[i] !== undefined) (x.bar.firstChild as HTMLElement).style.width = `${Math.round((res[i] / max) * 100)}%`; });
    }
    if (stopped) return;
    const top = Math.max(...res); if (!top) { verdict.textContent = t('speedNoNet'); return; }
    // (The fewest connections within 10 % of the best: as fast, and kinder to the link and the servers.)
    const bestI = res.findIndex((x) => x >= top * 0.9); const best = STEPS[bestI];
    rows[bestI].el.classList.add('best');
    verdict.textContent = t('speedVerdict', { speed: rate(top), n: localDigits(best) });
    const cur = getSettings().connections;
    acts.append(h('button', { type: 'button', class: 'btn primary', disabled: cur === best, onclick: () => { updateSettings({ connections: best }); onPicked?.(best); toast(t('speedUsed', { n: localDigits(best) })); sh.close(); } }, icon('check'), t('speedUse', { n: localDigits(best) })));
  })();
}
