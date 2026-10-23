'use strict';
// agentreach.js (Agent-Reach in JS) — the offline parts: the readability pass, feed parsing (RSS and Atom),
// the JSON-in-a-script-tag reader YouTube needs, and routing by host. No network, no Brave, no model.
const R = require('../agentreach');
const W = require('../websession');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const page = (html, url) => W.makePage({ url: url || 'https://news.example/a', status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) });

const ART = `<html><head><title>Site | Story</title><meta property="og:title" content="The real headline"><meta name="author" content="A. Writer"></head><body>
<header><nav><a href="/">Home</a><a href="/x">World</a><a href="/y">Sport</a></nav></header>
<aside><ul><li><a href="/1">Trending one that is a long link text here</a></li><li><a href="/2">Trending two that is also a long link text</a></li></ul></aside>
<div class="story"><h1>The real headline</h1><p>The first paragraph of the story has plenty of words in it, enough to count as prose.</p>
<p>A second paragraph keeps going with more detail, a <a href="/ref">reference</a>, and some more words to be safe.</p>
<p>And the third paragraph finishes the thought with yet more words so the scorer is sure.</p></div>
<footer><p>Copyright notice with a lot of words that should never be in the article text at all.</p></footer>
<script>var x = "<p>not text</p>";</script></body></html>`;

console.log('readability');
const r = R.readable(page(ART));
ok(r.title === 'The real headline' && r.byline === 'A. Writer', 'og:title and author meta');
ok(/first paragraph/.test(r.text) && /third paragraph/.test(r.text), 'the story paragraphs are kept');
ok(!/Trending|Copyright|World|not text/.test(r.text), 'nav, aside, footer and scripts are left out — ' + JSON.stringify(r.text.slice(0, 80)));

console.log('feeds');
const rss = R.parseFeed(`<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Feed &amp; Co</title>
<item><title><![CDATA[First & <i>best</i>]]></title><link>https://f.example/1</link><pubDate>Wed, 01 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description></item>
<item><title>Second</title><link>https://f.example/2</link><dc:date>2026-10-01</dc:date></item></channel></rss>`, 'https://f.example/rss');
ok(rss.title === 'Feed & Co' && rss.items.length === 2, 'RSS channel and items');
ok(rss.items[0].title === 'First & <i>best</i>' && rss.items[0].url === 'https://f.example/1', 'CDATA title kept literally; <link> holds its text in XML mode');
ok(rss.items[0].summary === 'Hello world' && rss.items[1].date === '2026-10-01', 'HTML inside the description read as text; dc:date found');
const atom = R.parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>E1</title><link href="https://a.example/e1"/><updated>2026-09-30</updated><summary>S</summary></entry></feed>`, 'https://a.example/atom');
ok(atom.items.length === 1 && atom.items[0].url === 'https://a.example/e1' && atom.items[0].date === '2026-09-30', 'Atom entries, link from href');

console.log('youtube page data');
const yt = 'var x=1;var ytInitialPlayerResponse = {"videoDetails":{"title":"A \\"quoted\\" {brace} title","lengthSeconds":"61"},"n":[1,{"k":"}"}]};var y=2;';
const j = R.jsonAfter(yt, 'ytInitialPlayerResponse');
ok(j && j.videoDetails.title === 'A "quoted" {brace} title' && j.n[1].k === '}', 'the JSON object after a marker, braces inside strings ignored');
ok(R.jsonAfter('nothing here', 'ytInitialData') === null, 'no marker → null');

console.log('routing');
ok(R.platformOf('https://x.com/someone/status/1') === 'X' && R.platformOf('https://www.reddit.com/r/india') === 'Reddit' &&
   R.platformOf('https://in.linkedin.com/in/someone') === 'LinkedIn' && R.platformOf('https://www.instagram.com/p/abc') === 'Instagram', 'logged-in platforms go to Brave');
ok(R.platformOf('https://example.com/x.com') === null && R.platformOf('https://notreddit.com/') === null, 'look-alike hosts and paths do not');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
