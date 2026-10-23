'use strict';
// MEASUREMENT SCRIPT — not a test. Two questions, measured on ONE held-out set:
//
//   Q2  can the EMBEDDER gate it — "is this a commerce/media errand at all?" — so the 3B is only
//       woken for sentences that are one? The gate replaces ARB_CANDIDATES.verbs, whose whole job
//       was "an action needs a verb", and it has to be cheap because it runs on every turn.
//
// GROUND TRUTH. Two halves, both written before any number was read:
//   PINNED    the expectations already asserted in test_parse / test_sitekind. A mechanism that
//             breaks one of these is a regression, not a trade-off.
//   HELDOUT   new sentences, written to cover the words the three regexes never contained.
// Nothing below is edited after a run. Tuning by adding the exemplar that fixes a failing case is
// the trap one level up.

const path = require('path');
const intent = require('../intent.js');

// ---------------------------------------------------------------------------
// THE SET
// ---------------------------------------------------------------------------
const PINNED = [
  ['order hiking boots from amazon', 'shop'],
  ['order a birthday cake from amazon', 'shop'],
  ['order me a pizza from dominos', 'food'],
  ['get me something from swiggy', 'food'],
  ['order me momos', 'food'],
  ['order hiking boots', 'shop'],
  ['order dinner', 'food'],
  ['order something', null],
  ['play judas by lady gaga', 'music'],
  ['play the latest yessmartypie video', 'video'],
  ['what is my battery', null],
  ['create a file called notes.txt on my desktop', null],
  ['open safari', null],
  ['what is my favourite pizza?', null],
  ['remind me to drink water in 3 hours', null],
  ['order apples from instamart', 'grocery'],
  ['order milk from blinkit', 'grocery'],
  ['order a pizza from swiggy', 'food'],
  ['order onions from swiggy instamart', 'grocery'],
  ['order a keyboard from amazon', 'shop'],
  // clause-level strings the splitter hands to arbitrate() one at a time
  ['order cake from swiggy', 'food'],
  ['order me a pizza from swiggy', 'food'],
  ['get me 2kg apples from instamart', 'grocery'],
  ['get a chocolate cake from swiggy', 'food'],
  ['get a keyboard on amazon under 3000', 'shop'],
  ['order pizza from swiggy', 'food'],
  ['order biryani from zomato', 'food'],
  // VERBLESS CLAUSES. English elides the verb after a conjunction, and the splitter depends on
  // these NOT resolving so it can restore it — see expandElided. Pinned from test_parse's splits.
  ['cake from swiggy', null],
  ['a keyboard from amazon', null],
  ['biryani from zomato', null],
  ['a chocolate cake from swiggy', null],
  ['spotify', null],
  ['my ram', null],
];

const HELDOUT = [
  // prepared food, no destination named — the half a word list keeps missing
  ['order me some samosas', 'food'],
  ['get me a chicken biryani', 'food'],
  ['order two plates of chole bhature', 'food'],
  ['i want a shawarma', 'food'],
  ['order a masala dosa', 'food'],
  ['order some butter chicken tonight', 'food'],
  // raw ingredients, no destination named
  ['order some atta', 'grocery'],
  ['buy 2kg onions', 'grocery'],
  ['order a packet of toor dal', 'grocery'],
  ['get me some anjeer', 'grocery'],
  ['buy me a watermelon', 'grocery'],
  ['order chicken breast', 'grocery'],
  // the live bugs the generic-word regexes caused: a product category read as a meal
  ['buy cat food', 'grocery'],
  ['order dog food', 'grocery'],
  ['order coffee beans', 'grocery'],
  // durables
  ['buy a mechanical keyboard', 'shop'],
  ['order a standing desk', 'shop'],
  ['buy me some running shoes', 'shop'],
  ['order a new bedsheet', 'shop'],
  // media
  ['play some lofi beats', 'music'],
  ['put on bohemian rhapsody', 'music'],
  ['play the new kendrick album', 'music'],
  ['play the latest mrbeast video', 'video'],
  ['watch the oppenheimer trailer', 'video'],
  ['put on a documentary about everest', 'video'],
  // NOT an errand. Every one of these must score nothing, or a lane that works today breaks.
  ['what is the weather today', null],
  ['take a screenshot', null],
  ['message mama on whatsapp', null],
  ['search cats on youtube', null],
  ['what do you know about me', null],
  ['how many apps are running', null],
  ['research quantum computing', null],
  ['find my resume', null],
  ['what is a samosa', null],
  ['should i order a laptop', null],
  ['open the app store and search for action games', null],
  ['whats my ram at', null],
  ['remind me to buy milk tomorrow', null],
  ['close spotify', null],
  ['empty the trash', null],
  ['who is the ceo of blackrock', null],
];

const ALL = PINNED.map(x => [x[0], x[1], 'pinned']).concat(HELDOUT.map(x => [x[0], x[1], 'heldout']));

// ---------------------------------------------------------------------------
// Q2 — the embedder, as a GATE. Regions, not a verb list: an errand frame on one side, and the
// several coherent regions of "not an errand" on the other. A single `none` region would be the
// junk drawer this codebase has been bitten by three times, so the not-an-errand half is split and
// rejoined with `groups` — every one of them still answers "not an errand".
// ---------------------------------------------------------------------------
const E = require('../errand.js');
const EXEMPLARS = E.EXEMPLARS;
const GROUPS = E.GROUPS;

(async () => {
  const which = process.argv[2] || 'both';

  if (which === 'both' || which === 'gate') {
    console.log('\n=== Q2: the embedder as a gate (errand / not) ===');
    // Swept, not chosen: the threshold is read off the data below rather than picked in advance.
    for (const m of [0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.10]) {
      const classify = intent.makeClassifier({
        exemplars: EXEMPLARS, groups: GROUPS, none: 'none', minMargin: m, label: 'Errand',
      });
      let tp = 0, tn = 0, fp = 0, fn = 0;
      const leaks = [];
      for (const [s, want] of ALL) {
        const r = await classify(s);
        const said = !!(r && r.group === 'errand');
        const isErrand = want !== null;
        if (said && isErrand) tp++;
        else if (!said && !isErrand) tn++;
        else if (said && !isErrand) { fp++; leaks.push('FP "' + s + '"'); }
        else { fn++; leaks.push('FN "' + s + '"'); }
      }
      console.log('  margin ' + m.toFixed(2) + '  ' + (tp + tn) + '/' + ALL.length +
        '  (kept ' + tp + '/' + ALL.filter(x => x[1] !== null).length + ' errands, ' +
        fp + ' false opens, ' + fn + ' dropped)');
      if (m === 0.02) console.log('    ' + leaks.join('\n    '));
    }
  }
})();
