#!/usr/bin/env python3
"""Round 3 rows adapted from the approved external datasets (data/external/, see its MANIFEST.md).

    gen_round3_ext.py        # writes data/round3_batches/round3-htop.tsv and round3-massive.tsv

Google Hinglish-TOP (Apache-2.0): English + Hinglish pairs with exact slot spans — messaging, reminders,
music, weather. Amazon MASSIVE 1.1 en-US (CC BY 4.0): assistant commands with slot tags — music, weather,
calendar reads, "remind me", volume, and chit-chat / questions / email as `none`.

Every line is restyled into his register (lowercase, no apostrophes, some "u"/"plz", no end punctuation)
with the SAME word-level change applied to its slot values, so labels stay exact substrings (checked; a row
that fails is dropped, never patched). Each category is capped so the datasets cannot drown his style.
Training material only — nothing in JARVIS reads these words.
"""
import csv
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
X = os.path.join(HERE, 'data', 'external', 'x')
OUT = os.path.join(HERE, 'data', 'round3_batches')
rng = random.Random(20260927)
CAP = 140
# Per-category ceilings: messages and reminders are the point of round 3; weather, things JARVIS does not do,
# and chit-chat only need enough to be learned, not enough to outweigh his own sentences.
CAPS = {'messaging-en': 140, 'messaging-cs': 140, 'reminder-en': 90, 'reminder-cs': 90, 'music-en': 60, 'music-cs': 60,
        'weather-en': 40, 'weather-cs': 40, 'weather': 40, 'play': 80, 'calendar': 60, 'remind': 100, 'vol_up': 45, 'vol_down': 45}


def detok(s):
    s = s.replace('\\ u 2019', "'").replace('\\u2019', "'").replace('’', "'")
    s = re.sub(r"\s*'\s*", "'", s)
    s = re.sub(r'\s+([.,?!])', r'\1', s)
    return ' '.join(s.split())


def make_style():
    """One row's restyle, applied identically to the message and to each value."""
    lower = rng.random() < 0.85
    u = rng.random() < 0.5
    plz = rng.random() < 0.6

    def f(s):
        s = s.replace("'", '')
        if lower:
            s = s.lower()
        if u:
            s = re.sub(r'\byou\b', 'u', s, flags=re.I)
            s = re.sub(r'\byour\b', 'ur', s, flags=re.I)
        if plz:
            s = re.sub(r'\bplease\b', 'plz', s, flags=re.I)
        return ' '.join(s.split())
    return f


def finish(text):
    text = re.sub(r'[\s.,!]+$', '', text)
    return text[:1].lower() + text[1:] if rng.random() < 0.7 else text


def ok_label(text, label):
    t = text.lower()
    return all(k == 'act' or not isinstance(v, str) or (v and v.lower() in t) for k, v in label.items())


# ---- Hinglish-TOP bracket parses --------------------------------------------------------------------------
def parse_top(p):
    """'[IN:X a [SL:Y b c ] d ]' → (intent, [(slot, text)]) for top-level slots, text flattened."""
    toks = p.split()
    i = 0

    def node():
        nonlocal i
        label = toks[i][1:]
        i += 1
        words, slots = [], []
        while i < len(toks) and toks[i] != ']':
            if toks[i].startswith('['):
                sub_label, sub_words, _ = node()
                words += sub_words
                slots.append((sub_label, ' '.join(sub_words)))
            else:
                words.append(toks[i])
                i += 1
        i += 1
        return label, words, slots
    label, words, slots = node()
    return label, slots


def reported_from(en_parse):
    m = re.search(r'(\S+(?:\s+\S+){0,2})\s+\[SL:CONTENT_EXACT', en_parse)
    before = (m.group(1).lower() if m else '')
    content = re.search(r'\[SL:CONTENT_EXACT\s+(\S+)', en_parse)
    first = content.group(1).lower() if content else ''
    return bool(re.search(r'\b(ask|asking|if|whether|see)\b', before) or first in ('he', 'she', 'they', 'his', 'her', 'their', 'him'))


rows = {'round3-htop': [], 'round3-massive': []}
counts = {}


def put(batch, cat, text, label):
    if counts.get(cat, 0) >= CAPS.get(cat, 30):
        return
    if not ok_label(text, label) or len(text) >= 90:
        return
    counts[cat] = counts.get(cat, 0) + 1
    rows[batch].append((text, label))


top_dir = os.path.join(X, 'Hinglish-TOP-Dataset-main', 'Dataset', 'Human Annotated Data')
top_rows = []
for name in ('train.tsv', 'validation.tsv'):
    with open(os.path.join(top_dir, name)) as f:
        r = list(csv.reader(f, delimiter='\t'))
        top_rows += [x for x in r[1:] if len(x) >= 5]
rng.shuffle(top_rows)
for en_q, cs_q, en_p, cs_p, dom in top_rows:
    for side, query, parse in (('en', en_q, en_p), ('cs', cs_q, cs_p)):
        try:
            intent, slots = parse_top(detok(parse))
        except Exception:
            continue
        sd = {}
        for k, v in slots:
            sd.setdefault(k, v)
        style = make_style()
        text = finish(style(detok(query)))
        cat = dom + '-' + side
        if intent == 'IN:SEND_MESSAGE' and 'SL:RECIPIENT' in sd:
            lab = {'act': 'message', 'to': style(sd['SL:RECIPIENT'])}
            if 'SL:CONTENT_EXACT' in sd:
                lab['body'] = style(sd['SL:CONTENT_EXACT'])
                if reported_from(detok(en_p)):
                    lab['reported'] = True
            if 'SL:RESOURCE' in sd:
                lab['where'] = style(sd['SL:RESOURCE'])
            put('round3-htop', cat, text, lab)
        elif intent in ('IN:GET_MESSAGE', 'IN:REACT_MESSAGE', 'IN:GET_REMINDER', 'IN:DELETE_REMINDER', 'IN:UPDATE_REMINDER'):
            put('round3-htop', cat + '-none', text, {'act': 'none'})
        elif intent == 'IN:CREATE_REMINDER' and ('SL:TODO' in sd or 'SL:DATE_TIME' in sd):
            lab = {'act': 'remind'}
            if 'SL:TODO' in sd:
                lab['what'] = style(sd['SL:TODO'])
            if 'SL:DATE_TIME' in sd:
                lab['when'] = style(sd['SL:DATE_TIME'])
            if 'SL:PERSON_REMINDED' in sd and sd['SL:PERSON_REMINDED'].lower() not in ('me', 'mujhe', 'i'):
                continue                                   # reminding someone else is not supported
            put('round3-htop', cat, text, lab)
        elif intent == 'IN:PLAY_MUSIC':
            music = [v for k, v in slots if k.startswith('SL:MUSIC_')]
            if len(music) == 1:
                lab = {'act': 'play', 'query': style(music[0])}
                if 'SL:MUSIC_PROVIDER_NAME' in sd and sd['SL:MUSIC_PROVIDER_NAME'] != music[0]:
                    lab['where'] = style(sd['SL:MUSIC_PROVIDER_NAME'])
                put('round3-htop', cat, text, lab)
        elif intent == 'IN:GET_WEATHER':
            lab = {'act': 'weather'}
            if 'SL:LOCATION' in sd:
                lab['where'] = style(sd['SL:LOCATION'])
            if 'SL:DATE_TIME' in sd:
                lab['when'] = style(sd['SL:DATE_TIME'])
            put('round3-htop', cat, text, lab)
        elif dom in ('alarm', 'timer', 'navigation', 'event') and side == 'en' and rng.random() < 0.25:
            put('round3-htop', dom + '-none', text, {'act': 'none'})   # things JARVIS does not do: stay none

# ---- MASSIVE en-US ----------------------------------------------------------------------------------------
SLOT = re.compile(r'\[(\w+) : ([^\]]+)\]')
mas = [json.loads(l) for l in open(os.path.join(X, '1.1', 'data', 'en-US.jsonl'))]
mas = [m for m in mas if m['partition'] in ('train', 'dev')]
rng.shuffle(mas)
NONE_INTENTS = {'general_greet': 30, 'general_quirky': 30, 'general_joke': 20, 'qa_factoid': 30, 'qa_definition': 20,
                'email_sendemail': 30, 'social_post': 20, 'alarm_set': 20, 'email_query': 15, 'news_query': 15}
none_n = {}
for m in mas:
    intent = m['intent']
    style = make_style()
    slots = [(k, v.strip()) for k, v in SLOT.findall(m['annot_utt'])]
    text = finish(style(m['utt']))
    sd = dict(slots)
    if intent == 'play_music':
        music = [v for k, v in slots if k in ('artist_name', 'song_name', 'playlist_name', 'music_genre', 'music_descriptor')]
        if len(music) == 1 and len(slots) <= 2:
            lab = {'act': 'play', 'query': style(music[0])}
            if 'app_name' in sd:
                lab['where'] = style(sd['app_name'])
            put('round3-massive', 'play', text, lab)
    elif intent == 'weather_query':
        lab = {'act': 'weather'}
        if 'place_name' in sd:
            lab['where'] = style(sd['place_name'])
        when = sd.get('date') or sd.get('timeofday') or sd.get('time')
        if when:
            lab['when'] = style(when)
        put('round3-massive', 'weather', text, lab)
    elif intent == 'calendar_query' and 'event_name' not in sd:
        lab = {'act': 'calendar'}
        when = sd.get('date') or sd.get('time') or sd.get('timeofday')
        if when:
            lab['when'] = style(when)
        put('round3-massive', 'calendar', text, lab)
    elif intent == 'calendar_set' and re.match(r'(remind|set a reminder|reminder)', m['utt'].lower()) and 'person' not in sd:
        lab = {'act': 'remind'}
        if 'event_name' in sd:
            lab['what'] = style(sd['event_name'])
        when = sd.get('time') or sd.get('date')
        if when:
            lab['when'] = style(when)
        if len(lab) > 1:
            put('round3-massive', 'remind', text, lab)
    elif intent == 'audio_volume_up':
        put('round3-massive', 'vol_up', text, {'act': 'volume_up'})
    elif intent == 'audio_volume_down':
        put('round3-massive', 'vol_down', text, {'act': 'volume_down'})
    elif intent in NONE_INTENTS and none_n.get(intent, 0) < NONE_INTENTS[intent]:
        none_n[intent] = none_n.get(intent, 0) + 1
        put('round3-massive', 'none-' + intent, text, {'act': 'none'})

seen = set()
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
    print(batch, len(lines))
print(json.dumps(dict(sorted(counts.items())), indent=0))
