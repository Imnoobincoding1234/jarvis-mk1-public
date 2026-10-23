#!/usr/bin/env python3
"""Round 6's hand-written hold file — written 2026-10-10 BEFORE any round-6 training row (he is away on a trek).
    build_round6_valid.py   → data/round6_valid.jsonl

50 lines in his register: 20 `time` (the new act — the clock, here or in a named place), 10 that only MENTION time and are
not it (alarms are `none` — reminders do not ring; his calendar; event times; durations; a song called Time), and 20 of the
shapes round 5 still asked about or missed on the casual dev set (artist + song, Hinglish play, a typo'd play, quiz, slang and
Hinglish messages, "ping X on whatsapp asking about Y", calls, a Hinglish close, a Hinglish search, a Hinglish folder, casual
calendar). Every label passes label_batch.check; no line is an exact or near copy (word Jaccard >= 0.75) of either casual
stress set, the clock lane's held-out or round5_valid.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from label_batch import check  # noqa: E402

T = lambda **k: dict(act='time', **k)
ROWS = [
    # ---- time (20)
    ('ayy what time is it gng', T()), ('kitna baj gaya yaar', T()), ('clock batao jaldi', T()), ('is it past 10 already', T()),
    ('todays date pls bro', T()), ('aaj ki tareekh batao', T()), ('which day is today lol', T()), ('is it saturday or sunday today', T()),
    ('bhai date bata de aaj ki', T()), ('gimme the time quick', T()), ('samay kya ho raha hai', T()), ('bro is it late, whats the clock say', T()),
    ('aaj monday hai na', T()),
    ('time in dubai rn', T(where='dubai')), ('what time is it in new york', T(where='new york')), ('tokyo mein kya time hai', T(where='tokyo')),
    ('is it morning in toronto rn', T(where='toronto')), ('singapore time batao', T(where='singapore')),
    ('whats the time back home in mohali', T(where='mohali')), ('paris mein abhi kitne baje hain', T(where='paris')),
    # ---- mentions time, is not it (10)
    ('wake me up at 6 tmrw', {'act': 'none'}), ('what time does the ipl final start', {'act': 'none'}),
    ('what time is my physics tuition tmrw', {'act': 'calendar', 'when': 'tmrw'}), ('how long till 5 pm', {'act': 'none'}),
    ('i got no time today', {'act': 'none'}), ('remind me at 8 to drink water', {'act': 'remind', 'what': 'drink water', 'when': 'at 8'}),
    ('kitna time lagega maggi banne mein', {'act': 'none'}), ('play time by pink floyd', {'act': 'play', 'query': 'time by pink floyd'}),
    ('when is raksha bandhan this year', {'act': 'none'}), ('date pe jaa raha hoon kal', {'act': 'none'}),
    # ---- the shapes round 5 still asked about or missed (20)
    ('play arijit singh kesariya', {'act': 'play', 'query': 'arijit singh kesariya'}),
    ('Play the weeknd blinding lights', {'act': 'play', 'query': 'the weeknd blinding lights'}),
    ('koi accha sa gaana chala do', {'act': 'play', 'query': 'koi accha sa gaana'}),
    ('plz ply some drake', {'act': 'play', 'query': 'some drake'}),
    ('quiz me on the french revolution', {'act': 'quiz_me', 'topic': 'the french revolution'}),
    ('text aman fr fr we gotta finish the ppt', {'act': 'message', 'to': 'aman', 'body': 'fr fr we gotta finish the ppt'}),
    ('mausi ko msg bhejo kal aa rahe ho kya', {'act': 'message', 'to': 'mausi', 'body': 'kal aa rahe ho kya'}),
    ('ping rohan on whatsapp asking about the physics notes',
     {'act': 'message', 'to': 'rohan', 'body': 'about the physics notes', 'where': 'whatsapp', 'reported': True}),
    ('get kavya on the phone', {'act': 'call', 'to': 'kavya'}),
    ('ring papa on whatsapp quick', {'act': 'call', 'to': 'papa', 'where': 'whatsapp'}),
    ('yo facetime simran', {'act': 'call', 'to': 'simran', 'video': True}),
    ('discord band karo yaar', {'act': 'close', 'thing': 'discord'}),
    ('google pe dekh ipl ka schedule', {'act': 'search_web', 'query': 'ipl ka schedule'}),
    ('downloads mein ek folder bana do notes naam ka', {'act': 'create_folder', 'name': 'notes', 'where': 'downloads'}),
    ('hows tmrw looking for me', {'act': 'calendar', 'when': 'tmrw'}),
    ('anything on at 4', {'act': 'calendar', 'when': 'at 4'}),
    ('search cheap flights to delhi for diwali', {'act': 'search_web', 'query': 'cheap flights to delhi for diwali'}),
    ('whats trending on reddit, search it', {'act': 'search_web', 'query': 'whats trending', 'where': 'reddit'}),
    ('yo open spotify n play some ap dhillon', {'act': 'play', 'query': 'some ap dhillon', 'where': 'spotify'}),
    ('ok call tanya nvm text her instead saying running late', {'act': 'message', 'to': 'tanya', 'body': 'running late'}),
]


def words(s):
    return set(w for w in re.split(r'[^\w]+', s.lower()) if w)


def jac(a, b):
    A, B = words(a), words(b)
    return len(A & B) / (len(A | B) or 1)


others = []
D = os.path.join(HERE, 'data')
for f in ('casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl', 'round5_valid.jsonl'):
    others += [json.loads(l)['text'] for l in open(os.path.join(D, f)) if l.strip()]
c = json.load(open(os.path.join(D, 'clock_heldout.json')))
others += c['clock'] + [z[0] for z in c['zone']] + c['other']
bad = 0
if len({r[0].lower() for r in ROWS}) != len(ROWS):
    print('duplicate inside the set'); bad += 1
for t, lab in ROWS:
    e = check(t, lab)
    if e:
        print('label: %r — %s' % (t, e)); bad += 1
    for o in others:
        if jac(t, o) >= 0.75:
            print('collides: %r ~ %r' % (t, o)); bad += 1
if bad:
    raise SystemExit('%d problem(s) — nothing written' % bad)
with open(os.path.join(D, 'round6_valid.jsonl'), 'w') as f:
    for t, lab in ROWS:
        f.write(json.dumps({'text': t, 'label': lab}, ensure_ascii=False) + '\n')
acts = {}
for _, lab in ROWS:
    acts[lab['act']] = acts.get(lab['act'], 0) + 1
print('wrote data/round6_valid.jsonl — %d lines' % len(ROWS), acts, '; 0 collisions with %d lines' % len(others))
