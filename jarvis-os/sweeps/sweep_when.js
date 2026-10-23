// MEASUREMENT SCRIPT — round 7's `when` words → a time (README "Reader round 7", pre-registered 2026-10-15). timedintent.convertWhen
// on finetune/data/when_phrases_v1.jsonl (written before this ran): the local model JARVIS's llm() uses for a 'cheap' call, same
// schema and prompt, temperature 0, through Ollama on this Mac. Bar: ≥ 27 / 30 exact (a delay within one minute, a clock time
// exact, a vague phrase → null). Nothing leaves the Mac, nothing acts.
//   node sweeps/sweep_when.js   → finetune/runs/when_20261015.json
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('../timedintent.js');
const ROOT = path.join(__dirname, '..', '..');
const SET = process.argv[2] || 'when_phrases_v1.jsonl';
const MODELS = (process.argv[3] || process.env.JARVIS_LOCAL_MODEL || 'qwen2.5:3b-instruct-q4_K_M').split(',');
const { execFileSync } = require('child_process');
const unloadAll = () => { try { for (const m of execFileSync('ollama', ['ps'], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean)) execFileSync('ollama', ['stop', m]); } catch (e) {} };
let MODEL = MODELS[0];
async function llm(o) {
  const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: MODEL, stream: false, keep_alive: '5m', think: false,
    format: o.schema, messages: [{ role: 'system', content: o.system }].concat(o.messages), options: { temperature: 0, num_ctx: 4096, num_predict: o.max_tokens || 120 } }) })
    .then(x => x.json());
  return { text: (r && r.message && r.message.content) || '' };
}
const parseJson = t => { try { return JSON.parse(t); } catch (e) { return null; } };
(async () => {
  const P = fs.readFileSync(path.join(ROOT, 'finetune', 'data', SET), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const all = {};
  for (MODEL of MODELS) {
  unloadAll(); await llm({ system: 'hi', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });   // warm, so timings are warm
  const now = Date.now(); let ok = 0, vagueGuessed = 0; const rows = [];
  for (const p of P) {
    const t0 = Date.now();
    const when = await T.convertWhen(p.when, { llm, parseJson, now });
    let want = null;
    if (typeof p.expect === 'number') want = now + p.expect * 60000;
    else if (Array.isArray(p.expect)) { const d = new Date(now); d.setHours(p.expect[0], p.expect[1], 0, 0);
      if (p.expect[2] === 'tomorrow') d.setDate(d.getDate() + 1); else if (d.getTime() <= now) d.setDate(d.getDate() + 1); want = d.getTime(); }
    const good = want === null ? when === null : (when !== null && (typeof p.expect === 'number' ? Math.abs(when - want) <= 60000 : when === want));
    if (good) ok++;
    if (want === null && when !== null) vagueGuessed++;
    rows.push({ id: p.id, when: p.when, expect: p.expect, got: when ? new Date(when).toString() : null, good, ms: Date.now() - t0 });
    console.log((good ? 'ok   ' : 'MISS ') + p.id + '  ' + JSON.stringify(p.when).padEnd(22) + ' → ' + (when ? new Date(when).toLocaleString() : 'no exact time'));
  }
  const ms = rows.map(r => r.ms).sort((a, b) => a - b)[rows.length >> 1];
  console.log('\n' + MODEL + ': ' + ok + ' / ' + P.length + ' exact · vague given a time ' + vagueGuessed + ' · median ' + ms + ' ms\n');
  all[MODEL] = { ok, n: P.length, vagueGuessed, medianMs: ms, rows };
  }
  unloadAll();
  fs.writeFileSync(path.join(ROOT, 'finetune', 'runs', 'when_' + SET.replace(/\.jsonl$/, '') + '_20261015.json'), JSON.stringify(all, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
