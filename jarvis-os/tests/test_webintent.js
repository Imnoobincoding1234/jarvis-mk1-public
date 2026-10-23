'use strict';
// NEEDS OLLAMA. Like test_intent.js and test_itemclass.js, this asks the embedder real questions,
// because the thing under test is a decision made by an embedder and a stub would only test the
// stub.
//
// WHAT THIS REPLACES. test_parse.js used to assert researchIntent() and stripResearch() — a regex
// listing the verbs that might introduce a request, and a second copy of that list used to cut the
// topic back out. Both are deleted. This suite asserts the PROPERTY they were standing in for:
// a question whose answer lives on the web reaches the web lane, and one that does not, does not.
//
// THE SWEEP IS RE-RUN, NOT REMEMBERED. The threshold in webintent.js was chosen from these numbers;
// if an exemplar changes, the numbers change, and this suite prints them and fails on the property
// rather than on a remembered constant. Nothing here is loaded by server.js.

const webintent = require('../webintent.js');
const intent = require('../intent.js');

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what); }
}
function head(t) { console.log('\n— ' + t + ' —'); }

// HELD OUT. Not one of these strings is an exemplar. Where the exemplars taught a concept
// ("open spotify"), this tests a different surface for it ("open brave", "safari band karo") —
// generalisation is the property under test, so conceptual overlap is the point and verbatim
// overlap would be marking its own homework.
const WEB = [
  'who is mrbeast',
  "what's the CEO of Microsoft called",
  'how old is Shah Rukh Khan',
  'who won the world cup in 2022',
  'has the new zelda game been released',
  'tell me about the new macbook air',
  'any update on the mars rover',
  "what's the news about the budget",
  'who is the ceo of spotify',
  'how much is a steam deck these days',
  'which phone did samsung just launch',
  'what is the diameter of jupiter',
  'india ka president kaun hai',
  // THE TWO KNOWN MISSES, LEFT IN ON PURPOSE. Both are Hindi lookups that fall just under the
  // threshold: "sundar pichai kaun hai" wins `person` correctly at 0.042 against a 0.05 gate, and
  // "nayi iphone kab release hogi" reads as an imperative and wins `command`. Deleting them from
  // this list would make the suite print a cleaner number than the system deserves, which is the
  // only thing a test set can do that is worse than being wrong.
  'sundar pichai kaun hai',
  'nayi iphone kab release hogi',
];
const LOCAL = [
  'is my laptop charging',
  'remind me what I told you last week',
  'open brave',
  'play something by drake',
  "what's 45 divided by 9",
  'write a bash script to rename files',
  'how do I fix this error',
  'cheers mate',
  'ok install among us',            // a guard that blocks this is worse than the bug it fixes
  'set an alarm for 7',
  'shorten that',
  'what do you know about me',
  'safari band karo',
  'mere contacts dikhao',
  'screenshot le lo',
  'meri photos kholo',
  'mere bhai ka naam kya hai',
  'mujhe kal kya karna hai',
];

(async () => {
  if (!await require('../ollama.js').reachable(1500)) {
    console.log('ollama is not reachable — this suite needs the embedder. Skipping.');
    process.exit(0);
  }

  head('a private question never reaches the web');
  // THE ERRORS ARE NOT SYMMETRICAL, and this is the half that must be perfect. A miss costs
  // nothing — the turn falls through to the behaviour that existed before. A false fire sends one
  // of his questions to a search engine.
  for (const t of LOCAL) {
    ok((await webintent.needsWeb(t)) === false, 'stays local: "' + t + '"');
  }

  head('a question whose answer lives on the web gets there');
  let fired = 0;
  for (const t of WEB) if (await webintent.needsWeb(t)) fired++;
  // Not all of them, and the number is the point rather than a pass mark: at the chosen threshold
  // two Hindi lookups still fall short and are caught at the other end by the hedge check instead.
  console.log('    ' + fired + '/' + WEB.length + ' web questions routed');
  ok(fired >= WEB.length - 3, 'at least ' + (WEB.length - 3) + '/' + WEB.length + ' routed (got ' + fired + ')');

  head('the two failures this was built for');
  // Both are exemplars, so this is in-domain and proves only that the wiring is live — the
  // held-out sets above are what measure whether it generalises.
  ok(await webintent.needsWeb('who is the CEO of BlackRock'), 'the BlackRock question routes to the web');
  ok(await webintent.needsWeb('who is yessmartypie'), 'the yessmartypie question routes to the web');

  head('separation, re-measured');
  // Rebuilt here rather than trusted: if someone edits an exemplar, these numbers move, and the
  // comment in webintent.js that records them should be moved with them.
  const cent = {};
  for (const [id, phrases] of Object.entries(webintent.WEB_INTENT_EXEMPLARS)) {
    const vecs = [];
    for (const p of phrases) { const v = await intent.embed(p); if (v) vecs.push(v); }
    const c = new Array(vecs[0].length).fill(0);
    for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
    for (let i = 0; i < c.length; i++) c[i] /= vecs.length;
    cent[id] = c;
  }
  const g = id => (webintent.WEB_REGIONS.has(id) ? 'web' : 'local');
  const marginOf = async (text) => {
    const v = await intent.embed(text);
    const scored = Object.entries(cent).map(([id, cv]) => ({ id, s: intent.cos(v, cv) }))
      .sort((a, b) => b.s - a.s);
    const winG = g(scored[0].id);
    const rival = scored.find(x => g(x.id) !== winG);
    return { win: scored[0].id, group: winG, margin: rival ? scored[0].s - rival.s : 1 };
  };
  let lowestRight = 1, highestWrong = 0;
  for (const t of WEB) { const r = await marginOf(t); if (r.group === 'web') lowestRight = Math.min(lowestRight, r.margin); }
  for (const t of LOCAL) { const r = await marginOf(t); if (r.group === 'web') highestWrong = Math.max(highestWrong, r.margin); }
  console.log('    lowest correct web margin : ' + lowestRight.toFixed(3));
  console.log('    highest wrong  web margin : ' + highestWrong.toFixed(3));
  console.log('    threshold in use          : ' + webintent.MIN_MARGIN);
  ok(webintent.MIN_MARGIN > highestWrong,
    'the threshold sits above every wrong case (' + webintent.MIN_MARGIN + ' > ' + highestWrong.toFixed(3) + ')');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
