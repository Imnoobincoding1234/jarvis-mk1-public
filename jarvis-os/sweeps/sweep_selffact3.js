'use strict';
// MEASUREMENT SCRIPT — not a test; nothing is stored. Loads only the embedder.
// The self-fact lane, V2 (live) vs the V3 candidate (selffact.js EXEMPLARS_V3), on held-outs #1, #2 and the casual #3. The bar
// was written in finetune/build_selffact_heldout3.js BEFORE this ran; this script applies it and says SHIPS or STAYS.
//   node sweeps/sweep_selffact3.js
const fs = require('fs');
const path = require('path');
const intent = require('../intent.js');
const SF = require('../selffact.js');
const D = path.join(__dirname, '..', '..', 'finetune', 'data');
// ---- V3 CANDIDATE (2026-10-10, he is away) — measured by sweeps/sweep_selffact3.js against the bar written in
// finetune/build_selffact_heldout3.js BEFORE it ran. RESULT: failed its bar (lost real facts) — not live; kept here so the run can be reproduced. V2 had no region for news of the day ("i aced my
// test"), compliments to JARVIS, a how-to question or a slang request, so those landed in `durable` and were stored as facts
// about him. New regions, neutral wording, new sentences only (no line of #1–#3 or either casual stress set).
const EXEMPLARS_V3 = Object.assign({}, SF.EXEMPLARS_V2, {
  transient: SF.EXEMPLARS_V2.transient.concat(['i am starving', 'feeling a bit down today', 'i am so bored']),
  'other-request': SF.EXEMPLARS_V2['other-request'].concat(['play some old bollywood songs', 'i want to hear some music', 'show me funny videos',
    'find me a good movie to watch']),
  'other-chat': SF.EXEMPLARS_V2['other-chat'].concat(['hey whats going on', 'see you later', 'haha thats funny', 'you are awesome jarvis',
    'you are being really slow', 'kya haal hai', 'oh nice', 'no way']),
  'other-event': ['i just got back from tuition', 'we won our football match today', 'my laptop crashed in the middle of class',
    'got my results this morning', 'my brother broke my headphones', 'it rained the whole way home'],
  'other-ask': ['how can i get better at maths', 'what should i do this weekend', 'which laptop should i buy', 'why do cats purr',
    'how long should i study each day', 'is it bad to skip breakfast'],
});
const GROUPS_V3 = Object.assign({}, SF.GROUPS_V2, { 'other-event': 'other', 'other-ask': 'other' });

const H = n => JSON.parse(fs.readFileSync(path.join(D, n), 'utf8'));
const H1 = H('selffact_heldout.json'), H2 = H('selffact_heldout2.json'), H3 = H('selffact_heldout3.json');

// V3's new sentences must not be copies of anything they are judged on, or of either casual stress set.
const words = s => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
const jac = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n || 1); };
const judged = [].concat(H1.store, H1.skip, H2.store, H2.skip, H3.store, H3.skip);
for (const f of ['casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl'])
  for (const l of fs.readFileSync(path.join(D, f), 'utf8').split('\n')) if (l.trim()) judged.push(JSON.parse(l).text);
const v2set = new Set(Object.values(SF.EXEMPLARS_V2).flat());
const added = Object.values(EXEMPLARS_V3).flat().filter(s => !v2set.has(s));
let bad = 0;
for (const s of added) for (const o of judged) if (jac(s, o) >= 0.75) { console.log('V3 sentence collides: ' + JSON.stringify(s) + ' ~ ' + JSON.stringify(o)); bad++; }
if (bad) { console.log('fix the V3 sentences first — not measured'); process.exit(1); }

const unaddress = t => String(t).replace(/^\s*jarvis\b[\s,:!-]*/i, '');
const make = (ex, gr, label) => { const c = intent.makeClassifier({ exemplars: ex, minMargin: SF.MIN_MARGIN_V2, none: 'other', groups: gr, label, jlog: () => {} });
  return async s => { const r = await c(unaddress(s)); return { stored: !!(r && (r.group || r.id) === 'durable'), id: r ? r.id : 'none' }; }; };
const V2 = make(SF.EXEMPLARS_V2, SF.GROUPS_V2, 'SF-V2'), V3 = make(EXEMPLARS_V3, GROUPS_V3, 'SF-V3');

(async () => {
  const res = {};
  for (const [nm, fn] of [['V2', V2], ['V3', V3]]) {
    res[nm] = {};
    for (const [hn, h] of [['#1', H1], ['#2', H2], ['#3', H3]]) {
      const miss = [], wrong = [];
      for (const s of h.store) { const r = await fn(s); if (!r.stored) miss.push(s + '  (' + r.id + ')'); }
      for (const s of h.skip) { const r = await fn(s); if (r.stored) wrong.push(s); }
      res[nm][hn] = { stored: h.store.length - miss.length, of: h.store.length, wrong: wrong.length, ofSkip: h.skip.length };
      console.log(nm + ' ' + hn + ': facts stored ' + (h.store.length - miss.length) + '/' + h.store.length + ', junk WRONGLY stored ' + wrong.length + '/' + h.skip.length);
      for (const s of miss) console.log('     missed: ' + s);
      for (const s of wrong) console.log('     WRONG:  ' + s);
    }
  }
  const a = res.V2, b = res.V3;
  const old = r => ({ stored: r['#1'].stored + r['#2'].stored, wrong: r['#1'].wrong + r['#2'].wrong });
  const c1 = b['#3'].wrong <= Math.floor(a['#3'].wrong / 2), c2 = b['#3'].stored >= a['#3'].stored - 2;
  const c3 = old(b).stored >= old(a).stored - 1, c4 = old(b).wrong <= old(a).wrong;
  console.log('\nBAR (pre-registered): #3 junk ≤ half of V2 [' + b['#3'].wrong + ' vs ' + a['#3'].wrong + '] ' + (c1 ? 'ok' : 'FAIL') +
    ' · #3 facts ≥ V2 − 2 [' + b['#3'].stored + ' vs ' + a['#3'].stored + '] ' + (c2 ? 'ok' : 'FAIL') +
    ' · #1+#2 facts ≥ V2 − 1 [' + old(b).stored + ' vs ' + old(a).stored + '] ' + (c3 ? 'ok' : 'FAIL') +
    ' · #1+#2 junk ≤ V2 [' + old(b).wrong + ' vs ' + old(a).wrong + '] ' + (c4 ? 'ok' : 'FAIL'));
  console.log(c1 && c2 && c3 && c4 ? 'V3 SHIPS' : 'V3 STAYS OUT — V2 remains');
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
