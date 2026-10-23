'use strict';
// MEASUREMENT SCRIPT — not a test. Which playbook region do file requests land in?
//
// Written 2026-09-17, BEFORE any exemplar was added for it, after "Create a new folder and label it as
// JARVIS MK two" (by voice, 2026-09-16) was claimed by files-make-many and spent 76 s in the agent loop
// over one folder. The playbook regions had nowhere for a ONE-call file request to land, so it took the
// nearest region — a missing region, not a bad threshold.
//
// Nothing below may be copied into playbook.js as an exemplar: this is the held-out side.
//
// Usage: node sweep_playbook.js        (needs ollama and nomic-embed-text; reads state/centroids.json)
const pb = require('../playbook.js');
pb.init({ jlog: () => {} });

const SETS = {
  // one file or folder, one call — the action lane owns these, so no procedure may claim them
  single: [
    'Create a new folder and label it as JARVIS MK two',
    'make a folder called invoices on my desktop',
    'create a file named todo.txt',
    'new folder called receipts',
    'delete old_notes.txt',
    'read the file budget.txt',
    "what's in my downloads folder",
    'add the line buy milk to list.txt',
    'create a folder named mark 3',
    'make me a file called ideas.md saying hello',
    'put a new folder on my desktop called photos',
    'get rid of the scratch folder',
  ],
  // several things made in one go — files-make-many is right for these
  many: [
    'create three files called a.txt b.txt and c.txt',
    'make a folder called site and put an index.html inside it',
    'create five empty text files on my desktop',
    'make two folders named alpha and beta in documents',
    'create a folder called notes with a file inside called ideas.txt',
    'generate ten blank files in the test folder',
  ],
  // tidying — files-organise
  organise: [
    'sort my downloads into folders by type',
    'tidy my desktop',
    'clean up the mess in my documents folder',
  ],
};
const WANT = { single: null, many: 'files-make-many', organise: 'files-organise' };

(async () => {
  let right = 0, wrong = 0, missed = 0;
  for (const [set, goals] of Object.entries(SETS)) {
    console.log('\n— ' + set + ' (want ' + (WANT[set] || 'no procedure') + ') —');
    for (const g of goals) {
      const r = await pb.semanticMatch(g);
      const got = r ? (r.group || r.id) : null;
      const verdict = got === WANT[set] ? 'ok   ' : (got === null ? 'MISS ' : 'WRONG');
      if (verdict === 'ok   ') right++; else if (got === null) missed++; else wrong++;
      console.log('  ' + verdict + ' ' + JSON.stringify(g).padEnd(72) + ' → ' + (got || 'none') +
        (r ? '  (region ' + r.id + ', sim ' + r.sim.toFixed(3) + ', margin ' + r.margin.toFixed(3) + ')' : ''));
    }
  }
  console.log('\nright ' + right + '   wrong ' + wrong + '   missed ' + missed);
  process.exit(0);
})();
