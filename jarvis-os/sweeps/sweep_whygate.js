'use strict';
// MEASUREMENT SCRIPT — not a test; nothing is executed. WHERE SHOULD whyintent.js's MARGIN SIT?
//
// 1. LEAVE-ONE-OUT on the exemplars (the only data the margin may be chosen from): each exemplar is read
//    against centroids built WITHOUT it, exactly as intent.makeClassifier scores — mean vectors, cosine,
//    margin = best region minus the best region of the OTHER group.
// 2. The held-out set (finetune/data/whyintent_heldout.json, written before the exemplars) is only
//    REPORTED at each margin.
//
//   node sweeps/sweep_whygate.js
const path = require('path');
const intent = require('../intent.js');
const R = require('../whyintent.js');
R.REASON_EXEMPLARS = R.WHY_EXEMPLARS;

const HELD = require(path.join(__dirname, '..', '..', 'finetune', 'data', 'whyintent_heldout.json')).cases.map(c => ({ q: c.q, reasoning: c.why }));
const GATES = [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06];

const mean = vs => { const c = new Array(vs[0].length).fill(0); for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i]; return c.map(x => x / vs.length); };
function read(v, cents) {
  const scored = Object.entries(cents).map(([id, c]) => ({ id, s: intent.cos(v, c) })).sort((a, b) => b.s - a.s);
  const g = R.GROUPS[scored[0].id];
  const rival = scored.find(x => R.GROUPS[x.id] !== g);
  return { group: g, id: scored[0].id, margin: scored[0].s - rival.s };
}

(async () => {
  if (!(await intent.embed('probe'))) { console.log('Skipping — the embedder is not reachable'); process.exit(0); }
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ex = new Set(Object.values(R.REASON_EXEMPLARS).flat().map(norm));
  const overlap = HELD.filter(c => ex.has(norm(c.q)));
  if (overlap.length) { console.log('HELD-OUT SENTENCE IS AN EXEMPLAR: ' + overlap.map(c => c.q).join(' | ')); process.exit(1); }

  const vec = {};
  for (const [id, list] of Object.entries(R.REASON_EXEMPLARS)) vec[id] = await Promise.all(list.map(p => intent.embed(p)));
  const full = {}; for (const id of Object.keys(vec)) full[id] = mean(vec[id]);

  // 1. leave-one-out
  const loo = [];
  for (const [id, vs] of Object.entries(vec)) {
    vs.forEach((v, k) => {
      const cents = Object.assign({}, full, { [id]: mean(vs.filter((_, j) => j !== k)) });
      const r = read(v, cents);
      loo.push({ text: R.REASON_EXEMPLARS[id][k], truth: R.GROUPS[id], said: r.group, via: r.id, margin: r.margin });
    });
  }
  const nR = loo.filter(x => x.truth === 'why_last').length, nN = loo.length - nR;
  console.log('LEAVE-ONE-OUT on the exemplars (' + nR + ' why, ' + nN + ' look-alikes)');
  console.log('   gate    why caught   look-alikes called why');
  for (const g of GATES) {
    const tp = loo.filter(x => x.truth === 'why_last' && x.said === 'why_last' && x.margin >= g).length;
    const fp = loo.filter(x => x.truth !== 'why_last' && x.said === 'why_last' && x.margin >= g).length;
    console.log('   ' + g.toFixed(3).padEnd(8) + (tp + '/' + nR).padStart(10) + (fp + '/' + nN).padStart(22) + (g === R.MIN_MARGIN ? '   ← shipped' : ''));
  }
  for (const x of loo) if ((x.truth === 'why_last') !== (x.said === 'why_last'))
    console.log('   LOO ' + (x.truth === 'why_last' ? 'missed  ' : 'intruder') + ' ' + JSON.stringify(x.text) + ' → ' + x.via + ' (' + x.margin.toFixed(3) + ')');

  // 2. held-out, reported only
  const held = [];
  for (const c of HELD) { const r = read(await intent.embed(c.q), full); held.push(Object.assign({ q: c.q, truth: c.reasoning }, r)); }
  const hR = held.filter(x => x.truth).length, hN = held.length - hR;
  console.log('\nHELD-OUT (reported, never tuned on)');
  console.log('   gate    why caught   false alarms');
  for (const g of GATES) {
    const tp = held.filter(x => x.truth && x.group === 'why_last' && x.margin >= g).length;
    const fp = held.filter(x => !x.truth && x.group === 'why_last' && x.margin >= g).length;
    console.log('   ' + g.toFixed(3).padEnd(8) + (tp + '/' + hR).padStart(10) + (fp + '/' + hN).padStart(16) + (g === R.MIN_MARGIN ? '   ← shipped' : ''));
  }
  for (const x of held) {
    const said = x.group === 'why_last' && x.margin >= R.MIN_MARGIN;
    if (said !== x.truth) console.log('   ' + (x.truth ? 'missed  ' : 'FALSE   ') + JSON.stringify(x.q.slice(0, 70)) + ' → ' + x.id + ' (' + x.margin.toFixed(3) + ')');
  }
  process.exit(0);
})();
