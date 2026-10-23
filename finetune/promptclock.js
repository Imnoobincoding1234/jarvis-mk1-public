'use strict';
// promptclock.js — set the clock and weather inside a JARVIS system prompt (2026-10-05, jarvis v4.2).
//
// Why: server.js puts "Now Monday, October 5, 2026 at 9:31 PM. Weather 29°C Clear Ludhiana." into the system prompt
// (nowText(), the live weather). Every training row of a round was built in the same minute, so the model saw ONE time
// of day per round — and every eval prompt another single time (v4.1's held-out was built at 10:49 AM, so "shaam ho gayi
// jarvis" got "Good morning."). And with a weather line in every prompt it learned it always knows the weather ("can u
// check the weather with no wifi" → "yes"). Builders now give each row its own clock and sometimes no weather line.
//
// This edits OUR OWN machine-written line (server.js's fixed format), never his words. Three prompt shapes carry it:
// attention state  "Now <clock>. Weather <t>°<u> <desc> <city>. Automations: …"
// lean             "Now <clock>. CPU … disk N%. <t>°<u> <desc> <city>. Agents: …"
// full             "- Local time: <clock>\n" (+ a weather line further down)
const CLOCK_RE = /(Now |Local time: )[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2}\s?[AP]M/g;
const WEATHER_ATTN_RE = /Weather -?\d+(\.\d+)?°[CF] [^.\n]*\. /;
const WEATHER_LEAN_RE = /(disk \d+%\. )-?\d+(\.\d+)?°[CF] [^.\n]*\. /;
const WEATHER_FULL_RE = /\n- Weather: [^\n]*/;

// the exact text nowText() produces (server.js: toLocaleString with weekday, long month, numeric hour, 2-digit minute)
const clockText = d => d.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  .replace(/ /g, ' ');

// weather: undefined = leave as built; null = remove (offline); { temp, unit, desc, city } = replace
function setClock(sys, date, weather) {
  let s = String(sys).replace(CLOCK_RE, (m, pre) => pre + clockText(date));
  if (weather === null) s = s.replace(WEATHER_ATTN_RE, '').replace(WEATHER_LEAN_RE, '$1').replace(WEATHER_FULL_RE, '');
  else if (weather) {
    const w = weather.temp + '°' + (weather.unit || 'C') + ' ' + weather.desc + (weather.city ? ' ' + weather.city : '') + '. ';
    s = s.replace(WEATHER_ATTN_RE, 'Weather ' + w).replace(WEATHER_LEAN_RE, '$1' + w);
  }
  return s;
}

// "2026-10-12T07:20" → a Date in local time (the format the held-outs use)
const at = iso => { const [d, t] = String(iso).split('T'); const [y, mo, da] = d.split('-').map(Number); const [h, mi] = (t || '12:00').split(':').map(Number); return new Date(y, mo - 1, da, h, mi); };

// a reproducible random clock: any day in Oct–Dec 2026, the hour drawn from a bucket
const BUCKETS = { early: [5, 7], morning: [7, 11], afternoon: [12, 16], evening: [17, 20], night: [21, 23], late: [0, 3] };
function randomClock(rnd, bucket) {
  const [lo, hi] = BUCKETS[bucket || Object.keys(BUCKETS)[Math.floor(rnd() * 6)]];
  const day = 1 + Math.floor(rnd() * 90);
  const d = new Date(2026, 9, day, lo + Math.floor(rnd() * (hi - lo + 1)), Math.floor(rnd() * 60));
  return d;
}
const bucketOf = d => { const h = d.getHours(); return h < 4 ? 'late' : h < 7 ? 'early' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'; };
const WEATHERS = [['Clear', 31], ['Clear', 24], ['Partly cloudy', 27], ['Overcast', 22], ['Light rain', 21], ['Haze', 29], ['Mist', 17], ['Sunny', 34], ['Thunderstorm', 25], ['Fog', 12]];
function randomWeather(rnd) {
  if (rnd() < 0.2) return null;                               // offline: no weather line at all
  const [desc, t] = WEATHERS[Math.floor(rnd() * WEATHERS.length)];
  return { temp: t + Math.floor(rnd() * 5) - 2, unit: 'C', desc, city: rnd() < 0.8 ? 'Ludhiana' : 'Mohali' };
}

module.exports = { setClock, clockText, at, randomClock, bucketOf, randomWeather, CLOCK_RE };
