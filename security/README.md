# JARVIS MK-1 — Security

Hardening for the JARVIS fleet against **corruption, hijacking, and malware**. Nothing here
changes what JARVIS does; it changes who is allowed to touch it and lets you detect tampering.

## Threat model & controls

| Threat | Control | Where |
|--------|---------|-------|
| A website you visit drives the local API (DNS-rebinding / CSRF) — screen capture, chat, file open, Shortcuts | `Host`/`Origin` allowlist **+** per-install secret token on every `/api` call | `jarvis-os/server.js`, `public/app.js` |
| Local process/malware reads your passwords | Settings password stored as **salted SHA-256** (no cleartext on disk or in the binary); `jarvis.yaml`, `.env`, API token forced to `600` | `harden.sh` |
| A script/binary run by a login agent gets silently modified (trojaned) | **SHA-256 integrity manifest** + daily verify agent that alerts on drift | `integrity.sh`, `verify.sh`, `com.jarvis.jarvissecurity` |
| A world/group-writable file becomes a hijack foothold | Recursive `go-w` strip + writable-launch-agent report | `harden.sh` |

## Files

- **`install.sh`** — one-shot: harden perms → baseline integrity → install daily agent.
- **`harden.sh`** — idempotent permission lockdown. Safe to re-run anytime.
- **`integrity.sh`** — (re)baseline the manifest. Run **after any intentional code change**.
- **`verify.sh`** — check current files vs. baseline. Reports `CHANGED` / `MISSING` / `NEW`, logs to `integrity.log`, and posts a desktop alert on drift. Exit 0 = clean, 1 = drift.
- **`uninstall.sh`** — remove the daily agent (keeps perms + manifest).
- `_lib.sh` — shared list of security-critical files (code/scripts/launch configs/binaries; runtime data is excluded).

## Everyday use

```bash
bash security/verify.sh      # is anything tampered right now?
bash security/harden.sh      # re-apply permissions
bash security/integrity.sh   # re-baseline AFTER you intentionally edit code
```

**Important:** whenever you (or Codex/Claude) legitimately change any JARVIS source, re-run
`integrity.sh` so the new state becomes trusted — otherwise the daily check will flag your
own edit as drift. That is by design: an unexplained `CHANGED`/`NEW` is exactly the signal
you want.

The daily agent (`com.jarvis.jarvissecurity`) runs `verify.sh` at 09:00 and at login;
output is in `agent.log`.
