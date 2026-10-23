// Learning decks: well-known Anki decks fetched from their authors' GitHub releases
// on request (never bundled — Kaishi carries no licence for redistribution). On
// Android and desktop the download lands in app storage and is linked; elsewhere
// the release page opens so the file can be downloaded and imported by hand.
import { h, icon, openSheet, toast } from './dom';
import { t, localDigits } from '../i18n';
import { importFiles, type SourcedFile } from '../library';
import { nativePlatform, readContentUri } from '../native';
import { fmtMB } from '../updates';

interface DeckSource { id: string; title: string; lang: string; body: () => string; repo: string; pick: (name: string) => boolean; page: string }
const DECKS: DeckSource[] = [
  { id: 'kaishi', title: 'Kaishi 1.5k', lang: '日本語', body: () => t('kaishiBody'), repo: 'donkuri/Kaishi', pick: (n) => /kaishi.*\.apkg$/i.test(n), page: 'https://github.com/donkuri/Kaishi/releases/latest' },
  { id: 'hsk', title: 'Anki-xiehanzi · New HSK', lang: '中文', body: () => t('hskBody'), repo: 'krmanik/Anki-xiehanzi', pick: (n) => /\.apkg$/i.test(n) && !/sentence/i.test(n), page: 'https://github.com/krmanik/Anki-xiehanzi/releases/latest' },
];

async function latestAsset(d: DeckSource): Promise<{ url: string; name: string; size: number } | null> {
  const r = await fetch(`https://api.github.com/repos/${d.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) return null;
  const j = await r.json() as { assets?: { name: string; size: number; browser_download_url: string }[] };
  const a = j.assets?.find((x) => d.pick(x.name));
  return a ? { url: a.browser_download_url, name: a.name, size: a.size } : null;
}

export function starterDecksSheet(onAdded: () => void): void {
  const sh = openSheet(t('starterDecks'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.body.append(h('p', { class: 'src' }, t('starterDecksBody')));
  const plat = nativePlatform();
  for (const d of DECKS) {
    const status = h('span', { class: 'hint' });
    const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
    const btn = h('button', { class: 'btn small primary', type: 'button' }, icon('download'), t('deckDownload')) as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const asset = await latestAsset(d);
        if (!asset || (plat !== 'android' && plat !== 'desktop')) { window.open(d.page, '_blank', 'noopener'); return; }
        track.hidden = false;
        const progress = (p: { pct: number; got: number; total: number; speed: number }) => { bar.style.width = `${p.pct}%`; status.textContent = `${t('downloadingDeck', { p: p.pct })} · ${fmtMB(p.got)} / ${fmtMB(p.total || asset.size)}${p.speed ? ` · ${fmtMB(p.speed)}/s` : ''}`; };
        let file: SourcedFile;
        if (plat === 'android') {
          const k = (window as unknown as { Capacitor?: { Plugins?: { Kurokawa?: { downloadFile(o: { url: string; name: string; persist: boolean }): Promise<{ path: string }>; addListener?(ev: string, fn: (p: { pct: number; got: number; total: number; speed: number }) => void): Promise<{ remove(): void }> } } } }).Capacitor!.Plugins!.Kurokawa!;
          const sub = await k.addListener?.('downloadProgress', progress);
          try { const { path } = await k.downloadFile({ url: asset.url, name: asset.name, persist: true }); file = await readContentUri(path, asset.name, 'application/octet-stream') as SourcedFile; file.krSource = { uri: path }; }
          finally { sub?.remove(); }
        } else {
          const dk = window.kurokawaDesktop as unknown as { download(u: string, n: string): Promise<string>; onDownloadProgress?(cb: (p: { pct: number; got: number; total: number; speed: number }) => void): void; readFile(p: string): Promise<ArrayBuffer> };
          dk.onDownloadProgress?.(progress);
          const path = await dk.download(asset.url, asset.name);
          file = new File([await dk.readFile(path)], asset.name) as SourcedFile; file.krSource = { path };
        }
        status.textContent = t('loading');
        const added = await importFiles([file]);
        status.textContent = added.length ? t('addedToLibrary') : t('convertFailed');
        if (added.length) { toast(t('addedToLibrary')); onAdded(); }
      } catch (err) { status.textContent = String((err as Error).message ?? err); }
      finally { btn.disabled = false; }
    });
    sh.body.append(h('div', { class: 'deck-row' },
      h('div', { class: 'deck-info' }, h('b', null, `${d.title} `, h('small', { lang: d.lang === '日本語' ? 'ja' : 'zh' }, d.lang)), h('p', null, d.body()), track, status),
      h('div', { class: 'deck-actions' }, btn, h('a', { class: 'btn small', href: d.page, target: '_blank', rel: 'noopener' }, icon('external')))));
  }
  void localDigits;
}
