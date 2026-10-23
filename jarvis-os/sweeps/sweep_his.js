'use strict';
// MEASUREMENT SCRIPT — not a test, and it fires no actions. His real messages through the real reader
// pipeline: what WOULD JARVIS do with each one, and is that what the hand-written label says?
//
// Both sides go through readmodel.build(), so the comparison is ACTION against ACTION — the checker, the
// registries, the verblex direction gate and the confidence gate included. A label that the checker
// turns into a question (a verb he has never used, a which-site) expects that question.
//
//   exact    the pipeline would do exactly what the label would
//   WRONG    it would ACT, and not as the label would (including acting on a non-request)
//   MISS     the label acts and the pipeline would not (null, or an ask the label does not have)
//   ASKS     both ask
//
// Groups are reported apart, because only some of them measure anything new:
//   exam       his messages from 2026-09-06 on — never trained on (finetune/build_dataset.py)
//   held-out   finetune/data/negatives_heldout.jsonl — his ordinary messages kept out of training
//   trained    everything else of his: the model has seen these, so they show fit, not generalisation
//
// Usage: node sweep_his.js [limit]         needs ollama with the jarvis-reader model
// Reads into its own cache file and its own places file; his real state is never written.
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.sweep_his.json';
process.env.JARVIS_PLACES_FILE = 'places.sweep_his.json';
const fs = require('fs');
const path = require('path');
const J = require('../server.js');
const RM = J.readmodel;
const store = require('../store.js');
store.write('places.sweep_his.json', { create: path.join(process.env.HOME, 'Desktop') });

const DATA = path.join(__dirname, '..', '..', 'finetune', 'data');
const jsonl = f => fs.readFileSync(path.join(DATA, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const SPLIT_ID = 1257;

const labels = new Map(jsonl('labels_real.jsonl').map(r => [r.id, r.label]));
const heldIds = new Set(jsonl('negatives_heldout.jsonl').map(r => r.id));
const limit = Number(process.argv[2]) || Infinity;
const rows = jsonl('his_messages.jsonl').slice(0, limit).map(m => ({
  id: m.id, text: m.text, label: labels.get(m.id),
  group: m.id >= SPLIT_ID ? 'exam' : heldIds.has(m.id) ? 'held-out' : 'trained',
}));

const shapeOf = b => !b ? null : b.ask ? { ask: b.ask.kind } : b.action ? b.action : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const t0 = Date.now();
  // Read ahead in small batches, exactly as the live pre-warm does, then judge synchronously.
  for (let i = 0; i < rows.length; i += 20) await RM.warm(rows.slice(i, i + 20).map(r => r.text));
  if (!RM.ready()) { console.log('the reader model is not installed — nothing to measure'); process.exit(1); }
  const tally = {}, notes = [];
  for (const r of rows) {
    const got = shapeOf(RM.build(r.text, RM.readSync(r.text)));
    const want = shapeOf(RM.build(r.text, r.label));
    let v;
    if (same(got, want)) v = got && got.ask ? 'ASKS' : 'exact';
    else if (got && !got.ask) v = 'WRONG';
    else v = 'MISS';
    const t = tally[r.group] = tally[r.group] || { exact: 0, ASKS: 0, MISS: 0, WRONG: 0 };
    t[v]++;
    if (v === 'WRONG' || (v === 'MISS' && r.group !== 'trained')) {
      notes.push(v.padEnd(6) + r.group.padEnd(9) + JSON.stringify(r.text).slice(0, 56).padEnd(58) +
        ' would ' + JSON.stringify(got).slice(0, 80) + '   label ' + JSON.stringify(want).slice(0, 80));
    }
  }
  console.log(rows.length + ' messages in ' + Math.round((Date.now() - t0) / 1000) + 's');
  for (const [g, t] of Object.entries(tally)) {
    console.log('  ' + g.padEnd(9) + ' exact ' + t.exact + '   asks ' + t.ASKS + '   MISS ' + t.MISS + '   WRONG ' + t.WRONG);
  }
  for (const n of notes) console.log('  ' + n);
  store.write('places.sweep_his.json', {});
  process.exit(0);
})();
