'use strict';
// MEASUREMENT SCRIPT — not a test. Web research (server.js doResearch) under different settings: how long
// it takes, how much the 3B has to read, and whether the answer is still right. Fires no actions — it
// searches the web and asks the local 3B, nothing else. Written 2026-09-23 after a real turn showed
// research as the biggest cost of a turn (36.8 s of 52.9 s for "what is the capital of germany").
//
//   node sweeps/sweep_research_speed.js [limit]
//
// THE QUESTIONS WERE WRITTEN BEFORE ANY SETTING WAS TRIED, with answers anyone can check; his own
// "who is the ceo of blackrock" is among them (the question the research lane exists for). Each question
// runs under every setting back to back, so the settings share the same network conditions.
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.sweep_research_speed.json';
const J = require('../server.js');

// [question, answer patterns — any one matching counts as right]
const QUESTIONS = [
  ['who is the ceo of blackrock', ['fink']],
  ['what is the capital of australia', ['canberra']],
  ['who wrote the alchemist', ['coelho']],
  ['how tall is the eiffel tower', ['330', '324', '300 m', '1,083', '1,063']],
  ['when did the first iphone come out', ['2007']],
  ['what is the chemical symbol for gold', ['\\bAu\\b']],
  ['who painted the mona lisa', ['da vinci', 'leonardo']],
  ['what currency does japan use', ['\\byen\\b']],
  ['what year did india get independence', ['1947']],
  ['which company makes the playstation', ['sony']],
  ['what is the largest planet in the solar system', ['jupiter']],
  ['who won the 2023 cricket world cup', ['australia']],
  ['how many bones are in the human body', ['206']],
  ['what is the speed of light', ['299,792', '299792', '300,000', '186,000', '3 ?x ?10']],
  ['who founded microsoft', ['gates']],
  ['what language is spoken in brazil', ['portuguese']],
  ['who is the ceo of nvidia', ['huang']],
  ['what is the tallest mountain in the world', ['everest']],
  ['how far is the moon from earth', ['384', '238,']],
  ['who discovered penicillin', ['fleming']],
];
const right = (reply, pats) => pats.some(p => new RegExp(p, /[A-Z]/.test(p) ? '' : 'i').test(String(reply)));

// The settings compared. `now` is what the live lane does today.
const SETTINGS = {
  // `now` is whatever the live lane does — since 2026-09-23 that IS shortFirst for local, non-deep research;
  // `before` pins what it did until then.
  now: {},
  before: { perSrc: 1400, maxTokens: 500, brevity: 'Be brief: 4-6 sentences.', firstArrived: false },
  short: { perSrc: 700, maxTokens: 220, brevity: 'Be brief: 1-3 sentences.' },
  shortFirst: { perSrc: 700, maxTokens: 220, brevity: 'Be brief: 1-3 sentences.', firstArrived: true },
  tiny: { nSrc: 2, perSrc: 400, maxTokens: 150, brevity: 'Be brief: 1-2 sentences.', firstArrived: true },
};

(async () => {
  const limit = Number(process.argv[2]) || QUESTIONS.length;
  const tally = {};
  for (const name of Object.keys(SETTINGS)) tally[name] = { right: 0, ms: [], net: [], chars: [], wrong: [] };
  for (const [q, pats] of QUESTIONS.slice(0, limit)) {
    const line = [q.padEnd(48)];
    for (const [name, opts] of Object.entries(SETTINGS)) {
      const r = await J.doResearch(q, opts);
      const ok = right(r.reply, pats);
      const t = tally[name];
      if (ok) t.right++; else t.wrong.push(q + ' → ' + String(r.reply).slice(0, 90));
      t.ms.push(r.ms || 0); t.net.push(r.netMs || 0); t.chars.push(r.ctxChars || 0);
      line.push(name + ' ' + (ok ? 'ok ' : 'NO ') + String(Math.round((r.ms || 0) / 100) / 10).padStart(5) + 's');
    }
    console.log(line.join('  '));
  }
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const sum = a => a.reduce((x, y) => x + y, 0);
  console.log('\nsetting      right   median   mean    web median   chars read (median)');
  for (const [name, t] of Object.entries(tally)) {
    console.log('  ' + name.padEnd(11) + (t.right + '/' + t.ms.length).padEnd(8) + ((med(t.ms) / 1000).toFixed(1) + 's').padEnd(9) +
      ((sum(t.ms) / t.ms.length / 1000).toFixed(1) + 's').padEnd(8) + ((med(t.net) / 1000).toFixed(1) + 's').padEnd(14) + med(t.chars));
  }
  for (const [name, t] of Object.entries(tally)) for (const w of t.wrong) console.log('  wrong (' + name + '): ' + w);
  process.exit(0);
})().catch(e => { console.log('crashed: ' + (e.stack || e)); process.exit(1); });
