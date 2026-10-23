'use strict';
// MEASUREMENT SCRIPT — not a test; fires no actions. Loads the reader, then nomic (one at a time).
//
// WHEN MAY THE REFERENCE RESOLVER BE SKIPPED? (bug [A], 2026-09-23)
//
// context.resolveInText asks the 3B on every plain turn with history, and under one-model-at-a-time its
// prompt cache is always cold: 514 prompt tokens at ~120 tok/s (Low Power Mode) = 5–7 s a turn, for an
// answer of "NONE" nearly every time. The reader's P(refers) alone cannot skip it (REFERS_SKIP: every cut
// skipped 2–7 real references), nor can the leaning embedder alone (spares 26/204). This measures the
// AND of the two: skip only when the reader is sure, does not flag refers, P(refers) < cut, AND the
// leaning embedder's score (cos to "leaning" − cos to "self_contained", context.LEANING_EXEMPLARS,
// nomic) < T. A skipped reference is the error that must be ZERO.
//
// Tuned on refers_heldout + exam_his + round2_heldout; judged ONCE on refskip_heldout.jsonl, which was
// written before any of this ran (finetune/data, 35 references / 30 self-contained, his style).
//
//   node sweeps/sweep_refskip.js
process.env.JARVIS_READER_CACHE = 'readmodel.sweep_refskip.json';
const fs = require('fs');
const path = require('path');
const J = require('../server.js');
const RM = J.readmodel;
const intent = require('../intent.js');
const cx = require('../context.js');

const DATA = path.join(__dirname, '..', '..', 'finetune', 'data');
const load = f => fs.readFileSync(path.join(DATA, f), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .map(x => ({ text: x.text, refers: (x.label ? x.label.refers : x.refers) === true }));
const TUNE = { refers_heldout: load('refers_heldout.jsonl'), exam_his: load('exam_his.jsonl'), round2_heldout: load('round2_heldout.jsonl') };
const HELD = load('refskip_heldout.jsonl');

(async () => {
  const all = [...Object.values(TUNE).flat(), ...HELD];
  const texts = [...new Set(all.map(x => x.text))];
  await RM.warm(texts);
  const cL = await intent.centroidOf(intent.MODEL, cx.LEANING_EXEMPLARS.leaning);
  const cS = await intent.centroidOf(intent.MODEL, cx.LEANING_EXEMPLARS.self_contained);
  const feat = new Map();
  for (const t of texts) {
    const r = RM.readSync(t);
    const v = await intent.embed(String(t).toLowerCase().trim().replace(/\s+/g, ' '), intent.MODEL);
    feat.set(t, {
      readerOk: !!(r && typeof r.__conf === 'number' && r.__conf >= RM.MIN_CONFIDENCE && r.refers !== true && typeof r.__ref === 'number'),
      ref: r && typeof r.__ref === 'number' ? r.__ref : 1,
      lean: v ? intent.cos(v, cL) - intent.cos(v, cS) : 1,
    });
  }
  const skips = (x, cut, T) => { const f = feat.get(x.text); return f.readerOk && f.ref < cut && f.lean < T; };
  const CUTS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.3];
  const TS = []; for (let t = -0.10; t <= 0.101; t += 0.005) TS.push(Math.round(t * 1000) / 1000);
  const tuneRows = Object.values(TUNE).flat();
  const nonRef = tuneRows.filter(x => !x.refers).length;
  console.log('tuning rows ' + tuneRows.length + ' (' + (tuneRows.length - nonRef) + ' references), fresh held-out ' + HELD.length);
  console.log('\ncut     T       skipped refs (tune)   saved (tune non-refs of ' + nonRef + ')');
  const best = [];
  for (const cut of CUTS) {
    let lastSafe = null;
    for (const T of TS) {
      const missed = tuneRows.filter(x => x.refers && skips(x, cut, T)).length;
      const saved = tuneRows.filter(x => !x.refers && skips(x, cut, T)).length;
      if (missed === 0) lastSafe = { cut, T, saved };
      else break;
    }
    // Back off one step from the edge, so the rule is not sitting exactly on the tuning set's boundary.
    const idx = lastSafe ? TS.indexOf(lastSafe.T) : -1;
    const T = idx > 0 ? TS[idx - 1] : null;
    if (T == null) { console.log(String(cut).padEnd(8) + '—       no threshold skips zero references'); continue; }
    const saved = tuneRows.filter(x => !x.refers && skips(x, cut, T)).length;
    best.push({ cut, T, saved });
    console.log(String(cut).padEnd(8) + String(T).padEnd(8) + '0'.padEnd(22) + saved + '   (edge T was ' + lastSafe.T + ')');
  }
  best.sort((a, b) => b.saved - a.saved);
  if (!best.length) { console.log('\nNO SAFE RULE.'); process.exit(0); }
  const pick = best[0];
  const hm = HELD.filter(x => x.refers && skips(x, pick.cut, pick.T));
  const hs = HELD.filter(x => !x.refers && skips(x, pick.cut, pick.T));
  console.log('\nPICKED cut ' + pick.cut + ', T ' + pick.T + ' → fresh held-out: skipped references ' + hm.length +
    '/' + HELD.filter(x => x.refers).length + ', saved ' + hs.length + '/' + HELD.filter(x => !x.refers).length);
  for (const x of hm) console.log('  SKIPPED A REFERENCE: ' + x.text + '  ' + JSON.stringify(feat.get(x.text)));
  for (const x of HELD.filter(x => !x.refers && !skips(x, pick.cut, pick.T))) console.log('  still asked: ' + x.text + '  ' + JSON.stringify(feat.get(x.text)));
  process.exit(0);
})();
