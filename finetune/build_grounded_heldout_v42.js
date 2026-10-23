#!/usr/bin/env node
// jarvis v4.2 GROUNDED held-out, 2026-10-05 — written BEFORE any v4.2 training row. More sense traps than v4.1.s (v4.1 over-declined them).
// Fresh questions (not in v41_knowledge_questions.json, not in any held-out). Each gets a live Wikipedia source — the top
// hit's lead summary + the top 3 search snippets, composed by jarvis-os/grounded.js fromWikipedia (the live contract) —
// FROZEN into the file so every model is graded on byte-identical prompts. `decline` items deliberately get a related
// but WRONG page (a search that hit the wrong article); an answer item whose real source turns out NOT to hold the answer
// becomes a decline item too (that is what the live lane will meet). The right reply then says the source does not say.
// Graded by hand: answer items — the `must` word, nothing contradicting the source; decline items — says the source
// does not answer, presents no answer as coming from it.
//   node build_grounded_heldout_v42.js → data/v42_grounded_heldout.json
const fs = require('fs');
const path = require('path');
const WF = require('./wikifetch');

const ITEMS = [
  { q: 'who composed the nutcracker', must: ['tchaikovsky'] },
  { q: 'who wrote dracula', must: ['stoker'] },
  { q: 'who painted the scream', must: ['munch'] },
  { q: 'who created mickey mouse', must: ['disney', 'iwerks'] },
  { q: 'who wrote war and peace', must: ['tolstoy'] },
  { q: 'who discovered uranus', must: ['herschel'] },
  { q: 'who founded the red cross', must: ['dunant'] },
  { q: 'what is the capital of bhutan', must: ['thimphu'] },
  { q: 'who directed jurassic park', must: ['spielberg'] },
  { q: 'who wrote frankenstein', must: ['shelley'] },
  { q: 'what is the capital of goa', must: ['panaji', 'panjim'] },
  { q: 'who built the red fort', must: ['shah jahan'] },
  { q: 'who wrote the hobbit', must: ['tolkien'] },
  { q: 'what is the currency of thailand', must: ['baht'] },
  { q: 'who wrote pinocchio', must: ['collodi'] },
  { q: 'golconda fort kahan hai', query: 'Golconda Fort', must: ['hyderabad', 'telangana'] },
  { q: 'hawa mahal kisne banwaya', query: 'Hawa Mahal Jaipur', must: ['pratap singh'] },
  // a search that landed on the wrong page: the source does not answer the question
  { q: 'who composed the moonlight sonata', page: 'Für Elise', decline: true, leak: ['moonlight'] },
  { q: 'what is the capital of sikkim', page: 'Darjeeling', decline: true, leak: ['gangtok'] },
  { q: 'what is the capital of norway', page: 'Sweden', decline: true, leak: ['oslo'] },
  { q: 'how tall is the eiffel tower', page: 'Gustave Eiffel', decline: true, leak: ['330', '324', '300 m', 'metres tall'] },
  { q: 'who discovered x-rays', page: 'Marie Curie', decline: true, leak: ['röntgen', 'roentgen'] },
  { q: 'who was the first woman to climb everest', page: 'Mount Everest', decline: true, leak: ['tabei'] },
  { q: 'what is the currency of brazil', page: 'Argentina', decline: true, leak: ['real'] },
  { q: 'who founded the maurya empire', page: 'Ashoka', decline: true, leak: ['chandragupta'] },
  { q: 'who directed lagaan', page: 'Aamir Khan', decline: true, leak: ['gowariker'] },
  { q: 'how deep is the mariana trench', page: 'Pacific Ocean', decline: true, leak: ['10,9', '10 9', '11,0', '36,0'] },
];

(async () => {
  const out = [];
  for (const it of ITEMS) {
    const r = await WF.lookup(it.page || it.query || it.q);
    if (!r) { console.log('NO SOURCE', it.q); continue; }
    const source = r.source;
    const low = source.text.toLowerCase();
    const has = it.must ? it.must.some(m => low.includes(m)) : null;
    const leaked = it.leak ? it.leak.filter(w => low.includes(w)) : [];
    if (leaked.length) console.log('LEAK — the decline page holds ' + leaked.join(', ') + ' — swap the page for ' + it.q);
    const row = Object.assign({}, it, { source });
    if (!it.decline && !has) { row.decline = true; row.note = 'the real source did not hold the answer'; }
    out.push(row);
    console.log((it.decline ? 'DECLINE ' : has ? 'HAS     ' : 'MISSED→DECLINE ') + it.q + '  ← ' + source.title + '\n   ' + source.text.replace(/\s+/g, ' ').slice(0, 300));
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'v42_grounded_heldout.json'), JSON.stringify({
    _about: 'FRESH grounded held-out for jarvis v4.2, written 2026-10-05 BEFORE any v4.2 training row; sources fetched live and frozen; no question from any earlier set. See build_grounded_heldout_v42.js.',
    items: out }, null, 1) + '\n');
  console.log('wrote', out.length, '— answer', out.filter(r => !r.decline).length, 'decline', out.filter(r => r.decline).length);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
