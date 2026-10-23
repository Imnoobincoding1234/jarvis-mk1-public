'use strict';
// SCORES THE `jarvis` HELD-OUT RUNS SIDE BY SIDE. 2026-09-26.
//
//   node score_bonsai.js 3b stock s1 s2 s3 soup     → prints the table, writes runs/bonsai_eval_report.md
//
// AUTOMATIC where the answer is a fact, never a judgement:
//   reasoning   the LAST non-empty line must hold every expected number (±0.01), or the expected text — the
//               live path asks for the final answer there (sweep_reasoncmp.js grades the same way)
//   resolver    the raw answer goes through context.js judgeStandsFor — exactly what the live resolver does with
//               it — then: exact (the right referent, or NONE when NONE is right), miss (NONE when one was
//               there — it asks him, safe), WRONG (a different referent acted on — the failure that must be 0)
//   chat facts  the two questions with a one-word fact
// HAND-GRADED, printed side by side in the report: greetings (quiet / attention / context), capability answers,
// chat. Word counts are shown as a chattiness figure; they grade nothing.
const fs = require('fs');
const path = require('path');
const cx = require('../jarvis-os/context.js');

const names = process.argv.slice(2);
if (!names.length) { console.log('usage: node score_bonsai.js <name> [<name> …]'); process.exit(1); }
const prompts = fs.readFileSync(path.join(__dirname, 'data', process.env.BONSAI_PROMPTS || 'bonsai_eval_prompts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const key = r => r.section + '#' + r.i;
const runs = {};
for (const n of names) {
  const f = path.join(__dirname, 'runs', 'bonsai_eval_' + n + '.jsonl');
  if (!fs.existsSync(f)) { console.log('no run for ' + n + ' (' + path.relative(__dirname, f) + ')'); process.exit(1); }
  runs[n] = new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(r => [key(r), r]));
}

const lastLine = s => String(s).split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
const numsIn = s => (String(s).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
function gradeReasoning(meta, reply) {
  const line = lastLine(reply);
  const str = meta.str || meta.text;   // v2's held-out calls it `text`
  if (str) return str.some(x => line.toLowerCase().includes(x.toLowerCase()));
  const got = numsIn(line);
  return meta.num.every(n => got.some(g => Math.abs(g - n) <= 0.01));
}
function gradeResolver(p, reply) {
  const j = cx.judgeStandsFor(reply, p.meta.request, p.prior);
  if (p.meta.expect === 'NONE') return j.ok ? 'WRONG' : 'exact';
  if (!j.ok) return 'miss';
  return j.value.toLowerCase().includes(p.meta.expect.toLowerCase()) ? 'exact' : 'WRONG';
}
const words = s => String(s).split(/\s+/).filter(Boolean).length;
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const sum = {};
for (const n of names) {
  const r = runs[n], s = { reasoning: 0, nReason: 0, exact: 0, miss: 0, WRONG: 0, nRes: 0, facts: 0, nFacts: 0, greetWords: [], ms: [] };
  for (const p of prompts) {
    const a = r.get(key(p)); if (!a) continue;
    s.ms.push(a.ms);
    if (p.section === 'reasoning') { s.nReason++; if (gradeReasoning(p.meta, a.reply)) s.reasoning++; }
    else if (p.section === 'resolver') { s.nRes++; s[gradeResolver(p, a.reply)]++; }
    else if (p.section === 'chat' && p.meta.must && p.meta.must.length) { s.nFacts++; if (p.meta.must.some(m => a.reply.toLowerCase().includes(m.toLowerCase()))) s.facts++; }
    if (p.section === 'greet') s.greetWords.push(words(a.reply));
  }
  sum[n] = s;
}

const lines = [];
const P = s => { lines.push(s); console.log(s); };
P('| model | reasoning (last line right) | resolver exact / miss / WRONG | chat facts | greeting words (median) | median ms |');
P('|---|---|---|---|---|---|');
for (const n of names) {
  const s = sum[n];
  P('| ' + n + ' | ' + s.reasoning + '/' + s.nReason + ' | ' + s.exact + ' / ' + s.miss + ' / ' + s.WRONG + ' of ' + s.nRes + ' | ' +
    s.facts + '/' + s.nFacts + ' | ' + med(s.greetWords) + ' | ' + med(s.ms) + ' |');
}

// Side by side, for hand-grading — and the misses of the automatic parts, so they can be read.
const md = ['# `jarvis` held-out — ' + names.join(' vs ') + '\n', lines.join('\n'), ''];
for (const sec of ['greet', 'caps', 'chat', 'reasoning', 'resolver']) {
  md.push('\n## ' + sec + '\n');
  for (const p of prompts.filter(x => x.section === sec)) {
    const m = p.meta;
    const tag = sec === 'greet' ? '[' + m.kind + (m.must ? ': must mention ' + m.must : '') + (m.stats ? ' ' + JSON.stringify(m.stats) : '') + ']'
      : sec === 'caps' ? '[truth: ' + m.truth + ']' : sec === 'chat' ? '[' + (m.ack ? 'ack' : m.must ? 'must: ' + m.must.join('|') : 'noClaim') + (m.note ? ' — ' + m.note : '') + ']'
      : sec === 'reasoning' ? '[want ' + JSON.stringify(m.num || m.str) + ']' : '[want ' + m.expect + ']';
    md.push('**' + p.q + '** ' + tag);
    for (const n of names) {
      const a = runs[n].get(key(p)); if (!a) continue;
      let mark = '';
      if (sec === 'reasoning') mark = gradeReasoning(m, a.reply) ? ' ✓' : ' ✗';
      if (sec === 'resolver') mark = ' ' + gradeResolver(p, a.reply);
      md.push('- ' + n + mark + ': ' + JSON.stringify(a.reply.replace(/\s+/g, ' ').slice(0, 300)));
    }
    md.push('');
  }
}
const outFile = path.join(__dirname, 'runs', process.env.BONSAI_REPORT || 'bonsai_eval_report.md');
fs.writeFileSync(outFile, md.join('\n'));
console.log('\nreport (every reply, side by side, for hand-grading): ' + path.relative(__dirname, outFile));
