'use strict';
// ---------------------------------------------------------------------------
// JARVIS time machine — "put everything back to how it was at 3pm".
//
// Undo covers ONE action for 60 seconds. This covers the shape of your whole
// working session: which apps were open, which one you were in, over a rolling
// two days at 5-minute granularity.
//
// The safety line that matters: RE-OPENING an app is harmless, CLOSING one can
// destroy unsaved work. So a restore opens freely and never closes anything on
// its own — apps that were not running then are listed and left alone unless you
// explicitly confirm. A "restore" that silently quit an editor with unsaved work
// would be the single most damaging thing in this codebase.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// No closeApp dep, deliberately — see the note above. Nothing in this module can quit an app,
// which is enforced by there being no way to.
let deps = { jlog: () => {}, audit: () => {}, stateDir: null, openApp: null };
function init(d) { deps = Object.assign(deps, d || {}); }

const FILE = () => path.join(deps.stateDir || '/tmp', 'timemachine.json');
const EVERY = 5 * 60 * 1000;          // snapshot cadence
const KEEP = 48 * 60 * 60 * 1000;     // rolling window
const MIN_GAP = 60 * 1000;            // never write two snapshots closer than this

let snaps = null, lastWrite = 0;

function load() {
  if (snaps) return snaps;
  try { snaps = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { snaps = []; }
  if (!Array.isArray(snaps)) snaps = [];
  return snaps;
}
function save() { try { fs.writeFileSync(FILE(), JSON.stringify(snaps)); } catch (e) {} }

const sh = (cmd, args, timeout) => new Promise(resolve => {
  execFile(cmd, args, { timeout: timeout || 15000, maxBuffer: 4 << 20 }, (e, out) => resolve(String(out || '')));
});

// System Events gives the real user-visible app list (background helpers excluded),
// which is what "how it was" means to a person.
const JXA_STATE = `function run(){
  const se = Application('System Events');
  const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
  const apps = procs.map(p => { try { return p.name(); } catch(e) { return null; } }).filter(Boolean);
  let front = '';
  try { front = se.applicationProcesses.whose({ frontmost: true })()[0].name(); } catch(e) {}
  return JSON.stringify({ apps: apps, front: front });
}`;

async function capture() {
  const out = await sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_STATE], 20000);
  try {
    const o = JSON.parse(out.trim());
    if (!o || !Array.isArray(o.apps) || !o.apps.length) return null;
    return { apps: o.apps.filter(a => a !== 'Finder'), front: o.front || '' };
  } catch (e) { return null; }
}

async function snapshot(force) {
  const now = Date.now();
  if (!force && now - lastWrite < MIN_GAP) return null;
  const st = await capture();
  if (!st) return null;
  const list = load();
  // Collapse identical consecutive states — an idle afternoon should not cost 100 rows.
  const prev = list[0];
  if (prev && prev.front === st.front && prev.apps.length === st.apps.length &&
      prev.apps.every((a, i) => a === st.apps[i])) {
    prev.until = now;
    lastWrite = now; save();
    return prev;
  }
  const snap = { at: now, until: now, apps: st.apps, front: st.front };
  list.unshift(snap);
  const cutoff = now - KEEP;
  while (list.length && list[list.length - 1].at < cutoff) list.pop();
  lastWrite = now;
  save();
  return snap;
}

let timer = null;
function start() {
  if (timer) return;
  snapshot(true).catch(() => {});
  timer = setInterval(() => snapshot().catch(() => {}), EVERY);
  if (timer.unref) timer.unref();
  deps.jlog('Time machine › journaling app state every ' + (EVERY / 60000) + ' min');
}

// ---------------- "at 3pm" / "an hour ago" / "before lunch" ----------------
function parseWhen(text) {
  const t = String(text || '').toLowerCase();
  const now = new Date();
  let m;
  if ((m = t.match(/\b(\d+)\s*(minute|min|hour|hr)s?\s+ago\b/))) {
    const ms = Number(m[1]) * (/hour|hr/.test(m[2]) ? 3600000 : 60000);
    return { at: Date.now() - ms, label: m[1] + ' ' + m[2] + (Number(m[1]) === 1 ? '' : 's') + ' ago' };
  }
  if (/\bhalf an hour ago\b/.test(t)) return { at: Date.now() - 1800000, label: 'half an hour ago' };
  if (/\ban hour ago\b/.test(t)) return { at: Date.now() - 3600000, label: 'an hour ago' };
  if ((m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/))) {
    let h = Number(m[1]); const min = Number(m[2] || 0);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    // No am/pm and it's already past that hour today → they mean the afternoon one.
    if (!m[3] && h < 12 && now.getHours() >= 12 && h + 12 <= now.getHours()) h += 12;
    const d = new Date(now); d.setHours(h, min, 0, 0);
    if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
    if (/\byesterday\b/.test(t)) d.setDate(d.getDate() - 1);
    return { at: d.getTime(), label: (/\byesterday\b/.test(t) ? 'yesterday ' : '') + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) };
  }
  const TOD = { 'this morning': 9, 'lunch': 13, 'lunchtime': 13, 'before lunch': 12, 'after lunch': 14, 'this afternoon': 15, 'this evening': 19, 'last night': 22 };
  for (const k in TOD) {
    if (t.includes(k)) {
      const d = new Date(now); d.setHours(TOD[k], 0, 0, 0);
      if (d.getTime() > now.getTime() || k === 'last night') d.setDate(d.getDate() - 1);
      return { at: d.getTime(), label: k };
    }
  }
  return null;
}

function nearest(ts) {
  const list = load();
  if (!list.length) return null;
  let best = null, bestGap = Infinity;
  for (const s of list) {
    // A snapshot spans [at, until] — if the moment falls inside, it is exact.
    const gap = ts >= s.at && ts <= s.until ? 0 : Math.min(Math.abs(s.at - ts), Math.abs(s.until - ts));
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  if (!best || bestGap > 30 * 60 * 1000) return null;   // nothing within half an hour = no honest answer
  return { snap: best, gap: bestGap };
}

// ---------------- tools ----------------
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = say => ({ ok: false, say });

const fmt = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

async function what_was_open(args) {
  const w = parseWhen(args.when || args.time || args.text || '');
  if (!w) return fail('When, Sir? Give me a time — “at 3pm”, “an hour ago”, “before lunch”.');
  const n = nearest(w.at);
  if (!n) return fail('I have no record of ' + w.label + ', Sir — the journal only goes back two days.');
  const s = n.snap;
  return ok('At ' + fmt(s.at) + ', Sir, you had ' + s.apps.length + ' apps open: ' + s.apps.join(', ') +
    (s.front ? '.\nYou were in ' + s.front + '.' : '.'), { data: { snap: s } });
}

// The restore itself. `confirmed` gates the closing half only.
async function restore_session(args, ctx) {
  const w = parseWhen(args.when || args.time || args.text || '');
  if (!w) return fail('Restore to when, Sir? Try “put everything back to how it was at 3pm”.');
  const n = nearest(w.at);
  if (!n) return fail('No record of ' + w.label + ', Sir — I journal the last two days only.');
  const s = n.snap;

  const nowState = await capture();
  if (!nowState) return fail('I could not read the current app state, Sir.');
  const running = new Set(nowState.apps);
  const missing = s.apps.filter(a => !running.has(a));
  const extra = nowState.apps.filter(a => !s.apps.includes(a));

  if (!missing.length && !extra.length) {
    return ok('Nothing to change, Sir — this is already how it was at ' + fmt(s.at) + '.');
  }

  const opened = [];
  for (const app of missing) {
    if (!deps.openApp) break;
    try { const r = await deps.openApp(app); if (r && r.ok !== false) opened.push(app); } catch (e) {}
  }
  // Front app last, so it ends up actually in front.
  if (s.front && deps.openApp && s.apps.includes(s.front)) { try { await deps.openApp(s.front); } catch (e) {} }

  deps.audit('restore_session', { at: s.at, opened: opened.length }, 'ok');

  let say = opened.length
    ? 'Restored to ' + fmt(s.at) + ', Sir — reopened ' + opened.join(', ') + '.'
    : 'Everything from ' + fmt(s.at) + ' was already running, Sir.';
  if (s.front) say += ' You were in ' + s.front + ' at the time.';
  // Deliberately NOT closed automatically: quitting an app can lose unsaved work, and
  // a restore is not worth that risk. Named, so the user can decide.
  if (extra.length) {
    say += '\n\nOpen now that was not open then: ' + extra.join(', ') +
      '. I have left those alone — say “close them too” if you want them quit.';
  }
  return ok(say, { data: { restoredTo: s.at, opened, extra } });
}

function session_timeline() {
  const list = load();
  if (!list.length) return ok('No session history yet, Sir — I have just started journaling.');
  const rows = list.slice(0, 12).map(s =>
    fmt(s.at) + (s.until - s.at > 60000 ? '–' + fmt(s.until) : '') + '  ' +
    (s.front || '—') + '  (' + s.apps.length + ' apps)');
  return ok('Your session, most recent first, Sir:\n' + rows.join('\n'));
}

const TOOLS = { what_was_open, restore_session, session_timeline };
const TOOL_HELP = {
  what_was_open: 'what_was_open{when}. What apps were open at a past time ("at 3pm", "an hour ago").',
  restore_session: 'restore_session{when}. Reopen the apps that were running at a past time. Never closes anything.',
  session_timeline: 'session_timeline{}. Recent app-state history.',
};

// "session timeline" was missing, which left session_timeline unreachable by voice or chat — and
// worse, it then fell through to whatever lane was widest, getting graded as a quiz answer.
const TM_RE = /\b(?:put (?:everything|it all|things) back|restore (?:my |the )?(?:session|apps|setup|workspace)|back to how it was|what (?:was|did i have) open|which apps were open|reopen what i had|session (?:timeline|history)|app history)\b/i;

module.exports = { init, TOOLS, TOOL_HELP, start, snapshot, parseWhen, nearest, TM_RE, count: () => load().length };
