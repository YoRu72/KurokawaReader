// The sheet that moves a library novel to another source (see sources/migrate): every other extension the reader
// has searched for its title at once — a few at a time, each source's answers shown as they come — and the one
// tapped takes the novel's place, its reading carried over.
import { h, openSheet, toast, coverColors } from './dom';
import { t, localDigits } from '../i18n';
import type { Book } from '../db';
import type { SourceBook } from '../sources/types';

export async function migrateSheet(book: Book, done: (newSrc: string, newPath: string) => void): Promise<void> {
  const sh = openSheet(t('migrateTitle'), t('close'));
  sh.el.classList.add('migrate-sheet'); sh.body.style.fontFamily = 'var(--font-ui)';
  const q = h('input', { type: 'search', class: 'src-search', value: book.title, dir: 'auto', placeholder: t('migrateSearch') }) as HTMLInputElement;
  const list = h('div', { class: 'migrate-list' });
  sh.body.append(h('p', { class: 'hint' }, t('migrateAbout')), h('form', { class: 'gs-form', onsubmit: (e: Event) => { e.preventDefault(); void run(); } }, q), list);
  const [{ listRepos, installedItems }, ext, { pool }] = await Promise.all([import('../sources/repos'), import('../sources/ext/source'), import('../sources/http')]);
  let token = 0;
  const run = async () => {
    const my = ++token; const words = q.value.trim(); if (!words) return;
    list.replaceChildren();
    const repos = await listRepos().catch(() => []);
    const sources: { id: string; name: string }[] = [];
    for (const r of repos) if (r.kind !== 'folder') for (const i of installedItems(r).filter((x) => x.runnable)) { const id = ext.sourceIdOf(r, i); if (id !== book.remote?.source) sources.push({ id, name: i.name }); }
    if (!sources.length) { list.append(h('p', { class: 'src' }, t('migrateNoSources'))); return; }
    await pool(sources, 3, async (s) => {
      const sec = h('section', { class: 'migrate-src' }, h('h4', null, s.name), h('div', { class: 'spinner small' }));
      list.append(sec);
      let items: SourceBook[] = [];
      try { const hnd = await ext.extHandle(s.id); const f = Object.fromEntries(hnd.source.filters().map((x) => [x.id, x.value])); items = (await hnd.source.browse(words, f, 1)).items.slice(0, 6); }
      catch (e) { if (my === token) sec.replaceChildren(h('h4', null, s.name), h('p', { class: 'src' }, t('migrateSourceFailed'))); void e; return; }
      if (my !== token) return;
      if (!items.length) { sec.remove(); return; }
      sec.replaceChildren(h('h4', null, s.name), h('div', { class: 'migrate-hits' }, ...items.map((b) => {
        const [c1, c2] = coverColors(b.title);
        return h('button', { type: 'button', class: 'migrate-hit', onclick: () => void pick(s, b) },
          h('span', { class: 'migrate-cover', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }, b.cover ? h('img', { src: b.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null),
          h('span', { class: 'migrate-name', dir: 'auto' }, b.title));
      })));
    });
    if (my === token && !list.children.length) list.append(h('p', { class: 'src' }, t('noResults')));
  };
  const pick = async (s: { id: string; name: string }, b: SourceBook) => {
    if (!confirm(t('migrateConfirm', { title: b.title, source: s.name }))) return;
    sh.body.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('migrating')));
    try {
      const { migrateNovel } = await import('../sources/migrate');
      const r = await migrateNovel(book, s.id, b.id);
      sh.close();
      toast(t('migrated', { source: s.name, n: localDigits(r.mapped), total: localDigits(r.total) }) + (r.at ? ` · ${r.at}` : ''), 'info', 6000);
      done(s.id, b.id);
    } catch (e) { sh.close(); toast(String((e as Error)?.message ?? e), 'error', 5000); }
  };
  void run();
}
