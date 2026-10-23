// COMPOSER V2 (finetune/README "Composer v2", 2026-10-15) — the candidate behind JARVIS_COMPOSE_JUDGE. Off: composeStrict is
// what it was (invented() decides, his words as the fallback). On: a judge's yes share decides, and a `reported` body nobody
// could rewrite becomes a question instead of a message. Also runs sweeps/sweep_composer_v2.js `score` on three fake rows.
// Stubbed models only — nothing is loaded, nothing is sent.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require(path.join(__dirname, '..', 'agent.js'));
const profile = require(path.join(__dirname, '..', 'profile.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
// the logprobs of a one-token answer whose yes share is `s`
const lp = s => [{ token: 'yes', logprob: Math.log(s), top_logprobs: [{ token: 'yes', logprob: Math.log(s) }, { token: 'no', logprob: Math.log(1 - s) }] }];
function setup(drafts, opts) {
  opts = opts || {};
  let served = 0; const asked = [];
  A.init({
    jlog: () => {},
    llm: async () => { served++; if (opts.llmThrows) throw new Error('model down'); return { text: drafts[served - 1] }; },
    judge: opts.noJudge ? undefined : async m => { asked.push(m); if (opts.judgeThrows) throw new Error('judge down'); return lp(opts.shares[served - 1]); },
    envVal: n => (n === 'JARVIS_COMPOSE_JUDGE' && opts.on ? '1' : ''),
  });
  return { served: () => served, asked };
}
const run = (body, extra) => A.compose(Object.assign({ kind: 'message', strict: true, said: body, message: 'dm bhai asking ' + body, recipient: 'Bhai' }, extra || {}));

async function main() {
  console.log('— flag OFF: composeStrict as it was —');
  let s = setup(['did you eat dinner?']);
  let r = await run('if he ate dinner', { reported: true });
  eq('a draft with no new long word is the draft', [r.ok, r.text, s.served()], [true, 'did you eat dinner?', 1]);
  eq('…and carries no judge record', r.data, { text: 'did you eat dinner?' });
  s = setup(['tell me whether you finished eating', 'whether you finished eating']);
  r = await run('if he ate dinner', { reported: true });
  eq('two rejected rewrites → his words as they are, even when reported', [r.ok, r.text, r.data], [true, 'if he ate dinner', { text: 'if he ate dinner', verbatim: true }]);
  s = setup(["“let's grab dinner at 7?”"]);
  r = await run('what time dinner is', { reported: true });
  eq('quotes are cleaned off a draft', r.text, "let's grab dinner at 7?");
  s = setup(['x'], { llmThrows: true });
  r = await run('if he ate dinner', { reported: true });
  eq('a model failure → his words', [r.ok, r.text], [true, 'if he ate dinner']);
  s = setup(['ping bhai asking if he ate dinner', 'ping bhai asking if he ate dinner']);
  r = await A.compose({ kind: 'message', strict: true, said: 'ping bhai asking if he ate dinner', noVerbatim: true, recipient: 'Bhai' });
  eq('an echoed instruction still asks (noVerbatim)', [r.ok, /what should the message to Bhai say/i.test(r.say)], [false, true]);
  s = setup(['did you eat dinner?'], { shares: [0.01] });
  r = await run('if he ate dinner', { reported: true });
  eq('with the flag off the judge is never asked', s.asked.length, 0);

  console.log('\n— flag ON: the judge decides —');
  s = setup(['did you eat dinner?'], { on: true, shares: [0.9] });
  r = await run('if he ate dinner', { reported: true });
  eq('yes → the first draft', [r.ok, r.text, s.served(), s.asked.length], [true, 'did you eat dinner?', 1, 1]);
  eq('the judge record rides along', r.data.judged.map(j => [j.text, j.share, j.ok]), [['did you eat dinner?', 0.9, true]]);
  s = setup(['tell me whether you finished eating', 'did u eat dinner'], { on: true, shares: [0.3, 0.7] });
  r = await run('if he ate dinner', { reported: true });
  eq('no then yes → the second draft (a new long word no longer decides)', [r.ok, r.text, s.served()], [true, 'did u eat dinner', 2]);
  s = setup(["let's grab dinner at 7?"], { on: true, shares: [0.2, 0.1] });
  r = await run('what time dinner is', { reported: true });
  eq('two no → a reported body becomes a question, nothing to send', [r.ok, r.say, r.data.asked, s.served()],
    [false, 'What should the message to Bhai say, Sir?', true, 2]);
  s = setup(['nah', 'nah'], { on: true, shares: [0.2, 0.2] });
  r = await run('im outside');
  eq('two no on a body NOT marked reported → his words, as today', [r.ok, r.text, r.data.verbatim], [true, 'im outside', true]);
  s = setup(['did you eat dinner?', 'did u eat?'], { on: true, judgeThrows: true });
  r = await run('if he ate dinner', { reported: true });
  eq('a judge that fails accepts nothing → the question', [r.ok, r.data.asked, r.data.judged.map(j => j.share)], [false, true, [null, null]]);
  s = setup(['did you eat dinner?', 'did u eat?'], { on: true, noJudge: true });
  r = await run('if he ate dinner', { reported: true });
  eq('no judge at all accepts nothing → the question', [r.ok, r.data.asked], [false, true]);
  s = setup(['', 'did u eat dinner'], { on: true, shares: [0.9, 0.9] });
  r = await run('if he ate dinner', { reported: true });
  eq('an empty draft is not judged; the next one is', [r.text, s.asked.length], ['did u eat dinner', 1]);
  s = setup(['did u eat dinner'], { on: true, shares: [0.5] });
  r = await run('if he ate dinner', { reported: true });
  eq('exactly 0.5 is not over 0.5 (fixed, pre-registered)', r.data.judged[0].ok, false);

  console.log('\n— the judge\'s question is the pre-registered one —');
  const P = profile.pronouns();
  const m = A.composeJudgeMessages('dm bhai asking if he ate dinner', 'if he ate dinner', 'Bhai', 'did you eat dinner?');
  eq('one user turn, the fixed wording', m, [{ role: 'user', content: P.poss.toUpperCase() + ' REQUEST: dm bhai asking if he ate dinner\n' +
    'THE PART TO PASS ON: if he ate dinner\nDRAFT TO Bhai: did you eat dinner?\n\nIf JARVIS sends this DRAFT to Bhai, does it pass on what ' +
    P.subj + ' asked — all of it and nothing more, said to Bhai directly? Answer yes or no.' }]);
  eq('the bar is 0.5', A.COMPOSE_JUDGE_AT, 0.5);

  console.log('\n— the agent path carries the reader\'s `reported` —');
  const T = A.threadMessageArgs;
  eq('reported reading → reported compose', T('compose', { kind: 'message' }, [], [], 'dm bhai asking if he ate', { to: 'bhai', body: 'if he ate', reported: true }).reported, true);
  eq('plain reading → no reported key', 'reported' in T('compose', { kind: 'message' }, [], [], 'tell bhai im out', { to: 'bhai', body: 'im out', reported: false }), false);

  console.log('\n— sweep_composer_v2.js score on three fake rows —');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-v2-'));
  const W = (f, x) => fs.writeFileSync(path.join(dir, f), typeof x === 'string' ? x : JSON.stringify(x));
  const held = [
    { id: 'f1', lang: 'en', text: 'dm bhai asking if he ate dinner', to: 'bhai', body: 'if he ate dinner', reported: true },
    { id: 'f2', lang: 'en', text: 'text rehaan asking when the bus leaves', to: 'rehaan', body: 'when the bus leaves', reported: true },
    { id: 'f3', lang: 'hinglish', text: 'nanu se puch ki chai piyogi kya', to: 'nanu', body: 'chai piyogi kya', reported: true },
  ];
  W('held.jsonl', held.map(x => JSON.stringify(x)).join('\n') + '\n');
  const dr = (a, b) => [{ raw: a, text: a, ms: 1000 }, { raw: b, text: b, ms: 1000 }];
  W('drafts.json', [{ id: 'f1', drafts: dr('did you eat dinner?', 'did u eat') },
    { id: 'f2', drafts: dr('tell me when the bus departs please', 'when does the bus leave?') },
    { id: 'f3', drafts: dr("let's have chai at 5", 'chai piyogi kya') }]);
  W('key.json', { m001: { id: 'f1', srcs: ['d1'] }, m002: { id: 'f1', srcs: ['d2'] }, m003: { id: 'f1', srcs: ['body'] },
    m004: { id: 'f2', srcs: ['d1'] }, m005: { id: 'f2', srcs: ['d2'] }, m006: { id: 'f2', srcs: ['body'] },
    m007: { id: 'f3', srcs: ['d1'] }, m008: { id: 'f3', srcs: ['d2', 'body'] } });
  const g = (f, i) => ({ faithful: f, invented: i, indirect: false, note: '' });
  W('grades.json', { m001: g(true, false), m002: g(true, false), m003: g(false, false), m004: g(false, true), m005: g(true, false),
    m006: g(false, false), m007: g(false, true), m008: g(true, false) });
  const J = (id, a, b, extra) => ({ id, judged: [Object.assign({ logprobs: lp(a), ms: 300 }, extra || {}), Object.assign({ logprobs: lp(b), ms: 300 }, extra || {})] });
  W('judge_J1.json', [J('f1', 0.9, 0.9), J('f2', 0.2, 0.8), J('f3', 0.1, 0.3)]);
  W('judge_J2.json', [J('f1', 0.9, 0.9, { reloadMs: 4000 }), J('f2', 0.2, 0.8, { reloadMs: 4000 }), J('f3', 0.7, 0.3, { reloadMs: 4000 })]);
  execFileSync(process.execPath, [path.join(__dirname, '..', 'sweeps', 'sweep_composer_v2.js'), 'score'],
    { env: Object.assign({}, process.env, { COMPOSER_V2_OUT: dir, COMPOSER_V2_HELD: path.join(dir, 'held.jsonl') }), stdio: 'pipe' });
  const res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  eq('B: f1 its draft, f2 his indirect words, f3 the invented draft', res.perRow.map(x => [x.B.src, x.B.outcome]),
    [['d1', 'SEND-OK'], ['body', 'SEND-BAD'], ['d1', 'SEND-BAD']]);
  eq('C(J1): f1 d1, f2 d2, f3 asks', res.perRow.map(x => [x.J1.src, x.J1.outcome]), [['d1', 'SEND-OK'], ['d2', 'SEND-OK'], ['ask', 'ASK']]);
  eq('J1 counts + bars', [res.J1.sendOk, res.J1.ask, res.J1.sendBad, res.J1.lostSends, res.J1.acceptedInvented, res.J1.passes], [2, 1, 0, 0, 0, true]);
  eq('J1 added time: f1 one judge call, f2 two judges + the second draft B also wrote, f3 two judges + a second draft',
    res.perRow.map(x => x.J1.addedMs), [300, 600, 1600]);
  eq('C(J2) accepts the invented f3 draft → fails the INVENTED bar', [res.J2.acceptedInvented, res.J2.bars.acceptedInvented, res.J2.passes], [1, false, false]);
  eq('J2 time counts qwen coming back after every judge call', res.perRow[0].J2.addedMs, 4300);
  eq('the choice is the judge that passes', res.choice, 'J1');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
