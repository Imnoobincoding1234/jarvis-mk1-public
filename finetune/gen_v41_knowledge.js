'use strict';
// jarvis v4.1 knowledge rows = STOCK Bonsai 4B's own answers (self-distillation), 2026-10-04.
// Why: stock Bonsai answers "capital city of australia?" with Canberra; v4 answered Sydney. The knowledge was there and
// training wore it down (54 of v4's 2,760 rows carried general knowledge). Replaying the base model's OWN correct answers
// keeps it; writing my answers instead would teach new single facts, which v1 memorised and misfired on.
//
//   node gen_v41_knowledge.js     → data/v41_knowledge_answers.jsonl (resumable; one model call per question)
//
// Questions: data/v41_knowledge_questions.json (written after the v4.1 held-outs; no held-out fact). Asked in ENGLISH
// with no system prompt, thinking off, temperature 0, for one or two plain sentences. Every answer is read by hand
// (data/v41_knowledge_review.json); a wrong answer drops the question — it is never replaced with my answer.
// Machine flags here only catch the shape: <think>, narration, cut at the limit, markdown, empty.
const fs = require('fs');
const path = require('path');
const MODEL = process.env.STOCK_MODEL || 'hf.co/prism-ml/Bonsai-4B-gguf:Q1_0';
const Q = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'v41_knowledge_questions.json'), 'utf8')).topics;
const OUT = path.join(__dirname, 'data', 'v41_knowledge_answers.jsonl');
const ASK = '\n\n(Answer in one or two plain sentences. No markdown.)';
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).q) : []);
(async () => {
  let kept = 0, flagged = 0;
  for (const [topic, qs] of Object.entries(Q)) for (const { q, hi } of qs) {
    if (done.has(q)) continue;
    const t0 = Date.now();
    let body = null;
    try {
      const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: MODEL, stream: false, think: false, keep_alive: '5m',
        messages: [{ role: 'user', content: q + ASK }], options: { temperature: 0, num_predict: 120, num_ctx: 1024 } }) });
      body = await r.json();
    } catch (e) { console.log('ERR', q, e.message); continue; }
    const a = String((body && body.message && body.message.content) || '').trim();
    const why = !a ? 'empty' : /<think>/i.test(a) ? 'think' : /^(okay|ok|alright|so)[, ]+(the user|so|let me)/i.test(a) ? 'narration'
      : body.done_reason === 'length' ? 'cut' : /[*#`]|^\s*[-•]\s/m.test(a) ? 'markdown' : '';
    fs.appendFileSync(OUT, JSON.stringify({ topic, q, hi: hi || null, a, flag: why, ms: Date.now() - t0 }) + '\n');
    why ? flagged++ : kept++;
    console.log((why || 'ok').padEnd(9), String(Date.now() - t0).padStart(6) + 'ms', q.slice(0, 60));
  }
  console.log('clean', kept, 'flagged', flagged);
})();
