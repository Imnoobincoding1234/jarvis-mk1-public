#!/bin/bash
# Shared helpers for the JARVIS MK-1 security toolkit.
# Emits the set of "security-critical" files — the code, scripts, launch configs and
# compiled binaries that, if silently altered, would mean corruption / hijack / malware.
# Pure runtime DATA (jarvis.yaml, state/*.json, logs, backups) is deliberately excluded:
# it changes during normal use and is not an execution vector.

ROOT="$HOME/JARVIS MK-1"
LA="$HOME/Library/LaunchAgents"
SECDIR="$ROOT/security"

# Print NUL-delimited absolute paths of every critical file.
emit_critical_files() {
  # Source + launch/config code under the tree (skip backups, node_modules, logs, data). A Python
  # virtualenv (finetune/.venv) is third-party packages rebuilt from requirements.txt, like
  # node_modules — thousands of files that are not JARVIS code. backups/ holds pre-edit copies and
  # retired components (see backups/README.md): nothing there runs, so nothing there is watched.
  find "$ROOT" \
      \( -path "$ROOT/backups" -o -name node_modules -o -name .venv -o -name '*.bak' -o -name '*.bak-*' -o -name '*.app.bak*' \
         -o -name 'state' -o -name 'logs' -o -name 'JARVIS Outputs' \) -prune -o \
      -type f \( -name '*.sh' -o -name '*.swift' -o -name '*.js' -o -name '*.html' -o -name '*.plist' \
                 -o -name '*.py' \) \
      ! -name '*.log' -print0
  # Compiled Mach-O executables shipped inside the .app bundles.
  find "$ROOT" -path "$ROOT/backups" -prune -o -type f -path '*/Contents/MacOS/*' -print0 2>/dev/null
  # The pinned llama-server that serves jarvis, with its template and parameters (runtime/README.md) — a binary that
  # runs every chat reply is watched like the .app executables are.
  find "$ROOT/runtime" -type f -print0 2>/dev/null
  # Installed launchd login agents that drive the whole fleet.
  find "$LA" -maxdepth 1 -type f -name 'com.jarvis.*.plist' -print0 2>/dev/null
}
