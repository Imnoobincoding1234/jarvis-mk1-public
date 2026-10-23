# Regression gate diff: baseline run vs after-fix run, per line. Reads the scorer's .scored.json of both runs (scorer v2
# `base` verdict = the decision verdict before any unread-claim masking) and JARVIS's own route/decision record.
# Prints: verdict flips (PASS→not, not→PASS, new WRONG), decision changes with identical verdicts, and a count of
# reply-only changes. A changed message body counts as a decision change (read it). Usage: gate_diff.py <base-tag> <after-tag> [sets...]
import json, sys, os
R = os.path.expanduser('~/JARVIS MK-1/finetune/data/casual_runs')
base_tag, after_tag = sys.argv[1], sys.argv[2]
sets = sys.argv[3:] or ['live', 'v3', 'v2', 'dev']

def load(tag, s):
    sc = os.path.join(R, 'gate-%s-%s.scored.json' % (tag, s)); raw = os.path.join(R, 'gate-%s-%s.jsonl' % (tag, s))
    if not os.path.exists(sc) or not os.path.exists(raw): return None
    S = {x['id']: x for x in json.load(open(sc))}
    for l in open(raw):
        r = json.loads(l)
        if r['id'] in S: S[r['id']]['route_full'] = r.get('route') or ''; S[r['id']]['confirm'] = r.get('confirm')
    return S

def dec(x):
    rk = (x.get('route_full') or '').split(' (')[0]
    rk = rk.split(':')[0] + (':' + rk.split(':')[1] if ':' in rk else '')
    # A message's body is part of its decision (scorer v3 reads bodies by hand), so a changed body is listed for reading.
    acts = sorted(set(d.get('act', '') + ('>' + str(d.get('target') or d.get('to') or ''))[:30] +
                      ('|' + str(d.get('body') or '') if d.get('act') == 'message' else '') for d in x.get('ds', []) if not d.get('soft')))
    c = (x.get('confirm') or {}).get('tool') if x.get('confirm') else None
    return (rk, tuple(acts), c)

tot = {'lines': 0, 'pass_base': 0, 'pass_after': 0, 'lost': 0, 'gained': 0, 'new_wrong': 0, 'dec_changed': 0, 'reply_only': 0}
for s in sets:
    B, A = load(base_tag, s), load(after_tag, s)
    if B is None or A is None: print('-- %s: missing run(s)' % s); continue
    print('==== %s (%d base, %d after)' % (s, len(B), len(A)))
    for i in B:
        if i not in A: print('  MISSING after:', i); continue
        b, a = B[i], A[i]; tot['lines'] += 1
        vb, va = b.get('base', b['verdict']), a.get('base', a['verdict'])
        tot['pass_base'] += vb == 'PASS'; tot['pass_after'] += va == 'PASS'
        db, da = dec(b), dec(a)
        tag = None
        if vb == 'PASS' and va != 'PASS': tag = 'LOST'; tot['lost'] += 1
        elif vb != 'PASS' and va == 'PASS': tag = 'GAINED'; tot['gained'] += 1
        if va == 'WRONG' and vb != 'WRONG': tag = (tag + '+' if tag else '') + 'NEW-WRONG'; tot['new_wrong'] += 1
        if not tag and db != da: tag = 'DECISION'; tot['dec_changed'] += 1
        if not tag and (b.get('reply') or '') != (a.get('reply') or ''): tot['reply_only'] += 1
        if tag:
            print('  %-14s %-6s %s→%s  %s' % (tag, i, vb, va, b['text'][:60]))
            print('       base : %s | %s' % (db, (b.get('reply') or '')[:110].replace('\n', ' ')))
            print('       after: %s | %s' % (da, (a.get('reply') or '')[:110].replace('\n', ' ')))
print('\nTOTAL', json.dumps(tot))
