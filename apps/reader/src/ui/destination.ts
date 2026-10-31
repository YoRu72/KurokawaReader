// "Where should these books go?" — the library itself, one of the folders, or
// a new folder named on the spot. Used by both importers.
import { h, icon, openSheet } from './dom';
import { t } from '../i18n';
import type { Folder } from '../db';

export type Destination = { kind: 'library' } | { kind: 'folder'; id: string } | { kind: 'new'; name: string };

export function describeDestination(d: Destination, folders: Folder[]): string {
  if (d.kind === 'library') return t('destinationNone');
  if (d.kind === 'new') return `${t('newFolder')}: ${d.name}`;
  return folders.find((f) => f.id === d.id)?.name ?? t('destinationNone');
}

/** The radio list itself, for embedding in another sheet. `get()` resolves the choice (null when a new folder has no name yet). */
export function destinationList(folders: Folder[], current: Destination): { el: HTMLElement; get(): Destination | null; focusName(): void } {
    let choice: Destination = current;
    const nameInput = h('input', { type: 'text', placeholder: t('folderName'), dir: 'auto', style: { width: '100%', marginTop: '8px' } }) as HTMLInputElement;
    if (current.kind === 'new') nameInput.value = current.name;
    const rows: HTMLElement[] = [];
    const row = (label: string, iconName: string, d: Destination, extra?: HTMLElement) => {
      const on = () => (choice.kind === d.kind && (d.kind !== 'folder' || (choice as { id?: string }).id === d.id));
      const el = h('label', { class: 'dest-row' },
        h('input', { type: 'radio', name: 'kr-dest', checked: on(), onchange: () => { choice = d; rows.forEach((r) => r.classList.toggle('on', r === el)); if (d.kind === 'new') setTimeout(() => nameInput.focus(), 30); } }),
        icon(iconName), h('span', { class: 'name', dir: 'auto' }, label), extra ?? null);
      if (on()) el.classList.add('on');
      rows.push(el);
      return el;
    };
    const list = h('div', { class: 'dest-list' },
      row(t('destinationNone'), 'library', { kind: 'library' }),
      ...folders.map((f) => row(f.name, 'folder', { kind: 'folder', id: f.id })),
      row(t('destinationNew'), 'folderPlus', { kind: 'new', name: '' }, nameInput));
    nameInput.addEventListener('focus', () => { choice = { kind: 'new', name: nameInput.value }; rows.forEach((r) => r.classList.toggle('on', r.contains(nameInput))); (rows[rows.length - 1].querySelector('input[type=radio]') as HTMLInputElement).checked = true; });
    return {
      el: list,
      get: () => { if (choice.kind === 'new') { const name = nameInput.value.trim(); return name ? { kind: 'new', name } : null; } return choice; },
      focusName: () => nameInput.focus(),
    };
}

export function pickDestination(folders: Folder[], current: Destination, title = t('destination')): Promise<Destination | null> {
  return new Promise((resolve) => {
    const sheet = openSheet(title, t('close'));
    sheet.body.style.fontFamily = 'var(--font-ui)';
    const list = destinationList(folders, current);
    sheet.body.append(list.el);
    let done = false;
    const finish = (d: Destination | null) => { if (done) return; done = true; sheet.close(); resolve(d); };
    sheet.actions.append(h('button', { class: 'btn small primary', type: 'button', onclick: () => { const d = list.get(); if (!d) { list.focusName(); return; } finish(d); } }, icon('check'), t('done')));
    const obs = new MutationObserver(() => { if (!document.body.contains(sheet.el)) { obs.disconnect(); finish(null); } });
    obs.observe(document.body, { childList: true });
  });
}
