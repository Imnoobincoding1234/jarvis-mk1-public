// ROUND 8 FRESH HELD-OUT v1 (2026-10-17) — written AFTER the README plan "Reader round 8 — round 7's whole data, play cleaned" and BEFORE
// any model read it, any round-8 row or any training. Every act at everyday shapes, weighted to what the play top-up lost (the field-less
// acts: time, screenshot, sleep_display, system_status, list_running; the player), what the gate asked on (play, messages, reminders), and
// the play / search / tell borders. Labels by LABELING.md (play: "the words that name the thing, and `video`"). ≥ ⅓ Hinglish. Never copied
// from his messages, never trained on. Shape-checked by readmodel.shapeError (training table); overlap-checked (exact and ≥ 0.75
// word-Jaccard) against every file in finetune/data and his episodes.
//   node build_round8_fresh.js → data/round8_fresh_v1.jsonl
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');   // norm / words / jac — the same overlap test
const RM = require('../jarvis-os/readmodel.js');
RM.init({ laterOn: () => true });                 // the training table (round 7's `when` allowed)

const E = 'en', H = 'hinglish';
const p = (query, x) => Object.assign({ act: 'play', query }, x || {});
const V = { video: true };
const N = { act: 'none' };
const m = (to, body, x) => Object.assign({ act: 'message', to }, body ? { body } : {}, x || {});
const ROWS = [
  // the clock
  ['time', E, 'got the time on you jarvis', { act: 'time' }],
  ['time', E, 'remind me what day it is', { act: 'time' }],
  ['time', E, 'whats the time over in toronto', { act: 'time', where: 'toronto' }],
  ['time', E, 'is it already past 2 am', { act: 'time' }],
  ['time', H, 'abhi kya time ho gaya', { act: 'time' }],
  ['time', H, 'aaj kaun sa din chal raha hai', { act: 'time' }],
  ['time', H, 'dubai mein abhi kya baja hai', { act: 'time', where: 'dubai' }],
  ['time', H, 'tareekh kya hai aaj ki', { act: 'time' }],
  // the screen and the machine
  ['screenshot', E, 'capture my screen real quick', { act: 'screenshot' }],
  ['screenshot', E, 'take a pic of the screen', { act: 'screenshot' }],
  ['screenshot', E, 'screenshot this for me', { act: 'screenshot' }],
  ['screenshot', H, 'is screen ki ek photo khinch lo', { act: 'screenshot' }],
  ['screenshot', H, 'ek ss le le bhai', { act: 'screenshot' }],
  ['sleep_display', E, 'turn my monitor off for a while', { act: 'sleep_display' }],
  ['sleep_display', E, 'blank the screen for now', { act: 'sleep_display' }],
  ['sleep_display', H, 'display ko sula do', { act: 'sleep_display' }],
  ['system_status', E, 'is anything wrong with this laptop right now', { act: 'system_status' }],
  ['system_status', E, 'run a quick health check on the laptop', { act: 'system_status' }],
  ['system_status', H, 'laptop theek chal raha hai na', { act: 'system_status' }],
  ['system_status', H, 'system ka haal batao', { act: 'system_status' }],
  ['list_running', E, 'what apps do i have open right now', { act: 'list_running' }],
  ['list_running', H, 'kaun kaun se apps khule hain', { act: 'list_running' }],
  // the player
  ['player', E, 'stop the music for a bit', { act: 'pause' }],
  ['player', E, 'resume the track', { act: 'resume' }],
  ['player', E, 'skip to the next one', { act: 'next_track' }],
  ['player', E, 'bump the volume up some more', { act: 'volume_up' }],
  ['player', E, 'bring the sound down a notch', { act: 'volume_down' }],
  ['player', H, 'music thodi der ke liye rok do', { act: 'pause' }],
  ['player', H, 'gaana phir se chalu karo', { act: 'resume' }],
  ['player', H, 'speaker ka volume kam karo zara', { act: 'volume_down' }],
  ['player', H, 'agla track lagao', { act: 'next_track' }],
  // search, not play
  ['search', E, 'search youtube for how to make cold brew', { act: 'search_web', query: 'how to make cold brew', where: 'youtube' }],
  ['search', E, 'look up ukulele tabs on google', { act: 'search_web', query: 'ukulele tabs', where: 'google' }],
  ['search', E, 'find laptop bags on amazon', { act: 'search_web', query: 'laptop bags', where: 'amazon' }],
  ['search', E, 'search for flights to bangalore', { act: 'search_web', query: 'flights to bangalore' }],
  ['search', H, 'myntra pe sneakers dhundo', { act: 'search_web', query: 'sneakers', where: 'myntra' }],
  ['search', H, 'youtube pe origami tutorial search karo', { act: 'search_web', query: 'origami tutorial', where: 'youtube' }],
  ['search', H, 'google pe dekho kal ka match kab hai', { act: 'search_web', query: 'kal ka match kab hai' }],
  ['search', H, 'nykaa pe sunscreen dhundo', { act: 'search_web', query: 'sunscreen', where: 'nykaa' }],
  // play
  ['play', E, 'play some old eagles songs', p('some old eagles songs')],
  ['play', E, 'put on a few acoustic songs', p('a few acoustic songs')],
  ['play', E, 'play a video on how to tie shoelaces', p('how to tie shoelaces', V)],
  ['play', E, 'play the newest beerbiceps podcast video', p('the newest beerbiceps podcast video', V)],
  ['play', E, 'watch some old f1 crashes', p('some old f1 crashes', V)],
  ['play', E, 'play some bhangra on spotify', p('some bhangra', { where: 'spotify' })],
  ['play', E, 'play a hindi movie on netflix', p('a hindi movie', { where: 'netflix', video: true })],
  ['play', E, 'put on some lofi on youtube', p('some lofi', { where: 'youtube', video: true })],
  ['play', E, 'can you play a random kids song', p('a random kids song')],
  ['play', E, 'play the latest kai cenat stream', p('the latest kai cenat stream', V)],
  ['play', H, 'koi purani filmi gaana chala do', p('koi purani filmi gaana')],
  ['play', H, 'kuch rajasthani folk lagao', p('kuch rajasthani folk')],
  ['play', H, 'kishore da ka ek gaana bajao', p('kishore da ka ek gaana')],
  ['play', H, 'thoda carnatic music chala do', p('thoda carnatic music')],
  ['play', H, 'ek cartoon dikha do chhote ke liye', p('ek cartoon', V)],
  ['play', H, 'youtube pe koi standup laga do', p('koi standup', { where: 'youtube', video: true })],
  ['play', H, 'yt pe ek movie review chala', p('ek movie review', { where: 'yt', video: true })],
  ['play', H, 'spotify pe kuch tamil songs bajao', p('kuch tamil songs', { where: 'spotify' })],
  ['play', H, 'netflix pe koi anime chala do', p('koi anime', { where: 'netflix', video: true })],
  ['play', H, 'kuch bollywood remix chala de', p('kuch bollywood remix')],
  // look-alikes: not play
  ['lookalike', E, 'that playlist slaps', N],
  ['lookalike', E, 'i love lofi music', N],
  ['lookalike', E, 'do you know any good songs', N],
  ['lookalike', E, 'stop asking me to play stuff', N],
  ['lookalike', E, 'did the video finish', N],
  ['lookalike', H, 'koi achhi si kahani sunao na', N],
  ['lookalike', H, 'koi sher o shayari sunao yaar', N],
  ['lookalike', H, 'mujhe ye gaana bahut pasand hai', N],
  ['lookalike', H, 'kal concert mein gaye the', N],
  ['lookalike', H, 'video baad mein dekhenge', N],
  // open / close
  ['open', E, 'open the notion app', { act: 'open', thing: 'notion', as: 'app' }],
  ['open', E, 'pull up my outlook inbox', { act: 'open', thing: 'outlook' }],
  ['open', E, 'boot up blender', { act: 'open', thing: 'blender' }],
  ['open', H, 'telegram khol do bhai', { act: 'open', thing: 'telegram' }],
  ['open', H, 'chrome mein instagram kholo', { act: 'open', thing: 'instagram', browser: 'chrome' }],
  ['open', H, 'calculator kholo jaldi', { act: 'open', thing: 'calculator' }],
  ['close', E, 'quit spotify for now', { act: 'close', thing: 'spotify' }],
  ['close', E, 'close the webex app', { act: 'close', thing: 'webex', as: 'app' }],
  ['close', E, 'force quit photoshop', { act: 'close', thing: 'photoshop', force: true }],
  ['close', H, 'opera band karo abhi', { act: 'close', thing: 'opera' }],
  ['close', H, 'teams band kar de yaar', { act: 'close', thing: 'teams' }],
  // messages and calls
  ['message', E, 'text kunal saying bring the speaker', m('kunal', 'bring the speaker')],
  ['message', E, 'whatsapp mama saying ill be home by 9', m('mama', 'ill be home by 9')],
  ['message', E, 'dm rehaan asking if he has the charger', m('rehaan', 'if he has the charger', { reported: true })],
  ['message', E, 'message ira saying gg', m('ira', 'gg')],
  ['message', H, 'bhai ko msg kar ki dinner ready hai', m('bhai', 'dinner ready hai')],
  ['message', H, 'nanu ko bolo main aa raha hu', m('nanu', 'main aa raha hu')],
  ['message', H, 'kunal ko puch ki kal school hai kya', m('kunal', 'kal school hai kya', { reported: true })],
  ['message', H, 'yuvan ko text kar de wya', m('yuvan', 'wya')],
  ['call', E, 'ring nanu real quick', { act: 'call', to: 'nanu' }],
  ['call', E, 'facetime kunal', { act: 'call', to: 'kunal', where: 'facetime', video: true }],
  ['call', H, 'rehaan ko ek call maar', { act: 'call', to: 'rehaan' }],
  ['call', H, 'bhai ke saath video call shuru karo', { act: 'call', to: 'bhai', video: true }],
  // reminders, calendar, weather, notes
  ['remind', E, 'remind me to send the internship form at 5', { act: 'remind', what: 'send the internship form', when: 'at 5' }],
  ['remind', E, 'remind me tomorrow morning to call the bank', { act: 'remind', what: 'call the bank', when: 'tomorrow morning' }],
  ['remind', E, 'set a reminder to buy milk', { act: 'remind', what: 'buy milk' }],
  ['remind', H, 'mujhe 8 baje yaad dilana ki gym jana hai', { act: 'remind', what: 'gym jana hai', when: '8 baje' }],
  ['remind', H, 'kal yaad dila dena ki library book wapas karni hai', { act: 'remind', what: 'library book wapas karni hai', when: 'kal' }],
  ['remind', H, 'yaad dilana ki mama ka birthday hai parso', { act: 'remind', what: 'mama ka birthday hai', when: 'parso' }],
  ['calendar', E, 'whats on my plate tomorrow', { act: 'calendar', when: 'tomorrow' }],
  ['calendar', E, 'am i busy friday evening', { act: 'calendar', when: 'friday evening' }],
  ['calendar', H, 'parso kuch scheduled hai kya', { act: 'calendar', when: 'parso' }],
  ['weather', E, 'is it going to pour in chennai tomorrow', { act: 'weather', where: 'chennai', when: 'tomorrow' }],
  ['weather', E, 'do i need sunscreen today', { act: 'weather', when: 'today' }],
  ['weather', H, 'aaj sweater pehnna padega kya', { act: 'weather', when: 'aaj' }],
  ['weather', H, 'pune ka mausam batao', { act: 'weather', where: 'pune' }],
  ['note', E, 'jot down pick up the parcel', { act: 'note', content: 'pick up the parcel' }],
  ['note', E, 'note that the wifi password changed', { act: 'note', content: 'the wifi password changed' }],
  ['note', H, 'notes mein daal do kal exam hai', { act: 'note', content: 'kal exam hai' }],
  // files, the tutor, dream mode
  ['files', E, 'find resume.pdf on this mac', { act: 'search_files', query: 'resume.pdf' }],
  ['files', E, 'make a folder called hackathon stuff', { act: 'create_folder', name: 'hackathon stuff' }],
  ['files', E, 'create a file named ideas.txt', { act: 'create_file', name: 'ideas.txt' }],
  ['files', E, 'delete draft_v2.docx', { act: 'delete', thing: 'draft_v2.docx' }],
  ['files', E, 'show me whats inside shopping_list.txt', { act: 'read', thing: 'shopping_list.txt' }],
  ['tutor', E, 'quiz me on world war 2', { act: 'quiz_me', topic: 'world war 2' }],
  ['tutor', H, 'mujhe chemistry seekhni hai', { act: 'learn_topic', topic: 'chemistry' }],
  ['tutor', E, 'show me my study progress so far', { act: 'study_stats' }],
  ['dream', E, 'what did you work on while i was asleep', { act: 'dream_log' }],
  ['dream', H, 'dream mode ko off kar de bhai', { act: 'dream_off' }],
  // none
  ['none', E, 'just got home from practice', N],
  ['none', E, 'my phone battery is dying', N],
  ['none', E, 'why do cats purr so much', N],
  ['none', E, 'cheers jarvis, sorted', N],
  ['none', E, 'ira rang me this morning', N],
  ['none', E, 'how do people take screenshots on linux', N],
  ['none', E, 'dont close anything', N],
  ['none', E, 'my legs are dead after football', N],
  ['none', H, 'aaj ka lecture boring tha', N],
  ['none', H, 'mama kitchen mein hai', N],
  ['none', H, 'jarvis tum kaise ho aaj', N],
  ['none', H, 'mujhe bhookh lagi hai', N],
  ['none', H, 'kal se gym shuru', N],
  ['none', H, 'rehaan bahut late aata hai', N],
  ['none', H, 'kuch nahi bas time pass', N],
];
const ITEMS = ROWS.map(([kind, lang, text, label], i) => ({ id: 'r' + String(i + 1).padStart(3, '0'), kind, lang, text, label }));

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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('round8_fresh_v1.jsonl') || st.size > 200e6) continue;
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
  const kinds = {}; for (const x of ITEMS) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  const acts = new Set(ITEMS.flatMap(x => x.label.act === 'multi' ? x.label.steps.map(s => s.act) : [x.label.act]));
  console.log('items', ITEMS.length, '· hinglish', ITEMS.filter(x => x.lang === H).length, '· kinds', JSON.stringify(kinds));
  console.log('acts', acts.size, '· missing acts', RM.ACTS.filter(a => !acts.has(a)).join(' ') || '–');
  shapeCheck();
  overlapCheck();
  const out = path.join(__dirname, 'data', 'round8_fresh_v1.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify({ text: x.text, label: x.label, lang: x.lang, kind: x.kind, id: x.id })).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
