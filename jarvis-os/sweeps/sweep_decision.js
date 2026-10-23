'use strict';
// DECISION MODELS ON THE HELD-OUT (2026-10-13 — finetune/README "Decision models + Ollama 0.40.3 — sandbox trial", part 2).
// Each line of finetune/data/decision_heldout_v1.jsonl goes to a decision model with ONLY its own question (worded in
// build_decision_heldout.js), via the sandbox Ollama's POST /v1/systemone. The baseline runs what JARVIS uses today on the
// live Ollama. Nothing here routes, acts or writes JARVIS state. One model at a time; each is unloaded when it is done.
//   node sweeps/sweep_decision.js model <name> <out.jsonl>       (sandbox, port SANDBOX_PORT default 11435)
//   node sweeps/sweep_decision.js baseline <reader_live.json> <out.jsonl>   (live; act_now from sweep_ollama_update's live reader)
//   node sweeps/sweep_decision.js score <baseline.jsonl> <model1.jsonl> [<model2.jsonl> …]
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const FT = path.join(__dirname, '..', '..', 'finetune');
// DECISION_SET=v2 (2026-10-14): the fresh set of the reranker + nomic v2 trial, with play_now added.
const SET = process.env.DECISION_SET === 'v2' ? 'v2' : 'v1';
const { QUESTIONS } = require(path.join(FT, SET === 'v2' ? 'build_decision_heldout_v2.js' : 'build_decision_heldout.js'));
const ITEMS = fs.readFileSync(path.join(FT, 'data', 'decision_heldout_' + SET + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const SANDBOX = Number(process.env.SANDBOX_PORT || 11435);
const [, , mode, ...args] = process.argv;

const freePct = () => { try { return Number(execSync('sysctl -n kern.memorystatus_level').toString().trim()); } catch (e) { return null; } };
// Everything the sandbox server has spawned (its model runners), resident MB.
const sandboxRunnerMb = () => {
  try {
    const pid = (process.env.SANDBOX_PID || '').trim(); if (!pid) return null;
    const kids = execSync(`pgrep -P ${pid} || true`).toString().trim().split('\n').filter(Boolean);
    let kb = 0; for (const k of kids) kb += Number(execSync(`ps -o rss= -p ${k} || echo 0`).toString().trim()) || 0;
    return Math.round(kb / 1024);
  } catch (e) { return null; }
};
function post(port, pathname, body, timeoutMs) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      let s = ''; res.on('data', c => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: j ? null : s.slice(0, 300) }); });
    });
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, body: null, raw: String(e.message || e) }));
    req.end(data);
  });
}

async function runModel(model, out) {
  const w = fs.createWriteStream(out);
  let i = 0;
  for (const it of ITEMS) {
    const q = QUESTIONS[it.question];
    const f0 = freePct(), t0 = Date.now();
    const r = await post(SANDBOX, '/v1/systemone', { model, state: it.q, keep_alive: '5m',
      questions: { [it.question]: { type: 'noul', instructions: q.instructions, criteria: q.criteria } } });
    const ms = Date.now() - t0;
    const ans = r.body && r.body.answers && r.body.answers[it.question];
    const p = ans && typeof ans.noul === 'number' ? ans.noul : null;
    const rec = { id: it.id, question: it.question, lang: it.lang, label: it.label, p, pred: p === null ? null : p > 0.5,
      ms, first: i === 0, status: r.status, err: p === null ? (r.raw || (r.body && (r.body.error || JSON.stringify(r.body).slice(0, 200)))) : undefined,
      usage: r.body && r.body.usage, free_before: f0, free_after: freePct(), runner_mb: sandboxRunnerMb() };
    w.write(JSON.stringify(rec) + '\n');
    if (++i % 20 === 0 || rec.err) console.log(`${model} ${i}/${ITEMS.length} ${ms} ms free ${rec.free_after}% runner ${rec.runner_mb} MB${rec.err ? ' ERR ' + rec.err : ''}`);
  }
  w.end();
  await post(SANDBOX, '/api/generate', { model, keep_alive: 0 }, 30000);   // may not apply to decision models; the CLI stop follows
}

async function runBaseline(readerFile, out) {
  const replyclaim = require('../replyclaim.js');
  const selffact = require('../selffact.js');
  const webintent = require('../webintent.js');
  const live = JSON.parse(fs.readFileSync(readerFile, 'utf8')).reader;
  const w = fs.createWriteStream(out);
  for (const it of ITEMS) {
    let pred = null, note;
    if (it.question === 'act_now') { const r = live[it.q]; pred = r && r.reading ? r.reading.act !== 'none' : null; note = r && r.reading ? r.reading.act : 'no reading'; }
    else if (it.question === 'play_now') { const r = live[it.q]; pred = r && r.reading ? ['play', 'resume'].includes(r.reading.act) : null; note = r && r.reading ? r.reading.act : 'no reading'; }
    else if (it.question === 'claims_action') { const c = await replyclaim.replyClaimOf(it.q); pred = !!c && c !== 'none'; note = c; }
    else if (it.question === 'self_fact') { pred = !!(await selffact.isSelfFact(it.q)); }
    else if (it.question === 'needs_web') { pred = !!(await webintent.needsWeb(it.q)); }
    w.write(JSON.stringify({ id: it.id, question: it.question, lang: it.lang, label: it.label, pred, note }) + '\n');
  }
  w.end();
  console.log('baseline written', out);
}

function score(files) {
  const load = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
  const runs = files.map(f => ({ name: path.basename(f, '.jsonl'), rows: load(f) }));
  const base = runs[0];
  const acc = (rows, q, lang) => { const r = rows.filter(x => x.question === q && (!lang || x.lang === lang)); return { ok: r.filter(x => x.pred === x.label).length, n: r.length }; };
  const falseTrue = (rows, q) => rows.filter(x => x.question === (q || 'act_now') && !x.label && x.pred === true).length;
  console.log('question        ' + runs.map(r => r.name.slice(0, 22).padEnd(24)).join(''));
  for (const q of Object.keys(QUESTIONS)) {
    console.log(q.padEnd(16) + runs.map(r => { const a = acc(r.rows, q), h = acc(r.rows, q, 'hinglish'); return (a.n ? `${a.ok}/${a.n} (hi ${h.ok}/${h.n})` : '—').padEnd(24); }).join(''));
  }
  for (const q of ['act_now', 'play_now'].filter(q => QUESTIONS[q]))
    console.log(q + ' said true on a non-request: ' + runs.map(r => r.name.slice(0, 14) + ' ' + falseTrue(r.rows, q)).join(' · '));
  for (const r of runs.slice(1)) {
    const warm = r.rows.filter(x => !x.first && typeof x.ms === 'number').map(x => x.ms).sort((p, q) => p - q);   // no ms → runtime judged in that runner's own log
    const med = warm[Math.floor(warm.length / 2)];
    const maxMb = Math.max(...r.rows.map(x => x.runner_mb || 0));
    const minFree = Math.min(...r.rows.map(x => x.free_after).filter(x => x != null));
    const errs = r.rows.filter(x => x.err).length;
    const first = r.rows.find(x => x.first);
    console.log(`\n${r.name}: median warm ${med} ms (first call ${first && first.ms} ms) · resident ≤ ${maxMb} MB · lowest free ${minFree}% · errors ${errs}`);
    const runtimeOk = warm.length ? (med <= 1000 && maxMb <= 1536 && minFree >= 20 && !errs) : !errs;
    for (const q of Object.keys(QUESTIONS)) {
      const a = acc(r.rows, q), b = acc(base.rows, q), ah = acc(r.rows, q, 'hinglish'), bh = acc(base.rows, q, 'hinglish');
      if (!a.n) continue;                                   // a candidate that does not answer this question
      let pass = a.ok >= Math.ceil(0.9 * a.n) && a.ok >= b.ok + 2 && ah.ok >= bh.ok;
      if (q === 'act_now' || q === 'play_now') pass = pass && falseTrue(r.rows, q) <= falseTrue(base.rows, q);
      console.log(`  ${q.padEnd(14)} ${a.ok}/${a.n} vs baseline ${b.ok}/${b.n} · hinglish ${ah.ok}/${ah.n} vs ${bh.ok}/${bh.n} → ${pass && runtimeOk ? 'PASSES the bar' : 'does not pass'}${pass && !runtimeOk ? ' (accuracy yes, runtime no)' : ''}`);
    }
    const miss = r.rows.filter(x => x.pred !== x.label);
    for (const m of miss) console.log(`    miss ${m.id} label ${m.label} p ${m.p == null ? 'null' : Math.round(m.p * 1000) / 1000}  ${JSON.stringify(ITEMS.find(i => i.id === m.id).q)}`);
  }
}

if (mode === 'model') runModel(args[0], args[1]).catch(e => { console.error(e); process.exit(1); });
else if (mode === 'baseline') runBaseline(args[0], args[1]).catch(e => { console.error(e); process.exit(1); });
else if (mode === 'score') score(args);
else { console.log('usage: model <name> <out> · baseline <reader_live.json> <out> · score <baseline> <runs…>'); process.exit(1); }
