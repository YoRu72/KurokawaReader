// The library's hand-over from the Electron build to the Tauri one — PLACEHOLDER (stage R6b). Stage R6a owns this file
// and replaces it whole: it makes the hand-over backup on the Electron side (desktop/handover.cjs `prepare()`) and
// restores it here. The first-run screen (src/ui/firstrun.ts) calls `restore()` and shows what it answers:
//   { ok: true, books?: n }      → «Your library is here.»
//   { ok: false, none: true }    → «No library from an earlier version was found on this computer.»
//   { ok: false, reason: '…' }   → «The library could not be brought over: … The earlier version's data is untouched.»
// It must never delete or change the earlier version's data.
export interface HandoverResult { ok: boolean; none?: boolean; reason?: string; books?: number }

/** Bring the library over from the earlier (Electron) version on this computer. Placeholder: finds nothing. */
export async function restore(): Promise<HandoverResult> {
  return { ok: false, none: true };
}
