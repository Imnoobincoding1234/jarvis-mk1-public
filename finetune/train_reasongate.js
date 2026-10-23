'use strict';
// TRAINS THE REASONING GATE (jarvis-os/reasonintent.js), 2026-09-25. Zero-dep; loads only embedders.
//
// Softmax over the five kinds in data/reasongate_train.jsonl (build_reasongate_data.js): reasoning,
// command, machine, lookup, chat. A sentence is a question to work out when P(reasoning) ≥ τ. The embedder
// (nomic, all-minilm, both), the L2 strength and τ are chosen by 5-fold cross-validation on the TRAINING rows
// only — first by fewest look-alikes called reasoning (a false yes skips the lane that has the real data),
// then by most reasoning caught, then the middle τ of a tie. The held-out sets are scored once, at the end.
//
//   node train_reasongate.js --dry   # report only
//   node train_reasongate.js         # report and write ../jarvis-os/reasongate.weights.json
const fs = require('fs');
const path = require('path');
const intent = require('../jarvis-os/intent.js');

const CLASSES = ['reasoning', 'command', 'machine', 'lookup', 'chat'];
const REASON = 0;
const DATA = path.join(__dirname, 'data');
const rows = fs.readFileSync(path.join(DATA, 'reasongate_train.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const SETS = [
  ['HELD-OUT #1 (round 1 saw its misses — report only)', 'reasongate_heldout.json'],
  ['HELD-OUT #2 (FRESH — the judge)', 'reasongate_heldout2.json'],
].concat(fs.existsSync(path.join(DATA, 'reasongate_heldout3.json')) ? [['HELD-OUT #3 (FRESH)', 'reasongate_heldout3.json']] : [])
 .map(([name, f]) => [name, JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).cases]);
const norm = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
const unit = v => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); };

const MODELS = { nomic: [intent.MODEL], minilm: ['all-minilm'], both: [intent.MODEL, 'all-minilm'] };
const cacheV = new Map();
async function feat(text, which) {
  const parts = [];
  for (const m of MODELS[which]) {
    const k = m + '\u0000' + norm(text);
    if (!cacheV.has(k)) { const v = await intent.embed(norm(text), m); if (!v) throw new Error('embedder down: ' + m); cacheV.set(k, unit(v)); }
    parts.push(cacheV.get(k));
  }
  return [].concat(...parts);
}

// Softmax regression, full-batch Adam, class-balanced loss, L2 on W (same as train_replyclaim.js).
function train(X, y, lambda, iters) {
  const D = X[0].length, C = CLASSES.length, N = X.length;
  const W = Array.from({ length: C }, () => new Float64Array(D)), b = new Float64Array(C);
  const cnt = new Array(C).fill(0); for (const t of y) cnt[t]++;
  const cw = cnt.map(c => c ? N / (C * c) : 0);
  const mW = W.map(() => new Float64Array(D)), vW = W.map(() => new Float64Array(D));
  const mb = new Float64Array(C), vb = new Float64Array(C);
  const lr = 0.05, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let it = 1; it <= iters; it++) {
    const gW = W.map(() => new Float64Array(D)), gb = new Float64Array(C);
    let wsum = 0;
    for (let i = 0; i < N; i++) {
      const p = probs(W, b, X[i]);
      const w = cw[y[i]]; wsum += w;
      for (let c = 0; c < C; c++) {
        const g = w * (p[c] - (c === y[i] ? 1 : 0));
        gb[c] += g; const xi = X[i], gc = gW[c];
        for (let d = 0; d < D; d++) gc[d] += g * xi[d];
      }
    }
    for (let c = 0; c < C; c++) {
      for (let d = 0; d < D; d++) {
        const g = gW[c][d] / wsum + lambda * W[c][d];
        mW[c][d] = b1 * mW[c][d] + (1 - b1) * g; vW[c][d] = b2 * vW[c][d] + (1 - b2) * g * g;
        W[c][d] -= lr * (mW[c][d] / (1 - b1 ** it)) / (Math.sqrt(vW[c][d] / (1 - b2 ** it)) + eps);
      }
      const g = gb[c] / wsum;
      mb[c] = b1 * mb[c] + (1 - b1) * g; vb[c] = b2 * vb[c] + (1 - b2) * g * g;
      b[c] -= lr * (mb[c] / (1 - b1 ** it)) / (Math.sqrt(vb[c] / (1 - b2 ** it)) + eps);
    }
  }
  return { W, b };
}
function probs(W, b, x) {
  const z = W.map((w, c) => { let s = b[c]; for (let d = 0; d < x.length; d++) s += w[d] * x[d]; return s; });
  const m = Math.max(...z); const e = z.map(v => Math.exp(v - m)); const S = e.reduce((a, v) => a + v, 0);
  return e.map(v => v / S);
}

(async () => {
  const y = rows.map(r => CLASSES.indexOf(r.label));
  if (y.some(v => v < 0)) throw new Error('unknown label');
  const ITERS = 300, TAUS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const folds = rows.map((_, i) => i % 5);
  const cands = [];
  const nR = y.filter(v => v === REASON).length, nN = y.length - nR;
  console.log('training rows ' + rows.length + ' (' + nR + ' reasoning, ' + nN + ' look-alikes); 5-fold CV');
  for (const which of Object.keys(MODELS)) {
    const X = []; for (const r of rows) X.push(await feat(r.text, which));
    for (const lambda of [1e-4, 1e-3, 1e-2]) {
      const pR = new Array(rows.length);
      for (let f = 0; f < 5; f++) {
        const tr = [], ty = [];
        for (let i = 0; i < rows.length; i++) if (folds[i] !== f) { tr.push(X[i]); ty.push(y[i]); }
        const m = train(tr, ty, lambda, ITERS);
        for (let i = 0; i < rows.length; i++) if (folds[i] === f) pR[i] = probs(m.W, m.b, X[i])[REASON];
      }
      for (const tau of TAUS) {
        let tp = 0, fp = 0;
        for (let i = 0; i < rows.length; i++) { const said = pR[i] >= tau; if (said && y[i] === REASON) tp++; else if (said) fp++; }
        cands.push({ which, lambda, tau, tp, fp });
      }
      const mine = cands.filter(c => c.which === which && c.lambda === lambda);
      console.log('  ' + which.padEnd(7) + ' λ=' + String(lambda).padEnd(7) + ' CV caught/false by τ: ' + mine.map(c => c.tau + ':' + c.tp + '/' + c.fp).join(' '));
    }
  }
  const minFp = Math.min(...cands.map(c => c.fp));
  const pool = cands.filter(c => c.fp === minFp);
  const maxTp = Math.max(...pool.map(c => c.tp));
  const tied = pool.filter(c => c.tp === maxTp);
  const cfg = tied.filter(c => c.which === tied[0].which && c.lambda === tied[0].lambda).sort((a, b) => a.tau - b.tau);
  const best = cfg[Math.floor((cfg.length - 1) / 2)];
  console.log('\nCHOSEN BY CV: ' + best.which + ', λ ' + best.lambda + ', τ ' + best.tau + ' — CV reasoning caught ' + best.tp + '/' + nR + ', look-alikes called reasoning ' + best.fp + '/' + nN);

  const X = []; for (const r of rows) X.push(await feat(r.text, best.which));
  const model = train(X, y, best.lambda, ITERS);
  for (const [name, cases] of SETS) {
    const miss = [], fals = [];
    for (const c of cases) {
      const p = probs(model.W, model.b, await feat(c.q, best.which));
      const said = p[REASON] >= best.tau;
      let k = 0; for (let j = 1; j < CLASSES.length; j++) if (p[j] > p[k]) k = j;
      if (c.reasoning && !said) miss.push(c.q + '  [P ' + p[REASON].toFixed(2) + ', ' + CLASSES[k] + ']');
      if (!c.reasoning && said) fals.push(c.q + '  [P ' + p[REASON].toFixed(2) + ']');
    }
    const hR = cases.filter(c => c.reasoning).length, hN = cases.length - hR;
    console.log('\n' + name + ': reasoning caught ' + (hR - miss.length) + '/' + hR + ', false alarms ' + fals.length + '/' + hN);
    for (const s of miss) console.log('   missed: ' + s);
    for (const s of fals) console.log('   FALSE:  ' + s);
  }

  if (!process.argv.includes('--dry')) {
    const outFile = path.join(__dirname, '..', 'jarvis-os', 'reasongate.weights.json');
    fs.writeFileSync(outFile, JSON.stringify({
      _about: 'Trained by finetune/train_reasongate.js on data/reasongate_train.jsonl — do not edit by hand.',
      trainedAt: new Date().toISOString(), rows: rows.length, embed: best.which, models: MODELS[best.which],
      classes: CLASSES, tau: best.tau, lambda: best.lambda, cv: { tp: best.tp, fp: best.fp, nReason: nR, nOther: nN },
      W: model.W.map(w => Array.from(w, v => +v.toFixed(6))), b: Array.from(model.b, v => +v.toFixed(6)),
    }));
    console.log('\nwrote ' + path.relative(path.join(__dirname, '..'), outFile));
  }
  process.exit(0);
})();
