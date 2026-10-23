'use strict';
// BONSAI READER HELD-OUT v1 — written 2026-10-15, AFTER the README pre-registration "Bonsai reader — 4B, then 1.7B, keep the best"
// (phase 2) and BEFORE any full Bonsai reader round. Chooses between the live round 5 and the Bonsai readers. Every act, the
// none-shapes, the round-7 shapes (when, front pages, reasons, `as` on close, music talk, someone's news, ss), multi; a third
// Hinglish or more. Written for this file only — never copied from his messages, never trained on. Labels follow LABELING.md
// and are checked by the reader's own shapeError (fields per act, every value his words); no `refers` keys (not graded here).
//   node build_bonsai_reader_heldout.js → shape check, overlap check (every file in finetune/data, his episodes, the rows
//   against each other), then data/bonsai_reader_heldout_v1.jsonl
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');   // norm / words / jac — the same overlap test
const RM = require('../jarvis-os/readmodel.js');

const E = 'en', H = 'hinglish';
const m = (to, body, x) => Object.assign({ act: 'message', to }, body ? { body } : {}, x || {});
const ROWS = [
  // open
  [E, 'launch figma for me', { act: 'open', thing: 'figma' }],
  [E, 'open the canva website', { act: 'open', thing: 'canva', as: 'site' }],
  [E, 'get notion up i need to make a todo', { act: 'open', thing: 'notion' }],
  [H, 'bhai vscode khol de', { act: 'open', thing: 'vscode' }],
  [E, 'open my outlook inbox', { act: 'open', thing: 'outlook' }],
  [E, 'pls open the calculator app', { act: 'open', thing: 'calculator', as: 'app' }],
  [H, 'telegram khol do yaar', { act: 'open', thing: 'telegram' }],
  [H, 'instagram wala app khol de bro', { act: 'open', thing: 'instagram', as: 'app' }],
  [E, 'open slack in 10 mins', { act: 'open', thing: 'slack', when: 'in 10 mins' }],
  // close
  [E, 'quit teams', { act: 'close', thing: 'teams' }],
  [E, 'force quit premiere its frozen', { act: 'close', thing: 'premiere', force: true }],
  [H, 'firefox ko abhi band kar de', { act: 'close', thing: 'firefox' }],
  [E, 'close the podcasts app now', { act: 'close', thing: 'podcasts', as: 'app' }],
  [E, 'close spotify at 11', { act: 'close', thing: 'spotify', when: 'at 11' }],
  [H, 'discord ko band karo 15 minute baad', { act: 'close', thing: 'discord', when: '15 minute baad' }],
  // search_web
  [E, 'google how deep the mariana trench goes', { act: 'search_web', query: 'how deep the mariana trench goes' }],
  [E, 'search skyscanner for return tickets to kochi', { act: 'search_web', query: 'return tickets to kochi', where: 'skyscanner' }],
  [E, 'look up the bus timetable', { act: 'search_web', query: 'the bus timetable' }],
  [H, 'youtube pe lofi beats search karo', { act: 'search_web', query: 'lofi beats', where: 'youtube' }],
  [E, 'open brave and search for laptop reviews', { act: 'search_web', query: 'laptop reviews', where: 'brave' }],
  [H, 'amazon pe running shoes dhundo', { act: 'search_web', query: 'running shoes', where: 'amazon' }],
  // play
  [E, 'play blinding lights', { act: 'play', query: 'blinding lights' }],
  [E, 'put on some lofi on spotify', { act: 'play', query: 'some lofi', where: 'spotify' }],
  [E, 'watch a video on how to solve a rubiks cube', { act: 'play', query: 'how to solve a rubiks cube', video: true }],
  [H, 'koi marathi gaana chala do', { act: 'play', query: 'koi marathi gaana' }],
  [E, 'play the weeknd at 9 pm', { act: 'play', query: 'the weeknd', when: 'at 9 pm' }],
  [H, 'youtube pe mkbhd ki latest video lagao', { act: 'play', query: 'mkbhd ki latest video', where: 'youtube', video: true }],
  [H, 'spotify pe arijit ke gaane bajao', { act: 'play', query: 'arijit ke gaane', where: 'spotify' }],
  // files
  [E, 'find my physics notes pdf', { act: 'search_files', query: 'physics notes pdf' }],
  [E, 'where is my passport scan on this mac', { act: 'search_files', query: 'passport scan' }],
  [E, 'make a folder called tax receipts 2026 on the desktop', { act: 'create_folder', name: 'tax receipts 2026', where: 'the desktop' }],
  [H, 'documents mein ek folder banao named projects', { act: 'create_folder', name: 'projects', where: 'documents' }],
  [E, 'create a file named shopping.txt', { act: 'create_file', name: 'shopping.txt' }],
  [E, 'create notes.md on the desktop', { act: 'create_file', name: 'notes.md', where: 'the desktop' }],
  [E, 'delete old_notes.txt from downloads', { act: 'delete', thing: 'old_notes.txt', where: 'downloads' }],
  [E, 'move clip2.mov to the trash', { act: 'delete', thing: 'clip2.mov' }],
  [E, 'show me whats in todo.txt', { act: 'read', thing: 'todo.txt' }],
  [E, 'add call the plumber to todo.txt', { act: 'append', thing: 'todo.txt', content: 'call the plumber' }],
  [E, 'list the stuff in documents', { act: 'list', thing: 'documents' }],
  // the machine
  [E, 'everything healthy with this macbook?', { act: 'system_status' }],
  [H, 'laptop itna hang kyun ho raha hai', { act: 'system_status' }],
  [E, 'snap the whole screen for me', { act: 'screenshot' }],
  [H, 'screen ka ss le lo', { act: 'screenshot' }],
  [E, 'which apps are open right now', { act: 'list_running' }],
  [E, 'wipe everything in the bin', { act: 'empty_trash' }],
  [E, 'turn the screen off', { act: 'sleep_display' }],
  // dream, tutor
  [E, 'anything happen in dream mode while i slept', { act: 'dream_log' }],
  [H, 'apna dream mode off rakho ab se', { act: 'dream_off' }],
  [H, 'raat ko apna idle wala kaam phir se on kar dena', { act: 'dream_on' }],
  [E, 'do your idle work now', { act: 'dream_now' }],
  [E, 'test me on organic reactions', { act: 'quiz_me', topic: 'organic reactions' }],
  [H, 'ek sawaal pucho mere syllabus se', { act: 'quiz_me' }],
  [E, 'show my flashcard scores', { act: 'study_stats' }],
  [E, 'i want to learn about black holes', { act: 'learn_topic', topic: 'black holes' }],
  [E, 'remove trigonometry from my study list', { act: 'stop_topic', topic: 'trigonometry' }],
  // message
  [E, 'text yuvan saying ill be there in 5', m('yuvan', 'ill be there in 5')],
  [E, 'whatsapp mama that i ate lunch', m('mama', 'i ate lunch')],
  [E, 'message bhai on imessage saying call me', m('bhai', 'call me', { where: 'imessage' })],
  [H, 'kunal ko msg karo ki kal milte hain', m('kunal', 'kal milte hain')],
  [E, 'ask rehaan if hes coming to the gym', m('rehaan', 'if hes coming to the gym', { reported: true })],
  [E, 'text ira at 7 saying wake up its exam day', m('ira', 'wake up its exam day', { when: 'at 7' })],
  [H, 'nanu ko puchho ki unhone dawai li', m('nanu', 'unhone dawai li', { reported: true })],
  [E, 'send mama a msg saying im on my way, ill be home in 20 mins', m('mama', 'im on my way, ill be home in 20 mins')],
  // call
  [E, 'ring papa real quick', { act: 'call', to: 'papa' }],
  [E, 'facetime ira', { act: 'call', to: 'ira', where: 'facetime', video: true }],
  [H, 'chhote bhai ko phone karo', { act: 'call', to: 'chhote bhai' }],
  [E, 'video call kunal on whatsapp', { act: 'call', to: 'kunal', where: 'whatsapp', video: true }],
  [H, 'papa ko facetime karo', { act: 'call', to: 'papa', where: 'facetime', video: true }],
  // remind, calendar, note
  [E, 'remind me to water the tulsi plant at 5:30', { act: 'remind', what: 'water the tulsi plant', when: 'at 5:30' }],
  [H, 'kal subah 6 baje yaad dila dena gym jaana hai', { act: 'remind', what: 'gym jaana hai', when: 'kal subah 6 baje' }],
  [E, 'lmk at 5 to call the bank', { act: 'remind', what: 'call the bank', when: 'at 5' }],
  [E, 'am i free this saturday', { act: 'calendar', when: 'this saturday' }],
  [H, 'parso mera din kaisa hai calendar mein', { act: 'calendar', when: 'parso' }],
  [E, 'jot down pick up the dry cleaning', { act: 'note', content: 'pick up the dry cleaning' }],
  [H, 'notes mein likh do wifi password changed', { act: 'note', content: 'wifi password changed' }],
  [H, 'mere notes mein add karo doodh lana hai', { act: 'note', content: 'doodh lana hai' }],
  // weather, time
  [E, 'any chance of rain this weekend in pune', { act: 'weather', where: 'pune', when: 'this weekend' }],
  [H, 'delhi mein aaj kitni garmi hai', { act: 'weather', where: 'delhi', when: 'aaj' }],
  [E, 'do i need a jacket in shimla', { act: 'weather', where: 'shimla' }],
  [H, 'kolhapur mein parso thand hogi kya', { act: 'weather', where: 'kolhapur', when: 'parso' }],
  [E, 'what time is it in dubai', { act: 'time', where: 'dubai' }],
  [H, 'aaj konsa din hai', { act: 'time' }],
  [E, 'is it past midnight yet', { act: 'time' }],
  [H, 'new york mein abhi kya time hai', { act: 'time', where: 'new york' }],
  // the player
  [E, 'hold the music, someones at the door', { act: 'pause' }],
  [H, 'gaana roko zara', { act: 'pause' }],
  [E, 'skip this track', { act: 'next_track' }],
  [H, 'next wala gaana lagao', { act: 'next_track' }],
  [H, 'awaaz badhao thoda', { act: 'volume_up' }],
  [E, 'make the speakers quieter', { act: 'volume_down' }],
  [E, 'unpause the album', { act: 'resume' }],
  // several at once
  [E, 'open spotify and text kunal saying omw', { act: 'multi', steps: [{ act: 'open', thing: 'spotify' }, m('kunal', 'omw')] }],
  [E, 'take a screenshot then open notes', { act: 'multi', steps: [{ act: 'screenshot' }, { act: 'open', thing: 'notes' }] }],
  [H, 'chrome khol aur bhai ko call kar', { act: 'multi', steps: [{ act: 'open', thing: 'chrome' }, { act: 'call', to: 'bhai' }] }],
  // none
  [E, 'lol that movie was so good', { act: 'none' }],
  [E, 'ira sent me a meme lol', { act: 'none' }],
  [E, 'did you close chrome', { act: 'none' }],
  [E, 'how do you rename a file on a mac', { act: 'none' }],
  [E, 'ill open the shop later', { act: 'none' }],
  [H, 'mama ko baad mein call karunga', { act: 'none' }],
  [E, 'whats the capital of peru', { act: 'none' }],
  [E, 'whatsapp is lagging so bad today', { act: 'none' }],
  [H, 'aur jarvis, sab badhiya?', { act: 'none' }],
  [E, 'please dont close my browser tabs', { act: 'none' }],
  [E, 'put the brightness at 70 percent', { act: 'none' }],
  [E, 'set an alarm for 5:45 tomorrow', { act: 'none' }],
  [H, 'yeh gaana kisne gaaya hai', { act: 'none' }],
  [E, 'i need to open up to my friends more', { act: 'none' }],
  [E, 'my tuition got moved to 4 on friday', { act: 'none' }],
  [H, 'yuvan bol raha tha movie cancel', { act: 'none' }],
  [H, 'kya chal raha hai tere saath', { act: 'none' }],
  [H, 'bhai ne bola wo late aayega', { act: 'none' }],
];
const ITEMS = ROWS.map(([lang, text, label], i) => ({ id: 'b' + String(i + 1).padStart(3, '0'), lang, text, label }));

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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('bonsai_reader_heldout_v1.jsonl') || st.size > 200e6) continue;
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
  const out = path.join(__dirname, 'data', 'bonsai_reader_heldout_v1.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify({ text: x.text, label: x.label, lang: x.lang, id: x.id })).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
