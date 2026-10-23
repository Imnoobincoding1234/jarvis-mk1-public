'use strict';
// MEASUREMENT SCRIPT — not a test. Can EMBEDDERS ALONE say what kind of thing a request names?
//
// No 3B, no word list. Every contiguous span of the sentence is offered by POSITION (the appIn()
// shape §0 points at), each span is embedded, and the span that sits closest to one of the
// prototype regions is the thing — its region is the kind. The prototypes are embedded and
// compared by cosine, never matched literally.
//
// Two numbers matter and are reported separately:
//   COARSE   edible / durable / music / video — embedders are known to be good at this
//   FINE     cooked dish vs raw ingredient — three embedders were measured failing at this before;
//            anything uncertain here is ASKED once and remembered, so what counts is WRONG, not missed

const ollama = require('../ollama.js');
const itemclass = require('../itemclass.js');

const P = itemclass.PROTOTYPES;
const REGIONS_OLD = {
  dish:       P.grocery.slice(0, 16),          // itemclass's cooked-food half
  ingredient: P.grocery.slice(16),             // its raw-ingredient half
  durable:    P.marketplace,
  music:      ['a song', 'an album', 'a playlist', 'music by an artist', 'a track', 'a band'],
  video:      ['a video', 'a movie trailer', 'an episode', 'a documentary', 'a film', 'a youtube clip'],
};
const REGIONS = require('../errand.js').KIND_REGIONS;
const COARSE = { dish: 'edible', ingredient: 'edible', 'durable-electronics': 'durable', 'durable-wearable': 'durable', 'durable-home': 'durable', music: 'music', video: 'video' };
const FINE = { dish: 'food', ingredient: 'grocery', 'durable-electronics': 'shop', 'durable-wearable': 'shop', 'durable-home': 'shop', music: 'music', video: 'video' };

// Held out: every sentence written for sweep_errand.js before any number was read, plus the live
// failures from his log. Expected fine kind; COARSE derives from it.
const CASES = [
  ['order me momos', 'food'], ['order hiking boots', 'shop'], ['order dinner', 'food'],
  ['play judas by lady gaga', 'music'], ['play the latest yessmartypie video', 'video'],
  ['order me some samosas', 'food'], ['get me a chicken biryani', 'food'],
  ['order two plates of chole bhature', 'food'], ['i want a shawarma', 'food'],
  ['order a masala dosa', 'food'], ['order some butter chicken tonight', 'food'],
  ['order some atta', 'grocery'], ['buy 2kg onions', 'grocery'], ['order a packet of toor dal', 'grocery'],
  ['get me some anjeer', 'grocery'], ['buy me a watermelon', 'grocery'], ['order chicken breast', 'grocery'],
  ['buy cat food', 'grocery'], ['order dog food', 'grocery'], ['order coffee beans', 'grocery'],
  ['buy a mechanical keyboard', 'shop'], ['order a standing desk', 'shop'],
  ['buy me some running shoes', 'shop'], ['order a new bedsheet', 'shop'],
  ['play some lofi beats', 'music'], ['put on bohemian rhapsody', 'music'],
  ['play the new kendrick album', 'music'], ['play the latest mrbeast video', 'video'],
  ['watch the oppenheimer trailer', 'video'], ['put on a documentary about everest', 'video'],
  ['order me gulab jamoon', 'food'], ['get me some rasgulla', 'food'], ['order me a kaju katli', 'food'],
  ['order some haldi', 'grocery'], ['buy besan', 'grocery'], ['order rasmalai', 'food'],
  // held out, added now: possessives and apostrophes, the shape that stranded the greedy search
  ["play yessmartypie's latest video", 'video'], ["put on taylor swift's new album", 'music'],
  ["watch mkbhd's review of the iphone", 'video'], ["order dominos' farmhouse pizza", 'food'],
  ["buy my brother's birthday gift card", 'shop'],
];

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cos = (a, b) => { const d = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b)); return d ? dot(a, b) / d : 0; };
const memo = new Map();
async function emb(t, model) {
  const k = model + '|' + t; if (memo.has(k)) return memo.get(k);
  const r = await ollama.embed(t, { model, keepAlive: '60s', numCtx: 512 });
  const v = r && r.v ? r.v : null; memo.set(k, v); return v;
}
async function centroids(model) {
  const out = {};
  for (const [id, ex] of Object.entries(REGIONS)) {
    const vs = []; for (const e of ex) { const v = await emb(e, model); if (v) vs.push(v); }
    out[id] = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
  }
  return out;
}
// Every contiguous span, by position only.
function spans(s, maxLen) {
  const w = s.split(' ').filter(Boolean), out = [];
  for (let i = 0; i < w.length; i++) for (let n = 1; n <= maxLen && i + n <= w.length; n++) out.push(w.slice(i, i + n).join(' '));
  return out;
}

// ---------------------------------------------------------------------------
// CHOOSING THE SPAN — two list-free readers.
// ---------------------------------------------------------------------------
// LEXICAL: inverse document frequency over HIS OWN messages. Nothing is written down by hand; a
// word is scaffolding because he says it constantly, and content because he rarely does. A word he
// has never typed gets the highest weight there is.
const fs = require('fs');
const LOGS = require('path').join(__dirname, '..', 'logs');   // jarvis-os/logs, wherever this is run from
function buildIdf() {
  const docs = [];
  for (const f of fs.readdirSync(LOGS).filter(f => f.startsWith('jarvisos.log'))) {
    for (const line of fs.readFileSync(require('path').join(LOGS, f), 'utf8').split('\n')) {
      const i = line.indexOf('Chat › '); if (i < 0) continue;
      docs.push(new Set(line.slice(i + 7).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
    }
  }
  const df = new Map(); for (const d of docs) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length;
  return w => Math.log((N + 1) / ((df.get(w) || 0) + 1));
}
const toks = s => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// Content runs: contiguous tokens weighted above the sentence's OWN mean — relative to the sentence,
// so there is no global constant to tune.
function idfSpans(s, idf) {
  const t = toks(s); if (!t.length) return [];
  const w = t.map(idf), mean = w.reduce((a, b) => a + b, 0) / w.length;
  const runs = []; let cur = [];
  for (let i = 0; i < t.length; i++) { if (w[i] > mean) cur.push(t[i]); else { if (cur.length) runs.push(cur.join(' ')); cur = []; } }
  if (cur.length) runs.push(cur.join(' '));
  return runs;
}
// SEMANTIC: occlusion. The span whose removal moves the sentence furthest from where it was.
async function occlusionSpan(s, model) {
  const full = await emb(s, model); const t = toks(s);
  let best = null;
  for (let i = 0; i < t.length; i++) for (let n = 1; n <= 4 && i + n <= t.length; n++) {
    const rest = t.slice(0, i).concat(t.slice(i + n)).join(' ');
    if (!rest) continue;
    const v = await emb(rest, model); if (!v) continue;
    const drop = 1 - cos(full, v);
    // normalised per token, or the whole sentence minus one word always wins
    const score = drop / n;
    if (!best || score > best.score) best = { span: t.slice(i, i + n).join(' '), score };
  }
  return best ? [best.span] : [];
}

async function kindOfSpans(spansList, C, model) {
  let best = null;
  for (const sp of spansList) {
    const v = await emb(sp, model); if (!v) continue;
    const sc = Object.entries(C).map(([id, cv]) => ({ id, s: cos(v, cv) })).sort((a, b) => b.s - a.s);
    const coarseRival = sc.find(x => COARSE[x.id] !== COARSE[sc[0].id]);
    const cand = { span: sp, id: sc[0].id, sim: sc[0].s, fine: sc[0].s - sc[1].s,
                   coarse: sc[0].s - (coarseRival ? coarseRival.s : 0) };
    if (!best || cand.coarse > best.coarse) best = cand;
  }
  return best;
}

// GROW / TRIM A SEED BY CONFIDENCE. Start from each IDF run, try one token more or less on either
// edge, keep the change only if the COARSE margin rises. Position and the embedder decide; nothing
// else. This is what should recover "butter" -> "butter chicken" and "cat" -> "cat food" without
// knowing a single word.
async function scoreSpan(sp, C, model, allowed) {
  const v = await emb(sp, model); if (!v) return null;
  const sc = Object.entries(C).filter(([id]) => !allowed || allowed.includes(COARSE[id]))
    .map(([id, cv]) => ({ id, s: cos(v, cv) })).sort((a, b) => b.s - a.s);
  const coarseRival = sc.find(x => COARSE[x.id] !== COARSE[sc[0].id]);
  return { span: sp, id: sc[0].id, sim: sc[0].s, fine: sc[0].s - sc[1].s,
           coarse: coarseRival ? sc[0].s - coarseRival.s : sc[0].s - sc[1].s };
}
async function grown(s, idf, C, model, allowed) {
  const t = toks(s); if (!t.length) return null;
  const w = t.map(idf), mean = w.reduce((a, b) => a + b, 0) / w.length;
  const seeds = []; let st = -1;
  for (let i = 0; i <= t.length; i++) {
    if (i < t.length && w[i] > mean) { if (st < 0) st = i; }
    else if (st >= 0) { seeds.push([st, i]); st = -1; }
  }
  let best = null;
  for (let [a, b] of seeds) {
    let cur = await scoreSpan(t.slice(a, b).join(' '), C, model, allowed);
    for (let step = 0; step < 4 && cur; step++) {
      const moves = [[a - 1, b], [a, b + 1], [a + 1, b], [a, b - 1]].filter(([x, y]) => x >= 0 && y <= t.length && y - x >= 1);
      let improved = null;
      for (const [x, y] of moves) {
        const c = await scoreSpan(t.slice(x, y).join(' '), C, model, allowed);
        if (c && c.coarse > cur.coarse + 1e-9 && (!improved || c.coarse > improved.c.coarse)) improved = { c, x, y };
      }
      if (!improved) break;
      cur = improved.c; a = improved.x; b = improved.y;
    }
    if (cur && (!best || cur.coarse > best.coarse)) best = cur;
  }
  return best;
}

// WINDOW SEARCH: every span that contains a seed token, up to W tokens either side, best margin wins.
// Exhaustive within the window, so it cannot stall on a worse intermediate span the way greedy growth
// does — "yessmartypie" -> "yessmartypie s" got LESS confident and greedy stopped short of "video".
const W = 3;
async function windowed(s, idf, C, model, allowed) {
  const t = toks(s); if (!t.length) return null;
  const w = t.map(idf), mean = w.reduce((a, b) => a + b, 0) / w.length;
  const seedIdx = t.map((_, i) => i).filter(i => w[i] > mean + 1e-9);
  const idx = seedIdx.length ? seedIdx : t.map((_, i) => i);
  let best = null; const tried = new Set();
  for (const i of idx) for (let a = Math.max(0, i - W); a <= i; a++) for (let b = i + 1; b <= Math.min(t.length, i + 1 + W); b++) {
    const k = a + ':' + b; if (tried.has(k)) continue; tried.add(k);
    const c = await scoreSpan(t.slice(a, b).join(' '), C, model, allowed);
    if (c && (!best || c.coarse > best.coarse)) best = c;
  }
  return best;
}
(async () => {
  const idf = buildIdf();
  for (const model of ['all-minilm']) {
    const C = await centroids(model);
    // THE FRAME COMES FROM THE GATE THAT ALREADY RUNS — errand.js's embedder regions. A request in the
    // play region can only name music or video; one in the get region only edible or durable goods.
    const intent = require('../intent.js');
    const E = require('../errand.js');
    const gate = intent.makeClassifier({ exemplars: E.EXEMPLARS, groups: E.GROUPS, none: 'none', minMargin: 0 });
    const rows = [];
    for (const [s, want] of CASES) {
      const g = await gate(s);
      const allowed = g && g.id === 'play-something' ? ['music', 'video'] : g && g.id === 'get-something' ? ['edible', 'durable'] : null;
      const pick = process.env.SEARCH === 'window' ? windowed : grown;
      rows.push({ s, want, frame: g && g.id, ...((await pick(s, idf, C, model, allowed)) || { span: '(none)', id: null, coarse: -1, fine: -1 }) });
    }
    const off = rows.filter(r => r.frame !== ((r.want === 'music' || r.want === 'video') ? 'play-something' : 'get-something'));
    console.log('  frame wrong for ' + off.length + ': ' + off.map(r => '"' + r.s + '" → ' + r.frame).join(', '));
    console.log('\n===== ' + model + ' / IDF seed, grown by confidence =====');
    console.log('  spans: ' + rows.map(r => r.span).join(' | '));
    for (const t of [0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
      let cOk = 0, cWrong = 0, cAbst = 0; const wrong = [];
      for (const r of rows) {
        const wantCoarse = COARSE[Object.keys(FINE).find(k => FINE[k] === r.want)];
        if (!r.id || r.coarse < t) cAbst++;
        else if (COARSE[r.id] === wantCoarse) cOk++;
        else { cWrong++; wrong.push('"' + r.s + '" [' + r.span + '] → ' + COARSE[r.id] + ' (' + r.coarse.toFixed(3) + ')'); }
      }
      console.log('  t=' + t.toFixed(2) + '  COARSE ok ' + cOk + '  WRONG ' + cWrong + '  abstain ' + cAbst + (wrong.length ? '\n      ' + wrong.join('\n      ') : ''));
    }
  }
})();
