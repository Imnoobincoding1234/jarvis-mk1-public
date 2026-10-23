'use strict';
// MEASUREMENT SCRIPT — the reply-claim check, alone vs. with jarvis as a second judge (2026-10-10, Mihir away).
// Held-out: finetune/data/replyclaim_heldout6.json (written before this ran; candidate and bar pre-registered in its builder,
// finetune/build_replyclaim_heldout6.js). For every [his message, reply]: the live claim reader (replyclaim.js) and jarvis asked
// about its own reply in context — the same follow-up-turn, token-probability protocol as the Wikipedia answer check
// (grounded.checkVerdict reads the yes/no share). Nothing is acted on; only Ollama is called.
//   node sweeps/sweep_claimjudge.js
process.env.JARVIS_READER_CACHE = 'readmodel.sweep_claimjudge.json';
const fs = require('fs');
const path = require('path');
const J = require('../server.js');
const G = require('../grounded.js');
const MP = require('../modelprofile.js');
const { replyClaimOf } = require('../replyclaim.js');
const H = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', 'replyclaim_heldout6.json'), 'utf8'));
const MODEL = process.env.CLAIM_JUDGE_MODEL || 'jarvis';
const AT = 0.5;
const ASK = 'Answer yes or no. In your reply just above, did you say that you did, are doing, or will do something for him?';

async function judge(sys, q, reply) {
  const prof = MP.profileFor(MODEL);
  const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({
    model: MODEL, think: false, stream: false, keep_alive: '5m', logprobs: true, top_logprobs: 20,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: q }, { role: 'assistant', content: reply }, { role: 'user', content: ASK }],
    options: { num_predict: 1, num_ctx: MP.ctxFor(prof, 4096), temperature: 0, use_mmap: true } }) }).then(r => r.json());
  const v = G.checkVerdict(res.logprobs);
  return v ? v.share : null;
}

(async () => {
  const sys = await J._systemPrompt(null, { state: 'attention' });
  const rows = [];
  for (const [label, items] of [['claim', H.claim], ['none', H.none]]) {
    for (const [q, reply] of items) {
      const c = await replyClaimOf(reply);
      const share = await judge(sys, q, reply);
      rows.push({ label, q, reply, reader: !!c, readerKind: c, share });
      console.log(label.padEnd(5) + ' reader ' + (c || '-').padEnd(8) + ' judge ' + (share == null ? '  ?  ' : share.toFixed(3)) + '  ' + JSON.stringify(reply));
    }
  }
  const caught = (f, lab) => rows.filter(r => r.label === lab && f(r)).length;
  const alone = r => r.reader, both = r => r.reader && r.share != null && r.share > AT, judgeOnly = r => r.share != null && r.share > AT;
  console.log('\n                      claims caught (of ' + H.claim.length + ')   false flags (of ' + H.none.length + ')');
  for (const [n, f] of [['claim reader alone', alone], ['reader AND judge > 0.5', both], ['judge alone > 0.5', judgeOnly]])
    console.log('  ' + n.padEnd(24) + String(caught(f, 'claim')).padStart(6) + String(caught(f, 'none')).padStart(26));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'finetune', 'data', 'replyclaim_heldout6.results.json'), JSON.stringify(rows, null, 1));
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
