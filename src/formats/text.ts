// Plain text, Markdown and HTML.
import { marked } from 'marked';
import type { FlowHandler, FlowRender } from './types';
import { titleFromFileName } from './types';
import { collectImages, decodeText, el, markDirections, sanitize, textToParagraphs, tocFromHeadings } from './shared';

export const txtHandler: FlowHandler = {
  kind: 'flow',
  format: 'txt',
  async readMeta(file, fileName) {
    const text = await decodeText(file.slice(0, 4000));
    const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && l.length < 120);
    return { title: first && !/^[\W\d]+$/.test(first) ? first : titleFromFileName(fileName) };
  },
  async render(file): Promise<FlowRender> {
    const root = el('div', 'kr-content kr-text');
    textToParagraphs(await decodeText(file), root);
    const rtl = markDirections(root);
    return { element: root, toc: [], images: [], rtl, dispose: () => undefined };
  },
};

export const mdHandler: FlowHandler = {
  kind: 'flow',
  format: 'md',
  async readMeta(file, fileName) {
    const text = await decodeText(file.slice(0, 4000));
    const m = /^#\s+(.+)$/m.exec(text);
    return { title: m ? m[1].trim() : titleFromFileName(fileName) };
  },
  async render(file, ctx): Promise<FlowRender> {
    const root = el('div', 'kr-content kr-md');
    root.innerHTML = await marked.parse(await decodeText(file), { gfm: true, breaks: false });
    sanitize(root, false);
    const rtl = markDirections(root);
    return { element: root, toc: tocFromHeadings(root, ctx, 'md'), images: collectImages(root, ctx, 'md'), rtl, dispose: () => undefined };
  },
};

export const htmlHandler: FlowHandler = {
  kind: 'flow',
  format: 'html',
  async readMeta(file, fileName) {
    const text = await decodeText(file.slice(0, 20000));
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    return { title: m ? m[1].replace(/\s+/g, ' ').trim() : titleFromFileName(fileName) };
  },
  async render(file, ctx): Promise<FlowRender> {
    const doc = new DOMParser().parseFromString(await decodeText(file), 'text/html');
    const root = el('div', 'kr-content kr-html');
    const body = doc.body;
    body.querySelectorAll('img').forEach((img) => { if (!/^data:/i.test(img.getAttribute('src') ?? '')) img.remove(); });
    sanitize(body, false);
    while (body.firstChild) root.appendChild(body.firstChild);
    const rtl = markDirections(root);
    return { element: root, toc: tocFromHeadings(root, ctx, 'html'), images: collectImages(root, ctx, 'html'), rtl, dispose: () => undefined };
  },
};
