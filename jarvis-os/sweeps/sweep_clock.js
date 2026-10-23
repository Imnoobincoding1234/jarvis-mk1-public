'use strict';
// MEASUREMENT SCRIPT — not a test; loads only the embedder. The clock lane (clockintent.js) against the bar written in
// finetune/build_clock_heldout.js BEFORE the lane existed. The margin is chosen by leave-one-out over the exemplars ONLY;
// the held-out is then run once at that margin.
//   node sweeps/sweep_clock.js
const fs = require('fs');
const path = require('path');
const intent = require('../intent.js');
const C = require('../clockintent.js');
const D = path.join(__dirname, '..', '..', 'finetune', 'data');
const H = JSON.parse(fs.readFileSync(path.join(D, 'clock_heldout.json'), 'utf8'));

// No exemplar may be a copy of a line it is judged on, or of either casual stress set.
const words = s => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
const jac = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n || 1); };
const judged = [].concat(H.clock, H.zone.map(z => z[0]), H.other);
for (const f of ['casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl'])
  for (const l of fs.readFileSync(path.join(D, f), 'utf8').split('\n')) if (l.trim()) judged.push(JSON.parse(l).text);
let bad = 0;
for (const s of Object.values(C.EXEMPLARS).flat()) for (const o of judged) if (jac(s, o) >= 0.75) { console.log('exemplar collides: ' + JSON.stringify(s) + ' ~ ' + JSON.stringify(o)); bad++; }
if (bad) { console.log('fix the exemplars first — not measured'); process.exit(1); }

(async () => {
  // LEAVE-ONE-OUT over the exemplars: each scored against centroids built without it.
  const norm = t => String(t).toLowerCase().trim().replace(/\s+/g, ' ');
  const rows = [];
  for (const [id, list] of Object.entries(C.EXEMPLARS)) for (const t of list) rows.push({ id, g: C.GROUPS[id], v: await intent.embed(norm(t), intent.MODEL) });
  const mean = vs => { const c = new Array(vs[0].length).fill(0); for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i] / vs.length; return c; };
  const loo = rows.map((r, skip) => {
    const by = {}; rows.forEach((x, i) => { if (i !== skip) (by[x.id] = by[x.id] || []).push(x.v); });
    const sc = Object.entries(by).map(([id, vs]) => ({ id, g: C.GROUPS[id], s: intent.cos(r.v, mean(vs)) })).sort((a, b) => b.s - a.s);
    const rival = sc.find(x => x.g !== sc[0].g);
    return { truth: r.g, win: sc[0].g, margin: sc[0].s - (rival ? rival.s : -1) };
  });
  let pick = null;
  for (const m of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
    const said = x => (x.win !== 'none' && x.margin >= m) ? x.win : 'none';
    const right = loo.filter(x => said(x) === x.truth).length, falseAns = loo.filter(x => x.truth === 'none' && said(x) !== 'none').length;
    console.log('LOO margin ' + String(m).padEnd(5) + ' right ' + right + '/' + loo.length + ', none-exemplars answered ' + falseAns);
    if (!pick || right > pick.right || (right === pick.right && falseAns < pick.falseAns)) pick = { m, right, falseAns };
  }
  console.log('LOO picks margin ' + pick.m + '\n');

  let ok = 0, wrongPlace = 0, falseFire = 0;
  for (const s of H.clock) { const r = await C.read(s, pick.m); const good = r && r.kind === 'clock'; if (good) ok++; console.log((good ? 'ok   ' : 'MISS ') + 'clock  ' + JSON.stringify(s) + ' → ' + (r ? r.kind + (r.zone ? ' ' + r.zone : '') : 'falls through')); }
  for (const [s, z] of H.zone) {
    const r = await C.read(s, pick.m); const good = r && r.kind === 'zone' && r.zone === z;
    if (good) ok++; if (r && r.kind === 'zone' && r.zone !== z) wrongPlace++;
    console.log((good ? 'ok   ' : (r && r.kind === 'zone' ? 'WRONG' : 'MISS ')) + ' zone  ' + JSON.stringify(s) + ' → ' + (r ? r.kind + (r.zone ? ' ' + r.zone : '') : 'falls through'));
  }
  for (const s of H.other) { const r = await C.read(s, pick.m); if (r) { falseFire++; console.log('FIRE  other  ' + JSON.stringify(s) + ' → ' + r.kind + (r.zone ? ' ' + r.zone : '')); } }
  const n = H.clock.length + H.zone.length;
  const c1 = ok >= 34, c2 = wrongPlace === 0, c3 = falseFire <= 1;
  console.log('\nBAR (pre-registered): answered right ' + ok + '/' + n + ' (≥ 34) ' + (c1 ? 'ok' : 'FAIL') + ' · wrong place ' + wrongPlace + ' (0) ' + (c2 ? 'ok' : 'FAIL') +
    ' · false fires ' + falseFire + '/' + H.other.length + ' (≤ 1) ' + (c3 ? 'ok' : 'FAIL'));
  console.log(c1 && c2 && c3 ? 'CLOCK LANE SHIPS at margin ' + pick.m : 'CLOCK LANE STAYS OUT');
  console.log('\nsample replies: ' + C.say({ kind: 'clock' }) + ' | ' + C.say({ kind: 'zone', zone: 'Europe/London', city: 'london' }));
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
