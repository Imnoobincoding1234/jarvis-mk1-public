'use strict';
// ---------------------------------------------------------------------------
// IS HE ASKING FOR A LONG INVESTIGATION, OR A LOOKUP? — asked of the embedder, not of four regexes.
//
// WHAT THIS REPLACES. deepresearch.js shipped its own triggers, and all four were the trap:
//
//   DEEP_RE         /deep[-\s]?research|do (a )?deep dive|research (deeply|properly|in depth|…)/
//   DEEP_STATUS_RE  /research status|how('s| is) (the |your )?research|are you (still )?researching/
//   DEEP_STOP_RE    /(stop|cancel|abort|drop) (the )?(deep )?research/
//   stripDeep()     .replace(/\bresearch\b/ig,' ').replace(/\b(deeply|properly|…)\b/ig,' ')…
//
// The first three are open classes of phrasing: "look into X properly for me", "spend half an hour
// on X", "dig into X", "give me a real writeup on X" and "take your time with X" are all the same
// request and not one of them fires. The fourth is worse, and is the shape §0 names outright —
// SUBTRACTIVE extraction. It deletes the words somebody wrote down and ships whatever survives, so
//
//     "can you research the new samsung phone for me please"
//        → topic: "can you the new samsung phone for me please"
//
// and that string is what gets searched, round after round, for twenty minutes.
//
// ---------------------------------------------------------------------------
// WHY A `quick-lookup` REGION EXISTS, AND WHY IT IS THE MOST IMPORTANT ONE HERE.
//
// The decision is not "is this about the web" — webintent.js already owns that. It is DEPTH: the
// same subject can be a forty-second answer or a twenty-minute investigation, and the only thing
// separating them is how much he asked for. So the ordinary lookup needs a region of its own, or
// every "what is X" lands on whichever centroid is generically nearest and starts a job that runs
// for twenty minutes and notifies him at the end. A missing region is the same bug as a junk
// drawer; this is the region that must exist for the others to mean anything.
//
// Every region that is not `deep`, `status` or `stop` answers `none`, and a `none` here means the
// turn falls through to the lanes that already handle it — the ordinary research path included.
// Falling through is the safe direction: it costs forty seconds, where a false `deep` costs twenty
// minutes and a notification.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const EXEMPLARS = {
  // A LONG INVESTIGATION. Note there is no reliance on the word "research" anywhere in here — the
  // region is about the SIZE of the request, which is what the old regex could never see.
  deep: [
    'do a deep dive on the indian ev market',
    'look into fusion power properly and take your time',
    'spend the next half hour finding out everything about this company',
    'i want a thorough writeup on what happened with silicon valley bank',
    'dig into this properly and come back to me',
    'really investigate the history of the kashmir conflict',
    'go away and read everything you can about lithium supply',
    'give me a proper report on quantum error correction',
  ],
  // THE ORDINARY LOOKUP — forty seconds, one round, the lane that already exists.
  //
  // THE SECOND HALF OF THIS REGION WAS MISSING AND IT COST TWO FALSE DEEPS. The first version held
  // only question-shaped lookups ("what is the population of jakarta"), so a sentence using a
  // RESEARCH VERB had nowhere to land but `deep`:
  //
  //     "research on quantum computing"  → deep      "read up on stoicism" → deep
  //
  // Both are pinned as ordinary lookups by test_reflective, and both are the expensive mistake —
  // half an hour of the machine for a question worth forty seconds. The gap was structural rather
  // than per-case: the boundary this classifier draws is EFFORT ASKED FOR, and every exemplar that
  // used a research verb was on the deep side, so the verb itself became the signal. The bare-verb
  // half is here now, which is what makes the qualifier carry the decision instead of the verb.
  'quick-lookup': [
    'what is the population of jakarta', 'who is the ceo of blackrock',
    'look up the price of bitcoin', 'tell me about the new samsung phone',
    'what happened in the match last night', 'find out when the shop closes',
    'summarise the news today', 'what does this error mean',
    // the same verbs the deep region uses, with no effort asked for
    'research the offside rule', 'read about the mughal empire',
    'look into why my train is late', 'find out about the new tax rules',
    'give me a rundown on kubernetes', 'check what time the match starts',
  ],
  // ASKING AFTER A JOB THAT IS ALREADY RUNNING.
  status: [
    'how is the research going', 'are you still working on that',
    'any progress on the deep dive', 'is it done yet',
    'what have you found so far', 'how much longer will that take',
  ],
  // CALLING IT OFF.
  stop: [
    'stop the research', 'cancel that deep dive', 'drop it, i do not need it any more',
    'abort what you are doing', 'forget the investigation', 'never mind, stop looking into it',
  ],
  // NOT ABOUT RESEARCH AT ALL. Split into coherent regions rather than one drawer, for the reason
  // intent.js's `groups` note gives: an averaged centroid of unrelated sentences stands for nothing
  // and pulls weakly on everything.
  'none-machine': [
    'open safari', 'take a screenshot', 'close spotify', 'what is my battery at',
    'create a file called notes.txt', 'empty the trash',
  ],
  'none-errand': [
    'order me a pizza', 'buy a keyboard from amazon', 'play judas by lady gaga',
    'get me some apples', 'watch the latest video from that channel',
  ],
  'none-talk': [
    'thanks that worked', 'good morning', 'what do you know about me',
    'remind me to drink water in 3 hours', 'message mama on whatsapp', 'schedule a meeting at 6pm',
  ],
};

// Only three of these are answers the caller acts on. Everything else — the ordinary lookup
// included — is `none`, which means "not mine, carry on down the lanes".
const GROUPS = {
  deep: 'deep', status: 'status', stop: 'stop',
  'quick-lookup': 'none', 'none-machine': 'none', 'none-errand': 'none', 'none-talk': 'none',
};

// SWEPT, NOT CHOSEN. 37 held-out requests (10 deep, 10 ordinary lookups, 5 status, 4 stop, 8 not
// research at all), every one written before a number was read:
//
//     margin 0.00   37/37   0 false deep, 0 missed
//     margin 0.02   37/37   0 false deep, 0 missed      <- this one
//     margin 0.03   36/37   0 false deep, 1 missed
//     margin 0.05   35/37   0 false deep, 2 missed      ("a proper writeup on how ssds fail")
//     margin 0.10   29/37   0 false deep, 8 missed
//
// 0.02 is the LARGEST margin that still costs nothing — past it real investigations start being
// read as lookups. 0.05 was written here first, on the reasoning that a false `deep` occupies the
// machine for half an hour and a missed one costs forty seconds, so erring high is the safe
// direction. The sweep says that reasoning bought nothing: false deeps are zero at every threshold
// on this set, so the higher number was pure loss. Measure before you claim, including about your
// own caution.
//
// The direction-of-error rule still stands for the day this is re-swept on a different embedder: a
// false `deep` is the expensive mistake and the threshold should be chosen to keep it at zero.
const MIN_MARGIN = 0.02;

let _raw = null;
const deps = { jlog: () => {} };
function init(d) { if (d && typeof d.jlog === 'function') deps.jlog = d.jlog; }

// Every region scored, no floor — the margin itself is what the decision below reads.
let _cent = null;
async function centroids() {
  if (_cent) return _cent;
  const out = {};
  for (const [id, ex] of Object.entries(EXEMPLARS)) {
    const c = await intent.centroidOf(intent.MODEL, ex);   // cached on disk — see intent.js
    if (!c) return null;
    out[id] = c;
  }
  _cent = out;
  return out;
}

// NO SECOND MODEL. THE EMBEDDER'S OWN UNCERTAINTY IS THE SECOND OPINION.
//
// The previous version confirmed every deep verdict with the local 3B. Measured against simply
// reading how close the embedder's call was, on the same 61 held-out requests:
//
//     embedder + 3B confirmation          58 exact, 2 ask first, 1 wrong
//     embedder alone, margin + band       58 exact, 2 ask first, 1 wrong   <- this
//
// Identical. The 3B was a second opinion that added nothing, cost a model call, and is a small
// generative model — which is not a thing to trust with a decision. Swept, MIN_MARGIN × BAND:
//
//     MIN 0.02  BAND 0.00   58 exact, 1 ask, 2 wrong  ("really investigate whether creatine does
//                                                       anything" read as a lookup, silently)
//     MIN 0.02  BAND 0.01   58 exact, 2 ask, 1 wrong  <- smallest band that turns the silent miss
//                                                       into a question
//     MIN 0.02  BAND 0.05   54 exact, 6 ask, 1 wrong  (more questions, no fewer wrongs)
//
// THE ONE "WRONG" IS A LABEL, NOT A READING. "research on quantum computing" is read as a confident
// deep request, above every margin tried. Its expected answer came from DEEP_RE, which called it a
// lookup for exactly one reason: the word "deeply" was absent. Recorded in the suite as a known
// disagreement rather than forced either way.
//
//   deep, clearly            -> 'deep'
//   deep, narrowly           -> 'maybe-deep' (asked)
//   a lookup, with deep close behind -> 'maybe-deep' (asked)
//   status / stop, clearly   -> 'status' / 'stop'
//   anything else            -> null, and the ordinary lanes take it
const BAND = 0.01;
async function kindOf(text) {
  const t0 = Date.now();
  try { return await kindOfInner(text); }
  finally { const ms = Date.now() - t0; if (ms > 50) intent.noteTiming('Research', ms); }
}
async function kindOfInner(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return null;
  let cent;
  try { cent = await centroids(); } catch (e) { return null; }
  if (!cent) return null;
  const v = await intent.embed(t);
  if (!v) return null;
  const group = id => GROUPS[id] || id;
  const best = {};
  for (const [id, c] of Object.entries(cent)) {
    const sim = intent.cos(v, c), g = group(id);
    if (best[g] === undefined || sim > best[g]) best[g] = sim;
  }
  const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
  const [top, topSim] = ranked[0];
  const margin = topSim - (ranked[1] ? ranked[1][1] : 0);
  if (top === 'deep') return margin >= MIN_MARGIN ? 'deep' : 'maybe-deep';
  if (top === 'status' || top === 'stop') return margin >= MIN_MARGIN ? top : null;
  if (best.deep !== undefined && topSim - best.deep < BAND) return 'maybe-deep';
  return null;
}

// THE TOPIC IS WHAT HE SAID. Nothing is extracted from it.
//
// This file used to ask the 3B for the subject, verify it as a substring, and strip a leading
// preposition with a list of prepositions. None of that was needed: deep research hands the topic to
// its own research model as the REQUEST, and a request is read better whole than as a noun phrase
// somebody carved out of it. So the sentence he typed is the topic, and the list and the model call
// are both gone.

module.exports = { init, kindOf, EXEMPLARS, GROUPS, MIN_MARGIN, BAND };
