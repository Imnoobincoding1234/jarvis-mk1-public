'use strict';
/* JARVIS voice — neural TTS through a warm Piper process.
 *
 * WHY THIS EXISTS. The browser's Web Speech API can only reach the voices macOS
 * ships, and the best male en-GB one is Daniel: a compact, concatenative voice
 * from 2010. rate and pitch were already tuned against it; there was nothing
 * left to gain. Piper is a local neural synthesiser — no key, no cloud, nothing
 * to silently stop working the way the DuckDuckGo scraper did.
 *
 * WHY IT IS A SERVER ENDPOINT AND NOT BROWSER CODE. He reaches JARVIS from his
 * phone over the tailnet. Anything built on macOS `say` would play out of the
 * Mac's speakers while he is in another room holding the device he asked from.
 * Synthesising here and sending the audio to whoever asked works for both.
 *
 * ZERO DEPENDENCIES HOLDS. Node spawns a binary and talks JSON lines over a
 * pipe, exactly as it already does for say, osascript and ollama. Nothing was
 * added to this process; piper lives in its own venv outside the repo.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

let deps = { jlog: () => {}, envVal: () => '' };
function init(d) { deps = Object.assign(deps, d || {}); }

const HOME = os.homedir();
const DEFAULT_ROOT = path.join(HOME, '.local', 'share', 'piper-jarvis');
const DAEMON = path.join(__dirname, 'tts', 'piper_daemon.py');

// Every one of these is overridable in .env, because a voice is taste and his
// taste is the only vote that counts. Defaults are what he picked by ear.
function cfg() {
  const root = deps.envVal('JARVIS_PIPER_ROOT') || DEFAULT_ROOT;
  const model = deps.envVal('JARVIS_TTS_MODEL') || 'en_GB-semaine-medium';
  return {
    python: deps.envVal('JARVIS_PIPER_PYTHON') || path.join(root, 'venv', 'bin', 'python'),
    model: path.join(deps.envVal('JARVIS_PIPER_VOICES') || path.join(root, 'voices'), model + '.onnx'),
    speaker: deps.envVal('JARVIS_TTS_SPEAKER') || '2',        // obadiah, in en_GB-semaine
    lengthScale: deps.envVal('JARVIS_TTS_LENGTH_SCALE') || '1.1',
    enabled: (deps.envVal('JARVIS_TTS') || 'piper').toLowerCase(),
  };
}

// Whether this machine can synthesise at all. Checked before the endpoint is
// advertised so the browser knows to keep using Web Speech rather than waiting
// on a request that was always going to fail.
function available() {
  const c = cfg();
  if (c.enabled === 'off' || c.enabled === 'browser') return false;
  try { return fs.existsSync(c.python) && fs.existsSync(c.model) && fs.existsSync(DAEMON); }
  catch (e) { return false; }
}

let child = null;          // the warm process, or null
let ready = false;         // model loaded and announced
let queue = [];            // [{ text, resolve, reject, timer }] — one in flight at a time
let inflight = null;
let starting = null;       // Promise, so twenty simultaneous replies start ONE process

const SYNTH_TIMEOUT_MS = 20000;   // a spoken line is seconds of audio; this is a hang, not a slow day
// SIXTY SECONDS, DOWN FROM TEN MINUTES.
//
// The old window was set against a load cost this daemon no longer really pays. The page calls
// /api/speak/warm the moment the microphone opens (app.js), so on the voice path the model loads
// behind his own sentence and is resident before there is anything to say — the timeout cannot be
// felt there however short it is. What the ten minutes actually bought was the TYPED path, where no
// mic opens and a spoken reply loads the model in the silence after the answer is ready.
//
// Measured, so the trade is known rather than guessed: load is ~1.0s in isolation and 1.4-2.2s in
// the log's real starts, and the resident cost is 219 MB settled, 387 MB while synthesising, on an
// 8 GB machine that also holds 2.4 GB of chat model.
//
// The case that prompted this: he woke JARVIS, gave it a command, then closed the window before the
// reply played. Nothing tells this file the page went away — armIdleExit is driven by synthesis
// finishing and nothing else — so a 73 MB model sat warm for ten minutes for a sentence nobody
// heard. Sixty seconds is short enough that a closed window costs almost nothing and long enough
// that a real back-and-forth never reloads mid-conversation.
//
// NOT five seconds, which was the other option considered. Two reasons it does not work: a follow-up
// question asked six seconds later would reload, and "five seconds after it finishes SPEAKING" needs
// a signal that only exists for wake-word turns — app.js guards notifySpeaking on `selfWake`, so a
// typed reply never reports finishing and the timer would never fire for it. Idle time since the
// last synthesis is a signal every path produces.
const IDLE_EXIT_MS = 60 * 1000;
let idleTimer = null;

function armIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!inflight && !queue.length) stop('idle'); }, IDLE_EXIT_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function stop(why) {
  if (!child) return;
  deps.jlog('Voice › piper stopped (' + why + ')');
  try { child.kill(); } catch (e) {}
  child = null; ready = false; starting = null;
}

function start() {
  if (starting) return starting;
  if (child && ready) return Promise.resolve();
  const c = cfg();
  starting = new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; err ? reject(err) : resolve(); } };
    let proc;
    try {
      proc = spawn(c.python, [DAEMON], {
        env: Object.assign({}, process.env, {
          PIPER_MODEL: c.model, PIPER_SPEAKER: String(c.speaker),
          PIPER_LENGTH_SCALE: String(c.lengthScale),
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { starting = null; return done(e); }
    child = proc;

    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.ready === true) {
          ready = true;
          deps.jlog('Voice › piper ready — ' + msg.voice + ' speaker ' + msg.speaker +
                    ' at ' + msg.length_scale + 'x in ' + msg.ms + 'ms');
          done(null);
        } else if (msg.ready === false) {
          deps.jlog('Voice › piper failed to start: ' + msg.error);
          stop('start failed');
          done(new Error(msg.error || 'piper failed to start'));
        } else if (inflight) {
          // A reply belongs to whatever is in flight; the protocol is strictly
          // one at a time so there is no id to match and nothing to mismatch.
          const job = inflight; inflight = null;
          clearTimeout(job.timer);
          if (msg.ok) job.resolve(); else job.reject(new Error(msg.error || 'synthesis failed'));
          pump();
        }
      }
    });
    // stderr is onnxruntime's warnings, not ours. Logged only when it looks like a failure.
    proc.stderr.on('data', d => {
      const s = d.toString().trim();
      if (/error|Traceback|failed/i.test(s)) deps.jlog('Voice › piper stderr: ' + s.slice(0, 200));
    });
    proc.on('exit', code => {
      const wasReady = ready;
      child = null; ready = false; starting = null;
      if (inflight) { const j = inflight; inflight = null; clearTimeout(j.timer); j.reject(new Error('piper exited')); }
      for (const j of queue.splice(0)) { clearTimeout(j.timer); j.reject(new Error('piper exited')); }
      if (wasReady && code) deps.jlog('Voice › piper exited with code ' + code);
      done(new Error('piper exited before ready'));
    });
    proc.on('error', e => { starting = null; deps.jlog('Voice › piper spawn error: ' + e.message); done(e); });
  });
  return starting;
}

function pump() {
  if (inflight || !queue.length || !child || !ready) return;
  const job = queue.shift();
  inflight = job;
  job.timer = setTimeout(() => {
    // A hung synthesis holds the only pipe there is, so the process goes rather
    // than the queue backing up behind it forever.
    if (inflight === job) { inflight = null; job.reject(new Error('synthesis timed out')); stop('timeout'); }
  }, SYNTH_TIMEOUT_MS);
  try { child.stdin.write(JSON.stringify({ text: job.text, out: job.out }) + '\n'); }
  catch (e) { inflight = null; clearTimeout(job.timer); job.reject(e); }
}

// Markdown reaches the speaker as punctuation the synthesiser tries to pronounce.
// The browser stripped these before handing text to Web Speech; the same has to
// happen here or the voice reads his asterisks out loud.
function speakable(text) {
  return String(text || '')
    .replace(/[*_`#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);           // a spoken reply, not an essay
}

// Returns a WAV Buffer. Rejects if piper is unavailable or the line fails —
// the caller falls back to the browser's own voice rather than going silent.
async function synth(text) {
  const line = speakable(text);
  if (!line) throw new Error('nothing to say');
  if (!available()) throw new Error('piper not available');
  await start();
  const out = path.join(os.tmpdir(), 'jarvis-tts-' + crypto.randomUUID() + '.wav');
  try {
    await new Promise((resolve, reject) => {
      queue.push({ text: line, out, resolve, reject, timer: null });
      pump();
    });
    const buf = fs.readFileSync(out);
    armIdleExit();
    return buf;
  } finally {
    try { fs.unlinkSync(out); } catch (e) {}
  }
}

// Load the model WITHOUT synthesising anything, so the cost is paid while he is
// still talking rather than in the silence after JARVIS has finished thinking.
// Called when the mic opens: a spoken question is about to want a spoken answer.
// Safe to call repeatedly — start() collapses concurrent callers into one spawn.
async function warm() {
  if (!available()) return false;
  try { await start(); armIdleExit(); return true; }
  catch (e) { return false; }
}

module.exports = { init, available, synth, speakable, stop, warm, cfg };
