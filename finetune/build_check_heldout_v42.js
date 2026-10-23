#!/usr/bin/env node
// FRESH held-out for the Wikipedia-lane ANSWER CHECK (2026-10-08) — written before any replacement for
// grounded.supported() was built or measured. supported() decides by capital letters and sentence punctuation, which
// his rule #1 forbids; its replacement must judge by meaning and is measured here, not on the 27 v4.2 sources (those were
// read while grading v4.2, so they are not a fair test).
//
// Questions: none in any earlier held-out, training question file, training row, his messages or the stress set
// (check_heldout_overlap.js over finetune/data: 0 exact matches; every shared rare word read by hand), and none of the
// seven live questions of 2026-10-08. Kinds, mixed on purpose: answerable from the lead, only from a snippet, not in the
// source at all, wrong-sense pages (the top hit is a film / series / island / animal), Hinglish searched raw exactly as
// the live lane does, and contested pages that state a fringe or disputed claim (the Frankenstein case).
//
// Sources: natural items are fetched exactly like server.js wikiSource(q) — one search of the raw question (srlimit 3),
// the summary of the top hit, composed by grounded.fromWikipedia — and FROZEN here so every check is measured on
// byte-identical inputs. `page` items are a search that landed on the wrong page (as in v42_grounded_heldout.json): the
// source is that page's own search, and `leak` words are checked so the page really does not hold the answer.
// Hinglish: Wikipedia's search needs every word to match, so a raw Hinglish question mostly finds nothing (11 of 15 here)
// and the live lane goes straight to research without ever reaching the check. Those items carry an English `query`
// (what a query-rewrite step would search) so the check is still measured on Hinglish questions and jarvis's replies.
// The label of each item is NOT decided here: jarvis's reply is generated (gen_check_replies_v42.js) and read by hand.
//   node build_check_heldout_v42.js → data/v42_check_heldout.json
const fs = require('fs');
const path = require('path');
const WF = require('./wikifetch');

const ITEMS = [
  // natural live search, English — lead, snippet or nowhere, decided by the fetched source
  { q: 'what is the capital of kazakhstan', must: ['astana'] },
  { q: 'what is the capital of kerala', must: ['thiruvananthapuram', 'trivandrum'] },
  { q: 'what is the capital of uzbekistan', must: ['tashkent'] },
  { q: 'what is the capital of arunachal pradesh', must: ['itanagar'] },
  { q: 'what is the capital of tajikistan', must: ['dushanbe'] },
  { q: 'what is the currency of indonesia', must: ['rupiah'] },
  { q: 'what is the currency of poland', must: ['zloty', 'złoty'] },
  { q: 'what is the currency of south africa', must: ['rand'] },
  { q: 'who founded infosys', must: ['murthy'] },
  { q: 'who founded zomato', must: ['goyal'] },
  { q: 'who founded flipkart', must: ['bansal'] },
  { q: 'who founded the tata group', must: ['jamsetji'] },
  { q: 'who was the first person in space', must: ['gagarin'] },
  { q: 'who was the first person to walk in space', must: ['leonov'] },
  { q: 'who was the first woman to win a nobel prize', must: ['curie'] },
  { q: 'who directed 3 idiots', must: ['hirani'] },
  { q: 'who wrote wings of fire', must: ['kalam', 'tiwari'] },
  { q: 'who built the konark sun temple', must: ['narasimha'] },
  { q: 'which river flows through kolkata', must: ['hooghly', 'hugli'] },
  { q: 'how long is the nile river', must: ['6,650', '6650', '4,130', '6,6'] },
  { q: 'what year did the titanic sink', must: ['1912'] },
  { q: 'how high is k2', must: ['8,611', '8611', '28,251'] },
  { q: 'how hot is the surface of venus', must: ['464', '465', '467', '867', '870', '900'] },
  { q: 'how deep is lake baikal', must: ['1,642', '1642', '5,387'] },
  { q: 'when was the united nations founded', must: ['1945'] },
  { q: 'what is the half life of carbon 14', must: ['5,730', '5730', '5,700', '5700'] },
  { q: 'what is the atomic number of gold', must: ['79'] },
  { q: 'how many keys does a piano have', must: ['88'] },
  { q: 'who created python', must: ['van rossum', 'guido'] },
  { q: 'what is the capital of georgia', must: ['tbilisi', 'atlanta'] },
  { q: 'who wrote the god of small things', must: ['arundhati', 'roy'] },
  { q: 'who wrote train to pakistan', must: ['khushwant'] },
  { q: 'who wrote the white tiger', must: ['adiga'] },
  { q: "who wrote midnight's children", must: ['rushdie'] },
  { q: 'who wrote a suitable boy', must: ['vikram seth'] },
  { q: 'who composed the planets', must: ['holst'] },
  { q: 'who painted guernica', must: ['picasso'] },
  { q: 'who painted the birth of venus', must: ['botticelli'] },
  { q: 'who sculpted the statue of liberty', must: ['bartholdi'] },
  { q: 'who designed chandigarh', must: ['corbusier', 'mayer'] },
  { q: 'who invented the stethoscope', must: ['laennec', 'laënnec'] },
  { q: 'who wrote the exorcist', must: ['blatty'] },
  { q: 'who wrote psycho', must: ['bloch'] },
  { q: 'who wrote the notebook', must: ['sparks'] },
  { q: 'who wrote forrest gump', must: ['groom'] },
  { q: 'who wrote fight club', must: ['palahniuk'] },
  { q: 'who wrote slumdog millionaire', must: ['swarup', 'beaufoy'] },
  { q: 'who wrote the silence of the lambs', must: ['harris'] },
  { q: "who wrote schindler's list", must: ['keneally', 'zaillian'] },
  { q: 'who wrote the shawshank redemption', must: ['stephen king', 'darabont'] },
  { q: 'who wrote the princess bride', must: ['goldman'] },
  { q: 'who wrote mary poppins', must: ['travers'] },
  { q: 'who wrote the wizard of oz', must: ['baum'] },
  { q: 'who wrote the devil wears prada', must: ['weisberger'] },
  { q: 'who wrote one hundred years of solitude', must: ['márquez', 'marquez'] },
  { q: 'who wrote crime and punishment', must: ['dostoevsky', 'dostoyevsky'] },
  { q: 'who invented dynamite', must: ['nobel'] },
  { q: 'how many states are there in india', must: ['28'] },
  { q: 'who is the father of the indian constitution', must: ['ambedkar'] },
  { q: 'who designed the indian flag', must: ['venkayya'] },
  { q: 'who wrote the ramcharitmanas', must: ['tulsidas'] },
  { q: 'what does a seismograph measure', must: ['earthquake', 'seismic', 'ground'] },
  { q: 'what does a barometer measure', must: ['pressure'] },
  { q: 'what causes the tides', must: ['moon', 'gravit'] },
  { q: 'what is an exoplanet', must: ['outside the solar system', 'another star', 'orbits a star'] },
  { q: 'what is the ozone layer', must: ['ozone', 'ultraviolet', 'uv'] },
  // contested / fringe pages
  { q: "who wrote shakespeare's plays", must: ['shakespeare'], fringe: true },
  { q: 'who was jack the ripper', fringe: true },
  { q: 'who is satoshi nakamoto', fringe: true },
  { q: 'who invented the radio', must: ['marconi'], fringe: true },
  { q: 'who invented the airplane', must: ['wright'], fringe: true },
  { q: 'who discovered america first', fringe: true },
  { q: 'who wrote the voynich manuscript', fringe: true },
  { q: 'who built stonehenge', fringe: true },
  { q: 'who killed jfk', must: ['oswald'], fringe: true },
  { q: 'who painted the salvator mundi', must: ['leonardo'], fringe: true },
  { q: 'who discovered neptune', must: ['le verrier', 'galle', 'adams'], fringe: true },
  { q: 'who invented the jet engine', must: ['whittle', 'ohain'], fringe: true },
  { q: 'who discovered insulin', must: ['banting', 'best', 'macleod', 'collip'], fringe: true },
  // Hinglish, searched raw exactly as the live lane does
  { q: 'mahabharat kisne likhi', must: ['vyasa'] },
  { q: 'chand par sabse pehle kaun gaya', must: ['armstrong'] },
  { q: 'gateway of india kisne banwaya', must: ['wittet'] },
  { q: 'ganga nadi kahan se nikalti hai', query: 'Ganges source', must: ['gangotri', 'gaumukh'] },
  { q: 'cv raman ko nobel prize kab mila', query: 'C. V. Raman Nobel Prize', must: ['1930'] },
  { q: '1983 world cup mein india ka captain kaun tha', query: '1983 Cricket World Cup India captain', must: ['kapil'] },
  { q: 'bharat ki sabse lambi nadi kaunsi hai', query: 'longest river in India', must: ['ganga', 'ganges'] },
  { q: 'ashoka chakra mein kitni teeliyan hain', query: 'Ashoka Chakra spokes', must: ['24'] },
  { q: 'jaipur ko pink city kyun kehte hain', query: 'Jaipur Pink City', must: ['pink', 'paint'] },
  { q: 'lotus temple kisne design kiya', query: 'Lotus Temple architect', must: ['sahba'] },
  { q: 'imphal kis rajya ki rajdhani hai', query: 'Imphal', must: ['manipur'] },
  { q: 'ladakh ki rajdhani kya hai', query: 'Ladakh capital', must: ['leh'] },
  { q: 'sabse bada grah kaunsa hai', query: 'largest planet in the Solar System', must: ['jupiter'] },
  { q: 'lata mangeshkar ka janm kab hua', query: 'Lata Mangeshkar', must: ['1929'] },
  { q: 'kohinoor heera abhi kahan hai', must: ['tower of london', 'crown jewels', 'london'] },
  // a search that landed on the wrong page (the source does not hold the answer)
  { q: 'who painted the school of athens', page: 'Mona Lisa', decline: true, leak: ['raphael', 'school of athens'] },
  { q: 'who was the first president of the united states', page: 'Benjamin Franklin', decline: true, leak: ['washington'] },
  { q: 'who wrote macbeth', page: 'King Lear', decline: true, leak: ['macbeth'] },
  { q: 'what is the capital of canada', page: 'Toronto', decline: true, leak: ['ottawa'] },
  { q: 'what is the national flower of india', page: 'Indian peafowl', decline: true, leak: ['lotus'] },
  { q: "who was india's first prime minister", page: 'Rajendra Prasad', decline: true, leak: ['nehru'] },
  { q: 'who commanded apollo 11', page: 'Apollo 13', decline: true, leak: ['armstrong', 'apollo 11'] },
  { q: 'what is the largest planet', page: 'Neptune', decline: true, leak: ['jupiter', 'largest planet'] },
  { q: 'who composed the blue danube', page: 'Vienna', decline: true, leak: ['strauss', 'danube waltz'] },
  { q: 'who wrote wuthering heights', page: 'Jane Eyre', decline: true, leak: ['emily', 'wuthering'] },
  { q: 'what is the currency of vietnam', page: 'Thailand', decline: true, leak: ['dong', 'đồng'] },
  { q: 'who discovered the structure of dna', page: 'Rosalind Franklin', decline: true, leak: ['watson', 'crick'] },
  { q: 'how tall is the burj khalifa', page: 'Shanghai Tower', decline: true, leak: ['828', 'burj'] },
  { q: 'who built the golden gate bridge', page: 'Brooklyn Bridge', decline: true, leak: ['golden gate', 'strauss'] },
  { q: 'what is the capital of tanzania', page: 'Dar es Salaam', decline: true, leak: ['dodoma'] },
  { q: 'who won the 2019 cricket world cup', page: '2015 Cricket World Cup', decline: true, leak: ['2019'] },
  { q: 'who invented the phonograph', page: 'Nikola Tesla', decline: true, leak: ['edison', 'phonograph'] },
  { q: 'who directed dilwale dulhania le jayenge', page: 'Shah Rukh Khan', decline: true, leak: ['aditya chopra'] },
  { q: 'who founded microsoft', page: 'Apple Inc.', decline: true, leak: ['gates', 'paul allen'] },
  { q: 'what is the boiling point of ethanol', page: 'Methanol', decline: true, leak: ['78'] },
];

if (require.main === module) (async () => {
  const out = [];
  for (const it of ITEMS) {
    const r = await WF.lookup(it.page || it.query || it.q);
    if (!r) { console.log('NO SOURCE   ' + it.q + '  (the live lane would go straight to research)'); out.push(Object.assign({}, it, { source: null })); continue; }
    const source = r.source;
    const low = source.text.toLowerCase();
    const has = it.must ? it.must.filter(m => low.includes(m)) : [];
    const leaked = it.leak ? it.leak.filter(w => low.includes(w)) : [];
    if (leaked.length) console.log('LEAK — the wrong page holds ' + leaked.join(', ') + ' — swap the page for ' + it.q);
    out.push(Object.assign({}, it, { source }));
    console.log((it.page ? 'WRONG PAGE ' : has.length ? 'HAS ' + has.join('|') + ' ' : 'NOT IN SOURCE ') + it.q + '  ← ' + source.title +
      '\n   ' + source.text.replace(/\s+/g, ' ').slice(0, 240));
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'v42_check_heldout.json'), JSON.stringify({
    _about: 'FRESH held-out for the Wikipedia-lane answer check (grounded.supported replacement), written 2026-10-08 before any candidate check was built; sources fetched live and frozen; 0 overlap with every earlier question set. See build_check_heldout_v42.js.',
    items: out }, null, 1) + '\n');
  console.log('wrote', out.length, '— with a source', out.filter(r => r.source).length, '— wrong-page', out.filter(r => r.page).length);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });

module.exports = { ITEMS };
