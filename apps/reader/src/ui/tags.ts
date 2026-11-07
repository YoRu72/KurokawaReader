// A book's tags, from anywhere: the tags in the library ticked on or off, a new one typed. (The library view has
// its own copy of this list; this one stands alone for the book's page.)
import { h, icon, openSheet } from './dom';
import { t, localDigits } from '../i18n';
import { db, FAV_TAG, type Book, type TagDef } from '../db';

export function tagsSheetFor(book: Book, onChange: () => void): void {
  const s = openSheet(t('tags'), t('close'), { stack: true });
  s.body.style.fontFamily = 'var(--font-ui)'; s.body.style.fontSize = '14px';
  const list = h('div', { class: 'dest-list' });
  const input = h('input', { type: 'text', placeholder: t('newTag'), dir: 'auto', style: { flex: '1' } }) as HTMLInputElement;
  let defs: TagDef[] = []; let counts = new Map<string, number>();
  const load = async () => {
    defs = (await db.getMeta<TagDef[]>('tags')) ?? [];
    counts = new Map<string, number>(); for (const d of defs) counts.set(d.name, 0);
    for (const b of await db.allBooks()) for (const n of b.tags ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
  };
  const set = async (name: string, on: boolean) => {
    if (on && name !== FAV_TAG && !defs.some((d) => d.name === name)) { defs = [...defs, { name, createdAt: Date.now() }]; await db.setMeta('tags', defs); }
    const next = new Set(book.tags ?? []); if (on) next.add(name); else next.delete(name);
    const tags = [...next]; const at = Date.now();
    await db.updateBook(book.id, (b) => { if (tags.length) b.tags = tags; else delete b.tags; b.tagsAt = at; });
    if (tags.length) book.tags = tags; else delete book.tags; book.tagsAt = at;
    void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined);
    onChange(); await load(); draw();
  };
  const draw = () => {
    const names = [FAV_TAG, ...[...counts.keys()].filter((n) => n !== FAV_TAG).sort((a, b) => a.localeCompare(b))];
    list.replaceChildren(...names.map((name) => {
      const on = (book.tags ?? []).includes(name);
      return h('label', { class: 'dest-row' + (on ? ' on' : '') },
        h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => void set(name, (e.target as HTMLInputElement).checked) }),
        icon(name === FAV_TAG ? 'heartFill' : 'tag'),
        h('span', { class: 'name', dir: 'auto' }, name === FAV_TAG ? t('favorites') : name, h('span', { style: { color: 'var(--md-on-surface-dim)', fontSize: '12px' } }, ` · ${localDigits(String(counts.get(name) ?? 0))}`)));
    }));
  };
  s.body.append(h('form', { onsubmit: (e: Event) => { e.preventDefault(); const name = input.value.trim(); if (!name) return; input.value = ''; void set(name, true); }, style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, input, h('button', { class: 'btn primary small', type: 'submit' }, icon('plus'), t('addTag'))), list);
  s.actions.append(h('button', { class: 'btn primary small', type: 'button', onclick: () => s.close() }, icon('check'), t('done')));
  void load().then(draw);
}

/** Hold (touch) or right-click (mouse) on an element to run `fn`; a plain tap is left alone. */
// After a hold: the click on letting go, and a phone's «contextmenu» for the same hold, belong to the hold — dropped
// wherever they land, since what the hold did (a selection, a sheet) often redraws the very element held.
let heldAt = 0; let heldUp = false; let watching = false;
function swallowAfterHold(): void {
  if (watching) return; watching = true;
  const recent = () => heldAt && performance.now() - heldAt < 1500;
  document.addEventListener('pointerup', () => { if (recent()) heldUp = true; }, true);
  document.addEventListener('click', (e) => { if (recent() && heldUp) { e.preventDefault(); e.stopImmediatePropagation(); heldAt = 0; heldUp = false; } }, true);
  document.addEventListener('contextmenu', (e) => { if (recent() && !heldUp) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  document.addEventListener('pointerdown', () => { heldAt = 0; heldUp = false; }, true);
}

export function onHoldOrContext(el: HTMLElement, fn: () => void): void {
  // (One hold, one call: the timer's end or a «contextmenu», whichever comes first.)
  swallowAfterHold();
  let timer = 0;
  const cancel = () => { window.clearTimeout(timer); timer = 0; };
  const fire = () => { cancel(); heldAt = performance.now(); heldUp = false; fn(); };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; cancel(); timer = window.setTimeout(() => { navigator.vibrate?.(15); fire(); }, 480); });
  el.addEventListener('pointerup', cancel); el.addEventListener('pointerleave', cancel); el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); fn(); } });
}
