'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// corrections.js — notice when he fixes an answer, and stop being wrong the same
// way twice.
//
// This project already learns from a correction in exactly ONE place: rephrase()
// in learned.js records "this wording means that taught procedure" after he
// answers a same-job question. Everything else he corrects is thrown away. Told
// "no, Parth's number is the other one", "it's spelled Atharv not Atharva", "I
// said the AdMax site not the AdMax repo", JARVIS agrees pleasantly in the moment
// and holds the same wrong belief on the next turn.
//
// WHAT COUNTS AS A CORRECTION, structurally rather than as a phrase list:
//   1. It follows an assistant turn. A correction has to correct something.
//   2. It opens with a REPAIR MARKER — no/not/actually/I meant/wrong — which is a
//      genuinely closed class in English, unlike the content words after it.
//   3. It carries content beyond the marker. "no" alone is a refusal, not a
//      correction, and storing it would poison retrieval with an empty fact.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not try to work out WHICH span of the
// previous answer was wrong, and it does not edit anything. A 3B cannot do that
// reliably and a wrong edit to stored memory is worse than no edit — the whole
// point is to stop confidently repeating a mistake, so replacing it with a
// differently-confident mistake fails on its own terms. It records the correction
// as a first-class fact next to what it corrected, and lets retrieval surface both.
//
// Zero dependencies, per this project's standing rule.
// ---------------------------------------------------------------------------

let deps = { jlog: () => {}, recall: null };
function init(d) { deps = Object.assign(deps, d || {}); }

// The repair markers. Closed class, and anchored to the START of the utterance —
// "I know it is not raining" contains "not" and corrects nothing, while "not the
// repo, the site" is a correction and opens with one. Hinglish included because
// he mixes it in constantly and a guard that only speaks English is a guard with
// a hole in it (see the Hinglish note in server.js's isStatement).
const REPAIR_RE = new RegExp(
  '^\\s*(?:' +
  'no+\\b|nope\\b|nah\\b|not\\b|wrong\\b|incorrect\\b|' +
  "that'?s (?:not|wrong|incorrect)\\b|" +
  'actually\\b|i meant\\b|i said\\b|i asked for\\b|' +
  '(?:it|its|it\'?s) (?:not|actually)\\b|' +
  'correction\\b|rather\\b|instead\\b|' +
  'nahi+\\b|nahin\\b|galat\\b|arre nahi\\b' +
  ')', 'i');

// A marker with nothing after it is a refusal, not a correction. Measured in
// characters of remaining content rather than words, so "no, 9812" counts.
const MIN_CONTENT = 4;

// Was this utterance a correction of the turn before it?
// `prevAssistant` is what JARVIS last said; without one there is nothing to correct.
function detect(userText, prevAssistant) {
  const t = String(userText || '').trim();
  if (!t || !String(prevAssistant || '').trim()) return null;
  const m = t.match(REPAIR_RE);
  if (!m) return null;
  const rest = t.slice(m[0].length).replace(/^[\s,.:;—-]+/, '').trim();
  if (rest.length < MIN_CONTENT) return null;       // "no." / "nope" — a refusal
  // A QUESTION IS NOT A CORRECTION. "no, what did you mean?" opens with a repair
  // marker and is asking, not telling; storing it as a fact would file a question
  // as a belief.
  if (/\?\s*$/.test(rest)) return null;
  // ABANDONING A REQUEST IS NOT CORRECTING AN ANSWER. "actually never mind" opens
  // with a repair marker and carries content, and filing it would store the
  // standing fact "Atharv corrected me: never mind" — which then competes for
  // retrieval slots with things he actually said.
  if (/^(?:never\s?mind|nvm|forget it|leave it|skip it|cancel that|don'?t bother|rehne do|chhod do)\b/i.test(rest)) return null;
  return { marker: m[0].trim().toLowerCase(), correction: rest.slice(0, 300) };
}

// Record it. Stored through recall.log so it lands in the same journal everything
// else does — which means it is redacted on the way to disk and retrievable by the
// same tf-idf path, rather than needing a second store and a second retrieval
// route that would drift from the first.
function note(userText, prevAssistant) {
  const hit = detect(userText, prevAssistant);
  if (!hit) return null;
  const line = profile.userLabel() + ' corrected me: ' + hit.correction +
               ' (I had said: ' + String(prevAssistant).replace(/\s+/g, ' ').trim().slice(0, 160) + ')';
  try {
    if (deps.recall && deps.recall.log) deps.recall.log('correction', line);
    deps.jlog('Correction › noted — "' + hit.correction.slice(0, 48) + '"');
  } catch (e) { return null; }
  return hit;
}

module.exports = { init, detect, note, REPAIR_RE };
