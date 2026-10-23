'use strict';
// agent.js controlReq keeps the QUERY (2026-10-10). It used to send `u.pathname` only, so "/elements?app=WhatsApp" reached
// JarvisControl as "/elements" — the frontmost app's controls. Measured: a WhatsApp send that went out was reported "could not
// confirm", and screen_elements{app} listed whatever app was in front. A fake JarvisControl on a spare port records the path.
const http = require('http');
const agent = require('../agent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };

const seen = [];
const srv = http.createServer((req, res) => {
  seen.push(req.url);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, app: 'WhatsApp', fingerprint: 'f', elements: [{ i: 1, role: 'AXTextArea', label: 'Compose message' }] }));
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  agent.init({ envVal: k => k === 'JARVIS_CONTROL_PORT' ? String(port) : '', jlog: () => {}, audit: () => {} });
  console.log('the query reaches JarvisControl');
  const r = await agent.TOOLS.screen_elements({ app: 'WhatsApp' });
  ok(seen[0] === '/elements?app=WhatsApp', 'screen_elements{app} asks for that app, not the frontmost (got ' + seen[0] + ')');
  ok(r && r.ok, 'the listing comes back');
  await agent.TOOLS.screen_elements({});
  ok(seen[1] === '/elements', 'no app named → plain /elements');
  srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
