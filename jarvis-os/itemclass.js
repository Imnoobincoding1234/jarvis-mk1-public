// ============================================================================
// WHAT KIND OF THING IS THIS? — asked of an embedding model, not a word list.
// ============================================================================
//
// THE PROBLEM THIS REPLACES. Routing an order used to depend on whether the item appeared in a
// hand-written regex. There were THREE copies of the food list — FOOD_CATEGORY_RE in server.js, a
// copy in playbook.js whose comment promised to keep it "in step", and a third, shorter one inside
// ARB_CANDIDATES — and they disagreed. Measured before this existed:
//
//   "order me some samosas"                  -> the arbiter scored nothing; samosa is in two of the
//                                               three lists and not the one that decides
//   "order me a gulab jamun and a charger"   -> `shop`. A sweet, routed to Amazon.
//   "order apples and bananas from instamart"-> nothing at all; produce is in no list
//
// The comment above FOOD_CATEGORY_RE says it plainly: "SAMOSA WAS NOT ON THIS LIST, on a machine in
// Punjab." A list fails on the first word nobody thought of, and there is no end to that work.
//
// WHAT THIS DOES INSTEAD. Embed the item, compare it to a handful of exemplar prototypes per class,
// take the nearest. An unseen word — anjeer, rasmalai, besan — gets a position in the same space as
// the exemplars, so it is classified rather than missed. The exemplars are prototypes, not a
// membership list: sixteen of them stand in for thousands of items, which is the difference between
// this and the regex it replaces.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not try to separate a restaurant order from a grocery
// order. That was measured on three models — all-minilm, granite-embedding:30m and
// snowflake-arctic-embed:33m — and all three failed on the same boundary, confidently: haldi, jeera,
// toor dal and atta all land next to cooked Indian food, because that is the context those words
// appear in. Two category schemes were tried, including one shaped around which provider stocks
// what; the provider-shaped one scored 78.7%, worse than the semantic one.
//
// It is not a model gap. Paneer from Instamart is a grocery and paneer tikka from Swiggy is a meal;
// the same word is both, so the distinction is not in the word and no larger model can read it off
// one. Restaurant-vs-grocery comes from the PROVIDER when the sentence names one, and from asking
// him when it does not. This answers only the question embeddings actually answer well.
//
// MEASURED, on 47 items chosen to include everything the old lists got wrong:
//   2-class, exemplar prototypes           94.9%
//   held out, 28 unseen items              92.9%
//   held out, abstaining below MIN_MARGIN  100% on 79% of items
// Both held-out errors fell below the margin and were abstained on, which is the property that
// matters: this is allowed to say "I cannot tell", and saying so turns into a question rather than a
// wrong order placed with his money.
//
// 25 MB resident, ~6ms per item. The model is all-minilm, which is already installed and already
// used by recall.js — this adds no new dependency and no new download.

const ollama = require('./ollama.js');
const crypto = require('crypto');
const store = require('./store');

let deps = { jlog: () => {}, stateDir: null };
function init(d) {
  deps = Object.assign(deps, d || {});
  try { store.init({ jlog: deps.jlog, stateDir: deps.stateDir }); } catch (e) {}
}

// THE ONE PLACE THAT KEPT all-minilm, AND IT IS MEASURED, NOT LEFT BEHIND.
//
// On 2026-09-12 every classifier in this system moved to nomic-embed-text, which is better at
// sentences by a wide margin — 74/81 held-out routing goals with no wrong actions, against 68/81
// with seven. This classifier does not read sentences. It reads ITEMS: one or two bare words, no
// verb, no context. Swept on 22 real items — the suite's eight, plus fourteen held out:
//
//                         correct  wrong  "bedsheet" abstains
//     all-minilm @ 0.02     21       0      yes
//     nomic      @ 0.005    19       2      no
//     nomic      @ 0.016    13       2      no
//
// There is no threshold at which nomic passes. Under it the grocery items crowd into a 0.008–0.017
// band while the marketplace ones spread to 0.16, so `atta` lands on marketplace and `bedsheet` —
// the item this file uses to prove it can say "I cannot tell" — answers confidently at 0.066.
// Short-string similarity is what all-minilm was trained for and nomic was not; being better at
// paragraphs does not make a model better at the word "anjeer".
//
// The cost of the exception is one extra 45 MB model, loaded only on ordering flows. That is the
// cheaper mistake. Do NOT "finish the migration" by pointing this at the env var without re-running
// the sweep above.
const MODEL = 'all-minilm';
const CACHE_FILE = 'itemclass.json';
// Chosen on 39 items and then re-validated on 28 unseen ones, where it still gave 100% accuracy on
// what it accepted. It is a floor on CONFIDENCE, not on correctness: below it the two classes are
// close enough that the answer is a coin flip, and a coin flip is what asking exists to avoid.
//
// UNCHANGED THROUGH THE 2026-09-12 EMBEDDER MIGRATION, because the model above is unchanged. It was
// briefly moved to 0.016 on a leave-one-out sweep of the PROTOTYPES, and the suite caught it within
// a minute: the prototypes are canonical single words and real items are not, so a threshold fitted
// to 'pizza' and 'keyboard' abstained on 'gulab jamun', 'rasmalai' and 'soap'. Re-swept on 22 real
// items, 0.02 remains the value that gets 21 of them right with nothing wrong.
const MIN_MARGIN = 0.02;

// Prototypes, not members. Each list stands in for a whole region of the space; adding a word here
// is only worthwhile when a whole KIND of thing is missing, never to patch one item — patching one
// item is what the regex did.
const PROTOTYPES = {
  // Everything a grocery or quick-commerce run brings back: cooked food, raw ingredients, and the
  // household consumables that sit on the same shelves. Soap and shampoo are not edible and belong
  // here anyway, because the question is which errand this is, not what it is made of.
  grocery: ['pizza', 'burger', 'biryani', 'noodles', 'fried rice', 'pasta', 'sandwich', 'momos',
            'dosa', 'thali', 'ice cream', 'brownie', 'pastry', 'shawarma', 'fried chicken', 'soup',
            'flour', 'rice', 'lentils', 'milk', 'eggs', 'onion', 'potato', 'tomato', 'sugar', 'salt',
            'cooking oil', 'tea leaves', 'wheat', 'spices', 'butter', 'yoghurt'],
  // Durable goods — the marketplace errand.
  marketplace: ['keyboard', 'laptop', 'headphones', 'charger', 'shoes', 't-shirt', 'chair', 'lamp',
                'backpack', 'watch', 'cable', 'speaker', 'mattress', 'umbrella', 'bottle', 'toolkit'],
};

// Changing a prototype changes every centroid, so the cache is keyed by their fingerprint: edit the
// lists and yesterday's verdicts are discarded rather than silently kept. Cheaper than remembering
// to clear it by hand, and it cannot be forgotten.
const PROTO_HASH = crypto.createHash('sha256')
  .update(JSON.stringify(PROTOTYPES) + '|' + MODEL).digest('hex').slice(0, 12);

let centroids = null;          // in-memory, rebuilt once per process
let cache = null;              // { hash, items: { <item>: {k, m} } }

function loadCache() {
  if (cache) return cache;
  const c = store.read(CACHE_FILE, null);
  cache = (c && c.hash === PROTO_HASH && c.items) ? c : { hash: PROTO_HASH, items: {} };
  return cache;
}
function saveCache() {
  try { store.write(CACHE_FILE, cache); } catch (e) {}
}

// THIS COPY HAD ALREADY DRIFTED. It sent no `options` at all, so it embedded at the model's default
// context while intent.js pinned num_ctx to 512 — the exact difference measured as 2.9 GB resident
// against 1.0 GB. Nobody chose that; it is what two copies of one transport do. ollama.js owns the
// endpoint, the pin, and starting the daemon if it is not running.
//
// Still a vector or null, so the classifier below is unchanged. The timeout stays short for the same
// reason as before: this sits in front of an order, and a hang looks like a crash where an
// abstention asks him a question.
async function embed(text) {
  const r = await ollama.embed(text, { model: MODEL, keepAlive: '60s', numCtx: 512 });
  return r && r.v ? r.v : null;
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cos = (a, b) => {
  const d = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return d ? dot(a, b) / d : 0;
};

async function buildCentroids() {
  if (centroids) return centroids;
  const out = {};
  for (const [k, words] of Object.entries(PROTOTYPES)) {
    const vs = [];
    for (const w of words) {
      const v = await embed(w);
      if (v) vs.push(v);
    }
    // A centroid built from a handful of prototypes is not the centroid this was measured with.
    // Refuse rather than classify against a partial one — the whole point of this module is that it
    // knows when not to answer.
    if (vs.length < words.length * 0.8) return null;
    out[k] = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
  }
  centroids = out;
  return centroids;
}

// Returns { kind: 'grocery'|'marketplace', margin } or null when it cannot tell — which includes
// ollama being down, the model being absent, and the two classes being too close to separate.
// EVERY caller must treat null as "ask him", never as a default.
async function classify(item) {
  const key = String(item || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!key || key.length > 60) return null;
  const c = loadCache();
  if (c.items[key]) {
    const hit = c.items[key];
    return hit.k ? { kind: hit.k, margin: hit.m, cached: true } : null;
  }
  const cent = await buildCentroids();
  if (!cent) return null;
  const v = await embed(key);
  if (!v) return null;
  const scored = Object.entries(cent).map(([k, cv]) => ({ k, s: cos(v, cv) }))
    .sort((a, b) => b.s - a.s);
  const margin = scored[0].s - scored[1].s;
  const ok = margin >= MIN_MARGIN;
  // Abstentions are cached too. The answer will not change on a retry — same model, same
  // prototypes — and re-embedding a word already known to be unclassifiable buys nothing.
  c.items[key] = ok ? { k: scored[0].k, m: Number(margin.toFixed(4)) } : { k: null, m: Number(margin.toFixed(4)) };
  saveCache();
  if (!ok) {
    deps.jlog('ItemClass › "' + key.slice(0, 30) + '" is between classes (margin ' +
              margin.toFixed(3) + ') — saying so rather than guessing');
    return null;
  }
  deps.jlog('ItemClass › "' + key.slice(0, 30) + '" → ' + scored[0].k + ' (margin ' + margin.toFixed(3) + ')');
  return { kind: scored[0].k, margin };
}

// HIS ANSWER OUTRANKS THE MODEL, PERMANENTLY. When the classifier abstains and he is asked, the
// reply is worth more than a fresh embedding ever will be, so it is written into the same cache the
// classifier reads. The next order for that item costs nothing and asks nothing.
function teach(item, kind) {
  const key = String(item || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!key || !['grocery', 'marketplace'].includes(kind)) return false;
  const c = loadCache();
  c.items[key] = { k: kind, m: 1, taught: true };
  saveCache();
  deps.jlog('ItemClass › learned from him: "' + key.slice(0, 30) + '" is ' + kind);
  return true;
}

module.exports = { init, classify, teach, MIN_MARGIN, PROTOTYPES, PROTO_HASH, _cacheFile: CACHE_FILE };
