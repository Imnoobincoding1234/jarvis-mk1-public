#!/usr/bin/env node
// run_all.js — every suite in this folder, one after another, then one table.
//
//   node tests/run_all.js               the 20 suites (run from jarvis-os/, or from anywhere)
//   node tests/run_all.js --install     …plus test_install (needs the network: it asks two registries)
//   node tests/run_all.js parse store   only the suites whose names contain these
//   node tests/run_all.js --keep-models leave the models this run loaded in memory
//
// NEVER runs test_eval.js: it drives the real server and real apps (Brave, Notes, Reminders) and needs
// his OK every time — run it by hand: node tests/test_eval.js --audit, then node tests/test_eval.js.
//
// Why a runner: a suite that finds no model prints "Skipping" and exits 0, which a bare exit code
// reports as a pass. Here it is SKIPPED, not passed, and the run does not count as green. And the models
// a suite loads are unloaded as soon as that suite ends, not once at the end: the first full run
// (2026-09-18) held the reader, the 3B, nomic and granite together and pushed swap from 3.4 to 4.8 GB on
// this 8 GB Mac. One suite's models at a time costs a few seconds of reloading and none of his browser's
// memory. Models that were loaded before the run started (JARVIS's own) are never touched.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HERE = __dirname;
const OS_DIR = path.join(HERE, '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const picks = args.filter(a => !a.startsWith('--'));

const all = fs.readdirSync(HERE).filter(f => /^test_.+\.js$/.test(f)).sort();
const suites = all.filter(f => f !== 'test_eval.js')
  .filter(f => f !== 'test_install.js' || flags.has('--install'))
  .filter(f => !picks.length || picks.some(p => f.includes(p)));

// Models loaded right now, by name — JARVIS's own, which this run must leave alone.
function loadedModels() {
  try {
    return execFileSync('ollama', ['ps'], { encoding: 'utf8', timeout: 10000 })
      .split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
  } catch (e) { return null; }
}

// Unload whatever is resident now that was not resident when the run began. Returns the names.
function unloadExtra(before) {
  if (!before || flags.has('--keep-models')) return [];
  const extra = (loadedModels() || []).filter(m => !before.includes(m));
  for (const m of extra) {
    try { execFileSync('ollama', ['stop', m], { timeout: 30000, stdio: 'ignore' }); } catch (e) { /* already gone */ }
  }
  return extra;
}

function run(file) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, file)], { cwd: OS_DIR, env: process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ file, code, out, ms: Date.now() - t0 }));
  });
}

(async () => {
  const before = loadedModels();
  console.log(`running ${suites.length} suite${suites.length === 1 ? '' : 's'} from ${path.relative(process.cwd(), HERE) || '.'}/` +
    (all.includes('test_eval.js') ? '  (test_eval.js is never run from here — it drives real apps)' : ''));
  const rows = [], unloaded = new Set();
  for (const f of suites) {
    process.stdout.write(`  ${f.padEnd(24)}`);
    const r = await run(f);
    for (const m of unloadExtra(before)) unloaded.add(m);
    const counts = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
    r.pass = counts ? Number(counts[1]) : null;
    r.fail = counts ? Number(counts[2]) : null;
    r.skipped = /Skipping/.test(r.out);
    r.status = r.skipped ? 'SKIPPED' : (r.code === 0 && !r.fail) ? 'ok' : 'FAILED';
    console.log(`${r.status.padEnd(8)} ${String(r.pass ?? '-').padStart(5)} passed  ${String(r.fail ?? '-').padStart(3)} failed` +
      `  ${(r.ms / 1000).toFixed(1).padStart(6)} s${r.code !== 0 && r.status !== 'FAILED' ? '  exit ' + r.code : ''}`);
    rows.push(r);
  }
  const total = rows.reduce((n, r) => n + (r.pass || 0), 0);
  const failed = rows.filter(r => r.status === 'FAILED');
  const skipped = rows.filter(r => r.status === 'SKIPPED');
  for (const r of failed) {
    console.log(`\n── ${r.file} (exit ${r.code}) — last lines ──`);
    console.log(r.out.trimEnd().split('\n').slice(-25).join('\n'));
  }
  console.log(`\n${total} assertions passed in ${rows.length - skipped.length} suites` +
    (failed.length ? `; FAILED: ${failed.map(r => r.file).join(', ')}` : '') +
    (skipped.length ? `; SKIPPED (no model — not a pass): ${skipped.map(r => r.file).join(', ')}` : '') +
    (failed.length || skipped.length ? '' : '; all green'));

  for (const m of unloadExtra(before)) unloaded.add(m);
  if (unloaded.size) console.log(`unloaded after each suite: ${[...unloaded].join(', ')}`);
  process.exit(failed.length || skipped.length ? 1 : 0);
})();
