'use strict';
// ---------------------------------------------------------------------------
// IS THIS A QUESTION TO WORK OUT? — asked of the embedder, not spelled out.
//
// WHAT THIS REPLACES (2026-09-25). server.js looksLikeReasoning: IMPERATIVE_RE (a verb list), QUANTITY_RE
// and NUM_RE (number words), DERIVE_RE ("how many", "sum of", "altogether", "what percentage" …),
// ARITH_OP_RE ("plus", "minus" …), CLOCK_RE + DURATION_RE ("min", "hours" …). His question
//
//     "so if we were to take 2 cubes, one whose area is 12cm square and the other square's area being
//      14 cm square, what will be their sum?"
//
// said "their sum", not "sum of", so it was not a word problem: the reference resolver asked the 3B what
// "their" meant (12 s) and the 3B answered it as chat (21.5 s) — 43 s for 12 + 14. On a held-out set
// written before this file (finetune/data/reasongate_heldout.json) the lists caught 6 of 22 worked-out
// questions.
//
// ONE REGION FOR THE QUESTION WORKED OUT FROM WHAT THE SENTENCE STATES, AND FOUR LOOK-ALIKES THAT CARRY
// NUMBERS TOO: an instruction ("set a timer for 10 min"), a question about the machine or his own data
// ("how many tabs do i have open" — answering it from a model would invent the tabs), a fact to look up
// ("what year was the first iphone released"), and chat ("i ran 5 km today"). The reasoning region has to
// beat the NEAREST of them by the margin (groups, as in proactiveintent.js). Below it, the answer is "no":
// a miss costs the ordinary chat model answering, which is the old behaviour; a false yes on a machine
// question would skip the lane that has the real data.
//
// Every region carries English and Hinglish in proportion. None of these sentences is in the held-out set.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const REASON_EXEMPLARS = {
  // WORKED OUT FROM WHAT THE SENTENCE STATES.
  reasoning: [
    'if 3 notebooks cost 90 how much do 7 cost',
    'a shirt was 1200 and now its 900 whats the discount percent',
    'i need 75 percent attendance and have attended 42 of 60 classes can i skip any',
    'we left at 9:15 and reached at 11:50 how long was the drive',
    'whats the area of a circle with radius 7',
    'if a tank fills in 6 hrs and drains in 9 how long to fill it with both open',
    'split a 2400 bill between 6 friends',
    'whats 17 percent of 3500',
    'how many seconds are there in 3 days',
    'which is cheaper 1 kg for 240 or 750 g for 170',
    'my exam is in 38 days how many weeks is that',
    'if x plus 7 is 19 whats x',
    'the sum of two numbers is 50 and one is 18 whats the other',
    'every student gets 4 chocolates and there are 27 students how many do i buy',
    'a bus comes every 12 min and i just missed the 5:03 one when is the next',
    'is 97 divisible by 7',
    'all dogs bark and tommy is a dog so does tommy bark',
    'whats the volume of a box 10 by 4 by 3',
    'convert 68 fahrenheit to celsius',
    'agar ek kilo aam 80 ka hai to 3.5 kilo kitne ka',
    '100 mein se 37 kitna percent hua',
    '6:45 pe nikle aur 2 ghante lage to kab pahunchenge',
    'do numbers ka jod 30 aur farak 6 hai numbers batao',
    '12 dozen mein kitne ande hote hai',
  ],
  // AN INSTRUCTION, numbers and all.
  command: [
    'open the 2nd tab in brave',
    'set an alarm for 6:30',
    'remind me in 15 min to check the oven',
    'turn brightness to 70',
    'play song number 3 from my playlist',
    'create 4 folders on the desktop',
    'close the last 2 windows',
    'text mama that ill be home by 9',
    'schedule a message to parth at 8 pm',
    'take a screenshot in 5 seconds',
    'open chrome and search top 5 phones under 30000',
    'delete files older than 30 days from downloads',
    'volume 20 pe kar do',
    '10 min ka timer laga do',
  ],
  // THE MACHINE, OR HIS OWN DATA — the answer lives somewhere a lane can read it.
  machine: [
    'how much storage is free',
    'whats my battery at',
    'how many tabs do i have open',
    'how much ram is chrome using',
    'whats on my calendar at 3',
    'how many reminders do i have today',
    'when is my next meeting',
    'how many unread messages do i have',
    'what time is it',
    'how long have i been on my laptop today',
    'mera battery kitna hai',
    'kitne apps chal rahe hai',
  ],
  // A FACT TO LOOK UP — the number is out in the world, not in the sentence.
  lookup: [
    'who scored the most runs in 2023',
    'when did india get independence',
    'what year was the first iphone released',
    'how far is the moon from earth',
    'whats the price of the iphone 17 in india',
    'how many people live in tokyo',
    'what is the speed of light',
    'who is the richest person in 2026',
    'when is diwali this year',
    'what is the boiling point of water',
    'kal ka match kaun jeeta',
    'bitcoin ka price kya hai',
  ],
  // CHAT that happens to carry a number.
  chat: [
    'i ran 5 km today felt great',
    'got 90 in physics lets go',
    'its been 3 days since i slept properly',
    'my phone is 2 years old now',
    'i have like 4 assignments due',
    'woke up at 11 again lol',
    'bro its 40 degrees outside',
    'im 17 btw',
    'thanks for the help earlier',
    'hi jarvis whats up',
    'aaj 2 ghante padha',
    'kal 3 baje tak jaga tha',
  ],
};

const GROUPS = {};
for (const id of Object.keys(REASON_EXEMPLARS)) GROUPS[id] = id === 'reasoning' ? 'reasoning' : 'not_reasoning';

// FALLBACK ONLY (used when reasongate.weights.json is missing). MEASURED, sweeps/sweep_reasongate.js:
// leave-one-out on these exemplars puts 0.03 at the first margin with no look-alike called reasoning (11/24
// caught, 0/50 false); on held-out #1 it caught 12/22 with 0/22 false.
const MIN_MARGIN = process.env.JARVIS_REASON_MARGIN != null ? Number(process.env.JARVIS_REASON_MARGIN) : 0.03;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }

function classifier() {
  if (!_classify) {
    _classify = intent.makeClassifier({
      exemplars: REASON_EXEMPLARS, minMargin: MIN_MARGIN, none: 'not_reasoning', groups: GROUPS,
      label: 'Reasoning', jlog: (m) => _jlog(m),
    });
  }
  return _classify;
}

// THE TRAINED READER (round 3, 2026-09-25) — a softmax over the sentence's nomic embedding, trained by
// finetune/train_reasongate.js on finetune/data/reasongate_train.jsonl (426 rows; the exemplars above are
// among them). Embedder, L2 and τ chosen by 5-fold CV on the training rows only, first for ZERO look-alikes
// called reasoning: nomic, τ 0.8 — CV 125/179 caught, 0/247 false. Held-out, scored once each:
//
//     set                                   caught   false alarms
//     #1 (written first; misses read)       15/22    0/22     (the old regex gate: 6/22, 0/22)
//     #2 (fresh for round 2; misses read)   23/28    0/28
//     #3 (fresh for round 3)                21/28    0/28
//
// The centroid regions above reach 12/22 on #1 at margin 0.03 and are the fallback if the weights file is
// missing. NOT 100%: an embedding reads what a sentence is about, not whether its answer can be derived from
// it ("is 1 a prime number" sits beside "explain what a prime number is"). The lasting fix is a read in the
// reader model. His call: ship this now, keep going to 100%.
let _weights;
function weights() {
  if (_weights !== undefined) return _weights;
  try {
    const w = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'reasongate.weights.json'), 'utf8'));
    _weights = (w && Array.isArray(w.W) && Array.isArray(w.models) && typeof w.tau === 'number' && w.classes[0] === 'reasoning') ? w : null;
  } catch (e) { _weights = null; }
  return _weights;
}
const _seen = new Map();
async function pReasoning(t) {
  const w = weights();
  const key = t.toLowerCase().trim().replace(/\s+/g, ' ');   // exactly what the trainer embedded
  if (_seen.has(key)) return _seen.get(key);
  const parts = [];
  for (const m of w.models) {
    const v = await intent.embed(key, m);
    if (!v) return null;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    parts.push(v.map(x => x / n));
  }
  const x = [].concat(...parts);
  const z = w.W.map((row, c) => { let s = w.b[c]; for (let d = 0; d < x.length; d++) s += row[d] * x[d]; return s; });
  const mx = Math.max(...z), e = z.map(v => Math.exp(v - mx)), S = e.reduce((a, v) => a + v, 0);
  const p = e[0] / S;
  if (_seen.size > 500) _seen.clear();
  _seen.set(key, p);
  return p;
}

// true only when the reader is sure (P(reasoning) ≥ τ). Unsure, or the embedder down: false — the ordinary
// chat model answers, as it did before this existed.
async function isReasoning(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return false;
  try {
    const w = weights();
    if (w) {
      const p = await pReasoning(t);
      if (p != null) _jlog('Reasoning › "' + t.slice(0, 40) + '" P ' + p.toFixed(2) + (p >= w.tau ? ' — work it out' : ''));
      return p != null && p >= w.tau;
    }
    const r = await classifier()(t);
    return !!(r && r.id === 'reasoning');
  } catch (e) { return false; }
}

module.exports = { init, isReasoning, pReasoning, weights, REASON_EXEMPLARS, GROUPS, MIN_MARGIN };
