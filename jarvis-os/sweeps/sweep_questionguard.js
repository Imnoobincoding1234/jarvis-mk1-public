'use strict';
// MEASUREMENT SCRIPT (2026-10-10, he is away) — not a test; loads no model.
// Should the question guard (blockedForQuestion) veto an action the READER read and checked? The statement guard beside it
// already lets a checked reader action through (3 of 737 sentences, all real requests). Casual dev line s09 "google how to fix a
// squeaky door" was read as search_web by the reader and then refused here because of "how to fix".
// Rows: finetune/runs/reader_round5_eval_rows.jsonl — round 5's own outputs on the six round-4 hold files + round5_valid, with
// gold labels. For every row where the reader produced an action at confidence ≥ 0.75 (what the live gate would act on), ask the
// guard. A refused row whose gold label is an action = the guard was WRONG; whose gold is none = the guard SAVED a mistake.
//   node sweeps/sweep_questionguard.js
const fs = require('fs');
const path = require('path');
const J = require('../server.js');
const rows = fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'runs', 'reader_round5_eval_rows.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
let acted = 0, unbuilt = 0; const wrongBlocks = [], savedBlocks = [];
for (const r of rows) {
  let out = null; try { out = JSON.parse(r.raw); } catch (e) { continue; }
  if (!out || !out.act || out.act === 'none' || !(r.minp >= 0.75)) continue;
  acted++;
  // The reader's own builder turns the output into the action the server would run (same checker as live).
  let built = null; try { built = J.readmodel.build(r.text, Object.assign({}, out, { __conf: r.minp })); } catch (e) { built = null; }
  const action = built && built.action;
  if (!action || !action.type) { unbuilt++; continue; }
  if (!J.blockedForQuestion(action, r.text)) continue;
  const gold = r.label && r.label.act;
  (gold && gold !== 'none' ? wrongBlocks : savedBlocks).push(r);
}
console.log(rows.length + ' rows; the reader acted (conf ≥ 0.75) on ' + acted + ' (' + unbuilt + ' did not build into an action here)');
console.log('question guard refused ' + (wrongBlocks.length + savedBlocks.length) + ': ' + wrongBlocks.length + ' were REAL requests (guard wrong), ' + savedBlocks.length + ' were none (guard saved a mistake)');
for (const r of wrongBlocks) console.log('  guard WRONG  [' + r.set + '] ' + JSON.stringify(r.text) + ' → ' + r.raw);
for (const r of savedBlocks) console.log('  guard SAVED  [' + r.set + '] ' + JSON.stringify(r.text) + ' → ' + r.raw);
process.exit(0);
