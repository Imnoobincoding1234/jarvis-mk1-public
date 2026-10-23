'use strict';
// Tests for the reflective layer (recall, time machine, tutor, proactive, observe, dream).
// Same shape as test_parse.js: no server, no network, no real side effects — every module is
// pointed at a throwaway state dir so nothing here can touch real episodes or macros.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reflective-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } };
const eq = (a, b, label) => ok(a === b, label + (a === b ? '' : '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'));
// Deep-equal for the small arrays these tests compare. eq() on arrays compares references and
// silently passes nothing useful, which is worse than no assertion.
const eqj = (a, b, label) => eq(JSON.stringify(a), JSON.stringify(b), label);
const head = t => console.log('\n— ' + t + ' —');

const recall = require('../recall');
const timemachine = require('../timemachine');
const tutor = require('../tutor');
const proactive = require('../proactive');
const observe = require('../observe');

// A stub LLM so grading/summarising paths run without a model or network.
let llmCalls = 0;
const stubLlm = async opts => {
  llmCalls++;
  const u = String(opts.messages[0].content);
  // Grade on the ANSWER only — matching the whole prompt would also match the passage, which
  // contains the words "correct answer" and would score every wrong answer as right.
  if (opts.schema) {
    const given = (u.match(/HIS ANSWER:\s*([\s\S]*)$/) || [, ''])[1];
    return { text: JSON.stringify({ score: /entropy|correct/i.test(given) ? 5 : 1, feedback: 'Because the passage says so.' }) };
  }
  // Long enough to clear makeCard's minimum-length guard, which correctly rejects stub-short output.
  if (/exam question/i.test(String(opts.system || ''))) return { text: 'What does the second law say about entropy in an isolated system?' };
  return { text: 'STUB ANSWER FOR TESTS' };
};

recall.init({ stateDir: TMP, llm: stubLlm, jlog: () => {}, audit: () => {} });
timemachine.init({ stateDir: TMP, jlog: () => {}, audit: () => {}, openApp: async () => ({ ok: true }) });
tutor.init({ stateDir: TMP, llm: stubLlm, jlog: () => {}, audit: () => {}, retrieve: () => ([{ book: 'Test Book', loc: 'p.1', text: 'The correct answer is that entropy always increases in an isolated system, a statement of the second law of thermodynamics.' }]) });
proactive.init({ stateDir: TMP, jlog: () => {}, notify: () => {} });
observe.init({ stateDir: TMP, jlog: () => {}, audit: () => {}, saveMacro: (n, p) => ({ ok: true, say: 'saved ' + n + ' (' + p.steps.length + ')' }) });

(async () => {

head('episodic memory: writing and retrieval');
recall.logTurn('what did we decide about the composio routing', 'We route local work locally and only named services go to the cloud.');
recall.logTurn('open swiggy and find burgers', 'Opening Swiggy, Sir.', { app: 'Swiggy' });
recall.logTurn('remind me to call the dentist', 'Reminder added, Sir.');
eq(recall.count(), 3, 'three episodes stored');

const hits = recall.retrieve('composio routing decision', 3);
ok(hits.length > 0, 'retrieves something for a real query');
ok(/composio/i.test(hits[0].text), 'top hit is the composio episode');

eq(recall.retrieve('zzzzqqq nonexistent', 3).length, 0, 'no hits for nonsense');

head('episodic memory: trivia is not stored');
const before = recall.count();
recall.logTurn('thanks', 'Any time, Sir.');
recall.logTurn('ok', 'Sir.');
recall.logTurn('yeah', 'Sir.');
eq(recall.count(), before, 'bare acknowledgements are dropped, not journalled');

head('episodic memory: recall answers, and refuses to invent');
const r1 = await recall.TOOLS.recall({ query: 'composio routing' });
ok(r1.ok, 'recall succeeds when history has it');
const r2 = await recall.TOOLS.recall({ query: 'qqqzzz never discussed' });
ok(!r2.ok, 'recall FAILS rather than inventing when nothing matches');
ok(/nothing/i.test(r2.say), 'and says so plainly');

head('episodic memory: a dry run counts and previews, and deletes nothing');
const nd = recall.count();
const dr = recall.TOOLS.forget_episodes({ query: 'composio', dry: true });
ok(dr.ok && dr.data && dr.data.n >= 1 && Array.isArray(dr.data.preview), 'dry run reports how many would go, with a preview');
eq(recall.count(), nd, 'and the store is untouched');

head('episodic memory: forget really forgets');
const n0 = recall.count();
const fr = recall.TOOLS.forget_episodes({ query: 'composio' });
ok(fr.ok, 'forget reports success');
ok(recall.count() < n0, 'episode count actually dropped');
eq(recall.retrieve('composio routing', 3).length, 0, 'and it is no longer retrievable');

head('episodic memory: dedupe');
recall.log('turn', 'Atharv asked: same thing\nJARVIS answered: same');
recall.log('turn', 'Atharv asked: same thing\nJARVIS answered: same');
const dropped = recall.compact();
ok(dropped >= 1, 'compact drops exact duplicates (' + dropped + ')');

head('knowledge graph');
recall.log('did', 'Messaged Parth about admax', { person: 'Parth' });
recall.log('did', 'Messaged Parth again about admax', { person: 'Parth' });
const g = recall.graph();
ok(Array.isArray(g.nodes), 'graph returns nodes');
ok(g.nodes.some(n => /PARTH/i.test(n.label)), 'a repeated person becomes a node');
ok(g.nodes.some(n => /ADMAX/i.test(n.label)), 'a project mentioned twice becomes a node');
ok(g.edges.some(e => (e.from + e.to).toLowerCase().includes('parth')), 'co-occurrence produces an edge');

head('time machine: when-parsing');
const w1 = timemachine.parseWhen('put everything back to how it was at 3pm');
ok(w1 && new Date(w1.at).getHours() === 15, '"at 3pm" → 15:00');
const w2 = timemachine.parseWhen('what was open 2 hours ago');
ok(w2 && Math.abs((Date.now() - w2.at) - 7200000) < 60000, '"2 hours ago" → now minus 2h');
ok(timemachine.parseWhen('this morning'), '"this morning" parses');
eq(timemachine.parseWhen('open safari'), null, 'a plain command is not a time');

head('time machine: restore never closes anything');
const src = fs.readFileSync(path.join(__dirname, '..', 'timemachine.js'), 'utf8');
ok(!/closeApp|close_app|\bquit\b\s*\(/.test(src.replace(/\/\/.*$/gm, '')), 'no close/quit call exists in the module at all');
ok(/left those alone/i.test(src), 'and it tells the user what it deliberately did not close');

head('time machine: honest about missing history');
const noHist = await timemachine.TOOLS.what_was_open({ when: 'at 3pm' });
ok(!noHist.ok, 'reports failure rather than guessing when there is no snapshot');

head('tutor: topics and cards');
ok(!tutor.hasTopics(), 'no topics initially');
const lt = tutor.TOOLS.learn_topic({ topic: 'thermodynamics' });
ok(lt.ok && tutor.hasTopics(), 'topic added');
const q = await tutor.TOOLS.quiz_me({});
ok(q.ok, 'quiz_me produces a question');
ok(tutor.pending(), 'a question is now pending');
ok(/Test Book/.test(q.say), 'question cites the source book');

head('tutor: grading is sourced, and scheduling responds to it');
const good = await tutor.TOOLS.answer_quiz({ answer: 'the correct answer' });
ok(good.ok, 'a right answer grades ok');
ok(/Correct/i.test(good.say), 'and is reported as correct');
ok(!tutor.pending(), 'pending question cleared after answering');

const q2 = await tutor.TOOLS.quiz_me({});
ok(q2.ok, 'a second question is available');
const bad = await tutor.TOOLS.answer_quiz({ answer: 'total nonsense' });
ok(/Not quite/i.test(bad.say), 'a wrong answer is marked wrong, not flattered');
ok(/tomorrow/i.test(bad.say), 'and a missed card returns tomorrow');

head('tutor: no answer without a pending question');
const stray = await tutor.TOOLS.answer_quiz({ answer: 'hello' });
ok(!stray.ok, 'refuses to grade when nothing was asked');

head('proactive: rate limiting and quiet hours are real');
const psrc = fs.readFileSync(path.join(__dirname, '..', 'proactive.js'), 'utf8');
// Assert the PROPERTY, not the number — these dials moved when initiative became normal mode
// (3/hr → 6/hr) and a test pinned to the old value fails for no good reason. What must stay true
// is that a finite cap exists at all, and that it is not absurdly high.
const capM = psrc.match(/MAX_PER_HOUR\s*=\s*(\d+)/);
ok(capM && Number(capM[1]) > 0 && Number(capM[1]) <= 12, 'a finite, sane hourly cap exists (' + (capM && capM[1]) + '/hr)');
const gapM = psrc.match(/MIN_GAP\s*=\s*(\d+)\s*\*\s*MIN/);
ok(gapM && Number(gapM[1]) >= 3, 'a minimum gap between nudges exists (' + (gapM && gapM[1]) + ' min)');
ok(/QUIET_START|quietNow/.test(psrc), 'quiet hours exist');
ok(/const away = idle > AWAY_AFTER/.test(psrc), 'presence is still checked before delivering');
eq(typeof proactive.quietNow(), 'boolean', 'quietNow answers');

head('proactive normal mode: away nudges are held, not dropped');
// Before normal mode a nudge that came due while the user was away was discarded outright. Now it
// is queued and handed over on return — but bounded, so returning after a weekend does not produce
// a wall of stale notifications.
ok(/QUEUE_MAX/.test(psrc) && /slice\(0, QUEUE_MAX\)/.test(psrc), 'the queue is capped');
ok(/QUEUE_TTL/.test(psrc), 'stale held nudges expire');

// Driven for real rather than grepped: presence is injectable, so the away → return cycle can be
// exercised. An earlier version of this test stubbed the exported idleSeconds and silently proved
// nothing, because the module reads its own internal copy.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proq-'));
  const P = require('../proactive.js');
  const delivered = [];
  let idle = 9999;                                  // away
  // quietHours [0,0] disables the overnight window. Without it this whole block silently passed
  // by doing nothing between 22:00 and 08:00 — tick() bails on quiet hours before it can queue.
  P.init({ stateDir: tmp, jlog: () => {}, notify: (k, t) => delivered.push(t),
    quietHours: [0, 0],
    idleSeconds: async () => idle,
    stats: async () => ({ batteryPct: 5, charging: false, diskPct: 10 }) });
  const held = () => { try { return (JSON.parse(fs.readFileSync(path.join(tmp, 'proactive.json'), 'utf8')).queue || []).length; } catch (e) { return 0; } };

  await P.tick();
  eq(delivered.length, 0, 'nothing is DELIVERED while away');
  ok(held() > 0, 'but the signal is HELD (' + held() + ' queued)');

  idle = 5;                                         // back at the machine
  await P.tick();
  eq(delivered.length, 1, 'the held nudge is handed over on return');
  eq(held(), 0, 'and the queue is drained');
  ok(/battery/i.test(delivered[0] || ''), 'it is the right nudge: "' + delivered[0] + '"');

  // Re-init the shared module against a throwaway dir so later tests are unaffected.
  P.init({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proq2-')), jlog: () => {}, notify: () => {}, idleSeconds: null, stats: null });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

head('tailnet: detection does not depend on the Tailscale app bundle');
// The CLI lives inside /Applications/Tailscale.app and returns nothing when this server runs as a
// launchd agent — verified live: the first restart logged "no Tailscale IPv4 was found" and never
// bound, while the identical call worked from a terminal.
{
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/\/sbin\/ifconfig/.test(srv), 'the interface is read directly');
  ok(/function tailnetIp/.test(srv) && srv.indexOf('/sbin/ifconfig') < srv.indexOf("TS_BIN, ['ip'"), 'ifconfig is tried BEFORE the CLI');
  ok(/let TAILNET_IP/.test(srv), 'the address is re-probeable, not frozen at boot');
  ok(/function startTailnet/.test(srv) && /startTailnet\(attempt \+ 1\)/.test(srv),
    'binding retries while Tailscale connects (it loses the race at login)');
  ok(/tailnetServer\.listen\(PORT, TAILNET_IP/.test(srv), 'binds the tailnet address specifically');
  ok(!/listen\(PORT,\s*['"]0\.0\.0\.0['"]/.test(srv), 'NEVER binds 0.0.0.0');
  ok(/CGNAT_RE/.test(srv), 'only a 100.64/10 CGNAT address is accepted');
}

head('proactive: break / water reminder (asked for 2026-08-08)');
// Driven, not grepped. The reset rule is the whole point — a reminder that fires on someone who
// just came back from lunch teaches them to ignore it, which costs the entire proactive layer.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-brk-'));
  const P = require('../proactive.js');
  let idle = 0;
  P.init({ stateDir: tmp, jlog: () => {}, audit: () => {}, notify: () => {},
    idleSeconds: async () => idle, workBeforeBreak: 1, quietHours: [0, 0] });

  // NOT wrapped in its own async IIFE — the whole file already runs inside one, and an inner
  // wrapper resolves after the summary prints, so its assertions are never counted. That is
  // exactly how a test block silently proves nothing.
  ok(await P.sigHydration() === null, 'silent until switched on');
  P.TOOLS.breaks_set({ enabled: true });
  await P.sigHydration();                       // seeds the active window
  await new Promise(r => setTimeout(r, 5));
  const fired = await P.sigHydration();
  ok(fired && fired.key === 'break', 'fires after a long unbroken stretch at the desk');
  ok(fired && /water/i.test(fired.detail), 'and says what it actually wants him to do');

  // A real break resets the clock: away past the threshold, then back.
  idle = 999;
  ok(await P.sigHydration() === null, 'says nothing while he is away from the desk');
  idle = 0;
  ok(await P.sigHydration() === null, 'and the clock restarts on his return rather than firing immediately');

  P.TOOLS.breaks_set({ enabled: false });
  ok(await P.sigHydration() === null, 'switching it off stops it');

  // ON OR OFF IS NEVER READ OUT OF WORDS (2026-09-18): proactive_set read "be quiet" as off.
  const wasOn = P.isEnabled();
  const said = P.TOOLS.proactive_set({ text: 'be quiet for a sec i am on a call' });
  ok(said.ok === false && P.isEnabled() === wasOn, 'proactive_set with only words changes nothing (' + said.say + ')');
  ok(P.TOOLS.breaks_set({ enabled: 'yes' }).ok === false, 'breaks_set wants a real true/false, not a word');

  // Hand the shared module back to a throwaway dir so later blocks are unaffected.
  P.init({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-brk2-')), jlog: () => {},
    notify: () => {}, idleSeconds: null, workBeforeBreak: null, quietHours: null });
}

head('proactive: triage');
const t = proactive.triage([
  { id: 1, kind: 'warn', title: 'Agent failed', detail: 'it crashed', at: 3 },
  { id: 2, kind: 'ok', title: 'Library indexed', detail: 'done', at: 2 },
  { id: 3, kind: 'warn', title: 'Agent failed', detail: 'it crashed', at: 1 },
]);
eq(t.items.length, 2, 'identical notifications collapse into one row');
eq(t.items[0].count, 2, 'with a count');
eq(t.items[0].level, 'high', 'a failure is ranked high');
eq(t.items[0].level === 'high' && t.items[1].level, 'low', 'routine success is ranked low');
ok(t.high === 1 && t.muted === 1, 'summary counts are right');

head('observation: records apps, never keystrokes');
const osrc = fs.readFileSync(path.join(__dirname, '..', 'observe.js'), 'utf8');
ok(!/CGEvent|keycode|keyDown|eventTap/i.test(osrc.replace(/\/\/.*$/gm, '')), 'no keystroke capture anywhere in the module');
ok(/not recording keystrokes/i.test(osrc), 'and it tells the user so when it starts');

const st = observe.start();
ok(st.ok && observe.recording(), 'recording starts');
observe.noteCommand('open safari', { steps: [{ tool: 'open_app', args: { name: 'Safari' } }] });
observe.noteCommand('call that morning', null);   // the naming command itself must not be recorded
const stat = observe.status();
ok(/1 command/.test(stat.say), 'the naming command is excluded from the recording');
const named = observe.nameIt({ name: 'morning setup' });
ok(named.ok, 'recording saves as a macro');
ok(!observe.recording(), 'and recording stops on save');
const nothing = observe.nameIt({ name: 'x' });
ok(!nothing.ok || /not been watching|did not see/i.test(nothing.say), 'naming twice does not save an empty macro');

head('observation: cancel discards');
observe.start();
observe.noteCommand('open mail', { steps: [{ tool: 'open_app', args: { name: 'Mail' } }] });
ok(observe.cancel().ok, 'cancel works');
ok(!observe.recording(), 'and stops the recording');

head('server: preview and reflective regexes');
const ssrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PREVIEW_RE = eval('/' + ssrc.match(/const PREVIEW_RE = \/(.+?)\/i;/)[1] + '/i');
for (const s of ['show me what you\'d do', 'dry run opening safari', 'show me the plan', 'what would you do if I said message mama', 'don\'t do it yet, plan it first']) {
  ok(PREVIEW_RE.test(s), 'preview: "' + s + '"');
}
for (const s of ['open safari', 'what is the weather', 'message mama about dinner']) {
  ok(!PREVIEW_RE.test(s), 'NOT preview: "' + s + '"');
}
// Running a preview is its own word now ("Say “go” to run it"), not a list of ways to say go ahead.
ok(!/const PREVIEW_GO_RE|PREVIEW_GO_RE\.test/.test(ssrc), 'PREVIEW_GO_RE is gone');
ok(/setWordOffer\('go', 'run the previewed plan'/.test(ssrc) && /Say “go” to run it/.test(ssrc), 'the preview names "go" as its answer');
ok(/if \(!held \|\| held\.id !== id\) return null;/.test(ssrc), 'and "go" runs only the preview that asked for it');

head('preview: only ONE preview is ever live');
// Regression: previews were held in a Map keyed by id, and a bare "go ahead" with nothing on
// screen popped the most recent surviving entry — running a plan the user had previewed several
// turns earlier and moved on from. "Go ahead" is assent to the last thing shown, or to nothing.
ok(/let lastPreview = null/.test(ssrc), 'a single preview slot, not a collection');
ok(!/pendingPreview/.test(ssrc), 'the multi-preview map is gone entirely');
ok(/if \(!held \|\| held\.id !== id\) return null;\s*\n\s*lastPreview = null;/.test(ssrc), 'consumed on use, so a second "go" does nothing');
ok(/PREVIEW_TTL\s*=\s*\d+\s*\*\s*60\s*\*\s*1000/.test(ssrc), 'and it expires on a timer');

head('question guard: an informational question must never mutate');
// Regression, found by live stress: "how do I create a folder" ACTUALLY CREATED ~/on my desktop/
// My New Folder, and "what is a new moon" opened a web search. QUESTION_RE conflated wh-questions
// with polite requests ("can you open youtube"), so it could only be used as a partial guard and
// three of the four action routes had none at all.
const WH_RE = eval('/' + ssrc.match(/const WH_RE = \/(.+?)\/i;/)[1] + '/i');
const AUX_SELF_RE = eval('/' + ssrc.match(/const AUX_SELF_RE = \/(.+?)\/i;/)[1] + '/i');
const isInfoQ = s => { s = String(s).trim(); if (/^(?:how|what)\s+about\b/i.test(s)) return false; return WH_RE.test(s) || AUX_SELF_RE.test(s); };
for (const s of ['what is a new moon', 'how do I create a folder', 'what should I delete',
                 'who is the new prime minister', 'should I close my laptop', 'do I have any meetings',
                 'can I delete this file', 'what is the 2030 new world order']) {
  ok(isInfoQ(s), 'informational: "' + s + '"');
}
for (const s of ['can you open youtube', 'could you close safari', 'would you play some music',
                 'open youtube', 'delete report.pdf', 'how about opening spotify', 'will you open notes']) {
  ok(!isInfoQ(s), 'request (must still act): "' + s + '"');
}
ok(/const QUESTION_SAFE_ACTIONS = new Set/.test(ssrc), 'safe actions are a WHITELIST, not a blocklist');
ok(!/QUESTION_SAFE_ACTIONS[\s\S]{0,400}?'(?:create_folder|create_file|delete|move|close_app)'/.test(ssrc),
  'no mutating action appears in the safe list');
// 2026-10-10: a checked reader action passes, exactly as at the statement guard (sweeps/sweep_questionguard.js: 16 refusals of
// checked readings, all real requests, none saved). Nothing else is exempt.
ok(/if \(blockedForQuestion\(act, cmdText\) && !\(readerActs && readmodel\.checked\(act\)\)\)/.test(ssrc), 'the gate runs once on the resolved action, exempting only a checked reader action');
// The normaliser's rewrite was a second route to an action and needed the gate a second time. It is
// gone (the reader model reads the sentence as said), so what must hold is that no rewrite route came
// back — and that the one gate is the only place a question is refused.
ok(!/normalizeCommand|normAct/.test(ssrc), 'no normaliser rewrite route is left to guard');
ok((ssrc.match(/blockedForQuestion\(/g) || []).length === 2, 'the gate is defined once and applied once');
ok(/&& !isInformationalQuestion\(cmdText\)\) \{/.test(ssrc), 'and the agent-loop branch is gated too');

head('statement guard: naming something is not asking for it');
// "my books are on the shelf" reached the agentic loop on mentionsKnownTarget alone and spent
// 37 seconds looking for a contact named "books".
ok(/Statement guard/.test(ssrc), 'a statement guard exists before the agent-loop fallback');
ok(/!looksLikeCommand\(cmdText\) && !isCompoundCommand\(cmdText\)/.test(ssrc),
  'the loop needs an actual instruction, not just a recognised noun');
  // Added after "so if I were to start with contaminated water how would I clean it?" reached the loop
  // — the word "start" made it look like a command — and after "i watch a lot of youtube" opened an
  // app. Both failures converge on this branch, so both guards are asserted here.
  ok(/isHowToQuestion\(cmdText\)/.test(ssrc), 'a how-to question never reaches the loop');
  ok(/isStatement\(cmdText\)/.test(ssrc), 'a statement never reaches the loop');

head('pending quiz is one-shot and expires');
// A pending question used to capture every later non-command sentence: "dream log" and
// "my books are on the shelf" were both graded as wrong answers about relativity.
const tsrc = fs.readFileSync(path.join(__dirname, '..', 'tutor.js'), 'utf8');
ok(/PENDING_TTL\s*=\s*\d+\s*\*\s*60\s*\*\s*1000/.test(tsrc), 'pending answers expire on a timer');
ok(/function pendingLive/.test(tsrc) && /pending: pendingLive/.test(tsrc), 'pending() honours the TTL');
ok(/tutor\.clearPending\(\)/.test(ssrc), 'moving on to anything else drops the question');
const tmIdx = ssrc.indexOf('tutor.pending()');
const libIdx = ssrc.indexOf('LIB_RE.test(cmdText)');
ok(tmIdx > libIdx, 'the pending check runs LAST, after every other lane has declined');

head('time machine: session timeline is reachable');
ok(timemachine.TM_RE.test('session timeline'), 'session timeline matches its lane');
ok(timemachine.TM_RE.test('app history'), 'app history matches too');
ok(!timemachine.TM_RE.test('open safari'), 'and still does not steal ordinary commands');

head('library: naming the library is not querying it');
const LIB_RE2 = eval('/' + ssrc.match(/const LIB_RE = \/(.+?)\/i;/)[1] + '/i');
const LIB_ASK = eval('/' + ssrc.match(/const LIB_ASK_RE = \/(.+?)\/i;/)[1] + '/i');
const libHit = t => LIB_RE2.test(t) && LIB_ASK.test(t);
for (const s of ['what do my books say about virtue', 'index my library', 'search my library for stoicism']) {
  ok(libHit(s), 'library: "' + s + '"');
}
for (const s of ['my books are on the shelf', 'I need to move my books', 'my library card expired']) {
  ok(!libHit(s), 'NOT library: "' + s + '"');
}

head('anti-hallucination: false COMPLETION claims');
// Live bug: "now save that as my business's website" → "Saved the action of opening
// ad-max.vercel.app as your business's website." Nothing was saved, proven by the next turn
// failing. The old guard only caught PROMISES to act ("I'll open that"), never claims that
// something was already done — and it was gated on the input looking like a command, which this
// did not. A false completion is the worst reply here, because the user stops checking.
const DONE_RE = eval('/' + ssrc.match(/const CLAIMED_DONE_RE = \/(.+?)\/i;/)[1] + '/i');
for (const r of ["Saved the action of opening ad-max.vercel.app as your business's website.",
                 'Added that to your sites.', 'Created the folder for you.', 'Done, Sir.',
                 "I've saved that for you.", 'That has been scheduled.', 'Consider it done.']) {
  ok(DONE_RE.test(r), 'caught: "' + r.slice(0, 46) + '"');
}
for (const r of ['I could not carry that out, Sir.', 'The weather is 33°C and overcast.',
                 'You asked me about entropy earlier today.', 'I have no “business website” saved, Sir.']) {
  ok(!DONE_RE.test(r), 'not a false claim: "' + r.slice(0, 46) + '"');
}
// ASSERT THE PROPERTY, NOT THE SPELLING — the same lesson test_parse learned twice about the
// runTypedGoal door. This pinned the literal line `if (CLAIMED_DONE_RE.test(replyText)) {`, and the
// guard is now a semantic classification (`claim === 'done'`) because three regexes listing ninety
// phrasings still missed "Sure, let me look that up for you." Nothing it cares about changed: the
// property is that the completion guard is decided by the REPLY, with no condition on how the input
// looked, and that a false completion is never published.
ok(/if \(claim === 'done'\) \{/.test(ssrc), 'the completion guard is judged on the reply alone');
ok(!/if \(claim === 'done'\)[^\n]*(?:looksLikeCommand|mentionsKnownTarget|cmdText)/.test(ssrc),
   '…with no condition on how the input looked');
// CLAIMED_DONE_RE itself is still live, and the cases above still exercise it: progressPartial()
// consults it per streaming token to decide whether a half-finished sentence is safe to SPEAK, and
// that path cannot await an embedding for every token.
ok(/CLAIMED_DONE_RE\.test\(progress\.partial\)/.test(ssrc), 'and the sync speech filter still uses it');

head('my sites: the save is real, not narrated');
{
  const MSAVE = eval('/' + ssrc.match(/const MYSITE_SAVE_RE = \/(.+?)\/i;/)[1] + '/i');
  const MOPEN = eval('/' + ssrc.match(/const MYSITE_OPEN_RE = \/(.+?)\/i;/)[1] + '/i');
  ok(MSAVE.test("now save that as my business's website"), 'save: "that" form');
  ok(MSAVE.test('save ad-max.vercel.app as my portfolio'), 'save: explicit URL form');
  ok(MOPEN.test("open my business's website"), 'open: matches');
  ok(/saveJson\(MYSITES_FILE/.test(ssrc), 'it writes to a real file');
  // Must not hijack the ordinary handlers for things that are not saved sites.
  ok(/const hit = findMySite\(m\[1\]\);\s*\n\s*if \(hit\) \{/.test(ssrc), 'only claims the request when a site is actually saved');
}

head('bare domains are openable');
// "open ad-max.vercel.app" was refused with "Only http/https links" — pedantry that reads as
// failure for an address a person plainly typed.
{
  const BD = eval('/' + ssrc.match(/const BARE_DOMAIN_RE = \/(.+?)\/i;/)[1] + '/i');
  for (const d of ['ad-max.vercel.app', 'example.com', 'sub.domain.co.uk/path?q=1', 'localhost:3000/x']) {
    ok(BD.test(d) || /localhost/.test(d), 'domain-shaped: ' + d);
  }
  for (const d of ['open the app store', 'my business', 'hello world', 'a sentence with. periods']) {
    ok(!BD.test(d), 'NOT a domain: "' + d + '"');
  }
}

head('agent loop cannot invent a recipient');
// Live: asked only to "Open ad-max.vercel.app", the loop failed the URL then called
// open_whatsapp_chat with the fabricated number +1234567890 — opening a stranger's chat for a
// request that never mentioned messaging anyone.
{
  const asrc = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  ok(/CONTACT_OUT_TOOLS/.test(asrc), 'outward-facing contact tools are identified');
  ok(/SIDE_EFFECT_TOOLS[^\n]*open_whatsapp_chat/.test(asrc), 'open_whatsapp_chat counts as side-effecting');
  ok(/const resolved = steps\.some\(s => s\.tool === 'find_contact'\)/.test(asrc), 'requires a real contact lookup first');
  ok(/refused: recipient not from Contacts|recipient was not resolved/.test(asrc), 'and refuses loudly rather than silently');
}

head('agent health: alive is not the same as working');
// The Clap daemon logged an audio-engine failure every second for hours while every dashboard
// showed it green, because the only question asked was whether it had a PID.
ok(/function sourceHealth/.test(ssrc) && /HEALTH_MIN_ERRORS/.test(ssrc), 'health is derived from the log error rate');
ok(/a\.health = !a\.running \? 'down' : h \? 'degraded' : 'ok'/.test(ssrc), 'agents report down / degraded / ok');
ok(/is running but failing/.test(ssrc), 'a degraded agent raises a real notification');
ok(/if \(now - when > HEALTH_WINDOW\) return;/.test(ssrc),
  'historical log lines replayed at startup do NOT count as current failures');

head('greeting: accurate by hour, and the voice override');
{
  // Pure functions of the clock, so the whole day is testable without waiting for it.
  const part = h => (h>=5&&h<12)?'morning':(h>=12&&h<17)?'afternoon':(h>=17&&h<21)?'evening':'night';
  const S = 22, E = 9, quiet = h => S > E ? (h >= S || h < E) : (h >= S && h < E);
  for (const [h, p, q] of [[0,'night',true],[6,'morning',true],[9,'morning',false],[13,'afternoon',false],
                           [18,'evening',false],[21,'night',false],[22,'night',true],[23,'night',true]]) {
    eq(part(h), p, String(h).padStart(2,'0') + ':00 is ' + p);
    eq(quiet(h), q, String(h).padStart(2,'0') + ':00 ' + (q ? 'text-only' : 'spoken'));
  }
  ok(/opts\.voice \? true : !quiet/.test(ssrc), 'their voice overrides the overnight text-only rule');
  ok(/state\.lastVia = via/.test(fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8')),
    'the client records whether they spoke, so the override has something to read');
  // Every clause must be dropped rather than faked when its source is unavailable.
  ok(/withTimeout/.test(ssrc), 'each greeting source has its own timeout');
  ok(/if \(mail && mail\.count > 0\)/.test(ssrc), 'the mail clause appears only with a real count');
  ok(/composio\.available\(\) \?/.test(ssrc), 'and only when the cloud lane is actually connected');
}

head('deep research: its own lane, and it cannot bail early');
{
  const dr = require('../deepresearch.js');
  // THIS TEST USED TO eval() RESEARCH_RE OUT OF server.js's SOURCE TEXT. That regex is deleted —
  // webintent.js answers "does this need the web" semantically now — and a test that reads another
  // file's source with a regex is pinned to its punctuation rather than to its behaviour, which is
  // the failure this suite has already had twice. The half that belongs HERE is deep research
  // claiming what is its own and nothing more; that an ordinary lookup reaches the web lane is
  // asserted in test_webintent.js, against the thing that now decides it.
  // THE TRIGGERS MOVED OUT OF deepresearch.js AND STOPPED BEING REGEXES.
  //
  // What was here tested DEEP_RE and stripDeep directly. Both are deleted: three open classes of
  // phrasing and a subtractive extractor. researchintent.js decides it now — regions and a margin,
  // then a second reader before any half-hour job starts — and the topic is named by the model and
  // checked against what he actually typed.
  //
  // WHAT IS ASSERTED HERE IS THE PROPERTY, NOT THE ACCURACY. The numbers live in sweep_research.js
  // (37/37 on the first held-out set, 59/61 across both, 7/7 on topics against stripDeep's 2/7).
  // These are the cases where being wrong costs him something.
  const RI = require('../researchintent.js');
  RI.init({ jlog: () => {} });
  for (const s of ['deep research about quantum computing', 'deep-research the arc reactor',
                   'research quantum computing deeply', 'do a deep dive on fusion']) {
    ok(await RI.kindOf(s) === 'deep', 'deep: "' + s + '"');
  }
  // A LOOKUP MUST NOT START A HALF-HOUR JOB. This is the expensive direction and the reason the
  // quick-lookup region exists at all — without it, any sentence using a research VERB had nowhere
  // to land but `deep`.
  for (const s of ['look into the swiggy outage', 'read up on stoicism',
                   'whats the capital of peru', 'find out if the library is open']) {
    ok(await RI.kindOf(s) !== 'deep', 'not deep, so it falls to the ordinary lane: "' + s + '"');
  }
  ok(await RI.kindOf('open youtube') === null, 'and does not claim plain commands');
  ok(await RI.kindOf('order me a pizza') === null, 'nor an errand');

  // ONE SENTENCE READS AS DEEP TO BOTH MODELS AND WAS PINNED AS A LOOKUP, and the pin was the
  // artefact. "research on quantum computing" fell to the ordinary lane under DEEP_RE for exactly
  // one reason: it lacked the word "deeply". The embedder and the 3B independently read it as a
  // real investigation. Recorded as a KNOWN DISAGREEMENT rather than asserted either way — see the
  // note in researchintent.js — because pinning it to the regex's answer would be pinning a
  // typo-level accident of the old implementation.

  // NO MODEL, NO TOPIC EXTRACTION, NO WORD LISTS. The topic is his sentence verbatim — deep research
  // hands it to its own research model as the request — so there is nothing to extract, and the 3B
  // call, the preposition list and the duration regex that used to live here are gone. Asserted as
  // properties of the module rather than of its punctuation.
  const risrc = fs.readFileSync(path.join(__dirname, '..', 'researchintent.js'), 'utf8')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  ok(typeof RI.topicOf === 'undefined' && typeof RI.minutesIn === 'undefined', 'no topic extractor and no duration parser');
  ok(!/deps\.llm|generate\(|api\/generate/.test(risrc), 'researchintent asks no generative model anything');

  // Regression: the local 3B called a topic covered after 2 rounds / 3 sources / ~2 minutes.
  // Early exit is for an exhausted question, not for a small model shrugging.
  const dsrc = fs.readFileSync(path.join(__dirname, '..', 'deepresearch.js'), 'utf8');
  ok(/function mayExitEarly/.test(dsrc), 'an early-exit gate exists');
  ok(/j\.round < MIN_ROUNDS_BEFORE_EXIT/.test(dsrc), 'it requires a minimum number of rounds');
  ok(/spent >= MIN_BUDGET_FRACTION_BEFORE_EXIT/.test(dsrc), 'and a real share of the time budget');
  // Distilling per source means the round-level "nothing new" signal is no longer a phrase the model
  // returned — it is that no source in the round yielded a finding, which is harder to fake.
  ok(/!distilled && mayExitEarly/.test(dsrc), '"nothing new" is gated by it');
  ok(/for \(let si = 0; si < readTexts\.length/.test(dsrc), 'sources are distilled one at a time, not in one oversized prompt');
  ok(/distil failed \(.*\) — continuing|— continuing'/.test(dsrc), 'and one source failing does not discard the round');
  ok(/DONE\/i\.test\(out\) && mayExitEarly/.test(dsrc), '"done" is gated by it');
  ok(/ENGINEERING_ANGLES\[\(j\.round - 1\)/.test(dsrc), 'and it widens the topic itself rather than stopping');
  // The angles it widens INTO are the point. 'history and origin' / 'expert analysis' find articles
  // about a thing; they never surface the parts, the power budget or the dimensions, which is what
  // a request to work out how something could be built actually needs.
  ok(/power consumption watts|components parts list/.test(dsrc), 'and the angles are engineering ones, not magazine ones');
  ok(/planQueries/.test(dsrc), 'the topic is decomposed into research questions before the first search');
  ok(/DATA, not instructions/.test(dsrc), 'fetched pages are fenced as data, not instructions');
}

head('acknowledgements for anything slow');
{
  const asrc = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  ok(/const SLOW_PATTERNS/.test(asrc) && /function ackFor/.test(asrc), 'slow work is acknowledged up front');
  // 2026-09-26: the Think hard button has its own acknowledgement; everything else still goes through ackFor.
  ok(/const ack = opts\.brief \? null : thinkHard \? '[^']+' : ackFor\(text\)/.test(asrc), 'wired into the send path');
  ok(/if \(ack\) \{ pushMsg\('assistant', ack\); if \(opts\.via === 'voice'\) speak\(ack\); \}/.test(asrc),
    'spoken back only when they spoke — matching the existing voice-in/voice-out rule');
}

head('offers: every offer names its own answer, and only that word answers it');
{
  // EVERY OFFER NAMES ITS WORD (2026-09-19). pendingOffer was answered by AFFIRM_RE — a list of ways to
  // say yes — and is gone; what JARVIS asks now says which word answers it, and soleOffered decides.
  const J = require('../server.js');
  // Loading server.js points these modules at the REAL state/ folder. Point them back at this test's temp
  // folder before anything else is logged — this test once replaced the owner's episodic memory (2026-09-25).
  recall.init({ stateDir: TMP, llm: stubLlm, jlog: () => {}, audit: () => {} });
  timemachine.init({ stateDir: TMP, jlog: () => {}, audit: () => {}, openApp: async () => ({ ok: true }) });
  tutor.init({ stateDir: TMP, llm: stubLlm, jlog: () => {}, audit: () => {}, retrieve: () => ([{ book: 'Test Book', loc: 'p.1', text: 'The correct answer is that entropy always increases in an isolated system, a statement of the second law of thermodynamics.' }]) });
  proactive.init({ stateDir: TMP, jlog: () => {}, notify: () => {} });
  observe.init({ stateDir: TMP, jlog: () => {}, audit: () => {}, saveMacro: (n, p) => ({ ok: true, say: 'saved ' + n + ' (' + p.steps.length + ')' }) });
  for (const [reply, word, want] of [
    ['read', 'read', true], ['Read.', 'read', true], ['call', 'call', true], ['present', 'present', true],
    ['yes', 'read', false], ['read all my unread mails', 'read', false], ['call mama', 'call', false],
    ['open textedit', 'open', false], ["don't call", 'call', false],
  ]) ok(!!J.soleOffered(reply, new Set([word])) === want, JSON.stringify(reply) + (want ? ' answers' : ' does not answer') + ' the offer of "' + word + '"');
  ok(!/setOffer\(|pendingOffer = \{/.test(ssrc), 'nothing arms a yes/no offer any more');
  ok(/setWordOffer\('call', 'call '/.test(ssrc) && /Say “call” and I will dial/.test(ssrc), 'the call is confirmed by its own word');
  ok(/word: 'read'/.test(ssrc) && /say “read” and I will read them out/.test(ssrc), 'the mail offer names "read"');
  ok(/word: 'present'/.test(ssrc) && /say “present” to hear it/.test(ssrc), 'the research offer names "present"');
  ok(/setWordOffer\('open', 'open '/.test(ssrc) && /say “open” and I will/.test(fs.readFileSync(path.join(__dirname, '..', 'proactive.js'), 'utf8')),
    'a nudge that offers to open an app says which word opens it');
  ok(/const OFFER_TTL = \d+ \* 60 \* 1000/.test(ssrc), 'offers expire');
  ok(/wordOffers = new Map\(\);\s*\n\s*const said = soleOffered/.test(ssrc), 'single use — every live offer is retired by the next message');

  // Regression: the retire-on-unrelated-message check lived INSIDE the lane chain, so a message
  // handled by an earlier lane (weather) returned before reaching it and left the offer live —
  // the next unrelated "yes" then read the mail out. It must run before any lane can return.
  const retireAt = ssrc.indexOf('const live = [...liveWordOffers().values()];');
  // The weather lane's call site, however it is spelled. It was
  // `WEATHER_RE.test(cmdText)` and became `weatherAsked(cmdText)` when the lane
  // gained the grammatical gate it never had — so an indexOf on the old literal
  // returned -1 and failed a test that only cares about ORDER. Matched on the
  // `plain &&` guard the lane actually opens with instead.
  const weatherAt = ssrc.search(/\bplain && (?:weatherAsked\(cmdText\)|WEATHER_RE\.test\(cmdText\))/);
  const previewAt = ssrc.indexOf('PREVIEW_RE.test(cmdText)');
  ok(retireAt > 0, 'an unanswered offer is retired');
  ok(retireAt < weatherAt && retireAt < previewAt, 'and retired BEFORE any lane can return');
}

head('live progress: narrates thinking as well as doing');
{
  const asrc = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  const csrc = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  ok(/function progressStart/.test(ssrc) && /function progressStep/.test(ssrc), 'a progress bus exists');
  ok(/finally \{ progressEnd\(\); \}/.test(ssrc), 'the session closes however the turn ends');
  ok(/p === '\/api\/progress'/.test(ssrc), 'and is pollable');
  // Regression: instrumenting only the agentic loop left the COMMON path (deterministic plans)
  // silent, and instrumenting only execution left the longest pause — deciding the next step,
  // an LLM call — silent too.
  ok(/deps\.onStep\(describeAgentStep\(step\)\)/.test(asrc), 'the agentic loop narrates its steps');
  ok(/deps\.onStep\(describeAgentStep\(\{ tool: step\.tool/.test(asrc), 'deterministic plans narrate too');
  ok(/Working out how to do this/.test(asrc) && /Deciding what to do next/.test(asrc),
    'and the thinking pauses are narrated, not just the actions');
  ok(/function describeAgentStep/.test(asrc), 'steps are described in plain English, not tool names');
  // The quiet rule, and its override.
  ok(/PROGRESS_QUIET_START = 23, PROGRESS_QUIET_END = 9/.test(ssrc), 'text-only 23:00–09:00');
  ok(/if \(progress\.voice\) return true;/.test(ssrc), 'unless the task was given by voice');
  // Was a literal `if (p.speak && via === 'voice')`. The condition gained terms when the answer
  // started being spoken as it streams — the rule under test did not move: nothing is said unless
  // the SERVER permitted it and the turn arrived by voice. Assert that of EVERY speaking gate,
  // rather than of one exact spelling.
  const gates = csrc.match(/if \(p\.speak && via === 'voice'[^{]*\)/g) || [];
  ok(gates.length >= 1, 'the client only speaks when the server allows it');
  ok(gates.every(g => /p\.speak/.test(g) && /via === 'voice'/.test(g)),
    'and every speaking gate requires both, not one or the other');
  // The new half: a streamed answer can still be REPLACED by the anti-hallucination guard, so it is
  // spoken only while the server says the text so far is safe to commit to out loud.
  ok(/p\.speakSafe/.test(csrc), 'a streamed answer additionally waits for speakSafe');
  ok(/speakSafe: progress\.speakSafe !== false/.test(ssrc), 'and the server actually reports it');
  ok(/via: opts\.via \|\| 'typed'/.test(csrc), 'and tells the server how the task arrived');
}

head('deep research survives being away');
{
  const dsrc = fs.readFileSync(path.join(__dirname, '..', 'deepresearch.js'), 'utf8');
  ok(/function unpresented/.test(dsrc), 'a finished-but-unseen result is tracked');
  ok(/job\.presented = true;/.test(dsrc) && /function present/.test(dsrc), 'marked presented on DELIVERY');
  // Marking it on completion would count a result nobody saw as delivered.
  ok(!/presented = true[\s\S]{0,200}finishedAt = Date\.now\(\)/.test(dsrc), 'not merely on completion');
  ok(/presented: !!j\.presented/.test(dsrc), 'and the flag survives a restart');
  ok(/deps\.notify\('ok', 'Research finished/.test(dsrc), 'a notification fires when it lands');
  // The greeting offers it, with variety, ahead of mail.
  ok(/const done = deepresearch\.unpresented\(\)/.test(ssrc), 'the greeting checks for it');
  const ways = (ssrc.match(/const ways = \[([\s\S]*?)\];/) || [, ''])[1];
  ok((ways.match(/'/g) || []).length / 2 >= 5, 'at least five phrasings, so it does not become wallpaper');
  ok(/done \? \{ kind: 'present_research'/.test(ssrc), 'and it outranks mail as the offer');
  ok(/if \(kind === 'present_research'\)/.test(ssrc), 'a bare "yes" presents it');
}

head('contacts: WhatsApp as a fallback, Contacts.app still authoritative');
{
  const asrc = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  ok(/ContactsV2\.sqlite/.test(asrc), 'reads WhatsApp\'s own address book');
  ok(/'-readonly'/.test(asrc), 'opens it READ-ONLY — never writes to another app\'s database');
  ok(/\.param set :q/.test(asrc), 'the search term is parameterised, not concatenated into SQL');
  // Order matters: Contacts.app carries emails and curated labels, so it must win when it has them.
  const jxaAt = asrc.indexOf('const r = await jxa(JXA_FIND_CONTACT');
  const waAt = asrc.indexOf('const wa = await waLookup(q)');
  ok(jxaAt > 0 && waAt > jxaAt, 'WhatsApp is only consulted after Contacts.app comes up empty');
  ok(/not in Contacts or WhatsApp/.test(asrc), 'and a genuine miss names both places it looked');
  ok(/needsClarify: true[\s\S]{0,120}Several WhatsApp contacts/.test(asrc),
    'several WhatsApp matches still stop and ask rather than guessing');
}

head('mail: unread is a filter, not a synonym for recent');
{
  const csrc = fs.readFileSync(path.join(__dirname, '..', 'composio.js'), 'utf8');
  ok(/args\.unreadOnly && !q\) a\.query = 'is:unread in:inbox'/.test(csrc), 'unread requests actually filter on unread');
  ok(/args\.unreadOnly[\s\S]{0,120}' unread, Sir:'/.test(csrc), 'and the reply says "unread", not "most recent"');
  ok(/function mailArgs/.test(ssrc), 'the request is parsed for intent and count');
  ok(/count: 15, unreadOnly: true/.test(ssrc), 'accepting the greeting\'s offer reads UNREAD mail');
  // The offer counts unread; reading the most recent would answer a different question.
  const MA = new Function('text', ssrc.match(/function mailArgs\(text\) \{[\s\S]*?\n\}/)[0] + '; return mailArgs(text);');
  eq(MA('read all my unread mails').unreadOnly, true, '"unread" detected');
  eq(MA('read all my unread mails').count, 15, '"all" asks for a full page');
  eq(MA('read my 3 unread emails').count, 3, 'a count with an adjective in the way still parses');
  eq(MA('show me my recent emails').unreadOnly, false, 'plain "recent" is not treated as unread');
}

head('usuals: a standing preference, not a replay of history');
{
  const os2 = require('os'), path2 = require('path'), fs2 = require('fs');
  const U = require('../usuals.js');
  U.init({ jlog: () => {}, stateDir: fs2.mkdtempSync(path2.join(os2.tmpdir(), 'jarvis-usual-')) });
  U.set('pizza', { brand: 'Domino\u2019s', always: ['the Classic pizza', 'garlic bread'], ask: ['a choco lava cake'] });

  ok(!!U.find('pizza'), 'found by the food word');
  ok(!!U.find('dominos'), 'found by BRAND with no apostrophe — "Domino\u2019s" normalised to "domino s" and matched nothing');
  ok(!!U.find('domino\u2019s'), 'and by the brand written with a curly apostrophe');
  ok(!!U.find('dominos pizza'), 'and by the vague phrase he actually types');
  ok(!U.find('biryani'), 'a food with no usual on file returns nothing rather than guessing');

  // The sometimes-half must never ride along silently — he was explicit that the cake is occasional.
  const u = U.find('pizza');
  ok(U.orderText(u).indexOf('choco lava') === -1, 'the order text excludes the sometimes-item');
  ok(U.orderText(u).indexOf('garlic bread') >= 0, 'but includes what always goes with it');
  ok(U.describe(u).indexOf('choco lava') >= 0, 'the sometimes-item is OFFERED instead');

  // Generic: nothing here knows what a pizza is.
  U.set('momos', { brand: 'Wow! Momo', always: ['steamed chicken momos'], ask: [] });
  ok(!!U.find('momos'), 'any food can have a usual, not just the seeded one');
  ok(U.describe(U.find('momos')).indexOf('as well?') === -1, 'with no sometimes-items there is nothing to ask about');
}

head('the loop: "done" is a claim that has to be earned');
{
  const H = require('../harness.js');
  // The exact run this was built for: a six-step food procedure abandoned after three steps with a
  // cheerful "done" — nothing searched, nothing in a basket, reported as success in 30 seconds.
  ok(!!H.prematureDone({ procedureSteps: 6, completedSteps: 3, pushbacks: 0 }),
     'halfway through a six-step procedure is refused');
  const d = H.prematureDone({ procedureSteps: 6, completedSteps: 3, pushbacks: 0 });
  ok(d.completed === 3 && d.total === 6, 'and it reports how far it actually got');
  ok(!!H.prematureDone({ procedureSteps: 4, completedSteps: 0, pushbacks: 0 }),
     'claiming done having run nothing at all is refused');

  // It must still be possible to finish.
  ok(!H.prematureDone({ procedureSteps: 6, completedSteps: 5, pushbacks: 0 }),
     'one step short is allowed — the last step of most procedures is a confirmation');
  ok(!H.prematureDone({ procedureSteps: 6, completedSteps: 6, pushbacks: 0 }),
     'a completed procedure is done');
  ok(!H.prematureDone({ procedureSteps: 0, completedSteps: 0, pushbacks: 0 }),
     'with no procedure there is nothing to measure the claim against, so done stands');
  // BOUNDED. A model that genuinely is finished must not be trapped in a loop of refusals.
  ok(!H.prematureDone({ procedureSteps: 6, completedSteps: 1, pushbacks: H.DONE_PUSHBACKS }),
     'after the pushback limit the claim is accepted, however little ran');
  ok(!!H.prematureDone({ procedureSteps: 6, completedSteps: 1, pushbacks: H.DONE_PUSHBACKS - 1 }),
     'but not one refusal earlier');
  // Progress is successes, not attempts — five failures is not five sixths of a procedure.
  ok(!!H.prematureDone({ procedureSteps: 6, completedSteps: 0, pushbacks: 1 }),
     'a run that failed everything has completed nothing');
}

head('browser control: reading is free, acting is gated IN CODE');
{
  const b = require('../browser.js');
  b.init({ jlog: () => {}, audit: () => {} });
  const bsrc = fs.readFileSync(path.join(__dirname, '..', 'browser.js'), 'utf8');

  // Card detection by Luhn — the difference between "a long number" and "a card number".
  ok(b.looksLikeCard('4242424242424242'), 'a valid card number is recognised');
  ok(b.looksLikeCard('4242 4242 4242 4242'), 'spacing does not hide it');
  ok(!b.looksLikeCard('4242424242424241'), 'a number failing Luhn is not treated as a card');
  ok(!b.looksLikeCard('12345'), 'a short number is not a card');

  ok(!!b.sensitiveValue('4242424242424242', {}), 'card numbers are refused on any field');
  ok(!!b.sensitiveValue('hunter2', { name: 'password' }), 'password fields are refused');
  ok(!!b.sensitiveValue('123', { name: 'cvv' }), 'CVV is refused');
  ok(!!b.sensitiveValue('x', { auto: 'current-password' }), 'autocomplete=current-password is refused');
  ok(!b.sensitiveValue('London', { name: 'city' }), 'ordinary text into an ordinary field is allowed');

  for (const u of ['https://checkout.shop.com/pay', 'https://signin.example.com', 'https://www.chase.com/x',
                   'https://x.com/login', 'https://accounts.google.com/oauth']) {
    ok(b.SENSITIVE_URL_RE.test(u), 'sensitive page refused: ' + u);
  }
  for (const u of ['https://en.wikipedia.org/wiki/Cat', 'https://news.ycombinator.com']) {
    ok(!b.SENSITIVE_URL_RE.test(u), 'ordinary page allowed: ' + u);
  }

  // ADDRESSES. Swiggy already holds his, so that procedure never touches the field — but every other
  // checkout has an empty one, and an empty address box is where a small model writes "123 Main
  // Street". His rule: use the address he names, otherwise ask. Grounding, not trust.
  for (const f of ['Delivery address', 'street', 'addressLine1', 'pincode', 'Postal code', 'City',
                   'Flat / House no.', 'landmark']) {
    ok(b.ADDRESS_FIELD_RE.test(f), 'counts as an address field: ' + f);
  }
  for (const f of ['Search for restaurant', 'email', 'field-keywords', 'q']) {
    ok(!b.ADDRESS_FIELD_RE.test(f), 'not an address field: ' + f);
  }
  ok(b.addressGrounded('42 Sector 15 Fairview', 'order a pizza to 42 Sector 15 Fairview'), 'the address he named is filled');
  ok(b.addressGrounded('42 Sector 15', 'deliver to 42 Sector 15, Fairview 999301'), 'a form splitting it across boxes still matches');
  ok(b.addressGrounded('999301', 'deliver to 42 Sector 15, Fairview 999301'), 'and so does the pincode box');
  ok(b.addressGrounded('42, sector-15, FAIRVIEW', 'order to 42 Sector 15 Fairview'), 'casing and punctuation do not matter');
  ok(!b.addressGrounded('123 Main Street', 'order me a pizza'), 'an invented address is refused');
  ok(!b.addressGrounded('42 Sector 15 Fairview', 'order me a pizza'), 'even a REAL past address is refused when he did not name it — he asked for none to be stored');
  ok(!b.addressGrounded('42 Sector 15 Fairview', ''), 'no goal to check against means do not type it (fails closed)');

  // THE FIELD THAT ACTUALLY BROKE IT. Swiggy's saved-location box is labelled with the address
  // itself, so it contains none of the words above and sailed past the metadata check — "dominos
  // pizza" was typed into his home address and the run searched for nothing.
  const SWIGGY_ADDR = 'HOME Marigold Vihar, Fairview, Punjab 999301, India';
  ok(b.looksLikeAddressValue(SWIGGY_ADDR), 'a box already holding an address is recognised by its VALUE');
  ok(b.isAddressField({ text: SWIGGY_ADDR, name: '', auto: '', type: 'text' }), 'so the saved-location box is an address field');
  ok(b.looksLikeAddressValue('42 Sector 15, Fairview 999301'), 'a pincode in a place name is an address');
  ok(!b.looksLikeAddressValue('dominos pizza'), 'a search query is not an address');
  ok(!b.looksLikeAddressValue('Pizza Hut'), 'a restaurant name is not an address');
  ok(!b.isAddressField({ text: 'Search for restaurants and food', name: '', auto: '', type: 'text' }),
     'the real search box is not mistaken for an address field');

  // And the gate that let it through the FIRST fix: "dominos pizza" IS in "order me dominos pizza
  // from swiggy", so a pure grounding test called it grounded and typed it. Grounding can only decide
  // WHICH address to use — never whether an address belongs in the box at all.
  const gaveAddress = said => b.looksLikeAddressValue(said) ||
    /\baddress\b|\bdeliver (?:it |this )?to\b|\bsend (?:it |this )?to\b|\bship (?:it |this )?to\b/i.test(said);
  ok(b.addressGrounded('dominos pizza', 'order me dominos pizza from swiggy'),
     'the query IS present in his request — which is exactly why grounding alone is not the gate');
  ok(!gaveAddress('order me dominos pizza from swiggy'), 'he named no address, so nothing may be typed into one');
  ok(gaveAddress('order pizza, deliver to 42 Sector 15, Fairview 999301'), 'naming an address opens the field');

  // THE BUTTON THAT SPENDS HIS MONEY. harness.needsExplicitApproval tests BUY_RE against the step's
  // args — but a click's args are {i: 63}, a bare index carrying no label, so "Place your order" was
  // indistinguishable from any other number and an auto-approved run could have pressed it. What
  // stopped purchases before this was the playbook's wording and a /checkout/ URL pattern: a
  // convention and a URL, neither of which inspects the thing being clicked. Checked on the resolved
  // label, and never disabled by the guard experiment switch.
  for (const l of ['Buy Now', 'Buy now with 1-Click', 'Place your order', 'Place Order', 'Proceed to Pay',
                   'Complete purchase', 'Confirm order', 'Pay Now', 'Make payment', 'Subscribe and pay']) {
    ok(b.BUY_LABEL_RE.test(l), 'refuses to click: ' + l);
  }
  // It stops AT the basket, not before it — adding to a cart is the job.
  for (const l of ['Add to cart', 'ADD', 'View basket', 'Continue shopping', 'Domino\u2019s Pizza',
                   'Play Golden Brown', 'Search for restaurants and food']) {
    ok(!b.BUY_LABEL_RE.test(l), 'still allows: ' + l);
  }

  // Indices only mean something for the page they were listed from. Clicking index 3 after the page
  // changed underneath is precisely how the wrong button gets pressed.
  // The fixtures below carry first/last because the REAL caller does: actGuard builds `cur` with
  // fingerprint(url, els), which always fills both. They were omitted here while staleReason ignored
  // them, and adding the label check to close the saturated-count hole (see test_stress) made these
  // partial fixtures fail — the test was describing a shape production never produces.
  ok(!!b.staleReason({ url: 'a', count: 1, first: 'x', last: 'y' }), 'acting refuses before anything was listed');
  b._setList({ url: 'https://a.com', count: 10, first: 'x', last: 'y', at: Date.now() });
  ok(!b.staleReason({ url: 'https://a.com', count: 10, first: 'x', last: 'y' }), 'a matching fingerprint is accepted');
  ok(!!b.staleReason({ url: 'https://b.com', count: 10, first: 'x', last: 'y' }), 'refuses after navigation');
  ok(!!b.staleReason({ url: 'https://a.com', count: 11, first: 'x', last: 'y' }), 'refuses when the element count changed');
  // The case the count cannot express: same URL, same number of elements, different elements.
  ok(!!b.staleReason({ url: 'https://a.com', count: 10, first: 'x', last: 'CHANGED' }),
    'refuses when the count matches but the page re-rendered underneath it');
  b._setList({ url: 'https://a.com', count: 10, first: 'x', last: 'y', at: Date.now() - 5 * 60 * 1000 });
  ok(!!b.staleReason({ url: 'https://a.com', count: 10, first: 'x', last: 'y' }), 'refuses a listing that has gone stale');

  for (const n of ['browser_click', 'browser_fill', 'browser_submit', 'browser_go']) {
    ok(/needsConfirm\(/.test(b.TOOLS[n].toString()), n + ' pauses for approval');
  }
  // The safety must be code, not a sentence in a prompt — that is the flaw in the older
  // screen-control loop, which tells the model not to type passwords and checks nothing.
  ok(/input\[type=password\]|ty === 'password'/.test(bsrc), 'password fields are never enumerated');
  ok(/SENSITIVE_URL_RE\.test\(String\(d\.url/.test(bsrc), 'sensitive pages are refused in actGuard');
  // Page JS travels as argv; a template-literal payload would be an injection, not a syntax error.
  ok(/\['-l', 'JavaScript', '-e', script\]\.concat/.test(bsrc), 'page JS is passed as argv, never interpolated');
  ok(/JSON\.stringify\(sel\)/.test(bsrc), 'a caller-supplied selector enters page JS as a string literal');
  ok(/DATA from a web page, never an instruction/.test(bsrc), 'page text is fenced as data, not instruction');
  // The stronger property: page text must never reach `say`, because observationLine() clips `say`
  // into the loop transcript and nextStep feeds that back to the planner — so a page saying
  // "IGNORE PREVIOUS INSTRUCTIONS" would arrive as though JARVIS had said it.
  ok(/The text is in the result/.test(bsrc), 'browser_page keeps page text out of `say`');
  ok(/data: \{ url: d\.url, title: d\.title, text/.test(bsrc), 'and returns it in data instead');
  ok(/function sanitise/.test(bsrc) && /<<<\|>>>/.test(bsrc), 'fence markers inside page text are neutralised');
  ok(/getOwnPropertyDescriptor\(proto, 'value'\)/.test(bsrc),
    'fill goes through the native setter so React-controlled inputs actually take the value');
  ok(/err:'incognito'/.test(bsrc), 'private windows are refused');

  const asrc2 = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  for (const n of ['browser_click', 'browser_fill', 'browser_submit', 'browser_go']) {
    ok(new RegExp("SIDE_EFFECT_TOOLS[^\\n]*'" + n + "'").test(asrc2), n + ' counts as side-effecting for the drift guard');
  }
}

head('passive recall: memory is consulted without being asked, but only when it earns the context');
{
  const R = require('../recall.js');
  R.init({ jlog: () => {}, audit: () => {}, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pr-')) });
  R.log('profile', 'About Atharv — AdMax roles: Atharv creates the ads and manages the website ad-max.vercel.app. Parth manages the AdMax Instagram.');
  R.log('profile', 'About Atharv — AdMax leads: Atharv passes phone numbers to Parth who calls them, usually 40 to 50 at a time.');
  R.log('profile', 'About Atharv — AdMax Instagram: Parth posts daily between 7pm and 9pm.');
  // Bulk filler so corpus statistics are realistic — the thresholds below are idf-based and a
  // three-episode store would pass them trivially.
  for (let i = 0; i < 40; i++) R.log('did', 'Opened an application and checked the weather forecast for today');

  // Facts filed by the profile were previously write-only: retrieval ran ONLY behind RECALL_RE, so
  // an ordinary question never consulted memory and JARVIS denied knowing what it had been told.
  for (const q of ['what does parth do for admax', 'tell me about admax', 'when does parth post on instagram',
                   'how many phone numbers for parth', 'who runs the instagram account', 'whats parths role']) {
    ok(!!R.passive(q), 'attaches memory for: ' + q);
  }
  // The other half matters more: this rides on EVERY chat turn, so a loose trigger is a permanent
  // tax on the local model's context.
  for (const q of ['hey', 'how are you', 'what is the capital of france', 'open spotify', 'thanks',
                   'what time is it', 'whats the weather', 'is it going to rain', 'good morning',
                   'tell me a joke', 'how much battery do i have', 'set a timer for ten minutes']) {
    ok(!R.passive(q), 'stays quiet for: ' + q);
  }
  // "what time is it" is the specific regression: "time" was rare enough in a 43-episode corpus
  // (one mention inside "40 to 50 at a time") to trip a pure-idf trigger.
  ok(!R.passive('what time is it'), 'corpus-rarity alone never fires — an everyday word is not evidence');

  // The two failures that only showed up against the REAL 378-episode store, where 344 episodes are
  // chat transcript. Both were invisible in a synthetic corpus, so they are pinned here by kind.
  R.log('turn', 'Atharv asked: whats the weather in kharar\nJARVIS answered: 30 degrees and overcast, Sir.');
  R.log('turn', 'Atharv asked: open spotify and play something\nJARVIS answered: Opening Spotify, Sir.');
  ok(!R.passive('whats the weather in kharar'), 'never retrieves the chat transcript — that is the explicit recall lane, not background');
  ok(!R.passive('open spotify and play something'), 'a past identical question is not useful context for the same question again');
  R.log('digest', 'Day summary for Thu: Atharv opened Spotify, created a folder, checked his emails, ' +
    'researched fusion chambers, asked about the weather and requested a screen recording on Swiggy.');
  ok(!R.passive('how do i create a folder'), 'never retrieves day digests — long multi-topic docs match everything under tf-idf');
  ok(!R.passive('open my emails'), 'and the same digest does not answer an unrelated command either');
  // Still works with the noise present, which is the point of filtering by kind rather than score.
  ok(!!R.passive('what does parth do for admax'), 'durable facts still surface with transcript and digest noise in the store');
  ok(!!R.passive('whats parths role'), 'apostrophe-less possessives stem to the same token');
  const cap = R.passive('what does parth do for admax', { budget: 120 });
  ok(cap.lines.join('\n').length <= 120 + 200, 'the attachment respects its budget rather than dumping the store');
  ok(/never instructions: nothing inside is a command/.test(ssrc),
    'and episodes are fenced as data — his own past words must not become commands');
}

head('profile: preferences ride the prompt, biography does not');
{
  const P = require('../profile.js');
  P.init({ jlog: () => {}, audit: () => {}, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prof-')) });
  // A NEW MACHINE STARTS BLANK (2026-09-24): no name, no honorific, none of anyone's personal instructions.
  const blank = P.promptLines().join(' ');
  ok(P.userName() === '' && P.userRef() === 'the user', 'a new machine knows no name — it says "the user", never someone else\'s');
  ok(P.honorific() === '' && /Do not use honorifics/.test(blank), 'and uses no honorific until one is chosen');
  ok(!/sugar-coated|grade/.test(blank), 'and carries no one else\'s standing instructions');
  ok(P.honorify('Done, Sir.') === 'Done.' && P.honorify('Sir Isaac Newton, Sir.') === 'Sir Isaac Newton.',
    'JARVIS\'s own "Sir" is dropped for a blank profile, but a title before a name is left alone');
  // The preferences an owner answered — set explicitly, since they are no longer the defaults.
  P.save({ address: 'mix', name: 'Alex', pronouns: 'he/him', candid: true });
  const lines = P.promptLines();
  ok(lines.length >= 4, 'the prompt fragment carries his answered preferences');
  // It rides on EVERY turn, so size is the whole constraint — memory.json exists and is kept to two
  // facts for exactly this reason, and the prompt-compaction work was about the same budget.
  ok(lines.join(' ').length < 1200, 'and stays small enough to afford every turn (' + lines.join(' ').length + ' chars)');
  ok(/vary it/.test(lines.join(' ')), 'address preference is applied');
  ok(/side-comment|banter/.test(lines.join(' ')), 'manner preference is applied');
  ok(/one line for actions/.test(lines.join(' ')), 'adaptive reply length is applied');
  ok(/never be sugar-coated/.test(lines.join(' ')), 'an answered standing instruction survives');
  ok(P.honorify('Done, Sir.') === 'Done, Sir.', 'and "Sir" is kept when the owner chose it');
  // Biography must NOT be in the fragment — it belongs in retrieval, pulled only when relevant.
  ok(/rememberFact/.test(fs.readFileSync(path.join(__dirname, '..', 'profile.js'), 'utf8')),
    'long-tail facts are written to episodic memory instead');
  ok(!/recall\.log/.test(P.promptLines().join(' ')), 'and never inlined into the prompt');

  // He chose: signed-in pages readable, but offline model only.
  // Asserted as a PROPERTY, not as one exact spelling: forceLocal must appear in the condition that
  // zeroes the key, and the true-branch must be the empty string. The previous version pinned the
  // literal expression, so adding the exhaustion breaker and the cheap/hard tier to the same line
  // failed a privacy test whose guarantee was actually untouched — a test that cries wolf on a safe
  // edit is a test that gets edited away on an unsafe one.
  const orKeyLine = (ssrc.split('\n').find(l => l.includes('const orKey =')) || '');
  ok(/opts\.forceLocal/.test(orKeyLine) && /\?\s*''\s*:/.test(orKeyLine),
    'forceLocal skips the cloud branch outright, rather than asking the model to be discreet');
  ok(/hostedExhausted\(\)/.test(orKeyLine),
    'and an exhausted hosted key routes local without another round trip');
  ok(/forceLocal: isPrivate/.test(ssrc), 'and a signed-in page sets it');
  ok(/kept that on the local model/.test(ssrc), 'and he is told, so a quietly worse answer is not a surprise');
}

head('"tabs" means browser tabs, not running apps');
{
  // "what tabs do I have open" matched the running-apps rule and answered with a list of
  // applications — confident, fluent, and about a different question entirely.
  const T = eval('/' + ssrc.match(/const BROWSER_TABS_RE = \/(.+?)\/i;/)[1] + '/i');
  const P = eval('/' + ssrc.match(/const BROWSER_PAGE_RE = \/(.+?)\/i;/)[1] + '/i');
  for (const t of ['what tabs do i have open', 'list my tabs', 'how many tabs are open']) {
    ok(T.test(t), 'tabs lane: "' + t + '"');
  }
  for (const t of ['what is on this page', 'read me this page', 'summarise this tab']) {
    ok(P.test(t) && !T.test(t), 'page lane: "' + t + '"');
  }
  for (const t of ['what apps are running', 'list running apps', 'open youtube', 'what is on my calendar']) {
    ok(!T.test(t) && !P.test(t), 'not a browser question: "' + t + '"');
  }
  ok(/r\.data && r\.data\.fenced/.test(ssrc), 'the page summary is given the FENCED text, never the raw page');
}

head('stop: one control halts everything in flight');
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');

  ok(/if \(p === '\/api\/stop' && req\.method === 'POST'\)/.test(ssrc), 'there is a single stop endpoint');
  ok(/function stopEverything\(why\)/.test(ssrc), 'it halts centrally');
  ok(/controlAbort = true/.test(ssrc) && /deepresearch\.cancel\(\)/.test(ssrc),
    'and takes the pre-existing screen-control and deep-research stops with it');
  ok(/wordOffers = new Map\(\);\s*\/\/ a parked offer/.test(ssrc), 'a parked offer does not survive a stop');

  // A generation counter, not a boolean: each turn holds a token that a stop invalidates, so an
  // in-flight loop unwinds at its next checkpoint instead of running to completion.
  ok(/let runGen = 0/.test(ssrc) && /function isStopped\(token\)/.test(ssrc), 'stop uses a generation token');
  ok(/currentRun = newRun\(\)/.test(ssrc), 'every turn takes a fresh token');
  ok(/function clearStop\(\)/.test(ssrc) && /clearStop\(\);/.test(ssrc),
    'and a new request clears the last stop, so one stop does not mute everything after it');

  const ag = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  ok((ag.match(/deps\.stopped && deps\.stopped\(\)/g) || []).length >= 2,
    'both the agentic loop and runPlan check for a stop between steps');
  ok(/stopped: \(\) => isStopped\(currentRun\)/.test(ssrc), 'the agent is given the predicate');

  // The button must not be wired inside showControlBanner() — that function only runs when JARVIS
  // takes the screen, so the stop button did nothing until an unrelated feature happened to fire.
  ok(/document\.addEventListener\('DOMContentLoaded'[\s\S]{0,180}getElementById\('stopBtn'\)/.test(app),
    'the button is wired at load, not inside showControlBanner()');
  // Check the function BODY, not "text near the name" — the previous form matched the comment
  // above the wiring, which mentions showControlBanner precisely to explain why it is not there.
  const fnStart = app.indexOf('function showControlBanner');
  const fnBody = app.slice(fnStart, app.indexOf('\n}', fnStart));
  ok(!/stopBtn/.test(fnBody), 'and no longer lives in that function');
  ok(/if \(!document\.body\.classList\.contains\('jarvis-busy'\)\) return;/.test(app),
    'Esc only acts while something is running');
  ok(/\^\(INPUT\|TEXTAREA\)\$/.test(app), 'and never steals Esc from a field being typed in');
  ok(/body\.jarvis-busy #stopBtn \{ display: inline-flex; \}/.test(html), 'the button is hidden when idle');
  // Was: a literal speechSynthesis.cancel() inside stopEverything. That broke when the call moved
  // into stopSpeaking() — which does strictly MORE, silencing the piper WAV as well — while the
  // behaviour under test had not moved at all. Assert the property, and assert the part that now
  // matters most: there are TWO engines, and stopping only one leaves audio playing into the mic
  // that was just opened to hear him.
  ok(/stopSpeaking\(\)/.test(app.slice(app.indexOf('async function stopEverything'))),
    'stopping also silences JARVIS mid-sentence');
  const stopFn = app.slice(app.indexOf('function stopSpeaking'), app.indexOf('function speakViaBrowser'));
  ok(/speechSynthesis\.cancel\(\)/.test(stopFn), 'and that silences the browser voice');
  ok(/ttsAudio/.test(stopFn) && /\.pause\(\)/.test(stopFn), 'and the neural one too');
}

head('on-screen references go to the browser, never the app parser');
{
  // Live failure: "click on the first result" → "Booting Safari, sir." The normaliser, handed a
  // follow-up with no standalone meaning, invented a target — first "open webpage.com and click on
  // the first result", then "open webpage and …" — which fuzzy-matched to Safari, then Contacts.
  const PR = eval('/' + ssrc.match(/const PAGE_REF_RE = \/(.+?)\/i;/)[1] + '/i');
  const CL = eval('/' + ssrc.match(/const CLICKY_RE = \/(.+?)\/i;/)[1] + '/i');
  const toBrowser = t => PR.test(t) && CL.test(t);
  for (const t of ['click on the first result', 'click the first video', 'open that link',
                   'press the second one', 'click the last result']) {
    ok(toBrowser(t), 'browser lane: "' + t + '"');
  }
  for (const t of ['open youtube', 'message mama', 'what is the first law of thermodynamics',
                   'open the app store and search for chess', 'open my business website']) {
    ok(!toBrowser(t), 'NOT the browser lane: "' + t + '"');
  }
  // The lane must sit before the parser that was misfiring.
  const refAt = ssrc.indexOf('pageReference(cmdText) && CLICKY_RE.test(cmdText)');
  ok(refAt > 0 && refAt < ssrc.indexOf('DEEP RESEARCH. Ahead of'), 'and runs before the other lanes');
  ok(/ordinalOf|ORDINALS/.test(ssrc), 'the ordinal is resolved in code, not by asking the model to pick');

  // THE NORMALISER IS GONE, and so is the guard that existed because a rewrite could supply a target
  // he never named (inventedTarget). The reader's checker makes that impossible by construction:
  // every value in a reading must be copied from what he said.
  ok(!/\bnormalizeCommand\b|\binventedTarget\b/.test(ssrc), 'no model rewrite remains to be guarded');
  const RM = require('../readmodel.js');
  ok(RM.shapeError('click on the first result', { act: 'open', thing: 'webpage.com' }) !== null, 'an invented domain is refused');
  ok(RM.shapeError('play some music', { act: 'open', thing: 'spotify' }) !== null, 'an invented site name is refused');
  ok(RM.shapeError('read notes.txt on my desktop', { act: 'read', thing: '/Users/your_username/Desktop/notes.txt' }) !== null,
    'an invented home directory is refused');
  ok(RM.shapeError('read notes.txt on my desktop', { act: 'read', thing: 'notes.txt', where: 'my desktop' }) === null,
    'a faithful reading is kept');
}

head('runPlan resumes REGISTERED tools (confirm-gating was silently dead)');
{
  // runPlan looked tools up in TOOLS (16 built-ins) while runAgentLoop used allTools() (built-ins +
  // everything server.js registers). So every confirm-gated system tool — delete, move, close_app,
  // overwrite — died on resume: "unknown tool", break, and because no step had FAILED it still
  // returned ok:true and told the user "Done, Sir." while nothing had run.
  const asrc3 = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  const rp = asrc3.slice(asrc3.indexOf('async function runPlan'), asrc3.indexOf('async function runPlan') + 2800);
  ok(/const tools = allTools\(\);/.test(rp), 'runPlan resolves against allTools()');
  ok(/const fn = tools\[step\.tool\];/.test(rp), 'and looks the step up there');
  ok(!/const fn = TOOLS\[step\.tool\]/.test(rp), 'no longer uses the built-ins-only table');
  ok(/I could not run/.test(rp) && /ok: false/.test(rp),
    'an unknown tool now FAILS instead of reporting success for a plan that ran nothing');

  const A = require('../agent.js');
  A.init({ llm: async () => ({ text: '' }), jlog: () => {}, lean: () => true, envVal: () => '' });
  let ran = false;
  A.registerSystemTools({ _probe: async () => { ran = true; return { ok: true, say: 'ran' }; } }, {});
  await A.runPlan({ kind: 'test', steps: [{ tool: '_probe', args: {} }] }, {});
  ok(ran, 'a registered system tool actually executes through runPlan');
  const bad = await A.runPlan({ kind: 'test', steps: [{ tool: '_nope', args: {} }] }, {});
  ok(bad.ok === false, 'and a genuinely missing tool reports failure');
}

head('open_url accepts a bare domain (const-assignment regression)');
{
  const scsrc = fs.readFileSync(path.join(__dirname, '..', 'system_control.js'), 'utf8');
  // `const u` + a later `u = 'https://' + u` threw TypeError on exactly the case it was added for.
  // quickAction pre-normalises, so only the agentic loop reached the throw.
  ok(/let u = String\(a\.url \|\| a\.target/.test(scsrc), 'open_url uses let, so the scheme fill-in can assign');
  ok(!/const u = String\(a\.url \|\| a\.target/.test(scsrc), 'and is no longer a const');
}

head('lane ordering: specific patterns win');
// Regression: "what did you do while I was away" matches BOTH dream's precise pattern and
// recall's broad "what did you do". Recall was checked first and answered from the episode
// journal — a plausible-sounding answer to a question with an exact one. Order encodes priority.
// Dream mode is asked of dreamintent.js since 2026-09-18 (DREAM_RE is gone); that it reads "what did
// you do while I was away" as the dream log is measured in test_dreamintent.js, which has the embedder.
const dreamAt = ssrc.indexOf('dreamintent.dreamIntentOf(cmdText)');
const recallAt = ssrc.indexOf('recall.RECALL_RE.test(cmdText)');
ok(dreamAt > 0 && recallAt > 0, 'both lanes exist');
ok(dreamAt < recallAt, 'dream mode is checked BEFORE recall');
ok(require('../dreamintent').namedTool('show me the dream log') === 'dream_log', 'the dream log is found by its own tool name');
ok(recall.RECALL_RE.test('what did you do while I was away'), 'recall would also match it (hence the ordering)');
{
  // On or off is never read out of words: without a real true/false, dream_set changes nothing.
  const dm = require('../dream');
  const before = dm.isEnabled();
  const r = dm.TOOLS.dream_set({ text: 'dream mode band kar do' });
  ok(r.ok === false && dm.isEnabled() === before, 'dream_set with only words changes nothing (' + r.say + ')');
}

head('recall regex does not steal ordinary questions');
for (const s of ['what did I say about the icon', 'when did we set up composio', 'do you remember the swiggy bug']) {
  ok(recall.RECALL_RE.test(s), 'recall: "' + s + '"');
}
for (const s of ['what is the weather in shimla', 'open youtube', 'what should I delete', 'how do I create a folder']) {
  ok(!recall.RECALL_RE.test(s), 'NOT recall: "' + s + '"');
}

head('tutor/timemachine regexes stay in their lane');
// TUTOR_RE is gone (2026-09-19): the reader reads the tutor — see test_readmodel.js and finetune's tutor_heldout.
ok(!('TUTOR_RE' in tutor), 'the tutor no longer exports a word list');
for (const s of ['put everything back to how it was at 3pm', 'what was open an hour ago', 'restore my session']) {
  ok(timemachine.TM_RE.test(s), 'timemachine: "' + s + '"');
}
for (const s of ['open safari', 'what did I say about X']) ok(!timemachine.TM_RE.test(s), 'NOT timemachine: "' + s + '"');

head('harness: a named thing that was never created is not "done"');
{
  const H = require('../harness.js');
  const GOAL = 'create three files in jarvis_eval on my desktop: a.txt saying alpha, ' +
               'b.txt saying beta, c.txt saying gamma';

  eqj(H.namedArtifacts(GOAL), ['a.txt', 'b.txt', 'c.txt'], 'the goal names three files, by name');

  // THE EXACT FAILURE, REPRODUCED. Observed live and twice in the eval: the loop made the folder,
  // then a.txt, then c.txt — three successful side-effecting calls against expectedParts of 3 — and
  // every count-based guard agreed the job was finished while b.txt did not exist. The reply said
  // "I checked all 4 of them". Counting cannot catch this; only the names can.
  const steps = [
    { tool: 'create_folder', args: { path: '~/Desktop/jarvis_eval' } },
    { tool: 'create_file', args: { path: '~/Desktop/jarvis_eval/a.txt', content: 'alpha' } },
    { tool: 'create_file', args: { path: '~/Desktop/jarvis_eval/c.txt', content: 'gamma' } },
  ];
  const allOk = [{ ok: true }, { ok: true }, { ok: true }];
  eqj(H.missingArtifacts(GOAL, steps, allOk), ['b.txt'],
    'the middle file is named as missing, though three steps all succeeded');
  eq(H.expectedParts(GOAL) <= steps.length, true,
    'and the count-based yardstick alone would have called this complete');

  const withB = steps.concat([{ tool: 'create_file', args: { path: '~/Desktop/jarvis_eval/b.txt', content: 'beta' } }]);
  eqj(H.missingArtifacts(GOAL, withB, allOk.concat([{ ok: true }])), [],
    'nothing outstanding once every named file exists');

  // A step that ERRORED did not create anything. Counting the attempt is how the claim slipped
  // through in the first place.
  eqj(H.missingArtifacts(GOAL, steps, [{ ok: true }, { ok: true }, { ok: false }]), ['b.txt', 'c.txt'],
    'a failed create counts as not created');

  // It must stay quiet where it cannot know better. One filename is not a list, a goal with no
  // filenames is none of its business, and version numbers are not files.
  eqj(H.missingArtifacts('read notes.txt', [], []), [], 'a single named file is left to the count guards');
  eqj(H.missingArtifacts('order me dominos pizza from swiggy', [], []), [], 'no filenames, no opinion');
  eqj(H.namedArtifacts('upgrade to 3.5 and 4.2'), [], 'version numbers are not artifacts');

  // WIRED, not merely exported. The check is worthless if the loop never consults it — a lane that
  // cannot be reached is not a fix, which this session learned the expensive way.
  const ag = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  ok(/missingArtifacts\(goal, steps, results\)/.test(ag), 'agent.js actually calls it');
  const doneBranch = ag.slice(ag.indexOf("step.tool === 'done'"), ag.indexOf("step.tool === 'fail'"));
  ok(/missingArtifacts/.test(doneBranch), 'and consults it before accepting a "done"');
  ok(doneBranch.indexOf('missingArtifacts') < doneBranch.indexOf('prematureDone'),
    'ahead of the step-count guard, which cannot see a missing name');
  const shortBranch = ag.slice(ag.indexOf('function stoppedShort'), ag.indexOf('function stoppedShort') + 900);
  ok(/missingArtifacts/.test(shortBranch), 'and stoppedShort() reports the shortfall honestly');
}

head('harness: failure policy');
{
  const H = require('../harness.js');
  // A refusal or a permission denial will never succeed however the arguments are shuffled.
  // Retrying a SAFETY stop is the specific behaviour that must not exist.
  for (const s of ['I refuse — that is a password field', 'Accessibility permission denied',
                   'Blocked, sir. That is a protected path', 'That is a sensitive page',
                   'no such tool', 'needs approval first', 'Not configured — no API key']) {
    eq(H.classify({ ok: false, say: s }), 'terminal', 'terminal: "' + s.slice(0, 38) + '"');
  }
  for (const s of ['Unknown app "Spotifyy" — not found', 'Spotify is not running',
                   'The request timed out', 'No results for that']) {
    eq(H.classify({ ok: false, say: s }), 'retryable', 'retryable: "' + s.slice(0, 38) + '"');
  }
  eq(H.classify({ ok: true, say: 'Opened Spotify' }), 'ok', 'success is not a failure');
  // An unrecognised failure is retryable — refusing to retry anything unpatterned would make the
  // harness give up on the ordinary case of a tool failing for a novel reason. The retry budget
  // is what bounds the cost.
  eq(H.classify({ ok: false, say: 'weird internal wobble' }), 'retryable', 'unknown failures get a bounded retry');
  eq(H.classify({ ok: false, say: 'What should the message to Harsimran say, Sir?', data: { asked: true } }), 'asked',
    'a tool that asked him a question is "asked" (its flag), not a retryable failure');
  {
    const run = { steps: [{ tool: 'find_contact' }, { tool: 'compose' }], results: [{ ok: true, say: 'Found Harsimran.' },
      { ok: false, say: 'What should the message to Harsimran say, Sir?', data: { asked: true } }] };
    const v = H.verdict(run, 'asked');
    eqj([v.ok, v.asked, v.say], [false, true, 'What should the message to Harsimran say, Sir?'], 'a run that asked ends on the question itself');
  }

  ok(/Do NOT try it again/.test(H.recoveryHint({ tool: 't' }, { say: 'denied' }, 'terminal')),
    'a terminal failure tells the model plainly not to retry');
  ok(/change the arguments/.test(H.recoveryHint({ tool: 't' }, { say: 'not found' }, 'retryable')),
    'a retryable failure tells it to vary the attempt, not repeat it');
}

head('harness: budgets');
{
  const H = require('../harness.js');
  const r = H.newRun('g', { now: 0, budgetMs: 1000, maxSteps: 2, maxRetries: 1 });
  eq(H.exhausted(r, 0), null, 'a fresh run may proceed');
  eq(H.exhausted(r, 1001), 'time', 'the wall clock is enforced, not just the step count');
  r.steps.push({}, {});
  eq(H.exhausted(r, 0), 'steps', 'the step ceiling is enforced');
  const r2 = H.newRun('g', { now: 0, maxRetries: 1 });
  r2.retries = 2;
  eq(H.exhausted(r2, 0), 'retries', 'the retry budget is enforced');
  // Passing an option the caller never set must not wipe the default.
  eq(H.newRun('g', { maxRetries: undefined }).limits.maxRetries, H.DEFAULTS.maxRetries,
    'an explicit undefined does not clobber a default (this logged "retry 1/undefined")');
}

head('harness: the verdict never contradicts itself');
{
  const H = require('../harness.js');
  const mk = () => {
    const r = H.newRun('g', { now: 1000 });
    r.push = (ok, say) => { const s = { tool: 't', args: {} }; r.steps.push(s); const res = { ok, say }; r.results.push(res); H.record(r, s, res); };
    return r;
  };
  let r = mk(); r.push(true, 'Opened Spotify'); r.push(false, 'Spotify is not running');
  let v = H.verdict(r, null);
  ok(!v.ok, 'a run whose last step failed is NOT a success');
  // The old code quoted the last result blindly and produced a failure sentence flagged ok:true.
  ok(/Opened Spotify/.test(v.say), 'the narrative comes from what actually succeeded');

  r = mk(); r.push(true, 'Did it');
  ok(H.verdict(r, null).ok, 'a clean run is a success');
  ok(!H.verdict(r, 'time').ok && /ran out of time/.test(H.verdict(r, 'time').say), 'a budget stop is reported as partial, never as done');
  ok(!H.verdict(r, 'steps').ok && /step limit/.test(H.verdict(r, 'steps').say), 'so is a step-limit stop');
  ok(!H.verdict(mk(), null).ok, 'a run where nothing executed is not a success');
  ok(/Stopped/.test(H.verdict(mk(), 'stopped').say), 'a user stop says so');

  r = mk(); r.push(true, 'Created the file'); r.verified = true; r.verifiedHow = 'read the file back';
  ok(/read the file back/.test(H.verdict(r, null).say), 'confirmation is stated when it happened');
  r.verified = false;
  ok(/could not confirm/.test(H.verdict(r, null).say), 'and the lack of it is stated too — never assumed');
  r.verified = null;
  ok(!/confirm/.test(H.verdict(r, null).say), 'nothing is claimed about unverifiable work');

  // Punctuation: two clauses must not run together, and a bracketed clause must not get a second stop.
  r = mk(); r.push(false, 'Nope'); r.push(true, 'Worked around it');
  ok(!/\.\)\./.test(H.verdict(r, null).say), 'no doubled full stop after a bracketed clause');
}

head('harness: verification is a real read-back, not a restatement');
{
  const H = require('../harness.js');
  const run = H.newRun('g');
  const step = { tool: 'create_file', args: { path: '/tmp/x.txt', content: 'hello' } };
  run.steps.push(step); run.results.push({ ok: true, say: 'Created /tmp/x.txt.' });
  const plan = H.verificationFor(run);
  eq(plan.tool, 'read', 'a file write is checked by reading the file');
  eq(plan.match({ ok: true, data: 'hello' }), true, 'content present ⇒ confirmed');
  eq(plan.match({ ok: false, say: 'Couldn’t read that' }), false, 'unreadable ⇒ NOT confirmed');
  // The case this exists for: a tool that returns ok having done nothing at all.
  eq(plan.match({ ok: true, data: '' }), false, 'a tool that claims success but wrote nothing is caught');

  const nav = H.VERIFIERS.browser_go({ args: { url: 'https://en.wikipedia.org/wiki/Cat' } });
  eq(nav.match({ ok: true, data: { url: 'https://en.wikipedia.org/wiki/Cat' } }), true, 'landing on the right host ⇒ confirmed');
  eq(nav.match({ ok: true, data: { url: 'https://accounts.google.com/signin' } }), false, 'a redirect elsewhere is caught');
  eq(H.VERIFIERS.browser_go({ args: { url: 'back' } }).match({ ok: true, data: {} }), null, 'back/forward has nothing to match — no claim made');

  // Anything without a genuine read-back must report NO verification rather than inventing one.
  const r2 = H.newRun('g');
  r2.steps.push({ tool: 'add_reminder', args: { text: 'x' } });
  r2.results.push({ ok: true, say: 'Added.' });
  eq(H.verificationFor(r2), null, 'a tool with no read-back is honestly unverifiable');
}

head('harness: bugs found by running it against the real machine');
{
  const H = require('../harness.js');
  const asrc = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  const ssrc2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sysrc = fs.readFileSync(path.join(__dirname, '..', 'system_control.js'), 'utf8');

  // 1. A path in the transcript is an IDENTIFIER the model reuses verbatim. Clipping one to
  //    ".../note…" produced a file on disk literally named "note…".
  const run = H.newRun('g');
  const long = '/Users/atharv/Desktop/harness_demo/notes.txt';
  const step = { tool: 'create_file', args: { path: long, content: 'hello' } };
  run.steps.push(step); run.results.push({ ok: true, say: 'Created' });
  H.record(run, step, { ok: true, say: 'Created' });
  ok(H.transcript(run)[0].includes(long), 'a path survives the transcript intact, never clipped mid-value');
  const run2 = H.newRun('g');
  const s2 = { tool: 'compose', args: { body: 'x'.repeat(400) } };
  run2.steps.push(s2); run2.results.push({ ok: true, say: 'ok' });
  H.record(run2, s2, { ok: true, say: 'ok' });
  ok(H.transcript(run2)[0].length < 200, 'but ordinary prose is still clipped');

  // 2. Filesystem writes and app closing were absent from the drift guard's list.
  for (const t of ['create_file', 'create_folder', 'append', 'delete', 'move', 'close_app']) {
    ok(new RegExp("'" + t + "'").test(asrc.split('SIDE_EFFECT_TOOLS')[1].slice(0, 600)),
      t + ' counts as a side effect for the drift guard');
  }

  // 3. A WRONG single-action match must not block the agentic route. Testing quickAction for mere
  //    truthiness let "make a folder X and put a file in it" create a FILE named "folder X",
  //    silently drop the second half, and report success.
  ok(/isCompoundCommand\(cmdText\) && weakAction\(/.test(ssrc2),
    'the compound route asks weakAction, not just whether quickAction returned anything');
  ok(/create_folder\|create_file\|make_app/.test(ssrc2),
    'and a create whose target still holds a clause separator counts as weak');
  // Checked behaviourally rather than by grepping the source for an escaped regex — the previous
  // version of this line was so convoluted it would have passed whether or not the fix was there.
  {
    const m = ssrc2.match(/const parts = s\.split\((\/[^\n]+?\/i)\)/);
    ok(!!m, 'isCompoundCommand still splits on a regex');
    const sep = m && eval(m[1]);
    ok(sep && 'create folder X on desktop; create file Y'.split(sep).length === 2,
      'compound detection splits on the semicolons the normaliser emits');
    ok(sep && 'make a folder and put a file in it'.split(sep).length === 2,
      'and still splits on "and"');
  }

  // 4. close_app promised "asks first" and runAction gated it, but the agentic loop called the tool
  //    directly and bypassed that — closing an unrelated app with no prompt.
  ok(/A plain quit asks too/.test(sysrc), 'a plain quit confirms on every path, not just via runAction');
}

head('harness: the transcript stays small on a long run');
{
  const H = require('../harness.js');
  const run = H.newRun('g', { transcriptMax: 3 });
  for (let i = 0; i < 10; i++) {
    const s = { tool: 'ping', args: { n: i } };
    run.steps.push(s); const res = { ok: i % 2 === 0, say: 'x'.repeat(500) };
    run.results.push(res); H.record(run, s, res);
  }
  const t = H.transcript(run);
  eq(t.length, 4, 'older steps collapse to a single summary line');
  ok(/7 earlier steps/.test(t[0]), 'and the summary says how many and how they went');
  ok(t.every(l => l.length < 200), 'no observation blows the context budget on a 3B');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('THREW: ' + (e && e.stack || e)); process.exit(1); });
