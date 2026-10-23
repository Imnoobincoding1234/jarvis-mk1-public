#!/bin/bash
# ---------------------------------------------------------------------------
# JARVIS MK-1 — bring a machine back from nothing but this repo.
#
# WHAT A REPO CANNOT HOLD, and therefore what this script exists to rebuild:
#
#   · the Ollama models          ~8 GB of weights, pulled fresh (chat, vision, three embedders, reasoning)
#   · the reader model           jarvis-reader, BUILT here from the adapter the vault restores
#   · the launchd agents         9 plists, written for THIS machine's paths and user
#   · the compiled .app bundles  rebuilt from the Swift sources beside them
#   · the integrity baseline     hashes are per-machine; a copied manifest is meaningless
#
# And the one class it cannot do anything about: macOS TCC permissions. Accessibility, Microphone,
# Screen Recording and Camera are granted by a human clicking a checkbox, per machine, and no script
# may grant them — that is the point of TCC. Those are printed as a checklist at the end rather than
# silently skipped, because an agent that is installed but not permitted looks identical to a working
# one until the moment it matters.
#
# IDEMPOTENT. Re-running is safe: models are only pulled if absent, apps rebuilt only if the source
# is newer, agents rebootstrapped in place.
#
#   ./install.sh              full install
#   ./install.sh --check      report what is missing, change nothing
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
UID_N="$(id -u)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
MISSING=0
need() { command -v "$1" >/dev/null 2>&1 && ok "$1" || { bad "$1 — $2"; MISSING=1; }; }

# ── 0. this machine ────────────────────────────────────────────────────────
# APPLE SILICON ONLY. The wake word's onnxruntime (1.29) ships for arm64 only, the reader model is built
# with MLX (Apple Silicon only), and the local models are sized for an M-series GPU. Any M-series Mac
# and any RAM size works; 8 GB is the smallest it has been measured on.
say "this Mac"
if [ "$(uname -m)" != "arm64" ]; then bad "JARVIS MK-1 needs an Apple Silicon Mac (M1 or later) — this one is $(uname -m)"; exit 1; fi
ok "Apple Silicon ($(sysctl -n machdep.cpu.brand_string 2>/dev/null), $(( $(sysctl -n hw.memsize) / 1073741824 )) GB)"
OSV="$(sw_vers -productVersion)"
if [ "${OSV%%.*}" -lt 14 ]; then bad "macOS $OSV — JARVIS needs macOS 14 (Sonoma) or later"; exit 1; fi
ok "macOS $OSV"
# THE INSTALL LOCATION. Every component finds the others at ~/JARVIS MK-1 (any username). A clone
# anywhere else is linked there rather than having forty paths rewritten.
if [ "$ROOT" != "$HOME/JARVIS MK-1" ]; then
  if [ -L "$HOME/JARVIS MK-1" ] && [ "$(cd "$HOME/JARVIS MK-1" && pwd -P)" = "$(cd "$ROOT" && pwd -P)" ]; then ok "~/JARVIS MK-1 → $ROOT"
  elif [ -e "$HOME/JARVIS MK-1" ]; then bad "~/JARVIS MK-1 exists and is not this checkout — move it aside, then re-run"; exit 1
  elif [ "$CHECK_ONLY" = 1 ]; then bad "~/JARVIS MK-1 missing — would link it to $ROOT"
  else ln -s "$ROOT" "$HOME/JARVIS MK-1" && ok "linked ~/JARVIS MK-1 → $ROOT"; fi
else ok "installed at ~/JARVIS MK-1"; fi

# ── 1. prerequisites ───────────────────────────────────────────────────────
say "prerequisites"
need node   "install with: brew install node"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  bad "node $(node -v) is too old — JARVIS needs Node 18 or later (brew upgrade node)"; MISSING=1
fi
need ollama "install from https://ollama.com/download"
need swiftc "install Xcode command line tools: xcode-select --install"
need git    "install with: brew install git"
if [ "$MISSING" = 1 ]; then bad "install the above first, then re-run"; exit 1; fi

# HOMEBREW IS A CAPABILITY, NOT A PREREQUISITE, so it warns rather than exits.
#
# install_app and uninstall_app ask two registries what exists — the Mac App Store (over the iTunes
# search API) and Homebrew (`brew search`, `brew list`) — and Homebrew is the half that can be
# VERIFIED afterwards with `brew list` instead of read off a store window. Without it, "install X"
# still works for anything on the App Store and reports honestly that it looked in one place rather
# than two. Nothing else in this system needs it, which is why a missing brew is a warning and a
# missing node is fatal.
if command -v brew >/dev/null 2>&1; then ok "brew — install_app/uninstall_app can use Homebrew"
else warn "brew missing — install_app/uninstall_app will fall back to the App Store only"; fi

# BRAVE IS A REQUIREMENT. Web search, research, YouTube, Spotify's web player and every browser_* tool
# drive Brave Browser (AppleScript + its JavaScript-from-Apple-Events setting). Installed with Homebrew
# when it is there, otherwise from Brave's own universal disk image.
if [ -d "/Applications/Brave Browser.app" ] || [ -d "$HOME/Applications/Brave Browser.app" ]; then ok "Brave Browser"
elif [ "$CHECK_ONLY" = 1 ]; then bad "Brave Browser MISSING — would install it (brew, or brave.com's disk image)"
else
  say "installing Brave Browser"
  if command -v brew >/dev/null 2>&1 && brew install --cask brave-browser >/dev/null 2>&1; then ok "Brave installed (Homebrew)"
  else
    BRAVE_DMG="$(mktemp -d)/Brave-Browser.dmg"
    if curl -fsSL -o "$BRAVE_DMG" "https://referrals.brave.com/latest/Brave-Browser-universal.dmg" \
       && MNT="$(hdiutil attach -nobrowse -readonly "$BRAVE_DMG" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')" \
       && cp -R "$MNT/Brave Browser.app" /Applications/ ; then
      hdiutil detach "$MNT" -quiet >/dev/null 2>&1; ok "Brave installed (brave.com)"
    else
      [ -n "${MNT:-}" ] && hdiutil detach "$MNT" -quiet >/dev/null 2>&1
      bad "Brave install FAILED — get it from https://brave.com/download and re-run"; MISSING=1
    fi
    rm -f "$BRAVE_DMG"
  fi
fi
# JARVIS runs page scripts in Brave through Apple Events; Brave ships that switch OFF.
[ -d "/Applications/Brave Browser.app" ] && warn "In Brave: View → Developer → Allow JavaScript from Apple Events (once, by hand)"

# A NEW MACHINE WITH NO VAULT starts from .env.example, BEFORE the models are read from it — otherwise
# the reasoning model named there is never pulled. (With a vault, step 3 restores the real .env.)
if [ ! -f .env ] && [ ! -f private/vault.enc ] && [ "$CHECK_ONLY" = 0 ]; then
  cp .env.example .env && ok ".env started from .env.example (local-only; add keys later if you want them)"
fi

# ── 2. the models (the ~6.3 GB that is deliberately not in git) ────────────
# Read from the .env the vault restored, so the repo never hardcodes a model choice that has
# already been changed once. Falls back to what was running when this was written.
CHAT_MODEL="$(sed -n 's/^JARVIS_LOCAL_MODEL=//p' .env 2>/dev/null | tail -1)"
VIS_MODEL="$(sed -n 's/^JARVIS_VISION_MODEL=//p' .env 2>/dev/null | tail -1)"
# The reasoning model. Read the same way and for the same reason — but with NO
# fallback default, because unlike the others this one is optional: an install
# that never set JARVIS_REASONING_MODEL should not silently acquire 2.5 GB of
# weights it was not asked for. Empty means "not configured", and the loop below
# skips empty entries.
#
# It has to be pulled HERE or a restored machine gets the exact silent failure
# the embedder note above describes: .env names phi4-mini, nothing ever pulls it,
# and every reasoning question dies on `model not found` — while ordinary chat
# keeps working, so the machine looks fine until the moment it is asked to think.
REASON_MODEL="$(sed -n 's/^JARVIS_REASONING_MODEL=//p' .env 2>/dev/null | tail -1)"
# The MULTILINGUAL embedder, read the same way. Overridable so a machine can point at a different
# one, defaulted below so a restore that never set it still gets a working Hinglish lane.
ALT_EMBED_MODEL="$(sed -n 's/^JARVIS_EMBED_MODEL_ALT=//p' .env 2>/dev/null | tail -1)"
: "${CHAT_MODEL:=qwen2.5:3b-instruct-q4_K_M}"
: "${VIS_MODEL:=qwen3-vl:2b}"
# The embedder for semantic recall AND for every classifier in the system. 274 MB, and it must be
# pulled here or a restored machine loses the semantic half of memory SILENTLY — recall falls back to
# tf-idf and still answers, so nothing looks broken. Same shape as the restore promise the wake word
# broke once already.
#
# Was all-minilm until 2026-09-12. Replaced on measurement: on 81 held-out routing goals, with each
# model's own threshold swept, all-minilm scored 68/81 with 7 WRONG actions and nomic 74/81 with 0.
# A restored machine that pulls the old one gets thresholds tuned for a space it is not in.
: "${EMBED_MODEL:=nomic-embed-text}"
# THE MULTILINGUAL EMBEDDER, AND IT FAILS SILENTLY IN A WORSE WAY THAN THE ONE ABOVE.
#
# all-minilm is an English model. Measured on sixteen of his own romanized Hinglish phrasings it did
# not merely mis-rank them, it LEAKED: "mere bhai ka naam kya hai", "mujhe kal kya karna hai" and
# "mere contacts dikhao" were all routed to a search engine. Hinglish is therefore scored by granite,
# which leaks none of them — highest wrong margin 0.000 against 0.040.
#
# Without it on the machine, intent.js cannot build granite's centroids, every Hinglish turn abstains,
# and the lane simply stops answering — while English keeps working perfectly, so nothing looks
# broken. That is the same restore trap the embedder note above describes, and it is why this is
# pulled here rather than left to the first request that needs it. 562 MB.
: "${ALT_EMBED_MODEL:=granite-embedding:278m}"
# THE SMALL ENGLISH EMBEDDER IS STILL NEEDED, and nothing pulled it. nomic replaced it as the default,
# but six readers pin it on measurement — errand.js (what a span names), actread.js (a leftover word's
# role), calintent.js, itemclass.js, and replyclaim.js / replyhedge.js (JARVIS's own reply read back) —
# and each fails soft without it: the classifier abstains and the request falls through, so a restored
# machine looked fine and routed worse. 45 MB.
ROLE_EMBED_MODEL="all-minilm"
say "ollama models"
if ! pgrep -x ollama >/dev/null 2>&1; then
  warn "ollama not running — starting it"
  [ "$CHECK_ONLY" = 0 ] && { open -a Ollama 2>/dev/null || (ollama serve >/dev/null 2>&1 &); sleep 4; }
fi
for m in "$CHAT_MODEL" "$VIS_MODEL" "$EMBED_MODEL" "$ALT_EMBED_MODEL" "$ROLE_EMBED_MODEL" "$REASON_MODEL"; do
  [ -n "$m" ] || continue          # REASON_MODEL is legitimately unset on some installs
  # `ollama list` always prints an explicit tag, so an untagged name never matches and the model is
  # reported missing on a machine that already has it — then re-pulled on every run.
  case "$m" in *:*) ;; *) m="$m:latest" ;; esac
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$m"; then ok "$m present"
  elif [ "$CHECK_ONLY" = 1 ]; then bad "$m MISSING (would pull ~2 GB)"
  else say "pulling $m — this is the slow part"; ollama pull "$m" || bad "pull failed for $m"; fi
done

# ── 3. secrets + personal data ─────────────────────────────────────────────
say "vault"
if [ -f .env ]; then ok ".env present"
elif [ -f private/vault.enc ]; then
  if [ "$CHECK_ONLY" = 1 ]; then warn "vault present, not yet unpacked — run ./tools/vault.sh unpack"
  else say "unpacking vault (passphrase required)"; ./tools/vault.sh unpack || bad "vault unpack failed"; fi
else
  warn "no .env and no vault — copy .env.example to .env and fill in the keys by hand"
fi

# The speech vocabulary is per user (names, places) and never committed; start it from the example.
if [ -f config/vocabulary.json ]; then ok "config/vocabulary.json present"
elif [ "$CHECK_ONLY" = 1 ]; then warn "config/vocabulary.json missing — would start it from the example"
else cp config/vocabulary.example.json config/vocabulary.json && ok "config/vocabulary.json started from the example — add your own names to it"; fi

# ── 3a. jarvis's base model, and think hard ─────────────────────────────────
# Nothing pulled either until 2026-10-19. Chat replies come from `jarvis`: Bonsai-4B's 1-bit GGUF with his LoRA on top,
# served by runtime/llama-server (jarvis-os/loraserver.js). The vault restores the LoRA, but the base is read from the
# INSTALLED Ollama model's blob — so a restored Mac had the adapter and no model under it, and every chat reply fell
# back. Think hard (Bonsai-8B) was simply missing. This runs AFTER the vault, because which reply model is in use lives
# in the .env the vault restores (step 2 reads .env before it exists on a restored Mac). The defaults are the ones
# loraserver.js and server.js fall back to; JARVIS_LORA_BASE (a GGUF path) means no pull.
# The REASONING model is pulled here too (2026-10-22): step 2 reads it from .env, which on a restored Mac does not exist
# until the vault step — so the first run pulled no reasoning model and every reasoning question failed until a re-run.
say "jarvis base + think hard + reasoning"
REPLY_MODEL="$(sed -n 's/^JARVIS_CHAT_REPLY_MODEL=//p' .env 2>/dev/null | tail -1)"
LORA_NAME="$(sed -n 's/^JARVIS_LORA_NAME=//p' .env 2>/dev/null | tail -1)"; : "${LORA_NAME:=jarvis}"
LORA_BASE_PATH="$(sed -n 's/^JARVIS_LORA_BASE=//p' .env 2>/dev/null | tail -1)"
LORA_ADAPTER_PATH="$(sed -n 's/^JARVIS_LORA_ADAPTER=//p' .env 2>/dev/null | tail -1)"
REPLY_RUNTIME="$(sed -n 's/^JARVIS_CHAT_REPLY_RUNTIME=//p' .env 2>/dev/null | tail -1)"
THINK_MODEL="$(sed -n 's/^JARVIS_THINK_MODEL=//p' .env 2>/dev/null | tail -1)"; : "${THINK_MODEL:=hf.co/prism-ml/Bonsai-8B-gguf:Q1_0}"
REASON_MODEL_3A="$(sed -n 's/^JARVIS_REASONING_MODEL=//p' .env 2>/dev/null | tail -1)"
EXTRA_MODELS=("$THINK_MODEL")
[ -n "$REASON_MODEL_3A" ] && EXTRA_MODELS+=("$REASON_MODEL_3A")
[ "${REPLY_MODEL%:latest}" = "$LORA_NAME" ] && [ -z "$LORA_BASE_PATH" ] && EXTRA_MODELS+=("hf.co/prism-ml/Bonsai-4B-gguf:Q1_0")
for m in "${EXTRA_MODELS[@]}"; do
  case "$m" in *:*) ;; *) m="$m:latest" ;; esac          # `ollama list` always shows a tag
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$m"; then ok "$m present"
  elif [ "$CHECK_ONLY" = 1 ]; then bad "$m MISSING (would pull ~1–2 GB)"
  else say "pulling $m"; ollama pull "$m" || bad "pull failed for $m"; fi
done
# The chat reply's server is configured only when its binary, template, base and LoRA all exist — check from the
# server's own lookup, so a moved manifest or a missing adapter is named here instead of surfacing as a dim JARVIS.
if [ "${REPLY_MODEL%:latest}" = "$LORA_NAME" ]; then
  # The .env values loraserver.js would read live are handed over explicitly (2026-10-22): without them an override in .env
  # (JARVIS_LORA_BASE / _ADAPTER / _NAME, JARVIS_CHAT_REPLY_RUNTIME) was invisible here and the check could say NOT ready.
  if JARVIS_LORA_NAME="$LORA_NAME" JARVIS_LORA_BASE="$LORA_BASE_PATH" JARVIS_LORA_ADAPTER="$LORA_ADAPTER_PATH" JARVIS_CHAT_REPLY_RUNTIME="$REPLY_RUNTIME" \
     node -e "const l=require('./jarvis-os/loraserver.js');l.init({root:process.cwd(),envVal:n=>process.env[n]||null});process.exit(l._config()?0:1)" 2>/dev/null; then
    ok "$LORA_NAME ready on runtime/llama-server"
  else bad "$LORA_NAME NOT ready — runtime/llama-server, runtime/jarvis.jinja, the Bonsai-4B base or the LoRA (vault) is missing"; fi
fi

# ── 3b. neural extras: the voice, and the wake word's runtime ──────────────
# Both live OUTSIDE the repo on purpose — a 41 MB dylib and ~270 MB of voice models are build inputs,
# not things this project maintains. They are fetched here rather than left to a README step, because
# clap-daemon/build.sh now HARD FAILS without onnxruntime, which would make a restore stop dead at
# step 4 with a message about a path nobody has seen before.
say "neural extras (voice + wake word runtime)"
ORT_DIR="$HOME/.local/share/ort"
ORT_VER="1.29.0"
if [ -f "$ORT_DIR/onnxruntime-osx-arm64-$ORT_VER/lib/libonnxruntime.dylib" ]; then
  ok "onnxruntime present (wake word)"
elif [ "$CHECK_ONLY" = 1 ]; then bad "onnxruntime missing — the wake word will not build"
else
  say "fetching onnxruntime $ORT_VER"
  mkdir -p "$ORT_DIR"
  if curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v$ORT_VER/onnxruntime-osx-arm64-$ORT_VER.tgz" \
       | tar xz -C "$ORT_DIR"; then ok "onnxruntime fetched"
  else bad "onnxruntime fetch FAILED — the wake word will not build; claps still work"; fi
fi

PIPER_DIR="$HOME/.local/share/piper-jarvis"
PIPER_VOICE="${JARVIS_TTS_MODEL:-en_GB-semaine-medium}"
if [ -f "$PIPER_DIR/voices/$PIPER_VOICE.onnx" ]; then
  ok "piper voice present ($PIPER_VOICE)"
elif [ "$CHECK_ONLY" = 1 ]; then warn "piper missing — JARVIS will speak in the macOS fallback voice"
else
  say "installing piper + voice $PIPER_VOICE"
  mkdir -p "$PIPER_DIR"
  ( cd "$PIPER_DIR" \
    && python3 -m venv venv >/dev/null 2>&1 \
    && ./venv/bin/pip install --quiet piper-tts >/dev/null 2>&1 \
    && ./venv/bin/python -m piper.download_voices "$PIPER_VOICE" --data-dir voices >/dev/null 2>&1 ) \
    && ok "piper ready" \
    || warn "piper install failed — speech falls back to the macOS voice, nothing else breaks"
fi

# ── 3c. the reader model: BUILT here, never pulled ─────────────────────────
# jarvis-reader reads every request (jarvis-os/readmodel.js). It is Qwen3.5-0.8B with a LoRA adapter
# trained on his own messages, fused and handed to Ollama by finetune/export_reader.sh, so no registry
# has it — and without it JARVIS still starts and answers, but only open / close / system requests
# parse (actread.js). Files, searches and playing things fall through, which looks like a dim JARVIS
# rather than a missing model. The adapter comes out of the vault (step 3) at finetune/adapters/current.
#
# The build needs Python 3.14 for the MLX wheels the training venv was made with (Apple's python3 is
# too old), downloads the 1.6 GB base model once, and runs under finetune/guard.py like every heavy
# step here. A few minutes.
say "reader model (jarvis-reader)"
READER_ADAPTER="finetune/adapters/current/adapters.safetensors"
PY314="$(command -v python3.14 || true)"
if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "jarvis-reader:latest"; then
  ok "jarvis-reader present"
elif [ ! -f "$READER_ADAPTER" ] && [ ! -f private/vault.enc ]; then
  # A new user: the reader's adapter was trained on the owner's own messages and ships only in the
  # owner's vault. JARVIS runs without it — open / close / system requests parse, the rest goes through
  # the chat model — so this is a notice, not a failure.
  warn "jarvis-reader not installed (its adapter is private to the owner's vault) — JARVIS uses the basic reader"
elif [ ! -f "$READER_ADAPTER" ]; then
  bad "jarvis-reader MISSING, and no adapter at $READER_ADAPTER — unpack the vault (./tools/vault.sh unpack), then re-run"
elif [ "$CHECK_ONLY" = 1 ]; then
  bad "jarvis-reader MISSING — would build it from finetune/adapters/current (1.6 GB download, a few minutes)"
elif [ -z "$PY314" ] && [ ! -x finetune/.venv/bin/python ]; then
  bad "jarvis-reader MISSING — building it needs Python 3.14: brew install python@3.14, then re-run"
else
  say "building jarvis-reader — downloads Qwen3.5-0.8B (1.6 GB) the first time"
  ( cd finetune \
    && { [ -x .venv/bin/python ] || "$PY314" -m venv .venv; } \
    && ./.venv/bin/pip install --quiet -r requirements.txt \
    && { [ -f models/Qwen3.5-0.8B/config.json ] || ./.venv/bin/hf download Qwen/Qwen3.5-0.8B --local-dir models/Qwen3.5-0.8B; } \
    && ./export_reader.sh adapters/current q8_0 jarvis-reader >/dev/null ) \
    && ok "jarvis-reader built" \
    || bad "jarvis-reader build FAILED — run: cd finetune && ./export_reader.sh adapters/current"
fi

# ── 4. build the native apps from source ───────────────────────────────────
# Each build.sh already knows how to sign its own bundle; this only decides whether to run one.
say "native apps"
# THE SIGNING IDENTITY FIRST. Without it the builds fall back to ad-hoc signatures, and macOS then drops
# the Microphone and Accessibility grants on every rebuild — the agents run and silently hear/do nothing.
# Idempotent; the first signature may ask once for keychain access ("Always Allow").
if security find-certificate -c "JARVIS Local Signing" >/dev/null 2>&1; then ok "signing identity 'JARVIS Local Signing'"
elif [ "$CHECK_ONLY" = 1 ]; then bad "signing identity missing — would create it (jarvis-control/make-signing-cert.sh)"
else bash jarvis-control/make-signing-cert.sh >/dev/null 2>&1 && ok "signing identity created" || warn "could not create the signing identity — apps will be ad-hoc signed (grants reset on rebuild)"; fi
build_if_needed() {
  local dir="$1" app="$2" src="$3"
  [ -d "$dir" ] || { warn "$dir missing — skipping"; return; }
  # REBUILD WHEN THE SOURCE IS NEWER, not when the app fails to be newer. The two
  # are not the same test and the difference is an equal timestamp: `-nt` is false
  # for equal mtimes, so an app built in the same second as the source it was built
  # FROM reported "needs building" for ever. FocusGuard and JarvisControl both sat
  # in that state — source and bundle stamped to the same minute, both running
  # fine, both reported broken by --check on every run. A check that cries wolf is
  # worse than no check, because this script's whole promise is that a restored
  # machine can be trusted when it says everything is in place.
  if [ -d "$dir/$app" ] && [ -e "$dir/$src" ] && [ ! "$dir/$src" -nt "$dir/$app" ]; then ok "$app up to date"; return; fi
  if [ "$CHECK_ONLY" = 1 ]; then bad "$app needs building"; return; fi
  say "building $app"
  ( cd "$dir" && bash build.sh >/dev/null 2>&1 ) && ok "$app built" || bad "$app build FAILED — run: cd '$dir' && bash build.sh"
}
build_if_needed "clap-daemon"    "ClapListener.app"  "ClapListener.swift"
build_if_needed "focus-guard"    "FocusGuard.app"    "FocusGuard.swift"
build_if_needed "jarvis-control" "JarvisControl.app" "JarvisControl.swift"
[ -d "Jarvis Search/src" ] && ok "Jarvis Search source vendored (build: cd 'Jarvis Search/src' && bash build.sh)"

# ── 5. launchd agents, written for THIS machine ────────────────────────────
# NOT copied from a committed plist. The originals hardcode /Users/you and one of them pointed at
# a directory outside this repo entirely for months. Generating them from $ROOT means the paths are
# right by construction on any machine and any username.
say "launchd agents"
NODE="$(command -v node)"
write_agent() { # label, program-args..., then optional KEY=VALUE env via AGENT_ENV
  local label="$1"; shift
  local plist="$AGENTS_DIR/$label.plist"
  if [ "$CHECK_ONLY" = 1 ]; then
    [ -f "$plist" ] && ok "$label registered" || bad "$label NOT registered"
    return
  fi
  mkdir -p "$AGENTS_DIR"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key><array>'
    for a in "$@"; do echo "    <string>$a</string>"; done
    echo '  </array>'
    echo '  <key>RunAtLoad</key><true/>'
    [ "${AGENT_KEEPALIVE:-1}" = 1 ] && echo '  <key>KeepAlive</key><true/>'
    [ -n "${AGENT_INTERVAL:-}" ] && echo "  <key>StartInterval</key><integer>$AGENT_INTERVAL</integer>"
    if [ -n "${AGENT_ENV:-}" ]; then
      echo '  <key>EnvironmentVariables</key><dict>'
      for kv in $AGENT_ENV; do echo "    <key>${kv%%=*}</key><string>${kv#*=}</string>"; done
      echo '  </dict>'
    fi
    echo "  <key>StandardOutPath</key><string>$ROOT/logs/$label.log</string>"
    echo "  <key>StandardErrorPath</key><string>$ROOT/logs/$label.log</string>"
    echo '</dict></plist>'
  } > "$plist"
  launchctl bootout "gui/$UID_N/$label" >/dev/null 2>&1
  launchctl bootstrap "gui/$UID_N" "$plist" >/dev/null 2>&1 && ok "$label loaded" || bad "$label failed to load"
}
mkdir -p logs
AGENT_KEEPALIVE=1 AGENT_INTERVAL= AGENT_ENV= write_agent com.jarvis.jarvisos       "$NODE" "$ROOT/jarvis-os/server.js"
AGENT_KEEPALIVE=1 AGENT_INTERVAL= AGENT_ENV= write_agent com.jarvis.claplistener   "$ROOT/clap-daemon/ClapListener.app/Contents/MacOS/ClapListener"
AGENT_KEEPALIVE=1 AGENT_INTERVAL= AGENT_ENV= write_agent com.jarvis.jarviscontrol  "$ROOT/jarvis-control/JarvisControl.app/Contents/MacOS/JarvisControl"
AGENT_KEEPALIVE=1 AGENT_INTERVAL= \
  AGENT_ENV="FOCUS_ON=AIC_DND_On FOCUS_OFF=AIC_DND_Off POLL=1.0 CLAP_LOG=$ROOT/clap-daemon/clap.log" \
  write_agent com.jarvis.focusguard "$ROOT/focus-guard/FocusGuard.app/Contents/MacOS/FocusGuard"
AGENT_KEEPALIVE=0 AGENT_INTERVAL=300 AGENT_ENV= write_agent com.jarvis.jarvisselfheal "$NODE" "$ROOT/security/selfheal.js"
AGENT_KEEPALIVE=0 AGENT_INTERVAL=3600 AGENT_ENV= write_agent com.jarvis.jarviscanary  "$NODE" "$ROOT/security/canary.js"
AGENT_KEEPALIVE=0 AGENT_INTERVAL=86400 AGENT_ENV= write_agent com.jarvis.jarvissecurity /bin/bash "$ROOT/security/verify.sh"
# HOW MANY MODELS OLLAMA MAY HOLD (his rule). 2026-09-23: one — three at once had frozen the 8 GB Mac. Since
# 2026-10-09: four, because jarvis-os/ollama.js makeRoomFor keeps a heavy model alone and the light ones (chat
# model, reader, embedders) within a memory budget — so the chat model keeps its cached prompt between turns.
# Ollama.app has no setting for it, so launchd hands it the environment variable at login; Ollama reads it when it
# starts. Off switch: launchctl bootout gui/$UID/com.jarvis.ollamaonemodel && launchctl unsetenv OLLAMA_MAX_LOADED_MODELS
AGENT_KEEPALIVE=0 AGENT_INTERVAL= AGENT_ENV= write_agent com.jarvis.ollamaonemodel /bin/launchctl setenv OLLAMA_MAX_LOADED_MODELS 4

# ── 6. integrity baseline (per machine — a copied manifest means nothing) ───
say "integrity baseline"
if [ "$CHECK_ONLY" = 1 ]; then
  [ -f security/integrity.manifest ] && ok "manifest present" || bad "no manifest — would be baselined"
else
  bash security/integrity.sh >/dev/null 2>&1 && ok "baselined" || bad "baseline failed"
  bash security/verify.sh 2>&1 | tail -1 | sed 's/^/  /'
fi

# ── 7. liveness ────────────────────────────────────────────────────────────
say "checking it actually answers"
sleep 3
if curl -s -o /dev/null -m 8 -w '' http://127.0.0.1:8787/ 2>/dev/null; then ok "jarvis-os answering on :8787"
else warn "jarvis-os not answering yet — check logs/com.jarvis.jarvisos.log"; fi

# ── 8. the part no script may do ───────────────────────────────────────────
cat <<'PERMS'

──────────────────────────────────────────────────────────────────────────
  THE ONLY REMAINING STEPS ARE YOURS. macOS will not let a script grant
  these, and each one fails silently-but-plausibly if skipped:

  System Settings → Privacy & Security →
    · Accessibility      → JarvisControl    (without it, clicks post ok
                            and do nothing — this failure recurred 5×)
    · Microphone         → ClapListener     (wake word + claps)
    · Screen Recording   → JARVIS OS / Terminal (screen control, vision)
    · Camera             → JARVIS OS        (face recognition, vision)
    · Automation         → allow control of Brave, Notes, Contacts,
                            Messages, Shortcuts as prompted

  Shortcuts app: Focus Guard needs two shortcuts named exactly
    · "AIC DND On"    · "AIC DND Off"
  (they toggle a Focus mode; recreate them by hand — they are not files)

  Then re-run:  ./install.sh --check
──────────────────────────────────────────────────────────────────────────
PERMS
