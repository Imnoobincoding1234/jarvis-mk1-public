'use strict';
// THE ARBITER'S TIE DOES NOT PRE-EMPT A READ-ONLY PROCEDURE (2026-10-24, his live turn). "find me resturants with no
// websites in my locality" was read by the errand reader as something to order, the arbiter tied food vs grocery, and
// "Did you mean food delivery or a grocery run?" was asked ahead of every lane — while find-businesses had matched the
// sentence by meaning. handleChatInner now asks readOnlyProcedureFor() first; this suite checks what it answers.
// Classification only: nothing is routed, opened, sent or ordered. Needs Ollama (the playbook's embedders).
const path = require('path');
const J = require(path.join(__dirname, '..', 'server.js'));
const errand = require(path.join(__dirname, '..', 'errand.js'));
const door = require(path.join(__dirname, '..', 'ollama.js'));

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const tie = t => { const v = J.arbitrate(t, { messages: [{ role: 'user', content: t }] }); return !!(v && !v.kind && v.ambiguous); };

(async () => {
  if (!(await door.reachable(1500))) { console.log('Skipping: Ollama is not running'); console.log('\n0 passed, 0 failed'); process.exit(0); }
  const his = 'find me resturants with no websites in my locality';
  const stillAsked = ['order gulab jamoon', 'get me some mangoes', 'order paneer', 'i want cake', 'get me ice cream', 'order chocolates'];
  if (errand.warm) await errand.warm([his].concat(stillAsked));

  console.log('— his sentence —');
  ok(tie(his), 'the arbiter ties food vs grocery on it (the case this guards)');
  const m = await J.readOnlyProcedureFor(his);
  ok(m && m.pb && m.pb.id === 'find-businesses', 'find-businesses fits it, read-only → the tie is set aside (' + (m && m.pb && m.pb.id) + ')');

  console.log('\n— a real tie is still asked —');
  for (const t of stillAsked) {
    const r = await J.readOnlyProcedureFor(t);
    ok(!r, '"' + t + '": no read-only procedure, so food or grocery is still asked' + (r ? ' (got ' + r.pb.id + ')' : ''));
  }

  console.log('\n— the shapes that already reached the business finder —');
  for (const t of ['find resturants near me without a website', 'look for dental clinics without any website and provide me their phone numbers']) {
    const r = await J.readOnlyProcedureFor(t);
    ok(r && r.pb.id === 'find-businesses', '"' + t.slice(0, 44) + '" → find-businesses');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL threw: ' + (e && e.stack || e)); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
