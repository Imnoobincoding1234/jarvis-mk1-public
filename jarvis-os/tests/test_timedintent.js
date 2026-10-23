// timedintent.js — the arithmetic half (whenOf) and stage 2's contract, with a scripted model. No model is loaded.
// Stage 1 (the embedder regions) is measured by sweeps/sweep_timed.js on finetune/data/timed_heldout_v1.jsonl.
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', 'timedintent.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

async function main() {
  console.log('— whenOf: the code does the arithmetic —');
  const now = at(2026, 10, 14, 21, 30);
  eq('a delay → now + minutes', T.whenOf({ run: 'later', minutes_from_now: 2 }, now), now + 120000);
  eq('a fractional delay rounds to the second', T.whenOf({ run: 'later', minutes_from_now: 1.5 }, now), now + 90000);
  eq('a clock time later today', T.whenOf({ run: 'later', hour: 23, minute: 0, day: 'today' }, now), at(2026, 10, 14, 23, 0));
  eq('a clock time already past today → tomorrow', T.whenOf({ run: 'later', hour: 7, minute: 0, day: 'today' }, now), at(2026, 10, 15, 7, 0));
  eq('tomorrow asked for → tomorrow', T.whenOf({ run: 'later', hour: 23, minute: 0, day: 'tomorrow' }, now), at(2026, 10, 15, 23, 0));
  eq('minute missing → :00', T.whenOf({ run: 'later', hour: 22, minute: null, day: null }, now), at(2026, 10, 14, 22, 0));
  eq('run now → null', T.whenOf({ run: 'now', minutes_from_now: 5 }, now), null);
  eq('no time at all → null', T.whenOf({ run: 'later', minutes_from_now: null, hour: null }, now), null);
  eq('an impossible hour → null', T.whenOf({ run: 'later', hour: 25, minute: 0 }, now), null);
  eq('a zero / negative delay → null', T.whenOf({ run: 'later', minutes_from_now: 0 }, now), null);
  eq('more than a week → null', T.whenOf({ run: 'later', minutes_from_now: 8 * 24 * 60 }, now), null);

  console.log('\n— decide: stage 2 with a scripted model —');
  const parseJson = t => JSON.parse(t);
  const llmSays = j => async () => ({ text: JSON.stringify(j) });
  eq('later + delay → scheduled with his task',
    await T.decide('open notes in 2 minutes', { now, parseJson, llm: llmSays({ run: 'later', minutes_from_now: 2, task: 'open notes' }) }),
    { when: now + 120000, task: 'open notes' });
  eq('now → null (runs as usual)',
    await T.decide('set the volume to 40', { now, parseJson, llm: llmSays({ run: 'now', task: 'set the volume to 40' }) }), null);
  eq('later without a usable time → null (never guesses one)',
    await T.decide('open notes later', { now, parseJson, llm: llmSays({ run: 'later', task: 'open notes' }) }), null);
  eq('model down → null',
    await T.decide('open notes in 2 minutes', { now, parseJson, llm: async () => { throw new Error('down'); } }), null);
  eq('junk JSON → null',
    await T.decide('open notes in 2 minutes', { now, parseJson, llm: async () => ({ text: 'sure!' }) }), null);

  console.log('\n— the question names JARVIS’s decision, and every region has at least 7 exemplars —');
  eq('system prompt asks when JARVIS should carry it out', /when JARVIS should carry out/.test(T.systemFor(now)), true);
  for (const [r, ex] of Object.entries(T.EXEMPLARS)) eq('region ' + r + ' has at least 7 exemplars', ex.length >= 7, true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
