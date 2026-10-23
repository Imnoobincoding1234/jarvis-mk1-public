'use strict';
// ---------------------------------------------------------------------------
// IS HE ASKING WHY JARVIS DID WHAT IT JUST DID? — asked of the embedder, not spelled out. 2026-09-26.
//
// The question the "why did you do that?" lane answers (explain.js, from the last turn's own log). Recognising
// it by a phrase list would be exactly the kind of trap this project removes: "why did u open chrome", "itna
// time kyu laga", "what made u do that" share no fixed words, and "why is my mac slow" shares most of them
// while asking something else entirely.
//
// ONE REGION FOR THE QUESTION, AND THE LOOK-ALIKES IT MUST BEAT BY THE MARGIN (groups, as in
// proactiveintent.js): a why-question about the world, a why-question about the machine (the system report
// answers those), what JARVIS did EARLIER or overnight (recall / dream report), undo and redo, and what it
// CAN do. Below the margin the answer is "no" and the turn carries on untouched — a miss costs him asking
// again in other words; a false yes answers a question about the sky with a routing log.
//
// Held-out: finetune/data/whyintent_heldout.json, written before these exemplars; none of it is here.
// Every region carries English and Hinglish in proportion.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const WHY_EXEMPLARS = {
  why_last: [
    'why did you open that',
    'why did u do it that way',
    'why did it take so long just now',
    'how come that was so slow',
    'what made you pick that',
    'why did you answer like that',
    'why did you send that to the reasoning model',
    'why did u search online for that',
    'why didnt you just open it',
    'why did you ask me instead of doing it',
    'explain your last answer',
    'why did you say that',
    'ye kyu kiya tumne',
    'itni der kyu lagi',
    'aisa kyu kiya',
  ],
  world_why: [
    'why is the ocean salty',
    'why do we dream',
    'why did the roman empire fall',
    'why do leaves change colour',
    'why should i drink more water',
    'why do people like horror movies',
    'barish kyu hoti hai',
    'log jhooth kyu bolte hai',
  ],
  machine_why: [
    'why is my laptop so hot',
    'why is my wifi slow',
    'why is chrome using so much ram',
    'why wont my mac charge',
    'why is my disk full',
    'mera laptop slow kyu hai',
  ],
  earlier: [
    'what did you do last night',
    'what did we talk about yesterday',
    'what have you done today',
    'what did i ask you this morning',
    'kal maine kya pucha tha',
  ],
  redo_undo: [
    'undo it',
    'do it again',
    'reverse what you just did',
    'try that one more time',
    'cancel that',
    'wapas karo',
  ],
  capability: [
    'what are you able to do',
    'how do you work',
    'what can you help me with',
    'explain how you decide things in general',
    'tum kya kya kar sakte ho',
  ],
};

const GROUPS = {};
for (const id of Object.keys(WHY_EXEMPLARS)) GROUPS[id] = id === 'why_last' ? 'why_last' : 'not_why';

// MEASURED 2026-09-26 — sweeps/sweep_whygate.js. Chosen by LEAVE-ONE-OUT on these exemplars only (15 why, 30
// look-alikes): no look-alike is called a why-question from 0.025 up, and the catch rate is flat at 11/15 over
// 0.025–0.030, so the safer end of that flat, 0.03. Held-out (whyintent_heldout.json, written first), reported
// only: 12/14 caught, 0/14 false yes. Missed: "why was that so slow" (0.026), "itna time kyu laga" (0.016) — he
// asks again; nothing wrong happens.
const MIN_MARGIN = process.env.JARVIS_WHY_MARGIN != null ? Number(process.env.JARVIS_WHY_MARGIN) : 0.03;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }
function classifier() {
  if (!_classify) {
    _classify = intent.makeClassifier({
      exemplars: WHY_EXEMPLARS, minMargin: MIN_MARGIN, none: 'not_why', groups: GROUPS,
      label: 'Why', jlog: (m) => _jlog(m),
    });
  }
  return _classify;
}

// true only when "why did you just…" beats every look-alike by the margin; the embedder down → false.
async function isWhyLast(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return false;
  try { const r = await classifier()(t); return !!(r && r.id === 'why_last'); } catch (e) { return false; }
}

module.exports = { init, isWhyLast, WHY_EXEMPLARS, GROUPS, MIN_MARGIN };
