'use strict';
// ---------------------------------------------------------------------------
// notekind.js — is a note's content something to WRITE, or words to KEEP as they are?
//
// Reader round 3 (2026-09-27) reads "jot down buy eggs milk bread" and "write a passage about tea in notes"
// the same way: act `note`, content copied from his words ("buy eggs milk bread" / "a passage about tea").
// The first is saved as it stands; the second asks for text to be written. The old note plan told them
// apart with a regex on "about|on|regarding|for" anywhere in the sentence — which turns "note down the test
// is ON the 14th" into "Write a is about the 14th". This is an embedder reader over the CONTENT alone,
// regions of exemplars in his style, the same machinery as whyintent.js.
//
// SAFE SIDE: when it is not sure, the words are KEPT. Saving "a passage about tea" literally is visible and
// harmless; writing a passage he did not ask for is invention.
//
// MIN_MARGIN IS PROVISIONAL — not yet measured. Before this goes live: leave-one-out on these exemplars
// (sweeps/sweep_notekind.js, to be written) and a fresh held-out set (finetune/data/notekind_heldout.json),
// numbers in this comment, the way whyintent.js records its own. Measured only when no model is training.
// ---------------------------------------------------------------------------
const intent = require('./intent.js');

const NOTE_EXEMPLARS = {
  write: [
    'a passage about the ocean', 'a short poem about rain', 'an essay on tigers', 'a paragraph about friendship',
    'a haiku about cats', 'a long passage about the history of aviation', 'something about my trip to shimla',
    'a story about a dragon', 'a few lines about my mom', 'a summary of photosynthesis', 'a letter to my teacher asking for leave',
    'some tips for studying', 'a rap about jarvis', 'a speech for the farewell', 'a short bio for my insta',
    'kuch lines dosti pe', 'a description of our new logo',
  ],
  keep: [
    'buy eggs milk bread', 'the wifi password is on the router', 'call the plumber tmrw', 'gym at 6 every day',
    'parth owes me 500', 'the locker code is 4412', 'project due friday', 'meeting moved to 3pm', 'dentist on the 12th',
    'ideas: dark mode, voice wake', 'rahul bday 14 march', 'pick up the parcel', 'my shoe size is 9', 'hello',
    'doodh aur bread lana hai', 'the test is on the 14th', 'passwords go in the vault not here',
  ],
};
const GROUPS = { write: 'write', keep: 'keep' };
const MIN_MARGIN = process.env.JARVIS_NOTEKIND_MARGIN != null ? Number(process.env.JARVIS_NOTEKIND_MARGIN) : 0.03;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }
function classifier() {
  if (!_classify) {
    _classify = intent.makeClassifier({
      exemplars: NOTE_EXEMPLARS, minMargin: MIN_MARGIN, none: 'keep', groups: GROUPS,
      label: 'Note kind', jlog: m => _jlog(m),
    });
  }
  return _classify;
}
// 'write' only when the embedder is sure; anything else is 'keep'.
async function kindOf(content) {
  const t = String(content || '').trim();
  if (!t || t.length > 300) return 'keep';
  try { const r = await classifier()(t); return r && r.id === 'write' ? 'write' : 'keep'; } catch (e) { return 'keep'; }
}

module.exports = { init, kindOf, NOTE_EXEMPLARS, GROUPS, MIN_MARGIN };
