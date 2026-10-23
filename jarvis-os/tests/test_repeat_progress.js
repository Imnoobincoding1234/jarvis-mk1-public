// A REPEATED LOOK IS PROGRESS WHEN ITS ANSWER CHANGED (2026-10-14, agent.js loop guard). Before: any identical call ended
// the run as a success, so re-reading a page after it changed reported "done" one step in. After: a call outside
// SIDE_EFFECT_TOOLS is run again and compared; the same answer still stops the run, a different one carries on. A side
// effect repeated still stops BEFORE it runs again. Real runGoal, scripted model, stubbed tools — nothing is touched.
'use strict';
const path = require('path');
const A = require(path.join(__dirname, '..', 'agent.js'));
const SC = require(path.join(__dirname, '..', 'system_control.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}

async function runScript(script, looks) {
  const calls = [];
  let i = 0, n = 0;
  A.init({ llm: async () => ({ text: JSON.stringify(script[Math.min(i++, script.length - 1)]) }),
    fuzzyApp: SC.fuzzyApp, jlog: () => {}, audit: () => {}, lean: () => true, envVal: () => '' });
  const real = { screen_elements: A.TOOLS.screen_elements, list_running: A.TOOLS.list_running, type_text: A.TOOLS.type_text };
  A.TOOLS.screen_elements = async () => { calls.push('screen_elements'); const v = looks[Math.min(n++, looks.length - 1)]; return { ok: true, say: 'Saw ' + v + '.', data: { elements: [v] } }; };
  A.TOOLS.list_running = async () => { calls.push('list_running'); return { ok: true, say: 'Running (2): Notes, Safari', data: { apps: ['Notes', 'Safari'] } }; };
  A.TOOLS.type_text = async a => { calls.push('type_text'); return { ok: true, say: 'Typed it.' }; };
  try {
    await A.runGoal('look over what is on screen and then check the running apps',
      { allowTools: ['screen_elements', 'list_running', 'type_text', 'volume'], autoApprove: true, noLearn: true });
  } finally { Object.assign(A.TOOLS, real); }
  return calls;
}

async function main() {
  console.log('— a look that saw something new carries on —');
  let c = await runScript([{ tool: 'screen_elements', args: {} }, { tool: 'screen_elements', args: {} },
    { tool: 'list_running', args: {} }, { tool: 'done', say: 'Done.' }], ['page top', 'page after scrolling']);
  eq('looked twice', c.filter(x => x === 'screen_elements').length, 2);
  eq('and went on to the next step', c.includes('list_running'), true);

  console.log('\n— a look that saw the same thing again stops —');
  c = await runScript([{ tool: 'screen_elements', args: {} }, { tool: 'screen_elements', args: {} },
    { tool: 'list_running', args: {} }, { tool: 'done', say: 'Done.' }], ['same page', 'same page']);
  eq('looked twice', c.filter(x => x === 'screen_elements').length, 2);
  eq('and stopped there', c.includes('list_running'), false);

  console.log('\n— a repeated side effect stops before it runs again (unchanged) —');
  c = await runScript([{ tool: 'type_text', args: { text: 'hello' } }, { tool: 'type_text', args: { text: 'hello' } },
    { tool: 'list_running', args: {} }, { tool: 'done', say: 'Done.' }], ['x']);
  eq('typed once', c.filter(x => x === 'type_text').length, 1);
  eq('and stopped there', c.includes('list_running'), false);

  console.log('\n— a repeated tool that is not a listed look (volume) runs once, as before —');
  const realVol = A.TOOLS.volume, vcalls = [];
  A.TOOLS.volume = async () => { vcalls.push('volume'); return { ok: true, say: 'Volume 60%.' }; };
  c = await runScript([{ tool: 'volume', args: { up: true } }, { tool: 'volume', args: { up: true } },
    { tool: 'list_running', args: {} }, { tool: 'done', say: 'Done.' }], ['x']);
  A.TOOLS.volume = realVol;
  eq('volume ran once', vcalls.length, 1);
  eq('and the run stopped there', c.includes('list_running'), false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
