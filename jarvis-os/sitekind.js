'use strict';
// ---------------------------------------------------------------------------
// WHAT ERRAND DOES A WEBSITE SERVE? — asked once, written down, never listed.
//
// WHAT THIS REPLACES. ARB_CANDIDATES' `dest` field: five hand-written alternations naming the
// forty-odd sites the arbiter was allowed to recognise.
//
//     dest: /\b(?:swiggy(?!\s*instamart)|zomato|uber\s?eats|dominos?|pizza\s?hut|kfc|…)\b/i
//
// Two failures, and the second is the worse one.
//
// It MISSES. The registry (config/sites.json) knows 77 sites; that regex knew 14 of them, and the
// other 63 scored nothing. "order from bigbasket" was not a grocery run to the arbiter because
// nobody had typed the word into this file. There is no end to that work — it is the same trap as
// the food lists, one field along.
//
// And it does not know what a site IS. "swiggy" was a string that happened to appear in a pattern.
// swiggy.com was not the same thing as swiggy, https://www.swiggy.com/search?query=x was not either,
// and neither was "order it off swiggy dot com". The registry has known the URL for every one of
// these sites the whole time and nothing asked it.
//
// WHAT THIS DOES INSTEAD. Two halves, and keeping them apart is the point:
//
//   RESOLUTION — which site is this? Answered by the registry the system already owns, now indexed
//     by HOST as well as by key and alias, so swiggy, swiggy.com, www.swiggy.com and a pasted URL
//     are one site. A host the registry has never heard of resolves to itself, which is what makes
//     this work for every website rather than for a list of them.
//
//   KIND — what is that site for? Asked of the local 3B, once per site, and written down. Nothing
//     here maps a name to a kind. An unseen site is LEARNED, which is the whole difference between
//     a cache and a table.
//
// MEASURED, on all 77 registry sites, hand-labelled (the labels are in the test, not in here):
//
//     six labels, one flat question            75/77    585ms per site
//     the same, then a binary confirm pass     58/77    — the confirm answers NO to everything
//     three labels, then three or two          63/77    — "ordering/streaming/neither" means
//                                                         nothing to it without the glosses
//
// The flat question wins because each label carries a one-line gloss, which is what the model is
// actually reading. The cascade that worked for verbs does not work here, and the confirm pass that
// looked obviously good made it seventeen worse — both measured rather than assumed.
//
// The two it gets wrong: zeptonow.com, which it does not know (so a Zepto order scores no
// destination and falls to the item classifier — today's behaviour for all 63 unlisted sites), and
// zoom.us, which it calls video. He can overrule either, permanently, with teach().
//
// A MISS IS NOT A FAILURE. kindOfSync returns null for a site nobody has asked about yet, the
// arbiter scores no destination, and the request routes exactly as it does today. In the background
// the site is asked about once. The second time it is instant and right. The parser stays
// SYNCHRONOUS, which is what let this replace a regex that six sync callers depend on.
// ---------------------------------------------------------------------------

const http = require('http');

// The errands this system actually routes. A closed set of LANES THE MACHINE HAS — the same kind of
// closed category verblex's KINDS is — and never a set of site names. '' means "serves none of
// these", which is the answer for most of the web and the half that matters: a false `shop` on a
// train-booking site sends a ticket to a shopping cart.
const KINDS = ['food', 'grocery', 'shop', 'music', 'video'];

const deps = {
  jlog: () => {},
  store: null,
  llmModel: 'qwen2.5:3b-instruct-q4_K_M',
  numCtx: 8192,
  sites: () => ({ data: {}, index: {} }),   // the registry, injected by server.js
};

let cache = null;              // { <identity>: kind }  — '' is a real answer, undefined is "unasked"
let dirty = false;
const asking = new Set();

const CACHE_FILE = 'sitekind.json';

function init(opts) {
  if (opts && typeof opts.jlog === 'function') deps.jlog = opts.jlog;
  if (opts && opts.store) deps.store = opts.store;
  if (opts && opts.llmModel) deps.llmModel = opts.llmModel;
  if (opts && Number(opts.numCtx)) deps.numCtx = Number(opts.numCtx);
  if (opts && opts.keepAlive) deps.keepAlive = opts.keepAlive;
  if (opts && typeof opts.sites === 'function') deps.sites = opts.sites;
  // A RE-INIT RE-READS. The cache is module-level, and load() returns early once it is populated —
  // so handing init a different store did nothing, and a test that pointed this at a scratch store
  // kept answering out of his real one. Everything learned is written on the spot by save(), so
  // dropping the in-memory copy loses nothing.
  cache = null;
  load();
}

function load() {
  if (cache) return cache;
  cache = Object.create(null);
  // NO SEED. verblex ships one and is right to — a verb's meaning is a fact about English that does
  // not change, so pre-warming it costs nothing and risks nothing. A site's purpose is a fact about
  // a company, and a table of them in here is the exact thing this file deletes. On a cold machine
  // the first mention of a site behaves as an unknown site behaves today; warmAll() fills the cache
  // from the model at idle, and by the second sentence it is all there.
  try {
    const saved = deps.store && deps.store.read(CACHE_FILE, null);
    if (saved && saved.sites) for (const [s, k] of Object.entries(saved.sites)) cache[s] = k;
  } catch (e) {}
  return cache;
}

function save() {
  if (!dirty || !deps.store) return;
  try { deps.store.write(CACHE_FILE, { sites: cache, at: Date.now() }); dirty = false; } catch (e) {}
}

// ---------------------------------------------------------------------------
// RESOLUTION. Which site is being named.
// ---------------------------------------------------------------------------

// A site's IDENTITY is its host and path with the scheme and the "www." stripped — the shape the
// registry stores and the shape the model answers best about. The path is part of who a site is:
// swiggy.com/instamart is the grocery service and swiggy.com is the restaurant one, and collapsing
// them is a measured error (my first probe did exactly that and mislabelled Instamart as food).
function identity(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Is this token a hostname? Answered by SHAPE, not by a list of domains: labels joined by dots, a
// final label of two-to-24 letters, and at least one dot. That admits "node.js" and "e.g" — and it
// is supposed to, because the only thing being claimed here is "this looks like it could name a
// site". What it IS gets decided downstream by the registry and the model, and a token that is
// neither resolves to nothing and contributes no evidence. Guessing wide and verifying is the
// opposite of a keyword list, which guesses narrow and never verifies.
const HOSTISH = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.[a-z]{2,24}$/i;

// THE REGISTRY, ASKED PROPERLY. server.js's siteKey() indexes keys and aliases; hostFor() closes
// the loop the other way, so a URL or a bare host finds the site it belongs to.
// Rebuilt only when the registry object itself changes. sites() re-reads config/sites.json on an
// mtime change and returns a NEW object when it does, so identity comparison is the whole
// invalidation rule — a site added to the registry is picked up without a restart, and an unchanged
// registry costs one comparison rather than a rebuilt index per hostname-shaped token.
let _hostIdx = { from: null, idx: null };
function hostIndex() {
  const reg = deps.sites() || {};
  if (_hostIdx.from === reg && _hostIdx.idx) return _hostIdx.idx;
  const data = reg.data || {};
  const out = Object.create(null);
  for (const [k, v] of Object.entries(data)) {
    if (!v || !v.url) continue;
    const id = identity(v.url);
    if (!id) continue;
    out[id] = k;
    // The bare host too, so "amazon.in" finds amazon even though the registry stores a path-free
    // URL, and so "swiggy.com" finds swiggy rather than swiggy/instamart.
    const bare = id.replace(/\/.*$/, '');
    if (!out[bare]) out[bare] = k;
  }
  _hostIdx = { from: reg, idx: out };
  return out;
}

// The identity of a named site: a registry key, an alias, a host, or a URL. Returns the string the
// KIND is cached under. A host the registry does not know returns ITSELF — which is the line that
// makes this apply to every website rather than to 77 of them.
function identityOf(token, siteKeyFn) {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return null;
  // A registry key or alias — "swiggy", "yt", "you tube".
  try {
    const k = siteKeyFn && siteKeyFn(raw);
    if (k) {
      const e = (deps.sites().data || {})[k];
      return e && e.url ? identity(e.url) : k;
    }
  } catch (e) {}
  // A URL or a bare host — "swiggy.com", "https://www.swiggy.com/search?query=x".
  const id = identity(raw);
  const bare = id.replace(/\/.*$/, '');
  if (!HOSTISH.test(bare)) return null;
  const idx = hostIndex();
  if (idx[id]) { const e = (deps.sites().data || {})[idx[id]]; return e && e.url ? identity(e.url) : id; }
  if (idx[bare]) { const e = (deps.sites().data || {})[idx[bare]]; return e && e.url ? identity(e.url) : bare; }
  return id;                                  // a site nobody has registered. It is still a site.
}

// EVERY site named in a sentence, with the kind of each. The arbiter needs all of them, not the
// first: "order apples from instamart and cake from swiggy" names two, and reading only one is how
// half a request used to get dropped.
//
// Tokens are taken as written and as joined pairs, because a registry alias can be two words ("you
// tube", "uber eats"). Punctuation is trimmed off the ends only — a dot in the MIDDLE is what makes
// a hostname a hostname.
function sitesIn(text, siteKeyFn) {
  let s = String(text || '');
  const out = [];
  const seenIdPre = new Set();
  // A PASTED URL IS ONE TOKEN, AND THE SPLITTER BELOW WOULD CUT IT INTO FOUR. Measured:
  // "https://www.swiggy.com/search?query=pizza" split on its own colon and question mark into
  // "https", "//www.swiggy.com/search" and "query=pizza", none of which is a site. So whole URLs are
  // lifted out first and taken entire, then removed so the remaining words are split normally.
  s = s.replace(/\bhttps?:\/\/\S+/gi, (u) => {
    const id = identityOf(u, siteKeyFn);
    if (id && !seenIdPre.has(id)) { seenIdPre.add(id); out.push({ token: u, id, kind: kindOfSync(id) }); }
    return ' ';
  });
  const words = s.split(/[\s,;:!?"'()\[\]]+/).map(w => w.replace(/^[.\-/]+|[.\-/]+$/g, '')).filter(Boolean);
  // One resolution per distinct token. The adjacency rule below looks at each word twice (as `here`
  // and again as the next word's predecessor) and add() resolves it a third time, so without this a
  // twelve-clause sentence pays for the same lookups three times over. Measured before: 391µs on a
  // long sentence, and clauseSplit asks per clause.
  const memo = new Map();
  const resolve = tok => {
    if (memo.has(tok)) return memo.get(tok);
    let r = null;
    try { r = identityOf(tok, siteKeyFn); } catch (e) { r = null; }
    memo.set(tok, r);
    return r;
  };
  const seenId = seenIdPre;
  const add = tok => {
    const id = resolve(tok);
    if (!id || seenId.has(id)) return false;
    seenId.add(id);
    out.push({ token: tok, id, kind: kindOfSync(id) });
    return true;
  };
  for (let i = 0; i < words.length; i++) {
    // Longest first, so "uber eats" is one site and not "uber" plus a word.
    if (i + 1 < words.length && add(words[i] + ' ' + words[i + 1])) { i++; continue; }
    // A SUB-SERVICE SWALLOWS ITS PARENT WHEN THE TWO ARE WRITTEN TOGETHER.
    //
    // "swiggy instamart" is ONE site — the grocery one — and reading it as two claimed both food
    // and grocery, which is a tie, which asks him which he meant between two readings of one name.
    // The old regex bought this with a lookahead, `swiggy(?!\s*instamart)`, hand-written for the one
    // pair somebody hit. This comes from the URLs instead: swiggy.com is a proper prefix of
    // swiggy.com/instamart, so the longer identity is the more specific service and wins.
    //
    // Scoped to ADJACENT words on purpose. "order apples from instamart and cake from swiggy" names
    // the same two sites in the same prefix relation and genuinely means both — two errands, two
    // carts — so the rule must not reach across the sentence.
    const here = resolve(words[i]);
    const nextTok = i + 1 < words.length ? resolve(words[i + 1]) : null;
    if (here && nextTok && nextTok !== here && nextTok.startsWith(here + '/')) { add(words[i + 1]); i++; continue; }
    add(words[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// KIND. What that site is for.
// ---------------------------------------------------------------------------

// The synchronous lookup — the one the arbiter uses. A kind, '' for "serves none of our errands",
// or null for "nobody has asked yet".
function kindOfSync(idOrToken, siteKeyFn) {
  const c = load();
  const direct = c[String(idOrToken || '').toLowerCase()];
  if (direct !== undefined) return direct;
  if (!siteKeyFn) return null;
  const id = identityOf(idOrToken, siteKeyFn);
  if (!id) return null;
  const k = c[id];
  return k === undefined ? null : k;
}

function seen(id) {
  return Object.prototype.hasOwnProperty.call(load(), String(id || '').toLowerCase());
}

// ONE FLAT QUESTION, SIX LABELS, EACH WITH A GLOSS.
//
// The gloss is what the model reads. Measured: the same six labels as bare words scored worse than
// this, and a three-label cascade in the shape that works for verbs scored 63/77 — "is it ORDERING
// or STREAMING or NEITHER" is an abstraction the model has no grip on, where "ordering cooked meals
// delivered from restaurants" is a description of a business it has read about a thousand times.
//
// OTHER's gloss is deliberately a RULE and not a list of categories. An earlier version enumerated
// them — "search, email, social media, news, banking, payments, ride booking…" — which fixed the
// five sites in front of me and would have failed on the sixth. That is the trap this file exists to
// remove, and writing it into a prompt does not make it not one.
const PROMPT = site =>
  'What is the website ' + site + ' mainly used for?\n' +
  'Reply with exactly one word from this list:\n' +
  'RESTAURANT - ordering cooked meals delivered from restaurants\n' +
  'GROCERIES - ordering groceries, fresh produce and household supplies delivered\n' +
  'SHOPPING - buying physical products from an online store\n' +
  'MUSIC - listening to songs and albums\n' +
  'VIDEO - watching films, TV shows or video clips\n' +
  'OTHER - anything whose main purpose is none of the five above\n' +
  '\nWebsite: ' + site + '\nAnswer:';

const ANSWER_TO_KIND = {
  RESTAURANT: 'food', GROCERIES: 'grocery', SHOPPING: 'shop', MUSIC: 'music', VIDEO: 'video', OTHER: '',
};

function askModel(site) {
  // What may share memory is decided first (ollama.makeRoomFor — a heavy model alone).
  return require('./ollama.js').makeRoomFor(deps.llmModel).then(() => new Promise(resolve => {
    const body = Buffer.from(JSON.stringify({
      model: deps.llmModel, prompt: PROMPT(site), stream: false, keep_alive: deps.keepAlive,
      // temperature 0 because this is a DECISION, not a sample — the same reason verblex pins it.
      options: { temperature: 0, num_ctx: deps.numCtx, num_predict: 6, use_mmap: true },   // mmap: see ollama.js USE_MMAP
    }));
    const req = http.request({
      host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try {
          const w = String(JSON.parse(b).response || '').toUpperCase().replace(/[^A-Z]/g, '');
          if (!w) return resolve(null);
          const hit = Object.keys(ANSWER_TO_KIND).find(k => w.startsWith(k));
          // AN ANSWER OUTSIDE THE LIST IS "OTHER", NOT A FAILURE. makemytrip.com came back "TRAVEL"
          // — the model naming a category we do not route, which is precisely what OTHER means.
          // Treating it as unparseable left the site unasked and re-asked forever.
          resolve(hit ? ANSWER_TO_KIND[hit] : '');
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  }));
}

// LEARN IN THE BACKGROUND. Never awaited by the parser. null is a transport failure and is NOT
// cached, so a moment when ollama was down does not permanently teach the system that Swiggy is
// nothing.
async function learn(idOrToken, siteKeyFn) {
  const id = (siteKeyFn ? identityOf(idOrToken, siteKeyFn) : String(idOrToken || '').toLowerCase()) || '';
  if (!id || seen(id) || asking.has(id)) return null;
  asking.add(id);
  try {
    const kind = await askModel(id);
    if (kind === null) return null;
    load()[id] = kind;
    dirty = true;
    save();
    deps.jlog('Site › learned ' + id + ' → ' + (kind || 'serves none of the errands I route'));
    return kind;
  } catch (e) {
    return null;
  } finally { asking.delete(id); }
}

// FILL THE CACHE FROM THE REGISTRY, AT IDLE, ONE AT A TIME.
//
// 77 sites at 585ms is 45 seconds of model time, which is why it is not done at boot and never
// blocks a request. ONE AT A TIME matters on an 8 GB machine: this is the same 3B the chat path
// uses, and firing 77 concurrent generates at it is how you evict the model mid-conversation.
async function warmAll(opts) {
  const reg = deps.sites() || {};
  const data = reg.data || {};
  const todo = [];
  for (const [k, v] of Object.entries(data)) {
    if (!v || !v.url) continue;
    const id = identity(v.url);
    if (id && !seen(id) && !todo.includes(id)) todo.push(id);
  }
  if (!todo.length) return 0;
  deps.jlog('Site › learning what ' + todo.length + ' registered site(s) are for, one at a time');
  let done = 0;
  for (const id of todo) {
    if (opts && typeof opts.stop === 'function' && opts.stop()) break;
    const k = await learn(id, null);
    if (k !== null) done++;
    // A breath between calls so this never competes with a request he is waiting on.
    await new Promise(r => setTimeout(r, (opts && opts.gapMs) || 250));
  }
  deps.jlog('Site › ' + done + ' of ' + todo.length + ' learned');
  return done;
}

// HIS ANSWER OUTRANKS THE MODEL, PERMANENTLY — the same contract itemclass.teach() has.
function teach(idOrToken, kind, siteKeyFn) {
  const id = (siteKeyFn ? identityOf(idOrToken, siteKeyFn) : String(idOrToken || '').toLowerCase()) || '';
  if (!id) return false;
  if (kind !== '' && !KINDS.includes(kind)) return false;
  load()[id] = kind;
  dirty = true;
  save();
  deps.jlog('Site › learned from him: ' + id + ' is ' + (kind || 'none of my errands'));
  return true;
}

module.exports = {
  init, sitesIn, kindOfSync, identityOf, identity, learn, warmAll, teach, seen,
  KINDS, _cacheFile: CACHE_FILE, _hostIndex: hostIndex,
};
