// The little of libarchive.js's own worker sources (MIT; the library is libarchive, BSD 2-Clause) that
// src/comic/archive.worker.ts uses: the reader's wasm calls, and the emscripten module it runs on.
declare module 'libarchive.js/src/webworker/archive-reader.js' {
  interface RunCode {
    malloc(n: number): number; free(p: number): void;
    openArchive(ptr: number, len: number, passphrase: string | null, locale: string): number;
    closeArchive(a: number): void;
    getNextEntry(a: number): number;
    getFileData(a: number, size: number): number;
    skipEntry(a: number): number;
    getEntrySize(e: number): number; getEntryName(e: number): string; getEntryType(e: number): number;
    getError(a: number): string | null;
    hasEncryptedEntries(a: number): number;
    entryIsEncrypted(e: number): number;
  }
  export interface Wasm { HEAPU8: Uint8Array; runCode: RunCode; _free(p: number): void }
  export class ArchiveReader {
    constructor(wasm: Wasm);
    _wasmModule: Wasm; _runCode: RunCode; _archive: number | null; _filePtr: number | null; _fileLength: number;
  }
}
declare module 'libarchive.js/src/webworker/wasm-module.js' {
  import type { Wasm } from 'libarchive.js/src/webworker/archive-reader.js';
  export class WasmModule { locateFile?: (name: string) => string; initFunctions(): void }
  export type { Wasm };
}
declare module 'libarchive.js/src/webworker/wasm-gen/libarchive.js' {
  import type { WasmModule, Wasm } from 'libarchive.js/src/webworker/wasm-module.js';
  const libarchive: (m: WasmModule) => Promise<WasmModule & Wasm>;
  export default libarchive;
}
