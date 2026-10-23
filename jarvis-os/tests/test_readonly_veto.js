// THE READ-ONLY WALL (2026-10-14). Under the reader's confident "nothing to do" (JARVIS_READER_VETO) only a procedure
// that declares itself read-only (`readOnly` on its playbook entry) may run, and agent.runGoal walls it to that list
// (opts.strictTools): the loop, a taught replay and a fixed plan can reach nothing else. These tests drive the real
// runGoal with stubbed tools and a scripted model — no model is loaded, nothing on the Mac is touched.
'use strict';
const path = require('path');
const A = require(path.join(__dirname, '..', 'agent.js'));
const PB = require(path.join(__dirname, '..', 'playbook.js'));
const SC = require(path.join(__dirname, '..', 'system_control.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}

async function main() {
  console.log('— playbook: which procedures are read-only —');
  const ro = PB.PLAYBOOKS.filter(pb => PB.readOnlyTools({ pb }));
  eq('only find-businesses declares itself read-only', ro.map(pb => pb.id), ['find-businesses']);
  eq('its read-only tools', PB.readOnlyTools({ pb: PB.PLAYBOOKS.find(pb => pb.id === 'find-businesses') }), ['find_businesses']);
  eq('no match → null', PB.readOnlyTools(null), null);

  console.log('\n— agent: the strict wall holds on every path —');
  const calls = [];
  const real = {};
  for (const n of ['send_message', 'find_businesses', 'open_app', 'compose']) {
    real[n] = A.TOOLS[n];
    A.TOOLS[n] = async a => { calls.push(n); return { ok: true, say: n + ' ran.', data: { count: 2, file: '/tmp/x.csv' } }; };
  }
  // A model that tries to send first, then does the read, then says done.
  const script = [
    { tool: 'send_message', args: { to: 'mama', text: 'hi' } },
    { tool: 'find_businesses', args: { what: 'dental clinics', withoutWebsite: true } },
    { tool: 'done', say: 'Found 2.' },
  ];
  let i = 0;
  const learnedStub = {
    replayable: () => ({ steps: [{ tool: 'send_message', args: { to: 'mama', text: 'hi' } }] }),
    candidate: () => null, failed: () => {}, succeeded: () => {}, recordSuccess: () => {}, fillSlots: steps => steps,
  };
  A.init({ llm: async () => ({ text: JSON.stringify(script[Math.min(i++, script.length - 1)]) }),
    fuzzyApp: SC.fuzzyApp, jlog: () => {}, audit: () => {}, lean: () => true, envVal: () => '', learned: learnedStub });

  const r = await A.runGoal('look for dental clinics without any website and give me their numbers',
    { allowTools: ['find_businesses'], strictTools: true, autoApprove: true, noLearn: true });
  eq('send_message never ran under the wall', calls.includes('send_message'), false);
  eq('compose never ran under the wall', calls.includes('compose'), false);
  eq('find_businesses ran', calls.includes('find_businesses'), true);
  eq('the taught send was not replayed (no send at all)', calls.filter(c => c === 'send_message').length, 0);
  eq('run returned', !!r, true);

  calls.length = 0; i = 2;   // the model just says done
  await A.runGoal('open notes', { allowTools: ['find_businesses'], strictTools: true, autoApprove: true, noLearn: true });
  eq('a fixed plan outside the wall did not run (no open_app)', calls.includes('open_app'), false);

  for (const n of Object.keys(real)) A.TOOLS[n] = real[n];
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
