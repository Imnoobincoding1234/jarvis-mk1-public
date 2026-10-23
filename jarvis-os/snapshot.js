'use strict';
// ---------------------------------------------------------------------------
// Page snapshot — a compact, numbered outline of a page for a model to act on (Stagehand's idea, rebuilt).
//
// browser.js already numbers the clickable things (ENUM_CORE) and its click/fill tools act on those
// numbers. What a model lacks there is CONTEXT: a bare list of 300 labels does not say that "Continue"
// sits inside the "Sign in" dialog, that the box is the search form's, or that the checkbox is already
// ticked. The snapshot keeps browser.js's numbers EXACTLY (same enumeration, same order, overlay first)
// and lays them out in the page's structure — dialogs, forms, landmarks, headings — with each element's
// role, name and state:
//
//   URL https://example.com/signup
//   TITLE Sign up
//   [dialog "Cookies"]
//     [0] button "Accept"
//   # Create your account
//   [form "Sign up"]
//     [4] textbox "Your name" required
//     [5] combobox "City" = "Delhi" {Pick, Kolhapur, Delhi}
//     [6] checkbox "Send me news" checked
//     [7] button "Save"
//
// ONE FORMAT, TWO SOURCES: Brave pages (the raw facts gathered by page JS, numbered by ENUM_CORE) and
// websession pages (the same facts read from the parsed HTML). Role and name are computed HERE, once, in
// Node — the page side only reports facts, so the two can never drift apart. The v4 web-action model is
// trained on exactly this text, so what it sees in training is what it sees live.
// Roles are HTML-AAM's implicit roles and names follow the accessible-name order — standards, not word lists.
// ---------------------------------------------------------------------------

const H = require('./htmlparse');

// HTML-AAM implicit roles for the controls we number
function roleOf(f) {
  if (f.role) return f.role;
  const t = f.tag, ty = String(f.type || '').toLowerCase();
  if (t === 'a') return 'link';
  if (t === 'button') return 'button';
  if (t === 'select') return f.multiple ? 'listbox' : 'combobox';
  if (t === 'textarea') return 'textbox';
  if (t === 'input') {
    if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
    if (ty === 'checkbox' || ty === 'radio') return ty;
    if (ty === 'search') return 'searchbox';
    if (ty === 'range') return 'slider';
    if (ty === 'number') return 'spinbutton';
    if (ty === 'file') return 'file';
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(ty)) return ty;
    return 'textbox';
  }
  return t;
}
// accessible name, in the spec's order: aria-labelledby, aria-label, <label>, content, value, alt, title, placeholder
function nameOf(f) {
  const c = [f.labelledby, f.ariaLabel, f.label, f.tag === 'input' || f.tag === 'select' || f.tag === 'textarea' ? '' : f.text,
    ['submit', 'button', 'reset'].includes(String(f.type || '').toLowerCase()) ? f.value : '', f.alt, f.title, f.placeholder];
  for (const x of c) { const s = String(x || '').replace(/\s+/g, ' ').trim(); if (s) return s.slice(0, 80); }
  return '';
}
const q = s => '"' + String(s).replace(/"/g, "'") + '"';
function stateOf(f, role) {
  const out = [];
  if (['textbox', 'searchbox', 'spinbutton', 'slider', 'date', 'time', 'datetime-local', 'month', 'week'].includes(role) && f.value) out.push('= ' + q(String(f.value).slice(0, 60)));
  if (role === 'combobox' || role === 'listbox') {
    if (f.current && f.current.length) out.push('= ' + q(f.current.join(', ').slice(0, 60)));
    if (f.options && f.options.length) out.push('{' + f.options.slice(0, 10).map(o => String(o).slice(0, 30)).join(', ') + (f.options.length > 10 ? ', …+' + (f.options.length - 10) : '') + '}');
  }
  if (f.checked) out.push('checked');
  if (f.disabled) out.push('disabled');
  if (f.required) out.push('required');
  if (f.expanded === 'true') out.push('expanded');
  if (f.expanded === 'false') out.push('collapsed');
  if (f.selected === 'true') out.push('selected');
  if (f.host) out.push('→ ' + f.host);
  return out.join(' ');
}

// Raw items, in document order (overlays first): { k:'open'|'close'|'heading'|'el'|'text', … } → the outline text.
function format(meta, items, opts) {
  opts = opts || {};
  const max = opts.maxChars || 8000;
  const lines = ['URL ' + meta.url, 'TITLE ' + (meta.title || '')];
  let depth = 0, used = lines.join('\n').length, cut = 0;
  const push = l => { const s = '  '.repeat(depth) + l; if (used + s.length + 1 > max) { cut++; return; } lines.push(s); used += s.length + 1; };
  for (const it of items) {
    if (it.k === 'open') { push('[' + it.role + (it.name ? ' ' + q(it.name.slice(0, 60)) : '') + ']'); depth++; continue; }
    if (it.k === 'close') { depth = Math.max(0, depth - 1); continue; }
    if (it.k === 'heading') { push('#'.repeat(Math.min(3, it.level || 1)) + ' ' + String(it.text).replace(/\s+/g, ' ').trim().slice(0, 100)); continue; }
    if (it.k === 'gap') { push('…'); continue; }                     // an excerpt skipped controls here
    if (it.k === 'text') { push('· ' + String(it.text).replace(/\s+/g, ' ').trim().slice(0, 140)); continue; }
    // no accessible name: the control's form name, in parentheses, so the model still knows which box it is
    if (it.k === 'el') { const role = roleOf(it), name = nameOf(it); push('[' + it.i + '] ' + role + (name ? ' ' + q(name) : it.fname ? ' (' + String(it.fname).slice(0, 40) + ')' : '') + (stateOf(it, role) ? ' ' + stateOf(it, role) : '')); }
  }
  if (cut) lines.push('… ' + cut + ' more lines not shown');
  return lines.join('\n');
}

// ---------------- from parsed HTML (websession pages, and v4 training pages) ----------------
// The same selector and the same overlay-first order as browser.js ENUM_CORE.
const SEL = 'a[href],button,input,select,textarea,[role=button],[onclick],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=switch],[role=checkbox],[role=radio],[role=link]';
const OVERLAY = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[aria-modal=true],dialog[open]';
const LANDMARK = { form: 'form', nav: 'navigation', main: 'main', dialog: 'dialog', header: 'banner', footer: 'contentinfo', aside: 'complementary', table: 'table', ul: null, ol: null };
const LANDMARK_ROLES = new Set(['dialog', 'alertdialog', 'menu', 'listbox', 'navigation', 'main', 'form', 'search', 'banner', 'contentinfo', 'complementary', 'region', 'tablist']);
function hiddenElDefault(el) {
  for (let p = el; p && p.type === 'el'; p = p.parent) {
    const a = p.attrs;
    if ('hidden' in a || a['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '')) return true;
    if (p.tag === 'template' || p.tag === 'noscript' || p.tag === 'head') return true;
  }
  return String(el.attrs.type || '').toLowerCase() === 'hidden';
}
function factsOf(el, doc) {
  const a = el.attrs, f = { tag: el.tag, type: a.type || '', role: a.role || '', ariaLabel: a['aria-label'] || '', title: a.title || '', alt: a.alt || '',
    placeholder: a.placeholder || '', value: a.value || '', fname: a.name || '', disabled: 'disabled' in a || a['aria-disabled'] === 'true', required: 'required' in a,
    checked: 'checked' in a || a['aria-checked'] === 'true', expanded: a['aria-expanded'] || '', selected: a['aria-selected'] || '' };
  if (a['aria-labelledby']) f.labelledby = a['aria-labelledby'].split(/\s+/).map(id => { const x = H.select(doc, '[id="' + id.replace(/"/g, '') + '"]'); return x ? H.text(x) : ''; }).join(' ');
  if (a.id) { const l = H.selectAll(doc, 'label[for]').find(x => x.attrs.for === a.id); if (l) f.label = H.text(l); }
  if (!f.label) { const w = H.closest(el, x => x.tag === 'label'); if (w && w !== el) f.label = H.text(w); }
  f.text = el.tag === 'textarea' ? '' : H.text(el);
  if (el.tag === 'textarea') f.value = H.text(el, { raw: true });
  if (el.tag === 'select') {
    const os = H.selectAll(el, 'option'); f.multiple = 'multiple' in a;
    f.options = os.map(o => H.text(o) || o.attrs.value || '');
    const sel = os.filter(o => 'selected' in o.attrs); f.current = (sel.length ? sel : os.slice(0, 1)).map(o => H.text(o));
  }
  if (el.tag === 'a') { try { const u = new URL(a.href, doc.__base || 'http://x/'); if (doc.__host && u.hostname !== doc.__host) f.host = u.hostname.replace(/^www\./, ''); } catch (e) {} }
  return f;
}
// opts.isControl / opts.isHidden replace the live rules for pages recorded elsewhere (Mind2Web's DOM dumps carry
// no hrefs but do carry a clickable flag and each node's box) — the OUTPUT format is the same either way.
function fromParsed(doc, meta, opts) {
  opts = opts || {};
  try { doc.__host = new URL(meta.url).hostname; doc.__base = meta.url; } catch (e) {}
  const sel = H.parseSelector(SEL), ov = H.parseSelector(OVERLAY);
  const isCtl = opts.isControl || (e => H.matches(e, sel));
  const hiddenEl = opts.isHidden || hiddenElDefault;
  // which subtrees the OUTLINE skips: hidden ones live; for recorded pages a zero-size box can still hold visible children
  const pruned = opts.isPruned || hiddenEl;
  // numbering: overlay contents first, then the rest — as ENUM_CORE does
  const all = [...H.walk(doc)];
  const numbered = new Map();
  const take = el => { if (numbered.has(el) || numbered.size >= 300) return; if (String(el.attrs.type || '').toLowerCase() === 'password' || hiddenEl(el)) return; numbered.set(el, numbered.size); };
  for (const o of all.filter(e => H.matches(e, ov) && !hiddenEl(e))) for (const e of [...H.walk(o)]) if (isCtl(e)) take(e);
  for (const e of all) if (isCtl(e)) take(e);
  // outline: overlays first, then the document
  const items = [];
  const overlays = all.filter(e => H.matches(e, ov) && !hiddenEl(e) && !(e.parent && H.closest(e.parent, x => x.type === 'el' && H.matches(x, ov))));
  const visit = (el, inOverlayPass) => {
    if (el.type === 'text') return;
    if (el.type === 'el' && pruned(el) && !numbered.has(el)) return;
    if (!inOverlayPass && overlays.includes(el)) return;          // already shown at the top
    // a numbered control is listed, and its children are still visited: a link inside a clickable card is its own control
    if (el.type === 'el' && numbered.has(el)) items.push(Object.assign({ k: 'el', i: numbered.get(el) }, factsOf(el, doc)));
    if (el.type === 'el' && /^h[1-3]$/.test(el.tag)) { const t = H.text(el); if (t) items.push({ k: 'heading', level: Number(el.tag[1]), text: t }); return; }
    const lm = el.type === 'el' ? (LANDMARK_ROLES.has(el.attrs.role) ? el.attrs.role : LANDMARK[el.tag]) : null;
    if (lm) items.push({ k: 'open', role: lm, name: el.attrs['aria-label'] || (lm === 'form' ? (el.attrs.name || el.attrs.id || '') : '') });
    if (opts && opts.text && el.type === 'el' && el.tag === 'p') { const t = H.text(el); if (t && t.length <= 200) items.push({ k: 'text', text: t }); }
    // inside a form, a short bit of text with no control in it is how many forms label their boxes
    if (el.type === 'el' && !lm && el.tag !== 'label' && H.closest(el, x => x.tag === 'form') && !(el.children || []).some(c => c.type === 'el') && !numbered.has(el)) {
      const t = H.text(el); if (t && t.length <= 60) items.push({ k: 'text', text: t });
    }
    for (const c of el.children || []) visit(c, inOverlayPass);
    if (lm) items.push({ k: 'close' });
  };
  for (const o of overlays) visit(o, true);
  visit(doc, false);
  // drop empty landmarks (an open followed straight by its close)
  const tidy = [];
  for (const it of items) { if (it.k === 'close' && tidy.length && tidy[tidy.length - 1].k === 'open') { tidy.pop(); continue; } tidy.push(it); }
  return { text: format(meta, tidy, opts), items: tidy, count: numbered.size, elements: [...numbered.keys()], indexOf: el => numbered.get(el) };
}
// a websession page
const ofPage = (page, opts) => fromParsed(page.doc, { url: page.url, title: page.title }, opts);

// ---------------- in Brave: page JS that reports FACTS, numbered by browser.js's own ENUM_CORE ----------------
// buildPageJs(ENUM_CORE) → a script whose result is { url, title, items } for format().
function buildPageJs(ENUM_CORE) {
  return `(function(){
${ENUM_CORE}
  var idx = new Map(); for (var n = 0; n < out.length; n++) idx.set(out[n], n);
  var OV = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[aria-modal=true],dialog[open]';
  var LM = {FORM:'form', NAV:'navigation', MAIN:'main', DIALOG:'dialog', HEADER:'banner', FOOTER:'contentinfo', ASIDE:'complementary', TABLE:'table'};
  var LMR = {dialog:1, alertdialog:1, menu:1, listbox:1, navigation:1, main:1, form:1, search:1, banner:1, contentinfo:1, complementary:1, region:1, tablist:1};
  var items = [], budget = 2500;
  function txt(e){ return String(e.innerText || e.textContent || '').replace(/\\s+/g,' ').trim().slice(0,120); }
  function facts(el, i){
    var f = {k:'el', i:i, tag: el.tagName.toLowerCase(), type: String(el.type || el.getAttribute('type') || ''), role: String(el.getAttribute('role') || ''),
      ariaLabel: String(el.getAttribute('aria-label') || ''), title: String(el.title || ''), alt: String(el.getAttribute('alt') || ''),
      placeholder: String(el.getAttribute('placeholder') || ''), fname: String(el.getAttribute('name') || ''), value: (el.tagName === 'SELECT') ? '' : String(el.value == null ? '' : el.value).slice(0,80),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', required: !!el.required,
      checked: !!el.checked || el.getAttribute('aria-checked') === 'true', expanded: String(el.getAttribute('aria-expanded') || ''), selected: String(el.getAttribute('aria-selected') || '')};
    var lb = el.getAttribute('aria-labelledby'); if (lb) f.labelledby = lb.split(/\\s+/).map(function(id){ var x = document.getElementById(id); return x ? txt(x) : ''; }).join(' ');
    if (el.labels && el.labels.length) f.label = txt(el.labels[0]);
    f.text = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') ? '' : txt(el);
    if (el.tagName === 'SELECT') { f.multiple = el.multiple; f.options = Array.prototype.slice.call(el.options, 0, 11).map(function(o){ return o.text; });
      if (el.options.length > 11) f.options.push('…'); f.current = Array.prototype.slice.call(el.selectedOptions || []).map(function(o){ return o.text; }); }
    if (el.tagName === 'A' && el.hostname && el.hostname !== location.hostname) f.host = el.hostname.replace(/^www\\./,'');
    return f;
  }
  function vis(el){ if (el.nodeType !== 1) return false; var s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; }
  var overlays = Array.prototype.slice.call(document.querySelectorAll(OV)).filter(function(o){ return __vis(o) && !(o.parentElement && o.parentElement.closest(OV)); });
  function visit(el, ovPass){
    if (budget-- <= 0) return;
    if (el.nodeType !== 1 || !vis(el)) return;
    if (!ovPass && overlays.indexOf(el) >= 0) return;
    if (idx.has(el)) items.push(facts(el, idx.get(el)));
    if (/^H[1-3]$/.test(el.tagName)) { var t = txt(el); if (t) items.push({k:'heading', level: Number(el.tagName[1]), text: t}); return; }
    var r = el.getAttribute('role'), lm = (r && LMR[r]) ? r : LM[el.tagName];
    if (!lm && el.tagName !== 'LABEL' && !el.firstElementChild && el.closest('form')) { var tt = txt(el); if (tt && tt.length <= 60) items.push({k:'text', text: tt}); }
    if (lm) items.push({k:'open', role: lm, name: String(el.getAttribute('aria-label') || (lm === 'form' ? (el.getAttribute('name') || el.id || '') : ''))});
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) visit(c, ovPass);
    if (el.shadowRoot) for (var s = el.shadowRoot.firstElementChild; s; s = s.nextElementSibling) visit(s, ovPass);
    if (lm) items.push({k:'close'});
  }
  overlays.forEach(function(o){ visit(o, true); });
  visit(document.body, false);
  return JSON.stringify({url: location.href, title: document.title, items: items, count: out.length, hasPassword: hasPassword});
})()`;
}
function fromBrave(raw, opts) {
  const tidy = [];
  for (const it of raw.items || []) { if (it.k === 'close' && tidy.length && tidy[tidy.length - 1].k === 'open') { tidy.pop(); continue; } tidy.push(it); }
  return { text: format({ url: raw.url, title: raw.title }, tidy, opts), count: raw.count };
}

module.exports = { format, roleOf, nameOf, fromParsed, ofPage, buildPageJs, fromBrave, SEL, OVERLAY };
