#!/bin/bash
# Stops a running gate cleanly if the battery reaches 20% while discharging (sweeps resume by id with the same --out).
SP="$(dirname "$0")"; J="$HOME/JARVIS MK-1/jarvis-os"; T=$(cat "$J/state/.apitoken")
while pgrep -f gate_run.sh >/dev/null; do
  b=$(pmset -g batt | grep -o '[0-9]*%' | head -1 | tr -d %); st=$(pmset -g batt | grep -o 'discharging' | head -1)
  if [ -n "$b" ] && [ "$b" -le 20 ] && [ "$st" = discharging ]; then
    echo "[$(date '+%H:%M:%S')] battery $b% discharging — stopping the gate"
    for p in $(pgrep -f gate_run.sh); do kill "$p"; done
    sleep 1; for p in $(pgrep -f 'sweeps/sweep_casual.js'); do kill "$p"; done
    curl -s -m 20 -X POST http://127.0.0.1:8787/api/tool -H "x-jarvis-token: $T" -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8787' -d '{"tool":"dream_set","args":{"enabled":true}}' | head -c 60; echo
    echo GATE-STOPPED-BATTERY; exit 0
  fi
  sleep 60
done
echo "[$(date '+%H:%M:%S')] gate finished; watcher exits"
