'use strict';
// ANSWERS THE `jarvis` HELD-OUT PROMPTS WITH AN OLLAMA MODEL — the 3B that `jarvis` has to beat, or later the
// built `jarvis` itself. 2026-09-26. Same prompts file as eval_bonsai.py, the body server.js llm() sends a local
// model (think off, use_mmap, modelprofile ctx), and temperature 0 so the comparison is between models, not
// samples. One model at a time: the model is stopped when it is done. Writes runs/bonsai_eval_<name>.jsonl.
//
//   node eval_bonsai_ollama.js qwen2.5:3b-instruct-q4_K_M 3b
const fs = require('fs');
const path = require('path');
const MP = require('../jarvis-os/modelprofile.js');
const { spawnSync } = require('child_process');

const [model, name] = process.argv.slice(2);
if (!model || !name) { console.log('usage: node eval_bonsai_ollama.js <model> <name>'); process.exit(1); }
const rows = fs.readFileSync(path.join(__dirname, 'data', process.env.BONSAI_PROMPTS || 'bonsai_eval_prompts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const prof = MP.profileFor(model);

(async () => {
  const outPath = path.join(__dirname, 'runs', 'bonsai_eval_' + name + '.jsonl');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.openSync(outPath, 'w');
  const t = Date.now();
  for (const r of rows) {
    const numCtx = MP.ctxFor(prof, r.section === 'reasoning' ? 4096 : 8192);
    const t0 = Date.now();
    const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({
      model, stream: false, think: false, keep_alive: '60s', messages: r.messages,
      options: { temperature: 0, num_predict: r.max, num_ctx: numCtx, use_mmap: true } }) }).then(x => x.json()).catch(e => ({ error: e.message }));
    const reply = String((res.message && res.message.content) || res.error || '').trim();
    fs.writeSync(out, JSON.stringify({ section: r.section, i: r.i, reply, ms: Date.now() - t0 }) + '\n');
  }
  fs.closeSync(out);
  spawnSync('ollama', ['stop', model]);
  console.log(name + ': ' + rows.length + ' answers in ' + Math.round((Date.now() - t) / 1000) + ' s -> ' + path.relative(__dirname, outPath));
})();
