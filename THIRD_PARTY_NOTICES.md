# Third-party files in this repository

`LICENSE` (MIT) covers JARVIS's own code and the adapters trained here. These bundled files are someone else's
work and keep their own terms. Models that `install.sh` downloads (Bonsai, Qwen, phi4-mini, the embedders) are
not in the repository; each comes with its own licence from where it is pulled.

| path | what it is | terms |
|---|---|---|
| `runtime/llama-server` | llama.cpp's server, the build bundled in Ollama.app 0.33.3 (`runtime/README.md`) | MIT, © the ggml authors, plus its vendored libraries — full text in `runtime/LICENSE-llama.cpp.txt` |
| `jarvis-os/public/vendor/globe.gl.min.js` | globe.gl (github.com/vasturiano/globe.gl) | MIT |
| `jarvis-os/public/vendor/satellite.min.js` | satellite.js (github.com/shashwatak/satellite-js) | MIT |
| `jarvis-os/public/vendor/faceapi/` | @vladmandic/face-api and the face-api.js models it loads | MIT |
| `jarvis-os/public/vendor/earth/` | three-globe's example textures, derived from NASA Blue Marble / Black Marble | MIT package; NASA imagery is public domain (sources and hashes in that folder's `README.md`) |
| `jarvis-os/public/vendor/countries.geojson` | Natural Earth admin-0 countries | public domain |
| `finetune/adapters/bonsai_v42_s1/` | the chat LoRA, trained here on PrismML's Bonsai-4B | the base model is Apache-2.0 |
| `finetune/adapters/current/`, `finetune/reader_gguf/` | the reader LoRA, trained here on Qwen3.5-0.8B, and headers taken from that model's GGUF | the base model's own licence (its Hugging Face model card) |
| `library/` — the 25 `.epub` books | Project Gutenberg editions | public domain in the US; Project Gutenberg's terms travel with each file |
| `library/Life_Skills/FM21-76_US_Army_Survival_Manual.pdf` | US Army field manual FM 21-76 | US government work, public domain |
| `library/Life_Skills/Where_There_Is_No_Doctor.pdf` | Hesperian Health Guides | © Hesperian. Shared under Hesperian's own terms (free or at cost, not for profit) — **not** covered by `LICENSE` |
