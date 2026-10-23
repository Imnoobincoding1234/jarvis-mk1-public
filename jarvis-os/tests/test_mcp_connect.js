'use strict';
// mcp.js — connecting a server by its link (Settings → Connections), his approval, removal. Runs against
// tests/mock_mcp_http.js on this Mac with TEMP files: the server list goes to a temp file (JARVIS_MCP_REMOTE), the
// token to a temp .env through the same setSecret path server.js uses. His real .env and state are never touched.
// The embedder is a stand-in here (picker QUALITY is measured in sweeps/sweep_mcp_picker.js); this checks mechanics.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'));
process.env.JARVIS_MCP_REMOTE = path.join(dir, 'mcp_remote.json');
const envPath = path.join(dir, '.env');
fs.writeFileSync(envPath, 'OTHER=1\n', { mode: 0o600 });
const envfile = require('../envfile.js');
const mcp = require('../mcp.js');
const mock = require('./mock_mcp_http.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');
// stand-in embedder: letter counts — enough for the picker to rank a tool whose words overlap the goal
const embed = async t => { const v = new Array(26).fill(0); for (const ch of String(t).toLowerCase()) { const i = ch.charCodeAt(0) - 97; if (i >= 0 && i < 26) v[i]++; } return v; };
const readEnv = n => { const m = new RegExp('^' + n + '=(.*)$', 'm').exec(fs.readFileSync(envPath, 'utf8')); return m ? m[1] : null; };
const audits = [];
mcp.init({ jlog: () => {}, audit: (t, a, r) => audits.push([t, r]), envVal: n => readEnv(n), setSecret: (n, v) => envfile.set(envPath, n, v), embed });

const TOOLS = [
  { name: 'list_issues', description: 'List open issues in a project', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Create a new issue in a project', inputSchema: { type: 'object' } },
];

(async () => {
  const m = await mock.start({ tools: TOOLS, token: 'tok-test-123456' });

  head('connecting by link');
  let r = await mcp.connectRemote({ url: m.url, token: 'wrong-token-000', authKind: 'bearer' });
  ok(!r.ok && /401/.test(r.error), 'a refused token → not connected (' + r.error + ')');
  ok(readEnv('MCP_MOCK_TOKEN') === null && !fs.existsSync(process.env.JARVIS_MCP_REMOTE), 'and nothing was saved anywhere');
  r = await mcp.connectRemote({ url: m.url, token: 'tok-test-123456', authKind: 'bearer' });
  // named after the server's own name ("mock"), with a suffix if that name is taken (config/mcp.json has a "mock")
  ok(r.ok && /^mock(_\d+)?$/.test(r.name) && r.tools === 2 && r.readOnly === 1, 'the right token → connected, 2 tools, 1 read-only (' + JSON.stringify(r) + ')');
  const NAME = r.name, VAR = 'MCP_' + NAME.toUpperCase() + '_TOKEN';
  ok(readEnv(VAR) === 'tok-test-123456', 'the token went to .env under ' + VAR);
  const saved = fs.readFileSync(process.env.JARVIS_MCP_REMOTE, 'utf8');
  ok(!saved.includes('tok-test-123456') && saved.includes('"authEnv": "' + VAR + '"'), 'the server list names the variable, never the token');
  ok((fs.statSync(process.env.JARVIS_MCP_REMOTE).mode & 0o777) === 0o600, 'the server list is owner-only');
  r = await mcpAgain();
  ok(!r.ok && /already connected/.test(r.error), 'the same link twice is refused');
  ok(mcp.remoteStatus().length === 1 && mcp.remoteStatus()[0].ready, 'status shows it ready');

  head('his approval');
  const picked = await mcp.forGoal('create a new issue in my project');
  ok(Object.keys(picked.tools).includes(NAME + '__create_issue'), 'the picker offers the matching tool');
  let c = await mcp.call(NAME + '__create_issue', { title: 'x' }, { confirmed: true });
  ok(c.needsConfirm && c.confirm.args.__approval && m.calls.length === 0, 'a tool not marked read-only stops for approval — even with a blanket confirmed:true');
  const code = c.confirm.args.__approval;
  let bad = await mcp.call(NAME + '__create_issue', { title: 'x', __approval: 'made-up-code' }, {});
  ok(bad.needsConfirm && m.calls.length === 0, 'a made-up approval code does not run it');
  bad = await mcp.call(NAME + '__create_issue', { title: 'DIFFERENT', __approval: code }, {});
  ok(bad.needsConfirm && m.calls.length === 0, 'the code is tied to the exact arguments he saw');
  // the different-args attempt issued a fresh code and left the original one valid
  c = await mcp.call(NAME + '__create_issue', { title: 'x', __approval: code }, {});
  ok(c.ok && m.calls.length === 1 && m.calls[0].name === 'create_issue' && !('__approval' in m.calls[0].arguments), 'the code from his card runs it once, and is not passed to the server');
  c = await mcp.call(NAME + '__create_issue', { title: 'x', __approval: code }, {});
  ok(c.needsConfirm && m.calls.length === 1, 'a used code does not run it again');
  c = await mcp.call(NAME + '__list_issues', { project: 'p' }, {});
  ok(c.ok && m.calls.length === 2, 'a read-only tool runs without asking');
  ok(audits.some(a => a[0] === 'mcp_connect') && audits.filter(a => a[0] === 'mcp_call').length >= 2, 'connects and calls are audited');

  head('removing');
  r = mcp.removeRemote(NAME);
  ok(r.ok && r.authEnv === VAR, 'removed, and the caller is told which .env variable to delete');
  envfile.unset(envPath, r.authEnv);
  ok(readEnv(VAR) === null && readEnv('OTHER') === '1', 'its token is gone from .env, nothing else is');
  ok(mcp.remoteStatus().length === 0 && mcp.allTools().length === 0, 'and its tools are gone');

  m.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);

  function mcpAgain() { return mcp.connectRemote({ url: m.url, token: 'tok-test-123456', authKind: 'bearer' }); }
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
