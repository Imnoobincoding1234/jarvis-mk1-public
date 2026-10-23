#!/usr/bin/env python3
"""New play rows for the round-7 play top-up (README "Reader round 7 top-up — play labels", step 4) — TRAINING MATERIAL ONLY, never read at
runtime. Written by hand 2026-10-16 after step 3, for the shapes the relabeled data is thin on: a video with no platform named, Hinglish
video, front words (some / a / koi / kuch / ek / thoda …) on music, a platform + video, music services. Labels by LABELING.md "Play — the
words that name the thing, and `video`". Checked: every value is a copy (readmodel.shapeError), no near-copy (exact or ≥ 0.75
word-Jaccard) of ANY held-out, hold, gate or validation file, no near-copy of each other. → data/reader_play_topup/new_play.jsonl"""
import json, os, re, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = "Read the message as one JARVIS action. Reply with JSON only. Copy the user's words exactly."
def p(q, where=None, video=False):
    s = {'act': 'play', 'query': q}
    if where: s['where'] = where
    if video: s['video'] = True
    return s
V = dict(video=True)
ROWS = [
  # a video, no platform named — English
  ('play a quick ab workout video', p('a quick ab workout video', **V)), ('put on a lofi animation video', p('a lofi animation video', **V)),
  ('play some old tom and jerry clips', p('some old tom and jerry clips', **V)), ('find me a vid on how to fold a shirt', p('how to fold a shirt', **V)),
  ('play the new apple event video', p('the new apple event video', **V)), ('watch a short film', p('a short film', **V)),
  ('play some street food vlogs', p('some street food vlogs', **V)), ('put on a car review video', p('a car review video', **V)),
  ('play a few minecraft shorts', p('a few minecraft shorts', **V)), ('watch the latest sidemen sunday video', p('the latest sidemen sunday video', **V)),
  ('play some funny dog clips', p('some funny dog clips', **V)), ('put on a pasta recipe video', p('a pasta recipe video', **V)),
  ('play a 10 minute hiit video', p('a 10 minute hiit video', **V)), ('watch some asmr videos', p('some asmr videos', **V)),
  ('play the trailer for the new spiderman', p('the trailer for the new spiderman', **V)), ('put on a guitar cover video', p('a guitar cover video', **V)),
  ('play a space documentary', p('a space documentary', **V)), ('watch the new veritasium video', p('the new veritasium video', **V)),
  ('play some old cricket match highlights', p('some old cricket match highlights', **V)), ('put on a movie trailer', p('a movie trailer', **V)),
  ('play a cat compilation', p('a cat compilation', **V)), ('watch a podcast clip from joe rogan', p('a podcast clip from joe rogan', **V)),
  ('play the latest kurzgesagt video', p('the latest kurzgesagt video', **V)), ('put on some speedrun videos', p('some speedrun videos', **V)),
  ('play a travel vlog from japan', p('a travel vlog from japan', **V)), ('watch a chess game recap', p('a chess game recap', **V)),
  ('play some tech unboxing videos', p('some tech unboxing videos', **V)), ('play a yoga for beginners video', p('a yoga for beginners video', **V)),
  ('put on a 15 minute stretching video', p('a 15 minute stretching video', **V)), ('play a short cartoon', p('a short cartoon', **V)),
  ("watch mkbhd's phone review", p("mkbhd's phone review", **V)), ('play some magic trick videos', p('some magic trick videos', **V)),
  ('put on a gaming montage', p('a gaming montage', **V)), ('play a funny compilation lol', p('a funny compilation', **V)),
  ('can u play a science experiment video', p('a science experiment video', **V)),
  # a video, no platform named — Hinglish
  ('ek stand up comedy video lagao', p('ek stand up comedy video', **V)), ('koi gaming video chala', p('koi gaming video', **V)),
  ('kuch funny clips dikha do', p('kuch funny clips', **V)), ('bhuvan bam ka naya video chala', p('bhuvan bam ka naya video', **V)),
  ('ek recipe ka video laga do', p('ek recipe ka video', **V)), ('koi motivational video dikhao', p('koi motivational video', **V)),
  ('kuch science ke videos chala de', p('kuch science ke videos', **V)), ('ek short film dikha', p('ek short film', **V)),
  ('dhruv rathee ki nayi video lagao', p('dhruv rathee ki nayi video', **V)), ('koi purana cartoon chala do', p('koi purana cartoon', **V)),
  ('kuch travel vlogs dikhao', p('kuch travel vlogs', **V)), ('ek movie trailer chala', p('ek movie trailer', **V)),
  ('koi cricket highlights ka video laga', p('koi cricket highlights ka video', **V)), ('kuch unboxing videos chalao', p('kuch unboxing videos', **V)),
  ('ek yoga video laga do', p('ek yoga video', **V)), ('thoda comedy dikhao', p('thoda comedy', **V)),
  ('koi documentary dikha do', p('koi documentary', **V)), ('kuch magic tricks ke video chala', p('kuch magic tricks ke video', **V)),
  ('samay raina ka koi clip chala do', p('samay raina ka koi clip', **V)), ('ek gaming stream dikhao', p('ek gaming stream', **V)),
  ('kuch old songs ke video chala do', p('kuch old songs ke video', **V)), ('excel ka koi tutorial video chala de', p('excel ka koi tutorial video', **V)),
  ('ek hindi movie ka trailer dikha', p('ek hindi movie ka trailer', **V)), ('kuch dance videos lagao', p('kuch dance videos', **V)),
  ('mrbeast ka koi video chala', p('mrbeast ka koi video', **V)),
  # front words on music — English
  ('play some old linkin park', p('some old linkin park')), ('put on a few chill tracks', p('a few chill tracks')),
  ('play some soft piano music', p('some soft piano music')), ('throw on a sad playlist', p('a sad playlist')),
  ('play some 2000s pop', p('some 2000s pop')), ('queue up some kanye', p('some kanye')), ('play a mellow song', p('a mellow song')),
  ('put on some workout bangers', p('some workout bangers')), ('play some classic bollywood', p('some classic bollywood')),
  ('play a couple of arijit songs', p('a couple of arijit songs')), ('blast some punjabi bangers', p('some punjabi bangers')),
  ('put on a nice instrumental', p('a nice instrumental')), ('play some lo-fi for studying', p('some lo-fi for studying')),
  ('throw on some old school rap', p('some old school rap')), ('play a random bollywood song', p('a random bollywood song')),
  ('play some coldplay songs', p('some coldplay songs')), ('put on some rainy day jazz', p('some rainy day jazz')),
  ('play a few songs by the weeknd', p('a few songs by the weeknd')), ('queue up some focus beats', p('some focus beats')),
  ('play some sufi music', p('some sufi music')), ('put on a happy playlist', p('a happy playlist')), ('play some country songs', p('some country songs')),
  ('bump some drill', p('some drill')), ('play a slow romantic song', p('a slow romantic song')), ('throw on some edm for the gym', p('some edm for the gym')),
  # front words on music — Hinglish
  ('kuch purani ghazals chala do', p('kuch purani ghazals')), ('koi naya punjabi gaana bajao', p('koi naya punjabi gaana')),
  ('ek romantic gaana laga do', p('ek romantic gaana')), ('thoda arijit chala do', p('thoda arijit')), ('kuch party songs bajao', p('kuch party songs')),
  ('koi sad song chala de', p('koi sad song')), ('kuch english songs laga', p('kuch english songs')), ('thoda lofi chala de', p('thoda lofi')),
  ('ek dance number bajao', p('ek dance number')), ('koi 90s ka gaana chala', p('koi 90s ka gaana')), ('kuch shaant music lagao', p('kuch shaant music')),
  ('thoda diljit bajao yaar', p('thoda diljit')), ('koi motivational gaana chala do', p('koi motivational gaana')), ('kuch bhajan laga do', p('kuch bhajan')),
  ('ek accha sa english gaana bajao', p('ek accha sa english gaana')), ('koi rap song chala', p('koi rap song')),
  ('kuch nusrat sahab ki qawwali chala do', p('kuch nusrat sahab ki qawwali')), ('thoda old school bollywood chala', p('thoda old school bollywood')),
  ('koi garba song laga do', p('koi garba song')), ('kuch slow punjabi chala de', p('kuch slow punjabi')), ('ek lori bajao', p('ek lori')),
  ('koi chill playlist laga', p('koi chill playlist')), ('kuch hits of the week chala do', p('kuch hits of the week')), ('thoda jazz bajao', p('thoda jazz')),
  ('koi workout wala gaana chala', p('koi workout wala gaana')),
  # a platform, and video
  ('play some cooking shorts on youtube', p('some cooking shorts', 'youtube', True)), ('put on a nature documentary on netflix', p('a nature documentary', 'netflix', True)),
  ('play a random podcast on yt', p('a random podcast', 'yt', True)), ('watch some old wwe clips on youtube', p('some old wwe clips', 'youtube', True)),
  ('play the new ipl highlights on hotstar', p('the new ipl highlights', 'hotstar', True)), ('open youtube and play some rain videos', p('some rain videos', 'youtube', True)),
  ('play a kids cartoon on youtube', p('a kids cartoon', 'youtube', True)), ('put on some 90s songs on youtube', p('some 90s songs', 'youtube', True)),
  ('play arijit live concert on yt', p('arijit live concert', 'yt', True)), ('watch a thriller on prime video', p('a thriller', 'prime video', True)),
  ('youtube pe kuch funny shorts chala', p('kuch funny shorts', 'youtube', True)), ('yt pe koi tech review laga', p('koi tech review', 'yt', True)),
  ('netflix pe ek comedy show laga do', p('ek comedy show', 'netflix', True)), ('youtube pe thoda lofi chala de', p('thoda lofi', 'youtube', True)),
  ('yt pe kuch purane gaane chalao', p('kuch purane gaane', 'yt', True)), ('youtube pe ek recipe video dikhao', p('ek recipe video', 'youtube', True)),
  ('hotstar pe koi match highlights chala', p('koi match highlights', 'hotstar', True)), ('youtube khol ke kuch gaming videos chala', p('kuch gaming videos', 'youtube', True)),
  ('prime pe koi web series laga do', p('koi web series', 'prime', True)), ('yt pe ek short film dikha', p('ek short film', 'yt', True)),
  # music services — never video
  ('play some arijit on spotify', p('some arijit', 'spotify')), ('put on a chill mix on spotify', p('a chill mix', 'spotify')),
  ('play some old hindi songs on jiosaavn', p('some old hindi songs', 'jiosaavn')), ('throw on a workout playlist on spotify', p('a workout playlist', 'spotify')),
  ('play some drake on apple music', p('some drake', 'apple music')), ('spotify pe kuch naye gaane chala', p('kuch naye gaane', 'spotify')),
  ('spotify pe koi chill playlist laga', p('koi chill playlist', 'spotify')), ('jiosaavn pe thoda sufi bajao', p('thoda sufi', 'jiosaavn')),
  ('play a random playlist on spotify', p('a random playlist', 'spotify')), ('put on some kpop on spotify', p('some kpop', 'spotify')),
  ('spotify pe ek party mix laga do', p('ek party mix', 'spotify')), ('play some taylor swift on apple music', p('some taylor swift', 'apple music')),
  ('yt music pe kuch punjabi chala', p('kuch punjabi', 'yt music')), ('play some ghazals on yt music', p('some ghazals', 'yt music')),
  ('play some old classics on spotify', p('some old classics', 'spotify')),
]
def norm(s): return ' '.join(w for w in re.split(r'[^\w]+', str(s).lower()) if w)
def jac(a, b): return len(a & b) / max(1, len(a | b))
def protected_files():
    """Every file that measures a reader: held-outs, holds, validation and exam files, gate sets and gate runs."""
    out, D = [], os.path.join(HERE, 'data')
    for root, _, files in os.walk(D):
        for f in files:
            p = os.path.join(root, f)
            if not re.search(r'\.(jsonl?|tsv)$', f) or os.path.getsize(p) > 200e6: continue
            if re.search(r'(heldout|valid|exam|calib|casual_stress|casual_bugs|casual_runs|gate)', p) and 'reader_play_topup' not in p: out.append(p)
    return out
if __name__ == '__main__':
    rows = [{'text': t, 'label': l} for t, l in ROWS]
    chk = subprocess.run(['node', '-e', """const RM = require(process.argv[1]); RM.init({ laterOn: () => true });
      const xs = JSON.parse(require('fs').readFileSync(0, 'utf8')); let bad = 0;
      for (const x of xs) { const e = RM.shapeError(x.text, x.label); if (e) { bad++; console.log('SHAPE', JSON.stringify(x.text), e); } }
      console.log('shape errors', bad);""", os.path.join(HERE, '..', 'jarvis-os', 'readmodel.js')], input=json.dumps(rows), capture_output=True, text=True)
    print(chk.stdout.strip() or chk.stderr.strip())
    mine = [(r, set(norm(r['text']).split())) for r in rows]
    hits, n_str = {}, 0
    for p in protected_files():
        for line in open(p, errors='ignore'):
            vals = []
            try:
                def walk(v):
                    if isinstance(v, str): vals.append(v)
                    elif isinstance(v, dict): [walk(x) for x in v.values()]
                    elif isinstance(v, list): [walk(x) for x in v]
                walk(json.loads(line))
            except Exception: vals.append(line)
            for v in vals:
                if not (6 <= len(v) <= 400): continue
                n_str += 1; w = set(norm(v).split())
                for r, rw in mine:
                    if r['text'] in hits: continue
                    if norm(v) == norm(r['text']) or jac(rw, w) >= 0.75: hits[r['text']] = (v, os.path.relpath(p, HERE))
    self_ = [(a['text'], b['text']) for i, (a, aw) in enumerate(mine) for (b, bw) in mine[i + 1:] if jac(aw, bw) >= 0.75]
    for t, (v, p) in hits.items(): print('NEAR', repr(t), '≈', repr(v), '←', p)
    for a, b in self_: print('SELF', repr(a), repr(b))
    print('rows', len(rows), '· protected strings', n_str, '· near', len(hits), '· self', len(self_), '· Hinglish (tagged by hand)',
          64)
    keep = [r for r in rows if r['text'] not in hits and not any(r['text'] == b for _, b in self_)]
    out = os.path.join(HERE, 'data', 'reader_play_topup', 'new_play.jsonl')
    with open(out, 'w') as f:
        for r in keep: f.write(json.dumps({'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': r['text']},
            {'role': 'assistant', 'content': json.dumps(r['label'], ensure_ascii=False, separators=(',', ':'))}]}, ensure_ascii=False) + '\n')
    print('wrote', len(keep), 'rows →', os.path.relpath(out, HERE))
