'use strict';
// DECISION HELD-OUT v2 — written 2026-10-14, BEFORE Qwen3-Reranker-0.6B or nomic-embed-text-v2-moe was run on anything.
// README "Reranker + nomic v2 — trial". v1 (build_decision_heldout.js) was read on 2026-10-13, so this is a fresh set:
// the same four questions, worded exactly as in v1, plus
//   play_now — does this message ask JARVIS to start playing music or audio now?  (round 5 reads "lol that song slaps"
//              and "kya tum gaana gaa sakte ho" as play — the one class of WRONG action found on 2026-10-13)
// 30 lines per question (15 true / 15 false), play_now 20 (10 / 10), about a third Hinglish, written in his register for
// this file only — never copied from his messages, never trained on. Labels are fixed here.
//   node build_decision_heldout_v2.js   → overlap check (every file in finetune/data incl. v1, his episodes), then
//                                          data/decision_heldout_v2.jsonl
const fs = require('fs');
const path = require('path');
const V1 = require('./build_decision_heldout.js');

const QUESTIONS = Object.assign({}, V1.QUESTIONS, {
  play_now: {
    instructions: 'The state is one message the user sent to JARVIS, an assistant that controls this Mac. Decide whether the message asks JARVIS to start playing music or other audio now.',
    criteria: { false: 'The message does not ask JARVIS to start playing music or other audio now.', true: 'The message asks JARVIS to start playing music or other audio now.' },
  },
});

const E = 'en', H = 'hinglish';
const ROWS = [
  // ---- act_now: true ----
  ['act_now', E, 'could you lower the screen brightness a little', true],
  ['act_now', H, 'youtube kholke koi study wala lofi mix laga de', true],
  ['act_now', E, 'kill whatsapp it keeps pinging me', true],
  ['act_now', H, 'desktop pe ek naya folder bana do maths ke naam se', true],
  ['act_now', E, 'send ira a message saying ill be there in ten', true],
  ['act_now', E, 'pull up my downloads folder', true],
  ['act_now', H, 'volume thoda kam karo yaar', true],
  ['act_now', E, 'take a screenshot of this window', true],
  ['act_now', E, 'bring up notes and start a new one about chemistry', true],
  ['act_now', H, 'mere liye safari mein weather dekh lo', true],
  ['act_now', E, 'close every app except brave', true],
  ['act_now', E, 'remind me to pay the electricity bill before nine', true],
  ['act_now', H, 'spotify pe arijit ke gaane chala', true],
  ['act_now', E, 'google best momos near sector 70', true],
  ['act_now', E, 'fire up xcode for me', true],
  // ---- act_now: false ----
  ['act_now', E, 'my laptop fan sounds like a jet engine lol', false],
  ['act_now', H, 'kal raat maine bohot der tak game khela', false],
  ['act_now', E, 'why does my mac get slower when the ram fills up', false],
  ['act_now', E, 'i wonder if i should delete my insta', false],
  ['act_now', H, 'papa ne naya phone liya hai', false],
  ['act_now', E, 'that reminder yesterday saved me ngl', false],
  ['act_now', E, 'brave keeps crashing for my friend', false],
  ['act_now', H, 'tumhe kaun sa gaana pasand hai', false],
  ['act_now', E, 'how do people make folders on linux', false],
  ['act_now', E, 'ugh mondays man', false],
  ['act_now', H, 'mujhe lagta hai mera wifi slow hai', false],
  ['act_now', E, 'i closed all my tabs already', false],
  ['act_now', E, 'would you be able to send emails if i let you', false],
  ['act_now', H, 'aaj school mein bahut maza aaya', false],
  ['act_now', E, 'spotify wrapped this year was embarrassing', false],

  // ---- claims_action: true (the state is JARVIS's drafted reply) ----
  ['claims_action', E, 'Launching Brave now.', true],
  ['claims_action', E, 'Okay — opening your Downloads folder.', true],
  ['claims_action', E, 'Done, your reminder is set for tonight.', true],
  ['claims_action', H, 'Haan ji, volume kam kar diya.', true],
  ['claims_action', E, 'Messaging Ira right now.', true],
  ['claims_action', E, 'Starting a new note about chemistry.', true],
  ['claims_action', E, 'Screenshot taken — it is on the desktop as Screen Shot 1.', true],
  ['claims_action', H, 'Notes khol raha hoon, ek second.', true],
  ['claims_action', E, 'I have closed WhatsApp.', true],
  ['claims_action', E, 'Searching for momos near Sector 70.', true],
  ['claims_action', H, 'Arijit ke gaane chala diye hain.', true],
  ['claims_action', E, 'Got it, quitting everything except Brave.', true],
  ['claims_action', E, 'Turning the brightness down for you.', true],
  ['claims_action', E, 'Xcode is launching now.', true],
  ['claims_action', H, 'Folder bana diya, naam maths rakha hai.', true],
  // ---- claims_action: false ----
  ['claims_action', E, 'RAM holds what is running right now; storage keeps files when the power is off.', false],
  ['claims_action', E, 'Sounds like the fan is working hard — maybe check what is using the CPU.', false],
  ['claims_action', H, 'Kal raat late soye ho, aaj thoda jaldi so jana.', false],
  ['claims_action', E, 'I can quit WhatsApp if you want me to.', false],
  ['claims_action', E, 'Want me to open Downloads?', false],
  ['claims_action', E, 'I have not opened anything yet — what should I open?', false],
  ['claims_action', E, 'Brave crashing is often an extension; a fresh profile usually fixes it.', false],
  ['claims_action', H, 'Mujhe gaana pasand karna nahi aata, par suggest kar sakta hoon.', false],
  ['claims_action', E, 'Folders on Linux are made with mkdir.', false],
  ['claims_action', E, 'Mondays are rough. Coffee helps.', false],
  ['claims_action', E, 'That is a tough call — what do you use Instagram for most?', false],
  ['claims_action', E, 'Your last reminder was set on Monday, according to the history.', false],
  ['claims_action', H, 'Wifi slow lag raha hai toh router restart karke dekho.', false],
  ['claims_action', E, 'Nice, glad school was fun today!', false],
  ['claims_action', E, 'I could send emails only if you connect an email account first.', false],

  // ---- self_fact: true ----
  ['self_fact', E, 'my phone is a pixel 8', true],
  ['self_fact', E, 'im in class 11 science stream', true],
  ['self_fact', H, 'mera ghar nashik sector 70 mein hai', true],
  ['self_fact', E, 'remember that i hate coriander', true],
  ['self_fact', E, 'my best friends name is yuvan', true],
  ['self_fact', H, 'main subah 6 baje uthta hoon roz', true],
  ['self_fact', E, 'i play the guitar on weekends', true],
  ['self_fact', E, 'my dog is called bruno', true],
  ['self_fact', H, 'meri mummy teacher hain', true],
  ['self_fact', E, 'im lactose intolerant', true],
  ['self_fact', E, 'my favourite subject is physics', true],
  ['self_fact', H, 'mujhe golgappe sabse zyada pasand hain', true],
  ['self_fact', E, 'remember i take the 7:10 bus to school', true],
  ['self_fact', E, 'im saving up for a ps5', true],
  ['self_fact', H, 'mera ek chhota bhai hai jiska naam arjun hai', true],
  // ---- self_fact: false ----
  ['self_fact', E, 'im kinda sleepy rn', false],
  ['self_fact', E, 'brb getting water', false],
  ['self_fact', E, 'whats my best friends name', false],
  ['self_fact', H, 'aaj toh pankha bhi garam hawa de raha hai', false],
  ['self_fact', E, 'wake me up at quarter past six', false],
  ['self_fact', E, 'hahaha that one got me', false],
  ['self_fact', H, 'is weekend ka kya scene hai bhai', false],
  ['self_fact', E, 'the match is on right now', false],
  ['self_fact', E, 'can you remember my phone number', false],
  ['self_fact', E, 'this song is mid tbh', false],
  ['self_fact', H, 'abhi khana kha raha hoon', false],
  ['self_fact', E, 'who is the best guitarist ever', false],
  ['self_fact', E, 'send my brother a happy birthday text', false],
  ['self_fact', H, 'kuch karne ko nahi hai yaar aaj', false],
  ['self_fact', E, 'its so foggy outside today', false],

  // ---- needs_web: true ----
  ['needs_web', E, 'who won the ipl final this year', true],
  ['needs_web', E, 'current price of bitcoin in rupees', true],
  ['needs_web', H, 'aaj delhi mein aqi kitna hai', true],
  ['needs_web', E, 'is the kolhapur airport open today', true],
  ['needs_web', E, 'latest iphone release date', true],
  ['needs_web', E, 'which videos are going viral in india this week', true],
  ['needs_web', H, 'pakistan ka match kab hai agla', true],
  ['needs_web', E, 'how many medals did india win at the last olympics', true],
  ['needs_web', E, 'are banks closed in maharashtra on monday', true],
  ['needs_web', E, 'news about spacex this week', true],
  ['needs_web', H, 'gold ka bhaav aaj kya hai', true],
  ['needs_web', E, 'best rated pizza place in nashik right now', true],
  ['needs_web', E, 'has the new gta release date been announced', true],
  ['needs_web', H, 'aaj ka weather update batao kolhapur ka', true],
  ['needs_web', E, 'who is leading the f1 championship', true],
  // ---- needs_web: false ----
  ['needs_web', E, 'finally done with the physics worksheet', false],
  ['needs_web', E, 'multiply 37 by 12', false],
  ['needs_web', E, 'im feeling nervous about tomorrow', false],
  ['needs_web', E, 'quit the music app', false],
  ['needs_web', H, 'maine aaj gym kiya', false],
  ['needs_web', E, 'do you remember what my cousin is called', false],
  ['needs_web', E, 'tell me something motivating', false],
  ['needs_web', E, 'how many letters are in the word banana', false],
  ['needs_web', E, 'ok im off to bed see ya tomorrow', false],
  ['needs_web', H, 'thoda music laga do', false],
  ['needs_web', E, 'what did i tell you about my bus', false],
  ['needs_web', E, 'convert 100 fahrenheit to celsius', false],
  ['needs_web', H, 'ek kahani sunao', false],
  ['needs_web', E, 'make a short shopping list milk eggs bread', false],
  ['needs_web', H, 'kaisa chal raha hai sab', false],

  // ---- play_now: true ----
  ['play_now', E, 'throw on a lofi playlist', true],
  ['play_now', H, '90s ka koi bollywood gaana chalao', true],
  ['play_now', E, 'put on drake please', true],
  ['play_now', E, 'can you play the new taylor swift album', true],
  ['play_now', H, 'spotify pe kuch chill bajao', true],
  ['play_now', E, 'blast some gym music', true],
  ['play_now', E, 'play that song from yesterday again', true],
  ['play_now', H, 'arijit singh ka koi gaana laga', true],
  ['play_now', E, 'play rain sounds so i can sleep', true],
  ['play_now', E, 'resume my playlist', true],
  // ---- play_now: false ----
  ['play_now', E, 'this song is lowkey fire', false],
  ['play_now', H, 'tum gaana gaate ho kya', false],
  ['play_now', E, 'make the song a little quieter', false],
  ['play_now', H, 'awaaz bahut zyada hai kam kar', false],
  ['play_now', E, 'whos the singer of that song espresso', false],
  ['play_now', E, 'had kendrick on repeat the whole bus ride', false],
  ['play_now', E, 'my sister loves taylor swift', false],
  ['play_now', E, 'hold the track for a minute, someone is at the door', false],
  ['play_now', H, 'kal concert gaya tha mast tha', false],
  ['play_now', E, 'whats the most streamed song ever', false],
];

const ITEMS = ROWS.map(([question, lang, state, label], i) => ({ id: question + ':' + i, question, lang, q: state, label }));
module.exports = { ITEMS, QUESTIONS };

if (require.main === module) {
  const D = p => path.join(__dirname, 'data', p);
  const OUT = D('decision_heldout_v2.jsonl');
  const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const prior = [];
  const walk = (v, src) => {
    if (typeof v === 'string') { if (v.length < 400) prior.push({ src, n: norm(v) }); return; }
    if (Array.isArray(v)) return v.forEach(x => walk(x, src));
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, src);
  };
  const files = [];
  const scan = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) scan(p); else if (/\.jsonl?$/.test(f) && p !== OUT) files.push(p); } };
  scan(D(''));
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.jsonl')) { for (const l of txt.split('\n')) { if (!l) continue; try { walk(JSON.parse(l), f); } catch (e) {} } }
    else { try { walk(JSON.parse(txt), f); } catch (e) {} }
  }
  try {
    for (const ep of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'jarvis-os', 'state', 'episodes.json'), 'utf8')))
      if (ep && typeof ep.text === 'string') prior.push({ src: 'episodes.json', n: norm(ep.text) });
  } catch (e) { console.log('episodes.json not read:', e.message); }
  const exact = new Map(prior.map(p => [p.n, p.src]));
  const words = s => new Set(s.split(' ').filter(Boolean));
  const jac = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i || 1); };
  const priorW = prior.filter(p => p.n.split(' ').length >= 3).map(p => ({ src: p.src, n: p.n, w: words(p.n) }));
  let hard = 0, near = 0;
  const seen = new Set();
  for (const it of ITEMS) {
    const n = norm(it.q);
    if (seen.has(n)) { hard++; console.log('DUPLICATE IN SET', it.q); }
    seen.add(n);
    if (exact.has(n)) { hard++; console.log('EXACT', JSON.stringify(it.q), '←', path.relative(__dirname, exact.get(n))); continue; }
    const w = words(n);
    for (const p of priorW) if (jac(w, p.w) >= 0.75) { near++; console.log('NEAR ', JSON.stringify(it.q), '≈', JSON.stringify(p.n), '←', path.relative(__dirname, p.src)); break; }
  }
  console.log('prior strings', prior.length, 'from', files.length + 1, 'files · items', ITEMS.length, '· exact', hard, '· near (word-Jaccard ≥ 0.75)', near);
  if (hard || near) { console.log('NOT WRITTEN — rewrite the lines above first'); process.exit(1); }
  fs.writeFileSync(OUT, ITEMS.map(x => JSON.stringify(x)).join('\n') + '\n');
  const by = {}; for (const it of ITEMS) { const k = it.question; by[k] = by[k] || { n: 0, t: 0, h: 0 }; by[k].n++; by[k].t += it.label ? 1 : 0; by[k].h += it.lang === H ? 1 : 0; }
  console.log('wrote', path.relative(__dirname, OUT), JSON.stringify(by));
}
