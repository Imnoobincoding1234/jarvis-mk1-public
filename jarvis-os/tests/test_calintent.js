'use strict';
// NEEDS OLLAMA. The thing under test is a decision made by an embedder; a stub would test the stub.
// Not loaded by server.js — this measures the runtime decider, it is not part of it.

const cal = require('../calintent.js');
const intent = require('../intent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

// HELD OUT — none of these is an exemplar.
const CAL = [
  "what's on my schedule for thursday",
  'do i have any meetings tomorrow',
  'am i free at 3',
  'when is my next appointment',
  'book me a slot on monday',
  'have i got anything booked this evening',
  'kal koi meeting hai kya',
];
const NOT_CAL = [
  'where did i put that spreadsheet',
  'look up the population of peru',
  'open brave',
  "what's my battery",
  'what day is it',
  'cheers mate',
  'play something by drake',
  'message dad',
  'summarise that',
  'safari band karo',
  // HINDI QUESTIONS, ADDED AFTER THIS SUITE MISSED A LIVE REGRESSION. The NOT_CAL list held exactly
  // one Hindi case and it was an IMPERATIVE, so nothing here exercised a Hindi QUESTION — and a
  // Hindi question was precisely what broke: the `calendar` region was the only one in this file
  // with any Hindi in it, so "sundar pichai kaun hai" was classified as a diary question and routed
  // to the agent lane. The repair was to give every competing region the language, not to special-
  // case the sentence; these are here so the hole cannot reopen silently.
  'sundar pichai kaun hai',
  'mrbeast kaun hai',
  'battery kitni hai',
  'mera naam kya hai',
];

(async () => {
  if (!await require('../ollama.js').reachable(1500)) {
    console.log('ollama is not reachable — this suite needs the embedder. Skipping.');
    process.exit(0);
  }

  head('the two cases pinned since the regex days');
  // IN-DOMAIN, and labelled as such: both are exemplars, so this proves the wiring is live and the
  // old regressions cannot come back, not that the classifier generalises. The held-out sets do that.
  ok((await cal.isCalendarIntent('find my resume')) === false, 'does NOT steal file search');
  ok((await cal.isCalendarIntent('find out about tokamaks')) === false, 'does NOT steal a lookup');

  head('calendar questions are recognised');
  let got = 0;
  for (const t of CAL) { const r = await cal.isCalendarIntent(t); if (r) got++; ok(r, 'calendar: "' + t + '"'); }

  head('everything else is left alone');
  for (const t of NOT_CAL) ok((await cal.isCalendarIntent(t)) === false, 'not calendar: "' + t + '"');

  head('separation, re-measured');
  const cent = {};
  for (const [id, phrases] of Object.entries(cal.CAL_EXEMPLARS)) {
    const vecs = [];
    for (const p of phrases) { const v = await intent.embed(p); if (v) vecs.push(v); }
    const c = new Array(vecs[0].length).fill(0);
    for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
    for (let i = 0; i < c.length; i++) c[i] /= vecs.length;
    cent[id] = c;
  }
  const g = id => cal.GROUPS[id];
  const marginOf = async (text) => {
    const v = await intent.embed(text);
    const scored = Object.entries(cent).map(([id, cv]) => ({ id, s: intent.cos(v, cv) })).sort((a, b) => b.s - a.s);
    const winG = g(scored[0].id);
    const rival = scored.find(x => g(x.id) !== winG);
    return { win: scored[0].id, group: winG, margin: rival ? scored[0].s - rival.s : 1 };
  };
  let lowestRight = 1, highestWrong = 0, worstWrong = '(none)';
  for (const t of CAL) { const r = await marginOf(t); if (r.group === 'cal') lowestRight = Math.min(lowestRight, r.margin); }
  for (const t of NOT_CAL) {
    const r = await marginOf(t);
    if (r.group === 'cal' && r.margin > highestWrong) { highestWrong = r.margin; worstWrong = t; }
  }
  console.log('    lowest correct calendar margin : ' + lowestRight.toFixed(3));
  console.log('    highest wrong   calendar margin: ' + highestWrong.toFixed(3) + '   ("' + worstWrong + '")');
  console.log('    threshold in use               : ' + cal.MIN_MARGIN);
  ok(cal.MIN_MARGIN > highestWrong, 'threshold clears every wrong case');
  ok(lowestRight >= cal.MIN_MARGIN, 'threshold admits every correct case');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
