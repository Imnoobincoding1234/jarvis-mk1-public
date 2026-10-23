'use strict';
// MEASUREMENT SCRIPT — not a test. Does the find-businesses playbook region take what it should, and only that?
//
// Written 2026-10-09, BEFORE the region's exemplars, after his live turn "Okay find businesses in my locality without a
// website and provide me their phone numbers" had no procedure: the loop offered to be taught, then ran one Safari search
// and called it done. Nothing below may be copied into playbook.js as an exemplar: this is the held-out side.
//
// Usage: node sweeps/sweep_playbook_business.js      (needs ollama + nomic-embed-text)
const pb = require('../playbook.js');
pb.init({ jlog: () => {} });

const TAKE = [
  'Okay find businesses in my locality without a website and provide me their phone numbers',   // his live turn
  'get me a list of gyms in mohali and their contact numbers',
  'which bakeries around me dont have websites',
  'find local shops that need a website, with numbers',
  'pull up phone numbers of tailors nearby',
  'show me businesses in chandigarh sector 17 without an online presence',
  'koi dukaan jiska website nahi hai, unke number chahiye',
  'mohali mein salons ki list bana do number ke saath',
  'find me leads: local restaurants without websites',
  'any clinics near me without a site? need their numbers',
  'list hardware stores in kharar',
  'aas paas ke coaching centres ke contact nikal',
];
const LEAVE = [
  'order a pizza from dominos',
  'google the best cafe in ludhiana and open the first one',
  'what is the phone number of my dad',
  'message the plumber that i will be late',
  'research the restaurant industry in india',
  'who owns the bakery chain monginis',
  'make a website for my business',
  'open google maps',
  'how many shops are there in india',
  'search youtube for how to start a bakery',
  'call papa on whatsapp',
  'tidy up my downloads folder',
  'add a meeting with the shop owner tomorrow at 5',
  'whats the best phone under 20k',
  'save this number for the electrician',
  'find my nearest metro station',
  'send the list of leads to parth on whatsapp',
  'fill in the contact form on this site',
  'look up the price of a playstation and open the top link',
  'what time does the mall close today',
];

// SET 2 — written after set 1 showed 4/20 wrong takes and BEFORE the structural fix for them (a `none` region for talk
// ABOUT businesses, and exemplars that lean on the action rather than the nouns). Set 1 is the dev set from then on;
// set 2 is the confirmation. SET=2 runs it.
const TAKE2 = [
  'need numbers of all the electricians in my area',
  'find printing shops in phase 7 mohali',
  'local businesses with no website near kharar, list them',
  'jo shops online nahi hain unki list do',
  'get contacts for car repair garages nearby',
  'scan my neighbourhood for small businesses i could pitch to',
  'restaurants around here that only have a facebook page',
  'mujhe nazdeek ke dentists ke number chahiye',
  'compile a list of boutiques in chandigarh with phone numbers',
  'which pet shops near me lack a website',
  'show salons near me',
  'businesses around sector 70 mohali, numbers please',
];
const LEAVE2 = [
  'how do i start a small business',
  'build a landing page for a bakery',
  'what does a website cost in india',
  'email the client the proposal',
  'what is the gdp of punjab',
  'open my business notes',
  'remind me to call the salon at 4',
  'search for website templates on google',
  'who is the richest businessman in india',
  'play some music while i work',
  'how far is the airport from here',
  'give me ideas for a business name',
  'whatsapp the electrician my address',
  'what is seo',
  'book a table at a restaurant for 8',
  'read the reviews of this shop on google',
  'compare iphone and pixel prices',
  'translate this to punjabi',
  'where is the nearest atm',
  'set up a google business profile for my shop',
];
const T = process.env.SET === '2' ? TAKE2 : TAKE, L = process.env.SET === '2' ? LEAVE2 : LEAVE;

(async () => {
  let took = 0, wrong = 0;
  console.log('— should be find-businesses —');
  for (const g of T) {
    const m = await pb.semanticMatch(g);
    const ok = m && m.id === 'find-businesses'; if (ok) took++;
    console.log((ok ? 'TAKE ' : 'MISS ') + (m ? m.id + ' ' + m.margin.toFixed(3) : 'none') + '  ' + g);
  }
  console.log('— must not be find-businesses —');
  for (const g of L) {
    const m = await pb.semanticMatch(g);
    const bad = m && m.id === 'find-businesses'; if (bad) wrong++;
    console.log((bad ? 'WRONG ' : 'ok    ') + (m ? m.id + ' ' + m.margin.toFixed(3) : 'none') + '  ' + g);
  }
  console.log('\nSET ' + (process.env.SET || '1') + ': taken ' + took + '/' + T.length + ', wrongly taken ' + wrong + '/' + L.length);
  process.exit(0);
})();
