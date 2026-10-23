'use strict';
// WHICH SPOTIFY CARD A PLAY PRESSES — browser.js playNearJs, run against a small fake page. No browser,
// no model, nothing pressed.
//
// WHY. Reported live 2026-09-23: "judas" played "Judas — TommyMuzzic". The ranking counted every word
// of the card that was not asked for as an "extra", so the ARTIST'S NAME was one: Lady Gaga (2 words)
// lost to TommyMuzzic (1). Extras are now counted on the card's title line only, and equally clean
// titles fall to Spotify's own order. The cards below are the shapes on his search page (screenshot
// of the "Blast judas" search, and the "judas by lady gaga" rows measured in browser.js).
const B = require('../browser.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };

// A page of cards, in page order. Each card: its text (lines as Spotify renders them) and a Play button.
function page(cards) {
  const els = [];
  const mk = (tag, props) => Object.assign({ tagName: tag, type: '', offsetParent: {}, value: '', name: '', placeholder: '',
    getBoundingClientRect: () => ({ width: 40, height: 40 }), getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; } }, props);
  for (const text of cards) {
    const card = mk('DIV', { innerText: text, attrs: {} });
    const btn = mk('BUTTON', { innerText: '', attrs: { 'aria-label': 'Play ' + text.split('\n')[0] }, parentElement: card });
    els.push(btn);
  }
  return { querySelectorAll: sel => /dialog|menu|listbox|aria-modal/.test(sel) && !/a\[href\]/.test(sel) ? [] : els };
}
function pick(cards, title, artist) {
  const run = new Function('document', 'location', 'return ' + B._playNearJs(title, artist));
  const d = JSON.parse(run(page(cards), { href: 'https://open.spotify.com/search/x' }));
  return d.ok ? cards[d.i] : null;
}

const GAGA = 'Judas\nSong • Lady Gaga';
const TOMMY = 'Judas\nSong • TommyMuzzic';
const DARKER = 'Judas (80 Version)\nSingle • Darker';
const SABATON = 'Jawbreaker - Judas Priest Song\nSong • Sabaton';
const NEON = 'NEON JUDAS\nSong • Berry BLAST';
const COVER = 'Judas Guitar Slowed 8d\nSong • Josué Ribeiro';
const LIST = 'judas by Lady Gaga\nPlaylist • DJ XJOTA';
const SYLOSIS = 'Judas\nSong • Sylosis';

console.log('\n— the artist\'s name is not an "extra" —');
ok(pick([GAGA, TOMMY, DARKER], 'judas', '') === GAGA, 'bare "judas": Spotify\'s first clean Judas (Lady Gaga), not the one with the shorter artist name');
ok(pick([SABATON, DARKER, GAGA, TOMMY], 'judas', '') === GAGA, 'a remix and a longer title lose to a clean title');
ok(pick([TOMMY, GAGA], 'judas', 'lady gaga') === GAGA, 'an artist asked for is honoured wherever the card is');
ok(pick([COVER, LIST, GAGA], 'judas', '') === GAGA, 'a slowed cover and a playlist named after the search lose');
ok(pick([COVER, LIST, GAGA], 'judas', 'lady gaga') === GAGA, 'with the artist named too');
ok(pick(['1\nJudas\nLady Gaga\nBorn This Way\n4:09', '2\nJudas Remix\nSomeone\n3:00'], 'judas', '') === '1\nJudas\nLady Gaga\nBorn This Way\n4:09',
   'a numbered tracklist row: the title line is found by its words, not by being first');
ok(pick([SYLOSIS, GAGA], 'judas', '') === SYLOSIS, 'two equally clean titles: Spotify\'s order decides (documented limit — no artist was asked for)');
ok(pick([LIST], 'judas', '') === null, 'only a playlist on the page: nothing is pressed');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
