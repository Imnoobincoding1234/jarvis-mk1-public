'use strict';
// The exam again, through the path JARVIS will actually use: Ollama, raw prompt, JSON schema, the
// request and the parsing taken from jarvis-os/readmodel.js so neither can drift from what ships.
//
//   node eval_ollama.js <exam.jsonl> [model] [--dump rows.jsonl]      default model: jarvis-reader
//
// Scores exactly like eval_reader.py (exact / MISS / REFUSED / WRONG; case and spacing alone do not
// change an action, because readmodel trims every value before use) and reports latency per read.
// Then the two gates that decide whether a reading may act, swept on these rows:
//   CONFIDENCE  the least likely token of the reading (readmodel MIN_CONFIDENCE)
//   POLARITY    for open/close, create/delete and dream_on/dream_off: the probability of the token where
//               the halves part, and its margin over the best listed alternative continuing into the other
//               half (readmodel POLARITY_MIN / _MARGIN)
// And `refers`, graded on its own, never as part of the verdict: caught / missed / false alarms, and the
// cut on the model's own P(refers) under which server.js may skip the reference check (a skipped
// reference is the error that must be zero).
const fs = require('fs');
const path = require('path');
const http = require('http');
const rm = require(path.join(__dirname, '..', 'jarvis-os', 'readmodel.js'));

const args = process.argv.slice(2);
const dumpAt = args.indexOf('--dump');
const dump = dumpAt >= 0 ? args.splice(dumpAt, 2)[1] : null;
const exam = args[0] || path.join(__dirname, 'data', 'exam_his.jsonl');
const model = args[1] || 'jarvis-reader';
const ORDER = ['act', 'thing', 'query', 'to', 'body', 'what', 'when', 'where', 'browser', 'name', 'content', 'topic', 'as', 'business', 'force', 'reported', 'video'];
const canon = o => { const r = {}; for (const k of ORDER) if (o[k] !== undefined && o[k] !== false && o[k] !== '' && o[k] !== null) r[k] = o[k]; return r; };
const low = o => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, x]) => [k, typeof x === 'string' ? x.toLowerCase().trim() : x])));
const HALF = { open: 'app+', close: 'app-', create_folder: 'file+', create_file: 'file+', delete: 'file-',
               dream_on: 'dream+', dream_off: 'dream-' };
const pairOf = a => (HALF[a] || '').slice(0, -1);
// Quitting and deleting are confirmed by runAction, naming the app or path, so an unsure reading of
// those goes to that confirmation instead of a question (readmodel CONFIRMED_BY_RUNACTION).
const CONFIRMED = new Set(['close', 'delete']);

function post(body) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data); req.end();
  });
}

(async () => {
  const rows = fs.readFileSync(exam, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const tally = { exact: 0, MISS: 0, REFUSED: 0, WRONG: 0 };
  const notes = [], graded = [], times = [];
  const out = dump ? fs.createWriteStream(dump) : null;
  for (const r of rows) {
    const t0 = Date.now();
    const res = await post(Object.assign(rm._request(r.text), { model }));
    times.push(Date.now() - t0);
    const got = res ? rm._parse(res) : null;
    const err = got ? rm.shapeError(r.text, got) : 'no answer';
    let v;
    if (err) v = 'REFUSED';
    else if (low(canon(got)) === low(canon(r.label))) v = 'exact';
    else if (got.act === 'none') v = 'MISS';
    else v = 'WRONG';
    tally[v]++;
    const g = { v, text: r.text, label: r.label, got: got ? canon(got) : null,
                conf: got && typeof got.__conf === 'number' ? got.__conf : null,
                pol: got && typeof got.__pol === 'number' ? got.__pol : null,
                anti: got && typeof got.__anti === 'number' ? got.__anti : null, ms: times[times.length - 1],
                ref: got && typeof got.__ref === 'number' ? got.__ref : null, said: !!(got && got.refers === true),
                want: !!r.label.refers };
    graded.push(g);
    if (out) out.write(JSON.stringify(g) + '\n');
    if (v !== 'exact') notes.push(v.padEnd(8) + ('(' + g.conf + (g.pol !== null ? ' pol ' + g.pol + '/' + g.anti : '') + ')').padEnd(22) +
      JSON.stringify(r.text).slice(0, 50).padEnd(52) + ' got ' + (res && res.response ? res.response.slice(0, 70) : 'nothing') +
      '  want ' + JSON.stringify(r.label).slice(0, 60) + (err ? ' (' + err + ')' : ''));
  }
  if (out) out.end();
  times.sort((a, b) => a - b);
  const p = q => times[Math.min(times.length - 1, Math.floor(q * times.length))];
  console.log(path.basename(exam) + ' via ollama ' + model + ': ' + rows.length + ' reads, median ' + p(0.5) + 'ms, p90 ' + p(0.9) + 'ms, max ' + times[times.length - 1] + 'ms');
  console.log('  exact ' + tally.exact + '   MISS ' + tally.MISS + '   REFUSED ' + tally.REFUSED + '   WRONG ' + tally.WRONG);

  // REFERS. A file labelled before the flag existed has no opinion on it and is not graded.
  if (rows.some(r => 'refers' in r.label)) {
    const want = graded.filter(g => g.want).length;
    const caught = graded.filter(g => g.want && g.said).length;
    const alarms = graded.filter(g => !g.want && g.said).length;
    console.log('  refers: caught ' + caught + ' of ' + want + ', missed ' + (want - caught) + ', false alarms ' + alarms + ' (of ' + (graded.length - want) + ' that lean on nothing)');
    for (const g of graded) if (g.want !== g.said) console.log('    refers ' + (g.want ? 'MISSED ' : 'false  ') + '(' + g.ref + ') ' + JSON.stringify(g.text).slice(0, 60));
    // THE SKIP GATE (server.js): the reference check is skipped only for a reading at or over the
    // confidence cut that does not say refers and whose P(refers) is under the cut.
    console.log('  skip the check when conf >= ' + rm.MIN_CONFIDENCE + ' and P(refers) < cut    references skipped (must be 0)   checks saved');
    for (const cut of [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5]) {
      let skippedRef = 0, saved = 0;
      for (const g of graded) {
        const skip = g.conf !== null && g.conf >= rm.MIN_CONFIDENCE && g.ref !== null && g.ref < cut && !g.said;
        if (skip && g.want) skippedRef++;
        if (skip && !g.want) saved++;
      }
      console.log('    ' + String(cut).padEnd(44) + String(skippedRef).padStart(18) + String(saved).padStart(16));
    }
  } else console.log('  refers: not graded — this file was labelled before the flag existed');

  // THE CONFIDENCE GATE. A reading whose least likely token is under the cut is not acted on: right if
  // he asked for nothing, a miss if he asked for something.
  console.log('  confidence gate   exact  MISS  REFUSED  WRONG');
  for (const cut of [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    const t = { exact: 0, MISS: 0, REFUSED: 0, WRONG: 0 };
    for (const g of graded) {
      if (g.conf !== null && g.conf < cut) t[g.label.act === 'none' ? 'exact' : 'MISS']++;
      else t[g.v]++;
    }
    console.log('  ' + String(cut).padEnd(16) + String(t.exact).padStart(6) + String(t.MISS).padStart(6) + String(t.REFUSED).padStart(9) + String(t.WRONG).padStart(7));
  }

  // THE POLARITY GATE, on readings that chose a half of open/close or create/delete while the label
  // names a half of the same pair. WRONG HALF = the model chose the opposite half: acting on one of
  // those is the error this gate exists for. A question costs a turn; a wrong half costs an action.
  const paired = graded.filter(g => g.got && pairOf(g.got.act) && pairOf(g.got.act) === pairOf(g.label.act));
  const wrongHalf = paired.filter(g => HALF[g.got.act].slice(-1) !== HALF[g.label.act].slice(-1));
  const noPol = paired.filter(g => g.pol === null).length;
  console.log('  polarity: ' + paired.length + ' readings in a pair, ' + wrongHalf.length + ' on the wrong half, ' + noPol + ' with no act token found');
  for (const g of wrongHalf) console.log('    wrong half (' + g.pol + '/' + g.anti + ') ' + JSON.stringify(g.text).slice(0, 60) + ' → ' + g.got.act);
  console.log('  min    margin   wrong half acted  (of which confirmed)   right half asked');
  for (const min of [0.5, 0.7, 0.8, 0.9, 0.95, 0.98]) {
    for (const margin of [0, 0.5, 0.8, 0.9, 0.95]) {
      let acted = 0, confirmed = 0, asked = 0;
      for (const g of paired) {
        const sure = g.pol !== null && g.pol >= min && (g.anti === null || g.pol - g.anti >= margin);
        const passes = sure || CONFIRMED.has(g.got.act);
        const wrong = HALF[g.got.act].slice(-1) !== HALF[g.label.act].slice(-1);
        if (wrong && passes) { acted++; if (!sure) confirmed++; }
        if (!wrong && !passes) asked++;
      }
      console.log('  ' + String(min).padEnd(7) + String(margin).padEnd(9) + String(acted).padStart(10) + String(confirmed).padStart(20) + String(asked).padStart(20));
    }
  }
  for (const n of notes) console.log('  ' + n);
})();
