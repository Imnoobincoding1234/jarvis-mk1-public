'use strict';
// ---------------------------------------------------------------------------
// A small, forgiving HTML parser with CSS selectors — zero dependencies.
//
// WHY: JARVIS read pages with one regex (server.js htmlToText) that deletes tags. That is fine for
// prose and useless for ACTING: a form, its fields, which link sits in which list — all of that
// lives in the tree the regex throws away. MechanicalSoup (his roadmap #1) stands on BeautifulSoup;
// this is the BeautifulSoup half, rebuilt in Node so JARVIS stays zero-npm.
//
// What it does: tokenises real-world HTML (unquoted attributes, missing end tags, stray closers,
// raw-text elements) into a tree of { type:'el', tag, attrs, children, parent } and
// { type:'text', text } under a { type:'doc' } root, closing elements the way browsers do for the
// common cases (a new <p> closes the open <p>, <li> closes <li>, <td> closes <td>, a block closes
// an open <p>…). It is not the full WHATWG algorithm — no foster parenting, no adoption agency —
// and it does not need to be: the jobs are links, forms, tables and text.
//
// Selectors: tag, *, #id, .class, [attr], [attr=v], [attr~=v], [attr^=v], [attr$=v], [attr*=v],
// :first-child, :last-child, :nth-child(n), :not(simple), descendant ' ', child '>', groups ','.
// ---------------------------------------------------------------------------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
// a start tag of any of these closes an open <p> (HTML's "close a p element" list)
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const P_SCOPE = new Set(['button', 'table', 'td', 'th', 'caption', 'html', 'marquee', 'object', 'applet', 'template']);
// start tag → the open elements it implicitly ends, stopping at a boundary
const IMPLIED = {
  li: { close: ['li'], stop: ['ul', 'ol', 'menu'] },
  dt: { close: ['dt', 'dd'], stop: ['dl'] },
  dd: { close: ['dt', 'dd'], stop: ['dl'] },
  option: { close: ['option'], stop: ['select', 'datalist', 'optgroup'] },
  optgroup: { close: ['option', 'optgroup'], stop: ['select'] },
  tr: { close: ['tr', 'td', 'th'], stop: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { close: ['td', 'th'], stop: ['tr', 'table'] },
  th: { close: ['td', 'th'], stop: ['tr', 'table'] },
  thead: { close: ['tbody', 'tfoot', 'thead', 'tr', 'td', 'th'], stop: ['table'] },
  tbody: { close: ['tbody', 'tfoot', 'thead', 'tr', 'td', 'th'], stop: ['table'] },
  tfoot: { close: ['tbody', 'tfoot', 'thead', 'tr', 'td', 'th'], stop: ['table'] },
};
const BLOCK = new Set([...CLOSES_P, 'li', 'tr', 'td', 'th', 'dt', 'dd', 'option', 'br', 'body', 'html', 'head', 'caption', 'legend', 'label', 'button']);

// Named entities: the ones real pages use; numeric ones are decoded in full.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', euro: '€', pound: '£',
  yen: '¥', cent: '¢', rupee: '₹', laquo: '«', raquo: '»', frac12: '½', frac14: '¼', frac34: '¾', sect: '§', para: '¶', plusmn: '±',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', zwnj: '‌', zwj: '‍', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ' };
function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, e) => {
    if (e[0] === '#') {
      const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
    }
    const v = ENT[e] != null ? ENT[e] : ENT[e.toLowerCase()];
    return v == null ? m : v;
  });
}

const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
function parseAttrs(s) {
  const out = {};
  let m; ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) {
    const k = m[1].toLowerCase();
    if (k in out) continue;                                     // first one wins, as in browsers
    const v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    out[k] = decode(v);
  }
  return out;
}

// opts.xml: feeds and other XML — no void or raw-text elements, no implied end tags (<link> holds text there)
function parse(html, opts) {
  html = String(html == null ? '' : html);
  const xml = !!(opts && opts.xml);
  const doc = { type: 'doc', tag: '#document', attrs: {}, children: [], parent: null };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const append = n => { const p = top(); n.parent = p; p.children.push(n); };
  const text = t => { if (!t) return; const p = top(), last = p.children[p.children.length - 1];
    if (last && last.type === 'text') last.text += t; else append({ type: 'text', text: t }); };
  const openIdx = tag => { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) return i; return -1; };
  const closeTo = i => { stack.length = i; };
  const implied = tag => {
    if (xml) return;
    const r = IMPLIED[tag];
    if (r) {
      // the OUTERMOST closable element below the boundary: a new <tr> ends the open <td> and its <tr>
      let at = -1;
      for (let i = stack.length - 1; i > 0; i--) {
        const t = stack[i].tag;
        if (r.stop.includes(t)) break;
        if (r.close.includes(t)) at = i;
      }
      if (at > 0) closeTo(at);
    }
    // an open <p> "in button scope" ends here; the scope stops at these boundaries
    if (CLOSES_P.has(tag)) {
      for (let i = stack.length - 1; i > 0; i--) {
        const t = stack[i].tag;
        if (t === 'p') { closeTo(i); break; }
        if (P_SCOPE.has(t)) break;
      }
    }
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(decode(html.slice(i))); break; }
    if (lt > i) text(decode(html.slice(i, lt)));
    i = lt;
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
    // CDATA (feeds, SVG, XHTML): its content is literal text
    if (html.startsWith('<![CDATA[', i)) { const e = html.indexOf(']]>', i + 9); text(html.slice(i + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
    if (html[i + 1] === '!' || html[i + 1] === '?') { const e = html.indexOf('>', i); i = e < 0 ? n : e + 1; continue; }
    if (html[i + 1] === '/') {
      const m = /^<\/\s*([a-zA-Z][^\s>\/]*)[^>]*>?/.exec(html.slice(i, i + 200));
      if (!m) { text('<'); i++; continue; }
      i += m[0].length;
      const tag = m[1].toLowerCase();
      if (tag === 'br') { append({ type: 'el', tag: 'br', attrs: {}, children: [] }); continue; }
      const k = openIdx(tag);
      if (k > 0) closeTo(k);
      continue;
    }
    // start tag: scan to the closing '>' that is not inside quotes
    if (!/[a-zA-Z]/.test(html[i + 1] || '')) { text('<'); i++; continue; }
    let j = i + 1, q = null;
    while (j < n) { const c = html[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; j++; }
    const raw = html.slice(i + 1, j);
    i = j + 1;
    const tm = /^([a-zA-Z][^\s\/>]*)/.exec(raw);
    const tag = tm[1].toLowerCase();   // feeds' dc:creator, media:content stay as written, lowercased
    const selfClosing = /\/\s*$/.test(raw);
    const el = { type: 'el', tag, attrs: parseAttrs(raw.slice(tm[1].length).replace(/\/\s*$/, '')), children: [] };
    implied(tag);
    append(el);
    if (xml ? selfClosing : (VOID.has(tag) || (selfClosing && !RAW.has(tag)))) continue;
    if (!xml && RAW.has(tag)) {
      const re = new RegExp('</' + tag + '\\s*>', 'i');
      const rest = html.slice(i), m = re.exec(rest);
      const body = m ? rest.slice(0, m.index) : rest;
      if (body) el.children.push({ type: 'text', text: tag === 'textarea' || tag === 'title' ? decode(body) : body, parent: el });
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }
    stack.push(el);
  }
  return doc;
}

// ---------------- traversal ----------------
function* walk(node) {
  const kids = node.children || [];
  for (const c of kids) { if (c.type === 'el') { yield c; yield* walk(c); } }
}
const elementChildren = el => (el.children || []).filter(c => c.type === 'el');

// Text the way a reader sees it: blocks on their own lines, scripts and styles never.
function text(node, opts) {
  const keepScripts = opts && opts.raw;
  const out = [];
  const rec = nd => {
    if (nd.type === 'text') { out.push(nd.text); return; }
    if (nd.type === 'el' && !keepScripts && (nd.tag === 'script' || nd.tag === 'style' || nd.tag === 'template' || nd.tag === 'noscript')) return;
    const block = nd.type === 'el' && BLOCK.has(nd.tag);
    if (block) out.push('\n');
    for (const c of nd.children || []) rec(c);
    if (block) out.push('\n');
  };
  rec(node);
  return out.join('').replace(/[ \t\r\f ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}
const attr = (el, k) => (el && el.attrs && k.toLowerCase() in el.attrs) ? el.attrs[k.toLowerCase()] : null;
function closest(el, pred) { for (let p = el; p && p.type !== 'doc'; p = p.parent) if (pred(p)) return p; return null; }

// ---------------- selectors ----------------
// "div.card > a[href^='http']:not(.ad)" → groups of [ {combinator, simple:{tag,id,classes,attrs,pseudos}} ]
function parseSelector(sel) {
  const groups = [];
  let cur = [], comb = ' ', i = 0;
  const s = String(sel).trim();
  const simple = () => {
    const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
    let any = false;
    while (i < s.length) {
      const ch = s[i];
      if (/[a-zA-Z*]/.test(ch) && !any && c.tag == null) { const m = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(i)); c.tag = m[1] === '*' ? null : m[1].toLowerCase(); i += m[1].length; any = true; continue; }
      if (ch === '#') { const m = /^#([^\s.#\[:>,+~]+)/.exec(s.slice(i)); c.id = m[1]; i += m[0].length; any = true; continue; }
      if (ch === '.') { const m = /^\.([^\s.#\[:>,+~]+)/.exec(s.slice(i)); c.classes.push(m[1]); i += m[0].length; any = true; continue; }
      if (ch === '[') {
        const m = /^\[\s*([^\s~|^$*!=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(i)?)?\s*\]/.exec(s.slice(i));
        if (!m) throw new Error('bad selector near ' + s.slice(i, i + 20));
        c.attrs.push({ k: m[1].toLowerCase(), op: m[2] || null, v: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5], ci: !!m[6] });
        i += m[0].length; any = true; continue;
      }
      if (ch === ':') {
        const m = /^:([a-z-]+)(?:\(([^()]*(?:\([^()]*\))?[^()]*)\))?/.exec(s.slice(i));
        if (!m) throw new Error('bad selector near ' + s.slice(i, i + 20));
        c.pseudos.push({ name: m[1], arg: m[2] }); i += m[0].length; any = true; continue;
      }
      break;
    }
    if (!any) throw new Error('bad selector near "' + s.slice(i, i + 20) + '"');
    return c;
  };
  comb = null;
  while (i < s.length) {
    const ws = /^\s+/.exec(s.slice(i)); if (ws) { i += ws[0].length; if (comb === null && cur.length) comb = ' '; continue; }
    const ch = s[i];
    if (ch === ',') { groups.push(cur); cur = []; comb = null; i++; continue; }
    if (ch === '>' || ch === '+' || ch === '~') { comb = ch; i++; continue; }
    cur.push({ comb: cur.length ? (comb || ' ') : ' ', simple: simple() });
    comb = null;
  }
  if (cur.length) groups.push(cur);
  return groups;
}
function matchSimple(el, c) {
  if (el.type !== 'el') return false;
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) { const cl = String(el.attrs.class || '').split(/\s+/); for (const k of c.classes) if (!cl.includes(k)) return false; }
  for (const a of c.attrs) {
    if (!(a.k in el.attrs)) return false;
    if (!a.op) continue;
    let v = String(el.attrs[a.k]), w = String(a.v);
    if (a.ci) { v = v.toLowerCase(); w = w.toLowerCase(); }
    if (a.op === '=' && v !== w) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(w)) return false;
    if (a.op === '^=' && !(w && v.startsWith(w))) return false;
    if (a.op === '$=' && !(w && v.endsWith(w))) return false;
    if (a.op === '*=' && !(w && v.includes(w))) return false;
    if (a.op === '|=' && !(v === w || v.startsWith(w + '-'))) return false;
  }
  for (const p of c.pseudos) {
    const sib = el.parent ? elementChildren(el.parent) : [el];
    if (p.name === 'first-child' && sib[0] !== el) return false;
    if (p.name === 'last-child' && sib[sib.length - 1] !== el) return false;
    if (p.name === 'nth-child') { const k = parseInt(p.arg, 10); if (!(sib.indexOf(el) + 1 === k)) return false; }
    if (p.name === 'not') { const g = parseSelector(p.arg); if (g.some(chain => chain.length === 1 && matchSimple(el, chain[0].simple))) return false; }
    if (!['first-child', 'last-child', 'nth-child', 'not'].includes(p.name)) throw new Error('unsupported :' + p.name);
  }
  return true;
}
function matchChain(el, chain, k) {
  if (!matchSimple(el, chain[k].simple)) return false;
  if (k === 0) return true;
  const comb = chain[k].comb;
  if (comb === '>') return !!el.parent && el.parent.type === 'el' && matchChain(el.parent, chain, k - 1);
  if (comb === '+' || comb === '~') {
    const sib = el.parent ? elementChildren(el.parent) : [];
    const at = sib.indexOf(el);
    if (comb === '+') return at > 0 && matchChain(sib[at - 1], chain, k - 1);
    for (let j = at - 1; j >= 0; j--) if (matchChain(sib[j], chain, k - 1)) return true;
    return false;
  }
  for (let p = el.parent; p && p.type === 'el'; p = p.parent) if (matchChain(p, chain, k - 1)) return true;
  return false;
}
function matches(el, sel) { const g = typeof sel === 'string' ? parseSelector(sel) : sel; return g.some(chain => matchChain(el, chain, chain.length - 1)); }
function selectAll(root, sel) {
  const g = parseSelector(sel);
  const out = [];
  for (const el of walk(root)) if (g.some(chain => matchChain(el, chain, chain.length - 1))) out.push(el);
  return out;
}
const select = (root, sel) => selectAll(root, sel)[0] || null;

// Serialise back (for debugging and the page snapshot).
function outer(el) {
  if (el.type === 'text') return el.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (el.type === 'doc') return (el.children || []).map(outer).join('');
  const a = Object.entries(el.attrs).map(([k, v]) => ' ' + k + '="' + String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"').join('');
  if (VOID.has(el.tag)) return '<' + el.tag + a + '>';
  return '<' + el.tag + a + '>' + (el.children || []).map(c => RAW.has(el.tag) && c.type === 'text' ? c.text : outer(c)).join('') + '</' + el.tag + '>';
}

module.exports = { parse, decode, text, attr, closest, walk, selectAll, select, matches, parseSelector, outer, elementChildren, VOID, RAW };
