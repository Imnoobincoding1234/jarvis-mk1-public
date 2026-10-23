'use strict';
// verblex.js — his answers about what his words mean, and nothing else. No model, no seed.
//
// The properties: nothing is known until he has said it (the seed that used to ship here was a keyword
// table, and "spin up" read as an open even in "spin up a folder"); an answer is kept per PAIR, so the
// same words can mean one thing to an app and another to a file; only the four paired kinds are
// accepted; a later answer replaces an earlier one; answers survive a restart; and a state file in the
// old format — a seed plus model-learned phrases, none of it his — is not loaded.

const path = require('path');
const os = require('os');
const fs = require('fs');
const store = require('../store.js');
const lex = require('../verblex.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

// A THROWAWAY STATE DIR. This suite writes answers, and writing them into his real state directory
// would mean a test taught the live system what his words mean.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verblex-test-'));
store.init({ jlog: () => {}, stateDir: TMP });
lex.init({ jlog: () => {}, store });

head('nothing is known before he says it');
// The behavioural test for a trap: with nothing stored, does the code still "know" words? It must not.
for (const w of ['open', 'close', 'make', 'delete', 'spin up', 'quit']) {
  ok(lex.kindOfSync(w, 'app') === null && lex.kindOfSync(w, 'file') === null, '"' + w + '" means nothing yet');
}
ok(lex.seen('open') === false, 'and nothing has been answered');

head('his answer is kept, in its pair');
ok(lex.teach('spin up', 'create') === true, 'he says "spin up" (about a folder) meant create');
ok(lex.kindOfSync('spin up', 'file') === 'create', '…kept for files');
ok(lex.kindOfSync('spin up', 'app') === null, '…and says nothing about apps');
ok(lex.teach('spin up', 'open_app') === true, 'he says "spin up" (about an app) meant open');
ok(lex.kindOfSync('spin up', 'app') === 'open_app' && lex.kindOfSync('spin up', 'file') === 'create',
   'the same words hold one answer per pair');
ok(lex.kindOfSync('Spin  Up', 'app') === 'open_app', 'case and spacing are his words all the same');

head('only a paired kind is an answer');
ok(lex.teach('screen grab', 'screenshot') === false, 'a kind outside the two pairs is refused');
ok(lex.teach('', 'open_app') === false, 'no words, no answer');
ok(lex.seen('screen grab') === false, '…and nothing was kept for it');

head('a later answer replaces an earlier one');
lex.teach('chuck on', 'open_app');
lex.teach('chuck on', 'close_app');
ok(lex.kindOfSync('chuck on', 'app') === 'close_app', 'he is the authority on what he meant');

head('answers survive a restart');
lex.init({ jlog: () => {}, store });
ok(lex.kindOfSync('chuck on', 'app') === 'close_app', 'still there after reload');
ok(lex.kindOfSync('spin up', 'file') === 'create', 'both pairs reload');
ok(fs.existsSync(path.join(TMP, 'verblex.json')), 'and they are on disk');

head('the old format is not his, and is not loaded');
store.write('verblex.json', { verbs: { how: '', open: 'open_app', 'crank up': 'close_app' }, at: Date.now() });
lex.init({ jlog: () => {}, store });
ok(lex.kindOfSync('open', 'app') === null, 'a seeded verb from the old file is gone');
ok(lex.kindOfSync('crank up', 'app') === null, 'a model-learned verb from the old file is gone');

head('a lookup is a dictionary lookup');
lex.teach('boot up', 'open_app');
const t0 = Date.now();
for (let i = 0; i < 10000; i++) lex.kindOfSync('boot up', 'app');
const per = (Date.now() - t0) / 10000;
ok(per < 0.05, 'known words cost ' + per.toFixed(4) + 'ms, not a model call');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
