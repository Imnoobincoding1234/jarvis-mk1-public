'use strict';
// MEASUREMENT SCRIPT — not a test, and it fires no actions. What does the reader add to a turn?
//
// For a sample of his real messages, the same pre-warm handleChatInner runs before routing:
// clauseCandidates + navigationHead, read by the reader model (readmodel.warm) and by the errand
// embedders (errand.warm). Each message is read from an EMPTY reader cache, so this is the cost of a
// sentence JARVIS has never seen; a repeated sentence costs a dictionary lookup.
//
// Usage: node sweep_latency.js [count]      needs ollama with jarvis-reader and the embedders
process.env.JARVIS_READER_CACHE = 'readmodel.latency.json';
process.env.JARVIS_PLACES_FILE = 'places.latency.json';
const fs = require('fs');
const path = require('path');
const J = require('../server.js');
const store = require('../store.js');

const n = Number(process.argv[2]) || 40;
const all = fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', 'his_messages.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l).text).filter(t => t.length < 90);
// A fixed, spread-out sample: every k-th message, plus the multi-clause ones the handoff worried about.
const step = Math.max(1, Math.floor(all.length / n));
const sample = all.filter((_, i) => i % step === 0).slice(0, n);
for (const t of ['open notes and make a note called mechanical soup', 'boot up youtube and play scary pumpkin\'s latest video',
                 'bored out of my mind, stick on netflix and find some thrillers', 'Create a new folder and label it as JARVIS MK two']) {
  if (!sample.includes(t)) sample.push(t);
}

const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
(async () => {
  // Load both kinds of model first, so the first sample does not carry the load.
  await J.readmodel.warm(['open safari']);
  await J.errand.warm(['open safari']);
  const rows = [];
  for (const t of sample) {
    J.readmodel._forget();                                      // an unseen sentence
    const cands = J.clauseCandidates(t, {});
    const t0 = Date.now();
    await J.errand.warm(cands);
    const t1 = Date.now();
    // What handleChatInner does now: the sentence first, then only what the splitter asks about.
    let reads = await J.readmodel.warm([t]);
    const before = J.readmodel.missesOf(() => {});
    const counted = [];
    const origWarm = J.readmodel.warm;
    await J.warmWhatTheSplitterAsks(t, {});
    reads = Object.keys(require('../store.js').read('readmodel.latency.json', { readings: {} }).readings || {}).length;
    const t2 = Date.now();
    rows.push({ t, cands: cands.length, reads, errandMs: t1 - t0, readerMs: t2 - t1 });
  }
  const total = rows.map(r => r.errandMs + r.readerMs);
  console.log(rows.length + ' messages; reader + errand pre-warm per turn: median ' + pct(total, 0.5) + 'ms, p90 ' + pct(total, 0.9) + 'ms, max ' + Math.max(...total) + 'ms');
  console.log('reader alone: median ' + pct(rows.map(r => r.readerMs), 0.5) + 'ms, p90 ' + pct(rows.map(r => r.readerMs), 0.9) + 'ms');
  console.log('per read: median ' + pct(rows.filter(r => r.reads).map(r => Math.round(r.readerMs / r.reads)), 0.5) + 'ms');
  for (const r of rows.sort((a, b) => (b.errandMs + b.readerMs) - (a.errandMs + a.readerMs)).slice(0, 8)) {
    console.log('  ' + String(r.errandMs + r.readerMs).padStart(6) + 'ms  ' + r.cands + ' pieces (' + r.reads + ' read)  ' + JSON.stringify(r.t).slice(0, 70));
  }
  store.write('readmodel.latency.json', {});
  process.exit(0);
})();
