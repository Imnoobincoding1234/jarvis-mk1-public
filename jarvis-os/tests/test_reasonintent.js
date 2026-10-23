'use strict';
// reasonintent.js — is this a question to WORK OUT? NEEDS OLLAMA (it asks the embedder).
//
// Replaced looksLikeReasoning and its word lists on 2026-09-25. What must hold, on the held-out sets in
// finetune/data (never training rows — the suite checks):
//   - NOTHING that is not a worked-out question is read as one: a false yes takes a command with numbers
//     away from its lane, or has phi invent a machine answer. Zero, on every set.
//   - his live failure ("…what will be their sum?", 43 s) is read as one.
//   - the catch rate on the freshest set does not fall below the shipped 21/28 (printed; it is not 100%).
// The weights file is required here: without it the module falls back to the centroid regions.
const fs = require('fs');
const path = require('path');
const intent = require('../intent.js');
const R = require('../reasonintent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const DATA = path.join(__dirname, '..', '..', 'finetune', 'data');
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).cases; } catch (e) { return null; } };

(async () => {
  if (!(await intent.embed('probe'))) { console.log('Skipping — the embedder is not reachable'); process.exit(0); }
  const sets = ['reasongate_heldout.json', 'reasongate_heldout2.json', 'reasongate_heldout3.json'].map(f => [f, load(f)]);
  if (sets.some(([, c]) => !c)) { console.log('Skipping — the held-out sets are not on this machine (finetune/data is his)'); process.exit(0); }

  console.log('\n— the trained weights are there —');
  ok(!!R.weights(), 'reasongate.weights.json loads');

  console.log('\n— no held-out sentence is a training row —');
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const train = new Set(fs.readFileSync(path.join(DATA, 'reasongate_train.jsonl'), 'utf8').trim().split('\n').map(l => norm(JSON.parse(l).text)));
  for (const [f, cases] of sets) ok(cases.every(c => !train.has(norm(c.q))), f + ' shares no sentence with training');

  console.log('\n— held-out —');
  const caught = {};
  for (const [f, cases] of sets) {
    let tp = 0, fp = 0, nR = 0; const falses = [];
    for (const c of cases) {
      const y = await R.isReasoning(c.q);
      if (c.reasoning) { nR++; if (y) tp++; } else if (y) { fp++; falses.push(c.q); }
    }
    caught[f] = tp;
    console.log('    ' + f + ': caught ' + tp + '/' + nR + ', false alarms ' + fp + '/' + (cases.length - nR));
    ok(fp === 0, f + ': nothing else is read as a question to work out' + (falses.length ? ' — ' + falses.join(' | ') : ''));
  }
  ok(caught['reasongate_heldout3.json'] >= 21, 'the freshest set does not fall below the shipped 21/28');

  console.log('\n— his live failure, and the old gate\'s must-not-fire cases —');
  ok(await R.isReasoning(sets[0][1][0].q), '"…what will be their sum?" is a question to work out');
  for (const t of ['open tab 3 and delete the last 2 files', 'how much battery do I have', 'how many apps are running',
                   'he called me three times', 'what happened on 2026-09-09', 'my head hurts today', '', null])
    ok(!(await R.isReasoning(t)), JSON.stringify(t) + ' is not');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed: ' + (e.stack || e)); process.exit(1); });
