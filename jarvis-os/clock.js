'use strict';
// ---------------------------------------------------------------------------
// WHAT THE CLOCK SAYS — here, or in a place he names. (2026-10-10, reader round 6's `time` act; he is away on a trek)
//
// The reader decides THAT he asked the time and cuts the place out of his words (`where`); this file only answers, from
// the Mac's clock. The place is looked up in machine registries, never in a list of words:
//   1. IANA zone ids (Intl.supportedValuesOf + /usr/share/zoneinfo/zone.tab) — every id ends in a city ("Asia/Tokyo").
//   2. /usr/share/zoneinfo/iso3166.tab (country names) → zone.tab (that country's zones): India has one, so it is answered;
//      Canada has several, so he is asked for a city instead of being given a guess.
// A registry name counts only as WHOLE WORDS inside his `where` ("the uk" holds "uk"), the longest match winning.
// A place no registry knows ("mohali", "california") gets an honest answer, never a web guess.
// ---------------------------------------------------------------------------
const fs = require('fs');

const ZI = process.env.JARVIS_ZONEINFO || '/usr/share/zoneinfo';
const flat = s => ' ' + String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';

let _reg = null;
function registry() {
  if (_reg) return _reg;
  const cities = new Map();          // "tokyo" → { zone: "Asia/Tokyo", shown: "Tokyo" }
  const countries = [];              // { name: "india", code: "IN" }
  const byCountry = new Map();       // "IN" → ["Asia/Kolkata"]
  const addZone = z => { const shown = z.split('/').pop().replace(/_/g, ' '), c = shown.toLowerCase(); if (c.length >= 3 && !/^(?:gmt|utc|etc)/.test(c) && !cities.has(c)) cities.set(c, { zone: z, shown }); };
  try { for (const z of Intl.supportedValuesOf('timeZone')) addZone(z); } catch (e) {}
  try {
    for (const line of fs.readFileSync(ZI + '/zone.tab', 'utf8').split('\n')) {
      if (!line || line[0] === '#') continue;
      const [cc, , z] = line.split('\t');
      if (!cc || !z) continue;
      addZone(z);
      if (!byCountry.has(cc)) byCountry.set(cc, []);
      byCountry.get(cc).push(z);
    }
  } catch (e) {}
  try {
    for (const line of fs.readFileSync(ZI + '/iso3166.tab', 'utf8').split('\n')) {
      if (!line || line[0] === '#') continue;
      const [cc, name] = line.split('\t');
      if (!cc || !name) continue;
      // "Britain (UK)" names the same country twice; both are the registry's own words.
      for (const n of name.replace(/[()]/g, '|').split('|').map(x => x.trim()).filter(x => x.length >= 2)) countries.push({ name: n.toLowerCase(), shown: n, code: cc });
    }
  } catch (e) {}
  _reg = { cities: [...cities.entries()].sort((a, b) => b[0].length - a[0].length), countries: countries.sort((a, b) => b.name.length - a.name.length), byCountry };
  return _reg;
}

// → { zone, place } | { many: [zones], place } | null
function zoneFor(where) {
  const w = flat(where);
  if (!w.trim()) return null;
  const r = registry();
  for (const [city, c] of r.cities) if (w.includes(' ' + city + ' ')) return { zone: c.zone, place: c.shown };
  for (const c of r.countries) {
    if (!w.includes(' ' + c.name + ' ')) continue;
    const zs = r.byCountry.get(c.code) || [];
    if (zs.length === 1) return { zone: zs[0], place: c.shown };
    if (zs.length > 1) return { many: zs, place: c.shown };
  }
  return null;
}

const timeIn = (d, zone) => d.toLocaleTimeString('en-IN', Object.assign({ hour: 'numeric', minute: '2-digit', hour12: true }, zone ? { timeZone: zone } : {})).toUpperCase();
const dateIn = (d, zone, year) => d.toLocaleDateString('en-GB', Object.assign({ weekday: 'long', day: 'numeric', month: 'long' }, year ? { year: 'numeric' } : {}, zone ? { timeZone: zone } : {}))
  .replace(/^(\p{L}+),? /u, '$1, ');

// The reply for a reader_time action.
function answer(where, now) {
  const d = now || new Date();
  if (!where || !String(where).trim()) return 'It is ' + timeIn(d) + ', ' + dateIn(d, null, true) + ', Sir.';
  const z = zoneFor(where);
  if (z && z.zone) return 'It is ' + timeIn(d, z.zone) + ' in ' + z.place + ' — ' + dateIn(d, z.zone, false) + ', Sir.';
  if (z && z.many) return z.place + ' has ' + z.many.length + ' time zones, Sir — name a city there and I will tell you.';
  return 'I do not have a time zone for ' + String(where).trim() + ', Sir — name a nearby city and I will tell you.';
}

module.exports = { zoneFor, answer };
