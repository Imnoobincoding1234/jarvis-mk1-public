'use strict';
// NEEDS OLLAMA. Not loaded by server.js.
//
// This measures whether a semantic classifier can do config/verbs.json's job before anything is
// routed on it. Eleven regions is a lot to ask of all-minilm — the handoff records it at 31/32 on a
// multi-class task with four regions — so the number that matters here is not the pass count but the
// separation, and a bad result is a real answer.

const A = require('../actionintent.js');
const intent = require('../intent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

// HELD OUT — not one of these is an exemplar. Includes the phrasings verbs.json is known to miss.
const CASES = [
  ['open_app',     'fire up the calculator'],
  ['open_app',     'get brave going'],
  ['open_app',     'chuck on netflix'],            // "chuck" is in the DELETE list in verbs.json
  ['open_app',     'whatsapp kholo'],
  ['close_app',    'shut safari down'],
  ['close_app',    'terminate the terminal'],
  ['create',       'make me a folder for receipts'],
  ['create',       'knock up a file called todo.txt'],
  ['delete',       'scrap that folder'],
  ['delete',       'toss the old screenshots'],
  ['search',       'where did i put the budget file'],
  ['list',         'show me what is in downloads'],
  ['system_status','how is the machine doing'],
  ['empty_trash',  'clear out the trash'],
  ['screenshot',   'grab a picture of the screen'],
  ['list_running', 'what have i got running'],
  ['sleep_display','switch the display off'],
  // MUST NOT be read as one of the eleven.
  ['none',         'what is the capital of france'],
  ['none',         'message dad about dinner'],
  ['none',         'remind me to water the plants'],
  ['none',         'delete is a harsh word to use'],
  ['none',         'thanks that worked'],
  ['none',         'play something by drake'],
];

(async () => {
  if (!await require('../ollama.js').reachable(1500)) {
    console.log('ollama is not reachable — this suite needs the embedder. Skipping.');
    process.exit(0);
  }

  head('the group each request belongs to');
  let right = 0;
  for (const [want, text] of CASES) {
    const got = await A.actionKind(text);
    const hit = (want === 'none') ? (got === null) : (got === want);
    if (hit) right++;
    console.log((hit ? '  ok   ' : ' MISS  ') + String(want).padEnd(14) +
      'got=' + String(got).padEnd(14) + '"' + text + '"');
  }
  console.log('\n    ' + right + '/' + CASES.length + ' held-out requests classified correctly');

  head('the safety property: a non-action is never read as an action');
  // THE ASYMMETRY THAT MATTERS. A miss means quickAction sees nothing and the request falls to the
  // lanes below — which is where it went before. A WRONG action is how "delete is a strong word"
  // becomes a hunt for a file. This half must be perfect before anything routes on it.
  let leaked = 0;
  for (const [want, text] of CASES) {
    if (want !== 'none') continue;
    const got = await A.actionKind(text);
    if (got !== null) { leaked++; console.log('    LEAK: "' + text + '" → ' + got); }
  }
  ok(leaked === 0, 'no conversational request was read as an action (' + leaked + ' leaks)');

  head('separation, measured');
  const cent = {};
  for (const [id, phrases] of Object.entries(A.ACTION_EXEMPLARS)) {
    const vecs = [];
    for (const p of phrases) { const v = await intent.embed(p); if (v) vecs.push(v); }
    const c = new Array(vecs[0].length).fill(0);
    for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
    for (let i = 0; i < c.length; i++) c[i] /= vecs.length;
    cent[id] = c;
  }
  let lowestRight = 1, worstWrongMargin = 0, worstWrong = '(none)';
  for (const [want, text] of CASES) {
    const v = await intent.embed(text);
    const g = id => (A.NOT_ACTION.has(id) ? 'idle' : 'act');
    const scored = Object.entries(cent).map(([id, cv]) => ({ id, s: intent.cos(v, cv) })).sort((a, b) => b.s - a.s);
    const winG = g(scored[0].id);
    const rival = scored.find(x => g(x.id) !== winG);
    const margin = rival ? scored[0].s - rival.s : 1;
    const isAction = want !== 'none';
    if (isAction && scored[0].id === want) lowestRight = Math.min(lowestRight, margin);
    if (!isAction && !A.NOT_ACTION.has(scored[0].id) && margin > worstWrongMargin) {
      worstWrongMargin = margin; worstWrong = text;
    }
  }
  console.log('    lowest correct margin : ' + lowestRight.toFixed(3));
  console.log('    highest wrong  margin : ' + worstWrongMargin.toFixed(3) + '  ("' + worstWrong + '")');
  console.log('    threshold in use      : ' + A.MIN_MARGIN);

  // Reported, NOT asserted as a pass mark. This suite exists to say whether the swap is viable;
  // pretending a marginal result is a green tick is how a parser gets replaced by a worse one.
  console.log('\n    VERDICT: ' + (leaked === 0 && right >= CASES.length - 4
    ? 'viable — worth moving from shadow to live once his traffic agrees'
    : 'NOT yet viable — stays in shadow; see the misses above'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
