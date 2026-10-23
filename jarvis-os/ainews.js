'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// THE WEEK IN AI AND MACHINE LEARNING — gathered in dream mode, offered on Sundays.
//
// Dream mode reads what the field published this week; on Sunday, the last day of his week, the
// greeting says how much there was and offers the short version: 'Say "summary"'. Only that word,
// as his whole answer, gets it (soleOffered in server.js — the reader's own rule, no list of
// yeses). The full list, with links, goes to JARVIS Outputs when he takes it.
//
// WHAT COUNTS AS AI NEWS IS DECIDED BY THE SOURCES, NEVER BY THE WORDS IN A STORY. Every source in
// config/ainews.json is AI/ML by construction — a lab's own blog, the AI section of a publication, an
// AI community, Hugging Face's papers and models. Nothing here reads a headline and decides by
// keyword whether it is about AI; a keyword filter would miss the phrasing nobody wrote down.
//
// VAST ON PURPOSE: he asked for the ignored breakthroughs too — "a new model by an unknown lab".
// Those never reach a big lab's blog. They surface as Hugging Face models created this week that are
// already trending (measured 2026-09-18: 12 of the top 100, from prism-ml, XingChen-AGI, Agnes-AI,
// internlm …), on r/LocalLLaMA's top of the week, and in the outlets that cover small releases. So the
// full list keeps every story (324 from 20 sources in the first live week), and the short version keeps
// three places for the wider field whatever the big labs announced — see rankWeek.
//
// ONE DREAM A WEEK IS ENOUGH. Dream mode ran 4 times in the first 18 days of September (it needs 20
// minutes idle on mains power), so each run rebuilds the whole week: Hugging Face papers are fetched
// per day, WordPress feeds are paged back to Monday, Reddit's "top of the week" is the week already.
//
// THE SHORT VERSION IS THE LOCAL MODEL'S, AND IT IS CHECKED BEFORE IT IS KEPT. The 3B invents: it
// fabricated in ~70% of the normaliser's rewrites. So it must answer as JSON, one sentence per story,
// each naming its story's number (Ollama's `format`), and every name-shaped word in a sentence — a
// capital past the first word, an acronym, anything with a digit — must appear in THAT story's own text,
// maker included, outlet excluded. An invented model, an invented number, one lab's news credited to
// another, or a model credited to the website that listed it: that sentence is dropped. Fewer than three
// left, or nothing from the wider field, and the short version is the real headlines instead.
// Shape decides what is name-shaped, not a list.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

let deps = {
  jlog: () => {}, stateDir: null, outDir: null, llm: null,
  fetchText: null,              // injected by tests; the default is httpText below
  now: () => new Date(),
  sourcesFile: path.join(__dirname, '..', 'config', 'ainews.json'),
};
function init(d) { deps = Object.assign(deps, d || {}); state = null; cfgCache = null; }

const DAY = 86400000, HOUR = 3600000;
const KEEP_DAYS = 21;              // three weeks of stories; only this week's is ever offered
const KEEP_WEEKS = 6;
const FETCH_GAP = 3 * HOUR;        // a forced "dream now" twice in a row does not re-read 28 sources
const OFFER_WORD = 'summary';      // JARVIS's own word, said in the greeting — the only answer taken

// ---------------- time: his week runs Monday to Sunday ----------------
function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - (x.getDay() + 6) % 7);     // getDay(): Sunday 0 … Saturday 6
  return x;
}
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function weekKey(d) { return ymd(weekStart(d)); }
function isSunday(d) { return new Date(d).getDay() === 0; }
function weekBounds(key) {
  const [y, m, dd] = key.split('-').map(Number);
  const start = new Date(y, m - 1, dd, 0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  return { start: start.getTime(), end: end.getTime() };
}

// ---------------- the sources (config/ainews.json) ----------------
let cfgCache = null;
function config() {
  if (cfgCache) return cfgCache;
  let c = null;
  try { c = JSON.parse(fs.readFileSync(deps.sourcesFile, 'utf8')); } catch (e) { c = null; }
  const sources = (c && Array.isArray(c.sources) ? c.sources : [])
    .filter(s => s && s.name && /^https:\/\//.test(String(s.url || '')));
  cfgCache = { enabled: !c || c.enabled !== false, sources };
  return cfgCache;
}

// ---------------- reading RSS, Atom and Hugging Face ----------------
// XML is read by its own markup — tag names and entities are the format's, not language.
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    }
    const v = ENTITY[e.toLowerCase()];
    return v == null ? ' ' : v;
  });
}
// Escaped HTML inside a description (&lt;p&gt;…) is decoded before the tags are stripped.
function clean(s) {
  const raw = String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decode(decode(raw).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function tagText(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : null;
}
function attrOf(attrs, key) {
  const m = attrs.match(new RegExp('\\b' + key + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? (m[1] != null ? m[1] : m[2]) : null;
}
function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map(m => m[1]);
  const alt = links.find(a => { const rel = attrOf(a, 'rel'); return !rel || rel === 'alternate'; }) || links[0];
  return alt ? decode(attrOf(alt, 'href') || '').trim() : '';
}
const isWeb = u => /^https?:\/\//i.test(String(u || ''));

function mk(o, src) {
  return {
    title: String(o.title).slice(0, 300), url: o.url, at: o.at,
    source: src.name, group: src.group || 'field', kind: src.kind || 'rss',
    blurb: String(o.blurb || '').slice(0, 280),
    score: o.score == null ? null : o.score, scoreText: o.scoreText || '', org: o.org || '',
    pos: o.pos == null ? null : o.pos,   // place in its feed: a "top of the week" feed is ranked by it
  };
}

// RSS 2.0, RSS 1.0 and Atom. An entry with no title, link or date is dropped: without a date it
// cannot be placed in a week, and a story that cannot be placed is not one to tell him about.
// A relative link (Sakana's Atom feed writes "/frontier-intelligence-group/") is resolved against the
// feed's own address, as Atom intends; with no address to resolve against, it is dropped.
function absolute(url, base) {
  if (isWeb(url) || !url || !base) return url;
  try { return new URL(url, base).href; } catch (e) { return url; }
}
function parseFeed(xml, src) {
  const out = [];
  for (const chunk of String(xml || '').split(/<(?:item|entry)(?=[\s>])/i).slice(1)) {
    const b = chunk.split(/<\/(?:item|entry)>/i)[0];
    const title = clean(tagText(b, 'title'));
    let url = absolute(clean(tagText(b, 'link')), src.url);
    if (!isWeb(url)) url = absolute(atomLink(b), src.url);
    if (!isWeb(url)) { const g = clean(tagText(b, 'guid')); if (isWeb(g)) url = g; }
    const when = tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated') || tagText(b, 'dc:date');
    const at = when ? Date.parse(clean(when)) : NaN;
    if (!title || !isWeb(url) || !Number.isFinite(at)) continue;
    const blurb = clean(tagText(b, 'description') || tagText(b, 'summary') || tagText(b, 'content') || tagText(b, 'content:encoded') || '');
    out.push(mk({ title, url, at, blurb, pos: out.length }, src));
  }
  return out;
}

// One day's Hugging Face daily papers. Placed at noon of the day they were featured.
function parseHfPapers(json, day, src) {
  const noon = new Date(day); noon.setHours(12, 0, 0, 0);
  return (Array.isArray(json) ? json : []).map(e => {
    const p = (e && e.paper) || {};
    const title = clean(p.title || (e && e.title));
    if (!p.id || !title) return null;
    const up = Number(p.upvotes) || 0;
    return mk({
      title, url: 'https://huggingface.co/papers/' + p.id, at: noon.getTime(),
      blurb: clean(p.ai_summary || p.summary || (e && e.summary) || ''),
      score: up, scoreText: up + ' upvotes', org: clean(p.organization && p.organization.fullname),
    }, src);
  }).filter(Boolean);
}

// Hugging Face's trending models, kept only when they are NEW — placed in the week they were created.
// This is where a model from a lab nobody has heard of shows up first.
function parseHfModels(json, src, since) {
  return (Array.isArray(json) ? json : []).map(m => {
    const id = m && (m.id || m.modelId);
    const at = Date.parse(m && m.createdAt);
    if (!id || !Number.isFinite(at) || at < since) return null;
    const likes = Number(m.likes) || 0;
    return mk({
      title: id, url: 'https://huggingface.co/' + id, at,
      blurb: [m.pipeline_tag, (Number(m.downloads) || 0) + ' downloads'].filter(Boolean).join(' · '),
      score: likes, scoreText: likes + ' likes', org: String(id).split('/')[0],
    }, src);
  }).filter(Boolean);
}

// ---------------- fetching ----------------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JARVIS-OS/1.0 (personal assistant; weekly AI digest)';
const MAX_BYTES = 6 * 1024 * 1024;       // OpenAI's feed is 0.7 MB: it carries every post it ever made
function httpText(url, timeoutMs, hops) {
  hops = hops || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('bad url')); return; }
    if (u.protocol !== 'https:') { reject(new Error('not https')); return; }
    const req = https.get(u, { headers: { 'user-agent': UA, accept: '*/*' }, timeout: timeoutMs || 15000 }, res => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && hops < 3) {
        res.resume();
        resolve(httpText(new URL(res.headers.location, u).toString(), timeoutMs, hops + 1));
        return;
      }
      // A 429 or a 404 page is HTML, not a feed — never parse it as one.
      if (code < 200 || code >= 300) { res.resume(); reject(new Error('HTTP ' + code)); return; }
      let size = 0; const parts = [];
      res.on('data', d => {
        size += d.length;
        if (size > MAX_BYTES) { req.destroy(new Error('over ' + (MAX_BYTES >> 20) + ' MB')); return; }
        parts.push(d);
      });
      res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const withParam = (url, k, v) => url + (url.includes('?') ? '&' : '?') + k + '=' + encodeURIComponent(v);
const hostOf = u => { try { return new URL(u).host; } catch (e) { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchSource(src, since, now, get, free) {
  if (src.kind === 'hf-papers') {
    const out = [];
    for (const d = new Date(since); d.getTime() <= now.getTime(); d.setDate(d.getDate() + 1)) {
      if (!(await free())) break;
      out.push(...parseHfPapers(JSON.parse(await get(withParam(src.url, 'date', ymd(d)))), d, src));
    }
    return out;
  }
  if (src.kind === 'hf-models') {
    return parseHfModels(JSON.parse(await get(src.url)), src, now.getTime() - KEEP_DAYS * DAY);
  }
  const out = [];
  const pages = Math.max(1, Math.min(Number(src.pages) || 1, 6));
  for (let p = 1; p <= pages; p++) {
    const items = parseFeed(await get(p === 1 ? src.url : withParam(src.url, 'paged', p)), src);
    out.push(...items);
    if (!items.length || items.some(i => i.at < since)) break;   // this page already reaches back past Monday
    if (!(await free())) break;
  }
  return out;
}

async function gather(now, free) {
  const { sources } = config();
  const since = weekStart(now).getTime();
  const get = deps.fetchText || (u => httpText(u));
  const got = [], failed = [], empty = [];
  let lastHost = null, interrupted = false;
  for (const src of sources) {
    if (!(await free())) { interrupted = true; break; }
    const host = hostOf(src.url);
    if (host === lastHost && !deps.fetchText) await sleep(1500);   // Reddit answers 429 to back-to-back asks
    lastHost = host;
    try {
      const items = await fetchSource(src, since, now, get, free);
      got.push(...items);
      if (!items.length) empty.push(src.name);
    } catch (e) { failed.push(src.name + ': ' + (e.message || e)); }
  }
  return { got, failed, empty, total: sources.length, interrupted };
}

// ---------------- the store (state/ainews.json) ----------------
const FILE = () => path.join(deps.stateDir || '/tmp', 'ainews.json');
let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { state = null; }
  if (!state || typeof state !== 'object') state = {};
  state.items = state.items && typeof state.items === 'object' ? state.items : {};
  state.weeks = state.weeks && typeof state.weeks === 'object' ? state.weeks : {};
  return state;
}
function save() {
  try {
    const tmp = FILE() + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(load()));
    fs.renameSync(tmp, FILE());
  } catch (e) { deps.jlog('AI news › could not save: ' + (e.message || e)); }
}

// Keyed by URL: a story read twice is one story. Upvotes and likes keep climbing, so they refresh.
function merge(items, nowMs) {
  const s = load();
  let added = 0;
  for (const it of items) {
    if (!(it.at >= nowMs - KEEP_DAYS * DAY)) continue;   // OpenAI's feed alone carries 1,200 old posts
    const old = s.items[it.url];
    if (!old) { s.items[it.url] = it; added++; continue; }
    if (it.score != null) { old.score = it.score; old.scoreText = it.scoreText; }
    if (it.pos != null) old.pos = it.pos;
    if (!old.blurb && it.blurb) old.blurb = it.blurb;
  }
  for (const [k, it] of Object.entries(s.items)) if (!(it.at >= nowMs - KEEP_DAYS * DAY)) delete s.items[k];
  return added;
}
function itemsOfWeek(key) {
  const { start, end } = weekBounds(key);
  return Object.values(load().items).filter(i => i.at >= start && i.at < end);
}
const signature = items => crypto.createHash('sha1').update(items.map(i => i.url).sort().join('\n')).digest('hex');

// ---------------- choosing the week's stories ----------------
// THE MODEL DOES NOT CHOOSE. Given 36 stories, the 3B summarised the first five in the list — a
// customer story, a teachers' tool, a blog post — and skipped Gemini 3.8 Live (live run, 2026-09-18).
// Importance is decided here, from what the week itself shows, and the model only turns each chosen
// story into a sentence:
//
//   COVERAGE — a story several sources carried is bigger than one only its maker posted. Two headlines
//   are the same story when they share a DISTINCTIVE name-shaped word: one with a digit ("3.8", "S2",
//   "Kestrel-3B"), or two capitalised ones — and distinctive means rare in THIS week's headlines (at most
//   2% of them), so "OpenAI" or "Google", which head dozens of different stories, tie none together.
//   The week's own statistics, not a list of words.
//   RELEASE SHAPE — a version in the title ("GPT-6.1", "27B") outranks a customer story.
//   THE WIDER FIELD KEEPS ITS OWN PLACES — the ignored breakthroughs he asked for: the best of each field
//   source by its own signal (upvotes, likes, a community feed's rank), coverage first.
const MAIN_PICKS = 4, FIELD_PICKS = 3;
// A compound name counts whole and in its parts, so "prism-ml/Ternary-Bonsai-2-27B-gguf" and a post
// titled "Ternary Bonsai 2 (27B) just released" share "ternary", "bonsai" and "27b".
function titleTokens(title) {
  return [...new Set(String(title).split(/\s+/)
    .map(t => t.split(/['’]/)[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(t => /\p{Lu}|\p{N}/u.test(t))
    .flatMap(t => { const w = t.toLowerCase(); return [w].concat(/[-/_]/.test(w) ? w.split(/[-/_]+/) : []); })
    .filter(t => t.length > 1))];
}
function storyLinks(items) {
  const toks = items.map(i => titleTokens(i.title));
  const df = new Map();
  for (const set of toks) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  const cap = Math.max(2, Math.ceil(items.length * 0.02));
  const keys = toks.map(set => set.filter(t => df.get(t) <= cap));
  // Two rare words in common, or one that is letters AND digits and long enough to name one thing
  // ("kestrel-3b", "gpt-6.1"). A bare version or size is not enough: "3.8" joined Gemini 3.8 to Qwen 3.8
  // in the first live week, and "27b" is half the open models there are.
  const same = (a, b) => {
    const shared = keys[a].filter(t => keys[b].includes(t));
    return shared.length >= 2 || shared.some(t => /\p{N}/u.test(t) && /\p{L}/u.test(t) && t.length >= 4);
  };
  const coverage = items.map((it, a) => {
    const others = new Set();
    items.forEach((o, b) => { if (b !== a && o.source !== it.source && same(a, b)) others.add(o.source); });
    return others.size;
  });
  return { same, coverage };
}
function rankWeek(items) {
  const { same, coverage } = storyLinks(items);
  const idx = new Map(items.map((it, k) => [it, k]));
  const cov = it => coverage[idx.get(it)];
  const byOwnSignal = (a, b) => (b.score != null || a.score != null) ? ((b.score || 0) - (a.score || 0)) || (b.at - a.at)
    : ((a.pos == null ? 1e9 : a.pos) - (b.pos == null ? 1e9 : b.pos)) || (b.at - a.at);
  const take = (list, n) => {
    const out = [];
    for (const it of list) {
      if (out.length >= n) break;
      if (out.some(o => o.source === it.source || same(idx.get(o), idx.get(it)))) continue;
      out.push(it);
    }
    return out;
  };
  const main = take(items.filter(i => i.group !== 'field').slice().sort((a, b) =>
    (cov(b) - cov(a)) || (releaseShaped(b.title) - releaseShaped(a.title)) ||
    ((a.group === 'labs' ? 0 : 1) - (b.group === 'labs' ? 0 : 1)) || (b.at - a.at)), MAIN_PICKS);
  // THE WIDER FIELD IS NOT RANKED BY COVERAGE — the ignored breakthroughs are exactly the stories nobody
  // else carried. Its three places, by the registry's own `kind`: the paper the community upvoted most,
  // the NEW model it liked most, and a community pick (coverage, then the feed's own rank). A story that
  // is already a headline is passed over for the next one.
  const order = config().sources.map(s => s.name);
  const oi = n => { const k = order.indexOf(n); return k < 0 ? 1e9 : k; };
  const f = items.filter(i => i.group === 'field');
  const papers = f.filter(i => i.kind === 'hf-papers').sort(byOwnSignal);
  const models = f.filter(i => i.kind === 'hf-models').sort(byOwnSignal);
  const community = f.filter(i => i.kind !== 'hf-papers' && i.kind !== 'hf-models').sort((a, b) =>
    (cov(b) - cov(a)) || ((a.pos == null ? 1e9 : a.pos) - (b.pos == null ? 1e9 : b.pos)) || (oi(a.source) - oi(b.source)) || (b.at - a.at));
  const field = [];
  for (const list of [papers, models, community]) {
    const it = list.find(c => !main.concat(field).some(o => same(idx.get(o), idx.get(c))));
    if (it && field.length < FIELD_PICKS) field.push(it);
  }
  return { main, field, coverage: it => cov(it) };
}

const GROUP_HEAD = {
  labs: 'Announced by the labs themselves',
  news: 'Reported by the AI press',
  field: 'From the wider field — new models, papers and the community',
};
function groupsOf(items) {
  const seen = [];
  for (const g of ['labs', 'news', 'field']) if (items.some(i => i.group === g)) seen.push(g);
  for (const i of items) if (!seen.includes(i.group)) seen.push(i.group);
  return seen;
}
// WHO MADE IT. A lab's own blog is the maker. For a paper or a model it is the organisation Hugging Face
// names. For a news story the maker is in the headline — and the outlet is never shown, so it cannot be
// credited: the first live draft (2026-09-18) said "Hugging Face introduced Vidu S2", a Tsinghua paper
// Hugging Face merely listed. The website a story came through is not who made the thing.
const maker = i => (i.group === 'labs' ? i.source : i.org) || '';
const storyText = i => [i.title, i.blurb, i.scoreText, maker(i)].join(' ').toLowerCase();

// The model answers in this shape (Ollama's `format`, the mechanism the reader model uses): one sentence
// per story, each naming its story's number — so every sentence is checked against the story it claims.
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array', minItems: 3, maxItems: 7,
      items: { type: 'object', properties: { story: { type: 'integer' }, text: { type: 'string' } }, required: ['story', 'text'] },
    },
  },
  required: ['sentences'],
};
// The stories rankWeek chose, in its order: the week's biggest, then the wider field.
function promptFor(picks) {
  const numbered = [], lines = [];
  // A model's repository id is shown as its name — "prism-ml/Ternary-Bonsai-2-27B-gguf" was read out
  // verbatim in the second live draft.
  const shown = i => i.kind === 'hf-models' && i.title.includes('/')
    ? i.title.split('/').slice(1).join('/') + ' (a new model by ' + i.org + ')'
    : i.title + (maker(i) && !i.title.includes(maker(i)) ? ' (' + (i.kind === 'hf-papers' ? 'a paper by ' : 'by ') + maker(i) + ')' : '');
  const block = (head, list) => {
    if (!list.length) return;
    lines.push(head + ':');
    for (const i of list) {
      numbered.push(i);
      lines.push(numbered.length + '. ' + shown(i) + (i.scoreText ? ' — ' + i.scoreText : '') + (i.blurb ? ' — ' + i.blurb.slice(0, 160) : ''));
    }
  };
  block('The week\'s biggest stories, most important first', picks.main || []);
  block(GROUP_HEAD.field, picks.field || []);
  // The example is invented on purpose: a real story in it would be told again every week.
  const system = [
    'You are JARVIS, telling ' + profile.userRef() + ' out loud what happened in AI and machine learning this week.',
    'Below are the week\'s biggest stories, most important first, then stories from the wider field, where new models and papers from smaller labs appear.',
    'For each numbered story write ONE short spoken sentence in your own words and in normal sentence case, saying who made it and what happened. Do not repeat the headline word for word.',
    'Keep every name and number exactly as the story writes it, never add a name or number the story does not have, and never name the website it was posted on. No links, no dates, do not address him.',
    'Example — story: "Lab A introduces Nova-7: a 7B model for on-device agents (by Lab A)" — sentence: "Lab A released Nova-7, a 7B model built to run agents on the device."',
    'Answer in JSON: {"sentences": [{"story": <its number>, "text": "<the sentence>"}]}.',
  ].join(' ');
  return { system, user: lines.join('\n'), numbered, schema: DRAFT_SCHEMA };
}

// Qwen-family models can wrap a reply in thinking tags; lists and markdown become one spoken paragraph.
function tidy(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*_#`]+/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Name-shaped words: anything with a digit, anything with two capitals (OpenAI, GPT, MIT), and any
// capitalised word past the first of its sentence. A possessive is cut at the apostrophe.
//
// THE FIRST WORD TOO, unless the week shows it is an ordinary word. A sentence starts with a capital
// whatever it is — "The", "Researchers" — but it is also where the model puts the MAKER, and
// "Microsoft released Gemini 3.8" went unchecked until a test caught it. So the first word is checked
// unless it appears in lower case somewhere in this week's stories (`ordinary`, their own statistics,
// web addresses removed first so "deepmind.google" does not make "Google" ordinary).
function nameTokens(sentence, ordinary) {
  const toks = String(sentence).split(/\s+/)
    .map(t => t.split(/['’]/)[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  return toks.filter((t, i) => /\p{N}/u.test(t) || /\p{Lu}[^\p{Lu}]*\p{Lu}/u.test(t) ||
    (/\p{Lu}/u.test(t) && (i > 0 || (ordinary && !ordinary.has(t.toLowerCase())))));
}
function ordinaryWords(items) {
  const set = new Set();
  for (const i of items) {
    const text = String(i.title || '') + ' ' + String(i.blurb || '');
    for (const chunk of text.split(/\s+/)) {
      if (/[\p{L}\p{N}][./][\p{L}\p{N}]|:\/\//u.test(chunk)) continue;          // a URL, a domain, a path
      for (const w of chunk.split(/[^\p{L}]+/u)) if (w && w === w.toLowerCase()) set.add(w);
    }
  }
  return set;
}
// THE SAME WORD IN ANOTHER FORM. The model writes "Google DeepMind Introduces Gemini…" in title case
// and the story says "Introducing": that dropped a true sentence in the third live run. A capitalised
// word counts as present when a story word starts the same way for at least five letters AND 70% of the
// longer of the two, differing in length by three at most — spelling shape, like edit distance.
// "introduces"/"introducing" share 8 of 11; "microsoft"/"microscope" share only 6 of 10, and do not
// match. Never for anything with a digit: "GPT-7" must match exactly, or an invented version would pass.
function sameWord(word, storyLow) {
  if (!/^\p{L}{5,}$/u.test(word)) return false;
  return storyLow.split(/[^\p{L}\p{N}]+/u).some(w => {
    if (w.length < 5 || Math.abs(w.length - word.length) > 3) return false;
    let k = 0;
    while (k < w.length && k < word.length && w[k] === word[k]) k++;
    return k >= 5 && k >= 0.7 * Math.max(w.length, word.length);
  });
}
function parseDraft(raw) {
  const s = String(raw || '');
  let j = null;
  try { j = JSON.parse(s); } catch (e) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { j = JSON.parse(m[0]); } catch (e2) { j = null; } }
  }
  if (!j || !Array.isArray(j.sentences)) return null;
  return j.sentences.map(e => ({ story: Number(e && e.story), text: tidy(e && e.text) })).filter(e => e.text);
}
// EVERY SENTENCE AGAINST THE ONE STORY IT NAMES. Every name-shaped word in it must be in that story's own
// text — its title, its description, its score, its maker. A sentence that fails is DROPPED, not the
// summary: one invented clause should cost that clause. What is left must still be a summary — three
// sentences at least, and something from the wider field when the week had any, because the ignored
// breakthroughs are what he asked for.
function checkDraft(raw, numbered, ordinary) {
  const entries = parseDraft(raw);
  if (!entries) return { ok: false, why: 'it did not answer in the form asked', kept: [], dropped: [] };
  const kept = [], dropped = [], seen = new Set();
  for (const e of entries.slice(0, 7)) {
    const item = numbered[e.story - 1];
    let why = null;
    if (!item) why = 'there is no story ' + e.story;
    else if (seen.has(e.story)) why = 'story ' + e.story + ' twice';
    else if (/https?:\/\/|www\./i.test(e.text)) why = 'a link';
    else {
      const t = storyText(item);
      const miss = [...new Set(nameTokens(e.text, ordinary).map(x => x.toLowerCase()))].filter(n => !t.includes(n) && !sameWord(n, t));
      if (miss.length) why = '"' + miss[0] + '" is not in story ' + e.story;
    }
    if (why) { dropped.push({ story: e.story, text: e.text, why }); continue; }
    seen.add(e.story);
    kept.push({ story: e.story, text: /[.!?]$/.test(e.text) ? e.text : e.text + '.', group: item.group });
  }
  if (kept.length < 3) return { ok: false, why: 'only ' + kept.length + ' of its sentences held up', kept, dropped };
  if (numbered.some(i => i.group === 'field') && !kept.some(k => k.group === 'field')) {
    return { ok: false, why: 'it left out the wider field', kept, dropped };
  }
  return { ok: true, text: kept.map(k => k.text).join(' '), kept, dropped };
}

// The fallback, and the fair one: real headlines, the announcements first, then the wider field.
function spokenTitle(i) {
  return i.kind === 'hf-models' && i.title.includes('/') ? i.title.split('/').slice(1).join('/') + ' from ' + i.org : i.title;
}
// A title carrying a version — letters and digits in one word ("GPT-6.1", "27B", "S2") or a decimal
// ("Gemini 3.8") — has the shape of a release. Those lead the fallback: the first live run's newest
// lab post was a customer story, and a release is what "what happened this week" means. Shape, not words.
const releaseShaped = t => String(t).split(/\s+/).some(w => (/\p{L}/u.test(w) && /\p{N}/u.test(w)) || /\d\.\d/.test(w));
// The same stories rankWeek chose for the model, read as they are.
function headlines(picks) {
  const say = i => i.source + ': ' + spokenTitle(i).replace(/[.!?]+$/, '') + (i.scoreText ? ', ' + i.scoreText : '') + '.';
  const parts = [];
  if ((picks.main || []).length) parts.push('The headlines. ' + picks.main.map(say).join(' '));
  if ((picks.field || []).length) parts.push('From the wider field. ' + picks.field.map(say).join(' '));
  return parts.join(' ');
}

// ---------------- the dream job ----------------
async function job(opts) {
  opts = opts || {};
  const free = opts.stillFree || (async () => true);
  const cfg = config();
  if (!cfg.enabled || !cfg.sources.length) return null;
  const s = load();
  if (!opts.force && s.lastRun && Date.now() - s.lastRun < FETCH_GAP) return null;
  const now = deps.now();

  const r = await gather(now, free);
  const added = merge(r.got, now.getTime());
  s.lastRun = Date.now();
  s.lastFailed = r.failed;
  s.lastEmpty = r.empty;
  if (r.failed.length) deps.jlog('AI news › ' + r.failed.length + ' source(s) failed: ' + r.failed.join('; ').slice(0, 300));

  const key = weekKey(now);
  const week = itemsOfWeek(key);
  const w = s.weeks[key] = s.weeks[key] || {};
  const sig = signature(week);
  let wrote = '';
  if (week.length && !w.presented && (w.sig !== sig || !w.short)) {
    const picks = rankWeek(week);
    let short = null, via = 'headlines', why = null, rejected = null, dropped = [];
    if (deps.llm && (await free())) {
      try {
        const p = promptFor(picks);
        const out = await deps.llm({ system: p.system, messages: [{ role: 'user', content: p.user }], schema: p.schema, max_tokens: 700, timeoutMs: 150000 });
        const c = checkDraft(out && out.text, p.numbered, ordinaryWords(week));
        dropped = c.dropped.map(d => d.text + ' — ' + d.why);
        if (dropped.length) deps.jlog('AI news › dropped ' + dropped.length + ' sentence(s): ' + c.dropped.map(d => d.why).join('; ').slice(0, 300));
        if (c.ok) { short = c.text; via = 'model'; }
        else { why = c.why; rejected = String((out && out.text) || '').slice(0, 4000); deps.jlog('AI news › the model\'s short version was not kept — ' + why); }
      } catch (e) { why = 'the model failed: ' + (e.message || e); }
    }
    if (!short) short = headlines(picks);
    // What was dropped, and a rejected draft, are kept beside the reason — a Sunday of headlines, or a
    // shorter summary than usual, can always be explained.
    Object.assign(w, {
      short, via, why, dropped, rejectedDraft: rejected, sig, builtAt: Date.now(),
      count: week.length, sources: new Set(week.map(i => i.source)).size,
    });
    wrote = via === 'model' ? '; wrote the short version' : '; the short version is the headlines' + (why ? ' (' + why + ')' : '');
  }
  const keys = Object.keys(s.weeks).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_WEEKS))) delete s.weeks[k];
  save();
  return 'read ' + (r.total - r.failed.length) + ' of ' + r.total + ' AI/ML sources — ' + week.length +
    ' stories this week' + (added ? ' (' + added + ' new)' : '') + wrote + (r.interrupted ? ', stopped early — you came back' : '');
}

// ---------------- Sunday ----------------
const say = w => ({ count: w.count, sources: w.sources });
const LINES = [
  n => 'It is Sunday, so here is the week in AI: I went through ' + n.count + ' stories from ' + n.sources +
    ' sources, the smaller labs included. Say "' + OFFER_WORD + '" for the short version.',
  n => 'Sunday — the week in AI and machine learning is ready: ' + n.count + ' stories from ' + n.sources +
    ' sources. Say "' + OFFER_WORD + '" and I will give you the short version.',
];
// Only on Sundays, only when dream mode has built this week, and only until he has heard it.
function greetingLine(now) {
  now = now || new Date();
  if (!isSunday(now)) return null;
  const w = load().weeks[weekKey(now)];
  if (!w || !w.short || w.presented || !w.count) return null;
  return LINES[Math.floor(weekBounds(weekKey(now)).start / (7 * DAY)) % LINES.length](say(w));
}

const fmtDay = ms => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const mdText = s => String(s).replace(/([[\]])/g, '\\$1');
function longForm(key, items, w) {
  const { start } = weekBounds(key);
  const head = new Date(start).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const lines = ['# AI & ML — the week of ' + head, '',
    items.length + ' stories from ' + w.sources + ' sources, gathered by JARVIS in dream mode.', '',
    '## The short version', '', w.short, ''];
  const order = config().sources.map(s => s.name);
  for (const g of groupsOf(items)) {
    lines.push('## ' + (GROUP_HEAD[g] || g), '');
    const names = [...new Set(items.filter(i => i.group === g).map(i => i.source))]
      .sort((a, b) => (order.indexOf(a) < 0 ? 1e9 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 1e9 : order.indexOf(b)));
    for (const n of names) {
      lines.push('### ' + n);
      const list = items.filter(i => i.source === n).sort((a, b) => ((b.score || 0) - (a.score || 0)) || (b.at - a.at));
      for (const i of list) {
        lines.push('- [' + mdText(i.title) + '](' + i.url + ') — ' + fmtDay(i.at) +
          (i.scoreText ? ' · ' + i.scoreText : '') + (i.org && i.org !== i.source ? ' · ' + i.org : ''));
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// He said the word. The short version is the reply (it is spoken, so no links in it); the full list
// is written to JARVIS Outputs, and the week is marked heard so Sunday does not offer it twice.
function present(now) {
  now = now || new Date();
  const s = load();
  const key = weekKey(now);
  const w = s.weeks[key];
  if (!w || !w.short) return null;
  const items = itemsOfWeek(key);
  let file = null;
  if (deps.outDir) {
    try {
      fs.mkdirSync(deps.outDir, { recursive: true });
      file = path.join(deps.outDir, 'AI-ML week of ' + key + '.md');
      fs.writeFileSync(file, longForm(key, items, w));
    } catch (e) { file = null; deps.jlog('AI news › could not write the full list: ' + (e.message || e)); }
  }
  w.presented = Date.now();
  save();
  const tail = file ? ' The full list — ' + items.length + ' stories from ' + w.sources + ' sources, with links — is in JARVIS Outputs.' : '';
  return { reply: w.short + tail, week: key, count: items.length, file };
}

function status(now) {
  const s = load();
  const w = s.weeks[weekKey(now || new Date())] || {};
  return {
    sources: config().sources.length, thisWeek: w.count || 0, ready: !!w.short, presented: !!w.presented,
    via: w.via || null, lastRun: s.lastRun || 0, failed: (s.lastFailed || []).length,
  };
}

module.exports = {
  init, job, greetingLine, present, status, OFFER_WORD,
  // exported for tests/test_ainews.js
  weekStart, weekKey, isSunday, parseFeed, parseHfPapers, parseHfModels, merge, itemsOfWeek, rankWeek, titleTokens,
  promptFor, tidy, nameTokens, ordinaryWords, checkDraft, headlines, longForm, gather, config,
};
