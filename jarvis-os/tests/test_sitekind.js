'use strict';
// Does the site adaptor actually replace the destination regex, and — the question that matters
// most here — is it a cache or is it a table with a new name?
//
// The distinguishing property is stated as a test rather than as a promise: EMPTY THE CACHE AND
// NOTHING IS KNOWN. A table would still answer. This does not, which is what makes an unregistered
// site learnable rather than invisible.
//
// The model half is exercised by test_sitekind_live.js, which needs ollama. Everything here runs
// against an in-memory store and no network, so it cannot be flaky and cannot write to his state.

const fs = require('fs');
const pathx = require('path');
// The reader model (readmodel.js) reads on demand in tests, into a cache file of the suites' own, so the
// synchronous parser can be asserted on sentences built as the suite goes. The live server never does this.
process.env.JARVIS_READER_BLOCKING = '1';
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.test.json';
const J = require('../server.js');          // the site registry, and the arbiter under test
const sk = require('../sitekind.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const eq = (w, got, want) => ok(JSON.stringify(got) === JSON.stringify(want), w + '  (got ' + JSON.stringify(got) + ')');
const head = t => console.log('\n— ' + t + ' —');

// An in-memory store, so this suite never touches state/sitekind.json.
let mem = {};
const memStore = { read: (n, f) => (n in mem ? mem[n] : f), write: (n, d) => { mem[n] = d; } };
const reinit = () => { sk.init({ jlog: () => {}, store: memStore, sites: () => J._sites() }); };

// server.js does not export sites(); the registry is read the same way it reads it.
if (typeof J._sites !== 'function') {
  const ROOT = pathx.join(__dirname, '..', '..');
  const raw = JSON.parse(fs.readFileSync(pathx.join(ROOT, 'config', 'sites.json'), 'utf8'));
  delete raw._comment;
  const index = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || !v.url) continue;
    index[k] = k;
    for (const a of (v.alias || [])) index[String(a).toLowerCase().replace(/[^a-z0-9]/g, '')] = k;
  }
  J._sites = () => ({ data: raw, index });
}
reinit();

const ids = t => sk.sitesIn(t, J.siteKey).map(x => x.id);

// ---------------------------------------------------------------------------
head('nothing is baked in — the property that makes this not a list');
// If a name-to-kind table shipped in the source, this would answer. It must not.
mem = {}; sk.init({ jlog: () => {}, store: memStore, sites: () => J._sites() });
// The module caches in a module-level variable, so force a genuinely cold read.
delete require.cache[require.resolve('../sitekind.js')];
const cold = require('../sitekind.js');
cold.init({ jlog: () => {}, store: { read: () => null, write: () => {} }, sites: () => J._sites() });
ok(cold.kindOfSync('swiggy.com') === null, 'a cold cache knows nothing about swiggy');
ok(cold.kindOfSync('amazon.in') === null, 'nor about amazon');
ok(cold.kindOfSync('open.spotify.com') === null, 'nor about spotify');
// And it still RESOLVES them, because resolution is the registry's job and kind is the model's.
eq('but it still resolves swiggy to its host', cold.sitesIn('swiggy', J.siteKey).map(x => x.id), ['swiggy.com']);

// ---------------------------------------------------------------------------
head('one site, four spellings — "swiggy = swiggy.com"');
eq('a registry key', ids('swiggy'), ['swiggy.com']);
eq('a bare host', ids('swiggy.com'), ['swiggy.com']);
eq('a host with www', ids('www.swiggy.com'), ['swiggy.com']);
eq('a pasted URL with a query string', ids('https://www.swiggy.com/search?query=pizza'), ['swiggy.com']);
eq('and in a sentence', ids('order me a pizza from swiggy.com please'), ['swiggy.com']);
eq('an alias resolves too', ids('play it on yt'), ['youtube.com']);
eq('a two-word alias', ids('put it on you tube'), ['youtube.com']);

// ---------------------------------------------------------------------------
head('a sub-service is not its parent');
// The regex bought this with a hand-written lookahead, swiggy(?!\s*instamart). This comes from the
// URLs: swiggy.com is a proper prefix of swiggy.com/instamart, so the longer one is more specific.
eq('"swiggy instamart" is the grocery service, once', ids('order milk from swiggy instamart'), ['swiggy.com/instamart']);
eq('and bare "instamart" is the same site', ids('order milk from instamart'), ['swiggy.com/instamart']);
eq('bare "swiggy" is still the restaurant one', ids('order a pizza from swiggy'), ['swiggy.com']);
// The rule is scoped to ADJACENT words, or a genuine two-shop order would collapse to one.
eq('two shops in one sentence stay two',
   ids('order apples from instamart and cake from swiggy'), ['swiggy.com/instamart', 'swiggy.com']);

// ---------------------------------------------------------------------------
head('a site the registry has never heard of is still a site');
eq('an unregistered host resolves to itself', ids('order from bigbasket.com'), ['bigbasket.com']);
eq('with a trailing full stop trimmed', ids('get it off nykaa.com.'), ['nykaa.com']);
eq('a country domain', ids('order a pizza from dominos.co.in'), ['dominos.co.in']);
ok(sk.kindOfSync('bigbasket.com') === null, 'and its kind is unknown until something asks');

// ---------------------------------------------------------------------------
head('and ordinary words are not sites');
for (const t of ['hello there', 'what is my battery at', 'order me a pizza', 'call mama', 'take a screenshot']) {
  eq('"' + t + '" names no site', ids(t), []);
}

// ---------------------------------------------------------------------------
head('his answer outranks the model, permanently');
sk.teach('zeptonow.com', 'grocery');
ok(sk.kindOfSync('zeptonow.com') === 'grocery', 'a taught kind is returned');
ok(sk.teach('zeptonow.com', 'nonsense') === false, 'and a kind outside the lanes is refused');
ok(sk.kindOfSync('zeptonow.com') === 'grocery', 'without disturbing what was taught');
ok(sk.teach('example.com', '') === true, '"" is a real answer — serves none of the errands');
ok(sk.kindOfSync('example.com') === '', 'and it is distinguishable from never-asked');
ok(sk.kindOfSync('never-asked-about.com') === null, 'which is null');

// ---------------------------------------------------------------------------
head('the arbiter reads every site, not fourteen of them');
// Taught rather than asked, so this suite needs no model and cannot flake. What is under test is
// the arbiter's use of the answer, not the model's ability to produce it.
for (const [h, k] of [['swiggy.com', 'food'], ['zomato.com', 'food'], ['swiggy.com/instamart', 'grocery'],
                      ['blinkit.com', 'grocery'], ['amazon.in', 'shop'], ['flipkart.com', 'shop'],
                      ['myntra.com', 'shop'], ['open.spotify.com', 'music'], ['youtube.com', 'video'],
                      ['bigbasket.com', 'grocery'], ['etsy.com', 'shop'], ['dominos.co.in', 'food']]) sk.teach(h, k);
// WARMED, BECAUSE THE ARBITER'S OTHER HALF IS LEARNED NOW TOO.
//
// The site kinds above are TAUGHT, so nothing here depends on the model getting a website right —
// that was the point and it still holds. What changed is that a destination alone no longer claims
// a request: the verb regex that used to establish "this is an errand at all" is gone, and
// errand.js answers that instead, from a cache the handler fills before it routes. So these warm
// the same way handleChatInner does. A cold run would pass for the wrong reason.
const kindOf = async t => {
  await J.errand.warm(J.clauseCandidates(t, {}));
  const v = J.arbitrate(t, {});
  return v ? (v.kind || 'AMBIG') : null;
};
(async () => {
head('  · the sites the old regex knew');
eq('a named shop beats a food word', await kindOf('order hiking boots from amazon'), 'shop');
eq('a named restaurant', await kindOf('order me a pizza from swiggy'), 'food');
eq('a named quick-commerce service', await kindOf('order apples from instamart'), 'grocery');
eq('a named music service', await kindOf('play judas on spotify'), 'music');
eq('a named video service', await kindOf('watch the trailer on youtube'), 'video');
head('  · and the ones it did not');
// "kurtis" is in no vocabulary in this codebase. The destination carries the whole decision, which
// is exactly what the destination is for.
eq('an unlisted shop, with an item nothing has a word for', await kindOf('order kurtis from myntra'), 'shop');
eq('an unregistered grocer', await kindOf('order from bigbasket.com'), 'grocery');
eq('an unregistered marketplace', await kindOf('buy a lamp on etsy.com'), 'shop');
eq('an unregistered restaurant, by host', await kindOf('order a pizza from dominos.co.in'), 'food');


// ---------------------------------------------------------------------------
head('the destination regex is gone and stays gone');
const src = fs.readFileSync(pathx.join(__dirname, '..', 'server.js'), 'utf8');
// THE CANDIDATE TABLE IS GONE ENTIRELY, so this no longer looks for one.
//
// It used to read the ARB_CANDIDATES source and assert that no candidate carried a `dest` pattern.
// That was an assertion about a STRING in a file rather than about behaviour, and it went red on a
// change that made the property it cared about MORE true: the destination regex was the first of
// the three fields to go, and `vocab` and `verbs` followed. What is being pinned is that none of
// them comes back — as a field on a candidate, or anywhere else.
ok(!/const ARB_CANDIDATES\b/.test(src), 'the candidate table with its word lists is gone');
ok(!/^\s*(?:dest|vocab|verbs)\s*:\s*\//m.test(src), 'and no pattern field has grown back on a candidate');
// The third and fourth copies of the restaurant list, which both asked "did he name a place that
// delivers cooked food" and both answered it with a ninth of the registry.
const platformCopies = (src.match(/swiggy\s*\|\s*zomato/g) || []).length;
eq('no copy of the restaurant platform alternation survives', platformCopies, 0);
// Nor may one come back somewhere else in the file.
ok(!/\/\\b\(\?:[a-z|\\s?']*\bamazon\b[a-z|\\s?']*\)\\b\/i/.test(src.replace(/\n/g, ' ')),
   'and no new alternation of shop names was added anywhere');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
