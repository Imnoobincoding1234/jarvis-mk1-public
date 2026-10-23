'use strict';
// grounded.js — the Wikipedia-lane contract and its answer check (2026-10-08).
// The pure parts always run. The live parts NEED OLLAMA with `jarvis`, and use the 27 v4.2
// development sources (finetune/data/v42_grounded_heldout.json) — never the fresh held-out the check was measured on.

const fs = require('fs');
const path = require('path');
const G = require('../grounded.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');
const lp = (pairs) => [{ token: pairs[0][0], logprob: Math.log(pairs[0][1]), top_logprobs: pairs.map(([token, p]) => ({ token, logprob: Math.log(p) })) }];

(async () => {
  head('the contract the model was trained on is unchanged');
  const src = { title: 'Thimphu', host: 'en.wikipedia.org', text: 'Thimphu is the capital and largest city of Bhutan.' };
  const um = G.userMessage(' what is the capital of bhutan ', src);
  ok(um.startsWith('QUESTION: what is the capital of bhutan\nSOURCE (en.wikipedia.org — Thimphu):\n'), 'userMessage opens with the question and the source line');
  ok(um.endsWith('Answer the question in one or two plain sentences, using only the source. If the source does not answer it, say so.'), 'userMessage ends with the trained instruction');
  const fw = G.fromWikipedia([{ title: 'Thimphu', snippet: 'is the <span>capital</span> &amp; seat' }], { title: 'Thimphu', extract: 'Thimphu is the capital.' });
  ok(fw.text === 'Thimphu is the capital.\nSearch matches:\nThimphu: … is the capital & seat …', 'fromWikipedia: lead, then the snippets with the markup stripped');

  head('long text is cut at a word boundary, never at punctuation');
  ok(G.clip('aaa bbb. ccc ddd eee', 14) === 'aaa bbb. ccc …', 'cut at the last word before the limit, marked " …" (not back to "aaa bbb.")');
  ok(G.clip('  short   text ', 50) === 'short text', 'short text is only tidied');
  ok(!/lastIndexOf\('[.?!] '\)/.test(fs.readFileSync(path.join(__dirname, '..', 'grounded.js'), 'utf8')), 'no sentence-end search left in grounded.js');

  head('the capital-letter check is gone');
  ok(G.supported === undefined, 'grounded.supported() no longer exists');
  ok(!/\\p\{Lu\}/.test(fs.readFileSync(path.join(__dirname, '..', 'grounded.js'), 'utf8')), 'no upper-case letter class anywhere in grounded.js');

  head('the follow-up question keeps the cached answer prompt as its prefix');
  const ask = [{ role: 'system', content: 'SYS' }, { role: 'user', content: um }];
  const cm = G.checkMessages(ask, '  The capital of Bhutan is Thimphu. ');
  ok(cm.length === 4 && cm[0] === ask[0] && cm[1] === ask[1], 'the answer prompt is passed through untouched');
  ok(cm[2].role === 'assistant' && cm[2].content === 'The capital of Bhutan is Thimphu.', 'the reply goes back as the assistant turn');
  ok(cm[3].role === 'user' && cm[3].content.includes('STATEMENT: The capital of Bhutan is Thimphu.') &&
     cm[3].content.includes(G.CHECK_YES) && cm[3].content.includes(G.CHECK_NO), 'one user turn naming the two answers checkVerdict reads');
  ok(ask.length === 2, 'the caller\'s array is not modified');

  head('the verdict is read from the first token\'s probabilities, against a high bar');
  ok(G.CHECK_AT === 0.886, 'the bar is 0.886 of P(yes) + P(no) (fitted on held-out 1, confirmed on held-out 2)');
  ok(G.checkVerdict(lp([['Yes', 0.95], ['No', 0.02]])).ok === true, 'yes 0.95 / no 0.02 → kept');
  ok(G.checkVerdict(lp([['Yes', 0.8], ['No', 0.2]])).ok === false, 'yes 0.8 / no 0.2 → sent on: "mostly yes" is not sure enough');
  ok(G.checkVerdict(lp([['No', 0.6], [' yes', 0.3]])).ok === false, 'no over yes → sent on');
  const sum = G.checkVerdict(lp([['Yes', 0.6], ['yes', 0.33], ['No', 0.05]]));
  ok(sum.ok === true && sum.yes === 0.93 && sum.share === 0.949, 'both spellings of the answer token add up (0.6 + 0.33 over 0.05)');
  ok(G.checkVerdict([]) === null && G.checkVerdict(null) === null, 'no tokens → no verdict');
  ok(G.checkVerdict(lp([['Car', 0.9]])) === null, 'neither answer among the alternatives → no verdict');
  ok(G.declines === undefined && G.DECLINE_EXEMPLARS === undefined, 'round 1\'s nomic decline step is gone from production');

  if (!await require('../ollama.js').reachable(1500)) {
    console.log('\nollama is not reachable — Skipping the live checks.');
    return done();
  }
  const tags = await fetch('http://127.0.0.1:11434/api/tags').then(r => r.json()).catch(() => null);
  const have = n => !!(tags && (tags.models || []).some(m => m.name === n || m.name === n + ':latest'));
  if (!have('jarvis')) {
    console.log('\njarvis is not installed — Skipping the live checks.');
    return done();
  }

  head('the whole check on three development sources (v4.2 replies)');
  const F = p => path.join(__dirname, '..', '..', 'finetune', p);
  const items = JSON.parse(fs.readFileSync(F('data/v42_grounded_heldout.json'), 'utf8')).items;
  const prompts = fs.readFileSync(F('data/bonsai_eval_prompts_v42_grounded.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  async function check(i, reply) {
    const msgs = prompts.find(p => p.i === i).messages;
    const j = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jarvis', think: false, stream: false, keep_alive: '30s', logprobs: true, top_logprobs: 20,
        messages: G.checkMessages(msgs, reply), options: { num_predict: 1, num_ctx: 4096, temperature: 0 } }) }).then(r => r.json());
    const v = G.checkVerdict(j.logprobs);
    return !!(v && v.ok);
  }
  ok(items[7].q === 'what is the capital of bhutan' && await check(7, 'The capital of Bhutan is Thimphu.'), 'keeps a right answer the page states');
  ok(items[18].q === 'what is the capital of sikkim' && !await check(18, 'The source does not answer the question about the capital of Sikkim.'), 'sends on a decline');
  ok(items[21].q === 'who discovered x-rays' && !await check(21, 'Marie Curie discovered X-rays.'), 'sends on an answer from memory');
  ok(!await check(18, 'Is page mein iska jawab nahi hai, Boss.'), 'sends on a Hinglish decline (the judge says no)');
  done();
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });

function done() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
