// Put first in pdf.js (the main build, in every bundle that has it, and the worker) by scripts/patch-pdfjs.mjs:
// `for await (… of aReadableStream)` where the engine cannot do it. pdf.js 6 reads a page's text so
// (PDFPageProxy.getTextContent) and inflates with DecompressionStream so; WebKit has no async iteration of a
// ReadableStream (macOS 26 / Safari 27.2 and WebKitGTK 2.50 in the Tauri shell's R1 engine test: «undefined is not a
// function (near '...i of e...')»), so there the PDF's text layer, its search and PDF → Word all stopped at the first
// page. Defined only where missing: an engine that has its own (Chromium, Firefox) keeps it.
(function () {
  if (typeof ReadableStream === 'undefined' || typeof Symbol === 'undefined' || !Symbol.asyncIterator) return;
  var P = ReadableStream.prototype;
  if (typeof P[Symbol.asyncIterator] === 'function') return;
  // (As the Streams standard has it: a reader held while iterating, let go at the end; leaving the loop early —
  // `break`, `return`, a throw — cancels the stream unless asked not to.)
  function values(opts) {
    var preventCancel = !!(opts && opts.preventCancel);
    var reader = this.getReader(), finished = false;
    var release = function () { try { reader.releaseLock(); } catch (e) { /* already */ } };
    var it = {
      next: function () {
        if (finished) return Promise.resolve({ value: undefined, done: true });
        return reader.read().then(function (r) {
          if (r.done) { finished = true; release(); return { value: undefined, done: true }; }
          return { value: r.value, done: false };
        }, function (e) { finished = true; release(); throw e; });
      },
      return: function (value) {
        if (finished) return Promise.resolve({ value: value, done: true });
        finished = true;
        var p = preventCancel ? Promise.resolve() : reader.cancel(value);
        return p.then(function () { release(); return { value: value, done: true }; }, function (e) { release(); throw e; });
      },
    };
    it[Symbol.asyncIterator] = function () { return this; };
    return it;
  }
  if (typeof P.values !== 'function') Object.defineProperty(P, 'values', { value: values, writable: true, configurable: true });
  Object.defineProperty(P, Symbol.asyncIterator, { value: P.values, writable: true, configurable: true });
  try { Object.defineProperty(globalThis, '__krStreamIterPolyfill', { value: true, configurable: true }); } catch (e) { /* a mark only */ }
})();
