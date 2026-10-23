#!/usr/bin/env node
// jarvis v4 data, 2026-10-02 — his call: "go for v4 and add the material … which v3.1 failed at".
// = v4 web rows (build_v4_web.js: Mind2Web steps in our snapshot format + MolmoWeb start rows)
// + a chat patch for v3.1's misses (data/v4_parts/chat_patch.js)
// + a seeded replay of v3.1's training rows, so the chat it learned stays.
// Validation: v3.1's validation rows (all of them) + the patch's 6% + web_valid (whole Mind2Web tasks held back).
// The fresh held-outs (data/jarvis_heldout_v4.json, data/v4_web_heldout.jsonl) were written FIRST and are never trained.
// His rule: very diverse — diversity printed per kind; no reply over 3% of its kind or 3 rows (excess dropped).
//   JARVIS_READER_CACHE=readmodel.build_bonsai.json node build_bonsai_data_v4.js → data/bonsai_jarvis_v4/
const fs = require('fs');
const path = require('path');
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.build_bonsai.json';
const J = require('../jarvis-os/server.js');
const cx = require('../jarvis-os/context.js');

let seed = 40404;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const nm = () => pick(['Sir', 'Mihir', 'Boss']);
const cap = s => s.replace(/(^|\s)\S/g, c => c.toUpperCase());
const fmt = n => Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
const P = require('./data/v4_parts/chat_patch.js')({ pick, int, cap, fmt });
const NORMAL = { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61 };
const D = f => path.join(__dirname, 'data', f);
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

(async () => {
  const sysP = await J._systemPrompt(null, { over: { stats: Object.assign({}, NORMAL), down: [] } });
  const rows = [];
  const add = (kind, q, a) => rows.push({ kind, messages: [{ role: 'system', content: sysP }, { role: 'user', content: q }, { role: 'assistant', content: a.replace(/\{n\}/g, () => nm()) }] });
  const many = (kind, qs, gen, k) => { for (const q of qs) { const seen = new Set(); for (let i = 0, t = 0; i < k && t < 20; t++) { const a = gen(q); if (seen.has(a)) continue; seen.add(a); i++; add(kind, q, a); } } };
  const res = (kind, convo, req, ans) => { const p = cx.standsForPrompt(req, convo.map(([role, content]) => ({ role, content })).concat([{ role: 'user', content: req }]));
    if (p) rows.push({ kind, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }, { role: 'assistant', content: ans }] }); };

  for (const [q, a] of P.MANY) for (const r of P.AMBIG_REQ.slice().sort(() => rnd() - 0.5).slice(0, 4)) res('resolve_none', [['user', q], ['assistant', a]], r, 'NONE');
  for (const [q, a, ref, reqs] of P.ONE) for (const r of reqs) res(ref === 'NONE' ? 'resolve_none' : 'resolve', [['user', q], ['assistant', a]], r, ref);
  for (const [qs, as] of P.CAPS) many('caps', qs, () => pick(as), 2);
  many('greet', P.LISTEN, P.listenR, 2);
  for (const w of P.BACKFROM) for (let i = 0; i < 2; i++) add('greet', pick(P.BACK)(w), P.backR(w));
  many('greet', P.SCENE, P.sceneR, 2);
  for (const p of P.OTHERS) for (let i = 0; i < 2; i++) add('noclaim', pick(P.OTHER)(p), P.otherR());
  many('noclaim', P.SELF, P.selfR, 2);
  many('honest', P.HON, P.honR, 2);
  for (const [q, a] of P.FACTS) { const f = pick(P.FACT_ASK); add('fact', f(q), a); }
  const rsys = await J._systemPrompt(J.REASON_EXTRA, { state: 'full', over: { stats: Object.assign({}, NORMAL), down: [] } });
  const seenQ = new Set();
  for (let i = 0; seenQ.size < 90 && i < 5000; i++) { const [q, a] = pick(P.REASON)(); if (seenQ.has(q)) continue; seenQ.add(q);
    rows.push({ kind: 'reason', messages: [{ role: 'system', content: rsys }, { role: 'user', content: q }, { role: 'assistant', content: a }] }); }

  // held-out sentences are never trained: v4 (fresh), v3.1, v3, v2, v1, the stress set
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const held = new Set();
  for (const f of ['jarvis_heldout_v4.json', 'jarvis_heldout_v31.json', 'jarvis_heldout_v3.json', 'jarvis_heldout_v2.json', 'jarvis_heldout.json']) {
    const H = JSON.parse(fs.readFileSync(D(f), 'utf8'));
    for (const k of ['greet', 'caps', 'chat', 'reasoning']) for (const c of H[k]) held.add(norm(c.q)); for (const c of H.resolver) held.add(norm(c.request));
  }
  for (const l of fs.readFileSync(D('casual_stress_heldout.jsonl'), 'utf8').split('\n').filter(Boolean)) held.add(norm(JSON.parse(l).text));
  const userOf = r => { const u = r.messages[r.messages.length - 2].content; const m = u.match(/REQUEST: ([^\n]*)\nSTANDS FOR:$/); return norm(m ? m[1] : u); };
  const leak = rows.filter(r => held.has(userOf(r)));
  if (leak.length) console.log('dropped ' + leak.length + ' patch rows matching held-out sentences: ' + [...new Set(leak.map(userOf))].join(' | '));
  const kindN = {}; for (const r of rows) kindN[r.kind] = (kindN[r.kind] || 0) + 1;
  const used = {}, patch = []; let capped = 0;
  for (const r of rows.filter(r => !held.has(userOf(r)))) {
    const a = r.kind + '\u0000' + r.messages[r.messages.length - 1].content.replace(/\b(Sir|Mihir|Boss)\b/g, '{n}');
    if ((used[a] = (used[a] || 0) + 1) > Math.max(3, Math.ceil(kindN[r.kind] * 0.03)) && r.kind !== 'resolve_none') { capped++; continue; }
    patch.push(r);
  }
  if (capped) console.log('dropped ' + capped + ' rows over the per-reply cap');

  // web rows: the web held-out tasks must not appear in training (Mind2Web's splits are disjoint; checked anyway)
  const webHeld = new Set(readJsonl(D('v4_web_heldout.jsonl')).map(r => norm(r.task)));
  const webTrain = readJsonl(D('v4_parts/web_train.jsonl')).filter(r => !webHeld.has(norm(r.messages[1].content.split('\n')[0].replace(/^TASK: /, ''))));
  const webValid = readJsonl(D('v4_parts/web_valid.jsonl'));
  // start-site rows are easy and many: a seeded 350 of them, so they do not outweigh the page steps
  const molmo = readJsonl(D('v4_parts/molmo_start.jsonl')).sort(() => rnd() - 0.5).slice(0, 350);

  // replay of v3.1's training rows (seeded), and all of v3.1's validation rows
  const v31t = readJsonl(D('bonsai_jarvis_v31/train.jsonl')), v31v = readJsonl(D('bonsai_jarvis_v31/valid.jsonl'));
  const REPLAY = 700;
  const sh = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const replay = sh(v31t).slice(0, REPLAY).map(r => Object.assign({ kind: 'replay_v31' }, r));

  // diversity report (patch + web + molmo)
  const by = {};
  for (const r of patch.concat(webTrain, molmo)) (by[r.kind] = by[r.kind] || []).push(r);
  for (const [k, rs] of Object.entries(by).sort()) {
    const qs = new Set(rs.map(r => r.messages[r.messages.length - 2].content)), as = {};
    for (const r of rs) { const a = r.messages[r.messages.length - 1].content.replace(/\b(Sir|Mihir|Boss)\b/g, '{n}'); as[a] = (as[a] || 0) + 1; }
    const top = Math.max(...Object.values(as));
    const extra = k.startsWith('web') ? '  websites ' + new Set(rs.map(r => r.website)).size : '';
    console.log(k.padEnd(13) + ' rows ' + String(rs.length).padStart(5) + '  inputs ' + String(qs.size).padStart(5) + '  replies ' + String(Object.keys(as).length).padStart(5) + '  top ' + (top / rs.length * 100).toFixed(1) + '%' + extra);
  }

  const pv = sh(patch), nPV = Math.round(pv.length * 0.06);
  const strip = r => ({ messages: r.messages });
  const train = sh(pv.slice(nPV).concat(webTrain, molmo, replay)).map(strip);
  // the held-back check costs ~10 s a row on this Mac: a seeded 60 of v3.1's validation and 60 web steps keep one check near 25 min
  const v31vs = sh(v31v).slice(0, 60), webVs = sh(webValid).slice(0, 60);
  const valid = v31vs.concat(pv.slice(0, nPV).map(strip), webVs.map(strip));
  const dir = D('bonsai_jarvis_v4'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'train.jsonl'), train.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'valid.jsonl'), valid.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'valid_parts.json'), JSON.stringify({ v31: v31vs.length, patch: nPV, web: webVs.length }) + '\n');
  console.log('wrote data/bonsai_jarvis_v4 — train ' + train.length + ' (chat patch ' + (pv.length - nPV) + ', web ' + webTrain.length + ', molmo start ' + molmo.length + ', v3.1 replay ' + replay.length +
    '), valid ' + valid.length + ' (v3.1 ' + v31vs.length + ', patch ' + nPV + ', web ' + webVs.length + ')');
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
