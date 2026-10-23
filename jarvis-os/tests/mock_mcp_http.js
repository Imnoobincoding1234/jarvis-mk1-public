'use strict';
// A tiny MCP server over HTTP, for tests only (not a suite: run_all picks up test_*.js). Listens on 127.0.0.1 at a
// random port and speaks one shape: 'streamable' (POST, JSON or SSE answers, session id) or 'legacy' (GET event
// stream + endpoint). Options: token (require "Authorization: Bearer <token>"), oauth (refuse with an OAuth
// challenge), sse (answer POSTs as event streams), tools (the catalogue), pages (split tools/list into pages).
const http = require('http');

function start(opts) {
  const o = Object.assign({ shape: 'streamable', tools: [], pages: 1 }, opts || {});
  const calls = [];
  const legacyStreams = new Map();   // session → res
  const authorised = req => !o.token || req.headers.authorization === 'Bearer ' + o.token;
  const answer = (msg) => {
    if (msg.method === 'initialize') return { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
    if (msg.method === 'tools/list') {
      const per = Math.ceil(o.tools.length / o.pages) || 1;
      const at = Number((msg.params && msg.params.cursor) || 0);
      const next = at + per < o.tools.length ? String(at + per) : undefined;
      return Object.assign({ tools: o.tools.slice(at, at + per) }, next ? { nextCursor: next } : {});
    }
    if (msg.method === 'tools/call') {
      calls.push(msg.params);
      return { content: [{ type: 'text', text: 'ran ' + msg.params.name + ' with ' + JSON.stringify(msg.params.arguments || {}) }] };
    }
    return null;
  };
  const server = http.createServer((req, res) => {
    if (o.oauth) {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' });
      return res.end();
    }
    if (!authorised(req)) { res.writeHead(401, { 'www-authenticate': 'Bearer' }); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (o.shape === 'legacy') {
        if (req.method === 'GET') {
          const sid = String(Math.random()).slice(2);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write('event: endpoint\ndata: /messages?session=' + sid + '\n\n');
          legacyStreams.set(sid, res);
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/messages')) {
          const sid = new URL(req.url, 'http://x').searchParams.get('session');
          const stream = legacyStreams.get(sid);
          let msg; try { msg = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
          res.writeHead(202); res.end();
          if (msg.id != null && stream) {
            const result = answer(msg);
            stream.write('event: message\ndata: ' + JSON.stringify(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } }) + '\n\n');
          }
          return;
        }
        res.writeHead(405); return res.end();   // a legacy server refuses the newer POST-to-the-link shape
      }
      // streamable
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      let msg; try { msg = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
      if (msg.id == null) { res.writeHead(202); return res.end(); }   // a notification
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(400); return res.end('missing session'); }
      const result = answer(msg);
      const reply = result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } };
      const headers = msg.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
      if (o.sse) {
        res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream' }, headers));
        res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n\n');
        res.write('event: message\ndata: ' + JSON.stringify(reply) + '\n\n');
        return;   // left open on purpose: the client must stop reading once its answer has come
      }
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, headers));
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ url: 'http://127.0.0.1:' + port + '/mcp', port, calls,
      stop: () => { for (const r of legacyStreams.values()) { try { r.end(); } catch (e) {} } server.closeAllConnections && server.closeAllConnections(); server.close(); } });
  }));
}

module.exports = { start };
