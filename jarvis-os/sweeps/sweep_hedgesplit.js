#!/usr/bin/env node
// sweep_hedgesplit.js — is replyhedge.saysGoLookItUp()'s split into sentences at . ! ? needed? (2026-10-08, his "test if
// this is needed"). Fixed before measuring: the same classifier (exemplars, all-minilm, margin, groups) reads
//   split    today's code: the first two and last two sentences, cut at . ! ?           (replyhedge.saysGoLookItUp)
//   heads    the first two and last two 16-word windows — position only, no punctuation
//   slide    every 16-word window, stepping 8 words
//   whole    the reply in one piece
// over every distinct real reply on disk (finetune/runs/bonsai_eval_*.jsonl chat sections + stock Bonsai's knowledge
// answers). Only replies where the four disagree are printed, to be labelled by hand; the two replies the file was built
// for and test_replyhedge.js's own cases are run too.
//   node sweeps/sweep_hedgesplit.js     → finetune/runs/hedgesplit_disagree.json
'use strict';
const fs = require('fs');
const path = require('path');
const intent = require('../intent.js');
const hedge = require('../replyhedge.js');
const F = p => path.join(__dirname, '..', '..', 'finetune', p);

const pool = new Set();
for (const f of fs.readdirSync(F('runs')).filter(f => /^bonsai_eval_.*\.jsonl$/.test(f) && !/_g\.jsonl$/.test(f) && !/stale/.test(f)))
  for (const l of fs.readFileSync(F('runs/' + f), 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.reply && r.section !== 'grounded' && r.section !== 'web') pool.add(String(r.reply).trim()); } catch (e) {}
  }
for (const f of ['data/v41_knowledge_answers.jsonl', 'data/bonsai_v2_stock_answers.jsonl'])
  for (const l of fs.readFileSync(F(f), 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.a) pool.add(String(r.a).trim()); } catch (e) {}
  }
const BUILT_FOR = [
  'The CEO of BlackRock as of recent information is Christopher A. "A. Chris" Garthwaite. However, for the most current and accurate information, I would recommend checking the official BlackRock website or a recent business news source.',
  "I don't have information about that.",
];

const cls = intent.makeClassifier({ exemplars: hedge.HEDGE_EXEMPLARS, minMargin: hedge.MIN_MARGIN, none: '__unused__', groups: hedge.GROUPS,
  model: 'all-minilm', label: 'HedgeSweep' });
async function anyWorld(parts) {
  for (const p of [...new Set(parts)]) { const r = await cls(p.slice(0, 200)); if (r && r.id === 'unknown_world') return true; }
  return false;
}
const words = t => String(t).split(/\s+/).filter(Boolean);
function windows(t, size, step) {
  const w = words(t), out = [];
  for (let s = 0; s < w.length; s += step) { out.push(w.slice(s, s + size).join(' ')); if (s + size >= w.length) break; }
  return out.length ? out : [String(t)];
}
const V = {
  split: t => hedge.saysGoLookItUp(t),
  heads: t => { const ws = windows(t, 16, 16); return anyWorld([...ws.slice(0, 2), ...ws.slice(-2)]); },
  slide: t => anyWorld(windows(t, 16, 8)),
  whole: t => anyWorld([String(t).slice(0, 1000)]),
};

(async () => {
  const texts = [...BUILT_FOR, ...pool];
  console.log('replies', texts.length);
  const res = [];
  for (const [k, t] of texts.entries()) {
    const r = { t };
    for (const [name, f] of Object.entries(V)) r[name] = await f(t);
    res.push(r);
    if (k < BUILT_FOR.length) console.log('built-for #' + k + ': ' + JSON.stringify(Object.fromEntries(Object.keys(V).map(n => [n, r[n]]))));
  }
  for (const n of Object.keys(V)) console.log(n.padEnd(6), 'fires on', res.filter(r => r[n]).length, 'of', res.length);
  const dis = res.filter(r => new Set(Object.keys(V).map(n => r[n])).size > 1);
  console.log('disagreements', dis.length);
  for (const [k, r] of dis.entries()) console.log('#' + k + ' ' + Object.keys(V).map(n => n + '=' + (r[n] ? 'Y' : '-')).join(' ') + '  ' + r.t.replace(/\s+/g, ' ').slice(0, 300));
  fs.writeFileSync(F('runs/hedgesplit_disagree.json'), JSON.stringify(dis, null, 1));
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
