'use strict';
// ---------------------------------------------------------------------------
// JARVIS macro-by-observation — "watch what I do", then "call that morning setup".
//
// WHAT THIS DELIBERATELY DOES NOT DO: capture keystrokes. JarvisControl holds the
// Accessibility grant, so a CGEvent tap recording every key you press is
// technically available — and it is a keylogger. Raw click coordinates are also
// brittle: replaying (847, 322) breaks the moment a window moves. Neither is worth
// having, so neither is here.
//
// What it records instead is the shape of what you did, from two sources that are
// both safe and both actually replayable:
//   · which apps you brought to the front, in order (polled, no event tap)
//   · which commands you gave JARVIS while recording (it already has these)
//
// That covers the real case — "open these four things and put me in the right one"
// — without touching a single keystroke.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let deps = { jlog: () => {}, audit: () => {}, stateDir: null, saveMacro: null };
function init(d) { deps = Object.assign(deps, d || {}); }

const FILE = () => path.join(deps.stateDir || '/tmp', 'observe.json');
const POLL = 2000;              // fast enough to catch a deliberate app switch
const MAX_MINUTES = 30;         // a recording left running forever is a bug, not a feature
const MIN_DWELL = 2500;         // ignore apps you flicked through on the way somewhere

const sh = (cmd, args, timeout) => new Promise(resolve => {
  execFile(cmd, args, { timeout: timeout || 8000, maxBuffer: 1 << 20 }, (e, out) => resolve(String(out || '')));
});

const JXA_FRONT = `function run(){
  try { return Application('System Events').applicationProcesses.whose({ frontmost: true })()[0].name(); }
  catch(e) { return ''; }
}`;

async function frontApp() {
  const out = await sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_FRONT], 8000);
  return String(out || '').trim();
}

let rec = null;                 // { started, apps: [], commands: [], timer }
let lastSeen = { app: null, at: 0 };

function loadLast() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { return null; }
}
function saveLast(r) { try { fs.writeFileSync(FILE(), JSON.stringify(r, null, 2)); } catch (e) {} }

async function poll() {
  if (!rec) return;
  if (Date.now() - rec.started > MAX_MINUTES * 60000) { stop(); return; }
  let app = '';
  try { app = await frontApp(); } catch (e) { return; }
  if (!app || app === 'JARVIS OS' || app === 'Jarvis') return;   // ignore JARVIS's own window
  const now = Date.now();
  if (app !== lastSeen.app) { lastSeen = { app, at: now }; return; }
  // Same app for MIN_DWELL → you meant to be there.
  if (now - lastSeen.at < MIN_DWELL) return;
  if (rec.apps[rec.apps.length - 1] === app) return;
  if (rec.apps.includes(app)) return;                            // first visit only; order is what matters
  rec.apps.push(app);
  deps.jlog('Observe › noted ' + app);
}

// ---------------- control ----------------
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = say => ({ ok: false, say });

function start() {
  if (rec) return ok('Already watching, Sir — say “call that <name>” when you are done.');
  rec = { started: Date.now(), apps: [], commands: [], timer: null };
  lastSeen = { app: null, at: 0 };
  rec.timer = setInterval(() => poll().catch(() => {}), POLL);
  if (rec.timer.unref) rec.timer.unref();
  deps.jlog('Observe › recording started');
  return ok('Watching, Sir. Do it once and I will follow — which apps you open, and anything you ask me to do. ' +
    'Say “call that <name>” when you are finished. I am not recording keystrokes.');
}

function stop() {
  if (!rec) return null;
  clearInterval(rec.timer);
  const out = { started: rec.started, ended: Date.now(), apps: rec.apps.slice(), commands: rec.commands.slice() };
  rec = null;
  saveLast(out);
  deps.jlog('Observe › recording stopped (' + out.apps.length + ' apps, ' + out.commands.length + ' commands)');
  return out;
}

// server.js calls this for every command issued while a recording is live.
function noteCommand(text, plan) {
  if (!rec) return;
  const t = String(text || '').trim();
  // The commands that DRIVE the recording are not part of it. "watch what I do" is logged by the
  // wrapper after the recording has already started, so without this the first step of every
  // observed macro is the instruction to start observing.
  if (!t || WATCH_START_RE.test(t) || WATCH_NAME_RE.test(t) || WATCH_STOP_RE.test(t) || WATCH_STATUS_RE.test(t)) return;
  rec.commands.push({ at: Date.now(), text: t.slice(0, 200), steps: (plan && Array.isArray(plan.steps)) ? plan.steps : null });
}

function recording() { return !!rec; }

function status() {
  if (!rec) {
    const last = loadLast();
    if (!last) return ok('Not watching, Sir. Say “watch what I do” to start.');
    return ok('Not watching, Sir. The last recording had ' + last.apps.length + ' apps and ' + last.commands.length + ' commands — say “call that <name>” to keep it.');
  }
  const mins = Math.round((Date.now() - rec.started) / 60000);
  return ok('Watching, Sir — ' + mins + ' min so far. ' +
    (rec.apps.length ? 'Apps: ' + rec.apps.join(' → ') + '. ' : 'No app switches yet. ') +
    (rec.commands.length ? rec.commands.length + ' command' + (rec.commands.length === 1 ? '' : 's') + ' noted.' : ''));
}

// "call that morning setup" — turn whatever was observed into a real macro.
function nameIt(args) {
  const name = String(args.name || args.text || '').trim().replace(/^["“]|["”]$/g, '');
  if (!name) return fail('Call it what, Sir?');
  const r = rec ? stop() : loadLast();
  if (!r) return fail('I have not been watching, Sir — say “watch what I do” first.');
  if (!r.apps.length && !r.commands.length) return fail('I did not see anything to save, Sir.');

  // App switches become open_app steps; recorded commands contribute their real plans
  // where they had one, so a macro replays the same vetted steps rather than re-planning.
  const steps = r.apps.map(a => ({ tool: 'open_app', args: { name: a } }));
  for (const c of r.commands) if (c.steps) steps.push(...c.steps);
  if (!steps.length) return fail('Nothing in that recording is replayable, Sir.');

  if (!deps.saveMacro) return fail('The macro store is not wired up, Sir.');
  const res = deps.saveMacro(name, { kind: 'observed', steps }, 'observed: ' + r.apps.join(', '));
  if (!res.ok) return fail(res.say);
  // Consume the recording. Without this, "call that X" then "call that Y" would silently save the
  // same steps twice under two names — the second one looking like it captured something new.
  saveLast(null);
  deps.audit('observe_save', { name, steps: steps.length }, 'ok');
  return ok('Saved “' + name + '”, Sir — ' + steps.length + ' step' + (steps.length === 1 ? '' : 's') +
    (r.apps.length ? ' (' + r.apps.join(' → ') + ')' : '') + '. Say “run ' + name + '” any time.');
}

function cancel() {
  if (!rec) return fail('Not watching, Sir.');
  stop();
  saveLast(null);
  return ok('Stopped watching and dropped it, Sir.');
}

const TOOLS = {
  watch_me: () => start(),
  save_observed: nameIt,
  observe_status: () => status(),
  stop_watching: () => cancel(),
};
const TOOL_HELP = {
  watch_me: 'watch_me{}. Start observing which apps the user opens so it can be saved as a macro.',
  save_observed: 'save_observed{name}. Turn what was just observed into a named, replayable macro.',
  observe_status: 'observe_status{}. Whether a recording is running and what it has captured.',
  stop_watching: 'stop_watching{}. Stop and discard the recording.',
};

const WATCH_START_RE = /\b(?:watch (?:what|me|how) i(?:'| a)?m? ?(?:do|doing)?|watch what i do|learn (?:this|what i(?:'|’)?m doing)|record (?:what i do|this|my steps)|observe me)\b/i;
// "remember" belongs here. It is the verb people actually reach for, and without it "remember that
// as morning setup" missed this lane and fell through to the remember-a-FACT lane, which dutifully
// stored the fact "as morning setup" and saved no macro at all. macros.json was still {} after
// several attempts. The naming lane is already gated on a recording being in progress, so a plain
// "remember that I like mountains" outside a recording is untouched by this.
// "remember" requires an explicit "as". call/name/save that <name> is unambiguous, but "remember
// that I like mountains" is a FACT and only "remember that as <name>" is a naming. Without the
// stricter branch, stating a fact mid-recording would have been filed as a macro name.
const WATCH_NAME_RE = /^(?:can you |please )?(?:(?:call|name|save) (?:that|this|it)\s+(?:as\s+)?|remember (?:that|this|it)\s+as\s+)["“]?(.+?)["”]?$/i;
const WATCH_STOP_RE = /\b(?:stop watching|stop recording|forget what you saw|cancel the recording)\b/i;
const WATCH_STATUS_RE = /\b(?:what are you watching|are you (?:still )?watching|recording status)\b/i;

module.exports = {
  init, TOOLS, TOOL_HELP, start, stop, nameIt, status, cancel, noteCommand, recording,
  WATCH_START_RE, WATCH_NAME_RE, WATCH_STOP_RE, WATCH_STATUS_RE,
};
