'use strict';
// ---------------------------------------------------------------------------
// JARVIS web session — MechanicalSoup rebuilt in Node, zero dependencies (his roadmap #1).
//
// MechanicalSoup = a stateful HTTP client (cookies, redirects, referer) + BeautifulSoup + form
// filling: open a page, follow links, pick a form, set its fields, submit — no browser. That is
// the fast, quiet way to do multi-step web jobs: a page is ~100 KB of HTML instead of a rendered
// tab, nothing steals the screen, and many pages can be read at once. Sites that need JavaScript
// to render still go through browser.js (Brave); this is the half that does not need it.
//
// THE SAFETY POSTURE IS THE SAME AS browser.js — reading is free, acting is gated, in CODE:
//   • only public addresses: the hostname is resolved and private / loopback / link-local IPs are
//     refused at connect time (a name that resolves to 192.168.x is refused too, not just the literal)
//   • a form is never submitted without confirmed:true — without it you get the exact request back
//     (method, URL, every field) to show him first
//   • password / OTP / card fields are never filled (browser.sensitiveValue); file inputs are refused
//   • login, checkout and payment pages refuse to submit (browser.SENSITIVE_URL_RE)
//   • a form guarded by a CAPTCHA refuses to submit: solving one is his job, never ours
//   • polite: one request at a time per host with a gap; robots.txt is honoured when asked (crawls)
// ---------------------------------------------------------------------------

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const H = require('./htmlparse');
const browser = require('./browser');

let deps = { jlog: () => {}, audit: () => {} };
function init(d) { deps = Object.assign(deps, d || {}); }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 4 * 1024 * 1024;

// ---------------- public-address guard ----------------
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return /^(fc|fd|fe[89ab])/.test(v) || v.startsWith('ff');
}
// tests run a local fixture server; only they may switch the guard off
let allowPrivate = false;
// Node calls this with all:true (happy-eyeballs wants every address) or without; answer in the shape asked,
// and refuse if ANY address is private — a name with one public and one private record is not public.
function guardedLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, Object.assign({}, opts, { all: true }), (err, addrs) => {
    if (err) return cb(err);
    if (!allowPrivate && addrs.some(a => privateIp(a.address))) return cb(new Error('refused: ' + host + ' resolves to a private address'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
function publicUrl(raw) {
  let u; try { u = new URL(String(raw)); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || (net.isIP(h) && privateIp(h)))) return null;
  u.hash = '';
  return u;
}

// ---------------- cookies (RFC 6265, the parts sites use) ----------------
class CookieJar {
  constructor() { this.list = []; }
  set(url, header) {
    const u = new URL(url);
    for (const line of [].concat(header || [])) {
      const parts = String(line).split(';').map(s => s.trim());
      const eq = parts[0].indexOf('=');
      if (eq <= 0) continue;
      const c = { name: parts[0].slice(0, eq).trim(), value: parts[0].slice(eq + 1).trim(), domain: u.hostname, hostOnly: true,
        path: u.pathname.replace(/\/[^/]*$/, '') || '/', expires: null, secure: false };
      for (const p of parts.slice(1)) {
        const [k, ...vs] = p.split('='); const v = vs.join('=').trim(); const key = k.trim().toLowerCase();
        if (key === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          if (u.hostname !== d && !u.hostname.endsWith('.' + d)) { c.reject = true; break; }   // a site may not set cookies for another
          c.domain = d; c.hostOnly = false;
        } else if (key === 'path' && v.startsWith('/')) c.path = v;
        else if (key === 'max-age') c.expires = Date.now() + Number(v) * 1000;
        else if (key === 'expires' && c.expires == null) { const t = Date.parse(v); if (!isNaN(t)) c.expires = t; }
        else if (key === 'secure') c.secure = true;
      }
      if (c.reject) continue;
      this.list = this.list.filter(x => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
      if (c.expires == null || c.expires > Date.now()) this.list.push(c);
    }
  }
  header(url) {
    const u = new URL(url), now = Date.now();
    this.list = this.list.filter(c => c.expires == null || c.expires > now);
    const ok = this.list.filter(c => (c.hostOnly ? u.hostname === c.domain : (u.hostname === c.domain || u.hostname.endsWith('.' + c.domain))) &&
      (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/') || c.path === '/') &&
      (!c.secure || u.protocol === 'https:'));
    ok.sort((a, b) => b.path.length - a.path.length);
    return ok.map(c => c.name + '=' + c.value).join('; ');
  }
  clear() { this.list = []; }
}

// ---------------- decoding ----------------
function decompress(buf, enc) {
  enc = String(enc || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') { try { return zlib.inflateSync(buf); } catch (e) { return zlib.inflateRawSync(buf); } }
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) { return buf; }
  return buf;
}
function charsetOf(ct, buf) {
  const m = /charset=["']?([\w-]+)/i.exec(ct || '');
  if (m) return m[1].toLowerCase();
  const head = buf.slice(0, 2048).toString('latin1');
  const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return mm ? mm[1].toLowerCase() : 'utf-8';
}
function toText(buf, ct) {
  const cs = charsetOf(ct, buf);
  try { return new TextDecoder(cs).decode(buf); } catch (e) { return buf.toString('utf8'); }
}

// ---------------- the session ----------------
class Session {
  constructor(opts) {
    opts = opts || {};
    this.jar = new CookieJar();
    this.ua = opts.userAgent || UA;
    this.timeoutMs = opts.timeoutMs || 15000;
    this.gapMs = opts.gapMs == null ? 800 : opts.gapMs;     // politeness: per-host gap between requests
    this.robots = !!opts.robots;                             // honour robots.txt (crawls set this)
    this.page = null;
    this.history = [];
    this._last = new Map();
    this._robots = new Map();
  }

  async _wait(host) {
    const last = this._last.get(host) || 0, wait = last + this.gapMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._last.set(host, Date.now());
  }

  async allowedByRobots(url) {
    const u = new URL(url);
    if (!this._robots.has(u.origin)) {
      let rules = [];
      try {
        const r = await this._raw('GET', u.origin + '/robots.txt', null, {}, 0, true);
        if (r.status === 200) rules = parseRobots(toText(r.body, r.headers['content-type']));
      } catch (e) {}
      this._robots.set(u.origin, rules);
    }
    const path = u.pathname + u.search;
    let best = null;
    for (const r of this._robots.get(u.origin)) if (r.path && path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
    return !best || best.allow;
  }

  // One HTTP exchange, no redirects. body is a Buffer or string.
  _raw(method, url, body, headers, _n, skipRobots) {
    return new Promise(async (resolve, reject) => {
      const u = publicUrl(url);
      if (!u) return reject(new Error('refused: not a public http(s) address: ' + String(url).slice(0, 80)));
      if (this.robots && !skipRobots && !(await this.allowedByRobots(u.toString()))) return reject(new Error('refused by the site\'s robots.txt: ' + u.toString().slice(0, 80)));
      await this._wait(u.host);
      const mod = u.protocol === 'https:' ? https : http;
      const h = Object.assign({ 'user-agent': this.ua, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-IN,en;q=0.9', 'accept-encoding': 'gzip, deflate, br' }, headers || {});
      const ck = this.jar.header(u.toString()); if (ck) h.cookie = ck;
      if (body != null) h['content-length'] = Buffer.byteLength(body);
      const req = mod.request(u, { method, headers: h, lookup: guardedLookup, timeout: this.timeoutMs }, res => {
        const chunks = []; let n = 0;
        res.on('data', d => { n += d.length; if (n > MAX_BYTES) { req.destroy(new Error('page too large (over 4 MB)')); return; } chunks.push(d); });
        res.on('end', () => {
          if (res.headers['set-cookie']) this.jar.set(u.toString(), res.headers['set-cookie']);
          resolve({ url: u.toString(), status: res.statusCode, headers: res.headers, body: decompress(Buffer.concat(chunks), res.headers['content-encoding']) });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timed out after ' + this.timeoutMs + ' ms')));
      req.on('error', reject);
      if (body != null) req.write(body);
      req.end();
    });
  }

  // A request with redirects (301/302/303 → GET; 307/308 keep method and body), max 8 hops.
  async request(method, url, opts) {
    opts = opts || {};
    let m = method.toUpperCase(), cur = url, body = opts.body == null ? null : opts.body, headers = Object.assign({}, opts.headers || {});
    if (this.page && !headers.referer) headers.referer = this.page.url;
    for (let hop = 0; hop <= 8; hop++) {
      const r = await this._raw(m, cur, body, headers);
      if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
        const next = new URL(r.headers.location, r.url).toString();
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && m === 'POST')) { m = 'GET'; body = null; delete headers['content-type']; }
        headers.referer = r.url;
        cur = next;
        continue;
      }
      return makePage(r);
    }
    throw new Error('too many redirects');
  }

  async get(url, opts) { return this.request('GET', url, opts); }

  // Navigate: the result becomes the current page (links and forms resolve against it).
  async open(url) {
    const p = await this.get(url);
    if (this.page) this.history.push(this.page);
    this.page = p;
    deps.jlog('Web › ' + p.status + ' ' + p.url.slice(0, 90));
    return p;
  }
  back() { if (this.history.length) this.page = this.history.pop(); return this.page; }

  links(filter) { return this.page ? this.page.links(filter) : []; }

  // Follow a link of the current page: by its index in links(), a link object, or a predicate.
  async follow(which) {
    const ls = this.links();
    const l = typeof which === 'number' ? ls[which] : typeof which === 'function' ? ls.find(which) : which;
    if (!l || !l.href) throw new Error('no such link on ' + (this.page ? this.page.url : 'the page'));
    return this.open(l.href);
  }

  forms() { return this.page ? this.page.forms() : []; }
  // a form by selector (css on the <form>), index, or the form containing a field named X
  form(which) {
    const fs = this.forms();
    if (which == null) return fs[0] || null;
    if (typeof which === 'number') return fs[which] || null;
    if (typeof which === 'object' && which.field) return fs.find(f => f.fields.some(x => x.name === which.field)) || null;
    return fs.find(f => H.matches(f.el, which)) || null;
  }

  // SUBMIT. Without confirmed:true nothing is sent: the exact request comes back to be shown first.
  async submit(form, opts) {
    opts = opts || {};
    const req = form.request(opts.button);
    const stop = form.refusal();
    if (stop) return { ok: false, refused: true, say: stop, preview: req };
    if (!opts.confirmed) return { ok: false, needsConfirm: true, say: 'Submit this form to ' + hostOf(req.url) + '?', preview: req };
    deps.audit('websession_submit', { url: req.url, method: req.method, fields: req.fields.map(([k]) => k) });
    let p;
    if (req.method === 'GET') p = await this.get(req.url);
    else p = await this.request('POST', req.url, { body: req.body, headers: { 'content-type': req.contentType, origin: new URL(form.pageUrl).origin } });
    if (this.page) this.history.push(this.page);
    this.page = p;
    deps.jlog('Web › submitted ' + req.method + ' ' + req.url.slice(0, 80) + ' → ' + p.status);
    return { ok: p.status < 400, page: p, say: p.status < 400 ? 'Submitted.' : 'The site answered ' + p.status + '.' };
  }
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u).slice(0, 40); } }

function parseRobots(txt) {
  // the group for "*" (or for us); Allow/Disallow with the longest match winning
  const lines = String(txt).split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  const groups = []; let cur = null, lastWasAgent = false;
  for (const l of lines) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'disallow' && v) cur.rules.push({ path: v.replace(/\*.*$/, ''), allow: false });
    if (k === 'allow' && v) cur.rules.push({ path: v.replace(/\*.*$/, ''), allow: true });
  }
  const g = groups.find(x => x.agents.includes('jarvis')) || groups.find(x => x.agents.includes('*'));
  return g ? g.rules : [];
}

// ---------------- pages ----------------
function makePage(r) {
  const ct = String(r.headers['content-type'] || '');
  const isHtml = /html|xml/i.test(ct) || (!ct && /^\s*</.test(r.body.slice(0, 64).toString('latin1')));
  const isText = isHtml || /^text\/|json|javascript/i.test(ct);
  const html = isText ? toText(r.body, ct) : '';
  let doc = null;
  const page = {
    url: r.url, status: r.status, headers: r.headers, contentType: ct, body: r.body, html,
    get doc() { if (!doc) doc = H.parse(isHtml ? html : ''); return doc; },
    get title() { const t = H.select(this.doc, 'title'); return t ? H.text(t) : ''; },
    // the base for relative links: <base href> if the page has one
    get base() { const b = H.select(this.doc, 'base[href]'); try { return b ? new URL(b.attrs.href, r.url).toString() : r.url; } catch (e) { return r.url; } },
    text() { const main = H.select(this.doc, 'main') || H.select(this.doc, 'article') || H.select(this.doc, 'body') || this.doc; return H.text(main); },
    json() { return JSON.parse(html); },
    select(sel) { return H.selectAll(this.doc, sel); },
    links(filter) {
      const out = [], seen = new Set();
      for (const a of H.selectAll(this.doc, 'a[href]')) {
        let href; try { href = new URL(a.attrs.href, this.base).toString(); } catch (e) { continue; }
        if (!/^https?:/.test(href)) continue;
        const l = { text: H.text(a).replace(/\s+/g, ' ').slice(0, 200), href, rel: a.attrs.rel || '', el: a };
        if (filter && !filter(l)) continue;
        const k = href + '\u0000' + l.text; if (seen.has(k)) continue; seen.add(k);
        out.push(l);
      }
      return out;
    },
    forms() { return formsOf(this); },
  };
  return page;
}

// ---------------- forms ----------------
const CAPTCHA_SEL = '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], script[src*="recaptcha"], script[src*="hcaptcha"], script[src*="turnstile"]';

function formsOf(page) {
  const doc = page.doc;
  const pageCaptcha = H.selectAll(doc, CAPTCHA_SEL).length > 0;
  return H.selectAll(doc, 'form').map((el, index) => new Form(page, el, index, pageCaptcha));
}

class Form {
  constructor(page, el, index, pageCaptcha) {
    this.pageUrl = page.url;
    this.base = page.base;
    this.el = el;
    this.index = index;
    this.id = el.attrs.id || null;
    this.name = el.attrs.name || null;
    this.method = String(el.attrs.method || 'get').toUpperCase() === 'POST' ? 'POST' : 'GET';
    this.enctype = /multipart\/form-data/i.test(el.attrs.enctype || '') ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    try { this.action = new URL(el.attrs.action || '', this.base).toString(); } catch (e) { this.action = page.url; }
    this.captcha = H.selectAll(el, CAPTCHA_SEL).length > 0 || pageCaptcha;
    // controls inside the form, plus any outside it that name it with form="id"
    const inside = H.selectAll(el, 'input, select, textarea, button');
    const outside = this.id ? H.selectAll(page.doc, '[form]').filter(x => x.attrs.form === this.id && !inside.includes(x)) : [];
    this.fields = inside.concat(outside).map(fieldOf).filter(Boolean);
  }
  // one line per field — what to show the model or him
  describe() {
    return this.fields.filter(f => f.type !== 'hidden').map(f => {
      const opts = f.options ? ' [' + f.options.map(o => o.value + (o.text && o.text !== o.value ? '=' + o.text : '')).slice(0, 12).join(', ') + ']' : '';
      return (f.name || '(no name)') + ' <' + f.type + '>' + (f.label ? ' "' + f.label + '"' : '') + (f.required ? ' required' : '') + opts + (f.value ? ' = ' + JSON.stringify(String(f.value).slice(0, 40)) : '');
    });
  }
  field(name) { return this.fields.find(f => f.name === name) || null; }

  // Set a field. Refuses what JARVIS must never type, and values a select/radio does not offer.
  set(name, value) {
    const fs = this.fields.filter(f => f.name === name && !f.button);
    if (!fs.length) throw new Error('no field "' + name + '" — fields: ' + [...new Set(this.fields.filter(f => f.name && !f.button).map(f => f.name))].join(', '));
    const f = fs[0];
    if (f.type === 'password') throw new Error('refused: "' + name + '" is a password field — that one is yours to type');
    if (f.type === 'file') throw new Error('refused: file uploads are not supported');
    if (f.type === 'hidden') throw new Error('refused: "' + name + '" is a hidden field the site set');
    const why = browser.sensitiveValue(String(value), { name: f.name, auto: f.autocomplete, type: f.type });
    if (why) throw new Error('refused: ' + why);
    if (f.type === 'radio') {
      const pick = fs.find(x => String(x.value) === String(value)) || fs.find(x => x.label && x.label.toLowerCase() === String(value).toLowerCase());
      if (!pick) throw new Error('"' + name + '" has no choice "' + value + '" — choices: ' + fs.map(x => x.value).join(', '));
      for (const x of fs) x.checked = x === pick;
      return this;
    }
    if (f.type === 'checkbox') {
      if (fs.length > 1 && typeof value === 'string') { const x = fs.find(c => c.value === value); if (!x) throw new Error('"' + name + '" has no box "' + value + '"'); x.checked = true; return this; }
      f.checked = !!value && value !== 'false' && value !== 'off';
      return this;
    }
    if (f.type === 'select') {
      const vals = [].concat(value);
      const chosen = vals.map(v => f.options.find(o => o.value === String(v)) || f.options.find(o => o.text.toLowerCase() === String(v).toLowerCase()));
      if (chosen.some(c => !c)) throw new Error('"' + name + '" has no option "' + vals.join(', ') + '" — options: ' + f.options.map(o => o.text || o.value).slice(0, 20).join(', '));
      if (!f.multiple && chosen.length > 1) throw new Error('"' + name + '" takes one option');
      for (const o of f.options) o.selected = chosen.includes(o);
      f.value = chosen.map(c => c.value);
      return this;
    }
    if (f.maxlength && String(value).length > f.maxlength) throw new Error('"' + name + '" takes at most ' + f.maxlength + ' characters');
    f.value = String(value);
    return this;
  }

  // Why this form must not be submitted by JARVIS, or null.
  refusal() {
    if (this.captcha) return 'This form is guarded by a CAPTCHA — that part is yours; I will not try to get past it.';
    if (browser.SENSITIVE_URL_RE.test(this.action) || browser.SENSITIVE_URL_RE.test(this.pageUrl)) return 'That is a login, checkout or payment form — I will not submit it.';
    if (this.fields.some(f => f.type === 'password' && f.value)) return 'That form carries a password — I will not submit it.';
    return null;
  }

  // The request a browser would send, with the given (or first) submit button.
  request(buttonName) {
    const pairs = [];
    const buttons = this.fields.filter(f => f.button && f.type !== 'reset' && f.type !== 'button');
    let btn = null;
    if (buttonName != null) {
      btn = buttons.find(b => b.name === buttonName) || buttons.find(b => (b.label || '').toLowerCase() === String(buttonName).toLowerCase()) || buttons.find(b => String(b.value) === String(buttonName));
      if (!btn) throw new Error('no submit button "' + buttonName + '" — buttons: ' + buttons.map(b => b.label || b.name || b.value).join(', '));
    } else btn = buttons[0] || null;
    for (const f of this.fields) {
      if (!f.name || f.disabled) continue;
      if (f.button) { if (f === btn) { if (f.type === 'image') { pairs.push([f.name + '.x', '0'], [f.name + '.y', '0']); } else pairs.push([f.name, f.value || '']); } continue; }
      if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue;
      if (f.type === 'select') { for (const o of f.options) if (o.selected) pairs.push([f.name, o.value]); continue; }
      if (f.type === 'file') continue;
      pairs.push([f.name, f.type === 'checkbox' || f.type === 'radio' ? (f.value == null || f.value === '' ? 'on' : f.value) : (f.value == null ? '' : String(f.value))]);
    }
    const action = btn && btn.formaction ? new URL(btn.formaction, this.base).toString() : this.action;
    const method = btn && btn.formmethod ? (btn.formmethod.toUpperCase() === 'POST' ? 'POST' : 'GET') : this.method;
    if (method === 'GET') {
      const u = new URL(action); u.search = new URLSearchParams(pairs).toString();
      return { method, url: u.toString(), fields: pairs };
    }
    if (this.enctype === 'multipart/form-data') {
      const boundary = '----jarvis' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      const body = pairs.map(([k, v]) => '--' + boundary + '\r\nContent-Disposition: form-data; name="' + k.replace(/"/g, '%22') + '"\r\n\r\n' + v + '\r\n').join('') + '--' + boundary + '--\r\n';
      return { method, url: action, fields: pairs, contentType: 'multipart/form-data; boundary=' + boundary, body };
    }
    return { method, url: action, fields: pairs, contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams(pairs).toString() };
  }
}

// a <label for=id>, a wrapping <label>, aria-label, placeholder — whatever names the field to a person
function labelOf(el) {
  const doc = (() => { let p = el; while (p.parent) p = p.parent; return p; })();
  if (el.attrs.id) { const l = H.selectAll(doc, 'label[for]').find(x => x.attrs.for === el.attrs.id); if (l) return H.text(l); }
  const wrap = H.closest(el, x => x.tag === 'label'); if (wrap) return H.text(wrap);
  return el.attrs['aria-label'] || el.attrs.placeholder || el.attrs.title || '';
}
function fieldOf(el) {
  const base = { el, name: el.attrs.name || null, disabled: 'disabled' in el.attrs, required: 'required' in el.attrs, autocomplete: el.attrs.autocomplete || '',
    label: labelOf(el).replace(/\s+/g, ' ').trim().slice(0, 80) };
  if (el.tag === 'select') {
    const options = H.selectAll(el, 'option').map(o => ({ value: o.attrs.value != null ? o.attrs.value : H.text(o), text: H.text(o), selected: 'selected' in o.attrs }));
    const multiple = 'multiple' in el.attrs;
    if (!multiple && options.length && !options.some(o => o.selected)) options[0].selected = true;   // a browser shows the first
    if (!multiple) { let seen = false; for (const o of options) { if (o.selected && seen) o.selected = false; if (o.selected) seen = true; } }
    return Object.assign(base, { type: 'select', multiple, options, value: options.filter(o => o.selected).map(o => o.value) });
  }
  if (el.tag === 'textarea') return Object.assign(base, { type: 'textarea', value: H.text(el, { raw: true }), maxlength: Number(el.attrs.maxlength) || 0 });
  if (el.tag === 'button') {
    const type = String(el.attrs.type || 'submit').toLowerCase();
    return Object.assign(base, { type, button: true, value: el.attrs.value || '', label: H.text(el).slice(0, 60) || base.label,
      formaction: el.attrs.formaction, formmethod: el.attrs.formmethod });
  }
  const type = String(el.attrs.type || 'text').toLowerCase();
  if (type === 'submit' || type === 'image' || type === 'reset' || type === 'button') {
    return Object.assign(base, { type, button: true, value: el.attrs.value != null ? el.attrs.value : (type === 'submit' ? 'Submit' : ''),
      label: el.attrs.value || el.attrs.alt || base.label, formaction: el.attrs.formaction, formmethod: el.attrs.formmethod });
  }
  if (type === 'checkbox' || type === 'radio') return Object.assign(base, { type, checked: 'checked' in el.attrs, value: el.attrs.value != null ? el.attrs.value : 'on' });
  return Object.assign(base, { type, value: el.attrs.value || '', maxlength: Number(el.attrs.maxlength) || 0 });
}

module.exports = { init, Session, CookieJar, parseRobots, privateIp, publicUrl, makePage, Form,
  _allowPrivate: v => { allowPrivate = !!v; } };
