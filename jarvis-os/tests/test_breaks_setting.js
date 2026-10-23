// BREAK REMINDERS — ONE HOME (2026-10-15, his ask: Settings → Break reminders did nothing). The reminder read proactive.json's own
// `breaks` (off) while Settings showed profile.breaks (its default, on). Now profile.breaks is the setting, through
// deps.breaksOn / deps.setBreaks; a value left in proactive.json is carried over once and removed. No profile wired = the old
// file-only behaviour (test_reflective drives that). Stubs only — no model, nothing on the Mac.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PRO = path.join(__dirname, '..', 'proactive.js');
const fresh = () => { delete require.cache[require.resolve(PRO)]; return require(PRO); };

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
function dirWith(state) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'breaks-')); if (state) fs.writeFileSync(path.join(d, 'proactive.json'), JSON.stringify(state)); return d; }
const fileOf = d => JSON.parse(fs.readFileSync(path.join(d, 'proactive.json'), 'utf8'));

async function main() {
  console.log('— the value in force is carried over once —');
  let prof = true; const sets = [];
  let d = dirWith({ enabled: true, breaks: false, fired: [], cooldowns: {}, queue: [] });
  let P = fresh();
  P.init({ stateDir: d, jlog: () => {}, breaksOn: () => prof, setBreaks: on => { sets.push(on); prof = on; } });
  eq('the profile gets the off that was really in force', [P.breaksOn(), sets], [false, [false]]);
  eq('…and proactive.json no longer keeps its own copy', 'breaks' in fileOf(d), false);
  P.breaksOn();
  eq('carried over once, not again', sets, [false]);

  console.log('\n— Settings and the spoken switch are the same switch —');
  prof = true;
  eq('Settings on → the reminder reads on', P.breaksOn(), true);
  let r = P.TOOLS.breaks_set({ enabled: false });
  eq('"turn break reminders off" writes the profile', [r.ok, sets.slice(-1)[0], prof], [true, false, false]);
  eq('…and the reminder reads off', P.breaksOn(), false);
  r = P.TOOLS.breaks_set({});
  eq('no true/false → the state is told, nothing changes', [r.ok, /Break reminders are off/.test(r.say), sets.length], [false, true, 2]);

  console.log('\n— the reminder itself follows the profile —');
  let idle = 0;
  d = dirWith(null); P = fresh(); prof = false;
  P.init({ stateDir: d, jlog: () => {}, breaksOn: () => prof, setBreaks: on => { prof = on; }, idleSeconds: async () => idle, workBeforeBreak: 1, quietHours: [0, 0] });
  eq('off → silent', await P.sigHydration(), null);
  prof = true;
  await P.sigHydration();                                 // seeds the active window
  await new Promise(res => setTimeout(res, 5));
  const fired = await P.sigHydration();
  eq('on (from Settings) → it fires', !!(fired && fired.key === 'break'), true);

  console.log('\n— no profile wired: the old file-only switch (default off) —');
  d = dirWith(null); P = fresh();
  P.init({ stateDir: d, jlog: () => {} });
  eq('default off', P.breaksOn(), false);
  P.TOOLS.breaks_set({ enabled: true });
  eq('breaks_set writes the file', [P.breaksOn(), fileOf(d).breaks], [true, true]);

  console.log('\n— defaults and wiring —');
  const PF = require(path.join(__dirname, '..', 'profile.js'));
  eq('profile default is OFF (opt-in, what the reminder always did)', PF.DEFAULTS.breaks, false);
  const S = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  eq('server passes audit (breaks_set records the change)', /proactive\.init\(\{\n  jlog, audit, stateDir: STATE_DIR,/.test(S), true);
  eq('server wires the profile in', /breaksOn: \(\) => profile\.get\(\)\.breaks === true/.test(S) && /setBreaks: on => profile\.save\(\{ breaks: !!on \}\)/.test(S), true);
  eq('the carry-over runs at boot, after profile.init', /profile\.init\(\{[^\n]*\}\);\nproactive\.breaksOn\(\);/.test(S), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
