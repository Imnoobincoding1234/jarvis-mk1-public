'use strict';
// dreamintent.js — is this about dream mode, and which part? NEEDS OLLAMA (it asks the embedder).
//
// THE HELD-OUT SET BELOW WAS WRITTEN BEFORE ANYTHING WAS MEASURED, and none of it is an exemplar (the
// suite checks). His own dream-mode messages are here — "dream now", "dream log", "what did you do
// while I was away", "What happened while I was asleep?" — with look-alikes that must NOT reach dream
// mode: "tidy up my desktop" (the old DREAM_RE ran maintenance for it), his own "what did I do today",
// other on/off settings, and human dreams. The suite prints the sweep, and asserts at the shipped gate:
// no request goes to the wrong dream region, and nothing that is not dream mode reaches one.

const intent = require('../intent.js');
const D = require('../dreamintent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

const HELD = [
  // the log
  ['dream log', 'dream_log'], ['what did you do while I was away', 'dream_log'],
  ['What happened while I was asleep?', 'dream_log'], ['what did you do overnight', 'dream_log'],
  ['did you do anything while i was out', 'dream_log'], ['what have you been up to while i was gone', 'dream_log'],
  ['show me the dream log', 'dream_log'], ['tumne raat ko kya kiya', 'dream_log'],
  // run it now
  ['dream now', 'dream_now'], ['run maintenance', 'dream_now'], ['do your idle jobs now', 'dream_now'],
  ['start dreaming now', 'dream_now'], ['run your background tasks right now', 'dream_now'],
  ['go ahead and do your maintenance', 'dream_now'], ['abhi dream karo', 'dream_now'],
  // the setting
  ['turn off dream mode', 'dream_setting'], ['turn dream mode on', 'dream_setting'], ['disable dream mode', 'dream_setting'],
  ['stop dreaming while i am away', 'dream_setting'], ['dream mode off', 'dream_setting'],
  ['enable dream mode again', 'dream_setting'], ['dream mode band kar do', 'dream_setting'],
  // not dream mode
  ['tidy up my desktop', null], ['what did I do today', null], ['turn off focus mode', null],
  ['i had a dream about flying', null], ['clean my desktop', null], ['run a virus scan', null],
  ['do my homework now', null], ['what did you say', null], ['switch off the display', null],
  ['what happens in your mind when you dream', null], ['stop the music', null], ['enable wifi', null],
  ['what did we do last time', null], ['mera desktop saaf karo', null],
];

// A SECOND HELD-OUT SET, WRITTEN AFTER THE FIRST WAS MEASURED AND BEFORE THE REGIONS WERE CHANGED.
// The first measurement showed the dream regions missing his own "dream log" / "dream now": the regions
// barely used the feature's own name, so "dream" drifted to human dreams. The regions were given the
// name — never these sentences — and from then on HELD had been looked at. FRESH is the honest number.
const FRESH = [
  ['did you get anything done last night', 'dream_log'], ['give me a recap of your night', 'dream_log'],
  ['what did you work on while i slept', 'dream_log'], ['jab main so raha tha tab tumne kya kiya', 'dream_log'],
  ['run your overnight stuff now', 'dream_now'], ['kick off your background jobs', 'dream_now'],
  ['run your nightly jobs right now', 'dream_now'], ['maintenance kar do abhi', 'dream_now'],
  ['switch dream mode off', 'dream_setting'], ['stop your idle work', 'dream_setting'],
  ['turn your dream mode back on', 'dream_setting'], ['dream mode on karo', 'dream_setting'],
  ['no more dreaming while i am away', 'dream_setting'],
  ['play dreams by fleetwood mac', null], ['organise my photos folder', null], ['what did i watch yesterday', null],
  ['turn on airplane mode', null], ['i dreamt i was flying', null], ['run the tests now', null],
  ['clean up these files', null], ['what did you do wrong', null], ['turn off the tv', null], ['what did i eat today', null],
];

(async () => {
  if (!(await intent.embed('probe'))) { console.log('Skipping — the embedder is not reachable'); process.exit(0); }

  head('the held-out set is not the exemplars');
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ex = new Set(Object.values(D.DREAM_EXEMPLARS).flat().map(norm));
  ok(HELD.every(([t]) => !ex.has(norm(t))), 'no held-out sentence is an exemplar (' + HELD.length + ' held out)');

  // Every case's winning region and margin, before any gate.
  const raw = intent.makeClassifier({ exemplars: D.DREAM_EXEMPLARS, minMargin: 0, none: '__unused__', groups: D.GROUPS, label: 'DreamRaw', jlog: () => {} });
  const got = [];
  for (const [t, want] of HELD) {
    const r = await raw(t);
    got.push({ t, want, id: r ? r.id : null, dream: !!(r && D.GROUPS[r.id] !== 'not_dream'), margin: r ? r.margin : 0 });
  }
  const at = gate => {
    let right = 0, miss = 0, wrong = 0, falseDream = 0;
    for (const g of got) {
      const said = g.dream && g.margin >= gate ? g.id : null;
      if (g.want === null) { if (said) falseDream++; else right++; }
      else if (said === g.want) right++;
      else if (said === null) miss++;
      else wrong++;
    }
    return { right, miss, wrong, falseDream };
  };

  head('the sweep (dream cases: right / missed / wrong region; not-dream cases reaching dream mode)');
  console.log('    gate    right  missed  wrong  false-dream');
  for (const gate of [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
    const s = at(gate);
    console.log('    ' + gate.toFixed(2).padEnd(8) + String(s.right).padStart(5) + String(s.miss).padStart(8) + String(s.wrong).padStart(7) + String(s.falseDream).padStart(12) +
      (gate === D.MIN_MARGIN ? '   ← shipped' : ''));
  }
  const dreamOk = got.filter(g => g.want && g.id === g.want).map(g => g.margin);
  const intruders = got.filter(g => g.dream && g.id !== g.want).map(g => g.margin);
  console.log('    lowest margin on a right dream case  ' + (dreamOk.length ? Math.min(...dreamOk).toFixed(3) : '-'));
  console.log('    highest margin on a WRONG dream call ' + (intruders.length ? Math.max(...intruders).toFixed(3) : 'none at all'));
  for (const g of got) if ((g.want || null) !== (g.dream && g.margin >= D.MIN_MARGIN ? g.id : null)) {
    console.log('    ' + (g.want ? 'missed' : 'intruder').padEnd(9) + JSON.stringify(g.t).padEnd(46) + ' → ' + g.id + ' (' + g.margin.toFixed(3) + ')');
  }

  head('the tool names are the machine\'s own');
  ok(D.namedTool('dream log') === 'dream_log' && D.namedTool('show me the dream log') === 'dream_log', '"dream log" names the dream_log tool, alone or in a sentence');
  ok(D.namedTool('dream now') === 'dream_now', '"dream now" names dream_now');
  ok(D.namedTool('play dreams by fleetwood mac') === null && D.namedTool('i had a dream') === null, 'a song called Dreams, or a dream, names no tool');

  // A NAME IS EVIDENCE, NOT A DECISION. These name a tool in ordinary words; the first version acted on
  // the name alone and would have started a dream cycle for the first two. Written to test that rule —
  // no region was changed after them.
  head('a tool named in a sentence that reads otherwise is asked about, never acted on');
  for (const t of ['my dream now is to be a pilot', 'i had a weird dream now that i think about it', 'i keep a dream log in my notes']) {
    const s = await D.dreamIntentOf(t);
    ok(!(s && s.sure), JSON.stringify(t) + ' → ' + (s ? (s.sure ? 'ACTS: ' : 'asks: ') + s.id : 'not dream mode'));
  }

  // THE WHOLE PIPELINE on both sets. Three outcomes for a dream request: acted on (right or WRONG part),
  // asked about (a named tool the classifier read otherwise — his yes is kept, so once per sentence), or
  // missed (carries on to the lanes below).
  const run = async set => {
    const out = { right: 0, asked: [], miss: [], wrong: [], intruders: [], askedNot: [] };
    for (const [t, want] of set) {
      const s = await D.dreamIntentOf(t);
      const acts = s && s.sure ? s.id : null;
      if (s && !s.sure) { (want === s.id ? out.asked : want ? out.wrong : out.askedNot).push(t + (want === s.id ? '' : ' → asks ' + s.id)); continue; }
      if (acts === want) out.right++;
      else if (want && !acts) out.miss.push(t);
      else if (want) out.wrong.push(t + ' → ' + acts);
      else out.intruders.push(t + ' → ' + acts);
    }
    return out;
  };
  for (const [name, set] of [['first held-out set (looked at while designing)', HELD], ['FRESH held-out set (never looked at)', FRESH]]) {
    head(name);
    const r = await run(set);
    const dreams = set.filter(([, w]) => w).length;
    const acted = dreams - r.miss.length - r.wrong.length - r.asked.length;
    console.log('    ' + (r.right + r.asked.length) + '/' + set.length + ' right — dream requests ' + acted + '/' + dreams + ' acted on' +
      (r.asked.length ? ', ' + r.asked.length + ' asked about first (' + r.asked.join(' | ') + ')' : '') +
      '; missed: ' + (r.miss.join(' | ') || 'none') + (r.askedNot.length ? '; asked needlessly: ' + r.askedNot.join(' | ') : ''));
    ok(r.wrong.length === 0, 'no dream request goes to the wrong part of dream mode' + (r.wrong.length ? ': ' + r.wrong.join(' | ') : ''));
    ok(r.intruders.length === 0, 'nothing that is not dream mode is acted on as dream mode' + (r.intruders.length ? ': ' + r.intruders.join(' | ') : ''));
  }
  ok((await D.dreamIntentOf('tidy up my desktop')) === null, '"tidy up my desktop" — which the old DREAM_RE ran maintenance for — is not dream mode');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed: ' + (e.stack || e)); process.exit(1); });
