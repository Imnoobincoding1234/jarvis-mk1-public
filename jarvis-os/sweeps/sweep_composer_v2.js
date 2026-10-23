// MEASUREMENT SCRIPT — composer v2 (finetune/README "Composer v2 — ask instead of sending his indirect words", pre-registered
// 2026-10-15 before the held-out existed). Baseline B = today's agent.composeStrict; candidate C = the same function with
// JARVIS_COMPOSE_JUDGE=1 (a yes/no judge instead of the five-letter invented() check; neither draft accepted + `reported` → ask).
// Both policies see the SAME two drafts per row: qwen writes them once (phase `drafts`), and phase `score` replays them through
// the REAL agent.compose with a stub llm — the code under test decides, nothing is copied into this script. The judges' answers
// (phase `judge`) are replayed the same way. One model in memory at a time; nothing is sent or acted on.
//
// BEFORE RUNNING: no training running, Dream off, lid open (Ollama-backed), his usual apps open (timings are a bar).
//   node sweeps/sweep_composer_v2.js drafts      → runs/composer_v2_20261015/drafts.json, blind_sheet.txt, key.json (do not open),
//                                                   grades_template.json
//   node sweeps/sweep_composer_v2.js judge J1    → judge_J1.json (qwen2.5:3b, the composer's own model — warm, no swap)
//   node sweeps/sweep_composer_v2.js judge J2    → judge_J2.json (jarvis on its own llama-server, port 11437 — every swap timed)
//   …grade blind_sheet.txt by reading → grades.json ({code: {faithful, invented, indirect, note}}), saved before anything below
//   node sweeps/sweep_composer_v2.js score       → result.json + the bar table
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('../agent.js');
const MP = require('../modelprofile.js');

const ROOT = path.join(__dirname, '..', '..');
// (the two overrides exist only for tests/test_composer_v2.js, which scores fake rows with no model)
const OUT = process.env.COMPOSER_V2_OUT || path.join(ROOT, 'finetune', 'runs', 'composer_v2_20261015');
const HELD = process.env.COMPOSER_V2_HELD || path.join(ROOT, 'finetune', 'data', 'composer_heldout_v2.jsonl');
const OLLAMA = 'http://127.0.0.1:11434/api/chat';
const COMPOSER = 'qwen2.5:3b-instruct-q4_K_M';                    // .env JARVIS_LOCAL_MODEL — the model composeStrict runs on
const JUDGES = { J1: COMPOSER, J2: 'jarvis' };
const LORA_PORT = '11437';                                         // never the live llama-server's port (11436)

const rows = () => fs.readFileSync(HELD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const readJson = f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const writeJson = (f, x) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(x, null, 1));
const median = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };

function unloadOllama() {
  try { for (const m of execFileSync('ollama', ['ps'], { encoding: 'utf8' }).split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean)) execFileSync('ollama', ['stop', m]); }
  catch (e) {}
}
// The composer's call exactly as server.js localChat makes it for qwen: its context (8192), its answer budget for max_tokens 60,
// no temperature (qwen's own default — the drafts are samples, which is why both policies must see the same ones).
const qwenCtx = () => MP.ctxFor(MP.profileFor(COMPOSER), 8192);
async function qwen(body) {
  return fetch(OLLAMA, { method: 'POST', body: JSON.stringify(Object.assign({ model: COMPOSER, think: false, stream: false, keep_alive: '5m' }, body)) })
    .then(x => x.json());
}
const qwenPing = () => qwen({ messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 1, num_ctx: qwenCtx(), use_mmap: true } });

async function drafts() {
  fs.mkdirSync(OUT, { recursive: true });
  if (fs.existsSync(path.join(OUT, 'drafts.json'))) throw new Error('drafts.json exists — drafts are written once (move it aside to redo)');
  unloadOllama();
  await qwenPing();                                                // loaded once; the timings below are warm
  const H = rows(), out = [];
  const prof = MP.profileFor(COMPOSER), ctx = qwenCtx();
  for (const it of H) {
    const ds = [];
    for (let k = 0; k < 2; k++) {
      const t0 = Date.now();
      const j = await qwen({ messages: [{ role: 'system', content: A.strictComposeSystem(it.to) }, { role: 'user', content: it.body }],
        options: { num_predict: MP.fitTokens(prof, 60, ctx), num_ctx: ctx, use_mmap: true } });
      const raw = (j && j.message && j.message.content) || '';
      ds.push({ raw, text: A.cleanDraft(raw), ms: Date.now() - t0 });
    }
    out.push({ id: it.id, drafts: ds });
    console.log(it.id + '  ' + ds.map(d => d.ms + 'ms').join(' '));
  }
  unloadOllama();
  writeJson('drafts.json', out);
  // The blind sheet: every text that could reach the confirm card — draft 1, draft 2, his body as it stands — once per distinct
  // text in a row, shuffled across rows, its source behind a code. The key is written apart and opened only by `score`.
  const items = [];
  for (const d of out) {
    const it = H.find(x => x.id === d.id), seen = new Map();
    for (const [src, text] of [['d1', d.drafts[0].text], ['d2', d.drafts[1].text], ['body', it.body]]) {
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
  console.log('wrote drafts.json, blind_sheet.txt (' + order.length + ' texts), key.json, grades_template.json');
}

// ---- judges ----
const envFromFile = (() => {   // only the names loraserver reads — the live .env, so J2 runs the live base + adapter
  const m = {};
  try { for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const x = l.match(/^\s*(JARVIS_LORA_(?:NAME|BASE|ADAPTER)|JARVIS_CHAT_REPLY_(?:RUNTIME|CTX))\s*=\s*(.*)$/); if (x) m[x[1]] = x[2].trim().replace(/^["']|["']$/g, ''); } } catch (e) {}
  return m;
})();
async function judgeJ1(messages) {
  const t0 = Date.now();
  const j = await qwen({ messages, logprobs: true, top_logprobs: 20, options: { num_predict: 1, num_ctx: qwenCtx(), temperature: 0, use_mmap: true } });
  return { logprobs: (j && j.logprobs) || null, ms: Date.now() - t0 };
}
let L = null;
async function judgeJ2(messages) {
  if (!L) {
    L = require('../loraserver.js');
    L.init({ jlog: () => {}, root: ROOT, envVal: n => (n === 'JARVIS_LORA_PORT' ? LORA_PORT : envFromFile[n] || null) });
  }
  const t0 = Date.now();
  const ctx = MP.ctxFor(MP.profileFor('jarvis'), Number(envFromFile.JARVIS_CHAT_REPLY_CTX) || 4096);
  const j = await L.chat({ model: 'jarvis', think: false, stream: false, keep_alive: '10m', logprobs: true, top_logprobs: 20, messages,
    options: { num_predict: 1, num_ctx: ctx, temperature: 0, use_mmap: true } }, 120000);
  return { logprobs: (j && j.logprobs) || null, ms: Date.now() - t0 };
}
const timed = async f => { const t0 = Date.now(); await f(); return Date.now() - t0; };

async function judge(which) {
  if (!JUDGES[which]) throw new Error('judge J1 or J2');
  const D = readJson('drafts.json'), H = rows(), out = [];
  unloadOllama();
  if (which === 'J1') await qwenPing();                            // the composer's model, warm as it is after a draft
  for (const d of D) {
    const it = H.find(x => x.id === d.id), res = [];
    for (let k = 0; k < 2; k++) {
      const msgs = A.composeJudgeMessages(it.text, it.body, it.to, d.drafts[k].text);
      if (which === 'J1') { res.push(await judgeJ1(msgs)); continue; }
      // J2, the way it would run live: qwen is resident after writing the draft; the one-model gate evicts it to start
      // jarvis (timed with the judge), and the next draft or message pays for qwen coming back (timed as reload).
      await qwenPing();
      const evict = await timed(async () => unloadOllama());
      const r = await judgeJ2(msgs);
      r.ms += evict;
      r.reloadMs = await timed(async () => { await L.stop('swap back to the composer'); await qwenPing(); });
      res.push(r);
    }
    const share = r => { const v = require('../grounded.js').checkVerdict(r.logprobs); return v ? v.share : null; };
    out.push({ id: d.id, judged: res.map(r => Object.assign({ share: share(r) }, r)) });
    console.log(which + ' ' + d.id + '  ' + res.map(r => r.ms + 'ms').join(' '));
  }
  if (L) await L.stop('sweep done');
  unloadOllama();
  writeJson('judge_' + which + '.json', out);
  console.log('wrote judge_' + which + '.json');
}

// ---- score: replay both policies through the real agent.compose ----
async function replay(it, d, jrow) {
  let served = 0; const judgedIdx = [];
  A.init({
    jlog: () => {},
    llm: async () => { served++; if (served > 2) throw new Error('a third draft was asked for'); return { text: d.drafts[served - 1].raw }; },
    judge: async () => { judgedIdx.push(served - 1); return jrow ? jrow.judged[served - 1].logprobs : null; },
    envVal: n => (n === 'JARVIS_COMPOSE_JUDGE' && jrow ? '1' : ''),
  });
  const r = await A.compose({ kind: 'message', strict: true, said: it.body, message: it.text, recipient: it.to, reported: true });
  const src = r && !r.ok && r.data && r.data.asked ? 'ask' : r && r.ok && r.data && r.data.verbatim ? 'body' : r && r.ok ? 'd' + served : 'other';
  return { src, served, judgedIdx, text: r && r.text, say: r && r.say };
}

async function score() {
  const H = rows(), D = readJson('drafts.json'), key = readJson('key.json'), grades = readJson('grades.json');
  const ungraded = Object.keys(key).filter(c => !grades[c] || typeof grades[c].faithful !== 'boolean' || typeof grades[c].invented !== 'boolean');
  if (ungraded.length) throw new Error(ungraded.length + ' texts ungraded (' + ungraded.slice(0, 5).join(', ') + '…) — grade every one first');
  const codeOf = {};
  for (const [code, k] of Object.entries(key)) for (const s of k.srcs) codeOf[k.id + ':' + s] = code;
  const judges = Object.keys(JUDGES).filter(w => fs.existsSync(path.join(OUT, 'judge_' + w + '.json')));
  const J = Object.fromEntries(judges.map(w => [w, readJson('judge_' + w + '.json')]));
  const outcome = (id, src) => { if (src === 'ask') return 'ASK'; const g = grades[codeOf[id + ':' + src]]; return g && g.faithful ? 'SEND-OK' : 'SEND-BAD'; };
  const perRow = [];
  for (const it of H) {
    const d = D.find(x => x.id === it.id);
    const b = await replay(it, d, null);
    const row = { id: it.id, lang: it.lang, B: Object.assign(b, { outcome: outcome(it.id, b.src), ms: d.drafts[0].ms + (b.served > 1 ? d.drafts[1].ms : 0) }) };
    for (const w of judges) {
      const jrow = J[w].find(x => x.id === it.id);
      const c = await replay(it, d, jrow);
      const j = jrow.judged;
      // model time this row costs under C: the drafts written, each judge call the code made (J2: + qwen coming back after each,
      // for the next draft or the next message)
      let ms = d.drafts[0].ms + (c.served > 1 ? d.drafts[1].ms : 0);
      for (const k of c.judgedIdx) ms += j[k].ms + (w === 'J2' ? j[k].reloadMs : 0);
      const acceptedInvented = /^d[12]$/.test(c.src) && grades[codeOf[it.id + ':' + c.src]].invented;
      row[w] = Object.assign(c, { outcome: outcome(it.id, c.src), ms, addedMs: ms - row.B.ms, acceptedInvented });
    }
    perRow.push(row);
  }
  const count = (pol, o, rs) => (rs || perRow).filter(r => r[pol].outcome === o).length;
  const res = { rows: perRow.length, B: { sendOk: count('B', 'SEND-OK'), ask: count('B', 'ASK'), sendBad: count('B', 'SEND-BAD'), medianMs: median(perRow.map(r => r.B.ms)) } };
  const hing = perRow.filter(r => r.lang === 'hinglish');
  for (const w of judges) {
    const bad = count(w, 'SEND-BAD');
    const x = { model: JUDGES[w], sendOk: count(w, 'SEND-OK'), ask: count(w, 'ASK'), sendBad: bad,
      lostSends: perRow.filter(r => r.B.outcome === 'SEND-OK' && r[w].outcome !== 'SEND-OK').length,
      acceptedInvented: perRow.filter(r => r[w].acceptedInvented).length,
      hinglishSendBad: count(w, 'SEND-BAD', hing), medianAddedMs: median(perRow.map(r => r[w].addedMs)) };
    x.bars = { sendBad: bad <= 3 && bad <= res.B.sendBad / 2, lostSends: x.lostSends <= 3, acceptedInvented: x.acceptedInvented === 0,
      hinglish: x.hinglishSendBad <= 1, time: x.medianAddedMs <= 1500 };
    x.passes = Object.values(x.bars).every(Boolean);
    res[w] = x;
  }
  const passing = judges.filter(w => res[w].passes).sort((a, b) => res[a].sendBad - res[b].sendBad || res[a].medianAddedMs - res[b].medianAddedMs);
  res.choice = passing[0] || null;
  writeJson('result.json', Object.assign({}, res, { perRow }));
  console.log(JSON.stringify(res, null, 1));
  console.log(res.choice ? 'SHIPS (to the gate next): ' + res.choice + ' = ' + JUDGES[res.choice] : 'NO JUDGE PASSES — nothing changes');
}

const [cmd, arg] = process.argv.slice(2);
(cmd === 'drafts' ? drafts() : cmd === 'judge' ? judge(arg) : cmd === 'score' ? score() : Promise.reject(new Error('drafts | judge J1|J2 | score')))
  .catch(e => { console.error(e.message || e); process.exit(1); });
