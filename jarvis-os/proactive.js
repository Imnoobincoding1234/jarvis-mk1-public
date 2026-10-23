'use strict';
// ---------------------------------------------------------------------------
// JARVIS proactive layer — the part that speaks first.
//
// Everything else in this system is reactive: you ask, it answers. This watches
// state JARVIS already collects and decides, on its own, when something is worth
// interrupting you for.
//
// The hard part is NOT noticing things — it is shutting up. An assistant that
// nudges too often gets muted, and a muted assistant is worth nothing. So every
// signal passes a rate limiter, a per-signal cooldown, quiet hours, and a
// presence check before it reaches you, and anything that fires while you are
// away is queued rather than fired into an empty room.
//
// PERMISSIONS NOTE: macOS TCC-protects both the notification database
// (~/Library/Group Containers/group.com.apple.usernoted) and the Focus/DND state
// file — both return "authorization denied" without Full Disk Access. So this
// cannot read your system notifications or know whether Focus is on. It triages
// JARVIS's OWN notification stream, which needs no permission, and uses quiet
// hours plus idle detection as the presence signal instead of Focus.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let deps = {
  jlog: () => {}, notify: () => {}, stateDir: null,
  audit: () => {},       // breaks_set records the change; live JARVIS passed none, so "turn break reminders on" threw (2026-10-15)
  listEvents: null,      // async (days) → [{title, start, end}]
  stats: null,           // async () → {batteryPct, charging, diskPct, ...}
  tutorDue: () => 0,
  frontApp: null,        // async () → app name
  pendingApproval: () => null,
};
function init(d) { deps = Object.assign(deps, d || {}); }

const FILE = () => path.join(deps.stateDir || '/tmp', 'proactive.json');

const MIN = 60000, HOUR = 3600000;
const TICK = 2 * MIN;
// NORMAL MODE (set at Atharv's request, 2026-08-05). Initiative is standard behaviour now, not a
// cautious opt-in — so the ceiling is raised and the gap shortened. The limits still exist, because
// the failure mode of a proactive assistant is being muted, and a muted assistant is worth nothing.
// These are the dials to turn if it ever gets noisy.
const MAX_PER_HOUR = 6;          // hard ceiling regardless of how much is happening
const MIN_GAP = 6 * MIN;         // never two nudges back to back
// No unprompted anything overnight — kept, deliberately. Overridable through init() so the hours
// can be tuned, and so behavioural tests are not silently skipped for ten hours a day: the
// away-queue tests passed at 16:00 and failed at 23:12 purely because tick() was correctly bailing
// out on quiet hours. A test that only runs in the afternoon is not a test.
const QUIET_START_DEFAULT = 22, QUIET_END_DEFAULT = 8;
const quietStart = () => (deps.quietHours && Number.isFinite(deps.quietHours[0])) ? deps.quietHours[0] : QUIET_START_DEFAULT;
const quietEnd = () => (deps.quietHours && Number.isFinite(deps.quietHours[1])) ? deps.quietHours[1] : QUIET_END_DEFAULT;
const AWAY_AFTER = 10 * MIN;     // treat as "not at the machine" past this much idle
const QUEUE_MAX = 3;             // most nudges held for their return; older ones are dropped
const QUEUE_TTL = 6 * HOUR;      // a nudge nobody saw for six hours is no longer worth showing

let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { state = null; }
  if (!state || typeof state !== 'object') state = { enabled: true, fired: [], cooldowns: {}, queue: [] };
  state.fired = state.fired || []; state.cooldowns = state.cooldowns || {}; state.queue = state.queue || [];
  if (state.enabled == null) state.enabled = true;
  // Break/water reminders are opt-in and default OFF: a nudge nobody asked for is the kind of thing
  // that gets the whole proactive layer muted. He turned it on on 2026-08-08.
  // ONE HOME (2026-10-15, his ask — Settings → Break reminders did nothing): the setting is profile.breaks, read and written
  // through deps.breaksOn / deps.setBreaks. The reminder used to read THIS file while Settings showed the profile's default,
  // so a value still kept here is the one that was in force: it is carried over once and removed from here.
  if (deps.setBreaks) {
    if (state.breaks != null) { const was = !!state.breaks; delete state.breaks; deps.setBreaks(was); save(); }
  } else if (state.breaks == null) state.breaks = false;   // no profile wired (tests, older callers): this file, default OFF
  return state;
}
function breaksOn() { const s = load(); return deps.setBreaks && deps.breaksOn ? !!deps.breaksOn() : !!s.breaks; }
function save() { try { fs.writeFileSync(FILE(), JSON.stringify(load(), null, 2)); } catch (e) {} }

const sh = (cmd, args, timeout) => new Promise(resolve => {
  execFile(cmd, args, { timeout: timeout || 10000, maxBuffer: 1 << 20 }, (e, out) => resolve(String(out || '')));
});

// Seconds since the last keyboard/mouse event. No permission required, unlike
// every other way of asking "is the user here".
// Overridable through init() so presence can be driven in tests — the away/return behaviour is
// the whole point of normal mode and asserting it on the source text alone proves nothing.
async function idleSeconds() {
  if (deps.idleSeconds) return await deps.idleSeconds();
  const out = await sh('/bin/sh', ['-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"], 8000);
  const n = Number(String(out).trim());
  return Number.isFinite(n) ? n : 0;
}

function quietNow() {
  const h = new Date().getHours();
  const a = quietStart(), b = quietEnd();
  if (a === b) return false;                 // equal start/end disables quiet hours entirely
  return a > b ? (h >= a || h < b) : (h >= a && h < b);
}

function canFire(key, cooldownMs) {
  const s = load(), now = Date.now();
  if (!s.enabled) return false;
  if (quietNow()) return false;
  if ((s.cooldowns[key] || 0) > now) return false;
  const recent = s.fired.filter(t => now - t < HOUR);
  if (recent.length >= MAX_PER_HOUR) return false;
  if (s.fired.length && now - s.fired[0] < MIN_GAP) return false;
  return true;
}

function fire(key, title, detail, cooldownMs, action) {
  const s = load(), now = Date.now();
  s.cooldowns[key] = now + (cooldownMs || 2 * HOUR);
  s.fired.unshift(now);
  s.fired = s.fired.filter(t => now - t < 6 * HOUR).slice(0, 20);
  save();
  deps.notify('proactive', title, detail);
  deps.jlog('Proactive › ' + title + ' — ' + detail);
  const nudge = { key, title, detail, at: now, action: action || null };
  // Let the host arm an offer for nudges that propose something — under the word the nudge names ("say
  // “open”") — so his answer reaches the nudge instead of arriving at the router with no context.
  try { if (deps.onNudge) deps.onNudge(nudge); } catch (e) {}
  return nudge;
}

// ---------------- the signals ----------------
// Each returns {key, title, detail, cooldown, action} or null. Kept deliberately
// small and legible — a signal you cannot reason about is a signal that will
// eventually annoy someone.

async function sigCalendar() {
  if (!deps.listEvents) return null;
  let events = [];
  try { events = await deps.listEvents(1) || []; } catch (e) { return null; }
  const now = Date.now();
  for (const ev of events) {
    const start = new Date(ev.start).getTime();
    if (!Number.isFinite(start)) continue;
    const mins = (start - now) / MIN;
    if (mins < 2 || mins > 12) continue;
    const title = String(ev.title || 'an event');
    // If the event names a tool, offer to open it — that is the actually useful half.
    const m = title.match(/\b(zoom|google meet|meet|teams|webex|discord|slack)\b/i);
    const app = m ? { zoom: 'zoom.us', 'google meet': 'Google Chrome', meet: 'Google Chrome', teams: 'Microsoft Teams', webex: 'Webex', discord: 'Discord', slack: 'Slack' }[m[1].toLowerCase()] : null;
    return {
      key: 'cal:' + title.slice(0, 30),
      title: title + ' in ' + Math.round(mins) + ' min',
      detail: app ? app + ' is not open — say “open” and I will.' : 'Starting shortly, Sir.',
      cooldown: 30 * MIN,
      action: app ? { type: 'open_app', name: app } : null,
    };
  }
  return null;
}

async function sigBattery() {
  if (!deps.stats) return null;
  let s;
  try { s = await deps.stats(); } catch (e) { return null; }
  if (!s || s.batteryPct == null || s.charging) return null;
  if (s.batteryPct > 15) return null;
  return { key: 'battery', title: 'Battery at ' + s.batteryPct + '%', detail: 'Not charging, Sir. Worth plugging in.', cooldown: 45 * MIN };
}

async function sigDisk() {
  if (!deps.stats) return null;
  let s;
  try { s = await deps.stats(); } catch (e) { return null; }
  if (!s || s.diskPct == null || s.diskPct < 92) return null;
  return { key: 'disk', title: 'Disk ' + s.diskPct + '% full', detail: 'Running out of room, Sir.', cooldown: 12 * HOUR };
}

// A question is only worth surfacing unprompted if you are actually at the machine
// and not mid-flow; the caller already gates on idle, so this just reports readiness.
function sigTutor() {
  const due = deps.tutorDue ? deps.tutorDue() : 0;
  if (!due) return null;
  return {
    key: 'tutor', title: due + ' question' + (due === 1 ? '' : 's') + ' ready',
    detail: 'From your library, Sir — say “quiz me”.', cooldown: 20 * HOUR,
  };
}

function sigStaleApproval() {
  const p = deps.pendingApproval ? deps.pendingApproval() : null;
  if (!p || !p.at) return null;
  const age = Date.now() - p.at;
  if (age < 15 * MIN || age > 6 * HOUR) return null;
  return {
    key: 'approval:' + (p.id || 'x'), title: 'Still waiting on your approval',
    detail: String(p.goal || p.say || 'A drafted message is parked, Sir.').slice(0, 100),
    cooldown: 3 * HOUR,
  };
}

// Long unbroken stretch in one app. Uses the same frontmost check the time machine
// uses, so it costs nothing extra.
let frontSince = { app: null, at: Date.now() };
async function sigLongSession() {
  if (!deps.frontApp) return null;
  let app = null;
  try { app = await deps.frontApp(); } catch (e) { return null; }
  if (!app) return null;
  if (app !== frontSince.app) { frontSince = { app, at: Date.now() }; return null; }
  const mins = (Date.now() - frontSince.at) / MIN;
  if (mins < 100) return null;
  return {
    key: 'session', title: Math.round(mins / 10) * 10 + ' minutes in ' + app,
    detail: 'Straight through, Sir. Worth standing up.', cooldown: 3 * HOUR,
  };
}

// Break / water reminder, asked for on 2026-08-08. Distinct from sigLongSession above, which fires
// on 100 minutes in ONE app: this one tracks continuous time AT the machine regardless of how much
// he app-switches, which is the pattern that actually goes four hours without a glass of water.
//
// A real break resets it. "Real" means genuinely away from the keyboard for BREAK_RESET, using the
// same idle clock the away-detection already relies on — otherwise the reminder fires on someone
// who just got back from lunch, which is the fastest way to train him to ignore it.
const WORK_BEFORE_BREAK_DEFAULT = 90 * MIN;
const BREAK_RESET = 6 * MIN;
// Injectable so the tests can exercise the reset logic without waiting ninety real minutes.
const workBeforeBreak = () => Number.isFinite(deps.workBeforeBreak) ? deps.workBeforeBreak : WORK_BEFORE_BREAK_DEFAULT;
let activeSince = Date.now();
let lastIdleSeen = 0;

async function sigHydration() {
  if (!breaksOn()) return null;                 // opt-in; off unless he asked for it
  let idle = 0;
  try { idle = await idleSeconds(); } catch (e) { return null; }
  // Crossing back under the threshold after a proper break = a fresh stretch.
  if (lastIdleSeen >= BREAK_RESET / 1000 && idle < BREAK_RESET / 1000) activeSince = Date.now();
  lastIdleSeen = idle;
  if (idle >= BREAK_RESET / 1000) return null;  // away right now — nothing to say
  const mins = (Date.now() - activeSince) / MIN;
  if (mins < workBeforeBreak() / MIN) return null;
  return {
    key: 'break', title: Math.round(mins / 15) * 15 + ' minutes without a break',
    detail: 'Water and a look away from the screen, Sir.', cooldown: 90 * MIN,
  };
}

const SIGNALS = [sigCalendar, sigStaleApproval, sigBattery, sigDisk, sigLongSession, sigHydration, sigTutor];

// ---------------- the tick ----------------
let timer = null, lastNudge = null;

let wasAway = false;

async function tick() {
  const s = load();
  if (!s.enabled) return;
  if (quietNow()) return;

  let idle = 0;
  try { idle = await idleSeconds(); } catch (e) {}
  const away = idle > AWAY_AFTER / 1000;

  // Presence. Firing into an empty room burns the cooldown and they come back to a stale
  // notification, so nothing is DELIVERED while they are away — but under normal mode it is no
  // longer thrown away either. Anything worth saying is held and handed over when they return.
  if (away) {
    wasAway = true;
    for (const sig of SIGNALS) {
      let r = null;
      try { r = await sig(); } catch (e) { continue; }
      if (!r) continue;
      const q = load().queue;
      if (q.some(x => x.key === r.key)) continue;
      if ((load().cooldowns[r.key] || 0) > Date.now()) continue;
      q.unshift({ key: r.key, title: r.title, detail: r.detail, at: Date.now(), cooldown: r.cooldown });
      load().queue = q.slice(0, QUEUE_MAX);
      save();
    }
    return;
  }

  // They are back. Anything held goes out first — it is older, so it is more urgent to clear.
  if (wasAway) {
    wasAway = false;
    const s2 = load();
    const fresh = s2.queue.filter(q => Date.now() - q.at < QUEUE_TTL);
    s2.queue = [];
    save();
    const held = fresh[0];
    if (held && canFire(held.key, held.cooldown)) {
      lastNudge = fire(held.key, held.title, held.detail, held.cooldown, null);
      return;
    }
  }

  for (const sig of SIGNALS) {
    let r = null;
    try { r = await sig(); } catch (e) { continue; }
    if (!r) continue;
    if (!canFire(r.key, r.cooldown)) continue;
    lastNudge = fire(r.key, r.title, r.detail, r.cooldown, r.action);
    return;                        // one at a time, always
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => tick().catch(e => deps.jlog('Proactive tick failed › ' + (e.message || e))), TICK);
  if (timer.unref) timer.unref();
  deps.jlog('Proactive › watching (max ' + MAX_PER_HOUR + '/hr, quiet ' + quietStart() + ':00–' + quietEnd() + ':00)');
}

// ---------------- notification triage ----------------
// Scores JARVIS's own notification stream so the UI can fold the noise away.
// Not a model call — a notification you have to wait on a model to read is worse
// than the noise it was meant to remove.
const HIGH = /\b(failed|error|denied|refused|blocked|expired|offline|stopped|critical|tamper|unauthorized|approval|waiting on you)\b/i;
const LOW = /\b(indexed|snapshot|started|running|connected|saved|ok|done|completed|synced)\b/i;

function triage(list) {
  const out = [];
  const seen = new Map();
  for (const n of (list || [])) {
    const text = (n.title || '') + ' ' + (n.detail || '');
    let level = 'normal';
    if (HIGH.test(text) || n.kind === 'watcher' || n.kind === 'reminder') level = 'high';
    else if (LOW.test(text) || n.kind === 'ok') level = 'low';
    // Collapse repeats of the same title into one row with a count — five identical
    // "agent stopped" lines are one fact, not five.
    const key = level + '|' + String(n.title || '').slice(0, 40);
    if (seen.has(key)) { seen.get(key).count++; continue; }
    const row = Object.assign({}, n, { level, count: 1 });
    seen.set(key, row);
    out.push(row);
  }
  out.sort((a, b) => ({ high: 0, normal: 1, low: 2 })[a.level] - ({ high: 0, normal: 1, low: 2 })[b.level] || b.at - a.at);
  return { items: out, high: out.filter(x => x.level === 'high').length, muted: out.filter(x => x.level === 'low').length };
}

// ---------------- tools ----------------
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});

// ON OR OFF IS NEVER READ OUT OF WORDS. It used to be: `off|stop|disable|quiet|shut up|mute` in the text
// meant off, so "be quiet for a sec i am on a call" silenced initiative for good. Now the caller must say
// which: the chat lane offers the other state as a word (server.js, proactiveintent.js), and the agent
// passes {enabled}. Without a real true/false nothing changes, and he is told the state it is in.
function proactive_set(args) {
  const s = load();
  if (!args || typeof args.enabled !== 'boolean') {
    return { ok: false, say: 'My nudges are ' + (s.enabled ? 'on' : 'off') + ', Sir — say whether you want them on or off.' };
  }
  const on = args.enabled;
  s.enabled = on; save();
  return ok(on ? 'I will speak up when something needs you, Sir — at most ' + MAX_PER_HOUR + ' times an hour, nothing between ' + quietStart() + ':00 and ' + quietEnd() + ':00.'
               : 'Silenced, Sir. I will not interrupt unless you ask.');
}
function isEnabled() { return !!load().enabled; }

function proactive_status() {
  const s = load(), now = Date.now();
  const recent = s.fired.filter(t => now - t < 24 * HOUR).length;
  const held = s.queue.filter(q => now - q.at < QUEUE_TTL).length;
  return ok('Initiative is ' + (s.enabled ? 'ON — this is my normal mode' : 'OFF') + ', Sir. ' +
    recent + ' nudge' + (recent === 1 ? '' : 's') + ' in the last 24h' +
    (lastNudge ? ' — most recently “' + lastNudge.title + '”' : '') + '.\n' +
    'Watching: calendar, parked approvals, battery, disk, long sessions, study cards.\n' +
    'Limits: up to ' + MAX_PER_HOUR + ' an hour, ' + (MIN_GAP / MIN) + ' min apart, silent ' +
    quietStart() + ':00–' + quietEnd() + ':00. While you are away I hold them and hand them over when you return' +
    (held ? ' (' + held + ' waiting now)' : '') + '.\n' +
    'I cannot read macOS notifications or your Focus state — both need Full Disk Access, which I do not have.');
}

// The same rule: a real true/false, or nothing changes. (It read "on|yes|true|1" out of a string.)
function breaks_set(args) {
  if (!args || typeof args.enabled !== 'boolean') {
    return { ok: false, say: 'Break reminders are ' + (breaksOn() ? 'on' : 'off') + ', Sir — say whether you want them on or off.' };
  }
  const on = args.enabled;
  if (deps.setBreaks) { load(); deps.setBreaks(on); } else { load().breaks = on; save(); }
  deps.audit('breaks_set', { on }, 'ok');
  return ok(on
    ? 'I will remind you to drink something and look away after ' + Math.round(workBeforeBreak() / MIN) + ' minutes at the desk, Sir. A real break resets the clock.'
    : 'No more break reminders, Sir.');
}

const TOOLS = { proactive_set, proactive_status, breaks_set };
const TOOL_HELP = {
  proactive_set: 'proactive_set{enabled}. Turn unprompted nudges on or off.',
  proactive_status: 'proactive_status{}. What JARVIS is watching and how often it has spoken up.',
  breaks_set: 'breaks_set{enabled}. Turn the water/break reminder on or off.',
};
// PROACTIVE_RE lived here until 2026-09-18 — a word list that turned "be quiet for a sec i am on a call"
// into initiative OFF and found 2 of 14 held-out requests. Which initiative request a sentence is, is now
// asked of proactiveintent.js.

module.exports = { init, TOOLS, TOOL_HELP, start, tick, triage, idleSeconds, quietNow, sigHydration, isEnabled, breaksOn, last: () => lastNudge };
