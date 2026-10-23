// MEASUREMENT SCRIPT — composer v3 (finetune/README "Composer v3", 2026-10-19). What the v2 trial showed: the DRAFTS are the
// bottleneck (20 / 80 qwen drafts faithful; most failures are person conversion — "if he has the charger" kept about him, if-
// fragments, who-brings-what flipped), and the drafting model only ever saw the cut fragment, never his request.
//
// Phase `dev <drafter>` runs on composer_heldout_v2 — READ on 10-15, so it is the development set: one draft per row at
// temperature 0 with the v3 prompt (agent.composeDirectMessages: his whole request + the part to pass on + worked examples), for
// reading side by side. Drafters: qwen (the 3B the composer runs on today), phi (phi4-mini, already installed), jarvis (the chat
// model, on its OWN llama-server port 11437 — never the live 11436). One model in memory at a time; nothing is sent or acted on.
//   node sweeps/sweep_composer_v3.js dev qwen|phi|jarvis   → finetune/runs/composer_v3_20261019/dev_<drafter>.json
// DECISION (composer_heldout_v3, bars in the README written before this phase ran):
//   node sweeps/sweep_composer_v3.js drafts   → decision_drafts.json, blind_sheet.txt, key.json (do not open), grades_template.json
//     B = today: qwen, the old prompt shown only the body, two drafts at qwen's default temperature (as live), warm.
//     C = phi4-mini, the v3 prompt, one draft at temperature 0 with token logprobs — warm, then again COLD (qwen resident, evicted,
//         phi loaded — the swap the memory gate makes live) for the time bar.
//   …grade blind_sheet.txt by reading → grades.json ({code: {faithful, invented, indirect, note}}), saved before `score`
//   node sweeps/sweep_composer_v3.js score    → result.json + the bar table (both policies replayed through the real agent.compose)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const A = require('../agent.js');
const MP = require('../modelprofile.js');
const profile = require('../profile.js');
// The prompt names him and his pronouns from profile.js, as it does live (the v2 sweep never loaded the profile, so its prompts
// said "the user"). A COPY in a temp dir — nothing here can write his real profile.json.
{ const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-v3-profile-'));
  try { fs.copyFileSync(path.join(__dirname, '..', 'state', 'profile.json'), path.join(tmp, 'profile.json')); } catch (e) {}
  profile.init({ stateDir: tmp }); }

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'finetune', 'runs', 'composer_v3_20261019');
const DEV = path.join(ROOT, 'finetune', 'data', 'composer_heldout_v2.jsonl');
const HELD = path.join(ROOT, 'finetune', 'data', 'composer_heldout_v3.jsonl');
const HELD_SHA1 = 'c5eb4c5561458ff5e0128c25c1568daacb76be87';      // as written before the README pre-registration
const OLLAMA = 'http://127.0.0.1:11434/api/chat';
const DRAFTERS = { qwen: 'qwen2.5:3b-instruct-q4_K_M', phi: 'phi4-mini:latest', jarvis: 'jarvis', bonsai8b: 'hf.co/prism-ml/Bonsai-8B-gguf:Q1_0' };
// How sure the drafter was of each token it wrote (Ollama logprobs) — the machine's own signal, read with no word list.
const LOGPROBS = process.argv.includes('--logprobs');
const LORA_PORT = '11437';

const rows = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
function unloadOllama() {
  try { for (const m of execFileSync('ollama', ['ps'], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean)) execFileSync('ollama', ['stop', m]); }
  catch (e) {}
}
const envFromFile = (() => {   // only the names loraserver reads — the live .env, so jarvis runs the live base + adapter
  const m = {};
  try { for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const x = l.match(/^\s*(JARVIS_LORA_(?:NAME|BASE|ADAPTER)|JARVIS_CHAT_REPLY_(?:RUNTIME|CTX))\s*=\s*(.*)$/); if (x) m[x[1]] = x[2].trim().replace(/^["']|["']$/g, ''); } } catch (e) {}
  return m;
})();
let L = null;
async function chat(drafter, messages, opts) {
  const model = DRAFTERS[drafter];
  const options = Object.assign({ num_predict: 60, temperature: 0, use_mmap: true }, opts || {});
  if (drafter === 'jarvis') {
    if (!L) { L = require('../loraserver.js'); L.init({ jlog: () => {}, root: ROOT, envVal: n => (n === 'JARVIS_LORA_PORT' ? LORA_PORT : envFromFile[n] || null) }); }
    options.num_ctx = MP.ctxFor(MP.profileFor('jarvis'), Number(envFromFile.JARVIS_CHAT_REPLY_CTX) || 4096);
    return L.chat({ model: 'jarvis', think: false, stream: false, keep_alive: '10m', messages, options }, 120000);
  }
  options.num_ctx = MP.ctxFor(MP.profileFor(model), 8192);
  if (drafter === 'bonsai8b') options.num_predict = Math.max(options.num_predict, 400);   // it reasons before answering even with think off
  return fetch(OLLAMA, { method: 'POST', body: JSON.stringify(Object.assign({ model, think: false, stream: false, keep_alive: '5m', messages, options },
    LOGPROBS ? { logprobs: true } : {})) }).then(x => x.json());
}

async function dev(drafter) {
  if (!DRAFTERS[drafter]) throw new Error('drafter: ' + Object.keys(DRAFTERS).join(' | '));
  fs.mkdirSync(OUT, { recursive: true });
  const H = rows(DEV), out = [];
  unloadOllama();
  const tw = Date.now(); await chat(drafter, [{ role: 'user', content: 'hi' }], { num_predict: 1 }); const warmup = Date.now() - tw;
  for (const it of H) {
    const t0 = Date.now();
    const j = await chat(drafter, A.composeDirectMessages(it.text, it.body, it.to));
    const raw = String((j && j.message && j.message.content) || '');
    const lps = ((j && j.logprobs) || []).map(t => t.logprob).filter(x => typeof x === 'number');
    const lp = lps.length ? { mean: lps.reduce((a, b) => a + b, 0) / lps.length, min: Math.min(...lps), n: lps.length } : null;
    out.push({ id: it.id, lang: it.lang, text: it.text, body: it.body, draft: A.cleanDraft(MP.stripReasoning(raw)), raw, lp, ms: Date.now() - t0 });
    console.log(it.id.padEnd(4), String(Date.now() - t0).padStart(5) + 'ms', '|', it.text, '\n      →', A.cleanDraft(raw));
  }
  if (L) await L.stop('sweep done');
  unloadOllama();
  const ms = out.map(x => x.ms).sort((a, b) => a - b);
  fs.writeFileSync(path.join(OUT, 'dev_' + drafter + (LOGPROBS ? '_lp' : '') + '.json'), JSON.stringify({ drafter: DRAFTERS[drafter], warmup, median: ms[ms.length >> 1], rows: out }, null, 1));
  console.log('cold start', warmup, 'ms · median draft', ms[ms.length >> 1], 'ms');
}

// ---- decision ----------------------------------------------------------------------------------------------------------------
const readJson = f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const writeJson = (f, x) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(x, null, 1));
const median = xs => { const v = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
const QWEN = DRAFTERS.qwen, PHI = DRAFTERS.phi;
const ctxOf = m => MP.ctxFor(MP.profileFor(m), 8192);
const ollama = body => fetch(OLLAMA, { method: 'POST', body: JSON.stringify(Object.assign({ think: false, stream: false, keep_alive: '5m' }, body)) }).then(x => x.json());
const qwenPing = () => ollama({ model: QWEN, messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 1, num_ctx: ctxOf(QWEN), use_mmap: true } });
// exactly server.js composeDraft's call
const phiDraft = (msgs, ctx) => ollama({ model: PHI, logprobs: true, messages: msgs, options: { num_predict: 60, num_ctx: ctx || ctxOf(PHI), temperature: 0, use_mmap: true } });

async function decisionDrafts() {
  const sha = require('crypto').createHash('sha1').update(fs.readFileSync(HELD)).digest('hex');
  if (sha !== HELD_SHA1) throw new Error('composer_heldout_v3.jsonl changed since it was written (' + sha + ')');
  if (fs.existsSync(path.join(OUT, 'decision_drafts.json'))) throw new Error('decision_drafts.json exists — drafts are written once');
  const H = rows(HELD), out = [];
  // B — warm qwen, two drafts per row, the call composeStrict makes today
  unloadOllama(); await qwenPing();
  const qp = MP.profileFor(QWEN), qctx = ctxOf(QWEN);
  for (const it of H) {
    const ds = [];
    for (let k = 0; k < 2; k++) {
      const t0 = Date.now();
      const j = await ollama({ model: QWEN, messages: [{ role: 'system', content: A.strictComposeSystem(it.to) }, { role: 'user', content: it.body }],
        options: { num_predict: MP.fitTokens(qp, 60, qctx), num_ctx: qctx, use_mmap: true } });
      const raw = String((j && j.message && j.message.content) || '');
      ds.push({ raw, text: A.cleanDraft(raw), ms: Date.now() - t0 });
    }
    out.push({ id: it.id, B: ds });
    console.log('B ' + it.id + '  ' + ds.map(d => d.ms + 'ms').join(' '));
  }
  // C — warm phi4-mini, one draft per row at temperature 0
  unloadOllama(); await phiDraft([{ role: 'user', content: 'hi' }]);
  for (const it of H) {
    const t0 = Date.now();
    const j = await phiDraft(A.composeDirectMessages(it.text, it.body, it.to));
    const raw = String((j && j.message && j.message.content) || '');
    const lps = ((j && j.logprobs) || []).map(t => ({ logprob: t.logprob }));
    out.find(x => x.id === it.id).C = { raw, text: A.cleanDraft(raw), logprobs: lps, ms: Date.now() - t0 };
    console.log('C ' + it.id + '  ' + (Date.now() - t0) + 'ms');
  }
  // C cold — qwen resident (as live after the reader / helper), then the swap: qwen out, phi in, the draft
  for (const it of H) {
    unloadOllama(); await qwenPing();
    const t0 = Date.now();
    unloadOllama();
    const j = await phiDraft(A.composeDirectMessages(it.text, it.body, it.to));
    const row = out.find(x => x.id === it.id);
    row.C.coldMs = Date.now() - t0;
    row.C.coldSame = A.cleanDraft(String((j && j.message && j.message.content) || '')) === row.C.text;
    console.log('C cold ' + it.id + '  ' + row.C.coldMs + 'ms' + (row.C.coldSame ? '' : '  (draft differs from warm)'));
  }
  unloadOllama();
  writeJson('decision_drafts.json', out);
  // the blind sheet: every text that could reach the card — B's two drafts, C's draft, the body as it stands — once per distinct
  // text in a row, shuffled across rows, source behind a code; the key is apart and opened only by `score`
  const items = [];
  for (const d of out) {
    const it = H.find(x => x.id === d.id), seen = new Map();
    for (const [src, text] of [['b1', d.B[0].text], ['b2', d.B[1].text], ['c', d.C.text], ['body', it.body]]) {
      if (seen.has(text)) { seen.get(text).srcs.push(src); continue; }
      const x = { id: it.id, srcs: [src], text }; seen.set(text, x); items.push(x);
    }
  }
  const order = items.map(x => ({ x, k: Math.random() })).sort((a, b) => a.k - b.k).map(o => o.x);
  const key = {}, lines = [], template = {};
  order.forEach((x, i) => {
    const code = 'm' + String(i + 1).padStart(3, '0'), it = H.find(r => r.id === x.id);
    key[code] = { id: x.id, srcs: x.srcs };
    template[code] = { faithful: null, invented: null, indirect: null, note: '' };
    lines.push(code + ' | to ' + it.to + ' | he said: ' + it.text + '\n       to pass on: ' + it.body + '\n       message: ' + x.text);
  });
  fs.writeFileSync(path.join(OUT, 'blind_sheet.txt'), lines.join('\n') + '\n');
  writeJson('key.json', key);
  writeJson('grades_template.json', template);
  console.log('wrote decision_drafts.json, blind_sheet.txt (' + order.length + ' texts), key.json, grades_template.json');
}

async function replay(it, d, policy) {
  let served = 0;
  A.init({
    jlog: () => {},
    llm: async () => { served++; if (served > 2) throw new Error('a third draft was asked for'); return { text: d.B[served - 1].raw }; },
    draft: async () => ({ text: d.C.raw, logprobs: d.C.logprobs }),
    envVal: n => (n === 'JARVIS_COMPOSE_V3' && policy === 'C' ? '1' : ''),
  });
  const r = await A.compose(Object.assign({ kind: 'message', strict: true, said: it.body, message: it.text, recipient: it.to }, it.reported ? { reported: true } : {}));
  const src = r && !r.ok && r.data && r.data.asked ? 'ask' : r && r.ok && r.data && r.data.verbatim ? 'body'
    : r && r.ok ? (policy === 'C' ? 'c' : 'b' + served) : 'other';
  return { src, served, text: r && r.text, say: r && r.say, sure: r && r.data && r.data.sure };
}

async function score() {
  const H = rows(HELD), D = readJson('decision_drafts.json'), key = readJson('key.json'), grades = readJson('grades.json');
  const ungraded = Object.keys(key).filter(c => !grades[c] || typeof grades[c].faithful !== 'boolean' || typeof grades[c].invented !== 'boolean');
  if (ungraded.length) throw new Error(ungraded.length + ' texts ungraded (' + ungraded.slice(0, 5).join(', ') + '…) — grade every one first');
  const codeOf = {};
  for (const [code, k] of Object.entries(key)) for (const s of k.srcs) codeOf[k.id + ':' + s] = code;
  const outcome = (id, src) => { if (src === 'ask') return 'ASK'; const g = grades[codeOf[id + ':' + src]]; return g && g.faithful ? 'SEND-OK' : 'SEND-BAD'; };
  const per = [];
  for (const it of H) {
    const d = D.find(x => x.id === it.id);
    const b = await replay(it, d, 'B'), c = await replay(it, d, 'C');
    const bMs = d.B[0].ms + (b.served > 1 ? d.B[1].ms : 0);
    per.push({ id: it.id, lang: it.lang, reported: it.reported,
      B: Object.assign(b, { outcome: outcome(it.id, b.src), ms: bMs }),
      C: Object.assign(c, { outcome: outcome(it.id, c.src), addedWarm: d.C.ms - bMs, addedCold: d.C.coldMs - bMs,
        acceptedInvented: c.src === 'c' && grades[codeOf[it.id + ':c']].invented }) });
  }
  const rep = per.filter(r => r.reported), plain = per.filter(r => !r.reported), hing = rep.filter(r => r.lang === 'hinglish');
  const n = (rs, pol, o) => rs.filter(r => r[pol].outcome === o).length;
  const tab = rs => ({ B: { sendOk: n(rs, 'B', 'SEND-OK'), ask: n(rs, 'B', 'ASK'), sendBad: n(rs, 'B', 'SEND-BAD') },
                       C: { sendOk: n(rs, 'C', 'SEND-OK'), ask: n(rs, 'C', 'ASK'), sendBad: n(rs, 'C', 'SEND-BAD') } });
  const res = { reported: tab(rep), hinglishReported: tab(hing), plain: tab(plain),
    lostSends: per.filter(r => r.B.outcome === 'SEND-OK' && r.C.outcome !== 'SEND-OK').map(r => r.id),
    acceptedInvented: per.filter(r => r.C.acceptedInvented).map(r => r.id),
    plainNewBad: plain.filter(r => r.C.outcome === 'SEND-BAD' && r.B.outcome !== 'SEND-BAD').map(r => r.id),
    medianAddedColdMs: median(per.map(r => r.C.addedCold)), medianAddedWarmMs: median(per.map(r => r.C.addedWarm)),
    coldDraftsDiffer: D.filter(d => !d.C.coldSame).map(d => d.id) };
  const bad = res.reported.C.sendBad;
  res.bars = { '1 send-bad <=5 and <= half B': bad <= 5 && bad <= res.reported.B.sendBad / 2, '2 lost sends <=3': res.lostSends.length <= 3,
    '3 accepted invented <=1': res.acceptedInvented.length <= 1, '4 hinglish send-bad <=2': res.hinglishReported.C.sendBad <= 2,
    '5 plain: no new send-bad': res.plainNewBad.length === 0, '6 time cold <=4s, warm <=1.5s': res.medianAddedColdMs <= 4000 && res.medianAddedWarmMs <= 1500 };
  res.passes = Object.values(res.bars).every(Boolean);
  writeJson('result.json', Object.assign({}, res, { perRow: per }));
  console.log(JSON.stringify(res, null, 1));
  console.log(res.passes ? 'C PASSES THE BARS — the regression gate is next' : 'C FAILS — nothing changes');
}

// ---- C2 (README "Composer C2", 2026-10-22) on composer_heldout_v4 -----------------------------------------------------------
//   node sweeps/sweep_composer_v3.js c2drafts → runs/composer_c2_20261022/: decision_drafts.json (B's two qwen drafts per row; the
//     routing JARVIS's own intent.isHinglish gives body and request; C2's phi draft + logprobs for every reported row routed English,
//     warm then cold), blind_sheet.txt, key.json (do not open), grades_template.json
//   …grade blind_sheet.txt → grades.json, saved before `c2score`
//   node sweeps/sweep_composer_v3.js c2score  → result.json + the bar table
// Which set (and phi4-mini context) a C2 run is on: `c2drafts v4` (C2, 8192 — the 10-22 run) | `c2drafts v5` (C2-2k, 2048).
const C2SETS = {
  v4: { held: 'composer_heldout_v4.jsonl', sha1: '8810348abeb19af8bb98045d9718d95a7dd4d826', out: 'composer_c2_20261022', ctx: 8192 },
  v5: { held: 'composer_heldout_v5.jsonl', sha1: 'dd8745aa6198ca2e900afb9f427c5a62f650e066', out: 'composer_c2k_20261022', ctx: 2048 },
};
const C2SET = C2SETS[process.argv[3] || 'v4'] || C2SETS.v4;
const HELD4 = path.join(ROOT, 'finetune', 'data', C2SET.held);
const HELD4_SHA1 = C2SET.sha1;
const OUT2 = path.join(ROOT, 'finetune', 'runs', C2SET.out);
const PHI_CTX = C2SET.ctx;
const r2 = f => JSON.parse(fs.readFileSync(path.join(OUT2, f), 'utf8'));
const w2 = (f, x) => fs.writeFileSync(path.join(OUT2, f), JSON.stringify(x, null, 1));

async function c2Drafts() {
  console.log('C2 set ' + C2SET.held + ' · phi4-mini context ' + PHI_CTX);
  fs.mkdirSync(OUT2, { recursive: true });
  const sha = require('crypto').createHash('sha1').update(fs.readFileSync(HELD4)).digest('hex');
  if (sha !== HELD4_SHA1) throw new Error(C2SET.held + ' changed since it was written (' + sha + ')');
  if (fs.existsSync(path.join(OUT2, 'decision_drafts.json'))) throw new Error('decision_drafts.json exists — drafts are written once');
  const H = rows(HELD4), out = H.map(it => ({ id: it.id }));
  // the routing, from JARVIS's own detector — its name registries as live: his recipients (the gate sandbox's fixture idea) and
  // the installed apps (read only)
  const RECIPIENTS = new Set(H.map(it => it.to.toLowerCase()));
  const sysctl = require('../system_control.js');
  require('../lang.js').init({ isContact: n => RECIPIENTS.has(String(n || '').toLowerCase()),
    fuzzyApp: n => { try { return sysctl.fuzzyApp(n); } catch (e) { return null; } } });
  const intent = require('../intent.js');
  for (const it of H) {
    const o = out.find(x => x.id === it.id);
    o.route = { body: !!(await intent.isHinglish(it.body)), text: !!(await intent.isHinglish(it.text)) };
    o.route.hinglish = o.route.body || o.route.text;
    console.log('route ' + it.id + ' ' + (o.route.hinglish ? 'HINGLISH' : 'english ') + ' | ' + it.text);
  }
  unloadOllama(); await qwenPing();
  const qp = MP.profileFor(QWEN), qctx = ctxOf(QWEN);
  for (const it of H) {
    const ds = [];
    for (let k = 0; k < 2; k++) {
      const t0 = Date.now();
      const j = await ollama({ model: QWEN, messages: [{ role: 'system', content: A.strictComposeSystem(it.to) }, { role: 'user', content: it.body }],
        options: { num_predict: MP.fitTokens(qp, 60, qctx), num_ctx: qctx, use_mmap: true } });
      const raw = String((j && j.message && j.message.content) || '');
      ds.push({ raw, text: A.cleanDraft(raw), ms: Date.now() - t0 });
    }
    out.find(x => x.id === it.id).B = ds;
    console.log('B ' + it.id + '  ' + ds.map(d => d.ms + 'ms').join(' '));
  }
  const english = H.filter(it => it.reported && !out.find(x => x.id === it.id).route.hinglish);
  unloadOllama(); await phiDraft([{ role: 'user', content: 'hi' }], PHI_CTX);
  for (const it of english) {
    const t0 = Date.now();
    const j = await phiDraft(A.composeDirectMessages(it.text, it.body, it.to), PHI_CTX);
    const raw = String((j && j.message && j.message.content) || '');
    out.find(x => x.id === it.id).C = { raw, text: A.cleanDraft(raw), logprobs: ((j && j.logprobs) || []).map(t => ({ logprob: t.logprob })), ms: Date.now() - t0 };
    console.log('C2 ' + it.id + '  ' + (Date.now() - t0) + 'ms');
  }
  for (const it of english) {
    unloadOllama(); await qwenPing();
    const t0 = Date.now(); unloadOllama();
    const j = await phiDraft(A.composeDirectMessages(it.text, it.body, it.to), PHI_CTX);
    const row = out.find(x => x.id === it.id);
    row.C.coldMs = Date.now() - t0;
    row.C.coldSame = A.cleanDraft(String((j && j.message && j.message.content) || '')) === row.C.text;
    console.log('C2 cold ' + it.id + '  ' + row.C.coldMs + 'ms' + (row.C.coldSame ? '' : '  (draft differs from warm)'));
  }
  unloadOllama();
  w2('decision_drafts.json', out);
  const items = [];
  for (const d of out) {
    const it = H.find(x => x.id === d.id), seen = new Map();
    const cands = [['b1', d.B[0].text], ['b2', d.B[1].text], ['body', it.body]].concat(d.C ? [['c', d.C.text]] : []);
    for (const [src, text] of cands) {
      if (seen.has(text)) { seen.get(text).srcs.push(src); continue; }
      const x = { id: it.id, srcs: [src], text }; seen.set(text, x); items.push(x);
    }
  }
  const order = items.map(x => ({ x, k: Math.random() })).sort((a, b) => a.k - b.k).map(o => o.x);
  const key = {}, lines = [], template = {};
  order.forEach((x, i) => {
    const code = 'n' + String(i + 1).padStart(3, '0'), it = H.find(r => r.id === x.id);
    key[code] = { id: x.id, srcs: x.srcs };
    template[code] = { faithful: null, invented: null, indirect: null, note: '' };
    lines.push(code + ' | to ' + it.to + ' | he said: ' + it.text + '\n       to pass on: ' + it.body + '\n       message: ' + x.text);
  });
  fs.writeFileSync(path.join(OUT2, 'blind_sheet.txt'), lines.join('\n') + '\n');
  w2('key.json', key); w2('grades_template.json', template);
  console.log('wrote decision_drafts.json, blind_sheet.txt (' + order.length + ' texts), key.json, grades_template.json');
}

async function c2Replay(it, d, policy) {
  let served = 0;
  A.init({
    jlog: () => {},
    llm: async () => { served++; if (served > 2) throw new Error('a third draft was asked for'); return { text: d.B[served - 1].raw }; },
    draft: async () => { if (!d.C) throw new Error('C2 asked for a draft on a row it routes away from drafting'); return { text: d.C.raw, logprobs: d.C.logprobs }; },
    isHinglish: async t => (t === it.body ? d.route.body : t === it.text ? d.route.text : true),
    envVal: n => (n === 'JARVIS_COMPOSE_V3' && policy === 'C2' ? 'c2' : ''),
  });
  const r = await A.compose(Object.assign({ kind: 'message', strict: true, said: it.body, message: it.text, recipient: it.to }, it.reported ? { reported: true } : {}));
  const src = r && !r.ok && r.data && r.data.asked ? 'ask' : r && r.ok && r.data && r.data.verbatim ? 'body'
    : r && r.ok ? (policy === 'C2' ? 'c' : 'b' + served) : 'other';
  return { src, served, text: r && r.text, say: r && r.say, sure: r && r.data && r.data.sure, hinglish: !!(r && r.data && r.data.hinglish) };
}

async function c2Score() {
  const H = rows(HELD4), D = r2('decision_drafts.json'), key = r2('key.json'), grades = r2('grades.json');
  const ungraded = Object.keys(key).filter(c => !grades[c] || typeof grades[c].faithful !== 'boolean' || typeof grades[c].invented !== 'boolean');
  if (ungraded.length) throw new Error(ungraded.length + ' texts ungraded — grade every one first');
  const codeOf = {};
  for (const [code, k] of Object.entries(key)) for (const s of k.srcs) codeOf[k.id + ':' + s] = code;
  const outcome = (id, src) => { if (src === 'ask') return 'ASK'; if (src === 'other') return 'OTHER'; const g = grades[codeOf[id + ':' + src]]; return g && g.faithful ? 'SEND-OK' : 'SEND-BAD'; };
  const per = [];
  for (const it of H) {
    const d = D.find(x => x.id === it.id);
    const b = await c2Replay(it, d, 'B'), c = await c2Replay(it, d, 'C2');
    const bMs = d.B[0].ms + (b.served > 1 ? d.B[1].ms : 0);
    per.push({ id: it.id, lang: it.lang, reported: it.reported, routedHinglish: d.route.hinglish,
      B: Object.assign(b, { outcome: outcome(it.id, b.src), ms: bMs }),
      C2: Object.assign(c, { outcome: outcome(it.id, c.src), addedWarm: d.C ? d.C.ms - bMs : null, addedCold: d.C ? d.C.coldMs - bMs : null,
        acceptedInvented: c.src === 'c' && grades[codeOf[it.id + ':c']].invented }) });
  }
  const rep = per.filter(r => r.reported), plain = per.filter(r => !r.reported);
  const en = rep.filter(r => r.lang === 'en'), hi = rep.filter(r => r.lang === 'hinglish');
  const n = (rs, pol, o) => rs.filter(r => r[pol].outcome === o).length;
  const tab = rs => ({ B: { sendOk: n(rs, 'B', 'SEND-OK'), ask: n(rs, 'B', 'ASK'), sendBad: n(rs, 'B', 'SEND-BAD') },
                       C2: { sendOk: n(rs, 'C2', 'SEND-OK'), ask: n(rs, 'C2', 'ASK'), sendBad: n(rs, 'C2', 'SEND-BAD') } });
  const enRouted = rep.filter(r => !r.routedHinglish);
  const res = { reported: tab(rep), englishReported: tab(en), hinglishReported: tab(hi), plain: tab(plain),
    acceptedInvented: per.filter(r => r.C2.acceptedInvented).map(r => r.id),
    lostSendsReported: rep.filter(r => r.B.outcome === 'SEND-OK' && r.C2.outcome !== 'SEND-OK').map(r => r.id + (r.lang === 'hinglish' ? '(hi)' : '(en)')),
    routing: { hinglishRoutedToAsk: hi.filter(r => r.routedHinglish).length, englishRoutedHinglish: en.filter(r => r.routedHinglish).map(r => r.id),
               plainRows: plain.length },
    medianAddedColdMs: median(enRouted.map(r => r.C2.addedCold)), medianAddedWarmMs: median(enRouted.map(r => r.C2.addedWarm)),
    coldDraftsDiffer: D.filter(d => d.C && !d.C.coldSame).map(d => d.id) };
  const bad = res.reported.C2.sendBad;
  res.bars = {
    '1 reported send-bad <=2 and <= quarter of B': bad <= 2 && bad <= res.reported.B.sendBad / 4,
    '2 english send-ok >= B': res.englishReported.C2.sendOk >= res.englishReported.B.sendOk,
    '3 reported asks <=26': res.reported.C2.ask <= 26,
    '4 accepted invented <=1': res.acceptedInvented.length <= 1,
    '5 plain send-bad = 0': res.plain.C2.sendBad === 0,
    '6 routing 16/16 hinglish asked, <=2 english misrouted': res.routing.hinglishRoutedToAsk === hi.length && res.routing.englishRoutedHinglish.length <= 2,
    '7 time cold <=4s, warm <=1.5s': res.medianAddedColdMs <= 4000 && res.medianAddedWarmMs <= 1500 };
  res.passes = Object.values(res.bars).every(Boolean);
  w2('result.json', Object.assign({}, res, { perRow: per }));
  console.log(JSON.stringify(res, null, 1));
  console.log(res.passes ? 'C2 PASSES THE BARS — the regression gate is next' : 'C2 FAILS — nothing changes');
}

const [phase, arg] = process.argv.slice(2);
const run = phase === 'dev' ? dev(arg) : phase === 'drafts' ? decisionDrafts() : phase === 'score' ? score()
  : phase === 'c2drafts' ? c2Drafts() : phase === 'c2score' ? c2Score() : null;
if (!run) { console.log('usage: node sweeps/sweep_composer_v3.js dev qwen|phi|jarvis|bonsai8b [--logprobs] | drafts | score | c2drafts v4|v5 | c2score v4|v5'); process.exit(2); }
run.catch(e => { console.error(e.message || e); process.exit(1); });
