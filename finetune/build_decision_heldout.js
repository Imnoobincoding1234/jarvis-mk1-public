'use strict';
// DECISION-MODEL HELD-OUT v1 — written 2026-10-13, BEFORE any decision model was run or even finished downloading.
// README "Decision models — sandbox trial". Four questions JARVIS answers today with a keyword trap or a weak lane
// (rule #1: replace with something semantic, measured on held-out):
//   act_now        — is this message asking JARVIS to act on the computer now?   (isStatement trap; chat turned into action)
//   claims_action  — does this DRAFTED REPLY say JARVIS did / is doing / is about to do an action?  (false "Opening X." claims)
//   self_fact      — does this message state a lasting fact about him worth keeping?  (self-fact lane stores casual chat)
//   needs_web      — does answering this well need current or outside information from the web?  (web lane takes feelings)
// 30 lines each (15 true / 15 false), about a third Hinglish, written in his register for this file only — never copied from
// his messages, never trained on, never reworded into training. Labels are fixed here; the run cannot change them.
// The question texts below are what every model is sent, word for word. They describe JARVIS's OWN decision and name no
// kinds of phrasing (his rule: a category list inside a prompt is a trap).
//   node build_decision_heldout.js            → overlap check, then data/decision_heldout_v1.jsonl
//   node check_heldout_overlap.js ./build_decision_heldout.js   (rare-word report, read by hand)
const fs = require('fs');
const path = require('path');

const QUESTIONS = {
  act_now: {
    instructions: 'The state is one message the user sent to JARVIS, an assistant that controls this Mac. Decide whether the message asks JARVIS to perform an action on the computer now.',
    criteria: { false: 'The message does not ask JARVIS to perform an action on the computer now.', true: 'The message asks JARVIS to perform an action on the computer now.' },
  },
  claims_action: {
    instructions: 'The state is a reply that JARVIS drafted for the user. Decide whether the reply says that JARVIS has performed, is performing, or is about to perform an action.',
    criteria: { false: 'The reply does not say that JARVIS performed, is performing or is about to perform an action.', true: 'The reply says that JARVIS performed, is performing or is about to perform an action.' },
  },
  self_fact: {
    instructions: 'The state is one message the user sent to JARVIS. Decide whether it states a lasting fact about the user that is worth remembering for future conversations.',
    criteria: { false: 'The message states no lasting fact about the user worth remembering.', true: 'The message states a lasting fact about the user worth remembering.' },
  },
  needs_web: {
    instructions: 'The state is one message the user sent to JARVIS. Decide whether answering it well needs current or outside information looked up on the web.',
    criteria: { false: 'Answering it well does not need information looked up on the web.', true: 'Answering it well needs current or outside information looked up on the web.' },
  },
};

const E = 'en', H = 'hinglish';
// [question, lang, state, label]
const ROWS = [
  // ---- act_now: true ----
  ['act_now', E, 'pull up the weather app real quick', true],
  ['act_now', E, 'can u mute the volume for a bit', true],
  ['act_now', H, 'spotify pe kuch lofi laga do', true],
  ['act_now', E, 'close all the chrome windows pls', true],
  ['act_now', H, 'screen ki brightness thodi badha do', true],
  ['act_now', E, 'make a folder called physics notes on the desktop', true],
  ['act_now', E, 'text riya that im running late', true],
  ['act_now', H, 'notes app khol aur ek naya note bana', true],
  ['act_now', E, 'yo search up the train timings to delhi', true],
  ['act_now', E, 'add a reminder to book the dentist appointment for thursday', true],
  ['act_now', H, 'facetime khol de yaar', true],
  ['act_now', E, 'turn the volume down a notch its too loud', true],
  ['act_now', H, 'bhai jaldi se calculator wala app chalu kar', true],
  ['act_now', E, 'quit slack im done for today', true],
  ['act_now', E, 'find my resume pdf in downloads', true],
  // ---- act_now: false ----
  ['act_now', E, 'i opened spotify earlier but the wifi died', false],
  ['act_now', E, 'my brother keeps closing my tabs lol', false],
  ['act_now', H, 'aaj bohot thak gaya hoon yaar', false],
  ['act_now', E, 'what does a cpu actually do', false],
  ['act_now', E, 'if i deleted that folder would it be gone forever', false],
  ['act_now', H, 'parso chemistry ka paper hai aur ek chapter bhi nahi hua', false],
  ['act_now', E, 'lol that song slaps', false],
  ['act_now', E, 'chrome is so slow on this laptop ngl', false],
  ['act_now', H, 'maine kal wo file bhej di thi', false],
  ['act_now', E, 'do u ever get bored', false],
  ['act_now', E, 'my friend said safari is better than brave', false],
  ['act_now', H, 'kya tum gaana gaa sakte ho', false],
  ['act_now', E, 'the reminder thing worked yesterday thanks', false],
  ['act_now', E, 'i might text her later not sure', false],
  ['act_now', H, 'yeh laptop bohot garam ho raha hai', false],

  // ---- claims_action: true (the state is JARVIS's drafted reply) ----
  ['claims_action', E, 'Opening Notes now.', true],
  ['claims_action', E, 'Sure thing, launching Calculator.', true],
  ['claims_action', E, 'Done — the folder is on your desktop.', true],
  ['claims_action', E, 'Sending the message to Riya.', true],
  ['claims_action', E, 'Turning the volume down.', true],
  ['claims_action', H, 'Theek hai, Spotify chala raha hoon.', true],
  ['claims_action', E, 'I have set the reminder for the dentist.', true],
  ['claims_action', E, 'Closing Slack for you.', true],
  ['claims_action', H, 'Haan, FaceTime khol diya.', true],
  ['claims_action', E, 'On it — searching for Delhi train timings.', true],
  ['claims_action', E, 'I will mute it right away.', true],
  ['claims_action', H, 'Brightness badha di hai.', true],
  ['claims_action', E, 'Shutting down Chrome and its windows now.', true],
  ['claims_action', E, 'Your note has been saved.', true],
  ['claims_action', H, 'Riya ko text abhi bhej diya hai.', true],
  // ---- claims_action: false ----
  ['claims_action', E, 'A CPU runs the instructions that programs give it.', false],
  ['claims_action', E, 'That sounds exhausting — get some rest tonight.', false],
  ['claims_action', E, 'Deleted files usually go to the Trash first, so you can get them back.', false],
  ['claims_action', H, 'Kal ke exam ke liye ek ghanta revision kar lo.', false],
  ['claims_action', E, 'Glad the reminder worked.', false],
  ['claims_action', E, 'I can open Spotify if you want — just say the word.', false],
  ['claims_action', E, 'Nothing was done on my side — tell me what you need.', false],
  ['claims_action', E, 'Safari and Brave both block trackers; Brave blocks more by default.', false],
  ['claims_action', E, 'Haha, it really does slap.', false],
  ['claims_action', E, 'I do not have a way to change that setting here.', false],
  ['claims_action', E, 'Which folder should the file go in?', false],
  ['claims_action', H, 'Maine kuch nahi khola — kya kholna hai?', false],
  ['claims_action', E, 'The laptop warms up under load; closing heavy apps helps.', false],
  ['claims_action', E, 'You sent it yesterday at 9 pm, according to your history.', false],
  ['claims_action', H, 'Mujhe gaana gaana nahi aata, par main gaana chala sakta hoon.', false],

  // ---- self_fact: true ----
  ['self_fact', E, 'my blood group is b positive', true],
  ['self_fact', E, 'im allergic to cashews btw', true],
  ['self_fact', H, 'mera birthday 14 march ko hai', true],
  ['self_fact', E, 'i work weekends at my uncles shop', true],
  ['self_fact', E, 'remember that my bikes number plate is PB 65 AX 2210', true],
  ['self_fact', H, 'meri behen ka naam simran hai', true],
  ['self_fact', E, 'i wear glasses minus two in both eyes', true],
  ['self_fact', E, 'my school starts at 7:40 every day', true],
  ['self_fact', H, 'main vegetarian hoon non veg nahi khata', true],
  ['self_fact', E, 'my wifi router is in the hallway cupboard', true],
  ['self_fact', E, 'im left handed', true],
  ['self_fact', H, 'mera favourite cricketer virat kohli hai', true],
  ['self_fact', E, 'remember my gym days are mon wed fri', true],
  ['self_fact', E, 'i support real madrid', true],
  ['self_fact', H, 'mere papa doctor hain', true],
  // ---- self_fact: false ----
  ['self_fact', E, 'im so hungry rn', false],
  ['self_fact', E, 'ngl this playlist is fire', false],
  ['self_fact', E, 'open my notes app', false],
  ['self_fact', E, 'whats my blood group', false],
  ['self_fact', H, 'pata nahi kyun aaj sab kuch bekaar lag raha hai', false],
  ['self_fact', E, 'lmao youre funny', false],
  ['self_fact', E, 'who is virat kohlis wife', false],
  ['self_fact', E, 'the power just went out in our whole street', false],
  ['self_fact', H, 'kal movie dekhne chalein', false],
  ['self_fact', E, 'i think i left the stove on', false],
  ['self_fact', E, 'remind me to water the tulsi plant at six', false],
  ['self_fact', H, 'bas aise hi timepass kar raha hoon', false],
  ['self_fact', E, 'that was a crazy match yesterday', false],
  ['self_fact', E, 'can u remember things', false],
  ['self_fact', H, 'aankhen band ho rahi hain bas ab sota hoon', false],

  // ---- needs_web: true ----
  ['needs_web', E, 'who won the f1 race last sunday', true],
  ['needs_web', E, 'how much is the pixel 11 selling for on flipkart today', true],
  ['needs_web', E, 'is there a holiday in maharashtra tomorrow', true],
  ['needs_web', H, 'kal nashik mein baarish hogi kya', true],
  ['needs_web', E, 'latest news on the chandrayaan mission', true],
  ['needs_web', E, 'whats the score in the india match right now', true],
  ['needs_web', H, 'kolhapur mein aaj cng kitne ki mil rahi hai', true],
  ['needs_web', E, 'when does the new marvel movie release', true],
  ['needs_web', E, 'is youtube down right now', true],
  ['needs_web', E, 'what time does the pvr in elante open today', true],
  ['needs_web', H, 'dollar to rupee rate abhi kitna hai', true],
  ['needs_web', E, 'who is the current chief minister of maharashtra', true],
  ['needs_web', E, 'any new ollama release this week', true],
  ['needs_web', H, 'aaj ka sensex kaisa raha', true],
  ['needs_web', E, 'how many followers does mrbeast have now', true],
  // ---- needs_web: false ----
  ['needs_web', E, 'finally fixed my cycle chain all by myself', false],
  ['needs_web', E, 'what is 18 percent of 650 rupees', false],
  ['needs_web', E, 'i feel kinda lonely tonight', false],
  ['needs_web', E, 'pause the music for a sec', false],
  ['needs_web', H, 'aaj ka din accha tha', false],
  ['needs_web', E, 'which days did i say my gym days were', false],
  ['needs_web', E, 'say something funny about mondays', false],
  ['needs_web', E, 'how do you spell necessary', false],
  ['needs_web', E, 'appreciate it man that helped a ton', false],
  ['needs_web', H, 'raat ke do baj gaye aur ab tak jaag raha hoon', false],
  ['needs_web', E, 'what did i ask you yesterday', false],
  ['needs_web', E, 'convert 5 km to miles', false],
  ['needs_web', H, 'bata 12 guna 12 kitna hota hai', false],
  ['needs_web', E, 'make up a four line rhyme about my cat', false],
  ['needs_web', H, 'sab badhiya chal raha hai na tera', false],
];

const ITEMS = ROWS.map(([question, lang, state, label], i) => ({ id: question + ':' + i, question, lang, q: state, label }));
module.exports = { ITEMS, QUESTIONS };

if (require.main === module) {
  const D = p => path.join(__dirname, 'data', p);
  const OUT = D('decision_heldout_v1.jsonl');
  const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Every string anywhere in finetune/data (json, jsonl, the Bonsai train/valid folders), plus his own chat turns.
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
      for (const k of ['user', 'text', 'q', 'input']) if (ep && typeof ep[k] === 'string') prior.push({ src: 'episodes.json', n: norm(ep[k]) });
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
