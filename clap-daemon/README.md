# Clap Listener — 2 claps → open Claude

Native macOS background listener. Two sharp claps within ~0.9s open **Claude.app**.
Auto-starts every time you log in. (Clap count is tunable — see `CLAP_COUNT` below.)

## Install
```bash
bash install.sh
```
On first run macOS asks for **microphone** access — click **Allow**
(or enable *ClapListener* under System Settings → Privacy & Security → Microphone).

## Turn it off
```bash
bash uninstall.sh
```

## Check it's running
```bash
launchctl list | grep claplistener
tail -f clap.log
```

## Tune sensitivity
Detection constants are read from env vars (set them in the launch agent's
`ProgramArguments`/`EnvironmentVariables`, or run the binary manually):

| Var | Default | Meaning |
|-----|---------|---------|
| `CLAP_THRESHOLD` | `5.5` | Peak loudness to count as a clap. This mic returns un-clamped floats that exceed 1.0, so a loud clap can cross several units (measured >5.0). ~0.4–0.5 = normal claps; higher = only loud claps close to the mic. Ambient/typing ≈ 0.05–0.11. |
| `CLAP_COUNT` | `2` | How many claps within the window to open Claude. |
| `CLAP_WINDOW_MS` | `900` | All claps must fall within this span. |
| `CLAP_MIN_GAP_MS` | `120` | Ignore a single clap's ringing. |
| `CLAP_LAUNCH_COOLDOWN_MS` | `4000` | Won't relaunch Claude more often than this. |

Manual test with a custom threshold:
```bash
CLAP_THRESHOLD=0.3 ./ClapListener.app/Contents/MacOS/ClapListener
```

## Notes
- **"24/7"** means *whenever you're logged in* — a login-time LaunchAgent, the correct
  way for a mic app (a lower-level daemon can't access your mic/session).
- The orange "mic in use" dot stays on in the menu bar while it's listening — expected.
- Detection = loud sharp transient. Two claps in-window filters most noise; tune
  `CLAP_THRESHOLD` if your room is loud.
