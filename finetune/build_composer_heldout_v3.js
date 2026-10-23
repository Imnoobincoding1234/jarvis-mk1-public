'use strict';
// COMPOSER HELD-OUT v3 — written 2026-10-19, BEFORE the "Composer v3" pre-registration's measurements and before any model saw
// it; the DECISION set for that trial (composer_heldout_v2 is read and is now the development set). 60 message instructions
// written for this file only — never copied from his messages, never trained on:
//   48 whose body the reader marks `reported` (questions with if / whether / when / what / where / how much, requests "ask X to …",
//      statements "tell X that his …", a third person inside, who-brings-what, times, numbers, his slang) — 32 English, 16 Hinglish;
//   12 plain controls (`reported: false`, the words to send are given) — the agent path composes those too, and a fix must not
//      bend them.
// Each row carries the body the reader cuts (what composeStrict is given) and the facts a faithful draft must carry (`keep` — a
// reminder for whoever reads the drafts; grading is by reading, blind, never by matching these words).
//   node build_composer_heldout_v3.js → overlap check (every file in finetune/data incl. composer v1/v2 and the gate sets, his
//   episodes, and the rows against each other), then data/composer_heldout_v3.jsonl
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');

const E = 'en', H = 'hinglish';
const R = [   // reported
  // yes / no questions about the person — the draft has to say "you"
  [E, 'text harsimran asking if she finished the bio diagram', 'harsimran', 'if she finished the bio diagram', ['bio diagram', 'finished']],
  [E, 'msg sidhu asking whether he still has my cricket bat', 'sidhu', 'whether he still has my cricket bat', ['cricket bat']],
  [E, 'dm ekamveer asking if hes coming to tuition tmrw', 'ekamveer', 'if hes coming to tuition tmrw', ['tuition', 'tmrw']],
  [E, 'ping parth asking if he charged the speaker', 'parth', 'if he charged the speaker', ['charged', 'speaker']],
  [E, 'ask bhai if he can pick me up from the metro at 8', 'bhai', 'if he can pick me up from the metro at 8', ['pick me up', 'metro', '8']],
  [E, 'text mama asking whether she needs anything from the market', 'mama', 'whether she needs anything from the market', ['market']],
  [E, 'whatsapp nanu asking if she took her evening medicine', 'nanu', 'if she took her evening medicine', ['evening medicine']],
  [E, 'message papa asking if he reached the office safe', 'papa', 'if he reached the office safe', ['office', 'safe']],
  // wh- questions
  [E, 'text parth asking which chapter the maths test is from', 'parth', 'which chapter the maths test is from', ['chapter', 'maths test']],
  [E, 'dm harsimran asking what she got in the english paper', 'harsimran', 'what she got in the english paper', ['english paper']],
  [E, 'msg sidhu asking where he parked the cycle', 'sidhu', 'where he parked the cycle', ['parked', 'cycle']],
  [E, 'ping ekamveer asking how much the tickets were for sunday', 'ekamveer', 'how much the tickets were for sunday', ['tickets', 'sunday']],
  [E, 'ask bhai what time hes leaving for the airport', 'bhai', 'what time hes leaving for the airport', ['airport', 'what time']],
  [E, 'text mama asking when dinner will be ready', 'mama', 'when dinner will be ready', ['dinner', 'ready']],
  [E, 'whatsapp parth asking who else is coming to the trek', 'parth', 'who else is coming to the trek', ['trek', 'who else']],
  [E, 'dm sidhu asking how long the practice went yesterday', 'sidhu', 'how long the practice went yesterday', ['practice', 'yesterday']],
  // requests — "ask X to …"
  [E, 'ask harsimran to send me the physics notes pdf', 'harsimran', 'to send me the physics notes pdf', ['physics notes', 'pdf']],
  [E, 'text bhai asking him to bring my hoodie when he comes', 'bhai', 'to bring my hoodie when he comes', ['hoodie']],
  [E, 'msg ekamveer asking him to save me a seat in the bus', 'ekamveer', 'to save me a seat in the bus', ['seat', 'bus']],
  [E, 'ping parth asking him to call me after 9', 'parth', 'to call me after 9', ['call', 'after 9']],
  [E, 'ask mama to keep my phone charger on the table', 'mama', 'to keep my phone charger on the table', ['charger', 'table']],
  // statements to pass on — "tell X that his …"
  [E, 'tell sidhu that his bag is still in my room', 'sidhu', 'that his bag is still in my room', ['bag', 'my room']],
  [E, 'let harsimran know that her book is with me', 'harsimran', 'that her book is with me', ['book', 'with me']],
  [E, 'tell parth that his song request got played fr', 'parth', 'that his song request got played fr', ['song request', 'played', 'fr']],
  [E, 'text papa that his parcel came at noon', 'papa', 'that his parcel came at noon', ['parcel', 'noon']],
  // a third person inside, who-brings-what, slang
  [E, 'ask ekamveer if his mom said yes for the sleepover', 'ekamveer', 'if his mom said yes for the sleepover', ['his mom', 'sleepover']],
  [E, 'text parth asking whether sidhu told him about the change in venue', 'parth', 'whether sidhu told him about the change in venue', ['sidhu', 'venue']],
  [E, 'msg harsimran asking if she should bring the speaker or if i should', 'harsimran', 'if she should bring the speaker or if i should', ['speaker', 'she or i']],
  [E, 'dm bhai asking if he wants maggi or should i make him a sandwich', 'bhai', 'if he wants maggi or should i make him a sandwich', ['maggi', 'sandwich']],
  [E, 'text sidhu asking if hes free rn or after dinner lol', 'sidhu', 'if hes free rn or after dinner lol', ['rn', 'after dinner', 'lol']],
  [E, 'ping ekamveer asking whether the match is at 4 or 4:30 bro', 'ekamveer', 'whether the match is at 4 or 4:30 bro', ['match', '4 or 4:30', 'bro']],
  [E, 'ask mama whether nani is staying for 2 days or 3', 'mama', 'whether nani is staying for 2 days or 3', ['nani', '2 days or 3']],
  // Hinglish — "… se puch ki …", "… ko bol ki …"
  [H, 'harsimran se puch ki usne project ka chart banaya kya', 'harsimran', 'usne project ka chart banaya kya', ['project', 'chart']],
  [H, 'sidhu ko msg kar ki kal subah gym chalega kya', 'sidhu', 'kal subah gym chalega kya', ['kal subah', 'gym']],
  [H, 'parth se pooch ki uske paas extra pen hai kya', 'parth', 'uske paas extra pen hai kya', ['extra pen']],
  [H, 'bhai se puch ki woh ghar kitne baje aayega', 'bhai', 'woh ghar kitne baje aayega', ['ghar', 'kitne baje']],
  [H, 'mama ko bata de ki mujhe aane mein der hogi saade 7 tak', 'mama', 'mujhe aane mein der hogi saade 7 tak', ['der', 'saade 7']],
  [H, 'ekamveer se puch ki uski cycle theek hui ya nahi', 'ekamveer', 'uski cycle theek hui ya nahi', ['cycle', 'theek']],
  [H, 'nanu se pooch ki unhone khana kha liya', 'nanu', 'unhone khana kha liya', ['khana']],
  [H, 'papa ko msg kar ki unki meeting kab khatam hogi', 'papa', 'unki meeting kab khatam hogi', ['meeting', 'kab']],
  [H, 'harsimran ko bol ki uski copy mere bag mein hai', 'harsimran', 'uski copy mere bag mein hai', ['copy', 'mere bag']],
  [H, 'sidhu se puch ki usne result dekha kya', 'sidhu', 'usne result dekha kya', ['result']],
  [H, 'parth ko bol ki uska charger mere paas reh gaya', 'parth', 'uska charger mere paas reh gaya', ['charger', 'mere paas']],
  [H, 'bhai se pooch ki woh mere liye chips laayega kya', 'bhai', 'woh mere liye chips laayega kya', ['chips', 'mere liye']],
  [H, 'ekamveer se puch ki movie 7 wali hai ya 9 wali', 'ekamveer', 'movie 7 wali hai ya 9 wali', ['movie', '7 ya 9']],
  [H, 'mama se puch ki aaj sabzi mein kya bana hai', 'mama', 'aaj sabzi mein kya bana hai', ['sabzi', 'aaj']],
  [H, 'harsimran ko msg kar ki uske bhai ne form bhara kya', 'harsimran', 'uske bhai ne form bhara kya', ['uske bhai', 'form']],
  [H, 'sidhu ko bol ki usko coach ne bulaya hai', 'sidhu', 'usko coach ne bulaya hai', ['coach', 'bulaya']],
];
const P = [   // plain controls — the words to send are given
  [E, 'text parth saying omw be there in 10', 'parth', 'omw be there in 10', ['omw', '10']],
  [E, 'msg harsimran saying thanks for the notes', 'harsimran', 'thanks for the notes', ['thanks', 'notes']],
  [E, 'tell bhai i took the car keys', 'bhai', 'i took the car keys', ['car keys']],
  [E, 'whatsapp sidhu saying gg that was a crazy match', 'sidhu', 'gg that was a crazy match', ['gg', 'crazy match']],
  [E, 'dm ekamveer saying cant come today sorry', 'ekamveer', 'cant come today sorry', ['cant come', 'sorry']],
  [E, 'text mama saying ill eat outside tonight', 'mama', 'ill eat outside tonight', ['eat outside', 'tonight']],
  [E, 'ping papa saying the wifi is down again', 'papa', 'the wifi is down again', ['wifi', 'down again']],
  [H, 'parth ko bol main neeche aa raha hoon', 'parth', 'main neeche aa raha hoon', ['neeche']],
  [H, 'mama ko msg kar khana mat banana aaj', 'mama', 'khana mat banana aaj', ['khana mat banana']],
  [H, 'sidhu ko bol bhai kal pakka', 'sidhu', 'bhai kal pakka', ['kal pakka']],
  [H, 'harsimran ko text kar thank you yaar', 'harsimran', 'thank you yaar', ['thank you yaar']],
  [H, 'bhai ko bol mera phone uthana', 'bhai', 'mera phone uthana', ['phone uthana']],
];
const ITEMS = R.map(([lang, text, to, body, keep], i) => ({ id: 'q' + String(i + 1).padStart(2, '0'), lang, text, to, body, reported: true, keep }))
  .concat(P.map(([lang, text, to, body, keep], i) => ({ id: 'p' + String(i + 1).padStart(2, '0'), lang, text, to, body, reported: false, keep })));

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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('composer_heldout_v3.jsonl') || st.size > 200e6) continue;
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
  const out = path.join(__dirname, 'data', 'composer_heldout_v3.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
