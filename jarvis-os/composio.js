'use strict';
// ---------------------------------------------------------------------------
// JARVIS ↔ Composio bridge — CLOUD SaaS tools only.
//
// WHAT THIS IS NOT: a replacement for local Mac control. Composio runs in the
// cloud and has no presence on this machine, so it cannot open an app, type a
// keystroke, write an Apple Note, or send a personal iMessage/WhatsApp. Those
// stay on the local path (system_control.js / agent.js / JarvisControl).
// Verified against the live catalogue: there is no macOS-app toolkit, and the
// WhatsApp toolkit is Business-API only ("not WhatsApp Personal accounts").
//
// WHAT IT ADDS: things JARVIS genuinely cannot do locally — news/finance/
// scholar/places/shopping/trends search, and (once the user authorises them)
// Gmail, Slack, Notion, Google Calendar and friends.
//
// ZERO DEPENDENCIES on purpose. The rest of jarvis-os has no package.json and
// no node_modules; pulling in an SDK would break that and bury the security
// agent's integrity baseline under thousands of vendored files. The v3 REST API
// is a handful of endpoints, so it is called directly with node's https.
// ---------------------------------------------------------------------------

const https = require('https');

const BASE = 'backend.composio.dev';
const API = '/api/v3';

let deps = { envVal: () => '', jlog: () => {}, audit: () => {} };
function init(d) { deps = Object.assign(deps, d || {}); }

const apiKey = () => String(deps.envVal('COMPOSIO_API_KEY') || '').trim();
const available = () => !!apiKey();
// Composio scopes connections per end-user; JARVIS is single-user so one id is enough.
const USER_ID = () => String(deps.envVal('COMPOSIO_USER_ID') || 'default').trim();

function request(method, path, body, timeoutMs, keyOverride) {
  return new Promise(resolve => {
    const key = keyOverride != null ? String(keyOverride) : apiKey();
    if (!key) return resolve({ ok: false, status: 0, err: 'no-key', json: null });
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: BASE, path: API + path, method,
      headers: Object.assign({ 'x-api-key': key, accept: 'application/json' },
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b || '{}'); } catch (e) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw: b.slice(0, 400) });
      });
    });
    req.setTimeout(timeoutMs || 45000, () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, err: 'timeout', json: null }); });
    req.on('error', e => resolve({ ok: false, status: 0, err: String(e.message || e), json: null }));
    if (data) req.write(data);
    req.end();
  });
}

// IS THIS KEY GOOD? (Settings → Connections, 2026-10-09.) One read-only call with the pasted key, before anything is
// saved: a key Composio refuses is never written to .env. → { ok } | { ok:false, error }
async function testKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'Paste your Composio API key.' };
  const r = await request('GET', '/connected_accounts?limit=1', null, 15000, k);
  if (r.ok) { connCache = { at: 0, slugs: [] }; return { ok: true }; }
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'Composio refused that key (' + r.status + '). Copy it again from your Composio dashboard.' };
  if (!r.status) return { ok: false, error: 'Could not reach Composio (' + (r.err || 'no answer') + ') — check the internet and try again.' };
  return { ok: false, error: 'Composio answered ' + r.status + ' — the key was not saved.' };
}

// ---------------- connections ----------------
// An OAuth toolkit with no connection cannot run ANYTHING, so this is checked
// before execution to produce a useful "authorise it here" message rather than
// a raw API error the user cannot act on.
let connCache = { at: 0, slugs: [] };
async function connectedToolkits(force) {
  if (!force && Date.now() - connCache.at < 60000) return connCache.slugs;
  const r = await request('GET', '/connected_accounts?limit=100', null, 15000);
  const items = (r.json && (r.json.items || r.json.data)) || [];
  const slugs = items
    .filter(c => !c.status || /active|connected|success/i.test(String(c.status)))
    .map(c => String((c.toolkit && c.toolkit.slug) || c.appName || '').toLowerCase())
    .filter(Boolean);
  connCache = { at: Date.now(), slugs };
  return slugs;
}

// Toolkits that need no OAuth — usable the moment the API key exists.
const NO_AUTH = new Set(['composio_search', 'browser_tool', 'text_to_pdf', 'hackernews', 'weathermap', 'codeinterpreter', 'deepwiki_mcp']);

// Tool slugs are TOOLKIT_ACTION, but toolkit slugs themselves contain underscores
// (composio_search, browser_tool, text_to_pdf). Splitting on the first underscore
// gave "composio" for COMPOSIO_SEARCH_*, which then looked unconnected and produced
// a nonsense "connect composio" instruction. Longest known prefix wins instead.
async function toolkitOf(toolSlug) {
  const s = String(toolSlug || '').toLowerCase();
  const known = Array.from(new Set(Array.from(NO_AUTH).concat(await connectedToolkits())));
  const hit = known.filter(k => s.startsWith(k + '_')).sort((a, b) => b.length - a.length)[0];
  return hit || s.split('_')[0];
}

async function isUsable(toolkit) {
  const t = String(toolkit || '').toLowerCase();
  if (NO_AUTH.has(t)) return true;
  return (await connectedToolkits()).includes(t);
}

// Composio's errors are nested objects; `j.error` alone stringifies to "[object Object]".
function errText(j, status) {
  const e = (j && j.error) || j || {};
  const msg = (typeof e === 'string' ? e : (e.message || e.error || (j && j.message))) || ('HTTP ' + status);
  const detail = Array.isArray(e.errors) && e.errors.length ? ' (' + e.errors.join('; ') + ')' : '';
  return String(msg).slice(0, 220) + detail;
}

// Reuse an existing auth config for a toolkit, or create a Composio-managed one.
// A toolkit needs an auth_config BEFORE any connection can be made, and a fresh
// account has none — so the first "connect gmail" has to create it.
async function authConfigFor(slug) {
  const list = await request('GET', '/auth_configs?limit=100', null, 20000);
  const items = (list.json && list.json.items) || [];
  const hit = items.find(a => String((a.toolkit && a.toolkit.slug) || '').toLowerCase() === slug);
  if (hit && (hit.id || (hit.auth_config && hit.auth_config.id))) return { ok: true, id: hit.id || hit.auth_config.id };
  const made = await request('POST', '/auth_configs', {
    toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth' },
  }, 30000);
  const id = made.json && made.json.auth_config && made.json.auth_config.id;
  if (!id) return { ok: false, say: errText(made.json, made.status) };
  return { ok: true, id };
}

// Start an OAuth flow and hand back the URL the user must visit. Composio cannot
// authorise on their behalf, so this always ends with a link for a human.
// Three steps, in this order, because the API enforces it: find/create an
// auth_config → POST /connected_accounts/link → return the redirect URL. Note
// /connected_accounts (without /link) is explicitly rejected for Composio-managed
// OAuth: "no longer supported. Use POST /api/v3/connected_accounts/link instead."
async function connect(toolkit) {
  const slug = String(toolkit || '').toLowerCase().trim();
  if (!slug) return { ok: false, say: 'Which service should I connect, Sir?' };
  const cfg = await authConfigFor(slug);
  if (!cfg.ok) return { ok: false, say: 'Could not prepare ' + slug + ', Sir — ' + cfg.say };
  const r = await request('POST', '/connected_accounts/link', { auth_config_id: cfg.id, user_id: USER_ID() }, 30000);
  const j = r.json || {};
  const url = j.redirect_url || j.redirectUrl || j.redirect_uri;
  if (!url) return { ok: false, say: 'Could not start the ' + slug + ' connection, Sir — ' + errText(j, r.status) };
  connCache.at = 0;   // force a refresh on the next check
  deps.jlog('Cloud › authorisation link issued for ' + slug);
  return { ok: true, say: 'Open this to authorise ' + slug + ', Sir:\n' + url + '\nTell me once you are done and I will verify the connection.', url };
}

// ---------------- execution ----------------
async function execute(slug, args, timeoutMs) {
  if (!available()) return { ok: false, say: 'Composio is not connected yet, Sir — add your API key in Settings → Connections.' };
  const r = await request('POST', '/tools/execute/' + encodeURIComponent(slug),
    { arguments: args || {}, user_id: USER_ID() }, timeoutMs || 60000);
  const j = r.json || {};
  if (!r.ok || j.successful === false) {
    return { ok: false, say: r.err === 'timeout' ? 'the request timed out' : errText(j, r.status), raw: j };
  }
  return { ok: true, data: j.data || {}, raw: j };
}

// ---------------- readable summaries ----------------
// Tool responses are deep provider-shaped JSON; the agentic loop only needs a
// short human answer, and dumping raw JSON into a 3B's context derails it.
function summarise(kind, data) {
  const d = data || {};
  const res = d.results || d;
  const lines = [];
  const push = (t, u) => { if (t) lines.push('· ' + String(t).trim().slice(0, 150) + (u ? '\n    ' + u : '')); };

  // Google's answer box is the single best result when present — a live stock quote, a definition,
  // a direct answer. Handled first and formatted properly, because dumping its raw JSON was exactly
  // what made the stock-price reply unreadable.
  const ab = res.answer_box;
  if (ab && typeof ab === 'object') {
    if (ab.price != null) {
      const mv = ab.price_movement || {};
      const arrow = /up/i.test(mv.movement || '') ? '▲' : /down/i.test(mv.movement || '') ? '▼' : '';
      // The provider's own date string is locale-unstable — the same query returned
      // "Jul 29, 1:12 PM EDT" once and "30 يوليو، 6:13 ص غرينتش-4" the next time, which would put
      // Arabic in an English reply. Only pass it through when it is Latin script; the price,
      // movement and exchange carry the actual meaning anyway.
      const rawDate = (ab.market && ab.market.date) || '';
      const asciiDate = /^[\x20-\x7E]+$/.test(rawDate) ? rawDate : '';
      return [ab.stock || ab.title || 'Quote', ab.price + ' ' + (ab.currency || ''),
        arrow + (mv.percentage != null ? ' ' + mv.percentage + '%' : ''),
        ab.exchange ? '(' + ab.exchange + ')' : '', asciiDate ? '· ' + asciiDate : '',
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }
    const direct = ab.answer || ab.result || ab.snippet || ab.definition;
    if (direct) return String(direct).slice(0, 400);
  }

  if (res.ai_overview && Array.isArray(res.ai_overview.references)) {
    const refs = res.ai_overview.references.slice(0, 3);
    refs.forEach(r => push(r.snippet || r.title, r.link));
  }
  const listKeys = ['organic_results', 'news_results', 'results', 'items', 'organic', 'articles', 'local_results', 'shopping_results', 'scholar_results'];
  for (const k of listKeys) {
    if (Array.isArray(res[k]) && res[k].length) {
      res[k].slice(0, 5).forEach(r => push(r.title || r.name || r.snippet || r.headline, r.link || r.url || r.address));
      break;
    }
  }
  if (!lines.length) {
    // A provider-level "no results" is a real answer, not something to dump as JSON at the user.
    if (res.error) return String(res.error).slice(0, 200);
    const flat = JSON.stringify(res);
    return flat.length > 500 ? flat.slice(0, 500) + '…' : flat;
  }
  return lines.join('\n');
}
// Some specialised providers are flaky or gated — Google Finance returns "hasn't returned any
// results" for every query tried, including its own schema example ("Apple Inc"), while plain web
// search answers the same question from its answer box. So an empty specialised result falls back
// to web search instead of surfacing a dead end.
const emptyResult = data => {
  const res = (data && (data.results || data)) || {};
  if (res.error) return true;
  if (res.answer_box || res.knowledge_graph || res.ai_overview) return false;
  return !['organic_results', 'news_results', 'results', 'items', 'local_results', 'shopping_results', 'scholar_results']
    .some(k => Array.isArray(res[k]) && res[k].length);
};

// ===========================================================================
// SMART ROUTER — decides LOCAL vs CLOUD
// ===========================================================================
// Default is LOCAL, deliberately. Local is offline-capable, instant, private,
// and is what every existing JARVIS feature already does — so an ambiguous
// phrase keeps its current behaviour and nothing regresses. Cloud has to be
// EARNED by an explicit signal: a named cloud service, or a search category
// JARVIS genuinely cannot do on its own.

// Named cloud services → toolkit slug. Only fires when the name is actually said.
const CLOUD_APPS = [
  [/\bgmail\b|\bgoogle mail\b/i, 'gmail'],
  [/\bslack\b/i, 'slack'],
  [/\bnotion\b/i, 'notion'],
  [/\bgoogle (?:calendar|cal)\b|\bgcal\b/i, 'googlecalendar'],
  [/\bgoogle (?:drive|docs|sheets)\b|\bgdrive\b/i, 'googledrive'],
  [/\bgithub\b/i, 'github'],
  [/\blinear\b/i, 'linear'],
  [/\btrello\b/i, 'trello'],
  [/\basana\b/i, 'asana'],
  [/\bdiscord\b/i, 'discord'],
  [/\bhacker ?news\b|\bhn\b/i, 'hackernews'],
];

// Search flavours JARVIS has no local equivalent for. Plain "search X" is NOT
// here — that already opens a browser via the site registry, and stealing it
// would break a working feature.
// Mail nouns route to Gmail without the service being named. Without this, "check my recent
// emails" fell through to ordinary chat and the model ANSWERED AS IF IT WERE WORKING ("give me a
// minute") while nothing ran at all — the worst kind of failure, because it looks like progress.
const CLOUD_MAIL_RE = /\b(?:e-?mails?|inbox(?:es)?|mail(?:box(?:es)?|s)?|g-?mail)\b/i;
// cloud_email is READ-ONLY — it is GMAIL_FETCH_EMAILS and nothing else. A request to send, reply or
// forward that lands on it gets the inbox listed back, which looks like an answer and is not one.
// Observed: "send an email to bob" routed to the mail lane and would have listed mail instead.
// Those belong to the agentic loop, which has the tools that actually write.
const MAIL_WRITE_RE = /\b(?:send|compose|write|reply|respond|forward|draft)\b/i;
// Reading, in the words he actually uses.
const MAIL_READ_RE = /\b(?:check|read|show|list|see|look\s+at|any|new|unread|latest|recent|summari[sz]e|fetch|get|open)\b/i;
// Wiring Gmail up is not reading it. Widening CLOUD_MAIL_RE to cover "gmail" pulled "connect gmail"
// into the mail lane, where cloud_email answered "Gmail is not connected yet — say connect gmail":
// a loop, and an answer to a question nobody asked. Account admin belongs to CLOUD_ADMIN_RE in the
// router, which is checked after this lane, so it has to be let through here.
const MAIL_ADMIN_RE = /\b(?:connect|disconnect|reconnect|authoriz|authoris|unlink|re-?link|set\s*up)\w*\b/i;

const CLOUD_SEARCH = [
  [/\b(?:news|headlines?|latest news)\b/i, 'COMPOSIO_SEARCH_NEWS_SEARCH', 'news'],
  [/\b(?:stock|share) price\b|\bstock market\b|\bticker\b|\bmarket cap\b|\bhow much is .* trading\b/i, 'COMPOSIO_SEARCH_FINANCE_SEARCH', 'finance'],
  [/\b(?:scholarly|academic|research papers?|journal|citations?)\b|\bpapers? (?:on|about)\b/i, 'COMPOSIO_SEARCH_SCHOLAR_SEARCH', 'scholar'],
  [/\b(?:restaurants?|cafes?|hotels?|shops?|places?|nearby|near me)\b/i, 'COMPOSIO_SEARCH_GOOGLE_MAPS_SEARCH', 'places'],
  [/\b(?:price of|buy|shopping|cheapest|deals? on)\b/i, 'COMPOSIO_SEARCH_SHOPPING_SEARCH', 'shopping'],
  [/\btrending\b|\btrends?\b/i, 'COMPOSIO_SEARCH_TRENDS_SEARCH', 'trends'],
];

// Anything that touches THIS machine. Wins over every cloud signal below, so
// "open gmail" still opens a browser locally instead of hitting the Gmail API.
const LOCAL_HARD = /\b(?:open|launch|close|quit|focus|switch to|type|press|click|scroll|screenshot|volume|brightness|empty trash|sleep display|shut down)\b|\bon my (?:mac|computer|laptop|screen)\b|\blocally\b|\bmy calendar\b|\bapple notes?\b|\bimessage\b|\bfinder\b/i;

// A cloud service named as a DESTINATION for real work, not just referenced.
const CLOUD_VERB = /\b(?:send|email|mail|post|message|create|add|make|write|draft|list|fetch|get|read|check|search|find|show)\b/i;

function route(text) {
  const t = String(text || '').trim();
  if (!t) return { lane: 'local', reason: 'empty' };

  // 1. Local always wins when the machine itself is the target.
  if (LOCAL_HARD.test(t)) return { lane: 'local', reason: 'local-verb-or-target' };

  // 2. A named cloud service + an action verb.
  for (const [re, toolkit] of CLOUD_APPS) {
    if (re.test(t) && CLOUD_VERB.test(t)) {
      // NAMING GMAIL MUST NOT BE WORSE THAN NOT NAMING IT.
      //
      // "check my email" routed to the real inbox. "check my gmail" matched HERE first, returned no
      // mail flag, and fell through to the agentic loop — which reached for cloud_search and ran a
      // web search for the word "gmail". Rule 2.5 below could not have rescued it either: its
      // CLOUD_MAIL_RE looks for \bmail\b, and that does not match inside "gmail".
      if (toolkit === 'gmail' && MAIL_READ_RE.test(t) && !MAIL_WRITE_RE.test(t) && !MAIL_ADMIN_RE.test(t)) {
        return { lane: 'cloud', reason: 'mail-by-name', toolkit: 'gmail', mail: true };
      }
      return { lane: 'cloud', reason: 'named-service', toolkit };
    }
  }

  // 2.5 Mail, even when Gmail is not named by name.
  // No verb requirement: the noun is specific enough, and requiring one missed plain phrasings
  // like "any new emails" and "summarise my inbox" (CLOUD_VERB also failed on the PLURALS —
  // \\bmail\\b does not match "mails"). Falling through here means chat invents an answer, which
  // is strictly worse than routing a borderline phrase to the real inbox.
  if (CLOUD_MAIL_RE.test(t) && !MAIL_WRITE_RE.test(t) && !MAIL_ADMIN_RE.test(t)) return { lane: 'cloud', reason: 'mail', toolkit: 'gmail', mail: true };

  // 3. A search category with no local equivalent.
  for (const [re, slug, kind] of CLOUD_SEARCH) {
    if (re.test(t)) return { lane: 'cloud', reason: 'search:' + kind, toolkit: 'composio_search', slug, kind };
  }

  // 4. Default: keep it local. Offline, private, and preserves existing behaviour.
  return { lane: 'local', reason: 'default-local' };
}

// ===========================================================================
// Tools exposed to the agentic loop
// ===========================================================================
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = say => ({ ok: false, say });

async function cloud_search(args) {
  if (!available()) return fail('Composio is not connected yet, Sir — add your API key in Settings → Connections.');
  let query = String(args.query || args.q || args.text || '').trim();
  if (!query) return fail('What should I look up, Sir?');
  // "near me" means nothing to a cloud search engine — without a place it answered a coffee-shop
  // query with results in Florida. The caller passes the user's actual city (JARVIS already knows
  // it from the weather feed) and it is substituted in.
  const near = String(args.near || '').trim();
  if (near && /\bnear me\b|\bnearby\b|\baround here\b|\bclose by\b/i.test(query)) {
    query = query.replace(/\bnear me\b|\bnearby\b|\baround here\b|\bclose by\b/gi, 'in ' + near).trim();
  } else if (near && /^(places|restaurants|shopping)$/.test(String(args.kind || '')) && !/\bin\s+\w/i.test(query)) {
    query += ' in ' + near;
  }
  const kindMap = {
    news: 'COMPOSIO_SEARCH_NEWS_SEARCH', finance: 'COMPOSIO_SEARCH_FINANCE_SEARCH',
    scholar: 'COMPOSIO_SEARCH_SCHOLAR_SEARCH', places: 'COMPOSIO_SEARCH_GOOGLE_MAPS_SEARCH',
    shopping: 'COMPOSIO_SEARCH_SHOPPING_SEARCH', trends: 'COMPOSIO_SEARCH_TRENDS_SEARCH',
    web: 'COMPOSIO_SEARCH_SEARCH', image: 'COMPOSIO_SEARCH_IMAGE_SEARCH', event: 'COMPOSIO_SEARCH_EVENT_SEARCH',
  };
  const kind = String(args.kind || 'web').toLowerCase();
  // Google Finance is dead upstream — it returned "hasn't returned any results" for every form
  // tried (apple / AAPL / apple stock / NASDAQ:AAPL / its own schema example "Apple Inc"), and once
  // hung for 66s before the fallback rescued it. Plain web search answers the same question from its
  // answer box in ~6s with a live quote, so finance skips the broken provider entirely rather than
  // paying a timeout on every single request.
  const DEGRADED = new Set(['finance']);
  const slug = DEGRADED.has(kind) ? kindMap.web : (kindMap[kind] || kindMap.web);
  // Short timeout on specialised providers: the whole point of the fallback is to be quick, and a
  // 60s hang defeats it. Plain web search gets the full budget since there is nothing after it.
  const firstTimeout = (slug === kindMap.web) ? 45000 : 15000;
  let r = await execute(slug, { query }, firstTimeout);
  let used = DEGRADED.has(kind) ? 'web(' + kind + ' provider unavailable)' : kind;

  // Fall back to plain web search when a specialised provider comes back empty (see emptyResult).
  if (slug !== kindMap.web && (!r.ok || emptyResult(r.data))) {
    const fb = await execute(kindMap.web, { query }, 45000);
    if (fb.ok && !emptyResult(fb.data)) { r = fb; used = 'web(fallback from ' + kind + ')'; }
  }
  if (!r.ok) return fail('Cloud search failed, Sir — ' + r.say);
  deps.audit('cloud_search', { kind: used, query }, 'ok');
  deps.jlog('Cloud › ' + used + ' search "' + query.slice(0, 50) + '"');
  return ok(summarise(kind, r.data), { data: { kind: used, query }, entity: query });
}

// STRUCTURED web results, for callers that need links rather than prose.
//
// cloud_search returns a formatted paragraph, which is right for chat and useless for research —
// deep research needs {title, url} rows it can fetch and read. The local scraper this system used
// as its primary provider is dead: html.duckduckgo.com now serves a 14KB anti-bot landing page with
// zero results, so every search silently fell through to the Wikipedia + Google News fallback. That
// is why research came back reading like an encyclopedia instead of like engineering.
//
// Same provider, same key, no new dependency — this just keeps the rows instead of flattening them.
async function cloudLinks(query, want) {
  if (!available()) return [];
  const r = await execute('COMPOSIO_SEARCH_SEARCH', { query: String(query || '').trim() }, 45000);
  if (!r.ok) return [];
  const res = (r.data && (r.data.results || r.data)) || {};
  const rows = [];
  for (const k of ['organic_results', 'results', 'items', 'organic', 'scholar_results', 'news_results']) {
    if (!Array.isArray(res[k])) continue;
    for (const it of res[k]) {
      const url = it && (it.link || it.url);
      const title = it && (it.title || it.name || it.headline);
      if (!url || !title) continue;
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { continue; }
      if (rows.some(x => x.url === url)) continue;
      rows.push({ title: String(title).slice(0, 200), url, host });
    }
    if (rows.length) break;
  }
  return rows.slice(0, want || 6);
}

async function cloud_status() {
  if (!available()) return fail('Composio is not connected yet, Sir — add your API key in Settings → Connections.');
  const conns = await connectedToolkits(true);
  const ready = Array.from(NO_AUTH).join(', ');
  if (!conns.length) {
    return ok('Cloud tools are live for things needing no login, Sir — ' + ready + '. ' +
      'Nothing else is authorised yet; say “connect gmail” (or slack, notion, google calendar) to link one.',
      { data: { connected: [], noAuth: Array.from(NO_AUTH) } });
  }
  return ok('Connected, Sir: ' + conns.join(', ') + '. Also available without login: ' + ready + '.',
    { data: { connected: conns, noAuth: Array.from(NO_AUTH) } });
}

async function cloud_connect(args) {
  const name = String(args.service || args.toolkit || args.name || '').toLowerCase().trim();
  if (!name) return fail('Which service, Sir?');
  const hit = CLOUD_APPS.find(([re]) => re.test(name));
  const slug = hit ? hit[1] : name.replace(/[^a-z0-9_]/g, '');
  const r = await connect(slug);
  return r.ok ? ok(r.say, { data: { toolkit: slug, url: r.url } }) : fail(r.say);
}

// Generic escape hatch for any connected OAuth toolkit (Gmail, Slack, Notion…).
// Kept deliberately explicit — the loop must name a real Composio tool slug, so
// nothing is invented and every call is auditable.
async function cloud_action(args) {
  const slug = String(args.tool || args.slug || '').trim().toUpperCase();
  if (!slug) return fail('Which cloud tool, Sir?');
  const toolkit = await toolkitOf(slug);
  if (!(await isUsable(toolkit))) {
    return fail(toolkit + ' is not connected yet, Sir — say “connect ' + toolkit + '” and I will give you the authorisation link.');
  }
  const r = await execute(slug, args.args || args.arguments || {}, 60000);
  if (!r.ok) return fail(slug + ' failed, Sir — ' + r.say);
  deps.audit('cloud_action', { tool: slug }, 'ok');
  deps.jlog('Cloud › ' + slug);
  return ok(summarise('action', r.data), { data: r.data });
}

// Reading mail deterministically: the agentic loop guessing a tool slug is far less reliable than
// calling the known one, and this is the request Mihir actually makes.
// Unread count only — used by the opening greeting, which must not stall. Returns null (rather
// than an error) whenever Gmail is not connected or the call is slow, so the greeting simply omits
// the mail clause instead of claiming a count it does not have.
// Cached, because the greeting must not wait on the network. Measured at ~2.5s cold, which is long
// enough to outlast the boot animation prefetching it — so the count is kept warm in the background
// and read instantly. A count a couple of minutes stale is fine; a greeting that arrives late is not.
let unreadCache = { at: 0, value: null };
const UNREAD_TTL = 3 * 60 * 1000;

async function unreadCount() {
  try {
    if (!available()) return null;
    if (!(await isUsable('gmail'))) return null;
    const r = await execute('GMAIL_FETCH_EMAILS', { max_results: 25, query: 'is:unread in:inbox' }, 12000);
    if (!r.ok) return null;
    const msgs = (r.data && (r.data.messages || r.data.data)) || [];
    unreadCache = { at: Date.now(), value: { count: msgs.length, capped: msgs.length >= 25 } };
    return unreadCache.value;
  } catch (e) { return null; }
}

// Instant. Returns the cached count if it is fresh, otherwise null — and kicks off a refresh in the
// background so the NEXT read is warm. Never awaits the network.
function unreadCountCached() {
  const fresh = Date.now() - unreadCache.at < UNREAD_TTL;
  if (!fresh) unreadCount().catch(() => {});      // fire and forget
  return fresh ? unreadCache.value : null;
}
// Called at startup so the very first greeting already has a count to show.
function warmUnread() { unreadCount().catch(() => {}); }

async function cloud_email(args) {
  if (!available()) return fail('Composio is not connected yet, Sir — add your API key in Settings → Connections.');
  if (!(await isUsable('gmail'))) return fail('Gmail is not connected yet, Sir — say "connect gmail" and I will give you the link.');
  const n = Math.min(15, Math.max(1, Number(args.count || args.max || 5)));
  const q = String(args.query || args.search || '').trim();
  const a = { max_results: n };
  if (q) a.query = q;
  // "unread" is a filter, not a synonym for "recent". Offering to read 25 unread and then listing
  // the 5 most recent — which may be entirely different messages, most of them already read — is
  // answering a different question than the one asked.
  if (args.unreadOnly && !q) a.query = 'is:unread in:inbox';
  const r = await execute('GMAIL_FETCH_EMAILS', a, 60000);
  if (!r.ok) return fail('Could not read your mail, Sir — ' + r.say);
  const msgs = (r.data && (r.data.messages || r.data.data)) || [];
  if (!msgs.length) return ok(args.unreadOnly ? 'Nothing unread, Sir.' : 'No messages matched, Sir.', { data: { count: 0 } });
  const clean = v => String(v || '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  const lines = msgs.slice(0, n).map(m => {
    const who = clean(m.sender || m.from || '?').split('<')[0].trim() || '?';
    return '· ' + (m.subject || '(no subject)').slice(0, 78) + '\n    — ' + who.slice(0, 46);
  });
  deps.audit('cloud_email', { count: lines.length }, 'ok');
  deps.jlog('Cloud › fetched ' + lines.length + ' emails');
  // Say which set these actually are — "most recent" over a list of unread messages misdescribes
  // what was fetched, and the user has no way to tell.
  // If more were asked for than the tool will return, say so. Silently showing 15 of 25 lets the
  // user believe they have seen everything.
  // A FULL page means there may well be more behind it — we asked for n and got exactly n, so the
  // inbox was not exhausted. Cannot distinguish "exactly n" from "n and counting" without another
  // call, so the wording says "first n" rather than claiming either.
  const capped = lines.length >= n && n > 1;
  const head = args.unreadOnly
    ? (lines.length === 1 ? 'Your unread message, Sir:' : 'Your ' + lines.length + ' unread, Sir:')
    : 'Your ' + lines.length + ' most recent, Sir:';
  const tail = capped ? '\n\n(That is the first ' + lines.length + ' — I can only pull a page at a time, Sir.)' : '';
  return ok(head + '\n' + lines.join('\n') + tail, { data: { count: lines.length, unread: !!args.unreadOnly, capped } });
}

const TOOLS = { cloud_search, cloud_status, cloud_connect, cloud_action, cloud_email };
// Exported outside TOOLS: this is a primitive for other modules, not an agent-callable tool.
const TOOL_HELP = {
  cloud_search: 'cloud_search{query, kind:"web"|"news"|"finance"|"scholar"|"places"|"shopping"|"trends"|"image"}. Live internet search for things not on this Mac. Use for news, stock prices, papers, places nearby, shopping, trends.',
  cloud_status: 'cloud_status{}. Which cloud services are connected.',
  cloud_connect: 'cloud_connect{service}. Start authorising a cloud service (returns a link the user must open).',
  cloud_email: 'cloud_email{count?, query?}. Read recent Gmail messages. Use this for anything about email/inbox/mail.',
  cloud_action: 'cloud_action{tool, args}. Run a specific Composio tool slug on a connected service (Gmail/Slack/Notion…).',
};

module.exports = {
  testKey,
  cloudLinks,
  init, available, route, execute, connect, connectedToolkits, isUsable, summarise, unreadCount, unreadCountCached, warmUnread,
  TOOLS, TOOL_HELP, NO_AUTH, CLOUD_APPS, CLOUD_SEARCH,
};
