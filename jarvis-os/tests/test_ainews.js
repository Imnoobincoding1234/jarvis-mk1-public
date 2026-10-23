'use strict';
// ainews.js — the week in AI and machine learning, gathered in dream mode and offered on Sundays.
// No network and no model: the sources are served by a fake fetcher, the model by fake functions.
//
// The properties: his week runs Monday to Sunday and the offer exists ONLY on Sunday; feeds are read by
// their format (RSS, Atom, Hugging Face JSON) and an entry that cannot be placed in a week is dropped;
// one dream rebuilds the whole week (papers per day, feeds paged back to Monday) and a failing source
// never stops the others; every source that published gets its best story into the short version's
// sample before any source gets a second (a small lab's model is not crowded out); the model's short
// version is kept only if every name and number in each sentence is in the one story it is about,
// otherwise the real headlines are; he hears the week once; and the word the greeting tells him to say
// is exactly the word that answers it — and a request that merely contains the word does not.

const path = require('path');
const os = require('os');
const fs = require('fs');
const A = require('../ainews.js');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };
const head = t => console.log('\n— ' + t + ' —');

// A THROWAWAY STATE DIR, SOURCE LIST AND OUTPUT DIR — nothing here may touch his real ones.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ainews-test-'));
const OUT = path.join(TMP, 'out');
const SRC_FILE = path.join(TMP, 'sources.json');     // not ainews.json — that name is the state file's
const at = (y, m, d, h) => new Date(y, m - 1, d, h == null ? 12 : h, 0, 0, 0);
const WED = at(2026, 9, 16), SUN = at(2026, 9, 20, 10), NEXT_SUN = at(2026, 9, 27, 10);
let now = WED;

head('his week runs Monday to Sunday');
{
  let right = 0, sundays = 0;
  for (let i = 0; i < 21; i++) {
    for (const h of [0, 12, 23]) {
      const d = at(2026, 9, 14 + i, h);
      const s = A.weekStart(d);
      if (s.getDay() === 1 && s.getHours() === 0 && d - s >= 0 && d - s < 7 * 86400000) right++;
    }
    if (A.isSunday(at(2026, 9, 14 + i))) { sundays++; ok(at(2026, 9, 14 + i).getDay() === 0, 'the Sunday is getDay() 0'); }
  }
  ok(right === 63, 'every hour of 21 days lands in the week that began on the Monday before it (' + right + '/63)');
  ok(sundays === 3, 'exactly one Sunday in every seven days');
  ok(A.weekKey(at(2026, 9, 20, 23)) === '2026-09-14', 'Sunday belongs to the week that began six days earlier');
  ok(A.weekKey(at(2026, 9, 21, 0)) === '2026-09-21', 'and Monday midnight starts the next one');
}

head('feeds are read by their format, not their words');
const RSS = `<?xml version="1.0"?><rss><channel><title>Lab A</title>
<item><title><![CDATA[Lab A ships Nova-7 &amp; friends]]></title><link>https://laba.example/nova-7</link>
<pubDate>Tue, 15 Sep 2026 09:00:00 GMT</pubDate><description>&lt;p&gt;Nova-7 is our &lt;b&gt;fastest&lt;/b&gt; model&#8217;s release.&lt;/p&gt;</description></item>
<item><title>No date here</title><link>https://laba.example/undated</link></item>
<item><title>No link here</title><pubDate>Tue, 15 Sep 2026 09:00:00 GMT</pubDate></item>
<item><title>Relative link</title><link>/relative</link><pubDate>Tue, 15 Sep 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>r/Test</title>
<entry><title type="html">Tiny lab releases Kestrel-3B</title><link rel="self" href="https://x.example/self"/><link rel="alternate" href="https://x.example/kestrel"/>
<published>2026-09-16T08:00:00+00:00</published><updated>2026-09-16T09:00:00+00:00</updated><content type="html">&lt;div&gt;submitted by someone&lt;/div&gt;</content></entry>
</feed>`;
{
  const src = { name: 'Lab A', group: 'labs', kind: 'rss' };
  const r = A.parseFeed(RSS, src);
  ok(r.length === 1, 'the one placeable entry is read; undated, unlinked and relative-link entries are dropped (' + r.length + ')');
  ok(r[0] && r[0].title === 'Lab A ships Nova-7 & friends', 'CDATA and entities in the title are decoded');
  ok(r[0] && r[0].url === 'https://laba.example/nova-7' && r[0].at === Date.parse('Tue, 15 Sep 2026 09:00:00 GMT'), 'link and pubDate are taken as written');
  ok(r[0] && !/[<>]/.test(r[0].blurb) && /fastest/.test(r[0].blurb) && /model’s/.test(r[0].blurb), 'escaped HTML in the description is decoded, then stripped: "' + (r[0] && r[0].blurb) + '"');
  const a = A.parseFeed(ATOM, { name: 'r/Test', group: 'field', kind: 'atom' });
  ok(a.length === 1 && a[0].url === 'https://x.example/kestrel', 'Atom: the alternate link, not the self link');
  ok(a[0] && a[0].at === Date.parse('2026-09-16T08:00:00+00:00'), 'Atom: published before updated');
  ok(A.parseFeed('<html><body>429 Too Many Requests</body></html>', src).length === 0, 'an error page is not a feed');
  const rel = A.parseFeed('<feed><entry><title>FIG</title><link href="/frontier-intelligence-group/" rel="alternate"/><published>2026-09-18T00:00:00+09:00</published></entry></feed>',
    { name: 'Sakana AI', group: 'labs', kind: 'atom', url: 'https://sakana.ai/feed.xml' });
  ok(rel.length === 1 && rel[0].url === 'https://sakana.ai/frontier-intelligence-group/', 'a relative link is resolved against the feed\'s own address (Sakana\'s feed read as empty before this)');

  const papers = A.parseHfPapers([{ paper: { id: '2609.1', title: 'LimiX-2: Structured Data', upvotes: 163, summary: 'We introduce LimiX-2.', organization: { fullname: 'Stable AI' } } }, { paper: {} }],
    at(2026, 9, 15, 3), { name: 'HF papers', group: 'field', kind: 'hf-papers' });
  ok(papers.length === 1 && papers[0].url === 'https://huggingface.co/papers/2609.1', 'a paper links to its Hugging Face page; a paper with no id is dropped');
  ok(papers[0] && papers[0].score === 163 && papers[0].org === 'Stable AI' && new Date(papers[0].at).getHours() === 12, 'upvotes, the lab, and noon of the day it was featured');
  const models = A.parseHfModels([
    { id: 'prism-ml/Ternary-Bonsai-2-27B-gguf', likes: 439, downloads: 0, pipeline_tag: 'text-generation', createdAt: '2026-09-16T00:00:00Z' },
    { id: 'bigco/old-model', likes: 9000, createdAt: '2025-01-01T00:00:00Z' },
  ], { name: 'HF models', group: 'field', kind: 'hf-models' }, at(2026, 9, 1).getTime());
  ok(models.length === 1 && models[0].org === 'prism-ml' && models[0].score === 439, 'a trending model counts only if it is NEW — the old favourite is not this week\'s news');
}

// ---- a fake internet for everything below ----
const CONFIG = { enabled: true, sources: [
  { name: 'Lab A', group: 'labs', kind: 'rss', url: 'https://laba.example/feed' },
  { name: 'Tiny Lab', group: 'labs', kind: 'rss', url: 'https://tiny.example/feed' },
  { name: 'Press B', group: 'news', kind: 'rss', url: 'https://pressb.example/feed/', pages: 5 },
  { name: 'Broken', group: 'news', kind: 'rss', url: 'https://broken.example/feed' },
  { name: 'HF papers', group: 'field', kind: 'hf-papers', url: 'https://hf.example/api/daily_papers' },
  { name: 'HF models', group: 'field', kind: 'hf-models', url: 'https://hf.example/api/models?sort=trendingScore' },
] };
fs.writeFileSync(SRC_FILE, JSON.stringify(CONFIG));
const rss = items => '<rss><channel>' + items.map(i => '<item><title>' + i[0] + '</title><link>' + i[1] + '</link><pubDate>' + i[2].toUTCString() + '</pubDate><description>' + (i[3] || '') + '</description></item>').join('') + '</channel></rss>';
const LAB_A = [];
for (let k = 0; k < 10; k++) LAB_A.push(['Lab A post number ' + (k + 1), 'https://laba.example/p' + k, at(2026, 9, 14 + (k % 3), 9 + k), 'Post ' + (k + 1) + ' of the week']);
const requested = [];
function fetchText(url) {
  requested.push(url);
  if (url === 'https://laba.example/feed') return Promise.resolve(rss(LAB_A));
  if (url === 'https://tiny.example/feed') return Promise.resolve(rss([['Tiny Lab releases Kestrel-3B', 'https://tiny.example/kestrel', at(2026, 9, 15), 'A 3B model from a two-person lab']]));
  if (url === 'https://pressb.example/feed/') return Promise.resolve(rss([['Press B story one: Tiny Lab\'s Kestrel-3B tested', 'https://pressb.example/1', at(2026, 9, 16, 8)], ['Press B story two', 'https://pressb.example/2', at(2026, 9, 15, 8)]]));
  if (url === 'https://pressb.example/feed/?paged=2') return Promise.resolve(rss([['Press B story three', 'https://pressb.example/3', at(2026, 9, 15, 6)], ['Press B story four', 'https://pressb.example/4', at(2026, 9, 14, 8)]]));
  // page 3 reaches back past Monday: the last page needed
  if (url === 'https://pressb.example/feed/?paged=3') return Promise.resolve(rss([['Press B story five', 'https://pressb.example/5', at(2026, 9, 14, 1)], ['Press B last week', 'https://pressb.example/old', at(2026, 9, 12)]]));
  if (url === 'https://broken.example/feed') return Promise.reject(new Error('HTTP 429'));
  if (url.startsWith('https://hf.example/api/daily_papers?date=')) {
    const day = url.split('=').pop();
    return Promise.resolve(JSON.stringify(day === '2026-09-15'
      ? [{ paper: { id: '2609.17488', title: 'LimiX-2: A Contextual Mechanism Network', upvotes: 163, summary: 'We introduce LimiX-2.', organization: { fullname: 'Stable AI' } } },
         { paper: { id: '2609.00002', title: 'A quiet paper', upvotes: 3, summary: 'Small result.' } }]
      : []));
  }
  if (url.startsWith('https://hf.example/api/models')) {
    return Promise.resolve(JSON.stringify([{ id: 'prism-ml/Ternary-Bonsai-2-27B-gguf', likes: 439, downloads: 0, pipeline_tag: 'text-generation', createdAt: '2026-09-16T02:00:00Z' }]));
  }
  return Promise.reject(new Error('unexpected url ' + url));
}
const FREE = async () => true;
A.init({ jlog: () => {}, stateDir: TMP, outDir: OUT, llm: null, fetchText, now: () => now, sourcesFile: SRC_FILE });

(async () => {
  head('one dream reads the whole week');
  {
    requested.length = 0;
    const r = await A.gather(WED, FREE);
    const papersAsked = requested.filter(u => u.includes('daily_papers')).map(u => u.split('=').pop());
    ok(papersAsked.join(',') === '2026-09-14,2026-09-15,2026-09-16', 'papers are fetched for every day from Monday to today: ' + papersAsked.join(','));
    const pressPages = requested.filter(u => u.startsWith('https://pressb.example/'));
    ok(pressPages.length === 3, 'a paged feed is followed back until a page reaches past Monday, and no further (' + pressPages.length + ' pages of 5 allowed)');
    ok(r.failed.length === 1 && /Broken/.test(r.failed[0]) && /429/.test(r.failed[0]), 'a failing source is reported: ' + r.failed.join('; '));
    ok(r.got.some(i => i.source === 'HF models') && r.got.some(i => i.source === 'Tiny Lab'), '…and does not stop the sources after it');
    let asked = 0;
    const r2 = await A.gather(WED, async () => ++asked < 3);
    ok(r2.interrupted === true && r2.got.length < r.got.length, 'coming back stops the reading part-way (' + r2.got.length + ' of ' + r.got.length + ' stories)');
  }

  head('the week\'s stories are chosen by what the week shows, not by the model');
  {
    const items = (await A.gather(WED, FREE)).got.filter(i => i.at >= at(2026, 9, 14, 0).getTime());
    const p = A.rankWeek(items);
    ok(p.main[0] && p.main[0].title === 'Tiny Lab releases Kestrel-3B',
      'the story two sources carried leads — even from a two-person lab, over Lab A\'s ten posts: "' + (p.main[0] && p.main[0].title) + '"');
    ok(!p.main.some(i => i.url === 'https://pressb.example/1'), 'and Press B\'s report of the same story is not told twice');
    ok(new Set(p.main.map(i => i.source)).size === p.main.length && p.main.length === 3, 'one headline per source (' + p.main.map(i => i.source).join(', ') + ')');
    ok(p.field.length === 2 && p.field[0].title.startsWith('LimiX-2') && p.field[1].org === 'prism-ml',
      'the wider field: the most upvoted paper and the most liked NEW model, though no one else covered them');
    const g = (title, source, group, kind) => ({ title, source, group: group || 'news', kind: kind || 'rss', at: 1, url: 'https://x.example/' + source });
    const links = A.rankWeek([g('Introducing Gemini 3.8 Live', 'S1', 'labs'), g('Qwen 3.8 Max arrives', 'S2'), g('Meet Nova7x', 'S3'), g('Nova7x beats the benchmarks', 'S4')]);
    ok(links.coverage(links.main.find(i => i.source === 'S1')) === 0, 'a bare version number does not make two products one story (Gemini 3.8 vs Qwen 3.8)');
    ok([...links.main].filter(i => i.title.includes('Nova7x')).length === 1, 'a shared name with letters and digits does ("Nova7x" is told once)');
    const rel = A.rankWeek([g('How a law firm uses chatbots', 'Lab X', 'labs'), Object.assign(g('Lab X ships Falcon-9B', 'Lab X', 'labs'), { at: 0 })]);
    ok(rel.main.length === 1 && /Falcon-9B/.test(rel.main[0].title), 'a release leads its source ahead of a newer customer story');
  }

  head('every sentence is checked against the one story it names');
  {
    // As the prompt numbers them: labs first, then the wider field.
    const numbered = [
      { title: 'Introducing Gemini 3.8 Live', source: 'Google DeepMind', group: 'labs', org: '', blurb: 'A faster live voice model', scoreText: '' },
      { title: 'OpenAI releases GPT-6.1 mini', source: 'OpenAI', group: 'labs', org: '', blurb: 'A smaller model', scoreText: '' },
      { title: 'Anthropic rebuilds Projects in Claude Code', source: 'The Decoder', group: 'news', org: '', blurb: 'Parallel agent workflows.', scoreText: '' },
      { title: 'prism-ml/Ternary-Bonsai-2-27B-gguf', source: 'Hugging Face models', group: 'field', org: 'prism-ml', blurb: 'text-generation', scoreText: '439 likes', kind: 'hf-models' },
      { title: 'Vidu S2: Real-Time Interactive Video Generation', source: 'Hugging Face papers', group: 'field', org: 'Tsinghua University', blurb: 'We present Vidu S2.', scoreText: '714 upvotes' },
    ];
    const s = (story, text) => ({ story, text });
    const draft = list => JSON.stringify({ sentences: list });
    // The week's own lower-case words decide which sentence-initial words are ordinary. A real week has
    // hundreds of stories; this fixture stands in for their plain English. "deepmind.google" is there to
    // show a domain does not make "Google" ordinary.
    const ord = A.ordinaryWords(numbered.concat([{ title: 'the lab said a model was released this week', blurb: 'see deepmind.google for details' }]));
    ok(ord.has('the') && !ord.has('google') && !ord.has('microsoft'), 'ordinary words come from the week\'s text — "the" is one, "google" (seen only in a domain) is not');
    const good = [
      s(1, 'Google DeepMind introduced Gemini 3.8 Live, a faster live voice model.'),
      s(2, 'OpenAI released GPT-6.1 mini, a smaller model.'),
      s(3, 'Anthropic rebuilt Projects in Claude Code with parallel agent workflows.'),
      s(4, 'The lab prism-ml released Ternary-Bonsai-2-27B, which drew 439 likes.'),
      s(5, 'Tsinghua University presented Vidu S2 for real-time video generation, with 714 upvotes.'),
    ];
    const c = A.checkDraft(draft(good), numbered, ord);
    ok(c.ok && c.kept.length === 5 && !c.dropped.length, 'five faithful sentences are all kept' + (c.ok ? '' : ' — ' + c.why));
    ok(c.text === good.map(g => g.text).join(' '), 'and read as one spoken paragraph, in the model\'s order');
    // Each bad sentence REPLACES a good one, so it is dropped for what it says — not for repeating a story.
    const drop = (k, bad, expect, label) => {
      const list = good.slice(); list[k] = bad;
      const r = A.checkDraft(draft(list), numbered, ord);
      const why = r.dropped[0] ? r.dropped[0].why : 'NOT dropped';
      ok(r.ok && r.kept.length === 4 && r.dropped.length === 1 && why.includes(expect), label + ' — ' + why);
    };
    drop(1, s(2, 'OpenAI released GPT-7 ultra.'), 'gpt-7', 'an invented model name costs its sentence, not the summary');
    drop(3, s(4, 'The model Ternary-Bonsai-2-27B has 9000 likes.'), '9000', 'an invented number is caught');
    drop(1, s(2, 'OpenAI released Gemini 3.8 Live.'), 'gemini', 'one lab\'s news credited to another is caught');
    drop(4, s(5, 'Hugging Face introduced Vidu S2.'), 'hugging', 'a paper credited to the website that listed it is caught — the first live draft\'s mistake');
    drop(0, s(1, 'Read more at https://deepmind.google now.'), 'link', 'a link is caught — the short version is spoken');
    drop(0, s(9, 'Something happened.'), 'no story 9', 'a story number that does not exist is caught');
    drop(0, s(2, 'OpenAI released GPT-6.1 mini again.'), 'twice', 'the same story twice is caught');
    ok(!A.checkDraft(draft([good[0], good[3]]), numbered, ord).ok, 'fewer than three sentences left is not a summary');
    const noField = A.checkDraft(draft(good.slice(0, 3)), numbered, ord);
    ok(!noField.ok && /wider field/.test(noField.why), 'three sentences with nothing from the wider field is not the summary he asked for');
    ok(!A.checkDraft('Here is the week: Gemini 3.8 Live was released.', numbered, ord).ok, 'prose instead of the JSON asked for is not taken');
    ok(A.checkDraft('```json\n' + draft(good) + '\n```', numbered, ord).ok, 'the JSON is found inside a code fence');
    ok(A.nameTokens('OpenAI\'s new model').includes('OpenAI'), 'a possessive is cut at the apostrophe');
    const tc = good.slice(); tc[0] = s(1, 'Google DeepMind Introduces Gemini 3.8 Live, A Faster Live Voice Model.');
    ok(A.checkDraft(draft(tc), numbered, ord).kept.length === 5, 'title case is not an invention: "Introduces" is the story\'s "Introducing" (the third live run dropped this)');
    const ms = good.slice(); ms[0] = s(1, 'Microsoft introduced Gemini 3.8 Live.');
    const msr = A.checkDraft(draft(ms), [Object.assign({}, numbered[0], { blurb: 'Seen under a microscope' })].concat(numbered.slice(1)), ord);
    ok(msr.dropped.length === 1 && /microsoft/.test(msr.dropped[0].why), 'a wrong maker FIRST in the sentence is caught, and "Microsoft" is not "microscope"');
    const th = good.slice(); th[1] = s(2, 'The model GPT-6.1 mini was released by OpenAI.');
    ok(A.checkDraft(draft(th), numbered, ord).kept.length === 5, 'while an ordinary first word ("The") is not taken for a name');
    const v = good.slice(); v[1] = s(2, 'OpenAI released GPT-6.2 mini.');
    ok(A.checkDraft(draft(v), numbered, ord).dropped.length === 1, 'and a version must match exactly: "GPT-6.2" is not the story\'s GPT-6.1');
    const picks = { main: numbered.slice(0, 3), field: numbered.slice(3) };
    const p = A.promptFor(picks);
    ok(!/Hugging Face papers|Hugging Face models|The Decoder/.test(p.user) && p.user.includes('(by Tsinghua University)') && p.user.includes('(by Google DeepMind)'),
      'the prompt names who made each story, and never the site or outlet it was posted on');
    ok(p.numbered.length === 5 && p.numbered[3] === numbered[3] && p.schema && p.schema.properties.sentences,
      'and numbers the chosen stories in order — headlines, then the wider field — asking for one sentence each');
    const h = A.headlines(picks);
    ok(/Gemini 3\.8 Live/.test(h) && /Ternary-Bonsai-2-27B-gguf from prism-ml/.test(h) && !/https?:/.test(h),
      'the fallback reads the same chosen stories, a new model named with its lab: "' + h.slice(0, 120) + '…"');
  }

  head('the job: the model\'s version when it is faithful, the headlines when it is not');
  {
    // A faithful fake: the JSON it is asked for, each sentence a story's own title — the first three stories
    // (the announcements) and the last two (the wider field, which the prompt lists last).
    const numberedLines = a => a.messages[0].content.split('\n').filter(l => /^\d+\. /.test(l))
      .map(l => ({ story: Number(l.split('.')[0]), title: l.replace(/^\d+\. /, '').split(/ \(by | — /)[0] }));
    let asked = null;
    const copyist = async a => {
      asked = a;
      const n = numberedLines(a);
      return { text: JSON.stringify({ sentences: n.slice(0, 3).concat(n.slice(-2)).map(x => ({ story: x.story, text: x.title + '.' })) }) };
    };
    A.init({ llm: copyist }); now = WED;
    const said = await A.job({ stillFree: FREE, force: true });
    const w = A.status(WED);
    ok(w.ready && w.via === 'model', 'a faithful draft is kept as the short version (' + said + ')');
    ok(asked && asked.schema && asked.schema.properties.sentences, 'the model is asked for the numbered-sentence JSON, not prose');
    ok(w.thisWeek === 19, 'the week holds its 19 stories — none from the Saturday before Monday (' + w.thisWeek + ')');

    ok((await A.job({ stillFree: FREE })) === null, 'a second dream within three hours does not re-read 28 sources');

    // One invented sentence among faithful ones: that sentence goes, the model's summary stays.
    A.init({ llm: async a => {
      const j = JSON.parse((await copyist(a)).text);
      j.sentences[1] = { story: j.sentences[1].story, text: 'Anthropic also released Claude 9.' };
      return { text: JSON.stringify(j) };
    } });
    fs.rmSync(path.join(TMP, 'ainews.json'));
    A.init({});
    await A.job({ stillFree: FREE, force: true });
    const s1 = JSON.parse(fs.readFileSync(path.join(TMP, 'ainews.json'), 'utf8')).weeks[A.weekKey(WED)];
    ok(s1.via === 'model' && !/Claude 9/.test(s1.short) && s1.dropped.length === 1 && /"(anthropic|claude)" is not in story/.test(s1.dropped[0]),
      'one invented sentence is dropped for what it invented, and the rest kept — ' + (s1.dropped[0] || 'nothing dropped'));

    // All of it invented: nothing holds up, so the headlines, and the draft kept beside the reason.
    A.init({ llm: async () => ({ text: JSON.stringify({ sentences: [1, 2, 3, 4].map(k => ({ story: k, text: 'Anthropic released Claude ' + (8 + k) + '.' })) }) }) });
    fs.rmSync(path.join(TMP, 'ainews.json'));
    A.init({});
    await A.job({ stillFree: FREE, force: true });
    const s2 = JSON.parse(fs.readFileSync(path.join(TMP, 'ainews.json'), 'utf8')).weeks[A.weekKey(WED)];
    ok(s2.via === 'headlines' && /held up/.test(s2.why) && /Claude 9/.test(s2.rejectedDraft), 'a draft that invents everything gives way to the headlines — "' + s2.why + '"');

    fs.rmSync(path.join(TMP, 'ainews.json'));
    A.init({ llm: async () => { throw new Error('model not loaded'); } });
    await A.job({ stillFree: FREE, force: true });
    ok(A.status(WED).via === 'headlines', 'a model that fails leaves the headlines, not nothing');

    fs.rmSync(path.join(TMP, 'ainews.json'));
    A.init({ llm: copyist });
    let n = 0;
    const partly = await A.job({ stillFree: async () => ++n < 4, force: true });
    const w3 = A.status(WED);
    ok(w3.ready && w3.via === 'headlines' && w3.thisWeek < 19 && /came back/.test(partly),
      'coming back mid-read stops it, and the model is not loaded — the headlines of what was read (' + w3.thisWeek + ' stories)');
    fs.rmSync(path.join(TMP, 'ainews.json'));
    A.init({ llm: copyist });
    await A.job({ stillFree: FREE, force: true });
  }

  head('Sundays only, and only until he has heard it');
  {
    for (let d = 14; d <= 19; d++) ok(A.greetingLine(at(2026, 9, d, 9)) === null, at(2026, 9, d).toDateString() + ': nothing offered, though the week is ready');
    const line = A.greetingLine(SUN);
    ok(typeof line === 'string' && /19 stories/.test(line), 'Sunday: "' + line + '"');
    const word = ((line || '').match(/Say "([^"]+)"/) || [])[1];
    ok(word === A.OFFER_WORD, 'the greeting names its own answer: "' + word + '"');
    ok(A.greetingLine(NEXT_SUN) === null, 'the next Sunday does not offer last week');

    const told = A.present(SUN);
    const shortNow = JSON.parse(fs.readFileSync(path.join(TMP, 'ainews.json'), 'utf8')).weeks[A.weekKey(WED)].short;
    ok(told && told.reply.startsWith(shortNow) && !/https?:/.test(told.reply), 'the reply is the short version, with no link in it — it is spoken');
    ok(told && /19 stories/.test(told.reply) && /JARVIS Outputs/.test(told.reply), 'and says where the full list is');
    const doc = told && told.file ? fs.readFileSync(told.file, 'utf8') : '';
    ok(['https://tiny.example/kestrel', 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf', 'https://huggingface.co/papers/2609.17488', 'https://pressb.example/5']
      .every(u => doc.includes('(' + u + ')')) && !doc.includes('pressb.example/old'), 'the full list links every story of the week, and nothing from before Monday');
    ok(A.greetingLine(SUN) === null, 'heard once: Sunday does not offer it again');
    now = WED;
    await A.job({ stillFree: FREE, force: true });
    ok(A.status(WED).presented, 'and a later dream does not rewrite a week he has already heard');
  }

  head('the answer is the offered word, and only that');
  {
    // server.js points ainews at HIS state directory when it loads, so this comes last and reads only.
    process.env.JARVIS_READER_CACHE = process.env.JARVIS_READER_CACHE || 'readmodel.test.json';
    const J = require('../server.js');
    for (const t of ['summary', 'Summary.', 'SUMMARY!']) ok(J.answersDigestOffer(t) === true, '"' + t + '" is the answer');
    for (const t of ['yes', 'yeah sure', 'no', '', 'summary of the french revolution', 'open spotify'])
      ok(J.answersDigestOffer(t) === false, '"' + t + '" is not' + (t.includes('summary') ? ' — a request that contains the word is a request' : ''));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed: ' + (e.stack || e)); process.exit(1); });
