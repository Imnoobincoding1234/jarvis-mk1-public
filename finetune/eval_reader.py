#!/usr/bin/env python3
"""Grade the reader on the exam: his newest messages, which it has never seen.

    eval_reader.py --adapter adapters/reader [--model models/Qwen3.5-0.8B-4bit] [--exam a.jsonl b.jsonl …]
                   [--dump runs/rows.jsonl]

Several exam files are graded with one model load and reported one by one. --dump writes every row
(verdict, raw answer, and `minp`: the probability of the least likely token the model chose — the
same quantity readmodel.js gates on, though here without Ollama's JSON grammar, so treat it as a
first look, not the gate's calibration).

Greedy decoding, the same prompt the trainer used. Every answer is scored as:
  exact    the whole reading matches the label
  MISS     the label is an action and the model said none — costs coverage, never acts
  WRONG    the model produced an action that is not the labelled one (wrong act, or right act with a
           different thing/query/where/name/content) — this is what must be zero
  REFUSED  the checker threw the answer away: not JSON, unknown act, missing field, or a value that
           is not in his message. A refused answer never acts; it is reported so we see how often.
A WRONG answer that the checker would refuse is counted as REFUSED — that is the point of the checker.

`refers` (LABELING.md) is graded on its own, never as part of the reading: the verdict above compares the
reading with `refers` taken off both sides, and a second tally says whether the flag was caught, missed
(the dangerous error — JARVIS would act on the bare word) or raised on a message that leans on nothing.
A file labelled before `refers` existed has no opinion on it, so its tally says nothing either way.
"""
import argparse
import json
import os
import sys
import time

from label_batch import check, canonical

HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = "Read the message as one JARVIS action. Reply with JSON only. Copy the user's words exactly."


def refers_of(label, got):
    """'caught' | 'missed' | 'false alarm' | None — whether the refers flag was right."""
    want, said = bool(label.get('refers')), bool(got and got.get('refers'))
    if want and said:
        return 'caught'
    if want:
        return 'missed'
    return 'false alarm' if said else None


def grade(text, label, raw):
    try:
        got = json.loads(raw)
        if not isinstance(got, dict):
            raise ValueError('not an object')
    except Exception:
        return 'REFUSED', None, 'not json'
    err = check(text, got)
    if err:
        return 'REFUSED', got, err
    got = {k: v for k, v in canonical(got).items() if k != 'refers'}
    label = {k: v for k, v in label.items() if k != 'refers'}
    if got == label:
        return 'exact', got, ''
    if got['act'] == 'none':
        return 'MISS', got, ''
    if label['act'] == 'none':
        return 'WRONG', got, 'acted on a non-request'
    # readmodel.js trims every value before it is used (names, places, queries, content), so a value
    # the model wrote with a stray space acts exactly like the label. Counted as exact, and said so.
    fields = lambda d: {k: (v.lower().strip() if isinstance(v, str) else v) for k, v in d.items()}
    if fields(got) == fields(label):
        return 'exact', got, 'case or spacing only'
    return 'WRONG', got, 'differs'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=os.path.join(HERE, 'models', 'Qwen3.5-0.8B-4bit'))
    ap.add_argument('--adapter', default=None)
    ap.add_argument('--exam', nargs='+', default=[os.path.join(HERE, 'data', 'exam_his.jsonl')])
    ap.add_argument('--show', type=int, default=40)
    ap.add_argument('--dump', default=None)
    a = ap.parse_args()

    import math
    import mlx.core as mx
    mx.set_memory_limit(int(2.5 * 1024 ** 3))
    mx.set_cache_limit(int(0.3 * 1024 ** 3))
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler

    model, tok = load(a.model, adapter_path=a.adapter)
    sampler = make_sampler(temp=0.0)
    dump = open(a.dump, 'w') if a.dump else None
    for exam in a.exam:
        rows = [json.loads(l) for l in open(exam)]
        tally = {'exact': 0, 'MISS': 0, 'WRONG': 0, 'REFUSED': 0}
        ref = {'caught': 0, 'missed': 0, 'false alarm': 0}
        labelled = any('refers' in r['label'] for r in rows)
        notes = []
        t0 = time.time()
        for r in rows:
            prompt = tok.apply_chat_template(
                [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': r['text']}],
                tokenize=False, add_generation_prompt=True, enable_thinking=False)
            parts, minp = [], 1.0
            for step in stream_generate(model, tok, prompt=prompt, max_tokens=80, sampler=sampler):
                parts.append(step.text)
                if step.logprobs is not None and step.finish_reason != 'stop':
                    minp = min(minp, math.exp(step.logprobs[step.token].item()))
            raw = ''.join(parts).strip()
            v, got, why = grade(r['text'], r['label'], raw)
            tally[v] += 1
            try:
                said = json.loads(raw)
            except Exception:
                said = None
            rv = refers_of(r['label'], said if isinstance(said, dict) else None) if labelled else None
            if rv:
                ref[rv] += 1
                if rv != 'caught':
                    notes.append('refers %-7s %-58s got %s' % (rv, json.dumps(r['text'])[:58], raw[:70]))
            if dump:
                dump.write(json.dumps({'set': os.path.basename(exam), 'text': r['text'], 'label': r['label'],
                                       'raw': raw, 'verdict': v, 'why': why, 'refers': rv, 'minp': round(minp, 4)},
                                      ensure_ascii=False) + '\n')
            if v != 'exact':
                notes.append('%-7s %.2f %-58s got %s  want %s %s' % (v, minp, json.dumps(r['text'])[:58], raw[:70],
                             json.dumps(r['label'], ensure_ascii=False)[:60], ('(' + why + ')') if why else ''))
        dt = time.time() - t0
        n = len(rows)
        acts = sum(1 for r in rows if r['label']['act'] != 'none')
        print('exam %s: %d messages (%d actions, %d none), %.0f ms each' % (os.path.basename(exam), n, acts, n - acts, 1000 * dt / n))
        print('  exact %d   MISS %d   REFUSED %d   WRONG %d' % (tally['exact'], tally['MISS'], tally['REFUSED'], tally['WRONG']))
        if labelled:
            n_ref = sum(1 for r in rows if r['label'].get('refers'))
            print('  refers: caught %d of %d, missed %d, false alarms %d (of %d that lean on nothing)' % (
                ref['caught'], n_ref, ref['missed'], ref['false alarm'], n - n_ref))
        else:
            print('  refers: not graded — this file was labelled before the flag existed')
        for line in notes[:a.show]:
            print('  ' + line)
        sys.stdout.flush()
    if dump:
        dump.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
