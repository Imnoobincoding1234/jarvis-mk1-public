'use strict';
// COMPOSER HELD-OUT v5 — written 2026-10-22, BEFORE the "Composer C2-2k" pre-registration's measurements and before any model
// saw it; the DECISION set for C2 at a 2048 context (v2–v4 are read — development only). 60 message instructions written for this file only — never copied from his messages, never trained on:
//   40 whose body the reader marks `reported` (questions with if / whether / when / what / where / how much, requests "ask X to …",
//      statements "tell X that his …", a third person inside, who-brings-what, times, numbers, his slang) — 24 English, 16 Hinglish;
//   20 plain controls (12 English, 8 Hinglish) (`reported: false`, the words to send are given) — the agent path composes those too, and a fix must not
//      bend them.
// Each row carries the body the reader cuts (what composeStrict is given) and the facts a faithful draft must carry (`keep` — a
// reminder for whoever reads the drafts; grading is by reading, blind, never by matching these words).
//   node build_composer_heldout_v3.js → overlap check (every file in finetune/data incl. composer v1–v4 and the gate sets, his
//   episodes, and the rows against each other), then data/composer_heldout_v5.jsonl
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');

const E = 'en', H = 'hinglish';
const R = [   // reported
  [E, 'text parth asking if he finished the english essay', 'parth', 'if he finished the english essay', ['english essay', 'finished']],
  [E, 'msg harsimran asking whether her laptop is working again', 'harsimran', 'whether her laptop is working again', ['laptop', 'working again']],
  [E, 'dm sidhu asking if he can lend me his studs for the match', 'sidhu', 'if he can lend me his studs for the match', ['studs', 'match']],
  [E, 'ping ekamveer asking whether the canteen is open on saturday', 'ekamveer', 'whether the canteen is open on saturday', ['canteen', 'saturday']],
  [E, 'ask mama if she wants me to pick up the clothes from the dry cleaner', 'mama', 'if she wants me to pick up the clothes from the dry cleaner', ['clothes', 'dry cleaner']],
  [E, 'text papa asking whether the electrician is coming today', 'papa', 'whether the electrician is coming today', ['electrician', 'today']],
  [E, 'whatsapp nanu asking if she slept well last night', 'nanu', 'if she slept well last night', ['slept well', 'last night']],
  [E, 'message bhai asking where his old cricket kit is', 'bhai', 'where his old cricket kit is', ['old cricket kit']],
  [E, 'text harsimran asking what page the homework is on', 'harsimran', 'what page the homework is on', ['page', 'homework']],
  [E, 'dm ekamveer asking how far the new cafe is from school', 'ekamveer', 'how far the new cafe is from school', ['new cafe', 'school']],
  [E, 'msg parth asking which movie he picked for friday', 'parth', 'which movie he picked for friday', ['movie', 'friday']],
  [E, 'ask sidhu how much the gym membership costs per month', 'sidhu', 'how much the gym membership costs per month', ['gym membership', 'per month']],
  [E, 'ping bhai asking when his train reaches', 'bhai', 'when his train reaches', ['train', 'reaches']],
  [E, 'ask parth to send me the photos from the trip', 'parth', 'to send me the photos from the trip', ['photos', 'trip']],
  [E, 'text ekamveer asking him to bring his charger to class', 'ekamveer', 'to bring his charger to class', ['charger', 'class']],
  [E, 'msg mama asking her to wake me up at 6', 'mama', 'to wake me up at 6', ['wake me up', '6']],
  [E, 'tell harsimran that her earrings are on my desk', 'harsimran', 'that her earrings are on my desk', ['earrings', 'my desk']],
  [E, 'let papa know that the water tank is overflowing', 'papa', 'that the water tank is overflowing', ['water tank', 'overflowing']],
  [E, 'tell sidhu that his cousin called me', 'sidhu', 'that his cousin called me', ['his cousin', 'called me']],
  [E, 'ask ekamveer if his brother is still selling the cycle', 'ekamveer', 'if his brother is still selling the cycle', ['his brother', 'cycle']],
  [E, 'text parth asking whether harsimran added him to the group', 'parth', 'whether harsimran added him to the group', ['harsimran', 'group']],
  [E, 'msg sidhu asking if he wants fries or should i order nuggets', 'sidhu', 'if he wants fries or should i order nuggets', ['fries', 'nuggets']],
  [E, 'dm harsimran asking if shes coming to the fest tmrw lol', 'harsimran', 'if shes coming to the fest tmrw lol', ['fest', 'tmrw', 'lol']],
  [E, 'ping parth asking whether the quiz is at 10 or 11 bro', 'parth', 'whether the quiz is at 10 or 11 bro', ['quiz', '10 or 11', 'bro']],
  [H, 'ekamveer se puch ki usne mera hoodie dekha kya', 'ekamveer', 'usne mera hoodie dekha kya', ['hoodie']],
  [H, 'parth ko msg kar ki kal bus kitne baje aayegi', 'parth', 'kal bus kitne baje aayegi', ['kal', 'bus', 'kitne baje']],
  [H, 'sidhu se pooch ki uski practice kab shuru hogi', 'sidhu', 'uski practice kab shuru hogi', ['practice', 'kab']],
  [H, 'bhai se puch ki woh mere liye pen la dega kya', 'bhai', 'woh mere liye pen la dega kya', ['pen', 'mere liye']],
  [H, 'mama ko bol ki main aaj library mein padh raha hoon', 'mama', 'main aaj library mein padh raha hoon', ['library', 'aaj']],
  [H, 'harsimran se puch ki usne mere notes print kiye kya', 'harsimran', 'usne mere notes print kiye kya', ['notes', 'print']],
  [H, 'nanu se pooch ki unhone chai pi li', 'nanu', 'unhone chai pi li', ['chai']],
  [H, 'papa ko msg kar ki unki car ki chabi table pe hai', 'papa', 'unki car ki chabi table pe hai', ['car ki chabi', 'table']],
  [H, 'ekamveer ko bol ki uska wallet mere bag mein hai', 'ekamveer', 'uska wallet mere bag mein hai', ['wallet', 'mere bag']],
  [H, 'parth se puch ki usne exam form submit kiya kya', 'parth', 'usne exam form submit kiya kya', ['exam form', 'submit']],
  [H, 'harsimran ko bol ki uski mummy ne phone kiya tha', 'harsimran', 'uski mummy ne phone kiya tha', ['mummy', 'phone']],
  [H, 'bhai se pooch ki aaj raat movie dekhne chalein kya', 'bhai', 'aaj raat movie dekhne chalein kya', ['aaj raat', 'movie']],
  [H, 'ekamveer se puch ki tournament kis din hai', 'ekamveer', 'tournament kis din hai', ['tournament', 'kis din']],
  [H, 'mama se puch ki main dost ke saath mall ja sakta hoon kya', 'mama', 'main dost ke saath mall ja sakta hoon kya', ['dost ke saath', 'mall']],
  [H, 'parth ko msg kar ki uski behen ne ticket book ki kya', 'parth', 'uski behen ne ticket book ki kya', ['behen', 'ticket']],
  [H, 'sidhu ko bol ki uska helmet meri bike pe hai', 'sidhu', 'uska helmet meri bike pe hai', ['helmet', 'meri bike']],
];
const P = [   // plain controls — the words to send are given
  [E, 'text harsimran saying good luck for the test', 'harsimran', 'good luck for the test', ['good luck']],
  [E, 'msg parth saying be there in 2', 'parth', 'be there in 2', ['2']],
  [E, 'tell bhai the wifi password changed', 'bhai', 'the wifi password changed', ['wifi password']],
  [E, 'whatsapp papa saying ill call after class', 'papa', 'ill call after class', ['after class']],
  [E, 'dm sidhu saying that catch was unreal', 'sidhu', 'that catch was unreal', ['catch', 'unreal']],
  [E, 'ping ekamveer saying bring the ball', 'ekamveer', 'bring the ball', ['ball']],
  [E, 'whatsapp mama saying the bus dropped me near the park', 'mama', 'the bus dropped me near the park', ['near the park']],
  [E, 'msg nanu saying miss you nanu', 'nanu', 'miss you nanu', ['miss you']],
  [E, 'tell parth i sent the pdf', 'parth', 'i sent the pdf', ['pdf']],
  [E, 'text harsimran saying lunch at 1?', 'harsimran', 'lunch at 1?', ['lunch', '1']],
  [E, 'dm ekamveer saying haha true', 'ekamveer', 'haha true', ['haha true']],
  [E, 'ping bhai saying open the door', 'bhai', 'open the door', ['door']],
  [H, 'parth ko bol main gate pe khada hoon', 'parth', 'main gate pe khada hoon', ['gate']],
  [H, 'mama ko msg kar main thodi der mein aata hoon', 'mama', 'main thodi der mein aata hoon', ['thodi der']],
  [H, 'sidhu ko bol kal milte hain pakka', 'sidhu', 'kal milte hain pakka', ['kal', 'pakka']],
  [H, 'harsimran ko text kar assignment bhej diya', 'harsimran', 'assignment bhej diya', ['assignment']],
  [H, 'bhai ko bol mera headphone mat lena', 'bhai', 'mera headphone mat lena', ['headphone mat lena']],
  [H, 'ekamveer ko bol theek hai bhai done', 'ekamveer', 'theek hai bhai done', ['done']],
  [H, 'papa ko msg kar bijli wala aa gaya', 'papa', 'bijli wala aa gaya', ['bijli wala']],
  [H, 'nanu ko bol aap aaram karo', 'nanu', 'aap aaram karo', ['aaram karo']],
];
const ITEMS = R.map(([lang, text, to, body, keep], i) => ({ id: 'u' + String(i + 1).padStart(2, '0'), lang, text, to, body, reported: true, keep }))
  .concat(P.map(([lang, text, to, body, keep], i) => ({ id: 'w' + String(i + 1).padStart(2, '0'), lang, text, to, body, reported: false, keep })));

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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('composer_heldout_v5.jsonl') || st.size > 200e6) continue;
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
  const out = path.join(__dirname, 'data', 'composer_heldout_v5.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
