'use strict';
// ---------------------------------------------------------------------------
// WHAT A REQUEST NAMES — errand.js. Embedders and his own history; no word lists, no generative model.
//
// What is asserted is the CONTRACT and the PROPERTIES: what a cold cache answers, what his answer
// outranks, what survives a change to the readers, which words his own history marks as carrying
// meaning, and that the module contains no word pattern and asks no model anything. Accuracy lives in
// sweep_spankind.js and sweep_errand.js and is recorded in errand.js's header.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const os = require('os');

// A scratch state dir AND an empty log dir, so nothing here reads or writes what he has learned.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-errand-'));
const noLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-nologs-'));
const store = require('../store.js');
store.init({ jlog: () => {}, stateDir: dir });

const E = require('../errand.js');
E.init({ store, jlog: () => {}, logDir: noLogs });

let pass = 0, fail = 0;
function eq(what, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + '\n         got  ' + g + '\n         want ' + w); }
}
const ok = (cond, what) => eq(what, !!cond, true);
const head = t => console.log('\n— ' + t + ' —');
const codeOf = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n')
  .filter(l => !/^\s*\/\//.test(l)).join('\n');

(async () => {
// ---------------------------------------------------------------------------
head('a cold cache says "nobody has asked", not "no"');
// arbitrate() is synchronous and all of this is learned asynchronously, so "never asked" and "asked,
// and it is not an errand" must be different answers. Conflating them is how a bare "spotify" once
// became a music errand.
eq('never asked is null', E.isErrandSync('order me a zzzqqq'), null);
eq('and so are its kinds', E.kindsOfSync('order me a zzzqqq'), null);
eq('and a bare thing nobody has read', E.kindsOfThingSync('zzzqqq'), null);

// ---------------------------------------------------------------------------
head('his answer outranks everything, and is found by identity, not spelling');
ok(E.teach('gulab jamun', 'food'), 'a kind he gives is accepted');
eq('and is returned for the thing', [...E.kindsOfThingSync('gulab jamun')], ['food']);
eq('and for the same thing spelled the way he actually typed it', [...E.kindsOfThingSync('gulab jamoon')], ['food']);
ok(!E.teach('gulab jamun', 'nonsense'), 'a kind outside the errands is refused');
ok(E.teach('example thing', ''), '"" is a real answer — none of the errands');
eq('and is distinguishable from never-asked', [...E.kindsOfThingSync('example thing')], []);

// ---------------------------------------------------------------------------
head('change the readers and the verdicts go — his answers stay');
{
  const f = path.join(dir, 'errand.json');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  saved.v = 'stale00000';
  saved.gate['order me a stale thing'] = 'get-something';
  saved.found['order me a stale thing'] = [{ name: 'stale thing', span: 'stale thing', coarse: 'durable' }];
  fs.writeFileSync(f, JSON.stringify(saved));
  delete require.cache[require.resolve('../errand.js')];
  const E2 = require('../errand.js');
  E2.init({ store, jlog: () => {}, logDir: noLogs });
  eq('a verdict decided by the old readers is dropped', E2.isErrandSync('order me a stale thing'), null);
  eq('but what he taught survives it', [...E2.kindsOfThingSync('gulab jamun')], ['food']);
}

// ---------------------------------------------------------------------------
head('which words carry meaning is counted from what he says');
// LEXICAL, AND LEARNED. Nothing names a word: a word he uses in every message is scaffolding, a word
// he has used once is content, and the seed of a request is its run of rare words.
{
  delete require.cache[require.resolve('../errand.js')];
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-errand-lex-'));
  const st2 = require('../store.js'); st2.init({ jlog: () => {}, stateDir: d2 });
  const E3 = require('../errand.js');
  E3.init({ store: st2, jlog: () => {}, logDir: noLogs });
  for (let i = 0; i < 40; i++) E3.observe('order me some thing number ' + i);
  E3.observe('i like kaju katli');
  const seeds = E3._seedsOf('order me some kaju katli').map(sd => sd.t.slice(sd.a, sd.b).join(' '));
  eq('the seed is the run of words he rarely uses', seeds, ['kaju katli']);
  const unseen = E3._seedsOf('order me some zzqq').map(sd => sd.t.slice(sd.a, sd.b).join(' '));
  eq('a word he has never typed is the most meaningful of all', unseen, ['zzqq']);
  fs.rmSync(d2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
head('an answer to the tie question is read by the embedder');
// The arbiter asks "food delivery or a grocery run?" and the reply is read against ONLY the two
// kinds offered. A reply that is clearly neither retires the question, so the next request is not
// swallowed as an answer. No ordinals — "the first one" was a word list and is gone.
{
  const two = ['food', 'grocery'];
  const check = async (reply, want, what) => eq(what, await E.answerKind(reply, two), want);
  await check('food delivery', 'food', 'the words he was offered');
  await check('a grocery run', 'grocery', 'and the other ones');
  await check('from a restaurant', 'food', 'a phrasing he was never shown');
  await check('what is my battery', null, 'an unrelated request is not an answer');
  await check('open youtube', null, 'nor is a command');
  eq('a kind he was never offered cannot be picked', await E.answerKind('play it as music', two), null);
}

// ---------------------------------------------------------------------------
head('no word patterns, no generative model');
{
  const code = codeOf('errand.js');
  // A word pattern needs either an alternation group or a word boundary; shape handling (splitting
  // on non-letters) needs neither.
  ok(!/\(\?:/.test(code), 'errand.js has no alternation groups');
  ok(!/\\b/.test(code), 'and no word-boundary patterns');
  ok(!/api\/generate|generate\(|deps\.llm/.test(code), 'and asks no generative model anything');
  ok(/require\('\.\/sitekind\.js'\)\.KINDS/.test(code), 'the errand kinds come from sitekind, not a retyped list');
}

// ---------------------------------------------------------------------------
head('the food lane\'s word lists are gone from server.js');
{
  const src = codeOf('server.js');
  // Declarations, not mentions — a trailing note saying what a module replaced is not the thing.
  for (const name of ['ARB_CANDIDATES', 'MEAL_TOKEN', 'AMBIGUOUS_TOKEN', 'bareFood', 'weakFood',
                      'ORDER_VERB_RE', 'wantsFood', 'wantsShop', 'wantsPlay'])
    ok(!new RegExp('(?:const|let|var)\\s+' + name + '\\b').test(src), name + ' is gone');
  ok(!/function\s+orderItem\b/.test(src), 'orderItem is gone');
  ok(!/vocab:\s*\//.test(src) && !/verbs:\s*\//.test(src), 'no candidate carries a word pattern');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
for (const d of [dir, noLogs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
process.exit(fail ? 1 : 0);
})();
