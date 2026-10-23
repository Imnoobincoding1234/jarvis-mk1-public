'use strict';
// ---------------------------------------------------------------------------
// JARVIS model profile — what a model COSTS to talk to, so the system can be
// fair to one it has never met.
//
// WHY THIS EXISTS.
//
// Every llm() call site in this project passes an absolute `max_tokens` and an
// absolute `timeoutMs` — 30 tokens for a classification, 60 for a rewrite, 900
// for research, 20s here, 180s there. Every one of those numbers was chosen by
// watching qwen2.5:3b, which is terse and, on this machine, a known speed.
//
// That is fine until you point the system at a DIFFERENT model, and then it is
// a rigged test. Measured facts from this project's own model search:
//
//   · granite-3.1-3b-a800m answered "what is the capital of France" in 729
//     characters where qwen2.5:3b used 31 — 23x the output. A call budgeted at
//     max_tokens:30 truncates that mid-sentence. The reply is then wrong, and
//     the scorecard says the MODEL is wrong. It is not: the budget was.
//   · The same model was genuinely FASTER per token (3x prefill, 2x decode,
//     8.34s -> 2.78s cold) and still lost on wall clock, because verbosity and
//     speed are different axes and this system only ever tuned for one of them.
//   · A model whose reasoning markers are not qwen's `<think>` leaks raw
//     reasoning into the reply. server.js already documents where that goes:
//     the musing tripped the hallucinated-action guard and a correct answer
//     came back as "I could not carry that out, Sir".
//
// So a candidate model could be rejected for being verbose, for being slow in a
// way that mattered less than it looked, or for punctuating its thoughts
// differently — none of which is being bad at the job.
//
// WHAT THIS DOES. Call sites keep expressing INTENT ("this needs about 30
// tokens for a terse model"). This module turns that intent into a budget for
// the model actually running, by scaling on two independent axes:
//
//   verbosity — how many output tokens this model spends per unit of answer
//   speed     — how much wall clock it spends per token, on THIS machine
//
// THE BASELINE IS THE INCUMBENT, DELIBERATELY. qwen2.5:3b is 1.0 on both axes,
// so every number already in the codebase keeps its exact current meaning and
// today's behaviour is unchanged to the token. Only a DIFFERENT model sees
// different budgets. That is the whole safety property of this file, and
// test_modelprofile asserts it directly rather than trusting the claim.
//
// AN UNKNOWN MODEL IS TREATED GENEROUSLY, NOT CAUTIOUSLY. The failure this file
// exists to prevent is under-budgeting, and the two errors are not symmetric:
// over-budgeting costs some latency, while under-budgeting produces a truncated
// answer that is indistinguishable from incompetence. So a model nobody has
// measured gets room, and `calibrate.js` replaces the guess with a measurement.
//
// NO DEPENDENCIES. Pure stdlib, per this project's standing rule.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// Where a calibrated profile is persisted. Written by calibrate.js, read here.
// Absent is the normal case and must never be an error.
let FILE = path.join(__dirname, 'state', 'modelprofiles.json');

// ---------------------------------------------------------------------------
// The axes
// ---------------------------------------------------------------------------
// verbosity: output tokens this model spends to say the same thing, relative to
//            qwen2.5:3b. 23.0 is not hypothetical — it is granite, measured.
// speed:     wall-clock per token relative to qwen2.5:3b ON THIS MACHINE. Below
//            1.0 means faster. This is a property of the pair (model, machine),
//            never of the model alone, which is why calibrate.js measures it
//            here rather than reading a number off a model card.
// reasoning: emits thinking tokens that come out of the same output budget. A
//            reasoning model needs headroom even when its final answer is short.
// schema:    can be held to a JSON schema (Ollama `format` / OpenAI
//            `response_format`). When false the caller must fall back to asking
//            for JSON in the prompt and parsing loosely.
// ctx:       context window the model actually supports. Ollama defaults an
//            unconfigured model to 2048 regardless of architecture, so this has
//            to be stated or older turns are silently truncated.
const BASELINE = 'qwen2.5:3b';

// Measured or vendor-documented. Keys are matched as substrings of the model
// name, longest first, so "qwen2.5:3b-instruct-q4_K_M" finds "qwen2.5:3b".
const KNOWN = {
  // THE BASELINE. 1.0/1.0 by definition — see the note above.
  'qwen2.5:3b':    { verbosity: 1.0,  speed: 1.0,  reasoning: false, schema: true,  ctx: 32768 },
  // Purpose-built VLM. Answers in `thinking` with an empty `content` even when
  // asked not to, which localChat already compensates for.
  'qwen3-vl':      { verbosity: 2.0,  speed: 1.6,  reasoning: true,  schema: true,  ctx: 32768, vision: true },
  // qwen3 family reasons by default and emits <think> inline whatever think:false asks.
  'qwen3':         { verbosity: 3.0,  speed: 1.3,  reasoning: true,  schema: true,  ctx: 32768 },
  // Faster per token, wildly more verbose. The pair that motivated this file.
  'granite-3.1':   { verbosity: 23.0, speed: 0.45, reasoning: false, schema: true,  ctx: 8192 },
  'smollm3':       { verbosity: 1.2,  speed: 0.8,  reasoning: false, schema: true,  ctx: 8192 },
  'all-minilm':    { verbosity: 1.0,  speed: 0.3,  reasoning: false, schema: false, ctx: 512, embedding: true },
  // THE MAIN EMBEDDER since 2026-09-12, replacing all-minilm. Profiled explicitly because
  // profileFor() matches by substring and 'nomic-embed-text' contains none of the other keys — it
  // would otherwise fall through to the guessed default and be treated as a CHAT model, which is
  // how an embedder ends up being asked for JSON. 768 dims; embeddings are pinned to num_ctx 512 by
  // every caller, so the window below is the one it is actually used with, not its maximum.
  'nomic-embed':   { verbosity: 1.0,  speed: 0.6,  reasoning: false, schema: false, ctx: 512, embedding: true },
  // THE HOSTED DEFAULT. chatModel() falls back to this for every `tier:'hard'`
  // call — deepresearch's planning, distilling and final synthesis, the three
  // this system deliberately spends a hosted call on. It was profiled as
  // 'guessed', which is not what "verified against the real .env model string"
  // meant: that check covered the LOCAL half of a two-path system and stopped.
  // Dormant only because OPENROUTER_API_KEY is currently empty; it activates the
  // instant a key is added, with no code change and no warning.
  'qwen/qwen-2.5-7b': { verbosity: 1.2, speed: 1.0, reasoning: false, schema: true, ctx: 32768, hosted: true },
};

// A hosted slug ("vendor/model"), not something running on this Mac.
const HOSTED_RE = /\//;

// A model nobody has measured. Generous on both axes for the asymmetry reason
// above: 2.5x output room and 2x the clock. Not infinite — a runaway model still
// has to be cut off, or one bad generation hangs a chat turn forever.
const UNKNOWN = { verbosity: 2.5, speed: 2.0, reasoning: false, schema: true, ctx: 8192, unknown: true };

// Ceilings. A multiplier is a scaling hint, not a licence to spend the whole
// context on one classification, and no single call may outlast a user's
// patience. Both overridable, because this project's numbers are always
// arguable and none of them should need a code edit to argue with.
const MAX_TOKEN_CEILING = 4096;
const MAX_TIMEOUT_MS = 600000;

// ---------------------------------------------------------------------------
// Name heuristics — used only when the model is not in KNOWN and has not been
// calibrated. Deliberately crude: a rough right answer beats a confident wrong
// one, and calibrate.js exists to replace any of this with a measurement.
// ---------------------------------------------------------------------------
// Families that reason by default. Matched on the NAME, which is all we have
// before the first call. Being wrong here costs headroom, not correctness.
const REASONING_NAME_RE = /(?:^|[^a-z])(?:r1|qwq|thinking|reason(?:er|ing)?|cot|marco-o1|deepseek-r|openthinker|o[13]-)/i;

// Parameter count from the name (…:4b, -1.7b, /9b, 8x7b). Same shape server.js
// uses for its FLOP estimate; duplicated rather than imported because this file
// must stay loadable on its own for the tests and for calibrate.js.
function paramsOf(name) {
  const n = String(name || '').toLowerCase();
  const moe = n.match(/(\d+)x(\d+(?:\.\d+)?)b\b/);          // 8x7b — active params, not total
  if (moe) return Number(moe[2]);
  const m = n.match(/[:\-/_](\d+(?:\.\d+)?)\s*b\b/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Reasoning markers — EVERY family this system might meet, not just qwen's.
//
// server.js stripped `<think>` only. That was correct for the incumbent and
// silently wrong for anything else: the markers below all appear in models that
// run on Ollama today, and an unstripped one travels on as ordinary reply text.
// Ordered pairs so an unterminated opener can still be handled by the caller.
// ---------------------------------------------------------------------------
const REASONING_BLOCKS = [
  [/<think>/gi,                 /<\/think>/gi],
  [/<thinking>/gi,              /<\/thinking>/gi],
  [/<reasoning>/gi,             /<\/reasoning>/gi],
  [/<reflection>/gi,            /<\/reflection>/gi],
  [/<\|begin_of_thought\|>/gi,  /<\|end_of_thought\|>/gi],
  [/◁think▷/gi,                 /◁\/think▷/gi],
];
// Bare markers to sweep up after block removal — an UNTERMINATED opener leaves
// its tag behind, which is exactly how a raw marker reached a reply before.
const REASONING_TAGS = /<\/?(?:think|thinking|reasoning|reflection)>|<\|(?:begin|end)_of_thought\|>|◁\/?think▷/gi;

// gpt-oss / harmony channels are not a matched pair — the analysis channel runs
// until the final channel starts. Handled separately for that reason.
const HARMONY_RE = /<\|channel\|>analysis[\s\S]*?<\|channel\|>final[^\n]*/gi;
// The cheap linear question "is there anything for the sweep to match?", asked
// before the quadratic sweep runs. See stripReasoning.
const HARMONY_CLOSE_RE = /<\|channel\|>final/i;
const HARMONY_TAGS = /<\|(?:channel|message|start|end|return)\|>[a-z]*/gi;

// Strip whatever reasoning wrapper this model uses, WITHOUT destroying an answer
// that is only reasoning. Same rule server.js already applies for <think>: if
// removing the block leaves nothing, the block WAS the reply, so keep it and
// drop the markers instead. Generalised here to every family above.
// INTERNAL WHITESPACE IS PART OF THE ANSWER. An earlier draft of this collapsed
// /\s+/ to a single space, which strips a reasoning block correctly and quietly
// flattens every multi-line reply in the system to one line — lists, code, the
// research summaries. Blocks are removed with '' and the result is only
// trimmed, which is exactly what server.js did for <think> before this file.
// A REPLY THIS LARGE IS ALREADY PATHOLOGICAL. Past this we strip markers only and
// skip the block sweep entirely — see the complexity note below.
const SWEEP_CAP = 262144;

function stripReasoning(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  let out = raw;
  // THIS LOOP WAS QUADRATIC AND COULD FREEZE THE WHOLE PROCESS.
  //
  // `<opener>[\s\S]*?<closer>` is lazy, so for every opener with NO matching
  // closer the engine scans to end-of-string before failing and retrying from the
  // next position. With many unclosed openers that is O(n^2), and it is
  // synchronous: Node is single-threaded, so one bad reply blocks every other
  // chat turn, skill and automation on the server for the duration.
  //
  // Not a contrived adversary — a small quantized model looping on its own
  // reasoning token is a documented degenerate-decoding mode, and this system
  // runs exactly that class of model. Measured before the fix, on unclosed
  // openers: 28KB 44ms, 56KB 161ms, 112KB 653ms, 224KB 2700ms — four times the
  // cost for twice the input, and 24 seconds at 448KB.
  //
  // The fix is to ask, in linear time, whether a closer exists at all before
  // running the quadratic sweep for that family. No closer, no block to remove.
  if (raw.length <= SWEEP_CAP) {
    if (HARMONY_CLOSE_RE.test(out)) out = out.replace(HARMONY_RE, '');
    for (const [open, close] of REASONING_BLOCKS) {
      // Fresh non-global regex: a /g regex is stateful under .test() and would
      // skip every other check.
      if (!new RegExp(close.source, 'i').test(out)) continue;
      if (!new RegExp(open.source, 'i').test(out)) continue;
      out = out.replace(new RegExp(open.source + '[\\s\\S]*?' + close.source, 'gi'), '');
    }
  }
  // WHITESPACE, TWICE BURNED. The first draft collapsed /\s+/ and flattened every
  // multi-line reply. The second trimmed the whole string, which is correct until
  // the removed block sat at the FRONT — then the trim ate the real first line's
  // indentation and left a code block that renders as prose. So: drop the blank
  // lines the block left behind, keep the indentation of the first surviving
  // line, and trim the end.
  out = out.replace(/^[ \t]*(?:\r?\n)+/, '').replace(/\s+$/, '');
  // A single-line reply has no indentation to protect, so a leading trim is right.
  if (!/\n/.test(out)) out = out.replace(/^\s+/, '');
  // Nothing survived: the reply was its own reasoning. Keep the words, lose the tags.
  if (!out) out = raw;
  let cleaned = out.replace(REASONING_TAGS, '').replace(HARMONY_TAGS, '')
                   .replace(/^[ \t]*(?:\r?\n)+/, '').replace(/\s+$/, '');
  if (!/\n/.test(cleaned)) cleaned = cleaned.replace(/^\s+/, '');
  return cleaned;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
let calibrated = null;                                    // lazily read, cached
function loadCalibrated() {
  if (calibrated) return calibrated;
  try { calibrated = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (e) { calibrated = {}; }                          // absent is normal
  return calibrated;
}

// Longest key first so a specific entry beats a family prefix — "qwen3-vl" must
// win over "qwen3" regardless of what order the object literal happens to be in.
const KNOWN_KEYS = Object.keys(KNOWN).sort((a, b) => b.length - a.length);

// OLLAMA'S DEFAULT TAG. To Ollama "jarvis" and "jarvis:latest" are one model — a name with no tag means :latest. Settings →
// Calibrate saves under the name Ollama lists ("jarvis:latest") while chat replies ask for "jarvis" (JARVIS_CHAT_REPLY_MODEL),
// so an exact-key lookup missed and a kept measurement never reached the call it was for (found 2026-10-19). Only the
// default tag is folded: "jarvis:q4" is a different build and stays a different name.
function latestTwin(n) {
  if (n.endsWith(':latest')) return n.slice(0, -':latest'.length) || null;
  return n.slice(n.lastIndexOf('/') + 1).includes(':') ? null : n + ':latest';
}

function profileFor(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return Object.assign({ model: '', source: 'unknown' }, UNKNOWN);

  // A MEASUREMENT ALWAYS BEATS A GUESS. calibrate.js writes exact model names.
  // Keys beginning with `_` are reserved bookkeeping (`_reference` holds what the
  // baseline actually measured on this machine) and are never model profiles.
  const cal = loadCalibrated();
  if (n[0] !== '_') {
    const twin = latestTwin(n);
    const hit = cal[n] ? n : (twin && cal[twin] ? twin : null);
    if (hit) return Object.assign({ model: n, source: 'calibrated' }, UNKNOWN, cal[hit]);
  }

  for (const k of KNOWN_KEYS) {
    if (n.includes(k)) return Object.assign({ model: n, source: 'known' }, UNKNOWN, KNOWN[k]);
  }

  // Never met it. Start from the generous default and let the name adjust it.
  const p = Object.assign({ model: n, source: 'guessed' }, UNKNOWN);
  if (REASONING_NAME_RE.test(n)) {
    // A reasoning model spends output budget before it says anything. This is
    // the single biggest cause of "the model returned nothing" on a small
    // budget — finish_reason=length with an empty content field.
    p.reasoning = true;
    p.verbosity = Math.max(p.verbosity, 6.0);
  }
  const b = paramsOf(n);
  if (b) {
    p.params = b;
    // Bigger is slower on a memory-bound 8 GB machine, and the relationship is
    // closer to linear in weights than anything cleverer. Anchored on the
    // baseline's 3B rather than assumed absolute.
    //
    // ONLY FOR MODELS THAT RUN HERE. `speed` is documented as a property of the
    // pair (model, machine); applying a local memory-pressure heuristic to a
    // hosted model is a category error, and it produced speed 4.53 for a 7B on
    // OpenRouter — a number about this Mac's RAM, describing a call that never
    // touches it. A hosted model keeps the neutral default until measured.
    if (!HOSTED_RE.test(n)) {
      p.speed = Math.max(0.3, Number((p.speed * (b / 3.09)).toFixed(2)));
    } else {
      p.hosted = true;
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
// Turn a call site's baseline intent into this model's budget.
//
// `base` is what the incumbent needs. A verbose model gets proportionally more,
// and a reasoning model gets a floor on top, because a reasoning model with 30
// tokens produces thinking and no answer — the worst possible outcome, since it
// looks like a refusal.
function scaleTokens(profile, base) {
  const p = profile || UNKNOWN;
  const b = Number(base) || 0;
  if (!b) return b;                                        // caller passed nothing; leave it alone
  let out = b * (Number(p.verbosity) || 1);
  if (p.reasoning) out = Math.max(out, b + 256);
  // THE CEILING MUST NEVER DROP THE FLOOR. This was
  // `Math.min(CEILING, Math.max(b, out))` — the ceiling wrapped AROUND the
  // "never worse than the incumbent" guarantee, so whenever the caller asked for
  // more than the ceiling the ceiling silently won and the guarantee broke, for
  // the incumbent itself at verbosity 1.0: scaleTokens(incumbent, 5000) returned
  // 4096. No call site passes that today, which is what made it a landmine
  // rather than a bug — the next person to raise deepresearch's 1400-token
  // synthesis budget would have reintroduced, with no test failure, the exact
  // truncation this file exists to prevent. A ceiling below what was explicitly
  // asked for is not a ceiling, it is a cut.
  const ceiling = Math.max(MAX_TOKEN_CEILING, b);
  return Math.max(b, Math.min(ceiling, Math.round(out)));
}

// Same idea on the clock. A model 2x slower per token, asked for more tokens,
// needs more than 2x the wall time — so the two axes multiply rather than being
// applied one at a time.
function scaleTimeout(profile, base) {
  const p = profile || UNKNOWN;
  const b = Number(base) || 0;
  if (!b) return b;
  const tokenGrowth = Math.max(1, (Number(p.verbosity) || 1));
  const out = b * (Number(p.speed) || 1) * Math.min(tokenGrowth, 4);   // capped: verbosity hits the token ceiling anyway
  // Same inversion as scaleTokens, same fix: a deadline shorter than the one the
  // caller explicitly asked for is not a ceiling.
  const ceiling = Math.max(MAX_TIMEOUT_MS, b);
  return Math.max(b, Math.min(ceiling, Math.round(out)));
}

// OUTPUT AND PROMPT SHARE THE WINDOW.
//
// Scaling a budget up for a verbose model is right until the budget starts
// eating the context it has to read: a model with a 4096 window handed
// num_predict 4096 has nothing left for the system prompt, and Ollama silently
// truncates the oldest turns to make room — the same "doesn't understand
// context" failure that raising num_ctx was meant to fix. Half the window is
// the most any single answer may reserve.
//
// Lives here rather than at the call site so the rule is testable on its own.
function fitTokens(profile, base, ctx) {
  const want = scaleTokens(profile, base);
  const c = Number(ctx) || 0;
  if (!c) return want;
  return Math.min(want, Math.floor(c / 2));
}

// Context window to ask Ollama for. Never exceeds what the model supports, and
// never sits at Ollama's silent 2048 default.
function ctxFor(profile, requested) {
  const p = profile || UNKNOWN;
  const want = Number(requested) || 0;
  const cap = Number(p.ctx) || 8192;
  return want ? Math.min(want, cap) : Math.min(8192, cap);
}

// Can this model be held to a JSON schema? When false the caller has to ask for
// JSON in the prompt and parse loosely — parseJsonLoose already exists for that.
function supportsSchema(profile) { return (profile || UNKNOWN).schema !== false; }

module.exports = {
  profileFor, scaleTokens, scaleTimeout, fitTokens, ctxFor, supportsSchema, stripReasoning,
  paramsOf,
  // exported for tests and calibrate.js
  KNOWN, UNKNOWN, BASELINE, MAX_TOKEN_CEILING, MAX_TIMEOUT_MS,
  REASONING_BLOCKS, REASONING_TAGS,
  _setFile: f => { FILE = f; calibrated = null; },
  _file: () => FILE,
  _reload: () => { calibrated = null; },
};
