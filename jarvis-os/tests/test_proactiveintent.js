'use strict';
// proactiveintent.js — is this about JARVIS's nudges, and which part? NEEDS OLLAMA (it asks the embedder).
//
// THE HELD-OUT SET BELOW WAS WRITTEN BEFORE THE CLASSIFIER EXISTED (2026-09-18 23:15 IST), and none of it
// is an exemplar (the suite checks). His own message about initiative is here — "proactive status" — with
// look-alikes that must NOT reach it: macOS Do Not Disturb and notifications, stopping the music, reminders
// he sets, "be quiet" said to stop JARVIS talking, dream mode, and bare "stop". The suite prints the sweep
// and asserts at the shipped gate: no request goes to the wrong part, and nothing else is acted on as it.

const intent = require('../intent.js');
const P = require('../proactiveintent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

const S = 'proactive_status', SET = 'proactive_setting';
const HELD = [
  ['proactive status', S],                                   // his own, 2026-08
  ['are your nudges on', S], ['how many times did you nudge me today', S],
  ['what are you keeping an eye on for me', S], ['is initiative mode on right now', S],
  ['kitni baar aaj tumne mujhe tok diya', S],
  ['stop interrupting me', SET], ['quit bugging me with your little reminders', SET],
  ['you can start nudging me again', SET], ['no more pop ups from you today', SET],
  ['speak up if something needs my attention', SET], ['nudges band karo', SET],
  ['go back to reminding me about stuff', SET], ['hold your nudges until tonight', SET],
  // not initiative
  ['turn on do not disturb', null], ['stop the music', null], ['notify me when my package arrives', null],
  ['remind me to drink water at 5', null], ['turn off notifications for slack', null],
  ['turn off dream mode', null], ['mute the volume', null], ['what did you do while i was away', null],
  ['stop', null], ["don't open youtube", null], ['tell me when it is 6 pm', null],
  ['be quiet for a sec i am on a call', null], ['who keeps calling me', null], ['bluetooth band karo', null],
];

(async () => {
  if (!(await intent.embed('probe'))) { console.log('Skipping — the embedder is not reachable'); process.exit(0); }

  head('the held-out set is not the exemplars');
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ex = new Set(Object.values(P.PROACTIVE_EXEMPLARS).flat().map(norm));
  ok(HELD.every(([t]) => !ex.has(norm(t))), 'no held-out sentence is an exemplar (' + HELD.length + ' held out)');

  const raw = intent.makeClassifier({ exemplars: P.PROACTIVE_EXEMPLARS, minMargin: 0, none: '__unused__', groups: P.GROUPS, label: 'ProactiveRaw', jlog: () => {} });
  const got = [];
  for (const [t, want] of HELD) {
    const r = await raw(t);
    got.push({ t, want, id: r ? r.id : null, mine: !!(r && P.GROUPS[r.id] !== 'not_proactive'), margin: r ? r.margin : 0 });
  }
  const at = gate => {
    let right = 0, miss = 0, wrong = 0, intruders = 0;
    for (const g of got) {
      const said = g.mine && g.margin >= gate ? g.id : null;
      if (g.want === null) { if (said) intruders++; else right++; }
      else if (said === g.want) right++;
      else if (said === null) miss++;
      else wrong++;
    }
    return { right, miss, wrong, intruders };
  };
  head('the sweep (initiative cases: right / missed / wrong part; other cases reaching initiative)');
  console.log('    gate    right  missed  wrong  intruders');
  for (const gate of [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
    const s = at(gate);
    console.log('    ' + gate.toFixed(2).padEnd(8) + String(s.right).padStart(5) + String(s.miss).padStart(8) + String(s.wrong).padStart(7) + String(s.intruders).padStart(11) +
      (gate === P.MIN_MARGIN ? '   ← shipped' : ''));
  }
  const rightMargins = got.filter(g => g.want && g.id === g.want).map(g => g.margin);
  const badMargins = got.filter(g => g.mine && g.id !== g.want).map(g => g.margin);
  console.log('    lowest margin on a right case   ' + (rightMargins.length ? Math.min(...rightMargins).toFixed(3) : '-'));
  console.log('    highest margin on a WRONG call  ' + (badMargins.length ? Math.max(...badMargins).toFixed(3) : 'none at all'));
  for (const g of got) if ((g.want || null) !== (g.mine && g.margin >= P.MIN_MARGIN ? g.id : null)) {
    console.log('    ' + (g.want ? 'missed' : 'intruder').padEnd(9) + JSON.stringify(g.t).padEnd(46) + ' → ' + g.id + ' (' + g.margin.toFixed(3) + ')');
  }

  head('the tool names are the machine\'s own, and evidence only');
  ok(P.namedTool('proactive status') === S, '"proactive status" names proactive_status');
  ok(P.namedTool('stop the music') === null, '"stop the music" names no tool');

  head('the whole pipeline on the held-out set');
  const out = { right: 0, asked: [], miss: [], wrong: [], intruders: [], askedNot: [] };
  for (const [t, want] of HELD) {
    const s = await P.proactiveIntentOf(t);
    if (s && !s.sure) { (want === s.id ? out.asked : want ? out.wrong : out.askedNot).push(t); continue; }
    const acts = s ? s.id : null;
    if (acts === want) out.right++;
    else if (want && !acts) out.miss.push(t);
    else if (want) out.wrong.push(t + ' → ' + acts);
    else out.intruders.push(t + ' → ' + acts);
  }
  const mine = HELD.filter(([, w]) => w).length;
  console.log('    ' + (out.right + out.asked.length) + '/' + HELD.length + ' right — initiative requests ' + (mine - out.miss.length - out.wrong.length - out.asked.length) + '/' + mine +
    ' acted on' + (out.asked.length ? ', ' + out.asked.length + ' asked about first (' + out.asked.join(' | ') + ')' : '') +
    '; missed: ' + (out.miss.join(' | ') || 'none') + (out.askedNot.length ? '; asked needlessly: ' + out.askedNot.join(' | ') : ''));
  ok(out.wrong.length === 0, 'no initiative request goes to the wrong part' + (out.wrong.length ? ': ' + out.wrong.join(' | ') : ''));
  ok(out.intruders.length === 0, 'nothing else is acted on as initiative' + (out.intruders.length ? ': ' + out.intruders.join(' | ') : ''));
  ok((await P.proactiveIntentOf('be quiet for a sec i am on a call')) === null, '"be quiet…" — which PROACTIVE_RE turned into initiative OFF — is not initiative');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed: ' + (e.stack || e)); process.exit(1); });
