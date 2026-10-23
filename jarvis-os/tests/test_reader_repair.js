// NO-TRAINING FIXES 1 + 2 (2026-10-17, finetune/README "No-training fixes 1 + 2"). Fix 1 (JARVIS_READER_TIERS=1): a message, a call
// or a quit is not asked about by the reader — its own card is the one question. Fix 2 (JARVIS_READER_REPAIR=1): a reading the checker
// would throw away for ONE field is repaired (a `when` that runs straight on from his free words joins them; an identifier next to a
// value joins it; a value not quite copied snaps to his own words) or, for a `when` that cannot be taken, he is asked about doing it
// now. Both switches OFF by default = exactly the old behaviour. readmodel.build only — no model.
'use strict';
const fs = require('fs');
const path = require('path');
const RM = require(path.join(__dirname, '..', 'readmodel.js'));
const logs = [];
RM.init({ actread: require(path.join(__dirname, '..', 'actread.js')), store: { read: () => null, write: () => {} }, jlog: m => logs.push(m) });

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
const sure = (r, conf) => { Object.defineProperty(r, '__conf', { value: conf, enumerable: true }); return r; };
const withEnv = (vars, fn) => { const old = {}; for (const k in vars) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k in vars) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
const OFF = { JARVIS_READER_TIERS: '', JARVIS_READER_REPAIR: '' };
const ON = { JARVIS_READER_TIERS: '1', JARVIS_READER_REPAIR: '1' };
const act = out => out && out.action;
const ask = out => out && out.ask;

console.log('— switches off: exactly the old behaviour —');
withEnv(OFF, () => {
  eq('a `when` on a message is refused', RM.build('ping rehaan saying cya at practice', { act: 'message', to: 'rehaan', body: 'cya', when: 'at practice' }), null);
  eq('a left-out number is refused', RM.build('search what is chatgpt 5', { act: 'search_web', query: 'what is chatgpt' }), null);
  eq('a value not quite copied is refused', RM.build('quiz me on electrostatics', { act: 'quiz_me', topic: 'electstatics' }), null);
  const q = RM.build('text bhai saying gg', sure({ act: 'message', to: 'bhai', body: 'gg' }, 0.5));
  eq('a message under the bar is asked about', ask(q) && ask(q).kind, 'confirm');
});

console.log('\n— fix 2: a `when` that runs straight on from his free words joins them —');
withEnv(ON, () => {
  let a = act(RM.build('ping rehaan saying cya at practice', { act: 'message', to: 'rehaan', body: 'cya', when: 'at practice' }));
  eq('message body takes it back', [a && a.type, a && a.body, a && 'later' in a], ['reader_message', 'cya at practice', false]);
  a = act(RM.build('send yuvan omw 5 min', { act: 'message', to: 'yuvan', body: 'omw', when: '5 min' }));
  eq('…"omw 5 min"', a && a.body, 'omw 5 min');
  a = act(RM.build('search flights to goa for next month', { act: 'search_web', query: 'flights to goa', when: 'for next month' }));
  eq('search query takes it back', !!a && JSON.stringify(a).includes('flights to goa for next month'), true);
  a = act(RM.build('jot down that the match is at 4 on sunday', { act: 'note', content: 'that the match is', when: 'at 4 on sunday' }));
  eq('note content takes it back', a && a.content, 'that the match is at 4 on sunday');
});

console.log('\n— fix 2: a `when` it cannot join is dropped and ASKED about, never run —');
withEnv(ON, () => {
  let o = RM.build('call mama in 10 minutes', { act: 'call', to: 'mama', when: 'in 10 minutes' });
  eq('a call for later → a question about doing it now', [ask(o) && ask(o).kind, ask(o) && ask(o).cannotLater], ['confirm', 'in 10 minutes']);
  eq('…and nothing is run directly', act(o), undefined);
  eq('…the asked action carries no time', ask(o) && ask(o).action && 'later' in ask(o).action, false);
  o = RM.build('text bhai at 6 saying dinner is ready', { act: 'message', to: 'bhai', body: 'dinner is ready', when: 'at 6' });
  eq('a time not next to the body → asked, body kept', [ask(o) && ask(o).cannotLater, ask(o) && ask(o).action && ask(o).action.body], ['at 6', 'dinner is ready']);
  const r = RM.build('remind me to drink water at 4', { act: 'remind', what: 'drink water', when: 'at 4' });
  eq('a reminder keeps its own `when` (not repaired, not asked)', [act(r) && act(r).when, ask(r)], ['at 4', undefined]);
});

console.log('\n— fix 2: an identifier he typed —');
withEnv(ON, () => {
  let a = act(RM.build('search what is chatgpt 5', { act: 'search_web', query: 'what is chatgpt' }));
  eq('right next to the query → joins it', a && JSON.stringify(a).includes('what is chatgpt 5'), true);
  a = act(RM.build('is today the 11th or 12th', { act: 'time' }));
  eq('a read-only act stands without it', a && a.type, 'reader_time');
  eq('a file he named that the reading ignores is still refused (empty_trash)', RM.build('toss invoice_copy.png in the trash', { act: 'empty_trash' }), null);
});

console.log('\n— fix 2: a value not quite copied —');
withEnv(ON, () => {
  const a = act(RM.build('quiz me on electrostatics', { act: 'quiz_me', topic: 'electstatics' }));
  eq('snaps to his own words', a && a.topic, 'electrostatics');
  eq('nothing close enough → refused as before', RM.build('open notes', { act: 'open', thing: 'zzqqxx' }), null);
  eq('nearestSpan: two equally close spans → none', RM._nearestSpan('play tum hi ho and tum hi ho', 'tum hi hoo'), null);
});

console.log('\n— fix 1: one question, not two —');
withEnv(ON, () => {
  let o = RM.build('text bhai saying gg', sure({ act: 'message', to: 'bhai', body: 'gg' }, 0.5));
  eq('a message under the bar goes to its own send card', [act(o) && act(o).type, ask(o)], ['reader_message', undefined]);
  o = RM.build('call mama', sure({ act: 'call', to: 'mama' }, 0.5));
  eq('a call under the bar goes to the call offer', act(o) && act(o).type, 'reader_call');
  o = RM.build('play some lofi', sure({ act: 'play', query: 'some lofi' }, 0.5));
  eq('a play under the bar is still asked about (tier bar kept at 0.70)', ask(o) && ask(o).kind, 'confirm');
  o = RM.build('text bhai saying gg', sure({ act: 'message', to: 'bhai', body: 'gg' }, 0.2));
  eq('under the 0.3 floor nothing acts, as before', o, null);
});

console.log('\n— the server asks it in plain words —');
const S = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
eq('askAboutReading says it cannot do things for later and offers now', /q\.cannotLater\) reply = 'Should I ' \+ told\.what \+ ' now, Sir\? I cannot do things for later yet/.test(S), true);
eq('every repair is logged', logs.some(m => /^Reader › repaired /.test(m)), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
