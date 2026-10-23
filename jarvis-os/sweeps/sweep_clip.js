#!/usr/bin/env node
// sweep_clip.js — is grounded.clip()'s cut at a sentence end (". " "? " "! ") needed? (2026-10-08, his "test if this
// is needed"). The alternative cuts at the last word boundary before the limit and adds " …" — position only, no
// punctuation — the way the search snippets already end. Each source of the answer-check held-outs (set 1, 114, and
// the 27 dev sources) is rebuilt both ways from the cached Wikipedia responses (read-only: finetune/data/wiki_cache.json
// is never written here); where the two differ, jarvis answers again from the word-cut source exactly as the live lane
// does, and the new replies are written out to be read by hand against their source.
//   node sweeps/sweep_clip.js            → finetune/runs/clip_sweep.jsonl
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../grounded.js');
const F = p => path.join(__dirname, '..', '..', 'finetune', p);
const cache = JSON.parse(fs.readFileSync(F('data/wiki_cache.json'), 'utf8'));
const SYSTEM = fs.readFileSync(F('runs/v42_check_replies.system.txt'), 'utf8');

// grounded.clip with its punctuation branch removed — everything else identical
function clipWord(text, max) {
  const t = String(text || '').replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
  const m = max || G.MAX_SOURCE;
  if (t.length <= m) return t;
  return t.slice(0, m).replace(/\s+\S*$/, '') + ' …';
}
function compose(hits, summary, cut) {
  const hs = (hits || []).slice(0, 3);
  const lead = cut(summary && summary.extract, 650);
  const snips = hs.map(h => h.title + ': … ' + G.stripSnippet(h.snippet) + ' …');
  return cut(lead + (snips.length ? '\nSearch matches:\n' + snips.join('\n') : ''));   // userMessage's own clip(text)
}
function rawFor(term) {
  const s = cache['https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + encodeURIComponent(term)];
  const hits = (s && s.query && s.query.search) || [];
  if (!hits.length) return null;
  const sum = cache['https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hits[0].title.replace(/ /g, '_'))];
  return sum && sum.extract ? { hits, summary: sum } : null;
}
async function answer(q, title, text) {
  const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jarvis', think: false, stream: false, keep_alive: '60s',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: G.userMessage(q, { title, host: 'en.wikipedia.org', text }) }],
      options: { num_predict: 400, num_ctx: 4096, temperature: 0, use_mmap: true } }) });
  const j = await r.json();
  return String((j.message && j.message.content) || '').trim();
}

(async () => {
  const sets = [
    { name: 'set1', items: JSON.parse(fs.readFileSync(F('data/v42_check_heldout.json'), 'utf8')).items,
      replies: new Map(fs.readFileSync(F('runs/v42_check_replies.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.i, r.reply])) },
    { name: 'dev', items: JSON.parse(fs.readFileSync(F('data/v42_grounded_heldout.json'), 'utf8')).items,
      replies: new Map(fs.readFileSync(F('runs/bonsai_eval_v42u690_g.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.i, r.reply])) },
  ];
  const out = F('runs/clip_sweep.jsonl');
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return r.set + ':' + r.i; }) : []);
  for (const S of sets) {
    let same = 0, differ = 0, unbuilt = 0, rebuiltOk = 0, leadCut = 0, totalCut = 0;
    for (const [i, it] of S.items.entries()) {
      if (!it.source) continue;
      const raw = rawFor(it.page || it.query || it.q);
      if (!raw) { unbuilt++; continue; }
      const sent = compose(raw.hits, raw.summary, G.clip);
      if (sent === G.clip(it.source.text)) rebuiltOk++;   // the rebuild reproduces what the model was shown
      const word = compose(raw.hits, raw.summary, clipWord);
      if (String(raw.summary.extract).replace(/\s+/g, ' ').trim().length > 650) leadCut++;
      if (G.clip(it.source.text) !== it.source.text.replace(/[ \t\r\f\v]+/g, ' ').trim()) totalCut++;
      if (sent === word) { same++; continue; }
      differ++;
      if (done.has(S.name + ':' + i)) continue;
      const rep = await answer(it.q, it.source.title, word);
      fs.appendFileSync(out, JSON.stringify({ set: S.name, i, q: it.q, sentenceCut: sent.split('\nSearch matches:')[0].slice(-120),
        wordCut: word.split('\nSearch matches:')[0].slice(-120), oldReply: S.replies.get(i), newReply: rep, changed: rep !== S.replies.get(i) }) + '\n');
      console.log(S.name, i, it.q, '\n   old: ' + S.replies.get(i) + '\n   new: ' + rep);
    }
    console.log(S.name + ': rebuilt ' + rebuiltOk + ' exactly, could not rebuild ' + unbuilt + '; lead over 650 chars: ' + leadCut +
      '; sources that differ between the two cuts: ' + differ + ', identical: ' + same);
  }
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
