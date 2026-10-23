'use strict';
// ---------------------------------------------------------------------------
// ONE DOOR TO THE LOCAL MODEL SERVER — AND THE ONE PLACE THAT RESTARTS IT.
//
// WHY THIS FILE EXISTS. Three modules held their own copy of the same twenty-line POST to
// 127.0.0.1:11434/api/embeddings — intent.js, itemclass.js and recall.js. Two copies of a transport
// is the same disease as two copies of a word list: they drift, and the bug is that they disagree.
// They already had. itemclass.js sent no `options` at all, so it embedded at the model's default
// context while intent.js pinned num_ctx to 512 — the precise difference that was measured as
// 2.9 GB resident versus 1.0 GB. Nobody wrote that divergence on purpose; it is just what happens
// when the same code lives in three files.
//
// WHY IT RESTARTS OLLAMA. Every semantic classifier in this system abstains when the embedder does
// not answer, and abstention means the request falls through to whatever lexical fallback exists.
// That is the entire justification for config/verbs.json — "works with Ollama down" — and it is the
// reason a table of verbs got to overrule a classifier. Take away the outage and the justification
// goes with it.
//
// The outage is not a hardware limit. Measured on this machine, from a dead daemon:
//
//     ollama serve → answering /api/tags        606 ms
//     first embedding (loads all-minilm)        341 ms
//     subsequent embeddings                      57 ms
//     ------------------------------------------------
//     dead daemon → first classification       ~950 ms
//
// One second, once, is a price worth paying to keep semantics rather than guess from a list. So a
// connection failure here is treated as "the daemon is not running yet", not as "this feature is
// unavailable": spawn it, wait for the port, retry the call exactly once.
//
// WHAT IT WILL NOT DO. It will not retry forever, it will not spawn a second server while one is
// starting, and it will not mask a real failure. If the heal does not take, callers get null and
// abstain — and a caller that abstains must say so honestly rather than fall back to guessing.
//
// NO DEPENDENCIES. stdlib http and child_process. `ollama` is an external binary, which this
// project permits; it is never an npm package.
// ---------------------------------------------------------------------------

const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

// Honours JARVIS_LOCAL_URL so a remote or non-default endpoint keeps working — in which case the
// heal below correctly does nothing, because a daemon we do not own is not ours to restart.
function endpoint() {
  const raw = (process.env.JARVIS_LOCAL_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port || 11434), local: /^(127\.0\.0\.1|localhost|::1)$/i.test(u.hostname) };
  } catch (e) {
    return { host: '127.0.0.1', port: 11434, local: true };
  }
}

// The binary, looked for where it actually lives. `which ollama` finds nothing on this machine even
// though ollama is running — it ships inside the .app bundle and the GUI starts it at login — which
// is exactly the mistake of concluding something is absent because one probe missed it.
const BINARY_CANDIDATES = [
  '/Applications/Ollama.app/Contents/Resources/ollama',
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
];
function findBinary() {
  if (process.env.JARVIS_OLLAMA_BIN && fs.existsSync(process.env.JARVIS_OLLAMA_BIN)) return process.env.JARVIS_OLLAMA_BIN;
  for (const p of BINARY_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  try {
    const r = spawnSync('/usr/bin/which', ['ollama'], { encoding: 'utf8', timeout: 2000 });
    const p = String((r && r.stdout) || '').trim();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  return null;
}

function reachable(timeoutMs) {
  const ep = endpoint();
  return new Promise(resolve => {
    const req = http.request({ host: ep.host, port: ep.port, path: '/api/tags', method: 'GET' },
      res => { res.resume(); resolve(res.statusCode > 0); });
    req.setTimeout(timeoutMs || 1000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

// SINGLE FLIGHT, WITH A COOLDOWN.
//
// Every classifier in the system can be in flight at once — a single chat turn touches the shape
// classifier, the playbook matcher and the claim checker. If each of them reacted to a refused
// connection by spawning a server, one outage would start a dozen. Concurrent callers share one
// attempt; a failed attempt is remembered so the next thirty seconds fall through fast instead of
// paying the full start-up timeout again on every request.
const HEAL_COOLDOWN_MS = 30000;
const READY_TIMEOUT_MS = 8000;
let healing = null;
let lastHealFailedAt = 0;
const MAX_LOADED = '4';   // OLLAMA_MAX_LOADED_MODELS for a server started here; see makeRoomFor
let jlog = () => {};
function setLogger(fn) { if (typeof fn === 'function') jlog = fn; }

async function ensureUp() {
  if (await reachable(1000)) return true;
  const ep = endpoint();
  // A daemon on another host is not ours to start, and spawning a local one would silently answer
  // from the wrong machine.
  if (!ep.local) { jlog('Ollama › unreachable at ' + ep.host + ':' + ep.port + ' — not local, not restarting'); return false; }
  if (healing) return healing;
  if (Date.now() - lastHealFailedAt < HEAL_COOLDOWN_MS) return false;

  healing = (async () => {
    const bin = findBinary();
    if (!bin) {
      jlog('Ollama › down and no ollama binary found — semantics unavailable');
      lastHealFailedAt = Date.now();
      return false;
    }
    jlog('Ollama › not answering — starting ' + bin);
    try {
      // THE SPAWNED SERVER MUST LISTEN WHERE THE CALLER IS LOOKING. `ollama serve` binds 11434
      // unless OLLAMA_HOST says otherwise, so with JARVIS_LOCAL_URL pointed at any other local port
      // this would have started a healthy server on the wrong one and reported failure against the
      // right one — a heal that looks like it ran and changes nothing.
      // HOW MANY MODELS MAY BE LOADED — his rule. Until 2026-10-09: one (the default of three — reader +
      // 3B + an embedder — had frozen his 8 GB Mac). Since then four, because makeRoomFor keeps a heavy model
      // alone and the light ones within a memory budget. Ollama.app gets the same number from launchd
      // (install.sh, com.atharv.ollamaonemodel); a server started here must use it too.
      const env = Object.assign({}, process.env, { OLLAMA_HOST: ep.host + ':' + ep.port, OLLAMA_MAX_LOADED_MODELS: MAX_LOADED });
      // Detached and fully decoupled: this outlives the request that triggered it, and must never
      // hold the parent's stdio open or inherit its lifetime.
      const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', env });
      child.unref();
      child.on('error', () => {});
    } catch (e) {
      jlog('Ollama › could not start: ' + String(e.message || e).slice(0, 80));
      lastHealFailedAt = Date.now();
      return false;
    }
    const t0 = Date.now();
    while (Date.now() - t0 < READY_TIMEOUT_MS) {
      if (await reachable(700)) { jlog('Ollama › back up in ' + (Date.now() - t0) + 'ms'); return true; }
      await new Promise(r => setTimeout(r, 150));
    }
    jlog('Ollama › did not come up within ' + READY_TIMEOUT_MS + 'ms');
    lastHealFailedAt = Date.now();
    return false;
  })().finally(() => { healing = null; });

  return healing;
}

// LOAD WEIGHTS BY MMAP — every model call JARVIS makes passes this, because whichever request loads a
// model decides how it is loaded, and Ollama's llama-server path turns mmap OFF by default (its log:
// "disabling mmap for llama-server load by default"), copying the whole model into RAM. Measured
// 2026-09-23 on his Mac, one model at a time, load + 1 token, twice each:
//
//     model          mmap off               mmap on
//     jarvis-reader  2.8–3.1 s, free 22–26%   2.2 s, free 30–31%
//     qwen2.5 3B     3.7–4.0 s, free 17–18%   2.6–2.9 s, free 26%
//
// Faster, and ~0.7 GB more free at the tightest moment — the weights stay file-backed pages macOS can
// drop and re-read instead of swapping, which is what froze the machine.
const USE_MMAP = true;

// The raw POST. Returns { v } on success, { err } otherwise, so a caller can tell a network failure
// (the service is down — worth healing) from a content failure (this particular text was refused —
// healing would change nothing). recall.js needs that distinction to decide whether to halve the
// text and retry; collapsing both to null is what made an embedding outage look like a tf-idf score.
function postEmbed(text, opts) {
  const o = opts || {};
  const ep = endpoint();
  return new Promise(resolve => {
    const payload = { model: o.model, prompt: String(text), keep_alive: o.keepAlive || '60s' };
    // num_ctx IS NOT OPTIONAL. ollama sizes its KV allocation from the context it is handed, not
    // from the length of the text, so an unpinned embedding call reserves for the model's full
    // window. Nothing embedded here is longer than a couple of sentences.
    payload.options = Object.assign({ num_ctx: o.numCtx || 512, use_mmap: USE_MMAP }, o.options || {});
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request({
      host: ep.host, port: ep.port, path: '/api/embeddings', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (Array.isArray(j.embedding) && j.embedding.length) return resolve({ v: j.embedding });
          resolve({ err: 'content', why: String(j.error || 'no embedding').slice(0, 80) });
        } catch (e) { resolve({ err: 'content', why: 'unparseable reply' }); }
      });
    });
    // Short by design. These sit in front of routing decisions, and a classifier that hangs is worse
    // than one that abstains: an abstention falls through, a hang looks like a crash.
    req.setTimeout(o.timeoutMs || 4000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ err: 'net' }));
    req.write(body); req.end();
  });
}

// embed() — the call every classifier should make.
//
// One retry, and only for a network error. A content error means the server answered and declined
// this text; restarting it would produce the same refusal a second later.
// A warm embed is 8–20ms. Anything much slower is the model being loaded back into memory, or the
// machine swapping — and either is exactly what a turn that "took forever" needs to be able to name.
let _timingSink = null;
function setTimingSink(fn) { _timingSink = typeof fn === 'function' ? fn : null; }

// ---------------------------------------------------------------------------
// WHAT MAY SHARE MEMORY — a heavy model alone; the light ones together under a budget (2026-10-09, his yes).
//
// WHY. His rule since 2026-09-23 was one model in memory at a time (OLLAMA_MAX_LOADED_MODELS=1): two
// resident models had frozen this 8 GB Mac. It worked, but it made every chat turn pay for itself twice:
// the reader preloads when he starts typing and the embedders run every turn, and each pushed the chat model
// out — so it loaded again and re-read its ~1,000-token system prompt from nothing. Measured 2026-10-09, "hi"
// as a live turn runs it: jarvis 11.9 s, the 3B 11.9 s (load ~2 s + prompt ~8–10 s); with jarvis kept loaded
// and only the clock line changed, 0.7 s.
//
// THE RULE NOW, enforced here because Ollama only counts models (its cap is now MAX_LOADED):
//   - a HEAVY model (≥ HEAVY_BYTES on disk: the 3B, phi, vision) is always alone, exactly as before;
//   - the light ones (jarvis, the reader, the embedders) may share, while what is loaded stays within the
//     budget (budgetBytes, below); past it, the biggest other generation model goes. Embedders always may.
// Which model is an embedder and how big it is come from Ollama itself (/api/show capabilities, /api/tags and
// /api/ps sizes) — no list of model names here. Every call that loads a model asks makeRoomFor first: the
// generation calls in server.js, readmodel.js, agent.js, factmatch.js, sitekind.js, and embed() below on a
// cache miss.
const HEAVY_BYTES = 1.5e9;
// How much the light models may hold together. 0 = never two generation models (embedders may still sit beside
// one). MEASURED 2026-10-09 with only Claude open: at 3.0 GB (jarvis + reader + nomic, 2.6 GB) the reply fell from
// ~12 s to 1.1 s, but free memory went to 16–24%, swap filled, and the 4th model (all-minilm) stalled 8 s on every
// load — so the default is 0 until he chooses otherwise. Set per call from .env (JARVIS_MODEL_BUDGET_GB) through
// setBudgetSource, so changing it needs no restart.
let budgetBytes = () => 0;
function setBudgetSource(fn) { if (typeof fn === 'function') budgetBytes = () => { try { return Math.max(0, Number(fn()) || 0); } catch (e) { return 0; } }; }
const _info = new Map();       // 'name:tag' → { embed, size } (size on disk)
const _resident = new Map();   // 'name:tag' → bytes it took the last time it was seen loaded
const tagged = n => { const s = String(n || ''); return s.includes(':') ? s : s + ':latest'; };
function jsonCall(method, path, body, timeoutMs) {
  const ep = endpoint();
  return new Promise(resolve => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: ep.host, port: ep.port, path, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.setTimeout(timeoutMs || 4000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}
// MODELS SERVED OUTSIDE OLLAMA (2026-10-13): `jarvis` runs on a pinned llama-server with its LoRA loaded at runtime
// (loraserver.js). It still holds memory, so the gate has to see it and be able to evict it — otherwise "one generation
// model at a time" quietly becomes two. Each entry: { size (bytes on disk), loaded() → Promise<bool>, bytes() → resident,
// evict() → Promise }.
const externals = new Map();
function registerExternal(name, x) { if (name && x) externals.set(tagged(name), x); }
async function infoOf(model) {
  const k = tagged(model);
  const ex = externals.get(k);
  if (ex) return { embed: false, size: ex.size || 0 };
  if (_info.has(k)) return _info.get(k);
  const show = await jsonCall('POST', '/api/show', { model }, 4000);
  const tags = await jsonCall('GET', '/api/tags', null, 4000);
  const caps = (show && show.capabilities) || [];
  let size = 0;
  for (const m of (tags && tags.models) || []) if (tagged(m.name) === k) size = m.size || 0;
  const v = { embed: caps.includes('embedding') && !caps.includes('completion'), size };
  if (show && tags) _info.set(k, v);   // a failed lookup is not remembered
  return v;
}
const isHeavy = i => !i.embed && i.size >= HEAVY_BYTES;
// → [{ name, bytes }] for what Ollama has loaded right now (and remembers each one's size)
async function loadedModels() {
  const ps = await jsonCall('GET', '/api/ps', null, 2000);
  const out = ((ps && ps.models) || []).map(m => ({ name: m.name || m.model, bytes: m.size || 0 })).filter(m => m.name);
  for (const [k, x] of externals) {
    let up = false; try { up = await x.loaded(); } catch (e) {}
    if (up && !out.some(m => tagged(m.name) === k)) out.push({ name: k, bytes: (x.bytes && x.bytes()) || 0 });
  }
  for (const m of out) if (m.bytes) _resident.set(tagged(m.name), m.bytes);
  return out;
}
// Unload, then wait until Ollama no longer lists it — the request returns before the runner has exited.
async function unload(name) {
  const ex = externals.get(tagged(name));
  if (ex) {
    try { await ex.evict(); } catch (e) {}
    // Ollama's own copy of the same name is unloaded too, but only if Ollama really has it loaded: a keep_alive:0
    // request for a model it does not hold is not a request this needs to make.
    const ps = await jsonCall('GET', '/api/ps', null, 2000);
    if (!((ps && ps.models) || []).some(m => tagged(m.name || m.model) === tagged(name))) return;
  }
  await jsonCall('POST', '/api/generate', { model: name, keep_alive: 0 }, 15000);
  for (let i = 0; i < 30; i++) {
    if (!(await loadedModels()).some(m => tagged(m.name) === tagged(name))) return;
    await new Promise(r => setTimeout(r, 100));
  }
}
// → the names it unloaded. Never throws: a failed check leaves things as they are and the caller goes on.
async function makeRoomFor(model) {
  if (!model) return [];
  try {
    let loaded = (await loadedModels()).filter(m => tagged(m.name) !== tagged(model));
    if (!loaded.length) return [];
    const me = await infoOf(model);
    const out = [];
    for (const m of loaded) {
      const it = await infoOf(m.name);
      if (isHeavy(me) || isHeavy(it)) { await unload(m.name); out.push(m.name); }
    }
    loaded = loaded.filter(m => !out.includes(m.name));
    // Within the budget? The model about to load counts at what it took last time (twice its file size if
    // never seen — the KV cache comes on top of the weights).
    const mine = _resident.get(tagged(model)) || me.size * 2;
    const others = [];
    for (const m of loaded) others.push(Object.assign({ embed: (await infoOf(m.name)).embed }, m));
    let total = mine + others.reduce((t, m) => t + m.bytes, 0);
    const budget = me.embed ? Infinity : budgetBytes();
    for (const m of others.filter(x => !x.embed).sort((x, y) => y.bytes - x.bytes)) {
      if (total <= budget) break;
      await unload(m.name); out.push(m.name); total -= m.bytes;
    }
    if (out.length) jlog('Ollama › unloaded ' + out.join(', ') + ' to make room for ' + model);
    return out;
  } catch (e) { return []; }
}
// THE SAME SENTENCE IS EMBEDDED ONCE. A turn asks a dozen gates about one sentence, and each used to embed
// it again. With one model in memory at a time (his rule, 2026-09-23) every one of those calls could force
// a reload — and an embedder loaded after the 3B resolver throws the 3B out, so the reply paid for it
// twice. A vector is a deterministic function of (model, context, text), so it is kept here, bounded.
const VEC_MAX = 512;
const vecs = new Map();
async function embed(text, opts) {
  const o = opts || {};
  const k = (o.model || '') + '\u0000' + (o.numCtx || 512) + '\u0000' + String(text);
  if (vecs.has(k)) { const v = vecs.get(k); vecs.delete(k); vecs.set(k, v); return { v }; }
  const s = Date.now();
  await makeRoomFor(o.model);   // a heavy model never shares memory with an embedder — see makeRoomFor
  let r = await postEmbed(text, o);
  if (r.err === 'net') {
    if (await ensureUp()) r = await postEmbed(text, o);
  }
  if (r && r.v) { vecs.set(k, r.v); if (vecs.size > VEC_MAX) vecs.delete(vecs.keys().next().value); }
  const ms = Date.now() - s;
  if (ms > 150 && _timingSink) { try { _timingSink('embed ' + (o.model || '?') + ' (load/pressure)', ms); } catch (e) {} }
  return r;
}

module.exports = { embed, postEmbed, ensureUp, reachable, endpoint, findBinary, setLogger, setTimingSink, makeRoomFor, setBudgetSource, registerExternal, HEAVY_BYTES, MAX_LOADED };
