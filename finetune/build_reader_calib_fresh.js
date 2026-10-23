// READER CALIBRATION — FRESH CONFIRMATION SET v1 (2026-10-16), written AFTER the README pre-registration "Round 7's confidence bar —
// calibration" and BEFORE any model read it. Everyday plain requests of every kind (where round 7 asked instead of acting), none-shapes,
// a few round-7 shapes (front pages, a reason after the request, `as`, ss) — no `when` for later; ≥ ⅓ Hinglish. Never copied from his
// messages, never trained on. Shape-checked by readmodel.shapeError; overlap-checked against every file in finetune/data and his episodes.
//   node build_reader_calib_fresh.js → data/reader_calib_fresh_v1.jsonl
'use strict';
// BONSAI READER HELD-OUT v1 — written 2026-10-15, AFTER the README pre-registration "Bonsai reader — 4B, then 1.7B, keep the best"
// (phase 2) and BEFORE any full Bonsai reader round. Chooses between the live round 5 and the Bonsai readers. Every act, the
// none-shapes, the round-7 shapes (when, front pages, reasons, `as` on close, music talk, someone's news, ss), multi; a third
// Hinglish or more. Written for this file only — never copied from his messages, never trained on. Labels follow LABELING.md
// and are checked by the reader's own shapeError (fields per act, every value his words); no `refers` keys (not graded here).
//   node build_bonsai_reader_heldout.js → shape check, overlap check (every file in finetune/data, his episodes, the rows
//   against each other), then data/reader_calib_fresh_v1.jsonl
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');   // norm / words / jac — the same overlap test
const RM = require('../jarvis-os/readmodel.js');

const E = 'en', H = 'hinglish';
const m = (to, body, x) => Object.assign({ act: 'message', to }, body ? { body } : {}, x || {});
const ROWS = [
  // messages — plain, the shape round 7 asked about
  [E, 'text harsimran saying bring the extension cord', m('harsimran', 'bring the extension cord')],
  [E, 'whatsapp sidhu saying im at the gate', m('sidhu', 'im at the gate')],
  [E, 'message nanu saying happy dussehra', m('nanu', 'happy dussehra')],
  [E, 'send parth a text that the lab is cancelled', m('parth', 'the lab is cancelled')],
  [E, 'dm ekamveer saying lmk if ur free', m('ekamveer', 'lmk if ur free')],
  [E, 'shoot bhai a text saying grab some ice cream', m('bhai', 'grab some ice cream')],
  [E, 'text mama saying reached the coaching centre safely', m('mama', 'reached the coaching centre safely')],
  [E, 'ask parth whether he finished the lab file', m('parth', 'whether he finished the lab file', { reported: true })],
  [E, 'message harsimran asking when the bus leaves tomorrow', m('harsimran', 'when the bus leaves tomorrow', { reported: true })],
  [E, 'whatsapp nanu that i love the sweater', m('nanu', 'i love the sweater')],
  [H, 'bhai ko msg kar ki gaadi saaf kar de', m('bhai', 'gaadi saaf kar de')],
  [H, 'sidhu ko whatsapp karo ki kal practice cancel hai', m('sidhu', 'kal practice cancel hai')],
  [H, 'mama ko text kar ki main thodi der mein aaunga', m('mama', 'main thodi der mein aaunga')],
  [H, 'parth ko bol de ki notes mere paas hain', m('parth', 'notes mere paas hain')],
  [H, 'harsimran ko msg bhej ki party kitne baje hai', m('harsimran', 'party kitne baje hai', { reported: true })],
  [H, 'nanu ko message karo aap kaise ho', m('nanu', 'aap kaise ho')],
  // calls
  [E, 'give mama a call right now', { act: 'call', to: 'mama' }],
  [E, 'facetime sidhu', { act: 'call', to: 'sidhu', where: 'facetime', video: true }],
  [E, 'whatsapp call sidhu bhaiya', { act: 'call', to: 'sidhu bhaiya', where: 'whatsapp' }],
  [H, 'nani ji ko call milao', { act: 'call', to: 'nani ji' }],
  [H, 'ekamveer ke saath video call laga', { act: 'call', to: 'ekamveer', video: true }],
  [H, 'mama ko phone laga do', { act: 'call', to: 'mama' }],
  // play
  [E, 'play blank space by taylor swift', { act: 'play', query: 'blank space by taylor swift' }],
  [E, 'put on some arijit songs', { act: 'play', query: 'some arijit songs' }],
  [E, 'play a funny video on youtube', { act: 'play', query: 'a funny video', where: 'youtube', video: true }],
  [E, 'watch the new mkbhd video', { act: 'play', query: 'the new mkbhd video', video: true }],
  [E, 'play lofi on spotify', { act: 'play', query: 'lofi', where: 'spotify' }],
  [E, 'play some old bollywood music', { act: 'play', query: 'some old bollywood music' }],
  [H, 'koi romantic gaana chalao', { act: 'play', query: 'koi romantic gaana' }],
  [H, 'youtube pe cricket highlights chala do', { act: 'play', query: 'cricket highlights', where: 'youtube', video: true }],
  [H, 'spotify pe diljit ke gaane lagao', { act: 'play', query: 'diljit ke gaane', where: 'spotify' }],
  [H, 'kuch sad songs bajao', { act: 'play', query: 'kuch sad songs' }],
  // open
  [E, 'pull up discord for me', { act: 'open', thing: 'discord' }],
  [E, 'open the zoom app', { act: 'open', thing: 'zoom', as: 'app' }],
  [E, 'fire up vlc', { act: 'open', thing: 'vlc' }],
  [E, 'bring up my yahoo mail', { act: 'open', thing: 'yahoo mail' }],
  [E, 'open github i need to check a pr', { act: 'open', thing: 'github' }],
  [E, 'open the instagram website', { act: 'open', thing: 'instagram', as: 'site' }],
  [H, 'whatsapp web khol de bhai', { act: 'open', thing: 'whatsapp web' }],
  [H, 'reminders wala app khol', { act: 'open', thing: 'reminders', as: 'app' }],
  [H, 'safari kholo jaldi', { act: 'open', thing: 'safari' }],
  [H, 'mera calendar khol de', { act: 'open', thing: 'calendar' }],
  // close
  [E, 'shut down the figma app for now', { act: 'close', thing: 'figma', as: 'app' }],
  [E, 'close the reminders app', { act: 'close', thing: 'reminders', as: 'app' }],
  [E, 'force quit chrome its stuck', { act: 'close', thing: 'chrome', force: true }],
  [H, 'zoom band kar de abhi', { act: 'close', thing: 'zoom' }],
  [H, 'teams ko band karo', { act: 'close', thing: 'teams' }],
  // search
  [E, 'search for noise cancelling headphones under 5000', { act: 'search_web', query: 'noise cancelling headphones under 5000' }],
  [E, 'google who won the last world cup', { act: 'search_web', query: 'who won the last world cup' }],
  [E, 'look up train timings to amritsar', { act: 'search_web', query: 'train timings to amritsar' }],
  [E, 'search youtube for beginner ukulele chords', { act: 'search_web', query: 'beginner ukulele chords', where: 'youtube' }],
  [H, 'google pe search karo petrol ka rate', { act: 'search_web', query: 'petrol ka rate' }],
  [H, 'amazon pe phone cover dhundo', { act: 'search_web', query: 'phone cover', where: 'amazon' }],
  [H, 'netflix pe koi thriller dhundo', { act: 'search_web', query: 'koi thriller', where: 'netflix' }],
  // remind, calendar, weather, time, note, screenshot
  [E, 'remind me to pay the electricity bill at 5', { act: 'remind', what: 'pay the electricity bill', when: 'at 5' }],
  [E, 'remind me tomorrow to call the plumber', { act: 'remind', what: 'call the plumber', when: 'tomorrow' }],
  [E, 'set a reminder to take my vitamins', { act: 'remind', what: 'take my vitamins' }],
  [H, 'kal shaam ko yaad dilana ki dhobi ko kapde dene hain', { act: 'remind', what: 'dhobi ko kapde dene hain', when: 'kal shaam ko' }],
  [H, 'mujhe 7 baje yaad dilana homework karna hai', { act: 'remind', what: 'homework karna hai', when: '7 baje' }],
  [E, 'anything booked on my calendar this afternoon', { act: 'calendar', when: 'this afternoon' }],
  [E, 'do i have anything on monday', { act: 'calendar', when: 'on monday' }],
  [H, 'kal ka plan kya hai mera', { act: 'calendar', when: 'kal' }],
  [E, 'will it be windy tomorrow', { act: 'weather', when: 'tomorrow' }],
  [E, 'whats the weather like in manali', { act: 'weather', where: 'manali' }],
  [H, 'aaj baarish ka chance hai kya', { act: 'weather', when: 'aaj' }],
  [E, 'whats the time in singapore rn', { act: 'time', where: 'singapore' }],
  [H, 'abhi time kya ho raha hai', { act: 'time' }],
  [E, 'note down buy batteries', { act: 'note', content: 'buy batteries' }],
  [H, 'notes mein likh lo milk khatam hai', { act: 'note', content: 'milk khatam hai' }],
  [E, 'grab an ss of this page', { act: 'screenshot' }],
  [H, 'screen grab kar lo', { act: 'screenshot' }],
  [E, 'close the slack app', { act: 'close', thing: 'slack', as: 'app' }],
  // none
  [E, 'i just got back from school', { act: 'none' }],
  [E, 'parth is coming over later', { act: 'none' }],
  [E, 'that video was hilarious', { act: 'none' }],
  [E, 'did you message mama', { act: 'none' }],
  [E, 'how do i set an alarm on my phone', { act: 'none' }],
  [E, 'i already opened spotify', { act: 'none' }],
  [E, 'whats the capital of mongolia', { act: 'none' }],
  [E, 'the hostel wifi keeps dropping', { act: 'none' }],
  [E, 'dont call anyone rn', { act: 'none' }],
  [E, 'mama said hi', { act: 'none' }],
  [E, 'i love this song', { act: 'none' }],
  [E, 'what should i eat for dinner', { act: 'none' }],
  [E, 'lol bro', { act: 'none' }],
  [E, 'im heading out now', { act: 'none' }],
  [E, 'tell me something funny about cats', { act: 'none' }],
  [E, 'who sang perfect', { act: 'none' }],
  [E, 'the game starts at 8', { act: 'none' }],
  [E, 'finally done with the chem worksheet', { act: 'none' }],
  [E, 'sidhu is so funny', { act: 'none' }],
  [E, 'appreciate it jarvis, that helped', { act: 'none' }],
  [E, 'ok im off to bed now, night', { act: 'none' }],
  [H, 'chhota bhai tuition se aa gaya', { act: 'none' }],
  [H, 'mama ne khana bana diya', { act: 'none' }],
  [H, 'kya tum gaana bajate ho', { act: 'none' }],
  [H, 'aaj bohot thak gaya', { act: 'none' }],
  [H, 'parth ka msg aaya tha', { act: 'none' }],
  [H, 'ye gaana mast hai', { act: 'none' }],
  [H, 'kal school jaana hai', { act: 'none' }],
  [H, 'bas aise hi baat kar raha tha', { act: 'none' }],
  [H, 'haha sahi hai', { act: 'none' }],
  [H, 'spotify mat kholna', { act: 'none' }],
  [H, 'aur sunao kya chal raha hai aajkal', { act: 'none' }],
  [H, 'aankhein band ho rahi hain thak ke', { act: 'none' }],
];
const ITEMS = ROWS.map(([lang, text, label], i) => ({ id: 'k' + String(i + 1).padStart(3, '0'), lang, text, label }));

function shapeCheck() {
  let bad = 0;
  for (const it of ITEMS) {
    const steps = it.label.act === 'multi' ? it.label.steps : [it.label];
    for (const st of steps) { const e = RM.shapeError(it.text, st); if (e) { bad++; console.log('SHAPE', it.id, JSON.stringify(it.text), JSON.stringify(st), '→', e); } }
  }
  console.log('shape errors', bad);
  if (bad) { console.log('NOT WRITTEN — fix the labels above first'); process.exit(1); }
}

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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('reader_calib_fresh_v1.jsonl') || st.size > 200e6) continue;
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
    console.log(r.hit.kind.padEnd(5), r.it.id, JSON.stringify(r.it.text), '≈', JSON.stringify(r.hit.n), '←', path.relative(__dirname, r.hit.src)); }
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++)
    if (T.jac(rows[i].w, rows[j].w) >= 0.75) { self++; console.log('SELF ', rows[i].it.id, rows[j].it.id); }
  console.log('prior strings', strings, 'from', files + 1, 'files · items', ITEMS.length, '· exact', hard, '· near', near, '· self', self);
  if (hard || near || self) { console.log('NOT WRITTEN — rewrite the lines above first'); process.exit(1); }
}

if (require.main === module) {
  const acts = new Set(ITEMS.map(x => x.label.act));
  console.log('items', ITEMS.length, '· hinglish', ITEMS.filter(x => x.lang === H).length, '· acts', acts.size, '· missing acts',
    RM.ACTS.filter(a => !acts.has(a)).join(' ') || '–');
  shapeCheck();
  overlapCheck();
  const out = path.join(__dirname, 'data', 'reader_calib_fresh_v1.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify({ text: x.text, label: x.label, lang: x.lang, id: x.id })).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
