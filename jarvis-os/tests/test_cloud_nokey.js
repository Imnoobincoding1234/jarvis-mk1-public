'use strict';
// A MAC WITH NO COMPOSIO KEY SAYS WHAT IS MISSING (2026-10-24, tested from the public repo). Without a key the cloud lane is
// skipped, and "read me my unread emails" came back "I could not carry that out". cloudNeedsKey() answers mail and named
// apps with where the key goes, using composio.route()'s own decision, and leaves everything else to the local lanes.
// Pure: no key is read, nothing is fetched or run.
const path = require('path');
const J = require(path.join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };

console.log('— mail and named apps get what is missing —');
for (const t of ['read me my unread emails', 'any new emails', 'check my gmail']) {
  const r = J.cloudNeedsKey(t);
  ok(r && /Settings → Connections/.test(r.reply) && /connect gmail/.test(r.reply) && r.cloud && r.cloud.key === false,
    '"' + t + '" → add a key in Settings → Connections, then connect gmail');
}
{
  const r = J.cloudNeedsKey('check my slack');
  ok(r && /^Slack goes through the cloud connection/.test(r.reply) && /connect slack/.test(r.reply), '"check my slack" names Slack');
}

console.log('\n— everything else is left to the local lanes —');
for (const t of ['what is the weather', 'open youtube', 'who wrote hamlet', 'make a folder called notes on my desktop',
                 'whats the news today', 'stock price of apple', 'papers on transformers', 'cafes near me']) {   // searches: local lanes
  ok(J.cloudNeedsKey(t) === null, '"' + t + '" → not a cloud request');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
