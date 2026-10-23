'use strict';
// mcp_http.js — talking to an MCP server by its LINK (2026-10-09, Settings → Connections → "Connect an MCP server").
//
// mcp.js spoke only stdio (a program JARVIS starts). A pasted link is a REMOTE server, which speaks MCP over HTTP in
// one of two shapes, and this file speaks both — stdlib http/https only, like everything else here:
//
//   Streamable HTTP (MCP 2025-03-26 and later): every JSON-RPC message is a POST to the link; the answer comes back
//     as JSON or as a short server-sent-event stream. The server may hand out a session id (Mcp-Session-Id) on
//     initialize, which every later request carries.
//   HTTP + SSE (MCP 2024-11-05, older servers): a GET to the link opens an event stream whose first `endpoint` event
//     names where to POST; every answer then arrives on that stream. Tried only when the first shape is refused.
//
// SAFETY. A remote server is somebody else's code. So: only https, or http to this Mac itself; no redirects
// followed; every answer is capped in size and time; a key or token is sent only to the server it was given for;
// and a server that wants a browser sign-in (OAuth) is reported as exactly that, never half-connected.
const http = require('http');
const https = require('https');

const MAX_BYTES = 4 * 1024 * 1024;
const PROTOCOL = '2025-06-18';
const LEGACY_PROTOCOL = '2024-11-05';

// A link is accepted when it is https, or http to this Mac itself (a local server). → { url } | { error }
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return { error: 'That is not a link.' }; }
  if (u.username || u.password) return { error: 'Put the key in the key field, not in the link.' };
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
  if (u.protocol === 'https:') return { url: u };
  if (u.protocol === 'http:' && loopback) return { url: u };
  return { error: u.protocol === 'http:' ? 'Only https links are allowed (plain http only to this Mac).' : 'Only https links are allowed.' };
}

// One HTTP request. onEvent, when given, receives each server-sent event as it arrives and may return true to end
// the read early (the answer it was waiting for has come). → { status, headers, body, events }
function request(url, opts) {
  const o = opts || {};
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const req = lib.request({ hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: o.method || 'POST',
      headers: o.headers || {} }, res => {
      const status = res.statusCode;
      const ctype = String(res.headers['content-type'] || '');
      const events = [];
      let size = 0, body = '', sse = '';
      const ending = () => { try { req.destroy(); } catch (e) {} finish({ status, headers: res.headers, body, events }); };
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { finish({ status, headers: res.headers, body, events, error: 'answer too large' }); try { req.destroy(); } catch (e) {} return; }
        if (!/text\/event-stream/i.test(ctype)) { body += chunk; return; }
        sse += chunk;
        let i;
        while ((i = sse.search(/\r?\n\r?\n/)) >= 0) {
          const block = sse.slice(0, i); sse = sse.slice(i).replace(/^\r?\n\r?\n/, '');
          const ev = { event: 'message', data: '' };
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data += (ev.data ? '\n' : '') + line.slice(5).replace(/^ /, '');
          }
          events.push(ev);
          if (o.onEvent && o.onEvent(ev, res)) return ending();
        }
      });
      res.on('end', () => finish({ status, headers: res.headers, body, events }));
      res.on('error', e => finish({ status, headers: res.headers, body, events, error: e.message }));
      if (o.onResponse) o.onResponse(res);
    });
    req.setTimeout(o.timeoutMs || 30000, () => { try { req.destroy(); } catch (e) {} finish({ status: 0, error: 'timed out' }); });
    req.on('error', e => finish({ status: 0, error: e.message }));
    if (o.body) req.write(o.body);
    req.end();
  });
}

// What a refusal means, in words he can act on.
function refusal(r) {
  const auth = String((r.headers && r.headers['www-authenticate']) || '');
  if (r.status === 401 || r.status === 403) {
    if (/resource_metadata|oauth|authorization_uri/i.test(auth) || /oauth/i.test(String(r.body || '').slice(0, 2000)))
      return 'This server needs a browser sign-in (OAuth), which JARVIS does not support yet. If it also offers an API key or token, paste that instead.';
    return r.status === 401 ? 'The server wants a key or token (401) — the one given was missing or refused.' : 'The server refused access (403).';
  }
  if (r.status >= 300 && r.status < 400) return 'The link redirects elsewhere (' + r.status + ') — paste the final link instead.';
  if (r.error) return 'Could not reach the server: ' + String(r.error).slice(0, 120);
  return 'The server answered ' + r.status + '.';
}

// The JSON-RPC answer with this id, from a JSON body or from the events of a stream.
function answerFrom(r, id) {
  const pick = m => (m && m.id === id && (m.result !== undefined || m.error !== undefined)) ? m : null;
  for (const ev of r.events || []) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { continue; }
    for (const x of Array.isArray(m) ? m : [m]) { const hit = pick(x); if (hit) return hit; }
  }
  let m; try { m = JSON.parse(r.body || ''); } catch (e) { return null; }
  for (const x of Array.isArray(m) ? m : [m]) { const hit = pick(x); if (hit) return hit; }
  return null;
}

// ---------------- a session ----------------
// session = { url, headers (auth only), kind: 'streamable'|'legacy', sessionId, protocol, nextId, legacy? }
function baseHeaders(s, extra) {
  const h = Object.assign({ accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, s.headers || {}, extra || {});
  if (s.sessionId) h['mcp-session-id'] = s.sessionId;
  if (s.protocol && s.kind === 'streamable') h['mcp-protocol-version'] = s.protocol;
  return h;
}

async function streamableRpc(s, method, params, timeoutMs) {
  const id = s.nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
  const r = await request(s.url, { method: 'POST', headers: Object.assign(baseHeaders(s), { 'content-length': Buffer.byteLength(body) }), body, timeoutMs,
    onEvent: ev => { try { const m = JSON.parse(ev.data); return (Array.isArray(m) ? m : [m]).some(x => x && x.id === id); } catch (e) { return false; } } });
  if (r.status < 200 || r.status >= 300) return { error: { message: refusal(r), status: r.status, http: r } };
  const sid = r.headers && r.headers['mcp-session-id'];
  if (sid && !s.sessionId) s.sessionId = String(sid);
  const m = answerFrom(r, id);
  return m || { error: { message: 'The server answered, but not with an MCP reply.' } };
}

// The older shape: one long-lived GET stream carries every answer.
function openLegacy(s, timeoutMs) {
  return new Promise(resolve => {
    const st = { endpoint: null, waiting: new Map(), res: null, closed: false };
    s.legacy = st;
    let settled = false;
    const settle = v => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => settle({ error: 'no endpoint event from the server' }), timeoutMs || 15000);
    request(s.url, { method: 'GET', headers: Object.assign({ accept: 'text/event-stream' }, s.headers || {}), timeoutMs: 6 * 3600 * 1000,
      onResponse: res => {
        st.res = res;
        if (res.statusCode !== 200) { clearTimeout(timer); settle({ error: refusal({ status: res.statusCode, headers: res.headers }) }); }
      },
      onEvent: ev => {
        if (ev.event === 'endpoint' && !st.endpoint) {
          let target;
          try { target = new URL(ev.data.trim(), s.url); } catch (e) { target = null; }
          // The endpoint must be on the same server the key was given for.
          if (!target || target.origin !== s.url.origin) { clearTimeout(timer); settle({ error: 'the server pointed its endpoint at another site' }); return true; }
          st.endpoint = target; clearTimeout(timer); settle({ ok: true });
          return false;
        }
        let m; try { m = JSON.parse(ev.data); } catch (e) { return false; }
        for (const x of Array.isArray(m) ? m : [m]) {
          if (x && x.id != null && st.waiting.has(x.id)) { const w = st.waiting.get(x.id); st.waiting.delete(x.id); w(x); }
        }
        return false;
      } }).then(r => { st.closed = true; for (const w of st.waiting.values()) w({ error: { message: 'the server closed the stream' } }); st.waiting.clear();
        if (!settled) { clearTimeout(timer); settle({ error: refusal(r) }); } });
  });
}
async function legacyRpc(s, method, params, timeoutMs) {
  const st = s.legacy;
  if (!st || st.closed || !st.endpoint) return { error: { message: 'not connected' } };
  const id = s.nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
  const answer = new Promise(resolve => {
    const t = setTimeout(() => { st.waiting.delete(id); resolve({ error: { message: 'timed out after ' + (timeoutMs || 30000) + 'ms' } }); }, timeoutMs || 30000);
    st.waiting.set(id, m => { clearTimeout(t); resolve(m); });
  });
  const r = await request(st.endpoint, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, s.headers || {}), body, timeoutMs });
  if (r.status < 200 || r.status >= 300) { st.waiting.delete(id); return { error: { message: refusal(r) } }; }
  const direct = answerFrom(r, id);   // some servers answer the POST directly as well
  if (direct) { st.waiting.delete(id); return direct; }
  return answer;
}

function rpc(s, method, params, timeoutMs) { return s.kind === 'legacy' ? legacyRpc(s, method, params, timeoutMs) : streamableRpc(s, method, params, timeoutMs); }
async function notify(s, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
  if (s.kind === 'legacy') {
    if (s.legacy && s.legacy.endpoint) await request(s.legacy.endpoint, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, s.headers || {}), body, timeoutMs: 10000 });
    return;
  }
  await request(s.url, { method: 'POST', headers: Object.assign(baseHeaders(s), { 'content-length': Buffer.byteLength(body) }), body, timeoutMs: 10000 });
}

// Connect: initialize (newer shape first, the older on refusal), then every page of tools/list.
// → { session, serverInfo, tools: [raw tool objects] } | { error }
async function connect(rawUrl, authHeaders, opts) {
  const o = opts || {};
  const chk = checkUrl(rawUrl);
  if (chk.error) return { error: chk.error };
  const s = { url: chk.url, headers: authHeaders || {}, kind: 'streamable', sessionId: null, protocol: null, nextId: 1 };
  const initParams = p => ({ protocolVersion: p, capabilities: {}, clientInfo: { name: 'JARVIS MK-1', version: '1' } });
  let init = await streamableRpc(s, 'initialize', initParams(PROTOCOL), o.timeoutMs || 15000);
  // 401/403 are about the key, not the transport — no point trying the older shape.
  const st = init.error && init.error.status;
  if (init.error && st !== 401 && st !== 403) {
    const legacy = { url: chk.url, headers: authHeaders || {}, kind: 'legacy', sessionId: null, protocol: LEGACY_PROTOCOL, nextId: 1 };
    const opened = await openLegacy(legacy, o.timeoutMs || 15000);
    if (opened.ok) {
      const li = await legacyRpc(legacy, 'initialize', initParams(LEGACY_PROTOCOL), o.timeoutMs || 15000);
      if (!li.error) { Object.assign(s, legacy); init = li; }
    }
  }
  if (init.error) { close(s); return { error: init.error.message }; }
  if (s.kind === 'streamable') s.protocol = (init.result && init.result.protocolVersion) || PROTOCOL;
  await notify(s, 'notifications/initialized');
  const tools = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const r = await rpc(s, 'tools/list', cursor ? { cursor } : {}, o.timeoutMs || 15000);
    if (r.error) { close(s); return { error: 'Connected, but listing its tools failed: ' + r.error.message }; }
    tools.push(...((r.result && r.result.tools) || []));
    cursor = r.result && r.result.nextCursor;
    if (!cursor || tools.length >= 1000) break;
  }
  return { session: s, serverInfo: (init.result && init.result.serverInfo) || {}, tools };
}

function close(s) {
  try { if (s && s.legacy && s.legacy.res) s.legacy.res.destroy(); } catch (e) {}
  if (s && s.legacy) s.legacy.closed = true;
}

module.exports = { checkUrl, connect, rpc, close, PROTOCOL, LEGACY_PROTOCOL };
