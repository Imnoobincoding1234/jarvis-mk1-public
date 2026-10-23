# JARVIS Fleet — Handoff

Native macOS "JARVIS" background agents (Swift, ad-hoc-signed `.app`, launchd LaunchAgents at
`~/Library/LaunchAgents/com.atharv.*.plist`). Each has `build.sh`/`install.sh`/`uninstall.sh` +
env-var tuning in its plist. macOS 26.x, Apple Silicon, Swift 6.x.

Everything lives in `~/JARVIS MK-1/`. `focus-guard/` was moved in: the launchd agent now runs
`~/JARVIS MK-1/focus-guard/FocusGuard.app` (checked in the plist 2026-09-17), and the old copy under
`~/claude code test/` is not what runs. `ambient-dashboard/` was removed. `gesture-control/` is a DEAD DIRECTORY: the app and log
are still on disk under `~/claude code test/`, but there is no launchd agent and nothing loads it —
do not read its presence as "installed".

## Current state (2026-10-22) — read this first; older sections below are history

**Live:** chat replies = `jarvis` (Bonsai 4B 1-bit + v4.2 LoRA) on `runtime/llama-server`; helper (rewrites, checks, routing) =
`qwen2.5:3b-instruct-q4_K_M`; reader = `jarvis-reader` **round 5** (MIN_CONFIDENCE 0.75, veto on); reasoner = `phi4-mini`;
Think hard = Bonsai 8B; vision = `qwen3-vl:2b`. Ollama 0.40.3 (auto-update off). Settings → Models shows this map;
Calibrate (10-17) measured jarvis and Bonsai 8B (kept 10-19). Quit refuses names no app answers to (10-17).
**In the code, OFF (switches, not in .env):** `JARVIS_COMPOSE_V3` (composer: `=1` candidate C failed; `=c2` + `JARVIS_COMPOSE_CTX=2048`
= C2-2k, passed 6/7 bars on fresh v5 — time missed by 62 ms, accepted by the owner — gate 533 → 534 with 4 composer LOST,
shipping is the owner's call); `JARVIS_READER_TIERS`, `JARVIS_READER_REPAIR`, `JARVIS_READER_LATER`, `JARVIS_COMPOSE_JUDGE`.
**Results and plans:** `finetune/README.md` (every trial, its pre-registered bars and the result — newest at the bottom).
**Restore (fixed 10-19):** `finetune/reader_gguf.py` rebuilds the reader byte-identical on Ollama 0.40.3; `install.sh` step 3a
pulls Bonsai 4B / 8B; `loraserver.js` reads `manifests-v2/`. **Gate:** `jarvis-os/sweeps/gate/` (`gate_resume_loop.sh <tag>`,
`carry_grades.py`, `gate_diff.py`, baseline tag `prerestart2-20261016`); the sandbox's write guard now covers every write path.
**Rules that bit recently:** zsh does not word-split `$VAR` (use the command written out or a bash array); measure memory
with JARVIS's other models loaded (a sweep that unloads everything hid phi4-mini's 3.6 GB at 8192 context); `tools/bak.sh`
takes two arguments.

## Agents (checked 2026-10-13)
| Agent | Label / bundle | Does | Perms | State |
|---|---|---|---|---|
| JARVIS OS | com.atharv.jarvisos | the assistant, 127.0.0.1:8787 | — | running |
| Screen control | com.atharv.jarviscontrol | CGEvent input + blue HUD | Accessibility | running |
| Clap daemon | com.atharv.claplistener | 2 claps -> open JARVIS OS.app; also the "hey jarvis" wake word | Mic | **NOT LOADED — muted until the casual push is done (my rule, 2026-09-28)** |
| Focus guard | com.atharv.focusguard | Gesture-armed DND + banners | Notifications | running |
| Jarvis Search | local.jarvis.search | Cmd+9 overlay; built-in voice "jarvis search <query>" | Mic + Speech | running |
| Self healing | com.atharv.jarvisselfheal | checks every agent every 5 min | — | periodic |
| Jarvis canary | com.atharv.jarviscanary | one real query through every outside dependency, 4×/day | — | periodic |
| Security | com.atharv.jarvissecurity | daily integrity check (verify.sh, 09:00) | — | periodic |
| Model limit | com.atharv.ollamaonemodel | `launchctl setenv OLLAMA_MAX_LOADED_MODELS 4` at login | — | one-shot |
| ~~Battery alert~~ | com.atharv.batteryalert | WhatsApped Nanu under 20% during my trek | — | **RETIRED 2026-10-13** → `backups/retired-batteryalert-20261013/` |

### THE TWO WAKE PHRASES HAVE TWO SEPARATE SWITCHES. There is no single one.

`main.swift` calls `jarvis.voice_wake` "ONE SWITCH FOR EVERY ALWAYS-ON WAKE PHRASE IN THE FLEET".
It is not. It gates **only** Jarvis Search's "jarvis search" phrase, and it is currently `false`.

ClapListener's "hey jarvis" reads no YAML at all. It is gated on the env var `JARVIS_WAKE` in
`com.atharv.claplistener.plist`, currently `1`, threshold `JARVIS_WAKE_THRESHOLD` default 0.5.
So setting `voice_wake: false` leaves "hey jarvis" armed and the mic open. To actually silence the
fleet you must set BOTH. Verified 2026-09-05 by reading the plist.

CORRECTION (2026-09-07): an earlier version of this paragraph said the live `localspeechrecognition`
XPC was that recogniser. **That was wrong.** ClapListener migrated to openWakeWord — three ONNX
models (`hey_jarvis_v0.1`, `embedding_model`, `melspectrogram`, 3.5 MB total) shipped in
`ClapListener.app/Contents/Resources/models/`, run on onnxruntime inside the daemon, which is why the
bundle is 127 MB. Checked: the binary was built one minute after the source, so it is current.
The `localspeechrecognition` processes on this machine have PPID 1 and belong to something else —
they are not the wake word. The privacy property is the opposite of what that paragraph implied:
openWakeWord CANNOT transcribe, it only scores how much a sound resembled the one phrase.

Threshold history: 0.5 -> 0.3 (wrong, seven false wakes in a day) -> back to 0.5 on 2026-09-04.
Since the rollback: one wake in 29 hours, score 0.970, which was the verification shot itself.
Zero false accepts. `clap.log` restarts audio ~130-160x/day ("no audio for 5s") and has done since
at least 2026-08-27 — stable, not degrading, and wakes still register through it.

Jarvis Search was built by Codex (not us). **The source now lives in this repo** at
`Jarvis Search/src/Sources/main.swift` — that is the only copy, it is what `build.sh` compiles, and
it is what the backup restores. **The live app has NO URL scheme.** The `jarvissearch://search?q=`
scheme existed only in the mistaken 2026-07-08 build `Jarvis Search.app.with-urlscheme` — and until
2026-09-18 that dead, downgraded build was what macOS opened for `jarvissearch://` links. It is now
zipped in `backups/`, so no app claims the scheme. Nothing in JARVIS opens it (checked: only the retired
jarvis-search-voice agent did).

RETIRED 2026-08-28: the original under `~/Documents/Codex/.../JarvisSearch/` is no longer the source
of truth. Two copies drifted within a single afternoon — one revision of the AI-provider work landed
in the repo and not in Codex — and a stale second copy is how the wrong file gets built. The
"UI Handoff" folder was always a snapshot with no `main.swift` at all; on 2026-09-18 it moved to
`backups/` with the old app builds, so the only Jarvis Search source in the tree is `src/`.

## Critical gotchas
1. Ad-hoc rebuild wipes Accessibility grant (new cdhash). (gesture-control removed).
   Prefer tuning via plist env + reload (no rebuild). Dashboard/clap/config rebuild safely.
2. "not trusted" warning logs BEFORE the "launched" line -> check `tail -n +$((LAST-1))`.
3. Duplicate instances = mic contention. If a .app gets `open`'d alongside its agent, two fight
   the mic. Fix: `pkill -9 -f <Name>...` then bootstrap ONE.
4. launchd CANNOT exec from ~/Desktop, ~/Documents, ~/Downloads (TCC -> EX_CONFIG 78). Keep in home.
5. After moving any .app: `lsregister -f "<path>"` + kill ghost from old path, or by-name/voice
   opening silently breaks.
6. Synthetic Cmd-hotkeys don't reliably fire Carbon RegisterEventHotKey -> Jarvis Search voice uses
   the URL scheme, not fake keystrokes.
7. Mic contention: this said "3 engines (clap + Jarvis Search voice + Jarvis Config voice)". Only ONE
   is live now — Jarvis Config was deleted, and Jarvis Search's phrase is off (`voice_wake: false`),
   so ClapListener holds the mic alone. Restore the contention warning if either comes back.

## Clap tuning (most-fiddled)
Gain-independent: clap = spike vs rolling background. Env CLAP_RATIO (x bg, default 8) AND CLAP_FLOOR
(absolute min). This Mac has 3 mics with different gains; measured claps peak 2.0-6.5, ambient
~0.03-0.11. Current CLAP_FLOOR=1.8. CLAP_DEBUG=1 logs peak=. Tune via plist + reload.

## Jarvis Config — THE PANEL IS GONE (deleted 2026-09-04); the YAML is not

The ⌘⇧S settings panel and its `com.atharv.jarvisconfig` agent were deleted. Confirmed 2026-09-05:
no such label in `launchctl list`. What this section used to promise no longer exists —
there is no UI, and nothing toggles agents for you. Use `launchctl` directly.

Still true:
- SoT: `~/JARVIS MK-1/jarvis.yaml` (sections jarvis/agents/database/security). Auto-created,
  crash-proof (MiniYAML, merges defaults on invalid, no rewrite on read). Still read at launch —
  `voice_wake` is consumed by Jarvis Search, see the wake-phrase note above.

No longer true:
- "Settings toggles really enable/disable agents via launchctl" — there is no settings panel.
- `security.settings_password` is ORPHANED: nothing reads it now that the panel is gone. It holds a
  salted SHA-256 hash (`sha256$<salt>$<digest>`), not the plaintext this doc used to print.
  mine to remove from `jarvis.yaml` when I want it out.
- `config-manager/` no longer exists on disk. Do not confuse it with `config/`, which is live
  jarvis-os data (mcp.json, ordering.json, sites.json). **`verbs.json` is DELETED** — see below.
- The dashboard `Config.agents` / `isRunning` / `dot()` wiring described here has no dashboard.

## Routing: asked, not looked up (2026-09-11)

**THE STANDING RULE: no keyword or regex traps, no matter what.** A list of the words a person might
use fails on the one nobody wrote down, and it fails SILENTLY — nothing in the log says "that matched no
pattern". If you find one, replace it with something semantic measured on held-out data, never with a
longer list. The test: does it list natural-language words that decide behaviour from what I typed?
Trap — and that includes GRAMMAR words (articles, pronouns, prepositions, ordinals, wh-words, time
units): I revoked the "closed grammatical category" exception on 2026-09-13. Subtractive extraction
(deleting listed words) and a category list inside a model prompt are the same trap. Allowed: registries
the machine owns (sites.json, the app index, Contacts, my folders, the dictionary), statistics learned
from my own data, pure shape (digits, punctuation, URLs, edit distance, position), JARVIS's OWN output
and log strings, the reader model behind its checker, and my own answers kept per word. Behavioural
check: empty every cache — if the code still "knows" words, it is a trap.

**Destroyed:** `config/verbs.json` (all 11 groups), `RESEARCH_RE`, `stripResearch`, `CAL_LIST_RE`,
`FREE_SLOT_RE`, `APP_SEARCH_RE`, `APP_SEARCH_IN_RE`, `LEADIN_RE`, the verblex antonym seed (2026-09-17),
`DREAM_RE` and the two regexes behind it + dream_set's off/stop/disable guess (2026-09-18 → dreamintent.js),
`PROACTIVE_RE` + the `status` word test + proactive_set's off/stop/quiet guess + breaks_set's on/yes/true
(2026-09-18 → proactiveintent.js: 28 held-out, 0 wrong, 0 intruders, where the list found 2 of 14 and turned
"be quiet for a sec i am on a call" into initiative OFF). JARVIS's own TOOL NAMES are evidence, never a
decision, in both: "my dream now is to be a pilot" names dream_now, so a name the classifier reads otherwise
is ASKED about and my yes kept for that sentence (readmodel.confirm).

Every offer's yes/no (2026-09-19): `pendingOffer` answered by AFFIRM_RE/DECLINE_RE, and PREVIEW_GO_RE for a
plan preview — each offer now names its own answer ('Say “read”', '“present”', '“call”', '“open”',
'“replace”', '“go”') and soleOffered decides; several can be live at once (`wordOffers`). AFFIRM_RE/DECLINE_RE
survive ONLY in actionableGoal (a "yes" after the 3B's free-text reply offered something) until a measured
reading of "this reply is an offer" exists.

**Measured and NOT shipped:** a tutor classifier (2026-09-18, 33 held-out incl. all 8 of my tutor messages):
at every gate it either acted on look-alikes ("quiz show on tv tonight", "ask mama a question" → a quiz)
or missed most of my "teach me about X" — to an embedder that is "what is X". TUTOR_RE stays until the
READER learns the tutor (quiz_me / study_stats / learn_topic{topic} / stop_topic{topic}) in a retrain — the
route I chose for dream mode. On 2026-09-19 the tutor became reader acts (finetune/LABELING.md; round 2) and
went live with the round-2 reader; TUTOR_RE, its three subject captures, `study stats` as words, and
learn_topic's about/on strip were DELETED (tutor_heldout: 27/33 raw, 0 acting wrong past the gate).

**Still live, to be replaced one measured reader at a time** (line numbers drift — search by name):
server.js `isInformationalQuestion` (WH_RE, SELF_CAPABILITY_RE, ANSWER_VERB_RE, ASK_ANSWER_RE,
AUX_SELF_RE, HINGLISH_Q_RE), `resolveReference`, `stripPreamble` + CHATTER_CLAUSE_RE, ACTION_VERB_RE,
ORDINALS, CLAUSE_SPLIT_RE / CLAUSE_CMD_RE, the isStatement family, isQuestion / isHowToQuestion /
looksLikeCommand / isCompoundCommand / mentionsKnownTarget, the order lane (FOOD_BRAND_RE,
FOOD_CATEGORY_RE, YES_RE/NO_RE, ORDER_PLATFORM_RE and its word-strip lists), STORE_VAGUE_RE,
**AFFIRM_RE / DECLINE_RE** (every offer's yes/no — the Sunday AI/ML offer deliberately does NOT use
them), MUSIC_LATEST_RE, the WEATHER_* family, PERSONAL_SITE_TASK_RE + SEARCH_VERB_RE, the LIB_* /
MYSITE_* / PREVIEW_* / PAGE_REF / NAV_LABEL / BROWSER_* / CLICK* / STOP_PHRASE / HINGLISH_* regexes,
playOnSpotify's stop lists; browser.js playNearJs STOP; system_control.js APP_FILLER, ALIAS_BASE,
resolvePath's word regexes; playbook.js's order-food regex; harness.js expectedParts; learned.js
VERB_FAMILY + STOP (keep verbConflict's subscribe≠unsubscribe behaviour — my words 2026-09-19: the one
kind of word check allowed is "something genuine like the unsubscribe /= subscribe thing where semantic
cant help"); recall.js TRIVIAL_RE + STOP; weakAction's `and|then|for|looking|hunt|find|search` and `;|and|then` tests (they only
see actions the reader did NOT build — the actread fallback); AFFIRM_RE/DECLINE_RE in actionableGoal (above);
PREVIEW_RE (what asks for a plan preview); public/app.js's world/neural open/close lists (REPLACED on the
server 2026-09-19 — PANELS registry + actread.panelFor + the reader's open/close, reply `ui`; the client
half is applied at the next deploy, measured first by tests/test_panels.js), detectWatchIntent,
detectScreenIntent, clientControlIntent, resolveDisplayFromText's number/ordinal words, and the agent-confirm yes-list
(`y|yes|yep|…|go ahead|sure|ok|please|affirmative`, client side); proactive.js sigCalendar's meeting-app list
(`zoom|google meet|meet|teams|…` — "meet the parents dinner" would offer Chrome; the installed-apps registry
and the event's own link are the list-free sources); the quiz-answer lane's looksLikeCommand /
isInformationalQuestion.

**What replaced them, and the one thing that did NOT:**
- `webintent.js` — does answering this need the web? `calintent.js` — is this my calendar?
  `replyhedge.js` — did the reply ANSWER, or defer to a source? All swept on held-out sets; the
  numbers are in the files and re-measured by their suites.
- `verblex.js` — HIS answers about which way a phrase goes, and nothing else (since 2026-09-17).
  Embeddings **cannot do negation**: measured, the embedder ranks "fire up the calculator" nearer
  `close_app` (0.382) than `open_app` (0.367). The version before this kept a SEED of antonym pairs
  for the 3B to extend, and the seed was itself a keyword trap ("spin up" = open an app, and "spin up a
  folder" is not one) — I ordered it destroyed, and it was, with the 3B learner. Direction now comes
  from the reader model's own probabilities (see below); my answers are kept per pair (app, file) in
  format 2, and an answer that points the other way turns the reading round.
- `ollama.js` — one door for every embedding call, and it restarts the daemon when it finds it down
  (950 ms from dead to a vector). That is what made deleting verbs.json viable: "works with Ollama
  down" was its whole justification.

**THE MAIN EMBEDDER IS `nomic-embed-text` SINCE 2026-09-12.** all-minilm was replaced on measurement:
81 held-out routing goals with each model's own threshold swept, 74/81 and no wrong actions against
68/81 with seven. Nothing was superior in every way — all-minilm is still smaller and twice as fast —
and three classifiers KEPT it, also on measurement: `itemclass` (bare item words, 21/22 against
19/22, and "bedsheet" stops abstaining), `replyclaim` and `replyhedge` (both read JARVIS's own reply
back, and under nomic the hedge guard stops firing at all). nomic reads a REQUEST better and a REPLY
worse. Its task prefixes were measured too and all four were worse — the same prefix on both sides
lifts every cosine together and the usable threshold collapses to 0.005. `makeClassifier` takes a
`model` now; every pin says why at the call site.

**Two embedders for language, and they are not interchangeable.** nomic reads English; granite-embedding:278m
reads my Hinglish. The second exists because the first LEAKED — measured, it routed "mere bhai ka
naam kya hai", "mujhe kal kya karna hai" and "mere contacts dikhao" to a search engine. granite leaks
none (highest wrong margin 0.000 vs 0.040) but is 2.5x slower, 6.5x more resident, and compresses
every margin, so a threshold swept for one stops firing under the other — calintent clears by 0.004
under granite against 0.054 under all-minilm. Routing is therefore **opt-in per classifier**
(`minMarginAlt`); only webintent opts in so far. The two vector spaces are NEVER compared.

The language detector (`lang.js` + `intent.js`) names no Hindi — that would be the same trap in
another language. It asks how much of the sentence is ENGLISH, against the 236k-word dictionary macOS
ships, with names removed by the site/app/Contacts registries, OR'd with a semantic language region.
Measured 36/36 together. **Contacts warms asynchronously** — before it is warm, "message parth" reads
as Hinglish. That is a race in tests, not in the server, which warms at boot.

## The reader model (live since 2026-09-17; round 5 since 2026-10-13)

`jarvis-reader` — Qwen3.5-0.8B + a LoRA adapter trained on my hand-labelled messages — reads every
request into one JSON reading, and `jarvis-os/readmodel.js` keeps it only if every value is copied from
my words and every name resolves in a registry. It replaced `quickActionCore`, the 3B normaliser and
`classifyAction`. The live model is **round 5** (`adapters/reader_round5`, exported q8_0, 1.0 GB on disk,
1.1 GB resident) since 2026-10-13, with **the veto on** (`JARVIS_READER_VETO=1` in .env: a confident `none`
closes the procedure, agent, act-instead and dream lanes). Round 2 is kept as `jarvis-reader-r2` — roll back
with `ollama cp jarvis-reader-r2 jarvis-reader` and restart. `finetune/adapters/current` holds the live
adapter for the vault and `install.sh` (it is tracked in git). Round 5 on the six held-out files: 372 exact /
4 missed / 8 refused / 28 wrong; casual stress set v3 through the whole pipeline: 69.5%, 1 wrong action.

- **Gates** (tables in readmodel.js): confidence 0.75; 0.3–0.75 asks "Should I …?" and keeps my answer
  in `state/readmodel.confirmed.json`; open/close and create/delete need the model's own act probability
  0.5 above the other half's; a typed file, path, URL or number the reading ignores is refused.
- **Places**: a folder I name always wins. The answer to "where?" applies once; only my "always"
  (said alone) makes it the default, in `state/places.json`.
- **Measured** (`sweeps/sweep_his.js`, full pipeline): exam 218 → 197 exact / 21 missed / 0 wrong; held-out
  118 → 117 / 1 / 0; trained 1,139 → 1,075 / 51 / 2 wrong (+11 both ask). Raw exam before the gates:
  203/218, 1 wrong. **I want 100%** — next is a retrain (new examples for the missed shapes, never the
  test sentences; a `refers` flag so the 3B resolver stops running on every turn with history), checked
  on a fresh held-out set. Training waits until I am away and plugged in.
- **Training rules**: every heavy step under `finetune/guard.py`; never while I am using the Mac (macOS
  kills MLX with `kIOGPUCommandBufferCallbackErrorImpactingInteractivity` anyway); fixed validation with
  `build_dataset.py --hold`; export with `finetune/export_reader.sh`, then `./tools/vault.sh pack`.
- **Without the model** only open / close / system parse (`actread.js`), and `test_parse` exits 1.

## ONE MODEL IN MEMORY AT A TIME (my rule, 2026-09-23)

**Superseded 2026-10-09 by one gate** (`jarvis-os/ollama.js` makeRoomFor, commit 670dde0), asked before every
model call: a heavy model (1.5 GB or more on disk) is always alone; the light ones (`jarvis`, the reader) share
only within `JARVIS_MODEL_BUDGET_GB` (default 0 = never two generation models); embedders may sit beside one.
Ollama's cap is now 4 (com.atharv.ollamaonemodel). A 3 GB budget made a reply 1.1 s instead of ~12 s but took
free memory to 16–24% and filled swap, so it stays 0 until I choose. What follows is how one-at-a-time was
built and measured.

"ollama and llama server have too much ram occupation and jarvis freezes everything when i use it … i want 1
model at a time in jarvis so my machine doesnt die." Every loaded model is its own `llama-server` process
holding its full weights (Ollama loads them with mmap off); the default of three at once let reader + 3B +
an embedder co-reside. Now `OLLAMA_MAX_LOADED_MODELS=1`:
- Ollama.app has no setting for it. The login agent `com.atharv.ollamaonemodel` (written by install.sh) runs
  `launchctl setenv OLLAMA_MAX_LOADED_MODELS 1`; Ollama.app reads launchd's environment only when it starts,
  so after any change it must be restarted (quit + open; `osascript quit` can come back "User canceled").
- jarvis-os/ollama.js passes the same setting to any `ollama serve` its self-heal starts.
- Verify: the last "server config" line of ~/.ollama/logs/server.log says `OLLAMA_MAX_LOADED_MODELS:1`.
- Off switch: `launchctl bootout gui/$UID/com.atharv.ollamaonemodel && launchctl unsetenv OLLAMA_MAX_LOADED_MODELS`, restart Ollama.app.
- Measured (`jarvis-os/sweeps/sweep_onemodel.js`, a turn's model sequence, twice): one model resident after
  every call, lowest free memory 19% (the 3B alone); ~11–12 s of model time per turn — reader reload 3.4–3.7 s,
  3B 3.3–3.8 s, embedders 0.3–0.6 s. The 3B reloads between the resolver and the reply because a nomic gate
  runs in between; ordering the gates before the resolver would save ~2 s. Not yet judged live by me.

Same day, "save speed but make sure it doesnt destroy my ram":
- **mmap on for every model call** (`use_mmap: true` in ollama.js, readmodel.js, llm(), factmatch, sitekind,
  agent, calibrate; the measurement is in ollama.js USE_MMAP). Load + 1 token: reader 2.8–3.1 s → 2.2 s,
  free 22–26% → 30–31%; 3B 3.7–4.0 s → 2.6–2.9 s, free 17–18% → 26%. File-backed weights macOS can drop
  instead of swapping.
- **A vector cache at the one embedding door** (ollama.js, 512 entries) and **`intent.prewarmText`** at the
  start of every turn: the sentence is embedded once by every gate's model before the reader and the 3B.
  Measured on a real warm turn (via 'eval'): the 3B now loads ONCE per turn and stays through the reply.
  Gaps: the first turn after a restart misses models whose classifiers are built lazily; all-minilm and the
  reader still load twice at turn start (~3–4 s).
- **Where a turn's time goes now** (warm, "what is the capital of germany" with history, 52.9 s): web
  research 36.8 s (7 sources, 3B synthesis 25.5 s on 1,725 prompt tokens), the reference resolver ~10 s
  ([A], still every turn with history), model swaps ~4–5 s. Loading is no longer the big cost.
- **Faster web research** (my pick, same day): `jarvis-os/sweeps/sweep_research_speed.js`, 20 factual questions
  written before any setting was tried. Local non-deep research now reads 700 chars/page (was 1,400),
  answers in 1–3 sentences (max 220 tokens, was 500) and stops waiting once enough pages have arrived:
  20/20 right, median 12.0 s, where the old setting was 20/20 at 27.9 s (table in doResearch). Deep
  research keeps the long form (not measured). The same real warm turn: 52.9 s → 23.8 s (research
  36.8 → 12.9 s). What is left per turn: the resolver 3B call ~7–10 s ([A]), model swaps ~3–6 s.

### Follow-ups, 2026-09-23 evening → 2026-09-24 (commits e147b67, and this one)

- **Red memory is the 3B itself, not co-residence.** Sampling live turns every 250 ms (kernel pressure level +
  every llama-server): never more than one runner; the 3B alone takes free memory 58% → 17–22% (pressure
  "warn"), red once Brave/apps are bigger, and a one-line reply then takes 12–20 s instead of ~2.6 s. The 3B
  unloads 30 s after its last call now (`CHAT_KEEPALIVE`, `JARVIS_CHAT_KEEPALIVE`), which barely matters:
  an embedder after the reply evicts it anyway.
- **phi4-mini is a memory hazard.** At the live reasoning context (8192) it took the Mac to 12% free, at 4096
  to 14% (sweeps/sweep_reasoncmp.js, aborted by its watchdog both times). Every reasoning turn does this.
  Not changed yet — a smaller context is my call.
- **Fleet panel:** `ollamaonemodel` is a run-once agent (no PID). It shows as "One Model Limit" and is judged by
  `launchctl getenv OLLAMA_MAX_LOADED_MODELS` = 1 (server.js ONESHOT_AGENTS), not by a PID.
- **Double 3B load:** only the first turn after a restart — validateModel's probe embed (once per embedder per
  process) loaded all-minilm between the resolver and the reply. `intent.warmModels` runs at boot; verified.
- **"whats 2 plus 2"** skipped exact arithmetic (reasoning-shaped text is not `plain`), went to phi, whose
  "Done. The answer is 4." read as a false claim → the agent. Arithmetic now runs on reasoning-shaped turns;
  the reasoning route is not judged for action claims; `mentionsKnownTarget` no longer takes a PREFIX as an
  app ("whats" was WhatsApp) — whole words, run-together words (FindMy), or one edit (Reminders).
- **Spotify:** the matcher counted the artist's name as "extra" words, so bare "judas" played TommyMuzzic over
  Lady Gaga — title line only now, ties to Spotify's order (tests/test_playnear.js). "Blast judas": the
  playbook's query slot is still a subtractive word list; a leading word it keeps is asked about once
  ('Say "play" / "name"', kept in state/playwords.json) until round 3 teaches the reader play verbs.
- **Bug [A], partial:** the resolver's cost is cold PROMPT eval (514 tokens at ~120 tok/s with Low Power Mode;
  0.45 s when cached, and the cache never survives one-model-at-a-time). It is skipped only when the reader
  (P(refers) < 0.001) AND the leaning embedder (< −0.045) both say self-contained: 0/99 + 0/35 fresh references
  skipped, ~18% of calls saved (sweeps/sweep_refskip.js).
- **The false-claim guard is a trained reader now** (replyclaim.js + replyclaim.weights.json; trained by
  finetune/train_replyclaim.js). Across five held-out sets: 108/127 claims caught, 11/135 answers flagged,
  where the old regions caught 32/127 and flagged 36/135 (and on 22 real blocked replies had blocked all
  22, 15 of them correct answers). Delete the weights file to fall back.
- **Bonsai (PrismML 1-bit) tried:** 8B removed (2.5× slower prompts on the M1 — prompt eval is compute-bound).
  4B (572 MB) still installed as a candidate, NOT used: vs the 3B on held-out JARVIS jobs it lost the resolver
  (8/16 vs 14/16) and agent decisions (8/14 vs 12/14), tied chat, and on reasoning made confident errors
  (2^10 = "1,024,000,000,000"). Worth training (Apache-2.0 unpacked weights) — see the roadmap.

### 2026-09-25 → 2026-09-26 (commits abc5874, 5294fd8)

- **My episodic memory was restored.** The test suite had overwritten `state/episodes.json` (1,365 → 7). Root
  fix in abc5874 (recall/profile drop their cache on a folder change). Restored from the Aug 21 backup plus
  the one real Sep 24 turn = 1,366; the vault turned out to be packed after the wipe. `episodes.vec.json`
  proves 337 episodes from Aug 21 → Sep 12 existed and are gone unless Time Machine has them. Never run
  `tools/vault.sh unpack` on a live machine — it extracts the whole vault over `.env`, profile and
  `finetune/data`; to read one file, decrypt with openssl and `tar -x` just that file into scratch.
- **phi4-mini reasons at ctx 4096** (`REASONING_CTX`, env `JARVIS_REASONING_CTX`): at 8192 it took free memory
  to 8% on the first problem; at 4096 lowest 14%.
- **Chat replies see only what needs me** (`attention.js`): battery under 20% and not charging, disk 92%+, an
  agent down — as one `Needs attention:` line at the end — instead of CPU/RAM/battery/disk on every turn
  (Bonsai recited them on 15 of 22 greetings). The clock carries the weekday (both models called a Friday
  "Wednesday"/"Saturday"). Reasoning turns and watchers still get every number (`state: 'full'`). A
  greeting-rule sentence naming kinds of message was tried and REMOVED the same day — a category list in a
  prompt is a trap.
- **The Briefing button** (`body.brief`, only #qaBriefing sends it) goes straight to `buildBriefing()` —
  real calendar, schedule, battery, disk, RAM, weather. It used to fall to the 3B improvising one ("3 unread
  messages" from nowhere), which the claim guard blocked into an agent run (39 s, calendar only).
- **The reasoning gate is a trained reader** (`reasonintent.js` + `reasongate.weights.json`, trained by
  `finetune/train_reasongate.js`). `looksLikeReasoning` and its word lists (IMPERATIVE_RE, QUANTITY_RE/NUM_RE,
  DERIVE_RE, ARITH_OP_RE, CLOCK_RE, DURATION_RE — 84 lines) are deleted: "…what will be their sum?" missed
  "sum of", went through the resolver and the 3B, 43 s. Held-out: 15/22, 23/28, 21/28 caught, **0 false yes on
  all three**; the regex caught 6/22. Interim — the reader model's round 3 is meant to take it to 100%.
- **Reasoning turns use a lean prompt** (`systemPrompt(extra, {purpose: 'reasoning'})`,
  `profile.promptLines({forReasoning})`): no capability list, no contacts/nickname/acting rules. Bonsai 8B had
  read a puzzle's "a" and "b" as contacts to look up. 4,262 → 1,167 chars; phi on the graded logic set
  30/58 → 35/58.
- **"Why did you do that?"** (`explain.js` + `whyintent.js`): the last turn's own decision lines (jlog,
  "<Stage> › …") said in plain English — no model writes it. The question is recognised by embedder regions
  (margin 0.03 by leave-one-out; held-out 12/14 caught, 0/14 false). Eval turns keep their own slot.
- **Think hard button** (#qaThink → `body.thinkHard` → `thinkHard()`): my next question goes to **Bonsai 8B**
  with its thinking mode on, the lean prompt and an 8K window (`JARVIS_THINK_MODEL/CTX/TOKENS`). On the nine
  hard graded problems it solved 6/9 where phi managed ~2, at 30 s–4.5 min and free memory down to 17%.
  Opt-in only. It is still wrong a third of the time on hard problems and says to double-check.
- **REAL reasoning is weak in every local model.** `finetune/data/reasoning_graded_heldout.json` (30 logic
  problems, grade 2 → 12; hand-graded): phi 52%, 3B 55%, Bonsai 4B 43% (thinking on 47%, it does not really
  think). The earlier "reasoning" sets were arithmetic word problems — never call them reasoning. Switching
  reasoning to Bonsai 4B on those arithmetic numbers was UNDONE when it failed a 2nd-grade renaming puzzle.
- **Bonsai `jarvis` v1 trained, NOT deployed** (finetune/README). Wins greetings (quiet, short) and reasoning
  arithmetic; loses chat ("capital of japan" → "Ottawa", "did u send that message" → "Yes, Sir", curt, Hinglish
  misread). v2 needs ~5× data, anti-forgetting, honesty rows, Hinglish.
- **Models:** `jarvis-reader-prev` removed. Bonsai 4B stays (the `jarvis` base); Bonsai 8B stays (Think hard).
  `qwen3-embedding:0.6b` is installed and used by nothing (removed 2026-10-13). (Superseded 2026-10-13: Ollama is 0.40.3 and
  jarvis no longer depends on Ollama's adapter models — see the next section.)

### 2026-09-27 → 2026-10-13

- **`jarvis` is the chat model since 2026-10-08** (d993d88): Bonsai 4B Q1_0 + my v4.2 LoRA, built by
  `ollama create` from `finetune/Modelfile.jarvis` (`.env JARVIS_CHAT_REPLY_MODEL=jarvis`). It writes plain chat
  replies and the Wikipedia lane's answers; the 3B still runs the agent loop, the reference check and research
  answers; **phi4-mini is still the reasoner** (`JARVIS_REASONING_MODEL`); Bonsai 8B is Think hard. v4.2.1 and v4.3
  (a greeting patch) missed their bars — finetune/README.
- **Ollama is 0.40.3 since 2026-10-13 (my go, after option 3 went live).** Done by hand: the notarized
  `Ollama-darwin.zip` (sha256 = GitHub's digest, team 3MU9H2V9Y9), the old app zipped to
  `backups/ollama-app/Ollama-0.33.3.app.zip` + its settings folder copied beside it, the old .app moved to the Trash.
  Measured on the live install against 0.33.3: reader 90/90 same reading (confidence change ≤ 0.002, 194 vs 212 ms),
  nomic / granite / all-minilm identical vectors; no background model upgrade ran; auto_update_enabled stayed 0.
  run_all after the update: 2,924 green twice, once 2,923 (test_calintent "threshold admits every correct case": lowest
  correct margin 0.023 < 0.05 inside the full run; 0.054 in three runs alone and green in the next full run) — a flake
  to watch, not reproduced.
  Rollback: quit Ollama, unzip the 0.33.3 app over /Applications/Ollama.app, relaunch with the cap. `ollama create …
  ADAPTER` no longer exists — a new jarvis adapter is served by loraserver.js (`JARVIS_LORA_ADAPTER`), never built
  into Ollama. History of the pin: 0.34.1 removed `ollama create … ADAPTER` (how `jarvis` is built); 0.40.0 runs qwen3.5
  (the reader's base) on MLX by default; 0.40.2 upgrades older models in the background. Auto-update is OFF
  (`~/Library/Application Support/Ollama/db.sqlite`, settings.auto_update_enabled=0, 2026-10-10) — re-check it
  after any Ollama relaunch. The downloaded 0.40.2 is parked in `backups/ollama-app/`. Way out ("option 3"):
  serve `jarvis` from a copy of the llama-server Ollama bundles (`--lora`, 28 MB), and test a new Ollama in a
  sandbox (own port, cloned models folder) against the reader and embedders before it goes in.
  **Option 3 sandbox, 2026-10-13: 59/59 identical** to Ollama's `jarvis` (24 chat, 3 streamed, 16 Wikipedia
  answers, 16 answer checks — same text, same prompt tokens, check yes-share difference 0), same speed and memory,
  load 0.93 s. Kit + numbers: `backups/option3-sandbox-20261013/README.md`. Use `--reasoning-format deepseek`
  (`none` leaks the template's empty think block).
  **LIVE 2026-10-13 (my go):** `jarvis-os/loraserver.js` serves jarvis from `runtime/llama-server` (pinned, in git,
  watched by integrity — runtime/README.md) on 127.0.0.1:11436, started on demand by JARVIS, stopped after keep_alive,
  and counted by the gate (`ollama.registerExternal`): another generation model evicts it and vice versa. server.js
  postChat/postChatStream route `jarvis` there and fall back to Ollama's own `jarvis` if it cannot answer (logged
  "LoRA server › … answering through Ollama"). Off switch: `JARVIS_CHAT_REPLY_RUNTIME=ollama` in .env. Tests:
  `tests/test_loraserver.js` (17, incl. identical replies and yes-shares vs Ollama's jarvis). The sandbox sweep may start
  exactly that binary and reach port 11436 (sweep_casual.js) — without that it silently measured Ollama's jarvis.
- **Wikipedia lane** (`grounded.js`, d993d88 + 14845a7): a factual question is answered from the top page by
  `jarvis`, which then judges its own answer as one more turn (kept above a 0.886 yes share); otherwise full
  research. No punctuation splitters, no capitalisation checks (my rule #1).
- **One gate for memory** (670dde0) — see the ONE MODEL section.
- **Settings → Connections** (39cae40): the Composio key and MCP servers by pasted link, behind an approval gate.
- **Business finder** (4bdc337): OpenStreetMap + Google Maps in my Brave + the web, around a named place.
- **The casual-slang push** (my goal: 98% or more on a fresh slang/Hinglish set, 0 false claims, 0 wrong
  actions). Sandbox `jarvis-os/sweeps/sweep_casual.js` (cannot act) + `score_casual.js`; runs in
  `finetune/data/casual_runs/`. Dev v1: 58.5% (09-29) → 71.7% (10-10). Judged once each: v2 65.5%, v3 69.5%
  (Hinglish 50%). v1–v3 have all been read, so the next judged run needs a fresh v4. Reader rounds 3–5 were
  trained for it; round 6 (a `time` act) missed its bar and its code is parked on branch `time-act`.
- **Round 5 + veto live 2026-10-13.** The veto had never really been on outside the sandbox: `readerSaysNone`
  read `process.env`, which nothing fills from .env — it reads `envVal` now. Same latent shape, harmless today
  (their defaults match .env): factmatch.js / ollama.js read `JARVIS_LOCAL_*` from process.env only.
- Forget asks first (b9b01ce); searches the reader read now run; agent message drafts come from the reader,
  never an echo of my command (b455626); the self-fact lane stands aside when the reader holds an action (a4be325).
- **Battery alert** (my trek, 2026-10-10: WhatsApped Nanu under 20%) — retired 2026-10-13, see the agents table.
- **Cleanup 2026-10-13:** adapters bonsai_v43_s1 / bonsai_v421_s1 / reader_round6 and `finetune/data/external` +
  `external_web` went to the Trash as "<name> (JARVIS cleanup 2026-10-13)"; Ollama models qwen3-embedding,
  jarvis-reader-next and the duplicate tag jarvis-reader-r5 removed. **phi4-mini kept — it is the live reasoner.**
  Round 7 starts from round 5 (or round 6 back out of the Trash).
- **`ollama serve` memory:** after days up it holds ~3 GB compressed with no model loaded. Restart: `kill -9` the
  Ollama app and its server (by PID — in zsh an unquoted "$P" with two PIDs is ONE argument and kills nothing), then
  `open --env OLLAMA_MAX_LOADED_MODELS=4 -a Ollama`; check the version, the cap in
  ~/.ollama/logs/server.log, and auto_update_enabled still 0 (done 2026-10-13).
- **The neural network** gained GROUNDED ANSWERS, CLAIM CHECK, ONE-MODEL GATE, SELF-FACTS and THINK HARD
  (2026-10-13); its reasoning / reader / wake-word lines now read live state.
- `config/vocabulary.json` is out of every git ref (the pre-scrub mirror is in `backups/`), but GitHub still
  serves its 2 old commits by ID from cache until GitHub Support purges them.
- **World Monitor phase 1 (2026-10-14, his go)** — still no API keys. `jarvis-os/worldlive.js` fetches, caches (memory +
  `state/world_cache/`) and rate-limits: OpenSky flights (anonymous, one global snapshot per 16 min — the browser moves each
  aircraft along its heading in between, ≤ 20 min), adsb.lol military (60 s), CelesTrak TLE groups (12 h; Starlink only when
  its layer is switched on), Launch Library 2 (1 h), NOAA NHC cyclones (30 min), and a clicked point (Open-Meteo, Nominatim
  1/s, Wikipedia geosearch). Routes `/api/world/live/*` and `/api/world/point`; the world summary reads the caches. The globe
  is realistic (NASA Blue/Black Marble at the real terminator, clouds, ocean glint, true sun light; textures and satellite.js
  6.0.0 vendored with hashes in `public/vendor/earth/README.md`). The 2D tab works: an equirectangular canvas drawing the same
  scene (markers round-trip to 1e-13°). The legend is a left-column panel from one colour table (`WM_COLORS`) — the old strip
  sat behind the ask bar and listed colours no marker used. Measured on the M1: a live update 3 ms; Starlink (10,654) 26 ms at
  59 fps; 2D redraw 2.6 ms. Ideas from God's Eye View (MIT); phase 2 (own free keys: ships, FIRMS, traffic) waits.
- Open casual bugs (ids in `finetune/data/casual_runs/`): false "Opening X." claims, "open my mail" read as
  nothing, songs sent to YouTube, the isStatement trap, self-fact junk, proactive / why / web lane misfires, no
  live time act, single stats via chat, Hinglish at 50%.

The paragraph below describes the three-at-once behaviour it replaced.

## Which model Ollama unloads (2026-09-17)

Ollama here keeps three models loaded (`OLLAMA_MAX_LOADED_MODELS=0`, its default), loads one at a time,
and unloads the idle one with the SHORTEST configured keep_alive — measured in four orders, including one
where that model was not the next to expire. JARVIS can want four at once (reader, 3B, nomic,
all-minilm), so with embedders at 60s they are the ones thrown out and reloaded behind the reader's
load ("play let me down": 9.7 s of routing, the 3B still loaded from the turn before).

**TRIED AND REVERTED the same evening:** keep-alives as an order (embedders 4m < 3B 5m < reader 15m)
plus unloading every ≥900 MB model before phi or vision loaded (commit 8c00355). Measured ALONE — a
simulated turn 150 s after a question — it took 5.2 s to 1.4 s. On my machine it kept ~1.4 GB more
loaded between turns; with Brave + Spotify open and 5.3 GB already in swap from an evening of test runs,
memory reached ~7.5 of 8 GB, Brave page scripts took 5–26 s, and "play let me down slowly" took 123 s.
Me: "this fix did nothing but ruin stuff". Reverted; embedders 60s, reader 2m, the 3B at Ollama's 5m
default, phi evicts the 3B, vision evicts nothing (a known gap). **Any residency change must be measured
on the real machine with my browser open, not in isolation.**

What would actually help: the 3B off action turns. `context.resolveInText` loads it (2.4 GB, 16.8 s cold)
on every plain turn with history. Two shortcuts were measured that evening and rejected: skipping it
when the reader holds a checked action (3 of 56 real references would be acted on as "it", and "play …"
never qualifies), and the leaning embedder as a pre-filter (keeping every reference spares only 26 of my
204 newest messages; "play let me down slowly" scores −0.003). Only the `refers` retrain fixes it.

## Do not break these again
- `clauseResolves()` must know EVERY deterministic lane. The taught lane was missing, so a procedure
  I demonstrated read as unresolvable and refused the split for a whole sentence.
- `locate()` in learned.js must ask the scorer before trusting a bucket key. `keyOf` collapses eleven
  verbs into "view", so a chess search recorded a failure against my taught YouTube procedure.
- `appIn()` takes the BEST span, not the first over the floor, and a span under 5 characters must
  match EXACTLY — otherwise "and" matches Claude Code URL Handler and "what" matches WhatsApp.
- Test counts (2026-10-13): **2,907 assertions across 39 suites** (`test_parse` 1052, `test_reflective` 555,
  `test_stress` 305; new since 09-26 include `test_grounded`, `test_businessfinder`, `test_mcp_connect`,
  `test_envfile`, `test_websession`). `test_install` (48) not re-run. A stale number in a
  doc is how a green run gets read as a regression.
- The rules I set for anyone working here: no keyword or regex traps, ever — replace them with measured
  semantic readers or registries; do not trust a 3B's decision; measure on held-out data before claiming;
  stage named files only (never `git add -A`, never `state/*.json`); a backup copy before every edit —
  `tools/bak.sh FILE WHAT` puts it in `backups/<same path>.bak-WHAT-<time>`, never beside the file (346
  of those had piled up through the tree by 2026-09-18); `security/integrity.sh` then `verify.sh` after
  every source edit; never drive my browser or apps to test; never push without my say-so.
- The layout since 2026-09-18: tests in `jarvis-os/tests/` (`node tests/run_all.js` runs every suite,
  marks a skipped suite as not green, and unloads each suite's models when it ends), measurement scripts
  in `jarvis-os/sweeps/`. Both build paths from `__dirname`, so they run from any folder.
  `finetune/build_dataset.py` reads `tests/test_parse.js` and `sweeps/sweep_actread.js` to keep exam
  sentences out of training — move either file and it must follow.
- WHERE A NEW FILE GOES (my rule, "very important"): where its kind already lives. A module in
  `jarvis-os/`, its test in `jarvis-os/tests/`, a measurement in `jarvis-os/sweeps/`, a registry in
  `config/`, a helper in `tools/`, a reader-model script beside its siblings in `finetune/` and its data in
  `finetune/data/`, runtime state in `jarvis-os/state/`, a pre-edit copy in `backups/` (tools/bak.sh).
  Scratch work never lands in the tree.
- THE SUNDAY AI/ML WEEK (`ainews.js`, 2026-09-18, my request: "vast, so jarvis can catch even the most
  ignored breakthroughs, eg; a new model by an unknown lab"). Dream job 3 reads the 28 sources in
  `config/ainews.json` (AI/ML by construction — nothing filters by keyword; Anthropic, Meta AI and Mistral
  publish no feed). One dream rebuilds the whole week: HF papers per day, WordPress feeds paged back to
  Monday. JARVIS picks 4 headlines (coverage across sources, then release-shaped titles) and 3 wider-field
  places (top paper by upvotes, top NEW model by likes, a community pick) — the 3B only phrases them,
  as JSON `{story, text}`, and a sentence whose name-shaped words are not in its story (maker included,
  website excluded, first word checked unless the week's text shows it is ordinary) is dropped; fewer
  than 3 left or no wider field → the headlines. Sundays only (`isSunday`), until heard; 'Say "summary"'
  answered by `answersDigestOffer` (soleOffered). Full list → `JARVIS Outputs/AI-ML week of <Monday>.md`.
  First live week: 324 stories / 20 sources; r/MachineLearning often answers 429. Off switch:
  `"enabled": false` in `config/ainews.json`. The check cannot see invented lower-case CLAIMS — only names
  and numbers — so it narrows the 3B's room to invent; it does not prove a sentence true.

## My preferences (the owner)
- Their Claude app is `/Applications/Claude.app`. It WAS renamed to Jarvis.app at one point and has
  since been renamed back — and that stale fact cost a real bug: `config/sites.json` still declared
  the claude site's app as "Jarvis", `appInstalled("Jarvis")` was false, so "open claude" opened
  claude.ai in a browser with Claude.app sitting in /Applications. The registry entry is corrected,
  and open_site now falls back to the installed-app index when the declared name is not installed,
  so the next rename costs nothing.
- Rule: never edit originals — work on copies (esp. their AdMax web project).
- Minimize permission re-grants; likes it to just work.
- Uses caveman skill sometimes (terse). "stop caveman" to disable.
- Memory at ~/.claude/projects/-Users-atharv-claude-code-test/memory/ (MEMORY.md index +
  project_*.md details). Keep updated.

## Standard commands
```bash
launchctl list | grep atharv
pgrep -fl "ClapListener|FocusGuard|JarvisSearch|JarvisControl"
# reload after plist env change (no rebuild):
launchctl bootout "gui/$(id -u)/<label>"; launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/<label>.plist
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:KEY value" ~/Library/LaunchAgents/<label>.plist
```
