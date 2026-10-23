'use strict';
// ---------------------------------------------------------------------------
// JARVIS personal profile — who the user is and how they want to be dealt with.
//
// A NEW MACHINE STARTS BLANK (2026-09-24). The defaults below used to be one person's answers, so a
// fresh install called a stranger by his name's pronouns, assumed Hinglish, India's time zone and a
// school syllabus. They are neutral now; everything personal lives in state/profile.json (never
// committed), which the Settings panel and the questionnaire fill in. userRef()/honorific()/
// honorify() below are the ONE place the rest of JARVIS asks who it is talking to and how.
//
// WHY NOT memory.json: those facts are injected into EVERY prompt. That store holds two entries
// today and is the right size for two entries; a full profile there would eat the local 3B's
// context on every turn, which is exactly what the prompt-compaction work went to lengths to
// avoid. So this splits in two:
//
//   · PREFERENCES — small, stable, and behavioural. These genuinely must be in every prompt,
//     because they change how JARVIS speaks and what it may do. Kept to a handful of lines.
//   · FACTS — the long tail (people, timetable, projects). Written into the episodic store and
//     retrieved by the same tf-idf as everything else, so a question about school pulls the school
//     facts and nothing else.
//
// Answers come from the questionnaire, so this file is edited by conversation, not by hand.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let deps = { jlog: () => {}, audit: () => {}, stateDir: null, recall: null };
// A new state folder reads its own profile — the cache never crosses folders (see recall.js init, 2026-09-25).
function init(d) {
  if (d && d.stateDir !== undefined && d.stateDir !== deps.stateDir) cache = null;
  deps = Object.assign(deps, d || {});
}

const FILE = () => path.join(deps.stateDir || '/tmp', 'profile.json');

// Defaults are the answers given on 2026-08-08. Anything not asked about stays null so the prompt
// simply omits it rather than asserting something invented.
const DEFAULTS = {
  // 'sir' | 'maam' | 'boss' | 'name' | 'mix' | 'none' — HOW to address the user, NOT where they live.
  // 'none' on a new machine: no honorific until the user picks one (Settings).
  address: 'none',
  // WHERE HE LIVES. Separate from `address` above, which is a salutation setting — a distinction that
  // already cost one bug: the SOS script read `address` and would have told an ambulance dispatcher
  // "The address is: mix."
  //
  // Used ONLY when he is actually at this address. `homeMatch` is tested against the reverse-geocoded
  // location, so the flat number is given when he is home and withheld when he is not — sending
  // paramedics to his flat while he is collapsed in another town is the worst thing this file could do.
  // BLANK BY DESIGN — the real values live in state/profile.json, which is vaulted and never
  // committed. They used to sit here as literals, which meant a stranger's fresh clone did not fall
  // back to NOTHING, it fell back to ATHARV'S FLAT. An SOS from that install would have read his
  // street address to a dispatcher for someone who has never been there — precisely the failure the
  // note above warns about, arriving through a different door.
  // Empty is safe: a missing homeMatch already means "not at a known address", so the geocoded
  // location is given instead, flagged as geocoded and not human-confirmed.
  homeAddress: '',
  homeMatch: '',      // regex source, case-insensitive, matched against the geocoded address
  name: '',
  pronouns: 'they/them',       // how JARVIS refers to the user when writing ABOUT them
  city: '',      // weather/traffic resolve here; city granularity is enough
  language: 'en',              // 'en-understand-hi' = also parses Hindi/Punjabi/Hinglish, answers in English
  // WHERE, for everything that depends on it. Empty = read from this Mac (System Settings → Language &
  // Region / Date & Time), so a machine in Germany is German and one in the US is American without
  // anyone configuring it. The SOS lane does NOT use these: it resolves the country from where the
  // user IS, every time (sos.js).
  country: '',                 // ISO 3166 two letters, e.g. 'US', 'DE', 'IN'
  homeZone: '',                // IANA time zone, e.g. 'America/New_York'
  units: 'auto',               // 'auto' (this Mac's setting) | 'metric' | 'us'
  familyZone: '',              // family_time: where family lives; empty = not set
  candid: false,               // true = never sugar-coat; push back where the reasoning is weak
  explainLevel: '',            // e.g. '9th-10th grade'; empty = pitch it to the question
  birthday: null,              // declined — nothing depends on it
  nicknameStrategy: 'learn',   // ask on a miss, then remember that answer for next time
  music: 'Spotify',
  notes: 'Apple Notes',
  calendar: 'Apple Calendar',
  briefing_include: ['messages', 'calendar', 'weather-actionable', 'system'],
  // Water/look-away nudges (proactive.js sigHydration) — opt-in, OFF until he turns them on. The ONE place this lives since
  // 2026-10-15 (Settings showed this default as on while the reminder read its own off switch in proactive.json).
  breaks: false,
  // Tutor mode's unprompted side (Settings → "Daily quiz", 2026-10-15, his ask): the "N questions ready" nudge (proactive.js
  // sigTutor, via server.js tutorDue) and Dream drafting new study cards each night (dream.js jobPrepCards, via quizOn).
  // Off = neither; "quiz me" still works when he asks, and his topics and cards are kept.
  dailyQuiz: true,
  // Settings → Quiz new topics (2026-10-15): 'ask' = a new study topic is offered first (tutor.js learn_topic — "quiz" or
  // "always"); 'always' = added straight away, which is what answering "always" sets.
  quizNewTopics: 'ask',
  // Emergency numbers live HERE, in a local file, and deliberately NOT in the episodic retrieval
  // store. Anything in retrieval can be pulled into a prompt by a fuzzy keyword match, and prompts
  // can go to OpenRouter — so putting his family's phone numbers there would mean a stray question
  // could ship them off the machine. These are reachable only by an explicit tool call.
  emergency: [],
  replyStyle: 'adaptive',      // terse for actions, fuller for questions and failures
  uncertainty: 'read-act-write-ask',
  manner: 'ironman',           // dry wit, more side-comments
  rhythm: 'irregular',         // infer presence from activity; never assume a timetable
  briefing: 'on-open-if-something',
  pagePrivacy: 'local-only',   // may read logged-in pages, but only the offline model sees them
  awayAllowed: ['maintenance', 'reads', 'queue'],
  extraConfirm: [],            // current gates judged correct — nothing added
  // Narrowed 2026-08-08: he chose "school syllabus only" for the tutor. The wider list stays out —
  // drilling him on philosophy he did not ask to be drilled on is how the tutor gets switched off.
  studyTopics: [],
  addBooksFor: [],             // explicitly asked NOT to add business/marketing books
  contactAmbiguity: 'ask',     // keep stopping to ask when a name matches more than one person
  updated: null,
};

let cache = null;
function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { saved = {}; }
  cache = Object.assign({}, DEFAULTS, saved || {});
  return cache;
}
function save(patch) {
  const p = Object.assign(load(), patch || {}, { updated: Date.now() });
  cache = p;
  try { fs.writeFileSync(FILE(), JSON.stringify(p, null, 2)); } catch (e) {}
  deps.jlog('Profile › updated (' + Object.keys(patch || {}).join(', ') + ')');
  return p;
}
function get() { return load(); }

// ---------------- who JARVIS is talking to ----------------
// userRef: how prompts name the user — their name, or "the user" before they have given one.
// userLabel: the speaker label in stored transcripts and memory ("<name> asked:"), "User" when unnamed.
function userName() { return String(load().name || '').trim(); }
function userRef() { return userName() || 'the user'; }
function userLabel() { return userName() || 'User'; }
// Pronouns as words, from the one setting. Anything unrecognised is they/them.
function pronouns() {
  const p = String(load().pronouns || '').toLowerCase();
  if (p.startsWith('he')) return { subj: 'he', obj: 'him', poss: 'his' };
  if (p.startsWith('she')) return { subj: 'she', obj: 'her', poss: 'her' };
  return { subj: 'they', obj: 'them', poss: 'their' };
}
// The honorific JARVIS's built-in replies carry. 'mix' keeps "Sir" in the fixed replies — the model
// varies it in its own (see promptLines).
function honorific() {
  const p = load();
  if (p.address === 'sir' || p.address === 'mix') return 'Sir';
  if (p.address === 'maam') return 'Ma\'am';
  if (p.address === 'boss') return 'Boss';
  if (p.address === 'name') return userName();
  return '';
}
// JARVIS's OWN reply wording carries "Sir" in several hundred places. Rather than edit every one, the
// finished reply is rewritten here, once, to the honorific the user chose — this reads only strings
// JARVIS itself produced (never what the user typed), and does nothing when the choice is "Sir".
function honorify(text) {
  if (typeof text !== 'string' || !text) return text;
  const h = honorific();
  if (h === 'Sir') return text;
  // A title before a name — "Sir Isaac Newton" in an answer — is content, not the honorific.
  const HON = /\bSir\b(?!\s+[A-Z][a-z])/g;
  if (h) return text.replace(HON, h);
  return text
    .replace(/,\s*Sir(?=\s*[—–]|[.!?:;,)"”’]|$)/g, '')    // "Done, Sir." / "now, Sir — enjoy" → "Done." / "now — enjoy"
    .replace(/(^|[.!?]\s+|\n)Sir,\s*(\S)/g, (m, lead, c) => lead + c.toUpperCase())   // "Sir, the file…"   → "The file…"
    .replace(/\s+Sir(?=[.!?—–:;,)"”’]|$)/g, '')         // "Yes Sir."          → "Yes."
    .replace(/\bSir\b(?!\s+[A-Z][a-z])\s*/g, '');
}

// ---------------- where this Mac is ----------------
// Read from macOS itself (Language & Region), cached for the process. Machine-owned settings, not guesses.
let _sysLocale = null;
function systemLocale() {
  if (_sysLocale) return _sysLocale;
  let tag = '';
  try {
    tag = require('child_process').execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();   // e.g. en_IN, de_DE
  } catch (e) {}
  if (!tag) { try { tag = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (e) {} }
  const m = /^([a-z]{2,3})(?:[_-][A-Za-z]{4})?[_-]([A-Z]{2})/.exec(tag);
  _sysLocale = { tag, language: m ? m[1] : 'en', region: m ? m[2] : '' };
  return _sysLocale;
}
function country() { return String(load().country || systemLocale().region || '').toUpperCase(); }
function timeZone() {
  const p = load();
  if (p.homeZone) return p.homeZone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}
// 'metric' | 'us'. 'auto' asks the Mac; the US, Liberia and Myanmar are the non-metric holdouts.
function unitSystem() {
  const u = load().units;
  if (u === 'metric' || u === 'us') return u;
  try {
    const t = require('child_process').execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleTemperatureUnit'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (t === 'Fahrenheit') return 'us';
    if (t === 'Celsius') return 'metric';
  } catch (e) {}
  return ['US', 'LR', 'MM'].includes(country()) ? 'us' : 'metric';
}

// ---------------- the prompt fragment ----------------
// Deliberately short. Every line here costs context on EVERY turn, so only things that change
// behaviour earn a place — nothing biographical, which belongs in retrieval.
// forReasoning: only the settings that shape how an answer is EXPLAINED (address, language, candour, level,
// pronouns). The ones about ACTING — contacts and nicknames, when to ask before acting, reply length, briefings,
// his hours — are left out: on 2026-09-26 Bonsai 8B read the "a" and "b" of a logic puzzle as unknown contacts
// ("no known contacts listed, I can't proceed"), straight from the nickname rule below.
function promptLines(opts) {
  const forReasoning = !!(opts && opts.forReasoning);
  const p = load();
  const out = [];
  const pr = pronouns();
  const nm = userName();

  if (p.address === 'mix') {
    out.push('Address ' + pr.obj + ' naturally and vary it — "Sir", "Boss"' + (nm ? ', or ' + pr.poss + ' name (' + nm + ')' : '') + '. Do not end every line the same way.');
  } else if (p.address === 'sir') out.push('Address ' + pr.obj + ' as "Sir".');
  else if (p.address === 'maam') out.push('Address ' + pr.obj + ' as "Ma\'am".');
  else if (p.address === 'boss') out.push('Address ' + pr.obj + ' as "Boss".');
  else if (p.address === 'name' && nm) out.push('Address ' + pr.obj + ' as ' + nm + '.');
  else out.push('Do not use honorifics such as Sir or Ma\'am' + (nm ? '; you may use ' + pr.poss + ' name, ' + nm : '') + '.');

  if (forReasoning) {
    // skip manner/length/acting rules — see the note at the top of this function
  } else if (p.manner === 'ironman') {
    out.push('Manner: the JARVIS of the films — dry, quick, a side-comment or light bit of banter when it fits. ' +
      'Never at the cost of the answer, and never when ' + pr.subj + (pr.subj === 'they' ? ' are' : ' is') + ' in a hurry or something failed.');
  } else if (p.manner === 'dry') out.push('Manner: butler-crisp, dry, an understated line only rarely.');
  else if (p.manner === 'plain') out.push('Manner: strictly functional, no flourishes.');
  // A SETTING THE PANEL OFFERS AND THIS FILE DOES NOT IMPLEMENT IS A LIE TOLD TO THE PERSON USING IT.
  // "warm" was on the menu and had no branch here, so picking it saved cleanly, showed as selected,
  // and changed nothing about how JARVIS spoke. Same for replyStyle "short" below. Both implemented
  // rather than removed, because they are reasonable things to want.
  else if (p.manner === 'warm') out.push('Manner: warm and personable — a friendly word before the answer, never gushing.');

  if (forReasoning) {
    // the reasoning instruction sets the length
  } else if (p.replyStyle === 'adaptive') {
    out.push('Length: one line for actions that worked ("Opened YouTube"). Fuller for questions, ' +
      'judgement calls and anything that failed — there, say briefly WHY.');
  } else if (p.replyStyle === 'terse') out.push('Length: one or two lines. Result only.');
  else if (p.replyStyle === 'short') out.push('Length: keep it to a couple of sentences at most.');
  else if (p.replyStyle === 'full') out.push('Length: show your reasoning.');

  if (forReasoning) {
    // nothing is acted on in a worked answer
  } else if (p.uncertainty === 'read-act-write-ask') {
    out.push('When unsure: go ahead for anything reversible (reading, checking, looking up); ask first for ' +
      'anything that changes state, sends, or leaves the machine.');
  } else if (p.uncertainty === 'ask-first') {
    out.push('When unsure: ask before doing anything at all, including reads.');
  } else if (p.uncertainty === 'act') {
    out.push('When unsure: act on your best reading rather than asking — but never for anything that ' +
      'spends money, sends a message, or deletes.');
  }
  // DECLARED, OFFERED, AND READ BY NOTHING until now. Both sat in the panel as controls that saved a
  // value no code ever consulted.
  //
  // ONLY THE NON-DEFAULT VALUE EARNS A LINE. This fragment is rebuilt into EVERY turn's prompt, and
  // the first cut of these spent 263 characters per turn restating behaviour that was already the
  // baseline — worst case went from 1150 to 1526 against a 1200 budget this file's own note calls
  // tight. A setting left at its default needs to say nothing; a setting moved off it has to.
  if (!forReasoning && p.contactAmbiguity === 'best-guess') {
    out.push('If a name matches several contacts, pick the likeliest and say who — but still ask before sending.');
  }
  // pagePrivacy gets NO line, and is no longer offered as a control. It was never a preference: the
  // signed-in-page guarantee is enforced at server.js's page-read lane, where forceLocal is set from
  // whether the PAGE is private (r.data.private) and never from this field. Choosing "any" would have
  // been refused by the code, so the panel was offering a switch that does not move. It is shown as a
  // read-only fact now. Stating it in the prompt as well would only spend characters restating what
  // the code already enforces.
  const is = pr.subj === 'they' ? 'are' : 'is';
  const Subj = pr.subj[0].toUpperCase() + pr.subj.slice(1);
  if (!forReasoning && p.rhythm === 'irregular') {
    out.push(pr.poss[0].toUpperCase() + pr.poss.slice(1) + ' hours vary daily — never assume a timetable. Judge whether ' + pr.subj + ' ' + is + ' around from recent activity, not the clock.');
  }
  if (p.language === 'en-understand-hi') {
    out.push(Subj + ' ' + (pr.subj === 'they' ? 'mix' : 'mixes') + ' Hindi/Punjabi and Hinglish into ' + pr.poss + ' requests. Understand them, but always ANSWER in English.');
  }
  if (p.pronouns && p.pronouns !== 'they/them') {
    out.push('Use ' + p.pronouns + ' when writing about ' + pr.obj + ' to anyone else.');
  }
  if (forReasoning) {
    // contacts have nothing to do with a worked answer — and named letters in a puzzle are not people
  } else if (p.nicknameStrategy === 'learn') {
    // The behaviour picked over handing over a nickname map: it earns the map by asking.
    out.push('You do not have a nickname→contact map. On an unfamiliar name, ask WHICH contact ' + pr.subj + ' ' + (pr.subj === 'they' ? 'mean' : 'means') + ', ' +
      'then remember ' + pr.poss + ' answer so you never ask about that name again. Never guess a recipient.');
  } else if (p.nicknameStrategy === 'ask') {
    out.push('Ask which contact an unfamiliar name means every time; do not store the answer.');
  } else if (p.nicknameStrategy === 'never') {
    out.push('Use exact contact matches only — on an unfamiliar name say you do not have it.');
  }
  // The briefing preference was displayed by profile_show and consulted by nothing, so all three of
  // its values behaved identically. Only the two that deviate from the default are stated; see the
  // note on per-turn cost above.
  if (forReasoning) {} else if (p.briefing === 'always') out.push('Open with a short briefing every time, even if little to report.');
  else if (p.briefing === 'never') out.push('Never open with a briefing.');
  if (p.candid) out.push(Subj + ' asked to never be sugar-coated: give the full story and push back on ' + pr.poss + ' reasoning where it is weak.');
  // EXPLANATION LEVEL. Asked what class he is in, he answered with a behaviour instead: pitch at
  // 9th-10th grade, change level on request. That governs every explanation he gets, so it earns one
  // of the very few slots here — kept to a single short sentence because the whole fragment has to
  // stay under 1200 chars and had barely 50 to spare.
  //
  // The address rule he gave in the same round is NOT here: it only matters while ordering, so it
  // lives in the procedures that actually handle an address (playbook.js) and costs nothing on the
  // turns that do not.
  if (p.explainLevel) out.push('Explain at ' + String(p.explainLevel).slice(0, 40) + ' unless asked otherwise.');
  return out;
}

// ---------------- facts go to retrieval, not the prompt ----------------
// Long-tail biography (people, timetable, projects) is written as episodes so the existing tf-idf
// surfaces only the relevant part. A hundred facts cost nothing until one is actually needed.
function rememberFact(topic, text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, say: 'Nothing to record, Sir.' };
  if (!deps.recall) return { ok: false, say: 'Memory is not wired up, Sir.' };
  deps.recall.log('profile', 'About ' + userLabel() + ' — ' + topic + ': ' + t, { profile: topic });
  // Write through rather than leaving it in recall's debounce buffer. A profile fact is stated once
  // and expected to stick; the buffered save cost nine of them when the writing process exited
  // before the timer fired, and JARVIS then denied knowing things it had been told minutes earlier.
  try { deps.recall.flush(); } catch (e) {}
  deps.audit('profile_fact', { topic: String(topic).slice(0, 40) }, 'ok');
  return { ok: true, say: 'Noted, Sir.' };
}

const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});

function profile_show() {
  const p = load();
  return ok('What I hold about you, Sir:\n' +
    '· Address: ' + p.address + ' · manner: ' + p.manner + ' · replies: ' + p.replyStyle + '\n' +
    '· Hours: ' + p.rhythm + ' · briefing: ' + p.briefing + '\n' +
    '· Logged-in pages: ' + (p.pagePrivacy === 'local-only' ? 'readable, offline model only' : p.pagePrivacy) + '\n' +
    '· While away: ' + p.awayAllowed.join(', ') + '\n' +
    '· Study topics: ' + p.studyTopics.join(', ') + '\n' +
    'Anything biographical is in my episodic memory — ask and I will recall it.');
}

function profile_set(args) {
  const key = String(args.key || '').trim();
  if (!(key in DEFAULTS)) return { ok: false, say: 'I do not keep a “' + key + '”, Sir.' };
  save({ [key]: args.value });
  return ok('Updated, Sir — ' + key + ' is now ' + JSON.stringify(args.value) + '.');
}

// Surfacing only — JARVIS shows the numbers, it never dials or messages them by itself. An assistant
// that contacts family on its own judgement is a category of mistake with no undo, and he gave these
// so that HE can reach them faster, not so that JARVIS can.
function emergency_contacts() {
  const p = load();
  if (!p.emergency.length) return { ok: false, say: 'You have not given me any emergency numbers, Sir.' };
  const lines = p.emergency.map(e => '· ' + (e.label ? e.label + ' — ' : '') + e.number);
  return ok('Emergency contacts, Sir:\n' + lines.join('\n') +
    '\nI will not call or message any of them myself — that is yours to do.');
}

// Computed, not reasoned about. The local 3B inverted the direction of the home↔family timezone offset
// in every wording tried — "late evening in India is a good time to call" came back as its exact
// opposite. Whether it is the middle of the night for his mother is not a thing to be approximately
// right about, so the arithmetic is done here and handed over as a finished sentence.
function family_time() {
  const p = load();
  if (!p.familyZone) return { ok: false, say: 'I do not know where your family lives yet, Sir — set it in Settings (family time zone).' };
  const zone = p.familyZone;
  const now = new Date();
  const fmt = tz => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: true,
  }).format(now);
  const hourThere = Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hour12: false }).format(now));
  // Three-way rather than a blunt asleep/awake split: 7am is not "almost certainly asleep", and
  // overstating it is the sort of small confident wrongness that makes him stop trusting the answer.
  const verdict = (hourThere >= 23 || hourThere < 7) ? 'They are almost certainly asleep — I would not call now.'
    : (hourThere < 9 || hourThere >= 22) ? 'Early there, but not unreasonable — your call.'
    : 'A reasonable hour to reach them.';
  // Who they are and where, read from the vaulted profile rather than written into source — a
  // hardcoded relationship and place is family detail sitting in a repo, and it is simply wrong
  // for anyone whose family lives somewhere else.
  const who   = p.familyLabel || 'your family';
  const place = p.familyPlace || zone.split('/').pop().replace(/_/g, ' ');
  return ok('It is ' + fmt(zone) + ' where ' + who + ' are (' + place + '), ' +
    'and ' + fmt(timeZone()) + ' here. ' + verdict);
}

// ---------------- "who am I" ----------------
// THE FACTS ARE THERE; THE QUESTION CANNOT REACH THEM. Retrieval is tf-idf over the words in the
// query, and "who am I" / "tell me about myself" contain no rare word to match on — every token is a
// stopword. So passive recall returned nothing and the model did what a small model does with a
// question it cannot answer: it apologised and asked Atharv to introduce himself, with a full
// biography sitting in the store. Measured, not assumed: "who is Parth" retrieves fine, "who am I"
// returns null.
//
// Same remedy as family_time — answer it from the store, deterministically, before a model sees it.
const BIO_ORDER = ['Who he is', 'Household', 'Hobbies', 'Goals'];

// Profile facts carry instructions to JARVIS as well as biography — "Weather and travel answers
// should resolve there at city level", "Use this when suggesting music". Read back verbatim, the
// answer to "who am I" told Atharv how his own weather lookups are routed. Sentences aimed at JARVIS
// are dropped; only the ones describing him survive.
const DIRECTIVE_RE = /^\s*(?:use|do not|don'?t|never|always|avoid|order|prefer|those are|that is what|answers?\b|weather\b)/i;
function biographyOnly(text) {
  return String(text || '')
    .split(/(?<=\.)\s+/)
    .filter(s => s.trim() && !DIRECTIVE_RE.test(s))
    .join(' ')
    .trim();
}

function profileFacts() {
  if (!deps.recall || !deps.recall.recent) return [];
  return deps.recall.recent(0)
    .filter(e => e.kind === 'profile')
    .map(e => ({
      topic: (e.meta && e.meta.profile) || '',
      // JARVIS's own record format, "About <name> — <topic>: …" (any name, including older records).
      text: String(e.text || '').replace(/^About [^—]{1,60} — [^:]*:\s*/, '').trim(),
    }))
    .filter(f => f.text);
}

function who_am_i(args) {
  const facts = profileFacts();
  if (!facts.length) return { ok: false, say: 'I have nothing on file about you yet, Sir.' };

  // "what do you know about me" wants the lot; "who am I" wants the short version.
  if (args && (args.full || args.all)) {
    const seen = new Set();
    const lines = facts.filter(f => { const k = f.topic + '|' + f.text; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(f => '· ' + (f.topic ? f.topic + ' — ' : '') + f.text);
    return ok('Everything I hold on you, Sir:\n' + lines.join('\n'));
  }

  const pick = [];
  for (const t of BIO_ORDER) {
    const f = facts.find(x => x.topic === t);
    const bio = f && biographyOnly(f.text);
    if (bio && !pick.includes(bio)) pick.push(bio);
  }
  if (!pick.length) pick.push(biographyOnly(facts[0].text) || facts[0].text);
  return ok((userName() ? 'You are ' + userName() + ', Sir. ' : '') + pick.join(' ') +
    '\n\nAsk me what I know about you if you want the full list.');
}

const TOOLS = { profile_show, profile_set, emergency_contacts, family_time, who_am_i };
const TOOL_HELP = {
  profile_show: 'profile_show{}. What JARVIS holds about the user and how they want to be dealt with.',
  profile_set: 'profile_set{key,value}. Change one stored preference.',
  emergency_contacts: 'emergency_contacts{}. Show the user\'s emergency numbers. Display only — never dial or message them.',
  family_time: 'family_time{}. The current time where the user\'s family lives vs here, and whether it is a reasonable hour to contact them. ALWAYS use this instead of working out the offset yourself.',
  who_am_i: 'who_am_i{full?}. Who the user is, assembled from their stored profile. Use for "who am I", "tell me about myself"; pass full:true for "what do you know about me". Never answer these from your own guess.',
};

module.exports = { init, get, save, promptLines, rememberFact, TOOLS, TOOL_HELP, DEFAULTS,
  userName, userRef, userLabel, pronouns, honorific, honorify, systemLocale, country, timeZone, unitSystem };
