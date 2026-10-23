'use strict';
// ---------------------------------------------------------------------------
// JARVIS business finder — "find bakeries in Kolhapur without a website and give me their numbers".
//
// LIVE AND MULTI-SOURCE, his call (2026-10-01): an offline OpenStreetMap copy was "worse, way worse" —
// stale, and one source. So every search asks, at that moment:
//   1. OpenStreetMap — Nominatim turns "bakeries in kolhapur" into the area AND the map category
//      (shop=bakery) using OSM's own special phrases, so no word list of ours decides what a "bakery"
//      is; then Overpass lists every mapped place of that category in the area (several mirrors, the
//      first that answers wins). Open data, allowed to query, but thin on phone numbers in India.
//   2. Google Maps, read in HIS Brave like he would look at it (the most phone numbers by far).
//      Never fetched in the background: Google's robots.txt keeps scripts off /maps, and his browser
//      reading at a human pace is him looking, not a scraper.
//   3. The web: for a place with no number yet, a search for "<name> <area> phone" — numbers come
//      from the result snippets, each tagged with where it came from.
// Results are merged by phone number or name, every field says which source gave it, and a place
// counts as "no website" only when no source shows one AND a search for it finds no site of its own.
// Directory hosts (Justdial, Zomato…) are a machine-owned registry of listing sites, not a word list.
// ---------------------------------------------------------------------------

const W = require('./websession');
const R = require('./agentreach');
const H = require('./htmlparse');

let deps = { jlog: () => {}, audit: () => {} };
function init(d) { deps = Object.assign(deps, d || {}); }

const UA_OSM = 'JARVIS-personal-assistant/1.0 (one user, on-demand searches)';
let osm = null;
const OSM = () => (osm = osm || new W.Session({ gapMs: 1100, timeoutMs: 45000, userAgent: UA_OSM }));   // Nominatim: max 1 request a second
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

// Listing / social hosts: a hit on one of these is not the business's own website.
const DIRECTORY = ['justdial.com', 'sulekha.com', 'indiamart.com', 'zomato.com', 'swiggy.com', 'tripadvisor.in', 'tripadvisor.com', 'magicpin.in',
  'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'linkedin.com', 'youtube.com', 'google.com', 'maps.app.goo.gl', 'goo.gl', 'yelp.com',
  'wikipedia.org', 'tradeindia.com', 'asklaila.com', 'yellowpages.in', 'dineout.co.in', 'eazydiner.com', 'urbanpro.com', 'practo.com', 'nobroker.in',
  'housing.com', '99acres.com', 'magicbricks.com', 'wanderon.in', 'holidify.com', 'lbb.in', 'whatsapp.com', 'wa.me', 'blogspot.com', 'quora.com', 'reddit.com'];
const isDirectory = h => DIRECTORY.some(d => h === d || h.endsWith('.' + d));

// Phone numbers by SHAPE (Indian mobiles and landlines with STD codes, or any +CC number).
const PHONE_RE = /(?:\+?91[\s-]?|0)?(?:[6-9]\d{4}[\s-]?\d{5}|\d{2,4}[\s-]?\d{6,8})|\+\d{1,3}[\s-]?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{2,4}/g;
function normPhone(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+91')) d = d.slice(3); else if (d.startsWith('91') && d.length === 12) d = d.slice(2); else if (d.startsWith('0')) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : (/^\+\d{8,15}$/.test(d) ? d : null);
}
const phonesIn = s => [...new Set((String(s || '').match(PHONE_RE) || []).map(normPhone).filter(Boolean))];
const normName = s => String(s || '').toLowerCase().normalize('NFKD').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// how a number is shown: mobiles +91 XXXXX XXXXX, landlines with their 0 and STD code
const showPhone = d => /^[6-9]\d{9}$/.test(d) ? '+91 ' + d.slice(0, 5) + ' ' + d.slice(5) : /^\d{10}$/.test(d) ? '0' + d : d;
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };

// ---------------- OpenStreetMap ----------------
async function geocode(where) {
  const j = (await OSM().get('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(where))).json();
  if (!j.length) return null;
  const b = j[0].boundingbox.map(Number);
  return { name: j[0].display_name, bbox: [b[0], b[2], b[1], b[3]] };   // south, west, north, east
}
// "<what> in <where>" → the map categories OSM itself reads into it
async function categories(what, where) {
  const j = (await OSM().get('https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&limit=50&q=' + encodeURIComponent(what + ' in ' + where))).json();
  const count = {};
  for (const x of j) if (x.category && x.type && !['boundary', 'place', 'highway', 'landuse'].includes(x.category)) { const k = x.category + '=' + x.type; count[k] = (count[k] || 0) + 1; }
  const tags = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  if (tags.length) return { tags, hits: j, via: 'nominatim' };
  const d = dictionaryTags(what);
  return { tags: d, hits: j, via: d.length ? 'dictionary' : 'none' };
}
let ovp = null;
// OSM's own place-type dictionary (config/osm_presets, iD's preset registry): when Nominatim reads no
// category into his words, the presets whose name, aliases or search terms carry them give the tags.
// Matching is by token shape — the same token, or one a prefix of the other within two letters
// ("salons" ~ "salon") — against the registry's words, never a list of ours.
let PRESETS = null;
function presets() {
  if (PRESETS) return PRESETS;
  const dir = require('path').join(__dirname, '..', 'config', 'osm_presets');
  try {
    const p = JSON.parse(require('fs').readFileSync(dir + '/presets.min.json', 'utf8'));
    const en = JSON.parse(require('fs').readFileSync(dir + '/en.min.json', 'utf8'));
    const names = en[Object.keys(en)[0]].presets.presets;
    PRESETS = Object.entries(p).filter(([id, x]) => x.tags && Object.keys(x.tags).length === 1 && Object.values(x.tags).every(v => v !== '*') && names[id] &&
      (x.geometry || []).some(g => g === 'point' || g === 'area')).map(([id, x]) => {
      const nm = names[id];
      const words = [nm.name].concat(nm.aliases ? String(nm.aliases).split('\n') : [], nm.terms ? String(nm.terms).split(',') : []).filter(Boolean);
      return { id, tags: x.tags, searchable: x.searchable !== false, name: nm.name, toks: [...new Set(words.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3))], nameToks: nm.name.toLowerCase().split(/[^\p{L}\p{N}]+/u) };
    });
  } catch (e) { PRESETS = []; }
  return PRESETS;
}
const tokSim = (a, b) => a === b ? 3 : ((a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 2 && Math.min(a.length, b.length) >= 4) ? 2 : 0;
function dictionaryTags(what) {
  const want = String(what).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3);
  if (!want.length) return [];
  const scored = presets().map(p => {
    let s = 0; for (const w of want) { let b = 0; for (const t of p.toks) b = Math.max(b, tokSim(w, t)); s += b; }
    for (const w of want) for (const t of p.nameToks) if (tokSim(w, t)) s += 1;           // a hit on the name itself counts more
    return { p, s: s / want.length };
  }).filter(x => x.s >= 2).sort((a, b) => b.s - a.s || (b.p.searchable - a.p.searchable) || a.p.name.length - b.p.name.length);
  const out = [], top = scored.length ? scored[0].s : 0;
  for (const x of scored) { if (x.s < top * 0.9) break; const k = Object.entries(x.p.tags)[0].join('='); if (!out.includes(k)) out.push(k); if (out.length >= 3) break; }
  return out;
}
async function overpass(q) {
  let last = '';
  // a mirror that has not answered in 25 s is busy — the next one is tried rather than waiting it out
  ovp = ovp || new W.Session({ gapMs: 500, timeoutMs: 25000, userAgent: UA_OSM });
  for (const m of MIRRORS) {
    try {
      const p = await ovp.request('POST', m, { body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      if (p.status === 200) return { mirror: hostOf(m), elements: p.json().elements || [] };
      last = hostOf(m) + ' ' + p.status;
    } catch (e) { last = hostOf(m) + ' ' + e.message; }
  }
  throw new Error('no Overpass mirror answered (' + last + ')');
}
const esc = s => String(s).replace(/[\\"]/g, '\\$&');
// "ANY BUSINESS" — when he names no kind ("businesses in my locality"), OSM's own preset registry says
// what a business is: a place type whose preset asks, up front, for its opening hours AND a website or phone
// (shops, crafts, offices, cafés, gyms — not a school, a temple, a park or a bench). Opening hours alone let
// in parks, barriers and waterways (measured on the registry, 2026-10-09). Read from config/osm_presets,
// never a list of ours.
let BIZ = null;
function businessTags() {
  if (BIZ) return BIZ;
  BIZ = { tags: new Set(), keys: new Set() };
  try {
    const p = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config', 'osm_presets', 'presets.min.json'), 'utf8'));
    for (const x of Object.values(p)) {
      const f = x.fields || [];
      if (!x.tags || Object.keys(x.tags).length !== 1 || !f.includes('opening_hours') || !(f.includes('website') || f.includes('phone'))) continue;
      const [k, v] = Object.entries(x.tags)[0];
      BIZ.tags.add(k + '=' + v); BIZ.keys.add(k);
    }
  } catch (e) {}
  return BIZ;
}
const isBusiness = tg => { const b = businessTags(); return Object.entries(tg).some(([k, v]) => b.keys.has(k) && (b.tags.has(k + '=' + v) || b.tags.has(k + '=*'))); };
// A square around a point, `km` from its centre to each edge — "around me" without a place name to geocode.
function areaAround(lat, lon, km, label) {
  const dLat = km / 111.32, dLon = km / (111.32 * Math.cos(lat * Math.PI / 180));
  return { name: label || 'around you', bbox: [lat - dLat, lon - dLon, lat + dLat, lon + dLon] };
}
async function fromOSM(what, where, area) {
  if (!what) {
    // no kind named: every named place of a business type in the area
    const [s, w, n, e] = area.bbox, bb = '(' + [s, w, n, e].join(',') + ')';
    const keys = [...businessTags().keys];
    if (!keys.length) throw new Error('the OSM preset registry could not be read');
    const r = await overpass('[out:json][timeout:40];(' + keys.map(k => 'nwr["name"]["' + esc(k) + '"]' + bb + ';').join('') + ');out center tags 400;');
    const out = r.elements.filter(x => x.tags && x.tags.name && isBusiness(x.tags)).map(x => osmPlace(x, Object.entries(x.tags).find(([k]) => businessTags().keys.has(k)).join('=')));
    return { places: out, tags: ['any business (OSM presets with opening hours)'], via: 'presets', mirror: r.mirror };
  }
  const cat = await categories(what, where);
  const [s, w, n, e] = area.bbox, bb = '(' + [s, w, n, e].join(',') + ')';
  // the categories OSM read; if it read none, places whose NAME carries his word
  const parts = cat.tags.length ? cat.tags.map(t => { const [k, v] = t.split('='); return 'nwr["' + esc(k) + '"="' + esc(v) + '"]' + bb + ';'; })
    : ['nwr["name"~"' + esc(what.replace(/[.*+?^${}()|[\]]/g, '')) + '",i]' + bb + ';'];
  const r = await overpass('[out:json][timeout:40];(' + parts.join('') + ');out center tags 300;');
  const out = r.elements.filter(x => (x.tags || {}).name).map(x => osmPlace(x, cat.tags[0] || 'name match'));
  return { places: out, tags: cat.tags, via: cat.via, mirror: r.mirror };
}
function osmPlace(x, category) {
  const tg = x.tags || {};
  const phone = [tg.phone, tg['contact:phone'], tg['contact:mobile'], tg.mobile].filter(Boolean).join(';');
  const site = tg.website || tg['contact:website'] || tg.url || '';
  const addr = [tg['addr:housenumber'], tg['addr:street'], tg['addr:suburb'] || tg['addr:place'], tg['addr:city']].filter(Boolean).join(', ');
  return { name: tg.name, phones: phonesIn(phone), website: site, address: addr, category,
    osm: 'https://www.openstreetmap.org/' + x.type + '/' + x.id, lat: x.lat || (x.center && x.center.lat), lon: x.lon || (x.center && x.center.lon), from: ['osm'] };
}

// ---------------- Google Maps, in his Brave ----------------
// The results list loads as it scrolls: one script scrolls it for a few seconds, a second reads every
// card — its name, its text lines (rating · category · address · phone), and any link off Google (its website).
const MAPS_SCROLL = `(function(){
  var n = 0, f = document.querySelector('[role=feed]');
  var t = setInterval(function(){ f = f || document.querySelector('[role=feed]'); if (f) f.scrollTop = f.scrollHeight; if (++n >= 7) clearInterval(t); }, 1200);
  return JSON.stringify({title: document.title, wall: false, text: '', links: []});
})()`;
const MAPS_READ = `(function(){
  var seen = {}, cards = [];
  Array.prototype.slice.call(document.querySelectorAll('[role=feed] a[href*="/maps/place/"]')).forEach(function(a){
    var card = a.closest('[role=article]') || a.parentElement;
    var name = String(a.getAttribute('aria-label') || card.getAttribute('aria-label') || '').trim();
    if (!name || seen[name]) return; seen[name] = 1;
    var site = Array.prototype.slice.call(card.querySelectorAll('a[href]')).filter(function(x){ return /^https?:/.test(x.href) && !/(^|\\.)google\\./.test(x.hostname); }).map(function(x){ return x.href; })[0] || '';
    cards.push({name: name, text: String(card.innerText || '').slice(0, 600), website: site, link: a.href});
  });
  return JSON.stringify({title: document.title, wall: false, text: '', links: [], cards: cards});
})()`;
async function fromMaps(what, where, near) {
  // around a point: Maps searches the view centred there (zoom 15 ≈ a couple of km across)
  const url = near
    ? 'https://www.google.com/maps/search/' + encodeURIComponent(what || 'shops') + '/@' + near.lat.toFixed(5) + ',' + near.lon.toFixed(5) + ',15z?hl=en'
    : 'https://www.google.com/maps/search/' + encodeURIComponent((what || 'shops') + ' in ' + where) + '?hl=en';
  const r = await R.braveRead(url, { js: MAPS_SCROLL, settleS: 3, then: MAPS_READ, thenAfterS: 9 });
  if (!r.ok) return { places: [], note: r.say };
  const places = (r.cards || []).map(c => {
    // the card's own lines, as Maps shows them (rating · category · address, hours · phone) — kept whole, not guessed apart
    const lines = String(c.text).split('\n').map(x => x.trim()).filter(x => x && x !== c.name);
    return { name: c.name, phones: phonesIn(c.text), website: c.website || '', address: '', card: lines.slice(0, 4).join(' | '), link: c.link, from: ['maps'] };
  });
  return { places, note: places.length ? '' : 'no result cards (layout changed, or a consent page)' };
}

// ---------------- the web, per place ----------------
async function fromWeb(place, where) {
  // A name of one short or common-shaped word ("Bakers") matches half the city: a number found for it on
  // the web could be anyone's. Only names with two or more real words (4+ letters, or 2 words + digits) are looked up.
  const words0 = normName(place.name).split(' ').filter(w => w.length >= 4);
  if (normName(place.name).split(' ').length < 2 || !words0.length) return { phones: [], ownSite: '', skipped: 'name too generic to search' };
  const res = await R.searchWeb('"' + place.name + '" ' + where + ' phone', 6);
  const phones = new Map(), ownSite = [];
  const words = normName(place.name).split(' ').filter(w => w.length >= 4);
  for (const r of res) {
    const h = hostOf(r.url);
    // a number counts only when the same result also names the place
    const blob = normName(r.snippet + ' ' + r.title);
    if (!blob.includes(normName(place.name))) continue;
    for (const p of phonesIn(r.snippet + ' ' + r.title)) if (!phones.has(p)) phones.set(p, h);
    // its own site: a non-directory host that carries a word of its name ("nikbakers.com" for "Nik Baker's")
    const flat = h.replace(/[^a-z0-9]/g, '');
    if (!isDirectory(h) && words.length && words.some(w => flat.includes(w.replace(/[^a-z0-9]/g, '')))) ownSite.push('https://' + h + '/');
  }
  return { phones: [...phones].map(([p, h]) => ({ phone: p, source: h })), ownSite: ownSite[0] || '' };
}

// ---------------- merge ----------------
function merge(lists) {
  const out = [];
  const find = p => out.find(o => (p.phones.length && p.phones.some(x => o.phones.includes(x))) || normName(o.name) === normName(p.name));
  for (const p of lists.flat()) {
    const o = find(p);
    if (!o) { out.push(Object.assign({}, p, { phones: p.phones.slice(), from: p.from.slice() })); continue; }
    for (const x of p.phones) if (!o.phones.includes(x)) o.phones.push(x);
    for (const f of p.from) if (!o.from.includes(f)) o.from.push(f);
    o.website = o.website || p.website; o.address = o.address || p.address;
  }
  return out;
}

// find({ what, where, near:{lat,lon,km,label}, withoutWebsite, needPhone, limit, maps, web, check })
// `what` may be empty: any business (OSM presets). `near` replaces geocoding `where` with a square around a point.
async function find(q) {
  q = Object.assign({ limit: 40, maps: true, web: true, check: 15 }, q || {});
  q.what = String(q.what || '').trim();
  if (!q.where && !q.near) throw new Error('need where or near');
  const t0 = Date.now(), notes = [];
  const where = q.where || (q.near && q.near.label) || '';
  const area = q.near ? areaAround(q.near.lat, q.near.lon, q.near.km || 2, q.near.label) : await geocode(q.where);
  if (!area) return { ok: false, say: 'I could not find "' + q.where + '" on the map.' };
  let osmR = { places: [] };
  try { osmR = await fromOSM(q.what, where, area); notes.push('OpenStreetMap: ' + osmR.places.length + ' (' + (osmR.tags.join(', ') || 'name match') + (osmR.via === 'dictionary' ? ' from the OSM dictionary' : '') + ', via ' + osmR.mirror + ')'); }
  catch (e) { notes.push('OpenStreetMap: ' + e.message); }
  let mapsR = { places: [] };
  if (q.maps) { mapsR = await fromMaps(q.what, where, q.near); notes.push('Google Maps (Brave): ' + (mapsR.places.length || mapsR.note)); }
  let places = merge([osmR.places, mapsR.places]);
  if (q.web && where) {
    let looked = 0;
    for (const p of places) {
      if (looked >= Math.min(30, q.check)) break;                // a search a place, a couple of dozen places: polite
      if (p.phones.length && (p.website || !q.withoutWebsite)) continue;
      looked++;
      const w = await fromWeb(p, where);
      if (!w.skipped) p.webChecked = true;
      for (const x of w.phones) if (!p.phones.includes(x.phone)) { p.phones.push(x.phone); (p.phoneSources = p.phoneSources || {})[x.phone] = x.source; }
      if (!p.website && w.ownSite) { p.website = w.ownSite; p.websiteFrom = 'web search'; }
      if (w.phones.length && !p.from.includes('web')) p.from.push('web');
    }
    notes.push('web search: ' + looked + ' places checked');
  }
  // a social or listing page is not a website of its own: kept, but as `profile`
  for (const p of places) if (p.website && isDirectory(hostOf(/^https?:/.test(p.website) ? p.website : 'https://' + p.website))) { p.profile = p.website; p.website = ''; }
  // "NO WEBSITE" IS A CLAIM, so it is only made where it was checked: no source showed one AND a web search for the
  // place found no site of its own. The rest are kept apart as `unchecked`, never counted as without a website.
  let unchecked = 0;
  if (q.withoutWebsite) {
    places = places.filter(p => !p.website);
    for (const p of places) p.noSiteChecked = !!p.webChecked;
    unchecked = places.filter(p => !p.noSiteChecked).length;
  }
  if (q.needPhone) places = places.filter(p => p.phones.length);
  places.sort((a, b) => (b.noSiteChecked ? 1 : 0) - (a.noSiteChecked ? 1 : 0) || b.phones.length - a.phones.length || a.name.localeCompare(b.name));
  deps.audit('business_find', { what: q.what || '(any)', where: q.near ? 'near' : q.where, found: places.length });
  return { ok: true, area: area.name, places: places.slice(0, q.limit), total: places.length, unchecked, notes, seconds: Math.round((Date.now() - t0) / 1000) };
}

function toCsv(places) {
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  return ['name,phones,website,address,sources,map'].concat(places.map(p => [p.name, p.phones.map(showPhone).join(' / '), p.website, p.address, p.from.join('+'), p.osm || p.link || ''].map(cell).join(','))).join('\n') + '\n';
}

module.exports = { init, find, toCsv, geocode, categories, fromOSM, fromWeb, merge, businessTags, isBusiness, areaAround, phonesIn, normPhone, isDirectory, showPhone, dictionaryTags, normName, MAPS_SCROLL, MAPS_READ };
