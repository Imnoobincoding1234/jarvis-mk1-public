#!/usr/bin/env python3
"""Round 7's rows — `when`, front pages and reasons, Hinglish opens, talk about music, Hinglish volume, someone's news, screenshot
slang, "close the X app", casual weather/calendar, artist + song. New sentences in Mihir's style.
    gen_round7.py       # writes data/round7_batches/round7.tsv
    then: synth_add.py round7 < data/round7_batches/round7.tsv

Pre-registered in README "Reader round 7" (2026-10-15). The hold file data/round7_valid.jsonl and the conversion set were written
first; this generator REFUSES an exact copy of any line of every casual set, the live bug set, round5/6/7_valid, the clock, timed
and composer held-outs, and DROPS near copies (word Jaccard >= 0.75), counting them. Duplicates inside the batch are dropped.

TRAINING MATERIAL, NOT A RUNTIME LIST. Nothing in JARVIS reads these words; every value is cut from the sentence it labels, so it
is an exact substring by construction, and synth_add.py re-checks every row with label_batch.check.
"""
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'data')
OUT = os.path.join(D, 'round7_batches', 'round7.tsv')
rng = random.Random(20261015)
pick = rng.choice

PRE = ['', '', '', '', 'yo ', 'bro ', 'ok ', 'jarvis ', 'hey jarvis ', 'oye ', 'ayy ', 'pls ']
POST = ['', '', '', '', ' pls', ' rq', ' bro', ' yaar', ' fr', ' lol', ' gng', ' bhai', ' thanks']
APPS = ['spotify', 'discord', 'whatsapp', 'notes', 'safari', 'chrome', 'zoom', 'slack', 'telegram', 'notion', 'xcode', 'vs code',
        'calculator', 'finder', 'mail', 'photos', 'music', 'teams', 'obs', 'figma', 'brave', 'terminal', 'reminders', 'maps']
SITES = ['youtube', 'github', 'chatgpt', 'reddit', 'netflix', 'instagram', 'twitter', 'gmail', 'outlook', 'linkedin', 'amazon',
         'hotstar', 'canva', 'leetcode', 'coursera', 'wikipedia', 'pinterest']
PEOPLE = ['mama', 'papa', 'bhai', 'kunal', 'ira', 'rehaan', 'yuvan', 'nanu', 'tanya', 'vikram', 'ishaan', 'meher', 'jas',
          'kavya', 'arnav', 'karan', 'riya', 'sahil', 'didi', 'chachu', 'bua', 'my coach', 'aman', 'simran']
DELAYS = ['in 2 minutes', 'in 5 mins', 'in like 10 mins', 'in 15 min', 'in 20 minutes', 'in half an hour', 'in an hour', 'in 2 hours',
          'after 10 minutes', 'after half an hour', 'after an hour', 'in about a minute', 'in 30 secs', 'in 45 mins', 'in 3 hours',
          'after 25 minutes', 'in a minute', 'in 90 minutes']
CLOCKS = ['at 9 tonight', 'at 10 pm', 'at 7am', 'at 6 in the evening', 'at midnight', 'at noon', 'at 8:30 pm', 'tonight at 11',
          'at 5', 'at 9:15', 'tomorrow at 7am', 'at 4 pm', 'at 6:45 pm', 'tomorrow morning at 8', 'at 11 tonight']
HI_WHEN = ['10 minute baad', '5 min mein', 'aadhe ghante mein', 'ek ghante baad', 'do ghante baad', 'raat 10 baje', 'kal subah 7 baje',
           'shaam 6 baje', 'dopahar 2 baje', '15 minute baad', '20 min mein', 'raat 11 baje', 'subah 6 baje', 'kal shaam 5 baje']
SONGS = [('arijit singh', 'tum hi ho'), ('the weeknd', 'starboy'), ('taylor swift', 'cruel summer'), ('ap dhillon', 'brown munde'),
         ('karan aujla', 'softly'), ('coldplay', 'yellow'), ('drake', 'one dance'), ('billie eilish', 'lovely'), ('diljit dosanjh', 'lover'),
         ('eminem', 'mockingbird'), ('dua lipa', 'levitating'), ('rehaan moosewala', 'so high'), ('linkin park', 'in the end'),
         ('pritam', 'tum se hi'), ('bruno mars', 'grenade'), ('ed sheeran', 'perfect'), ('kanye west', 'stronger'), ('shubh', 'cheques'),
         ('imagine dragons', 'believer'), ('post malone', 'circles'), ('anuv jain', 'husn'), ('lana del rey', 'young and beautiful')]
QUERIES = ['the match score', 'the ipl points table', 'cheap flights to goa', 'todays news', 'the weather in shimla', 'jee mains result',
           'new marvel trailer', 'f1 results', 'best earbuds under 2000', 'how to make maggi']
BODIES = ['im outside', 'wake up', 'call me', 'omw', 'dinner is ready', 'ill be late', 'gn', 'wya', 'lets go', 'send the notes',
          'happy birthday', 'reached safely', 'khana kha liya?', 'kahan ho', 'jaldi aao', 'leaving now']
REASONS = ['i wanna push my code', 'i got a doubt', 'i need to check something', 'i have a question', 'i gotta reply to someone',
           'i need to see my messages', 'i wanna watch something', 'gotta plan my week', 'i need to study', 'i wanna chill',
           'mujhe kuch dekhna hai', 'kaam hai thoda', 'ek doubt hai']
HI_OPEN = ['{x} khol', 'jaldi se {x} khol', '{x} khol do zara', 'mera {x} khol de', '{x} chalu kar', 'zara {x} kholna', '{x} open kar do',
           '{x} khol de yaar', 'ek baar {x} khol']
FRONT = [('open my mail', 'mail'), ('open my gmail', 'gmail'), ('open my gmail inbox', 'gmail'), ('pull up my inbox on gmail', 'gmail'),
         ('open my outlook inbox', 'outlook'), ('open my email', 'email'), ('get my mail up', 'mail'), ('open my whatsapp', 'whatsapp'),
         ('open my notes', 'notes'), ('bring up my calendar app', 'calendar'), ('open my spotify', 'spotify'), ('open my github', 'github')]
SECTIONS = ['open my youtube history', 'open my spotify liked songs', 'open my github stars', 'open my amazon cart', 'open my netflix list',
            'open my instagram saved posts', 'open my gmail drafts and find the one to sir', 'open my youtube subscriptions page']
MUSIC_TALK = ['that song slaps', 'this song is so good', 'this beat is fire', 'the bass on this is crazy', 'i love this track',
              'tum gaana gaate ho kya', 'kya tum gaana gaa sakte ho', 'tumhe kaunsa gaana pasand hai', 'yeh gaana mast hai',
              'who sings {s}', 'is {a} still making music', '{a} ka naya gaana sun liya maine', 'what album is {s} from',
              'the {a} concert was insane', 'lol this song is stuck in my head', '{s} is such a vibe', 'can u even sing lol',
              'do you have a favourite song', 'kya {a} ke gaane acche hain', 'i was listening to {a} all day']
VOL_DOWN = ['itna tez mat chala, kam kar', 'awaaz kam kar', 'volume thoda kam karo', 'bahut loud hai kam kar', 'aawaz dheere kar do',
            'thoda dheema kar volume', 'kaan phat jayenge, kam karo', 'turn it down a bit', 'too loud bro lower it', 'volume down a little']
VOL_UP = ['awaaz badha do', 'volume thoda tez karo', 'aawaz tez kar', 'sunai nahi de raha, badha', 'turn it up a bit', 'louder pls',
          'volume up thoda', 'thoda aur tez kar do']
NEWS = ['{p} says hi', '{p} said hello', '{p} texted me', '{p} called me earlier', '{p} sent u a hi', 'chal bye', 'chal bye kal baat karte',
        'ok bye milte hai', '{p} ne hi bola', '{p} ka message aaya tha', '{p} wished me happy birthday', '{p} is coming over later',
        'gtg {p} is calling', '{p} replied finally']
SS = ['ss the screen', 'ss pls', 'take an ss', 'screenshot le le', 'snap my screen', 'grab my screen', 'ss this', 'screen ka photo le lo',
      'capture the screen', 'take a screen grab']
SLEEP = ['put the display to sleep', 'turn off my screen', 'sleep the display', 'screen band kar do', 'lock screen off for now']
WEATHER = [('is it gonna rain', None), ('hows the weather looking', None), ('should i take a jacket', None), ('kitni garmi hai bahar', None),
           ('baarish hogi kya {w}', '{w}'), ('is it cold outside {w}', '{w}'), ('weather check {w}', '{w}'), ('hot or nah {w}', '{w}')]
CAL = [('whats on my calendar {w}', '{w}'), ('am i busy {w}', '{w}'), ('anything planned {w}', '{w}'), ('calendar mein kya hai {w}', '{w}'),
       ('hows my schedule {w}', '{w}'), ('do i have class {w}', '{w}')]
CAL_W = ['today', 'tomorrow', 'tmrw', 'kal', 'aaj', 'on friday', 'this weekend', 'tonight']
WX_W = ['today', 'tomorrow', 'tmrw', 'aaj', 'kal', 'tonight', 'this evening']
LATER = ['open youtube later', 'call mama baad mein', 'text bhai later not now', 'spotify baad mein kholna', 'remind me later about it',
         'do it later', 'not now, later']
TIMERS = ['set a timer for {d}', 'start a {d} timer', 'wake me up at {c}', 'set an alarm for {c}']
TIME_STATE = ['my class starts at {c}', 'the bus comes at {c}', 'ill be back in {d}', 'dinner is in {d}', 'main {h} free ho jaunga',
              'the match is at {c}', 'mama {h} aayegi', 'i slept for {d}', 'tuition {h} hai']

rows = []
def add(text, label):
    rows.append((re.sub(r'\s+', ' ', text).strip(), label))

def withfill(core):
    return pick(PRE) + core + pick(POST)

# ---- A. `when` (the act scheduled for that time)
for _ in range(70):
    x = pick(APPS + SITES); w = pick(DELAYS + CLOCKS)
    t = pick(['open {x} {w}', '{w} open {x}', 'launch {x} {w}', 'bring up {x} {w}', 'start {x} {w}']).format(x=x, w=w)
    add(withfill(t), {'act': 'open', 'thing': x, 'when': w})
for _ in range(45):
    x = pick(APPS); w = pick(DELAYS + CLOCKS)
    t = pick(['close {x} {w}', 'quit {x} {w}', '{w} close {x}', 'shut {x} {w}', 'kill {x} {w}']).format(x=x, w=w)
    add(withfill(t), {'act': 'close', 'thing': x, 'when': w})
for _ in range(45):
    a, s = pick(SONGS); q = pick([s, a, 'some ' + a, s + ' by ' + a, 'lofi', 'some chill music', 'my gym playlist']); w = pick(DELAYS + CLOCKS)
    t = pick(['play {q} {w}', '{w} play {q}', 'put on {q} {w}']).format(q=q, w=w)
    add(withfill(t), {'act': 'play', 'query': q, 'when': w})
for _ in range(60):
    p = pick(PEOPLE); b = pick(BODIES); w = pick(DELAYS + CLOCKS)
    form = pick(['text {p} {w} saying {b}', '{w} text {p} {b}', 'msg {p} {w} saying {b}', 'send {p} {b} {w}', '{w} msg {p} saying {b}'])
    add(withfill(form.format(p=p, b=b, w=w)), {'act': 'message', 'to': p, 'body': b, 'when': w})
for _ in range(30):
    p = pick(PEOPLE); w = pick(DELAYS + CLOCKS)
    add(withfill(pick(['call {p} {w}', '{w} call {p}', 'ring {p} {w}']).format(p=p, w=w)), {'act': 'call', 'to': p, 'when': w})
for _ in range(20):
    q = pick(QUERIES); w = pick(DELAYS + CLOCKS)
    add(withfill(pick(['search {q} {w}', '{w} google {q}', 'look up {q} {w}']).format(q=q, w=w)), {'act': 'search_web', 'query': q, 'when': w})
for _ in range(15):
    w = pick(DELAYS); add(withfill(pick(['take a screenshot {w}', 'ss the screen {w}', '{w} take a screenshot']).format(w=w)), {'act': 'screenshot', 'when': w})
for _ in range(20):
    w = pick(DELAYS + CLOCKS); act = pick(['pause', 'volume_down', 'next_track'])
    core = {'pause': pick(['pause the music {w}', 'stop the song {w}', '{w} pause spotify']), 'volume_down': pick(['turn the volume down {w}', '{w} lower the volume']),
            'next_track': pick(['skip this song {w}', '{w} next song'])}[act].format(w=w)
    add(withfill(core), {'act': act, 'when': w})
for _ in range(45):   # Hinglish `when`
    w = pick(HI_WHEN); kind = pick(['open', 'close', 'msg', 'play', 'call'])
    if kind == 'open':
        x = pick(APPS + SITES); add(pick(['{w} {x} khol dena', '{x} {w} khol dena', '{w} {x} chalu kar dena']).format(w=w, x=x), {'act': 'open', 'thing': x, 'when': w})
    elif kind == 'close':
        x = pick(APPS); add(pick(['{w} {x} band kar dena', '{x} {w} band kar dena']).format(w=w, x=x), {'act': 'close', 'thing': x, 'when': w})
    elif kind == 'msg':
        p = pick(PEOPLE); b = pick(BODIES); add('{w} {p} ko msg kar dena {b}'.format(w=w, p=p, b=b), {'act': 'message', 'to': p, 'body': b, 'when': w})
    elif kind == 'play':
        a, s = pick(SONGS); add('{w} {a} ke gaane chala dena'.format(w=w, a=a), {'act': 'play', 'query': a + ' ke gaane', 'when': w})
    else:
        p = pick(PEOPLE); add('{w} {p} ko call laga dena'.format(w=w, p=p), {'act': 'call', 'to': p, 'when': w})

# ---- B. mentions a time, takes no `when`
for _ in range(35):
    p = pick(PEOPLE); w = pick(DELAYS + CLOCKS); b = pick(['ill be there ' + w, 'im on my way, reaching ' + w, 'the class is ' + w, 'call me ' + w,
                                                         'pick me up ' + w, 'movie starts ' + w])
    add(withfill(pick(['text {p} saying {b}', 'tell {p} {b}', 'msg {p} that {b}']).format(p=p, b=b)), {'act': 'message', 'to': p, 'body': b})
for _ in range(20):
    n = pick(['5', '10', '15', '20', '30']); q = pick(['a {n} minute meditation', 'a {n} min workout', '{n} minute study music', 'a {n} min podcast']).format(n=n)
    add(withfill('play ' + q), {'act': 'play', 'query': q})
for _ in range(15):
    n = pick(['10', '15', '20', '30']); q = pick(['{n} minute recipes', '{n} min abs workout', 'how to cook rice in {n} minutes']).format(n=n)
    add(withfill('search ' + q), {'act': 'search_web', 'query': q})
for _ in range(30):
    w = pick(DELAYS + CLOCKS); what = pick(['call nanu', 'drink water', 'study chem', 'take my meds', 'feed the dog', 'pay the bill'])
    add(withfill(pick(['remind me {w} to {what}', 'remind me to {what} {w}']).format(w=w, what=what)), {'act': 'remind', 'what': what, 'when': w})
for _ in range(15):
    add(withfill(pick(LATER)), {'act': 'none'})
for _ in range(15):
    add(withfill(pick(TIMERS).format(d=pick(['10 minutes', '5 min', 'half an hour', '25 mins']), c=pick(['6', '7am', '5:30', '8']))), {'act': 'none'})
for _ in range(30):
    add(withfill(pick(TIME_STATE).format(c=pick(['9', '7:40', '5 pm', '8 tonight', 'noon']), d=pick(['10 mins', 'an hour', '3 hours', 'half an hour']),
                                          h=pick(['6 baje', '10 minute mein', 'shaam ko', 'kal subah']))), {'act': 'none'})

# ---- C. front pages and reasons; sections stay none
for _ in range(30):
    t, x = pick(FRONT); add(withfill(t), {'act': 'open', 'thing': x})
for _ in range(45):
    x = pick(APPS + SITES); r = pick(REASONS)
    add(withfill(pick(['open {x} {r}', 'open {x}, {r}', 'pull up {x} {r}']).format(x=x, r=r)), {'act': 'open', 'thing': x})
for t in SECTIONS:
    add(t, {'act': 'none'}); add(pick(PRE) + t + pick(POST), {'act': 'none'})
# ---- D. Hinglish opens
for _ in range(50):
    x = pick(APPS + SITES); add(pick(PRE) + pick(HI_OPEN).format(x=x) + pick(POST), {'act': 'open', 'thing': x})
# ---- E. talk about music is not a play
for _ in range(60):
    a, s = pick(SONGS); add(withfill(pick(MUSIC_TALK).format(a=a, s=s)), {'act': 'none'})
# ---- F. Hinglish volume
for _ in range(30):
    add(withfill(pick(VOL_DOWN)), {'act': 'volume_down'})
for _ in range(20):
    add(withfill(pick(VOL_UP)), {'act': 'volume_up'})
# ---- G. someone's news is not a message
for _ in range(50):
    add(withfill(pick(NEWS).format(p=pick(PEOPLE))), {'act': 'none'})
# ---- H. screenshot slang (and the display, apart)
for _ in range(30):
    add(withfill(pick(SS)), {'act': 'screenshot'})
for _ in range(12):
    add(withfill(pick(SLEEP)), {'act': 'sleep_display'})
# ---- I. close the X app
for _ in range(30):
    x = pick(APPS); add(withfill(pick(['close the {x} app', 'quit the {x} app', 'shut the {x} app', '{x} app band kar']).format(x=x)), {'act': 'close', 'thing': x, 'as': 'app'})
# ---- J. casual weather / calendar
for _ in range(25):
    t, w = pick(WEATHER); ww = pick(WX_W)
    add(withfill(t.format(w=ww)), {'act': 'weather', **({'when': ww} if w else {})})
for _ in range(25):
    t, w = pick(CAL); ww = pick(CAL_W)
    add(withfill(t.format(w=ww)), {'act': 'calendar', 'when': ww})
# ---- K. artist + song, whole
for _ in range(40):
    a, s = pick(SONGS); q = pick(['{a} {s}', '{s} by {a}', '{s} {a}']).format(a=a, s=s)
    add(withfill(pick(['play {q}', 'put on {q}', 'bajao {q}', 'play {q} on spotify']).format(q=q)),
        {'act': 'play', 'query': q, **({'where': 'spotify'} if False else {})})


def words(s):
    return set(w for w in re.split(r'[^\w]+', str(s).lower()) if w)


def jac(a, b):
    return len(a & b) / (len(a | b) or 1)


protect = []
for f in ['casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl', 'casual_stress_heldout_v3.jsonl', 'casual_bugs_live.jsonl',
          'round5_valid.jsonl', 'round6_valid.jsonl', 'round7_valid.jsonl', 'timed_heldout_v1.jsonl', 'composer_heldout_v1.jsonl']:
    for l in open(os.path.join(D, f)):
        if l.strip():
            r = json.loads(l); protect.append(r.get('text') or r.get('q'))
c = json.load(open(os.path.join(D, 'clock_heldout.json')))
protect += c['clock'] + [z[0] for z in c['zone']] + c['other']
PW = [words(p) for p in protect]
PE = set(' '.join(sorted(w)) for w in PW)
out, seen, near, exact = [], set(), 0, 0
for t, lab in rows:
    if lab.get('act') == 'play' and 'where' in lab and 'spotify' not in t:
        lab.pop('where')
    if t.endswith(' on spotify') and lab.get('act') == 'play':
        lab = dict(lab, where='spotify')
    k = t.lower()
    if k in seen:
        continue
    w = words(t)
    if ' '.join(sorted(w)) in PE:
        exact += 1; continue
    if any(jac(w, p) >= 0.75 for p in PW):
        near += 1; continue
    seen.add(k); out.append((t, lab))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    for t, lab in out:
        f.write(t + '\t' + json.dumps(lab, ensure_ascii=False) + '\n')
acts = {}
for _, lab in out:
    k = lab['act'] + ('+when' if 'when' in lab and lab['act'] not in ('remind', 'calendar', 'weather') else '')
    acts[k] = acts.get(k, 0) + 1
print('wrote', os.path.relpath(OUT, HERE), len(out), 'rows · dropped exact', exact, 'near', near, '·', dict(sorted(acts.items())))
