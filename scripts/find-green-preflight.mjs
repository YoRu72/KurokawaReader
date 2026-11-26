#!/usr/bin/env node
// Used by the release workflows before their long test chain: is there a GREEN FULL Preflight of exactly these files?
//
//   node scripts/find-green-preflight.mjs <tools|reader> [--sha <commit>] [--github-output <file>]
//
// «Exactly these files»: the git tree of every path the app's release depends on is the same at the released commit and at
// the commit the Preflight ran on: apps/<app>, shared, repo, .github/actions, and the release workflow of that app (its test
// chain is what the Preflight runs; a changed chain is never trusted). The merge commit's second parent (the work branch's
// head) is the usual match; then its first parent; then every recent Preflight run, newest first.
// «Green full Preflight»: a run of preflight.yml whose job «Preflight verdict [full: <apps>]» concluded success and names this
// app (a quick run says «[full: none]»). The verdict job is the single result of the sharded Preflight (preflight.yml).
//
// Looks the runs up with the REST API and the job's own token (GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL). Writes
// «found=true|false», «run_id», «run_url», «sha», «reason» to --github-output and a short note to $GITHUB_STEP_SUMMARY.
// Whatever goes wrong (no token, no network, a commit that cannot be fetched) the answer is found=false: the release then
// runs the full chain as before. It can never make a release weaker than that.
// Tests: scripts/find-green-preflight.test.mjs (a made-up repository and a made-up API).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_OF = { tools: '.github/workflows/release-tools.yml', reader: '.github/workflows/release.yml' };
export const pathsOf = (app) => [`apps/${app}`, 'shared', 'repo', '.github/actions', WORKFLOW_OF[app]];

// The signature of a commit for an app: the tree id of each path («-» when the path is not there), or null when the commit is unknown.
export function signature(app, sha, cwd) {
  const git = (args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
  if (spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status !== 0) return null;
  return pathsOf(app).map((p) => git(['rev-parse', '--verify', '--quiet', `${sha}:${p}`]) || '-').join(' ');
}

// The name of the verdict job: «Preflight verdict [full: reader,tools]» -> ['reader','tools'] (['none'] for a quick run).
export const fullAppsOf = (name) => { const m = /^Preflight verdict \[full: ([^\]]*)\]$/.exec(name || ''); return m ? m[1].split(',').map((s) => s.trim()) : null; };

export async function findGreen({ app, sha, cwd, api, fetchCommit = () => false, log = () => {} }) {
  const want = signature(app, sha, cwd);
  if (!want) return { found: false, reason: `the released commit ${sha} is not in this checkout` };
  const parents = (spawnSync('git', ['rev-list', '--parents', '-n', '1', sha], { cwd, encoding: 'utf8' }).stdout || '').trim().split(/\s+/).slice(1);
  // the candidate commits, in the order to try them: the commit itself, the merge's second parent (the branch head), the first
  // parent, then the commits of the recent Preflight runs
  const order = [sha, parents[1], parents[0]].filter(Boolean);
  const runsBySha = new Map();
  const note = (runs) => { for (const r of runs || []) { if (!r.head_sha) continue; if (!runsBySha.has(r.head_sha)) runsBySha.set(r.head_sha, []); runsBySha.get(r.head_sha).push(r); } };
  for (const c of order) note((await api(`/actions/workflows/preflight.yml/runs?head_sha=${c}&status=completed&per_page=20`))?.workflow_runs);
  for (let page = 1; page <= 3; page++) { const r = await api(`/actions/workflows/preflight.yml/runs?status=completed&per_page=100&page=${page}`); const runs = r?.workflow_runs || []; note(runs); if (runs.length < 100) break; }
  const tried = []; let fetches = 0;
  for (const c of [...new Set([...order, ...runsBySha.keys()])]) {
    const runs = (runsBySha.get(c) || []).filter((r) => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (!runs.length) continue;
    let have = signature(app, c, cwd);
    if (have === null && fetches < 40) { fetches++; if (fetchCommit(c)) have = signature(app, c, cwd); }
    if (have === null) { tried.push(`${c.slice(0, 9)} (commit not available)`); continue; }
    if (have !== want) { tried.push(`${c.slice(0, 9)} (other files)`); continue; }
    for (const run of runs) {
      const jobs = (await api(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`))?.jobs || [];
      const v = jobs.find((j) => fullAppsOf(j.name));
      if (!v) { tried.push(`run ${run.id} (no verdict job: an older Preflight)`); continue; }
      if (v.conclusion !== 'success') { tried.push(`run ${run.id} (verdict ${v.conclusion})`); continue; }
      if (!fullAppsOf(v.name).includes(app)) { tried.push(`run ${run.id} (${v.name}: not a full run of ${app})`); continue; }
      return { found: true, run_id: run.id, run_url: run.html_url || '', sha: c, reason: `${v.name} succeeded in run ${run.id} on ${c.slice(0, 9)}, whose ${pathsOf(app).join(', ')} are identical to this commit's` };
    }
  }
  return { found: false, reason: `no green full Preflight of the same files (looked at: ${tried.slice(0, 8).join('; ') || 'no Preflight run found'})` };
}

// ---------- command line ----------
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2); const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const app = argv.find((a) => a === 'tools' || a === 'reader');
  if (!app) { console.error('usage: node scripts/find-green-preflight.mjs <tools|reader> [--sha <commit>] [--github-output <file>]'); process.exit(2); }
  const cwd = process.cwd(); const sha = opt('--sha') || process.env.GITHUB_SHA || 'HEAD';
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN, apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
  const api = async (p) => { const r = await fetch(`${apiBase}/repos/${repo}${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'kurokawa-release' } }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
  const fetchCommit = (c) => spawnSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', c], { cwd, stdio: 'ignore' }).status === 0;
  let res;
  try {
    if (!repo || !token) throw new Error('no GITHUB_REPOSITORY / GITHUB_TOKEN');
    const full = spawnSync('git', ['rev-parse', sha], { cwd, encoding: 'utf8' }).stdout.trim() || sha;
    res = await findGreen({ app, sha: full, cwd, api, fetchCommit });
  } catch (e) { res = { found: false, reason: `the lookup failed (${(e && e.message) || e}); the full chain runs` }; }
  console.log(res.found ? `green Preflight found: ${res.reason}` : `no green Preflight: ${res.reason}`);
  const out = opt('--github-output');
  if (out) fs.appendFileSync(out, `found=${res.found}\nrun_id=${res.run_id || ''}\nrun_url=${res.run_url || ''}\nsha=${res.sha || ''}\nreason=${String(res.reason).replace(/[\r\n]+/g, ' ')}\n`);
  process.exit(0);
}
