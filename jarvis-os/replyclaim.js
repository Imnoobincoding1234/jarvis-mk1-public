'use strict';
// ---------------------------------------------------------------------------
// THE SAME QUESTION, ASKED INSTEAD OF LISTED.
//
// The three regexes above enumerate roughly ninety ways of saying "I did it" or "I am about to",
// and the ninety-first walked straight through them:
//
//     ◆ look for the next holiday
//       Sure, let me look that up for you.
//
// Nothing ran, nothing was blocked, and he was left waiting for a lookup that was never coming.
// This is the reply the SYSTEM produced, so the shapes are stereotyped and the regions separate
// cleanly — and unlike a list, a region covers the phrasing nobody wrote down.
//
// THE REGEXES ABOVE STAY, and not out of sentiment. progressPartial() consults them per streaming
// token to decide whether a half-finished sentence is safe to speak aloud, and that path cannot
// await an embedding for every token. A cheap synchronous filter on speech and an authoritative
// asynchronous decision on the reply are different jobs with different constraints.
//
// `none` carries plenty of ordinary answers on purpose: misreading a good reply as a false claim
// would replace a correct answer with a refusal, which is its own kind of lying.
const REPLY_CLAIM_EXEMPLARS = {
  done: [
    'Done, Sir.', 'Saved.', 'I have added that to your calendar.',
    'The message has been sent.', 'Consider it done.', 'I have created the file for you.',
    'Added to your reminders, Sir.', 'I have noted that down.', 'That has been scheduled.',
  ],
  promised: [
    'Sure, let me look that up for you.', 'I will get that for you now.',
    'One moment while I check that.', 'Let me open that for you.',
    'Hold on, I will find it.', 'I will search for that and come back to you.',
    'Just a second while I pull that up.', 'Let me fetch those for you.',
  ],
  acting: [
    'Opening Netflix now, Sir.', 'Searching the App Store for you.',
    'I am ordering that for you now.', 'Launching Spotify right away.',
    'Placing your order, Sir.', 'I am sending that message now.',
  ],
  none: [
    'The CEO of Nvidia is Jensen Huang.', 'It is 22C and sunny in Tokyo.',
    '17 times 23 is 391.', 'Paris is the capital of France.',
    'I do not have that in my journal, Sir.', 'Your battery is at 18 percent.',
    'I cannot do that, Sir — it needs Full Disk Access.',
    'MrBeast is a YouTuber known for large-scale stunts.',
    'You have three unread emails.', 'Rust is a systems programming language.',
    // OFFERING AND ASKING ARE NOT PROMISING. The regex this replaced carried the same warning in
    // as many words — "'Let me explain' and 'I can help with that' are fine and must stay fine" —
    // and reading them as promises would answer a clarifying question with a refusal.
    'I can help with that. What would you like it to say?',
    'Let me explain how that works.', 'That depends on what you mean by fast.',
    'What would you like me to search for, Sir?', 'Which one did you mean?',
    'Happy to help — what should it say?', 'Do you want the short version or the long one?',
    'Let me know which channel and I will open it.',
    // STANDALONE POLITENESS. Scored per sentence, an opener has to stand on its own, and "I can
    // help with that." alone reads as a promise. Putting the courtesy half here is also what makes
    // the CLAIM half decide: "Sure thing, Sir." is none, so "Ordering a non-veg meal for you now."
    // is what the reply gets judged on.
    'I can help with that.', 'Happy to help.', 'Of course, Sir.', 'Sure thing, Sir.',
    'Absolutely, Sir.', 'Certainly.', 'Right you are, Sir.', 'Good question.',
    // AN ACTION VERB USED DESCRIPTIVELY IS NOT A CLAIM. "It is indoors and quick to arrange" landed
    // in `acting` on the strength of "arrange", and flagging it would have answered a perfectly
    // good suggestion with a refusal. Advice, description and second-person suggestions all talk
    // about doing things without claiming to have done them.
    'It is indoors and quick to arrange.', 'That takes about twenty minutes to set up.',
    'You could try opening it in Safari instead.', 'It plays well on a laptop.',
    'Badminton is a good shout at this time of year.',
    'You would need to install it first.', 'That one is worth watching.',
    'It is easier to order those the night before.',
    'There is nothing on your calendar today.', 'Good morning, Sir.',
    // A SHORT FACTUAL ANSWER WITH AN HONORIFIC IS NOT A COMPLETION CLAIM. Measured: "Your name is
    // Atharv, Sir." classified as `done`, because it shares its shape with "Added to your
    // reminders, Sir." — and misreading it would have replaced a correct answer with a refusal.
    'Your name is Atharv, Sir.', 'Your battery is at 81 percent, Sir.',
    'It is 7pm in London, Sir.', 'That is 391, Sir.', 'The file is on your desktop, Sir.',
    // THE SYSTEM'S OWN REFUSALS. These are the strings the guards below emit. Reading one of them
    // back as a claim would be the guard triggering on its own output.
    'I have not actually done that, Sir — I have no way to carry it out.',
    'I cannot actually fetch that here, Sir.',
    'I could not carry that out, Sir — I did not manage to turn it into something I can run.',
    'I will not message a bare number, Sir.',
  ],
};

const intent = require('./intent.js');

// THE TRAINED READER (2026-09-24). The regions below read TOPIC, and whether a sentence reports something
// this conversation did is a SPEECH ACT. A softmax classifier over the sentence's embeddings (nomic +
// all-minilm), trained by finetune/train_replyclaim.js on finetune/data/replyclaim_train.jsonl, reads it
// instead (round 3: nomic, 615 rows incl. the exemplars above, τ 0.3). Its weights are
// replyclaim.weights.json — learned, never hand-edited. Held-out, finetune/data/replyclaim_*.json:
//
//     set                                           regions (the old guard)   trained reader (round 3)
//     #5 heldout4, fresh, never seen by any round   2/25 caught, 5/25 flagged 18/25 caught, 2/25 flagged
//     #3 heldout2, written before round 2           7/25, 2/25                23/25, 1/25
//     #1 heldout, written first                     13/45, 8/45               41/45, 2/45
//     real blocked 3B replies (live)                7/7, 15/15 (blocked all)  4/7, 1/15
//     #4 heldout3                                   3/25, 6/25                22/25, 5/25
//     all                                           32/127, 36/135            108/127 (85%), 11/135 (8%)
//
// Round 4 (more chatty "let me"/status/past-event rows) scored the same on #5 and was not kept.
// Still missed: chatty opener + "let me / I'll", some bare status claims. The ceiling here is a linear
// reader on an embedding; the next step is a trained LANGUAGE reader. Without the weights file the
// regions below answer, exactly as before.
let _weights;
function weights() {
  if (_weights !== undefined) return _weights;
  try {
    const w = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'replyclaim.weights.json'), 'utf8'));
    _weights = (w && Array.isArray(w.W) && Array.isArray(w.models) && typeof w.tau === 'number') ? w : null;
  } catch (e) { _weights = null; }
  return _weights;
}
const normText = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
async function trainedClaimOf(sentence, w) {
  const parts = [];
  for (const m of w.models) {
    const v = await intent.embed(normText(sentence), m);
    if (!v) return undefined;                    // embedder down: let the caller fall back
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (const x of v) parts.push(x / n);
  }
  const z = w.W.map((row, c) => { let s = w.b[c]; for (let d = 0; d < parts.length; d++) s += row[d] * parts[d]; return s; });
  const mx = Math.max(...z); const e = z.map(x => Math.exp(x - mx)); const S = e.reduce((a, x) => a + x, 0);
  const p = e.map(x => x / S);
  const none = w.classes.indexOf('none');
  if (p[none] >= w.tau) return null;
  let k = -1; for (let c = 0; c < p.length; c++) if (c !== none && (k < 0 || p[c] > p[k])) k = c;
  return w.classes[k];
}

let _replyClaim = null;
async function replyClaimOf(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const w = weights();
  if (w) {
    const s0 = Date.now();
    try {
      let fellBack = false;
      for (const h of t.split(/(?<=[.!?])\s+/).slice(0, 3).map(x => x.trim()).filter(Boolean)) {
        const id = await trainedClaimOf(h.slice(0, 200), w);
        if (id === undefined) { fellBack = true; break; }
        if (id) return id;
      }
      if (!fellBack) return null;
    } catch (e) { /* fall through to the regions */ }
    finally { const ms = Date.now() - s0; if (ms > 50) intent.noteTiming('Claim', ms); }
  }
  if (!_replyClaim) {
    _replyClaim = intent.makeClassifier({
      // PINNED TO all-minilm THROUGH THE 2026-09-12 MIGRATION, on measurement. Leave-one-out over
      // the exemplars said nomic was much better here (55/68 against 40/68) and the real input said
      // otherwise — which is why the suite is the gate and LOO is only the instrument:
      //
      //     "Sure thing, Sir. Ordering a non-veg meal with oranges for you now."
      //         all-minilm -> 'acting'      nomic -> null
      //
      // That is the fabricated order confirmation out of his own terminal, and catching it is the
      // entire reason this file exists. A guard that reads JARVIS's reply back to check it did not
      // claim an action it never took cannot be allowed to get quieter. Same finding as
      // replyhedge.js: nomic reads requests better and replies worse.
      exemplars: REPLY_CLAIM_EXEMPLARS, minMargin: 0.05, none: 'none', model: 'all-minilm',
      label: 'Claim', jlog: () => {},          // silent: this fires on every plain-chat reply
    });
  }
  try {
    // SENTENCE BY SENTENCE, because averaging hides the lie.
    //
    //     "Sure thing, Sir. Ordering a non-veg meal with oranges for you now."
    //
    // That is the fabricated order confirmation from his own terminal. As one string it classifies
    // as ordinary politeness — the first sentence is pure courtesy and dilutes the second — and it
    // slipped through both as one sentence and as two joined. Scored separately, "Sure thing, Sir."
    // is none and "Ordering a non-veg meal…" is a claim, and a reply that claims an action in ANY
    // of its opening sentences is a claim.
    //
    // Bounded to the first three: a long answer that mentions opening something four paragraphs
    // down is discussing it, not claiming it.
    const heads = t.split(/(?<=[.!?])\s+/).slice(0, 3).map(x => x.trim()).filter(Boolean);
    for (const h of heads) {
      const r = await _replyClaim(h.slice(0, 200));
      if (r && r.id) return r.id;                 // the first real claim decides it
    }
    return null;
  } catch (e) { return null; }
}

module.exports = { replyClaimOf, REPLY_CLAIM_EXEMPLARS };
