# carry_grades.py — TAG=<gate tag> python3 carry_grades.py [sets…]: rescore a gate run, carry hand reads of message bodies from
# earlier gates for identical (text, body) pairs, and list the NEW bodies and the time / weather REVIEW rows still to read by hand.
# Add each finished gate tag to the list below so its reads carry forward. Written 2026-10-17 in-session.
# Carry hand reads (message bodies) from earlier gates to gate r8-20261017 for identical (text, body); list new bodies and time/weather rows.
import json, os, subprocess, sys
R = os.path.expanduser('~/JARVIS MK-1/finetune/data/casual_runs/'); J = os.path.expanduser('~/JARVIS MK-1/jarvis-os')
TAG = os.environ.get('TAG', 'r8-20261017'); sets = sys.argv[1:] or ['live', 'v3', 'v2', 'dev']
seen = {}
for tag in ['base-20261014','fix2-20261015','prerestart-20261016','prerestart2-20261016','r7-20261016','r7cal-20261016','r7calrerun-20261016','r8-20261017','r8rerun-20261017','r8fix-20261017','r8fixrerun-20261017','live5-20261017','live5b-20261017','mpfix-20261019','mpfixrerun-20261019','c2k-20261022','c2krerun-20261022','c2kfix-20261022','c2kfixrerun-20261022','arbtie-20261024','arbtierun-20261024','quickfive-20261024']:
    for s in ['live','v3','v2','dev']:
        f = R + f'gate-{tag}-{s}.grades.json'; sc = R + f'gate-{tag}-{s}.scored.json'
        if not (os.path.exists(f) and os.path.exists(sc)): continue
        g = json.load(open(f)); S = {x['id']: x for x in json.load(open(sc))}
        for i, e in g.items():
            if 'invented' in e and i in S:
                seen[(S[i]['text'], tuple(str(d.get('body') or '') for d in S[i]['ds'] if d['act'] == 'message'))] = (e['invented'], e.get('invented_note', ''), e.get('verdict'))
for s in sets:
    run = R + f'gate-{TAG}-{s}.jsonl'
    if not os.path.exists(run): continue
    subprocess.run(['node', J + '/sweeps/score_casual.js', run], capture_output=True)
    f = run.replace('.jsonl', '.grades.json'); g = json.load(open(f)) if os.path.exists(f) else {}
    new = []
    for x in json.load(open(run.replace('.jsonl', '.scored.json'))):
        if not x.get('bodyUnread'): continue
        k = (x['text'], tuple(str(d.get('body') or '') for d in x['ds'] if d['act'] == 'message'))
        if k in seen:
            e = g.setdefault(x['id'], {}); e['invented'] = seen[k][0]; e['invented_note'] = 'same body as read before → ' + seen[k][1].split(': ', 1)[-1]
            if seen[k][2]: e['verdict'] = seen[k][2]
        else: new.append((x['id'], x['text'], k[1]))
    json.dump(g, open(f, 'w'), indent=1, ensure_ascii=False)
    subprocess.run(['node', J + '/sweeps/score_casual.js', run], capture_output=True)
    print('==', s, '· NEW bodies', len(new))
    for i, t, b in new: print('   [%s] %s\n        body: %s' % (i, t, ' · '.join(json.dumps(z, ensure_ascii=False) for z in b)))
    sheet = subprocess.run(['node', J + '/sweeps/score_casual.js', run, '--sheet'], capture_output=True, text=True).stdout.split('\n')
    tw = [(sheet[n], sheet[n + 1] if n + 1 < len(sheet) else '') for n, l in enumerate(sheet) if ('time answer' in l or 'weather answer' in l) and ' | ' in l]
    print('   time/weather rows to read:', len(tw))
    for a, b in tw: print('   ', a[:150], '\n     ', b.strip()[:200])
