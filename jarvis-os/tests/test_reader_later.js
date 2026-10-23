// ROUND 7's "DO IT LATER" vs A REMINDER'S OWN TIME (2026-10-16, found by the pre-restart gate before it went live). build() used to
// attach the round-7 time as `when` — the same key remind / calendar / weather already use for their own time — so the server sent
// every timed reminder to the scheduler ("remind me to submit the assignment at 9" → "Scheduled for 2:05 AM"). Now it rides as
// `later`, and scheduling is off unless JARVIS_READER_LATER=1 (the round-7 reader is not live, the converter failed its bar).
// readmodel.build only — no model.
'use strict';
const fs = require('fs');
const path = require('path');
const RM = require(path.join(__dirname, '..', 'readmodel.js'));
// build() reads his words through actread (pure tokenizer) — injected the way server.js does, no store, no model.
RM.init({ actread: require(path.join(__dirname, '..', 'actread.js')), store: { read: () => null, write: () => {} } });

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}

console.log('— build(): the two kinds of time stay apart —');
const reading = () => ({ act: 'message', to: 'bhai', body: 'dinner is ready', when: 'at 6' });
eq('switched off (default): a message for later is refused, as before round 7', RM.build('text bhai at 6 saying dinner is ready', reading()), null);
RM.init({ laterOn: () => true });
const msg = RM.build('text bhai at 6 saying dinner is ready', reading());
RM.init({ laterOn: () => false });
const ma = msg && msg.action;
eq('switched on: a message for later carries `later`', ma && ma.later, 'at 6');
eq('…and no `when`', ma && 'when' in ma, false);
const rem = RM.build('remind me to drink water at 4', { act: 'remind', what: 'drink water', when: 'at 4' });
const ra = rem && rem.action;
eq('a reminder keeps its own `when`', ra && ra.when, 'at 4');
eq('…and is never marked for later', ra && 'later' in ra, false);
const cal = RM.build('am i free this saturday', { act: 'calendar', when: 'this saturday' });
eq('the calendar keeps its own `when`, no `later`', cal && cal.action && [cal.action.when, 'later' in cal.action], ['this saturday', false]);

console.log('\n— the shape check: `when` for later only while it is switched on —');
eq('off (default) → refused on open, as before round 7', RM.shapeError('open notes in 2 minutes', { act: 'open', thing: 'notes', when: 'in 2 minutes' }), 'when is not part of open');
eq('off → a search with a time is refused too', RM.shapeError('look for flight deals to goa in december', { act: 'search_web', query: 'flight deals to goa', when: 'in december' }), 'when is not part of search_web');
eq('off → a reminder keeps its own `when`', RM.shapeError('remind me to drink water at 4', { act: 'remind', what: 'drink water', when: 'at 4' }), null);
RM.init({ laterOn: () => true });
eq('on → allowed on open', RM.shapeError('open notes in 2 minutes', { act: 'open', thing: 'notes', when: 'in 2 minutes' }), null);
RM.init({ laterOn: () => false });
eq('server passes its switch to the reader (a lambda: laterOn is defined further down)', /laterOn: \(\) => laterOn\(\),/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')), true);

console.log('\n— server: scheduling reads `later`, and is off by default —');
const S = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
eq('runAction schedules on `later` only', /if \(act && act\.later\) \{ const s = await scheduleAction/.test(S) && !/if \(act && act\.when\) \{ const s = await scheduleAction/.test(S), true);
eq('runReaderJob schedules on `later` only', /if \(a && a\.later\) \{ const s = await scheduleAction/.test(S) && !/if \(a && a\.when\) \{ const s = await scheduleAction/.test(S), true);
eq('scheduleAction is off unless JARVIS_READER_LATER=1', /const laterOn = \(\) => String\(envVal\('JARVIS_READER_LATER'\) \|\| ''\)\.trim\(\) === '1';/.test(S) && /if \(!laterOn\(\)\) \{/.test(S), true);
eq('off → told plainly, nothing guessed', /nothing has run\. Say it again when you want it done\./.test(S), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
