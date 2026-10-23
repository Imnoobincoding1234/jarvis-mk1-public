'use strict';
const door = require('./ollama.js');   // makeRoomFor before every read
// ---------------------------------------------------------------------------
// THE READER MODEL — a small model trained on his own requests, and a checker it cannot get past.
//
// WHAT THIS REPLACES. quickActionCore's word regexes, and the two 3B calls that produced actions from
// anything the regexes missed: normalizeCommand (measured fabricating in ~70% of 157 real rewrites)
// and classifyAction. Neither word lists nor a general model's guesses: a 0.8B Qwen3.5, LoRA-trained
// (finetune/) on his own messages labelled by hand, reads ONE message into ONE reading —
//
//     {"act":"search_web","query":"pizza","where":"swiggy"}
//
// and the machine does everything else.
//
// WHY IT IS NOT TRUSTED, and what stands in its way. It is still a generative model; no test makes it
// 100%. So a reading only becomes an action through build(), which refuses it unless:
//   - every word-valued field is copied from his message (it cannot invent a target, a query or a
//     name — the normaliser's failure, made structurally impossible rather than guarded against);
//   - every name resolves in a registry the machine owns (sites.json, installed apps, browsers,
//     workflows, the folders actually on his disk) — or, for a file he is creating, is his own words;
//   - the half of an antonym pair it chose (open/close, create/delete) is one the model was sure of,
//     or one he has confirmed for these words (direction()). Otherwise he is ASKED, and his answer is
//     kept. There is no verb table: the seed that stood here was a keyword trap and is gone.
// A refused reading is not an action: the message goes on to the lanes below, exactly as an unread
// one did.
//
// THE SYNCHRONOUS CONTRACT, same as errand.js and actread.js: quickAction is synchronous and has many
// synchronous callers, so warm() reads every string they could be handed before they run, and
// readSync() answers from that cache. Nothing read means null, and null never acts.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const HOME = process.env.HOME || '';
// The prompt the model was trained on (finetune/build_dataset.py), in the chat layout its tokenizer
// renders with thinking switched off. Sent raw so no server-side template can change a byte of it.
const SYSTEM = "Read the message as one JARVIS action. Reply with JSON only. Copy the user's words exactly.";
const promptFor = text =>
  '<|im_start|>system\n' + SYSTEM + '<|im_end|>\n<|im_start|>user\n' + String(text) +
  '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';

const ACTS = ['open', 'close', 'search_web', 'play', 'search_files', 'create_folder', 'create_file',
  'delete', 'read', 'append', 'list', 'system_status', 'screenshot', 'list_running', 'empty_trash',
  'sleep_display', 'dream_log', 'dream_now', 'dream_on', 'dream_off', 'quiz_me', 'study_stats', 'learn_topic',
  'stop_topic', 'message', 'call', 'remind', 'calendar', 'note', 'weather', 'time', 'pause', 'resume', 'next_track',
  'volume_up', 'volume_down', 'multi', 'none'];
// Which fields each act needs and may carry — the same table finetune/label_batch.py enforces on
// every training label, so a reading the checker accepts is shaped like one the model learned.
const FIELDS = {
  // `when` (round 7, 2026-10-15): the words saying WHEN to do it — the act is scheduled, not done now (build() carries it on the
  // action; server.js scheduleAction). `as` on close too ("close the notes app").
  open: [['thing'], ['as', 'business', 'browser', 'when']],
  close: [['thing'], ['force', 'as', 'when']],
  search_web: [['query'], ['where', 'browser', 'when']],
  play: [['query'], ['where', 'browser', 'video', 'when']],
  search_files: [['query'], []],
  create_folder: [['name'], ['where']],
  create_file: [['name'], ['where', 'content']],
  delete: [['thing'], ['where']],
  read: [['thing'], ['where']],
  append: [['thing', 'content'], ['where']],
  list: [['thing'], ['where']],
  system_status: [[], []], screenshot: [[], ['when']], list_running: [[], []],
  empty_trash: [[], []], sleep_display: [[], []],
  // Dream mode (taught 2026-09-18): the log, run it now, and the setting as a polarity pair.
  dream_log: [[], []], dream_now: [[], []], dream_on: [[], []], dream_off: [[], []],
  // The tutor (taught 2026-09-19): the subject is copied from his words like every other value.
  quiz_me: [[], ['topic']], study_stats: [[], []], learn_topic: [['topic'], []], stop_topic: [['topic'], []],
  // Round 3 (taught 2026-09-27, finetune/LABELING.md): the jobs the message/call regions, the agent loop and
  // the weather regexes used to guess at. Values are his words; people resolve against his address books.
  message: [['to'], ['body', 'where', 'reported', 'when']], call: [['to'], ['where', 'video', 'when']],
  remind: [[], ['what', 'when']], calendar: [[], ['when']], note: [['content'], ['write']], weather: [[], ['where', 'when']], time: [[], ['where']],
  pause: [[], ['when']], resume: [[], ['when']], next_track: [[], ['when']], volume_up: [[], ['when']], volume_down: [[], ['when']],
  // Round 4: 2–4 independent requests from one message, each step a reading of its own (never multi/none).
  multi: [['steps'], []],
  none: [[], []],
};
// `refers` may ride on ANY act, none included (finetune/LABELING.md): the message leans on something
// named earlier in the conversation. It says whether the reference resolver has anything to do — it
// is never a value, so build() never reads it.
const ANY_ACT = ['refers'];
// The acts whose `when` means "do it then" (round 7) — JARVIS's own act names.
const WHEN_ACTS = new Set(['open', 'close', 'search_web', 'play', 'screenshot', 'message', 'call', 'pause', 'resume', 'next_track', 'volume_up', 'volume_down']);
const STEP_PROPS = {
  act: { type: 'string', enum: ACTS.filter(a => a !== 'multi' && a !== 'none') },
  thing: { type: 'string' }, query: { type: 'string' }, where: { type: 'string' }, browser: { type: 'string' },
  name: { type: 'string' }, content: { type: 'string' }, topic: { type: 'string' }, to: { type: 'string' },
  body: { type: 'string' }, what: { type: 'string' }, when: { type: 'string' },
  as: { type: 'string', enum: ['site', 'app'] }, business: { type: 'boolean' }, force: { type: 'boolean' },
  reported: { type: 'boolean' }, video: { type: 'boolean' }, write: { type: 'boolean' },
};
const MULTI_MIN = 2, MULTI_MAX = 4;
const SCHEMA = {
  type: 'object',
  properties: {
    act: { type: 'string', enum: ACTS },
    thing: { type: 'string' }, query: { type: 'string' }, where: { type: 'string' },
    browser: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' }, topic: { type: 'string' },
    to: { type: 'string' }, body: { type: 'string' }, what: { type: 'string' }, when: { type: 'string' },
    as: { type: 'string', enum: ['site', 'app'] }, business: { type: 'boolean' }, force: { type: 'boolean' },
    reported: { type: 'boolean' }, video: { type: 'boolean' }, write: { type: 'boolean' }, refers: { type: 'boolean' },
    steps: { type: 'array', minItems: MULTI_MIN, maxItems: MULTI_MAX, items: { type: 'object', properties: STEP_PROPS, required: ['act'] } },
  },
  required: ['act'],
};

const deps = {
  jlog: () => {},
  store: null,
  model: process.env.JARVIS_READER_MODEL || 'jarvis-reader',
  // The reader is an LLM on an 8 GB machine that also runs the 3B. It is small (~0.6 GB) and short-
  // lived: resident only while he is issuing commands.
  keepAlive: '2m',
  numCtx: 512,
  // registries and helpers, injected by server.js
  actread: null, verblex: null, siteKey: () => null, siteEntry: () => null, browserName: () => null,
  workflows: () => [], socialKeys: () => [], businessSite: () => null,
  validUrl: () => false, normalizeUrl: s => s,
  laterOn: () => false,   // round 7's "do it later" path (server.js laterOn, JARVIS_READER_LATER) — off: `when` stays where it was before
};
function init(opts) {
  for (const k of Object.keys(opts || {})) if (opts[k] !== undefined) deps[k] = opts[k];
  load();
}

// ---------------------------------------------------------------------------
// CACHE
// ---------------------------------------------------------------------------
// Tests keep their own cache file, so a suite and the live server never overwrite each other's reads.
const CACHE_FILE = process.env.JARVIS_READER_CACHE || 'readmodel.json';
// Trailing sentence punctuation is dropped everywhere a sentence is read or looked up: the splitter's
// candidates arrive without it and a synchronous caller may pass it with it, and the two must be the
// same key. Shape only.
const bare = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '').trim();
const key = s => bare(s).toLowerCase();
let cache = null, dirty = false, modelTag = null;
function load() {
  if (cache) return cache;
  cache = { tag: null, readings: Object.create(null), at: 0 };
  try {
    const saved = deps.store && deps.store.read(CACHE_FILE, null);
    if (saved && saved.readings) { cache.tag = saved.tag; Object.assign(cache.readings, saved.readings); }
  } catch (e) {}
  return cache;
}
function save() {
  if (!dirty || !deps.store) return;
  try { deps.store.write(CACHE_FILE, { tag: cache.tag, readings: cache.readings, at: Date.now() }); dirty = false; } catch (e) {}
}

// ---------------------------------------------------------------------------
// THE MODEL
// ---------------------------------------------------------------------------
function post(pathname, body, timeoutMs) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: 11434, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve(null); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.write(data); req.end();
  });
}
// The model's digest names what is installed, so a retrained reader discards readings the old one made.
async function currentTag() {
  if (modelTag) return modelTag;
  const r = await post('/api/show', { model: deps.model }, 5000);
  if (!r || r.status !== 200 || !r.body) return null;
  const basis = JSON.stringify([r.body.modified_at || '', r.body.details || {}, SYSTEM]);
  modelTag = crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12);
  return modelTag;
}
// HOW SURE WAS IT? The least likely token the model chose while writing its reading — which act,
// where a copied phrase starts and stops, whether a field is there at all. A reading written through
// a token it gave less than MIN_CONFIDENCE is treated as unread: the request goes on to the lanes
// below, exactly as one the model never saw.
//
// SWEPT 2026-09-17 with finetune/eval_ollama.js, jarvis-reader (q8_0, adapter reader_mid3_c2 step 1600),
// on the three held-out sets no run trained on — 50 clean validation rows, 86 pattern rows written
// before their training batch, 118 of his ordinary messages. Counts are exact / MISS / WRONG, summed:
//
//     cut    exact  MISS  WRONG   WRONG the checker still lets act
//     0.5     237    11     6     3   (browser dropped; quit for force quit; "play X and open Y" → open Y)
//     0.6     235    14     5     2
//     0.7     229    23     2     0   <- "toss invoice_copy.png…" → empty_trash is refused (the file he
//     0.8     223    31     0     0      named is unused), "scrap that plan" → delete asks which file
//     0.9     217    37     0     0
//
// 0.7 is the lowest cut at which nothing wrong ACTS — but only because the checker's shape rules
// catch the two left (a file he named and the reading ignores; a delete of something not there). With
// the exam added (472 rows) and the readings between the floor and the cut asked about rather than
// dropped, the cut was raised to where the model alone lets nothing wrong through:
//
//     cut    wrong readings reaching an action   questions (of them on the exam)   right actions taken at once
//     0.70           2 (checker stops both)                23 (9)                           49
//     0.75           0                                     29 (10)                          45
//     0.80           0                                     36 (13)                          39
//
// Also seen after the sweep, in test_parse: "make a note called mechanical soup" read as a FOLDER at
// 0.743 — under 0.75 it is a question ("Should I create the folder …?"), not a folder.
const MIN_CONFIDENCE = Number(process.env.JARVIS_READER_MIN_CONFIDENCE) || 0.75;
function confidenceOf(logprobs) {
  if (!Array.isArray(logprobs) || !logprobs.length) return null;
  let min = 1;
  for (const t of logprobs) if (t && typeof t.logprob === 'number') min = Math.min(min, Math.exp(t.logprob));
  return Math.round(min * 1000) / 1000;
}
function parseReading(body) {
  if (!body || typeof body.response !== 'string') return null;
  let v;
  try { v = JSON.parse(body.response); } catch (e) { v = { act: '__unreadable__' }; }
  if (!v || typeof v !== 'object') return null;
  const conf = confidenceOf(body.logprobs);
  if (conf !== null) Object.defineProperty(v, '__conf', { value: conf, enumerable: true });
  const pol = polarityOf(v.act, body.logprobs);
  if (pol) {
    Object.defineProperty(v, '__pol', { value: pol.chosen, enumerable: true });
    if (pol.other !== null) Object.defineProperty(v, '__anti', { value: pol.other, enumerable: true });
  }
  const ref = refersOf(v, body.logprobs);
  if (ref !== null) Object.defineProperty(v, '__ref', { value: ref, enumerable: true });
  return v;
}
// HOW LIKELY THE MESSAGE LEANS ON THE CONVERSATION, as the model itself put it. `refers` is the last key
// the schema allows, so where the reading could have ended, the probability the model gave to going on
// (a comma) is an upper bound on its writing `refers` — the side a skipped reference check must err on.
// A reading that does say refers: the probability of the comma it chose. One that does not: the listed
// alternatives that go on, or, when none is listed, the least likely listed one (which bounds it).
// Shape of the model's own JSON only.
function refersOf(v, logprobs) {
  if (!v || !Array.isArray(logprobs) || !logprobs.length) return null;
  let text = '';
  const spans = logprobs.map(t => {
    const piece = String(t && t.token != null ? t.token : '');
    const span = [text.length, text.length + piece.length];
    text += piece;
    return span;
  });
  const said = v.refers === true;
  const pos = said ? text.lastIndexOf(',', text.lastIndexOf('"refers"')) : text.lastIndexOf('}');
  if (pos < 0) return null;
  const i = spans.findIndex(([a, b]) => a <= pos && pos < b);
  if (i < 0 || typeof logprobs[i].logprob !== 'number') return null;
  const round = x => Math.round(x * 1000) / 1000;
  if (said) return round(Math.exp(logprobs[i].logprob));
  const off = pos - spans[i][0];
  const mine = String(logprobs[i].token).slice(0, off);
  const alts = Array.isArray(logprobs[i].top_logprobs) ? logprobs[i].top_logprobs : [];
  let on = 0, least = 1, listed = false;
  for (const a of alts) {
    if (!a || typeof a.logprob !== 'number') continue;
    const p = Math.exp(a.logprob);
    least = Math.min(least, p);
    const piece = String(a.token != null ? a.token : '');
    if (piece.slice(0, off) === mine && piece[off] === ',') { on += p; listed = true; }
  }
  return round(listed ? on : alts.length ? least : 1);
}
// WHERE THE HALVES PART. In the reading's own JSON the act is the first value, and the token where its
// name first differs from the other half's is where the model chose between them: the first letter for
// open/close and create/delete, the letter after "dream_o" for dream_on/dream_off. Kept: the probability
// of that token, and the best alternative Ollama lists there that continues the name into the OTHER
// half. When the other half is not among the listed alternatives, the least likely listed one bounds it
// from above, so the margin is never overstated. Act names are the machine's own (ACTS); the pattern
// reads the model's JSON, not his words.
const OTHER_HALF = { open: ['close'], close: ['open'], create_folder: ['delete'], create_file: ['delete'],
                     delete: ['create_folder', 'create_file'], dream_on: ['dream_off'], dream_off: ['dream_on'] };
const sharedStart = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
function polarityOf(act, logprobs) {
  const others = OTHER_HALF[act];
  if (!others || !Array.isArray(logprobs) || !logprobs.length) return null;
  let text = '';
  const spans = logprobs.map(t => {
    const piece = String(t && t.token != null ? t.token : '');
    const span = [text.length, text.length + piece.length];
    text += piece;
    return span;
  });
  const m = /"act"\s*:\s*"/.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  const split = at + Math.min(...others.map(o => sharedStart(act, o)));
  const i = spans.findIndex(([a, b]) => a <= split && split < b);
  if (i < 0 || typeof logprobs[i].logprob !== 'number') return null;
  const base = spans[i][0];
  // What this token adds to the name, for any piece in its place: the part of the token before the name
  // starts (an opening quote) must match, the part of the name written before the token is kept, and
  // the name ends at its closing quote.
  const lead = base < at ? text.slice(base, at) : '';
  const before = base > at ? text.slice(at, base) : '';
  const nameWith = piece => piece.startsWith(lead) ? (before + piece.slice(lead.length)).split('"')[0] : null;
  const alts = Array.isArray(logprobs[i].top_logprobs) ? logprobs[i].top_logprobs : null;
  let other = null;
  if (alts && alts.length) {
    let least = 1, best = null;
    for (const a of alts) {
      if (!a || typeof a.logprob !== 'number') continue;
      const p = Math.exp(a.logprob);
      least = Math.min(least, p);
      const name = nameWith(String(a.token != null ? a.token : ''));
      if (name && name.length > before.length && others.some(o => o.startsWith(name)) && !act.startsWith(name)) best = Math.max(best || 0, p);
    }
    other = best !== null ? best : least;
  }
  const round = x => Math.round(x * 1000) / 1000;
  return { chosen: round(Math.exp(logprobs[i].logprob)), other: other === null ? null : round(other) };
}
const TOP_ALTERNATIVES = 5;
const request = text => ({
  model: deps.model, prompt: promptFor(bare(text)), raw: true, stream: false, format: SCHEMA,
  keep_alive: deps.keepAlive, logprobs: true, top_logprobs: TOP_ALTERNATIVES,
  options: { temperature: 0, num_ctx: deps.numCtx, num_predict: 96, use_mmap: true },   // mmap: see ollama.js USE_MMAP
});
async function ask(text) {
  await door.makeRoomFor(deps.model);   // what may share memory — ollama.makeRoomFor
  const r = await post('/api/generate', request(text), 20000);
  if (!r || r.status !== 200) return null;
  return parseReading(r.body);
}

async function warm(texts) {
  const c = load();
  const tag = await currentTag();
  if (!tag) return 0;                                  // model not installed or ollama down: nothing read
  if (c.tag !== tag) { c.tag = tag; c.readings = Object.create(null); dirty = true; }
  let n = 0;
  for (const t of new Set((Array.isArray(texts) ? texts : [texts]).map(bare).filter(Boolean))) {
    const k = key(t);
    if (!k || k.length > 400 || c.readings[k] !== undefined) continue;
    const s = Date.now();
    const v = await ask(t);
    if (v === null) continue;                          // transport failure: not cached, asked again later
    c.readings[k] = v;
    dirty = true; n++;
    const ms = Date.now() - s;
    if (ms > 800) deps.jlog('Reader › slow read ' + ms + 'ms for "' + t.slice(0, 40) + '"');
  }
  save();
  return n;
}
let onMiss = null;
function readSync(text) {
  const v = load().readings[key(text)];
  if (v !== undefined) return v;
  if (onMiss) onMiss(bare(text));
  return process.env.JARVIS_READER_BLOCKING === '1' ? readBlocking(text) : null;
}
// Run a synchronous reader and collect the sentences it asked about that had not been read yet.
function missesOf(fn) {
  const missed = new Set();
  const outer = onMiss;
  onMiss = t => { if (t) missed.add(t); };
  try { fn(); } catch (e) {} finally { onMiss = outer; }
  return [...missed];
}
// TESTS ONLY. The suites call the synchronous parser hundreds of times with sentences they build as
// they go, so a sentence nobody has read is read on the spot, synchronously, through curl. The live
// server never sets JARVIS_READER_BLOCKING and never waits here: it reads ahead in warm().
function readBlocking(text) {
  const c = load();
  const k = key(text);
  if (!k || k.length > 400) return null;
  try {
    const { spawnSync } = require('child_process');
    if (!modelTag) {
      const show = spawnSync('/usr/bin/curl', ['-s', '-m', '10', '-X', 'POST', 'http://127.0.0.1:11434/api/show',
        '-d', JSON.stringify({ model: deps.model })], { encoding: 'utf8' });
      const info = JSON.parse(show.stdout || 'null');
      if (!info || !info.details) return null;
      modelTag = crypto.createHash('sha256').update(JSON.stringify([info.modified_at || '', info.details || {}, SYSTEM])).digest('hex').slice(0, 12);
      if (c.tag !== modelTag) { c.tag = modelTag; c.readings = Object.create(null); }
    }
    const body = JSON.stringify(request(text));
    const r = spawnSync('/usr/bin/curl', ['-s', '-m', '30', '-X', 'POST', 'http://127.0.0.1:11434/api/generate', '-d', body], { encoding: 'utf8' });
    const v = parseReading(JSON.parse(r.stdout || 'null'));
    if (!v) return null;
    c.readings[k] = v;
    dirty = true; save();
    return v;
  } catch (e) { return null; }
}
// Is the reader model installed and answering? Known once a warm() has asked.
function ready() { return !!modelTag; }
// LOAD IT BEFORE IT IS ASKED. The wake word, the window's typing signal and the start of a turn all
// arrive before the first read; loading then spends the load in the seconds he is still speaking.
// An empty prompt loads the model and generates nothing; num_ctx matches every read, because Ollama
// reloads a model asked for a different context size.
let preloading = null;
function preload() {
  if (preloading) return preloading;
  preloading = door.makeRoomFor(deps.model)
    .then(() => post('/api/generate', { model: deps.model, prompt: '', keep_alive: deps.keepAlive,
                                        options: { num_ctx: deps.numCtx, use_mmap: true } }, 30000))
    .catch(() => null)
    .finally(() => { const t = setTimeout(() => { preloading = null; }, 20000); if (t.unref) t.unref(); });
  return preloading;
}
// TESTS ONLY: hand the cache a reading, so routing can be asserted without the model; and forget every
// reading, so a measurement can time sentences the reader has never seen.
function _remember(text, reading) { load().readings[key(text)] = reading; }
function _forget() { load().readings = Object.create(null); }

// ---------------------------------------------------------------------------
// THE CHECKER
// ---------------------------------------------------------------------------
// The reading must be shaped like a label and copied from the message. Returns an error or null.
const NOTES = new Set(['__conf', '__pol', '__anti', '__ref']);
function shapeError(text, r) {
  if (!r || typeof r !== 'object' || !FIELDS[r.act]) return 'not a reading';
  const [need, may] = FIELDS[r.act];
  // `__conf`, `__pol` and `__anti` are the machine's own notes on the reading (see parseReading), not
  // fields the model wrote. They are enumerable so the gates still apply to a reading reloaded from
  // the cache file — and before they were skipped here, every real reading failed this check as
  // "__conf is not part of open".
  const keys = Object.keys(r).filter(k => k !== 'act' && !NOTES.has(k) && r[k] !== undefined && r[k] !== null && r[k] !== false && r[k] !== '');
  for (const k of need) if (!keys.includes(k)) return 'missing ' + k;
  for (const k of keys) if (!need.includes(k) && !may.includes(k) && !ANY_ACT.includes(k)) return k + ' is not part of ' + r.act;
  const low = String(text).toLowerCase();
  for (const k of keys) {
    const v = r[k];
    if (k === 'business' || k === 'force' || k === 'refers' || k === 'reported' || k === 'video' || k === 'write') { if (v !== true) return k + ' must be true'; continue; }
    if (k === 'steps') {
      if (!Array.isArray(v) || v.length < MULTI_MIN || v.length > MULTI_MAX) return 'steps must be ' + MULTI_MIN + '–' + MULTI_MAX + ' readings';
      for (let i = 0; i < v.length; i++) {
        const st = v[i];
        if (!st || typeof st !== 'object' || st.act === 'multi' || st.act === 'none') return 'step ' + (i + 1) + ' must be a single act';
        if (st.refers) return 'refers belongs on the whole reading';
        const e = shapeError(text, st);
        if (e) return 'step ' + (i + 1) + ': ' + e;
      }
      continue;
    }
    // `when` on an act for LATER needs the round-7 path switched on (server.js laterOn / JARVIS_READER_LATER); off, it is what it was
    // before round 7 — not part of the act (2026-10-16: round 5 under the round-7 table read "look for flight deals to goa in
    // december" as a search for later; before, that reading was refused and the line was answered as it is live).
    if (k === 'when' && WHEN_ACTS.has(r.act) && !(deps.laterOn && deps.laterOn())) return 'when is not part of ' + r.act;
    if (k === 'as') { if (v !== 'site' && v !== 'app') return 'as must be site or app'; continue; }
    if (typeof v !== 'string' || !low.includes(v.toLowerCase())) return k + ' "' + String(v).slice(0, 30) + '" is not in what he said';
  }
  return null;
}

// What does this name resolve to? Registries and shape only.
function resolveThing(words) {
  const ar = deps.actread;
  const w = String(words || '').trim();
  if (!w) return null;
  const toks = ar.tokenize(w);
  if (toks.length === 1 && toks[0].ident) {
    const raw = toks[0].raw;
    if (deps.validUrl(raw)) return { kind: 'url', value: raw };
    const n = deps.normalizeUrl(raw);
    if (deps.validUrl(n)) return { kind: 'url', value: n };
  }
  const anchors = ar.anchorsIn(toks);
  // One word that names nothing exactly may be a typo of one name the machine owns (actread.typoAnchor —
  // edit distance, shape only): "spotfy" → spotify.
  if (!anchors.length && toks.length === 1 && !toks[0].ident) {
    const typo = ar.typoAnchor(toks[0].raw);
    if (typo) return Object.assign(typo, { i: 0, j: 1, raw: toks[0].raw });
  }
  // The whole phrase must be the name, apart from words his own messages say are scaffolding.
  const covered = new Set();
  for (const a of anchors) for (let k = a.i; k < a.j; k++) covered.add(k);
  const rest = toks.filter((t, k) => !covered.has(k) && !ar.isScaffold(t.low));
  if (anchors.length !== 1 || rest.length) return null;
  return anchors[0];
}

// A place he named, resolved against the folders that actually exist under his home directory.
// Every word of it must be a real folder in the chain or scaffolding by his own frequencies.
function resolveWhere(words) {
  const ar = deps.actread;
  const toks = ar.tokenize(words);
  const typed = typedPath(toks);
  if (typed !== undefined) return typed;
  const { dir, used } = walkFolders(toks);
  const unexplained = toks.filter((t, k) => !used.has(k) && !ar.isScaffold(t.low));
  if (unexplained.length || !used.size) return null;
  return dir;
}
// A single path-shaped token is taken as written (null when it is not absolute); undefined otherwise.
function typedPath(toks) {
  if (toks.length !== 1 || !toks[0].ident) return undefined;
  const p = toks[0].raw.replace(/^~(?=\/|$)/, HOME);
  return path.isAbsolute(p) ? path.normalize(p) : null;
}
// Folder names are matched by flattened equality, so "my desktop" finds Desktop and "jarvis_eval"
// finds jarvis_eval. The search walks down: a word matching a child of the current folder moves
// into it, in whatever order he said them ("the jarvis_eval folder on my desktop").
function walkFolders(toks) {
  let dir = HOME;
  const used = new Set();
  let moved = true;
  while (moved) {
    moved = false;
    let kids = [];
    try { kids = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) {}
    const flat = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    for (let k = 0; k < toks.length; k++) {
      if (used.has(k)) continue;
      const hit = kids.find(n => flat(n) === flat(toks[k].raw));
      if (hit) { dir = path.join(dir, hit); used.add(k); moved = true; break; }
    }
  }
  return { dir, used };
}

// WHERE A NEW FILE OR FOLDER GOES WHEN HE DOES NOT SAY. "Create a new folder and label it as JARVIS
// MK two" (2026-09-16) was made in ~/Documents by the agent loop, which picked the place itself, and he
// thought it had never been made. Choosing a place for him is a guess, so the first create that names
// no place ASKS, and his answer — a folder that exists on his disk — is kept and used from then on.
const PLACES_FILE = process.env.JARVIS_PLACES_FILE || 'places.json';
function createPlace() {
  try {
    const saved = deps.store && deps.store.read(PLACES_FILE, null);
    const dir = saved && saved.create;
    return dir && fs.existsSync(dir) ? dir : null;
  } catch (e) { return null; }
}
// HIS ANSWER FOR THIS ONE REQUEST. "desktop", said when asked where "JARVIS MK-2" should go, was kept
// as the place for everything from then on — and he had never agreed to that (2026-09-17). The answer
// now places this request only; keeping it takes his own "always" (placeToOffer, server.js).
const placedOnce = new Map();
function placeOnce(text, dir) { placedOnce.set(key(text), { dir, at: Date.now() }); }
function oncePlace(text) {
  const p = placedOnce.get(key(text));
  return p && Date.now() - p.at < ANSWER_TTL_MS && fs.existsSync(p.dir) ? p.dir : null;
}
// After a create went through: the place worth OFFERING to keep — the one he just answered with, or one
// he named that is not the place kept now. A place he names always wins over the kept one; this only
// asks whether the kept one should change.
function placeToOffer(text, action) {
  if (!action || (action.type !== 'create_folder' && action.type !== 'create_file') || !action.path) return null;
  const dir = path.dirname(action.path);
  const kept = createPlace();
  if (kept === dir) return null;
  if (oncePlace(text) === dir) return dir;
  const r = readSync(text);
  return kept && r && r.where ? dir : null;
}
function setCreatePlace(dir, said) {
  if (!deps.store || !dir) return false;
  try { deps.store.write(PLACES_FILE, { create: dir, said: String(said || ''), at: Date.now() }); return true; } catch (e) { return false; }
}
// The folder named by his answer to "where should it go?". Unlike resolveWhere, other words may sit
// around it ("put it on the desktop please") because the question already asked for a place — but it
// has to name at least one folder that exists, and a typed path is taken as written if it is a folder.
function placeIn(reply) {
  const toks = deps.actread.tokenize(String(reply || ''));
  const typed = typedPath(toks);
  if (typed !== undefined) {
    try { return typed && fs.statSync(typed).isDirectory() ? typed : null; } catch (e) { return null; }
  }
  const { dir, used } = walkFolders(toks);
  return used.size ? dir : null;
}

// A file or folder named by his words, placed where he said. A thing that is itself a real folder
// ("list my downloads") resolves as one; a new name is placed in his home folder unless he said where.
function pathFor(name, where, existing) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (/^[~/]/.test(n)) return path.normalize(n.replace(/^~(?=\/|$)/, HOME));
  if (where) {
    const dir = resolveWhere(where);
    return dir ? path.join(dir, n) : null;
  }
  if (existing) {
    const asFolder = resolveWhere(n);
    if (asFolder) return asFolder;
  }
  return path.join(HOME, n);
}

// ---------------------------------------------------------------------------
// WHICH WAY ROUND — open or close, create or delete.
// ---------------------------------------------------------------------------
// The reading already says which half the model chose; the question is whether that can be trusted.
// There is no verb table any more (verblex.js): a table keyed by the verb cannot see the object, and
// "spin up" read as an open even in "spin up a folder called experiments". What is consulted, in order:
//   1. HIS ANSWER — given to this very sentence moments ago (allowOnce), or kept for the words of
//      this request in this pair (verblex; his data, nothing anyone wrote down in advance);
//   2. THE MODEL'S OWN CERTAINTY about the half it chose — the probability it gave the act at the
//      token where the halves part, and the best alternative there that starts the other half, when
//      Ollama lists alternatives (parseReading keeps both on the reading);
//   3. a reading the model did not write (a label, a test fixture) is taken as written.
//   'agree'   act as read
//   'oppose'  he has said these words mean the other half: do that instead, or say it cannot be done
//   'unknown' ask him, and keep the answer
const OPPOSITE = { open_app: 'close_app', close_app: 'open_app', create: 'delete', delete: 'create' };
const PAIR = { open_app: 'app', close_app: 'app', create: 'file', delete: 'file' };
// SWEPT 2026-09-17. 46 readings in the Ollama runs (held-out sets and the exam) chose a half of a pair,
// none of them the wrong half, and in 45 the other half got at most 0.04 — when the model was less sure
// of "open" the rest went to OTHER acts (none, search), not to "close". The exception, "bin
// notes_backup.txt", read correctly as a delete at 0.704 with create at 0.185. So a high minimum on the
// act token only repeats the confidence gate: at 0.9 it asked "open or close?" about "open system
// settings" (0.77 / 0.001), "yes but open textedit first" (0.862 / 0.001) and "open the app store for
// me" (0.899 / 0) in sweep_actread's sets. What marks polarity confusion is the other half close
// behind, which is the margin:
//
//     min / margin      right half asked   wrong half acted     (46 held-out + exam, 9 sweep)
//     0.5 / 0.5              0                  0
//     0.9 / 0.8              2 + 3              0
//
// A reading that is unsure overall is asked about anyway (ASK_FLOOR…MIN_CONFIDENCE), naming the action.
const POLARITY_MIN = Number(process.env.JARVIS_READER_POLARITY_MIN) || 0.5;
const POLARITY_MARGIN = Number(process.env.JARVIS_READER_POLARITY_MARGIN) || 0.5;
function direction(text, kind, r) {
  const said = answered.get(key(text));
  if (said && Date.now() - said.at < ANSWER_TTL_MS) {
    if (said.kind === kind) return 'agree';
    if (said.kind === OPPOSITE[kind]) return 'oppose';
  }
  const words = requestWords(text, r);
  const taught = words && deps.verblex ? deps.verblex.kindOfSync(words, PAIR[kind]) : null;
  if (taught === kind) return 'agree';
  if (taught === OPPOSITE[kind]) return 'oppose';
  return modelDirection(r);
}
// The model's own say on which half: sure enough of the half it wrote, and the other half far enough
// behind. A reading the model did not write (a label, a test fixture) is taken as written.
function modelDirection(r) {
  if (!r || typeof r.__conf !== 'number') return 'agree';
  if (typeof r.__pol !== 'number' || r.__pol < POLARITY_MIN) return 'unknown';
  if (typeof r.__anti === 'number' && r.__pol - r.__anti < POLARITY_MARGIN) return 'unknown';
  return 'agree';
}
// HIS WORDS FOR THE REQUEST: the sentence less the values the reading copied out of it, less the
// words his own messages say are scaffolding. "chuck on netflix" → "chuck on", "bin notes_backup.txt"
// → "bin", "spin up a folder called experiments" → "spin up folder called". His answer is kept under
// these — his words — so it applies again when he says the same thing about something else.
const VALUE_FIELDS = ['thing', 'query', 'where', 'browser', 'name', 'content', 'topic', 'to', 'body', 'what', 'when'];
function requestWords(text, r) {
  const ar = deps.actread;
  const toks = ar.tokenize(text);
  const covered = new Set();
  for (const f of VALUE_FIELDS) {
    const v = r && r[f];
    if (typeof v !== 'string' || !v.trim()) continue;
    const want = ar.tokenize(v).map(t => t.low);
    for (let i = 0; want.length && i + want.length <= toks.length; i++) {
      if (want.every((w, k) => toks[i + k].low === w)) { for (let k = 0; k < want.length; k++) covered.add(i + k); break; }
    }
  }
  return toks.filter((t, i) => !covered.has(i) && !t.ident && !ar.isScaffold(t.low)).map(t => t.low).join(' ');
}
function unusedIdent(text, r) {
  const src = r && Array.isArray(r.steps) ? r.steps : [r];
  const values = [].concat(...src.map(x => VALUE_FIELDS.map(f => x[f]))).filter(v => typeof v === 'string').map(v => v.toLowerCase());
  for (const t of deps.actread.tokenize(text)) {
    if ((t.ident || /\d/.test(t.low)) && !values.some(v => v.includes(t.low))) return t.raw;
  }
  return null;
}
// The same reading the other way round, for when he has said his words meant the other half. A site
// has no process to quit, and a delete does not say whether the new thing is a file or a folder, so
// those cannot be turned.
function turned(r) {
  if (!r) return null;
  if (r.act === 'open') return { act: 'close', thing: r.thing };
  if (r.act === 'close') return { act: 'open', thing: r.thing };
  if (r.act === 'create_folder' || r.act === 'create_file') {
    return Object.assign({ act: 'delete', thing: r.name }, r.where ? { where: r.where } : {});
  }
  return null;
}

// ---------------------------------------------------------------------------
// BUILD — a reading into an action, or a question, or nothing.
// ---------------------------------------------------------------------------
// Actions this checker built. The router's older plausibility test (weakAction) was written for a
// word-matching parser's partial matches; a checked reading has already had every name resolved, and
// "open the app called zzqqxx" must reach the honest "there is no app by that name".
const builtHere = new WeakSet();
function checked(a) { return !!(a && typeof a === 'object' && builtHere.has(a)); }
// NOT SURE ENOUGH TO ACT, SURE ENOUGH TO ASK. A reading whose least likely token sits between ASK_FLOOR
// and MIN_CONFIDENCE is put to him as a question naming what it would do ("Should I open Hugging Face,
// Sir?"), and his yes is kept for that sentence and that action — so it is asked once. Below the floor
// the reading is treated as unread. Measured 2026-09-17 on the same rows as MIN_CONFIDENCE, with the
// exam (his 218 newest messages) read once:
//
//     floor   questions: exam   clean   patterns   his ordinary messages
//     0.2           9 / 218     1 / 50   13 / 86        2 / 118
//     0.3           9 / 218     1 / 50   11 / 86        2 / 118
//     0.4           9 / 218     1 / 50   11 / 86        2 / 118
//
// On the exam 8 of the 9 were right readings that the 0.7 gate would otherwise drop ("open hugging
// face" read at 0.44 fell to the agent loop); the ninth, "open his youtube channel", becomes a question
// instead of a wrong open. The readings that are wrong in the band are partial ones, and the question
// shows what is missing ("Should I quit Adobe Premiere Pro?" for a force quit); a file he named and the
// reading left out is refused before any question (unusedIdent).
const ASK_FLOOR = Number(process.env.JARVIS_READER_ASK_FLOOR) || 0.3;

// NO-TRAINING FIXES 1 + 2 (2026-10-17, finetune/README "No-training fixes 1 + 2"), each behind a switch that is OFF by default.
// FIX 1 — ONE QUESTION, NOT TWO. A message, a call and a quit each show their own card before anything happens ("Send this to …?", the
// call offer, "Quit …? Please confirm"), so the reader does not ask about them first. (Fix 1's other half, a bar per tier of act, was
// measured on round 8's READ sets and kept at 0.70: between 0.3 and 0.7 about half of the low-stakes readings are wrong.)
const tiersOn = () => String(process.env.JARVIS_READER_TIERS || '').trim() === '1';
const CONFIRMING = new Set(['message', 'call', 'close']);
// FIX 2 — ONE BAD FIELD IS REPAIRED OR ASKED ABOUT, NOT THE WHOLE READING THROWN AWAY. JARVIS's own act names and the reading's own
// fields, and positions in his text — no word of his is tested.
const repairOn = () => String(process.env.JARVIS_READER_REPAIR || '').trim() === '1';
// Acts whose doing can only show a wrong answer — nothing on the Mac changes and nothing he named can be lost.
const READ_ONLY = new Set(['time', 'weather', 'calendar', 'system_status', 'list_running', 'search_web', 'search_files', 'read', 'list',
  'study_stats', 'dream_log']);
// The field of an act that holds his free words — where LABELING puts a time said inside a message or a search.
const FREE_TEXT = { message: 'body', search_web: 'query', note: 'content' };
// Fields an identifier he typed next to them may belong to.
const EXTENDABLE = ['query', 'body', 'content', 'what', 'topic', 'name', 'thing'];
const between = (s, a, b) => (a <= b ? s.slice(a, b) : null);
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// The one span of his words a not-quite-copied value is closest to: word-aligned, same word count ± 1, character similarity ≥ 0.8,
// and no other span as close. Returns his own words for it, or null.
function nearestSpan(text, v) {
  // His words by JARVIS's own tokenizer (actread), each found in order in his text for its place.
  const src = String(text), lowSrc = src.toLowerCase(), words = [];
  let at = 0;
  for (const t of deps.actread.tokenize(src)) {
    const i = lowSrc.indexOf(String(t.low), at);
    if (i < 0) continue;
    words.push({ w: src.slice(i, i + String(t.low).length), at: i }); at = i + String(t.low).length;
  }
  const n = Math.max(1, deps.actread.tokenize(String(v)).length), low = String(v).toLowerCase();
  let best = null, second = -1;
  for (let len = Math.max(1, n - 1); len <= n + 1; len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const span = String(text).slice(words[i].at, words[i + len - 1].at + words[i + len - 1].w.length);
      const s = 1 - editDistance(span.toLowerCase(), low) / Math.max(span.length, low.length, 1);
      if (!best || s > best.s) { if (best) second = Math.max(second, best.s); best = { s, span }; } else second = Math.max(second, s);
    }
  }
  return best && best.s >= 0.8 && best.s - second > 0.01 ? best.span : null;
}
// A reading the checker would refuse for ONE field, repaired — or null when no repair applies (it is then refused as before).
//   { reading }                      the repaired reading, to be checked again in full
//   { reading, cannotLater: words }  the `when` dropped — he is ASKED before it runs (never run silently, never scheduled)
//   { reading, skipIdent: true }     a read-only act may stand without the identifier it left out
function repaired(text, r) {
  if (!r || !FIELDS[r.act] || r.act === 'multi' || r.act === 'none') return null;
  const src = String(text), low = src.toLowerCase();
  const err = shapeError(src, r);
  const ok = (x, skipIdent) => !shapeError(src, x) && (skipIdent || !unusedIdent(src, x));
  const copy = x => { const o = {}; for (const k of Object.keys(x)) o[k] = x[k]; for (const k of NOTES) if (k in x) Object.defineProperty(o, k, { value: x[k], enumerable: true }); return o; };
  // A `when` it cannot take — the act has no `when` (FIELDS), or it is a later-act while later is off — joined back onto his free
  // words when they run straight on, otherwise dropped and asked about. Decided from the reading's fields, not the checker's message.
  const [need, may] = FIELDS[r.act];
  const whenTaken = need.includes('when') || (may.includes('when') && !(WHEN_ACTS.has(r.act) && !(deps.laterOn && deps.laterOn())));
  if (err && typeof r.when === 'string' && r.when.trim() && !whenTaken) {
    const f = FREE_TEXT[r.act], w = r.when.trim();
    if (f && typeof r[f] === 'string' && r[f].trim()) {
      const v = r[f].trim(), i = low.indexOf(v.toLowerCase()), j = i < 0 ? -1 : low.indexOf(w.toLowerCase(), i + v.length);
      const gap = i < 0 || j < 0 ? null : between(src, i + v.length, j);
      if (gap !== null && !gap.trim()) {
        const x = copy(r); delete x.when; x[f] = src.slice(i, j + w.length);
        if (ok(x)) { deps.jlog('Reader › repaired "' + src.slice(0, 40) + '": “' + w + '” belongs to the ' + f); return { reading: x }; }
      }
    }
    // Dropped: the time words leave with it, so the identifier check runs on his text without them (the digits of "at 6" are the
    // time, not something the reading left out) — and is not run again on the whole text (skipIdent).
    const x = copy(r); delete x.when;
    const iw = low.indexOf(w.toLowerCase()), rest = iw < 0 ? src : src.slice(0, iw) + ' ' + src.slice(iw + w.length);
    if (!shapeError(src, x) && !unusedIdent(rest, x)) {
      deps.jlog('Reader › "' + src.slice(0, 40) + '": cannot do it “' + w + '” — asking about doing it now');
      return { reading: x, cannotLater: w, skipIdent: true };
    }
    return null;
  }
  // A value not quite copied: his own words for it, when exactly one span of them is that close. (Which field: the first string value
  // that is not in his words — read off the reading, not the checker's message.)
  const k = err ? Object.keys(r).find(f => typeof r[f] === 'string' && f !== 'as' && f !== 'act' && !NOTES.has(f) && !low.includes(r[f].toLowerCase())) : null;
  if (k) {
    const span = nearestSpan(src, r[k]);
    if (span) {
      const x = copy(r); x[k] = span;
      if (ok(x)) { deps.jlog('Reader › repaired "' + src.slice(0, 40) + '": ' + k + ' “' + r[k] + '” → his “' + span + '”'); return { reading: x }; }
    }
    return null;
  }
  if (err) return null;
  // An identifier he typed and the reading left out: part of the free words it sits next to, or — for a read-only act — let stand.
  const missed = unusedIdent(src, r);
  if (!missed) return null;
  const at = low.indexOf(String(missed).toLowerCase());
  for (const f of EXTENDABLE) {
    if (typeof r[f] !== 'string' || !r[f].trim() || at < 0) continue;
    const v = r[f].trim(), i = low.indexOf(v.toLowerCase());
    if (i < 0) continue;
    const after = between(src, i + v.length, at), before = between(src, at + String(missed).length, i);
    const x = copy(r);
    if (after !== null && !after.trim()) x[f] = src.slice(i, at + String(missed).length);
    else if (before !== null && !before.trim()) x[f] = src.slice(at, i + v.length);
    else continue;
    if (ok(x)) { deps.jlog('Reader › repaired "' + src.slice(0, 40) + '": “' + missed + '” belongs to the ' + f); return { reading: x }; }
  }
  if (READ_ONLY.has(r.act)) { deps.jlog('Reader › "' + src.slice(0, 40) + '": read-only ' + r.act + ' stands without “' + missed + '”'); return { reading: r, skipIdent: true }; }
  return null;
}
const CONFIRMED_FILE = process.env.JARVIS_READER_CONFIRMED_FILE || 'readmodel.confirmed.json';
const signature = a => JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]]));
let confirmedCache = null;
function confirmedAll() {
  if (confirmedCache) return confirmedCache;
  confirmedCache = Object.create(null);
  try {
    const saved = deps.store && deps.store.read(CONFIRMED_FILE, null);
    if (saved && saved.confirmed) Object.assign(confirmedCache, saved.confirmed);
  } catch (e) {}
  return confirmedCache;
}
function isConfirmed(text, action) { return confirmedAll()[key(text)] === signature(action); }
// His yes, kept: this sentence, this exact action. A later model that reads the sentence differently
// builds a different action, and is asked about again.
function confirm(text, action) {
  if (!action || !key(text)) return false;
  confirmedAll()[key(text)] = signature(action);
  try { if (deps.store) deps.store.write(CONFIRMED_FILE, { confirmed: confirmedAll(), at: Date.now() }); } catch (e) {}
  return true;
}
function build(text, r) {
  const conf = r && typeof r.__conf === 'number' ? r.__conf : null;
  if (conf !== null && conf < ASK_FLOOR) {
    if (r.act !== 'none') deps.jlog('Reader › unsure (' + conf + ') about "' + String(text).slice(0, 40) + '" — not acting on it');
    return null;
  }
  // FIX 2 (switch JARVIS_READER_REPAIR): one bad field repaired, or the `when` dropped and asked about — see repaired().
  const rep = repairOn() ? repaired(text, r) : null;
  if (rep) r = rep.reading;
  const out = buildInner(text, r, rep && rep.skipIdent ? { skipIdent: true } : null);
  if (rep && rep.cannotLater && out && out.action) {
    builtHere.add(out.action);
    return { ask: { kind: 'confirm', text: String(text), action: out.action, conf, cannotLater: rep.cannotLater } };
  }
  // A TIME FOR LATER rides on the action it belongs to (round 7) as `later`: the server schedules an action that carries it instead
  // of running it. Only on the acts the reader may give one (FIELDS). NOT under `when` (2026-10-16 gate, found before it went live):
  // remind / calendar / weather already carry their OWN `when` ("which time / day"), and the server could not tell the two apart —
  // every timed reminder was sent to the scheduler ("remind me to submit the assignment at 9" → "Scheduled for 2:05 AM").
  if (out && r && typeof r.when === 'string' && r.when.trim() && WHEN_ACTS.has(r.act)) {
    for (const a of [out.action, out.ask && out.ask.action]) if (a && typeof a === 'object') a.later = r.when.trim();
  }
  // FIX 1 (switch JARVIS_READER_TIERS): a message, call or quit goes straight to its own card — one question, not two.
  const ownCard = tiersOn() && r && CONFIRMING.has(r.act);
  if (out && out.action && conf !== null && conf < MIN_CONFIDENCE && !ownCard && !isConfirmed(text, out.action)) {
    builtHere.add(out.action);
    return { ask: { kind: 'confirm', text: String(text), action: out.action, conf } };
  }
  if (out && out.action) builtHere.add(out.action);
  // An action waiting on his answer was built by this checker too.
  if (out && out.ask && out.ask.action && typeof out.ask.action === 'object') builtHere.add(out.ask.action);
  return out;
}
function buildInner(text, r, opts) {
  if (!r) return null;
  if (r.act === 'none') return null;
  const err = shapeError(text, r);
  if (err) { deps.jlog('Reader › refused "' + String(text).slice(0, 40) + '": ' + err); return null; }
  // (fix 2: a read-only act repaired() let stand without an identifier it left out skips the next check — nothing it does can lose it)
  // EVERYTHING HE NAMED BY ITS SHAPE IS IN THE READING. A file, path or address he typed — or a number —
  // that no value of the reading uses means the reading is of something else. Measured: "toss
  // invoice_copy.png in the trash" came back as empty_trash at confidence 1.00 (held-out patterns),
  // "make d.txt with delta and e.txt with epsilon…" as the first file alone (held-out), and "move mark 2
  // to the bin" as empty_trash at 0.873 (sweep_his.js, all his messages). Of 923 hand-labelled actions
  // (his, synthetic, held-out) not one has a number or an identifier outside its values, so the rule
  // refuses nothing that was right. Shape only — actread's identifier test, and digits.
  const missed = opts && opts.skipIdent ? null : unusedIdent(text, r);
  if (missed) { deps.jlog('Reader › refused "' + String(text).slice(0, 40) + '": it leaves out "' + missed + '"'); return null; }

  if (r.act === 'system_status' || r.act === 'screenshot' || r.act === 'list_running' ||
      r.act === 'empty_trash' || r.act === 'sleep_display') return { action: { type: r.act } };

  // DREAM MODE — JARVIS's own idle work (dream.js). The log and "run it now" carry nothing to resolve.
  // The setting is a polarity pair like open/close: the half the model wrote stands only when its own
  // probabilities are sure of it; otherwise which way is not guessed — he is told the state it is in
  // and offered the other one (server.js, askAboutReading 'dream-setting').
  if (r.act === 'dream_log' || r.act === 'dream_now') return { action: { type: r.act } };
  // THE TUTOR (tutor.js) — a quiz now (on a subject, if he named one), the stats, or a subject put on or
  // taken off his list. The subject has already been checked to be his own words (shapeError).
  if (r.act === 'quiz_me') return { action: Object.assign({ type: 'quiz_me' }, r.topic ? { topic: String(r.topic).trim() } : {}) };
  if (r.act === 'study_stats') return { action: { type: 'study_stats' } };
  if (r.act === 'learn_topic' || r.act === 'stop_topic') return { action: { type: r.act, topic: String(r.topic).trim() } };
  if (r.act === 'dream_on' || r.act === 'dream_off') {
    if (modelDirection(r) === 'agree') return { action: { type: 'dream_set', enabled: r.act === 'dream_on' } };
    return { ask: { kind: 'dream-setting', text: String(text) } };
  }

  if (r.act === 'open' || r.act === 'close') {
    const kind = r.act === 'open' ? 'open_app' : 'close_app';
    // Whose account: the business profile, only for a social site that has one.
    if (r.act === 'open' && r.business) {
      const t = resolveThing(r.thing);
      if (t && t.kind === 'site' && (deps.socialKeys() || []).includes(t.value)) {
        return gate(text, kind, r, { type: 'open_social', target: t.value });
      }
      const site = deps.businessSite && deps.businessSite();
      if (site) return gate(text, kind, r, { type: 'open_url', target: site });
      return null;
    }
    const t = resolveThing(r.thing);
    const name = String(r.thing).trim();
    // One of JARVIS's own panels (actread.panelFor): shown or hidden in his window, nothing on the Mac.
    if (t && t.kind === 'panel') return gate(text, kind, r, { type: r.act === 'open' ? 'open_panel' : 'close_panel', target: t.value });
    if (r.act === 'close') {
      if (!t) return gate(text, kind, r, { type: 'close_app', name, target: name, force: !!r.force });
      // `known`: a name JARVIS's own registry recognises (an installed app, a browser, or a site the registry says has a Mac app —
      // Spotify, Discord) keeps its quit card even when the app is not in the folders system_control reads (2026-10-17 gate).
      if (t.kind === 'app' || t.kind === 'browser' || (t.kind === 'site' && t.app)) {
        return gate(text, kind, r, { type: 'close_app', name, target: name, force: !!r.force, known: true });
      }
      return null;
    }
    const browser = r.browser ? deps.browserName(r.browser) : null;
    if (r.browser && !browser) return null;
    if (!t) {
      // A name no registry knows. He said it was an app: say honestly that there is none by that name.
      if (r.as === 'app') return gate(text, kind, r, { type: 'open_app', name, target: name });
      // One of his real folders ("open downloads" → ~/Downloads): resolveWhere, every word a real folder in
      // the chain or scaffolding. Only after no app, site, panel or workflow claimed the name.
      const dir = resolveWhere(name);
      if (dir) return gate(text, kind, r, { type: 'open_folder', path: dir, target: name });
      return null;
    }
    if (t.kind === 'url') return gate(text, kind, r, Object.assign({ type: 'open_url', target: t.value }, browser ? { browser } : {}));
    if (t.kind === 'workflow') return gate(text, kind, r, { type: 'run_workflow', target: t.value });
    if (t.kind === 'ambiguous') return { ask: { kind: 'which-site', text: String(text), said: name, options: t.value } };
    if (t.kind === 'site') {
      if (r.as === 'app') return gate(text, kind, r, { type: 'open_app', name, target: name });
      return gate(text, kind, r, Object.assign({ type: 'open_site', target: t.value, preferSite: r.as === 'site' }, browser ? { browser } : {}));
    }
    // A typo match (actread.typoAnchor) hands on the app's real name — "discrod" means nothing to open_app.
    const appName = t.typo && t.kind === 'app' ? t.value : name;
    return gate(text, kind, r, { type: 'open_app', name: appName, target: appName });
  }

  if (r.act === 'search_web' || r.act === 'play') {
    const q = String(r.query).trim();
    let site = null, browser = null;
    if (r.browser) { browser = deps.browserName(r.browser); if (!browser) return null; }
    if (r.where) {
      const w = resolveThing(r.where);
      if (!w) return null;                                  // a place no registry knows: not ours to guess
      if (w.kind === 'site') site = w.value;
      else if (w.kind === 'browser' && !browser) browser = w.value;
      else return null;                                     // an app's own search belongs to the agent
    }
    // THE READER'S PLAY IS PLAYED WITH THE READER'S QUERY (2026-09-28). Before this, a bare "play X" returned
    // null and the old media lanes re-read the sentence with stripNoise word lists — "yo throw on some drake"
    // became a question about "yo", "play lofi beats plz" a tie between procedures, "arijit ke gaane laga do"
    // nothing (casual stress set: music 4/23). Now a play with no place, or on Spotify or YouTube, is one
    // action carrying the query he said; server.js picks the player (video → YouTube, Spotify named →
    // Spotify, otherwise the arbiter's music/video read of the query). Other places keep the old path.
    if (r.act === 'play' && !browser && (!site || site === 'youtube' || site === 'spotify')) {
      return { action: Object.assign({ type: 'reader_play', query: q }, site ? { where: site } : {},
        (r.video || site === 'youtube') ? { video: true } : {}) };
    }
    if (r.act === 'play' && !site) return null;
    const out = { type: 'search_web', target: q };
    if (site) out.site = site;
    if (browser) out.browser = browser;
    // Marked, because to the action lane this is only a search on the site: the router lets the
    // procedures that actually PLAY something (the YouTube and Spotify ones) try it first.
    if (r.act === 'play') out.play = true;
    if (r.act === 'play' && r.video) out.video = true;
    return { action: out };
  }

  // ROUND 3 — messages, calls, reminders, the calendar, notes, the weather and the player. Each becomes one
  // action carrying his own words; server.js resolves the person (Contacts, then WhatsApp) and every send
  // still goes through the confirm card, where he sees the exact text first.
  if (r.act === 'message') {
    return { action: Object.assign({ type: 'reader_message', to: String(r.to).trim() },
      r.body ? { body: String(r.body).trim() } : {}, r.where ? { where: String(r.where).trim() } : {},
      r.reported ? { reported: true } : {}) };
  }
  if (r.act === 'call') {
    return { action: Object.assign({ type: 'reader_call', to: String(r.to).trim() },
      r.where ? { where: String(r.where).trim() } : {}, r.video ? { video: true } : {}) };
  }
  if (r.act === 'remind') {
    return { action: Object.assign({ type: 'reader_remind' }, r.what ? { what: String(r.what).trim() } : {},
      r.when ? { when: String(r.when).trim() } : {}) };
  }
  if (r.act === 'calendar') return { action: Object.assign({ type: 'reader_calendar' }, r.when ? { when: String(r.when).trim() } : {}) };
  if (r.act === 'note') return { action: Object.assign({ type: 'reader_note', content: String(r.content).trim() }, r.write ? { write: true } : {}) };
  // ROUND 4 — several independent requests. Each step is built exactly as if it had been said alone (same
  // checker, same registries, same gates). All or nothing: if any step would not act, or needs a question
  // first, none of it acts here — the message goes on to the old lanes, exactly as an unread one did.
  // ROUND 4 — several independent requests. The reader SPLITS; it does not act. Each step goes back through
  // the router as a clause of its own (server.js, clause routing — the same executor the old splitter fed),
  // where it is read, gated, confirmed and run exactly as if he had said it alone. Every step's values have
  // already been checked against his message (shapeError); everything he named by shape must be used by
  // SOME step (unusedIdent, across all of them).
  if (r.act === 'multi') {
    const missedAll = unusedIdent(text, r);
    if (missedAll) { deps.jlog('Reader › refused multi "' + String(text).slice(0, 40) + '": it leaves out "' + missedAll + '"'); return null; }
    const steps = r.steps.map(st => { const o = {}; for (const k of Object.keys(st)) if (!NOTES.has(k)) o[k] = st[k]; return o; });
    return { action: { type: 'reader_multi', steps } };
  }
  // ROUND 6/7: what the clock says, here or in the place he named — answered by clock.js from the Mac's clock.
  if (r.act === 'time') return { action: Object.assign({ type: 'reader_time' }, r.where ? { where: String(r.where).trim() } : {}) };
  if (r.act === 'weather') {
    return { action: Object.assign({ type: 'reader_weather' }, r.where ? { where: String(r.where).trim() } : {},
      r.when ? { when: String(r.when).trim() } : {}) };
  }
  if (r.act === 'pause' || r.act === 'resume' || r.act === 'next_track' || r.act === 'volume_up' || r.act === 'volume_down') {
    return { action: { type: 'reader_player', control: r.act } };
  }

  if (r.act === 'search_files') return { action: { type: 'search', name: String(r.query).trim() } };

  if (r.act === 'create_folder' || r.act === 'create_file') {
    const name = String(r.name).trim();
    const unplaced = !r.where && !/^[~/]/.test(name);
    const dir = unplaced ? (oncePlace(text) || createPlace()) : null;
    const p = unplaced ? path.join(dir || HOME, name) : pathFor(r.name, r.where, false);
    if (!p) return null;
    const content = r.content ? String(r.content).trim() : '';
    const action = r.act === 'create_folder'
      ? { type: 'create_folder', path: p }
      : Object.assign({ type: 'create_file', path: p }, content ? { content } : {});
    // The verb is settled first: a create he has not asked for needs no place.
    const g = gate(text, 'create', r, action);
    if (g.action && unplaced && !dir) return { ask: { kind: 'which-place', text: String(text), said: name, act: r.act } };
    return g;
  }
  if (r.act === 'delete' || r.act === 'read' || r.act === 'list' || r.act === 'append') {
    const p = pathFor(r.thing, r.where, true);
    if (!p) return null;
    if (r.act === 'delete') {
      // Nothing there: the words were a referent or a name he misremembered. Ask which, never guess
      // at something to delete.
      if (!fs.existsSync(p)) return { ask: { kind: 'which-file', text: String(text), said: r.thing } };
      return gate(text, 'delete', r, { type: 'delete', path: p });
    }
    if (r.act === 'read') return { action: { type: 'read', path: p } };
    if (r.act === 'list') return { action: { type: 'list', path: p } };
    return { action: { type: 'append', path: p, content: String(r.content).trim() } };
  }
  return null;
}

// THE ANTONYM GATE. An action of a paired kind passes when direction() agrees. Quitting an app and
// deleting a file already ask him to confirm, naming the app or the path, so an uncertain reading of
// those is settled by that confirmation rather than by a second question. When his own answer says
// the other half, that is what is done — the reading turned round and checked again from the top —
// and when it cannot be turned round he is told so, rather than asked a question whose answer he has
// already given.
const CONFIRMED_BY_RUNACTION = new Set(['close_app', 'delete']);
// HIS ANSWER, FOR THIS ONE REQUEST. When he answers and the answer cannot be kept under his words (no
// words were left once the values were taken out), the replayed request must not ask again. Kept for
// this sentence only, briefly: build() runs several times while one request is routed, so it is not
// consumed on first use.
const ANSWER_TTL_MS = 60000;
const answered = new Map();
function allowOnce(text, kind) { answered.set(key(text), { kind, at: Date.now() }); }
function gate(text, kind, r, action) {
  const d = direction(text, kind, r);
  if (d === 'agree') return { action };
  if (d === 'oppose') {
    const other = turned(r);
    const out = other ? buildInner(text, other) : null;
    if (out) return out;
    return { ask: { kind: 'no-turn', text: String(text), action, verbKind: kind, opposite: OPPOSITE[kind] } };
  }
  if (CONFIRMED_BY_RUNACTION.has(kind)) return { action };
  return { ask: { kind: 'direction', text: String(text), action, verbKind: kind, opposite: OPPOSITE[kind],
                  verb: requestWords(text, r) } };
}

module.exports = { init, warm, readSync, missesOf, ready, preload, build, confirm, isConfirmed, ASK_FLOOR, checked, shapeError, confidenceOf, MIN_CONFIDENCE, resolveThing, resolveWhere, pathFor, direction,
  requestWords, turned, POLARITY_MIN, POLARITY_MARGIN, promptFor, SCHEMA, ACTS, FIELDS, SYSTEM, createPlace, setCreatePlace, placeIn, placeOnce, placeToOffer, allowOnce,
  _cacheFile: CACHE_FILE, _placesFile: PLACES_FILE, _confirmedFile: CONFIRMED_FILE, _remember, _forget, _parse: parseReading, _request: text => request(text), _repaired: (t, r) => repaired(t, r), _nearestSpan: nearestSpan };
