<div align="center">

# 🤖 JARVIS MK-1

**A personal AI assistant that runs on one Mac — and can prove what it did.**

🏠 Local-first &nbsp;·&nbsp; 🪶 74 MB idle, ~1.4 GB per command &nbsp;·&nbsp; 📦 Zero npm packages &nbsp;·&nbsp; 🎯 A 0.8B trained on my own messages &nbsp;·&nbsp; ✅ 3,170 assertions &nbsp;·&nbsp; 🔒 Encrypted vault

</div>

---

Still under development. Local model, no cloud dependency for the things that matter, and **every capability wired to
something it can actually verify afterwards**.

It talks 🗣️ (voice in and out, in a local neural voice), drives a browser 🌐, controls the screen 🖱️, reads the camera 📷,
watches world events 📰, remembers what it is told 💾, installs and removes software 📦, and supervises its own agents 🤝.

### 🪶 What it costs to run

**74 MB idle. One model at a time: ~1.1 GB for a command, ~2.4 GB when the 3B answers.** Measured on the
machine, not estimated — the processes with `ps` (2026-09-12), the models with `ollama ps` and live
sampling (2026-09-17 → 09-24) — and the headline is that almost none of it is JARVIS:

| state | RAM | what is in it |
|---|---|---|
| 💤 **idle** | **74 MB** | all seven processes; no model loaded once they have been idle — 60 seconds for the embedders, 2 minutes for the reader, 30 s for the 3B |
| 🎯 **a command** | **~1.1 GB** | the reader (1.1 GB); the embedders (249 MB, 28 MB) load in turn, never beside it |
| 💭 **a question, or a turn with history** | **~2.4 GB** | the 3B at 8192 ctx, alone — since 2026-09-23 Ollama holds **one model at a time**. Measured: free memory 58% → 17–22% while it is loaded (pressure "warn") |
| 📈 **peak** | **phi4-mini, alone** | a reasoning turn. Measured 2026-09-24: 12% free at the live 8192 context, 14% at 4096 — the heaviest thing JARVIS does, and a known hazard on 8 GB |

> **Since 2026-10-09 one gate decides what may share memory** (`jarvis-os/ollama.js` makeRoomFor, my rule): a
> heavy model (1.5 GB or more on disk — the 3B, phi4-mini, vision) is always alone; the light ones (`jarvis`, the
> reader) share only within `JARVIS_MODEL_BUDGET_GB` (default 0 = never two generation models at once); the
> embedders may sit beside one. Ollama's own cap is 4 (`com.atharv.ollamaonemodel`). It replaced 2026-09-23's
> `OLLAMA_MAX_LOADED_MODELS=1`, and paragraphs below that talk about models sharing the machine describe the
> older setups. **Plain chat replies now come from `jarvis`** (Bonsai 4B, 1-bit, with my own LoRA — 601 MB on
> disk), not the 3B. Details in HANDOFF.md.

Every megabyte this repo is actually responsible for:

| process | RSS | |
|---|---|---|
| `jarvis-os/server.js` | **11.8 MB** | the entire assistant — router, agent loop, memory, browser control, UI |
| `clap-daemon` | 16.5 MB | wake word + clap detection, including ~38 MB of graphs when armed |
| `ollama serve` + `Ollama.app` | 21.4 MB | the model supervisor, not a model |
| `Jarvis Search` | 5.7 MB | the ⌘9 overlay |
| `FocusGuard` | 5.2 MB | gesture-armed Do Not Disturb |
| `JarvisControl` | 3.2 MB | native screen control |

Everything beyond that is model weights, which are whatever you point it at rather than anything
written here. On an 8 GB machine that is the entire design constraint: **as little resident as
possible, for as short a time as possible.** `phi4-mini` never sits beside the 3B — two of them at once
is what froze the machine the day this rule was learned — so it unloads the 3B before it loads and is
unloaded on the way back. The reader (1.1 GB) does share the machine with the 3B, and that is the
current pressure point: Ollama logged 1.0–2.0 GiB free in such a turn.

**Holding models longer made everything slower, and was reverted the same evening.** Ollama here keeps
three models loaded, JARVIS can want four (reader, 3B, two embedders), and when Ollama must make room it
unloads the idle model with the SHORTEST keep-alive — measured in four orders, including one where that
model was not the next to expire. So on 2026-09-17 the keep-alives were turned into an order (embedders
4 minutes < 3B 5 minutes < reader 15 minutes). Measured alone, a turn 150 s after a question went from
5.2 s to 1.4 s. On the real machine it kept ~1.4 GB more loaded between turns, on top of an evening of
test runs that had already pushed 5.3 GB into swap; with Brave and Spotify open, memory went to ~7.5 of
8 GB, every script JARVIS ran in Brave took 5–26 seconds, and "play let me down slowly" took 123 s. How
much of that was the change and how much the swap already there was not separated — it made things
worse and nothing better, so it is back to 60 seconds for the embedders and 2 minutes for the reader. The lesson is the measurement's, not Ollama's: a speed-up measured with nothing else running
says nothing about an 8 GB machine that is also running a browser. The real saving is the 3B itself —
the reference resolver loads it (2.4 GB, 16.8 s cold on that turn) on every turn with history, and the
next retrain moves that question into the reader. Measured 2026-09-24, its cost is the PROMPT, not the
answer: 514 tokens at ~120 tok/s (Low Power Mode) because the cache never survives one model at a time.
It is now skipped when the reader and the leaning embedder both read the message as self-contained —
0 real references skipped on 134 held-out, ~18% of calls saved (`sweeps/sweep_refskip.js`).

> 🔍 **Two honest caveats on those numbers.** The ~3.1 GB peak is **extrapolated** from the 3B's
> resident-to-file ratio (a 1.9 GB file sitting at 2,127 MB resident); `phi4-mini` was deliberately
> not loaded to find out, on an 8 GB machine. And RSS under macOS's unified memory is not quite
> "RAM consumed" — ollama's own accounting reports 2.4 GB where `ps` reports 2.13 GB for the same
> model, so treat the mid-thought figure as a band rather than a point.

Roughly **50k lines of Node and Swift with no package manager anywhere** — the Node server is stdlib only. The two neural
extras it does use, the voice and the wake word, are external binaries it shells out to or links against, the same way it
already shells out to `say` and `ollama`. The one place with packages is `finetune/`, where the reader model is trained:
Python and MLX, pinned in `requirements.txt`, run by hand and never part of the running assistant.

### 🧩 What it actually does

| | |
|---|---|
| 🗣️ **Talks** | Local neural voice (piper), streamed clause-by-clause while the model is still generating |
| 🌐 **Drives the browser** | Real navigation, form filling, clicking results — not screenshots-and-guesses |
| 🖱️ **Controls the screen** | Enumerates real macOS controls and presses one **by number**, never by pixel coordinates |
| 📦 **Installs & removes apps** | Asks two registries what exists, scores identity, verifies afterwards, refuses on doubt |
| 💾 **Remembers** | Told a fact in any phrasing, answers only from what is stored, and can say "you never told me" |
| 🎯 **Reads every request with its own model** | A 0.8B fine-tuned on my messages turns a sentence into one checked action, or asks |
| 🧠 **Routes semantically** | Embeddings and abstention instead of keyword lists — see below, it is the heart of this repo |
| 🎓 **Learns skills** | Teach-mode: shown once, generalised afterwards |
| 📰 **Keeps up with AI** | Dream mode reads 28 AI/ML sources — labs big and small, the AI press, Hugging Face's new models and papers, r/LocalLLaMA — and on Sundays offers the week's short version. The picking is JARVIS's; the local model only phrases it, and a sentence naming anything its story does not is dropped |
| 🔒 **Guards itself** | Integrity baseline, canary, self-healing supervisor, encrypted vault |
| 🧮 **Thinks hard when asked** | A **Think hard** button sends the next question to a bigger 1-bit model with its thinking mode on — minutes, not seconds, and far better at hard logic (6/9 hard puzzles vs ~2/9) |
| ❓ **Explains itself** | Ask *"why did you do that?"* and it answers from its own decision log for that turn — what it read, what it refused, where the time went — never a guess |
| 📋 **Briefs from real data** | The Briefing button builds the brief from the calendar, battery, disk and weather, and greetings mention only what needs you |
| 📖 **Answers facts from a source** | A factual question is answered from the top Wikipedia page by the chat model, which then checks its own answer against that page and keeps it only when it is sure; otherwise the full web lookup runs |
| 🎛️ **Knows its own models** | Settings → Models shows which model does which job, read from the code that runs them; **Calibrate** measures any installed model on this Mac (speed, verbosity, cold start) and changes nothing until you press Keep |
| 🔌 **Connections** | Settings → Connections: a Composio key for cloud apps, and MCP servers added by pasting a link — every tool behind an approval gate, picked per goal by meaning |
| 🌍 **World Monitor** | A realistic live Earth (⌘⇧W) — NASA day and night imagery split at the real terminator, clouds, the sun where it actually is — with ~7,000 live flights, military aircraft, ~900 satellites (Starlink on demand), launches, cyclones, quakes, NASA events and GDACS alerts, as a globe or an accurate flat 2D map. Click anything for details. No API keys |
| 📍 **Finds local businesses** | *"find bakeries in Chandigarh without a website"* — OpenStreetMap, Google Maps read in my own Brave, and the web for missing numbers |

> ### ⚠️ The vault passphrase has no recovery path.
> Secrets, tokens, face enrolments, profile and memory
> live encrypted in `private/vault.enc`. Lose the passphrase and the code still restores perfectly —
> the keys and the enrolments do not. Keep it in a password manager, not here.

---

## 🚀 Bringing it back on a new machine

A step-by-step guide. You never need to understand the code — just follow the steps in order.
Where a step says **type**, click into the Terminal window, type (or paste) the line exactly, and press **Return**.

### ✅ What you need

- **A Mac with Apple Silicon** — any M1, M2, M3, M4, M5 or newer (MacBook, iMac, Mac mini, Mac Studio). Intel Macs are not supported.
  Check:  → **About This Mac** → it says "Chip: Apple M…".
- **macOS 14 (Sonoma) or newer** — same window shows it.
- **Any amount of memory.** 8 GB works (it is what this was built on); 16 GB or more is smoother.
- **About 20 GB of free disk space** and an internet connection — the first install downloads ~9 GB.
- **A Mac mini, Mac Studio or Mac Pro has no built-in microphone.** Plug one in (or connect AirPods) if you want
  voice and claps; everything else works without one.

### 1️⃣ Install the basic tools (≈10 minutes)

1. Open **Terminal**: press **⌘ Space**, type `Terminal`, press **Return**.
2. Type:
   ```bash
   xcode-select --install
   ```
   A window pops up — click **Install**, then **Agree**, and wait until it says the software was installed.
3. Install **Homebrew** (the Mac's app installer for tools): go to **https://brew.sh**, copy the one line on that page,
   paste it into Terminal, press **Return**, and type your Mac password when asked (nothing shows while you type — that is
   normal). **At the end it prints "Next steps" with two or three lines — copy and run those too**, or `brew` will not be found.
4. Type:
   ```bash
   brew install node git gh python@3.14
   ```
5. Type:
   ```bash
   brew install --cask ollama-app
   ```
   Then open **Ollama** once from your Applications folder. A small llama icon appears in the menu bar — leave it there.

### 2️⃣ Download JARVIS (≈2 minutes)

1. If the GitHub repository is private, sign in first:
   ```bash
   gh auth login
   ```
   Pick **GitHub.com → HTTPS → Login with a web browser**, and follow the code it shows you.
2. Download it into the right place (the folder MUST be called `JARVIS MK-1`, in your home folder):
   ```bash
   git clone https://github.com/<owner>/jarvis-mk1.git ~/"JARVIS MK-1"
   ```
3. Go into it:
   ```bash
   cd ~/"JARVIS MK-1"
   ```
4. **Only if this is the owner's own vault** (you have the vault passphrase): restore the private data. Everyone else,
   skip this — JARVIS starts blank and learns about you.
   ```bash
   ./tools/vault.sh unpack
   ```

### 3️⃣ Run the installer (≈20–60 minutes, mostly downloading)

```bash
./install.sh
```

It checks your Mac, installs **Brave** (JARVIS uses it for web search, YouTube and Spotify), downloads the AI models,
builds JARVIS's small helper apps, and starts everything in the background. How to read what it prints:

- **✓ green** — done. **! yellow** — a note, nothing is broken. **✗ red** — something needs you; it says what.
- A popup may ask whether **codesign** can use a key in your keychain — click **Always Allow** (type your Mac password).
- Safe to run again at any time. If your internet drops halfway, just run it again — it continues where it stopped.
- It also builds **jarvis-reader**, the small model that reads every request — the first time, it downloads a 1.6 GB base
  model and takes a few minutes (the reader's files are written by `finetune/reader_gguf.py`, byte-identical to the live
  model, so no old Ollama is needed). It pulls the chat model's base (Bonsai 4B) and the Think-hard model (Bonsai 8B) too.

### 4️⃣ Give macOS permission (≈5 minutes) — the part no script is allowed to do

Open ** → System Settings → Privacy & Security**, then for each item below click it, switch the app **on**, and if it is not
in the list, click **+**, press **⌘ Shift G**, paste the path shown, and click **Open**:

| Setting | Turn on | Path if you need to add it | What breaks without it |
|---|---|---|---|
| **Accessibility** | JarvisControl | `~/JARVIS MK-1/jarvis-control/JarvisControl.app` | JARVIS "clicks" but nothing happens |
| **Microphone** | ClapListener, JARVIS OS | `~/JARVIS MK-1/clap-daemon/ClapListener.app` | "Hey Jarvis" and claps do nothing |
| **Screen & System Audio Recording** (called **Screen Recording** on macOS 14) | JARVIS OS, node | `~/JARVIS MK-1/jarvis-os/JARVIS OS.app` | "what's on my screen" fails |
| **Notifications** (separate page in System Settings) | FocusGuard | — | Focus Guard cannot tell you it acted |

The first time JARVIS controls Brave, Notes, Messages or Contacts, macOS asks *"node wants to control …"* — click **OK**
each time (that is the **Automation** permission).

### 5️⃣ One switch in Brave (≈1 minute)

Open **Brave**. In the menu bar at the top of the screen: **View → Developer → Allow JavaScript from Apple Events** — click it
so it has a tick. Without it, JARVIS can open pages but cannot read or press anything on them. While Brave is open, sign in
to the sites you want JARVIS to use for you (YouTube, the Spotify web player, Gmail…).

### 6️⃣ (Optional) Two shortcuts for Focus Guard (≈2 minutes)

Focus Guard switches Do Not Disturb on when you clap. Open the **Shortcuts** app → **+** → search the actions for
**Set Focus** → set it to **Do Not Disturb**, **On** → name the shortcut exactly `AIC DND On`. Make a second one set to
**Off**, named exactly `AIC DND Off`. Skip this if you do not want it.

### 7️⃣ Check everything (≈1 minute)

```bash
./install.sh --check
```

Everything should be green. It changes nothing — it only looks. Anything red tells you which step above to redo.

### 8️⃣ Meet JARVIS (≈2 minutes)

1. Open **http://localhost:8787** in Brave (or double-click `JARVIS OS.app` in `~/JARVIS MK-1/jarvis-os/`).
2. Go to **Settings**. A fresh JARVIS shows a welcome note, because it knows nothing about you yet — it will not call
   you by anyone else's name. Fill in **Your name**, **How to address you** (Sir, Ma'am, Boss, your name, or none) and
   **Pronouns**. Under **Where you are**, leave the fields blank to use your Mac's own country, time zone and °C/°F.
   Everything saves the moment you change it.
3. Type **hi** in the chat box. With a microphone, say **"Hey Jarvis"** (or clap twice) and speak.
4. Tell it about yourself in plain sentences whenever you like — *"my sister is called Anna"*, *"I live in Berlin"* —
   and it remembers.

### 9️⃣ (Optional) Extras

- **Names it mishears when you speak** (friends, your town, shops): add them to `~/JARVIS MK-1/config/vocabulary.json`
  (one per line in the list) — picked up the next time the microphone opens.
- **Cloud keys** (a bigger online model via OpenRouter, Gmail/Calendar via Composio): put them in `~/JARVIS MK-1/.env`.
  JARVIS runs fully offline without them.
- **Less memory on an 8 GB Mac:** the reasoning model (`phi4-mini`) is the heaviest thing JARVIS loads. To skip it, empty the
  `JARVIS_REASONING_MODEL=` line in `.env`.
- **Use it from your phone:** see [jarvis-os/PHONE_ACCESS.md](jarvis-os/PHONE_ACCESS.md).

### 🆘 If something is wrong

| What you see | What to do |
|---|---|
| `localhost:8787` does not open | Wait a minute after installing, then run `launchctl kickstart -k gui/$(id -u)/com.atharv.jarvisos`. The log is `~/JARVIS MK-1/logs/com.atharv.jarvisos.log`. |
| JARVIS says it clicked, but nothing moved | Step 4 → Accessibility → JarvisControl. |
| Web searches or YouTube fail with "Allow JavaScript from Apple Events" | Step 5. |
| "Hey Jarvis" / claps do nothing | Step 4 → Microphone → ClapListener. On a Mac mini/Studio/Pro, plug in a microphone — it starts on its own. |
| Answers are very slow or the Mac feels frozen | Close heavy apps; on 8 GB see "Less memory" in step 9. The first answer after starting is always the slowest. |
| Anything else | Run `./install.sh` again — it is safe, and it repairs what is missing. |

**To remove JARVIS completely:** stop its background agents, then delete the folder (and, if you like, the models):
```bash
for p in ~/Library/LaunchAgents/com.atharv.*.plist; do launchctl bootout gui/$(id -u) "$p"; rm "$p"; done
```
Then drag `~/JARVIS MK-1` to the Bin, and remove the models with `ollama list` / `ollama rm <name>`.
Full technical detail, including what is deliberately not in this repo: **[RESTORE.md](RESTORE.md)**.

`install.sh` pulls the Ollama models, **builds** the reader model from the adapter the vault restores (no registry has
it), fetches the two neural extras that live outside the repo (the piper voice, and the onnxruntime the wake word links
against), builds the Swift apps, **generates** the seven launchd agents from wherever you cloned to, and re-baselines
integrity. What it cannot do — and prints as a checklist
rather than skipping quietly — is macOS TCC permissions, because those are granted by a human clicking
a checkbox and no script may do it. Each of them fails *silently but plausibly* when missing: without
Accessibility, screen-control clicks return `ok:true` and nothing moves.

---

## 🗺️ What is where

| | |
|---|---|
| `jarvis-os/` | the assistant: server, agent loop, browser control, memory, world monitor, UI — the modules sit at the top, `public/` is the UI, `state/` what it has learned, `app/` the native window |
| `jarvis-os/tests/` | the 53 test suites plus `test_install` and `test_eval` — `node tests/run_all.js` runs the 53 |
| `jarvis-os/sweeps/` | measurement scripts: each re-measures a threshold or an accuracy table that a module's comments cite |
| `jarvis-control/` | native screen control — enumerates real macOS controls and presses one **by number**, never by coordinates off a screenshot |
| `clap-daemon/` | wake word and clap detection, on-device, audio never leaves the Mac — and the wake word **cannot transcribe**: it is a neural detector that only reports how much a sound resembled "hey jarvis" |
| `focus-guard/` | gesture-armed Do Not Disturb |
| `Jarvis Search/` | ⌘9 search overlay — `Jarvis Search.app` is the live app, `src/` the real source |
| `outputs/` | where `Jarvis Search/src/build.sh` writes a new build, before it is copied over the live app |
| `finetune/` | where the reader model is trained, measured and exported — scripts only; my data, the weights and the venv stay out of git |
| `security/` | integrity baseline, canary, self-healing supervisor |
| `tools/` | `vault.sh` encrypts/decrypts the private set (`pack`, `unpack`, `list`, `verify`); `bak.sh FILE WHAT` copies a file into `backups/` before an edit |
| `config/` | the site registry (`sites.json`), MCP servers, vocabulary, ordering |
| `library/` | my books, for the tutor and the library questions |
| `apps/` | small apps JARVIS built for me with its `make_app` tool (`system_control.js`) |
| `JARVIS Outputs/` | JARVIS's output folder — `server.js` creates it at startup, and the file view opens files from it |
| `logs/` | `actions.log`: one line per system-control action (JARVIS's own log is `jarvis-os/logs/`) |
| `private/` | `vault.enc`, the encrypted vault |
| `backups/` | not in git: every pre-edit copy, plus retired components — see `backups/README.md` |
| `JARVIS OS.dc.html` | the original design the UI was ported from, kept as it was |

---

## 🔬 Verifying it works

**Do not trust a summary — inspect the machine.** 🔎

> **3,170 assertions across 53 suites** (2026-10-22; `test_install` adds 48 more and was last run
> before 2026-09-19), and most of them need `ollama` running because they ask the embedders and the reader
> real questions — a stub would only ever test the stub. Suites that cannot reach the embedder **skip
> themselves rather than pass** — `tests/run_all.js` reports those as SKIPPED and the run as not green.
> It also unloads each suite's models as soon as that suite ends, so a test run does not leave gigabytes
> resident on an 8 GB machine.
> `test_parse` is also the reader model's end-to-end check: it reads its sentences through
> `jarvis-reader`, so on a machine without that model it stops at the first reading it cannot get and
> exits 1 — checked by pointing it at a model name that does not exist.

```bash
./install.sh --check                    # prerequisites, models (the reader too), agents, baseline
cd jarvis-os
node tests/run_all.js                   # all 53 suites, one table (--install adds test_install)
node tests/test_parse.js                # 1052 needs ollama + jarvis-reader — the parser end to end
                                        #      (and prints 14 KNOWN GAPS it declines, and 9 it asks about)
node tests/test_readmodel.js            # 160  the reader's checker, fed readings by hand — no model
node tests/test_store.js                # 46   durable state + credential scrubbing
node tests/test_stress.js               # 305
node tests/test_reflective.js           # 555
node tests/test_context.js              # 35   the resolver is extractive, not a pronoun list
node tests/test_modelprofile.js         # 105
node tests/test_verblex.js              # 23   my answers about a phrase, kept per pair — no model
node tests/test_errand.js               # 34   what a request names: the contract, no word lists
node tests/test_ainews.js               # 83   the week in AI: Sundays only, whole-week reads, the summary check — no network, no model
node tests/test_dreamintent.js          # 12   needs ollama — is this dream mode, and which part (it replaced DREAM_RE)
node tests/test_proactiveintent.js      #  6   needs ollama — JARVIS's nudges (it replaced PROACTIVE_RE)
node tests/test_panels.js               #  5   needs the reader — its own panels, open/close (replaced app.js's lists)
node tests/test_centroids.js            # 8    needs ollama — the cached regions are the ones built
node tests/test_itemclass.js            # 19   needs ollama — it asks the embedder real questions
node tests/test_intent.js               # 85   needs ollama — which procedure / which command shape
node tests/test_clauses.js              # 14   "and"/"then": one errand, two errands, or too many
node tests/test_lang.js                 # 17   needs ollama — Hinglish detection + model routing
node tests/test_webintent.js            # 22   needs ollama — does answering this need the web?
node tests/test_calintent.js            # 25   needs ollama — is this my calendar?
node tests/test_replyhedge.js           # 21   needs ollama — did the reply ANSWER, or defer?
node tests/test_selffact.js             # 23   needs ollama — what gets remembered, and what answers
node tests/test_sitekind.js             # 43   needs ollama — what errand a website serves
node tests/test_actionintent.js         #  1   needs ollama — reports whether the swap is viable yet
node tests/test_playnear.js             #  8   which Spotify card a play presses — fake page, no browser
node tests/test_grounded.js             # 24   the Wikipedia lane's contract and its answer check
node tests/test_attention.js            # 11   what a chat reply is told needs me
node tests/test_explain.js              # 17   "why did you do that?" from the turn's own log
node tests/test_reasonintent.js         # 17   the reasoning gate
node tests/test_whyintent.js            #  2   is this a "why" question
node tests/test_businessfinder.js       # 17
node tests/test_agentreach.js           # 11
node tests/test_websession.js           # 44
node tests/test_snapshot.js             # 16
node tests/test_parquet.js              #  7
node tests/test_mcp_connect.js          # 19   Settings → Connections: MCP by link
node tests/test_mcp_http.js             # 16
node tests/test_envfile.js              # 17   the one writer of .env
node tests/test_controlreq.js           #  3
node tests/test_install.js              # 48   needs ollama + network — install/uninstall resolution
node tests/test_eval.js                 # 46 real tasks, judged by inspecting the machine — drives real apps
cd .. && ./security/verify.sh && node security/canary.js   # integrity baseline, then 6 live providers
```

After editing any source file, run `./security/integrity.sh` before `verify.sh`, or verify will
report your own edit as tampering — which is exactly what it exists to do.

`./tools/vault.sh verify` proves the backup actually restores what is on this machine — it diffs every
item against disk. `list` only proves the passphrase decrypts *something*, which is not the same thing.

---

## 🧭 Two habits this codebase is built around

**1️⃣ Verify by inspecting the machine, never by reading the reply.** A pressed button is not a playing
track; an element list containing "Pause" only proves *something* is playing, not the right thing. Most
of the hard bugs here survived for a while behind a check that was real but measured the wrong thing.

**2️⃣ A check that cannot fail is not a check.** Every guard added here was run against the exact input
that used to break, and shown to fail on the old code first.

The comments throughout are longer than usual on purpose: most record a specific failure and why the
obvious fix was wrong. They are the reason a bug fixed once stays fixed.

---

## 🎯 A 0.8B model, trained on my own messages, reads every request

The parser that turned a sentence into an action was a stack of regexes with a 3B normaliser in front,
and it failed both ways: the lists missed phrasings nobody wrote down, and the 3B rewrote requests into
things I never said. On 2026-09-16 "Create a new folder and label it as JARVIS MK two" went to the
agent loop, ran for 76 seconds, made a folder somewhere I never named, and reported "1 of 3 done".

`jarvis-reader` replaced both. It is Qwen3.5-0.8B with a LoRA adapter trained on my own hand-labelled
messages, plus synthetic batches for the shapes I rarely use (`finetune/`). It reads one message into
one reading — `{"act":"create_folder","name":"JARVIS MK two"}` — and `jarvis-os/readmodel.js` keeps that
reading only if it survives a checker that trusts nothing the model says:

- every value must be copied from my words, and every app, site, folder and browser must resolve in a
  registry the system owns
- a file, path, URL or number I typed that the reading ignores gets the reading refused (0 false
  refusals on 923 labels)
- below 0.75 confidence it asks — "Should I …? Say "yes"" — and remembers my answer for that sentence;
  below 0.3 it does nothing
- open/close and create/delete are the pairs a model can flip, so its own probability for the other half
  must sit 0.5 below its choice, and my answers (`verblex.js`) can turn a reading round
- a folder I name always wins; the answer to "where should it go?" applies once, and only my "always"
  makes it the default

**Live since 2026-10-13: round 5, with the veto on.** On the six held-out files it never trained on: 372
exact, 4 missed, 8 refused, 28 wrong (round 4: 360 / 4 / 17 / 31). Through the whole pipeline on a
casual-slang stress set it had never seen (v3, judged once, in a sandbox that cannot act): 226 of 325
(69.5%; Hinglish 50%) and 1 wrong action — my bar is 98%. The veto: when the reader is sure (0.75 or more)
that a message is nothing to do, the procedure, agent, act-instead and dream lanes stay closed, so chat is
not turned into an action. Round 2 is kept as `jarvis-reader-r2` to roll back. The numbers below are from
September, an earlier round.

**Measured on all 1,475 of my messages**, the reading and the hand label both put through the same
checker, so the comparison is action against action (`jarvis-os/sweeps/sweep_his.js`):

    exam       218, never trained on     197 exact    21 missed    0 wrong
    held-out   118, never trained on     117 exact     1 missed    0 wrong
    trained    1,139                   1,075 exact    51 missed    2 wrong    (+11 where both ask)

Before the gates, the raw model got 203 of the 218 exam messages exactly right and 1 wrong
(`finetune/eval_ollama.js`); the gates take the wrong one to zero. **It is not 100% yet.** The exam
misses are pronoun references ("search him up on brave" — the conversation resolver handles those live,
with the 3B), questions about the machine ("how many apps are running"), "open X and play Y" read as one
sentence (the clause splitter handles those live), and a few plain requests it was not sure of. A miss
asks or does nothing; it does not act. The two wrong ones are in the trained set: "run status check"
and "find scholarly papers on perovskite solar cells", both labelled as not a command.

Cost: 1.1 GB resident, ~0.46 s per read warm, 3.1 s to load cold. The pre-warm reads the whole sentence
first and then only the pieces the clause splitter asks about: median 0.47 s per turn, p90 2.2 s
(`sweeps/sweep_latency.js`). **No registry has this model** — `install.sh` builds it from the adapter the vault
restores. Without it JARVIS still runs, but only open / close / system requests parse (`actread.js`).

**Training never touches the machine while I am using it.** Every heavy step runs under
`finetune/guard.py`, which stops it on low free memory, swap growth, a thermal warning, a time budget or
a low battery. Validation sets are fixed (`build_dataset.py --hold`) since a resumed run turned out to be
validating on 88 of 138 rows it had trained on. `export_reader.sh` fuses the adapter into the original
weights, and `to_hf_layout.py` puts them back into the layout the checkpoint was published in, because
Ollama cannot load mlx_lm's own ("tensor 'token_embd.weight' not found").

---

## 🧠 Routing is asked, not looked up

**🪤 A keyword trap is a list of the words a person might use, and it fails on the one nobody wrote
down.** It fails silently, which is the worst part: nothing in the log says "that request matched no
pattern". Several of these were removed by asking an embedder what a request MEANS instead.

`RESEARCH_RE` decided whether to consult the web by listing research verbs — *research, look into,
read up on, dig into, investigate*. "who is the CEO of BlackRock" contains none of them, so the web
lane was unreachable and a 3B answered from memory: "Christopher A. Flowers" one day, "Christopher A.
Garthwaite" the next. It is Larry Fink, and `doResearch` returns exactly that with three citations in
about twenty seconds. `webintent.js` asks whether the answer lives on the web; the same went for
`CAL_LIST_RE`/`FREE_SLOT_RE` (`calintent.js`, which also understands "am i busy today" and "kal koi
meeting hai kya"), `APP_SEARCH_RE`, and `LEADIN_RE`, which listed conversational openers and is now a
question of POSITION rather than vocabulary — so "right, what is the weather" works without "right"
appearing anywhere in the code.

**🎯 Two things a region has to get right, both learned the hard way and both measurable.** A catch-all
"everything else" region is not a region: averaging forty unrelated sentences gives a centroid that
means nothing in particular and pulls weakly on everything near it, so an order in Hindi drifted into
the lookup region by a wider margin than a real lookup won by. Splitting it into regions that each
mean ONE thing fixed it. And a region taught only one language drags every sentence in the other
toward whichever region does have it — Hindi concentrated in `calendar` made "sundar pichai kaun hai"
a diary question. The repair in both directions is proportion, never the failing sentence; patching
individual test cases is fitting the test set and makes every number a lie.

**💾 My memory was two keyword traps in a row, and they cancelled each other out.** Storing required a
sentence BEGINNING with "my" and joined by "is" or "are" — `/^(?:jarvis[,\s]+)?(my\s+…\s+(?:is|are)\s+…)$/`
— so "i hate summer and enjoy winters" was acknowledged warmly by the 3B and stored nowhere. Nor
would "i am allergic to peanuts", "i live in ludhiana", "call me atharv"; the frame AND the verb are
both open classes. Retrieval was worse: one token of four characters or more found anywhere inside a
fact claimed the turn, so "do i hate summer" came back with "Atharv hates being woken up early, hates
phone calls, and hates people being late" — a question about summer answered with a fact about
mornings, on the letters "hate" inside "hates". Lengthening the stop list cannot fix that; the word
that matched was the word the question was about.

`selffact.js` decides what is worth keeping (durable / transient / neither, with abstention) and
`factmatch.js` decides which stored fact ANSWERS a question. Getting the second to zero errors took
two stages, and the first attempt is instructive:

    cosine floor alone              15/16, 0 wrong, 1 missed
    3B asked yes/no per fact         6/16, 0 wrong, 10 missed   <- rejected
    3B asked to pick from a list    15/16, 0 wrong, 1 missed
    floor + selection in the band   16/16, 0 wrong, 0 missed

The yes/no pass answered NO to all sixteen, including "do i prefer tea or coffee" against "Atharv
prefers tea over coffee". Handed the same sixteen as a NUMBERED LIST with a "none of them" option it
refused all six adversarial pairs and found the rest. A 3B chooses from a list reliably and judges a
proposition badly — the same finding `playbook.js` records about procedures. Each stage is used only
where it was measured to be right: above 0.60 the cosine produced nothing wrong so no model is woken,
and between 0.45 and 0.60 it produced six wrong, all of which the selection pass rejected.

And a question is never stored as a fact — but that is not an embedding problem. A statement and the
question about it are nearly the same sentence (0.002 apart), so `isQuestion()` decides it from
wh-words and auxiliaries and is INJECTED, exactly as `WH_RE` is into `verblex`.

**🧬 The embedder itself was the other half of the problem, and it was swapped on measurement.**
`all-minilm` is 22M parameters, 384 dimensions and a 256-token window, and it was the weakest link in
every classifier here. Six candidates were pulled one at a time and scored on 81 held-out routing
goals, each with its own threshold swept — a threshold is a property of the embedding SPACE, not of
the task, and nomic's margins run about half as wide, so every gate in the system was re-swept:

    all-minilm        68/81 correct, 7 WRONG        384d   9.6ms   28 MB
    granite-278m      72/81, 1 wrong                768d  18.3ms  562 MB
    nomic-embed-text  74/81 correct, 0 WRONG        768d  18.2ms  249 MB   <- now the default

Nothing was superior in EVERY way — all-minilm is still the smallest and fastest, and this costs 2x
per embed. What it buys is seven wrong actions going to zero. Six readers pin all-minilm, also on
measurement, and each says why at the call site: `itemclass` reads bare item words rather than
sentences (21/22 against nomic's 19/22, and "bedsheet" stops abstaining); `replyhedge` reads JARVIS'S
OWN REPLY back to check it is not leaking — under nomic the hedge guard stops firing entirely
(`replyclaim`, the other reply guard, is a TRAINED reader over nomic since 2026-09-24: regions caught
32/127 false "I did it" replies and flagged 36/135 right answers; the trained reader 108/127 and 11/135); `calintent` kept it through the migration ("kal koi meeting hai kya" is
a calendar question under all-minilm and not under nomic); and the two newest, `errand` and `actread`,
read short spans and single words. nomic is better at reading a REQUEST and worse at reading a REPLY
or a fragment — which is why `install.sh` pulls both.

Its task prefixes (`classification:`, `clustering:`) were measured too and all four were WORSE: the
same prefix on both sides lifts every cosine together, the median winning similarity goes 0.698 →
0.832, the usable threshold collapses to 0.005, and abstention stops separating anything.

**➖ Embeddings cannot do negation, and neither can a word list.** Measured, and this is the limit
rather than a tuning problem: the embedder ranks "fire up the calculator" nearer `close_app` (0.382)
than `open_app` (0.367), and "knock up a file" nearer `delete` than `create`. Every group in the old
`config/verbs.json` was half of an antonym pair, and it was deleted as a keyword trap. What replaced it
kept a SEED of those pairs for a 3B to extend — and the seed was the same trap in a smaller box: "spin
up" was seeded as opening an app, and "spin up a folder" is not one. The seed and the 3B learner were
destroyed on 2026-09-17.

Direction now comes from the reader model itself (next section): the probability it gave its own act
against the best act from the other half of the pair — open against close, create against delete —
and it must win by 0.5. `verblex.js` holds only MY answers, kept per pair (app, file) and keyed by
the words of my request that are not the thing being acted on. My answer beats the model: if I have
said a phrase means close, a reading of open is turned round. When the model is unsure about closing
or deleting, the action asks before it runs.

**And a reply that defers is a routing signal.** The web gate is deliberately conservative, because a
false fire sends a private question to a search engine. What it misses is caught at the other end:
`replyhedge.js` notices the model announcing its own doubt — "I would recommend checking the official
website" — and only then looks it up. A gap about the WORLD is worth a search; "I have no note of
that conversation" is the store answering correctly and must never reach the web, which is why those
are separate regions.

---

**🇮🇳 Hinglish goes to a model that can read it, and the detector names no Hindi.** all-minilm is an
English model, and on my romanized Hinglish it did not merely lose accuracy — it leaked. Measured on
sixteen of my own phrasings: *mere bhai ka naam kya hai* (what is my brother's name), *mujhe kal kya
karna hai*, and *mere contacts dikhao* were all routed to a search engine. `granite-embedding:278m`
reads those correctly and leaks nothing: swept across every threshold, not one local Hinglish sentence
ever won a web region — highest wrong margin 0.000 against 0.040.

It is not a global replacement, though, and that is the interesting part: granite is 2.5× slower, 6.5×
more resident, and compresses every margin, so a gate tuned for all-minilm stops firing under it
(calintent's correct cases clear by 0.004 instead of 0.054). So each sentence goes to the model that
is good at it, and the two spaces are never compared — a Hinglish sentence is scored against centroids
granite built, an English one against all-minilm's, from the same exemplars. Multilingual routing is
opt-in per classifier, because a caller without a second swept threshold must not be handed a second
model.

The detector itself never lists a Hindi word, which would be the same trap in a new language. It asks
how much of the sentence is ENGLISH, against the 236k-word dictionary macOS ships, with names removed
by the registries the system already owns — the site registry knows spotify, the app index knows
Notes, Contacts knows Parth. A first version spotted names by LENGTH and was measured and failed,
because my names are short: "open spotify", "open notes", "message parth" and "call mama" all read
as Hinglish. The dictionary alone still cannot see Hindi that collides with English words — *safari
band karo* is three English words — so a second signal embeds whole sentences as language regions.
Measured on 36 held-out phrasings: dictionary 32/36, regions 35/36, the two together 36/36.

---

## 📦 Installing and removing software

`install_app` and `uninstall_app` resolve WHERE something comes from by asking registries, never by
assuming. The first version hardcoded the App Store and could not report the one thing that was true
of the request that prompted it: Among Us is on neither the Mac App Store nor Homebrew, so it was
never going to succeed there however well the buttons were pressed.

    among us         appstore=-                    brew=-                  -> refuses, says where it looked
    telegram         appstore=Telegram [Free]      brew=telegram (cask)
    rectangle        appstore=-                    brew=rectangle (cask)

**Identity is scored, not prefix-tested, and that is not decoration.** `install istapaper` installed
TASKPAPER: `brew search istapaper` returns taskpaper because brew matches fuzzily, the iTunes search
returned the correct Instapaper and a `startsWith` test discarded it, and a model handed a one-item
list with no right answer in it picked the item. A model given a list with no correct answer will
choose something — the list is the bug, not the choice. Candidates are now scored by spelling
(edit distance, which tolerates a typo) or prefix, whichever is stronger, with a floor at 0.80:

    istapaper  vs taskpaper     0.556   rejected
    instapaper vs instaloader   0.727   rejected
    istapaper  vs Instapaper    0.900   accepted, and ASKS first because it is not what I typed

Inside the store, the control to press is found by ROLE first (a Button — AppKit's vocabulary, 37
elements down to 24) and then by MEANING over the surviving labels, with abstention. A results page
gives every app its own byte-identical "Get", so the button is matched to its ROW by document order —
ranking by label alone is a one-in-four chance of installing a competitor's app. And a press is not
an install: it waits for the app to appear in `/Applications` and says what is true at the end. A Mac
App Store install needs Touch ID, which is not in the store's accessibility tree at all, so that is
reported as the requirement it is rather than guessed at.

`uninstall_app` mirrors it and is more cautious: Homebrew where the package came from there (which
also clears the Caskroom — dragging an app out of `/Applications` by hand leaves the cask registered
and half-removed), otherwise the **Trash**, never `rm`. It always asks first, even on an exact match,
refuses anything under `/System`, and refuses to uninstall JARVIS. The name is extracted POSITIVELY —
every contiguous span of the sentence offered to what is actually installed, longest first — so "get
rid of discord" and "remove slack from my mac" resolve without stripping scaffolding. An earlier
version deleted a leading verb phrase and a trailing locative and shipped the remainder, which is the
same subtractive mistake the search-query lane had already been fixed for.

---

## ✨ Extras

Currently it features a "teach-mode" that allows it to learn new skills, and then generalize them for future requests, it works by asking the user about something it doesn't know that its prompted to do. It will say two options: Teach me OR Let me learn on my own **(Note: use learn on my own usually when using a stronger qwen model, default is the qwen2.5:3b-instruct-q4_K_M for text and logic and qwen3-vl:2b for vision input)**

**💾 Memory retrieves twice, lexically and semantically.** Episodes were ranked by tf-idf alone. They are now also embedded
(`nomic-embed-text`, 768 dims — it was `all-minilm` at 384 until the embedder swap, and the stored vectors were rebuilt
because a cosine between two embedding spaces is a meaningless number that looks like a score) and the two rankings are fused, which is worth stating carefully because embeddings ALONE were not an
upgrade: over 140 known-item queries on the real 1,476-episode store (1,696 today), tf-idf scored 21%/49% at recall@1/@5, embeddings scored
26%/49% — a tie at @5 — and the two together scored 28%/59%. The gain is entirely in their disagreement; each finds questions
the other misses. Cost is 4.7 MB of floats in one array (1,696 episodes × 768 × 4), the same `nomic-embed-text` routing already
keeps loaded, and a 55-second index rebuild. It runs only on the explicit "what did I decide about X" path, never on the per-turn passive lane.

Crucially it can still say **no**. Vector search always returns a nearest neighbour — it cannot abstain — and a cosine floor
does not fix that: nonsense queries peaked at 0.396 while the weakest real query scored 0.306, so the two overlap and no
threshold separates them. The semantic half therefore only ever *reorders* what tf-idf already admitted. Nothing lexical still
means "nothing in our history matches that, Sir".

**🛒 One sentence can name two shops, and each item is classified rather than matched.** The router used to score a whole
request once and pick a single winner, so "order apples from Instamart and cake from Swiggy" came back as one food order with
the apples silently gone. Two causes: English elides the verb after the conjunction, so the second clause had none and the
clause splitter refused it; and the vocabulary was three hand-written regex lists that disagreed — samosa was in two of them
and not the one that decides, gulab jamun in none, so a sweet routed to Amazon. The verb is now supplied from the head of the
sentence and the rewrite kept only if the clause independently resolves, so the safety rule is unchanged. A trailing shop still
distributes over the whole list: "apples and bananas from Instamart" stays one basket, and a split needs two shops or two kinds.

Items are classified by embedding (`itemclass.js`, `all-minilm`, ~6 ms warm, cached so a word is embedded once in its life)
instead of matched against a list, so *anjeer* and *rasmalai* are placed rather than missed. It runs **only** where the
deterministic scorer already found nothing, so an understood sentence costs what it always did. It answers grocery-vs-product
and nothing finer, and it may **abstain**: 94.9% on 47 items, 92.9% on 28 held out, and 100% of what it accepts once it is
allowed to say it cannot tell. Restaurant-vs-grocery is deliberately not asked of it — measured on three models
(`all-minilm`, `granite-embedding:30m`, `snowflake-arctic-embed:33m`), all three failed on the same boundary, because paneer
from Instamart is a grocery and paneer tikka from Swiggy is a meal. The distinction is not in the word, so it comes from the
provider or from a question. Two shops means two carts, said before they open, and each still shows its draft before anything
leaves.

**🧮 A reasoning question goes to a model that shows its working.** `qwen2.5:3b` scores 5/15 on arithmetic, time and unit
problems where `phi4-mini` scores 11/15, so those route to phi — and the brevity rule is suspended for that turn only, because
phi's advantage *is* the working and forbidding it buys a slower wrong answer. Only one model is resident at a time; the
eviction is symmetric, since evicting only on the way to phi left it lingering and made the next ordinary turn 31.9 s.
A plain sum ("whats 2 plus 2") never reaches phi — the exact calculator answers it first. Measured 2026-09-24: Bonsai 4B
(1-bit, 0.6 GB) could not replace phi — fast and light, but confidently wrong ("2 to the power 10 is 1,024,000,000,000").

**🌙 Visual-silent mode: the answer in text, midnight to eight.** Of fifty features surveyed from other assistants this was the
only one that measurably cuts memory here — silence means `piper_daemon.py` never loads, measured at 120 MB `phys_footprint`
(184 MB peak) on a machine that idles at 60–70 MB free. Verified in both directions, because "piper did not load" proves
nothing if piper never loads: with the window open a warm call starts it, with the window closed the same call leaves no
process. The refusal that matters is the *warm* one — declining only at synthesis time would pay the whole cost and save
nothing. A silenced request answers `200 {silent:true}`, deliberately not the `503 fallback:'browser'` used for a broken
voice, because the page answers a 503 by speaking the line in the browser's own voice, which at 3am is the exact opposite of
what was asked. `POST /api/silent {mode:'on'|'off'|'auto'}` — `off` gets you spoken answers at 2am when you are working late,
and overrides expire so one night's decision does not quietly govern next month.

**🎙️ The recogniser is told the words it cannot know.** Speech recognition has a general English lexicon and no idea who Parth
is, that AdMax is a company, or that Swiggy and Instamart are different services — which are exactly the words carrying the
meaning, so mangling one loses the sentence, silently, because a confident wrong transcript looks like a correct one.
`config/vocabulary.json` is read on every microphone open and passed as `contextualStrings`: no model, no measurable time,
nothing resident. Data rather than code on purpose — adding a name is an edit, not a rebuild — and any problem with the file
returns an empty list, so a stray comma costs the bias and never costs you the microphone.

**🔊 The voice is local and neural.** Spoken replies are synthesised on this Mac by piper (`en_GB-semaine`, speaker 2) and served
as audio from the server rather than spoken by the browser — the browser can only reach the voices macOS ships, and serving
audio means voice still works from a phone over the tailnet. It speaks the answer *as it is written*: the first finished clause
goes to the synthesiser while the model is still generating the rest, because on this machine generation is the whole wait.
The browser's own voice stays as the fallback, so losing piper costs quality and never costs you the reply.
Knobs live in `.env` — `JARVIS_TTS_MODEL`, `JARVIS_TTS_SPEAKER`, `JARVIS_TTS_LENGTH_SCALE` (higher is slower).

**👂 "Hey jarvis" is a neural wake word, not speech-to-text.** It used to be Apple's recogniser, which held a ~112 MB system
speech service permanently and transcribed everything in the room to match one phrase. It is now openWakeWord's pretrained
model on onnxruntime, running inside the clap daemon that already owns the microphone — one process, ~38 MB of graphs, and
it is structurally incapable of transcribing anything. `JARVIS_WAKE_THRESHOLD` tunes sensitivity; `JARVIS_WAKE=0` turns it off.

The threshold is **0.5**, the model's own default, and it got there the hard way. Swept through the real detector at gains
from 1.0 down to 0.10, the score moves by about 0.02 — this model is level-invariant, so how loudly or how close you say it
barely matters — and six recordings of me scored 0.362 to 0.989 while ten synthesised non-wake phrases scored 0.000. At 0.5,
three of my six takes were rejected, so it was lowered to 0.3. The room then did what the note on that change warned it
might: seven false wakes in one day, so it went back to 0.5 on 2026-09-04. In the 29 hours after, one wake, scoring 0.970,
and no false accepts. Mid-sentence detection works either way: "hey jarvis is not what I said" scores 0.978.

**🔍 The "jarvis search" wake phrase is off by default.** It used to run its own always-on recogniser, which kept the
microphone open around the clock for a shortcut ⌘9 already provides. Set `jarvis.voice_wake: true` in `jarvis.yaml` to
have it back — read at launch, no rebuild. (The "jarvis settings" phrase and the panel it opened were removed.)

---

## 🗓️ Roadmap

Everything here is temporary for now — updates land on a near-daily basis.

**✅ Done**

- 🎛️ **Calibration** — JARVIS adjusting itself to whichever model it is given. **Done 2026-10-17:** Settings → Models →
  Calibrate measures a model on this Mac (speed, verbosity, cold start) and keeps its profile only on Keep; jarvis and
  Bonsai 8B were measured and kept 2026-10-19.
- 🍲 **MechanicalSoup rebuilt in JS** — stateful browsing (cookies, links, forms) without a browser. **Built 2026-10-01** as
  `jarvis-os/websession.js` (with `htmlparse.js`): cookies, redirects, referer, links and forms; a form is submitted only
  with my confirmation, and password / card / file fields, login and checkout pages and CAPTCHAs are refused in code;
  44 tests. Used today by the business finder; not yet a tool the agent can call on its own.
- 🌐 **Agent-Reach in JS** — one door per platform, each with a fallback and a health check. **Built 2026-10-01** as
  `jarvis-os/agentreach.js`: web, search, YouTube, RSS, GitHub, Hacker News and Wikipedia over plain HTTP; Reddit, X,
  Instagram and LinkedIn read through my own logged-in Brave (reading only, a login wall is reported, never typed through);
  `doctor` probes every door live; 11 tests. Only its search door is in use (the business finder) — wiring the other doors
  into chat and the agent is the open half.
- 🔗 **The reader's `refers` flag** (part of the reader item below) — live with round 5 since 2026-10-13: the 3B is asked
  what "it" means only when the reading says the sentence leans on something earlier, not on every turn.

**🚧 In progress**

1. 🎯 **The reader to 100% on my messages** — a retrain that teaches the shapes it misses (pronoun references, questions
   about the machine, "open X and play Y", plain searches) from new examples, never from the test sentences themselves.
   Checked against a fresh held-out set, because a model trained on its exam has no exam. **Where it is:** round 5 is live
   (2026-10-13, 69.5% on the casual set v3, bar 98%); round 6 (a `time` act) missed its bar and is parked on branch
   `time-act`; rounds 7 and 8 (2026-10-15, 10-17) read better than round 5 on fresh sets but lost lines against it in the
   regression gate, so round 5 stays live. Next: better labels (a bigger model as a second labeller) and a ship rule decided
   before the next result.
2. 🌳 **One trained 1-bit model for everything local** — PrismML's Bonsai 4B (Apache-2.0, 0.6 GB) distilled on JARVIS's own
   jobs — chat, resolving "it", agent steps, reasoning, and never claiming an action it did not take — judged on the
   held-out sets in `finetune/data`. Untrained, it lost to the 3B on the resolver and the agent; trained, it could replace
   the 3B and phi4-mini at a quarter of the RAM. **Where it is:** v1 (2026-09-26, three LoRA runs averaged on an exact 2-bit
   repack) was curt and over-confident, not deployed. **v4.2 is live since 2026-10-08** as `jarvis` — plain chat replies and
   the Wikipedia lane, served since 2026-10-13 by the pinned `runtime/llama-server` with the adapter loaded at runtime
   (`runtime/README.md`). v4.3 (greetings) missed its bar on Hinglish feelings and false claims, so nothing shipped. Still
   open: the 3B and phi4-mini do the helper and reasoning jobs, and the regression gate still catches chat replies that
   promise actions nothing performs.

**⏳ Not started**

3. 🧲 **Superdense in JS** — an outcome loop: one move per run, each with a hypothesis and a measured result, keeping what
   worked and retiring what did not. Top priority once the known bugs and the training are done.
4. 🧪 **Optional, to be tested:** OpenAgentsControl, hindsight, deepagents.

Everything stays zero-dependency JS.

| | |
|---|---|
| 🥇 **MK-1** | this version |
| 🥈 **MK-2** | ~4–6 months |
| 🥉 **MK-3** | a few years out — the aim is to compete with Claude Opus 4.8 / Opus 5 or stronger, as JARVIS improves and new breakthroughs land in AI/ML |
| 🐧 **Linux** | compatibility coming |


**NOTE:** THIS IS THE PUBLIC VERSION, MUCH WEAKER THAN THE PRIVATE VERSION
