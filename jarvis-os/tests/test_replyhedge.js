'use strict';
// NEEDS OLLAMA. Not loaded by server.js — measures the runtime decider, is not part of it.

const hedge = require('../replyhedge.js');
const intent = require('../intent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

// HELD OUT — none of these is an exemplar.
const SHOULD_SEARCH = [
  "I'm sorry, but I don't have details about that person.",
  'My training data may not include the most recent information on this.',
  'I would check the company website for the current figures.',
  'I am unable to look that up right now, so please verify independently.',
  "I'm not certain — that may have changed since my knowledge cutoff.",
];
const SHOULD_NOT = [
  // real answers
  'Sundar Pichai is the CEO of Google.',
  'The file is on your desktop, Sir.',
  'That comes to 1,240 rupees.',
  'Python and Rust differ mainly in memory management.',
  'Good morning, Sir.',
  // a capability limit is not a knowledge gap
  'I cannot read your notifications without Full Disk Access.',
  'I will not dial an emergency number, Sir.',
  // a gap about HIM is not a reason to search the web
  'You have not saved anything under that name, Sir.',
  'I have no note of that conversation.',
  'Your calendar has nothing for tomorrow.',
];

(async () => {
  if (!await require('../ollama.js').reachable(1500)) {
    console.log('ollama is not reachable — this suite needs the embedder. Skipping.');
    process.exit(0);
  }

  head('the two replies this was built for');
  // THE REAL STRINGS, from his terminal. The first is the one that matters most: a fabricated name
  // with the retraction stapled on the END, which is why this reads the tail as well as the head.
  ok(await hedge.saysGoLookItUp(
    'The CEO of BlackRock as of recent information is Christopher A. "A. Chris" Garthwaite. ' +
    'However, for the most current and accurate information, I would recommend checking the ' +
    'official BlackRock website or a recent business news source.'),
    'catches a fabricated answer with a disclaimer at the end');
  ok(await hedge.saysGoLookItUp("I don't have information about that."),
    'catches a plain knowledge gap');

  head('pieces are word windows, not sentences');
  // No punctuation anywhere: the old split at . ! ? read this as one sentence. The hedge sits in the last window.
  ok(await hedge.saysGoLookItUp('the chief executive right now is somebody called a chris garthwaite who took over a while back however ' +
    'for the most current and accurate information i would recommend checking the official company website or a recent business news source'),
    'catches a hedge at the end of a reply with no punctuation at all');
  ok((await hedge.saysGoLookItUp('paris is the capital of france and it sits on the seine river in the north of the country it has been the ' +
    'capital for many centuries and is known for the eiffel tower')) === false, 'leaves a long unpunctuated answer alone');
  ok(hedge.WINDOW === 16, 'reads 16-word windows (the size measured in sweeps/sweep_hedgesplit.js)');

  head('a reply that announces doubt about the world');
  for (const t of SHOULD_SEARCH) ok(await hedge.saysGoLookItUp(t), 'searches: "' + t.slice(0, 52) + '…"');

  head('a reply that answered, or that is about HIM, is left alone');
  for (const t of SHOULD_NOT) ok((await hedge.saysGoLookItUp(t)) === false, 'leaves alone: "' + t.slice(0, 52) + '…"');

  head('separation, re-measured');
  const cent = {};
  for (const [id, phrases] of Object.entries(hedge.HEDGE_EXEMPLARS)) {
    const vecs = [];
    for (const p of phrases) { const v = await intent.embed(p); if (v) vecs.push(v); }
    const c = new Array(vecs[0].length).fill(0);
    for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
    for (let i = 0; i < c.length; i++) c[i] /= vecs.length;
    cent[id] = c;
  }
  const g = id => hedge.GROUPS[id];
  const marginOf = async (text) => {
    const v = await intent.embed(text);
    const scored = Object.entries(cent).map(([id, cv]) => ({ id, s: intent.cos(v, cv) })).sort((a, b) => b.s - a.s);
    const winG = g(scored[0].id);
    const rival = scored.find(x => g(x.id) !== winG);
    return { win: scored[0].id, group: winG, margin: rival ? scored[0].s - rival.s : 1 };
  };
  let lowestRight = 1, highestWrong = 0, worst = '(none)';
  for (const t of SHOULD_SEARCH) { const r = await marginOf(t); if (r.group === 'search') lowestRight = Math.min(lowestRight, r.margin); }
  for (const t of SHOULD_NOT) {
    const r = await marginOf(t);
    if (r.group === 'search' && r.margin > highestWrong) { highestWrong = r.margin; worst = t; }
  }
  console.log('    lowest correct hedge margin : ' + lowestRight.toFixed(3));
  console.log('    highest wrong   hedge margin: ' + highestWrong.toFixed(3) + '   ("' + worst.slice(0, 46) + '")');
  console.log('    threshold in use            : ' + hedge.MIN_MARGIN);
  ok(hedge.MIN_MARGIN > highestWrong, 'threshold clears every wrong case');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
