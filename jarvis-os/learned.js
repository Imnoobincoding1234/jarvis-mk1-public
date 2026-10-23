'use strict';
// ---------------------------------------------------------------------------
// JARVIS learned procedures — the other half of lessons.js.
//
// lessons.js remembers what FAILED, so a mistake is not repeated. Nothing remembered what WORKED.
// A novel goal the loop solved today was solved from scratch tomorrow: same ten steps, same model
// calls, same chance of arriving somewhere different. The hand-written PLAYBOOKS in playbook.js are
// curated and never grow on their own, so the system got better at avoiding failure and no better
// at repeating success.
//
// PROVISIONAL BY DEFAULT, and that is the whole design. A single success proves very little here —
// file-multi once passed in 50.9s by luck and failed the next two runs, and a lucky sequence baked
// in as a procedure is worse than no procedure at all, because it repeats a wrong method with
// confidence. So a freshly learned procedure is a HYPOTHESIS: it is offered to the loop as a
// suggestion rather than replayed blindly, its outcome is recorded every time, and it is:
//
//   · promoted to `trusted` after CONFIRMS successes (it has now worked more than once), and
//   · demoted, then forgotten, once failures outnumber successes.
//
// That ordering matters. `playbook.match()` consults the curated playbooks FIRST; a learned
// procedure never outranks one a human wrote, it only fills the space where there was nothing.
//
// WHAT IS STORED IS THE SHAPE, NOT THE ANSWER. Steps keep tool names and argument KEYS, with values
// preserved only where they are structural (a URL, an app name) and dropped where they are the
// specific thing asked for this time (a search query, a track title). Storing "play judas by lady
// gaga" as a procedure for "play music" would replay one song forever.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const store = require('./store.js');

// Declared BEFORE init, which assigns it. This project has been bitten twice by a `let` referenced
// from a function defined above it: node --check passes, the server boots, and it dies on the first
// request that reaches the line.
let FILE = path.join(__dirname, 'state', 'learned.json');
let cache = null;

let deps = { jlog: () => {}, audit: () => {} };
// `file` is a test seam and nothing else. Until it existed, the only way to exercise learn/failed/
// recall/replayable was against his real store — so the store half of this module was tested by
// reading it rather than by running it, which is how a one-strike bug in replayable() sat in a green
// suite. A test points this at a throwaway path; nothing in the running system passes it.
function init(d) {
  deps = Object.assign(deps, d || {});
  if (d && d.file) { FILE = d.file; cache = null; }
}
const MAX_PROCEDURES = 120;      // oldest, least-used are dropped first
const CONFIRMS = 2;              // successes needed before a hypothesis becomes trusted

// A DAMAGED STORE MUST NOT BE READ AS AN EMPTY ONE.
//
// This was two lines and both of them destroyed data. save() was a plain writeFileSync, so a crash
// or a power cut partway through left a truncated file; load() then caught the parse error and
// returned [], and the very next save() wrote that emptiness over what was left. Every procedure he
// had ever demonstrated, gone, with nothing in the log to say so. state/ still holds a
// learned.json.bak-corrupt-subscribe-* from the day it happened.
//
// An empty file IS empty — that is a first run, not damage. A file with bytes in it that will not
// parse is damage: it is moved aside under a name that says what it was, so the data is still there
// to recover, and the loss is announced instead of inferred months later.
// THROUGH store.js, WHICH IS THE ONE COPY OF THIS LOGIC.
//
// The atomic write and the damaged-file quarantine were written here first, then
// needed again by the episode journal — and two implementations of the same rule
// is the bug shape this codebase keeps producing (see the note on the food and
// compose vocabularies in this same file). store.js owns it now, and gets the
// migration runner as well, which this store had no way to do: a change to the
// procedure shape would previously have had to be absorbed by every reader or
// silently dropped.
function load() {
  if (cache) return cache;
  store.init({ jlog: deps.jlog, stateDir: path.dirname(FILE) });
  cache = store.read(path.basename(FILE), []);
  if (!Array.isArray(cache)) cache = [];
  return cache;
}
function save() {
  store.init({ jlog: deps.jlog, stateDir: path.dirname(FILE) });
  store.write(path.basename(FILE), cache || []);
}

// The KEY a goal is looked up by. Numbers, quoted strings and trailing specifics are stripped so
// "play bohemian rhapsody on spotify" and "play judas by lady gaga" collapse to the same shape —
// which is the point: the procedure is "how to play a song", not "how to play that song".
const VERB_FAMILY = {
  show: 'view', find: 'view', get: 'view', open: 'view', see: 'view', check: 'view',
  read: 'view', look: 'view', search: 'view', browse: 'view', list: 'view',
  play: 'play', start: 'play', resume: 'play', listen: 'play', watch: 'play',
  order: 'order', buy: 'order', purchase: 'order', reorder: 'order',
  post: 'post', share: 'post', upload: 'post', publish: 'post', send: 'post',
  add: 'add', create: 'add', make: 'add', new: 'add',
  delete: 'remove', remove: 'remove', clear: 'remove', cancel: 'remove',
};
// The BUCKET NAMES, not the keys — view/play/order/post/add/remove. keyOf() collapses a taught verb
// into one of these when the table knows it, and leaves it alone when it does not, so membership here
// answers a question worth asking later: was the taught verb one of the ~30 words people swap freely,
// or a specific one with no synonym set behind it? Derived rather than written out, so it cannot
// disagree with the table above.
// THE SAME TABLE DOES TWO OPPOSITE JOBS, AND ONLY ONE OF THEM IS SAFE ALONE.
//
// keyOf uses it to WIDEN — collapsing eleven interchangeable verbs so a synonym finds the same
// procedure. That is what a learned store is for, and it is also what let unrelated jobs share a
// bucket, so the widening is only safe because learn() now asks the scorer before treating a bucket
// hit as identity.
//
// verbConflict uses it to NARROW — it is what stops "unsubscribe to Mythpat" matching a taught
// "subscribe to Mythpat". An embedder cannot be asked to do that job: negation is the one thing
// embeddings reliably get wrong, and subscribe/unsubscribe sit almost on top of each other.
const VERB_FAMILY_NAMES = new Set(Object.values(VERB_FAMILY));
const STOP = new Set(['the', 'a', 'an', 'my', 'me', 'please', 'jarvis', 'can', 'you', 'could', 'would', 'and', 'then']);
function keyOf(goal) {
  // THE KEY IS THE SHAPE OF THE REQUEST, NOT THE REQUEST.
  //
  // Keying on the whole sentence looked reasonable and was useless: "play bohemian rhapsody on
  // spotify" and "play judas by lady gaga" produced different keys, so a procedure learned from one
  // could never serve the other — which is every case worth learning. The song is the ARGUMENT; the
  // procedure is "how to play a song".
  //
  // So the key is the leading verb plus the platform, where the platform is whatever follows
  // on/from/in/at. That is grammar rather than a hardcoded list of sites, so a service nobody has
  // heard of yet still keys correctly the first time it is mentioned.
  const words = String(goal || '')
    .toLowerCase()
    .replace(/["'\u201c\u201d]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const raw = words.find(w => !STOP.has(w));
  if (!raw) return '';
  // ONE WORD PER INTENT. "find my latest repo on github" and "show me the newest project on github"
  // are the same procedure and were keying differently, which is the generalisation problem one
  // level down from the song title. A small synonym map is honest here: these are the verbs a person
  // actually opens a request with, and an unlisted verb simply keys as itself rather than guessing.
  //
  // THIS COLLAPSE WAS REMOVED AND PUT BACK, and the round trip is worth recording. It looked like
  // the cause of a real bug: eleven verbs become "view", so "open my youtube channel" and "search
  // Christopher A. Flowers" share a bucket, and a taught procedure kept absorbing unrelated requests
  // as phrasings. Removing it made every key distinct and immediately broke what the store is FOR —
  // "show me my youtube channel" stopped finding a procedure taught as "open my youtube channel",
  // which the suite caught within a minute.
  //
  // The collapse is not the bug. Using a COARSE BUCKET AS AN IDENTITY was. A bucket is the right
  // shape for "which entries might this be" and the wrong shape for "this IS that entry", and
  // learn() was treating a key hit as identity without ever asking the scorer. That guard now sits
  // in learn(), and with it the bucket can stay wide, which is what makes a synonym generalise.
  const verb = VERB_FAMILY[raw] || raw;
  let platform = null;
  for (let i = 0; i < words.length - 1; i++) {
    if (['on', 'from', 'in', 'at'].includes(words[i])) {
      const next = words.slice(i + 1).find(w => !STOP.has(w));
      if (next) { platform = next; break; }
    }
  }
  // A platform is no longer REQUIRED — see the note on matching below. The key is now a label used
  // for logging and for the store's own bookkeeping, not the thing a request is looked up by.
  return platform ? verb + ' ' + platform : verb;
}

// ---------------------------------------------------------------------------
// FINDING A PROCEDURE BY WHAT IT IS FOR, NOT BY REPEATING THE SENTENCE THAT TAUGHT IT.
//
// The key above WAS the retrieval mechanism, and it was two tokens: the leading verb and the word
// after "on". Measured against a real lesson taught as "subscribe to a channel on youtube", eight of
// twelve natural ways of asking for the same thing missed it:
//
//   HIT   subscribe to mrbeast on youtube        MISS  sub to mrbeast on youtube
//   HIT   can you subscribe to mrbeast on youtube MISS  hit subscribe on mrbeast
//   HIT   subscribe me to mrbeast on youtube     MISS  subscribe to mrbeast          (empty key!)
//                                                MISS  subscribe to the mrbeast channel
//                                                MISS  youtube: subscribe to mrbeast
//                                                MISS  follow mrbeast on youtube
//                                                MISS  go to mrbeast on youtube and subscribe
//                                                MISS  please subscribe to mrbeast on yt
//
// Three returned an EMPTY key, which switched the whole system off: say it without "on <platform>"
// and nothing could be learned or recalled at all. And `yt` missed `youtube` even though
// siteKey('yt') === 'youtube' is asserted in this project's own test suite — the store never asked
// the site registry sitting next to it.
//
// That is a lookup table with a synonym map bolted on. What follows is scoring instead:
//
//   · every content word counts, not just the leading verb, so word order and filler stop mattering;
//   · the PLATFORM comes from the procedure's own stored steps (the host it navigates to), so the
//     request no longer has to name it, and `yt`/`youtube` are resolved through the site registry;
//   · a prefix match carries most of the weight of an exact one, so `sub` finds `subscribe` without
//     anybody writing `sub` down anywhere;
//   · and every phrasing he CONFIRMS joins the procedure's vocabulary, so the thing gets better at
//     being addressed the more it is addressed. That is the part that makes it learning.
//
// Two guards keep looseness from becoming recklessness. The ACTION has to match — agreeing about the
// site is not agreeing about the job, or "unsubscribe on youtube" would replay the subscribe lesson.
// And a negation is treated as an opposite, not a near-miss: un-/de- prefixes disqualify outright.
// ---------------------------------------------------------------------------
const NOISE = new Set(['the', 'a', 'an', 'my', 'me', 'please', 'jarvis', 'can', 'you', 'could', 'would',
  'and', 'then', 'to', 'on', 'from', 'in', 'at', 'for', 'of', 'it', 'that', 'this', 'some', 'go',
  'with', 'into', 'onto', 'is', 'be', 'do', 'does', 'just', 'now', 'up', 'over', 'again']);
function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter(w => w && !NOISE.has(w))
    // Crude singular. Enough to make "channels" and "channel" the same word without a stemmer.
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) ? w.slice(0, -1) : w);
}
// The site a stored procedure is ABOUT, read off the pages it actually navigates to. Taking it from
// the steps rather than the sentence is what lets "subscribe to mrbeast" — no platform named — still
// find the YouTube lesson.
function platformOf(entry) {
  for (const st of (entry && entry.steps) || []) {
    const u = st && st.args && st.args.url;
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) continue;
    try {
      const host = new URL(u).hostname.replace(/^(?:www|m|open|web)\./i, '');
      const label = host.split('.')[0];
      if (label && label.length > 1) return label.toLowerCase();
    } catch (e) {}
  }
  return null;
}
// yt → youtube, via the registry the open/search path already uses, so the two can never disagree
// about what a site is. Falls back to the raw token when server.js has not injected it (tests).
function canonSite(tok) {
  try { return (deps.siteKey && deps.siteKey(tok)) || tok; } catch (e) { return tok; }
}
// IS THIS TOKEN A REGISTERED SITE AT ALL? canonSite cannot answer that, because it
// falls back to the raw token — so a canonical name is indistinguishable from a word
// nobody has heard of. That ambiguity silently disabled the platform-clash guard for
// every literal site name; see the note at its call site.
function knownSite(tok) {
  try { return (deps.siteKey && deps.siteKey(tok)) || null; } catch (e) { return null; }
}
// The words a procedure answers to: what it is FOR, the sentence that taught it, and every phrasing
// that has since been confirmed to mean it.
function vocabOf(entry) {
  // THE EXAMPLE HE TAUGHT WITH IS NOT PART OF WHAT THE LESSON IS ABOUT.
  //
  // The goal line is usually a concrete instance — "follow lady gaga on spotify" — so folding it into
  // the vocabulary let the ARTIST become a matching word. "play judas by lady gaga on spotify" then
  // matched the follow-an-artist lesson on the strength of "lady", a word that is in there only
  // because of who he happened to demonstrate with. The specific was already being slotted out of the
  // STEPS for exactly this reason; it has to come out of the words too.
  //
  // So a procedure that takes an argument is described by its DESCRIPTION — what he said the job is —
  // plus any phrasing he has since confirmed. One with no argument keeps its goal, because there is
  // no specific in it to leak.
  const takesArgument = JSON.stringify(entry.steps || []).includes(SLOT);
  const sources = (takesArgument && entry.description)
    ? [entry.description].concat(entry.phrasings || [])
    : [entry.description, entry.goal].concat(entry.phrasings || []);
  const v = new Set();
  for (const src of sources) for (const t of tokens(src)) v.add(t);
  // NOT the key. Adding it looked principled — keyOf() has already stripped the specific, so there is
  // nothing to leak — and it broke the eval: the key's bare VERB entered at full strength, so "follow
  // the more information link on example.com" scored action 1.00 and exactly 2.00 against the lesson
  // for following an artist on SPOTIFY, replayed it against example.com, and filled the click slot
  // with "more information link". A verb the two requests happen to share is not agreement about the
  // job. The inflection problem it was meant to solve is fixed in wordScore instead, where it stays
  // worth 0.7 like every other near miss rather than a full match.
  return v;
}
const NEGATED = (a, b) => a === 'un' + b || a === 'de' + b || b === 'un' + a || b === 'de' + a;
// THE SAME NEGATION, SAID IN WORDS INSTEAD OF IN A PREFIX.
//
// NEGATED above catches "unfollow" and "unsubscribe" because the reversal is glued to the verb. Say
// the identical thing with a separate word and nothing saw it, so these all replayed the POSITIVE
// procedure against his real accounts — measured, not supposed:
//
//   no longer follow imagine dragons on spotify   -> SURE 3.00, clicks Follow
//   never subscribe to that channel again         -> SURE 3.00, clicks Subscribe
//   undo the subscribe on mkbhd youtube           -> SURE 3.00, clicks Subscribe
//   remind me to subscribe to mkbhd later         -> SURE 3.00, clicks Subscribe NOW
//
// Two closed classes, and they are closed in a way a verb list never is: English has a fixed handful
// of negators and a fixed handful of deferral markers, and no amount of new vocabulary adds to them.
// That is why this is a set and the verbs are not.
//
// POSITION SEPARATES THEM, AND IT HAS TO — the first cut ignored it for deferral and immediately cost
// two real requests: "follow Tomorrow X Together on spotify" and "subscribe to Later with Jools
// Holland on youtube" are a K-pop group and a BBC show, and both were demoted for containing a word
// that happened to be in the set.
//
// A negator only negates what FOLLOWS it, so it is looked for before the verb — which is what keeps
// "subscribe to No Copyright Sounds" and "follow Never Shout Never" working, where the word is part
// of a name and sits after the verb. Deferral either opens the clause ("remind me to…", "tomorrow,
// subscribe to…") or closes it ("subscribe to it later") — it never sits in the middle of the object,
// which is exactly where both band names put it.
//
// server.js has NEGATED_COMMAND_RE for the same idea in the action lane, deliberately NOT reused: it
// is keyed to a fixed list of sixteen verbs and cannot see a verb somebody taught this morning. This
// one takes the taught verb as its argument, which is the whole difference.
const REVERSAL = new Set([
  'not', 'never', 'no', 'none', 'stop', 'undo', 'reverse', 'avoid', 'instead', 'rather', 'without',
  // Apostrophes are stripped before tokenising, so "don't" arrives as "don" + "t".
  'don', 'doesn', 'didn', 'won', 'shouldn', 'wouldn', 'couldn', 'dont', 'cant',
  'nahi', 'nahin', 'mat',
]);
const DEFERRAL = new Set(['later', 'tomorrow', 'remind', 'sometime', 'eventually', 'baad', 'abhi']);
function reversedOrDeferred(goalTokens, verb) {
  if (!goalTokens.length) return false;
  const at = goalTokens.findIndex(t => verbLike(t, verb));
  if (at >= 0 && DEFERRAL.has(goalTokens[goalTokens.length - 1])) return true;   // "…on youtube later"
  // No verb named at all — nothing for a negator to point at, so the whole sentence is fair game.
  const before = at < 0 ? goalTokens : goalTokens.slice(0, at);
  return before.some(t => REVERSAL.has(t) || DEFERRAL.has(t));
}
// Two words that share a long stem but neither of which is a prefix of the other. "subscribe" and
// "subscribing" split at subscrib|e / subscrib|ing, so the startsWith test below scores them ZERO
// while it happily scores "sub" at 0.7 — the rule paid him for saying LESS. He taught a lesson as
// "subscribe to <name> on youtube", described it as "subscribing to a youtube channel", and then the
// exact sentence he had demonstrated with came back "I have not done this before".
//
// Five characters, not four: "chan" would join `channel` to `change`, and "play" would join
// `playlist` to `playing`. At five the shortest thing this admits is a real shared stem.
const STEM_MIN = 5;
function sharedPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function wordScore(t, vocab) {
  if (vocab.has(t)) return 1;
  let best = 0;
  for (const v of vocab) {
    if (NEGATED(t, v)) return -1;                       // opposite, not a near miss
    if (v.length >= 4 && t.length >= 3 && (v.startsWith(t) || t.startsWith(v))) best = Math.max(best, 0.7);
    // A shared stem is the same KIND of evidence as a prefix — a near miss, never a full match, so it
    // can lift a request over the line only when the site agrees too.
    else if (sharedPrefix(t, v) >= STEM_MIN) best = Math.max(best, 0.7);
  }
  return best;
}
// Returns { entry, score, action, platform } — `action` is how well the JOB matched, which is the
// half that must never be carried by the site alone.
function scoreEntry(goalTokens, entry) {
  const vocab = vocabOf(entry);
  const plat = platformOf(entry);
  if (plat) vocab.delete(plat);                          // the site is scored separately, not as an action word
  // WHAT THE JOB IS ABOUT, AS OPPOSED TO WHAT IS DONE TO IT.
  //
  // A request can also be too SMALL. "open youtube" matched a three-step lesson for opening his
  // channel — the verb agreed, the site agreed, and the word that makes it that particular job,
  // `channel`, was simply absent. Nothing required it, so a bare "open youtube" replayed a procedure
  // that clicks through to his channel page.
  //
  // The leading word of the description is the verb, which people vary freely; everything after it is
  // what the job is ABOUT, and at least one of those has to be present. Procedures that take an
  // argument are exempt, because for them the object IS the argument — "follow an artist on spotify"
  // can never expect to see the word "artist" in a request naming a real one.
  // Identified by position in the REQUEST, not by guessing which stored word is the verb — his own
  // description begins "whenever you have to…", so the leading word there is not a verb at all and
  // that assumption let "open youtube" straight back through.
  let subHit = false;
  let action = 0, extra = 0, platformSeen = false, platformClash = false, unknown = 0;
  for (let n = 0; n < goalTokens.length; n++) {
    const t = goalTokens[n];
    const canon = canonSite(t);
    if (plat && (t === plat || canon === plat)) { platformSeen = true; continue; }
    const s = wordScore(t, vocab);
    if (s < 0) return null;                              // negation — this is the opposite procedure
    // Beyond the verb and beyond the site: the request has to say what the job is ABOUT. Identified
    // with VERB_FAMILY, the map of request-opening verbs that already lives in this file — position
    // does not work, because "go to my channel on yt" loses "go to" as noise and leads with the
    // object, while "open youtube" leads with the verb.
    if (!subHit && s > 0 && !VERB_FAMILY[t]) subHit = true;
    if (s > action) { extra += action; action = s; } else extra += s;
    // WORDS THE PROCEDURE CANNOT ACCOUNT FOR ARE EVIDENCE AGAINST IT.
    //
    // They used to be free: they did not add, and nothing subtracted, so "open my youtube account
    // settings" scored 3.00 against a lesson about opening his CHANNEL — identical to "show me my
    // youtube channel" — on the strength of "open" and "youtube" alone. `account` and `settings`,
    // the two words that make it a different job, counted for nothing and it replayed silently.
    //
    // The leading word is exempt because the VERB is the part a person varies freely — show, open,
    // pull up — and penalising it would punish the paraphrases this scorer exists to catch.
    if (s <= 0 && n > 0) unknown++;
    // A token that names a DIFFERENT known site is a clash: "star it on github" must not reach a
    // youtube procedure just because it shares the word "star".
    //
    // THIS GUARD WAS DEAD FOR EVERY CANONICAL SITE NAME — the exact case its own example names.
    // It tested `canon !== t`, meaning "canonSite changed this token", as a proxy for "this token is
    // a site". But canonSite returns the token unchanged when the token IS already the canonical key,
    // so only ALIASES ever satisfied it: "gh" clashed, "github" did not. Measured with the real
    // registry wired in exactly as server.js does: siteKey('github') === 'github', and
    // "star the mrbeast channel on github" scored SURE 2.00 against `subscribe youtube` — one
    // confirmation away from subscribing him to whatever YouTube returns for "mrbeast".
    // Asking the registry whether the token is a site at all is the question that was meant.
    const site = knownSite(t);
    if (plat && site && site !== plat) platformClash = true;
  }
  if (platformClash) return null;
  // A PROCEDURE THAT TAKES AN ARGUMENT IS SUPPOSED TO MEET WORDS IT DOES NOT KNOW.
  //
  // "follow imagine dragons on spotify" cannot possibly explain "imagine dragons" — that is the slot
  // being filled, and charging it as unexplained would break the case this whole mechanism is for.
  // A procedure with no slot takes no argument, so every word of the request ought to be accounted
  // for, and the ones that are not are the request being about something else.
  const takesArgument = JSON.stringify(entry.steps || []).includes(SLOT);
  // Too small a request is as wrong as too large a one: without this, "open youtube" replays a
  // three-step walk to his channel page.
  if (!takesArgument && !subHit) return null;
  let score = action * 2 + (platformSeen ? 1 : 0) + Math.min(extra, 1) * 0.5 -
              (takesArgument ? 0 : unknown * 1.5);
  // A PROCEDURE THAT LIVES ON A SITE MAY NOT ACT UNTIL THE REQUEST NAMES THAT SITE.
  //
  // `platformSeen` was a BONUS (+1) and nothing more, so a request that never mentions the site
  // could still clear the bar on the strength of one shared verb: action*2 = 2.00, exactly SURE.
  // Measured against his real store — "switch to the general channel" and "mute the general channel
  // on slack" both scored precisely 2.00 with platformSeen=false against `subscribe youtube`, and
  // both were replayable: open youtube.com, search "general", click the first result, press
  // Subscribe. Meanwhile the genuine "subscribe to mrbeast on youtube" scores 2.40 WITH the platform
  // seen and a LOWER action score — so requiring the platform costs the real case nothing and takes
  // the false ones out.
  //
  // Demoted to a question rather than refused: the request may still be the job, and this scorer's
  // whole contract is that a plausible-but-uncertain match is worth one question and never a silent
  // replay. Failing toward asking is the only safe direction when the terminal step is a Subscribe
  // on his own account.
  //
  // TWO SIGNALS, AT LEAST ONE MUST BE STRONG. Requiring the platform outright was too blunt and the
  // suite caught it: "subscribe to the mrbeast channel" names no site and is plainly the job, and
  // demoting it broke two passing tests. What separates it from "switch to the general channel" is
  // not the site — neither has one — it is that the first says the procedure's own verb and the
  // second says a different one. So the site is required only when the verb does not carry it.
  if (plat && !platformSeen && !verbNamedExactly(entry, goalTokens)) score = Math.min(score, SURE - 0.1);
  // And a procedure whose verb is a specific word may not act until the request opens with it.
  // Clamped here rather than gated in match() so the demotion is a real drop in SCORE — a procedure
  // that genuinely fits can then outrank it, instead of the wrong one holding the top slot and
  // turning into the question that gets asked.
  if (!namesTaughtVerb(entry, goalTokens, plat)) score = Math.min(score, SURE - 0.1);
  // Negation and deferral apply to EVERY procedure, not just the specifically-named ones: "don't open
  // my youtube channel" is as wrong to replay as "never subscribe to it again", and the harm only
  // differs by how much the last step commits.
  if (reversedOrDeferred(goalTokens, String(entry.key || '').split(' ')[0])) score = Math.min(score, SURE - 0.1);
  return { entry, score, action, platform: platformSeen, unknown };
}
const SURE = 2.0;      // act on it
const MAYBE = 1.0;     // plausible — worth one question, never a silent replay
// Every stored procedure, ranked. `sure` is the one to use; `maybe` is the best candidate that needs
// confirming before anything is replayed.
// A REQUEST THAT NAMES A DIFFERENT ACTION MUST NOT REPLAY THIS ONE.
//
// Nothing checked the verb, and the consequence was a wrong REPLAY rather than a wrong answer.
// Asked to "show me my own youtube channel", the store returned `subscribe youtube` as a SURE match
// and replayed all five steps — the last two are the clicks that subscribe. A request to LOOK at his
// channel would have subscribed him to one. It scored 3.000 there and 3.000 on "open my youtube
// channel" as well, which is the tell: the whole score came from "youtube channel" and the word
// "subscribe" was never asked for. scoreEntry already refuses the mirror image of this, requiring the
// SUBJECT so a bare "open youtube" cannot replay a channel lesson; this is that rule pointed at the verb.
//
// STATED AS A CONFLICT, NOT A REQUIREMENT — and the difference is the whole design. Requiring the
// verb to be PRESENT broke four working phrasings immediately: "my youtube channel" has no verb at
// all, "pull up my youtube channel" and "go to my channel on yt" lead with verbs no table knows, and
// "follow mrbeast on youtube" is a phrasing he CONFIRMED means subscribe — rephrase() recorded it,
// and a rule that overrides his own correction is worse than the bug. Absence of a verb is not
// evidence of anything. So the demotion needs positive evidence that the request names a DIFFERENT
// action: a verb the table actually knows, canonicalising to something else.
//
// Only VERB_FAMILY keys count as that evidence. They are the ~30 verbs people really open requests
// with, which is exactly where "show" against "subscribe" lives, and an unlisted word stays silent
// rather than guessing. And this can only ever DEMOTE a match to `maybe`, which asks instead of
// acting — the worst it can do is one extra question.
// Does the request actually say the thing this procedure DOES? Extracted so the scorer and the
// conflict check cannot drift apart about what counts as naming the verb — they used to each have
// their own opinion, and only one of them was consulted before acting.
// One token against one verb. Extracted because THREE rules now ask this question and
// they were each about to grow their own answer — the shape of bug this file keeps
// finding (see the note on the food and compose vocabularies).
function verbLike(t, verb) {
  if (!t || !verb) return false;
  if ((VERB_FAMILY[t] || t) === verb) return true;
  const p = sharedPrefix(t, verb);
  if (p >= 3 && (t.startsWith(verb) || verb.startsWith(t))) return true;
  return p >= 5;
}
function verbAgrees(entry, goalTokens) {
  const verb = String(entry.key || '').split(' ')[0];
  if (!verb) return false;
  return goalTokens.some(t => verbLike(t, verb));
}
// AGREEING WITH A FAMILY IS NOT NAMING THE VERB.
//
// keyOf() stores the taught verb ALREADY COLLAPSED to its family name — show,
// find, get, open, see, check, read, look, search, browse and list all become
// "view". So verbAgrees, which compares (VERB_FAMILY[t] || t) === verb, does not
// ask "did he say the taught verb"; it asks "did he say ANY of eleven verbs".
// That is fine for detecting a CONFLICT, where being generous is the safe
// direction, and useless as the thing that waives the platform requirement.
//
// Measured against his real store, entry {key:'view', goal:'open my youtube
// channel', steps: navigate → account menu → "view your channel"}:
//
//   check my channel        -> SURE 2.00, auto-replays
//   browse my channel       -> SURE 2.00, auto-replays
//   look at my channel      -> SURE 2.00, auto-replays
//   get my channel          -> SURE 2.00, auto-replays
//
// None names YouTube, and "channel" is a Slack channel, a TV channel or a
// Telegram channel at least as often. The TWO SIGNALS rule was doing nothing for
// any family-keyed procedure — and view/play/order/post/add/remove are all
// families, so it was doing nothing for most of them.
//
// So the WAIVER needs the verb itself, not its bucket: the same word, or a plain
// inflection of it. Conflict detection keeps the loose test.
function verbNamedExactly(entry, goalTokens) {
  const verb = String(entry.key || '').split(' ')[0];
  if (!verb) return false;
  return goalTokens.some(t => {
    if (t === verb) return true;
    const p = sharedPrefix(t, verb);
    return p >= 4 && (t.startsWith(verb) || verb.startsWith(t));
  });
}
function verbConflict(entry, goalTokens) {
  const verb = String(entry.key || '').split(' ')[0];
  if (!verb) return false;
  if (verbAgrees(entry, goalTokens)) return false;
  return goalTokens.some(t => VERB_FAMILY[t] && VERB_FAMILY[t] !== verb);
}

// THE VERB OF A REQUEST IS THE WORD IT OPENS WITH, NOT ANY WORD IT CONTAINS.
//
// A site name may come first — "youtube: subscribe to mkbhd" — and a site is not a verb, so those are
// stepped over. Politeness is already gone: NOISE eats please/can/you/jarvis/go before this sees it.
function leadVerb(goalTokens, plat) {
  for (const t of goalTokens) {
    if (plat && (t === plat || canonSite(t) === plat)) continue;
    if (knownSite(t)) continue;
    return t;
  }
  return null;
}
// A SPECIFIC VERB HAS TO BE SAID. A FAMILY BUCKET DOES NOT.
//
// Measured against his real store, and this is the whole of it: for the requests these procedures
// were TAUGHT with, the score is carried by the VERB — "subscribe" against "subscribing", a stem
// match worth 0.70. For the false ones it is carried by the OBJECT — "channel" against "channel", an
// exact match worth 1.00. The scorer paid MORE for naming what the job is ABOUT than for naming what
// the job IS, so the object outvoted the verb and eighteen ordinary sentences replayed a Subscribe or
// a Follow on his real accounts:
//
//   copy the link to my youtube channel        -> SURE 3.00, clicks Subscribe
//   block the mrbeast channel on youtube       -> SURE 3.00, clicks Subscribe   (the opposite)
//   stop following imagine dragons on spotify  -> SURE 3.00, clicks Follow      (also the opposite)
//   show my followed artists on spotify        -> SURE 3.35, clicks Follow
//
// against the genuine "subscribe to mkbhd on youtube" at 2.40. The false matches scored HIGHER than
// the real ones, which is the tell that the evidence was coming from the wrong half of the sentence.
//
// The obvious fix — stop letting the object carry `action` — is wrong, and the suite says so: for the
// `view` lesson NOTHING but the object carries it. "see my youtube channel" scores zero on "see",
// because the vocabulary holds "open", and it matches on "channel" alone. Eleven synonyms of view
// work exactly because the object is allowed to carry them. So the object carrying the match is a
// FEATURE, and only for some procedures.
//
// The line between them already exists in the data and did not have to be invented. keyOf() collapses
// a taught verb into its family when the table knows it, so a key verb of `view` means he opened with
// one of eleven interchangeable words and the next request may use any of them — or none. A key verb
// of `subscribe` or `follow` means the table had no family to collapse it into: there is no synonym
// set to be generous toward, and the generosity is pure cost. So the request must actually say it.
//
// Two ways to satisfy that, and the second is not optional. A phrasing he has CONFIRMED through
// rephrase() — "follow mrbeast on youtube" meaning subscribe — is his own correction, and a rule that
// overrides his correction is worse than the bug it fixes. That is recorded history, so it is
// consulted here rather than guessed at.
//
// Demotes to `maybe`, never refuses: the request may well be the job, and one question whose answer
// is remembered is the honest price. It cannot make a wrong replay; it can only make a wrong question.
//
// REQUIRING THE VERB TO LEAD IS TOO STRONG, and the suite said so immediately: "hit subscribe on
// mrbeast" and "go to mrbeast on youtube and subscribe" are both real phrasings it already
// recognised, and in neither does the verb come first. So the verb is wanted ANYWHERE — and the two
// ways a sentence can contain it without meaning it are ruled out directly instead.
//
// A PARTICIPLE IS NOT A COMMAND. "stop FOLLOWING imagine dragons", "export my FOLLOWED artists" —
// the -ing and -ed forms are modifying a noun or completing another verb, and the word that gives
// the order is elsewhere in the sentence. That is a rule about the shape of the word and where it
// sits, not a list of the verbs it happens to appear with, so "export", "stop" and every other verb
// nobody has thought of yet are covered by the same line. When the participle IS the leading word —
// "subscribing to mkbhd on youtube" — nothing else is giving an order and it stands.
const PARTICIPLE_RE = /(?:ed|ing)$/;
const isParticipleOf = (t, verb) => t !== verb && t.length > verb.length && PARTICIPLE_RE.test(t);
function namesTaughtVerb(entry, goalTokens, plat) {
  const verb = String(entry.key || '').split(' ')[0];
  if (!verb || VERB_FAMILY_NAMES.has(verb)) return true;   // a bucket — the synonyms are the point
  const lead = leadVerb(goalTokens, plat);
  if (!lead) return true;                                  // nothing but the site — not evidence of anything
  // He has confirmed a wording for this procedure before. If this request opens the same way that
  // wording does, it is the same request, whatever the taught verb was. Checked FIRST so nothing
  // below can overrule his own correction.
  for (const p of (entry.phrasings || [])) {
    const pl = leadVerb(tokens(p), plat);
    if (pl && verbLike(lead, pl)) return true;
  }
  const said = goalTokens.filter(t => verbLike(t, verb));
  if (!said.length) return false;                          // never says it — this is a different job
  // The word it opens with gives the order. If the table knows that word and it means something
  // else, the request is that other thing, whatever it mentions later.
  if (VERB_FAMILY[lead] && VERB_FAMILY[lead] !== verb) return false;
  if (said.every(t => t !== lead && isParticipleOf(t, verb))) return false;
  return true;
}

function match(goal) {
  const gt = tokens(goal);
  if (!gt.length) return { sure: null, maybe: null, ranked: [] };
  const ranked = load().map(e => scoreEntry(gt, e)).filter(Boolean)
                       .filter(r => r.entry.bad <= r.entry.ok)
                       .sort((a, b) => b.score - a.score);
  const top = ranked[0] || null;
  // The action must carry it. Agreeing about the site is not agreeing about the job.
  const sure = (top && top.action >= 0.7 && top.score >= SURE && !verbConflict(top.entry, gt)) ? top : null;
  const maybe = (!sure && top && top.score >= MAYBE) ? top : null;
  return { sure, maybe, ranked };
}
// Record that a phrasing means this procedure, so the next one like it is recognised outright.
// This is the compounding part: his correction becomes the store's vocabulary.
function rephrase(key, phrasing) {
  const hit = load().find(p => p.key === key);
  if (!hit || !phrasing) return null;
  hit.phrasings = (hit.phrasings || []).concat([String(phrasing)]).slice(-12);
  save();
  deps.jlog('Learned › "' + key + '" also answers to "' + String(phrasing).slice(0, 48) + '"');
  return hit;
}

// Values worth keeping are the ones that make the procedure work anywhere; values worth dropping are
// the ones that make it work only for the request that happened to teach it.
// `direction` and `description` are part of the METHOD — "scroll down", "the search box" — and a
// procedure that forgets them is not a procedure. `text` is deliberately absent: the words typed
// are what was asked for this time, and storing them would replay one search forever.
const STRUCTURAL = new Set(['url', 'site', 'app', 'name', 'target', 'kind', 'selector', 'path',
                            'direction', 'description']);
function shapeOf(steps) {
  return (steps || []).slice(0, 12).map(s => {
    const args = {};
    for (const k of Object.keys(s.args || {})) {
      // A SLOT IS STRUCTURAL BY DEFINITION. `text` is dropped because the words typed were this
      // request's answer — but once slotify has turned them into {target} they are no longer an
      // answer, they are the shape of one. Nulling it anyway is what made every taught SEARCH
      // unreplayable: a null argument is refused by replayable(), so the procedure was stored,
      // recognised, and then never able to run.
      const v = s.args[k];
      const isSlot = typeof v === 'string' && v.includes(SLOT);
      args[k] = (STRUCTURAL.has(k) || isSlot) ? v : null;   // null = "supply this from the request"
    }
    return { tool: s.tool, args };
  });
}

// THE SPECIFIC IN A URL IS AN ARGUMENT, NOT PART OF THE METHOD.
//
// A taught step stored "https://youtube.com/@Mythpat", so the procedure keyed as "subscribe youtube"
// replayed for exactly one channel forever. The handle is what was being asked about; going to the
// channel and pressing Subscribe is the method. Same distinction that already keeps the search TEXT
// out of a stored step, one level deeper.
//
// The test is simple and needs no knowledge of any particular site: a path segment the taught GOAL
// never mentioned is something supplied at the time, so it becomes a slot. "check trending on github"
// keeps /trending because he said the word; "subscribe to a channel on youtube" turns @Mythpat into
// {target} because he never did.
const SLOT = '{target}';
// WHAT HE TYPED INTO THE SEARCH BOX IS WHAT THE LESSON WAS ABOUT.
//
// The URL rule below could not see this at all, and a real lesson showed why. Teaching "follow an
// artist on spotify" by example stored:
//
//     step 2  browser_fill_described  { description: "search…", text: null }
//     step 4  browser_click_described { description: "click on Lady Gaga (Lady Gaga)" }
//
// Nothing about that varies. The search text was dropped entirely — so the procedure could not even
// be replayed, since a null argument is not replayable — and the artist was welded into step 4's
// description, so every future run would follow Lady Gaga whoever was asked for.
//
// The subject is not guessed: it is the text he TYPED. You type the specific thing you are looking
// for, by construction, so that string is the lesson's variable — and it is then replaced wherever
// else it appears, which is exactly how "click on Lady Gaga" becomes "click on {target}" while
// "click Follow" is left alone.
//
// Tested against the DESCRIPTION, not the goal, and that distinction is the whole of it. The goal is
// whatever sentence opened the lesson and is usually a concrete example — "follow lady gaga on
// spotify" — so checking it would conclude the artist was part of the method. The description is what
// he said the job IS, "following an artist on spotify", and a subject missing from that is a variable.
function subjectOf(steps, description, goal) {
  for (const st of steps || []) {
    const t = st && st.args && st.args.text;
    if (typeof t === 'string' && t.trim().length > 2) {
      const subj = t.trim();
      const said = new Set(String(description || goal || '').toLowerCase().match(/[a-z0-9]+/g) || []);
      const words = subj.toLowerCase().match(/[a-z0-9]+/g) || [];
      // He named it in the description, so he means this exact thing every time.
      if (words.length && words.every(w => said.has(w))) return null;
      return subj;
    }
  }
  return null;
}
function slotify(steps, goal, description) {
  const said = new Set(String(goal || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const subject = subjectOf(steps, description, goal);
  const subjRe = subject
    ? new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'ig')
    : null;
  return (steps || []).map(st => {
    const args = Object.assign({}, st.args || {});
    // The typed subject, replaced wherever it appears — the text itself, and any description that
    // names it. Done before the URL rule so a URL containing it is caught here too.
    if (subjRe) {
      for (const k of Object.keys(args)) {
        if (typeof args[k] === 'string') args[k] = args[k].replace(subjRe, SLOT);
      }
    }
    const u = args.url;
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
      try {
        const parsed = new URL(u);
        const segs = parsed.pathname.split('/').filter(Boolean);
        let changed = false;
        const out = segs.map(seg => {
          const bare = seg.replace(/^@/, '').toLowerCase();
          // Short or numeric segments are structure ("videos", "2", "r"), not somebody's name.
          if (bare.length < 3 || said.has(bare)) return seg;
          changed = true;
          return seg.startsWith('@') ? '@' + SLOT : SLOT;
        });
        if (changed) args.url = parsed.origin + '/' + out.join('/') + (parsed.search || '');
      } catch (e) {}
    }
    return { tool: st.tool, args };
  });
}

// THE OTHER HALF: putting the new request's specific back in.
//
// Grammar, not a list of sites. The target is what follows "to"/"for" and precedes "on <platform>",
// or simply the word before "on <platform>" — which covers "subscribe to yessmartypie on youtube"
// and "subscribe mrbeast on youtube" alike.
//
// Returns NULL when the request names no target. A template filled with last time's value would
// subscribe him to somebody else's channel and report success, which is worse than declining.
function targetOf(goal) {
  const words = String(goal || '').trim().split(/\s+/).filter(Boolean);
  const lower = words.map(w => w.toLowerCase().replace(/[^a-z0-9@._-]/g, ''));
  let end = lower.findIndex(w => ['on', 'from', 'in', 'at'].includes(w));
  if (end === -1) end = words.length;
  const to = lower.findIndex(w => w === 'to' || w === 'for');
  const start = (to !== -1 && to < end) ? to + 1 : 1;   // skip the verb when there is no "to"
  const cand = words.slice(start, end)
    .map(w => w.replace(/[^A-Za-z0-9@._-]/g, ''))
    .filter(w => w && !STOP.has(w.toLowerCase()) && w.toLowerCase() !== 'channel');
  if (!cand.length) return null;
  // SPACES ARE KEPT HERE and removed only where the slot demands it — see fillSlots.
  //
  // This used to join with nothing at all, because the only slot was a URL handle and
  // "scary pumpkin" has to become "scarypumpkin" to be one. The moment a slot could sit in typed
  // TEXT that was wrong in the other direction: searching Spotify for "imaginedragons" is not
  // searching for "imagine dragons". The name is the name; where it goes decides how it is spelled.
  return cand.join(' ').replace(/^@/, '');
}
function fillSlots(steps, goal) {
  const needs = (steps || []).some(st => JSON.stringify(st.args || {}).includes(SLOT));
  if (!needs) return steps;
  const t = targetOf(goal);
  if (!t) return null;
  // A URL segment cannot hold a space; a search box must. Same name, spelled for where it lands —
  // "imagine dragons" typed into Spotify's search, "@imaginedragons" in a channel URL.
  const tight = t.replace(/\s+/g, '');
  return steps.map(st => {
    const args = {};
    for (const k of Object.keys(st.args || {})) {
      const v = st.args[k];
      args[k] = typeof v === 'string' ? v.split(SLOT).join(k === 'url' ? tight : t) : v;
    }
    return { tool: st.tool, args };
  });
}

// Record a goal the loop actually solved. `verified` is the harness's own verdict, not the model's
// claim — an unverified success is not evidence of a procedure, it is evidence of an opinion.
function learn(goal, steps, opts) {
  opts = opts || {};
  let key = keyOf(goal);
  if (!key || !steps || !steps.length) return null;
  if (opts.verified === false) return null;             // never learn from an unproven run

  const all = load();
  // IDENTITY IS THE SAME QUESTION AS RETRIEVAL, so it is answered the same way. Matching on an exact
  // key meant re-teaching the same job in different words silently created a SECOND procedure, and
  // then the two competed. The exact key is still tried first — it is free and unambiguous — and the
  // scorer decides the rest.
  let hit = all.find(p => p.key === key);
  // A SHARED BUCKET IS NOT A SHARED JOB, AND THE COMMENT ABOVE CALLED THE EXACT KEY "UNAMBIGUOUS".
  //
  // It is not. keyOf() collapses the leading verb through VERB_FAMILY, and eleven verbs —
  // show, find, get, open, see, check, read, look, search, browse, list — all become "view". Any
  // view-family request that names no platform therefore lands in ONE bucket:
  //
  //     open my youtube channel        -> view
  //     search Christopher A. Flowers  -> view
  //     show me the weather            -> view
  //
  // Measured on his machine, three times in one day: a taught procedure for opening his own YouTube
  // channel absorbed "open his youtube channel" and then "search Christopher A. Flowers" as
  // phrasings, and its success counters went up for runs that had nothing to do with it. With three
  // procedures that is an odd entry in a JSON file. With a hundred, every open/search/show/find he
  // ever teaches piles into the same one and they overwrite each other's meaning.
  //
  // THE SCORER ALREADY KNOWS. match() answers "is this request that procedure", and asked about
  // "search Christopher A. Flowers" against that entry it returns 0.00 — retrieval was never fooled,
  // only the write path was, because it never asked. So the bucket proposes and the scorer disposes:
  // a keyed hit that the scorer does not recognise as this job is not this job, and the request gets
  // its own entry instead of contaminating one that already works.
  //
  // NARROWED TO TAUGHT ENTRIES, AND THE WIDER VERSION WAS MEASURED AND WITHDRAWN. Applied to every
  // entry it refused a merge the store depends on: "buy me a phone charger" then "buy me hiking
  // boots" is ONE procedure with a different argument, and the scorer rates it as low as the
  // poisoning case because in both the arguments are what differ. An embedder does not separate
  // them either — measured, same-job pairs at 0.132 and 0.336 against different-job pairs at 0.093,
  // and subscribe/unsubscribe scoring 0.830, the highest of the lot.
  //
  // So the guard protects what is actually worth protecting: a procedure HE STOOD OVER AND
  // DEMONSTRATED. All three contaminations were the same taught entry, and a demonstration is the
  // one thing in this store that cannot be re-derived if it is overwritten. A self-learned entry
  // keeps the old merge behaviour, which its own tests describe.
  if (hit && hit.taught) {
    const rank = match(goal).ranked.find(r => r.entry === hit);
    if (!rank || rank.score < MAYBE) {
      deps.jlog('Learned › "' + String(goal).slice(0, 40) + '" keys as "' + key + '" but is not "' +
                String(hit.goal || '').slice(0, 40) + '" — giving it its own entry');
      hit = null;
      // The bucket is taken by something else, so this needs a key of its own. Derived from the
      // goal rather than a counter, so the store stays readable when he opens it.
      const slug = String(goal).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(w => w && !STOP.has(w)).slice(1, 3).join('-');
      let candidateKey = slug ? key + ':' + slug : key;
      let n = 2;
      while (all.some(p => p.key === candidateKey)) candidateKey = (slug ? key + ':' + slug : key) + ':' + (n++);
      key = candidateKey;
    }
  }
  if (!hit) {
    const m = match(goal);
    if (m.sure) hit = m.sure.entry;
    // A FUZZY HIT IS NOT ALLOWED TO BE OVERWRITTEN BY A DEMONSTRATION.
    //
    // The scorer answers "which stored procedure is this request most like", which is the right
    // question for RETRIEVAL and the wrong one for identity when the next thing that happens is
    // destructive. Teaching "subscribe to a channel on youtube" scored 3.00/1.00 against the lesson
    // for "open my youtube channel" — the whole match carried by the word `channel`, while
    // `subscribe`, the word that makes it a different job, scored zero and was exempt from the
    // unexplained-word penalty for being the leading verb. The taught branch below then replaced that
    // entry's steps, goal and description in place and never touched its key, so the channel lesson
    // was destroyed, no `subscribe youtube` entry was ever created, and the log named the key it had
    // COMPUTED rather than the one it had overwritten. Four days of "I do not know how" followed.
    //
    // Same-key hits are still replaced: that is genuinely the same procedure being re-demonstrated.
    // A hit under a DIFFERENT key is at best a near neighbour, so a demonstration starts its own
    // entry rather than eating one. Only the taught path is guarded — the self-learned path below
    // just increments counters and cannot destroy steps.
    if (hit && opts.taught && hit.key !== key) {
      deps.jlog('Learned › taught "' + key + '" resembles "' + hit.key + '" but is not it — keeping both');
      hit = null;
    }
  }
  if (hit) {
    hit.uses = (hit.uses || 0) + 1;
    hit.ok = (hit.ok || 0) + 1;
    hit.at = Date.now();
    // THE GOAL IS THE LABEL ON THE STEPS, SO IT CANNOT BE REPLACED WHILE THEY STAY.
    //
    // The note above says the self-learned path "just increments counters and cannot destroy steps",
    // and that is true — but it destroyed the SENTENCE THAT SAYS WHAT THE STEPS ARE, which leaves an
    // entry that lies about itself. Measured on this machine, from two consecutive runs that both
    // key to a bare "order":
    //
    //   run 1  "buy me a phone charger"  -> steps: browser_go .../s?k=phone%20charger
    //   run 2  "buy me hiking boots"     -> same key, so goal became "buy me hiking boots"
    //                                       and the steps stayed the phone charger's
    //
    // The stored entry then read: buy me hiking boots -> search Amazon for a phone charger. It is
    // the same clobber the taught path was hardened against, arriving through the door that was
    // declared safe because it does not touch `steps`.
    //
    // The FIRST goal is the one the steps were recorded for, so it keeps the label; the new wording
    // is kept as a phrasing, which is exactly what the taught path does with the sentence it
    // displaces. Nothing is lost and the entry stops describing work it does not contain.
    if (!hit.goal) hit.goal = goal;
    else if (hit.goal !== goal) hit.phrasings = (hit.phrasings || []).concat([goal]).slice(-12);
    // BEING TAUGHT OVERRIDES HAVING GUESSED. Without this, a lesson a person stood over was merged
    // into whatever the loop had previously stumbled on: the counters went up, the STEPS stayed the
    // old ones, and `taught` stayed false — so the thing he just demonstrated was recorded as
    // agreement with a method he had never seen. A human demonstration replaces the stored steps and
    // goes straight to trusted; it does not need two runs to earn belief.
    if (opts.taught) {
      hit.steps = shapeOf(slotify(steps, goal, opts.description || hit.description));
      hit.taught = true;
      hit.status = 'trusted';
      hit.bad = 0;
      if (opts.description) hit.description = String(opts.description).slice(0, 200);
      // The sentence that opened the old lesson still means this procedure, so it is kept as a
      // phrasing rather than thrown away with the entry it used to be.
      if (hit.goal && hit.goal !== goal) hit.phrasings = (hit.phrasings || []).concat([hit.goal]).slice(-12);
      // hit.key, not key: these are equal now that a different-key hit is refused above, but the log
      // must name the entry it actually touched. Printing the COMPUTED key is what hid the clobber.
      deps.jlog('Learned › "' + hit.key + '" replaced by a taught procedure (' + hit.steps.length + ' steps, ' + hit.status + ')');
      save();
      return hit;
    }
    if (hit.status === 'hypothesis' && hit.ok >= CONFIRMS) {
      hit.status = 'trusted';
      deps.jlog('Learned › "' + key + '" promoted to trusted after ' + hit.ok + ' successes');
    }
    save();
    return hit;
  }
  // Taught procedures are slotified so the specific he happened to name this time does not become
  // part of the method. Self-learned ones are not: their steps came from the loop's own choices,
  // which are already generic, and templating them would be guessing at which part varied.
  // `description` is what he said the lesson is FOR, asked for once at the end of teaching. It is the
  // single most useful thing in the entry for finding it again: the goal sentence is whatever he
  // happened to type that day, while this is him saying what the job is.
  const entry = { key, goal, description: opts.description ? String(opts.description).slice(0, 200) : '',
                  phrasings: [], steps: shapeOf(opts.taught ? slotify(steps, goal, opts.description) : steps),
                  status: opts.taught ? 'trusted' : 'hypothesis',
                  ok: 1, bad: 0, uses: 1, at: Date.now(), taught: !!opts.taught };
  all.push(entry);
  if (all.length > MAX_PROCEDURES) {
    all.sort((a, b) => (b.ok - b.bad) - (a.ok - a.bad) || b.at - a.at);
    cache = all.slice(0, MAX_PROCEDURES);
  }
  save();
  // entry.status, not the literal "hypothesis": a taught procedure is created trusted, and saying
  // otherwise told him his demonstration had not stuck when it had.
  deps.jlog('Learned › recorded a new procedure for "' + key + '" (' + entry.steps.length + ' steps, ' + entry.status + ')');
  return entry;
}

// Record that a learned procedure did NOT work this time. Forgetting is as important as learning:
// a procedure that keeps failing is actively harmful, because it steers the loop down a path that
// has already been shown not to arrive.
// ---------------------------------------------------------------------------
// WHICH STEP, NOT MERELY WHETHER.
//
// A procedure has only ever succeeded or failed as a whole, and that coarseness did real damage: a
// five-step Spotify lesson whose first four steps worked perfectly was demoted, then deleted,
// because the fifth could not press a button. The blame landed on the demonstration when it belonged
// to one line of it.
//
// runPlan has been returning `at` — the index of the step that failed — on every failure since it
// was written, and both callers threw it away. So the store learned "this failed 3 times" when the
// trace could have told it "step 4 failed 3 times and steps 1-3 have never failed once".
//
// What this is FOR: a targeted answer instead of a wholesale one. "Re-teach the Follow step" is
// something he can act on; "that procedure keeps failing" is not. Everything before the failing step
// demonstrably ran, so it is credited — that is not an assumption, it is what `at` means.
// DIAGNOSING A PROCEDURE MEANS FINDING IT EVEN WHEN IT IS FAILING.
//
// recall() hides anything whose failures outnumber its successes — correct, because nothing should
// ACT on one — but that is precisely the procedure you want to look at. Using recall() here meant
// the diagnosis went blank at exactly the moment it became worth reading. This locates the entry
// without the survival filter, and is used only for accounting and reporting, never for replay.
// THE SAME BUCKET COLLISION learn() GUARDS AGAINST, ON THE PATH THAT RECORDS BLAME.
//
// learn() was taught to ask the scorer before treating a bucket hit as identity. locate() — which
// failed() and stepOutcome() use to decide WHICH procedure just went wrong — was not, and it takes
// the first entry whose coarse key matches and nothing else. keyOf collapses eleven verbs into
// "view", so:
//
//     ◆ open the app store and find chess          (his, 09:07)
//       → the clause "search for chess" keys as "view"
//       → locate() returned the taught "open my youtube channel" entry
//       → the run failed, and the failure was recorded against a procedure he demonstrated in August
//
// Measured in his state file: that entry went ok 2 / bad 0 / uses 2 → ok 2 / bad 1 / uses 3, at the
// exact millisecond the chess run ended. Two more of those and recall() hides it, because recall
// drops procedures whose failures outnumber their successes — a demonstration deleted by a request
// that had nothing to do with it.
//
// The guard is learn()'s, verbatim in intent: a keyed hit on a TAUGHT entry has to be recognised by
// the scorer as this job, or it is not this job. Self-learned entries keep the old behaviour, which
// their own tests describe.
function locate(goal) {
  const all = load();
  const byKey = all.find(p => p.key === keyOf(goal));
  if (byKey && byKey.taught) {
    const rank = match(goal).ranked.find(r => r.entry === byKey);
    if (!rank || rank.score < MAYBE) {
      deps.jlog('Learned › "' + String(goal).slice(0, 40) + '" keys as "' + byKey.key +
                '" but the scorer does not know it as that — not crediting or blaming it');
      // Fall through to the ranked search below: something else may genuinely be this job.
    } else return byKey;
  } else if (byKey) return byKey;
  const gt = tokens(goal);
  if (!gt.length) return null;
  const ranked = all.map(e => scoreEntry(gt, e)).filter(Boolean).sort((a, b) => b.score - a.score);
  const top = ranked[0];
  return (top && top.action >= 0.7 && top.score >= SURE) ? top.entry : null;
}
function stepOutcome(goal, at, why) {
  const hit = locate(goal);
  if (!hit || !Array.isArray(hit.steps)) return null;
  // Number(null) is 0, not NaN — so `stepOutcome(goal, null)`, which MEANS "the whole run
  // succeeded", was being recorded as "step 0 failed". Caught by the test that asserts a clean run
  // credits every step; the absence of an index has to be checked before it is coerced.
  const n = (at == null) ? null : Number(at);
  for (let i = 0; i < hit.steps.length; i++) {
    const s = hit.steps[i];
    if (!Number.isInteger(n)) { s.ok = (s.ok || 0) + 1; continue; }   // whole run succeeded
    if (i < n) s.ok = (s.ok || 0) + 1;                                 // reached it, so it worked
    else if (i === n) {
      s.bad = (s.bad || 0) + 1;
      if (why) s.why = String(why).replace(/\s+/g, ' ').slice(0, 140);
    }
    // Steps after the failure were never reached — neither credited nor blamed.
  }
  save();
  return hit;
}
// What is actually wrong with a procedure, in the words of the step that keeps breaking.
function diagnose(goal) {
  const hit = locate(goal);
  if (!hit || !Array.isArray(hit.steps)) return null;
  const rows = hit.steps.map((s, i) => ({
    i, tool: s.tool, ok: s.ok || 0, bad: s.bad || 0, why: s.why || '',
    label: (s.args && (s.args.description || s.args.url || s.args.name || s.args.text)) || '',
  }));
  const weak = rows.filter(r => r.bad > 0).sort((a, b) => b.bad - a.bad || a.i - b.i)[0] || null;
  const solid = rows.filter(r => r.ok > 0 && r.bad === 0).length;
  return { key: hit.key, description: hit.description || hit.goal, rows, weak, solid, taught: !!hit.taught };
}

function failed(goal, at, why) {
  const all = load();
  // Found the same way it was offered. Recording the failure against an exact key while the SCORER
  // decided what to replay would let a procedure be used under one phrasing and blamed under another.
  const hit = locate(goal);
  if (!hit) return null;
  // Per-step accounting BEFORE the procedure-level counters, so a diagnosis survives even the run
  // that tips this procedure over into being parked.
  try { if (at != null) stepOutcome(goal, at, why); } catch (e) {}
  hit.bad = (hit.bad || 0) + 1;
  hit.uses = (hit.uses || 0) + 1;
  hit.at = Date.now();
  if (hit.status === 'trusted' && hit.bad >= hit.ok) {
    hit.status = 'hypothesis';
    deps.jlog('Learned › "' + hit.key + '" demoted — ' + hit.bad + ' failures against ' + hit.ok + ' successes');
  }
  // Forgotten at the SAME threshold recall() hides it at. They were off by one, so a procedure that
  // could never be returned still occupied a slot and counted in the stats — invisible clutter that
  // makes the store look busier than it is.
  // A DEMONSTRATION IS NEVER DELETED. A GUESS STILL IS.
  //
  // Forgetting is right for something the loop stumbled on by itself: nobody loses anything, and a
  // method that keeps failing is worse than none. It is wrong for a procedure a PERSON stood over and
  // performed step by step, and this is not hypothetical — his Spotify lesson was deleted after three
  // failures, and all three were the system's own defects: a clarify resume that fabricated success
  // instead of clicking, twice, and a staleness guard that fired on a page which merely redrew. The
  // demonstration was never wrong. It was charged for someone else's bugs and he would have had to
  // teach it again without ever being told why.
  //
  // So a taught procedure is demoted and kept. It stops replaying — recall() hides anything whose
  // failures outnumber its successes, so nothing acts on it — but it is still on disk and can be
  // restored by one more success instead of a whole lesson.
  if (hit.bad > hit.ok) {
    if (hit.taught) {
      deps.jlog('Learned › "' + hit.key + '" has failed more than it worked — parked, NOT deleted ' +
                '(' + hit.bad + '/' + hit.ok + '). It was demonstrated; it stays until you say otherwise.');
    } else {
      cache = all.filter(p => p !== hit);
      deps.jlog('Learned › forgot "' + hit.key + '" — it failed more than it worked');
    }
  }
  save();
  return hit;
}

// What the loop is shown before it starts. Deliberately a HINT, never an instruction to replay:
// the page may have changed, the request may differ in a way the key cannot see, and a procedure
// that is followed blindly is how a stale method survives.
function recall(goal) {
  const m = match(goal);
  return m.sure ? m.sure.entry : null;
}
// The candidate that is plausible but not certain — handed up so a PERSON can settle it, never
// replayed on its own. Nothing is guessed silently; the whole point of asking is that the answer is
// then remembered.
function candidate(goal) {
  const m = match(goal);
  return m.maybe ? m.maybe.entry : null;
}

// REPLAYABLE means every argument is already known — nothing left to guess at run time.
//
// A hint in the prompt is not "using what it learned": the model may follow it, may not, and the
// hint does not even carry the arguments. A procedure a PERSON demonstrated, whose every step has
// complete arguments, can simply be run — no model in the path, no re-derivation, and it either
// works or fails honestly.
//
// A step with a null argument is deliberately NOT replayable. Those nulls are the parts that belong
// to the request rather than the method — the search text, the track title — and replaying one with
// last time's value would repeat an old answer to a new question.
// THE STATUS LADDER IS FOR PROCEDURES NOBODY DEMONSTRATED.
//
// `trusted` means "this has now worked more than once", which is the right bar for something the
// loop stumbled on by itself. It is meaningless for a taught one: a person stood over it and
// directed every step, which is why learn() sends a taught procedure straight to trusted without
// waiting for CONFIRMS. Requiring `trusted` HERE quietly re-imposed the bar it had just waived —
// one failure demoted a demonstration to hypothesis, replay refused it from then on, and because
// only a replay can earn a taught success it could never climb back. One strike and the lesson was
// dead while still sitting in the store looking healthy.
//
// So a taught procedure is replayable for as long as it SURVIVES. That is not a softer test than it
// sounds: failed() deletes any procedure whose failures outnumber its successes, so a demonstration
// gets a second chance and not a third. Self-learned procedures still have to earn `trusted`.
// A BARE NUMBER NAMES NO JOB, AND MUST NEVER REPLAY ONE.
//
// He was shown a numbered list of potatoes and typed "7" to pick row seven. That reached the replay
// path, fuzzy-matched a taught procedure, and JARVIS opened the APP STORE, searched "action games"
// and launched Candy Crush Saga. Nothing about "7" resembles that job — the scorer simply had
// almost no signal to work with and a stored procedure won by default.
//
// A procedure is "how to do a kind of thing", and a reply with no content word in it is not naming a
// kind of thing: it is an ANSWER to whatever was just asked. Refusing here costs nothing, because a
// goal this thin could never have been matched on merit anyway.
const NO_CONTENT_RE = /^[\s\d.,;:!?#()\[\]-]*$/;
function tooThinToReplay(goal) {
  const g = String(goal || '').trim();
  if (!g) return true;
  if (NO_CONTENT_RE.test(g)) return true;                 // digits and punctuation only
  const letters = g.replace(/[^a-z]/gi, '');
  return letters.length < 3;                              // "no", "ok", "7." — answers, not goals
}

function replayable(goal) {
  if (tooThinToReplay(goal)) return null;
  const hit = recall(goal);
  if (!hit || !hit.taught) return null;
  if (hit.status !== 'trusted' && !(hit.ok >= hit.bad)) return null;
  if (!hit.steps || !hit.steps.length) return null;
  for (const st of hit.steps) {
    for (const k of Object.keys(st.args || {})) {
      if (st.args[k] === null || st.args[k] === undefined) return null;
    }
  }
  return hit;
}

function all() { return load().slice(); }
function clear() { cache = []; save(); }
function stats() {
  const a = load();
  return { total: a.length, trusted: a.filter(p => p.status === 'trusted').length,
           hypothesis: a.filter(p => p.status === 'hypothesis').length,
           taught: a.filter(p => p.taught).length };
}

module.exports = { tooThinToReplay, init, learn, failed, recall, candidate, match, rephrase, replayable, slotify, fillSlots, targetOf,
                   stepOutcome, diagnose,
                   all, clear, stats, keyOf, shapeOf, tokens, platformOf, FILE, CONFIRMS, SURE, MAYBE };
