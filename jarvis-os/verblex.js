'use strict';
// ---------------------------------------------------------------------------
// WHAT HE HAS TOLD JARVIS HIS WORDS MEAN — his answers, and nothing else.
//
// WHAT WAS HERE. A seed table of verb phrases (open / close / create / delete, plus rows for status,
// screenshots, the trash, running apps and the display) and a 3B learner for phrases outside it. The
// seed was a word table, and it misread by construction: "spin up" was an open because it had been
// written under open_app, so "spin up a folder called experiments" — a create — could never agree with
// it. What a verb means depends on what it is done TO, and a table keyed by the verb alone cannot see
// the object. He named it for what it was on 2026-09-17: a keyword trap. The seed is gone, and so is
// the 3B learner, which nothing in the live path had called since the reader model arrived.
//
// WHAT READS POLARITY NOW. The reader model (readmodel.js) reads the whole sentence, verb and object
// together, trained on his own messages, and its own probabilities say how sure it is that it chose
// open rather than close, create rather than delete. When it is not sure enough, readmodel asks him.
//
// WHAT IS KEPT HERE is his answer, keyed by HIS words for the request (readmodel.requestWords) and by
// PAIR — the same words can mean one thing to an app and another to a file. An answer is his data, not
// a list anyone wrote: nothing is known until he has said it.
// ---------------------------------------------------------------------------

// The two antonym pairs the reader acts on. These name ACTIONS THE MACHINE CAN TAKE — machine-owned —
// never the words for them.
const PAIR_OF = { open_app: 'app', close_app: 'app', create: 'file', delete: 'file' };
const KINDS = Object.keys(PAIR_OF);
const CACHE_FILE = 'verblex.json';
// Format 2 holds his answers only. Format 1 (a seed plus model-learned phrases) is discarded on load:
// nothing in it came from him.
const FORMAT = 2;

const deps = { jlog: () => {}, store: null };
function init(opts) {
  for (const k of Object.keys(opts || {})) if (opts[k] !== undefined) deps[k] = opts[k];
  cache = null;
}

const norm = v => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');

let cache = null;
function load() {
  if (cache) return cache;
  cache = Object.create(null);
  try {
    const saved = deps.store && deps.store.read(CACHE_FILE, null);
    if (saved && saved.format === FORMAT && saved.taught) {
      for (const [phrase, byPair] of Object.entries(saved.taught)) {
        const row = Object.create(null);
        for (const [pair, kind] of Object.entries(byPair || {})) {
          if (PAIR_OF[kind] === pair) row[pair] = kind;
        }
        if (Object.keys(row).length) cache[norm(phrase)] = row;
      }
    }
  } catch (e) {}
  return cache;
}
function save() {
  if (!deps.store) return;
  try {
    const taught = {};
    for (const [phrase, row] of Object.entries(load())) taught[phrase] = Object.assign({}, row);
    deps.store.write(CACHE_FILE, { format: FORMAT, taught, at: Date.now() });
  } catch (e) {}
}

// What he said these words mean, in this pair ('app' or 'file'), or null if he has not said.
function kindOfSync(phrase, pair) {
  const row = load()[norm(phrase)];
  if (!row) return null;
  if (pair) return row[pair] || null;
  const kinds = Object.values(row);
  return kinds.length === 1 ? kinds[0] : null;
}
// Has he answered for these words in this pair?
function seen(phrase, pair) {
  const row = load()[norm(phrase)];
  return !!(row && (pair ? row[pair] : Object.keys(row).length));
}

// HIS ANSWER, kept. Only a kind of one of the two pairs is accepted; a later answer for the same words
// and pair replaces the earlier one, because he is the authority on what he meant.
function teach(phrase, kind) {
  const v = norm(phrase);
  const pair = PAIR_OF[kind];
  if (!v || !pair) return false;
  const c = load();
  const row = c[v] || (c[v] = Object.create(null));
  row[pair] = kind;
  save();
  deps.jlog('Verb › learned from him: "' + v + '" → ' + kind);
  return true;
}

module.exports = { init, kindOfSync, seen, teach, norm, KINDS, PAIR_OF, FORMAT, _cacheFile: CACHE_FILE };
