'use strict';
// ---------------------------------------------------------------------------
// IS HE WRITING HINGLISH? — answered by what a sentence is NOT, so no Hindi is ever listed.
//
// WHY THIS EXISTS. all-minilm is an English model, and measured on his own romanized Hinglish it
// does not merely lose accuracy, it leaks:
//
//     mere bhai ka naam kya hai   → web      (what is my brother's name)
//     mujhe kal kya karna hai     → web      (what do I have to do tomorrow)
//     mere contacts dikhao        → web      (show my contacts)
//
// Three private questions routed to a search engine. granite-embedding:278m gets all three right and
// leaks nothing — 14/16 against 11/16, and no local case reaches the web group at all. But granite
// is 2.5x slower, 6.5x more resident, and compresses every margin, so adopting it for EVERYTHING
// would mean re-sweeping every threshold in the system and would make English worse. The answer is
// to send each sentence to the model that is good at it.
//
// THE DETECTOR NAMES NO HINDI. A list of Hindi words is the same trap in a new language: it fails on
// the word nobody wrote down, and "the word nobody wrote down" is most of a language. So the
// question is inverted — how much of this sentence is ENGLISH? — and answered against the 236k-word
// dictionary macOS ships at /usr/share/dict/words. That is a registry, like the app index or
// Contacts: a closed set the system owns rather than a list anybody here maintains. A Hindi word
// this file has never seen still fails the test, which is exactly the property a word list lacks.
//
// PROPER NOUNS ARE NEUTRAL, NOT EVIDENCE, AND THE SYSTEM ALREADY KNOWS WHICH THEY ARE.
//
// "spotify", "notes", "kunal" are in no English dictionary and in no Hindi one either, so counting
// them as non-English makes every sentence that names an app or a person look Hindi. A first version
// tried to spot them by LENGTH — unknown and longer than seven characters — and it was measured and
// it failed, because the names he actually uses are short:
//
//     open spotify   → HINGLISH      open notes   → HINGLISH
//     message kunal  → HINGLISH      call mama    → HINGLISH
//
// None of those is Hinglish. The repair is not a list of names — that is the same trap wearing a
// different hat — but the REGISTRIES this system already owns and already trusts for exactly this
// question: config/sites.json knows spotify, the app index knows Notes, Contacts knows Kunal. A
// token any of them recognises is a name, and a name says nothing about which language surrounds it.
// The length rule survives underneath as a last resort for names no registry has heard of.
//
// The dictionary is also asked about simple morphology: /usr/share/dict/words is Webster's Second
// and lists "note" but not "notes", which alone accounted for several of the failures above.
//
// MEASURED, on 17 held-out phrasings of his, none of them exemplars anywhere:
//
//     highest ratio on a Hinglish sentence   0.57
//     lowest  ratio on an English sentence   0.67
//     17/17 correct at any threshold between; 0.60 chosen, clear of both by ~0.07
//
// A rival embedding-region detector scored 15/17 on the same set and cost an embed call, so this is
// both better and free. The numbers are re-measured in test_lang.js rather than remembered.
// ---------------------------------------------------------------------------

const fs = require('fs');

// The registries that settle what is a name. Injected, because this file must not reach into the
// site registry or the address book itself — server.js owns those and warms them.
const deps = { siteKey: null, fuzzyApp: null, isContact: null };
function init(d) { Object.assign(deps, d || {}); }

// Does any registry the system owns recognise this token as a thing rather than a word?
function isKnownName(tok) {
  try { if (deps.siteKey && deps.siteKey(tok)) return true; } catch (e) {}
  try { const m = deps.fuzzyApp && deps.fuzzyApp(tok); if (m && m.score >= 0.9) return true; } catch (e) {}
  try { if (deps.isContact && deps.isContact(tok)) return true; } catch (e) {}
  return false;
}

const DICT_PATHS = ['/usr/share/dict/words', '/usr/dict/words'];
let WORDS = null;

function dict() {
  if (WORDS) return WORDS;
  WORDS = new Set();
  for (const p of DICT_PATHS) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      for (const w of raw.split('\n')) { const t = w.trim().toLowerCase(); if (t) WORDS.add(t); }
      if (WORDS.size) break;
    } catch (e) {}
  }
  return WORDS;
}

// Tokens too long to be a function word are skipped when unknown — see the note on proper nouns.
const PROPER_NOUN_LEN = 7;
// Below this many decidable tokens the ratio is noise. One is enough once the registries remove the
// names: "open spotify" leaves {open} and scores 1.00, "spotify kholo" leaves {kholo} and scores
// 0.00, and both are right. English is the safe default because it is the behaviour that exists.
const MIN_DECIDABLE = 1;
// Swept in test_lang.js. 0.60 sits in the measured gap between 0.57 and 0.67.
const ENGLISH_RATIO = 0.60;

// What fraction of the decidable tokens are English words? Exposed for the test, which prints the
// distribution rather than trusting a remembered number.
function englishRatio(text) {
  const w = dict();
  if (!w.size) return { ratio: 1, decidable: 0 };     // no dictionary on this machine: assume English
  const toks = String(text || '').toLowerCase()
    .replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(t => t.length > 1);
  let known = 0, decidable = 0;
  for (const t of toks) {
    // Webster's Second lists "note" and not "notes"; asking about the obvious inflections costs
    // nothing and removes a whole class of false unknowns.
    const bare = t.replace(/'s$/, '');
    const inDict = w.has(t) || w.has(bare) ||
                   (bare.endsWith('s') && w.has(bare.slice(0, -1))) ||
                   (bare.endsWith('es') && w.has(bare.slice(0, -2))) ||
                   (bare.endsWith('ing') && (w.has(bare.slice(0, -3)) || w.has(bare.slice(0, -3) + 'e'))) ||
                   (bare.endsWith('ed') && (w.has(bare.slice(0, -2)) || w.has(bare.slice(0, -1))));
    if (inDict) { decidable++; known++; continue; }
    if (isKnownName(t)) continue;                          // a registry knows it: a name, stay neutral
    if (t.length > PROPER_NOUN_LEN) continue;              // unknown and long: probably a name too
    decidable++;
  }
  return { ratio: decidable ? known / decidable : 1, decidable };
}

// DEVANAGARI IS NOT A GUESS. If he writes in the script, there is nothing to infer.
const DEVANAGARI = /[ऀ-ॿ]/;

// THE DICTIONARY HALF, and it is deliberately only half.
//
// Measured on 36 held-out phrasings including the short app/person commands that broke the first
// version: 32/36, with every error in the SAFE direction — no English sentence was ever called
// Hinglish. What it cannot see is romanized Hindi that collides with real English words, and there
// is a lot of it:
//
//     safari band karo        ratio 1.00   band and karo are both English words
//     mummy ko message karo   ratio 1.00
//     mere contacts dikhao    ratio 0.67   "mere" is English for "only"
//
// No dictionary can separate those, because there is nothing to separate — the surface forms are
// identical. That is what the semantic half in intent.js is for, and together they measured 36/36.
// This function stays sync and model-free so it can be asked anywhere, including before any model
// is warm.
function isHinglish(text) {
  const s = String(text || '');
  if (DEVANAGARI.test(s)) return true;
  const r = englishRatio(s);
  if (r.decidable < MIN_DECIDABLE) return false;      // too little to tell — English, as today
  return r.ratio < ENGLISH_RATIO;
}

module.exports = { init, isHinglish, englishRatio, isKnownName, ENGLISH_RATIO, MIN_DECIDABLE, PROPER_NOUN_LEN };
