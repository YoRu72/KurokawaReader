// Learning decks (optional): nothing ships with the app. Each deck lists its sources in
// order — this app's own "decks" release (a mirror, for openly licensed decks) and the
// deck author's original repository — and the first one that answers is used; if a
// download fails, the next source is tried. Android and desktop download in-app
// (several connections at once; aria2c on desktop when installed) and link the file.
import { h, icon, toast, clear } from './dom';
import { t, countCards } from '../i18n';
import { db } from '../db';
import { importFiles, removeBooks, type SourcedFile } from '../library';
import { nativePlatform, readContentUri } from '../native';
import { fmtMB } from '../updates';
import { navigate } from '../router';

type Source = { repo: string; tag?: string; pick: (name: string) => boolean; label: string };
interface DeckDef { id: string; title: string; lang: 'ja' | 'zh'; body: () => string; license: string; sources: Source[]; page: string }

const APP_REPO = 'YoRu72/KurokawaReader';
export const DECKS: DeckDef[] = [
  {
    id: 'kaishi', title: 'Kaishi 1.5k', lang: 'ja', body: () => t('kaishiBody'), license: '—',
    // No licence for redistribution, so it is not mirrored here: the author's release only.
    sources: [{ repo: 'donkuri/Kaishi', pick: (n) => /kaishi.*\.apkg$/i.test(n), label: 'donkuri/Kaishi' }],
    page: 'https://github.com/donkuri/Kaishi/releases/latest',
  },
  {
    id: 'hsk', title: 'Anki-xiehanzi · New HSK', lang: 'zh', body: () => t('hskBody'), license: 'MIT / GPL-3.0 · CC-CEDICT CC BY-SA',
    sources: [
      { repo: APP_REPO, tag: 'decks', pick: (n) => n === 'hsk-new-2025.apkg', label: t('deckMirror') },
      { repo: 'krmanik/Anki-xiehanzi', pick: (n) => /\.apkg$/i.test(n) && !/sentence/i.test(n), label: 'krmanik/Anki-xiehanzi' },
    ],
    page: 'https://github.com/krmanik/Anki-xiehanzi/releases/latest',
  },
  {
    id: 'hsk-sentences', title: 'Anki-xiehanzi · New HSK + sentences', lang: 'zh', body: () => t('hskSentencesBody'), license: 'MIT / GPL-3.0 · CC-CEDICT CC BY-SA',
    sources: [
      { repo: APP_REPO, tag: 'decks', pick: (n) => n === 'hsk-new-2025-sentences.apkg', label: t('deckMirror') },
      { repo: 'krmanik/Anki-xiehanzi', pick: (n) => /sentence.*\.apkg$/i.test(n), label: 'krmanik/Anki-xiehanzi' },
    ],
    page: 'https://github.com/krmanik/Anki-xiehanzi/releases/latest',
  },
];

interface Asset { url: string; name: string; size: number; from: string }
async function resolve(src: Source): Promise<Asset | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${src.repo}/releases/${src.tag ? `tags/${src.tag}` : 'latest'}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const j = await r.json() as { assets?: { name: string; size: number; browser_download_url: string }[] };
    const a = j.assets?.find((x) => src.pick(x.name));
    return a ? { url: a.browser_download_url, name: a.name, size: a.size, from: src.label } : null;
  } catch { return null; }
}

type Installed = Record<string, { bookId: string; path: string }>;
const getInstalled = async () => (await db.getMeta<Installed>('decks:installed')) ?? {};

type Prog = { pct: number; got: number; total: number; speed: number; via?: string };
async function download(asset: Asset, onProgress: (p: Prog) => void): Promise<{ file: SourcedFile; path: string }> {
  if (nativePlatform() === 'android') {
    const k = (window as unknown as { Capacitor: { Plugins: { Kurokawa: { downloadFile(o: { url: string; name: string; persist: boolean; connections: number }): Promise<{ path: string }>; addListener?(ev: string, fn: (p: Prog) => void): Promise<{ remove(): void }> } } } }).Capacitor.Plugins.Kurokawa;
    const sub = await k.addListener?.('downloadProgress', onProgress);
    try {
      const { path } = await k.downloadFile({ url: asset.url, name: asset.name, persist: true, connections: 8 });
      const file = await readContentUri(path, asset.name, 'application/octet-stream') as SourcedFile; file.krSource = { uri: path };
      return { file, path };
    } finally { sub?.remove(); }
  }
  const dk = window.kurokawaDesktop as unknown as { download(u: string, n: string): Promise<string>; onDownloadProgress?(cb: (p: Prog) => void): void; readFile(p: string): Promise<ArrayBuffer> };
  dk.onDownloadProgress?.(onProgress);
  const path = await dk.download(asset.url, asset.name);
  const file = new File([await dk.readFile(path)], asset.name) as SourcedFile; file.krSource = { path };
  return { file, path };
}

/** The Settings section: one row per deck with its sources, size and licence. */
export function decksCard(): HTMLElement {
  const list = h('div', { class: 'deck-list' });
  const card = h('section', { class: 'card' }, h('h3', null, t('starterDecks')), h('p', null, t('starterDecksBody')), list);
  const plat = nativePlatform();
  const inApp = plat === 'android' || plat === 'desktop';
  const draw = async () => {
    const installed = await getInstalled();
    clear(list);
    for (const d of DECKS) {
      const have = installed[d.id] && (await db.getBook(installed[d.id].bookId)) ? installed[d.id] : null;
      const status = h('span', { class: 'hint' });
      const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
      const actions = h('div', { class: 'deck-actions' });
      if (have) {
        actions.append(
          h('button', { class: 'btn small primary', type: 'button', onclick: () => navigate(`/read/${have.bookId}`) }, icon('play'), t('open')),
          h('button', { class: 'btn small danger', type: 'button', 'aria-label': t('delete'), onclick: async () => {
            if (!confirm(t('deleteConfirm', { n: 1 }))) return;
            await removeBooks([have.bookId]);
            if (plat === 'android') await (window as unknown as { Capacitor: { Plugins: { Kurokawa: { deleteDownload?(o: { path: string }): Promise<unknown> } } } }).Capacitor.Plugins.Kurokawa.deleteDownload?.({ path: have.path }).catch(() => {});
            else await (window.kurokawaDesktop as unknown as { deleteDownload?(p: string): Promise<boolean> } | undefined)?.deleteDownload?.(have.path).catch(() => false);
            const all = await getInstalled(); delete all[d.id]; await db.setMeta('decks:installed', all);
            void draw();
          } }, icon('trash')));
      } else {
        const btn = h('button', { class: 'btn small primary', type: 'button' }, icon('download'), t('deckDownload')) as HTMLButtonElement;
        btn.addEventListener('click', async () => {
          btn.disabled = true; track.hidden = false; status.textContent = t('checking');
          try {
            let lastErr: unknown = null;
            for (const src of d.sources) {
              const asset = await resolve(src);
              if (!asset) { lastErr = new Error(t('deckSourceMissing', { source: src.label })); continue; }
              if (!inApp) { window.open(asset.url, '_blank', 'noopener'); status.textContent = t('deckOpenedInBrowser'); return; }
              try {
                const { file, path } = await download(asset, (p) => { bar.style.width = `${p.pct}%`; status.textContent = `${asset.from} · ${p.pct}% · ${fmtMB(p.got)} / ${fmtMB(p.total || asset.size)}${p.speed ? ` · ${fmtMB(p.speed)}/s` : ''}${p.via ? ` · ${p.via}` : ''}`; });
                status.textContent = t('loading');
                const added = await importFiles([file]);
                if (!added.length) throw new Error(t('convertFailed'));
                const all = await getInstalled(); all[d.id] = { bookId: added[0].id, path }; await db.setMeta('decks:installed', all);
                toast(t('addedToLibrary'));
                void draw();
                return;
              } catch (err) { lastErr = err; status.textContent = t('deckTryingNext'); }
            }
            throw lastErr ?? new Error(t('deckSourceMissing', { source: d.title }));
          } catch (err) { status.textContent = String((err as Error).message ?? err); }
          finally { btn.disabled = false; }
        });
        actions.append(btn);
      }
      actions.append(h('a', { class: 'btn small', href: d.page, target: '_blank', rel: 'noopener', 'aria-label': t('openInBrowser') }, icon('external')));
      list.append(h('div', { class: 'deck-row' },
        h('div', { class: 'deck-info' },
          h('b', null, `${d.title} `, h('small', { lang: d.lang }, d.lang === 'ja' ? '日本語' : '中文')),
          h('p', null, d.body()),
          h('p', { class: 'deck-meta' }, `${t('deckSources')}: ${d.sources.map((s) => s.label).join(' → ')} · ${t('deckLicense')}: ${d.license}`),
          track, status),
        actions));
    }
    // The reader's own decks: any .apkg / .colpkg from the device, and the ones already in the library.
    const mine = (await db.allBooks()).filter((b) => b.format === 'anki' && !Object.values(installed).some((i) => i.bookId === b.id));
    const input = h('input', { type: 'file', accept: '.apkg,.colpkg', multiple: true, hidden: true }) as HTMLInputElement;
    input.addEventListener('change', async () => { const files = Array.from(input.files ?? []); input.value = ''; if (!files.length) return; try { const added = await importFiles(files); toast(t('imported', { n: added.length })); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } void draw(); });
    list.append(h('div', { class: 'deck-row own' },
      h('div', { class: 'deck-info' }, h('b', null, t('myDecks')), h('p', null, t('myDecksBody')),
        mine.length ? h('div', { class: 'deck-mine' }, ...mine.map((b) => h('button', { type: 'button', class: 'chip small', onclick: () => navigate(`/read/${b.id}`) }, icon('play'), h('span', null, `${b.title}${b.pageCount ? ' · ' + countCards(b.pageCount) : ''}`)))) : null),
      h('div', { class: 'deck-actions' }, input, h('button', { class: 'btn small primary', type: 'button', onclick: () => input.click() }, icon('import'), t('importDeck')))));
  };
  void draw();
  return card;
}
