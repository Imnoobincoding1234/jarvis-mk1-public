'use strict';
// IS UPDATING OLLAMA SAFE FOR WHAT JARVIS LOADS? (2026-10-13 — finetune/README "Decision models + Ollama 0.40.3 — sandbox
// trial", part 1). The same reader requests and the same embeddings go to the live Ollama and to a sandbox Ollama that
// holds APFS clones of the same model blobs; nothing here routes, acts or writes JARVIS state.
//   node sweeps/sweep_ollama_update.js live    <out.json>     (port 11434)
//   node sweeps/sweep_ollama_update.js sandbox <out.json>     (port SANDBOX_PORT, default 11435)
//   node sweeps/sweep_ollama_update.js compare <live.json> <sandbox.json>
// One model in memory at a time: each model is unloaded (keep_alive 0) before the next one is asked.
const fs = require('fs');
const http = require('http');
const path = require('path');
const readmodel = require('../readmodel.js');

const [, , mode, a, b] = process.argv;
const PORT = mode === 'sandbox' ? Number(process.env.SANDBOX_PORT || 11435) : 11434;
const HELD = path.join(__dirname, '..', '..', 'finetune', 'data', 'decision_heldout_' + (process.env.DECISION_SET === 'v2' ? 'v2' : 'v1') + '.jsonl');
const ITEMS = fs.readFileSync(HELD, 'utf8').trim().split('\n').map(JSON.parse);
const USER_LINES = ITEMS.filter(it => it.question !== 'claims_action').map(it => it.q);   // the 90 things HE would type
const EMBEDDERS = ['nomic-embed-text', 'granite-embedding:278m', 'all-minilm'];

function post(pathname, body, timeoutMs) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      let s = ''; res.on('data', c => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: j ? null : s.slice(0, 300) }); });
    });
    req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, body: null, raw: String(e.message || e) }));
    req.end(data);
  });
}
const unload = model => post('/api/generate', { model, keep_alive: 0 }, 30000);
const clean = r => { if (!r) return r; const o = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith('__')) o[k] = v; return o; };

async function collect(out) {
  const res = { port: PORT, version: null, reader: {}, embed: {} };
  const v = await new Promise(r => http.get({ host: '127.0.0.1', port: PORT, path: '/api/version' }, x => { let s = ''; x.on('data', c => { s += c; }); x.on('end', () => r(s)); }).on('error', () => r('')));
  try { res.version = JSON.parse(v).version; } catch (e) {}
  console.log('ollama', res.version, 'on', PORT);
  let n = 0;
  for (const t of USER_LINES) {
    const t0 = Date.now();
    const r = await post('/api/generate', readmodel._request(t), 60000);
    const reading = r.status === 200 && r.body ? readmodel._parse(r.body) : null;
    res.reader[t] = { status: r.status, ms: Date.now() - t0, reading: clean(reading), conf: reading ? reading.__conf : null,
      response: r.body ? r.body.response : r.raw };
    if (++n % 15 === 0) console.log('reader', n, '/', USER_LINES.length);
  }
  await unload(readmodel._request('x').model);
  for (const m of EMBEDDERS) {
    res.embed[m] = {};
    for (const it of ITEMS) {
      const r = await post('/api/embeddings', { model: m, prompt: it.q, keep_alive: '60s', options: { num_ctx: 512, use_mmap: true } }, 60000);
      res.embed[m][it.q] = r.status === 200 && r.body && Array.isArray(r.body.embedding) ? r.body.embedding : { status: r.status, err: r.raw || (r.body && r.body.error) };
    }
    await unload(m);
    console.log('embedded', m);
  }
  fs.writeFileSync(out, JSON.stringify(res));
  console.log('wrote', out);
}

function compare(fa, fb) {
  const A = JSON.parse(fs.readFileSync(fa, 'utf8')), B = JSON.parse(fs.readFileSync(fb, 'utf8'));
  console.log('A ollama', A.version, '· B ollama', B.version);
  let same = 0, n = 0, maxConf = 0, errs = 0;
  const diffs = [];
  for (const [t, x] of Object.entries(A.reader)) {
    const y = B.reader[t]; if (!y) continue;
    n++;
    if (y.status !== 200) errs++;
    if (JSON.stringify(x.reading) === JSON.stringify(y.reading)) same++;
    else diffs.push({ t, a: x.reading, b: y.reading, b_raw: y.response && String(y.response).slice(0, 160) });
    if (typeof x.conf === 'number' && typeof y.conf === 'number') maxConf = Math.max(maxConf, Math.abs(x.conf - y.conf));
  }
  const ms = o => { const s = Object.values(o.reader).map(r => r.ms).sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  console.log(`reader: same reading ${same}/${n} · errors on B ${errs} · largest confidence change ${Math.round(maxConf * 1000) / 1000} · median ms A ${ms(A)} B ${ms(B)}`);
  console.log(`  verdict: ${same >= 88 && maxConf <= 0.02 && !errs ? 'UNCHANGED (bar: ≥ 88/90, ≤ 0.02)' : 'CHANGED — re-measure before any update'}`);
  for (const m of Object.keys(A.embed)) {
    let min = 1, bad = 0, cnt = 0;
    for (const [t, va] of Object.entries(A.embed[m])) {
      const vb = B.embed[m] && B.embed[m][t];
      if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) { bad++; continue; }
      let d = 0, na = 0, nb = 0; for (let i = 0; i < va.length; i++) { d += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
      min = Math.min(min, d / Math.sqrt(na * nb)); cnt++;
    }
    console.log(`${m.padEnd(24)} lowest cosine old↔new ${Math.round(min * 1e6) / 1e6} over ${cnt} lines${bad ? ' · ' + bad + ' FAILED/mismatched' : ''} → ${min >= 0.999 && !bad ? 'UNCHANGED' : 'CHANGED'}`);
  }
  for (const d of diffs.slice(0, 20)) console.log('DIFF', JSON.stringify(d));
}

if (mode === 'compare') compare(a, b);
else if (mode === 'live' || mode === 'sandbox') collect(a).catch(e => { console.error(e); process.exit(1); });
else { console.log('usage: live|sandbox <out.json> · compare <live.json> <sandbox.json>'); process.exit(1); }
