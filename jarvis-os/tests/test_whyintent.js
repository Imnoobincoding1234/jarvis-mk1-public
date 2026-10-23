'use strict';
// whyintent.js — is he asking why JARVIS did what it just did? NEEDS OLLAMA (it asks the embedder).
//
// Held-out: finetune/data/whyintent_heldout.json, written before the exemplars. Prints the margin sweep and
// asserts at the shipped margin: NOTHING that is not a why-question reaches the lane (a false yes answers
// "why is the sky blue" with a routing log), and no held-out sentence is an exemplar.
const fs = require('fs');
const path = require('path');
const intent = require('../intent.js');
const W = require('../whyintent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const HELD = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', 'whyintent_heldout.json'), 'utf8')).cases; } catch (e) { return null; } })();

(async () => {
  if (!(await intent.embed('probe'))) { console.log('Skipping — the embedder is not reachable'); process.exit(0); }
  if (!HELD) { console.log('Skipping — the held-out set is not on this machine (finetune/data is his)'); process.exit(0); }
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ex = new Set(Object.values(W.WHY_EXEMPLARS).flat().map(norm));
  ok(HELD.every(c => !ex.has(norm(c.q))), 'no held-out sentence is an exemplar (' + HELD.length + ' held out)');

  const raw = intent.makeClassifier({ exemplars: W.WHY_EXEMPLARS, minMargin: 0, none: '__unused__', groups: W.GROUPS, label: 'WhyRaw', jlog: () => {} });
  const got = [];
  for (const c of HELD) { const r = await raw(c.q); got.push({ q: c.q, want: c.why, yes: !!(r && W.GROUPS[r.id] === 'why_last'), id: r && r.id, margin: r ? r.margin : 0 }); }
  console.log('\n    margin   caught   false yes');
  for (const g of [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
    const tp = got.filter(x => x.want && x.yes && x.margin >= g).length, fp = got.filter(x => !x.want && x.yes && x.margin >= g).length;
    console.log('    ' + g.toFixed(2).padEnd(9) + (tp + '/' + got.filter(x => x.want).length).padEnd(9) + fp + '/' + got.filter(x => !x.want).length + (g === W.MIN_MARGIN ? '   ← shipped' : ''));
  }
  for (const x of got) { const said = x.yes && x.margin >= W.MIN_MARGIN; if (said !== x.want) console.log('    ' + (x.want ? 'missed   ' : 'FALSE YES') + ' ' + JSON.stringify(x.q) + ' → ' + x.id + ' (' + x.margin.toFixed(3) + ')'); }
  const fps = [];
  for (const c of HELD) if (!c.why && await W.isWhyLast(c.q)) fps.push(c.q);
  ok(fps.length === 0, 'nothing that is not a why-question reaches the lane' + (fps.length ? ': ' + fps.join(' | ') : ''));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed: ' + (e.stack || e)); process.exit(1); });
