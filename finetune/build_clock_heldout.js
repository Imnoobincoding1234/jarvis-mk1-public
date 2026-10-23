'use strict';
// FRESH held-out for the clock lane (2026-10-10, Atharv away on a trek), written BEFORE clockintent.js existed.
// Why: time questions were answered by the chat model reading the prompt's clock line, and half of them failed across the
// casual dev set and the one judged v2 run — the web lane took "whats the date today" and answered from search results
// with a wrong date (2023-09-28), "time in london" went to the web too, and Hinglish "kitne baje" was misread.
// No line of either casual stress set is used here; the guard refuses exact and near copies (word Jaccard ≥ 0.75).
//
// CANDIDATE (pre-registered): jarvis-os/clockintent.js — an embedding classifier (intent.makeClassifier) with two answered
// regions, `clock` (the time, the date or the day here) and `zone` (the time in a named place), and none regions for what
// merely mentions time (event times, alarms, his calendar, chat, knowledge, durations, app actions). `clock` is answered
// from the Mac's clock with time, weekday and date together; `zone` only when a city in Intl's IANA time-zone registry
// (a machine registry) is named in the sentence — otherwise it falls through to today's behaviour. Margin chosen by
// leave-one-out over the exemplars only (never this set), from {0.02, 0.03, 0.04, 0.05, 0.06, 0.08}.
// SHIPS ONLY IF (sweeps/sweep_clock.js, one run):
//   clock + zone lines answered correctly ≥ 34 of 40 (zone correct = the right IANA zone);
//   0 answers naming the wrong place; false fires on the 40 `other` lines ≤ 1.
// Otherwise nothing changes.
//   node build_clock_heldout.js → data/clock_heldout.json
const fs = require('fs');
const path = require('path');
const clock = [
  'yo what time is it', 'time kya hua', 'abhi kitna time hua hai', 'whats the time bro', 'tell me the time', 'current time pls',
  'time batao', 'is it late already what time is it', 'hey jarvis whats the clock saying', 'wat time is it now', 'can u tell me the time rq',
  'time dekh ke bata', 'yaar time kya ho gaya', 'am i late, whats the time', 'bro check the time', 'hows the time looking',
  'which date is it today', 'aaj kya date hai', 'date batao aaj ki', 'what date is it rn', 'tell me todays date', 'aaj kaun si tareekh hai',
  'date pls', 'what is the date, need it for my form',
  'what day is it today', 'aaj kaunsa din hai', 'is today monday', 'its sunday right', 'which day is it bro', 'aaj din kya hai',
  'is it the weekend yet', 'kya aaj thursday hai',
];
const zone = [
  ['whats the time in tokyo', 'Asia/Tokyo'], ['time in new york rn', 'America/New_York'], ['dubai mein kitne baje hain', 'Asia/Dubai'],
  ['what time is it in sydney', 'Australia/Sydney'], ['singapore ka time kya hai', 'Asia/Singapore'], ['is it night in los angeles rn', 'America/Los_Angeles'],
  ['current time in paris', 'Europe/Paris'], ['toronto mein abhi kya time hai', 'America/Toronto'],
];
const other = [
  // event times — the web's job
  'what time does the ipl match start today', 'when is diwali this year', 'what time does dmart close', 'when does the new marvel movie come out', 'what time is sunset today',
  // alarms and reminders
  'set an alarm for 6 tmrw', 'remind me at 9 to call nanu', 'wake me up in 20 mins', 'timer for 10 minutes',
  // his calendar
  'what time is my dentist appointment', 'am i free tmrw at 4', 'whats on my calendar today', 'what time is tuition tmrw',
  // chat that uses the word
  'i have no time for this lol', 'time to sleep fr', 'what a time to be alive', 'timepass kar raha hoon', 'bro u took so much time',
  'it was a good time', 'last time i checked u were faster', 'time flies man',
  // knowledge
  'what is time travel', 'who invented the clock', 'how many hours in a week', 'what year did india get independence', 'when was the iphone launched',
  'whats the time complexity of quicksort',
  // durations and plans
  'how long till 6 pm', 'how many hours till my exam', 'kitna time lagega delhi pahunchne mein', 'how long does it take to boil eggs',
  'what time should i sleep to get 8 hours', 'kal kitne baje uthna hai mujhe', 'what time did i sleep yesterday', 'date kab hai exam ki',
  // actions and other
  'play time by hans zimmer', 'open the clock app', 'search time magazine', 'date night ideas', 'how many days in february this year',
];
module.exports = { clock, zone, other };
if (require.main === module) {
  const words = s => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
  const jac = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n || 1); };
  const norm = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
  const others = [];
  for (const f of ['casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl'])
    for (const l of fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').split('\n')) if (l.trim()) others.push(JSON.parse(l).text);
  const all = clock.concat(zone.map(z => z[0]), other); let bad = 0;
  if (new Set(all.map(norm)).size !== all.length) { console.log('duplicate inside the set'); bad++; }
  for (const s of all) for (const o of others) if (norm(s) === norm(o) || jac(s, o) >= 0.75) { console.log('collides: ' + JSON.stringify(s) + ' ~ ' + JSON.stringify(o)); bad++; }
  const zones = new Set(Intl.supportedValuesOf('timeZone'));
  for (const [, z] of zone) if (!zones.has(z)) { console.log('not in the registry: ' + z); bad++; }
  if (bad) { console.log(bad + ' problem(s) — fix them; nothing written'); process.exit(1); }
  fs.writeFileSync(path.join(__dirname, 'data', 'clock_heldout.json'), JSON.stringify({
    _about: 'FRESH held-out for the clock lane, written 2026-10-10 BEFORE clockintent.js existed. ' + clock.length + ' clock / ' + zone.length +
      ' zone / ' + other.length + ' other. Candidate and bar in finetune/build_clock_heldout.js.', clock, zone, other }, null, 1) + '\n');
  console.log('wrote data/clock_heldout.json — ' + clock.length + ' clock, ' + zone.length + ' zone, ' + other.length + ' other; 0 collisions with ' + others.length + ' lines');
}
