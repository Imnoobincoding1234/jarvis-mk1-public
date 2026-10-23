'use strict';
// MEASUREMENT SCRIPT — not a test; nothing is stored. Loads only the embedder.
//
// WHAT JARVIS STORES AS A FACT ABOUT THE USER (2026-09-25). Reported: "tell me a fun fact about space" was
// stored and answered "Noted — I will remember that." The lane was a remember-phrase list (REMEMBER_RE,
// which also cut the fact out of the sentence), then isQuestion() (a word test), then selffact's
// classifier. The candidate is the classifier ALONE, with regions for requests to JARVIS, questions about
// the user and chat — no word list anywhere — so the decision is the embedder's, before any chat model.
//
// Held-out: finetune/data/selffact_heldout.json, written before this ran.
//   node sweeps/sweep_selffact.js
const fs = require('fs');
const path = require('path');
const J = require('../server.js');
const intent = require('../intent.js');
const SF = require('../selffact.js');

const H = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', 'selffact_heldout.json'), 'utf8'));
// The live lane's own remember-phrase list, copied here only to measure what it did.
const REMEMBER_RE = /^(?:jarvis[,\s]+)?(?:please\s+)?(?:remember|note down|make a note|keep in mind|don'?t forget)\s+(?:that\s+|this[:,]?\s+)?(.{3,300})$/i;

(async () => {
  SF.init({ isQuestion: J.isQuestion, jlog: () => {} });
  const current = async s => !!(s.match(REMEMBER_RE) || (!J.isQuestion(s) && await SF.isSelfFact(s)));
  const cand = SF.EXEMPLARS_V2 ? intent.makeClassifier({ exemplars: SF.EXEMPLARS_V2, minMargin: SF.MIN_MARGIN_V2, none: 'other',
    groups: SF.GROUPS_V2, label: 'SelfFactV2', jlog: () => {} }) : null;
  const candidate = async s => { const r = cand ? await cand(s) : null; return !!(r && (r.group || r.id) === 'durable'); };
  // LEAVE-ONE-OUT MARGIN over the V2 exemplars (held-out sets never consulted): each exemplar is scored
  // against centroids built without it; durable wins only by >= margin over the best non-durable region.
  const norm = t => String(t).toLowerCase().trim().replace(/\s+/g, ' ');
  const rows = []; for (const [id, list] of Object.entries(SF.EXEMPLARS_V2)) for (const t of list) rows.push({ id, v: await intent.embed(norm(t), intent.MODEL) });
  const mean = vs => { const c = new Array(vs[0].length).fill(0); for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i] / vs.length; return c; };
  const looScore = (skip) => { const byId = {}; rows.forEach((r, i) => { if (i !== skip) (byId[r.id] = byId[r.id] || []).push(r.v); });
    const cents = Object.fromEntries(Object.entries(byId).map(([k, vs]) => [k, mean(vs)])); const v = rows[skip].v;
    const d = intent.cos(v, cents.durable); let best = -1; for (const [k, c] of Object.entries(cents)) if (k !== 'durable') best = Math.max(best, intent.cos(v, c)); return d - best; };
  const loo = rows.map((r, i) => ({ durable: r.id === 'durable', s: looScore(i) }));
  let pick = null;
  for (const m of [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05]) {
    const right = loo.filter(x => (x.s >= m) === x.durable).length, wrongStore = loo.filter(x => !x.durable && x.s >= m).length;
    console.log('LOO margin ' + String(m).padEnd(6) + ' right ' + right + '/' + loo.length + ', wrongly durable ' + wrongStore);
    if (!pick || right > pick.right || (right === pick.right && wrongStore < pick.wrongStore)) pick = { m, right, wrongStore };
  }
  console.log('LOO picks margin ' + pick.m);
  const cand2 = intent.makeClassifier({ exemplars: SF.EXEMPLARS_V2, minMargin: pick.m, none: 'other', groups: SF.GROUPS_V2, label: 'SelfFactV2b', jlog: () => {} });
  // JARVIS's own name addressed at the front is not content (a machine-owned string, not a word list).
  const unaddress = t => String(t).replace(/^\s*jarvis\b[\s,:!-]*/i, '');
  const candidate2 = async s => { const r = await cand2(unaddress(s)); return !!(r && (r.group || r.id) === 'durable'); };
  const H2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', 'selffact_heldout2.json'), 'utf8'));
  for (const [nm, fn] of [['CURRENT', current], ['CANDIDATE+name strip+LOO margin', candidate2]]) {
    const miss = [], wrong = [];
    for (const s of H2.store) if (!(await fn(s))) miss.push(s);
    for (const s of H2.skip) if (await fn(s)) wrong.push(s);
    console.log('\nFRESH #2 — ' + nm + ': stored ' + (H2.store.length - miss.length) + '/' + H2.store.length + ', WRONGLY stored ' + wrong.length + '/' + H2.skip.length);
    for (const s of miss) console.log('   missed:  ' + s);
    for (const s of wrong) console.log('   WRONG:   ' + s);
  }
  global.__cand2 = candidate2;
  for (const [name, fn] of [['#1 CURRENT (list + isQuestion + classifier)', current], ['#1 CANDIDATE (classifier only)', cand ? candidate : null], ['#1 CANDIDATE+name strip+LOO margin', candidate2]]) {
    if (!fn) { console.log('\n' + name + ': not defined yet'); continue; }
    const miss = [], wrong = [];
    for (const s of H.store) if (!(await fn(s))) miss.push(s);
    for (const s of H.skip) if (await fn(s)) wrong.push(s);
    console.log('\n' + name + ': stored ' + (H.store.length - miss.length) + '/' + H.store.length + ' facts, WRONGLY stored ' + wrong.length + '/' + H.skip.length);
    for (const s of miss) console.log('   missed:  ' + s);
    for (const s of wrong) console.log('   WRONG:   ' + s);
  }
  process.exit(0);
})();
