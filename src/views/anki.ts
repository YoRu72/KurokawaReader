// Anki deck view: an overview with today's counts, a study screen (front → answer →
// Again / Hard / Good / Easy), and a card browser. Cards render inside a shadow root
// so each note type's own CSS applies without touching the app.
import { h, icon, iconButton, toast, clear, openSheet, pickSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { db, type Book } from '../db';
import { navigate } from '../router';
import { getSettings, pageIsLight } from '../settings';
import { scheduleSync } from '../sync';
import { ReadingTracker } from '../stats';
import { openDeck, loadProgress, saveProgress, buildQueue, nextCard, schedule, dueLabel, renderCard, attachMedia, soundUrl, noteSummary, today, type Deck, type Card, type Grade, type Progress } from '../anki';

export async function mountAnki(root: HTMLElement, book: Book, onDispose: (fn: () => void) => void): Promise<void> {
  const title = h('div', { class: 'title', dir: 'auto' }, book.title, h('small', null, t('ankiDeck')));
  const topbar = h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/')), title,
    iconButton('search', t('ankiBrowse'), () => browse()),
    iconButton('settings', t('ankiOptions'), () => options()));
  const main = h('div', { class: 'anki-main' });
  root.append(topbar, main);
  main.append(h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('loading')));
  const file = await db.getFile(book.id);
  if (!file) { toast(t('linkedFileMissing', { title: book.title }), 'error', 5000); navigate('/', true); return; }
  let deck: Deck;
  try { deck = await openDeck(book.id, file); } catch (err) { clear(main); main.append(h('p', { class: 'center' }, t('openError', { error: String((err as Error).message ?? err) }))); return; }
  let p = await loadProgress(book.id);
  // Study time counts in the reading statistics while the study screen is up.
  let studying = false;
  const tracker = new ReadingTracker(book, () => studying);
  tracker.start();
  onDispose(() => void tracker.stop());
  const urls = new Map<string, string>();
  onDispose(() => { urls.forEach((u) => URL.revokeObjectURL(u)); audio?.pause(); });
  const night = () => !pageIsLight(getSettings()) || document.documentElement.dataset.ui === 'dark';
  let audio: HTMLAudioElement | null = null;
  const play = async (name: string) => { const u = await soundUrl(deck, name, urls); if (!u) return; audio?.pause(); audio = new Audio(u); void audio.play().catch(() => {}); };

  const persist = async () => {
    await saveProgress(book.id, p);
    const studied = Object.keys(p.cards).length;
    const pct = deck.cards.length ? studied / deck.cards.length : 0;
    tracker.advance(0, pct);
    await db.updateBook(book.id, (b) => { b.progress = { bookId: book.id, pct }; b.progressAt = Date.now(); b.lastOpenedAt = Date.now(); });
    scheduleSync();
  };

  /* ---------- overview ---------- */
  function overview() {
    studying = false;
    clear(main);
    const q = buildQueue(deck, p);
    const learnNow = q.learning.filter((c) => p.cards[c.id].due <= Date.now()).length;
    const studied = Object.keys(p.cards).length;
    const mature = Object.values(p.cards).filter((s) => s.s === 2 && s.ivl >= 21).length;
    const subdecks = [...new Set(deck.cards.map((c) => c.did))].filter((id) => deck.decks.has(id));
    const count = (n: number, label: string, cls: string) => h('div', { class: `anki-count ${cls}` }, h('b', null, localDigits(n)), h('span', null, label));
    const nothing = !q.fresh.length && !q.review.length && !q.learning.length;
    main.append(h('section', { class: 'anki-overview' },
      h('h2', { dir: 'auto' }, p.deckFilter != null ? (deck.decks.get(p.deckFilter) ?? deck.name) : deck.name),
      h('div', { class: 'anki-counts' }, count(q.fresh.length, t('ankiNew'), 'new'), count(learnNow || q.learning.length, t('ankiLearning'), 'learn'), count(q.review.length, t('ankiReview'), 'rev')),
      nothing ? h('p', { class: 'src' }, t('ankiDoneToday')) : null,
      h('button', { class: 'btn primary anki-study', type: 'button', disabled: nothing, onclick: () => study() }, icon('play'), t('ankiStudy')),
      subdecks.length > 1 ? h('button', { class: 'btn small', type: 'button', onclick: () => pickSheet(t('ankiSubdeck'), [['all', deck.name, 'library'], ...subdecks.map((id): [string, string, string] => [String(id), deck.decks.get(id)!.split('::').slice(1).join(' › ') || deck.decks.get(id)!, 'books'])], p.deckFilter == null ? 'all' : String(p.deckFilter), (v) => { p.deckFilter = v === 'all' ? null : Number(v); void saveProgress(book.id, p); overview(); }, t('close')) }, icon('folder'), t('ankiSubdeck')) : null,
      h('div', { class: 'anki-stats' },
        h('span', null, t('ankiTotal', { n: deck.cards.length })),
        h('span', null, t('ankiStudied', { n: studied })),
        h('span', null, t('ankiMature', { n: mature }))),
    ));
  }

  /* ---------- study ---------- */
  function study() {
    studying = true;
    clear(main);
    let q = buildQueue(deck, p);
    let card: Card | null = null; let side: 'q' | 'a' = 'q';
    const host = h('div', { class: 'anki-card-host' });
    const shadow = host.attachShadow({ mode: 'open' });
    const counter = h('div', { class: 'anki-mini-counts' });
    const bar = h('div', { class: 'anki-bar' });
    main.append(counter, host, bar);
    const paintCounts = () => { counter.replaceChildren(h('b', { class: 'new' }, localDigits(q.fresh.length)), h('b', { class: 'learn' }, localDigits(q.learning.length)), h('b', { class: 'rev' }, localDigits(q.review.length))); };
    const show = async () => {
      if (!card) return;
      const r = renderCard(deck, card, side, night());
      const style = `:host{display:block}.card{font-family:var(--font-read, serif);font-size:22px;text-align:center;color:${night() ? '#e8e6e3' : '#1d1b18'};padding:18px 14px;line-height:1.5}.card img{max-width:100%;height:auto}ruby rt{font-size:.55em}.anki-sound{border:0;border-radius:50%;width:38px;height:38px;margin:4px;background:#8885;color:inherit;font-size:15px;cursor:pointer}.cloze{font-weight:bold;color:#3b82f6}.nightMode .cloze{color:#93c5fd}hr#answer{border:0;border-top:1px solid #8886;margin:16px 0}a.hint{color:#3b82f6}`;
      shadow.innerHTML = `<style>${style}\n${r.css}</style>${r.html}`;
      await attachMedia(deck, shadow, urls);
      shadow.querySelectorAll<HTMLButtonElement>('.anki-sound').forEach((b) => b.addEventListener('click', () => void play(b.dataset.sound!)));
      shadow.querySelectorAll<HTMLAnchorElement>('a.hint').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const t2 = shadow.getElementById(a.dataset.hint!); if (t2) { t2.hidden = false; a.remove(); } }));
      if (p.autoplay && r.sounds.length) void play(side === 'q' ? r.sounds[0] : (r.sounds.find((s) => !renderCard(deck, card!, 'q', false).sounds.includes(s)) ?? r.sounds[0]));
      paintBar();
      host.scrollTop = 0;
    };
    const paintBar = () => {
      clear(bar);
      if (!card) return;
      if (side === 'q') { bar.append(h('button', { class: 'btn primary anki-show', type: 'button', onclick: () => { side = 'a'; void show(); } }, t('ankiShowAnswer'))); return; }
      const st = p.cards[card.id];
      const grade = (g: Grade, label: string, cls: string) => { const next = schedule(st, g); return h('button', { class: `anki-grade ${cls}`, type: 'button', onclick: () => void answer(g) }, h('small', null, dueLabel(next)), h('span', null, label)); };
      bar.append(grade(1, t('ankiAgain'), 'again'), grade(2, t('ankiHard'), 'hard'), grade(3, t('ankiGood'), 'good'), grade(4, t('ankiEasy'), 'easy'));
    };
    const answer = async (g: Grade) => {
      if (!card) return;
      const wasNew = !p.cards[card.id];
      const wasReview = p.cards[card.id]?.s === 2;
      p.cards[card.id] = schedule(p.cards[card.id], g);
      if (wasNew) p.newToday++;
      if (wasReview) p.reviewsToday++;
      await persist();
      advance();
    };
    const advance = () => {
      q = buildQueue(deck, p);
      paintCounts();
      card = nextCard(q, p);
      side = 'q';
      if (!card) { toast(t('ankiDoneToday')); overview(); return; }
      void show();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!host.isConnected) { window.removeEventListener('keydown', onKey); return; }
      if ((e.target as HTMLElement).matches('input, textarea')) return;
      if (side === 'q' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); side = 'a'; void show(); return; }
      if (side === 'a' && /^[1-4]$/.test(e.key)) { e.preventDefault(); void answer(Number(e.key) as Grade); return; }
      if (side === 'a' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); void answer(3); return; }
      if (e.key === 'r' && card) { const r = renderCard(deck, card, side, false); if (r.sounds[0]) void play(r.sounds[0]); }
      if (e.key === 'Escape') { window.removeEventListener('keydown', onKey); overview(); }
    };
    window.addEventListener('keydown', onKey);
    onDispose(() => window.removeEventListener('keydown', onKey));
    advance();
  }

  /* ---------- browse ---------- */
  function browse() {
    const sh = openSheet(t('ankiBrowse'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    const input = h('input', { type: 'search', placeholder: t('searchPlaceholder'), style: { width: '100%' } }) as HTMLInputElement;
    const list = h('ul', { class: 'plain-list' });
    sh.body.append(input, list);
    const notes = [...deck.notes.values()].map((n) => ({ n, s: noteSummary(deck, n), all: n.fields.join(' ').replace(/<[^>]*>/g, ' ').toLowerCase() }));
    const draw = () => {
      clear(list);
      const q = input.value.trim().toLowerCase();
      const hits = (q ? notes.filter((x) => x.all.includes(q)) : notes).slice(0, 300);
      for (const x of hits) {
        const c = deck.cards.find((cd) => cd.nid === x.n.id);
        const st = c ? p.cards[c.id] : undefined;
        list.append(h('li', null, h('button', { type: 'button', onclick: () => { if (c) preview(c); } }, h('span', { dir: 'auto', style: { flex: '1' } }, x.s || '—'), h('small', { style: { color: 'var(--md-on-surface-dim)' } }, st ? (st.s === 2 ? `${st.ivl}d` : t('ankiLearning')) : t('ankiNew')))));
      }
    };
    input.addEventListener('input', draw); draw();
  }
  function preview(card: Card) {
    const sh = openSheet(t('ankiPreview'), t('close'), { stack: true });
    const host = h('div', { class: 'anki-card-host small' }); const shadow = host.attachShadow({ mode: 'open' });
    sh.body.append(host);
    const r = renderCard(deck, card, 'a', night());
    shadow.innerHTML = `<style>.card{font-size:19px;text-align:center;color:${night() ? '#e8e6e3' : '#1d1b18'}}img{max-width:100%}${r.css}</style>${r.html}`;
    void attachMedia(deck, shadow, urls);
    shadow.querySelectorAll<HTMLButtonElement>('.anki-sound').forEach((b) => b.addEventListener('click', () => void play(b.dataset.sound!)));
    sh.actions.append(h('button', { class: 'btn small', type: 'button', onclick: async () => { delete p.cards[card.id]; await persist(); sh.close(); toast(t('ankiReset')); } }, icon('undo'), t('ankiForget')));
  }

  /* ---------- options ---------- */
  function options() {
    const sh = openSheet(t('ankiOptions'), t('close'));
    sh.body.style.fontFamily = 'var(--font-ui)';
    const perDay = h('input', { type: 'number', min: '0', max: '9999', value: String(p.newPerDay), dir: 'ltr', style: { width: '6em' } }) as HTMLInputElement;
    const auto = h('input', { type: 'checkbox' }) as HTMLInputElement; auto.checked = p.autoplay;
    sh.body.append(
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('ankiNewPerDay')), perDay),
      h('label', { class: 'row' }, h('span', { class: 'label' }, t('ankiAutoplay')), h('span', { class: 'switch' }, auto, h('i'))),
      h('p', { class: 'hint' }, t('ankiOptionsHint')),
    );
    sh.actions.append(
      h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (!confirm(t('ankiResetConfirm'))) return; p = { ...p, cards: {}, newToday: 0, reviewsToday: 0, day: today() }; await persist(); sh.close(); overview(); } }, icon('trash'), t('ankiResetAll')),
      h('button', { class: 'btn small primary', type: 'button', onclick: async () => { p.newPerDay = Math.max(0, Number(perDay.value) || 0); p.autoplay = auto.checked; await saveProgress(book.id, p); sh.close(); overview(); } }, icon('check'), t('done')),
    );
  }

  await persist().catch(() => {});
  overview();
  void (p satisfies Progress);
}
