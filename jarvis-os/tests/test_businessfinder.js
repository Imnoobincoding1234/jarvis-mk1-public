'use strict';
// find_businesses (agent.js) over businessfinder.js — the offline parts (2026-10-09). No network, no Brave, no model:
// find() is stubbed, so this checks what the TOOL claims about what came back. The live finder was run by hand
// (OpenStreetMap + the web around his saved location: 11 places, 4 checked).
const path = require('path');
const fs = require('fs');
const os = require('os');
const BF = require('../businessfinder.js');
const agent = require('../agent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };

console.log('what a business is — from the OSM preset registry, not a list');
ok(BF.isBusiness({ shop: 'bakery' }) && BF.isBusiness({ office: 'lawyer' }) && BF.isBusiness({ craft: 'carpenter' }), 'shops, offices, crafts are businesses');
ok(BF.isBusiness({ shop: 'something_new' }), 'any shop type counts (the generic shop preset)');
ok(!BF.isBusiness({ amenity: 'school' }) && !BF.isBusiness({ amenity: 'place_of_worship' }) && !BF.isBusiness({ leisure: 'park' }) && !BF.isBusiness({ amenity: 'bench' }),
  'schools, temples, parks and benches are not');

console.log('around a point');
const a = BF.areaAround(30.7, 76.7, 2, 'Mohali');
ok(Math.abs((a.bbox[2] - a.bbox[0]) * 111.32 - 4) < 0.01, '2 km each way north–south');
ok(a.bbox[1] < 76.7 && a.bbox[3] > 76.7 && a.name === 'Mohali', 'centred on the point, named');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
const realFind = BF.find;
let asked = null;
BF.find = async q => {
  asked = q;
  return { ok: true, area: 'x', total: 3, unchecked: 1, notes: ['OpenStreetMap: 3', 'web search: 2 places checked'], seconds: 1, places: [
    { name: 'Verma Law Firm', phones: ['9876543210'], from: ['osm'], noSiteChecked: true },
    { name: 'Rajput IT', phones: [], from: ['osm'], noSiteChecked: true },
    { name: 'Ink Studio', phones: ['1722345678'], from: ['osm'], noSiteChecked: false },
  ] };
};

(async () => {
  console.log('the tool — around him');
  agent.init({ whereAmI: async () => ({ lat: 30.7, lon: 76.7, ageDays: 13, label: 'Mohali' }), outDir: OUT });
  let r = await agent.find_businesses({ withoutWebsite: true, needPhone: 'true' });
  ok(r.ok && asked.near && asked.near.km === 2 && !asked.where, 'no place named → a 2 km square around the saved location');
  ok(asked.withoutWebsite === true && asked.needPhone === true && asked.what === '', 'flags passed; no kind = any business');
  ok(/within about 2 km/.test(r.say) && /13 days ago/.test(r.say) && /Mohali/.test(r.say), 'says where and how old the location is');
  ok(/2 confirmed by a web search, 1 not checked/.test(r.say), 'separates checked "no website" from unchecked');
  ok(/Ink Studio — \S.*\(website not checked\)/.test(r.say), 'an unchecked place is marked as such');
  ok(/Rajput IT — no number found/.test(r.say), 'a place without a number says so, nothing invented');
  ok(/\+91 98765 43210/.test(r.say), 'mobile numbers shown in full');
  ok(r.data.file && fs.existsSync(r.data.file) && /Verma Law Firm/.test(fs.readFileSync(r.data.file, 'utf8')), 'the full list is saved as a file');

  console.log('the tool — a named place, and no location at all');
  r = await agent.find_businesses({ what: 'gyms', where: 'Kharar' });
  ok(asked.where === 'Kharar' && !asked.near && asked.what === 'gyms' && /gyms in Kharar/.test(r.say), 'a named place is searched by name');
  agent.init({ whereAmI: async () => ({ city: 'Ludhiana' }) });
  r = await agent.find_businesses({});
  ok(asked.where === 'Ludhiana' && /no saved location, so this is the whole city/.test(r.say), 'IP city only as a whole city, and said');
  agent.init({ whereAmI: async () => null });
  r = await agent.find_businesses({});
  ok(!r.ok && /tell me the area/.test(r.say), 'no location → asks for the area, does not guess');

  BF.find = async () => ({ ok: true, total: 0, unchecked: 0, notes: ['OpenStreetMap: 0'], places: [] });
  agent.init({ whereAmI: async () => ({ lat: 1, lon: 2, ageDays: 0.2, label: '' }) });
  r = await agent.find_businesses({ what: 'bakeries', withoutWebsite: true });
  ok(r.ok && /found no bakeries without a website/.test(r.say) && r.data.count === 0, 'nothing found is said plainly');

  BF.find = realFind;
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
