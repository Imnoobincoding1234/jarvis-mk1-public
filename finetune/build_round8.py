#!/usr/bin/env python3
"""Reader round 8 data (README "Reader round 8 — round 7's whole data, play cleaned"): round 7's own training file at its own weights,
with the step-3 play relabels applied and the 16 unclear rows dropped, rows whose text is in a measurement set dropped, the 142 new play
rows added ×1. Identical INPUTS at most twice (round 7's weight); replies are not capped (field-less acts read identically by design).
→ data/reader_round8/{train,valid}.jsonl. No model."""
import json, os, re, collections, random
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(HERE, 'data'); T = os.path.join(D, 'reader_play_topup')
def load(p): return [json.loads(l) for l in open(p)]
def norm(s): return ' '.join(w for w in re.split(r'[^\w]+', str(s).lower()) if w)
def text(r): return r['messages'][1]['content']
def acts(content):
    a = json.loads(content); return a['act'], [s['act'] for s in (a['steps'] if a['act'] == 'multi' else [a])]
# the measurement sets: every held-out / hold / exam / calibration / gate file at the top of data/ (+ reader_mid/valid_clean)
MEASURE = [os.path.join(D, f) for f in os.listdir(D) if re.search(r'(heldout|_valid\.jsonl$|exam|calib|casual_stress|casual_bugs|round8_fresh)', f)
           and re.search(r'\.jsonl?$', f)] + [os.path.join(D, 'reader_mid', 'valid_clean.jsonl')]
prot = set()
for p in MEASURE:
    raw = open(p).read()
    try: items = json.loads(raw) if p.endswith('.json') else [json.loads(l) for l in raw.split('\n') if l.strip()]
    except Exception: continue
    for x in (items if isinstance(items, list) else []):
        if isinstance(x, dict):
            for k in ('text', 'input', 'q', 'user'):
                if isinstance(x.get(k), str): prot.add(norm(x[k]))
relab = {text(r): r['messages'][2]['content'] for r in load(os.path.join(T, 'play_relabeled.jsonl'))}
view = json.load(open(os.path.join(T, 'play_view.json')))
import sys; sys.path.insert(0, T); from decisions import D as DEC
drop_txt = {v['text'] for v in view if DEC.get(v['i'], {}).get('drop')}
r7 = load(os.path.join(D, 'reader_round7', 'train.jsonl'))
out, why, seen = [], collections.Counter(), collections.Counter()
for r in r7:
    t = text(r)
    if t in drop_txt: why['unclear play row (step 3)'] += 1; continue
    if norm(t) in prot: why['text in a measurement set'] += 1; continue
    if seen[t] >= 2: why['input already twice'] += 1; continue
    if t in relab and relab[t] != r['messages'][2]['content']:
        r = json.loads(json.dumps(r)); r['messages'][2]['content'] = relab[t]; why['relabeled (kept)'] += 1
    seen[t] += 1; out.append(r)
new = load(os.path.join(T, 'new_play.jsonl'))
for r in new:
    if norm(text(r)) in prot or seen[text(r)] >= 2: why['new row skipped'] += 1; continue
    seen[text(r)] += 1; out.append(r)
random.seed(8); random.shuffle(out)
os.makedirs(os.path.join(D, 'reader_round8'), exist_ok=True)
with open(os.path.join(D, 'reader_round8', 'train.jsonl'), 'w') as f:
    for r in out: f.write(json.dumps(r, ensure_ascii=False) + '\n')
vals, vfix = load(os.path.join(D, 'reader_round7', 'valid.jsonl')), 0
for r in vals:
    t = text(r)
    if t in relab and relab[t] != r['messages'][2]['content']: r['messages'][2]['content'] = relab[t]; vfix += 1
with open(os.path.join(D, 'reader_round8', 'valid.jsonl'), 'w') as f:
    for r in vals: f.write(json.dumps(r, ensure_ascii=False) + '\n')
c7, c8 = collections.Counter(acts(r['messages'][2]['content'])[0] for r in r7), collections.Counter(acts(r['messages'][2]['content'])[0] for r in out)
print('measurement files', len(MEASURE), '· protected texts', len(prot))
print('round 7 rows', len(r7), '→ round 8 rows', len(out), '·', dict(why), '· valid rows relabeled', vfix)
print('distinct inputs', len({text(r) for r in out}), '· distinct replies', len({r['messages'][2]['content'] for r in out}))
print('%-14s %6s %6s' % ('act', 'r7', 'r8'))
for a, n in c7.most_common(): print('%-14s %6d %6d%s' % (a, n, c8.get(a, 0), '   ←' if abs(c8.get(a, 0) - n) > max(3, 0.05 * n) else ''))
