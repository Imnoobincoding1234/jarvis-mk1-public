#!/usr/bin/env node
// jarvis v4.2.1 — the GREETING PATCH, 2026-10-09. Written AFTER data/prompt_heldout_v3.json (finetune/README "Greeting patch").
// His words: a "hi" gets "Hey, Sir." — "not jarvis like, which is 'hey sir how may i assist' etc". A prompt line could not move it
// (4/21, README "Greeting style by prompt"): the bare hello is in v4.2's weights (v42_parts/greetings.js HI replies). So:
//   hello   — hellos answered the JARVIS way: a greeting that fits the row's clock + a short offer of help (many of each)
//   present — "are you there" answered "Here, Sir — what do you need?" style
//   replay  — a stratified sample of v4.2's OWN training rows (same prompts) so nothing else drifts; v4.2's bare-reply rows
//             for the same hello / presence inputs are left out, not trained against.
// TRAINING MATERIAL, NOT A RUNTIME LIST. Held-out sentences (every jarvis held-out + prompt_heldout_v1..v3) are never trained.
// His rule: very diverse — no reply over 3% of its kind or 3 rows.
//   node build_bonsai_data_v421.js → data/bonsai_jarvis_v421/
const fs = require('fs');
const path = require('path');
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.build_bonsai.json';
const J = require('../jarvis-os/server.js');
const C = require('./promptclock');

let seed = 42142;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];
const sh = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nm = () => pick(['Sir', 'Atharv', 'Boss']);
const D = f => path.join(__dirname, 'data', f);
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const readJson = f => JSON.parse(fs.readFileSync(D(f), 'utf8'));
const NORMAL = { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61 };
const GR = require('./data/v42_parts/greetings.js')({ pick });

// ---- hello inputs (any clock unless the words name a time of day) ----
const HELLO_ANY = ['hey', 'hi', 'hello', 'yo', 'sup jarvis', 'hey jarvis', 'hi jarvis', 'hello jarvis', 'heyyy', 'yo yo', 'howdy partner',
  'hey you', 'hi hi', 'heya j', 'yo j', 'ello', 'wassup j', 'hey there buddy', 'hii', 'hiiii jarvis', 'greetings', 'yo whats up',
  'hey, im back at my desk', 'just opened my laptop, hey', 'hey its atharv', 'hello again jarvis', 'hey jarvis, ready?', 'hey boss',
  'jarvis!', 'knock knock, its me', 'hey hey hey', 'hello there my friend', 'yo jarvis lets go', 'hi there j',
  'namaste jarvis', 'jarvis ji', 'haan jarvis', 'oye', 'kiddan jarvis', 'ram ram ji', 'salaam', 'jai hind jarvis', 'pranaam',
  'aur bhai', 'arey jarvis', 'jarvis bhai', 'aa gaya jarvis', 'chalo shuru karein', 'hello jarvis ji', 'kya haal jarvis bhai',
].concat(GR.GENERIC);
const HELLO_MORNING = ['good morning', 'morning', 'gm', 'rise and shine jarvis', 'top of the morning', 'gm jarvis', 'good morning ji',
  'utth gaya main', 'subah subah hello', 'morning boss'].concat(GR.MORNING);
const HELLO_AFTERNOON = ['good afternoon', 'afternoon j', 'afternoon jarvis, back', 'lunch ke baad hello'];
const HELLO_EVENING = ['good evening', 'evening', 'evening boss', 'shaam ho gayi, hello', 'good evening jarvis ji'];
const PRESENT = ['jarvis?', 'u up?', 'you there?', 'jarvis are you on', 'can you hear me jarvis', 'hello? jarvis?', 'jarvis online hai?',
  'sun rahe ho?', 'koi hai?', 'jarvis active?', 'you awake j?', 'still with me jarvis?'].concat(GR.PRESENT.q);

// ---- replies: a greeting that fits the clock + an offer of help ----
const OPEN = {
  early: ['Good morning, {n} — up early.', 'Early start, {n}.', 'Morning, {n}. Ahead of the sun today.', 'Good morning, {n}.', 'Up with the birds, {n}.'],
  morning: ['Good morning, {n}.', 'Morning, {n}.', 'Hello, {n}. Good morning.', 'Good morning, {n} — hope you slept well.', 'Morning, {n}. Fresh start.'],
  afternoon: ['Good afternoon, {n}.', 'Afternoon, {n}.', 'Hello, {n}.', 'Hey, {n} — good afternoon.', 'Good afternoon, {n}. Half the day done.'],
  evening: ['Good evening, {n}.', 'Evening, {n}.', 'Hello, {n}. Good evening.', 'Hey, {n} — evening already.', 'Good evening, {n}. Long day?'],
  night: ['Evening, {n}.', 'Good evening, {n} — late one?', 'Hello, {n}.', 'Hey, {n}. Still at it?', 'Good evening, {n}. Night shift?'],
  late: ['Still up, {n}?', 'Burning the midnight oil, {n}.', 'Late one, {n}.', 'Hey, {n} — it is late.', 'You are up late, {n}.'],
};
const OFFER = ['How may I assist?', 'What can I do for you?', 'What are we doing today?', 'What do you need?', 'Ready when you are.',
  'What is first?', 'What can I help with?', 'What shall we start with?', 'Anything I can take off your plate?', 'What is on the agenda?',
  'How can I help?', 'What needs doing?', 'Where would you like to start?', 'Tell me what you need.', 'What are we working on?',
  'At your service — what is the plan?', 'Say the word.', 'How can I be of use?'];
const OFFER_LATE = ['What do you need?', 'Anything I can help with before you sleep?', 'Need anything?', 'What is keeping you up — anything I can do?',
  'How can I help this late?'];
const OFFER_HI = ['Bataiye, kya karna hai?', 'Kya madad karun?', 'Bolo, kya karna hai?', 'Aaj kya plan hai?', 'Kya karein aaj?'];
const HERE = ['Here, {n}.', 'Right here, {n}.', 'Yes, {n}, I am here.', 'Always, {n}.', 'Here and listening, {n}.', 'Haan, yahin hoon, {n}.', 'At your service, {n}.'];
// Hinglish input = his words carry Hindi/Punjabi — marked here by hand, as data (this list is training material, never read at runtime)
const HING = new Set(['namaste jarvis', 'jarvis ji', 'haan jarvis', 'oye', 'kiddan jarvis', 'ram ram ji', 'salaam', 'jai hind jarvis', 'pranaam',
  'aur bhai', 'arey jarvis', 'jarvis bhai', 'aa gaya jarvis', 'chalo shuru karein', 'hello jarvis ji', 'kya haal jarvis bhai', 'good morning ji',
  'utth gaya main', 'subah subah hello', 'lunch ke baad hello', 'shaam ho gayi, hello', 'good evening jarvis ji', 'jarvis online hai?',
  'sun rahe ho?', 'koi hai?', 'namaste', 'sat sri akal jarvis', 'ram ram', 'salaam jarvis', 'hello jarvis ji', 'subah ho gayi', 'shubh prabhat',
  'sun raha hai?', 'jarvis suno', 'oye sun']);
const offerFor = (q, b) => b === 'late' ? pick(OFFER_LATE) : HING.has(q) && rnd() < 0.3 ? pick(OFFER_HI) : pick(OFFER);

(async () => {
  const sys0 = await J._systemPrompt(null, { over: { stats: NORMAL, down: [] } });
  const rows = [];
  const fill = s => s.replace(/\{n\}/g, () => nm());
  const chat = (kind, q, bucket, reply) => {
    const d = C.randomClock(rnd, bucket);
    rows.push({ kind, messages: [{ role: 'system', content: C.setClock(sys0, d, C.randomWeather(rnd)) }, { role: 'user', content: q }, { role: 'assistant', content: fill(reply) }] });
  };
  const ALL = Object.keys(OPEN);
  for (const q of [...new Set(HELLO_ANY)]) for (const b of sh(ALL).slice(0, 2)) chat('hello', q, b, pick(OPEN[b]) + ' ' + offerFor(q, b));
  for (const q of [...new Set(HELLO_MORNING)]) for (const b of ['early', 'morning']) chat('hello', q, b, pick(OPEN[b]) + ' ' + offerFor(q, b));
  for (const q of HELLO_AFTERNOON) for (let i = 0; i < 2; i++) chat('hello', q, 'afternoon', pick(OPEN.afternoon) + ' ' + offerFor(q, 'afternoon'));
  for (const q of HELLO_EVENING) for (const b of ['evening', 'night']) chat('hello', q, b, pick(OPEN[b]) + ' ' + offerFor(q, b));
  for (const q of [...new Set(PRESENT)]) for (const b of sh(ALL).slice(0, 2)) chat('present', q, b, pick(HERE) + ' ' + offerFor(q, b));

  // ===== held-out sentences are never trained =====
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const held = new Set();
  for (const f of ['jarvis_heldout_v42.json', 'jarvis_heldout_v41.json', 'jarvis_heldout_v4.json', 'jarvis_heldout_v31.json', 'jarvis_heldout_v3.json',
    'jarvis_heldout_v2.json', 'jarvis_heldout.json', 'prompt_heldout_v1.json', 'prompt_heldout_v2.json', 'prompt_heldout_v3.json']) {
    const H = readJson(f); for (const k of ['greet', 'caps', 'chat', 'reasoning']) for (const c of (H[k] || [])) held.add(norm(c.q)); for (const c of (H.resolver || [])) held.add(norm(c.request)); }
  for (const l of fs.readFileSync(D('casual_stress_heldout.jsonl'), 'utf8').split('\n').filter(Boolean)) held.add(norm(JSON.parse(l).text));
  const userOf = r => { const u = r.messages[r.messages.length - 2].content; const m = u.match(/REQUEST: ([^\n]*)\nSTANDS FOR:$/) || u.match(/^QUESTION: ([^\n]*)/); return norm(m ? m[1] : u); };
  const leak = rows.filter(r => held.has(userOf(r)));
  if (leak.length) console.log('dropped ' + leak.length + ' patch rows matching held-out sentences: ' + [...new Set(leak.map(userOf))].join(' | '));
  const kindN = {}; for (const r of rows) kindN[r.kind] = (kindN[r.kind] || 0) + 1;
  const used = {}, patch = []; let capped = 0;
  for (const r of rows.filter(r => !held.has(userOf(r)))) {
    const a = r.kind + '\u0000' + r.messages[2].content.replace(/\b(Sir|Atharv|Boss)\b/g, '{n}');
    if ((used[a] = (used[a] || 0) + 1) > Math.max(3, Math.ceil(kindN[r.kind] * 0.03))) { capped++; continue; }
    patch.push(r);
  }
  if (capped) console.log('dropped ' + capped + ' rows over the per-reply cap');

  // ===== replay: v4.2's own rows, stratified; its bare replies to these same hello / presence inputs are left out =====
  const replaced = new Set([...HELLO_ANY, ...HELLO_MORNING, ...HELLO_AFTERNOON, ...HELLO_EVENING, ...PRESENT].map(norm));
  const v42 = readJsonl(D('bonsai_jarvis_v42/train.jsonl')).filter(r => !(r.kind === 'greet' && replaced.has(userOf(r))) && !held.has(userOf(r)));
  const byK = {}; for (const r of v42) (byK[r.kind] = byK[r.kind] || []).push(r);
  const REPLAY = Number(process.env.REPLAY) || 280, total = v42.length, replay = [];
  for (const [k, rs] of Object.entries(byK)) replay.push(...sh(rs).slice(0, Math.max(6, Math.round(REPLAY * rs.length / total))));
  console.log('replay ' + replay.length + ' of v4.2\'s ' + total + ' rows (' + Object.entries(byK).map(([k, rs]) => k + ' ' + Math.max(6, Math.round(REPLAY * rs.length / total))).join(', ') + ')');

  // ===== diversity report =====
  const by = {}; for (const r of patch) (by[r.kind] = by[r.kind] || []).push(r);
  for (const [k, rs] of Object.entries(by)) {
    const qs = new Set(rs.map(userOf)), as = {};
    for (const r of rs) { const a = r.messages[2].content.replace(/\b(Sir|Atharv|Boss)\b/g, '{n}'); as[a] = (as[a] || 0) + 1; }
    console.log(k.padEnd(9) + ' rows ' + String(rs.length).padStart(4) + '  inputs ' + String(qs.size).padStart(4) + '  replies ' + String(Object.keys(as).length).padStart(4) + '  top ' + (Math.max(...Object.values(as)) / rs.length * 100).toFixed(1) + '%');
  }

  // ===== split: 6% of each NEW kind (at least 6) held back; v4.2's own held-back rows join unchanged =====
  const train = [], valid = [];
  for (const [k, rs] of Object.entries(by)) { const s = sh(rs), n = Math.max(6, Math.round(rs.length * 0.06)); valid.push(...s.slice(0, n)); train.push(...s.slice(n)); }
  const v42v = readJsonl(D('bonsai_jarvis_v42/valid.jsonl'));
  const all = sh(train.concat(replay)), val = valid.concat(v42v);
  const dir = D('bonsai_jarvis_v421'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'train.jsonl'), all.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'valid.jsonl'), val.map(r => JSON.stringify(r)).join('\n') + '\n');
  const vk = {}; for (const r of val) vk[r.kind] = (vk[r.kind] || 0) + 1;
  console.log('wrote data/bonsai_jarvis_v421 — train ' + all.length + ' (patch ' + train.length + ', replay ' + replay.length + '), valid ' + val.length + ' ' + JSON.stringify(vk));
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
