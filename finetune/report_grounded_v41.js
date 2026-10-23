'use strict';
// Side-by-side replies on the grounded held-out (data/bonsai_eval_prompts_v41_grounded.jsonl) for hand-grading, 2026-10-04.
// Prints, per item: the question, the source page, what a right reply is (the `must` word, or "decline"), and each model's
// reply, with an automatic hint only (must-word present / a decline phrase present) — the grade is by hand, every reply read.
//   node report_grounded_v41.js <name> [<name> …]   → runs/bonsai_v41_grounded_report.md (reads runs/bonsai_eval_<name>.jsonl)
const fs = require('fs');
const path = require('path');
// v4.2: GROUNDED_PROMPTS / GROUNDED_REPORT pick the set and the report file
const P = fs.readFileSync(path.join(__dirname, 'data', process.env.GROUNDED_PROMPTS || 'bonsai_eval_prompts_v41_grounded.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const names = process.argv.slice(2);
const ans = {};
for (const n of names) ans[n] = new Map(fs.readFileSync(path.join(__dirname, 'runs', 'bonsai_eval_' + n + '.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(a => a.section === 'grounded').map(a => [a.i, a.reply]));
// a HINT for the reader, not a grade: does the reply say the source lacks the answer?
const saysNotInSource = r => /\b(source|page)\b[^.]*\b(does not|doesn't|did not|nahi|not)\b[^.]*\b(say|answer|mention|cover|state|contain|provide|likh)/i.test(r);
const out = ['# jarvis — grounded held-out (' + (process.env.GROUNDED_PROMPTS || 'v4.1') + '), replies side by side (hand-graded)', '', 'models: ' + names.join(', '), ''];
const tally = Object.fromEntries(names.map(n => [n, { mustHit: 0, nAns: 0, declineHint: 0, nDec: 0 }]));
for (const p of P) {
  const m = p.meta;
  out.push('**' + p.q + '** — source: ' + m.title + ' — ' + (m.decline ? 'want: says the source does not say' : 'want: ' + m.must.join(' | ')) + (m.note ? ' (' + m.note + ')' : ''));
  for (const n of names) {
    const r = String(ans[n].get(p.i) || '(no answer)');
    const t = tally[n];
    let hint = '';
    if (m.decline) { t.nDec++; if (saysNotInSource(r)) { t.declineHint++; hint = ' [declines]'; } }
    else { t.nAns++; if (m.must.some(w => r.toLowerCase().includes(w))) { t.mustHit++; hint = ' [has ' + m.must.join('|') + ']'; } }
    out.push('- ' + n + ': "' + r.replace(/\s+/g, ' ') + '"' + hint);
  }
  out.push('');
}
out.push('## hints (not grades)', '| model | answer items with the word | decline items that decline |', '|---|---|---|');
for (const n of names) { const t = tally[n]; out.push('| ' + n + ' | ' + t.mustHit + '/' + t.nAns + ' | ' + t.declineHint + '/' + t.nDec + ' |'); }
fs.writeFileSync(path.join(__dirname, 'runs', process.env.GROUNDED_REPORT || 'bonsai_v41_grounded_report.md'), out.join('\n') + '\n');
console.log(out.slice(-2 - names.length).join('\n'));
