// MEASUREMENT SCRIPT — app-name matching without the filler-word list (finetune/README "App matcher without the filler-word list",
// pre-registered 2026-10-17). Six candidates on data/app_match_heldout_v1.jsonl against the apps installed on THIS Mac:
//   C0 today's system_control.fuzzyApp (APP_FILLER + ALIAS_BASE)   C1 the same without APP_FILLER
//   C2 APP_FILLER replaced by the registry itself — a query word that is no word, word-start or initials of ANY installed app
//      name cannot identify one and is set aside (statistics of the registry, no list)      C3 = C2 without ALIAS_BASE
//   C4 the reader's own resolver (actread: registry anchors, typo match, scaffolding by his own word frequencies)
//   C5 semantic: nomic-embed-text cosine between the query and each app name; threshold chosen on even rows, scored on odd rows
// WRONG = an app other than the label (or any app when the label is none); MISS = none when the label names one.
//   node sweeps/sweep_app_match.js [--no-embed]
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const HELD = path.join(ROOT, '..', 'finetune', 'data', 'app_match_heldout_v1.jsonl');
const rows = fs.readFileSync(HELD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const SC = require(path.join(ROOT, 'system_control.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'system_control.js'), 'utf8');

// The same registry fuzzyApp reads.
const DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
const APPS = [...new Set(DIRS.flatMap(d => { try { return fs.readdirSync(d).filter(n => n.endsWith('.app')).map(n => n.slice(0, -4)); } catch (e) { return []; } }))];
// The two hand lists, read out of the file as they are today (so C0 is exactly today's code).
const FILLER = new Set(eval(SRC.match(/const APP_FILLER = new Set\((\[[\s\S]*?\])\);/)[1]));
const ALIAS = eval('(' + SRC.match(/const ALIAS_BASE = (\{[^}]*\});/)[1] + ')');
const wordsOf = a => a.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const APP_WORDS = APPS.map(a => ({ app: a, low: a.toLowerCase(), words: wordsOf(a) }));
const spells = (t, words) => t.length >= 2 && words.some((w, i) => i + t.length <= words.length && words.slice(i, i + t.length).every((x, k) => x[0] === t[k]));
const tokenHits = (t, words) => words.some(w => w === t || w.startsWith(t)) || spells(t, words);
// Does a query word occur in the registry at all? (C2/C3 — the registry's own statistics in place of a list.)
const inRegistry = t => APP_WORDS.some(x => tokenHits(t, x.words));

// fuzzyApp, parameterised exactly along the two lists — nothing else changes.
function fuzzy(query, { filler, alias, registryOnly }) {
  const q = String(query || '').toLowerCase().trim();
  if (alias && ALIAS[q]) return ALIAS[q];
  let qt = q.split(/\s+/).filter(t => t.length > 1);
  if (filler) qt = qt.filter(t => !FILLER.has(t));
  if (registryOnly) qt = qt.filter(inRegistry);
  let best = null;
  for (const x of APP_WORDS) {
    let score = 0;
    if (x.low === q) score = 1;
    else if (x.low.startsWith(q)) score = 0.9;
    else if (x.low.includes(q)) score = 0.75;
    else if (qt.length) score = (qt.filter(t => tokenHits(t, x.words)).length / qt.length) * 0.6;
    if (!best || score > best.score) best = { name: x.app, score };
  }
  return best && best.score >= 0.5 ? best.name : null;
}

// C4 — the reader's resolver, with his word frequencies from his own messages (finetune/data/his_messages.jsonl).
const actread = require(path.join(ROOT, 'actread.js'));
const msgs = (() => { try { return fs.readFileSync(path.join(ROOT, '..', 'finetune', 'data', 'his_messages.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).text); } catch (e) { return []; } })();
const distinct = [...new Set(msgs.map(m => String(m).toLowerCase()))];
const df = new Map();
for (const m of distinct) for (const t of new Set(actread.tokenize(m).map(x => x.low))) df.set(t, (df.get(t) || 0) + 1);
actread.init({ jlog: () => {}, store: { read: () => null, write: () => {} }, df: w => df.get(w) || 0, messages: () => distinct.length,
  validUrl: () => false, normalizeUrl: u => u });
function viaReader(query) {
  const toks = actread.tokenize(String(query));
  const anchors = actread.anchorsIn(toks);
  if (!anchors.length && toks.length === 1 && !toks[0].ident) {
    const typo = actread.typoAnchor(toks[0].raw);
    if (typo && typo.kind === 'app') return typo.value;
  }
  const covered = new Set();
  for (const a of anchors) for (let k = a.i; k < a.j; k++) covered.add(k);
  const rest = toks.filter((t, k) => !covered.has(k) && !actread.isScaffold(t.low));
  if (anchors.length !== 1 || rest.length) return null;
  return anchors[0].kind === 'app' ? anchors[0].value : null;
}

const score = (rs, f) => {
  let wrong = 0, miss = 0, right = 0; const bad = [];
  for (const r of rs) {
    const got = f(r.q);
    if (got && got !== r.app) { wrong++; bad.push('WRONG ' + r.q + ' → ' + got); }
    else if (!got && r.app) { miss++; bad.push('MISS  ' + r.q + ' (want ' + r.app + ')'); }
    else right++;
  }
  return { right, wrong, miss, bad };
};
const C = {
  C0: q => fuzzy(q, { filler: true, alias: true }),
  C1: q => fuzzy(q, { filler: false, alias: true }),
  C2: q => fuzzy(q, { filler: false, alias: true, registryOnly: true }),
  C3: q => fuzzy(q, { filler: false, alias: false, registryOnly: true }),
  C4: viaReader,
};

(async () => {
  console.log('installed apps', APPS.length, '· held-out', rows.length, '(' + rows.filter(r => r.app).length + ' name an app)');
  console.log('C0 check — the parameterised copy agrees with today\'s fuzzyApp on every row:',
    rows.every(r => { const m = SC.fuzzyApp(r.q); return (m && m.score >= 0.5 ? m.name : null) === C.C0(r.q); }));
  const odd = rows.filter((r, i) => i % 2 === 1), even = rows.filter((r, i) => i % 2 === 0);
  if (!process.argv.includes('--no-embed')) {
    const ol = require(path.join(ROOT, 'ollama.js'));
    const vec = async t => { const r = await ol.embed(t, { model: 'nomic-embed-text' }); return r && r.v; };
    const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };
    const appV = []; for (const a of APPS) appV.push({ app: a, v: await vec(a) });
    const near = {}; for (const r of rows) { const v = await vec(r.q); let best = null; for (const a of appV) { const s = cos(v, a.v); if (!best || s > best.s) best = { app: a.app, s }; } near[r.q] = best; }
    let pick = null;
    for (let t = 0.5; t <= 0.951; t += 0.01) {
      const th = Number(t.toFixed(2)), s = score(even, q => (near[q].s >= th ? near[q].app : null));
      if (!pick || s.wrong < pick.s.wrong || (s.wrong === pick.s.wrong && s.miss < pick.s.miss)) pick = { th, s };
    }
    console.log('C5 threshold chosen on the even rows:', pick.th, '(even rows: wrong', pick.s.wrong, 'miss', pick.s.miss + ')');
    C.C5 = q => (near[q].s >= pick.th ? near[q].app : null);
  }
  const res = {};
  for (const [k, f] of Object.entries(C)) {
    const all = score(rows, f), o = score(odd, f);
    res[k] = { all: { right: all.right, wrong: all.wrong, miss: all.miss }, odd: { right: o.right, wrong: o.wrong, miss: o.miss } };
    console.log('\n' + k + (k === 'C5' ? ' (odd rows only are fair)' : '') + '  all ' + rows.length + ': right ' + all.right + ' · WRONG ' + all.wrong + ' · MISS ' + all.miss +
      '   |  odd ' + odd.length + ': right ' + o.right + ' · WRONG ' + o.wrong + ' · MISS ' + o.miss);
    for (const b of all.bad) console.log('     ' + b);
  }
  fs.writeFileSync(path.join(ROOT, '..', 'finetune', 'runs', 'app_match_20261017', 'result.json'), JSON.stringify(res, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
