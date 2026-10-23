'use strict';
// ---------------------------------------------------------------------------
// IS THIS ABOUT DREAM MODE, AND WHICH PART? — asked, not spelled out.
//
// WHAT THIS REPLACES (2026-09-18). Four word lists chained in front of dream mode:
//
//     DREAM_RE   dream (mode|now|log) | what did you do (while i was away|overnight|last night) |
//                run maintenance | tidy up
//     then       dream log | what did you do         → the log
//     then       off | on | enable | disable          → dream_set, which read off | stop | disable
//
// "tidy up" sat in the first list, so "tidy up my desktop" ran dream-mode maintenance and replied
// "Done, Sir" with the desktop untouched. "what happened while I was asleep" — his own words, in the
// log — matched nothing at all. The same class of failure as every list: it fires on the phrasing it
// named and misses the one nobody wrote down.
//
// THREE REGIONS OF DREAM MODE, AND FIVE OF WHAT IS NOT. The log (what JARVIS did while he was away),
// running the idle work now, and the on/off setting — then files (tidying HIS things), recall (what HE
// did or said), other settings (dark mode, wifi), human dreams, and ordinary requests. A single
// "everything else" region averages into a centroid that means nothing (calintent.js, webintent.js);
// each of these means one thing, and a dream region has to beat the NEAREST of them.
//
// ON OR OFF IS NOT DECIDED HERE. It is a polarity pair, and embeddings cannot do polarity — measured:
// subscribe/unsubscribe sit at 0.830 cosine, and "fire up the calculator" ranks nearer close than open.
// The setting region only says he is talking about the setting; server.js tells him the current state
// and offers the other one as a word ('Say "off"'), and his whole reply must be that word (soleOffered).
//
// Every region carries English and Hinglish in proportion — a region taught one language alone pulls
// every sentence in that language toward itself (calintent.js records it happening twice).
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const DREAM_EXEMPLARS = {
  // WHAT JARVIS DID WHILE HE WAS AWAY — dream_log.
  dream_log: [
    'what did you get done while i was gone',
    'show me what you did in the background',
    'what work did you do overnight',
    'tell me what you did when i was away from the laptop',
    'what maintenance ran while i was out',
    'give me your idle work log',
    'anything you worked on while i was asleep',
    'what jobs did you run last night',
    // The feature's OWN NAME. Without it, his "dream log" drifted to human dreams (measured below).
    'what is in your dream log',
    'read me the entries in your dream log',
    'jab main nahi tha tab tumne kya kiya',
    'raat ko tumne kya kaam kiya',
    'apna dream log batao',
  ],
  // RUN THE IDLE WORK NOW — dream_now.
  dream_now: [
    'run your idle maintenance now',
    'do your background housekeeping right now',
    'start your overnight jobs now',
    'go do your idle work now',
    'run the dream cycle',
    'do your maintenance tasks now instead of waiting',
    'catch up on your background work now',
    'reindex your library and tidy your memory now',
    'run a dream cycle now',
    'go into dream mode right now',
    'do some dreaming now while i grab coffee',
    'abhi apna maintenance kar lo',
    'apna idle kaam abhi chala do',
    'dream mode abhi chalao',
  ],
  // THE SETTING — dream_set. Which way is not read here (see above).
  dream_setting: [
    'turn dream mode off',
    'switch on dream mode',
    'disable idle work',
    'stop doing background work while i am away',
    'enable your overnight maintenance',
    'pause dream mode',
    'let yourself work while i am away again',
    'dont run maintenance when i am gone',
    'dream mode band karo',
    'dream mode chalu karo',
  ],
  // HIS FILES. "tidy up my desktop" is his, and it is not dream mode.
  files: [
    'clean up my downloads folder',
    'organise the files on my desktop',
    'sort my documents into folders',
    'delete the old screenshots on my desktop',
    'move my pdfs into one folder',
    'declutter my home folder',
    'make my desktop less messy',
    "archive last year's files",
    'mere downloads saaf kar do',
    'desktop ki files arrange karo',
  ],
  // WHAT HE DID OR SAID — recall, not the dream log.
  recall: [
    'what did we talk about yesterday',
    'what was i working on this morning',
    'what did i ask you last week',
    'remind me what i said about the project',
    'what apps did i use this afternoon',
    'what happened in our last conversation',
    'what did i search for earlier',
    'when did i last open spotify',
    'kal humne kya baat ki thi',
    'maine subah kya kiya tha',
  ],
  // OTHER SETTINGS — the same on/off shape, about something else.
  settings: [
    'turn on dark mode',
    'switch off wifi',
    'enable bluetooth',
    'disable notifications',
    'turn the volume down',
    'turn off do not disturb',
    'switch on night shift',
    'mute the sound',
    'wifi band karo',
    'bluetooth on karo',
  ],
  // HUMAN DREAMS AND SLEEP.
  dreams: [
    'i had a weird dream last night',
    'what do dreams mean',
    'why do we dream',
    'i dreamt about the ocean',
    'how do i remember my dreams',
    'what is lucid dreaming',
    'i keep having nightmares',
    'my dream is to be an engineer',
    'mujhe ajeeb sapna aaya',
    'sapne kyun aate hain',
  ],
  // ORDINARY REQUESTS.
  other: [
    'open spotify',
    'what is the weather',
    'play some music',
    'set a reminder for 5',
    'how are you',
    'what time is it',
    'search for pizza',
    'message mama',
    'kya haal hai',
    'music laga do',
  ],
};

// Each dream region answers for itself; everything that is not dream mode is one group, so a dream
// region is measured against its nearest REAL competitor. Region names this file owns.
const DREAM = new Set(['dream_log', 'dream_now', 'dream_setting']);
const GROUPS = {};
for (const id of Object.keys(DREAM_EXEMPLARS)) GROUPS[id] = DREAM.has(id) ? id : 'not_dream';

// MEASURED, 2026-09-18, nomic-embed-text — tests/test_dreamintent.js re-measures it and prints the sweep.
// Two held-out sets, neither an exemplar: HELD (36, his own dream-mode messages + look-alikes, looked at
// while designing) and FRESH (23, written before the regions were last changed, looked at once).
//
//                                   HELD                     FRESH
//   this file, gate 0.03            33/36, 0 wrong, 0 in     21/23, 0 wrong, 0 in
//   the old regex chain             24/36, 1 WRONG, 1 in     13/23 (3/13 dream requests found)
//
//   the old chain's WRONG one: "dream mode band kar do" — turn it off — ran the maintenance cycle;
//   its intruder: "tidy up my desktop". Sweep on HELD: 0.00–0.02 let one look-alike in, 0.03 lets none
//   in and keeps every region right, 0.04+ only loses dream requests. Lowest margin on a right dream
//   case 0.038, highest on a wrong call 0.026.
//
// all-minilm read it worse — 25/36 at 0.03 and two look-alikes IN ("what did I do today" → the log,
// "do my homework now" → run it now) — so this classifier uses the main embedder. What it still misses
// (both sets): Hinglish past tense ("tumne raat ko kya kiya", "jab main so raha tha…"), "start dreaming
// now", "abhi dream karo", "stop your idle work". A miss carries on to the lanes below, as before.
const MIN_MARGIN = process.env.JARVIS_DREAM_MARGIN != null ? Number(process.env.JARVIS_DREAM_MARGIN) : 0.03;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }

function classifier() {
  if (!_classify) {
    _classify = intent.makeClassifier({
      exemplars: DREAM_EXEMPLARS, minMargin: MIN_MARGIN, none: '__unused__', groups: GROUPS,
      label: 'Dream', jlog: (m) => _jlog(m),
    });
  }
  return _classify;
}

// JARVIS'S OWN TOOL NAMES — dream_log, dream_now and dream_set (dream.js TOOLS), read from dream.js itself,
// never typed out here. "dream log" / "dream now" are what he types because that is what they are called,
// and the embedder cannot read them: a two-word command is mostly the word "dream", and both went to human
// dreams (0.110, 0.130) even after the regions were given the feature's name.
//
// A NAME IS EVIDENCE, NOT A DECISION (2026-09-18). The first version acted on the name alone, and the name's
// words are ordinary words: "my dream now is to be a pilot" and "i had a weird dream now that i think about
// it" named dream_now and would have started a dream cycle. So dreamIntentOf only acts when the classifier
// reads the SAME part of dream mode; a name it reads otherwise comes back unsure, and server.js asks — his
// yes is kept for that sentence (readmodel.confirm), so "dream now" is asked about once, not every time.
const TOOL_REGION = { dream_log: 'dream_log', dream_now: 'dream_now', dream_set: 'dream_setting' };
function namedTool(text) {
  const words = String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const tool of Object.keys(require('./dream.js').TOOLS)) {
    const name = tool.split('_');
    for (let i = 0; i + name.length <= words.length; i++) {
      if (name.every((w, k) => words[i + k] === w)) return TOOL_REGION[tool] || null;
    }
  }
  return null;
}

// { id: 'dream_log' | 'dream_now' | 'dream_setting', sure }, or null. sure = the classifier read it that
// way (and any tool he named is the same one); a named tool the classifier reads otherwise is sure:false,
// which is a question, never an action. null is abstention: the request carries on to the lanes below,
// where it went before this gate existed — a miss is the error worth having.
async function dreamIntentOf(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const named = namedTool(t);
  let read = null;
  try {
    const r = await classifier()(t);
    read = r && DREAM.has(r.id) ? r.id : null;
  } catch (e) {}
  if (read && (!named || named === read)) return { id: read, sure: true };
  if (named) return { id: named, sure: false };
  return null;
}

// For the test: the region and margin, whatever the gate decides.
async function explain(text) {
  try { return await classifier()(String(text || '').trim()); } catch (e) { return null; }
}

module.exports = { init, dreamIntentOf, explain, namedTool, DREAM_EXEMPLARS, GROUPS, MIN_MARGIN };
