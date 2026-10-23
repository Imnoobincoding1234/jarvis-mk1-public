# JARVIS OS (jarvis-os)

Working port of `JARVIS OS.dc.html` (the original design file is untouched).
Local web app at http://localhost:8787 — server binds to 127.0.0.1 only.

- **Chat** — 1:1 conversation with JARVIS. Goes through the LLM router: OpenRouter when `OPENROUTER_API_KEY` is set in `~/JARVIS MK-1/.env`, otherwise local models, which is the current setup — so chat works with no internet and no key. Plain chat replies come from `jarvis` (`JARVIS_CHAT_REPLY_MODEL`: Bonsai 4B 1-bit + my LoRA, on `runtime/llama-server`); rewrites, checks and routing use `JARVIS_LOCAL_MODEL`. Settings → Models lists every job and its model.
- **Voice** — mic button / orb click; speech-to-text in the browser (use Chrome); JARVIS answers in text. Say "schedule ..." to create automations. Spoken replies use a **local neural voice** (piper, `en_GB-semaine` speaker 2 — "obadiah") served as a WAV from `POST /api/speak`, not the browser's own voice: Web Speech can only reach the voices macOS ships, and the best male en-GB one is Daniel, a compact 2010 concatenative voice. Synthesis happens on the server so it also works from my phone over the tailnet, where macOS `say` would have played to an empty room. The model is held warm by `tts/piper_daemon.py` — **~1.5s cold, ~180ms warm**, unloading after 10 idle minutes so 73MB is not resident forever on an 8GB machine. Web Speech remains the automatic fallback: no piper, no python, or a line that fails to synthesise costs quality and never costs a reply. Voice is still strictly voice-in→voice-out; a typed message is never spoken. Knobs (all optional) in `.env` — see `.env.example`.
- **Vision** — MacBook camera + external webcam; snapshots go to JARVIS. Drop `Name.jpg` photos in `jarvis-os/faces/` for face matching (best-effort).
- **Automations** — `/schedule ...` in chat or "schedule ..." by voice; reminders fire as macOS + browser notifications.
- **Watchers** — condition-based, one-shot alerts distinct from time-based automations: `/watch ...` or natural phrases ("let me know when CPU goes above 90%", "keep an eye on Focus Guard going offline"). Built-in conditions (system-stat thresholds, fleet agent online/offline) are checked free every 20s; anything else falls back to an AI-evaluated check every 5 min (a real API call, so kept infrequent). Fires once, then deactivates. Shown alongside automations in the Automations view.
- **Files** — browse `~/JARVIS MK-1`; click to open, Reveal in Finder.
- **Briefing** — brief 3-line status answer. **Capture** — screenshot → JARVIS (needs Screen Recording permission for node on first use).
- **"What's on my screen?"** — ask in chat or voice ("what can you see on my screen", "look at my screen"). If multiple displays are connected, JARVIS asks which one first. In the native app (`JARVIS OS.app`), if JARVIS's own window happens to be on the screen you asked about, it auto-minimizes itself first, captures, then restores — unless you ask about "your UI"/"your screen" (JARVIS's own interface), which skips the hide. Native capture uses ScreenCaptureKit (needs Screen Recording permission for **"JARVIS OS"**, separate from node's); the browser fallback uses `screencapture -D <n>` via the backend.
- **System Log (⌘L)** — live console aggregating every fleet agent's log (Clap / Config / Dashboard / Focus / JARVIS OS) plus JARVIS OS's own activity. Per-source filters, text search, level color-coding, pause. Also via the ▤ LOG button (for browsers, where ⌘L is reserved).

## Running a different model

Every `llm()` budget in `server.js` — `max_tokens: 30` here, `timeoutMs: 20000` there — was
chosen by watching `qwen2.5:3b`. Pointed at a different model those numbers stop being
budgets and become a rigged test: `granite-3.1-3b-a800m` answers "capital of France" in 729
characters where the incumbent uses 31, so a 30-token call truncates it and the scorecard
blames the model. `modelprofile.js` scales those budgets for whatever is actually loaded.

Two independent axes, both ratios against the incumbent:

- **verbosity** — output tokens spent per unit of answer
- **speed** — wall clock per token, *on this machine* (so it is a property of the pair, never
  of the model alone)

`qwen2.5:3b` is **1.0 on both by definition**, so nothing moves while it is the local model —
`test_modelprofile.js` asserts that against every budget the codebase actually uses. A model
nobody has measured is treated *generously* rather than cautiously: over-budgeting costs some
latency, under-budgeting produces a truncated answer indistinguishable from incompetence.
No model is ever given a smaller budget than the incumbent.

Also handled per-model: the context window (never Ollama's silent 2048 default, never more
than the model supports), whether a JSON schema may be sent at all, and reasoning markers for
every family rather than only qwen's `<think>` — `<thinking>`, `<reasoning>`, `<reflection>`,
harmony's `<|channel|>analysis`, kimi's `◁think▷`, `<|begin_of_thought|>`. An unstripped
marker used to travel on as ordinary reply text, which is documented in `server.js` as having
tripped the hallucinated-action guard and turned a correct answer into "I could not carry
that out, Sir".

**Measure before you judge.** A guess is a guess; `calibrate.js` replaces it with numbers
taken on this machine:

```bash
node calibrate.js --list                  # what is installed, and how it is profiled
node calibrate.js                         # the active model's current profile
node calibrate.js <model>                 # measure it, write state/modelprofiles.json
node calibrate.js <model> --baseline      # also re-measure the incumbent, same machine, same hour
```

It **never pulls a model** — this is an 8 GB machine and two candidates resident at once has
frozen it. Pull, measure, `ollama rm`, then the next one. Calibrating the incumbent updates
the *reference* other models are compared against and leaves its own 1.0/1.0 alone, because a
ratio against itself is 1 by definition.

Switch models with `JARVIS_LOCAL_MODEL` in `~/JARVIS MK-1/.env`.

## The reflective layer

Five subsystems that read JARVIS's own state rather than the world's. None sits on the
critical path of a request — a failure in any of them cannot take a chat turn down.

- **Episodic memory** (`recall.js`) — every exchange is journalled to `state/episodes.json` and
  retrieved by the same tf-idf scoring the library uses, with a recency bias (45-day half-life,
  never decaying to zero). *"What did I decide about the Composio routing?"*, *"when did we do X"*.
  Unlike `/api/memory` facts it is **not** injected into the prompt — passages are pulled only when
  a question asks about the past, which is what lets it grow without cost. `forget about X` drops
  those episodes for good. If nothing matches it says so; it never invents a memory.
- **Knowledge graph** — the same episodes read sideways: people, apps, projects and books, linked
  by having appeared in the same episode. Rendered by the existing Palantir view — press ⌘⇧0, then
  **◧ MY GRAPH** to switch. Entities come only from things JARVIS knows are real (a contact it
  looked up, an app it opened), never from guessing at free text.
- **Time machine** (`timemachine.js`) — snapshots which apps are open and which is frontmost every
  5 minutes, rolling 48 hours. *"What was open at 3pm"*, *"put everything back to how it was"*.
  A restore **only reopens** — it never quits anything, because closing an app to "restore" a
  session could destroy unsaved work. Apps that were not open then are listed for you to close.
- **Tutor** (`tutor.js`) — spaced repetition (SM-2) over your own books. *"Teach me about X"* adds a
  topic, *"quiz me"* asks one question generated from a real passage and grades your answer against
  that same passage, so the feedback is sourced rather than improvised.
- **Initiative** (`proactive.js`) — the only part that speaks first. Watches calendar, parked
  approvals, battery, disk, long unbroken sessions and due study cards. Hard-capped at **3
  interruptions an hour**, silent 22:00–08:00, and holds fire entirely while you are away from the
  machine. *"Be quiet"* turns it off.
- **Dream mode** (`dream.js`) — runs only when idle 20+ min **and** on mains power: re-indexes the
  library if the books changed, distils the day into one episode, drafts tomorrow's study
  questions. Yields the instant you touch the keyboard. *"What did you do while I was away"*.
- **Plan preview** — *"show me what you'd do"* / *"dry run ..."* prints the steps and runs nothing.
  *"Go ahead"* executes **the exact plan that was shown**, never a re-planned one, and only within
  3 minutes. Exactly one preview is live at a time.
- **Learn by watching** (`observe.js`) — *"watch what I do"* notes which apps you bring to the front
  and which commands you give; *"call that morning setup"* saves it as a replayable macro.
  It does **not** record keystrokes: a CGEvent tap would be a keylogger, and replaying click
  coordinates breaks the moment a window moves.
- **Notification triage** — `/api/overview` collapses repeated notifications into one row with a
  count and ranks each high/normal/low. Pure string matching, no model — a notification you have to
  wait on a model to read is worse than the noise.

**What this layer cannot do:** read macOS system notifications or your Focus/Do-Not-Disturb state.
Both are TCC-protected (`~/Library/Group Containers/group.com.apple.usernoted` and
`~/Library/DoNotDisturb/DB`) and return *authorization denied* without Full Disk Access. Triage
therefore covers JARVIS's own notification stream, and presence is inferred from HID idle time
(`ioreg`, no permission needed) rather than Focus.

**Phone access** over Tailscale is opt-in and off by default — see `PHONE_ACCESS.md`.

The test suites live in `tests/`, the measurement scripts that re-derive the thresholds quoted in the
modules' comments in `sweeps/`. `node tests/run_all.js` runs the 53 suites in one table — a suite that
skips itself for want of a model is reported as SKIPPED, not passed, and each suite's models are unloaded
when it ends. It never runs `test_eval.js`.

Tests that need no model: `node tests/test_readmodel.js` (148 — the reader's checker, fed readings by hand) ·
`node tests/test_store.js` (46) · `node tests/test_stress.js` (290) · `node tests/test_reflective.js` (548) ·
`node tests/test_context.js` (35) · `node tests/test_modelprofile.js` (96) · `node tests/test_verblex.js` (23) ·
`node tests/test_errand.js` (34) · `node tests/test_ainews.js` (83 — the Sunday AI/ML week, against a fake
internet and fake models). None of them starts a server or fires a real action.

`node tests/test_parse.js` (1066) is the parser end to end and reads its sentences through the reader model,
so it needs ollama AND `jarvis-reader` — without the model it exits 1 at its first reading. It also
prints the phrasings the reader declines (KNOWN GAPS) and the ones it asks about, which are not failures.

The rest need ollama, because they ask the embedders real questions: `test_intent` (85),
`test_install` (48, network too), `test_sitekind` (43), `test_calintent` (25), `test_selffact` (23),
`test_webintent` (22), `test_itemclass` (19), `test_replyhedge` (21), `test_lang` (17),
`test_clauses` (14), `test_dreamintent` (12), `test_proactiveintent` (6), `test_panels` (5), `test_centroids` (8), `test_actionintent` (1). **3,170 assertions, 53 suites** (2026-10-22)
(2026-09-18, all passing; `test_install` was not re-run that day).

`node tests/test_eval.js` is different in kind: **46 end-to-end tasks that drive the real server and take
real actions on this Mac**, each judged by inspecting the machine (files on disk, the browser's URL,
Reminders) rather than by reading the reply. Run `node tests/test_eval.js --audit` first — it is a
structural self-check that catches tasks which could pass without JARVIS doing anything. The suite
cleans up after itself: the Desktop sandbox, the reminder `rem-add` creates, and the profile fact
`mem-remember` stores. Its traffic is marked `via:'eval'` so it never lands in the episodic diary.

Models: chat is whatever `JARVIS_CHAT_MODEL` names in `.env` — currently `qwen/qwen-2.5-7b-instruct`,
which is an **OpenRouter** model, and there is no `OPENROUTER_API_KEY` (I never had one; the empty line
was removed from `.env` on 2026-09-17). So in practice everything is local: plain chat replies come from `jarvis` (Bonsai 4B + my LoRA on `runtime/llama-server`,
since 2026-10-13); rewrites, checks and routing from `qwen2.5:3b-instruct-q4_K_M` (ctx 8192); reasoning from `phi4-mini`;
Think hard from Bonsai 8B; vision from `qwen3-vl:2b`. Settings → Models shows this map from the same getters the code uses.
Every request is read by `jarvis-reader` (`readmodel.js`), a fine-tuned 0.8B that `install.sh` builds from
the vault's adapter; the embedders are `nomic-embed-text`, `all-minilm` and, for Hinglish,
`granite-embedding:278m`. Since 2026-10-09 every model call goes through one memory gate
(`ollama.js` makeRoomFor): a heavy model is always alone, the light ones (jarvis, the reader, embedders) share within a budget. There is no
Anthropic path left — the document-skills feature that used it has been removed, so `ANTHROPIC_API_KEY`
is no longer read anywhere. Check what is actually loaded with `curl -s localhost:11434/api/ps`, not by
reading this line. Port: `JARVIS_OS_PORT`.

### Known open issues

1. **The agentic loop drops items from lists.** A 3B given "create three files … a.txt … b.txt …
   c.txt" wrote the first and third and skipped the middle one, failing 2 runs in 3 while replying
   "I checked all 4 of them". Multi-file creation now bypasses the loop entirely
   (`parseMultiFileCreate` + the lane above the procedural block in server.js), so `file-multi` and
   `file-multi-and` no longer measure this — **the underlying defect is unfixed and now unmeasured.**
   The same fault is expected wherever the loop iterates.
2. `safe-buy` drives a real Amazon session. It asserts the browser never reaches a checkout or
   order-placement URL; the actual protection is `BUY_LABEL_RE` in browser.js at four call sites.
   Both the 3B and the 4B press "Buy Now" every time in benchmarks — the model is expected to try
   and the guard is expected to stop it.
3. Second-monitor screen control is still blind: capture supports `-D`, the control loop and
   JarvisControl's coordinate space do not. Untestable without a second display.
4. ~~"play it cool" types "PlayItCool" into a search box~~ — **fixed 2026-08-25.** It and
   "call it a day" (which reached the 3B classifier and proposed quitting every app) both opened
   with a command verb, which was the whole basis for treating them as commands. `IDIOM_RE` +
   `IDIOM_SHAPE_RE` in server.js gate `looksLikeCommand`, so they route to chat. It is a curated
   list plus one structural shape, NOT understanding — the model is what produced both wrong
   answers. Missing an idiom costs a declined confirm; a false positive would break "close it",
   which is why pronouns with a real referent are explicitly tested.
5. `runSpecs` is wired but only three playbooks carry `run:` specs. Three agentic cases neither model
   passes: recognise-when-done, recover-after-rejected-click, refuse-to-buy.
6. Mama's face descriptor is 0.580 from mine — above the 0.5 threshold but the narrowest margin
   of any pair. Re-check if enrolments change.
7. Face recognition has never been tested against a live camera frame, only enrolled photos.
   Distances between people are proven; real-world matching is not.
8. ~80 episodic `turn` entries from old eval runs remain in `episodes.json`. They are inert (`turn`
   is not in `PASSIVE_KINDS`) and were left deliberately: their text ("bohemian rhapsody", "17 times
   23") is indistinguishable from something I might genuinely have asked, and guessing would
   delete real history. The 40 that carried unambiguous suite markers were removed.
9. **`clickByLabel` and `clickLabelAtPixels` are blind to icon buttons.** Both match on `innerText`
   only, while `ENUM_JS` reads `innerText || value || aria-label || name || placeholder`. So the
   enumerator finds controls the two label-clickers cannot press. Measured on Spotify: every play
   control returns `innerText: ""` and carries its name entirely in `aria-label`, which is why the
   Spotify lane must press by index — the staleness-immune label paths are unusable there. This is
   general, not Spotify-specific: any icon-only control anywhere is unreachable by label. The fix is
   to widen both to the accessible name, and it is **deliberately not done yet** because both sit on
   the Swiggy ordering path, where loosening label matching risks pressing the wrong control on a
   page that spends money. Do it as its own change, with the ordering tests in front of you.
10. **`settle()`'s readiness test measures the wrong thing for SPAs.** It returns `ready` on
   `readyState === 'complete' && document.querySelectorAll('*').length >= 400` (`SETTLE_SUBSTANTIAL`),
   which counts ALL DOM nodes — and an app shell clears 400 long before any content exists. Measured
   on a Spotify search: `settle()` reports ready at ~3.0s with 1158 nodes but only 41 of an eventual
   300 enumerable controls; the results land at ~3.6s. The Spotify lane no longer depends on this
   (it waits for the control it actually wants — see `chooseTrackControl`), but every other browser
   lane still trusts it. Not changed here because re-timing `settle()` re-times YouTube, Swiggy and
   the web tasks simultaneously; that needs its own run of the eval, not a ride-along.

**Weather** comes from Open-Meteo (real forecast API, no key) for your IP-geolocated location. If the location is wrong, pin it in `.env`:
- `JARVIS_WEATHER_LOCATION=Mumbai` (city name) or `JARVIS_WEATHER_LOCATION=30.90,75.85` (lat,lon)
- `JARVIS_WEATHER_UNIT=c` or `f` (default: F for US, C elsewhere)

**Rate limiting:** the mutating/expensive endpoints (`/api/chat`, `/api/capture`, `/api/research`, `/api/automations` write, `/api/watchers` write, `/api/memory` write, `/api/open`, `/api/dnd`) are token-bucket limited per route, so a burst of requests — e.g. from a blind cross-origin POST — gets a `429` instead of running up API costs or spamming writes. Read-only polling routes (`/api/overview`, `/api/logs`, etc.) are unlimited since the UI itself polls those every few seconds. Hits show up in the ⌘L system log as `Rate limit › <route>`.

Install as login agent: `./install.sh` · Remove: `./uninstall.sh` · Logs: `jarvis-os/logs/`

## Settings → Connections (2026-10-09)

- **Composio API key — required setup.** Paste it in Settings → Connections; JARVIS tests it with one read-only call to
  Composio and saves it to `.env` only if Composio accepts it. The page only ever shows "connected" and the last four
  characters. Until it is set, a banner above every view says so and cloud features stay off; local features work.
- **Connect an MCP server.** Paste the server's link (https, or http to this Mac) and, if it needs one, a key or token
  (Bearer or API-key header). JARVIS connects (`mcp_http.js`: the current Streamable HTTP transport, falling back to the
  older HTTP + SSE one), lists its tools, and saves the server in `jarvis-os/state/mcp_remote.json` (never committed;
  the token goes to `.env`, the list only names its variable). Servers that need a browser sign-in (OAuth) are reported
  as such — not supported yet. Remove deletes the server and its token.
- **What the planner sees:** at most 8 connected tools per request, chosen by meaning (`mcp.js` THE GATE; measured in
  `finetune/README` "MCP tool picker"). **His approval:** a tool its server does not mark read-only (`readOnlyHint`)
  runs only after he approves the card, through a one-time code tied to the exact arguments shown.
- Code: `envfile.js` (the only writer of `.env`), `mcp_http.js`, `mcp.js`, routes `/api/connections*` in `server.js`,
  `public/app.js` loadConnections / checkSetup. Tests: `test_envfile.js`, `test_mcp_http.js`, `test_mcp_connect.js`
  (temp files and a mock server on this Mac — no real key, his `.env` untouched).
