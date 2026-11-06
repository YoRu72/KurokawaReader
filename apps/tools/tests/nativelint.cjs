// Mistakes in the Java that compile and fail quietly at run time: JSArray.from() with a JSONArray (Capacitor's from()
// takes a Java array only and gives null otherwise — the Installed apps and the cookie jars came empty).
const fs = require('node:fs'); const path = require('node:path');
const dir = path.join(__dirname, '..', 'native', 'android'); const bad = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.java'))) fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((l, i) => { if (/JSArray\.from\(/.test(l)) bad.push(`${f}:${i + 1} JSArray.from()`); });
for (const b of bad) console.log('FAIL', b);
console.log(bad.length ? 'errors' : 'all passed'); process.exit(bad.length ? 1 : 0);
