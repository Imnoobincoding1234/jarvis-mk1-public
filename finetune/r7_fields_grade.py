#!/usr/bin/env python3
"""Per-field reader confidence (README "Per-field confidence — round 7", pre-registered 2026-10-16). Today the reader's confidence is
the least likely token of the WHOLE reading, so a word copied from his message ("gg", "match kab hai") can pull it under the bar when
the act and the person are certain. This splits every output token by the JSON field it belongs to — a machine format, read with a
JSON lexer; which fields an act needs comes from readmodel's own FIELDS table and SCHEMA enums (no word list) — and scores three rules:
  A  min over all tokens                         (today)
  B  min over choice tokens + required values    (ignores optional free text: body, what, when, where, browser, content of note…)
  C  min over choice tokens only                 (act, enums, booleans, which keys, JSON structure)
Costs per bar, chosen bar per rule on TUNING, chosen rule, then the FRESH confirmation — all by the rules fixed in the README.
  python3 r7_fields_grade.py   (reads runs/r7_fields_20261016/fields_<model>.jsonl from jarvis-os/sweeps/sweep_reader_fields.js)"""
import json, math, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from eval_reader import grade
D = os.path.join(HERE, 'runs', 'r7_fields_20261016')
FRESH = 'reader_calib_fresh_v2.jsonl'
FLOOR = 0.3
BARS = [round(0.30 + 0.05 * i, 2) for i in range(14)]          # 0.30 … 0.95
R7, R5 = 'jarvis-reader-r7q8', 'jarvis-reader'

reg = json.loads(subprocess.check_output(['node', '-e',
    "const R=require(process.argv[1]);const p=R.SCHEMA.properties;const s=p.steps.items.properties;"
    "const en=k=>!!((p[k]&&p[k].enum)||(s[k]&&s[k].enum));"
    "console.log(JSON.stringify({fields:R.FIELDS,enums:Object.keys(Object.assign({},p,s)).filter(en)}))",
    os.path.join(HERE, '..', 'jarvis-os', 'readmodel.js')]))
FIELDS, ENUMS = reg['fields'], set(reg['enums'])

def char_classes(text):
    """Class of every character of the reading: 'choice' (structure, keys, enums, booleans) / 'req' / 'opt' (string values). None if
    the text is not one JSON object."""
    try: obj = json.loads(text)
    except Exception: return None
    if not isinstance(obj, dict): return None
    cls = ['choice'] * len(text)
    stack = []                                      # frames: [kind, path, expecting_key, key, n_children]
    i, n = 0, len(text)
    def act_at(path):
        o = obj
        for p in path: o = o[p] if isinstance(o, (dict, list)) else None
        return o.get('act') if isinstance(o, dict) else None
    while i < n:
        ch = text[i]
        if ch == '{' or ch == '[':
            if stack and stack[-1][0] == 'arr':
                path = stack[-1][1] + (stack[-1][4],); stack[-1][4] += 1
            elif stack: path = stack[-1][1] + (stack[-1][3],)
            else: path = ()
            stack.append(['obj' if ch == '{' else 'arr', path, True, None, 0]); i += 1; continue
        if ch == '}' or ch == ']': stack.pop(); i += 1; continue
        if ch == ':' and stack: stack[-1][2] = False; i += 1; continue
        if ch == ',' and stack:
            if stack[-1][0] == 'obj': stack[-1][2] = True
            i += 1; continue
        if ch == '"':
            j = i + 1
            while j < n and text[j] != '"': j += 2 if text[j] == '\\' else 1
            fr = stack[-1] if stack else None
            if fr and fr[0] == 'obj' and fr[2]: fr[3] = json.loads(text[i:j + 1])          # a key: choice
            elif fr and fr[0] == 'obj':
                key, act = fr[3], act_at(fr[1])
                if key not in ENUMS:
                    need = (FIELDS.get(act) or [[], []])[0]
                    for k in range(i + 1, j): cls[k] = 'req' if key in need else 'opt'
            i = j + 1; continue
        i += 1
    return cls

def signals(row):
    lp, raw = row.get('lp'), row.get('raw') or ''
    if not lp: return None
    text = ''.join(t for t, _ in lp)
    if text != raw: return None
    cls = char_classes(text)
    m = {'all': 1.0, 'choice': 1.0, 'req': 1.0, 'opt': 1.0}
    pos = 0
    for tok, logp in lp:
        p = math.exp(logp); m['all'] = min(m['all'], p)
        seen = set(cls[pos:pos + len(tok)]) if cls else {'choice'}
        for c in (seen or {'choice'}): m[c] = min(m[c], p)
        pos += len(tok)
    r = lambda x: round(x, 3)
    return {'A': r(m['all']), 'B': r(min(m['choice'], m['req'])), 'C': r(m['choice']), 'opt': r(m['opt'])}

def load(model):
    out, bad = [], 0
    for l in open(os.path.join(D, 'fields_%s.jsonl' % model)):
        x = json.loads(l); v, _, _ = grade(x['text'], x['label'], x['raw']); s = signals(x)
        if s is None: bad += 1; s = {'A': x['conf'], 'B': x['conf'], 'C': x['conf'], 'opt': None}
        elif x['conf'] is not None and abs(s['A'] - x['conf']) > 0.0015: print('  rule A ≠ readmodel conf', x['text'], s['A'], x['conf'])
        out.append(dict(x, verdict=v, sig=s))
    print('%s: %d rows, %d without token split (fall back to today\'s number)' % (model, len(out), bad))
    return out

def costs(rows, rule, b):
    c = lambda r: r['sig'][rule] if r['sig'][rule] is not None else -1
    aw = sum(1 for r in rows if r['verdict'] == 'WRONG' and c(r) >= b)
    vm = sum(1 for r in rows if r['verdict'] == 'MISS' and c(r) >= b)
    ar = sum(1 for r in rows if r['verdict'] == 'exact' and r['label'].get('act') != 'none' and FLOOR <= c(r) < b)
    return aw, vm, ar

def choose(T7, ref, label):
    bars = {}
    print('\n%s — allowed: ACTED-WRONG ≤ %d, VETO-MISS ≤ %d' % (label, ref[0], ref[1]))
    print('bar   ' + '   '.join('%s: AW  VM  ASK' % k for k in 'ABC'))
    for b in BARS:
        cells = []
        for k in 'ABC':
            aw, vm, ar = costs(T7, k, b); ok = aw <= ref[0] and vm <= ref[1]
            cells.append('%s %3d %3d %4d%s' % (k, aw, vm, ar, '*' if ok else ' '))
            if ok and k not in bars: bars[k] = b
        print('%.2f  %s' % (b, '  '.join(cells)))
    return bars

if __name__ == '__main__':
    r7, r5 = load(R7), load(R5)
    T = lambda rows: [r for r in rows if r['set'] != FRESH]
    F = lambda rows: [r for r in rows if r['set'] == FRESH]
    for name, rows in (('r7', r7), ('r5', r5)):
        tally = lambda xs: {k: sum(1 for r in xs if r['verdict'] == k) for k in ('exact', 'MISS', 'REFUSED', 'WRONG')}
        print(name, 'tuning', len(T(rows)), tally(T(rows)), '· fresh', len(F(rows)), tally(F(rows)))
    ref = costs(T(r5), 'A', 0.75)
    print('\nTUNING round 5, rule A at 0.75: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % ref)
    bars = choose(T(r7), ref, 'TUNING round 7')
    if not bars: print('\nNO RULE meets the limits at any bar → stop'); sys.exit(0)
    order = 'ABC'
    rule = min(bars, key=lambda k: (costs(T(r7), k, bars[k])[2], order.index(k)))
    b = bars[rule]
    print('\nbars per rule:', bars, '→ CHOSEN rule %s at %.2f (fewest ASK-ON-RIGHT on tuning; tie → A, then B, then C)' % (rule, b))
    res = {'bars': bars, 'rule': rule, 'bar': b}
    if rule == 'A': print('rule A = today\'s number → nothing new to confirm; stop'); json.dump(res, open(os.path.join(D, 'result.json'), 'w')); sys.exit(0)
    f7, f5 = costs(F(r7), rule, b), costs(F(r5), 'A', 0.75)
    print('FRESH  round 7, rule %s at %.2f: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % ((rule, b) + f7))
    print('FRESH  round 5, rule A at 0.75: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % f5)
    passes = all(x <= y for x, y in zip(f7, f5))
    print('CONFIRMATION', 'PASSES' if passes else 'FAILS', '(all three ≤ round 5)')
    print('(record) FRESH round 7, rule A at 0.70: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % costs(F(r7), 'A', 0.70))
    r5bars = choose(T(r5), ref, '(record) TUNING round 5 under the same rules')
    if rule in r5bars: print('(record) FRESH round 5, rule %s at %.2f: AW %d · VM %d · ASK %d' % ((rule, r5bars[rule]) + costs(F(r5), rule, r5bars[rule])))
    res.update(fresh_r7=f7, fresh_r5=f5, passes=passes, r5_bars=r5bars)
    json.dump(res, open(os.path.join(D, 'result.json'), 'w'))
