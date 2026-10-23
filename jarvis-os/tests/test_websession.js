'use strict';
// websession.js (MechanicalSoup in JS) + htmlparse.js — against a local fixture server, no internet, no model.
// The properties: cookies set by one page ride on the next; redirects follow the browser rules (303 → GET);
// gzip bodies decode; links resolve against the page; a form's request is exactly what a browser sends;
// nothing is submitted without confirmed:true; password / card / hidden / file fields are never filled;
// CAPTCHA, login and payment forms refuse; robots.txt is honoured when asked; private addresses are refused.
const http = require('http');
const zlib = require('zlib');
const H = require('../htmlparse');
const W = require('../websession');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const throwsLike = async (fn, re, w) => { try { await fn(); ok(false, w + ' (did not throw)'); } catch (e) { ok(re.test(e.message), w + ' — ' + e.message.slice(0, 70)); } };

const FORM = `<!doctype html><html><head><title>Sign up &amp; more</title></head><body>
<form id="f" action="/submit" method="post">
  <input type="hidden" name="token" value="t0k">
  <label for="nm">Your name</label><input id="nm" name="name" required>
  <label>Email <input type="email" name="email" value="a@b.c"></label>
  <select name="city"><option value="">Pick</option><option value="chd">Kolhapur</option><option value="del" selected>Delhi</option></select>
  <input type="radio" name="plan" value="free" checked><input type="radio" name="plan" value="pro">
  <input type="checkbox" name="news" value="yes">
  <textarea name="msg" maxlength="20">hi &lt;there&gt;</textarea>
  <input type="password" name="pw">
  <input type="file" name="cv">
  <input name="dis" value="x" disabled>
  <button type="submit" name="act" value="save">Save</button>
  <button type="submit" name="act" value="send" formaction="/send">Send</button>
  <button type="button">Nothing</button>
</form>
<input form="f" name="outside" value="o">
<a href="/home">Home</a> <a href="next?p=2">Next page</a> <a href="mailto:x@y.z">mail</a> <a href="https://ext.example/x">Ext</a>
</body></html>`;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, html, hdr) => { res.writeHead(code, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, hdr || {})); res.end(html); };
    if (u.pathname === '/set') return send(302, '', { 'set-cookie': ['sid=abc; Path=/; HttpOnly', 'evil=1; Domain=other.example'], location: '/home' });
    if (u.pathname === '/home') return send(200, '<html><body><main><p>cookie=' + (req.headers.cookie || '') + '</p><p>ref=' + (req.headers.referer || '') + '</p></main></body></html>');
    if (u.pathname === '/form') return send(200, FORM);
    if (u.pathname === '/submit' || u.pathname === '/send') return send(200, '<pre>' + req.method + ' ' + u.pathname + ' ' + (req.headers['content-type'] || '') + '\n' + body + '\ncookie=' + (req.headers.cookie || '') + '</pre>');
    if (u.pathname === '/gz') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('<p>zipped ✓</p>')); }
    if (u.pathname === '/latin') { res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }); return res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9])); }
    if (u.pathname === '/post303') return send(303, '', { location: '/done' });
    if (u.pathname === '/done') return send(200, '<p>' + req.method + ' done</p>');
    if (u.pathname === '/captcha') return send(200, '<form action="/submit" method="post"><input name="q"><div class="g-recaptcha" data-sitekey="k"></div><button>Go</button></form>');
    if (u.pathname === '/login') return send(200, '<form action="/login" method="post"><input name="user"><input type="password" name="pass"><button>Log in</button></form>');
    if (u.pathname === '/search') return send(200, '<form action="/results"><input name="q"><select name="sort"><option>new</option><option>top</option></select><input type="submit" value="Search"></form>');
    if (u.pathname === '/results') return send(200, '<p>q=' + u.searchParams.get('q') + ' sort=' + u.searchParams.get('sort') + '</p>');
    if (u.pathname === '/multi') return send(200, '<form action="/submit" method="post" enctype="multipart/form-data"><input name="a" value="1"><textarea name="b">two</textarea><button>Go</button></form>');
    if (u.pathname === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n', { 'content-type': 'text/plain' });
    if (u.pathname.startsWith('/private')) return send(200, '<p>private</p>');
    if (u.pathname === '/loop') return send(302, '', { location: '/loop' });
    send(404, 'nope');
  });
});

(async () => {
  // ---------------- parser ----------------
  console.log('htmlparse');
  const d = H.parse('<ul><li>a<li>b<ul><li>c</ul><li>d</ul><p>x<p>y<div>z</div><table><tr><td>1<td>2<tr><td>3</table><script>if(a<b)"</p>"</script>');
  ok(H.selectAll(d, 'ul > li').length === 4, 'unclosed <li> close each other; a nested list stays nested');
  ok(H.selectAll(d, 'p').length === 2 && H.text(H.selectAll(d, 'p')[1]) === 'y', 'a new <p> closes the open one; a <div> ends a <p>');
  ok(H.selectAll(d, 'tr').length === 2 && H.selectAll(d, 'tr:first-child td').length === 2, 'a new <tr> closes the open <td> and <tr>');
  ok(H.select(d, 'script').children[0].text.includes('"</p>"'), 'script bodies are raw text — a "</p>" inside does not close anything');
  ok(!H.text(d).includes('if(a<b)'), 'text() leaves scripts out');
  ok(H.decode('&amp;&lt;&#8377;&#x20B9;&nbsp;&bogus;') === '&<₹₹ &bogus;', 'entities: named, decimal, hex; unknown ones kept');
  const d2 = H.parse('<div class="a b" id=x data-k=\'v w\'><a href=/p class=b>L</a><span>s</span><a href="http://e">E</a></div>');
  ok(H.select(d2, 'div#x.a.b > a.b').attrs.href === '/p', 'tag#id.class > child.class');
  ok(H.selectAll(d2, 'a[href^=http]').length === 1 && H.selectAll(d2, 'a:not(.b)').length === 1, '[attr^=] and :not()');
  ok(H.selectAll(d2, '[data-k~=w]').length === 1 && H.selectAll(d2, 'span + a').length === 1 && H.selectAll(d2, 'a ~ a').length === 1, '[attr~=], + and ~');
  ok(H.selectAll(d2, 'a, span').length === 3, 'selector groups');

  // ---------------- session ----------------
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log('websession');
  {
    const s = new W.Session({ gapMs: 0 });
    await throwsLike(() => s.get(base + '/home'), /private|public/, 'a private address is refused by default');
  }
  ok(W.privateIp('10.1.2.3') && W.privateIp('192.168.0.9') && W.privateIp('::1') && W.privateIp('::ffff:127.0.0.1') && W.privateIp('100.64.0.1') && !W.privateIp('8.8.8.8'), 'private ranges recognised (v4, v6, mapped, CGNAT)');
  W._allowPrivate(true);
  const s = new W.Session({ gapMs: 0 });
  let p = await s.open(base + '/set');
  ok(p.url === base + '/home' && /cookie=sid=abc/.test(p.text()), 'redirect followed; the cookie it set rides on the next request');
  ok(!/evil/.test(p.text()), 'a cookie for another domain is refused');
  ok(/ref=$/m.test(p.text()) || /ref=http/.test(p.text()), 'referer header handled');
  p = await s.open(base + '/form');
  ok(p.title === 'Sign up & more', 'title decoded');
  const links = s.links();
  ok(links.map(l => l.href).join(' ') === base + '/home ' + base + '/next?p=2 https://ext.example/x', 'links resolved against the page; mailto dropped');
  const f = s.form('#f');
  ok(f && f.method === 'POST' && f.action === base + '/submit', 'form found by selector; method and action resolved');
  ok(f.field('outside') && f.field('name').label === 'Your name' && f.field('email').label.startsWith('Email'), 'form="id" fields included; labels from for= and wrapping <label>');
  const r0 = f.request();
  ok(r0.body === 'token=t0k&name=&email=a%40b.c&city=del&plan=free&msg=hi+%3Cthere%3E&pw=&act=save&outside=o', 'default request: hidden kept, selected option, checked radio, unchecked box and disabled field left out, first submit button — ' + r0.body);
  f.set('name', 'Mihir').set('city', 'Kolhapur').set('plan', 'pro').set('news', true).set('msg', 'hello');
  const r1 = f.request('Send');
  ok(r1.url === base + '/send' && /name=Mihir/.test(r1.body) && /city=chd/.test(r1.body) && /plan=pro/.test(r1.body) && /news=yes/.test(r1.body) && /act=send/.test(r1.body),
    'set by option text, radio, checkbox; formaction of the chosen button — ' + r1.body);
  await throwsLike(() => f.set('pw', 'hunter2'), /password/, 'password field refused');
  await throwsLike(() => f.set('token', 'x'), /hidden/, 'hidden field refused');
  await throwsLike(() => f.set('cv', 'x'), /file/, 'file field refused');
  await throwsLike(() => f.set('name', '4111 1111 1111 1111'), /card/, 'card-shaped value refused');
  await throwsLike(() => f.set('city', 'Mumbai'), /no option/, 'a select option that is not there is refused, with the options listed');
  await throwsLike(() => f.set('plan', 'gold'), /no choice/, 'a radio value that is not there is refused');
  await throwsLike(() => f.set('msg', 'x'.repeat(21)), /at most 20/, 'maxlength honoured');
  await throwsLike(() => f.set('nope', 'x'), /no field/, 'unknown field names the real ones');
  let sub = await s.submit(f, { button: 'Send' });
  ok(sub.needsConfirm && sub.preview.url === base + '/send' && !/POST \/send/.test(s.page.html), 'no confirmed:true → nothing sent, the exact request comes back');
  sub = await s.submit(f, { button: 'Send', confirmed: true });
  ok(sub.ok && /POST \/send application\/x-www-form-urlencoded/.test(sub.page.text()) && /cookie=sid=abc/.test(sub.page.text()), 'confirmed submit posts the form with the session cookie');
  p = await s.open(base + '/search');
  const sf = s.form({ field: 'q' }); sf.set('q', 'cold coffee').set('sort', 'top');
  sub = await s.submit(sf, { confirmed: true });
  ok(/q=cold coffee sort=top/.test(sub.page.text()), 'GET form puts the fields in the query string');
  p = await s.open(base + '/multi');
  const mr = s.form().request();
  ok(/^multipart\/form-data; boundary=/.test(mr.contentType) && /name="b"\r\n\r\ntwo\r\n/.test(mr.body), 'multipart body built');
  sub = await s.submit(s.form(), { confirmed: true });
  ok(/POST \/submit multipart\/form-data/.test(sub.page.text()), 'multipart submit reaches the server');
  p = await s.open(base + '/captcha');
  sub = await s.submit(s.form(), { confirmed: true });
  ok(sub.refused && /CAPTCHA/.test(sub.say), 'a CAPTCHA form refuses even when confirmed');
  p = await s.open(base + '/login');
  sub = await s.submit(s.form(), { confirmed: true });
  ok(sub.refused && /login/.test(sub.say), 'a login form refuses even when confirmed');
  p = await s.request('POST', base + '/post303', { body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  ok(/GET done/.test(p.text()), '303 after POST becomes GET');
  p = await s.get(base + '/gz');
  ok(p.text() === 'zipped ✓', 'gzip body decoded');
  p = await s.get(base + '/latin');
  ok(p.text() === 'café', 'charset from the header (latin-1)');
  await throwsLike(() => s.get(base + '/loop'), /redirects/, 'redirect loops stop');
  const polite = new W.Session({ gapMs: 0, robots: true });
  await throwsLike(() => polite.get(base + '/private/x'), /robots/, 'robots.txt Disallow honoured when asked');
  p = await polite.get(base + '/private/ok/y');
  ok(p.status === 200, 'the longer Allow wins over Disallow');
  ok((await new W.Session({ gapMs: 0 }).get(base + '/private/x')).status === 200, 'robots not consulted unless asked');
  const t0 = Date.now(); const slow = new W.Session({ gapMs: 300 }); await slow.get(base + '/home'); await slow.get(base + '/home');
  ok(Date.now() - t0 >= 280, 'per-host politeness gap');
  W._allowPrivate(false);
  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH ' + (e.stack || e)); process.exit(1); });
