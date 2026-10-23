#!/usr/bin/env python3
"""Record hand-written labels for a range of his messages, and refuse any label that breaks the rules.

    label_batch.py START END < labels.json      # {"<id>": {"act": ...}, ...}; unlisted ids are "none"

Checks, per LABELING.md: the act is known, its required fields are present, no field it does not
take is present, and every string value is an exact (case-insensitive) substring of the message.
Writes data/labels_real.jsonl, replacing any earlier labels for the same ids.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MSGS = os.path.join(HERE, 'data', 'his_messages.jsonl')
OUT = os.path.join(HERE, 'data', 'labels_real.jsonl')

FIELDS = {
    # `when` (round 7, 2026-10-15): the words saying WHEN to do it, copied ("in 2 minutes", "at 9 tonight", "10 minute baad") —
    # the action is then scheduled, not done now. Not a time inside a message body, a length in a query, or a reminder's time.
    # `as` on close too (round 7): "close the notes app" — the same site/app word open takes.
    'open': ({'thing'}, {'as', 'business', 'browser', 'when'}),
    'close': ({'thing'}, {'force', 'as', 'when'}),
    'search_web': ({'query'}, {'where', 'browser', 'when'}),
    # `video` (round 3): he asked for a video ("find me a vid on…", "put on a minecraft video") — the reader
    # says so, instead of the machine testing for the words "vid" / "video".
    'play': ({'query'}, {'where', 'browser', 'video', 'when'}),
    'search_files': ({'query'}, set()),
    'create_folder': ({'name'}, {'where'}),
    'create_file': ({'name'}, {'where', 'content'}),
    'delete': ({'thing'}, {'where'}),
    'read': ({'thing'}, {'where'}),
    'append': ({'thing', 'content'}, {'where'}),
    'list': ({'thing'}, {'where'}),
    'system_status': (set(), set()),
    'screenshot': (set(), {'when'}),
    'list_running': (set(), set()),
    'empty_trash': (set(), set()),
    'sleep_display': (set(), set()),
    # Dream mode (2026-09-18): what JARVIS did while he was away, run the idle work now, and the setting
    # as a POLARITY PAIR — on and off are separate acts so the reader's own probabilities decide the
    # direction, the way they do for open/close; an embedder measurably cannot.
    'dream_log': (set(), set()),
    'dream_now': (set(), set()),
    'dream_on': (set(), set()),
    'dream_off': (set(), set()),
    # The tutor (2026-09-19): an embedder was measured unable to tell "teach me about entropy" (study it)
    # from "what is entropy" (answer it now), and TUTOR_RE cut the subject out with a word list. The
    # reader reads the request and copies the subject, like every other value.
    'quiz_me': (set(), {'topic'}),
    'study_stats': (set(), set()),
    'learn_topic': ({'topic'}, set()),
    'stop_topic': ({'topic'}, set()),
    # Round 3 (2026-09-27, the casual-slang push): the jobs every other lane used to guess at.
    # message/call: `to` is the words naming the person (resolved against Contacts + WhatsApp at run time,
    # never here); `body` the words to convey; `reported` when the body is indirect ("asking if hes free")
    # so the machine turns it into a direct message instead of sending the words as they stand.
    'message': ({'to'}, {'body', 'where', 'reported', 'when'}),
    'call': ({'to'}, {'where', 'video', 'when'}),
    # remind/calendar/weather: `when` is the words naming the time ("tmrw", "at 6", "kal subah").
    'remind': (set(), {'what', 'when'}),
    'calendar': (set(), {'when'}),
    # `write` (round 4): he asks for text to be WRITTEN ("write a passage about tea") rather than his words
    # kept ("jot down buy eggs") — the reader says so; no word test decides it.
    'note': ({'content'}, {'write'}),
    'weather': (set(), {'where', 'when'}),
    # Round 6 (2026-10-10): what the clock says, here or in a named place ("whats the time", "aaj kya date hai", "time in tokyo").
    # `where` is the words naming the place. Event times, alarms, his calendar and durations are NOT time — see LABELING.md.
    'time': (set(), {'where'}),
    # The player, as separate no-field acts so the reader's own probabilities pick the control.
    'pause': (set(), {'when'}),
    'resume': (set(), {'when'}),
    'next_track': (set(), {'when'}),
    'volume_up': (set(), {'when'}),
    'volume_down': (set(), {'when'}),
    # Round 4 (2026-09-27): several independent requests in one message, in his order — each step shaped like
    # any other reading (never multi, never none), each value his own words. See LABELING.md "Round 4".
    'multi': ({'steps'}, set()),
    'none': (set(), set()),
}
MULTI_MIN, MULTI_MAX = 2, 4
ORDER = ['act', 'thing', 'query', 'to', 'body', 'what', 'when', 'where', 'browser', 'name', 'content', 'topic', 'as',
         'business', 'force', 'reported', 'video', 'write', 'steps', 'refers']
# `refers` is allowed on EVERY act, none included: it says the message has words standing in for something
# named earlier in the conversation (LABELING.md). label_refers.py sets it without touching the rest.
ANY_ACT = {'refers'}


def check(text, label):
    act = label.get('act')
    if act not in FIELDS:
        return 'unknown act %r' % act
    need, may = FIELDS[act]
    keys = set(label) - {'act'}
    if need - keys:
        return 'missing %s' % sorted(need - keys)
    if keys - need - may - ANY_ACT:
        return 'not allowed for %s: %s' % (act, sorted(keys - need - may - ANY_ACT))
    low = text.lower()
    for k in keys:
        v = label[k]
        if k == 'steps':
            if not isinstance(v, list) or not (MULTI_MIN <= len(v) <= MULTI_MAX):
                return 'steps must be a list of %d-%d readings' % (MULTI_MIN, MULTI_MAX)
            for n, st in enumerate(v):
                if not isinstance(st, dict) or st.get('act') in ('multi', 'none', None):
                    return 'step %d must be a single act' % (n + 1)
                if 'refers' in st:
                    return 'refers goes on the whole reading, not a step'
                e = check(text, st)
                if e:
                    return 'step %d: %s' % (n + 1, e)
            continue
        if k in ('business', 'force', 'refers', 'reported', 'video', 'write'):
            if v is not True:
                return '%s must be true or absent' % k
        elif k == 'as':
            if v not in ('site', 'app'):
                return 'as must be site or app'
        elif not isinstance(v, str) or not v or v.lower() not in low:
            return '%s=%r is not in the message' % (k, v)
    return None


def canonical(label):
    out = {k: label[k] for k in ORDER if k in label}
    if isinstance(out.get('steps'), list):
        out['steps'] = [canonical(st) for st in out['steps']]
    return out


def main():
    start, end = int(sys.argv[1]), int(sys.argv[2])
    given = {int(k): v for k, v in json.load(sys.stdin).items()}
    msgs = {}
    with open(MSGS) as f:
        for line in f:
            r = json.loads(line)
            msgs[r['id']] = r
    bad = []
    for i in given:
        if not (start <= i < end):
            bad.append('%d: outside %d..%d' % (i, start, end))
    new = {}
    for i in range(start, end):
        if i not in msgs:
            continue
        label = given.get(i, {'act': 'none'})
        err = check(msgs[i]['text'], label)
        if err:
            bad.append('%d: %s — %r' % (i, err, msgs[i]['text'][:70]))
        new[i] = canonical(label)
    if bad:
        print('REFUSED:\n  ' + '\n  '.join(bad))
        return 1
    old = {}
    if os.path.exists(OUT):
        with open(OUT) as f:
            for line in f:
                r = json.loads(line)
                old[r['id']] = r['label']
    old.update(new)
    with open(OUT, 'w') as f:
        for i in sorted(old):
            f.write(json.dumps({'id': i, 'label': old[i]}, ensure_ascii=False) + '\n')
    acts = {}
    for i in new:
        acts[new[i]['act']] = acts.get(new[i]['act'], 0) + 1
    print('labelled %d..%d (%d): %s; file now %d' % (start, end - 1, len(new),
          ', '.join('%s %d' % kv for kv in sorted(acts.items(), key=lambda x: -x[1])), len(old)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
