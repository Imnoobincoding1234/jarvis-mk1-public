#!/usr/bin/env python3
"""Round 7 play top-up (README "Reader round 7 top-up — play labels"): tallies for steps 2, 5 and 6.
Offline: eval_reader.py dumps (runs/play_topup_20261016/offline_<adapter>.jsonl) per set, and play_heldout_v1 per kind (play / lookalike /
other). Live: sweep_reader_conf.js rows (live_<model>.jsonl) on play_heldout_v1 graded by eval_reader.grade, with the three costs at 0.70
and 0.75. Labels are re-read from the data files at grading time, so the 2026-10-16 relabels always count.
  python3 play_topup_grade.py [adapter …] [--live model …]"""
import json, os, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from eval_reader import grade
O = os.path.join(HERE, 'runs', 'play_topup_20261016')
FLOOR = 0.3
HOLD6 = ['valid_clean.jsonl', 'patterns_heldout.jsonl', 'negatives_heldout.jsonl', 'round2_valid.jsonl', 'round3_valid.jsonl', 'round4_valid.jsonl']
PATHS = {'valid_clean.jsonl': 'data/reader_mid/valid_clean.jsonl'}
def path_of(name): return os.path.join(HERE, PATHS.get(name, 'data/' + name))
_lab = {}
def labels(name):
    if name not in _lab:
        _lab[name] = {}
        for l in open(path_of(name)):
            r = json.loads(l); _lab[name][r['text']] = r
    return _lab[name]
def tally(rows): return collections.Counter(r['v'] for r in rows)
fmt = lambda c: '%3d exact / %2d MISS / %2d REFUSED / %2d WRONG' % (c['exact'], c['MISS'], c['REFUSED'], c['WRONG'])

def offline(adapter):
    rows = []
    for l in open(os.path.join(O, 'offline_%s.jsonl' % adapter)):
        r = json.loads(l); src = labels(r['set'])[r['text']]
        r['v'] = grade(r['text'], src['label'], r['raw'])[0]; r['kind'] = src.get('kind'); rows.append(r)
    by = collections.defaultdict(list)
    for r in rows: by[r['set']].append(r)
    print('\nOFFLINE', adapter)
    for k in ('play', 'lookalike', 'other'):
        print('  play_heldout_v1 %-9s %s' % (k, fmt(tally([r for r in by['play_heldout_v1.jsonl'] if r['kind'] == k]))))
    h6 = [r for s in HOLD6 for r in by[s]]
    print('  six hold files            %s' % fmt(tally(h6)))
    for s in ['round5_valid.jsonl', 'round6_valid.jsonl', 'round7_valid.jsonl', 'bonsai_reader_heldout_v1.jsonl', 'reader_calib_fresh_v1.jsonl', 'reader_calib_fresh_v2.jsonl']:
        print('  %-25s %s' % (s.replace('.jsonl', ''), fmt(tally(by[s]))))
    return by

def live(model):
    rows = []
    for l in open(os.path.join(O, 'live_%s.jsonl' % model)):
        r = json.loads(l); src = labels('play_heldout_v1.jsonl')[r['text']]
        r['v'] = grade(r['text'], src['label'], r['raw'])[0]; r['kind'] = src['kind']; r['label'] = src['label']; rows.append(r)
    c = lambda r: r['conf'] if r['conf'] is not None else -1
    print('\nLIVE', model, '— play_heldout_v1', fmt(tally(rows)))
    for b in (0.70, 0.75):
        for k in ('play', 'lookalike', 'other', None):
            rs = [r for r in rows if k is None or r['kind'] == k]
            aw = sum(1 for r in rs if r['v'] == 'WRONG' and c(r) >= b); vm = sum(1 for r in rs if r['v'] == 'MISS' and c(r) >= b)
            ar = sum(1 for r in rs if r['v'] == 'exact' and r['label'].get('act') != 'none' and FLOOR <= c(r) < b)
            print('  at %.2f %-9s ACTED-WRONG %2d · VETO-MISS %2d · ASK-ON-RIGHT %2d' % (b, k or 'all', aw, vm, ar))
    return rows

if __name__ == '__main__':
    a = sys.argv[1:]; lv = a[a.index('--live') + 1:] if '--live' in a else []; ad = a[:a.index('--live')] if '--live' in a else a
    for x in ad: offline(x)
    for m in lv: live(m)
