// Memory: what gets STORED, and which stored fact ANSWERS a question.
//
// Both halves were keyword traps until 2026-09-12 and both failed in the same live exchange:
//
//     ◆ i hate summer and enjoy winters      → nothing stored (SELF_FACT_RE wanted "my X is Y")
//     ◆ do i hate summer                     → answered with the hates-list, which shares only the
//                                              letters "hate" (retrieval was substring overlap)
//
// Needs ollama. Skips itself rather than failing if the embedder is unreachable.
const sf = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/selffact.js');
const fm = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/factmatch.js');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

(async () => {
  if (!(await sf.isSelfFact('my favourite colour is teal'))) {
    console.log('\nSkipping — the embedder is not answering (is ollama running?)');
    process.exit(0);
  }

  console.log('\n— a fact about him is stored whatever frame he says it in —');
  // THE ONE FROM HIS SCREENSHOT. Under the regex this stored nothing at all.
  eq('"i hate summer and enjoy winters"', await sf.isSelfFact('i hate summer and enjoy winters'), true);
  // Held out: none of these is an exemplar, and none begins with "my … is".
  for (const s of ['i really dislike crowded places', 'i am vegetarian on tuesdays',
                   'my dog is called bruno', 'i cannot stand loud chewing',
                   'i drink my coffee black', 'i am left handed']) {
    eq('"' + s + '"', await sf.isSelfFact(s), true);
  }

  console.log('\n— a reading is not a fact —');
  // The old TRANSIENT_FACT_RE was a list of device nouns; "my hands are freezing" was on nobody's
  // list and would have been filed forever.
  for (const s of ['my phone is at ten percent', 'my hands are freezing', 'i am running late today']) {
    eq('"' + s + '" is not stored', await sf.isSelfFact(s), false);
  }

  console.log('\n— and neither is a command or a fact about the world —');
  for (const s of ['open the calculator', 'send parth a message',
                   'delhi is the capital of india', 'play something by drake']) {
    eq('"' + s + '" is not stored', await sf.isSelfFact(s), false);
  }

  console.log('\n— the right fact answers the question —');
  const FACTS = [
    'Atharv hates being woken up early, hates phone calls, and hates people being late.',
    'Atharv hates summer and enjoys winters.',
    'Atharv is allergic to peanuts.',
    'Atharv lives in Ludhiana.',
    "Atharv's favourite colour is teal.",
    "Atharv's sister is called Anaya.",
  ];
  const top = async q => { const r = await fm.rank(q, FACTS, 3); return r.length ? r[0].text : null; };
  // THE ONE FROM HIS SCREENSHOT: this returned the hates-list, on the word "hate".
  eq('"do i hate summer" finds the summer fact', await top('do i hate summer'),
     'Atharv hates summer and enjoys winters.');
  eq('"do i hate phone calls" still finds the hates-list', await top('do i hate phone calls'),
     'Atharv hates being woken up early, hates phone calls, and hates people being late.');
  // RECOVERED BY STAGE TWO. This pulls its own fact to only 0.520 — below two of the adversarial
  // pairs — so no cosine floor can have it and refuse them. The numbered-selection pass picks it.
  eq('"where do i live" is recovered from under the floor', await top('where do i live'),
     'Atharv lives in Ludhiana.');
  eq('"am i allergic to anything"', await top('am i allergic to anything'), 'Atharv is allergic to peanuts.');
  eq('"what is my sister called"', await top('what is my sister called'), "Atharv's sister is called Anaya.");

  console.log('\n— sharing a word with a fact is not the same as being answered by it —');
  // The adversarial half. Each of these shares its subject with a stored fact and differs in the
  // object, which is as close as a wrong answer gets — and is precisely what substring matching
  // could never tell apart.
  for (const q of ['do i hate mondays', 'am i allergic to cats', 'what is my favourite film',
                   'where does my sister live']) {
    eq('"' + q + '" returns nothing rather than a near miss', await top(q), null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
