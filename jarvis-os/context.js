'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// JARVIS conversation context — what the request is referring to.
//
// THE BUG THIS EXISTS FOR, verbatim from his terminal:
//
//     ◆ what is claude?
//       Claude is a large language model developed by Anthropic…
//     ◆ okay search it up on youtube
//       Searching on youtube for "it up", Sir.
//
// WHY THE FIRST VERSION OF THIS FILE FAILED, AND WHAT REPLACED IT.
//
// It answered that question with a closed list of pronouns:
//
//     const PRONOUN_RE = /\b(?:it|that|this|those|them|these|same|one)\b/i;
//
// Everything hung off that list — the gate that decided whether to look, the
// regex that decided what to substitute, and the predicate that decided whether
// a target was "bare". It fixed the screenshot above and left the class alone,
// which the next screenshot proved:
//
//     ◆ who is the ceo of nvidia
//       The CEO of Nvidia is Jensen Huang.
//     ◆ search him up on brave
//       Searched Brave Browser for "him up", Sir.
//
// The same bug, one word over, because "him" was not on the list.
//
// WIDENING THE LIST WAS THE WRONG FIX, MEASURED TWICE.
//
// First: pronouns are closed-class, but the failures are not all pronouns.
// "and in mumbai?" and "and my email?" contain none, and no list reaches
// "the second one" or "usko". Definite descriptions and ellipsis are open sets.
//
// Second, and worse: the extractor underneath was measured and it is not good
// enough to trust. Given "Mary Shelley wrote Frankenstein" it returned only
// ["Frankenstein"] — the subject was missed entirely. Given "The CEO of Nvidia
// is Jensen Huang" it returned ["The CEO of Nvidia", "Jensen Huang", "Nvidia"]
// and resolve() took [0], the description rather than the name. So widening the
// gate would have turned a visibly broken query ("him up") into a plausible and
// silently wrong one ("The CEO of Nvidia"). A resolver that guesses confidently
// is worse than one that never ran.
//
// WHAT THIS DOES INSTEAD: ASK, EXTRACTIVELY, AND VALIDATE VERBATIM.
//
// The model is asked which EXACT WORDS from the conversation the request points
// at, and any answer that is not a literal substring of the conversation is
// thrown away. It therefore cannot invent a target: to come back with "Kiran
// Watermelon 2 kg" that string would have to have been said. Measured over 22
// cases this shape produced ZERO wrong resolutions — every failure was a refusal,
// which costs a question rather than the wrong item in a real basket.
//
// WHY NOT A DEDICATED COREFERENCE MODEL. Both were built and measured on the
// same twelve cases before this was written:
//
//   extractive + verbatim gate   9/12   0 wrong   638ms
//   Maverick (DeBERTa-v3-large)  6/12   3 WRONG   509ms
//   AllenNLP coref → ONNX MiniLM 7/12   0 wrong  1727ms
//
// Maverick put "it" on "the macbook air" from a conversation comparing two
// laptops, and linked "him" to "The CEO of Nvidia" without ever reaching the
// name. That is not a tuning problem: a coreference model emits a cluster
// whenever it finds one and has no way to abstain, and abstention is the whole
// point here. The ONNX model can abstain but is slower and less accurate, and
// its 512-span limit is baked into the exported graph.
//
// WHY A MODEL CALL AT ALL, HAVING PREVIOUSLY REFUSED ONE. This file used to say
// a model call cost "tens of seconds" at 9-12 tokens/sec. Measured: 338-751ms
// steady state, because the few-shot prefix is identical every time and ollama
// caches it (402 of 441 tokens). The old reasoning was sound and the number was
// wrong.
//
// IT REFUSES RATHER THAN GUESSES. An unresolved reference returns ok:false with
// a reason, and the caller is expected to ask. That was this file's founding
// principle and it is the one thing that survived the rewrite intact.
//
// NO DEPENDENCIES. Pure stdlib, per this project's standing rule. The only
// injected capability is deps.llm, which is the model the rest of the system is
// already running.
// ---------------------------------------------------------------------------

let deps = { siteKey: null, llm: null };
function init(d) { deps = Object.assign(deps, d || {}); }

// How many turns back to look, and how much of each. Short on purpose: a long
// transcript is the single thing that makes a 3B lose the plot, which is why
// handleChatInner already slices to -8 on the local model.
const TURNS = 6;
const PER_TURN = 200;

function transcriptOf(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const prior = messages.slice(0, -1)
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .slice(-TURNS);
  if (!prior.length) return null;
  return prior;
}

function render(prior) {
  const who = profile.userLabel() + ': ';
  return prior.map(m => (m.role === 'assistant' ? 'JARVIS: ' : who) +
    String(m.content).replace(/\s+/g, ' ').trim().slice(0, PER_TURN)).join('\n');
}

function firstLine(raw) {
  return String(raw || '').split('\n')[0].trim().replace(/^["'`]+|["'`.]+$/g, '').trim();
}

// The examples carry the calibration, and the balance matters: weighted toward
// refusal the model answered NONE to everything, which is safe and useless.
// Five that resolve, two that refuse.
// The speaker label matches render() — the user's name, or "User" — so the examples and the real
// transcript always read alike. For a named user this is exactly the text that was measured.
const STANDS_FOR_SHOTS = () =>
  'CONVERSATION:\n' + profile.userLabel() + ': what is claude\nJARVIS: Claude is a large language model by Anthropic.\n' +
  'REQUEST: search it up on youtube\nSTANDS FOR: Claude\n\n' +
  'CONVERSATION:\n' + profile.userLabel() + ': who won the match\nJARVIS: India beat Australia by 6 wickets.\n' +
  'REQUEST: how many runs did they score\nSTANDS FOR: India\n\n' +
  'CONVERSATION:\n' + profile.userLabel() + ': open the calculator\nJARVIS: Booting Calculator, sir.\n' +
  'REQUEST: close it\nSTANDS FOR: Calculator\n\n' +
  'CONVERSATION:\n' + profile.userLabel() + ': what is the weather in tokyo\nJARVIS: Tokyo is 22C and sunny.\n' +
  'REQUEST: book me a hotel there\nSTANDS FOR: Tokyo\n\n' +
  'CONVERSATION:\n' + profile.userLabel() + ': show me nearby cafes\nJARVIS: Found: 1 Blue Tokai  2 Third Wave  3 Starbucks\n' +
  'REQUEST: directions to the third one\nSTANDS FOR: Starbucks\n\n' +
  // ACTING ON A PERSON, ON A PLATFORM. Every shot above is search/close/book/order shaped, and
  // "follow him on spotify" came back NONE against a transcript that had just named Michael
  // Jackson — while "search him up" on the same transcript resolved fine. The referent was never
  // the problem; the VERB was outside the region the examples described.
  'CONVERSATION:\n' + profile.userLabel() + ': who is michael jackson\nJARVIS: Michael Jackson was a singer and dancer, known for Thriller.\n' +
  'REQUEST: follow him on spotify\nSTANDS FOR: Michael Jackson\n\n' +
  'CONVERSATION:\n' + profile.userLabel() + ': who is mrbeast\nJARVIS: MrBeast is a YouTuber known for large-scale stunts.\n' +
  'REQUEST: open his youtube channel\nSTANDS FOR: MrBeast\n\n' +
  'CONVERSATION:\n' + profile.userLabel() + ': what is the weather in delhi\nJARVIS: Delhi is 33C and clear.\n' +
  'REQUEST: order me a watermelon\nSTANDS FOR: NONE\n\n' +
  'CONVERSATION:\n' + profile.userLabel() + ': compare the iphone 16 and the pixel 9\nJARVIS: Both are strong; the Pixel has better photos.\n' +
  'REQUEST: order it\nSTANDS FOR: NONE\n\n';

const STANDS_FOR_SYS = 'The REQUEST may use a short word standing in for something named earlier in the ' +
  'CONVERSATION. Answer with the EXACT WORDS from the CONVERSATION that it stands for, copied ' +
  'exactly. If the REQUEST already names everything it needs, or nothing earlier fits, or two ' +
  'things fit equally well, answer NONE. Answer with nothing else.';

// WHAT THE REQUEST IS POINTING AT. Returns the exact earlier words, or refuses.
//
//   standsFor('search him up on brave', msgs)  -> { ok:true,  value:'Jensen Huang' }
//   standsFor('order me some grapes', msgs)    -> { ok:false, reason:'NONE' }
// The exact prompt standsFor sends — exported so the Bonsai `jarvis` training rows (finetune/
// build_bonsai_data.js) are built from THIS text and never from a copy that drifts. null = nothing to ask.
function standsForPrompt(text, messages) {
  const goal = String(text == null ? '' : text);
  const prior = transcriptOf(messages);
  if (!goal.trim() || !prior) return null;
  return { system: STANDS_FOR_SYS, user: STANDS_FOR_SHOTS() + 'CONVERSATION:\n' + render(prior) + '\nREQUEST: ' + goal + '\nSTANDS FOR:' };
}

async function standsFor(text, messages) {
  const goal = String(text == null ? '' : text);
  if (!deps.llm || !goal.trim()) return { ok: false, reason: 'nothing to resolve' };
  const prior = transcriptOf(messages);
  if (!prior) return { ok: false, reason: 'no history' };
  // ASKED FOR ONE THING ONLY: WHAT IT REFERS TO.
  //
  // A third answer, UNCLEAR, used to live in this prompt so the caller could tell "stands on its
  // own" from "plainly pointing at something I cannot name". Measured on the case it existed for —
  // "compare the macbook air and the thinkpad x1" / "search it up" — the 3B answered NONE three
  // times out of three at temperature 0, and at the default temperature it answered UNCLEAR once
  // and NONE nine times. The label was never working; sampling was hiding how consistently it did
  // not. Whether a request leans at all is a question about its SHAPE, and leansOnContext answers
  // it with the embedder instead — 17/17, no false positives. This call answers what it refers to,
  // and nothing else.
  const pr = standsForPrompt(goal, messages);
  let raw = '';
  try {
    const r = await deps.llm({ system: pr.system,
      messages: [{ role: 'user', content: pr.user }],
      // Deterministic on purpose: this answer is acted on, and at the model's default temperature
      // the same question returned a WRONG referent one run in ten. See the note in server.js llm().
      max_tokens: 24, timeoutMs: 30000, temperature: 0 });
    raw = String((r && r.text) || '');
  } catch (e) { return { ok: false, reason: 'llm failed' }; }
  return judgeStandsFor(raw, goal, prior);
}

// What standsFor makes of the model's raw answer — exported so the `jarvis` eval (finetune/score_bonsai.js)
// scores a candidate model's answer exactly as the live resolver would read it.
function judgeStandsFor(raw, goal, prior) {
  const ans = firstLine(raw);
  if (!ans || /^none$/i.test(ans)) return { ok: false, reason: 'NONE' };
  // THE GATE. It must have been said, or it did not happen.
  const hay = prior.map(m => String(m.content)).join(' \n ').toLowerCase();
  if (!hay.includes(ans.toLowerCase())) return { ok: false, reason: 'not verbatim: ' + JSON.stringify(ans.slice(0, 40)) };
  // Already spelled out in the request — that is not a reference, and substituting
  // it would rewrite a sentence that was already complete.
  if (String(goal).toLowerCase().includes(ans.toLowerCase())) return { ok: false, reason: 'already named' };
  return { ok: true, value: ans };
}

// "search it UP on youtube" — the particle belongs to the verb, not the query.
// Taught by example rather than by a list of particles, so a folder genuinely
// called "backup up" is never quietly rewritten.
const WORDS_FOR_SHOTS =
  'REQUEST: search it up on youtube\nTHING: Claude\nWORDS: it up\n\n' +
  'REQUEST: how many runs did they score\nTHING: India\nWORDS: they\n\n' +
  'REQUEST: close it\nTHING: Calculator\nWORDS: it\n\n' +
  'REQUEST: book me a hotel there\nTHING: Tokyo\nWORDS: there\n\n' +
  'REQUEST: directions to the third one\nTHING: Starbucks\nWORDS: the third one\n\n' +
  'REQUEST: look him up on brave\nTHING: Jensen Huang\nWORDS: him up\n\n' +
  // A PERSON AS THE OBJECT, AND A POSSESSIVE. Every example above is search/close/book shaped, and
  // both of these came back NULL against a referent standsFor had already resolved correctly —
  // so the request was refused for want of knowing which two letters to replace.
  'REQUEST: follow him on spotify\nTHING: Michael Jackson\nWORDS: him\n\n' +
  'REQUEST: open his youtube channel\nTHING: MrBeast\nWORDS: his\n\n' +
  'REQUEST: subscribe to her channel\nTHING: Veritasium\nWORDS: her\n\n';

// WHICH WORDS STAND FOR IT — deliberately a SECOND question, asked only once the
// referent is already settled.
//
// Asking for both together scored higher and was wrong once, which is once too
// many: from a conversation comparing two laptops, "buy it" came back as "buy the
// macbook air". A model will pick a side when a single answer is demanded of it.
// standsFor asked alone refuses that case outright, so the ambiguity guard is
// upstream and this call cannot re-open it.
async function wordsFor(text, refers) {
  const goal = String(text == null ? '' : text);
  if (!deps.llm || !goal.trim() || !refers) return null;
  const sys = 'Reply with the EXACT WORDS from the REQUEST that stand in for the THING, copied ' +
    'exactly from the REQUEST. Reply with nothing else.';
  let raw = '';
  try {
    const r = await deps.llm({ system: sys,
      messages: [{ role: 'user', content: WORDS_FOR_SHOTS + 'REQUEST: ' + goal + '\nTHING: ' + refers + '\nWORDS:' }],
      max_tokens: 16, timeoutMs: 30000, temperature: 0 });
    raw = String((r && r.text) || '');
  } catch (e) { return null; }
  const w = firstLine(raw);
  if (!w || /^none$/i.test(w)) return null;
  const at = goal.toLowerCase().indexOf(w.toLowerCase());
  if (at < 0) return null;                                  // not his words; drop it
  if (w.length >= goal.trim().length) return null;          // "replace the whole request" is not a reference
  return { words: w, at };
}

// DOES THIS REQUEST LEAN ON THE CONVERSATION AT ALL? — a question about SHAPE, not about meaning.
//
// standsFor answers "what does it refer to", and both a self-contained request and an ambiguous one
// come back NONE. Those two need opposite handling: one is a fresh command, the other must not be
// acted on as written. Measured, that distinction defeats the 3B in both framings tried — asking it
// for an UNCLEAR label, and asking it which words are standing in (11/15, and it flagged "message
// parth on whatsapp that i am late" as incomplete, which would have blocked a real message).
//
// The embedder does it cleanly: 17/17 with no false positives. That is not surprising in hindsight.
// "search it up", "buy it", "delete them" and "show me that one" share a SHAPE — a request with a
// hole where its object should be — and shape is what an embedding is good at. What it refers to is
// a lookup, and that is what the extractive call is for. Two questions, each asked of the thing that
// can answer it.
const LEANING_EXEMPLARS = {
  leaning: [
    'search it up', 'close it', 'buy it', 'delete them', 'open his channel',
    'play his latest video', 'order from the second one', 'book me a flight there',
    'mark them as read', 'search him up', 'do that again', 'put it on',
    'show me those', 'order that one',
  ],
  self_contained: [
    'search for pizza recipes on brave', 'open spotify', 'play judas', 'what is the weather',
    'order me some grapes', 'close textedit', 'message parth on whatsapp that i am late',
    'who is the ceo of nvidia', 'what is my name', 'order me a pizza',
    'play the latest mrbeast video', 'buy me a phone charger', 'look up rust on brave',
    'what is on my calendar',
  ],
};
let _leans = null;
async function leansOnContext(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (!_leans) {
    const intent = require('./intent.js');
    // 0.15, MEASURED — 0.05 blocked him from installing an app.
    //
    //   "search it up" 0.239   "delete them" 0.271   "buy it" 0.227   "close it" 0.196
    //   "ok install among us" 0.054   "follow him on spotify" 0.072
    //
    // "among US" reads as a pronoun to an embedder, and at 0.05 the refusal fired on a request that
    // named its object perfectly well: "ok install among us" was answered "what are you pointing
    // at?". Blocking real work is worse than the bug this gate exists for, so the bar sits above
    // everything that turned out to be a false alarm and below everything that was genuinely
    // dangling. When in doubt this gate must let the request THROUGH.
    _leans = intent.makeClassifier({
      // 0.045, re-swept for nomic-embed-text (was 0.15 under all-minilm). This gate moved further
      // than any other because its margins compressed hardest: median correct 0.112 -> 0.032, a
      // ratio of 0.29, which puts the old 0.15 far above anything the new space ever produces — it
      // would have fired NEVER. That failure would have been silent and in the safe direction (the
      // request goes through, which is what the paragraph above asks for), which is exactly why it
      // needed measuring rather than leaving alone. Leave-one-out puts every wrong decision at or
      // below 0.035; 0.045 clears them with room and still errs towards letting work through.
      exemplars: LEANING_EXEMPLARS, minMargin: 0.045, none: 'self_contained',
      label: 'Leaning', jlog: () => {},
    });
  }
  try { const r = await _leans(t); return !!(r && r.id === 'leaning'); }
  catch (e) { return false; }
}

// THE ONE CALLERS SHOULD USE.
//
// Give it the sentence and the conversation; it hands back a sentence that says
// what he meant, or refuses. A refusal is a result, not an error: the caller asks.
//
//   resolveInText('search him up on brave', msgs)
//     -> { ok:true, text:'search Jensen Huang on brave', changed:true, value:'Jensen Huang' }
//   resolveInText('order me some grapes', msgs)
//     -> { ok:true, text:'order me some grapes', changed:false }   // self-contained
//   resolveInText('buy it', ambiguousMsgs)
//     -> { ok:false, leaned:false, reason:'NONE' }                 // refused, not guessed
//
// `leaned` says the request DOES point at something earlier but could not be put
// back into the sentence. That is the signal a caller uses to ask him rather than
// act on a sentence it knows is incomplete — it replaces the old isBareReference,
// and unlike that predicate it is not a list of words.
async function resolveInText(text, messages) {
  const src = String(text == null ? '' : text);
  const sf = await standsFor(src, messages);
  if (!sf.ok) {
    // Nothing to substitute. Two very different reasons for that, and only the embedder can tell
    // them apart: a request that stands on its own is a fresh command, and one with a hole in it
    // must not be acted on as written — "search it up" went to DuckDuckGo for "it up" for exactly
    // as long as this distinction was missing.
    const leaning = transcriptOf(messages) ? await leansOnContext(src) : false;
    if (leaning) return { ok: false, text: src, changed: false, leaned: true, reason: 'points at something I cannot name' };
    return { ok: true, text: src, changed: false, leaned: false, reason: sf.reason };
  }
  const wf = await wordsFor(src, sf.value);
  if (!wf) return { ok: false, text: src, changed: false, leaned: true, value: sf.value, reason: 'could not place it' };
  return {
    ok: true,
    text: src.slice(0, wf.at) + sf.value + src.slice(wf.at + wf.words.length),
    changed: true, leaned: true, value: sf.value, words: wf.words,
  };
}

// HOW MUCH THE REQUEST LEANS, AS A NUMBER: cos to the `leaning` centroid − cos to `self_contained`, same
// exemplars and embedder as leansOnContext. Negative = reads self-contained. Used by server.js's resolver
// skip (see REFERS_SKIP), which needs the score rather than the label. null when the embedder is down.
async function leanScore(text) {
  const t = String(text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!t) return null;
  try {
    const intent = require('./intent.js');
    const cL = await intent.centroidOf(intent.MODEL, LEANING_EXEMPLARS.leaning);
    const cS = await intent.centroidOf(intent.MODEL, LEANING_EXEMPLARS.self_contained);
    const v = await intent.embed(t, intent.MODEL);
    return cL && cS && v ? intent.cos(v, cL) - intent.cos(v, cS) : null;
  } catch (e) { return null; }
}

module.exports = { init, standsFor, standsForPrompt, judgeStandsFor, transcriptOf, wordsFor, leansOnContext, leanScore, resolveInText, LEANING_EXEMPLARS };
