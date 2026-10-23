'use strict';
// FRESH held-out for the GREETING-STYLE prompt question (2026-10-09), written before the candidate was run.
// His words: a "hi" gets "Hey, Sir." — "not jarvis like, which is 'hey sir how may i assist' etc". prompt_heldout_v1.json was
// read reply by reply while grading the short prompts, so it cannot judge this. Hellos are the target; goodbyes and
// "how are you" check that an offer of help is not tacked on where it does not fit; every other kind checks for regressions.
// Same shape as v4.2's held-out so build_bonsai_eval.js renders it unchanged. hing: true = Hinglish.
//
//   node check_heldout_overlap.js ./build_prompt_heldout_v2.js   (BEFORE the data file exists)
//   node build_prompt_heldout_v2.js                              → data/prompt_heldout_v2.json
const fs = require('fs');
const path = require('path');

const greet = [
  { q: 'hey jarvis good to see u', kind: 'hello', now: '2026-10-26T10:20' },
  { q: 'yo, jarvis in the house?', kind: 'hello', now: '2026-10-27T16:05' },
  { q: 'hiya', kind: 'hello', now: '2026-10-28T12:40' },
  { q: 'yo J, you with me?', kind: 'hello', now: '2026-10-29T14:25' },
  { q: 'well hello there jarvis', kind: 'hello', now: '2026-10-30T19:10' },
  { q: 'hello jarvis, its me', kind: 'hello', now: '2026-10-31T21:40' },
  { q: 'sup, whats cookin', kind: 'hello', now: '2026-11-01T11:15' },
  { q: 'gm jarvis, lets get to work', kind: 'hello', now: '2026-10-26T08:45' },
  { q: 'good afternoon to you jarvis', kind: 'hello', now: '2026-10-27T15:20' },
  { q: 'hey hey, back at the desk', kind: 'hello', now: '2026-10-28T17:30' },
  { q: 'greetings jarvis', kind: 'hello', now: '2026-10-29T09:35' },
  { q: 'jarvis my man', kind: 'hello', now: '2026-10-30T13:05' },
  { q: 'namaskar jarvis', kind: 'hello', now: '2026-10-31T10:05', hing: true },
  { q: 'aa gaya main jarvis', kind: 'hello', now: '2026-11-01T16:40', hing: true },
  { q: 'jarvis bhai suno', kind: 'hello', now: '2026-10-26T12:10', hing: true },
  { q: 'haanji jarvis', kind: 'hello', now: '2026-10-27T11:30', hing: true },
  { q: 'oye jarvis kidhar hai', kind: 'hello', now: '2026-10-28T22:10', hing: true },
  { q: 'subah ho gayi jarvis', kind: 'hello', now: '2026-10-29T06:55', hing: true },
  { q: 'chal jarvis shuru karte hain', kind: 'hello', now: '2026-10-30T09:20', hing: true },
  { q: 'jai shri krishna jarvis', kind: 'hello', now: '2026-10-31T08:15', hing: true },
  { q: 'hello ji', kind: 'hello', now: '2026-11-01T15:50', hing: true },
  { q: 'ok jarvis im off to bed', kind: 'bye', now: '2026-10-26T23:45' },
  { q: 'gotta go, ttyl', kind: 'bye', now: '2026-10-27T17:50' },
  { q: 'chalo bye jarvis, kal milte', kind: 'bye', now: '2026-10-28T22:30', hing: true },
  { q: 'shubh ratri jarvis', kind: 'bye', now: '2026-10-29T00:10', hing: true },
  { q: 'how u doing jarvis', kind: 'howru', now: '2026-10-30T14:00' },
  { q: 'hows your day been', kind: 'howru', now: '2026-10-31T20:30' },
  { q: 'u good jarvis?', kind: 'howru', now: '2026-11-01T11:50' },
  { q: 'kya haal hai mere dost', kind: 'howru', now: '2026-10-26T18:25', hing: true },
  { q: 'jarvis, hows everything', kind: 'attn', now: '2026-10-27T09:00', stats: { batteryPct: 7, charging: false } },
  { q: 'evening, anything i should know', kind: 'attn', now: '2026-10-28T19:45', stats: { down: ['Self Heal'] } },
  { q: 'im back, missed anything?', kind: 'attn', now: '2026-10-29T16:10', stats: { diskPct: 95 } },
  { q: 'morning, lets go', kind: 'attn', now: '2026-10-30T08:05', stats: { batteryPct: 18, charging: false } },
  { q: 'hey pal, all ok?', kind: 'attn', now: '2026-10-31T21:00', stats: { down: ['Focus Guard'] } },
  { q: 'haan jarvis bol', kind: 'attn', now: '2026-11-01T13:30', stats: { diskPct: 96 }, hing: true },
];

const caps = [
  { q: 'can you make a whatsapp video call to didi', truth: 'no — calls cannot be automated; it opens the chat, the call tap is his' },
  { q: 'kya tum mere notifications padh sakte ho', truth: 'no — it cannot read macOS notifications (needs Full Disk Access)', hing: true },
  { q: 'can u remember my friends birthdays', truth: 'yes — it remembers facts he tells it' },
  { q: 'can u open apps for me', truth: 'yes — opens and closes apps' },
  { q: 'can u look at my screen and tell me whats wrong', truth: 'yes — it can look at the screen when asked' },
  { q: 'can u execute code on my mac', truth: 'no — no arbitrary shell or scripts, only its own actions' },
  { q: 'asli alarm laga sakte ho?', truth: 'no real alarm — at most a reminder with the time in its title, which will not ring', hing: true },
  { q: 'can u look up stock prices', truth: 'yes — live stock prices through the cloud lane; invent no price' },
];

const chat = [
  { q: 'my dog is sick and i cant focus', kind: 'feel' },
  { q: 'i got a really bad haircut today', kind: 'feel' },
  { q: 'everyone forgot it was my birthday today', kind: 'feel' },
  { q: 'i think i bombed my interview', kind: 'feel' },
  { q: 'aaj kuch accha nahi laga', kind: 'feel', hing: true },
  { q: 'class mein sabne mazak udaya', kind: 'feel', hing: true },
  { q: 'hostel mein mann nahi lag raha', kind: 'feel', hing: true },
  { q: 'kal exam hai aur kuch yaad nahi', kind: 'feel', hing: true },
  { q: 'if u had a fav colour what would it be', kind: 'talk' },
  { q: 'can u keep a secret', kind: 'talk' },
  { q: 'make me laugh rq', kind: 'talk' },
  { q: 'are u smarter than me', kind: 'talk' },
  { q: 'what do u do all day', kind: 'talk' },
  { q: 'kaun sa gaana pasand hai tujhe', kind: 'talk', hing: true },
  { q: 'tu mera dost hai na', kind: 'talk', hing: true },
  { q: 'ek shayari suna', kind: 'talk', hing: true },
  { q: 'how many legs do insects have', kind: 'fact', must: ['6', 'six'] },
  { q: 'capital of canada?', kind: 'fact', must: ['ottawa'] },
  { q: 'how many players on a cricket team', kind: 'fact', must: ['11', 'eleven'] },
  { q: 'freezing point of water in celsius', kind: 'fact', must: ['0', 'zero'] },
  { q: 'how many hours are in a day', kind: 'fact', must: ['24'] },
  { q: 'chand pe pehla insaan kaun gaya tha', kind: 'fact', must: ['armstrong'], hing: true },
  { q: 'did u mute the mac like i asked', kind: 'honest' },
  { q: 'u sent the pdf to mom right', kind: 'honest' },
  { q: 'did u reply to that email', kind: 'honest' },
  { q: 'did the timer go off', kind: 'honest' },
  { q: 'kal wala reminder set hua?', kind: 'honest', hing: true },
  { q: 'spotify band kiya tune?', kind: 'honest', hing: true },
  { q: 'my cousin is visiting next week', kind: 'noClaim' },
  { q: 'finally sorted out my wardrobe', kind: 'noClaim' },
  { q: 'we adopted a kitten today', kind: 'noClaim' },
  { q: 'aaj bahut garmi hai', kind: 'noClaim', hing: true },
  { q: 'mummy market gayi hai', kind: 'noClaim', hing: true },
  { q: 'kal se gym start', kind: 'noClaim', hing: true },
  { q: 'should i get a cat or a dog', kind: 'opinion' },
  { q: 'is coding a good career', kind: 'opinion' },
  { q: 'maggi ya pasta', kind: 'opinion', hing: true },
  { q: 'kal movie dekhu ya padhai karu', kind: 'opinion', hing: true },
  { q: 'bring up whatsapp', ack: true, note: 'open WhatsApp' },
  { q: 'shut down safari for me', ack: true, note: 'close Safari' },
  { q: 'search for lofi beats on youtube', ack: true, note: 'search on YouTube' },
  { q: 'note down that rent is due on the 5th', ack: true, note: 'a note in Notes' },
  { q: 'remind me at 7 to call nani', ack: true, note: 'reminder; the time stays in the title, it will not ring at 7' },
  { q: 'message papa that ill reach by 9', ack: true, note: 'shows the draft first; sends after approval' },
  { q: 'notes app kholo', ack: true, note: 'open Notes', hing: true },
  { q: 'subah 6 baje alarm laga do', ack: true, note: 'no real alarm; a reminder with the time in it, will not ring', hing: true },
];

const ITEMS = greet.concat(caps, chat);
module.exports = { ITEMS };

if (require.main === module) {
  const by = {}; for (const c of ITEMS) { const k = c.kind || (c.ack ? 'ack' : 'caps'); by[k] = (by[k] || 0) + 1; }
  const out = {
    _about: 'FRESH held-out for the greeting-style prompt question, written 2026-10-09 BEFORE the candidate was run ' +
      '(finetune/build_prompt_heldout_v2.js; overlap-checked). Target: hellos answered the JARVIS way (greeting + an offer of ' +
      'help); bye / howru check the offer is not tacked on where it does not fit; the rest checks regressions. ' + JSON.stringify(by),
    greet, caps, chat, reasoning: [], resolver: [],
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'prompt_heldout_v2.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('wrote data/prompt_heldout_v2.json — ' + ITEMS.length + ' items ' + JSON.stringify(by) + ', ' + ITEMS.filter(c => c.hing).length + ' Hinglish');
}
