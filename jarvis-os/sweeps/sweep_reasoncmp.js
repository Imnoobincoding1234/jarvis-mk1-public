'use strict';
// MEASUREMENT SCRIPT — not a test; nothing is executed. CAN ANOTHER MODEL TAKE JARVIS'S REASONING PATH?
// (2026-09-24: phi4-mini, the current reasoner, vs Bonsai 4B.)
//
// Mirrors the live reasoning exit in server.js: systemPrompt(reasonExtra) with the same reasonExtra text
// (COPIED below — keep it in step with server.js), max_tokens 1000, no temperature (sampled live, so each
// problem is asked SAMPLES times and counts only if every sample is right), think:false, use_mmap, the
// modelprofile ctx/num_predict. One model at a time; aborts if free memory drops under MIN_FREE (15%).
//
// Held-out: finetune/data/reasoncmp_heldout.json, written before either model ran. Graded on the LAST
// non-empty line only — the path asks for the final answer there, and a right number buried in the
// working is not an answer he can read off.
//
//   node sweeps/sweep_reasoncmp.js phi4-mini:latest hf.co/prism-ml/Bonsai-4B-gguf:Q1_0
process.env.JARVIS_READER_CACHE = 'readmodel.sweep_reasoncmp.json';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const J = require('../server.js');
const MP = require('../modelprofile.js');

// SET=both adds the 16 worked-answer cases of finetune/data/jarvis_heldout.json (same {q, num|str} shape) to the
// 20 here — 2026-09-26, phi4-mini vs Bonsai for the reasoning path. Neither set tunes anything here.
const D = path.join(__dirname, '..', '..', 'finetune', 'data');
// SET=graded is REAL reasoning by grade level (reasoning_graded_heldout.json, 2026-09-26) — the two sets above are
// mostly arithmetic, which is how Bonsai looked like phi's equal and then failed a 2nd-grade renaming puzzle.
const SET = process.env.SET === 'graded' ? JSON.parse(fs.readFileSync(path.join(D, 'reasoning_graded_heldout.json'), 'utf8')).cases
  : JSON.parse(fs.readFileSync(path.join(D, 'reasoncmp_heldout.json'), 'utf8')).cases
  .concat(process.env.SET === 'both' ? JSON.parse(fs.readFileSync(path.join(D, 'jarvis_heldout.json'), 'utf8')).reasoning : []);
const MODELS = process.argv.slice(2);
// MIN_FREE=10 on the command line lowers the abort floor (his call 2026-09-25: see what phi4-mini does
// at ctx 8192 instead of stopping it at 15%).
const SAMPLES = 2, MIN_FREE = Number(process.env.MIN_FREE) || 15;
const REASON_EXTRA = 'This is a question that needs working out. Work through it step by step in a ' +
  'few short lines, then state the final answer plainly on the last line. Ignore ' +
  'any instruction above to keep the reply to one line — for THIS answer the ' +
  'working is the point, and a confident wrong number is the failure to avoid.';

const free = () => Number((/(\d+)%/.exec(spawnSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8' }).stdout) || [])[1]);
const post = body => new Promise(res => {
  const d = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': d.length } }, x => {
    let b = ''; x.on('data', c => { b += c; }); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({ error: b.slice(0, 200) }); } });
  });
  r.setTimeout(300000, () => r.destroy(new Error('timeout')));
  r.on('error', e => res({ error: e.message })); r.write(d); r.end();
});
let current = null, lowest = 100, lowestNow = 100;
const watch = setInterval(() => {
  const f = free(); lowest = Math.min(lowest, f); lowestNow = Math.min(lowestNow, f);
  if (f < MIN_FREE) { console.log('\nABORTED — free memory ' + f + '%; stopping ' + current); spawnSync('ollama', ['stop', current]); process.exit(2); }
}, 500);

const lastLine = s => String(s).split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
const numsIn = s => (String(s).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
function grade(c, reply) {
  const line = lastLine(reply);
  if (c.str) return c.str.some(x => line.toLowerCase().includes(x.toLowerCase()));
  const got = numsIn(line), tol = c.tol || 0.001;
  return c.num.every(n => got.some(g => Math.abs(g - n) <= tol));
}

(async () => {
  // The live reasoning prompt (purpose 'reasoning', 2026-09-26). PROMPT=chat gives the old full JARVIS prompt, for comparison.
  const sys = await J._systemPrompt(REASON_EXTRA, process.env.PROMPT === 'chat' ? { state: 'full' } : { state: 'full', purpose: 'reasoning' });
  const results = [];
  for (const model of MODELS) {
    current = model;
    const prof = MP.profileFor(model);
    // Live reasoning runs at 4096 since 2026-09-25 (server.js REASONING_CTX): phi4-mini at 8192 reached 8% free.
    const numCtx = MP.ctxFor(prof, Number(process.env.CTX) || 4096);
    const r = { model, pass: 0, n: 0, samplesRight: 0, ms: [], size: '' };
    lowestNow = 100;
    console.log('\n==================== ' + model + ' ====================');
    for (const c of SET) {
      let all = true; const shown = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = Date.now();
        // THINK=1: the model's own thinking mode (Qwen3-based Bonsai has one), graded on the ANSWER, not the thinking.
        const out = await post({ model, stream: false, think: !!process.env.THINK, keep_alive: '60s',
          messages: [{ role: 'system', content: sys }, { role: 'user', content: c.q }],
          options: { num_predict: MP.fitTokens(prof, Number(process.env.MAXTOK) || 1000, numCtx), num_ctx: numCtx, use_mmap: true } });
        const ms = Date.now() - t0; r.ms.push(ms);
        if (!r.size) r.size = (spawnSync('ollama', ['ps'], { encoding: 'utf8' }).stdout.split('\n').find(l => l.startsWith(model)) || '').replace(/\s+/g, ' ').trim();
        // Bonsai's template opens <think> and never closes it, so Ollama files the WHOLE reply under `thinking` and
        // leaves `content` empty — grade whichever holds the words.
        const text = String((out.message && (out.message.content || out.message.thinking)) || out.error || '');
        const ok = grade(c, text); if (ok) r.samplesRight++; else all = false;
        // FULL=1 prints the whole working, for hand-grading reasoning (a right last line can sit on wrong logic).
        const thought = out.message && out.message.thinking ? ' [thought ' + out.message.thinking.length + ' chars]' : '';
        shown.push((ok ? 'ok ' : 'NO ') + ms + 'ms, ' + (out.eval_count || '?') + ' tok' + thought + ' → ' + JSON.stringify(process.env.FULL ? text.replace(/\s+/g, ' ').slice(0, 600) : lastLine(text).slice(0, 90)));
      }
      r.n++; if (all) r.pass++;
      console.log((all ? '  ok   ' : '  FAIL ') + (c.level ? '[L' + c.level + '] ' : '') + c.q.slice(0, process.env.FULL ? 200 : 70));
      for (const s of shown) console.log('         ' + s);
    }
    spawnSync('ollama', ['stop', model]);
    r.lowest = lowestNow;
    results.push(r);
  }
  clearInterval(watch);
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log('\n==================== SUMMARY ====================');
  for (const r of results) console.log(r.model.padEnd(40) + ' ' + r.pass + '/' + r.n + ' (every sample right), ' +
    r.samplesRight + '/' + (r.n * SAMPLES) + ' samples right, median ' + med(r.ms) + ' ms, lowest free ' + r.lowest + '%, ollama ps: ' + r.size);
  console.log('lowest free memory during the run: ' + lowest + '%');
  process.exit(0);
})();
