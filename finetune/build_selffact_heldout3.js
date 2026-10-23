'use strict';
// FRESH held-out #3 for the self-fact lane (2026-10-10, Atharv away on a trek), written BEFORE the candidate below was run.
// Why: the casual dev set (v1) and the one judged v2 run showed selffact.js V2 filing casual chat as durable facts about him
// and answering "Noted, Sir — I will remember that.": news of the day, compliments to JARVIS, a Punjabi greeting, a how-to
// question, a slang music request. #1 and #2 are written in a neat register ("i am allergic to peanuts"); this one is in HIS
// register (data/style_profile.md: lowercase, slang, Hinglish). No sentence from either casual stress set is used; the guard
// below refuses exact and near copies (word Jaccard ≥ 0.75) of both stress sets and of #1/#2.
//
// CANDIDATE (pre-registered): selffact.js EXEMPLARS_V3 = V2 plus regions that V2 has no place for — `other-event` (something
// that happened to him today; true now, not a standing fact), `other-ask` (a how-to or advice question to JARVIS), and
// casual sentences added to `other-chat` (greetings, compliments, reactions) and `other-request` (slang requests); feelings
// of the moment added to `transient`. New sentences only — none from #1–#3 or either stress set. Margin stays 0.02 (not tuned).
// SHIPS ONLY IF (sweeps/sweep_selffact3.js, one run):
//   on #3:      junk wrongly stored ≤ half of V2's, AND facts stored ≥ V2's − 2;
//   on #1 + #2: facts stored ≥ V2's − 1, AND junk wrongly stored ≤ V2's.
// Otherwise V2 stays and nothing changes.
//   node build_selffact_heldout3.js → data/selffact_heldout3.json
const fs = require('fs');
const path = require('path');
const store = [
  'im vegetarian btw', 'i stay in mohali', 'my bday is on 14 feb lol', 'i main jett in valorant', 'ngl i hate coffee',
  'i support csk', 'im in class 11', 'i wake up at 6 everyday', 'my fav singer is the weeknd', 'i cant stand horror movies',
  'my dog is a labrador named simba', 'i use an iphone 13', 'mera fav colour blue hai', 'main non veg nahi khata',
  'meri height 5 10 hai', 'i go to the gym on weekdays', 'im left footed', 'my best friend is parth', 'i usually sleep around 1',
  'i have asthma', 'my shoe size is 9', 'i speak punjabi at home', 'mujhe spicy khana pasand hai', 'im allergic to dust',
  'i dont drink cold drinks', 'my school starts at 8', 'i was born in chandigarh', 'my fav subject is physics',
  'i drive an activa', 'my papa runs a shop',
];
const skip = [
  // happened today
  'bro i just topped the class test', 'my phone fell in the pool today', 'my bus was late again smh', 'just finished my assignment finally',
  'my teacher yelled at me today', 'my cousin just landed in delhi', 'aaj school mein mazaa aaya', 'abhi abhi exam khatam hua',
  // feeling right now
  'ugh nothing to do today', 'lowkey hungry', 'feeling kinda low today', 'mood off hai yaar',
  // about JARVIS
  'ur lowkey smart ngl', 'bro ur kinda slow today', 'ur the goat fr', 'tu toh kamaal hai',
  // hello / bye
  'namaste ji', 'yo jarvis wassup', 'cya tmrw', 'good morning bhai',
  // requests
  'need some punjabi songs rn', 'put on some chill music', 'show me the cricket score', 'gimme a quick recipe for maggi', 'koi accha gaana laga',
  // questions
  'how do i stop procrastinating', 'whats the best way to learn guitar', 'why is the sky blue tho', 'kya tum mujhe yaad rakhte ho',
  // about the world
  'that movie was mid', 'the new iphone looks the same lol', 'india will win the series fr',
  // reactions
  'lmaooo dead', 'bruh moment', 'sahi hai', 'thats crazy', 'damn okay',
  // plans
  'gonna sleep early tonight', 'heading out with friends', 'calling papa in a bit',
];
module.exports = { store, skip };
if (require.main === module) {
  const words = s => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
  const jac = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n || 1); };
  const norm = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
  const others = [];
  for (const f of ['casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl'])
    for (const l of fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').split('\n')) if (l.trim()) others.push(JSON.parse(l).text);
  for (const f of ['selffact_heldout.json', 'selffact_heldout2.json']) { const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8')); others.push(...d.store, ...d.skip); }
  const SF = require('../jarvis-os/selffact.js');
  for (const list of Object.values(SF.EXEMPLARS_V2)) others.push(...list);
  const all = store.concat(skip); let bad = 0;
  if (new Set(all.map(norm)).size !== all.length) { console.log('duplicate inside #3'); bad++; }
  for (const s of all) for (const o of others) if (norm(s) === norm(o) || jac(s, o) >= 0.75) { console.log('collides: ' + JSON.stringify(s) + ' ~ ' + JSON.stringify(o)); bad++; }
  if (bad) { console.log(bad + ' collision(s) — rewrite them; nothing written'); process.exit(1); }
  fs.writeFileSync(path.join(__dirname, 'data', 'selffact_heldout3.json'), JSON.stringify({
    _about: 'FRESH held-out #3 for the self-fact lane, written 2026-10-10 BEFORE the V3 candidate ran; his casual register. ' +
      store.length + ' store / ' + skip.length + ' skip. Candidate and bar in finetune/build_selffact_heldout3.js.', store, skip }, null, 1) + '\n');
  console.log('wrote data/selffact_heldout3.json — ' + store.length + ' store, ' + skip.length + ' skip; 0 collisions with ' + others.length + ' lines');
}
