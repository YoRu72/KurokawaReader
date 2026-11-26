#!/usr/bin/env node
// node scripts/rerun-unstarted.test.mjs — which jobs rerun-unstarted.mjs would re-run, on made-up job lists.
import { pickUnstarted } from './rerun-unstarted.mjs';
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x ?? ''))); if (!c) fails++; };
const t = (min) => ({ created_at: '2026-11-25T10:00:00Z', completed_at: new Date(Date.parse('2026-11-25T10:00:00Z') + min * 60000).toISOString() });
const jobs = [
  { name: 'macOS', conclusion: 'cancelled', steps: [], ...t(15) },
  { name: 'iOS', conclusion: 'cancelled', ...t(15) },
  { name: 'cancelled by a person at once', conclusion: 'cancelled', steps: [], ...t(1) },
  { name: 'cancelled mid-run', conclusion: 'cancelled', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'build', conclusion: 'cancelled' }], ...t(40) },
  { name: 'failed', conclusion: 'failure', steps: [], ...t(30) },
  { name: 'ok', conclusion: 'success', steps: [{ name: 'x', conclusion: 'success' }], ...t(30) },
];
const got = pickUnstarted(jobs).map((j) => j.name);
ok('only the jobs cancelled with no step after a long wait', JSON.stringify(got) === '["macOS","iOS"]', got);
ok('nothing in, nothing out', pickUnstarted([]).length === 0 && pickUnstarted(undefined).length === 0);
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
