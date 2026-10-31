// The PDF text layer's layout, off the main thread: pdf.js's text items in, the boxes of the words out (see
// planTextLayer in src/pdflayer.ts), or a page's text in reading order for searching. The page keeps
// scrolling while a page's words are worked out.
import { planTextLayer, readingTextFromItems, type PlanViewport } from './pdflayer';

type Item = { str: string; transform: number[]; width: number; height: number; dir?: string; fontName?: string };
self.onmessage = (e: MessageEvent<{ id: number; op?: 'text'; items: Item[]; viewport: PlanViewport; laid?: PlanViewport }>) => {
  const { id, op, items, viewport, laid } = e.data;
  try {
    if (op === 'text') self.postMessage({ id, text: readingTextFromItems(items, viewport) });
    else self.postMessage({ id, plan: planTextLayer(items, viewport, laid ?? viewport) });
  } catch (err) { self.postMessage({ id, error: String((err as Error)?.message ?? err) }); }
};
