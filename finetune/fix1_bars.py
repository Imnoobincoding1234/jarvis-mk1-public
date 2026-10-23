#!/usr/bin/env python3
"""Fix 1 (README "No-training fixes 1 + 2"): choose the READ-ONLY and LOW-STAKES bars by the pre-registered rule — on round 8's live
readings of the 13 READ sets, b_T = the lowest of 0.30 … 0.70 with 4 × ADDED-WRONG(b) ≤ ASKS-SAVED(b), tier by the act the reading names."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from eval_reader import grade
import play_topup_grade as G
READ_ONLY = {'time', 'weather', 'calendar', 'system_status', 'list_running', 'search_web', 'search_files', 'read', 'list', 'study_stats', 'dream_log'}
LOW_STAKES = {'play', 'open', 'pause', 'resume', 'next_track', 'volume_up', 'volume_down', 'screenshot', 'sleep_display', 'remind', 'note',
              'create_folder', 'create_file', 'quiz_me'}
FLOOR, TOP = 0.3, 0.70
BARS = [round(0.30 + 0.05 * i, 2) for i in range(9)]
rows = []
for l in open(os.path.join(HERE, 'runs', 'round8_20261017', 'live_jarvis-reader-r8.jsonl')):
    r = json.loads(l); src = G.labels(r['set'])[r['text']]
    try: act = json.loads(r['raw']).get('act')
    except Exception: act = None
    rows.append(dict(v=grade(r['text'], src['label'], r['raw'])[0], act=act, conf=r['conf'] if r['conf'] is not None else -1, text=r['text']))
out = {}
for name, T in (('READ_ONLY', READ_ONLY), ('LOW_STAKES', LOW_STAKES)):
    rs = [r for r in rows if r['act'] in T]
    print('%s — %d readings' % (name, len(rs)))
    chosen = TOP
    for b in BARS:
        added = sum(1 for r in rs if r['v'] == 'WRONG' and b <= r['conf'] < TOP)
        saved = sum(1 for r in rs if r['v'] == 'exact' and FLOOR <= r['conf'] < TOP and r['conf'] >= b)
        ok = 4 * added <= saved
        print('   %.2f  ADDED-WRONG %2d  ASKS-SAVED %2d  %s' % (b, added, saved, 'ok' if ok else '–'))
        if ok and b < chosen and chosen == TOP: chosen = b
    out[name] = chosen
    print('   → bar %.2f' % chosen)
json.dump(out, open(os.path.join(HERE, 'runs', 'round8_20261017', 'fix1_bars.json'), 'w'))
