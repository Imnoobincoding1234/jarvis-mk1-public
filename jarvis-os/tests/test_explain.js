'use strict';
// explain.js — "why did you do that?" read from the last turn's own log. Pure: no model, no state.
// The turns below are REAL, copied from logs/jarvisos.log (JARVIS's own output, timestamps dropped).
const assert = require('assert');
const { explainTurn, split } = require('../explain.js');

let n = 0;
const has = (s, part, what) => { assert.ok(s.includes(part), what + '\n   got: ' + s + '\n   missing: ' + part); n++; };
const hasnt = (s, part, what) => { assert.ok(!s.includes(part), what + '\n   got: ' + s); n++; };

// 2026-09-26 14:40 — his cubes question after the reasoning reader shipped.
const cubes = explainTurn({
  text: "so if we were to take 2 cubes, one whose area is 12cm square and the other square's area being 14 cm square, what will be their sum?",
  lane: 'chat', took: 58304,
  spans: [['model call', 53306], ['embed nomic-embed-text (load/pressure)', 3137], ['Hedge', 882]],
  lines: [
    'Reasoning › "one whose area is 12cm square and the ot" P 0.99 — work it out',
    'Self-fact › "one whose area is 12cm square and the ot" → none of these',
    'Reasoning › "so if we were to take 2 cubes, one whose" P 0.99 — work it out',
    'Chat › reasoning-shaped — routing to phi4-mini:latest',
    'prompt › system 4258 chars (~1065 tok) [lean] [full state]',
    'LLM › unloaded qwen2.5:3b-instruct-q4_K_M to make room (8 GB — one model at a time)',
    'Hedge › "to find the sum of the volumes of two cu" → between answer and unknown_world (margin 0.005) — not guessing',
    'Chat › routed → chat (58304ms)',
  ],
});
has(cubes, 'question to work out (99% sure)', 'names the reasoning read and its confidence');
has(cubes, 'sent it to phi4-mini', 'names the model it went to');
has(cubes, 'unloaded qwen2.5:3b-instruct-q4_K_M', 'says it swapped models');
has(cubes, 'It took 58 s — 53 s of that was the model', 'says where the time went');
has(cubes, 'Self-fact, Hedge looked at it and let it pass', 'stages that passed are one clause');
assert.strictEqual((cubes.match(/question to work out/g) || []).length, 1); n++;   // the same reading twice is said once

// 2026-09-25 14:54 — the Briefing button before the fix: blocked claim, then the agent.
const brief = explainTurn({
  text: 'Give me my briefing: system health, what’s scheduled, anything that needs me.',
  lane: 'agent', took: 39278, spans: [['model call', 21456], ['model call', 12381]],
  lines: [
    'Briefing › Give me my briefing: system health, what’s scheduled, anything that needs me.',
    'Reasoning › "Give me my briefing: system health, what" P 0.01',
    'Blocked false completion claim › Here you go, Sir. System is running smoothly, no pending tasks.',
    'Chat › false completion claim — the reply wanted to act, so acting: "Give me my briefing: system health, what’s schedul"',
    'Shape › "Give me my briefing: system health, what’s s" read structurally as calendar',
    'Agent › "Give me my briefing: system health, what’s scheduled, anythi" → [fixed] list_events',
    'Agent › done in 569ms — ✓ list events',
    'Chat › routed → agent (39278ms)',
  ],
});
has(brief, 'blocked that', 'says the first draft was blocked');
has(brief, 'handed it to the agent', 'says why the agent took over');
has(brief, 'using list events', 'names the tool the agent used');
has(brief, 'more than one call', 'says two model calls were made');
hasnt(brief, 'question to work out', 'a low P is not a reason');

// 2026-09-25 — a how-to question the list tool was refused for.
const q = explainTurn({ text: 'how do i create a file on my mac', lane: 'chat', took: 18632, spans: [['model call', 15000]],
  lines: ['Question guard › refused list for "how do i create a file on my mac"', 'prompt › system 3940 chars (~985 tok) [lean]'] });
has(q, 'It was a question, so I did not run list', 'the question guard is a reason');
has(q, 'I answered it as conversation', 'the lane is said');

// No turn yet, and a line from a stage it does not know: nothing is invented.
has(explainTurn(null), 'nothing to explain', 'no turn yet');
const unknown = explainTurn({ text: 'hi', lane: 'chat', took: 900, lines: ['Frobnicator › did something odd'] });
hasnt(unknown, 'odd', 'an unknown stage is never paraphrased');
assert.deepStrictEqual(split('Agent › done in 5ms — ✓ x'), ['Agent', 'done in 5ms — ✓ x']); n++;
assert.strictEqual(split('no separator here'), null); n++;

console.log('\n' + n + ' passed, 0 failed');
