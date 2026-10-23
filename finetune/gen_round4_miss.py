#!/usr/bin/env python3
"""Round 4's rows for the SHAPES round 3 got wrong — new sentences in Mihir's style, never the failing lines.
    gen_round4_miss.py       # writes data/round4_batches/round4-miss.tsv
    then: synth_add.py round4-miss < data/round4_batches/round4-miss.tsv

Where the shapes come from: round 3's dev run (round3b-20260928) and the reader-play rerun (playfix-20260928) on
the casual stress set. Those lines are READ now, so none of them is copied here: other people, other artists,
other creators, other bodies. The generator refuses to write any sentence whose normalised text equals a line
of data/casual_stress_heldout.jsonl, and build_dataset.py --exclude drops near ones on top.

  - a person after a short verb ("yo txt kabir …" read the person as "txt")      → message {to, body}
  - a body that starts with "i" ("i cant make it" lost its "i")                   → body copied whole
  - "did u text X" / "u called mama right"                                        → none (a question about the past)
  - "at 9 text kunal …"                                                           → none (a scheduled send)
  - calls in his register ("call X rq", "yo facetime X", "X ko phone kar")        → call
  - "skip this trash song" read as a delete                                       → next_track
  - Hinglish player words ("gaana band kar", "awaaz badha")                       → pause / volume
  - "kya haal chaal" read as weather                                              → none (small talk), with real
    Hinglish weather asks beside it so the line between them is taught, not just one side
  - a reminder's time folded into `what`                                          → what and when apart
  - plays he asks for in slang or Hinglish ("blast X rn", "X chala do", "X laga de") → play
  - videos named as streams, vids, "ki latest video"                              → play with video

TRAINING MATERIAL, NOT A RUNTIME LIST. Nothing in JARVIS reads these words; every value is cut from the
sentence it labels, so it is an exact substring by construction, and synth_add.py re-checks every row.
"""
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'round4_batches', 'round4-miss.tsv')
STRESS = os.path.join(HERE, 'data', 'casual_stress_heldout.jsonl')
rng = random.Random(20260929)
pick = rng.choice

PEOPLE = ['rohan', 'aman', 'tanya', 'vikram', 'neha', 'ishaan', 'meher', 'jas', 'gurpreet', 'ankit', 'chachu', 'didi',
          'my coach', 'mama', 'papa', 'nanu', 'bhai', 'sid', 'arnav', 'kavya']
HI_PEOPLE = ['mama', 'papa', 'bhai', 'didi', 'chachu', 'nanu', 'rohan', 'aman', 'gurpreet']
BODIES = ['im outside', 'omw', 'gn', 'wya', 'call me when u can', 'running 10 mins late', 'bring my charger',
          'reached', 'u up?', 'the match starts at 8', 'lets go tmrw', 'ok bet', 'ghar aa raha hu', 'khana kha liya?']
I_BODIES = ['i cant come today', 'i\'ll be there in 10', 'i forgot my keys', 'i reached', 'i need the notes',
            'i wont be home for dinner', 'i owe u one', 'i left my bag in ur car', 'im gonna be late', 'i miss u guys']
ARTISTS = ['ed sheeran', 'taylor swift', 'diljit', 'rehaan moosewala', 'seedhe maut', 'badshah', 'pritam', 'shreya ghoshal',
           'eminem', 'kendrick', 'sza', 'the local train', 'prateek kuhad', 'krsna', 'imagine dragons', 'post malone']
HI_MUSIC = ['diljit ke gaane', 'marathi gaane', 'old songs', 'pritam ke songs', 'romantic gaane', 'party songs',
            'rehaan ke gaane', 'bhajan', 'sufi songs']
CREATORS = ['technoblade', 'markiplier', 'bb ki vines', 'triggered insaan', 'dhruv rathee', 'sidemen', 'mkbhd',
            'fukra insaan', 'tanmay bhat', 'mrwhosetheboss']
TASKS = ['pay the electricity bill', 'call nanu', 'water the plants', 'return the library book', 'email sir',
         'book the cab', 'finish the ppt', 'renew my metro card']
TIMES = ['at 6', 'at 9pm', 'tmrw morning', 'in 30 mins', 'tonight', 'at 5:30', 'on sunday', 'in 2 hours']
CITIES = ['kolhapur', 'jaipur', 'pune', 'amritsar', 'goa']

rows = []


def add(text, label):
    rows.append((text, label))


def cut(text, value):
    """The value exactly as it appears in the sentence (case kept), or fail loudly."""
    i = text.lower().find(value.lower())
    if i < 0:
        raise SystemExit(f'value {value!r} not in {text!r}')
    return text[i:i + len(value)]


def msg(text, to, body):
    add(text, {'act': 'message', 'to': cut(text, to), 'body': cut(text, body)})


# a person right after a short verb
for _ in range(45):
    p, b = pick(PEOPLE), pick(BODIES)
    t = pick(['yo txt {p} {b}', 'txt {p} {b}', 'msg {p} {b}', 'yo msg {p} {b}', 'dm {p} {b}', 'hit {p} up saying {b}',
              'txt {p} saying {b}', 'shoot {p} a text {b}', 'ping {p} {b}', 'tell {p} {b}']).format(p=p, b=b)
    msg(t, p, b)
# bodies that start with "i"
for _ in range(35):
    p, b = pick(PEOPLE), pick(I_BODIES)
    t = pick(['text {p} saying {b}', 'tell {p} {b}', 'msg {p} {b}', 'whatsapp {p} {b}', 'txt {p} that {b}',
              'let {p} know {b}']).format(p=p, b=b)
    msg(t, p, b)
# questions about the past → none
for _ in range(35):
    p = pick(PEOPLE)
    t = pick(['did u text {p}', 'did u send that msg to {p}', 'u texted {p} right?', 'did u call {p} or nah',
              'did the message to {p} go through', 'wait did u actually msg {p}', 'did {p} get my text',
              'u called {p} earlier right', 'did i text {p} yesterday', 'has {p} replied']).format(p=p)
    add(t, {'act': 'none'})
# scheduled sends → none
for _ in range(30):
    p, b, w = pick(PEOPLE), pick(BODIES), pick(['at 9', 'at 7am', 'tmrw morning', 'in an hour', 'at midnight', 'tonight at 10'])
    t = pick(['{w} text {p} {b}', 'text {p} {w} saying {b}', '{w} msg {p} {b}', 'send {p} {b} {w}',
              'schedule a text to {p} {w}']).format(p=p, b=b, w=w)
    add(t, {'act': 'none'})
# calls in his register
for _ in range(20):
    p = pick(PEOPLE)
    t = pick(['call {p} rq', 'yo call {p}', 'ring {p}', 'call {p} real quick', 'give {p} a call', 'call {p} asap']).format(p=p)
    add(t, {'act': 'call', 'to': cut(t, p)})
for _ in range(15):
    p = pick(PEOPLE)
    t = pick(['yo facetime {p}', 'facetime {p} rq', 'ft {p}', 'video call {p} on whatsapp']).format(p=p)
    lab = {'act': 'call', 'to': cut(t, p), 'video': True}
    if 'facetime' in t:
        lab['where'] = cut(t, 'facetime')
    if 'whatsapp' in t:
        lab['where'] = cut(t, 'whatsapp')
    add(t, lab)
for _ in range(25):
    p = pick(HI_PEOPLE)
    t = pick(['{p} ko phone kar', '{p} ko call kar do', '{p} ko phone lagao', '{p} ko call laga', 'zara {p} ko phone karo',
              '{p} ko call karo jaldi']).format(p=p)
    add(t, {'act': 'call', 'to': cut(t, p)})
# skip, in his words
for t in ['skip this trash song', 'skip this garbage', 'next song pls this one sucks', 'skip this one its mid',
          'nah skip', 'this song is ass skip it', 'skip skip skip', 'change the song bro', 'agla gaana', 'gaana skip kar',
          'next wala laga', 'ye gaana badal do', 'skip kar yaar', 'skip this cringe song', 'next track pls']:
    add(t, {'act': 'next_track'})
for t in ['gaane ko band kar de', 'music band karo', 'pause kar de', 'ruk ja gaana', 'stop the music for a sec', 'pause it rq']:
    add(t, {'act': 'pause'})
for t in ['gaana wapas chala', 'resume kar', 'play it again from where it stopped', 'unpause']:
    add(t, {'act': 'resume'})
for t in ['awaaz badha do', 'volume badhao', 'louder pls', 'crank it up a lil', 'thoda loud kar']:
    add(t, {'act': 'volume_up'})
for t in ['awaaz kam kar', 'volume kam karo', 'too loud turn it down', 'thoda dheere', 'lower the volume a bit']:
    add(t, {'act': 'volume_down'})
# Hinglish small talk → none, beside real weather asks
for t in ['aur bhai kya haal', 'kya haal hai bro', 'kya scene hai aaj', 'aur bata kya chal raha', 'kaisa hai bhai',
          'sab badhiya?', 'kya kar raha hai', 'kya haal hai jarvis', 'aur sunao', 'kaise ho', 'sab theek?',
          'kya chal raha hai life mein', 'bas timepass', 'kuch nahi yaar bore ho raha', 'mood off hai aaj',
          'wsg jarvis', 'hyd jarvis', 'how u holding up', 'wyd rn', 'sup']:
    add(t, {'act': 'none'})
for _ in range(12):
    c = pick(CITIES)
    t = pick(['{c} mein mausam kaisa hai', 'aaj {c} ka weather kya hai', 'weather in {c} rn', 'is it raining in {c}',
              '{c} mein baarish ho rahi hai kya']).format(c=c)
    add(t, {'act': 'weather', 'where': cut(t, c)})
for t in ['aaj mausam kaisa hai', 'bahar thand hai kya', 'weather kaisa hai aaj', 'will it rain today', 'is it hot outside rn']:
    add(t, {'act': 'weather'})
# reminders: what and when apart
for _ in range(35):
    k, w = pick(TASKS), pick(TIMES)
    t = pick(['remind me {w} to {k}', 'lmk {w} to {k}', 'remind me to {k} {w}', '{w} remind me to {k}',
              'yaad dila dena {w} {k}', 'set a reminder {w} to {k}']).format(k=k, w=w)
    add(t, {'act': 'remind', 'what': cut(t, k), 'when': cut(t, w)})
# plays in slang / Hinglish
for _ in range(40):
    a = pick(ARTISTS)
    t = pick(['blast {a} rn', 'bump {a}', 'run {a}', 'spin some {a}', 'queue up {a}', 'can u play the new {a} album',
              'lowkey wanna hear {a}', 'put {a} on', 'yo play {a} gng', 'throw some {a} on', 'play {a} pls',
              'i need some {a} rn']).format(a=a)
    q = 'the new ' + a + ' album' if 'album' in t else a
    add(t, {'act': 'play', 'query': cut(t, q)})
for _ in range(30):
    m = pick(HI_MUSIC + ARTISTS)
    t = pick(['{m} chala do', '{m} laga de', '{m} baja do', '{m} chala de yaar', 'koi {m} laga do', 'thoda {m} chala',
              '{m} laga na']).format(m=m)
    add(t, {'act': 'play', 'query': cut(t, m)})
# videos
for _ in range(30):
    c = pick(CREATORS)
    t, q, where = pick([
        ('play the {c} stream', 'the {c} stream', None),
        ('put on some {c} vids', '{c} vids', None),
        ('{c} ki latest video chala', '{c} ki latest video', None),
        ('{c} ka naya video laga do', '{c} ka naya video', None),
        ('throw on a {c} video', 'a {c} video', None),
        ('play {c} on yt', '{c}', 'yt'),
        ('watch {c} on youtube', '{c}', 'youtube'),
    ])
    t, q = t.format(c=c), q.format(c=c)
    lab = {'act': 'play', 'query': cut(t, q), 'video': True}
    if where:
        lab['where'] = cut(t, where)
    add(t, lab)
for t, q, w in [('play a random vid on youtube', 'a random vid', 'youtube'), ('put on some random yt video', 'some random yt video', None),
                ('play some dog videos', 'dog videos', None), ('play funny fails videos lol', 'funny fails videos', None)]:
    lab = {'act': 'play', 'query': cut(t, q), 'video': True}
    if w:
        lab['where'] = cut(t, w)
    add(t, lab)


def norm(s):
    return ' '.join(w for w in re.split(r'[^\w]+', s.lower()) if w)


stress = {norm(json.loads(l)['text']) for l in open(STRESS)}
seen, out = set(), []
for t, lab in rows:
    n = norm(t)
    if n in stress:
        raise SystemExit(f'refusing: {t!r} is a stress-set line')
    if n in seen:
        continue
    seen.add(n)
    out.append(f'{t}\t{json.dumps(lab, ensure_ascii=False)}')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write('\n'.join(out) + '\n')
counts = {}
for t, lab in rows:
    counts[lab['act']] = counts.get(lab['act'], 0) + 1
print(f'{len(out)} rows → {OUT}', counts)
