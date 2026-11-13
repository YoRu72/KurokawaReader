// window.kurokawaHandover for the Tauri shell (stage R6a): the hand-over's reading half — the folder the last Electron
// build left found, checked, read file by file, what became of it kept, its space freed when the reader asks
// (src-tauri/src/handover.rs). The writing half is the Electron build's (desktop/preload.cjs, desktop/handover.cjs);
// the page's side is src/handover.ts. Run by main.rs after bridge.js, before the page's own scripts. Its own name, not
// one of kurokawaDesktop's, so the bridge keeps exactly the preload's names (tests/tauribridge.cjs).
(function () {
  'use strict';
  if (window.kurokawaHandover) return;
  function invoker() {
    var t = window.__TAURI__;
    if (t && t.core && typeof t.core.invoke === 'function') return function (c, a) { return t.core.invoke(c, a); };
    var i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return function (c, a) { return i.invoke(c, a); };
    return null;
  }
  function asError(e) { return e instanceof Error ? e : new Error(typeof e === 'string' ? e : (e && e.message) || String(e)); }
  function call(cmd, args) {
    var inv = invoker();
    if (!inv) return Promise.reject(new Error('Tauri IPC is not available'));
    try { return Promise.resolve(inv(cmd, args || {})).catch(function (e) { throw asError(e); }); } catch (e) { return Promise.reject(asError(e)); }
  }
  function toArrayBuffer(r) {
    if (r instanceof ArrayBuffer) return r;
    if (r && r.buffer instanceof ArrayBuffer && typeof r.byteLength === 'number') return r.buffer.slice(r.byteOffset || 0, (r.byteOffset || 0) + r.byteLength);
    if (Array.isArray(r)) return new Uint8Array(r).buffer;
    return new ArrayBuffer(0);
  }
  var api = {
    shell: 'tauri',
    // find(dir?) → { found, dir, marker, state, looked } | { found: false, state, looked, problems }: the folder the
    // reader picked (it, or its «handover» folder), else where the Electron build leaves it.
    find: function (dir) { return call('kr_handover_find', { p: dir ? String(dir) : null }); },
    // Every file's SHA-256 against the marker → { ok, bad }.
    verifyDir: function (dir) { return call('kr_handover_verify', { p: String(dir) }); },
    // One file of it → ArrayBuffer.
    read: function (dir, rel) { return call('kr_handover_read', { p: String(dir), rel: String(rel) }).then(toArrayBuffer); },
    // A piece of one file → ArrayBuffer (`len` bytes from `at`; fewer at its end): a large book brought piece by piece.
    readRange: function (dir, rel, at, len) { return call('kr_handover_read', { p: String(dir), rel: String(rel), at: Math.max(0, Math.floor(Number(at) || 0)), len: Math.max(1, Math.floor(Number(len) || 0)) }).then(toArrayBuffer); },
    // { id, state: 'restored' | 'declined', counts } kept → true.
    mark: function (o) { return call('kr_handover_mark', { o: o && typeof o === 'object' ? o : {} }); },
    // The hand-over folder deleted (the reader said yes) → { freed }.
    free: function (dir) { return call('kr_handover_free', { p: String(dir) }); },
    // The earlier (Electron) KurokawaReader started, where it is still installed beside this one → true / false.
    openOld: function () { return call('kr_handover_open_old', {}); },
  };
  try { Object.defineProperty(window, 'kurokawaHandover', { value: Object.freeze(api), enumerable: true, configurable: false, writable: false }); } catch (e) { /* defined already */ }
})();
