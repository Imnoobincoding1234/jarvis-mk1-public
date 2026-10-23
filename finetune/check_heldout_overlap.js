// Overlap check for the fresh grounded-check held-out (build_check_heldout_v42.js): every item against every earlier question in finetune/data.
// Exact (normalised) matches are hard failures; any candidate sharing a RARE token (document frequency ≤ 6 across the
// whole prior corpus — decided by counting, not by a list) with a prior line is printed for me to read.
const fs = require('fs');
const path = require('path');
const D = p => path.join(__dirname, 'data', p);
const prior = [];   // { src, text }
function walk(v, src, key) {
  if (typeof v === 'string') { if (['q', 'hi', 'query', 'text', 'page'].includes(key)) prior.push({ src, text: v }); return; }
  if (Array.isArray(v)) { v.forEach(x => typeof x === 'string' ? prior.push({ src, text: x }) : walk(x, src, key)); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'source') continue; walk(x, src, k); }
}
// the set being checked must not be matched against its own output file
const OWN = process.argv[2] && /heldout2/.test(process.argv[2]) ? 'v42_check_heldout2.json' : 'v42_check_heldout.json';
const jsonFiles = fs.readdirSync(D('')).filter(f => /\.json$/.test(f) && !/^(wiki_cache|style)/.test(f) && f !== OWN);
for (const f of jsonFiles) { try { walk(JSON.parse(fs.readFileSync(D(f), 'utf8')), f, ''); } catch (e) { console.log('skip', f, e.message); } }
for (const f of fs.readdirSync(D('')).filter(f => /\.jsonl$/.test(f))) {
  for (const l of fs.readFileSync(D(f), 'utf8').split('\n').filter(Boolean)) { try { walk(JSON.parse(l), f, ''); } catch (e) {} }
}
// every user turn of every Bonsai training/valid set (the question line of grounded rows, the whole message otherwise)
for (const dir of fs.readdirSync(D('')).filter(d => /^bonsai_jarvis/.test(d))) {
  for (const f of ['train.jsonl', 'valid.jsonl']) {
    const p = D(path.join(dir, f)); if (!fs.existsSync(p)) continue;
    for (const l of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      let r; try { r = JSON.parse(l); } catch (e) { continue; }
      for (const m of r.messages || []) if (m.role === 'user') {
        const c = String(m.content);
        const qi = c.indexOf('QUESTION: ');
        prior.push({ src: dir + '/' + f, text: qi >= 0 ? c.slice(qi + 10, c.indexOf('\n', qi) > 0 ? c.indexOf('\n', qi) : undefined) : c.slice(0, 300) });
      }
    }
  }
}
// the seven live questions of 2026-10-08 (from the handoff)
for (const t of ['who wrote dracula bram stoker', 'who is the ceo of blackrock', 'what is the capital of sikkim gangtok',
  'who discovered penicillin alexander fleming', 'who won the 2011 world cup india', 'hawa mahal kisne banwaya', 'how tall is mount everest'])
  prior.push({ src: 'live-2026-10-08', text: t });

const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const toks = s => norm(s).split(' ').filter(Boolean);
const df = new Map();
for (const p of prior) for (const t of new Set(toks(p.text))) df.set(t, (df.get(t) || 0) + 1);
const exact = new Set(prior.map(p => norm(p.text)));
const C = require(process.argv[2] ? path.resolve(process.argv[2]) : './build_check_heldout_v42.js').ITEMS;   // node check_heldout_overlap.js [builder.js]
console.log('prior lines', prior.length, 'from', new Set(prior.map(p => p.src)).size, 'sources');
let hard = 0;
for (const c of C) {
  const n = norm(c.q);
  if (exact.has(n)) { hard++; console.log('EXACT  ', c.q, '←', prior.filter(p => norm(p.text) === n).map(p => p.src).join(', ')); continue; }
  const rare = toks(c.q).concat(c.page ? toks(c.page) : []).filter(t => (df.get(t) || 0) <= 6 && (df.get(t) || 0) > 0);
  if (!rare.length) continue;
  const hits = prior.filter(p => toks(p.text).some(t => rare.includes(t)));
  console.log('RARE   ', JSON.stringify(c.q), '[' + rare.join(',') + ']');
  for (const h of hits.slice(0, 6)) console.log('          ', h.src, '|', h.text.replace(/\s+/g, ' ').slice(0, 110));
}
console.log('exact hits', hard, 'of', C.length);
