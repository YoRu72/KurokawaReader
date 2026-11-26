#!/usr/bin/env node
// node scripts/find-green-preflight.test.mjs — find-green-preflight.mjs on a made-up git repository (a base commit, a work branch
// and its merge) and a made-up GitHub API. No network, nothing of the real repository touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findGreen, fullAppsOf, signature } from './find-green-preflight.mjs';

let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra ?? ''))); if (!cond) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-green-'));
const git = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }); if (r.status !== 0) throw new Error(a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
const put = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
git('init', '-q', '-b', 'main');
put('apps/reader/a.txt', '1'); put('apps/tools/t.txt', '1'); put('shared/s.txt', '1'); put('repo/r.txt', '1'); put('.github/actions/x/action.yml', '1'); put('.github/workflows/release.yml', 'chain 1'); put('.github/workflows/release-tools.yml', 'chain 1');
git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
git('checkout', '-q', '-b', 'work-x'); put('apps/reader/a.txt', '2'); git('add', '-A'); git('commit', '-qm', 'work'); const work = git('rev-parse', 'HEAD');
git('checkout', '-q', 'main'); put('apps/tools/t.txt', '2'); git('add', '-A'); git('commit', '-qm', 'main moves on (tools only)'); const main1 = git('rev-parse', 'HEAD');
git('merge', '-q', '--no-ff', '-m', 'merge', 'work-x'); const merge = git('rev-parse', 'HEAD');
git('checkout', '-q', '-b', 'work-y', base); put('.github/workflows/release.yml', 'chain 2'); git('add', '-A'); git('commit', '-qm', 'chain changed'); const chain2 = git('rev-parse', 'HEAD');

// a made-up API: path (as called) -> response
const mkApi = (runs, jobs, { throws } = {}) => async (p) => {
  if (throws) throw new Error('HTTP 500');
  let m;
  if ((m = p.match(/runs\?head_sha=(\w+)/))) return { workflow_runs: runs.filter((r) => r.head_sha === m[1]) };
  if (/runs\?status=completed&per_page=100&page=1/.test(p)) return { workflow_runs: runs };
  if ((m = p.match(/runs\/(\d+)\/jobs/))) return { jobs: jobs[m[1]] || [] };
  return {};
};
const run = (id, sha, extra = {}) => ({ id, head_sha: sha, conclusion: 'success', created_at: '2026-11-26T10:00:00Z', html_url: `https://x/runs/${id}`, ...extra });
const verdict = (name, conclusion = 'success') => [{ name: 'Plan', conclusion: 'success' }, { name, conclusion }];

ok('signature differs when the app files differ, equals for the merge and its branch head', signature('reader', work, dir) !== signature('reader', base, dir) && signature('reader', merge, dir) === signature('reader', work, dir));
ok('the tools signature of the merge is not the branch head\'s (main changed tools)', signature('tools', merge, dir) !== signature('tools', work, dir));
ok('fullAppsOf reads the verdict job name', JSON.stringify(fullAppsOf('Preflight verdict [full: reader,tools]')) === '["reader","tools"]' && JSON.stringify(fullAppsOf('Preflight verdict [full: none]')) === '["none"]' && fullAppsOf('Preflight reader 1/4') === null);

let r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, work)], { 1: verdict('Preflight verdict [full: reader,tools]') }) });
ok('a green full run on the merge\'s second parent stands in', r.found && r.run_id === 1 && r.sha === work, r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, work)], { 1: verdict('Preflight verdict [full: reader]', 'failure') }) });
ok('a failed verdict does not', !r.found && /verdict failure/.test(r.reason), r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, work)], { 1: verdict('Preflight verdict [full: none]') }) });
ok('a quick run does not', !r.found && /not a full run/.test(r.reason), r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, work)], { 1: verdict('Preflight verdict [full: tools]') }) });
ok('a full run of the other app does not', !r.found, r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, base)], { 1: verdict('Preflight verdict [full: reader,tools]') }) });
ok('a green run on other files does not', !r.found && /other files/.test(r.reason), r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, chain2)], { 1: verdict('Preflight verdict [full: reader,tools]') }) });
ok('a green run with another release chain does not', !r.found, r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, work, { conclusion: 'cancelled' })], { 1: verdict('Preflight verdict [full: reader]') }) });
ok('a cancelled run is ignored', !r.found, r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, work)], { 1: [{ name: 'Preflight (reader)', conclusion: 'success' }] }) });
ok('an old Preflight without a verdict job does not', !r.found && /no verdict job/.test(r.reason), r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([], {}) });
ok('no run at all does not', !r.found, r);
r = await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([run(1, 'f'.repeat(40))], { 1: verdict('Preflight verdict [full: reader]') }), fetchCommit: () => false });
ok('a run on a commit that cannot be fetched does not', !r.found && /not available/.test(r.reason), r);
r = await findGreen({ app: 'reader', sha: 'e'.repeat(40), cwd: dir, api: mkApi([], {}) });
ok('an unknown released commit does not', !r.found, r);
let threw = false; try { await findGreen({ app: 'reader', sha: merge, cwd: dir, api: mkApi([], {}, { throws: true }) }); } catch { threw = true; }
ok('an API error reaches the caller (the command line turns it into found=false)', threw);
// the command line, with no token: found=false and exit 0
const cli = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'find-green-preflight.mjs'), 'reader', '--github-output', path.join(dir, 'out.txt')], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_REPOSITORY: '' } });
ok('the command line without a token says found=false and exits 0', cli.status === 0 && /found=false/.test(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')), cli);
void main1;
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
