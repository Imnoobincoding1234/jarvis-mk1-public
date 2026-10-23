// READER CALIBRATION — FRESH CONFIRMATION SET v2 (2026-10-16), written AFTER the README pre-registration "Per-field confidence —
// round 7" and BEFORE any model read it. Everyday plain requests of the kinds the r7cal gate asked on (short slang / Hinglish message
// bodies, play and video, reminders, quit, search, quiz), the other acts, none-shapes, a few round-7 shapes (a reason after the request,
// `as`, ss) — no `when` for later; ≥ ⅓ Hinglish. Never copied from his messages, never trained on. Shape-checked by readmodel.shapeError;
// overlap-checked against every file in finetune/data (v1 and the gate sets included) and his episodes.
//   node build_reader_calib_fresh_v2.js → data/reader_calib_fresh_v2.jsonl
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');   // norm / words / jac — the same overlap test
const RM = require('../jarvis-os/readmodel.js');

const E = 'en', H = 'hinglish';
const m = (to, body, x) => Object.assign({ act: 'message', to }, body ? { body } : {}, x || {});
const ROWS = [
  // messages — plain, the shape round 7 asked about
  [E, 'text sidhu saying gg that was close', m('sidhu', 'gg that was close')],
  [E, 'whatsapp parth saying bro ur late again', m('parth', 'bro ur late again')],
  [E, 'dm harsimran saying lets go 2nite', m('harsimran', 'lets go 2nite')],
  [E, 'message ekamveer saying nice shot today', m('ekamveer', 'nice shot today')],
  [E, 'shoot mama a text saying on my way home', m('mama', 'on my way home')],
  [E, 'text bhai saying dont touch my charger', m('bhai', 'dont touch my charger')],
  [E, 'send nanu a msg saying miss ur parathas', m('nanu', 'miss ur parathas')],
  [E, 'whatsapp parth asking if the test got postponed', m('parth', 'if the test got postponed', { reported: true })],
  [E, 'dm sidhu asking whether practice is at 5', m('sidhu', 'whether practice is at 5', { reported: true })],
  [E, 'text harsimran saying ngl that movie was mid', m('harsimran', 'ngl that movie was mid')],
  [E, 'msg ekamveer saying brb 10 mins', m('ekamveer', 'brb 10 mins')],
  [E, 'tell parth on whatsapp that im outside', m('parth', 'im outside', { where: 'whatsapp' })],
  [H, 'sidhu ko bol ki jaldi aa ja', m('sidhu', 'jaldi aa ja')],
  [H, 'mama ko msg kar de ki khana mat banana', m('mama', 'khana mat banana')],
  [H, 'parth ko text kar bro kidhar hai', m('parth', 'bro kidhar hai')],
  [H, 'bhai ko whatsapp pe bol de ki charger le aana', m('bhai', 'charger le aana', { where: 'whatsapp' })],
  [H, 'harsimran ko msg bhej ki movie kab dekhni hai', m('harsimran', 'movie kab dekhni hai', { reported: true })],
  [H, 'ekamveer ko bol do gg bro', m('ekamveer', 'gg bro')],
  [H, 'nanu ko message karo ki main sunday ko aaunga', m('nanu', 'main sunday ko aaunga')],
  [H, 'sidhu ko puch ki notes mil gaye kya', m('sidhu', 'notes mil gaye kya', { reported: true })],
  // calls
  [E, 'call parth real quick', { act: 'call', to: 'parth' }],
  [E, 'start a whatsapp video call with mama', { act: 'call', to: 'mama', where: 'whatsapp', video: true }],
  [E, 'ring harsimran', { act: 'call', to: 'harsimran' }],
  [H, 'chhote bhai ko phone lagao abhi', { act: 'call', to: 'chhote bhai' }],
  [H, 'sidhu ko video call kar do', { act: 'call', to: 'sidhu', video: true }],
  // play
  [E, 'play a 5 minute meditation video', { act: 'play', query: 'a 5 minute meditation video', video: true }],
  [E, 'play some chill beats', { act: 'play', query: 'some chill beats' }],
  [E, 'play a funny dog video', { act: 'play', query: 'a funny dog video', video: true }],
  [E, 'watch a black hole documentary on youtube', { act: 'play', query: 'a black hole documentary', where: 'youtube', video: true }],
  [E, 'play the latest dhruv rathee video', { act: 'play', query: 'the latest dhruv rathee video', video: true }],
  [E, 'play levitating by dua lipa', { act: 'play', query: 'levitating by dua lipa' }],
  [E, 'play some ap dhillon tracks on spotify', { act: 'play', query: 'some ap dhillon tracks', where: 'spotify' }],
  [E, 'play thunderstorm sounds for sleeping', { act: 'play', query: 'thunderstorm sounds for sleeping' }],
  [H, 'youtube pe physics ka video chala', { act: 'play', query: 'physics ka video', where: 'youtube', video: true }],
  [H, 'koi purana kishore kumar gaana laga do', { act: 'play', query: 'koi purana kishore kumar gaana' }],
  [H, 'arijit ka naya gaana bajao', { act: 'play', query: 'arijit ka naya gaana' }],
  [H, 'cooking ka video dikha', { act: 'play', query: 'cooking ka video', video: true }],
  [H, 'spotify pe lofi chala de', { act: 'play', query: 'lofi', where: 'spotify' }],
  [H, 'ek motivational video chalao', { act: 'play', query: 'ek motivational video', video: true }],
  [H, 'kuch punjabi gaane chala', { act: 'play', query: 'kuch punjabi gaane' }],
  [H, 'workout ke liye gaane lagao', { act: 'play', query: 'workout ke liye gaane' }],
  // open
  [E, 'launch notion for me', { act: 'open', thing: 'notion' }],
  [E, 'open the coursera website', { act: 'open', thing: 'coursera', as: 'site' }],
  [E, 'open my google classroom', { act: 'open', thing: 'google classroom' }],
  [E, 'start up the terminal app', { act: 'open', thing: 'terminal', as: 'app' }],
  [E, 'get finder open', { act: 'open', thing: 'finder' }],
  [H, 'perplexity khol do jaldi', { act: 'open', thing: 'perplexity' }],
  [H, 'music app khol de bhai', { act: 'open', thing: 'music', as: 'app' }],
  [H, 'linkedin open kar', { act: 'open', thing: 'linkedin' }],
  // close
  [E, 'quit chrome its using too much ram', { act: 'close', thing: 'chrome' }],
  [E, 'shut down whatsapp desktop', { act: 'close', thing: 'whatsapp desktop' }],
  [E, 'quit discord', { act: 'close', thing: 'discord' }],
  [E, 'force close the photoshop app', { act: 'close', thing: 'photoshop', as: 'app', force: true }],
  [E, 'exit notion', { act: 'close', thing: 'notion' }],
  [H, 'excel band kar do', { act: 'close', thing: 'excel' }],
  [H, 'obs ko band karo stream khatam', { act: 'close', thing: 'obs' }],
  [H, 'xcode band kar de', { act: 'close', thing: 'xcode' }],
  // search
  [E, 'search for cheap hostels in rishikesh', { act: 'search_web', query: 'cheap hostels in rishikesh' }],
  [E, 'google why my ceiling fan wobbles', { act: 'search_web', query: 'why my ceiling fan wobbles' }],
  [E, 'look up the jee mains exam date', { act: 'search_web', query: 'the jee mains exam date' }],
  [E, 'search amazon for a laptop stand', { act: 'search_web', query: 'a laptop stand', where: 'amazon' }],
  [H, 'google pe dekh aaj ka sensex', { act: 'search_web', query: 'aaj ka sensex' }],
  [H, 'flipkart pe sasta keyboard dhundo', { act: 'search_web', query: 'sasta keyboard', where: 'flipkart' }],
  [H, 'youtube pe guitar tutorial search kar', { act: 'search_web', query: 'guitar tutorial', where: 'youtube' }],
  // remind, calendar, weather, time, note, screenshot
  [E, 'remind me to return the library book at 3', { act: 'remind', what: 'return the library book', when: 'at 3' }],
  [E, 'remind me abt the chem test on friday', { act: 'remind', what: 'the chem test', when: 'on friday' }],
  [E, 'remind me in 15 mins to take the clothes out', { act: 'remind', what: 'take the clothes out', when: 'in 15 mins' }],
  [E, 'set a reminder for the dentist at 4', { act: 'remind', what: 'the dentist', when: 'at 4' }],
  [E, 'remind me to stretch', { act: 'remind', what: 'stretch' }],
  [H, 'mujhe kal yaad dilana ki fees bharni hai', { act: 'remind', what: 'fees bharni hai', when: 'kal' }],
  [H, 'raat 9 baje yaad dila dena dawai leni hai', { act: 'remind', what: 'dawai leni hai', when: 'raat 9 baje' }],
  [H, 'yaad dilana ki parth ka birthday hai kal', { act: 'remind', what: 'parth ka birthday hai', when: 'kal' }],
  [E, 'do i have anything saturday evening', { act: 'calendar', when: 'saturday evening' }],
  [E, 'check my calendar for next tuesday', { act: 'calendar', when: 'next tuesday' }],
  [H, 'is hafte mera schedule kya hai', { act: 'calendar', when: 'is hafte' }],
  [E, 'is it gonna be cold tonight', { act: 'weather', when: 'tonight' }],
  [E, 'hows the weather looking in shimla for the weekend', { act: 'weather', where: 'shimla', when: 'for the weekend' }],
  [H, 'delhi ka mausam kaisa hai', { act: 'weather', where: 'delhi' }],
  [E, 'whats the time in tokyo right now', { act: 'time', where: 'tokyo' }],
  [H, 'new york mein kitne baje hain', { act: 'time', where: 'new york' }],
  [E, 'note down call the electrician', { act: 'note', content: 'call the electrician' }],
  [E, 'add bread and eggs to my notes', { act: 'note', content: 'bread and eggs' }],
  [H, 'note kar lo kal test hai', { act: 'note', content: 'kal test hai' }],
  [E, 'screenshot the whole screen pls', { act: 'screenshot' }],
  [H, 'ss le lo', { act: 'screenshot' }],
  // tutor and player
  [E, 'quiz me on the mughal empire', { act: 'quiz_me', topic: 'the mughal empire' }],
  [E, 'test me on trigonometry', { act: 'quiz_me', topic: 'trigonometry' }],
  [H, 'mujhe history pe quiz karo', { act: 'quiz_me', topic: 'history' }],
  [E, 'teach me about the french revolution', { act: 'learn_topic', topic: 'the french revolution' }],
  [E, 'pause this song rn', { act: 'pause' }],
  [H, 'agla gaana chala', { act: 'next_track' }],
  [E, 'turn the volume up a bit', { act: 'volume_up' }],
  // none
  [E, 'sidhu just texted me lol', { act: 'none' }],
  [E, 'i already rang mama this morning', { act: 'none' }],
  [E, 'did you play the song', { act: 'none' }],
  [E, 'how do i turn on dark mode', { act: 'none' }],
  [E, 'ordering pizza tonight', { act: 'none' }],
  [E, 'parth is so lazy man', { act: 'none' }],
  [E, 'what causes a rainbow to form', { act: 'none' }],
  [E, 'thanks jarvis ur a lifesaver', { act: 'none' }],
  [E, 'the match was crazy yesterday', { act: 'none' }],
  [E, 'dont open chrome', { act: 'none' }],
  [E, 'my laptop is so slow today', { act: 'none' }],
  [E, 'who is the ceo of tesla', { act: 'none' }],
  [E, 'gonna sleep now', { act: 'none' }],
  [E, 'bhai is watching tv', { act: 'none' }],
  [E, 'what does lmao mean', { act: 'none' }],
  [E, 'sup jarvis whats new', { act: 'none' }],
  [E, 'the wifi is down again', { act: 'none' }],
  [H, 'aaj lab mein experiment fail ho gaya', { act: 'none' }],
  [H, 'mama ghar pe nahi hai', { act: 'none' }],
  [H, 'chhutti ka din hai aur plan zero', { act: 'none' }],
  [H, 'parso mera badminton tournament hai', { act: 'none' }],
  [H, 'tumhara favourite colour kya hai', { act: 'none' }],
  [H, 'parth ne call kiya tha', { act: 'none' }],
  [H, 'bas thak gaya hu', { act: 'none' }],
  [H, 'chrome mat band karna', { act: 'none' }],
  [H, 'bhai aaj kuch naya hua kya', { act: 'none' }],
  [H, 'ye video bekar thi', { act: 'none' }],
  [H, 'aankhon mein neend bhari hai', { act: 'none' }],
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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('reader_calib_fresh_v2.jsonl') || st.size > 200e6) continue;
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
  const out = path.join(__dirname, 'data', 'reader_calib_fresh_v2.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify({ text: x.text, label: x.label, lang: x.lang, id: x.id })).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
