#!/usr/bin/env node
// sweep_answercheck.js — every candidate replacement for grounded.supported(), measured on the FRESH held-out
// (finetune/data/v42_check_heldout.json, replies runs/v42_check_replies.jsonl, hand labels runs/v42_check_labels.json).
// Pre-registered in finetune/README "The answer check, redone by meaning": kept right ≥ old, sent on decline ≥ old,
// sent on memory + contra ≥ old, added median ≤ 1.5 s; thresholds chosen on one half (even/odd items), reported on the
// other half, both ways.
//
//   node sweeps/sweep_answercheck.js [old|hedge|region|embed|judge|all] [--dev]     (default all, the fresh set)
//
// Reads Ollama directly (jarvis for the judge, embedders for the rest). Never POSTs to JARVIS's /api/chat.
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../grounded.js');
const intent = require('../intent.js');
const replyhedge = require('../replyhedge.js');
const DR = require('./declineregion.js');   // round 1's step 2, kept for measuring

const F = p => path.join(__dirname, '..', '..', 'finetune', p);
const DEV = process.argv.includes('--dev');
const which = process.argv.slice(2).find(a => !a.startsWith('--')) || 'all';
// --dev: the 27 v4.2 sources and replies (already read while grading v4.2 — used ONLY to settle the judge's wording and
// to sanity-check the code before the fresh set is run once). Labels from reading each reply against its source.
const DEV_LABELS = { 0: 'right', 1: 'right', 2: 'right', 3: 'decline', 4: 'right', 5: 'decline', 6: 'sense', 7: 'right',
  8: 'right', 9: 'contra', 10: 'right', 11: 'right', 12: 'right', 13: 'right', 14: 'right', 15: 'right', 16: 'right',
  17: 'decline', 18: 'decline', 19: 'decline', 20: 'decline', 21: 'memory', 22: 'decline', 23: 'decline', 24: 'decline',
  25: 'memory', 26: 'decline' };
let rows;
if (DEV) {
  const items = JSON.parse(fs.readFileSync(F('data/v42_grounded_heldout.json'), 'utf8')).items;
  const reps = fs.readFileSync(F('runs/bonsai_eval_v42u690_g.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const prompts = fs.readFileSync(F('data/bonsai_eval_prompts_v42_grounded.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  rows = items.map((it, i) => ({ i, it, r: reps.find(r => r.i === i), lab: DEV_LABELS[i], msgs: prompts.find(p => p.i === i).messages }));
} else {
  const items = JSON.parse(fs.readFileSync(F('data/v42_check_heldout.json'), 'utf8')).items;
  const replies = new Map(fs.readFileSync(F('runs/v42_check_replies.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.i, r]));
  const labels = JSON.parse(fs.readFileSync(F('runs/v42_check_labels.json'), 'utf8')).labels;
  const SYSTEM = fs.readFileSync(F('runs/v42_check_replies.system.txt'), 'utf8');
  rows = items.map((it, i) => ({ i, it, r: replies.get(i), lab: labels[i] && labels[i].label,
    msgs: it.source ? [{ role: 'system', content: SYSTEM }, { role: 'user', content: G.userMessage(it.q, it.source) }] : null }))
    .filter(x => x.it.source && x.r && x.lab);
}
const WRONG = new Set(['memory', 'contra', 'sense']);

function tally(name, keepOf, subset) {
  const rs = subset || rows;
  const t = { right_kept: 0, right_sent: 0, decline_sent: 0, decline_kept: 0, wrong_sent: 0, wrong_kept: 0 };
  const keptWrong = [], sentRight = [];
  for (const x of rs) {
    const keep = keepOf(x);
    if (x.lab === 'right') { keep ? t.right_kept++ : (t.right_sent++, sentRight.push(x)); }
    else if (x.lab === 'decline') { keep ? (t.decline_kept++, keptWrong.push(x)) : t.decline_sent++; }
    else if (WRONG.has(x.lab)) { keep ? (t.wrong_kept++, keptWrong.push(x)) : t.wrong_sent++; }
  }
  return { name, t, keptWrong, sentRight };
}
function show(res, detail) {
  const t = res.t;
  console.log(res.name.padEnd(44), 'right kept', String(t.right_kept).padStart(3), '/', t.right_kept + t.right_sent,
    ' decline sent', String(t.decline_sent).padStart(3), '/', t.decline_sent + t.decline_kept,
    ' memory+contra sent', String(t.wrong_sent).padStart(3), '/', t.wrong_sent + t.wrong_kept);
  if (detail) {
    for (const x of res.keptWrong) console.log('      KEPT ' + x.lab.padEnd(7) + ' #' + x.i + ' ' + x.it.q + ' → ' + x.r.reply.slice(0, 110));
    for (const x of res.sentRight) console.log('      SENT right   #' + x.i + ' ' + x.it.q + ' → ' + x.r.reply.slice(0, 110));
  }
}
// the objective for choosing a threshold on one half: right kept + wrong sent on, ties to fewer wrong kept
const score = t => (t.right_kept + t.decline_sent + t.wrong_sent) * 1000 - (t.decline_kept + t.wrong_kept);
function twoFold(name, val, keepAt, grid) {
  const halves = [rows.filter(x => x.i % 2 === 0), rows.filter(x => x.i % 2 === 1)];
  const chosen = [];
  for (const [k, tune] of halves.entries()) {
    let best = null;
    for (const th of grid) { const s = score(tally('', x => keepAt(val(x), th), tune).t); if (!best || s > best.s) best = { th, s }; }
    chosen.push(best.th);
    show(tally(name + ' fold ' + (k ? 'odd→even' : 'even→odd') + ' @' + best.th.toFixed(3), x => keepAt(val(x), best.th), halves[1 - k]));
  }
  const mean = (chosen[0] + chosen[1]) / 2;
  const all = tally(name + ' all @' + mean.toFixed(3) + ' (mean of folds)', x => keepAt(val(x), mean));
  show(all, true);
  return mean;
}

// ---- (old) grounded.supported() — the capital-letter check, retired 2026-10-08. Its code is NOT kept here (his rule:
// no capitals-as-meaning, not even in a sweep); it lives in git at d993d88. Its numbers, measured by this sweep on the
// fresh set before it was removed (finetune/runs/sweep_answercheck_fresh.log): right kept 53/59, declines sent 35/38,
// memory+contra+sense sent 4/17; on --dev 13/13, 10/10, 2/4.
// ---- (a) the decline region: the model's own way of saying "the source does not answer that", by meaning.
// Exemplars from the training declines (data/bonsai_jarvis_v42) and the 27 v4.2 replies — never from the fresh set.
const DECLINE_EXEMPLARS = DR.DECLINE_EXEMPLARS;   // one source: round 1's shipped regions
const _region = {};
function regionClassifier(model) {
  if (!_region[model]) _region[model] = intent.makeClassifier({ exemplars: DECLINE_EXEMPLARS, minMargin: 0, none: '__unused__', model, label: 'Decline' });
  return _region[model];
}
// signed margin: + = decline, − = answer (minMargin 0 so the raw margin comes back)
async function declineMargin(model, text) {
  const r = await regionClassifier(model)(text);
  if (!r) return 0;
  return r.id === 'decline' ? r.margin : -r.margin;
}

// ---- (b) support by embedding: highest cosine between the reply and fixed-length word windows of the source
const WIN = 24, STRIDE = 8;
function windows(text) {
  const w = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  for (let s = 0; s < w.length; s += STRIDE) { out.push(w.slice(s, s + WIN).join(' ')); if (s + WIN >= w.length) break; }
  return out;
}
async function maxSupport(model, reply, source) {
  const rv = await intent.embed(reply.toLowerCase(), model);
  let best = -1;
  for (const win of windows(source)) { const v = await intent.embed(win.toLowerCase(), model); if (v && rv) best = Math.max(best, intent.cos(rv, v)); }
  return best;
}

// ---- (c) jarvis's own yes/no, as the next turn of the same conversation (the prefix is still cached)
const JUDGE_YES = 'yes', JUDGE_NO = 'no';
const JUDGE_ASK = 'Check your reply against the SOURCE above. Does the SOURCE itself say what your reply says? Answer ' + JUDGE_YES + ' or ' + JUDGE_NO + '.';
async function judgeCont(x, ask) {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jarvis', think: false, stream: false, keep_alive: '60s', logprobs: true, top_logprobs: 20,
      messages: x.msgs.concat([{ role: 'assistant', content: x.r.reply }, { role: 'user', content: ask || JUDGE_ASK }]),
      options: { num_predict: 1, num_ctx: 4096, temperature: 0, use_mmap: true } }) });
  const j = await r.json();
  const lp = (j.logprobs && j.logprobs[0]) || null;
  const alts = lp ? [lp].concat(lp.top_logprobs || []) : [];
  let py = 0, pn = 0; const seen = new Set();
  for (const a of alts) {
    if (!a || seen.has(a.token)) continue; seen.add(a.token);
    const tok = String(a.token).trim().toLowerCase();
    if (tok === JUDGE_YES) py += Math.exp(a.logprob); else if (tok === JUDGE_NO) pn += Math.exp(a.logprob);
  }
  return { py, pn, first: lp && lp.token, ms: Date.now() - t0, promptEval: j.prompt_eval_count, promptMs: Math.round((j.prompt_eval_duration || 0) / 1e6) };
}

// ---- (c2) a standalone judgement by jarvis: no system prompt, no "your reply" framing (self-agreement), only the
// source, the question and the reply. Two wordings, settled on the dev set before the fresh set is run once.
const JUDGE_PROMPTS = {
  statement: (x) => 'SOURCE (' + x.it.source.title + '):\n' + G.clip(x.it.source.text) + '\n\nSTATEMENT: ' + x.r.reply +
    '\n\nDoes the SOURCE state this? Answer ' + JUDGE_YES + ' or ' + JUDGE_NO + '.',
  answer: (x) => 'QUESTION: ' + x.it.q + '\nSOURCE (' + x.it.source.title + '):\n' + G.clip(x.it.source.text) + '\n\nREPLY: ' + x.r.reply +
    '\n\nDoes the SOURCE itself give this REPLY as the answer to the QUESTION? Answer ' + JUDGE_YES + ' or ' + JUDGE_NO + '.',
};
async function judgeAlone(x, variant, model) {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || 'jarvis', think: false, stream: false, keep_alive: '60s', logprobs: true, top_logprobs: 20,
      messages: [{ role: 'user', content: JUDGE_PROMPTS[variant](x) }],
      options: { num_predict: 1, num_ctx: 4096, temperature: 0, use_mmap: true } }) });
  const j = await r.json();
  const lp = (j.logprobs && j.logprobs[0]) || null;
  const alts = lp ? [lp].concat(lp.top_logprobs || []) : [];
  let py = 0, pn = 0; const seen = new Set();
  for (const a of alts) {
    if (!a || seen.has(a.token)) continue; seen.add(a.token);
    const tok = String(a.token).trim().toLowerCase();
    if (tok === JUDGE_YES) py += Math.exp(a.logprob); else if (tok === JUDGE_NO) pn += Math.exp(a.logprob);
  }
  return { py, pn, first: lp && lp.token, ms: Date.now() - t0, promptEval: j.prompt_eval_count, promptMs: Math.round((j.prompt_eval_duration || 0) / 1e6) };
}

// ---- (c3) the neutral wording, sent as a follow-up to the answer prompt so the system prompt + source stay cached.
// `warm` first replays the answer prompt (as the live lane just did), untimed, so the timing is the live one.
const FOLLOW = {
  user2: (x) => [...x.msgs, { role: 'user', content: 'STATEMENT: ' + x.r.reply + '\n\nDoes the SOURCE above state this? Answer ' + JUDGE_YES + ' or ' + JUDGE_NO + '.' }],
  after: (x) => G.checkMessages(x.msgs, x.r.reply),   // the shipped wording (identical to what was measured)
};
async function ollamaChat(messages, extra) {
  const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ model: 'jarvis', think: false, stream: false, keep_alive: '60s', messages,
      options: { num_predict: 1, num_ctx: 4096, temperature: 0, use_mmap: true } }, extra || {})) });
  return r.json();
}
function yesNo(j) {
  const lp = (j.logprobs && j.logprobs[0]) || null;
  const alts = lp ? [lp].concat(lp.top_logprobs || []) : [];
  let py = 0, pn = 0; const seen = new Set();
  for (const a of alts) {
    if (!a || seen.has(a.token)) continue; seen.add(a.token);
    const tok = String(a.token).trim().toLowerCase();
    if (tok === JUDGE_YES) py += Math.exp(a.logprob); else if (tok === JUDGE_NO) pn += Math.exp(a.logprob);
  }
  return { py, pn, first: lp && lp.token };
}
async function judgeFollow(x, variant) {
  await ollamaChat(x.msgs);                       // the answer prompt, as the lane just sent it (cached prefix)
  const t0 = Date.now();
  const j = await ollamaChat(FOLLOW[variant](x), { logprobs: true, top_logprobs: 20 });
  return Object.assign(yesNo(j), { ms: Date.now() - t0, promptEval: j.prompt_eval_count, promptMs: Math.round((j.prompt_eval_duration || 0) / 1e6) });
}

(async () => {
  const counts = {}; for (const x of rows) counts[x.lab] = (counts[x.lab] || 0) + 1;
  console.log('rows', rows.length, JSON.stringify(counts));
  const results = {};
  if (which === 'old' || which === 'all') console.log('old: grounded.supported (capitals, retired) — fresh 53/59, 35/38, 4/17; dev 13/13, 10/10, 2/4 (recorded, see above)');

  if (which === 'hedge' || which === 'all') {
    const hv = new Map();
    for (const x of rows) hv.set(x.i, await replyhedge.saysGoLookItUp(x.r.reply));
    show(tally('replyhedge.saysGoLookItUp as decline', x => !hv.get(x.i)), true);
  }

  if (which === 'region' || which === 'all') {
    for (const model of ['all-minilm', 'nomic-embed-text']) {
      const m = new Map();
      for (const x of rows) m.set(x.i, await declineMargin(model, x.r.reply));
      results['region_' + model] = m;
      show(tally('region ' + model + ' (decline if margin > 0)', x => !(m.get(x.i) > 0)));
      const grid = []; for (let t = -0.10; t <= 0.15; t += 0.005) grid.push(Math.round(t * 1000) / 1000);
      twoFold('region ' + model, x => m.get(x.i), (v, th) => !(v > th), grid);
    }
  }

  if (which === 'embed' || which === 'all') {
    for (const model of ['all-minilm', 'nomic-embed-text']) {
      const m = new Map();
      for (const x of rows) m.set(x.i, await maxSupport(model, x.r.reply, x.it.source.text));
      const grid = []; for (let t = 0.3; t <= 0.95; t += 0.01) grid.push(Math.round(t * 100) / 100);
      twoFold('embed support ' + model, x => m.get(x.i), (v, th) => v >= th, grid);
      for (const x of rows) console.log('      ' + model.slice(0, 5) + ' ' + m.get(x.i).toFixed(3) + ' ' + x.lab.padEnd(7) + ' #' + x.i + ' ' + x.r.reply.slice(0, 80));
    }
  }

  if (which === 'judge' || which === 'all') {
    const m = new Map(); const ms = [];
    for (const x of rows) {
      const j = await judgeCont(x);
      m.set(x.i, j); ms.push(j.ms);
      console.log('      judge yes ' + j.py.toFixed(3) + ' no ' + j.pn.toFixed(3) + ' first ' + JSON.stringify(j.first) + ' ' + j.ms + 'ms (prompt ' + j.promptEval + ' tok ' + j.promptMs + 'ms) ' + x.lab.padEnd(7) + ' #' + x.i + ' ' + x.r.reply.slice(0, 70));
    }
    ms.sort((a, b) => a - b);
    console.log('judge median ms', ms[ms.length >> 1]);
    show(tally('judge jarvis continuation (yes > no)', x => m.get(x.i).py > m.get(x.i).pn), true);
    fs.writeFileSync(path.join(__dirname, '..', 'state', 'sweep_answercheck.judge' + (DEV ? '.dev' : '') + '.json'), JSON.stringify([...m]));
  }
  for (const variant of Object.keys(JUDGE_PROMPTS)) {
    if (which !== 'alone' && which !== 'alone-' + variant && which !== 'all') continue;
    const model = process.env.JUDGE_MODEL || 'jarvis';
    const m = new Map(); const ms = [];
    for (const x of rows) {
      const j = await judgeAlone(x, variant, model);
      m.set(x.i, j); ms.push(j.ms);
      console.log('      ' + variant + ' yes ' + j.py.toFixed(3) + ' no ' + j.pn.toFixed(3) + ' first ' + JSON.stringify(j.first) + ' ' + j.ms + 'ms (prompt ' + j.promptEval + ' tok ' + j.promptMs + 'ms) ' + x.lab.padEnd(7) + ' #' + x.i + ' ' + x.r.reply.slice(0, 70));
    }
    ms.sort((a, b) => a - b);
    console.log(variant + ' median ms', ms[ms.length >> 1]);
    show(tally('judge ' + model + ' alone "' + variant + '" (yes > no)', x => m.get(x.i).py > m.get(x.i).pn), true);
    fs.writeFileSync(path.join(__dirname, '..', 'state', 'sweep_answercheck.' + variant + (DEV ? '.dev' : '') + '.json'), JSON.stringify([...m]));
  }
  for (const variant of Object.keys(FOLLOW)) {
    if (which !== 'follow' && which !== 'follow-' + variant && which !== 'all') continue;
    const m = new Map(); const ms = [];
    for (const x of rows) {
      const j = await judgeFollow(x, variant);
      m.set(x.i, j); ms.push(j.ms);
      console.log('      ' + variant + ' yes ' + j.py.toFixed(3) + ' no ' + j.pn.toFixed(3) + ' first ' + JSON.stringify(j.first) + ' ' + j.ms + 'ms (prompt ' + j.promptEval + ' tok ' + j.promptMs + 'ms) ' + x.lab.padEnd(7) + ' #' + x.i + ' ' + x.r.reply.slice(0, 70));
    }
    ms.sort((a, b) => a - b);
    console.log(variant + ' median ms', ms[ms.length >> 1]);
    show(tally('judge jarvis follow-up "' + variant + '" (yes > no)', x => m.get(x.i).py > m.get(x.i).pn), true);
    fs.writeFileSync(path.join(__dirname, '..', 'state', 'sweep_answercheck.follow_' + variant + (DEV ? '.dev' : '') + '.json'), JSON.stringify([...m]));
  }
  // (d) combinations, pre-registered: the decline region sends declines on, then a judge decides support. Uses the judge
  // results saved above (state/sweep_answercheck.<variant>.json); the region threshold is chosen on one half and
  // reported on the other, like every threshold here.
  if (which === 'combo' || which === 'all') {
    const m = new Map();
    for (const x of rows) m.set(x.i, await declineMargin('nomic-embed-text', x.r.reply));
    const grid = []; for (let t = -0.10; t <= 0.15; t += 0.005) grid.push(Math.round(t * 1000) / 1000);
    for (const v of ['follow_user2', 'statement', 'follow_after', 'judge']) {
      const f = path.join(__dirname, '..', 'state', 'sweep_answercheck.' + v + (DEV ? '.dev' : '') + '.json');
      if (!fs.existsSync(f)) continue;
      const jm = new Map(JSON.parse(fs.readFileSync(f, 'utf8')));
      const judgeOk = i => { const j = jm.get(i); return !!j && j.py > j.pn; };
      show(tally('combo region nomic @0 + judge ' + v, x => !(m.get(x.i) > 0) && judgeOk(x.i)), true);
      twoFold('combo region nomic + judge ' + v, x => ({ g: m.get(x.i), ok: judgeOk(x.i) }), (val, th) => !(val.g > th) && val.ok, grid);
    }
  }
  // LATENCY of the chosen order, as the lane would run it: the answer (untimed — the lane already pays it), then the
  // "after" judge on the warm cache, then — only if the judge said yes — the nomic decline region (loading nomic evicts
  // jarvis; the next chat turn starts by loading the embedders anyway). Every 5th fresh item.
  if (which === 'latency') {
    const ms = [], judgeMs = [], regionMs = [];
    for (const x of rows.filter((_, k) => k % 5 === 0)) {
      await ollamaChat(x.msgs, { options: { num_predict: 400, num_ctx: 4096, temperature: 0, use_mmap: true } });   // the answer, as live
      const t0 = Date.now();
      const j = await ollamaChat(FOLLOW.after(x), { logprobs: true, top_logprobs: 20 });
      const v = yesNo(j);
      const t1 = Date.now();
      let g = null;
      if (v.py > v.pn) g = await declineMargin('nomic-embed-text', x.r.reply + ' ');   // trailing space: not the classifier's cached key
      const t2 = Date.now();
      ms.push(t2 - t0); judgeMs.push(t1 - t0); if (g !== null) regionMs.push(t2 - t1);
      console.log('      ' + (t2 - t0) + 'ms  judge ' + (t1 - t0) + 'ms' + (g !== null ? '  region ' + (t2 - t1) + 'ms' : '  (judge said no)') + '  #' + x.i);
    }
    const med = a => { const b = [...a].sort((p, q) => p - q); return b.length ? b[b.length >> 1] : null; };
    console.log('added median ' + med(ms) + 'ms (judge ' + med(judgeMs) + ', region when run ' + med(regionMs) + ') over ' + ms.length);
  }
  // SHIPPED: grounded.checkMessages + checkVerdict — the production functions, end to end (since round 2: the judge
  // alone, keep when P(yes) share > grounded.CHECK_AT). Round 1's production (+ declineregion.declines) reproduced
  // 54/59, 38/38, 8/17 on the round-1 replies.
  if (which === 'shipped') {
    const keep = new Map();
    for (const x of rows) {
      const j = await ollamaChat(G.checkMessages(x.msgs, x.r.reply), { logprobs: true, top_logprobs: 20 });
      const v = G.checkVerdict(j.logprobs);
      keep.set(x.i, !!(v && v.ok));
    }
    show(tally('SHIPPED grounded check (judge, keep when P(yes) share > ' + G.CHECK_AT + ')', x => keep.get(x.i)), true);
  }
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });

module.exports = { DECLINE_EXEMPLARS, windows };
