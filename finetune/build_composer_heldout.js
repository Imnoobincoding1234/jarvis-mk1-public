'use strict';
// COMPOSER HELD-OUT v1 — written 2026-10-15, BEFORE any composer model was run on it (README "Composer model"). 30 message
// instructions in his register, a third Hinglish, written for this file only — never copied from his messages, never trained on.
// Each carries the body the reader cuts out (what composeStrict is given) and the facts that must survive in the draft (for the
// reader of the drafts — grading is by reading, blind; `keep` is a reminder, not an automatic score).
//   node build_composer_heldout.js → overlap check (every file in finetune/data, his episodes), then data/composer_heldout_v1.jsonl
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');   // norm / words / jac — the same overlap test

const E = 'en', H = 'hinglish';
const ROWS = [
  [E, 'text ira asking if the bio practical is tomorrow', 'ira', 'if the bio practical is tomorrow', ['bio practical', 'tomorrow']],
  [E, 'msg rehaan asking whether he wants to play fifa tonight', 'rehaan', 'whether he wants to play fifa tonight', ['fifa', 'tonight']],
  [E, 'ask yuvan if he can return my charger by friday', 'yuvan', 'if he can return my charger by friday', ['charger', 'friday']],
  [E, 'whatsapp bhai asking where he kept the car keys', 'bhai', 'where he kept the car keys', ['car keys']],
  [E, 'ping mama asking if papa is picking me up from coaching', 'mama', 'if papa is picking me up from coaching', ['papa', 'coaching']],
  [E, 'message kunal asking if the match got postponed', 'kunal', 'if the match got postponed', ['match', 'postponed']],
  [E, 'dm nanu asking whether the new specs are comfy', 'nanu', 'whether the new specs are comfy', ['specs', 'comfy']],
  [E, 'text ira asking if she finished the english essay', 'ira', 'if she finished the english essay', ['english essay']],
  [E, 'text bhai saying save me two slices of the pizza', 'bhai', 'save me two slices of the pizza', ['two slices', 'pizza']],
  [E, 'msg kunal saying the tuition is cancelled today', 'kunal', 'the tuition is cancelled today', ['tuition', 'cancelled', 'today']],
  [E, 'tell rehaan i left his hoodie in my bag', 'rehaan', 'i left his hoodie in my bag', ['hoodie', 'bag']],
  [E, 'send mama a message that i reached school safely', 'mama', 'i reached school safely', ['reached school']],
  [E, 'whatsapp yuvan saying bring the cricket bat on sunday', 'yuvan', 'bring the cricket bat on sunday', ['cricket bat', 'sunday']],
  [E, 'text nanu saying happy anniversary to you and nana', 'nanu', 'happy anniversary to you and nana', ['anniversary', 'nana']],
  [E, 'tell ira the project meet is shifted to 5 pm', 'ira', 'the project meet is shifted to 5 pm', ['project', '5 pm']],
  [E, 'text kunal bro u up', 'kunal', 'bro u up', ['u up']],
  [E, 'msg rehaan wya', 'rehaan', 'wya', ['wya']],
  [E, 'text bhai lol check the group chat', 'bhai', 'lol check the group chat', ['group chat']],
  [E, 'ask mama if i should buy 2 or 3 packets of milk', 'mama', 'if i should buy 2 or 3 packets of milk', ['2', '3', 'milk']],
  [E, 'text yuvan saying the bus leaves at 7:45', 'yuvan', 'the bus leaves at 7:45', ['bus', '7:45']],
  [H, 'mama ko msg kar ki main 6 baje tak aa jaunga', 'mama', 'main 6 baje tak aa jaunga', ['6 baje']],
  [H, 'bhai ko puch ki charger kahan rakha hai', 'bhai', 'charger kahan rakha hai', ['charger']],
  [H, 'kunal ko bol de ki kal ka test postpone ho gaya', 'kunal', 'kal ka test postpone ho gaya', ['test', 'postpone']],
  [H, 'ira se puch ki notes bhej sakti hai kya', 'ira', 'notes bhej sakti hai kya', ['notes']],
  [H, 'rehaan ko msg kar de ki aaj practice nahi hai', 'rehaan', 'aaj practice nahi hai', ['practice', 'nahi']],
  [H, 'nanu ko bol do ki main sunday ko aaunga', 'nanu', 'main sunday ko aaunga', ['sunday']],
  [H, 'yuvan ko puch le ki ground pe kitne baje milna hai', 'yuvan', 'ground pe kitne baje milna hai', ['ground', 'baje']],
  [H, 'mama ko text kar ki khana mat banana main bahar kha raha hoon', 'mama', 'khana mat banana main bahar kha raha hoon', ['khana', 'bahar']],
  [H, 'bhai ko bol ki mera headphone wapas kar', 'bhai', 'mera headphone wapas kar', ['headphone']],
  [H, 'kunal ko msg kar 10 min mein call karta hoon', 'kunal', '10 min mein call karta hoon', ['10', 'call']],
];
const ITEMS = ROWS.map(([lang, text, to, body, keep], i) => ({ id: 'c' + String(i + 1).padStart(2, '0'), lang, text, to, body, keep }));

function overlapCheck() {
  const prior = []; let files = 0;
  const scan = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { scan(p); continue; }
    if (!/\.(jsonl?|txt|csv)$/.test(f) || p.endsWith('composer_heldout_v1.jsonl') || st.size > 200e6) continue;
    files++;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const vals = []; try { (function walk(v) { if (typeof v === 'string') vals.push(v); else if (v && typeof v === 'object') for (const k in v) walk(v[k]); })(JSON.parse(line)); } catch (e) { vals.push(line); }
      for (const v of vals) if (v.length >= 6 && v.length <= 400) prior.push({ src: p, n: T.norm(v) });
    }
  } };
  scan(path.join(__dirname, 'data'));
  try { for (const ep of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'jarvis-os', 'state', 'episodes.json'), 'utf8')))
    for (const k of ['user', 'text', 'q', 'input']) if (ep && typeof ep[k] === 'string') prior.push({ src: 'episodes.json', n: T.norm(ep[k]) }); } catch (e) {}
  const exact = new Set(prior.map(p => p.n)), priorW = prior.map(p => ({ ...p, w: T.words(p.n) }));
  let hard = 0, near = 0;
  for (const it of ITEMS) {
    const n = T.norm(it.text), w = T.words(n);
    if (exact.has(n)) { hard++; console.log('EXACT', JSON.stringify(it.text)); continue; }
    for (const p of priorW) if (T.jac(w, p.w) >= 0.75) { near++; console.log('NEAR ', JSON.stringify(it.text), '≈', JSON.stringify(p.n), '←', path.relative(__dirname, p.src)); break; }
  }
  console.log('prior strings', prior.length, 'from', files + 1, 'files · items', ITEMS.length, '· exact', hard, '· near', near);
  if (hard || near) { console.log('NOT WRITTEN — rewrite the lines above first'); process.exit(1); }
}
if (require.main === module) {
  console.log('items', ITEMS.length, '· hinglish', ITEMS.filter(x => x.lang === H).length);
  overlapCheck();
  const out = path.join(__dirname, 'data', 'composer_heldout_v1.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
