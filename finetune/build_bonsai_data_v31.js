#!/usr/bin/env node
// jarvis v3.1 data, 2026-10-01: v3's rows (same train/valid split, so the held-back error stays clean) + a patch
// aimed at v3's misses (data/v31_parts/patch.js). The fresh held-out (data/jarvis_heldout_v31.json) was written
// FIRST. His rule: very diverse — the diversity of every kind is printed, and no reply (names counted as one) may be more than 3% of its kind or 3 rows, whichever is larger.
//   node build_bonsai_data_v31.js   → data/bonsai_jarvis_v31/{train,valid}.jsonl
const fs = require('fs');
const path = require('path');
const J = require('../jarvis-os/server.js');

let seed = 31031;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const nm = () => pick(['Sir', 'Atharv', 'Boss']);
const cap = s => s.replace(/(^|\s)\S/g, c => c.toUpperCase());
const fmt = n => Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
const hm = m => { const h = Math.floor(m / 60) % 24, mm = m % 60, ap = h >= 12 ? 'PM' : 'AM'; return ((h % 12) || 12) + ':' + String(mm).padStart(2, '0') + ' ' + ap; };
const P = require('./data/v31_parts/patch.js')({ pick, int, nm, cap, fmt, hm });
const NORMAL = { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61 };
// the one greeting line v3 leaned on for 4 different greetings — its rows are dropped from v3's set
const OVERUSED = new Set(['Nothing that needs you. What is on your mind?']);

(async () => {
  const sysCache = new Map();
  const sys = async (stats, down) => { const k = JSON.stringify([stats, down]); if (!sysCache.has(k)) sysCache.set(k, await J._systemPrompt(null, { over: { stats: Object.assign({}, NORMAL, stats || {}), down: down || [] } })); return sysCache.get(k); };
  const rows = [];
  const add = async (kind, q, a, stats, down) => rows.push({ kind, messages: [{ role: 'system', content: await sys(stats, down) }, { role: 'user', content: q }, { role: 'assistant', content: a.replace(/\{n\}/g, () => nm()) }] });
  const many = async (kind, qs, gen, k) => { for (const q of qs) { const seen = new Set(); for (let i = 0, t = 0; i < k && t < 20; t++) { const a = gen(q); if (seen.has(a)) continue; seen.add(a); i++; await add(kind, q, a); } } };

  // content-asking banter: 3 different replies per input
  await many('talk_fact', P.ASK_FACT, P.factR, 3);
  await many('talk_fact', P.ASK_FACT_HI, P.factHI, 3);
  await many('talk_joke', P.ASK_JOKE, P.jokeR, 3);
  await many('talk_joke', P.ASK_JOKE_HI, P.jokeHI, 2);
  await many('talk_any', P.ASK_ANY.slice(0, 7), P.anyR, 3);
  await many('talk_any', P.ASK_ANY.slice(7), P.anyHI, 3);
  await many('talk_self', P.HOW_U, P.howR, 2);
  await many('talk_self', P.HOW_U_HI, P.howHI, 2);
  await many('talk_self', P.PLANS, P.plansR, 2);
  await many('talk_self', P.PLANS_HI, P.plansHI, 2);
  await many('talk_self', P.WHO, P.whoR, 2);
  for (const [qs, as] of P.BANTER) await many('talk_banter', qs, () => pick(as), 2);
  // greetings
  await many('greet', P.WAKE, P.wakeR, 2);
  await many('greet', P.HEY_HRU, P.heyHruR, 2);
  await many('greet', P.GM_Q, P.gmQR, 2);
  await many('greet', P.SLEEP, P.sleepR, 2);
  await many('greet', P.HOME, P.homeR, 2);
  const HI_G = new Set(['kya haal', 'kaise ho', 'aur bata']);
  for (let i = 0; i < 30; i++) { const g = pick(P.ATT_GREET), d = int(91, 99); await add('attn', g, HI_G.has(g) ? P.diskHI(d) : P.diskR(d), { diskPct: d }); }
  for (let i = 0; i < 30; i++) { const g = pick(P.ATT_GREET), n = pick(P.AGENTS); await add('attn', g, HI_G.has(g) ? P.downHI(n) : P.downR(n), null, [n]); }
  for (let i = 0; i < 12; i++) { const g = pick(P.ATT_GREET.filter(x => !HI_G.has(x))), b = int(4, 19); await add('attn', g, P.battR(b), { batteryPct: b, charging: false }); }
  // capabilities: every phrasing, 2 different truthful replies
  for (const [qs, as] of P.CAPS) await many('caps', qs, () => pick(as), 2);
  // acks that name what was asked
  for (const a of P.APPS) for (let i = 0; i < 2; i++) { const f = pick(P.OPEN_EN), q = f(a); await add('ack_open', q, / (khol|karo)/.test(q) ? P.openHI(a) : P.openR(a)); }
  for (let i = 0; i < 30; i++) { const t = pick(['5', '5:30', '6', '6:15', '6:45', '7', '7:30', '8', '9', '4:45']); await add('ack_alarm', pick(P.ALARM)(t), P.alarmR(t)); }
  for (let i = 0; i < 40; i++) { const p = pick(P.PEOPLE); await add('ack_msg', pick(P.MSG)(p, pick(P.BODIES)), P.msgR(p)); }
  for (let i = 0; i < 24; i++) { const a = pick(P.ARTISTS); await add('ack_play', pick(P.PLAY)(a), P.playR(a)); }
  for (let i = 0; i < 16; i++) { const t = pick(P.TOPICS); await add('ack_search', pick(P.SEARCH)(t), P.searchR(t)); }
  // honesty
  await many('honest', P.HONEST[0], P.honestHI, 2);
  await many('honest', P.HONEST[1], P.honestEN, 2);
  for (let i = 0; i < 24; i++) await add('honest', pick(P.DID)(pick(P.PEOPLE)), P.didR());
  // feelings: 2 different replies per input
  for (const [qs, as] of P.FEEL) await many('feel', qs, () => pick(as), 2);
  // reasoning, computed, with the reasoning system prompt
  const rsys = await J._systemPrompt(J.REASON_EXTRA, { state: 'full', over: { stats: Object.assign({}, NORMAL), down: [] } });
  const seenQ = new Set();
  for (let i = 0; seenQ.size < 220 && i < 20000; i++) { const [q, a] = pick(P.REASON)(); if (seenQ.has(q)) continue; seenQ.add(q);
    rows.push({ kind: 'reason', messages: [{ role: 'system', content: rsys }, { role: 'user', content: q }, { role: 'assistant', content: a.replace(/\{n\}/g, () => nm()) }] }); }

  // same input + same reply twice → once
  const key = r => r.messages.map(m => m.content).join('\u0000');
  const uniq = new Map(); for (const r of rows) if (!uniq.has(key(r))) uniq.set(key(r), r);
  const patch = [...uniq.values()];

  // held-out sentences are never trained: v3.1 (fresh), v3, v2, v1, and the casual stress set
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const held = new Set();
  for (const f of ['jarvis_heldout_v31.json', 'jarvis_heldout_v3.json', 'jarvis_heldout_v2.json', 'jarvis_heldout.json']) {
    const H = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
    for (const k of ['greet', 'caps', 'chat', 'reasoning']) for (const c of H[k]) held.add(norm(c.q)); for (const c of H.resolver) held.add(norm(c.request));
  }
  for (const l of fs.readFileSync(path.join(__dirname, 'data', 'casual_stress_heldout.jsonl'), 'utf8').split('\n').filter(Boolean)) held.add(norm(JSON.parse(l).text));
  const userOf = r => { const u = r.messages[r.messages.length - 2].content; const m = u.match(/REQUEST: ([^\n]*)\nSTANDS FOR:$/); return norm(m ? m[1] : u); };
  const leak = patch.filter(r => held.has(userOf(r)));
  if (leak.length) console.log('dropped ' + leak.length + ' patch rows matching held-out sentences: ' + [...new Set(leak.map(userOf))].join(' | '));
  const clean0 = patch.filter(r => !held.has(userOf(r)));
  // the cap, enforced: rows past a reply's allowance in its kind are dropped (and counted)
  const kindN = {}; for (const r of clean0) kindN[r.kind] = (kindN[r.kind] || 0) + 1;
  const used = {}, clean = []; let capped = 0;
  for (const r of clean0) { const a = r.kind + '\u0000' + r.messages[r.messages.length - 1].content.replace(/\b(Sir|Atharv|Boss)\b/g, '{n}');
    if ((used[a] = (used[a] || 0) + 1) > Math.max(3, Math.ceil(kindN[r.kind] * 0.03))) { capped++; continue; } clean.push(r); }
  if (capped) console.log('dropped ' + capped + ' rows over the per-reply cap');

  // v3's rows, same split; the overused greeting line dropped
  const load = f => fs.readFileSync(path.join(__dirname, 'data', 'bonsai_jarvis_v3', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const keepV3 = r => !OVERUSED.has(r.messages[r.messages.length - 1].content);
  const v3t = load('train.jsonl'), v3v = load('valid.jsonl');
  const v3tk = v3t.filter(keepV3), v3vk = v3v.filter(keepV3);
  console.log('v3 rows kept: train ' + v3tk.length + '/' + v3t.length + ', valid ' + v3vk.length + '/' + v3v.length);

  // diversity report + the 3% cap per reply within a kind
  const by = {};
  for (const r of clean) (by[r.kind] = by[r.kind] || []).push(r);
  let over = 0;
  for (const [k, rs] of Object.entries(by)) {
    const qs = new Set(rs.map(userOf)), as = {}; for (const r of rs) { const a = r.messages[r.messages.length - 1].content.replace(/\b(Sir|Atharv|Boss)\b/g, '{n}'); as[a] = (as[a] || 0) + 1; }
    const top = Object.entries(as).sort((a, b) => b[1] - a[1])[0];
    const share = top[1] / rs.length;
    if (top[1] > Math.max(3, Math.ceil(rs.length * 0.03))) { over++; console.log('  OVER 3%: ' + k + ' "' + top[0].slice(0, 60) + '" ' + top[1] + '/' + rs.length); }
    console.log(k.padEnd(12) + ' rows ' + String(rs.length).padStart(4) + '  inputs ' + String(qs.size).padStart(4) + '  replies ' + String(Object.keys(as).length).padStart(4) + '  top reply ' + (share * 100).toFixed(1) + '%');
  }

  for (let i = clean.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [clean[i], clean[j]] = [clean[j], clean[i]]; }
  const nValid = Math.round(clean.length * 0.06);
  const pValid = clean.slice(0, nValid), pTrain = clean.slice(nValid);
  const strip = r => ({ messages: r.messages });
  // replay: a seeded sample of v3's training rows rides along so v3.1 does not forget what v3 learned (all
  // of v3's validation rows stay in validation)
  const REPLAY = 600;
  const v3s = v3tk.slice(); for (let i = v3s.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [v3s[i], v3s[j]] = [v3s[j], v3s[i]]; }
  const replay = v3s.slice(0, REPLAY);
  const train = replay.concat(pTrain.map(strip)), valid = v3vk.concat(pValid.map(strip));
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  const dir = path.join(__dirname, 'data', 'bonsai_jarvis_v31');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'train.jsonl'), train.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'valid.jsonl'), valid.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'patch_valid_count.txt'), String(pValid.length) + '\n');
  console.log('wrote data/bonsai_jarvis_v31 — train ' + train.length + ' (v3 replay ' + replay.length + ' of ' + v3tk.length + ' + patch ' + pTrain.length + '), valid ' + valid.length + ' (v3 ' + v3vk.length + ' + patch ' + pValid.length + ')' + (over ? ' — ' + over + ' kinds over the 3% cap' : ''));
  process.exit(0);
})();
