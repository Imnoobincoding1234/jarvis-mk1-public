// COMPOSER V3 (finetune/README "Composer v3", 2026-10-19) — the candidate behind JARVIS_COMPOSE_V3. Off: composeStrict is what it
// was and the drafter is never asked. On: one draft, sent only when its lowest token logprob ≥ COMPOSE_SURE_AT; otherwise a
// `reported` body becomes a question and a plain body stays his words. Stubbed models only — nothing is loaded, nothing is sent.
'use strict';
const path = require('path');
const A = require(path.join(__dirname, '..', 'agent.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
const lps = (...xs) => xs.map(x => ({ token: 't', logprob: x }));
function setup(opts) {
  const seen = { llm: 0, draft: [] };
  A.init({
    jlog: () => {},
    llm: async () => { seen.llm++; return { text: opts.llmText || 'did you eat dinner?' }; },
    draft: async m => { seen.draft.push(m); if (opts.draftThrows) throw new Error('model down'); return opts.draft; },
    isHinglish: opts.isHinglish,
    envVal: n => (n === 'JARVIS_COMPOSE_V3' && opts.on ? (opts.on === true ? '1' : opts.on) : ''),
  });
  return seen;
}
const run = (body, extra) => A.compose(Object.assign({ kind: 'message', strict: true, said: body, message: 'dm bhai asking ' + body, recipient: 'Bhai' }, extra || {}));

(async () => {
  console.log('— switch OFF: the drafter is never asked —');
  let s = setup({ draft: { text: 'x', logprobs: lps(-0.1) } });
  let r = await run('if he ate dinner', { reported: true });
  eq('today\'s path answers', [r.ok, r.text, s.llm, s.draft.length], [true, 'did you eat dinner?', 1, 0]);

  console.log('— switch ON —');
  s = setup({ on: true, draft: { text: '"did you eat dinner?"', logprobs: lps(-0.01, -0.4, -1.2) } });
  r = await run('if he ate dinner', { reported: true });
  eq('a sure draft is sent, cleaned', [r.ok, r.text, r.data.sure], [true, 'did you eat dinner?', -1.2]);
  eq('…the old composer is not called', s.llm, 0);
  const m = s.draft[0];
  eq('…the drafter sees his whole request and the part to pass on', m[m.length - 1].content, 'Request: dm bhai asking if he ate dinner\nPass on: if he ate dinner\nMessage to Bhai:');

  s = setup({ on: true, draft: { text: 'did you eat the dinner i made?', logprobs: lps(-0.01, -1.21) } });
  r = await run('if he ate dinner', { reported: true });
  eq('one unsure token → a reported body becomes a question', [r.ok, r.say, r.data.asked], [false, 'What should the message to Bhai say, Sir?', true]);

  s = setup({ on: true, draft: { text: 'omw', logprobs: lps(-3) } });
  r = await run('omw be there in 10');
  eq('…a plain body stays his words', [r.ok, r.text, r.data.verbatim], [true, 'omw be there in 10', true]);

  s = setup({ on: true, draft: { text: 'dm bhai asking if he ate dinner', logprobs: lps(-0.01) } });
  r = await run('if he ate dinner', { reported: true });
  eq('his whole instruction echoed is never sent, however sure', [r.ok, r.data.asked], [false, true]);

  s = setup({ on: true, draft: { text: 'did you eat dinner?', logprobs: null } });
  r = await run('if he ate dinner', { reported: true });
  eq('no token probabilities → not sent', [r.ok, r.data.asked], [false, true]);

  s = setup({ on: true, draftThrows: true });
  r = await run('if he ate dinner', { reported: true });
  eq('the drafter failing → asked, nothing sent', [r.ok, r.data.asked], [false, true]);

  s = setup({ on: true, draft: { text: 'ping bhai asking about dinner', logprobs: lps(-2) } });
  r = await A.compose({ kind: 'message', strict: true, said: 'ping bhai asking about dinner', message: 'ping bhai asking about dinner', recipient: 'Bhai', noVerbatim: true });
  eq('no body at all → asked (as today\'s noVerbatim)', [r.ok, r.say], [false, 'What should the message to Bhai say, Sir?']);

  console.log('— C2 (JARVIS_COMPOSE_V3=c2) —');
  // stands in for intent.isHinglish (no model): the fixture's own Hinglish sentences by identity — no words are matched
  const HINGLISH_FIXTURE = new Set(['usne chart banaya kya', 'harsimran se puch ki usne chart banaya kya']);
  const hing = t => HINGLISH_FIXTURE.has(t);
  s = setup({ on: 'c2', isHinglish: async t => hing(t), draft: { text: 'tune chart banaya?', logprobs: lps(-0.01) } });
  r = await A.compose({ kind: 'message', strict: true, said: 'usne chart banaya kya', message: 'harsimran se puch ki usne chart banaya kya', recipient: 'Harsimran', reported: true });
  eq('a reported Hinglish body is asked — the drafter is never called', [r.ok, r.say, r.data.hinglish, s.draft.length], [false, 'What should the message to Harsimran say, Sir?', true, 0]);
  s = setup({ on: 'c2', isHinglish: async t => hing(t), draft: { text: 'did you eat dinner?', logprobs: lps(-0.1) } });
  r = await run('if he ate dinner', { reported: true });
  eq('a reported English body takes the sure-draft path', [r.ok, r.text, s.draft.length], [true, 'did you eat dinner?', 1]);
  s = setup({ on: 'c2', isHinglish: async t => hing(t), draft: { text: 'did you eat the dinner i made?', logprobs: lps(-2) } });
  r = await run('if he ate dinner', { reported: true });
  eq('…and is asked when the drafter is not sure', [r.ok, r.data.asked], [false, true]);
  s = setup({ on: 'c2', isHinglish: async t => hing(t), draft: { text: 'bhai, you took the car keys.', logprobs: lps(-0.1) } });
  r = await A.compose({ kind: 'message', strict: true, said: 'i took the car keys', message: 'tell bhai i took the car keys', recipient: 'Bhai' });
  eq('a plain body is his words — no model call, however sure a draft would be', [r.ok, r.text, r.data.verbatim, s.draft.length, s.llm], [true, 'i took the car keys', true, 0, 0]);
  s = setup({ on: 'c2', isHinglish: async () => { throw new Error('embedder down'); }, draft: { text: 'did you eat dinner?', logprobs: lps(-0.1) } });
  r = await run('if he ate dinner', { reported: true });
  eq('the language check failing → asked (counts as Hinglish)', [r.ok, r.data.asked, s.draft.length], [false, true, 0]);
  s = setup({ on: 'c2', draft: { text: 'did you eat dinner?', logprobs: lps(-0.1) } });
  r = await run('if he ate dinner', { reported: true });
  eq('no language check wired → asked', [r.ok, r.data.asked], [false, true]);

  eq('the threshold is the pre-registered one', A.COMPOSE_SURE_AT, -1.2);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
