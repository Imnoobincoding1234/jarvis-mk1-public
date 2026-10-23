// MEASUREMENT SCRIPT — the casual/slang stress set through the WHOLE pipeline, in a sandbox that cannot act.
//
// WHY A SANDBOX. POST /api/chat {via:'eval'} only skips memory — it still acts. On 2026-09-27 replaying
// "eh let it be, just open youtube and play a random video" that way opened two YouTube searches in his
// Brave while he watched. This script never talks to the live server. It loads server.js as a module
// (no listen, no background loops) in its own process, and BEFORE loading it replaces every way that
// code can touch the machine:
//
//   child_process   only read-only binaries run (pmset, df, which, uptime, `defaults read`, curl to the
//                   local Ollama, sqlite3 -readonly). Everything else — open, osascript, shortcuts, brew,
//                   `ollama serve` — is RECORDED as "would run" and never started. osascript's one
//                   exception is the Contacts lookup, answered from a FIXTURE address book, not his.
//   http / https    only 127.0.0.1:11434 (Ollama) and :11436 (the llama-server serving jarvis). JarvisControl, Brave,
//                   Composio, the web: recorded, refused.
//   fetch           same rule.
//   fs writes       only inside this run's scratch dir. His state/, logs and caches are never written.
//
// A self-test runs first and the script ABORTS if any of those escapes. What the pipeline tried to do is
// the "would run" record — that plus the reply and the route line is what gets scored (score_casual.js).
//
// Usage: node sweeps/sweep_casual.js [--set ../finetune/data/casual_stress_heldout.jsonl] [--limit N]
//                                     [--only id,id] [--out <file>] [--min-free 15]
// Output: ../finetune/data/casual_runs/<stamp>.jsonl (gitignored), resumable with --out.
'use strict';
const cp = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- arguments ------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', '..');
const SET = path.resolve(arg('--set', path.join(ROOT, 'finetune/data/casual_stress_heldout.jsonl')));
const LIMIT = Number(arg('--limit', 0)) || 0;
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const MIN_FREE = Number(arg('--min-free', 15));
const RUNS = path.join(ROOT, 'finetune/data/casual_runs');
const OUT = path.resolve(arg('--out', path.join(RUNS, new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl')));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sandbox-'));

// Originals, for this script's own use (writing results, reading memory) — captured before patching.
const real = {
  execFile: cp.execFile, execFileSync: cp.execFileSync, spawn: cp.spawn, spawnSync: cp.spawnSync,
  exec: cp.exec, execSync: cp.execSync,
  httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get,
  fetch: globalThis.fetch,
  writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync, mkdirSync: fs.mkdirSync, unlinkSync: fs.unlinkSync,
};
real.mkdirSync(RUNS, { recursive: true });

// ---- the record of what the pipeline tried to do ----------------------------------------------------
let would = [];                           // per item
const note = (kind, detail) => { would.push({ kind, detail: String(detail).slice(0, 400) }); };

// ---- child_process ----------------------------------------------------------------------------------
// Ollama, and the pinned llama-server that serves jarvis (loraserver.js, JARVIS_LORA_PORT, default 11436) — both only
// answer model calls on this Mac.
const LORA_PORT = String(Number(process.env.JARVIS_LORA_PORT) || 11436);
const OLLAMA_URL = new RegExp('^https?://(127\\.0\\.0\\.1|localhost):(11434|' + LORA_PORT + ')/');
function allowedCmd(file, args) {
  const f = String(file || ''); const a = (args || []).map(String);
  const base = path.basename(f);
  if (['pmset', 'df', 'uptime', 'which', 'sw_vers', 'vm_stat', 'memory_pressure', 'ifconfig', 'ipconfig', 'sysctl', 'ps', 'pbpaste'].includes(base)) return true;
  if (base === 'defaults') return a[0] === 'read';
  // Read-only status reads the LIVE prompt depends on (server.js getAgents): refused, every fleet agent looked DOWN and
  // "Jarvis Search is down" rode into ~15 greetings of the 2026-10-10 dev run — a sandbox artifact, not JARVIS's reply.
  if (base === 'pgrep') return true;
  if (base === 'launchctl') return a[0] === 'list' || a[0] === 'getenv';
  if (base === 'sqlite3') return a.includes('-readonly');
  if (base === 'curl') {
    const urls = a.filter(x => /^https?:\/\//.test(x));
    return urls.length > 0 && urls.every(u => OLLAMA_URL.test(u));
  }
  return false;
}
// The Contacts lookup script is JARVIS's own code (agent.js JXA_FIND_CONTACT); recognised by its own text.
const FIXTURE = [
  { name: 'Mama', nick: '', phone: '+919900000001' },
  { name: 'Mera Bhai', nick: 'Bhai', phone: '+919900000002' },
  { name: 'Parth', nick: '', phone: '+919900000003' },
  { name: 'Harsimran', nick: '', phone: '+919900000004' },
  { name: 'Sidhu', nick: '', phone: '+919900000005' },
  { name: 'Ekamveer', nick: '', phone: '+919900000006' },
  { name: 'Nanu', nick: '', phone: '+919900000007' },
];
function fixtureFind(q) {
  const s = String(q || '').toLowerCase().trim();
  const hits = FIXTURE.filter(c => c.name.toLowerCase().includes(s) || (c.nick && c.nick.toLowerCase() === s) || s.includes(c.name.toLowerCase()));
  return JSON.stringify(hits.map(c => ({ name: c.name, nickname: c.nick, phones: [c.phone], emails: [],
    exact: c.name.toLowerCase() === s || c.nick.toLowerCase() === s })));
}
function osaAnswer(args) {
  const a = (args || []).map(String);
  const script = a.find(x => x.includes('function run')) || a.join(' ');
  if (/people\.whose|\.people\(\)|Application\('Contacts'\)|Application\("Contacts"\)/.test(script) && /phones/.test(script)) {
    const q = a[a.length - 1];
    note('contacts-lookup', q);
    return { ok: true, out: fixtureFind(q) };
  }
  return null;
}
// A script's text is JARVIS's own code and says little; its ARGUMENTS (the URL, the app, the text) are the
// decision. So an inline script is recorded by its first line plus everything passed after it.
function denied(file, args) {
  const a = (args || []).map(String);
  const si = a.findIndex(x => /\bfunction run\b|\n/.test(x));
  // Which app the script drives, read from JARVIS's own script text (Application('Reminders') …).
  const apps = si < 0 ? [] : [...new Set((a[si].match(/Application\(['"]([^'"]+)['"]\)/g) || []).map(s => s.replace(/Application\(['"]|['"]\)/g, '')))];
  const tells = si < 0 ? [] : [...new Set((a[si].match(/tell application "([^"]+)"/g) || []).map(s => s.replace(/tell application "|"/g, '')))];
  const shown = si < 0 ? a : a.slice(0, si).concat(['<script apps=' + apps.concat(tells).join('+') + '>'], a.slice(si + 1));
  note('would-run', [path.basename(String(file))].concat(shown).join(' '));
}

cp.execFile = function (file, args, opts, cb) {
  if (typeof args === 'function') { cb = args; args = []; opts = {}; }
  else if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (allowedCmd(file, args)) return real.execFile.call(cp, file, args, opts, cb);
  if (path.basename(String(file)) === 'osascript') {
    const ans = osaAnswer(args);
    if (ans) { setImmediate(() => cb && cb(null, ans.out, '')); return fakeChild(); }
  }
  denied(file, args);
  const err = Object.assign(new Error('sandbox: not run'), { code: 1 });
  setImmediate(() => cb && cb(path.basename(String(file)) === 'osascript' ? err : null, '', ''));
  return fakeChild();
};
cp.execFileSync = function (file, args, opts) {
  if (allowedCmd(file, args)) return real.execFileSync.call(cp, file, args, opts);
  denied(file, args); return Buffer.from('');
};
cp.spawnSync = function (file, args, opts) {
  if (allowedCmd(file, args)) return real.spawnSync.call(cp, file, args, opts);
  denied(file, args); return { status: 1, stdout: '', stderr: 'sandbox', output: [] };
};
// The pinned llama-server that serves jarvis (option 3, runtime/README.md) writes the chat replies — it reads a model and
// changes nothing on the Mac, so the sandbox may start exactly that binary. Refusing it sent every reply to Ollama instead.
const LORA_BIN = path.join(ROOT, 'runtime', 'llama-server');
cp.spawn = function (file, args, opts) {
  if (String(file) === LORA_BIN) return real.spawn.call(cp, file, args, opts);
  denied(file, args); return fakeChild();
};
cp.exec = function (cmd, opts, cb) { if (typeof opts === 'function') cb = opts; denied('sh -c', [cmd]); setImmediate(() => cb && cb(new Error('sandbox'), '', '')); return fakeChild(); };
cp.execSync = function (cmd) { denied('sh -c', [cmd]); return Buffer.from(''); };
function fakeChild() {
  const { EventEmitter } = require('events');
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { write() {}, end() {} };
  c.kill = () => true; c.unref = () => {}; c.pid = 0;
  setImmediate(() => { c.emit('exit', 1); c.emit('close', 1); });
  return c;
}

// ---- network ----------------------------------------------------------------------------------------
function urlOf(a, b) {
  if (typeof a === 'string' || a instanceof URL) return String(a);
  const o = a || {}; const host = o.hostname || o.host || 'localhost';
  return (o.protocol || 'http:') + '//' + host + (o.port ? ':' + o.port : '') + (o.path || '/');
}
function blockedRequest(url) {
  note('would-connect', url);
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.write = () => true; req.end = () => { setImmediate(() => req.emit('error', Object.assign(new Error('sandbox: network blocked'), { code: 'ECONNREFUSED' }))); return req; };
  req.setTimeout = () => req; req.destroy = () => req; req.abort = () => {}; req.on = EventEmitter.prototype.on;
  return req;
}
// READ-ONLY PUBLIC LOOKUPS ARE ALLOWED, and only as GET. Blocking them made "whats the capital of australia"
// fail for the sandbox's reasons, not JARVIS's (baseline 2026-09-27). A GET to an encyclopedia, a search
// page, a weather service or an IP-location service changes nothing on his Mac or in any account. Anything
// that can act — Composio (mail, Slack…), JarvisControl, Brave, any POST — stays blocked and recorded.
const READ_HOSTS = ['en.wikipedia.org', 'html.duckduckgo.com', 'duckduckgo.com', 'news.google.com', 'api.open-meteo.com',
  'geocoding-api.open-meteo.com', 'ipwho.is', 'itunes.apple.com', 'wttr.in'];
function readOnlyOk(u, method) {
  if (method && String(method).toUpperCase() !== 'GET') return false;
  try { return READ_HOSTS.includes(new URL(u).hostname); } catch (e) { return false; }
}
const methodOf = (a, b) => (a && typeof a === 'object' && !(a instanceof URL) && a.method) || (b && typeof b === 'object' && b.method) || 'GET';
http.request = function (a, b, c) { const u = urlOf(a, b); return OLLAMA_URL.test(u) ? real.httpRequest.apply(http, arguments) : blockedRequest(u); };
http.get = function (a, b, c) { const u = urlOf(a, b); if (OLLAMA_URL.test(u)) return real.httpGet.apply(http, arguments); const r = blockedRequest(u); r.end(); return r; };
https.request = function (a, b) { const u = urlOf(a, b); if (readOnlyOk(u, methodOf(a, b))) { note('read', u); return real.httpsRequest.apply(https, arguments); } return blockedRequest(u); };
https.get = function (a, b) { const u = urlOf(a, b); if (readOnlyOk(u, 'GET')) { note('read', u); return real.httpsGet.apply(https, arguments); } const r = blockedRequest(u); r.end(); return r; };
globalThis.fetch = async function (input, init) {
  const u = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (OLLAMA_URL.test(u)) return real.fetch(input, init);
  if (readOnlyOk(u, (init && init.method) || 'GET')) { note('read', u); return real.fetch(input, init); }
  note('would-connect', u);
  throw Object.assign(new TypeError('sandbox: network blocked'), { cause: { code: 'ECONNREFUSED' } });
};

// ---- filesystem writes ------------------------------------------------------------------------------
const inScratch = p => path.resolve(String(p)).startsWith(SCRATCH) || path.resolve(String(p)).startsWith(RUNS);
// EVERY PATH A CALL WRITES TO, not just the first (2026-10-19). rename / copy / link name their DESTINATION second, so
// renameSync(scratch → state/) and copyFileSync(scratch → state/) passed the old first-argument check; cpSync, chmod and
// open-for-writing were not patched at all — system_control's "copy X to Y" really copied, and loraserver appended to
// the live log. Two-path calls need BOTH ends in scratch: moving one of his files INTO scratch removes it from his tree.
const TWO = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']);
const allInScratch = (k, args) => inScratch(args[0]) && (!TWO.has(k.replace(/Sync$/, '')) || inScratch(args[1]));
const SYNC = ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'mkdirSync',
  'symlinkSync', 'linkSync', 'truncateSync', 'chmodSync', 'lchmodSync', 'chownSync', 'lchownSync', 'utimesSync', 'lutimesSync'];
for (const k of SYNC) {
  const orig = fs[k]; if (typeof orig !== 'function') continue;
  fs[k] = function () { if (allInScratch(k, arguments)) return orig.apply(fs, arguments); note('would-write', k + ' ' + [...arguments].slice(0, TWO.has(k.replace(/Sync$/, '')) ? 2 : 1).join(' → ')); return undefined; };
}
const ASYNC = ['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'mkdir', 'symlink', 'link', 'truncate',
  'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes'];
for (const k of ASYNC) {
  const orig = fs[k];
  if (typeof orig === 'function') fs[k] = function () { const cb = arguments[arguments.length - 1];
    if (allInScratch(k, arguments)) return orig.apply(fs, arguments); note('would-write', k + ' ' + arguments[0]); if (typeof cb === 'function') setImmediate(() => cb(null)); };
  const op = fs.promises[k];
  if (typeof op === 'function') fs.promises[k] = async function () { if (allInScratch(k, arguments)) return op.apply(fs.promises, arguments); note('would-write', k + ' ' + arguments[0]); };
}
// OPENING FOR WRITING outside scratch gets a scratch file instead, so the caller's writeSync/closeSync on that fd still
// work and nothing of his changes. Read-only opens pass through. Flags are the machine's own (string or O_* bits).
const WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC;
const writes = f => typeof f === 'number' ? (f & WRITE_BITS) !== 0 : typeof f === 'string' && /[wa+]/.test(f);   // open(p, cb): no flags = read
const devnull = () => path.join(SCRATCH, 'devnull-' + Math.random().toString(36).slice(2));
const routeOpen = (k, args) => { const a = [...args]; if (writes(a[1]) && !inScratch(a[0])) { note('would-write', k + ' ' + a[0]); a[0] = devnull(); } return a; };
const origOpenSync = fs.openSync, origOpen = fs.open, origPOpen = fs.promises.open;
fs.openSync = function () { return origOpenSync.apply(fs, routeOpen('openSync', arguments)); };
fs.open = function () { return origOpen.apply(fs, routeOpen('open', arguments)); };
fs.promises.open = function () { return origPOpen.apply(fs.promises, routeOpen('open', arguments)); };
const origCWS = fs.createWriteStream;
fs.createWriteStream = function (p, o) { if (!inScratch(p)) note('would-write', 'stream ' + p); return origCWS.call(fs, inScratch(p) ? p : path.join(SCRATCH, 'devnull-' + Math.random().toString(36).slice(2)), o); };

// ---- self-test: abort if anything escapes -----------------------------------------------------------
async function selfTest() {
  would = [];
  const probe = path.join(ROOT, 'jarvis-os/state/__sandbox_probe__');
  await new Promise(r => cp.execFile('/usr/bin/open', ['-a', 'Calculator'], () => r()));
  fs.writeFileSync(probe, 'x');
  // Every other way to land a file in his tree (2026-10-19): two-path calls aimed at state/, open-for-append, promises.
  const src = path.join(SCRATCH, 'probe-src'); real.writeFileSync(src, 'x');
  const p = n => probe + '.' + n;
  try { fs.renameSync(src, p('rename')); } catch (e) {}
  try { fs.copyFileSync(src, p('copy')); } catch (e) {}
  try { fs.cpSync(src, p('cp')); } catch (e) {}
  try { fs.linkSync(src, p('link')); } catch (e) {}
  try { const fd = fs.openSync(p('open'), 'a'); fs.writeSync(fd, 'x'); fs.closeSync(fd); } catch (e) {}
  try { await fs.promises.writeFile(p('pwrite'), 'x'); } catch (e) {}
  try { await fs.promises.copyFile(src, p('pcopy')); } catch (e) {}
  try { const h = await fs.promises.open(p('popen'), 'w'); await h.write('x'); await h.close(); } catch (e) {}
  const leaked = fs.readdirSync(path.dirname(probe)).filter(n => n.startsWith(path.basename(probe)));
  if (leaked.length) { for (const n of leaked) try { real.unlinkSync(path.join(path.dirname(probe), n)); } catch (e) {}
    console.error('SANDBOX SELF-TEST FAILED — wrote ' + leaked.join(', ') + ' into state/ (removed) — refusing to run'); process.exit(2); }
  let netBlocked = false; try { await globalThis.fetch('https://example.com/'); } catch (e) { netBlocked = true; }
  let ctlBlocked = false; await new Promise(r => { const q = http.request({ hostname: '127.0.0.1', port: 8765, path: '/show', method: 'POST' }); q.on('error', () => { ctlBlocked = true; r(); }); q.end(); });
  const ok = would.some(w => w.kind === 'would-run' && /open -a Calculator/.test(w.detail)) && !fs.existsSync(probe) && netBlocked && ctlBlocked;
  would = [];
  if (!ok) { console.error('SANDBOX SELF-TEST FAILED — refusing to run'); process.exit(2); }
}

// ---- memory guard -----------------------------------------------------------------------------------
function freePct() {
  try { const o = real.execFileSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 5000 });
    const m = o.match(/free percentage:\s*(\d+)/); return m ? Number(m[1]) : 100; } catch (e) { return 100; }
}

// ---- main -------------------------------------------------------------------------------------------
(async () => {
  await selfTest();
  // Silence and capture the pipeline's log lines per item.
  let lines = [];
  const origLog = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ').replace(/^\[[^\]]+\]\s*/, '')); };
  const J = require('../server.js');
  // server.js starts warmContacts() while it loads — before this fixture exists, so that first read hits
  // the sandboxed osascript and fails. Inject the fixture, then force the cache to take it before item 1.
  const A = require('../agent.js');
  A.init({ contacts: FIXTURE.map(c => ({ name: c.name, nick: c.nick })) });
  await A.warmContacts(true);
  lines = [];

  const items = fs.readFileSync(SET, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    .filter(x => !ONLY.length || ONLY.includes(x.id));
  const done = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { try { done.add(JSON.parse(l).id); } catch (e) {} }
  const todo = items.filter(x => !done.has(x.id)).slice(0, LIMIT || undefined);
  origLog('sandbox ok · ' + todo.length + ' to run · ' + done.size + ' already in ' + path.relative(ROOT, OUT));

  let lowest = 100;
  for (const [n, it] of todo.entries()) {
    const f = freePct(); lowest = Math.min(lowest, f);
    if (f < MIN_FREE) { origLog('free memory ' + f + '% < ' + MIN_FREE + '% — stopping (resume with --out)'); break; }
    try { J._resetTurnState(); } catch (e) {}
    lines = []; would = [];
    const t0 = Date.now();
    let r = null, err = null;
    try {
      r = await Promise.race([
        J.handleChat({ messages: [{ role: 'user', content: it.text }], via: 'eval' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 240s')), 240000)),
      ]);
    } catch (e) { err = String(e && e.message || e); }
    const rec = {
      id: it.id, text: it.text, expect: it.expect, lang: it.lang, tags: it.tags || [],
      ms: Date.now() - t0, freePct: f, err,
      reply: r && (r.reply || r.say) || '',
      confirm: r && r.confirm ? { tool: r.confirm.tool || r.confirm.kind, args: r.confirm.args || null, preview: r.confirm.preview || null } : null,
      action: r && r.action ? r.action : null,
      agent: r && r.agent ? { plan: r.agent.plan || null, results: r.agent.results || null } : null,
      offer: r && r.offer ? r.offer : null, weather: r && r.weather ? r.weather : null,
      route: (lines.find(l => /^Chat › routed → /.test(l)) || '').replace(/^Chat › routed → /, ''),
      would, lines: lines.filter(l => !/^(Time machine|Proactive|Dream) ›/.test(l)).slice(0, 80),
    };
    real.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    origLog(String(n + 1).padStart(3) + '/' + todo.length + ' ' + it.id.padEnd(4) + ' ' + String(rec.ms).padStart(6) + 'ms  ' +
      (rec.route || '?').padEnd(28) + ' ' + JSON.stringify(it.text).slice(0, 50) + (would.length ? '  · would: ' + would.map(w => w.kind).join(',') : ''));
  }
  origLog('done · lowest free ' + lowest + '% · ' + path.relative(ROOT, OUT));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
