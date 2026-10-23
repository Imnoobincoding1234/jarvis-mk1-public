'use strict';
// grounded.js — answering a factual question FROM A FETCHED SOURCE (2026-10-04, his call for jarvis v4.1).
//
// Why: the small chat model does not know when it does not know. Reading stock Bonsai's answers to 388 general
// questions (finetune/data/v41_knowledge_review.json): 74 confidently wrong ("capital of Maharashtra is Nagpur",
// "Für Elise by ABBA"), 3 "I don't know"s. So "search when unsure" cannot be left to the model — JARVIS fetches a
// source for a factual question and the model answers from it, and says so when the source does not answer it.
//
// This file is the CONTRACT shared by training (finetune/build_grounded_v41.js) and the live lane: the exact user
// message the model sees. The system prompt is the normal chat one. Deciding WHICH questions get a source is not here
// and must stay semantic (his rule: no word lists) — the reader / an intent region, measured on a held-out set.
// Live since 2026-10-08: server.js groundedAnswer(), behind webintent.needsWeb, with the `jarvis` chat model.

const MAX_SOURCE = 1300;  // characters of source text (a lead summary + three search snippets fit)

// Cut long text at the last word boundary before the limit and mark the cut with " …", the way every search snippet
// below already ends. Spaces collapse; line breaks stay (they separate the summary from the snippets).
// It used to back up to the last ". " "? " "! " so the model never read a half sentence — punctuation standing in for
// meaning, which his rule #1 forbids, so it was measured before it went (2026-10-08, sweeps/sweep_clip.js): on the 141
// answer-check sources the two cuts differ on 25; jarvis answered all 25 again from the word cut — 15 replies identical,
// 7 different but equally right/wrong, 2 better ("the capital of Canada is not Toronto" became an honest decline;
// Salvator Mundi became "attributed in whole or part to Leonardo"), 1 worse (Princess Bride gained Goldman's fictional
// "S. Morgenstern" as a source). Not needed, so gone.
function clip(text, max) {
  const t = String(text || '').replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
  const m = max || MAX_SOURCE;
  if (t.length <= m) return t;
  return t.slice(0, m).replace(/\s+\S*$/, '') + ' …';
}

const stripSnippet = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Wikipedia as a source: the lead summary of the top hit, then the search snippets of the top hits. The snippet is the
// sentence that matched the question, and it often holds what the lead leaves out ("Mizoram is a state … with Aizawl
// as its capital" — the Odisha lead never names its capital). hits: action=query&list=search results (title, snippet);
// summary: rest_v1/page/summary of hits[0] (title, extract).
function fromWikipedia(hits, summary) {
  const hs = (hits || []).slice(0, 3);
  const lead = clip(summary && summary.extract, 650);
  const snips = hs.map(h => h.title + ': … ' + stripSnippet(h.snippet) + ' …');
  return { title: (summary && summary.title) || (hs[0] && hs[0].title) || '', host: 'en.wikipedia.org',
    text: lead + (snips.length ? '\nSearch matches:\n' + snips.join('\n') : '') };
}

// source: { title, host, text } — e.g. agentreach.wikipedia(q) → { title, url, text } (host taken from url)
function userMessage(question, source) {
  let host = source.host || '';
  if (!host && source.url) { try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; } }
  return 'QUESTION: ' + String(question).trim() + '\n' +
    'SOURCE (' + (host || 'web') + ' — ' + String(source.title || '').trim() + '):\n' + clip(source.text) + '\n\n' +
    'Answer the question in one or two plain sentences, using only the source. If the source does not answer it, say so.';
}

// DOES THE REPLY STAND ON THE SOURCE? Judged by meaning — never by the spelling of the reply's words.
//
// WHAT THIS REPLACED, AND WHY. supported() (d993d88, retired 2026-10-08) took every capitalised word in the reply as a
// name the page had to print and split sentences at punctuation — spelling, not meaning, which his rule #1 forbids (his
// 2026-09-24 ruling: capitals are not a "shape"). On a fresh held-out it also failed at its own job: it kept "Jim Lovell
// commanded Apollo 11" off the Apollo 13 page and "Rajendra Prasad was India's first prime minister" off his page (every
// name is printed there), and threw away "A barometer measures air pressure" (no capital to find).
//
// HOW. jarvis itself is asked, as one more turn of the conversation that produced the reply: the reply goes back as
// its own turn, then "STATEMENT: <reply> — Does the SOURCE above state this? Answer yes or no." The answer prompt
// (system prompt + userMessage) is still in Ollama's cache, so only those few tokens are new: median 0.63 s, p90 0.9 s.
// The verdict is read from the first token's probabilities for the two answers the question names (JARVIS's own answer
// protocol, as readmodel.js reads open/close): keep only when P(yes) is more than CHECK_AT of P(yes) + P(no).
//
// WHY A HIGH BAR AND NOT "YES BEATS NO". jarvis is very sure of its right answers (most at 0.89–0.99) and never above
// 0.80 on a "the source does not say…" reply; at 0.5 it waved 26 of 38 such replies through (round 1). 0.886 was fitted
// on one fresh held-out and confirmed on a second (finetune/README "Round 2 of the answer check";
// sweeps/choose_answercheck_r2.js; errors = 2 × wrong kept + right sent on):
//
//                                           set 1 (114, leave-one-out)        set 2 (95, scored once)
//                                           right / declines / wrong / err    right / declines / wrong / err
//     old supported() (capitals)            53/59   35/38   4/17   —          —     (round-1 replies)
//     round 1: decline region + judge > .5  53/59   39/39   8/16   22         35/41   35/35   7/19   30
//     this: judge > 0.886                   52/59   39/39  11/16   17         35/41   35/35  12/19   20
//
// (round 1's nomic "decline region" step is gone with it: one more model swap, and it read Hinglish declines as
// answers. It lives on, for measuring only, in sweeps/declineregion.js.) An independent judge was not better: the same
// question put to qwen2.5:3b, standalone, 24 errors on set 1, at 2.7 s and a model swap.
// What it still keeps: wrong answers jarvis is sure of — "The first American in space was John Glenn Jr." off his page
// (it says "third"), "The capital of Brazil is São Paulo" off the São Paulo page (the state's capital), and true lines
// that do not answer the question ("Douglas Adams wrote The Hitchhiker's Guide…" for "who wrote the guide").
const CHECK_YES = 'yes', CHECK_NO = 'no';
const CHECK_AT = 0.886;
function checkMessages(answerMessages, reply) {
  const r = String(reply || '').trim();
  return answerMessages.concat([{ role: 'assistant', content: r },
    { role: 'user', content: 'STATEMENT: ' + r + '\n\nDoes the SOURCE above state this? Answer ' + CHECK_YES + ' or ' + CHECK_NO + '.' }]);
}
// logprobs: Ollama's list for the one generated token (request it with logprobs:true, top_logprobs:20).
// → { ok, yes, no, share } | null (neither answer among the alternatives)
function checkVerdict(logprobs) {
  const first = Array.isArray(logprobs) ? logprobs[0] : null;
  if (!first) return null;
  let yes = 0, no = 0;
  const seen = new Set();
  for (const a of [first].concat(Array.isArray(first.top_logprobs) ? first.top_logprobs : [])) {
    if (!a || typeof a.logprob !== 'number' || seen.has(a.token)) continue;
    seen.add(a.token);
    const t = String(a.token).trim().toLowerCase();
    if (t === CHECK_YES) yes += Math.exp(a.logprob);
    else if (t === CHECK_NO) no += Math.exp(a.logprob);
  }
  if (!yes && !no) return null;
  const share = yes / (yes + no);
  const r3 = x => Math.round(x * 1000) / 1000;
  return { ok: share > CHECK_AT, yes: r3(yes), no: r3(no), share: r3(share) };
}

module.exports = { MAX_SOURCE, clip, fromWikipedia, userMessage, stripSnippet, CHECK_YES, CHECK_NO, CHECK_AT, checkMessages, checkVerdict };
