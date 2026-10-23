'use strict';
// ---------------------------------------------------------------------------
// JARVIS identity — who is actually sitting in front of the machine, and how much of Atharv's life
// they are allowed to see.
//
// THREE TIERS, in descending trust:
//   root    Atharv. Everything: memory, profile, agentic work, actions, the lot. Today's behaviour.
//   known   A face he has enrolled. Chat + vision + BASIC agentic work. NOTHING personal: no
//           memory, no profile facts, no action log, no habits, no settings.
//   unknown Anyone else, and the default. A plain assistant. It answers general questions and
//           reveals nothing whatsoever about him — not even that there is anything to reveal.
//
// THE POINT IS THAT IT IS SILENT. The tier is never announced, never explained, never negotiated.
// A stranger asking "what tier am I" or "who am I" gets an ordinary non-answer, because a system
// that tells you it is withholding something has told you the one thing worth knowing.
//
// WHAT THIS IS NOT. The API token is still the real security boundary — it always was, and this
// changes nothing about it. This is a PRIVACY layer for the case the token cannot cover: the
// machine is unlocked, JARVIS is open, and someone who is not him is looking at it. Treating it as
// authentication would be a mistake; a photograph would beat it.
//
// FAIL DIRECTION, which is the whole design:
//   · no face in frame          → tier UNCHANGED. He walked away; that is not an intrusion, and
//                                 demoting on absence would lock him out every time he stood up.
//   · a face that does not match → demote to unknown. Someone IS there and is not him.
//   · camera unavailable/error   → tier unchanged, and it is logged. A broken camera must not be a
//                                 silent promotion, nor a lockout.
//
// HONEST LIMITATION, recorded here because it will not be obvious later: the classifier is a
// general vision model (qwen3-vl:2b), not a face-recognition network. It has no face embeddings and
// no notion of identity distance. It is being asked "does this look like the same person as this
// reference photo", which is a question it answers plausibly and not reliably. Accuracy is measured
// by test_identity.js rather than assumed, and the fail direction above exists precisely because
// this component is expected to be wrong sometimes.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let deps = { jlog: () => {}, audit: () => {}, llm: null, visionModel: () => '' };
function init(d) { deps = Object.assign(deps, d || {}); }

const TIERS = ['unknown', 'known', 'root'];
const rank = t => Math.max(0, TIERS.indexOf(t));

// How long a classification stands before it is called stale. Raised from 25s when the client moved
// to a 2.5-minute cadence: a freshness window SHORTER than the check interval would mark every
// reading stale within seconds of taking it, which is not a useful signal. Kept comfortably longer
// than the interval so an ordinary late frame does not flap it.
//
// This only affects what snapshot() reports. It deliberately does NOT expire the tier — a stale
// reading is not evidence of an intruder, and decaying to unknown on staleness is the lockout this
// design already rejected once.
const TTL_MS = 200000;

let FACES_DIR = null;
// STARTS AT ROOT, NOT UNKNOWN — and this is a considered decision, not a default.
//
// Caught in testing: with the initial tier set to "unknown", the instant a face was enrolled the
// owner was demoted, because no classification had run yet. A camera that was busy, denied, or
// simply not reached for fifteen seconds would have locked him out of his own assistant, and a
// permanently denied permission would have locked him out for good. That is a worse failure than
// the thing this feature defends against.
//
// So absence of evidence is not evidence of an intruder. Only an actual unrecognised FACE demotes.
// The window this opens — a stranger in the first fifteen seconds — is real and accepted: the API
// token is still the door, and this layer was never authentication.
let state = { tier: 'root', name: null, at: 0, confidence: 0, lastSeen: 0, checks: 0, demotions: 0 };

function setFacesDir(dir) { FACES_DIR = dir; try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }

// ---------------- enrolment ----------------
// A reference photo is stored as <tier>__<name>.jpg. Tier lives in the FILENAME on purpose: there is
// no separate index to fall out of sync with the images, and deleting the file is a complete
// revocation with no leftover record of the person.
// 384px on the longest side. Measured: the vision encoder costs ~18s per call at this size and
// image dimensions are what drive it, so references are held here rather than at whatever the
// camera or the photo library happened to produce.
const REF_MAX_PX = 384;
// A hard ceiling on what will even be accepted, before decoding. A 12 MP photo is ~8 MB of base64;
// refusing it outright is better than decoding it into memory to then shrink it.
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const SAFE = /^[a-z0-9][a-z0-9 _-]{0,40}$/i;
function enroll(name, tier, dataUrl) {
  if (!FACES_DIR) return { ok: false, say: 'Face storage is not configured.' };
  if (!SAFE.test(String(name || ''))) return { ok: false, say: 'That name cannot be used for a face file.' };
  if (!TIERS.includes(tier)) return { ok: false, say: 'Unknown tier.' };
  // Refused before decoding, not after: turning an 8 MB base64 string into a Buffer just to learn it
  // was too big is the expensive way to say no.
  if (String(dataUrl || '').length > MAX_UPLOAD_BYTES) {
    return { ok: false, say: 'That image is too large — anything up to about 8 MB is fine.' };
  }
  // webp and heic accepted too: heic is what an iPhone actually produces, and refusing the format
  // his own phone shoots in would make "send a photo" useless on the one device he asked for.
  // Whatever arrives, sips below rewrites it as a normalised JPEG.
  const m = String(dataUrl || '').match(/^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,(.+)$/i);
  if (!m) return { ok: false, say: 'That is not an image I can store — send a JPEG, PNG, WEBP or HEIC.' };
  const file = path.join(FACES_DIR, tier + '__' + String(name).replace(/[^a-z0-9 _-]/gi, '') + '.jpg');
  try {
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    // NORMALISE ON THE WAY IN, server-side, whatever the client sent.
    //
    // Every reference photo is attached to EVERY classification, so an oversized enrolment is not a
    // one-off cost — it is paid on every check, forever. A phone photo is 4000px wide; measured, the
    // vision encoder is already ~18s per call at 384px and image size is the part that grows. The
    // client downscales too, but the client is the untrusted half: a direct POST, an old tab, or a
    // future caller would otherwise put a 12 MP image into the hot path.
    //
    // sips is macOS's own tool, so this stays dependency-free. -Z fits the LONGEST side and only
    // shrinks, so an already-small reference is left untouched.
    try {
      // "-s format jpeg" as well as the resize: a HEIC straight off his iPhone, or a WEBP saved from
      // the web, is written back out as a JPEG the vision path can actually read. Without it the file
      // would carry a .jpg name over non-JPEG bytes, which fails later and confusingly.
      require('child_process').execFileSync('/usr/bin/sips',
        ['-s', 'format', 'jpeg', '-Z', String(REF_MAX_PX), file, '--out', file],
        { timeout: 15000, stdio: 'ignore' });
    } catch (e) { deps.jlog('Identity › could not normalise the reference image: ' + e.message); }
    const kb = Math.round((fs.statSync(file).size || 0) / 1024);
    deps.audit('face_enroll', { name, tier, kb }, 'ok');
    deps.jlog('Identity › enrolled "' + name + '" as ' + tier + ' (' + kb + ' KB after normalising)');
    return { ok: true, say: 'Stored.', file };
  } catch (e) { return { ok: false, say: e.message }; }
}

function enrolled() {
  if (!FACES_DIR) return [];
  try {
    return fs.readdirSync(FACES_DIR).filter(f => /\.(jpe?g|png)$/i.test(f)).map(f => {
      const m = f.match(/^(root|known|unknown)__(.+)\.(?:jpe?g|png)$/i);
      return m ? { tier: m[1].toLowerCase(), name: m[2], file: f } : { tier: 'known', name: f.replace(/\.\w+$/, ''), file: f };
    });
  } catch (e) { return []; }
}

function forget(name) {
  const hit = enrolled().find(e => e.name.toLowerCase() === String(name || '').toLowerCase());
  if (!hit) return { ok: false, say: 'No enrolled face by that name.' };
  try {
    fs.unlinkSync(path.join(FACES_DIR, hit.file));
    // The descriptor goes with the photo. Leaving it behind would keep recognising someone the
    // roster says has been removed — a revocation that does not revoke.
    try { fs.unlinkSync(descriptorFile(hit.name, hit.tier)); } catch (e) {}
    deps.audit('face_forget', { name: hit.name }, 'ok');
    return { ok: true, say: 'Removed.' };
  } catch (e) { return { ok: false, say: e.message }; }
}

// ---------------- classification ----------------
// Deliberately a CLOSED question with a tiny answer space. Asking a 2B model to "identify the
// person" invites it to narrate; asking it to pick one label from a list it was given, or say NONE,
// is the same shape as every other structured call in this project and fails in a way that can be
// parsed.
function buildPrompt(names) {
  return 'Reference photos of known people are attached first, each labelled. The LAST image is a ' +
    'live camera frame.\n\n' +
    'Answer with ONE line and nothing else:\n' +
    '  NOFACE            if the last image contains no clearly visible human face\n' +
    '  MATCH <label>     if the face in the last image is the SAME PERSON as that labelled reference\n' +
    '  NONE              if a face is visible but it is not any of the references\n\n' +
    'Labels available: ' + (names.join(', ') || '(none)') + '\n' +
    'Be strict. If you are unsure whether it is the same person, answer NONE.';
}

// NO ANSWER IS NOT AN ANSWER OF "NOT HIM".
//
// This is the most dangerous line in the file and the first version got it wrong. Anything that was
// not NOFACE or MATCH fell through to "none", which DEMOTES. Measured: qwen3-vl:2b is a thinking
// model and returns an EMPTY content field for every two-image comparison — it reasons for 800
// tokens and 43 seconds and never reaches a conclusion. So the old parse turned "the model said
// nothing" into "that is not Atharv", and every single check would have quietly demoted him to
// unknown on his own machine.
//
// Silence is now its own outcome, and the caller leaves the tier alone. Only an explicit, parseable
// "a face is here and it is not one of yours" may demote.
function parse(text) {
  const s = String(text || '').trim().split('\n')[0].trim();
  if (!s) return { kind: 'unclear' };
  if (/^noface\b/i.test(s)) return { kind: 'noface' };
  const m = s.match(/^match\s+(.+?)\s*$/i);
  if (m) return { kind: 'match', label: m[1].replace(/["'.]/g, '').trim() };
  if (/^none\b/i.test(s)) return { kind: 'none' };
  return { kind: 'unclear' };                 // anything else is a model failing, not a verdict
}

// ---------------- descriptor matching (the real recogniser) ----------------
//
// THIS REPLACED THE VISION MODEL, and the reason is measured rather than aesthetic.
//
// The first implementation asked qwen3-vl:2b "is this the same person as this reference photo". It
// cannot do that: it is a THINKING model, and on any two-image comparison it reasons for ~850
// characters and returns an EMPTY answer — verified at 800 tokens and 43 seconds. Each attempt also
// cost ~18s and evicted the chat model from RAM on this 8 GB machine. It was slow, disruptive, and
// wrong.
//
// face-api.js does what that model could not: a 128-dimension face DESCRIPTOR, compared by
// Euclidean distance. It is the same technique every real face-recognition system uses, it runs in
// the browser in milliseconds, and it needs no LLM at all.
//
// THE BROWSER EXTRACTS, THE SERVER DECIDES. The client sends 128 floats, never a claimed identity —
// a client that could say "I am Atharv" would defeat the entire feature. Matching happens here, on
// numbers the client cannot usefully forge without already having his face.
//
// 0.5 is face-api's own conventional threshold and the one his prototype used. Lower is stricter.
const MATCH_THRESHOLD = 0.5;
const DESC_LEN = 128;

function descriptorFile(name, tier) {
  return path.join(FACES_DIR, tier + '__' + String(name).replace(/[^a-z0-9 _-]/gi, '') + '.descriptor.json');
}

function saveDescriptor(name, tier, descriptor) {
  if (!Array.isArray(descriptor) || descriptor.length !== DESC_LEN) return false;
  if (!descriptor.every(n => typeof n === 'number' && Number.isFinite(n))) return false;
  try { fs.writeFileSync(descriptorFile(name, tier), JSON.stringify(descriptor)); return true; }
  catch (e) { return false; }
}

// Every enrolled descriptor, with the tier read off the filename exactly as the photos are.
function descriptors() {
  if (!FACES_DIR) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(FACES_DIR)) {
      const m = f.match(/^(root|known|unknown)__(.+)\.descriptor\.json$/i);
      if (!m) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(FACES_DIR, f), 'utf8'));
        if (Array.isArray(d) && d.length === DESC_LEN) out.push({ tier: m[1].toLowerCase(), name: m[2], d });
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < DESC_LEN; i++) { const x = a[i] - b[i]; s += x * x; }
  return Math.sqrt(s);
}

// The closest enrolled face, or null when nothing is near enough. Returning the distance as well as
// the name matters: it is the one number that says how sure this was, and it is logged so a
// threshold can be tuned from real readings instead of guessed at.
function bestMatch(descriptor) {
  const all = descriptors();
  if (!all.length) return null;
  let best = null;
  for (const e of all) {
    const dist = euclidean(descriptor, e.d);
    if (!best || dist < best.distance) best = { name: e.name, tier: e.tier, distance: dist };
  }
  return best;
}

// Classify from a DESCRIPTOR rather than an image. Same fail directions as the image path: only a
// face that is present and demonstrably not his may demote.
function classifyDescriptor(descriptor) {
  state.checks++;
  if (!Array.isArray(descriptor) || descriptor.length !== DESC_LEN) {
    return { tier: state.tier, reason: 'bad-descriptor' };
  }
  if (!descriptors().length) {
    // Nothing enrolled with a descriptor — the feature is not configured, so it does not interfere.
    state = Object.assign(state, { tier: 'root', name: null, at: Date.now() });
    return { tier: 'root', reason: 'no-enrolment' };
  }
  const best = bestMatch(descriptor);
  const now = Date.now();
  const prev = state.tier;
  if (best && best.distance <= MATCH_THRESHOLD) {
    state = { tier: best.tier, name: best.name, at: now, confidence: 1 - best.distance,
      lastSeen: now, checks: state.checks, demotions: state.demotions };
    if (rank(best.tier) < rank(prev)) { state.demotions++; deps.audit('identity_demote', { from: prev, to: best.tier }, 'ok'); }
    deps.jlog('Identity › ' + best.name + ' (' + best.tier + ') at distance ' + best.distance.toFixed(3));
    return { tier: best.tier, reason: 'match', name: best.name, distance: best.distance };
  }
  // A face was extracted — someone IS there — and it is not near any enrolled descriptor.
  state = { tier: 'unknown', name: null, at: now, confidence: 0, lastSeen: now,
    checks: state.checks, demotions: state.demotions + (prev !== 'unknown' ? 1 : 0) };
  if (prev !== 'unknown') deps.audit('identity_demote', { from: prev, to: 'unknown' }, 'unrecognised face');
  deps.jlog('Identity › unrecognised face' + (best ? ' (nearest ' + best.name + ' at ' + best.distance.toFixed(3) + ')' : ''));
  return { tier: 'unknown', reason: 'unrecognised', distance: best ? best.distance : null };
}

// Returns the tier WITHOUT saying anything to anyone. The caller decides what to do with it; nothing
// in this module ever produces user-facing text about tiers.
// A HARD FLOOR, independent of whatever the client decides to do.
//
// The client now skips unchanged scenes, which is where the saving comes from — but the client is
// the least trustworthy part of this system, and a stale tab, a second window, or a bug could send
// a frame every fifteen seconds forever. Each vision call evicts the chat model on this 8 GB
// machine and costs the next reply thirty seconds, so the server keeps its own minimum spacing and
// simply declines to think more often than this. Declining leaves the tier untouched, which is the
// safe direction: it can only ever delay a demotion, never invent a promotion.
const MIN_MODEL_GAP_MS = 45000;
let lastModelCall = 0;

async function classify(frameDataUrl) {
  state.checks++;
  if (Date.now() - lastModelCall < MIN_MODEL_GAP_MS) {
    return { tier: state.tier, reason: 'rate-limited' };
  }
  const refs = enrolled();
  if (!refs.length) {
    // Nothing enrolled means nothing to protect against — staying at root here would be a security
    // hole, but demoting a machine with no enrolment configured would make JARVIS useless out of
    // the box. So: no enrolment = feature off, tier stays root.
    state = Object.assign(state, { tier: 'root', name: null, at: Date.now(), confidence: 0 });
    return { tier: 'root', reason: 'no-enrolment' };
  }
  if (!deps.llm) return { tier: state.tier, reason: 'no-model' };

  const content = [];
  for (const r of refs.slice(0, 6)) {           // a hard cap: every reference costs vision context
    try {
      const b64 = fs.readFileSync(path.join(FACES_DIR, r.file)).toString('base64');
      content.push({ type: 'text', text: 'REFERENCE — label: ' + r.name });
      content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
    } catch (e) {}
  }
  content.push({ type: 'text', text: buildPrompt(refs.map(r => r.name)) });
  content.push({ type: 'image_url', image_url: { url: frameDataUrl } });

  let out = '';
  lastModelCall = Date.now();
  try {
    const r = await deps.llm({
      system: 'You compare faces between reference photos and a live frame. Answer in the exact format asked. Never explain.',
      messages: [{ role: 'user', content }],
      // 20s, not 60s: a face check that takes a minute is useless — he has moved on. And a SHORT
      // keep_alive so the 1.9 GB vision model releases RAM quickly instead of squatting where the
      // chat model needs to be.
      orModel: deps.visionModel(), vision: true, max_tokens: 20, timeoutMs: 20000, keepAlive: '5s',
      // Face frames are of him, in his home. They never leave the machine, whatever else is configured.
      forceLocal: true,
    });
    out = r.text || '';
  } catch (e) {
    deps.jlog('Identity › classifier error: ' + (e.message || e));
    return { tier: state.tier, reason: 'error' };          // unchanged, never a silent promotion
  }

  const got = parse(out);
  const now = Date.now();

  if (got.kind === 'unclear') {
    // The model gave no usable verdict. That is a fact about the MODEL, not about who is sitting
    // here, and it must never move the tier. Logged rather than silent, because a classifier that
    // is permanently unclear is a broken feature and should be visible as one.
    deps.jlog('Identity › no usable verdict from the vision model — tier left at "' + state.tier + '"');
    return { tier: state.tier, reason: 'unclear' };
  }
  if (got.kind === 'noface') {
    // Absence is not intrusion. Tier is left exactly as it was.
    return { tier: state.tier, reason: 'noface' };
  }
  if (got.kind === 'match') {
    const hit = refs.find(r => r.name.toLowerCase() === got.label.toLowerCase());
    if (hit) {
      const before = state.tier;
      state = { tier: hit.tier, name: hit.name, at: now, confidence: 1, lastSeen: now,
        checks: state.checks, demotions: state.demotions };
      if (rank(hit.tier) < rank(before)) { state.demotions++; deps.audit('identity_demote', { from: before, to: hit.tier }, 'ok'); }
      return { tier: hit.tier, reason: 'match', name: hit.name };
    }
    // Matched a label that is not enrolled — treat as no match rather than trusting a hallucinated name.
    deps.jlog('Identity › model returned an unknown label "' + got.label.slice(0, 30) + '" — treating as unrecognised');
  }
  // A face is present and it is not one of his. This is the only path that demotes.
  const prev = state.tier;
  state = { tier: 'unknown', name: null, at: now, confidence: 0, lastSeen: now,
    checks: state.checks, demotions: state.demotions + (prev !== 'unknown' ? 1 : 0) };
  if (prev !== 'unknown') deps.audit('identity_demote', { from: prev, to: 'unknown' }, 'unrecognised face');
  return { tier: 'unknown', reason: 'unrecognised' };
}

// The tier as the rest of the server should see it. Stale classifications do NOT decay to unknown —
// a lid closed for an hour is not an intruder, and the token still guards the door.
function tier() {
  if (!enrolled().length) return 'root';
  return state.tier;
}
function fresh() { return Date.now() - state.at < TTL_MS; }
function snapshot() {
  return { tier: tier(), name: state.name, fresh: fresh(), checks: state.checks,
    demotions: state.demotions,
    // `recognisable` is reported per person, because a photo without a descriptor is a face JARVIS
    // can DISPLAY but never MATCH. Parth sat in this roster as "known" for a day while actually
    // being classified unknown, and nothing anywhere said so. A roster that cannot show that
    // distinction is a roster that lies by omission.
    enrolled: enrolled().map(e => ({
      name: e.name, tier: e.tier,
      recognisable: descriptors().some(d => d.name === e.name && d.tier === e.tier),
    })) };
}

// ---------------- what each tier may reach ----------------
// One table, consulted everywhere, so a new lane cannot quietly become a leak by forgetting to ask.
// `personal` is the important one: memory, profile facts, the action log, habits, settings — every
// lane added today that reads something about him.
const CAPS = {
  root:    { personal: true,  actions: true,  agentic: 'full',  vision: true,  research: true },
  known:   { personal: false, actions: false, agentic: 'basic', vision: true,  research: true },
  unknown: { personal: false, actions: false, agentic: 'none',  vision: false, research: false },
};
function can(what) { return (CAPS[tier()] || CAPS.unknown)[what]; }

// The sentence a non-root user gets. Deliberately flat and incurious: it does not hint that there
// is a tier, a policy, or anything being withheld. "I don't have that" is what an assistant without
// the information would say, and that is exactly the impression to leave.
function deflect() {
  return 'I don\'t have anything on that.';
}

module.exports = { init, setFacesDir, enroll, enrolled, forget, classify, classifyDescriptor, saveDescriptor, descriptors, bestMatch, tier, fresh, snapshot, can, deflect, TIERS, CAPS, TTL_MS, MATCH_THRESHOLD, DESC_LEN };
