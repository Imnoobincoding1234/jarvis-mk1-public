// PLAY HELD-OUT v1 (2026-10-16) — written AFTER the README plan "Reader round 7 top-up — play labels" and his OK on the convention
// (LABELING.md "Play — the words that name the thing, and `video`"), BEFORE any model read it and before any relabeled or new training
// row exists. Chooses whether a play top-up of round 7 is kept (README step 5). Three kinds, graded apart:
//   play      60 — front words kept (some / a / koi / kuch / ek …), a video with no platform, platform + video, music on Spotify, artist + song,
//                  a length inside the query, filler around; ≥ ⅓ Hinglish
//   lookalike 15 — NOT play: talk about music or videos, "… suna de" meaning tell, negations, questions (the v2j07 shape)
//   other     15 — the player, open / close, a search on YouTube, play words inside a message body, reminders, a call, a note, the time
// Never copied from his messages, never trained on. Shape-checked by readmodel.shapeError; overlap-checked (exact and ≥ 0.75 word-Jaccard)
// against every file in finetune/data — gate sets, fresh v1/v2 and every hold included — and his episodes.
//   node build_play_heldout.js → data/play_heldout_v1.jsonl
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./build_timed_heldout.js');   // norm / words / jac — the same overlap test
const RM = require('../jarvis-os/readmodel.js');

const E = 'en', H = 'hinglish';
const p = (query, x) => Object.assign({ act: 'play', query }, x || {});
const V = { video: true };
const PLAY = [
  // front words, music
  [E, 'play some old arctic monkeys', p('some old arctic monkeys')],
  [E, 'throw on some bollywood party songs', p('some bollywood party songs')],
  [E, 'put on a chill playlist for studying', p('a chill playlist for studying')],
  [E, 'play some travis scott real quick', p('some travis scott')],
  [E, 'queue up a few lana del rey songs', p('a few lana del rey songs')],
  [H, 'koi garhwali gaana bajao', p('koi garhwali gaana')],
  [H, 'kuch slow songs chala de yaar', p('kuch slow songs')],
  [H, 'ek gazal laga do', p('ek gazal')],
  [H, 'kuch naya marathi sunao', p('kuch naya marathi')],
  [H, 'koi old school hip hop laga', p('koi old school hip hop')],
  // a video, no platform named
  [E, 'play a 20 minute pilates video', p('a 20 minute pilates video', V)],
  [E, 'play some funny fail videos', p('some funny fail videos', V)],
  [E, 'put on a minecraft speedrun video', p('a minecraft speedrun video', V)],
  [E, 'show me a trailer for the new batman movie', p('a trailer for the new batman movie', V)],
  [E, 'play the latest carryminati video', p('the latest carryminati video', V)],
  [E, 'watch some stand up comedy clips', p('some stand up comedy clips', V)],
  [E, 'find me a vid on how to change a tyre', p('how to change a tyre', V)],
  [H, 'ek funny video chala do', p('ek funny video', V)],
  [H, 'koi motivational speech ka video lagao', p('koi motivational speech ka video', V)],
  [H, 'kuch cricket ke clips dikhao', p('kuch cricket ke clips', V)],
  [H, 'samay raina ka naya video chala', p('samay raina ka naya video', V)],
  [H, 'paneer tikka ki recipe video chala', p('paneer tikka ki recipe video', V)],
  // a platform, and video
  [E, 'play some synthwave mixes on youtube', p('some synthwave mixes', { where: 'youtube', video: true })],
  [E, 'go to youtube and put on a chess commentary stream', p('a chess commentary stream', { where: 'youtube', video: true })],
  [E, 'watch the india vs australia highlights on yt', p('the india vs australia highlights', { where: 'yt', video: true })],
  [E, 'play a ted talk on youtube', p('a ted talk', { where: 'youtube', video: true })],
  [E, 'put on some cat videos on youtube', p('some cat videos', { where: 'youtube', video: true })],
  [E, 'play stranger things on netflix', p('stranger things', { where: 'netflix', video: true })],
  [H, 'youtube pe koi documentary chala', p('koi documentary', { where: 'youtube', video: true })],
  [H, 'yt pe kuch comedy dikha', p('kuch comedy', { where: 'yt', video: true })],
  [H, 'youtube pe ek gaming stream laga', p('ek gaming stream', { where: 'youtube', video: true })],
  [H, 'netflix pe koi horror movie lagao', p('koi horror movie', { where: 'netflix', video: true })],
  // music on a music service — never video
  [E, 'play some taylor swift on spotify', p('some taylor swift', { where: 'spotify' })],
  [E, 'put on my chill vibes playlist on spotify', p('my chill vibes playlist', { where: 'spotify' })],
  [E, 'play a random song on spotify', p('a random song', { where: 'spotify' })],
  [E, 'play lofi on apple music', p('lofi', { where: 'apple music' })],
  [H, 'spotify pe kuch english gaane chala', p('kuch english gaane', { where: 'spotify' })],
  [H, 'spotify pe ek sad playlist laga', p('ek sad playlist', { where: 'spotify' })],
  // artist + song, no front word
  [E, 'play heat waves by glass animals', p('heat waves by glass animals')],
  [E, 'play someone like you adele', p('someone like you adele')],
  [E, 'put on kun faya kun', p('kun faya kun')],
  [E, 'play the local train aaoge tum kabhi', p('the local train aaoge tum kabhi')],
  [H, 'channa mereya bajao', p('channa mereya')],
  [H, 'ap dhillon ka excuses chala do', p('ap dhillon ka excuses')],
  // a length inside the query (never `when`)
  [E, 'play a 30 minute rain playlist', p('a 30 minute rain playlist')],
  [E, 'play a 5 min breathing exercise video', p('a 5 min breathing exercise video', V)],
  [H, '10 minute ka meditation music chala', p('10 minute ka meditation music')],
  // filler around the request
  [E, 'eh whatever just play some jazz', p('some jazz')],
  [E, 'yo jarvis throw on some phonk lol', p('some phonk')],
  [E, 'can u play a random video idk', p('a random video', V)],
  [H, 'bhai kuch bhi gaana chala de', p('kuch bhi gaana')],
  [H, 'yaar ek acha sa song laga do na', p('ek acha sa song')],
  // more
  [E, 'play my road trip mix from last summer', p('my road trip mix from last summer')],
  [E, 'play something soft for a rainy evening', p('something soft for a rainy evening')],
  [E, 'watch the new mrbeast video', p('the new mrbeast video', V)],
  [E, 'play some nature sounds for focus', p('some nature sounds for focus')],
  [E, 'play some old kishore kumar songs', p('some old kishore kumar songs')],
  [H, 'shiv tandav stotram chalao', p('shiv tandav stotram')],
  [H, 'koi bhakti gaana laga do', p('koi bhakti gaana')],
  [H, 'ek dum mast gaana bajao', p('ek dum mast gaana')],
];
const N = { act: 'none' };
const LOOKALIKE = [
  [E, 'that song was fire', N],
  [E, 'did u play the playlist i asked for', N],
  [E, 'had seedhe maut on loop the whole bus ride', N],
  [E, 'what genre is lofi', N],
  [E, 'youtube is so slow today', N],
  [E, 'who sings heat waves', N],
  [E, 'dont play anything rn', N],
  [E, 'my brother keeps playing the same song', N],
  [H, 'ek chutkula suna de yaar', N],
  [H, 'kuch interesting suna na', N],
  [H, 'koi kahani sunao', N],
  [H, 'ye gaana kisne gaaya hai', N],
  [H, 'mujhe gaane sunna pasand hai', N],
  [H, 'kal raat netflix pe movie dekhi', N],
  [H, 'gaana mat chalana abhi', N],
];
const OTHER = [
  [E, 'hold the music for a second', { act: 'pause' }],
  [H, 'agle gaane pe jao', { act: 'next_track' }],
  [E, 'crank the volume up', { act: 'volume_up' }],
  [H, 'speaker ki awaaz thodi dheemi karo', { act: 'volume_down' }],
  [E, 'launch apple music', { act: 'open', thing: 'apple music' }],
  [E, 'quit vlc player', { act: 'close', thing: 'vlc player' }],
  [E, 'search youtube for guitar lessons for beginners', { act: 'search_web', query: 'guitar lessons for beginners', where: 'youtube' }],
  [H, 'youtube pe tabla tutorial dhundo', { act: 'search_web', query: 'tabla tutorial', where: 'youtube' }],
  [E, 'text kunal saying put on some music', { act: 'message', to: 'kunal', body: 'put on some music' }],
  [H, 'bhai ko bol gaana band kar', { act: 'message', to: 'bhai', body: 'gaana band kar' }],
  [E, 'remind me to restring my ukulele at 6', { act: 'remind', what: 'restring my ukulele', when: 'at 6' }],
  [H, 'shaam 7 baje yaad dilana ki dance class hai', { act: 'remind', what: 'dance class hai', when: 'shaam 7 baje' }],
  [E, 'call rehaan on facetime', { act: 'call', to: 'rehaan', where: 'facetime', video: true }],
  [E, 'note down songs for the party playlist', { act: 'note', content: 'songs for the party playlist' }],
  [E, 'whats the time in seoul', { act: 'time', where: 'seoul' }],
];
const ROWS = [...PLAY.map(r => ['play', ...r]), ...LOOKALIKE.map(r => ['lookalike', ...r]), ...OTHER.map(r => ['other', ...r])];
const ITEMS = ROWS.map(([kind, lang, text, label], i) => ({ id: 'p' + String(i + 1).padStart(3, '0'), kind, lang, text, label }));

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
    if (!/\.(jsonl?|txt|csv|tsv)$/.test(f) || p.endsWith('play_heldout_v1.jsonl') || st.size > 200e6) continue;
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
  const k = x => ITEMS.filter(i => i.kind === x).length;
  console.log('items', ITEMS.length, '· play', k('play'), '· lookalike', k('lookalike'), '· other', k('other'),
    '· hinglish', ITEMS.filter(x => x.lang === H).length,
    '· play with video', ITEMS.filter(x => x.kind === 'play' && x.label.video).length, '· play with where', ITEMS.filter(x => x.kind === 'play' && x.label.where).length);
  shapeCheck();
  overlapCheck();
  const out = path.join(__dirname, 'data', 'play_heldout_v1.jsonl');
  fs.writeFileSync(out, ITEMS.map(x => JSON.stringify({ text: x.text, label: x.label, lang: x.lang, kind: x.kind, id: x.id })).join('\n') + '\n');
  console.log('wrote', path.relative(__dirname, out));
}
module.exports = { ITEMS };
