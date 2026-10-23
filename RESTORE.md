# Bringing JARVIS back

If the Mac is gone, this is the whole procedure. Budget ~40 minutes, most of it waiting on model
downloads and building the reader model, plus however long the permission clicking takes.

```bash
git clone https://github.com/<you>/jarvis-mk1.git ~/"JARVIS MK-1"
cd ~/"JARVIS MK-1"
./tools/vault.sh unpack        # passphrase from your password manager
./install.sh
```

Then grant the permissions the installer lists at the end, and re-run `./install.sh --check`.

Cloning a private repo needs auth first — on a fresh Mac that is `brew install gh && gh auth login`
(choose HTTPS; it stores an OAuth token in the Keychain and configures git's credential helper, so
nothing prompts for a password afterwards).

---

## What the repo holds, and what it deliberately does not

| | where it lives | why |
|---|---|---|
| all source, config, playbooks, tests, the training scripts in `finetune/` | git, in the clear | it is the system |
| API keys, auth tokens, face enrolments, profile, episodic memory | `private/vault.enc` | encrypted before it reaches a commit |
| the reader model's adapter (`finetune/adapters/current/`, 29 MB) | git, in the clear (since 2026-09-24) | weights only, so any install can build the reader |
| my labelled training messages, my answers to the reader's questions | `private/vault.enc` | my own sentences — needed only to TRAIN again, not to run |
| Ollama models (~11 GB: the 3B helper, vision, THREE embedders, reasoning, Bonsai 4B = the chat model's base, Bonsai 8B = Think hard) | nowhere — re-pulled by `install.sh` | too large, and freely re-downloadable |
| the chat model `jarvis`: its LoRA (`finetune/adapters/bonsai_v42_s1/jarvis-v42-lora.gguf`) | `private/vault.enc` | trained on my own messages; `runtime/llama-server` (in git) serves it on top of the pulled Bonsai 4B |
| `jarvis-reader` (1.0 GB) | nowhere — **rebuilt** by `install.sh` from the adapter | a fine-tuned model is not in any registry |
| logs, incl. `clap.log` | **never committed** | `clap.log` is a transcript of what the microphone heard in the house. Regenerable noise with a real privacy cost |
| `library.json` (26 MB), integrity manifest | nowhere — rebuilt | derived data; a copied integrity manifest is worse than none, since hashes are per-machine |
| `.app` bundles | nowhere — rebuilt | built from the source in the repo |
| `backups/` — pre-edit copies (`tools/bak.sh`), retired components | this Mac only | git *is* the history for tracked files, and the vault carries the live copies of the rest |
| the base model (1.6 GB), the training venv, old checkpoints | nowhere — re-downloaded | `install.sh` fetches what the rebuild needs |

### Why the vault, rather than just committing the files

A private repo is not a vault. It is readable by anything holding an account token, it is in scope
for an account breach, and **git history is permanent** — a key committed today and deleted tomorrow
is still in the history forever. One accidental flip to public exposes everything at once.

So the sensitive set is encrypted first (AES-256-CBC, PBKDF2, 200k iterations, via the `openssl`
already on macOS). The repo carries `private/vault.enc`, which is useless without the passphrase.
A repo leak stops being a data leak.

**The passphrase is not in the repo and cannot be.** Keep it in a password manager. Lose it and the
code still restores perfectly — the keys, the face enrolments and the profile do not.

---

## The reader model is built, not downloaded

`jarvis-reader` reads every request (`jarvis-os/readmodel.js`). It is Qwen3.5-0.8B with a LoRA adapter
trained on my own messages, so `ollama pull` cannot fetch it. `install.sh` rebuilds it:

1. the adapter is already in the clone at `finetune/adapters/current/` (the vault restores my labelled data to
   `finetune/data/`, which only retraining needs)
2. a Python 3.14 venv is made in `finetune/.venv` from `requirements.txt` (Apple's `python3` is too old —
   `brew install python@3.14` first)
3. the base model is downloaded once from Hugging Face (`Qwen/Qwen3.5-0.8B`, 1.6 GB)
4. `finetune/export_reader.sh` fuses the adapter, restores the published tensor layout, writes the two GGUF files itself
   (`finetune/reader_gguf.py` — Ollama 0.40.3 cannot make q8_0; the files come out byte-identical to the live model,
   checked 2026-10-19) and runs `ollama create jarvis-reader`, with the heavy steps under `finetune/guard.py`

**If it is missing, JARVIS still starts and answers — and only open / close / system requests parse.**
Files, searches and playing things fall through, which looks like a dim JARVIS rather than a missing
model. `./install.sh --check` says so, and `node tests/test_parse.js` exits 1 at its first reading.

**Pack the vault after every retrain.** `export_reader.sh` points `adapters/current` at the adapter it
just built from, but only `./tools/vault.sh pack` puts it where a restore can find it. Each pack after a
retrain adds about 30 MB to the repo history.

---

## The parts no script can do

macOS TCC permissions are granted by a human clicking a checkbox, per machine. That is the point of
TCC, and it is not a limitation to route around. Each of these fails *silently but plausibly* when
skipped, which is what makes them worth checking deliberately:

- **Accessibility → JarvisControl.** Without it, `CGEvent` posts return `ok:true` and nothing moves.
  This exact failure recurred five separate times; the daemon looks healthy the whole way through.
- **Microphone → ClapListener.** Wake word and clap detection.
- **Screen Recording → JARVIS OS / Terminal.** Screen control and vision.
- **Camera → JARVIS OS.** Face recognition and vision.
- **Automation.** Approve Brave, Notes, Contacts, Messages, Shortcuts when prompted.

**Shortcuts.** Focus Guard drives two shortcuts named exactly `AIC DND On` and `AIC DND Off`. They
are not files and cannot be committed — recreate them by hand in the Shortcuts app.

---

## Things that were outside the folder, and now are not

Two components lived outside `~/JARVIS MK-1` and would have been silently lost by a folder-only
backup. Both were moved in, so the repo boundary is now the truth:

- **Focus Guard** was in `~/claude code test/focus-guard/` with a live launchd agent pointing there.
  Now at `focus-guard/`, and the agent is regenerated by `install.sh` from the repo root.
- **Jarvis Search's real source** was only in `~/Documents/Codex/2026-07-04/can/work/JarvisSearch/`.
  The copy inside the tree was a stale "UI Handoff" folder containing **no `main.swift` at all**
  (moved to `backups/` on 2026-09-18, with the app builds made from it).
  The real source is now vendored at `Jarvis Search/src/` and that is the **only** copy — the Codex
  original was retired on 2026-08-28 after the two drifted apart in a single afternoon. Build it with
  `cd "Jarvis Search/src" && bash build.sh`, then copy the bundle over `Jarvis Search/Jarvis Search.app`
  and re-register it with `lsregister -f`.

`install.sh` **generates** the launchd plists from wherever the repo is checked out rather than
committing them. The originals hardcoded `/Users/atharv/...`, and one of them pointed outside the
repo for months without anyone noticing — generated paths are correct by construction, on any
machine and any username.

---

## Verifying a restore actually worked

Do not trust the installer's own summary. Inspect the machine:

```bash
./install.sh --check                       # every prerequisite, model (the reader too), agent, baseline
ollama list | grep jarvis-reader           # the reader model is there
cd jarvis-os && node tests/run_all.js      # all 24 suites below in one table — or one at a time:
node tests/test_parse.js                   # 1052 passing — needs jarvis-reader; the parser end to end
node tests/test_readmodel.js               # 160 passing — the reader's checker, no model
node tests/test_store.js                   # 46 passing
node tests/test_stress.js                  # 305 passing
node tests/test_reflective.js              # 555 passing
node tests/test_context.js                 # 35 passing
node tests/test_modelprofile.js            # 105 passing
node tests/test_clauses.js                 # 14 passing — "and"/"then" routing
node tests/test_verblex.js                 # 23 passing — my answers about a phrase, per pair
node tests/test_errand.js                  # 34 passing — what a request names
node tests/test_ainews.js                  # 83 passing — the Sunday AI/ML week, no network, no model
node tests/test_dreamintent.js             # 12 passing — dream mode, asked not listed (needs ollama)
node tests/test_proactiveintent.js         #  6 passing — JARVIS's nudges, asked not listed (needs ollama)
node tests/test_panels.js                  #  5 passing — the World Monitor / neural network, read by the reader
# The rest need ollama: they ask the embedder real questions, because a stub
# would only ever test the stub.
node tests/test_centroids.js               # 8 passing
node tests/test_itemclass.js               # 19 passing
node tests/test_intent.js                  # 85 passing
node tests/test_webintent.js               # 22 passing
node tests/test_calintent.js               # 25 passing
node tests/test_replyhedge.js              # 21 passing
node tests/test_sitekind.js                # 43 passing — what errand a website serves
node tests/test_lang.js                    # 17 passing — Hinglish detection + model routing
node tests/test_selffact.js                # 23 passing — what is remembered, and what answers
node tests/test_actionintent.js            #  1 passing
node tests/test_install.js                 # 48 passing — needs network too (two registries)
node tests/test_eval.js                    # 46 real tasks, judged by inspecting the machine
# 3,170 assertions across 53 suites when everything is green (2026-10-22; `node tests/run_all.js`), plus test_install's 48.
cd .. && ./security/verify.sh && node security/canary.js
./tools/vault.sh verify                    # the vault holds what this machine has, byte for byte
```

If `test_eval.js` prints `RUN INVALID`, the identity gate is on and the run measures nothing — that
is a configuration problem, not a regression.
