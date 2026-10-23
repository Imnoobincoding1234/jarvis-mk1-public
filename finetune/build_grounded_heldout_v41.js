#!/usr/bin/env node
// jarvis v4.1 GROUNDED held-out, 2026-10-04 — written BEFORE any grounded training row (build_grounded_v41.js).
// Fresh questions (not in v41_knowledge_questions.json, not in any held-out). Each gets a live Wikipedia source — the top
// hit's lead summary + the top 3 search snippets, composed by jarvis-os/grounded.js fromWikipedia (the live contract) —
// FROZEN into the file so every model is graded on byte-identical prompts. `decline` items deliberately get a related
// but WRONG page (a search that hit the wrong article); an answer item whose real source turns out NOT to hold the answer
// becomes a decline item too (that is what the live lane will meet). The right reply then says the source does not say.
// Graded by hand: answer items — the `must` word, nothing contradicting the source; decline items — says the source
// does not answer, presents no answer as coming from it.
//   node build_grounded_heldout_v41.js → data/v41_grounded_heldout.json
const fs = require('fs');
const path = require('path');
const WF = require('./wikifetch');

const ITEMS = [
  { q: 'who wrote the gita govinda', must: ['jayadeva'] },
  { q: 'what is the capital of odisha', must: ['bhubaneswar'] },
  { q: 'who founded the indian national congress', must: ['hume'] },
  { q: 'which river is the longest in europe', must: ['volga'] },
  { q: 'what is the national tree of india', must: ['banyan'] },
  { q: 'what is the capital of mizoram', must: ['aizawl'] },
  { q: 'who wrote the arthashastra', must: ['kautilya', 'chanakya'] },
  { q: 'who is known as the flying sikh', must: ['milkha'] },
  { q: 'who painted girl with a pearl earring', must: ['vermeer'] },
  { q: 'what is the largest moon of saturn', must: ['titan'] },
  { q: 'who composed the four seasons', must: ['vivaldi'] },
  { q: 'what is the currency of bangladesh', must: ['taka'] },
  { q: 'who wrote malgudi days', must: ['narayan'], note: 'the lead is about a 2020 film whose writer is also named; naming him as the film writer is not wrong, but the answer wanted is R. K. Narayan (in a snippet)' },
  { q: 'who was the first governor of the reserve bank of india', must: ['osborne', 'smith'] },
  { q: 'what is the tallest building in the world', must: ['burj khalifa'] },
  { q: 'who wrote the discovery of india', must: ['nehru'] },
  { q: 'mount abu kis state mein hai', query: 'Mount Abu', must: ['rajasthan'] },
  { q: 'qutub minar kisne banwaya', query: 'Qutb Minar', must: ['aibak'] },
  // a search that landed on the wrong page: the source does not answer the question
  { q: 'who discovered the electron', page: 'Proton', decline: true },
  { q: 'what is the capital of meghalaya', page: 'Assam', decline: true },
  { q: 'who directed mughal-e-azam', page: 'Dilip Kumar', decline: true },
  { q: 'how tall is the statue of unity', page: 'Sardar Vallabhbhai Patel', decline: true },
  { q: 'who invented the telescope', page: 'Galileo Galilei', decline: true },
];

(async () => {
  const out = [];
  for (const it of ITEMS) {
    const r = await WF.lookup(it.page || it.query || it.q);
    if (!r) { console.log('NO SOURCE', it.q); continue; }
    const source = r.source;
    const low = source.text.toLowerCase();
    const has = it.must ? it.must.some(m => low.includes(m)) : null;
    const row = Object.assign({}, it, { source });
    if (!it.decline && !has) { row.decline = true; row.note = 'the real source did not hold the answer'; }
    out.push(row);
    console.log((it.decline ? 'DECLINE ' : has ? 'HAS     ' : 'MISSED→DECLINE ') + it.q + '  ← ' + source.title + '\n   ' + source.text.replace(/\s+/g, ' ').slice(0, 300));
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'v41_grounded_heldout.json'), JSON.stringify({
    _about: 'FRESH grounded held-out for jarvis v4.1, written 2026-10-04 BEFORE any grounded training row; sources fetched live and frozen. See build_grounded_heldout_v41.js.',
    items: out }, null, 1) + '\n');
  console.log('wrote', out.length, '— answer', out.filter(r => !r.decline).length, 'decline', out.filter(r => r.decline).length);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
