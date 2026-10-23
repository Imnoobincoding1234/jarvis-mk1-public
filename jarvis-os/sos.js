'use strict';
// ---------------------------------------------------------------------------
// JARVIS SOS — reaching emergency services, correctly, for wherever he actually is.
//
// WHAT THIS IS FOR. He is in Fairview, Maharashtra. His mother and step-father are in California. He
// travels. An assistant that dials 911 because 911 is the number an American model has memorised is
// worse than no assistant at all — in India it reaches nothing. So the country is resolved from his
// CURRENT location every time, and the number comes from a table rather than from a model.
//
// THREE RULES, and they are the whole design:
//
//   1. NOTHING HERE DIALS. This module builds a decision and a script; placing the call lives in
//      server.js behind an explicit live flag. A module that cannot dial cannot dial by accident.
//   2. NO MODEL DECIDES ANY OF IT. Not the country, not the number, not the words. A 3B that
//      confuses "play judas by lady gaga" with opening Safari does not get a vote in this.
//   3. SILENCE MEANS PROCEED. He asked for that explicitly, and it is the right default: the person
//      who most needs this is the person who cannot answer a follow-up question. Everything is
//      therefore built so the automated path is complete on its own, with no input from him at all.
//
// The scripts are written to be READ ALOUD to a dispatcher, which is why they lead with location.
// Every emergency service in the world asks for the address first; if the call drops after one
// sentence, that sentence should be the one that lets them come.
// ---------------------------------------------------------------------------

// ---------------- the numbers ----------------
//
// Curated deliberately rather than fetched: a network that is down is exactly when this is needed.
// `all` is the unified number where one exists; the specific services are listed where the country
// actually separates them (India and Japan do; the US does not).
//
// 112 is the fallback for anywhere not listed. On any GSM network it routes to the local emergency
// service even with no SIM, no credit and the keypad locked — which makes it the only honest
// default for a country this table has never heard of.
const NUMBERS = {
  IN: { all: '112', ambulance: '108', police: '100', fire: '101', label: 'India' },
  US: { all: '911', label: 'the United States' },
  CA: { all: '911', label: 'Canada' },
  GB: { all: '999', alt: '112', label: 'the United Kingdom' },
  IE: { all: '112', alt: '999', label: 'Ireland' },
  AU: { all: '000', alt: '112', label: 'Australia' },
  NZ: { all: '111', label: 'New Zealand' },
  JP: { all: null, ambulance: '119', fire: '119', police: '110', label: 'Japan' },
  CN: { all: null, ambulance: '120', fire: '119', police: '110', label: 'China' },
  KR: { all: null, ambulance: '119', fire: '119', police: '112', label: 'South Korea' },
  RU: { all: '112', ambulance: '103', police: '102', fire: '101', label: 'Russia' },
  BR: { all: null, ambulance: '192', police: '190', fire: '193', label: 'Brazil' },
  MX: { all: '911', label: 'Mexico' },
  ZA: { all: '112', ambulance: '10177', police: '10111', label: 'South Africa' },
  AE: { all: null, ambulance: '998', police: '999', fire: '997', label: 'the UAE' },
  SG: { all: null, ambulance: '995', fire: '995', police: '999', label: 'Singapore' },
  NP: { all: '112', ambulance: '102', police: '100', fire: '101', label: 'Nepal' },
  LK: { all: '119', ambulance: '1990', label: 'Sri Lanka' },
  BD: { all: '999', label: 'Bangladesh' },
  PK: { all: '15', ambulance: '1122', fire: '16', label: 'Pakistan' },
  // The EU-wide single number. Listed individually so the label reads like a place, not a continent.
  DE: { all: '112', label: 'Germany' }, FR: { all: '112', label: 'France' },
  ES: { all: '112', label: 'Spain' },   IT: { all: '112', label: 'Italy' },
  NL: { all: '112', label: 'the Netherlands' }, SE: { all: '112', label: 'Sweden' },
  NO: { all: '112', label: 'Norway' },  DK: { all: '112', label: 'Denmark' },
  PL: { all: '112', label: 'Poland' },  PT: { all: '112', label: 'Portugal' },
  CH: { all: '112', label: 'Switzerland' }, AT: { all: '112', label: 'Austria' },
  BE: { all: '112', label: 'Belgium' }, FI: { all: '112', label: 'Finland' },
  GR: { all: '112', label: 'Greece' },  TR: { all: '112', label: 'Türkiye' },
};
const FALLBACK = { all: '112', label: null };

const SERVICES = ['ambulance', 'police', 'fire'];

// Which service, from his words. Returns null when he said "emergency services" without naming one —
// that is not a failure to parse, it is a real answer meaning "the unified number".
function classifyService(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:ambulance|paramedic|medic|medical|heart\s?attack|stroke|bleeding|unconscious|overdose|choking|not\s+breathing|injured|hurt)\b/.test(t)) return 'ambulance';
  if (/\b(?:fire\s?(?:brigade|department|service|fighters?)?|burning|smoke|gas\s+leak)\b/.test(t)) return 'fire';
  if (/\b(?:police|cops?|intruder|burglar|break[-\s]?in|robbery|assault|attacked|stalker)\b/.test(t)) return 'police';
  return null;
}

// The number to dial. Falls back through: the country's specific service → its unified number →
// 112. `exact` says whether the country was actually in the table, because a guess must be visible
// as a guess.
function numberFor(cc, service) {
  const key = String(cc || '').toUpperCase();
  const row = NUMBERS[key];
  const src = row || FALLBACK;
  const specific = service && src[service];
  const number = specific || src.all || FALLBACK.all;
  return {
    number,
    label: src.label || null,
    exact: !!row,
    specific: !!specific,
    alt: src.alt || null,
    cc: key || null,
  };
}

// ---------------- the script ----------------
//
// Built here so it is identical whether he lets it run automatically or reads it himself, and so it
// can be reviewed in daylight rather than composed during an emergency.
//
// Ordered the way dispatchers ask: WHERE, WHAT, WHO. Location leads because a call that drops after
// one sentence should still have said where to come.
function buildScript(opts) {
  const o = opts || {};
  const service = o.service || null;
  const who = o.name || 'the caller';
  const addr = (o.address || '').trim();
  const city = (o.city || '').trim();
  const coords = (o.lat != null && o.lon != null) ? Number(o.lat).toFixed(5) + ', ' + Number(o.lon).toFixed(5) : '';
  const nature = (o.nature || '').trim();

  const OPENER = {
    ambulance: 'This is an automated emergency call requesting an ambulance.',
    fire: 'This is an automated emergency call reporting a fire.',
    police: 'This is an automated emergency call requesting police assistance.',
  };
  const lines = [];
  lines.push(OPENER[service] || 'This is an automated emergency call requesting assistance.');
  // It must be unmistakable that a machine is speaking — a dispatcher who thinks they are talking to
  // a person will wait for answers that never come, and that wastes the only thing that matters.
  lines.push('I am a voice assistant calling on behalf of ' + who + '. I cannot hear your replies.');

  // AN ADDRESS THAT IS NOT AN ADDRESS MUST NOT BE READ OUT.
  //
  // Found while reviewing the generated ambulance script: profile.address held the string "mix", and
  // the call would have told a dispatcher "The address is: mix." A wrong address is worse than no
  // address — it sends the ambulance somewhere, and it sounds authoritative enough to stop them
  // asking. Anything that fails this check is discarded in favour of coordinates and an explicit
  // request to trace the call, which is the honest state.
  const usableAddr = addr.length >= 12 && /\d/.test(addr) && /[ ,]/.test(addr) ? addr : '';
  if (usableAddr) {
    // SAY WHICH KIND OF ADDRESS THIS IS. A confirmed flat number and a point derived from GPS are
    // both useful and are not the same claim, and a dispatcher deserves to know which one they are
    // being given. `addressExact` is true only when the caller is at a place he has confirmed
    // himself; everywhere else this is a geocoder's best reading of a coordinate, and saying so is
    // what lets them ask the right follow-up instead of driving to a building that may be wrong.
    lines.push(o.addressExact
      ? 'The address is: ' + usableAddr + '.'
      : 'The approximate address, geocoded from GPS coordinates, is: ' + usableAddr +
        '. This address was derived from coordinates and has not been confirmed by the caller.');
  }
  else if (city) lines.push('The location is ' + city + '.');
  if (coords) lines.push('Coordinates: ' + coords + '.');
  if (!usableAddr) {
    lines.push(coords || city
      ? 'I do not have a verified street address. Please use those coordinates or trace this call.'
      : 'The exact address is not available to me. Please trace this call.');
  }

  if (nature) lines.push('The reported emergency is: ' + nature + '.');
  else if (service === 'ambulance') lines.push('A medical emergency has been reported. The nature is not known to me.');
  else if (service === 'fire') lines.push('A fire has been reported. Details are not known to me.');
  else if (service === 'police') lines.push('Police assistance has been requested. Details are not known to me.');

  if (o.callback) lines.push('The caller can be reached on ' + o.callback + '.');
  const contacts = (o.contacts || []).filter(c => c && c.number).slice(0, 3);
  if (contacts.length) {
    lines.push('Next of kin: ' + contacts.map(c => (c.label ? c.label + ' on ' : '') + c.number).join('; ') + '.');
  }
  lines.push('I will repeat this message.');
  return lines.join(' ');
}

// A compact line for the screen, so he can see what is about to be said before it is said.
function summarise(plan) {
  const p = plan || {};
  return [
    (p.service ? p.service.toUpperCase() : 'EMERGENCY SERVICES'),
    p.number ? 'on ' + p.number : '',
    p.label ? '(' + p.label + ')' : (p.cc ? '(' + p.cc + ')' : ''),
    p.exact ? '' : '[country not in table — 112 fallback]',
  ].filter(Boolean).join(' ');
}

module.exports = { NUMBERS, FALLBACK, SERVICES, classifyService, numberFor, buildScript, summarise };
