'use strict';
// ---------------------------------------------------------------------------
// THE MODEL ANNOUNCING ITS OWN DOUBT IS A ROUTING SIGNAL — AND IT IS FREE.
//
// WHY THIS EXISTS. webintent.js decides BEFORE answering whether a question needs the web, and it is
// deliberately conservative: a false fire sends one of his private questions to a search engine, so
// the threshold sits where false fires are zero and a couple of genuine lookups fall through. Those
// leftovers need catching at the other end, and the model hands us the signal for nothing. Both
// measured failures announced their own doubt in the reply:
//
//     ◆ who is the CEO of BlackRock
//       …Christopher A. Garthwaite. However, for the most current and accurate information,
//       I would recommend checking the official BlackRock website.
//
//     ◆ who is yessmartypie
//       I don't have information about that.
//
// The first is a fabricated name with a disclaimer stapled to it; the second is honest and useless.
// Either way the model is saying "go and look", and nothing was listening.
//
// WHY THREE REGIONS AND NOT TWO. "I don't know" about the WORLD is a reason to search. "I don't know"
// about HIM is not — "I do not have that in my journal, Sir" is the memory store answering correctly,
// and sending that to DuckDuckGo would turn a private question into a web query, which is the exact
// failure the conservative threshold in webintent.js exists to prevent. Splitting the two is what
// makes this safe to act on; a single "hedge" region would have collapsed them.
//
// THIS IS NOT replyclaim.js. That asks whether a reply CLAIMS AN ACTION it did not take ("Opening
// Netflix now"). This asks whether a reply ANSWERED AT ALL. Different questions, same shared
// machinery in intent.js, and neither is a copy of the other.
//
// COST. One embedding of the first few sentences, on a path that already spent ~15 seconds
// generating them. It fires rarely, and when it does the turn pays for a lookup it should have made
// in the first place.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const HEDGE_EXEMPLARS = {
  // "GO AND LOOK IT UP" — about the world. The only region that triggers anything.
  unknown_world: [
    "I don't have information about that.",
    'I am not able to access current information.',
    'For the most current and accurate information, I would recommend checking the official website.',
    'As of my last update, I do not have details on that.',
    'I cannot browse the internet, so I cannot check that for you.',
    'You may want to check a reliable source for the latest figures.',
    'I am not sure who that is.',
    'My information may be out of date, so please verify this.',
    'I do not have real-time data on that.',
    'I would suggest looking that up for the most recent details.',
  ],

  // "I DON'T HAVE THAT ABOUT YOU" — the store answering correctly. Must never reach the web.
  unknown_personal: [
    'I do not have that in my journal, Sir.',
    'You have not told me about that yet.',
    'I have no record of that in your notes.',
    'There is nothing on your calendar about it.',
    'I did not find that in what you have saved.',
    'You never mentioned that to me, Sir.',
    'I cannot see that in your messages.',
  ],

  // AN ACTUAL ANSWER. Carries plenty of ordinary replies on purpose: misreading a good answer as a
  // hedge would replace a correct reply with a thirty-second web round for nothing. Refusals about
  // CAPABILITY live here too — "it needs Full Disk Access" is a real answer about a real limit, not
  // a gap in knowledge, and searching the web would not help.
  answer: [
    'The CEO of Nvidia is Jensen Huang.',
    'Larry Fink is the CEO of BlackRock.',
    'It is 22C and sunny in Tokyo.',
    '17 times 23 is 391.',
    'Paris is the capital of France.',
    'Rust is a systems programming language.',
    'Your battery is at 18 percent.',
    'You have three unread emails.',
    'MrBeast is a YouTuber known for large-scale stunts.',
    'That depends on what you mean by fast.',
    'I cannot do that, Sir — it needs Full Disk Access.',
    'I will not message a bare number, Sir.',
    'Badminton is a good shout at this time of year.',
    'There is nothing on your calendar today.',
    'Good afternoon, Sir.',
    'Let me explain how that works.',
    'Which one did you mean?',
  ],
};

// Only the world-shaped gap is worth a lookup. `unknown_personal` and `answer` both mean "leave this
// reply alone", so they share a group and the margin is measured between the two OUTCOMES rather
// than between two ways of not searching.
const GROUPS = {
  unknown_world: 'search',
  unknown_personal: 'leave',
  answer: 'leave',
};

// MEASURED, NOT GUESSED — test_replyhedge.js re-measures and prints these.
//
//     lowest margin on a correct hedge      0.083
//     highest margin on a WRONG  hedge      0.000  — no `leave` case ever won the search group at all
//
// The cleanest separation of the three classifiers built today, and not by luck: these are the
// SYSTEM'S OWN replies, so the shapes are stereotyped in a way a person's requests never are.
// replyclaim.js says the same thing about the same input for the same reason.
//
// The three-way split is what earns the 0.000. "Your calendar has nothing for tomorrow" and "I have
// no note of that conversation" are both knowledge gaps, and both must be left alone; with a single
// "hedge" region they would sit next to "I don't have information about that" and the first web
// search of a private question would only be a matter of time.
//
// UNCHANGED, BECAUSE THIS CLASSIFIER KEPT all-minilm. See the `model` pin below.
const MIN_MARGIN = 0.07;
// Words per piece read by saysGoLookItUp — see there.
const WINDOW = 16;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }

// Returns true only when the reply is a knowledge gap about the WORLD. Abstention is false, and
// false means "leave the reply exactly as it is" — the behaviour that existed before this file.
async function saysGoLookItUp(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!_classify) {
    _classify = intent.makeClassifier({
      // PINNED TO all-minilm THROUGH THE 2026-09-12 MIGRATION, on measurement, because under
      // nomic-embed-text this guard STOPS FIRING ENTIRELY:
      //
      //                                              all-minilm   nomic
      //     "I don't have information about that."      true       false
      //     "I'm not sure what that is."                true       false
      //
      // Not a threshold that needed lowering — the regions themselves stop separating: "I do not
      // know the answer to that" moves from `search` to `leave` outright. A hedge detector that
      // never fires is not a degraded guard, it is an absent one, and what it guards is a private
      // question quietly turning into a web search. nomic is better at reading a REQUEST and worse
      // at reading a REPLY; this file only ever reads replies.
      exemplars: HEDGE_EXEMPLARS, minMargin: MIN_MARGIN, none: '__unused__', groups: GROUPS,
      model: 'all-minilm',
      label: 'Hedge', jlog: (m) => _jlog(m),
    });
  }
  try {
    // THE START AND THE END, PIECE BY PIECE, because the disclaimer is usually the LAST thing in
    // the reply, not the first. "…Christopher A. Garthwaite. However, for the most current
    // information, I would recommend checking the official website." scored as an answer whole —
    // the invented fact is three-quarters of the text and dilutes the retraction (measured again
    // 2026-10-08: whole, it is missed). replyclaim.js reads the opening for the same reason in
    // reverse: a claim comes first, a hedge comes last.
    //
    // PIECES ARE 16-WORD WINDOWS, NOT SENTENCES. This used to split at . ! ? and read the first two
    // and last two sentences — punctuation standing in for meaning, which his rule #1 forbids — so
    // it was measured before it went (2026-10-08, sweeps/sweep_hedgesplit.js, every distinct real
    // reply on disk, 2,205): the first two and last two 16-word windows catch every hedge the
    // sentence split catches (test_replyhedge's 5, the two this file was built for, the ~4 real
    // ones in the pool) and fire falsely on 52 of the 159 replies where the two disagree against
    // the split's 74 (none of the 159 was a real hedge). Every 16-word window, stepping 8: 92.
    const words = String(t).split(/\s+/).filter(Boolean);
    const wins = [];
    for (let s = 0; s < words.length; s += WINDOW) { wins.push(words.slice(s, s + WINDOW).join(' ')); if (s + WINDOW >= words.length) break; }
    const heads = wins.slice(0, 2);
    const tails = wins.slice(-2);
    for (const p of [...new Set([...heads, ...tails])]) {
      const r = await _classify(p.slice(0, 200));
      if (r && r.id === 'unknown_world') return true;
    }
    return false;
  } catch (e) { return false; }
}

module.exports = { saysGoLookItUp, init, HEDGE_EXEMPLARS, GROUPS, MIN_MARGIN, WINDOW };
