// SETTINGS → MODELS → CALIBRATE (2026-10-17, his ask). calibrate.js's measurement reused inside JARVIS (a swappable transport),
// the profile arithmetic shared with the command line, Keep writes / Undo restores the previous profile; the server lists the
// generation models by Ollama's own capability flags, shows which model does which job, refuses to measure while a training or a
// test run is loading models, and holds the measurement until Keep. The old "CORE — READ-ONLY" box (whose "Chat model" line was
// the helper) and its jarvis.yaml text are gone. A stub model and a scratch profile file — his real state is never touched.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const REAL = path.join(ROOT, 'state', 'modelprofiles.json');
const realBefore = fs.existsSync(REAL) ? fs.readFileSync(REAL, 'utf8') : null;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}

async function main() {
  const C = require(path.join(ROOT, 'calibrate.js'));
  const MP = require(path.join(ROOT, 'modelprofile.js'));
  const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'calib-')), 'modelprofiles.json');
  C._setOut(scratch);

  console.log('— the measurement, through whatever transport JARVIS gives it —');
  const seen = [];
  C.setTransport(async body => {
    seen.push(body.model);
    if (body.format) return { message: { content: '{"capital":"Paris"}' }, eval_count: 6, prompt_eval_count: 10 };
    return { message: { content: 'Paris is the capital of France, and it is lovely.' }, eval_count: 24, prompt_eval_count: 12 };
  });
  const cand = await C.measure('stub-model');
  eq('every probe went through the given transport', seen.every(m => m === 'stub-model') && seen.length === C.PROBES.length + 1, true);
  eq('it measured (not failed)', cand.failed, false);
  eq('mean output tokens', cand.outTokMean, 24);
  eq('the schema probe counts', cand.schema, true);

  console.log('\n— the profile arithmetic is shared, and nothing is written before Keep —');
  const out = C.profileFrom('stub-model', cand, null);
  eq('verbosity is a ratio against the stored reference (24 / 12)', out.prof.verbosity, 2);
  eq('profileFrom writes nothing', fs.existsSync(scratch), false);
  C.writeProfile('stub-model', out.prof, cand, out.isBaseline);
  eq('Keep writes the profile', JSON.parse(fs.readFileSync(scratch, 'utf8'))['stub-model'].verbosity, 2);
  eq('…and modelprofile.js reads it straight away', MP.profileFor('stub-model').source, 'calibrated');
  C.writeProfile('stub-model', Object.assign({}, out.prof, { verbosity: 3 }), cand, false);
  eq('a second Keep replaces it', MP.profileFor('stub-model').verbosity, 3);
  eq('Undo puts the previous one back (one step: it undoes the last Keep)', [C.undoProfile('stub-model'), MP.profileFor('stub-model').verbosity], [true, 2]);
  eq('nothing more to undo after that', C.undoProfile('stub-model'), false);
  C.writeProfile('fresh-model', out.prof, cand, false);
  eq('a first Keep, undone → back to no saved profile (the built-in guess)', [C.undoProfile('fresh-model'), MP.profileFor('fresh-model').source !== 'calibrated'], [true, true]);
  eq('his real profile file was not touched', fs.existsSync(REAL) ? fs.readFileSync(REAL, 'utf8') : null, realBefore);

  console.log('\n— the server —');
  const S = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  eq('calibration runs through the memory gate and postChat (jarvis → llama-server)',
    /calibrate\.setTransport\(async \(body, ms\) => \{ await ollamaDoor\.makeRoomFor\(body\.model\); return postChat\(/.test(S), true);
  eq('generation models are picked by Ollama\'s capability flag, not by name', /if \(!caps\.includes\('completion'\)\) continue;/.test(S), true);
  eq('the jobs come from the same getters the code calls', /role: 'Chat replies', model: reply \|\| localModel\(\)/.test(S) && /role: 'Helper/.test(S), true);
  eq('never measures while a training, gate or eval runs', /for \(const proc of \['train_resumable\.py', 'gate_run\.sh', 'sweep_casual\.js', 'eval_reader\.py'/.test(S), true);
  const start = S.slice(S.indexOf('async function startCalibration'), S.indexOf('function keepCalibration'));
  eq('measuring does not write — only Keep does', !/writeProfile/.test(start) && /calibrate\.writeProfile\(calJob\.model/.test(S), true);
  eq('endpoints: models, calibrate, keep, discard, undo', ['/api/models', "'/api/calibrate'", '/api/calibrate/keep', '/api/calibrate/discard', '/api/calibrate/undo'].every(e => S.includes(e)), true);
  eq('Settings sends `models`, not the old read-only box', /models: \{\n\s+roles: modelRoles\(\),/.test(S) && !/readOnly: \{\n\s+mac:/.test(S), true);
  eq('the jarvis.yaml / fleet text is gone', !/jarvis\.yaml is the source of truth for these/.test(S), true);

  console.log('\n— the page —');
  const A = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const H = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  eq('MODELS section replaces CORE — READ-ONLY', H.includes('id="modelsBox"') && !H.includes('CORE — READ-ONLY'), true);
  eq('renders the jobs and a model picker', /async function renderModels\(m\)/.test(A) && /createElement\('optgroup'\)/.test(A), true);
  eq('Keep / Discard / Undo are offered', ["'Keep'", "'Discard'", "'Undo'"].every(t => A.includes(t)), true);
  eq('no more "Chat model" / "Agent switches" lines', !/add\('Chat model'/.test(A) && !/Agent switches/.test(A), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
