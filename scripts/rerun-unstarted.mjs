#!/usr/bin/env node
// A release job that GitHub cancels before it has run one step (no machine was found for it: seen on 25 Nov, the macOS and iOS
// jobs of the Reader's release, cancelled at 15 minutes) is re-run once, automatically. Started by
// .github/workflows/rerun-unstarted.yml when a release run has completed without success.
//
//   node scripts/rerun-unstarted.mjs <run-id> [--dry]
//
// Which jobs count: concluded «cancelled», with NO step at all, and waited at least 10 minutes between being queued and being
// cancelled (a job that a person cancelled a moment after starting the run is not re-run). If there is one, the API's
// «re-run failed jobs» is called once for the run: it re-runs the failed and cancelled jobs and the jobs that needed them.
// The caller guards against loops (the workflow runs only for attempt 1). Uses GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL.
import { pathToFileURL } from 'node:url';

export const MIN_WAIT_SEC = 600;
// jobs: the «jobs» array of GET /actions/runs/{id}/jobs -> the ones that never got a machine
export function pickUnstarted(jobs, minWaitSec = MIN_WAIT_SEC) {
  return (jobs || []).filter((j) => j.conclusion === 'cancelled' && (!j.steps || j.steps.length === 0) && j.created_at && j.completed_at && (Date.parse(j.completed_at) - Date.parse(j.created_at)) / 1000 >= minWaitSec);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2); const id = argv.find((a) => /^\d+$/.test(a)); const dry = argv.includes('--dry');
  if (!id) { console.error('usage: node scripts/rerun-unstarted.mjs <run-id> [--dry]'); process.exit(2); }
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const call = (method, p) => fetch(`${base}/repos/${repo}${p}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'kurokawa-release' } });
  try {
    if (!repo || !token) throw new Error('no GITHUB_REPOSITORY / GITHUB_TOKEN');
    const r = await call('GET', `/actions/runs/${id}/jobs?filter=latest&per_page=100`); if (!r.ok) throw new Error(`jobs: HTTP ${r.status}`);
    const hit = pickUnstarted((await r.json()).jobs);
    if (!hit.length) { console.log(`run ${id}: no job was cancelled before it started; nothing to re-run`); process.exit(0); }
    console.log(`run ${id}: ${hit.length} job(s) cancelled before any step ran: ${hit.map((j) => j.name).join(', ')}`);
    if (dry) { console.log('dry run: not re-running'); process.exit(0); }
    const x = await call('POST', `/actions/runs/${id}/rerun-failed-jobs`);
    console.log(x.ok ? `re-run requested (HTTP ${x.status})` : `::warning::the re-run was refused: HTTP ${x.status}`);
  } catch (e) { console.log(`::warning::${(e && e.message) || e}`); }
  process.exit(0);
}
