#!/usr/bin/env python3
"""Round 7's hand-written hold file — written 2026-10-15 BEFORE any round-7 training row (README "Reader round 7").
    build_round7_valid.py   → data/round7_valid.jsonl

60 lines in his register: 12 with a `when` (the act is scheduled for that time), 8 that mention a time but take no `when` (a time
inside a message body, a length in a query, a reminder, statements), 10 `time`, and 30 of the shapes round 5 misread on the casual
sets (front pages and a reason after the request, Hinglish opens, talk about music that is not a play, Hinglish volume, someone's
news that is not a message, screenshot slang, "close the X app", casual weather and calendar, artist + song). Every label passes
label_batch.check; no line is an exact or near copy (word Jaccard >= 0.75) of any line under finetune/data (training rows, every
casual set, every hold file, the timed and composer held-outs) or of his episodes.
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from label_batch import check  # noqa: E402

N = lambda: {'act': 'none'}
ROWS = [
    # ---- a `when` (12)
    ('open spotify in like 5 mins', {'act': 'open', 'thing': 'spotify', 'when': 'in like 5 mins'}),
    ('close discord after half an hour', {'act': 'close', 'thing': 'discord', 'when': 'after half an hour'}),
    ('play some arijit at 10 tonight', {'act': 'play', 'query': 'some arijit', 'when': 'at 10 tonight'}),
    ('text ira at 8 saying wake up', {'act': 'message', 'to': 'ira', 'body': 'wake up', 'when': 'at 8'}),
    ('in 15 min call papa', {'act': 'call', 'to': 'papa', 'when': 'in 15 min'}),
    ('take a screenshot in 2 mins', {'act': 'screenshot', 'when': 'in 2 mins'}),
    ('20 minute baad youtube khol dena', {'act': 'open', 'thing': 'youtube', 'when': '20 minute baad'}),
    ('raat 11 baje gaana band kar dena', {'act': 'pause', 'when': 'raat 11 baje'}),
    ('kal subah 7 baje bhai ko msg kar dena utho', {'act': 'message', 'to': 'bhai', 'body': 'utho', 'when': 'kal subah 7 baje'}),
    ('pause the music in 40 minutes', {'act': 'pause', 'when': 'in 40 minutes'}),
    ('search the match score at 9 pm', {'act': 'search_web', 'query': 'the match score', 'when': 'at 9 pm'}),
    ('quit chrome in an hour', {'act': 'close', 'thing': 'chrome', 'when': 'in an hour'}),
    # ---- mentions a time, takes no `when` (8)
    ('text mama saying ill reach in 20 mins', {'act': 'message', 'to': 'mama', 'body': 'ill reach in 20 mins'}),
    ('play a 15 minute yoga video', {'act': 'play', 'query': 'a 15 minute yoga', 'video': True}),
    ('remind me in an hour to call nanu', {'act': 'remind', 'what': 'call nanu', 'when': 'in an hour'}),
    ('my bus comes at 7:30', N()),
    ('ill be online in 10 mins', N()),
    ('bhai 5 minute mein aa raha hai', N()),
    ('search 30 minute dinner recipes', {'act': 'search_web', 'query': '30 minute dinner recipes'}),
    ('msg kunal that the movie is at 9', {'act': 'message', 'to': 'kunal', 'body': 'the movie is at 9'}),
    # ---- time (10)
    ('bro clock check, kitne baj gaye', {'act': 'time'}),
    ('which date is it today bro i lost track', {'act': 'time'}),
    ('aaj kaunsi tareekh hai bhai', {'act': 'time'}),
    ('is it thursday today or friday', {'act': 'time'}),
    ('bro which weekday are we on', {'act': 'time'}),
    ('tell me the time real quick', {'act': 'time'}),
    ('samay bata do abhi ka', {'act': 'time'}),
    ('whats the time in sydney', {'act': 'time', 'where': 'sydney'}),
    ('london mein kya baja hai', {'act': 'time', 'where': 'london'}),
    ('bhai aaj kitni tareekh ho gayi', {'act': 'time'}),
    # ---- the misread shapes (30)
    ('open my mail app pls', {'act': 'open', 'thing': 'mail', 'as': 'app'}),
    ('yo get my gmail inbox up on screen', {'act': 'open', 'thing': 'gmail'}),
    ('open youtube i wanna watch something', {'act': 'open', 'thing': 'youtube'}),
    ('open spotify i need music for studying', {'act': 'open', 'thing': 'spotify'}),
    ('open chatgpt i have a question', {'act': 'open', 'thing': 'chatgpt'}),
    ('jaldi se chrome khol', {'act': 'open', 'thing': 'chrome'}),
    ('mera whatsapp khol do zara', {'act': 'open', 'thing': 'whatsapp'}),
    ('open notion i gotta plan my week', {'act': 'open', 'thing': 'notion'}),
    ('this song is fire ngl', N()),
    ('tumhe gaane pasand hain kya', N()),
    ('that beat goes hard', N()),
    ('arijit ki awaaz kitni acchi hai', N()),
    ('who sings starboy', N()),
    ('awaaz thodi kam kar do', {'act': 'volume_down'}),
    ('bahut loud hai, kam karo', {'act': 'volume_down'}),
    ('volume badha de yaar', {'act': 'volume_up'}),
    ('kunal says hello', N()),
    ('mama said hi to you', N()),
    ('chal bye milte hai', N()),
    ('yuvan texted me', N()),
    ('ss my screen', {'act': 'screenshot'}),
    ('capture whatever is on my screen rn', {'act': 'screenshot'}),
    ('close the spotify app', {'act': 'close', 'thing': 'spotify', 'as': 'app'}),
    ('quit the safari app pls', {'act': 'close', 'thing': 'safari', 'as': 'app'}),
    ('is it gonna be hot today', {'act': 'weather', 'when': 'today'}),
    ('aaj bahar dhoop hai ya badal', {'act': 'weather', 'when': 'aaj'}),
    ('whats on my schedule tomorrow', {'act': 'calendar', 'when': 'tomorrow'}),
    ('calendar check kar, kal free hoon kya', {'act': 'calendar', 'when': 'kal'}),
    ('play drake gods plan', {'act': 'play', 'query': 'drake gods plan'}),
    ('put on kesariya by arijit', {'act': 'play', 'query': 'kesariya by arijit'}),
]


def words(s):
    return set(w for w in re.split(r'[^\w]+', str(s).lower()) if w)


def jac(a, b):
    return len(a & b) / (len(a | b) or 1)


def strings(v, out):
    if isinstance(v, str):
        out.append(v)
    elif isinstance(v, dict):
        for x in v.values():
            strings(x, out)
    elif isinstance(v, list):
        for x in v:
            strings(x, out)


D = os.path.join(HERE, 'data')
others = []
for p in glob.glob(os.path.join(D, '**', '*'), recursive=True):
    if os.path.isdir(p) or p.endswith('round7_valid.jsonl') or not re.search(r'\.(jsonl?|txt|csv|tsv)$', p) or os.path.getsize(p) > 200e6:
        continue
    for line in open(p, errors='ignore'):
        vals = []
        try:
            strings(json.loads(line), vals)
        except Exception:
            vals = [line] + line.split('\t')
        others += [v for v in vals if 4 <= len(v) <= 300]
try:
    for ep in json.load(open(os.path.join(HERE, '..', 'jarvis-os', 'state', 'episodes.json'))):
        for k in ('user', 'text', 'q', 'input'):
            if isinstance(ep, dict) and isinstance(ep.get(k), str):
                others.append(ep[k])
except Exception as e:
    print('episodes.json not read:', e)
OW = [(o, words(o)) for o in others]
EX = set(' '.join(sorted(w)) for _, w in OW)
bad = 0
if len({r[0].lower() for r in ROWS}) != len(ROWS):
    print('duplicate inside the set'); bad += 1
for t, lab in ROWS:
    e = check(t, lab)
    if e:
        print('label: %r — %s' % (t, e)); bad += 1
    w = words(t)
    if ' '.join(sorted(w)) in EX:
        print('EXACT: %r' % t); bad += 1; continue
    for o, ow in OW:
        if jac(w, ow) >= 0.75:
            print('NEAR: %r ~ %r' % (t, o[:80])); bad += 1; break
if bad:
    raise SystemExit('%d problem(s) — nothing written' % bad)
with open(os.path.join(D, 'round7_valid.jsonl'), 'w') as f:
    for t, lab in ROWS:
        f.write(json.dumps({'text': t, 'label': lab}, ensure_ascii=False) + '\n')
acts = {}
for _, lab in ROWS:
    acts[lab['act']] = acts.get(lab['act'], 0) + 1
print('wrote data/round7_valid.jsonl — %d lines' % len(ROWS), acts, '; 0 collisions with %d strings' % len(others))
