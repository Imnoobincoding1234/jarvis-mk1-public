// MEASUREMENT SCRIPT — Bonsai reader trial, phase 1 serving half (finetune/README "Bonsai reader — 4B, then 1.7B, keep the best",
// pre-registered 2026-10-15). A trial reader LoRA on a Bonsai Q1_0 base, served by runtime/llama-server on port 11437 (never the
// live 11436), reading 20 lines with the reader's OWN request — the prompt, JSON schema, temperature, token budget and
// alternatives readmodel.js sends Ollama (readmodel._request) — timed warm. With --jarvis-lora, both adapters are loaded and
// picked per request, and the script checks each request got its own adapter. Round 5 on Ollama reads the same lines for the
// record (--r5). Timing only: a 50-update adapter is not graded for correctness. One model at a time; nothing acts.
//   node sweeps/sweep_bonsai_reader_speed.js --name 4b --base <Q1_0.gguf> --lora <reader.gguf> [--jarvis-lora <jarvis.gguf>] [--r5]
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const R = require('../readmodel.js');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 11437;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NAME = arg('--name'), BASE = arg('--base'), LORA = arg('--lora'), JLORA = arg('--jarvis-lora', null);
const N = Number(arg('--n', 20));
const LINES = fs.readFileSync(path.join(ROOT, 'finetune', 'data', 'round5_valid.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l).text).slice(0, N);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = xs => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const p90 = xs => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };
const parses = t => { try { return !!JSON.parse(t).act; } catch (e) { return false; } };

function req(port, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, res => {
      let s = ''; res.on('data', d => { s += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} res.statusCode >= 400 ? reject(new Error('HTTP ' + res.statusCode + ' ' + s.slice(0, 200))) : resolve(j); });
    });
    r.setTimeout(timeoutMs || 60000, () => r.destroy(new Error('timeout')));
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const unloadOllama = () => { try { for (const m of execFileSync('ollama', ['ps'], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean)) execFileSync('ollama', ['stop', m]); } catch (e) {} };
const rssMB = pid => { try { return Math.round(Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024); } catch (e) { return null; } };

async function bonsai() {
  unloadOllama();
  const loras = [JLORA, LORA].filter(Boolean);
  const args = ['--model', BASE, '--lora', loras.join(','), '--lora-init-without-apply', '--host', '127.0.0.1', '--port', String(PORT),
    '--no-webui', '--offline', '-c', '4096', '-np', '1', '--flash-attn', 'auto', '-b', '512', '-ub', '512'];
  const child = spawn(path.join(ROOT, 'runtime', 'llama-server'), args, { stdio: 'ignore' });
  const out = { name: NAME, base: BASE, lora: LORA, jarvisLora: JLORA, lines: LINES.length };
  try {
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) { if (await req(PORT, 'GET', '/health', null, 400).then(j => j && j.status === 'ok').catch(() => false)) break; await sleep(100); }
    out.startMs = Date.now() - t0;
    const list = await req(PORT, 'GET', '/lora-adapters');
    out.adapters = list;
    const idOf = p => (list.find(a => path.resolve(a.path) === path.resolve(p)) || {}).id;
    const readerId = idOf(LORA), jarvisId = JLORA ? idOf(JLORA) : null;
    const use = id => list.map(a => ({ id: a.id, scale: a.id === id ? 1 : 0 }));
    const read = async (text, id, schema) => {
      const o = R._request(text);
      const body = { prompt: o.prompt, temperature: 0, n_predict: o.options.num_predict, n_probs: o.top_logprobs, cache_prompt: true, lora: use(id) };
      if (schema) body.json_schema = o.format;
      const t = Date.now(); const j = await req(PORT, 'POST', '/completion', body, 60000);
      return { ms: Date.now() - t, text: (j && j.content) || '', tokens: j && j.tokens_predicted };
    };
    await read(LINES[0], readerId, true);                                   // warm-up, not timed
    const rows = [];
    for (const l of LINES) { const r = await read(l, readerId, true); rows.push(Object.assign({ line: l, json: parses(r.text) }, r)); }
    out.rows = rows;
    out.medianMs = median(rows.map(r => r.ms)); out.p90Ms = p90(rows.map(r => r.ms));
    out.validJson = rows.filter(r => r.json).length;
    out.rssMB = rssMB(child.pid);
    if (jarvisId != null) {
      // Per-request adapters: the same line, no schema, reader → jarvis → reader. Each must get its own adapter (jarvis's text
      // differs from the reader's) and switching back must give the reader's text again.
      const sw = [];
      for (const l of LINES.slice(0, 3)) {
        const a = await read(l, readerId, false), b = await read(l, jarvisId, false), c = await read(l, readerId, false);
        sw.push({ line: l, reader: a.text.slice(0, 120), jarvis: b.text.slice(0, 120), readerAgain: c.text.slice(0, 120), differs: a.text !== b.text, sameBack: a.text === c.text });
      }
      out.switch = sw; out.switchOk = sw.every(x => x.differs && x.sameBack);
    }
  } finally { try { child.kill('SIGTERM'); } catch (e) {} await sleep(500); }
  return out;
}

async function r5() {
  unloadOllama();
  const ask = async text => {
    const t = Date.now();
    const j = await new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(R._request(text)));
      const r = http.request({ host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
        let s = ''; res.on('data', d => { s += d; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
      });
      r.on('error', reject); r.write(data); r.end();
    });
    return { ms: Date.now() - t, text: (j && j.response) || '' };
  };
  await ask(LINES[0]);
  const rows = [];
  for (const l of LINES) { const r = await ask(l); rows.push(Object.assign({ line: l, json: parses(r.text) }, r)); }
  unloadOllama();
  return { name: 'round5 (Ollama jarvis-reader)', rows, medianMs: median(rows.map(r => r.ms)), p90Ms: p90(rows.map(r => r.ms)), validJson: rows.filter(r => r.json).length };
}

(async () => {
  const res = {};
  if (BASE && LORA) res.bonsai = await bonsai();
  if (process.argv.includes('--r5')) res.r5 = await r5();
  const out = path.join(ROOT, 'finetune', 'runs', 'bonsai_reader_trial_' + (NAME || 'r5') + '.json');
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
  for (const [k, v] of Object.entries(res)) console.log(k, 'median', v.medianMs, 'ms · p90', v.p90Ms, 'ms · valid JSON', v.validJson + '/' + v.rows.length,
    v.startMs != null ? '· start ' + v.startMs + ' ms · RSS ' + v.rssMB + ' MB' : '', v.switchOk != null ? '· per-request adapters ' + (v.switchOk ? 'OK' : 'FAILED') : '');
  console.log('wrote', path.relative(ROOT, out));
})().catch(e => { console.error(e); process.exit(1); });
