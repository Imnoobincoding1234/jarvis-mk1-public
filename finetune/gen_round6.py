#!/usr/bin/env python3
"""Round 6's rows — the `time` act, and the shapes round 5 still asked about or missed. New sentences in Mihir's style.
    gen_round6.py       # writes data/round6_batches/round6.tsv
    then: synth_add.py round6 < data/round6_batches/round6.tsv

Pre-registered in README "Reader round 6" (2026-10-10, written while he is away, before this file). The hold file
data/round6_valid.jsonl and the clock held-out were written first; this generator REFUSES an exact copy of any line of either
casual stress set, the clock held-out, round5_valid or round6_valid, and DROPS near copies (word Jaccard >= 0.75), counting them.

  - `time` here: the time, the date, the day, a yes/no about the day or the hour, EN and Hinglish, his fillers   → time
  - `time` in a place: "time in X", "X mein kya time hai", "is it night in X"                                    → time, where X
  - mentions time but is not it: alarms/timers → none; "remind me at 8 to …" → remind; his schedule → calendar;
    event times, festivals, durations, chat, someone's family time → none; a song called Time → play
  - round 5's remaining asks on the dev set: artist + song, Hinglish play, typo'd play, quiz, slang/Hinglish messages,
    "ping X on whatsapp asking about Y", calls ("get X on the phone", "ring X on whatsapp", "facetime X"), Hinglish
    close/search/folder, casual calendar, "call X nvm text her instead saying Y"

TRAINING MATERIAL, NOT A RUNTIME LIST. Nothing in JARVIS reads these words; every value is cut from the sentence it labels,
so it is an exact substring by construction, and synth_add.py re-checks every row.
"""
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'data')
OUT = os.path.join(D, 'round6_batches', 'round6.tsv')
rng = random.Random(20261011)
pick = rng.choice

FILL_PRE = ['', '', '', 'yo ', 'bro ', 'ayy ', 'hey jarvis ', 'ok ', 'oye ', 'jarvis ']
FILL_POST = ['', '', '', ' rq', ' pls', ' gng', ' bro', ' yaar', ' lol', ' fr', ' quick', ' bhai']
DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
HOURS = ['9', '10', '11', 'midnight', '6', '7', '8', 'noon']
CITIES = ['london', 'berlin', 'sydney', 'chicago', 'moscow', 'seoul', 'hong kong', 'bangkok', 'cairo', 'nairobi', 'vancouver',
          'auckland', 'kathmandu', 'dubai', 'los angeles', 'mexico city', 'lisbon', 'istanbul', 'jakarta', 'manila', 'california',
          'canada', 'the uk', 'dhaka', 'karachi', 'riyadh', 'amsterdam', 'zurich', 'melbourne', 'denver']
PEOPLE = ['tanya', 'vikram', 'ishaan', 'meher', 'jas', 'gurpreet', 'ankit', 'chachu', 'kabir', 'arnav', 'yuvraj', 'karan',
          'neha', 'kavya', 'my coach', 'bua', 'mausi', 'sahil', 'riya', 'dev']
HI_PEOPLE = ['chachu', 'bua', 'mausi', 'didi', 'bhaiya', 'gurpreet', 'karan', 'riya', 'sahil', 'papa']
ARTISTS = [('arijit singh', 'tum hi ho'), ('the weeknd', 'starboy'), ('taylor swift', 'cruel summer'), ('ap dhillon', 'brown munde'),
           ('karan aujla', 'softly'), ('coldplay', 'yellow'), ('drake', 'gods plan'), ('billie eilish', 'birds of a feather'),
           ('diljit dosanjh', 'lover'), ('eminem', 'lose yourself'), ('dua lipa', 'levitating'), ('rehaan moosewala', '295'),
           ('linkin park', 'numb'), ('pritam', 'kesariya'), ('bruno mars', 'die with a smile')]
MOODS = ['mast', 'accha', 'chill', 'sad', 'party wala', 'purana', 'romantic', 'dhamakedar']
TOPICS = ['photosynthesis', 'the cold war', 'trigonometry', 'the periodic table', 'world war 1', 'organic chemistry', 'indian history',
          'newtons laws', 'the human heart', 'french vocab']
SLANG = ['fr fr we gotta finish the project', 'bro where r u', 'wya', 'hmu when ur free', 'running late srry', 'u up?', 'lets gooo',
         'no cap that was fire', 'send the notes pls', 'gg ez', 'omw', 'idk bro ask sir']
HI_BODIES = ['kal aa rahe ho kya', 'khana kha liya?', 'main late ho jaunga', 'notes bhej do', 'kahan ho abhi', 'phone kyu nahi utha rahe',
             'ghar kab aaoge', 'match dekh rahe ho?']
ABOUT = ['the chem assignment', 'the maths hw', 'tmrws plan', 'the bio notes', 'the ppt', 'the trip', 'the party', 'the test syllabus']
APPS = ['discord', 'slack', 'zoom', 'telegram', 'safari', 'notes', 'spotify', 'chrome', 'whatsapp', 'teams']
QUERIES = ['ipl points table', 'aaj ka sensex', 'cheap flights to goa', 'best phone under 20k', 'jee mains date', 'new bollywood movies',
           'how to make cold coffee', 'f1 schedule']
PLACES = [('desktop', 'pe'), ('downloads', 'mein'), ('documents', 'mein')]
FOLDERS = ['school', 'photos', 'projects', 'old stuff', 'assignments', 'music']
EVENTS = ['physics tuition', 'dentist appointment', 'football practice', 'maths class', 'meeting', 'chem lab']
WHENS = ['tmrw', 'today', 'on friday', 'this evening', 'kal', 'tonight']

rows = []


def add(t, lab):
    rows.append((t, lab))


def cut(t, s):
    i = t.lower().find(s.lower())
    if i < 0:
        raise SystemExit(f'not a substring: {s!r} in {t!r}')
    return t[i:i + len(s)]


def f(s):
    return (pick(FILL_PRE) + s + pick(FILL_POST)).strip()


# ---- time, here (EN + Hinglish)
HERE_T = ['what time is it', 'whats the time', 'time?? ', 'tell me the time', 'whats the time rn', 'time check', 'whats the clock saying',
          'current time', 'what time is it now', 'time kya hua hai', 'kitne baj gaye', 'abhi kya time hai', 'time bata do', 'kitna baja hai',
          'whats the date', 'what date is it today', 'which date is it', 'todays date?', 'aaj kya tareekh hai', 'aaj date kya hai',
          'date bata do', 'what day is it', 'which day is it today', 'aaj kaunsa din hai', 'what day of the week is it',
          'is it late rn', 'how late is it', 'kitni der ho gayi, time kya hai']
for _ in range(44):
    add(f(pick(HERE_T)).replace('?? ', '??'), {'act': 'time'})
for _ in range(14):
    d = pick(DAYS)
    add(f(pick(['is it {d} today', 'its {d} right', 'aaj {d} hai kya', 'is today {d}', 'wait is it {d}']).format(d=d)), {'act': 'time'})
for _ in range(8):
    h = pick(HOURS)
    add(f(pick(['is it past {h} yet', 'is it {h} already', 'has it hit {h}', 'kya {h} baj gaye']).format(h=h)), {'act': 'time'})

# ---- time, in a place
for _ in range(40):
    c = pick(CITIES)
    t = f(pick(['whats the time in {c}', 'time in {c} rn', 'what time is it in {c}', '{c} mein kya time hua', 'is it night in {c} rn',
                '{c} ka time batao', 'what time is it over in {c}', '{c} mein abhi kitne baje hain', 'current time in {c}',
                'is it morning in {c}']).format(c=c))
    add(t, {'act': 'time', 'where': cut(t, c)})

# ---- mentions time, is not it
for _ in range(10):
    h = pick(['6', '7', '5:30', '8', '6 am'])
    add(f(pick(['wake me up at {h}', 'set an alarm for {h}', 'alarm laga do {h} baje ka', 'timer for {m} min', 'start a {m} min timer'])
          .format(h=h, m=pick(['5', '10', '20', '25']))), {'act': 'none'})
for _ in range(8):
    h, x = pick(['8', '9 pm', '6', '4']), pick(['drink water', 'call nanu', 'study chem', 'take my meds', 'pack my bag'])
    t = f(pick(['remind me at {h} to {x}', 'lmk at {h} to {x}']).format(h=h, x=x))
    add(t, {'act': 'remind', 'what': cut(t, x), 'when': cut(t, 'at ' + h)})
for _ in range(10):
    e, w = pick(EVENTS), pick(WHENS)
    t = f(pick(['what time is my {e} {w}', 'when is my {e} {w}', '{w} {e} kitne baje hai']).format(e=e, w=w))
    add(t, {'act': 'calendar', 'when': cut(t, w)})
for _ in range(10):
    add(f(pick(['what time does the {x} start', 'when does the {x} begin', '{x} kitne baje shuru hoga'])
          .format(x=pick(['ipl match', 'f1 race', 'india game', 'new episode', 'concert', 'sale', 'eclipse']))), {'act': 'none'})
for t in ['when is diwali this year', 'when is holi', 'when is eid this year', 'when is christmas break', 'kab hai lohri']:
    add(f(t), {'act': 'none'})
for _ in range(10):
    add(f(pick(['how long till {h}', 'how many hours till {h}', 'how long does it take to {x}', 'kitna time lagega {y}'])
          .format(h=pick(['6 pm', 'midnight', 'my exam', 'the weekend']), x=pick(['boil rice', 'reach delhi', 'charge my phone']),
                  y=pick(['ghar pahunchne mein', 'chai banne mein', 'download hone mein']))), {'act': 'none'})
for t in ['no time rn sorry', 'took u long enough', 'good times man', 'time pass kar rahe hain', 'i wasted so much time today',
          'every time bro', 'time hi nahi milta', 'last time was better', 'long time no see']:
    add(t, {'act': 'none'})
for t in ['what time is it for my mom', 'is it too late to call my mom', 'what time is it where mama is']:
    add(t, {'act': 'none'})
for _ in range(5):
    s = pick(['time by hans zimmer', 'time after time', 'time of our lives', 'the times they are a changin'])
    t = f(pick(['play {s}', 'put on {s}', '{s} chala do']).format(s=s))
    add(t, {'act': 'play', 'query': cut(t, s)})

# ---- round 5's remaining asks
for _ in range(16):
    a, s = pick(ARTISTS)
    q = pick(['{a} {s}', '{s} by {a}', '{s} {a}']).format(a=a, s=s)
    t = f(pick(['play {q}', 'put on {q}', 'Play {q}', '{q} chala do', 'can u play {q}']).format(q=q))
    add(t, {'act': 'play', 'query': cut(t, q)})
for _ in range(10):
    m = pick(MOODS)
    q = pick(['koi {m} gaana', 'koi {m} sa gaana', 'kuch {m} gaane']).format(m=m)
    t = f(pick(['{q} chala do', '{q} laga de', '{q} bajao', '{q} sunao']).format(q=q))
    add(t, {'act': 'play', 'query': cut(t, q)})
for _ in range(8):
    q = pick(['some lofi', 'some drake', 'arijit', 'some old songs', 'the weeknd', 'some marathi music'])
    t = f(pick(['ply {q}', 'pls ply {q}', 'plya {q}', 'pley {q}']).format(q=q))
    add(t, {'act': 'play', 'query': cut(t, q)})
for _ in range(10):
    tp = pick(TOPICS)
    t = f(pick(['quiz me on {tp}', 'test me on {tp}', 'ask me questions on {tp}', '{tp} pe quiz lo', 'gimme a quiz on {tp}']).format(tp=tp))
    add(t, {'act': 'quiz_me', 'topic': cut(t, tp)})
for _ in range(12):
    p, b = pick(PEOPLE), pick(SLANG)
    t = f(pick(['text {p} {b}', 'yo text {p} {b}', 'msg {p} {b}', 'dm {p} {b}']).format(p=p, b=b))
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, b)})
for _ in range(12):
    p, b = pick(HI_PEOPLE), pick(HI_BODIES)
    t = f(pick(['{p} ko msg bhejo {b}', '{p} ko bolo {b}', '{p} ko whatsapp pe likh do {b}', '{p} ko text kar {b}']).format(p=p, b=b))
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, b)})
for _ in range(14):
    p, x = pick(PEOPLE), pick(ABOUT)
    w = pick(['whatsapp', 'insta', 'imessage'])
    t = f(pick(['ping {p} on {w} asking about {x}', 'hit {p} up on {w} asking about {x}', 'msg {p} on {w} asking about {x}']).format(p=p, w=w, x=x))
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, 'about ' + x), 'where': cut(t, w), 'reported': True})
for _ in range(14):
    p = pick(PEOPLE)
    form = pick(['get {p} on the phone', 'ring {p} on whatsapp', 'can u call {p} on whatsapp', 'yo facetime {p}', 'facetime {p} rn',
                 'give {p} a ring', '{p} ko call lagao'])
    t = f(form.format(p=p))
    lab = {'act': 'call', 'to': cut(t, p)}
    if 'whatsapp' in form:
        lab['where'] = cut(t, 'whatsapp')
    if 'facetime' in form:
        lab['video'] = True
    add(t, lab)
for _ in range(8):
    a = pick(APPS)
    t = f(pick(['{a} band karo yaar', '{a} band kar do', '{a} ko band kar de']).format(a=a))
    add(t, {'act': 'close', 'thing': cut(t, a)})
for _ in range(8):
    q = pick(QUERIES)
    t = f(pick(['google pe dekh {q}', 'google karke bata {q}', 'google pe search kar {q}']).format(q=q))
    add(t, {'act': 'search_web', 'query': cut(t, q)})
for _ in range(8):
    (pl, prep), n = pick(PLACES), pick(FOLDERS)
    t = f(pick(['{pl} {prep} ek folder bana do {n} naam ka', '{pl} {prep} {n} naam ka folder bana do']).format(pl=pl, prep=prep, n=n))
    add(t, {'act': 'create_folder', 'name': cut(t, n), 'where': cut(t, pl)})
for _ in range(12):
    w = pick(['tmrw', 'today', 'friday', 'the weekend', 'tonight', 'kal'])
    form = pick(['hows {w} looking', 'hows my {w} looking', 'do i have stuff {w}', 'anything planned {w}', '{w} ka schedule kya hai',
                 'is {w} free'])
    t = f(form.format(w=w))
    add(t, {'act': 'calendar', 'when': cut(t, w)})
for _ in range(6):
    h = pick(['3', '5', '6:30', '11'])
    t = f(pick(['anything on at {h}', 'do i have smth at {h}', 'kuch hai kya {h} baje']).format(h=h))
    add(t, {'act': 'calendar', 'when': cut(t, h if 'baje' in t else 'at ' + h)})
for _ in range(8):
    p, b = pick(PEOPLE), pick(['running late', 'im busy', 'call u later', 'cant talk rn', 'in class'])
    t = f(pick(['ok call {p} nvm text instead saying {b}', 'call {p}, no wait text them saying {b}', 'nvm dont call {p} just text {b}'])
          .format(p=p, b=b))
    add(t, {'act': 'message', 'to': cut(t, p), 'body': cut(t, b)})


def norm(s):
    return ' '.join(w for w in re.split(r'[^\w]+', s.lower()) if w)


def words(s):
    return set(norm(s).split())


protected = []
for fn in ('casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl', 'round5_valid.jsonl', 'round6_valid.jsonl'):
    protected += [json.loads(l)['text'] for l in open(os.path.join(D, fn)) if l.strip()]
c = json.load(open(os.path.join(D, 'clock_heldout.json')))
protected += c['clock'] + [z[0] for z in c['zone']] + c['other']
pnorm = {norm(t) for t in protected}
pwords = [words(t) for t in protected]
seen, out, hit, near = set(), [], [], 0
for t, lab in rows:
    n = norm(t)
    if n in pnorm:
        hit.append(t)
        continue
    if n in seen:
        continue
    W = words(t)
    if any(len(W & P) / (len(W | P) or 1) >= 0.75 for P in pwords):
        near += 1
        continue
    seen.add(n)
    out.append(f'{t}\t{json.dumps(lab, ensure_ascii=False)}')
if hit:
    raise SystemExit('refusing — protected lines: ' + ', '.join(sorted(set(hit))))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write('\n'.join(out) + '\n')
counts = {}
for line in out:
    a = json.loads(line.split('\t')[1])['act']
    counts[a] = counts.get(a, 0) + 1
print(f'{len(out)} rows → {OUT} (near copies dropped: {near})', counts)
