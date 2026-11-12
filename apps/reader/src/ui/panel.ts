// A sliding side panel with optional tabs.
import { h, iconButton, clear } from './dom';
import { t } from '../i18n';

export interface PanelTab { id: string; label: string; render(body: HTMLElement): void }

export class SidePanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private titleEl: HTMLElement;
  private scrim: HTMLElement;
  private tabs: PanelTab[] = [];
  private active = '';
  isOpen = false;
  /** Told when the panel is shut (its button, the scrim, Escape) — not when a docked panel stays open after a jump. */
  onClose?: () => void;
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.titleEl = h('h2');
    this.body = h('div', { class: 'panel-body' });
    this.tabsEl = h('div', { class: 'panel-tabs', role: 'tablist' });
    this.scrim = h('div', { class: 'scrim', hidden: true, onclick: () => this.close() });
    this.el = h('aside', { class: 'panel', role: 'dialog' },
      h('div', { class: 'handle' }),
      h('div', { class: 'panel-head' }, this.titleEl, iconButton('close', t('close'), () => this.close())),
      this.tabsEl, this.body);
    host.append(this.scrim, this.el);
  }

  /** On a computer wide enough, a panel opened `dock`ed (the contents, bookmarks, search) sits beside the page —
   *  no scrim, the text narrowed to make room — and stays open while reading; others float over it as before. */
  open(title: string, tabs: PanelTab[], activeId?: string, o: { dock?: boolean } = {}): void {
    this.titleEl.textContent = title;
    this.tabs = tabs;
    this.tabsEl.hidden = tabs.length <= 1;
    const dock = !!o.dock && SidePanel.canDock();
    this.el.classList.toggle('docked', dock); this.host.classList.toggle('panel-docked', dock);
    this.scrim.hidden = dock;
    this.el.classList.add('open');
    this.isOpen = true;
    this.show(activeId ?? tabs[0]?.id ?? '');
    // (Said aloud for the reader's keys — src/readkeys.ts: nothing is taken from the phone's keys while a panel is open.)
    document.dispatchEvent(new Event('kr:panel'));
  }

  show(id: string): void {
    this.active = id;
    clear(this.tabsEl);
    for (const tab of this.tabs) this.tabsEl.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab.id === id), onclick: () => this.show(tab.id) }, tab.label));
    clear(this.body);
    this.tabs.find((tb) => tb.id === id)?.render(this.body);
  }

  refresh(): void { if (this.isOpen) this.show(this.active); }

  close(): void {
    if (this.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const was = this.isOpen;
    this.el.classList.remove('open', 'docked'); this.host.classList.remove('panel-docked');
    this.scrim.hidden = true;
    this.isOpen = false;
    if (was) { this.onClose?.(); document.dispatchEvent(new Event('kr:panel')); }
  }

  /** After a jump from the panel (a chapter, a bookmark, a search hit): shut — unless it is docked beside the page. */
  dismiss(): void { if (!this.el.classList.contains('docked')) this.close(); }

  get docked(): boolean { return this.isOpen && this.el.classList.contains('docked'); }
  static canDock(): boolean { return document.documentElement.classList.contains('pc') && window.innerWidth >= 1000; }

  get bodyEl(): HTMLElement { return this.body; }
}
