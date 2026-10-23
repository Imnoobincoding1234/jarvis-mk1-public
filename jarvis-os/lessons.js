'use strict';
// ---------------------------------------------------------------------------
// JARVIS lessons — the agent's memory of what did NOT work.
//
// WHAT WAS MISSING. harness.recoveryHint() steers the model around a failure it just hit, and then
// the run ends and takes the knowledge with it. Ask the same thing tomorrow and the loop walks into
// the identical wall: same wrong app name, same missing permission, same tool that cannot do the
// job. Every failure was paid for once per asking, forever.
//
// This stores the ones that could not be recovered from, keyed by the goal that produced them, and
// hands them back as constraints the next time a similar goal comes round. It is the difference
// between an agent that retries and an agent that learns.
//
// WHAT IT DELIBERATELY DOES NOT STORE. Only the tool, a short target, and the reason — never the
// content of a file, a message, or anything he typed. A failure store that accumulates payloads is
// a transcript of his private data wearing a different name, and this one gets read back into a
// prompt, which is the exact path that can reach a cloud model.
//
// The matching and phrasing are pure and live in harness.js (goalTerms/pickLessons/lessonLines);
// this file is only the store. Same split as everything else: policy where it can be tested,
// I/O where it has to be.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

let deps = { jlog: () => {} };
function init(d) { deps = Object.assign(deps, d || {}); }

const FILE = path.join(__dirname, 'state', 'lessons.json');
const MAX_LESSONS = 200;        // pruned oldest-first; this is a cache, not an archive
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;   // a 3-month-old grievance is not evidence

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    cache = Array.isArray(j) ? j : [];
  } catch (e) {
    cache = [];                 // absent or corrupt — an empty store is a valid state, not an error
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // Written through a temp file and renamed: a half-written lessons.json read back at the next
    // boot is indistinguishable from a corrupt one, and rename is atomic on the same filesystem.
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache || [], null, 0));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    deps.jlog('Lessons › could not save: ' + e.message);
  }
}

// Records a failure worth remembering. Idempotent on (goal-ish, tool, target): asking the same
// thing twice bumps a counter rather than filling the store with copies of one grudge.
function learn(entry) {
  entry = entry || {};
  const tool = String(entry.tool || '').trim();
  const why = String(entry.why || '').trim();
  const goal = String(entry.goal || '').trim();
  if (!tool || !goal) return null;

  const all = load();
  const target = H.clip(String(entry.target || ''), 80);
  const now = Date.now();

  const hit = all.find(l => l.tool === tool && (l.target || '') === target &&
    H.lessonScore(goal, l) >= 0.6);
  if (hit) {
    hit.hits = (hit.hits || 1) + 1;
    hit.at = now;
    hit.why = H.clip(why, 140) || hit.why;
    save();
    return hit;
  }

  const lesson = { goal: H.clip(goal, 160), tool, target, why: H.clip(why, 140),
    kind: String(entry.kind || 'fail'), at: now, hits: 1 };
  all.push(lesson);

  // Prune: expired first, then oldest, so a store at capacity loses its least relevant entry
  // rather than refusing to learn anything new.
  const fresh = all.filter(l => now - (l.at || 0) < MAX_AGE_MS);
  fresh.sort((a, b) => (a.at || 0) - (b.at || 0));
  cache = fresh.slice(Math.max(0, fresh.length - MAX_LESSONS));
  save();
  return lesson;
}

// The lines to put in front of the planner for this goal. Empty array when nothing is relevant —
// which is the common case, and must cost nothing.
// `allowTools`, when a procedure scopes the run, drops lessons about tools this run cannot call at
// all. Filtered BEFORE the top-k cut, so a scoped run still gets its k most relevant APPLICABLE
// lessons rather than k slots half-filled with warnings about forbidden tools.
function recall(goal, k, allowTools) {
  let pool = load();
  if (Array.isArray(allowTools) && allowTools.length) {
    const ok = new Set(allowTools);
    pool = pool.filter(l => ok.has(l.tool));
  }
  const picked = H.pickLessons(goal, pool, k || 3);
  return H.lessonLines(picked);
}

// A lesson that turns out to be wrong should not haunt the agent forever. When a goal SUCCEEDS
// using a tool a lesson warned against, the lesson was either stale or never right — drop it.
// Without this the store only ever accumulates pessimism, and an agent that has learned only what
// cannot be done eventually refuses to try anything.
function unlearn(goal, tool) {
  const all = load();
  const before = all.length;
  cache = all.filter(l => !(l.tool === tool && H.lessonScore(goal, l) >= H.LESSON_FLOOR));
  if (cache.length !== before) {
    deps.jlog('Lessons › dropped ' + (before - cache.length) + ' — ' + tool + ' worked this time');
    save();
  }
  return before - cache.length;
}

function all() { return load().slice(); }
function clear() { cache = []; save(); }

// ---------------- tool ----------------
// Asking it what it has learned is the only way to audit this from outside, and an unauditable
// store quietly steering every plan is the thing nobody should ship.
const TOOLS = {
  what_i_learned: async (args) => {
    const list = load();
    if (!list.length) return { ok: true, say: 'Nothing yet, Sir — no failure has repeated itself enough to be worth remembering.' };
    const q = String((args && args.about) || '').trim();
    const picked = q ? H.pickLessons(q, list, 8) : list.slice(-8).reverse();
    if (!picked.length) return { ok: true, say: 'Nothing I have learned bears on that, Sir.' };
    const lines = picked.map(l => '· ' + l.tool + (l.target ? ' on ' + l.target : '') +
      ' — ' + l.why + (l.hits > 1 ? ' (hit ' + l.hits + ' times)' : ''));
    return { ok: true, data: picked,
      say: 'What I have learned not to do' + (q ? ' about that' : '') + ', Sir:\n' + lines.join('\n') };
  },
};

const TOOL_HELP = {
  what_i_learned: 'what_i_learned{about?} — the failures worth remembering, optionally filtered by topic',
};

module.exports = { init, TOOLS, TOOL_HELP, learn, recall, unlearn, all, clear, FILE, MAX_LESSONS };
