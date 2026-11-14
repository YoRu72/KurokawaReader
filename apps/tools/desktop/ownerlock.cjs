// Who runs the downloads the two programs share after the hand-over (stage P9; desktop-tauri/PORTING.md «Downloads:
// one owner»). The rule is kt-core's ownerlogic.rs, in JavaScript (both checked against one table,
// core/kt-core/src/ownerlock-cases.txt, by tests/ownerlock.cjs): one owner file, downloads-owner.json, in this app's
// data folder — next to the aria2 session that was handed over —, naming the program that runs the handed-over
// downloads now ({ owner: 'tauri'|'electron', pid, startedAt, heartbeat, released, ids }), written atomically. While
// another program that looks alive holds them, this one keeps those downloads paused and refuses to resume them
// («kt-owner:held», which the page turns into words with «Take them back», asked first). Only the bridge build uses
// it (main.cjs, `RUST_SWITCH`): with the switch off nothing here runs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'downloads-owner.json';
const APP = 'KurokawaTools';
const KIND = 'downloads-owner';
const FORMAT = 1;
const HEARTBEAT_MS = 10000;
const STALE_MS = 45000;
const PID_REUSE_MS = 600000;
const SKEW_MS = 120000;
const SETTLE_MS = 1500;

/** ownerlogic.rs status: 'free' | 'mine' | 'held' | 'stale'. `rec` { owner, pid, startedAt, heartbeat, released } or
 *  null; `me` { owner, pid, startedAt }; `pidAlive` whether the record's pid runs. */
function status(now, rec, me, pidAlive) {
  if (!rec) return 'free';
  if (rec.released) return 'free';
  if (rec.owner === me.owner && rec.pid === me.pid && rec.startedAt === me.startedAt) return 'mine';
  const alive = !!pidAlive && rec.pid !== me.pid && rec.pid !== 0;
  const age = now - rec.heartbeat;
  if (age < -SKEW_MS) return alive ? 'held' : 'stale';
  if (age <= STALE_MS) return 'held';
  if (alive && age <= PID_REUSE_MS) return 'held';
  return 'stale';
}
const mayTake = (st, asked) => st !== 'held' || !!asked;
const tick = (st) => (st === 'mine' ? 'renew' : st === 'held' ? 'yield' : 'take');
const resumeAllowed = (st, ids, id) => st !== 'held' || !(ids || []).includes(id);

/** A record from the file's text (null when it is not one). */
function parse(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.app !== APP || j.kind !== KIND || typeof j.owner !== 'string' || !Number.isFinite(j.pid) || !Number.isFinite(j.heartbeat)) return null;
  return { owner: j.owner, pid: j.pid, startedAt: Number(j.startedAt) || 0, heartbeat: j.heartbeat, released: !!j.released, ids: Array.isArray(j.ids) ? j.ids.map(String) : [], handover: j.handover ? String(j.handover) : '' };
}
function render(me, o) {
  return JSON.stringify({ app: APP, kind: KIND, format: FORMAT, owner: me.owner, pid: me.pid, startedAt: me.startedAt, heartbeat: o.now, released: !!o.released, handover: o.handover || '', ids: o.ids || [] });
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** The owner file in `dir` for this program: read, take, renew, release — and the guard main.cjs asks before a resume.
 *  `hooks.pause(ids)` pauses those of the downloads that run here (the engine's and the video jobs'), `hooks.told(info)`
 *  tells the page. */
class OwnerLock {
  constructor(dir, hooks, o) {
    this.file = path.join(dir, FILE); this.hooks = hooks || {};
    this.me = { owner: 'electron', pid: process.pid, startedAt: (o && o.startedAt) || Date.now() };
    this.now = (o && o.now) || (() => Date.now());
    this.alive = (o && o.alive) || pidAlive;
    this.sleep = (o && o.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timer = null; this.lastStatus = null; this.paused = [];
  }
  read() { try { return parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  status(rec) { const r = rec === undefined ? this.read() : rec; return status(this.now(), r, this.me, r ? this.alive(r.pid) : false); }
  write(o) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, render(this.me, { now: this.now(), ...o }));
    try { fs.renameSync(tmp, this.file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  }
  /** What the page shows: null when no record names handed-over downloads; else whether another holds them. */
  info() {
    const r = this.read(); if (!r) return null;
    const st = this.status(r);
    return { held: st === 'held', status: st, by: r.owner, since: r.heartbeat, count: r.ids.length };
  }
  /** Whether `id` may be resumed here now; a stale record is taken over on the way (no asking). */
  async allowResume(id) {
    const r = this.read(); if (!r) return true;
    const st = this.status(r);
    if (resumeAllowed(st, r.ids, id)) { if (st === 'stale') await this.take(false).catch(() => false); return true; }
    return false;
  }
  /** This program's record written (asked: also over a live owner — «Take them back»), then read back after a moment:
   *  true when it still names this program. */
  async take(asked) {
    const r = this.read(); const st = this.status(r);
    if (!mayTake(st, asked)) return false;
    this.write({ ids: r ? r.ids : [], handover: r ? r.handover : '' });
    await this.sleep(SETTLE_MS);
    const ok = this.status() === 'mine';
    if (ok) { this.start(); const back = this.paused; this.paused = []; if (asked && back.length && this.hooks.resume) await Promise.resolve(this.hooks.resume(back)).catch(() => undefined); }
    return ok;
  }
  /** The heartbeat (only while this program owns them): renewed; taken over by another → its downloads paused here. */
  async beat() {
    const r = this.read(); if (!r) return;
    const st = this.status(r); const what = tick(st);
    if (this.lastStatus !== 'mine' && st !== 'mine') { this.lastStatus = st; return; }
    if (what === 'renew') this.write({ ids: r.ids, handover: r.handover });
    else if (what === 'yield') { this.stop(); await this.pauseHeld(r.ids); if (this.hooks.told) this.hooks.told(this.info()); }
    else this.write({ ids: r.ids, handover: r.handover });
    this.lastStatus = what === 'yield' ? 'held' : 'mine';
  }
  /** At the engine's start: another live owner → the handed-over downloads that run here paused, the page told. */
  async atStart() {
    const r = this.read(); if (!r) return null;
    const st = this.status(r); this.lastStatus = st;
    if (st === 'held') { await this.pauseHeld(r.ids); if (this.hooks.told) this.hooks.told(this.info()); }
    else if (st === 'mine') this.start();
    return st;
  }
  /** The handed-over downloads that run here paused; those it paused remembered (resumed when taken back). */
  async pauseHeld(ids) { const got = await Promise.resolve(this.hooks.pause && this.hooks.pause(ids)).catch(() => []); for (const id of got || []) if (!this.paused.includes(id)) this.paused.push(id); }
  start() { this.lastStatus = 'mine'; if (!this.timer) { this.timer = setInterval(() => void this.beat().catch(() => undefined), HEARTBEAT_MS); if (this.timer.unref) this.timer.unref(); } }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  /** At quit, while it owns them: released, so the other program takes them up at once. */
  release() { this.stop(); try { const r = this.read(); if (r && this.status(r) === 'mine') this.write({ ids: r.ids, handover: r.handover, released: true }); } catch { /* read-only */ } }
}

module.exports = { FILE, APP, KIND, FORMAT, HEARTBEAT_MS, STALE_MS, PID_REUSE_MS, SKEW_MS, SETTLE_MS, status, mayTake, tick, resumeAllowed, parse, render, pidAlive, OwnerLock };
