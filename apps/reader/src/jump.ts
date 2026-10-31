// A one-shot place to open a book at (a bookmark, a note, a chapter of its contents), set by the view that
// opens the book and taken by the reader: kept apart so those views need not load the reader to set it.
export interface Jump { bookId: string; kind: 'bm' | 'hl' | 'pin' | 'toc' | 'anchor'; id: string }
export function setJump(j: Jump): void { sessionStorage.setItem('kr.jump', JSON.stringify(j)); }
export function takeJump(): Jump | null { const raw = sessionStorage.getItem('kr.jump'); if (!raw) return null; sessionStorage.removeItem('kr.jump'); try { return JSON.parse(raw) as Jump; } catch { return null; } }
