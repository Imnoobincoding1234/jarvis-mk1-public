'use strict';
// RENDERS data/jarvis_heldout.json INTO THE PROMPTS JARVIS WOULD SEND — once, so every candidate (stock Bonsai,
// each seed, the soup, the 3B) answers byte-identical text. 2026-09-26. Same machinery as the training rows
// (build_bonsai_data.js): server.js systemPrompt with `over` for the machine state, REASON_EXTRA with the full
// state for worked answers, context.js standsForPrompt for the resolver. Nothing is graded here.
//
//   node build_bonsai_eval.js        → data/bonsai_eval_prompts.jsonl
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.build_bonsai.json';
const fs = require('fs');
const path = require('path');
const J = require('../jarvis-os/server.js');
const cx = require('../jarvis-os/context.js');

// v2 (2026-09-29): BONSAI_HELD=jarvis_heldout_v2.json BONSAI_PROMPTS=bonsai_eval_prompts_v2.jsonl
const H = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', process.env.BONSAI_HELD || 'jarvis_heldout.json'), 'utf8'));
const NORMAL = { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61 };
// v4.2 (2026-10-05): each item's prompt shows ITS OWN clock (`now`, default below) and a fixed weather — or none when the
// item says `weather: null` (offline). Before, every prompt carried the build minute's clock and the live weather
// (v4.1's set: 10:49 AM for "shaam ho gayi jarvis"). Held-outs from before v4.2 have no `now` and keep their old behaviour.
const C = require('./promptclock');
const CLOCKED = H.greet.concat(H.caps, H.chat).some(c => 'now' in c) || /v42/.test(process.env.BONSAI_HELD || '');
const DEFAULT_NOW = '2026-10-13T16:10', DEFAULT_WEATHER = { temp: 27, unit: 'C', desc: 'Clear', city: 'Nagpur' };
const clocked = (sys, c) => CLOCKED ? C.setClock(sys, C.at((c && c.now) || DEFAULT_NOW), c && c.weather === null ? null : DEFAULT_WEATHER) : sys;
// Max reply tokens per job — the live budgets' order of size (chat 700 is a ceiling nobody reaches in a greeting).
const MAX = { greet: 80, caps: 120, chat: 200, reasoning: 400, resolver: 24 };

(async () => {
  const out = [];
  for (const sec of ['greet', 'caps', 'chat']) {
    for (const [i, c] of H[sec].entries()) {
      const { down, ...stats } = c.stats || {};
      const sys = await J._systemPrompt(null, { over: { stats: Object.assign({}, NORMAL, stats), down: down || [] } });
      out.push({ section: sec, i, q: c.q, max: MAX[sec], meta: c, messages: [{ role: 'system', content: clocked(sys, c) }, { role: 'user', content: c.q }] });
    }
  }
  const rsys = await J._systemPrompt(J.REASON_EXTRA, { state: 'full', over: { stats: NORMAL, down: [] } });
  for (const [i, c] of H.reasoning.entries())
    out.push({ section: 'reasoning', i, q: c.q, max: MAX.reasoning, meta: c, messages: [{ role: 'system', content: clocked(rsys, c) }, { role: 'user', content: c.q }] });
  for (const [i, c] of H.resolver.entries()) {
    const msgs = c.convo.map(([role, content]) => ({ role, content })).concat([{ role: 'user', content: c.request }]);
    const p = cx.standsForPrompt(c.request, msgs);
    out.push({ section: 'resolver', i, q: c.request, max: MAX.resolver, meta: c,
      prior: cx.transcriptOf(msgs), messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }] });
  }
  fs.writeFileSync(path.join(__dirname, 'data', process.env.BONSAI_PROMPTS || 'bonsai_eval_prompts.jsonl'), out.map(r => JSON.stringify(r)).join('\n') + '\n');
  const by = {}; for (const r of out) by[r.section] = (by[r.section] || 0) + 1;
  console.log('wrote data/' + (process.env.BONSAI_PROMPTS || 'bonsai_eval_prompts.jsonl') + ' — ' + out.length + ' prompts ' + JSON.stringify(by));
  process.exit(0);
})();
