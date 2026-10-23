'use strict';
// ---------------------------------------------------------------------------
// DOES ANSWERING THIS NEED THE WEB? — asked, not listed.
//
// WHAT THIS REPLACES. A regex named RESEARCH_RE and a "research" group in config/verbs.json, which
// between them enumerated the ways a person might ask to be told something:
//
//     research | look into | read up on | dig into | investigate | brief me on |
//     what's the latest on | catch me up on | fill me in on | find out about …
//
// Every one of those is a VERB somebody thought of. The request that exposed it used none of them:
//
//     ◆ who is the CEO of BlackRock
//       The CEO of BlackRock as of recent information is Christopher A. "A. Chris" Garthwaite.
//
// It is Larry Fink. The day before, the same question produced "Christopher A. Flowers". That is
// what a 3B does with specific factual recall — it samples a plausibly-shaped name — and the whole
// time a working web search was sitting one lane away, unreachable because the sentence did not
// contain the word "research".
//
// ONE REGION, NOT TWO. An earlier draft split this into `lookup` (a fact) and `research` (an
// investigation). They are neighbours in meaning, so the margin between them collapsed on exactly
// the phrasings that matter — "what's the latest on the Artemis programme" is both — and a
// collapsed margin means abstention, which means falling through to the model and inventing a name.
// The question here is binary: does this turn need the web, or not. Depth is a separate decision and
// a much easier one.
//
// WHY `none` IS THE LONGER LIST. A false positive here is worse than a false negative. Answering
// "what did I tell you about my mum" from DuckDuckGo, or turning "what is 17 times 23" into a
// thirty-second research round, is a worse assistant than one that occasionally answers a trivia
// question from memory. Personal recall, device state, arithmetic, code, chit-chat and anything
// imperative all belong to other lanes and must fall straight through this one.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

// The regions whose answer lives on the web. This is a set of REGION NAMES defined in this file —
// a closed category the system owns, in the same way the app index and Contacts are — and never a
// set of words a request might contain. Adding a region here changes what counts as a lookup;
// nothing is ever matched against these strings.
const WEB_REGIONS = new Set(['person', 'fact', 'product', 'topic']);

const WEB_INTENT_EXEMPLARS = {
  // THE WEB SIDE IS FOUR REGIONS FOR THE SAME REASON THE OTHER SIDE IS FIVE.
  //
  // Splitting the junk drawer fixed the false fires and then exposed the identical fault pointing
  // the other way: `web` had become the junk drawer. Twenty-seven exemplars covering people, prices,
  // release dates, distances, news and research requests average to a centroid that is not
  // especially near any of them, so a five-exemplar region could outpull it on a single shared word.
  // Measured, at that point:
  //
  //     "what is the newest samsung phone called"  lost to `machine` by 0.007  ← the word "phone"
  //     "how far is mars from earth"               lost to `reason`  by 0.012
  //     "when does the new season … come out"      lost to `command` by 0.016
  //
  // None of those is a close call in meaning; they are artefacts of averaging. Four tight regions
  // pull properly in their own neighbourhoods, and needsWeb() below simply asks whether the winner
  // was any of them — WEB_REGIONS is the list, and it is a list of REGION NAMES this file owns, not
  // of words a person might say.

  // A NAMED PERSON HE DOES NOT KNOW. The measured hallucinations both live here: asked who runs
  // BlackRock the model invented "Christopher A. Flowers" one day and "Christopher A. Garthwaite"
  // the next. It is Larry Fink. Note "who am I" sits in `personal` — the two sentences are three
  // characters apart and mean opposite things, so both sides have to be taught.
  person: [
    'who is the CEO of BlackRock',
    'who is yessmartypie',
    'who founded Anthropic',
    'who is Elon Musk',
    'who is the guy who created Linux',
    'who is that actor in Oppenheimer',
    'who is the prime minister of japan',
    'who owns Reddit',
    // HINDI BELONGS IN EVERY REGION, NOT ONE. With "mera naam kya hai" and "meri calendar mein kya
    // hai" in `personal` and a single Hindi exemplar here, the Hindi mass sat in `personal` and
    // pulled every Hindi question toward it regardless of subject: "sundar pichai kaun hai" — plainly
    // a lookup — lost to `personal` by 0.109. That is not a threshold problem and it is not fixed by
    // adding the failing sentence; it is fixed by giving each region the language it was missing.
    'mrbeast kaun hai',
    'ratan tata kaun the',
    'yeh actor kaun hai',
  ],

  // PLACES, NUMBERS AND MEASUREMENTS — the encyclopedic facts, where being confidently wrong is
  // indistinguishable from being right.
  fact: [
    'what is the population of Jakarta',
    'what is the capital of Kazakhstan',
    'how tall is the Burj Khalifa',
    'how many people live in Chandigarh',
    'how far is the moon from earth',
    'how deep is the Mariana trench',
    'when is Diwali this year',
    'what year did the Berlin wall come down',
    'japan ki capital kya hai',
    'chandigarh ki population kitni hai',
  ],

  // PRODUCTS: WHAT EXISTS, WHAT IT COSTS, WHETHER IT IS OUT YET. This is the region `machine` was
  // stealing from, because a question about a phone and a question about THIS machine share their
  // nouns and share nothing else.
  product: [
    'when did the iPhone 15 come out',
    'what are the reviews of the Sony XM5 like',
    'is there a new Framework laptop yet',
    'how much does the Vision Pro cost',
    'what is the newest Pixel called',
    'when does the next season come out',
    'what is the price of bitcoin right now',
    'tesla ka share price kya hai',
    'is the Switch 2 out yet',
  ],

  // WHAT IS HAPPENING NOW, AND TOPICS TO GO AND READ ABOUT. The verbs the old regex enumerated live
  // here — reachable because they genuinely belong to this region, not because they are listed.
  topic: [
    'who won the match last night',
    'what happened to Silicon Valley Bank',
    'what is the latest on the Artemis programme',
    "what's happening with the election",
    'latest news on openai',
    'research AR smart glasses power consumption',
    'read up on transformer attention',
    'look into the new EU AI rules',
    'dig into how solid state batteries work',
    'search the web and tell me about the Chandrayaan lander',
  ],
  // ONE JUNK DRAWER BECAME FIVE REGIONS, AND THAT IS THE WHOLE FIX.
  //
  // Everything below used to be a single `none` region: commands, questions about his life, device
  // state, arithmetic and chit-chat, averaged together. A centroid is the MEAN of its exemplars, so
  // averaging forty unrelated sentences produces a vector that means nothing in particular and
  // therefore pulls weakly on everything near it. Measured consequence: "mere contacts dikhao" —
  // plainly an order — won the `web` region by 0.048, beating several genuine lookups. It was never
  // that it resembled a web search; it was that `none` had no coherent place for it to belong.
  //
  // Split into regions that each mean ONE thing, every centroid is tight and pulls hard in its own
  // neighbourhood, and `web` has to beat its NEAREST real competitor rather than an average of
  // everything that is not a lookup. No exemplar below was chosen to fix a specific failing test
  // case; they are the same sentences as before, grouped by what they actually are.

  // THINGS THAT SHOULD HAPPEN. Any language. This gate sits below the action lanes, so these should
  // never arrive — but a gate that would answer a command if one did arrive is a gate waiting to
  // steal one.
  command: [
    'open spotify',
    'play judas',
    'message mama on whatsapp',
    'make a folder called notes on my desktop',
    'search youtube for cat videos',
    'close safari',
    'take a screenshot',
    'order groceries',
    'remind me at 5',
    'show me my contacts',
    'mujhe ek note banao',
    'spotify kholo',
    'mummy ko message karo',
    'yeh file delete kar do',
    'ek folder bana do desktop pe',
  ],

  // HIS OWN LIFE. The store answers these and the web must never see them — the failure that would
  // matter most is a question about his mother becoming a search query. "mera naam kya hai" and
  // "mrbeast kaun hai" are the same sentence shape in opposite regions; the only thing separating
  // them is whether the subject is him, so both sides have to be taught.
  personal: [
    'what did I tell you about my mum',
    'what is on my calendar tomorrow',
    'who am I',
    'what did we talk about yesterday',
    'what is my sister called',
    'remind me what I said about the trip',
    'what did you do today',
    'mera naam kya hai',
    'what is my name',
    'meri calendar mein kya hai',
    'who is my sister',
  ],

  // THE MACHINE ITSELF.
  machine: [
    'what is my battery at',
    'what apps are running',
    'how much disk space do I have',
    'what is on my screen',
    'is the wifi connected',
  ],

  // REASONING, MATHS AND CODE — the model is genuinely good at these and the web adds nothing but
  // thirty seconds. Meta-requests about the conversation itself live here too: "summarise that"
  // operates on what is already in front of it.
  reason: [
    'what is 17 times 23',
    'explain how recursion works',
    'write me a python function that reverses a list',
    'why is my code throwing a null pointer',
    'what is the difference between a list and a tuple',
    'summarise what you just said',
  ],

  // CONVERSATION, AND OPINIONS WANTED FROM HIM RATHER THAN FROM A SEARCH ENGINE.
  social: [
    'good afternoon',
    'how are you',
    'thanks, that is perfect',
    'never mind',
    'what do you think',
    'what should I have for lunch',
    'is this a good idea',
    'which one would you pick',
  ],
};

// MIN_MARGIN IS SWEPT, NOT GUESSED.
//
// Measured on 31 held-out phrasings, not one of them an exemplar (sweep in test_webintent.js):
//
//     threshold   correct fires   FALSE fires   missed
//       0.03          15               3           1
//       0.04          15               1           1
//       0.05          14               0           2      ← chosen
//       0.08          13               0           3
//       0.10          12               0           4
//
//     lowest margin on a CORRECT web case    0.042   "sundar pichai kaun hai"
//     highest margin on a WRONG  web case    0.040   "mujhe kal kya karna hai"
//
// The regions do separate — 0.042 above 0.040 — so a threshold of 0.041 would score 15/16 here with
// no false fires, and it is NOT the one chosen. A 0.002 gap measured over 31 sentences is noise, and
// a threshold sitting inside it is fitted to this set rather than to the problem. 0.05 clears every
// wrong case by 0.010 and costs two misses.
//
// The two errors are not symmetrical, which is what settles it. A MISS costs nothing: the turn falls
// through to exactly the behaviour that exists today. A FALSE FIRE sends one of his private
// questions to a search engine and puts 24 seconds in front of a trivial one. The two cases still
// missed at 0.05 are both Hindi, both genuine lookups, and both are caught at the other end instead
// — see the hedge check in replyhedge.js, which notices the model announcing its own doubt.
//
// DO NOT tune this by adding an exemplar that fixes a failing case in the sweep. The two repairs
// that got the regions here were structural — splitting a junk-drawer region that averaged to
// nothing, and giving every region the Hindi that only one of them had. Patching individual
// held-out failures is fitting the test set, and it makes every number above a lie.
//
// RE-SWEPT for nomic-embed-text (was 0.05 under all-minilm). Leave-one-out over these regions:
// median correct margin 0.154 -> 0.074, so the whole scale halved and 0.05 in the new space is a
// far stricter gate than 0.05 ever was in the old one. LOO accuracy holds at 78/85 against 79/85,
// and the correct margins' 10th percentile sits at 0.023.
const MIN_MARGIN = 0.025;

// AND A SECOND THRESHOLD, BECAUSE A HINGLISH SENTENCE IS READ BY A DIFFERENT MODEL.
//
// all-minilm is an English model, and on his romanized Hinglish it does not merely lose accuracy —
// it LEAKS. Measured on sixteen of his own phrasings, it sent three private questions to the web:
//
//     mere bhai ka naam kya hai   → web      (what is my brother's name)
//     mujhe kal kya karna hai     → web      (what do I have to do tomorrow)
//     mere contacts dikhao        → web      (show my contacts)
//
// granite-embedding:278m reads those correctly and leaks NOTHING: swept across every threshold from
// 0.00 to 0.06, not one local Hinglish sentence ever won a web region — highest wrong margin 0.000,
// against 0.040 for all-minilm. It routes 6 of 8 Hinglish lookups, with the lowest correct margin at
// 0.017, so 0.01 admits all of them and still abstains rather than acting on a tie.
//
// Supplying this is also what switches the routing on (see makeClassifier): a classifier without a
// swept second threshold is never handed a second model, because granite compresses the margins and
// a gate tuned for the main model would simply stop firing.
//
// THIS NUMBER DID NOT MOVE WHEN THE MAIN EMBEDDER DID, and that is not an oversight. It is swept
// against GRANITE, which is unchanged, so the space it measures is unchanged. The main model going
// from all-minilm to nomic-embed-text cannot affect a threshold that is never applied in that space.
//
// WORTH KNOWING, NOT YET ACTED ON: on those same sixteen Hinglish phrasings, nomic scores 14/16 and
// leaks nothing, against granite's 13/16 and all-minilm's 11/16-with-three-leaks. The two-model
// design exists because all-minilm could not read Hinglish at all; its replacement can. Collapsing
// to one model would delete this threshold, this branch, and the evict-and-reload that a Hinglish
// sentence currently costs on an 8 GB machine — but sixteen sentences is too thin a basis to retire
// a leak guard on, so granite stays until that is measured properly.
const MIN_MARGIN_HINGLISH = 0.01;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }

// Returns true when the turn should consult the web, false otherwise. Abstention counts as false:
// if the embedder cannot answer, this falls through to the behaviour that existed before, which is
// the model answering from memory. That is not good, but it is not a REGRESSION, and a gate that
// guessed in the dark would be.
function classifier() {
  if (!_classify) {
    // `none` names a region that deliberately does not exist. makeClassifier suppresses a win by
    // whatever id it is given; here every non-web region is a real, named answer ("this is a
    // command", "this is about him"), and the only thing this caller asks is whether `web` won. So
    // the suppression slot goes unused and the margin check does the work it is there for: `web`
    // must beat its nearest real competitor, not an average of everything else.
    // The groups are the whole point of splitting the regions. `person` beating `fact` is not a
    // close call about whether to search — both answers are on the web — so the margin is measured
    // against the best NON-web region instead. Without this, "who won the world cup in 2022" won
    // `fact` over `topic` by 0.000 and was silenced by its own certainty.
    const groups = {};
    for (const id of Object.keys(WEB_INTENT_EXEMPLARS)) groups[id] = WEB_REGIONS.has(id) ? 'web' : 'local';
    _classify = intent.makeClassifier({
      exemplars: WEB_INTENT_EXEMPLARS, minMargin: MIN_MARGIN, minMarginAlt: MIN_MARGIN_HINGLISH,
      none: '__unused__', groups, label: 'Web', jlog: (m) => _jlog(m),
    });
  }
  return _classify;
}
async function needsWeb(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  try {
    const r = await classifier()(t.slice(0, 300));
    return !!(r && WEB_REGIONS.has(r.id));
  } catch (e) { return false; }
}
// WHICH REGION, not just yes/no: { id, group: 'web'|'local', margin }, or null when it cannot tell. The
// same classifier and thresholds as needsWeb. Used by the hedge guard (server.js): a reply that defers is
// turned into a web lookup only when the QUESTION is not confidently one the web cannot answer.
async function regionOf(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    const r = await classifier()(t.slice(0, 300));
    return r ? { id: r.id, group: WEB_REGIONS.has(r.id) ? 'web' : 'local', margin: r.margin } : null;
  } catch (e) { return null; }
}

module.exports = { needsWeb, regionOf, init, WEB_INTENT_EXEMPLARS, WEB_REGIONS, MIN_MARGIN, MIN_MARGIN_HINGLISH };
