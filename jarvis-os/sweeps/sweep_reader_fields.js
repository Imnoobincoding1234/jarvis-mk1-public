// MEASUREMENT SCRIPT — per-field reader confidence (finetune/README "Per-field confidence", pre-registered 2026-10-16).
// Same live path as sweep_reader_conf.js — readmodel's own request (raw prompt, schema, temperature 0, token probabilities) to Ollama
// and readmodel's own parse — for ONE reader model per run, but keeps every output token with its probability, so the confidence can be
// split by the JSON field each token belongs to (finetune/r7_fields_grade.py). Writes {set, id, text, label, raw, conf, lp: [[token, logprob]]}.
// Nothing acts; one model in memory.
//   JARVIS_READER_MODEL=<model> node sweeps/sweep_reader_fields.js <out.jsonl> <set.jsonl> …
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const R = require('../readmodel.js');
const [out, ...sets] = process.argv.slice(2);
const post = body => new Promise((res, rej) => { const d = Buffer.from(JSON.stringify(body));
  const q = http.request({ host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': d.length } },
    r => { let s = ''; r.on('data', c => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 200))); } }); });
  q.setTimeout(60000, () => q.destroy(new Error('timeout'))); q.on('error', rej); q.write(d); q.end(); });
(async () => {
  const lines = [];
  await post(R._request('hi'));
  for (const f of sets) {
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    for (const row of rows) {
      const j = await post(R._request(row.text));
      const r = R._parse(j);
      const lp = Array.isArray(j && j.logprobs) ? j.logprobs.map(t => [String(t.token), t.logprob]) : null;
      lines.push(JSON.stringify({ set: path.basename(f), id: row.id || null, text: row.text, label: row.label, raw: (j && j.response) || '',
        conf: r && typeof r.__conf === 'number' ? r.__conf : null, lp }));
    }
    console.log(path.basename(f), rows.length);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log('wrote', out, lines.length, 'rows · model', process.env.JARVIS_READER_MODEL || 'jarvis-reader');
})().catch(e => { console.error(e.message); process.exit(1); });
