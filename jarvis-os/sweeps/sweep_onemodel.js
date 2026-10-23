'use strict';
// MEASUREMENT SCRIPT — not a test, and it fires no actions. What "one model in memory at a time" costs a
// turn (OLLAMA_MAX_LOADED_MODELS=1, his rule since 2026-09-23): the models one of his turns touches, called
// in the order a turn calls them, straight against Ollama. For each call: how long it took (a model that
// has to be loaded first pays for the load), what is resident afterwards, and how much memory is free.
//
//   node sweeps/sweep_onemodel.js [rounds]        default 2 rounds — the second shows a warm-cache turn
//
// The sequence is the one the live log shows for a turn with history: all-minilm (errand), nomic (the
// gates), the reader (the pre-read), nomic again, the 3B (the reference resolver), nomic, the 3B (the reply).
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const rm = require(path.join(__dirname, '..', 'readmodel.js'));

const post = (p, body) => new Promise(res => {
  const d = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: 11434, path: p, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': d.length } }, x => {
    let b = ''; x.on('data', c => { b += c; }); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
  });
  r.on('error', () => res(null)); r.write(d); r.end();
});
const get = p => new Promise(res => {
  http.get({ host: '127.0.0.1', port: 11434, path: p }, x => {
    let b = ''; x.on('data', c => { b += c; }); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
  }).on('error', () => res(null));
});
const freePct = () => {
  const m = /(\d+)%/.exec(spawnSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8' }).stdout || '');
  return m ? Number(m[1]) : null;
};
const THREE_B = 'qwen2.5:3b-instruct-q4_K_M';
const TEXT = 'search him up on brave';
const steps = [
  ['all-minilm   (errand)', () => post('/api/embeddings', { model: 'all-minilm', prompt: TEXT, keep_alive: '60s' })],
  ['nomic        (gates)', () => post('/api/embeddings', { model: 'nomic-embed-text', prompt: TEXT, keep_alive: '60s' })],
  ['reader       (pre-read)', () => post('/api/generate', rm._request(TEXT + ' ' + Date.now() % 1000))],
  ['nomic        (gates)', () => post('/api/embeddings', { model: 'nomic-embed-text', prompt: TEXT + ' again', keep_alive: '60s' })],
  ['3B           (resolver)', () => post('/api/generate', { model: THREE_B, prompt: 'Reply with the word NONE.', stream: false, keep_alive: '5m', options: { num_predict: 8, temperature: 0 } })],
  ['nomic        (gates)', () => post('/api/embeddings', { model: 'nomic-embed-text', prompt: TEXT + ' once more', keep_alive: '60s' })],
  ['3B           (reply)', () => post('/api/generate', { model: THREE_B, prompt: 'Say hello in five words.', stream: false, keep_alive: '5m', options: { num_predict: 16, temperature: 0 } })],
];

(async () => {
  const rounds = Number(process.argv[2]) || 2;
  let lowest = 100;
  for (let r = 1; r <= rounds; r++) {
    console.log('\nround ' + r);
    let total = 0;
    for (const [label, call] of steps) {
      const t0 = Date.now();
      const out = await call();
      const ms = Date.now() - t0;
      total += ms;
      const ps = await get('/api/ps');
      const resident = ((ps && ps.models) || []).map(m => m.name.replace(':latest', '') + ' ' + (m.size_vram / 1e9 || m.size / 1e9).toFixed(1) + 'GB');
      const free = freePct();
      if (free !== null) lowest = Math.min(lowest, free);
      console.log('  ' + label.padEnd(26) + String(ms).padStart(6) + ' ms   ' + (out ? '' : 'FAILED  ') + 'resident: ' + (resident.join(', ') || 'none') + '   free ' + free + '%');
    }
    console.log('  total ' + total + ' ms');
  }
  console.log('\nlowest free memory seen: ' + lowest + '%');
  // Leave nothing resident.
  const ps = await get('/api/ps');
  for (const m of ((ps && ps.models) || [])) spawnSync('ollama', ['stop', m.name]);
  process.exit(0);
})();
