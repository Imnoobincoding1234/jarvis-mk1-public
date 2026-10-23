'use strict';
// jarvis v4.1 GROUNDED rows, step 1 of 2 (2026-10-04): for every knowledge question (data/v41_knowledge_questions.json),
// fetch a live Wikipedia source (wikifetch.js → jarvis-os/grounded.js fromWikipedia, the live contract) and ask STOCK
// Bonsai to answer from it (grounded.js userMessage — no system prompt, thinking off, temperature 0, like
// gen_v41_knowledge.js). Written AFTER data/v41_grounded_heldout.json; no held-out question is asked.
// Every answer is then read by hand (data/v41_grounded_review.json): kept only when the source holds the answer and the
// reply takes it from the source; when the source does NOT hold the answer the row's reply becomes an honest "the source
// does not say" (step 2, build_bonsai_data_v41.js) — never my answer to the question.
//   node gen_grounded_v41.js     → data/v41_grounded_answers.jsonl (resumable)
const fs = require('fs');
const path = require('path');
const G = require('../jarvis-os/grounded');
const WF = require('./wikifetch');
const MODEL = process.env.STOCK_MODEL || 'hf.co/prism-ml/Bonsai-4B-gguf:Q1_0';
const D = f => path.join(__dirname, 'data', f);
// v4.2 (2026-10-05): GROUNDED_QUESTIONS / GROUNDED_OUT pick another question set (data/v42_grounded_questions.json → v42_grounded_answers.jsonl)
const Q = JSON.parse(fs.readFileSync(D(process.env.GROUNDED_QUESTIONS || 'v41_knowledge_questions.json'), 'utf8')).topics;
const held = new Set(['v41_grounded_heldout.json', 'v42_grounded_heldout.json'].filter(f => fs.existsSync(D(f))).flatMap(f => JSON.parse(fs.readFileSync(D(f), 'utf8')).items.map(r => r.q)));
const OUT = D(process.env.GROUNDED_OUT || 'v41_grounded_answers.jsonl');
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).q) : []);
(async () => {
  let n = 0;
  for (const [topic, qs] of Object.entries(Q)) for (const { q, hi } of qs) {
    if (done.has(q) || held.has(q)) continue;
    let src = null;
    try { src = await WF.lookup(q); } catch (e) { console.log('ERR fetch', q, e.message); continue; }
    if (!src) { fs.appendFileSync(OUT, JSON.stringify({ topic, q, hi: hi || null, source: null }) + '\n'); console.log('nosrc    ', q); continue; }
    const prompt = G.userMessage(q, src.source);
    const t0 = Date.now();
    let body = null;
    try {
      const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: MODEL, stream: false, think: false, keep_alive: '5m',
        messages: [{ role: 'user', content: prompt }], options: { temperature: 0, num_predict: 120, num_ctx: 2048 } }) });
      body = await r.json();
    } catch (e) { console.log('ERR model', q, e.message); continue; }
    const a = String((body && body.message && body.message.content) || '').trim();
    fs.appendFileSync(OUT, JSON.stringify({ topic, q, hi: hi || null, source: src.source, a, cut: body.done_reason === 'length', ms: Date.now() - t0 }) + '\n');
    console.log(String(++n).padStart(4), String(Date.now() - t0).padStart(6) + 'ms', src.source.title.slice(0, 30).padEnd(30), q.slice(0, 50));
  }
  console.log('done');
})();
