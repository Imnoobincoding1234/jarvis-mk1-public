'use strict';
// ---------------------------------------------------------------------------
// The web agent's contract — ONE definition for training (finetune/build_v4_data.js) and for the live
// JARVIS, so the model sees in use exactly what it was trained on (2026-10-02, v4).
//
// A turn: the TASK, what has been done so far, and the PAGE as snapshot.js's numbered outline — cut to an
// EXCERPT (a 4B on an 8 GB Mac cannot read a 300-control page each step). The model answers with ONE action
// in a small grammar; parseAction() reads it back and refuses anything outside the grammar. The excerpt
// policy is the same function in both places: the controls whose names share the most words with the task
// and the steps so far, their neighbours in page order, then the earliest controls on the page — plus, in
// training only, the control the person actually used (else there is nothing to learn).
//
// Word overlap here is TOKEN MATCHING between his task and the page's own labels — no word list of ours.
// ---------------------------------------------------------------------------

const H = require('./htmlparse');
const S = require('./snapshot');

const SYSTEM = [
  'You are JARVIS, operating a web page for the user. Each turn you get the TASK, the steps done so far, and the PAGE as a numbered outline.',
  'Reply with exactly ONE action, nothing else:',
  'click [N]',
  'type [N] "text"',
  'select [N] "option"',
  'go "https://…"',
  'scroll down',
  'scroll up',
  'back',
  'done "what was found or achieved"',
  'ask "a question for the user"',
  'Use only numbers that are on the PAGE. Type only text that comes from the TASK. Never type a password, OTP or card number — ask instead.',
].join('\n');

const ACTION_RE = /^\s*(?:(click|hover)\s*\[(\d+)\]|(type|select)\s*\[(\d+)\]\s*"((?:[^"\\]|\\.)*)"|(go|done|ask)\s*"((?:[^"\\]|\\.)*)"|(scroll)\s+(down|up)|(back))\s*$/i;
// The model's reply → { op, index?, value? } or { error }. One action, the grammar only.
function parseAction(text, count) {
  const line = String(text || '').trim().split('\n')[0];
  const m = ACTION_RE.exec(line);
  if (!m) return { error: 'not an action: ' + line.slice(0, 80) };
  const un = s => s.replace(/\\(.)/g, '$1');
  let a;
  if (m[1]) a = { op: m[1].toLowerCase() === 'hover' ? 'click' : 'click', index: Number(m[2]) };
  else if (m[3]) a = { op: m[3].toLowerCase(), index: Number(m[4]), value: un(m[5]) };
  else if (m[6]) a = { op: m[6].toLowerCase(), value: un(m[7]) };
  else if (m[8]) a = { op: 'scroll', value: m[9].toLowerCase() };
  else a = { op: 'back' };
  if (a.index != null && count != null && !(a.index >= 0 && a.index < count)) return { error: 'no control [' + a.index + '] on the page' };
  if (a.op === 'go' && !/^https?:\/\//i.test(a.value)) return { error: 'go needs a full http(s) address' };
  return a;
}
const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function formatAction(a) {
  if (a.op === 'click') return 'click [' + a.index + ']';
  if (a.op === 'type' || a.op === 'select') return a.op + ' [' + a.index + '] ' + q(a.value);
  if (a.op === 'go' || a.op === 'done' || a.op === 'ask') return a.op + ' ' + q(a.value);
  if (a.op === 'scroll') return 'scroll ' + a.value;
  return 'back';
}
// what was done, in words that survive the page changing (numbers do not)
function describeStep(a, name) {
  if (a.op === 'click') return 'click ' + q(name || '?');
  if (a.op === 'type' || a.op === 'select') return a.op + ' ' + q(a.value) + ' into ' + q(name || '?');
  return formatAction(a);
}
function userMessage(task, history, outline) {
  return 'TASK: ' + task + '\nDONE SO FAR:\n' + (history && history.length ? history.map((h, i) => (i + 1) + '. ' + h).join('\n') : 'nothing yet') + '\nPAGE:\n' + outline;
}

// ---------------- the excerpt ----------------
const toks = s => new Set(String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3));
function elText(it) { return [S.nameOf(it), it.fname, it.value, (it.options || []).join(' '), it.placeholder].filter(Boolean).join(' '); }
function excerpt(items, opts) {
  opts = opts || {};
  const max = opts.max || 40, want = toks((opts.task || '') + ' ' + (opts.history || []).join(' '));
  const els = items.filter(it => it.k === 'el');
  const pos = new Map(els.map((e, i) => [e.i, i]));
  const chosen = new Set(opts.keep || []);
  const scored = els.map(e => { const t = toks(elText(e)); let s = 0; for (const w of t) if (want.has(w)) s++; return { e, s }; })
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s || pos.get(a.e.i) - pos.get(b.e.i));
  for (const x of scored) { if (chosen.size >= Math.ceil(max * 0.45)) break; chosen.add(x.e.i); }
  for (const i of [...chosen]) { const p = pos.get(i); if (p == null) continue; for (const d of [-2, -1, 1, 2]) { const n = els[p + d]; if (n && chosen.size < Math.ceil(max * 0.8)) chosen.add(n.i); } }
  for (const e of els) { if (chosen.size >= max) break; chosen.add(e.i); }
  // keep structure only where something is shown; skipped runs of controls become one "…"
  const out = [];
  for (const it of items) {
    if (it.k === 'el') { if (chosen.has(it.i)) out.push(it); else if (!out.length || out[out.length - 1].k !== 'gap') out.push({ k: 'gap' }); continue; }
    out.push(it);
  }
  // drop headings with nothing shown under them, and landmarks with nothing shown inside
  const shown = it => it.k === 'el' || it.k === 'text';
  let changed = true, cur = out;
  while (changed) {
    changed = false; const nx = [];
    for (let i = 0; i < cur.length; i++) {
      const it = cur[i];
      if (it.k === 'heading') { let j = i + 1; while (j < cur.length && (cur[j].k === 'gap')) j++; if (j >= cur.length || !shown(cur[j])) { changed = true; continue; } }
      if (it.k === 'open') { let d = 0, has = false, j = i; for (; j < cur.length; j++) { if (cur[j].k === 'open') d++; else if (cur[j].k === 'close') { if (--d === 0) break; } else if (shown(cur[j])) has = true; }
        if (!has) { if (!nx.length || nx[nx.length - 1].k !== 'gap') nx.push({ k: 'gap' }); i = j; changed = true; continue; } }
      if (it.k === 'gap' && nx.length && nx[nx.length - 1].k === 'gap') { changed = true; continue; }
      nx.push(it);
    }
    cur = nx;
  }
  return { items: cur, shown: [...chosen].filter(i => pos.has(i)) };
}
function outline(meta, items, opts) { return S.format(meta, items, { maxChars: (opts && opts.maxChars) || 4000 }); }

// ---------------- Mind2Web's recorded pages ----------------
// Their DOM dumps keep each node's box (bounding_box_rect "x,y,w,h") and an is_clickable flag but no hrefs;
// a control is what the live rules would number, with the flag standing in for href / onclick.
const CTL_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
const CTL_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'switch', 'checkbox', 'radio', 'textbox', 'combobox', 'searchbox']);
function boxOf(el) { const b = String(el.attrs.bounding_box_rect || '').split(',').map(Number); return b.length === 4 && b.every(Number.isFinite) ? b : null; }
function m2wPage(rawHtml, meta) {
  const doc = H.parse(rawHtml);
  const isHidden = el => {
    if (el.tag === 'option') return false;                                  // options live inside their select
    if (String(el.attrs.type || '').toLowerCase() === 'hidden') return true;
    const b = boxOf(el); if (!b) return CTL_TAGS.has(el.tag);               // a control with no box was not on screen
    return !(b[2] > 0 && b[3] > 0);
  };
  const isControl = el => el.type === 'el' && el.tag !== 'option' && (CTL_TAGS.has(el.tag) || CTL_ROLES.has(el.attrs.role) || el.attrs.is_clickable === 'true');
  const r = S.fromParsed(doc, meta || { url: '', title: '' }, { isControl, isHidden, isPruned: el => String(el.attrs.type || '').toLowerCase() === 'hidden', maxChars: 1e9 });
  const byId = new Map(); for (const el of r.elements) if (el.attrs.backend_node_id) byId.set(el.attrs.backend_node_id, r.indexOf(el));
  // a target that is not itself numbered (a <span> inside a link): its nearest numbered ancestor
  r.indexOfNode = id => { if (byId.has(id)) return byId.get(id); for (const el of H.walk(doc)) if (el.attrs.backend_node_id === id) { for (let p = el.parent; p && p.type === 'el'; p = p.parent) { const k = r.indexOf(p); if (k != null) return k; } return null; } return null; };
  return r;
}

module.exports = { SYSTEM, parseAction, formatAction, describeStep, userMessage, excerpt, outline, m2wPage, ACTION_RE };
