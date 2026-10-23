'use strict';
// THE GREETING-STYLE CANDIDATE (2026-10-09): ONE line of the live prompt changes — his "Manner" setting line (profile.js,
// manner 'ironman') — so a bare reply gets a short offer of help, the way JARVIS speaks. It names no kinds of message (rule #1):
// the condition is on the REPLY ("would otherwise be a bare line"), not on what he typed. Rendered from the live prompts
// (data/bonsai_eval_prompts_pg_long.jsonl, build_bonsai_eval.js on data/prompt_heldout_v2.json) so nothing else differs.
//   node build_prompt_greet_eval.js   → data/bonsai_eval_prompts_pg_M.jsonl
const fs = require('fs');
const path = require('path');
const OLD = '- Manner: the JARVIS of the films — dry, quick, a side-comment or light bit of banter when it fits. ' +
  'Never at the cost of the answer, and never when he is in a hurry or something failed.';
const NEW = '- Manner: the JARVIS of the films — courteous and at his service; dry, quick, a side-comment or light bit of banter ' +
  'when it fits. When a reply would otherwise be a bare line, add a short offer of help or ask what he needs. Never at the ' +
  'cost of the answer, and never when he is in a hurry or something failed.';
const D = p => path.join(__dirname, 'data', p);
const rows = fs.readFileSync(D('bonsai_eval_prompts_pg_long.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const out = rows.map(r => {
  const sys = r.messages[0].content;
  if (sys.split(OLD).length !== 2) throw new Error('manner line not found exactly once in ' + r.section + ':' + r.i);
  return Object.assign({}, r, { messages: [{ role: 'system', content: sys.replace(OLD, NEW) }, r.messages[1]] });
});
fs.writeFileSync(D('bonsai_eval_prompts_pg_M.jsonl'), out.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log('wrote data/bonsai_eval_prompts_pg_M.jsonl (' + out.length + ' prompts)');
module.exports = { OLD, NEW };
