'use strict';
// mcp_http.js — connecting to an MCP server by its link. Everything runs against tests/mock_mcp_http.js on this
// Mac; nothing here reaches the internet, and no real key is used.
const H = require('../mcp_http.js');
const mock = require('./mock_mcp_http.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');
const TOOLS = [
  { name: 'list_issues', description: 'List open issues in a project', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Create a new issue', inputSchema: { type: 'object' } },
  { name: 'add_comment', description: 'Comment on an issue', inputSchema: { type: 'object' } },
];

(async () => {
  head('which links are accepted');
  ok(!!H.checkUrl('https://mcp.example.com/mcp').url, 'https anywhere');
  ok(!!H.checkUrl('http://127.0.0.1:9000/mcp').url && !!H.checkUrl('http://localhost:9000/mcp').url, 'plain http only to this Mac');
  ok(!!H.checkUrl('http://example.com/mcp').error, 'plain http to another machine is refused');
  ok(!!H.checkUrl('file:///etc/passwd').error && !!H.checkUrl('not a link').error, 'not-web links and non-links are refused');
  ok(!!H.checkUrl('https://user:pw@example.com/mcp').error, 'a key hidden inside the link is refused (it belongs in the key field)');

  head('streamable HTTP, JSON answers, a session id, paged tools');
  let m = await mock.start({ tools: TOOLS, pages: 2 });
  let c = await H.connect(m.url, {});
  ok(!c.error && c.tools.length === 3, 'connects and lists all 3 tools across 2 pages (' + (c.error || c.tools.length) + ')');
  ok(c.session.kind === 'streamable' && c.session.sessionId === 'sess-1', 'keeps the session id the server handed out');
  let r = await H.rpc(c.session, 'tools/call', { name: 'list_issues', arguments: { project: 'x' } });
  ok(r.result && /ran list_issues/.test(r.result.content[0].text), 'calls a tool and reads the answer');
  m.stop();

  head('streamable HTTP, answers as an event stream left open');
  m = await mock.start({ tools: TOOLS, sse: true });
  c = await H.connect(m.url, {});
  ok(!c.error && c.tools.length === 3, 'reads its answer from the stream and stops reading (' + (c.error || c.tools.length) + ')');
  m.stop();

  head('the older HTTP + SSE shape');
  m = await mock.start({ tools: TOOLS, shape: 'legacy' });
  c = await H.connect(m.url, {});
  ok(!c.error && c.session.kind === 'legacy' && c.tools.length === 3, 'falls back when the newer shape is refused (' + (c.error || c.session.kind) + ')');
  r = await H.rpc(c.session, 'tools/call', { name: 'create_issue', arguments: {} });
  ok(r.result && /ran create_issue/.test(r.result.content[0].text), 'calls a tool over the stream');
  H.close(c.session);
  m.stop();

  head('keys and sign-in');
  m = await mock.start({ tools: TOOLS, token: 'test-token-123' });
  c = await H.connect(m.url, {});
  ok(c.error && /key or token/.test(c.error), 'no key → says it wants a key (' + c.error + ')');
  c = await H.connect(m.url, { authorization: 'Bearer wrong' });
  ok(c.error && /401/.test(c.error), 'a wrong key → refused');
  c = await H.connect(m.url, { authorization: 'Bearer test-token-123' });
  ok(!c.error && c.tools.length === 3, 'the right key → connected');
  m.stop();
  m = await mock.start({ tools: TOOLS, oauth: true });
  c = await H.connect(m.url, { authorization: 'Bearer x' });
  ok(c.error && /browser sign-in \(OAuth\)/.test(c.error), 'an OAuth server is reported as needing sign-in, not half-connected');
  m.stop();

  head('nothing listening');
  c = await H.connect('http://127.0.0.1:1/mcp', {}, { timeoutMs: 3000 });
  ok(!!c.error, 'a dead link gives an error, not a hang (' + c.error + ')');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
