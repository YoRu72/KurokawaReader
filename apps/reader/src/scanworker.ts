// A worker thread for the scanner: each message is one piece of picture work (see scanops.ts).
import { handle, type Op } from './scanops';

self.addEventListener('message', (e: MessageEvent<{ id: number; m: Op }>) => {
  const { id, m } = e.data;
  handle(m).then(
    ({ res, transfer }) => (self as unknown as Worker).postMessage({ id, ok: true, res }, transfer),
    (err) => (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) }),
  );
});
