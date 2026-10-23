#!/usr/bin/env python3
"""Write round 4's synthetic training batches: several requests in one message (`multi`), the look-alikes
that stay ONE reading or `none`, and notes with `write` — in Mihir's texting style (data/style_profile.md).

    gen_round4.py            # writes data/round4_batches/<batch>.tsv
    then (only after round 3 is evaluated): synth_add.py <batch> < data/round4_batches/<batch>.tsv

TRAINING MATERIAL, NOT A RUNTIME LIST. The words below build sentences; nothing in JARVIS reads them. Each
step's label is computed from its own pieces, so every value is an exact substring by construction, and the
checker (label_batch.check, recursive for `multi`) runs again in synth_add.py.
"""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'round4_batches')
rng = random.Random(20260928)
pick = rng.choice

APPS = ['spotify', 'notes', 'whatsapp', 'brave', 'calculator', 'terminal', 'insta', 'youtube', 'yt', 'discord', 'vs code',
        'safari', 'reminders', 'netflix', 'chatgpt', 'gmail', 'github', 'finder', 'maps', 'photos', 'calendar', 'settings']
PEOPLE = ['mama', 'papa', 'bhai', 'didi', 'nanu', 'kunal', 'rehaan', 'ira', 'rohan', 'kabir', 'priya', 'arjun', 'simran',
          'dev', 'riya', 'my sister', 'coach', 'jake', 'emma']
BODIES = ['omw', 'wsg', 'im outside', 'running late', 'call me', 'gn', 'hbu', 'lmk when ur free', 'reached home', 'bring my charger',
          'dinner at 8', 'the plan is off', 'thx', 'ok', 'see u tmrw', 'where u at', 'kal milte hai', 'ghar pahunch gaya']
MUSIC = ['lofi', 'drake', 'arijit singh', 'the weeknd', 'ap dhillon', 'coldplay', 'sad songs', 'gym music', 'starboy', 'kesariya',
         'karan aujla', 'my liked songs', 'travis scott']
VIDS = ['minecraft', 'f1 highlights', 'mrbeast', 'cricket highlights', 'a podcast', 'gym motivation', 'funny cat videos']
WHATS = ['call the dentist', 'drink water', 'charge my phone', 'submit the project', 'take my meds', 'pack my bag', 'go to the gym']
WHENS = ['tmrw', 'at 6', 'in an hour', 'tonight', 'at 7pm', 'in 20 mins', 'on friday']
SEARCH_Q = ['ipl schedule', 'best budget earbuds', 'gta 6 release date', 'ps5 price in india', 'f1 standings', 'cheap flights to goa']
NOTES = ['buy eggs milk bread', 'the wifi password is on the router', 'gym at 6', 'kunal owes me 500', 'call the plumber']
CITIES = ['delhi', 'mumbai', 'shimla', 'nagpur', 'london']


def step():
    """One request: (text, label). Never ends with words a joiner could be mistaken for."""
    k = rng.random()
    if k < 0.20:
        a = pick(APPS); return pick(['open {a}', 'pull up {a}', 'launch {a}', 'fire up {a}', 'open {a} rn']).format(a=a), {'act': 'open', 'thing': a}
    if k < 0.30:
        a = pick(APPS); return pick(['close {a}', 'kill {a}', 'quit {a}', 'shut {a}']).format(a=a), {'act': 'close', 'thing': a}
    if k < 0.42:
        q = pick(MUSIC); return pick(['play {q}', 'throw on {q}', 'put on {q}', 'bump {q}']).format(q=q), {'act': 'play', 'query': q}
    if k < 0.48:
        v = pick(VIDS)
        tpl, where = pick([('play {v} on yt', 'yt'), ('put on {v} on youtube', 'youtube')])
        return tpl.format(v=v), {'act': 'play', 'query': v, 'where': where, 'video': True}
    if k < 0.62:
        to, b = pick(PEOPLE), pick(BODIES)
        return pick(['text {to} {b}', 'text {to} saying {b}', 'dm {to} saying {b}', 'msg {to} {b}', 'tell {to} {b}']).format(to=to, b=b), \
            {'act': 'message', 'to': to, 'body': b}
    if k < 0.68:
        to = pick(PEOPLE)
        tpl, lab = pick([('call {to}', {}), ('ring {to}', {}), ('facetime {to}', {'where': 'facetime', 'video': True})])
        return tpl.format(to=to), dict({'act': 'call', 'to': to}, **lab)
    if k < 0.75:
        w, t = pick(WHATS), pick(WHENS); return 'remind me to {w} {t}'.format(w=w, t=t), {'act': 'remind', 'what': w, 'when': t}
    if k < 0.79:
        return pick(['check the weather', 'hows the weather', 'is it gonna rain']), {'act': 'weather'}
    if k < 0.82:
        c = pick(CITIES); return 'weather in ' + c, {'act': 'weather', 'where': c}
    if k < 0.86:
        q = pick(SEARCH_Q); return pick(['google {q}', 'look up {q}', 'search up {q}']).format(q=q), {'act': 'search_web', 'query': q}
    if k < 0.89:
        c = pick(NOTES); return 'note down ' + c, {'act': 'note', 'content': c}
    if k < 0.92:
        return pick(['check my calendar', 'whats on my calendar']), {'act': 'calendar'}
    if k < 0.95:
        return pick(['take a screenshot', 'screenshot my screen']), {'act': 'screenshot'}
    ctl = pick([('pause the music', 'pause'), ('skip this song', 'next_track'), ('turn it up', 'volume_up'), ('turn it down', 'volume_down')])
    return ctl[0], {'act': ctl[1]}


def step_ok():
    return step()


JOIN = [' and ', ' and then ', ' then ', ' + ', ', ', ', then ', ' after that ', ' also ', ' aur ', ' phir ', ' & ', ' and also ']
LEAD = [''] * 8 + ['yo ', 'ok ', 'jarvis ', 'plz ', 'real quick ', 'bro ', 'Jarvis can you ', 'ok so ']

rows = {}


def add(batch, text, label):
    text = ' '.join(text.split())
    if rng.random() < 0.15:
        text = text[:1].upper() + text[1:]

    def values(l):
        for k, v in l.items():
            if k == 'steps':
                for st in v:
                    yield from values(st)
            elif k != 'act' and isinstance(v, str):
                yield v
    for v in values(label):
        if v.lower() not in text.lower():
            raise SystemExit('generator bug: %r not in %r' % (v, text))
    rows.setdefault(batch, []).append((text, label))


# ---- multi: 2, 3 and 4 independent requests -----------------------------------------------------------------
for n, count in ((2, 650), (3, 150), (4, 35)):
    for _ in range(count):
        steps = [step_ok() for _ in range(n)]
        if len({json.dumps(s[1], sort_keys=True) for s in steps}) < n:
            continue                                            # two identical requests is not a real message
        people = [s[1].get('to') for s in steps if s[1].get('to')]
        if len(people) != len(set(people)):
            continue                                            # the same person twice reads as one request
        # "open X and <use X>" is ONE reading (LABELING.md): opening WhatsApp then messaging, Notes then a note,
        # Spotify/YouTube then playing, anything then searching — never a multi.
        def uses(prev, nxt):
            if prev['act'] != 'open':
                return False
            t = prev['thing']
            return (nxt['act'] == 'message' and t == 'whatsapp') or (nxt['act'] == 'note' and t == 'notes') or \
                   (nxt['act'] == 'play' and t in ('spotify', 'youtube', 'yt', 'netflix')) or nxt['act'] == 'search_web' or \
                   (nxt['act'] == 'calendar' and t == 'calendar') or (nxt['act'] == 'remind' and t == 'reminders')
        if any(uses(steps[i][1], steps[i + 1][1]) for i in range(n - 1)):
            continue
        text = pick(LEAD) + steps[0][0]
        for s in steps[1:]:
            text += pick(JOIN) + s[0]
        add('round4-multi', text, {'act': 'multi', 'steps': [s[1] for s in steps]})

# ---- still ONE reading ------------------------------------------------------------------------------------------
SITES = ['youtube', 'yt', 'spotify', 'netflix']
for _ in range(60):
    site, q = pick(SITES), pick(MUSIC + VIDS)
    tpl = pick(['open {s} and play {q}', 'open {s} and put on {q}', 'go to {s} and play {q}', '{s} kholo aur {q} chala do'])
    lab = {'act': 'play', 'query': q, 'where': site}
    if site in ('youtube', 'yt', 'netflix'):
        lab['video'] = True
    add('round4-single', pick(LEAD) + tpl.format(s=site, q=q), lab)
for _ in range(40):
    site, q = pick(['youtube', 'amazon', 'google', 'yt']), pick(SEARCH_Q)
    add('round4-single', pick(LEAD) + pick(['open {s} and search {q}', 'open {s} and look up {q}']).format(s=site, q=q),
        {'act': 'search_web', 'query': q, 'where': site})
AND_BODIES = ['im at the mall and ill be late', 'dinner is ready and papa is waiting', 'i got home and im tired af',
              'bring chips and coke', 'the match is on and we need u', 'call me and dont forget the charger',
              'im free after 6 and we can go', 'happy bday and have fun', 'thx for today and gn']
for _ in range(80):
    to, b = pick(PEOPLE), pick(AND_BODIES)
    add('round4-single', pick(LEAD) + pick(['text {to} saying {b}', 'tell {to} {b}', 'msg {to} {b}', 'dm {to} saying {b}']).format(to=to, b=b),
        {'act': 'message', 'to': to, 'body': b})
for _ in range(30):
    a, b = rng.sample(MUSIC, 2)
    q = a + pick([' and ', ' & ', ' + ']) + b
    add('round4-single', pick(['play ', 'throw on ', 'queue up ']) + q, {'act': 'play', 'query': q})
for _ in range(30):
    w1, w2 = rng.sample(WHATS, 2)
    w = w1 + ' and ' + w2
    add('round4-single', 'remind me to ' + w, {'act': 'remind', 'what': w})
GREET = ['yo wsg, ', 'wsg gng ', 'hey ', 'thx and ', 'gm, ', 'ok cool, ', 'lol ok ', 'bruh ']
for _ in range(40):
    s = step_ok()
    add('round4-single', pick(GREET) + s[0], s[1])

# ---- stays none: one step works on another's result, a step that is not an act, or too many -------------------
DEP = ['take a screenshot and send it to {to}', 'find my resume and send it to {to}', 'open {a} and click the first video',
       'search for {q} and open the first result', 'google {q} and tell me what it says', 'download the pdf and open it',
       'make a folder called {f} and put a file in it', 'record my screen and send it to {to}', 'find the photo and share it with {to}',
       'open {a} and delete the last one']
for _ in range(60):
    add('round4-none', pick(DEP).format(to=pick(PEOPLE), a=pick(APPS), q=pick(SEARCH_Q), f=pick(['work', 'school', 'pics'])), {'act': 'none'})
QS = ['whats my battery', 'how much ram do i have', 'whats the capital of peru', 'who won the match', 'whats 12 times 12']
for _ in range(30):
    s = step_ok()
    add('round4-none', s[0] + pick([' and ', ', ', ' also ']) + pick(QS), {'act': 'none'})
for _ in range(10):
    ss = [step_ok()[0] for _ in range(5)]
    add('round4-none', ' and '.join(ss), {'act': 'none'})

# ---- notes: write vs keep --------------------------------------------------------------------------------------
TOPICS = ['rain', 'tea', 'the ocean', 'friendship', 'cricket', 'space', 'exams', 'my trip to shimla', 'climate change', 'diwali']
FORMS = ['a passage', 'a paragraph', 'a short poem', 'an essay', 'a few lines', 'a story', 'a haiku', 'something']
for _ in range(70):
    c = pick(FORMS) + ' about ' + pick(TOPICS)
    add('round4-note', pick(LEAD) + pick(['write {c} in notes', 'open notes and write {c}', 'write {c} in my notes',
                                         'notes mein {c} likh do', 'write {c} and save it in notes']).format(c=c),
        {'act': 'note', 'content': c, 'write': True})
for _ in range(50):
    c = pick(NOTES + ['meeting moved to 3pm', 'dentist on the 12th', 'rahul bday 14 march', 'the test is on friday'])
    add('round4-note', pick(LEAD) + pick(['open notes and write {c}', 'write {c} in notes', 'note down {c}', 'jot down {c}',
                                         'put {c} in my notes']).format(c=c), {'act': 'note', 'content': c})

os.makedirs(OUT, exist_ok=True)
seen, total = set(), 0
for batch, rs in rows.items():
    lines = []
    for text, label in rs:
        k = ' '.join(text.lower().split())
        if k in seen:
            continue
        seen.add(k)
        lines.append(text + '\t' + json.dumps(label, ensure_ascii=False))
    with open(os.path.join(OUT, batch + '.tsv'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    total += len(lines)
    print('%-14s %4d' % (batch, len(lines)))
print('total', total)
