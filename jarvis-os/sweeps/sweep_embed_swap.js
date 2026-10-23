'use strict';
// EMBEDDER SWAP ON THE DECISION HELD-OUT (2026-10-14 — finetune/README "Reranker + nomic v2 — trial").
// JARVIS's own semantic lanes, unchanged, with a different embedder underneath — a drop-in: the same exemplars and the
// same margins. Run it with the embedder named in the environment, because intent.js reads it when it loads, and with a
// scratch centroid cache so the live state/centroids.json is never rebuilt for another model:
//   JARVIS_EMBED_MODEL=<m> JARVIS_EMBED_MODEL_ALT=<m> JARVIS_CENTROID_CACHE=<scratch.json> DECISION_SET=v2 \
//     node sweeps/sweep_embed_swap.js <claim weights.json> <out.jsonl>
// needs_web = webintent.needsWeb · self_fact = selffact.isSelfFact · claims_action = the claim reader with the given
// weights (retrained for this embedder by finetune/train_replyclaim.js). act_now / play_now are the reader's — skipped.
// Rows come out in sweeps/sweep_decision.js's format. Nothing here routes, acts or writes JARVIS state.
const fs = require('fs');
const path = require('path');
const http = require('http');

if (!process.env.JARVIS_CENTROID_CACHE) { console.log('refusing: set JARVIS_CENTROID_CACHE to a scratch file first'); process.exit(1); }
const intent = require('../intent.js');
const webintent = require('../webintent.js');
const selffact = require('../selffact.js');

const FT = path.join(__dirname, '..', '..', 'finetune');
const SET = process.env.DECISION_SET === 'v2' ? 'v2' : 'v1';
const ITEMS = fs.readFileSync(path.join(FT, 'data', 'decision_heldout_' + SET + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const [, , weightsFile, outFile] = process.argv;
const W = JSON.parse(fs.readFileSync(weightsFile, 'utf8'));

// The claim reader's own scoring (replyclaim.js trainedClaimOf), with these weights instead of the live file.
const normText = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
async function claimOf(sentence) {
  const parts = [];
  for (const m of W.models) {
    const v = await intent.embed(normText(sentence), m);
    if (!v) return undefined;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (const x of v) parts.push(x / n);
  }
  const z = W.W.map((row, c) => { let s = W.b[c]; for (let d = 0; d < parts.length; d++) s += row[d] * parts[d]; return s; });
  const mx = Math.max(...z); const e = z.map(x => Math.exp(x - mx)); const S = e.reduce((a, x) => a + x, 0);
  const p = e.map(x => x / S);
  const none = W.classes.indexOf('none');
  if (p[none] >= W.tau) return null;
  let k = -1; for (let c = 0; c < p.length; c++) if (c !== none && (k < 0 || p[c] > p[k])) k = c;
  return W.classes[k];
}

const loaded = () => new Promise(r => http.get({ host: '127.0.0.1', port: 11434, path: '/api/ps' }, x => {
  let s = ''; x.on('data', d => { s += d; }); x.on('end', () => { try { r(JSON.parse(s).models || []); } catch (e) { r([]); } });
}).on('error', () => r([])));

(async () => {
  console.log('embedder', intent.MODEL, '· alt', process.env.JARVIS_EMBED_MODEL_ALT, '· claim weights embed', JSON.stringify(W.models));
  const w = fs.createWriteStream(outFile);
  let maxGb = 0;
  for (const it of ITEMS) {
    let pred, note;
    const t0 = Date.now();
    if (it.question === 'needs_web') pred = !!(await webintent.needsWeb(it.q));
    else if (it.question === 'self_fact') pred = !!(await selffact.isSelfFact(it.q));
    else if (it.question === 'claims_action') { const c = await claimOf(it.q); pred = !!c && c !== 'none'; note = c; }
    else continue;
    const ms = Date.now() - t0;
    for (const m of await loaded()) if (/nomic/.test(m.name)) maxGb = Math.max(maxGb, (m.size || 0) / 1e9);   // machine format: the model's own name
    w.write(JSON.stringify({ id: it.id, question: it.question, lang: it.lang, label: it.label, pred, note, ms_lane: ms }) + '\n');
  }
  w.end();
  // Per-embed latency, warm: one sentence, timed after the model is loaded and its cache cannot answer.
  const times = [];
  for (let i = 0; i < 20; i++) { const t0 = Date.now(); await intent.embed('timing probe sentence number ' + i + ' ' + Date.now(), intent.MODEL); times.push(Date.now() - t0); }
  times.sort((a, b) => a - b);
  console.log(`median warm embed ${times[10]} ms · loaded size ${maxGb.toFixed(2)} GB · wrote ${outFile}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
