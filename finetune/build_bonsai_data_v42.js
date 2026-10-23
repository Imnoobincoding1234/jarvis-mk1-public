#!/usr/bin/env node
// jarvis v4.2 "the masters" data, 2026-10-05 — written AFTER the v4.2 held-outs (jarvis_heldout_v42.json, v42_web_heldout.jsonl,
// v42_grounded_heldout.json); finetune/README "jarvis v4.2". ONE curated set — no random replay of older hand-template chat rows
// (their cross-wired replies are what v4.1 kept). Every chat row has its OWN clock and weather (promptclock.js; 20% no weather =
// offline) and greetings follow that clock. Every row carries "kind" so train_bonsai.py scores the held-back error per kind.
//   kinds: feel greet attn honest noclaim ack caps banter mine know grounded grounded_decline resolve resolve_none reason web
// His rule: very diverse — diversity printed per kind; no reply over 3% of its kind or 3 rows (excess dropped).
//   node build_bonsai_data_v42.js → data/bonsai_jarvis_v42/
const fs = require('fs');
const path = require('path');
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.build_bonsai.json';
const J = require('../jarvis-os/server.js');
const cx = require('../jarvis-os/context.js');
const G = require('../jarvis-os/grounded.js');
const C = require('./promptclock');

let seed = 42424;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const sh = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nm = () => pick(['Sir', 'Atharv', 'Boss']);
const D = f => path.join(__dirname, 'data', f);
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const readJson = f => JSON.parse(fs.readFileSync(D(f), 'utf8'));
const NORMAL = { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61 };

const P41 = require('./data/v41_parts/chat_patch.js')({ pick });
const P4 = require('./data/v4_parts/chat_patch.js')({ pick, int, cap: s => s, fmt: n => String(n) });   // v4's capability truths
const FEEL42 = require('./data/v42_parts/feelings.js');
const GR = require('./data/v42_parts/greetings.js')({ pick });
const CORE = require('./data/v42_parts/core.js')({ pick });
const BANTER = require('./data/v42_parts/banter.js');
const REASON = require('./data/v42_parts/reasoning.js')({ pick, int });

(async () => {
  const sysCache = {};
  const sysFor = async (stats, down) => { const k = JSON.stringify([stats, down]); return sysCache[k] = sysCache[k] || await J._systemPrompt(null, { over: { stats: Object.assign({}, NORMAL, stats || {}), down: down || [] } }); };
  const rsys = await J._systemPrompt(J.REASON_EXTRA, { state: 'full', over: { stats: NORMAL, down: [] } });
  const rows = [];
  const fill = s => s.replace(/\{n\}/g, () => nm());
  // one chat row: its own clock (from a bucket, or any) and weather (random, or given; null = offline)
  const chat = async (kind, q, a, o = {}) => {
    const d = C.randomClock(rnd, o.bucket);
    const sys = C.setClock(await sysFor(o.stats, o.down), d, 'weather' in o ? o.weather : C.randomWeather(rnd));
    rows.push({ kind, messages: [{ role: 'system', content: sys }, { role: 'user', content: q }, { role: 'assistant', content: fill(a) }] });
  };
  const two = async (kind, q, replies, o) => { for (const a of sh(replies).slice(0, 2)) await chat(kind, q, a, o); };
  const res = (kind, convo, req, ans) => {
    const msgs = convo.map(([role, content]) => ({ role, content: fill(content) })).concat([{ role: 'user', content: req }]);
    const p = cx.standsForPrompt(req, msgs);
    if (p) rows.push({ kind, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }, { role: 'assistant', content: ans }] });
  };

  // ===== feelings: v4.2's 70 inputs + v4.1's 54 =====
  for (const [q, replies] of FEEL42) await two('feel', q, replies);
  for (const [q, replies] of P41.FEEL) await two('feel', q, replies);
  for (const [q, tips] of P41.BAD) for (const tip of sh(tips).slice(0, 2)) await chat('feel', q, pick(P41.OPEN_BAD.concat(P41.OPEN_BAD_HI)) + ' ' + tip);

  // ===== greetings, by the clock =====
  const B = ['early', 'morning', 'afternoon', 'evening', 'night', 'late'];
  for (const q of GR.GENERIC) for (const b of sh(B).slice(0, 3)) await chat('greet', q, pick(GR.HI[b]), { bucket: b });
  for (const q of GR.MORNING) for (const b of ['morning', 'early']) await chat('greet', q, pick(GR.HI[b].concat(['Good morning, {n}!', 'Morning! Sleep well?'])), { bucket: b });
  for (const q of GR.WOKE.q) await two('greet', q, GR.WOKE.r, { bucket: 'morning' });
  for (const q of GR.NIGHT.q) for (const b of ['night', 'late']) await chat('greet', q, pick(GR.NIGHT.r), { bucket: b });
  for (const [p, said] of GR.PLACES) for (const f of sh(GR.ARRIVE_Q).slice(0, 2)) await chat('greet', f(p), GR.arriveR(said), { bucket: pick(['afternoon', 'evening']) });
  for (const q of GR.HOME.q) await two('greet', q, GR.HOME.r, { bucket: pick(['afternoon', 'evening', 'night']) });
  for (const q of GR.LEAVE.q) await two('greet', q, GR.LEAVE.r);
  for (const q of GR.PRESENT.q) await two('greet', q, GR.PRESENT.r);
  for (const q of GR.HOWZIT.q) await two('greet', q, GR.HOWZIT.r);
  // attention: the prompt's "Needs attention" items, said plainly; an agent's name is never his name
  for (let i = 0; i < 96; i++) {
    const b = pick(B), q = pick(GR.ATTN_Q), stats = {}, down = [], says = [];
    const which = sh(['battery', 'disk', 'down']).slice(0, rnd() < 0.2 ? 2 : 1);
    for (const w of which) {
      if (w === 'battery') { stats.batteryPct = int(4, 19); stats.charging = false; says.push(GR.ISSUE.battery(stats.batteryPct)); }
      if (w === 'disk') { stats.diskPct = int(92, 99); says.push(GR.ISSUE.disk(stats.diskPct)); }
      if (w === 'down') { const n = sh(GR.AGENTS).slice(0, rnd() < 0.25 ? 2 : 1); down.push(...n); says.push(n.length > 1 ? n.join(' and ') + ' are down' : GR.ISSUE.down(n[0])); }
    }
    const tail = which.includes('battery') && rnd() < 0.4 ? pick([' Plug in when you can.', ' Charger lagao.']) : rnd() < 0.3 ? ' Otherwise all good.' : '';
    await chat('attn', q, pick(GR.ATTN_OPEN[b]) + pick(GR.ATTN_JOIN) + says.join(', and ') + '.' + tail, { bucket: b, stats, down });
  }

  // ===== honesty: no record in this conversation =====
  const honEN = CORE.HON_R_EN.concat(P41.HON_R_EN), honHI = CORE.HON_R_HI.concat(P41.HON_R_HI);
  for (const q of CORE.HON_EN.concat(P41.HON_EN)) await two('honest', q, honEN);
  for (const q of CORE.HON_HI.concat(P41.HON_HI)) await two('honest', q, honHI);
  // ===== statements: claim nothing =====
  for (const [q, replies] of CORE.STATE.concat(P41.STATE)) await two('noclaim', q, replies);

  // ===== acks: short and honest; lanes do the work =====
  for (const a of CORE.APPS) {
    await chat('ack', pick(CORE.OPEN_EN)(a), CORE.openR(a, false)); await chat('ack', pick(CORE.OPEN_HI)(a), CORE.openR(a, true));
    await chat('ack', pick(CORE.CLOSE_EN)(a), CORE.closeR(a, false)); await chat('ack', pick(CORE.CLOSE_HI)(a), CORE.closeR(a, true));
  }
  for (const m of CORE.MUSIC) { await chat('ack', pick(CORE.PLAY_EN)(m), CORE.playR(m, false)); await chat('ack', pick(CORE.PLAY_HI)(m), CORE.playR(m, true)); }
  for (const [qs, replies] of CORE.MEDIA) for (const q of qs) await chat('ack', q, pick(replies));
  for (const t of CORE.TASKS) { const w = pick(CORE.TIMES); await chat('ack', pick(CORE.REMIND_EN)(t, w), CORE.remindR(t, w, false)); const w2 = pick(CORE.TIMES); await chat('ack', pick(CORE.REMIND_HI)(t, w2), CORE.remindR(t, w2, true)); }
  for (const w of CORE.ALARM_T) { await chat('ack', pick(CORE.ALARM_EN)(w), CORE.alarmR(w, false)); await chat('ack', pick(CORE.ALARM_HI)(w), CORE.alarmR(w, true)); }
  for (const [p, P] of CORE.PEOPLE) { const s = pick(CORE.SAY); await chat('ack', pick(CORE.MSG_EN)(p, s), CORE.msgR(P, s, false)); const s2 = pick(CORE.SAY); await chat('ack', pick(CORE.MSG_HI)(p, s2), CORE.msgR(P, s2, true)); }
  for (const [qs, replies] of CORE.CALLS) for (const q of qs) await chat('ack', q, pick(replies));
  for (const [q, w] of CORE.SEARCH) await chat('ack', q, CORE.searchR(w));

  // ===== capability truths (v4.2's + v4's), one row per wording; the offline ones half without a weather line =====
  for (const [qs, replies] of CORE.CAPS) for (const q of qs) await chat('caps', q, pick(replies), rnd() < 0.5 ? { weather: null } : {});
  for (const [qs, replies] of P4.CAPS) for (const q of qs) await chat('caps', q, pick(replies));

  // ===== banter, identity, jokes, facts, opinions; his own messages =====
  const MINE_N = 68;   // the first 68 entries of banter.js are his real messages
  for (const [i, [q, replies]] of BANTER.entries()) await two(i < MINE_N ? 'mine' : 'banter', q, replies);
  for (const [q, replies] of P41.IDENTITY.concat(P41.PLAY, P41.ABOUT)) await chat('banter', q, pick(replies));
  for (const q of P41.JOKE_EN) await chat('banter', q, P41.jokeR(false));
  for (const q of P41.JOKE_HI) await chat('banter', q, P41.jokeR(true));
  for (const q of P41.FACT_EN) await chat('banter', q, P41.factR(false));
  for (const q of P41.FACT_HI) await chat('banter', q, P41.factR(true));

  // ===== knowledge: stock Bonsai's own reviewed answers (v4.1) =====
  const KR = readJson('v41_knowledge_review.json'), keepK = new Set(KR.keep);
  for (const r of readJsonl(D('v41_knowledge_answers.jsonl'))) {
    const a = keepK.has(r.q) ? r.a.replace(/\s+/g, ' ').trim() : KR.cut[r.q];
    if (!a) continue;
    await chat('know', r.q, a); if (r.hi) await chat('know', r.hi, a);
  }

  // ===== grounded: answers from the source (snippet-only answers twice), fewer declines than v4.1 =====
  const declEN = [t => 'The page I found (' + t + ') does not say. Want me to search again?', t => 'That source is about ' + t + ' and does not answer it. Should I look elsewhere?',
    t => 'The ' + t + ' page does not cover that — I would rather search again than guess.', () => 'Nothing in the source answers that, {n}. Want me to try another search?',
    () => 'The source I have does not say, so I will not guess. Search again?', t => 'I only have the ' + t + ' page, and it does not answer that. Another search?'];
  const declHI = [t => 'Jo page mila (' + t + ') usme yeh nahi likha. Dobara search karun?', t => t + ' wale page mein iska jawab nahi hai. Kahin aur dekhun?', () => 'Source mein yeh nahi hai, {n} — guess nahi karunga. Phir se search karun?'];
  const gsys = async () => C.setClock(await sysFor(), C.randomClock(rnd), C.randomWeather(rnd));
  const grow = async (kind, q, source, a) => rows.push({ kind, messages: [{ role: 'system', content: await gsys() }, { role: 'user', content: G.userMessage(q, source) }, { role: 'assistant', content: fill(a) }] });
  // does the answer live only in the snippets (not the lead)? then it is the case v4.1 declined — train it twice
  const snippetOnly = (source, a) => { const [lead, snips] = source.text.split('\nSearch matches:\n'); if (!snips) return false;
    const names = (a.match(/\b[A-Z][\w'’.-]+(?: [A-Z][\w'’.-]+)*|\d[\d,.]*/g) || []).filter(w => w.length > 2 && !/^(The|This|It|Its|In|A|An|As|There)$/.test(w));
    return names.length > 0 && names.some(w => !lead.includes(w) && snips.includes(w)); };
  let nSnip = 0;
  const groundedSet = async (answersFile, reviewFile, declineShare) => {
    if (!fs.existsSync(D(reviewFile))) { console.log('NOTE: no ' + reviewFile + ' yet — skipped'); return []; }
    const RV = readJson(reviewFile), keep = new Set(RV.keep), pos = [];
    const ans = readJsonl(D(answersFile)).filter(r => r.source);
    for (const r of ans) {
      const a = keep.has(r.q) ? r.a.replace(/\s+/g, ' ').trim() : RV.cut[r.q];
      if (a) { const times = snippetOnly(r.source, a) ? 2 : 1; if (times > 1) nSnip++;
        for (let t = 0; t < times; t++) await grow('grounded', r.q, r.source, a); if (r.hi) await grow('grounded', r.hi, r.source, a); pos.push(r); continue; }
      if (RV.decline[r.q] && rnd() < declineShare) { await grow('grounded_decline', r.q, r.source, pick(declEN)(r.source.title)); if (r.hi && rnd() < 0.5) await grow('grounded_decline', r.hi, r.source, pick(declHI)(r.source.title)); }
    }
    return pos.map(r => Object.assign({ ans }, r));
  };
  const pos41 = await groundedSet('v41_grounded_answers.jsonl', 'v41_grounded_review.json', 0.7);
  const pos42 = await groundedSet('v42_grounded_answers.jsonl', 'v42_grounded_review.json', 0.7);
  // wrong page: a question with another topic's source (25)
  const allAns = readJsonl(D('v41_grounded_answers.jsonl')).concat(readJsonl(D('v42_grounded_answers.jsonl'))).filter(r => r.source);
  for (const r of sh(pos41.concat(pos42)).slice(0, 25)) { const other = pick(allAns.filter(o => o.topic !== r.topic)); const hi = r.hi && rnd() < 0.5;
    await grow('grounded_decline', hi ? r.hi : r.q, other.source, pick(hi ? declHI : declEN)(other.source.title)); }

  // ===== resolver: v4.1's contrast rows (they scored 15/0/0) =====
  for (const [q, a, name, kind] of P41.GROUP) { const convo = [['user', q], ['assistant', a]];
    for (const r of sh(P41.PERSON_REQ_HE).slice(0, 3)) res('resolve_none', convo, r, 'NONE');
    for (const r of sh(kind === 'band' ? P41.BAND_REQ : P41.ORG_REQ).slice(0, 2)) res('resolve', convo, r, name); }
  for (const [q, a, name, pron, type] of P41.PERSON) { const convo = [['user', q], ['assistant', a]];
    res('resolve', convo, pick(pron === 'she' ? P41.PERSON_REQ_SHE : P41.PERSON_REQ_HE), name); const t = (P41.TYPE_REQ[type] || {})[pron]; if (t) res('resolve', convo, pick(t), name); }
  for (const [q, a, thing, maker, pron] of P41.THING) { const convo = [['user', q], ['assistant', a]];
    for (const r of sh(P41.THING_REQ).slice(0, 2)) res('resolve', convo, r, thing);
    if (maker) for (const r of sh(pron === 'she' ? P41.PERSON_REQ_SHE : P41.PERSON_REQ_HE).slice(0, 2)) res('resolve', convo, r, maker); }
  for (const [q, a] of P41.TWO) for (const r of sh(P41.THING_REQ).slice(0, 3)) res('resolve_none', [['user', q], ['assistant', a]], r, 'NONE');
  for (const [q, a] of P41.SMALL) for (const r of sh(P41.SMALL_REQ).slice(0, 2)) res('resolve_none', [['user', q], ['assistant', a]], r, 'NONE');

  // ===== reasoning: computed, each with its own clock =====
  const seenR = new Set();
  for (let i = 0; seenR.size < 160 && i < 20000; i++) { const g = REASON.GEN[i % REASON.GEN.length]; const r = g(); if (!r || seenR.has(r[0])) continue; seenR.add(r[0]);
    rows.push({ kind: 'reason', messages: [{ role: 'system', content: C.setClock(rsys, C.randomClock(rnd), C.randomWeather(rnd)) }, { role: 'user', content: r[0] }, { role: 'assistant', content: r[1] }] }); }

  // ===== held-out sentences are never trained =====
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const held = new Set();
  for (const f of ['jarvis_heldout_v42.json', 'jarvis_heldout_v41.json', 'jarvis_heldout_v4.json', 'jarvis_heldout_v31.json', 'jarvis_heldout_v3.json', 'jarvis_heldout_v2.json', 'jarvis_heldout.json']) {
    const H = readJson(f); for (const k of ['greet', 'caps', 'chat', 'reasoning']) for (const c of H[k]) held.add(norm(c.q)); for (const c of H.resolver) held.add(norm(c.request)); }
  for (const f of ['v41_grounded_heldout.json', 'v42_grounded_heldout.json']) for (const r of readJson(f).items) held.add(norm(r.q));
  for (const l of fs.readFileSync(D('casual_stress_heldout.jsonl'), 'utf8').split('\n').filter(Boolean)) held.add(norm(JSON.parse(l).text));
  const userOf = r => { const u = r.messages[r.messages.length - 2].content; const m = u.match(/REQUEST: ([^\n]*)\nSTANDS FOR:$/) || u.match(/^QUESTION: ([^\n]*)/); return norm(m ? m[1] : u); };
  const leak = rows.filter(r => held.has(userOf(r)));
  if (leak.length) console.log('dropped ' + leak.length + ' rows matching held-out sentences: ' + [...new Set(leak.map(userOf))].join(' | '));
  const kindN = {}; for (const r of rows) kindN[r.kind] = (kindN[r.kind] || 0) + 1;
  const used = {}, patch = []; let capped = 0;
  for (const r of rows.filter(r => !held.has(userOf(r)))) {
    const a = r.kind + '\u0000' + r.messages[r.messages.length - 1].content.replace(/\b(Sir|Atharv|Boss)\b/g, '{n}');
    if ((used[a] = (used[a] || 0) + 1) > Math.max(3, Math.ceil(kindN[r.kind] * 0.03)) && r.kind !== 'resolve_none') { capped++; continue; }
    patch.push(r);
  }
  if (capped) console.log('dropped ' + capped + ' rows over the per-reply cap');

  // ===== web: a seeded replay of v4's Mind2Web + MolmoWeb rows (no task from any web held-out) =====
  const v4t = readJsonl(D('bonsai_jarvis_v4/train.jsonl'));
  const isWeb = r => r.messages[0].content.startsWith('You are JARVIS, operating a web page');
  const webHeld = new Set(['v4_web_heldout.jsonl', 'v41_web_heldout.jsonl', 'v42_web_heldout.jsonl'].flatMap(f => readJsonl(D(f)).map(r => norm(r.task))));
  const taskOf = r => norm(r.messages[1].content.split('\n')[0].replace(/^TASK: /, ''));
  const web = sh(v4t.filter(r => isWeb(r) && !webHeld.has(taskOf(r)))).slice(0, 450).map(r => ({ kind: 'web', messages: r.messages }));

  // ===== diversity report =====
  const by = {};
  for (const r of patch.concat(web)) (by[r.kind] = by[r.kind] || []).push(r);
  for (const [k, rs] of Object.entries(by).sort()) {
    const qs = new Set(rs.map(userOf)), as = {};
    for (const r of rs) { const a = r.messages[r.messages.length - 1].content.replace(/\b(Sir|Atharv|Boss)\b/g, '{n}'); as[a] = (as[a] || 0) + 1; }
    console.log(k.padEnd(17) + ' rows ' + String(rs.length).padStart(5) + '  inputs ' + String(qs.size).padStart(5) + '  replies ' + String(Object.keys(as).length).padStart(5) + '  top ' + (Math.max(...Object.values(as)) / rs.length * 100).toFixed(1) + '%');
  }
  const clocks = new Set(patch.map(r => (r.messages[0].content.match(C.CLOCK_RE) || [''])[0])).size;
  console.log('distinct clocks ' + clocks + '; snippet-only grounded answers doubled: ' + nSnip);

  // ===== split: 6% of each kind (at least 4) held back; v4's web validation rows join as "web" =====
  const train = [], valid = [];
  const byKind = {}; for (const r of sh(patch)) (byKind[r.kind] = byKind[r.kind] || []).push(r);
  for (const [k, rs] of Object.entries(byKind)) { const n = Math.max(4, Math.round(rs.length * 0.06)); valid.push(...rs.slice(0, n)); train.push(...rs.slice(n)); }
  const v4v = readJsonl(D('bonsai_jarvis_v4/valid.jsonl')).filter(isWeb).map(r => ({ kind: 'web', messages: r.messages }));
  const all = sh(train.concat(web)), val = valid.concat(v4v);
  const dir = D('bonsai_jarvis_v42'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'train.jsonl'), all.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'valid.jsonl'), val.map(r => JSON.stringify(r)).join('\n') + '\n');
  const vk = {}; for (const r of val) vk[r.kind] = (vk[r.kind] || 0) + 1;
  console.log('wrote data/bonsai_jarvis_v42 — train ' + all.length + ' (curated ' + train.length + ', web ' + web.length + '), valid ' + val.length + ' ' + JSON.stringify(vk));
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
