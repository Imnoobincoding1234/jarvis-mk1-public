'use strict';
// ---------------------------------------------------------------------------
// DOES HE WANT THIS DONE LATER? — asked of the embedder, then of the local model; never spelled out. 2026-10-14.
//
// His live turns: "open the app store in about a minute" went to the why lane, "open notes in 2 minutes" to the teach
// offer — JARVIS had a scheduler (automations with task.goal) and no way to hand a timed request to it. Recognising
// "later" by its words would be the trap this project removes (EXPLICIT_TIME_RE and the every|each|daily regex are not
// used here): "close safari in like 10 minutes", "aadhe ghante mein youtube khol dena" and "text mama saying im on my way
// in half an hour" share no fixed words, and the last one is a message to send NOW whose content has a time in it.
//
// TWO STAGES (pattern from OpenClaw's automations: the model fills structured time, the code does the arithmetic):
//   1. a region classifier on the embedder — a request for later vs a request for now, a reminder, a statement, a
//      question (groups: only `later` against the rest, by the margin). Cheap, asked on plain turns.
//   2. only on a stage-1 hit, the local model with a JSON schema answers JARVIS's own decision — run it now, or
//      schedule it; if scheduled, minutes from now or the local clock time; and the task in his words. whenOf() does
//      the arithmetic; no model computes a timestamp.
// Held-out: finetune/data/timed_heldout_v1.jsonl (build_timed_heldout.js), written before these exemplars; none of it is
// here (checked by sweeps/sweep_timed.js). Bars in finetune/README.md "B · timed requests".
// ---------------------------------------------------------------------------
const intent = require('./intent.js');

const EXEMPLARS = {
  later: [
    'open spotify in five minutes',
    'in ten mins close the browser',
    'turn the volume down in half an hour',
    'after twenty minutes open my email',
    'at 10 pm put on some sleep music',
    'open the weather app tomorrow at 8',
    'text ira at 7 tonight that im outside',
    'start the chemistry playlist in an hour',
    'quit vs code at midnight',
    'in 2 hours open zoom for my class',
    'take a screenshot at quarter past nine',
    'do minute baad notes khol dena',
    'aadhe ghante baad gaana band kar dena',
    'raat 11 baje zoom khol dena',
    'subah 6 baje bhajan chala dena',
    'ek ghante mein ira ko call kar dena',
    'paanch minute mein youtube band kar',
    'kal shaam 5 baje maps khol dena',
  ],
  now: [
    'bring up the photos app for me',
    'close the browser right now',
    'turn the volume down to 20',
    'play a 5 minute breathing exercise',
    'search for 30 minute workouts',
    'text ira saying ill be there at 7',
    'tell mama i will call her in an hour',
    'open the 9am meeting link',
    'set brightness to 50',
    'youtube pe 10 minute ki recipe dikhao',
    'bhai ko bol de 8 baje tak aa jaunga',
    'is waqt instagram hata do screen se',
    'terminal chalu karo',
  ],
  reminder: [
    'remind me in an hour to stretch',
    'ping me with a reminder at 5 about the electricity form',
    'set a reminder for tomorrow 9am dentist',
    'remind me tonight to pack my bag',
    'kal 10 baje yaad dila dena meeting ki',
    '2 ghante baad yaad dilana khana khane ka',
    'dont let me forget the recharge tonight',
  ],
  statement: [
    'my class starts in 15 minutes',
    'im going to sleep at 11',
    'the bus comes at 7:40',
    'i studied for 2 hours today',
    'dinner is in half an hour',
    'my flight is at 6 am tomorrow',
    'kal subah 5 baje uthna hai',
    'main 10 minute mein free ho jaunga',
    'mama 9 baje tak aa jayegi',
    'the movie was 3 hours long',
  ],
  question: [
    'what time is it',
    'how many minutes till 5',
    'what time is it in new york',
    'how long is a football match',
    'is it 7 already',
    'kitna time bacha hai 12 bajne mein',
    'aaj kaunsa din hai',
    'how many seconds are in an hour',
  ],
};
const GROUPS = {};
for (const id of Object.keys(EXEMPLARS)) GROUPS[id] = id === 'later' ? 'later' : 'not_later';
// NOT YET MEASURED — sweeps/sweep_timed.js chooses it by leave-one-out on these exemplars only, then reports the held-out
// once. Until then nothing calls this module (it is not wired into server.js).
const MIN_MARGIN = process.env.JARVIS_TIMED_MARGIN != null ? Number(process.env.JARVIS_TIMED_MARGIN) : 0.03;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }
function classifier(minMargin) {
  if (minMargin != null) return intent.makeClassifier({ exemplars: EXEMPLARS, minMargin, none: 'not_later', groups: GROUPS, label: 'Timed', jlog: () => {} });
  if (!_classify) _classify = intent.makeClassifier({ exemplars: EXEMPLARS, minMargin: MIN_MARGIN, none: 'not_later', groups: GROUPS, label: 'Timed', jlog: m => _jlog(m) });
  return _classify;
}
// Stage 1: true only when "a request for later" beats every other region by the margin; the embedder down → false.
async function isLater(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return false;
  try { const r = await classifier()(t); return !!(r && r.id === 'later'); } catch (e) { return false; }
}

// Stage 2's question names JARVIS's own decision and the fields it needs — never kinds of phrasing.
const SCHEMA = {
  type: 'object',
  properties: {
    run: { type: 'string', enum: ['now', 'later'], description: 'when JARVIS should carry out the request' },
    minutes_from_now: { type: ['number', 'null'], description: 'if later and the message gives a delay: the delay in minutes' },
    hour: { type: ['number', 'null'], description: 'if later and the message gives a clock time: local 24-hour hour (0-23)' },
    minute: { type: ['number', 'null'], description: 'if later and the message gives a clock time: minute (0-59)' },
    day: { type: ['string', 'null'], enum: ['today', 'tomorrow', null], description: 'if a clock time: today or tomorrow' },
    task: { type: 'string', description: 'the request itself, in the user’s own words, without the time' },
  },
  required: ['run', 'task'],
  additionalProperties: false,
};
function systemFor(now) {
  return 'The user sent one message to JARVIS, an assistant that controls this Mac. Decide when JARVIS should carry out ' +
    'what the message asks: now, or at a later time that the message itself gives. If later, give either the delay in ' +
    'minutes from now, or the local clock time (24-hour hour, minute, today or tomorrow). task is the request to carry ' +
    'out, in the user’s own words, without the time. Local time now: ' + new Date(now).toString() + '. Reply with JSON only.';
}
// The arithmetic, in code. A delay → now + minutes; a clock time → that time today, or tomorrow if asked or already past.
function whenOf(j, now) {
  if (!j || j.run !== 'later') return null;
  const m = Number(j.minutes_from_now);
  if (j.minutes_from_now != null && isFinite(m) && m > 0 && m <= 7 * 24 * 60) return now + Math.round(m * 60000);
  const h = Number(j.hour), mi = j.minute == null ? 0 : Number(j.minute);
  if (j.hour == null || !isFinite(h) || h < 0 || h > 23 || !isFinite(mi) || mi < 0 || mi > 59) return null;
  const d = new Date(now); d.setHours(h, mi, 0, 0);
  if (j.day === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
// Stage 2 → { when, task } when JARVIS should schedule it, else null (run it now / not readable).
async function decide(text, deps) {
  const now = (deps && deps.now) || Date.now();
  try {
    const resp = await deps.llm({ max_tokens: 200, system: systemFor(now), messages: [{ role: 'user', content: String(text) }],
      schema: SCHEMA, timeoutMs: 30000, temperature: 0 });
    const j = deps.parseJson(resp && resp.text);
    const when = whenOf(j, now);
    const task = String((j && j.task) || '').trim();
    if (!when || !task) return null;
    return { when, task };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// ROUND 7 (2026-10-15): the READER decides that a request is for later and cuts the time words out (`when`, his words);
// this only turns those words into a time. The local model answers under a JSON schema; whenOf() does the arithmetic. A
// phrase that names no exact time ("tmrw morning", "tonight", "thodi der mein") comes back null, and JARVIS asks for one.
// v1 (an `exact` flag) FAILED 15/30 on when_phrases_v1: the model filled clock times right and then said "not exact". v2 has no flag:
// a phrase that sets no time leaves both the delay and the clock empty (README "Converter v2").
const WHEN_SCHEMA = {
  type: 'object',
  properties: {
    minutes_from_now: { type: ['number', 'null'], description: 'if the words set a delay: how many minutes from now' },
    hour: { type: ['number', 'null'], description: 'if the words set a clock time: local 24-hour hour (0-23)' },
    minute: { type: ['number', 'null'], description: 'if the words set a clock time: minute (0-59)' },
    day: { type: ['string', 'null'], enum: ['today', 'tomorrow', null], description: 'if the words set a clock time: today or tomorrow' },
  },
  required: ['minutes_from_now', 'hour'],
  additionalProperties: false,
};
function whenSystem(now) {
  return 'The user told JARVIS, an assistant on this Mac, WHEN to do something, in these words. Give the time these words set: either ' +
    'the delay in minutes from now, or the local clock time (24-hour hour, minute, today or tomorrow). If the words set no delay and no ' +
    'clock time, leave both empty (null). Local time now: ' + new Date(now).toString() + '. Reply with JSON only.';
}
async function convertWhen(words, deps) {
  const now = (deps && deps.now) || Date.now();
  try {
    const resp = await deps.llm({ max_tokens: 120, system: whenSystem(now), messages: [{ role: 'user', content: String(words) }],
      schema: WHEN_SCHEMA, timeoutMs: 30000, temperature: 0, ...(deps.model ? { model: deps.model } : {}) });
    const j = deps.parseJson(resp && resp.text);
    if (!j) return null;
    return whenOf(Object.assign({ run: 'later' }, j), now);
  } catch (e) { return null; }
}

module.exports = { init, isLater, decide, whenOf, classifier, EXEMPLARS, GROUPS, MIN_MARGIN, SCHEMA, systemFor, convertWhen, WHEN_SCHEMA, whenSystem };
