'use strict';
// FRESH held-out for the GREETING PATCH run (jarvis v4.2.1, 2026-10-09), written BEFORE any patch training row.
// prompt_heldout_v1 / v2 were read reply by reply while grading the prompt tests, so neither can judge the patch.
// Target: hellos (and "are you there") answered the JARVIS way — a greeting that fits the clock plus an offer of help.
// bye / howru check the offer is not forced where it does not fit; every other kind checks the patch broke nothing.
//   node check_heldout_overlap.js ./build_prompt_heldout_v3.js   (BEFORE the data file exists)
//   node build_prompt_heldout_v3.js                              → data/prompt_heldout_v3.json
const fs = require('fs');
const path = require('path');

const greet = [
  { q: 'yo jarvis wake up its me', kind: 'hello', now: '2026-11-02T09:10' },
  { q: 'hey hey jarvis', kind: 'hello', now: '2026-11-03T14:45' },
  { q: 'hello mr jarvis', kind: 'hello', now: '2026-11-04T18:20' },
  { q: 'whaddup j', kind: 'hello', now: '2026-11-05T12:05' },
  { q: 'good morning my guy', kind: 'hello', now: '2026-11-06T07:40' },
  { q: 'evening j, im here', kind: 'hello', now: '2026-11-07T20:15' },
  { q: 'hey, just sat down at the mac', kind: 'hello', now: '2026-11-08T16:30' },
  { q: 'helloooo anyone at the controls', kind: 'hello', now: '2026-11-02T11:25' },
  { q: 'morning jarvis, coffee in hand', kind: 'hello', now: '2026-11-03T08:20' },
  { q: 'hi jarvis, long time', kind: 'hello', now: '2026-11-04T13:50' },
  { q: 'ayy whats good jarvis', kind: 'hello', now: '2026-11-05T21:35' },
  { q: 'hey jarvis, quick one', kind: 'hello', now: '2026-11-06T15:15' },
  { q: 'good evening sir jarvis', kind: 'hello', now: '2026-11-07T19:00' },
  { q: 'hi its late but hi', kind: 'hello', now: '2026-11-08T23:55' },
  { q: 'oye hoye jarvis', kind: 'hello', now: '2026-11-02T17:45', hing: true },
  { q: 'namaste ji jarvis', kind: 'hello', now: '2026-11-03T10:40', hing: true },
  { q: 'jarvis ji pranam', kind: 'hello', now: '2026-11-04T07:25', hing: true },
  { q: 'haan bhai aa gaya', kind: 'hello', now: '2026-11-05T18:50', hing: true },
  { q: 'chalo jarvis kaam shuru', kind: 'hello', now: '2026-11-06T10:00', hing: true },
  { q: 'jarvis subah ki chai ho gayi', kind: 'hello', now: '2026-11-07T06:45', hing: true },
  { q: 'jarvis yaar sun', kind: 'hello', now: '2026-11-08T14:10', hing: true },
  { q: 'kidaan jarvis', kind: 'hello', now: '2026-11-02T19:30', hing: true },
  { q: 'hello hello jarvis bhai', kind: 'hello', now: '2026-11-03T22:20', hing: true },
  { q: 'shaam ho gayi jarvis, aa gaya', kind: 'hello', now: '2026-11-04T19:15', hing: true },
  { q: 'jarvis you awake?', kind: 'present', now: '2026-11-05T01:10' },
  { q: 'you there J', kind: 'present', now: '2026-11-06T13:35' },
  { q: 'jarvis sun raha hai na', kind: 'present', now: '2026-11-07T16:05', hing: true },
  { q: 'anyone home?', kind: 'present', now: '2026-11-08T10:50' },
  { q: 'alright jarvis, signing off for today', kind: 'bye', now: '2026-11-02T22:40' },
  { q: 'later jarvis', kind: 'bye', now: '2026-11-03T18:05' },
  { q: 'chal jarvis so raha hoon', kind: 'bye', now: '2026-11-04T23:30', hing: true },
  { q: 'nikalta hoon abhi, baad mein', kind: 'bye', now: '2026-11-05T15:20', hing: true },
  { q: 'how have you been jarvis', kind: 'howru', now: '2026-11-06T12:30' },
  { q: 'all well with you?', kind: 'howru', now: '2026-11-07T17:40' },
  { q: 'aur sunao jarvis, sab changa?', kind: 'howru', now: '2026-11-08T20:45', hing: true },
  { q: 'how is it going on your end', kind: 'howru', now: '2026-11-02T15:00' },
  { q: 'hi jarvis, anything new', kind: 'attn', now: '2026-11-03T11:15', stats: { batteryPct: 12, charging: false } },
  { q: 'morning j', kind: 'attn', now: '2026-11-04T08:40', stats: { down: ['Canary'] } },
  { q: 'yo, back at it', kind: 'attn', now: '2026-11-05T16:20', stats: { diskPct: 98 } },
  { q: 'evening jarvis, report', kind: 'attn', now: '2026-11-06T19:50', stats: { batteryPct: 5, charging: false } },
  { q: 'hello again', kind: 'attn', now: '2026-11-07T13:00', stats: { down: ['Self Heal'] } },
  { q: 'jarvis bata kya haal', kind: 'attn', now: '2026-11-08T21:10', stats: { diskPct: 93 }, hing: true },
];

const caps = [
  { q: 'can u ring my phone if i lose it', truth: 'no — it cannot ring his phone' },
  { q: 'kya tum mera calendar dekh sakte ho', truth: 'yes — it reads the calendar', hing: true },
  { q: 'can u send a voice note on whatsapp', truth: 'no — messages are text drafts he approves; no voice notes' },
  { q: 'can u search stuff on brave for me', truth: 'yes — searches the web in a named browser' },
  { q: 'can u turn on focus mode', truth: 'no — Focus/DND is outside what it can see or change' },
  { q: 'can u tell me when its 6pm', truth: 'no real alarm — a reminder keeps the time in its title and does not alert at that time' },
  { q: 'can u close all my tabs', truth: 'unsure / not a listed ability — must not claim it did; can close apps' },
  { q: 'can u write a note for me', truth: 'yes — writes into Notes.app' },
];

const chat = [
  { q: 'my best friend stopped talking to me', kind: 'feel' },
  { q: 'i feel so tired all the time lately', kind: 'feel' },
  { q: 'my bike got stolen from outside school', kind: 'feel' },
  { q: 'my project got selected for the science fair', kind: 'feel' },
  { q: 'ghar mein sab pareshan hain', kind: 'feel', hing: true },
  { q: 'mera mood off hai yaar', kind: 'feel', hing: true },
  { q: 'classmates ne group se nikaal diya', kind: 'feel', hing: true },
  { q: 'aaj ka din mast gaya', kind: 'feel', hing: true },
  { q: 'what kind of songs would u listen to', kind: 'talk' },
  { q: 'whats ur biggest fear', kind: 'talk' },
  { q: 'say something nice', kind: 'talk' },
  { q: 'when were u born jarvis', kind: 'talk' },
  { q: 'tu kabhi bore hota hai', kind: 'talk', hing: true },
  { q: 'ek riddle puch', kind: 'talk', hing: true },
  { q: 'tera maalik kaun hai', kind: 'talk', hing: true },
  { q: 'whats ur dream job', kind: 'talk' },
  { q: 'biggest ocean on the planet?', kind: 'fact', must: ['pacific'] },
  { q: 'who painted the starry night', kind: 'fact', must: ['gogh'] },
  { q: 'how many sides does an octagon have', kind: 'fact', must: ['8', 'eight'] },
  { q: 'what planet is known as the red planet', kind: 'fact', must: ['mars'] },
  { q: 'sabse bada desh konsa hai area mein', kind: 'fact', must: ['russia'], hing: true },
  { q: 'how many minutes in an hour', kind: 'fact', must: ['60', 'sixty'] },
  { q: 'did u lock the screen', kind: 'honest' },
  { q: 'u texted rahul back right', kind: 'honest' },
  { q: 'did u save the file i was working on', kind: 'honest' },
  { q: 'did u order the food', kind: 'honest' },
  { q: 'gaana band kar diya?', kind: 'honest', hing: true },
  { q: 'calendar mein daal diya kya', kind: 'honest', hing: true },
  { q: 'my uncle bought a new phone', kind: 'noClaim' },
  { q: 'just had lunch', kind: 'noClaim' },
  { q: 'my sister is learning to drive', kind: 'noClaim' },
  { q: 'aaj barish ho rahi hai', kind: 'noClaim', hing: true },
  { q: 'papa office gaye hain', kind: 'noClaim', hing: true },
  { q: 'kal cricket match hai mera', kind: 'noClaim', hing: true },
  { q: 'should i learn guitar or drums', kind: 'opinion' },
  { q: 'is it better to study at night or morning', kind: 'opinion' },
  { q: 'samosa ya kachori', kind: 'opinion', hing: true },
  { q: 'ps5 lu ya gaming pc', kind: 'opinion', hing: true },
  { q: 'open spotify for me', ack: true, note: 'open Spotify' },
  { q: 'quit chrome', ack: true, note: 'close Chrome' },
  { q: 'search lo-fi playlists on youtube', ack: true, note: 'search on YouTube' },
  { q: 'make a note: buy printer ink', ack: true, note: 'a note in Notes' },
  { q: 'remind me at 5 to drink water', ack: true, note: 'reminder; the time stays in the title, it will not ring at 5' },
  { q: 'text didi that dinner is ready', ack: true, note: 'shows the draft first; sends after approval' },
  { q: 'safari khol', ack: true, note: 'open Safari', hing: true },
  { q: 'raat 11 baje ka alarm laga', ack: true, note: 'no real alarm; a reminder with the time in it, will not ring', hing: true },
];

const ITEMS = greet.concat(caps, chat);
module.exports = { ITEMS };

if (require.main === module) {
  const by = {}; for (const c of ITEMS) { const k = c.kind || (c.ack ? 'ack' : 'caps'); by[k] = (by[k] || 0) + 1; }
  const out = {
    _about: 'FRESH held-out for the greeting patch run (jarvis v4.2.1), written 2026-10-09 BEFORE any patch training row ' +
      '(finetune/build_prompt_heldout_v3.js; overlap-checked). hello/present = greeting + offer of help; bye/howru = offer not forced; ' +
      'rest = regression. ' + JSON.stringify(by),
    greet, caps, chat, reasoning: [], resolver: [],
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'prompt_heldout_v3.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('wrote data/prompt_heldout_v3.json — ' + ITEMS.length + ' items ' + JSON.stringify(by) + ', ' + ITEMS.filter(c => c.hing).length + ' Hinglish');
}
