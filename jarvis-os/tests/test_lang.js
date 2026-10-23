'use strict';
// NEEDS OLLAMA for the semantic half. Not loaded by server.js.
//
// Two questions: does the detector tell his Hinglish from his English, and does routing Hinglish to
// granite actually close the leaks it was built to close?

// The reader model (readmodel.js) reads on demand in tests, into a cache file of the suites' own, so the
// synchronous parser can be asserted on sentences built as the suite goes. The live server never does this.
process.env.JARVIS_READER_BLOCKING = '1';
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.test.json';
const J = require('../server.js');       // wires lang.js's registries and warms Contacts
const lang = require('../lang.js');
const intent = require('../intent.js');
const web = require('../webintent.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

// HELD OUT. The English half is deliberately full of the shape that broke the first detector: short
// commands whose only unusual token is the name of an app, a site or a person.
const ENGLISH = [
  'open spotify', 'open notes', 'message kunal', 'call mama', 'open zomato',
  'play judas', 'play drake', 'open brave', 'follow lady gaga', 'text kunal saying hi',
  'who is mrbeast', 'open the app store and find chess', "play yessmartypie's latest video",
  'what is the diameter of jupiter', 'remind me what I told you last week',
  'is my laptop charging', 'star the jarvis repo on github',
  'order apples from instamart and cake from swiggy', 'take a screenshot', 'what is my battery at',
];
const HINGLISH = [
  'sundar pichai kaun hai', 'mere bhai ka naam kya hai', 'mujhe kal kya karna hai',
  'mere contacts dikhao', 'nayi iphone kab release hogi', 'elon musk ki net worth kitni hai',
  'bitcoin ka rate kya hai abhi', 'spotify kholo aur judas chalao', 'japan ki rajdhani kya hai',
  'kal koi meeting hai kya', 'safari band karo', 'battery kitni hai',
  'meri photos kholo', 'mummy ko message karo', 'yeh file delete kar do',
];

(async () => {
  if (!await require('../ollama.js').reachable(1500)) {
    console.log('ollama unreachable — this suite needs the embedder. Skipping.');
    process.exit(0);
  }

  // CONTACTS WARM ASYNCHRONOUSLY, and the detector asks them whether a token is a name. Asking
  // before the address book is cached makes "message kunal" look like Hinglish — which is a race in
  // this SUITE, not in the server, where the warm runs at boot long before a request arrives. Waited
  // for explicitly rather than slept on, so a slow address book cannot make this flaky.
  const agent = require('../agent.js');
  try { await agent.warmContacts(); } catch (e) {}
  for (let i = 0; i < 40 && !agent.personIn('kunal'); i++) await new Promise(r => setTimeout(r, 250));

  head('a name is not a language signal');
  // THE FAILURE THAT KILLED THE FIRST VERSION. It spotted proper nouns by LENGTH, and the names he
  // uses are short — so "open spotify", "open notes", "message kunal" and "call mama" all read as
  // Hinglish. The registries answer this properly: the site registry knows spotify, the app index
  // knows Notes, Contacts knows Kunal.
  for (const n of ['spotify', 'notes', 'kunal', 'zomato']) {
    ok(lang.isKnownName(n) === true, '"' + n + '" is a name the system already knows');
  }

  head('English stays English');
  let engWrong = 0;
  for (const t of ENGLISH) {
    const h = await intent.isHinglish(t);
    if (h) { engWrong++; console.log('    called Hinglish: "' + t + '"'); }
  }
  // THIS HALF MUST BE PERFECT. A false Hinglish sends an English sentence to a model whose
  // thresholds are tuned for something else, and English is the overwhelming majority of what he
  // types. A missed Hinglish merely keeps today's behaviour.
  ok(engWrong === 0, 'no English sentence was called Hinglish (' + engWrong + ' wrong)');

  head('Hinglish is caught');
  let hinGot = 0;
  for (const t of HINGLISH) if (await intent.isHinglish(t)) hinGot++;
  console.log('    ' + hinGot + '/' + HINGLISH.length + ' detected');
  // Not all of them, and the number is the point rather than a pass mark. "screenshot le lo" reads as
  // three English words to the dictionary ("le" and "lo" both are) and sits at 0.066 to the semantic
  // half, under the 0.10 floor. It falls to all-minilm, which classifies it correctly anyway.
  ok(hinGot >= HINGLISH.length - 2, 'at least ' + (HINGLISH.length - 2) + '/' + HINGLISH.length + ' detected');

  head('the leaks this was built to close');
  // MEASURED UNDER all-minilm, these three private questions were routed to a search engine.
  for (const t of ['mere bhai ka naam kya hai', 'mujhe kal kya karna hai', 'mere contacts dikhao']) {
    ok((await web.needsWeb(t)) === false, 'stays private: "' + t + '"');
  }
  for (const t of ['mera naam kya hai', 'meri photos kholo', 'safari band karo']) {
    ok((await web.needsWeb(t)) === false, 'stays local: "' + t + '"');
  }

  head('and Hinglish lookups still reach the web');
  for (const t of ['mrbeast kaun hai', 'india ka president kaun hai', 'japan ki rajdhani kya hai']) {
    ok((await web.needsWeb(t)) === true, 'reaches the web: "' + t + '"');
  }

  head('English routing is untouched');
  ok((await web.needsWeb('who is the CEO of BlackRock')) === true, 'the BlackRock question still routes');
  ok((await web.needsWeb('what did I tell you about my mum')) === false, 'and a private English one does not');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
