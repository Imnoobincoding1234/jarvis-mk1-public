// MEASUREMENT SCRIPT — which local model should run the strict message composer (finetune/README.md "Composer model",
// pre-registered 2026-10-15). The REAL agent.compose({strict}) code — its prompt, its invented-word retry and its fallback to
// his words — with only the model changed, called the way llm() calls a local model (think off, no temperature set, the
// composer's own max_tokens). One model in memory at a time (each is unloaded before the next). Nothing is sent or acted on.
//   node sweeps/sweep_composer.js run      → finetune/runs/composer_20261015/drafts.json + blind_sheet.txt + key.json (do not open)
//   node sweeps/sweep_composer.js score    → reads grades.json ({code: {faithful: bool, invented: bool, note}}) and the key
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('../agent.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'finetune', 'runs', 'composer_20261015');
const HELD = path.join(ROOT, 'finetune', 'data', 'composer_heldout_v1.jsonl');
const MODELS = ['qwen2.5:3b-instruct-q4_K_M', 'phi4-mini:latest', 'jarvis'];

function unloadAll() {
  try {
    const ps = execFileSync('ollama', ['ps'], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
    for (const m of ps) execFileSync('ollama', ['stop', m]);
  } catch (e) {}
}
async function chatWith(model, o) {
  const msgs = (o.system ? [{ role: 'system', content: o.system }] : []).concat(o.messages || []);
  const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model, messages: msgs, think: false, stream: false,
    keep_alive: '5m', options: { num_predict: o.max_tokens || 200, num_ctx: 4096, use_mmap: true } }) }).then(x => x.json());
  return { text: (r && r.message && r.message.content) || '' };
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const H = fs.readFileSync(HELD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const drafts = [];
  for (const model of MODELS) {
    unloadAll();
    A.init({ llm: o => chatWith(model, o), jlog: () => {}, audit: () => {}, lean: () => true, envVal: () => '' });
    await chatWith(model, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });   // load once; timings below are warm
    for (const it of H) {
      const t0 = Date.now();
      const r = await A.compose({ kind: 'message', strict: true, said: it.body, message: it.text, recipient: it.to });
      drafts.push({ id: it.id, model, draft: (r && r.text) || '', verbatim: !!(r && r.data && r.data.verbatim), ok: !!(r && r.ok), ms: Date.now() - t0 });
      console.log(model.padEnd(28) + it.id + '  ' + (Date.now() - t0) + 'ms');
    }
  }
  unloadAll();
  fs.writeFileSync(path.join(OUT, 'drafts.json'), JSON.stringify(drafts, null, 1));
  // the blind sheet: shuffled, model hidden behind a code; the key is written apart and not opened before grading
  const order = drafts.map((d, i) => ({ d, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.d);
  const key = {}, lines = [];
  order.forEach((d, i) => {
    const code = 'g' + String(i + 1).padStart(3, '0'); key[code] = { id: d.id, model: d.model };
    const it = H.find(x => x.id === d.id);
    lines.push(code + ' | to ' + it.to + ' | he said: ' + it.text + '\n       body: ' + it.body + '\n       draft: ' + d.draft);
  });
  fs.writeFileSync(path.join(OUT, 'blind_sheet.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'key.json'), JSON.stringify(key));
  console.log('wrote drafts.json, blind_sheet.txt, key.json (' + drafts.length + ' drafts)');
}

function score() {
  const key = JSON.parse(fs.readFileSync(path.join(OUT, 'key.json'), 'utf8'));
  const grades = JSON.parse(fs.readFileSync(path.join(OUT, 'grades.json'), 'utf8'));
  const drafts = JSON.parse(fs.readFileSync(path.join(OUT, 'drafts.json'), 'utf8'));
  const res = {};
  for (const [code, g] of Object.entries(grades)) {
    const k = key[code]; if (!k) continue;
    const r = res[k.model] = res[k.model] || { faithful: 0, inventedNone: 0, n: 0, hinglishFaithful: 0, verbatim: 0 };
    const d = drafts.find(x => x.id === k.id && x.model === k.model);
    r.n++; if (g.faithful) r.faithful++; if (!g.invented) r.inventedNone++; if (d && d.verbatim) r.verbatim++;
    if (g.faithful && /^c(2[1-9]|30)$/.test(k.id)) r.hinglishFaithful++;
  }
  for (const m of Object.keys(res)) {
    const ms = drafts.filter(x => x.model === m).map(x => x.ms).sort((a, b) => a - b);
    res[m].medianMs = ms[ms.length >> 1];
  }
  console.log(JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(res, null, 1));
}

(process.argv[2] === 'score' ? Promise.resolve(score()) : run()).catch(e => { console.error(e); process.exit(1); });
