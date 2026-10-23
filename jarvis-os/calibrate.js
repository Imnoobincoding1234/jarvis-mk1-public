'use strict';
// ---------------------------------------------------------------------------
// calibrate.js — measure a model instead of guessing at it.
//
//   node calibrate.js                     # report the active model's profile
//   node calibrate.js <model>             # measure <model>, write its profile
//   node calibrate.js <model> --baseline  # also re-measure the incumbent, so
//                                         # the ratio is same-machine same-hour
//   node calibrate.js --list              # what is installed and what is known
//
// WHY. Every llm() budget in this project was set by watching qwen2.5:3b. Point
// the system at another model and those numbers become a rigged test: granite
// answered "capital of France" in 729 characters where the incumbent used 31,
// so a max_tokens:30 call truncates it and the scorecard blames the model.
// modelprofile.js scales the budgets; this file supplies the numbers it scales
// by, measured on THIS machine rather than read off a model card.
//
// WHAT IT REFUSES TO DO. It never pulls a model. This is an 8 GB machine and
// holding two candidates at once froze the screen badly enough to need a hard
// interrupt — the standing rule is one model at a time: pull, test, `ollama rm`,
// then the next. So this measures what is ALREADY installed and says plainly
// when it is not, rather than helpfully downloading 2 GB.
//
// HONESTY. Every number written here came from a request that actually ran. A
// probe that fails is reported as a failure and leaves that axis unmeasured; it
// is never quietly defaulted, because a made-up measurement is worse than an
// admitted guess. No dependencies, per this project's standing rule.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const MP = require('./modelprofile.js');

const OLLAMA = (process.env.JARVIS_LOCAL_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
let OUT = path.join(__dirname, 'state', 'modelprofiles.json');
// Tests point both this file and modelprofile.js at a scratch file — a test must never write his real state (2026-09-25).
function _setOut(f) { OUT = f; MP._setFile(f); }

// The probes. Fixed, small, and the same for every model, because a comparison
// is only meaningful if both sides answered the same questions.
//
// `cap` is deliberately generous: the point is to observe how much a model
// CHOOSES to say, and a tight cap would measure the cap instead of the model.
const PROBES = [
  { id: 'terse',  cap: 512, prompt: 'What is the capital of France?' },
  { id: 'short',  cap: 512, prompt: 'In one sentence, what does an operating system do?' },
  { id: 'list',   cap: 512, prompt: 'List three primary colours.' },
];

const SCHEMA_PROBE = {
  prompt: 'Give the capital of France.',
  schema: { type: 'object', properties: { capital: { type: 'string' } }, required: ['capital'], additionalProperties: false },
};

function j(o) { return JSON.stringify(o); }

// HOW A PROBE REACHES THE MODEL. Run from the command line, straight to Ollama's /api/chat. Run inside JARVIS (Settings →
// Models → Calibrate, 2026-10-17), server.js swaps in its own path — the memory gate first (one generation model at a time),
// then postChat, which sends `jarvis` to its llama-server — so a model is measured the way JARVIS actually runs it.
let chatCall = (body, timeoutMs) => post(OLLAMA + '/api/chat', body, timeoutMs);
function setTransport(fn) { chatCall = fn; }
function say(s) { process.stdout.write(s + '\n'); }

async function post(url, body, timeoutMs) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: j(body),
    signal: AbortSignal.timeout(timeoutMs || 180000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function installed() {
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const t = await r.json();
    // Ollama always reports an explicit tag. An untagged name never matches, so
    // compare against both forms rather than only what the user typed.
    return (t.models || []).map(m => String(m.name || m.model || ''));
  } catch (e) { return null; }
}

function isInstalled(list, want) {
  const w = String(want).toLowerCase();
  return list.some(n => {
    const l = n.toLowerCase();
    return l === w || l === w + ':latest' || l.replace(/:latest$/, '') === w.replace(/:latest$/, '');
  });
}

// One probe. Returns what actually happened, including a failure.
async function runProbe(model, probe) {
  const t0 = Date.now();
  try {
    const body = {
      model, stream: false, think: false,
      messages: [{ role: 'user', content: probe.prompt }],
      options: { num_predict: probe.cap, num_ctx: 4096, use_mmap: true },
    };
    const r = await chatCall(body, 180000);
    const ms = Date.now() - t0;
    const msg = r.message || {};
    const raw = String(msg.content || '') || String(msg.thinking || '');
    return {
      ok: true, ms,
      outTok: Number(r.eval_count) || 0,
      inTok: Number(r.prompt_eval_count) || 0,
      chars: raw.length,
      // Did it wrap its answer in a reasoning marker of any family?
      reasoned: raw !== MP.stripReasoning(raw) || !!msg.thinking,
      text: raw.slice(0, 160),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message };
  }
}

// The runtime does NOT use bare JSON.parse on a schema reply — server.js has
// parseJsonLoose, which tolerates code fences and stray prose. A probe stricter
// than the runtime it is measuring reports "cannot do schemas" for a model the
// system would in fact parse fine. Same tolerance here, deliberately.
function parseLoose(s) {
  if (!s) throw new Error('empty');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
}

// THE REQUEST FAILING IS NOT A MEASUREMENT OF THE MODEL.
//
// This used to wrap the request AND the parse in one try/catch and return the
// same `ok:false` for both, which measure() then wrote to disk as
// `schema: false` — a permanent capability verdict for what may have been
// Ollama busy loading another model and timing out. On this machine that is a
// real risk, not a hypothetical: the header of this file exists because two
// models resident at once froze it. A transient failure now leaves the axis
// UNMEASURED, which is what the rest of this file already promises.
async function probeSchema(model) {
  let r;
  try {
    r = await chatCall({
      model, stream: false, think: false,
      messages: [{ role: 'user', content: SCHEMA_PROBE.prompt }],
      format: SCHEMA_PROBE.schema,
      options: { num_predict: 200, num_ctx: 4096, use_mmap: true },
    }, 120000);
  } catch (e) {
    return { ok: false, transient: true, err: e.message };   // says nothing about the model
  }
  const raw = String((r.message || {}).content || (r.message || {}).thinking || '');
  try {
    const parsed = parseLoose(raw);
    return { ok: true, honoured: typeof parsed.capital === 'string' };
  } catch (e) {
    // A genuine non-compliance: the model answered, and what it said is not the
    // shape it was asked for.
    return { ok: true, honoured: false, sample: raw.slice(0, 80) };
  }
}

// Measure one model across every probe. Aggregate, not single-shot: one cold
// request is dominated by weight loading and says nothing about steady state.
async function measure(model) {
  const runs = [];
  for (const p of PROBES) runs.push(Object.assign({ id: p.id }, await runProbe(model, p)));
  const good = runs.filter(r => r.ok);
  if (!good.length) return { model, failed: true, runs };

  // The FIRST run pays the cold load. Steady-state speed is measured on the
  // rest — mixing them in reports the load time as if it were per-token cost,
  // which is how a fast model gets called slow.
  const warm = good.slice(1).length ? good.slice(1) : good;
  const totalOut = warm.reduce((a, r) => a + r.outTok, 0);
  const totalMs = warm.reduce((a, r) => a + r.ms, 0);
  const schema = await probeSchema(model);

  // A MEAN IS THE WRONG SUMMARY FOR A MEASUREMENT WITH OUTLIERS, and this one has
  // them. Measured on this machine: deepseek-r1:1.5b answering a twelve-probe set
  // produced a 112-SECOND run against a ~20s median — one probe that ran to the
  // token ceiling and returned nothing usable. The mean absorbed it and reported
  // a model roughly 40% slower than it actually is, and every budget in
  // modelprofile.js scales off these two numbers.
  //
  // The mean is KEPT, not replaced: the verbosity and speed ratios are defined
  // against it and changing that silently would move every stored profile's
  // meaning. p50 is recorded beside it so the gap between them is visible — when
  // they diverge, the mean is being dragged by something, and the run log says
  // which probe did it.
  const outToks = good.map(r => r.outTok);
  const perTok = warm.filter(r => r.outTok > 0).map(r => r.ms / r.outTok);
  return {
    model,
    failed: false,
    runs,
    outTokMean: good.reduce((a, r) => a + r.outTok, 0) / good.length,
    charsMean: good.reduce((a, r) => a + r.chars, 0) / good.length,
    msPerTok: totalOut ? totalMs / totalOut : null,
    outTokStats: stats(outToks),
    msPerTokStats: stats(perTok),
    coldMs: good[0].ms,
    reasoning: good.some(r => r.reasoned),
    // null, not false, when the request itself failed — see probeSchema.
    schema: schema.ok ? schema.honoured : null,
    schemaErr: schema.ok ? null : schema.err,
    schemaTransient: !!schema.transient,
  };
}

function loadOut() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch (e) { return {}; }
}
function saveOut(o) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(o, null, 1));
}

// A name longer than the column must not run into the value — pad to at least
// one space so the two are always separable.
function reportRow(label, value) { say('  ' + String(label).padEnd(22) + ' ' + value); }

// p50/p95/min/max/std for a list of per-probe values. Linear interpolation for
// the percentile, so a twelve-probe run gives a meaningful p95 rather than just
// "the largest sample". Returns null for an empty list — a made-up statistic is
// worse than an admitted absence, which is this file's standing rule.
function stats(values) {
  const v = (values || []).filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pct = p => {
    const k = (v.length - 1) * p, f = Math.floor(k), c = f + 1;
    return c >= v.length ? v[v.length - 1] : v[f] + (k - f) * (v[c] - v[f]);
  };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  const r = n => Number(n.toFixed(2));
  return { n: v.length, mean: r(mean), p50: r(pct(0.5)), p95: r(pct(0.95)),
           min: r(v[0]), max: r(v[v.length - 1]), std: r(Math.sqrt(variance)) };
}

// THE PROFILE A MEASUREMENT GIVES — shared by the command line and Settings (server.js), so both write the same numbers.
// verbosity and speed are ratios against the incumbent (a fresh baseline run when given, else the stored reference).
function profileFrom(target, cand, base) {
  const stored = loadOut();
  const REF = (stored._reference && stored._reference.outTokMean)
    ? stored._reference
    : { outTokMean: 12, msPerTok: 85, source: 'this project\'s stored figures' };
  const isBaseline = String(target).toLowerCase().includes(MP.BASELINE);
  const ref = (base && !base.failed) ? base : REF;
  const verbosity = isBaseline ? 1.0 : Number((cand.outTokMean / Math.max(1, ref.outTokMean)).toFixed(2));
  const speed = isBaseline ? 1.0
    : ((cand.msPerTok && ref.msPerTok) ? Number((cand.msPerTok / ref.msPerTok).toFixed(2)) : null);
  const prof = { verbosity, reasoning: cand.reasoning, measuredAt: new Date().toISOString() };
  // An UNMEASURED axis is omitted, never written as a value. Writing `false`
  // here for a timed-out request is how a transient failure becomes a permanent
  // verdict; omitting it lets profileFor fall back to the built-in default until
  // someone measures it properly.
  if (cand.schema !== null) prof.schema = cand.schema;
  if (speed != null) prof.speed = speed;
  const known = MP.profileFor(target);
  if (known.ctx) prof.ctx = known.ctx;                 // context is architectural, not measurable here
  return { prof, ref, isBaseline, verbosity, speed };
}
// Saved under the model's name; the profile it replaces is kept under `_previous` so Settings can put it back.
// Measuring the baseline teaches us what 1.0 actually IS on this machine today, which is what every other model's
// ratio is computed from — stored under a reserved key so it is never mistaken for a model's own profile.
function writeProfile(target, prof, cand, isBaseline) {
  const all = loadOut(), key = String(target).toLowerCase();
  all._previous = all._previous || {};
  all._previous[key] = all[key] || null;
  all[key] = prof;
  if (isBaseline) all._reference = { outTokMean: cand.outTokMean, msPerTok: cand.msPerTok, model: target, measuredAt: prof.measuredAt };
  saveOut(all);
  MP._reload();
}
// Settings → Undo: the profile before the last one saved for this model (none before = back to the built-in guess).
function undoProfile(target) {
  const all = loadOut(), key = String(target).toLowerCase();
  if (!all._previous || !(key in all._previous)) return false;
  if (all._previous[key]) all[key] = all._previous[key]; else delete all[key];
  delete all._previous[key];
  saveOut(all);
  MP._reload();
  return true;
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const target = args.find(a => !a.startsWith('--'));
  const list = await installed();

  if (list === null) {
    say('Ollama is not reachable at ' + OLLAMA + '. Start it and try again.');
    process.exit(1);
  }

  if (flags.has('--list')) {
    say('\nInstalled (' + list.length + '):');
    for (const n of list) {
      const p = MP.profileFor(n);
      reportRow(n, p.source + '  verbosity=' + p.verbosity + ' speed=' + p.speed);
    }
    say('\nBaseline is ' + MP.BASELINE + ' — 1.0 on both axes by definition.');
    process.exit(0);
  }

  const active = process.env.JARVIS_LOCAL_MODEL || MP.BASELINE;
  if (!target) {
    const p = MP.profileFor(active);
    say('\nActive model: ' + active);
    reportRow('profile source', p.source);
    reportRow('verbosity', p.verbosity + '  (output tokens vs the baseline)');
    reportRow('speed', p.speed + '  (wall clock per token vs the baseline)');
    reportRow('reasoning', String(!!p.reasoning));
    reportRow('schema', String(p.schema !== false));
    reportRow('context', String(p.ctx));
    if (p.source !== 'calibrated') {
      say('\nThis profile is a ' + p.source + ', not a measurement.');
      say('Measure it with:  node calibrate.js ' + active);
    }
    process.exit(0);
  }

  // NEVER PULL. One model at a time on this machine — see the header.
  if (!isInstalled(list, target)) {
    say('\n"' + target + '" is not installed, and this tool will not pull it.');
    say('This is an 8 GB machine and two candidates resident at once has frozen it before.');
    say('\nPull it yourself, measure, then remove it before the next one:');
    say('  ollama pull ' + target);
    say('  node calibrate.js ' + target);
    say('  ollama rm ' + target);
    say('\nInstalled right now: ' + (list.join(', ') || '(none)'));
    process.exit(1);
  }

  say('\nMeasuring ' + target + ' — ' + PROBES.length + ' probes plus a schema check.');
  const cand = await measure(target);
  if (cand.failed) {
    say('\nEvery probe failed. Nothing measured, nothing written.');
    for (const r of cand.runs) reportRow(r.id, r.err || '?');
    process.exit(1);
  }

  // The baseline half of the ratio. Measured NOW when asked for and installed,
  // because a ratio against a number taken on a different day, on a differently
  // loaded machine, is not a ratio of the models.
  let base = null;
  const wantBase = flags.has('--baseline') || target.toLowerCase().includes(MP.BASELINE);
  const baseInstalled = list.find(n => n.toLowerCase().includes(MP.BASELINE));
  if (wantBase && baseInstalled && !target.toLowerCase().includes(MP.BASELINE)) {
    say('Re-measuring the baseline ' + baseInstalled + ' for a same-machine ratio.');
    base = await measure(baseInstalled);
  }

  // THE BASELINE IS 1.0 BY DEFINITION, NOT BY MEASUREMENT.
  //
  // verbosity and speed are ratios AGAINST the incumbent, so the incumbent's own
  // ratio is 1.0 tautologically. An earlier version of this divided its measured
  // output by a stored constant and wrote whatever fell out — 1.3, say — which
  // would have silently rescaled every budget in the system for the model the
  // budgets were written for, breaking the one property this refactor promised.
  // Calibrating the baseline instead updates the REFERENCE that other models are
  // measured against, which is the genuinely useful thing to learn from it.
  const { prof, ref, isBaseline, verbosity, speed } = profileFrom(target, cand, base);

  say('\n=== measured ===');
  reportRow('output tokens (mean)', cand.outTokMean.toFixed(1) + '   baseline ' + Number(ref.outTokMean).toFixed(1));
  reportRow('characters (mean)', cand.charsMean.toFixed(0));
  reportRow('ms per output token', cand.msPerTok == null ? 'not measured' : cand.msPerTok.toFixed(1) + '   baseline ' + Number(ref.msPerTok).toFixed(1));
  // The spread, so a mean dragged by one bad probe is VISIBLE rather than
  // silently believed. When mean and p50 disagree, the run log names the probe.
  const spread = (label, s) => {
    if (!s) return;
    reportRow(label, 'p50 ' + s.p50 + '  p95 ' + s.p95 + '  min ' + s.min + '  max ' + s.max + '  sd ' + s.std);
    if (s.p50 > 0 && s.mean / s.p50 >= 1.25) {
      say('    ⚠︎ mean is ' + (s.mean / s.p50).toFixed(1) + '× the median — one slow probe is dragging this.');
    }
  };
  spread('output tokens spread', cand.outTokStats);
  spread('ms/token spread', cand.msPerTokStats);
  reportRow('cold first call', cand.coldMs + ' ms');
  reportRow('emits reasoning', String(cand.reasoning));
  reportRow('honours a schema', String(cand.schema) + (cand.schemaErr ? '  (' + cand.schemaErr.slice(0, 60) + ')' : ''));
  say('');
  reportRow('verbosity', String(verbosity) + '  (x the baseline)');
  reportRow('speed', speed == null ? 'not measured — left to the guess' : String(speed) + '  (x the baseline)');
  if (!base && !target.toLowerCase().includes(MP.BASELINE)) {
    say('\n  NOTE: compared against this project\'s stored baseline figures, not a');
    say('  fresh measurement. Re-run with --baseline for a same-machine ratio.');
  }

  if (cand.schema === null) say('  NOTE: the schema probe did not complete (' + (cand.schemaErr || '?') + ') — leaving that axis unmeasured.');
  writeProfile(target, prof, cand, isBaseline);
  if (isBaseline) {
    say('\nBaseline measured. Recorded as the reference every other model is compared against:');
    reportRow('reference outTok', cand.outTokMean.toFixed(1));
    reportRow('reference ms/tok', cand.msPerTok == null ? 'not measured' : cand.msPerTok.toFixed(1));
    say('  Its own verbosity/speed stay 1.0 — a ratio against itself is 1 by definition.');
  }
  say('\nWritten to ' + OUT);
  say('modelprofile.js will now use this measurement instead of a guess.');

  // What this actually buys, in the units the call sites use.
  const p = MP.profileFor(target);
  MP._reload();
  say('\n=== what the budgets become ===');
  for (const b of [30, 300, 900]) {
    reportRow('max_tokens ' + b, '-> ' + MP.scaleTokens(Object.assign({}, p, prof), b));
  }
  for (const b of [20000, 120000]) {
    reportRow('timeout ' + b, '-> ' + MP.scaleTimeout(Object.assign({}, p, prof), b));
  }
}

if (require.main === module) main().catch(e => { say('calibrate failed: ' + (e && e.message || e)); process.exit(1); });
module.exports = { measure, profileFrom, writeProfile, undoProfile, setTransport, installed, PROBES, _setOut, out: () => OUT };
