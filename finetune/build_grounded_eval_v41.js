'use strict';
// Renders data/v41_grounded_heldout.json into the prompts every candidate answers (2026-10-04): the live chat system prompt +
// jarvis-os/grounded.js userMessage over the FROZEN source. Same row shape as build_bonsai_eval.js (section 'grounded'),
// so eval_bonsai.py (MLX) and eval_bonsai_ollama.js (the 3B) answer it unchanged. Graded by hand.
//   node build_grounded_eval_v41.js → data/bonsai_eval_prompts_v41_grounded.jsonl
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.build_bonsai.json';
const fs = require('fs');
const path = require('path');
const J = require('../jarvis-os/server.js');
const G = require('../jarvis-os/grounded.js');
const NORMAL = { batteryPct: 64, charging: false, cpu: 18, ramPct: 78, diskPct: 61 };
(async () => {
  // v4.2: GROUNDED_HELD / GROUNDED_PROMPTS (v42_grounded_heldout.json → bonsai_eval_prompts_v42_grounded.jsonl)
  const H = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', process.env.GROUNDED_HELD || 'v41_grounded_heldout.json'), 'utf8'));
  // v4.2: a fixed clock and weather (promptclock.js) so the prompts do not depend on the build minute; v4.1's set is unchanged
  const C = require('./promptclock');
  const sys0 = await J._systemPrompt(null, { over: { stats: NORMAL, down: [] } });
  const sys = process.env.GROUNDED_HELD ? C.setClock(sys0, C.at('2026-10-13T16:10'), { temp: 27, unit: 'C', desc: 'Clear', city: 'Nagpur' }) : sys0;
  const out = H.items.map((c, i) => ({ section: 'grounded', i, q: c.q, max: 120, meta: { must: c.must || null, decline: !!c.decline, note: c.note || null, title: c.source.title },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: G.userMessage(c.q, c.source) }] }));
  fs.writeFileSync(path.join(__dirname, 'data', process.env.GROUNDED_PROMPTS || 'bonsai_eval_prompts_v41_grounded.jsonl'), out.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log('wrote', out.length, 'grounded prompts — answer', out.filter(r => !r.meta.decline).length, 'decline', out.filter(r => r.meta.decline).length);
  process.exit(0);
})();
