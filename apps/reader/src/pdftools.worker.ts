// The PDF tools' work (pdf-lib: pages copied, pictures embedded, files decrypted) off the main thread — see the
// end of pdftools.ts, which sends the work here and runs it on the page when it cannot.
import { runHere } from './pdftools';
self.onmessage = async (e: MessageEvent<{ id: number; op: string; args: unknown[] }>) => {
  const { id, op, args } = e.data;
  try {
    const result = await runHere(op as Parameters<typeof runHere>[0], args, (n) => (self as unknown as Worker).postMessage({ id, progress: n }));
    const transfer = result instanceof Uint8Array && result.buffer instanceof ArrayBuffer && result.byteOffset === 0 && result.byteLength === result.buffer.byteLength ? [result.buffer] : [];
    (self as unknown as Worker).postMessage({ id, result }, transfer);
  } catch (err) { (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) }); }
};
