// Online catalogues (OPDS): the catalogues kept, the free ones anyone may add with a tap, and a feed's pages —
// shelves to go into, books with their files to fetch straight into the library — with a search when the
// catalogue offers one. Each feed is its own place in the history, so the system's back goes up one shelf.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { navigate } from '../router';
import { db } from '../db';
import { nativePlatform } from '../native';
import { fmtMB } from '../updates';
import { getCatalogs, saveCatalogs, catalogFor, fetchFeed, searchUrl, entryFeed, entryDocument, acquisitions, downloadToLibrary, OpdsError, SUGGESTED, type Catalog, type OpdsFeed, type OpdsEntry } from '../opds';

const uid = () => Math.random().toString(36).slice(2, 10);
const feedPath = (url: string, q?: string) => `/catalog?u=${encodeURIComponent(url)}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

export function catalogView(url?: string, q?: string): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'library-body catalog-view' });
  const titleEl = h('div', { class: 'title' }, t('catalogs'));
  const actions = h('div', { class: 'topbar-actions' });
  const root = h('div', { class: 'view catalog-view' },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), () => (url ? history.back() : navigate('/'))), titleEl, actions),
    body) as HTMLElement & { dispose?: () => void };
  let gone = false; root.dispose = () => { gone = true; };

  if (!url) { renderHome(); return root; }
  void renderFeed(url, q);
  return root;

  /* ---------- the catalogues kept ---------- */

  function renderHome(): void {
    body.replaceChildren();
    actions.replaceChildren(iconButton('plus', t('addCatalog'), () => editCatalog()));
    const mine = getCatalogs();
    body.append(h('p', { class: 'hint catalog-hint' }, t('catalogHint')));
    if (mine.length) {
      body.append(h('h3', { class: 'section-title' }, t('yourCatalogs')));
      const list = h('ul', { class: 'plain-list catalog-list' });
      for (const c of mine) {
        list.append(h('li', null,
          h('button', { type: 'button', onclick: () => navigate(feedPath(c.url)) }, icon('globe'), h('span', { class: 'catalog-name' }, h('b', { dir: 'auto' }, c.name), h('small', null, hostOf(c.url) + (c.user ? ` · ${c.user}` : '')))),
          h('button', { type: 'button', class: 'del', 'aria-label': t('edit'), onclick: () => editCatalog(c) }, icon('pen'))));
      }
      body.append(list);
    } else {
      body.append(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('globe')), h('p', null, t('noCatalogsYet'))));
    }
    const left = SUGGESTED.filter((sg) => !mine.some((c) => hostOf(c.url) === hostOf(sg.url)));
    if (left.length) {
      body.append(h('h3', { class: 'section-title' }, t('suggestedCatalogs')));
      const list = h('ul', { class: 'plain-list catalog-list' });
      for (const sg of left) {
        list.append(h('li', null,
          h('button', { type: 'button', onclick: () => { const c: Catalog = { id: uid(), name: sg.name, url: sg.url }; saveCatalogs([...getCatalogs(), c]); navigate(feedPath(c.url)); } }, icon('books'), h('span', { class: 'catalog-name' }, h('b', null, sg.name), h('small', null, `${sg.note} · ${hostOf(sg.url)}`))),
          h('button', { type: 'button', class: 'del', 'aria-label': t('addCatalog'), onclick: () => { const c: Catalog = { id: uid(), name: sg.name, url: sg.url }; saveCatalogs([...getCatalogs(), c]); renderHome(); toast(t('catalogAdded', { name: sg.name })); } }, icon('plus'))));
      }
      body.append(list);
    }
  }

  /** The form for a catalogue: new, or `c` to change or remove. */
  function editCatalog(c?: Catalog, after?: () => void): void {
    const sh = openSheet(c ? c.name : t('addCatalog'), t('close'));
    const name = h('input', { type: 'text', value: c?.name ?? '', placeholder: t('catalogName'), dir: 'auto' }) as HTMLInputElement;
    const addr = h('input', { type: 'url', value: c?.url ?? '', placeholder: 'https://…/opds', inputmode: 'url', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
    const user = h('input', { type: 'text', value: c?.user ?? '', placeholder: t('catalogUser'), autocapitalize: 'off', autocomplete: 'username' }) as HTMLInputElement;
    const pass = h('input', { type: 'password', value: c?.pass ?? '', placeholder: t('catalogPass'), autocomplete: 'current-password' }) as HTMLInputElement;
    const field = (label: string, input: HTMLElement) => h('label', { class: 'field' }, h('span', null, label), input);
    sh.body.append(field(t('catalogName'), name), field(t('catalogUrl'), addr), field(t('catalogUser'), user), field(t('catalogPass'), pass), h('p', { class: 'hint' }, t('catalogLoginHint')));
    const save = h('button', { type: 'button', class: 'btn primary', onclick: () => {
      let u = addr.value.trim(); if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
      try { new URL(u); } catch { toast(t('catalogBadUrl'), 'error'); return; }
      const next: Catalog = { id: c?.id ?? uid(), name: name.value.trim() || hostOf(u), url: u, user: user.value.trim() || undefined, pass: pass.value || undefined };
      saveCatalogs(c ? getCatalogs().map((x) => (x.id === c.id ? next : x)) : [...getCatalogs(), next]);
      sh.close(); if (after) after(); else if (c) renderHome(); else navigate(feedPath(next.url));
    } }, icon('check'), t('done'));
    sh.actions.append(save);
    if (c) sh.actions.append(h('button', { type: 'button', class: 'btn danger', onclick: () => { if (!confirm(t('removeCatalogConfirm', { name: c.name }))) return; saveCatalogs(getCatalogs().filter((x) => x.id !== c.id)); sh.close(); renderHome(); } }, icon('trash'), t('removeCatalog')));
    setTimeout(() => (c ? addr : name).focus(), 60);
  }

  /* ---------- a feed ---------- */

  async function renderFeed(feedUrl: string, query?: string): Promise<void> {
    body.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('loading')));
    const cat = catalogFor(feedUrl);
    titleEl.textContent = cat?.name ?? hostOf(feedUrl);
    let feed: OpdsFeed;
    try {
      feed = await fetchFeed(feedUrl);
      if (query) { const su = await searchUrl(feed, query); if (!su) throw new OpdsError('nosearch'); feed = await fetchFeed(su); }
    } catch (err) { if (!gone) showError(err, feedUrl, query); return; }
    if (gone) return;
    titleEl.replaceChildren(h('span', { dir: 'auto' }, feed.title)); if (cat && cat.name !== feed.title) titleEl.append(h('small', null, cat.name));
    actions.replaceChildren();
    body.replaceChildren();
    if (feed.search || query) {
      const input = h('input', { type: 'search', class: 'catalog-search', placeholder: t('searchCatalog'), value: query ?? '', dir: 'auto', 'aria-label': t('searchCatalog') }) as HTMLInputElement;
      const form = h('form', { class: 'catalog-search-row', onsubmit: (e: Event) => { e.preventDefault(); const v = input.value.trim(); if (v) navigate(feedPath(query ? feedUrl : feed.url, v)); } }, input, h('button', { type: 'submit', class: 'icon-btn', 'aria-label': t('search') }, icon('search')));
      body.append(form);
      actions.append(iconButton('search', t('searchCatalog'), () => input.focus()));
    }
    const list = h('div', { class: 'catalog-entries' });
    body.append(list);
    if (!feed.entries.length) list.append(h('div', { class: 'empty small' }, h('p', null, t('catalogEmpty'))));
    const have = await inLibrary();
    const more = h('div', { class: 'catalog-more' });
    body.append(more);
    const show = (f: OpdsFeed) => {
      for (const e of f.entries) list.append(entryRow(e, have));
      more.replaceChildren();
      if (f.next) {
        const btn = h('button', { type: 'button', class: 'btn tonal', onclick: async () => {
          btn.disabled = true; btn.textContent = t('loading');
          try { const nx = await fetchFeed(f.next!); if (!gone) show(nx); } catch (err) { toast(describe(err), 'error'); btn.disabled = false; btn.textContent = t('nextPage'); }
        } }, t('nextPage'));
        more.append(btn);
      }
    };
    show(feed);
  }

  function showError(err: unknown, feedUrl: string, query?: string): void {
    const e = err as OpdsError;
    body.replaceChildren();
    if (e instanceof OpdsError && e.message === 'auth') {
      body.append(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('user')), h('p', null, t('catalogNeedsLogin')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => {
          const c = catalogFor(feedUrl) ?? { id: uid(), name: hostOf(feedUrl), url: feedUrl };
          if (!catalogFor(feedUrl)) saveCatalogs([...getCatalogs(), c]);
          editCatalog(catalogFor(feedUrl) ?? c, () => void renderFeed(feedUrl, query));
        } }, icon('user'), t('catalogSignIn'))));
      return;
    }
    body.append(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('globe')), h('p', null, describe(err)),
      h('button', { type: 'button', class: 'btn tonal', onclick: () => void renderFeed(feedUrl, query) }, t('tryAgain'))));
  }
  function describe(err: unknown): string {
    const e = err as Error;
    if (e instanceof OpdsError) {
      if (e.message === 'auth') return t('catalogNeedsLogin');
      if (e.message === 'nosearch') return t('catalogNoSearch');
      if (e.message === 'parse') return t('catalogLoadFailed', { error: t('catalogNotOpds') });
      return t('catalogLoadFailed', { error: e.message });
    }
    if (e instanceof TypeError && nativePlatform() === 'web') return t('catalogCors');
    return t('catalogLoadFailed', { error: e?.message ?? String(err) });
  }

  /** Titles already in the library, to say so on the shelf. */
  async function inLibrary(): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try { for (const b of await db.allBooks()) m.set(keyOf(b.title, b.author), b.id); } catch { /* the shelf shows without */ }
    return m;
  }
  function keyOf(title: string, author?: string): string { return `${title.trim().toLowerCase()}|${(author ?? '').trim().toLowerCase().split(/[,;]/)[0]}`; }

  function entryRow(e: OpdsEntry, have: Map<string, string>): HTMLElement {
    const next = entryFeed(e);
    if (next) {
      return h('button', { type: 'button', class: 'catalog-nav', onclick: () => navigate(feedPath(next)) },
        e.thumbnail ? h('img', { class: 'catalog-thumb small', src: e.thumbnail, alt: '', loading: 'lazy' }) : icon('folder'),
        h('span', { class: 'catalog-nav-text' }, h('b', { dir: 'auto' }, e.title), e.summary ? h('small', { dir: 'auto' }, e.summary.slice(0, 160)) : null),
        icon('chevronRight'));
    }
    const acqs = acquisitions(e);
    const haveId = have.get(keyOf(e.title, e.authors[0]));
    const buttons = h('div', { class: 'catalog-get' });
    if (haveId) buttons.append(h('button', { type: 'button', class: 'btn small primary', onclick: () => navigate(`/read/${haveId}`) }, icon('play'), t('open')), h('span', { class: 'hint' }, t('inLibrary')));
    else if (!acqs.length && entryDocument(e)) buttons.append(h('button', { type: 'button', class: 'btn small tonal', onclick: () => navigate(feedPath(entryDocument(e)!)) }, icon('info'), t('details')));
    else for (const a of acqs) {
      const btn = h('button', { type: 'button', class: 'btn small tonal' }, icon('download'), a.label) as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        btn.disabled = true; const label = a.label;
        try {
          const book = await downloadToLibrary(e, a, (p) => { btn.textContent = p.total ? `${p.pct}% · ${fmtMB(p.got)} / ${fmtMB(p.total)}` : p.got ? fmtMB(p.got) : `${label}…`; });
          toast(t('addedToLibrary'));
          buttons.replaceChildren(h('button', { type: 'button', class: 'btn small primary', onclick: () => navigate(`/read/${book.id}`) }, icon('play'), t('open')), h('span', { class: 'hint' }, t('inLibrary')));
          have.set(keyOf(e.title, e.authors[0]), book.id);
        } catch (err) {
          btn.disabled = false; btn.replaceChildren(icon('download'), label);
          toast(describe(err), 'error');
        }
      });
      buttons.append(btn);
    }
    if (!acqs.length && !haveId && !entryDocument(e)) buttons.append(h('span', { class: 'hint' }, t('catalogNoFile')));
    const metaBits = [e.authors.join(', '), e.language, e.published ? e.published.slice(0, 4) : ''].filter(Boolean);
    return h('article', { class: 'catalog-book' },
      e.thumbnail ? h('img', { class: 'catalog-thumb', src: e.thumbnail, alt: '', loading: 'lazy' }) : h('span', { class: 'catalog-thumb blank' }, icon('file')),
      h('div', { class: 'catalog-book-text' },
        h('b', { dir: 'auto' }, e.title),
        metaBits.length ? h('small', { dir: 'auto' }, metaBits.join(' · ')) : null,
        e.summary ? h('p', { dir: 'auto' }, e.summary.length > 260 ? `${e.summary.slice(0, 260)}…` : e.summary) : null,
        e.categories.length ? h('small', { class: 'catalog-cats', dir: 'auto' }, e.categories.slice(0, 4).map((c) => `#${c}`).join('  ')) : null,
        buttons));
  }
}

/** The number of catalogues kept, for the library's menu. */
export function catalogCount(): string { return localDigits(getCatalogs().length); }
