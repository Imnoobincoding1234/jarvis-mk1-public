#!/bin/bash
# ---------------------------------------------------------------------------
# JARVIS secret + personal-data vault.
#
# WHY THIS EXISTS. The goal is "my Mac dies, I clone one repo and JARVIS is back". That needs the
# API keys, the auth tokens, the face enrolments and the profile — the things that make it HIS
# assistant rather than a fresh install. It also means those things end up on GitHub.
#
# A private repo is not a safe place for them. It is readable by anything holding an account token,
# it is in scope for an account breach, and git history is PERMANENT: a key committed today and
# deleted tomorrow is still in the history. One accidental flip to public exposes everything at once.
#
# So they go in encrypted. AES-256-CBC with PBKDF2 (200k iterations) via the openssl already on
# macOS — no dependency added, nothing to install. The repo carries private/vault.enc, which is
# useless without the passphrase. A repo leak stops being a data leak.
#
# THE PASSPHRASE IS NOT IN THE REPO AND CANNOT BE. Keep it in a password manager. Losing it means
# losing the vault — the code still restores, but the keys and enrolments do not.
#
#   ./tools/vault.sh pack     encrypt the live files into private/vault.enc  (before committing)
#   ./tools/vault.sh unpack   restore them onto a fresh machine              (after cloning)
#   ./tools/vault.sh list     show what is inside, without decrypting to disk
# ---------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VAULT="private/vault.enc"

# Everything here is either a credential or personal data. Anything absent is skipped without
# complaint — a fresh machine has not created its tokens yet, and that is not an error.
ITEMS=(
  ".env"
  "jarvis-control/.token"
  "jarvis-os/state/.apitoken"
  "jarvis-os/faces"
  "jarvis-os/state/profile.json"
  "jarvis-os/state/episodes.json"
  "jarvis-os/state/memory.json"
  "jarvis-os/state/location.json"
  # THE SCHEMA VERSIONS, and they belong with the data rather than beside it.
  # store.js records which migration version each state file has reached. Restore a
  # migrated episodes.json WITHOUT this and every migration re-runs from version
  # zero against data that has already been through them — a doubled transform on
  # the one store that cannot be regenerated. Nothing registers a migration yet, so
  # this is a trap being closed before it is stepped in rather than a live bug.
  "jarvis-os/state/.schema.json"
  # WHAT HE TAUGHT THE ITEM CLASSIFIER, which is the half of that cache no machine can rebuild.
  # Most of itemclass.json is regenerable — re-embed the word and the same verdict comes back. The
  # entries marked `taught` are not: they are his answers to questions the classifier could not
  # settle on its own, and dropping them means a restored machine asks him all of them again, one
  # order at a time. Small file, and the alternative is losing knowledge that only he has.
  "jarvis-os/state/itemclass.json"
  "config/ordering.json"
  "jarvis.yaml"
  # THE READER MODEL CANNOT BE DOWNLOADED. jarvis-reader, which reads every request, is built on this
  # machine from a LoRA adapter trained on his own messages (finetune/export_reader.sh), so a restore
  # needs both halves: the adapter, to rebuild the model in minutes, and his labelled messages, to ever
  # train it again. export_reader.sh keeps adapters/current pointing at the adapter the live model was
  # built from. ~29 MB of weights, so each pack after a retrain adds about that much to the history.
  "finetune/adapters/current/adapters.safetensors"
  "finetune/adapters/current/adapter_config.json"
  "finetune/data"
  # HIS ANSWERS TO THE READER'S QUESTIONS: which way a verb goes (verblex), which "Should I…?" he
  # confirmed, and where "always" puts new folders. A few KB, and only he can give them again.
  "jarvis-os/state/verblex.json"
  "jarvis-os/state/readmodel.confirmed.json"
  "jarvis-os/state/places.json"
  # THE CHAT MODEL CANNOT BE DOWNLOADED EITHER (2026-10-08). `jarvis` is PrismML's Bonsai 4B, which can be pulled
  # (ollama pull hf.co/prism-ml/Bonsai-4B-gguf:Q1_0), plus the v4.2 LoRA trained here — rebuilt with
  # `ollama create jarvis -f finetune/Modelfile.jarvis`. Only the GGUF form: it holds the same weights as the MLX
  # adapter (transposed, float32), so it also converts back for another round, and both would add ~58 MB per pack.
  "finetune/adapters/bonsai_v42_s1/jarvis-v42-lora.gguf"
  "finetune/adapters/bonsai_v42_s1/adapter_config.json"
)

# Public datasets downloaded into finetune/data (Mind2Web / MolmoWeb, 6.2 GB; the 7 external sets, 1 GB). Anyone can
# fetch them again (finetune/fetch_molmoweb.js, m2w_stream.js), and with them the vault would be gigabytes — past
# GitHub's 100 MB file limit. Everything else in finetune/data (his labelled messages, the hand reviews, held-outs,
# built sets: ~75 MB raw) still goes in.
EXCLUDE=("finetune/data/external" "finetune/data/external_web")
TAR_EXCLUDE=(); DIFF_EXCLUDE=()
for x in "${EXCLUDE[@]}"; do TAR_EXCLUDE+=("--exclude=$x"); DIFF_EXCLUDE+=("-x" "$(basename "$x")"); done

enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt "$@"; }

case "${1:-}" in
  pack)
    mkdir -p private
    present=()
    for i in "${ITEMS[@]}"; do [ -e "$i" ] && present+=("$i"); done
    if [ ${#present[@]} -eq 0 ]; then echo "nothing to pack"; exit 1; fi
    echo "packing ${#present[@]} item(s):"; printf '  %s\n' "${present[@]}"
    # -P so the passphrase is prompted twice and never appears in argv or the shell history.
    tar -czf - "${TAR_EXCLUDE[@]}" "${present[@]}" | enc -out "$VAULT"
    chmod 600 "$VAULT"
    echo "→ $VAULT ($(du -h "$VAULT" | cut -f1)) — safe to commit."
    ;;
  unpack)
    [ -f "$VAULT" ] || { echo "no $VAULT here"; exit 1; }
    echo "restoring secrets and personal data from $VAULT"
    enc -d -in "$VAULT" | tar -xzf - -C "$ROOT"
    # The tokens and .env are read by daemons; keep them owner-only exactly as harden.sh leaves them.
    chmod 600 .env 2>/dev/null || true
    chmod 600 jarvis-control/.token jarvis-os/state/.apitoken 2>/dev/null || true
    echo "→ restored. Verify with: ls -l .env jarvis-os/faces"
    ;;
  list)
    [ -f "$VAULT" ] || { echo "no $VAULT here"; exit 1; }
    enc -d -in "$VAULT" | tar -tzf -
    ;;
  verify)
    # A BACKUP NOBODY HAS RESTORED IS NOT A BACKUP, IT IS A HOPE.
    #
    # `list` only proves the passphrase decrypts something. This proves the vault actually contains
    # the live files, byte for byte — it extracts to a temporary directory and diffs against what is
    # on disk right now. Nothing in the working tree is touched, so it is safe to run any time, and
    # it is the only check that would catch a vault packed from a half-empty tree.
    [ -f "$VAULT" ] || { echo "no $VAULT here"; exit 1; }
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    if ! enc -d -in "$VAULT" 2>/dev/null | tar -xzf - -C "$TMP" 2>/dev/null; then
      echo "✗ could not decrypt — wrong passphrase, or the vault is damaged."
      exit 1
    fi
    echo "✓ decrypted"
    # Walked over the MANIFEST, not over whatever happens to be in the archive: the question worth
    # answering is "does the vault hold everything it promised, unchanged", and only the manifest
    # says what was promised.
    fail=0
    for i in "${ITEMS[@]}"; do
      in_vault=0; [ -e "$TMP/$i" ] && in_vault=1
      on_disk=0;  [ -e "$ROOT/$i" ] && on_disk=1
      if [ $in_vault = 1 ] && [ $on_disk = 1 ]; then
        if diff -rq "${DIFF_EXCLUDE[@]}" "$TMP/$i" "$ROOT/$i" >/dev/null 2>&1; then
          printf '  ✓ %-32s matches disk\n' "$i"
        else
          printf '  ✗ %-32s DIFFERS from disk — vault is stale\n' "$i"; fail=1
        fi
      elif [ $in_vault = 1 ]; then
        printf '  · %-32s in vault, not on disk (fine before a restore)\n' "$i"
      elif [ $on_disk = 1 ]; then
        printf '  ✗ %-32s ON DISK BUT MISSING FROM VAULT\n' "$i"; fail=1
      fi
    done
    echo
    [ "$fail" = 0 ] && echo "✓ vault verified — it restores what is on this machine." \
                    || { echo "✗ vault is NOT a faithful backup. Re-run: $0 pack"; exit 1; }
    ;;
  *)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
