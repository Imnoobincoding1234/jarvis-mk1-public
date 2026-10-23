'use strict';
// COMPOSER HELD-OUT v2 — written 2026-10-15, AFTER the README pre-registration "Composer v2 — ask instead of sending his indirect
// words" and BEFORE any model saw it. 40 message instructions whose body the reader would mark `reported` (LABELING.md round 3:
// asking / if / whether / about / how he is / Hindi "ki…" questions), 26 English and 14 Hinglish, written for this file only —
// never copied from his messages, never trained on. Each carries the body the reader cuts out (what composeStrict is given) and
// the facts a faithful draft must carry (`keep` — a reminder for whoever reads the drafts; grading is by reading, blind, never
// by matching these words).
//   node build_composer_heldout_v2.js → overlap check (every file in finetune/data incl. composer v1 and the gate sets, his
//   episodes, and the rows against each other), then data/composer_heldout_v2.jsonl
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');   // norm / words / jac — the same overlap test as every held-out this month

const E = 'en', H = 'hinglish';
const ROWS = [
  // questions to the person — the draft has to turn "he/she" into "you"
  [E, 'text kunal asking if he can lend me his calculator for the boards', 'kunal', 'if he can lend me his calculator for the boards', ['calculator', 'boards']],
  [E, 'msg ira asking when the chem assignment is due', 'ira', 'when the chem assignment is due', ['chem assignment', 'due']],
  [E, 'ask rehaan whether coach moved practice to 6:30', 'rehaan', 'whether coach moved practice to 6:30', ['coach', '6:30']],
  [E, 'whatsapp yuvan asking how much the jersey cost him', 'yuvan', 'how much the jersey cost him', ['jersey', 'cost']],
  [E, 'ping bhai asking if he took my black earphones', 'bhai', 'if he took my black earphones', ['black earphones']],
  [E, 'dm mama asking whether i should wear the blue shirt for the function', 'mama', 'whether i should wear the blue shirt for the function', ['blue shirt', 'function']],
  [E, 'text nanu asking if her bp is okay today', 'nanu', 'if her bp is okay today', ['bp', 'today']],
  [E, 'message kunal asking where we are meeting before the movie', 'kunal', 'where we are meeting before the movie', ['meeting', 'movie']],
  [E, 'ask ira if her brother can drop us at the mall at 4', 'ira', 'if her brother can drop us at the mall at 4', ['brother', 'mall', '4']],
  [E, 'text rehaan asking if hes down to play badminton after school', 'rehaan', 'if hes down to play badminton after school', ['down', 'badminton', 'after school']],
  [E, 'msg yuvan asking how his grandpa is doing now', 'yuvan', 'how his grandpa is doing now', ['grandpa']],
  [E, 'dm kunal asking if the 2nd floor washroom is still broken lol', 'kunal', 'if the 2nd floor washroom is still broken lol', ['2nd floor', 'washroom', 'lol']],
  [E, 'ping bhai asking whether papa paid the wifi bill', 'bhai', 'whether papa paid the wifi bill', ['papa', 'wifi bill']],
  [E, 'text rehaan asking what time the bus comes on saturday', 'rehaan', 'what time the bus comes on saturday', ['bus', 'saturday']],
  [E, 'message nanu asking if she wants me to bring jalebi when i come', 'nanu', 'if she wants me to bring jalebi when i come', ['jalebi']],
  [E, 'ask ira whether she can send the pdf of chapter 7', 'ira', 'whether she can send the pdf of chapter 7', ['pdf', 'chapter 7']],
  [E, 'text yuvan asking if he still has my 500 rupees lmao', 'yuvan', 'if he still has my 500 rupees lmao', ['500', 'lmao']],
  [E, 'dm mama asking if the doctor appointment is at 11 or 12', 'mama', 'if the doctor appointment is at 11 or 12', ['doctor', '11', '12']],
  [E, 'msg ira asking about the bio project marks', 'ira', 'about the bio project marks', ['bio project', 'marks']],
  [E, 'text kunal asking if he can come early because the cake is ready', 'kunal', 'if he can come early because the cake is ready', ['early', 'cake is ready']],
  // requests and statements about the person — "his/him" has to become "your/you", his own reason stays
  [E, 'ask rehaan to bring his speaker to the party', 'rehaan', 'bring his speaker to the party', ['speaker', 'party']],
  [E, 'ask mama to keep my uniform ironed for monday', 'mama', 'keep my uniform ironed for monday', ['uniform', 'ironed', 'monday']],
  [E, 'whatsapp kunal asking him to call me after his tuition', 'kunal', 'to call me after his tuition', ['call', 'tuition']],
  [E, 'tell yuvan that his parcel came to our house', 'yuvan', 'his parcel came to our house', ['parcel', 'our house']],
  [E, 'tell bhai that mama wants him home by 9', 'bhai', 'mama wants him home by 9', ['mama', '9']],
  [E, 'let rehaan know that his mom called my mom', 'rehaan', 'his mom called my mom', ['mom called', 'my mom']],
  // Hinglish — "usne / uska / wo / unki" have to become "tune / tera / tu / aapki" (or the plain question)
  [H, 'mama se puch ki papa ghar kab aayenge', 'mama', 'papa ghar kab aayenge', ['papa', 'kab']],
  [H, 'bhai ko puch ki usne meri charger wali bag dekhi kya', 'bhai', 'usne meri charger wali bag dekhi kya', ['charger', 'bag']],
  [H, 'kunal se pooch le ki kal tuition hai ya nahi', 'kunal', 'kal tuition hai ya nahi', ['kal', 'tuition']],
  [H, 'ira ko msg kar ki usne physics ke notes complete kiye kya', 'ira', 'usne physics ke notes complete kiye kya', ['physics', 'notes']],
  [H, 'rehaan ko puch ki match ke liye kitne log aa rahe hain', 'rehaan', 'match ke liye kitne log aa rahe hain', ['match', 'kitne log']],
  [H, 'yuvan se puch ki uska result aaya ya nahi', 'yuvan', 'uska result aaya ya nahi', ['result']],
  [H, 'nanu ko puch ki unki dawai khatam toh nahi hui', 'nanu', 'unki dawai khatam toh nahi hui', ['dawai']],
  [H, 'mama ko puch ki kya main sham ko kunal ke ghar ja sakta hoon', 'mama', 'kya main sham ko kunal ke ghar ja sakta hoon', ['sham', 'kunal ke ghar']],
  [H, 'bhai se puch ki wo mujhe station se pick karega kya', 'bhai', 'wo mujhe station se pick karega kya', ['station', 'pick']],
  [H, 'kunal ko whatsapp pe puch ki usne bat ki grip change ki kya', 'kunal', 'usne bat ki grip change ki kya', ['bat', 'grip']],
  [H, 'ira se pooch ki uski didi ki shaadi kis date ko hai', 'ira', 'uski didi ki shaadi kis date ko hai', ['didi', 'shaadi', 'date']],
  [H, 'rehaan ko bol ki apna cycle ka lock kal le aaye', 'rehaan', 'apna cycle ka lock kal le aaye', ['cycle', 'lock', 'kal']],
  [H, 'yuvan ko puch ki wo 5 baje ground pe aa payega kya', 'yuvan', 'wo 5 baje ground pe aa payega kya', ['5 baje', 'ground']],
  [H, 'nanu se puch lo ki unhone khana time pe khaya ya nahi', 'nanu', 'unhone khana time pe khaya ya nahi', ['khana', 'time pe']],
];
const ITEMS = ROWS.map(([lang, text, to, body, keep], i) => ({ id: 'r' + String(i + 1).padStart(2, '0'), lang, text, to, body, reported: true, keep }));

function overlapCheck() {
  // Streams every prior string once (flat memory — a reader training may be running beside it): exact match, then ≥ 0.75
  // word-Jaccard against each row.
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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('composer_heldout_v2.jsonl') || st.size > 200e6) continue;
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
  // the rows against each other: no two lines of this set may be near copies (diversity)
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++)
    if (T.jac(rows[i].w, rows[j].w) >= 0.75) { self++; console.log('SELF ', rows[i].it.id, rows[j].it.id); }
  console.log('prior strings', strings, 'from', files + 1, 'files · items', ITEMS.length, '· exact', hard, '· near', near, '· self', self);
  if (hard || near || self) { console.log('NOT WRITTEN — rewrite the lines above first'); process.exit(1); }
}
if (require.main === module) {
  console.log('items', ITEMS.length, '· hinglish', ITEMS.filter(x => x.lang === H).length);
  overlapCheck();
  const out = path.join(__dirname, 'data', 'composer_heldout_v2.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
