#!/usr/bin/env node
// SECOND fresh held-out for the Wikipedia-lane answer check (2026-10-08, his "try to get the best"): the CONFIRMATION set.
// Round 1 chose the shipped check on data/v42_check_heldout.json (114) out of ~16 candidates, so that set is now the
// TUNING set; every round-2 candidate is chosen there and scored on this one exactly once (finetune/README "Round 2").
//
// Questions: none in any earlier held-out (set 1 included), training question file, training row, his messages or the
// stress set (check_heldout_overlap.js build_check_heldout2_v42.js). Set 1 had only 17 replies that had to be sent on,
// so this one leans on searches that landed on a RELATED wrong page — one that names a plausible wrong answer (Apollo 13's
// commander for an Apollo 12 question): that is where the shipped check keeps wrong answers built from the page's words.
// Same kinds otherwise: lead / snippet / not in the source, sense traps, contested pages, Hinglish (searched in English
// via `query` — raw Hinglish finds no page for most questions — plus a few raw), and unrelated wrong pages.
// Sources: like server.js wikiSource(q) (or the `page` / `query` given), frozen — and the raw search hits and summary
// are kept too (`raw`), so the source can be recomposed if grounded.clip ever changes.
//   node build_check_heldout2_v42.js → data/v42_check_heldout2.json
const fs = require('fs');
const path = require('path');
const WF = require('./wikifetch');

const ITEMS = [
  // natural live search, English
  { q: 'what is the capital of cambodia', must: ['phnom penh'] },
  { q: 'what is the capital of ethiopia', must: ['addis ababa'] },
  { q: 'what is the capital of chile', must: ['santiago'] },
  { q: 'what is the capital of chhattisgarh', must: ['raipur'] },
  { q: 'what is the capital of tripura', must: ['agartala'] },
  { q: 'what is the capital of iceland', must: ['reykjavík', 'reykjavik'] },
  { q: 'what is the currency of malaysia', must: ['ringgit'] },
  { q: 'what is the currency of egypt', must: ['pound'] },
  { q: 'who founded paytm', must: ['vijay shekhar sharma'] },
  { q: 'who founded ola cabs', must: ['aggarwal'] },
  { q: 'who founded reliance industries', must: ['dhirubhai'] },
  { q: 'who founded spacex', must: ['musk'] },
  { q: 'who discovered pluto', must: ['tombaugh'] },
  { q: 'who painted the kiss', must: ['klimt'] },
  { q: 'who painted the arnolfini portrait', must: ['van eyck'] },
  { q: 'who composed carmen', must: ['bizet'] },
  { q: 'who composed the rite of spring', must: ['stravinsky'] },
  { q: 'who directed dangal', must: ['nitesh tiwari'] },
  { q: 'who directed pushpa', must: ['sukumar'] },
  { q: 'who directed spirited away', must: ['miyazaki'] },
  { q: 'who wrote the namesake', must: ['lahiri'] },
  { q: 'who wrote the guide', must: ['narayan'] },
  { q: 'who wrote the hungry tide', must: ['amitav ghosh'] },
  { q: 'who wrote the picture of dorian gray', must: ['wilde'] },
  { q: 'who wrote moby dick', must: ['melville'] },
  { q: 'who wrote the catcher in the rye', must: ['salinger'] },
  { q: 'who wrote the road', must: ['mccarthy'] },
  { q: 'who wrote it', must: ['stephen king'] },
  { q: 'how tall is mount kilimanjaro', must: ['5,895', '5895', '19,341'] },
  { q: 'how long is the amazon river', must: ['6,400', '6400', '7,000', '6,992'] },
  { q: 'how far is mars from the sun', must: ['228', '1.52', '1.5 au'] },
  { q: 'what is the boiling point of mercury', must: ['356', '674'] },
  { q: 'what is the atomic number of iron', must: ['26'] },
  { q: 'how many teeth does an adult human have', must: ['32', 'thirty-two'] },
  { q: 'how many strings does a sitar have', must: ['18', '19', '20', '21'] },
  { q: 'when did india win its first olympic gold medal', must: ['1928'] },
  { q: 'what does an ammeter measure', must: ['current'] },
  { q: 'what does a hygrometer measure', must: ['humidity'] },
  { q: 'what is a quasar', must: ['nucleus', 'black hole', 'luminous'] },
  { q: 'what is osmosis', must: ['membrane', 'solvent'] },
  { q: 'what is a recession', must: ['decline', 'economic'] },
  { q: 'what is an astronomical unit', must: ['distance', 'earth', 'sun'] },
  { q: 'who invented the microscope', must: ['janssen', 'leeuwenhoek', 'lippershey'], fringe: true },
  { q: 'who invented the television', must: ['baird', 'farnsworth'], fringe: true },
  { q: 'who discovered oxygen', must: ['priestley', 'scheele', 'lavoisier'], fringe: true },
  // contested / fringe pages
  { q: 'who built the pyramids of giza', fringe: true },
  { q: 'who was the real robin hood', fringe: true },
  { q: 'who is banksy', fringe: true },
  { q: 'what happened to amelia earhart', fringe: true },
  { q: 'who invented the computer', must: ['babbage', 'turing', 'zuse', 'eniac'], fringe: true },
  { q: 'who invented chess', must: ['india', 'chaturanga'], fringe: true },
  { q: 'is the great wall of china visible from space', fringe: true },
  { q: 'did humans land on the moon', fringe: true },
  // Hinglish — searched in English (`query`), as a query-rewrite step would; and three raw
  { q: 'virat kohli ki biwi kaun hai', query: 'Virat Kohli', must: ['anushka'] },
  { q: 'mangal grah ko laal grah kyu kehte hain', query: 'Mars red planet', must: ['iron oxide', 'iron'] },
  { q: 'rashtrapati bhavan kisne design kiya', query: 'Rashtrapati Bhavan', must: ['lutyens'] },
  { q: 'nalanda vishwavidyalaya kisne banwaya', query: 'Nalanda mahavihara', must: ['kumaragupta', 'gupta'] },
  { q: 'chandrayaan 3 kab launch hua', query: 'Chandrayaan-3', must: ['14 july 2023', '2023'] },
  { q: 'dilli ka purana naam kya tha', query: 'Delhi history name', must: ['indraprastha', 'shahjahanabad'] },
  { q: 'holi kyu manate hain', query: 'Holi festival', must: ['spring', 'good over evil', 'radha'] },
  { q: 'taj mahal kis nadi ke kinare hai', query: 'Taj Mahal', must: ['yamuna'] },
  { q: 'lal bahadur shastri ka janam kab hua', query: 'Lal Bahadur Shastri', must: ['1904'] },
  { q: 'sachin tendulkar ka janam kab hua', query: 'Sachin Tendulkar', must: ['1973'] },
  { q: 'starry night kisne banayi', must: ['van gogh'] },
  { q: 'pani ka formula kya hai', must: ['h2o', 'h₂o'] },
  { q: 'surya grahan kyu hota hai', must: ['moon'] },
  // a search that landed on a RELATED wrong page — one that names a plausible wrong answer
  { q: 'who was the first american in space', page: 'John Glenn', decline: true, leak: ['shepard'] },
  { q: 'who was the first indian woman in space', page: 'Rakesh Sharma', decline: true, leak: ['kalpana', 'chawla'] },
  { q: 'what is the capital of vietnam', page: 'Ho Chi Minh City', decline: true, leak: ['hanoi'] },
  { q: 'what is the capital of myanmar', page: 'Mandalay', decline: true, leak: ['naypyidaw', 'nay pyi taw'] },
  { q: 'what is the capital of brazil', page: 'São Paulo', decline: true, leak: ['brasília', 'brasilia'] },
  { q: 'who painted the last judgment', page: 'Titian', decline: true, leak: ['michelangelo', 'last judgment'] },
  { q: 'who wrote emma', page: 'Charlotte Brontë', decline: true, leak: ['austen'] },
  { q: 'who wrote the iliad', page: 'Virgil', decline: true, leak: ['homer'] },
  { q: 'who discovered the circulation of blood', page: 'Andreas Vesalius', decline: true, leak: ['harvey'] },
  { q: 'who invented the steam engine', page: 'Thomas Edison', decline: true, leak: ['watt', 'newcomen', 'steam'] },
  { q: 'who founded google', page: 'Microsoft', decline: true, leak: ['larry page', 'brin'] },
  { q: 'who founded instagram', page: 'Twitter', decline: true, leak: ['systrom', 'krieger'] },
  { q: 'what is the largest ocean', page: 'Atlantic Ocean', decline: true, leak: ['pacific'] },
  { q: 'what is the smallest planet', page: 'Mars', decline: true, leak: ['mercury'] },
  { q: 'what is the coldest planet', page: 'Pluto', decline: true, leak: ['uranus'] },
  { q: 'who won the 2007 t20 world cup', page: '2009 ICC World Twenty20', decline: true, leak: ['2007'] },
  { q: 'who won the first cricket world cup', page: '1987 Cricket World Cup', decline: true, leak: ['1975', 'west indies'] },
  { q: 'who wrote the national song of india', page: 'Rabindranath Tagore', decline: true, leak: ['bankim', 'vande mataram'] },
  { q: 'who is known as the iron man of india', page: 'B. R. Ambedkar', decline: true, leak: ['patel', 'iron man'] },
  { q: 'who directed mother india', page: 'Nargis', decline: true, leak: ['mehboob'] },
  { q: 'what is the capital of rajasthan', page: 'Bikaner', decline: true, leak: ['jaipur'] },
  { q: 'what is the chemical symbol for sodium', page: 'Potassium', decline: true, leak: ['sodium', ' na '] },
  { q: 'what is the speed of sound in air', page: 'Speed of light', decline: true, leak: ['343', '1,235'] },
  { q: 'who was the first prime minister of pakistan', page: 'Muhammad Ali Jinnah', decline: true, leak: ['liaquat'] },
  { q: 'who was the first person to reach the south pole', page: 'Ernest Shackleton', decline: true, leak: ['amundsen'] },
  // unrelated wrong pages
  { q: 'how tall is the leaning tower of pisa', page: 'Colosseum', decline: true, leak: ['pisa', '56', '57 m'] },
  { q: 'who invented the bicycle', page: 'Motorcycle', decline: true, leak: ['drais', 'bicycle'] },
  { q: 'who founded the scout movement', page: 'YMCA', decline: true, leak: ['baden-powell', 'scout'] },
  { q: 'what is the population of japan', page: 'Mount Fuji', decline: true, leak: ['million'] },
  { q: 'who wrote the constitution of the united states', page: 'Statue of Liberty', decline: true, leak: ['madison', 'constitution'] },
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
    out.push(Object.assign({}, it, { source, raw: { hits: r.hits.slice(0, 3).map(h => ({ title: h.title, snippet: h.snippet })), summary: r.summary } }));
    console.log((it.page ? 'WRONG PAGE ' : has.length ? 'HAS ' + has.join('|') + ' ' : 'NOT IN SOURCE ') + it.q + '  ← ' + source.title +
      '\n   ' + source.text.replace(/\s+/g, ' ').slice(0, 240));
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'v42_check_heldout2.json'), JSON.stringify({
    _about: 'SECOND fresh held-out (confirmation set) for the Wikipedia-lane answer check, written 2026-10-08 before any round-2 candidate was built; sources fetched live and frozen (raw hits + summary kept); 0 overlap with every earlier question set incl. v42_check_heldout.json. See build_check_heldout2_v42.js.',
    items: out }, null, 1) + '\n');
  console.log('wrote', out.length, '— with a source', out.filter(r => r.source).length, '— wrong-page', out.filter(r => r.page).length);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });

module.exports = { ITEMS };
