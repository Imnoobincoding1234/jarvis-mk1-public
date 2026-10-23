#!/usr/bin/env node
// v4 web-action rows, 2026-10-02 — Mind2Web (CC BY 4.0) steps in JARVIS's OWN format (jarvis-os/webagent.js +
// snapshot.js): the task, the steps so far, the page as a numbered outline excerpt → ONE action.
//   train   : data/external_web/mind2web/data/train/train_*.json — up to 2 steps a task, seeded
//   held-out: Mind2Web's own test splits (unseen WEBSITES and unseen DOMAINS), never trained — data/v4_web_heldout.jsonl
// Plus MolmoWeb (ODC-BY) start rows: the high-level task on a blank page → go "<the site the person opened>".
//   node build_v4_web.js → data/v4_parts/web_train.jsonl, web_valid.jsonl, molmo_start.jsonl; data/v4_web_heldout.jsonl
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('./m2w_stream');
const A = require('../jarvis-os/webagent');
const S = require('../jarvis-os/snapshot');

let seed = 4040;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const DIR = path.join(__dirname, 'data', 'external_web', 'mind2web');
const OUT = path.join(__dirname, 'data', 'v4_parts');
fs.mkdirSync(OUT, { recursive: true });

// "[link]  NFL . -> CLICK" / "[textbox]  From -> TYPE: Shanghai" → the step in our words
function stepWords(repr) {
  const m = /^\[([^\]]*)\]\s*(.*?)\s*->\s*(CLICK|TYPE|SELECT|HOVER)(?::\s*(.*))?$/.exec(String(repr).trim());
  if (!m) return null;
  const name = m[2].replace(/\s+/g, ' ').trim().slice(0, 60) || m[1];
  if (m[3] === 'TYPE' || m[3] === 'SELECT') return A.describeStep({ op: m[3].toLowerCase(), value: (m[4] || '').trim() }, name);
  return A.describeStep({ op: 'click' }, name);
}
const siteUrl = t => 'https://www.' + String(t.website).replace(/\s+/g, '') + '.com/';

// one Mind2Web step → { task, history, outline, answer, target, op } or null (with the reason)
function rowOf(t, k) {
  const a = t.actions[k];
  const id = a.pos_candidates && a.pos_candidates[0] && a.pos_candidates[0].backend_node_id;
  if (!id) return { skip: 'no target recorded' };
  const meta = { url: siteUrl(t), title: '' };
  let pg; try { pg = A.m2wPage(a.raw_html, meta); } catch (e) { return { skip: 'page did not parse' }; }
  const ix = pg.indexOfNode(id);
  if (ix == null) return { skip: 'target not a visible control (or past the 300 cap)' };
  const history = t.action_reprs.slice(0, k).map(stepWords).filter(Boolean);
  // the excerpt shrinks until the target fits the size cap — never drop a step because its control sits low on the page
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
const asMessages = r => ({ messages: [{ role: 'system', content: A.SYSTEM }, { role: 'user', content: A.userMessage(r.task, r.history, r.outline) }, { role: 'assistant', content: r.answer }] });

(async () => {
  const skips = {};
  const note = s => { skips[s] = (skips[s] || 0) + 1; };
  // ---- held-out first: Mind2Web's test splits, 2 steps from each sampled task ----
  const held = [];
  const testFiles = [...Array(2).keys()].map(i => 'test_website/test_website_' + i + '.json').concat([...Array(10).keys()].map(i => 'test_domain/test_domain_' + i + '.json'));
  for (const f of testFiles) {
    const split = f.split('/')[0];
    for await (const t of M.fromZip(path.join(DIR, 'test.zip'), f, 'mind2web')) {
      if (rnd() > (split === 'test_website' ? 0.17 : 0.035)) continue;           // ~30 tasks from each split
      const ks = [...t.actions.keys()].sort(() => rnd() - 0.5).slice(0, 2);
      for (const k of ks) { const r = rowOf(t, k); if (r.skip) { note('held: ' + r.skip); continue; } held.push(Object.assign({ split, step: k }, r)); }
    }
    process.stdout.write('held-out ' + f + ' → ' + held.length + '\n');
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'v4_web_heldout.jsonl'), held.map(r => JSON.stringify(r)).join('\n') + '\n');

  // ---- training rows: every train task, up to 2 steps; 6% of TASKS go to validation (whole tasks, no leak) ----
  const train = [], valid = [];
  const files = fs.readdirSync(path.join(DIR, 'data', 'train')).filter(f => /^train_\d+\.json$/.test(f)).sort();
  for (const f of files) {
    for await (const t of M.fromFile(path.join(DIR, 'data', 'train', f))) {
      const toValid = rnd() < 0.06;
      const ks = [...t.actions.keys()].sort(() => rnd() - 0.5).slice(0, 2);
      for (const k of ks) { const r = rowOf(t, k); if (r.skip) { note('train: ' + r.skip); continue; } (toValid ? valid : train).push(r); }
    }
    process.stdout.write('train ' + f + ' → ' + train.length + ' / ' + valid.length + '\n');
  }
  fs.writeFileSync(path.join(OUT, 'web_train.jsonl'), train.map(r => JSON.stringify(Object.assign({ kind: 'web_' + r.op, website: r.website }, asMessages(r)))).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'web_valid.jsonl'), valid.map(r => JSON.stringify(Object.assign({ kind: 'web_' + r.op, website: r.website }, asMessages(r)))).join('\n') + '\n');

  // ---- MolmoWeb start rows: the HIGH-level task (no URL in it) on a blank page → go "<where the person started>" ----
  const molmo = [], seenHost = {};
  const mdir = path.join(__dirname, 'data', 'external_web', 'molmoweb');
  for (const f of fs.readdirSync(mdir).filter(x => x.endsWith('.jsonl.gz')).sort()) {
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(mdir, f))).toString('utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      if (rnd() > 0.05) continue;
      const r = JSON.parse(l), hi = r.instruction && r.instruction.high_level, s0 = r.steps[0];
      const m = s0 && /^goto\(url='([^']+)'\)/.exec(s0.action);
      if (!hi || !m || /https?:\/\//.test(hi)) continue;
      let host; try { host = new URL(m[1]).hostname; } catch (e) { continue; }
      if ((seenHost[host] = (seenHost[host] || 0) + 1) > 4) continue;            // no site more than 4 times
      molmo.push(Object.assign({ kind: 'web_go', website: host }, asMessages({ task: hi, history: [], outline: 'URL about:blank\nTITLE New Tab', answer: A.formatAction({ op: 'go', value: m[1] }) })));
    }
  }
  fs.writeFileSync(path.join(OUT, 'molmo_start.jsonl'), molmo.map(r => JSON.stringify(r)).join('\n') + '\n');

  const ops = {}; for (const r of train) ops[r.op] = (ops[r.op] || 0) + 1;
  const sites = new Set(train.map(r => r.website));
  console.log(JSON.stringify({ heldout: held.length, heldSplits: held.reduce((o, r) => (o[r.split] = (o[r.split] || 0) + 1, o), {}), train: train.length, valid: valid.length, ops, websites: sites.size,
    molmoStart: molmo.length, molmoHosts: Object.keys(seenHost).length, skips }, null, 1));
  process.exit(0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
