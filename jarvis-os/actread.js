'use strict';
// ---------------------------------------------------------------------------
// WHAT DOES THIS SENTENCE ASK THE MACHINE TO DO? — the open / close / system half of the parser.
//
// WHAT THIS REPLACES. quickActionCore's lanes 0, 5 and 7 and the retry loop around it:
//   OPEN_VERB, the courtesy and determiner strips in cleanTarget and stripTail, SOCIAL_WORDS, the
//   instagram|insta|ig|… token regex, BUSINESS_SOCIAL_RE, the site|website|web|page|online and
//   app|application regexes, the TLD list, the force|kill test, the "can you|please" lead strip, and
//   CMD_START_RE — every one a list of words someone expected him to use.
//
// WHAT DOES THE WORK — six readers, and not one of them is a list of his words.
//
//   SHAPE      tokens, and the tokens that are URLs, hostnames or paths by their form.
//   REGISTRIES what the machine owns: config/sites.json and its aliases, the browsers it can drive,
//              the applications installed on this Mac, his saved workflows.
//   VERBS      verblex.js — HIS ANSWERS about which of open / close his words meant. It used to ship
//              a seed of verb phrases; that was a keyword table and was removed on 2026-09-17 (see
//              verblex.js). Embeddings cannot tell the halves apart either (re-measured 2026-09-16,
//              nomic: "unhide" read as CLOSE -0.067, "put down" as DELETE -0.156), so this fallback
//              reader only knows the verbs he has taught, and declines on anything else — the reader
//              model (readmodel.js) is what reads polarity now.
//   HIS WORDS  document frequency over his own distinct messages (errand.js's lexicon). A word in
//              a large share of everything he types is scaffolding, whatever it is.
//   REGIONS    embedders: which system action a sentence names; whether it names the business's
//              account rather than the site; what role a leftover word plays.
//   HIS ANSWERS what he said when asked, kept permanently. They outrank every reader above.
//
// THE RULE THAT MAKES IT SAFE: A READING MUST ACCOUNT FOR THE WHOLE REQUEST. After the verb and the
// thing it names are found, every word he typed after the first of them has to be explained —
// scaffolding by his own frequencies, or a role a reader is confident about, or a role he taught.
// One unexplained word means the reading is incomplete, and an incomplete reading is either asked
// about or left for the lanes that can do more ("open my youtube subscriptions" is not "open
// youtube"). Words BEFORE the verb and the thing are the preamble; the statement and question gates
// in front of this reader decide whether the sentence is an instruction at all.
//
// THE SYNCHRONOUS CONTRACT, same as errand.js: quickAction is sync with many sync callers, so every
// embedder verdict is computed ahead of time by warm() and read back from a cache. A verdict nobody
// has computed is null, and null never produces an action.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const intent = require('./intent.js');
const verblex = require('./verblex.js');

const HOME = process.env.HOME || '';
const deps = {
  jlog: () => {},
  store: null,
  siteKey: () => null,          // (phrase) -> site key | null
  siteKeys: () => [],           // () -> every canonical site key in the registry
  siteApp: () => null,          // (site key) -> the Mac app the registry says it has, or null
  browserName: () => null,      // (phrase) -> canonical browser | null
  workflows: () => [],          // () -> [{ name }]
  socialKeys: () => [],         // () -> site keys that have a business profile configured
  companyNames: () => [],       // () -> names from his profile that are his organisation
  panels: () => [],             // () -> JARVIS's own panels [{ name, id }] — the World Monitor, the neural network
  df: () => 0,                  // (word) -> distinct messages of his containing it
  messages: () => 0,            // () -> how many distinct messages that was counted over
  validUrl: () => false,
  normalizeUrl: s => s,
  appDirs: ['/Applications', '/Applications/Utilities', '/System/Applications',
            '/System/Applications/Utilities', '/System/Library/CoreServices', path.join(HOME, 'Applications')],
  isRequest: () => null,        // (text) -> true when the text is a request of its own (errand's gate)
  warmRequests: async () => 0,  // (texts) -> compute those verdicts ahead of the sync reader
};
function init(opts) {
  for (const k of Object.keys(opts || {})) if (opts[k] !== undefined) deps[k] = opts[k];
  load();
}

// ---------------------------------------------------------------------------
// SHAPE
// ---------------------------------------------------------------------------
// A whitespace chunk that carries a dot or a slash between letters, or starts with ~ or /, is one
// token — a URL, hostname or path is an identifier, not prose. Everything else is split into runs of
// letters and digits. No word is consulted.
const IDENT_SHAPE = /^(?:[~/]|[a-z][a-z0-9+.-]*:\/\/|[\p{L}\p{N}_-]+(?:[./][\p{L}\p{N}_-]+)+)/iu;
function tokenize(text) {
  const out = [];
  for (const chunk of String(text == null ? '' : text).split(/\s+/)) {
    if (!chunk) continue;
    const trimmed = chunk.replace(/^[("'“‘<]+|[)"'”’>,;:!?.]+$/g, '');
    if (trimmed && IDENT_SHAPE.test(trimmed) && /[./~]/.test(trimmed)) {
      out.push({ raw: trimmed, low: trimmed.toLowerCase(), ident: true });
      continue;
    }
    for (const w of chunk.split(/[^\p{L}\p{N}]+/u)) if (w) out.push({ raw: w, low: w.toLowerCase(), ident: false });
  }
  return out;
}
const flat = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ---------------------------------------------------------------------------
// REGISTRIES
// ---------------------------------------------------------------------------
let _apps = { at: 0, list: [] };
function appNames() {
  if (Date.now() - _apps.at < 60000 && _apps.list.length) return _apps.list;
  const set = new Set();
  for (const d of deps.appDirs) {
    try { for (const n of fs.readdirSync(d)) if (n.endsWith('.app')) set.add(n.slice(0, -4)); } catch (e) {}
  }
  _apps = { at: Date.now(), list: [...set] };
  return _apps.list;
}
// An installed app named by this phrase: the name itself with separators and case flattened
// ("find my" is FindMy, "app store" is App Store), or its words abbreviated the way people do — each
// word he typed is a whole word of the name, the start of one (3+ letters), or the initials of a run
// of them ("vs code" is Visual Studio Code). Shape against a registry; no nickname table.
function appFor(phrase) {
  const want = flat(phrase);
  if (!want) return null;
  const said = String(phrase).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let best = null;
  for (const app of appNames()) {
    if (flat(app) === want) return app;
    const words = app.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length < 2 && said.length < 2) continue;
    if (abbreviates(said, words) && (!best || app.length < best.length)) best = app;
  }
  return best;
}
function abbreviates(said, words) {
  // Every word of the name must be covered, in order, by the words he said.
  let wi = 0;
  for (let si = 0; si < said.length; si++) {
    const s = said[si];
    if (wi >= words.length) return false;
    if (words[wi] === s || (s.length >= 3 && words[wi].startsWith(s))) { wi++; continue; }
    // initials of a run of name words
    let k = 0;
    while (k < s.length && wi + k < words.length && words[wi + k][0] === s[k]) k++;
    if (k === s.length && k >= 2) { wi += k; continue; }
    return false;
  }
  return wi === words.length;
}

// A SITE NAMED BY ITS START. "insta" is Instagram the way "vs code" is Visual Studio Code: the
// registry's own key, shortened. Accepted only when the shortening is unambiguous (exactly one key
// starts that way), at least five letters, and at least half the key — so "open" never reaches
// "openrouter" and "goog" never reaches any of the three Google keys. Shape against the registry.
const MIN_PREFIX = 5;
// Two keys starting the same way ("insta" is both Instagram and Instamart) is not a lookup failure,
// it is a question — the registry genuinely cannot say, so the reader asks and keeps the answer.
// JARVIS'S OWN PANELS — a registry the machine owns (server.js PANELS), matched the way app names are: the
// whole name, or every word of it in order, shortened ("neural net"). Never one word alone: "world" is
// not the World Monitor. This replaced the client's own open/close word lists (2026-09-19).
function panelFor(phrase) {
  const want = flat(phrase);
  if (!want) return null;
  const said = String(phrase).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const p of (deps.panels() || [])) {
    const words = String(p.name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (flat(p.name) === want || (said.length >= 2 && abbreviates(said, words))) return p.id;
  }
  return null;
}
function sitesByPrefix(word) {
  const w = flat(word);
  if (w.length < MIN_PREFIX) return [];
  return (deps.siteKeys() || []).filter(k => k !== w && k.startsWith(w) && w.length * 2 >= k.length);
}
function siteByPrefix(word) {
  const taught = load().taughtSite[flat(word)];
  if (taught) return taught;
  const hits = sitesByPrefix(word);
  return hits.length === 1 ? hits[0] : null;
}

// A MISTYPED NAME — shape only: edit distance to the names the machine owns (site keys, installed apps).
// For the reader's `thing` alone, never a whole sentence (in running text "mail" is one edit from "gmail").
// One word of 4+ letters; distance 1, or 2 from 8 letters; exactly one name that close, or it is not a match
// (several → the caller asks). "opn spotfy" (casual dev run 2026-09-29) read thing "spotfy" and nothing
// resolved it.
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function typoAnchor(word) {
  const w = flat(word);
  if (w.length < 4) return null;
  const max = w.length >= 8 ? 2 : 1;
  // A name that starts the other is a different WORD, not a typo — a plural, a suffix: "screenshots" is not the
  // Screenshot app ("yeet the screenshots folder into the trash" would have deleted it), "note" is not Notes.
  const close = n => n !== w && !n.startsWith(w) && !w.startsWith(n) && editDistance(w, n) <= max;
  const hits = new Map();   // keyed by the flat name, so a site and the app of the same name are one match
  for (const k of (deps.siteKeys() || [])) if (close(flat(k))) hits.set(flat(k), { kind: 'site', value: k });
  for (const app of appNames()) if (close(flat(app)) && !hits.has(flat(app))) hits.set(flat(app), { kind: 'app', value: app });
  if (hits.size !== 1) return hits.size > 1 ? { kind: 'ambiguous', value: [...hits.values()].map(h => h.value) } : null;
  const h = Object.assign([...hits.values()][0], { typo: true });
  if (h.kind === 'site') h.app = deps.siteApp(h.value) || appFor(h.value) || null;
  return h;
}

// Every span of up to MAX_ANCHOR tokens that a registry or a shape recognises, longest first,
// never overlapping. Each carries what it is and what it resolved to.
const MAX_ANCHOR = 4;
function anchorsIn(toks) {
  const out = [];
  const taken = new Set();
  for (let n = MAX_ANCHOR; n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      let free = true;
      for (let k = i; k < i + n; k++) if (taken.has(k)) { free = false; break; }
      if (!free) continue;
      const slice = toks.slice(i, i + n);
      const phrase = slice.map(t => t.raw).join(' ');
      let a = null;
      if (n === 1 && slice[0].ident) {
        const raw = slice[0].raw;
        const url = deps.validUrl(raw) ? raw : (deps.validUrl(deps.normalizeUrl(raw)) ? deps.normalizeUrl(raw) : null);
        if (url) a = { kind: 'url', value: url };
      }
      if (!a && !slice.some(t => t.ident)) {
        const panel = panelFor(phrase);
        if (panel) a = { kind: 'panel', value: panel };
      }
      if (!a && !slice.some(t => t.ident)) {
        const site = deps.siteKey(phrase) || (n === 1 ? siteByPrefix(slice[0].low) : null);
        const browser = deps.browserName(phrase);
        const wf = (deps.workflows() || []).find(w => w && String(w.name).toLowerCase() === phrase.toLowerCase());
        const app = appFor(phrase);
        const several = !site && !browser && !wf && !app && n === 1 ? sitesByPrefix(slice[0].low) : [];
        if (wf) a = { kind: 'workflow', value: wf.name };
        else if (site) a = { kind: 'site', value: site, app: deps.siteApp(site) || app || null };
        else if (browser) a = { kind: 'browser', value: browser };
        else if (app) a = { kind: 'app', value: app };
        else if (several.length > 1) a = { kind: 'ambiguous', value: several };
      }
      if (!a) continue;
      out.push(Object.assign(a, { i, j: i + n, raw: phrase }));
      for (let k = i; k < i + n; k++) taken.add(k);
    }
  }
  return out.sort((x, y) => x.i - y.i);
}

// Every phrase he has told JARVIS means opening or closing an app, at every position, longest first
// per position. verblex holds his answers only — there is no seed — so on a machine he has not taught
// this finds nothing, and this fallback reader declines rather than guesses.
function verbsIn(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].ident) continue;
    for (let n = Math.min(4, toks.length - i); n >= 1; n--) {
      const phrase = toks.slice(i, i + n).map(t => t.low).join(' ');
      const kind = verblex.kindOfSync(phrase, 'app');
      if (kind) { out.push({ i, j: i + n, kind, verb: phrase }); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HIS WORDS — scaffolding by his own frequencies.
// ---------------------------------------------------------------------------
// A word that appears in at least this share of his distinct messages carries no content of its
// own. Swept in sweep_actread.js; see there for the table.
const SCAFFOLD_SHARE = 0.05;
function isScaffold(word) {
  const n = deps.messages();
  if (!n) return false;
  return deps.df(word) / n >= (deps.scaffoldShare || SCAFFOLD_SHARE);
}

// ---------------------------------------------------------------------------
// REGIONS
// ---------------------------------------------------------------------------
// WHICH SYSTEM ACTION — the five kinds that are not half of an antonym pair, so the embedder decides
// them unaided (verblex.js says the same). The not-an-action side is split into coherent regions and
// rejoined with groups, so an action has to beat its nearest NON-action.
const SYSTEM_EXEMPLARS = {
  system_status: ['system status', 'give me a status report on the machine', 'run diagnostics',
                  'how is the computer doing', 'show me the system stats', 'sitrep on the mac'],
  screenshot: ['take a screenshot', 'capture my screen', 'grab a picture of the screen',
               'screenshot this', 'snap the screen'],
  list_running: ['what apps are running', 'list the open applications', 'which programs are open right now',
                 'show me everything that is running'],
  empty_trash: ['empty the trash', 'clear out the bin', 'take out the trash on the mac'],
  sleep_display: ['turn off the display', 'put the screen to sleep', 'switch the monitor off'],
  // NOT ONE JUNK DRAWER. As a single "the machine's other lanes" region, opening and closing apps
  // averaged in with files and battery questions and lost to list_running — measured: "launch github",
  // "open the app store" and "okay open maps" all read as a running-apps question. Split, each region
  // means one thing. None of these sentences is in any measurement set.
  'none-question': ['who is the ceo of blackrock', 'how does a car engine work',
                    'what is the capital of france', 'explain recursion to me'],
  'none-chat': ['thanks that worked', 'good morning', 'never mind', 'tell me a joke', 'how have you been'],
  'none-open-close': ['launch brave', 'open notion', 'quit xcode', 'start discord', 'go to reddit',
                      'bring up the music app', 'shut spotify'],
  'none-files': ['create a folder called notes', 'delete report.pdf', 'find my resume',
                 'rename the file to draft', 'what is in my documents folder'],
  'none-stats': ['what is my battery at', 'how much ram is free', 'cpu usage right now', 'how much disk is left'],
  'none-errand': ['message mama on whatsapp', 'remind me to call the dentist', 'order me a pizza',
                  'play something by drake', 'research quantum computing'],
  // THE WORLD OUTSIDE THE MAC. A photo of something and a light switch are not the screen and the
  // display, and with nowhere else to go they landed on screenshot and sleep_display.
  'none-camera': ['click a photo of me', 'take a selfie with the webcam', 'photograph the whiteboard'],
  'none-home': ['switch on the fan', 'dim the bedroom lamp', 'lock the front door', 'set the ac to 22'],
  'none-schedule': ['cancel my meetings today', 'free up my afternoon', 'move the call to friday'],
};
const SYSTEM_KINDS = ['system_status', 'screenshot', 'list_running', 'empty_trash', 'sleep_display'];
const SYSTEM_GROUPS = {};
for (const k of Object.keys(SYSTEM_EXEMPLARS)) SYSTEM_GROUPS[k] = SYSTEM_KINDS.includes(k) ? k : 'none';
const SYSTEM_MIN_MARGIN = 0.03;

// THE BUSINESS'S ACCOUNT, OR THE SITE. He asks for both, in nearly the same words, and they open
// different accounts. His organisation's name, when his profile has one, is decisive on its own.
// A third region for opening something that is neither — "open the company report" names a company
// and is not a social account, and without a home of its own it would land on `business`.
const BUSINESS_EXEMPLARS = {
  business: ['pull up our company twitter', 'show me the brand\'s linkedin page',
             'open the agency\'s facebook profile', 'go to our work account on instagram',
             'bring up the startup\'s social media'],
  plain: ['go to twitter', 'launch facebook', 'pull up linkedin', 'take me to instagram',
          'open facebook in the browser', 'show me my instagram feed'],
  other: ['open the quarterly report', 'open my notes', 'open the project folder',
          'open that pdf', 'open the pod bay doors', 'open the company handbook'],
};
const BUSINESS_GROUPS = { business: 'business', plain: 'not', other: 'not' };
// No margin: this verdict never acts. Measured on his own phrasing, business-vs-plain margins ran
// 0.008 to 0.055 — too close to act on — so the lean only chooses which question to ask.

// WHAT ROLE DOES A LEFTOVER WORD PLAY? Read one word or short run at a time, by all-minilm — the
// model measured better than nomic on short strings (errand.js, itemclass.js). A word no region
// claims with margin is CONTENT, and content is what makes a reading incomplete.
const ROLE_MODEL = 'all-minilm';
const ROLE_EXEMPLARS = {
  courtesy: ['please', 'thanks', 'thank you', 'kindly', 'cheers', 'if you can', 'quickly'],
  sequence: ['first', 'next', 'then', 'now', 'again', 'right away', 'straight away'],
  'site-type': ['website', 'the website', 'web version', 'site', 'the web one', 'online version'],
  'app-type': ['app', 'application', 'desktop app', 'program', 'mac app'],
  force: ['force', 'forcefully', 'force it', 'hard'],
  // Not ignorable: a time is a different request (a reminder, a schedule), never an "open".
  deferral: ['later', 'tomorrow', 'tonight', 'in an hour', 'at five pm', 'next week'],
  // A PLACE INSIDE THE THING. Without a home, a word like this lands on whichever ignorable region
  // is nearest — the missing-region failure — and an incomplete reading would pass as complete.
  // None of these words is in any measurement set.
  destination: ['preferences', 'notifications', 'watch later', 'bookmarks', 'drafts',
                'the billing page', 'my orders', 'saved posts', 'dashboard', 'the cart'],
  // A THING TO DO THERE, likewise — "open notes and write" arrives here when the splitter keeps it.
  task: ['write a list', 'send it', 'reply to him', 'download the file', 'sign in', 'share this'],
};
const IGNORABLE_ROLES = new Set(['courtesy', 'sequence']);
const TYPE_ROLES = new Set(['site-type', 'app-type']);
// A role that lets a word be DROPPED or CHANGES what opens needs more daylight than one that only
// marks a word as content — being wrong in that direction acts on half a request. Swept on
// sweep_actread.js's first role set (38 words): at these cuts no content word was read as ignorable
// or as a type; the second, blind set is what the numbers in that file's header report.
const ROLE_MIN_MARGIN = 0.04;
const IGNORABLE_MIN_MARGIN = 0.10;
const TYPE_MIN_MARGIN = 0.15;
// A role only he can give: the words that meant "the business's account".
const TAUGHT_ONLY_ROLES = new Set(['business']);

// ---------------------------------------------------------------------------
// CACHE — verdicts keyed by text, his answers keyed by word.
// ---------------------------------------------------------------------------
const CACHE_FILE = 'actread.json';
let _version = null;
function version() {
  if (_version) return _version;
  _version = crypto.createHash('sha256').update(JSON.stringify([SYSTEM_EXEMPLARS, SYSTEM_MIN_MARGIN,
    BUSINESS_EXEMPLARS, BUSINESS_GROUPS, ROLE_MODEL, ROLE_EXEMPLARS, ROLE_MIN_MARGIN,
    IGNORABLE_MIN_MARGIN, TYPE_MIN_MARGIN])).digest('hex').slice(0, 12);
  return _version;
}
let cache = null, dirty = false;
function fresh() {
  return { v: version(), system: Object.create(null), business: Object.create(null),
           role: Object.create(null), taughtRole: Object.create(null), taughtSite: Object.create(null) };
}
function load() {
  if (cache) return cache;
  cache = fresh();
  try {
    const saved = deps.store && deps.store.read(CACHE_FILE, null);
    if (saved) {
      Object.assign(cache.taughtRole, saved.taughtRole || {});
      Object.assign(cache.taughtSite, saved.taughtSite || {});
      if (saved.v === cache.v) {
        Object.assign(cache.system, saved.system || {});
        Object.assign(cache.business, saved.business || {});
        Object.assign(cache.role, saved.role || {});
      }
    }
  } catch (e) {}
  return cache;
}
function save() {
  if (!dirty || !deps.store) return;
  try { deps.store.write(CACHE_FILE, Object.assign({ at: Date.now() }, load())); dirty = false; } catch (e) {}
}
const key = s => tokenize(s).map(t => t.low).join(' ');

let _sys = null, _biz = null;
const sysFn = () => _sys || (_sys = intent.makeClassifier({
  exemplars: SYSTEM_EXEMPLARS, groups: SYSTEM_GROUPS, none: 'none', minMargin: SYSTEM_MIN_MARGIN,
  label: 'ActSystem', jlog: () => {},
}));
const bizFn = () => _biz || (_biz = intent.makeClassifier({
  exemplars: BUSINESS_EXEMPLARS, groups: BUSINESS_GROUPS, minMargin: 0, none: '__unused__',
  label: 'ActBusiness', jlog: () => {},
}));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cos = (a, b) => { const d = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b)); return d ? dot(a, b) / d : 0; };
let _roleCent = null;
async function roleCentroids() {
  if (_roleCent) return _roleCent;
  const out = {};
  for (const [id, ex] of Object.entries(ROLE_EXEMPLARS)) {
    const c = await intent.centroidOf(ROLE_MODEL, ex);
    if (!c) return null;
    out[id] = c;
  }
  _roleCent = out;
  return out;
}
async function roleOf(word) {
  const cent = await roleCentroids();
  if (!cent) return null;
  const v = await intent.embed(word, ROLE_MODEL);
  if (!v) return null;
  const sc = Object.entries(cent).map(([id, c]) => ({ id, s: cos(v, c) })).sort((a, b) => b.s - a.s);
  const m = sc[0].s - sc[1].s;
  const need = IGNORABLE_ROLES.has(sc[0].id) ? IGNORABLE_MIN_MARGIN : TYPE_ROLES.has(sc[0].id) ? TYPE_MIN_MARGIN : ROLE_MIN_MARGIN;
  return m >= need ? sc[0].id : '';
}

// The leftover runs a reading of this text would have to explain — computed the same way readSync
// computes them, so warm() and the reader cannot disagree about what needs a verdict.
function leftoverRuns(text) {
  const toks = tokenize(text);
  const plan = planOf(toks);
  return plan ? plan.leftover.concat(plan.lead).map(r => r.map(i => toks[i].low).join(' ')) : [];
}

// Compute every verdict the sync reader could need for these texts.
async function warm(texts) {
  const c = load();
  let n = 0;
  for (const t of new Set((Array.isArray(texts) ? texts : [texts]).map(key).filter(Boolean))) {
    if (t.length > 300) continue;
    try {
      if (c.system[t] === undefined) {
        const r = await sysFn()(t);
        if (!r && !(await intent.embed('x'))) continue;     // embedder down: ask again next time
        c.system[t] = r && SYSTEM_KINDS.includes(r.id) ? r.id : '';
        dirty = true; n++;
      }
      if (c.business[t] === undefined && needsBusinessVerdict(t)) {
        const r = await bizFn()(t);
        if (!r) { if (!(await intent.embed('x'))) continue; }
        // The lean is kept even when it is not decisive: it only ever decides WHICH question to ask.
        c.business[t] = r ? { id: r.id, group: r.group, m: Math.round(r.margin * 1000) / 1000 } : { id: '', group: '', m: 0 };
        dirty = true; n++;
      }
      const runs = leftoverRuns(t);
      for (const run of runs) {
        if (c.role[run] !== undefined) continue;
        const r = await roleOf(run);
        if (r === null) continue;
        c.role[run] = r;
        dirty = true; n++;
      }
      // A leftover of more than one word may be a request of its own; that verdict is errand's.
      const multi = runs.filter(r => r.includes(' '));
      if (multi.length) await deps.warmRequests(multi);
    } catch (e) {}
  }
  save();
  return n;
}
// A social site with a business profile — or an open with no anchor at all, which is how "open the
// socials" arrives: the business's accounts, named without naming a platform.
function needsBusinessVerdict(text) {
  const toks = tokenize(text);
  const social = new Set(deps.socialKeys() || []);
  const anchors = anchorsIn(toks);
  if (anchors.some(a => a.kind === 'site' && social.has(a.value))) return true;
  return !anchors.length && verbsIn(toks).some(v => v.kind === 'open_app') && social.size > 0;
}

// ---------------------------------------------------------------------------
// THE PLAN — which verb, which thing, and what is left over.
// ---------------------------------------------------------------------------
// The first open/close verb, and the one anchor on its side of the sentence: after it (English) or
// before it (Hindi puts the object first — "terminal open kardo"). A second verb or a second anchor
// in the stretch the reading covers means this is more than one instruction, and the splitter, not
// this reader, owns that — with one exception the registry itself explains: his own business's site
// named beside a social site is not a second destination, it says WHOSE account ("the admax
// instagram").
const APP_KINDS = new Set(['open_app', 'close_app']);
function isCompanyAnchor(a) {
  const names = (deps.companyNames() || []).map(flat).filter(Boolean);
  return a.kind === 'site' && names.length > 0 && (names.includes(flat(a.value)) || names.includes(flat(a.raw)));
}
function planOf(toks) {
  let anchors = anchorsIn(toks);
  const social = new Set(deps.socialKeys() || []);
  let businessMark = false;
  if (anchors.some(a => a.kind === 'site' && social.has(a.value)) && anchors.some(isCompanyAnchor)) {
    businessMark = true;
    anchors = anchors.filter(a => !isCompanyAnchor(a));
  }
  // A verb inside a name is part of the name: "find my" is an app, not a search.
  const all = anchorsIn(toks);
  const inAnchor = x => all.some(a => x.i < a.j && a.i < x.j);
  const allVerbs = verbsIn(toks).filter(x => !inAnchor(x));
  const verbs = allVerbs.filter(v => APP_KINDS.has(v.kind));
  if (!verbs.length) return null;
  const v = verbs[0];
  const after = anchors.filter(a => a.i >= v.j);
  const before = anchors.filter(a => a.j <= v.i);
  let a = after[0] || null;
  if (a && (after.length > 1 || allVerbs.some(x => x !== v && x.i >= v.j))) return null;
  if (!a) {
    a = before[before.length - 1] || null;
    if (!a && anchors.length) return null;
    if (a && (before.length > 1 || allVerbs.some(x => x !== v && x.i >= a.j))) return null;
  }
  const covered = new Set();
  for (let k = v.i; k < v.j; k++) covered.add(k);
  if (a) for (let k = a.i; k < a.j; k++) covered.add(k);
  for (const x of all) if (isCompanyAnchor(x) && businessMark) for (let k = x.i; k < x.j; k++) covered.add(k);
  const start = a ? Math.min(v.i, a.i) : v.i;
  // Leftovers: contiguous runs of uncovered, non-scaffold tokens after the reading starts. The run
  // just before the reading is kept separately: it never has to be explained (it is the preamble),
  // but it can still carry a role the reading uses — "force quit textedit".
  const runsIn = (lo, hi) => {
    const out = [];
    let run = [];
    for (let k = lo; k < hi; k++) {
      if (covered.has(k) || (!toks[k].ident && isScaffold(toks[k].low))) {
        if (run.length) { out.push(run); run = []; }
        continue;
      }
      run.push(k);
    }
    if (run.length) out.push(run);
    return out;
  };
  const leftover = runsIn(start, toks.length);
  const pre = runsIn(0, start);
  const last = pre[pre.length - 1];
  const lead = last && last[last.length - 1] === start - 1 ? [last] : [];
  return { verb: v, anchor: a, leftover, lead, start, businessMark };
}

// ---------------------------------------------------------------------------
// THE SYNCHRONOUS READER
// ---------------------------------------------------------------------------
// Returns one of:
//   { action }                      a complete reading
//   { ask: { kind, ... } }          a reading that needs one answer from him first
//   null                            nothing this reader can say (or nothing warmed yet)
const words = (toks, run) => run.map(i => toks[i].low).join(' ');
function roleFor(c, w) {
  const taught = taughtRoleOf(w);
  return taught !== undefined ? taught : c.role[w];
}
function readSync(text) {
  const t = key(text);
  if (!t) return null;
  const c = load();
  const toks = tokenize(text);
  const plan = planOf(toks);

  // No open/close reading with a named thing: the sentence may name a system action instead.
  if (!plan || !plan.anchor) {
    const sys = c.system[t];
    if (sys) return { action: { type: sys } };
    if (!plan) return null;
    return readUnanchored(c, t, toks, plan);
  }
  const { verb, anchor } = plan;

  if (anchor.kind === 'ambiguous') {
    return { ask: { kind: 'which-site', text: String(text), said: anchor.raw, options: anchor.value } };
  }

  const leftovers = plan.leftover.map(r => words(toks, r));
  // A leftover that is a request of its own makes this more than one instruction.
  for (const w of leftovers) if (w.includes(' ') && deps.isRequest(w) === true) return null;

  // WHOSE ACCOUNT, for a social site with a business profile configured.
  const social = deps.socialKeys() || [];
  let business = false;
  if (anchor.kind === 'site' && social.includes(anchor.value)) {
    if (plan.businessMark) business = true;
    else if (leftovers.length && leftovers.every(w => roleFor(c, w) === 'business' || IGNORABLE_ROLES.has(roleFor(c, w)))
             && leftovers.some(w => roleFor(c, w) === 'business')) business = true;
    else {
      const b = c.business[t];
      if (b === undefined) return null;                         // not warmed: claim nothing
      const unknown = leftovers.filter(w => roleFor(c, w) === undefined || roleFor(c, w) === '' || roleFor(c, w) === 'destination');
      // The embedder never decides this on its own — its margins on his own phrasing were 0.008
      // to 0.055. It decides only whether the question worth asking is "whose account?".
      if (b.id === 'business' && leftovers.length) {
        return { ask: { kind: 'business', text: String(text), site: anchor.value, words: leftovers } };
      }
      if (unknown.length === 0 && b.id === 'business') {
        return { ask: { kind: 'business', text: String(text), site: anchor.value, words: [] } };
      }
    }
  }

  // EVERY LEFTOVER RUN MUST BE EXPLAINED.
  let preferSite = false, wantsApp = false, force = false;
  const unexplained = [];
  for (const w of leftovers) {
    const role = roleFor(c, w);
    if (role === undefined) return null;                        // not warmed: claim nothing
    if (IGNORABLE_ROLES.has(role)) continue;
    if (business && role === 'business') continue;
    if (role === 'site-type') { preferSite = true; continue; }
    if (role === 'app-type') { wantsApp = true; continue; }
    if (role === 'force' && verb.kind === 'close_app') { force = true; continue; }
    unexplained.push(w);
  }
  for (const r of plan.lead) {
    if (roleFor(c, words(toks, r)) === 'force' && verb.kind === 'close_app') force = true;
  }
  if (unexplained.length) {
    return { ask: { kind: 'leftover', text: String(text), verb: verb.verb, verbKind: verb.kind,
                    thing: anchor.raw, words: unexplained } };
  }

  const name = anchor.raw;
  if (anchor.kind === 'panel') return { action: { type: verb.kind === 'close_app' ? 'close_panel' : 'open_panel', target: anchor.value } };
  if (verb.kind === 'close_app') {
    if (anchor.kind === 'url' || anchor.kind === 'workflow') return null;
    if (anchor.kind === 'site' && !anchor.app) return null;     // a website has no process to quit
    return { action: { type: 'close_app', name, target: name, force } };
  }
  if (anchor.kind === 'url') return { action: { type: 'open_url', target: anchor.value } };
  if (anchor.kind === 'workflow') return { action: { type: 'run_workflow', target: anchor.value } };
  if (anchor.kind === 'site') {
    if (business) return { action: { type: 'open_social', target: anchor.value } };
    if (wantsApp) return { action: { type: 'open_app', name, target: name } };
    return { action: { type: 'open_site', target: anchor.value, preferSite } };
  }
  return { action: { type: 'open_app', name, target: name } };
}

// An open that names no registered thing. Only the business's accounts can be opened by description
// alone ("open the socials"), and only once he has said which words mean that.
function readUnanchored(c, t, toks, plan) {
  const social = deps.socialKeys() || [];
  if (plan.verb.kind !== 'open_app' || !social.length) return null;
  const rest = [];
  for (let k = plan.verb.j; k < toks.length; k++) if (toks[k].ident || !isScaffold(toks[k].low)) rest.push(toks[k].low);
  if (!rest.length) return null;
  const roles = rest.map(w => taughtRoleOf(w));
  if (roles.every(r => r === 'business' || IGNORABLE_ROLES.has(r)) && roles.includes('business')) {
    return { action: { type: 'open_social', target: social[0] } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// WHAT HE TOLD US
// ---------------------------------------------------------------------------
// A leftover run's role, as he answered it. '' means "that mattered" — content.
// A run he never answered about as a whole is still explained when he answered about EVERY word in
// it and every answer was "that was nothing" (or "that meant the business") — so "kardo" taught once
// covers "kardo plz". Any word he called content makes the run content.
function taughtRoleOf(w) {
  const t = load().taughtRole;
  if (Object.prototype.hasOwnProperty.call(t, w)) return t[w];
  const parts = String(w).split(' ').filter(Boolean);
  if (parts.length < 2) return undefined;
  const roles = parts.map(p => Object.prototype.hasOwnProperty.call(t, p) ? t[p] : undefined);
  if (roles.some(r => r === undefined)) return undefined;
  if (roles.some(r => r === '')) return '';
  if (roles.includes('business') && roles.every(r => r === 'business' || IGNORABLE_ROLES.has(r))) return 'business';
  return roles.every(r => IGNORABLE_ROLES.has(r)) ? roles[0] : undefined;
}
// Every word of the run is taught, one by one, so the answer generalises to the next phrasing.
function teachRole(w, role) {
  const parts = tokenize(w).map(x => x.low).filter(p => !isScaffold(p));
  if (!parts.length) return false;
  const ok = role === '' || TAUGHT_ONLY_ROLES.has(role) || Object.prototype.hasOwnProperty.call(ROLE_EXEMPLARS, role);
  if (!ok) return false;
  const c = load();
  for (const p of parts) c.taughtRole[p] = role;
  dirty = true; save();
  deps.jlog('ActRead › learned from him: "' + parts.join(' ').slice(0, 30) + '" ' + (role ? 'is ' + role : 'is part of what he wants'));
  return true;
}
// Which registered site a shortening meant, as he answered it.
function teachSite(said, site) {
  const w = flat(said);
  if (!w || !(deps.siteKeys() || []).includes(site)) return false;
  load().taughtSite[w] = site; dirty = true; save();
  deps.jlog('ActRead › learned from him: "' + w + '" means ' + site);
  return true;
}

module.exports = {
  init, warm, readSync, teachRole, teachSite, tokenize, anchorsIn, typoAnchor, verbsIn, appFor, planOf, leftoverRuns, isScaffold,
  _roleOf: roleOf, SYSTEM_EXEMPLARS, BUSINESS_EXEMPLARS, ROLE_EXEMPLARS, SCAFFOLD_SHARE, _cacheFile: CACHE_FILE,
};
