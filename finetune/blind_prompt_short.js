'use strict';
// BLIND SHEET for the short-system-prompt grading (README "Short system prompt", 2026-10-09).
// For each held-out item the replies of ps_long / ps_A / ps_B are shown as X / Y / Z in a per-item shuffled order (seeded,
// so the sheet is reproducible); replies that are byte-identical are shown once with all their letters. The key that maps
// letters back to prompts goes to a separate file, opened only after every item is graded.
//
//   node blind_prompt_short.js sheet   → runs/prompt_short_sheet.md + runs/prompt_short_key.json
//   node blind_prompt_short.js score   (reads runs/prompt_short_grades.json {"<section>:<i>": {"X": "y|w|n", ...}, ...})
const fs = require('fs');
const path = require('path');
const R = p => path.join(__dirname, 'runs', p);
// BLIND_RUNS / BLIND_PROMPTS / BLIND_TAG reuse it for another comparison (the first run named is the baseline).
const RUNS = (process.env.BLIND_RUNS || 'ps_long,ps_A,ps_B').split(',');
const TAG = process.env.BLIND_TAG || 'prompt_short';
const LET = 'XYZ'.slice(0, RUNS.length);
const prompts = fs.readFileSync(path.join(__dirname, 'data', process.env.BLIND_PROMPTS || 'bonsai_eval_prompts_ps_long.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const ans = {};
for (const run of RUNS) for (const l of fs.readFileSync(R('bonsai_eval_' + run + '.jsonl'), 'utf8').trim().split('\n')) {
  const a = JSON.parse(l); (ans[a.section + ':' + a.i] = ans[a.section + ':' + a.i] || {})[run] = a;
}
let seed = 20261009;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const kindOf = m => m.kind || (m.ack ? 'ack' : m.truth ? 'caps' : '?');

if (process.argv[2] === 'sheet') {
  const key = {}, out = ['# Short-prompt grading sheet (blind) — grade every letter y / w / n\n'];
  for (const p of prompts) {
    const id = p.section + ':' + p.i, m = p.meta;
    const order = RUNS.slice(); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    key[id] = {}; order.forEach((run, k) => { key[id][LET[k]] = run; });
    const groups = [];
    order.forEach((run, k) => {
      const reply = ans[id][run].reply, g = groups.find(x => x.reply === reply);
      if (g) g.letters += LET[k]; else groups.push({ letters: LET[k], reply });
    });
    const note = [m.truth && 'truth: ' + m.truth, m.must && 'must: ' + m.must.join(' | '), m.note && 'note: ' + m.note,
      m.now && 'clock: ' + m.now, m.stats && 'attention: ' + JSON.stringify(m.stats)].filter(Boolean).join(' · ');
    out.push('**' + id + '** [' + kindOf(m) + (m.hing ? ', Hinglish' : '') + '] ' + JSON.stringify(m.q) + (note ? '\n  ' + note : ''));
    for (const g of groups) out.push('  - ' + g.letters + ': ' + JSON.stringify(g.reply));
    out.push('');
  }
  fs.writeFileSync(R(TAG + '_sheet.md'), out.join('\n'));
  fs.writeFileSync(R(TAG + '_key.json'), JSON.stringify(key, null, 1));
  console.log('sheet: runs/' + TAG + '_sheet.md (' + prompts.length + ' items); key: runs/' + TAG + '_key.json — do not open before grading');
}

if (process.argv[2] === 'score') {
  const key = JSON.parse(fs.readFileSync(R(TAG + '_key.json'), 'utf8'));
  const grades = JSON.parse(fs.readFileSync(R(TAG + '_grades.json'), 'utf8'));
  const tab = {}, claims = {};
  for (const p of prompts) {
    const id = p.section + ':' + p.i, g = grades[id];
    if (!g) { console.log('UNGRADED ' + id); continue; }
    const sec = p.section === 'greet' ? 'greet ' + p.meta.kind : p.section === 'caps' ? 'caps' : kindOf(p.meta);
    for (const L of LET) {
      const run = key[id][L], v = String(g[L] || '');
      const row = (tab[sec] = tab[sec] || {})[run] = (tab[sec] || {})[run] || { pass: 0, w: 0, n: 0, en: 0, hi: 0, of: 0, ofEn: 0, ofHi: 0 };
      row.of++; row[p.meta.hing ? 'ofHi' : 'ofEn']++;
      if (/^[yw]/.test(v)) { row.pass++; row[p.meta.hing ? 'hi' : 'en']++; if (v[0] === 'w') row.w++; } else row.n++;
      if (/claim/.test(v)) (claims[run] = claims[run] || []).push(id + ' ' + v);
    }
  }
  const lines = ['| section | ' + RUNS.join(' | ') + ' |', '|---|' + RUNS.map(() => '---|').join('')];
  for (const [sec, r] of Object.entries(tab))
    lines.push('| ' + sec + ' (' + r[RUNS[0]].of + ') | ' + RUNS.map(run => r[run].pass + (r[run].w ? ' (' + r[run].w + ' w)' : '') +
      ' — en ' + r[run].en + '/' + r[run].ofEn + ', hi ' + r[run].hi + '/' + r[run].ofHi).join(' | ') + ' |');
  console.log(lines.join('\n'));
  for (const run of RUNS) console.log(run + ' flagged claims: ' + ((claims[run] || []).join('; ') || 'none'));
}
