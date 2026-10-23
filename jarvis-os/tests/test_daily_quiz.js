// SETTINGS → DAILY QUIZ + QUIZ NEW TOPICS (2026-10-15, his asks: "no where to disable the daily 10 questions pop up"; "teach me"
// made an auto quiz without asking → ask first, with a "don't ask me again"). profile.dailyQuiz (default
// on, as before) gates tutor mode's unprompted side: Dream drafting new study cards (dream.js jobPrepCards via deps.quizOn) and
// the "N questions ready" nudge (server.js tutorDue → proactive.js sigTutor). "quiz me" is untouched. Stubs only — no model.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require(path.join(__dirname, '..', 'dream.js'));
const P = require(path.join(__dirname, '..', 'profile.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}

async function main() {
  console.log('— the setting —');
  eq('on by default (nothing changes until he turns it off)', P.DEFAULTS.dailyQuiz, true);

  console.log('\n— Dream: new study cards only while the quiz is on —');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-quiz-'));
  let drafted = 0;
  const tutor = { hasTopics: () => true, prepareCards: async n => { drafted += n; return n; } };
  D.init({ stateDir: tmp, jlog: () => {}, tutor, quizOn: () => false });
  let done = await D.cycle(true);
  eq('off → no cards drafted', drafted, 0);
  eq('off → the cycle reports no drafting', (done || []).some(x => /study question/.test(x)), false);
  D.init({ quizOn: () => true });
  done = await D.cycle(true);
  eq('on → three cards drafted, as before', drafted, 3);
  eq('on → the cycle says so', (done || []).some(x => /drafted 3 study questions/.test(x)), true);
  D.init({ quizOn: null });
  await D.cycle(true);
  eq('no switch wired (an older caller) → drafts as before', drafted, 6);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n— server + Settings panel carry it (source) —');
  const S = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  eq('Settings may save it (SET_BOOL)', /const SET_BOOL = \[[^\]]*'dailyQuiz'/.test(S), true);
  eq('the nudge counts no cards while it is off', /tutorDue: \(\) => \(profile\.get\(\)\.dailyQuiz === false \? 0 : tutor\.dueCount\(\)\)/.test(S), true);
  eq('Dream is told whether it is on', /quizOn: \(\) => profile\.get\(\)\.dailyQuiz !== false/.test(S), true);
  eq('the panel shows it under "What it does on its own"', /WHAT IT DOES ON ITS OWN',\s*keys: \[[^\]]*'dailyQuiz'/.test(UI) && /dailyQuiz:\s*\{ label: 'Daily quiz'/.test(UI), true);

  console.log('\n— ask before quizzing a new topic ("quiz" / "always") —');
  const T = require(path.join(__dirname, '..', 'tutor.js'));
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-ask-'));
  const offered = []; let ask = true, daily = true;
  T.init({ stateDir: tdir, jlog: () => {}, audit: () => {}, askFirst: () => ask, dailyQuiz: () => daily, offerQuiz: t => offered.push(t) });
  const topics = () => JSON.parse(fs.readFileSync(path.join(tdir, 'tutor.json'), 'utf8')).topics.map(x => x.name);
  let r = T.TOOLS.learn_topic({ topic: 'Thermodynamics' });
  eq('a new topic is asked about, not added', [r.ok, r.asked, offered, fs.existsSync(path.join(tdir, 'tutor.json'))], [true, true, ['thermodynamics'], false]);
  eq('…and the question names both answers', /Say “quiz”, or “always”/.test(r.say) && /a question a day/.test(r.say), true);
  r = T.TOOLS.learn_topic({ topic: 'thermodynamics', confirmed: true });
  eq('"quiz" (confirmed) adds it, as before', [topics(), /one a day/.test(r.say)], [['thermodynamics'], true]);
  r = T.TOOLS.learn_topic({ topic: 'thermodynamics' });
  eq('already on the list → said so, nothing asked', [/Already on your list/.test(r.say), offered.length], [true, 1]);
  ask = false;
  r = T.TOOLS.learn_topic({ topic: 'optics' });
  eq('"always" set (askFirst false) → added straight away', [r.asked, topics()], [undefined, ['thermodynamics', 'optics']]);
  ask = true; daily = false;
  r = T.TOOLS.learn_topic({ topic: 'algebra' });
  eq('Daily quiz off → the question does not promise a daily question', /a question a day/.test(r.say), false);
  r = T.TOOLS.learn_topic({ topic: 'algebra', confirmed: true });
  eq('Daily quiz off → added, and the reply says nothing comes on its own', /Daily quiz is off/.test(r.say), true);
  eq('asksFirst follows the setting', [T.asksFirst(), (ask = false, T.asksFirst())], [true, false]);
  T.init({ offerQuiz: null }); ask = true;
  eq('no way to answer (no offerQuiz) → nothing is asked', T.asksFirst(), false);
  fs.rmSync(tdir, { recursive: true, force: true });
  eq('Quiz new topics defaults to ask', P.DEFAULTS.quizNewTopics, 'ask');
  eq('Settings may save it (SET_OPTIONS ask/always)', /quizNewTopics: \['ask', 'always'\]/.test(S), true);
  eq('server arms JARVIS\'s own words "quiz" and "always"', /setWordOffer\('quiz', 'quiz you on '/.test(S) && /setWordOffer\('always', 'quiz new topics without asking'/.test(S), true);
  eq('"always" saves the setting', /profile\.save\(\{ quizNewTopics: 'always' \}\)/.test(S), true);
  eq('an unsure reader hands a study topic to the tutor\'s question (no double ask)', /q\.action\.type === 'learn_topic' && tutor\.asksFirst\(\)/.test(S), true);
  eq('the panel shows Quiz new topics', /'dailyQuiz', 'quizNewTopics'\]/.test(UI) && /quizNewTopics:\s*\{ label: 'Quiz new topics'/.test(UI), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
