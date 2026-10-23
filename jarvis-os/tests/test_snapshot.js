'use strict';
// snapshot.js — the numbered page outline the v4 web-action model reads. Offline, from parsed HTML.
// The properties: numbering is browser.js's (same selector, overlay first, passwords and hidden things
// never numbered); controls sit inside their dialog / form / landmark; role, name and state follow the
// HTML-AAM / accessible-name rules; the Brave-side facts format to the very same text.
const S = require('../snapshot');
const W = require('../websession');
const B = require('../browser');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };

const HTML = `<html><head><title>Sign up</title></head><body>
<nav><a href="/">Home</a><a href="https://ext.example/x">Partner</a></nav>
<h1>Create your account</h1>
<form name="signup" action="/s"><label for="n">Your name</label><input id="n" name="name" required>
<select name="city"><option>Pick</option><option>Chandigarh</option><option selected>Delhi</option></select>
<label><input type="checkbox" name="news" checked> Send me news</label><input type="password" name="pw"><input type="hidden" name="t" value="x">
<textarea name="m" placeholder="Message">hey</textarea><button type="submit">Save</button><button disabled>Later</button>
<span id="lb">Phone number</span><input name="ph" aria-labelledby="lb"><input type="search" name="q" aria-label="Search the site">
<input type="radio" name="plan" value="free"><input name="code"></form>
<div style="display:none"><a href="/ghost">Ghost</a></div><p hidden><a href="/h">Hidden</a></p>
<div role="dialog" aria-label="Cookies"><button>Accept</button></div>
<footer><a href="/terms">Terms</a></footer></body></html>`;
const page = W.makePage({ url: 'https://site.example/signup', status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(HTML) });
const r = S.ofPage(page);
const L = r.text.split('\n');
console.log(r.text.split('\n').map(l => '      | ' + l).join('\n'));
ok(L[0] === 'URL https://site.example/signup' && L[1] === 'TITLE Sign up', 'header lines');
ok(L[2] === '[dialog "Cookies"]' && L[3] === '  [0] button "Accept"', 'an open dialog comes first and its button is [0], as in ENUM_CORE');
ok(L.includes('[navigation]') && L.includes('  [2] link "Partner" → ext.example'), 'landmark; off-site link shows its host');
ok(L.includes('# Create your account'), 'heading');
ok(L.includes('  [3] textbox "Your name" required'), '<label for> names the box; required shown');
ok(L.includes('  [4] combobox (city) = "Delhi" {Pick, Chandigarh, Delhi}'), 'select: no label → its form name; current value and options');
ok(L.includes('  [5] checkbox "Send me news" checked'), 'wrapping <label>; checked state');
ok(L.includes('  [6] textbox "Message" = "hey"'), 'textarea: placeholder names it, its text is its value');
ok(L.includes('  [7] button "Save"') && L.includes('  [8] button "Later" disabled'), 'buttons by content; disabled');
ok(L.includes('  [9] textbox "Phone number"') && L.includes('  [10] searchbox "Search the site"'), 'aria-labelledby and aria-label');
ok(L.includes('  [11] radio (plan)') && L.includes('  [12] textbox (code)'), 'nameless controls fall back to their form name');
ok(!/password|pw\)|Ghost|Hidden|"x"/.test(r.text), 'password, hidden input, display:none and [hidden] are never listed');
ok(r.count === 14, 'count = numbered controls (' + r.count + ')');
// the Brave side reports facts; formatted, they read the same
const viaBrave = S.fromBrave({ url: 'https://a.example/', title: 'T', count: 2, items: [{ k: 'open', role: 'form', name: '' }, { k: 'open', role: 'navigation', name: '' }, { k: 'close' },
  { k: 'el', i: 0, tag: 'input', type: 'email', label: 'Email', value: 'a@b.c' }, { k: 'el', i: 1, tag: 'input', type: 'submit', value: 'Go' }, { k: 'close' }] }).text;
ok(viaBrave === 'URL https://a.example/\nTITLE T\n[form]\n  [0] textbox "Email" = "a@b.c"\n  [1] button "Go"', 'Brave facts → the same format; empty landmarks dropped');
ok(S.format({ url: 'u', title: 't' }, Array.from({ length: 500 }, (_, i) => ({ k: 'el', i, tag: 'a', text: 'link number ' + i })), { maxChars: 300 }).endsWith('more lines not shown'), 'size cap says what it cut');
ok(typeof B.browser_snapshot === 'function' && B.SNAPSHOT_JS.includes('var SEL = ') && B.SNAPSHOT_JS.includes('function facts('), 'browser.js builds its snapshot on its own ENUM_CORE');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
