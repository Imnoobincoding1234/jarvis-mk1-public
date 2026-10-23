/* JARVIS OS — frontend logic */
'use strict';
// Attach the per-install API token (embedded in this page's HTML by the server) to every
// same-origin /api request, so the backend's anti-CSRF/anti-hijack gate accepts our calls.
// Wrapping fetch itself guarantees coverage of both the api() helper and any direct fetch().
(function () {
  const _fetch = window.fetch.bind(window);
  const TOKEN = window.__JARVIS_TOKEN__ || '';
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (TOKEN && (url.startsWith('/api') || url.startsWith(location.origin + '/api'))) {
        init = Object.assign({}, init);
        init.headers = Object.assign({}, init.headers, { 'x-jarvis-token': TOKEN });
      }
    } catch (e) {}
    return _fetch(input, init);
  };
})();
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const state = {
  view: 'voice',
  convo: JSON.parse(localStorage.getItem('jarvis.convo') || '[]'),
  visionConvo: [],
  orb: 'idle',
  listening: false,
  busy: false,
  filesPath: '.',
  // Whether the server has a local neural voice. Starts false so the very first spoken line uses
  // Web Speech rather than waiting out a request that may 503 — the poll flips it within seconds.
  tts: false,
  focusOn: false,
  seenNotifs: new Set(JSON.parse(localStorage.getItem('jarvis.seenNotifs') || '[]')),
  streams: { a: null, b: null },
  pendingScreen: null,   // { question, selfMeta, displays } — set while JARVIS is waiting for "which screen?"
  pendingConfirm: null,  // { type, target } — set while JARVIS is waiting to confirm a close-app action
  silenceTimer: null,    // closes a mic that JARVIS opened itself, if no answer comes
  autoOpened: false,     // true while the mic is open because JARVIS asked, not because you pressed it
};

// ---------------- utils ----------------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}
async function api(path, opts) {
  const r = await fetch(path, opts ? { method: opts.method || 'POST', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined);
  return r.json();
}

// ---------------- voice output (Web SpeechSynthesis) ----------------
// Speaks a reply ONLY when the user's own message that produced it was itself spoken (via
// startListening/SpeechRecognition) — typed messages always get a text-only reply. Every call
// site below passes the same `via` string ('voice' | 'typed') that handleUserText received, so
// this policy holds for every reply path, not just the main chat one.
let jarvisVoice = null;
function pickJarvisVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Preference order: deep, measured British-male voices closest to the JARVIS (Iron Man) voice.
  // Verified installed on this Mac: "Daniel" (en-GB) — the classic JARVIS-clone pick.
  const byName = ['Daniel', 'Arthur', 'Oliver', 'Malcolm', 'Reed (English (United Kingdom))', 'Eddy (English (United Kingdom))'];
  for (const name of byName) { const v = voices.find(x => x.name === name); if (v) return v; }
  return voices.find(v => /en-GB/i.test(v.lang) && !/female|woman/i.test(v.name))
      || voices.find(v => /^en/i.test(v.lang))
      || voices[0];
}
if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => { jarvisVoice = pickJarvisVoice(); };
  jarvisVoice = pickJarvisVoice(); // some browsers have the list ready immediately
}
// SELF-WAKE SUPPRESSION. The wake-word daemon listens to the same room these speakers play into, so
// it hears JARVIS as readily as it hears Mihir — caught in the daemon log transcribing his own
// reply: "shall i run through them battery is at 4% worth plugging in". Harmless there, but the
// moment a reply contains the word "jarvis" he can wake himself, and each wake opens the window and
// starts listening, which is a loop with nothing to stop it.
//
// Only utterances containing a wake word are announced. Everything else is already safe — the daemon
// transcribes it and matches nothing — so telling the server about every sentence would be a request
// per reply and a copy of his conversation for no benefit. This also keeps genuine barge-in working:
// he can still say "hey jarvis" over the top of any ordinary reply.
const SELF_WAKE_RE = /\bjarvis\b/i;
function notifySpeaking(on) {
  try { fetch('/api/speaking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !!on }) }); }
  catch (e) { /* the reply matters more than the suppression */ }
}

// A CONVERSATION DOES NOT MAKE YOU PRESS A BUTTON TO ANSWER A QUESTION.
//
// When JARVIS ends its turn with a question — "Send it, Sir?", "Which screen?" — the mic reopens on
// its own so the answer can simply be spoken. Three rules keep that from becoming a microphone that
// listens whenever it likes:
//
//   1. ONLY AFTER A SPOKEN TURN. Every speak() call site is already gated on via === 'voice', so a
//      typed conversation never opens the mic. Type to JARVIS and nothing here ever runs.
//   2. ONLY WHEN A QUESTION IS ACTUALLY OPEN. A pending confirm or screen choice is unambiguous;
//      otherwise the spoken line has to end in a question mark. A statement ends the turn.
//   3. ONLY AFTER JARVIS HAS STOPPED TALKING, and only for a few seconds. Chained off the
//      utterance's own `onend` rather than a guessed duration, because startListening() cancels
//      speech to avoid the mic hearing JARVIS — starting early would cut JARVIS off mid-question.
//
// `opts.listen === false` opts out; the greeting uses it, since the app opening is not a turn in a
// conversation and an unprompted open mic on launch is exactly the creepy behaviour to avoid.
const ANSWER_SILENCE_MS = 4000;   // stop listening after this much silence — "3-4 seconds"

function jarvisAwaitsAnswer(spoken) {
  if (state.pendingConfirm || state.pendingScreen) return true;
  return /\?["'”’)\s]*$/.test(String(spoken || '').trim());
}

function listenForAnswer(spoken) {
  if (!jarvisAwaitsAnswer(spoken)) return;
  if (state.listening || state.busy) return;              // already open, or another turn is running
  if (document.visibilityState !== 'visible') return;     // never open the mic on a hidden window
  startListening({ silenceMs: ANSWER_SILENCE_MS });
}

// TWO ENGINES, ONE CONTRACT. The server synthesises a neural voice (piper) and sends back a WAV;
// Web Speech remains as the fallback. Everything below the choice — the self-wake bracket, the
// reopened mic after a question, barge-in — behaves identically whichever one speaks, because a
// voice that changes how the CONVERSATION works depending on which engine answered is a bug.
//
// The server is preferred but never required: no piper, no python, offline model, a line it cannot
// pronounce — all fall through to the browser rather than leaving him with silence.
let ttsAudio = null;   // the <audio> playing a server-synthesised line, if any
let streamSpoken = ''; // the part of a streaming answer already said aloud, so it is not said twice

// Barge-in has to silence BOTH engines. Cancelling only speechSynthesis, as every call site used
// to, would leave a piper WAV playing straight into the mic that was just opened to hear him.
function stopSpeaking() {
  // The queue goes too. Barge-in means he is talking over the answer, so the REST of that answer is
  // no longer wanted either — leaving it queued would have JARVIS resume mid-paragraph seconds later.
  speakQ = [];
  pendingListenText = null;
  speaking = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (ttsAudio) {
    const a = ttsAudio; ttsAudio = null;
    try { a.pause(); if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src); } catch (e) {}
  }
}

function speakViaBrowser(clean, selfWake, finish) {
  if (!('speechSynthesis' in window)) return finish();
  const u = new SpeechSynthesisUtterance(clean);
  // Bracketed by the utterance's own events rather than an estimated duration: speech rate,
  // voice and length all change how long it actually takes, and a guess that ends early re-arms
  // the daemon mid-sentence.
  u.onstart = () => { if (selfWake) notifySpeaking(true); };
  u.onend = finish;
  u.onerror = finish;   // a failed utterance still ended JARVIS's turn
  u.voice = jarvisVoice || pickJarvisVoice();
  u.rate = 0.95;  // slightly slower — measured, JARVIS-like cadence
  u.pitch = 0.82; // slightly lower pitch — deeper voice
  // volume deliberately left at the SpeechSynthesisUtterance default (1.0) and never set here —
  // final loudness is system output volume x this value, so leaving it at 1.0 means the Mac's
  // own volume keys/output device are the only thing controlling how loud JARVIS sounds.
  speechSynthesis.speak(u);
}

// SPEAK THE FIRST SENTENCE WHILE THE REST IS STILL BEING MADE.
//
// Synthesis is roughly linear in length, and the whole WAV used to be built before a single byte
// reached the browser: measured 200ms for a short line but 1236ms for a long one, all of it silence
// after JARVIS had already finished thinking. He described it exactly — the voice takes too long to
// come up. Splitting on sentences makes the wait depend on the FIRST sentence only; the rest is
// fetched while that one plays, so it is ready before it is needed.
//
// Capped at four, with the tail merged into the last: a request per clause would be pointless
// traffic, would risk the rate limiter, and adds an audible seam at every join for nothing.
const TTS_MAX_CHUNKS = 4;
function ttsChunks(text) {
  const parts = String(text).match(/[^.!?…]+[.!?…]*\s*/g) || [];
  const out = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    // A fragment is not a sentence. "Sir." on its own, or the tail of an abbreviation, belongs to
    // the chunk before it — never as a separate utterance with its own pause either side.
    if (out.length && (p.length < 20 || /^[a-z]/.test(p))) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  if (!out.length) return [String(text)];
  while (out.length > TTS_MAX_CHUNKS) out[TTS_MAX_CHUNKS - 1] += ' ' + out.pop();
  return out;
}

async function speakViaServer(clean, selfWake, finish) {
  const a = new Audio();
  ttsAudio = a;
  const chunks = ttsChunks(clean);
  let settled = false, spokeAny = false;
  const superseded = () => ttsAudio !== a;    // barge-in replaced us while we were synthesising
  const end = () => { if (settled) return; settled = true; if (ttsAudio === a) ttsAudio = null; finish(); };
  const fallback = () => {
    if (settled || superseded()) return;
    settled = true; if (ttsAudio === a) ttsAudio = null;
    speakViaBrowser(clean, selfWake, finish);
  };
  // The token is attached by the global fetch wrapper, same as every other /api call.
  // SILENT IS NOT A SYNTHESIS FAILURE. The server answers a silenced request with 200 and
  // {silent:true} rather than the 503 it uses for a broken voice, precisely so this can tell them
  // apart: a 503 falls back to Web Speech, and falling back at 3am would say the line out loud in
  // the browser's voice — the one outcome this feature exists to prevent. Thrown with a marked flag
  // so the catch below can end the turn quietly instead of reaching for the other engine.
  const get = i => fetch('/api/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: chunks[i] }) })
    .then(async r => {
      if (!r.ok) throw new Error('speak ' + r.status);
      if ((r.headers.get('content-type') || '').includes('application/json')) {
        const j = await r.json().catch(() => ({}));
        if (j && j.silent) { const e = new Error('silent'); e.silent = true; throw e; }
        throw new Error('speak: unexpected json');
      }
      return r.blob();
    });

  try {
    let pending = get(0);
    for (let i = 0; i < chunks.length; i++) {
      const blob = await pending;
      if (superseded()) return;               // he interrupted; do not start talking over the answer
      pending = (i + 1 < chunks.length) ? get(i + 1) : null;   // build the next one while this plays
      const url = URL.createObjectURL(blob);
      a.src = url;
      a.onplaying = () => { if (selfWake && !spokeAny) notifySpeaking(true); };
      await new Promise((resolve, reject) => {
        a.onended = resolve;
        a.onerror = () => reject(new Error('audio error'));
        // stopSpeaking() pauses rather than ending, so without this the await would never settle
        // and the turn would hang on a line he had already interrupted.
        a.onpause = () => { if (superseded()) resolve(); };
        a.play().catch(reject);
      });
      try { URL.revokeObjectURL(url); } catch (e) {}
      if (superseded()) return;
      spokeAny = true;
    }
    end();
  } catch (e) {
    if (superseded()) return;
    // Nothing was heard yet, so the browser voice says the whole line. If part of it was ALREADY
    // spoken, repeating the lot from the top is worse than finishing quietly — end the turn instead.
    // A silenced turn ends quietly whether or not anything was spoken before the flag flipped.
    if (e && e.silent) { end(); return; }
    if (spokeAny) end(); else fallback();
  }
}

// SENTENCES THAT FOLLOW ONE ANOTHER INSTEAD OF INTERRUPTING.
//
// speak() has always meant "say this INSTEAD of whatever you were saying" — correct for barge-in,
// and exactly wrong for a reply arriving a sentence at a time, where each new one would cut off the
// last. `{ queue: true }` appends rather than replaces. Everything without the flag keeps the old
// behaviour, so the wake word, the greeting and every confirm still interrupt as they did.
let speakQ = [];              // [{ text, opts }] waiting their turn
let speaking = false;
let pendingListenText = null; // decides the reopened mic once the WHOLE reply has been said

function speak(text, opts) {
  opts = opts || {};
  if (opts.queue && (speaking || speakQ.length)) { speakQ.push({ text, opts }); return; }
  if (!opts.queue) { speakQ = []; pendingListenText = null; }   // an unqueued line replaces the lot
  speakNow(text, opts);
}

function speakNow(text, opts) {
  opts = opts || {};
  const wantListen = !(opts.listen === false);
  const clean = String(text || '').replace(/[*_`#]+/g, '').trim();
  // Whatever happens to THIS line, the turn is only over when nothing is left to say.
  const afterAll = () => {
    speaking = false;
    const next = speakQ.shift();
    if (next) { speakNow(next.text, next.opts); return; }
    const t = pendingListenText; pendingListenText = null;
    if (t != null) listenForAnswer(t);
    else if (wantListen) listenForAnswer(text);
  };
  if (!clean) {
    // Nothing to say. The follow-up still belongs to the caller's turn, so it happens anyway —
    // just without a spoken question to wait out first.
    setTimeout(afterAll, 120);
    return;
  }
  if (!opts.queue) stopSpeaking();   // barge-in: a new line replaces whatever JARVIS was still saying
  speaking = true;
  const selfWake = SELF_WAKE_RE.test(clean);
  // One finish path for both engines, so the mic reopens on exactly the same rule either way.
  const finish = () => {
    if (selfWake) notifySpeaking(false);
    afterAll();
  };
  // VISUAL-SILENT MODE. Checked HERE, above the engine choice, because the choice below is only
  // ever "which voice" — both branches speak. The flag is refreshed by the /api/overview poll, so a
  // window that opens at midnight reaches a tab that has been open since the evening.
  //
  // finish() is still called: the mic reopen and the speaking flag hang off it, and a silent turn
  // must leave the machine in the same state a spoken one does. Skipping it would end the turn with
  // the microphone shut.
  if (state.silent) { finish(); return; }
  if (state.tts) speakViaServer(clean, selfWake, finish);
  else speakViaBrowser(clean, selfWake, finish);
}

// The tail of a reply whose opening sentences were already spoken as they streamed. Speaks only what
// is left, so he does not hear the first sentence twice.
//
// If the finished reply is NOT a continuation of what was streamed, it is said in full: that is the
// anti-hallucination guard having replaced the answer, and the replacement is the part that matters.
function speakRemainder(reply, streamed) {
  const full = String(reply || '');
  const said = String(streamed || '').trim();
  if (said && full.replace(/\s+/g, ' ').startsWith(said.replace(/\s+/g, ' ').slice(0, Math.max(0, said.length - 1)))) {
    const rest = full.slice(said.length).trim();
    pendingListenText = full;                 // the mic decision belongs to the WHOLE answer
    speak(rest, { queue: true, listen: false });
    return;
  }
  speak(full);
}
const fmtTime = ms => new Date(ms).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const rel = ms => {
  const d = Date.now() - ms;
  if (d < 60000) return 'now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
};

// ---------------- orb state ----------------
const STATES = {
  idle: { label: 'Online', dot: 'rgba(140,210,255,0.75)', line: () => greeting() + ', Sir. At your service — tap the core or press the mic.' },
  listening: { label: 'Listening', dot: '#5ed4f7', line: () => 'Go ahead, Sir — I’m listening.' },
  thinking: { label: 'Thinking', dot: '#60a5fa', line: () => 'On it.' },
  speaking: { label: 'Speaking', dot: '#9fe6ff', line: () => 'Responding.' },
};
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function orbSet(s, line) {
  state.orb = s;
  const w = $('#orbWrap');
  w.className = s === 'idle' ? '' : s;
  const st = STATES[s];
  $('#stateDot').style.background = st.dot;
  $('#stateDot').style.boxShadow = '0 0 10px ' + st.dot;
  $('#stateLabel').textContent = st.label;
  $('#stateLine').textContent = line || st.line();
  $('#wave').classList.toggle('on', s === 'listening' || s === 'speaking');
}

// ---------------- navigation ----------------
function setView(v) {
  state.view = v;
  $$('.view').forEach(el => el.classList.remove('active'));
  const el = $('#view-' + v);
  if (el) el.classList.add('active');
  $$('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === v));
  if (v === 'vision') startVision();
  else stopVision();
  if (v === 'files') loadFiles(state.filesPath);
  if (v === 'settings') { loadSettings(); loadConnections(); }
  if (v === 'chat') { renderConvo(); }
}
$$('.nav-item[data-view]').forEach(n => n.addEventListener('click', () => setView(n.dataset.view)));
// ---------------- identity (silent) ----------------
//
// Grabs one camera frame every 15s and posts it. The server classifies and keeps the answer; this
// side is told NOTHING back — no tier, no name — so the page cannot reveal a classification even if
// someone opens the console. That is the point of the feature.
//
// GRAB AND RELEASE, not a held stream. Holding the camera open would sit the green LED on for the
// whole session and cost battery on an 8 GB Air; opening it for the half-second a frame takes gives
// a brief pulse instead. The LED cannot be suppressed — macOS wires it to the sensor in hardware —
// and this design at least makes it honest: it lights when a look is taken, not permanently.
//
// Same code serves the phone: facingMode 'user' picks the front camera, and the PWA gets the frame
// the same way the desktop does.
// MEASURED, AND THE FIRST DESIGN WAS WRONG. One check cost 60s of vision model, EVICTED the chat
// model from RAM on this 8 GB machine, and made the next reply take 30s instead of 3.5s — while
// firing every 15s, so checks overlapped and the chat model was never resident. That is the freeze.
//
// The fix is to stop calling the model in the steady state. A person sitting still produces a frame
// that barely changes, and an unchanged frame is itself the evidence: nobody has swapped. So the
// camera still looks on his cadence, but the expensive classification only runs when the scene
// ACTUALLY CHANGES — someone arrives, leaves, or is replaced. That is the only moment the answer
// could differ, so it is the only moment worth paying for.
//
// The security property survives: a different face in the chair is, by definition, a changed frame.
// 2.5 minutes, fixed, at his request — replacing the adaptive 15s→2min backoff. Simpler to reason
// about, and it cuts the camera pulses by an order of magnitude: 24 looks an hour instead of 240.
// The trade is a wider window in which a swapped face goes unnoticed, which is his call to make and
// a reasonable one — the API token is still the actual door, and this layer is about privacy at an
// unlocked machine, not authentication.
const IDENTITY_EVERY_MS = 150000;
// 22, not 9. A person working shifts, leans, and changes expression constantly, and at 9 every one
// of those counted as a scene change — which would have fired an 18s vision call every 15 seconds
// and rebuilt the exact problem this is meant to solve. A DIFFERENT person in the chair is a far
// larger delta than fidgeting. Needs tuning against his real camera; the log line below makes the
// measured deltas visible so it can be tuned from data rather than guessed at twice.
const DIFF_THRESHOLD = 22;
let idBusy = false, idFails = 0;
let idPrevThumb = null;                // last frame's thumbnail, for the cheap comparison
let idTimer = null;

// A 32x24 greyscale thumbnail, compared by mean absolute difference. Deliberately crude: it must be
// cheap enough to run on the main thread without being felt, and it only has to answer "is this the
// same scene", not "who is this".
function thumbOf(canvas) {
  const t = document.createElement('canvas');
  t.width = 32; t.height = 24;
  t.getContext('2d').drawImage(canvas, 0, 0, 32, 24);
  const d = t.getContext('2d').getImageData(0, 0, 32, 24).data;
  const out = new Uint8Array(32 * 24);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
  return out;
}
function frameDelta(a, b) {
  if (!a || !b) return 999;                // nothing to compare with — treat as changed
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function identityFrame() {
  if (idBusy || document.hidden) return null;      // a backgrounded tab has no one in front of it
  idBusy = true;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; v.playsInline = true;
    await v.play();
    // One frame is not ready the instant play() resolves on every device.
    await new Promise(r => setTimeout(r, 350));
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
    if (!c.width || !c.height) return null;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    // The thumbnail is taken here, while the canvas is in hand, so the caller can decide whether
    // this frame is even worth encoding. toDataURL is synchronous and the single most expensive
    // thing on this path — skipping it when nothing changed is most of the saving.
    return { canvas: c, thumb: thumbOf(c) };
  } catch (e) {
    // Permission refused, no camera, or the device is busy. Silent by design: this feature never
    // explains itself, and a toast here would announce exactly what it is trying not to announce.
    idFails++;
    return null;
  } finally {
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    idBusy = false;
  }
}

// ---- face-api: the actual recogniser ----
//
// Vendored locally (public/vendor/faceapi) rather than pulled from a CDN, because this machine is
// offline-first and a face check that needs the internet is a face check that fails on a train.
// ~6.8 MB of weights, loaded once, lazily — nothing is fetched until the first check runs, so a
// session that never sees the camera never pays for it.
let faceReady = null;
function loadFaceApi() {
  if (faceReady) return faceReady;
  faceReady = (async () => {
    if (!window.faceapi) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = '/vendor/faceapi/face-api.js';
        s.onload = res; s.onerror = () => rej(new Error('face-api failed to load'));
        document.head.appendChild(s);
      });
    }
    const M = '/vendor/faceapi/model';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(M),
      faceapi.nets.faceLandmark68Net.loadFromUri(M),
      faceapi.nets.faceRecognitionNet.loadFromUri(M),
    ]);
    // WEBGL CAN CLAIM TO WORK AND THEN HANG. Found the hard way: a context that reported
    // webglAvailable:true with backend "webgl" never returned from a single detection — not slow,
    // stuck, indefinitely. The same image on the CPU backend finished in 3.3s. A hidden tab throttles
    // it too, and a stalled backend is worse than a slow one because nothing ever errors.
    //
    // So the first detection is raced against a timeout, and a backend that fails to answer is
    // abandoned for CPU. Done once, at load, rather than per check.
    try {
      const probe = document.createElement('canvas');
      probe.width = 320; probe.height = 240;
      probe.getContext('2d').fillRect(0, 0, 320, 240);
      await Promise.race([
        faceapi.detectSingleFace(probe, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('webgl stalled')), 8000)),
      ]);
    } catch (e) {
      try {
        await faceapi.tf.setBackend('cpu');
        await faceapi.tf.ready();
        console.info('[identity] GPU backend stalled — using CPU');
      } catch (e2) {}
    }
    return true;
  })().catch(e => { faceReady = null; throw e; });
  return faceReady;
}

// One 128-float descriptor from a canvas, or null when no face is visible. Null is a real answer
// here and the caller must treat it as one — "no face" leaves the tier alone, it does not demote.
// SWEEP THE DETECTOR, do not give up after one setting.
//
// Found in practice: Kunal enrolled with a photo and NO descriptor, so he sat in the roster as
// "known" while actually being classified unknown — a silent, invisible failure. His face was there
// all along; at inputSize 416 it detected at score 0.868, a strong hit. His photo is portrait
// (288x384) and the 320 input squashes it enough to miss.
//
// So: try the cheap setting first and only escalate when nothing is found. A face that is present
// costs one pass; a hard frame costs three and still succeeds, which is far better than an enrolment
// that quietly cannot be recognised.
const DETECTOR_STEPS = [
  { inputSize: 320, scoreThreshold: 0.5 },   // fast path — the common case
  { inputSize: 416, scoreThreshold: 0.3 },   // portrait crops, smaller faces
  { inputSize: 608, scoreThreshold: 0.2 },   // last resort, off-angle or poorly lit
];
async function descriptorFrom(canvas) {
  await loadFaceApi();
  for (const opts of DETECTOR_STEPS) {
    const det = await faceapi
      .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions(opts))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (det && det.descriptor) return Array.from(det.descriptor);
  }
  return null;                                // genuinely no face — the caller leaves the tier alone
}

async function identityTick() {
  // Never compete with a reply in flight. The vision model and the chat model do not fit in this
  // machine's RAM together, so a check started mid-conversation is the freeze by another name.
  if (window.__jarvisChatBusy) { schedule(IDENTITY_EVERY_MS); return; }
  const shot = await identityFrame();
  if (!shot) { schedule(IDENTITY_EVERY_MS); return; }

  const delta = frameDelta(idPrevThumb, shot.thumb);
  if (delta <= DIFF_THRESHOLD) {
    // Same scene as last time. Nobody arrived, nobody left, nobody swapped — so the answer cannot
    // have changed and there is nothing to pay a model for. Back off, so a still room costs almost
    // nothing and the camera light stops pulsing every fifteen seconds.
    // Still no model call when the scene is unchanged. At 2.5-minute spacing this matters less than
    // it did at 15s, but an unchanged frame still cannot have changed the answer, and the vision
    // call it saves is the ~18s one that evicts the chat model.
    schedule(IDENTITY_EVERY_MS);
    return;
  }
  idPrevThumb = shot.thumb;
  try {
    // A descriptor, not a picture. 128 floats instead of a JPEG: nothing of his face leaves the
    // browser, the payload is a few KB, and the server decides in about a millisecond.
    const descriptor = await descriptorFrom(shot.canvas);
    if (descriptor) {
      await api('/api/identity/check', { body: { descriptor } });
    }
    // descriptor === null means face-api found no face. Nothing is sent, and the tier is left
    // exactly where it was — he stood up, which is not an intrusion.
  } catch (e) {
    idFails++;                                     // face-api missing or broken; stop after three
  }
  schedule(IDENTITY_EVERY_MS);
}

function schedule(ms) {
  clearTimeout(idTimer);
  if (idFails >= 3) return;                        // no camera, or permission permanently denied
  idTimer = setTimeout(identityTick, ms);
}

// setTimeout rather than setInterval: the interval is adaptive, and an interval that fires while the
// previous check is still running is what let these stack up in the first place.
// ---------------- location (asked for, not assumed) ----------------
//
// WHY THIS EXISTS. The server's fallback is IP geolocation, and on his connection that resolves to
// Nagpur — 78.1 km from where he actually is. Harmless for a weather tile; wrong city for an
// ambulance. The browser can do far better: navigator.geolocation reads Core Location (WiFi
// positioning), accurate to tens of metres, and it is the same source the address-lookup sites use.
// Going straight to it means his live position never passes through anyone else's server.
//
// ASKED FOR ONCE, AND NOT NAGGED. The first call raises the browser's permission prompt — that is
// JARVIS doing the asking. If he refuses, that is an answer: this stops for the session rather than
// re-prompting, because an assistant that asks twice for the same thing is one you turn off.
const LOCATION_EVERY_MS = 5 * 60 * 1000;
let locTimer = null, locDenied = false;

async function locationTick() {
  if (locDenied || !navigator.geolocation) return;
  if (document.hidden) { locTimer = setTimeout(locationTick, 60000); return; }   // nobody is here
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        await api('/api/location', { body: {
          lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy,
        } });
      } catch (e) {}
      locTimer = setTimeout(locationTick, LOCATION_EVERY_MS);
    },
    (err) => {
      // PERMISSION_DENIED is a decision, not a failure — stop asking. Everything else (no signal,
      // timeout) is temporary, so try again later at a slower cadence.
      if (err && err.code === 1) {
        locDenied = true;
        console.info('[location] denied — JARVIS will fall back to IP geolocation, which is ~78km off here');
        return;
      }
      locTimer = setTimeout(locationTick, LOCATION_EVERY_MS);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 120000 }
  );
}

(function startLocation() {
  if (!navigator.geolocation) return;
  // A beat after load, so the prompt does not collide with the window appearing.
  locTimer = setTimeout(locationTick, 1500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !locDenied && !locTimer) locationTick();
  });
})();

(function startIdentity() {
  // TURNED OFF 2026-08-24, at his request. Not deleted — every function above still works, and
  // flipping IDENTITY_ENABLED back to true restores the whole loop.
  //
  // The camera loop is the half that matters: with nothing posting descriptors, the server's tier
  // simply stays at its 'root' default and the gate can never demote him. Measured cause: his own
  // face came back 0.359-0.585 against a 0.50 threshold, so about half the checks rejected him and
  // each rejection silently locked him out of his own assistant.
  const IDENTITY_ENABLED = false;
  if (!IDENTITY_ENABLED) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  schedule(IDENTITY_EVERY_MS);
})();

// ---------------- settings ----------------
// Each control saves on change — there is no Save button, because a settings pane with an unsaved
// state is a way to lose a change by navigating away. The server owns the whitelist; this only ever
// sends the fields it was handed.
// A LABEL IS NOT ENOUGH FOR A SETTING THAT CHANGES HOW SOMETHING TALKS TO YOU. Each control carries
// one line saying what the choice actually does, because "Manner: dry | plain | warm" tells you the
// words on the menu and nothing about the consequence — and an unexplained control is one nobody
// touches. `hint` is the value-independent description; `note` is per-value where it earns it.
const SET_LABELS = {
  address:          { label: 'How to address you',   hint: 'none = no honorific · sir / maam / boss · name = your name · mix = varies. Salutation only — not where you live.' },
  name:             { label: 'Your name',            hint: 'Used when address is set to “name”, and when writing about you.' },
  pronouns:         { label: 'Pronouns',             hint: 'How JARVIS refers to you when writing to someone else.' },
  manner:           { label: 'Manner',               hint: 'ironman = dry wit · dry = butler-crisp · plain = no flourishes · warm = friendly.' },
  replyStyle:       { label: 'Reply length',         hint: 'adaptive = short for actions, fuller for questions and failures.' },
  briefing:         { label: 'Briefing on open',     hint: 'Whether JARVIS opens with what needs you.' },
  rhythm:           { label: 'Your hours',           hint: 'irregular = judge presence from activity, never from the clock.' },
  uncertainty:      { label: 'When unsure',          hint: 'read-act-write-ask = act on reversible things, ask before anything that changes state.' },
  contactAmbiguity: { label: 'Ambiguous contact',    hint: 'What to do when a name matches more than one person.' },
  nicknameStrategy: { label: 'Unfamiliar names',     hint: 'learn = ask once, then remember that answer for good.' },
  language:         { label: 'Language',             hint: 'en-understand-hi = understands Hindi/Marathi/Hinglish, always answers in English.' },
  music:            { label: 'Music app',            hint: 'Which app “play …” controls.' },
  breaks:           { label: 'Break reminders',      hint: 'Water and look-away nudges during long sessions.' },
  quizNewTopics:    { label: 'Quiz new topics',      hint: 'ask = when you add a study topic (“teach me about …”), JARVIS asks before quizzing you on it · always = adds it straight away (what answering “always” sets).' },
  dailyQuiz:        { label: 'Daily quiz',           hint: 'Tutor mode on its own: the “questions ready” notification and new study cards drafted each night. Off = neither — “quiz me” still works when you ask.' },
  candid:           { label: 'Never sugar-coat',     hint: 'On = the full story, and push back where your reasoning is weak.' },
  explainLevel:     { label: 'Explanation level',    hint: 'e.g. “9th-10th grade” or “expert”. Blank = pitched to the question.' },
  country:          { label: 'Country',              hint: 'Two letters, e.g. US, DE, IN. Blank = this Mac’s region. (SOS always uses where you actually are.)' },
  homeZone:         { label: 'Time zone',            hint: 'e.g. America/New_York, Europe/Berlin. Blank = this Mac’s time zone.' },
  units:            { label: 'Units',                hint: 'auto = this Mac’s °C/°F setting · metric · us.' },
  familyZone:       { label: 'Family time zone',     hint: 'Where your family lives, for “is it a good time to call?”. Blank = not set.' },
};
// The order controls read in, grouped so related choices sit together. A field not listed here still
// renders — it falls into "Other" rather than vanishing, so a setting added on the server can never
// silently fail to appear.
const SET_GROUPS = [
  { title: 'HOW JARVIS ADDRESSES YOU', keys: ['address', 'name', 'pronouns'] },
  { title: 'HOW IT SPEAKS',            keys: ['manner', 'replyStyle', 'language', 'candid', 'explainLevel'] },
  { title: 'WHERE YOU ARE',            keys: ['country', 'homeZone', 'units', 'familyZone'] },
  { title: 'WHAT IT DOES ON ITS OWN',  keys: ['uncertainty', 'briefing', 'rhythm', 'breaks', 'dailyQuiz', 'quizNewTopics'] },
  { title: 'PEOPLE AND APPS',          keys: ['contactAmbiguity', 'nicknameStrategy', 'music'] },
];
// One row: label, the line explaining what it does, and the control. Saving happens on change —
// there is still no Save button, for the original reason: a pane with unsaved state is a way to lose
// a change by navigating away.
//
// A REJECTED VALUE HAS TO SHOW. The server validates against its own option list now, so a POST can
// come back 400; silently swallowing that would leave the control showing a value the profile does
// not hold. On failure the row says so and puts the previous value back.
function setRow(key, val, opts, isText) {
  const row = document.createElement('div');
  row.className = 'set-row';
  const left = document.createElement('div');
  left.className = 'set-left';
  const meta = SET_LABELS[key] || { label: key, hint: '' };
  const label = document.createElement('div');
  label.className = 'set-label';
  label.textContent = meta.label || key;
  left.appendChild(label);
  if (meta.hint) {
    const hint = document.createElement('div');
    hint.className = 'set-hint';
    hint.textContent = meta.hint;
    left.appendChild(hint);
  }
  row.appendChild(left);

  const status = document.createElement('div');
  status.className = 'set-status';

  const save = async (body, revert) => {
    const res = await api('/api/settings', { body });
    if (res && res.ok) { status.textContent = 'saved'; status.className = 'set-status ok'; }
    else {
      status.textContent = (res && res.error) ? res.error : 'not saved';
      status.className = 'set-status bad';
      if (revert) revert();
    }
    setTimeout(() => { status.textContent = ''; status.className = 'set-status'; }, 2200);
  };

  let control;
  if (typeof val === 'boolean') {
    control = document.createElement('span');
    control.className = 'btn set-toggle' + (val ? ' on' : '');
    control.textContent = val ? 'On' : 'Off';
    control.addEventListener('click', () => {
      const next = !control.classList.contains('on');
      control.classList.toggle('on', next);
      control.textContent = next ? 'On' : 'Off';
      save({ [key]: next }, () => {
        control.classList.toggle('on', !next);
        control.textContent = !next ? 'On' : 'Off';
      });
    });
  } else if (isText) {
    control = document.createElement('input');
    control.className = 'field set-input';
    control.type = 'text';
    control.value = val == null ? '' : String(val);
    let last = control.value;
    const commit = () => {
      if (control.value === last) return;
      const prev = last; last = control.value;
      save({ [key]: control.value }, () => { control.value = prev; last = prev; });
    };
    control.addEventListener('blur', commit);
    control.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) control.blur(); });
  } else {
    control = document.createElement('select');
    control.className = 'field set-input';
    let last = val;
    for (const opt of (opts || [val])) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (opt === val) o.selected = true;
      control.appendChild(o);
    }
    control.addEventListener('change', () => {
      const prev = last; last = control.value;
      save({ [key]: control.value }, () => { control.value = prev; last = prev; });
    });
  }
  const right = document.createElement('div');
  right.className = 'set-right';
  right.appendChild(status);
  right.appendChild(control);
  row.appendChild(right);
  return row;
}

// ---------------- settings → connections ----------------
// The Composio key (a required setup step) and MCP servers connected by pasting their link (2026-10-09). A key is
// sent once, tested by the server, and never comes back — the page only ever sees "set" and its last four characters.
// Everything a server sends (names, hosts, errors) goes in with textContent, never as HTML: an MCP server is
// somebody else's code.
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function connRow(labelText, hintText) {
  const row = el('div', 'set-row');
  const left = el('div', 'set-left');
  left.appendChild(el('div', 'set-label', labelText));
  if (hintText) left.appendChild(el('div', 'set-hint', hintText));
  const right = el('div', 'set-right');
  // Stacked, not side by side: a connection row carries a field, a key box and buttons, which squeezed the label
  // into a one-word column when they shared the line.
  row.style.cssText = 'flex-direction:column;align-items:stretch;gap:10px;';
  right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-start;';
  row.appendChild(left); row.appendChild(right);
  return { row, left, right };
}
function secretInput(placeholder) {
  const i = el('input', 'field set-input');
  i.type = 'password'; i.placeholder = placeholder; i.autocomplete = 'new-password'; i.spellcheck = false;
  return i;
}
async function loadConnections() {
  const box = $('#connBox'); if (!box) return;
  const r = await api('/api/connections');
  box.innerHTML = '';
  if (!r || r.error) { box.appendChild(el('div', 'set-hint', 'Could not load connections — ' + ((r && r.error) || 'no response'))).style.padding = '13px 16px'; return; }

  // Composio — required
  const c = connRow('Composio API key — required',
    'Cloud tools: news, finance, places and shopping search, plus Gmail, Slack, Notion and the rest once you connect them in Composio. Paste the key from your Composio dashboard; it is tested first and saved only on this Mac.');
  const state = el('div', 'set-status ' + (r.composio.set ? 'ok' : 'bad'), r.composio.set ? 'connected ' + (r.composio.masked || '') : 'required — not set');
  const key = secretInput(r.composio.set ? 'paste a new key to replace it' : 'paste your Composio API key');
  const save = el('span', 'btn small', 'Save & test');
  const msg = el('div', 'set-hint'); msg.style.cssText = 'width:100%;';
  save.addEventListener('click', async () => {
    if (!key.value.trim()) { msg.textContent = 'Paste the key first.'; return; }
    save.textContent = 'Testing…';
    const res = await api('/api/connections/composio', { body: { key: key.value.trim() } });
    key.value = '';
    save.textContent = 'Save & test';
    msg.textContent = res && res.ok ? 'Composio accepted the key — saved.' : ((res && res.error) || 'Not saved.');
    if (res && res.ok) { loadConnections(); checkSetup(); }
  });
  c.right.append(state, key, save, msg);
  box.appendChild(c.row);

  // MCP servers connected by link
  for (const m of r.mcp || []) {
    const row = connRow('MCP · ' + m.name, (m.host || '') + (m.added ? ' · added ' + m.added : '') + (m.authKind && m.authKind !== 'none' ? ' · with a key' : ''));
    const st = el('div', 'set-status ' + (m.ready ? 'ok' : 'bad'),
      m.ready ? m.tools + ' tools (' + m.readOnly + ' read-only; the rest ask you first)' : 'not connected — ' + (m.error || '?'));
    const rm = el('span', 'btn small', 'Remove');
    rm.addEventListener('click', async () => {
      if (!confirm('Remove the ' + m.name + ' connection? Its saved key is deleted too.')) return;
      const res = await api('/api/connections/mcp/remove', { body: { name: m.name } });
      if (res && res.ok) loadConnections(); else alert((res && res.error) || 'Not removed.');
    });
    row.right.append(st, rm);
    box.appendChild(row.row);
  }
  // Servers from config/mcp.json (programs JARVIS starts) — read-only here
  for (const m of r.configured || []) {
    const row = connRow('MCP · ' + m.name + ' (config file)', 'Started from config/mcp.json — edit that file to change it.');
    row.right.appendChild(el('div', 'set-status ' + (m.ready ? 'ok' : 'bad'), m.ready ? m.tools + ' tools' : 'not running — ' + (m.error || '?')));
    box.appendChild(row.row);
  }

  // Connect a new one
  const add = connRow('Connect an MCP server',
    'Paste the server\'s link (https). If it needs a key or token, paste that too. JARVIS shows the planner at most ' + (r.maxExposed || 8) + ' of its tools per request, chosen by meaning, and asks you before any tool that is not read-only. Servers that need a browser sign-in (OAuth) are not supported yet.');
  const url = el('input', 'field set-input'); url.type = 'url'; url.placeholder = 'https://…/mcp'; url.spellcheck = false;
  const tok = secretInput('key or token (optional)');
  const kind = el('select', 'field set-input');
  for (const [v, t] of [['bearer', 'Bearer token'], ['header', 'API-key header'], ['none', 'No key']]) { const o = el('option', null, t); o.value = v; kind.appendChild(o); }
  const go = el('span', 'btn small', 'Connect');
  const out = el('div', 'set-hint'); out.style.cssText = 'width:100%;';
  go.addEventListener('click', async () => {
    if (!url.value.trim()) { out.textContent = 'Paste the link first.'; return; }
    go.textContent = 'Connecting…';
    const res = await api('/api/connections/mcp', { body: { url: url.value.trim(), token: tok.value.trim(), authKind: tok.value.trim() ? kind.value : 'none' } });
    tok.value = '';
    go.textContent = 'Connect';
    if (res && res.ok) { out.textContent = 'Connected "' + res.name + '" — ' + res.tools + ' tools (' + res.readOnly + ' read-only).'; url.value = ''; loadConnections(); }
    else out.textContent = (res && res.error) || 'Could not connect.';
  });
  add.right.append(url, tok, kind, go, out);
  box.appendChild(add.row);
}
// The banner above every view while a required step is missing.
async function checkSetup() {
  const b = $('#setupBanner'); if (!b) return;
  const r = await api('/api/connections');
  b.style.display = (r && r.composio && !r.composio.set) ? 'block' : 'none';
}
(() => {
  const b = $('#setupBanner');
  if (!b) return;
  const open = () => { setView('settings'); setTimeout(() => { const s = $('#connSection'); if (s) s.scrollIntoView({ behavior: 'smooth' }); }, 300); };
  b.addEventListener('click', open);
  b.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  setTimeout(checkSetup, 1500);
})();

async function loadSettings() {
  const form = $('#setForm'); if (!form) return;
  const r = await api('/api/settings');
  form.innerHTML = '';
  if (!r || r.error) {
    const e = document.createElement('div');
    e.className = 'set-card';
    e.textContent = 'Could not load settings — ' + ((r && r.error) || 'no response');
    form.appendChild(e);
    return;
  }
  const editable = r.editable || {};
  const textKeys = new Set(r.text || []);
  // A MACHINE NOBODY HAS SET UP. JARVIS starts blank on a new Mac — no name, no honorific — so say
  // where to start rather than leaving a stranger to guess which of twenty rows matter.
  if (r.firstRun) {
    const hello = document.createElement('div');
    hello.className = 'set-card';
    hello.style.cssText += 'padding:13px 16px;font-size:12px;line-height:1.6;color:rgba(255,255,255,0.8);';
    hello.textContent = 'Welcome — this JARVIS has not been set up yet. Start with your name and how to address you, '
      + 'then check “Where you are”. Everything saves as you change it; blank fields use this Mac’s own settings.';
    form.appendChild(hello);
  }
  // Anything the server sent that no group claims still renders, under "Other" — so a setting added
  // server-side appears here without this file being edited, instead of silently not existing.
  const claimed = new Set(SET_GROUPS.flatMap(g => g.keys));
  const leftovers = Object.keys(editable).filter(k => !claimed.has(k));
  const groups = leftovers.length ? SET_GROUPS.concat([{ title: 'OTHER', keys: leftovers }]) : SET_GROUPS;

  for (const g of groups) {
    const keys = g.keys.filter(k => k in editable);
    if (!keys.length) continue;
    const sec = document.createElement('div');
    sec.className = 'set-section';
    const h = document.createElement('div');
    h.className = 'set-section-title';
    h.textContent = g.title;
    sec.appendChild(h);
    const card = document.createElement('div');
    card.className = 'set-card';
    for (const k of keys) card.appendChild(setRow(k, editable[k], (r.options || {})[k], textKeys.has(k)));
    sec.appendChild(card);
    form.appendChild(sec);
  }
  // Enrolment lives here because this panel is already root-only on the server. A stranger at an
  // unlocked machine must not be able to add their own face — that would defeat the entire feature,
  // so /api/identity/enroll refuses at any tier below root regardless of what this UI does.
  try {
    const idr = await api('/api/identity');
    // RECOGNITION IS OFF — say so plainly instead of showing a roster that governs nothing.
    //
    // Leaving the enrolment controls up while the gate is disabled would be the panel lying: the
    // names would still list, "root" and "known" would still be selectable, and none of it would
    // affect a single request. The faces stay on disk and this returns the moment JARVIS_IDENTITY=1.
    if (idr && !idr.error && idr.enabled === false) {
      const off = document.createElement('div');
      // .set-card, not .glass — this sits among the setting groups and was the one panel still
      // styled as a free-floating box after the rebuild.
      off.className = 'set-card';
      off.style.cssText += 'display:flex;flex-direction:column;gap:6px;padding:13px 16px;';
      const h = document.createElement('div');
      h.style.cssText = 'font-size:12.5px;color:rgba(255,255,255,0.8);';
      h.textContent = 'Face recognition — OFF';
      const p2 = document.createElement('div');
      p2.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,0.45);line-height:1.6;';
      p2.textContent = 'Nothing is gated on who is at the camera; every request runs with full access. '
        + ((idr.enrolled || []).length ? (idr.enrolled || []).length + ' enrolled face(s) are kept on disk and unused. ' : '')
        + 'Re-enable with JARVIS_IDENTITY=1 in .env.';
      off.appendChild(h); off.appendChild(p2);
      form.appendChild(off);
    } else if (idr && !idr.error) {
      const box = document.createElement('div');
      box.className = 'set-card';
      box.style.cssText += 'display:flex;flex-direction:column;gap:9px;padding:13px 16px;';
      const head = document.createElement('div');
      head.className = 'set-label';
      head.textContent = 'Faces JARVIS knows';
      box.appendChild(head);
      const list = document.createElement('div');
      list.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,0.45);line-height:1.7;';
      // An enrolment with no descriptor is called out, not hidden: it looks enrolled but can never
      // be matched, which is the most misleading state this list can be in.
      list.textContent = (idr.enrolled || []).length
        ? (idr.enrolled || []).map(e => e.name + ' — ' + e.tier + (e.recognisable === false ? ' (NO FACE — cannot be matched)' : '')).join('   ·   ')
        : 'nobody enrolled — recognition is off, everything runs as normal';
      box.appendChild(list);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
      const nameIn = document.createElement('input');
      nameIn.className = 'field'; nameIn.placeholder = 'name'; nameIn.style.cssText = 'flex:1;min-width:120px;';
      const tierSel = document.createElement('select');
      tierSel.className = 'field';
      for (const t of ['root', 'known']) { const o = document.createElement('option'); o.value = t; o.textContent = t; tierSel.appendChild(o); }
      const go = document.createElement('span');
      go.className = 'btn'; go.textContent = 'Enrol from camera'; go.style.cursor = 'pointer';
      go.addEventListener('click', async () => {
        if (!nameIn.value.trim()) { toast('Name first'); return; }
        go.textContent = 'Look at the camera…';
        const shot = await identityFrame();
        if (!shot) { go.textContent = 'Enrol from camera'; toast('No camera frame'); return; }
        const frame = shot.canvas.toDataURL('image/jpeg', 0.85);   // enrolment keeps more detail than a check
        // The descriptor is the part that actually recognises. Computed here, from the same frame
        // the photo came from, so the roster picture and the maths describe the same moment.
        const descriptor = await descriptorFrom(shot.canvas).catch(() => null);
        const res = await api('/api/identity/enroll', { body: { name: nameIn.value.trim(), tier: tierSel.value, frame, descriptor } });
        go.textContent = 'Enrol from camera';
        toast(res && res.ok ? 'Enrolled' : (res && res.error) || 'Failed');
        if (res && res.ok) loadSettings();
      });
      // FROM A PHOTO, not only the camera. Enrolling someone who is not in the room is the normal
      // case for the "known" tier — family, a friend — and asking them to come and sit in front of
      // the webcam to be registered is absurd. It also gives a better reference than a webcam frame:
      // a clear, well-lit photo is exactly what the classifier compares against every time.
      const fileIn = document.createElement('input');
      fileIn.type = 'file';
      // heic included because that is what an iPhone actually shoots; the server converts it.
      fileIn.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';
      fileIn.style.display = 'none';
      const pick = document.createElement('span');
      pick.className = 'btn'; pick.textContent = 'Enrol from photo'; pick.style.cursor = 'pointer';
      pick.addEventListener('click', () => {
        if (!nameIn.value.trim()) { toast('Name first'); return; }
        fileIn.click();
      });
      fileIn.addEventListener('change', async () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        pick.textContent = 'Reading…';
        try {
          // Downscaled here as well as on the server. The server is the guarantee; doing it here too
          // means a 12 MP photo is not pushed through the socket only to be shrunk at the far end.
          // HEIC cannot be drawn to a canvas by the browser, so those are sent as-is and sips deals
          // with them — hence the raw-read fallback rather than an error.
          const dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result); fr.onerror = rej;
            fr.readAsDataURL(f);
          });
          let payload = dataUrl;
          if (/^data:image\/(jpeg|jpg|png|webp)/i.test(dataUrl)) {
            payload = await new Promise(res => {
              const im = new Image();
              im.onload = () => {
                const max = 384, s = Math.min(1, max / Math.max(im.width, im.height));
                const c = document.createElement('canvas');
                c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
                c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
                res(c.toDataURL('image/jpeg', 0.85));
              };
              im.onerror = () => res(dataUrl);          // unreadable by canvas — let the server try
              im.src = dataUrl;
            });
          }
          // A photo needs its descriptor computed from the SAME image, so draw it to a canvas and
          // extract. A photo with no detectable face enrols as a picture but can never be matched,
          // and the reply says so rather than letting him think it worked.
          const pimg = await new Promise(r2 => { const i2 = new Image(); i2.onload = () => r2(i2); i2.onerror = () => r2(null); i2.src = payload; });
          let pdesc = null;
          if (pimg) {
            const pc = document.createElement('canvas');
            pc.width = pimg.width; pc.height = pimg.height;
            pc.getContext('2d').drawImage(pimg, 0, 0);
            pdesc = await descriptorFrom(pc).catch(() => null);
          }
          const res2 = await api('/api/identity/enroll', { body: { name: nameIn.value.trim(), tier: tierSel.value, frame: payload, descriptor: pdesc } });
          toast(res2 && res2.ok ? (res2.recognisable ? 'Enrolled from photo' : 'Stored, but no face found in it') : (res2 && res2.error) || 'Failed');
          if (res2 && res2.ok) loadSettings();
        } catch (e) { toast('Could not read that image'); }
        pick.textContent = 'Enrol from photo';
        fileIn.value = '';
      });

      row.appendChild(nameIn); row.appendChild(tierSel); row.appendChild(go); row.appendChild(pick); row.appendChild(fileIn);
      box.appendChild(row);
      $('#setForm').appendChild(box);
    }
  } catch (e) {}

  renderModels(r.models || {});
}

// ---------------- Settings → Models (2026-10-17) ----------------
// Which model does which job — read from the server's own getters, so it cannot disagree with what runs — and CALIBRATE: measure a
// model the way JARVIS runs it (through the memory gate; jarvis on its llama-server), see what its limits would become, then Keep
// or Discard. Calibrating never changes which model does which job; nothing is saved until Keep, and Undo puts the old profile back.
async function renderModels(m) {
  const box = $('#modelsBox'); if (!box) return;
  box.innerHTML = '';
  for (const r of m.roles || []) {
    const row = el('div', 'set-row');
    const left = el('div', 'set-left'); left.appendChild(el('div', 'set-label', r.role));
    const right = el('div', 'set-right');
    right.appendChild(el('div', 'set-hint', r.model + (r.where === 'llama-server' ? ' · on llama-server' : '')));
    row.append(left, right); box.appendChild(row);
  }
  const c = connRow('Calibrate a model',
    'Measures how much a model says and how fast it runs on this Mac, so JARVIS gives it the right token and time limits. ' +
    'It does not change which model does which job. One at a time, never during a training — about a minute. Nothing is saved until you press Keep.');
  const sel = document.createElement('select'); sel.className = 'field set-input';
  const go = el('span', 'btn small', 'Measure');
  const out = el('div', 'set-hint'); out.style.cssText = 'width:100%;white-space:pre-line;';
  const acts = el('div'); acts.style.cssText = 'display:flex;gap:8px;';
  c.right.append(sel, go, acts, out); box.appendChild(c.row);
  if (m.signedInPages) { const row = el('div', 'set-row'); row.appendChild(el('div', 'set-hint', m.signedInPages)); box.appendChild(row); }
  if (m.mac) { const row = el('div', 'set-row'); row.appendChild(el('div', 'set-hint', 'This Mac: ' + m.mac + (m.detected ? ' · ' + m.detected : ''))); box.appendChild(row); }

  const fill = async fresh => {
    const r = await api('/api/models' + (fresh ? '?fresh=1' : ''));
    sel.innerHTML = '';
    const list = (r && r.models) || [];
    if (!list.length) { const o = el('option', null, 'Ollama is not answering — no models to list'); o.disabled = true; sel.appendChild(o); return r; }
    const inUse = list.filter(x => x.jobs.length), other = list.filter(x => !x.jobs.length);
    for (const [title, xs] of [['Doing a job now', inUse], ['Installed, not in use', other]]) {
      if (!xs.length) continue;
      const g = document.createElement('optgroup'); g.label = title;
      for (const x of xs) {
        const o = el('option', null, x.name + (x.params ? ' · ' + x.params : '') + (x.quant ? ' ' + x.quant : '') +
          (x.jobs.length ? ' — ' + x.jobs.join(', ') : '') + (x.where === 'llama-server' ? ' (llama-server)' : '') +
          ' · ' + (x.profile.source === 'calibrated' ? 'measured' : 'not measured'));
        o.value = x.name; g.appendChild(o);
      }
      sel.appendChild(g);
    }
    return r;
  };
  const show = job => {
    acts.innerHTML = '';
    if (!job) { out.textContent = ''; go.textContent = 'Measure'; return; }
    if (job.state === 'running') { out.textContent = 'Measuring ' + job.model + '… (' + Math.round((Date.now() - job.startedAt) / 1000) + ' s)'; go.textContent = 'Measuring…'; return; }
    go.textContent = 'Measure';
    if (job.state === 'failed') { out.textContent = job.model + ': ' + (job.error || 'failed') + ' Nothing was changed.'; return; }
    const ms = job.measured || {}, cur = job.current || {}, pr = job.proposed || {}, b = job.budgets || {};
    out.textContent = job.model + ' — measured, not saved yet\n' +
      'says ' + ms.outTok + ' tokens per answer · ' + (ms.msPerTok == null ? 'speed not measured' : ms.msPerTok + ' ms per token') +
      ' · first call ' + ms.coldMs + ' ms · follows a JSON format: ' + (ms.schema == null ? 'not measured' : ms.schema ? 'yes' : 'no') +
      ' · reasoning text: ' + (ms.reasoning ? 'yes' : 'no') + '\n' +
      'verbosity ' + cur.verbosity + ' → ' + pr.verbosity + ' · speed ' + cur.speed + ' → ' + (pr.speed == null ? cur.speed : pr.speed) +
      ' (now ' + (cur.source === 'calibrated' ? 'measured' : cur.source) + ')\n' +
      'a 300-token answer gets ' + (b.tokens300 || []).join(' → ') + ' tokens · a 20 s call gets ' + (b.timeout20s || []).map(x => Math.round(x / 1000) + ' s').join(' → ');
    const keep = el('span', 'btn small', 'Keep'), drop = el('span', 'btn small', 'Discard');
    keep.addEventListener('click', async () => {
      const res = await api('/api/calibrate/keep', {});
      acts.innerHTML = '';
      out.textContent = res && res.ok ? 'Saved — ' + res.model + ' now runs on its measured limits.' : ((res && res.error) || 'Not saved.');
      if (res && res.ok) {
        const undo = el('span', 'btn small', 'Undo');
        undo.addEventListener('click', async () => {
          const u = await api('/api/calibrate/undo', { body: { model: res.model } });
          out.textContent = u && u.ok ? 'Put back the profile ' + res.model + ' had before.' : ((u && u.error) || 'Nothing to undo.');
          acts.innerHTML = ''; fill(true);
        });
        acts.appendChild(undo); fill(true);
      }
    });
    drop.addEventListener('click', async () => { await api('/api/calibrate/discard', {}); show(null); out.textContent = 'Discarded — nothing changed.'; });
    acts.append(keep, drop);
  };
  let timer = null;
  const poll = async () => {
    const r = await api('/api/calibrate');
    const job = r && r.job;
    show(job);
    clearTimeout(timer);
    if (job && job.state === 'running') timer = setTimeout(poll, 2000);
  };
  go.addEventListener('click', async () => {
    if (!sel.value) return;
    const res = await api('/api/calibrate', { body: { model: sel.value } });
    if (!res || !res.ok) { out.textContent = (res && res.error) || 'Could not start.'; return; }
    poll();
  });
  const r0 = await fill(false);
  if (r0 && r0.job) poll();
}

// ---------------- clock ----------------
setInterval(() => {
  const t = new Date();
  const pad = n => String(n).padStart(2, '0');
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  $('#clock').textContent = pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
  $('#dateLine').textContent = days[t.getDay()] + ' ' + pad(t.getDate()) + ' ' + months[t.getMonth()];
}, 1000);

// ---------------- waveform ----------------
(function buildWave() {
  const wave = $('#wave');
  for (let i = 0; i < 24; i++) {
    const c = Math.abs(i - 11.5) / 11.5;
    const b = document.createElement('div');
    b.className = 'wavebar';
    b.style.height = Math.round(10 + (1 - c) * 22 + Math.sin(i * 2.7) * 5) + 'px';
    b.style.animationDuration = (0.45 + ((i * 7) % 5) * 0.09).toFixed(2) + 's';
    b.style.animationDelay = ((i * 0.083) % 0.6).toFixed(2) + 's';
    wave.appendChild(b);
  }
})();

// ---------------- chat ----------------
function saveConvo() { localStorage.setItem('jarvis.convo', JSON.stringify(state.convo.slice(-60))); }
function msgEl(role, text, isErr, route) {
  if (role === 'user') {
    const d = document.createElement('div');
    d.className = 'msg-user';
    d.textContent = text;
    return d;
  }
  const d = document.createElement('div');
  d.className = 'msg-jarvis' + (isErr ? ' err' : '');
  d.innerHTML = '<div class="dot"></div><div class="txt"></div>';
  d.querySelector('.txt').textContent = text;
  // WHERE IT WENT AND HOW LONG IT TOOK. Silent slowness reads as a hang; a labelled 8 seconds reads
  // as work. Only shown when it is worth knowing — a sub-second local answer needs no footnote.
  if (route && (route.ms >= 1500 || route.lane !== 'chat')) {
    const f = document.createElement('div');
    f.className = 'msg-route';
    const secs = route.ms >= 1000 ? (route.ms / 1000).toFixed(1) + 's' : route.ms + 'ms';
    f.textContent = String(route.lane).replace(/[:_]/g, ' ') + ' · ' + secs + (route.local ? ' · local' : '');
    d.querySelector('.txt').appendChild(f);
  }
  return d;
}
// Phase 4 cards: every tool result is a compact card; confirms are a distinct card with buttons.
const ACT_ICON = { open_app: '🚀', switch_to: '🚀', close_app: '⏹', hide_app: '🙈', create_folder: '📁', create_file: '📄', append: '✍️', delete: '🗑', rename: '🏷️', move: '📦', copy: '📑', list: '📂', search: '🔎', search_web: '🌐', open_url: '🌐', open_social: '📱', read: '📖', make_app: '🛠️', system_status: '📊', volume: '🔊', screenshot: '📸', empty_trash: '🗑', list_running: '📋', run_shortcut: '⚡', run_workflow: '⚙️', sleep_display: '🌙', control_screen: '🖥️', open_site: '🔗', research: '🔬' };
function cardEl(card, item) {
  // Agent clarify: ambiguous contact match — pick one instead of letting JARVIS guess.
  if (card.kind === 'agentclarify') {
    const d = document.createElement('div'); d.className = 'confirm-card agent-clarify' + (item.resolved ? ' resolved' : '');
    d.innerHTML = '<div class="q"></div><div class="clarify-opts"></div><div class="verdict"></div>';
    d.querySelector('.q').textContent = card.say;
    const wrap = d.querySelector('.clarify-opts');
    (card.options || []).forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'clarify-btn' + (item.resolved === name ? ' picked' : '');
      b.textContent = name;
      if (item.resolved) b.disabled = true;
      else b.addEventListener('click', () => { item.resolved = name; saveConvo(); renderConvo(); resolveClarify(card.id, i); });
      wrap.appendChild(b);
    });
    return d;
  }
  if (card.kind === 'confirm') {
    const d = document.createElement('div'); d.className = 'confirm-card' + (item.resolved ? ' resolved' : '');
    d.innerHTML = '<div class="q"></div><div class="btns"><button class="yes">Confirm</button><button class="no">Abort</button></div><div class="verdict"></div>';
    d.querySelector('.q').textContent = card.say;
    if (item.resolved) { const v = d.querySelector('.verdict'); v.textContent = item.resolved === 'confirmed' ? '✓ Confirmed' : '✕ Aborted'; v.style.color = item.resolved === 'confirmed' ? '#6ee7b7' : 'rgba(255,255,255,.5)'; }
    else {
      d.querySelector('.yes').addEventListener('click', () => { item.resolved = 'confirmed'; state.pendingConfirm = null; saveConvo(); renderConvo(); execConfirm(card.confirm); });
      d.querySelector('.no').addEventListener('click', () => { item.resolved = 'aborted'; state.pendingConfirm = null; saveConvo(); renderConvo(); pushMsg('assistant', 'Aborted, sir.'); });
    }
    return d;
  }
  if (card.kind === 'sources') {
    const d = document.createElement('div'); d.className = 'src-card';
    const head = document.createElement('div'); head.className = 'src-head';
    head.textContent = 'SOURCES READ — ' + card.sources.length + (card.ms ? ' · ' + (card.ms / 1000).toFixed(1) + 's' : '');
    d.appendChild(head);
    const wrap = document.createElement('div'); wrap.className = 'src-chips';
    card.sources.forEach((s, i) => {
      const c = document.createElement('button');
      c.className = 'src-chip';
      c.title = s.title || s.url;
      c.textContent = '[S' + (i + 1) + '] ' + (s.host || s.url);
      c.addEventListener('click', () => openExt(s.url));
      wrap.appendChild(c);
    });
    d.appendChild(wrap);
    return d;
  }
  const d = document.createElement('div'); d.className = 'act-card';
  d.innerHTML = '<span class="ico"></span><span class="say"></span><span class="ms"></span><span class="res"></span>';
  d.querySelector('.ico').textContent = ACT_ICON[card.type] || '⚡';
  d.querySelector('.say').textContent = card.say || (card.type || 'action').replace(/_/g, ' ');
  // THE WHOLE TURN, NOT THE LAST STEP. This used to print the action's own time — 860ms for a turn
  // that took fifteen seconds, because everything the router did before the action ran was not in it.
  // The number on the card is now what he waited; the action's share is on hover.
  if (card.ms != null) {
    const el = d.querySelector('.ms');
    el.textContent = card.ms >= 1000 ? (card.ms / 1000).toFixed(1) + 's' : card.ms + 'ms';
    if (card.actionMs != null && card.actionMs !== card.ms) el.title = 'the action itself took ' + card.actionMs + 'ms';
  }
  const res = d.querySelector('.res'); res.textContent = card.ok ? 'OK' : 'FAIL'; res.className = 'res ' + (card.ok ? 'ok' : 'bad');
  return d;
}
// THE TRANSCRIPT IS BOUNDED, and adding to it does not rebuild it.
//
// Two separate faults, both measured on the running app (238 MB across its four processes on an
// 8 GB machine with 70 MB free):
//
//   1. saveConvo() has always capped PERSISTED history at 60 messages, but state.convo itself was
//      never capped — only "New chat" emptied it. A long session grew the array, the DOM and the
//      WebContent process without limit, and the cap gave the false impression this was handled.
//   2. Every single message called renderConvo(), which clears innerHTML and re-appends the WHOLE
//      conversation. At 200 messages that is 200 elements rebuilt to show one new line — O(n²) over
//      a session, and the reason the window feels heavier the longer it is open.
//
// CONVO_MAX matches saveConvo's 60 deliberately. A larger in-memory buffer would show scrollback
// that silently vanishes on reload, which is a worse experience than a consistent limit.
const CONVO_MAX = 60;
function trimConvo() {
  const over = state.convo.length - CONVO_MAX;
  if (over > 0) state.convo.splice(0, over);
}
// Full rebuild. Still correct for a view switch, a clear, or an item whose CONTENT changed (a
// clarify or confirm card resolving in place) — those genuinely need the whole list re-evaluated.
function renderConvo() {
  const log = $('#chatLog');
  log.innerHTML = '';
  if (!state.convo.length) log.appendChild(msgEl('assistant', greeting() + ', Sir. Direct line open — how may I assist?'));
  for (const m of state.convo) log.appendChild(m.card ? cardEl(m.card, m) : msgEl(m.role, m.content, m.err, m.route));
  log.scrollTop = log.scrollHeight;
}
// Append ONE. The invariant renderConvo() establishes is one child per convo entry, so syncing the
// tail against state.convo.length both drops the greeting placeholder when the first real message
// lands and removes anything trimmed off the front — without touching the elements between.
function appendConvo(m) {
  const log = $('#chatLog');
  if (!log) return;
  log.appendChild(m.card ? cardEl(m.card, m) : msgEl(m.role, m.content, m.err, m.route));
  while (log.children.length > state.convo.length && log.firstChild) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
function pushCard(card) {
  const m = { role: 'assistant', card };
  state.convo.push(m); trimConvo(); saveConvo();
  if (state.view === 'chat') appendConvo(m);
}
function pushMsg(role, content, err, route) {
  const m = { role, content, err: !!err, route: route || null };
  state.convo.push(m); trimConvo(); saveConvo();
  if (state.view === 'chat') appendConvo(m);
}

// ---------------- screen-check intent (chat/voice: "what's on my screen", "what's on your UI") ----------------
function detectWatchIntent(text) {
  const t = text.toLowerCase();
  // "watch what I do" is LEARN-BY-WATCHING, not a variable watcher. This intent fired on anything
  // starting with "watch", posted it to /api/watchers, and the request never reached the server —
  // where observe.WATCH_START_RE matches it correctly and starts a recording. The chat router last
  // saw that phrase on 2 Aug; every attempt since became "Watching for: what i do."
  if (/\bwatch (?:what|how|me)\b|\bobserve me\b|\brecord (?:what i do|my steps|this)\b|\blearn (?:this|what i)/i.test(t)) return false;
  if (/^\/?watch\b/.test(t)) return true;
  if (/\b(let me know|notify me|ping me|alert me|tell me)\b.*\b(when|if)\b/.test(t)) return true;
  if (/\bkeep (an )?eye on\b/.test(t)) return true;
  return false;
}
function detectScreenIntent(text) {
  const t = text.toLowerCase();
  if (!/\b(screen|display|monitor|desktop|ui|interface)\b/.test(t)) return null;
  if (!/\bwhat|\bcheck\b|\blook\b|\bsee\b|\bshow\b|\btell me\b|\bhappening\b|\bgoing on\b/.test(t)) return null;
  const selfMeta = /\byour\b|\bjarvis'?s?\b/.test(t);   // "your screen/UI" → JARVIS's own window, not the user's screen
  return { selfMeta };
}
function resolveDisplayFromText(text, displays) {
  const t = text.toLowerCase();
  const words = { one: 1, two: 2, three: 3, four: 4, first: 1, second: 2, third: 3, fourth: 4 };
  for (const w in words) { if (new RegExp('\\b' + w + '\\b').test(t)) { const d = displays[words[w] - 1]; if (d) return d; } }
  const num = t.match(/\b(\d)\b/);
  if (num) { const d = displays[parseInt(num[1], 10) - 1]; if (d) return d; }
  if (/\b(main|built-?in|primary|laptop)\b/.test(t)) return displays.find(d => d.main) || displays[0];
  if (/\b(external|secondary|other|monitor)\b/.test(t) && displays.length > 1) return displays.find(d => !d.main) || displays[1];
  for (const d of displays) if (d.name && t.includes(String(d.name).toLowerCase())) return d;
  return null;
}
async function getDisplays() {
  if (window.jarvisListDisplays) {
    try { const d = await window.jarvisListDisplays(); if (Array.isArray(d) && d.length) return d; } catch (e) {}
  }
  try { const r = await api('/api/displays'); if (r.displays && r.displays.length) return r.displays; } catch (e) {}
  return [{ id: 0, index: 1, name: 'Main Display', main: true }];
}
async function captureDisplay(display, hideSelfIfNeeded) {
  if (window.jarvisCaptureDisplay) return await window.jarvisCaptureDisplay(display.id, !!hideSelfIfNeeded);
  const r = await api('/api/capture', { body: { display: display.index || 1 } });
  if (r.error) throw new Error(r.error);
  return r.dataUrl;
}
function pushScreenPicker(displays, via) {
  const names = displays.map((d, i) => (i + 1) + ': ' + (d.name || ('Screen ' + (i + 1))) + (d.main ? ' (main)' : '')).join('   ·   ');
  const msg = 'You have ' + displays.length + ' screens connected — which one? ' + names;
  pushMsg('assistant', msg);
  if (state.view === 'voice') { $('#voiceReply').style.display = 'flex'; $('#voiceQuery').style.display = 'none'; $('#voiceAnswer').textContent = msg; }
  if (via === 'voice') speak(msg);
}
async function initiateScreenCheck(question, selfMeta, via) {
  let displays;
  try { displays = await getDisplays(); } catch (e) { displays = null; }
  if (!displays || !displays.length) displays = [{ id: 0, index: 1, name: 'Main Display', main: true }];
  if (displays.length > 1) {
    const chosen = resolveDisplayFromText(question, displays);
    if (chosen) return runScreenCapture(question, selfMeta, chosen, false, via);
    pushMsg('user', question);
    state.pendingScreen = { selfMeta, displays };
    pushScreenPicker(displays, via);
    return;
  }
  return runScreenCapture(question, selfMeta, displays[0], false, via);
}
async function runScreenCapture(text, selfMeta, display, skipUserPush, via) {
  if (state.view !== 'chat' && state.view !== 'voice') setView('chat');
  toast(selfMeta ? 'Capturing JARVIS…' : 'Capturing screen…');
  try {
    const dataUrl = await captureDisplay(display, !selfMeta);
    const label = selfMeta ? 'Screenshot of JARVIS OS’s own window/UI' : 'Screenshot of the user’s screen (' + (display.name || 'display') + ')';
    await sendChat(text, { images: [{ dataUrl, label }], displayText: text, skipUserPush: !!skipUserPush, via });
  } catch (e) {
    if (!skipUserPush) pushMsg('user', text);
    pushMsg('assistant', 'Couldn’t capture the screen: ' + e.message, true);
    if (via === 'voice') speak('Couldn’t capture the screen: ' + e.message);
    orbSet('idle');
  }
}

async function sendChat(text, opts) {
  opts = opts || {};
  if (state.busy) { toast('One moment — still thinking.'); return; }
  state.busy = true;
  if (!opts.skipUserPush) pushMsg('user', opts.displayText || text);
  orbSet('thinking');
  // Acknowledge anything that will not answer in a beat, immediately and with a real estimate.
  // Spoken back only when they spoke to us, matching the existing voice-in/voice-out rule.
  // THINK HARD: armed by the #qaThink button, spent on this one question. The server routes it to the slow,
  // careful reasoning model (body.thinkHard) — it can take minutes, so say so up front.
  const thinkHard = !!state.thinkNext && !opts.brief;
  if (thinkHard) { state.thinkNext = false; $('#qaThink').classList.remove('on'); }
  const ack = opts.brief ? null : thinkHard ? 'Thinking this through carefully — this can take a few minutes.' : ackFor(text);
  if (ack) { pushMsg('assistant', ack); if (opts.via === 'voice') speak(ack); }
  if (!opts.brief) startProgress(opts.via);
  setBusy(true);
  if (state.view === 'voice') { $('#voiceQuery').style.display = 'block'; $('#voiceQuery').textContent = opts.displayText || text; $('#voiceAnswer').textContent = ack || '…'; $('#voiceReply').style.display = 'flex'; }
  try {
    const history = state.convo.filter(m => !m.err).slice(-16).map(m => ({ role: m.role, content: m.content }));
    history[history.length - 1] = { role: 'user', content: text };
    const r = await api('/api/chat', { body: { messages: history, images: opts.images || [], brief: !!opts.brief, thinkHard, useFaces: !!opts.useFaces, via: opts.via || 'typed' } });
    clearLiveReply();          // the streamed preview is replaced by whatever really arrived
    if (!r.error) applyUi(r.ui);
    if (r.error) {
      pushMsg('assistant', r.error, true);
      if (state.view === 'voice') $('#voiceAnswer').textContent = r.error;
      if (opts.via === 'voice') speak(r.error);
      orbSet('idle');
    } else {
      if (state.view === 'voice') $('#voiceAnswer').textContent = r.reply;
      if (r.agentClarify) {
        // Not stored in state.pendingConfirm — a clarify answer isn't yes/no, so it doesn't hook
        // into the confirm-resolution path in handleUserText at all; only the card's own buttons resolve it.
        pushCard({ kind: 'agentclarify', say: r.reply, id: r.agentClarify.id, options: r.agentClarify.options });
      }
      else if (r.confirm && r.confirm.kind === 'agent') {
        // No permission-dialog card — this reads as JARVIS asking a normal question. The safety
        // gate is unchanged (still needs an explicit yes before anything outbound happens), only
        // the presentation is plain conversation: say "yes"/"go ahead" (typed or spoken) to send.
        state.pendingConfirm = r.confirm;
        pushMsg('assistant', formatAgentConfirmText(r.reply, r.confirm.preview));
      }
      else if (r.confirm) { state.pendingConfirm = r.confirm; pushCard({ kind: 'confirm', say: r.reply, confirm: r.confirm }); }
      else if (r.action && (r.action.did || r.action.type)) pushCard({ kind: 'action', type: r.action.type, say: r.reply, ok: r.action.ok !== false, ms: (r.route && r.route.ms != null) ? r.route.ms : r.action.ms, actionMs: r.action.ms });
      else {
        // Research answers are prose, so they render as a normal bubble with a clickable
        // source strip beneath — never squashed into a one-line action card.
        pushMsg('assistant', r.reply, false, r.route);
        if (Array.isArray(r.sources) && r.sources.length) pushCard({ kind: 'sources', sources: r.sources, ms: r.researchMs });
      }
      if (r.undo) showUndo(r.undo);
      // Says only the part that was NOT already spoken while it streamed. When nothing streamed —
      // an action, a cloud lane, a cached answer — spokenSoFar() is empty and this is the plain
      // speak() it has always been.
      if (opts.via === 'voice') speakRemainder(r.reply, spokenSoFar());
      orbSet('speaking', 'Responding.');
      setTimeout(() => { if (state.orb === 'speaking') orbSet('idle'); }, 1800);
    }
  } catch (e) {
    clearLiveReply();
    pushMsg('assistant', 'Connection to JARVIS core failed: ' + e.message, true);
    orbSet('idle');
  }
  stopProgress(false);   // settle the working card whatever happened — error paths included
  setBusy(false);
  state.busy = false;
}

// Renders whatever a resumed agent plan comes back with — usually just a result message, but a
// plan with more than one gated step could pause again, so this handles that the same way sendChat
// does. `via` is only passed when this was reached by a spoken "yes" — mirrors execConfirm's rule
// that a button click stays silent (a click is neither voice nor typed).
// Folds the drafted message + recipient/channel into ONE plain chat line — no bordered box, just
// what JARVIS is asking plus exactly what it would send, so a bare "yes" reply has everything
// needed to decide without a separate special UI element to read.
function formatAgentConfirmText(reply, preview) {
  const pv = preview || {};
  if (!pv.body) return reply;
  const chip = pv.channel === 'whatsapp' ? 'WhatsApp' + (pv.number ? ' · ' + pv.number : '') : pv.channel === 'imessage' ? 'iMessage' : '';
  const toLine = pv.to ? 'To: ' + pv.to + (chip ? ' · ' + chip : '') : '';
  return reply + (toLine ? '\n' + toLine : '') + '\n“' + pv.body + '”';
}

function renderAgentResume(r, via) {
  if (r.agentClarify) { pushCard({ kind: 'agentclarify', say: r.reply, id: r.agentClarify.id, options: r.agentClarify.options }); if (via === 'voice') speak(r.reply); return; }
  if (r.confirm && r.confirm.kind === 'agent') { state.pendingConfirm = r.confirm; pushMsg('assistant', formatAgentConfirmText(r.reply, r.confirm.preview)); if (via === 'voice') speak(r.reply); return; }
  const say = r.reply || (r.ok ? 'Done, Sir.' : 'Nothing was sent.');
  pushMsg('assistant', say, r.ok === false);
  if (state.view === 'voice') $('#voiceAnswer').textContent = say;
  if (via === 'voice') speak(say);
}

// Approve or discard a paused agent plan. The server holds the plan; we only send its id, so the
// message that gets sent is exactly the one that was shown — the client cannot alter it.
async function resolveAgent(id, approve, via) {
  try { renderAgentResume(await api('/api/agent/confirm', { body: { id, approve } }), via); }
  catch (e) { pushMsg('assistant', 'Could not complete that: ' + e.message, true); }
}
// Answer a clarify card ("which Mama did you mean?") — sends the chosen option's index only; the
// server maps it back to the phone/email it already resolved, the client never sees or picks that.
async function resolveClarify(id, choice, via) {
  try { renderAgentResume(await api('/api/agent/clarify', { body: { id, choice } }), via); }
  catch (e) { pushMsg('assistant', 'Could not complete that: ' + e.message, true); }
}
// Finds the still-open LEGACY confirm card (close-app etc. — the only remaining card-with-buttons
// type) matching a pendingConfirm object and marks it resolved, so a spoken/typed "yes" visually
// settles it the same way clicking its button would. Agent sends have no such card anymore (they
// render as plain chat text, see formatAgentConfirmText) so there is nothing to mark for those.
// Legacy confirms have no server-side id, so they match by the SAME object reference
// state.pendingConfirm already held.
function markConfirmResolved(pc, verdict) {
  for (let i = state.convo.length - 1; i >= 0; i--) {
    const item = state.convo[i];
    if (!item.card || item.resolved) continue;
    if (item.card.kind === 'confirm' && item.card.confirm === pc) { item.resolved = verdict; saveConvo(); renderConvo(); return; }
  }
}

// Execute a confirmed action (close-app), then report the result. `via` is only passed when this
// was reached by a spoken/typed "yes" (handleUserText); the Confirm BUTTON click never passes it,
// so button-triggered confirms stay text-only (a click is neither a voice nor typed message).
async function execConfirm(confirm, via) {
  try {
    // New system-control tools confirm as {tool,args}; legacy actions as {type,target}.
    const r = confirm.tool
      ? await api('/api/tool', { body: { tool: confirm.tool, args: confirm.args, confirmed: true } })
      : await api('/api/action', { body: { type: confirm.type, target: confirm.target, confirmed: true } });
    const say = r.say || (r.ok ? 'Done, Sir.' : 'Could not complete that, Sir.');
    pushMsg('assistant', say, !r.ok);
    if (via === 'voice') speak(say);
    if (state.view === 'voice') $('#voiceAnswer').textContent = say;
  } catch (e) { pushMsg('assistant', 'Action failed: ' + e.message, true); }
}

// Screen-control: a blue "controlling" banner with its own Stop (mirrors the native HUD ✕).
const clientControlIntent = t => /^\/control\b/i.test(t) || /\b(take (over|control)|control (my|the) (screen|mouse|computer)|use (my|the) (mouse|computer|screen) to)\b/i.test(t.toLowerCase());
// The World Monitor and the neural network are opened and closed by what the server read (its reply's
// `ui`, see applyUi) — the open/close word lists that stood here were keyword traps (2026-09-19).
function showControlBanner() {
  if ($('#ctrlBanner')) return;
  if (!$('#ctrlPulseCss')) { const s = document.createElement('style'); s.id = 'ctrlPulseCss'; s.textContent = '@keyframes ctrlpulse{to{opacity:.2}}'; document.head.appendChild(s); }
  const b = document.createElement('div');
  b.id = 'ctrlBanner';
  b.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:3000;display:flex;align-items:center;gap:10px;background:linear-gradient(90deg,#0b5cd8,#1e73e8);color:#fff;padding:9px 12px 9px 16px;border-radius:22px;box-shadow:0 6px 26px rgba(0,80,220,.5);font:600 13px Inter,sans-serif;border:1px solid rgba(120,190,255,.6);';
  b.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;background:#9fe4ff;box-shadow:0 0 8px #9fe4ff;animation:ctrlpulse .8s infinite alternate;"></span>JARVIS is controlling your screen<button id="ctrlStop" style="margin-left:6px;background:rgba(255,255,255,.2);border:none;color:#fff;font:700 12px Inter;padding:5px 11px;border-radius:13px;cursor:pointer;">✕ Stop</button>';
  document.body.appendChild(b);
  $('#ctrlStop').addEventListener('click', async () => { try { await api('/api/control/stop', { method: 'POST' }); toast('Stopping JARVIS…'); } catch (e) {} });
}
function hideControlBanner() { const b = $('#ctrlBanner'); if (b) b.remove(); }

// command routing (chat + voice share this)
async function handleUserText(raw, via) {
  const text = raw.trim();
  if (!text) return;
  // Tells the identity checker to stay out of the way. The vision model and the chat model do not
  // both fit in this machine's RAM, so a face check that starts mid-reply evicts the model that is
  // answering — measured at 30s for the following reply instead of 3.5s. Cleared in the finally
  // below so a failed turn cannot leave the checker switched off forever.
  window.__jarvisChatBusy = true;
  try {
    return await handleUserTextInner(text, via);
  } finally {
    window.__jarvisChatBusy = false;
  }
}

async function handleUserTextInner(text, via) {
  // Remembered so the greeting knows whether they are speaking: their voice overrides the
  // overnight text-only rule, since someone who just spoke is plainly awake.
  state.lastVia = via;
  const lower = text.toLowerCase();

  // A confirmation is pending (close-app, a system-control action, or an agent send/open) — resolve
  // it with the next reply, typed OR spoken. "sure", "go ahead" etc. all count as yes; anything that
  // isn't a recognized yes/no abandons the confirm and falls through to being handled normally.
  if (state.pendingConfirm) {
    const pc = state.pendingConfirm;
    if (/^(y|yes|yep|yeah|yup|confirm|do it|go ahead|sure|ok|okay|please|affirmative)\b/i.test(lower)) {
      state.pendingConfirm = null; pushMsg('user', text); markConfirmResolved(pc, 'confirmed');
      return pc.kind === 'agent' ? resolveAgent(pc.id, true, via) : execConfirm(pc, via);
    }
    if (/^(n|no|nope|cancel|never ?mind|stop|don'?t|negative)\b/i.test(lower)) {
      state.pendingConfirm = null; pushMsg('user', text); markConfirmResolved(pc, 'aborted');
      if (pc.kind === 'agent') return resolveAgent(pc.id, false, via);
      pushMsg('assistant', 'Cancelled, Sir.');
      if (state.view === 'voice') $('#voiceAnswer').textContent = 'Cancelled, Sir.';
      if (via === 'voice') speak('Cancelled, Sir.');
      return;
    }
    state.pendingConfirm = null; // any other reply: abandon the confirm, handle normally
  }

  // World Monitor: "boot up/open/launch the world monitor" (voice or typed) — mirrors ⌘⇧W. Handled
  // here (not through sendChat/the LLM) so it's instant and works even with no internet or Ollama down.
  // Neural network — checked before the World Monitor since both are "open the X" shapes.
  // Screen control: show the web banner while JARVIS drives (the native HUD shows too).
  if (clientControlIntent(text)) {
    showControlBanner();
    try { await sendChat(text, { via }); } finally { hideControlBanner(); }
    return;
  }

  // A "which screen?" question is pending — the next utterance answers it (a slash command cancels it instead).
  if (state.pendingScreen) {
    const pending = state.pendingScreen;
    if (lower.startsWith('/')) { state.pendingScreen = null; }
    else {
      state.pendingScreen = null;
      const chosen = resolveDisplayFromText(text, pending.displays);
      if (chosen) return runScreenCapture(text, pending.selfMeta, chosen, false, via);
      pushMsg('user', text);
      pushMsg('assistant', 'Didn’t catch which one — checking your main display.');
      if (via === 'voice') speak('Didn’t catch which one — checking your main display.');
      return runScreenCapture(text, pending.selfMeta, pending.displays.find(d => d.main) || pending.displays[0], true, via);
    }
  }

  // "what's on my screen" / "what's happening on your UI" → screen-check flow (skip for slash commands)
  if (!lower.startsWith('/')) {
    const intent = detectScreenIntent(text);
    if (intent) return initiateScreenCheck(text, intent.selfMeta, via);
  }

  // schedule: "/schedule ..." typed, or voice starting with "schedule"
  if (lower.startsWith('/schedule') || (via === 'voice' && lower.startsWith('schedule'))) {
    const body = text.replace(/^\/?schedule\s*/i, '').trim();
    if (!body) { pushMsg('assistant', 'Tell me what to schedule, e.g. /schedule standup reminder tomorrow at 9am', true); return; }
    pushMsg('user', text);
    try {
      const r = await api('/api/automations', { body: { text: body } });
      const say = r.say || r.error || 'Could not schedule that.';
      pushMsg('assistant', say, !!r.error);
      if (state.view === 'voice') { $('#voiceQuery').style.display = 'block'; $('#voiceQuery').textContent = text; $('#voiceAnswer').textContent = say; $('#voiceReply').style.display = 'flex'; }
      if (via === 'voice') speak(say);
      toast('Automation created');
    } catch (e) { pushMsg('assistant', 'Scheduling failed: ' + e.message, true); }
    return;
  }
  // watch: "/watch ...", or natural phrases like "let me know when...", "keep an eye on..."
  if (detectWatchIntent(text)) {
    const body = text
      .replace(/^\/?watch\s*(for)?\s*/i, '')
      .replace(/^(let me know|notify me|ping me|alert me|tell me)\s*(when|if)\s*/i, '')
      .replace(/^keep (an )?eye on\s*/i, '')
      .trim();
    if (!body) { pushMsg('assistant', 'Tell me what to watch for, e.g. "let me know when CPU goes above 90%" or "watch for Focus Guard going offline".', true); return; }
    pushMsg('user', text);
    try {
      const r = await api('/api/watchers', { body: { text: body } });
      const say = r.say || r.error || 'Could not set up that watcher.';
      pushMsg('assistant', say, !!r.error);
      if (state.view === 'voice') { $('#voiceQuery').style.display = 'block'; $('#voiceQuery').textContent = text; $('#voiceAnswer').textContent = say; $('#voiceReply').style.display = 'flex'; }
      if (via === 'voice') speak(say);
      toast('Watching for it');
    } catch (e) { pushMsg('assistant', 'Setting up the watcher failed: ' + e.message, true); }
    return;
  }
  // /remember is gone on purpose. It POSTed straight to /api/memory and then said "Noted. I’ll
  // remember that." WITHOUT LOOKING AT THE RESPONSE — the one reply in the app guaranteed to be true
  // regardless of what happened. Saying "remember that …" in plain chat goes through the server lane
  // instead, which reports what actually got stored.
  if (lower === '/new') { newChat(); return; }
  await sendChat(text, { via });
}

// ══════════ ATTACHED IMAGES ══════════
// The backend has accepted images since vision existed (/api/chat takes images:[{dataUrl,label}],
// up to four) — there was simply no way to hand it one from the UI. Screen capture existed; sending
// a photo, a diagram or a screenshot taken elsewhere did not.
//
// Three ways in, because the natural one differs by moment: the button, ⌘V paste, and drag-and-drop.
state.attachments = state.attachments || [];
const MAX_ATTACH = 4;                       // the server slices to 4; refusing here is honest about it

// Downscaled before sending. A full retina screenshot is several megabytes of base64, and vision
// prefill scales with pixels — measured on the local model, 1440px cost 13s a call against 3s at 900.
function shrinkImage(dataUrl, maxW) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, (maxW || 1100) / img.width);
      if (scale >= 1) return resolve(dataUrl);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function renderAttachments() {
  const strip = $('#attachStrip');
  if (!strip) return;
  if (!state.attachments.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
  strip.style.display = 'flex';
  strip.innerHTML = state.attachments.map((a, i) =>
    '<div style="position:relative;width:74px;height:74px;border-radius:10px;overflow:hidden;' +
    'border:1px solid rgba(255,255,255,0.16);background:#0b0b0b;">' +
    '<img src="' + a.dataUrl + '" style="width:100%;height:100%;object-fit:cover;">' +
    '<div data-rm="' + i + '" title="Remove" style="position:absolute;top:2px;right:2px;width:18px;height:18px;' +
    'border-radius:9px;background:rgba(0,0,0,0.7);color:#fff;font:600 12px/18px sans-serif;text-align:center;' +
    'cursor:pointer;">×</div></div>').join('');
  strip.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
    state.attachments.splice(Number(el.getAttribute('data-rm')), 1); renderAttachments();
  }));
}

async function addAttachment(file) {
  if (!file || !/^image\//.test(file.type)) { toast('That is not an image.'); return; }
  if (state.attachments.length >= MAX_ATTACH) { toast('Four images is the limit.'); return; }
  const raw = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
  }).catch(() => null);
  if (!raw) { toast('Could not read that image.'); return; }
  const dataUrl = await shrinkImage(raw, 1100);
  state.attachments.push({ dataUrl, label: file.name || 'attached image' });
  renderAttachments();
  toast(state.attachments.length + ' image' + (state.attachments.length === 1 ? '' : 's') + ' attached');
}

$('#qaAttach') && $('#qaAttach').addEventListener('click', () => $('#imgFile').click());
$('#imgFile') && $('#imgFile').addEventListener('change', async e => {
  for (const f of Array.from(e.target.files || [])) await addAttachment(f);
  e.target.value = '';
});
// Paste: the fastest route for a screenshot taken with ⌘⇧4, which lands on the clipboard.
document.addEventListener('paste', async e => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const imgs = items.filter(i => /^image\//.test(i.type));
  if (!imgs.length) return;
  e.preventDefault();
  for (const i of imgs) await addAttachment(i.getAsFile());
});
// Drop anywhere on the window; preventing the default stops the browser navigating to the file.
window.addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types||[]).includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async e => {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) await addAttachment(f);
});

// LOAD THE EMBEDDERS WHILE HE TYPES. A pause of more than a minute unloads them, and reloading
// inside the turn is what made "open youtube" take fifteen seconds. At most one request per 20s.
let lastPrewarm = 0;
function prewarm() {
  const now = Date.now();
  if (now - lastPrewarm < 20000) return;
  lastPrewarm = now;
  fetch('/api/prewarm', { method: 'POST' }).catch(() => {});
}
$('#cmdInput').addEventListener('input', prewarm);
$('#cmdInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const v = $('#cmdInput').value;
  $('#cmdInput').value = '';
  if ((v.trim() || state.attachments.length) && state.view !== 'chat' && state.view !== 'voice') setView('chat');
  if (state.attachments.length) {
    const imgs = state.attachments.slice();
    state.attachments = []; renderAttachments();
    sendChat(v.trim() || 'What is in this image?', { images: imgs, displayText: v.trim() || '[image]', via: 'typed' });
    return;
  }
  handleUserText(v, 'typed');
});
function newChat() {
  state.convo = [];
  saveConvo();
  renderConvo();
  $('#voiceReply').style.display = 'none';
  toast('New conversation started');
}
$('#btnNewChat').addEventListener('click', newChat);

// ---------------- voice (Web Speech API) ----------------
let recog = null;
function ensureRecog() {
  if (recog) return recog;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice needs Chrome (Web Speech API not available here).'); return null; }
  recog = new SR();
  recog.lang = 'en-US';
  recog.interimResults = true;
  recog.continuous = false;
  recog.onresult = e => {
    let interim = '', final = '';
    for (const r of e.results) { if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript; }
    // Speech has started, so the silence timer has done its job — cancel it. Otherwise a considered
    // four-second answer would be cut off exactly as it was being given.
    if (interim || final) clearTimeout(state.silenceTimer);
    if (interim && state.view === 'voice') $('#stateLine').textContent = '“' + interim + '…”';
    if (interim && world.open) { const a = document.getElementById('wmAnswer'); a.classList.add('show'); a.textContent = '“' + interim + '…”'; }
    if (final) {
      stopListening();
      // While the World Monitor is open, speech goes to the world feed (and is answered aloud).
      if (world.open) askWorld(final, 'voice'); else handleUserText(final, 'voice');
    }
  };
  recog.onerror = e => {
    stopListening();
    if (e.error === 'not-allowed') toast('Microphone blocked — allow mic access for localhost.');
    else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Voice error: ' + e.error);
    else if (e.error === 'no-speech') toast('Didn’t catch anything.');
  };
  recog.onend = () => { clearTimeout(state.silenceTimer); state.autoOpened = false; if (state.listening) { state.listening = false; $('#ptt').classList.remove('listening'); if (state.orb === 'listening') orbSet('idle'); } };
  return recog;
}
function startListening(opts) {
  try { prewarm(); } catch (e) {}
  const r = ensureRecog();
  if (!r) return;
  stopSpeaking(); // barge-in: stop JARVIS talking so the mic isn't picking up its own voice
  // He is about to speak, so a spoken answer is coming: load the voice model NOW, behind his own
  // sentence, instead of in the silence after the reply is ready. Fire and forget — nothing waits
  // on it, and if there is no local voice the server says so and this costs one cheap request.
  // Not while silent: the server refuses this anyway, but the whole point of the feature is that
  // piper never loads, and the cheapest way to guarantee that is not to ask.
  if (state.tts && !state.silent) { try { fetch('/api/speak/warm', { method: 'POST' }); } catch (e) {} }
  try { r.start(); } catch (e) {}
  state.listening = true;
  $('#ptt').classList.add('listening');
  orbSet('listening');
  // A MIC THAT OPENED ITSELF MUST CLOSE ITSELF. When JARVIS reopened the mic to hear an answer and
  // no answer comes, it shuts after a few seconds rather than sitting open indefinitely. The timer
  // is cancelled the moment any speech is heard (see recog.onresult) so a slow, considered answer is
  // never cut off mid-sentence — it only measures SILENCE, not thinking time.
  //
  // Deliberately not applied to the push-to-talk button: pressing the mic yourself is a request to
  // listen until you are done, and having it close under you would be its own bug.
  clearTimeout(state.silenceTimer);
  if (opts && opts.silenceMs) {
    state.autoOpened = true;
    state.silenceTimer = setTimeout(() => {
      if (state.listening) { stopListening(); toast('No answer — mic closed.'); }
    }, opts.silenceMs);
  } else {
    state.autoOpened = false;
  }
}
function stopListening() {
  state.listening = false;
  clearTimeout(state.silenceTimer);
  state.autoOpened = false;
  const wo = document.getElementById('wmOrb'); if (wo && !world.busy) wo.classList.remove('busy');
  $('#ptt').classList.remove('listening');
  if (recog) { try { recog.stop(); } catch (e) {} }
  if (state.orb === 'listening') orbSet('idle');
}
$('#ptt').addEventListener('click', () => state.listening ? stopListening() : startListening());
$('#orbCore').addEventListener('click', () => state.listening ? stopListening() : startListening());

// ---------------- wake word ("hey jarvis") ----------------
// The phrase is detected OUTSIDE the browser, by the clap daemon, using on-device macOS speech —
// so no audio leaves the Mac and there is exactly one process holding the microphone. All this side
// does is notice that a wake is waiting and do precisely what clicking the orb does.
//
// Collected on FOCUS rather than by polling: "hey jarvis" opens the app, so either the window is
// being launched (load fires) or it is being brought forward (focus fires). Both are the moment the
// flag is worth reading, and neither costs a request while he is doing something else. A slow poll
// backs it up only while the window is actually visible, in case focus is missed.
async function collectWake() {
  if (state.listening) return;                       // already listening — nothing to arm
  try {
    // No token header here on purpose: fetch is wrapped at the top of this file to attach it to
    // every same-origin /api call, and TOKEN is closure-scoped to that wrapper.
    const r = await fetch('/api/wake');
    const j = await r.json();
    if (!j || !j.pending) return;
    // Speak nothing here. A wake that announces itself talks over the very command it is waiting
    // for, and the microphone would hear JARVIS instead of him.
    //
    // Being SUMMONED is not the same as being opened. Called by name, he should be listening, not
    // introducing himself — the opening greeting is a spoken paragraph, and it was playing over the
    // command the wake word exists to capture, so the mic heard the greeting instead of Mihir.
    suppressGreetingForWake();
    // A cold launch runs ~4.5s of boot animation first. Starting the mic underneath it would burn
    // the listening window on a sound effect, so the boot hands over when it clears instead.
    if (bootStillShowing()) return;
    beginWakeListening();
  } catch (e) { /* server briefly unreachable — the next focus will try again */ }
}
window.addEventListener('focus', collectWake);
document.addEventListener('visibilitychange', () => { if (!document.hidden) collectWake(); });
setInterval(() => { if (!document.hidden) collectWake(); }, 2500);
collectWake();

// ---------------- vision ----------------
async function listCams() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter(d => d.kind === 'videoinput');
}
async function startCam(which, deviceId) {
  stopCam(which);
  if (!deviceId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1280 } } });
    state.streams[which] = stream;
    $(which === 'a' ? '#camA' : '#camB').srcObject = stream;
  } catch (e) { toast('Camera failed: ' + e.message); }
}
function stopCam(which) {
  const s = state.streams[which];
  if (s) { s.getTracks().forEach(t => t.stop()); state.streams[which] = null; }
  $(which === 'a' ? '#camA' : '#camB').srcObject = null;
}
async function startVision() {
  try {
    // prime permission so device labels populate
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (e) { toast('Camera access denied — allow it for localhost.'); return; }
  const cams = await listCams();
  const selA = $('#selA'), selB = $('#selB');
  selA.innerHTML = ''; selB.innerHTML = '<option value="">— second camera off —</option>';
  cams.forEach((c, i) => {
    const label = c.label || ('Camera ' + (i + 1));
    selA.appendChild(new Option(label, c.deviceId));
    selB.appendChild(new Option(label, c.deviceId));
  });
  const builtin = cams.find(c => /facetime|built-in/i.test(c.label));
  const external = cams.find(c => builtin ? c.deviceId !== builtin.deviceId : false);
  selA.value = (builtin || cams[0] || {}).deviceId || '';
  await startCam('a', selA.value);
  if (external) { selB.value = external.deviceId; await startCam('b', selB.value); }
}
function stopVision() { stopCam('a'); stopCam('b'); }
$('#selA').addEventListener('change', () => startCam('a', $('#selA').value));
$('#selB').addEventListener('change', () => startCam('b', $('#selB').value));

function snapshot(videoEl, label) {
  if (!videoEl.srcObject || !videoEl.videoWidth) return null;
  const scale = Math.min(1, 1024 / videoEl.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(videoEl.videoWidth * scale);
  c.height = Math.round(videoEl.videoHeight * scale);
  c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', 0.8), label };
}
async function visionAsk() {
  const q = $('#visionQ').value.trim() || 'What do you see?';
  $('#visionQ').value = '';
  const images = [snapshot($('#camA'), 'Camera 1 snapshot'), snapshot($('#camB'), 'Camera 2 snapshot')].filter(Boolean);
  if (!images.length) { toast('No live camera feed to capture.'); return; }
  const log = $('#visionLog');
  const uEl = msgEl('user', q); log.prepend(uEl);
  const jEl = msgEl('assistant', 'Looking…'); log.prepend(jEl);
  orbSet('thinking');
  try {
    const msgs = state.visionConvo.slice(-6).concat([{ role: 'user', content: q }]);
    const r = await api('/api/chat', { body: { messages: msgs, images, useFaces: $('#useFaces').checked } });
    const txt = r.error || r.reply || '(no reply)';
    jEl.querySelector('.txt').textContent = txt;
    if (r.error) jEl.classList.add('err');
    else { state.visionConvo.push({ role: 'user', content: q }, { role: 'assistant', content: r.reply }); }
  } catch (e) { jEl.querySelector('.txt').textContent = 'Vision failed: ' + e.message; jEl.classList.add('err'); }
  orbSet('idle');
}
$('#btnVisionAsk').addEventListener('click', visionAsk);
$('#visionQ').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) visionAsk(); });

// ---------------- files ----------------
async function loadFiles(p) {
  const r = await api('/api/files?p=' + encodeURIComponent(p || '.'));
  if (r.error) { toast(r.error); return; }
  state.filesPath = r.path || '.';
  $('#filesPath').textContent = 'JARVIS MK-1' + (r.path && r.path !== '.' ? ' / ' + r.path.split('/').join(' / ') : '');
  const list = $('#filesList');
  list.innerHTML = '';
  for (const e of r.entries) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const icon = e.dir
      ? '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" style="color:#5ed4f7;min-width:15px;"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.8h4.5A1.5 1.5 0 0 1 14 6.3v5.2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"></path></svg>'
      : '<span style="width:15px;min-width:15px;display:inline-block;text-align:center;color:rgba(190,235,255,0.6);">·</span>';
    const size = e.dir ? '' : (e.size > 1048576 ? (e.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(e.size / 1024)) + ' KB');
    row.innerHTML = icon + '<span class="fn" style="flex:1;font-size:13px;' + (e.dir ? 'font-weight:500;color:#dff5ff;' : 'color:rgba(255,255,255,0.75);') + '"></span>' +
      '<span class="mono" style="font-size:10px;color:rgba(255,255,255,0.35);">' + size + '</span>' +
      '<span class="mono" style="font-size:10px;color:rgba(255,255,255,0.3);">' + rel(e.mtime) + '</span>';
    row.querySelector('.fn').textContent = e.name + (e.dir ? ' /' : '');
    const target = (state.filesPath === '.' ? '' : state.filesPath + '/') + e.name;
    row.addEventListener('click', () => e.dir ? loadFiles(target) : api('/api/open', { body: { p: target } }));
    list.appendChild(row);
  }
  if (!r.entries.length) list.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:13px;padding:14px;">Empty folder.</div>';
}
$('#btnFilesUp').addEventListener('click', () => {
  if (state.filesPath === '.' || !state.filesPath.includes('/')) loadFiles('.');
  else loadFiles(state.filesPath.split('/').slice(0, -1).join('/') || '.');
});
$('#btnReveal').addEventListener('click', () => api('/api/open', { body: { p: state.filesPath, reveal: true } }));

// ---------------- memory ----------------
// The memory PANEL was removed deliberately. Seeing the store listed, with an × on every row,
// made forgetting a one-click accident and put the least reversible thing in the app behind the
// lowest-friction control in it. Memory now lives entirely in the backend: it is written by asking
// ("remember that …"), dropped by asking ("forget …"), and recalled when a question needs it.
// Nothing here reads or renders it, which is why there is no loadMemory() any more.

// ---------------- quick actions ----------------
$('#qaThink').addEventListener('click', () => {
  state.thinkNext = !state.thinkNext;
  $('#qaThink').classList.toggle('on', state.thinkNext);
  toast(state.thinkNext ? 'Think hard is on for your next question — it can take a few minutes.' : 'Think hard is off.');
  if (state.thinkNext) $('#cmdInput').focus();
});
$('#qaBriefing').addEventListener('click', () => {
  if (state.view !== 'voice') setView('chat');
  sendChat('Give me my briefing: system health, what’s scheduled, anything that needs me.', { brief: true, displayText: 'Briefing' });
});
$('#qaFocus').addEventListener('click', async () => {
  const on = !state.focusOn;
  const r = await api('/api/dnd', { body: { on } });
  if (r.ok) { state.focusOn = on; toast(on ? 'Focus mode engaged — Do Not Disturb on.' : 'Focus mode off.'); $('#qaFocus').style.color = on ? '#7de8b8' : ''; }
  else toast(r.error || 'Focus toggle failed.');
});
$('#qaCapture').addEventListener('click', () => {
  const q = $('#cmdInput').value.trim() || 'Here is my screen. What am I looking at? Anything notable?';
  $('#cmdInput').value = '';
  initiateScreenCheck(q, false);
});

// ---------------- overview polling (sidebar) ----------------
function dotColor(kind) { return kind === 'warn' ? '#f59e6b' : kind === 'ok' || kind === 'reminder' ? '#7de8b8' : '#5ed4f7'; }
// ---------------- link-lost screen ----------------
//
// The heartbeat below already ran every 5s and swallowed its failures in silence, so a phone whose
// Mac had gone to sleep showed a frozen but plausible-looking dashboard — stale numbers presented as
// current, which is the same class of lie as claiming a message was sent. Now it says so.
//
// TWO failures before showing anything: one miss is a dropped packet or a restart, and flashing a
// full-screen alarm on every hiccup would train him to ignore it. It clears on the first success.
//
// This can only cover a session that is ALREADY OPEN. If the app is launched cold while the Mac is
// unreachable, nothing of ours runs — the browser shows its own error, and changing that needs a
// service worker, which needs HTTPS.
const link = { fails: 0, lastOk: Date.now() };
function linkLostShow(show) {
  const el = document.getElementById('linkLost');
  if (!el) return;
  el.style.display = show ? 'flex' : 'none';
  if (!show) return;
  const secs = Math.round((Date.now() - link.lastOk) / 1000);
  const ago = secs < 60 ? secs + 's ago'
    : secs < 3600 ? Math.round(secs / 60) + ' min ago'
    : Math.round(secs / 3600) + ' h ago';
  const meta = document.getElementById('llMeta');
  if (meta) meta.textContent = 'LAST CONTACT ' + ago.toUpperCase();
}
function linkOk() { link.fails = 0; link.lastOk = Date.now(); linkLostShow(false); }
function linkFail() { if (++link.fails >= 2) linkLostShow(true); }

async function poll() {
  // `reached` separates a genuine network failure from a rendering error further down: this try
  // block wraps the whole DOM update, so without it a broken selector would raise "cannot reach
  // JARVIS" about a server that answered perfectly. Only a throw BEFORE the response arrived counts.
  let reached = false;
  try {
    const o = await api('/api/overview');
    reached = true;
    linkOk();
    state.tts = !!o.tts;   // server has a neural voice; otherwise speak() stays on Web Speech
    state.silent = !!o.silent;  // visual-silent mode: text only, and piper never loads
    if (o.runningApps != null && $('#runApps')) $('#runApps').textContent = o.runningApps;
    const s = o.stats;
    $('#cpuPct').textContent = s.cpu + '%';
    $('#cpuW').style.width = s.cpu + '%';
    $('#ramPct').textContent = s.ramPct != null ? s.ramPct + '% · ' + s.ramUsedGB + '/' + s.ramTotalGB + ' GB' : '—';
    $('#ramW').style.width = (s.ramPct || 0) + '%';
    $('#battPct').textContent = s.batteryPct != null ? s.batteryPct + '%' + (s.charging ? ' ⚡' : '') : '—';
    $('#battW').style.width = (s.batteryPct || 0) + '%';
    $('#diskLine').textContent = s.diskPct != null ? s.diskPct + '% used · ' + s.diskFreeGB + ' GB free' : '—';
    $('#latency').textContent = s.latency != null ? s.latency + ' ms' : 'offline';
    // Connectivity check runs every 5s regardless of view, so the World Monitor (if open) reacts
    // to a dropped/restored connection on its own, without the user having to reopen it.
    const wasOnline = state.online;
    state.online = s.latency != null;
    if (world.open && state.online !== wasOnline) {
      setWorldOffline(!state.online);
      if (state.online) resumeWorldStage();  // connection just came back — load what never loaded
    }
    const warn = (s.batteryPct != null && !s.charging && s.batteryPct <= 20) || (s.diskPct || 0) >= 90;
    $('#sysState').innerHTML = warn
      ? '<span style="width:5px;height:5px;border-radius:50%;background:#f59e6b;box-shadow:0 0 8px rgba(245,158,107,0.8);"></span>Attention'
      : '<span style="width:5px;height:5px;border-radius:50%;background:#7de8b8;box-shadow:0 0 8px rgba(125,232,184,0.8);"></span>Nominal';
    $('#sysState').style.color = warn ? '#f59e6b' : '#7de8b8';

    // fleet
    const tl = $('#tasksList');
    tl.innerHTML = '';
    for (const a of o.agents || []) {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const c = a.running ? '#7de8b8' : '#ff9d8a';
      d.innerHTML = '<span style="width:7px;height:7px;min-width:7px;border-radius:50%;background:' + c + ';box-shadow:0 0 8px ' + c + ';"></span><span style="flex:1;">' + a.name + '</span><span class="mono" style="font-size:9.5px;color:rgba(255,255,255,0.35);">' + (a.running ? 'ONLINE' : 'DOWN') + '</span>';
      tl.appendChild(d);
    }

    // today
    const w = o.weather;
    if (w) {
      $('#weatherLine').textContent = w.temp + '°' + (w.unit || '') + ' ' + w.desc;
      $('#weatherLine').title = (w.city ? w.city + ' · ' : '') + 'feels like ' + w.feelsLike + '°' + (w.humidity != null ? ' · ' + w.humidity + '% humidity' : '');
    } else {
      $('#weatherLine').textContent = '';
      $('#weatherLine').title = '';
    }
    const td = $('#todayList');
    td.innerHTML = '';
    for (const a of o.automations || []) {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;gap:11px;align-items:baseline;';
      d.innerHTML = '<span class="mono" style="font-size:11px;color:rgba(94,212,247,0.85);min-width:42px;">' + new Date(a.next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span><div style="flex:1;"><div class="at" style="font-size:12.5px;"></div><div style="font-size:10.5px;color:rgba(255,255,255,0.4);">' + (a.repeat !== 'none' ? 'repeats ' + a.repeat : new Date(a.next).toLocaleDateString([], { weekday: 'long' })) + '</div></div>';
      d.querySelector('.at').textContent = a.title;
      td.appendChild(d);
    }
    if (!(o.automations || []).length) td.innerHTML = '<div style="font-size:11.5px;color:rgba(255,255,255,0.35);">Clear schedule. Use /schedule to add tasks.</div>';

    // notifications
    const nl = $('#notifList');
    nl.innerHTML = '';
    const notifs = o.notifications || [];
    for (const n of notifs) {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;gap:10px;align-items:flex-start;';
      const c = dotColor(n.kind);
      d.innerHTML = '<span style="width:6px;height:6px;min-width:6px;border-radius:50%;background:' + c + ';box-shadow:0 0 8px ' + c + ';margin-top:5px;"></span><div style="flex:1;"><div class="nt" style="font-size:12.5px;"></div><div class="nd" style="font-size:10.5px;color:rgba(255,255,255,0.4);"></div></div><span class="mono" style="font-size:9px;color:rgba(255,255,255,0.25);margin-top:2px;">' + rel(n.at) + '</span><span class="del-x nx" style="font-size:12px;line-height:1;padding:0 2px;margin-top:1px;">×</span>';
      d.querySelector('.nt').textContent = n.title;
      d.querySelector('.nd').textContent = n.detail || '';
      d.querySelector('.nx').addEventListener('click', () => dismissNotif(n.id, d));
      nl.appendChild(d);
      // browser notification for new persisted events
      if (!n.computed && !state.seenNotifs.has(n.id)) {
        state.seenNotifs.add(n.id);
        try { if (Notification.permission === 'granted') new Notification('JARVIS — ' + n.title, { body: n.detail || '' }); } catch (e) {}
      }
    }
    $('#notifClearAll').style.display = notifs.length ? 'inline' : 'none';
    if (!notifs.length) nl.innerHTML = '<div style="font-size:11.5px;color:rgba(255,255,255,0.35);">All quiet.</div>';
    localStorage.setItem('jarvis.seenNotifs', JSON.stringify(Array.from(state.seenNotifs).slice(-100)));
  } catch (e) { if (!reached) linkFail(); }
}
async function dismissNotif(id, rowEl) {
  if (rowEl) rowEl.remove();                          // instant feedback
  try { await fetch('/api/notifications?id=' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {}
  poll();                                             // reconcile with server
}
async function clearAllNotifs() {
  $('#notifList').innerHTML = '<div style="font-size:11.5px;color:rgba(255,255,255,0.35);">All quiet.</div>';
  $('#notifClearAll').style.display = 'none';
  try { await fetch('/api/notifications', { method: 'DELETE' }); } catch (e) {}
  poll();
}
$('#notifClearAll').addEventListener('click', clearAllNotifs);
setInterval(poll, 5000);
poll();
// Retry immediately rather than waiting out the 5s tick, and refresh the "last contact" line while
// the screen is up so it does not sit there showing a stale age.
(function () {
  const btn = document.getElementById('llRetry');
  if (btn) btn.addEventListener('click', () => { linkLostShow(true); poll(); });
  setInterval(() => { if (link.fails >= 2) linkLostShow(true); }, 1000);
  // A phone that has been in his pocket resumes with a dead socket; check the moment it wakes
  // instead of after the next interval, which is what makes the screen feel responsive on mobile.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();

// ask notification permission on first interaction
document.body.addEventListener('click', function once() {
  document.body.removeEventListener('click', once);
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
});

// ---------------- system log console (⌘L) ----------------
const SRC_COLORS = { 'Clap': '#5ed4f7', 'Config': '#a78bfa', 'Dashboard': '#34d399', 'Focus': '#f59e6b', 'Control': '#3b82f6', 'JARVIS OS': '#eafaff' };
const logState = { open: false, paused: false, seq: 0, entries: [], active: new Set(), search: '', timer: null, built: false };

function logTime(ts) { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function logMatches(e) {
  if (logState.active.size && !logState.active.has(e.source)) return false;
  if (logState.search && !(e.text.toLowerCase().includes(logState.search) || e.source.toLowerCase().includes(logState.search))) return false;
  return true;
}
function logLineEl(e) {
  const d = document.createElement('div');
  d.className = 'lg ' + e.level;
  d.innerHTML = '<span class="lg-t"></span><span class="lg-s"></span><span class="lg-m"></span>';
  d.querySelector('.lg-t').textContent = logTime(e.ts);
  const s = d.querySelector('.lg-s'); s.textContent = e.source; s.style.color = SRC_COLORS[e.source] || '#9fe6ff';
  d.querySelector('.lg-m').textContent = e.text;
  return d;
}
function logUpdateCount() {
  const shown = document.querySelectorAll('#logBody .lg').length;
  $('#logCount').textContent = shown + ' shown · ' + logState.entries.length + ' events';
}
function logRerender() {
  const body = $('#logBody'); body.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const e of logState.entries) if (logMatches(e)) frag.appendChild(logLineEl(e));
  body.appendChild(frag);
  body.scrollTop = body.scrollHeight;
  logUpdateCount();
}
function logAppend(entries) {
  const body = $('#logBody');
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const frag = document.createDocumentFragment();
  for (const e of entries) { logState.entries.push(e); if (logMatches(e)) frag.appendChild(logLineEl(e)); }
  if (logState.entries.length > 5000) logState.entries.splice(0, logState.entries.length - 5000);
  body.appendChild(frag);
  if (stick) body.scrollTop = body.scrollHeight;
  logUpdateCount();
}
function buildLogFilters(sources) {
  const wrap = $('#logFilters'); wrap.innerHTML = '';
  const all = document.createElement('div'); all.className = 'log-chip on'; all.textContent = 'ALL';
  all.onclick = () => { logState.active.clear(); wrap.querySelectorAll('.log-chip').forEach(c => c.classList.remove('on')); all.classList.add('on'); logRerender(); };
  wrap.appendChild(all);
  for (const src of sources) {
    const c = document.createElement('div'); c.className = 'log-chip'; c.textContent = src.toUpperCase();
    c.onclick = () => {
      all.classList.remove('on');
      if (logState.active.has(src)) { logState.active.delete(src); c.classList.remove('on'); }
      else { logState.active.add(src); c.classList.add('on'); }
      if (!logState.active.size) all.classList.add('on');
      logRerender();
    };
    wrap.appendChild(c);
  }
  logState.built = true;
}
async function logFetchInitial() {
  try {
    const r = await api('/api/logs');
    logState.seq = r.seq; logState.entries = r.entries || [];
    if (!logState.built) buildLogFilters(r.sources || []);
    logRerender();
  } catch (e) {}
}
async function logPoll() {
  if (logState.paused || !logState.open) return;
  try { const r = await api('/api/logs?after=' + logState.seq); logState.seq = r.seq; if (r.entries && r.entries.length) logAppend(r.entries); } catch (e) {}
}
function openLog() {
  if (logState.open) return; logState.open = true;
  $('#logConsole').classList.remove('log-hidden');
  if (!logState.entries.length) logFetchInitial(); else logRerender();
  logState.timer = setInterval(logPoll, 1300);
  setTimeout(() => $('#logSearch').focus(), 60);
}
function closeLog() {
  logState.open = false;
  $('#logConsole').classList.add('log-hidden');
  clearInterval(logState.timer); logState.timer = null;
}
function toggleLog() { logState.open ? closeLog() : openLog(); }
$('#logClose').addEventListener('click', closeLog);
$('#logBtn').addEventListener('click', toggleLog);
$('#logLive').addEventListener('click', () => {
  logState.paused = !logState.paused;
  const el = $('#logLive');
  el.classList.toggle('paused', logState.paused);
  el.textContent = logState.paused ? '❚❚ PAUSED' : '● LIVE';
});
$('#logSearch').addEventListener('input', e => { logState.search = e.target.value.trim().toLowerCase(); logRerender(); });
$('#logSearch').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeLog(); } });
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) {
    if (document.getElementById('boot')) return;   // ignore during boot
    e.preventDefault(); toggleLog();
  } else if (e.key === 'Escape' && logState.open) { closeLog(); }
});

// ---------------- WORLD MONITOR (⌘⇧W) ----------------
const world = { open: false, globe: null, loading: false, data: null, timer: null };
// Connectivity is decided in ONE place — the same ping-based signal already shown in the System
// panel (`s.latency`, null = unreachable) — so "offline" means the same thing everywhere in the UI.
// Starts `true` (optimistic): JARVIS has just booted and the first probe hasn't landed yet, so a
// real "no internet" state must be OBSERVED (state.online === false), never assumed from silence.
state.online = true;
function setWorldOffline(off) {
  world.offline = !!off;
  const el = document.getElementById('wmOffline');
  if (el) el.classList.toggle('show', world.offline);
}
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-src="' + src + '"]')) return resolve();
    const s = document.createElement('script'); s.src = src; s.dataset.src = src;
    s.onload = resolve; s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}
const SEV_COLOR = { high: '#ff5a5a', med: '#ffb454', low: '#5ed4f7', node: 'rgba(94,212,247,0.9)' };
// ONE colour table for every marker kind — the globe, the 2D map and the LEGEND all read it, so the legend can never show a
// colour nothing is drawn in (the old strip listed #ff4d4d/#ffa53c/#ffd93d while markers were #ff5a5a/#ffb454/#5ed4f7).
const WM_COLORS = { natural: '#ff8a3c', launch: '#ffffff', cyclone: '#c58bff', node: 'rgba(94,212,247,0.9)',
  flights: 'rgba(255,214,130,0.9)', military: '#ff6ad5', sats: 'rgba(158,247,255,0.95)', starlink: 'rgba(120,150,255,0.7)', path: 'rgba(158,247,255,0.7)' };
// Open a source link in the real browser (macOS `open` via the whitelisted open_url action) so it
// works both in the plain browser and the native WKWebView shell.
function openExt(url) {
  if (!url || !/^https?:\/\//.test(url)) return;
  api('/api/action', { body: { type: 'open_url', target: url } }).catch(() => window.open(url, '_blank'));
  toast('Opening source…');
}
window.openExt = openExt;
async function initGlobe() {
  await loadScriptOnce('/vendor/globe.gl.min.js');
  const countries = await fetch('/vendor/countries.geojson').then(r => r.json());
  world.countries = countries.features;
  const el = document.getElementById('worldGlobe');
  // REALISTIC EARTH (2026-10-14, his ask: "more realistic compared to other world monitor / god's eye view things").
  // NASA Blue Marble by day, Black Marble city lights on the night side — blended at the REAL terminator for this
  // minute — with relief, ocean glint, a drifting cloud layer, a starfield, and the sun lighting the globe from where it
  // actually is. Textures are local (vendor/earth/README.md). The old hex-dot hologram is the "HUD grid" layer.
  const g = Globe()(el)
    .backgroundColor('#000005')
    .backgroundImageUrl('/vendor/earth/night-sky.png')
    .globeImageUrl('/vendor/earth/earth-blue-marble.jpg')
    .bumpImageUrl('/vendor/earth/earth-topology.png')
    .showGlobe(true).showAtmosphere(true)
    .atmosphereColor('#7cbcff').atmosphereAltitude(0.18)
    .hexPolygonResolution(3).hexPolygonMargin(0.32).hexPolygonUseDots(true)
    .hexPolygonColor(() => 'rgba(94,212,247,0.55)')
    .polygonCapColor(() => 'rgba(0,0,0,0)').polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor(() => 'rgba(220,235,255,0.28)').polygonAltitude(0.0025)
    .pointLat('lat').pointLng('lon').pointColor(d => d.kind === 'event' ? WM_COLORS.natural : d.kind === 'launch' ? WM_COLORS.launch : d.kind === 'cyclone' ? WM_COLORS.cyclone : (SEV_COLOR[d.sev] || SEV_COLOR.low))
    // markers sit ON the surface as glowing discs — the old tall bars read as spikes on a realistic Earth
    .pointAltitude(d => d.kind === 'launch' ? 0.012 : 0.006)
    .pointRadius(d => d.kind === 'launch' || d.kind === 'cyclone' ? 0.5 : 0.2 + (d.mag || 1) * 0.07).pointResolution(24)
    .pointLabel(d => '<div style="font:600 12px Inter;color:#fff;background:rgba(6,14,24,.92);padding:7px 10px;border-radius:8px;border:1px solid rgba(94,212,247,.4);max-width:260px">' + pointTitle(d) + '<br><span style="font-size:10px;color:#8fd4ff">' + (d.source || '') + ' · click for details</span></div>')
    .onPointClick(d => showEventInfo(d))
    .ringLat('lat').ringLng('lon').ringColor(d => (t => (d.kind === 'cyclone' ? 'rgba(197,139,255,' : 'rgba(94,212,247,') + (1 - t) + ')'))
    .ringMaxRadius(d => d.kind === 'cyclone' ? 4.5 : 3.2).ringPropagationSpeed(1.4).ringRepeatPeriod(1400)
    // live layers: thousands of moving points as particles (one draw call per set), stations as labels, the ISS track as a path
    .particlesList(d => d.points).particleLat('lat').particleLng('lng').particleAltitude('alt')
    .particlesColor(d => d.color).particlesSize(d => d.size).particlesSizeAttenuation(false)
    // NO HOVER LABEL ON PARTICLES. globe.gl's default is the string 'name', read off what it takes for the hovered
    // point: set[index] — but a set here is {kind, color, size, points}, not an array, so that is undefined, and
    // reading .name off it threw inside the render loop the moment the pointer crossed a flight or a satellite on
    // the way to anything else. The loop never restarts after a throw: the globe froze and stopped taking input
    // (2026-10-14, his report). Clicks still reach the nearest aircraft or satellite through onWorldClick.
    .particleLabel(() => '')
    .labelLat('lat').labelLng('lng').labelAltitude('alt').labelText('name').labelSize(0.55).labelDotRadius(0.28)
    .labelColor(() => 'rgba(158,247,255,0.95)').labelResolution(2)
    .pathPoints('pts').pathPointLat(p => p[0]).pathPointLng(p => p[1]).pathPointAlt(p => p[2])
    .pathColor(() => ['rgba(158,247,255,0.05)', 'rgba(158,247,255,0.7)']).pathStroke(1.2).pathTransitionDuration(0)
    .onGlobeClick(({ lat, lng }) => onWorldClick(lat, lng))
    .onGlobeReady(() => { try { makeRealistic(g); } catch (e) { console.warn('realism', e); } });
  const c = g.controls(); c.autoRotate = true; c.autoRotateSpeed = 0.25; c.enableZoom = true; c.enableDamping = true; c.dampingFactor = 0.08;
  world.globe = g;
  window.addEventListener('resize', () => { if (world.open) { g.width(el.clientWidth); g.height(el.clientHeight); } });
  g.width(el.clientWidth); g.height(el.clientHeight);
  return g;
}

// Where the sun is overhead right now (declination + equation of time; good to about half a degree).
function subsolarPoint(d) {
  d = d || new Date();
  const day = (d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000;
  const decl = -23.44 * Math.cos(2 * Math.PI / 365 * (day + 10));
  const B = 2 * Math.PI * (day - 81) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);   // minutes
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const lng = -15 * ((utcMin + eot) / 60 - 12);
  return { lat: decl, lng: ((lng + 540) % 360) - 180 };
}

// Night lights, ocean glint, clouds and a true sun — added once the day texture has loaded. three.js is bundled inside
// globe.gl rather than exposed, so its classes are taken from objects the globe already made (a texture, a light, a mesh).
function makeRealistic(g) {
  const m = g.globeMaterial();
  if (!m || !m.map) return;
  const Tex = m.map.constructor;
  const V3 = g.camera().position.constructor;
  const load = (src, srgb) => new Promise(res => {
    const img = new Image();
    img.onload = () => { const t = new Tex(img); if (srgb) t.colorSpace = m.map.colorSpace; t.anisotropy = 4; t.needsUpdate = true; res(t); };
    img.onerror = () => res(null);
    img.src = src;
  });
  // The sun: a dim sky-fill for the night side plus a directional light where the sun really is.
  const lights = g.lights();
  const amb = lights.find(l => l.isAmbientLight), dir = lights.find(l => l.isDirectionalLight);
  if (amb) amb.intensity = 0.55;
  if (dir) dir.intensity = 3.2;
  world.sunDir = { value: new V3(1, 0, 0) };
  const placeSun = () => {
    const s = subsolarPoint();
    const p = g.getCoords(s.lat, s.lng, 0);
    const v = new V3(p.x, p.y, p.z).normalize();
    world.sunDir.value.copy(v);
    if (dir) { dir.position.copy(v.clone().multiplyScalar(500)); if (dir.target) dir.target.position.set(0, 0, 0); }
  };
  placeSun(); clearInterval(world._sun); world._sun = setInterval(placeSun, 60000);
  // Ocean glint: the water mask as a specular map.
  load('/vendor/earth/earth-water.png', false).then(t => {
    if (!t) return;
    m.specularMap = t; if (m.specular) m.specular.setRGB(0.22, 0.27, 0.33); m.shininess = 22; m.needsUpdate = true;
  });
  // City lights on the night side, faded in across the terminator — a small addition to the globe's own shader.
  load('/vendor/earth/earth-night.jpg', true).then(night => {
    if (!night) return;
    m.onBeforeCompile = sh => {
      sh.uniforms.nightMap = { value: night };
      sh.uniforms.sunDir = world.sunDir;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldN;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D nightMap;\nuniform vec3 sunDir;\nvarying vec3 vWorldN;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n{ float d = dot(normalize(vWorldN), normalize(sunDir));' +
          ' float n = smoothstep(0.10, -0.20, d); vec3 l = texture2D(nightMap, vMapUv).rgb;' +
          ' gl_FragColor.rgb = gl_FragColor.rgb * mix(1.0, 0.55, n) + l * l * n * 1.7; }');
    };
    m.customProgramCacheKey = () => 'jarvis-day-night';
    m.needsUpdate = true;
  });
  // A cloud layer just above the surface, drifting slowly (NASA's cloud composite — not live weather).
  load('/vendor/earth/clouds.jpg', false).then(ct => {
    if (!ct) return;
    let globeMesh = null;
    g.scene().traverse(o => { if (!globeMesh && o.material === m) globeMesh = o; });
    if (!globeMesh) return;
    const R = g.getGlobeRadius();
    const geo = new globeMesh.geometry.constructor(R * 1.006, 75, 75);
    const mat = new m.constructor({ color: 0xffffff, alphaMap: ct, transparent: true, opacity: 0.75, depthWrite: false });
    const clouds = new globeMesh.constructor(geo, mat);
    clouds.rotation.y = globeMesh.rotation.y;
    g.scene().add(clouds);
    world.clouds = clouds;
    const spin = () => { if (!world.open) return; if (world.clouds && !document.hidden) world.clouds.rotation.y += 0.00012; world._cloudRaf = requestAnimationFrame(spin); };
    world._spinClouds = spin; cancelAnimationFrame(world._cloudRaf); spin();
  });
}
const esc = s => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function relTime(ms) { if (!ms) return ''; const m = Math.round((Date.now() - ms) / 60000); if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); return h < 24 ? h + ' hr ago' : Math.round(h / 24) + ' d ago'; }
// A basic, instant, offline summary of one marker — "what it is", built from the feed fields.
function eventSummary(d) {
  if (!d) return { title: '', body: '' };
  if (d.kind === 'quake') return { title: 'M' + (d.mag || '?') + ' Earthquake', body: 'A magnitude ' + (d.mag || '?') + ' earthquake ' + (d.title || '') + '.' + (d.time ? ' Recorded ' + relTime(d.time) + '.' : '') + ' Detected and located by the USGS seismic network.', source: 'USGS', url: d.url };
  if (d.kind === 'event') return { title: d.cat || 'Natural Event', body: 'An active ' + (d.cat || 'natural event').toLowerCase() + ' — “' + (d.title || '') + '” — currently being tracked by NASA’s Earth Observatory (EONET).', source: 'NASA EONET', url: d.url };
  if (d.kind === 'disaster') return { title: (d.alert || '') + ' ' + (d.cat || 'Disaster'), body: 'A ' + String(d.alert || '').toLowerCase() + '-level ' + (d.cat || 'disaster').toLowerCase() + ' alert from GDACS (the UN/EC Global Disaster Alert system): ' + (d.title || '') + '.', source: 'GDACS', url: d.url };
  if (d.kind === 'launch') {
    const l = d.l, when = Date.parse(l.net), past = when < Date.now();
    return { title: 'Launch · ' + l.name, body: (l.provider ? l.provider + ' · ' : '') + (l.rocket || '') + (l.orbit ? ' to ' + l.orbit : '') + '. ' +
      (past ? 'Launched ' : 'Scheduled ') + new Date(when).toLocaleString() + ' (' + (l.status || '?') + ') from ' + (l.where || l.pad) + '.' +
      (l.about ? ' ' + l.about.slice(0, 220) + (l.about.length > 220 ? '…' : '') : ''), source: 'The Space Devs · Launch Library 2', url: '' };
  }
  if (d.kind === 'cyclone') {
    const c = d.c;
    return { title: c.name + ' · ' + (c.cls || 'cyclone'), body: (c.kt ? c.kt + ' kt sustained winds' : 'Intensity unknown') + (c.mb ? ', ' + c.mb + ' mb' : '') +
      (c.dir != null ? '; moving ' + c.dir + '° at ' + (c.mph || '?') + ' mph' : '') + '. Last NHC update ' + (c.updated || '?') + '.', source: 'NOAA National Hurricane Center', url: c.url };
  }
  return { title: d.name || 'Node', body: (d.name || '') + ' — a monitored geopolitical hotspot.', source: '', url: '' };
}
function pointTitle(d) {
  if (d.kind === 'launch') return 'Launch: ' + esc(d.title) + ' — ' + new Date(Date.parse(d.l.net)).toLocaleDateString();
  if (d.kind === 'cyclone') return esc(d.title) + ' · ' + esc(d.c.cls || '') + (d.c.kt ? ' · ' + d.c.kt + ' kt' : '');
  return (d.mag ? 'M' + d.mag + '  ' : d.cat ? esc(d.cat) + ': ' : '') + esc(d.title || d.name || '');
}
function showEventInfo(d) {
  const s = eventSummary(d); const ans = document.getElementById('wmAnswer');
  ans.classList.add('show');
  ans.innerHTML = '<div style="font-weight:700;color:#dff5ff;margin-bottom:5px">' + esc(s.title) + '</div>' + esc(s.body) +
    (s.url ? '<div class="wm-ans-src"><span class="wm-src" onclick="openExt(\'' + esc(s.url) + '\')">Open full report — ' + esc(s.source) + ' ↗</span></div>' : (s.source ? '<div class="wm-ans-src">Source: ' + esc(s.source) + '</div>' : ''));
}
function showEventByIdx(i) { showEventInfo((world.bigList || [])[i]); }
window.showEventByIdx = showEventByIdx;
// Which marker layers are shown on the globe — toggled by the LAYERS chips.
world.layers = { quake: true, event: true, disaster: true, node: true,
  flights: true, military: true, sats: true, starlink: false, launches: true, cyclones: true, borders: true, grid: false };
const liveN = f => () => { try { return f(); } catch (e) { return 0; } };
const LAYER_META = [
  { key: 'quake', label: 'Seismic', color: '#5ed4f7', src: 'quakes' },
  { key: 'event', label: 'Natural', color: WM_COLORS.natural, src: 'events' },
  { key: 'disaster', label: 'Disasters', color: '#ff5a5a', src: 'disasters' },
  { key: 'node', label: 'Watch nodes', color: WM_COLORS.node, src: 'nodes' },
  { key: 'flights', label: 'Flights', color: WM_COLORS.flights, count: liveN(() => world.live.flights.rows.length) },
  { key: 'military', label: 'Military air', color: WM_COLORS.military, count: liveN(() => world.live.military.rows.length) },
  { key: 'sats', label: 'Satellites', color: WM_COLORS.sats, count: liveN(() => world.live.sats.filter(s => s.group !== 'starlink').length) },
  { key: 'starlink', label: 'Starlink', color: WM_COLORS.starlink, count: liveN(() => world.live.sats.filter(s => s.group === 'starlink').length) },
  { key: 'launches', label: 'Launches', color: WM_COLORS.launch, count: liveN(() => launchPoints().length) },
  { key: 'cyclones', label: 'Cyclones', color: WM_COLORS.cyclone, count: liveN(() => world.live.cyclones.length) },
  { key: 'borders', label: 'Borders', color: 'rgba(220,235,255,0.6)' },
  { key: 'grid', label: 'HUD grid', color: 'rgba(94,212,247,0.55)' },
];
// Launch pads with a launch in the next 30 days or the last 7, and active cyclones, as clickable points.
function launchPoints() {
  const L = world.live.launches; if (!L) return [];
  const now = Date.now(), out = [];
  for (const l of [...(L.upcoming || []), ...(L.recent || [])]) {
    const t = Date.parse(l.net); if (l.lat == null || l.lon == null || !isFinite(t)) continue;
    if (t > now + 30 * 86400000 || t < now - 7 * 86400000) continue;
    out.push({ kind: 'launch', lat: l.lat, lon: l.lon, title: l.name, l, source: 'Launch Library 2' });
  }
  return out;
}
function cyclonePoints() { return (world.live.cyclones || []).map(c => ({ kind: 'cyclone', lat: c.lat, lon: c.lon, title: c.name, c, source: 'NOAA NHC', url: c.url })); }
function applyLayers() {
  if (!world.globe || !world.data) return;
  const d = world.data; const pts = [];
  const v = (typeof lensData === 'function') ? lensData(d) : d;   // lens narrows the globe too
  if (world.layers.quake) pts.push(...(v.quakes || []));
  if (world.layers.event) pts.push(...(v.events || []));
  if (world.layers.disaster) pts.push(...(v.disasters || []));
  if (world.layers.launches) pts.push(...launchPoints());
  if (world.layers.cyclones) pts.push(...cyclonePoints());
  world.globe.pointsData(pts);
  const rings = [...(world.layers.node ? (d.nodes || []) : []), ...(world.layers.cyclones ? cyclonePoints() : [])];
  world.globe.ringsData(rings);
  if (world.scene) { world.scene.points = pts; world.scene.rings = rings; }   // the 2D map draws the same scene
  world.globe.polygonsData(world.layers.borders ? (world.countries || []) : []);
  world.globe.hexPolygonsData(world.layers.grid ? (world.countries || []) : []);
  if (typeof liveFrame === 'function') liveFrame();
}
window.toggleLayer = function (key) {
  world.layers[key] = !world.layers[key];
  if (key === 'starlink' && world.layers.starlink && !world.live.sats.some(s => s.group === 'starlink')) loadLive('starlink');   // 7,000+ satellites: fetched only when asked for
  applyLayers(); if (world.data) renderLeft(lensData(world.data));
};
// ---------------- LIVE LAYERS (phase 1, 2026-10-14) ----------------
// Flights (OpenSky), military aircraft (adsb.lol), satellites (CelesTrak + SGP4), launches (Launch Library 2), cyclones
// (NOAA NHC) and "what is here" for a clicked spot — all keyless, all fetched and rate-limited by the server
// (worldlive.js). Aircraft move between snapshots along their own heading at their own speed; satellites are
// propagated from their element sets every two seconds. Everything stops while the monitor is closed or hidden.
world.live = { flights: null, military: null, sats: [], launches: null, cyclones: [] };
const EARTH_KM = 6371;
const AIR_EXAG = 9;                  // aircraft fly ~0.2% of an Earth radius up; drawn 9× higher so they read as aloft
const DR_LIMIT = 20 * 60000;          // never extrapolate a position more than 20 minutes past its snapshot
function deadReckon(r, f, ageMs) {
  // r = [id, callsign, lat, lon, alt_m, speed_ms, track, …]; the field order comes from the server (f = fields)
  const t = Math.min(DR_LIMIT, Math.max(0, ageMs)) / 1000;
  const lat = r[2], lon = r[3], v = r[5] || 0, h = (r[6] || 0) * Math.PI / 180;
  const dLat = v * Math.cos(h) * t / 111320;
  const dLon = v * Math.sin(h) * t / (111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
  return { lat: Math.max(-89.9, Math.min(89.9, lat + dLat)), lng: ((lon + dLon + 540) % 360) - 180,
    alt: 0.0015 + (r[4] || 0) / 1000 / EARTH_KM * AIR_EXAG };
}
function parseTle(text, group) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\r$/, '').trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    // a TLE is a name line, then line 1 and line 2 — a machine format, recognised by its line numbers
    if (lines[i + 1] && lines[i + 2] && lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
      try { out.push({ name: lines[i].trim(), norad: lines[i + 1].slice(2, 7).trim(), group, rec: satellite.twoline2satrec(lines[i + 1], lines[i + 2]) }); } catch (e) {}
      i += 2;
    }
  }
  return out;
}
function satPos(s, when) {
  const pv = satellite.propagate(s.rec, when);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(when));
  const v = pv.velocity ? Math.sqrt(pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2) : null;
  return { lat: satellite.degreesLat(geo.latitude), lng: satellite.degreesLong(geo.longitude), alt: geo.height / EARTH_KM, km: geo.height, kms: v };
}
async function loadLive(what) {
  try {
    if (what === 'flights') { const r = await api('/api/world/live/flights'); if (r && r.value) world.live.flights = r.value; }
    if (what === 'military') { const r = await api('/api/world/live/military'); if (r && r.value) world.live.military = r.value; }
    if (what === 'launches') { const r = await api('/api/world/live/launches'); if (r && r.value) world.live.launches = r.value; }
    if (what === 'cyclones') { const r = await api('/api/world/live/cyclones'); if (r && r.value) world.live.cyclones = r.value; }
    if (what === 'sats' || what === 'starlink') {
      if (what === 'sats' && !window.satellite) await loadScriptOnce('/vendor/satellite.min.js');
      if (what === 'starlink' && !window.satellite) await loadScriptOnce('/vendor/satellite.min.js');
      const groups = what === 'starlink' ? 'starlink' : 'stations,visual,gnss,weather,geo';
      const r = await api('/api/world/live/sats?groups=' + groups);
      const keep = world.live.sats.filter(s => what === 'starlink' ? s.group !== 'starlink' : s.group === 'starlink');
      const seen = new Set(keep.map(s => s.norad));
      for (const [g, v] of Object.entries(r || {})) for (const s of parseTle(v.tle, g)) if (!seen.has(s.norad)) { seen.add(s.norad); keep.push(s); }
      world.live.sats = keep;
    }
  } catch (e) { /* one layer failing never blanks the others */ }
  applyLayers();
  if (world.data) renderLeft(lensData(world.data));
}
// The moving layers, recomputed every two seconds while the monitor is open.
function liveFrame() {
  if (!world.globe || !world.open || document.hidden) return;
  const now = Date.now(), sets = [], labels = [], paths = [];
  const L = world.live;
  if (world.layers.flights && L.flights) {
    const age = now - L.flights.snapshot;
    sets.push({ kind: 'flights', color: WM_COLORS.flights, size: 1.6, points: L.flights.rows.map(r => deadReckon(r, L.flights.fields, age)) });
  }
  if (world.layers.military && L.military) {
    const age = now - L.military.snapshot;
    sets.push({ kind: 'military', color: WM_COLORS.military, size: 3.4, points: L.military.rows.map(r => deadReckon(r, L.military.fields, age)) });
  }
  if (window.satellite && L.sats.length) {
    const when = new Date(now), main = [], star = [];
    for (const s of L.sats) {
      const isStar = s.group === 'starlink';
      if (isStar ? !world.layers.starlink : !world.layers.sats) continue;
      const p = satPos(s, when); if (!p) continue;
      s.last = p;
      (isStar ? star : main).push(p);
      if (s.group === 'stations' && /ISS \(ZARYA\)|CSS \(TIANHE\)/.test(s.name)) labels.push({ lat: p.lat, lng: p.lng, alt: p.alt, name: s.name.replace(/\s*\(.*\)/, '') === 'ISS' ? 'ISS' : 'TIANGONG' });
    }
    if (main.length) sets.push({ kind: 'sats', color: WM_COLORS.sats, size: 2.2, points: main });
    if (star.length) sets.push({ kind: 'starlink', color: WM_COLORS.starlink, size: 1.3, points: star });
    // the ISS's next orbit (92 minutes), recomputed once a minute
    const iss = world.layers.sats && L.sats.find(s => s.group === 'stations' && s.name.startsWith('ISS (ZARYA)'));
    if (iss) {
      if (!world._issPath || now - world._issPath.at > 60000) {
        const pts = [];
        for (let k = 0; k <= 92; k += 1) { const p = satPos(iss, new Date(now + k * 60000)); if (p) pts.push([p.lat, p.lng, p.alt]); }
        world._issPath = { at: now, pts };
      }
      paths.push({ pts: world._issPath.pts });
    }
  }
  world.globe.particlesData(sets);
  world.globe.labelsData(labels);
  world.globe.pathsData(paths);
  world.scene.sets = sets; world.scene.labels = labels; world.scene.paths = paths;
  if (map2d.on) render2D();
}
function startLive() {
  stopLive();
  for (const k of ['flights', 'military', 'launches', 'cyclones', 'sats']) loadLive(k);
  if (world.layers.starlink) loadLive('starlink');
  world._liveTimers = [
    setInterval(() => { if (state.online && world.open) loadLive('military'); }, 60000),
    setInterval(() => { if (state.online && world.open) loadLive('flights'); }, 5 * 60000),     // the server holds each snapshot 16 min
    setInterval(() => { if (state.online && world.open) { loadLive('launches'); loadLive('cyclones'); } }, 30 * 60000),
    setInterval(liveFrame, 2000),
  ];
  setTimeout(liveFrame, 1500);
}
function stopLive() { (world._liveTimers || []).forEach(clearInterval); world._liveTimers = []; }

// Clicking the globe: the nearest live object within reach of the click, otherwise what is at that spot.
function angDist(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180, x = Math.sin((bLat - aLat) * r / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin((bLng - aLng) * r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(x))) / r;
}
function onWorldClick(lat, lng, reachDeg) {
  const pov = world.globe.pointOfView();
  const reach = reachDeg != null ? reachDeg : Math.max(0.15, Math.min(3, (pov.altitude || 2) * 0.9));   // degrees; tighter when zoomed in (2D passes its own)
  let best = null;
  const consider = (o, d) => { if (d < reach && (!best || d < best.d)) best = { o, d }; };
  const now = Date.now(), L = world.live;
  if (world.layers.military && L.military) for (const r of L.military.rows) { const p = deadReckon(r, null, now - L.military.snapshot); consider({ kind: 'mil', r, p }, angDist(lat, lng, p.lat, p.lng) * 0.7); }
  if (world.layers.flights && L.flights) for (const r of L.flights.rows) { const p = deadReckon(r, null, now - L.flights.snapshot); consider({ kind: 'flight', r, p }, angDist(lat, lng, p.lat, p.lng)); }
  for (const s of L.sats) if (s.last && (s.group === 'starlink' ? world.layers.starlink : world.layers.sats)) consider({ kind: 'sat', s }, angDist(lat, lng, s.last.lat, s.last.lng) * 1.2);
  if (best) return showLiveInfo(best.o);
  showPointInfo(lat, lng);
}
function infoCard(title, body, links) {
  const ans = document.getElementById('wmAnswer');
  ans.classList.add('show');
  ans.innerHTML = '<div style="font-weight:700;color:#dff5ff;margin-bottom:5px">' + esc(title) + '</div>' + body +
    (links && links.length ? '<div class="wm-ans-src">' + links.map(l => '<span class="wm-src" onclick="openExt(\'' + esc(l.url) + '\')">' + esc(l.name) + ' ↗</span>').join(' ') + '</div>' : '');
}
const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + ' UTC';
function showLiveInfo(o) {
  if (o.kind === 'flight' || o.kind === 'mil') {
    const r = o.r, mil = o.kind === 'mil', snap = mil ? world.live.military.snapshot : world.live.flights.snapshot;
    const mins = Math.round((Date.now() - snap) / 60000);
    infoCard((mil ? 'Military · ' : 'Flight · ') + (r[1] || r[0].toUpperCase()),
      esc((mil ? (r[7] ? r[7] + ' · ' : '') + (r[8] ? 'reg ' + r[8] : '') : 'Registered in ' + (r[7] || 'unknown'))) + '<br>' +
      'Altitude ' + Math.round(r[4]).toLocaleString() + ' m (' + Math.round(r[4] * 3.281).toLocaleString() + ' ft) · ' +
      Math.round(r[5] * 3.6) + ' km/h · heading ' + r[6] + '°<br>' +
      '<span style="color:#8fd4ff;font-size:11px">Position ' + (mins > 1 ? 'extrapolated from the ' + hhmm(snap) + ' snapshot (' + mins + ' min ago)' : 'from ' + hhmm(snap)) +
      ' · ' + (mil ? 'adsb.lol' : 'OpenSky Network') + '</span>',
      [{ name: 'Track on adsb.lol', url: 'https://globe.adsb.lol/?icao=' + r[0] }]);
    return;
  }
  if (o.kind === 'sat') {
    const s = o.s, p = s.last;
    infoCard('Satellite · ' + s.name,
      'Altitude ' + Math.round(p.km).toLocaleString() + ' km · ' + (p.kms ? p.kms.toFixed(2) + ' km/s · ' : '') + 'over ' + p.lat.toFixed(1) + '°, ' + p.lng.toFixed(1) + '°<br>' +
      '<span style="color:#8fd4ff;font-size:11px">NORAD ' + esc(s.norad) + ' · group ' + esc(s.group) + ' · position computed now from CelesTrak elements (SGP4)</span>',
      [{ name: 'N2YO live track', url: 'https://www.n2yo.com/satellite/?s=' + encodeURIComponent(s.norad) }]);
  }
}
async function showPointInfo(lat, lng) {
  infoCard('Looking at ' + lat.toFixed(2) + '°, ' + lng.toFixed(2) + '°…', 'Checking the weather and what is nearby.');
  let r;
  try { r = await api('/api/world/point?lat=' + lat.toFixed(4) + '&lon=' + lng.toFixed(4)); } catch (e) { r = null; }
  if (!r || r.error) return infoCard('Nothing to show here', esc((r && r.error) || 'The lookup failed — offline?'));
  const w = r.weather, place = r.place;
  const title = place ? (place.name || place.display || '').split(',')[0] + (place.country ? ', ' + place.country : '') : (lat.toFixed(2) + '°, ' + lng.toFixed(2) + '° (open water)');
  const wx = w && w.tempC != null ? Math.round(w.tempC) + '°C' + (w.feelsC != null ? ' (feels ' + Math.round(w.feelsC) + '°)' : '') + (w.sky ? ', ' + esc(w.sky) : '') +
    ' · wind ' + Math.round(w.windKmh || 0) + ' km/h · cloud ' + (w.cloud != null ? w.cloud + '%' : '?') + (w.localTime ? ' · local ' + esc(w.localTime.slice(11, 16)) + (w.isDay ? ' (day)' : ' (night)') : '') : 'No weather reading.';
  const links = (r.nearby || []).slice(0, 4).map(n => ({ name: n.title + ' (' + n.km + ' km)', url: n.url }));
  infoCard(title, wx + '<br><span style="color:#8fd4ff;font-size:11px">Open-Meteo · OpenStreetMap · Wikipedia</span>', links);
}

// ---------------- 2D MAP (equirectangular), 2026-10-14 ----------------
// His ask: "the 2D part doesn't work — make it display a 2D variation of the world with every marker accurate". It is the
// SAME scene as the globe — world.scene is filled by applyLayers() and liveFrame() for both views — drawn flat: x is
// longitude, y is latitude, one degree per unit, so a marker sits exactly where its coordinates say. The base map is the
// globe's own imagery (day, clouds, night shading and city lights split at the real terminator), rebuilt every five
// minutes as the sun moves; borders are vectors, crisp at any zoom; it wraps across the date line. Wheel = zoom at the
// cursor, drag = pan, click = the same cards as the globe, hover = the marker's name. The globe pauses while 2D is shown.
world.scene = { points: [], rings: [], sets: [], labels: [], paths: [] };
world.mode = '3d';
const map2d = { on: false, scale: 1, cx: 180, cy: 90, k: 1, k0: 1, w: 0, h: 0, ox: 0, oy: 0, fit: null, base: null, baseAt: 0, borders: null, imgs: {}, hit: [], drag: null };
const loadImg = src => map2d.imgs[src] || (map2d.imgs[src] = new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }));
async function ensureMapAssets() {
  const [day, night, clouds] = await Promise.all([loadImg('/vendor/earth/earth-blue-marble.jpg'), loadImg('/vendor/earth/earth-night.jpg'), loadImg('/vendor/earth/clouds.jpg')]);
  map2d.day = day; map2d.night = night;
  if (clouds && !map2d.cloudsAlpha) {
    // the cloud photo is white-on-black; turn its brightness into transparency once
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    const x = c.getContext('2d'); x.drawImage(clouds, 0, 0, c.width, c.height);
    const id = x.getImageData(0, 0, c.width, c.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const a = d[i]; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = a * 0.72; }
    x.putImageData(id, 0, 0); map2d.cloudsAlpha = c;
  }
  if (!map2d.borders && world.countries) {
    const p = new Path2D();
    const ring = r => r.forEach(([lng, lat], i) => i ? p.lineTo(lng + 180, 90 - lat) : p.moveTo(lng + 180, 90 - lat));
    for (const f of world.countries) {
      const g = f.geometry; if (!g) continue;
      if (g.type === 'Polygon') g.coordinates.forEach(ring);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(ring));
    }
    map2d.borders = p;
  }
}
// Day, clouds, night shade and city lights, split at the terminator for this minute (1 px of mask per degree, smoothed).
function buildBase() {
  if (!map2d.day) return;
  const W = 2048, H = 1024;
  const base = map2d.base || document.createElement('canvas'); base.width = W; base.height = H;
  const b = base.getContext('2d');
  b.globalCompositeOperation = 'source-over'; b.globalAlpha = 1;
  b.drawImage(map2d.day, 0, 0, W, H);
  if (map2d.cloudsAlpha) b.drawImage(map2d.cloudsAlpha, 0, 0, W, H);
  const s = subsolarPoint(), r = Math.PI / 180;
  const mask = document.createElement('canvas'); mask.width = 360; mask.height = 180;
  const mx = mask.getContext('2d'), md = mx.createImageData(360, 180);
  for (let y = 0; y < 180; y++) for (let x = 0; x < 360; x++) {
    const lat = (89.5 - y) * r, lng = (x - 179.5) * r;
    const cosz = Math.sin(lat) * Math.sin(s.lat * r) + Math.cos(lat) * Math.cos(s.lat * r) * Math.cos(lng - s.lng * r);
    let n = Math.min(1, Math.max(0, (0.10 - cosz) / 0.30)); n = n * n * (3 - 2 * n);   // smoothstep across twilight
    const o = (y * 360 + x) * 4; md.data[o] = md.data[o + 1] = md.data[o + 2] = 0; md.data[o + 3] = Math.round(n * 255);
  }
  mx.putImageData(md, 0, 0);
  // night shade: the mask itself, black, at 60%
  b.globalAlpha = 0.6; b.imageSmoothingEnabled = true; b.drawImage(mask, 0, 0, W, H); b.globalAlpha = 1;
  // city lights: the night image cut to the mask, added on top
  if (map2d.night) {
    const lc = document.createElement('canvas'); lc.width = W; lc.height = H;
    const l = lc.getContext('2d'); l.drawImage(map2d.night, 0, 0, W, H);
    l.globalCompositeOperation = 'destination-in'; l.drawImage(mask, 0, 0, W, H);
    b.globalCompositeOperation = 'lighter'; b.drawImage(lc, 0, 0, W, H); b.globalCompositeOperation = 'source-over';
  }
  map2d.base = base; map2d.baseAt = Date.now();
}
function clampView() {
  const k = map2d.k, f = map2d.fit || { w: map2d.w, h: map2d.h }, half = f.h / (2 * k);
  map2d.cy = 180 * k <= f.h ? 90 : Math.min(180 - half, Math.max(half, map2d.cy));
  map2d.cx = 360 * k <= f.w + 1 ? 180 : ((map2d.cx % 360) + 360) % 360;   // the whole map fits: keep it centred
}
// THE PART OF THE STAGE THE MAP CAN BE SEEN IN. The side panels, the ticker, the alert and the ask bar sit on top of the
// stage. The map used to be fitted to cover the whole stage, so it ran under them (the poles cut off on a wide window,
// the Americas and the Pacific behind the panels), and zoom stopped at that fit, so the whole map was never visible
// (2026-10-14, his report). The open area is measured from the panels on every draw, so it follows the window size
// and the panels' own sizes. Each panel bounds the side of the stage it sits on.
function mapOpenArea(cv) {
  const r = cv.getBoundingClientRect(); let x0 = 0, x1 = r.width, y0 = 0, y1 = r.height;
  for (const sel of ['.wm-stats', '.wm-legend', '.wm-feed', '.wm-ticker', '.wm-alert', '.wm-bar']) {
    const el = document.querySelector('#worldMonitor ' + sel); if (!el) continue;
    const b = el.getBoundingClientRect(); if (!b.width || !b.height) continue;   // hidden (the alert, most of the time)
    const l = b.left - r.left, t = b.top - r.top, mid = l + b.width / 2;
    if (mid < r.width / 3) x0 = Math.max(x0, l + b.width);
    else if (mid > 2 * r.width / 3) x1 = Math.min(x1, l);
    else if (t + b.height / 2 < r.height / 2) y0 = Math.max(y0, t + b.height);
    else y1 = Math.min(y1, t);
  }
  const pad = 8; x0 += pad; x1 -= pad; y0 += pad; y1 -= pad;
  if (x1 - x0 < 120 || y1 - y0 < 60) return { x: 0, y: 0, w: r.width, h: r.height };   // the panels leave no room: use the stage
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function proj(lat, lng) {
  let dx = (lng + 180) - map2d.cx; dx = ((dx + 180) % 360 + 360) % 360 - 180;   // the copy nearest the centre of the view
  return [dx * map2d.k + map2d.ox, (90 - lat - map2d.cy) * map2d.k + map2d.oy];
}
function unproj(x, y) {
  const lng = ((map2d.cx + (x - map2d.ox) / map2d.k) % 360 + 360) % 360 - 180;
  const lat = 90 - (map2d.cy + (y - map2d.oy) / map2d.k);
  return [Math.max(-90, Math.min(90, lat)), lng];
}
function render2D() {
  if (!map2d.on) return;
  const cv = document.getElementById('worldMap'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  map2d.w = w; map2d.h = h;
  const fit = map2d.fit = mapOpenArea(cv); map2d.ox = fit.x + fit.w / 2; map2d.oy = fit.y + fit.h / 2;
  map2d.k0 = Math.min(fit.w / 360, fit.h / 180); map2d.k = map2d.k0 * map2d.scale; clampView();   // zoom 1 = the whole map, in the open area
  if (!map2d.base || Date.now() - map2d.baseAt > 5 * 60000) buildBase();
  const c = cv.getContext('2d'), k = map2d.k;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#02060c'; c.fillRect(0, 0, w, h);
  const top = (0 - map2d.cy) * k + map2d.oy;
  const wraps = 360 * k > map2d.fit.w + 1;   // narrower than the open area: one copy, no repeats behind the panels
  for (const off of wraps ? [-360, 0, 360] : [0]) {
    const left = (off - map2d.cx) * k + map2d.ox;
    if (left > w || left + 360 * k < 0) continue;
    if (map2d.base) { c.imageSmoothingEnabled = true; c.drawImage(map2d.base, left, top, 360 * k, 180 * k); }
    c.save(); c.translate(left, top); c.scale(k, k);
    if (world.layers.grid) {   // the HUD grid layer, as a graticule here: every 15°
      c.strokeStyle = 'rgba(94,212,247,0.18)'; c.lineWidth = 0.6 / k; c.beginPath();
      for (let x = 0; x <= 360; x += 15) { c.moveTo(x, 0); c.lineTo(x, 180); }
      for (let y = 0; y <= 180; y += 15) { c.moveTo(0, y); c.lineTo(360, y); }
      c.stroke();
    }
    if (world.layers.borders && map2d.borders) { c.strokeStyle = 'rgba(220,235,255,0.38)'; c.lineWidth = 0.7 / k; c.stroke(map2d.borders); }
    c.restore();
  }
  const sc = world.scene, on = (x, y, m) => x > -m && x < w + m && y > -m && y < h + m;
  for (const set of sc.sets) {   // flights, military, satellites, Starlink — the same positions the globe draws
    const sz = Math.max(1.2, set.size * 0.8); c.fillStyle = set.color;
    for (const p of set.points) { const [x, y] = proj(p.lat, p.lng); if (on(x, y, 2)) c.fillRect(x - sz / 2, y - sz / 2, sz, sz); }
  }
  for (const pa of sc.paths) {   // the ISS's next orbit, broken where it crosses the edge of the map
    c.strokeStyle = 'rgba(158,247,255,0.55)'; c.lineWidth = 1.2; c.beginPath(); let px = null;
    for (const [lat, lng] of pa.pts) { const [x, y] = proj(lat, lng); if (px === null || Math.abs(x - px) > w / 2) c.moveTo(x, y); else c.lineTo(x, y); px = x; }
    c.stroke();
  }
  for (const rg of sc.rings) {
    const [x, y] = proj(rg.lat, rg.lon); if (!on(x, y, 20)) continue;
    c.strokeStyle = rg.kind === 'cyclone' ? 'rgba(197,139,255,0.9)' : 'rgba(94,212,247,0.8)'; c.lineWidth = 1.4;
    c.beginPath(); c.arc(x, y, rg.kind === 'cyclone' ? 11 : 7, 0, 2 * Math.PI); c.stroke();
  }
  map2d.hit = [];
  for (const d of sc.points) {
    const [x, y] = proj(d.lat, d.lon); if (!on(x, y, 10)) continue;
    const r = d.kind === 'launch' ? 4.5 : d.kind === 'cyclone' ? 5 : 2.4 + (d.mag || 1) * 0.75;
    c.fillStyle = world.globe ? world.globe.pointColor()(d) : '#5ed4f7';
    c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1;
    c.beginPath(); c.arc(x, y, r, 0, 2 * Math.PI); c.fill(); c.stroke();
    map2d.hit.push({ x, y, r, d });
  }
  c.font = '600 11px Inter, sans-serif'; c.fillStyle = 'rgba(158,247,255,0.95)';
  for (const l of sc.labels) { const [x, y] = proj(l.lat, l.lng); if (!on(x, y, 40)) continue; c.beginPath(); c.arc(x, y, 3, 0, 2 * Math.PI); c.fill(); c.fillText(l.name, x + 6, y - 5); }
}
function mapPointAt(x, y) {
  let best = null;
  for (const hp of map2d.hit) { const dd = Math.hypot(hp.x - x, hp.y - y); if (dd <= hp.r + 5 && (!best || dd < best.dd)) best = { dd, d: hp.d }; }
  return best && best.d;
}
function initMap2D() {
  const cv = document.getElementById('worldMap'); if (!cv || cv._wired) return; cv._wired = true;
  const tip = document.getElementById('wmMapTip');
  const at = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const [x, y] = at(e), [lat, lng] = unproj(x, y);
    map2d.scale = Math.min(24, Math.max(1, map2d.scale * Math.exp(-e.deltaY * 0.0015)));
    map2d.k = map2d.k0 * map2d.scale;
    map2d.cx = (lng + 180) - (x - map2d.ox) / map2d.k; map2d.cy = (90 - lat) - (y - map2d.oy) / map2d.k;   // the spot under the cursor stays put
    render2D();
  }, { passive: false });
  cv.addEventListener('mousedown', e => { const [x, y] = at(e); map2d.drag = { x, y, cx: map2d.cx, cy: map2d.cy, moved: false }; cv.classList.add('drag'); });
  window.addEventListener('mouseup', e => {
    if (!map2d.drag) return;
    const d = map2d.drag; map2d.drag = null; cv.classList.remove('drag');
    if (d.moved) return;
    const [x, y] = at(e), hitD = mapPointAt(x, y);
    if (hitD) return showEventInfo(hitD);
    const [lat, lng] = unproj(x, y);
    onWorldClick(lat, lng, 9 / map2d.k);   // reach: about nine pixels, in degrees
  });
  cv.addEventListener('mousemove', e => {
    const [x, y] = at(e);
    if (map2d.drag) {
      const d = map2d.drag; if (Math.hypot(x - d.x, y - d.y) > 4) d.moved = true;
      map2d.cx = d.cx - (x - d.x) / map2d.k; map2d.cy = d.cy - (y - d.y) / map2d.k;
      if (!map2d._raf) map2d._raf = requestAnimationFrame(() => { map2d._raf = 0; render2D(); });
      return;
    }
    const hitD = mapPointAt(x, y);
    if (tip) { if (hitD) { tip.innerHTML = pointTitle(hitD); tip.style.left = (x + 14) + 'px'; tip.style.top = (y + 10) + 'px'; tip.classList.add('show'); } else tip.classList.remove('show'); }
  });
  cv.addEventListener('mouseleave', () => tip && tip.classList.remove('show'));
  cv.addEventListener('dblclick', e => { const [x, y] = at(e); cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -460, clientX: e.clientX, clientY: e.clientY })); });
  window.addEventListener('resize', () => { if (map2d.on) render2D(); });
}
window.setWorldMode = async function (mode) {
  world.mode = mode === '2d' ? '2d' : '3d';
  document.querySelectorAll('#wmMode span').forEach(s => s.classList.toggle('on', s.dataset.mode === world.mode));
  const g = document.getElementById('worldGlobe'), m = document.getElementById('worldMap');
  if (world.mode === '2d') {
    initMap2D(); await ensureMapAssets();
    map2d.on = true; m.classList.add('on'); g.style.visibility = 'hidden';
    if (world.globe) { const pov = world.globe.pointOfView(); map2d.cx = pov.lng + 180; map2d.cy = 90 - pov.lat; world.globe.pauseAnimation(); }   // open the map where the globe was looking
    render2D();
  } else {
    map2d.on = false; m.classList.remove('on'); g.style.visibility = '';
    if (world.globe) world.globe.resumeAnimation();
  }
};
document.querySelectorAll('#wmMode span').forEach(s => s.addEventListener('click', () => setWorldMode(s.dataset.mode)));

async function loadWorldData() {
  try {
    const d = await api('/api/world/events');
    world.data = d;
    applyLayers();
    renderWorldAll(d);
  } catch (e) { document.getElementById('wmTicker').textContent = 'World feed unavailable — offline?'; }
}
const sevRank = { high: 3, med: 2, low: 1 };
const SEV_LABEL = { high: 'CRIT', med: 'ELEV', low: 'NOM' };
world.lens = 'WORLD';   // active lens filters what the whole board shows
world.outlet = 'ALL';   // active outlet/topic filter in the news wall

// Threat level is COMPUTED from live data (never decorative): red alerts + M6+ quakes drive it.
function threatLevel(d) {
  const redAlerts = (d.disasters || []).filter(x => x.sev === 'high').length;
  const bigQuakes = (d.quakes || []).filter(q => q.mag >= 6).length;
  const mod = (d.quakes || []).filter(q => q.mag >= 4.5).length + (d.events || []).filter(e => e.sev === 'high').length;
  const score = redAlerts * 3 + bigQuakes * 3 + mod;
  if (redAlerts + bigQuakes >= 3) return { n: 2, cls: 'd2', pct: Math.min(99, 60 + score) };
  if (redAlerts + bigQuakes >= 1) return { n: 3, cls: 'd3', pct: Math.min(90, 40 + score) };
  if (mod >= 8) return { n: 4, cls: 'd4', pct: Math.min(70, 20 + score) };
  return { n: 5, cls: 'd5', pct: Math.min(35, score) };
}
// The lens narrows the dataset — a real filter, not a decorative chip.
function lensData(d) {
  const L = world.lens;
  if (L === 'SEISMIC') return Object.assign({}, d, { events: [], disasters: [], headlines: [] });
  if (L === 'DISASTER') return Object.assign({}, d, { quakes: [], headlines: [] });
  if (L === 'NEWS') return Object.assign({}, d, { quakes: [], events: [], disasters: [] });
  return d;
}
window.setLens = function (l) { world.lens = l; if (world.data) { applyLayers(); renderWorldAll(world.data); } };
window.setOutlet = function (o) { world.outlet = o; if (world.data) renderNewsWall(lensData(world.data)); };

function renderWorldAll(d) {
  const v = lensData(d);
  renderCmdBar(d); renderLeft(v); renderFeed(v); renderWorldTicker(v);
  renderAlert(v); renderLegend(); renderLens(); renderNewsWall(v); renderEventLog(v); renderInsights(v);
}
function renderCmdBar(d) {
  const t = threatLevel(d);
  const dc = document.getElementById('wmDefcon');
  dc.className = 'wm-defcon ' + t.cls;
  dc.innerHTML = 'DEFCON ' + t.n + ' <span style="opacity:.7">' + t.pct + '%</span>';
  const geo = (d.quakes || []).length + (d.events || []).length + (d.disasters || []).length;
  document.getElementById('wmSignalChip').textContent = '◎ ' + geo + ' SIGNALS';
  document.getElementById('wmSourcesChip').textContent = (d.sources || []).length + ' SOURCES';
  document.getElementById('wmFeedCount').textContent = (d.headlines || []).length + ' SIGNALS';
}
function renderLeft(d) {
  const strong = (d.quakes || []).filter(q => q.mag >= 4.5).length;
  const layers = LAYER_META.map(l => '<div class="wm-layer' + (world.layers[l.key] ? ' on' : ' off') + '" onclick="toggleLayer(\'' + l.key + '\')">' +
    '<span class="box"></span><span class="swatch" style="background:' + l.color + '"></span>' + l.label.toUpperCase() +
    '<span class="n">' + (l.count ? l.count() || '' : l.src ? (d[l.src] || []).length : '') + '</span></div>').join('');
  const srcRow = (d.sources || []).map(s => '<span class="wm-src" onclick="openExt(\'' + esc(s.url) + '\')">' + esc(s.name) + ' ↗</span>').join('');
  const row = (k, v, pct) => '<div class="wm-stat-row"><span>' + k + '</span><span class="v">' + v + '</span></div>' +
    (pct != null ? '<div class="wm-bar-mini"><i style="width:' + Math.min(100, pct) + '%"></i></div>' : '');
  document.getElementById('wmStats').innerHTML =
    '<div class="wm-panel"><h4>SITUATION</h4><div class="wm-pbody">' +
    row('SEISMIC · USGS', (d.quakes || []).length, (d.quakes || []).length * 2) +
    row('SIGNIFICANT M4.5+', strong, strong * 6) +
    row('NATURAL · NASA', (d.events || []).length, (d.events || []).length * 2.5) +
    row('ALERTS · GDACS', (d.disasters || []).length, (d.disasters || []).length * 2.5) +
    row('NEWS SIGNALS', (d.headlines || []).length) +
    row('AIRBORNE · OPENSKY', world.live.flights ? world.live.flights.rows.length.toLocaleString() + ' · ' + hhmm(world.live.flights.snapshot) : '…') +
    row('MILITARY AIR · ADSB.LOL', world.live.military ? world.live.military.rows.length : '…') +
    row('SATELLITES · CELESTRAK', world.live.sats.length ? world.live.sats.length.toLocaleString() : '…') +
    row('CYCLONES · NOAA', world.live.cyclones.length) +
    '</div></div>' +
    '<div class="wm-panel"><h4>LAYERS<span class="hint">toggle</span></h4><div class="wm-pbody"><div class="wm-layers">' + layers + '</div></div></div>' +
    '<div class="wm-panel"><h4>LEGEND<span class="hint">2D · 3D</span></h4><div class="wm-pbody">' + legendHtml() + '</div></div>' +
    '<div class="wm-panel"><h4>SOURCES<span class="hint">verified</span></h4><div class="wm-pbody"><div class="wm-srcs">' + srcRow + '</div></div></div>';
}
function renderLegend() {
  // The legend used to be a strip pinned under the map, where the ask bar covered its middle in both views. It is a panel
  // in the left column now (legendHtml, drawn by renderLeft); the strip stays empty.
  const el = document.getElementById('wmLegend'); if (el) el.innerHTML = '';
}
// Every row is drawn in the colour and shape the map really uses, and dims when its layer is switched off.
function legendHtml() {
  const L = world.layers;
  const dot = c => '<i class="lg-dot" style="background:' + c + '"></i>';
  const ring = c => '<i class="lg-ring" style="border-color:' + c + '"></i>';
  const sq = c => '<i class="lg-sq" style="background:' + c + '"></i>';
  const line = c => '<i class="lg-line" style="background:' + c + '"></i>';
  const rows = [
    [dot(SEV_COLOR.high), 'SEVERE · M6+ / GDACS RED', L.quake || L.disaster],
    [dot(SEV_COLOR.med), 'ELEVATED · M4.5+ / ORANGE', L.quake || L.disaster],
    [dot(SEV_COLOR.low), 'MINOR QUAKE / GREEN', L.quake || L.disaster],
    [dot(WM_COLORS.natural), 'NATURAL EVENT · NASA', L.event],
    [ring(WM_COLORS.node), 'WATCH NODE', L.node],
    [dot(WM_COLORS.launch), 'LAUNCH PAD · 30 DAYS', L.launches],
    [ring(WM_COLORS.cyclone), 'CYCLONE · NOAA', L.cyclones],
    [sq(WM_COLORS.flights), 'AIRCRAFT', L.flights],
    [sq(WM_COLORS.military), 'MILITARY AIRCRAFT', L.military],
    [sq(WM_COLORS.sats), 'SATELLITE', L.sats],
    [sq(WM_COLORS.starlink), 'STARLINK', L.starlink],
    [line(WM_COLORS.path), 'ISS NEXT ORBIT', L.sats],
  ];
  return '<div class="wm-legend-grid">' + rows.map(([sw, t, on]) => '<div class="lg-row' + (on ? '' : ' off') + '"><span class="sw">' + sw + '</span>' + t + '</div>').join('') + '</div>';
}

function renderFeed(d) {
  world.bigList = [].concat(d.quakes || [], d.events || [], d.disasters || [])
    .sort((a, b) => ((sevRank[b.sev] || 0) - (sevRank[a.sev] || 0)) || ((b.mag || 0) - (a.mag || 0))).slice(0, 12);
  const evRow = (q, i) => '<div class="wm-ev link" onclick="showEventByIdx(' + i + ')">' +
    '<span class="dot" style="background:' + (q.kind === 'event' ? '#ffa53c' : (SEV_COLOR[q.sev] || '#5ed4f7')) + '"></span>' +
    '<span>' + (q.mag ? 'M' + q.mag + ' ' : q.cat ? esc(q.cat) + ' ' : '') + esc((q.title || '').slice(0, 44)) + '</span>' +
    '<span class="src">' + esc(q.source || '') + '</span></div>';
  document.getElementById('wmFeed').innerHTML =
    '<div class="wm-panel"><h4>PRIORITY EVENTS<span class="hint">click = brief</span></h4>' +
    '<div class="wm-feed-list" style="padding:0">' + (world.bigList.map(evRow).join('') || '<div class="wm-ev">No active events.</div>') + '</div></div>';
}
// News wall — outlet/topic filter chips + dense headline list (our text answer to their video wall)
function renderNewsWall(d) {
  const topics = ['ALL'].concat([...new Set((d.headlines || []).map(h => (h.topic || 'World').toUpperCase()))]);
  document.getElementById('wmOutlets').innerHTML = topics.map(t =>
    '<span class="wm-outlet' + (world.outlet === t ? ' on' : '') + '" onclick="setOutlet(\'' + t + '\')">' + esc(t) + '</span>').join('');
  const list = (d.headlines || []).filter(h => world.outlet === 'ALL' || (h.topic || 'World').toUpperCase() === world.outlet);
  document.getElementById('wmNewsWall').innerHTML = list.map(h =>
    '<div class="wm-head" onclick="' + (h.url ? 'openExt(\'' + esc(h.url) + '\')' : '') + '">' +
    '<span class="tag' + ((h.topic && h.topic !== 'World') ? ' t' : '') + '">' + esc((h.topic || h.source).toUpperCase()) + '</span>' +
    '<span>' + esc(h.title) + ' <span style="color:#556879;font-size:9px">· ' + esc(h.source) + '</span></span></div>').join('')
    || '<div class="wm-ev">No headlines for this filter.</div>';
}
// Event log — chronological geo stream, newest first
function renderEventLog(d) {
  const all = [].concat(
    (d.quakes || []).map(q => ({ t: q.time, sev: q.sev, txt: 'M' + (q.mag || '?') + '  ' + (q.title || ''), src: 'USGS', o: q })),
    (d.events || []).map(e => ({ t: null, sev: e.sev, txt: (e.cat || 'EVENT') + '  ' + (e.title || ''), src: 'NASA', o: e })),
    (d.disasters || []).map(x => ({ t: null, sev: x.sev, txt: (x.alert || '') + ' ' + (x.cat || '') + '  ' + (x.title || ''), src: 'GDACS', o: x }))
  ).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 40);
  world.logList = all.map(x => x.o);
  document.getElementById('wmEventLog').innerHTML = all.map((x, i) =>
    '<div class="wm-ev link" onclick="showLogByIdx(' + i + ')">' +
    '<span class="dot" style="background:' + (SEV_COLOR[x.sev] || '#5ed4f7') + '"></span>' +
    '<span class="wm-mono" style="font-size:10px">' + (x.t ? esc(new Date(x.t).toISOString().slice(11, 16)) + 'Z ' : '——:—— ') + esc(x.txt.slice(0, 58)) + '</span>' +
    '<span class="src">' + x.src + '</span></div>').join('') || '<div class="wm-ev">Log clear.</div>';
}
window.showLogByIdx = i => showEventInfo((world.logList || [])[i]);
// JARVIS INSIGHTS — severity-tagged dossier cards (their "AI STRATEGIC POSTURE" pattern, real data)
function renderInsights(d) {
  const t = threatLevel(d);
  const red = (d.disasters || []).filter(x => x.sev === 'high');
  const big = (d.quakes || []).filter(q => q.mag >= 5.5);
  const cards = [];
  const cls = t.n <= 3 ? '' : t.n === 4 ? 'amb' : 'cy';
  const sevTxt = t.n <= 3 ? 'CRIT' : t.n === 4 ? 'ELEV' : 'NOMINAL';
  const sevCol = t.n <= 3 ? '#ff4d4d' : t.n === 4 ? '#ffa53c' : '#4ade80';
  cards.push('<div class="wm-dossier ' + cls + '"><div class="dh">GLOBAL POSTURE<span class="sev" style="color:' + sevCol + '">' + sevTxt + '</span></div>' +
    '<div class="dm"><span>SEIS <b>' + (d.quakes || []).length + '</b></span><span>NAT <b>' + (d.events || []).length + '</b></span>' +
    '<span>ALERT <b>' + (d.disasters || []).length + '</b></span><span>NEWS <b>' + (d.headlines || []).length + '</b></span></div></div>');
  if (red.length) cards.push('<div class="wm-dossier"><div class="dh">' + esc((red[0].cat || 'DISASTER')) + ' THEATRE<span class="sev" style="color:#ff4d4d">CRIT</span></div>' +
    '<div class="dm"><span>RED <b>' + red.length + '</b></span><span>' + esc((red[0].title || '').slice(0, 34)) + '</span></div></div>');
  if (big.length) cards.push('<div class="wm-dossier amb"><div class="dh">SEISMIC WATCH<span class="sev" style="color:#ffa53c">ELEV</span></div>' +
    '<div class="dm"><span>M5.5+ <b>' + big.length + '</b></span><span>MAX <b>M' + Math.max(...big.map(q => q.mag)) + '</b></span></div></div>');
  const brief = world.lastBrief
    ? '<div class="wm-brief">' + esc(world.lastBrief) + '</div>'
    : '<div class="wm-brief" style="color:#5b6c7e">Tap the core or ask below for a live situational brief, sir.</div>';
  document.getElementById('wmInsights').innerHTML = cards.join('') + brief;
  document.getElementById('wmInsightSt').textContent = world.lastBrief ? 'BRIEFED' : 'STANDBY';
}
function renderWorldTicker(d) {
  const t = document.getElementById('wmTicker');
  const items = (d.headlines || []).map(h => '<span class="' + (h.url ? 'link' : '') + '"' + (h.url ? ' onclick="openExt(\'' + esc(h.url) + '\')"' : '') + '><b>' + esc((h.topic && h.topic !== 'World' ? h.topic : h.source).toUpperCase()) + '</b>' + esc(h.title) + '</span>').join('');
  t.innerHTML = items || 'No headlines.';
}
function renderAlert(d) {
  const crit = [].concat((d.disasters || []).filter(x => x.sev === 'high'), (d.quakes || []).filter(q => q.mag >= 6));
  const el = document.getElementById('wmAlert');
  if (!crit.length) { el.classList.remove('show'); return; }
  const top = crit[0];
  el.innerHTML = '<span class="pulse"></span>PRIORITY · ' + esc((top.mag ? 'M' + top.mag + ' QUAKE — ' : (top.alert || '') + ' ' + (top.cat || '') + ' — ') + (top.title || '').slice(0, 52)).toUpperCase() + (crit.length > 1 ? '  +' + (crit.length - 1) : '');
  el.classList.add('show');
}
function renderLens() {
  const lenses = ['WORLD', 'SEISMIC', 'DISASTER', 'NEWS'];
  document.getElementById('wmLens').innerHTML = lenses.map(l =>
    '<span class="' + (world.lens === l ? 'on' : '') + '" onclick="setLens(\'' + l + '\')">' + l + '</span>').join('');
}
// The globe + live feed load, separated from openWorld() so a connection that comes back mid-session
// (caught by poll()'s 5s check) can resume the SAME stage instead of duplicating open/close logic.
async function resumeWorldStage() {
  if (!world.globe && !world.loading) {
    world.loading = true;
    document.getElementById('wmTicker').textContent = 'Spinning up the globe…';
    try { await initGlobe(); } catch (e) { document.getElementById('wmTicker').textContent = 'Globe failed to load: ' + e.message; world.loading = false; return; }
    world.loading = false;
  } else if (world.globe) {
    const el = document.getElementById('worldGlobe'); world.globe.width(el.clientWidth).height(el.clientHeight);
  }
  await loadWorldData();
  startLive();
  if (world._spinClouds) { cancelAnimationFrame(world._cloudRaf); world._spinClouds(); }
  clearInterval(world.timer);
  world.timer = setInterval(() => { if (state.online) loadWorldData(); }, 5 * 60 * 1000); // refresh every 5 min while open AND online
}
async function openWorld() {
  if (world.open) return;
  world.open = true;
  // Fresh session every open — no stale answer carried over (each /api/world/summary call is
  // already stateless server-side, so nothing from a previous session can bias the model).
  const ans0 = document.getElementById('wmAnswer'); ans0.classList.remove('show'); ans0.innerHTML = '';
  document.getElementById('worldInput').value = '';
  world.lastBrief = ''; world.outlet = 'ALL'; world.lens = 'WORLD';
  document.getElementById('worldMonitor').classList.add('visible');
  const clk = () => { const e = document.getElementById('wmClock'); if (e) e.textContent = new Date().toUTCString().replace('GMT', 'UTC'); };
  clk(); clearInterval(world._clk); world._clk = setInterval(clk, 1000);
  setTimeout(() => document.getElementById('worldInput').focus(), 100);
  // No internet (per the ping-based signal poll() already maintains): skip the globe/feed fetches
  // entirely — they'd only sit there timing out — and show the plain "no connection" screen instead.
  // A `state.online === false` check (not falsy) means an unconfirmed/optimistic state never
  // triggers this; only an actual failed probe does.
  if (state.online === false) { setWorldOffline(true); return; }
  setWorldOffline(false);
  await resumeWorldStage();
}
function closeWorld() {
  world.open = false;
  document.getElementById('worldMonitor').classList.remove('visible');
  clearInterval(world.timer); clearInterval(world._clk);
  stopLive(); cancelAnimationFrame(world._cloudRaf);   // nothing keeps moving while the monitor is closed
}
async function askWorld(q, via) {
  const raw = q.trim(); if (!raw) return;
  const orb = document.getElementById('wmOrb'); const ans = document.getElementById('wmAnswer');
  world.busy = true;
  orb.classList.add('busy'); ans.classList.add('show'); ans.textContent = 'Analysing the feed…';
  try {
    const r = await api('/api/world/summary', { body: { question: raw } });
    const srcs = (r.sources || []).map(s => '<span class="wm-src" onclick="openExt(\'' + esc(s.url) + '\')">' + esc(s.name) + ' ↗</span>').join('');
    ans.innerHTML = esc(r.reply || 'Nothing notable, sir.') + (srcs ? '<div class="wm-ans-src">Sources: ' + srcs + '</div>' : '');
    world.lastBrief = r.reply || '';                       // mirror the brief into JARVIS INSIGHTS
    if (world.data) renderInsights(lensData(world.data));
    if (via === 'voice') speak(r.reply || '');
  } catch (e) { ans.textContent = 'Feed analysis failed: ' + e.message; }
  world.busy = false;
  orb.classList.remove('busy');
}
document.getElementById('wmClose').addEventListener('click', closeWorld);
document.getElementById('wmOffline').addEventListener('click', closeWorld);
document.getElementById('wmRefresh').addEventListener('click', async e => {
  e.currentTarget.style.opacity = '.4'; await loadWorldData(); e.currentTarget.style.opacity = '';
  toast('World feed refreshed.');
});
// Tap the core orb → JARVIS listens, then answers ALOUD (voice in → voice out).
document.getElementById('wmOrb').addEventListener('click', () => {
  const orb = document.getElementById('wmOrb'); const ans = document.getElementById('wmAnswer');
  if (state.listening) { stopListening(); orb.classList.remove('busy'); return; }
  startListening();
  orb.classList.add('busy');
  ans.classList.add('show'); ans.textContent = 'Listening, sir…';
});
document.getElementById('worldInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { const v = e.target.value; e.target.value = ''; askWorld(v); }
  if (e.key === 'Escape') closeWorld();
});
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'w' || e.key === 'W')) {
    if (document.getElementById('boot')) return;
    e.preventDefault(); world.open ? closeWorld() : openWorld();
  } else if (e.key === 'Escape' && world.open) { closeWorld(); }
});

// ---------------- boot / power-up sequence ----------------
let _actx;
function bootSound(kind) {
  try {
    _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
    if (_actx.state === 'suspended') _actx.resume();
    const t = _actx.currentTime;
    const o = _actx.createOscillator(), g = _actx.createGain();
    o.connect(g); g.connect(_actx.destination);
    if (kind === 'up') {                       // rising reactor spin-up
      o.type = 'sine';
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(560, t + 1.7);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
      o.start(t); o.stop(t + 2.0);
    } else {                                    // "online" confirmation chime
      o.type = 'triangle';
      o.frequency.setValueAtTime(760, t);
      o.frequency.exponentialRampToValueAtTime(1240, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.start(t); o.stop(t + 0.5);
    }
  } catch (e) {}
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// ---------------- opening greeting ----------------
// Fires ~1s after the boot sequence clears. Content comes from the server so every clause is
// backed by real state — the time of day, the next real calendar entry, a real unread count.
// Spoken by default; text-only between 22:00 and 09:00 UNLESS the user is talking to us, in which
// case answering silently would be the strange behaviour.
let greetedThisLaunch = false;
let greetingPrefetch = null;      // started at boot so the greeting is ready the moment it clears

// ---- summoned by name ----
// When the window was opened BY the wake word, the greeting is skipped entirely and the microphone
// takes its place. Marking it as already greeted is what suppresses it: openingGreeting() returns on
// that flag, so the prefetched text is simply never spoken or shown, and there is no second path
// that could still say it.
let wokeByVoice = false;
function suppressGreetingForWake() {
  wokeByVoice = true;
  greetedThisLaunch = true;
  // Covers the narrow case where the greeting had already started — a wake collected a moment after
  // boot cleared. Cancelling is what stops him talking over the command.
  stopSpeaking();
}
const bootStillShowing = () => {
  const b = document.getElementById('boot');
  return !!b && !b.classList.contains('gone');
};
function beginWakeListening() {
  if (state.listening) return;
  if (state.view !== 'voice') setView('voice');
  startListening();
  toast('Listening, Sir.');
}
async function openingGreeting() {
  if (greetedThisLaunch) return;
  greetedThisLaunch = true;
  try {
    // No delay: the request was fired when the boot sequence began and has had ~4.5s to land, so
    // this await is normally instant. The fallback covers a warm reload, where boot is skipped
    // (sessionStorage says we already booted) and nothing was prefetched.
    // state.lastVia is set by handleUserText; on a cold open nobody has spoken yet, so the
    // overnight text-only rule applies as normal.
    const viaVoice = state && state.lastVia === 'voice';
    const g = await (greetingPrefetch
      || api('/api/greeting' + (viaVoice ? '?voice=1' : ''), { method: 'GET' }));
    greetingPrefetch = null;
    if (!g || !g.text) return;
    pushMsg('assistant', g.text);
    // listen:false — the app opening is not a turn in a conversation. A greeting that happens to end
    // in a question ("What can I do for you, Sir?") must not silently open the microphone on launch.
    if (g.speak) speak(g.text, { listen: false });
  } catch (e) { /* a greeting is never worth surfacing an error for */ }
}

// ---------------- stop ----------------
// One control that halts whatever is running: the agent plan, research, screen control, the deep
// research job, and JARVIS's own voice. The server unwinds its loops at their next checkpoint, so
// the honest promise is "stops after the current step", not "stops mid-keystroke".
let stopping = false;
function setBusy(on) {
  document.body.classList.toggle('jarvis-busy', !!on);
  if (!on) stopping = false;
}
async function stopEverything() {
  if (stopping) return;
  stopping = true;
  // Silence and visible feedback happen locally and instantly; the server call is what actually
  // unwinds the work, but the user should never wait on the network to see that stop registered.
  stopSpeaking();
  stopProgress(false);
  orbSet('idle');
  toast('Stopping…');
  try { await api('/api/stop', { method: 'POST' }); } catch (e) {}
  pushMsg('assistant', 'Stopped, Sir.');
  setBusy(false);
  state.busy = false;      // release the input immediately; the in-flight request unwinds on its own
}

// Wired at load, NOT inside showControlBanner() — that function builds the screen-control banner
// dynamically and only runs when JARVIS takes the screen, so registering here previously meant the
// stop button did nothing until an unrelated feature happened to fire.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('stopBtn');
  if (btn) btn.addEventListener('click', stopEverything);
});
// Esc is the reflex people already have for "make it stop". Only while busy, and never while a text
// field holds typed text — there Esc means "clear what I'm writing", not "abort the assistant".
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!document.body.classList.contains('jarvis-busy')) return;
  const t = document.activeElement;
  if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && t.value) return;
  e.preventDefault();
  stopEverything();
});

// ---------------- live progress ----------------
// Shows what JARVIS is doing WHILE it does it, rather than going silent between the ack and the
// answer. Polled at 700ms (fast enough to feel live, slow enough to be free) with a cursor, so each
// poll carries only new steps. The server decides whether they may be spoken — text-only 23:00–09:00
// unless the task was given by voice.
let progressPoll = null;
function clearLiveReply() {
  // The streamed bubble is a PREVIEW of the final reply, not a second message. It has to go the
  // instant the real one is pushed, or the answer shows up twice — once streamed, once for real.
  const el = document.getElementById('liveReply');
  if (el) el.remove();
}
function stopProgress(collapse) {
  if (progressPoll) { clearInterval(progressPoll); progressPoll = null; }
  const el = document.getElementById('workCard');
  if (!el) return;
  if (collapse) el.remove(); else el.classList.add('done');
}
// HOW MUCH OF A HALF-WRITTEN ANSWER IS SAFE TO SAY.
//
// A full stop is the obvious break, and on his replies it is almost useless: asked to describe the
// ocean in forty words the model wrote ONE sentence, and at 5948ms the streamed text was 161
// characters ending "...regulating climate and weather through" — no terminator anywhere. Waiting
// for a period meant waiting for the whole answer, which is what streaming was supposed to avoid.
//
// So a clause counts too, once there is enough of it to be worth saying. A comma is where a person
// draws breath, so the seam lands where the ear expects a pause rather than mid-phrase. The 70/40
// thresholds keep it from firing on "Yes," or "Well," — a two-word utterance followed by a pause is
// worse than simply waiting.
function speakableSpan(fresh) {
  const sentence = fresh.match(/^[\s\S]*[.!?…]/);          // greedy: as much as is finished
  if (sentence && sentence[0].trim().length > 1) return sentence[0];
  if (fresh.length >= 70) {
    const clause = fresh.match(/^[\s\S]*[,;:](?=\s)/);
    if (clause && clause[0].trim().length >= 40) return clause[0];
  }
  return '';
}

function startProgress(via) {
  stopProgress(true);
  streamSpoken = '';
  let cursor = 0, spokenTo = 0, card = null;
  progressPoll = setInterval(async () => {
    let p;
    try { p = await api('/api/progress?after=' + cursor, { method: 'GET' }); } catch (e) { return; }
    if (!p || !Array.isArray(p.steps)) return;
    for (const s of p.steps) {
      if (!card) {
        card = document.createElement('div');
        card.id = 'workCard';
        card.className = 'work-card';
        card.innerHTML = '<div class="work-head"><span class="work-spin"></span>WORKING</div><div class="work-steps"></div>';
        const log = document.getElementById('chatLog');
        if (log) { log.appendChild(card); log.scrollTop = log.scrollHeight; }
      }
      const line = document.createElement('div');
      line.className = 'work-step';
      line.textContent = s.t;
      card.querySelector('.work-steps').appendChild(line);
      const log = document.getElementById('chatLog');
      if (log) log.scrollTop = log.scrollHeight;
    }
    cursor = p.total;

    // THE ANSWER, AS IT IS WRITTEN.
    //
    // The median reply took 9.2 seconds and every one of them was a blank screen. Nothing here is
    // faster — the same tokens arrive at the same time — but they arrive VISIBLY, which is the whole
    // difference between "thinking" and "frozen".
    //
    // This block only DRAWS the partial. Speaking it is a separate decision made further down, where
    // speakableSpan picks the part that is finished enough to say and speakSafe says whether it is
    // safe to say it yet. It was once true that the stream was deliberately never spoken and speech
    // fired once from the final reply in send(); that has not been true since streaming speech
    // landed, and the voice-in/voice-out rule is what still keeps this silent outside voice mode.
    if (p.partial) {
      let live = document.getElementById('liveReply');
      if (!live) {
        // Built as a real msg-jarvis bubble, dot and all, so the preview and the finished reply are
        // visually the same object — the text simply stops growing. A differently-styled "streaming"
        // bubble that then gets swapped reads as a flicker.
        live = document.createElement('div');
        live.id = 'liveReply';
        live.className = 'msg-jarvis streaming';
        live.innerHTML = '<div class="dot"></div><div class="txt"></div>';
        const log = document.getElementById('chatLog');
        if (log) { log.appendChild(live); }
      }
      const atBottom = (() => { const l = document.getElementById('chatLog'); return !l || (l.scrollHeight - l.scrollTop - l.clientHeight) < 80; })();
      live.querySelector('.txt').textContent = p.partial;
      const log = document.getElementById('chatLog');
      if (log && atBottom) log.scrollTop = log.scrollHeight;   // do not yank the view if he scrolled up
      // The voice view shows the same text as it lands.
      const va = document.getElementById('voiceAnswer');
      if (va && state.view === 'voice') va.textContent = p.partial;
    }

    // SAY THE ANSWER AS IT IS WRITTEN, NOT AFTER IT IS FINISHED.
    //
    // Measured: one turn was 6423ms wall, of which 6290ms was the model — 968 prompt tokens in, 34
    // out, at roughly 6 tokens a second. Every bit of the wait was generation, so making the VOICE
    // faster moved 15% of it and he correctly said it had not changed. The first sentence exists
    // seconds before the last one does; this speaks it then.
    //
    // Only COMPLETE sentences, never a trailing fragment — half a sentence followed by a correction
    // is worse than silence, which is why this was left unspoken when streaming was first added.
    // Only while the server says speakSafe: the plain-chat exit can still REPLACE this text if it
    // turns out to be a false completion claim, and those words must not have been said already.
    if (p.speak && via === 'voice' && p.speakSafe && p.partial) {
      const span = speakableSpan(String(p.partial).slice(streamSpoken.length));
      if (span) { speak(span, { queue: true, listen: false }); streamSpoken += span; }
    }
    // Progress STEP labels still interrupt rather than queue: they are status, not the answer, and a
    // backlog of stale "working on it" lines read out in order would be worse than the newest one.
    if (p.speak && via === 'voice' && !streamSpoken) {
      for (let i = spokenTo; i < p.steps.length; i++) speak(p.steps[i].t);
    }
    spokenTo = p.steps.length;
    if (p.done) stopProgress(false);
    // 700ms WAS FINE FOR WATCHING AND FAR TOO SLOW FOR SPEAKING. When this only drew text, a beat of
    // lag was invisible. Now the poll is what NOTICES the first finished sentence, so its interval is
    // added to the wait before JARVIS says anything — measured first-word at 5438ms against a reply
    // that was complete at 4243ms, i.e. streaming was LOSING to simply speaking at the end.
    // /api/progress is a read-only route, deliberately unrate-limited, and returns a few hundred
    // bytes; four a second for the seconds a turn lasts is cheaper than the delay it removes.
  }, 220);
}
// How much of the streamed answer has already been said aloud this turn, so the final reply can skip
// it. Read by sendChat once the turn completes; reset by startProgress.
function spokenSoFar() { return streamSpoken; }

// ---------------- "on it, Sir" ----------------
// Anything that cannot answer in a beat gets an immediate acknowledgement with an honest estimate,
// so the UI is never silently chewing. Purely client-side: the server is busy doing the actual
// work and should not be asked to round-trip an ack first.
const SLOW_PATTERNS = [
  [/\b(?:deep[-\s]?research|deep\s+dive|research\s+(?:deeply|properly|in\s+depth|thoroughly))\b/i, 'This one deserves a proper dig — give me a few minutes, Sir.'],
  [/\b(?:research|look into|read up on|investigate|find out about|dig into)\b/i, 'On it, Sir — reading around it now. Roughly a minute.'],
  [/\b(?:my books?|my library|in my library|according to my books?)\b/i, 'Checking your library, Sir — a moment.'],
  [/\b(?:index|re-?index)\s+my\s+library\b/i, 'Re-reading your books, Sir. This takes a minute or two.'],
  [/\b(?:brief me|briefing)\b/i, 'Pulling your briefing together, Sir.'],
  [/\b(?:take control|control my screen)\b/i, 'Taking the screen now, Sir — watch the blue HUD, and stop me any time.'],
  [/\b(?:quiz me|test me)\b/i, 'Drawing a question from your books, Sir.'],
  [/\b(?:what did (?:i|we)|when did (?:we|i)|do you remember)\b/i, 'Casting back, Sir — one moment.'],
];
function ackFor(text) {
  const t = String(text || '');
  for (const [re, msg] of SLOW_PATTERNS) if (re.test(t)) return msg;
  return null;
}

async function runBootSequence() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  if (sessionStorage.getItem('jarvis.booted') === '1') { boot.remove(); return; } // once per launch, not on refresh
  const log = document.getElementById('bootLog');
  const fill = document.getElementById('bootFill');
  const sub = document.getElementById('bootSub');
  const title = document.getElementById('bootTitle');

  let done = false;
  const finish = () => {
    if (done) return; done = true;
    sessionStorage.setItem('jarvis.booted', '1');
    boot.classList.add('gone');
    setTimeout(() => boot.remove(), 800);
    openingGreeting();          // a no-op when he summoned us by name — see suppressGreetingForWake
    // The handover: a wake collected while the boot animation was still up deferred its listening
    // to here, so the mic opens the moment the overlay clears rather than underneath it.
    if (wokeByVoice) beginWakeListening();
  };
  boot.addEventListener('click', () => { bootSound('online'); finish(); });
  const onKey = () => { finish(); window.removeEventListener('keydown', onKey); };
  window.addEventListener('keydown', onKey);
  const safety = setTimeout(finish, 9000);

  try {
    bootSound('up');
    // Fetch the greeting NOW, in parallel with the boot animation. Building it server-side costs a
    // round trip plus up to ~5s of calendar/mail lookups, and doing that after the overlay clears
    // is exactly the pause that read as lag. The boot sequence already runs for ~4.5s, so by the
    // time it finishes this has long since resolved and the greeting can appear instantly.
    greetingPrefetch = api('/api/greeting' + (state && state.lastVia === 'voice' ? '?voice=1' : ''),
      { method: 'GET' }).catch(() => null);
    let ov = null;
    const ovP = fetch('/api/overview').then(r => r.json()).then(j => (ov = j)).catch(() => {});
    await Promise.race([ovP, delay(1400)]);
    const s = (ov && ov.stats) || {};
    const agents = (ov && ov.agents) || [];
    const onlineN = agents.filter(a => a.running).length;
    const w = ov && ov.weather;

    const steps = [
      ['Core BIOS', 'OK', 'ok'],
      ['Neural cores', s.cpu != null ? 'ONLINE · ' + s.cpu + '%' : 'ONLINE', 'ok'],
      ['Memory banks', s.ramPct != null ? s.ramPct + '% · ' + s.ramTotalGB + 'GB' : 'MOUNTED', ''],
      ['Power cell', s.batteryPct != null ? s.batteryPct + '%' + (s.charging ? ' CHARGING' : '') : 'AC POWER', ''],
      ['Storage array', s.diskFreeGB != null ? s.diskFreeGB + 'GB FREE' : 'READY', ''],
      ['Sensor grid', w ? 'CALIBRATED · ' + w.temp + '°' + w.unit : 'CALIBRATED', 'ok'],
      ['Voice / Vision', 'READY', 'ok'],
      ['Fleet agents', onlineN + '/' + agents.length + ' ONLINE', (agents.length && onlineN === agents.length) ? 'ok' : 'warn'],
      ['Network uplink', s.latency != null ? s.latency + ' ms' : 'OFFLINE', s.latency != null ? '' : 'down'],
      ['LLM core', (ov && ov.hasKey) ? 'LINKED' : 'NO LLM', (ov && ov.hasKey) ? 'ok' : 'warn'],
    ];

    await delay(780);                         // reactor + title settle
    sub.textContent = 'INITIALIZING SUBSYSTEMS';
    for (let i = 0; i < steps.length; i++) {
      if (done) return;
      const [l, v, c] = steps[i];
      const row = document.createElement('div');
      row.className = 'bl';
      row.innerHTML = '<span class="bl-l"></span><span class="bl-d"></span><span class="bl-v ' + c + '"></span>';
      row.querySelector('.bl-l').textContent = l;
      row.querySelector('.bl-v').textContent = v;
      log.appendChild(row);
      fill.style.width = Math.round(((i + 1) / steps.length) * 100) + '%';
      await delay(195 + Math.random() * 90);
    }
    if (done) return;
    fill.style.width = '100%';
    sub.textContent = 'ALL SYSTEMS NOMINAL';
    await delay(520);
    if (done) return;
    title.classList.add('flare');
    bootSound('online');
    sub.textContent = greeting().toUpperCase() + ', SIR';
    await delay(1150);
  } catch (e) { /* fall through */ } finally {
    clearTimeout(safety);
    finish();
  }
}

// boot
orbSet('idle');
renderConvo();
runBootSequence();

// ===================== NEURAL NETWORK =====================
// A live self-model: nodes and edges come from /api/neural, which derives them from RUNNING state
// (launchd agents, live tool registries, real site/app counts). Nothing here is a hardcoded diagram,
// so a component added later shows up on its own. Nodes and the wires between them light up as the
// corresponding code path actually executes.
const neural = { open: false, data: null, timer: null, pos: {}, sel: null, busy: false,
                 drill: null, drag: null, bg: null, mode: 'system' };
// Node positions the user dragged, persisted so the layout they arranged survives a reload/restart.
const NN_POS_KEY = 'jarvis.neural.pos';
// The native window (app/main.swift) injects jarvisListDisplays; only there does the page run under
// the macOS title-bar buttons, and the neural header has to clear them (body.in-app in index.html).
if (typeof window.jarvisListDisplays === 'function') document.body.classList.add('in-app');
const nnSavedPos = () => { try { return JSON.parse(localStorage.getItem(NN_POS_KEY) || '{}'); } catch (e) { return {}; } };
const nnSavePos = m => { try { localStorage.setItem(NN_POS_KEY, JSON.stringify(m)); } catch (e) {} };

// Column per group. A deterministic layered layout beats a force simulation here: the point is to
// READ the architecture, and force layouts move things around every frame and overlap the labels.
const NN_COL = { io: 0, core: 1, logic: 2, brain: 2, store: 3, tool: 3, cloud: 4, target: 5, agent: 6 };
const NN_COLOR = { io: '#e879f9', core: '#22d3ee', brain: '#a78bfa', logic: '#38bdf8', store: '#fbbf24',
                   tool: '#34d399', cloud: '#60a5fa', target: '#94a3b8', agent: '#f472b6' };
const NN_GROUP_LABEL = { io: 'YOU', core: 'CORE', brain: 'REASONING', logic: 'LOGIC', store: 'STATE',
                         tool: 'EXECUTION', cloud: 'CLOUD', target: 'TARGETS', agent: 'BACKGROUND AGENTS' };

function nnLayout(g) {
  const svg = document.getElementById('nnSvg');
  const W = svg.clientWidth || window.innerWidth, H = svg.clientHeight || window.innerHeight;
  const cols = {};
  g.nodes.forEach(n => { const c = NN_COL[n.group] ?? 3; (cols[c] = cols[c] || []).push(n); });
  const keys = Object.keys(cols).map(Number).sort((a, b) => a - b);
  const padX = 108, usableW = Math.max(320, W - padX * 2);
  const pos = {};
  keys.forEach((c, ci) => {
    const list = cols[c];
    const x = padX + (keys.length === 1 ? usableW / 2 : (usableW * ci) / (keys.length - 1));
    const topPad = 128, botPad = 168;
    const usableH = Math.max(200, H - topPad - botPad);
    list.forEach((n, i) => {
      const y = topPad + (list.length === 1 ? usableH / 2 : (usableH * i) / (list.length - 1));
      pos[n.id] = { x, y, group: n.group };
    });
  });
  // A dragged node keeps exactly where it was put; everything else uses the computed layout.
  const saved = nnSavedPos();
  for (const id in pos) if (saved[id] && Number.isFinite(saved[id].x)) { pos[id].x = saved[id].x; pos[id].y = saved[id].y; }
  // The node under the cursor right now wins over both — nnRender() runs on every mousemove and
  // would otherwise recompute the layout and snap the node straight back to its slot.
  const d = neural.drag;
  if (d && d.cur && pos[d.id]) { pos[d.id].x = d.cur.x; pos[d.id].y = d.cur.y; }
  // A SAVED POSITION STILL HAS TO BE ON SCREEN. Positions dragged in a taller window, or into a
  // corner, stayed where the question box and the legend cover them: REFERENCE's label sat behind
  // "Ask about how I work" and WAKE WORD's under the legend. Only a node outside the readable band is
  // moved, and only as far as it takes to read it; the ones he arranged inside it stay put, and the
  // node being dragged is never pulled away from the cursor.
  const minX = 60, maxX = W - 60;
  const minY = 96, maxY = H - 124;          // label (r + 14 below the node) clear of the question box
  const legendRight = 212, legendTop = H - 262;
  for (const id in pos) {
    if (d && d.cur && id === d.id) continue;
    const p = pos[id];
    p.x = Math.min(maxX, Math.max(minX, p.x));
    p.y = Math.min(maxY, Math.max(minY, p.y));
    if (p.x < legendRight && p.y > legendTop) p.x = legendRight;
  }
  return pos;
}

function nnRender() {
  const g = neural.drill || neural.data; if (!g) return;
  const pos = neural.pos = nnLayout(g);
  const eG = document.getElementById('nnEdges'), nG = document.getElementById('nnNodes');
  const act = g.activity || {};
  const sel = neural.sel;
  const touching = id => !sel || sel === id || g.edges.some(e => (e.from === sel && e.to === id) || (e.to === sel && e.from === id));

  eG.innerHTML = g.edges.map(e => {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) return '';
    // Curved so parallel links stay distinguishable (Obsidian-style arcs rather than a hairball).
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + (b.x === a.x ? 0 : (b.y - a.y) * 0.08);
    const hot = act[e.from] != null && act[e.to] != null;
    const dim = sel && !(touching(e.from) && touching(e.to));
    return '<path class="nn-edge' + (hot ? ' hot' : '') + (dim ? ' dim' : '') + '" d="M' + a.x + ',' + a.y + ' Q' + mx + ',' + my + ' ' + b.x + ',' + b.y + '"/>';
  }).join('');

  nG.innerHTML = g.nodes.map(n => {
    const p = pos[n.id]; if (!p) return '';
    const col = NN_COLOR[n.group] || '#94a3b8';
    const fresh = act[n.id];                       // ms since it last ran, if within the live window
    const r = n.group === 'core' || n.group === 'brain' ? 15 : 11;
    const dim = sel && !touching(n.id);
    const label = esc(n.label);
    return '<g class="nn-node' + (dim ? ' dim' : '') + '" data-id="' + esc(n.id) + '">' +
      (fresh != null ? '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (r + 9) + '" fill="' + col + '" opacity="' + (0.20 * (1 - fresh / 14000)).toFixed(3) + '"/>' : '') +
      '<circle class="nn-core' + (fresh != null ? ' fire' : '') + '" style="--r:' + r + 'px" cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="rgba(6,20,34,.92)" stroke="' + col + '" stroke-width="' + (fresh != null ? 2.4 : 1.3) + '"' + (fresh != null ? ' filter="url(#nnGlow)"' : '') + '/>' +
      '<text x="' + p.x + '" y="' + (p.y + r + 14) + '">' + label + '</text>' +
    '</g>';
  }).join('');

  [...nG.querySelectorAll('.nn-node')].forEach(el => nnBindNode(el));

  const live = Object.keys(act).length;
  document.getElementById('nnSub').textContent = neural.drill
    ? neural.drill.parent.label + ' network · ' + (g.nodes.length - 1) + ' linked'
    : g.nodes.length + ' components · ' + g.edges.length + ' connections' + (live ? ' · ' + live + ' active now' : ' · idle');
  const groups = [...new Set(g.nodes.map(n => n.group))];
  document.getElementById('nnLegend').innerHTML = groups.map(gr =>
    '<div class="nn-lg"><i style="background:' + (NN_COLOR[gr] || '#94a3b8') + '"></i>' + (NN_GROUP_LABEL[gr] || gr.toUpperCase()) + '</div>').join('');
}

// Clearing focus: drop the selection (so nothing is dimmed), hide the panel, restore the legend.
function nnClearFocus() {
  neural.sel = null;
  document.getElementById('nnInfo').classList.remove('show');
  document.getElementById('nnLegend').classList.remove('hide');
  nnRender();
}

function nnInfo(id) {
  const g = neural.drill || neural.data; const box = document.getElementById('nnInfo');
  const target = id || neural.sel;
  const n = g && g.nodes.find(x => x.id === target);
  if (!n) { box.classList.remove('show'); document.getElementById('nnLegend').classList.remove('hide'); return; }
  const ins = g.edges.filter(e => e.to === n.id).map(e => e.from);
  const outs = g.edges.filter(e => e.from === n.id).map(e => e.to);
  const nameOf = i => (g.nodes.find(x => x.id === i) || {}).label || i;
  document.getElementById('nnInfoTitle').textContent = n.label;
  const kindEl = document.getElementById('nnInfoKind');
  if (kindEl) kindEl.textContent = (NN_GROUP_LABEL[n.group] || n.group || '').toUpperCase() + (n.meta ? '  ·  ' + n.meta : '');
  // The plain-English "what this does" is the point of clicking a node.
  document.getElementById('nnInfoMeta').textContent = n.desc || n.meta || '—';
  document.getElementById('nnInfoLinks').innerHTML =
    (ins.length ? '← FED BY: ' + ins.map(nameOf).join(', ') + '<br>' : '') +
    (outs.length ? '→ FEEDS: ' + outs.map(nameOf).join(', ') : '');
  const exp = document.getElementById('nnExpand');
  if (exp) {
    const canDrill = !neural.drill && n.sub && n.sub.length;
    exp.style.display = canDrill ? '' : 'none';
    exp.onclick = canDrill ? () => nnDrill(n.id) : null;
    if (canDrill) exp.textContent = 'OPEN ' + n.label + ' NETWORK ›';
  }
  box.classList.add('show');
  document.getElementById('nnLegend').classList.add('hide');   // panel and legend share the corner
}

async function nnPoll() {
  try {
    // Same renderer, two data sources: JARVIS's own architecture, or the user's knowledge graph
    // derived from their history. The graphs share a shape, so only the query param changes.
    const q = neural.mode === 'knowledge' ? '/api/neural?mode=knowledge' : '/api/neural';
    const g = await api(q, { method: 'GET' });
    neural.data = g;
    nnRender();
    // An empty knowledge graph is the normal state on day one, not an error — say so rather
    // than showing a blank canvas that reads as broken.
    if (neural.mode === 'knowledge' && g && g.empty && g.note) {
      document.getElementById('nnSub').textContent = g.note;
    }
  } catch (e) { /* transient; next tick retries */ }
}

function nnSetMode(mode) {
  neural.mode = mode;
  neural.drill = null; neural.sel = null;
  neural.pos = {};                       // the two graphs have different nodes; keep layouts apart
  document.getElementById('nnBack').style.display = 'none';
  document.getElementById('nnInfo').classList.remove('show');
  document.getElementById('nnLegend').classList.remove('hide');
  const btn = document.getElementById('nnMode');
  if (btn) btn.textContent = mode === 'knowledge' ? '◧ JARVIS' : '◧ MY GRAPH';
  const title = document.querySelector('.nn-title');
  if (title) title.textContent = mode === 'knowledge' ? 'KNOWLEDGE GRAPH' : 'NEURAL NETWORK';
  const input = document.getElementById('nnInput');
  if (input) input.placeholder = mode === 'knowledge'
    ? 'Ask about your own history — “what have I been working on?”'
    : 'Ask about how I work — “what happens when I say open youtube?”';
  nnPoll();
}

async function openNeural() {
  if (neural.open) return;
  neural.open = true; neural.sel = null;
  neural.mode = neural.mode || 'system';
  document.getElementById('nnAnswer').classList.remove('show');
  document.getElementById('nnInput').value = '';
  document.getElementById('neuralNet').classList.add('visible');
  neural.drill = null; document.getElementById('nnBack').style.display = 'none';
  nnBgStart();
  await nnPoll();
  // 2s cadence keeps the "lights up as it runs" effect responsive without hammering the server.
  clearInterval(neural.timer); neural.timer = setInterval(nnPoll, 2000);
  setTimeout(() => document.getElementById('nnInput').focus(), 100);
}
function closeNeural() {
  neural.open = false;
  document.getElementById('neuralNet').classList.remove('visible');
  clearInterval(neural.timer); nnBgStop();
}
async function askNeural(q) {
  const raw = String(q || '').trim(); if (!raw || neural.busy) return;
  const ans = document.getElementById('nnAnswer');
  neural.busy = true; ans.classList.add('show'); document.getElementById('nnAnswerText').textContent = 'Tracing the graph…';
  try {
    const r = await api('/api/neural/ask', { body: { question: raw, mode: neural.mode } });
    document.getElementById('nnAnswerText').textContent = r.reply || 'No answer, Sir.';
  } catch (e) { document.getElementById('nnAnswerText').textContent = 'Could not analyse: ' + e.message; }
  neural.busy = false;
}

document.getElementById('nnClose').addEventListener('click', closeNeural);
document.getElementById('nnMode').addEventListener('click', () => nnSetMode(neural.mode === 'knowledge' ? 'system' : 'knowledge'));
document.getElementById('nnInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = e.currentTarget.value; e.currentTarget.value = ''; askNeural(v); }
});
window.addEventListener('resize', () => { if (neural.open) nnRender(); });
// ⌘⇧0 mirrors the World Monitor's ⌘⇧W.
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '0' || e.code === 'Digit0')) {
    e.preventDefault(); neural.open ? closeNeural() : openNeural();
  } else if (e.key === 'Escape' && neural.open) { closeNeural(); }
});
// Shown or hidden as the server's reply says (`ui`: { panel, open }, or a list of them from a sentence of
// several clauses). The server resolved the panel against its own registry (server.js PANELS).
function applyUi(ui) {
  for (const u of [].concat(ui || [])) {
    if (!u || !u.panel) continue;
    if (u.panel === 'neural') { if (u.open) { if (!neural.open) openNeural(); } else if (neural.open) closeNeural(); }
    if (u.panel === 'world') { if (u.open) { if (!world.open) openWorld(); } else if (world.open) closeWorld(); }
  }
}


// --- node dragging (persisted) -------------------------------------------------
// Positions are stored per node id in localStorage, so an arrangement survives closing the view,
// reloading the page, and restarting the app.
function nnBindNode(el) {
  const id = el.dataset.id;
  let moved = false, startX = 0, startY = 0;
  el.addEventListener('mouseenter', () => { if (!neural.drag && neural.sel) nnInfo(id); });
  el.addEventListener('mousedown', ev => {
    ev.preventDefault();
    const p = neural.pos[id]; if (!p) return;
    moved = false; startX = ev.clientX; startY = ev.clientY;
    neural.drag = { id, dx: ev.clientX - p.x, dy: ev.clientY - p.y };
    el.classList.add('drag');
  });
  el.addEventListener('click', ev => {
    ev.stopPropagation();   // don't let the backdrop handler treat this as a click-away
    // Suppress the click that ends a drag, otherwise every reposition also toggles selection.
    if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) return;
    neural.sel = neural.sel === id ? null : id;
    nnRender(); nnInfo();
  });
}
window.addEventListener('mousemove', ev => {
  const d = neural.drag; if (!d) return;
  d.cur = { x: ev.clientX - d.dx, y: ev.clientY - d.dy };
  nnRender();
});
window.addEventListener('mouseup', () => {
  const d = neural.drag; if (!d) return;
  if (d.cur) { const saved = nnSavedPos(); saved[d.id] = { x: d.cur.x, y: d.cur.y }; nnSavePos(saved); }
  neural.drag = null;
  document.querySelectorAll('.nn-node.drag').forEach(e => e.classList.remove('drag'));
});

// --- drill-down: a node with children becomes its OWN network ------------------
// The old behaviour put a card over the graph, which covered other nodes. Expanding instead swaps
// the whole canvas to a focused sub-network and offers BACK.
function nnDrill(id) {
  const g = neural.data; const n = g && g.nodes.find(x => x.id === id);
  if (!n || !n.sub) return;
  neural.drill = {
    parent: n,
    nodes: [{ id: n.id, label: n.label, group: n.group, meta: n.meta, desc: n.desc }]
      .concat(n.sub.map(([sid, slabel, sdesc]) => ({ id: sid, label: String(slabel).toUpperCase(), group: n.group, meta: '', desc: sdesc }))),
    edges: n.sub.map(([sid]) => ({ from: n.id, to: sid })),
  };
  neural.sel = null;
  document.getElementById('nnBack').style.display = '';
  nnRender(); nnInfo();
}
function nnUndrill() {
  neural.drill = null; neural.sel = null;
  document.getElementById('nnBack').style.display = 'none';
  nnRender(); nnInfo();
}

// --- animated background -------------------------------------------------------
// Drifting points that link when close — a "live substrate" under the real graph. Deliberately
// low-contrast and paused while the view is closed so it costs nothing in the background.
function nnBgStart() {
  const c = document.getElementById('nnBg'); if (!c) return;
  const ctx = c.getContext('2d');
  const fit = () => { c.width = c.clientWidth; c.height = c.clientHeight; };
  fit();
  const N = Math.min(70, Math.round((c.width * c.height) / 26000));
  const pts = Array.from({ length: N }, () => ({
    x: Math.random() * c.width, y: Math.random() * c.height,
    vx: (Math.random() - .5) * .22, vy: (Math.random() - .5) * .22, r: Math.random() * 1.5 + .5,
  }));
  cancelAnimationFrame(neural.bg);
  const step = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > c.width) p.vx *= -1;
      if (p.y < 0 || p.y > c.height) p.vy *= -1;
    }
    ctx.lineWidth = .6;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (d2 < 20000) {
          ctx.strokeStyle = 'rgba(94,212,247,' + (0.11 * (1 - d2 / 20000)).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(120,220,255,.22)';
      ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, pts[i].r, 0, 6.283); ctx.fill();
    }
    neural.bg = requestAnimationFrame(step);
  };
  step();
  window.addEventListener('resize', fit);
}
function nnBgStop() { cancelAnimationFrame(neural.bg); neural.bg = null; }

document.getElementById('nnBack').addEventListener('click', nnUndrill);
document.getElementById('nnClear').addEventListener('click', () => {
  document.getElementById('nnAnswer').classList.remove('show');
  document.getElementById('nnAnswerText').textContent = '';
  document.getElementById('nnInput').value = '';
  document.getElementById('nnInput').focus();
});


// Click anywhere that is not a node → stop focusing it. Bound to the overlay itself so the graph,
// the background canvas and the empty space all count as "click away"; the header, legend, panel
// and chatbox sit above it and stop their own clicks.
document.getElementById('neuralNet').addEventListener('click', ev => {
  if (ev.target.closest('.nn-node, .nn-info, .nn-ask, .nn-head, .nn-legend')) return;
  nnClearFocus();
});
document.getElementById('nnInfoClose').addEventListener('click', ev => { ev.stopPropagation(); nnClearFocus(); });

// ===================== UNDO SUGGESTION =====================
// Shown only when the server says the last action is genuinely reversible. Auto-hides after 5s
// (the drain bar shows the remaining time); ✕ dismisses immediately. Dismissing only hides the
// prompt — the server keeps the undo available a little longer, so a slow "wait, undo that" still
// works via the same endpoint.
let undoTimer = null;
function showUndo(u) {
  if (!u || !u.label) return;
  const pop = document.getElementById('undoPop');
  document.getElementById('undoLabel').textContent = u.label;
  pop.classList.remove('show'); void pop.offsetWidth;   // restart the drain animation
  pop.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 5000);
}
function hideUndo() { clearTimeout(undoTimer); document.getElementById('undoPop').classList.remove('show'); }
document.getElementById('undoX').addEventListener('click', hideUndo);
document.getElementById('undoGo').addEventListener('click', async () => {
  hideUndo();
  try {
    const r = await api('/api/undo', { body: {} });
    pushMsg('assistant', r.reply || 'Undone, Sir.', r.ok === false);
  } catch (e) { pushMsg('assistant', 'Could not undo: ' + e.message, true); }
});
