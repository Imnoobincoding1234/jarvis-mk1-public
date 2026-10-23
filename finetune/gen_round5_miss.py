#!/usr/bin/env python3
"""Round 5's rows for the SHAPES round 4 got wrong or was unsure of — new sentences in Mihir's style, never the failing lines.
    gen_round5_miss.py       # writes data/round5_batches/round5-miss.tsv
    then: synth_add.py round5-miss < data/round5_batches/round5-miss.tsv

Where the shapes come from (2026-10-10, written while he is away): the casual DEV set (casual_stress_heldout.jsonl, v1) run
three times in the sandbox with jarvis-reader-next (finetune/data/casual_runs/dev-20261010-*), plus round 4's own WRONGs on
its --hold files (README "Round 4 chosen"). Those lines are READ, so none is copied: other people, other apps, other words.
The generator refuses any sentence whose normalised text equals a line of EITHER stress set (v1 dev, v2 the judge), and
build_dataset.py --exclude drops near ones on top.

  - messages read right but asked about (confidence 0.47–0.75): "send X a text saying …", "hit up X and ask if …",
    "say gn to X for me", "X ko whatsapp karo …", slang bodies ("wtf was that goal lmao" read at 0.002)   → message, sure
  - "gtg ttyl" read as a message to "ttyl"; "kya chal rha hai aajkal" read as weather                     → none
  - "kill brave its lagging" split into close + a text to brave                                          → ONE close
  - "X band kar do", "get rid of X"                                                                       → close
  - video asks ("X latest vid", "open yt and play some … videos", "youtube pe koi … video laga do")     → play, video
  - "open X and then play Y", "X khol aur Y chala" (one reading by the rules)                             → play, where X
  - "dm X saying … + call Y"; "X band kar aur Y khol" (polarity, round 4's WRONG)                         → multi
  - "yo wsg, open X" (round 4 read "wsg" as the app)                                                      → open X
  - "do i have anything at 5", "hows my day looking"                                                      → calendar
  - "find out when …", "search whats trending on X", "google pe dekh …" (the whole question)             → search_web
  - "how do i get better at X" (advice) beside "teach me X"                                               → none / learn_topic
  - "sry typo i meant open X not Y"                                                                       → open X

TRAINING MATERIAL, NOT A RUNTIME LIST. Nothing in JARVIS reads these words; every value is cut from the sentence it labels,
so it is an exact substring by construction, and synth_add.py re-checks every row.
"""
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'round5_batches', 'round5-miss.tsv')
STRESS = [os.path.join(HERE, 'data', 'casual_stress_heldout.jsonl'), os.path.join(HERE, 'data', 'casual_stress_heldout_v2.jsonl')]
rng = random.Random(20261010)
pick = rng.choice

PEOPLE = ['rohan', 'aman', 'tanya', 'vikram', 'neha', 'ishaan', 'meher', 'jas', 'gurpreet', 'ankit', 'chachu', 'didi', 'kabir',
          'my coach', 'papa', 'mom', 'kavya', 'arnav', 'simran', 'yuvraj', 'my tutor', 'bua', 'mausi', 'karan']
HI_PEOPLE = ['papa', 'didi', 'chachu', 'bua', 'mausi', 'rohan', 'aman', 'gurpreet', 'simran', 'karan']
SLANG = ['wtf was that', 'lmao ur so slow', 'ngl that was fire', 'fr fr', 'bro where r u', 'wya', 'hmu when ur free', 'gym at 6?',
         'bet see u there', 'idk bro', 'gg', 'omw', 'running late srry', 'that movie was mid', 'u up?', 'lets gooo', 'no cap',
         'send the notes pls', 'call me rq', 'happy bday gng']
HI_BODIES = ['main aa raha hoon', 'khana ready hai', 'der ho jayegi', 'kal milte hain', 'notes bhej de', 'kahan ho',
             'ghar pahunch gaya', 'phone utha', 'thodi der mein aata hoon', 'chai peene chalein']
ASK_IF = ['the match is still on', 'hes free tonight', 'she got the tickets', 'we have class tmrw', 'the shop is open',
          'he finished the ppt', 'she reached home', 'the plan is on for sunday']
SHORT = ['gn', 'gm', 'hi', 'thanks', 'sorry', 'congrats', 'happy bday', 'good luck']
APPS = ['discord', 'slack', 'zoom', 'telegram', 'arc', 'safari', 'notes', 'terminal', 'calculator', 'finder', 'mail',
        'photos', 'music', 'preview', 'xcode', 'obsidian', 'figma', 'notion']
HI_APPS = ['chrome', 'safari', 'discord', 'telegram', 'zoom', 'notes', 'terminal', 'slack']
CREATORS = ['technoblade', 'markiplier', 'dhruv rathee', 'sidemen', 'mkbhd', 'fukra insaan', 'tanmay bhat', 'mrwhosetheboss',
            'samay raina', 'beerbiceps', 'linus tech tips', 'veritasium']
TOPICS = ['cooking', 'chess', 'cricket highlights', 'stand up comedy', 'car review', 'cat', 'travel vlog', 'gaming', 'science',
          'football skills']
TRACKS = ['some lofi', 'drake', 'arijit', 'some jazz', 'coldplay', 'the weeknd', 'ap dhillon', 'karan aujla', 'some rain sounds']
SITES = ['twitter', 'reddit', 'youtube', 'instagram', 'amazon', 'flipkart']
QUERIES = ['the next ipl match', 'iphone 17 price in india', 'best budget earbuds', 'how to fix a squeaky fan', 'ps5 restock',
           'jee result date', 'cheap hostels in manali', 'the f1 race time', 'new marvel trailer', 'best laptop for coding']
WHEN = ['the next iphone launches', 'the new pixel ships', 'the cbse results come out', 'the ipl auction is', 'diwali sale starts']
TIMES = ['6', '7 pm', 'noon', '3', '9 tonight', '4:30', '11']
SKILLS = ['chess', 'coding', 'cricket', 'drawing', 'guitar', 'football', 'public speaking', 'typing']
LEARN = ['teach me about black holes', 'teach me organic chemistry', 'help me learn spanish', 'i want to learn about the french revolution',
         'teach me python basics']

rows = []


def add(t, lab):
    rows.append((t, lab))


def cut(t, s):
    i = t.lower().find(s.lower())
    if i < 0:
        raise SystemExit(f'not a substring: {s!r} in {t!r}')
    return t[i:i + len(s)]


# ---- messages, read right but unsure
for _ in range(40):
    p, b = pick(PEOPLE), pick(SLANG)
    t = pick(['send {p} a text saying {b}', 'send {p} a msg saying {b}', 'whatsapp {p} saying {b}', 'text {p} {b}', 'ping {p} {b}',
              'dm {p} saying {b}', 'shoot {p} a text {b}', 'msg {p} on whatsapp saying {b}', 'yo text {p} {b}']).format(p=p, b=b)
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, b)})
for _ in range(16):
    p, b = pick(PEOPLE), pick(ASK_IF)
    t = pick(['hit up {p} and ask if {b}', 'ask {p} if {b}', 'text {p} asking if {b}', 'msg {p} and ask if {b}']).format(p=p, b=b)
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, 'if ' + b), 'reported': True})
for _ in range(14):
    p, b = pick(PEOPLE), pick(SHORT)
    t = pick(['say {b} to {p} for me', 'tell {p} {b}', 'wish {p} {b}' if b in ('good luck', 'happy bday', 'congrats') else 'tell {p} {b}']).format(p=p, b=b)
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, b)})
for _ in range(20):
    p, b = pick(HI_PEOPLE), pick(HI_BODIES)
    t = pick(['{p} ko whatsapp karo {b}', '{p} ko msg kar {b}', '{p} ko text kar de {b}', '{p} ko bol de {b}', '{p} ko message bhejo {b}']).format(p=p, b=b)
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, b)})

# ---- look-alikes that are NOT requests
for t in ['ok gtg bye', 'ttyl gng', 'brb in 5', 'gtg ttyl bro', 'aight ttyl', 'kk bye ttyl', 'g2g talk later',
          'life mein kya chal raha', 'aur kya chal raha', 'kya scene hai aaj kal', 'sab badhiya chal raha?', 'kya haal chaal hai',
          'whats new with u lately', 'hows life going']:
    add(t, {'act': 'none'})
for s in SKILLS:
    t = pick(['any tips to improve at {s}', 'how can i get good at {s}', 'whats the best way to practice {s}']).format(s=s)
    add(t, {'act': 'none'})
for t in LEARN:
    topic = re.sub(r'^(teach me about |teach me |help me learn |i want to learn about )', '', t)
    add(t, {'act': 'learn_topic', 'topic': cut(t, topic)})

# ---- closes
for _ in range(16):
    a = pick(APPS)
    t, th = pick([('kill {a} its lagging', '{a}'), ('get rid of {a}', '{a}'), ('shut {a} down', '{a}'), ('close {a} its so slow', '{a}'),
                  ('quit {a} pls', '{a}'), ('{a} is frozen, close it', '{a}')])
    t, th = t.format(a=a), th.format(a=a)
    add(t, {'act': 'close', 'thing': cut(t, th)})
for _ in range(10):
    a = pick(HI_APPS)
    t = pick(['{a} band kar do', '{a} band karo', '{a} ko band kar', '{a} band kar de yaar']).format(a=a)
    add(t, {'act': 'close', 'thing': cut(t, a)})

# ---- videos
for _ in range(16):
    c = pick(CREATORS)
    t, q = pick([('play {c} latest vid', '{c} latest vid'), ('put on the newest {c} video', 'the newest {c} video'),
                 ('watch {c} new upload', '{c} new upload'), ('{c} ka latest video chala do', '{c} ka latest video')])
    t, q = t.format(c=c), q.format(c=c)
    add(t, {'act': 'play', 'query': cut(t, q), 'video': True})
for _ in range(12):
    x = pick(TOPICS)
    t, q, w = pick([('open yt and play some {x} videos', 'some {x} videos', 'yt'), ('put on a {x} podcast on youtube', 'a {x} podcast', 'youtube'),
                    ('play a {x} video on youtube', 'a {x} video', 'youtube'), ('youtube pe koi {x} video laga do', 'koi {x} video', 'youtube')])
    t, q, w = t.format(x=x), q.format(x=x), w
    add(t, {'act': 'play', 'query': cut(t, q), 'where': cut(t, w), 'video': True})

# ---- "open X and then play Y" is ONE reading
for _ in range(12):
    tr = pick(TRACKS)
    t, w = pick([('pull up spotify and play {tr}', 'spotify'), ('open youtube and play {tr}', 'youtube'), ('spotify khol aur {tr} chala', 'spotify'),
                 ('youtube khol ke {tr} laga', 'youtube')])
    t = t.format(tr=tr)
    lab = {'act': 'play', 'query': cut(t, tr), 'where': cut(t, w)}
    if w == 'youtube':
        lab['video'] = True
    add(t, lab)

# ---- several requests in one message (round 4's WRONG: the polarity of "band kar aur … khol")
for _ in range(10):
    a, b = rng.sample(HI_APPS, 2)
    t = pick(['{a} band kar aur {b} khol', '{a} band karo aur {b} kholo', '{a} band kar de phir {b} khol de']).format(a=a, b=b)
    add(t, {'act': 'multi', 'steps': [{'act': 'close', 'thing': cut(t, a)}, {'act': 'open', 'thing': cut(t, b)}]})
for _ in range(10):
    p, b, q = pick(PEOPLE), pick(SLANG), pick(PEOPLE)
    if p == q:
        continue
    t = pick(['dm {p} saying {b} + call {q}', 'text {p} {b} and then call {q}', 'msg {p} saying {b} then ring {q}']).format(p=p, b=b, q=q)
    add(t, {'act': 'multi', 'steps': [{'act': 'message', 'to': cut(t, p), 'body': cut(t, b)}, {'act': 'call', 'to': cut(t, q)}]})

# ---- a greeting before the ask is not part of it
for _ in range(14):
    a = pick(APPS)
    t = pick(['yo wsg, open {a}', 'hey jarvis open {a}', 'wsg gng open {a} rq', 'gm, open {a}', 'yo hyd, pull up {a}', 'sup, launch {a}']).format(a=a)
    add(t, {'act': 'open', 'thing': cut(t, a)})

# ---- calendar
for _ in range(10):
    tm = pick(TIMES)
    t, w = pick([('do i have anything at {tm}', 'at {tm}'), ('am i busy at {tm}', 'at {tm}'), ('anything on my calendar at {tm}', 'at {tm}'),
                 ('am i free at {tm} today', 'at {tm} today')])
    t, w = t.format(tm=tm), w.format(tm=tm)
    add(t, {'act': 'calendar', 'when': cut(t, w)})
for t in ['how does my week look', 'whats my day like', 'is my evening free', 'how packed is tmrw']:
    lab = {'act': 'calendar'}
    for w in ['day', 'week', 'evening', 'tmrw']:
        if w in t:
            lab['when'] = cut(t, w)
            break
    add(t, lab)

# ---- searches: the whole question is the query
for _ in range(12):
    w = pick(WHEN)
    t = pick(['find out when {w}', 'look up when {w}', 'check when {w}', 'can u see when {w}']).format(w=w)
    add(t, {'act': 'search_web', 'query': cut(t, 'when ' + w)})
for _ in range(8):
    s = pick(SITES)
    t = pick(['search whats trending on {s}', 'look up whats hot on {s} rn', 'check whats trending on {s}']).format(s=s)
    q = 'whats trending' if 'trending' in t else 'whats hot'
    add(t, {'act': 'search_web', 'query': cut(t, q), 'where': cut(t, s)})
for _ in range(10):
    q = pick(QUERIES)
    t = pick(['google pe dekh {q}', 'google kar {q}', 'search up {q}', 'look up {q} for me', 'google {q} quick']).format(q=q)
    add(t, {'act': 'search_web', 'query': cut(t, q)})

# ---- a correction names the app he meant
for _ in range(10):
    a, b = rng.sample(APPS, 2)
    t = pick(['sry typo i meant open {a} not {b}', 'no i meant open {a} not {b}', 'my bad, open {a} not {b}']).format(a=a, b=b)
    add(t, {'act': 'open', 'thing': cut(t, a)})


def norm(s):
    return ' '.join(w for w in re.split(r'[^\w]+', s.lower()) if w)


stress = set()
for f in STRESS:
    for l in open(f):
        stress.add(norm(json.loads(l)['text']))
seen, out, hit = set(), [], []
for t, lab in rows:
    n = norm(t)
    if n in stress:
        hit.append(t)
        continue
    if n in seen:
        continue
    seen.add(n)
    out.append(f'{t}\t{json.dumps(lab, ensure_ascii=False)}')
if hit:
    raise SystemExit('refusing — stress-set lines: ' + ', '.join(sorted(set(hit))))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write('\n'.join(out) + '\n')
counts = {}
for line in out:
    a = json.loads(line.split('\t')[1])['act']
    counts[a] = counts.get(a, 0) + 1
print(f'{len(out)} rows → {OUT}', counts)
