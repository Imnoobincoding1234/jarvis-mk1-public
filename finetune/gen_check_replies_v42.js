#!/usr/bin/env node
// jarvis's replies to the fresh answer-check held-out (data/v42_check_heldout.json), 2026-10-08 — generated exactly as
// the live Wikipedia lane does (server.js groundedAnswer): model `jarvis`, Ollama native /api/chat, think off, the live
// system prompt (server.js systemPrompt(null), captured once and saved with the run so the run can be redone), the
// grounded.js contract message, num_ctx / num_predict from modelprofile.js for that model, temperature 0 (the Modelfile's;
// sent explicitly here), the reply passed through the same markdown strip. Greedy, so a rerun gives the same replies.
// Resumable: items already in the output file are skipped. Ollama only — never POST /api/chat on JARVIS (eval turns act
// and land in his memory). Items with no source are skipped: the live lane sends those straight to research.
//   node gen_check_replies_v42.js → runs/v42_check_replies.jsonl (+ runs/v42_check_replies.system.txt)
//   node gen_check_replies_v42.js set2 → runs/v42_check2_replies.jsonl: the confirmation set, each source rebuilt from its kept
//     raw hits + summary with the current grounded.js (word-cut clip), the same saved system prompt as set 1.
const fs = require('fs');
const path = require('path');
const G = require('../jarvis-os/grounded.js');
const MP = require('../jarvis-os/modelprofile.js');

const MODEL = process.env.CHECK_MODEL || 'jarvis';
const SET2 = process.argv[2] === 'set2';
const OUT = path.join(__dirname, 'runs', SET2 ? 'v42_check2_replies.jsonl' : 'v42_check_replies.jsonl');
const SYS = path.join(__dirname, 'runs', 'v42_check_replies.system.txt');
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', SET2 ? 'v42_check_heldout2.json' : 'v42_check_heldout.json'), 'utf8')).items
  .map(it => SET2 && it.raw ? Object.assign({}, it, { source: G.fromWikipedia(it.raw.hits, it.raw.summary) }) : it);

// server.js plainText, copied: the lane runs the reply through it before checking.
function plainText(s) {
  return String(s || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*\*(\S(?:[^*]*\S)?)\*\*\*/g, '$1')
    .replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '$1')
    .replace(/(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])__(\S(?:[^_]*\S)?)__(?![\w_])/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

(async () => {
  let system;
  if (fs.existsSync(SYS)) system = fs.readFileSync(SYS, 'utf8');
  else {
    const J = require('../jarvis-os/server.js');
    system = await J._systemPrompt(null);
    fs.writeFileSync(SYS, system);
  }
  const prof = MP.profileFor(MODEL);
  const numCtx = MP.ctxFor(prof, 4096);
  const numPredict = MP.fitTokens(prof, 160, numCtx);
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).i) : []);
  console.log('model', MODEL, 'ctx', numCtx, 'predict', numPredict, 'system', system.length, 'chars; done', done.size);
  for (const [i, it] of items.entries()) {
    if (done.has(i) || !it.source) continue;
    const t0 = Date.now();
    const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, think: false, stream: false, keep_alive: '60s',
        messages: [{ role: 'system', content: system }, { role: 'user', content: G.userMessage(it.q, it.source) }],
        options: { num_predict: numPredict, num_ctx: numCtx, temperature: 0, use_mmap: true } }) });
    if (!r.ok) throw new Error('ollama HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const reply = plainText((j.message && j.message.content) || '');
    fs.appendFileSync(OUT, JSON.stringify({ i, q: it.q, reply, ms: Date.now() - t0 }) + '\n');
    console.log(String(i).padStart(3), (Date.now() - t0) + 'ms', it.q, '\n     → ' + reply);
  }
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
