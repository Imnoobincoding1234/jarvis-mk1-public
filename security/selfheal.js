'use strict';
// ---------------------------------------------------------------------------
// JARVIS self-healing supervisor.
//
// WHAT THIS HONESTLY DOES, and what it does not.
//
// It does NOT fix bugs in source code. Nothing here reads, patches or rewrites a line of an agent —
// a program that edits its own logic while running unattended is not self-healing, it is an
// unreviewed committer with root on Atharv's Mac. What it fixes is the class of failure that actually
// took agents down here, all of which are process-level and all of which a restart clears:
//
//   1. DEAD          — the agent is not running at all.
//   2. CRASHED       — launchd reports a non-zero last exit; it died and may be looping.
//   3. WEDGED        — the process exists but is spinning. JarvisSearch sat at 33% CPU for FOUR DAYS
//                      while JARVIS OS cheerfully reported it "running", because the check was "does
//                      a pid exist". ⌘9 did nothing that whole time.
//   4. UNRESPONSIVE  — the process exists and is calm, but its port does not answer. Liveness is
//                      whether it does its job, not whether it holds a pid.
//   5. BLOATED       — a helper an agent depends on has leaked. Not the agent itself: Apple's
//                      localspeechrecognition XPC, which the wake-word listener holds open, grew to
//                      a 2.5 GB footprint with a 7.3 GB peak over four days on an 8 GB machine —
//                      2.2 GB of it sitting in swap. Measured against its siblings, the leak only
//                      happens under CONTINUOUS recognition: instances used episodically were
//                      24-46 MB after eighteen days, while the one the listener kept alive ran away.
//                      Killing it recovered 2 GB of swap and macOS released a whole swap file; the
//                      XPC relaunched on demand and the wake word fired again within the minute.
//
// Both real incidents this week were in that list, and both were found by hand. Now they are not.
//
// BOUNDED ON PURPOSE. Three restarts per agent per hour, then it stops trying and says so. An agent
// that needs restarting every ten minutes has a bug a restart will not fix, and hammering it hides
// exactly the signal someone needs to see. Refusing to loop is part of the design, not a limitation.
// ---------------------------------------------------------------------------

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ROOT = path.join(HOME, 'JARVIS MK-1');
const STATE = path.join(ROOT, 'security', 'selfheal.json');
const LOG = path.join(ROOT, 'security', 'selfheal.log');
const UID = String(process.getuid());

const MAX_HEALS_PER_HOUR = 3;
const CPU_SAMPLES = 3;
const CPU_GAP_MS = 2000;
const HEAL_SETTLE_MS = 8000;   // time for a kickstarted/relaunched agent to get a pid and open its port

// ONCE. launchd points this job's stdout at selfheal.log too, so writing the file AND the console put every
// line in the log twice (2026-10-01: 254 "HEALED claplistener" lines were 127 events). The console copy is
// for a person running it by hand, i.e. a terminal.
function log(s) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + s;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  if (process.stdout.isTTY) console.log(line);
}
function sh(cmd, args) {
  try { return String(execFileSync(cmd, args, { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim(); }
  catch (e) { return ''; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- the agents, and what "healthy" means for each ----------------
// idleCpu is what this agent looks like when it is behaving. JARVIS OS is allowed to work hard — it
// runs real requests — so it is judged on whether its port answers, not on load.
const AGENTS = [
  { id: 'jarvisos',       label: 'com.atharv.jarvisos',       idleCpu: 90, probe: { port: 8787, path: '/' } },
  { id: 'jarviscontrol',  label: 'com.atharv.jarviscontrol',  idleCpu: 40, probe: { port: 8765, path: '/status' } },
  { id: 'claplistener',   label: 'com.atharv.claplistener',   idleCpu: 60 },   // taps the mic; some load is normal
  { id: 'focusguard',     label: 'com.atharv.focusguard',     idleCpu: 40 },
  // Not a launchd job — a real .app. It is here because it is the one that actually wedged.
  { id: 'jarvissearch',   app: path.join(ROOT, 'Jarvis Search', 'Jarvis Search.app'), match: 'JarvisSearch', idleCpu: 25 },
];

function launchdInfo(label) {
  const line = sh('/bin/launchctl', ['list']).split('\n').find(l => l.endsWith('\t' + label) || l.split('\t').pop() === label);
  if (!line) return { listed: false };
  const [pid, exit] = line.split('\t');
  return { listed: true, pid: pid === '-' ? null : Number(pid), lastExit: Number(exit) };
}
function pidOfApp(match) {
  const out = sh('/usr/bin/pgrep', ['-f', match]);
  const p = out.split('\n').filter(Boolean)[0];
  return p ? Number(p) : null;
}
function cpuOf(pid) {
  const v = sh('/bin/ps', ['-o', '%cpu=', '-p', String(pid)]);
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}
// Sustained, not instantaneous. A single sample catches a process mid-work and calls it wedged.
async function sustainedCpu(pid) {
  const s = [];
  for (let i = 0; i < CPU_SAMPLES; i++) { s.push(cpuOf(pid)); if (i < CPU_SAMPLES - 1) await sleep(CPU_GAP_MS); }
  return Math.min.apply(null, s);      // the FLOOR — every sample had to be high
}
function probe(p) {
  return new Promise(resolve => {
    const req = require('http').request(
      { host: '127.0.0.1', port: p.port, path: p.path, method: 'GET', timeout: 5000 },
      res => { res.resume(); resolve(res.statusCode > 0); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(false); });
    req.end();
  });
}

// ---------------- leaked helpers ----------------
// THE AGENT IS FINE; THE THING IT LEANS ON IS NOT. Every check above asks whether one of Atharv's
// own processes is unwell. This asks a different question: has a system helper that one of them
// keeps alive grown to a size that hurts an 8 GB machine.
//
// Only localspeechrecognition qualifies today, and it qualifies on measurement rather than
// suspicion — see the BLOATED note at the top. It is an XPC service with `Idle exit: clean`, so it
// would normally exit when unused; the wake-word listener starts a fresh recognition task every 50s,
// which is often enough that it never idles long enough to exit, and so it accumulates for days.
//
// The client-side fix already exists and is not enough: ClapListener recycles its recognition task
// on a 50s cadence precisely because "on-device tasks accumulate memory". That bounds the TASK, not
// the XPC process behind it, which is where the memory actually piles up.
//
// Killing it is safe and cheap: launchd restarts it on the next recognition request, it comes back
// at ~24 MB, and the only cost is that a wake word spoken during the restart is missed.
const HELPERS = [
  { id: 'localspeechrecognition', match: 'localspeechrecognition.xpc',
    // 600 MB. Healthy instances measured 24-46 MB even after eighteen days, and the runaway was
    // 2.5 GB — the two populations are three orders of magnitude apart, so the threshold sits in a
    // gap rather than on a guess. High enough that a busy-but-healthy instance is never killed.
    // Overridable so the threshold can be exercised against a live process — a reaper that has never
    // been seen to fire is a reaper nobody should trust.
    maxMB: Number(process.env.JARVIS_SPEECH_MAX_MB) || 600,
    why: 'held open by the wake-word listener; leaks under continuous recognition' },
];

// Physical footprint, which is what Activity Monitor shows and what actually costs the machine —
// NOT rss. The runaway instance reported 398 MB rss while its footprint was 2.5 GB, so judging this
// on rss would have missed it entirely.
function footprintMB(pid) {
  const out = sh('/usr/bin/vmmap', ['-summary', String(pid)]);
  const m = out.match(/^Physical footprint:\s+([\d.]+)([KMG])/m);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === 'G' ? n * 1024 : m[2] === 'K' ? n / 1024 : n;
}

function checkHelpers(st) {
  const out = [];
  for (const h of HELPERS) {
    const pids = sh('/usr/bin/pgrep', ['-f', h.match]).split('\n').filter(Boolean).map(Number);
    for (const pid of pids) {
      let mb = 0;
      try { mb = footprintMB(pid); } catch (e) { continue; }
      if (mb < h.maxMB) continue;
      // Bounded exactly like agent healing: a helper that needs killing every few minutes has
      // something else wrong, and hammering it would hide that.
      const heals = recentHeals(st, h.id);
      if (heals.length >= MAX_HEALS_PER_HOUR) {
        log('❌ ESCALATE ' + h.id + ' — ' + Math.round(mb) + ' MB and already reaped ' +
            heals.length + ' times this hour. This needs a person.');
        out.push({ id: h.id, ok: false, escalated: true });
        continue;
      }
      try { sh('/bin/kill', [String(pid)]); } catch (e) { continue; }
      st[h.id] = { heals: heals.concat(Date.now()), lastFault: Math.round(mb) + ' MB', at: Date.now() };
      log('⚠ REAPED ' + h.id + ' pid ' + pid + ' — ' + Math.round(mb) + ' MB footprint (' + h.why +
          '). It relaunches on demand.');
      out.push({ id: h.id, ok: false, healed: true });
    }
  }
  return out;
}

// ---------------- healing ----------------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch (e) {} }

function recentHeals(st, id) {
  const cutoff = Date.now() - 3600000;
  return ((st[id] && st[id].heals) || []).filter(t => t > cutoff);
}

function heal(agent) {
  if (agent.label) {
    sh('/bin/launchctl', ['kickstart', '-k', 'gui/' + UID + '/' + agent.label]);
    return 'kickstart';
  }
  // An .app: kill it, then relaunch. `open` on an already-running app does nothing, which is exactly
  // how a wedged one survives a naive "just open it again".
  const pid = pidOfApp(agent.match);
  if (pid) { sh('/bin/kill', [String(pid)]); }
  execFile('/usr/bin/open', ['-a', agent.app], () => {});
  return 'relaunch';
}

async function checkAgent(agent, st) {
  const info = agent.label ? launchdInfo(agent.label) : { listed: true, pid: pidOfApp(agent.match), lastExit: 0 };
  const faults = [];

  // NOT LOADED IS A DECISION, NOT A FAULT. A KeepAlive agent that crashes stays in launchd's list (with a
  // last exit) and launchd itself restarts it; it only leaves the list when someone boots it out on purpose
  // — `launchctl bootout`, an uninstall.sh, or Atharv muting the listener for a training run. Kickstarting
  // an unloaded label does nothing, and this script used to log "HEALED" anyway: 127 false heals of
  // claplistener between 2026-09-27 and 10-01 while it stayed (correctly) off. Logged once per change.
  if (agent.label && !info.listed) {
    if (!(st[agent.id] && st[agent.id].off)) {
      log('⏸ ' + agent.id + ' is not loaded in launchd — treated as switched off on purpose; not touching it');
      st[agent.id] = Object.assign({}, st[agent.id], { off: true, at: Date.now() });
    }
    return { id: agent.id, ok: true, off: true };
  }
  if (st[agent.id] && st[agent.id].off) {
    log('▶ ' + agent.id + ' is loaded again — watching it');
    delete st[agent.id].off;
  }

  if (!info.pid) faults.push('not running');

  if (info.pid) {
    const cpu = await sustainedCpu(info.pid);
    if (cpu > agent.idleCpu) faults.push('spinning at ' + cpu.toFixed(0) + '% CPU');
    if (agent.probe && !(await probe(agent.probe))) faults.push('port ' + agent.probe.port + ' not answering');
  }

  // A NON-ZERO LAST EXIT IS HISTORY, NOT A SYMPTOM.
  //
  // launchctl reports `last exit` for the PREVIOUS run and keeps reporting it forever, so a perfectly
  // healthy agent carries one indefinitely. Treating it as a live fault made this script restart a
  // working app — which terminates it with SIGTERM, writing a fresh `last exit -15`, which the next
  // cycle read as new evidence. Measured on jarviscontrol: healed at 15:46, 15:52 and 15:57 while
  // running, answering :8765 and holding its Accessibility grant the whole time, until it escalated
  // to "this needs a person". The only thing wrong was this check.
  //
  // -15 is SIGTERM: that is what a kickstart, a logout or a reboot looks like, i.e. a normal stop.
  // So the exit code is only evidence when something else already says the agent is unwell.
  if (info.lastExit && info.lastExit !== -15 && faults.length) faults.push('last exit ' + info.lastExit);
  if (info.lastExit && !info.pid) faults.push('last exit ' + info.lastExit);

  if (!faults.length) return { id: agent.id, ok: true };

  // jarvissecurity is deliberately absent from AGENTS: it is a periodic job that EXITS, and a
  // non-zero exit from it means integrity drift — a message for a human, never something to restart.
  const heals = recentHeals(st, agent.id);
  if (heals.length >= MAX_HEALS_PER_HOUR) {
    log('\u274c ESCALATE ' + agent.id + ' — ' + faults.join('; ') + ' — already healed ' + heals.length +
        ' times this hour, leaving it alone. This needs a person.');
    return { id: agent.id, ok: false, escalated: true, faults };
  }

  const how = heal(agent);
  st[agent.id] = { heals: heals.concat(Date.now()), lastFault: faults.join('; '), at: Date.now() };
  // A HEAL IS WHAT HAPPENED, NOT WHAT WAS TRIED. Re-check after the restart has had time to land: a pid,
  // and for agents with a port, an answer on it. Only that is "HEALED".
  await sleep(HEAL_SETTLE_MS);
  const after = agent.label ? launchdInfo(agent.label) : { pid: pidOfApp(agent.match) };
  const answers = !agent.probe || (after.pid && await probe(agent.probe));
  if (after.pid && answers) {
    log('\u26a0 HEALED ' + agent.id + ' via ' + how + ' — was: ' + faults.join('; ') + ' — now running (pid ' + after.pid + ')');
    return { id: agent.id, ok: false, healed: true, faults };
  }
  log('\u2717 HEAL FAILED ' + agent.id + ' via ' + how + ' — was: ' + faults.join('; ') + ' — still ' +
      (after.pid ? 'not answering on port ' + agent.probe.port : 'not running') + ' after ' + (HEAL_SETTLE_MS / 1000) + ' s');
  return { id: agent.id, ok: false, healed: false, faults };
}

(async () => {
  const st = loadState();
  const results = [];
  for (const a of AGENTS) {
    try { results.push(await checkAgent(a, st)); }
    catch (e) { log('check failed for ' + a.id + ': ' + e.message); }
  }
  try { results.push(...checkHelpers(st)); } catch (e) { log('helper check failed: ' + e.message); }
  saveState(st);
  const bad = results.filter(r => !r.ok);
  if (!bad.length) log('all ' + AGENTS.length + ' agents healthy, helpers within limits');
  process.exit(0);
})();
