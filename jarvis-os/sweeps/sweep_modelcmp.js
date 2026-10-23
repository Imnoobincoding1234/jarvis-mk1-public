'use strict';
// MEASUREMENT SCRIPT — not a test. Nothing is executed on the Mac: chat replies are only read, the resolver
// only answers, and the agent's `nextStep` only CHOOSES a tool (its choice is graded, never run).
//
// WHICH LOCAL MODEL SHOULD WRITE JARVIS'S ANSWERS AND DRIVE ITS LOOP? (2026-09-24, qwen2.5 3B vs Bonsai 4B)
//
// Every candidate sees JARVIS's own prompts: server.systemPrompt() for chat, context.standsFor for the
// reference resolver, agent.nextStep for the loop — called through a stand-in for server.js llm() that
// sends exactly what llm() sends for a local model (modelprofile ctx/num_predict, think:false, use_mmap,
// the JSON schema, temperature only when the caller sets one). Candidates run ONE AT A TIME, and the run
// aborts (model stopped) if free memory drops under 15%.
//
// Held-out: finetune/data/modelcmp_heldout.json, written before any candidate was run. Agent decisions
// are sampled in the live path (no temperature), so each is asked 3 times and counts only if all 3 pass.
//
//   node sweeps/sweep_modelcmp.js qwen2.5:3b-instruct-q4_K_M hf.co/prism-ml/Bonsai-4B-gguf:Q1_0
process.env.JARVIS_READER_CACHE = 'readmodel.sweep_modelcmp.json';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const J = require('../server.js');
const agent = require('../agent.js');
const cx = require('../context.js');
const MP = require('../modelprofile.js');
const { replyClaimOf } = require('../replyclaim.js');

const SET = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', 'modelcmp_heldout.json'), 'utf8'));
const MODELS = process.argv.slice(2);
const AGENT_RUNS = 3;
const MIN_FREE = 15;

const free = () => Number((/(\d+)%/.exec(spawnSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8' }).stdout) || [])[1]);
const post = body => new Promise(res => {
  const d = Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': d.length } }, x => {
    let b = ''; x.on('data', c => { b += c; }); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({ error: b.slice(0, 200) }); } });
  });
  r.setTimeout(240000, () => r.destroy(new Error('timeout')));
  r.on('error', e => res({ error: e.message })); r.write(d); r.end();
});

let current = null, lowest = 100, aborted = false;
const watch = setInterval(() => {
  const f = free(); lowest = Math.min(lowest, f);
  if (f < MIN_FREE && !aborted) {
    aborted = true;
    console.log('\nABORTED — free memory ' + f + '% (< ' + MIN_FREE + '%); stopping ' + current);
    spawnSync('ollama', ['stop', current]);
    process.exit(2);
  }
}, 500);

// Same body as server.js llm() for a local model.
async function llmFor(opts) {
  const model = current;
  const prof = MP.profileFor(model);
  const numCtx = MP.ctxFor(prof, opts.ctx || 8192);
  const msgs = (opts.system ? [{ role: 'system', content: opts.system }] : []).concat(opts.messages || []);
  const body = { model, messages: msgs, think: false, stream: false, keep_alive: '60s',
    options: Object.assign({ num_predict: MP.fitTokens(prof, opts.max_tokens || 700, numCtx), num_ctx: numCtx, use_mmap: true },
                           typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}) };
  if (opts.schema && MP.supportsSchema(prof)) body.format = opts.schema;
  const r = await post(body);
  if (r.error) throw new Error(r.error);
  return { text: String((r.message && r.message.content) || '') };
}
cx.init({ llm: llmFor });
agent.init({ llm: llmFor });

const has = (s, subs) => (subs || []).some(x => String(s).toLowerCase().includes(String(x).toLowerCase()));
const timed = async fn => { const t0 = Date.now(); const v = await fn(); return [v, Date.now() - t0]; };

async function runModel(model) {
  current = model;
  console.log('\n==================== ' + model + ' ====================');
  const out = { model, chat: { pass: 0, n: 0, ms: [] }, resolver: { exact: 0, miss: 0, wrong: 0, n: 0 }, agent: { pass: 0, n: 0, invalid: 0 } };
  const sys = await J._systemPrompt(null);

  console.log('\n— chat (JARVIS system prompt, ' + sys.length + ' chars) —');
  for (const c of SET.chat) {
    const [r, ms] = await timed(() => llmFor({ system: sys, messages: [{ role: 'user', content: c.q }], max_tokens: 700 }).catch(e => ({ text: 'ERROR ' + e.message })));
    const reply = r.text.trim();
    const claim = await replyClaimOf(reply);
    const factOk = !c.must || has(reply, c.must);
    const ok = factOk && !claim;
    out.chat.n++; if (ok) out.chat.pass++; out.chat.ms.push(ms);
    console.log((ok ? '  ok   ' : '  FAIL ') + String(ms).padStart(6) + 'ms  ' + c.q.slice(0, 40).padEnd(40) + ' → ' +
      JSON.stringify(reply.slice(0, 110)) + (claim ? '  [claims: ' + claim + ']' : '') + (factOk ? '' : '  [missing ' + c.must.join('|') + ']'));
  }

  console.log('\n— reference resolver (context.standsFor) —');
  for (const c of SET.resolver) {
    const msgs = c.convo.map(([role, content]) => ({ role, content })).concat([{ role: 'user', content: c.request }]);
    const [r, ms] = await timed(() => cx.standsFor(c.request, msgs));
    let v;
    if (c.expect === 'NONE') v = r.ok ? 'wrong' : 'exact';
    else v = !r.ok ? 'miss' : (has(r.value, [c.expect]) ? 'exact' : 'wrong');
    out.resolver.n++; out.resolver[v]++;
    console.log('  ' + v.padEnd(5) + String(ms).padStart(6) + 'ms  ' + c.request.padEnd(32) + ' → ' + (r.ok ? JSON.stringify(r.value) : 'NONE (' + r.reason + ')') + '   want ' + c.expect);
  }

  console.log('\n— agent loop decisions (agent.nextStep, ' + AGENT_RUNS + ' samples each, nothing executed) —');
  for (const c of SET.agent) {
    const picks = [];
    let allOk = true, anyInvalid = false;
    for (let i = 0; i < AGENT_RUNS; i++) {
      const [s, ms] = await timed(() => agent._nextStep(c.goal, c.done, [], null, null));
      if (!s) { anyInvalid = true; allOk = false; picks.push('INVALID ' + ms + 'ms'); continue; }
      const argStr = JSON.stringify(s.args || {});
      const okTool = c.tool.includes(s.tool) && !(c.notTool || []).includes(s.tool);
      const okArgs = !c.args || Object.values(c.args).every(sub => has(argStr, [sub]));
      if (!(okTool && okArgs)) allOk = false;
      picks.push(s.tool + (s.tool === 'done' || s.tool === 'fail' ? '' : ' ' + argStr.slice(0, 70)) + ' ' + ms + 'ms');
    }
    out.agent.n++; if (allOk) out.agent.pass++; if (anyInvalid) out.agent.invalid++;
    console.log((allOk ? '  ok   ' : '  FAIL ') + (c.done.length ? '[after ' + c.done.length + '] ' : '') + c.goal.slice(0, 48));
    for (const p of picks) console.log('         ' + p);
  }
  spawnSync('ollama', ['stop', model]);
  return out;
}

(async () => {
  const results = [];
  for (const m of MODELS) results.push(await runModel(m));
  clearInterval(watch);
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log('\n==================== SUMMARY ====================');
  for (const r of results) {
    console.log(r.model);
    console.log('  chat      ' + r.chat.pass + '/' + r.chat.n + '   median ' + med(r.chat.ms) + ' ms');
    console.log('  resolver  exact ' + r.resolver.exact + '/' + r.resolver.n + ', miss ' + r.resolver.miss + ', WRONG ' + r.resolver.wrong);
    console.log('  agent     ' + r.agent.pass + '/' + r.agent.n + ' (all ' + AGENT_RUNS + ' samples right), invalid JSON in ' + r.agent.invalid);
  }
  console.log('lowest free memory during the run: ' + lowest + '%');
  process.exit(0);
})();
