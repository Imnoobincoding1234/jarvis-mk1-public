'use strict';
// readmodel.js's checker — what a reading must survive before it becomes an action. No model is run:
// each case hands the checker a reading, the way the reader model would, and asserts what comes out.
// The properties: a value that is not in his sentence is refused; a name no registry knows is refused
// unless he said it was an app; a half of open/close or create/delete the model was not sure of is
// ASKED about, and his answer is kept for his words; a delete of something that is not there asks
// which; paths are his words placed in folders that exist.
// ITS OWN CACHE FILE. This suite plants hand-written readings (RM._remember), and a model read that
// happens in the same run saves the whole cache — so a shared file would hand those plants to every
// other suite as if the model had written them.
process.env.JARVIS_READER_CACHE = 'readmodel.test_readmodel.json';
// Where new things go is HIS setting; the suite keeps its own and starts it empty every run.
process.env.JARVIS_PLACES_FILE = 'places.test.json';
// His confirmed readings, likewise: the suite's own file, emptied every run.
process.env.JARVIS_READER_CONFIRMED_FILE = 'readmodel.confirmed.test.json';
const path = require('path');
const os = require('os');
const fs = require('fs');
const J = require('../server.js');
const RM = J.readmodel;
const H = os.homedir();
const store = require('../store');
store.write(RM._placesFile, {});
store.write(RM._confirmedFile, {});
// His answers about his words live in his real verblex.json; this suite teaches into memory only.
const lex = require('../verblex.js');
const memo = {};
lex.init({ store: { read: n => memo[n] || null, write: (n, d) => { memo[n] = JSON.parse(JSON.stringify(d)); } } });
// A reading shaped exactly as parseReading makes one from Ollama: the act token's probability, and
// the alternatives listed at that token.
// pRest is the probability of the rest of the reading (the copied values), so a reading can be sure of
// its act and unsure of what it copied — as real ones are.
const modelReading = (json, pAct, alts, pRest) => {
  const act = JSON.parse(json).act;
  const at = json.indexOf('"act":"') + 7;
  return RM._parse({ response: json, logprobs: [
    { token: json.slice(0, at), logprob: -0.001 },
    { token: act, logprob: Math.log(pAct), top_logprobs: (alts || [[act, pAct]]).map(([t, p]) => ({ token: t, logprob: Math.log(p) })) },
    { token: json.slice(at + act.length), logprob: Math.log(pRest || 0.999) },
  ] });
};

let pass = 0, fail = 0;
const pending = [];
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + g + '\n         want ' + w); }
}

console.log('\n— the checker —');
const cases = [
  ['open youtube', { act: 'open', thing: 'youtube' }, { action: { type: 'open_site', target: 'youtube', preferSite: false } }],
  ['open the youtube website', { act: 'open', thing: 'youtube', as: 'site' }, { action: { type: 'open_site', target: 'youtube', preferSite: true } }],
  ['open safari', { act: 'open', thing: 'safari' }, { action: { type: 'open_app', name: 'safari', target: 'safari' } }],
  ['close safari', { act: 'close', thing: 'safari' }, { action: { type: 'close_app', name: 'safari', target: 'safari', force: false, known: true } }],   // known: the registry's app (2026-10-17)
  ['close youtube', { act: 'close', thing: 'youtube' }, null],
  ['open youtube', { act: 'open', thing: 'netflix' }, null],                       // invented target
  ['open youtube', { act: 'close', thing: 'youtube' }, null],                      // website: no process
  // A hand-written reading is a label: its half is taken as written (the model's own readings are
  // gated on the model's certainty — see "which way round" below).
  ['chuck on netflix', { act: 'open', thing: 'netflix' }, { action: { type: 'open_site', target: 'netflix', preferSite: false } }],
  ['open a nonexistent app called zzqqxx', { act: 'open', thing: 'zzqqxx', as: 'app' }, { action: { type: 'open_app', name: 'zzqqxx', target: 'zzqqxx' } }],
  ['open zzqqxx', { act: 'open', thing: 'zzqqxx' }, null],
  ['open the business’s instagram account', { act: 'open', thing: 'instagram', business: true }, { action: { type: 'open_social', target: 'instagram' } }],
  ['open my business’s website', { act: 'open', thing: 'website', business: true }, { action: { type: 'open_url', target: 'https://ad-max.vercel.app' } }],
  ['open ad-max.vercel.app', { act: 'open', thing: 'ad-max.vercel.app' }, { action: { type: 'open_url', target: 'https://ad-max.vercel.app' } }],
  ['search lofi beats on youtube', { act: 'search_web', query: 'lofi beats', where: 'youtube' }, { action: { type: 'search_web', target: 'lofi beats', site: 'youtube' } }],
  ['open safari and search lofi on youtube', { act: 'search_web', query: 'lofi', where: 'youtube', browser: 'safari' }, { action: { type: 'search_web', target: 'lofi', site: 'youtube', browser: 'Safari' } }],
  ['search node streams in chrome', { act: 'search_web', query: 'node streams', where: 'chrome' }, { action: { type: 'search_web', target: 'node streams', browser: 'Google Chrome' } }],
  ['google weather in mumbai', { act: 'search_web', query: 'weather in mumbai' }, { action: { type: 'search_web', target: 'weather in mumbai' } }],
  ['open the app store and search for chess', { act: 'search_web', query: 'chess', where: 'app store' }, null],
  ['search for pizza', { act: 'search_web', query: 'burgers' }, null],             // invented query
  // Round 3 (2026-09-27): a play is the reader's own job, with the reader's query — the door runs it (runReaderJob).
  ['play lofi on youtube', { act: 'play', query: 'lofi', where: 'youtube' }, { action: { type: 'reader_play', query: 'lofi', where: 'youtube', video: true } }],
  ['play judas', { act: 'play', query: 'judas' }, { action: { type: 'reader_play', query: 'judas' } }],
  ['find my resume', { act: 'search_files', query: 'resume' }, { action: { type: 'search', name: 'resume' } }],
  ['create a file called eval_one.txt on my desktop saying hello jarvis', { act: 'create_file', name: 'eval_one.txt', where: 'my desktop', content: 'hello jarvis' },
    { action: { type: 'create_file', path: path.join(H, 'Desktop', 'eval_one.txt'), content: 'hello jarvis' } }],
  ['make a folder called notes in progress on my desktop', { act: 'create_folder', name: 'notes in progress', where: 'my desktop' },
    { action: { type: 'create_folder', path: path.join(H, 'Desktop', 'notes in progress') } }],
  ['make a folder called x on the moon', { act: 'create_folder', name: 'x', where: 'the moon' }, null],
  ['list my desktop', { act: 'list', thing: 'my desktop' }, { action: { type: 'list', path: path.join(H, 'Desktop') } }],
  ['get rid of the folder', { act: 'delete', thing: 'the folder' }, 'ask'],
  ['delete ~/Desktop', { act: 'delete', thing: '~/Desktop' }, { action: { type: 'delete', path: path.join(H, 'Desktop') } }],
  ['take a screenshot', { act: 'screenshot' }, { action: { type: 'screenshot' } }],
  ['what is the weather', { act: 'none' }, null],
  ['open youtube', { act: 'open', thing: 'youtube', extra: 'x' }, null],           // not shaped like a label
  ['open youtube', { act: 'launch', thing: 'youtube' }, null],
  // A file or address he typed that the reading leaves out: the reading is of something else.
  ['toss invoice_copy.png in the trash', { act: 'empty_trash' }, null],
  ['make d.txt with delta and e.txt with epsilon', { act: 'create_file', name: 'd.txt', content: 'delta' }, null],
  ['open safari and go to example.com', { act: 'open', thing: 'safari' }, null],
  ['move mark 2 to the bin', { act: 'empty_trash' }, null],
  ['empty the trash', { act: 'empty_trash' }, { action: { type: 'empty_trash' } }],
  ['search iphone 15 on amazon', { act: 'search_web', query: 'iphone 15', where: 'amazon' }, { action: { type: 'search_web', target: 'iphone 15', site: 'amazon' } }],
  ['search for my taxes.pdf', { act: 'search_files', query: 'taxes.pdf' }, { action: { type: 'search', name: 'taxes.pdf' } }],
];
for (const [text, reading, want] of cases) {
  const got = RM.build(text, reading);
  const shape = want === 'ask' ? (got && got.ask ? 'ask' : got) : got;
  eq(JSON.stringify(text).slice(0, 50) + ' ' + JSON.stringify(reading).slice(0, 60), shape, want);
}

console.log('\n— what the old parser guarded, as properties of the checker —');
{
  // test_stress used to assert these on the regex parser's source; the parser is gone.
  const built = RM.build('create a file called notes.txt on my desktop saying hello',
    { act: 'create_file', name: 'notes.txt', where: 'my desktop', content: 'hello' });
  const a = built && built.action;
  eq('the content he said reaches the file, not a 0-byte file', !!a && a.type === 'create_file' && a.content === 'hello', true);
  eq('…and the filename carries none of it', a && path.basename(a.path), 'notes.txt');
  eq('a place he did not say is refused', RM.build('read notes.txt on my desktop', { act: 'read', thing: 'notes.txt', where: '/Users/someone/Desktop' }), null);
  const mine = RM.build('read notes.txt on my desktop', { act: 'read', thing: 'notes.txt', where: 'my desktop' });
  eq('…and "my desktop" is under his own home', !!(mine && mine.action) && mine.action.path.startsWith(H + path.sep), true);
}

console.log('\n— a reading as the model actually returns it —');
{
  // parseReading() turns an Ollama answer into a reading carrying `__conf` (the least likely token) and
  // `__pol` / `__anti` (the act token, and the best listed alternative that starts the other half).
  // Every reading the live server sees has them; hand-written cases do not, which is how a checker
  // that refused ALL real readings once passed this suite.
  const sure = modelReading('{"act":"open","thing":"youtube"}', 0.97, [['open', 0.97], ['close', 0.02]]);
  eq('a real reading carries its confidence', typeof sure.__conf, 'number');
  eq('…and where the halves part', [sure.__pol, sure.__anti], [0.97, 0.02]);
  eq('…and passes the shape check', RM.shapeError('open youtube', sure), null);
  eq('…and builds its action', RM.build('open youtube', sure), { action: { type: 'open_site', target: 'youtube', preferSite: false } });
  const unread = modelReading('{"act":"open","thing":"youtube"}', RM.ASK_FLOOR / 2);
  eq('a reading under the floor builds nothing', RM.build('open youtube', unread), null);
  eq('the floor survives the cache file', RM.build('open youtube', JSON.parse(JSON.stringify(unread))), null);
  eq('an unreadable answer is not a reading', RM.build('open youtube', RM._parse({ response: 'not json', logprobs: [{ token: 'x', logprob: -0.01 }] })), null);
}

console.log('\n— which way round: the model\'s certainty, then his answer —');
{
  const kind = b => (b && b.ask ? 'ask:' + b.ask.kind : b && b.action ? b.action.type : null);
  const P = RM.POLARITY_MIN;
  // Sure of its half: acts.
  eq('sure of "open": opens', kind(RM.build('fire up spotify', modelReading('{"act":"open","thing":"spotify"}', 0.99, [['open', 0.99], ['close', 0.001]]))), 'open_site');
  // Less sure of "open", but the rest went to other acts, not to "close": that is not polarity doubt.
  eq('unsure overall, the other half far behind: no polarity question', kind(RM.build('open find my', modelReading('{"act":"open","thing":"find my"}', 0.8, [['open', 0.8], ['search', 0.15], ['close', 0.002]]))), 'open_app');
  // Unsure of its half: asks — whatever the verb, because there is no verb table to consult.
  const shaky = modelReading('{"act":"open","thing":"netflix"}', Math.max(RM.MIN_CONFIDENCE, P - 0.2));
  eq('unsure of "open": asks which', kind(RM.build('chuck on netflix', shaky)), 'ask:direction');
  eq('…and the question carries his words for the request', (RM.build('chuck on netflix', shaky).ask || {}).verb.includes('chuck'), true);
  eq('…never the thing itself', (RM.build('chuck on netflix', shaky).ask || {}).verb.includes('netflix'), false);
  // The other half listed close behind: asks, even when the chosen half looks likely on its own.
  const close2 = modelReading('{"act":"open","thing":"spotify"}', 0.95, [['open', 0.95], ['close', 0.95 - RM.POLARITY_MARGIN / 2]]);
  eq('the other half close behind: asks', kind(RM.build('crank up spotify', close2)), 'ask:direction');
  // The other half not listed: the least likely listed alternative bounds it.
  const unlisted = modelReading('{"act":"open","thing":"spotify"}', 0.95, [['open', 0.95], ['play', 0.03]]);
  eq('the other half unlisted: bounded by what was listed', unlisted.__anti, 0.03);
  // Quitting asks him to confirm anyway, naming the app: an unsure quit goes to that confirmation.
  eq('unsure of "close": goes to the confirmation', kind(RM.build('kill spotify', modelReading('{"act":"close","thing":"spotify"}', Math.max(RM.MIN_CONFIDENCE, P - 0.2)))), 'close_app');
  // A create he may not have meant is settled before where it goes.
  store.write(RM._placesFile, {});
  eq('an unsure create asks which, before where', kind(RM.build('knock up a folder called todo', modelReading('{"act":"create_folder","name":"todo"}', Math.max(RM.MIN_CONFIDENCE, P - 0.2)))), 'ask:direction');
  // His words for the request: what is left once the reading's values are out.
  eq('his words for "bin notes_backup.txt"', RM.requestWords('bin notes_backup.txt', { act: 'delete', thing: 'notes_backup.txt' }), 'bin');
  eq('his words never include the name', RM.requestWords('spin up a folder called experiments', { act: 'create_folder', name: 'experiments' }).includes('experiments'), false);
}

console.log('\n— his answer: kept for his words, or for this one request —');
{
  const kind = b => (b && b.ask ? 'ask:' + b.ask.kind : b && b.action ? b.action.type : null);
  const shaky = (json) => modelReading(json, Math.max(RM.MIN_CONFIDENCE, RM.POLARITY_MIN - 0.2));
  // Nothing is known before he says it: there is no seed.
  eq('no verb is known before he answers', lex.kindOfSync('open', 'app'), null);
  // Taught for his words, in one pair only.
  const words = RM.build('chuck on netflix', shaky('{"act":"open","thing":"netflix"}')).ask.verb;
  eq('his answer is kept', lex.teach(words, 'open_app'), true);
  eq('…and the same request now acts', kind(RM.build('chuck on netflix', shaky('{"act":"open","thing":"netflix"}'))), 'open_site');
  eq('…and the same words about another thing', kind(RM.build('chuck on spotify', shaky('{"act":"open","thing":"spotify"}'))), 'open_site');
  eq('…only in that pair', lex.kindOfSync(words, 'file'), null);
  // His answer points the other way: the reading is turned round and checked again.
  eq('he said these words mean close', lex.teach(words, 'close_app'), true);
  eq('…so an open read from them quits instead', kind(RM.build('chuck on spotify', shaky('{"act":"open","thing":"spotify"}'))), 'close_app');
  eq('…and a website, which has nothing to quit, is said so', kind(RM.build('chuck on netflix', shaky('{"act":"open","thing":"netflix"}'))), 'ask:no-turn');
  // No words to keep it under: it settles this one request.
  RM.allowOnce('spotify', 'open_app');
  eq('an answer for one sentence settles it', kind(RM.build('spotify', shaky('{"act":"open","thing":"spotify"}'))), 'open_site');
  eq('…every time it is read while being routed', kind(RM.build('spotify', shaky('{"act":"open","thing":"spotify"}'))), 'open_site');
  eq('…and no other sentence', kind(RM.build('safari', shaky('{"act":"open","thing":"safari"}'))), 'ask:direction');
  RM.allowOnce('zoom', 'close_app');
  eq('an answer for the other half turns it round', kind(RM.build('zoom', shaky('{"act":"open","thing":"zoom"}'))), 'close_app');
  // Reading his reply: the word the question offered and nothing else, or what the reader reads in it
  // when every value it copies came from the sentence being asked about.
  const q = { verbKind: 'open_app', opposite: 'close_app' };
  pending.push(J.directionIn('open', q, 'chuck on netflix').then(k => eq('"open" answers open', k, 'open_app')));
  pending.push(J.directionIn('not open', q, 'chuck on netflix').then(k => eq('"not open" is not an answer', k, null)));
  pending.push(J.directionIn('open or close, whatever', q, 'chuck on netflix').then(k => eq('a reply naming both is not an answer', k, null)));
  pending.push(J.directionIn('what is the weather', q, 'chuck on netflix').then(k => eq('an unrelated reply is not an answer', k, null)));
  if (RM.ready() || true) {
    pending.push(J.directionIn('close netflix', q, 'chuck on netflix').then(k => eq('"close netflix" answers close (the reader)', k, 'close_app')));
    pending.push(J.directionIn('open safari', q, 'chuck on netflix').then(k => eq('"open safari" names its own thing: a new request', k, null)));
  }
}

console.log('\n— not sure enough to act, sure enough to ask —');
{
  const kind = b => (b && b.ask ? 'ask:' + b.ask.kind : b && b.action ? b.action.type : null);
  const band = RM.ASK_FLOOR + (RM.MIN_CONFIDENCE - RM.ASK_FLOOR) / 2;
  const mid = () => modelReading('{"act":"open","thing":"calculator"}', 0.99, [['open', 0.99], ['close', 0.001]], band);
  eq('between the floor and the gate: a question', kind(RM.build('open the calculator', mid())), 'ask:confirm');
  const q2 = RM.build('open the calculator', mid()).ask;
  eq('…naming the action it would take', q2.action.type, 'open_app');
  eq('…in words that say what it would do', J.describeAction(q2.action).what, 'open calculator');
  eq('…and the word that says go', J.describeAction(q2.action).word, 'open');
  eq('his yes is kept', RM.confirm('open the calculator', q2.action), true);
  eq('…so the same reading now acts', kind(RM.build('open the calculator', mid())), 'open_app');
  eq('…and only that sentence', kind(RM.build('open calculator now', mid())), 'ask:confirm');
  const other = modelReading('{"act":"close","thing":"calculator"}', 0.99, [['close', 0.99], ['open', 0.001]], band);
  eq('a different reading of the confirmed sentence asks again', kind(RM.build('open the calculator', other)), 'ask:confirm');
  eq('sure enough: acts without asking', kind(RM.build('open textedit', modelReading('{"act":"open","thing":"textedit"}', 0.99, [['open', 0.99], ['close', 0.001]], Math.min(0.99, RM.MIN_CONFIDENCE + 0.1)))), 'open_app');
  // The yes is the offered word and nothing more, less the words his messages say are scaffolding.
  eq('"open" is the yes', J.soleOffered('open', new Set(['open'])), 'open');
  eq('"don\'t quit" is not', J.soleOffered("don't quit", new Set(['quit'])), null);
  eq('"quit" is', J.soleOffered('quit', new Set(['quit'])), 'quit');
  store.write(RM._confirmedFile, {});
}

console.log('\n— where a new thing goes when he does not say —');
{
  const kindOf = b => (b && b.ask ? b.ask.kind : b && b.action ? b.action.type : null);
  const folder = (text, name) => RM.build(text, { act: 'create_folder', name });
  // Nothing kept yet: an unplaced create is a question, never a guess at a place.
  eq('unplaced create, nothing kept → asks where', kindOf(folder('create a new folder and label it as jarvis mk two', 'jarvis mk two')), 'which-place');
  eq('the question carries his name for it', (folder('create a new folder and label it as jarvis mk two', 'jarvis mk two').ask || {}).said, 'jarvis mk two');
  // A named place never asks, kept or not.
  eq('a named place does not ask', kindOf(RM.build('make a folder called q on my desktop', { act: 'create_folder', name: 'q', where: 'my desktop' })), 'create_folder');
  // An unknown verb is settled before the place: a create he may not have meant needs no place.
  // His answer must name a folder that exists; words around it are allowed, a made-up place is not.
  eq('"put it on the desktop please" names Desktop', RM.placeIn('put it on the desktop please'), path.join(H, 'Desktop'));
  eq('"on the moon" names nothing', RM.placeIn('on the moon'), null);
  eq('a typed folder path is taken as written', RM.placeIn('~/Documents'), path.join(H, 'Documents'));
  eq('a typed path that is not a folder is not a place', RM.placeIn('~/definitely_not_a_folder_zz9'), null);
  // Kept: used from then on, for folders and files alike.
  eq('the answer is kept', RM.setCreatePlace(path.join(H, 'Desktop'), 'desktop'), true);
  eq('kept place is used for a folder', RM.build('create a new folder and label it as jarvis mk two', { act: 'create_folder', name: 'jarvis mk two' }),
     { action: { type: 'create_folder', path: path.join(H, 'Desktop', 'jarvis mk two') } });
  eq('kept place is used for a file', RM.build('create a file called notes.txt', { act: 'create_file', name: 'notes.txt' }),
     { action: { type: 'create_file', path: path.join(H, 'Desktop', 'notes.txt') } });
  // His answer to "where?" places THAT request only — keeping it takes his own "always".
  store.write(RM._placesFile, {});
  RM.placeOnce('create a folder called once', path.join(H, 'Documents'));
  eq('his answer places that request', RM.build('create a folder called once', { act: 'create_folder', name: 'once' }),
     { action: { type: 'create_folder', path: path.join(H, 'Documents', 'once') } });
  eq('…and no other', kindOf(folder('create a folder called other', 'other')), 'which-place');
  eq('…and is offered to keep, not kept', RM.placeToOffer('create a folder called once', { type: 'create_folder', path: path.join(H, 'Documents', 'once') }), path.join(H, 'Documents'));
  eq('nothing was kept without his "always"', RM.createPlace(), null);
  // Kept (his "always"): a place he names still wins, and changing the kept one is offered, not done.
  RM.setCreatePlace(path.join(H, 'Desktop'), 'always');
  const named = RM.build('make a folder called q in documents', { act: 'create_folder', name: 'q', where: 'documents' });
  eq('a place he names wins over the kept one', named, { action: { type: 'create_folder', path: path.join(H, 'Documents', 'q') } });
  RM._remember('make a folder called q in documents', { act: 'create_folder', name: 'q', where: 'documents' });
  eq('…and switching the kept place is offered', RM.placeToOffer('make a folder called q in documents', named.action), path.join(H, 'Documents'));
  RM._remember('create a folder called r', { act: 'create_folder', name: 'r' });
  eq('the kept place used as kept offers nothing', RM.placeToOffer('create a folder called r', { type: 'create_folder', path: path.join(H, 'Desktop', 'r') }), null);
  store.write(RM._placesFile, {});
  // A kept place that has since disappeared is not used: it asks again.
  store.write(RM._placesFile, { create: path.join(H, 'definitely_not_a_folder_zz9') });
  eq('a kept place that no longer exists asks again', kindOf(folder('create a folder called x', 'x')), 'which-place');
  store.write(RM._placesFile, {});
  // Content is his words without the spacing the model sometimes puts around them.
  RM.setCreatePlace(path.join(H, 'Desktop'), 'desktop');
  eq('content is trimmed', (RM.build('create a file called a.txt saying hi there', { act: 'create_file', name: 'a.txt', content: ' hi there' }).action || {}).content, 'hi there');
  store.write(RM._placesFile, {});
}

console.log('\n— what the procedures may not take from the reader —');
{
  // readerHolds decides whether the playbook lane is consulted at all. Readings are handed to the cache
  // the way the model's would be, so this runs without the model.
  const holds = (text, reading) => { RM._remember(text, reading); const h = J.readerHolds(text); return h ? (h.ask ? 'ask:' + h.ask.kind : h.action.type) : null; };
  const mk2 = 'Create a new folder and label it as JARVIS MK two';
  store.write(RM._placesFile, {});
  eq('a one-folder create with no place kept is the reader\'s question', holds(mk2, { act: 'create_folder', name: 'JARVIS MK two' }), 'ask:which-place');
  RM.setCreatePlace(path.join(H, 'Desktop'), 'desktop');
  eq('…and with a place kept, the reader\'s action', holds(mk2, { act: 'create_folder', name: 'JARVIS MK two' }), 'create_folder');
  store.write(RM._placesFile, {});
  eq('a checked open is the reader\'s', holds('open youtube', { act: 'open', thing: 'youtube' }), 'open_site');
  eq('a play on a site is left to the procedures', holds("boot up youtube and play scary pumpkin's latest video",
     { act: 'play', query: "scary pumpkin's latest video", where: 'youtube' }), null);
  eq('a bare play is left to the procedures', holds('play judas', { act: 'play', query: 'judas' }), null);
  eq('a none is left to the lanes', holds('order me a pizza', { act: 'none' }), null);
  eq('a refused reading is left to the lanes', holds('open youtube please', { act: 'open', thing: 'netflix' }), null);
  eq('a sentence nobody read is left to the lanes', J.readerHolds('this sentence was never read by anything zq'), null);
}

console.log('\n— dream mode, and whether a message leans on the conversation (taught 2026-09-18) —');
{
  // `refers` rides on any act and is never a value: true or absent, nothing else.
  eq('refers:true is accepted on an action', RM.shapeError('search him up on brave', { act: 'search_web', query: 'him', where: 'brave', refers: true }), null);
  eq('…and on a none', RM.shapeError('what did you mean by that', { act: 'none', refers: true }), null);
  eq('refers must be true', RM.shapeError('close it', { act: 'close', thing: 'it', refers: 'yes' }), 'refers must be true');
  eq('a none that refers is still no action', RM.build('what did you mean by that', { act: 'none', refers: true }), null);
  eq('the dream log', RM.build('dream log', { act: 'dream_log' }), { action: { type: 'dream_log' } });
  eq('run dream mode now', RM.build('dream now', { act: 'dream_now' }), { action: { type: 'dream_now' } });
  eq('a written label is taken as written: on', RM.build('turn dream mode on', { act: 'dream_on' }), { action: { type: 'dream_set', enabled: true } });
  eq('a dream act takes no values', RM.build('dream log', { act: 'dream_log', thing: 'dream log' }), null);
  // The model's own readings: "dream_on" and "dream_off" part after "dream_o", so the token that decides
  // is the one after "dream" — not the first token of the act, where both halves agree.
  const dreamReading = (half, pHalf, pOther) => {
    const json = '{"act":"dream' + half + '"}';
    const other = half === '_on' ? '_off' : '_on';
    return RM._parse({ response: json, logprobs: [
      { token: '{"act":"', logprob: -0.001 },
      { token: 'dream', logprob: Math.log(0.99), top_logprobs: [{ token: 'dream', logprob: Math.log(0.99) }, { token: 'none', logprob: Math.log(0.005) }] },
      { token: half, logprob: Math.log(pHalf), top_logprobs: [{ token: half, logprob: Math.log(pHalf) }, { token: other, logprob: Math.log(pOther) }] },
      { token: '"}', logprob: -0.001 },
    ] });
  };
  const sure = dreamReading('_off', 0.97, 0.01);
  eq('the halves are weighed where they part', [sure.__pol, sure.__anti], [0.97, 0.01]);
  eq('sure of off: dream mode off', RM.build('switch dream mode off', sure), { action: { type: 'dream_set', enabled: false } });
  eq('not sure which way: told the state and offered the other, never guessed',
     RM.build('dream mode band kar do', dreamReading('_off', 0.6, 0.35)), { ask: { kind: 'dream-setting', text: 'dream mode band kar do' } });
  // P(refers): where the reading could end, what the model gave to going on.
  const noneReading = pGoOn => RM._parse({ response: '{"act":"none"}', logprobs: [
    { token: '{"act":"none', logprob: -0.001 },
    { token: '"}', logprob: Math.log(1 - pGoOn), top_logprobs: [{ token: '"}', logprob: Math.log(1 - pGoOn) }, { token: '",', logprob: Math.log(pGoOn) }] },
  ] });
  eq('P(refers) on a reading that does not say it: the alternative that goes on', noneReading(0.08).__ref, 0.08);
  const saidIt = RM._parse({ response: '{"act":"none","refers":true}', logprobs: [
    { token: '{"act":"none"', logprob: -0.001 },
    { token: ',"', logprob: Math.log(0.7) },
    { token: 'refers":true}', logprob: -0.001 },
  ] });
  eq('…and on one that says it: the comma it chose', saidIt.__ref, 0.7);
  eq('the note is the machine\'s, not a field the model wrote', RM.shapeError('what did you mean by that', saidIt), null);
}

console.log('\n— JARVIS\'s own panels: a registry, opened and closed like anything else (2026-09-19) —');
{
  const kindOf = t => { const a = J.actread.anchorsIn(J.actread.tokenize(t)); return a.length === 1 ? a[0].kind + ':' + a[0].value : null; };
  eq('"world monitor" is the World Monitor panel', kindOf('world monitor'), 'panel:world');
  eq('"neural net" is the neural network, shortened', kindOf('neural net'), 'panel:neural');
  eq('one word alone is not a panel', kindOf('world'), null);
  eq('open the World Monitor', RM.build('open the world monitor', { act: 'open', thing: 'world monitor' }), { action: { type: 'open_panel', target: 'world' } });
  eq('close the neural net', RM.build('close the neural net', { act: 'close', thing: 'neural net' }), { action: { type: 'close_panel', target: 'neural' } });
  const am = RM.build('open activity monitor', { act: 'open', thing: 'activity monitor' });
  eq('Activity Monitor is not the World Monitor', !!(am && am.action && am.action.type === 'open_panel'), false);
  eq('the question names the panel', J.describeAction({ type: 'open_panel', target: 'world' }).what, 'open the World Monitor');
}

console.log('\n— the tutor, read by the reader (taught 2026-09-19) —');
{
  eq('teach me about X: X on the study list', RM.build('teach me about entropy', { act: 'learn_topic', topic: 'entropy' }),
     { action: { type: 'learn_topic', topic: 'entropy' } });
  eq('a subject that is not in his words is refused', RM.build('teach me about entropy', { act: 'learn_topic', topic: 'thermodynamics' }), null);
  eq('a learn names its subject', RM.shapeError('teach me something', { act: 'learn_topic' }), 'missing topic');
  eq('stop studying X', RM.build('stop studying entropy', { act: 'stop_topic', topic: 'entropy' }), { action: { type: 'stop_topic', topic: 'entropy' } });
  eq('a quiz with no subject', RM.build('quiz me', { act: 'quiz_me' }), { action: { type: 'quiz_me' } });
  eq('a quiz on a subject he named', RM.build('quiz me on chemistry', { act: 'quiz_me', topic: 'chemistry' }), { action: { type: 'quiz_me', topic: 'chemistry' } });
  eq('the stats take nothing', RM.build('study stats', { act: 'study_stats', topic: 'stats' }), null);
  eq('a number in the subject is used, not refused', RM.build('teach me about world war 2', { act: 'learn_topic', topic: 'world war 2' }),
     { action: { type: 'learn_topic', topic: 'world war 2' } });
  eq('the question names what it would do', J.describeAction({ type: 'learn_topic', topic: 'entropy' }).word, 'add');
}

console.log('\n— round 6: the clock —');
{
  eq('the time, here', RM.build('whats the time rn', { act: 'time' }), { action: { type: 'reader_time' } });
  eq('the time in the place he named', RM.build('time in tokyo rn', { act: 'time', where: 'tokyo' }), { action: { type: 'reader_time', where: 'tokyo' } });
  eq('a place he did not say fails the shape check', RM.shapeError('whats the time', { act: 'time', where: 'tokyo' }) !== null, true);
  eq('time takes nothing but where', RM.shapeError('whats the time', { act: 'time', when: 'time' }) !== null, true);
  eq('the question names what it would do', J.describeAction({ type: 'reader_time', where: 'tokyo' }).word, 'time');
  eq('a time step in several requests is kept, not dropped', J.describeAction({ type: 'reader_multi', steps: [{ act: 'time', where: 'tokyo' }, { act: 'weather' }] }).what,
     'do these 2: whats the time in tokyo; weather');
}

console.log('\n— round 7: a time for later rides on the action —');
{
  // round 7's "do it later" is switched off until its reader + converter pass (JARVIS_READER_LATER); both states are checked here
  RM.init({ laterOn: () => true });
  eq('`when` is allowed on open (doing things later switched on)', RM.shapeError('open notes in 2 minutes', { act: 'open', thing: 'notes', when: 'in 2 minutes' }), null);
  RM.init({ laterOn: () => false });
  eq('`when` on open is refused while doing things later is off (as before round 7)', RM.shapeError('open notes in 2 minutes', { act: 'open', thing: 'notes', when: 'in 2 minutes' }), 'when is not part of open');
  eq('a reminder keeps its own `when` either way', RM.shapeError('remind me to call nanu at 6', { act: 'remind', what: 'call nanu', when: 'at 6' }), null);
  eq('a `when` he did not say fails the shape check', RM.shapeError('open notes', { act: 'open', thing: 'notes', when: 'in 2 minutes' }) !== null, true);
  eq('`as` is allowed on close', RM.shapeError('close the notes app', { act: 'close', thing: 'notes', as: 'app' }), null);
  eq('`when` is not allowed where it means nothing (list)', RM.shapeError('list my downloads in 2 minutes', { act: 'list', thing: 'my downloads', when: 'in 2 minutes' }) !== null, true);
}

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
