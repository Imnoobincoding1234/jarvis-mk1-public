// find_businesses — the place he named, `once`, and no learning from a walled run (2026-10-15, his live turn "find resturants
// near me without a website": the planner wrote where="around me" (Nominatim: a theatre in Iraq), called the tool twice, and
// JARVIS learned the double call). Stubbed geocoder/finder/location and a scripted model — no network, nothing touched.
'use strict';
const path = require('path');
const A = require(path.join(__dirname, '..', 'agent.js'));
const BF = require(path.join(__dirname, '..', 'businessfinder.js'));
const SC = require(path.join(__dirname, '..', 'system_control.js'));

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
const HOME = { lat: 19.9975, lon: 73.7898, label: 'Mohali', ageDays: 1 };
const realGeo = BF.geocode, realFind = BF.find;
let asked = null;
BF.find = async q => { asked = q; return { ok: true, places: [], say: 'none', notes: [] }; };
const MAP = { 'around me': 'شارع الحولي, الدوّاية, Iraq', 'near me': 'near Felipe, Ciudad Obregón, Cajeme, Sonora, México',
  'sector 70 mohali': 'Sector 70, Mohali, S.A.S. Nagar, Punjab, India', 'elante mall': 'Nexus Elante Mall, Purv Marg, Chandigarh' };
BF.geocode = async w => MAP[w] ? { name: MAP[w], bbox: [0, 0, 1, 1] } : null;
A.init({ jlog: () => {}, audit: () => {}, lean: () => true, envVal: () => '', fuzzyApp: SC.fuzzyApp, whereAmI: async () => HOME });

async function main() {
  console.log('— the place he named —');
  let r = await A.TOOLS.find_businesses({ what: 'restaurants', where: 'around me', withoutWebsite: true }, { goal: 'find resturants near me without a website' });
  eq('"around me" is not in what he said → searched around him', [asked.where, !!asked.near], ['', true]);
  eq('…and the reply does not claim a place he never named', /around me/.test(r.say || ''), false);
  r = await A.TOOLS.find_businesses({ what: 'restaurants', where: 'near me' }, { goal: 'find resturants near me without a website' });
  eq('"near me" is in his words but the map’s match is a park in Mexico → around him', [asked.where, !!asked.near], ['', true]);
  eq('…and the reply says it could not find it on the map', /could not find "near me" on the map/.test(r.say || ''), true);
  r = await A.TOOLS.find_businesses({ what: 'shops', where: 'sector 70 mohali' }, { goal: 'find shops in sector 70 mohali without a website' });
  eq('a place he named that the map knows is kept', [asked.where, asked.near], ['sector 70 mohali', null]);
  r = await A.TOOLS.find_businesses({ what: 'restaurants', where: 'elante mall' }, { goal: 'restaurants in elante mall with no website' });
  eq('a named mall the map knows is kept', asked.where, 'elante mall');
  r = await A.TOOLS.find_businesses({ what: 'restaurants' }, { goal: 'restaurants around me' });
  eq('no where at all → around him (unchanged)', [asked.where, !!asked.near], ['', true]);

  console.log('\n— once, and no learning from a walled run —');
  const calls = [];
  BF.find = async q => { calls.push(q); return { ok: true, places: [], say: 'none', notes: [] }; };
  const learned = [];
  const script = [{ tool: 'find_businesses', args: { what: 'restaurants', withoutWebsite: true } },
    { tool: 'find_businesses', args: { what: 'restaurants', withoutWebsite: true, needPhone: true } }, { tool: 'done', say: 'Done.' }];
  let i = 0;
  A.init({ llm: async () => ({ text: JSON.stringify(script[Math.min(i++, script.length - 1)]) }), jlog: () => {}, audit: () => {},
    lean: () => true, envVal: () => '', fuzzyApp: SC.fuzzyApp, whereAmI: async () => HOME,
    learned: { replayable: () => null, candidate: () => null, learn: (g, s) => learned.push(g), failed: () => {}, fillSlots: s => s } });
  A.registerPlaybook(async () => ({ lines: ['Call find_businesses ONCE.', 'Reply with what it returned.'], tools: null, specs: [], once: ['find_businesses'] }));
  const run = await A.runGoal('find resturants near me without a website', { allowTools: ['find_businesses'], strictTools: true, autoApprove: true });
  eq('find_businesses ran once', calls.length, 1);
  eq('the run still reports its answer', !!(run && run.say), true);
  eq('a walled run learns no procedure', learned.length, 0);

  A.registerPlaybook(async () => []);
  BF.geocode = realGeo; BF.find = realFind;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
