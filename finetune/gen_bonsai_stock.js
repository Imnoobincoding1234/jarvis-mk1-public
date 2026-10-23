'use strict';
// STOCK Bonsai 4B's own answers to general questions — jarvis v2's rows against forgetting (2026-09-29).
// Training on the base model's own answers keeps what it already knows while the JARVIS rows change its
// manner. No single-fact questions (those teach memorisation — v1's "capital of japan" → "Ottawa"); no
// held-out question (data/jarvis_heldout_v2.json) — checked by build_bonsai_data_v2.js.
//
//   node gen_bonsai_stock.js     → data/bonsai_v2_stock_answers.jsonl (resumable; one model call per question)
//
// Thinking off, temperature 0, no system prompt, every answer read by hand before it is used (the live prompt makes stock Bonsai recite machine state).
// Kept only when it is a clean answer: no <think>, no "Okay, the user…" narration, finished (not cut at the
// token limit), 25+ words. Each call is short, so fetch() is fine.
const fs = require('fs');
const path = require('path');
const MODEL = process.env.STOCK_MODEL || 'hf.co/prism-ml/Bonsai-4B-gguf:Q1_0';
const Q = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'bonsai_v2_stock_questions.json'), 'utf8'));
const OUT = path.join(__dirname, 'data', 'bonsai_v2_stock_answers.jsonl');
// Asked for a reply's shape, not an essay: the first run (runs/bonsai_v2_stock_answers.essay-draft.jsonl) came back
// as markdown essays with headings, cut at the limit. The training row keeps only his question.
const ASK = '\n\n(Answer in 3 to 5 plain sentences. No markdown, no headings, no lists.)';
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).q) : []);
(async () => {
  let kept = 0, dropped = 0;
  for (const q of Q) {
    if (done.has(q)) continue;
    const t0 = Date.now();
    let body = null;
    try {
      const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: MODEL, stream: false, think: false, keep_alive: '5m',
        messages: [{ role: 'user', content: q + ASK }], options: { temperature: 0, num_predict: 220, num_ctx: 1024 } }) });
      body = await r.json();
    } catch (e) { console.log('ERR', q, e.message); continue; }
    const a = String((body && body.message && body.message.content) || '').trim();
    const why = /<think>/i.test(a) ? 'think' : /^(okay|ok|alright|so)[, ]+(the user|so|let me)/i.test(a) ? 'narration'
      : body.done_reason === 'length' ? 'cut' : a.split(/\s+/).length < 25 ? 'short' : '';
    fs.appendFileSync(OUT, JSON.stringify({ q, a, ok: !why, why, ms: Date.now() - t0 }) + '\n');
    why ? dropped++ : kept++;
    console.log((why || 'ok').padEnd(9), String(Date.now() - t0).padStart(6) + 'ms', q.slice(0, 60));
  }
  console.log('kept', kept, 'dropped', dropped);
})();
