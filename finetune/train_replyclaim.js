'use strict';
// TRAINS THE REPLY-CLAIM READER (jarvis-os/replyclaim.js), 2026-09-24. Zero-dep; loads only embedders.
//
// A softmax classifier (done / acting / promised / none) over sentence embeddings, trained on
// data/replyclaim_train.jsonl (build_replyclaim_data.js). Choices — which embedder (nomic, all-minilm,
// both concatenated), the L2 strength, and τ (a sentence is a claim when P(none) < τ) — are made by 5-fold
// cross-validation on the TRAINING rows only. The two held-out sets (data/replyclaim_heldout.json, written
// first; data/replyclaim_live.json, real blocked replies) are scored ONCE at the end, beside the live
// guard's own numbers, and nothing is chosen from them.
//
//   node train_replyclaim.js            # train, report, and write ../jarvis-os/replyclaim.weights.json
//   node train_replyclaim.js --dry      # report only
const fs = require('fs');
const path = require('path');
const intent = require('../jarvis-os/intent.js');

const CLASSES = ['done', 'acting', 'promised', 'none'];
const NONE = CLASSES.indexOf('none');
const DATA = path.join(__dirname, 'data');
// --data <file in data/> and --out <path>: round 5 (2026-10-10) trains from replyclaim_train_r5.jsonl into a CANDIDATE weights file,
// so the live replyclaim.weights.json is replaced only on his word. Defaults rebuild round 3 exactly as before.
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const rows = fs.readFileSync(path.join(DATA, argOf('--data', 'replyclaim_train.jsonl')), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const HELD = JSON.parse(fs.readFileSync(path.join(DATA, 'replyclaim_heldout.json'), 'utf8'));
const LIVE = JSON.parse(fs.readFileSync(path.join(DATA, 'replyclaim_live.json'), 'utf8'));
const HELD2 = JSON.parse(fs.readFileSync(path.join(DATA, 'replyclaim_heldout2.json'), 'utf8'));
const HELD3 = JSON.parse(fs.readFileSync(path.join(DATA, 'replyclaim_heldout3.json'), 'utf8'));
const HELD4 = JSON.parse(fs.readFileSync(path.join(DATA, 'replyclaim_heldout4.json'), 'utf8'));
// #6 (2026-10-10, items are [his message, reply]; read when it judged jarvis-as-judge) and FRESH #7 (written before round-5 data).
const pairsToReplies = j => ({ claim: j.claim.map(x => Array.isArray(x) ? x[1] : x), none: j.none.map(x => Array.isArray(x) ? x[1] : x) });
const HELD6 = fs.existsSync(path.join(DATA, 'replyclaim_heldout6.json')) ? pairsToReplies(JSON.parse(fs.readFileSync(path.join(DATA, 'replyclaim_heldout6.json'), 'utf8'))) : null;
const HELD7 = fs.existsSync(path.join(DATA, 'replyclaim_heldout7.json')) ? JSON.parse(fs.readFileSync(path.join(DATA, 'replyclaim_heldout7.json'), 'utf8')) : null;
const norm = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
const heads = t => String(t).split(/(?<=[.!?])\s+/).slice(0, 3).map(x => x.trim()).filter(Boolean);
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

// Softmax regression, full-batch Adam, class-balanced loss, L2 on W.
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
  const ITERS = 300, TAUS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const folds = rows.map((_, i) => i % 5);
  let best = null;
  const cands = [];
  console.log('training rows ' + rows.length + '; 5-fold CV, binary claim-vs-none balanced accuracy');
  for (const which of Object.keys(MODELS)) {
    const X = []; for (const r of rows) X.push(await feat(r.text, which));
    for (const lambda of [1e-4, 1e-3, 1e-2]) {
      const pNone = new Array(rows.length);
      for (let f = 0; f < 5; f++) {
        const tr = [], ty = [];
        for (let i = 0; i < rows.length; i++) if (folds[i] !== f) { tr.push(X[i]); ty.push(y[i]); }
        const m = train(tr, ty, lambda, ITERS);
        for (let i = 0; i < rows.length; i++) if (folds[i] === f) pNone[i] = probs(m.W, m.b, X[i])[NONE];
      }
      for (const tau of TAUS) {
        let tp = 0, fn = 0, tn = 0, fp = 0;
        for (let i = 0; i < rows.length; i++) {
          const claim = y[i] !== NONE, said = pNone[i] < tau;
          if (claim && said) tp++; else if (claim) fn++; else if (said) fp++; else tn++;
        }
        const bal = (tp / (tp + fn) + tn / (tn + fp)) / 2;
        cands.push({ which, lambda, tau, bal, tp, fn, fp, tn });
      }
      const mine = cands.filter(c => c.which === which && c.lambda === lambda);
      console.log('  ' + which.padEnd(7) + ' λ=' + String(lambda).padEnd(7) + ' CV bal by τ: ' + mine.map(c => c.tau + ':' + c.bal.toFixed(3)).join(' '));
    }
  }
  // ROUND 2 TIE-BREAK. Round 1 sent ties to the lowest τ, and on easy training rows every τ ties — so it
  // picked the strictest edge of the grid (0.2) and missed shapes it had been trained on. Now: the best CV
  // score, and among configurations within 0.002 of it, the MIDDLE τ of the tied range.
  const top = Math.max(...cands.map(c => c.bal));
  const tied = cands.filter(c => c.bal >= top - 0.002);
  const cfg = tied.filter(c => c.which === tied[0].which && c.lambda === tied[0].lambda).sort((a, b) => a.tau - b.tau);
  best = cfg[Math.floor((cfg.length - 1) / 2)];
  console.log('\nCHOSEN BY CV: ' + best.which + ', λ ' + best.lambda + ', τ ' + best.tau + ' — CV balanced ' + best.bal.toFixed(3) +
    ' (claims caught ' + best.tp + '/' + (best.tp + best.fn) + ', none flagged ' + best.fp + '/' + (best.fp + best.tn) + ')');

  const X = []; for (const r of rows) X.push(await feat(r.text, best.which));
  const model = train(X, y, best.lambda, ITERS);
  const judge = async text => {
    for (const h of heads(text)) {
      const p = probs(model.W, model.b, await feat(h.slice(0, 200), best.which));
      if (p[NONE] < best.tau) { let k = 0; for (let c = 1; c < NONE; c++) if (p[c] > p[k]) k = c; return CLASSES[k]; }
    }
    return null;
  };
  for (const [name, set] of [['HELD-OUT #1 (written first; round 1 saw its misses)', HELD], ['LIVE (real blocked 3B replies; round 1 saw its misses)', LIVE], ['HELD-OUT #3 (written before round 2)', HELD2], ['HELD-OUT #4 (round-3 misses seen)', HELD3], ['HELD-OUT #5 (FRESH, written after round-4 data, before training)', HELD4]].concat(HELD6 ? [['HELD-OUT #6 (2026-10-10, read)', HELD6]] : [], HELD7 ? [['HELD-OUT #7 (FRESH, written before round-5 data)', HELD7]] : [])) {
    const miss = [], flag = [];
    for (const s of set.claim) if (!(await judge(s))) miss.push(s);
    for (const s of set.none) { const c = await judge(s); if (c) flag.push(s + '  [' + c + ']'); }
    console.log('\n' + name + ': claims caught ' + (set.claim.length - miss.length) + '/' + set.claim.length +
      ', answers flagged ' + flag.length + '/' + set.none.length);
    for (const s of miss) console.log('   missed:  ' + s);
    for (const s of flag) console.log('   FLAGGED: ' + s);
  }
  console.log('\n(live guard for comparison: held-out 13/45 caught, 8/45 flagged; live set 7/7 caught, 15/15 flagged — it blocked every one)');

  if (!process.argv.includes('--dry')) {
    const outFile = path.resolve(__dirname, argOf('--out', path.join('..', 'jarvis-os', 'replyclaim.weights.json')));
    fs.writeFileSync(outFile, JSON.stringify({
      _about: 'Trained by finetune/train_replyclaim.js on data/' + argOf('--data', 'replyclaim_train.jsonl') + ' — do not edit by hand.',
      trainedAt: new Date().toISOString(), rows: rows.length, embed: best.which, models: MODELS[best.which],
      classes: CLASSES, tau: best.tau, lambda: best.lambda, cv: { bal: +best.bal.toFixed(4), tp: best.tp, fn: best.fn, fp: best.fp, tn: best.tn },
      W: model.W.map(w => Array.from(w, v => +v.toFixed(6))), b: Array.from(model.b, v => +v.toFixed(6)),
    }));
    console.log('\nwrote ' + path.relative(path.join(__dirname, '..'), outFile));
  }
  process.exit(0);
})();
