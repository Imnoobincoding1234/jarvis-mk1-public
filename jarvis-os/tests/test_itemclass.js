// Item classifier tests. UNLIKE test_parse.js these need ollama and all-minilm — the whole point of
// the module is what the embedder says, and a test double would just be me asserting my own
// expectations back at myself. Runs in a temp state dir so it never touches the real cache.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ic = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/itemclass.js');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-itemclass-'));
  ic.init({ jlog: () => {}, stateDir: tmp });

  console.log('\n— refuses before it reaches the network —');
  eq('empty', await ic.classify(''), null);
  eq('null', await ic.classify(null), null);
  eq('a sentence, not an item', await ic.classify('x'.repeat(80)), null);

  console.log('\n— the words the three regex lists got wrong —');
  const kind = async t => { const r = await ic.classify(t); return r ? r.kind : null; };
  // Every one of these was a measured failure of the old lists: samosa missing from the list that
  // decides, gulab jamun routed to Amazon, produce in no list at all.
  eq('samosa', await kind('samosa'), 'grocery');
  eq('gulab jamun', await kind('gulab jamun'), 'grocery');
  eq('rasmalai — in no list anywhere', await kind('rasmalai'), 'grocery');
  eq('apples', await kind('apples'), 'grocery');
  eq('anjeer — in no list anywhere', await kind('anjeer'), 'grocery');
  eq('keyboard', await kind('keyboard'), 'marketplace');
  eq('phone charger', await kind('phone charger'), 'marketplace');
  // Soap is not edible and belongs on the grocery errand anyway — the question is which shop,
  // not what it is made of.
  eq('soap goes with the grocery run', await kind('soap'), 'grocery');

  console.log('\n— it is allowed to say it cannot tell —');
  // The measured errors sat at the two smallest margins in the whole set. Abstaining on them is the
  // property that makes this safe to put in front of an order: a null becomes a question, and a
  // question cannot spend his money on the wrong thing.
  const bedsheet = await ic.classify('bedsheet');
  eq('a low-margin item abstains rather than guessing', bedsheet, null);

  console.log('\n— his answer outranks the model, permanently —');
  eq('teach records it', ic.teach('bedsheet', 'marketplace'), true);
  const taught = await ic.classify('bedsheet');
  eq('and the next call uses it', taught && taught.kind, 'marketplace');
  eq('a nonsense class is refused', ic.teach('bedsheet', 'furniture'), false);

  console.log('\n— the cache survives a restart, and dies when the prototypes change —');
  const file = path.join(tmp, 'itemclass.json');
  eq('written to state', fs.existsSync(file), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq('keyed by the prototype fingerprint', saved.hash, ic.PROTO_HASH);
  eq('and holds what it was taught', saved.items.bedsheet.k, 'marketplace');
  // A changed prototype set changes every centroid, so yesterday's verdicts are not comparable.
  // Rewriting the hash is how a stale cache is discarded without anyone having to remember to.
  fs.writeFileSync(file, JSON.stringify({ hash: 'stale-hash', items: { samosa: { k: 'marketplace', m: 1 } } }));
  delete require.cache[require.resolve(process.env.HOME + '/JARVIS MK-1/jarvis-os/itemclass.js')];
  const ic2 = require(process.env.HOME + '/JARVIS MK-1/jarvis-os/itemclass.js');
  ic2.init({ jlog: () => {}, stateDir: tmp });
  const afterStale = await ic2.classify('samosa');
  eq('a stale cache is discarded, not trusted', afterStale && afterStale.kind, 'grocery');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
