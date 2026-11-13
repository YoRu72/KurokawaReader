// The library's hand-over to the Rust (Tauri) build — PLACEHOLDER (stage R6b). Stage R6a owns this file and replaces it
// whole. main.cjs's switch (RUST_SWITCH) calls `await handover.prepare({ app, win, version })` before it downloads the
// Tauri build, and goes on only when it resolves { ok: true }; { ok: false, reason } or a throw stops the switch and
// the Electron app keeps working, saying why. It must never delete or change the Electron profile's data.
'use strict';

/** Make the library ready for the Tauri build (R6a: the hand-over backup). Placeholder: nothing to do. */
async function prepare(_ctx) {
  return { ok: true, placeholder: true };
}

module.exports = { prepare };
