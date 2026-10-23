#!/usr/bin/env node
// sweep_mcp_picker.js — the meaning-based MCP tool picker (mcp.js toolsFor) on the fresh test set
// finetune/data/mcp_picker_heldout.json. Pre-registered in finetune/README "MCP tool picker".
//   node sweeps/sweep_mcp_picker.js            → hit@8 / hit@1 on the 60 goals, tools shown on the 15 no-tool goals,
//                                                for a grid of floors, and the floor chosen on each half
// Uses the same embedder and text shape as mcp.js (intent.embed, "name with spaces: description"). Reads Ollama only.
'use strict';
const path = require('path');
const intent = require('../intent.js');
const mcp = require('../mcp.js');
const set = require(path.join(__dirname, '..', '..', 'finetune', 'data', 'mcp_picker_heldout.json'));

const CAP = mcp.MAX_EXPOSED;
(async () => {
  const tools = [];
  for (const [server, list] of Object.entries(set.catalogue))
    for (const [name, description] of list) tools.push({ q: server + '__' + name, vec: await intent.embed(name.replace(/_/g, ' ') + ': ' + description) });
  const goals = [];
  for (const [text, want] of set.goals) goals.push({ text, want, vec: await intent.embed(text) });
  const none = [];
  for (const text of set.none) none.push({ text, vec: await intent.embed(text) });
  const ranked = v => tools.map(t => ({ q: t.q, s: mcp._cosine(v, t.vec) })).sort((a, b) => b.s - a.s);
  for (const g of goals) g.r = ranked(g.vec);
  for (const n of none) n.r = ranked(n.vec);

  const score = (gs, ns, floor) => {
    let hit8 = 0, hit1 = 0, quiet = 0, shown = 0;
    for (const g of gs) {
      const top = g.r.filter(x => x.s >= floor).slice(0, CAP).map(x => x.q);
      if (top.some(q => g.want.includes(q))) hit8++;
      if (top[0] && g.want.includes(top[0])) hit1++;
    }
    for (const n of ns) { const k = n.r.filter(x => x.s >= floor).slice(0, CAP).length; shown += k; if (!k) quiet++; }
    return { hit8, hit1, quiet, shown, n: gs.length, nn: ns.length };
  };
  const fmt = (t) => 'hit@8 ' + t.hit8 + '/' + t.n + ', hit@1 ' + t.hit1 + '/' + t.n + ' | no-tool goals shown nothing ' + t.quiet + '/' + t.nn + ' (' + t.shown + ' tools shown in all)';
  const grid = []; for (let f = 0.30; f <= 0.75001; f += 0.01) grid.push(Math.round(f * 100) / 100);

  console.log('no floor:  ' + fmt(score(goals, none, -1)));
  for (const f of grid.filter(x => Math.round(x * 100) % 5 === 0)) console.log('floor ' + f.toFixed(2) + ': ' + fmt(score(goals, none, f)));

  // the floor, chosen on one half and scored on the other
  const half = (arr, k) => arr.filter((_, i) => i % 2 === k);
  const chosen = [];
  let sum = { hit8: 0, hit1: 0, quiet: 0, shown: 0, n: 0, nn: 0 };
  for (const k of [0, 1]) {
    let best = null;
    for (const f of grid) { const t = score(half(goals, k), half(none, k), f); const v = t.hit8 + t.quiet; if (!best || v > best.v) best = { f, v }; }
    chosen.push(best.f);
    const t = score(half(goals, 1 - k), half(none, 1 - k), best.f);
    console.log('half ' + (k ? 'odd→even' : 'even→odd') + ' floor ' + best.f.toFixed(2) + ': ' + fmt(t));
    for (const key of Object.keys(sum)) sum[key] += t[key];
  }
  const floor = (chosen[0] + chosen[1]) / 2;
  console.log('HELD-OUT HALVES: ' + fmt(sum));
  console.log('SHIPPED FLOOR (mean of the halves) ' + floor.toFixed(3) + ' — on all: ' + fmt(score(goals, none, floor)));
  console.log('\nmisses at the shipped floor:');
  for (const g of goals) {
    const top = g.r.filter(x => x.s >= floor).slice(0, CAP);
    if (!top.some(x => g.want.includes(x.q))) console.log('  ' + JSON.stringify(g.text) + ' wanted ' + g.want.join('|') + ' — top: ' + top.slice(0, 3).map(x => x.q + ' ' + x.s.toFixed(2)).join(', '));
  }
  for (const n of none) { const top = n.r.filter(x => x.s >= floor).slice(0, CAP); if (top.length) console.log('  no-tool ' + JSON.stringify(n.text) + ' shown ' + top.length + ' (top ' + top[0].q + ' ' + top[0].s.toFixed(2) + ')'); }
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
