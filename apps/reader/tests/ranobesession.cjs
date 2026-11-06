// A sign-in made on the site in the app's browser is taken up: the browser and the app's requests share one cookie
// jar, so the site's session endpoint answers with the user — the source marks itself signed in, with the email the
// site gives, and the account no longer asks for the form. Without that session, it stays signed out.
const { chromium } = require('playwright'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
(async () => {
  const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..'), path.join(__dirname, '..', '..', '..')] }));
  const out = path.join(os.tmpdir(), `rn-${process.pid}.js`);
  const stub = { name: 'stub-http', setup(b) { b.onResolve({ filter: /^\.\/http$/ }, () => ({ path: 'stub-http', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function request(url, init) { return window.__site(url, init); } export async function openBrowser(u) { window.__opened = u; window.__signInOnSite && window.__signInOnSite(); }', loader: 'js' })); } };
  await esbuild.build({ stdin: { contents: "import * as r from './src/sources/ranobe'; (window as any).__rn = r;", resolveDir: path.join(__dirname, '..'), loader: 'ts' }, bundle: true, outfile: out, format: 'iife', plugins: [stub], logLevel: 'silent' });
  const br = await chromium.launch(); const p = await br.newPage(); const errors = []; const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('https://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title><body></body>' })); await p.goto('https://app.test/');
  await p.evaluate(() => { window.__session = null; window.__site = async (url) => { if (url.endsWith('/api/auth/get-session')) return { status: 200, url, headers: {}, body: JSON.stringify(window.__session) }; return { status: 404, url, headers: {}, body: '' }; }; });
  await p.addScriptTag({ content: fs.readFileSync(out, 'utf8') });
  const repo = { key: 'rn', name: 'Ranobe', url: 'https://site.test' };
  check('no session: stays signed out', await p.evaluate(async (repo) => !(await window.__rn.adoptSession(repo)) && !window.__rn.signedIn(repo), repo));
  // signing in on the site, in the browser: the session the site set now answers
  await p.evaluate(() => { window.__signInOnSite = () => { window.__session = { session: { id: 's' }, user: { email: 'reader@example.com' } }; }; });
  check('signing in on the site is taken up', await p.evaluate(async (repo) => (await window.__rn.signInOnSite(repo)) && window.__rn.signedIn(repo) && window.__opened === 'https://site.test/', repo));
  check('the email comes from the site', await p.evaluate((repo) => localStorage.getItem(`kr.ranobe.${repo.key}.email`) === 'reader@example.com', repo));
  // a session made in the browser earlier, the mark lost: picked up without a sign-in
  await p.evaluate((repo) => localStorage.removeItem(`kr.ranobe.${repo.key}.in`), repo);
  check('an earlier browser session is picked up on its own', await p.evaluate(async (repo) => (await window.__rn.adoptSession(repo)) && window.__rn.signedIn(repo), repo));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed'); await br.close(); fs.rmSync(out, { force: true }); process.exit(errors.length ? 1 : 0);
})();
