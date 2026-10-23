'use strict';
// ---------------------------------------------------------------------------
// WHAT KIND OF REQUEST IS THIS? — the shared machinery, in one place.
//
// WHY THIS FILE EXISTS. Three parts of this system now answer a question of the form "which of
// these N kinds is this text?" — itemclass.js (grocery vs marketplace), playbook.js (which
// procedure), and agent.js (which deterministic plan shape). The first was written standalone; the
// second was about to copy it; the third would have been the third copy. Two copies of the same
// classifier is the same failure shape as two copies of the same word list — they drift, and the
// bug is that they disagree. So the embedding, the cosine, the centroids and the abstention live
// here once, and each caller supplies only its own exemplars and its own threshold.
//
// EXEMPLARS ARE NOT A WORD LIST. Nothing here is ever matched literally. Each list stands in for a
// REGION of meaning; the text is embedded and compared to the centroid of each region. That is why
// "blast judas" lands next to the music region without appearing in any list, and it is the whole
// reason this replaced the keyword tables it replaced.
//
// IT ABSTAINS. Below the caller's margin the two nearest regions are close enough that the answer
// is a coin flip, and every caller here would rather ask, fall through, or do nothing than act on
// one. Returning null is a result, not a failure.
//
// NO DEPENDENCIES. Pure stdlib against the embedder ollama is already running.
// ---------------------------------------------------------------------------

const ollama = require('./ollama.js');
const lang = require('./lang.js');

// THE MAIN EMBEDDER. Was all-minilm until 2026-09-12; nomic-embed-text replaced it on measurement.
//
// all-minilm is 22M parameters, 384 dimensions and a 256-token window, and it was the weakest link
// in every classifier here. Measured on 81 held-out routing goals — 47 used to choose the
// threshold, 34 written earlier and never tuned against — with each model's own margin swept,
// because a threshold does not transfer between embedding spaces:
//
//     all-minilm        68/81 correct, 7 WRONG        384 dims,  9.6ms,  28 MB resident
//     granite-278m      72/81 correct, 1 wrong        768 dims, 18.3ms, 562 MB
//     embeddinggemma    ~70/81,        1 wrong        768 dims, 22.4ms, 626 MB
//     mxbai-embed-large ~69/81,        0 wrong       1024 dims, 45.4ms, 624 MB
//     bge-m3            ~69/81,        0 wrong       1024 dims, 45.1ms, 624 MB
//     nomic-embed-text  74/81 correct, 0 WRONG        768 dims, 18.2ms, 249 MB   <- this one
//
// NOTHING IS SUPERIOR IN EVERY WAY. all-minilm is still the fastest and the smallest, and this
// costs 2x per embed and 9x resident. What it buys is the seven wrong actions going to zero, and a
// wrong action costs him more than 9ms does.
//
// IT IS USED RAW, WITH NO TASK PREFIX, AND THAT IS DELIBERATE. nomic's card offers
// `classification:` / `clustering:` / `search_query:` prefixes. All four were measured and all four
// were WORSE here, for a reason worth writing down: the same prefix on both sides adds a shared
// component to every vector, so every cosine rises together and the median winning similarity goes
// 0.698 -> 0.815 -> 0.832. The ranking barely moves; the SPREAD collapses, the usable threshold
// falls to 0.005, and abstention stops separating anything — wrong decisions went 0 -> 1 -> 2.
// That is the same margin-compression the ALT model below is quarantined for. Do not add a prefix.
const MODEL = process.env.JARVIS_EMBED_MODEL || 'nomic-embed-text';
// THE MULTILINGUAL ONE, USED ONLY FOR THE SENTENCES IT IS BETTER AT.
//
// all-minilm is an English model and on his romanized Hinglish it does not just lose accuracy, it
// LEAKS — measured, three of his own private questions routed to the web:
//
//     mere bhai ka naam kya hai   → web        mujhe kal kya karna hai → web
//     mere contacts dikhao        → web
//
// granite-embedding:278m gets all three right and sends nothing local to the web at all: 14/16
// against 11/16, highest-wrong margin 0.000 against 0.040. It is also 2.5x slower, 6.5x more
// resident, and compresses every margin — so it is NOT a global replacement. Each sentence goes to
// the model that is good at it, and the two spaces are never compared: a Hinglish sentence is scored
// against centroids granite built, an English one against centroids all-minilm built, from the same
// exemplars.
const ALT_MODEL = process.env.JARVIS_EMBED_MODEL_ALT || 'granite-embedding:278m';

// THE TRANSPORT MOVED, THE CONTRACT DID NOT. This was its own copy of the POST to
// /api/embeddings — and the copies in itemclass.js and recall.js had already drifted away from it,
// one of them dropping the num_ctx pin that keeps the KV allocation at 1.0 GB instead of 2.9 GB.
// ollama.js owns the endpoint, the pin and the restart-if-down; this still returns a vector or
// null, so every caller below is untouched.
const _modelsUsed = new Set([MODEL]);
// EVERY EMBEDDER THE GATES WILL ASK, ASKED FIRST. Called at the start of a turn, before the reader and the
// 3B: the sentence is embedded once by each model a classifier was built with (and by the Hinglish model
// when the sentence is Hinglish and some gate reads Hinglish with it), in the classifiers' own form of
// the text, so every gate after it reads from ollama.js's cache and no embedder is loaded after the 3B —
// with one model in memory at a time, that load would evict the 3B between the resolver and the reply.
const _gateModels = new Set();
let _altInUse = false;
async function prewarmText(text) {
  const key = String(text == null ? '' : text).toLowerCase().trim().replace(/\s+/g, ' ');
  if (!key) return 0;
  const models = [..._gateModels];
  try { if (_altInUse && await isHinglish(key)) models.push(ALT_MODEL); } catch (e) {}
  let n = 0;
  for (const m of models) { if (await embed(key, m)) n++; }
  return n;
}

// AT BOOT, NOT MID-TURN. Every classifier here is built lazily, and the first one to use a model pays
// validateModel's probe embed — a model load — whatever the centroid cache holds. After a restart that
// landed between the 3B's resolver call and its reply ("Calendar centroids 567ms", all-minilm), and
// with one model in memory at a time it evicted the 3B, which then loaded twice in that turn
// (measured 2026-09-23; warm turns load it once). Warming here validates each model and registers it
// with prewarmText, so the first turn after a restart embeds up front like every other turn.
async function warmModels(models) {
  let n = 0;
  for (const m of models || []) {
    _gateModels.add(m);
    try { if (await validateModel(m)) n++; } catch (e) {}
  }
  return n;
}

async function embed(text, model) {
  const m = model || MODEL;
  _modelsUsed.add(m);
  const r = await ollama.embed(text, { model: m, keepAlive: '60s', numCtx: 512 });
  return r && r.v ? r.v : null;
}

// ---------------------------------------------------------------------------
// WHERE A TURN'S TIME GOES. Every classifier call and centroid build reports its duration here, and
// the chat handler collects them into one line per turn. Added because a fifteen-second "open
// youtube" logged nothing at all between the request and the action: every stage that could have
// been slow was silent.
// ---------------------------------------------------------------------------
let _timingSink = null;
function setTimingSink(fn) { _timingSink = typeof fn === 'function' ? fn : null; }
function noteTiming(label, ms, detail) {
  if (_timingSink) { try { _timingSink(label, ms, detail); } catch (e) {} }
}

// ---------------------------------------------------------------------------
// CENTROIDS ARE COMPUTED ONCE, EVER, AND KEPT ON DISK.
//
// Measured on a cold process: 5.9 SECONDS of classifier work before quickAction — which answers
// "open youtube" in 20ms — could even run. agent's shape classifier 2.1s, playbook 1.8s, research
// 0.9s, self-fact 0.5s: nearly all of it building centroids, one embed per exemplar, on first use.
// Every restart paid it again. A centroid is a deterministic function of the model and the phrases,
// so it is cached under exactly that key, and a restart reads it back instead of re-embedding.
//
// A MODEL UPDATE MUST NOT LEAVE STALE VECTORS BEHIND. The cache stores the embedding of one fixed
// probe per model; the first time a model is used in a process, the probe is re-embedded and
// compared, and any drift discards that model's centroids. One embed per model per process.
// ---------------------------------------------------------------------------
const fsx = require('fs');
const pathx = require('path');
const cryptox = require('crypto');
const CENTROID_FILE = process.env.JARVIS_CENTROID_CACHE || pathx.join(__dirname, 'state', 'centroids.json');
const PROBE = 'the quick brown fox checks whether this model has changed';
let _cc = null;                 // { models: { model: { probe: [..], regions: { key: [..] } } } }
let _ccDirty = false, _ccTimer = null;
const _validated = new Map();   // model -> Promise<boolean>
function centroidCache() {
  if (_cc) return _cc;
  try { _cc = JSON.parse(fsx.readFileSync(CENTROID_FILE, 'utf8')); } catch (e) { _cc = null; }
  if (!_cc || typeof _cc.models !== 'object') _cc = { models: {} };
  return _cc;
}
function flushCentroids() {
  if (!_ccDirty) return;
  _ccDirty = false;
  try {
    fsx.mkdirSync(pathx.dirname(CENTROID_FILE), { recursive: true });
    const tmp = CENTROID_FILE + '.tmp';
    fsx.writeFileSync(tmp, JSON.stringify(centroidCache()));
    fsx.renameSync(tmp, CENTROID_FILE);
  } catch (e) {}
}
function saveCentroidsSoon() {
  _ccDirty = true;
  if (_ccTimer) return;
  _ccTimer = setTimeout(() => { _ccTimer = null; flushCentroids(); }, 500);
  if (_ccTimer.unref) _ccTimer.unref();
}
// A process that exits inside the debounce window would otherwise lose the last centroids it built
// — measured: a short run built self-fact's regions and exited 500ms too early to keep them.
process.on('exit', flushCentroids);
const round = v => v.map(x => Math.round(x * 1e6) / 1e6);
async function validateModel(model) {
  if (_validated.has(model)) return _validated.get(model);
  const p = (async () => {
    const v = await embed(PROBE, model);
    if (!v) return false;                          // embedder down: validate again next time
    const cc = centroidCache();
    const m = cc.models[model];
    if (m && Array.isArray(m.probe) && m.probe.length === v.length && cos(m.probe, v) > 0.9999) return true;
    cc.models[model] = { probe: round(v), regions: {} };
    saveCentroidsSoon();
    return true;
  })();
  _validated.set(model, p);
  const ok = await p;
  if (!ok) _validated.delete(model);
  return ok;
}
const regionKey = phrases => cryptox.createHash('sha256').update(JSON.stringify(phrases)).digest('hex').slice(0, 20);
// The centroid of a list of phrases under one model, or null if the embedder is unavailable.
async function centroidOf(model, phrases) {
  const list = (phrases || []).map(String);
  if (!list.length) return null;
  if (!(await validateModel(model))) return null;
  const cc = centroidCache();
  const key = regionKey(list);
  const hit = cc.models[model] && cc.models[model].regions[key];
  if (hit) return hit;
  const vecs = [];
  for (const p of list) { const v = await embed(p, model); if (v) vecs.push(v); }
  if (!vecs.length) return null;
  const c = new Array(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  for (let i = 0; i < c.length; i++) c[i] /= vecs.length;
  // A partial build is not the centroid anything was measured against; do not keep it.
  if (vecs.length < list.length) return c;
  cc.models[model].regions[key] = round(c);
  saveCentroidsSoon();
  return cc.models[model].regions[key];
}

// LOAD THE EMBEDDERS BEFORE HE FINISHES SPEAKING. Called when the wake word is heard and when he
// starts typing, so the ~0.5s-per-model reload lands in the gap before the request, not inside it.
const _preloading = new Map();
// With no argument, every embedder this process has actually used — so a classifier pinned to a
// second model is warmed too, and nothing here has to name one.
function preload(models) {
  for (const m of (models && models.length ? models : [..._modelsUsed])) {
    if (_preloading.has(m)) continue;
    const s = Date.now();
    const p = embed('warm', m).then(() => noteTiming('preload ' + m, Date.now() - s)).catch(() => {})
      .finally(() => setTimeout(() => _preloading.delete(m), 20000).unref && null);
    _preloading.set(m, p);
  }
}

// WHICH LANGUAGE IS THIS? — two signals, neither of them a list of Hindi.
//
//   the dictionary (lang.js)  how much of the sentence is English, by membership of the 236k-word
//                             dictionary macOS ships, with names removed by the site/app/contact
//                             registries. Blind to Hindi that collides with English words.
//   these regions             whole sentences, embedded and compared, exactly like every other
//                             classifier here. Catches "safari band karo", which the dictionary
//                             reads as three English words.
//
// Measured together on 36 held-out phrasings, including the short app-and-person commands that broke
// an earlier version: dictionary 32/36, regions 35/36, the two OR'd 36/36. The margin floor of 0.10
// is what excludes the regions' only two false positives, which sat at 0.011 and 0.070 while every
// true Hinglish case scored 0.186 or better.
const LANG_EXEMPLARS = {
  english: [
    'open spotify and play judas', 'what is the weather today', 'who is the CEO of BlackRock',
    'message mama on whatsapp', 'what is my battery at', 'find my resume', 'show me my calendar',
    'take a screenshot', 'how many apps are running', 'play something by drake',
    'thanks that worked', 'what do you know about me',
  ],
  hinglish: [
    'spotify kholo', 'mera naam kya hai', 'kal koi meeting hai kya', 'safari band karo',
    'battery kitni hai', 'mujhe ek note banao', 'yeh file delete kar do', 'mummy ko message karo',
    'screenshot le lo', 'abhi kitne baje hain', 'meri photos kholo', 'aaj calendar mein kuch hai kya',
  ],
};
// RE-SWEPT for nomic-embed-text (was 0.10 under all-minilm). Leave-one-out over these same
// exemplars: all-minilm 18/24 with wrong margins reaching 0.060, nomic 22/24 with wrong margins
// reaching 0.051 and correct ones starting at 0.028. 0.06 clears both wrongs and keeps 20 of 22.
const LANG_MIN_MARGIN = 0.06;
let _langCent = null, _langBuilding = null;
async function langCentroids() {
  if (_langCent) return _langCent;
  if (_langBuilding) return _langBuilding;
  _langBuilding = (async () => {
    const out = {};
    for (const [id, phrases] of Object.entries(LANG_EXEMPLARS)) {
      const c = await centroidOf(MODEL, phrases);
      if (!c) { _langBuilding = null; return null; }
      out[id] = c;
    }
    _langCent = out;
    return out;
  })();
  return _langBuilding;
}
const _langSeen = new Map();
async function isHinglish(text) {
  const key = String(text == null ? '' : text).toLowerCase().trim().replace(/\s+/g, ' ');
  if (!key) return false;
  if (_langSeen.has(key)) return _langSeen.get(key);
  let out = false;
  try {
    if (lang.isHinglish(key)) out = true;
    else {
      // Detection always uses the ENGLISH model: it is already warm, and telling two languages apart
      // is a far easier question than understanding either of them.
      const cent = await langCentroids();
      const v = cent && await embed(key, MODEL);
      if (v) {
        const sc = Object.entries(cent).map(([id, cv]) => ({ id, s: cos(v, cv) })).sort((a, b) => b.s - a.s);
        out = sc[0].id === 'hinglish' && (sc[0].s - sc[1].s) >= LANG_MIN_MARGIN;
      }
    }
  } catch (e) { out = false; }
  _langSeen.set(key, out);
  return out;
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cos = (a, b) => {
  const d = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return d ? dot(a, b) / d : 0;
};

// makeClassifier({ exemplars, minMargin, none, groups, jlog, label })
//
//   exemplars  { id: [phrases…] }   one entry per region. The id `none` (or whatever `none` names)
//                                   is the "not one of these" region and is never returned.
//   minMargin  number               how much daylight the winner needs over the runner-up.
//   groups     { id: groupName }    OPTIONAL. Regions that mean the same thing to the CALLER.
//
// Returns an async function: text -> { id, group, sim, margin } | null
//
// WHY `groups` EXISTS. A caller that only wants a yes/no answer often needs several regions to get
// there, because one broad region averages into a centroid that means nothing in particular — that
// is measured, not theoretical: a single "needs the web" region covering people, prices, release
// dates and news lost "what is the newest samsung phone called" to a five-exemplar region about
// device state, on the strength of the word "phone". Splitting it into tight regions fixed that and
// immediately caused the opposite failure:
//
//     "who won the world cup in 2022"   won `fact`  over `topic`  by 0.000
//     "any update on the mars rover"    won `topic` over `product` by 0.001
//
// Both are lookups. Both were silenced by a margin measured against ANOTHER lookup region, which is
// a margin about nothing — the choice between two answers that lead to the same place cannot make
// the decision less certain. With `groups`, the runner-up is the best region OUTSIDE the winner's
// group, so the margin measures the thing the caller actually cares about.
//
// Omit it and every region is its own group, which is exactly the behaviour that existed before.
//
// Centroids are built once, lazily, and kept in memory — the server is long-lived and rebuilding
// them per request would put ~15 embedding calls on the critical path of every turn.
function makeClassifier(opts) {
  const o = opts || {};
  const exemplars = o.exemplars || {};
  const minMargin = typeof o.minMargin === 'number' ? o.minMargin : 0.05;
  // Supplying this is what turns multilingual routing on for this classifier — see classify().
  const altMargin = typeof o.minMarginAlt === 'number' ? o.minMarginAlt : null;
  const noneId = o.none || 'none';
  // WHICH MODEL THIS PARTICULAR CLASSIFIER READS WITH. Defaults to the system embedder; a caller
  // that has MEASURED a different one to be better for its own question pins it here.
  //
  // This exists because "better model" turned out not to be a property of a model. nomic-embed-text
  // replaced all-minilm on 2026-09-12 and is decisively better at reading a REQUEST — 74/81 held-out
  // routing goals with no wrong actions, against 68/81 with seven. It is worse, measured, at three
  // narrower jobs: single-word items (itemclass), and the two guards that read JARVIS'S OWN REPLY
  // back to check it is not lying or leaking. Those three stay on all-minilm and say why at the call
  // site. Pinning is an assertion that a sweep was run, not a preference.
  const ownModel = o.model || MODEL;
  _gateModels.add(ownModel);
  if (typeof o.minMarginAlt === 'number') _altInUse = true;
  const groups = o.groups || null;
  const groupOf = (id) => (groups && groups[id]) || id;
  const label = o.label || 'Intent';
  const jlog = typeof o.jlog === 'function' ? o.jlog : () => {};

  // ONE SET OF CENTROIDS PER MODEL, BUILT FROM THE SAME EXEMPLARS.
  //
  // Two embedding models are two different spaces and a cosine between them is meaningless — so
  // nothing here ever compares across them. A Hinglish sentence is embedded by granite and scored
  // against centroids granite built; an English one by all-minilm against all-minilm's. The
  // exemplars are identical; only the model that reads them differs.
  const centroids = Object.create(null);
  const building = Object.create(null);
  const cache = new Map();

  async function centroidsFor(model) {
    if (centroids[model]) return centroids[model];
    if (building[model]) return building[model];
    building[model] = (async () => {
      const s = Date.now();
      const out = {};
      for (const [id, phrases] of Object.entries(exemplars)) {
        const c = await centroidOf(model, phrases);
        // Embedder unavailable: abstain rather than answer from a half-built space, and do not cache
        // the failure — the next call should try again once ollama is back.
        if (!c) { building[model] = null; return null; }
        out[id] = c;
      }
      centroids[model] = out;
      const ms = Date.now() - s;
      if (ms > 50) noteTiming(label + ' centroids', ms);
      return out;
    })();
    return building[model];
  }

  async function classify(text) {
    const s = Date.now();
    try { return await classifyInner(text); }
    finally { const ms = Date.now() - s; if (ms > 50) noteTiming(label, ms); }
  }
  return classify;

  async function classifyInner(text) {
    const key = String(text == null ? '' : text).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    // MULTILINGUAL IS OPT-IN, and deliberately so. Every threshold in this system was swept against
    // all-minilm, and granite compresses the margins — measured, calintent's correct cases clear by
    // 0.004 under granite against 0.054 under all-minilm. A caller that has not swept a second
    // threshold must not be handed a second model, or its gate stops working. So a caller opts in by
    // supplying minMarginAlt, and everything else keeps the single model it was tuned for.
    let model = ownModel, margin0 = minMargin;
    if (altMargin != null) {
      try {
        if (await isHinglish(key)) { model = ALT_MODEL; margin0 = altMargin; }
      } catch (e) {}
    }
    const cent = await centroidsFor(model);
    if (!cent) return null;                       // not cached: transient
    const v = await embed(key, model);
    if (!v) return null;
    const scored = Object.entries(cent).map(([id, cv]) => ({ id, s: cos(v, cv) })).sort((a, b) => b.s - a.s);
    const winGroup = groupOf(scored[0].id);
    // The runner-up is the best region OUTSIDE the winner's group.
    //
    // BACKWARD COMPATIBILITY IS BY CONSTRUCTION, NOT BY PROMISE. With no `groups` configured,
    // groupOf(id) === id, region ids are unique, so "the first entry whose group differs from the
    // winner's" is the first entry whose id differs from scored[0].id — which is scored[1]. The
    // formula below is then scored[0].s - scored[1].s, character for character the one it replaced.
    // Every existing caller (playbook, shapeOf, replyclaim, itemclass) and every threshold swept
    // against it is therefore untouched.
    const rival = scored.find(x => groupOf(x.id) !== winGroup);
    // No rival means every region belongs to the winner's group, so there is nothing to be uncertain
    // between and the margin is as wide as it can be. This cannot arise without `groups`, where each
    // region is its own group and any second region is a rival.
    const margin = rival ? scored[0].s - rival.s : 1;
    let res = null;
    // "NOT ONE OF THESE" IS A GROUP, NOT A REGION — for the same reason the rival is.
    //
    // A caller whose null answer is a junk drawer has the same problem a caller's real regions have:
    // chat, arithmetic, bare app opens and "act on this row of the page" average into a centroid
    // that stands for nothing, and a sentence belonging to no procedure loses to whichever real
    // region shares a turn of phrase with it. The fix is to split `none` into coherent regions too
    // — which only works if every one of them still ANSWERS none.
    //
    // BACKWARD COMPATIBLE BY CONSTRUCTION, not by promise. With no `groups`, groupOf(id) === id, so
    // this is character for character the test it replaced. With groups configured but a `noneId`
    // no group carries (`__unused__`, as calintent, replyhedge and actionintent all pass), nothing
    // equals it either way and those callers are untouched.
    if (winGroup !== noneId && margin >= margin0) {
      res = { id: scored[0].id, group: winGroup, sim: scored[0].s, margin };
    } else {
      jlog(label + ' › "' + key.slice(0, 40) + '" → ' +
        (winGroup === noneId ? 'none of these'
                                 : 'between ' + scored[0].id + ' and ' + (rival ? rival.id : '(nothing)') +
                                   ' (margin ' + margin.toFixed(3) + ') — not guessing'));
    }
    cache.set(key, res);
    return res;
  }
}

module.exports = { embed, prewarmText, warmModels, cos, makeClassifier, isHinglish, centroidOf, preload, setTimingSink, noteTiming,
  MODEL, ALT_MODEL, LANG_EXEMPLARS, LANG_MIN_MARGIN, _centroidFile: CENTROID_FILE };
