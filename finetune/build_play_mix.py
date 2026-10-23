#!/usr/bin/env python3
"""Step 4 mix for the round-7 play top-up (README "Reader round 7 top-up — play labels"): the relabeled play rows (step 3) ×1 + the new
play rows (gen_play_topup.py) + an equal-sized replay of round 7's NON-play rows, stratified by act so nothing else is forgotten. Any
identical action reply at most 3 times (none replies are identical by nature and are not capped — capping them would remove the
negatives); rows whose text matches a protected file (held-out / hold / valid / exam / gate) dropped. Seed 7.
→ data/reader_play_topup/mix/{train,valid}.jsonl (valid = round 7's own, unchanged — it only reports a loss)."""
import json, os, random, re, collections, shutil
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(HERE, 'data'); T = os.path.join(D, 'reader_play_topup')
random.seed(7)
def load(p): return [json.loads(l) for l in open(p)]
def acts(r):
    a = json.loads(r['messages'][2]['content']); return [s['act'] for s in (a['steps'] if a['act'] == 'multi' else [a])], a['act']
def norm(s): return ' '.join(w for w in re.split(r'[^\w]+', str(s).lower()) if w)
relab, new = load(os.path.join(T, 'play_relabeled.jsonl')), load(os.path.join(T, 'new_play.jsonl'))
r7 = load(os.path.join(D, 'reader_round7', 'train.single.jsonl'))
nonplay = [r for r in r7 if 'play' not in acts(r)[0]]
by = collections.defaultdict(list)
for r in nonplay: by[acts(r)[1]].append(r)
want = len(relab) + len(new)
replay = []
for act, rs in sorted(by.items()):
    k = max(1, round(want * len(rs) / len(nonplay))); replay += random.sample(rs, min(k, len(rs)))
prot = set()
from gen_play_topup import protected_files
for p in protected_files():
    for line in open(p, errors='ignore'):
        try: x = json.loads(line)
        except Exception: continue
        if isinstance(x, dict) and isinstance(x.get('text'), str): prot.add(norm(x['text']))
        elif isinstance(x, dict) and isinstance(x.get('messages'), list):
            for m in x['messages']:
                if m.get('role') == 'user': prot.add(norm(m['content']))
mix, dropped = [], collections.Counter()
seen_reply = collections.Counter()
for src, rows in (('new', new), ('relabeled', relab), ('replay', replay)):
    for r in rows:
        if norm(r['messages'][1]['content']) in prot and src != 'new': dropped['protected text (' + src + ')'] += 1; continue
        rep = r['messages'][2]['content']
        if json.loads(rep)['act'] != 'none' and seen_reply[rep] >= 3: dropped['reply already 3× (' + src + ')'] += 1; continue
        seen_reply[rep] += 1; mix.append((src, r))
random.shuffle(mix)
os.makedirs(os.path.join(T, 'mix'), exist_ok=True)
with open(os.path.join(T, 'mix', 'train.jsonl'), 'w') as f:
    for _, r in mix: f.write(json.dumps(r, ensure_ascii=False) + '\n')
shutil.copy(os.path.join(D, 'reader_round7', 'valid.jsonl'), os.path.join(T, 'mix', 'valid.jsonl'))
src_n = collections.Counter(s for s, _ in mix)
act_n = collections.Counter(acts(r)[1] for _, r in mix)
print('mix rows', len(mix), dict(src_n), '· dropped', dict(dropped))
print('distinct inputs', len({r['messages'][1]['content'] for _, r in mix}), '· distinct replies', len({r['messages'][2]['content'] for _, r in mix}),
      '· max action-reply repeats', max(c for rep, c in seen_reply.items() if json.loads(rep)['act'] != 'none'))
print('top-level acts:', dict(act_n.most_common()))
