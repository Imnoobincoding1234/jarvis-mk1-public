'use strict';
// Appends data/v41_web_heldout.jsonl to the v4.1 eval prompts as section 'web' (2026-10-04) — the same row shape v4's
// set had (built by hand then): the web agent's own system prompt + userMessage (jarvis-os/webagent.js), max 48 tokens,
// meta for score_web.js (target, op, value, split, website, answer). Run after build_bonsai_eval.js (which rewrites the file).
//   node build_web_eval_v41.js → appends to data/bonsai_eval_prompts_v41.jsonl
const fs = require('fs');
const path = require('path');
const A = require('../jarvis-os/webagent');
// v4.2: WEB_HELD / BONSAI_PROMPTS pick the held-out and the prompt file to append to
const F = path.join(__dirname, 'data', process.env.BONSAI_PROMPTS || 'bonsai_eval_prompts_v41.jsonl');
const have = fs.readFileSync(F, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
if (have.some(p => p.section === 'web')) { console.log('web prompts already there'); process.exit(0); }
const held = fs.readFileSync(path.join(__dirname, 'data', process.env.WEB_HELD || 'v41_web_heldout.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rows = held.map((r, i) => ({ section: 'web', i, q: r.task, max: 48,
  meta: { target: r.target, op: r.op, value: r.value, split: r.split, website: r.website, answer: r.answer },
  messages: [{ role: 'system', content: A.SYSTEM }, { role: 'user', content: A.userMessage(r.task, r.history, r.outline) }] }));
fs.appendFileSync(F, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log('appended', rows.length, 'web prompts');
