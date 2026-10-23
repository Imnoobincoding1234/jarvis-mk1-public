'use strict';
// ---------------------------------------------------------------------------
// PROVIDER CANARY — does each thing JARVIS depends on still actually answer?
//
// WHY THIS EXISTS. html.duckduckgo.com quietly started serving an anti-bot landing page with zero
// results. ddgHtmlSearch returns an empty array when it cannot parse, so every search fell through
// to the Wikipedia + Google News fallback WITHOUT A SINGLE LINE IN THE LOG. Deep research became
// "summarise Wikipedia" and nothing anywhere said so. It was found by hand, weeks later, only
// because a research answer looked thin.
//
// A dependency that fails LOUDLY gets fixed the same day. This exists to convert the silent kind
// into the loud kind: one real query through each provider, and a notification the moment one stops
// returning anything.
//
// It only ever READS. No writes, no side effects, nothing that can break what it is checking.
// Zero dependencies, like everything else here.
// ---------------------------------------------------------------------------

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(process.env.HOME, 'JARVIS MK-1');
const OS_DIR = path.join(ROOT, 'jarvis-os');
const STATE = path.join(OS_DIR, 'state', 'canary.json');

// LOCAL TIME, to match verify.sh's `date '+%Y-%m-%d %H:%M:%S'`.
//
// toISOString() is UTC, so on an IST machine every canary line was stamped 5h30m in the past and sat
// in the log looking like yesterday's run next to integrity checks stamped local. A fresh 6/6 was
// misread as a stale log tail during a handoff, and the only thing that settled it was running the
// canary again and watching the "old" timestamp advance. A health check whose own clock makes you
// distrust a good result is worse than no timestamp. Built by hand rather than via toLocaleString so
// it cannot depend on which ICU data this Node was built with.
const now = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};
const log = m => console.log('[' + now() + '] ' + m);

function envVal(key) {
  try {
    const t = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of t.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim();
    }
  } catch (e) {}
  return '';
}

function get(url, timeoutMs, headers) {
  return new Promise(resolve => {
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: Object.assign({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, headers || {}) }, res => {
      let b = '';
      res.on('data', d => { b += d; if (b.length > 400000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.setTimeout(timeoutMs || 15000, () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

function postJson(url, body, timeoutMs, headers) {
  return new Promise(resolve => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {}) },
      res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.setTimeout(timeoutMs || 20000, () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.write(data); req.end();
  });
}

// ---------------- the checks ----------------
// Each returns { name, ok, detail }. "ok" means it returned USABLE CONTENT, not merely HTTP 200 —
// the whole failure being guarded against answered 200 with a page containing no results.
const CHECKS = [
  {
    name: 'web-search (composio)',
    why: 'the primary provider for research and every "look this up"',
    async run() {
      const key = envVal('COMPOSIO_API_KEY');
      if (!key) return { ok: false, detail: 'no COMPOSIO_API_KEY in .env' };
      const r = await postJson('https://backend.composio.dev/api/v3/tools/execute/COMPOSIO_SEARCH_SEARCH',
        { arguments: { query: 'augmented reality glasses power consumption' } }, 45000, { 'x-api-key': key });
      if (r.status !== 200) return { ok: false, detail: 'HTTP ' + r.status };
      const hits = (r.body.match(/"link"\s*:/g) || []).length;
      return { ok: hits >= 3, detail: hits + ' result links' };
    },
  },
  {
    name: 'web-search (duckduckgo scrape)',
    why: 'the local fallback — already known dead, tracked so a recovery is noticed',
    expectedDead: true,
    async run() {
      const r = await get('https://html.duckduckgo.com/html/?q=augmented+reality+glasses', 15000);
      const hits = (r.body.match(/result__a/g) || []).length;
      return { ok: hits >= 3, detail: hits + ' results in ' + r.body.length + ' bytes' };
    },
  },
  {
    name: 'wikipedia',
    why: 'grounding for encyclopedic questions',
    async run() {
      const r = await get('https://en.wikipedia.org/api/rest_v1/page/summary/Augmented_reality', 12000);
      let extract = '';
      try { extract = (JSON.parse(r.body) || {}).extract || ''; } catch (e) {}
      return { ok: extract.length > 200, detail: extract.length + ' chars' };
    },
  },
  {
    name: 'weather',
    why: 'the briefing and "what is the weather" both read it',
    async run() {
      const r = await get('https://api.open-meteo.com/v1/forecast?latitude=30.74&longitude=76.65&current_weather=true', 12000);
      let temp = null;
      try { temp = ((JSON.parse(r.body) || {}).current_weather || {}).temperature; } catch (e) {}
      return { ok: temp != null, detail: temp != null ? temp + '°C' : 'no reading' };
    },
  },
  {
    name: 'ollama models',
    why: 'chat and vision both run locally; a missing model degrades everything silently',
    async run() {
      const r = await get('http://127.0.0.1:11434/api/tags', 8000);
      let names = [];
      try { names = ((JSON.parse(r.body) || {}).models || []).map(m => m.name); } catch (e) {}
      const want = ['qwen2.5:3b-instruct-q4_K_M', 'qwen3-vl:2b'];
      const missing = want.filter(w => !names.some(n => n.startsWith(w.split(':')[0]) && n.includes(w.split(':')[1] || '')));
      return { ok: names.length > 0 && !missing.length,
               detail: names.length + ' installed' + (missing.length ? ', MISSING: ' + missing.join(', ') : '') };
    },
  },
  {
    name: 'jarvis-os server',
    why: 'everything else is moot if the service is not answering',
    async run() {
      const r = await get('http://127.0.0.1:8787/', 8000);
      return { ok: r.status === 200, detail: 'HTTP ' + r.status };
    },
  },
];

// ---------------- notification ----------------
// Only on a CHANGE. A canary that notifies every day about the same known-dead provider is a canary
// nobody reads, and then the one that matters is missed too.
function notify(title, body) {
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-e',
      'display notification ' + JSON.stringify(body) + ' with title ' + JSON.stringify(title)],
      { timeout: 8000 }, () => resolve());
  });
}

(async () => {
  const results = [];
  for (const c of CHECKS) {
    let r;
    try { r = await c.run(); } catch (e) { r = { ok: false, detail: 'threw: ' + (e.message || e) }; }
    results.push({ name: c.name, ok: !!r.ok, detail: r.detail || '', why: c.why, expectedDead: !!c.expectedDead });
    log((r.ok ? 'OK   ' : 'DOWN ') + c.name.padEnd(30) + ' ' + (r.detail || ''));
  }

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) {}
  const prevOk = prev.byName || {};

  // Newly broken is what deserves an interruption. Recovery is worth saying too — it is how you learn
  // a workaround can be removed.
  const broke = results.filter(r => !r.ok && prevOk[r.name] === true);
  const fixed = results.filter(r => r.ok && prevOk[r.name] === false);
  const downNow = results.filter(r => !r.ok && !r.expectedDead);

  if (broke.length) {
    await notify('JARVIS: a provider just went down',
      broke.map(r => r.name + ' — ' + r.detail).join('; ').slice(0, 200));
    log('NOTIFIED: newly down — ' + broke.map(r => r.name).join(', '));
  } else if (fixed.length) {
    await notify('JARVIS: a provider recovered', fixed.map(r => r.name).join(', ').slice(0, 200));
    log('NOTIFIED: recovered — ' + fixed.map(r => r.name).join(', '));
  }

  const byName = {};
  for (const r of results) byName[r.name] = r.ok;
  try {
    fs.writeFileSync(STATE, JSON.stringify({ at: Date.now(), checkedAt: now(), byName, results }, null, 2));
  } catch (e) { log('could not write ' + STATE + ': ' + e.message); }

  log('summary: ' + results.filter(r => r.ok).length + '/' + results.length + ' healthy' +
      (downNow.length ? ' — DOWN: ' + downNow.map(r => r.name).join(', ') : ''));
  process.exit(0);
})();
