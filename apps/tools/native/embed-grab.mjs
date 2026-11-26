// Puts native/grab.js into the places that carry it as text: KtBrowserActivity.java (GRAB_JS). The Rust shell reads
// grab.js itself (desktop-tauri/src-tauri/src/grab.js, which tests/tauribridge.cjs keeps equal to native/grab.js). Run after
// changing grab.js: node native/embed-grab.mjs (tests/grabjs.cjs checks they match).
import { readFileSync, writeFileSync } from 'node:fs';
const here = new URL('.', import.meta.url);
export const grabSource = () => readFileSync(new URL('grab.js', here), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).filter(Boolean).join('\n');
export const javaLine = () => `    static final String GRAB_JS = ${JSON.stringify(grabSource())};`;
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const j = new URL('android/KtBrowserActivity.java', here); let k = readFileSync(j, 'utf8'); k = k.replace(/^ {4}static final String GRAB_JS = .*$/m, () => javaLine()); writeFileSync(j, k);
  console.log('embedded');
}
