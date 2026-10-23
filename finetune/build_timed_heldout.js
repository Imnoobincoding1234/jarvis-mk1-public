'use strict';
// TIMED-REQUEST HELD-OUT v1 — written 2026-10-14, BEFORE timedintent.js, its exemplars or any scheduling code existed.
// README "B · timed requests". 60 lines, about a third Hinglish, written in his register for this file only — never copied
// from his messages, never trained on, never used as an exemplar. Labels are fixed here.
//   later     — a request for JARVIS to do something at a later time: `delay` minutes from now, or a clock time
//               `at: [hour, minute, 'next'|'tomorrow']` ('next' = the next time the clock shows it); `task` = what must be in
//               the scheduled task's text
//   other     — must NOT be scheduled: now-requests that contain numbers or times (a message whose CONTENT has a time is a
//               send now), questions about time, statements with a time in them, and reminder requests (the reminder lane
//               keeps those — his decision: no time parser, no alarm, said honestly)
//   node build_timed_heldout.js   → overlap check (every file in finetune/data, his episodes), then data/timed_heldout_v1.jsonl
const fs = require('fs');
const path = require('path');

const E = 'en', H = 'hinglish';
const ROWS = [
  // ---- later: delays ----
  ['later', E, 'close safari in like 10 minutes', { delay: 10, task: ['safari'] }],
  ['later', E, 'play some lofi in 15 mins', { delay: 15, task: ['lofi'] }],
  ['later', E, 'in 20 minutes text bhai that dinner is ready', { delay: 20, task: ['bhai'] }],
  ['later', E, 'take a screenshot in 3 minutes', { delay: 3, task: ['screenshot'] }],
  ['later', E, 'shut down discord after an hour', { delay: 60, task: ['discord'] }],
  ['later', E, 'search for the match score in 45 min', { delay: 45, task: ['score'] }],
  ['later', E, 'launch xcode in a minute', { delay: 1, task: ['xcode'] }],
  ['later', E, 'pause the music in 30 mins', { delay: 30, task: ['music'] }],
  ['later', E, 'around 10 minutes from now open the downloads folder', { delay: 10, task: ['downloads'] }],
  ['later', E, 'quit chrome after 25 minutes', { delay: 25, task: ['chrome'] }],
  ['later', E, 'open netflix in two hours', { delay: 120, task: ['netflix'] }],
  ['later', E, 'close all my apps in 40 minutes', { delay: 40, task: ['apps'] }],
  ['later', E, 'after 15 min open notes and start a new one', { delay: 15, task: ['notes'] }],
  ['later', H, '10 minute baad spotify band kar dena', { delay: 10, task: ['spotify'] }],
  ['later', H, 'aadhe ghante mein youtube khol dena', { delay: 30, task: ['youtube'] }],
  ['later', H, '5 min mein calculator khol', { delay: 5, task: ['calculator'] }],
  ['later', H, 'ek ghante baad safari band kar', { delay: 60, task: ['safari'] }],
  ['later', H, '20 minute baad whatsapp khol dena', { delay: 20, task: ['whatsapp'] }],
  ['later', H, '15 min baad bhai ko call laga dena', { delay: 15, task: ['bhai'] }],
  // ---- later: clock times ----
  ['later', E, 'open youtube at 9 tonight', { at: [21, 0, 'next'], task: ['youtube'] }],
  ['later', E, 'at 7am tomorrow open my calendar', { at: [7, 0, 'tomorrow'], task: ['calendar'] }],
  ['later', E, 'message kunal at 6 pm saying gym time', { at: [18, 0, 'next'], task: ['kunal'] }],
  ['later', E, 'open whatsapp at 8:15 pm', { at: [20, 15, 'next'], task: ['whatsapp'] }],
  ['later', E, 'play arijit songs at 11 tonight', { at: [23, 0, 'next'], task: ['arijit'] }],
  ['later', E, 'send yuvan hi at 4 pm', { at: [16, 0, 'next'], task: ['yuvan'] }],
  ['later', E, 'start the gym playlist at 6 am tomorrow', { at: [6, 0, 'tomorrow'], task: ['gym'] }],
  ['later', H, 'raat 10 baje mama ko msg kar dena ki so gaya', { at: [22, 0, 'next'], task: ['mama'] }],
  ['later', H, 'kal subah 7 baje calendar dikha dena', { at: [7, 0, 'tomorrow'], task: ['calendar'] }],
  ['later', H, 'shaam 6 baje gaane chala dena', { at: [18, 0, 'next'], task: ['gaane'] }],
  ['later', H, '3 baje dopahar ko screenshot le lena', { at: [15, 0, 'next'], task: ['screenshot'] }],
  // ---- other: now-requests with numbers or times ----
  ['other', E, 'bump the brightness up to 70 percent', { why: 'now' }],
  ['other', E, 'play a 10 minute meditation', { why: 'now' }],
  ['other', E, 'text mama saying im on my way in half an hour', { why: 'now — the time is the message' }],
  ['other', E, 'search 15 minute pasta recipes', { why: 'now' }],
  ['other', E, 'open the 2 pm lecture notes', { why: 'now' }],
  ['other', E, 'message bhai that the movie starts at 8', { why: 'now — the time is the message' }],
  ['other', H, 'volume 30 pe kar do', { why: 'now' }],
  ['other', H, 'kunal ko bol de ki main 5 minute mein aa raha hoon', { why: 'now — the time is the message' }],
  ['other', E, 'open youtube and play top 10 songs of 2024', { why: 'now' }],
  ['other', H, 'ek 5 minute wala workout video laga', { why: 'now' }],
  // ---- other: questions about time ----
  ['other', E, 'is a 90 minute movie longer than 2 hours', { why: 'question' }],
  ['other', E, 'what time does the sun set today', { why: 'question' }],
  ['other', H, 'yaar ghadi dekh ke bata time kya ho gaya', { why: 'question' }],
  ['other', E, 'how many hours left before midnight', { why: 'question' }],
  ['other', E, 'what day is it tomorrow', { why: 'question' }],
  ['other', H, 'london mein abhi kya time hai', { why: 'question' }],
  // ---- other: statements with a time in them ----
  ['other', E, 'class starts at 9 tomorrow', { why: 'statement' }],
  ['other', E, 'ill be back in 10 mins', { why: 'statement' }],
  ['other', H, 'main 7 baje gym jaunga', { why: 'statement' }],
  ['other', E, 'my exam is in two weeks', { why: 'statement' }],
  ['other', E, 'the match starts in an hour lol', { why: 'statement' }],
  ['other', H, 'mama 6 baje aayegi', { why: 'statement' }],
  ['other', E, 'i slept for like 3 hours', { why: 'statement' }],
  ['other', E, 'kunal said hes coming at 5', { why: 'statement' }],
  // ---- other: reminder requests (the reminder lane keeps these) ----
  ['other', E, 'at 6 tonight remind me nanu wanted a call back', { why: 'reminder' }],
  ['other', E, 'remind me in 20 minutes to drink water', { why: 'reminder' }],
  ['other', H, 'kal subah 8 baje yaad dilana ki fees bharni hai', { why: 'reminder' }],
  ['other', E, 'set a reminder for 9 pm to study', { why: 'reminder' }],
  ['other', E, 'make sure i dont forget the science project tomorrow morning', { why: 'reminder' }],
  ['other', H, '1 ghante baad yaad dila dena pizza ka', { why: 'reminder' }],
];
const ITEMS = ROWS.map(([kind, lang, q, label], i) => ({ id: 't' + String(i + 1).padStart(2, '0'), kind, lang, q, label }));

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = s => new Set(norm(s).split(' ').filter(Boolean));
const jac = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };

function overlapCheck() {
  const prior = [];
  const files = [];
  const scan = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { scan(p); continue; }
    if (!/\.(jsonl?|txt|csv)$/.test(f) || p.endsWith('timed_heldout_v1.jsonl') || st.size > 200e6) continue;
    files.push(p);
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      // every string value on the line, at any depth — prompts, replies, labels
      const vals = []; try { (function walk(v) { if (typeof v === 'string') vals.push(v); else if (v && typeof v === 'object') for (const k in v) walk(v[k]); })(JSON.parse(line)); } catch (e) { vals.push(line); }
      for (const v of vals) if (v.length >= 6 && v.length <= 400) prior.push({ src: p, n: norm(v) });
    }
  } };
  scan(path.join(__dirname, 'data'));
  try {
    for (const ep of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'jarvis-os', 'state', 'episodes.json'), 'utf8')))
      for (const k of ['user', 'text', 'q', 'input']) if (ep && typeof ep[k] === 'string') prior.push({ src: 'episodes.json', n: norm(ep[k]) });
  } catch (e) { console.log('episodes.json not read:', e.message); }
  const exact = new Set(prior.map(p => p.n));
  const priorW = prior.map(p => ({ ...p, w: words(p.n) }));
  let hard = 0, near = 0;
  for (const it of ITEMS) {
    const n = norm(it.q), w = words(n);
    if (exact.has(n)) { hard++; console.log('EXACT', JSON.stringify(it.q)); continue; }
    for (const p of priorW) if (jac(w, p.w) >= 0.75) { near++; console.log('NEAR ', JSON.stringify(it.q), '≈', JSON.stringify(p.n), '←', path.relative(__dirname, p.src)); break; }
  }
  console.log('prior strings', prior.length, 'from', files.length + 1, 'files · items', ITEMS.length, '· exact', hard, '· near (word-Jaccard ≥ 0.75)', near);
  if (hard || near) { console.log('NOT WRITTEN — rewrite the lines above first'); process.exit(1); }
}

if (require.main === module) {
  const later = ITEMS.filter(x => x.kind === 'later').length, hi = ITEMS.filter(x => x.lang === H).length;
  console.log('items', ITEMS.length, '· later', later, '· other', ITEMS.length - later, '· hinglish', hi);
  overlapCheck();
  const out = path.join(__dirname, 'data', 'timed_heldout_v1.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS, norm, words, jac };
