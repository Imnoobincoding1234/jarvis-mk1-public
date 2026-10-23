'use strict';
// MEASUREMENT SCRIPT — not a test. How well does actread.js read open / close / system requests?
//
// Three sets, and the third was written before the reader was ever run:
//   PINNED    what test_parse already asserts about quickAction for these families.
//   REAL      his own sentences from the log that these lanes answered, or should have.
//   HELDOUT   new phrasings, written blind. Nothing in it is an exemplar anywhere.
//
// A case expects an action (compared on the fields it names), 'ask', or null. The score that matters
// is WRONG — an action that is not the expected one, or any action where null/ask was expected.
// A null or ask where an action was expected is a MISS: it costs coverage, not correctness.
//
// Usage: node sweep_actread.js [scaffold-share …]   (default sweeps 0.03 0.05 0.08)
// Runs against a scratch cache; his real state is read, never written.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.JARVIS_CENTROID_CACHE = process.env.JARVIS_CENTROID_CACHE || path.join(__dirname, '..', 'state', 'centroids.json');
// READER=1 measures the reader model and its checker (readmodel.js) on the same sets, end to end,
// reading into a cache file of its own.
const READER = process.env.READER === '1';
if (READER) process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.sweep.json';
const J = require('../server.js');
const actread = require('../actread.js');
const errand = require('../errand.js');

const PINNED = [
  ['open youtube', { type: 'open_site', target: 'youtube' }],
  ['open swiggy', { type: 'open_site', target: 'swiggy' }],
  ['open blinkit', { type: 'open_site', target: 'blinkit' }],
  ['launch github', { type: 'open_site', target: 'github' }],
  ['pull up zomato', { type: 'open_site', target: 'zomato' }],
  ['open the youtube website', { type: 'open_site', target: 'youtube', preferSite: true }],
  ['open safari', { type: 'open_app', target: 'safari', name: 'safari' }],
  ['open calculator', { type: 'open_app', target: 'calculator', name: 'calculator' }],
  ['hey jarvis can you open youtube', { type: 'open_site', target: 'youtube' }],
  ['open youtube thanks', { type: 'open_site', target: 'youtube' }],
  ['close safari', { type: 'close_app', target: 'safari', name: 'safari' }],
  ['open instagram', { type: 'open_site', target: 'instagram' }],
  // "insta" starts both instagram and instamart in the registry: a question, not a lookup.
  ['open insta', 'ask'],
  // First contact with business wording is a question (the embedder never decides it alone).
  ['open our business instagram', 'ask'],
  ['open the socials', null],
  ['open company instagram', 'ask'],
  ['open https://example.com', { type: 'open_url', target: 'https://example.com' }],
  ['system status', { type: 'system_status' }],
  ['open find my', { type: 'open_app' }],
  ['what is the weather like', null],
  ['play chess', null],
];

const REAL = [
  ['Yoo bro can you open youtube plz', { type: 'open_site', target: 'youtube' }],
  ['yes but open textedit first', { type: 'open_app', name: 'textedit' }],
  ['Tell me the current system stats', { type: 'system_status' }],
  ['chuck on netflix', 'ask'],
  ['hi jarvis, mere liye terminal open kardo plz', 'ask'],
  ['Open Swiggy', { type: 'open_site', target: 'swiggy' }],
  ['No actually open WhatsApp', { type: 'open_site', target: 'whatsapp' }],
  ['jarvis open github', { type: 'open_site', target: 'github' }],
  ['open the app store', { type: 'open_app', name: 'app store' }],
  ['open notes', { type: 'open_app', name: 'notes' }],
  ['open the weather app', { type: 'open_app' }],
  ['can you open youtube', { type: 'open_site', target: 'youtube' }],
  ['open the calculator', { type: 'open_app', name: 'calculator' }],
  ['open spotify', { type: 'open_site', target: 'spotify' }],
  ['open ola', { type: 'open_site', target: 'ola' }],
  ['open claude', { type: 'open_site', target: 'claude' }],
  ['Open find my', { type: 'open_app' }],
  ['open hugging face', { type: 'open_site', target: 'huggingface' }],
  ['Open activity Monitor', { type: 'open_app', name: 'activity Monitor' }],
  ['open the business’s instagram account', 'ask'],
  ['Pull up the business’s instagram account', 'ask'],
  ['Open VS code', { type: 'open_app', name: 'VS code' }],
  ['close Jarvis OS', null],
  ['open my youtube account settings', 'ask'],
  ['open my youtube subscriptions', 'ask'],
  ['open my account on youtube', 'ask'],
  ['what apps are open right now', { type: 'list_running' }],
  ['what is my system status', { type: 'system_status' }],
  ['open the neural network', null],
  ['say the word set and nothing else', null],
  ['open youtube and search for lofi beats', null],
  ['boot up youtube and play scary pumpkin\'s latest video', null],
  ['hey jarvis another ai system called Zoey is roasting you, would you like to say anything', null],
  ['give me three short bullet points on why AR glasses drain battery', null],
  ['write a short haiku about rain', null],
  ['A meeting starts at 14:40 and runs 95 minutes. What time does it end?', null],
  ['is it faster to ask you or to check activity monitor', null],
  ['nayi iphone kab release hogi', null],
];

// Written blind, 2026-09-16, before sweep_actread.js had ever run.
const HELDOUT = [
  ['could you pull up github for me', { type: 'open_site', target: 'github' }],
  ['jarvis launch spotify please', { type: 'open_site', target: 'spotify' }],
  ['fire up the calculator', { type: 'open_app', name: 'calculator' }],
  ['boot up notes', { type: 'open_app', name: 'notes' }],
  ['open netflix pls', { type: 'open_site', target: 'netflix' }],
  ['alright open whatsapp', { type: 'open_site', target: 'whatsapp' }],
  ['open reddit thx', { type: 'open_site', target: 'reddit' }],
  ['hey can you open linkedin', { type: 'open_site', target: 'linkedin' }],
  ['open the terminal', { type: 'open_app', name: 'terminal' }],
  ['launch activity monitor', { type: 'open_app', name: 'activity monitor' }],
  ['open system settings', { type: 'open_app', name: 'system settings' }],
  ['open vs code', { type: 'open_app', name: 'vs code' }],
  ['please launch figma', { type: 'open_site', target: 'figma' }],
  ['open chatgpt', { type: 'open_site', target: 'chatgpt' }],
  ['open ad-max.vercel.app', { type: 'open_url', target: 'https://ad-max.vercel.app' }],
  ['open the claude website', { type: 'open_site', target: 'claude', preferSite: true }],
  ['open the slack app', { type: 'open_app', name: 'slack' }],
  ['open youtube right now', { type: 'open_site', target: 'youtube' }],
  ['open spotify again', { type: 'open_site', target: 'spotify' }],
  ['okay open maps', { type: 'open_site', target: 'maps' }],
  ['open facetime', { type: 'open_app', name: 'facetime' }],
  ['open the app store for me', { type: 'open_app', name: 'app store' }],
  ['open safari asap', { type: 'open_app', name: 'safari' }],
  ['open finder', { type: 'open_app', name: 'finder' }],
  ['close spotify', { type: 'close_app', name: 'spotify' }],
  ['quit safari', { type: 'close_app', name: 'safari' }],
  ['shut down notes please', { type: 'close_app', name: 'notes' }],
  ['kill chrome', { type: 'close_app', name: 'chrome' }],
  ['force quit textedit', { type: 'close_app', name: 'textedit', force: true }],
  ['close the calculator app', { type: 'close_app', name: 'calculator' }],
  ['exit whatsapp', { type: 'close_app', name: 'whatsapp' }],
  ['how\'s the mac holding up', { type: 'system_status' }],
  ['give me a system report', { type: 'system_status' }],
  ['take a screen capture', { type: 'screenshot' }],
  ['grab my screen', { type: 'screenshot' }],
  ['what programs do i have open', { type: 'list_running' }],
  ['which apps are currently running', { type: 'list_running' }],
  ['clear the trash', { type: 'empty_trash' }],
  ['turn the screen off', { type: 'sleep_display' }],
  ['open my github stars', 'ask'],
  ['open youtube and search for cats', null],
  ['open the pod bay doors', null],
  ['close the deal with kunal', null],
  ['open spotify premium plans', 'ask'],
  ['open youtube shorts', 'ask'],
  ['open safari history', 'ask'],
  ['what is spotify', null],
  ['i love youtube', null],
  ['open youtube tomorrow morning', 'ask'],
  ['open the company report', null],
  ['close my eyes', null],
  ['quit smoking', null],
  ['open a new tab in chrome', null],
  ['how\'s the weather', null],
  ['how are you doing today', null],
  ['take a picture of the cat', null],
  ['clear my schedule for tomorrow', null],
  ['turn off the lights', null],
  ['open the admax instagram', { type: 'open_social', target: 'instagram' }],
  ['pull up the business\'s twitter', 'ask'],
  ['open our facebook page', 'ask'],
  ['open instagram in the browser', { type: 'open_site', target: 'instagram', preferSite: true }],
  ['show me my instagram', null],
];

// AFTER HE ANSWERS. Each sentence is asked about once; his answer is taught; the same sentence and
// a new phrasing that reuses the taught words must then read completely, with no second question.
//   [what he said, what he answered — { role for the asked words } or { site }, then the sentences
//    that must now read, with what they must read as]
const TAUGHT = [
  ['hi jarvis, mere liye terminal open kardo plz', { role: 'courtesy' }, [
    ['hi jarvis, mere liye terminal open kardo plz', { type: 'open_app', name: 'terminal' }],
    ['notes open kardo', { type: 'open_app', name: 'notes' }]]],
  ['open the business’s instagram account', { role: 'business' }, [
    ['open the business’s instagram account', { type: 'open_social', target: 'instagram' }],
    ['pull up the business’s twitter account', { type: 'open_social', target: 'twitter' }],
    ['open instagram', { type: 'open_site', target: 'instagram' }]]],
  ['open insta', { site: 'instagram' }, [
    ['open insta', { type: 'open_site', target: 'instagram' }],
    ['open insta please', { type: 'open_site', target: 'instagram' }]]],
  ['open youtube shorts', { role: '' }, [
    ['open youtube shorts', 'ask']]],
];

// The role of a single leftover run, read alone. Blind, none of these is an exemplar.
const ROLE_HELDOUT = [
  ['pls', 'ignorable'], ['plz', 'ignorable'], ['thx', 'ignorable'], ['ty', 'ignorable'],
  ['asap', 'ignorable'], ['if possible', 'ignorable'], ['thank u', 'ignorable'], ['cheers mate', 'ignorable'],
  ['at once', 'ignorable'], ['immediately', 'ignorable'], ['once more', 'ignorable'], ['afterwards', 'ignorable'],
  ['web', 'site-type'], ['browser version', 'site-type'], ['homepage', 'site-type'],
  ['desktop version', 'app-type'], ['native app', 'app-type'], ['the program', 'app-type'],
  ['subscriptions', 'content'], ['settings', 'content'], ['history', 'content'], ['shorts', 'content'],
  ['premium plans', 'content'], ['stars', 'content'], ['account', 'content'], ['messages', 'content'],
  ['trending', 'content'], ['library', 'content'], ['the second tab', 'content'], ['reels', 'content'],
  ['dms', 'content'], ['music videos', 'content'], ['playlists', 'content'], ['downloads', 'content'],
  ['search', 'content'], ['login page', 'content'], ['tomorrow morning', 'content'], ['for kunal', 'content'],
];
// Written blind AFTER the first role set had been used to set the cuts, so this is the honest number.
const ROLE_HELDOUT2 = [
  ['please and thanks', 'ignorable'], ['thank you so much', 'ignorable'], ['ta', 'ignorable'],
  ['thankyou', 'ignorable'], ['no rush', 'ignorable'], ['if you could', 'ignorable'], ['real quick', 'ignorable'],
  ['right now', 'ignorable'], ['now please', 'ignorable'], ['again please', 'ignorable'], ['one more time', 'ignorable'],
  ['site version', 'site-type'], ['web browser', 'site-type'], ['on the web', 'site-type'], ['web portal', 'site-type'],
  ['application version', 'app-type'], ['the mac version', 'app-type'], ['desktop client', 'app-type'], ['installed app', 'app-type'],
  ['watch history', 'content'], ['channel', 'content'], ['cart items', 'content'], ['profile page', 'content'],
  ['inbox', 'content'], ['sent mail', 'content'], ['photos', 'content'], ['album', 'content'],
  ['the latest episode', 'content'], ['my uploads', 'content'], ['comments', 'content'], ['for mama', 'content'],
  ['with kunal', 'content'], ['about cats', 'content'], ['billing', 'content'], ['storage', 'content'],
  ['wallet', 'content'], ['friends list', 'content'], ['saved', 'content'], ['live stream', 'content'],
];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'actread-sweep-'));
const store = {
  read: (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(scratch, f), 'utf8')); } catch (e) { return d; } },
  write: (f, o) => fs.writeFileSync(path.join(scratch, f), JSON.stringify(o)),
};
function companyNames() {
  try {
    const mine = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'mysites.json'), 'utf8'));
    return Object.values(mine).map(s => { try { return new URL(s.url).hostname.split('.')[0]; } catch (e) { return ''; } })
      .map(h => h.replace(/[^a-z0-9]/gi, '').toLowerCase()).filter(Boolean);
  } catch (e) { return []; }
}
const sitesFile = path.join(__dirname, '..', '..', 'config', 'sites.json');
const siteData = () => { try { const d = JSON.parse(fs.readFileSync(sitesFile, 'utf8')); delete d._comment; return d; } catch (e) { return {}; } };

function initReader(share) {
  actread.init({
    store, jlog: () => {},
    siteKey: J.siteKey, browserName: J.browserName,
    siteKeys: () => Object.keys(siteData()),
    siteApp: k => (siteData()[k] || {}).app || null,
    workflows: () => [],
    socialKeys: () => ['instagram', 'twitter', 'facebook', 'linkedin'],
    companyNames,
    df: errand.wordDf, messages: errand.messageCount,
    validUrl: u => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch (e) { return false; } },
    normalizeUrl: s => (/^https?:\/\//i.test(s) ? s : (/^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?:\/\S*)?$/i.test(s) ? 'https://' + s : s)),
    scaffoldShare: share,
    isRequest: w => errand.isErrandSync(w),
    warmRequests: ws => errand.warm(ws),
  });
}

function verdict(got, want) {
  const r = got && got.action ? got.action : (got && got.ask ? 'ask' : null);
  if (want === null) return r === null ? 'ok' : (r === 'ask' ? 'ASKED' : 'WRONG');
  if (want === 'ask') return r === 'ask' ? 'ok' : (r === null ? 'miss' : 'WRONG');
  if (r === null || r === 'ask') return 'miss';
  for (const k of Object.keys(want)) {
    const a = r[k], b = want[k];
    if (k === 'name' || k === 'target') { if (String(a || '').toLowerCase() !== String(b).toLowerCase()) return 'WRONG'; }
    else if (a !== b) return 'WRONG';
  }
  return 'ok';
}

(async () => {
  const shares = process.argv.slice(2).map(Number).filter(x => x > 0);
  const all = [['PINNED', PINNED], ['REAL', REAL], ['HELDOUT', HELDOUT]];
  if (READER) {
    const RM = J.readmodel;
    const t0 = Date.now();
    const n = await RM.warm(all.flatMap(([, s]) => s.map(x => x[0])));
    console.log('\n===== reader model + checker (' + n + ' new reads, ' + (Date.now() - t0) + 'ms) =====');
    for (const [label, set] of all) {
      const tally = { ok: 0, miss: 0, ASKED: 0, WRONG: 0 };
      const notes = [];
      for (const [s, want] of set) {
        const r = RM.readSync(s);
        const got = r ? RM.build(s, r) : null;
        const v = verdict(got, want);
        tally[v]++;
        if (v !== 'ok') notes.push('    ' + v.padEnd(6) + JSON.stringify(s).slice(0, 60).padEnd(62) + ' read ' +
          JSON.stringify(r).slice(0, 70) + ' → ' + JSON.stringify(got && (got.action || (got.ask && { ask: got.ask.kind })) || null).slice(0, 70) +
          '  want ' + JSON.stringify(want).slice(0, 50));
      }
      console.log(label.padEnd(8) + ' ok ' + tally.ok + '  miss ' + tally.miss + '  asked-instead-of-null ' + tally.ASKED + '  WRONG ' + tally.WRONG + '  of ' + set.length);
      if (notes.length) console.log(notes.join('\n'));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
  }
  for (const share of (shares.length ? shares : [0.03, 0.05, 0.08])) {
    initReader(share);
    await actread.warm(all.flatMap(([, s]) => s.map(x => x[0])));
    console.log('\n===== scaffold share ' + share + ' =====');
    for (const [label, set] of all) {
      const tally = { ok: 0, miss: 0, ASKED: 0, WRONG: 0 };
      const notes = [];
      for (const [s, want] of set) {
        const got = actread.readSync(s);
        const v = verdict(got, want);
        tally[v]++;
        if (v !== 'ok') notes.push('    ' + v.padEnd(6) + JSON.stringify(s).slice(0, 60).padEnd(62) + ' got ' +
          JSON.stringify(got && (got.action || (got.ask && { ask: got.ask.words })) || null).slice(0, 90) +
          '  want ' + JSON.stringify(want).slice(0, 60));
      }
      console.log(label.padEnd(8) + ' ok ' + tally.ok + '  miss ' + tally.miss + '  asked-instead-of-null ' + tally.ASKED + '  WRONG ' + tally.WRONG + '  of ' + set.length);
      if (notes.length) console.log(notes.join('\n'));
    }
  }
  // After he answers.
  {
    const tally = { ok: 0, miss: 0, ASKED: 0, WRONG: 0 }; const notes = []; let n = 0;
    for (const [said, answer, then] of TAUGHT) {
      const first = actread.readSync(said);
      if (answer.site) actread.teachSite(first && first.ask && first.ask.said || said, answer.site);
      else if (first && first.ask) for (const w of first.ask.words || []) actread.teachRole(w, answer.role);
      await actread.warm(then.map(x => x[0]));
      for (const [s, want] of then) {
        n++;
        const got = actread.readSync(s);
        const v = verdict(got, want);
        tally[v]++;
        if (v !== 'ok') notes.push('    ' + v.padEnd(6) + JSON.stringify(s).slice(0, 60).padEnd(62) + ' got ' +
          JSON.stringify(got && (got.action || (got.ask && { ask: got.ask.words || got.ask.options })) || null).slice(0, 90));
      }
    }
    console.log('TAUGHT   ok ' + tally.ok + '  miss ' + tally.miss + '  asked-instead-of-null ' + tally.ASKED + '  WRONG ' + tally.WRONG + '  of ' + n);
    if (notes.length) console.log(notes.join('\n'));
  }
  // Leftover roles, read alone.
  const R = actread._roleOf;
  for (const [label, set] of [['ROLES-1', ROLE_HELDOUT], ['ROLES-2', ROLE_HELDOUT2]]) {
    let ok = 0, wrong = 0, asked = 0; const notes = [];
    for (const [w, want] of set) {
      const r = await R(w);
      const got = r === null ? 'down' : (r === 'courtesy' || r === 'sequence') ? 'ignorable'
        : (r === 'site-type' || r === 'app-type') ? r : 'content';
      // The one direction that matters: content read as anything else is a reading that drops or
      // changes words. An ignorable or type word read as content only costs a question.
      if (got === want) ok++;
      else if (want === 'content' || got === 'ignorable' || (got !== 'content' && got !== want)) { wrong++; notes.push('    DANGER ' + w.padEnd(18) + ' → ' + (r || '(none)') + '   want ' + want); }
      else { asked++; notes.push('    asks   ' + w.padEnd(18) + ' → ' + (r || '(none)') + '   want ' + want); }
    }
    console.log('\n' + label + '  ok ' + ok + '  asks ' + asked + '  DANGEROUS ' + wrong + '  of ' + set.length + '\n' + notes.join('\n'));
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
