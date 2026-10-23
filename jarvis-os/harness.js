'use strict';
// ---------------------------------------------------------------------------
// JARVIS agent harness — the run state, budgets, failure policy and verification rules that turn
// a step loop into an agent.
//
// WHAT WAS MISSING. agent.js already decided one step at a time, guarded against drift and repeats,
// gated side effects behind confirmation and refused invented recipients. What it did NOT do is the
// part that makes an agent trustworthy:
//
//   · It reported success from the TOOL'S return code. "Done, Sir" meant "the function returned
//     ok:true", not "the thing you asked for is true of the world". Those differ constantly —
//     add_calendar_event succeeds against the wrong calendar, open_app succeeds on the wrong app.
//   · A failed step was recorded and then essentially ignored. Nothing fed the error back as
//     something to steer around, so the model either repeated itself into the repeat-guard or
//     wandered.
//   · A permission denial and a transient miss were treated identically, so a refusal that will
//     NEVER succeed got retried until the step budget ran out.
//   · The only budget was a step count. A single hung tool call could hold a run open indefinitely.
//
// WHY A SEPARATE MODULE. Everything here is pure — no I/O, no tool calls, no clock beyond what is
// passed in. That is what makes it testable: the interesting logic in an agent is its POLICY
// (when to retry, when to give up, what counts as done), and policy embedded in a stateful loop
// that needs a live Mac to run is policy nobody can test. agent.js keeps the loop and the tools;
// this decides what the loop should do.
//
// MODEL-AGNOSTIC BY CONSTRUCTION. Mihir runs a local 3B today with no API key. Every decision here
// is deterministic code rather than a judgement call handed to the model, so the harness behaves
// identically on a 3B and on a frontier model — the model only picks the next tool. The one place
// a model COULD be used (judging whether a goal was met) deliberately is not, because a 3B
// rubber-stamping its own work is worse than admitting the result is unverified.
// ---------------------------------------------------------------------------

const MIN = 60000;

// ---------------- run state ----------------

const DEFAULTS = {
  maxSteps: 10,
  maxRetries: 3,           // adaptive retries across the whole run, not per step
  budgetMs: 4 * MIN,       // wall clock; a hung tool must not hold the run open forever
  obsClip: 110,            // per-observation text budget in the planner transcript
  transcriptMax: 12,       // most recent observations kept in full
};

function newRun(goal, opts) {
  // Undefined keys are stripped before merging. Object.assign happily copies an explicit
  // `undefined` over a default, so a caller passing `{maxRetries: opts.maxRetries}` for an option
  // the caller did not set wiped the default and logged "retry 1/undefined".
  const given = {};
  for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) given[k] = v;
  const o = Object.assign({}, DEFAULTS, given);
  // `!= null`, not `||`: a caller passing now:0 (a test clock starting at zero) is passing a real
  // timestamp, and `0 || Date.now()` silently swapped in the wall clock and made the budget untestable.
  const now = o.now != null ? o.now : Date.now();
  return {
    goal: String(goal || ''),
    // How many side-effecting actions the request actually calls for. Read once from the goal and
    // then used both as the repetition allowance and as the yardstick for whether a run that
    // stopped early got far enough to be called finished.
    parts: o.parts != null ? o.parts : expectedParts(goal),
    startedAt: now,
    deadline: now + o.budgetMs,
    limits: { maxSteps: o.maxSteps, maxRetries: o.maxRetries, budgetMs: o.budgetMs },
    obsClip: o.obsClip,
    transcriptMax: o.transcriptMax,
    steps: [],               // the decisions taken
    results: [],             // aligned with steps
    observations: [],        // {i, tool, args, ok, text, kind}
    retries: 0,
    verified: null,          // set by the verification pass
    status: 'running',       // running | done | failed | stopped | paused
  };
}

// Joins two sentences without mangling either. An earlier version lower-cased the second clause so
// it would read mid-sentence, which duly turned "Spotify is not running" into "spotify is not
// running" — proper nouns are not something a heuristic gets to guess at. Punctuate instead.
const join = (a, b) => {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!b) return a;
  if (!a) return b;
  // Allows a closing bracket or quote after the stop, so "(1 step failed.)" is not given a second
  // full stop and rendered "(1 step failed.). "
  if (!/[.!?…][)\]"'’”]?$/.test(a)) a += '.';
  return a + ' ' + b;
};

const clip = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// One observation per executed step. Deliberately records the ARGS as well as the outcome: without
// them a transcript line reads "open_app → FAILED" and the model has no idea which app it just
// failed to open, so its next guess is uninformed.
// Paths and URLs are IDENTIFIERS: the model reuses them verbatim in later steps, so a truncated one
// is not a shortened display, it is a corrupt value. Observed live — a path clipped to
// ".../harness_demo/note…" was copied back as an argument and produced a file on disk literally
// named "note…". Identifiers therefore get a generous budget and, if they still have to be cut,
// a marker no one could mistake for part of a filename.
const IDENTIFIERISH = /[/\\]|^https?:|^~|\.\w{1,5}$/i;
function argValue(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (IDENTIFIERISH.test(s)) return s.length > 160 ? s.slice(0, 160) + ' [TRUNCATED — do not reuse]' : s;
  return clip(s, 40);
}

// A LISTING is the one observation whose whole point is its detail. An element list is not a
// description of what happened — it is the menu the very next decision is chosen from, and clipping
// it to the ordinary budget truncated a page's elements to about the first four, which on a real
// site are all navigation furniture. The model was picking a video from a list that contained no
// videos.
const LISTING_CLIP = 900;

function record(run, step, result, kind) {
  const i = run.steps.length - 1;
  const args = Object.entries(step.args || {})
    .map(([k, v]) => k + '=' + argValue(v)).join(' ');
  const listing = !!(result && result.listing);
  const obs = {
    i, tool: step.tool, args,
    ok: !!(result && result.ok),
    text: clip((result && result.say) || '', listing ? LISTING_CLIP : run.obsClip),
    kind: kind || (result && result.ok ? 'ok' : 'fail'),
    listing,
  };
  // A SUPERSEDED listing is dropped. Looking at a page twice — or widening the shortlist because
  // the first batch had nothing useful — otherwise leaves two long lists in the transcript, and the
  // stale one competes with the live one for a small model's attention while pushing the goal
  // itself towards the edge of the context. Only the newest list survives; the fact that an earlier
  // look happened is still visible in the step line above it.
  if (listing) {
    for (const o of run.observations) {
      if (o.listing) { o.text = '(earlier list of elements — superseded by the one below)'; o.listing = false; }
    }
  }
  run.observations.push(obs);
  return obs;
}

// What the planner sees. Older observations collapse to one line each so a long run does not push
// the goal itself out of a small model's context — the recent ones are what the next decision
// actually turns on.
function transcript(run) {
  const obs = run.observations;
  const keep = run.transcriptMax;
  const out = [];
  if (obs.length > keep) {
    const older = obs.slice(0, obs.length - keep);
    const okN = older.filter(o => o.ok).length;
    out.push('(' + older.length + ' earlier steps: ' + okN + ' ok, ' + (older.length - okN) + ' failed)');
  }
  for (const o of obs.slice(-keep)) {
    out.push((o.i + 1) + '. ' + o.tool + (o.args ? ' ' + o.args : '') +
      ' → ' + (o.ok ? 'ok' : 'FAILED') + (o.text ? ': ' + o.text : ''));
  }
  return out;
}

// ---------------- failure policy ----------------

// A failure that will never succeed on retry, no matter how the arguments are shuffled. Retrying
// these is not persistence, it is burning the step budget on a foregone conclusion — and for the
// refusals in particular, retrying a safety stop is exactly the behaviour that must not exist.
const TERMINAL_RE = new RegExp([
  'not authoris(?:ed|ed)', 'not authorized', 'permission', 'denied', 'no such tool',
  'refus', 'cannot handle', 'unsupported', 'not allowed', 'blocked',
  'accessibility', 'full disk access', 'needs? approval',
  'invented', 'not from your contacts', 'sensitive', 'password', 'card number',
  'no api key', 'not configured', 'requires? a key',
].join('|'), 'i');

// NOTE ON WHAT IS *NOT* TERMINAL. "Not sure which app you mean by Spotify" was briefly listed above,
// on the reasoning that an app which is not installed will not install itself on a retry. That was
// right about the tool and wrong about the RUN: a terminal failure on a side-effecting tool ends the
// run immediately, so the loop stopped dead at step one and never reached the browser fallback its
// own procedure defines. It is left retryable so the alternative gets a turn — and it is still
// learned regardless, because learning now keys off a failed RUN rather than off this classification.

// Worth another attempt with different arguments: the target was not found, the name was wrong,
// something timed out. These are the cases where the model genuinely can do better on a second go.
const RETRYABLE_RE = new RegExp([
  'not found', 'no match', 'could not find', 'does not exist', 'no results',
  'timed? out', 'timeout', 'try again', 'unavailable', 'not running', 'not open',
  'failed to open', 'unknown app', 'no window',
].join('|'), 'i');

function classify(result) {
  if (result && result.ok) return 'ok';
  // A TOOL THAT ASKED HIM A QUESTION did not fail — it needs his answer, and no retry can give it (2026-10-22: the composer's
  // "What should the message to Ira say?" matched neither list below, counted as retryable, and the loop retried it four
  // times before "ran out of retries"). Read from the tool's own flag (data.asked), never from its words.
  if (result && result.data && result.data.asked) return 'asked';
  const say = String((result && result.say) || '');
  if (TERMINAL_RE.test(say)) return 'terminal';
  if (RETRYABLE_RE.test(say)) return 'retryable';
  // Unknown failures are treated as retryable ONCE — the retry budget bounds how much that can
  // cost, and refusing to retry anything unrecognised would make the harness give up on the
  // ordinary case of a tool failing for a reason nobody wrote a pattern for.
  return 'retryable';
}

// The line handed back to the planner after a failure. Without this the model sees only "FAILED"
// and its most likely next move is the identical call again, which the repeat guard then kills —
// turning a recoverable miss into a dead run.
function recoveryHint(step, result, kind) {
  const why = clip((result && result.say) || 'no reason given', 120);
  if (kind === 'terminal') {
    return 'Step ' + step.tool + ' cannot succeed: ' + why +
      ' Do NOT try it again. Either reach the goal another way, or reply {"tool":"fail"} explaining this.';
  }
  return 'Step ' + step.tool + ' failed: ' + why +
    ' Do NOT repeat it unchanged — change the arguments, use a different tool, or reply {"tool":"fail"}.';
}

// ---------------- progress vs drift ----------------

// HOW MANY SIDE-EFFECTING ACTIONS THE GOAL ACTUALLY ASKS FOR.
//
// This exists because the drift guard could not tell "wrote the same file three times under three
// slightly different names" (real drift, observed live) from "created a.txt, b.txt and c.txt"
// (the goal, done correctly). Both look identical from inside one step: same tool twice in a row,
// similar-looking targets. The thing that distinguishes them is not in the steps at all — it is in
// the REQUEST. So the allowance for repeating a tool is read off the goal, once, up front.
//
// Deterministic on purpose. Asking the 3B "how many parts does this have?" is exactly the kind of
// counting it gets wrong, and a wrong answer here either strangles a real goal or unleashes the
// wandering the guard exists to stop.
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const PARTS_CAP = 30;   // nothing gets an unbounded allowance, however the goal is phrased

function expectedParts(goal) {
  const g = String(goal || '').toLowerCase().trim();
  if (!g) return 1;
  let n = 1;

  // An explicit count: "nine files", "15 notes", "three folders".
  const num = g.match(/\b(\d{1,3})\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/);
  if (num) {
    const v = num[1] ? parseInt(num[1], 10) : NUMBER_WORDS[num[2]];
    // Years, times and version numbers are not counts of anything. A goal mentioning 2026 does not
    // license thirty consecutive writes.
    if (v > 1 && v <= 100) n = Math.max(n, v);
  }

  // An enumerated list: "a.txt, b.txt and c.txt". Counted from the separators rather than the
  // nouns, because the nouns are the part a regex has no business trying to parse.
  const seps = (g.match(/,|\band\b|\bthen\b|;/g) || []).length;
  if (seps) n = Math.max(n, seps + 1);

  // "each"/"every"/"all" implies more than one even when no number is given at all.
  if (/\b(each|every|all)\b/.test(g)) n = Math.max(n, 3);

  return Math.min(n, PARTS_CAP);
}

// Was the part count STATED, or merely inferred from punctuation? The difference decides whether a
// shortfall is worth reporting. "create nine files" states nine things and finishing three is a
// real shortfall. "open Spotify, search for X and play it" scores three from its separators but
// describes one job that one tool does in one step — counting steps against it would cry wolf on
// the single most common shape of request there is.
function partsAreCounted(goal) {
  const g = String(goal || '').toLowerCase();
  const num = g.match(/\b(\d{1,3})\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/);
  if (!num) return false;
  const v = num[1] ? parseInt(num[1], 10) : NUMBER_WORDS[num[2]];
  return v > 1 && v <= 100;
}

// WHAT THE GOAL NAMED, not how many things it counted.
//
// expectedParts() answers "how many", and counting is not enough — it was the whole defect. Measured
// on "create three files in jarvis_eval on my desktop: a.txt saying alpha, b.txt saying beta, c.txt
// saying gamma": the loop created the FOLDER, then a.txt, then c.txt, and stoppedShort() counted
// three successful side-effecting calls against run.parts of 3 and declared the job complete. b.txt
// — the middle item — never existed, and the reply said "I checked all 4 of them". A count can
// always be satisfied by the wrong three things; only names can tell you which one is missing.
//
// So: the artifacts the sentence names explicitly, checked off individually. Filename-shaped tokens
// only, because those are the ones that can be matched against a step's target without guessing.
// A goal naming fewer than two is left to the existing count-based guards — one filename is not a
// list, and "read notes.txt" must not be second-guessed.
function namedArtifacts(goal) {
  const out = [];
  const re = /\b([A-Za-z0-9_][A-Za-z0-9_.\-]*\.[A-Za-z0-9]{1,6})\b/g;
  let m;
  while ((m = re.exec(String(goal || '')))) {
    const n = m[1].toLowerCase();
    if (/^\d+(?:\.\d+)?$/.test(n)) continue;          // "3.5" is a number, not a file
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// Which of those names never became the target of a step that SUCCEEDED. Success matters: a
// create_file that errored is not a created file, and counting the attempt is how "done" got
// claimed over a missing item in the first place.
function missingArtifacts(goal, steps, results) {
  const want = namedArtifacts(goal);
  if (want.length < 2) return [];
  const hit = new Set();
  for (let i = 0; i < (steps || []).length; i++) {
    const r = (results || [])[i];
    if (!r || !r.ok) continue;
    const t = String(targetOf(steps[i] && steps[i].args) || '').toLowerCase();
    if (!t) continue;
    for (const w of want) if (t.includes(w)) hit.add(w);
  }
  return want.filter(w => !hit.has(w));
}

// The value a step is acting ON. Ordered by how identifying each key is: a path names exactly one
// thing, `text` could be anything. First match wins.
const TARGET_KEYS = ['path', 'url', 'target', 'to', 'name', 'app', 'title', 'query', 'text', 'content', 'message', 'body'];
function targetOf(args) {
  args = args || {};
  for (const k of TARGET_KEYS) {
    if (args[k] != null && String(args[k]).trim()) return String(args[k]).trim();
  }
  return '';
}
const normTarget = s => String(s || '').toLowerCase().replace(/^~\//, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Text that is not really text: the '§' and 'Ctrl+A' the local model emitted AFTER typing the
// requested paragraph. Judged on the payload rather than the tool, because the same junk arrives
// through type_text, append and create_file alike.
function junkPayload(cur, prev) {
  const c = String(cur || '');
  if (!c.trim()) return true;                                  // nothing to say, said anyway
  const letters = (c.match(/[a-z0-9]/gi) || []).length;
  if (c.length <= 3 && letters < c.length) return true;         // '§', '⌘', '..'
  // A substantial payload followed by a scrap is the signature of the model tidying up after itself.
  if (String(prev || '').length >= 40 && c.length <= 8 && letters <= 4) return true;
  return false;
}

// THE DECISION. Given a step about to run and the one before it, is this the goal progressing or
// the model wandering? Returns 'ok' or 'drift'.
//
// Note what is NOT here: any notion of "this tool feels unrelated to the goal". That judgement
// needs a model, a model would get it wrong, and the confirm gate already catches the case that
// matters (close_app arriving out of nowhere on a file goal).
function consecutiveKind(step, prevStep, run, sameToolStreak) {
  const curT = targetOf(step && step.args);
  const prevT = targetOf(prevStep && prevStep.args);

  // Same tool, same target: rewriting the identical thing is never progress, whatever the goal
  // asked for. This is the case the old guard was really built for.
  if (curT && prevT && normTarget(curT) === normTarget(prevT)) return 'drift';

  // A scrap of a payload after a real one is drift regardless of the allowance.
  if (junkPayload(curT, prevT)) return 'drift';

  // Otherwise the goal decides how much repetition is legitimate. A single-part goal gets an
  // allowance of 1, which is byte-for-byte the old behaviour — so nothing that used to be caught
  // stops being caught. A nine-part goal gets nine.
  const allowance = Math.max(1, run && run.parts ? run.parts : 1);
  return sameToolStreak <= allowance ? 'ok' : 'drift';
}

// ---------------- lessons: what went wrong the LAST time he asked this ----------------

// WHAT WAS MISSING. recoveryHint() steers the model around a failure it just hit — but only until
// the run ends. Ask the same thing tomorrow and the agent walks into the identical wall, because
// nothing survived the run. Every failure was paid for twice, and the third time, and the fourth.
//
// So a failure that a retry could not fix is written down against the goal that produced it, and
// handed back as a NOTE the next time a similar goal comes round. That is the whole mechanism: no
// model judges it, nothing is inferred, it simply remembers what did not work and says so up front.
//
// Matched on shared significant words. Crude, and deliberately so — the alternative is an embedding
// model in a file that is meant to stay pure, and the failure mode of crude matching is a lesson
// that does not fire, which costs nothing beyond the status quo.
const STOP_WORDS = new Set(('a an the and or but if then to for of in on at by with from into my me my mine ' +
  'i you he she it we they this that these those is are was were be been being do does did doing done ' +
  'can could would should will shall may might must please jarvis sir now just some any all').split(/\s+/));

function goalTerms(goal) {
  const out = new Set();
  for (const w of String(goal || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !STOP_WORDS.has(w)) out.add(w);
  }
  return out;
}

// Jaccard overlap of significant words. Symmetric, bounded, and needs no corpus — which matters
// because this has to give a sane answer on the very first lesson ever stored.
function lessonScore(goal, lesson) {
  const a = goalTerms(goal);
  const b = goalTerms(lesson && lesson.goal);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

const LESSON_FLOOR = 0.34;   // below this the goals are simply different requests

// A SAFETY stop must never become a lesson. Lessons are phrased as "that does not work, try another
// way" — which is right for a missing key or a wrong app name, and precisely wrong for a refusal:
// it would teach the agent to route AROUND its own guardrails, and it would get better at it every
// time he asked. Capability failures are worth remembering; the refusals are not, and the whole
// point of them is that they fire again next time.
const SAFETY_RE = new RegExp([
  'refus', 'sensitive', 'password', 'card number', 'credential',
  'invented', 'not from your contacts', 'stopped short', 'would have messaged',
  'not allowed', 'i will not', 'i won.t',
].join('|'), 'i');

// A PRECONDITION COMPLAINT IS NOT A LESSON EITHER.
//
// Measured, and it cost a whole eval category. browser_fill answered "I have not listed this page
// yet, Sir - let me look at it first", which is a tool asking for a step it needs FIRST, not a tool
// that cannot do the job. It was stored anyway, and lessonLines renders a stored reason verbatim,
// so the next run for "play bohemian rhapsody on spotify" opened with:
//
//   LEARNED: browser_fill on Play does not work here - I have not listed this page yet, Sir - let
//   me look at it first. Do not start with it; try another way.
//
// The playbook's step 1 was "browser_go to open.spotify.com/search/...". The 3B obeyed the lesson
// instead, called browser_elements first, and listed the page it had not navigated to - the leftover
// tab from the previous task. It never reached Spotify at all.
//
// The distinction that matters: the reason describes a MISSING PRECONDITION the run can satisfy on
// its own (list the page, name the field), so harness.recoveryHint() already steers it in-run and it
// is recoverable by definition. This file's own contract is that it stores what could NOT be
// recovered from. A "wrong app name" or "no such tool here" is a dead end worth remembering; "do
// that other thing first" is a sequencing note, and injecting one into the NEXT run turns it into an
// instruction that outranks the procedure.
//
// Kept deliberately narrow and anchored on the observed phrasings. "Not sure which app you mean by
// Spotify" stays learnable: that tool can never resolve that target, no matter what runs first.
const PRECONDITION_RE = new RegExp([
  'have not listed', 'not listed this page', 'let me look at it first',
  'give me a (?:field|number|step|line|row)', 'which form',
].join('|'), 'i');

function worthLearning(result) {
  const say = String((result && result.say) || '');
  if (!say.trim()) return false;
  return !SAFETY_RE.test(say) && !PRECONDITION_RE.test(say);
}

function pickLessons(goal, lessons, k) {
  k = k || 3;
  return (lessons || [])
    .map(l => ({ l, s: lessonScore(goal, l) }))
    .filter(x => x.s >= LESSON_FLOOR)
    // Best match first, and a lesson that has bitten repeatedly outranks a one-off at equal score.
    .sort((x, y) => (y.s - x.s) || ((y.l.hits || 1) - (x.l.hits || 1)))
    .slice(0, k)
    .map(x => x.l);
}

// Phrased as constraints on the NEXT attempt rather than as history. "Last time X failed" invites a
// small model to narrate the past; "do not use X, it fails with Y" changes what it picks.
function lessonLines(picked) {
  return (picked || []).map(l => {
    const what = l.tool + (l.target ? ' on ' + clip(l.target, 60) : '');
    // join(), not concatenation: the reason is a tool's own sentence and may or may not end in a
    // stop, and "…not configured for writing Do not start with it" is one run-on sentence a small
    // model reads as a single confused instruction.
    return join('LEARNED: ' + what + ' does not work here — ' + clip(l.why || 'it failed', 100),
      'Do not start with it; try another way.');
  });
}

// ---------------- invented destinations ----------------
//
// A URL the model produced from memory rather than from the page. Observed live, and it is the most
// galling failure in this whole file: handed a ranked list, the loop clicked the correct newest
// video — and then navigated to youtube.com/watch?v=dQw4w9WgXcQ, an ID it knew by heart, throwing
// away the right answer it had just reached.
//
// The rule is the same one that governs file paths here: a destination must be traceable to
// something real — the request, the procedure it was given, or something it actually read off a
// page. Anything else is recall, not observation.
const URL_ID_RE = /[?&](?:v|id|q|search_query)=([\w-]{6,})|\/([\w-]{8,})(?:[/?#]|$)/gi;

function inventsDestination(step, haystack) {
  if (!step || step.tool !== 'browser_go') return false;
  const url = String((step.args && (step.args.url || step.args.to || step.args.target || step.args.query)) || '').trim();
  if (!/^https?:\/\//i.test(url)) return false;          // back/forward/reload invent nothing
  const hay = String(haystack || '').toLowerCase();
  if (hay.includes(url.toLowerCase())) return false;      // the whole URL was given or seen
  // Otherwise every distinctive identifier inside it has to have come from somewhere. A bare host
  // ("go to youtube.com") carries no identifier and is left alone — guessing a HOST is reasonable,
  // guessing a video id is not.
  URL_ID_RE.lastIndex = 0;
  let m, ids = [];
  while ((m = URL_ID_RE.exec(url)) !== null) { const id = m[1] || m[2]; if (id) ids.push(id.toLowerCase()); }
  if (!ids.length) return false;
  return ids.some(id => !hay.includes(id));
}

// ---------------- when approval is still required ----------------
//
// A multi-step run used to stop and ask before EVERY step. On a browser procedure that is four
// prompts to watch one video, which is not an assistant carrying out a task — it is a task being
// carried out by hand with extra steps. So a run that was itself approved runs its ordinary steps
// straight through.
//
// What does NOT get waved through, whatever the run:
//   · anything that spends money or places an order — the one class where being wrong is not
//     recoverable by trying again;
//   · anything that reaches another PERSON, because the mistake lands in someone else's phone;
//   · anything that destroys data.
//
// Note what this is not: it is not a general "the agent may now do anything". Credentials and card
// numbers are refused outright elsewhere and are not reachable from here at all, and a single-step
// request keeps its confirmation because there is no run to have approved.
const OUTBOUND_TOOLS = new Set(['send_message', 'open_whatsapp_chat', 'compose']);
const DESTRUCTIVE_TOOLS = new Set(['delete', 'empty_trash', 'move', 'close_app', 'make_app']);

// Buying, in the words that actually appear on the button. Checked against the ARGUMENTS of a click
// or submit, since that is where the label the model chose ends up.
const BUY_RE = /\b(?:buy|purchase|place\s+order|pay|payment|checkout|check\s?out|confirm\s+order|complete\s+order|subscribe\s+and\s+pay|proceed\s+to\s+pay)\b/i;

// ---------------- "done" is a claim, not a fact ----------------
// It used to be taken at face value: `if (step.tool === 'done') return finishRun('done')`, with no
// check of any kind. Measured on the six-step food procedure — the model opened Swiggy, listed the
// fields, typed "dominos pizza" into the search box, and announced it was finished. Three steps,
// nothing searched, nothing in a basket, and the run reported SUCCESS in 30 seconds.
//
// That is this system's signature failure — announcing work it did not do — sitting in the single
// place it costs the most. test_eval was built to inspect the machine precisely because replies
// cannot be trusted; the loop itself never got the same treatment.
//
// A procedure is a contract. When most of it never ran, "done" is refused and the remaining steps are
// handed back. Bounded, because a model that genuinely IS finished must still be able to stop: after
// this many refusals the claim is accepted whatever the count says.
const DONE_PUSHBACKS = 2;
function prematureDone(o) {
  const opts = o || {};
  const total = Number(opts.procedureSteps) || 0;
  const done = Number(opts.completedSteps) || 0;
  const pushbacks = Number(opts.pushbacks) || 0;
  if (!total) return null;                    // no procedure — nothing to measure the claim against
  if (pushbacks >= DONE_PUSHBACKS) return null;
  // The final step of most procedures is a confirmation ("check something is actually playing"), so
  // stopping one short is allowed; stopping halfway is not.
  if (done >= total - 1) return null;
  return { completed: done, total };
}

function needsExplicitApproval(step) {
  if (!step || !step.tool) return false;
  const tool = String(step.tool);
  if (OUTBOUND_TOOLS.has(tool)) return true;
  if (DESTRUCTIVE_TOOLS.has(tool)) return true;
  // A click or a form submit is ordinary — unless what it is clicking is the thing that takes his
  // money. The label travels in the args, so this reads them rather than trusting the tool name.
  if (tool === 'browser_click' || tool === 'browser_submit' || tool === 'browser_fill') {
    const blob = JSON.stringify((step.args || {}));
    if (BUY_RE.test(blob)) return true;
  }
  if (tool === 'browser_go') {
    const url = String((step.args && (step.args.url || step.args.target)) || '');
    if (/\/(?:checkout|payment|billing|cart\/checkout)\b/i.test(url)) return true;
  }
  return false;
}

// ---------------- budgets ----------------

// Returns a reason string when the run must stop, or null to continue. Time is checked alongside
// steps because a step budget alone bounds the number of tool calls, not how long they take.
function exhausted(run, now) {
  now = now != null ? now : Date.now();   // `||` here treated a now:0 test clock as "not given"

  if (run.steps.length >= run.limits.maxSteps) return 'steps';
  if (now >= run.deadline) return 'time';
  if (run.retries > run.limits.maxRetries) return 'retries';
  return null;
}

function remaining(run, now) {
  now = now != null ? now : Date.now();

  return {
    steps: Math.max(0, run.limits.maxSteps - run.steps.length),
    ms: Math.max(0, run.deadline - now),
    retries: Math.max(0, run.limits.maxRetries - run.retries),
  };
}

// ---------------- verification ----------------

// Which finished steps can be independently CHECKED, and how. This is the difference between "the
// function returned ok" and "the thing you asked for is true" — the two diverge often enough that
// reporting the first as the second is the harness's most misleading possible failure.
//
// Only tools with a genuine read-back are listed. Everything else is honestly unverifiable, and
// saying so is the point: an agent that cannot tell you which of its claims it actually confirmed
// is one you have to re-check by hand anyway.
const VERIFIERS = {
  add_calendar_event: step => ({
    tool: 'list_events',
    args: { days: 2 },
    // The event is confirmed when its title comes back out of the calendar we just wrote to.
    match: (res) => {
      const t = String((step.args && (step.args.title || step.args.summary)) || '').toLowerCase().trim();
      if (!t) return null;
      const hay = JSON.stringify((res && res.data) || res || '').toLowerCase();
      return hay.includes(t);
    },
    describe: 'checked it is in your calendar',
  }),
  open_app: step => ({
    tool: 'list_running',
    args: {},
    match: (res) => {
      const n = String((step.args && step.args.name) || '').toLowerCase().trim();
      if (!n) return null;
      return JSON.stringify((res && res.data) || res || '').toLowerCase().includes(n);
    },
    describe: 'confirmed it is running',
  }),
};
VERIFIERS.switch_to = VERIFIERS.open_app;
VERIFIERS.focus_app = VERIFIERS.open_app;

// Closing is verified by ABSENCE — the mirror of open_app, and the case where a tool's own return
// value is least trustworthy: `quit app` reports that the request was delivered, not that the app
// went away, so an app sitting on an unsaved-changes sheet returns success and stays on screen.
VERIFIERS.close_app = step => ({
  tool: 'list_running',
  args: {},
  match: (res) => {
    const n = String((step.args && (step.args.name || step.args.target)) || '').toLowerCase().trim();
    if (!n) return null;
    if (!res || !res.ok) return null;                  // a broken check proves nothing either way
    return !JSON.stringify(res.data || res.say || '').toLowerCase().includes(n);
  },
  describe: 'confirmed it is no longer running',
});

// Files are where an unverified write costs the most: "Created report.md" with nothing on disk is
// indistinguishable from success until the moment he goes looking for it. `read` gives a real
// read-back, so this is a genuine check rather than a restatement of the write's own return value.
VERIFIERS.create_file = step => ({
  tool: 'read',
  args: { path: (step.args && step.args.path) || '' },
  match: (res) => {
    if (!(step.args && step.args.path)) return null;
    if (!res || !res.ok) return false;                 // the file cannot be read back — not created
    const want = String((step.args && step.args.content) || '');
    if (!want) return true;                            // existence was the whole claim
    const got = String((res.data != null ? res.data : res.say) || '');
    return got.includes(want.slice(0, 200));
  },
  describe: 'read the file back to confirm it',
});

VERIFIERS.append = step => ({
  tool: 'read',
  args: { path: (step.args && step.args.path) || '' },
  match: (res) => {
    if (!(step.args && step.args.path) || !step.args.content) return null;
    if (!res || !res.ok) return false;
    const got = String((res.data != null ? res.data : res.say) || '');
    return got.includes(String(step.args.content).slice(0, 200));
  },
  describe: 'read the file back to confirm the addition',
});

VERIFIERS.create_folder = step => ({
  tool: 'list',
  args: { path: parentOf((step.args && step.args.path) || '') },
  match: (res) => {
    const leaf = baseOf((step.args && step.args.path) || '');
    if (!leaf) return null;
    if (!res || !res.ok) return false;
    const items = (res.data && Array.isArray(res.data)) ? res.data.join('\n') : String(res.say || '');
    return items.toLowerCase().includes(leaf.toLowerCase());
  },
  describe: 'confirmed the folder is there',
});

// Navigation is verified against the URL the browser actually ended up on — a redirect to a login
// wall returns ok from the navigate call while landing somewhere entirely different.
VERIFIERS.browser_go = step => ({
  tool: 'browser_page',
  args: {},
  match: (res) => {
    const want = String((step.args && (step.args.url || step.args.target)) || '').trim();
    if (!want || !/^https?:|\w+\./i.test(want)) return null;   // back/forward/reload — nothing to match
    if (!res || !res.ok) return false;
    const host = hostOf(want);
    if (!host) return null;
    const at = String((res.data && res.data.url) || res.url || res.say || '');
    return at.toLowerCase().includes(host.toLowerCase());
  },
  describe: 'checked the page it actually landed on',
});

// Path helpers kept local and dependency-free: this module must stay pure, and pulling in `path`
// for two string operations would be the only import in the file.
function parentOf(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : (i === 0 ? '/' : '~');
}
function baseOf(p) {
  const s = String(p || '').replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}
function hostOf(u) {
  const m = String(u || '').match(/^(?:https?:\/\/)?([^/?#\s]+)/i);
  return m ? m[1].replace(/^www\./i, '') : '';
}

// The last step worth verifying — checking every step would double the tool calls for no benefit,
// and it is the OUTCOME that matters, not the intermediate navigation.
function verificationFor(run) {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    const r = run.results[i];
    if (!r || !r.ok) continue;
    const mk = VERIFIERS[step.tool];
    if (mk) return Object.assign({ at: i, of: step.tool }, mk(step));
  }
  return null;
}

// EVERY part of a multi-part goal, not just the last one.
//
// Verifying only the final step is right for a single-outcome request and quietly wrong for a list:
// three files created, the first two never landing on disk, the third read back — and the run
// reports "I read the file back to confirm it". True of the file it checked, worthless as a claim
// about the other two, and indistinguishable from the real thing when he reads it.
//
// Bounded rather than exhaustive: distinct targets only (re-reading the same path proves nothing
// twice) and a hard cap, so a thirty-step run cannot triple its own tool calls. On a single-part
// run this returns exactly the one check it always did, at exactly the old cost.
const VERIFY_CAP = 6;
function verificationsFor(run, cap) {
  cap = cap != null ? cap : VERIFY_CAP;
  const out = [];
  const seenTargets = new Set();
  for (let i = run.steps.length - 1; i >= 0 && out.length < cap; i--) {
    const step = run.steps[i];
    const r = run.results[i];
    if (!r || !r.ok) continue;
    const mk = VERIFIERS[step.tool];
    if (!mk) continue;
    const key = step.tool + ':' + normTarget(targetOf(step.args));
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    out.push(Object.assign({ at: i, of: step.tool }, mk(step)));
  }
  return out.reverse();   // chronological, so the report reads in the order the work happened
}

// ---------------- verdict ----------------

// The honest outcome of a run, in the words the user actually hears. Every branch here exists
// because the previous code reported one of them wrongly: an exhausted budget as success, a run
// where nothing executed as "Done, Sir", or an unverified write as a confirmed one.
function verdict(run, reason) {
  const done = run.results.filter(Boolean);
  const failed = done.filter(r => !r.ok);

  if (reason === 'stopped') return { ok: false, say: run.steps.length
    ? 'Stopped, Sir — ' + run.steps.length + ' step' + (run.steps.length === 1 ? '' : 's') + ' in.'
    : 'Stopped, Sir.' };

  // A step asked him something: the run ends on that question, as it was asked.
  if (reason === 'asked') {
    const q = done.slice().reverse().find(r => r && r.data && r.data.asked);
    return { ok: false, asked: true, say: (q && q.say) || 'What should I do, Sir?' };
  }

  if (!done.length) return { ok: false, say: 'I could not get anywhere with that, Sir.' };

  if (failed.length && failed.length === done.length) {
    return { ok: false, say: failed[failed.length - 1].say || 'That did not work, Sir.' };
  }

  // The narrative comes from the last step that SUCCEEDED, never from a failure. Quoting the last
  // result blindly produced "Spotify is not running (1 step failed along the way.)" reported as a
  // success — the sentence and the ok flag contradicting each other in the same breath.
  const oks = done.filter(r => r.ok);
  const lastOk = oks[oks.length - 1];
  const endedBadly = !done[done.length - 1].ok;
  // EVERY DISTINCT THING THAT HAPPENED, NOT ONLY THE LAST ONE.
  //
  // Taking the last successful step alone is right about which sentence is safe to quote — never a
  // failure — and wrong about what the run DID. Observed live on "Jarvis search for GitHub.com": the
  // page was opened in step 1, an app in step 2, and the answer was "Booting Safari, sir. I confirmed
  // it is running." Every word true, describing the least important thing that happened, and leaving
  // him to wonder whether the actual request had been done at all.
  //
  // Bounded on purpose. A nine-step procedure narrated in full is a wall of text nobody reads, so
  // three distinct sentences are quoted and the rest become a count — enough to know more happened
  // and to ask, without burying the part that matters.
  const saidAll = [...new Set(oks.map(r => r.say).filter(Boolean))];
  let say = (lastOk && lastOk.say) || 'Done, Sir.';
  if (saidAll.length > 1) {
    say = saidAll.length <= 3 ? saidAll.join(' ')
      : saidAll.slice(0, 3).join(' ') + ' (and ' + (saidAll.length - 3) + ' more steps.)';
  }

  // Stopped short on a goal that plainly had more parts to it. The loop's repeat and drift guards
  // are the usual cause: both are "the model has nothing useful left to add", which on a one-part
  // request genuinely means finished, and on a nine-part request means eight parts never happened.
  // Reported as success until now — the worst kind of wrong, because he stops checking.
  if (reason === 'incomplete') {
    // Count against the PROCEDURE when one was being followed. run.parts counts the parts of the
    // sentence he typed, and "order me dominos pizza from swiggy" is one of those — which produced
    // the nonsense "I got 3 of about 1 done". The nine steps it was actually working through are the
    // honest denominator.
    const total = run.procedureSteps || run.parts;
    return { ok: false, partial: true,
      say: join(say, 'That is only part of it, Sir — I got ' + done.filter(r => r.ok).length + ' of ' +
        (run.procedureSteps ? '' : 'about ') + total + ' done and then stopped making progress. The rest did not happen.') };
  }

  // Partial completion is stated as partial. Reporting "Done" after running out of budget mid-task
  // is the single most misleading thing an agent can say, because the user stops checking.
  if (reason === 'steps' || reason === 'time' || reason === 'retries') {
    const what = reason === 'time' ? 'ran out of time' : reason === 'retries' ? 'ran out of retries' : 'reached my step limit';
    return { ok: false, partial: true,
      say: join(say, 'Then I ' + what + ' before finishing, Sir — ' + done.length + ' step' +
        (done.length === 1 ? '' : 's') + ' done' + (failed.length ? ', ' + failed.length + ' failed' : '') + '.') };
  }

  // A run whose final step failed is not a success, even if earlier steps worked.
  if (endedBadly) {
    const why = done[done.length - 1].say || 'the last step failed';
    return { ok: false, partial: true, say: join(say, 'But then it stalled — ' + why) };
  }

  if (failed.length) say = join(say, '(' + failed.length + ' step' + (failed.length === 1 ? '' : 's') + ' failed along the way.)');

  // Verification is reported, never assumed. "Confirmed" is only ever said about something that
  // was actually read back.
  if (run.verified === true) say = join(say, 'I ' + (run.verifiedHow || 'confirmed it') + '.');
  else if (run.verified === false) say = join(say, 'I could not confirm it afterwards, Sir — worth a look.');

  return { ok: true, say };
}

module.exports = {
  prematureDone, DONE_PUSHBACKS,
  DEFAULTS, newRun, record, transcript, clip, LISTING_CLIP,
  classify, recoveryHint, TERMINAL_RE, RETRYABLE_RE,
  expectedParts, partsAreCounted, namedArtifacts, missingArtifacts,
  targetOf, normTarget, junkPayload, consecutiveKind, PARTS_CAP,
  needsExplicitApproval, BUY_RE, OUTBOUND_TOOLS, DESTRUCTIVE_TOOLS, inventsDestination,
  goalTerms, lessonScore, pickLessons, lessonLines, LESSON_FLOOR, worthLearning, SAFETY_RE, PRECONDITION_RE,
  exhausted, remaining,
  VERIFIERS, verificationFor, verificationsFor, VERIFY_CAP, verdict,
};
