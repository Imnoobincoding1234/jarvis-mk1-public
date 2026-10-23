'use strict';
// ---------------------------------------------------------------------------
// WHAT ERRAND IS THIS REQUEST? — embedders and his own history. No word lists, no generative model.
//
// WHAT THIS REPLACES, TWICE OVER.
//
//   1. ARB_CANDIDATES.vocab / .verbs in server.js — two regexes per candidate, open classes of the
//      nouns and verbs a person might use.
//   2. The first version of THIS file, which replaced them with the local 3B and then quietly grew
//      its own word lists (articles, pronouns, ordinals) under the excuse that they were grammar.
//      He had said no keyword or regex traps at all, and no — they were not exempt. Every one of
//      them is gone, and so is every question put to the 3B.
//
// WHY NOT THE 3B. It was measured, and he was right about it:
//     whole sentence, six labels        60/68 with 6 WRONG KINDS ("buy cat food" -> SHOPPING)
//     action-or-thing, three labels     20/32 — answered NEITHER to all thirteen verbs
//     a two-label cascade for items     "atta" -> MUSIC, "masala dosa" -> VIDEO
//     is this a quick answer or long    missed a sentence the embedder got right
// A small generative model asked to judge picks SOMETHING, and something is not an answer.
//
// ---------------------------------------------------------------------------
// WHAT DOES THE WORK NOW — four readers, none of which knows a single word.
//
//   GATE      the embedder (nomic), over the whole sentence. Is this a request to GET something, to
//             PLAY something, or neither? Regions of meaning, split so no region is a junk drawer.
//
//   LEXICON   inverse document frequency over HIS OWN MESSAGES. A word he types in hundreds of
//             messages is scaffolding; a word he has typed twice is content; a word he has never
//             typed weighs the most of all. Nothing is written down by hand — it is counted from
//             what he has actually said, and it keeps counting.
//
//   SPAN      the rare runs of the sentence are SEEDS, and every span around a seed (within a few
//             tokens, by position) is scored; the one the embedder is MOST confident about is the
//             thing. That is what turns the seed "butter" into "butter chicken" and "cat" into
//             "cat food" without knowing either word.
//
//   KIND      the embedder (all-minilm, which is measured better than nomic on short item strings)
//             against prototype regions — cooked dish, raw ingredient, durable goods, music, video —
//             restricted by the gate's frame: a PLAY request can only name music or video.
//
// MEASURED on 36 held-out errand requests (the sweep_errand set plus the live failures from his log,
// "order me gulab jamoon" among them), coarse kind, margin swept:
//
//     span = every span, best similarity      21 right, 15 WRONG     (filler words won)
//     span = IDF runs                          28 right,  0 wrong, 8 abstain  @0.04
//     span = IDF seeds grown by confidence     34 right,  1 wrong, 1 abstain  @0.03
//     + the gate's frame restricting kinds     35 right,  0 WRONG, 1 abstain  @0.03  <- this
//
// The one abstention is "order a new bedsheet", which is asked — see below.
//
// ---------------------------------------------------------------------------
// WHAT IS NEVER DECIDED BY AN EMBEDDER: COOKED DISH OR RAW INGREDIENT.
//
// Measured again, the same way it failed for three models before: "haldi", "besan", "anjeer" and
// "toor dal" all land next to cooked food. The distinction is not in the word — paneer from a grocer
// is an ingredient and paneer tikka from a restaurant is a meal — so no embedder can read it off one,
// and guessing it is how raw atta gets ordered from a restaurant.
//
// So an edible thing claims BOTH food and grocery, and the tie is broken by, in order:
//     the destination he named          "from swiggy" settles it, as it always has
//     what he answered before           asked once, kept permanently (teach)
//     what he did before                every past order that named a shop taught which kind that
//                                       thing was — read from his own history, not guessed
//     otherwise                         the arbiter reports the tie and ASKS, and the answer is kept
//
// ---------------------------------------------------------------------------
// THE SYNCHRONOUS CONTRACT. arbitrate() is sync with six callers, three inside clauseSplit(). So:
//     a HIT is a dictionary lookup; a MISS returns null — "nobody has asked yet" — which claims
//     nothing; handleChatInner pre-warms every string the splitter can ask about before any sync
//     reader runs (clauseCandidates).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const intent = require('./intent.js');

const deps = { jlog: () => {}, store: null, logDir: path.join(__dirname, 'logs') };

// The errands this system can run — a closed set of THINGS THE MACHINE CAN DO, imported from
// sitekind so a site's kind and a thing's kind cannot come to be spelled differently.
const KINDS = require('./sitekind.js').KINDS;

const CACHE_FILE = 'errand.json';
const LEXICON_FILE = 'lexicon.json';

function init(opts) {
  if (opts && typeof opts.jlog === 'function') deps.jlog = opts.jlog;
  if (opts && opts.store) deps.store = opts.store;
  if (opts && opts.logDir) deps.logDir = opts.logDir;
  load();
  lexicon();
}

// Tokens by SHAPE: runs of letters or digits in any script. Matches no word.
const tokens = s => String(s == null ? '' : s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const norm = s => tokens(s).join(' ');

// ---------------------------------------------------------------------------
// GATE — is this a request to get something, to play something, or neither?
// ---------------------------------------------------------------------------
// Regions of meaning, embedded and compared by cosine. Not a word list: none of these sentences is
// ever matched literally, and a request phrased in words no exemplar contains still lands by meaning.
const EXEMPLARS = {
  'get-something': [
    'order me a pizza', 'buy a keyboard from amazon', 'get me some apples',
    'order two shirts', 'i want a coffee delivered', 'purchase a new lamp',
    'grab me some milk on the way', 'order lunch',
  ],
  'play-something': [
    'play judas by lady gaga', 'put on some music', 'play the latest video from that channel',
    'watch a documentary', 'stream the new album', 'play something chill',
  ],
  'none-question': [
    'what is the weather today', 'who is the ceo of blackrock', 'what is a samosa',
    'how many apps are running', 'what is my battery at', 'what do you know about me',
  ],
  // FETCHING HIS OWN THINGS IS NOT A PURCHASE. "get my calendar" had no home and landed on
  // get-something, and its item then read as a durable good — a calendar, bought from a shop. A
  // missing region, the same bug as a junk drawer. Measured on 24 errands and 6 own-data requests,
  // none of them these exemplars: 0 errands lost and 0 own-data requests claimed, at every margin.
  'none-my-own-data': [
    'show me my emails', 'pull up my notes from yesterday', 'bring up my photos',
    'what is on my schedule', 'check my messages', 'open my downloads folder',
  ],
  // AN ACCOUNT ACTION ON A SITE IS NOT PLAYING OR BUYING ANYTHING. Subscribing, starring, unfollowing
  // named no errand and had no home, so it landed on play-something when it named an artist. Measured
  // on 25 errands and 8 account actions (none of them these exemplars): 0 errands lost at 0.02, and
  // subscribe / unsubscribe / star / unfollow no longer claimed. "follow <artist>" and "like this
  // video" still read as play requests — the object dominates and only the verb differs — and are
  // left to a procedure he taught (see expandElided) rather than patched with a verb list here.
  'none-site-account-action': [
    'subscribe to that channel', 'star this repository', 'like the last post they made',
    'add him as a friend on facebook', 'upvote that answer', 'unsubscribe from the newsletter',
    'save this song to my liked songs',
  ],
  'none-machine': [
    'take a screenshot', 'open safari', 'close spotify', 'empty the trash',
    'create a file called notes.txt', 'find my resume', 'what is running right now',
  ],
  'none-errandless': [
    'message mama on whatsapp', 'remind me to drink water in 3 hours',
    'search cats on youtube', 'research quantum computing', 'schedule a meeting at 6pm',
    'brief me on my day',
  ],
};
const GROUPS = {
  'get-something': 'errand', 'play-something': 'errand',
  'none-question': 'none', 'none-my-own-data': 'none', 'none-site-account-action': 'none',
  'none-machine': 'none', 'none-errandless': 'none',
};
// SWEPT on 74 held-out requests: 0.02 keeps all 46 errands; above it real orders start dropping.
//
// TWO MORE REGIONS WERE TRIED FOR QUESTIONS ABOUT BUYING AND ERRANDS INSIDE REMINDERS, AND REMOVED.
// Written with item words ("is it worth buying a new phone") they stole five real orders, because the
// item dominated the embedding. Written without them ("is it worth buying that") they stole nothing
// and caught nothing — "should i order a laptop" still landed on get-something. That is the brief's
// own measurement showing up again: a question and a command sit 0.002 apart, because MOOD is
// structure and not meaning. Question detection is a separate reader, not a region here.
const GATE_MIN_MARGIN = 0.02;

let _gate = null;
function gateFn() {
  if (!_gate) _gate = intent.makeClassifier({
    exemplars: EXEMPLARS, groups: GROUPS, none: 'none',
    minMargin: GATE_MIN_MARGIN, label: 'Errand', jlog: (...a) => deps.jlog(...a),
  });
  return _gate;
}

// ---------------------------------------------------------------------------
// KIND — what sort of thing a span names. Embedded prototypes, all-minilm.
// ---------------------------------------------------------------------------
// The dish and ingredient halves are itemclass.js's measured prototypes, copied deliberately rather
// than sliced out of its list by index: a slice would silently change meaning the day that list is
// reordered. They are in the version fingerprint, so editing them discards cached verdicts.
const KIND_MODEL = 'all-minilm';
const KIND_REGIONS = {
  dish: ['pizza', 'burger', 'biryani', 'noodles', 'fried rice', 'pasta', 'sandwich', 'momos', 'dosa',
         'thali', 'ice cream', 'brownie', 'pastry', 'shawarma', 'fried chicken', 'soup'],
  ingredient: ['flour', 'rice', 'lentils', 'milk', 'eggs', 'onion', 'potato', 'tomato', 'sugar', 'salt',
               'cooking oil', 'tea leaves', 'wheat', 'spices', 'butter', 'yoghurt'],
  // DURABLE GOODS ARE THREE REGIONS, NOT ONE, and the reason is a junk-drawer centroid caught in the
  // act. As a single region, the average of keyboard, lamp, chair and bottle is "an object", and every
  // vague word fell into it — "something", "stuff", "the thing", "it", "whatever" all came back
  // durable, and did so in BOTH embedders, which is what made two-model agreement useless against
  // them. The same sixteen measured prototypes, regrouped (no new words), on 34 items and 12 vague
  // words at margin 0.03:
  //     one region     33 right, 0 wrong, 1 abstain — 6 vague words claimed as goods
  //     three regions  33 right, 0 wrong, 1 abstain — 4 vague words claimed ("something" now abstains)
  // Still claimed: "stuff", "the thing", "the door", "time". Embedders do not separate those from
  // real items — absolute similarity, his word frequencies and two-model agreement were each measured
  // and each OVERLAPS — so that residue is written down here rather than patched with a list.
  'durable-electronics': ['keyboard', 'laptop', 'headphones', 'charger', 'cable', 'speaker'],
  'durable-wearable': ['shoes', 't-shirt', 'backpack', 'watch', 'umbrella'],
  'durable-home': ['chair', 'lamp', 'mattress', 'bottle', 'toolkit'],
  music: ['a song', 'an album', 'a playlist', 'music by an artist', 'a track', 'a band'],
  video: ['a video', 'a movie trailer', 'an episode', 'a documentary', 'a film', 'a youtube clip'],
};
// Which coarse kind each region belongs to, and what each coarse kind can claim in the arbiter.
// These are the machine's own lanes, not words.
const COARSE = { dish: 'edible', ingredient: 'edible', 'durable-electronics': 'durable', 'durable-wearable': 'durable',
                 'durable-home': 'durable', music: 'music', video: 'video' };
const CLAIMS = { edible: ['food', 'grocery'], durable: ['shop'], music: ['music'], video: ['video'] };
// A get request names goods; a play request names media. The gate's region decides which.
const FRAME_ALLOWS = { 'get-something': ['edible', 'durable'], 'play-something': ['music', 'video'] };
// 35/36 right, 0 wrong, 1 abstain at 0.03; 0.00–0.02 lets "bedsheet" through as edible.
const KIND_MIN_MARGIN = 0.03;

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cos = (a, b) => { const d = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b)); return d ? dot(a, b) / d : 0; };

const _emb = new Map();
async function embedSpan(t) {
  if (_emb.has(t)) return _emb.get(t);
  const v = await intent.embed(t, KIND_MODEL);
  if (v) _emb.set(t, v);
  return v;
}
let _kindCent = null;
async function kindCentroids() {
  if (_kindCent) return _kindCent;
  const out = {};
  for (const [id, ex] of Object.entries(KIND_REGIONS)) {
    const c = await intent.centroidOf(KIND_MODEL, ex);     // cached on disk — see intent.js
    if (!c) return null;
    out[id] = c;
  }
  _kindCent = out;
  return out;
}
// A span's kind, with the margin measured against the best region of a DIFFERENT coarse kind — a
// near-tie between dish and ingredient is not uncertainty about whether it is edible.
async function scoreSpan(span, cent, allowed) {
  const v = await embedSpan(span);
  if (!v) return null;
  const sc = Object.entries(cent).filter(([id]) => !allowed || allowed.includes(COARSE[id]))
    .map(([id, cv]) => ({ id, s: cos(v, cv) })).sort((a, b) => b.s - a.s);
  if (!sc.length) return null;
  const rival = sc.find(x => COARSE[x.id] !== COARSE[sc[0].id]);
  return { span, region: sc[0].id, coarse: COARSE[sc[0].id],
           margin: rival ? sc[0].s - rival.s : (sc[1] ? sc[0].s - sc[1].s : sc[0].s) };
}

// ---------------------------------------------------------------------------
// LEXICON — how often he uses each word, counted from his own messages.
// ---------------------------------------------------------------------------
// ONE MESSAGE COUNTS ONCE, AND ONLY HIS MESSAGES COUNT.
//
// The first version counted every log line carrying the "Chat › " marker. Measured on 2026-09-16:
// of the 12,003 lines it counted, 4,791 were JARVIS's own routing lines ("Chat › routed → action
// (812ms)"), so "routed", "chat" and "action" were the three words he "used most" and every idf was
// taken against a message count eight times too large. The eval suite added the rest: the same
// sixty-odd sentences, sent hundreds of times, made "zephyr", "codeword" and "eiffel" read as
// everyday words. Only 1,500 of those lines were distinct messages he sent.
//
// So a TURN is read the way the handler writes it. handleChatInner logs what he typed as the first
// "Chat › " line of a turn; handleChat closes the turn with "Chat › routed → "; everything between
// is JARVIS narrating its own work — clause re-entries too, which would count his words twice. Those
// markers are JARVIS's own output format, not his vocabulary. And a message sent again is the same
// document: frequency is counted over DISTINCT messages, remembered by fingerprint so a live repeat
// is not counted as new.
const LEX_FORMAT = 2;
const TURN_MARK = 'Chat › ';
const TURN_END = 'Chat › routed → ';
// The same log call names a turn "Vision" or "Briefing" when it carries an image or is a briefing.
const TURN_OTHER = ['] Vision › ', '] Briefing › '];
const RESTART_MARK = 'JARVIS OS core online';
// The log keeps the first 90 characters of a message, so the fingerprint is taken over the same 90
// whether the message comes from the log or from a live turn.
const LOGGED_CHARS = 90;
const fingerprint = text => {
  const k = norm(String(text == null ? '' : text).slice(0, LOGGED_CHARS));
  return k ? crypto.createHash('sha1').update(k).digest('hex').slice(0, 12) : '';
};
let _lex = null;                 // { n, df: { word: messagesContainingIt }, seen: Set<fingerprint> }
let _lexDirty = false;
function lexicon() {
  if (_lex) return _lex;
  _lex = { n: 0, df: Object.create(null), seen: new Set() };
  try {
    const saved = deps.store && deps.store.read(LEXICON_FILE, null);
    if (saved && saved.format === LEX_FORMAT && saved.n && saved.df) {
      _lex.n = saved.n; Object.assign(_lex.df, saved.df);
      for (const k of (saved.seen || [])) _lex.seen.add(k);
      return _lex;
    }
  } catch (e) {}
  // FIRST RUN, or a lexicon counted the old way: count what he has already said.
  //
  // The closing "routed → " line only exists from 2026-08-15. Before it, JARVIS wrote nothing else
  // under "Chat › " (checked: not one of the 2,333 earlier lines is its own), so until a file shows
  // its first turn end, every line there is a message of his.
  try {
    for (const f of fs.readdirSync(deps.logDir)) {
      if (f.indexOf('jarvisos.log') !== 0) continue;
      let inTurn = false, structured = false;
      for (const line of fs.readFileSync(path.join(deps.logDir, f), 'utf8').split('\n')) {
        if (line.includes(TURN_END)) { structured = true; inTurn = false; continue; }
        if (line.includes(RESTART_MARK)) { inTurn = false; continue; }
        if (TURN_OTHER.some(m => line.includes(m))) { inTurn = true; continue; }
        const i = line.indexOf(TURN_MARK);
        if (i < 0 || (structured && inTurn)) continue;
        inTurn = true;
        countMessage(line.slice(i + TURN_MARK.length));
      }
    }
    _lexDirty = true;
    saveLexicon();
    deps.jlog('Errand › counted ' + _lex.n + ' distinct messages of his to learn which words carry meaning');
  } catch (e) {}
  return _lex;
}
function countMessage(text) {
  const key = fingerprint(text);
  if (!key || _lex.seen.has(key)) return;
  const words = new Set(tokens(text));
  if (!words.size) return;
  _lex.seen.add(key);
  _lex.n++;
  for (const w of words) _lex.df[w] = (_lex.df[w] || 0) + 1;
  _lexDirty = true;
}
function saveLexicon() {
  if (!_lexDirty || !deps.store) return;
  try {
    deps.store.write(LEXICON_FILE, { format: LEX_FORMAT, n: _lex.n, df: _lex.df, seen: [..._lex.seen], at: Date.now() });
    _lexDirty = false;
  } catch (e) {}
}
// Called once per turn with what he actually typed — never with a rewrite built from it, and never
// with an eval sentence, which is the test suite talking rather than him.
function observe(text) { lexicon(); countMessage(text); saveLexicon(); }
// The raw counts, for readers that judge a word by the share of his messages it appears in.
const wordDf = w => lexicon().df[String(w || '').toLowerCase()] || 0;
const messageCount = () => lexicon().n;
const idf = w => { const L = lexicon(); return Math.log((L.n + 1) / ((L.df[w] || 0) + 1)); };

// SEEDS: contiguous runs of tokens he uses less often than the sentence's own average. Relative to
// the sentence, so there is no global constant; if every token weighs the same, the whole sentence
// is one seed and the growth step below decides.
function seedsOf(text) {
  const t = tokens(text);
  if (!t.length) return [];
  const w = t.map(idf);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const runs = [];
  let st = -1;
  for (let i = 0; i <= t.length; i++) {
    if (i < t.length && w[i] > mean + 1e-9) { if (st < 0) st = i; }
    else if (st >= 0) { runs.push([st, i]); st = -1; }
  }
  if (!runs.length) runs.push([0, t.length]);
  return runs.map(([a, b]) => ({ a, b, t }));
}

// SEARCH THE WINDOW AROUND A SEED. Every span that contains the seed, reaching up to WINDOW tokens
// past either edge, is scored and the most confident wins. Position and the embedder; no vocabulary.
//
// This replaced greedy growth, on measurement. Greedy extended a seed one token at a time and kept a
// step only if confidence rose — and so it stalled on a worse intermediate span. "yessmartypie" ->
// "yessmartypie s" got LESS confident, so the search stopped short of "latest video" and the clause
// read as nothing at all. On 41 held-out requests, five of them possessives:
//     greedy growth    40 right, 1 WRONG at 0.02 ("get me some rasgulla" -> [some] durable)
//     window search    40 right, 0 wrong at 0.02 through 0.05, 1 abstain
const WINDOW = 3;
async function searchWindow(seed, cent, allowed) {
  const { t } = seed;
  let best = null;
  const tried = new Set();
  for (let a = Math.max(0, seed.a - WINDOW); a <= seed.a; a++) {
    for (let b = seed.b; b <= Math.min(t.length, seed.b + WINDOW); b++) {
      const key = a + ':' + b;
      if (tried.has(key) || b - a < 1) continue;
      tried.add(key);
      const c = await scoreSpan(t.slice(a, b).join(' '), cent, allowed);
      if (c && (!best || c.margin > best.margin)) best = c;
    }
  }
  // Inside the seed as well — a long rare run can hold a shorter, clearer thing.
  for (let a = seed.a; a < seed.b; a++) for (let b = a + 1; b <= seed.b; b++) {
    const key = a + ':' + b;
    if (tried.has(key)) continue;
    tried.add(key);
    const c = await scoreSpan(t.slice(a, b).join(' '), cent, allowed);
    if (c && (!best || c.margin > best.margin)) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------
// CACHE — verdicts keyed by sentence, his answers keyed by thing.
// ---------------------------------------------------------------------------
// Anything that can change an answer is fingerprinted, so editing a region discards the verdicts it
// produced. His answers (taught) and what his own past orders showed (learned) survive: a verdict
// is a guess to be redone, and those are not guesses.
let _version = null;
function version() {
  if (_version) return _version;
  _version = crypto.createHash('sha256').update(JSON.stringify(
    [EXEMPLARS, GROUPS, GATE_MIN_MARGIN, KIND_MODEL, KIND_REGIONS, KIND_MIN_MARGIN, WINDOW, LEX_FORMAT])).digest('hex').slice(0, 12);
  return _version;
}
let cache = null;
let dirty = false;
function fresh() {
  return { v: version(), gate: Object.create(null), margin: Object.create(null), found: Object.create(null),
           bare: Object.create(null), taught: Object.create(null), learned: Object.create(null) };
}
function load() {
  if (cache) return cache;
  cache = fresh();
  try {
    const saved = deps.store && deps.store.read(CACHE_FILE, null);
    if (saved) {
      Object.assign(cache.taught, saved.taught || {});
      Object.assign(cache.learned, saved.learned || {});
      if (saved.v === cache.v) {
        Object.assign(cache.gate, saved.gate || {});
        Object.assign(cache.margin, saved.margin || {});
        Object.assign(cache.found, saved.found || {});
        Object.assign(cache.bare, saved.bare || {});
      } else if (saved.v) {
        deps.jlog('Errand › the readers changed since these verdicts were written — redoing them ' +
                  '(his ' + Object.keys(cache.taught).length + ' answers kept)');
      }
    }
  } catch (e) {}
  return cache;
}
function save() {
  if (!dirty || !deps.store) return;
  try { deps.store.write(CACHE_FILE, Object.assign({ at: Date.now() }, load())); dirty = false; } catch (e) {}
}

// A remembered answer about a thing, found by IDENTITY rather than exact spelling — "gulab jamun"
// and "gulab jamoon" are the same dessert. Same edit-distance score agent.js uses to tell Instapaper
// from TaskPaper.
function editDistance(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const flat = s => tokens(s).join('');
function sameThing(x, y) {
  const a = flat(x), b = flat(y);
  if (!a || !b) return false;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length) >= 0.80;
}
function remembered(map, thing) {
  const key = norm(thing);
  if (map[key] !== undefined) return map[key];
  for (const k of Object.keys(map)) if (sameThing(k, key)) return map[k];
  return undefined;
}

// ---------------------------------------------------------------------------
// RESOLVE — the async half, awaited by the pre-warm and never by the parser.
// ---------------------------------------------------------------------------
async function resolve(text) {
  const t0 = Date.now();
  try { return await resolveInner(text); }
  finally { const ms = Date.now() - t0; if (ms > 50) intent.noteTiming('Errand', ms); }
}
async function resolveInner(text) {
  const key = norm(text);
  if (!key || key.length > 300) return null;
  const c = load();
  try {
    if (c.gate[key] === undefined) {
      const r = await gateFn()(key);
      // null from the classifier is BOTH "embedder down" and "not an errand"; the embedder being
      // reachable is what tells them apart, and an unreachable one must not be cached as a no.
      if (!r) {
        const probe = await intent.embed('x');
        if (!probe) return null;
        c.gate[key] = 0;
      } else {
        c.gate[key] = r.group === 'errand' ? r.id : 0;
        if (r.group === 'errand') c.margin[key] = r.margin;
      }
      dirty = true;
    }
    if (!c.gate[key]) { save(); return new Set(); }
    if (c.found[key] === undefined) {
      const cent = await kindCentroids();
      if (!cent) return null;
      const allowed = FRAME_ALLOWS[c.gate[key]] || null;
      const found = [];
      for (const seed of seedsOf(key)) {
        const s = await searchWindow(seed, cent, allowed);
        if (!s || s.margin < KIND_MIN_MARGIN) continue;
        // The THING is named by its seed — the rare words he actually typed — so the same item keys
        // the same way however the sentence around it grows.
        const name = seed.t.slice(seed.a, seed.b).join(' ');
        if (!found.some(f => f.coarse === s.coarse && sameThing(f.name, name))) found.push({ name, span: s.span, coarse: s.coarse });
      }
      c.found[key] = found;
      dirty = true;
      deps.jlog('Errand › "' + key.slice(0, 40) + '" names ' +
        (found.length ? found.map(f => '"' + f.span + '" (' + f.coarse + ')').join(' + ') : 'nothing I can place'));
    }
    save();
    return kindsOfSync(key) || new Set();
  } catch (e) { return null; }
}
function learn(text) { resolve(text).catch(() => {}); }
async function warm(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(norm).filter(Boolean);
  let n = 0;
  for (const t of [...new Set(list)]) if (kindsOfSync(t) === null) { await resolve(t); n++; }
  return n;
}

// ---------------------------------------------------------------------------
// THE SYNCHRONOUS READERS — the ones arbitrate() uses.
// ---------------------------------------------------------------------------
// true | false | null (nobody has asked yet).
function isErrandSync(text) {
  const g = load().gate[norm(text)];
  return g === undefined ? null : !!g;
}
// Errand kinds this request can claim. Empty set: asked, nothing to claim. null: not asked yet.
function kindsOfSync(text) {
  const key = norm(text);
  const c = load();
  if (c.gate[key] === undefined) return null;
  if (!c.gate[key]) return new Set();
  const found = c.found[key];
  if (found === undefined) return null;
  const out = new Set();
  for (const f of found) {
    if (f.coarse !== 'edible') { for (const k of CLAIMS[f.coarse]) out.add(k); continue; }
    // COOKED OR RAW is never the embedder's call. His answer first, then what his own past orders
    // showed, and otherwise both — which the arbiter reports as a tie and asks about.
    const fine = remembered(c.taught, f.name) !== undefined ? remembered(c.taught, f.name) : remembered(c.learned, f.name);
    if (fine) out.add(fine);
    else for (const k of CLAIMS.edible) out.add(k);
  }
  return out;
}
function thingsOfSync(text) {
  const f = load().found[norm(text)];
  return Array.isArray(f) ? f.map(x => x.name) : [];
}
// THE CONVERSATIONAL REFERENT — "order that", after he named a margherita pizza. A bare thing has no
// sentence around it to gate or frame, so every kind is open to it; it is read by the same seeds,
// growth and regions as a request is, and it claims exactly what a request naming it would.
async function resolveThing(thing) {
  const key = norm(thing);
  if (!key || key.length > 120) return null;
  const c = load();
  if (c.bare[key] !== undefined) return c.bare[key];
  const cent = await kindCentroids();
  if (!cent) return null;
  let best = null;
  for (const seed of seedsOf(key)) {
    const sc = await searchWindow(seed, cent, null);
    if (sc && (!best || sc.margin > best.margin)) best = sc;
  }
  c.bare[key] = best && best.margin >= KIND_MIN_MARGIN ? best.coarse : '';
  dirty = true; save();
  return c.bare[key];
}
// Kinds a bare thing can claim, as a Set, or null if nobody has read it. His answer and his own
// history outrank the embedder, and cooked-or-raw is never the embedder's call — same rule as above.
function kindsOfThingSync(thing) {
  const c = load();
  const t = remembered(c.taught, thing);
  if (t !== undefined) return new Set(t ? [t] : []);
  const coarse = c.bare[norm(thing)];
  if (coarse === undefined) return null;
  if (!coarse) return new Set();
  if (coarse === 'edible') {
    const l = remembered(c.learned, thing);
    return new Set(l ? [l] : CLAIMS.edible);
  }
  return new Set(CLAIMS[coarse]);
}
function seen(text) { return Object.prototype.hasOwnProperty.call(load().gate, norm(text)); }
// How clearly the gate read this as a request — the splitter compares two readings of one clause
// with it. 0 for anything the gate did not call an errand, null if nobody has asked.
function errandMarginSync(text) {
  const c = load(), key = norm(text);
  if (c.gate[key] === undefined) return null;
  return c.gate[key] ? (c.margin[key] || 0) : 0;
}

// ---------------------------------------------------------------------------
// WHAT HE TOLD US, AND WHAT HE DID.
// ---------------------------------------------------------------------------
// His answer outranks everything, permanently, and outlives any change to the readers.
function teach(thing, kind) {
  const key = norm(thing);
  if (!key) return false;
  if (kind !== '' && !KINDS.includes(kind)) return false;
  load().taught[key] = kind; dirty = true; save();
  deps.jlog('Errand › learned from him: "' + key.slice(0, 30) + '" is ' + (kind || 'none of my errands'));
  return true;
}
// A request that named a shop AND an edible thing shows which kind that thing is — the destination
// decided it, and it will decide it the same way next time he leaves the shop out. Only edible
// things, because only cooked-or-raw needs remembering; the embedder already knows a keyboard.
function noteDestinationVerdict(text, kind) {
  if (kind !== 'food' && kind !== 'grocery') return 0;
  const c = load();
  const found = c.found[norm(text)] || [];
  let n = 0;
  for (const f of found) {
    if (f.coarse !== 'edible') continue;
    if (remembered(c.taught, f.name) !== undefined) continue;
    if (c.learned[f.name] !== kind) { c.learned[f.name] = kind; n++; }
  }
  if (n) { dirty = true; save(); }
  return n;
}

// ---------------------------------------------------------------------------
// WHICH OF THE TWO OFFERED ERRANDS DID HE PICK? — embedder only.
// ---------------------------------------------------------------------------
// Scored against ONLY the two kinds he was offered. Descriptions, not shop names: the registry owns
// which shop is which. A reply that is not clearly one of the two returns null and the question is
// retired, so an unrelated next request routes normally instead of being swallowed as an answer.
const REPLY_EXEMPLARS = {
  food: ['food delivery', 'order it from a restaurant', 'get it cooked and delivered',
         'a takeaway', 'restaurant food', 'have it made and brought over'],
  grocery: ['a grocery run', 'from the grocery shop', 'raw ingredients',
            'groceries delivered', 'the supermarket', 'household supplies'],
  shop: ['online shopping', 'buy it as a product', 'from an online store',
         'order the item itself', 'a marketplace order'],
  music: ['play it as music', 'listen to it', 'a song', 'put it on'],
  video: ['watch it', 'a video', 'play the clip', 'something to watch'],
};
let _reply = null;
function replyFn() {
  if (!_reply) _reply = intent.makeClassifier({
    exemplars: Object.assign({}, REPLY_EXEMPLARS, {
      // A reply that is not an answer at all needs somewhere to land, or it lands on a kind.
      'none-new-request': ['what is my battery', 'open youtube', 'take a screenshot', 'message mama',
                           'what time is it', 'thanks'],
    }),
    groups: { 'none-new-request': 'none' }, none: 'none', minMargin: 0.02,
    label: 'ErrandReply', jlog: (...a) => deps.jlog(...a),
  });
  return _reply;
}
// WHICH OF TWO CHOICES DID HE PICK, when the choices are not both errand kinds — the playbook
// disagreement question offers a kind against a procedure. Each choice brings its own exemplars (a
// kind's reply exemplars, a procedure's own region), so nothing here names a word. Built per
// question and cached by the pair, because the same two choices come up again.
const _choice = new Map();
async function answerChoice(reply, choices) {
  const r = String(reply || '').trim();
  if (!r || !Array.isArray(choices) || choices.length !== 2) return null;
  const key = choices.map(c => c.id).join('|');
  if (!_choice.has(key)) {
    const ex = {};
    for (const c of choices) ex[c.id] = (c.exemplars || []).filter(Boolean);
    if (ex[choices[0].id].length < 2 || ex[choices[1].id].length < 2) return null;
    ex['none-new-request'] = ['what is my battery', 'open youtube', 'take a screenshot', 'message mama',
                              'what time is it', 'thanks'];
    _choice.set(key, intent.makeClassifier({ exemplars: ex, groups: { 'none-new-request': 'none' },
      none: 'none', minMargin: 0.02, label: 'Choice', jlog: (...a) => deps.jlog(...a) }));
  }
  try {
    const v = await _choice.get(key)(r);
    const hit = v && choices.find(c => c.id === v.id);
    return hit || null;
  } catch (e) { return null; }
}

async function answerKind(reply, offered) {
  const two = Array.isArray(offered) ? offered.filter(k => REPLY_EXEMPLARS[k]) : [];
  if (!String(reply || '').trim() || two.length !== 2) return null;
  try {
    const v = await replyFn()(String(reply));
    if (v && two.includes(v.id)) return v.id;
  } catch (e) {}
  return null;
}

module.exports = {
  init, observe, wordDf, messageCount, resolve, learn, warm, teach, noteDestinationVerdict, answerKind, answerChoice, REPLY_EXEMPLARS,
  isErrandSync, errandMarginSync, kindsOfSync, thingsOfSync, kindsOfThingSync, resolveThing, seen, norm,
  KINDS, EXEMPLARS, GROUPS, GATE_MIN_MARGIN, KIND_REGIONS, KIND_MIN_MARGIN,
  _cacheFile: CACHE_FILE, _seedsOf: seedsOf,
};
