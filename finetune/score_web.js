#!/usr/bin/env node
// v4 web held-out scoring, 2026-10-02 — Mind2Web step metrics on OUR format: for each held-out step, did the
// model's ONE action (parsed by jarvis-os/webagent.js, the same parser the live agent uses) pick the right
// control (element accuracy), the right kind of action (op), and — for type/select — the right text (value)?
// Step success = all three. Invalid = the reply was not one action in the grammar. Split by unseen websites /
// unseen domains, as Mind2Web reports it.
//   BONSAI_PROMPTS=bonsai_eval_prompts_v4.jsonl node score_web.js <name> [<name> …]   (reads runs/bonsai_eval_<name>.jsonl)
const fs = require('fs');
const path = require('path');
const A = require('../jarvis-os/webagent');
const prompts = fs.readFileSync(path.join(__dirname, 'data', process.env.BONSAI_PROMPTS || 'bonsai_eval_prompts_v4.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(p => p.section === 'web');
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const lines = ['| model | steps | element | op | step success | invalid | unseen websites (success) | unseen domains (success) |', '|---|---|---|---|---|---|---|---|'];
for (const name of process.argv.slice(2)) {
  const ans = new Map(fs.readFileSync(path.join(__dirname, 'runs', 'bonsai_eval_' + name + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(a => a.section === 'web').map(a => [a.i, a]));
  const s = { n: 0, el: 0, op: 0, ok: 0, bad: 0, split: {} };
  for (const p of prompts) {
    const a = ans.get(p.i); if (!a) continue;
    s.n++; const sp = (s.split[p.meta.split] = s.split[p.meta.split] || { n: 0, ok: 0 }); sp.n++;
    const got = A.parseAction(a.reply);
    if (got.error) { s.bad++; continue; }
    const el = got.index === p.meta.target, op = got.op === p.meta.op;
    const val = !(p.meta.op === 'type' || p.meta.op === 'select') || norm(got.value) === norm(p.meta.value);
    if (el) s.el++; if (op) s.op++;
    if (el && op && val) { s.ok++; sp.ok++; }
  }
  const pc = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';
  const sw = s.split.test_website || { n: 0, ok: 0 }, sd = s.split.test_domain || { n: 0, ok: 0 };
  lines.push('| ' + name + ' | ' + s.n + ' | ' + pc(s.el, s.n) + ' | ' + pc(s.op, s.n) + ' | ' + pc(s.ok, s.n) + ' | ' + s.bad + ' | ' + pc(sw.ok, sw.n) + ' (' + sw.n + ') | ' + pc(sd.ok, sd.n) + ' (' + sd.n + ') |');
}
console.log(lines.join('\n'));
