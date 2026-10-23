'use strict';
// THE CENTROID CACHE — every classifier now reads its regions from disk instead of re-embedding them
// on first use. What must hold: a cached centroid is the one that was built, a changed model throws
// the cache away, a partial build is never kept, and each stage reports its time.
// Needs ollama (it embeds). Runs against a scratch cache file, never the real one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-centroids-')), 'centroids.json');
process.env.JARVIS_CENTROID_CACHE = file;
const intent = require('../intent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');
const phrases = ['open the curtains', 'shut the window', 'turn on the fan'];

(async () => {
  if (!(await intent.embed('probe'))) { console.log('Skipping — the embedder is not reachable'); process.exit(0); }

  head('built once, then read back');
  const a = await intent.centroidOf(intent.MODEL, phrases);
  ok(Array.isArray(a) && a.length > 100, 'a centroid is built');
  process.emit('exit');                              // flush, as a real exit would
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = saved.models[intent.MODEL];
  ok(m && Object.keys(m.regions).length === 1, 'and written under its model');
  const b = await intent.centroidOf(intent.MODEL, phrases);
  ok(b === a, 'the second request is the cached vector, not a rebuild');
  const direct = [];
  for (const p of phrases) direct.push(await intent.embed(p));
  const mean = direct[0].map((_, i) => direct.reduce((s, v) => s + v[i], 0) / direct.length);
  ok(intent.cos(mean, a) > 0.999999, 'and it is the mean of the embeddings, to rounding');

  head('a different region is a different entry');
  const c = await intent.centroidOf(intent.MODEL, phrases.slice(0, 2));
  ok(c !== a && intent.cos(c, a) < 0.9999, 'changing the phrases changes the key');

  head('a changed model discards what it built');
  saved.models[intent.MODEL].probe = saved.models[intent.MODEL].probe.map(x => -x);
  fs.writeFileSync(file, JSON.stringify(saved));
  delete require.cache[require.resolve('../intent.js')];
  const fresh = require('../intent.js');
  await fresh.centroidOf(fresh.MODEL, phrases);
  process.emit('exit');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(intent.cos(after.models[fresh.MODEL].probe, saved.models[intent.MODEL].probe) < 0,
     'the probe no longer matched, so the entry was rebuilt from scratch');
  ok(Object.keys(after.models[fresh.MODEL].regions).length === 1, 'and only what was asked for since is in it');

  head('each stage reports where its time went');
  const seen = [];
  fs.writeFileSync(file, JSON.stringify({ models: {} }));   // force a real build
  delete require.cache[require.resolve('../intent.js')];
  const f2 = require('../intent.js');
  f2.setTimingSink((label, ms) => seen.push([label, ms]));
  const cls2 = f2.makeClassifier({ exemplars: { a: ['one thing', 'another thing'], b: ['a different kind', 'unrelated words'] },
                                   label: 'TimingProbe', minMargin: 0 });
  const tc = Date.now();
  await cls2('something to classify');
  const took = Date.now() - tc;
  // A stage is reported only when it took over 50 ms (intent.js classify). With the embedders kept loaded
  // (ollama.js makeRoomFor, 2026-10-09) the call is often faster than that, so this asserts the rule — a slow
  // call is reported under its label — rather than assuming the call is slow.
  ok(took <= 55 || seen.some(x => x[0] === 'TimingProbe'), 'a classifier call over 50 ms is reported under its label (' + took + ' ms, 5 ms allowed for this clock)');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
