'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// JARVIS dream mode — the work that is worth doing but never worth waiting for.
//
// Runs only when the machine is idle AND on mains power. Everything in here is
// something you would never sit through interactively: re-reading 27 books,
// distilling the day, drafting tomorrow's questions.
//
// Two rules make this safe to leave running:
//   1. It yields the moment you touch the keyboard. Every job checks between
//      units of work, so returning to the machine costs you nothing.
//   2. Nothing it does is user-visible or destructive. It writes caches and
//      indexes; it never sends, deletes, opens or changes anything you would
//      notice. The worst outcome of a failed dream cycle is a stale cache.
//
// The week in AI and machine learning (ainews.js) is the one job that reads the
// network: it gathers the week while he is away and only the Sunday greeting
// mentions it — the file with the full list is written when he asks for it.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let deps = {
  jlog: () => {}, stateDir: null, llm: null,
  idleSeconds: null, charging: null,
  library: null, recall: null, tutor: null,
  quizOn: null,                       // () => false when Settings → Daily quiz is off: no new study cards drafted
  briefing: null, ainews: null,
};
function init(d) { deps = Object.assign(deps, d || {}); }

const FILE = () => path.join(deps.stateDir || '/tmp', 'dream.json');
const MIN = 60000, HOUR = 3600000;

const IDLE_REQUIRED = 20 * 60;     // seconds away before we consider the machine free
const CHECK_EVERY = 5 * MIN;
const MIN_CYCLE_GAP = 4 * HOUR;    // do not re-dream every twenty minutes

let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { state = null; }
  if (!state || typeof state !== 'object') state = { enabled: true, lastCycle: 0, log: [], cache: {} };
  state.log = state.log || []; state.cache = state.cache || {};
  if (state.enabled == null) state.enabled = true;
  return state;
}
function save() { try { fs.writeFileSync(FILE(), JSON.stringify(load(), null, 2)); } catch (e) {} }

function note(what) {
  const s = load();
  s.log.unshift({ at: Date.now(), what });
  s.log = s.log.slice(0, 40);
  save();
  deps.jlog('Dream › ' + what);
}

// The yield check. Called between every unit of work — this is what makes dream
// mode invisible rather than annoying.
async function stillFree() {
  if (!load().enabled) return false;
  try {
    if (deps.idleSeconds && await deps.idleSeconds() < IDLE_REQUIRED / 2) return false;
    if (deps.charging && !(await deps.charging())) return false;
  } catch (e) { return false; }
  return true;
}

// ---------------- jobs ----------------
// Each returns a short string describing what it did, or null if it did nothing.

// 1. Re-index the library, but only if the books actually changed. Indexing 27
//    books takes ~9s and produces a 25MB file; doing it nightly for no reason is
//    pure waste.
async function jobReindexLibrary() {
  if (!deps.library) return null;
  const dir = deps.library.LIB_DIR;
  if (!dir || !fs.existsSync(dir)) return null;
  let newest = 0, count = 0;
  for (const folder of fs.readdirSync(dir)) {
    const fp = path.join(dir, folder);
    let st;
    try { st = fs.statSync(fp); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const name of fs.readdirSync(fp)) {
      if (!/\.(epub|pdf)$/i.test(name)) continue;
      count++;
      try { newest = Math.max(newest, fs.statSync(path.join(fp, name)).mtimeMs); } catch (e) {}
    }
  }
  const ix = deps.library.indexStatus ? deps.library.indexStatus() : null;
  if (ix && ix.at > newest && ix.books === count) return null;   // index is current
  const r = await deps.library.buildIndex();
  return r && r.ok ? 'reindexed the library (' + r.books + ' books, ' + r.passages + ' passages)' : null;
}

// 2. Distil the day into one episode, so "what did I do on Tuesday" has something
//    to retrieve that is not 200 raw turns.
async function jobDigestDay() {
  if (!deps.recall || !deps.llm) return null;
  const s = load();
  const today = new Date().toDateString();
  if (s.cache.lastDigest === today) return null;
  const since = Date.now() - 20 * HOUR;
  const eps = (deps.recall.recent ? deps.recall.recent(since) : []).filter(e => e.kind === 'turn' || e.kind === 'did');
  if (eps.length < 4) return null;
  const text = eps.slice(0, 60).map(e => '· ' + e.text.slice(0, 200)).join('\n');
  try {
    const r = await deps.llm({
      system: 'Summarise this day of interactions into 3-5 short bullet lines: what ' + profile.userRef() + ' worked on, what was decided, ' +
        'what is still open. Facts only, drawn from the log — no filler, no encouragement. Write it as a record, not a report to him.',
      messages: [{ role: 'user', content: text }],
      max_tokens: 300, timeoutMs: 90000,
    });
    const digest = String(r.text || '').trim();
    if (!digest) return null;
    deps.recall.log('digest', 'Day summary for ' + today + ':\n' + digest);
    s.cache.lastDigest = today; save();
    return 'distilled ' + eps.length + ' interactions into a day summary';
  } catch (e) { return null; }
}

// 3. The week in AI and machine learning, for Sunday's greeting: ~28 sources read,
//    and a short version written by the local model when the week has changed. It
//    checks `free` between sources, so coming back stops it mid-read, and the short
//    version is then made from headlines instead of loading the model.
async function jobAiNews(free) {
  if (!deps.ainews) return null;
  return await deps.ainews.job({ stillFree: free });
}

// 4. Draft tomorrow's study questions now, so "quiz me" is instant rather than a
//    30-second wait on a local model.
async function jobPrepCards() {
  if (deps.quizOn && !deps.quizOn()) return null;
  if (!deps.tutor || !deps.tutor.hasTopics || !deps.tutor.hasTopics()) return null;
  if (!deps.tutor.prepareCards) return null;
  const n = await deps.tutor.prepareCards(3);
  return n ? 'drafted ' + n + ' study question' + (n === 1 ? '' : 's') + ' for tomorrow' : null;
}

// 5. Precompute the morning briefing so it lands instantly at 8am.
async function jobPrepBriefing() {
  if (!deps.briefing) return null;
  const s = load();
  const h = new Date().getHours();
  if (h < 3 || h > 7) return null;         // only in the small hours — any earlier and it is stale by morning
  if (s.cache.briefingFor === new Date().toDateString()) return null;
  try {
    const text = await deps.briefing();
    if (!text) return null;
    s.cache.briefing = { at: Date.now(), text };
    s.cache.briefingFor = new Date().toDateString();
    save();
    return 'prepared your morning briefing';
  } catch (e) { return null; }
}

// 6. Housekeeping: flush the episode journal to disk properly and drop exact
//    duplicate turns that add nothing to retrieval.
async function jobCompact() {
  if (!deps.recall || !deps.recall.compact) return null;
  const n = deps.recall.compact();
  return n ? 'compacted ' + n + ' duplicate episodes' : null;
}

// The AI news job follows the day digest: both use the local model, which is then loaded once.
const JOBS = [jobReindexLibrary, jobDigestDay, jobAiNews, jobPrepCards, jobPrepBriefing, jobCompact];

// ---------------- the cycle ----------------
let running = false, timer = null;

async function cycle(force) {
  if (running) return null;
  const s = load();
  if (!s.enabled && !force) return null;
  if (!force && Date.now() - s.lastCycle < MIN_CYCLE_GAP) return null;
  if (!force && !(await stillFree())) return null;

  running = true;
  const done = [];
  const started = Date.now();
  // A job that works in several steps is handed this, to stop between them. "dream now" is his own
  // request, so a forced cycle is never told to yield.
  const free = force ? async () => true : stillFree;
  try {
    for (const job of JOBS) {
      if (!force && !(await stillFree())) { note('woke early — you came back'); break; }
      let r = null;
      try { r = await job(free); } catch (e) { deps.jlog('Dream job failed › ' + (e.message || e)); }
      if (r) done.push(r);
    }
    s.lastCycle = Date.now();
    if (done.length) note('cycle: ' + done.join('; ') + ' (' + Math.round((Date.now() - started) / 1000) + 's)');
    save();
  } finally { running = false; }
  return done;
}

function start() {
  if (timer) return;
  timer = setInterval(() => cycle().catch(e => deps.jlog('Dream cycle failed › ' + (e.message || e))), CHECK_EVERY);
  if (timer.unref) timer.unref();
  deps.jlog('Dream › idle worker armed (needs ' + (IDLE_REQUIRED / 60) + ' min idle + mains power)');
}

// ---------------- tools ----------------
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});

function cachedBriefing() {
  const c = load().cache.briefing;
  if (!c || Date.now() - c.at > 12 * HOUR) return null;
  return c.text;
}

async function dream_now() {
  const done = await cycle(true);
  if (!done || !done.length) return ok('Nothing needed doing, Sir — everything is already current.');
  return ok('Done, Sir — ' + done.join('; ') + '.');
}

function dream_log() {
  const s = load();
  if (!s.log.length) return ok('I have not dreamt yet, Sir — it needs ' + (IDLE_REQUIRED / 60) + ' minutes idle on mains power.');
  const rows = s.log.slice(0, 8).map(l => new Date(l.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' — ' + l.what);
  return ok('What I have done while you were away, Sir:\n' + rows.join('\n'));
}

// ON OR OFF IS NEVER READ OUT OF WORDS. It used to be: `off|stop|disable` in the text meant off, so
// anything else — "dream mode band kar do", "turn it on" — meant on. Now the caller must say which: the
// chat lane offers the other state as a word (server.js), and the agent passes {enabled}. Without a real
// true/false nothing changes, and he is told the state it is in.
function dream_set(args) {
  const s = load();
  if (!args || typeof args.enabled !== 'boolean') {
    return { ok: false, say: 'Dream mode is ' + (s.enabled ? 'on' : 'off') + ', Sir — say whether you want it on or off.' };
  }
  s.enabled = args.enabled;
  save();
  return ok(s.enabled ? 'Dream mode armed, Sir — I will tidy up while you are away.' : 'Dream mode off, Sir.');
}
function isEnabled() { return !!load().enabled; }

const TOOLS = { dream_now, dream_log, dream_set };
const TOOL_HELP = {
  dream_now: 'dream_now{}. Run the idle-time maintenance cycle immediately.',
  dream_log: 'dream_log{}. What JARVIS did during idle time.',
  dream_set: 'dream_set{enabled}. Turn idle-time work on or off.',
};
// DREAM_RE lived here until 2026-09-18 — a word list that ran maintenance for "tidy up my desktop".
// Which dream request a sentence is, is now asked of dreamintent.js.

module.exports = { init, TOOLS, TOOL_HELP, start, cycle, cachedBriefing, isEnabled };
