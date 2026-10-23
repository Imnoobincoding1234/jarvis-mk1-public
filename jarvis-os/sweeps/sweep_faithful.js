'use strict';
// MEASUREMENT SCRIPT — not a test. Does a rewrite add CONTENT he never typed?
//
// THE DATA IS REAL: 157 rewrites the normaliser actually produced in his log, matched back to the
// full sentence he typed. Labelled before this script was written: FAITHFUL when it is the same
// request with the phrasing changed, FABRICATED when it adds, drops or changes what is acted on, or
// turns a non-request into an action. Seven unclear ones are excluded rather than guessed.
//
// NO WORD LIST, NO MODEL. Which words in a rewrite are content is read from HIS OWN LEXICON — the
// same inverse document frequency errand.js keeps — and every content word must be traceable to a
// word he typed by edit distance (agent.js's identity score, floor 0.80). A rewrite may add the words
// he uses constantly; it may not add the words he rarely or never does.

const fs = require('fs');
const path = require('path');
// state/norm_pairs.json is machine state, never committed: it holds his real sentences. FAITHFUL and
// UNCLEAR below index into it, so it must not be regenerated in a different order.
const pairs = JSON.parse(fs.readFileSync(process.env.PAIRS || path.join(__dirname, '..', 'state', 'norm_pairs.json'), 'utf8'));
const FAITHFUL = new Set([0,1,2,8,34,36,37,41,42,43,44,45,46,47,48,49,52,53,57,58,60,61,62,63,64,
  72,74,77,80,82,88,89,90,94,97,98,100,101,127,131,132,133,134,135,145,150]);
const UNCLEAR = new Set([5,39,59,81,92,129,136]);

const lex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'lexicon.json'), 'utf8'));
const idf = w => Math.log((lex.n + 1) / ((lex.df[w] || 0) + 1));
const tokens = s => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function ed(a, b) { if (a === b) return 0; let p = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const c = [i]; for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[b.length]; }
const same = (x, y) => { const s1 = 1 - ed(x, y) / Math.max(x.length, y.length); const pre = (y.startsWith(x) || x.startsWith(y)) && Math.min(x.length, y.length) >= 4 ? 0.92 : 0; return Math.max(s1, pre) >= 0.80; };

// CONTENT: tokens weighted above the rewrite's own mean IDF; if none stands out, all of them.
function content(rw, rule) {
  const t = tokens(rw); if (!t.length) return [];
  const w = t.map(idf);
  if (rule === 'mean') { const m = w.reduce((a, b) => a + b, 0) / w.length; const c = t.filter((_, i) => w[i] > m + 1e-9); return c.length ? c : t; }
  // 'vocab': above a percentile of HIS WHOLE VOCABULARY — also data, not a list
  const all = Object.values(lex.df).map(d => Math.log((lex.n + 1) / (d + 1))).sort((a, b) => a - b);
  const cut = all[Math.floor(all.length * rule)];
  return t.filter((_, i) => w[i] >= cut);
}
function invented(orig, rw, rule) {
  const o = tokens(orig);
  return content(rw, rule).filter(w => !o.some(x => same(w, x)));
}

for (const rule of ['mean', 0.02, 0.05, 0.10, 0.20]) {
  let tp = 0, fn = 0, tn = 0, fp = 0; const harms = [], leaks = [];
  pairs.forEach((p, i) => {
    if (UNCLEAR.has(i)) return;
    const bad = invented(p.orig, p.rewrite, rule), rej = bad.length > 0, fab = !FAITHFUL.has(i);
    if (fab && rej) tp++; else if (fab) { fn++; leaks.push(i + ' "' + p.orig.slice(0, 40) + '" → "' + p.rewrite.slice(0, 40) + '"'); }
    else if (!rej) tn++; else { fp++; harms.push(i + ' "' + p.orig.slice(0, 40) + '" → "' + p.rewrite.slice(0, 40) + '" [' + bad.join(',') + ']'); }
  });
  console.log('\ncontent = ' + (rule === 'mean' ? 'above the rewrite\'s mean' : 'top ' + (100 - rule * 100) + '% of his vocabulary') +
    '   fabricated caught ' + tp + '/' + (tp + fn) + '   faithful kept ' + tn + '/' + (tn + fp));
  if (rule === 'mean' || rule === 0.05) {
    console.log('  faithful refused: ' + (harms.join('\n                    ') || '-'));
    console.log('  fabrications through: ' + (leaks.join('\n                        ') || '-'));
  }
}
