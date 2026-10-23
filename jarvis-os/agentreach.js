'use strict';
// ---------------------------------------------------------------------------
// JARVIS reach — Agent-Reach rebuilt in Node, zero dependencies (his roadmap #3, "VERY IMPORTANT").
//
// Agent-Reach (github.com/Panniantong/Agent-Reach, Python, MIT) is one front door to many sources:
// each platform is routed to a backend that works today, with fallbacks, and `doctor` probes them
// live and says which one answers. The Python original leans on external CLIs (yt-dlp, gh,
// feedparser, Jina Reader, OpenCLI…); here every backend is plain HTTP through websession.js, or
// his own logged-in Brave through AppleScript for the sites that need a login.
//
// Backends, as probed 2026-10-01 from his Mac:
//   web        websession + a readability pass (local; Jina Reader sits behind Cloudflare now — 403)
//   search     the server's own provider (Composio) → DuckDuckGo Lite (no key). Bing's RSS was tried
//              and dropped: it answers on the first word only ("best cafes in kolhapur" → dictionaries)
//   youtube    oEmbed + the watch page's player data (title, channel, length, description);
//              search from the results page. TRANSCRIPTS: the timedtext URL answers empty without
//              YouTube's proof-of-origin token, so the transcript is read through Brave.
//   rss        RSS 2.0 / Atom, and feed discovery from a page's <link rel=alternate>
//   github     api.github.com without a token (60 requests/hour): repos, READMEs, search, issues
//   hn         Algolia search + the Firebase front page
//   wikipedia  the REST summary
//   reddit / x / instagram / linkedin
//              through HIS Brave, where he is logged in: open a background tab, read it, close it.
//              Reddit refuses scripted readers (403); the other three need a login. A login wall is
//              detected and reported — JARVIS never types a password. Reading only: posting, liking,
//              following and DMs are actions and go through the gated browser tools.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const H = require('./htmlparse');
const W = require('./websession');

let deps = { jlog: () => {}, audit: () => {}, search: null };
function init(d) { deps = Object.assign(deps, d || {}); }

let session = null;
const S = () => (session = session || new W.Session({ gapMs: 900 }));
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };

// ---------------- readability ----------------
// The block of the page with the most paragraph text and the fewest links is the article.
const DROP = 'script, style, noscript, template, nav, header, footer, aside, form, iframe, svg, button, select, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]';
function readable(page) {
  const doc = page.doc;
  const meta = n => { const m = H.selectAll(doc, 'meta').find(x => (x.attrs.name || x.attrs.property || '').toLowerCase() === n); return m ? m.attrs.content || '' : ''; };
  const title = meta('og:title') || page.title;
  const dropped = new Set(H.selectAll(doc, DROP));
  const inDropped = el => { for (let p = el; p && p.type === 'el'; p = p.parent) if (dropped.has(p)) return true; return false; };
  const score = new Map();
  for (const p of H.selectAll(doc, 'p, pre, li, blockquote, h2, h3, td')) {
    if (inDropped(p)) continue;
    const t = H.text(p); if (t.length < 25) continue;
    const linkLen = H.selectAll(p, 'a').reduce((n, a) => n + H.text(a).length, 0);
    const s = t.length * (1 - Math.min(1, linkLen / t.length));
    for (let a = p.parent, d = 0; a && a.type === 'el' && d < 3; a = a.parent, d++) score.set(a, (score.get(a) || 0) + s / (d + 1));
  }
  let best = null, bs = 0;
  for (const [el, s] of score) if (s > bs && !inDropped(el)) { best = el; bs = s; }
  const root = best || H.select(doc, 'main') || H.select(doc, 'article') || H.select(doc, 'body') || doc;
  const lines = [];
  const rec = n => {
    if (n.type === 'text') return;
    if (dropped.has(n)) return;
    if (/^(p|li|pre|blockquote|h[1-6]|td|dd|dt|figcaption)$/.test(n.tag)) { const t = H.text(n); if (t) lines.push((/^h[1-6]$/.test(n.tag) ? '## ' : n.tag === 'li' ? '• ' : '') + t); return; }
    for (const c of n.children || []) rec(c);
  };
  rec(root);
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 200) text = H.text(root);
  return { url: page.url, title: clip(title, 200), byline: meta('author') || meta('article:author'), published: meta('article:published_time') || meta('date'),
    description: meta('og:description') || meta('description'), text };
}
// pages that answered with a wall instead of content
function walled(page) {
  if ([401, 403, 429, 503].includes(page.status)) return 'the site answered ' + page.status;
  const t = page.title.toLowerCase();
  if (/just a moment|attention required|access denied|are you a robot|verify you are human/.test(t)) return 'a bot check';
  return null;
}

// ---------------- Brave (his logged-in browser), reading only ----------------
const JXA_READ = `function run(argv){
  var b = Application('Brave Browser');
  if (!b.running()) return JSON.stringify({err:'not-running'});
  var ws = b.windows(), w = null;
  for (var i = 0; i < ws.length; i++) { try { if (String(ws[i].mode()) !== 'incognito') { w = ws[i]; break; } } catch(e) {} }
  if (!w) return JSON.stringify({err:'no-window'});
  var prev = 1; try { prev = w.activeTabIndex(); } catch(e) {}
  var t = b.Tab({url: argv[0]}); w.tabs.push(t);
  var tab = w.tabs[w.tabs.length - 1];
  var t0 = Date.now(), limit = Number(argv[2]) || 20000;
  while (Date.now() - t0 < limit) { try { if (!tab.loading()) break; } catch(e) {} delay(0.3); }
  delay(Number(argv[3]) || 2);
  var out;
  try { out = b.execute(tab, {javascript: argv[1]}); } catch(e) { out = JSON.stringify({err:'exec-failed', msg:String(e)}); }
  // an optional second script after a wait (a page that has to scroll or load more first)
  if (argv[4]) { delay(Number(argv[5]) || 5); try { out = b.execute(tab, {javascript: argv[4]}); } catch(e) { out = JSON.stringify({err:'exec-failed', msg:String(e)}); } }
  var url = ''; try { url = String(tab.url()); } catch(e) {}
  try { tab.close(); } catch(e) {}
  try { w.activeTabIndex = prev; } catch(e) {}
  return JSON.stringify({ok:true, url:url, out: out === undefined ? '' : String(out)});
}`;
// What the page shows a reader — visible text of the main column, links, and whether a login wall is up.
const READ_JS = `(function(){
  var pw = document.querySelector('input[type=password]');
  var path = location.pathname;
  var wall = !!pw || /\\/(login|signin|sign-in|accounts\\/login|i\\/flow\\/login|authwall|checkpoint)/i.test(path);
  var main = document.querySelector('main, [role=main], article') || document.body;
  var text = (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000);
  var links = Array.prototype.slice.call(main.querySelectorAll('a[href]'), 0, 400).map(function(a){ return [String(a.innerText||'').trim().slice(0,120), a.href]; })
    .filter(function(l){ return l[0] && /^https?:/.test(l[1]); });
  return JSON.stringify({title: document.title, wall: wall, text: text, links: links});
})()`;
function braveRead(url, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_READ, url, opts.js || READ_JS, String(opts.loadMs || 20000), String(opts.settleS || 2.5), opts.then || '', String(opts.thenAfterS || 5)],
      { timeout: (opts.loadMs || 20000) + 15000 + (opts.then ? (opts.thenAfterS || 5) * 1000 : 0), maxBuffer: 32 << 20 }, (err, out, errOut) => {
        if (err) return resolve({ ok: false, say: /-1743|not allowed|not authori[sz]ed/i.test(String(errOut)) ? 'macOS has not let me control Brave (Privacy & Security → Automation).' : 'Could not reach Brave — ' + clip(errOut || err.message, 120) });
        let r; try { r = JSON.parse(String(out).trim()); } catch (e) { return resolve({ ok: false, say: 'Brave gave back something I could not read.' }); }
        if (r.err === 'not-running') return resolve({ ok: false, say: 'Brave is not open — open it (logged in) and ask again.' });
        if (r.err === 'no-window') return resolve({ ok: false, say: 'Brave has no normal window open.' });
        let d; try { d = JSON.parse(r.out); } catch (e) { d = null; }
        if (!d || d.err) return resolve({ ok: false, say: /Apple Events|-2700|not permitted/i.test(String(d && d.msg || r.out)) ? 'Brave is refusing scripted JavaScript — turn on View → Developer → "Allow JavaScript from Apple Events".' : 'Could not read the page in Brave.' });
        deps.audit('reach_brave_read', { url: clip(r.url, 100) });
        resolve(Object.assign({}, d, { ok: true, url: r.url, title: d.title, text: d.text || '', links: d.links || [], wall: !!d.wall }));
      });
  });
}

// ---------------- channels ----------------
async function readWeb(url) {
  let page;
  try { page = await S().get(url); } catch (e) { return { ok: false, say: 'Could not fetch ' + hostOf(url) + ' — ' + clip(e.message, 100) }; }
  const wall = walled(page);
  const r = readable(page);
  if (!wall && r.text.length >= 200) return Object.assign({ ok: true, via: 'web' }, r);
  // a wall, or a page that builds itself with JavaScript: read it the way he would, in Brave
  const b = await braveRead(url);
  if (b.ok && !b.wall && b.text.length > r.text.length) return { ok: true, via: 'brave', url: b.url, title: b.title, text: b.text, links: b.links };
  if (r.text.length) return Object.assign({ ok: true, via: 'web', partial: true, note: wall || 'little text without JavaScript' }, r);
  return { ok: false, say: hostOf(url) + ' gave nothing readable (' + (wall || 'empty page') + ')' + (b.ok ? '' : '; Brave: ' + b.say) };
}

async function searchWeb(q, n) {
  n = n || 8;
  const out = [], seen = new Set();
  const add = (list, src) => { for (const r of list) { if (!r.url || seen.has(r.url)) continue; seen.add(r.url); out.push(Object.assign({ source: src }, r)); } };
  if (deps.search) { try { add((await deps.search(q, n)) || [], 'provider'); } catch (e) {} }
  if (out.length < n) {
    try {
      const p = await S().get('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q));
      const rows = p.select('a.result-link').map(a => {
        let u = a.attrs.href || ''; const m = /[?&]uddg=([^&]+)/.exec(u); if (m) { try { u = decodeURIComponent(m[1]); } catch (e) {} }
        if (u.startsWith('//')) u = 'https:' + u;
        const tr = H.closest(a, x => x.tag === 'tr'); let snip = '';
        if (tr && tr.parent) { const sib = H.elementChildren(tr.parent); const at = sib.indexOf(tr); const s2 = sib[at + 1]; if (s2) snip = H.text(s2); }
        return { title: H.text(a), url: u, snippet: clip(snip, 300) };
      });
      add(rows, 'duckduckgo');
    } catch (e) { deps.jlog('Reach › ddg: ' + e.message); }
  }
  return out.slice(0, n);
}

const ytId = u => { const m = /(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(String(u)); return m ? m[1] : (/^[\w-]{11}$/.test(u) ? u : null); };
function jsonAfter(html, marker) {
  const at = html.indexOf(marker); if (at < 0) return null;
  let i = html.indexOf('{', at), depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { if (--depth === 0) { try { return JSON.parse(html.slice(i, j + 1)); } catch (e) { return null; } } }
  }
  return null;
}
async function youtubeInfo(url) {
  const id = ytId(url); if (!id) return { ok: false, say: 'That is not a YouTube video link.' };
  try {
    const p = await S().get('https://www.youtube.com/watch?v=' + id + '&hl=en');
    const pr = jsonAfter(p.html, 'ytInitialPlayerResponse');
    const v = pr && pr.videoDetails;
    if (!v) return { ok: false, say: 'YouTube did not give the video details.' };
    const tracks = (((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || []).map(t => ({ lang: t.languageCode, auto: t.kind === 'asr' }));
    return { ok: true, via: 'youtube', id, url: 'https://www.youtube.com/watch?v=' + id, title: v.title, channel: v.author, seconds: Number(v.lengthSeconds) || 0,
      views: Number(v.viewCount) || 0, description: clip(v.shortDescription, 3000), captions: tracks };
  } catch (e) { return { ok: false, say: 'Could not reach YouTube — ' + clip(e.message, 80) }; }
}
async function youtubeSearch(q, n) {
  try {
    const p = await S().get('https://www.youtube.com/results?hl=en&search_query=' + encodeURIComponent(q));
    const d = jsonAfter(p.html, 'ytInitialData');
    const out = [];
    const walk = o => { if (!o || typeof o !== 'object' || out.length >= (n || 8)) return;
      if (o.videoRenderer) { const v = o.videoRenderer; out.push({ id: v.videoId, url: 'https://www.youtube.com/watch?v=' + v.videoId, title: ((v.title || {}).runs || []).map(r => r.text).join(''),
        channel: (((v.ownerText || {}).runs || [])[0] || {}).text || '', length: (v.lengthText || {}).simpleText || '', views: (v.viewCountText || {}).simpleText || '' }); return; }
      for (const k in o) walk(o[k]); };
    walk(d);
    return out;
  } catch (e) { return []; }
}
// The transcript, read in Brave: the page's own player fetches captions with the token YouTube wants.
const TRANSCRIPT_JS = `(function(){
  var pr = window.ytInitialPlayerResponse || (document.querySelector('ytd-watch-flexy') && null);
  var tr = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
  if (!tr || !tr.length) return JSON.stringify({title: document.title, wall:false, text:'', links:[], none:true});
  var t = tr.find(function(x){ return /^en/.test(x.languageCode) && x.kind !== 'asr'; }) || tr.find(function(x){ return /^en/.test(x.languageCode); }) || tr[0];
  var x = new XMLHttpRequest(); x.open('GET', t.baseUrl + '&fmt=json3', false); x.send();
  var txt = '';
  try { var j = JSON.parse(x.responseText); txt = (j.events||[]).map(function(e){ return (e.segs||[]).map(function(s){ return s.utf8; }).join(''); }).join(' ').replace(/\\s+/g,' '); } catch(e) {}
  return JSON.stringify({title: document.title, wall:false, text: txt, links:[], lang: t.languageCode});
})()`;
async function youtubeTranscript(url) {
  const id = ytId(url); if (!id) return { ok: false, say: 'That is not a YouTube video link.' };
  const r = await braveRead('https://www.youtube.com/watch?v=' + id, { js: TRANSCRIPT_JS, settleS: 3 });
  if (!r.ok) return r;
  if (!r.text) return { ok: false, say: 'No transcript came back for that video — it may have no captions, or YouTube refused even in Brave.' };
  return { ok: true, via: 'brave', id, title: r.title, text: r.text };
}

function parseFeed(xml, feedUrl) {
  const d = H.parse(xml, { xml: true });
  const first = (el, ...tags) => { for (const t of tags) { const x = H.selectAll(el, '*').find(e => e.tag === t); if (x) return x; } return null; };
  const items = H.selectAll(d, 'item').length ? H.selectAll(d, 'item') : H.selectAll(d, 'entry');
  const ch = H.select(d, 'channel') || H.select(d, 'feed');
  return { title: ch ? H.text(first(ch, 'title') || { children: [] }) : '', url: feedUrl,
    items: items.map(i => {
      const l = first(i, 'link');
      const link = l ? (l.attrs.href || H.text(l)) : '';
      const date = first(i, 'pubdate', 'published', 'updated', 'dc:date');
      const sum = first(i, 'description', 'summary', 'content', 'content:encoded');
      return { title: H.text(first(i, 'title') || { children: [] }), url: link, date: date ? H.text(date) : '', summary: clip(sum ? H.text(H.parse(H.text(sum, { raw: true }))) : '', 500) };
    }) };
}
async function readFeed(url) {
  try {
    let p = await S().get(url);
    if (!/<(rss|feed|rdf:rdf)[\s>]/i.test(p.html.slice(0, 2000))) {
      // a page, not a feed: find the feed it advertises
      const alt = p.select('link[rel=alternate]').find(l => /rss|atom/.test(l.attrs.type || ''));
      if (!alt) return { ok: false, say: 'No feed at ' + hostOf(url) + '.' };
      p = await S().get(new URL(alt.attrs.href, p.url).toString());
    }
    return Object.assign({ ok: true, via: 'rss' }, parseFeed(p.html, p.url));
  } catch (e) { return { ok: false, say: 'Could not read that feed — ' + clip(e.message, 80) }; }
}

const GH = 'https://api.github.com';
const ghGet = async (path, accept) => { const p = await S().get(GH + path, { headers: { accept: accept || 'application/vnd.github+json' } }); if (p.status >= 400) throw new Error('GitHub ' + p.status + (p.status === 403 ? ' (hourly limit without a token)' : '')); return /raw/.test(accept || '') ? p.html : p.json(); };
async function githubRepo(spec) {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(spec) || /^([\w.-]+)\/([\w.-]+)$/.exec(spec);
  if (!m) return { ok: false, say: 'Give me owner/repo or a GitHub link.' };
  try {
    const r = await ghGet('/repos/' + m[1] + '/' + m[2].replace(/\.git$/, ''));
    let readme = ''; try { readme = await ghGet('/repos/' + r.full_name + '/readme', 'application/vnd.github.raw+json'); if (typeof readme !== 'string') readme = ''; } catch (e) {}
    return { ok: true, via: 'github', url: r.html_url, title: r.full_name, description: r.description, stars: r.stargazers_count, forks: r.forks_count, language: r.language,
      license: r.license && r.license.spdx_id, updated: r.pushed_at, issues: r.open_issues_count, text: clip(readme, 20000) };
  } catch (e) { return { ok: false, say: clip(e.message, 120) }; }
}
async function githubSearch(q, n) {
  try { const r = await ghGet('/search/repositories?per_page=' + (n || 8) + '&q=' + encodeURIComponent(q));
    return (r.items || []).map(x => ({ title: x.full_name, url: x.html_url, snippet: x.description || '', stars: x.stargazers_count, language: x.language })); }
  catch (e) { return []; }
}
async function hnSearch(q, n) {
  try { const p = await S().get('https://hn.algolia.com/api/v1/search?hitsPerPage=' + (n || 8) + '&query=' + encodeURIComponent(q));
    return (p.json().hits || []).map(h => ({ title: h.title || h.story_title, url: h.url || 'https://news.ycombinator.com/item?id=' + h.objectID, points: h.points, comments: h.num_comments,
      discussion: 'https://news.ycombinator.com/item?id=' + h.objectID })); }
  catch (e) { return []; }
}
async function hnTop(n) {
  try { const ids = (await S().get('https://hacker-news.firebaseio.com/v0/topstories.json')).json().slice(0, n || 10);
    const out = []; for (const id of ids) { const it = (await S().get('https://hacker-news.firebaseio.com/v0/item/' + id + '.json')).json();
      out.push({ title: it.title, url: it.url || 'https://news.ycombinator.com/item?id=' + id, points: it.score, comments: it.descendants }); } return out; }
  catch (e) { return []; }
}
async function wikipedia(q) {
  try {
    const s = (await S().get('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=' + encodeURIComponent(q))).json();
    const hit = s.query && s.query.search && s.query.search[0]; if (!hit) return { ok: false, say: 'Nothing on Wikipedia for that.' };
    const j = (await S().get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hit.title.replace(/ /g, '_')))).json();
    return { ok: true, via: 'wikipedia', title: j.title, url: j.content_urls && j.content_urls.desktop.page, text: j.extract };
  } catch (e) { return { ok: false, say: 'Could not reach Wikipedia.' }; }
}

// Logged-in platforms: read in Brave. A login wall is reported, never typed past.
const BRAVE_HOSTS = { 'x.com': 'X', 'twitter.com': 'X', 'instagram.com': 'Instagram', 'linkedin.com': 'LinkedIn', 'reddit.com': 'Reddit', 'old.reddit.com': 'Reddit' };
const platformOf = u => { const h = hostOf(u); for (const k of Object.keys(BRAVE_HOSTS)) if (h === k || h.endsWith('.' + k)) return BRAVE_HOSTS[k]; return null; };
async function readLoggedIn(url) {
  const name = platformOf(url);
  const r = await braveRead(url, { settleS: 3.5 });
  if (!r.ok) return r;
  if (r.wall) return { ok: false, wall: true, say: name + ' wants a login. Log in to ' + name + ' in Brave once, then ask again — I will not type a password.' };
  return { ok: true, via: 'brave', platform: name, url: r.url, title: r.title, text: r.text, links: r.links };
}
const SEARCH_URL = { X: q => 'https://x.com/search?f=live&q=' + encodeURIComponent(q), Reddit: q => 'https://www.reddit.com/search/?q=' + encodeURIComponent(q),
  LinkedIn: q => 'https://www.linkedin.com/search/results/all/?keywords=' + encodeURIComponent(q), Instagram: q => 'https://www.instagram.com/explore/tags/' + encodeURIComponent(String(q).replace(/[^\w]/g, '')) + '/' };
async function searchLoggedIn(platform, q) { const f = SEARCH_URL[platform]; if (!f) return { ok: false, say: 'No search for ' + platform + '.' }; return readLoggedIn(f(q)); }

// ---------------- the front door ----------------
// read(url): the right backend for the link. Routing is by the URL's host — a machine-owned registry.
async function read(url) {
  const h = hostOf(url);
  if (!h) return { ok: false, say: 'That is not a link I can read.' };
  if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be') return youtubeInfo(url);
  if (h === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/?$/.test(new URL(url).pathname)) return githubRepo(url);
  if (platformOf(url)) return readLoggedIn(url);
  if (/\.(rss|xml|atom)(\?|$)|\/(feed|rss)\/?(\?|$)/i.test(url)) return readFeed(url);
  return readWeb(url);
}
async function search(q, where, n) {
  where = String(where || 'web').toLowerCase();
  if (where === 'web') return searchWeb(q, n);
  if (where === 'youtube') return youtubeSearch(q, n);
  if (where === 'github') return githubSearch(q, n);
  if (where === 'hn' || where === 'hackernews') return hnSearch(q, n);
  const p = Object.values(BRAVE_HOSTS).find(x => x.toLowerCase() === where);
  if (p) return searchLoggedIn(p, q);
  throw new Error('unknown source "' + where + '" — web, youtube, github, hn, x, reddit, linkedin, instagram');
}

// ---------------- doctor ----------------
// Probe every backend live; say which answers and what to do about the ones that do not.
async function doctor(opts) {
  opts = opts || {};
  const t = async (name, fn, fix) => { const t0 = Date.now(); let ok = false, note = '';
    try { const r = await fn(); ok = !!r.ok; note = r.note || ''; } catch (e) { note = clip(e.message, 80); }
    return { name, ok, ms: Date.now() - t0, note: ok ? note : (note || fix) }; };
  const rows = await Promise.all([
    t('web (local reader)', async () => { const r = await readWeb('https://example.com/'); return { ok: r.ok && /Example Domain/.test(r.title) }; }, 'pages are not reachable — is the Mac online?'),
    t('search: DuckDuckGo Lite', async () => { const p = await S().get('https://lite.duckduckgo.com/lite/?q=test'); return { ok: p.select('a.result-link').length > 0 }; }, 'DuckDuckGo Lite returned no results (bot check?)'),
    t('youtube: details', async () => ({ ok: (await youtubeInfo('https://youtu.be/dQw4w9WgXcQ')).ok }), 'YouTube did not give player data'),
    t('youtube: search', async () => ({ ok: (await youtubeSearch('lofi', 2)).length > 0 }), 'YouTube search page changed shape'),
    t('rss', async () => ({ ok: (await readFeed('https://hnrss.org/frontpage')).items.length > 0 }), 'feed did not parse'),
    t('github (no token)', async () => ({ ok: (await githubRepo('Panniantong/Agent-Reach')).ok }), 'GitHub refused — likely the 60/hour limit'),
    t('hacker news', async () => ({ ok: (await hnSearch('llm', 2)).length > 0 }), 'Algolia did not answer'),
    t('wikipedia', async () => ({ ok: (await wikipedia('Kolhapur')).ok }), 'Wikipedia did not answer'),
  ]);
  // the logged-in platforms open real tabs in his Brave, so they are probed only when asked
  if (opts.brave) for (const [name, url] of [['x (Brave)', 'https://x.com/home'], ['reddit (Brave)', 'https://www.reddit.com/'], ['linkedin (Brave)', 'https://www.linkedin.com/feed/'], ['instagram (Brave)', 'https://www.instagram.com/']]) {
    rows.push(await t(name, async () => { const r = await readLoggedIn(url); return { ok: r.ok, note: r.ok ? 'logged in' : r.say }; }, 'not logged in in Brave'));
  } else rows.push({ name: 'x / reddit / linkedin / instagram', ok: null, note: 'read through Brave with your login — run doctor({brave:true}) to check (opens tabs)' });
  return rows;
}

module.exports = { init, read, search, doctor, readWeb, searchWeb, youtubeInfo, youtubeSearch, youtubeTranscript, readFeed, parseFeed, githubRepo, githubSearch,
  hnSearch, hnTop, wikipedia, readLoggedIn, searchLoggedIn, readable, braveRead, platformOf, jsonAfter, _session: () => S() };
