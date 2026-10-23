'use strict';
// loraserver.js — `jarvis` (Bonsai 4B, 1-bit, + his LoRA) served by a PINNED llama-server with the adapter loaded at
// runtime, instead of by an Ollama adapter model (2026-10-13, "option 3", his go; runtime/README.md).
//
// Why: jarvis is a LoRA on a base model, and Ollama is dropping adapter models — 0.34.1 removed `ollama create … ADAPTER`,
// 0.40 logs "LoRA adapters are deprecated and will be removed". Serving it here keeps it working whatever Ollama does next,
// which is what lets Ollama be updated at all.
// Measured before it was written (backups/option3-sandbox-20261013/README.md): 59 JARVIS-shaped requests — chat, streamed,
// Wikipedia answers, answer checks with top-20 logprobs — 59/59 identical to Ollama's jarvis, the same prompt token counts
// and yes-shares, at the same speed and memory (load 0.93 s, ~1.25 GB).
//
// The contract: server.js hands it the SAME /api/chat body it would send Ollama and gets Ollama's reply shape back
// (message.content, logprobs, the eval/prompt counters), streamed or not. The memory gate (ollama.makeRoomFor) sees it
// through registerExternal, so "one generation model at a time" still holds — it is evicted when another generation model
// loads, and starting it evicts what the budget says must go. It stops itself after the call's keep_alive.
// Anything wrong (binary or files missing, no health in time) throws, and server.js answers through Ollama's own `jarvis`
// instead, if that is still installed. Off switch: JARVIS_CHAT_REPLY_RUNTIME=ollama in .env.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const HOST = '127.0.0.1';
const deps = {
  jlog: () => {},
  envVal: n => process.env[n] || null,
  root: path.join(process.env.HOME || '', 'JARVIS MK-1'),
  door: null,                                     // ollama.js — the memory gate
};
let child = null;          // the server this process started (another JARVIS process may have started the one on the port)
let ctxNow = 0;            // the context the running server was started with
let starting = null;
let idleTimer = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => Number(deps.envVal('JARVIS_LORA_PORT')) || 11436;
const tagged = n => { const s = String(n || ''); return s.includes(':') ? s : s + ':latest'; };

// The model this serves and the files it is built from — every path from a file the machine owns, nothing guessed.
// Ollama 0.40.3 writes the manifest of every model it pulls or creates under manifests-v2/ (jarvis-reader-r8 lives there);
// models pulled before the update stay under manifests/. A restored Mac pulls Bonsai-4B fresh, into manifests-v2/, so
// looking only in manifests/ found no base and jarvis never started (2026-10-19). The old folder is read first, so this
// Mac resolves exactly the blob it always did.
function blobOf(manifestParts, kind) {
  const models = process.env.OLLAMA_MODELS || path.join(process.env.HOME || '', '.ollama', 'models');
  for (const dir of ['manifests', 'manifests-v2']) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(models, dir, ...manifestParts), 'utf8'));
      const l = (m.layers || []).find(x => String(x.mediaType).endsWith('.' + kind));
      if (l) return path.join(models, 'blobs', l.digest.replace(':', '-'));
    } catch (e) {}
  }
  return null;
}
function config() {
  if ((deps.envVal('JARVIS_CHAT_REPLY_RUNTIME') || 'llama-server') !== 'llama-server') return null;
  const rt = path.join(deps.root, 'runtime');
  const c = {
    name: deps.envVal('JARVIS_LORA_NAME') || 'jarvis',
    bin: path.join(rt, 'llama-server'),
    template: path.join(rt, 'jarvis.jinja'),
    base: deps.envVal('JARVIS_LORA_BASE') || blobOf(['hf.co', 'prism-ml', 'Bonsai-4B-gguf', 'Q1_0'], 'model'),
    lora: deps.envVal('JARVIS_LORA_ADAPTER') || path.join(deps.root, 'finetune', 'adapters', 'bonsai_v42_s1', 'jarvis-v42-lora.gguf'),
    params: {},
  };
  for (const f of [c.bin, c.template, c.base, c.lora]) if (!f || !fs.existsSync(f)) return null;
  try { c.params = JSON.parse(fs.readFileSync(path.join(rt, 'jarvis.params.json'), 'utf8')); } catch (e) { c.params = {}; }
  return c;
}
const handles = model => !!model && !!config() && tagged(model) === tagged(config().name);
// What Settings → Models lists for the model this server runs. On a restored Mac Ollama 0.40 cannot create the old `jarvis`
// adapter model, so Ollama's own list never shows it and Calibrate could not reach it (2026-10-22).
function listEntry() {
  const c = config(); if (!c) return null;
  let size = 0; try { size = fs.statSync(c.base).size + fs.statSync(c.lora).size; } catch (e) {}
  return { name: c.name, size, where: 'llama-server' };
}

function request(method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: port(), path: pathname, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, res => {
      let s = ''; res.on('data', d => { s += d; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (e) {}
        if (res.statusCode >= 400) return reject(Object.assign(new Error('llama-server HTTP ' + res.statusCode + ': ' + s.slice(0, 200)), { status: res.statusCode }));
        resolve(j);
      });
    });
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('llama-server timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const healthy = () => request('GET', '/health', null, 400).then(j => !!j && j.status === 'ok').catch(() => false);

// pids of a server on OUR port started from OUR binary — whoever started it.
function pids(c) {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', c.bin + ' .*--port ' + port()]).toString().trim().split('\n').filter(Boolean).map(Number);
  } catch (e) { return []; }
}
function residentBytes() {
  const c = config(); if (!c) return 0;
  let kb = 0;
  for (const p of pids(c)) { try { kb += Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(p)]).toString().trim()) || 0; } catch (e) {} }
  return kb * 1024;
}

async function stop(why) {
  clearTimeout(idleTimer); idleTimer = null;
  const c = config() || { bin: path.join(deps.root, 'runtime', 'llama-server') };
  const list = pids(c);
  if (!list.length) { child = null; ctxNow = 0; return false; }
  for (const p of list) { try { process.kill(p, 'SIGTERM'); } catch (e) {} }
  for (let i = 0; i < 30 && pids(c).length; i++) await sleep(100);
  for (const p of pids(c)) { try { process.kill(p, 'SIGKILL'); } catch (e) {} }
  child = null; ctxNow = 0;
  deps.jlog('LoRA server › stopped (' + (why || 'asked') + ')');
  return true;
}

// Make sure a server with the right model and at least this context is answering on the port.
async function ensure(numCtx) {
  const c = config();
  if (!c) throw Object.assign(new Error('not configured'), { unavailable: true });
  const want = Math.max(4096, Number(numCtx) || 0);
  if (await healthy()) {
    if (!ctxNow) {   // started by another JARVIS process: learn what it runs before trusting it
      const p = await request('GET', '/props', null, 2000).catch(() => null);
      const s = p && p.default_generation_settings;
      ctxNow = (s && s.n_ctx) || (p && p.n_ctx) || 0;
      if (p && p.model_path && p.model_path !== c.base) ctxNow = 0;
    }
    if (ctxNow >= want) return c;
  }
  if (starting) return starting;
  starting = (async () => {
    await stop('restart for context ' + want);
    if (deps.door && deps.door.makeRoomFor) await deps.door.makeRoomFor(c.name);
    const args = ['--model', c.base, '--lora', c.lora, '--host', HOST, '--port', String(port()), '--no-webui', '--offline',
      '-c', String(want), '-np', '1', '--flash-attn', 'auto', '-b', '512', '-ub', '512', '--context-shift', '--keep', '4',
      '--jinja', '--chat-template-file', c.template,
      // the template opens and closes an empty think block itself; "deepseek" keeps that block out of the reply text
      // ("none" put it in — measured in the sandbox)
      '--reasoning-format', 'deepseek'];
    let log = 'ignore';
    try { log = fs.openSync(path.join(deps.root, 'jarvis-os', 'logs', 'loraserver.log'), 'a'); } catch (e) {}
    const t0 = Date.now();
    child = spawn(c.bin, args, { stdio: ['ignore', log, log] });
    let exited = false;
    child.on('exit', () => { exited = true; });
    while (Date.now() - t0 < 60000 && !exited) {
      if (await healthy()) {
        ctxNow = want;
        deps.jlog('LoRA server › ' + c.name + ' up in ' + (Date.now() - t0) + ' ms (context ' + want + ')');
        return c;
      }
      await sleep(120);
    }
    await stop('did not come up');
    throw Object.assign(new Error('llama-server did not come up (see logs/loraserver.log)'), { unavailable: true });
  })();
  try { return await starting; } finally { starting = null; }
}

// keep_alive as Ollama reads it: seconds, or "30s" / "10m" / "1h"; negative = keep; 0 = stop after this call.
function keepMs(k) {
  if (k === undefined || k === null || k === '') return 5 * 60000;
  if (typeof k === 'number') return k < 0 ? Infinity : k * 1000;
  const m = String(k).trim().match(/^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);   // machine format: a Go-style duration
  if (!m) return 5 * 60000;
  const n = Number(m[1]);
  if (n < 0) return Infinity;
  return n * ({ ms: 1, s: 1000, m: 60000, h: 3600000 })[m[2] || 's'];
}
function scheduleStop(k) {
  clearTimeout(idleTimer); idleTimer = null;
  const ms = keepMs(k);
  if (ms === Infinity) return;
  if (ms <= 0) { stop('keep_alive 0'); return; }
  idleTimer = setTimeout(() => stop('idle'), ms);
  if (idleTimer.unref) idleTimer.unref();
}

// Ollama /api/chat body → llama-server /v1/chat/completions body.
function toLlama(b, params) {
  const o = Object.assign({}, params, b.options || {});
  const req = { messages: b.messages, stream: !!b.stream, cache_prompt: true, stop: o.stop || params.stop || [],
    temperature: o.temperature, top_k: o.top_k, top_p: o.top_p, repeat_penalty: o.repeat_penalty };
  if (o.num_predict != null && o.num_predict >= 0) req.max_tokens = o.num_predict;
  if (o.seed != null) req.seed = o.seed;
  if (b.logprobs) { req.logprobs = true; if (b.top_logprobs) req.top_logprobs = b.top_logprobs; }
  if (b.format && typeof b.format === 'object') req.response_format = { type: 'json_schema', json_schema: { schema: b.format } };
  else if (b.format === 'json') req.response_format = { type: 'json_object' };
  if (b.stream) req.stream_options = { include_usage: true };
  for (const k of Object.keys(req)) if (req[k] === undefined) delete req[k];
  return req;
}
const logprobsOf = c => (c && c.logprobs && Array.isArray(c.logprobs.content))
  ? c.logprobs.content.map(t => ({ token: t.token, logprob: t.logprob, bytes: t.bytes,
      top_logprobs: (t.top_logprobs || []).map(x => ({ token: x.token, logprob: x.logprob, bytes: x.bytes })) }))
  : undefined;
function counters(t, u, ms) {
  t = t || {}; u = u || {};
  return {
    total_duration: Math.round(ms * 1e6), load_duration: 0,
    prompt_eval_count: t.prompt_n != null ? t.prompt_n : u.prompt_tokens,
    prompt_eval_duration: Math.round((t.prompt_ms || 0) * 1e6),
    eval_count: t.predicted_n != null ? t.predicted_n : u.completion_tokens,
    eval_duration: Math.round((t.predicted_ms || 0) * 1e6),
  };
}
function fromLlama(model, r, ms) {
  const c = (r && r.choices || [])[0] || {};
  const out = Object.assign({ model, created_at: new Date().toISOString(),
    message: { role: 'assistant', content: (c.message && c.message.content) || '' },
    done: true, done_reason: c.finish_reason === 'length' ? 'length' : 'stop' }, counters(r && r.timings, r && r.usage, ms));
  const lp = logprobsOf(c); if (lp) out.logprobs = lp;
  return out;
}

async function chat(body, timeoutMs) {
  const c = await ensure(body.options && body.options.num_ctx);
  clearTimeout(idleTimer);
  const t0 = Date.now();
  try {
    const r = await request('POST', '/v1/chat/completions', toLlama(Object.assign({}, body, { stream: false }), c.params), timeoutMs);
    return fromLlama(body.model || c.name, r, Date.now() - t0);
  } finally { scheduleStop(body.keep_alive); }
}

// Streamed: server-sent events in, Ollama's per-token callback out. Resolves with the same shape postChatStream returns.
// An error after a token went out carries `emitted`, so the caller does not answer the turn twice.
async function chatStream(body, timeoutMs, onToken) {
  const c = await ensure(body.options && body.options.num_ctx);
  clearTimeout(idleTimer);
  const t0 = Date.now();
  let emitted = false;
  try {
    return await new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(toLlama(Object.assign({}, body, { stream: true }), c.params)));
      const req = http.request({ host: HOST, port: port(), path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
        if (res.statusCode >= 400) {
          let e = ''; res.on('data', d => { e += d; });
          return res.on('end', () => reject(Object.assign(new Error('llama-server HTTP ' + res.statusCode + ': ' + e.slice(0, 200)), { status: res.statusCode })));
        }
        let buf = '', full = '', finish = 'stop', timings = null, usage = null;
        res.on('data', d => {
          buf += d;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
            if (ev.timings) timings = ev.timings;
            if (ev.usage) usage = ev.usage;
            const ch = (ev.choices || [])[0];
            if (!ch) continue;
            if (ch.finish_reason) finish = ch.finish_reason === 'length' ? 'length' : 'stop';
            const piece = ch.delta && ch.delta.content;
            if (piece) { full += piece; emitted = true; try { onToken && onToken(piece, full); } catch (e) {} }
          }
        });
        res.on('end', () => resolve(Object.assign({ model: body.model || c.name, done: true, done_reason: finish },
          counters(timings, usage, Date.now() - t0), { message: { content: full, thinking: '' } })));
      });
      req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('llama-server timed out')));
      req.on('error', reject);
      req.end(data);
    });
  } catch (e) { e.emitted = emitted; throw e; }
  finally { scheduleStop(body.keep_alive); }
}

function init(d) {
  Object.assign(deps, d || {});
  // The gate counts this server as a resident model and may evict it (see ollama.registerExternal).
  if (deps.door && deps.door.registerExternal) {
    deps.door.registerExternal(deps.envVal('JARVIS_LORA_NAME') || 'jarvis', {
      size: (() => { const c = config(); try { return c ? fs.statSync(c.base).size + fs.statSync(c.lora).size : 0; } catch (e) { return 0; } })(),
      loaded: async () => !!config() && pids(config()).length > 0 && healthy(),
      bytes: residentBytes,
      evict: () => stop('evicted to make room'),
    });
  }
}
// A server this process started does not outlive it (launchd also ends the job's whole process group).
process.on('exit', () => { if (child && !child.killed) { try { child.kill('SIGTERM'); } catch (e) {} } });

module.exports = { init, handles, listEntry, chat, chatStream, stop, ensure, status: async () => ({ configured: !!config(), up: await healthy(), ctx: ctxNow, port: port() }),
  _toLlama: toLlama, _fromLlama: fromLlama, _keepMs: keepMs, _config: config };
