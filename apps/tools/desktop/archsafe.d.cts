// Types of archsafe.cjs for the page (src/archives/safety.ts): the one name table and the pre-flight's decisions.
export type Platform = 'linux' | 'android' | 'android-fat' | 'macos' | 'windows';
export interface Verdict { action: 'allow' | 'rewrite' | 'refuse'; out: string; reasons: string[]; flags: string[] }
export interface Problem { kind: string; severity: 'block' | 'inPlace' | 'ask' | 'info'; count: number; names: string[]; fix?: string; methods?: number[]; kinds?: string[]; rewrites?: { from: string; to: string; reasons: string[] }[]; ratio?: number; total?: number; packed?: number }
export interface Space { free: number; normal: number; inPlace: number; margin: number; sameVolume: boolean; fitsNormal: boolean; fitsInPlace: boolean }
export interface Report { ok: boolean; files: number; total: number; problems: Problem[]; rewrites: { from: string; to: string; reasons: string[] }[]; space: Space; normal: { ok: boolean; why: string[] }; inPlace: { ok: boolean; why: string[] }; recommend: 'normal' | 'inPlace' | 'none'; why: string }
export interface Facts { format: string; platform: Platform; entries: { path: string; dir?: boolean; method?: number; encrypted?: boolean; csize?: number; usize?: number; offset?: number; unitBytes?: number; link?: string; target?: string }[]; supported?: number[]; external?: number[]; encrypted?: boolean; password?: string; damaged?: string[]; layoutBad?: string[]; volumes?: { missing: string[]; odd: string[] } | null; archiveWritable?: boolean; destWritable?: boolean; saf?: boolean; sameVolume?: boolean; free: number; existing?: string[]; busy?: boolean; destLen?: number; inPlaceFormat?: boolean; tailBytes?: number; blockSize?: number }
export declare const SPEC: { replacement: string; tempSuffix: string; asideDir: string; portableIllegal: string; reservedNames: string[] };
export declare function pathRule(path: string, platform: Platform, destLen?: number): Verdict;
export declare function nameRule(comp: string, platform: Platform): Verdict;
export declare function preflight(f: Facts, o?: { margin?: number }): Report;
export declare function keepBothName(name: string, taken: (n: string) => boolean, dir?: boolean): string;
export declare function conflictChoice(answers: Answers | undefined, path: string, isDir: boolean): Choice | null;
export type Choice = 'replace' | 'skip' | 'both';
export interface Answers { default?: Choice; files?: Choice; folders?: Choice; per?: Record<string, Choice> }
