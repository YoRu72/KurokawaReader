declare module '*.css';
declare module '*.ttf';
declare const __APP_VERSION__: string;
/** The GitHub repository the build came from (owner/name): its releases, its Pages site. */
declare const __REPO_SLUG__: string;

declare module 'pako' { export function deflateRaw(d: Uint8Array, o?: { level?: number }): Uint8Array; const pako: { deflateRaw: typeof deflateRaw }; export default pako; }
