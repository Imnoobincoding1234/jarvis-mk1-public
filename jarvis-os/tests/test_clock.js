'use strict';
// clock.js — reader round 6's `time` act, answered from the Mac's clock (2026-10-10). Pure: no model, no network.
process.env.TZ = 'Asia/Kolkata';   // the 'here' answer is the Mac's own zone; pinned so the suite passes on any Mac
const C = require('../clock.js');
let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)));
}
const at = new Date('2026-10-10T15:29:00Z');   // 8:59 PM in India

console.log('— the place comes from the zone registries —');
eq('a city in an IANA id', C.zoneFor('tokyo'), { zone: 'Asia/Tokyo', place: 'Tokyo' });
eq('a two-word city', C.zoneFor('new york'), { zone: 'America/New_York', place: 'New York' });
eq('a city inside his words', C.zoneFor('over in dubai'), { zone: 'Asia/Dubai', place: 'Dubai' });
eq('a country with one zone (iso3166.tab → zone.tab)', C.zoneFor('India'), { zone: 'Asia/Kolkata', place: 'India' });
eq('the registry\'s own second name', C.zoneFor('the uk'), { zone: 'Europe/London', place: 'UK' });
eq('a country with several zones is not guessed', !!(C.zoneFor('canada') || {}).many, true);
eq('a place no registry knows', C.zoneFor('nashik'), null);
eq('a US state is not a registry name', C.zoneFor('california'), null);
eq('a word that only CONTAINS a city is not it', C.zoneFor('parisian'), null);

console.log('— the answers —');
eq('here: time and date', C.answer('', at), 'It is 8:59 PM, Saturday, 10 October 2026, Sir.');
eq('a city: its own time and day', C.answer('tokyo', at), 'It is 12:29 AM in Tokyo — Sunday, 11 October, Sir.');
eq('several zones: asks for a city', /Canada has \d+ time zones, Sir — name a city there/.test(C.answer('canada', at)), true);
eq('unknown: says so, no guess', C.answer('nashik', at), 'I do not have a time zone for nashik, Sir — name a nearby city and I will tell you.');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
