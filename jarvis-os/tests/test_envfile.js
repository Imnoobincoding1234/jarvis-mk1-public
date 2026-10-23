'use strict';
// envfile.js — the only writer of .env. Runs on TEMP files only; his real .env is never opened here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../envfile.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-envfile-'));
const f = path.join(dir, '.env');
const before = '# keys\nOPENROUTER_API_KEY=or-abc123\n\nexport JARVIS_CHAT_REPLY_MODEL=jarvis\nOTHER="quoted value"\n';
fs.writeFileSync(f, before, { mode: 0o600 });

console.log('\n— set and replace in place —');
ok(E.set(f, 'COMPOSIO_API_KEY', 'ak_test_0123456789abcd').ok, 'a new variable is added');
let t = fs.readFileSync(f, 'utf8');
ok(t.startsWith('# keys\nOPENROUTER_API_KEY=or-abc123\n\nexport JARVIS_CHAT_REPLY_MODEL=jarvis\nOTHER="quoted value"\n'), 'every other line, comment and blank is untouched');
ok(/\nCOMPOSIO_API_KEY=ak_test_0123456789abcd\n$/.test(t), 'appended once, with a trailing newline');
ok(E.set(f, 'COMPOSIO_API_KEY', 'ak_test_new_value_9999').ok && (fs.readFileSync(f, 'utf8').match(/COMPOSIO_API_KEY=/g) || []).length === 1, 'replacing keeps exactly one line');
ok(E.set(f, 'JARVIS_CHAT_REPLY_MODEL', 'jarvis2').ok && fs.readFileSync(f, 'utf8').includes('JARVIS_CHAT_REPLY_MODEL=jarvis2'), 'an `export` line is found and replaced');
ok((fs.statSync(f).mode & 0o777) === 0o600, 'the file stays owner-only (0600)');
ok(fs.readdirSync(dir).length === 1, 'no temp file is left behind');

console.log('\n— refused, not cleaned —');
ok(!E.set(f, 'bad-name', 'x').ok, 'a name that is not SHOUTING_SNAKE_CASE');
ok(!E.set(f, 'MCP_X', 'two words').ok, 'a value with a space');
ok(!E.set(f, 'MCP_X', 'line\nINJECTED=1').ok, 'a value with a newline (cannot inject a second variable)');
ok(!E.set(f, 'MCP_X', '"quoted"').ok && !E.set(f, 'MCP_X', '').ok, 'quotes, and an empty value');
ok(!fs.readFileSync(f, 'utf8').includes('INJECTED'), 'nothing refused reached the file');

console.log('\n— reading without revealing —');
ok(E.has(f, 'COMPOSIO_API_KEY') && !E.has(f, 'NOT_THERE'), 'has() says set / not set');
ok(E.masked(f, 'COMPOSIO_API_KEY') === '…9999', 'masked() shows only the last four');
ok(E.masked(f, 'OPENROUTER_API_KEY') === '(set)', 'a short value shows no characters at all');

console.log('\n— unset —');
ok(E.unset(f, 'COMPOSIO_API_KEY').removed === true && !E.has(f, 'COMPOSIO_API_KEY'), 'removes the line');
ok(fs.readFileSync(f, 'utf8').includes('OPENROUTER_API_KEY=or-abc123'), 'and nothing else');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
