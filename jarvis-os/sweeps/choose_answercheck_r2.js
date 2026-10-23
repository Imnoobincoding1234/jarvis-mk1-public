#!/usr/bin/env node
// choose_answercheck_r2.js — round 2 of the answer check (finetune/README "Round 2 of the answer check").
// Reads the features sweep_answercheck_r2.js collected (state/answercheck_r2_set1.json, …_set2.json).
//   node sweeps/choose_answercheck_r2.js          choose on set 1 (leave-one-out) and print every candidate
//   node sweeps/choose_answercheck_r2.js --set2   …then score the chosen candidate, the shipped check and the rest on set 2
// errors = 2 × (a reply that should go on but is kept) + 1 × (a right answer sent on).
'use strict';
const fs = require('fs');
const path = require('path');
const S = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'answercheck_r2_' + n + '.json'), 'utf8'));
const BUDGET = 1500;   // ms, added median warm

const rowsOf = n => Object.entries(S(n)).map(([i, f]) => Object.assign({ i: +i }, f)).filter(f => f.after && f.region !== undefined);
const isRight = f => f.label === 'right';
function count(rows, keep) {
  const t = { rightKept: 0, rightSent: 0, declKept: 0, declSent: 0, wrongKept: 0, wrongSent: 0 };
  for (const f of rows) {
    const k = keep(f);
    if (f.label === 'right') k ? t.rightKept++ : t.rightSent++;
    else if (f.label === 'decline') k ? t.declKept++ : t.declSent++;
    else k ? t.wrongKept++ : t.wrongSent++;
  }
  t.errors = 2 * (t.declKept + t.wrongKept) + t.rightSent;
  return t;
}
const fmt = t => 'errors ' + String(t.errors).padStart(3) + ' | right kept ' + t.rightKept + '/' + (t.rightKept + t.rightSent) +
  ', declines sent ' + t.declSent + '/' + (t.declSent + t.declKept) + ', wrong sent ' + t.wrongSent + '/' + (t.wrongSent + t.wrongKept);
const med = a => { const b = a.filter(x => typeof x === 'number').sort((p, q) => p - q); return b.length ? b[b.length >> 1] : 0; };

// ---- the features. Judge ratios are P(yes)/(P(yes)+P(no)); region is the signed decline margin (+ = decline).
const FOLLOW = ['after', 'cont', 'answers', 'user2'];
const lg = r => Math.log(Math.min(Math.max(r, 1e-4), 1 - 1e-4) / (1 - Math.min(Math.max(r, 1e-4), 1 - 1e-4)));
const val = (f, k) => k === 'region' ? -f.region : k === 'alone' || k === 'q3b' ? (f[k] ? f[k].r : 0.5) : f[k].r;   // larger = keep
function timeOf(rows, keys) {
  // follow-ups in the order measured (after, cont, answers, user2 — each on the cache the one before left) + region
  let ms = 0;
  for (const k of keys) {
    if (FOLLOW.includes(k)) ms += med(rows.map(f => f[k].ms));
    else if (k === 'region') ms += med(rows.map(f => f.regionMs));
    else ms += 2700;   // the standalone judges: no shared cache (measured round 1: 2.7 s); the 3B adds a model swap
  }
  return ms;
}

// ---- candidate families. Each returns { name, keys, fit(train) → keep(f) }
// candidate cut points: below everything, then midpoints at 25 quantiles of the training values
function gridFor(train, k) {
  const v = [...new Set(train.map(f => val(f, k)))].sort((a, b) => a - b);
  const g = [-Infinity];
  for (let q = 1; q <= 25; q++) { const j = Math.min(v.length - 1, Math.floor(q * v.length / 26)); g.push(j + 1 < v.length ? (v[j] + v[j + 1]) / 2 : v[j] + 1e-9); }
  return [...new Set(g)];
}
const cands = [];
// fixed rules, nothing fitted
cands.push({ name: 'SHIPPED: after > 0.5 AND region ≤ -0.035', keys: ['after', 'region'], fit: () => f => f.after.r > 0.5 && !(f.region > -0.035) });
for (let a = 0; a < FOLLOW.length; a++) {
  cands.push({ name: FOLLOW[a] + ' > 0.5', keys: [FOLLOW[a]], fit: () => f => f[FOLLOW[a]].r > 0.5 });
  cands.push({ name: FOLLOW[a] + ' > 0.5 AND region ≤ 0', keys: [FOLLOW[a], 'region'], fit: () => f => f[FOLLOW[a]].r > 0.5 && !(f.region > 0) });
  for (let b = a + 1; b < FOLLOW.length; b++) {
    cands.push({ name: FOLLOW[a] + ' > 0.5 AND ' + FOLLOW[b] + ' > 0.5', keys: [FOLLOW[a], FOLLOW[b]], fit: () => f => f[FOLLOW[a]].r > 0.5 && f[FOLLOW[b]].r > 0.5 });
    for (let c = b + 1; c < FOLLOW.length; c++)
      cands.push({ name: FOLLOW[a] + ' AND ' + FOLLOW[b] + ' AND ' + FOLLOW[c] + ' (> 0.5 each)', keys: [FOLLOW[a], FOLLOW[b], FOLLOW[c]],
        fit: () => f => f[FOLLOW[a]].r > 0.5 && f[FOLLOW[b]].r > 0.5 && f[FOLLOW[c]].r > 0.5 });
  }
}
// one threshold, fitted
for (const k of [...FOLLOW, 'region']) cands.push({ name: k + ' thresholded', keys: [k], fit: train => {
  let best = null; for (const t of gridFor(train, k)) { const e = count(train, f => val(f, k) > t).errors; if (!best || e < best.e) best = { t, e }; }
  return f => val(f, k) > best.t; } });
// two thresholds, AND, fitted
const PAIRKEYS = [...FOLLOW, 'region'];
for (let a = 0; a < PAIRKEYS.length; a++) for (let b = a + 1; b < PAIRKEYS.length; b++) {
  const ka = PAIRKEYS[a], kb = PAIRKEYS[b];
  cands.push({ name: ka + ' AND ' + kb + ', both thresholded', keys: [ka, kb], fit: train => {
    let best = null; const ga = gridFor(train, ka), gb = gridFor(train, kb);
    for (const ta of ga) for (const tb of gb) { const e = count(train, f => val(f, ka) > ta && val(f, kb) > tb).errors; if (!best || e < best.e) best = { ta, tb, e }; }
    return f => val(f, ka) > best.ta && val(f, kb) > best.tb; } });
}
// logistic regression on up to three features (judge ratios as log-odds, region as is); keep when P(right) > 2/3,
// the point where keeping costs no more than sending on under the 2 : 1 errors
function logit(train, keys) {
  const X = f => keys.map(k => k === 'region' ? f.region * 10 : lg(val(f, k)));
  const w = new Array(keys.length + 1).fill(0);
  for (let it = 0; it < 1500; it++) {
    const g = new Array(w.length).fill(0);
    for (const f of train) { const x = X(f); const z = w[0] + x.reduce((s, v, j) => s + v * w[j + 1], 0); const p = 1 / (1 + Math.exp(-z)); const y = isRight(f) ? 1 : 0;
      g[0] += p - y; x.forEach((v, j) => { g[j + 1] += (p - y) * v; }); }
    for (let j = 0; j < w.length; j++) w[j] -= 0.05 * (g[j] / train.length + 0.01 * (j ? w[j] : 0));
  }
  return f => { const x = X(f); const z = w[0] + x.reduce((s, v, j) => s + v * w[j + 1], 0); return 1 / (1 + Math.exp(-z)) > 2 / 3; };
}
const LRKEYS = [...FOLLOW, 'region'];
for (let a = 0; a < LRKEYS.length; a++) for (let b = a + 1; b < LRKEYS.length; b++) {
  cands.push({ name: 'logistic(' + LRKEYS[a] + ', ' + LRKEYS[b] + ')', keys: [LRKEYS[a], LRKEYS[b]], fit: train => logit(train, [LRKEYS[a], LRKEYS[b]]) });
  for (let c = b + 1; c < LRKEYS.length; c++)
    cands.push({ name: 'logistic(' + LRKEYS[a] + ', ' + LRKEYS[b] + ', ' + LRKEYS[c] + ')', keys: [LRKEYS[a], LRKEYS[b], LRKEYS[c]], fit: train => logit(train, [LRKEYS[a], LRKEYS[b], LRKEYS[c]]) });
}
// references, over the budget
cands.push({ name: 'REF standalone jarvis > 0.5', keys: ['alone'], fit: () => f => (f.alone ? f.alone.r : 0.5) > 0.5 });
cands.push({ name: 'REF standalone qwen2.5:3b > 0.5', keys: ['q3b'], fit: () => f => (f.q3b ? f.q3b.r : 0.5) > 0.5 });
cands.push({ name: 'REF qwen2.5:3b > 0.5 AND region ≤ 0', keys: ['q3b', 'region'], fit: () => f => (f.q3b ? f.q3b.r : 0.5) > 0.5 && !(f.region > 0) });

// ---- leave-one-out on set 1
const set1 = rowsOf('set1');
const fittedRule = c => /thresholded|logistic/.test(c.name);
const results = [];
for (const c of cands) {
  let keepLoo;
  if (fittedRule(c)) { const dec = new Map(); for (const f of set1) dec.set(f.i, c.fit(set1.filter(g => g !== f))(f)); keepLoo = f => dec.get(f.i); }
  else keepLoo = c.fit(set1);
  const t = count(set1, keepLoo);
  const ms = timeOf(set1, c.keys);
  results.push({ c, t, ms, ok: ms <= BUDGET && !c.name.startsWith('REF') });
}
results.sort((a, b) => a.t.errors - b.t.errors || a.ms - b.ms);
console.log('SET 1 (tuning, ' + set1.length + ' rows; fitted rules scored leave-one-out):');
for (const r of results) console.log((r.ok ? '  ' : 'x ') + fmt(r.t) + ' | ' + String(Math.round(r.ms)).padStart(5) + ' ms | ' + r.c.name);
const winner = results.find(r => r.ok);
console.log('\nCHOSEN on set 1: ' + winner.c.name + ' — ' + fmt(winner.t) + ', ~' + Math.round(winner.ms) + ' ms');

if (process.argv.includes('--set2')) {
  const set2 = rowsOf('set2');
  console.log('\nSET 2 (confirmation, ' + set2.length + ' rows; every rule fitted on all of set 1):');
  const shipped = results.find(r => r.c.name.startsWith('SHIPPED'));
  for (const r of [winner, shipped, ...results.filter(x => x !== winner && x !== shipped)]) {
    const t = count(set2, r.c.fit(set1));
    console.log((r === winner ? 'WINNER  ' : r === shipped ? 'SHIPPED ' : '        ') + fmt(t) + ' | ' + r.c.name);
    if (r === winner || r === shipped) {
      const keep = r.c.fit(set1);
      for (const f of set2) { const k = keep(f); if ((f.label === 'right') !== k) console.log('            ' + (k ? 'KEPT ' + f.label : 'SENT right') + '  #' + f.i + ' ' + f.q + ' → ' + f.reply.slice(0, 100)); }
    }
  }
}
