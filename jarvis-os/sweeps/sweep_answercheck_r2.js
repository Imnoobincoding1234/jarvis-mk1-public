#!/usr/bin/env node
// sweep_answercheck_r2.js — round 2 of the answer check (finetune/README "Round 2 of the answer check"). Collects every
// feature for one set, item by item, in the order the lane would run them (answer prompt cached first), then writes
// them out for choose_answercheck_r2.js. Sources are rebuilt with the CURRENT grounded.js (word-cut clip).
//   node sweeps/sweep_answercheck_r2.js set1|set2 [jarvis|region|alone|3b]     (default: all phases, in that order)
// Phases are separate so each model is loaded once per phase (one model in memory at a time). Resumable per phase.
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../grounded.js');
const DR = require('./declineregion.js');
const F = p => path.join(__dirname, '..', '..', 'finetune', p);
const SET = process.argv[2];
const PHASES = process.argv[3] ? [process.argv[3]] : ['jarvis', 'region', 'alone', '3b'];
const SYSTEM = fs.readFileSync(F('runs/v42_check_replies.system.txt'), 'utf8');
const OUT = path.join(__dirname, '..', 'state', 'answercheck_r2_' + SET + '.json');

// set1: rebuilt from the cached Wikipedia responses (read-only); set2: from the raw hits + summary it keeps
let rows;
if (SET === 'set1') {
  const cache = JSON.parse(fs.readFileSync(F('data/wiki_cache.json'), 'utf8'));
  const rawFor = term => {
    const s = cache['https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + encodeURIComponent(term)];
    const hits = (s && s.query && s.query.search) || [];
    const sum = hits.length && cache['https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hits[0].title.replace(/ /g, '_'))];
    return sum && sum.extract ? { hits, summary: sum } : null;
  };
  const items = JSON.parse(fs.readFileSync(F('data/v42_check_heldout.json'), 'utf8')).items;
  const reps = new Map(fs.readFileSync(F('runs/v42_check_replies_r2.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.i, r.reply]));
  const labs = JSON.parse(fs.readFileSync(F('runs/v42_check_labels_r2.json'), 'utf8')).labels;
  rows = items.map((it, i) => { const raw = rawFor(it.page || it.query || it.q); return { i, q: it.q, source: raw && G.fromWikipedia(raw.hits, raw.summary), reply: reps.get(i), label: labs[i] && labs[i].label }; });
} else {
  const items = JSON.parse(fs.readFileSync(F('data/v42_check_heldout2.json'), 'utf8')).items;
  const reps = new Map(fs.readFileSync(F('runs/v42_check2_replies.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.i, r.reply]));
  const labs = JSON.parse(fs.readFileSync(F('runs/v42_check2_labels.json'), 'utf8')).labels;
  rows = items.map((it, i) => ({ i, q: it.q, source: it.raw ? G.fromWikipedia(it.raw.hits, it.raw.summary) : null, reply: reps.get(i), label: labs[i] && labs[i].label }));
}
rows = rows.filter(r => r.source && r.reply && r.label);

const YES = G.CHECK_YES, NO = G.CHECK_NO;
const ask = r => [{ role: 'system', content: SYSTEM }, { role: 'user', content: G.userMessage(r.q, r.source) }];
const FOLLOW = {
  after: r => G.checkMessages(ask(r), r.reply),
  cont: r => ask(r).concat([{ role: 'assistant', content: r.reply },
    { role: 'user', content: 'Check your reply against the SOURCE above. Does the SOURCE itself say what your reply says? Answer ' + YES + ' or ' + NO + '.' }]),
  answers: r => ask(r).concat([{ role: 'assistant', content: r.reply },
    { role: 'user', content: 'QUESTION: ' + r.q + '\nSTATEMENT: ' + r.reply + '\n\nDoes the STATEMENT answer the QUESTION? Answer ' + YES + ' or ' + NO + '.' }]),
  user2: r => ask(r).concat([{ role: 'user', content: 'STATEMENT: ' + r.reply + '\n\nDoes the SOURCE above state this? Answer ' + YES + ' or ' + NO + '.' }]),
};
const ALONE = r => [{ role: 'user', content: 'SOURCE (' + r.source.title + '):\n' + G.clip(r.source.text) + '\n\nSTATEMENT: ' + r.reply +
  '\n\nDoes the SOURCE state this? Answer ' + YES + ' or ' + NO + '.' }];
async function chat(model, messages, extra) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ model, think: false, stream: false, keep_alive: '60s', messages,
      options: { num_predict: 1, num_ctx: 4096, temperature: 0, use_mmap: true } }, extra || {})) });
  return res.json();
}
function ratio(j) {
  const v = G.checkVerdict(j.logprobs);
  return v ? { y: v.yes, n: v.no, r: Math.round(v.yes / (v.yes + v.no) * 1000) / 1000 } : { y: 0, n: 0, r: 0.5 };
}

(async () => {
  const feat = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const save = () => fs.writeFileSync(OUT, JSON.stringify(feat));
  console.log(SET, 'rows', rows.length);
  for (const phase of PHASES) {
    let n = 0;
    for (const r of rows) {
      const f = feat[r.i] = feat[r.i] || { label: r.label, q: r.q, reply: r.reply };
      if (phase === 'jarvis' && !f.after) {
        await chat('jarvis', ask(r));                                    // the answer prompt, as the lane just sent it
        for (const k of ['after', 'cont', 'answers', 'user2']) {
          const t0 = Date.now();
          const j = await chat('jarvis', FOLLOW[k](r), { logprobs: true, top_logprobs: 20 });
          f[k] = Object.assign(ratio(j), { ms: Date.now() - t0 });
        }
        n++;
      } else if (phase === 'region' && f.region === undefined) {
        const t0 = Date.now(); f.region = await DR.declineMargin(r.reply); f.regionMs = Date.now() - t0; n++;
      } else if (phase === 'alone' && !f.alone) {
        f.alone = ratio(await chat('jarvis', ALONE(r), { logprobs: true, top_logprobs: 20 })); n++;
      } else if (phase === '3b' && !f.q3b) {
        f.q3b = ratio(await chat('qwen2.5:3b-instruct-q4_K_M', ALONE(r), { logprobs: true, top_logprobs: 20 })); n++;
      }
      if (n && n % 10 === 0) { save(); process.stdout.write(phase + ' ' + n + '\n'); }
    }
    save();
    console.log(phase, 'done (' + n + ' new)');
  }
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
