'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// JARVIS episodic memory — what actually happened, across sessions.
//
// memory.json (the existing one) holds FACTS you told it to remember, and every
// one of them is injected into the prompt on every turn. That does not scale and
// it is the wrong shape for "what did I decide about the Composio routing" —
// which is a question about an EVENT, not a standing fact.
//
// So this is a separate store: an append-only journal of episodes (what you
// asked, what ran, what it answered, who was involved), retrieved on demand by
// the same tf-idf scoring library.js uses. Nothing is injected by default; the
// model only sees passages when a question actually calls for them.
//
// The same journal also derives the knowledge graph — people, apps, projects,
// files and how they connect — because those relationships ARE the episodes,
// read sideways. One store, two readings.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const redactor = require('./redact.js');
const store = require('./store.js');

let deps = { jlog: () => {}, audit: () => {}, llm: null, stateDir: null };
// A NEW STATE FOLDER STARTS FROM ITS OWN FILE (2026-09-25). init() used to change the folder and keep the cached
// list, so the next flush wrote ONE folder's episodes over ANOTHER's file. That is how the test suite — which
// points recall at a temp folder, then loads server.js, which points it at state/ — replaced the owner's real
// memory (1,365 episodes in August) with its fixtures. Now the cache is saved to the folder it came from and
// dropped before the switch, so data can never cross folders, whoever calls init and in whatever order.
function init(d) {
  const next = d && d.stateDir !== undefined ? d.stateDir : deps.stateDir;
  if (next !== deps.stateDir && episodes) {
    try { flush(); } catch (e) {}                // to the OLD folder — deps is not updated yet
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    episodes = null; dirty = false; invalidate();
  }
  deps = Object.assign(deps, d || {});
}

// NEVER /tmp. This is the episodic store — his memory — and the old default put it somewhere macOS
// is entitled to delete. Nothing hits this path today (server.js injects stateDir, every test passes
// its own, and /tmp was verified empty), so this is a loaded gun rather than a live wound: any
// future caller that forgot to init would have written his memory to a purgeable directory and lost
// it with no error at any point. The fallback now lands beside the real store, and says so loudly
// instead of failing silently — a crash here would take the whole server down over a path default,
// which is a worse trade than a noisy log line.
const FALLBACK_DIR = path.join(__dirname, 'state');
let warnedNoStateDir = false;
const FILE = () => {
  if (deps.stateDir) return path.join(deps.stateDir, 'episodes.json');
  if (!warnedNoStateDir) {
    warnedNoStateDir = true;
    const msg = 'Recall › stateDir was never injected — falling back to ' + FALLBACK_DIR;
    try { deps.jlog(msg); } catch (e) {}
    try { console.error(msg); } catch (e) {}
  }
  return path.join(FALLBACK_DIR, 'episodes.json');
};
const MAX_EPISODES = 6000;        // ~2MB at typical length; a year of heavy use
const SAVE_DEBOUNCE = 4000;

let episodes = null;              // lazily loaded
let dirty = false, saveTimer = null;

// Through store.js, which is atomic on write and preserves a damaged file rather
// than reading it as an empty one. This journal is the least replaceable thing on
// the machine — a year of what he asked and what happened — and it was being
// written with a bare writeFileSync, so an interrupted save truncated it, the
// next load parsed nothing and returned [], and the next save wrote that
// emptiness over the remains.
function load() {
  if (episodes) return episodes;
  store.init({ jlog: deps.jlog, stateDir: path.dirname(FILE()) });
  episodes = store.read(path.basename(FILE()), []);
  if (!Array.isArray(episodes)) episodes = [];
  return episodes;
}

function flush() {
  if (!dirty) return;
  store.init({ jlog: deps.jlog, stateDir: path.dirname(FILE()) });
  if (store.write(path.basename(FILE()), episodes)) dirty = false;
}
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, SAVE_DEBOUNCE);
  if (saveTimer.unref) saveTimer.unref();
}

// ---------------- writing ----------------
// kind: 'ask' (what you said) | 'did' (an action that ran) | 'said' (JARVIS's answer)
//     | 'decided' (an explicit decision worth keeping) | 'learned' (a fact discovered)
function log(kind, text, meta) {
  // SECRETS ARE MASKED AT THE ONE DOOR THEY ALL COME THROUGH.
  //
  // Everything journalled reaches this function — logTurn(), profile facts, tool
  // results — so this is the only place that has to be right. The journal is not
  // a passive archive: passive() pulls episodes back into the prompt on later
  // turns, and llm() sends prompts to OpenRouter whenever the hosted tier is in
  // play. Without this, an API key pasted into chat once, or a Bearer header read
  // off a page by browser_page, was written to disk verbatim and could be
  // retrieved and shipped off the machine weeks later by an unrelated question.
  //
  // Redacted BEFORE the length clip, so a secret cannot survive by sitting past
  // character 900 where the clip would have cut the pattern in half and left the
  // first two thirds of a key on disk.
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const t = redactor.redact(raw);
  if (t !== raw) deps.jlog('Recall › masked a credential before journalling (kind: ' + kind + ')');
  if (!t || t.length < 3) return null;
  const list = load();
  const ep = { id: (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)), at: Date.now(), kind, text: t.slice(0, 900) };
  if (meta && Object.keys(meta).length) ep.meta = redactor.redactDeep(meta);
  // A FACT RESTATED IS THE SAME FACT. Turns are history and may legitimately repeat — asking the
  // same question twice happened twice — but a profile fact is a standing statement, and storing it
  // again just makes it louder. The store held ELEVEN copies of the eval codeword and six of one
  // favourite colour, all of which compete for the same retrieval slots and crowd out everything
  // else he has said. Scoped to profile entries for exactly that reason.
  if (kind === 'profile') {
    const same = t.trim().toLowerCase();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].kind === 'profile' && String(list[i].text || '').trim().toLowerCase() === same) list.splice(i, 1);
    }
  }
  list.unshift(ep);
  if (list.length > MAX_EPISODES) list.length = MAX_EPISODES;
  invalidate();                   // the corpus changed; idf and the token cache must be recomputed
  scheduleSave();
  return ep;
}

// A turn is logged as one unit so the question and its answer retrieve together —
// splitting them means "what did I decide about X" finds the question but not the
// answer, which is exactly the useless half.
function logTurn(userText, replyText, meta) {
  const q = String(userText || '').replace(/\s+/g, ' ').trim();
  const a = String(replyText || '').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  if (TRIVIAL_RE.test(q) && q.length < 40) return null;   // "hi", "thanks", "yes" — no value stored
  return log('turn', profile.userLabel() + ' asked: ' + q.slice(0, 400) + (a ? '\nJARVIS answered: ' + a.slice(0, 500) : ''), meta);
}
const TRIVIAL_RE = /^(?:hi|hey|hello|yo|thanks?|thank you|ok(?:ay)?|yes|yeah|yep|sure|no|nope|cool|nice|got it|nvm|never ?mind)\b[\s.!]*$/i;

// ---------------- retrieval (tf-idf + recency) ----------------
const STOP = new Set('the a an and or of to in is it for on with as at by from that this be are was were i you he she they we not but if then than so what which who how why when where all can will me my your jarvis sir asked answered'.split(' '));
// Crudest possible stemming: fold a trailing plural/possessive "s". Applied to documents AND
// queries, so the two still meet. Without it "whats parths role" retrieved nothing about Kunal —
// the apostrophe form already worked, since punctuation is stripped first and the orphaned "s" is
// too short to survive. Guarded against "ss"/"us" so "business" and "status" stay themselves.
const stem = w => (w.length > 3 && /s$/.test(w) && !/(?:ss|us|is)$/.test(w)) ? w.slice(0, -1) : w;
const tokenize = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter(w => w.length > 2 && !STOP.has(w)).map(stem);

let dfCache = null;
// EVERY QUERY USED TO TOKENIZE THE WHOLE CORPUS TWICE.
//
// retrieveScored walked all episodes once to total their lengths for the pivot, then walked them
// again inside the ranking loop — so a single question ran tokenize() over 1476 episodes twice,
// measured at 91.5ms per query and growing with the store, on a path that runs on EVERY turn.
// Tokens depend only on the text, so they are cached beside the document frequencies and thrown
// away by the same invalidation. Nothing about the ranking changes; it just stops redoing the work.
let tokCache = null, avgLenCache = 0;
function corpus() {
  if (tokCache) return tokCache;
  const list = load();
  tokCache = new Map();
  let total = 0;
  for (const ep of list) {
    const w = tokenize(ep.text);
    tokCache.set(ep.id, w);
    total += w.length;
  }
  avgLenCache = Math.max(1, total / Math.max(1, list.length));
  return tokCache;
}
function tokensOf(ep) {
  const c = corpus();
  let w = c.get(ep.id);
  if (!w) { w = tokenize(ep.text); c.set(ep.id, w); }
  return w;
}
function invalidate() { dfCache = null; tokCache = null; }

function df() {
  if (dfCache) return dfCache;
  const d = Object.create(null);
  for (const ep of load()) for (const w of new Set(tokensOf(ep))) d[w] = (d[w] || 0) + 1;
  dfCache = d;
  return d;
}

const DAY = 86400000;
function retrieve(query, k) { return retrieveScored(query, k).map(x => x.ep); }

// Same ranking, but keeps the score and the count of distinct query terms that actually matched.
// Passive recall needs both: a bare score is not comparable across queries of different lengths,
// so "did two separate terms hit?" is the honest relevance test.
function retrieveScored(query, k) {
  const list = load();
  if (!list.length) return [];
  const qs = tokenize(query);
  if (!qs.length) return [];
  const D = df(), N = list.length || 1, now = Date.now();
  // Average length, for pivoted length normalisation below. Computed once with the token cache
  // rather than by re-tokenizing the corpus on every query.
  corpus();
  const avgLen = avgLenCache;
  const scored = [];
  for (const ep of list) {
    const words = tokensOf(ep);
    const tf = Object.create(null);
    for (const w of words) tf[w] = (tf[w] || 0) + 1;
    let s = 0, matched = 0, rarest = 0;
    for (const q of new Set(qs)) {
      if (!tf[q]) continue;
      matched++;
      const idf = Math.log(1 + N / (1 + (D[q] || 0)));
      rarest = Math.max(rarest, idf);
      s += (1 + Math.log(tf[q])) * idf;
    }
    if (!s) continue;
    // Pivoted length normalisation. Without it, plain tf-idf rewards long episodes for being long:
    // asked "how many leads do I hand Kunal", the two sprawling AdMax overview facts outranked the
    // one short fact that actually carried the number ("usually 40 to 50"), which then fell outside
    // the attachment budget — the question was answerable and JARVIS said it did not know. The 0.6
    // pivot keeps this a tilt rather than a penalty on genuinely rich episodes.
    s /= (0.4 + 0.6 * (words.length / avgLen));
    // Gentle recency preference: something from this week beats an equally-good
    // match from three months ago, but a much better old match still wins. Half-life
    // ~45 days, floor 0.55 so old memories never become unreachable.
    const ageDays = (now - ep.at) / DAY;
    s *= Math.max(0.55, Math.pow(0.5, ageDays / 45));
    scored.push({ s, ep, matched, rarest });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k || 6);
}

// ---------------- semantic recall (embeddings, fused with tf-idf) ----------------
//
// WHY BOTH, AND NOT INSTEAD. Measured on 140 known-item queries over his own 1476 episodes:
//
//   tf-idf alone      recall@1 21%   recall@5 49%
//   embeddings alone  recall@1 26%   recall@5 49%   <- a TIE at @5; not an upgrade
//   the two fused     recall@1 28%   recall@5 59%
//
// Swapping tf-idf out would have bought nothing. The gain is entirely in the disagreement: asked
// "where exactly does Mihir live?" only the vectors found it, and asked about "the Vantage V2"
// only tf-idf did. Lexical matching and semantic matching fail on different questions, so the
// honest move is to keep the working retriever and add a second opinion.
//
// WHERE IT RUNS. Only on the EXPLICIT recall path — "what did I decide about X" — which is async
// and rare. passive() and retrieveScored() stay synchronous and tf-idf-only: they run on every
// single turn, 558 tests depend on their being synchronous, and an HTTP round trip per turn would
// cost more than the retrieval is worth. That also keeps the vectors off the hot path entirely.
//
// RAM. One Float32Array for the whole corpus — 1540 x 768 x 4 = 4.7 MB in a single allocation,
// rather than 1540 JS arrays of boxed doubles. Loaded lazily on the first semantic query and never
// touched otherwise. The model itself is 249 MB and TRANSIENT: keep_alive is 30s, so ollama unloads
// it shortly after use instead of holding it resident on an 8 GB machine.
//
// THE MODEL IS READ FROM THE SAME PLACE EVERY OTHER EMBED CALL READS IT. This file used to hardcode
// 'all-minilm' while intent.js took it from the environment. That is two places deciding one
// question, and the failure mode is not a wrong answer, it is THRASHING: ollama keeps one model
// loaded per name, so a turn that touched both would unload 249 MB and load 45 MB and then undo it.
//
// CHANGING THE MODEL INVALIDATES EVERY STORED VECTOR, and the dimension is how that is caught.
// A cosine between two different embedding spaces is a meaningless number that looks like a score,
// so vecLoad() below checks the file's size against ids x EMBED_DIM x 4 and throws the whole store
// away if it disagrees — the 2026-09-12 migration from all-minilm's 384 dims to nomic's 768 relied
// on exactly that, and the index was then rebuilt from the episodes themselves. The vectors are a
// CACHE of the episodes, never the record; episodes.json is the record.
const EMBED_MODEL = process.env.JARVIS_EMBED_MODEL || 'nomic-embed-text';
const EMBED_DIM = 768;
const EMBED_CAP = 64;             // episodes indexed per query, so a backlog never stalls an answer
const VEC_FILE = () => FILE().replace(/\.json$/, '.vec');
const VEC_IDS = () => FILE().replace(/\.json$/, '.vec.json');

let vecBuf = null;                // Float32Array, EMBED_DIM per row
let vecIds = null;                // row index -> episode id
let vecPos = null;                // episode id -> row index
let vecDown = false;              // ollama or the model is unavailable; stop trying this process
const vecSkip = new Set();        // episodes this model cannot embed at all — recorded, never retried

function vecLoad() {
  if (vecBuf) return true;
  try {
    const ids = JSON.parse(fs.readFileSync(VEC_IDS(), 'utf8'));
    const raw = fs.readFileSync(VEC_FILE());
    if (!Array.isArray(ids) || raw.length !== ids.length * EMBED_DIM * 4) throw new Error('vector store size mismatch');
    // Copied rather than viewed: a Buffer from readFileSync may not be 4-byte aligned, and a
    // misaligned Float32Array view throws.
    vecBuf = new Float32Array(new Uint8Array(raw).buffer.slice(0));
    vecIds = ids;
  } catch (e) {
    vecBuf = new Float32Array(0); vecIds = [];
  }
  vecPos = new Map(vecIds.map((id, i) => [id, i]));
  return true;
}

function vecSave() {
  try {
    fs.writeFileSync(VEC_FILE(), Buffer.from(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength));
    fs.writeFileSync(VEC_IDS(), JSON.stringify(vecIds));
  } catch (e) { deps.jlog('Recall › could not save vectors: ' + e.message); }
}

// One embedding from ollama, returning WHY it failed rather than just null.
//
// That distinction is the whole point. The first cut treated every failure as "the service is gone"
// and latched a flag that disabled semantic search for the life of the process — so a single
// over-long episode silently switched the feature off, and the fused ranking quietly collapsed back
// to plain tf-idf while still calling itself a hybrid. Measured: it stopped at 922 of 1476 episodes
// and scored exactly the tf-idf numbers, 21%/49%, which is what a disabled feature looks like when
// nothing tells you it is disabled.
//
// A content error is about ONE episode; only a network error is about the service. The cap is 400
// characters because the real limit is not a character count at all: this model took 948 characters
// of ordinary prose but refused a 680-character episode dense with URLs and ids, so any fixed cap is
// a guess. 400 is a conservative one, and the halving retry below is the net under it.
const EMBED_CHARS = 400;
// The transport is shared (ollama.js), the POLICY is not. The content/net distinction below is
// this module's own and matters here more than anywhere else: a content error is about one episode
// and earns the halving retry, a net error is about the service and must not be mistaken for one —
// that confusion is what made an embedding outage look like an ordinary tf-idf score.
//
// The dimension check stays here too. It is a recall-specific invariant: a vector of the wrong width
// cannot go into an index built at EMBED_DIM, whatever the server thinks it returned.
async function embedOnce(text) {
  const r = await require('./ollama.js').embed(text, {
    model: EMBED_MODEL, keepAlive: '30s', numCtx: 512, timeoutMs: 20000,
  });
  if (r && r.v) {
    if (r.v.length === EMBED_DIM) return { v: r.v };
    return { err: 'content', why: 'unexpected dimension ' + r.v.length + ', wanted ' + EMBED_DIM };
  }
  return r;
}

// Halve on a content error rather than giving up: an episode too dense to embed whole is still worth
// embedding in part, and its opening carries the topic. Below 120 characters there is nothing left
// worth indexing, so it is recorded as unembeddable and never retried.
async function embedText(text) {
  let t = String(text).slice(0, EMBED_CHARS);
  if (!t) return { err: 'content', why: 'empty' };
  // The length floor guards the RETRY, never the first attempt. Written the other way round it read
  // as a sensible "do not bother with scraps" rule and was in fact a switch that turned the whole
  // feature off: every real question is shorter than 120 characters, so no QUERY was ever embedded,
  // every hybrid call fell through to plain tf-idf, and the measured result was a perfect tie with
  // the retriever it was supposed to improve. A tie is what a disabled feature looks like.
  for (let i = 0; i < 3; i++) {
    const r = await embedOnce(t);
    if (r.v) return r;
    if (r.err === 'net') return r;
    const half = Math.floor(t.length / 2);
    if (half < 120) break;
    t = t.slice(0, half);
  }
  return { err: 'content', why: 'too dense to embed at any length' };
}

// Embed whatever is not indexed yet, newest first, bounded. Anything still unindexed is simply not
// in the semantic half this turn — tf-idf still covers it, so a backlog degrades the ranking rather
// than breaking the answer.
async function vecIndex(cap) {
  vecLoad();
  const list = load();
  const missing = list.filter(ep => !vecPos.has(ep.id) && !vecSkip.has(ep.id)).slice(0, cap || EMBED_CAP);
  if (!missing.length) return 0;
  const rows = [];
  for (const ep of missing) {
    const r = await embedText(ep.text);
    if (r.err === 'net') { vecDown = true; break; }   // the SERVICE is gone; stop hammering it
    if (r.err) { vecSkip.add(ep.id); continue; }      // this ONE episode cannot be embedded; carry on
    rows.push([ep.id, r.v]);
  }
  if (!rows.length) return 0;
  const grown = new Float32Array(vecBuf.length + rows.length * EMBED_DIM);
  grown.set(vecBuf, 0);
  rows.forEach(([id, v], i) => {
    grown.set(v, vecBuf.length + i * EMBED_DIM);
    vecPos.set(id, vecIds.length);
    vecIds.push(id);
  });
  vecBuf = grown;
  vecSave();
  return rows.length;
}

// Cosine against every row, reading straight out of the flat buffer — no per-episode allocation.
function vecRank(q, k, floor) {
  let qn = 0;
  for (let i = 0; i < EMBED_DIM; i++) qn += q[i] * q[i];
  qn = Math.sqrt(qn) || 1;
  const out = [];
  for (let r = 0; r < vecIds.length; r++) {
    const off = r * EMBED_DIM;
    let dot = 0, n = 0;
    for (let i = 0; i < EMBED_DIM; i++) { const v = vecBuf[off + i]; dot += q[i] * v; n += v * v; }
    const s = dot / ((Math.sqrt(n) || 1) * qn);
    if (s >= (floor || 0)) out.push({ id: vecIds[r], s });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, k).map(x => x.id);
}

// Reciprocal rank fusion. Deliberately NOT a weighted sum of the two scores: tf-idf's scale moves
// with idf and corpus size while cosine sits in [-1,1], so any fixed weighting between them would
// be a constant that happened to suit one afternoon's corpus. Ranks are comparable; scores are not.
// THE SEMANTIC HALF NEVER SPEAKS ALONE.
//
// Vector search always returns a nearest neighbour. There is no such thing as "no match" — ask it
// about "qqqzzz never discussed" and it will hand back whichever episode is least unlike nonsense,
// with a straight face. tf-idf cannot do that: no shared term means no result, which is why
// recall() has always been able to say "nothing in our history matches that" and mean it. Fusing a
// retriever that cannot abstain into one that can would have destroyed exactly that property, and
// the reflective suite caught it — two tests, both about refusing to invent a memory.
//
// A cosine floor alone does NOT fix it, and the numbers say so plainly. Measured on his corpus, the
// best cosine anywhere for six nonsense queries ran 0.249-0.396, while the weakest of forty real
// queries scored 0.306. The distributions OVERLAP: no threshold separates them, so any floor either
// admits nonsense or silently drops real questions.
//
// So the gate is structural. The semantic half only ever REORDERS what the lexical half already
// admitted: if tf-idf found nothing, the answer is nothing, exactly as before. The floor is kept as
// well, at 0.40 — above every nonsense probe — to stop a weak semantic match promoting an unrelated
// episode over a good lexical one. Cheap, and it costs nothing when tf-idf is already confident.
const SEM_FLOOR = 0.40;
async function retrieveHybrid(query, k) {
  const lex = retrieveScored(query, (k || 6) * 3);
  // Nothing lexical means nothing at all — the abstention that makes this store trustworthy.
  if (!lex.length) return [];
  if (vecDown) return lex.slice(0, k || 6).map(x => x.ep);
  try {
    await vecIndex(EMBED_CAP);
    const qr = await embedText(query);
    if (qr.err === 'net') vecDown = true;
    if (!qr.v) return lex.slice(0, k || 6).map(x => x.ep);
    const sem = vecRank(qr.v, (k || 6) * 3, SEM_FLOOR);
    const byId = new Map(load().map(ep => [ep.id, ep]));
    const score = new Map();
    const add = (id, rank) => score.set(id, (score.get(id) || 0) + 1 / (60 + rank + 1));
    lex.forEach((x, i) => add(x.ep.id, i));
    sem.forEach((id, i) => add(id, i));
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k || 6)
      .map(([id]) => byId.get(id))
      .filter(Boolean);
  } catch (e) {
    return lex.slice(0, k || 6).map(x => x.ep);       // memory must never fail closed
  }
}

function when(ts) {
  const d = new Date(ts), now = Date.now(), ago = now - ts;
  if (ago < DAY && new Date(now).getDate() === d.getDate()) return 'today ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (ago < 2 * DAY) return 'yesterday';
  if (ago < 7 * DAY) return Math.round(ago / DAY) + ' days ago';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: ago > 300 * DAY ? 'numeric' : undefined });
}

// ---------------- entity extraction → knowledge graph ----------------
// Deliberately heuristic, no model. Entities come from things JARVIS already knows
// are real: contact names it looked up, apps it opened, files it touched, books in
// the library. Guessing entities out of free text with a 3B model produces noise,
// and a wrong node in a graph you trust is worse than a missing one.
const PROJECT_HINTS = /\b(admax|jarvis|neural network|ambient dashboard|jarvis search|focus guard|clap daemon|library)\b/gi;

function entitiesIn(ep) {
  const out = [];
  const m = ep.meta || {};
  if (m.person) out.push({ type: 'person', name: String(m.person) });
  if (m.app) out.push({ type: 'app', name: String(m.app) });
  if (m.file) out.push({ type: 'file', name: path.basename(String(m.file)) });
  if (m.book) out.push({ type: 'book', name: String(m.book) });
  if (m.site) out.push({ type: 'site', name: String(m.site) });
  let pm;
  const re = new RegExp(PROJECT_HINTS.source, 'gi');
  while ((pm = re.exec(ep.text))) out.push({ type: 'project', name: pm[1].toLowerCase() });
  return out;
}

// Builds {nodes, edges} in the same shape buildNeuralGraph() emits, so the existing
// Palantir renderer draws it with no client changes beyond a mode switch.
function graph(opts) {
  const list = load();
  const since = (opts && opts.since) || 0;
  const counts = new Map();       // key → {type, name, n, last}
  const pairs = new Map();        // "a|b" → n
  for (const ep of list) {
    if (ep.at < since) continue;
    const ents = entitiesIn(ep);
    const uniq = [];
    for (const e of ents) {
      const key = e.type + ':' + e.name.toLowerCase();
      if (uniq.includes(key)) continue;
      uniq.push(key);
      const c = counts.get(key) || { type: e.type, name: e.name, n: 0, last: 0 };
      c.n++; c.last = Math.max(c.last, ep.at);
      counts.set(key, c);
    }
    // Co-occurrence in one episode = a real relationship (you messaged Kunal ABOUT AdMax).
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
      const k = [uniq[i], uniq[j]].sort().join('|');
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  const GROUP = { person: 'io', app: 'target', file: 'store', book: 'store', site: 'target', project: 'core' };
  const nodes = [], edges = [];
  const kept = new Set();
  // Everything seen at least twice, plus anything from the last week — the floor keeps
  // one-off mentions from cluttering the graph without hiding recent context.
  const weekAgo = Date.now() - 7 * DAY;
  for (const [key, c] of counts) {
    if (c.n < 2 && c.last < weekAgo) continue;
    kept.add(key);
    nodes.push({
      id: key, label: c.name.toUpperCase(), group: GROUP[c.type] || 'store',
      meta: c.type + ' · ' + c.n + '×',
      desc: 'A ' + c.type + ' from your own history. Seen in ' + c.n + ' episode' + (c.n === 1 ? '' : 's') + ', most recently ' + when(c.last) + '.',
    });
  }
  for (const [k, n] of pairs) {
    const [a, b] = k.split('|');
    if (!kept.has(a) || !kept.has(b)) continue;
    if (n < 2) continue;
    edges.push({ from: a, to: b, kind: 'flow' });
  }
  return { nodes, edges, activity: {}, at: Date.now(), empty: !nodes.length };
}

// ---------------- tools ----------------
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = say => ({ ok: false, say });

async function recall(args) {
  const q = String(args.query || args.question || args.text || '').trim();
  if (!q) return fail('What should I cast my mind back to, Sir?');
  // The one path that gets the semantic half. It is async and asked deliberately, so it can afford
  // an embedding round trip; it falls back to plain tf-idf whenever ollama is not there.
  const hits = await retrieveHybrid(q, 6);
  if (!hits.length) return fail('Nothing in our history matches that, Sir.');
  const ctx = hits.map((h, i) => '[' + (i + 1) + '] (' + when(h.at) + ') ' + h.text).join('\n\n');
  if (!deps.llm) return ok('From our history, Sir:\n\n' + ctx.slice(0, 1200));
  try {
    const r = await deps.llm({
      // The speaker labels have to be spelled out: a 3B model reliably flips them and reports
      // "you asked Mihir about entropy", which inverts who did what in a memory feature — the
      // one place where being confidently backwards is worst.
      system: 'You are JARVIS. ' + profile.userRef() + ' is your user' + (profile.honorific() ? '; you address ' + profile.pronouns().obj + ' as ' + profile.honorific() : '') + '. In the episodes below, ' +
        '"' + profile.userLabel() + ' asked:" is ' + profile.pronouns().obj.toUpperCase() + ' speaking TO YOU, and "JARVIS answered:" is YOUR OWN past reply. ' +
        'Answer his question using only these episodes, in the second person ("you asked me about X"). ' +
        'Say WHEN, using the time in brackets. If the episodes do not answer it, say so plainly rather than ' +
        'inventing a memory — a fabricated memory is worse than none. Two or three sentences.',
      messages: [{ role: 'user', content: 'EPISODES:\n' + ctx + '\n\nQUESTION: ' + q }],
      max_tokens: 350, timeoutMs: 60000,
    });
    const answer = String(r.text || '').trim();
    deps.audit('recall', { q: q.slice(0, 60), hits: hits.length }, 'ok');
    if (!answer) return ok('From our history, Sir:\n\n' + ctx.slice(0, 1000));
    return ok(answer, { data: { episodes: hits.map(h => ({ at: h.at, kind: h.kind })) } });
  } catch (e) { return ok('From our history, Sir:\n\n' + ctx.slice(0, 1000)); }
}

function recall_stats() {
  const list = load();
  if (!list.length) return ok('No episodes recorded yet, Sir — I start remembering from now.');
  const oldest = list[list.length - 1].at;
  const g = graph();
  return ok('I am holding ' + list.length + ' episodes, Sir — going back to ' + when(oldest) +
    '. They connect ' + g.nodes.length + ' people, apps and projects.');
}

function forget_episodes(args) {
  const q = String(args.query || args.about || '').trim();
  const list = load();
  if (!q) return fail('Forget what, Sir? Name the subject and I will drop those episodes.');
  const found = retrieve(q, 40);
  const hits = new Set(found.map(h => h.id));
  if (!hits.size) return fail('Nothing matching that in my history, Sir.');
  // dry: count and preview only — the chat lane asks before anything is deleted (2026-10-10: "forget what i said" deleted 3
  // episodes about "i said" with no question asked; there is no undo).
  if (args.dry) return ok('', { data: { n: hits.size, q, preview: found.slice(0, 3).map(h => String(h.text || '').replace(/\s+/g, ' ').slice(0, 80)) } });
  episodes = list.filter(e => !hits.has(e.id));
  invalidate(); dirty = true; flush();
  deps.audit('forget_episodes', { q: q.slice(0, 60), n: hits.size }, 'ok');
  return ok('Forgotten, Sir — ' + hits.size + ' episode' + (hits.size === 1 ? ' is' : 's are') + ' gone about “' + q + '”.');
}

// FORGETTING A FACT IS NARROWER THAN FORGETTING A SUBJECT.
//
// forget_episodes() drops everything tf-idf associates with the query — up to 40 entries, ordinary
// conversation turns included. That is right for "forget everything about the Swiggy order" and
// completely wrong for "forget that my favourite trek is hampta pass", which should remove one
// stated fact and no history whatsoever. So this matches PROFILE entries only, and on a literal
// term hit rather than a ranked association: a fact is forgotten because it says the thing, not
// because it scored near it. Returns how many went, so the caller can stay quiet when none did.
function forget_facts(query, opts) {
  const want = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  if (!want.length) return 0;
  const list = load();
  // EVERY term, not any. Measured the hard way: "forget that my favourite trek is hampta pass" with
  // an any-term match deleted NINE facts, because "favourite" alone matched every favourite he had
  // ever stated, including his favourite colour. Forgetting is not recoverable, so it gets the
  // strictest rule in the file — a fact goes only when it contains ALL the distinctive words of the
  // request, which is the difference between naming a fact and naming a topic.
  const doomed = list.filter(e => e.kind === 'profile' &&
    want.every(w => String(e.text || '').toLowerCase().includes(w)));
  if (!doomed.length) return 0;
  if (opts && opts.dry) return doomed.length;          // count only — the chat lane asks first
  const ids = new Set(doomed.map(e => e.id));
  episodes = list.filter(e => !ids.has(e.id));
  invalidate(); dirty = true; flush();
  deps.audit('forget_facts', { q: String(query).slice(0, 60), n: doomed.length }, 'ok');
  return doomed.length;
}

const TOOLS = { recall, recall_stats, forget_episodes };
const TOOL_HELP = {
  recall: 'recall{query}. Search your OWN past conversations and actions with the user — what they asked, decided, or had you do, and when. Use for "what did I say about X", "when did we do Y", "what did I decide".',
  recall_stats: 'recall_stats{}. How much history is held.',
  forget_episodes: 'forget_episodes{query}. Permanently drop remembered episodes about a subject.',
};

// Questions that are ABOUT the shared history rather than about the world.
const RECALL_RE = /\b(?:what did (?:i|we|you) (?:say|ask|decide|do|call|name|choose|pick)|when did (?:i|we|you)|remind me what|do you remember|remember (?:when|what|the)|recall\b|last time (?:i|we)|have (?:i|we) (?:ever )?(?:asked|done|discussed|talked about)|what (?:was|were) (?:my|our|the) (?:decision|plan|reason)|how did (?:i|we) )/i;
const FORGET_RE = /\bforget (?:what|everything|all|about|our|the) |\bforget (?:that|those) (?:episodes?|conversations?|chats?)\b/i;

// ---------------- housekeeping (dream mode) ----------------
function recent(since) { return load().filter(e => e.at >= since); }

// Exact-duplicate turns add nothing to retrieval but do skew idf — asking the same
// question five times should not make its words look rare. Keeps the newest copy.
function compact() {
  const list = load();
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const key = e.kind + '|' + e.text.slice(0, 160).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  const dropped = list.length - out.length;
  if (dropped) { episodes = out; invalidate(); dirty = true; }
  flush();
  return dropped;
}

// ---------------- passive recall ----------------
// Facts written by the profile were previously write-only: retrieve() ran ONLY behind RECALL_RE
// ("do you remember…"), so an ordinary question like "what does Kunal do" never consulted memory
// and JARVIS truthfully said it did not know something it had been told.
//
// The cost of getting this wrong is context, on every single turn, for the local 3B — so the bar is
// deliberately high. Two distinct query terms must hit the same episode, or one genuinely rare term
// (a name, a project), which is what makes "what does Kunal do for AdMax" match and "how are you"
// match nothing at all.
// A lone term fires only if it is not in more than roughly a third of episodes. This is a low bar on
// purpose: GENERIC below is what screens out everyday words, and a stricter rarity cut simply broke
// the good case — "admax" sits in 3 of 43 episodes and a 1-in-12 threshold rejected the single most
// distinctive word in the store.
const RARE_IDF = Math.log(1 + 3);

// A word can be rare in a small corpus purely by accident: with 40 episodes, "time" appearing once
// inside "40 to 50 at a time" scored as rare enough to fire on "what time is it". Corpus-rarity
// alone is therefore not evidence — a lone term may only trigger recall if it is also not an
// everyday word. This is a hand-kept list rather than a frequency table, which is the honest
// trade for a zero-dependency build: it will have gaps, and the failure mode of a gap is one
// unnecessary 700-char attachment, not a wrong answer.
const GENERIC = new Set(('time times day days today tomorrow yesterday week month year now moment ' +
  'thing things stuff way ways good bad better best nice great okay fine sure yeah yes idea ' +
  'need needs want wants know knows knew make makes made get gets got give gives take takes ' +
  'come comes going went look looks see seen say says tell tells ask asks help helps use uses ' +
  'work works working try tries new old big small long short more most less least much many ' +
  'people person man woman guy someone something anything nothing everything one two three ' +
  'first last next back down over out up off just like really very still even also about ' +
  'right left top bottom here there where place home life world part end start stop open close ' +
  // Second pass, added after the live store showed the gap: "how are you doing today" attached
  // three episodes because "doing" was simply missing here. Conversational filler is the exact
  // shape that must never trigger recall, so the common verbs and hedges are worth spelling out.
  'doing done does did having has had been being seems seem think thought feel feels felt ' +
  'talk talks talked said call calls called keep keeps kept put puts set sets run runs ran ' +
  'show shows find finds found mean means sort kind bit lot guess maybe please actually ' +
  'probably anyway again another other others same different sure really quite pretty ' +
  'today tonight morning evening afternoon night early late soon later always never often ' +
  'ready able sorry thanks thank hello hey mind wonder tried check checked look looking ' +
  // Third pass: the everyday verbs and nouns of using a computer. "How do I create a folder"
  // matched the AdMax facts purely on "creates", which is not evidence of anything.
  'create creating add adding delete remove send sending write writing read reading save saving ' +
  'change edit move copy list search find open close turn play stop start file files folder ' +
  'folders app apps page pages link links note notes name names number numbers thing text')
  .split(' '));

// What passive recall may draw on. Deliberately EXCLUDES 'turn' — the raw chat transcript, which is
// 344 of the 374 episodes in the live store. Including it meant "what's the weather" retrieved three
// past occasions he asked the same thing, which is noise at best; at worst it feeds JARVIS its own
// earlier answers as background and re-affirms a mistake it has already made. Transcripts stay fully
// reachable through the explicit RECALL_RE lane ("do you remember what I asked…"), which is exactly
// what that lane is for. This one is for durable knowledge.
// 'digest' is excluded for the same reason and one of its own: a day summary is compressed
// transcript, and being long and multi-topic it matched almost every query — "open spotify",
// "open my emails" and "how do i create a folder" all pulled the same day summary, which is
// tf-idf's long-document failure, not relevance.
// 'correction' joins these because a correction is a STANDING fact — he told
// JARVIS it was wrong about something, and that has to be in front of the model
// on the next turn or the same mistake is made again, which is the entire point
// of recording it. Turns stay out (they are history, and there are thousands).
const PASSIVE_KINDS = new Set(['profile', 'learned', 'correction']);

function passive(query, opts) {
  const o = opts || {};
  const kinds = o.kinds ? new Set(o.kinds) : PASSIVE_KINDS;
  // Length floor of 3, not 4: "mom", "dad", "gym", "job" are exactly the short words worth
  // retrieving on, and "where is my mom" retrieved nothing while the floor was 4. Anything shorter
  // and more common is already removed by STOP during tokenisation.
  const strong = new Set(tokenize(query).filter(w => w.length >= 3 && !GENERIC.has(w)));
  const hits = retrieveScored(query, (o.k || 3) * 8)
    .filter(h => kinds.has(h.ep.kind))
    .slice(0, o.k || 3)
    .map(h => {
      const words = new Set(tokenize(h.ep.text));
      let n = 0;
      for (const w of strong) if (words.has(w)) n++;
      return Object.assign({ strong: n }, h);
    })
    .filter(h => h.strong >= 2 || (h.strong >= 1 && h.rarest >= RARE_IDF));
  if (!hits.length) return null;
  const budget = o.budget || 700;
  const lines = [];
  let used = 0;
  for (const h of hits) {
    const line = '(' + when(h.ep.at) + ') ' + h.ep.text.replace(/\s+/g, ' ').trim();
    // The best match is always attached, clipped if it has to be. Dropping it for being long
    // would mean the strongest hit is the one most likely to go missing — silently.
    if (!lines.length) { lines.push(line.slice(0, budget)); used = Math.min(line.length, budget); continue; }
    if (used + line.length > budget) break;
    lines.push(line); used += line.length;
  }
  if (!lines.length) return null;
  return { lines, hits: hits.length };
}

module.exports = { init, TOOLS, TOOL_HELP, log, logTurn, retrieve, retrieveScored, retrieveHybrid, passive, graph, when, RECALL_RE, FORGET_RE, forget_facts, flush, recent, compact, count: () => load().length };
