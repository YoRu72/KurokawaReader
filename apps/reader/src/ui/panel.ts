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

  constructor(host: HTMLElement) {
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

  open(title: string, tabs: PanelTab[], activeId?: string): void {
    this.titleEl.textContent = title;
    this.tabs = tabs;
    this.tabsEl.hidden = tabs.length <= 1;
    this.scrim.hidden = false;
    this.el.classList.add('open');
    this.isOpen = true;
    this.show(activeId ?? tabs[0]?.id ?? '');
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
    this.el.classList.remove('open');
    this.scrim.hidden = true;
    this.isOpen = false;
  }

  get bodyEl(): HTMLElement { return this.body; }
}
