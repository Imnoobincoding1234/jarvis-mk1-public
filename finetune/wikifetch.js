'use strict';
// wikifetch.js — polite, cached Wikipedia reads for building jarvis v4.1's grounded rows and held-out (2026-10-04).
// Wikipedia's search API answered 429 after ~24 calls at 0.9 s apart, so: one call at a time, 2.5 s apart, backing
// off 30/60/120 s on 429, and a cache (data/wiki_cache.json) so a rerun never refetches. Read-only GETs to
// en.wikipedia.org only. The source text itself is composed by jarvis-os/grounded.js fromWikipedia — the live contract.
const fs = require('fs');
const path = require('path');
const G = require('../jarvis-os/grounded');

const CACHE = path.join(__dirname, 'data', 'wiki_cache.json');
const UA = 'JARVIS-MK1-finetune/1.0 (personal assistant; low-volume research script)';
let cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let last = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  if (cache[url]) return cache[url];
  for (const back of [0, 30000, 60000, 120000]) {
    if (back) { process.stdout.write('  (429 — waiting ' + back / 1000 + ' s)\n'); await wait(back); }
    const gap = 2500 - (Date.now() - last); if (gap > 0) await wait(gap);
    last = Date.now();
    let r;
    try { r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } }); }
    catch (e) { process.stdout.write('  (network: ' + e.message + ' — retrying)\n'); continue; }   // a dropped connection is retried like a 429
    if (r.status === 429) continue;
    if (r.status === 404) { cache[url] = { missing: true }; break; }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    cache[url] = await r.json();
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    return cache[url];
  }
  return cache[url] || null;
}

// q → { hits, summary, source } (source = grounded.fromWikipedia), or null when nothing was found
async function lookup(q, opts) {
  const s = await getJson('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + encodeURIComponent(q));
  const hits = (s && s.query && s.query.search) || [];
  if (!hits.length) return null;
  const title = (opts && opts.page) || hits[0].title;
  const sum = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
  if (!sum || sum.missing || !sum.extract) return null;
  return { hits, summary: { title: sum.title, extract: sum.extract }, source: G.fromWikipedia(hits, sum) };
}

module.exports = { lookup, getJson };
