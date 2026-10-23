'use strict';
// ---------------------------------------------------------------------------
// JARVIS "usuals" — what he orders when he does not say.
//
// WHY THIS IS NOT THE ORDER HISTORY. They were the same thing until now: "the usual" and "order what
// I last ordered" shared one regex and both replayed the most recent logged order. That conflates a
// STANDING PREFERENCE with a REPLAY, and the replay was the wrong half — his preferences were
// already on file from the questionnaire, while the history had eleven phantom "dominos pizza"
// records from runs that never reached a basket, and one record whose item was literally the phrase
// "what I last ordered".
//
// So: a usual is a preference, kept here, stable, independent of whether any order ever completed.
// The history stays in episodic memory and answers a different question.
//
// GENERIC ON PURPOSE. Nothing here knows what a pizza is. A usual is keyed by whatever food or brand
// word he used, so momos, biryani and coffee work the same way the moment he states one — and when
// he states one, it is remembered, so the asking happens once per food rather than every time.
//
// `always` goes in without asking. `ask` is the sometimes half — the choco lava cake he wants offered
// rather than assumed. That distinction is the whole reason this is structured data and not a
// sentence in a prompt.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let deps = { jlog: () => {}, stateDir: null };
function init(d) { deps = Object.assign(deps, d || {}); }
const FILE = () => path.join(deps.stateDir || '/tmp', 'usuals.json');

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return (j && typeof j === 'object') ? j : {}; }
  catch (e) { return {}; }
}
function save(all) {
  try { fs.writeFileSync(FILE(), JSON.stringify(all, null, 1)); return true; }
  catch (e) { deps.jlog('Usuals › could not save: ' + e.message); return false; }
}

// The key is the food or brand word, lowercased. Matching is deliberately loose in BOTH directions so
// "dominos" finds a usual stored under "pizza" via its brand, and "pizza" finds one stored under
// "dominos".
// Apostrophes are DELETED, not turned into spaces. "Domino’s" became "domino s", which matched
// neither "dominos" nor "domino" — the same apostrophe failure that stopped a click on Domino’s
// Pizza earlier, in a second place.
function norm(s) { return String(s || '').toLowerCase().replace(/['‘’ʼ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function find(term) {
  const t = norm(term);
  if (!t) return null;
  const all = load();
  for (const [k, v] of Object.entries(all)) {
    const key = norm(k), brand = norm(v && v.brand);
    if (!key) continue;
    if (t.includes(key) || key.includes(t)) return Object.assign({ key: k }, v);
    if (brand && (t.includes(brand) || brand.includes(t))) return Object.assign({ key: k }, v);
  }
  return null;
}

function set(key, spec) {
  const all = load();
  all[norm(key) || String(key)] = {
    brand: (spec && spec.brand) || '',
    search: (spec && spec.search) || '',
    note: (spec && spec.note) || '',
    always: (spec && spec.always) || [],
    ask: (spec && spec.ask) || [],
    // Per-dish customisation answers, e.g. {"Classic": ["Classic Hand Tossed", "Regular"]}. A
    // "Customisable" dish opens a crust/size dialog INSTEAD of adding, so without these the add
    // silently does nothing — and choosing them on his behalf would be inventing his order.
    customise: (spec && spec.customise) || {},
    at: Date.now(),
  };
  save(all);
  deps.jlog('Usuals › remembered a usual for "' + key + '"');
  return all[norm(key) || String(key)];
}

// TWO DIFFERENT STRINGS, and conflating them broke the order.
//
// `always` holds SHORT dish names — what a search box and a menu actually contain. `note` holds the
// detail he cares about ("the 49 rupee one, medium hand tossed"), which belongs in what JARVIS says
// back to him and nowhere near a search field. Measured: the full description went into Swiggy's
// search box as "Classic pizza 49 rupee one medium hand tossed and garlic bread from Domino’s",
// matched nothing, and the run clicked "Swiggy Corporate" out of the wreckage.
function orderText(u) {
  if (!u) return '';
  const items = (u.always || []).filter(Boolean);
  if (!items.length) return '';
  return items.join(' and ') + (u.brand ? ' from ' + u.brand : '');
}

// What to type into a search box: the restaurant if we know it, else the first dish. One short thing,
// never a list — a search for "X and Y" finds neither.
function searchTerm(u) {
  if (!u) return '';
  return String(u.search || u.brand || (u.always || [])[0] || '').replace(/[’']/g, '');
}

// The primary dish, and anything else that has to be added after it.
function dishes(u) { return ((u && u.always) || []).filter(Boolean); }

// How JARVIS offers it back: what it will order, and what it needs a yes or no on.
function describe(u) {
  if (!u) return '';
  const base = orderText(u) + (u && u.note ? ' (' + u.note + ')' : '');
  const maybe = (u.ask || []).filter(Boolean);
  return base + (maybe.length ? ' — and ' + maybe.join(' or ') + ' as well?' : '');
}

function all() { return load(); }
function forget(key) { const a = load(); delete a[norm(key)]; save(a); }

module.exports = { init, find, set, all, forget, orderText, describe, searchTerm, dishes, norm, FILE };
