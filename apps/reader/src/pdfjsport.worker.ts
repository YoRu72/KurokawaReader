// pdf.js's own worker for a lane of the PDF → Word converter (src/pdf2docx.lane.ts), started by the page — not by
// the lane: under Windows' WebView2 (the Tauri shell) a worker cannot start a worker, and the lanes gave up there.
// The page gives this worker one end of a MessageChannel and the lane the other; pdf.js talks over it as it would
// over a worker it made itself (pdf.js's PDFWorker({ port }) on the lane's side, WorkerMessageHandler
// .initializeFromPort here). (Loaded by its address, not bundled: the patched pdf.js worker is a file of its own.)
const ctx = self as unknown as Worker;
ctx.addEventListener('message', (e: MessageEvent<{ krPort?: MessagePort }>) => {
  const port = e.data?.krPort; if (!port) return;
  import(/* the patched worker, built apart */ new URL('./pdf.worker.min.mjs', import.meta.url).href).then(
    (m: { WorkerMessageHandler: { initializeFromPort(p: MessagePort): void } }) => { m.WorkerMessageHandler.initializeFromPort(port); port.start(); ctx.postMessage({ krPdfjs: 'ready' }); },
    (err: unknown) => ctx.postMessage({ krPdfjs: 'failed', message: String((err as Error)?.message ?? err) }),
  );
});
