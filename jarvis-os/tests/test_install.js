// INSTALLING SOMETHING — the capability that did not exist, and then existed and did not run.
//
// Two live failures, one after the other:
//
//   ◆ open the app store and install among us      (before install_app existed)
//     UI › searched "among us" in App Store · Agent › done — ✓ search in app
//     Half the request, reported as success.
//
//   ◆ Open app store and install among us          (after it existed, and still wrong)
//     Chat › clause routing, partial: [Open app store] then asking about "install among us"
//     "Booting App Store, sir. I confirmed it is running. Alright, installing Among Us."
//     The sentence was cut in half before the shape was consulted, the tail went to the 3B as a
//     QUESTION, and the 3B announced an installation that never happened.
//
// Needs ollama for the shapes, and the network for the two registries. Skips rather than failing.
const a = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/agent.js');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + g + '\n         want ' + w); }
}

(async () => {
  a.init({ jlog: () => {}, stopped: () => false });
  if (await a.shapeOf('install among us') === null) {
    console.log('\nSkipping — the embedder is not answering (is ollama running?)');
    process.exit(0);
  }

  console.log('\n— installing is its own shape, not a search —');
  for (const t of ['install among us', 'download telegram', 'install the notion app',
                   'open the app store and install among us']) {
    eq('"' + t + '"', await a.shapeOf(t), 'appinstall');
  }
  // The boundary that matters: same place, different errand.
  eq('a store SEARCH is still a search', await a.shapeOf('search action games in the app store'), 'appsearch');

  console.log('\n— "open X and install Y" is ONE errand and must not be split —');
  // This is the exact regression from his screenshot: compoundAppIntent only accepted `appsearch`,
  // so the install compound was cut in half and the tail was answered by the model.
  for (const t of ['Open app store and install among us', 'open the app store and install among us']) {
    ok('"' + t + '" stays whole', await a.compoundAppIntent(t) === true);
  }

  console.log('\n— file work is not agent work (it has a region now) —');
  // Adding the install region stole these, because they had no home of their own: "delete my
  // downloads folder" landed on appinstall at margin 0.106 while every individual install exemplar
  // scored 0.34-0.49 against it. The average, not any example, was the problem.
  for (const t of ['delete my downloads folder', 'tidy up my downloads folder']) {
    eq('"' + t + '" is file work', await a.shapeOf(t), 'files');
    ok('…and is not handed to the agent', await a.agentIntent(t) === false);
  }

  console.log('\n— the source is resolved from the registries, not assumed —');
  const src = await a.resolveInstallSource('among us');
  if (src === null) {
    console.log('  (skipping registry assertions — no network)');
  } else {
    // THE ANSWER THE HARDCODED VERSION COULD NOT GIVE. Among Us is not on the Mac App Store (its
    // iTunes search returns MultiCraft and WhatsApp) and not in Homebrew, so the request he actually
    // made was never going to succeed inside the App Store however well the buttons were pressed.
    ok('"among us" is in neither registry', !src.store && !src.token);
    const t2 = await a.resolveInstallSource('telegram');
    ok('"telegram" is found', !!(t2.store || t2.token));

    console.log('\n— and nothing is installed, claimed, or pressed when it cannot be —');
    const r = await a.TOOLS.install_app({ query: 'among us' });
    ok('it refuses rather than reporting success', r.ok === false);
    ok('…and says where it looked', /App Store/i.test(r.say) && /Homebrew/i.test(r.say));
    ok('…and does not offer to run a command off a web page', /without showing it to you/i.test(r.say));

    // Already-installed is a real answer, and it does not shell out to install anything.
    const already = await a.TOOLS.install_app({ query: 'brotli' });
    ok('an installed package is reported as already there',
       already.ok === true && /already installed/i.test(already.say));

    console.log('\n— "install istapaper" installed TASKPAPER, and must never again —');
    // The worst failure of this feature, live: brew search istapaper returns taskpaper (brew matches
    // fuzzily), the iTunes search returned the correct Instapaper and a startsWith test discarded
    // it, and then a model was handed a one-item list with no right answer in it and picked the
    // item. Identity is scored now: taskpaper 0.556, instaloader 0.727, Instapaper 0.900, floor 0.80.
    const ista = await a.resolveInstallSource('istapaper');
    ok('the wrong-but-similar brew package is rejected outright', !ista.token);
    ok('…and the App Store match survives the typo',
       !!ista.store && /instapaper/i.test(ista.store.name));
    ok('…scored below 1, because it is not what he typed', ista.storeScore > 0.8 && ista.storeScore < 1);

    const r2 = await a.TOOLS.install_app({ query: 'istapaper' });
    ok('an inexact match ASKS rather than installing', r2.needsConfirm === true && r2.ok === false);
    ok('…and names what it would install', /Instapaper/i.test(r2.say));
    ok('…and quotes back what he actually said', /istapaper/i.test(r2.say));
    ok('…and nothing was installed', !/Installed/i.test(r2.say));

    // An exact match needs no question.
    const tg = await a.resolveInstallSource('telegram');
    ok('an exact name scores 1 and will not ask', tg.brewScore === 1 || tg.storeScore === 1);
  }

  console.log('\n— every result row has its own "Get", and only one of them is his —');
  // Copied from the real App Store accessibility tree after searching "Instapaper": four apps, four
  // byte-identical buttons, each preceded by the Group naming its own row. Ranking by label picks
  // one of four indistinguishable strings — a one-in-four chance of installing a competitor's app.
  const SCREEN = [
    { i: 17, role: 'AXButton', label: 'Field' },
    { i: 18, role: 'AXButton', label: 'Atharv Mahendru' },
    { i: 19, role: 'AXRadioButton', label: 'Mac Apps' },
    { i: 22, role: 'AXGroup', label: 'Instapaper, News, four and three quarters stars' },
    { i: 23, role: 'AXButton', label: 'Get, In-App Purchases' },
    { i: 24, role: 'AXGroup', label: 'Cubox: AI Read-It-Later App, Save Once. Know Forever., five stars' },
    { i: 25, role: 'AXButton', label: 'Get, In-App Purchases' },
    { i: 26, role: 'AXGroup', label: 'Anybox - Bookmark & Read Later, Save and Organize Links, five stars' },
    { i: 27, role: 'AXButton', label: 'Get, In-App Purchases' },
    { i: 28, role: 'AXGroup', label: 'ReadKit - Reading Hub, RSS news and read later, four stars' },
    { i: 29, role: 'AXButton', label: 'Get, In-App Purchases' },
    { i: 30, role: 'AXButton', label: 'Cancel' },
  ];
  const p1 = await a.pickInstallControl('Instapaper', SCREEN);
  eq('it presses the Get on Instapaper\'s own row', p1 && p1.i, 23);
  const p2 = await a.pickInstallControl('ReadKit - Reading Hub', SCREEN);
  eq('…and a different app gets a different button', p2 && p2.i, 29);
  const p3 = await a.pickInstallControl('Telegram', SCREEN);
  eq('an app that is not on screen is REFUSED, not guessed at', p3, null);

  // Store furniture is never an install control. This is what it pressed before role and meaning
  // were required: "Categories", out of a 37-item list, followed by "Installing now".
  const FURNITURE = [
    { i: 1, role: 'AXCell', label: 'Categories' },
    { i: 2, role: 'AXButton', label: 'Categories' },
    { i: 3, role: 'AXButton', label: 'Games' },
    { i: 4, role: 'AXButton', label: 'Atharv Mahendru' },
    { i: 5, role: 'AXButton', label: 'Open' },
  ];
  eq('no acquire button means no press', await a.pickInstallControl('Instapaper', FURNITURE), null);

  console.log('\n— and the mirror: removing something —');
  eq('"uninstall telegram" is its own shape', await a.shapeOf('uninstall telegram'), 'appuninstall');
  eq('…as is "get rid of discord"', await a.shapeOf('get rid of discord'), 'appuninstall');
  // The edge that matters: removing an APP and removing a FOLDER must never swap.
  eq('deleting a folder is still file work', await a.shapeOf('delete my downloads folder'), 'files');
  eq('…and so is deleting a file', await a.shapeOf('delete the file notes.txt'), 'files');

  // THE NAME IS EXTRACTED, NOT CARVED OUT BY DELETION.
  //
  // The first version stripped a leading verb phrase, then a trailing "from my mac", then an
  // article, and shipped the remainder — subtractive, which is the same shape as the search-query
  // bug fixed earlier the same day. The whole clause is passed through now and the INSTALLED
  // REGISTRIES are asked which of their entries the sentence names, every contiguous span offered
  // longest-first. So these all resolve without anything being stripped, and a phrasing nobody
  // anticipated resolves for the same reason rather than by luck.
  eq('the plan hands over the whole clause', a.structuralPlan('get rid of brotli', 'appuninstall').steps[0].args.query,
     'get rid of brotli');
  for (const said of ['uninstall brotli', 'get rid of brotli', 'remove brotli from my mac',
                      'take brotli off my mac', 'please uninstall brotli for me']) {
    const r = await a.TOOLS.uninstall_app({ query: said });
    ok('"' + said + '" resolves to brotli', r.needsConfirm === true && /“brotli”/.test(r.say));
  }
  // An app bundle rather than a package, named mid-sentence with scaffolding either side.
  const cl = await a.TOOLS.uninstall_app({ query: 'uninstall the claude app' });
  ok('"uninstall the claude app" resolves to Claude', cl.needsConfirm === true && /“Claude”/.test(cl.say));

  console.log('\n— nothing is removed without asking, and nothing unknown is removed at all —');
  const u1 = await a.TOOLS.uninstall_app({ query: 'zzznotinstalledxyz' });
  ok('an app that is not installed is refused', u1.ok === false && /matches anything installed/i.test(u1.say));
  // A sentence that names nothing installed is refused too — no partial-credit removal.
  const u1b = await a.TOOLS.uninstall_app({ query: 'uninstall telegram' });
  ok('…and so is a name that is simply not here', u1b.ok === false);
  const u2 = await a.TOOLS.uninstall_app({ query: 'uninstall brotli' });
  ok('an installed package ASKS first, even on an exact match', u2.needsConfirm === true);
  ok('…and names Homebrew as the route', /Homebrew/i.test(u2.say));
  const u3 = await a.TOOLS.uninstall_app({ query: 'uninstall Claude' });
  ok('a hand-installed app goes to the Trash, and says so', u3.needsConfirm === true && /Trash/i.test(u3.say));
  ok('…and is described as recoverable', /recoverable/i.test(u3.say));
  const u4 = await a.TOOLS.uninstall_app({});
  ok('no target means no removal', u4.ok === false && /uninstall what/i.test(u4.say));

  console.log('\n— an install with no target does nothing —');
  const none = await a.TOOLS.install_app({});
  ok('it asks instead of guessing', none.ok === false && /install what/i.test(none.say));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
