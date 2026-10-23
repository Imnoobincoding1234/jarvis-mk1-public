'use strict';
// ---------------------------------------------------------------------------
// WHICH STORED FACT ACTUALLY ANSWERS THIS QUESTION?
//
// WHAT WAS HERE BEFORE. A question about himself was matched against his stored facts by SHARED
// WORDS — every token of four characters or more that was not on a small stop list, tested with
// String.includes against each fact:
//
//     const terms = cmdText.split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !GENERIC.has(w));
//     if (terms.some(w => factText.includes(w))) hits.push(fact);
//
// Reported live, and it is the clearest possible demonstration of why this shape fails:
//
//     ◆ i hate summer and enjoy winters          (stored nothing — see selffact.js)
//     ◆ do i hate summer
//       "You told me: Mihir hates being woken up early, hates phone calls, and hates people
//        being late, Sir."
//
// The question was about SUMMER. The fact that came back is about mornings, phones and lateness.
// They share exactly one thing: the letters "hate", which appear inside "hates". One shared word
// with no bearing on the subject was enough to claim the turn and answer confidently.
//
// The failure is not that the stop list was too short. Lengthening it cannot help, because the word
// that matched was the one word the question was genuinely about — the topic is what differed, and
// a substring test cannot see a topic. It is also the reason this lane felt like a canned response:
// almost any question containing a common verb matched the same few facts.
//
// WHAT THIS DOES INSTEAD. Embeds the question, embeds each candidate fact, and ranks by cosine. A
// fact has to be about the same THING, not merely share a word with the sentence.
//
//     "do i hate summer"  vs  "Mihir hates being woken up early, hates phone calls…"   far
//     "do i hate summer"  vs  "Mihir hates summer and enjoys winters"                  near
//
// IT ABSTAINS, and the direction matters. Below FLOOR nothing is returned, the lane does not claim
// the turn, and the request carries on to normal chat exactly as it did when no word matched. A
// miss costs a worse answer; a false hit tells him he said something he never said.
//
// FACT VECTORS ARE CACHED by text, because his facts change rarely and questions arrive every turn.
// Embedding is only paid for a fact the first time it is seen in this process.
// ---------------------------------------------------------------------------

const intent = require('./intent.js');
const http = require('http');

let deps = {
  jlog: () => {},
  llmModel: process.env.JARVIS_LOCAL_MODEL || 'qwen2.5:3b-instruct-q4_K_M',
  // SAME numCtx AS EVERY OTHER CALLER OF THE LOCAL 3B. ollama evicts and reloads a model when a
  // request asks for a different context size, so a smaller number here would not save memory, it
  // would cost a reload on every memory question. verblex and sitekind pin the same value.
  numCtx: Number(process.env.JARVIS_LOCAL_CTX) || 8192,
};
function init(d) { deps = Object.assign(deps, d || {}); }

// SWEPT on 16 held-out questions against a realistic stored set (test_factmatch.js holds them and
// prints the table). Six of them are ADVERSARIAL on purpose — a question that shares a word with a
// fact which does not answer it, which is the exact shape the old substring test got wrong:
//
//   floor   right   WRONG FACT RETURNED   missed
//    0.20     10            6               0
//    0.45     10            6               0
//    0.50     13            3               0
//    0.55     13            2               1
//    0.60     15            0               1      <- ships
//    0.65     12            0               4
//
// The two that 0.55 lets through say why the floor is this high: "am i allergic to cats" pulls
// "Mihir is allergic to peanuts" to 0.559, and "do i hate mondays" pulls the hates-list to 0.557.
// Both are about the right SUBJECT and the wrong OBJECT, which is as close as a wrong answer gets.
// 0.60 is the first floor that refuses them, and it still clears "do i hate summer" at 0.682.
//
// The cost was one miss — "where do i live" pulls "Mihir lives in Nagpur" to only 0.520, BELOW
// two of the adversarial pairs. No single cosine can order those correctly, because what separates
// them is not similarity: one fact SUPPLIES the value the question asks for, the other CONTRADICTS
// the value it names. So a second stage decides the band, and the miss is gone.
const FLOOR = 0.60;
// Below this, nothing is even a candidate and no model is woken.
const FLOOR_ASK = 0.45;

// STAGE TWO — AND IT IS A SELECTION, NOT A JUDGEMENT.
//
// The obvious second stage is to ask the 3B "does this fact answer this question, yes or no". That
// was measured first and it collapsed exactly as the handoff says sitekind's confirm pass did:
// sixteen out of sixteen answered NO, including "do i prefer tea or coffee" against "Mihir prefers
// tea over coffee". A small model asked to judge a proposition says no.
//
// Handed the same sixteen as a numbered list with a "none of them" option, the same model scored
// 15/16 with nothing wrong. That is the insight playbook.js already states about procedures, applied
// to retrieval: choosing an item from a list is comfortably inside what a 3B does reliably, and
// judging one is not. Picking 0 for all six adversarial questions is the part that matters.
//
//     asked as yes/no       6/16 right, 0 wrong, 10 missed
//     asked as a selection 15/16 right, 0 wrong,  1 missed
//     selection + the 0.60 fast path above    16/16, 0 wrong, 0 missed
//
// The composition is not a trick: above FLOOR the cosine was already measured to produce nothing
// wrong, so the model is never consulted there and costs nothing; between FLOOR_ASK and FLOOR the
// cosine was measured to produce SIX wrong, and the model rejected all six. Each stage is used
// only where it was measured to be right.
function askWhichFact(question, cands) {
  // What may share memory is decided first (ollama.makeRoomFor — a heavy model alone).
  return require('./ollama.js').makeRoomFor(deps.llmModel).then(() => new Promise(resolve => {
    const prompt =
      'Facts stored about a user:\n' +
      cands.map((f, i) => (i + 1) + '. ' + f).join('\n') + '\n' +
      '0. none of them\n\n' +
      'Question: ' + question + '\n\n' +
      'Which numbered fact states the answer to that question? Reply with one number.';
    const body = Buffer.from(JSON.stringify({
      model: deps.llmModel, prompt, stream: false, keep_alive: deps.keepAlive,
      // temperature 0 because this is a DECISION, not a sample — same reason verblex pins it.
      options: { temperature: 0, num_ctx: deps.numCtx, num_predict: 4, use_mmap: true },   // mmap: see ollama.js USE_MMAP
    }));
    const req = http.request({
      host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try {
          const m = String(JSON.parse(b).response || '').match(/-?\d+/);
          const n = m ? Number(m[0]) : null;
          resolve(n != null && n >= 1 && n <= cands.length ? n : 0);
        } catch (e) { resolve(null); }
      });
    });
    // The model being unreachable means the band is simply not recovered — the fast path above
    // still works, and the answer is the same one this lane gave before stage two existed.
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end(body);
  }));
}

const _vec = new Map();                       // fact text -> vector, for this process
async function vectorFor(text) {
  const k = String(text || '').trim();
  if (!k) return null;
  if (_vec.has(k)) return _vec.get(k);
  let v = null;
  try { v = await intent.embed(k.toLowerCase(), intent.MODEL); } catch (e) { v = null; }
  if (v) _vec.set(k, v);
  return v;
}

// Rank `facts` (array of strings) against `question`. Returns [{ text, sim }] over FLOOR, best
// first. Returns [] when the embedder is unavailable — the caller then falls through to chat, which
// is the same behaviour as no fact matching.
async function rank(question, facts, limit) {
  const q = String(question || '').trim();
  const list = (facts || []).map(f => String(f || '').trim()).filter(Boolean);
  if (!q || !list.length) return [];
  let qv = null;
  try { qv = await intent.embed(q.toLowerCase(), intent.MODEL); } catch (e) { qv = null; }
  if (!qv) return [];
  const scored = [];
  for (const f of list) {
    const fv = await vectorFor(f);
    if (!fv) continue;
    scored.push({ text: f, sim: intent.cos(qv, fv) });
  }
  scored.sort((a, b) => b.sim - a.sim);

  // Fast path: above FLOOR the cosine alone was measured to return nothing wrong, so no model.
  const sure = scored.filter(x => x.sim >= FLOOR);
  if (sure.length) return sure.slice(0, limit || 3);

  // The band. Everything here would have been thrown away by the floor alone, and six of the
  // sixteen held-out questions that land here are near misses that must stay thrown away.
  const band = scored.filter(x => x.sim >= FLOOR_ASK).slice(0, 4);
  if (band.length) {
    const pick = await askWhichFact(q, band.map(x => x.text));
    if (pick) {
      const chosen = band[pick - 1];
      if (deps.jlog) deps.jlog('Fact match › "' + q.slice(0, 40) + '" → picked #' + pick +
        ' of ' + band.length + ' (sim ' + chosen.sim.toFixed(3) + ', under the floor)');
      return [chosen];
    }
  }
  if (deps.jlog && list.length) {
    deps.jlog('Fact match › nothing stored is actually about "' + q.slice(0, 40) + '" — leaving it to chat');
  }
  return [];
}

module.exports = { init, rank, vectorFor, FLOOR };
