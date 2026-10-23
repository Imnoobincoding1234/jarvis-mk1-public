'use strict';
// MEASUREMENT SCRIPT — not a test; nothing is executed. DOES JARVIS STAY QUIET WHEN GREETED?
// (2026-09-25, his rule: "when greeting ONLY report battery when (<20%) or anything else when it needs
// attention".)
//
// Each case is sent through the chat system prompt exactly as the live chat reply gets it (server.js
// systemPrompt, the same body llm() sends a local model). PROMPT=old gives the model every number in the
// live context, as before the change, so the same run shows before/after.
// Case stats (low battery, full disk, an agent down) replace the live readings through systemPrompt's
// `over`, so the attention cases do not depend on the Mac's real state.
//
// Hand-graded: the replies are printed, nothing here decides pass/fail from their words.
// Held-out: finetune/data/greet_heldout.json, written before the prompt change.
//
//   PROMPT=old node sweeps/sweep_greetcmp.js qwen2.5:3b-instruct-q4_K_M
//   node sweeps/sweep_greetcmp.js qwen2.5:3b-instruct-q4_K_M hf.co/prism-ml/Bonsai-4B-gguf:Q1_0
process.env.JARVIS_READER_CACHE = 'readmodel.sweep_greetcmp.json';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const J = require('../server.js');
const MP = require('../modelprofile.js');

// SET=caps_heldout.json runs the capability questions (bug [3]: the shortened capability text) the same way.
const SET = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', process.env.SET || 'greet_heldout.json'), 'utf8'));
SET.normal = SET.normal || { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61, down: [] };
const MODELS = process.argv.slice(2);
const OLD = process.env.PROMPT === 'old';
const MIN_FREE = Number(process.env.MIN_FREE) || 15;

const free = () => Number((/(\d+)%/.exec(spawnSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8' }).stdout) || [])[1]);
const post = body => new Promise(res => {
  const d = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': d.length } }, x => {
    let b = ''; x.on('data', c => { b += c; }); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({ error: b.slice(0, 200) }); } });
  });
  r.setTimeout(240000, () => r.destroy(new Error('timeout')));
  r.on('error', e => res({ error: e.message })); r.write(d); r.end();
});
let current = null, lowest = 100;
const watch = setInterval(() => {
  const f = free(); lowest = Math.min(lowest, f);
  if (f < MIN_FREE) { console.log('\nABORTED — free memory ' + f + '%; stopping ' + current); spawnSync('ollama', ['stop', current]); process.exit(2); }
}, 500);

async function promptFor(c) {
  const over = { stats: Object.assign({}, SET.normal, c.stats || {}), down: (c.stats && c.stats.down) || SET.normal.down };
  // OLD: the pre-change context — every number. (A greeting rule sentence was tried and REMOVED the same
  // day: it named kinds of message, a category list in a prompt.)
  return J._systemPrompt(null, OLD ? { state: 'full', over } : { over });
}

(async () => {
  const sum = [];
  for (const model of MODELS) {
    current = model;
    const prof = MP.profileFor(model);
    const numCtx = MP.ctxFor(prof, Number(process.env.CTX) || 8192);
    console.log('\n==================== ' + model + (OLD ? '  [OLD prompt]' : '  [NEW prompt]') + ' ====================');
    const ms = [], words = [];
    for (const c of SET.cases) {
      const sys = await promptFor(c);
      const t0 = Date.now();
      const out = await post({ model, stream: false, think: false, keep_alive: '60s',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: c.q }],
        options: { num_predict: MP.fitTokens(prof, 700, numCtx), num_ctx: numCtx, use_mmap: true } });
      const t = Date.now() - t0; ms.push(t);
      const text = String((out.message && out.message.content) || out.error || '').trim();
      words.push(text.split(/\s+/).filter(Boolean).length);
      console.log('[' + (c.kind || 'truth: ' + c.truth) + (c.must ? ': ' + c.must : '') + (c.stats ? ' ' + JSON.stringify(c.stats) : '') + '] ' +
        c.q + '  (' + t + 'ms, ' + (out.eval_count || '?') + ' tok)\n    → ' + JSON.stringify(text));
    }
    spawnSync('ollama', ['stop', model]);
    const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    sum.push(model + ': median ' + med(ms) + ' ms, median ' + med(words) + ' words');
  }
  clearInterval(watch);
  console.log('\n' + sum.join('\n') + '\nlowest free memory during the run: ' + lowest + '%');
  process.exit(0);
})();
