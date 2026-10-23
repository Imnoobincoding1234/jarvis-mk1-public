'use strict';
// ---------------------------------------------------------------------------
// IS THIS ABOUT HIS CALENDAR? — asked, not spelled out.
//
// WHAT THIS REPLACES. CAL_LIST_RE and FREE_SLOT_RE in agent.js, which decided whether a request was
// calendar work by writing out the whole phrasings:
//
//     what's on my calendar | what's my schedule | what do i have on | show me my calendar |
//     my calendar | anything on my calendar        …and for free time…
//     (find|get|book|when) … (free|open|available|spare) (hour|slot|time|gap|window|minutes)
//
// "am i busy today" is not in there. Neither is "kal kya hai". The handoff named these two, with
// APP_SEARCH_RE and APP_SEARCH_IN_RE, as the last real keyword trap in the router, and this is the
// half of it that asks a pure classification question — no slots are cut from the match, so nothing
// downstream depends on the shape of the pattern.
//
// WHAT IT MUST NOT STEAL, and why the competing regions are split rather than lumped into one
// "everything else". A single catch-all region is the mistake webintent.js made first: averaging
// forty unrelated sentences produces a centroid that means nothing in particular and pulls weakly on
// everything, so borderline requests drift to whichever real region is nearest. Measured there:
// an order in Hindi beat a genuine lookup by a wider margin than the lookup won by. Five tight
// regions, each meaning one thing, and `calendar` has to beat its NEAREST real competitor.
//
// The two that matter most are pinned in test_parse.js and have been since the regex days:
// "find my resume" is a file search and "find out about tokamaks" is a lookup. Both begin with the
// word the free-slot pattern leads on.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const CAL_EXEMPLARS = {
  // HIS DIARY: what is on it, whether he is free, and when.
  calendar: [
    'what is on my calendar tomorrow',
    'what does my schedule look like',
    'am i busy today',
    'when am i free this week',
    'do i have anything on friday',
    'find me a free hour tomorrow',
    'show me my calendar',
    'what have i got on today',
    'any meetings this afternoon',
    'is there a gap in my day',
    'what is my next meeting',
    // He does not always ask in English, and a region taught only one language pulls every sentence
    // in the other toward whichever region does have it.
    'kal mera kya schedule hai',
    'aaj calendar mein kuch hai kya',
    'aaj meri koi meeting hai',
    'is hafte main free kab hun',
    'kal kya kya hai schedule mein',
  ],

  // FILES. "find my resume" leads on the same verb as the free-slot pattern did, and it is pinned
  // in test_parse.js precisely because that pattern nearly took it.
  files: [
    'find my resume',
    'where is that pdf I saved',
    'open the notes file on my desktop',
    'search my documents for the invoice',
    'what is in the downloads folder',
    'meri resume file kahan hai',
  ],

  // LOOKUPS. "find out about tokamaks" is the other pinned case.
  lookup: [
    'find out about tokamaks',
    'who is the CEO of BlackRock',
    'what is the population of Jakarta',
    'read up on transformer attention',
    'latest news on openai',
    'virat kohli kaun hai',
    'japan ki capital kya hai',
    'tesla ka share price kya hai',
  ],

  // ORDERS.
  command: [
    'open spotify',
    'play judas',
    'message mama on whatsapp',
    'take a screenshot',
    'close safari',
    'remind me at 5',
    'set a timer for ten minutes',
    'spotify kholo',
    'ek note banao',
  ],

  // THE MACHINE, AND THE CLOCK. "what time is it" is not a calendar question, and it is the closest
  // thing to one that is not.
  machine: [
    'what time is it',
    'what is my battery at',
    'what apps are running',
    'how much disk space do I have',
    'what is the date today',
    "what is today's date",
    'what day of the week is it',
    'what is the time in London',
    'battery kitni hai',
    'abhi kitne baje hain',
  ],

  // CONVERSATION AND MEMORY.
  social: [
    'how are you',
    'thanks, that is perfect',
    'what did we talk about yesterday',
    'what did I tell you about my mum',
    'good afternoon',
    'kaise ho',
    'shukriya',
  ],
};

// Everything that is not the calendar is one group, so `calendar` is measured against its nearest
// REAL competitor rather than against the other ways of not being a calendar question. Region names
// this file owns — never words a request might contain.
const GROUPS = {};
for (const id of Object.keys(CAL_EXEMPLARS)) GROUPS[id] = (id === 'calendar') ? 'cal' : 'other';

// MEASURED, NOT GUESSED — test_calintent.js re-measures these rather than remembering them.
//
//     lowest margin on a correct calendar case   0.054
//     highest margin on a WRONG  calendar case   0.000  — nothing else wins `calendar` at all
//
// THE LANGUAGE BALANCE HERE WAS GOT WRONG TWICE, IN BOTH DIRECTIONS, AND BOTH TIMES IT SHOWED UP AS
// A ROUTING BUG RATHER THAN AS A NUMBER. Worth reading before touching any exemplar below.
//
//   1. `calendar` was the ONLY region in this file with Hindi in it. Every Hindi question therefore
//      drifted here, and "sundar pichai kaun hai" — a person lookup — was classified as a diary
//      question and routed to the agent lane, live. The first version of test_calintent.js did not
//      catch it because its not-calendar list held one Hindi IMPERATIVE and no Hindi QUESTION.
//
//   2. Giving the other five regions Hindi then moved the mass the other way, and "kal koi meeting
//      hai kya" — a real diary question — stopped being one. Adding Hindi to `machine` also lifted
//      "what day is it" from 0.025 to 0.091 and pushed it over the gate.
//
// The fix in both directions was PROPORTION, never the failing sentence: each region carries the
// language roughly in step with the others, and the English clock concept was thickened in
// `machine` because that is the region which genuinely owns "what is the date".
//
// The remaining headroom is asymmetric on purpose. Above the gate there is nothing at all; below it,
// the closest correct case clears by 0.004, so a Hindi diary phrasing nobody has tried could still
// fall short. That failure is a MISS — the request carries on to the lanes it used before this gate
// existed — and a miss is the error worth having when the alternative is sending a lookup to the
// calendar.
//
// UNCHANGED, BECAUSE THIS CLASSIFIER KEPT all-minilm. See the `model` pin below.
const MIN_MARGIN = 0.05;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }

// Abstention is `false`: if the embedder cannot answer, this is not calendar work and the request
// carries on to the lanes below, which is where it went before this gate existed.
async function isCalendarIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!_classify) {
    _classify = intent.makeClassifier({
      // PINNED TO all-minilm THROUGH THE 2026-09-12 MIGRATION, on measurement. This gate carries
      // his romanized Hinglish diary phrasings, and nomic loses them at the REGION level, not at
      // the threshold:
      //
      //     "kal koi meeting hai kya"   all-minilm -> cal (margin 0.054)   nomic -> other (0.004)
      //
      // No threshold recovers a sentence that picked the wrong region, and the English cases here
      // were never the problem. Unlike webintent this lane has no second-model path to fall back
      // on, so the model it reads with is the whole decision.
      exemplars: CAL_EXEMPLARS, minMargin: MIN_MARGIN, none: '__unused__', groups: GROUPS,
      model: 'all-minilm',
      label: 'Calendar', jlog: (m) => _jlog(m),
    });
  }
  try {
    const r = await _classify(t.slice(0, 300));
    return !!(r && r.id === 'calendar');
  } catch (e) { return false; }
}

module.exports = { isCalendarIntent, init, CAL_EXEMPLARS, GROUPS, MIN_MARGIN };
