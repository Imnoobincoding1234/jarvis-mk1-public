#!/usr/bin/env node
// v4.2 FRESH web held-out, 2026-10-05 — written BEFORE any v4.2 training row. v4 and v4.1 web held-outs were scored and
// their misses were read, so v4.2 is judged on a new sample: Mind2Web's own test splits (unseen WEBSITES and unseen
// DOMAINS), a different seed, and no task that is in data/v4_web_heldout.jsonl. Never trained (Mind2Web's splits are
// disjoint from train; the v4.1 builder also drops any matching task).
// rowOf/stepWords are build_v4_web.js's, copied unchanged so the rows are byte-for-byte the same format.
//   node build_v42_web_heldout.js → data/v42_web_heldout.jsonl  (excludes every task in v4_ and v41_web_heldout)
const fs = require('fs');
const path = require('path');
const M = require('./m2w_stream');
const A = require('../jarvis-os/webagent');

let seed = 42042;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const DIR = path.join(__dirname, 'data', 'external_web', 'mind2web');

function stepWords(repr) {
  const m = /^\[([^\]]*)\]\s*(.*?)\s*->\s*(CLICK|TYPE|SELECT|HOVER)(?::\s*(.*))?$/.exec(String(repr).trim());
  if (!m) return null;
  const name = m[2].replace(/\s+/g, ' ').trim().slice(0, 60) || m[1];
  if (m[3] === 'TYPE' || m[3] === 'SELECT') return A.describeStep({ op: m[3].toLowerCase(), value: (m[4] || '').trim() }, name);
  return A.describeStep({ op: 'click' }, name);
}
const siteUrl = t => 'https://www.' + String(t.website).replace(/\s+/g, '') + '.com/';
function rowOf(t, k) {
  const a = t.actions[k];
  const id = a.pos_candidates && a.pos_candidates[0] && a.pos_candidates[0].backend_node_id;
  if (!id) return { skip: 'no target recorded' };
  const meta = { url: siteUrl(t), title: '' };
  let pg; try { pg = A.m2wPage(a.raw_html, meta); } catch (e) { return { skip: 'page did not parse' }; }
  const ix = pg.indexOfNode(id);
  if (ix == null) return { skip: 'target not a visible control (or past the 300 cap)' };
  const history = t.action_reprs.slice(0, k).map(stepWords).filter(Boolean);
  let outline = null;
  for (const max of [40, 30, 22, 15, 10]) {
    const ex = A.excerpt(pg.items, { task: t.confirmed_task, history, keep: [ix], max });
    const o = A.outline(meta, ex.items, { maxChars: 3600 });
    if (new RegExp('^\\s*\\[' + ix + '\\] ', 'm').test(o)) { outline = o; break; }
  }
  if (!outline) return { skip: 'target cut from the excerpt by the size cap' };
  const op = String(a.operation.op).toLowerCase();
  const act = op === 'type' || op === 'select' ? { op, index: ix, value: a.operation.value } : { op: 'click', index: ix };
  if ((op === 'type' || op === 'select') && !String(a.operation.value || '').trim()) return { skip: 'empty value' };
  return { task: t.confirmed_task, website: t.website, domain: t.domain, history, outline, answer: A.formatAction(act), target: ix, op: act.op, value: act.value };
}

(async () => {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const old = new Set(['v4_web_heldout.jsonl', 'v41_web_heldout.jsonl'].flatMap(f => fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').split('\n').filter(Boolean).map(l => norm(JSON.parse(l).task))));
  const skips = {}, held = [];
  const files = [...Array(2).keys()].map(i => 'test_website/test_website_' + i + '.json').concat([...Array(10).keys()].map(i => 'test_domain/test_domain_' + i + '.json'));
  for (const f of files) {
    const split = f.split('/')[0];
    for await (const t of M.fromZip(path.join(DIR, 'test.zip'), f, 'mind2web')) {
      if (rnd() > (split === 'test_website' ? 0.17 : 0.045)) continue;
      if (old.has(norm(t.confirmed_task))) { skips['task in an earlier held-out'] = (skips['task in an earlier held-out'] || 0) + 1; continue; }
      const ks = [...t.actions.keys()].sort(() => rnd() - 0.5).slice(0, 2);
      for (const k of ks) { const r = rowOf(t, k); if (r.skip) { skips[r.skip] = (skips[r.skip] || 0) + 1; continue; } held.push(Object.assign({ split, step: k }, r)); }
    }
    process.stdout.write(f + ' → ' + held.length + '\n');
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'v42_web_heldout.jsonl'), held.map(r => JSON.stringify(r)).join('\n') + '\n');
  const by = (k) => held.reduce((o, r) => (o[r[k]] = (o[r[k]] || 0) + 1, o), {});
  console.log(JSON.stringify({ heldout: held.length, splits: by('split'), ops: by('op'), websites: Object.keys(by('website')).length, skips }));
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
