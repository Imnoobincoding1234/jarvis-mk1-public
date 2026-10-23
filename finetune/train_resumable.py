#!/usr/bin/env python3
"""A reader training run that carries on by itself after the guard stops it.

    train_resumable.py --name reader_round4 --data data/reader_round4 --iters 12000 \
        --resume-from adapters/reader_round3_c/adapters.safetensors \
        [--min-free 18 --min-battery 30 --max-seconds 36000 --max-child-gb 3.5 --max-pause 1800]

WHY. His word, 2026-09-28: "make sure if lid closes stuff only pauses not stop". Sleep already only
pauses (MLX freezes, guard.py's clock does not advance), and guard.py now PAUSES on passing pressure
instead of stopping. What is left is the stop a pause is not allowed to outlast (MAX_PAUSE, because a
paused child still holds its memory) and a refusal to start. Round 3 hit that three times and was
resumed by hand each time (reader_round3 → _b → _c). This does the same by itself:

  - each part runs under guard.py with the command in README "Reader round 3" (same hyper-parameters)
  - guard exit 97 (stopped) or 98 (refused to start): wait until the machine has been clear for
    CLEAR_FOR seconds (free ≥ MIN_FREE + 10, no thermal warning, on mains or battery ≥ MIN_BATTERY + 5),
    then continue from the part's last save into the next dir (<name>_b, _c, …), for the iterations left
  - a part that saved nothing is retried from the same starting point, in the same dir
  - the Metal GPU watchdog ("Impacting Interactivity") is carried on the same way, up to 10 in a row without a save
  - any other non-zero exit is a real failure: it stops and says so

Every part is recorded in runs/<name>.parts.json (dir, overall start iteration, iterations, resumed-from,
exit), so an overall iteration can always be mapped to a save, and running this again with the same
arguments continues where the record ends. The waits use time.sleep, which also stops while the Mac
sleeps — closing the lid never ends it.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import guard  # noqa: E402  (its readers: free_pct, thermal_warning, battery)

PY = os.path.join(HERE, '.venv', 'bin', 'python')
CLEAR_FOR = 120
POLL = 15


def last_save(d):
    best = 0
    for p in glob.glob(os.path.join(d, '*_adapters.safetensors')):
        m = re.match(r'(\d+)_adapters\.safetensors$', os.path.basename(p))
        if m:
            best = max(best, int(m.group(1)))
    return best


def machine_clear(a):
    f = guard.free_pct()
    if f is None or f < a.min_free + 10:
        return False, f'free {f}%'
    hot = guard.thermal_warning()
    if hot:
        return False, hot
    b = guard.battery()
    if b and not b[1] and b[0] < a.min_battery + 5:
        return False, f'battery {b[0]}% unplugged'
    return True, f'free {f}%'


def wait_until_clear(a):
    since = None
    last_note = 0
    while True:
        ok, why = machine_clear(a)
        now = time.monotonic()
        if ok:
            since = since or now
            if now - since >= CLEAR_FOR:
                log(f'machine clear for {CLEAR_FOR}s ({why}) — continuing')
                return
        else:
            since = None
            if now - last_note > 600:
                log(f'waiting for the machine to clear: {why}')
                last_note = now
        time.sleep(POLL)


def log(msg):
    print(f'[resumable {time.strftime("%H:%M:%S")}] {msg}', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--iters', type=int, required=True)
    ap.add_argument('--resume-from', required=True)
    ap.add_argument('--min-free', type=int, default=18)
    ap.add_argument('--min-battery', type=int, default=30)
    ap.add_argument('--max-seconds', type=float, default=36000)
    ap.add_argument('--max-child-gb', type=float, default=3.5)
    ap.add_argument('--max-pause', type=float, default=1800)
    a = ap.parse_args()
    os.chdir(HERE)

    record = os.path.join('runs', a.name + '.parts.json')
    parts = json.load(open(record)) if os.path.exists(record) else []
    suffixes = [''] + ['_' + chr(c) for c in range(ord('b'), ord('z') + 1)]

    while True:
        if parts and parts[-1].get('exit') == 0:
            log(f'finished: {a.iters} iterations, final = {parts[-1]["dir"]}/adapters.safetensors')
            return 0
        if parts:
            p = parts[-1]
            saved = last_save(p['dir'])
            if saved:
                start = p['start'] + saved
                resume = os.path.join(p['dir'], f'{saved:07d}_adapters.safetensors')
                d = os.path.join('adapters', a.name + suffixes[len(set(x['dir'] for x in parts))])
            else:
                start, resume, d = p['start'], p['resume_from'], p['dir']
        else:
            start, resume, d = 0, a.resume_from, os.path.join('adapters', a.name)
        left = a.iters - start
        if left <= 0:
            log(f'nothing left to train (overall {start} of {a.iters})')
            return 0
        logf = os.path.join('runs', 'train_' + os.path.basename(d) + '.log')
        part = {'dir': d, 'log': logf, 'start': start, 'iters': left, 'resume_from': resume,
                'began': time.strftime('%Y-%m-%d %H:%M:%S'), 'exit': None}
        parts.append(part)
        json.dump(parts, open(record, 'w'), indent=1)
        log(f'part {len(parts)}: {d} from overall {start}, {left} iterations, resuming {resume}; log {logf}')
        cmd = [PY, 'guard.py', '--min-free', str(a.min_free), '--min-battery', str(a.min_battery),
               '--max-seconds', str(a.max_seconds), '--max-child-gb', str(a.max_child_gb),
               '--max-pause', str(a.max_pause), '--',
               PY, 'run_lora.py', '-c', 'runs/bal_a.yaml', '--model', 'models/Qwen3.5-0.8B-4bit', '--train',
               '--data', a.data, '--adapter-path', d, '--fine-tune-type', 'lora',
               '--resume-adapter-file', resume,
               '--batch-size', '1', '--grad-accumulation-steps', '4', '--grad-checkpoint',
               '--learning-rate', '3e-5', '--iters', str(left),
               '--mask-prompt', '--max-seq-length', '256', '--num-layers', '16', '--save-every', '200',
               '--steps-per-eval', '1000', '--steps-per-report', '100', '--val-batches', '40']
        with open(logf, 'a') as out:
            code = subprocess.call(cmd, stdout=out, stderr=subprocess.STDOUT)
        part['exit'] = code
        part['ended'] = time.strftime('%Y-%m-%d %H:%M:%S')
        part['saved'] = last_save(d)
        json.dump(parts, open(record, 'w'), indent=1)
        log(f'part {len(parts)} exit {code}, last save {part["saved"]} (overall {start + part["saved"]})')
        if code == 0:
            continue
        if code in (97, 98):
            wait_until_clear(a)
            continue
        # THE GPU WATCHDOG. macOS kills a Metal command buffer that holds the GPU while the screen needs it —
        # MLX raises "[METAL] Command buffer execution failed: Impacting Interactivity
        # (…kIOGPUCommandBufferCallbackErrorImpactingInteractivity)". Round 4 died of it at 20:31 on 2026-09-28
        # (overall 5,400, a save just before) while he was using the Mac. Nothing is wrong with the run, so it
        # is carried on like a guard stop — matched on Metal's own error code, which is machine output. Ten in
        # a row without a new save means it is not passing, and it stops.
        tail = open(logf, errors='replace').read()[-6000:]
        if 'kIOGPUCommandBufferCallbackError' in tail:
            streak = 0
            for x in reversed(parts):
                if x.get('exit') in (0, 97, 98) or x.get('saved'):
                    break
                streak += 1
            if streak < 10:
                log(f'Metal GPU watchdog ended part {len(parts)} ({streak} in a row without a save) — carrying on')
                wait_until_clear(a)
                continue
        log(f'real failure (exit {code}) — stopping; see {logf}')
        return code


if __name__ == '__main__':
    sys.exit(main())
