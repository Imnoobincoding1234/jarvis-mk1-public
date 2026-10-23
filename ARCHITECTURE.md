# JARVIS MK-1 — Architecture (recon 2026-07-16, brought up to date 2026-10-22)

## Stack
- **JarvisOS backend** = `jarvis-os/server.js` — **zero-dependency Node.js** HTTP server, binds `127.0.0.1:8787`. No framework. Launchd agent `com.atharv.jarvisos`.
- **UI** = web view. `jarvis-os/public/index.html` + `app.js` (**vanilla JS**, no framework). Served by the Node server; also wrapped in a native WKWebView shell (`JARVIS OS.app`). This is "the JarvisOS app UI".
- **State/logs**: `jarvis-os/state/*.json` (automations, watchers, memory, workflows, jobs), `jarvis-os/logs/jarvisos.log`.

## LLM invocation (`llm()` in server.js)
- Dual-brain router: **OpenRouter** (online, primary) → **local Ollama** (offline fallback).
- Local = Ollama **NATIVE** `POST http://127.0.0.1:11434/api/chat` with `think:false`, model tag read from `JARVIS_LOCAL_MODEL`, which on this machine is **`qwen2.5:3b-instruct-q4_K_M`**
  (verified in `.env` 2026-09-11; the `qwen3.5:0.8b` this file used to name is only the fallback
  default in `server.js` when the variable is unset, and is not what actually runs here).
- Vision = the hosted model when a key exists, otherwise the LOCAL `qwen3-vl:2b` (3.1 GB at 4096 ctx,
  keep_alive 30s). There is no OpenRouter key on this machine, so everything is local and the UI and
  `jarvis-cli.js` no longer show a "back-up mode" label (removed 2026-09-17); `backupMode()` still
  exists in server.js because it switches prompts to their leaner local form.
- **Which model does which job** (Settings → Models reads the same getters): plain chat replies = `jarvis` (Bonsai 4B 1-bit
  + my v4.2 LoRA) on the pinned `runtime/llama-server` via `jarvis-os/loraserver.js` (since 2026-10-13); rewrites, checks and
  routing = the 3B above; reasoning = `phi4-mini`; Think hard = `hf.co/prism-ml/Bonsai-8B-gguf:Q1_0`; vision as above.
  A composer candidate (phi4-mini drafts, `JARVIS_COMPOSE_V3`) is in the code and OFF — `finetune/README.md` "Composer C2".
- **The reader** = `jarvis-reader` (Qwen3.5-0.8B + a LoRA adapter trained on my messages, built by
  `finetune/export_reader.sh`), called through `jarvis-os/readmodel.js` with `POST /api/generate` (raw
  prompt, thinking off, logprobs on).
- **Residency** (since 2026-10-09): every model call goes through `ollama.js` makeRoomFor — a heavy model (the 3B,
  phi4-mini, vision, Bonsai 8B) is always alone; the light ones (jarvis, the reader, the embedders) share within
  `JARVIS_MODEL_BUDGET_GB` (default 0 = one generation model + embedders); Ollama may hold four. Ollama is 0.40.3,
  auto-update off.

## Command handling (ALREADY EXISTS — extend, don't rebuild)
- `runAction(act, opts)` — whitelisted executor. Types today: `open_app`, `close_app` (confirm-gated), `open_url`, `open_social`, `search_web`, `run_shortcut`, `run_workflow`, plus every tool `system_control.js` provides (files, apps, system, trash), each behind its own safety checks and undo.
- `quickAction(text)` — reads the reader's pre-warmed cache: one reading per sentence, kept only if
  `readmodel.build` accepts it (values copied from my words, names resolved in registries, confidence
  0.75 or an "Should I …?" ask down to 0.3, open/close and create/delete direction from the model's own
  probabilities and my answers in `verblex.js`). `actread.js` covers open / close / system when the
  reader model is missing. `classifyAction`, `quickActionCore`, the 3B normaliser and
  `config/verbs.json` are DELETED.
- `handleChatInner` pre-warms the reader on the whole sentence, then only on the pieces
  `clauseSplit` asks about; `context.resolveInText` asks the 3B what "it"/"him" stands for — only when the reader's
  `refers` flag says the sentence leans on something earlier.
- `handleChat` routes: control-intent → screen control; a reading the reader holds → the action lane;
  a procedure (`playbook.js`) → its executor or the agent loop; else normal chat.
- Confirm flow: `close_app` returns `needsConfirm`; client `state.pendingConfirm` resolves via yes/no (typed or spoken).
- Audit today = `jlog()` → `jarvisos.log` (not a structured action log yet).

## Gaps vs mission (what's NEW)
| Pillar | Have | Build |
|---|---|---|
| File/folder ops | — | create/delete(→Trash)/rename/move/copy/list/search/read/append + path resolver |
| App control | open/close/url | fuzzy `/Applications` match, list_running, switch_to, hide, force-quit, finder |
| make_app | — | scaffold .app bundle under `apps/<name>/` |
| system_status etc | stats endpoint | status/volume/brightness/screenshot/sleep/empty_trash tools |
| Safety | close-confirm only | protected-path hard-block, confirm-all-destructive, `logs/actions.log`, dry-run flag |
| Parsing | quickAction+classify | the reader model + `readmodel.js`'s checker (replaced both); `verblex.js` holds only my answers about which way a phrase goes; `context.js` resolves "it" extractively with the 3B |
| Routing | regex lanes | semantic regions via `intent.js` — `webintent` (needs the web?), `calintent` (my calendar?), `replyhedge` (did the reply answer?), `shapeOf` (which plan shape) |
| Language | English only | `lang.js` + `intent.js` detect Hinglish and score it with `granite-embedding:278m`; English is read by `nomic-embed-text`. The two vector spaces are never compared |
| Embedder | one model for everything | `nomic-embed-text` is the default (74/81 held-out routing goals, 0 wrong, against all-minilm's 68/81 with 7). Six readers pin `all-minilm` on measurement — `itemclass` (bare item words), `replyclaim`/`replyhedge` (JARVIS's own reply read back), `calintent`, and `errand`/`actread` (short spans and single words). Each pin states its measurement at the call site |
| UI | boot+status+log console | action/confirm cards, status rail, actions.log viewer |

## Layout today
`apps/`, `config/` and `logs/` exist. The repo is git, backed up to a private GitHub repo with an
encrypted vault (`private/vault.enc`, `tools/vault.sh`); `install.sh` restores a machine from it, and
`finetune/` holds the reader model's training scripts (its data, weights and venv are not in git).
