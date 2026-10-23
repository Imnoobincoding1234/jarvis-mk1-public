'use strict';
// COMPOSER HELD-OUT v4 — written 2026-10-22, BEFORE the "Composer C2" pre-registration's measurements and before any model saw
// it; the DECISION set for C2 (v2 and v3 are read — development only). 60 message instructions written for this file only — never copied from his messages, never trained on:
//   40 whose body the reader marks `reported` (questions with if / whether / when / what / where / how much, requests "ask X to …",
//      statements "tell X that his …", a third person inside, who-brings-what, times, numbers, his slang) — 24 English, 16 Hinglish;
//   20 plain controls (12 English, 8 Hinglish) (`reported: false`, the words to send are given) — the agent path composes those too, and a fix must not
//      bend them.
// Each row carries the body the reader cuts (what composeStrict is given) and the facts a faithful draft must carry (`keep` — a
// reminder for whoever reads the drafts; grading is by reading, blind, never by matching these words).
//   node build_composer_heldout_v3.js → overlap check (every file in finetune/data incl. composer v1/v2/v3 and the gate sets, his
//   episodes, and the rows against each other), then data/composer_heldout_v4.jsonl
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');

const E = 'en', H = 'hinglish';
const R = [   // reported
  [E, 'text rehaan asking if he returned the library book', 'rehaan', 'if he returned the library book', ['library book', 'returned']],
  [E, 'msg kunal asking whether his phone screen got fixed', 'kunal', 'whether his phone screen got fixed', ['phone screen', 'fixed']],
  [E, 'dm ira asking if she can share her chem formulas sheet', 'ira', 'if she can share her chem formulas sheet', ['chem formulas sheet']],
  [E, 'ping yuvan asking if hes bringing the football tmrw', 'yuvan', 'if hes bringing the football tmrw', ['football', 'tmrw']],
  [E, 'ask papa if he can transfer the fees before friday', 'papa', 'if he can transfer the fees before friday', ['fees', 'before friday']],
  [E, 'text mama asking whether i should buy milk on the way back', 'mama', 'whether i should buy milk on the way back', ['milk', 'way back']],
  [E, 'whatsapp nanu asking if her knee pain is better now', 'nanu', 'if her knee pain is better now', ['knee pain']],
  [E, 'message bhai asking where he kept the hdmi cable', 'bhai', 'where he kept the hdmi cable', ['hdmi cable']],
  [E, 'text kunal asking what time the farewell starts', 'kunal', 'what time the farewell starts', ['farewell', 'what time']],
  [E, 'dm rehaan asking how many overs we are playing', 'rehaan', 'how many overs we are playing', ['overs']],
  [E, 'msg ira asking which bus she takes after class', 'ira', 'which bus she takes after class', ['bus', 'after class']],
  [E, 'ask yuvan how much he paid for the shoes', 'yuvan', 'how much he paid for the shoes', ['shoes', 'how much']],
  [E, 'ping bhai asking when his exam ends', 'bhai', 'when his exam ends', ['exam', 'ends']],
  [E, 'ask ira to bring my calculator back tmrw', 'ira', 'to bring my calculator back tmrw', ['calculator', 'tmrw']],
  [E, 'text rehaan asking him to wait at the gate for 5 min', 'rehaan', 'to wait at the gate for 5 min', ['gate', '5 min']],
  [E, 'msg papa asking him to get a phone cover from the shop', 'papa', 'to get a phone cover from the shop', ['phone cover', 'shop']],
  [E, 'tell yuvan that his jersey number is 17 now', 'yuvan', 'that his jersey number is 17 now', ['jersey number', '17']],
  [E, 'let mama know that my bus is stuck in traffic', 'mama', 'that my bus is stuck in traffic', ['bus', 'traffic']],
  [E, 'tell kunal that his headphones are in my locker', 'kunal', 'that his headphones are in my locker', ['headphones', 'locker']],
  [E, 'ask rehaan if his dad can drive us to the stadium', 'rehaan', 'if his dad can drive us to the stadium', ['his dad', 'stadium']],
  [E, 'text ira asking whether kunal already booked the court', 'ira', 'whether kunal already booked the court', ['kunal', 'court']],
  [E, 'msg yuvan asking if he wants the window seat or should i take it', 'yuvan', 'if he wants the window seat or should i take it', ['window seat', 'he or i']],
  [E, 'dm kunal asking if hes up for valorant tonight bro', 'kunal', 'if hes up for valorant tonight bro', ['valorant', 'tonight', 'bro']],
  [E, 'ping bhai asking whether the pizza is for 7 or 8 people lol', 'bhai', 'whether the pizza is for 7 or 8 people lol', ['pizza', '7 or 8', 'lol']],
  [H, 'kunal se puch ki usne mera tiffin dekha kya', 'kunal', 'usne mera tiffin dekha kya', ['tiffin']],
  [H, 'rehaan ko msg kar ki kal net practice hai kya', 'rehaan', 'kal net practice hai kya', ['kal', 'net practice']],
  [H, 'ira se pooch ki uski tuition kitne baje khatam hoti hai', 'ira', 'uski tuition kitne baje khatam hoti hai', ['tuition', 'kitne baje']],
  [H, 'bhai se puch ki woh mujhe market le jayega kya', 'bhai', 'woh mujhe market le jayega kya', ['market']],
  [H, 'mama ko bol ki main dost ke ghar ruk raha hoon raat ko', 'mama', 'main dost ke ghar ruk raha hoon raat ko', ['dost ke ghar', 'raat']],
  [H, 'yuvan se puch ki usne mera project folder bheja kya', 'yuvan', 'usne mera project folder bheja kya', ['project folder']],
  [H, 'nanu se pooch ki unki aankh ka checkup kab hai', 'nanu', 'unki aankh ka checkup kab hai', ['aankh', 'checkup']],
  [H, 'papa ko msg kar ki unka laptop charger mere bag mein hai', 'papa', 'unka laptop charger mere bag mein hai', ['laptop charger', 'mere bag']],
  [H, 'ira ko bol ki uska umbrella car mein reh gaya', 'ira', 'uska umbrella car mein reh gaya', ['umbrella', 'car']],
  [H, 'rehaan se puch ki usne fees jama kar di kya', 'rehaan', 'usne fees jama kar di kya', ['fees']],
  [H, 'kunal ko bol ki usko sir ne staffroom mein bulaya', 'kunal', 'usko sir ne staffroom mein bulaya', ['sir', 'staffroom']],
  [H, 'bhai se pooch ki aaj dinner mein bahar chalein kya', 'bhai', 'aaj dinner mein bahar chalein kya', ['dinner', 'bahar']],
  [H, 'yuvan se puch ki match kis ground pe hai', 'yuvan', 'match kis ground pe hai', ['match', 'ground']],
  [H, 'mama se puch ki main kal late aa sakta hoon kya', 'mama', 'main kal late aa sakta hoon kya', ['kal', 'late']],
  [H, 'ira ko msg kar ki uski didi ne cake order kiya kya', 'ira', 'uski didi ne cake order kiya kya', ['didi', 'cake']],
  [H, 'rehaan ko bol ki uska bat mere ghar pe pada hai', 'rehaan', 'uska bat mere ghar pe pada hai', ['bat', 'mere ghar']],
];
const P = [   // plain controls — the words to send are given
  [E, 'text kunal saying reached home safe', 'kunal', 'reached home safe', ['reached home']],
  [E, 'msg ira saying cool see you at 5', 'ira', 'cool see you at 5', ['5']],
  [E, 'tell rehaan the auto broke down so ill be there by half past', 'rehaan', 'the auto broke down so ill be there by half past', ['auto broke down', 'half past']],
  [E, 'whatsapp mama saying dont wait up for me', 'mama', 'dont wait up for me', ['wait up']],
  [E, 'dm yuvan saying bro that goal was insane', 'yuvan', 'bro that goal was insane', ['goal', 'insane']],
  [E, 'ping bhai saying grab some chips on your way', 'bhai', 'grab some chips on your way', ['chips']],
  [E, 'text papa saying the car needs petrol', 'papa', 'the car needs petrol', ['petrol']],
  [E, 'msg nanu saying happy birthday nanu love you', 'nanu', 'happy birthday nanu love you', ['happy birthday']],
  [E, 'tell ira i finished the slides', 'ira', 'i finished the slides', ['slides']],
  [E, 'text rehaan saying gym at 6 tmrw', 'rehaan', 'gym at 6 tmrw', ['gym', '6']],
  [E, 'dm kunal saying lol same', 'kunal', 'lol same', ['lol same']],
  [E, 'ping yuvan saying call me when free', 'yuvan', 'call me when free', ['call me']],
  [H, 'kunal ko bol main 5 min mein aa raha', 'kunal', 'main 5 min mein aa raha', ['5 min']],
  [H, 'mama ko msg kar main khana kha ke aaunga', 'mama', 'main khana kha ke aaunga', ['khana kha ke']],
  [H, 'rehaan ko bol scene set hai kal', 'rehaan', 'scene set hai kal', ['scene set', 'kal']],
  [H, 'ira ko text kar notes bhej diye', 'ira', 'notes bhej diye', ['notes bhej diye']],
  [H, 'bhai ko bol mera charger wapas de', 'bhai', 'mera charger wapas de', ['charger wapas']],
  [H, 'yuvan ko bol chal theek hai milte hain', 'yuvan', 'chal theek hai milte hain', ['milte hain']],
  [H, 'papa ko msg kar gaadi garage mein hai', 'papa', 'gaadi garage mein hai', ['garage']],
  [H, 'nanu ko bol aap dawai le lena time pe', 'nanu', 'aap dawai le lena time pe', ['dawai', 'time pe']],
];
const ITEMS = R.map(([lang, text, to, body, keep], i) => ({ id: 's' + String(i + 1).padStart(2, '0'), lang, text, to, body, reported: true, keep }))
  .concat(P.map(([lang, text, to, body, keep], i) => ({ id: 't' + String(i + 1).padStart(2, '0'), lang, text, to, body, reported: false, keep })));

function overlapCheck() {
  const rows = ITEMS.map(it => ({ it, n: T.norm(it.text), w: T.words(T.norm(it.text)), hit: null }));
  let files = 0, strings = 0;
  const test = (v, src) => {
    if (v.length < 6 || v.length > 400) return;
    strings++;
    const n = T.norm(v); let w = null;
    for (const r of rows) {
      if (r.hit && r.hit.kind === 'EXACT') continue;
      if (n === r.n) { r.hit = { kind: 'EXACT', n, src }; continue; }
      if (r.hit) continue;
      if (!w) w = T.words(n);
      if (T.jac(r.w, w) >= 0.75) r.hit = { kind: 'NEAR', n, src };
    }
  };
  const scan = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { scan(p); continue; }
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('composer_heldout_v4.jsonl') || st.size > 200e6) continue;
    files++;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const vals = []; try { (function walk(v) { if (typeof v === 'string') vals.push(v); else if (v && typeof v === 'object') for (const k in v) walk(v[k]); })(JSON.parse(line)); } catch (e) { vals.push(line); }
      for (const v of vals) test(v, p);
    }
  } };
  scan(path.join(__dirname, 'data'));
  try { for (const ep of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'jarvis-os', 'state', 'episodes.json'), 'utf8')))
    for (const k of ['user', 'text', 'q', 'input']) if (ep && typeof ep[k] === 'string') test(ep[k], 'episodes.json'); } catch (e) {}
  let hard = 0, near = 0, self = 0;
  for (const r of rows) if (r.hit) { r.hit.kind === 'EXACT' ? hard++ : near++;
    console.log(r.hit.kind.padEnd(5), JSON.stringify(r.it.text), '≈', JSON.stringify(r.hit.n), '←', path.relative(__dirname, r.hit.src)); }
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++)
    if (T.jac(rows[i].w, rows[j].w) >= 0.75) { self++; console.log('SELF ', rows[i].it.id, rows[j].it.id); }
  console.log('prior strings', strings, 'from', files + 1, 'files · items', ITEMS.length, '· exact', hard, '· near', near, '· self', self);
  if (hard || near || self) { console.log('NOT WRITTEN — rewrite the lines above first'); process.exit(1); }
}
if (require.main === module) {
  console.log('items', ITEMS.length, '· reported', ITEMS.filter(x => x.reported).length, '· hinglish', ITEMS.filter(x => x.lang === H).length);
  overlapCheck();
  const out = path.join(__dirname, 'data', 'composer_heldout_v4.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
