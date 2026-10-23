'use strict';
// MEASUREMENT SCRIPT — not a test. Which requests need the conversation to be understood?
//
// WHY. context.resolveInText asks the 3B "what does this request's short word stand for?" on EVERY turn
// that has history — 13.9 s of a 19.0 s turn on 2026-09-17 ("create a new folder and index it as
// JARVIS MK-2", 3B cold). A pre-filter that decides whether a request can lean on the conversation at
// all would keep the 3B off the turns that cannot. It has to catch EVERY real reference: a miss means
// "search it up" is searched for "it". A false alarm only costs the call made today.
//
// The two sets below were written BEFORE anything was measured, and nothing in them is an exemplar of
// context.js's regions. LEANING: requests whose object is somewhere else in the conversation (the first
// ten are his, from the log). SELF: requests that carry what they need — many of them his, including
// ones with a pronoun whose referent is in the same sentence, and "ok install among us", the known
// false alarm.
//
// Usage: node sweep_leaning.js        needs ollama and nomic-embed-text
const intent = require('../intent.js');
const cx = require('../context.js');

const LEANING = [
  'search him up on brave', 'okay search it up on youtube', 'Actually lets order that', 'okay order that for me',
  'play his latest video', 'send him the messagege', 'Message them on WhatsApp', 'search that up on brave',
  'open his youtube channel', 'ok search him up',
  'look her up on instagram', 'play that song again', 'open it in chrome', 'close that app', 'delete those files',
  'send it to mama', 'order the same thing again', 'buy that one', 'what about the second one', 'add it to my cart',
  'open the one you just mentioned', 'save that as a note', 'read it out loud', 'email that to parth',
  'find more videos like that', 'open their website', 'search for that on amazon', 'book it for tomorrow',
  'remind me about that tonight', 'tell me more about him', 'who founded it', 'how old is she', 'where is that place',
  'play it on spotify', 'compare it with the pixel 9', 'share this with dad', 'go back to that page',
  'make a folder for them', "text him that i'm on my way", 'open the first one',
];
const SELF = [
  'open github', 'close calculator', 'search lofi beats on youtube', 'create a folder called test-lab on my desktop',
  "what's the weather like", 'who is the ceo of blackrock', 'play bohemian rhapsody on spotify',
  'Create a new folder and label it as JARVIS MK two', 'create a new folder and index it as JARVIS MK-2',
  'open notes and make a note called mechanical soup', 'message mama asking about her health',
  "boot up youtube and play scary pumpkin's latest video", 'open safari and search healthy alternatives for pizza',
  'delete jarvis_confirm_test.txt from desktop', 'read stress_b.txt on my desktop', 'what apps are open right now',
  'how much battery do I have left', 'open youtube and spotify', 'Play Judas by Lady Gaga and open YouTube',
  'find my resume', 'open the app store and install among us', 'ok install among us',
  'what is the height of the burj khalifa?', 'remember that my favourite snack is samosa', 'brief me every morning at 8am',
  'open wikipedia and search it for the eiffel tower', 'call mama on whatsapp', 'search for kaiser on github', 'open ola',
  'what is 8 times 7', 'research the power consumption of AR smart glasses', 'order chicken popcorn medium from KFC',
  'go to bbc.com', 'open iphone mirroring', 'close JarvisOS', 'what is my system status', 'open the calculator',
  'search cats on youtube', 'play judas by lady gaga', 'hey jarvis how does a toilet work?',
  'jarvis can you please message mama saying that the bill for the order is 280',
  'open youtube and search for mythpat and play his latest video', 'what time is it for my mom right now',
  'list my downloads folder', 'make a folder called harness_demo on my desktop and put a file in it called notes.txt saying hello',
  'open spotify and follow lady gaga then open youtube', 'i am bored', 'thanks jarvis', 'tell me a joke',
  'what is claude mythos?', 'explain gravity in about fifty words', 'open terminal', 'create a file called notes.txt',
  'quit textedit', 'search the web for the eiffel tower height and open the first result', 'open the history page in chrome',
  'what should I eat tonight?', 'how are you', 'take a screenshot', 'empty the trash',
];

(async () => {
  const model = intent.MODEL;
  const lean = await intent.centroidOf(model, cx.LEANING_EXEMPLARS.leaning);
  const self = await intent.centroidOf(model, cx.LEANING_EXEMPLARS.self_contained);
  if (!lean || !self) { console.log('embedder unavailable'); process.exit(1); }
  const score = async t => { const v = await intent.embed(t, model); return v ? intent.cos(v, lean) - intent.cos(v, self) : null; };
  const L = [], S = [];
  for (const t of LEANING) L.push([t, await score(t)]);
  for (const t of SELF) S.push([t, await score(t)]);
  L.sort((a, b) => a[1] - b[1]); S.sort((a, b) => b[1] - a[1]);
  console.log('signed score = cos(leaning) - cos(self_contained), ' + model);
  console.log('LEANING, lowest first:');
  for (const [t, s] of L.slice(0, 12)) console.log('  ' + s.toFixed(4) + '  ' + t);
  console.log('SELF, highest first:');
  for (const [t, s] of S.slice(0, 12)) console.log('  ' + s.toFixed(4) + '  ' + t);
  console.log('\n  cut      leaning caught      self skipping the 3B');
  for (const cut of [-0.10, -0.08, -0.06, -0.05, -0.04, -0.03, -0.02, -0.01, 0]) {
    const caught = L.filter(([, s]) => s >= cut).length;
    const skipped = S.filter(([, s]) => s < cut).length;
    console.log('  ' + cut.toFixed(2).padStart(5) + '   ' + String(caught).padStart(6) + ' / ' + L.length + '         ' + String(skipped).padStart(4) + ' / ' + S.length);
  }
  process.exit(0);
})();
