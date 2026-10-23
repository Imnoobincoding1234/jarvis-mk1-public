'use strict';
// ---------------------------------------------------------------------------
// IS HE ASKING WHAT THE CLOCK SAYS — here, or in a named place?  (2026-10-10, he is away on a trek)
//
// NOT WIRED. RESULT 2026-10-10 (sweeps/sweep_clock.js, finetune/runs/clock_20261010.log): FAILED its pre-registered bar —
// 15 of 40 answered right (bar 34), 0 wrong places, 1 false fire ("date kab hai exam ki"). Neutral-register exemplars do not
// reach his register ("time kya hua", "whats the time bro" all fell through). Kept as the base for a later attempt; the time
// question most likely belongs in the reader (a time act) instead. Nothing in server.js requires this file.
//
// Before this, the chat model answered from the clock line in its prompt, and half of the time questions in the casual
// dev set and the judged v2 run failed: the web lane took "whats the date today" and answered from search results with a
// wrong date (2023-09-28), "time in london" went to the web as well, and Hinglish "kitne baje" was misread as chat. The
// Mac's clock knows the answer exactly; no model needs to be asked.
//
// Two answered regions, embedded and compared to centroids with abstention (intent.makeClassifier, the same machinery as
// whyintent and webintent):
//   clock   the time, the date or the day, here. Answered with all three together, so which of them he meant does not
//           have to be decided.
//   zone    the time in a named place. Answered only when a city from Intl's IANA time-zone registry (a machine registry,
//           not a word list) is named in the sentence; otherwise it falls through to exactly what happened before.
// Everything that merely MENTIONS time — event times, alarms, his calendar, chat, knowledge, durations, app actions — has
// a region of its own on the none side, so it is never answered with the clock.
//
// Pre-registered and measured on finetune/data/clock_heldout.json (finetune/build_clock_heldout.js, written first) by
// sweeps/sweep_clock.js. No exemplar is a line of that set or of either casual stress set.
// ---------------------------------------------------------------------------
const intent = require('./intent.js');

const EXEMPLARS = {
  clock: [
    'what time is it right now', 'can you check the time for me', 'what is the time at the moment', 'do you know what time it is',
    'what is the date', 'which date do we have today', 'tell me what day it is', 'what weekday is today', 'what is the day and date',
    'is it still friday', 'abhi samay kya hai', 'samay batao', 'aaj tarikh kya hai', 'aaj kaun sa vaar hai',
  ],
  zone: [
    'what time is it in berlin right now', 'what is the time in madrid', 'tell me the time in chicago', 'what is the local time in moscow',
    'is it morning in seattle', 'how late is it in hong kong', 'bangkok mein samay kya hai', 'what time is it over in cairo',
  ],
  'none-event': ['when does the football final start', 'what time does the bank open', 'when is holi next year', 'what time is the eclipse tonight',
    'when does the concert begin'],
  'none-alarm': ['set an alarm for seven', 'remind me in an hour', 'start a timer for five minutes', 'wake me at six thirty'],
  'none-calendar': ['what time is my meeting tomorrow', 'do i have anything this afternoon', 'when is my doctor visit', 'what is on my schedule'],
  'none-chat': ['i am running out of time', 'take your time', 'that was a long time ago', 'good times', 'every time i ask you are slow',
    'time pass ho raha hai', 'mere paas time nahi hai'],
  'none-knowledge': ['what is the speed of light', 'how does a clock work', 'how many minutes are in a day', 'when did the first world war start',
    'what is a time zone', 'when was google founded'],
  'none-duration': ['how long until my birthday', 'how long does a flight to goa take', 'how much time to cook rice',
    'what time should i leave to reach by nine', 'how many days until the holidays'],
  'none-action': ['launch the stopwatch', 'play the song clocks by coldplay', 'search for timezone converter', 'set the date on my mac'],
};
const GROUPS = {};
for (const id of Object.keys(EXEMPLARS)) GROUPS[id] = id.startsWith('none-') ? 'none' : id;

// Leave-one-out over these exemplars picked 0.05 (44/57 right, 2 none-exemplars answered); the held-out then failed.
const MIN_MARGIN = process.env.JARVIS_CLOCK_MARGIN != null ? Number(process.env.JARVIS_CLOCK_MARGIN) : 0.05;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }
function classifier(margin) {
  if (margin != null) return intent.makeClassifier({ exemplars: EXEMPLARS, minMargin: margin, none: 'none', groups: GROUPS, label: 'Clock', jlog: () => {} });
  if (!_classify) _classify = intent.makeClassifier({ exemplars: EXEMPLARS, minMargin: MIN_MARGIN, none: 'none', groups: GROUPS, label: 'Clock', jlog: m => _jlog(m) });
  return _classify;
}

// THE PLACE COMES FROM THE REGISTRY. Every IANA zone ends in a city ("America/New_York" → "new york"); the longest one named
// as whole words in the sentence wins. Nothing here lists places a person might say.
let _cities = null;
function cities() {
  if (_cities) return _cities;
  _cities = [];
  try {
    for (const z of Intl.supportedValuesOf('timeZone')) {
      const city = z.split('/').pop().replace(/_/g, ' ').toLowerCase();
      if (city.length >= 3 && !/^(?:gmt|utc)/.test(city)) _cities.push({ city, zone: z });
    }
  } catch (e) {}
  _cities.sort((a, b) => b.city.length - a.city.length);
  return _cities;
}
function zoneIn(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ') + ' ';
  for (const c of cities()) if (t.includes(' ' + c.city + ' ')) return c;
  return null;
}

// The reading, without answering: { kind: 'clock' } | { kind: 'zone', zone, city } | null.
async function read(text, margin) {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return null;
  let r = null;
  try { r = await classifier(margin)(t); } catch (e) { return null; }
  if (!r) return null;
  if (r.id === 'clock') return { kind: 'clock' };
  if (r.id === 'zone') { const z = zoneIn(t); return z ? { kind: 'zone', zone: z.zone, city: z.city } : null; }
  return null;
}

const title = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());
function say(reading, now) {
  const d = now || new Date();
  if (!reading) return null;
  if (reading.kind === 'clock') {
    const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
    const date = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return 'It is ' + time + ', ' + date.replace(/^(\w+) /, '$1, ') + ', Sir.';
  }
  if (reading.kind === 'zone') {
    const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: reading.zone }).toUpperCase();
    const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: reading.zone });
    return 'It is ' + time + ' in ' + title(reading.city) + ' — ' + day.replace(/^(\w+) /, '$1, ') + ', Sir.';
  }
  return null;
}

// The lane: a reply, or null to fall through.
async function answer(text) {
  const r = await read(text);
  if (!r) return null;
  _jlog('Clock › "' + String(text).slice(0, 40) + '" → ' + r.kind + (r.zone ? ' (' + r.zone + ')' : ''));
  return say(r);
}

module.exports = { init, read, say, answer, zoneIn, EXEMPLARS, GROUPS, MIN_MARGIN };
