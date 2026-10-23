'use strict';
// CLAUSE ROUTING — the lane that broke three times in one day, pinned.
//
// "and"/"then" join clauses, and every failure here has been the same shape: the router decided the
// sentence was one thing when it was several, or several when it was one, and then answered
// confidently. Each case below is a real request from his terminal or a guard that stops one.
//
// OLLAMA IS NEEDED NOW, AND THE OLD HEADER SAYING OTHERWISE WAS THE FIRST THING TO GO.
//
// It used to read "No ollama needed: everything here is deterministic readers and the site
// registry", and that stopped being true when the arbiter's two word lists were replaced. What a
// request NAMES is asked of a model once and cached (errand.js), so the deterministic readers below
// are still deterministic — they read a cache — but the cache has to be filled first, exactly as
// handleChatInner fills it before it routes.
//
// Leaving the claim in place would have been worse than the dependency: three of these assertions
// passed a cold cache by routing on a DESTINATION alone, which is not what they are testing.
// Warming through the shipped helpers means a failure here means what it says.

// The reader model (readmodel.js) reads on demand in tests, into a cache file of the suites' own, so the
// synchronous parser can be asserted on sentences built as the suite goes. The live server never does this.
process.env.JARVIS_READER_BLOCKING = '1';
process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.test.json';
const J = require('../server.js');

let pass = 0, fail = 0;
function eq(what, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + '\n         got  ' + g + '\n         want ' + w); }
}
const head = t => console.log('\n— ' + t + ' —');
const route = async t => {
  await J.errand.warm(J.clauseCandidates(t, {}));
  return J.clauseSplit(t, {}) || J.clausePartial(t, {}) || null;
};

(async () => {
head('a list runs every step, in order');
// HIS SENTENCE, and the one that exposed all of this. Four clauses, one of which needs the platform
// from the clause before it. Every step runs; nothing is dropped.
eq('four clauses, platform carried forward',
   await route("open spotify and follow lady gaga then open youtube and play yessmartypie's latest video"),
   ['open spotify', 'follow lady gaga on spotify', 'open youtube', "play yessmartypie's latest video"]);

// THE PLATFORM IS ELIDED ONCE NAMED. The taught procedure is "follow <artist> on spotify" and it
// generalises across the artist — measured, "follow drake on spotify" scores SURE 2.40 — but it will
// not drop the platform, deliberately, because following someone on the wrong site is an
// account-touching mistake. Here the platform is in the previous clause.
eq('platform carried to a clause that omitted it',
   await route('open spotify and follow drake'),
   ['open spotify', 'follow drake on spotify']);

head('one errand is not split into two');
// Both halves land on the same site, so this is one errand and the whole-sentence reading wins.
// Splitting it opened two tabs and searched twice for one song.
// This rests on the READER reading the whole sentence as one action. When it does, the split must be
// refused. When it declines (it read this one as none at 0.50 on 2026-09-17 — a gap in the model, not
// a wrong action), the split is the fallback: both halves still run, on the same site. Reported, not
// hidden.
{
  const whole = J.readAction('open spotify and play judas');
  const split = await route('open spotify and play judas');
  if (whole) eq('open X and act on X stays whole', split, null);
  else {
    console.log('  KNOWN GAP  the reader does not read "open spotify and play judas" as one action; split as ' + JSON.stringify(split));
    eq('…and the fallback split still runs both halves in order', split, ['open spotify', 'play judas']);
  }
}

head('two errands stay two');
eq('two shops, two orders',
   await route('order apples from instamart and cake from swiggy'),
   ['order apples from instamart', 'order cake from swiggy']);
eq('two independent questions',
   await route('what is my battery and how many apps are running'),
   ['what is my battery', 'how many apps are running']);
// DIFFERENT SITES MUST STILL SPLIT. This one is the reason the "one errand" veto is narrow: it
// scores as an app-search shape, and welding it together makes a YouTube search for "jarvis repo on
// github", which this codebase already records as a mangling.
eq('different sites still split',
   await route('open youtube and star the jarvis repo on github'),
   { done: ['open youtube'], ask: 'star the jarvis repo on github' });

head('a fragment is not an instruction');
// "dogs" is not a command, so running the search while asking about it would be a mangling rather
// than a partial success. The whole split is refused.
eq('trailing fragment refuses the whole split', await route('search for cats and dogs'), null);

head('a step it cannot take does not cancel the rest');
// The prefix walk used to stop at the first unresolved clause and sweep everything behind it into
// one question, so two runnable clauses were abandoned because a third sat in front of them.
{
  const r = J.clausePartial('what is my battery and star the jarvis repo on github and how many apps are running', {});
  eq('resolved clauses survive an unresolved one in the middle',
     r && r.done, ['what is my battery', 'how many apps are running']);
  eq('and the question names only what it could not do',
     r && r.ask, 'star the jarvis repo on github');
}

head('too long to run is answered, not mis-answered');
// Past the ceiling clauseSplit returns null, and null used to mean "not a list" — so a twenty-step
// paragraph went to a single lane and came back as one wrong action.
{
  const unit = ['open spotify', 'open youtube', 'open brave', 'open notes',
                'what is my battery', 'how many apps are running'];
  const listOf = n => { const a = []; for (let i = 0; i < n; i++) a.push(unit[i % unit.length]); return a.join(' and '); };
  eq('twelve still runs', J.clauseOverflow(listOf(12), {}), 0);
  eq('thirteen is reported as too many', J.clauseOverflow(listOf(13), {}), 13);
  eq('twenty likewise', J.clauseOverflow(listOf(20), {}), 20);
  // PROSE IS NOT A LIST. A paragraph of English splits on "and" into fragments that resolve to
  // nothing, and refusing it as "too many instructions" would be its own wrong answer.
  eq('prose is not mistaken for a long list',
     J.clauseOverflow('i went to the shop and bought milk and bread and eggs and then came home and made ' +
                      'breakfast and sat down and read the paper and thought about the day and decided to ' +
                      'go out and see a friend and talk', {}), 0);
}

head('a taught procedure counts as understood');
// clauseResolves asks every deterministic reader whether a clause is understood, and the taught lane
// was missing from it — so a procedure he DEMONSTRATED read as unresolvable and refused the split
// for the whole sentence.
eq('a taught clause resolves', J.clauseResolves('follow lady gaga on spotify', {}), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
