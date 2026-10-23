'use strict';
// ---------------------------------------------------------------------------
// test_store.js — the durable-state layer and the credential scrubber.
//
// Both exist because of failures that already happened on this machine:
// state/learned.json.bak-corrupt-subscribe-* is what an interrupted write left
// behind, and the episode journal was writing every exchange to disk with no
// notion of a secret while passive() pulls those episodes back into prompts that
// can reach OpenRouter.
//
// Every assertion here is written so it FAILS against the code as it was. A test
// that passes either way tells you nothing, which is the shape of check this
// codebase keeps finding.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         got  ' + a + '\n         want ' + b); }
}
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-store-'));

// ---- store: atomic writes and damaged files --------------------------------
function runStoreTests() {
  console.log('\n— a damaged store is set aside, never read as an empty one —');
  const store = require('../store.js');
  const dir = tmpdir();
  store.init({ jlog: () => {}, stateDir: dir });

  eq('a missing file returns the fallback', store.read('nothing.json', { a: 1 }), { a: 1 });
  store.write('thing.json', { hello: 'world' });
  eq('what was written comes back', store.read('thing.json', null), { hello: 'world' });
  eq('no temp file is left behind',
     fs.readdirSync(dir).some(f => f.includes('.tmp-')), false);

  // Truncate it the way a half-finished write would.
  const file = path.join(dir, 'thing.json');
  const whole = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, whole.slice(0, Math.max(1, Math.floor(whole.length / 2))));
  eq('a truncated file reads as the fallback, not a throw', store.read('thing.json', { fresh: true }), { fresh: true });
  const aside = fs.readdirSync(dir).filter(f => f.startsWith('thing.json.corrupt-'));
  eq('the damaged bytes are kept', aside.length, 1);
  eq('and they are the damaged ones', fs.readFileSync(path.join(dir, aside[0]), 'utf8').includes('hello'), true);
  // THE DESTRUCTIVE HALF: the next write must not bury the evidence.
  store.write('thing.json', { second: true });
  eq('the set-aside copy survives the next write', fs.existsSync(path.join(dir, aside[0])), true);

  // An EMPTY file is a first run, not damage.
  const dir2 = tmpdir();
  store.init({ jlog: () => {}, stateDir: dir2 });
  fs.writeFileSync(path.join(dir2, 'empty.json'), '');
  eq('an empty file is a first run', store.read('empty.json', []), []);
  eq('and nothing is quarantined for it',
     fs.readdirSync(dir2).some(f => f.includes('.corrupt-')), false);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (e) {}
}

// ---- store: migrations -----------------------------------------------------
function runMigrationTests() {
  console.log('\n— a schema change walks old files forward instead of losing them —');
  const store = require('../store.js');
  const dir = tmpdir();
  store.init({ jlog: () => {}, stateDir: dir });

  // A file written before migrations existed: no version anywhere.
  fs.writeFileSync(path.join(dir, 'shape.json'), JSON.stringify([{ name: 'a' }, { name: 'b' }]));
  eq('an unversioned file starts at v0', store.versionOf('shape.json'), 0);

  store.register('shape.json', [
    rows => rows.map(r => Object.assign({}, r, { tier: 'basic' })),      // v0 → v1
    rows => rows.map(r => Object.assign({}, r, { id: r.name + '-1' })),  // v1 → v2
  ]);
  const got = store.read('shape.json', []);
  eq('both migrations ran, in order', got, [
    { name: 'a', tier: 'basic', id: 'a-1' },
    { name: 'b', tier: 'basic', id: 'b-1' },
  ]);
  eq('the new version is recorded', store.versionOf('shape.json'), 2);
  eq('and the migrated shape is on DISK, not just in memory',
     JSON.parse(fs.readFileSync(path.join(dir, 'shape.json'), 'utf8'))[0].id, 'a-1');
  // Reading again must not re-run anything.
  store.register('shape.json', [
    () => { throw new Error('v0 migration must not run again'); },
    () => { throw new Error('v1 migration must not run again'); },
  ]);
  eq('an up-to-date file is not migrated twice', store.read('shape.json', [])[0].id, 'a-1');

  // A MIGRATION THAT THROWS LEAVES THE FILE AT THE LAST GOOD VERSION rather than
  // writing something half-transformed.
  const dir2 = tmpdir();
  store.init({ jlog: () => {}, stateDir: dir2 });
  fs.writeFileSync(path.join(dir2, 'brk.json'), JSON.stringify({ n: 1 }));
  store.register('brk.json', [
    d => Object.assign({}, d, { one: true }),
    () => { throw new Error('boom'); },
    d => Object.assign({}, d, { three: true }),
  ]);
  const partial = store.read('brk.json', {});
  eq('the migration before the failure applied', partial.one, true);
  eq('the one after it did not', partial.three, undefined);
  eq('and the recorded version stops at the failure', store.versionOf('brk.json'), 1);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (e) {}
}

// ---- redaction -------------------------------------------------------------
function runRedactTests() {
  console.log('\n— credentials are masked before anything is written down —');
  const R = require('../redact.js');
  const masked = (label, input, expectChange) =>
    eq(label, R.redact(input) !== input, expectChange);

  masked('an Anthropic/OpenAI key', 'here it is sk-ant-api03-' + 'a'.repeat(40), true);
  masked('an AWS access key', 'AKIAIOSFODNN7EXAMPLE', true);
  masked('a GitHub token', 'ghp_' + 'b'.repeat(38), true);
  masked('a Google API key', 'AIza' + 'c'.repeat(35), true);
  masked('a Slack token', 'xoxb-123456789012-abcdefghijkl', true);
  masked('a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', true);
  masked('a Bearer header', 'Authorization: Bearer abcdef123456', true);
  masked('this project\'s own token header', 'x-jarvis-token: abc123def456', true);
  masked('a keyword-anchored password', 'password=hunter2', true);
  masked('a private key block',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', true);
  masked('a payment card', 'card 4111 1111 1111 1111', true);
  masked('a long hex digest', 'sig ' + 'a1b2c3d4'.repeat(4), true);

  // THE OTHER HALF, and the one that decides whether this is usable: ordinary
  // sentences must survive untouched, or he turns it off.
  masked('an ordinary sentence', 'remind me to call Kunal at 6pm about the AdMax invoice', false);
  masked('a ten-digit phone number', 'call me on 9876543210', false);
  masked('a year and a count', 'in 2026 we had 100000 users', false);
  masked('a plain six-digit number', 'the flat costs 450000 rupees', false);
  masked('a short hex colour', 'the accent is #7de8b8 on the panel', false);

  // OTP needs the CONTEXT, not just six digits.
  eq('a bare six-digit number is left alone', R.redact('meeting at 123456'), 'meeting at 123456');
  eq('the same digits next to "otp" are masked',
     /REDACTED_OTP/.test(R.redact('your otp is 123456')), true);

  // The label should say WHICH kind, so a scrubbed log is still legible.
  eq('the mask names the credential type',
     R.redact('AKIAIOSFODNN7EXAMPLE'), '[REDACTED_AWS_KEY]');
  // Ordering: a vendor shape must win over the generic hex catch.
  eq('a vendor shape beats the generic hex rule',
     /AWS/.test(R.redact('AKIAIOSFODNN7EXAMPLE')), true);

  // Every occurrence, not just the first — a transcript may hold several.
  eq('every occurrence is masked, not only the first',
     (R.redact('password=a and password=b').match(/REDACTED/g) || []).length, 2);

  // Structured values, so a whole tool result can go through in one call.
  const deep = R.redactDeep({ ok: true, headers: { authorization: 'Bearer zzz' }, list: ['password=x'] });
  eq('redactDeep reaches into objects', /REDACTED/.test(JSON.stringify(deep.headers)), true);
  eq('redactDeep reaches into arrays', /REDACTED/.test(deep.list[0]), true);
  eq('and leaves non-strings alone', deep.ok, true);
  eq('a cyclic-depth value does not hang it', typeof R.redactDeep({ a: { b: { c: {} } } }), 'object');
}

// ---- the journal actually uses it ------------------------------------------
// The unit of audit is the ROUTE, not the module: redact.js passing its own tests
// says nothing about whether recall.js calls it.
function runJournalTests() {
  console.log('\n— the episode journal masks secrets on the way to disk —');
  const dir = tmpdir();
  const recall = require('../recall.js');
  recall.init({ jlog: () => {}, stateDir: dir });
  recall.log('turn', 'Mihir asked: use the key sk-ant-api03-' + 'z'.repeat(40) + ' for the call');
  recall.flush();
  const raw = fs.readFileSync(path.join(dir, 'episodes.json'), 'utf8');
  eq('the key is not on disk', /sk-ant-api03-zzzz/.test(raw), false);
  eq('and the episode is still stored', /REDACTED_LLM_KEY/.test(raw), true);
  eq('the surrounding words survive', /for the call/.test(raw), true);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

runStoreTests();
runMigrationTests();
runRedactTests();
runJournalTests();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
