#!/usr/bin/env python3
"""Run a training command under a memory watchdog, so an 8 GB Mac is never pushed into a lockup.

MLX's own memory limit is a guideline, not a ceiling: its documentation says allocations only fail
once RAM *and swap* are gone, which is exactly the state that freezes this machine. So the limit
set in run_lora.py keeps MLX from hoarding cache, and this process is the actual safety net. It
polls the whole system once a second.

PAUSE, NOT STOP (2026-09-28, his word: "if lid closes stuff only pauses not stop"). Round 3 was
stopped three times by passing pressure — swap growth with apps open, then free memory under the
line while live JARVIS loaded a model for a chat turn, a Dream cycle, a false wake — and every stop
threw away up to 199 iterations and needed a hand resume. Now these lines PAUSE the child (SIGSTOP:
it computes and allocates nothing) and it continues (SIGCONT) once the machine has been clear for
RESUME_AFTER awake seconds:

  - system-wide free memory (macOS `memory_pressure -Q`) below MIN_FREE_PCT
    (clear again at MIN_FREE_PCT + 5, so it does not flap on the line)
  - swap in use grown by more than MAX_SWAP_GROWTH_MB while the child ran (rebased at each resume:
    growth while it was paused was not its doing)
  - macOS recording a thermal or performance warning (`pmset -g therm`) — this is a fanless
    MacBook Air; when it has to slow itself down, the run waits rather than cooking it
  - on battery, the charge below MIN_BATTERY (clear when plugged in, or 5 points above) — this Mac
    does not idle-sleep while JARVIS holds the microphone open, so an unplugged overnight run would
    otherwise drain it flat. It refuses to start unplugged within 5 points of the floor.

A paused child still HOLDS its memory, so a pause is not allowed to last: after MAX_PAUSE awake
seconds it is stopped after all (exit 97) and train_resumable.py carries on from the last save once
the machine is clear. Two lines stop at once, because waiting cannot fix them:

  - the child's own resident size above MAX_CHILD_GB (Metal buffers are not all counted there,
    which is why the system-wide lines come first)
  - the run exceeding MAX_SECONDS of AWAKE, UNPAUSED time

SLEEP. time.monotonic() is mach_absolute_time() on macOS (checked on Python 3.14:
time.get_clock_info('monotonic')), which does not advance while the Mac sleeps. Closing the lid
freezes MLX and this loop together, and neither the budget nor a pause is spent while it is shut.

Usage: guard.py [--min-free 15] [--max-swap-growth 1500] [--max-child-gb 4] [--max-seconds 900]
                [--min-battery 30] [--max-pause 1800] [--resume-after 60] -- <command…>
Exit code: the child's, or 97 when the watchdog stopped it.
"""
import argparse
import plistlib
import re
import signal
import subprocess
import sys
import time


def free_pct():
    try:
        out = subprocess.run(['memory_pressure', '-Q'], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r'free percentage:\s*(\d+)%', out)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def swap_used_mb():
    try:
        out = subprocess.run(['sysctl', '-n', 'vm.swapusage'], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r'used\s*=\s*([\d.]+)M', out)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def child_rss_gb(pid):
    try:
        out = subprocess.run(['ps', '-o', 'rss=', '-p', str(pid)], capture_output=True, text=True, timeout=5).stdout
        return int(out.strip() or 0) / (1024 * 1024)
    except Exception:
        return None


def thermal_warning():
    # Prints "No thermal warning level has been recorded" (and the same for performance) until
    # macOS actually records one; anything else naming a warning level is a warning.
    try:
        out = subprocess.run(['pmset', '-g', 'therm'], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    for line in out.splitlines():
        low = line.lower()
        if 'warning level' in low and 'no ' not in low:
            return line.strip()
        if 'cpu_speed_limit' in low:
            m = re.search(r'(\d+)', line)
            if m and int(m.group(1)) < 100:
                return line.strip()
    return None


def battery():
    # (percent, on_mains) from the battery's own registry entry, read as a plist, or None on a Mac
    # without one. CurrentCapacity is a percentage on Apple silicon (MaxCapacity reads 100).
    try:
        out = subprocess.run(['ioreg', '-a', '-rn', 'AppleSmartBattery'], capture_output=True, timeout=5).stdout
        entries = plistlib.loads(out) if out else []
        if not entries:
            return None
        d = entries[0]
        pct = round(100 * d['CurrentCapacity'] / (d.get('MaxCapacity') or 100))
        return pct, bool(d.get('ExternalConnected'))
    except Exception:
        return None


def stop_child(child):
    # A stopped process keeps SIGTERM pending until it runs again, so it is woken to receive it.
    try:
        child.send_signal(signal.SIGTERM)
        child.send_signal(signal.SIGCONT)
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-free', type=int, default=15)
    ap.add_argument('--max-swap-growth', type=float, default=1500)
    ap.add_argument('--max-child-gb', type=float, default=4.0)
    ap.add_argument('--max-seconds', type=float, default=900)
    ap.add_argument('--min-battery', type=int, default=30)
    ap.add_argument('--max-pause', type=float, default=1800)
    ap.add_argument('--resume-after', type=float, default=60)
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == '--' else a.cmd
    if not cmd:
        ap.error('no command')

    free0, swap0 = free_pct(), swap_used_mb()
    if free0 is not None and free0 < a.min_free + 10:
        print(f'[guard] refusing to start: only {free0}% memory free', flush=True)
        return 98
    hot = thermal_warning()
    if hot:
        print(f'[guard] refusing to start: {hot}', flush=True)
        return 98
    batt = battery()
    if batt and not batt[1] and batt[0] < a.min_battery + 5:
        print(f'[guard] refusing to start: battery {batt[0]}% and unplugged', flush=True)
        return 98
    print(f'[guard] start: free {free0}%, swap {swap0} MB, battery '
          + (f'{batt[0]}% {"on mains" if batt[1] else "unplugged"}' if batt else 'n/a'), flush=True)
    child = subprocess.Popen(cmd)
    low_free, peak_swap, peak_rss = free0, swap0, 0.0
    reason = None
    t0 = time.monotonic()
    paused_at = None      # monotonic time of the current pause, or None while running
    paused_total = 0.0    # awake seconds spent paused, not charged to --max-seconds
    clear_since = None    # monotonic time the machine has been clear since, while paused
    pauses = 0
    tick = 0
    try:
        while child.poll() is None:
            time.sleep(1)
            tick += 1
            now = time.monotonic()
            if tick % 5 == 0 or paused_at is not None:
                hot = thermal_warning()
                batt = battery()
            f, s, r = free_pct(), swap_used_mb(), child_rss_gb(child.pid)
            if f is not None:
                low_free = f if low_free is None else min(low_free, f)
            if s is not None:
                peak_swap = s if peak_swap is None else max(peak_swap, s)
            if r is not None:
                peak_rss = max(peak_rss, r)
            batt_low = bool(batt and not batt[1] and batt[0] < a.min_battery)

            if paused_at is None:
                if now - t0 - paused_total > a.max_seconds:
                    reason = f'ran longer than {a.max_seconds:.0f}s awake'
                elif r is not None and r > a.max_child_gb:
                    reason = f'child resident {r:.2f} GB > {a.max_child_gb} GB'
                if reason:
                    print(f'[guard] STOPPING: {reason}', flush=True)
                    stop_child(child)
                    break
                why = (f'thermal: {hot}' if hot else
                       f'battery {batt[0]}% < {a.min_battery}% and unplugged' if batt_low else
                       f'free memory {f}% < {a.min_free}%' if f is not None and f < a.min_free else
                       f'swap grew {s - swap0:.0f} MB > {a.max_swap_growth:.0f} MB'
                       if s is not None and swap0 is not None and s - swap0 > a.max_swap_growth else None)
                if why:
                    child.send_signal(signal.SIGSTOP)
                    paused_at, clear_since = now, None
                    pauses += 1
                    print(f'[guard] PAUSED: {why} (free {f}%, swap {s} MB)', flush=True)
            else:
                clear = (not hot and not (batt and not batt[1] and batt[0] < a.min_battery + 5)
                         and f is not None and f >= a.min_free + 5)
                clear_since = (clear_since or now) if clear else None
                if clear_since is not None and now - clear_since >= a.resume_after:
                    child.send_signal(signal.SIGCONT)
                    paused_total += now - paused_at
                    print(f'[guard] RESUMED after {now - paused_at:.0f}s awake (free {f}%, swap {s} MB)', flush=True)
                    paused_at, clear_since = None, None
                    swap0 = s if s is not None else swap0
                elif now - paused_at > a.max_pause:
                    reason = f'paused longer than {a.max_pause:.0f}s awake (free {f}%)'
                    print(f'[guard] STOPPING: {reason}', flush=True)
                    stop_child(child)
                    break
    except KeyboardInterrupt:
        stop_child(child)
    code = child.wait()
    print(f'[guard] end: lowest free {low_free}%, peak swap {peak_swap} MB (start {swap0}), '
          f'peak child rss {peak_rss:.2f} GB, {pauses} pause(s), exit {code}'
          + (f', stopped: {reason}' if reason else ''), flush=True)
    return 97 if reason else code


if __name__ == '__main__':
    sys.exit(main())
