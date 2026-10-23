'use strict';
// loraserver.js — jarvis on a pinned llama-server with its LoRA loaded at runtime (option 3, 2026-10-13, runtime/README.md).
// 1. the Ollama ⇄ llama-server translation, with no model;
// 2. the memory gate sees a model served outside Ollama and evicts it (a fake one, no model);
// 3. the real thing: the same chat, streamed and logprob requests to the LoRA server and to Ollama's own `jarvis`, one model
//    at a time — identical text and identical yes/no logprobs, or it fails.
const http = require('http');
const path = require('path');
const fs = require('fs');
const lora = require('../loraserver.js');
const door = require('../ollama.js');
const grounded = require('../grounded.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const ROOT = path.join(__dirname, '..', '..');

function ollamaChat(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      let s = ''; res.on('data', d => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}

(async () => {
  console.log('translation (no model)');
  const params = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'jarvis.params.json'), 'utf8'));
  const t = lora._toLlama({ model: 'jarvis', messages: [{ role: 'user', content: 'hi' }], think: false, logprobs: true, top_logprobs: 20,
    options: { num_predict: 1, num_ctx: 4096, temperature: 0.7, use_mmap: true } }, params);
  ok(t.max_tokens === 1 && t.temperature === 0.7 && t.top_k === 20 && t.top_p === 0.95, 'options map: num_predict → max_tokens; a call\'s temperature beats the default');
  ok(t.logprobs === true && t.top_logprobs === 20, 'logprobs and top_logprobs pass through');
  ok(Array.isArray(t.stop) && t.stop.includes('<|im_end|>'), 'jarvis\'s stop tokens are sent');
  ok(!('use_mmap' in t) && !('num_ctx' in t) && !('think' in t), 'Ollama-only fields are not forwarded');
  const f = lora._fromLlama('jarvis', { choices: [{ message: { content: 'Hey, Sir.' }, finish_reason: 'stop',
    logprobs: { content: [{ token: 'yes', logprob: -0.1, top_logprobs: [{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.4 }] }] } }],
    usage: { prompt_tokens: 964, completion_tokens: 4 }, timings: { prompt_n: 12, prompt_ms: 30, predicted_n: 4, predicted_ms: 90 } }, 120);
  ok(f.message.content === 'Hey, Sir.' && f.done === true && f.done_reason === 'stop', 'reply shape: message.content, done, done_reason');
  ok(f.eval_count === 4 && f.prompt_eval_count === 12 && f.eval_duration === 90e6, 'counters come from llama-server timings');
  const v = grounded.checkVerdict(f.logprobs);
  ok(v && v.share > 0.9, 'grounded.checkVerdict reads the translated logprobs (yes share ' + (v && v.share) + ')');
  ok(lora._keepMs('10m') === 600000 && lora._keepMs('30s') === 30000 && lora._keepMs(0) === 0 && lora._keepMs(-1) === Infinity,
    'keep_alive read as Ollama reads it');

  console.log('the Bonsai base is found wherever Ollama put its manifest (fake folders, no model)');
  {
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-manifest-'));
    for (const f of ['runtime/llama-server', 'runtime/jarvis.jinja', 'finetune/adapters/bonsai_v42_s1/jarvis-v42-lora.gguf']) {
      fs.mkdirSync(path.dirname(path.join(tmp, 'root', f)), { recursive: true }); fs.writeFileSync(path.join(tmp, 'root', f), 'x');
    }
    const parts = ['hf.co', 'prism-ml', 'Bonsai-4B-gguf', 'Q1_0'];
    const manifest = (dir, digest) => {
      const p = path.join(tmp, 'models', dir, ...parts); fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest }] }));
      fs.mkdirSync(path.join(tmp, 'models', 'blobs'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'models', 'blobs', digest.replace(':', '-')), 'x');
    };
    const was = process.env.OLLAMA_MODELS; process.env.OLLAMA_MODELS = path.join(tmp, 'models');
    lora.init({ root: path.join(tmp, 'root'), envVal: n => (n === 'OLLAMA_MODELS' ? process.env.OLLAMA_MODELS : null) });
    manifest('manifests-v2', 'sha256:v2');
    ok(lora._config() && lora._config().base.endsWith('sha256-v2'), 'a base pulled by Ollama 0.40.3 (manifests-v2/ only) is found');
    manifest('manifests', 'sha256:v1');
    ok(lora._config().base.endsWith('sha256-v1'), '…and when both exist the older manifests/ wins, as before the fix');
    const e = lora.listEntry();
    ok(e && e.name === 'jarvis' && e.where === 'llama-server' && e.size === 2, 'Settings → Models gets an entry for the model it serves, with its files\' size');
    if (was === undefined) delete process.env.OLLAMA_MODELS; else process.env.OLLAMA_MODELS = was;
    lora.init({ root: ROOT, envVal: n => process.env[n] || null });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (!(await door.reachable(1500))) { console.log('Skipping the gate and live parts: Ollama is not running'); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

  console.log('the memory gate sees a model served outside Ollama (fake, no model loaded)');
  let evicted = 0;
  door.registerExternal('fake-outside-model', { size: 0.6e9, loaded: async () => evicted === 0, bytes: () => 1.25e9, evict: async () => { evicted++; } });   // jarvis-sized: light
  const out = await door.makeRoomFor('all-minilm');
  ok(evicted === 0, 'an embedder does not evict it (embedders may sit beside one model)');
  await door.makeRoomFor('jarvis-reader');
  ok(evicted === 1, 'another generation model evicts it (budget 0: never two at once)');
  door.registerExternal('fake-outside-model', { size: 0, loaded: async () => false, bytes: () => 0, evict: async () => {} });

  lora.init({ root: ROOT, door, jlog: () => {} });
  if (!lora.handles('jarvis')) { console.log('Skipping the live part: runtime/ or the Bonsai base / LoRA files are missing'); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

  console.log('live: the LoRA server answers exactly as Ollama\'s jarvis (one model at a time)');
  const sys = 'You are JARVIS, a concise assistant. Reply in one short sentence.';
  const ask = [{ role: 'system', content: sys }, { role: 'user', content: grounded.userMessage('what is the capital of japan',
    { title: 'Japan', host: 'en.wikipedia.org', text: 'Japan is an island country in East Asia. Its capital and largest city is Tokyo.' }) }];
  const chatBody = { model: 'jarvis', messages: [{ role: 'system', content: sys }, { role: 'user', content: 'yo whats good' }], think: false, stream: false,
    keep_alive: '30s', options: { num_predict: 40, num_ctx: 4096, use_mmap: true } };
  const answerBody = Object.assign({}, chatBody, { messages: ask, options: { num_predict: 60, num_ctx: 4096, use_mmap: true } });
  const a1 = await lora.chat(chatBody, 120000);
  const a2 = await lora.chat(answerBody, 120000);
  let streamed = '';
  const a3 = await lora.chatStream(Object.assign({}, chatBody, { stream: true }), 120000, piece => { streamed += piece; });
  const checkBody = { model: 'jarvis', messages: grounded.checkMessages(ask, a2.message.content), think: false, stream: false, keep_alive: '30s',
    logprobs: true, top_logprobs: 20, options: { num_predict: 1, num_ctx: 4096, temperature: 0, use_mmap: true } };
  const a4 = await lora.chat(checkBody, 120000);
  ok((await lora.status()).up, 'the server is up after the calls');
  await door.makeRoomFor('jarvis-reader');   // budget 0: another generation model evicts it — the gate's job, measured here
  ok(!(await lora.status()).up, 'the gate evicts it when another generation model is about to load');

  const o1 = await ollamaChat(chatBody), o2 = await ollamaChat(answerBody), o4 = await ollamaChat(checkBody);
  await ollamaChat({ model: 'jarvis', messages: [], keep_alive: 0 }).catch(() => null);
  ok(a1.message.content === o1.message.content, 'chat reply identical: "' + a1.message.content.slice(0, 50) + '"');
  ok(a2.message.content === o2.message.content, 'answer-from-source identical: "' + a2.message.content.slice(0, 50) + '"');
  ok(streamed === a3.message.content && a3.message.content === o1.message.content, 'streamed tokens add up to the same reply');
  const va = grounded.checkVerdict(a4.logprobs), vo = grounded.checkVerdict(o4.logprobs);
  ok(va && vo && va.share === vo.share, 'answer check: same yes share (' + (va && va.share) + ' vs ' + (vo && vo.share) + ')');
  ok(a1.prompt_eval_count > 0 && a1.eval_count > 0, 'counters are filled for the cost meter');
  await lora.stop('test done');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL threw: ' + (e && e.stack || e)); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
