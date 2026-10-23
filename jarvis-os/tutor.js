'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// JARVIS tutor — the library, pointed back at you.
//
// 27 books and 19k passages sitting on the disk are worth very little if they
// only answer questions you already thought to ask. This turns that around: one
// question a day, drawn from a real passage in a book you actually own, graded
// against that same passage so the feedback is sourced rather than invented.
//
// Scheduling is SM-2 (the Anki algorithm), trimmed to the parts that matter.
// Cards you get right recede; cards you miss come back tomorrow.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let deps = { jlog: () => {}, audit: () => {}, llm: null, stateDir: null, retrieve: null, folders: null,
  askFirst: null, offerQuiz: null, dailyQuiz: null };
function init(d) { deps = Object.assign(deps, d || {}); }

const FILE = () => path.join(deps.stateDir || '/tmp', 'tutor.json');
const DAY = 86400000;

let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { store = null; }
  if (!store || typeof store !== 'object') store = { topics: [], cards: [], stats: { asked: 0, right: 0 }, pending: null };
  store.topics = store.topics || []; store.cards = store.cards || [];
  store.stats = store.stats || { asked: 0, right: 0 };
  return store;
}
function save() { try { fs.writeFileSync(FILE(), JSON.stringify(load(), null, 2)); } catch (e) {} }

const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = say => ({ ok: false, say });

// ---------------- topics ----------------
// ASK BEFORE QUIZZING (2026-10-15, his ask): "teach me about X" used to put X on the quiz list on the spot. Now a new topic
// is offered first — JARVIS's own two answer words, "quiz" (this topic) and "always" (this topic, and new topics stop being
// asked about: Settings → Quiz new topics) — and nothing is added unless one of them comes back. deps.offerQuiz arms those
// words (server.js); deps.askFirst is the setting; without offerQuiz there is no way to answer, so nothing is asked.
// deps.dailyQuiz is Settings → Daily quiz: when it is off the replies say plainly that no questions will come on their own.
const asksFirst = () => !!deps.offerQuiz && (!deps.askFirst || deps.askFirst());
const quizDaily = () => !deps.dailyQuiz || deps.dailyQuiz();
function learn_topic(args) {
  // The subject as he said it — the reader copies it from his words; nothing is cut off it by a word list.
  const t = String(args.topic || args.subject || args.text || '').trim().toLowerCase();
  const s = load();
  if (!t) {
    if (!s.topics.length) return ok('You have not set any study topics yet, Sir — say “teach me about thermodynamics”.');
    return ok('You are studying, Sir: ' + s.topics.map(x => x.name).join(', ') + '.');
  }
  if (s.topics.some(x => x.name === t)) return ok('Already on your list, Sir — ' + t + '.');
  if (!args.confirmed && asksFirst()) {
    deps.offerQuiz(t);
    return ok('Should I quiz you on ' + t + ' from your library, Sir' + (quizDaily() ? ' — a question a day' : '') +
      '? Say “quiz”, or “always” and I will add new topics without asking.', { asked: true });
  }
  s.topics.push({ name: t, added: Date.now() });
  save();
  deps.audit('learn_topic', { topic: t }, 'ok');
  return ok(quizDaily()
    ? 'Added, Sir. I will start drawing questions on ' + t + ' from your library — one a day unless you ask for more.'
    : 'Added, Sir — ' + t + ' is on your list. Daily quiz is off in Settings, so I will not bring questions on my own; say “quiz me” when you want them.');
}

function stop_topic(args) {
  const t = String(args.topic || args.subject || '').trim().toLowerCase();
  const s = load();
  const before = s.topics.length;
  s.topics = s.topics.filter(x => x.name !== t && !x.name.includes(t));
  if (s.topics.length === before) return fail('Not studying that, Sir.');
  s.cards = s.cards.filter(c => c.topic !== t);
  save();
  return ok('Dropped ' + t + ', Sir — and its cards with it.');
}

// ---------------- card generation ----------------
// Questions come from a REAL passage, and the passage is stored on the card so
// grading later compares against the book rather than the model's memory of it.
async function makeCard(topic) {
  if (!deps.retrieve) return null;
  // The topic doubles as a BOOK HINT: library.retrieve gives a 2.5× boost when the title matches,
  // which is what keeps "relativity" landing in Einstein rather than in whichever book happens to
  // use the word once. Without it, a topic named after a book you own retrieves nearly at random.
  const hits = deps.retrieve(topic, 6, topic);
  if (!hits || !hits.length) return null;
  const s = load();
  // Prefer a passage not already used — otherwise the same fact recurs forever.
  const used = new Set(s.cards.map(c => c.passage.slice(0, 80)));
  const pick = hits.find(h => !used.has(h.text.slice(0, 80))) || hits[Math.floor(Math.random() * hits.length)];
  if (!deps.llm) return null;
  try {
    const r = await deps.llm({
      system: 'Write ONE short exam question answerable purely from the passage below. Test understanding of the IDEA, ' +
        'not trivia — no "what page", no "who wrote", no "which name is mentioned". ' +
        'The reader will NOT see the passage, so never refer to "the passage" or "the text" — the question must stand ' +
        'on its own as something answerable by someone who has studied this subject. ' +
        'Output the question alone: no preamble, no answer, no quotes.',
      messages: [{ role: 'user', content: 'PASSAGE (from "' + pick.book + '"):\n' + pick.text.slice(0, 1600) }],
      max_tokens: 120, timeoutMs: 60000,
    });
    const q = String(r.text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0];
    if (!q || q.length < 12) return null;
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      topic, q, passage: pick.text.slice(0, 1600), book: pick.book, loc: pick.loc,
      ease: 2.5, interval: 0, due: Date.now(), reps: 0, created: Date.now(),
    };
  } catch (e) { return null; }
}

function dueCards() {
  const now = Date.now();
  return load().cards.filter(c => c.due <= now);
}

// ---------------- asking ----------------
async function quiz_me(args) {
  const s = load();
  if (!s.topics.length) return fail('Nothing on your study list yet, Sir — say “teach me about <subject>” and I will build questions from your books.');

  let card = dueCards()[0];
  if (!card) {
    // Nothing due — make a fresh one on the least-covered topic.
    const counts = {};
    for (const t of s.topics) counts[t.name] = 0;
    for (const c of s.cards) if (counts[c.topic] != null) counts[c.topic]++;
    const topic = (args && args.topic) || Object.keys(counts).sort((a, b) => counts[a] - counts[b])[0];
    card = await makeCard(topic);
    if (!card) return fail('I could not find anything on ' + topic + ' in your library, Sir — the books may not cover it.');
    s.cards.push(card);
  }
  s.pending = { id: card.id, at: Date.now() };
  save();
  return ok('Question, Sir — ' + card.topic + ':\n\n' + card.q + '\n\n(from ' + card.book + ')',
    { data: { cardId: card.id, awaitingAnswer: true } });
}

// SM-2, trimmed. quality 0-5; <3 is a lapse and resets the interval.
function schedule(card, quality) {
  card.reps = (card.reps || 0) + 1;
  if (quality < 3) {
    card.interval = 1;
    card.ease = Math.max(1.3, card.ease - 0.2);
  } else {
    card.interval = card.interval === 0 ? 1 : card.interval === 1 ? 6 : Math.round(card.interval * card.ease);
    card.ease = Math.max(1.3, card.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  }
  card.due = Date.now() + card.interval * DAY;
  card.lastQuality = quality;
}

async function answer_quiz(args) {
  const s = load();
  if (!s.pending) return fail('No question on the table, Sir — say “quiz me”.');
  const card = s.cards.find(c => c.id === s.pending.id);
  if (!card) { s.pending = null; save(); return fail('I lost track of that question, Sir. Ask me to quiz you again.'); }
  const given = String(args.answer || args.text || '').trim();
  if (!given) return fail('Give me your answer, Sir.');

  let quality = 3, feedback = '';
  if (deps.llm) {
    try {
      const r = await deps.llm({
        system: 'Grade ' + (profile.userName() ? profile.userName() + '\'s' : 'the user\'s') + ' answer against the source passage ONLY. Reply as JSON: {"score":0-5,"feedback":"..."}. ' +
          '5 = fully correct, 3 = essentially right with gaps, 0 = wrong or empty. In the feedback, correct him from the ' +
          'passage in one or two sentences and say what he missed. Do not be generous — an inflated score wastes his time. Address him as Sir.',
        messages: [{ role: 'user', content: 'PASSAGE:\n' + card.passage + '\n\nQUESTION: ' + card.q + '\n\nHIS ANSWER: ' + given }],
        max_tokens: 300, timeoutMs: 60000,
        schema: { type: 'object', properties: { score: { type: 'number' }, feedback: { type: 'string' } }, required: ['score', 'feedback'], additionalProperties: false },
      });
      let j = {};
      try { j = JSON.parse(String(r.text || '{}').replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch (e) {}
      if (typeof j.score === 'number') quality = Math.max(0, Math.min(5, Math.round(j.score)));
      feedback = String(j.feedback || '').trim();
    } catch (e) {}
  }
  schedule(card, quality);
  s.stats.asked++; if (quality >= 3) s.stats.right++;
  s.pending = null;
  save();
  deps.audit('answer_quiz', { topic: card.topic, score: quality }, 'ok');

  const verdict = quality >= 4 ? 'Correct, Sir.' : quality === 3 ? 'Broadly right, Sir.' : 'Not quite, Sir.';
  const nextIn = card.interval === 1 ? 'tomorrow' : 'in ' + card.interval + ' days';
  return ok(verdict + (feedback ? ' ' + feedback : '') +
    '\n\nSource: ' + card.book + ' · ' + card.loc + '. I will ask this again ' + nextIn + '.');
}

function study_stats() {
  const s = load();
  if (!s.topics.length) return ok('No study topics set, Sir.');
  const due = dueCards().length;
  const pct = s.stats.asked ? Math.round(100 * s.stats.right / s.stats.asked) : null;
  return ok('Studying, Sir: ' + s.topics.map(t => t.name).join(', ') + '.\n' +
    s.cards.length + ' cards · ' + due + ' due now' +
    (pct == null ? '' : ' · ' + pct + '% right across ' + s.stats.asked + ' answers') + '.');
}

// Used by the proactive layer: is there something worth asking, unprompted?
function dueCount() { try { return load().topics.length ? dueCards().length : 0; } catch (e) { return 0; } }
function hasTopics() { try { return load().topics.length > 0; } catch (e) { return false; } }

// A pending question captures the NEXT message and then stops — one shot, and only for a few
// minutes. Without this, asking "quiz me" and then getting on with your day meant every
// non-command sentence afterwards was silently graded as a wrong answer ("my books are on the
// shelf" came back as "Not quite, Sir"). Being asked a question does not put the conversation
// into a mode.
const PENDING_TTL = 5 * 60 * 1000;
function pendingLive() {
  const p = load().pending;
  return !!(p && Date.now() - (p.at || 0) < PENDING_TTL);
}
function clearPending() {
  const s = load();
  if (s.pending) { s.pending = null; save(); }
}

const TOOLS = { learn_topic, stop_topic, quiz_me, answer_quiz, study_stats };
const TOOL_HELP = {
  learn_topic: 'learn_topic{topic}. Add a subject the user wants to study from their own books.',
  stop_topic: 'stop_topic{topic}. Stop studying a subject.',
  quiz_me: 'quiz_me{topic?}. Ask one spaced-repetition question drawn from their library.',
  answer_quiz: 'answer_quiz{answer}. Grade their answer to the outstanding question against the source passage.',
  study_stats: 'study_stats{}. Study topics, card count, accuracy.',
};

// TUTOR_RE lived here until 2026-09-19 — a word list for what the tutor was asked. The reader model reads
// it now (quiz_me / study_stats / learn_topic / stop_topic, the subject copied from his words).

// Called by dream mode: draft cards ahead of time so "quiz me" is instant in the
// morning rather than a wait on the model. Only tops up to a small buffer.
async function prepareCards(want) {
  const s = load();
  if (!s.topics.length) return 0;
  let made = 0;
  for (const t of s.topics) {
    const unseen = s.cards.filter(c => c.topic === t.name && c.reps === 0).length;
    if (unseen >= (want || 3)) continue;
    const card = await makeCard(t.name);
    if (!card) continue;
    s.cards.push(card); made++;
    if (made >= (want || 3)) break;
  }
  if (made) save();
  return made;
}

module.exports = { init, TOOLS, TOOL_HELP, dueCount, hasTopics, prepareCards, clearPending, pending: pendingLive, asksFirst };
