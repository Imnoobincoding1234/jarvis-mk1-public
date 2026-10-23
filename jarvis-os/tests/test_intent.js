// Intent classification tests — the layer that replaced the keyword tables.
//
// NEEDS OLLAMA. Like test_itemclass.js, this asks the embedder real questions, because the thing
// worth testing is whether the regions actually separate the phrasings a person uses. A stubbed
// embedder would test the arithmetic and nothing that matters.
//
// WHAT THIS IS PROTECTING. Every case below is a phrasing the old `must`/`when` tables got wrong on
// his machine, or a guard added after a wrong action reached his browser. If someone later widens a
// region's exemplars and these start crossing over, that is the signal to stop.
const pb = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/playbook.js');
const agent = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/agent.js');
const intent = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/intent.js');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + g + '\n         want ' + w); }
}
function ok(label, cond) { eq(label, !!cond, true); }

pb.init({ jlog: () => {} });
// resolvesToApp answers null without deps.fuzzyApp, which only server.js injects — a bare require
// would make every app branch look broken and the structural extractor untestable.
const APPS = ['Spotify', 'TextEdit', 'Brave Browser', 'Notes', 'WhatsApp', 'Calculator', 'App Store'];
agent.init({ jlog: () => {}, fuzzyApp: n => {
  const q = String(n || '').toLowerCase().trim();
  for (const a of APPS) {
    const al = a.toLowerCase();
    if (al === q || al.split(' ')[0] === q || q === al.replace(/\s+/g, '')) return { name: a, score: 1 };
  }
  return null;
} });

(async () => {
  console.log('\n— the phrasings the keyword table could not reach —');
  // Each of these scored 0 against the old `must` regexes. The object of a request is an open class
  // (song titles, channel names) and so, in practice, is the verb.
  for (const [goal, id] of [
    ['play judas', 'spotify-play'],
    ['blast judas', 'spotify-play'],
    ['throw on some lady gaga', 'spotify-play'],
    ['ring mama on whatsapp', 'message-someone'],
    ['hunt down rust in brave', 'search-and-open-result'],
  ]) {
    const r = await pb.semanticMatch(goal);
    // THE VERDICT, NOT THE REGION THAT CARRIED IT. A procedure may be recognised by more than one
    // region — `search-a-fact` and `search-then-open` are both search-and-open-result — and which
    // shape a sentence happened to land on is an internal detail. Asserting the region id made this
    // suite fail the moment a junk-drawer region was split in two, while the routing it exists to
    // protect had not changed at all. `group` is the answer the caller acts on; with no groups
    // configured it IS the id, so every other row here reads exactly as before.
    eq('"' + goal + '" → ' + id, r && (r.group || r.id), id);
  }

  console.log('\n— and the ones it got right, which must not regress —');
  for (const [goal, id] of [
    ['play judas by lady gaga', 'spotify-play'],
    ['play some music', 'spotify-play'],
    ['play the latest yessmartypie video', 'youtube-latest-from-channel'],
    ['order me a pizza', 'order-food'],
    ['buy me a phone charger', 'shop-add-to-cart'],
    ['order me a watermelon', 'grocery-add-to-cart'],
  ]) {
    const r = await pb.semanticMatch(goal);
    eq('"' + goal + '" → ' + id, r && (r.group || r.id), id);
  }

  console.log('\n— the `none` region: not everything is a procedure —');
  // Without a none class every sentence lands nearest to SOMETHING, and "what is the weather" gets
  // routed as a shopping trip.
  for (const goal of ['what is the weather', 'who is the ceo of nvidia', 'what is 17 times 23',
                      'how are you today', 'i am bored', 'what did i decide about the trip',
                      'play the game by the rules tomorrow morning at work']) {
    eq('"' + goal.slice(0, 44) + '" is not a procedure', await pb.semanticMatch(goal), null);
  }
  // The one that cost him a wrong action: it is not any of the thirteen, and at MIN_MARGIN 0.02 it
  // was claimed at margin 0.026 and replayed a taught procedure.
  eq('"unsubscribe to Mythpat on youtube" is not a procedure',
     await pb.semanticMatch('unsubscribe to Mythpat on youtube'), null);
  // KNOWN MISS, PAID FOR DELIBERATELY, and recorded here instead of asserted as a pass.
  //
  // "crank up spotify and search for ar rahman" used to be checked on this list. Under
  // nomic-embed-text it reaches spotify-play at margin 0.0347, while the line above — which must be
  // REFUSED — reaches youtube-search-and-open at 0.0370. The wrong one scores higher, so no
  // threshold keeps both, and MIN_MARGIN 0.04 was chosen to protect the refusal. The cost is that
  // "crank up spotify and search for ar rahman" now goes to the agent loop, which opens Spotify and
  // searches, instead of to the procedure. A slower right answer, not a wrong one.
  //
  // Do not repair this by adding an exemplar that mentions searching to spotify-play. See
  // playbook.js MIN_MARGIN for what the honest repair would be.
  {
    const crank = await pb.semanticMatch('crank up spotify and search for ar rahman');
    ok('"crank up spotify …" is a known miss, not a wrong claim', crank === null || (crank.group || crank.id) === 'spotify-play');
  }

  console.log('\n— acting on one item of a page is the loop\'s job, not a procedure —');
  // BOTH OF THESE WERE LIVE WRONG ACTIONS, from his screenshots and the log of 2026-09-12:
  //
  //   archive the oldest thread on example.com  → youtube-latest-from-channel, and the YouTube lane
  //                                               opened a search for the whole sentence
  //   follow the iana link on example.com       → search-and-open-result, which then sat on the page
  //
  // Both are "<verb> the <superlative> <thing> on <name>" — the same shape as "play the latest video
  // from <channel>" — and there was no region for them, so they went to the nearest region that had
  // one. Asserted as the PROPERTY (no procedure claims them) rather than against a region name.
  for (const goal of ['archive the oldest thread on example.com',
                      'follow the iana link on example.com']) {
    eq('"' + goal.slice(0, 44) + '" is not a procedure', await pb.match(goal), null);
  }
  // NOT YET FIXED, AND NOT ASSERTED AS IF IT WERE. "click the login button on this page" still
  // reaches fill-a-form — measured at sim 0.494, margin 0.152 (it was 0.226 before the split, so
  // this moved in the right direction and did not arrive). Clicking a control and filling a form
  // are genuinely adjacent to an embedder, and the repair is NOT to feed this sentence back in as
  // an exemplar: that is tuning on the held-out set, and the next phrasing would break again.
  // Written down here so the gap is visible rather than discovered twice.

  console.log('\n— a split region still answers as one procedure —');
  // The junk drawer that lost its own exemplar to order-food. What must hold is the VERDICT: every
  // region grouped under a procedure answers with that procedure, whichever shape it recognised.
  for (const goal of ['find a recipe for butter chicken and open the first result',
                      'google the best pizza in ludhiana and open the first one',
                      'look up jensen huang']) {
    const r = await pb.semanticMatch(goal);
    eq('"' + goal.slice(0, 44) + '" → search-and-open-result', r && (r.group || r.id), 'search-and-open-result');
  }
  // AND THE GROUPS MAP MUST NOT NAME A PROCEDURE THAT DOES NOT EXIST. A region whose group is a typo
  // routes to `PLAYBOOKS.find(...)` → undefined and the goal is silently dropped — the same class of
  // bug as the arbiter verdict that had no row in ARBITRATED and opened Amazon for bananas.
  for (const [region, group] of Object.entries(pb.GROUPS)) {
    ok('region "' + region + '" groups to a real verdict (' + group + ')',
       group === 'none' || pb.PLAYBOOKS.some(p => p.id === group));
    ok('region "' + region + '" is a region that exists', !!pb.EXEMPLARS[region]);
  }

  console.log('\n— a procedure does not run with an unfilled slot —');
  // ◆ play his latest video  →  Opening https://www.youtube.com/@/videos   (404)
  eq('"play his latest video" is not claimed', await pb.match('play his latest video'), null);
  const good = await pb.match('play the latest yessmartypie video');
  eq('…but a named channel still is', good && good.slots.query, 'yessmartypie');
  eq('"open youtube" has nothing to search for', await pb.match('open youtube'), null);
  // An optional slot is not a broken one.
  const music = await pb.match('play some music');
  ok('"play some music" still matches with an empty query', music && music.pb.id === 'spotify-play');

  console.log('\n— a one-call lane keeps its request —');
  // Routing these through the agentic loop turns a 300ms action into twenty seconds.
  eq('close spotify stays off the loop', await pb.isProcedural('close spotify'), false);
  eq('text mama … stays off the loop', await pb.isProcedural('text mama that I am running late'), false);
  eq('but ordering food does not', await pb.isProcedural('order me a pizza'), true);

  console.log('\n— command SHAPES, read structurally rather than by verb —');
  for (const [goal, shape] of [
    ['jump to textedit and type all clear', 'apptype'],
    ['crank up spotify and search for ar rahman', 'appsearch'],
    ['knock up a note about food', 'note'],
    ['am i busy today', 'calendar'],
    ['whats my day look like', 'calendar'],
  ]) {
    eq('"' + goal.slice(0, 40) + '" → ' + shape, await agent.shapeOf(goal), shape);
  }

  console.log('\n— and the pieces come out of the STRUCTURE, not a verb list —');
  const typed = agent.deterministicPlan('jump to textedit and type all clear', 'apptype');
  eq('app found mid-sentence', typed && typed.steps[0].args.name, 'TextEdit');
  eq('text is what follows the verb', typed && typed.steps[1].args.text, 'all clear');

  const searched = agent.deterministicPlan('get spotify going and look for ar rahman', 'appsearch');
  eq('app need not be at the end', searched && searched.steps[0].args.app, 'Spotify');
  eq('query drops the verb', searched && searched.steps[0].args.query, 'ar rahman');

  // "hunt DOWN rust in brave" — the particle belongs to the verb, not to the query.
  const oneClause = agent.deterministicPlan('hunt down rust in brave', 'appsearch');
  eq('single-clause "<verb> <thing> in <app>"', oneClause && oneClause.steps[0].args.app, 'Brave Browser');
  eq('and the particle goes with the verb', oneClause && oneClause.steps[0].args.query, 'rust');

  console.log('\n— the classifier outranks the regex table —');
  // Both from his terminal. The shape was right in the first and the table answered anyway.
  //   ◆ find me the next holiday in my calendar
  //     Searched Calendar for "me the next holiday", Sir.     (APP_SEARCH_IN_RE won)
  //   ◆ install among us from the app store
  //     Not sure which app — did you mean App Store, sir?     ("from" was not a seam)
  const cal = agent.deterministicPlan('find me the next holiday in my calendar', 'calendar');
  eq('a calendar request is a calendar request', cal && cal.kind, 'calendar');
  const store = agent.deterministicPlan('install among us from the app store', 'appsearch');
  eq('"from" names the app to search', store && store.steps[0].args.app, 'App Store');
  eq('…and the query is what he asked for', store && store.steps[0].args.query, 'among us');

  console.log('\n— a shape whose pieces are missing is not that shape —');
  // The registry is the authority on what an app is, so a sentence that merely looks like an
  // app-search but names no app does not become one.
  eq('no app named ⇒ no plan', agent.deterministicPlan('look up flights on kayak', 'appsearch'), null);
  eq('no shape ⇒ old behaviour', agent.deterministicPlan('jump to textedit and type all clear'), null);

  console.log('\n— a person is found by asking the address book, not by listing verbs —');
  // These four phrasings all missed before, and each puts the name somewhere different:
  //   "ring mama on whatsapp"  "give mama a call on whatsapp"  "whatsapp call mama"
  // No structural rule separates "mama" from "a call"; the address book does it by knowing which
  // span is a person. The SHAPE is machine-independent and asserted here; whether a given name
  // resolves depends on his actual Contacts, so that is not asserted.
  for (const goal of ['ring mama on whatsapp', 'give mama a call on whatsapp',
                      'phone mama on whatsapp', 'whatsapp call mama', 'call parth']) {
    eq('"' + goal + '" is a call', await agent.shapeOf(goal), 'call');
  }
  // Cold cache: no address book means no guess, and the request falls through exactly as before.
  eq('no address book ⇒ no person, no plan', agent.personIn('ring mama on whatsapp'), null);
  eq('…and therefore no call plan', agent.deterministicPlan('ring mama on whatsapp', 'call'), null);

  console.log('\n— a reply that claims an action it did not take —');
  // Replaces three regexes that between them listed ~90 phrasings. The 91st walked through:
  //   ◆ look for the next holiday
  //     Sure, let me look that up for you.        (nothing ran, nothing was blocked)
  // The real thing, not a copy of it — requiring server.js would boot a second server.
  const { replyClaimOf: claimOf } = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/replyclaim.js');
  for (const [reply, want] of [
    ['Sure, let me look that up for you.', 'promised'],
    ['Done, Sir.', 'done'],
    ['I have added it to your reminders.', 'done'],
    ['Opening Zomato now, Sir.', 'acting'],
  ]) {
    eq(JSON.stringify(reply.slice(0, 38)) + ' is a claim', await claimOf(reply), want);
  }
  // The fabricated order confirmation from his terminal. Scored as one string the courtesy half
  // dilutes the claim and it slips through — which is why each sentence is scored on its own.
  ok('"Sure thing, Sir. Ordering a non-veg meal…" is caught',
     !!(await claimOf('Sure thing, Sir. Ordering a non-veg meal with oranges for you now.')));

  console.log('\n— …and a reply that is simply an answer is left alone —');
  // A false positive here replaces a CORRECT answer with a refusal, which is its own kind of lying.
  for (const reply of [
    'The CEO of Google is Sundar Pichai.',
    'Your name is Atharv, Sir.',
    'Your battery is at 14 percent, Sir.',
    'I can help with that. What would you like it to say?',
    'Let me explain how that works.',
    'Badminton is a good shout. It is indoors and quick to arrange.',
    'You could open it in Brave if Safari is being slow.',
    'Which restaurant did you mean, Sir?',
    // The guards' own refusals — reading one back as a claim is the guard firing on itself.
    'I have not actually done that, Sir.',
    'I cannot actually fetch that here, Sir.',
  ]) {
    eq(JSON.stringify(reply.slice(0, 40)) + ' is not a claim', await claimOf(reply), null);
  }

  console.log('\n— the classifier abstains rather than guessing —');
  const tiny = intent.makeClassifier({
    exemplars: { a: ['open the door', 'unlock the door'], b: ['close the door', 'shut the door'], none: ['what is the weather'] },
    minMargin: 0.9,            // absurdly high on purpose: nothing can clear it
    jlog: () => {},
  });
  eq('an unreachable margin means no answer', await tiny('open the door'), null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
