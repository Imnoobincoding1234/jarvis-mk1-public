'use strict';
// ---------------------------------------------------------------------------
// IS HE TELLING ME SOMETHING ABOUT HIMSELF THAT IS WORTH KEEPING?
//
// WHAT WAS HERE BEFORE, and why it had to go.
//
//     const SELF_FACT_RE = /^(?:jarvis[,\s]+)?(my\s+[a-z][\w' -]{1,40}?\s+(?:is|are)\s+.{2,200})$/i;
//
// That is a keyword trap by the §0 definition, and a particularly expensive one: it decides whether
// his memory records anything at all. To be remembered a sentence had to BEGIN with the word "my"
// and join subject to value with "is" or "are". Everything else was acknowledged warmly by the 3B
// and thrown away. Reported live, from his terminal:
//
//     ◆ i hate summer and enjoy winters
//       "Understood, Mihir enjoys the cooler temperatures…"        ← nothing stored
//     ◆ do i hate summer
//       "You told me: Mihir hates being woken up early, hates phone calls, and hates people
//        being late, Sir."                                          ← answered from older facts
//
// The sentence starts with "i" and its verb is "hate", so it matched neither clause. Nor would
// "I'm allergic to peanuts", "I live in Nagpur", "I work nights", "I've got a sister called
// Anaya", "call me Mihir" — every one of them a fact about him, none of them shaped like the
// regex. The verb people use to state a fact about themselves is an OPEN CLASS, and so is the
// sentence frame; there is no end to the work of adding more.
//
// WHAT THIS DOES INSTEAD. Three regions, embedded and compared to centroids, with abstention — the
// same machinery as itemclass, webintent and calintent, one level up.
//
//   durable     a fact that will still be true next week. Preferences, attributes, relationships,
//               habits, where he lives, what he is called.
//   transient   a reading that is true for a minute. "my battery is low" is a measurement, not
//               something to recite back to him in a fortnight. This region is why the old
//               TRANSIENT_FACT_RE list of device nouns is no longer needed.
//   other       everything else: questions, commands, small talk, statements about the world
//               rather than about him.
//
// ABSTENTION IS THE SAFE DIRECTION HERE, and it is worth being explicit about which way that runs.
// Failing to store a fact is what happens today for every phrasing outside the regex, so a miss is
// no worse than the status quo; storing a QUESTION or a command as a fact would put a falsehood in
// his memory that he would then be told back as something he said. So the margin gates storing,
// never gates ignoring.
//
// NO DEPENDENCIES beyond the shared classifier.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

let deps = { jlog: () => {}, isQuestion: null };
function init(d) { deps = Object.assign(deps, d || {}); }

// Nothing here is matched literally. Each list stands for a REGION of meaning, and the point of the
// durable list is that it spans FRAMES — "my X is Y", "I am", "I have", "I hate", "I work",
// "call me" — rather than spanning vocabulary.
const EXEMPLARS = {
  durable: [
    'my favourite colour is teal',
    'i hate summer and enjoy winters',
    'i am allergic to peanuts',
    'i live in nagpur',
    'i work at a startup',
    'i have a sister called anaya',
    'i prefer tea over coffee',
    'i usually wake up at seven',
    'call me mihir',
    'i am scared of heights',
    'my birthday is in march',
    'i do not eat meat',
  ],
  transient: [
    'my battery is low',
    'my wifi is down',
    'my screen is too dim',
    'my laptop is running hot',
    'my internet is slow right now',
    'my disk is nearly full',
    'i am tired today',
    'i am in a hurry right now',
  ],
  // `other` IS THREE REGIONS, GROUPED. As one list it was a junk drawer — questions, commands and
  // statements about the world averaged into a centroid that stood for nothing, and the measurement
  // showed exactly the damage that does: at a 0.04 margin it swallowed NINE of twelve held-out
  // facts, including "my dog is called bruno" and "i am left handed". A memory that files one fact
  // in four is not a memory. Split into coherent regions and rejoined with `groups`, the same
  // repair as playbook.js.
  // THERE IS NO `other-question` REGION, AND THAT IS THE POINT.
  //
  // There was one, and it did more damage than the regex it replaced. "i hate summer and enjoy
  // winters" scored durable 0.6752 against other-question 0.6733 — a margin of 0.002 — because the
  // region contained "do i hate summer", and to an embedder a statement and the question about that
  // statement are nearly the same sentence. They differ in SYNTAX, not in meaning.
  //
  // Asking the embedder to make that call is asking the wrong instrument, and it silenced the very
  // fact this file was written to store. Question-versus-statement is already decided, correctly and
  // deterministically, by isQuestion() — built on wh-words and auxiliaries, which are a CLOSED
  // grammatical category and one of the permitted exceptions. So it is injected below rather than
  // re-learned here, exactly as WH_RE is injected into verblex, leaving one implementation.
  'other-command': [
    'open spotify',
    'play some music',
    'text mama that i am running late',
    'create three folders on my desktop',
    'remind me to call the dentist',
    'close the calculator',
  ],
  'other-world': [
    'the eiffel tower is in paris',
    'water boils at a hundred degrees',
    'the train leaves at six',
    'thanks that worked',
  ],
};

// Both halves of `other` answer the same thing to this caller: do not store it.
const GROUPS = {
  'other-command': 'other',
  'other-world': 'other',
};

// SWEPT, NOT GUESSED. On 30 held-out sentences written before the regions were split and never
// added to them (test_selffact.js holds the set and prints the table):
//
//   margin   stored-correctly   WRONGLY STORED   missed
//     0.00        27                  3            0
//     0.02        25                  3            2     <- ships
//     0.04        22                  2            6
//     0.08        20                  1            9
//     0.15        18                  0           12
//
// A LOW MARGIN, AND THE REASON IS UPSTREAM. Normally the first threshold with nothing wrong would
// ship. Here every one of the three "wrong" rows is a QUESTION — "do i like winters" (0.149),
// "what is my dog called" (0.065), "who is the prime minister" (0.039) — and a question never
// reaches this classifier: isQuestion() refuses it at the top of isSelfFact(). Raising the margin
// to exclude them buys nothing real and costs four more genuine facts, including "i am left handed"
// and "my mum works as a teacher". Excluding the questions the gate already removes, 0.02 scores
// 25 of 27 with nothing wrong.
//
// So the errors this margin is actually trading are: a miss, which leaves his memory as it is
// today, against storing a TRANSIENT state as though it were durable — "my hands are freezing"
// filed forever. The second is mild and visible; the dangerous one, a question stored as a fact he
// never stated, is excluded before it gets here.
const MIN_MARGIN = 0.02;

let _classify = null;
function classifier() {
  if (!_classify) {
    _classify = intent.makeClassifier({
      exemplars: EXEMPLARS, minMargin: MIN_MARGIN, none: 'other', groups: GROUPS,
      label: 'Self-fact', jlog: m => deps.jlog(m),
    });
  }
  return _classify;
}

// Returns true only for a durable fact about him. `other` is the none region, so it returns null
// from the classifier and false from here; `transient` is a real region and is refused explicitly,
// which is what keeps "my battery is low" out of his long-term memory.
// LIVE SINCE 2026-09-25: V2 alone decides (EXEMPLARS_V2 below). isQuestion() is no longer in front — it rested
// on the "closed grammatical category" exception, which was revoked on 2026-09-13 — and the explicit
// "remember that …" forms are durable examples instead of a remember-phrase list. V2's other-question holds
// requests for STORED information ("what do you know about me"), not a fact's own question-twin — the
// "do i hate summer" collision below. Only JARVIS's OWN name addressed at the front is set aside (a
// machine-owned string; the old lane stripped it too). Measured, sweeps/sweep_selffact.js on
// finetune/data/selffact_heldout*.json (both written first; margin 0.02 chosen by leave-one-out):
//
//     lane                                      facts stored   junk wrongly stored
//     old (remember list + isQuestion + V1)     26/30          7/40  (every "tell me/give me a fact …")
//     V2 alone                                  25/30          0/40
//
// It runs on its own pinned embedder BEFORE any chat model, so a new chat model cannot change it.
function unaddress(t) { return String(t).replace(/^\s*jarvis\b[\s,:!-]*/i, ''); }
async function isSelfFact(text) {
  const t = unaddress(String(text || '').trim());
  if (t.length < 4 || t.length > 300) return false;
  let r = null;
  try { r = await classifierV2()(t); } catch (e) { return false; }
  if (!r) return false;
  if ((r.group || r.id) !== 'durable') {
    if (deps.jlog) deps.jlog('Self-fact › "' + t.slice(0, 40) + '" reads as ' + r.id + ' — not storing');
    return false;
  }
  return true;
}

// ---- V2 (2026-09-25): the classifier ALONE decides, with no word list in front of it. ----
// "tell me a fun fact about space" was stored as a fact about the user. The regions above had no place for a
// REQUEST to JARVIS or a QUESTION about the user, so those fell into whichever region was nearest, and the
// word tests in front (a remember-phrase list, isQuestion) are keyword traps. V2 adds the regions, and puts
// the explicit "remember that …" forms into `durable`, so the lane needs neither list. New sentences only.
const EXEMPLARS_V2 = {
  durable: EXEMPLARS.durable.concat([
    'remember that my wifi password is on the fridge',
    'note down that i take vitamins every morning',
    'keep in mind that i am left handed',
    'dont forget my anniversary is in june',
    'jarvis my car is a white swift',
  ]),
  transient: EXEMPLARS.transient.concat(['i feel sleepy', 'my head hurts a bit', 'my phone is on 5 percent']),
  'other-command': EXEMPLARS['other-command'].concat(['remind me to stretch at five', 'set a timer for ten minutes']),
  'other-world': EXEMPLARS['other-world'].concat(['fun fact honey never spoils', 'octopuses have three hearts', 'the sun is a star']),
  'other-request': [
    'tell me a joke', 'give me an interesting fact', 'tell me something cool about the ocean', 'share a random fact',
    'teach me a new word', 'suggest a book to read', 'say something funny', 'explain how rainbows form',
    'tell me about ancient rome', 'give me a fun fact about animals', 'surprise me with a fact',
  ],
  'other-question': [
    'what is my favourite pizza', 'do you know where i work', 'when is my sisters birthday', 'whats my name',
    'what did i tell you about my allergies', 'do u remember what i like to eat', 'what do you know about me',
  ],
  'other-chat': ['thanks', 'hello jarvis', 'good night', 'nice one', 'ok cool', 'how are you'],
};
const GROUPS_V2 = { 'other-command': 'other', 'other-world': 'other', 'other-request': 'other', 'other-question': 'other', 'other-chat': 'other' };
const MIN_MARGIN_V2 = 0.02;
let _classifyV2 = null;
function classifierV2() {
  if (!_classifyV2) {
    _classifyV2 = intent.makeClassifier({
      exemplars: EXEMPLARS_V2, minMargin: MIN_MARGIN_V2, none: 'other', groups: GROUPS_V2,
      label: 'Self-fact', jlog: m => deps.jlog(m),
    });
  }
  return _classifyV2;
}

module.exports = { init, isSelfFact, EXEMPLARS, GROUPS, MIN_MARGIN, EXEMPLARS_V2, GROUPS_V2, MIN_MARGIN_V2 };
