// MEASUREMENT SCRIPT — B · timed requests (finetune/README.md, pre-registered 2026-10-14).
//   1. Stage 1's margin, chosen by LEAVE-ONE-OUT on timedintent.js's exemplars only: each exemplar classified by a
//      classifier built without it; the margin = the one with 0 non-later exemplars called "later" and the most later ones
//      caught (ties → the larger margin).
//   2. The held-out (finetune/data/timed_heldout_v1.jsonl, written before the exemplars) ONCE, whole pipeline: stage 1 at
//      that margin, then — only on a hit — stage 2: the local model JARVIS's llm() uses for a 'cheap' call, with the same
//      JSON schema and prompt (timedintent.SCHEMA / systemFor), temperature 0, through Ollama on this Mac. Nothing leaves the
//      Mac, nothing is acted on, no JARVIS state is written. Stage 2 is also run on every held-out line as a DIAGNOSTIC
//      (reported separately; the pipeline numbers are the result).
//   node sweeps/sweep_timed.js     → finetune/runs/timed_20261014/heldout_run.json
'use strict';
const fs = require('fs');
const path = require('path');
const intent = require('../intent.js');
const T = require('../timedintent.js');

const ROOT = path.join(__dirname, '..', '..');
const OUTDIR = path.join(ROOT, 'finetune', 'runs', 'timed_20261014');
const HELD = path.join(ROOT, 'finetune', 'data', 'timed_heldout_v1.jsonl');
const MODEL = process.env.JARVIS_LOCAL_MODEL || 'qwen2.5:3b-instruct-q4_K_M';

async function stage2(q, now) {
  const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({
    model: MODEL, stream: false, keep_alive: '5m', format: T.SCHEMA,
    messages: [{ role: 'system', content: T.systemFor(now) }, { role: 'user', content: q }],
    options: { temperature: 0, num_ctx: 4096 } }) }).then(x => x.json());
  let j = null; try { j = JSON.parse((r && r.message && r.message.content) || ''); } catch (e) {}
  return j;
}
function expectedWhen(label, now) {
  if (label.delay != null) return now + label.delay * 60000;
  const [h, m, day] = label.at; const d = new Date(now); d.setHours(h, m, 0, 0);
  if (day === 'tomorrow') d.setDate(d.getDate() + 1); else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  // ---- 1. leave-one-out on the exemplars ----
  const loo = [];
  for (const [region, list] of Object.entries(T.EXEMPLARS)) {
    for (const e of list) {
      const ex = {}; for (const [r, l] of Object.entries(T.EXEMPLARS)) ex[r] = l.filter(x => !(r === region && x === e));
      const clf = intent.makeClassifier({ exemplars: ex, minMargin: -1, none: 'not_later', groups: T.GROUPS, label: 'TimedLOO', jlog: () => {} });
      const res = await clf(e);
      loo.push({ region, e, later: !!(res && res.id === 'later'), margin: res && res.id === 'later' ? res.margin : null });
    }
  }
  const nLater = loo.filter(x => x.region === 'later').length;
  const grid = []; for (let m = 0; m <= 0.1001; m += 0.005) grid.push(+m.toFixed(3));
  const rows = grid.map(m => ({ m, caught: loo.filter(x => x.region === 'later' && x.later && x.margin >= m).length,
    falseLater: loo.filter(x => x.region !== 'later' && x.later && x.margin >= m).length }));
  const ok = rows.filter(r => r.falseLater === 0);
  const best = ok.length ? ok.reduce((a, b) => (b.caught > a.caught || (b.caught === a.caught && b.m > a.m)) ? b : a) : null;
  console.log('LOO (later exemplars ' + nLater + '):'); for (const r of rows) console.log('  margin ' + r.m.toFixed(3) + '  caught ' + r.caught + '/' + nLater + '  false later ' + r.falseLater);
  for (const x of loo.filter(x => x.region !== 'later' && x.later)) console.log('  LOO look-alike called later: [' + x.region + '] ' + x.e + ' (' + x.margin.toFixed(3) + ')');
  if (!best) { console.log('NO MARGIN gives 0 false later on the exemplars — stop: B is not wired.'); process.exit(1); }
  console.log('CHOSEN margin ' + best.m + ' (caught ' + best.caught + '/' + nLater + ', 0 false later)');

  // ---- 2. the held-out, once ----
  const H = fs.readFileSync(HELD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const clf = T.classifier(best.m);
  const now = Date.now();
  const out = [];
  for (const it of H) {
    const s1 = await clf(it.q);
    const hit = !!(s1 && s1.id === 'later');
    const t0 = Date.now();
    const j = await stage2(it.q, now);
    const ms = Date.now() - t0;
    const when = T.whenOf(j, now), task = String((j && j.task) || '').trim();
    const s2sched = !!(when && task);
    const scheduled = hit && s2sched;               // THE PIPELINE
    let timeOk = null, taskOk = null;
    if (it.kind === 'later' && s2sched) {
      const want = expectedWhen(it.label, now);
      timeOk = it.label.delay != null ? Math.abs(when - want) <= 60000 : when === want;
      taskOk = it.label.task.every(w => task.toLowerCase().includes(w.toLowerCase()));
    }
    out.push({ id: it.id, kind: it.kind, lang: it.lang, q: it.q, stage1: hit, s1margin: s1 ? s1.margin : null, stage2: j, ms,
      s2scheduled: s2sched, scheduled, when: when ? new Date(when).toString() : null, timeOk, taskOk });
    console.log((it.kind === 'later' ? (scheduled ? 'CAUGHT ' : 'missed ') : (scheduled ? 'WRONG  ' : 'ok     ')) + it.id + ' ' +
      (hit ? 'S1+' : 'S1-') + (s2sched ? 'S2+' : 'S2-') + ' ' + JSON.stringify(it.q) +
      (s2sched ? ' → ' + new Date(when).toLocaleTimeString() + ' "' + task + '"' + (timeOk === false ? ' TIME✗' : '') + (taskOk === false ? ' TASK✗' : '') : ''));
  }
  const later = out.filter(x => x.kind === 'later'), other = out.filter(x => x.kind === 'other');
  const caught = later.filter(x => x.scheduled);
  const R = {
    margin: best.m, model: MODEL,
    pipeline: { laterScheduled: caught.length + '/' + later.length, othersScheduled: other.filter(x => x.scheduled).length,
      timeOk: caught.filter(x => x.timeOk).length + '/' + caught.length, taskOk: caught.filter(x => x.taskOk).length + '/' + caught.length,
      hinglishLater: later.filter(x => x.lang === 'hinglish' && x.scheduled).length + '/' + later.filter(x => x.lang === 'hinglish').length },
    diagnostic: { stage1LaterHit: later.filter(x => x.stage1).length + '/' + later.length, stage1OtherHit: other.filter(x => x.stage1).length,
      stage2AloneLater: later.filter(x => x.s2scheduled).length + '/' + later.length, stage2AloneOther: other.filter(x => x.s2scheduled).length,
      stage2MedianMs: out.map(x => x.ms).sort((a, b) => a - b)[out.length >> 1] },
    bars: 'later ≥ 27/30 · others 0 · time ≥ 90% · task ≥ 90% (README, pre-registered)',
  };
  console.log('\nRESULT ' + JSON.stringify(R, null, 1));
  fs.writeFileSync(path.join(OUTDIR, 'heldout_run.json'), JSON.stringify({ result: R, loo, rows, items: out }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
