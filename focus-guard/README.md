# Focus Guard — gesture-armed Do Not Disturb + JARVIS banners

When you arm gesture control (two open palms), this turns on **Do Not Disturb** and posts a
banner; disarming turns DND back off. It also announces when the clap daemon summons Claude.

It only **reads** the other agents' logs (`gesture.log`, `clap.log`) — it never modifies them,
so gesture-control's Accessibility grant is never disturbed. Needs only **Notifications** permission.

> Why not a true "notification filter"? macOS gives no app permission to read or suppress *other
> apps'* notifications (by design). Toggling Focus is the sanctioned, buildable equivalent — it
> silences everything at once while you're in hands-free mode.

## Install
```bash
bash install.sh
```
Approve the **Notifications** prompt.

## One-time setup — the two Focus shortcuts (required for DND toggling)
Open **Shortcuts.app** → **+** and make two shortcuts (banners work without them; DND won't toggle until they exist):

| Name (exact) | Action |
|---|---|
| `AIC DND On` | **Set Focus** → Do Not Disturb → **On** (until turned off) |
| `AIC DND Off` | **Set Focus** → Turn Do Not Disturb **Off** |

Test one from Terminal: `shortcuts run "AIC DND On"` (your menu bar should show the DND moon).

## Turn it off
```bash
bash uninstall.sh
```

## Tune (no rebuild — edit the plist then reload)
`~/Library/LaunchAgents/com.atharv.focusguard.plist`

| Var | Default | Meaning |
|-----|---------|---------|
| `FOCUS_ON` | `AIC DND On` | Shortcut run when gesture control arms. |
| `FOCUS_OFF` | `AIC DND Off` | Shortcut run when it disarms. |
| `POLL` | `1.0` | Seconds between log checks. |
| `GESTURE_LOG` | …/gesture-control/gesture.log | Log it watches for ENABLED/DISABLED. |
| `CLAP_LOG` | …/clap-daemon/clap.log | Log it watches for "opening Claude". |

## Notes
- Prefer different Focus modes? Point `FOCUS_ON`/`FOCUS_OFF` at shortcuts that set "Work", "Sleep", etc.
- The clap announcement is a freebie — extend `poll()` in `FocusGuard.swift` to react to other log lines.
