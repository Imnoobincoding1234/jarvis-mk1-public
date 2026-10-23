// Model-profile tests — pure, no network, no server boot, no Ollama.
// Deliberately does NOT require server.js: this module has to stand on its own
// so a candidate model can be profiled without starting the machine.
const M = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/modelprofile.js');
const os = require('os'), path = require('path'), fs = require('fs');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + g + '\n         want ' + w); }
}
function ok(label, cond) { eq(label, !!cond, true); }

// Own fixture file, never his real one — a test that reads live state fails for
// reasons that have nothing to do with the test.
const TMP = path.join(os.tmpdir(), 'jarvis-modelprofile-test-' + process.pid + '.json');
M._setFile(TMP);

console.log('\n— THE SAFETY PROPERTY: the incumbent is unchanged, to the token —');
// Every max_tokens and timeoutMs that appears at an llm() call site in server.js
// today. If any of these move, the current model's behaviour has changed and
// this refactor has broken something it promised not to touch.
const BASE_TOKENS = [1, 30, 60, 90, 250, 300, 350, 400, 420, 500, 700, 900];
const BASE_TIMEOUTS = [20000, 25000, 30000, 45000, 60000, 90000, 120000, 180000];
const inc = M.profileFor('qwen2.5:3b-instruct-q4_K_M');
eq('the incumbent resolves to a KNOWN profile', inc.source, 'known');
eq('  …and is the baseline on both axes', [inc.verbosity, inc.speed], [1.0, 1.0]);
for (const b of BASE_TOKENS) eq('max_tokens ' + b + ' is untouched', M.scaleTokens(inc, b), b);
for (const b of BASE_TIMEOUTS) eq('timeoutMs ' + b + ' is untouched', M.scaleTimeout(inc, b), b);

console.log('\n— no model is ever budgeted WORSE than the incumbent —');
// The whole point is to stop under-budgeting. A profile that returned less than
// the baseline would reintroduce the bug in a new place, so it is forbidden
// outright rather than merely unlikely.
for (const name of ['qwen2.5:3b', 'granite-3.1-3b-a800m', 'qwen3-vl:2b', 'deepseek-r1:7b',
                    'something-nobody-has-ever-heard-of', 'llama3.2:1b', 'phi4-mini:3.8b']) {
  const p = M.profileFor(name);
  let worse = null;
  for (const b of BASE_TOKENS) if (M.scaleTokens(p, b) < b) worse = 'tokens@' + b;
  for (const b of BASE_TIMEOUTS) if (M.scaleTimeout(p, b) < b) worse = worse || 'timeout@' + b;
  eq('never under-budgets: ' + name, worse, null);
}

console.log('\n— the case that motivated the file: a verbose model —');
// granite answered in 729 chars where the incumbent used 31. On a 30-token
// budget that is a truncated sentence scored as a wrong answer.
const gran = M.profileFor('granite-3.1-3b-a800m');
eq('granite is known to be verbose', gran.verbosity, 23.0);
ok('a 30-token classification gets real room', M.scaleTokens(gran, 30) >= 400);
ok('  …and is still capped, not unbounded', M.scaleTokens(gran, 900) <= M.MAX_TOKEN_CEILING);
// It was FASTER per token. Verbosity and speed are independent axes and the
// profile must not conflate them.
ok('granite is recorded as faster per token', gran.speed < 1.0);
ok('  …but its timeout still grows, because it emits far more', M.scaleTimeout(gran, 20000) > 20000);

console.log('\n— a reasoning model gets headroom before it says anything —');
// A reasoning model handed 30 tokens produces thinking and no answer:
// finish_reason=length with empty content, which reads as a refusal.
const r1 = M.profileFor('deepseek-r1:7b');
ok('recognised as reasoning from the name', r1.reasoning);
ok('  …and gets at least a floor above the base', M.scaleTokens(r1, 30) >= 30 + 256);
const qwq = M.profileFor('qwq:32b');
ok('qwq too', qwq.reasoning);
const plain = M.profileFor('llama3.2:3b');
eq('a plain model is not marked reasoning', plain.reasoning, false);

console.log('\n— an unknown model is treated generously, not cautiously —');
const unk = M.profileFor('brand-new-model:4b');
eq('marked as a guess, not a measurement', unk.source, 'guessed');
ok('gets more output room than the incumbent', M.scaleTokens(unk, 60) > 60);
ok('gets more clock than the incumbent', M.scaleTimeout(unk, 20000) > 20000);
eq('and its size is read off the name', unk.params, 4);
// Bigger is slower on a memory-bound machine; the profile should say so.
ok('a 7B is profiled slower than a 1B', M.profileFor('mystery:7b').speed > M.profileFor('mystery:1b').speed);

console.log('\n— specific profiles beat family prefixes —');
// "qwen3-vl" and "qwen3" both match the string "qwen3-vl:2b". The longer key
// has to win or the vision model is profiled as a plain text model.
eq('qwen3-vl:2b is the VLM, not the family default', M.profileFor('qwen3-vl:2b').vision, true);
ok('qwen3:4b takes the family profile', M.profileFor('qwen3:4b').vision !== true);

console.log('\n— a measurement always beats a guess —');
fs.writeFileSync(TMP, JSON.stringify({ 'granite-3.1-3b-a800m': { verbosity: 4.0, speed: 1.1 } }));
M._reload();
const cal = M.profileFor('granite-3.1-3b-a800m');
eq('calibrated profile is used', cal.source, 'calibrated');
eq('  …and overrides the built-in guess', cal.verbosity, 4.0);
// calibrate.js stores what the BASELINE measured under a reserved `_reference`
// key. It is bookkeeping, not a model, and must never be served as a profile —
// otherwise a lookup for a model literally named that would inherit it.
fs.writeFileSync(TMP, JSON.stringify({
  _reference: { outTokMean: 12, msPerTok: 85 },
  'somemodel:1b': { verbosity: 3.0 },
}));
M._reload();
eq('a reserved key is not a model profile', M.profileFor('_reference').source, 'guessed');
eq('  …while a real entry beside it still resolves', M.profileFor('somemodel:1b').source, 'calibrated');
// Ollama's default tag (2026-10-19): Settings kept "jarvis:latest", chat replies ask for "jarvis" — the measurement
// never reached the reply. A bare name and its :latest are one model; any other tag is a different build.
fs.writeFileSync(TMP, JSON.stringify({
  'jarvis:latest': { verbosity: 0.75, speed: 0.28 },
  'phi4-mini': { verbosity: 1.39 },
  'hf.co/prism-ml/bonsai-8b-gguf:q1_0': { verbosity: 15.26 },
  'twin': { verbosity: 2.0 }, 'twin:latest': { verbosity: 3.0 },
}));
M._reload();
eq('a bare name finds its :latest measurement', [M.profileFor('jarvis').source, M.profileFor('jarvis').verbosity], ['calibrated', 0.75]);
eq('  …and :latest finds the bare one', M.profileFor('phi4-mini:latest').verbosity, 1.39);
eq('  …the exact name still resolves', M.profileFor('jarvis:latest').verbosity, 0.75);
eq('  …a namespaced, tagged name is untouched', M.profileFor('hf.co/prism-ml/Bonsai-8B-gguf:Q1_0').verbosity, 15.26);
ok('  …another tag is another build', M.profileFor('jarvis:q4').source !== 'calibrated');
ok('  …the same repo without its tag is not that build', M.profileFor('hf.co/prism-ml/bonsai-8b-gguf').source !== 'calibrated');
ok('  …no prefix bleed', M.profileFor('jarvis-reader').source !== 'calibrated');
eq('  …an exact entry wins over its twin', [M.profileFor('twin').verbosity, M.profileFor('twin:latest').verbosity], [2.0, 3.0]);
ok('  …a bare ":latest" is not a model', M.profileFor(':latest').source !== 'calibrated');
fs.unlinkSync(TMP); M._reload();
eq('and a missing profile file is normal, not an error', M.profileFor('granite-3.1-3b-a800m').source, 'known');

console.log('\n— reasoning markers: every family, not just qwen —');
// server.js stripped <think> only. Each of these appears in a model that runs
// on Ollama today, and an unstripped one travels on as ordinary reply text —
// which is documented in server.js as having tripped the action guard.
eq('qwen <think>', M.stripReasoning('<think>hmm, Paris</think>The capital is Paris.'), 'The capital is Paris.');
eq('<thinking>', M.stripReasoning('<thinking>x</thinking>Answer: 4'), 'Answer: 4');
eq('<reasoning>', M.stripReasoning('<reasoning>y</reasoning>Done, Sir.'), 'Done, Sir.');
eq('<reflection>', M.stripReasoning('<reflection>z</reflection>Ready.'), 'Ready.');
eq('begin/end_of_thought', M.stripReasoning('<|begin_of_thought|>q<|end_of_thought|>Yes.'), 'Yes.');
eq('kimi ◁think▷', M.stripReasoning('◁think▷w◁/think▷No.'), 'No.');
eq('harmony channels', M.stripReasoning('<|channel|>analysis deliberating<|channel|>final\nParis.'), 'Paris.');
eq('an unterminated opener leaves no marker behind', M.stripReasoning('<think>still going, Paris'), 'still going, Paris');
eq('plain text is untouched', M.stripReasoning('The capital is Paris.'), 'The capital is Paris.');
eq('empty stays empty', M.stripReasoning(''), '');
eq('null does not throw', M.stripReasoning(null), '');
// THE RULE server.js ALREADY APPLIES: if stripping leaves nothing, the reply WAS
// the reasoning — keep the words and drop only the markers. Returning empty here
// is how a correct answer became "I could not carry that out, Sir".
eq('a reply that is ONLY reasoning keeps its words', M.stripReasoning('<think>Paris is the capital.</think>'), 'Paris is the capital.');

// INTERNAL WHITESPACE IS PART OF THE ANSWER. The first draft of stripReasoning
// collapsed /\s+/ to a single space. That strips a think-block correctly and
// silently flattens every multi-line reply in the system — lists, code blocks,
// the research summaries with their source lines. Caught before wiring it in;
// asserted here so it cannot come back.
eq('newlines inside a reply survive',
  M.stripReasoning('<think>x</think>Line one.\nLine two.\n\nLine four.'),
  'Line one.\nLine two.\n\nLine four.');
eq('a code block keeps its shape',
  M.stripReasoning('Here:\n\n    const a = 1;\n    const b = 2;\n'),
  'Here:\n\n    const a = 1;\n    const b = 2;');
eq('indentation is not squeezed',
  M.stripReasoning('- one\n  - nested\n- two'),
  '- one\n  - nested\n- two');

console.log('\n— an answer may never crowd out the prompt —');
// num_predict and the prompt share num_ctx. A verbose model scaled up against a
// small window would reserve the whole thing and Ollama would silently truncate
// the oldest turns to fit — the exact "doesn't understand context" failure that
// raising num_ctx was introduced to fix.
eq('the incumbent at 8192 is untouched by the clamp', M.fitTokens(inc, 900, 8192), 900);
eq('  …and so is every other live budget', BASE_TOKENS.map(b => M.fitTokens(inc, b, 8192)), BASE_TOKENS);
ok('a verbose model is capped by a small window', M.fitTokens(gran, 900, 4096) <= 2048);
eq('exactly half the window is the ceiling', M.fitTokens(gran, 900, 4096), 2048);
ok('with no ctx given, the clamp does not invent one', M.fitTokens(gran, 30, 0) === M.scaleTokens(gran, 30));

console.log('\n— the sweep must not be quadratic: one bad reply blocks the whole server —');
// Node is single-threaded and stripReasoning is synchronous, so a reply that takes
// seconds to clean freezes every other chat turn, skill and automation for that
// long. A small quantized model looping on its own reasoning token is a documented
// degenerate-decoding mode, and this project runs exactly that class of model.
// Measured before the fix: 28KB 44ms, 56KB 161ms, 112KB 653ms, 224KB 2700ms —
// four times the cost for twice the input.
{
  const t0 = Date.now();
  M.stripReasoning('<think>'.repeat(64000) + 'trailing text');   // ~448KB, no closers
  const ms = Date.now() - t0;
  ok('448KB of unclosed openers stays fast (' + ms + 'ms)', ms < 1000);
}
{
  // Growth must be roughly linear, not quadratic. Compare the two sizes that
  // showed a 4x jump before the fix.
  const run = n => { const s = '<think>'.repeat(n) + 'x'; const t = Date.now(); M.stripReasoning(s); return Date.now() - t; };
  run(2000);                                    // warm up, ignore
  const small = run(16000), big = run(32000);
  ok('doubling the input does not quadruple the cost (' + small + 'ms -> ' + big + 'ms)', big <= Math.max(60, small * 3));
}
ok('a well-formed block is still removed after the fast-path check',
  M.stripReasoning('<think>hmm</think>Paris.') === 'Paris.');
ok('an unclosed opener still loses its marker', M.stripReasoning('<think>still going, Paris') === 'still going, Paris');

console.log('\n— a ceiling must never drop below what was explicitly asked for —');
// This was Math.min(CEILING, Math.max(b, out)) — the ceiling wrapped AROUND the
// "never worse than the incumbent" floor, so asking for more than the ceiling
// silently got less, for the incumbent itself at verbosity 1.0.
eq('scaleTokens(incumbent, 5000) honours the request', M.scaleTokens(inc, 5000), 5000);
eq('scaleTimeout(incumbent, 700000) honours the request', M.scaleTimeout(inc, 700000), 700000);
ok('and an oversized base is never reduced for ANY model',
  ['granite-3.1-3b-a800m', 'deepseek-r1:7b', 'nobody-has-heard-of-this:4b']
    .every(n => M.scaleTokens(M.profileFor(n), 9000) >= 9000));
eq('the ordinary ceiling still applies below it', M.scaleTokens(M.profileFor('granite-3.1-3b-a800m'), 900), M.MAX_TOKEN_CEILING);

console.log('\n— a leading block must not eat the first line’s indentation —');
// Removing a block at the very FRONT and then trimming the whole string took the
// real content's leading whitespace with it, leaving a code block that renders as
// prose. Line 0 lost its indent while every other line kept it.
eq('code keeps its indent when the block came first',
  M.stripReasoning('<think>x</think>\n\n    const a = 1;\n    const b = 2;'),
  '    const a = 1;\n    const b = 2;');
eq('a nested list keeps item 0’s indent',
  M.stripReasoning('<think>x</think>\n  - one\n  - two'),
  '  - one\n  - two');
eq('a single-line reply is still tidied', M.stripReasoning('<think>x</think>   Answer: 4'), 'Answer: 4');
eq('and the earlier shape still holds', M.stripReasoning('Here:\n\n    const a = 1;\n'), 'Here:\n\n    const a = 1;');

console.log('\n— the hosted model is a real model too —');
// chatModel() falls back to this for every tier:'hard' call. It was 'guessed',
// which is not what "verified against the real .env model string" covered.
const host = M.profileFor('qwen/qwen-2.5-7b-instruct');
eq('the hosted default is known, not guessed', host.source, 'known');
ok('  …and is marked hosted', host.hosted === true);
// speed is documented as a property of the pair (model, machine). A local
// memory-pressure heuristic applied to someone else's server is a category error.
const hostedGuess = M.profileFor('some-vendor/mystery-model-70b');
eq('a hosted slug does not get the local speed heuristic', hostedGuess.speed, M.UNKNOWN.speed);
ok('  …while a local model of the same size does', M.profileFor('mystery-model:70b').speed > M.UNKNOWN.speed);

console.log('\n— context window —');
eq('never Ollama’s silent 2048 default', M.ctxFor(inc, 0) >= 8192, true);
eq('never exceeds what the model supports', M.ctxFor(M.profileFor('granite-3.1-3b-a800m'), 32768), 8192);
eq('honours a smaller explicit request', M.ctxFor(inc, 4096), 4096);

console.log('\n— schema capability —');
eq('the incumbent can be held to a schema', M.supportsSchema(inc), true);
eq('an embedding model cannot', M.supportsSchema(M.profileFor('all-minilm')), false);

console.log('\n— params from a name —');
eq('qwen2.5:3b', M.paramsOf('qwen2.5:3b-instruct-q4_K_M'), 3);
eq('1.7b', M.paramsOf('smol:1.7b'), 1.7);
eq('MoE reports ACTIVE params', M.paramsOf('mixtral:8x7b'), 7);
eq('no size in the name', M.paramsOf('some-model'), null);
eq('null name', M.paramsOf(null), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
