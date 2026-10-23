#!/usr/bin/env python3
"""Write round 3's synthetic training batches in Mihir's texting style (data/style_profile.md).

    gen_round3.py            # writes data/round3_batches/<batch>.tsv, one "<message>\\t<label json>" per line
    then: synth_add.py <batch> < data/round3_batches/<batch>.tsv

TRAINING MATERIAL, NOT A RUNTIME LIST. The words below are what the sentences are built from; nothing in
JARVIS reads them. Labels are computed from the pieces, so every value is an exact substring by
construction (synth_add.py checks again). The stress set is never consulted here; build_dataset.py
--exclude drops any sentence near one of its lines.
"""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'round3_batches')
rng = random.Random(20260927)
pick = rng.choice

# ---- people, as he names them ------------------------------------------------------------------------
PEOPLE = ['mama', 'mom', 'mummy', 'papa', 'dad', 'bhai', 'mera bhai', 'didi', 'nanu', 'nani', 'chachu', 'kunal', 'ira',
          'rehaan', 'yuvan', 'jivanjot', 'aaditesh', 'samanvay', 'aditi', 'rohan', 'kabir', 'ananya', 'priya', 'arjun',
          'vikram', 'simran', 'jas', 'manav', 'riya', 'ishaan', 'tanvi', 'dev', 'noor', 'aarav', 'meher', 'singh ji', 'sir',
          'coach', 'jake', 'emma', 'liam', 'sophia', 'noah', 'mia', 'lucas', 'zoe', 'my sister', 'my bro', 'my friend rahul']
H_PEOPLE = ['mama', 'papa', 'bhai', 'didi', 'nanu', 'nani', 'kunal', 'rehaan', 'simran', 'rohan', 'chachu', 'mummy']

# ---- what he says in a message (direct) and what he asks (indirect → reported) -----------------------
BODIES = ['wsg', 'wsg gng', 'hyd', 'gn', 'gm', 'wyd', 'hbu', 'omw', 'otw', 'brb', 'ttyl', 'lmk when ur free', 'im outside',
          'im running late', 'running 10 min late', 'call me when u can', 'call me asap', 'ngl that was fire', 'happy bday',
          'happy bday gng', 'love u', 'miss u', 'thx', 'thanks for today', 'np', 'ok', 'kk', 'bet', 'fr', 'lol ok', 'where u at',
          'wya', 'reached home', 'reached safe', 'bring my charger', 'dinner at 8', 'im free now', 'cant talk rn', 'sry missed ur call',
          'the plan is off', 'the plan is still on', 'u up?', 'check ur dms', 'gg', 'congrats bro', 'good luck for the test',
          'see u tmrw', 'ill be there in 5', 'dont wait up', 'save me a seat', 'hmu later', 'the site is live', 'lets go',
          'on my way', 'call u back in 10', 'wtf was that goal', 'sounds good', 'yessir', 'all good', 'im home']
H_BODIES = ['main late aaunga', 'kya scene hai', 'kal milte hai', 'khana kha liya', 'ghar pahunch gaya', 'thodi der mein aata hu',
            'call kar mujhe', 'kaise ho', 'notes bhej de', 'charger le aana', 'aaj nahi aa paunga', 'sab theek hai',
            'dinner ready hai kya', 'kahan ho', 'bas nikal raha hu']
ASKS = ['if hes coming tonight', 'if shes free', 'how shes doing', 'how hes feeling', 'when dinner is', 'what time dinner is',
        'if she needs anything from the store', 'whether the plan is still on', 'where the party is', 'if he got the notes',
        'about the project', 'about the maths hw', 'about her health', 'if hes up', 'when hes back', 'if they reached',
        'what the wifi password is', 'if the match is on', 'how the test went', 'if we have class tmrw', 'about the trip',
        'why he didnt pick up', 'if she ate', 'where he kept my charger']
H_ASKS = ['kya kar raha hai', 'khana khaya ya nahi', 'kab aayega', 'kal class hai kya', 'kitne baje aana hai']

FILLERS = [''] * 50 + ['yo ', 'ok ', 'ok so ', 'eh ', 'btw ', 'hey jarvis ', 'jarvis ', 'can u ', 'plz ',
           'eh let it be, just ', 'nvm ', 'nvm that, ', 'wait ', 'real quick ', 'lowkey just ', 'bro ', 'bruh ', 'yo jarvis ',
           'ok all good, now ', 'Jarvis can you ', 'hmm ', 'aight ', 'wtf nvm, ', 'forget that, ', 'ok cool, ']
H_FILLERS = [''] * 12 + ['yaar ', 'bhai ', 'arre ', 'chal ', 'sun ', 'accha ', 'chhod, ']


def style(s):
    """His casing: mostly lowercase, some capitalised first word, a few typed with a capital acronym."""
    r = rng.random()
    if r < 0.18:
        return s[:1].upper() + s[1:]
    return s


rows = {}


def add(batch, text, label):
    text = ' '.join(style(text).split())
    for k, v in label.items():
        if k != 'act' and isinstance(v, str) and v.lower() not in text.lower():
            raise SystemExit('generator bug: %r not in %r' % (v, text))
    rows.setdefault(batch, []).append((text, label))


# ---- message ---------------------------------------------------------------------------------------------
MSG_DIRECT = ['text {to} {b}', 'text {to} saying {b}', 'msg {to} {b}', 'msg {to} saying {b}', 'dm {to} {b}', 'DM {to} saying {b}',
              'whatsapp {to} {b}', 'whatsapp {to} saying {b}', 'send {to} a msg saying {b}', 'send {to} a text saying {b}',
              'shoot {to} a text saying {b}', 'drop {to} a msg saying {b}', 'tell {to} {b}', 'tell {to} that {b}',
              'let {to} know {b}', 'message {to} {b}', 'message {to} saying {b}', 'text {to} on whatsapp saying {b}',
              'send a msg to {to} saying {b}', 'say {b} to {to}', 'send {b} to {to}', 'txt {to} {b}', 'hit up {to} saying {b}',
              'ping {to} saying {b}', 'text {to} rn saying {b}', 'can u text {to} saying {b}']
MSG_WHERE = [('imessage {to} saying {b}', 'imessage'), ('text {to} on imessage saying {b}', 'imessage'),
             ('message {to} on whatsapp saying {b}', 'whatsapp'), ('whatsapp message {to} saying {b}', 'whatsapp'),
             ('send {to} a whatsapp saying {b}', 'whatsapp'), ('dm {to} on insta saying {b}', 'insta')]
MSG_ASK = ['text {to} asking {a}', 'msg {to} asking {a}', 'dm {to} asking {a}', 'ask {to} {a}', 'whatsapp {to} asking {a}',
           'message {to} asking {a}', 'hit up {to} and ask {a}', 'send {to} a msg asking {a}', 'ping {to} asking {a}',
           'text {to} and ask {a}', 'can u ask {to} {a}']
MSG_BARE = ['text {to}', 'msg {to}', 'message {to}', 'dm {to}', 'whatsapp {to}', 'send {to} a msg', 'text {to} rq']
H_MSG = ['{to} ko msg kar do {b}', '{to} ko msg kar do ki {b}', '{to} ko whatsapp karo {b}', '{to} ko bol do {b}',
         '{to} ko text kar ki {b}', '{to} ko message bhejo {b}', '{to} ko bata do ki {b}', '{to} ko msg bhej {b}']
H_ASK = ['{to} se puchho {a}', '{to} ko msg karke puchh {a}', '{to} ko whatsapp pe puchho {a}']

for _ in range(210):
    to, b, f = pick(PEOPLE), pick(BODIES), pick(FILLERS)
    t = pick(MSG_DIRECT).format(to=to, b=b)
    add('round3-msg', f + t, {'act': 'message', 'to': to, 'body': b})
for _ in range(40):
    to, b, f = pick(PEOPLE), pick(BODIES), pick(FILLERS)
    tpl, w = pick(MSG_WHERE)
    add('round3-msg', f + tpl.format(to=to, b=b), {'act': 'message', 'to': to, 'body': b, 'where': w})
for _ in range(110):
    to, a, f = pick(PEOPLE), pick(ASKS), pick(FILLERS)
    add('round3-msg', f + pick(MSG_ASK).format(to=to, a=a), {'act': 'message', 'to': to, 'body': a, 'reported': True})
for _ in range(20):
    to, f = pick(PEOPLE), pick(FILLERS)
    add('round3-msg', f + pick(MSG_BARE).format(to=to), {'act': 'message', 'to': to})
for _ in range(70):
    to, b, f = pick(H_PEOPLE), pick(H_BODIES + BODIES[:10]), pick(H_FILLERS)
    add('round3-msg', f + pick(H_MSG).format(to=to, b=b), {'act': 'message', 'to': to, 'body': b})
for _ in range(20):
    to, a, f = pick(H_PEOPLE), pick(H_ASKS), pick(H_FILLERS)
    add('round3-msg', f + pick(H_ASK).format(to=to, a=a), {'act': 'message', 'to': to, 'body': a, 'reported': True})

# ---- call ------------------------------------------------------------------------------------------------
CALL = ['call {to}', 'ring {to}', 'phone {to}', 'give {to} a call', 'get {to} on the phone', 'hop on a call w {to}',
        'hop on a call with {to}', 'can u call {to}', 'call {to} rq', 'call {to} rn', 'voice call {to}', 'gimme a call with {to}',
        'call {to} real quick', 'yo call {to}', 'dial {to}']
CALL_W = [('call {to} on whatsapp', 'whatsapp', False), ('whatsapp call {to}', 'whatsapp', False), ('ring {to} on whatsapp', 'whatsapp', False),
          ('facetime {to}', 'facetime', True), ('facetime {to} rq', 'facetime', True), ('video call {to} on whatsapp', 'whatsapp', True)]
CALL_V = ['video call {to}', 'vc {to}', 'video call {to} plz']
H_CALL = ['{to} ko call karo', '{to} ko call lagao', '{to} ko phone kar', '{to} ko call kar de', '{to} ko phone lagao yaar']
H_CALL_V = ['{to} ko video call karo', '{to} ko vc kar']
for _ in range(80):
    to, f = pick(PEOPLE), pick(FILLERS)
    add('round3-call', f + pick(CALL).format(to=to), {'act': 'call', 'to': to})
for _ in range(30):
    to, f = pick(PEOPLE), pick(FILLERS)
    tpl, w, v = pick(CALL_W)
    lab = {'act': 'call', 'to': to, 'where': w}
    if v:
        lab['video'] = True
    add('round3-call', f + tpl.format(to=to), lab)
for _ in range(15):
    to, f = pick(PEOPLE), pick(FILLERS)
    add('round3-call', f + pick(CALL_V).format(to=to), {'act': 'call', 'to': to, 'video': True})
for _ in range(30):
    to, f = pick(H_PEOPLE), pick(H_FILLERS)
    add('round3-call', f + pick(H_CALL).format(to=to), {'act': 'call', 'to': to})
for _ in range(8):
    to, f = pick(H_PEOPLE), pick(H_FILLERS)
    add('round3-call', f + pick(H_CALL_V).format(to=to), {'act': 'call', 'to': to, 'video': True})

# ---- remind ----------------------------------------------------------------------------------------------
WHATS = ['call the dentist', 'drink water', 'charge my phone', 'study for the maths test', 'submit the project', 'take my meds',
         'feed the cat', 'email sir', 'pay the wifi bill', 'text kunal back', 'call mama', 'pack my bag', 'go to the gym',
         'finish the admax page', 'return the book', 'water the plants', 'start studying', 'check the oven', 'sleep early',
         'order the cake', 'reply to the email', 'back up my laptop', 'book the tickets', 'renew the domain', 'push the code']
WHENS = ['tmrw', 'tomorrow morning', 'at 6', 'at 7pm', 'in an hour', 'in 20 mins', 'tonight', 'on friday', 'every morning',
         'at 5:30', 'after school', 'in 2 hours', 'at 9 tonight', 'this evening', 'on sunday', 'at noon', 'in 10 min']
REM_WW = ['remind me to {w} {t}', 'remind me {t} to {w}', 'set a reminder to {w} {t}', 'lmk {t} to {w}', 'ping me {t} to {w}',
          'reminder to {w} {t}', 'yo remind me to {w} {t}', 'can u remind me to {w} {t}', 'remind me abt {w} {t}']
REM_W = ['remind me to {w}', 'dont let me forget to {w}', 'remind me abt {w}', 'set a reminder to {w}', 'make sure i {w}',
         'yo remind me to {w} later']
REM_T = ['set a reminder for {t}', 'remind me {t}', 'put a reminder {t}']
H_REM = ['{t} yaad dila dena ki {w}', '{t} yaad dilana {w}', 'yaad dila dena {w}']
H_WHATS = ['bag pack karna hai', 'dawai leni hai', 'mama ko call karna hai', 'padhai shuru karni hai', 'bill bharna hai']
H_WHENS = ['kal subah', 'aaj raat', 'shaam ko', 'kal', 'ek ghante mein']
for _ in range(120):
    w, t, f = pick(WHATS), pick(WHENS), pick(FILLERS)
    add('round3-remind', f + pick(REM_WW).format(w=w, t=t), {'act': 'remind', 'what': w, 'when': t})
for _ in range(40):
    w, f = pick(WHATS), pick(FILLERS)
    add('round3-remind', f + pick(REM_W).format(w=w), {'act': 'remind', 'what': w})
for _ in range(12):
    t, f = pick(WHENS), pick(FILLERS)
    add('round3-remind', f + pick(REM_T).format(t=t), {'act': 'remind', 'when': t})
for _ in range(25):
    w, t, f = pick(H_WHATS), pick(H_WHENS), pick(H_FILLERS)
    tpl = pick(H_REM)
    lab = {'act': 'remind', 'what': w}
    if '{t}' in tpl:
        lab['when'] = t
    add('round3-remind', f + tpl.format(w=w, t=t), lab)

# ---- calendar --------------------------------------------------------------------------------------------
CAL_T = ['whats on my calendar {t}', 'am i free {t}', 'anything planned {t}', 'do i have anything {t}', 'check my schedule {t}',
         'any meetings {t}', 'whats my schedule {t}', 'am i busy {t}', 'is my calendar clear {t}', 'what do i have {t}']
CAL_0 = ['hows my day looking', 'whats on my calendar', 'check my calendar', 'whens my next class', 'whats next on my schedule',
         'do i have any meetings', 'show me my schedule', 'hows my week looking', 'whats coming up']
CAL_WHENS = ['today', 'tmrw', 'tomorrow', 'tonight', 'this weekend', 'on friday', 'at 5', 'this week', 'next week',
             'tmrw evening', 'on saturday', 'this afternoon']
H_CAL = ['kal ka schedule kya hai', 'aaj kya plan hai', 'kal kya plan hai calendar mein', 'aaj free hu kya']
for _ in range(70):
    t, f = pick(CAL_WHENS), pick(FILLERS)
    add('round3-cal', f + pick(CAL_T).format(t=t), {'act': 'calendar', 'when': t})
for _ in range(25):
    add('round3-cal', pick(FILLERS) + pick(CAL_0), {'act': 'calendar'})
for s in H_CAL:
    when = s.split()[0]
    add('round3-cal', pick(H_FILLERS) + s, {'act': 'calendar', 'when': when})

# ---- note ------------------------------------------------------------------------------------------------
NOTE_C = ['buy eggs milk bread', 'the wifi password is on the router', 'call the plumber', 'ideas for the admax site',
          'the test is on the 14th', 'shopping list: rice, dal, chips', 'gym at 6 every day', 'books to read this month',
          'kunal owes me 500', 'fix the wake word bug', 'the locker code is 4412', 'project due friday']
NOTE_T = ['note down {c}', 'jot down {c}', 'make a note {c}', 'add {c} to my notes', 'write {c} in notes', 'open notes and write {c}',
          'save a note saying {c}', 'put {c} in my notes', 'quick note: {c}', 'notes mein likh do {c}']
TOPICS = ['rain', 'tea', 'the ocean', 'friendship', 'cricket', 'space', 'exams', 'healthy food', 'climate change', 'mumbai']
NOTE_P = ['write a passage about {x} in notes', 'open notes and write a paragraph about {x}', 'write a short note about {x}']
for _ in range(80):
    c, f = pick(NOTE_C), pick(FILLERS)
    add('round3-note', f + pick(NOTE_T).format(c=c), {'act': 'note', 'content': c})
for _ in range(25):
    x, f = pick(TOPICS), pick(FILLERS)
    tpl = pick(NOTE_P)
    text = tpl.format(x=x)
    if tpl.startswith('write a passage'):
        content = 'a passage about ' + x
    elif 'paragraph' in tpl:
        content = 'a paragraph about ' + x
    else:
        content = 'about ' + x
    add('round3-note', f + text, {'act': 'note', 'content': content})

# ---- weather ---------------------------------------------------------------------------------------------
CITIES = ['nagpur', 'nashik', 'delhi', 'mumbai', 'shimla', 'london', 'tokyo', 'kolhapur', 'goa', 'toronto', 'dubai']
W_0 = ['hows the weather', 'weather?', 'whats the weather like', 'do i need a jacket rn', 'do i need an umbrella', 'hot outside or nah',
       'whats the temp outside', 'is it cold out', 'is it gonna rain', 'hows it looking outside', 'weather check', 'raining rn?']
W_T = ['weather {t}', 'is it gonna rain {t}', 'do i need an umbrella {t}', 'hows the weather {t}', 'will it rain {t}',
       'hows the weather looking {t}', 'is it gonna be hot {t}']
W_P = ['weather in {p}', 'hows the weather in {p}', 'is it raining in {p}', 'whats the temp in {p}', 'will it snow in {p}']
W_PT = ['hows the weather in {p} {t}', 'will it rain in {p} {t}', 'weather in {p} {t}']
W_WHENS = ['today', 'tmrw', 'tomorrow', 'tonight', 'this weekend', 'later', 'on sunday']
H_W = [('aaj baarish hogi kya', 'aaj'), ('kal mausam kaisa rahega', 'kal'), ('bahar garmi hai kya', None), ('aaj mausam kaisa hai', 'aaj'),
       ('kal baarish hogi', 'kal')]
for _ in range(35):
    add('round3-weather', pick(FILLERS) + pick(W_0), {'act': 'weather'})
for _ in range(40):
    t = pick(W_WHENS)
    add('round3-weather', pick(FILLERS) + pick(W_T).format(t=t), {'act': 'weather', 'when': t})
for _ in range(35):
    p = pick(CITIES)
    add('round3-weather', pick(FILLERS) + pick(W_P).format(p=p), {'act': 'weather', 'where': p})
for _ in range(20):
    p, t = pick(CITIES), pick(W_WHENS)
    add('round3-weather', pick(FILLERS) + pick(W_PT).format(p=p, t=t), {'act': 'weather', 'where': p, 'when': t})
for s, t in H_W:
    add('round3-weather', pick(H_FILLERS) + s, {'act': 'weather', 'when': t} if t else {'act': 'weather'})

# ---- the player -------------------------------------------------------------------------------------------
PLAYER = {
    'pause': ['pause', 'pause the music', 'pause it', 'stop the song', 'pause spotify', 'hold the music', 'stop the music',
              'shh pause it', 'pause this', 'gaana rok do', 'gaana band kar', 'music band karo', 'pause the song rq'],
    'resume': ['resume', 'unpause', 'resume the music', 'continue the song', 'keep playing', 'resume spotify', 'play it again from where it stopped',
               'gaana wapas chala', 'music chalu kar', 'unpause the song'],
    'next_track': ['skip', 'next song', 'skip this', 'skip this its mid', 'next track', 'skip this one', 'play the next one',
                   'agla gaana', 'agla chala', 'next', 'skip it bro'],
    'volume_up': ['turn it up', 'louder', 'volume up', 'crank it up', 'increase the volume', 'turn the music up', 'make it louder',
                  'awaaz badha do', 'volume badha', 'turn it up a lil'],
    'volume_down': ['turn it down', 'lower the volume', 'quieter plz', 'volume down', 'too loud turn it down', 'make it quieter',
                    'awaaz kam karo', 'volume kam kar', 'turn the music down a bit'],
}
for act, lines in PLAYER.items():
    for s in lines:
        add('round3-player', s, {'act': act})
        add('round3-player', pick(['yo ', 'ok ', 'plz ', 'bro ', 'jarvis ', 'eh ']) + s, {'act': act})

# ---- existing acts, said casually ---------------------------------------------------------------------
APPS = ['spotify', 'notes', 'whatsapp', 'brave', 'calculator', 'terminal', 'insta', 'instagram', 'youtube', 'yt', 'discord',
        'vs code', 'safari', 'reminders', 'settings', 'netflix', 'chatgpt', 'gmail', 'github', 'finder', 'photos', 'maps']
OPEN = ['open {a}', 'open {a} rn', 'pull up {a}', 'fire up {a}', 'boot up {a}', 'launch {a}', 'get {a} up', 'bring up {a}',
        'open {a} plz', 'yo open {a}', 'open {a} rq', 'can u open {a}', 'opn {a}']
H_OPEN = ['{a} khol do', '{a} kholo', '{a} khol de yaar', '{a} open kar']
CLOSE = ['close {a}', 'kill {a}', 'shut {a}', 'quit {a}', 'close {a} its lagging', 'kill {a} rn', 'shut {a} down', 'close {a} plz']
H_CLOSE = ['{a} band kar do', '{a} band karo', '{a} band kar']
for _ in range(90):
    a, f = pick(APPS), pick(FILLERS)
    add('round3-slang', f + pick(OPEN).format(a=a), {'act': 'open', 'thing': a})
for _ in range(20):
    a, f = pick(APPS), pick(H_FILLERS)
    add('round3-slang', f + pick(H_OPEN).format(a=a), {'act': 'open', 'thing': a})
for _ in range(45):
    a, f = pick(APPS), pick(FILLERS)
    add('round3-slang', f + pick(CLOSE).format(a=a), {'act': 'close', 'thing': a})
for _ in range(15):
    a, f = pick(APPS), pick(H_FILLERS)
    add('round3-slang', f + pick(H_CLOSE).format(a=a), {'act': 'close', 'thing': a})

MUSIC = ['lofi', 'drake', 'travis scott', 'the weeknd', 'arijit singh', 'ap dhillon', 'rehaan moosewala', 'karan aujla', 'coldplay',
         'taylor swift', 'kendrick', 'old bollywood hits', 'sad songs', 'gym music', 'chill vibes', 'study music', 'marathi songs',
         'my liked songs', 'something chill', 'some hype music', 'blinding lights', 'starboy', 'shape of you', 'kesariya']
PLAY_M = ['play {q}', 'throw on {q}', 'blast {q}', 'bump {q}', 'put on {q}', 'queue up {q}', 'spin {q}', 'play some {q}',
          'yo play {q}', 'play {q} rn', 'can u play {q}', 'ply {q}', 'lemme hear {q}', 'put {q} on']
PLAY_MW = ['play {q} on spotify', 'put {q} on spotify', 'play {q} on yt music']
H_PLAY = ['{q} chala do', '{q} laga do', '{q} chala de yaar', '{q} ke gaane laga do', '{q} bajao']
VIDS = ['minecraft', 'f1 highlights', 'mrbeast', 'ishowspeed', 'funny cat videos', 'how to tie a tie', 'black holes explained',
        'gym motivation', 'carryminati', 'cricket highlights', 'a podcast', 'lofi beats', 'gta 6 trailer', 'a random video',
        'marvel trailers', 'dhruv rathee', 'a cooking video', 'football skills']
PLAY_V = [('play {q} on youtube', 'youtube'), ('put on {q} on yt', 'yt'), ('open youtube and play {q}', 'youtube'),
          ('play {q} on yt', 'yt'), ('youtube pe {q} laga do', 'youtube'), ('search yt for {q}', 'yt')]
PLAY_V0 = ['find me a vid on {q}', 'play a video on {q}', 'put on a {q} video', 'show me a vid of {q}', 'find a video about {q}']
for _ in range(95):
    q, f = pick(MUSIC), pick(FILLERS)
    add('round3-slang', f + pick(PLAY_M).format(q=q), {'act': 'play', 'query': q})
for _ in range(15):
    q, f = pick(MUSIC), pick(FILLERS)
    tpl = pick(PLAY_MW)
    where = 'spotify' if 'spotify' in tpl else 'yt music'
    add('round3-slang', f + tpl.format(q=q), {'act': 'play', 'query': q, 'where': where})
for _ in range(25):
    q, f = pick(['arijit', 'ap dhillon', 'lofi', 'marathi', 'old songs', 'karan aujla', 'koi accha']), pick(H_FILLERS)
    add('round3-slang', f + pick(H_PLAY).format(q=q), {'act': 'play', 'query': q})
for _ in range(55):
    q, f = pick(VIDS), pick(FILLERS)
    tpl, where = pick(PLAY_V)
    add('round3-slang', f + tpl.format(q=q), {'act': 'play', 'query': q, 'where': where, 'video': True})
for _ in range(25):
    q, f = pick([v for v in VIDS if not v.startswith('a ')]), pick(FILLERS)
    add('round3-slang', f + pick(PLAY_V0).format(q=q), {'act': 'play', 'query': q, 'video': True})

SEARCH_Q = ['best budget earbuds', 'iphone 18 release date', 'f1 standings', 'cheap flights to goa', 'how to fix a squeaky door',
            'gta 6 release date', 'ps5 price in india', 'ipl schedule', 'best laptops under 60k', 'nearest pizza place',
            'what time the match starts', 'lyrics to starboy', 'news about spacex', 'reviews for the pixel 10']
SEARCH = ['google {q}', 'look up {q}', 'search up {q}', 'search {q}', 'yo find out {q}', 'check {q} online', 'search the web for {q}',
          'look up {q} for me', 'srch {q}']
for _ in range(60):
    q, f = pick(SEARCH_Q), pick(FILLERS)
    add('round3-slang', f + pick(SEARCH).format(q=q), {'act': 'search_web', 'query': q})
for s in ['is my mac ok', 'wtf why is my mac so slow', 'hows my laptop doing', 'is everything good with my mac', 'mac ka kya haal hai',
          'why is everything lagging', 'check my system rq', 'laptop itna slow kyu hai']:
    add('round3-slang', pick(FILLERS) + s, {'act': 'system_status'})

# ---- none: slang that must NOT act ----------------------------------------------------------------------
GREET = ['wsg', 'wsg gng', 'hyd', 'hbu', 'wyd', 'sup', 'yo', 'yoo', 'gm', 'gn', 'gn gng', 'ttyl', 'brb', 'bet', 'fr', 'fr?', 'ngl',
         'lol', 'lmao', 'lmaooo', 'bruh', 'ty', 'tysm', 'thx', 'thx dawg', 'np', 'kk', 'aight', 'wsg jarvis', 'hyd bro', 'yo wsg',
         'wsg w u', 'wbu', 'hru', 'whats good', 'sup gng', 'gm jarvis hyd', 'nm u', 'lets gooo', 'real', 'facts', 'W', 'L',
         'kaisa hai', 'kya haal hai', 'kya scene', 'aur bata', 'sat sri akal', 'chal bye', 'shukriya', 'theek hai', 'haan bhai',
         'kya chal raha', 'bas timepass', 'good night', 'morning', 'mornin gng', 'im back', 'back', 'wassup', 'hiii', 'heyy']
FEEL = ['im so bored', 'cant sleep', 'today was rough', 'im stressed abt exams', 'im hungry af', 'idk what to do', 'im tired af',
        'lowkey sad rn', 'i aced my test', 'lets gooo i won', 'my head hurts', 'neend nahi aa rahi', 'bore ho raha hu',
        'aaj ka din bekar tha', 'im so done with school', 'ngl im kinda lonely', 'feeling good today', 'ugh mondays']
COMPLAIN = ['{a} keeps crashing wtf', '{a} is so mid', '{a} been lagging all day', 'why is {a} so slow', 'i hate {a} ngl',
            '{a} is actually goated', 'i was on {a} all day', '{a} ads are so annoying', '{a} is down again?']
PERSON_S = ['{p} is so annoying ngl', 'i texted {p} already', '{p} called me earlier', 'calling {p} later', 'gonna text {p} later',
            '{p} said dinner is ready', '{p} is coming over', 'i miss {p}', '{p} didnt reply', '{p} left me on read lol',
            'talked to {p} yesterday', '{p} ko call kiya tha', '{p} ne bola khana ready hai', 'will call {p} tmrw', '{p} is so funny']
DIDU = ['did u send that msg to {p}', 'did u text {p}', 'u sure u sent it', 'did u open {a}', 'did u actually play it', 'did u call {p}',
        'wait did that go through', 'did it send', 'did u remind me', 'did u close {a}', 'did the msg go to {p}', 'u sure u called {p}']
NVM = ['nvm', 'nvm forget it', 'wait dont', 'dont do that', 'cancel that', 'leave it', 'rehne de', 'chhod de', 'never mind lol',
       'nah forget it', 'stop', 'wait no', 'actually nvm', 'no dont text her', 'dont call him', 'nvm dont open it']
HOWTO = ['how do i text someone on whatsapp', 'how do i facetime', 'how do reminders work on mac', 'how do i take a screenshot on mac',
         'is spotify premium worth it', 'whats better brave or chrome', 'how do i call someone overseas', 'can u even send messages',
         'what apps do i have', 'why does whatsapp need my contacts', 'how do i mute a group chat', 'whats a good time to call mom']
for s in GREET:
    add('round3-none', s, {'act': 'none'})
    add('round3-none', pick(['yo ', 'ok ', 'bro ', 'jarvis ', '']) + s, {'act': 'none'})
for s in FEEL:
    add('round3-none', pick(['', '', 'ngl ', 'bro ', 'yaar ']) + s, {'act': 'none'})
for _ in range(45):
    add('round3-none', pick(COMPLAIN).format(a=pick(APPS)), {'act': 'none'})
for _ in range(60):
    add('round3-none', pick(PERSON_S).format(p=pick(PEOPLE)), {'act': 'none'})
for _ in range(45):
    add('round3-none', pick(DIDU).format(p=pick(PEOPLE), a=pick(APPS)), {'act': 'none'})
for s in NVM:
    add('round3-none', s, {'act': 'none'})
for s in HOWTO:
    add('round3-none', s, {'act': 'none'})
for s in ['call an ambulance rn', 'call the police theres someone outside', 'call 112', 'call it a night', 'that was a close call',
          'schedule a meeting with kunal at 5', 'add a meeting to my calendar', 'at 6pm text mama saying im leaving',
          'text mama omw and then open maps', 'close brave + open notes', 'play drake and open whatsapp', 'read my last text',
          'block him on whatsapp', 'set the volume to 40', 'whats the difference between weather and climate', 'rain is so pretty',
          'i love rainy days', 'the weather has been crazy lately', 'my calendar is a mess lol', 'notes app is kinda useless',
          'reminders never work for me', 'wtf is a reminder even for']:
    add('round3-none', s, {'act': 'none'})

# ---- his three real failures, 2026-09-27 (trained on — they are NOT in the stress set) -----------------
add('round3-his', 'DM mama on whatsapp saying wsg', {'act': 'message', 'to': 'mama', 'body': 'wsg', 'where': 'whatsapp'})
add('round3-his', 'Wsg hyd', {'act': 'none'})
add('round3-his', 'eh let it be, just open youtube and play a random video',
    {'act': 'play', 'query': 'a random video', 'where': 'youtube', 'video': True})

os.makedirs(OUT, exist_ok=True)
seen = set()
total = 0
for batch, rs in rows.items():
    lines = []
    for text, label in rs:
        key = ' '.join(text.lower().split())
        if key in seen:
            continue
        seen.add(key)
        lines.append(text + '\t' + json.dumps(label, ensure_ascii=False))
    with open(os.path.join(OUT, batch + '.tsv'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    total += len(lines)
    print('%-16s %4d' % (batch, len(lines)))
print('total', total)
