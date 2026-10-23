# runtime/ — the pinned llama-server that serves `jarvis`

Since 2026-10-13 ("option 3", my go) the chat model `jarvis` — Bonsai 4B (1-bit, Q1_0) with my v4.2 LoRA — is served by
`jarvis-os/loraserver.js` through the `llama-server` in this folder, with the adapter loaded at runtime. It no longer
depends on Ollama's adapter models: Ollama 0.34.1 removed `ollama create … ADAPTER`, and 0.40 logs "LoRA adapters are
deprecated and will be removed". Ollama still serves everything else (the reader, the 3B, phi4-mini, the embedders).

| file | what it is |
|---|---|
| `llama-server` | the arm64 slice (`lipo -thin arm64`) of the llama-server bundled in Ollama.app **0.33.3** — llama.cpp commit `0f3a71be1`, still signed by Ollama (team 3MU9H2V9Y9). Links only macOS system frameworks. sha256 `71f3955613d4513dbf3010f571ed1609264f0aa1628401daa6716d54c26b4687` |
| `jarvis.jinja` | jarvis's chat template, byte-identical to `ollama show jarvis --template` |
| `jarvis.params.json` | jarvis's sampling defaults, as in its Ollama manifest (Modelfile.jarvis + the Bonsai base) |

The base weights come from the installed Ollama model `hf.co/prism-ml/Bonsai-4B-gguf:Q1_0` (its blob, read from the
manifest), and the adapter from `finetune/adapters/bonsai_v42_s1/jarvis-v42-lora.gguf` (restored by the vault; same sha256
as Ollama's adapter blob). Override with `JARVIS_LORA_BASE` / `JARVIS_LORA_ADAPTER` in .env.

On a restored Mac `install.sh` (step 3a, after the vault) pulls the base and checks `loraserver.js`'s own lookup, which reads
Ollama's `manifests/` and, for models pulled by 0.40.x, `manifests-v2/` (2026-10-19). Ollama 0.40 cannot create the old
`jarvis` adapter model, so on a fresh Mac the "falls back to Ollama" path below has nothing to fall back to — this server is
the only way `jarvis` runs there.

**Measured before it went in** (`backups/option3-sandbox-20261013/README.md`): 59 JARVIS-shaped requests — 24 chat, 3
streamed, 16 Wikipedia answers, 16 answer checks with top-20 logprobs — gave 59/59 identical output to Ollama's `jarvis`,
the same prompt token counts and yes-shares, at the same speed (median 528 vs 545 ms, 42 tok/s) and memory (~1.25 GB).

**Off switch:** `JARVIS_CHAT_REPLY_RUNTIME=ollama` in .env (read on every call) — jarvis then goes through Ollama again,
for as long as Ollama can still serve an adapter model. If this server cannot start, loraserver.js falls back to Ollama
by itself and logs it.

**Updating the binary:** only with a measurement like the one above (same requests, identical output) — a different
llama.cpp can tokenise or sample differently. Run `security/integrity.sh` after any change here.
