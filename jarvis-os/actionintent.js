'use strict';
// ---------------------------------------------------------------------------
// WHICH KIND OF ACTION IS THIS? — asked, not looked up in config/verbs.json.
//
// WHAT THIS IS FOR. config/verbs.json is the last and largest keyword trap in the system, and the
// most load-bearing: quickActionCore consults it for eleven action groups, and its answers BEAT the
// model ("THE PARSER GETS FIRST REFUSAL, and its confident answers are final"). Its own header
// advertises the trap as a feature — "Add phrases freely; no code change needed" — and the failure
// is the usual one: the verb nobody wrote down. "crank up spotify" is not an open. "chuck on
// netflix" matches the DELETE group on the word "chuck".
//
// WHY THIS FILE DOES NOT YET REPLACE IT. verbRe() does two jobs at once — it decides the group AND
// strips the verb, handing the remainder to the parser as m[1]. The second job already has a
// listless replacement (afterVerb() in agent.js drops the leading token whatever it is). The first
// job is this file. What makes the swap expensive is not either half but the CALLERS: quickAction is
// synchronous and reached from four synchronous helpers (leadingNavigation, clauseResolves,
// expandElided, clauseSplit), each exported and each pinned by tests, and ~1050 assertions in
// test_parse.js describe quickAction's exact output.
//
// SO IT RUNS IN SHADOW FIRST. The classifier is wired where the caller is already async, its verdict
// is compared against what verbs.json decided, and every disagreement is logged. Nothing routes on
// it. That is how a parser this load-bearing earns its replacement — on a record of where the two
// differ over his real traffic, rather than on an argument that embeddings are better. The eval
// harness note in the handoff puts it exactly right: test agent changes by running real goals and
// inspecting the machine, not the reply.
//
// THE REGIONS ARE THE GROUPS verbs.json DECLARES, minus `research`, which is already gone (see
// webintent.js). Each is a thing the machine can DO, so they are naturally tight — with one honest
// exception noted on `search` below.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const ACTION_EXEMPLARS = {
  open_app: [
    'open spotify', 'launch brave', 'fire up notes', 'boot up textedit',
    'pull up the calculator', 'start the app store', 'bring up activity monitor',
    'get spotify going', 'crank up spotify', 'spotify kholo', 'notes kholo',
  ],
  close_app: [
    'close safari', 'quit spotify', 'kill the terminal', 'shut down notes',
    'exit the calculator', 'stand down textedit', 'safari band karo',
  ],
  create: [
    'make a folder called notes', 'create a file called report.txt',
    'new folder on my desktop', 'build me a folder for the trip',
    'make a note called groceries', 'ek folder banao desktop pe',
  ],
  delete: [
    'delete report.pdf', 'remove that file', 'get rid of the old folder',
    'trash the screenshot', 'bin those downloads', 'chuck out the temp files',
    'yeh file delete kar do',
  ],
  // THE HONEST EXCEPTION. A file search and a web lookup are close in meaning and the difference is
  // WHERE, not what — "find my resume" against "find out about tokamaks". webintent.js already owns
  // that boundary and runs earlier, so this region only ever has to recognise searching the MACHINE.
  // The exemplars are deliberately all local-file shaped for that reason.
  search: [
    'find my resume', 'where is that pdf I saved', 'locate the invoice file',
    'search for notes.txt on my desktop', 'find the file called budget',
    'meri resume file kahan hai',
  ],
  list: [
    'list my downloads', 'what is in the documents folder',
    'show contents of my desktop', 'what files are in that folder',
  ],
  system_status: [
    'system status', 'how are we looking', 'give me a sitrep',
    'run diagnostics', 'how are we doing', 'status report',
  ],
  empty_trash: [
    'empty the trash', 'take out the trash', 'empty the bin',
  ],
  screenshot: [
    'take a screenshot', 'grab the screen', 'capture the screen',
    'screenshot le lo', 'take a picture of my screen',
  ],
  list_running: [
    'what apps are running', 'what is running right now', 'list the running apps',
    'what have I got open', 'which apps are open',
  ],
  sleep_display: [
    'sleep the display', 'turn off the screen', 'screen off', 'put the display to sleep',
  ],
  // NOT ONE JUNK DRAWER. FOUR REGIONS, FOR THE REASON THIS FILE ALREADY KNOWS.
  //
  // The first draft of this put all fourteen of the sentences below into a single `none`, and it
  // failed exactly the way webintent.js and calintent.js failed before it: a centroid averaged over
  // unrelated sentences means nothing in particular and pulls weakly, so anything vaguely
  // imperative drifts into whichever ACTION region is nearest. Measured, on held-out text:
  //
  //     "what is the capital of france"  → screenshot
  //     "thanks that worked"             → delete     (margin 0.142 — decisively)
  //     "play something by drake"        → open_app
  //
  // Those are not near misses; they are a region with no gravity. Split into four things that each
  // mean something, every one of them has somewhere proper to belong.
  talk: [
    'how are you', 'thanks, that is perfect', 'good afternoon', 'never mind',
    'that worked, cheers', 'nice one', 'what do you think',
  ],
  ask: [
    'what is the weather', 'who is the CEO of BlackRock', 'what is 17 times 23',
    'what is the capital of france', 'explain how recursion works',
    'what is on my calendar', 'how far is the moon',
  ],
  // ADDRESSED TO SOMEONE, OR ABOUT TIME — both are instructions, so they cannot sit with `talk`,
  // and both belong to lanes that run before quickAction ever sees them.
  reach: [
    'message mama on whatsapp', 'text parth that i am late', 'call dad',
    'remind me to call the dentist', 'set a timer for ten minutes',
    'order me a pizza', 'play judas', 'play something by drake',
  ],
  // A SENTENCE THAT MERELY CONTAINS AN ACTION WORD. This is the region that stops "delete is a
  // strong word" becoming a hunt for a file called "is a strong word" — the failure quickActionCore's
  // own comments record from a run of ordinary chat.
  mention: [
    'delete is a strong word', 'create something beautiful',
    'i watch a lot of youtube', 'opening up to people is hard',
    'i should really close that chapter', 'searching for meaning is the point',
  ],
};

// Every region that is not one of the eleven ACTIONS means the same thing to the caller: leave this
// alone. Grouping them means an action has to beat its nearest NON-action, instead of the margin
// collapsing between two different ways of not being an action.
const NOT_ACTION = new Set(['talk', 'ask', 'reach', 'mention']);

// Swept in test_actionintent.js, which prints the table rather than remembering it.
//
// RE-SWEPT for nomic-embed-text (was 0.05 under all-minilm). This is the classifier the swap helped
// most: leave-one-out accuracy 76/92 -> 83/92, and the wrong decisions that used to reach 0.111 now
// stop at 0.094 with most of them under 0.03. Median correct margin 0.268 -> 0.119, so the scale
// halved here too and 0.025 is the same bar in the new space.
const MIN_MARGIN = 0.025;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }

// Returns the group id, or null when the regions are too close to call. Null is a RESULT: it means
// "this is not confidently one of the eleven", and in shadow mode it is recorded as such.
async function actionKind(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (!_classify) {
    const groups = {};
    for (const id of Object.keys(ACTION_EXEMPLARS)) groups[id] = NOT_ACTION.has(id) ? 'idle' : 'act';
    _classify = intent.makeClassifier({
      exemplars: ACTION_EXEMPLARS, minMargin: MIN_MARGIN, none: '__unused__', groups,
      label: 'Action', jlog: () => {},        // silent: shadow mode logs its own comparison
    });
  }
  try {
    const r = await _classify(t.slice(0, 300));
    // A win by any of the non-action regions is the same answer: not an action of this kind.
    return (r && !NOT_ACTION.has(r.id)) ? r.id : null;
  } catch (e) { return null; }
}

// SHADOW COMPARISON. `was` is whatever verbs.json's parser decided (an action type like
// 'create_folder', or null). The mapping from this file's GROUPS to those types is many-to-one, so
// the comparison is deliberately coarse: it asks whether the two agree about the FAMILY, which is
// the only thing a group can be wrong about.
const TYPE_TO_GROUP = {
  open_app: 'open_app', open_site: 'open_app', open_url: 'open_app', open_social: 'open_app',
  close_app: 'close_app',
  create_file: 'create', create_folder: 'create', make_app: 'create', append: 'create',
  delete: 'delete',
  search: 'search', search_web: 'search', read: 'list', list: 'list',
  system_status: 'system_status', empty_trash: 'empty_trash', screenshot: 'screenshot',
  list_running: 'list_running', sleep_display: 'sleep_display',
};
async function shadowCompare(text, was) {
  try {
    const mine = await actionKind(text);
    const theirs = was ? (TYPE_TO_GROUP[was] || was) : null;
    if (mine === theirs) return;
    _jlog('ActionShadow › "' + String(text).slice(0, 44) + '" verbs.json=' +
      (theirs || 'none') + ' semantic=' + (mine || 'none'));
  } catch (e) {}
}

module.exports = { actionKind, shadowCompare, init, ACTION_EXEMPLARS, NOT_ACTION, TYPE_TO_GROUP, MIN_MARGIN };
