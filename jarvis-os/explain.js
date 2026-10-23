'use strict';
// ---------------------------------------------------------------------------
// "WHY DID YOU DO THAT?" — the last turn's own decision log, said in plain English. 2026-09-26.
//
// None of the 218 JARVIS projects surveyed (finetune notes, 2026-09-26) can answer this; one logs its
// reasoning to a dashboard. JARVIS already writes every decision it makes on a turn as a log line —
// what the reader read, which guard refused what, which lane took it, where the time went. server.js
// keeps the lines of the last turn (lastTurn); this turns them into a short answer.
//
// WHAT IS READ HERE IS JARVIS'S OWN OUTPUT, NEVER HIS WORDS. Each line is "<Stage> › <what it decided>",
// written by this codebase; the stage names and their formats are the machine's, like replyclaim's reading
// of JARVIS's own replies. Nothing is guessed: a stage this file does not know is listed by name only, and
// the answer never says more than the lines do. No model writes it — a model asked why it did something
// invents a reason; the log cannot.
// ---------------------------------------------------------------------------

// "<Stage> › <rest>" → [stage, rest]; lines without the separator are ignored.
function split(line) {
  const i = String(line).indexOf(' › ');
  return i < 0 ? null : [line.slice(0, i).trim(), line.slice(i + 3).trim()];
}
const pct = p => Math.round(Number(p) * 100) + '%';
const secs = ms => (ms >= 10000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10) + ' s';

// A stage that LOOKED and let the turn pass writes "→ none of these" or "— not guessing". Those are
// collected into one clause instead of a sentence each.
const PASSED = /→ none of these$|— not guessing$/;

// The decisive stages, each read from its own line format (see the stage's jlog call in server.js).
const READ = {
  'Reasoning': r => { const m = r.match(/P ([\d.]+) — work it out$/); return m ? 'I read it as a question to work out (' + pct(m[1]) + ' sure)' : null; },
  'Chat': r => {
    let m = r.match(/^reasoning-shaped — routing to (.+)$/);
    if (m) return 'so I sent it to ' + m[1].replace(/:latest$/, '') + ' for step-by-step working';
    m = r.match(/^false completion claim — the reply wanted to act, so acting/);
    if (m) return 'then I handed it to the agent to actually do it';
    return null;
  },
  'Statement guard': r => /^not an instruction/.test(r) ? 'it read as a statement, not an instruction, so I replied instead of acting' : null,
  'Question guard': r => { const m = r.match(/^refused (\S+) for/); return m ? 'it was a question, so I did not run ' + m[1].replace(/_/g, ' ') : null; },
  'Reference': r => {
    if (/^not asked/.test(r)) return null;                                     // the ordinary case — not a reason
    let m = r.match(/^routing ".*" as "(.*)"/);
    if (m) return 'it pointed back at something from earlier, so I read it as “' + m[1] + '”';
    if (/^refusing to act/.test(r) || /will ask rather than guess$/.test(r)) return 'it pointed at something earlier I could not pin down, so I asked instead of guessing';
    m = r.match(/^goal ".*" → "(.*)"$/);
    return m ? 'it pointed back at something from earlier, so I read it as “' + m[1] + '”' : null;
  },
  'Arbiter': r => { const m = r.match(/→ (\w+)\s+\[(.+)\]$/); return m ? 'I took it as a ' + m[1] + ' request (' + m[2] + ')' : null; },
  'Normalised': r => { const m = r.match(/→ "(.*)"$/); return m ? 'I read it as “' + m[1] + '”' : null; },
  'Agent': r => {
    let m = r.match(/→ \[(\w+)\] (.+)$/);
    if (m) return 'I ran it as a ' + m[1] + ' job using ' + m[2].replace(/_/g, ' ');
    m = r.match(/^done in (\d+)ms — (.+)$/);
    return m ? 'it finished in ' + secs(+m[1]) + ' (' + m[2].replace(/_/g, ' ') + ')' : null;
  },
  'Verify': r => { const m = r.match(/^(\S+) via (\S+) → (\w+)/); return m ? 'I checked the ' + m[1].replace(/_/g, ' ') + ' actually happened (' + m[3] + ')' : null; },
  'Action': r => r.length < 120 ? r.replace(/ \(https?:[^)]*\)/, '') : null,
  'Blocked false completion claim': () => 'my first draft claimed it had done something it had not, so I blocked that',
  'Blocked false promise': () => 'my first draft promised something nothing would deliver, so I blocked that',
  'Blocked hallucinated action claim': () => 'my first draft claimed an action it had not taken, so I blocked that',
  'Memory': r => {
    if (/^answered from the store/.test(r)) return 'I answered from what you told me before';
    if (/^nothing stored/.test(r)) return 'I had nothing stored on it, and said so rather than guess';
    if (/^forgot/.test(r)) return 'I removed it from memory, as you asked';
    return null;
  },
  'Recall': r => { const m = r.match(/^attached (\d+) episode/); return m ? 'I pulled in ' + m[1] + ' earlier conversation' + (m[1] === '1' ? '' : 's') + ' for context' : null; },
  'Research': r => { const m = r.match(/^done in (\d+)ms.*?(\d+) sources/); return m ? 'I read ' + m[2] + ' web sources (' + secs(+m[1]) + ')' : null; },
  'Briefing': () => 'it was the Briefing button, so I built the briefing from your calendar, schedule, battery, disk and weather',
  'Correction': () => 'I noted what you said as a correction',
  'Music': r => { const m = r.match(/^playing: (.+)$/); return m ? 'I played ' + m[1] : null; },
  'Think': r => { const m = r.match(/^(\S+) thought (\d+) chars in (\d+)ms/); return m ? 'you pressed Think hard, so ' + m[1].split('/').pop().replace(/:.*$/, '') + ' thought it through for ' + secs(+m[3]) : null; },
  'LLM': r => { const m = r.match(/^unloaded (\S+) to make room/); return m ? 'I unloaded ' + m[1].replace(/:latest$/, '') + ' first, to keep one model in memory' : null; },
};

// What the lane name says was done — the lanes' own tags (server.js routeTag and the inferred lane).
function laneSentence(lane) {
  const l = String(lane || 'chat');
  if (l === 'chat') return 'I answered it as conversation';
  if (l === 'agent') return 'I handled it as a multi-step job';
  if (l === 'research') return 'I researched it on the web';
  if (l.startsWith('action:')) return 'I did it directly (' + l.slice(7).replace(/_/g, ' ') + ')';
  if (l.startsWith('confirm:')) return 'I asked you to confirm before ' + l.slice(8).replace(/_/g, ' ');
  if (l.startsWith('cloud:')) return 'I sent it to the cloud lane (' + l.slice(6) + ')';
  return 'the ' + l + ' lane handled it';
}

// turn: { text, lines: [...jlog lines of that turn, no timestamps], lane, took, spans: [[label, ms], …] }
function explainTurn(turn) {
  if (!turn || !Array.isArray(turn.lines)) return 'I have not done anything yet this session, Sir — nothing to explain.';
  const reasons = [], passed = [], seen = new Set();
  for (const line of turn.lines) {
    const kv = split(line); if (!kv) continue;
    const [stage, rest] = kv;
    // The why-reader itself checks every turn; naming it among the stages that passed is noise.
    if (PASSED.test(rest)) { if (stage !== 'Why' && !passed.includes(stage)) passed.push(stage); continue; }
    const f = READ[stage] || READ[Object.keys(READ).find(k => stage.startsWith(k))];
    const s = f ? f(rest) : null;
    if (s && !seen.has(s)) { seen.add(s); reasons.push(s); }
  }
  const asked = String(turn.text || '').replace(/\s+/g, ' ').trim();
  let out = 'You said “' + (asked.length > 70 ? asked.slice(0, 67) + '…' : asked) + '”. ';
  out += reasons.map(r => cap(r) + '.').join(' ').replace(/\. (So|Then) /g, (m, w) => ', ' + w.toLowerCase() + ' ');
  // "answered it as conversation" would contradict a turn that went to the reasoning model.
  if (!(turn.lane === 'chat' && reasons.some(r => /^so I sent it to/.test(r)))) out += (reasons.length ? ' ' : '') + cap(laneSentence(turn.lane)) + '.';
  if (passed.length) out += ' ' + passed.slice(0, 5).join(', ') + (passed.length > 5 ? ' and others' : '') + ' looked at it and let it pass.';
  if (turn.took >= 3000) {
    const spans = (turn.spans || []).filter(x => x[1] >= 1000).sort((a, b) => b[1] - a[1]);
    const model = spans.filter(x => /^model call/.test(x[0])).reduce((a, x) => a + x[1], 0);
    out += ' It took ' + secs(turn.took) + (model >= 1000 ? ' — ' + secs(model) + ' of that was the model' + (spans.filter(x => /^model call/.test(x[0])).length > 1 ? ' (more than one call)' : '') : '') + '.';
  }
  return out;
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

module.exports = { explainTurn, split, laneSentence };
