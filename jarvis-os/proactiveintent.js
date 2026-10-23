'use strict';
// ---------------------------------------------------------------------------
// IS THIS ABOUT JARVIS'S NUDGES (proactive.js), AND WHICH PART? — asked, not spelled out.
//
// WHAT THIS REPLACES (2026-09-18). Two word lists in front of initiative, and a third inside it:
//
//     PROACTIVE_RE   stop (interrupting|nudging|bothering) me | don't interrupt me | be quiet |
//                    (on|off) nudges | proactive (mode|status|on|off) | speak up when | notify me when something
//     then           \bstatus\b                               → the status, else the setting
//     then           off | stop | disable | quiet | shut up | mute   → proactive_set read ON or OFF from those
//
// "be quiet" — said to stop JARVIS talking over a call — switched initiative off for good. "quit bugging
// me with your little reminders" matched nothing. The same failure as every list: it fires on the phrasing
// it named and misses the one nobody wrote down.
//
// TWO REGIONS OF INITIATIVE, AND SEVEN OF WHAT IS NOT: the status (what it watches, how often it spoke
// up) and the setting — then macOS notifications and Focus, media, reminders he sets, stopping speech,
// dream mode, other settings, and ordinary requests. Each look-alike means one thing, so an initiative
// region has to beat the NEAREST of them (see dreamintent.js, calintent.js).
//
// ON OR OFF IS NOT DECIDED HERE — a polarity pair, which embeddings measurably cannot read (dreamintent.js).
// The setting region only says he is talking about the setting; server.js tells him the state and offers
// the other one as a word, and his whole reply must be that word.
//
// Every region carries English and Hinglish in proportion.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');

const PROACTIVE_EXEMPLARS = {
  // WHAT INITIATIVE IS DOING — proactive_status.
  proactive_status: [
    'what is your initiative set to',
    'how often have you been nudging me',
    'show me your proactive settings',
    'what things are you watching for me',
    'are you allowed to interrupt me right now',
    'how many nudges have you sent today',
    'is your proactive mode enabled',
    'initiative ka status batao',
    'tum kin cheezon par nazar rakh rahe ho',
    'aaj kitne nudges bheje',
  ],
  // THE SETTING — proactive_set. Which way is not read here.
  proactive_setting: [
    'turn your nudges off',
    'stop nudging me',
    'you may interrupt me again',
    'switch on proactive mode',
    'disable your initiative',
    'stop reminding me of things on your own',
    'let me work without interruptions from you',
    'resume your nudges',
    'nudges on karo',
    'apne se mat toko mujhe',
    'nudges phir se shuru karo',
  ],
  // macOS NOTIFICATIONS AND FOCUS — the system's, not JARVIS's.
  focus: [
    'turn on focus mode',
    'enable do not disturb',
    'silence all my notifications',
    'turn off notifications from whatsapp',
    'hide the notification banners',
    'focus mode on karo',
    'do not disturb chalu karo',
  ],
  // MEDIA.
  media: [
    'pause the song',
    'stop playing music',
    'mute the sound',
    'turn the volume down',
    'skip this track',
    'gaana band karo',
    'awaaz kam karo',
  ],
  // REMINDERS HE SETS — a time or an event he names, not JARVIS's own watching.
  reminders: [
    'remind me to call mama at 7',
    'tell me when the download finishes',
    'let me know when it is 5 pm',
    'set an alarm for 6',
    'ping me in ten minutes',
    'mujhe 8 baje yaad dilana',
    'alarm laga do 7 baje',
  ],
  // STOP TALKING NOW — this reply, not the setting.
  speech: [
    'stop talking',
    'shh',
    'enough talking for now',
    'stop reading that out',
    'chup ho jao',
    'bas karo bolna',
  ],
  // DREAM MODE — JARVIS's other setting.
  dream: [
    'switch dream mode on',
    'pause dream mode',
    'what did you do while i slept',
    'run the dream cycle now',
    'dream mode band karo',
  ],
  // OTHER SETTINGS.
  settings: [
    'turn on wifi',
    'enable bluetooth',
    'switch on dark mode',
    'turn off night shift',
    'wifi on karo',
    'brightness badhao',
  ],
  // ORDINARY REQUESTS.
  other: [
    'open spotify',
    'what is the weather',
    'how are you',
    'search for pizza',
    'message mama',
    'what time is it',
    'kya haal hai',
    'youtube kholo',
  ],
};

const MINE = new Set(['proactive_status', 'proactive_setting']);
const GROUPS = {};
for (const id of Object.keys(PROACTIVE_EXEMPLARS)) GROUPS[id] = MINE.has(id) ? id : 'not_proactive';

// MEASURED, 2026-09-18, nomic-embed-text — tests/test_proactiveintent.js re-measures it and prints the
// sweep. HELD: 28 sentences written before this file existed (14 about initiative, his own "proactive
// status" among them; 14 look-alikes), none an exemplar.
//
//     gate    right  missed  wrong  intruders
//     0.00      23       2      2         1
//     0.01      23       4      0         1
//     0.02–0.05 23       5      0         0      ← 0.03, the middle of the flat
//     0.06      20       8      0         0
//
// Lowest margin on a right case 0.012, highest on a wrong call 0.010. PROACTIVE_RE on the same set: 2 of
// the 14 found, and "be quiet for a sec i am on a call" switched initiative OFF. Still missed: "are your
// nudges on" (read as the setting, 0.008), "how many times did you nudge me today" (right, 0.012), "speak
// up if something needs my attention", "no more pop ups from you today" (→ Focus), "kitni baar aaj tumne
// mujhe tok diya". A miss carries on to the lanes below and changes nothing.
const MIN_MARGIN = process.env.JARVIS_PROACTIVE_MARGIN != null ? Number(process.env.JARVIS_PROACTIVE_MARGIN) : 0.03;

let _classify = null;
let _jlog = () => {};
function init(opts) { if (opts && typeof opts.jlog === 'function') _jlog = opts.jlog; }

function classifier() {
  if (!_classify) {
    _classify = intent.makeClassifier({
      exemplars: PROACTIVE_EXEMPLARS, minMargin: MIN_MARGIN, none: '__unused__', groups: GROUPS,
      label: 'Proactive', jlog: (m) => _jlog(m),
    });
  }
  return _classify;
}

// JARVIS'S OWN TOOL NAMES (proactive.js TOOLS), as evidence and never as a decision: a message that names
// one is acted on only when the classifier reads the same part; otherwise server.js asks, and keeps his
// yes for that sentence. The same rule as dreamintent.js, for the same reason — "proactive status" is his
// own message, and a name's words are ordinary words too.
const TOOL_REGION = { proactive_status: 'proactive_status', proactive_set: 'proactive_setting' };
function namedTool(text) {
  const words = String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const tool of Object.keys(require('./proactive.js').TOOLS)) {
    const name = tool.split('_');
    for (let i = 0; i + name.length <= words.length; i++) {
      if (name.every((w, k) => words[i + k] === w)) return TOOL_REGION[tool] || null;
    }
  }
  return null;
}

// { id: 'proactive_status' | 'proactive_setting', sure } or null — the same contract as dreamIntentOf.
async function proactiveIntentOf(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const named = namedTool(t);
  let read = null;
  try {
    const r = await classifier()(t);
    read = r && MINE.has(r.id) ? r.id : null;
  } catch (e) {}
  if (read && (!named || named === read)) return { id: read, sure: true };
  if (named) return { id: named, sure: false };
  return null;
}

async function explain(text) {
  try { return await classifier()(String(text || '').trim()); } catch (e) { return null; }
}

module.exports = { init, proactiveIntentOf, explain, namedTool, PROACTIVE_EXEMPLARS, GROUPS, MIN_MARGIN };
