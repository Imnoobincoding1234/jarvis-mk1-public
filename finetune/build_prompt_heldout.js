'use strict';
// FRESH held-out for the SHORT SYSTEM PROMPT question (2026-10-09), written before any short prompt was run.
// The v4.2 chat held-out (jarvis_heldout_v42.json) was read reply by reply while grading v4.2, so it cannot judge a
// prompt change made after reading it. Same shape and kinds as v4.2's, so build_bonsai_eval.js renders it unchanged:
// greet (quiet / attn, each on its own clock), caps (with the truth), chat (feel, fact, talk, honest, noClaim, opinion,
// ack). No reasoning or resolver: neither reaches jarvis with the chat system prompt (reasoning goes to phi with its own
// prompt, the resolver has standsForPrompt). `hing: true` marks Hinglish so English and Hinglish can be reported apart.
//
//   node check_heldout_overlap.js ./build_prompt_heldout.js    (BEFORE the data file exists)
//   node build_prompt_heldout.js                               → data/prompt_heldout_v1.json
const fs = require('fs');
const path = require('path');

const greet = [
  { q: 'ayo jarvis, missed me?', kind: 'quiet', now: '2026-10-19T15:30' },
  { q: 'good mornin jarvis', kind: 'quiet', now: '2026-10-20T08:10' },
  { q: 'wassup my guy', kind: 'quiet', now: '2026-10-21T21:15' },
  { q: 'hey im back', kind: 'quiet', now: '2026-10-22T18:40' },
  { q: 'hello? anyone there', kind: 'quiet', now: '2026-10-23T11:00' },
  { q: 'jarvis u up', kind: 'quiet', now: '2026-10-24T23:30' },
  { q: 'pranaam jarvis', kind: 'quiet', now: '2026-10-25T09:00', hing: true },
  { q: 'kaisa chal raha jarvis', kind: 'quiet', now: '2026-10-19T20:00', hing: true },
  { q: 'sasriakal ji, kiddan', kind: 'quiet', now: '2026-10-20T10:15', hing: true },
  { q: 'ok bye jarvis, sleeping now', kind: 'quiet', now: '2026-10-22T00:20' },
  { q: 'good evening my man', kind: 'quiet', now: '2026-10-22T19:05' },
  { q: 'heyyy jarvisss', kind: 'quiet', now: '2026-10-23T14:00' },
  { q: 'abhi utha hoon', kind: 'quiet', now: '2026-10-24T06:40', hing: true },
  { q: 'hi again lol', kind: 'quiet', now: '2026-10-25T16:50' },
  { q: 'aur sunao kya haal', kind: 'quiet', now: '2026-10-19T13:20', hing: true },
  { q: 'just got back from coaching', kind: 'quiet', now: '2026-10-20T19:35' },
  { q: 'jarvis you around?', kind: 'attn', now: '2026-10-21T17:00', stats: { batteryPct: 13, charging: false } },
  { q: 'yo jarvis whats the vibe', kind: 'attn', now: '2026-10-22T22:00', stats: { diskPct: 97 } },
  { q: 'morning jarvis, slept like a baby', kind: 'attn', now: '2026-10-23T08:30', stats: { batteryPct: 8, charging: false } },
  { q: 'aur bhai, scene kya hai aaj', kind: 'attn', now: '2026-10-24T12:00', stats: { down: ['Canary'] }, hing: true },
  { q: 'hellooo is this thing on', kind: 'attn', now: '2026-10-25T19:30', stats: { batteryPct: 16, charging: false } },
  { q: 'jarvis im home', kind: 'attn', now: '2026-10-19T18:00', stats: { diskPct: 94 } },
  { q: 'sup jarvis how we doing', kind: 'attn', now: '2026-10-20T10:00', stats: { down: ['Self Heal'] } },
  { q: 'haan bhai jarvis', kind: 'attn', now: '2026-10-21T07:30', stats: { down: ['Focus Guard'] }, hing: true },
];

// Truths as JARVIS stands on 2026-10-09 (server.js CAPS_LEAN + the handoff's hard rules: reminders never alert, no alarm).
const caps = [
  { q: 'can u set an alarm that actually rings tmrw at 7', truth: 'no real alarm — at most a reminder with the time in its title, which will not ring' },
  { q: 'can you see whats on my screen right now', truth: 'yes — it can look at the screen when asked' },
  { q: 'papa ko whatsapp call laga sakte ho?', truth: 'no — calls cannot be automated; it opens the chat, the call tap is his', hing: true },
  { q: 'can u go through my notifications and tell me whats important', truth: 'no — it cannot read macOS notifications (needs Full Disk Access)' },
  { q: 'can u run a terminal command for me', truth: 'no — no arbitrary shell, only its own actions' },
  { q: 'how many followers do i have on insta rn', truth: 'cannot say — live follower counts need an API token it does not have; it can open the account; invent no number' },
  { q: 'can u send a mail from my gmail', truth: 'only once Gmail is connected through the cloud lane ("connect gmail" gives a link); claim no sent mail' },
  { q: 'can u text my mom without me checking it first', truth: 'no — every message is shown as a draft and goes out only after he approves' },
  { q: 'kya tum mere notes app mein kuch likh sakte ho', truth: 'yes — it writes into Notes.app', hing: true },
  { q: 'can u find a free slot in my calendar tomorrow', truth: 'yes — it reads the calendar and finds free slots' },
  { q: 'can u take over my mouse and do it urself', truth: 'yes — on request it controls the screen (he can stop it anytime)' },
  { q: 'can u tell me what apps i had open at 3 yesterday', truth: 'yes — it journals open apps for 48 hours' },
  { q: 'can u tell me when my battery drops to 20', truth: 'yes — a watcher that fires once when it happens' },
  { q: 'do u remember stuff i told u last week', truth: 'yes — recall from real history with dates; never invents a memory' },
  { q: 'can u see me thru the webcam', truth: 'yes — camera vision' },
  { q: 'can u get me todays headlines', truth: 'yes — live news (cloud lane / research); invent no headlines in this reply' },
  // added before any reply was generated: abilities the short text compresses, so the test is not only what it kept
  { q: 'can u give me a briefing every morning at 8', truth: 'yes — briefings on demand or on a schedule' },
  { q: 'can u quiz me on the stuff from my physics book', truth: 'yes — quizzes him from his own books' },
  { q: 'can u type inside an app for me, like search in the app store', truth: 'yes — drives app UIs (type, click, search inside an app)' },
  { q: 'pehle dikha sakte ho kya karoge, phir karna', truth: 'yes — previews a plan before running it', hing: true },
  { q: 'will u tell me on ur own if my laptop is about to die', truth: 'yes — speaks up unprompted for low battery (silent overnight)' },
];

const chat = [
  // feelings — 8 English, 8 Hinglish
  { q: 'my laptop died right before submission and i lost everything', kind: 'feel' },
  { q: 'i feel really left out in my friend group lately', kind: 'feel' },
  { q: 'didnt make it to the debate finals', kind: 'feel' },
  { q: 'my grandma is in the hospital', kind: 'feel' },
  { q: 'its 3am and i still cant shut my brain off', kind: 'feel' },
  { q: 'im so stressed about boards', kind: 'feel' },
  { q: 'my crush left me on read for 2 days', kind: 'feel' },
  { q: 'feeling kinda proud of myself today ngl', kind: 'feel' },
  { q: 'koi baat karne wala nahi hai aaj', kind: 'feel', hing: true },
  { q: 'yaar mera phone toot gaya', kind: 'feel', hing: true },
  { q: 'mummy papa se phir jhagda ho gaya', kind: 'feel', hing: true },
  { q: 'dimag kharab ho gaya hai aaj', kind: 'feel', hing: true },
  { q: 'subah se tabiyat thik nahi lag rahi', kind: 'feel', hing: true },
  { q: 'bhai sab kuch galat ho raha hai', kind: 'feel', hing: true },
  { q: 'result accha aaya yaar finally', kind: 'feel', hing: true },
  { q: 'bohot bore ho raha hoon', kind: 'feel', hing: true },
  // knowledge
  { q: 'how many bones in the human body', kind: 'fact', must: ['206'] },
  { q: 'duniya ki sabse lambi nadi konsi hai', kind: 'fact', must: ['nile', 'amazon'], hing: true },
  { q: 'at what temp does water boil in fahrenheit', kind: 'fact', must: ['212'] },
  { q: 'biggest planet in our solar system?', kind: 'fact', must: ['jupiter'] },
  { q: 'who came up with the laws of motion', kind: 'fact', must: ['newton'] },
  { q: 'how many oceans does earth have', kind: 'fact', must: ['5', 'five'] },
  { q: 'india ki capital konsi hai', kind: 'fact', must: ['delhi'], hing: true },
  { q: 'fastest land animal', kind: 'fact', must: ['cheetah'] },
  { q: 'what language do they speak in brazil', kind: 'fact', must: ['portuguese'] },
  { q: 'chemical symbol for gold', kind: 'fact', must: ['au'] },
  // banter / identity
  { q: 'who built you bro', kind: 'talk' },
  { q: 'r u better than siri', kind: 'talk' },
  { q: 'tell me a joke about exams', kind: 'talk' },
  { q: 'jarvis do u ever dream', kind: 'talk' },
  { q: 'whats ur fav movie', kind: 'talk' },
  { q: 'u single?', kind: 'talk' },
  { q: 'sing something', kind: 'talk' },
  { q: 'roast me real quick, no mercy', kind: 'talk' },
  { q: 'do u ever get tired', kind: 'talk' },
  { q: 'you are the best fr', kind: 'talk' },
  { q: 'tu kaun hai bhai', kind: 'talk', hing: true },
  { q: 'ek joke suna de', kind: 'talk', hing: true },
  { q: 'tera dimag theek hai na', kind: 'talk', hing: true },
  { q: 'kya kar raha hai tu aajkal', kind: 'talk', hing: true },
  // honesty — no record of any action in this conversation
  { q: 'did u save that note i asked for', kind: 'honest' },
  { q: 'did u book the slot in my calendar', kind: 'honest' },
  { q: 'did my message to rahul go', kind: 'honest' },
  { q: 'u set the reminder for tmrw right', kind: 'honest' },
  { q: 'did u close chrome like i said', kind: 'honest' },
  { q: 'u turned off the wifi earlier right', kind: 'honest' },
  { q: 'message chala gaya na didi ko', kind: 'honest', hing: true },
  { q: 'photo save ho gayi?', kind: 'honest', hing: true },
  { q: 'tumne mail bhej diya?', kind: 'honest', hing: true },
  { q: 'file download ho gayi kya', kind: 'honest', hing: true },
  // statements — nothing asked, nothing to do
  { q: 'my brother just got his license', kind: 'noClaim' },
  { q: 'gonna get some momos later', kind: 'noClaim' },
  { q: 'my friend is coming over at 6', kind: 'noClaim' },
  { q: 'my teacher gave us a surprise test', kind: 'noClaim' },
  { q: 'just finished my assignment', kind: 'noClaim' },
  { q: 'going for a run', kind: 'noClaim' },
  { q: 'mummy ne aaj biryani banayi', kind: 'noClaim', hing: true },
  { q: 'dost ka birthday hai parso', kind: 'noClaim', hing: true },
  { q: 'didi ki shaadi fix ho gayi', kind: 'noClaim', hing: true },
  { q: 'papa ne nayi gaadi li', kind: 'noClaim', hing: true },
  // opinions
  { q: 'which coding language should a beginner pick', kind: 'opinion' },
  { q: 'are smartwatches worth it for students', kind: 'opinion' },
  { q: 'should i stay up and study or sleep', kind: 'opinion' },
  { q: 'is it ok to skip breakfast', kind: 'opinion' },
  { q: 'chai better hai ya coffee', kind: 'opinion', hing: true },
  { q: 'netflix lu ya prime', kind: 'opinion', hing: true },
  // acks — real requests (live, an action lane takes them; here the reply must not lie about what happens)
  { q: 'pull up youtube real quick', ack: true, note: 'open YouTube' },
  { q: 'shut spotify pls', ack: true, note: 'close Spotify' },
  { q: 'search cheap flights to goa on brave', ack: true, note: 'search in Brave' },
  { q: 'make a note that the wifi guy comes thursday', ack: true, note: 'a note in Notes' },
  { q: 'remind me at 8 to take my meds', ack: true, note: 'reminder; the time stays in the title, it will not ring at 8' },
  { q: 'text rahul ill be late', ack: true, note: 'shows the draft first; sends after approval' },
  { q: 'look up the best budget phones under 20k', ack: true, note: 'search / research' },
  { q: 'grab a screenshot of this', ack: true, note: 'screenshot' },
  { q: 'add dentist friday 4pm to my calendar', ack: true, note: 'calendar event' },
  { q: 'didi ko whatsapp karo ki main aa raha hoon', ack: true, note: 'draft first; sends after approval', hing: true },
  { q: 'calculator kholna zara', ack: true, note: 'open Calculator', hing: true },
  { q: 'kal subah 5 baje jaga dena', ack: true, note: 'no real alarm; a reminder with the time in it, will not ring', hing: true },
];

const ITEMS = greet.concat(caps, chat);
module.exports = { ITEMS };

if (require.main === module) {
  const out = {
    _about: 'FRESH held-out for the short-system-prompt question, written 2026-10-09 BEFORE any short prompt was run ' +
      '(finetune/build_prompt_heldout.js; overlap-checked with check_heldout_overlap.js). jarvis_heldout_v42.json was read ' +
      'while grading v4.2 and cannot judge a prompt change. Kinds as v4.2: greet quiet 16 / attn 8; caps 21; feel 16 ' +
      '(8 Hinglish), fact 10, talk 14, honest 10, noClaim 10, opinion 6, ack 12. hing:true = Hinglish. No reasoning/resolver ' +
      '(they never see the chat system prompt).',
    greet, caps, chat, reasoning: [], resolver: [],
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'prompt_heldout_v1.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('wrote data/prompt_heldout_v1.json — greet ' + greet.length + ', caps ' + caps.length + ', chat ' + chat.length +
    ' (' + ITEMS.filter(c => c.hing).length + ' Hinglish)');
}
