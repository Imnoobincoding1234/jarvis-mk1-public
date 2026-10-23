#!/usr/bin/env node
// jarvis v4.1 data, 2026-10-04 — his call: keep the web, fix knowledge, resolver balance, feelings, banter; and (his idea)
// answer factual questions from a fetched source. Written AFTER the v4.1 held-outs (jarvis_heldout_v41.json,
// v41_web_heldout.jsonl, v41_grounded_heldout.json); rows matching any held-out sentence are dropped and named.
// = chat patch (data/v41_parts/chat_patch.js: resolver contrast pairs, feelings, banter/identity/jokes, Hinglish honesty
//   and statements)
// + knowledge: STOCK Bonsai's own answers, hand-reviewed (v41_knowledge_answers.jsonl + v41_knowledge_review.json)
// + grounded: answers from a Wikipedia source (v41_grounded_answers.jsonl + v41_grounded_review.json, prompt = jarvis-os/grounded.js),
//   honest "the source does not say" when it does not, and wrong-page declines
// + seeded replays of v4's training rows: 600 chat (its patch + v3.1 replay), 700 web (Mind2Web steps + MolmoWeb starts).
// Validation: v4's 140 rows in their order (v3.1 60, v4 patch 21, web 59) + 6% of the new patch.
// His rule: very diverse — diversity printed per kind; no reply over 3% of its kind or 3 rows (excess dropped).
//   node build_bonsai_data_v41.js → data/bonsai_jarvis_v41/
const fs = require('fs');
const path = require('path');
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.build_bonsai.json';
const J = require('../jarvis-os/server.js');
const cx = require('../jarvis-os/context.js');
const G = require('../jarvis-os/grounded.js');

let seed = 41414;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];
const sh = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nm = () => pick(['Sir', 'Mihir', 'Boss']);
const P = require('./data/v41_parts/chat_patch.js')({ pick });
const NORMAL = { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61 };
const D = f => path.join(__dirname, 'data', f);
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const readJson = f => JSON.parse(fs.readFileSync(D(f), 'utf8'));

(async () => {
  const sysP = await J._systemPrompt(null, { over: { stats: Object.assign({}, NORMAL), down: [] } });
  const rows = [];
  const fill = s => s.replace(/\{n\}/g, () => nm());
  const add = (kind, q, a) => rows.push({ kind, messages: [{ role: 'system', content: sysP }, { role: 'user', content: q }, { role: 'assistant', content: fill(a) }] });
  const two = (kind, q, replies) => { for (const a of sh(replies).slice(0, 2)) add(kind, q, a); };
  const res = (kind, convo, req, ans) => {
    const msgs = convo.map(([role, content]) => ({ role, content: fill(content) })).concat([{ role: 'user', content: req }]);
    const p = cx.standsForPrompt(req, msgs);
    if (p) rows.push({ kind, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }, { role: 'assistant', content: ans }] });
  };

  // ---- resolver: same-conversation contrast, ≈1:1 NONE vs named ----
  for (const [q, a, name, kind] of P.GROUP) {
    const convo = [['user', q], ['assistant', a]];
    for (const r of sh(P.PERSON_REQ_HE).slice(0, 3)) res('resolve_none', convo, r, 'NONE');
    for (const r of sh(kind === 'band' ? P.BAND_REQ : P.ORG_REQ).slice(0, 2)) res('resolve', convo, r, name);
  }
  for (const [q, a, name, pron, type] of P.PERSON) {
    const convo = [['user', q], ['assistant', a]];
    res('resolve', convo, pick(pron === 'she' ? P.PERSON_REQ_SHE : P.PERSON_REQ_HE), name);
    const t = (P.TYPE_REQ[type] || {})[pron];
    if (t) res('resolve', convo, pick(t), name);
  }
  for (const [q, a, thing, maker, pron] of P.THING) {
    const convo = [['user', q], ['assistant', a]];
    for (const r of sh(P.THING_REQ).slice(0, 2)) res('resolve', convo, r, thing);
    if (maker) for (const r of sh(pron === 'she' ? P.PERSON_REQ_SHE : P.PERSON_REQ_HE).slice(0, 2)) res('resolve', convo, r, maker);
  }
  for (const [q, a] of P.TWO) for (const r of sh(P.THING_REQ).slice(0, 3)) res('resolve_none', [['user', q], ['assistant', a]], r, 'NONE');
  for (const [q, a] of P.SMALL) for (const r of sh(P.SMALL_REQ).slice(0, 2)) res('resolve_none', [['user', q], ['assistant', a]], r, 'NONE');

  // ---- feelings ----
  for (const [q, tips] of P.BAD) for (const tip of sh(tips).slice(0, 2)) add('feel', q, pick(P.OPEN_BAD.concat(P.OPEN_BAD_HI)) + ' ' + tip);
  for (const [q, replies] of P.FEEL) two('feel', q, replies);
  // ---- banter ----
  for (const [q, replies] of P.IDENTITY) two('identity', q, replies);
  for (const q of P.JOKE_EN) { const a = P.jokeR(false); add('joke', q, a); let b = P.jokeR(false); for (let i = 0; b === a && i < 9; i++) b = P.jokeR(false); add('joke', q, b); }
  for (const q of P.JOKE_HI) { const a = P.jokeR(true); add('joke', q, a); let b = P.jokeR(true); for (let i = 0; b === a && i < 9; i++) b = P.jokeR(true); add('joke', q, b); }
  for (const q of P.FACT_EN) { add('funfact', q, P.factR(false)); add('funfact', q, P.factR(false)); }
  for (const q of P.FACT_HI) { add('funfact', q, P.factR(true)); add('funfact', q, P.factR(true)); }
  for (const [q, replies] of P.PLAY) two('banter', q, replies);
  for (const [q, replies] of P.ABOUT) two('banter', q, replies);
  // ---- honesty, statements ----
  for (const q of P.HON_EN) two('honest', q, P.HON_R_EN);
  for (const q of P.HON_HI) two('honest', q, P.HON_R_HI);
  for (const [q, replies] of P.STATE) two('noclaim', q, replies);

  // ---- knowledge: stock Bonsai's own answers, hand-reviewed ----
  const KR = readJson('v41_knowledge_review.json');
  const keepK = new Set(KR.keep);
  let nK = 0;
  for (const r of readJsonl(D('v41_knowledge_answers.jsonl'))) {
    const a = keepK.has(r.q) ? r.a.replace(/\s+/g, ' ').trim() : KR.cut[r.q];
    if (!a) continue;
    add('know', r.q, a); nK++;
    if (r.hi) add('know', r.hi, a);
  }

  // ---- grounded: answer from the source, or say the source does not say ----
  const GR = fs.existsSync(D('v41_grounded_review.json')) ? readJson('v41_grounded_review.json') : null;
  const declEN = [t => 'The page I found (' + t + ') does not say. Want me to search again?', t => 'That source is about ' + t + ' and does not answer it. Should I look elsewhere?',
    t => 'The ' + t + ' page does not cover that — I would rather search again than guess.', () => 'Nothing in the source answers that, {n}. Want me to try another search?',
    () => 'The source I have does not say, so I will not guess. Search again?', t => 'I only have the ' + t + ' page, and it does not answer that. Another search?'];
  const declHI = [t => 'Jo page mila (' + t + ') usme yeh nahi likha. Dobara search karun?', t => t + ' wale page mein iska jawab nahi hai. Kahin aur dekhun?',
    () => 'Source mein yeh nahi hai, {n} — guess nahi karunga. Phir se search karun?'];
  const groundedRow = (kind, q, source, a) => rows.push({ kind, messages: [{ role: 'system', content: sysP }, { role: 'user', content: G.userMessage(q, source) }, { role: 'assistant', content: fill(a) }] });
  const gAns = readJsonl(D('v41_grounded_answers.jsonl')).filter(r => r.source);
  if (GR) {
    const keepG = new Set(GR.keep);
    for (const r of gAns) {
      const a = keepG.has(r.q) ? r.a.replace(/\s+/g, ' ').trim() : GR.cut[r.q];
      if (a) { groundedRow('grounded', r.q, r.source, a); if (r.hi) groundedRow('grounded', r.hi, r.source, a); continue; }
      if (GR.decline[r.q]) { groundedRow('grounded_decline', r.q, r.source, pick(declEN)(r.source.title)); if (r.hi) groundedRow('grounded_decline', r.hi, r.source, pick(declHI)(r.source.title)); }
    }
    // wrong page: a question with another topic's source (a search that landed elsewhere)
    const pool = gAns.filter(r => keepG.has(r.q) || GR.cut[r.q]);
    for (const r of sh(pool).slice(0, 50)) {
      const other = pick(gAns.filter(o => o.topic !== r.topic));
      const hi = r.hi && rnd() < 0.5;
      groundedRow('grounded_decline', hi ? r.hi : r.q, other.source, pick(hi ? declHI : declEN)(other.source.title));
    }
  } else console.log('NOTE: no v41_grounded_review.json yet — grounded rows skipped');

  // ---- held-out sentences are never trained ----
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const held = new Set();
  for (const f of ['jarvis_heldout_v41.json', 'jarvis_heldout_v4.json', 'jarvis_heldout_v31.json', 'jarvis_heldout_v3.json', 'jarvis_heldout_v2.json', 'jarvis_heldout.json']) {
    const H = readJson(f);
    for (const k of ['greet', 'caps', 'chat', 'reasoning']) for (const c of H[k]) held.add(norm(c.q)); for (const c of H.resolver) held.add(norm(c.request));
  }
  for (const r of readJson('v41_grounded_heldout.json').items) held.add(norm(r.q));
  for (const l of fs.readFileSync(D('casual_stress_heldout.jsonl'), 'utf8').split('\n').filter(Boolean)) held.add(norm(JSON.parse(l).text));
  const userOf = r => { const u = r.messages[r.messages.length - 2].content; const m = u.match(/REQUEST: ([^\n]*)\nSTANDS FOR:$/) || u.match(/^QUESTION: ([^\n]*)/); return norm(m ? m[1] : u); };
  const leak = rows.filter(r => held.has(userOf(r)));
  if (leak.length) console.log('dropped ' + leak.length + ' rows matching held-out sentences: ' + [...new Set(leak.map(userOf))].join(' | '));
  const kindN = {}; for (const r of rows) kindN[r.kind] = (kindN[r.kind] || 0) + 1;
  const used = {}, patch = []; let capped = 0;
  for (const r of rows.filter(r => !held.has(userOf(r)))) {
    const a = r.kind + '\u0000' + r.messages[r.messages.length - 1].content.replace(/\b(Sir|Mihir|Boss)\b/g, '{n}');
    if ((used[a] = (used[a] || 0) + 1) > Math.max(3, Math.ceil(kindN[r.kind] * 0.03)) && r.kind !== 'resolve_none') { capped++; continue; }
    patch.push(r);
  }
  if (capped) console.log('dropped ' + capped + ' rows over the per-reply cap');

  // ---- replays of v4's training rows ----
  const v4t = readJsonl(D('bonsai_jarvis_v4/train.jsonl'));
  const isWeb = r => r.messages[0].content.startsWith('You are JARVIS, operating a web page');
  const webR = sh(v4t.filter(isWeb)).slice(0, 700).map(r => Object.assign({ kind: 'replay_web' }, r));
  const chatR = sh(v4t.filter(r => !isWeb(r))).slice(0, 600).map(r => Object.assign({ kind: 'replay_chat' }, r));
  const webHeld = new Set(readJsonl(D('v41_web_heldout.jsonl')).map(r => norm(r.task)));
  const webLeak = webR.filter(r => webHeld.has(norm(r.messages[1].content.split('\n')[0].replace(/^TASK: /, ''))));
  if (webLeak.length) console.log('WARNING: ' + webLeak.length + ' web replay rows share a task with the web held-out — dropped');
  const webKeep = webR.filter(r => !webLeak.includes(r));

  // ---- diversity report (new rows) ----
  const by = {};
  for (const r of patch) (by[r.kind] = by[r.kind] || []).push(r);
  for (const [k, rs] of Object.entries(by).sort()) {
    const qs = new Set(rs.map(userOf)), as = {};
    for (const r of rs) { const a = r.messages[r.messages.length - 1].content.replace(/\b(Sir|Mihir|Boss)\b/g, '{n}'); as[a] = (as[a] || 0) + 1; }
    const top = Math.max(...Object.values(as));
    console.log(k.padEnd(17) + ' rows ' + String(rs.length).padStart(5) + '  inputs ' + String(qs.size).padStart(5) + '  replies ' + String(Object.keys(as).length).padStart(5) + '  top ' + (top / rs.length * 100).toFixed(1) + '%');
  }
  const nNone = patch.filter(r => r.kind === 'resolve_none').length, nNamed = patch.filter(r => r.kind === 'resolve').length;
  console.log('resolver NONE ' + nNone + ' : named ' + nNamed + '   knowledge questions ' + nK);

  const pv = sh(patch), nPV = Math.round(pv.length * 0.06);
  const strip = r => ({ messages: r.messages });
  const train = sh(pv.slice(nPV).concat(webKeep, chatR)).map(strip);
  const v4v = readJsonl(D('bonsai_jarvis_v4/valid.jsonl'));
  const valid = v4v.concat(pv.slice(0, nPV).map(strip));
  const dir = D('bonsai_jarvis_v41'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'train.jsonl'), train.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'valid.jsonl'), valid.map(r => JSON.stringify(r)).join('\n') + '\n');
  // v4's valid file order: v3.1 60, v4 patch 21, web (the rest); then the new patch
  fs.writeFileSync(path.join(dir, 'valid_parts.json'), JSON.stringify({ v31: 60, patch: 21, web: v4v.length - 81, patch41: nPV }) + '\n');
  console.log('wrote data/bonsai_jarvis_v41 — train ' + train.length + ' (new ' + (pv.length - nPV) + ', web replay ' + webKeep.length + ', chat replay ' + chatR.length +
    '), valid ' + valid.length + ' (v4 ' + v4v.length + ', new ' + nPV + ')');
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
