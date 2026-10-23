'use strict';
// JARVIS'S OWN PANELS — the World Monitor and the neural network — opened and closed by the reader. NEEDS
// OLLAMA with the reader model (it reads each sentence); nothing is opened.
//
// WHAT THIS REPLACES. Four client-side word lists in public/app.js (worldOpenIntent, worldCloseIntent,
// neuralOpenIntent, neuralCloseIntent): a list of opening verbs and one of closing verbs, in front of the
// panel's name. Opening and closing is what the reader already reads, with its own probabilities on
// which half (readmodel.polarityOf); the panels are a registry the machine owns (server.js PANELS), the
// same way apps and sites are. The client only shows the panel it is told to.
//
// THE HELD-OUT SET BELOW WAS WRITTEN BEFORE THE REGISTRY EXISTED (2026-09-19 10:20 IST), in his texting
// style, with look-alikes that must NOT open a panel: Activity Monitor (a real app), World of Warcraft,
// questions and searches about neural networks. The suite measures the reader against the client's old
// lists on it, and asserts the reader is not worse and opens nothing it should not.
process.env.JARVIS_READER_CACHE = 'readmodel.test_panels.json';
const J = require('../server.js');
const RM = J.readmodel;

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };

const W = 'world', N = 'neural';
// [sentence, what should happen: 'open:<panel>' | 'close:<panel>' | null (no panel)]
const HELD = [
  ['open world monitor', 'open:' + W], ['boot up the world monitor', 'open:' + W], ['world monitor kholo', 'open:' + W],
  ['pull up world monitor plz', 'open:' + W], ['show world monitor', 'open:' + W], ['can u open the world monitor', 'open:' + W],
  ['close world monitor', 'close:' + W], ['shut the world monitor', 'close:' + W], ['world monitor band karo', 'close:' + W],
  ['exit world monitor', 'close:' + W],
  ['open neural network', 'open:' + N], ['show me the neural net', 'open:' + N], ['neural network kholo', 'open:' + N],
  ['bring up the neural network', 'open:' + N], ['launch neural net', 'open:' + N],
  ['close the neural net', 'close:' + N], ['hide neural network', 'close:' + N], ['neural network band karo', 'close:' + N],
  ['quit neural network', 'close:' + N],
  ['what is a neural network', null], ['search for neural network tutorials', null], ['open activity monitor', null],
  ['world news', null], ['monitor my battery', null], ['train a neural network in python', null], ['open world of warcraft', null],
];

// The client's lists, copied from public/app.js as they stood before this change — measured, not trusted.
const OLD = {
  worldOpen: t => /\b(?:boot(?:\s+up)?|open|launch|start|pull\s+up|bring\s+up|show\s+me)\s+(?:the\s+|my\s+)?world\s*monitor\b/i.test(t.toLowerCase()),
  worldClose: t => /\b(?:close|shut(?:\s+down)?|exit|quit)\s+(?:the\s+|my\s+)?world\s*monitor\b/i.test(t.toLowerCase()),
  neuralOpen: t => /\b(?:open|show|boot(?:\s+up)?|launch|start|pull\s+up|bring\s+up)\s+(?:the\s+|my\s+)?neural\s*(?:net|network|map|graph)?\b/i.test(String(t).toLowerCase()),
  neuralClose: t => /\b(?:close|shut(?:\s+down)?|exit|quit|hide)\s+(?:the\s+|my\s+)?neural\s*(?:net|network|map|graph)?\b/i.test(String(t).toLowerCase()),
};
const oldSays = t => OLD.neuralOpen(t) ? 'open:' + N : OLD.neuralClose(t) ? 'close:' + N : OLD.worldOpen(t) ? 'open:' + W : OLD.worldClose(t) ? 'close:' + W : null;
const newSays = t => {
  const b = RM.build(t, RM.readSync(t));
  const a = b && (b.action || (b.ask && b.ask.action));
  if (!a || (a.type !== 'open_panel' && a.type !== 'close_panel')) return null;
  return (a.type === 'open_panel' ? 'open:' : 'close:') + a.target + (b.ask ? ' (asked first)' : '');
};

(async () => {
  console.log('\n— the registry (no model) —');
  const anchor = t => { const a = J.actread.anchorsIn(J.actread.tokenize(t)); return a.length ? a[0].kind + ':' + a[0].value : null; };
  ok(anchor('world monitor') === 'panel:' + W, '"world monitor" is the World Monitor');
  ok(anchor('neural network') === 'panel:' + N && anchor('neural net') === 'panel:' + N, '"neural network" and "neural net" are the neural network');
  ok(anchor('activity monitor') !== 'panel:' + W, '"activity monitor" is not the World Monitor');

  await RM.warm(HELD.map(([t]) => t));
  if (!RM.ready()) { console.log('Skipping the measurement — the reader model is not reachable'); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

  console.log('\n— the held-out set: the reader + registry against the old lists —');
  const score = says => {
    let right = 0, wrong = [], missed = [];
    for (const [t, want] of HELD) {
      const got = says(t);
      const plain = got && got.replace(' (asked first)', '');
      if (plain === want || (!want && !got)) right++;
      else if (got && plain !== want) wrong.push(t + ' → ' + got);
      else missed.push(t);
    }
    return { right, wrong, missed };
  };
  const o = score(oldSays), n = score(newSays);
  console.log('    old lists     ' + o.right + '/' + HELD.length + ' right; wrong: ' + (o.wrong.join(' | ') || 'none') + '; missed: ' + (o.missed.join(' | ') || 'none'));
  console.log('    reader        ' + n.right + '/' + HELD.length + ' right; wrong: ' + (n.wrong.join(' | ') || 'none') + '; missed: ' + (n.missed.join(' | ') || 'none'));
  ok(n.wrong.length === 0, 'the reader opens or closes no panel it should not');
  ok(n.right >= o.right, 'and is not worse than the lists it replaces');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed: ' + (e.stack || e)); process.exit(1); });
