'use strict';
// worldlive.js — the World Monitor's live layers (phase 1, 2026-10-14, his go: "run phase 1"). Every source here is
// KEYLESS and public — nothing to sign up for, nothing that has to be shipped. Ideas from God's Eye View (free edition,
// MIT, github.com/electronictechshow-netizen/gods-eye-view-free); the code is ours, zero-dependency like the rest.
//
//   flights    OpenSky Network /states/all, anonymous. Anonymous callers get ~400 credits a day and a global snapshot
//              costs 4, so ONE snapshot every 16 minutes stays inside it; the globe moves each aircraft along its own
//              heading and speed in between ("positions extrapolated from the HH:MM snapshot").
//   military   adsb.lol /v2/mil — aircraft broadcasting with a military flag. 60 s.
//   satellites CelesTrak GP element sets (TLE) by group. CelesTrak asks callers not to re-download a group within two
//              hours; it is fetched at most every 12 hours and kept on disk. The browser propagates positions (SGP4,
//              vendor/satellite.min.js).
//   launches   The Space Devs, Launch Library 2 (v2.3). Keyless callers get 15 calls an hour: refreshed hourly.
//   cyclones   NOAA National Hurricane Center CurrentStorms.json (Atlantic, East and Central Pacific; elsewhere GDACS,
//              already in the World Monitor, carries tropical cyclones). 30 minutes.
//   point      what is at a clicked spot: Open-Meteo current weather, OpenStreetMap Nominatim place name (its policy:
//              an identifying User-Agent and at most one request a second), Wikipedia articles within 10 km. Cached
//              per ~1 km cell for 10 minutes.
//
// Rules for every source: one request in flight at a time (callers share it), a minimum interval, backoff on errors
// and 429s, and the last good answer kept — on disk too, so a restart never hammers anyone.
const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'JARVIS-MK1-world-monitor/1.0 (personal, non-commercial; github.com/Imnoobincoding1234)';
const deps = { jlog: () => {}, stateDir: null };
function init(d) { Object.assign(deps, d || {}); }

function get(url, timeoutMs, accept) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': UA, accept: accept || 'application/json' }, timeout: timeoutMs || 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(new URL(res.headers.location, url).href, timeoutMs, accept).then(resolve, reject); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(Object.assign(new Error('HTTP ' + res.statusCode + ' from ' + new URL(url).host), { status: res.statusCode }));
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const getJson = (url, t) => get(url, t).then(b => JSON.parse(b));

// ---- a cached source: minimum interval, shared in-flight fetch, backoff, last good value (memory + disk) ----
function source(name, minMs, backoffMs, fetcher) {
  const s = { name, minMs, backoffMs, fetcher, at: 0, value: null, err: null, until: 0, inflight: null };
  const file = () => deps.stateDir ? path.join(deps.stateDir, 'world_cache', name + '.json') : null;
  s.load = () => {
    if (s.value || !file()) return;
    try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); s.value = j.value; s.at = j.at || 0; } catch (e) {}
  };
  s.save = () => {
    if (!file()) return;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = file() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ at: s.at, value: s.value })); fs.renameSync(tmp, file());
    } catch (e) {}
  };
  s.get = async (force) => {
    s.load();
    const now = Date.now();
    const fresh = s.value && now - s.at < s.minMs;
    if ((fresh && !force) || now < s.until) return { value: s.value, at: s.at, stale: !fresh, err: s.err };
    if (!s.inflight) {
      s.inflight = (async () => {
        try { s.value = await s.fetcher(); s.at = Date.now(); s.err = null; s.save(); }
        catch (e) {
          s.err = String(e.message || e);
          s.until = Date.now() + (e.status === 429 || e.status === 403 ? s.backoffMs * 2 : s.backoffMs);
          deps.jlog('World › ' + name + ' failed (' + s.err.slice(0, 80) + ') — keeping the last good copy');
        } finally { s.inflight = null; }
      })();
    }
    await s.inflight;
    return { value: s.value, at: s.at, stale: !s.value || Date.now() - s.at >= s.minMs, err: s.err };
  };
  s.peek = () => { s.load(); return { value: s.value, at: s.at }; };
  return s;
}
const r4 = x => Math.round(x * 1e4) / 1e4;

// ---- flights: OpenSky, anonymous, one global snapshot per 16 minutes ----
const flights = source('flights', 16 * 60000, 30 * 60000, async () => {
  const j = await getJson('https://opensky-network.org/api/states/all', 45000);
  const rows = [];
  for (const s of j.states || []) {
    // [icao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_alt, on_ground, velocity, track, …, geo_alt]
    if (s[5] == null || s[6] == null || s[8]) continue;
    rows.push([s[0], String(s[1] || '').trim(), r4(s[6]), r4(s[5]), Math.round(s[13] != null ? s[13] : (s[7] || 0)),
      Math.round((s[9] || 0) * 10) / 10, Math.round(s[10] || 0), s[2] || '']);
  }
  return { snapshot: (j.time || Math.floor(Date.now() / 1000)) * 1000, fields: ['icao', 'callsign', 'lat', 'lon', 'alt_m', 'speed_ms', 'track', 'country'], rows };
});

// ---- military: adsb.lol ----
const military = source('military', 60000, 5 * 60000, async () => {
  const j = await getJson('https://api.adsb.lol/v2/mil', 20000);
  const rows = [];
  for (const a of j.ac || []) {
    if (a.lat == null || a.lon == null || a.alt_baro === 'ground') continue;
    const ft = typeof a.alt_geom === 'number' ? a.alt_geom : typeof a.alt_baro === 'number' ? a.alt_baro : 0;
    rows.push([a.hex, String(a.flight || '').trim(), r4(a.lat), r4(a.lon), Math.round(ft * 0.3048),
      Math.round((a.gs || 0) * 0.514444 * 10) / 10, Math.round(a.track || 0), a.t || '', a.r || '']);
  }
  return { snapshot: j.now || Date.now(), fields: ['hex', 'callsign', 'lat', 'lon', 'alt_m', 'speed_ms', 'track', 'type', 'reg'], rows };
});

// ---- satellites: CelesTrak TLE groups, at most every 12 hours each ----
const SAT_GROUPS = ['stations', 'visual', 'gnss', 'weather', 'geo', 'starlink'];
const satSources = Object.fromEntries(SAT_GROUPS.map(g => [g, source('tle_' + g, 12 * 3600000, 2 * 3600000,
  async () => {
    const t = await get('https://celestrak.org/NORAD/elements/gp.php?GROUP=' + g + '&FORMAT=tle', 60000, 'text/plain');
    if (!/^1 /m.test(t)) throw new Error('CelesTrak returned no element sets for ' + g);   // machine format: TLE line 1
    return t;
  })]));
async function satellites(groups) {
  const want = (groups && groups.length ? groups : SAT_GROUPS.filter(g => g !== 'starlink')).filter(g => satSources[g]);
  const out = {};
  for (const g of want) { const r = await satSources[g].get(); out[g] = { tle: r.value || '', at: r.at, err: r.err }; }
  return out;
}

// ---- launches: Launch Library 2 v2.3, hourly ----
function launchRow(l) {
  const pad = l.pad || {};
  return {
    id: l.id, name: l.name, net: l.net, status: (l.status && (l.status.abbrev || l.status.name)) || '',
    provider: (l.launch_service_provider && l.launch_service_provider.name) || '',
    rocket: (l.rocket && l.rocket.configuration && (l.rocket.configuration.full_name || l.rocket.configuration.name)) || '',
    mission: (l.mission && l.mission.name) || '', orbit: (l.mission && l.mission.orbit && l.mission.orbit.abbrev) || '',
    about: String((l.mission && l.mission.description) || '').slice(0, 400),
    pad: pad.name || '', where: (pad.location && pad.location.name) || '',
    lat: pad.latitude != null ? Number(pad.latitude) : null, lon: pad.longitude != null ? Number(pad.longitude) : null,
  };
}
const launches = source('launches', 3600000, 3600000, async () => {
  const base = 'https://ll.thespacedevs.com/2.3.0/launches/';
  const up = await getJson(base + 'upcoming/?limit=15&mode=normal', 30000);
  const past = await getJson(base + 'previous/?limit=10&mode=normal', 30000);
  return { upcoming: (up.results || []).map(launchRow), recent: (past.results || []).map(launchRow) };
});

// ---- cyclones: NOAA NHC ----
const cyclones = source('cyclones', 30 * 60000, 30 * 60000, async () => {
  const j = await getJson('https://www.nhc.noaa.gov/CurrentStorms.json', 20000);
  return (j.activeStorms || []).map(s => ({
    id: s.id, name: s.name, cls: s.classification, kt: Number(s.intensity) || null, mb: Number(s.pressure) || null,
    lat: Number(s.latitudeNumeric), lon: Number(s.longitudeNumeric), dir: s.movementDir, mph: s.movementSpeed,
    updated: s.lastUpdate, url: (s.publicAdvisory && s.publicAdvisory.url) || 'https://www.nhc.noaa.gov/',
  })).filter(s => isFinite(s.lat) && isFinite(s.lon));
});

// ---- a clicked point: weather, place name, Wikipedia nearby ----
// WMO weather-interpretation codes (WMO 4677, as Open-Meteo returns them) — the machine's own code table.
const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle',
  53: 'drizzle', 55: 'dense drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers',
  81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail',
  99: 'thunderstorm with heavy hail' };
const pointCache = new Map();
let lastNominatim = 0;
async function point(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('bad coordinates');
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  const hit = pointCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.value;
  const out = { lat, lon, place: null, weather: null, nearby: [] };
  await Promise.all([
    (async () => {
      const w = await getJson('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,precipitation,is_day&timezone=auto', 12000);
      const c = w.current || {};
      out.weather = { tempC: c.temperature_2m, feelsC: c.apparent_temperature, humidity: c.relative_humidity_2m, cloud: c.cloud_cover,
        windKmh: c.wind_speed_10m, windDir: c.wind_direction_10m, precipMm: c.precipitation, isDay: !!c.is_day,
        sky: WMO[c.weather_code] || null, tz: w.timezone || null, localTime: c.time || null };
    })().catch(() => {}),
    (async () => {
      const wait = 1100 - (Date.now() - lastNominatim);   // Nominatim: at most one request a second
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastNominatim = Date.now();
      const n = await getJson('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=' + lat + '&lon=' + lon, 12000);
      if (n && !n.error) out.place = { name: n.name || null, display: n.display_name || null, country: (n.address && n.address.country) || null };
    })().catch(() => {}),
    (async () => {
      const g = await getJson('https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gsradius=10000&gslimit=6&format=json&gscoord=' + lat + '%7C' + lon, 12000);
      out.nearby = ((g.query && g.query.geosearch) || []).map(p => ({ title: p.title, km: Math.round(p.dist / 100) / 10,
        url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(p.title.replace(/ /g, '_')) }));
    })().catch(() => {}),
  ]);
  pointCache.set(key, { at: Date.now(), value: out });
  if (pointCache.size > 300) pointCache.delete(pointCache.keys().next().value);
  return out;
}

// What the World Monitor's spoken summary may say about the live layers — from the caches only, never a fetch.
function summaryLines() {
  const lines = [];
  const f = flights.peek().value;
  if (f) {
    const by = {}; for (const r of f.rows) by[r[7]] = (by[r[7]] || 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => c + ' ' + n).join(', ');
    lines.push('Airborne aircraft (OpenSky snapshot ' + new Date(f.snapshot).toISOString().slice(11, 16) + ' UTC): ' + f.rows.length + ' — most registered in ' + top + '.');
  }
  const m = military.peek().value;
  if (m) lines.push('Military aircraft broadcasting (adsb.lol): ' + m.rows.length + '.');
  const c = cyclones.peek().value;
  if (c && c.length) lines.push('Active tropical cyclones (NOAA NHC): ' + c.map(s => s.name + ' (' + s.cls + (s.kt ? ', ' + s.kt + ' kt' : '') + ')').join('; ') + '.');
  else if (c) lines.push('NOAA NHC: no active tropical cyclones in the Atlantic or East/Central Pacific.');
  const l = launches.peek().value;
  if (l && l.upcoming.length) lines.push('Next launches (Launch Library 2): ' + l.upcoming.slice(0, 3).map(x => x.name + ' — ' + (x.net || '').slice(0, 16).replace('T', ' ') + ' UTC from ' + (x.where || x.pad)).join('; ') + '.');
  return lines;
}

module.exports = { init, flights: () => flights.get(), military: () => military.get(), satellites, launches: () => launches.get(),
  cyclones: () => cyclones.get(), point, summaryLines, SAT_GROUPS };
