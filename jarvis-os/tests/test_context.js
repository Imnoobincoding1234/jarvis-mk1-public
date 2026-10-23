// Conversation-context tests — pure, no network, no server boot, no real model.
//
// The model is STUBBED. That is deliberate and it is what makes these tests worth
// running: everything that protects him here is the code AROUND the model — the
// verbatim gate, the refusals, the two-question ordering — and that logic is
// deterministic. Asserting on a real 3B would be asserting on a coin flip; the
// model's actual accuracy is measured separately, against real conversations.
const C = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/context.js');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + g + '\n         want ' + w); }
}
function ok(label, cond) { eq(label, !!cond, true); }

// A stub that answers standsFor and wordsFor from a script. `seen` records the
// prompts so the tests can assert on what the model was actually asked.
const seen = [];
function stub(answers) {
  let i = 0;
  return async (opts) => {
    seen.push(String(opts.messages[0].content));
    const a = answers[Math.min(i, answers.length - 1)]; i++;
    if (a instanceof Error) throw a;
    return { text: a };
  };
}
function withLLM(answers) { seen.length = 0; C.init({ llm: stub(answers) }); }

// The founding bug, verbatim from his terminal:
//   ◆ what is claude?
//     Claude is a large language model developed by Anthropic…
//   ◆ okay search it up on youtube
//     Searching on youtube for "it up", Sir.        <- what it used to do
const REAL = [
  { role: 'user', content: 'what is claude?' },
  { role: 'assistant', content: 'Claude is a large language model developed by Anthropic, known for its conversational capabilities.' },
  { role: 'user', content: 'search it up on youtube' },
];
// The second bug, one pronoun over, which the closed list could not reach:
const NVIDIA = [
  { role: 'user', content: 'who is the ceo of nvidia' },
  { role: 'assistant', content: 'The CEO of Nvidia is Jensen Huang.' },
  { role: 'user', content: 'search him up on brave' },
];

(async () => {
  console.log('\n— the two bugs this module exists for —');
  withLLM(['Claude', 'it up']);
  let r = await C.resolveInText('search it up on youtube', REAL);
  eq('"it up" resolves and the particle goes with it', r.text, 'search Claude on youtube');
  ok('reports that it changed', r.changed);

  withLLM(['Jensen Huang', 'him up']);
  r = await C.resolveInText('search him up on brave', NVIDIA);
  eq('"him" resolves — the word no list contained', r.text, 'search Jensen Huang on brave');

  console.log('\n— the verbatim gate: it must have been said —');
  withLLM(['Kiran Watermelon 2 kg']);
  r = await C.standsFor('order it', REAL);
  eq('an answer that was never said is thrown away', r.ok, false);
  ok('and says why', /not verbatim/.test(r.reason));

  withLLM(['Mumbai']);
  r = await C.resolveInText('what is the weather in mumbai', REAL);
  eq('an invented referent leaves the sentence alone', r.text, 'what is the weather in mumbai');
  eq('and is not reported as a change', r.changed, false);

  withLLM(['CLAUDE']);
  r = await C.standsFor('search it up', REAL);
  eq('the gate is case-insensitive', r.ok, true);

  console.log('\n— refusing beats guessing —');
  withLLM(['NONE']);
  r = await C.standsFor('order me some grapes', REAL);
  eq('NONE refuses', r.ok, false);
  eq('NONE is reported as such', r.reason, 'NONE');

  withLLM(['NONE']);
  r = await C.resolveInText('order me some grapes', REAL);
  eq('a self-contained request passes through ok', r.ok, true);
  eq('unchanged', r.changed, false);
  eq('and did NOT lean on the conversation', r.leaned, false);

  withLLM([new Error('model down')]);
  r = await C.standsFor('search it up', REAL);
  eq('a model failure refuses rather than throwing', r.ok, false);

  C.init({ llm: null });
  r = await C.standsFor('search it up', REAL);
  eq('no model wired at all refuses', r.ok, false);

  console.log('\n— what counts as a reference at all —');
  withLLM(['Claude']);
  r = await C.standsFor('search Claude on youtube', REAL);
  eq('a referent already spelled out is not a reference', r.ok, false);
  eq('and says so', r.reason, 'already named');

  withLLM(['Claude']);
  eq('no history refuses', (await C.standsFor('search it up', [])).ok, false);
  eq('a single message has no prior turn', (await C.standsFor('x', [{ role: 'user', content: 'x' }])).ok, false);
  eq('null messages do not throw', (await C.standsFor('search it up', null)).ok, false);
  eq('empty text does not throw', (await C.standsFor('', REAL)).ok, false);

  console.log('\n— the second question is asked second, and can refuse on its own —');
  withLLM(['Claude', 'NONE']);
  r = await C.resolveInText('search it up on youtube', REAL);
  eq('referent found but unplaceable => not ok', r.ok, false);
  eq('but it DID lean on the conversation', r.leaned, true);
  eq('and hands back what it points at, so the caller can ask', r.value, 'Claude');
  eq('the sentence is left exactly as he typed it', r.text, 'search it up on youtube');

  withLLM(['Claude', 'zzz not his words']);
  r = await C.resolveInText('search it up on youtube', REAL);
  eq('words that are not in the request are rejected', r.ok, false);

  withLLM(['Claude', 'search it up on youtube']);
  r = await C.resolveInText('search it up on youtube', REAL);
  eq('replacing the WHOLE request is not a reference', r.ok, false);

  console.log('\n— it reads JARVIS\'s own replies, which is where the answer usually is —');
  withLLM(['Jensen Huang']);
  r = await C.standsFor('search him up on brave', NVIDIA);
  ok('the antecedent came from an assistant turn', r.ok && r.value === 'Jensen Huang');
  ok('the prompt showed the assistant turn', /JARVIS: The CEO of Nvidia is Jensen Huang\./.test(seen[0]));
  ok('the prompt did NOT include the turn being resolved', !/Mihir: search him up on brave/.test(seen[0]));

  console.log('\n— the transcript handed to the model is bounded —');
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ role: 'user', content: 'turn number ' + i });
  many.push({ role: 'user', content: 'do it' });
  withLLM(['NONE']);
  await C.standsFor('do it', many);
  ok('only the last 6 prior turns are shown', /turn number 14/.test(seen[0]) && !/turn number 13/.test(seen[0]));

  const longMsg = [
    { role: 'user', content: 'x'.repeat(500) },
    { role: 'assistant', content: 'y'.repeat(500) },
    { role: 'user', content: 'do it' },
  ];
  withLLM(['NONE']);
  await C.standsFor('do it', longMsg);
  ok('each turn is truncated', !/x{300}/.test(seen[0]));

  console.log('\n— malformed model output —');
  withLLM(['  "Claude"  \nsome trailing rubbish', 'it up']);
  r = await C.resolveInText('search it up on youtube', REAL);
  eq('quotes and trailing lines are stripped', r.text, 'search Claude on youtube');

  withLLM(['']);
  eq('empty output refuses', (await C.standsFor('search it up', REAL)).ok, false);
  withLLM([null]);
  eq('null output refuses', (await C.standsFor('search it up', REAL)).ok, false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
