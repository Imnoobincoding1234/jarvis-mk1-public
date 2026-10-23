# finetune/ — where the reader model is made

`jarvis-reader` reads every request JARVIS gets (see `jarvis-os/readmodel.js` and the top-level README).
This folder trains it, measures it and hands it to Ollama. Only the scripts are in git: `data/` (my real
sentences), `models/`, `adapters/`, `runs/` and `.venv/` are not. The vault carries `data/` and
`adapters/current`, which is enough to rebuild the live model and to train again.

**Two rules before anything here runs.**

1. Every heavy step runs under `guard.py`. It stops the child on low free memory, swap growth, child
   RSS, a thermal warning, a time budget, or a battery below `--min-battery` (it will not start unplugged
   below that plus 5%).
2. Never while I am using the Mac. Training wants it plugged in and idle; macOS kills MLX with
   `kIOGPUCommandBufferCallbackErrorImpactingInteractivity` when I am busy, which fails safe (the last
   checkpoint is kept) but wastes the run.

## Setting up

```bash
cd finetune
/opt/homebrew/bin/python3.14 -m venv .venv          # Apple's python3 is too old for these wheels
./.venv/bin/pip install -r requirements.txt           # mlx 0.32.2, mlx-lm 0.31.3
./.venv/bin/hf download Qwen/Qwen3.5-0.8B --local-dir models/Qwen3.5-0.8B
./.venv/bin/python -m mlx_lm convert --hf-path models/Qwen3.5-0.8B \
  --mlx-path models/Qwen3.5-0.8B-4bit -q --q-bits 4 --q-group-size 64   # the copy LoRA trains on
```

`install.sh` does the first three when it rebuilds the reader. The 4-bit copy is only for training.

## Data

- `data/his_messages.jsonl` — my distinct messages (1,475), `data/labels_real.jsonl` — their labels
- `data/synth.jsonl` — hand-written examples for the shapes I rarely use (`synth_add.py`)
- `label_batch.py` — how labels are written; `LABELING.md` — the rules they follow
- the tests nobody trains on: my 218 newest messages (the exam, `data/exam_his.jsonl`) and the held-out
  sets `data/reader_mid/valid_clean.jsonl`, `data/patterns_heldout.jsonl`, `data/negatives_heldout.jsonl`
- `refers` (LABELING.md) — set by `label_refers.py`, which touches no other key; progress in
  `data/refers_progress.json`. Its own test, `data/refers_heldout.jsonl`, is passed with `--exclude`
  (kept out of training AND out of validation), so it has never been looked at

- `data/tutor_heldout_draft.jsonl` (33, 2026-09-18) — the test for teaching the reader the TUTOR next
  (quiz_me / study_stats / learn_topic{topic} / stop_topic{topic}; an embedder was measured unable to,
  see HANDOFF.md). Not reader labels yet: `part` and `subject`. All 8 of my tutor messages are in it
  (`from: "his"`), so when those acts exist they are relabelled and passed with `--exclude`, never trained.

**Fix a miss by teaching its shape, never by training its sentence.** A model trained on its exam has no
exam; write new examples of the pattern, and write a new held-out set when the old one has been looked at
too often.

## The recipe behind the live model

**Since 2026-09-19 13:45 IST `jarvis-reader` is ROUND 2** — `adapters/reader_round2_b` final (overall step
6,984 = 3 epochs of `data/reader_round2`; a copy is in `adapters/current`). The recipe, the checkpoint rule
and every number are in "Round 2" below. I chose to ship it (AskUserQuestion) although it missed the 0-WRONG
bar by one reading ("look for the next holiday" → a web search), because the live router's calendar lane
takes that sentence before the reader does (calintent says calendar: true) and it beat the old model
everywhere else: exam 212 exact / 5 miss / 1 wrong vs 197 / 21 / 0. Rollback: `ollama cp jarvis-reader-prev
jarvis-reader` (the old model, bfa03cf47f33) and `adapters/reader_mid3_c2/0001400_adapters.safetensors` back
into `adapters/current`, AND the code from before 2026-09-19 (git) — TUTOR_RE is deleted and the old model
cannot read the tutor, dream acts or `refers`, so the old model under the new code has no tutor at all — then restart.

The model before it — live 2026-09-17 to 2026-09-19 — was `adapters/reader_mid3_c2` at step 1400:

```bash
./.venv/bin/python build_dataset.py --out reader_mid3 --none-share 0.5 \
  --hold data/reader_mid/valid_clean.jsonl --hold data/patterns_heldout.jsonl \
  --hold data/negatives_heldout.jsonl
./.venv/bin/python guard.py --min-free 18 --max-seconds 3600 --max-child-gb 3.5 -- \
  ./.venv/bin/python run_lora.py -c runs/bal_a.yaml --model models/Qwen3.5-0.8B-4bit --train \
  --data data/reader_mid3 --adapter-path adapters/<new-run> --fine-tune-type lora \
  --batch-size 1 --grad-accumulation-steps 4 --grad-checkpoint --learning-rate 3e-5 --iters 1400 \
  --mask-prompt --max-seq-length 256 --num-layers 16 --save-every 100 --steps-per-eval 400 \
  --steps-per-report 100 --val-batches 40
```

`runs/bal_a.yaml` sets LoRA rank 16, scale 10, dropout 0.05. That run resumed from
`adapters/reader_mid3_c/0000200_adapters.safetensors` (`--resume-adapter-file`). Batch 1 with gradient
checkpointing keeps the peak around 1.1–1.3 GB; batch 4, or no checkpointing, dropped free memory to 15%.
A first run at learning rate 1e-4 with 62% "none" examples collapsed into answering none to everything,
which is what `--none-share` is for.

## The next retrain: `refers` + missed shapes + dream mode (started 2026-09-18 22:50 IST)

Training log: `runs/train_reader_refers.log`; checkpoints in `adapters/reader_refers/`. Not live until the
checklist at the end of this section is done.

What it is for: `context.resolveInText` asks the 3B what a word stands for on every turn with history —
16.8 s of a 123 s turn on 2026-09-17. A reading that says `refers` lets JARVIS skip that call on the turns
that cannot need it. Ready: all 1,475 of my messages reviewed (82 refer), synthetic batch `refers-1` (154:
112 refer, 42 hard negatives — same-message referents, idioms, "It Takes Two", page clicks),
`data/refers_heldout.jsonl` (110: the LEANING/SELF sets of `sweeps/sweep_leaning.js` + my real references
from the log; 20 of them also sit in the older held-out sets, so report both all 110 and the 90 never
used for validation).

The same retrain carries the reader's known misses ([B]), taught by SHAPE with new sentences — never the
missed ones: batch `shapes-4` (141: which apps are running, the machine as a whole vs one named stat,
"open X and play Y", bare searches for unusual names, multi-word app names, watch/listen, slang for open,
Hinglish, look-alikes that stay `none`). The old exam has been looked at, so its fresh replacement,
`data/shapes_heldout.jsonl` (70, written BEFORE the batch and leak-checked against it), is excluded the
same way.

And dream mode (my choice, 2026-09-18: "Teach the reader"). Four acts with no fields — `dream_log`,
`dream_now`, and the setting as the polarity pair `dream_on` / `dream_off`, so the reader's own token
probabilities decide the direction the way they do for open/close (an embedder cannot: measured in
`jarvis-os/dreamintent.js`). My five dream-mode messages were relabelled (455 → dream_now; 456, 464, 481,
706 → dream_log) and batch `dream-1` (109: dream_log 22, dream_now 20, dream_on 13, dream_off 14, and 40
look-alikes that stay `none`/`play`/`sleep_display` — "tidy up my desktop", "what did I do today", other
on/off settings, human dreams, "play dreams by fleetwood mac") teaches the shape. Two tests, both excluded:
`data/dream_heldout.jsonl` (40, brand-new, written before the batch) and `data/dream_interim_sets.jsonl`
(59: `tests/test_dreamintent.js`'s HELD 36 — my own dream messages among them, so none of my five is
trained — and FRESH 23, relabelled as readings; `from` says which).

The dataset built 2026-09-18: 2,074 training rows (my 945, synthetic 1,129), 147 refer, dream_log 22,
dream_now 20, dream_on 13, dream_off 14, and 0 sentences from any of the four excluded sets.

Only when I am away, the Mac plugged in and the lid open (this run: I asked for it while at the Mac, on
battery at 71% — "dont stop anything cuz of battery"; the guard still stops it at 30%):

```bash
./.venv/bin/python build_dataset.py --out reader_refers --none-share 0.5 \
  --hold data/reader_mid/valid_clean.jsonl --hold data/patterns_heldout.jsonl \
  --hold data/negatives_heldout.jsonl --exclude data/refers_heldout.jsonl --exclude data/shapes_heldout.jsonl \
  --exclude data/dream_heldout.jsonl --exclude data/dream_interim_sets.jsonl
./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-seconds 5400 --max-child-gb 3.5 -- \
  ./.venv/bin/python run_lora.py -c runs/bal_a.yaml --model models/Qwen3.5-0.8B-4bit --train \
  --data data/reader_refers --adapter-path adapters/reader_refers --fine-tune-type lora \
  --resume-adapter-file adapters/current/adapters.safetensors \
  --batch-size 1 --grad-accumulation-steps 4 --grad-checkpoint --learning-rate 3e-5 --iters 1000 \
  --mask-prompt --max-seq-length 256 --num-layers 16 --save-every 100 --steps-per-eval 200 \
  --steps-per-report 100 --val-batches 40
```

**One epoch, in two legs.** At batch size 1 mlx_lm draws one row per iteration from one shuffle per epoch,
so the 1,000 iterations above covered 1,000 of the 2,074 rows once — 65 of the 147 `refers` rows, 3 of
the 13 `dream_on`. `rest_of_epoch.py` replays that shuffle (verified against the trainer's own "Trained
Tokens" at every report — it refuses otherwise) and writes the 1,074 unseen rows to
`data/reader_refers_b`; leg 2 resumes from leg 1's final adapter on exactly those, for 1,074 iterations,
into `adapters/reader_refers_b` (same flags, `--data data/reader_refers_b --adapter-path
adapters/reader_refers_b --resume-adapter-file adapters/reader_refers/adapters.safetensors --iters 1074`).

**Choosing the checkpoint — fixed before any test set was looked at.** The trainer's "Val loss" is
computed on a different random 40 of the 254 validation rows each time (0.053 → 0.073 → 0.090 → 0.073 →
0.086 in leg 1), so it is not used. Each candidate is graded on all three validation files with
`eval_ckpt.sh` (reading graded without `refers`); the live model's raw numbers there are 49/0/0/1,
70/9/3/4, 116/0/1/1 (exact/MISS/REFUSED/WRONG) — 6 WRONG. The end-of-epoch checkpoint is taken unless it
has more WRONG than that; otherwise the earlier checkpoint with the fewest WRONG, then the most exact.

What happened (2026-09-18 23:50): the end-of-epoch checkpoint graded 46/0/1/3, 76/2/2/6, 112/0/2/4 —
misses 10 → 2, but 13 WRONG > 6 (three at full confidence: "search for my passport scan" → a web search,
"Hi how is everything doing?" → system status, "open safari and search amazon echo dot" → searched in
Safari; and "kuch purane gaane chala do" → dream_on at 0.42). So per the rule, leg-1 400 and 1000 and leg-2
400 and 1000 were graded too.

**The bar for going live — fixed before any test set was read:** through the whole pipeline
(`sweeps/sweep_his.js`, the reader behind its checker and gates), 0 WRONG on the exam group, as the live
model has; anything else stays unshipped and is reported. The dream numbers (FRESH, my 23/23 and 13/13) are
reported for the reader alone and for the pipeline (reader, then dreamintent), not used to choose.

Then measure it ONCE on the exam, `refers_heldout`,
`shapes_heldout`, `dream_heldout` and `dream_interim_sets` — none of them trained or validated on, so they
are the honest numbers. The dream number I asked for is FRESH (the 23 rows with `from: "fresh"`): "need
23/23 and 13/13" — every row right, and all 13 dream requests acted on, with 0 look-alikes let in.
Before it goes live, in this order:
- `readmodel.js` — `refers: { type: 'boolean' }` in SCHEMA and accepted (true only) by shapeError, never
  passed to build() as a value. The dream acts in ACTS / FIELDS / SCHEMA (no fields); `dream_on` ↔
  `dream_off` as a polarity pair beside open/close (OPPOSITE, polarityOf), so an unsure direction is asked,
  never guessed; build() → `{ type: 'dream_log' }`, `{ type: 'dream_now' }`, `{ type: 'dream_set',
  enabled }` — the first two are the same signatures the interim lane keeps my yes under
  (`readmodel.confirm`), so a sentence I already confirmed stays confirmed.
- `eval_ollama.js` — `refers` in ORDER and a refers tally (caught / missed / false alarms).
- `server.js` — skip `cx.resolveInText` only when the reading is confident AND the model's own probability
  of writing `"refers"` is below a cut swept on refers_heldout (a missed reference is the dangerous error:
  it is how Brave searched for "him up"); still resolve when the reading refers, is missing, or is unsure.
  The reader's dream actions run the dream tools (describeAction gains their words for the confirm band);
  `dreamintent.js` stays as the fallback when the reading is `none` or unsure, and is retired only if the
  reader alone meets FRESH.
- Then export, `sweeps/sweep_his.js`, every suite, integrity, restart, my live test ("play …" with history;
  "search him up on brave" after asking about someone; "dream log", "dream now", "turn dream mode off"),
  and `../tools/vault.sh pack` (mine — the adapter and data changed).

## Round 2 (2026-09-19): the verdict on round 1, and what was done about it

Round 1's candidate (adapters/reader_refers_b, exported as `jarvis-reader-next`) was measured once on the
test sets: exam 204/2/3/9 raw — two readings acting wrong past the confidence gate ("is my battery okay" and
"mera laptop slow chal raha hai kyun" → system_status); `refers` caught 7/34 (exam) and 14/50
(refers_heldout); dream_heldout 27/40 with 4 of 9 on/off readings on the wrong half; shapes_heldout 64/70.
It did not meet the bar and did not go live. Two findings were label problems, fixed by rule: 1317 ("mera
laptop slow chal raha hai kyun") → system_status, like 1326 ("why is my mac so slow"); and the tutor became
reader acts (LABELING.md), my 8 tutor messages relabelled.

My instruction: keep the model that performs better, and train that again — longer is fine. The live model
performs better (0 acting wrong on the exam), so round 2 starts from `adapters/current`.

Written BEFORE the training batch, in my own texting style (lowercase, "u", "plz", "whats", Hinglish):
`data/round2_heldout.jsonl` (67, the test for the shapes round 1 missed) and `data/tutor_heldout.jsonl`
(33, the tutor's test, all 8 of my tutor messages in it) — both `--exclude`; `data/round2_valid.jsonl`
(63, new-skill VALIDATION, `--hold`, so choosing a checkpoint sees the new skills this time). Then batch
`round2-1` (254): one named stat vs the whole machine, greetings, references with and without stand-in
words, dream on/off, Hindi music requests, my files vs the web, the tutor. Dataset `data/reader_round2`:
2,328 train (my 964, synthetic 1,364), 317 validation, 195 `refers`, 0 sentences from any test or
validation file.

```bash
./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-seconds 18000 --max-child-gb 3.5 -- \
  ./.venv/bin/python run_lora.py -c runs/bal_a.yaml --model models/Qwen3.5-0.8B-4bit --train \
  --data data/reader_round2 --adapter-path adapters/reader_round2 --fine-tune-type lora \
  --resume-adapter-file adapters/current/adapters.safetensors \
  --batch-size 1 --grad-accumulation-steps 4 --grad-checkpoint --learning-rate 3e-5 --iters 6984 \
  --mask-prompt --max-seq-length 256 --num-layers 16 --save-every 200 --steps-per-eval 400 \
  --steps-per-report 100 --val-batches 40
```

Three epochs (6,984 = 3 × 2,328; mlx_lm reshuffles each epoch, so every row is seen three times).

Interrupted once, at iteration ~400 (2026-09-19 10:13): eight reader reads were run beside the training,
free memory fell to 16% and the guard stopped it — its job; no model is loaded while one trains. Resumed
from `adapters/reader_round2/0000200_adapters.safetensors` into `adapters/reader_round2_b` for the
remaining 6,784 iterations (log `runs/train_reader_round2_b.log`); overall iteration = 200 + its own.

**Choosing — fixed before training.** Candidates: 2400, 4600 (the saves nearest the ends of epochs 1 and 2)
and the final — in the resumed run, its 2200, 4400 and final. Each is graded by `eval_reader.py` on all four validation files (the three old ones and
`round2_valid.jsonl`); the one with the fewest WRONG across the four is taken, ties to the most exact. The
bar for going live is unchanged: 0 WRONG on the exam group through `sweeps/sweep_his.js`. Then, once,
`eval_ollama.js` on round2_heldout, tutor_heldout and the round-1 test sets (reported as looked-at-once).

## Measuring

```bash
./eval_ckpt.sh adapters/<run> 1400                      # one checkpoint on the held-out sets
./.venv/bin/python guard.py -- ./.venv/bin/python eval_reader.py --adapter adapters/<run>   # the exam, once
node eval_ollama.js data/exam_his.jsonl                 # the exported model, and a sweep of the gates
cd ../jarvis-os && node sweeps/sweep_his.js             # all my messages through the whole pipeline
```

Look at the exam once per candidate, at the end. Choosing between checkpoints on the exam turns it into
a validation set.

## Exporting

```bash
./export_reader.sh adapters/<run> q8_0 jarvis-reader
../tools/vault.sh pack                                  # so a restore gets this adapter, not the last one
```

`export_reader.sh` fuses the adapter into the ORIGINAL bf16 weights, then `to_hf_layout.py` puts them back
into the published layout — mlx_lm saves its own (renamed tensors, conv1d axes moved, +1 on the norms),
which Ollama cannot load ("tensor 'token_embd.weight' not found"). It checks that every tensor the adapter
did not touch still equals the original and writes the original bytes for those. Then `ollama create`
quantises to q8_0 (1.0 GB); q4_K_M was only ~10% faster and was not taken. After a successful build it
copies the adapter to `adapters/current`.

Before JARVIS uses a new model: `node eval_ollama.js data/exam_his.jsonl` for the gates, then in
`jarvis-os` `node sweeps/sweep_his.js` and every suite (`node tests/run_all.js`), then
`../security/integrity.sh` and `../security/verify.sh`, then a restart.

**A candidate goes beside the live model, never over it** (2026-09-18). Exporting straight to
`jarvis-reader` swaps the model under the running server, whose code may not know the new model's acts —
Ollama's JSON grammar then forces its answers into the old ones. So:

```bash
./export_reader.sh adapters/<run> q8_0 jarvis-reader-next      # beside the live one; adapters/current untouched
node eval_ollama.js data/<set>.jsonl jarvis-reader-next         # measured under its own name
ollama cp jarvis-reader jarvis-reader-prev                      # the live model, kept for a rollback
ollama cp jarvis-reader-next jarvis-reader && ollama rm jarvis-reader-next
cp adapters/<run>/adapters.safetensors adapters/<run>/adapter_config.json adapters/current/
```

then the code that knows the new acts, the suites, integrity, and a restart — together. Rollback:
`ollama cp jarvis-reader-prev jarvis-reader`, the previous adapter back into `adapters/current`, the
previous code (git), restart. `ollama rm jarvis-reader-prev` once I have used the new one and am happy.

## The reply-claim reader (2026-09-24) — a second, much smaller trained reader

JARVIS checks its own plain-chat reply for a claim of an action nothing ran ("Alarm set for 6 AM, Sir.").
Averaged embedder regions did that at 32/127 claims caught and 36/135 right answers flagged, because an
embedding reads TOPIC and this is a SPEECH ACT. It is now a softmax classifier over nomic embeddings — no
MLX, no GPU, zero-dependency Node, trained in about a minute on the Mac:

```bash
node build_replyclaim_data.js     # writes data/replyclaim_train.jsonl (615 rows) — shapes, never held-out items
node train_replyclaim.js          # 5-fold CV picks embedder / L2 / τ on TRAINING rows only; scores every held-out
                                  # set once; writes ../jarvis-os/replyclaim.weights.json (--dry: report only)
```

Held-out sets, each written before the round it judges (`data/replyclaim_*.json`, never staged): `heldout`
(#1), `live` (22 real blocked 3B replies from jarvisos.log), `heldout2` (#3), `heldout3` (#4), `heldout4`
(#5, the only one no round ever saw). Protocol that held: a round is judged on a set written AFTER its data
and BEFORE its training; once a set's misses have been read it stops being a judge. Round 4 (more chatty
"let me" rows) scored exactly round 3's 18/25 · 2/25 on #5 and was not kept. The ceiling of a linear reader
on an embedding is about here (85% caught, 8% flagged overall); past it needs a reader that reads language —
a `claim` read in the reader model, or the trained Bonsai. Undo: delete the weights file (falls back to the
regions).

**2026-10-10 — jarvis as a second judge (held-out #6, `data/replyclaim_heldout6.json`, 40 claim / 40 none in jarvis's own
voice, written before the run; candidate and bar in `build_replyclaim_heldout6.js`; `jarvis-os/sweeps/sweep_claimjudge.js`):
FAILS — nothing changes.** Claim reader alone (live round 3): 33/40 caught, 5/40 flagged. Reader AND jarvis judge (> 0.5):
29 caught (bar ≥ 31), 3 flagged (bar ≤ 2). jarvis alone: 35 caught but 18 flagged — it says yes to most statements. What #6
shows about round 3: it misses Hinglish claims ("Band kar diya.", "Gaana chala raha hoon.") and bare status claims ("Screen
locked.", "Copied to your clipboard."), and flags short chat ("Bet, Boss.", "Enjoy your food!", a joke, a weather line). Next:
a round-5 claim reader with those shapes — judged on a FRESH #7 (#6 is read now); going live waits for his word.

**Round 5 (2026-10-10, written before any round-5 row):** data = round 3's rows + new SHAPES for what #6 showed (Hinglish
done/acting/promised claims; bare status claims — "X is off now", "Tab closed"; short small-talk, thanks-replies, jokes and
plain facts as none). No #6 or #7 sentence is trained. Judge = FRESH #7 (`data/replyclaim_heldout7.json`, 40/40, written
before the data; round 3 on it: 33/40 caught, 5/40 flagged — its misses NOT read). **Bar:** on #7 caught ≥ 33 AND flagged ≤ 5
with at least one strictly better; on #1, LIVE, #3, #4, #5, #6 together no worse than round 3 by more than 3 caught or 2
flagged. The trainer writes `jarvis-os/replyclaim.weights.next.json` (a candidate) — the live file is replaced only on his word.

**Round 5 RESULT (2026-10-10): FAILS — nothing changes.** CV chose both embedders, λ 1e-4, τ 0.3 (704 rows). FRESH #7: 35/40
caught, 3/40 flagged (round 3: 33 / 5 — better on both). But #1, LIVE, #3, #4, #5, #6 together: 136/167 caught, 20/175 flagged
(round 3: 141 / 16; the bar allowed 138 / 18) — #3 23→19, #1 41→39 caught; #1 and #5 2→4 flagged. Counts only were printed for
#7, but it is not reused to pick a variant. Candidate weights moved to `backups/jarvis-os/replyclaim.weights.r5-failed-20261010.json`.
Live stays round 3; in chat its false flags are softened by the sampled redraft (server.js, 2026-10-10).

## The reasoning gate (2026-09-25) — a third trained reader

`jarvis-os/reasonintent.js` decides whether a turn is a question to WORK OUT (it goes to the reasoning model and
skips the action lanes). It replaced `looksLikeReasoning`'s word lists. Softmax over nomic embeddings, like the
reply-claim reader:

```bash
node build_reasongate_data.js   # data/reasongate_train.jsonl (426 rows; refuses if a held-out sentence is in it)
node train_reasongate.js        # CV picks embedder/L2/τ for ZERO look-alikes called reasoning; writes
                                # ../jarvis-os/reasongate.weights.json (--dry: report only)
```

Held-out `data/reasongate_heldout.json`, `…heldout2`, `…heldout3` (each written before the round it judged):
15/22, 23/28, 21/28 caught, 0 false alarms on all three. An embedding reads what a sentence is ABOUT, not whether
its answer can be derived from it, so this plateaus near 80%; 100% needs a read in the reader model.

A separate REAL-reasoning test lives in `data/reasoning_graded_heldout.json` (30 logic problems, grade 2 → 12,
hand-graded — the auto-check is unreliable on one-letter and yes/no answers). `jarvis-os/sweeps/sweep_reasoncmp.js`
runs it: `SET=graded FULL=1 THINK=1 MAXTOK=2048 node sweeps/sweep_reasoncmp.js <models…>`.

## Bonsai `jarvis` (2026-09-25/26) — a small 1-bit model trained for JARVIS's own jobs

Bonsai 4B (PrismML, Apache-2.0) ships as 1-bit MLX weights that need PrismML's MLX fork, which needs full Xcode.
Instead, the 1-bit weights are repacked into stock-MLX 2-bit form with the SAME q/scale/bias — bit-for-bit the
same model (checked against Ollama's GGUF by greedy decoding) — and trained with the MLX already here.

```bash
./.venv/bin/python repack_bonsai.py models/Bonsai-4B-mlx-1bit models/Bonsai-4B-mlx-2bit   # exact repack
node build_bonsai_data.js          # data/bonsai_jarvis — rows built from the LIVE prompts (systemPrompt with
                                   # `over`, REASON_EXTRA, context.standsForPrompt); reasoning answers COMPUTED
./run_bonsai_soup.sh               # 3 seeds of train_bonsai.py under guard.py, resumable; a closed lid pauses it
./after_bonsai_soup.sh             # soup_bonsai.py (exact average: A's concatenated, B's stacked /K), then
                                   # eval_bonsai.py (MLX) + eval_bonsai_ollama.js (the 3B) + score_bonsai.js
```

Things that bit, and are fixed in the scripts: `mlx_lm lora` scores every position against a 151,669-word
vocabulary (0.7 GB of logits per example — the guard stopped it), so `train_bonsai.py` scores only the reply;
guard.py's default `--max-seconds 900` would stop every run after 15 minutes (its clock is AWAKE time, so a closed
lid only freezes a run); `mlx_lm.generate()` pins the whole working set as wired memory, so `eval_bonsai.py`
disables that. Overfitting starts after ~300 steps on 254 rows (held-back loss 1.03 → 1.11 at 400).

v1 (seed 1 @300 + seeds 2, 3; `data/jarvis_heldout.json`): quiet greetings 14/14 and short; reasoning 15/16 (the 3B
11/16 — but stock Bonsai also 15/16); resolver 12 exact / 1 wrong ("Hello, Sir"); chat worse than the 3B —
"capital of japan" → "Ottawa" (a memorised row), "did u send that message" → "Yes, Sir". **Not deployed.** v2:
~5× data, stock Bonsai's own answers mixed in against forgetting, honesty rows, Hinglish, a fresh held-out set.
Deploying needs a GGUF LoRA adapter on the Q1_0 base and a Modelfile TEMPLATE matching the training text (Qwen3,
thinking off) — Ollama ≤ 0.33.x, since 0.34.1 removed adapter creation.


### jarvis v2 (2026-09-29) — data, and the rule for choosing, written before training

**Held-out first:** `data/jarvis_heldout_v2.json` — 104 new items (greet 20 incl. 6 attention, caps 12 with the CURRENT
truth, chat 48: feelings, EN/Hinglish banter, honesty "did u X", statements that must claim nothing, knowledge with
answer words, opinions, acks; reasoning 12 computed; resolver 12 incl. NONE after small talk). 0 overlap with the stress
set, v1's held-out, my messages, synth or v1 training (23 first-draft lines rewritten until none matched).

**Training data:** `build_bonsai_data_v2.js` → `data/bonsai_jarvis_v2` (880 train / 56 valid): greetings 84 + attention
58, caps 66, banter 73, feelings 53, honesty 65 (no record / yes when the history shows it / not yet when it waits for
approval), statements 78, acks 57 (never "done", no invented alarm times), opinions 27, reasoning 150 computed, resolver
39 + NONE-after-small-talk 47, and **139 of stock Bonsai's own answers** (`gen_bonsai_stock.js`, 227 general questions,
3–5 plain sentences; every one read by hand — 88 dropped for wrong facts: sports rules, cooking, some science, and almost
all Hinglish answers, which were garbled — `data/bonsai_v2_stock_review.json`). Rows that land on any held-out sentence
are dropped and named (93). External chat sets (PersonaChat, Hinglish Everyday) were NOT used as replies: they are people
describing their own lives ("mujhe chai chahiye") — the opposite of the honesty this model needs.

Also fixed on the way: the live system prompt still said a WhatsApp send "tells the user to tap Send" — since ea0f435
JARVIS presses Send itself after approval; both prompt copies now say so.

**Run:** `run_bonsai_v2.sh` — one seed, 1,000 steps (~1 epoch, ~6–7 h awake), under guard.py (pauses, not stops),
resumable. **Choosing, fixed before training:** the save at a multiple of 100 steps with the lowest held-back error is
the candidate; it is judged on `jarvis_heldout_v2.json` against the 3B — at least as good on every section, 0 false
claims, at least as fast on his Mac — before anything is exported; then his live test.

### jarvis v2 result and v3 (2026-09-30)

**v2 (step 900, lowest held-back 0.68; step 1000 0.82 = overfitting) vs the 3B on `jarvis_heldout_v2.json`, hand-graded
(`runs/bonsai_v2_verdict.md`): not a replacement.** Won honesty 5/6 vs 1, attention 5/6 vs 0, caps 9 vs 6, statements 5 vs
2, reasoning 11 vs 9, false claims 1 vs ~7. Lost feelings 1/7 vs 7 (collapsed onto "I am here. What is going on?"),
banter 4/13 vs 8 (echoes), quiet greetings 9 vs 11, knowledge 6 vs 8, resolver 2 WRONG vs 0. Cause: tiny, repeated
hand-written reply sets.

**v3:** fresh held-out `data/jarvis_heldout_v3.json` (75, 0 overlap incl. v2's held-out and v2 training) — v2's was read
reply by reply while grading. `build_bonsai_data_v3.js` = v2's builder with greetings, banter and feelings rewritten
(many replies per input, two rows per input with two different replies, feelings always with a suggestion, questions to
JARVIS answered not echoed) and resolver rows for "his <work>" → the person, "their site" → the company, NONE when "him"
could be several → `data/bonsai_jarvis_v3` 1,132 / 72. `run_bonsai_v3.sh`: learning rate 5e-5 (v2 jumped twice at 1e-4),
1,300 steps. **Choosing, fixed before training:** the 100-step save with the lowest held-back error, then judged on
`jarvis_heldout_v3.json` against the 3B — every section at least as good, 0 false claims, 0 resolver WRONG, at least as
fast (speed on the Ollama build).

### jarvis v3 result and v3.1 (2026-10-01)

**v3 (step 1000, held-back 1.0546) vs the 3B on `jarvis_heldout_v3.json`, hand-graded (`runs/bonsai_v3_verdict.md`):
fails the bar.** Won quiet greetings 9/12 vs 6, attention 2/4 vs 0, caps 6/8 vs 4, honesty 3/4 vs 2, resolver 8/0/0 vs
6/2/0; feelings tied 6/7 (v2 had 1). Lost reasoning 6/8 vs 8 (days vs weeks, a pace question), banter 4/10 vs 5 (dodged
"kuch bol na", wrong facts for "tell me something interesting"), and 3 false statements ("open maps" → "Opening
Safari.", "I will add an alarm for 7", "I never open a browser without your OK") + a false "no" on screenshots.
Steps 1200/1300 (1.54/1.55) were hurt by a resume that restarted Adam from zero — fixed: `train_bonsai.py` now saves the
optimiser beside every save and loads it on resume (tested bit-exact against an uninterrupted run).

**v3.1, his call ("do v3.1 and then grade"), and his rule: very diverse.** Fresh held-out written FIRST:
`data/jarvis_heldout_v31.json` (82; 0 overlap with every training row and every earlier held-out; more items where v3
failed, every section present). `build_bonsai_data_v31.js` + `data/v31_parts/patch.js` → `data/bonsai_jarvis_v31`:
patch 893 train / 57 valid (content-asking banter answered with hand-checked facts and jokes, "how are u" / "wyd later"
answered, wake/home/sleep greetings, disk and agent-down attention, capability truth on screenshots/alarms/chats/DND,
acks naming the asked-for app across 45 apps, alarm requests → honest reminder, vague "did u do it" → the record, more
feelings, 220 computed unit/rate problems) + a seeded replay of 600 of v3's training rows; validation = v3's 72 + the
patch's 57. Diversity printed per kind; no reply may exceed 3% of its kind or 3 rows (excess rows dropped: 24). v3's 3
rows of "Nothing that needs you. What is on your mind?" dropped. `run_bonsai_v31.sh`: starts from
`adapters/bonsai_v3_s1/0001000_adapters.safetensors` (`--init-from`), learning rate 5e-5 with a 50-step warm-up (a fresh
optimiser must not take full-size first steps), 1,500 steps (~1 epoch), held-back check every 100.
**Choosing, fixed before training:** the 100-step save with the lowest held-back error, then judged on
`jarvis_heldout_v31.json` against the 3B — every section at least as good, 0 false claims, 0 resolver WRONG — and, only if
that passes, the GGUF build is made and must be at least as fast as the 3B before his live test.

### jarvis v3.1 result and v4 (2026-10-02)

**v3.1 (step 1500, held-back 0.9578) vs the 3B on `jarvis_heldout_v31.json`, hand-graded (`runs/bonsai_v31_verdict.md`):
fails the strict bar, best yet.** 0 false "done" claims (3B ~8); better on 6 sections, tied 4, behind 3 (1 resolver WRONG,
knowledge 3 vs 4, statements 2 vs 3). Split held-back: v3's rows 1.05 → 0.94, new rows 1.90 → 0.98 — nothing forgotten.

**v4, his call: "go for v4 and add the material … which v3.1 failed at".** One model for chat AND web actions.
- The web agent's contract is `jarvis-os/webagent.js` — the system prompt, the action grammar (click/type/select/go/scroll/
  back/done/ask), the parser and the page EXCERPT policy — shared by training and the live agent; pages are `snapshot.js`
  outlines (live Brave and background pages give identical text).
- Fresh held-outs written FIRST: `data/jarvis_heldout_v4.json` (68 chat, every section, extra items on v3.1's misses) and
  `data/v4_web_heldout.jsonl` (Mind2Web's OWN test splits — unseen websites and unseen domains; never trained).
- Data (`build_v4_web.js`, `build_bonsai_data_v4.js`): Mind2Web train steps (CC BY 4.0) as excerpt → one action, up to 2
  steps a task, 6% of TASKS held back for validation; MolmoWeb (ODC-BY) start rows (high-level task on a blank page → go
  "<site>"), seeded 350; a chat patch for v3.1's misses (`data/v4_parts/chat_patch.js`: NONE when "him/it" could be several,
  capability truths incl. the new web tools, Hinglish listen/back greetings, statements about others, things he did himself,
  Hinglish honesty, short checked facts, minutes→hours); a seeded replay of 700 v3.1 rows. Diversity printed per kind.
- Built 2026-10-02: `data/bonsai_jarvis_v4` train 2,760 (chat patch 323, Mind2Web 1,486 steps from 73 websites — click 1,201 /
  type 235 / select 50 — MolmoWeb starts 350, v3.1 replay 700; 99 web rows over 1,550 tokens dropped by `fit_rows.py`), valid 140
  (v3.1 60, patch 21, web 59). Web held-out: 83 steps (unseen websites 52, unseen domains 31).
- Training: `run_bonsai_v4.sh`, from `adapters/bonsai_v31_s1/0001500_adapters.safetensors`, lr 5e-5, 50-step warm-up, 2,760
  steps (1 epoch), held-back check every 300 steps and at the end.
**Choosing, fixed before training:** the checked save with the lowest held-back error. Then judged on the fresh held-outs
against the 3B (and v3.1 for chat):
  - chat: every section at least as good as the 3B, 0 false "done" claims, 0 resolver WRONG — and no section more than one
    item worse than v3.1 (no regression);
  - web: step success (right control + right action + right text) at least 10 points above the 3B given the same prompt,
    and at most 5% replies outside the action grammar;
  - only if both pass: the GGUF build, at least as fast as the 3B, then his live test.

### jarvis v4 result and v4.1 (2026-10-04) — written before any v4.1 training row

**v4 (step 2700, held-back 0.7023) on the fresh held-outs (`runs/bonsai_v4_verdict.md`): web PASSES, chat FAILS.** Web
step success 31.3% vs the 3B 14.5%, 0 invalid. Chat beats the 3B on 7 sections with 0 false "done" claims, but loses
feelings 4/5, banter 4/5, knowledge 3/5 ("capital of Australia → Sydney", "plants give out carbon dioxide") and has
1 resolver WRONG. Causes from the data: 54 of 2,760 rows carried general knowledge; the resolver patch was 51 NONE to
17 named; Hinglish inputs were few and each kind's Hinglish shared one reply pool, so v4 answered Hinglish questions
with greeting replies ("tu kaun hai waise" → "Mast. Aapke yahan kya scene hai?").

**v4.1, his call (2026-10-04): keep the web, fix knowledge, resolver balance, feelings and banter.**
- Fresh held-outs written FIRST: `data/jarvis_heldout_v41.json` (106: greet 16, caps 10, feelings 10, banter 12,
  honesty 5, statements 5, knowledge 16, opinions 3, acks 6, reasoning 8, resolver 15 = 7 NONE / 8 named, incl. two
  same-conversation pairs where "his" is NONE but "their" is the company; Hinglish in every kind) and
  `data/v41_web_heldout.jsonl` (`build_v41_web_heldout.js`: 99 steps, 41 websites, Mind2Web test splits, new seed, no
  task from v4's web held-out). Every chat item checked against every training row, every earlier held-out, the stress
  set and his messages (exact + near matches rewritten; 50 rewritten).
- Knowledge = STOCK Bonsai's own answers (self-distillation), not mine: ~400 new general questions over many topics,
  asked with no system prompt, thinking off, temperature 0, for one or two plain sentences; every answer read by hand;
  a WRONG answer drops the question — never replaced with my answer (v1 memorised single facts and misfired: "capital
  of japan" → "Ottawa"; v4's short-fact rows may have done it again). The training row puts his question under the live
  system prompt. Before training, stock Bonsai answers the 16 held-out knowledge items too (measurement only): if the
  base does not know them, training cannot fix it, and that is reported as a ceiling.
- Resolver ≈ 1:1 NONE vs named, as same-conversation contrast pairs ("his" after two founders → NONE, "their" → the
  company; "it" after one product → the product; after two → NONE), Hinglish requests, small talk → NONE.
- Feelings, banter, identity, jokes: wider pools, two different replies per input, and Hinglish inputs in EVERY kind
  (feelings, honesty, identity, jokes, facts) so the language is not a cue for one kind's replies.
- Replays (seeded): 600 chat rows from v4's training (its patch + v3.1 replay) and 700 web rows from v4's training
  (Mind2Web steps + MolmoWeb starts in v4's proportion). Not a full second pass over the web: v4's held-back web error was
  already 0.43, a second epoch costs ~10 h more, and the web bar below catches any loss.
- Diversity printed per kind; no reply over 3% of its kind or 3 rows; rows matching any held-out sentence dropped and named.
- Knowledge review done (`data/v41_knowledge_review.json`, every answer read): of 388, keep 262, cut 52 (the wrong tail cut
  off; the kept text is a prefix of Bonsai's own answer), drop 74 — Indian GK, sports rules, arts attributions and numbers
  inside longer answers were often wrong. Bonsai said "I don't know" 3 times. It does not know when it does not know.
- **Answering from a source (his idea, 2026-10-04: "let bonsai search online for answers it doesnt know").** Because the
  model cannot tell when it is wrong, the lane is JARVIS's: fetch a source for a factual question, the model answers
  from it or says the source does not say. Contract: `jarvis-os/grounded.js` (the user message; source = the top Wikipedia
  hit's lead summary + the top 3 search snippets — the snippet often holds what the lead leaves out). Not wired yet;
  which questions get a source must be decided semantically (no word lists), and the live lane needs a search-query step
  (raw questions hit wrong pages: "who wrote the discovery of india" → Warner Bros. Discovery; Hinglish finds nothing).
  - Held-out written FIRST: `data/v41_grounded_heldout.json` (`build_grounded_heldout_v41.js`): 23 fresh questions with
    sources fetched live and frozen — 13 the source answers (two traps: the lead is about a different "Four Seasons" /
    "Malgudi Days", the answer sits in a snippet), 10 it does not (5 deliberately wrong pages, 5 real searches that missed).
  - Rows (`gen_grounded_v41.js`, `wikifetch.js`: 2.5 s between calls, cached): the 388 knowledge questions with their live
    sources; STOCK Bonsai answers from the source; every answer read by hand. Kept when the source holds the answer and
    the reply takes it from there; when the source does not hold it, the reply is an honest "the source does not say"
    (never my answer to the question); plus wrong-page rows (a question paired with another topic's source → declines).
    Hinglish wordings reuse the English source.
- Grounded review done (`data/v41_grounded_review.json`, every reply read against its source): of 387 with a source, keep
  193 (incl. Bonsai's own correct "the source does not say"), cut 73, decline 83, drop 38. When the search hits the right
  page Bonsai answers well from it; on a wrong page it mostly answers from memory or about the neighbouring topic.
- Built 2026-10-04 (`build_bonsai_data_v41.js`, `run_bonsai_v41.sh`): `data/bonsai_jarvis_v41` train 2,487 = new 1,187
  (knowledge 347, grounded 296, grounded declines 99, resolver 116 NONE : 116 named, feelings 108, banter 54, jokes 26,
  fun facts 18, identity 24, honesty 31, statements 28) + web replay 700 + chat replay 600; valid 216 (v4's 140 + new 76).
  20 rows dropped for matching held-out sentences, 39 over the per-reply cap; 0 rows over 1,550 tokens.
- Training: from `adapters/bonsai_v4_s1/0002700_adapters.safetensors` (`--init-from`), lr 5e-5, 50-step warm-up, one pass
  (2,487 steps), held-back check every 300 steps and at the end; validation = v4's 140 + 6% of the new patch.
**Choosing, fixed before training:** the checked save with the lowest held-back error. Judged on the v4.1 held-outs
against the 3B and v4:
  - grounded (`v41_grounded_heldout.json`, same prompt for every model, hand-graded): answers right from the source at
    least as many as the 3B, declines (says the source does not say, presents no answer as from it) at least as many as
    the 3B, and 0 replies that contradict their source;
  - chat (hand-graded, every reply read): every section at least as good as the 3B, 0 false "done" claims, 0 resolver
    WRONG, and no section more than one item worse than v4;
  - web (`score_web.js` on `v41_web_heldout.jsonl`): step success at least 10 points above the 3B, at most 5% replies
    outside the grammar, and no more than 3 points below v4;
  - only if both pass: the GGUF build, at least as fast as the 3B on his Mac, then his live test.

**v4.1 result (2026-10-05, `runs/bonsai_v41_verdict.md`): web passes, chat and grounded fail — not deployed.** Pick step 2100
(held-back 0.6789; it rose after 2100 — 2400 0.7124, 2487 0.7166). Web 36.4% vs 3B 12.1%, 0 invalid, 1 point under v4. Chat: best
knowledge (15/16 vs 3B 14) and resolver (15/0/0 vs 12/3/0) of any JARVIS model, 0 false "done" claims (3B ~7), caps/acks/honesty/
banter above the 3B — but below it on quiet greetings 8/10, feelings 5/9, statements 2/3 (and statements 2 under v4): short
Hinglish inputs still cross-wire onto replay replies ("Badhiya", "Good morning", "Welcome home"). Grounded: declines right 9/10
(3B 7), answers right 10/13 (3B 13) — it over-declines when the answer sits only in a snippet.

### jarvis v4.2 — "the masters" (2026-10-05), written before any v4.2 training row

**His call:** "include EVERYTHING it failed on + other stuff so this can be the grand FINAL … go thru ur entire training scripts
and enhance every drop of it." Each round so far gained 2–3% and lost somewhere else. Why, from an audit of the whole pipeline:
1. **Patches on patches.** Every round = a small new patch + a RANDOM replay of older rows. The replay carries the old rows'
   flaws forward (v4.1's "Badhiya" / "Good morning" / "Welcome home" for Hinglish feelings came from v3.1/v4 replay rows).
2. **One clock per round.** The system prompt says "Now <weekday, date> at <time>. Weather …" (server.js nowText + live
   weather); every row of a round was built in the same minute, so the model never learned time of day — and every eval
   prompt showed one time too (v4.1's: 10:49 AM, so "shaam ho gayi jarvis" → "Good morning."). With a weather line in every
   prompt it also learned it always knows the weather ("weather with no wifi?" → "yes", v4 and v4.1).
3. **Noisy training.** One row per update (batch 1, no accumulation: training error swings 0.12 ↔ 0.9 step to step) and a
   constant learning rate after warm-up (the end never settles: v4.1's held-back rose after step 2100).
4. **Noisy choosing.** The held-back error is a plain row average, dominated by long web rows; a save that is better at
   feelings can lose to one slightly better at web. And sections of 4–5 held-out items decided pass/fail by one reply.

**Fixes:**
- Held-outs written FIRST, bigger: `data/jarvis_heldout_v42.json` (169: feelings 20, quiet greetings 20, attention 8, caps 14,
  banter 16, honesty 10, statements 12, knowledge 20, opinions 5, acks 12, reasoning 12, resolver 20 = 10 NONE / 10 named;
  Hinglish in every kind; every item has its own clock `now`, weather fixed or absent) — checked against every training row,
  every earlier held-out, the stress set and his messages (61 rewritten); `data/v42_web_heldout.jsonl` (89 fresh Mind2Web test
  steps, no task from the v4 or v4.1 web sets); `data/v42_grounded_heldout.json` (27 frozen sources: 15 answerable incl. sense
  traps — the top page is a film / TV series / other sense and the answer sits in a snippet — and 12 where the source does
  not say, decline pages checked for answer leaks). Eval prompts: `build_bonsai_eval.js` now shows each item's own clock
  (`promptclock.js`); older held-outs render as before.
- `promptclock.js`: each training row gets its own clock and weather (20% none = offline); greeting replies follow the clock.
- Trainer (`train_bonsai.py`, new flags, old runs unchanged): `--grad-accum` (several rows per update), `--schedule cosine`
  (decay to a floor after warm-up), `--neftune` (noise on the input embeddings during training only — a published fix for
  templated, memorised replies), per-kind held-back error with a MACRO average (every kind counts the same) for choosing,
  `--val-max-per-kind` (faster checks), `--num-layers` decided by a timing test (LoRA on more than the top 16 of 36 layers if
  affordable; new layers start at zero, so the run starts exactly at v4.1).
- Data: ONE curated set instead of patch + random replay. Every chat kind rebuilt with per-input replies (several fitting
  replies per input, Hinglish contrast pairs such as "aa gaya" greeting / "kho gaya" bad news / "chala gaya kya" honesty),
  his own real chat messages as inputs, the truths that kept failing (weather/music need the internet, alarm → reminder that
  will not ring, "band kar" = close), varied clocks. Kept from v4.1 (they passed): stock Bonsai's own knowledge answers,
  grounded rows (+ snippet-only and sense-trap rows, fewer declines), the resolver rows, web replay. No random replay of
  older hand-template chat rows.
- Starts from `adapters/bonsai_v41_s1/0002100_adapters.safetensors` (v4.1's pick).
- Built 2026-10-05 (`build_bonsai_data_v42.js`; parts `data/v42_parts/{feelings,greetings,core,banter,reasoning}.js`;
  grounded sense traps `data/v42_grounded_questions.json` → `v42_grounded_answers.jsonl`, review `v42_grounded_review.json`:
  keep 53 / cut 15 / decline 3 / drop 11 — on film/series pages Bonsai often answered the FILM's credits or declined although a
  snippet held the answer; those were dropped, not trained): `data/bonsai_jarvis_v42` train 2,760 = curated 2,310 (feelings 236,
  greetings 176, attention 72, honesty 98, statements 100, acks 201, caps 94, banter 135, his own messages 136, knowledge 347,
  grounded 429 incl. 54 snippet-only answers twice, grounded declines 44 (≈20% of grounded vs v4.1's 31%), resolver 119 named /
  113 NONE, reasoning 160) + web 450; 2,145 distinct clocks; valid 209 (6% of each kind, v4's 59 web rows). 0 rows over 1,550 tokens.
- Trainer settings (`run_bonsai_v42.sh`): 690 updates × 4 rows (one pass), peak lr 1e-4 (batch 4 moves each row's pull to a
  quarter, so 2× v4.1's 5e-5) with a 20-update warm-up and cosine decay to 1e-5, NEFTune 5, held-back check every 100 updates
  and at the end on ≤ 8 rows a kind, LoRA rank 8 on the top 16 layers — a 24-layer timing test cost +26% per row (20.8 → 26.3 s).
**Choosing, fixed before training:** the checked save with the lowest MACRO-averaged held-back error (mean over kinds of
each kind's mean). Judged on the v4.2 held-outs against the 3B and v4.1:
  - chat (hand-graded, every reply read): every section at least as good as the 3B, 0 false "done" claims, 0 resolver WRONG,
    and no section more than one item worse than v4.1;
  - web (`score_web.js`, `v42_web_heldout.jsonl`): step success ≥ 3B + 10 points, ≤ 5% replies outside the grammar, no more
    than 3 points below v4.1;
  - grounded (hand-graded): answers right from the source ≥ the 3B, declines ≥ the 3B, 0 replies contradicting their source;
  - only if all pass: the GGUF build, at least as fast as the 3B on his Mac, then his live test.

**v4.2 result (2026-10-08, every reply read — `runs/bonsai_v42_verdict.md`, grades in `runs/bonsai_v42_grades.json`):**
picked update 690 (macro held-back 0.9060, from 1.3754). **Web passes** (36.0% vs the 3B's 13.5%, 0 invalid, 1.1 under
v4.1). **Chat fails:** under the 3B on feelings (14 vs 15 of 20), knowledge (12 vs 18) and statements (9 vs 11), plus one
false "done" claim ("tune screenshot le liya?" → "Yes, Boss."); above it on greetings (20 vs 17), attention (8 vs 0),
capabilities (11 vs 7), banter, honesty, acks (10 vs 3), reasoning and the resolver (18/2/0 vs 12/7/1); nothing more than
one item under v4.1. **Grounded fails** on one contradiction ("Percy Bysshe Shelley wrote Frankenstein" against a source
calling that a fringe theory); answers tie the 3B (13/15), declines beat it (9 vs 5 of 12). Not deployed. The knowledge
misses are the base model's (6 of 8 identical to v4.1) — more LoRA rows of Bonsai's own answers cannot add facts it lacks;
the remaining chat gap is Hinglish short emotional inputs cross-wiring onto other kinds' templates (English feelings 10/10,
Hinglish 4/10).

**v4.2 live (2026-10-08, his call: "wire up the v4.2 to main jarvis … give wikipedia access to v4.2").** Deployed
despite the failed chat/grounded bars, on his decision, with the verdict's weak spots known (Hinglish feelings,
knowledge from memory, one false "Yes"). How:
- `export_lora_gguf.py` writes the MLX adapter as a llama.cpp GGUF LoRA (A = lora_aᵀ, B = lora_bᵀ, alpha = scale × rank
  = 160; qwen3 tensor names) → `Modelfile.jarvis` (Bonsai-4B Q1_0 + the adapter, the training template: Qwen3 chat with
  an empty think block — Bonsai's own Ollama template opens `<think>` — temperature 0 as graded) → `ollama create
  jarvis` (601 MB). Checked against the graded MLX replies on 36 rendered held-out prompts (chat, caps, greetings,
  reasoning, resolver, grounded): 35 identical, 1 different (better). Warm median 1.3 s a chat reply (3B in the eval:
  3.7 s); 3–6 s with a Wikipedia source.
- `.env` `JARVIS_CHAT_REPLY_MODEL=jarvis`: the plain-chat reply only (the slot made for Bonsai on 2026-09-24); the
  reader, resolver, agent, research and reasoning paths are unchanged.
- **The Wikipedia lane** (`server.js` groundedAnswer, `jarvis-os/grounded.js`): a question `webintent.needsWeb` already
  sends to the web first gets the top Wikipedia page's lead + the top three search snippets in the trained contract
  format, and jarvis answers from it. `grounded.supported()` keeps the reply only if every capitalised word and number
  in it (sentence openers aside) is printed in the source and at least one is not already in the question — shape,
  not a word list. Anything else goes on to `doResearch` exactly as before. On the 27 frozen v4.2 sources (already read
  while grading, so not a fresh test): all 13 right answers kept; all 12 "the source does not say" replies and both
  memory answers ("Marie Curie discovered X-rays", "Aamir Khan directed Lagaan") sent on; still kept wrongly:
  "Percy Bysshe Shelley wrote Frankenstein" (names the page does print) and "Clara Barton founded the American Red
  Cross" (true, but the American branch). Seven fresh questions: Bram Stoker, Larry Fink (BlackRock CEO), Gangtok,
  Alexander Fleming, India (2011 World Cup) answered right in 4–6 s warm; "hawa mahal kisne banwaya" (search found a
  song list) and "how tall is mount everest" (found "Mount Everest in 2018") declined and went on to research.
- Tests: `tests/run_all.js` 33 suites, 2,789 assertions, all green, before the restart.

**The answer check, redone by meaning (2026-10-08) — written before any candidate was built or measured.**
`grounded.supported()` decides what a reply asserts by capital letters, splits sentences at punctuation and sets each
sentence's first word aside: spelling, not meaning — his rule #1 forbids it (his 2026-09-24 ruling on capitals), and I
had mislabelled it "shape". It stays live until a replacement passes the bar below.
- **Fresh held-out:** `data/v42_check_heldout.json` (`build_check_heldout_v42.js`): 114 questions, 0 exact overlap with
  every question in `finetune/data` (held-outs, training question files, every Bonsai training/valid row, his messages,
  the stress set) and with the seven live questions of 10-08 (`check_heldout_overlap.js`; every shared rare word read by
  hand, subject repeats swapped out). Mixed: answerable from the lead, only from a snippet, not in the source, wrong-sense
  pages (film / series / island / animal), Hinglish searched raw as the live lane does, contested pages stating a fringe or
  disputed claim, and 20 searches that landed on the wrong page. Sources fetched exactly like `server.js` `wikiSource()`
  and frozen.
- **Replies:** `gen_check_replies_v42.js` → `runs/v42_check_replies.jsonl`: model `jarvis` through Ollama, think off,
  temperature 0, the live system prompt (saved beside the run), the `grounded.js` contract message, the live num_ctx /
  num_predict.
- **Labels, by hand, every reply read against its source, BEFORE any candidate is scored:** `runs/v42_check_labels.json`
  — `right` (answers the question, and the source states it), `decline` (says the source does not answer), `memory` (an
  answer the source does not state, true or not), `contra` (the source states something else). A reply the source backs
  but in the wrong sense of the question is labelled and reported, and counts with `memory`.
- **Candidates — every one judges by meaning; no word list, no regex over language, no capital-letter or punctuation
  signal:**
  (a) a decline region: `intent.makeClassifier` over the whole reply; exemplars written from the training declines
  (`data/bonsai_jarvis_v42`) and the 27 v4.2 replies, never from the fresh set; `replyhedge.saysGoLookItUp()` measured
  as it is, for comparison;
  (b) support by embedding: the highest cosine between the reply and fixed-length word windows of the source
  (nomic-embed-text and all-minilm);
  (c) a yes/no judgement by jarvis itself, asked as the next turn of the same conversation (the answer prompt is still in
  Ollama's cache, so only the short question is new): the first answer token's probabilities for the two answers the
  prompt itself names, as readmodel.js reads open/close — the larger one wins, no threshold;
  (d) combinations: (a) sends declines on, then (b) or (c) judges support.
  Any threshold (a's margin, b's cosine) is chosen on one half of the fresh set (even / odd items) and reported on the
  other half, both ways; the shipped value is the mean of the two halves' choices.
- **Bar to ship, on the fresh set:** kept `right` ≥ the old check's; sent on `decline` ≥ the old check's; sent on
  `memory` + `contra` ≥ the old check's; added median time ≤ 1.5 s warm on his Mac with his browser open. Ties: fewer
  wrong replies kept, then more right ones kept, then faster. If nothing passes, the old check stays and the numbers are
  reported to him.

**Result (2026-10-08, `jarvis-os/sweeps/sweep_answercheck.js`, logs `runs/sweep_answercheck_fresh*.log`).** Labels: 59
right, 38 declines, 17 to send on (7 contradict the source, 7 backed but not an answer, 3 from memory). The dev set (the
27 v4.2 sources, `--dev`) was used only to settle the judge's wording before the fresh set was run once. Fresh set:

| candidate | right kept /59 | declines sent /38 | wrong sent /17 | added time |
|---|---|---|---|---|
| old `supported()` (capitals) | 53 | 35 | 4 | — |
| `replyhedge.saysGoLookItUp()` as the decline test | 54 | **0** | 0 | — |
| (a) decline region, all-minilm, halves | 52 | 36 | 5 | — |
| (a) decline region, nomic, margin 0 (no tuning) | **59** | **38** | 0 | 0.56 s |
| (a) decline region, nomic, halves | 53 | 38 | 5 | 0.56 s |
| (b) embedding support, all-minilm, halves | 50 | 38 | 3 | — |
| (b) embedding support, nomic, halves | 55 | 36 | 2 | — |
| (c) judge as a follow-up: "check your reply" | 59 | 38 | 3 | ~0.6 s* |
| (c) follow-up, second question turn (chosen on dev) | 58 | 38 | 3 | 0.59 s |
| (c) follow-up after the reply turn | 59 | 12 | 4 | 0.63 s |
| (c) standalone, no system prompt: "does the source state this?" | 55 | 37 | 8 | 2.7 s |
| (c) standalone with the question | 51 | 38 | 7 | 2.9 s |
| (d) region (halves) + "check your reply" | 53 | 38 | 6 | ~1.2 s |
| (d) region (halves) + second question turn | 52 | 38 | 6 | 1.2 s |
| (d) region (halves) + standalone | 50 | 38 | 10 | 3.3 s |
| **(d) region (halves) + follow-up after the reply turn** | **53** | **38** | **7** | **1.2 s** |

"halves" = threshold chosen on the even items and scored on the odd ones, and the other way round, summed. *timed without
a warm cache in the sweep; the same shape as the row two below. **Shipped: (d) with the follow-up after the reply turn** —
the rows that meet every count of the bar are the nomic region alone (halves: 53 / 38 / 5), the (d) rows with the
"check your reply" judge (53 / 38 / 6) and with this one (53 / 38 / 7), and the standalone judge (55 / 37 / 8), which
fails the time bar; the tie-break (fewer wrong kept) picks this one. Added time measured on 23 items as
the lane runs it (answer first, judge on the warm cache, region only when the judge says yes): median 1.2 s (judge 0.64,
region 0.56), 65% memory free, on battery. Region margin −0.035 (the halves chose −0.030 and −0.040).
**Honest limits:** (1) it was picked from 16 rows measured on the same 114, so its numbers flatter it — his live test is
the confirmation; (2) it still keeps 9 of 17 wrong replies — mostly wrong answers built from the page's own words
("The capital of Tanzania is Dar es Salaam", "The Ashoka Chakra has 14 spokes", "Neptune is the largest planet") and true
lines that do not answer ("William Shakespeare wrote King Lear" for Macbeth); the old check kept 13; (3) a jarvis that
answers wrongly also judges wrongly — the follow-up judges catch 3–4 of 17 on their own. The fix for (2)/(3) is a better
judge (a model that did not write the answer, or one trained on these contrast cases), not more tuning on this set.
Also found: raw Hinglish questions find no Wikipedia page at all for 11 of 15 (search needs every word) and junk for 4
(a list of Asha Bhosle songs) — the query-rewrite item in the backlog.
The shipped functions (`grounded.checkMessages` / `checkVerdict` / `declines`, sweep mode `shipped`) reproduce the sweep
on all 114 at −0.035: 54 / 38 / 8 (the same items). On the 27 dev sources: 11 / 13 right kept (old 13 — it now sends
"Bram Stoker wrote Dracula." and "Carlo Collodi wrote Pinocchio." on to research: slower, not wrong), 10 / 10 declines,
3 / 4 wrong sent on (old 2 — "Percy Bysshe Shelley wrote Frankenstein" and "Aamir Khan directed Lagaan" are now caught;
Clara Barton still kept).
- Live since the 21:57 IST restart (tests 34 suites / 2,811 assertions green; integrity re-baselined, 273 files). Smoke
  test through `J._groundedAnswer` (3 new questions): kept "…designed by Jørn Utzon, son of architect Jørn Utzon"
  (garbled clause kept); sent on two right short answers — "The human body typically has 206 bones." (region −0.034,
  0.001 past the cut) and "Jimmy Wales and Larry Sanger founded Wikipedia." (+0.023: the region misreads it as a decline
  at any threshold). Sending on is the safe failure (research answers with sources, ~25 s), but it is a cost.
- EXPLORATORY, not pre-registered, so not shipped: both follow-up judges and no embedder (second-turn question AND the
  after-reply question, both on the warm cache, ~1.2 s) scores 58 / 38 / 4 on the fresh set — the old check's 4 wrong
  caught, 5 more right kept than the shipped check, no Hinglish or short-answer weakness. Needs a fresh confirmation set
  before it could replace the shipped check.
- Undo: `cp -p backups/jarvis-os/grounded.js.bak-answercheck-20261008-211812 jarvis-os/grounded.js`, the same for
  `server.js.bak-answercheck-20261008-211812`, `bash security/integrity.sh`, restart; or blank `JARVIS_CHAT_REPLY_MODEL`
  to switch the whole lane off.

**The two punctuation splitters (2026-10-08, his "test if this is needed") — measured, not needed, both replaced.**
`grounded.clip()` cut long text back to the last ". " / "? " / "! "; `replyhedge.saysGoLookItUp()` split replies into
sentences at . ! ?. `jarvis-os/sweeps/sweep_clip.js`: on the 141 answer-check sources the sentence cut and a plain word
cut (" …", as the snippets already end) differ on 25; jarvis re-answered those 25 from the word cut — 15 identical, 7
equally right/wrong, 2 better, 1 worse. `sweeps/sweep_hedgesplit.js`: over 2,205 distinct real replies on disk, the first
and last two 16-word windows catch every real hedge the sentence split catches (the suite's 5, the 2 it was built for, ~4
in the pool) and fire falsely on 52 of the 159 replies where the methods disagree against the split's 74 (every window:
92; the whole reply in one piece misses the BlackRock case). Live since the 22:16 IST restart.

**Round 2 of the answer check (2026-10-08, his "try to get the best") — written before any round-2 candidate was run.**
- Set 1 (`data/v42_check_heldout.json`, 114) has been read and chosen on, so it is now the TUNING set: rebuilt with the
  word-cut clip (20 of its sources change; replies `runs/v42_check_replies_r2.jsonl` = the round-1 replies with those 20
  re-answered by `sweep_clip.js` (10 replies change); labels `runs/v42_check_labels_r2.json` — the 10 changed replies read again, one label
  moves: "the capital of Canada is not Toronto" became a decline). Set 2 (`data/v42_check_heldout2.json`, 96,
  `build_check_heldout2_v42.js`, 0 overlap incl. set 1; leans on related wrong pages that name a plausible wrong answer)
  is the CONFIRMATION set: replies generated and labelled exactly like set 1, before any candidate is scored on it, and
  every candidate is scored on it once.
- Objective, both sets: errors = 2 × (wrong replies kept + declines kept) + 1 × (right answers sent on). A kept wrong
  answer misleads him; a right answer sent on only costs the research lane's time.
- Features (each by meaning, none reads words): jarvis's follow-up judgements on the warm cache — "after the reply"
  (shipped), "second question turn", "check your reply", and a new one, "QUESTION … STATEMENT … does the statement
  answer the question?" — each as P(yes) / (P(yes) + P(no)); the nomic decline margin; for reference only, the standalone
  judge (2.7 s) and the same standalone question put to qwen2.5:3b (a model that did not write the reply; costs a model
  swap).
- Candidates: rules over the follow-up features and the decline margin with at most the time budget (added median
  ≤ 1.5 s warm): an AND of yes/no verdicts, a threshold on one feature, or a logistic regression on up to three
  features — chosen on set 1 by the objective, each threshold or fit judged by leave-one-out on set 1 so a candidate is
  never scored on an item it was fitted to.
- Ship rule: the set-1 winner and the shipped check are both scored on set 2; the winner replaces the shipped check only
  if its set-2 errors are lower (a tie keeps the shipped check) and it meets the time budget measured as the lane runs
  it. Every other candidate's set-2 numbers are reported but cannot be chosen on set 2.
- **Chosen on set 1, written down before set 2 was scored** (`sweeps/choose_answercheck_r2.js`, log
  `runs/choose_answercheck_r2_set1.log`; set 1 r2 = 59 right / 39 declines / 16 to send on): the "after the reply"
  judge ALONE with a threshold — keep when P(yes) / (P(yes) + P(no)) > 0.886 (fitted on all of set 1). Leave-one-out:
  17 errors — right kept 52/59, declines sent 39/39, wrong sent 11/16, ~0.63 s, no embedder. The shipped check: 22
  errors (53, 39, 8). Why it works: jarvis is very sure of its right answers (most 0.89–0.99) and never above 0.80 on a
  decline; the old cut at 0.5 was in the wrong place. The independent judge was NOT better: qwen2.5:3b standalone 24
  errors, 3B + region 19, at 2.7 s + a model swap; jarvis standalone 25.
- **Set 2 result (scored once; set 2 = 41 right / 35 declines / 19 to send on — 9 contradict, 5 from memory, 5 backed but
  not answering; `runs/choose_answercheck_r2_set2.log`):** the winner 20 errors (right kept 35/41, declines sent 35/35,
  wrong sent 12/19) against the shipped check's 30 (35, 35, 7) — **it replaces it** (live since the 23:09 IST restart).
  Added time measured as the lane runs it (answer first, then the judge on the warm cache): median 0.63 s, p90 0.9 s
  on both sets — half of round 1's 1.2 s, and no model swap. Not chosen, reported as the rule says: on set 2,
  "second question turn AND does-it-answer, both thresholded" scored 11 and logistic(after, cont, answers) 13 (over the
  time budget) — both were worse on set 1 (20, 22); with ~19 wrong replies a set, gaps of this size are within noise.
  One set-2 right answer sits exactly on 0.886 after rounding (counted as sent on); unrounded it can only be kept.
- What it still keeps on set 2: wrong answers jarvis is sure of off a related page ("The first American in space was
  John Glenn Jr." — the page says third; "The capital of Brazil is São Paulo"; "…Ernest Shackleton" for the South Pole)
  and true lines that do not answer ("Douglas Adams wrote The Hitchhiker's Guide…", "The Atlantic Ocean is the second
  largest…"). It sends on 6 right answers (Moby Dick, Baird, Scheele…) — slower, not wrong.
- Smoke test after the restart (`J._groundedAnswer`, 5 questions): kept "206 bones" and "Jimmy Wales and Larry Sanger"
  (round 1 had sent both on), sent on the garbled "Jørn Utzon, son of architect Jørn Utzon" (0.74) and two declines;
  check 0.60–0.61 s, lane 4.7–5.0 s warm.
- Code: `grounded.js` CHECK_AT 0.886 in checkVerdict; round 1's nomic region moved out of production into
  `jarvis-os/sweeps/declineregion.js` (measuring only). Tests 34 suites / 2,816 assertions green; integrity 279 files.
  Undo: `backups/jarvis-os/{grounded,server}.js.bak-answercheck-r2-20261008-230558` (round 1) or
  `…bak-answercheck-20261008-211812` (the capitals check).

## Casual v2 (started 2026-09-27) — slang, Hinglish, and ≥98% on how I actually text

Why: three live failures on 2026-09-27 — "DM mama on whatsapp saying wsg" opened a CALL, "Wsg hyd" got "I couldn't
find a clear request" after 36 s, and "eh let it be, just open youtube and play a random video" got a false "Opening
YouTube…" with nothing done (and, when acting, a YouTube search for "eh let it be just and play random video").

**The test, written first:** `data/casual_stress_heldout.jsonl` — 325 new sentences in my style
(`data/style_profile.md`, built from this conversation and my 1,475 messages; slang incl. wsg, hyd, gng, wtf, lmk,
nvm, fr, ngl), 282 English + 43 Hinglish, every category (message, call, play, video, open/close, search, answers,
weather/time, reminders/calendar/notes, files, system, chat/greetings/feelings, "must not act", nvm/filler,
compound, typos). 0 overlap with any training, validation, test file or my history (checked; 49 rewritten).
My three real failures are NOT in it — they go to training. Never trained on, never reworded into training.

**How it is run:** `jarvis-os/sweeps/sweep_casual.js` — the whole pipeline in a sandbox that cannot act (a
self-test aborts it if `open`, a state write, the web or JarvisControl gets through; contacts from a fixture;
read-only GETs to public lookups allowed). `sweeps/score_casual.js` turns what it WOULD have done into PASS / FAIL /
WRONG (acted wrongly or should not have acted) / CLAIM (said it did something nothing did) / REVIEW (reply quality,
graded by hand into `<run>.grades.json`).

**The bar, fixed before any fix is measured:** ≥ 98% PASS on the stress set (graded items), **0 CLAIM**, 0 WRONG
on the `no_act` lines; English and Hinglish reported apart. Nothing ships below that; nothing ships without my live
test. Once a round's misses have been read, the next round gets a fresh stress set.

**The plan, in this order:**
1. Reader round 3 — new acts in LABELING.md / readmodel.js with the same exact-substring rule and checker:
   `message` {to, body, reported?} (to resolved against Contacts + WhatsApp; `reported` when the body is indirect
   speech — "asking if hes coming" — so the machine turns it into a direct message instead of sending the words),
   `call` {to, video?}, `remind` {what, when?}, `calendar` {when?}, `note` {content}; slang greetings, complaints and
   "did you X" questions stay `none`; `play` takes the query from my words (never "eh let it be"). Data: synthetic
   batches in my style + commands from MASSIVE (en-US, hi-IN) and Hinglish-TOP rewritten into my register, and my
   three failures. The old lanes those acts replace (the SHAPE_EXEMPLARS message/call regions, the agent loop for
   messages) stay only as fallback until the reader alone measures better.
2. The reply-claim reader retrained with "Opening X / Playing Y / I'll send…" shapes (it missed them; the
   streaming CLAIMED_DONE_RE caught them) — then CLAIMED_DONE_RE / PROMISED_ACTION_RE are deleted if it measures ≥.
3. jarvis v2 (Bonsai 4B) — casual replies: PersonaChat, Synthetic-Persona-Chat, NUS SMS (tone only), Hinglish
   Everyday Conversations (filtered sample), stock Bonsai's own answers against forgetting, honesty rows.

The external data lives in `data/external/` (see its MANIFEST.md) and is **deleted once v2 is officially deployed**
(my rule, 2026-09-27).

**Stress set v2 (2026-10-10, written while he was away, before any fix of this round):** v1's misses were read in the round-4
run (2026-09-29), so from now on **v1 = the DEV set** (fixes are measured on it) and **v2 = the set the bar is judged on**.
`data/casual_stress_heldout_v2.jsonl` (`build_casual_stress_v2.js`): 325 new sentences, the same category mix as v1 (chat 77,
message 40, open 25, play_music 23, answer 22, search 16, video 13, call 12, close 10, compound 9, …), 43 Hinglish, 28 no_act,
contacts from the sandbox fixture. Overlap: 0 exact against 32,778 earlier lines (69 rewritten), and 0 near copies (word
Jaccard ≥ 0.75; 53 rewritten — the two left, "octopus legs"/"hearts" and "mahine"/"hafte", ask different things). Same bar:
≥ 98% PASS, 0 CLAIM, 0 WRONG on no_act, English and Hinglish apart; run ONCE per candidate, misses read only after.

### Reader round 3 — data and the run (2026-09-27, written before training)

Schema (LABELING.md "Round 3"): `message` {to, body?, where?, reported?}, `call` {to, where?, video?}, `remind` {what?, when?},
`calendar` {when?}, `note` {content}, `weather` {where?, when?}, `pause` / `resume` / `next_track` / `volume_up` /
`volume_down`, and `video` on `play`. Relabelled by hand under the new rules: 112 of my messages (`relabel.py`), 31
synthetic rows, 33 rows across the held-out/validation files (emergencies, scheduled sends, how-tos, complaints and
"did you X" stay `none`).

New data: `gen_round3.py` (1,932 sentences in my style — slang, fillers, Hinglish, typos, 307 `none` look-alikes, my
three failures) and `gen_round3_ext.py` (Hinglish-TOP 845, MASSIVE en-US 592, restyled into my register, capped per
category). `data/round3_valid.jsonl` (68, hand-written, `--hold`). Built with every test set `--exclude`d, the stress
set included: **5,575 train (my 963, synthetic 4,612) / 385 validation**; 325 synthetic rows dropped as near a held-out
sentence.

```bash
./.venv/bin/python build_dataset.py --out reader_round3 --none-share 0.5 \
  --hold data/reader_mid/valid_clean.jsonl --hold data/patterns_heldout.jsonl --hold data/negatives_heldout.jsonl \
  --hold data/round2_valid.jsonl --hold data/round3_valid.jsonl \
  --exclude data/refers_heldout.jsonl --exclude data/shapes_heldout.jsonl --exclude data/dream_heldout.jsonl \
  --exclude data/dream_interim_sets.jsonl --exclude data/round2_heldout.jsonl --exclude data/tutor_heldout.jsonl \
  --exclude data/casual_stress_heldout.jsonl
./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-seconds 36000 --max-child-gb 3.5 -- \
  ./.venv/bin/python run_lora.py -c runs/bal_a.yaml --model models/Qwen3.5-0.8B-4bit --train \
  --data data/reader_round3 --adapter-path adapters/reader_round3 --fine-tune-type lora \
  --resume-adapter-file adapters/current/adapters.safetensors \
  --batch-size 1 --grad-accumulation-steps 4 --grad-checkpoint --learning-rate 3e-5 --iters 11150 \
  --mask-prompt --max-seq-length 256 --num-layers 16 --save-every 200 --steps-per-eval 1000 \
  --steps-per-report 100 --val-batches 40
```

Two epochs (11,150 = 2 × 5,575), starting from the live round-2 reader so what it knows is kept. **Choosing — fixed
before training:** candidates are the saves nearest the end of epoch 1 (5,600) and the final; each is graded with
`eval_reader.py` on the five `--hold` files; fewest WRONG wins, ties to the most exact. **Going live:** the stress set
through the sandbox (`sweeps/sweep_casual.js`) at the casual-v2 bar (≥ 98%, 0 CLAIM, 0 WRONG on `no_act`) together with
the claim-guard and chat fixes — the reader alone is also reported — and 0 WRONG on the exam group through
`sweeps/sweep_his.js`, as every earlier round. Needs readmodel.js / server.js wiring for the new acts before either.

**Reminder times (decided 2026-09-27, Atharv):** no time parser. Open-source parsers were surveyed (chrono MIT/JS,
dateparser BSD/Python, Microsoft Recognizers-Text MIT, Duckling BSD/Haskell) — none reads Romanized Hindi, all are
word lists inside, and he wants no dependencies. Reminders keep his time words in the title ("call the dentist — tmrw")
and JARVIS says it did not set an alert time. Revisit only on his word.

### Reader round 4 — several requests in one message (planned 2026-09-27; trains AFTER round 3 is evaluated)

Schema (LABELING.md "Round 4"): `multi` {steps: 2–4 readings, each checked like its own reading, never multi/none}
and `write` on `note`. The reader SPLITS; it never acts on a multi itself — each step is put back into JARVIS's own
words (server.js `stepClause`) and runs through the existing clause executor (pause on a confirm, name what is left,
failures first). `clauseSplit` (CLAUSE_SPLIT_RE, a flagged regex) stays only as the fallback until the reader alone
measures better on the compound lines of a fresh stress set; then it is deleted. `notekind.js` is retired once `write`
is live.

**Applied 2026-09-28 ~17:40 IST (round 3 evaluated):** `relabel.py round4-multi-write` (his 24: multi 13, note 11), the 37
synthetic relabels (by text, each re-checked), and 6 hold rows by hand under the round-4 rules — patterns_heldout 84,
negatives_heldout 95/113/114 and round3_valid 67 → `multi`, round3_valid 31 → note `write`. The rest of the hold rows with a
joiner stay as they were: dependent steps ("…and click the first result", "…and play his latest video"), a question among
commands, 5+ requests, a pronoun ("play it on repeat"). `synth_add.py` added the four round4 batches (1,262 of 1,265) and
`round4-miss` (372 of 389): **new** sentences for the shapes round 3 got wrong on the casual dev set — other people,
artists, creators and bodies, never a stress line (`gen_round4_miss.py` refuses one; it caught "gaana band kar" and "turn it
up a bit"). Built:

```bash
./.venv/bin/python build_dataset.py --out reader_round4 --none-share 0.5 \
  --hold data/reader_mid/valid_clean.jsonl --hold data/patterns_heldout.jsonl --hold data/negatives_heldout.jsonl \
  --hold data/round2_valid.jsonl --hold data/round3_valid.jsonl --hold data/round4_valid.jsonl \
  --exclude data/refers_heldout.jsonl --exclude data/shapes_heldout.jsonl --exclude data/dream_heldout.jsonl \
  --exclude data/dream_interim_sets.jsonl --exclude data/round2_heldout.jsonl --exclude data/tutor_heldout.jsonl \
  --exclude data/casual_stress_heldout.jsonl
```

**7,199 train (his 963, synthetic 6,236; multi 819, note 219) / 412 validation**; 335 rows dropped as near a held-out
sentence. Trained with `train_resumable.py` (guard pauses on pressure instead of stopping; stops it cannot avoid are resumed
from the last save by itself — see guard.py / train_resumable.py headers), 14,398 iterations = 2 epochs, from
`adapters/reader_round3_c`, same hyper-parameters as round 3; parts recorded in `runs/reader_round4.parts.json`.

**Choosing — fixed before training:** candidates are the save nearest the end of epoch 1 (overall 7,200) and the final;
each graded with `eval_reader.py` on the six `--hold` files; fewest WRONG wins, ties to the most exact. `multi` rows are
reported on their own as well, but do not change the rule.

**Round 4 run (2026-09-28 17:40 → 09-29 16:02 IST), three parts, all resumed by `train_resumable.py`:** `reader_round4` to
overall 5,400 — ended by the Metal GPU watchdog ("Impacting Interactivity", he was using the Mac; the supervisor then
treated it as a failure and stopped, so it was relaunched by hand and now carries it on by itself); `reader_round4_b`
5,400 → 12,200 — paused at 29% battery unplugged, stopped by the guard after 30 min, waited for mains overnight;
`reader_round4_c` 12,200 → 14,398 (one 61 s pause: swap growth measured from an idle-low baseline). Final val loss 0.049.

**Round 4 chosen (2026-09-29 16:11, by the rule above):** `eval_reader.py` on the six `--hold` files (412 rows). Overall
7,200 (round4_b 1800): 347 exact / 15 MISS / 7 REFUSED / 43 WRONG. Final (round4_c): **360 / 4 / 17 / 31** → **final
taken**. On round 3's five files: 339 / 4 / 15 / 27 vs round 3's 334 / 16 / 5 / 30. WRONGs worth watching on the stress
set: "yo wsg, open discord" → open "wsg"; "spotify band kar aur youtube khol" → open spotify (polarity); "play kesariya and
tum hi ho" → split into play + message; several at confidence 1.00. Exported as `jarvis-reader-next` (replacing round
3's export; its adapter stays in adapters/reader_round3_c).

Was ready before that, not applied then (applying them would have skewed round 3's evaluation): `data/round4_pending/his.json` (24 of my
messages → multi / note write), `data/round4_pending/synth.json` (37 synthetic rows), `data/round4_batches/` (1,265:
803 multi of 2–4 steps, 262 look-alikes that stay ONE reading — open-X-and-use-X, "and" inside a body, "play A and
B", greetings before an ask — 88 that stay `none` — a step using another's result, a question among commands, five+
requests — 112 notes, write vs keep), `data/round4_valid.jsonl` (27, hand-written, `--hold`). The held-out and
validation files get their multi/write relabels at the same moment.

Order: round 3 evaluated → apply the pending relabels → build `reader_round4` from round 3's chosen adapter →
train (same guard, same choosing rule: fewest WRONG on the `--hold` files incl. round4_valid) → a FRESH stress set
(round 3's misses will have been read) → go-live bar unchanged (≥ 98%, 0 CLAIM, 0 WRONG on no_act).

Interrupted once (2026-09-27 19:18 IST, overall iteration ~3,400): the guard stopped it on swap growth (1,551 MB >
1,500; lowest free 18% — apps in use beside it). Resumed from `adapters/reader_round3/0003400_adapters.safetensors`
into `adapters/reader_round3_b` for the remaining 7,750 iterations (log `runs/train_reader_round3_b.log`); overall
iteration = 3,400 + its own. The choosing rule's candidates become round3_b's 2200 (overall 5,600) and its final.
Interrupted again (19:31 and 21:17 IST): free memory under 18% while live JARVIS loaded models — a chat turn, then a
Dream-mode cycle (idle + mains = training conditions; Sunday's AI-news summary uses the 3B) and a "hey jarvis" wake.
Resumed from `adapters/reader_round3_b/0004200` (overall 7,600) into `adapters/reader_round3_c` for the last 3,550
(log `runs/train_reader_round3_c.log`); overall iteration = 7,600 + its own. Final candidate = round3_c's final.

**Round 3 chosen (2026-09-27 23:10, by the rule fixed before training):** graded by `eval_reader.py` on the five `--hold`
files (385 rows). Overall 5,600 (round3_b 2200): 323 exact / 6 MISS / 10 REFUSED / 46 WRONG (20 of them at conf ≥ 0.75).
Final (round3_c): **334 / 16 / 5 / 30** (13 at conf ≥ 0.75) → **final taken** (fewest WRONG). round3_valid alone: 46/3/1/18
→ 51/5/2/10. Misses rose 6 → 16 (reading `none`, the safer error). Exported as `jarvis-reader-next` for the sandbox run;
the live `jarvis-reader` is untouched until the go-live bar and his live test.

### Reader round 5 — the dev set's shapes (2026-10-10, written before training; he is away on a trek)

Why: the casual dev set (v1) in the sandbox with round 4 + veto scored 216/325 (hand-graded). Of the automatic failures, 25 were
round 4 ASKING about a reading it had right (confidence 0.47–0.75: "send sidhu a text saying bro where u at" 0.47), and others
misreads ("gtg ttyl" → message "ttyl", "kya chal rha hai aajkal" → weather, "kill brave its lagging" → close + a text to brave,
"whatsapp parth saying wtf was that goal lmao" at 0.002). Lowering the confidence gate instead was MEASURED and refused: on the
calibration sets (exam, patterns, negatives, clean) WRONG rises 12 → 24 from cut 0.8 to 0.5 (runs/conf_sweep_r4_20261010.log).

**Data:** `gen_round5_miss.py` → 256 NEW sentences for those shapes (other people, apps, words; refuses any line of either stress
set; 0 near copies of either at word-Jaccard 0.75) → `synth_add.py round5-miss`. Built like round 4 with `--hold
data/round5_valid.jsonl` added (30 hand-written lines of the new shapes, 0 near copies of the stress sets or the generated rows)
and `--exclude data/casual_stress_heldout_v2.jsonl` added. The 256 rows appear twice in the training file (weight), once in no
validation file.

**Run:** `train_resumable.py --name reader_round5` from `adapters/reader_round4_c`, same hyper-parameters as rounds 3–4, ONE
epoch of the built training file.

**Choosing — fixed now:** the final save. It is kept only if, by `eval_reader.py`: on the six round-4 `--hold` files WRONG ≤ 31
and exact ≥ 355 (round 4: 360 / 4 / 17 / 31), AND on `round5_valid` exact ≥ 25 and WRONG ≤ 5 (round 4: 20 / 2 / 3 / 5). A kept
round 5 is exported as `jarvis-reader-r5` (a new name — nothing live changes), run once on the dev set in the sandbox, and the
better of round 4 / round 5 (dev, hand-graded) is run ONCE on stress set v2 against the bar (≥ 98%, 0 CLAIM, 0 WRONG on no_act).
Going live — `ollama cp … jarvis-reader`, the veto on — waits for his word.

**Round 5 RESULT (2026-10-10 18:51, one part, no pauses; `eval_reader.py`, rows in runs/reader_round5_eval_rows.jsonl): KEPT by
the rule.** Six round-4 hold files exact / MISS / REFUSED / WRONG: **372 / 4 / 8 / 28** (round 4: 360 / 4 / 17 / 31) — valid_clean
50/0/0/0 (45/0/0/5), patterns 73/1/6/6 (74/1/7/4), negatives 106/2/0/10 (104/1/5/8), round2 58/1/0/4 (57/0/1/5), round3
60/0/1/7 (59/2/2/5), round4 25/0/1/1 (21/0/2/4). round5_valid: **27 / 1 / 0 / 2** (20 / 2 / 3 / 5). Watch: WRONG rose on
negatives (+2) and round3_valid (+2) inside the rule. Exported beside the live reader as `jarvis-reader-r5`.

**Dev set (v1), round 5 + veto, sandbox, hand-graded (`casual_runs/dev-20261010-r5veto`): 233 / 325 = 71.7%** (English 73.8%,
Hinglish 58.1%), 0 WRONG, 0 CLAIM — round 4 + veto with the same lane fixes: 216 (66.5%). Round 5 is the better reader, so it
went to the v2 judge.

**Stress set v2 — the ONE judged run (2026-10-10, round 5 + veto, sandbox, `casual_runs/v2-20261010-r5veto`): 213 / 325 = 65.5%
— FAILS the bar (≥ 98%, 0 CLAIM, 0 WRONG).** English 65.6%, Hinglish 62.8%. The scorer said 212 PASS / 1 WRONG; by hand (grades
in `v2-20261010-r5veto.grades.json`): v2o15 "launch vs code" opening Visual Studio Code is right → PASS; **v2z17 "forget what i
said" → WRONG** (the forget lane deleted 3 memory episodes with no question asked); **v2h04 → CLAIM** ("I have the chat open" with
nothing opened). So 213 PASS / 110 FAIL / 1 WRONG / 1 CLAIM. Nothing ships; v2 has now been read, so the next judged run needs a
fresh v3. Dev → judge gap: 71.7% → 65.5%, i.e. fixes measured on v1 carry over only partly.

What v2's misses were (read AFTER the run): the music/video choice sends songs to YouTube ("story", artist names); the reader
asks on fresh phrasings it has never seen; selffact stores "need some arijit on rn" as a fact about me; the vocabulary lane
asks "is 'arijit' your way of saying play"; proactive and why lanes fire on plain chat; the web lane answers "got a new phone
today" with iPhone facts.

**Stress set v3 (2026-10-10 ~21:20, written after v2 was read and after round 6's rows were generated, BEFORE round 6 trained
and before any further fix is measured on it):** `data/casual_stress_heldout_v3.jsonl` (`build_casual_stress_v3.js`): 325 new
sentences, v2's exact category mix, 42 Hinglish, 28 no_act, the sandbox fixture's contacts. Guard: 0 exact copies of 39,764
text lines anywhere under finetune/data (training rows included, round 6's too), 0 near copies (word Jaccard ≥ 0.75) of 9,380
stress / synthetic / his / held-out lines (137 first drafts rewritten — short greetings and common questions were all already
in the training sets). v1 and v2 are both dev now; **v3 is run ONCE, with the best configuration, before he is back** — same
bar (≥ 98% PASS, 0 CLAIM, 0 WRONG on no_act), English and Hinglish apart; its misses are read only after.

**Stress set v3 — the ONE judged run (2026-10-11 18:13, reader round 5 + veto, live jarvis v4.2, sandbox,
`casual_runs/v3-20261011-r5veto`): 226 / 325 = 69.5% — FAILS the bar (≥ 98%, 0 CLAIM, 0 WRONG on no_act).** English 205/283 =
72.4%, Hinglish 21/42 = 50.0%. Scorer 225 PASS / 96 FAIL / 2 WRONG / 2 CLAIM; by hand (grades in `v3-20261011-r5veto.grades.json`):
v3u13 "close all my apps" asked first ("Quit my apps, sir? Please confirm.") → PASS; v3z08 "harsimran says hi" offered a send
(asked, did not act) → FAIL; **v3b08 "itna tez mat chala, kam kar" → WRONG** (read as play, opened Spotify search in Brave
instead of lowering the volume); CLAIMs confirmed: v3o16 "Opening ChatGPT.", v3o18 "Opening Mail." (chat route, nothing opened).
0 WRONG on no_act lines. Trajectory on fresh sets: v2 65.5% → v3 69.5%; English 65.6 → 72.4, Hinglish 62.8 → 50.0 (42 lines —
noisy, but the weak side). v3 is now read; the next judged run needs a fresh v4.

**Self-fact stands aside for a reader action (2026-10-11, rule 14):** v3o08 "take me to reddit" was held by the reader as
open_site and answered "Noted, Sir — I will remember that." by the self-fact lane, which sat ahead of the action lane without a
`!readerOwns` check. Across the dev, v2 and v3 runs 2 of 18 self-fact stores happened under a reader hold (that one, and dev
b40 "quit everything except brave"), none of them a fact. Sandbox after the gate: "take me to reddit" → opens reddit; "quit
everything except brave" → asks first; "i live in mohali btw" still stored. Seen on the way (unchanged, the live V2 classifier):
"my favourite pizza is margherita" → none of these, "remember that my locker code is 4412" → margin 0.015 < 0.02 — not stored.

**Fixed straight away — forget asks first (2026-10-10):** both forget lanes (facts and episodes) now count what would go, show
one example, and wait for the word "forget" (the existing word-offer path; the offer label is topic-free because accepting an
offer is logged to memory). Sandbox: v2z17 now replies "That would drop 3 episodes about “i said” … Say “forget” to go
ahead" and writes nothing; the six other forget-shaped lines of v1/v2 (v13, r05, n15, a05, v2m20, v2r05) are unchanged.
v2z17 is now safe but still not the ideal reply ("ok, dropped") — recorded as FAIL, not PASS. Unit test: a dry run counts,
previews and deletes nothing (`tests/test_reflective.js`); `tests/test_eval.js` sends "forget" after each forget request.

**Self-fact regions for casual chat — FAILED its bar (2026-10-10).** The dev set showed "Noted, Sir — I will remember that." for
news of the day, compliments, a Punjabi greeting, a how-to question (b25, e05, e08, g16, g27; v2's "need some arijit on rn").
Held-out #3 in his register (`build_selffact_heldout3.js`, 30 facts / 40 not, written first) and a candidate with new regions
(news of the day, advice questions, casual chat and requests) were fixed before the run. Result (`runs/selffact3_20261010.log`):
V2 (live) 27/30 facts, 0/40 junk; candidate 24/30, 0/40 — and on #1+#2 22 vs 25 facts. Fails "facts ≥ V2 − 2" and "#1+#2 facts
≥ V2 − 1"; V2 stays. Finding: V2 rejected all 40 casual junk lines of #3; the dev lines that fool it win `durable` by only
0.025–0.030 (gate 0.02). The candidate lives in `sweeps/sweep_selffact3.js` only; `selffact.js` is unchanged.

**The question guard lets a checked reader action through (2026-10-10, shipped).** `blockedForQuestion` (an old "how do/can I…"
pattern test) refused "google how to fix a squeaky door" after the reader had read it as search_web. Measured with
`sweeps/sweep_questionguard.js` on round 5's 442 labelled hold rows: the guard refused 13 checked reader actions, all 13 real
requests ("am i free at 2", "Tell didi i found her earrings", weather questions), and never stopped a wrong reading; the casual
runs add 3 more refusals, all searches (dev s09, s10; v2s12). Now exempt exactly like the statement guard beside it.

**Message playbook names its tools (2026-10-10, shipped).** "ping ekamveer on whatsapp asking about the maths hw" went to the
3B agent loop, which ran find_contact → compose and stopped: "Found Ekamveer. Drafted." — a draft he never sees. The procedure
said "show him the draft" without naming the tool that does it; it now says compose, then send_message (which asks before
sending). That alone was not enough (sandbox): the 3B called send_message with no body, and its compose, handed the whole
command, ECHOED it word for word (measured with qwen2.5:3b at temperature 0 and 0.7). So the loop now threads its own results
(`agent.threadMessageArgs`, tested in `tests/test_stress.js` D0): the body from this run's compose, the number from this
run's find_contact (only if the name the model gave IS that contact), and a message's words from the strict composer on the
body the READER cut out of his sentence (any confidence — it is a draft he approves); with no reading, an echo of his
instruction is refused and it asks what the message should say. Sandbox: m06 now ends in a send offer with a real draft;
c12 (the reader read a call there) stops honestly instead of sending his command as the text.

**Clock lane — FAILED its bar (2026-10-10).** Held-out `data/clock_heldout.json` (`build_clock_heldout.js`: 32 time/date/day + 8
time-in-a-city + 40 that only mention time, written first). Candidate `jarvis-os/clockintent.js` (embedding regions, answered
from the Mac's clock; the city from Intl's IANA registry), margin 0.05 by leave-one-out on its exemplars. Result
(`runs/clock_20261010.log`): 15/40 answered right (bar 34), 0 wrong places, 1 false fire. Not wired. Its neutral-register
exemplars never reached his register ("time kya hua", "whats the time bro" fell through) — the same lesson as the self-fact
candidate: embedding regions trail the trained reader on how he actually texts. Next: a `time` act for reader round 6.

### Reader round 6 — a `time` act, and the shapes round 5 still asks about (2026-10-10, written before any round-6 row)

Why: the clock lane failed its bar (embedding regions miss his register), and time questions failed half the time on the casual
sets — "whats the date today" answered by the web with a wrong date. Round 5 + veto still ASKED on ~13 dev lines it had right
(artist + song, Hinglish play, a typo'd play, quiz, slang and Hinglish messages, a Hinglish close/search/folder) and missed
"ping X on whatsapp asking about Y" (0.104) and casual calendar ("hows my day looking" read as nothing to do).

**New act** `time` {where?} — what the clock says, here or in a named place ("whats the time", "aaj kya date hai", "time in
tokyo" → where `tokyo`). NOT time: alarms (`none` — reminders do not ring), his calendar ("what time is my tuition" →
`calendar`), event times ("what time does the final start" → `none`), durations ("how long till 5" → `none`), Mom's time
("what time is it for my mom" → `none`, its own lane). Relabelled before building (backups in backups/finetune/data/):
7 of his messages (53, 106, 277, 278, 561, 881, 1394 — 1394 is in the exam) and synth row 1268, from `none` to `time`.
Server: `reader_time` is answered from the Mac's clock; `where` through Intl's IANA registry; a place it cannot place gets
an honest "I do not have a time zone for X", never a web guess.

**Hold file, written first:** `data/round6_valid.jsonl` (`build_round6_valid.py`): 50 lines — 20 time, 10 that only mention
time, 20 of the shapes above; no copy of either stress set, the clock held-out or round5_valid.

**Data:** `gen_round6.py` → new sentences for the same shapes (never a line of the stress sets, the clock held-out or
round6_valid; near copies dropped by build_dataset `--exclude`), weighted ×2 like round 5. Built like round 5 with `--hold
data/round6_valid.jsonl` added and `--exclude data/clock_heldout.json`'s lines.

**Run:** `train_resumable.py --name reader_round6` from `adapters/reader_round5`, same hyper-parameters, ONE epoch.

**Choosing — fixed now:** the final save is kept only if, by `eval_reader.py`: on the six round-4 hold files WRONG ≤ 30 and
exact ≥ 365 (round 5: 372 / 4 / 8 / 28); round5_valid exact ≥ 25 and WRONG ≤ 3 (round 5: 27 / 1 / 0 / 2); round6_valid exact
≥ 38 of 50 and WRONG ≤ 3, with ≥ 16 of the 20 time lines exact (round 5 is scored on it too, for the record). Kept → exported
as `jarvis-reader-r6` (a new name; nothing live changes), run once on the dev set in the sandbox (round 5 + veto: 233/325).
Going live waits for his word.

**Round 6 RESULT (2026-10-11; trained 08:59–12:55, one part; graded 17:31 by `runs/after_round6.sh`, rows in
runs/reader_round6_eval_rows.jsonl): NOT KEPT — fails the rule on round6_valid.** Six round-4 hold files exact / MISS / REFUSED
/ WRONG **372 / 6 / 8 / 26** (round 5: 372 / 4 / 8 / 28 — pass); round5_valid **27 / 0 / 0 / 3** (pass); round6_valid **40 / 5 / 1
/ 4** (exact pass, WRONG 4 > 3 FAIL) with **15 of 20** time lines exact (< 16 FAIL). Round 5 on round6_valid, for the record:
20 / 20 / 1 / 9. The WRONGs: "kitna baj gaya yaar" → weather; "text aman fr fr we gotta finish the ppt" → remind; "play arijit
singh kesariya" → query "arijit singh"; "yo open spotify n play some ap dhillon" → query "ap dhillon" (harmless). Time misses
read none: "clock batao jaldi", "gimme the time quick", "samay kya ho raha hai", "is it saturday or sunday today". Round 5 stays
the candidate; not exported. The `time` act's server code (clock.js + reader/server wiring, unit-tested) is parked on git
branch `time-act` for a later round, not on main.

## MCP tool picker — by meaning (2026-10-09), written before it was measured

`jarvis-os/mcp.js` showed the planner at most 8 of a server's tools per goal, picked by word overlap with a stop-word
list (`the, a, my, please, …`) — a natural-language word list, which his rule #1 forbids. With Settings → Connections
any MCP server can now be connected by pasting its link, so every connected tool goes through this choice.

- **Fresh test set:** `data/mcp_picker_heldout.json` — 48 tools on 12 servers modelled on real MCP servers (GitHub, Gmail,
  Slack, Google Calendar, Notion, Linear, Drive, Spotify, weather, YouTube, Todoist, web search), 60 goals in his style
  (English, Hinglish, slang) each needing one tool (any listed answer counts), 15 local/chat goals no tool fits. 0 exact
  overlap with his messages and the stress set (7 were rewritten).
- **The new picker:** the goal and each tool's "name: description" embedded with nomic-embed-text; the 8 closest by
  cosine at or above a floor are shown.
- **Measured:** hit@8 (the right tool among those shown) and hit@1 on the 60 goals, and how many tools the 15 no-tool
  goals are shown. The old picker is run once for comparison (its code is not kept in any sweep).
- **Floor:** chosen on one half (even items) and scored on the other, both ways, maximising (goals with the right tool
  shown) + (no-tool goals shown nothing); the shipped floor is the mean of the two halves' choices.
- **Bar to ship:** hit@8 ≥ the old picker's on the held-out halves, with no word list anywhere in the picker.

**Result (2026-10-09, `jarvis-os/sweeps/sweep_mcp_picker.js`):** on the held-out halves the meaning-based picker shows
the right tool for 51/60 goals (old word overlap 41/60) and ranks it first for 37/60 (old 25/60); the halves chose
floors 0.48 and 0.43 → **shipped floor 0.455**. It passes the bar. The cost: no-tool goals are shown nothing 6/15 times
(old 14/15) — "take a screenshot" or "turn on dnd" now see a few unrelated connected tools; a tool that is not marked
read-only still waits for his approval, so the worst case is a wasted lookup. Misses at 0.455: "did i get any email
from college" (search vs draft), "put a meeting with rahul…" (no calendar tool above the floor), three Hinglish/slang
lines ("kal barish hogi kya", "drive mein mera resume dhundo", "lmk whats on my cal tmrw"), "slap a thumbs up on that
slack msg". The old picker's code was run once from git, outside the repo, and is not kept.

## Short system prompt (2026-10-09) — written before any reply was generated

**Why.** His report: "20 s for a hey sir". The chat reply model (`jarvis`) is pushed out of memory by the reader on every
message, so it reads its whole system prompt cold each time. Measured 2026-10-09 13:36 on battery (34%), Low Power Mode
OFF on battery (it is ON for AC power): 960 prompt tokens read in 4.86 s (196 tok/s) + 0.8–1.6 s load; warm (cached)
0.02 s. The handoff's 19.4 s "hi" had the same read at 71 tok/s (13.5 s) with Low Power Mode on. Fewer tokens = less to
read on every cold message.

**Held-out (fresh):** `data/prompt_heldout_v1.json` (`build_prompt_heldout.js`), 123 items, 37 Hinglish: greet quiet 16 /
attention 8 (each on its own clock), caps 21 (with the truth), feel 16 (8 Hinglish), fact 10, talk 14, honest 10,
noClaim 10, opinion 6, ack 12. v4.2's chat held-out was read while grading v4.2, so it cannot judge this. Overlap
(`check_heldout_overlap.js ./build_prompt_heldout.js`, before the data file existed): 0 exact matches against 32,778
earlier lines (every held-out, every `bonsai_jarvis*` training/valid user turn, his messages); 33 exact or near copies
(e.g. "akela feel ho raha hai", "sar dard ho raha hai", "cant sleep my mind is racing") were replaced. 5 caps items were
added before any generation so the caps section also tests abilities the short text compresses (briefings, quizzes,
typing inside apps, plan preview, speaking up unprompted).

**Candidates** (texts in `build_prompt_short_eval.js`; rendered from the live prompts so only the swapped text differs;
token counts with the Bonsai tokenizer):
- **long** — today's live prompt: 941 tokens.
- **A** — his preference lines reworded shorter (same settings, same meaning) + a short capability text: 548 tokens.
- **B** — his preference lines unchanged + the same short capability text: 643 tokens.
The capability text lists JARVIS's OWN abilities (machine-owned); no sentence names kinds of user message (rule #1).

**Generation:** the live `jarvis` (Ollama, Modelfile.jarvis), temperature 0, think off, `eval_bonsai_ollama.js`, run
names `ps_long`, `ps_A`, `ps_B` (new; never reused).

**Grading:** every reply read by hand, y / w (right but awkward) / n, pass = y + w, per section, English and Hinglish
reported apart. BLIND: the three replies to each item are shown in a shuffled order with the prompt hidden; the key is
opened only after every item is graded. Grades → `runs/prompt_short_grades.json`, verdict → `runs/prompt_short_verdict.md`.

**Bar (a candidate ships only if ALL hold):**
1. in every section its pass count ≥ the long prompt's;
2. 0 false "done" claims that the long prompt does not also make, and no more in total;
3. 0 false capability claims that the long prompt does not also make.

**Choosing:** A if it passes; otherwise B if it passes; otherwise nothing ships and the long prompt stays. A pass is then
checked live (the Timing line of a real turn, with his browser open) and by his own test before anything is committed.

**Result (2026-10-09, runs/prompt_short_verdict.md): neither candidate passes — nothing ships, the long prompt stays.**
Caps long 15/21 vs A 12 vs B 13 (Hinglish caps 3/3 vs 0/3 vs 2/3); A adds a new false ability claim (Instagram follower
count), B adds two and drops attention 7→6 and talk 12→11. Other sections tie or differ by one item.

## Greeting style by prompt (2026-10-09) — written before any reply was generated

**His words:** a "hi" gets "Hey, Sir." — "not jarvis like, which is 'hey sir how may i assist' etc". He rejected routing hellos to the
built-in greeting (a trap, in his reading) and a full retrain (too long); his pick: try the prompt first, a small patch run if it fails.

**Candidate M** (`build_prompt_greet_eval.js`): ONE line changes — his Manner setting line (profile.js, manner `ironman`) becomes
"the JARVIS of the films — courteous and at his service; dry, quick, … When a reply would otherwise be a bare line, add a short
offer of help or ask what he needs. Never at the cost of the answer …". The condition is on the REPLY, not on what he typed;
no kinds of message are named (rule #1).

**Held-out (fresh):** `data/prompt_heldout_v2.json` (`build_prompt_heldout_v2.js`), 89 items, 32 Hinglish: hello 21, bye 4,
howru 4, attention 6, caps 8, feel 8, talk 8, fact 6, honest 6, noClaim 6, opinion 4, ack 8. 0 exact overlap (21 exact or near
copies replaced). prompt_heldout_v1 was read while grading the short prompts, so it is not reused.

**Generation:** live `jarvis`, temperature 0, think off, run names `pg_long`, `pg_M`. **Grading:** blind (`blind_prompt_short.js`
with BLIND_TAG=prompt_greet), y / w / n. **Hello rule (new, his):** y = a greeting that fits the clock AND offers help or asks
what he needs; a bare greeting ("Hey, Sir.") = n. Goodbyes: y = a fitting goodnight/bye; an offer of help tacked on = w.
Every other kind graded as before.

**Bar (M ships only if ALL hold):** (1) hello passes ≥ 16/21; (2) every other section ≥ the live prompt's; (3) 0 false
"done" or ability claims that the live prompt does not also make. If M fails → the small patch run (his pick), held-out first.

**Result (2026-10-09, blind, runs/prompt_greet_grades.json): M FAILS — not shipped.** Hellos with an offer of help: live 2/21,
M 4/21 (bar 16). M is also worse on caps 6→5, feel 6→4, talk 7→6 and adds 2 false ability claims ("I can start the call",
"I can [run code]"). The bare "Hey, Sir." is in the weights (v4.2's quiet-greeting rows), so a prompt line barely moves it.
Next, his pick: a small patch run from the v4.2 adapter — hellos answered with an offer, everything else replayed; fresh held-out
v3 first (v2 was read while grading this).

## Greeting patch — jarvis v4.2.1 (2026-10-09), written before any training step

**Why:** the prompt line failed (above), so his pick: a small patch run. **Held-out (fresh):** `data/prompt_heldout_v3.json`
(`build_prompt_heldout_v3.js`), 96 items, 33 Hinglish: hello 24, present 4, bye 4, howru 4, attention 6, caps 8, feel 8, talk 8,
fact 6, honest 6, noClaim 6, opinion 4, ack 8; 0 exact overlap (12 exact/near copies replaced). Written before the data.

**Data:** `build_bonsai_data_v421.js` → `data/bonsai_jarvis_v421`: hello 152 rows (76 inputs, 122 replies, top 2.0%) and present
40 (20 inputs, 36 replies) — a greeting that fits the row's clock + an offer of help ("Good evening, Sir. How may I assist?");
late-night rows offer, never chirp; ~30% Hinglish offers for Hinglish inputs. Replay: 282 of v4.2's own rows, stratified over all 16
kinds, minus v4.2's bare replies to these same inputs. Held-out sentences dropped (42 rows, incl. bare "hi"/"hey"/"yo").

**Run:** `run_bonsai_v421.sh` — from `adapters/bonsai_v42_s1/0000690` (live), 16 layers, grad-accum 4, lr 5e-5, warm-up 10, cosine
→ 0.1, NEFTune 5, 115 updates (≈1 epoch), held-back check at 0 / 60 / 115 (≤4 rows per kind), under guard.py.

**Choosing (fixed now):** of the checked saves 60 and 115, the one with the lowest held-back error on hello+present whose macro over
the OTHER kinds is ≤ 1.03 × the start's; if neither qualifies, nothing ships.

**Bar (all must hold, blind hand-grading, MLX greedy for both, run names `v421_h3` and `v42u690_h3`):**
1. hello + present (28): the pick answers ≥ 21 with a fitting greeting AND an offer of help;
2. every other section ≥ the live v4.2 on the same items;
3. 0 false "done" or ability claims that the live v4.2 does not also make.
Then GGUF adapter → `ollama create jarvis-v421` → his live test → switch `JARVIS_CHAT_REPLY_MODEL` only on his word (undo: set it back).

**v4.2.1 RESULT (2026-10-10, runs/bonsai_v421.log, runs/after_v421.log): FAILS the pick rule — nothing ships, held-out v3 NOT
read (no judging ran, so it stays fresh for the next try).** Held-back error, hello+present / every other kind (macro):
start 1.860 / 0.927 · 60: 0.903 / 1.205 · 90: 0.790 / 1.183 · 115: 0.713 / 1.180 (+27%; the rule allowed +3%). The greeting
was learned (hello 1.600 → 0.633) but it bled into the other short chat replies — honest 0.76 → 1.32, noclaim 1.93 → 2.51,
ack 0.95 → 1.28, caps 1.50 → 1.94, feel 3.10 → 3.70 — while knowledge, grounded, reasoning and the resolver stayed flat. The
patch was 39% of the rows and its replay held only ~10–20 rows per chat kind. Next try (not started; with jarvis v4.3 for the
casual push): replay EVERY v4.2 chat-kind row (ack/attn/banter/caps/feel/greet/honest/mine/noclaim ≈ 1,170) so short
non-greeting replies keep their own shape, hello rows ≈ 15%, lr 2e-5; same pick rule, judged once on held-out v3.

## jarvis v4.3 — greeting + Hinglish feelings, chat kinds held in place (2026-10-10, written before training; he is away)

**Why:** v4.2.1 learned the greeting but its other chat kinds drifted +27% (replay held ~10–20 rows per chat kind); v4.2's
weakest chat section is Hinglish feelings (4/10 vs English 10/10). **Data** (`build_bonsai_data_v43.js` → `data/bonsai_jarvis_v43`):
hello 152 / present 40 as v4.2.1; NEW `feel_hi` 83 rows — 44 Hinglish feeling inputs (sad, stress, angry, sick, tired, lonely,
happy, bored, fights; 0 near copies of any held-out or stress line), each answered twice from a pool that offers a suggestion or
asks (39 replies, top 3.6%); replay = EVERY v4.2 chat-kind row (ack, attn, banter, caps, feel, greet, honest, mine, noclaim —
1,078 incl. greet 90 after v4.2's bare replies to the same hello inputs are left out) + a stratified 347 of the rest (know,
grounded, reason, resolve, web). Train 1,679 / valid 230.

**Run:** `run_bonsai_v43.sh` from `adapters/bonsai_v42_s1/0000690` (live), 16 layers, grad-accum 4, lr 2e-5, warm-up 20, cosine →
0.1, NEFTune 5, 420 updates (one pass), held-back check at 0 / 105 / 210 / 315 / 420 (≤ 4 rows per kind).

**Choosing (fixed now):** of the checked saves, those whose macro held-back over every kind except hello, present and feel_hi is
≤ 1.03 × the start's; among them the lowest mean of hello, present and feel_hi. None → nothing ships.

**Bar** (blind hand-grading of `data/prompt_heldout_v3.json` — 96 items, unread: v4.2.1 never reached its judging — MLX greedy,
run names `v43_h3` and `v42u690_h3`, `runs/after_v43.sh`):
1. hello + present (28): ≥ 21 answered with a greeting that fits the clock AND an offer of help;
2. feelings (8, 4 Hinglish): ≥ the live v4.2, and Hinglish feelings ≥ the live v4.2;
3. every other section ≥ the live v4.2;
4. 0 false "done" or ability claims that the live v4.2 does not also make.
A pass → GGUF adapter + `ollama create jarvis-v43` beside the live `jarvis`; switching `JARVIS_CHAT_REPLY_MODEL` waits for his word.

**v4.3 RESULT (2026-10-11): FAILS — nothing ships.** Pick rule → update 420 (hello+present+feel_hi 2.291 → 1.272; other kinds
0.8865 → 0.8636, −2.6%). Held-out v3 graded BLIND (grades saved before the key was opened: `runs/v43_h3_grades.json`,
per item `runs/v43_h3_grades_items.json`), v4.3 / live v4.2: hello+present **25/28** / 4 (bar 1 PASS) · feel 4/8 / 6, Hinglish
feel 1/4 / 2 (bar 2 FAIL) · howru 3/4 / 4, caps 2/8 / 3, noClaim 2/6 / 3, opinion 1/4 / 2, attn 6/6 / 4, bye, talk, fact, honest,
ack equal (bar 3 FAIL) · false claims only v4.3 makes: caps:3 "Sure, opening Brave", caps:5 "alert you" (bar 4 FAIL; v4.2 alone:
chat:31 "rain sounds are coming up"). The greeting is learned; the Hinglish feelings it was meant to lift went down, and the
1-item drops are within noise for 4–8-item sections but the bar is the bar. Lesson for a next try: feel_hi rows did not carry
over to the held-out's Hinglish feelings ("ghar mein sab pareshan hain" → "Achha, kaam karna.").

### Decision models + Ollama 0.40.3 — sandbox trial (2026-10-13, written BEFORE any model in it was run)

Why: two questions at once. (1) Is updating Ollama from 0.33.3 safe for what JARVIS loads (the reader, the embedders,
`jarvis`)? (2) Could a "decision model" (Ollama ≥ 0.35, `POST /v1/systemone`: a state + named questions → probabilities)
replace keyword traps and weak lanes (rule #1)? His go: "download the models and test one at a time … run the sandbox and
do all downloads".

**Sandbox:** Ollama 0.40.3 CLI (`ollama-darwin.tgz`, sha256 matched GitHub's digest, signed by team 3MU9H2V9Y9 like the
installed app) on 127.0.0.1:11435 with its own HOME and models folder; the reader, nomic, granite, all-minilm and `jarvis`
are APFS clones of the live blobs. The live Ollama (0.33.3, :11434) and its models are never touched. One model in memory
at a time across BOTH servers; Dream off; nothing is wired into JARVIS from this trial.

**Part 1 — update risk (same inputs to 0.33.3 and 0.40.3):**
- reader: the 90 user lines of the held-out below through `readmodel._request()` (/api/generate, raw prompt, JSON schema,
  logprobs) → same reading (act + fields) on ≥ 88/90 and confidence within 0.02 on all → "reader unchanged".
- embedders (nomic, granite, all-minilm): all 120 lines → cosine(old vector, new vector) ≥ 0.999 on every line → "unchanged".
- `jarvis`: the option-3 harness (59 requests) against :11435 → 59/59 identical to 0.33.3's answers → "unchanged".
A component that fails its line needs its thresholds re-measured before the live Ollama may be updated.

**Part 2 — decision models, one at a time:** `strands-decider:2b-nvfp4`, `tev1:0.8b`, `laya:latest` (English 421M),
`laya:322m-multilingual-mlx-fp16`. (`kev` needs 0.40.4, not released as stable — not in this trial.)
Set: `data/decision_heldout_v1.jsonl` (built by `build_decision_heldout.js`): 4 questions × 30 lines, 15 true / 15 false
each, 34 Hinglish; labels fixed in the builder; 0 exact and 0 near (word-Jaccard ≥ 0.75) overlap with 732,928 strings
from every file in finetune/data and his episodes (20 lines rewritten until clean). Each line is sent with ONLY its own
question, worded exactly as in the builder (JARVIS's own decision, no kinds of phrasing).
Rule fixed now: a model answers `true` when P(true) > 0.5 — no tuning on this set.
Baseline on the same lines (what JARVIS runs today, live Ollama): act_now = reader round 5 act ≠ none; claims_action =
`replyclaim.replyClaimOf` not none; self_fact = `selffact.isSelfFact`; needs_web = `webintent.needsWeb`.
**Bar for a later wiring trial, per question and per model:** accuracy ≥ 27/30 AND ≥ baseline + 2 lines AND Hinglish
accuracy ≥ the baseline's Hinglish accuracy; for act_now also no more "true" on non-requests than the baseline. Runtime:
median single-question call ≤ 1.0 s warm on this M1, model resident ≤ 1.5 GB, free memory never below 20%.
Passing earns a SEPARATE pre-registered wiring trial on a fresh set — not a deploy. This set is read after one run.

**RESULT (2026-10-13, one run each, labels fixed before the run; files in `runs/decision_20261013/`):**
Part 1 — update risk, 0.33.3 vs 0.40.3 on the same cloned blobs: reader 90/90 same reading, largest confidence change
0.002, same speed → UNCHANGED. nomic / granite / all-minilm: cosine 1.000000 on all 120 lines → UNCHANGED. `jarvis`:
59/59 identical (0.40.3 logs "LoRA adapters are deprecated" and serves it anyway) → UNCHANGED. These GGUF models ran
on llama.cpp under 0.40.3, not MLX; no background model upgrade was seen.

Part 2 (correct /30, Hinglish in brackets):

| question | baseline (live JARVIS) | strands-decider 2b-nvfp4 | tev1 0.8b | laya 421m (EN) | laya 322m multilingual |
|---|---|---|---|---|---|
| act_now | 27 (8/10) | 26 (8/10) | 21 (6/10) | 18 (5/10) | 16 (6/10) |
| claims_action | 26 (5/7) | 18 (3/7) | 20 (5/7) | 14 (0/7) | 18 (4/7) |
| self_fact | 25 (7/9) | 20 (4/9) | 25 (7/9) | 16 (4/9) | 15 (4/9) |
| needs_web | 22 (5/8) | **29 (7/8)** | 22 (6/8) | 8 (3/8) | 12 (4/8) |
| acted on a non-request | 2 | 0 | 0 | 0 | 13 |
| median warm call / loaded | — | 367 ms / 1.48 GB | 171 ms / ~0.77 GB | 65 ms / ~0.88 GB | 28 ms / ~0.84 GB |

**Verdict: strands-decider PASSES on needs_web only** (29/30 vs 22/30, Hinglish 7/8 vs 5/8, 367 ms, 1.48 GB, lowest free
20%) → it earns a separate wiring trial on a fresh set (it needs Ollama ≥ 0.40). Nothing else passes; today's lanes win
act_now, claims_action and self_fact. The baseline's 2 acts on non-requests are the live round-5 reader reading "lol that
song slaps" and "kya tum gaana gaa sakte ho" as play — a live risk to fix in round 7. embeddinggemma-2:270m runs on 0.40.3
(768 d, 0.35 GB, ~14 ms/text warm); its accuracy was NOT tested (needs its own pre-registered threshold sweep).
This set has now been read.

### Reranker + nomic v2 — trial (2026-10-14, written BEFORE either model was run on anything)

Why (his idea): Qwen3-Reranker-0.6B and nomic-embed-text-v2-moe "might fix round 5's known bugs". What each can reach:
the reranker as a yes/no judge — a second check before an action runs, or a lane's decision; nomic v2 as the embedder
under JARVIS's own semantic lanes (web, self-fact, the claim reader). Neither changes the reader's own readings.
Downloads (his go): `Qwen/Qwen3-Reranker-0.6B` (Hugging Face, Apache-2.0, 1.21 GB safetensors → finetune/models/, run
with MLX for this trial) and `nomic-embed-text-v2-moe` (Ollama, 958 MB).

**Set:** `data/decision_heldout_v2.jsonl` (`build_decision_heldout_v2.js`), 140 lines — act_now, claims_action,
self_fact, needs_web 30 each (15 / 15), and a new **play_now** 20 (10 / 10: does the message ask JARVIS to start
playing music or audio now? — the class of round 5's wrong action), 40 Hinglish. 0 exact / 0 near (word-Jaccard ≥ 0.75)
against 736,725 strings from every finetune/data file (v1 included) and his episodes; 27 lines rewritten until clean.
Labels are fixed in the builder.

**How each candidate is asked (fixed now):**
- **R = Qwen3-Reranker-0.6B**, with its own prompt from the model card — system "Judge whether the Document meets the
  requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".", user
  "<Instruct>: {the question's instructions}\n<Query>: {the question's true criterion}\n<Document>: {the line}",
  assistant prefix "<think>\n\n</think>\n\n". Answers true when P(yes) / (P(yes) + P(no)) > 0.5. All five questions.
- **N = nomic-embed-text-v2-moe** as BOTH `JARVIS_EMBED_MODEL` and `JARVIS_EMBED_MODEL_ALT` (one embedder for English
  and Hinglish), exemplars and margins unchanged (a drop-in), centroids built fresh into a scratch cache (the live
  state/centroids.json is not touched): needs_web = `webintent.needsWeb`, self_fact = `selffact.isSelfFact`,
  claims_action = the claim reader retrained on nomic v2 by `train_replyclaim.js` (same data, its own CV choices) into a
  candidate weights file (the live weights are not touched). act_now and play_now: not applicable (the reader decides).

**Baseline (live JARVIS today):** act_now = reader round 5 act ≠ none; play_now = reader act ∈ {play, resume};
claims_action = `replyclaim` (live weights); self_fact = `selffact`; needs_web = `webintent` (nomic + granite).

**Bars (as v1):** per question and candidate — correct ≥ 90% (27/30; play_now 18/20) AND ≥ the baseline + 2 AND
Hinglish ≥ the baseline's Hinglish; for act_now and play_now also no more "true" on non-requests than the baseline.
Runtime: R median ≤ 1.0 s per question warm on this M1, peak memory ≤ 1.5 GB; N median embed ≤ 150 ms warm, loaded
≤ 1.2 GB. One model in memory at a time; Dream off. Passing earns a separate wiring trial — nothing is wired from this
one. The set is read after this one run.

**RESULT (2026-10-14, one run each; files in `runs/decision_20261014/`):**

| question (/30, play_now /20) | baseline (live) | Qwen3-Reranker-0.6B | nomic v2 (drop-in) |
|---|---|---|---|
| act_now | 29 (10/10) | 15 (5/10) | — |
| claims_action | 21 (5/7) | 15 (3/7) | 21 (3/7) |
| self_fact | 23 (5/9) | 15 (4/9) | 17 (3/9) |
| needs_web | 25 (6/8) | 15 (4/8) | **28 (8/8)** |
| play_now | 19 (5/6) | 10 (3/6) | — |
| runtime | — | 124 ms/question, 1.43 GB peak (MLX) | 39 ms/embed, 0.59 GB |

**Reranker: fails every question.** Its P(yes) never passed 0.5 on any line (max 0.47), so the fixed rule answered "no"
throughout. Not a harness bug — the model card's own example scores 0.9995 / 0.0 in the same harness. Post-hoc ranking
quality (AUC, info only, not a pass): act_now 0.64, claims 0.72, self_fact 0.50, needs_web 0.42, play_now 0.70 — a
relevance ranker does not judge "this message asks for X" well, so a better threshold would not rescue it.
**nomic-embed-text-v2-moe: PASSES on needs_web only** (28/30 vs 25/30, Hinglish 8/8 vs 6/8, one embedder for English
and Hinglish) → earns a separate wiring trial for the web lane (with strands-decider, which passed needs_web on v1 —
compare the two there). As a drop-in it ties the claim reader (21 vs 21, Hinglish worse) and loses self-facts (17 vs
23: margins tuned for nomic v1 drop 12 real facts) — a re-thresholding would need its own pre-registered trial.
Baseline confirmed round 5's wrong-action class on a fresh line: "tum gaana gaate ho kya" → play. The live claim reader
also flagged "Nice, glad school was fun today!" and "Your last reminder was set on Monday…" as done-claims, and missed
seven real claims ("Messaging Harsimran right now.", "Okay — opening your Downloads folder." …). This set has now been read.
Both removed 2026-10-14 on his word: the reranker to the Trash, `ollama rm nomic-embed-text-v2-moe` (the web-lane wiring trial re-pulls it, 958 MB).

## Casual push — scorer v2, read-only acts without a question, and plain bugs (2026-10-14, written BEFORE the scorer change, before any count in the item-2 measurement was looked at, and before any v4 line exists)

His order: 1 → 2 → 3. Stress set v3 is already read; nothing here is judged on it — v3 is only re-scored so the
trajectory stays comparable. The bar for the push is unchanged: ≥ 98% on a FRESH set (v4), 0 CLAIM, 0 WRONG on no_act.

### 1 · Scorer v2 (`jarvis-os/sweeps/score_casual.js`)

Artifacts found reading every v3 miss:
- **CLAIM was decided by an English verb regex** (`claims()`): a word list, which his rule forbids in sweeps too. It only
  ran when NO decision at all was recorded, so a soft non-acting decision (a recall) hid "Opening GitHub." (v3o21) and
  "Sure, FaceTime with Parth." (v3c02), and it never matched paraphrase or Hinglish ("Theek hai, safari khol raha hoon.",
  "Sure, battery check.", "Snapping a pic of what is on your screen."). Those five were scored FAIL.
- **A compound line whose first step asked a confirm counted FAIL** although JARVIS held the rest for his yes — a
  one-turn sandbox cannot answer the confirm (v3k02/k05/k06/k09).
- **A reader action routed `action:sleep_display` recorded no decision**, so "ss the screen" putting the display to sleep
  scored FAIL instead of WRONG (the only unmapped `action:` route across the dev, v2 and v3 runs).

Rules from now on (every run, every set):
1. **CLAIM is read, not matched.** Every row with no ACTING decision and no confirm gets a claim check; I read the reply and
   record `claim: true|false` in `<run>.grades.json`. A row whose claim is unread stays REVIEW (out of the accuracy).
   `claims()` is deleted. (DEFLECT stays: it matches JARVIS's own fixed sentences, not his words.)
2. **Held compound steps.** A step after a step that asked a confirm counts PASS ("held") only when JARVIS's own log says
   it is holding the rest (`Chat › clause K/N is asking — holding the remaining …`), the asking step itself judges PASS from
   its confirm, and the matching held clause in JARVIS's own split line (`Chat › clause routing (N): a | b`) contains every
   label value of that step (target / to / query_has / body_has / what_has). Anything else stays as judged.
3. **Every action route is a decision.** `action:sleep_display` maps to an acting decision; any single-act line where a
   DIFFERENT acting decision ran is WRONG (the scorer's own definition: "acted on the wrong thing"), now for the generic
   kinds too (file acts, screenshot, why, undo, quiz…), not only open/close/message/call. play_music vs play_video keep
   their own rule (a song played as a video is FAIL, the same kind of action).
4. **Media control in the sandbox** (convention, hand grade, unchanged code): Spotify cannot be reached, so the right
   control attempted = PASS.

v3 is re-scored under v2 (claims read by hand for every checked row) and reported next to the old 226/325 = 69.5%.

### 2 · Read-only reader acts run instead of asking

Today a reading whose least likely token is in [ASK_FLOOR 0.3, MIN_CONFIDENCE 0.75) is put to him as a question
("Should I check the weather, Sir? Say “check”"). For an act that only REPORTS — nothing is sent, opened, closed, written
or deleted — the question costs a turn and protects nothing: a wrong report is visible and harmless. v3 lines lost this
way: w03, w04, w08 (weather), l05, l08 (calendar). **Change:** in `readmodel.build()`, acts in `READ_ONLY` (from the
reader's own act registry ACTS, no words): weather, calendar, system_status, list_running, list, read, search_files,
study_stats, dream_log — run in that band instead of asking. screenshot stays out (it writes a file). Below 0.3 nothing
changes (unread); every other act still asks.

**Measurement, decided before counting:** rows = the round-5 hold-file dump (`runs/reader_round5_eval_rows.jsonl`, 442
rows, 7 sets; MLX adapter — the live q8 export's confidences can differ slightly) + `runs/reader_round5_on_r6valid_rows.jsonl`
(50) + the dev, v2 and v3 casual runs' `reader:ask` rows whose asked action is read-only (labelled). Count readings that
are read-only with minp in [0.3, 0.75): RIGHT = act and fields right (verdict exact / casual label PASS once it runs),
WRONG = anything else (a wrong field such as "weather in school", or a read-only reading of a line that wanted a
different act or nothing). **Ships if RIGHT ≥ 3 × WRONG pooled, AND no more than 2 WRONG on lines whose label is
none/chat** (an unasked report on chat is the visible cost). Then a sandbox rerun of the affected casual ids must add
0 WRONG and 0 CLAIM. Fails → reverted, nothing live.

### 3 · Plain bugs (code, not models)

Each fixed only where the cause is in code (not a reader misread — those go to round 7), with a unit test where one
fits, then a sandbox rerun of just those ids on the dev/v3 runs (read sets — this is a bug check, not a judgement):
"close the notes app" (v3x07: a stray optional field refused the reading ~10× and the agent then printed "Running (0):");
a play with no music/video flag going to the arbiter / YouTube (v3p01, v3p12; v2p05/p13/p18/p22); the composer changing
his message words (v3m23, v3m35); "read notes.txt for me" answered with the Dream log (v3f11); "delete old_resume.pdf"
asking which file (v3f03/f04 — first check the sandbox has the file; if not, it is a label/fixture problem, not a bug).

**RESULT 1 · scorer v2 (2026-10-14):** v3 re-scored with every claim read by hand (193 rows; grades in
`v3-20261011-r5veto.grades.json`, old scored/grades files in `backups/finetune/data/casual_runs/*.bak-scorer-v1-*`):
**229 / 325 = 70.5%** (English 73.1, Hinglish 52.4) · **CLAIM 9** · **WRONG 2** — was 226 = 69.5%, CLAIM 2, WRONG 1.
Claims read: v3c02 "Sure, FaceTime with Parth.", v3o16 "Opening ChatGPT.", v3o18 "Opening Mail.", v3o21 "Opening GitHub.",
v3o24 "Theek hai, safari khol raha hoon.", v3y01 "Sure, battery check.", v3f07 "Snapping a pic of what is on your screen.",
v3u09 "I will put it in the form of a chat message … until you say send" (nothing pending), v3z20 "Okay, forgetting."
(borderline — he meant drop it — counted strictly). WRONG: v3b08 (hand) + v3f08 "ss the screen" → display slept. Held
compound steps: compound 3 → 7 / 9 (k02/k05/k06/k09). Hand verdicts now live in the grades file (`verdict`): v3u13 PASS
(asked first), v3z08 FAIL (offered, did not act), v3b08 WRONG. dev and v2 are NOT re-scored yet (their claims are unread).

**RESULT 2 · read-only acts without a question — FAILS its bar, not shipped (nothing was changed in readmodel.js).**
Read-only readings in [0.3, 0.75): hold dumps 3 RIGHT / 1 WRONG ("aaj ki tareekh batao" → calendar "aaj"); casual runs
5 RIGHT (v2w08, v3w04, v3w08, v3l05, v3l08) / 8 WRONG (v2s13 lyrics → Mac file search, v2t06 "kitne baje hain" → weather
"in kitne baje", v2u05 why → status, v2f10 desktop → running apps, v2u10 briefing → calendar, v3m08 a message → file
search, v3w03 weather "in school", v3g02 "wsg gng" → status on chat). Pooled 8 RIGHT / 9 WRONG — the bar needed
RIGHT ≥ 3 × WRONG. The question in that band is doing its job; the five lost lines need a more confident reader (round 7
rows for casual weather/calendar), not a policy change.

## Regression gate + fixes A, C, D (2026-10-14, written BEFORE any fix was applied or measured)

His order: no more training rounds; fix bugs in code, without regression, no keyword traps, no rule broken. Patterns
taken from open-source harnesses (memory project_harness_borrow_20261014): DeepSeek dsh (replay tests, read-only sandbox
level, one record of what ran), OpenHands stuck detector (a repeat counts only with the same observation), goose/MCP
read-only annotations (computed per run — goose's CVE was a persisted one), smolagents final_answer_checks.

**The gate.** Every labelled line — `casual_bugs_live.jsonl` (20: his three live bugs of 2026-10-14 + the handoff test lines
+ known reader misses), stress v3, v2 and the dev set (all already read; used here only to catch regressions, nothing is
judged on them) — through `sweeps/sweep_casual.js` (cannot act), Dream off. Baseline `gate-base-20261014-*` on the code of
2026-10-14 21:03 (after the dream-lane fix). Compared per line with `gate_diff.py`: scorer-v2 `base` verdict and JARVIS's own
route / decision / confirm record.

**Ship rule for each fix (pre-registered):** 0 lines LOST (PASS → anything else), 0 NEW-WRONG, every line whose decision
or reply changed read by me, and the target lines fixed. Unit tests for the fix + run_all green. Fails → reverted, nothing
live. Sampling noise: a LOST line whose route and decision are unchanged and only the model's wording moved is re-run once;
it counts as LOST only if it fails again.

- **A · read-only procedures under the veto.** Target lb03 (dental clinics → find_businesses). playbook.js `readOnly` list
  on find-businesses (JARVIS's own registry); server.js keeps a matched procedure under readerNone only if it is read-only;
  agent.runGoal walls the run to that list (`strictTools`: out-of-list tools deleted from the per-run table, taught replay
  skipped, fixed plans outside the list skipped). Unit test `tests/test_readonly_veto.js`.
- **C · the model is told nothing ran, before it writes.** Target: claims on chat-route lines (live lb03/lb05/lb10; v3's
  read claims). The redraft note ("Nothing was done on this turn. Reply in words only, without saying you did, are doing or
  will do anything.") goes into the FIRST plain-chat draft too (end of the system prompt). A fact about the turn, no words of
  his. Extra bar for C, because it touches every chat reply: claims read by hand on every chat-route line of the after run
  must be fewer than the baseline's (read the same way), and no chat reply that I graded fine in the baseline may turn into a
  refusal, a deflection or a wrong answer (every chat-route reply read).
- **D · a repeated look is progress when its answer changed.** agent.js loop guard: a call outside SIDE_EFFECT_TOOLS that
  repeats is run again and compared — same answer stops (as before), a different one carries on; a repeated side effect
  stops before running, unchanged. Target: "explore runs claim done after one step". The corpus cannot reach browser runs,
  so the measure is `tests/test_repeat_progress.js` (it FAILS 3/6 on the code before the fix — reproduced 2026-10-14) plus
  run_all; the gate only has to show 0 LOST / 0 NEW-WRONG.

### B · timed requests — "open notes in 2 minutes" (2026-10-14, written BEFORE the held-out, the exemplars or any code)

His live turns: "open the app store in about a minute" → the why lane ("nothing to explain"; the reader read none);
"open notes in 2 minutes" → the reader refused the reading ("it leaves out 2") → the agent's teach offer. JARVIS already has
the scheduler (automations with `task.goal`, fired through agent.runGoal; an outbound step waits for his yes). What is
missing is the decision "now or later", and it must be semantic: EXPLICIT_TIME_RE and the every|each|daily regex are traps
and are NOT reused (pattern from OpenClaw's automations: the model fills structured time, the code does the arithmetic).

**Design.** Two stages, asked on plain turns before the why lane:
1. `timedintent.js` — a region classifier on nomic (intent.js makeClassifier, exemplar sentences, cosine; the same
   mechanism as whyintent / reasonintent), regions: a request for later · a request for now · not a request. Exemplars are
   written for this file only and checked against the held-out (no exact / near copies).
2. Only on a "later" region hit: the local model with a JSON schema answers JARVIS's own decision — run now, or schedule it;
   if scheduled: minutes from now, or the local clock hour/minute and today/tomorrow; and the task to run, in his words.
   The question names JARVIS's outcome and the fields, never kinds of phrasing. JARVIS computes the time; a reply says
   exactly when it will run and that it is scheduled (no claim that it already ran). Reminders are NOT this: a reminder
   request stays with the reminder lane (no alarm, honest).

**Held-out** `data/timed_heldout_v1.jsonl` (built by `build_timed_heldout.js`, overlap-checked against every file in
finetune/data and his episodes, exact 0 / near 0 required before it is written): 60 lines, about a third Hinglish —
30 later-requests (delays and clock times, several kinds of task), 30 others: now-requests that contain numbers or times
("set the volume to 40", "play a 10 minute meditation"), questions about time, statements with a time in them ("class
starts at 9"), and reminder requests. Labels fixed in the builder.

**Bars (whole pipeline, stage 1 + stage 2, run once on the held-out):** later-requests scheduled ≥ 27 / 30; others
scheduled = 0 (a now-request that waits is a silent failure; a statement scheduled is a WRONG); for the scheduled ones the
time within ±1 minute of the label (delays) or exact (clock times) on ≥ 90%, and the task names the right thing on ≥ 90%.
Plus the gate (it runs on every plain turn): 0 LOST, 0 NEW-WRONG, lb01/lb02 scheduled. Fails → not wired; nothing live.

**D, corrected before any gate run (2026-10-14 22:5x):** as first written D let any tool OUTSIDE SIDE_EFFECT_TOOLS run again on a
repeat. test_stress caught it ("an identical repeat is not executed twice": got 2) — and the cause is real: volume, brightness,
screenshot, sleep_display, open_app, open_url, screen_press, install_app and uninstall_app are not in SIDE_EFFECT_TOOLS, so D would
have re-run a volume step or an uninstall. Reworked to an explicit LOOK_TOOLS list (JARVIS's own tool names that only observe:
screen_elements, list_running, list, read, search, system_status, read_clipboard, list_events, find_free_slot, find_contact);
every other tool keeps the old stop-on-repeat rule. test_repeat_progress gained the volume case (8/8). A's wall, controlled:
WITHOUT strictTools the scripted loop did reach send_message (stopped only by the invented-recipient guard); WITH it,
send_message was unreachable and find_businesses ran. run_all: 2,963 assertions in 43 suites, all green.

**RESULT — gate after A + C + D (2026-10-14 22:43–23:49, `gate-after-ACD-20261014-*`, 995 lines):** PASS 531 → 533, LOST 6,
GAINED 8, NEW-WRONG 0. Target lb03 fixed (find_businesses ran under the read-only wall; honest result). One stop: free memory
fell to 12% at v3 235/325 (the sweep's own 15% floor) — same model-load pattern as the baseline (3B loads 17 vs 19), resumed.
**C FAILED its bar → reverted.** Claim-guard "false completion" blocks 25 → 30, canned "Nothing was done on my side" 7 → 12,
false-action blocks unchanged (14 → 14): the note did not stop claims ("On it — opening GitHub." still drafted) and made honest
replies trip the claim reader ("I have not done that, Boss. Want me to now?" → blocked). Re-run of the 6 LOST + 12 newly-refused
lines on A + D (C reverted): 12 of the refusals came back to good replies (lb06, n06 "No — I have not. Should I?", b06 "No — Friday
is not today.", v2e13 "Huge win — proud of you." …) — C caused them. Still failing after the re-run, all on paths A and D do not
reach: v3m29 (the message composer invented a body — the same run GAINED 4 composer lines, flaky both ways: bug c), v2q21 (research
wording), v2q09 (weather answered in all three runs; the baseline passed by a scorer accident), v3e13 (claim-reader false flag on a
congratulation). **A + D shipped live 2026-10-15 00:0x** (run_all 2,963 / 43 suites green, integrity 337, JARVIS restarted).
Lesson: a prompt sentence on the chat model's own first draft moves the claim reader's false flags more than it moves claims.

## Business finder — the place he named, once, no learning from a walled run (2026-10-15, his live turn)

"find resturants near me without a website" → A's path worked (reader none → read-only find-businesses, walled), but the 3B
wrote where="around me" (not his words; Nominatim: a theatre in Iraq — "near me" is a park in Mexico), called find_businesses
twice (the second only added needPhone; the reply carried both answers, 69.9 s), and JARVIS learned the double call as
"view:resturants-near". Fixed (shape checks + JARVIS's own registry, no words): `where` must be in what he said AND the map's own
name for its match must carry every word of `where`, else the search goes around him and says it could not place the name;
playbook `once: ['find_businesses']` ends the run on the first result; no learning from strictTools runs.
tests/test_bizfinder_where.js 10/10; run_all 2,973 / 44 suites; sandbox live set 0 LOST / 0 NEW-WRONG, lb03 one call, 6.8 s.
Live 2026-10-15 12:0x. Not changed (his call): the Maps half needs an open normal Brave window (braveRead never opens one).
Left in state/learned.json: the junk hypothesis "view:resturants-near" (asked him before touching state).

**RESULT B (2026-10-15, `runs/timed_20261014/heldout_run.json`, held-out run once — now READ): FAILS every bar → NOT wired.**
Stage 1 (nomic regions): leave-one-out found no margin that separates later-requests from the look-alikes — at 0 false-later
it catches 0/18 of its own exemplars ("close the browser right now", "set brightness to 50", "terminal chalu karo" sat closer to
`later` than real later-requests). Pipeline 0/30 later scheduled, 0 others. Stage 2 alone (diagnostic): the 3B answered
run:"now" for almost every later-request even while extracting the delay ("close safari in like 10 minutes" → run now,
minutes_from_now 10) and dropped the delay on most; 1/30 later, 2 others scheduled, 2.4 s median. Same lesson as the clock lane:
an embedding region does not carry time, and the 3B does not decide it reliably under a schema. timedintent.js stays unwired
(kept for the record; nothing requires it). Next try needs a fresh held-out v2 and a different decider (see memory).

## Composer model — which local model rewrites his message faithfully (2026-10-15, written BEFORE the held-out or any run)

Why: agent.composeStrict (the strict message composer, qwen2.5:3b through llm()) invents and drops content — "asking if he got my
email" → "let me know if you need any help with it" (v3m29); "…needs anything from the market" → "let me know what she needs"
(v3m23); rewrites adding "breakfast", "pasta dinner", "aisle", "exactly" fall back to his words verbatim, which reach the other
person in the third person ("if she needs anything from the store"). He sees every draft before Send, so nothing wrong is sent,
but the lines fail and flip run to run (the gate's composer lines moved both ways). A word-level dropped-content check would
need pronoun lists (a trap) — so the measured fix is the model.

**Candidates:** qwen2.5:3b-instruct-q4_K_M (today), phi4-mini:latest (installed, the live reasoner), jarvis (Bonsai-4B + v4.2,
installed). Same composeStrict code and prompt for all (the model is the only change), temperature as llm() uses it.
**Held-out** `data/composer_heldout_v1.jsonl` (`build_composer_heldout.js`, overlap-checked against every file in finetune/data
and his episodes, exact 0 / near 0): 30 message instructions in his register, about a third Hinglish, each with the body the
reader cuts out (reported "asking if…", "saying…", plain bodies, Hinglish bodies, times and numbers in the body) and the facts
that must survive.
**Graded by reading every draft, blind** (model names hidden, order shuffled; grades saved before the key is opened): a draft
is FAITHFUL when it is a message to that person, says everything the body says (facts, times, numbers) and nothing else, and
addresses them directly. **Choosing rule:** the model with the most FAITHFUL; it replaces qwen for composeStrict only if it beats
qwen by ≥ 5 / 30, invents nothing on ≥ 28 / 30, and its median time is ≤ 6 s warm on this M1. Otherwise nothing changes. A
switch then goes through the gate (message lines must not lose; 0 NEW-WRONG).

**RESULT composer (2026-10-15, `runs/composer_20261015/`, graded blind before the key was opened; held-out now READ):**
faithful qwen2.5:3b **19 / 30** (invented nothing 27, Hinglish 8/10, median 1.4 s) · phi4-mini 18 (26, 8, 2.1 s) · jarvis 15 (24, 7,
1.0 s). No candidate beats qwen by ≥ 5 → **nothing changes**. What the failures are: mostly the fallback that keeps his reported
words as they are ("if she finished the english essay", "whether the new specs are comfy" — indirect, third person; qwen 11
verbatim), then wrong person ("Can he return my charger by Friday?"), questions turned into claims ("Tell Parth the match got
postponed."). A model swap does not fix it; the reported-speech fallback is the thing to change (next idea: when the reader marked
the body `reported` and the rewrite failed, ask what the message should say instead of sending indirect words — measure first).

## Deep-research offer on a close call → answer quickly instead (2026-10-15, written BEFORE the change was measured)

"Quick answer, Sir, or shall I go away and research that properly for twenty minutes?" was asked on 8 corpus lines and none
wanted deep research: "who wrote dracula", "who wrote the hunger games", "which scientist figured out gravity", and chat —
"ill text parth later", "exams r killing me", "bhai took my charger", "kya baat hai tu toh genius hai", "idk what to do with my
life lol". researchintent's scores on them are flat — every region within ~0.01–0.03 (dracula: deep 0.460, quick-lookup 0.453);
the case the 0.01 band was built for ("really investigate whether creatine does anything": quick 0.554, deep 0.552) is just as
flat, so no threshold separates them honestly (and tuning on read lines is fitting). **Change:** `maybe-deep` no longer asks; the
turn carries on as an ordinary lookup/chat. A clear `deep` still starts deep research; he can always say "research it properly".
**Known cost:** researchintent's own held-out had 2 lines that asked; they now get the quick answer. **Bar:** the gate — 0 LOST,
0 NEW-WRONG, and the 8 lines no longer get the offer.

### Reader round 7 — `when`, the open/play/statement misreads, and the `time` act again (2026-10-15, written BEFORE any round-7 row)

His word: "just get it fixed" (one targeted round, after "stop spamming training rounds"). Starts from `adapters/reader_round5`
(round 6's adapter is gone), same hyper-parameters, ONE epoch.

**Why (read misses, with ids):** open requests read as none — "open my mail" (v3o18/lb05), "open my gmail inbox" (v3o13/lb09),
"open github i wanna push my code" (v3o21/lb10), "open chatgpt i got a doubt" (v3o16), Hinglish "jaldi se safari khol" (v3o24),
"mere notes khol do zara" (v3o25) — the veto then blocks act-instead and the chat model claims "Opening X."; talk about music
read as play — "lol that song slaps" (lb04), "tum gaana gaate ho kya" (lb07), "kya tum gaana gaa sakte ho" (lb08); Hinglish volume
"itna tez mat chala, kam kar" → play (v3b08, the one WRONG); statements read as a message — "harsimran says hi" (v3z08), "chal bye
kal baat karte" (v3j08); "ss the screen" → sleep_display (v3f08); "close the notes app" refused (an `as` on close — not allowed);
asks on readings it had right (casual weather/calendar, artist + song, "previous song"); and timed requests with nowhere to go —
"open notes in 2 minutes" (refused: "it leaves out 2"), "open the app store in about a minute" (read none). B (embedder + 3B)
failed for those; the reader is the one model that reads every turn.

**Schema (label_batch.py + readmodel.js FIELDS + LABELING.md, together):** a new optional `when` on open, close, play, message,
call, search_web, screenshot, pause, resume, next_track, volume_up, volume_down — the words saying WHEN to do it, copied ("in 2
minutes", "at 9 tonight", "10 minute baad", "kal subah 7 baje"). NOT `when`: a time inside a message body ("text mama saying im
on my way in half an hour" → body), a length in a query ("play a 10 minute meditation"), reminders (remind keeps its own `when`),
statements. `as` (site/app) allowed on close too ("close the notes app" → as app). The `time` act stays (round 6's rows and
relabels are still in the data; its server code is on branch `time-act`, merged to main only if round 7 is kept).

**Hold file, written first:** `data/round7_valid.jsonl` (`build_round7_valid.py`): 60 lines — 12 with a `when`, 8 that mention a
time but take no `when` (body / query / reminder / statement), 10 `time`, 30 of the misread shapes above; checked against every
casual set, the live bug set, every hold file, timed_heldout_v1, composer_heldout_v1 and the generated rows (exact 0, near 0).
**Conversion set, written first:** `data/when_phrases_v1.jsonl` — 30 `when` phrases with the minutes or clock time they mean.

**Data:** `gen_round7.py` → new sentences for these shapes (training material — never read at runtime; every value cut from its
sentence; refuses any line of the sets above; near copies dropped), weighted ×2. Built like round 6 with `--hold
data/round7_valid.jsonl` added and every set above `--exclude`d.

**Choosing — fixed now:** the final save is kept only if, by `eval_reader.py`: six round-4 hold files WRONG ≤ 30 and exact ≥ 365
(round 5: 372 / 4 / 8 / 28); round5_valid exact ≥ 25, WRONG ≤ 3; round7_valid exact ≥ 48 / 60, WRONG ≤ 3, with ≥ 10 / 12 `when`
lines exact, 0 of the 8 look-alikes given a `when`, ≥ 8 / 10 `time` exact. round6_valid is reported for the record only (read).
**Kept →** exported as `jarvis-reader-r7` (new name; nothing live changes); the server learns `when` (the reading's action is
scheduled through the existing automations; the `when` words are turned into minutes or a clock time by the local model under a
JSON schema — measured on when_phrases_v1: ≥ 27 / 30 exact, otherwise the reply says plainly it cannot run things on a timer and
offers to do it now) and the `time` act (branch time-act, its unit tests); then the full gate with r7 in the sandbox: 0 LOST
beyond noise, 0 NEW-WRONG, the target lines above fixed. Then live (his word given: "just get it fixed").

**RESULT — research change + reader-ask change, gate `gate-fix2-20261015-*` (995 lines):** PASS 531 → 534, NEW-WRONG 0, GAINED 8
(lb03, lb18 "who wrote dracula", lb20 "look up dentists near me that have no website", v3q15, q05 "who wrote the hunger games", composer
flakes). LOST 5; re-run once: v2q20 and w06 pass; v3q14 ("how many hours in 2 days" — the reasoner answered from his school hours)
and v3t03 ("time in london rn") fail AGAIN on the pre-fix server.js too (swapped in for the sandbox only, hash-restored) — drift since
the baseline, not these changes; m11 (composer) passed 2/2 more. **Shipped 2026-10-15 ~14:00.**

**RESULT — when-phrase converter (timedintent.convertWhen, qwen2.5:3b, `runs/when_20261015.json`; when_phrases_v1 now READ): 15 / 30 →
FAILS (bar 27).** Every clock time came back "not exact": the model filled hour/minute right ("at 9 tonight" → 21:00, "at 7am" → 7:00)
and then set exact:false; Hinglish is wrong outright ("raat 11 baje" → 23:11, "aadhe ghante mein" → 60 min). Vague phrases were all
right (null). Until a converter passes, a reading with `when` gets the honest "not a time I can set" ask — never a guessed time.

**RESULT reader round 7 (2026-10-15 18:00, final save 9,543 iters from round 5; `runs/reader_round7_eval.log`, rows
`runs/reader_round7_eval_rows.jsonl`; every round7_valid row read): NOT KEPT — two bars fail.** Round 5 stays live; nothing exported.
- six round-4 hold files **374 exact / 7 MISS / 7 REFUSED / 24 WRONG** (bars ≥ 365, ≤ 30 ✓; round 5 372 / 4 / 8 / 28) · round5_valid
  28 / 1 / 0 / 1 ✓ · round6_valid (record) 41 / 3 / 1 / 5.
- **round7_valid 50 exact / 4 MISS / 0 REFUSED / 6 WRONG** — exact ≥ 48 ✓, **WRONG ≤ 3 ✗**; `when` 10 / 12 ✓; look-alikes given a
  `when` 0 / 8 ✓; **time 7 / 10 ✗** (bar 8). Round 5 on the same file (record): 26 / 17 / 0 / 17, `when` 1 / 12, time 0 / 10.
- The six WRONG, read: three change what happens — "samay bata do abhi ka" → a MESSAGE to "samay" (body "abhi ka"); "raat 11 baje gaana
  band kar dena" → close an app "gaana" (label pause); "play a 15 minute yoga video" → play without `video` (music, not YouTube). Three
  are field details — "some arijit" → "arijit"; "open my mail app pls" without `as: app`; calendar `when` "kal free hoon" for "kal".
  The time MISSes: "which date is it today bro i lost track", "london mein kya baja hai"; other MISSes "yo get my gmail inbox up on
  screen", "capture whatever is on my screen rn".
- The bar is the pre-registered one; it is not moved after reading. Keeping round 7 anyway would be his call.

### Converter v2 (2026-10-15, written BEFORE when_phrases_v2 or any v2 run)
Fresh set `data/when_phrases_v2.jsonl`: 40 phrases (16 delays, 16 clock times, 8 vague; a third Hinglish), none from v1. Candidates, one
run each, temperature 0, the same JSON schema WITHOUT the `exact` flag (vague = both delay and clock left null; the prompt names
JARVIS's decision — "give the time these words set, or leave both empty if they set none" — never kinds of phrasing): qwen2.5:3b,
phi4-mini, jarvis. **Choose:** the most exact; ships only if ≥ 37 / 40 with 0 vague phrases given a time (a guessed time is worse than a
question) and median ≤ 3 s warm. Measured after reader round 7 has trained (no model loads during training).

## Scorer v3 — time, weather and message bodies read by hand (2026-10-15, his order: "replace the time/weather regex and the invented-words length check with hand reading, no models")
Three shape checks in `jarvis-os/sweeps/score_casual.js` passed or failed a reply by the words in it — natural-language lists, which
his rule 1 forbids in measurement scripts too:
- `time`: PASS when the reply held a clock-shaped number or a weekday NAME (and nothing acted).
- `weather`: PASS when a weather fetch was on record OR the reply held °/degrees/rain/sunny/cloud/clear/humid/forecast.
- `message`: FAIL when the body held any word of 5+ letters missing from his message ("invented").

Rules from now on (same pattern as CLAIM in scorer v2):
1. **time** — acting on a time question stays FAIL; otherwise REVIEW, settled by `pass` in `<run>.grades.json` after reading whether
   the reply tells the time asked, correct for when the row ran (estimate it from the run file's end time minus the later rows' `ms`).
2. **weather** — a weather fetch on record (reader:weather route, a weather place, an open-meteo/wttr read) stays PASS; otherwise
   REVIEW, settled by `pass`.
3. **message body** — once the person and his words (`body_has`) are right, the body is read: `invented: true|false` (+
   `invented_note`). `invented: true` → FAIL. Unread → shown REVIEW with `base` PASS (like an unread claim), so `gate_diff.py`
   still compares decisions; `gate_diff.py` now puts the message body into the decision, so a changed body is listed as a
   DECISION line and gets read.
4. A compound line whose steps are all PASS/HELD except time/weather steps waiting for a read is REVIEW (was FAIL).

**RESULT (both gate baselines re-scored; old scored files in `backups/finetune/data/casual_runs/*.bak-scorer-v2-before-v3-*`,
grades files backed up as `*.bak-scorer-v3-hand-reads-*`):** 49 time/weather rows and 217 message bodies (119 unique) read by hand.
Base verdicts moved on 12 rows, all PASS→FAIL, none the other way:
- time regex FALSE PASSES 3: base v3t03 "time in london rn" → "1:14 PM" (real ~16:44 BST); v2t04 "which day of the week is it" →
  "Friday." on a Wednesday (base) and on a Thursday (fix2). The weather regex changed nothing (every unfetched row was an ask or a
  "no information" reply).
- length check MISSED 7 invented bodies, flagged 0: "dm mama asking what time dinner is" → "Let's grab dinner at 7?" / "Let's set
  a time for dinner?"; "…what time the movie starts" → "…so I can plan my day."; "asking if he got/finished X" → "send me X" ×3;
  "text her instead saying im busy" → "text harsimran it's busy here". Verbatim reported-speech fallbacks ("if he ate dinner") are
  noted in `invented_note` but are not invention (composer bug, separate).
- Gate base-20261014 → fix2-20261015 under v3: PASS 526 → 529, LOST 5, GAINED 8, NEW-WRONG 0. Newly visible LOST: v3m09 only (the
  composer invented "so I can plan my day" in the fix2 run — composer path untouched by fix2, the known flaky composer bug); the
  other four (v3q14, v2q20, m11, w06) were already LOST under v2.

## Composer v2 — ask instead of sending his indirect words (2026-10-15, written BEFORE composer_heldout_v2 exists and before any model saw it)
Why: when the reader marks a message body `reported` ("asking if he ate dinner" → `if he ate dinner`), agent.composeStrict asks
qwen2.5:3b for the direct message, twice; if both drafts are rejected it sends his indirect words as they are, so the confirm card
says "if he ate dinner" to his brother. The idea (README "Composer model", result): ask what the message should say instead.
**But "rejected" is decided by `invented()` — any draft word of 5+ letters that is not in his words.** That is the same
natural-language length check scorer v3 removed from the scorer today (his rule 1 covers runtime first), and the scorer v3 reads
show it failing both ways: it rejected rewrites and fell back to his words 13 times in the two gate baselines (7 + 6, JARVIS's own "using his words" log line) and accepted invented
ones ("Let's grab dinner at 7?", "send me the notes" for "asking if he got the notes" — 7 bodies, no new 5-letter word). An ask
built on it would fire on the wrong drafts. So the change under test replaces the detector AND the fallback, together:

**Candidate C:**
1. `invented()` is deleted. A draft is accepted only when a JUDGE says yes to one fixed question, asked as a fresh turn and read
   from the answer token's probabilities (logprobs, the way grounded.checkVerdict reads jarvis's yes/no):
   `HIS REQUEST: <his whole message>` / `THE PART TO PASS ON: <the body the reader cut>` / `DRAFT TO <recipient>: <draft>` /
   `If JARVIS sends this DRAFT to <recipient>, does it pass on what he asked — all of it and nothing more, said to <recipient>
   directly? Answer yes or no.` Accepted when P(yes) / (P(yes) + P(no)) > 0.5 — fixed, not tuned (any other threshold needs a
   fresh set). The question names JARVIS's own decision only.
2. Two drafts, as today. If neither is accepted and the reading marked the body `reported`: JARVIS asks
   "What should the message to <name> say, Sir?" (the ask composeStrict already uses for noVerbatim) and sends nothing.
   A body not marked `reported` is unchanged (his words as they are).
3. The composer's own prompt is NOT changed in this trial (one change at a time). Flagged, not fixed: it lists kinds of
   addition ("no greeting, no sign-off, no reason, no feeling, no emoji, no extra question") — a category list in a prompt.

**Judges (one model in memory at a time, measured one after the other):** J1 qwen2.5:3b-instruct-q4_K_M (the composer's own model,
already warm — no swap); J2 jarvis on runtime/llama-server (the grounded-answer judge; costs a swap from qwen). The 3B composer
itself stays.

**Held-out** `data/composer_heldout_v2.jsonl` (`build_composer_heldout_v2.js`): 40 message instructions whose body the reader
would mark `reported` — 26 English (questions with if/whether/when/where/how much, requests "ask X to …", statements about the
recipient "tell X that his …"), 14 Hinglish ("… se puch ki …", "… ko puch ki …"); times, numbers, third people, slang and a
reason inside some bodies. Written for this file only; overlap-checked (exact and ≥ 0.75 word-Jaccard) against every file in
finetune/data — composer_heldout_v1 and the gate sets included — and his episodes. `keep` on each row is a reminder for the reader
of the drafts, never an automatic score.

**Procedure (so both policies see the SAME drafts):** (a) qwen2.5:3b writes the two drafts per row with the real composer prompt
(the two tries today's code makes); saved first. (b) Baseline B = today's agent.compose({strict}) run with an llm stub that replays
those two drafts in order (the real code decides — no detector copied into the sweep). (c) C(J1), C(J2) = the candidate code with
the same stub for drafts and the real judge model for the yes/no. (d) Every text that could reach the confirm card — draft 1,
draft 2 and the body as it stands — is graded BY READING, BLIND (row order shuffled, source hidden) and the grades saved before any
policy outcome or judge verdict is opened: FAITHFUL = a message to that person, said to them directly, carrying everything the
body says (facts, times, numbers, his slang) and nothing he did not say; also marked INVENTED (adds content) / INDIRECT (talks
about the person instead of to them).
**Outcome per row and policy:** SEND-OK (the text on the card is FAITHFUL) · ASK · SEND-BAD (the text on the card is not
FAITHFUL — the indirect fallback counts here).

**C ships only if, for one judge, ALL hold** (best = fewest SEND-BAD, then faster):
1. SEND-BAD(C) ≤ 3 / 40 and ≤ half of SEND-BAD(B).
2. Lost sends ≤ 3: rows SEND-OK under B that are not SEND-OK under C.
3. Accepted INVENTED drafts = 0.
4. Hinglish (14): SEND-BAD(C) ≤ 1.
5. Added time per message (median, warm, his apps open on this M1, the swap included for J2) ≤ 1.5 s.
Then the regression gate: message lines must not lose, 0 NEW-WRONG, every changed body read (gate_diff lists them). If no judge
passes, nothing changes; ideas for a next try need a fresh set. Measured after reader round 7 (no model loads during training).
**Composer v2 — how the code and the sweep do it (written 2026-10-15 15:14, before any draft or judge answer exists; bars unchanged):**
- Code (behind `JARVIS_COMPOSE_JUDGE=1`, OFF; nothing live changes): agent.js composeStrict — with the flag on, invented() is not
  used; `judgeDraft` asks `deps.judge` (server.js `composeJudge`: model = `JARVIS_COMPOSE_JUDGE_MODEL`, else the local model the
  composer runs on) and reads the yes share with grounded.checkVerdict. The question's "HIS / he" come from profile.pronouns(), so it
  reads exactly as above for him. The judge call uses the context the model is already loaded with (qwen 8192 like the composer,
  jarvis the chat reply's 4096) — a different num_ctx reloads the model. The reader door and the agent path pass `reported`.
  Flag off = byte-identical results on 195 stub scenarios against the pre-change agent.js; tests/test_composer_v2.js 27/27 (no model).
- Sweep `jarvis-os/sweeps/sweep_composer_v2.js` (drafts → judge J1 / judge J2 → blind grades → score). Drafts at qwen's own default
  temperature (as live — llm() sends none), each written once and replayed. J2 runs on its own llama-server port (11437), never the
  live one. **Added time** per row = C's model time − B's model time (drafts written + every judge call the code made; for J2 also
  the eviction of qwen and qwen coming back after each judge call); bar 5 is on the median of that.
- Known limit, not in this trial: the ask is not threaded — his answer to "What should the message to X say?" is a new turn (the same
  as today's noVerbatim and no-body asks).

**RESULT composer v2 (2026-10-15 18:25; `runs/composer_v2_20261015/`, 102 texts graded blind and saved 18:06 before the key or any
judge answer was opened; held-out composer_heldout_v2 now READ): NO JUDGE PASSES — nothing changes, the flag stays off.**

| rows 40 | SEND-OK | ASK | SEND-BAD | lost sends | accepted INVENTED | Hinglish SEND-BAD | added median |
|---|---|---|---|---|---|---|---|
| B (today) | 10 | 0 | 30 | — | — | 11 / 14 | (1.4 s total) |
| C(J1) qwen 3B | 11 | 5 | 24 ✗ | 1 ✓ | 3 ✗ | 10 ✗ | 0.85 s ✓ |
| C(J2) jarvis | 8 | 12 | 20 ✗ | 3 ✓ | 2 ✗ | 9 ✗ | 5.1 s ✗ |

What it shows: (1) **the drafts are the bottleneck** — only 20 / 80 qwen drafts are faithful and only 12 / 40 rows have any
faithful draft, so even a perfect judge tops out at 12 sends and 28 asks; the failures are person conversion (he/she/usne/uska left
in the third person, "if/whether" fragments, who-brings-what flipped) far more than invention. (2) **Neither judge separates them** —
J1 passed 19 / 20 faithful drafts but also 46 / 60 unfaithful ones (7 of them invented); J2 14 / 20 and 38 / 60. The fixed question
does not make a small model see a third-person message as wrong. (3) Today's code sends a bad text on 30 / 40 reported bodies
(Hinglish 11 / 14). Ideas for a next try (each needs a fresh set): the reader itself writing the direct body (training — his call);
or asking whenever the body is `reported` (0 SEND-BAD by construction, but it gives up today's 10 good sends — bar 2).

## Bonsai reader — 4B, then 1.7B, keep the best (2026-10-15, his order; written BEFORE any Bonsai reader step or measurement)
Why: round 7 showed the 0.8B reader's ceiling (fresh phrasing still misread — "samay bata do" → a message). PrismML's 1-bit Bonsai
fits far more parameters in the same memory: Bonsai 4B Q1_0 is 0.57 GB (already jarvis's base on runtime/llama-server, so a reader
LoRA could share it), Bonsai 1.7B Q1_0 ~0.25 GB (downloaded after the 4B trial, his word). The live reader (round 5,
Qwen3.5-0.8B Q8_0) is 1.0 GB.

**Phase 1 — trial, the same for each candidate:**
- Training: `train_bonsai.py` on `data/reader_round7` (the rows round 7 trained on), the base repacked exactly to MLX 2-bit
  (repack_bonsai.py), rank 8, scale 20, 16 layers, lr 1e-4, grad-accum 4, max-seq 256, 50 updates, under guard.py (min-free 18,
  min-battery 30), MLX_LIMIT_GB 2.5. Measured: seconds per update, peak MLX memory, lowest free memory → projected time for one
  epoch (≈ 2,386 updates of 4 rows).
- Serving: the 50-update adapter → GGUF LoRA (export_lora_gguf.py) → runtime/llama-server on port 11437 (never the live 11436)
  with the base Q1_0 GGUF; for 4B also jarvis's LoRA, adapters picked per request. 20 reader lines (round5_valid — already read,
  used for timing only, not correctness), the reader's own request: raw prompt (readmodel.promptFor), its JSON schema, temperature
  0, 96 tokens, token probabilities. Measured: median and p90 warm read time, valid JSON count; for 4B, that alternating
  jarvis-adapter and reader-adapter requests each get their own adapter (the same line read differently by each, and back).
  Round 5 on Ollama on the same 20 lines, for the record.
- **A candidate goes on to a full round only if:** median warm read ≤ 1.5 s and p90 ≤ 3 s; projected one-epoch time ≤ 24 h awake;
  no guard pause for memory during the trial. (A 50-update adapter is not graded for correctness — it only proves the pipeline.)

**Phase 2 — full round(s), choosing fixed now:** a FRESH reader held-out (≥ 80 lines: every act, none-shapes, Hinglish ≥ ⅓, the
round-7 shapes; overlap-checked against every file in finetune/data and his episodes) is written BEFORE any full training. A Bonsai
reader replaces round 5 only if, by eval_reader-style grading on it: WRONG < round 5's and exact ≥ round 5's; on the six round-4
hold files WRONG ≤ 28 and exact ≥ 372 (round 5's own numbers — regression check only, they are read); round5_valid WRONG ≤ 1; then
the 995-line gate with 0 NEW-WRONG and every changed reply read. If both Bonsai pass: fewer WRONG on the fresh set, then faster.
Live only after that, his live test after.
**RESULT phase 1 — Bonsai 4B (2026-10-15 ~19:50; `runs/bonsai4b_reader_trial.log`, `runs/bonsai_reader_trial_4b.json`): PASSES — may go
to a full round.** Training: 50 updates in 581 s awake (steady ~7.3 s/update after warm-up), held-back 3.81 → 0.38, peak MLX 1.46 GB,
lowest free 20 %, 0 guard pauses → one epoch (2,386 updates) ≈ 5 h awake. Serving (llama-server :11437, base Q1_0 + jarvis LoRA +
reader LoRA, RSS 1.3 GB, start 1.2 s): median 318 ms, p90 549 ms, valid JSON 20 / 20; per-request adapters OK (3 / 3 lines: the
reader adapter gave reader JSON, jarvis's gave a chat-style reply, and switching back gave the reader's exact text). The median is
flattered — the 50-update adapter answers `none` (short) on most lines; like-for-like full-action reads were 420–721 ms (12–23
tokens, ~51 ms/token) vs round 5 on Ollama 275–598 ms (median of all 20: 369 ms, p90 501). So ≈ 1.2–1.4× round 5's read time,
still well inside the bars.
**RESULT phase 1 — Bonsai 1.7B (2026-10-15 ~20:05; downloaded on his word: prism-ml/Bonsai-1.7B-gguf @210a9e9 `Bonsai-1.7B-Q1_0.gguf`
248 MB + prism-ml/Bonsai-1.7B-mlx-1bit @fac480d 285 MB, Apache-2.0, sha256 checked in full; repacked exactly to MLX 2-bit — 4/4 greedy
prompts identical to the GGUF): PASSES — may go to a full round.** Training 50 updates in 259 s awake (~3.8 s/update), held-back
3.91 → 0.38, peak MLX 0.75 GB, lowest free 36 %, 0 pauses → one epoch ≈ 2.5 h. Serving (own base, RSS 0.83 GB at ctx 4096, start
0.7 s): median 137 ms, p90 141 ms, valid JSON 20 / 20; ~23 ms/token (4B ~51) — a full action ≈ 0.15–0.3 s, faster than round 5.
**Fresh held-out written (phase 2):** `data/bonsai_reader_heldout_v1.jsonl` (`build_bonsai_reader_heldout.js`) — 112 lines, every one of
the 38 reader acts, 38 Hinglish, round-7 shapes, 17 none-shapes; labels pass readmodel.shapeError; exact 0 / near 0 / self 0 against
889,551 prior strings (every file in finetune/data + his episodes). UNREAD by any model.

**Phase 2 recipe — fixed before either full round (2026-10-15 20:10):** for each of 1.7B then 4B, one at a time: `train_bonsai.py` on
`data/reader_round7`, 2,386 updates (one epoch of 4-row updates), lr 1e-4 cosine to 10 % after 50 warm-up updates, rank 8, scale 20,
16 layers, max-seq 256, seed 1, save every 100, held-back every 400 (recorded, not used to choose); guard pauses, a stop resumes from
the last save with the optimiser (runs/bonsai_reader_full.sh). **The FINAL save is the candidate** (no picking among saves). Graded with
eval_reader.py (MLX, its base + adapter) on bonsai_reader_heldout_v1 (choosing), the six round-4 hold files + round5_valid (regression
bars above), round7_valid (record); round 5 on bonsai_reader_heldout_v1 for the comparison. Then the bars as written in phase 2.
**RESULT phase 2 — Bonsai 1.7B (2026-10-15 21:35; 2,386 updates in 4,665 s awake, 0 pauses, lowest free 33 %, held-back 3.91 → 0.16 →
0.13 → 0.088 (400/800/1,200); final save graded, `runs/bonsai_reader_17b_eval.log` + rows): FAILS the regression bars — not kept.**
Six round-4 hold files **357 exact / 9 MISS / 4 REFUSED / 38 WRONG** (bars ≥ 372, ≤ 28 ✗); round5_valid 22 / 4 / 0 / 4 (WRONG ≤ 1 ✗);
fresh bonsai_reader_heldout_v1 81 / 6 / 0 / 25 (round 5 not yet graded on it); round7_valid (record) 49 / 4 / 0 / 7. Read: most fresh
WRONGs are dropped fields (`as`, `force`, `when`, `where`, "desktop" for "the desktop"); the ones that change what happens — "lmk at 5 to
call the bank" → call, "gaana roko zara" → play, "next wala gaana lagao" → play, "chrome khol aur bhai ko call kar" → call bhai where
chrome, "create notes.md on the desktop" → create_folder, "hold the music, someones at the door" → multi with a call.
**RESULT phase 2 — Bonsai 4B (2026-10-16 01:15; 2,386 updates in ~3.5 h awake, 0 pauses, lowest free 21 %; held-back 3.81 → 0.148 →
0.123 → 0.087 (400/800/1,200); final save graded, `runs/bonsai_reader_4b_eval.log` + rows): FAILS the regression bars — not kept.**
Six round-4 hold files **357 exact / 13 MISS / 9 REFUSED / 33 WRONG** (bars ≥ 372, ≤ 28 ✗); round5_valid 24 / 3 / 0 / 3 (WRONG ≤ 1 ✗);
fresh bonsai_reader_heldout_v1 **85 / 9 / 2 / 16** vs round 5 **80 / 10 / 5 / 17** (passes this one: fewer WRONG, more exact);
round7_valid (record) 49 / 5 / 0 / 6. MLX read ~1.0 s vs 0.47 s for the 0.8B.
**Neither Bonsai is kept — round 5 stays live.** Both Bonsai adapters stay on disk (adapters/bonsai_reader_{17b,4b}); nothing exported.

**FOR THE RECORD — round 7 on the fresh held-out (2026-10-16 01:20, `runs/reader_round7_on_bonsai_heldout.log`): 93 exact / 4 MISS /
4 REFUSED / 11 WRONG** — the best of the four (round 5 80 / 17, Bonsai 4B 85 / 16, Bonsai 1.7B 81 / 25). The same 0.8B, the same data:
the gain over round 5 is the round-7 data, not model size; the 4B's wins over round 5 are mostly the round-7 shapes round 5 was never
taught (when, time, ss, Hinglish volume). Against the Bonsai phase-2 bars round 7 passes every one (fresh WRONG 11 < 17 and exact 93 ≥
80; six hold files 374 ≥ 372 and WRONG 24 ≤ 28; round5_valid WRONG 1 ≤ 1). It failed only its own pre-registered round7_valid bar
(WRONG 6 > 3, time 7 / 10 < 8) and was not kept on his word ("keep round 5"). Whether that changes is his call.

## Pre-restart gate (2026-10-16 01:20–02:31, tag `prerestart-20261016`, current code with round 5) — a ROUND-7 WIRING REGRESSION, caught before live
run_all first: 3,063 assertions / 48 suites green. Gate (995 lines; the first pass stopped at the 15 % memory floor — jarvis-reader +
qwen 3B both resident — Ollama unloaded and resumed with the same tag): vs fix2-20261015 **PASS 529 → 517, LOST 23, GAINED 11,
NEW-WRONG 4**. Read every one:
- **19 LOST + 4 NEW-WRONG = the round-7 wiring (on disk since 10-15, never live).** build() attached round 7's "do it later" time as
  `when` — the key remind / calendar / weather already use for their OWN time — and runReaderJob / runAction scheduled anything with a
  `when`: "remind me to submit the assignment at 9" → "Scheduled for 2:05 AM" (converter v1, failed 15/30), "tmrw" / "friday" →
  "is not a time I can set"; the mis-scheduled reminders then fired during later chat lines in the sandbox (the NEW-WRONGs).
  The handoff's "safe if JARVIS restarts early" was wrong.
- **FIX (on disk, not live):** readmodel.build() puts round 7's time on `later` (remind / calendar / weather keep `when`); server.js
  schedules on `later` only; the whole path is OFF unless `JARVIS_READER_LATER=1` — off, scheduleAction says plainly nothing ran
  (never a guessed time, as round 7's own pre-registration demanded), and readmodel.shapeError refuses `when` on the round-7 acts as it
  did before round 7 (round 5 under the round-7 table had read "look for flight deals to goa in december" as a search for later).
  tests/test_reader_later.js 15/15; test_readmodel 160/160 (its round-7 case now checks both switch states).
- Targeted re-run of all 27 flagged lines on the fixed code (`gate-prerestart-fix-20261016-*`, `-fix2b-`): every reminder line PASS again,
  the NEW-WRONGs gone, v2s06 answered in chat as in fix2. The rest is drift: v3m04 / m02 composer bodies (3 re-runs of v3m04 on the same
  code: "have you got the charger?", "if he has the charger", "did you get the charger?" — all PASS; the gate's "let's grab it and go"
  is sampling), v2w05 weather route.
- **NOT RESTARTED:** code changed after the full gate, so the full gate must run again on the final code (≈ 70 min) — on battery at
  45 % at 02:45 it could not finish. Morning, on mains: run_all → gate `prerestart2-2026101X` → read → restart.

## Round 7 go-live gate (2026-10-16 11:34–12:40, tag `r7-20261016`, the final code with `jarvis-reader-r7q8`) — FAILS, round 5 stays live
Export: export_reader.sh's `-q q8_0` no longer exists on Ollama 0.40.3 (int4 / int8 / nvfp4 / mxfp4 / mxfp8 only). The int8 build runs on
Ollama's MLX runner and grew to ~3 GB in use (system free −2.3 GB over 40 reads vs round 5's −1.4) — rejected, moved to the Trash. A
GGUF Q8_0 was built with the 0.33.3 rollback app as a sandbox server (own port and model folder) and imported as `jarvis-reader-r7q8`
(1.0 GB, llama.cpp runner, the same projector blob as round 5): 60 / 60 valid JSON with token probabilities, median 346 ms.
**Gate vs the same code with round 5 (`prerestart2-20261016`): PASS 533 → 538, GAINED 55, LOST 50, NEW-WRONG 1.** Every LOST line re-run
once (temperature 0): 6 came back (composer bodies v3m35 / m06 / m15 / m19, v2q20 wording, u11 a pending-quiz sandbox artifact); **44
reproduce — 38 of them are round 7 ASKING ("Should I message ekamveer “gg well played”? Say “message”", "Should I play “a cooking video”?",
"Should I open calendar?", "Should I set a reminder to email sir tmrw?") on plain requests round 5 just did**; the rest: why lane on
"whatsapp parth saying wtf was that goal lmao", self-fact "Noted" on "bhai ko whatsapp kar ki khana kha liya", the teach offer on "open netflix
lets watch smth", an agent partial on "can you whatsapp ekamveer saying thx for the help", lb20 dentists → a web search, k08 / v2k02
compounds read as one message. **NEW-WRONG b40 "quit everything except brave" → "Quit Brave Browser?" (reproduces).** The gains are the
round-7 targets (time 8 — the clock answers in ~250 ms, opens 7, music 8, messages 9 where round 5 had asked).
What it shows: round 7 asks on DIFFERENT lines — its token-probability confidence on everyday message / play / open lines fell under the
0.75 ask bar, while its readings are right (the offline grading counts the reading, never the confidence, so 93 / 11 on the fresh
held-out could not see this). Not shippable under the gate's rule. jarvis-reader-r7q8 stays in Ollama until he decides.

## Round 7's confidence bar — calibration (2026-10-16, his ask "try calibrating round 7's confidence bar … pre-register and use a fresh set";
## written BEFORE the fresh set exists and before any confidence was measured)
Why: in the go-live gate round 7 asked "Should I …? Say …" on 38 plain requests round 5 just did — its least-likely-token confidence fell
under the bar (MIN_CONFIDENCE 0.75) on readings that were right. Expectation stated now: a bar can fix at most those 38; 7 reproduced
regressions cannot be fixed by any bar (b40 and k08 confident and wrong, lb20 / o14 read differently, m27 / v2m37 / m12 confidence ≤ 0.16,
under the 0.3 ask floor) — so the gate's 0 LOST / 0 NEW-WRONG rule will still fail. This measures how close round 7 can get.
**What changes:** only the existing setting `JARVIS_READER_MIN_CONFIDENCE` (no code). It is ONE number with four uses — act vs ask
(readmodel.build), the confident-none veto (readerSaysNone), and two reader gates in server.js (6222, 13425) — so both effects are measured.
**Measured on the live path:** readmodel's own request (raw prompt, schema, temperature 0, token probabilities) through Ollama, the
confidence readmodel computes (`__conf`, least likely token), graded by eval_reader.grade — for `jarvis-reader-r7q8` and live round 5
(`jarvis-reader`), one model at a time. (eval_reader's `minp` is the same quantity from MLX; reported for agreement only.)
**Costs, per reading (ask floor 0.3 unchanged):** ACTED-WRONG(b) = an action reading graded WRONG with conf ≥ b (acts on a wrong
reading without asking); VETO-MISS(b) = a `none` reading graded MISS with conf ≥ b (the veto blocks the lanes for a real request);
ASK-ON-RIGHT(b) = an exact action reading with 0.3 ≤ conf < b (asks when it was right).
**Tuning (choosing b), on the READ sets:** six round-4 hold files, round5_valid, round6_valid, round7_valid, bonsai_reader_heldout_v1.
b = the LOWEST of 0.30, 0.35, …, 0.75 with ACTED-WRONG_r7(b) ≤ ACTED-WRONG_r5(0.75) and VETO-MISS_r7(b) ≤ VETO-MISS_r5(0.75).
**Confirmation, on a FRESH set** (written after this paragraph, before any model reads it; everyday plain requests where the asks showed,
none-shapes, round-7 shapes, ≥ ⅓ Hinglish; shape-checked; overlap 0 against finetune/data incl. every held-out, and his episodes):
r7 at b vs round 5 at 0.75 — ACTED-WRONG ≤, VETO-MISS ≤, and ASK-ON-RIGHT ≤ (all three). Fails → b is not used, nothing gated.
**Then the gate** (passes the confirmation only): `JARVIS_READER_MODEL=jarvis-reader-r7q8 JARVIS_READER_MIN_CONFIDENCE=b`, tag `r7cal-…`,
vs prerestart2-20261016, the usual rule (every LOST re-run once, drift proven, 0 NEW-WRONG, every change read). Nothing goes live from this.
**RESULT — round 7's bar (2026-10-16 ~13:20; `runs/r7_bar_20261016/`, finetune/r7_bar_grade.py, jarvis-os/sweeps/sweep_reader_conf.js;
fresh set data/reader_calib_fresh_v1.jsonl — 105 lines, 41 Hinglish, overlap 0 vs 1,025,489 strings — now READ):**
Live-path readings, graded by eval_reader.grade: tuning (664) round 7 574 exact / 14 MISS / 18 REFUSED / 58 WRONG vs round 5 508 / 51 / 20 /
85; fresh (105) round 7 87 / 3 / 2 / 13 vs round 5 80 / 7 / 2 / 16.
Bar rule on tuning (round 5 at 0.75: ACTED-WRONG 30, VETO-MISS 36, ASK-ON-RIGHT 20): round 7 ACTED-WRONG 45 at 0.30–0.45, 44 at 0.50, 38 at
0.55, 36 at 0.60, 34 at 0.65, **29 at 0.70** (VETO-MISS 9, ASK-ON-RIGHT 27), 27 at 0.75 → **b = 0.70**. Fresh confirmation, round 7 at 0.70 vs
round 5 at 0.75: ACTED-WRONG 7 vs 10, VETO-MISS 3 vs 6, ASK-ON-RIGHT 5 vs 7 → **passes** (record: round 7 at 0.75 → 6 / 3 / 6).
**But it barely moves the gate's problem:** round 7's live confidence on the 38 gate lines it asked on is 0.48–0.75 (8 at ≥ 0.70, 30 between
0.48 and 0.70). At 0.70 about 8 of those 38 become actions; the other 30 stay asks, and lower bars make round 7 act wrongly more often than
round 5 (the rule's limit). Predicted gate at 0.70 (temperature 0, the same lines): ≈ 36 LOST + the b40 NEW-WRONG → fails the ship rule.
Note: the fresh everyday set did NOT reproduce the gate's ask problem (round 7 asks on fewer right readings than round 5 there) — the gate's
sets lean toward round 5, whose round was built from the dev set's shapes.
**GATE RESULT — round 7 at 0.70 (`r7cal-20261016` vs prerestart2-20261016; 2026-10-16 13:05–14:34, stopped once at 20 % battery and resumed;
every LOST / NEW-WRONG line re-run once as `r7calrerun-20261016`; time/weather answers and new message bodies read by hand):**
PASS 533 → 542 (round 7 at 0.75 was 538). First run 46 LOST + 2 NEW-WRONG; after the re-run **40 LOST + 2 NEW-WRONG reproduce → FAILS** the ship
rule (prediction ≈ 36 LOST + b40). Did not reproduce (drift): v2m04, m02, m06, m19 (message bodies), v2q06 (chat fact), u11 (food order).
- 30 of the 40 are asks ("Should I …? Say …") on plain requests with the right reading in the question (38 at 0.75 → 30 at 0.70, as predicted).
- 10 are not about the bar: lb20 (business finder → web search), v2m14 ("send ekamveer wya" → asks what to say), v2m37 (→ "Noted"), m12
  (→ "why"), m27 (→ agent), o14 (→ "I have not done this before"), k08 (the "+ call mama" clause swallowed into the body), and three message
  bodies rewritten with words he never gave (v3m35 greeting + reason, m15 "send me the notes", m11 garbled "ime for dinner?").
- NEW-WRONG: b40 "quit everything except brave" → quit Brave (as before) and v2j07 "kuch mazedaar suna de" → plays music (round 5 asked).
Round 5 stays live; `jarvis-reader-r7q8` stays parked. Next (his OK 2026-10-16): the per-field confidence test below.

## Per-field confidence — round 7 (2026-10-16, his ask "pre-register the per-field confidence test after the gate"; written AFTER the r7cal
## gate, BEFORE the fresh set exists and before any per-field number was measured on anything)
**Why:** 30 of round 7's 40 reproduced gate regressions at 0.70 are asks whose question shows the right reading. The reader's confidence
(readmodel.confidenceOf) is the least likely token of the WHOLE reading — including the words it copies from his message (its own
instruction: "Copy the user's words exactly"). Hypothesis: on those lines the least likely token sits in the copied text ("wsg", "gg well
played", "a 10 min workout video"), not in the act or the person. If so, a confidence over the decision tokens only should stop the asks
without letting more wrong readings act. If the low token sits in the act or the person, nothing moves and the idea is done.
**Never seen beforehand:** runs/r7_bar_20261016/conf_gate_asks_r7.jsonl holds round 7's raw reading + whole-reading confidence on the 38
gate asks of the 0.75 gate — no tokens, so no per-field number of any gate line has been looked at.
**Measured on the live path:** jarvis-os/sweeps/sweep_reader_fields.js — readmodel's own request (raw prompt, schema, temperature 0, token
probabilities) through Ollama, keeping every output token and its probability; one model at a time (round 7 `jarvis-reader-r7q8`, then
round 5 `jarvis-reader`); graded by eval_reader.grade; finetune/r7_fields_grade.py does the rest.
**The split (machine format only, no word list):** the reading's JSON is lexed; each character is a CHOICE character (structure, keys, the
`act` value and `as` — the SCHEMA's enum fields — and booleans), a REQUIRED value (string value of a field the act needs, from readmodel's
own FIELDS table, e.g. message `to`, play `query`, open `thing`) or an OPTIONAL value (any other string value: body, what, when, where,
browser…). A token counts for every class it touches. Steps of a multi use their own act. Rules:
  A = min over all tokens (today, must equal readmodel's `__conf`) · B = min over choice + required tokens · C = min over choice tokens.
The chosen number replaces `__conf` in all four uses (act vs ask, the confident-none veto, server.js wholeIsOneInstruction and
readerSaysSelfContained) and the 0.3 ask floor reads the same number — so all of it is in the costs.
**Costs (same as the bar calibration):** ACTED-WRONG(b) = WRONG reading with number ≥ b · VETO-MISS(b) = MISS (`none` for a request) with
number ≥ b · ASK-ON-RIGHT(b) = exact action reading with 0.3 ≤ number < b.
**Tuning (choosing), on the 11 READ sets** of the bar calibration (six round-4 hold files, round5/6/7_valid, bonsai_reader_heldout_v1,
and reader_calib_fresh_v1 — read now; 769 lines): for each rule, b = the LOWEST of 0.30, 0.35, … 0.95 with round 7 ACTED-WRONG ≤ round 5's
(rule A, 0.75) and VETO-MISS ≤ round 5's. Chosen rule = the fewest ASK-ON-RIGHT at its b; ties → A, then B, then C. Rule A chosen, or no
rule meets the limits → stop (nothing new).
**Confirmation, on a FRESH set** `data/reader_calib_fresh_v2.jsonl` (written after this paragraph, before any model reads it; ~110 lines:
everyday plain requests of the kinds the gate asked on — short slang / Hinglish message bodies, play and video, reminders, quit, search and
order, quiz — plus none-shapes and a few round-7 shapes; ≥ ⅓ Hinglish; shape-checked by readmodel.shapeError; overlap 0 — exact and ≥ 0.75
word-Jaccard — against every file in finetune/data, gate sets and v1 included, and his episodes): round 7 (rule, b) vs round 5 (A, 0.75) —
ACTED-WRONG ≤, VETO-MISS ≤ and ASK-ON-RIGHT ≤ (all three). Fails → stop.
**Record only (no decision):** round 5 under the chosen rule with its own bar by the same limits, on tuning and fresh — whether the live
reader itself would ask less. Any change to live is his call.
**Passes only → prediction, then code, then the gate:** (1) round 7's per-field number on the gate's 30 reproduced ask lines, written down
as a prediction before the gate; (2) readmodel's split behind `JARVIS_READER_CONF` (unset = today, `B` / `C` = the rule), tests,
integrity — nothing live changes; (3) gate `JARVIS_READER_MODEL=jarvis-reader-r7q8 JARVIS_READER_CONF=<rule>
JARVIS_READER_MIN_CONFIDENCE=<b>`, tag `r7field-…`, vs prerestart2-20261016, the usual rule (every LOST re-run once, 0 NEW-WRONG, every
change read).
**Stated now:** this can only touch the 30 asks. The other 10 reproduced LOST and both NEW-WRONG (b40, v2j07 — confident and wrong) are not
confidence, so even a perfect result leaves the gate failing; the gate shows how many remain. It answers whether the asks are a measurement
problem (fixable without training) or a reading problem.
**RESULT — per-field confidence (2026-10-16 14:41–14:55; runs/r7_fields_20261016/ — fields_<model>.jsonl, grade_output.txt,
where_low_token.txt; fresh set data/reader_calib_fresh_v2.jsonl — 120 lines, 48 Hinglish, overlap 0 vs 1,071,452 strings — now READ):**
Token split checked: 889 / 889 rows split, rule A equals readmodel's `__conf` on every row. Readings (eval_reader.grade): tuning (769)
round 7 661 exact / 17 MISS / 20 REFUSED / 71 WRONG vs round 5 588 / 58 / 22 / 101; fresh (120) round 7 96 / 2 / 4 / 18 vs round 5 90 / 4 / 2 / 24.
Tuning (round 5, rule A at 0.75: ACTED-WRONG 40 · VETO-MISS 42 · ASK-ON-RIGHT 27). Round 7 bars by the rule: A 0.70 (36 / 12 / 32),
**B 0.70 (39 / 12 / 28)**, C 0.80 (39 / 11 / 47) → chosen **B at 0.70** (4 fewer asks than A on 769 lines).
Fresh confirmation, round 7 B at 0.70 vs round 5 A at 0.75: ACTED-WRONG 9 vs 13 ✓, VETO-MISS 1 vs 4 ✓, ASK-ON-RIGHT **10 vs 9 ✗ →
CONFIRMATION FAILS → stop** (no code, no gate). Record: round 7 A at 0.70 on fresh 9 / 1 / 11; round 5 under B (own bar 0.80) 10 / 3 / 9.
**The hypothesis was wrong.** On round 7's 43 right readings that today's number asks about (tuning + fresh, 0.3 ≤ A < 0.70) the least
likely token sits in a copied OPTIONAL value only 5 times, a required value 9 times, and a CHOICE token 29 times — mostly the separator right
after a value (`","` vs `"}` = "is there another field?" — whether to add `video`, `where`, `as`…) and the act name itself (time, pause,
screenshot, message, multi). At equal bars, dropping copied words (C) removes a few asks but lets more wrong readings act (0.70: 36 → 43),
so the copied tokens do carry warning. The asks are round 7's own uncertainty about the reading, not a measurement artefact.
**What the gate's 30 reproduced asks are** (round 7 at 0.70): play 15, message 5, remind 3, open 2, search 2, quit 1, quiz 1, weather 1,
calendar 1. Skipping the reader's ask on acts that already confirm (message, quit) could touch at most 6 — and two of those readings are
wrong anyway (v2m19 body "asking for the notes from today", v2k02 "coming + open maps"). Play is half: the split shows round 7 unsure whether
to add `video` / `where` after the query — a training-data question (play labels), not a bar.

## Reader round 7 top-up — play labels (PLAN, 2026-10-16; his ask "write a pre-registered plan for a small round-7 top-up on play labels
## (video/where), no training yet"; written BEFORE the held-out, any relabel, any new row or any training)
**Why (evidence, all read by hand — no model loaded for this plan):**
- 15 of the 30 reproduced gate asks (r7cal) are play. Round 7's own readings of them (runs/r7_bar_20261016/conf_gate_asks_r7.jsonl,
  confidence 0.48–0.74) flip on two things: (1) the words he puts in front of the thing — "some dog videos" kept, but "yo throw on some
  drake" → `drake`, "queue up some sad songs" → `sad songs`, "play some chill music" → `chill music`, "play a random song lol" → `song`;
  (2) `video` — absent on "play a cooking video", "play a 10 min workout video", "open youtube and play some dog videos".
- The training data disagrees with itself on exactly those two. data/reader_round7/train.single.jsonl has 1,221 play readings (756 query
  only, 231 query+where+video, 101 query+where, 58 query+video, 54 with `when`…). 248 name YouTube/yt as `where` — 27 of them WITHOUT
  `video` ("watch f1 highlights on youtube", "open YouTube and play smarty pie latest video"). Lead words dropped in many rows ("throw on
  some coldplay" → `coldplay`, "put on some rain sounds" → `rain sounds`, "play some dog videos" → `dog videos`) and kept in others.
  "video, no platform named" — the gate's ask shape — has only 58 rows (5 %).
- The hold files drifted the same way: rounds 2–3 drop the lead word (patterns_heldout l.57 "kuch purane gaane chala do" → `purane
  gaane`; round2_valid l.41 `romantic gaane`, l.44 "koi bhajan bajao" → `bhajan`; round3_valid l.42 "play some karan aujla rn" →
  `karan aujla`, l.45 "eh nvm just play some lofi" → `lofi`), rounds 5–7 and every fresh set since keep it ("some edm", "koi science vid",
  "some drake", "some arijit"); round7_valid l.14 "play a 15 minute yoga video" → `a 15 minute yoga` drops the word video.
- The per-field test: on such lines the least likely token is the separator after the query (`","` vs `"}` — add `video` / `where`?).
  Conflicting labels make the model unsure; the fix is consistent labels, not a bar.
**Step 0 — the convention (needs HIS OK before anything is relabeled; then added to LABELING.md):**
- `query` = every word he used to name the thing, copied in order, the words in front included ("some drake", "koi bhajan", "kuch
  purane gaane", "a cooking video", "a 15 minute yoga video", "a random song"). NOT in query: the lead-in and filler ("eh nvm just",
  "lol", "rn", "idk"), the platform words (→ `where`: "on spotify", "youtube pe"), and the framing of a topic ("a vid on how to tie a tie"
  → `how to tie a tie`, as LABELING.md already says).
- `video: true` whenever he asks for a video — in whatever words he uses (read for meaning, as every label is; no word list anywhere,
  rule 1) — or names a video site as `where`. So a reading with `where` YouTube always has `video: true`.
- Why keep the front words: the reader's own instruction is "Copy the user's words exactly", LABELING.md's own example keeps "a random
  video", and every set written since round 5 keeps them; dropping needs a judgement per word that the model cannot see in the text.
**Step 1 — held-out FIRST:** `data/play_heldout_v1.jsonl` (builder `build_play_heldout.js`), ~90 lines: 60 play (front words some / a /
koi / kuch / ek; a video with no platform; platform + video; music on Spotify; artist + song; a length in the query; Hinglish ≥ ⅓), 15
look-alikes that are NOT play (talk about music, "X suna de" meaning tell, "did u play it", statements — the v2j07 shape), 15 other acts
(regression). Labels by the Step-0 convention; shape-checked; overlap 0 (exact and ≥ 0.75 word-Jaccard) vs every file in finetune/data —
gate sets, fresh v1/v2 and every hold included — and his episodes. The six hold rows above are relabeled to the convention at the same
time, each keeping its old label as `label_was`, BEFORE any baseline is measured.
**Step 2 — baselines (after Step 1, before any training):** round 5 and round 7 on play_heldout_v1 and the relabeled holds — offline
(eval_reader.py) and on the live path (sweep_reader_conf.js, `__conf`). Recorded; the bars below are relative to round 7's numbers.
**Step 3 — relabel:** every play reading in reader_round7/train.single.jsonl (1,221) read by hand against Step 0; fixed, or dropped when the
sentence itself is unclear. Change list kept (`runs/play_relabel_20261016.tsv`: text, old, new).
**Step 4 — data and training (needs his go):** the relabeled play rows ×1 + new play rows for the thin shapes (a video with no platform,
Hinglish video, front words — ~150, `gen_play_topup.py`, training material only) + an equal-sized replay of round 7's NON-play rows,
stratified by act (so nothing else is forgotten) — ~2,800 rows; distinct inputs and replies counted, any reply ≤ 3 times; every hold,
held-out and gate set `--exclude`d, near copies dropped. ONE epoch from `adapters/reader_round7`, round 7's exact settings (runs/bal_a.yaml:
lr 3e-5, LoRA rank 16 scale 10, 16 layers, batch 1 × 4 accumulation), under guard.py, Dream off — ~2,800 updates ≈ 80 min at 0.6 it/s.
Adapter `adapters/reader_r7play` (round 7's stays).
**Step 5 — bars (offline, eval_reader.py; fixed now):**
- play_heldout_v1, the 60 play lines: exact ≥ round 7's + 9 (15 %) and WRONG ≤ round 7's; the 15 look-alikes: WRONG ≤ round 7's (no new
  play on talk); the 15 other acts: exact ≥ round 7's − 1.
- six round-4 hold files (relabeled): WRONG ≤ round 7's + 2 and exact ≥ round 7's − 4; round5_valid WRONG ≤ 1; round7_valid exact ≥ round
  7's, WRONG ≤ round 7's; bonsai_reader_heldout_v1, reader_calib_fresh_v1 and v2: WRONG ≤ round 7's (each).
**Step 6 — live path (passes Step 5 only):** export as `jarvis-reader-r7p` (GGUF q8_0 via the Ollama 0.33.3 sandbox route; nothing live
changes). On play_heldout_v1 at 0.70: ASK-ON-RIGHT ≤ half of round 7's and ACTED-WRONG ≤ round 7's. The bar rule re-run on the 12 READ
sets (vs round 5 at 0.75, as before) must give b ≤ 0.70.
**Step 7 — prediction, then the gate:** r7p's confidence on the 15 gate play-ask lines written down as the prediction; then the gate vs
prerestart2-20261016 with r7p at its b, the usual rule (every LOST re-run once, 0 NEW-WRONG, every change read).
**Stated now:** the best case fixes the 15 play asks. The gate's other 27 failures stay (15 asks on message / remind / open / search /
quit / quiz / weather / calendar, 10 LOST that are not the bar, b40, v2j07) — so the gate still FAILS after this top-up. What this
answers is whether consistent labels remove round 7's asks. If they do, the same audit (labels that disagree) is the way to take on
message and remind next; round 7 can only ship once those are done too, or if he sets a different reader-swap rule BEFORE a result.
**Cost:** Steps 1–3 no model except the Step-2 baselines (~15 min); Step 3 ≈ 2–3 h of hand reading; Step 4 ≈ 80 min training; Steps 5–7
≈ 2.5 h (eval, export, live sweep, gate). Disk: one adapter + one 1 GB Ollama model.
**STEP 0–1 DONE (2026-10-16 ~21:20–21:40; his OK: "keep the front words, video whenever he asks for a video or names a video site"):**
- LABELING.md: new section "Play — the words that name the thing, and `video`" (backup backups/finetune/LABELING.md.bak-play-convention-…).
- Hold files relabeled to it — every play row of all 12 bar sets read by hand; 9 rows changed, each keeping `label_was` (backups
  backups/finetune/data/*.bak-play-relabel-20261016-212235; shape errors 0): patterns_heldout l.7 + `video` (Vimeo), l.57 `kuch purane
  gaane`; round2_valid l.24 + `video` ("wahi wala video"), l.41 `kuch romantic gaane`, l.43 + `video` (YouTube), l.44 `koi bhajan`;
  round3_valid l.42 `some karan aujla`, l.45 `some lofi`; round7_valid l.14 `a 15 minute yoga video`. bonsai_reader_heldout_v1 and
  reader_calib_fresh_v1/v2 already followed it (0 changes).
- Held-out `data/play_heldout_v1.jsonl` (`build_play_heldout.js`): 90 lines — 60 play (25 with `video`, 16 with `where`), 15 look-alikes
  (`none`), 15 other acts; 36 Hinglish; shape errors 0; overlap exact 0 / near 0 / self 0 vs 1,071,776 strings in 415 files + his episodes
  (11 first-draft lines collided and were rewritten before writing). Every label read by hand. No model has read it.
- Note: the earlier `tools/bak.sh` calls of 2026-10-16 (README) passed one argument and saved nothing; today's README additions are
  append-only. Proper backups from here on.
**STEP 2 DONE — baselines (2026-10-16 21:25–21:41; `runs/play_baselines.sh`, `play_topup_grade.py`, `runs/play_topup_20261016/` —
offline_<adapter>.jsonl/.log, live_<model>.jsonl, baselines_graded.txt, regrade_live_holds.txt; play_heldout_v1 now READ):**
| | round 7 | round 5 |
|---|---|---|
| play_heldout_v1 — 60 play | 24 exact / 1 MISS / 2 REFUSED / 33 WRONG | 17 / 1 / 3 / 39 |
| — 15 look-alikes | 12 / 0 / 1 / 2 | 10 / 0 / 0 / 5 |
| — 15 other acts | 10 / 0 / 1 / 4 | 8 / 1 / 2 / 4 |
| six hold files (relabeled) | 374 / 7 / 7 / 24 | 370 / 4 / 8 / 30 |
| round5_valid · round7_valid | 28/1/0/1 · 50/4/0/6 | 27/1/0/2 · 27/17/0/16 |
| bonsai v1 · fresh v1 · fresh v2 | 93/4/4/11 · 85/3/3/14 · 99/0/2/19 | 80/10/5/17 · 81/7/3/14 · 89/4/3/24 |
| live, 60 play lines, asks at 0.70 / 0.75 (any verdict) | 21 / 22 | 20 / 24 |
| live play_heldout_v1 at 0.70: ACTED-WRONG · VETO-MISS · ASK-ON-RIGHT | 20 · 1 · 7 | 29 · 2 · 9 |
Read by hand — round 7's 36 non-exact play readings: 18 drop only the front word ("play some travis scott real quick" → `travis scott`,
often at confidence 0.95–1.0 — it learned the drop), 5 miss only `video` ("watch the new mrbeast video", "play stranger things on netflix"),
4 both, 8 cut or garble the query ("channa mereya" → `mereya`, "kun faya kun" → `kun faya`, "a random video idk" → `a random video id`,
"play a random song on spotify" → `song` with no `where`), 1 MISS ("show me a trailer for the new batman movie" → none). Both readers ask on
a third or more of plain play requests — the gate's play asks, reproduced on lines neither has seen.
Regrading the stored live readings against the relabeled holds: both readers flip on the same rows (round 5 keeps "some lofi", drops "some
karan aujla"); on all 12 READ sets round 7's bar by the rule would now be 0.65 (record).
**Step-5 bars, now concrete (top-up `reader_r7play`, offline):** 60 play: exact ≥ 33 and WRONG ≤ 33 · look-alikes: WRONG ≤ 2 · other acts:
exact ≥ 9 · six hold files: exact ≥ 370 and WRONG ≤ 26 · round5_valid WRONG ≤ 1 · round7_valid exact ≥ 50 and WRONG ≤ 6 · bonsai v1 WRONG ≤ 11
· fresh v1 WRONG ≤ 14 · fresh v2 WRONG ≤ 19. **Step-6 (live):** play_heldout_v1 at 0.70 ASK-ON-RIGHT ≤ 3 and ACTED-WRONG ≤ 20; the bar rule
on the 12 READ sets gives b ≤ 0.70. Noted now, not changed: ASK-ON-RIGHT counts only exact readings, so it can rise as exact rises; the
asks-any-verdict line above (21 at 0.70) is recorded beside it for the read.
**STEP 3 DONE — relabel (2026-10-16 ~21:45–21:58; no model):** every one of the 1,221 play readings in reader_round7/train.single.jsonl
(1,172 rows) read by hand against LABELING.md "Play — …" and LABELING's own "search <site> for X is search_web". Decisions are written per
row in `data/reader_play_topup/decisions.py` (view `play_view.json`), applied by `apply_relabel.py` → `data/reader_play_topup/
play_relabeled.jsonl` (1,156 rows) + change list `runs/play_relabel_20261016.tsv`. Shape check (readmodel.shapeError, training table):
0 errors in 1,529 readings. round 7's own data folder is untouched.
- 206 readings changed: query 150 (front words restored — "play some country music" was `country`, "throw on some coldplay" was `coldplay`;
  truncations fixed — "plz play my favorite pop songs from my list" was `pop`, "spotify par naye releases bajayein" was `spotify`), `video`
  41 (YouTube / Netflix / Prime / Hotstar / Crunchyroll rows and "watch …" a show), `where` 10 (a platform he named was missing — "play
  in the end by linkin park on spotify thanks"), `refers` 3, and 8 "search yt for X" readings play → search_web.
- 16 rows left out as unclear: cat VIDEOS on SPOTIFY (the two rules disagree), "go to the first song" / "change channel" (not play),
  `aaj` / `today` / "after this track" that read like a round-7 `when`, "aur aisa music" (more-of-this, `aur` also "and"), garbled lines.
- After: all 240 YouTube/yt readings have `video`; `video` without a platform 63 (was 58); no music service carries `video`.
**STEP 4 — data and training (his go 2026-10-16: "ok do it"; on mains):**
- New rows `gen_play_topup.py` → data/reader_play_topup/new_play.jsonl: 145 written by hand for the thin shapes (35 English video with no
  platform, 25 Hinglish video, 25 English and 25 Hinglish front words on music, 20 platform + video, 15 music services; 64 Hinglish,
  tagged by hand); shape errors 0; 3 dropped as near-copies of protected files ("ek gaming stream dikhao" ≈ play_heldout_v1's query, "play
  some sufi music" ≈ jarvis_heldout "play some music", "open youtube and play some rain videos" ≈ casual v3 "… some dog videos") → 142.
  (The first run also printed a Hinglish count made with a word regex — removed from the script, not used: rule 1.)
- Mix `build_play_mix.py` → data/reader_play_topup/mix/train.jsonl, 2,414 rows: relabeled play 1,083 + new 142 + replay 1,189 of round 7's
  non-play rows (stratified by act, seed 7). Dropped: 59 rows whose text is in a protected file (15 relabeled, 44 replay — round 7's
  build had let them in) and 126 over the cap of 3 identical action replies (58 relabeled, 68 replay). `none` replies are not capped (they
  are identical by nature; capping them would remove the negatives) — stated here as the reading of "any reply ≤ 3 times". Distinct inputs
  2,414 / 2,414; distinct replies 1,786. valid.jsonl = round 7's own (reports a loss only).
- Training started 22:19:45: `train_resumable.py --name reader_r7play --data data/reader_play_topup/mix --iters 2414 --resume-from
  adapters/reader_round7/adapters.safetensors` (round 7's exact settings; guard: min-free 18, min-battery 30), Dream off, Ollama empty.
  `runs/after_r7play.sh` armed: grades the final save on every step-5 set when training exits, then Dream back on.
**STEP 5 RESULT (2026-10-16 23:29 training done, 23:38 graded; `runs/play_topup_20261016/step5_graded.txt`, `step5_regressions.txt`):
NOT KEPT — 4 pre-registered bars fail.** Round 5 stays live, round 7 stays parked, `adapters/reader_r7play` kept for the record; step 6 not run.
| bar | reader_r7play | round 7 | |
|---|---|---|---|
| 60 play: exact ≥ 33, WRONG ≤ 33 | **56** / 1 / 0 / 3 | 24 / 1 / 2 / 33 | ✓ |
| 15 look-alikes: WRONG ≤ 2 | 11 / 0 / 0 / **4** | 12 / 0 / 1 / 2 | ✗ |
| 15 other acts: exact ≥ 9 | 9 / 0 / 1 / 5 | 10 / 0 / 1 / 4 | ✓ |
| six hold files: exact ≥ 370, WRONG ≤ 26 | **365** / 12 / 9 / 26 | 374 / 7 / 7 / 24 | ✗ |
| round5_valid WRONG ≤ 1 | 29 / 1 / 0 / 0 | 28 / 1 / 0 / 1 | ✓ |
| round7_valid exact ≥ 50, WRONG ≤ 6 | **47** / 9 / 0 / 4 | 50 / 4 / 0 / 6 | ✗ |
| bonsai v1 WRONG ≤ 11 · fresh v1 ≤ 14 · fresh v2 ≤ 19 | 82/11/4/**15** · 81/9/6/9 · 103/5/2/10 | 93/4/4/11 · 85/3/3/14 · 99/0/2/19 | ✗ · ✓ · ✓ |
**Read (every lost row is in step5_regressions.txt):** the convention worked where it was taught — the 60 fresh play lines went 24 → 56
exact, front words and `video` now as labeled, and the asks on them should fall with it. But 78 rows round 7 had right were lost (79 gained):
the acts the replay starved — `time` 14 (and an invented `where`: "aaj ki tareekh batao" → time where `aaj`), screenshot 5, sleep_display /
system_status / weather / open → none — and things pulled toward play: "gaana roko zara" → play `roko`, "next wala gaana lagao" → play,
"flipkart pe earphones dhundo" / "youtube pe tabla tutorial dhundo" → play, "koi kahani sunao" → play. Cause, in the mix design: play was
~half of 2,414 rows and the replay was proportional to round 7's act counts, so rare acts got 3–11 rows each (time 11, screenshot 5,
sleep_display 3); one epoch at round 7's learning rate moved the reader toward play and away from them.
**Not tried (would need his go, and its own pre-registration):** keep the relabeled play rows and the new rows, but train a FULL round from
round 5 on round 7's whole cleaned dataset (every act at its normal weight, ~8.6k rows, ~4 h) instead of a play-heavy top-up; or a top-up
whose replay has a floor per act and the play-adjacent look-alikes (player commands, "… pe X dhundo" searches, "… sunao" = tell).

## Reader round 8 — round 7's whole data, play cleaned (PLAN, 2026-10-17; his ask "pre-register a full round from round 5 on round 7's
## whole cleaned data (every act at normal weight), don't train yet"; written BEFORE round8_fresh_v1, the round-8 data or any training)
**Why:** the top-up showed the play convention works where it is taught (60 fresh play lines 24 → 56 exact) and that its MIX starved the
other acts. Two causes, both in the mix: the replay was ~half play and proportional, and the "any reply ≤ 3 times" cap cut every act whose
reading has no fields to 3 rows — screenshot 48 → 3, system_status 53 → 3, time (bare) 65 → 3, sleep_display 30 → 3, volume up / down
101 → 3, pause 22 → 3 — exactly the acts it lost. Round 8 keeps round 7's own make-up and weights and changes only labels.
**Data** (`build_round8.py` → `data/reader_round8/{train,valid}.jsonl`):
- start from data/reader_round7/train.jsonl (9,543 rows, round 7's weights, its ×2 rows included);
- every row whose text is one of the 1,221 hand-read play readings takes its step-3 label (in a multi only the play steps change); every
  copy of the 16 unclear rows is dropped;
- rows whose text is in a protected file (held-out / hold / valid / exam / gate) are dropped;
- the 142 new play rows are added ×1;
- diversity (his rule): distinct inputs and replies counted and reported; an identical INPUT at most twice (round 7's own weight);
  replies are NOT capped — readings of field-less acts are identical by design (the top-up's lesson);
- valid = round 7's valid with the same relabels where the text matches (it only reports a loss).
**Training (needs his go):** ONE epoch from `adapters/reader_round5` (as round 7), round 7's settings (bal_a.yaml: lr 3e-5, rank 16, scale
10, 16 layers, batch 1 × 4), `train_resumable.py --name reader_round8` under guard, Dream off, on mains — ~4.5 h. Adapter `reader_round8`.
**Step 1 — a fresh held-out FIRST:** `data/round8_fresh_v1.jsonl` (`build_round8_fresh.js`), ~135 lines over every act at everyday
shapes, weighted to what the top-up lost and the gate asked on: the field-less acts (time, screenshot, sleep_display, system_status,
list_running), the player (pause / resume / next / volume, Hinglish), search vs play ("… pe X dhundo", "search youtube for …"), play with
front words and `video`, play look-alikes ("… sunao" meaning tell, talk about music), messages, reminders, open / close, files, the tutor,
none; ≥ ⅓ Hinglish; shape-checked; overlap 0 (exact and ≥ 0.75 word-Jaccard) vs every file in finetune/data and his episodes. Baselines —
round 5, round 7 and the top-up, offline — measured after it is written and before training (models load: needs his go).
**Step 2 — bars (offline, eval_reader.py; fixed now):**
- round8_fresh_v1: exact ≥ round 7's and WRONG ≤ round 7's;
- **per-act guard** (the top-up's lesson): pooled over every offline bar set (the 13 of step 5 + round8_fresh_v1), for every act with ≥ 10
  labeled lines, round 8's exact ≥ round 7's − 2;
- play_heldout_v1: 60 play exact ≥ 50 and WRONG ≤ 6; the 15 look-alikes WRONG ≤ 2; the 15 other acts exact ≥ 9;
- six hold files exact ≥ 370 and WRONG ≤ 26 · round5_valid WRONG ≤ 1 · round7_valid exact ≥ 50, WRONG ≤ 6, `time` ≥ 7 / 10 · bonsai v1
  WRONG ≤ 11 · fresh v1 WRONG ≤ 14 · fresh v2 WRONG ≤ 19.
**Step 3 — live path (passes step 2 only):** export `jarvis-reader-r8` (GGUF q8_0 via the Ollama 0.33.3 sandbox; nothing live changes); on
play_heldout_v1 at 0.70: ASK-ON-RIGHT ≤ 3, ACTED-WRONG ≤ 20, and asks on the 60 play lines (any verdict) ≤ 10 (round 7: 21); the bar rule
on the READ sets gives b ≤ 0.70.
**Step 4 — prediction, then the gate:** round 8's live confidence on the r7cal gate's 30 reproduced ask lines written down as the
prediction; then the gate vs prerestart2-20261016, the usual rule (every LOST re-run once, 0 NEW-WRONG, every change read).
**Stated now:** round 8 trains on round 7's data, so round 7's other misreads stay — the 10 gate LOST that are not the bar, b40, v2j07 are
not play labels — and the gate can still fail on them. What round 8 answers: does the play cleanup hold when nothing else is starved? If
yes, the same audit for message and remind (ideally with the second labeler) is next.
**Cost:** held-out and data build no model; baselines ~15 min; training ~4.5 h; bars ~10 min; export + live ~20 min; gate ~1.5 h.
**STEP 1 + DATA DONE (2026-10-17 ~10:41–10:45; no model):**
- Fresh held-out `data/round8_fresh_v1.jsonl` (`build_round8_fresh.js`): 133 lines, 60 Hinglish, 31 acts — time 8, screenshot 5,
  sleep_display 3, system_status 4, list_running 2, player 9, search 8, play 20, play look-alikes 10, open 6, close 5, message 8, call 4,
  remind 6, calendar 3, weather 4, note 3, files 5, tutor 3, dream 2, none 15; shape errors 0; overlap exact 0 / near 0 / self 0 vs
  1,095,893 strings in 421 files + his episodes (41 first-draft lines collided — short everyday phrasing is everywhere in data/ — and were
  rewritten before writing; one negated line, "… dream mode mat chalana", replaced as unclear between none and dream_off). Every label
  read by hand. No model has read it.
- Data `build_round8.py` → `data/reader_round8/train.jsonl` 9,651 rows (round 7: 9,543): 214 rows took the step-3 relabels, 16 unclear
  dropped, 18 dropped because their text is in a measurement set (round 7 had trained on them), 142 new play rows added; identical
  inputs ≤ 2; distinct inputs 8,739, distinct replies 4,596. Every act at round 7's count except play 996 → 1,114 and search_web 468 → 476
  (the "search yt for" relabels); screenshot 78, time 107, system_status 53, sleep_display 30, volume 113 / 99 — unchanged.
  valid = round 7's (no play row of it needed a relabel).
- Waiting for his go: baselines on round8_fresh_v1 (round 5, round 7, the top-up — offline, ~10 min), then training (~4.5 h on mains).
**BASELINES on round8_fresh_v1 (2026-10-17 12:56–12:59, offline, `runs/round8_20261017/baselines.txt`; the set is now READ):**
round 5 90 exact / 12 MISS / 4 REFUSED / 27 WRONG (time 0/8, play 5/20) · **round 7 107 / 2 / 4 / 20** (play 6/20, time 8/8, screenshot 5/5) ·
the top-up 98 / 18 / 4 / 13 (play 19/20, but time 2/8, sleep_display 0/3, list_running 0/2, screenshot 2/5 — the starvation, on lines
neither saw). Round 8's bar on this set: exact ≥ 107 and WRONG ≤ 20. Training waits for mains (his word).
**ROUND 8 RESULT (2026-10-17 13:05–17:05 training, 9,651 iters from round 5, one part, exit 0; graded 17:13; `runs/round8_20261017/
step2_bars.txt`, `step2_failing_rows.txt`): NOT KEPT — 3 of 11 pre-registered bars fail.** Round 5 stays live; nothing exported.
| bar | round 8 | round 7 | |
|---|---|---|---|
| round8_fresh_v1 exact ≥ r7, WRONG ≤ r7 | **113** / 6 / 4 / **10** | 107 / 2 / 4 / 20 | ✓ |
| per-act guard (exact ≥ r7 − 2) | message 82 / 96, system_status 10 / 13, time 35 / 47 | 86, 13, 40 | ✗ |
| play_heldout_v1 60 play ≥ 50 / ≤ 6 | **54** / 2 / 0 / 4 | 24 / 1 / 2 / 33 | ✓ |
| look-alikes WRONG ≤ 2 | 11 / 0 / 0 / **4** | 12 / 0 / 1 / 2 | ✗ |
| other acts exact ≥ 9 | 12 / 0 / 0 / 3 | 10 / 0 / 1 / 4 | ✓ |
| six hold files ≥ 370 / ≤ 26 | 375 / 6 / 8 / 23 | 374 / 7 / 7 / 24 | ✓ |
| round5_valid WRONG ≤ 1 · round7_valid ≥ 50 / ≤ 6 / time ≥ 7 | 27/2/1/0 · 50/6/0/4, time 7 | 28/1/0/1 · 50/4/0/6, time 7 | ✓ ✓ |
| bonsai v1 WRONG ≤ 11 · fresh v1 ≤ 14 · fresh v2 ≤ 19 | 92/4/4/**12** · 87/6/5/7 · 103/0/2/15 | 93/4/4/11 · 85/3/3/14 · 99/0/2/19 | ✗ ✓ ✓ |
**Read (every failing row in step2_failing_rows.txt):** the cleanup held without starving anything wholesale — round 8 beats round 7 on
the fresh set (+6 exact, half the WRONG), the holds, fresh v1 / v2 and play (24 → 54 of 60). The three fails: (1) look-alikes — "… sunao /
suna de" meaning TELL now read as play ("ek chutkula suna de yaar", "koi kahani sunao"), plus "mujhe gaane sunna pasand hai" and "kal raat
netflix pe movie dekhi" (a past statement) → play: the data has many "… gaane sunao" plays and almost no "… sunao" tells or past-tense
music talk; (2) small per-act losses, mostly to none — time 5 ("kitna baj gaya yaar", "abhi time kya ho raha hai"), system_status 3
("computer check karo" → a message to "computer"), message 7 lost / 3 gained (two "ask X if/whether …" → none) — round 8 trained on the
same time / system_status rows as round 7 in a different order, so part of this is run-to-run spread the −2 margin does not allow;
(3) bonsai v1 one WRONG over. Per the rule round 8 is not kept; keeping it anyway (export + live checks + gate) would be his call.
**KEPT ANYWAY FOR TESTING — his call (2026-10-17 ~17:20: "keep round 8 anyway (my call): export jarvis-reader-r8, run the step 3 live
checks, then the gate. nothing goes live").** Export: `jarvis-reader-r8` (1.0 GB, qwen35 Q8_0, round 5's projector) built through the Ollama
0.33.3 sandbox (models/jarvis-reader-r8-hf → sandbox `-q q8_0` → live import), 60 / 60 JSON with token probabilities, median 685 ms.
**STEP 3 (live, `runs/round8_20261017/step3.txt`; round8_live.py): FAILS by one** — play_heldout_v1 at 0.70: ASK-ON-RIGHT 4 (bar ≤ 3),
ACTED-WRONG 2 (≤ 20), asks on the 60 plain play lines 4 (≤ 10; round 7 21). Bar rule on the 13 READ sets (979 lines) vs round 5 at 0.75
(ACTED-WRONG 80, VETO-MISS 48): round 8 meets it at every bar down to 0.30 — the floor, where nothing is ever asked — because round 5 is far
worse on these sets; at 0.30 round 8 would act wrongly 71 times vs 38 at 0.70. Read as the rule being too loose, not as a setting: the
gate runs at **0.70** (round 7's gate bar, so the two gates compare). Live confidence split (round 8, 979 lines): of 23 actions on
non-requests, 16 were at ≥ 0.7 ("spotify mat kholna" → open 0.90, "chrome mat band karna" → close 0.77, "mama ko baad mein call
karunga" → call 0.97, "ek chutkula suna de yaar" → play 0.82) — a confidence gate cannot catch most of them.
**PREDICTION (written before the gate):** on the r7cal gate's 30 reproduced ask lines, round 8 at 0.70 acts on 27 and still asks on 3
("quiz me on electrostatics" 0.44 with the topic garbled "electstatics", "msg sidhu asking for the notes from today" 0.50, "youtube pe
comedy video chala" 0.64); play lines now read at 0.98–0.999. "how many degrees is it" reads none (0.80) and "what does my day look like"
reads calendar `when` "day". Expected: far fewer LOST than r7cal's 40, but round 7's 10 non-bar LOST, b40 / v2j07 and round 8's own new
misreads (negations, statements) can still fail the 0-LOST / 0-NEW-WRONG rule.
**GATE — round 8 at 0.70 (`r8-20261017` vs prerestart2-20261016; 17:38–19:14, one memory-floor stop at v3 247 resumed; every LOST /
NEW-WRONG re-run once as `r8rerun-20261017`; time / weather answers and new bodies read by hand): PASS 533 → 570; 24 LOST + 3 NEW-WRONG
reproduce → FAILS the ship rule** (r7cal: 40 + 2). Did not reproduce: v2q21 (chat fact), m19 (body). Nothing live changed.
The 24 LOST, by cause:
- **The confidence bar — right reading, asked (12):** v3m09, v3m30, v2m19, b33 (messages — each would ALSO get the send-confirm card, so
  the reader's ask is a second ask), v3o02 "launch whatsapp desktop", v3v08 / v2v12 / p11 (play), v2s03 (search), v3r07 (remind), v3t04
  "day and date pls" (time), b04 (calendar).
- **The checker refuses a mostly-right reading, the turn drops to chat (4):** v3m05 "ping sidhu saying cya at practice" (reader put "at
  practice" in `when` → refused: later is off) → "I have not done this before"; v2s12 "search what is chatgpt 5" (query left out "5" →
  refused); v3n05 "jot down that the match is at 4 on sunday" → "Nothing was done"; v3o10 "open discord the server is popping".
- **Misreads / routing (5):** lb20 dentists → web search (business finder never asked), v3u11 "quiz me on electrostatics" (topic garbled
  "electstatics", 0.44 → research lane), u06 "give me my briefing" → calendar, o14 "open netflix lets watch smth" → search netflix
  "smth", x06 "get rid of terminal" → delete (base: quit the app).
- **Message bodies (3):** v2m14 "send ekamveer wya" (no body read → "What should I say?"), v2m23 "if hes free sat" → composer wrote
  "let's hang", m15 "if he got the notes" → composer wrote "send me the notes".
NEW-WRONG (3, each stops at a confirm or plays music): v2u13 "shut down every app thats open" → "Quit every app, sir? Please confirm.",
b40 "quit everything except brave" → "Quit everything except brave, sir? Please confirm." (better than round 7's "Quit Brave"),
v2j07 "kuch mazedaar suna de" → plays music.

## No-training fixes 1 + 2 for the reader path (PLAN, 2026-10-17; his ask "build fix 1 (no double ask on messages/calls/close + tiered
## bar) and fix 2 (ask about one bad field instead of refusing), pre-register and gate-test them with round 8"; written BEFORE any tier
## bar was computed and before any code)
**Why (the r8 gate's 24 LOST):** 12 are right readings that JARVIS asked about (confidence < 0.70), 4 of them messages that would ALSO get
the send-confirm card — a second ask; 4 are readings the checker threw away for ONE field, after which the turn fell to chat ("I have not
done this before"). Across the whole gate the checker refused 15 readings: 8 for a `when` while "later" is off (often time words that
belong to the message or the search: "cya at practice", "omw 5 min", "flights to goa for next month"), 2 for a number left out ("search
what is chatgpt 5"), 5 for a value not quite copied ("electstatics" for "electrostatics").
Both fixes use only JARVIS's own act names, the reader's JSON fields and positions in his text — no word list (rule 1). Both are behind
switches that are OFF by default, so nothing live changes: `JARVIS_READER_TIERS=1` (fix 1), `JARVIS_READER_REPAIR=1` (fix 2).
**Fix 1 — no double ask + a bar per tier (readmodel.build):**
- (a) CONFIRMING acts — message, call, close (each already shows its own card: "Send this to …?", the call offer, "Quit …? Please
  confirm") — are not asked about by the reader at any confidence ≥ the 0.3 floor; their own card is the one question.
- (b) READ-ONLY acts (time, weather, calendar, system_status, list_running, search_web, search_files, read, list, study_stats, dream_log —
  a wrong one only shows a wrong answer) and LOW-STAKES acts (play, open, pause, resume, next_track, volume_up, volume_down, screenshot,
  sleep_display, remind, note, create_folder, create_file, quiz_me — reversible or undoable) each get their own bar; every other act
  keeps 0.70. The veto and the two other server uses of the bar are unchanged.
- **Choosing the two bars (fixed now):** round 8's live readings of the 13 READ sets (runs/round8_20261017/live_jarvis-reader-r8.jsonl),
  graded with today's labels, tier by the act the READING names. For a tier T and bar b: ADDED-WRONG(b) = WRONG readings of T acting at b
  but not at 0.70; ASKS-SAVED(b) = exact readings of T asked at 0.70 but not at b. b_T = the LOWEST of 0.30, 0.35, … 0.70 with
  4 × ADDED-WRONG(b) ≤ ASKS-SAVED(b) — at least four right asks removed for every wrong action added (an ask costs him one word; a wrong
  low-stakes action costs a correction or an undo). No bar below 0.70 qualifies → that tier stays at 0.70.
**Fix 2 — repair or ask about the one bad field, instead of refusing (readmodel.buildInner):** when the checker's objection is
- **a `when` it cannot take** (a WHEN_ACT while later is off, or an act with no `when` at all): if the act has a free-text field the
  `when` words directly follow in his text (message body, search_web query, note content — LABELING: a time inside a body or a query
  belongs to it), the words are joined back onto that field; otherwise the `when` is dropped and he is ASKED ("Should I … now, Sir? I
  cannot do things for later yet.") — never run silently, never scheduled;
- **an identifier left out** (unusedIdent): if it sits directly next to a free-text field's words in his text, the field is extended to
  cover it; otherwise, for a read-only act, the reading stands (nothing it does can lose the thing he named); otherwise refused as now;
- **a value not quite copied:** snapped to the one span of his words it is closest to (character similarity ≥ 0.8, same word count ± 1,
  a single best span); otherwise refused as now.
Every repaired reading is checked again by shapeError and unusedIdent; a repair that does not pass is refused as before. Logged.
**Checks before the gate (record, plus one bar):** unit tests for every branch; run_all green. On the 13 READ sets, the readings fix 2
repairs are listed and graded — **bar: repaired readings that become exact ≥ 2 × those that become WRONG**, else fix 2 is not gated.
**Prediction (before the gate):** written after the bars are chosen — which of the 24 LOST each fix should turn, from the gate rows.
**Gate:** `JARVIS_READER_MODEL=jarvis-reader-r8 JARVIS_READER_MIN_CONFIDENCE=0.70 JARVIS_READER_TIERS=1 JARVIS_READER_REPAIR=1` + the two
bars, tag `r8fix-20261017`, vs prerestart2-20261016 (round 5 live), the usual rule: every LOST / NEW-WRONG re-run once, 0 LOST and 0
NEW-WRONG to pass, every change read. Nothing goes live from this; going live is his call after.
**BUILT + CHECKED (2026-10-17 ~19:20–19:45):**
- **Fix 1 bars, by the rule (`fix1_bars.py`, `runs/round8_20261017/fix1_bars.txt`): BOTH TIERS STAY AT 0.70.** In the 0.3–0.7 band the reader
  is wrong about as often as right: low-stakes at 0.30 would save 16 asks and add 16 wrong actions (0.55: 10 / 9), read-only at 0.30 saves
  10 and adds 5 (0.55: 6 / 2) — never the 4 : 1 the rule asks. So fix 1 is only its first half (no reader ask on message / call / close).
  Record: confirming acts read in the band on the READ sets — 16 exact, 9 WRONG (mostly a field detail: a missing `facetime`, a missing
  `reported`), 4 refused anyway; each goes to its own card, which shows exactly what would be sent / called / quit.
- **Code** (readmodel.js `repaired()`, `nearestSpan()`, build(); server.js askAboutReading `cannotLater`): JARVIS's own act and field
  names, positions in his text found with JARVIS's own tokenizer (actread), character edit distance — no word list, no regex on his words;
  the checker's own error text is not parsed either (the field is read off the reading). Switches `JARVIS_READER_TIERS`,
  `JARVIS_READER_REPAIR`, both OFF by default. Tests `tests/test_reader_repair.js` 25 / 25; run_all 3,105 assertions / 50 suites green;
  integrity re-baselined (379).
- **Fix 2 bar (`runs/round8_20261017/fix2_check.txt`): PASSES** — on round 8's live readings of the 13 READ sets, fix 2 touches 44:
  repaired and acting 12 (11 exact, 1 WRONG — "search the match score at 9 pm" now searches with the time in it), standing read-only 2
  (1 exact, 1 WRONG — "What was open at 3pm?" lists what is open now), asked 31 ("open spotify in like 5 mins" → "Should I open spotify now,
  Sir? I cannot do things for later yet …"). Exact 11 ≥ 2 × WRONG 2.
**PREDICTION (before the gate):** of round 8's 24 reproduced LOST, fix 1 should turn the 4 messages that were asked (v3m09, v3m30, v2m19,
b33) into send cards (their bodies then read by hand — v3m09 and v2m19 go through the composer); fix 2 should turn v3m05 ("cya at
practice"), v2s12 ("chatgpt 5") and v3n05 (the note) — and may gain lines the base also failed (v3m14 "omw 5 min", s06 "flights to goa for
next month"). Left: the 8 non-message asks (bar kept), the 5 misreads / routing (lb20, u06, o14, x06, v3u11 — still asked at 0.44 even with
the topic repaired), the 3 bodies. Expected ≈ 16–18 LOST, NEW-WRONG 3 or more (the band's wrong message / call / close readings now reach
their cards) → still FAILS the 0 / 0 rule, with fewer LOST.
**GATE RESULT — round 8 + fixes 1 + 2 (`r8fix-20261017` vs prerestart2-20261016; 19:27–20:32, one memory-floor stop at v3 235, resumed by
a loop that unloads Ollama between passes; every LOST / NEW-WRONG re-run once as `r8fixrerun-20261017`; time / weather answers and new
bodies read by hand): PASS 533 → 582 (round 8 alone 570); 22 LOST + 5 NEW-WRONG reproduce (round 8 alone 24 + 3) → FAILS the 0 / 0 rule.**
- **What the fixes did:** fix 1 turned all 4 asked messages into send cards (v3m09, v3m30, v2m19, b33 PASS); fix 2 turned v3m05 ("cya at
  practice") and v3t02 ("is today the 11th or 12th" → the date); v3n05 and v2s12 were repaired correctly but read under 0.70, so they are
  now ASKED with the right words ("Should I search the web for “what is chatgpt 5”") instead of dropping to chat.
- **The 22 LOST:** 11 asks under the 0.70 bar (v3o02, v3v08, v3r07, v3t04, v3n05, v3u11, v2s03, v2s12, v2v12, p11, b04 — the tier rule showed
  a lower bar adds about one wrong action per 1–2 asks removed); 5 misreads / routing (lb20 → web search not the business finder, v3o10,
  o14, x06, u06 briefing → calendar); 4 message bodies (v2m14 none read; v2m23, m15, m19 composer); 2 chat / grounded answers (v2q21 currency,
  v2w05 "how many degrees" — not the reader).
- **The 5 NEW-WRONG:** four quit cards — "shut down every app thats open", "quit everything except brave", and two from fix 1 sending
  low-confidence chit-chat straight to the card: "lmaooo stop" → "Quit lmaooo, sir? Please confirm.", "aankhen band ho rahi hain" →
  "Quit aankhen, sir?" (round 8 alone asked "Should I quit …?" there) — and v2j07 "kuch mazedaar suna de" → plays music.
**Read:** the fixes are a net gain (+12 PASS, −2 LOST) but cannot reach 0 / 0 alone. The next no-training step the rows point to is checking
a quit against JARVIS's own app registry before any card (all four quit NEW-WRONG name no installed or running app); the asks are real
uncertainty (the bar rule); misreads, bodies and the chat answers need data or their own lanes' fixes. Both switches stay OFF; nothing live.

## App matcher without the filler-word list (PLAN, 2026-10-17; his ask "look if its keyword/regex trap is a necessity (semantic or smth
## else performs worse than it) and then replace it with the best option"; written BEFORE any candidate was run)
**What is there:** system_control.fuzzyApp — exact / prefix / substring, then whole-word and initials matching of the query's words
against the installed apps (/Applications, /System/Applications, …/Utilities, ~/Applications), accepted at score ≥ 0.5 by open, switch,
hide (close uses its raw words below 0.5). Two hand lists: `APP_FILLER` (the, a, an, app, apps, application, for, mac, macos, os, on, my,
please, open — dropped from the query first; without it "the app store" scores 2 / 3 · 0.6 = 0.4, under the bar) and `ALIAS_BASE`
(chrome, code, vscode, vs, calc, ff, settings, prefs, terminal, finder → an app). Rule 1 bans the first outright; the second is a
nickname table (actread's own matcher says "no nickname table").
**Held-out, written first:** `data/app_match_heldout_v1.jsonl` (`build_app_match_heldout.js`): 101 queries — 80 name an app on this Mac
(plain, with words around them, nicknames, initials, typos), 21 name none (not installed, a site, or the r8 gate's quit look-alikes:
"lmaooo", "aankhen", "every app", "everything except brave").
**Candidates (all at the callers' own 0.5 bar where they score):** C0 today (filler + aliases); C1 no filler list (aliases kept); C2 the
filler list REPLACED BY THE REGISTRY ITSELF — a query word that is no word, word-start or initials of ANY installed app's name cannot
identify one and is set aside (machine statistics of the registry, no list); C3 = C2 without the alias table; C4 the reader's own
resolver (actread: registry anchors, typo match, scaffolding learned from his messages); C5 semantic — nomic-embed-text similarity
between the query and each app name, its threshold chosen on the even-numbered rows and scored on the odd ones (all candidates are
reported on the odd rows too, for a fair comparison).
**Scoring and the decision (fixed now):** WRONG = an app other than the label (or any app when the label is none) — the worst kind;
MISS = no app when the label names one. The filler list is replaced by the best candidate WITHOUT a hand word list (C2 / C3 / C4 / C5)
when that candidate has WRONG ≤ C0's and MISS ≤ C0's; the best = fewest WRONG, then fewest MISS, then no table over a table. If none
qualifies, the list stays and the trade-off is reported. The alias table goes by the same comparison (C3 vs C2). Measured once.
**RESULT (2026-10-17 ~22:40; `jarvis-os/sweeps/sweep_app_match.js`, `runs/app_match_20261017/`; app_match_heldout_v1 now READ; the first
run had a harness bug — alias hits returned an object — fixed and re-run; C0's copy then agrees with today's fuzzyApp on every row):**
| | right | WRONG | MISS |
|---|---|---|---|
| C0 today (filler list + aliases) | **93** | **0** | **8** |
| C1 no filler list | 81 | 0 | 20 |
| C2 the registry's own statistics in place of the list | 81 | 6 | 14 |
| C3 = C2 without aliases | 80 | 6 | 15 |
| C4 the reader's resolver (actread) | 80 | 0 | 21 |
| C5 semantic, nomic (threshold 0.84 from even rows; odd rows) | 39 / 50 | 1 | 10 (C0 on odd rows: 48 / 0 / 2) |
**No candidate without a hand list qualifies (WRONG ≤ 0 and MISS ≤ 8) → by the rule the filler list STAYS for now; the alias table stays
too (C3 is one MISS worse than C2).** What the list does that nothing else here does: it knows "app", "the", "my" are not part of an app's
name. Without it, the words around a name sink the score ("my notes app", "the app store", "photos app" — C1's 12 extra misses); letting
the registry decide instead makes generic words match ("every app" → App Store, "all apps" → Apps, "my mac" → Time Machine — C2's 6 WRONG,
exactly the quit look-alikes). The semantic matcher is safe but misses nicknames, typos and initials ("vs code", "calc", "termnal").
**Next candidate, not yet measured (needs a fresh held-out): C6 = C0 with APP_FILLER replaced by scaffolding by HIS OWN word frequencies
(actread.isScaffold — words in ≥ 5 % of his distinct messages, the reader already uses it): data, not a hand list.**

## Gate of the live setup with tonight's code (2026-10-17; his ask "run the gate with round 5 (live setup) and the new code, then restart
## JARVIS if it passes") — round 5 at 0.75, both reader switches OFF, vs prerestart2-20261016
**First try `live5-20261017` STOPPED at live + v3 (345 lines):** 7 LOST, 5 of them the quit fix itself — "spotify band kar", "close spotify
rq", "ye spotify band kar yaar", "kill discord i need to focus", "quit discord and open spotify" now said "There is no app called “spotify”
on this Mac" (Spotify and Discord are not in /Applications; JARVIS's registry knows them as sites with a Mac app, and the old card is what
the gate expects). Fixed before going on: the reader marks a name its registry recognises (`known`: an app, a browser, a site with a Mac
app) and close_app keeps that card; only names nothing knows ("lmaooo", "every app", "everything except brave") get "no app called …".
Tests updated (test_quit_registry 12, test_readmodel's "close safari" now carries `known`); run_all 3,142 / 52 green; integrity
re-baselined. The other 2 of the 7 (v3m09 composer body, v3q06 grounded answer) are the chat side, re-run with the rest.
**Second try `live5b-20261017`** on the final code — running.
**RESULT `live5b-20261017` (23:06–00:21, all four sets complete, no memory stop): PASS 533 → 534, 0 NEW-WRONG; 5 LOST, none from tonight's
code → PASSES the ship rule.** v3m35 (a composer body) passed on its re-run; v2m04 (composer) failed twice, then passed 3 / 3 on tonight's
code and 3 / 3 on the code from before tonight (swapped in for the sandbox only, restored, hashes checked) — run-to-run variance; v2m23 and
m15 (composer bodies "let's hang", "send me the notes") fail identically on the pre-tonight code — drift, not these changes; v2w05 is a
scorer artifact (the reply is word for word the same in both runs; the baseline's run recorded a weather step and was never read). The
quit fix holds: "close spotify rq", "spotify band kar", "kill discord" keep their card. Every changed line read: 17 decision changes (all
composer bodies or chat answers) and 187 reply-only changes (chat wording, and time / date / weather / battery figures from runs hours
apart) — none touch quit or Settings. → JARVIS restarted with tonight's code (his word: "then restart JARVIS if it passes").

## 2026-10-19 — our own q8_0 writer (reader_gguf.py): the reader rebuilds on Ollama 0.40.3

Problem: `export_reader.sh` / `install.sh` called `ollama create -q q8_0`, which Ollama 0.40.3 cannot do (its `-q` is MLX-only;
int8 ran at ~3 GB, rejected 10-16). r7q8 and r8 were built by hand through Ollama 0.33.3 from a zip in backups/ — a fresh
Mac has neither, so a restore could not rebuild the reader.

Fix: `reader_gguf.py` writes the two GGUF files itself. Every reader round has a byte-identical header (r5 vs r8 compared),
so the header is stored once (`reader_gguf/qwen35-text.header.gz` 3.4 MB, `qwen35-proj.header.gz` 2 KB, cut from the live
files) and each tensor is filled in at its recorded offset. The source tensor and transform for every GGUF name were found
by value (335 text + 154 projector, all matched): rename · +1 on RMS norms · ssm_a = −exp(A_log) in float64 · patch
embedding split into its 2 frames · q8_0 as Ollama 0.33.3's Go code wrote it (incl. ±inf → int32 → low byte on blocks whose
scale underflows; those decode to 0 either way).

Proof (sha256, byte for byte):
- r8 text from models/jarvis-reader-r8-hf → `eccb55a0…` = the live jarvis-reader-r8 blob;
- projector from the base model → `bb2e70b4…` = the projector every round uses;
- END TO END: `export_reader.sh adapters/current q8_0` into a throwaway Ollama 0.40.3 (own port + models dir) → both blobs
  = the live jarvis-reader (`0bec5f9f…`, `bb2e70b4…`), TEMPLATE {{ .Prompt }}.
Any quant other than q8_0 still goes to `ollama create -q`. `gguf==0.19.0` (+ requests, urllib3) added to requirements.txt.

## Composer v3 — a better draft, sent only when the drafter is sure (2026-10-19, written BEFORE any model saw composer_heldout_v3)
Why: every gate loses 2–4 lines to message bodies, and composer v2 (above) showed the DRAFTS are the bottleneck — only 20 / 80
qwen drafts faithful, mostly person conversion ("if he has the charger" kept about him, if-fragments, who-brings-what flipped);
today's code sent a bad text for 30 / 40 reported bodies. Two causes found in the code: (1) the drafting model is shown only the
fragment the reader cut ("if he has the charger"), never his request ("msg harsimran asking if he has the charger"); (2) a draft
is accepted by `invented()` — any 5+-letter word not in his words — a natural-language length check (his rule 1), blind to short
invented words ("send me the charger", "grab", "hang", "eat at 7").

**Development (composer_heldout_v2 — READ on 10-15, so only used to choose; nothing below is decided on it):** the v3 prompt
(agent.composeDirectMessages: his whole request + the part to pass on + who it goes to + 5 worked examples written for the prompt,
max word-Jaccard 0.46 against every composer held-out; no category list) — one draft per row at temperature 0, read side by side
(runs/composer_v3_20261019/dev_*.json, dev_grades.json):

| drafter (v3 prompt) | faithful / 40 | Hinglish / 14 | median warm | does its confidence separate? |
|---|---|---|---|---|
| today: qwen 3B, old prompt (v2 run) | ~10 | — | — | — |
| qwen2.5:3b | 23 | 6 | 0.67 s | NO — its 5 surest drafts hold 2 bad ones |
| phi4-mini (installed reasoner) | 22 | 5 | 0.79 s (+ swap) | YES — surest 25 by min token logprob: 21 faithful, 4 bad |
| jarvis (llama-server) | 8 | 5 | 0.55 s | — (echoes his words) |
| Bonsai-8B | — | — | 17.8 s | — (writes its reasoning as plain text, past 400 tokens) |

A word-coverage constraint (only his words + his own frequent words) was considered and dropped: at the 5% share only 20 of his
words qualify (his messages are commands to JARVIS), so "your / did / tu / tera" are out and person conversion would be impossible.

**Candidate C (behind `JARVIS_COMPOSE_V3=1`, OFF):**
1. The draft: `agent.composeDirectMessages(his request, body, recipient)` → `deps.draft` (server.js): model `JARVIS_COMPOSE_MODEL`,
   default `phi4-mini:latest`, through the memory gate (one model at a time), ONE draft, temperature 0, 60 tokens, token logprobs.
2. Sent only when the draft is non-empty, is not his whole instruction echoed, and its LOWEST token log-probability ≥ −1.2
   (fixed from the dev set: there 21 faithful, 4 bad, 15 asks; any other value needs a fresh set).
3. Otherwise: a body the reader marked `reported` → JARVIS asks "What should the message to <name> say, Sir?" and sends nothing;
   a plain body → his words, as today.
4. `invented()` is not used when the switch is on.

**Baseline B:** today's composeStrict (qwen2.5:3b, the old prompt shown only the body, two drafts at qwen's default temperature,
`invented()`, his words as the fallback).

**Procedure (both see drafts written ONCE, then the real code decides):** composer_heldout_v3.jsonl (60: 48 reported incl. 16
Hinglish, 12 plain controls; sha1 c5eb4c55… — written before this section, overlap-checked against 1.35 M strings and his
episodes). (a) B's two qwen drafts per row and C's phi draft + logprobs per row are written and saved first. (b) Every text
that could reach the confirm card — B's drafts, C's draft and the body as it stands — is graded BY READING, BLIND (row order
shuffled, source hidden), grades saved before the key or any policy outcome is opened: FAITHFUL = said to that person directly,
carrying everything the body says (facts, times, numbers, his slang, his language mix) and nothing he did not say; also INVENTED
(adds content) / INDIRECT (talks about the person instead of to them). For a plain row his own words are FAITHFUL. (c) The real
agent.compose replays them (stubbed llm / draft) for B and for C. Outcome per row: SEND-OK · ASK · SEND-BAD.

**C ships only if ALL hold** (then the regression gate):
1. Reported rows (48): SEND-BAD(C) ≤ 5 AND ≤ half of SEND-BAD(B).
2. Lost sends ≤ 3 (rows SEND-OK under B that are not SEND-OK under C).
3. Accepted INVENTED drafts ≤ 1.
4. Hinglish reported (16): SEND-BAD(C) ≤ 2.
5. Plain controls (12): no row SEND-BAD under C that is not SEND-BAD under B.
6. Time, his apps open, this M1: median added per message ≤ 4 s with phi4-mini loaded COLD (qwen resident before, as live) and
   ≤ 1.5 s warm. (The 3B reloading afterwards, ~2 s on his next helper call, is reported, not barred.)
Regression gate with the switch on: 0 NEW-WRONG, every LOST re-run / proven, every changed body read. If any bar fails, nothing
changes and the result is written here.

**RESULT composer v3 (2026-10-19 22:33; `runs/composer_v3_20261019/`; 217 texts graded blind and saved 22:31 before the key was
opened; composer_heldout_v3 now READ): C FAILS 5 of 6 bars — nothing changes, the switch stays off.**

| | reported 48: OK / ASK / BAD | English 32 | Hinglish 16 | plain 12 OK / BAD | lost sends | accepted invented | added time |
|---|---|---|---|---|---|---|---|
| B (today) | 19 / 0 / 29 | 13 / 0 / 19 | 6 / 0 / 10 | 7 / 5 | — | — | — |
| C (phi4-mini, sure ≥ −1.2) | 21 / 21 / 6 ✗ | 20 / 11 / 1 | 1 / 10 / 5 ✗ | 9 / 3 (p05 new) ✗ | 10 ✗ | 2 ✗ | cold 3.9 s ✓, warm 0.18 s ✓ |

What it shows: (1) in ENGLISH the candidate works — 20 good, 1 bad ("who else is coming to the trek on whatsapp?"), 11 asks,
against today's 13 good / 19 bad. (2) phi4-mini cannot do Hinglish person conversion and is SURE when wrong: "usne project ka chart
banaya kya?", "puch ki woh ghar kitne baje aayega?", "tera sabzi mein kya bana hai?" (to mama). Today's code scores 6 Hinglish sends
only where his words were already direct ("Cycle theek hui ya nahi?"). (3) On plain statements phi flips the person with
confidence ("tell bhai i took the car keys" → "bhai, you took the car keys.") or keeps the instruction ("dm ekamveer, sorry, …").
(4) Today's code mangles 5 of 12 PLAIN bodies on the agent path (agent.js composes plain bodies; the reader path sends them as his
words) — unmeasured as its own candidate. Ideas for a next try, each needs a fresh set and its own bars: C for English only
(language by the Hinglish lane's own embedder, no word list); ask on Hinglish reported bodies, or the reader writing the direct
body (training); plain bodies never composed.

## Composer C2 — English drafted when sure, Hinglish asked, plain never rewritten (2026-10-22, written BEFORE any model saw composer_heldout_v4)
Why: composer v3 (above) showed phi4-mini's sure drafts work in ENGLISH (v3: 20 good / 1 bad / 11 asks against today's 13 / 19)
but it cannot convert Hinglish and is sure when wrong; and today's agent path rewrites PLAIN bodies and got 5 / 12 wrong. Those v3
numbers are hindsight (v3 is read), so C2 is decided on a fresh set. **The trade-off is explicit: an ask is better than a wrong
message.** C2 gives up today's Hinglish sends on reported bodies — those become asks; lost Hinglish sends are reported, not barred.

**C2 (behind `JARVIS_COMPOSE_V3=c2`, OFF; `=1` stays candidate C for the record):**
1. A body the reader did NOT mark `reported` (plain "saying …") → his words, no model call.
2. A `reported` body whose body OR request reads as Hinglish → JARVIS asks "What should the message to <name> say, Sir?" and
   sends nothing. The language check is JARVIS's own `intent.isHinglish` (macOS dictionary registry + nomic centroids, no word
   list; injected as `deps.isHinglish`). If the check fails or is missing → treated as Hinglish (ask).
3. A `reported` English body → candidate C unchanged: phi4-mini, the v3 prompt, one draft at temperature 0, sent only when its
   lowest token logprob ≥ −1.2; otherwise ask.
4. No body at all (noVerbatim) → as candidate C (sure draft, else ask) — unchanged from C, not measured here.

**Baseline B:** today (qwen2.5:3b, old prompt, two drafts, `invented()`, his words as the fallback; plain bodies composed too).

**Set:** composer_heldout_v4.jsonl — 60 written for this file (40 reported: 24 English, 16 Hinglish; 20 plain: 12 English, 8
Hinglish), sha1 8810348a…, overlap-checked against 1.35 M strings (v1–v3, gate sets, all training data) and his episodes.
**Procedure:** as composer v3 — drafts written once (B: two qwen drafts per row; C2: the phi draft + logprobs for every reported
row, and the routing decision recorded), every text that could reach the card under B or C2 graded BY READING, BLIND (shuffled,
source hidden) and saved before the key is opened; the real agent.compose replays both. Same FAITHFUL definition as v3.

**C2 ships only if ALL hold** (then the regression gate):
1. Reported (40): SEND-BAD(C2) ≤ 2 AND ≤ a quarter of SEND-BAD(B).
2. English reported (24): SEND-OK(C2) ≥ SEND-OK(B) — no fewer good English sends than today.
3. Reported asks ≤ 26 / 40 (the 16 Hinglish by design + at most 10 of 24 English).
4. Accepted INVENTED ≤ 1.
5. Plain (20): 0 SEND-BAD.
6. Routing: 16 / 16 Hinglish reported rows routed to ask; ≤ 2 English reported rows routed as Hinglish.
7. Time: median added per English reported message ≤ 4 s with phi loaded cold (qwen resident before), ≤ 1.5 s warm.
If any bar fails, nothing changes and the result is written here.

**RESULT composer C2 (2026-10-22 15:22; `runs/composer_c2_20261022/`; 191 texts graded blind, saved 15:22:44 before the key was
opened; composer_heldout_v4 now READ): C2 PASSES ALL 7 BARS → regression gate (tag c2-20261022, switch on).**

| v4 | reported 40: OK / ASK / BAD | English 24 | Hinglish 16 | plain 20 OK / BAD | invented sent | added time |
|---|---|---|---|---|---|---|
| B (today) | 15 / 0 / 25 | 11 / 0 / 13 | 4 / 0 / 12 | 11 / 9 | — | — |
| C2 | 16 / 23 / 1 ✓ | 16 / 7 / 1 ✓ | 0 / 16 / 0 | 20 / 0 ✓ | 0 ✓ | cold 3.6 s ✓, warm 0.17 s ✓ |

Routing (intent.isHinglish on body or request): 24 / 24 English and 16 / 16 Hinglish reported rows right; one plain row ("lol same")
read as Hinglish — plain bodies are never rewritten, so it costs nothing. The one bad send: "dm parth asking if hes up for valorant
tonight bro" → "bro, parth up for valorant tonight?" (sure −1.09). Lost sends (today good, C2 not): 4 Hinglish by design (asked)
and 3 English — two asks ("where did you keep the HDMI cable?", "how much did you pay for the shoes?" — drafts not sure) and the bad
send above. Grading rule made explicit this round: spelling out an abbreviation ("tmrw" → "tomorrow") is faithful; dropping or
swapping his word ("lol" → "lmao", "cool see you at 5" → "see you at 5") is not.

**C2 GATE — STOPPED BY MEMORY, NOT A RESULT (2026-10-22 15:23–15:45).** gate c2-20261022 hit the sandbox's 15 % memory floor on every
reported message line (5 passes, 19 / 325 v3 lines): phi4-mini at the measured 8192 context is 3.6 GB (`ollama ps`), and beside the
reader, the embedders and his apps free memory falls to 12–14 %. The decision sweep never saw this because it unloaded every other
model before each draft — the "measure on the real machine" lesson again. Probe, same 14 v3 message lines, floor kept at 15 %:
- 8192 (as measured): stopped after 4 lines, lowest free 12 %;
- 2048 (`JARVIS_COMPOSE_CTX`, default unchanged): all 14, lowest free 24 %; phi4-mini 2.8 GB; prompts ≤ 326 tokens.
But a 2048 context CHANGES phi4-mini's output: on the 24 v4 English drafts, token logprobs differ on all 24 and the text on 11 —
so C2's result does not carry over. **C2 at 8192 is not shippable on this Mac; C2 at 2048 needs its own fresh set** (same bars).

## Composer C2-2k — C2 with phi4-mini at a 2048 context (2026-10-22, written BEFORE any model saw composer_heldout_v5)
Why: C2 passed its bars on v4 at an 8192 context, but at 8192 phi4-mini is 3.6 GB and drops this Mac to 12–14 % free beside
JARVIS's other models (the gate stopped on its floor). At 2048 it is 2.8 GB and the probe stayed ≥ 24 % free — but its drafts
change (v4: logprobs 24 / 24, text 11 / 24), so C2's result does not carry over and C2-2k is decided on its own fresh set.
**C2-2k = C2 exactly** (README "Composer C2": plain → his words; reported + Hinglish by intent.isHinglish on body or request → ask;
reported English → phi4-mini, the v3 prompt, one draft at temperature 0, sent only when its lowest token logprob ≥ −1.2, else ask)
**with `JARVIS_COMPOSE_CTX=2048`** (live it needs both `JARVIS_COMPOSE_V3=c2` and `JARVIS_COMPOSE_CTX=2048`). The −1.2 threshold is
NOT re-tuned. **Set:** composer_heldout_v5.jsonl — 60 written for this file (40 reported: 24 English, 16 Hinglish; 20 plain:
12 English, 8 Hinglish), sha1 dd8745aa…, overlap-checked against 1.35 M strings (v1–v4, gate sets, all training data) and his
episodes. **Procedure and grading:** as C2 (drafts once; blind reading; grading rules as written in the C2 result, incl.
spelled-out abbreviations faithful, dropped or swapped words not). **Bars: the same 7 as C2.** Then the regression gate with both
switches on (env, never .env): 0 NEW-WRONG; every LOST re-run / proven or shown to be a reported Hinglish message turned into an
ask BY DESIGN (listed for him); his OK before anything goes live.

**RESULT composer C2-2k (2026-10-22 15:41; `runs/composer_c2k_20261022/`; 184 texts graded blind, saved 15:40:56 before the key
was opened; composer_heldout_v5 now READ): 6 OF 7 BARS PASS — BAR 7 (TIME) FAILS by 62 ms → by the rule nothing changes.**

| v5 | reported 40: OK / ASK / BAD | English 24 | Hinglish 16 | plain 20 OK / BAD | invented sent | added time |
|---|---|---|---|---|---|---|
| B (today) | 13 / 0 / 27 | 8 / 0 / 16 | 5 / 0 / 11 | 9 / 11 | — | — |
| C2-2k | 18 / 21 / 1 ✓ | 18 / 5 / 1 ✓ | 0 / 16 / 0 | 20 / 0 ✓ | 1 ✓ | cold 4.06 s ✗ (bar 4 s), warm 0.17 s ✓ |

Routing 40 / 40 right. Every quality bar passes with room (bad sends 27 → 1, English good sends 8 → 18, plain bad 11 → 0); the
only miss is the cold-start median, 4,062 ms against the 4,000 ms written before the run. Not re-run (re-measuring until a bar
passes is not allowed); whether a ~4 s first-message delay is acceptable is his call, and the gate (memory) still has to pass.
**His call (2026-10-22): accept the 62 ms time miss, look for a faster path, run the gate.** Where the cold time goes (5 cold runs,
qwen resident before, 2048 context): evict qwen ~70 ms · load phi4-mini 2.3–3.1 s · read the ~320-token prompt ~1.5 s · write 7–15
tokens 0.3–0.7 s. Output-neutral options tried: `use_mmap` false vs true — load 2.6–2.9 s vs 2.6–3.1 s (no real difference), drafts
and logprobs identical both ways (4 / 4). Nothing output-neutral saves meaningful time. Faster paths that CHANGE the drafts and so
need their own fresh set: fewer worked examples (~0.5–0.9 s less prompt), or Ollama flash attention (global — would also move the
reader's confidences; not recommended). The gate runs C2-2k exactly as measured (JARVIS_COMPOSE_V3=c2, JARVIS_COMPOSE_CTX=2048).

**GATE c2k-20261022 (C2-2k on: JARVIS_COMPOSE_V3=c2 JARVIS_COMPOSE_CTX=2048; 15:45–17:05, 995 lines, 2 passes, lowest free 16 %):
533 → 534 PASS, 0 NEW-WRONG, 7 LOST, 8 GAINED.** All 7 LOST re-run once (all reproduce — phi4-mini runs at temperature 0):
- 3 chat lines, not composer: v3q06, v2w05 (scorer artifact, as before), v2t04 ("Friday." — right last Friday, wrong on Thursday) —
  identical failures with the switch OFF → drift / artifact.
- 3 English reported messages now ASK (phi4-mini not sure: −1.70, −2.29, −1.35): v3m16 and m02 replaced indirect fragments the
  scorer counts as passes ("if he ate dinner", "if hes coming tonight" sent to the person); v3m33 replaced a passable send ("where the
  party is tonight, bro?"). The pre-registered allowance named only Hinglish asks, so these count as LOST caused by C2 — by design of
  the ask-when-unsure policy, listed for him.
- 1 real C2 bad send: m06 "ping ekamveer on whatsapp asking about the maths hw" → "Hey Ekamveer, can you help me with my maths
  homework? Thanks!" (adds "Thanks!", "help me with"; sure enough to send).
GAINED (message bodies): "can you help me with the physics answers?", "do you need anything from the market?", "did you get my email?",
"what time is dinner?", "did you finish the ppt?", "are you up right now?" (were invented: "send them my way?", "let me know what she
needs", "let me know if you need any help with it", "Let's set a time for dinner, okay?", "send me the ppt", "let's chat"). 12 more
bodies changed with the same verdict, all to direct questions in his words. m13 now asks (was the invented "cool, let's hit it").
Rough edge seen: c12 (no body — the noVerbatim path, not measured in C2) — phi not sure → the agent treats the ask as a failed step and
retries 4 times before "ran out of retries"; nothing wrong sent (today sent his whole instruction). Every changed reply read (16
decisions + 164 replies; 35 more differ only in live numbers). **By the letter the gate does not pass** (4 composer-caused LOST outside
the Hinglish allowance); shipping is his call.

**GATE c2kfix-20261022 (C2-2k + fixes 6/7/8/11; 21:36–22:49): 533 → 535 PASS, 0 NEW-WRONG, 7 LOST** — the same 4 composer lines
as c2k-20261022 (asks on v3m16, v3m33, m02; the bad send m06), v3q06 and v2t04 (drift, proven 10-22), and v2q10 (a Wikipedia-lane
answer that never reaches the composer — re-run with C2 on hedged again, with it off answered). Against c2k-20261022: c12 now asks
once ("What should the message to harsimran say, Sir?", 17.9 s, was 4 retries and "ran out of retries"); "is it still morning" →
"No — it is already 9:47 PM". **DEPLOYED 2026-10-22 22:51 (owner's "deploy fix"):** `JARVIS_COMPOSE_V3=c2` and
`JARVIS_COMPOSE_CTX=2048` appended to .env (backup in backups/), integrity re-baselined, JARVIS restarted; checked through the sandbox
with no overrides — "msg harsimran asking if he has the charger" → "have you got the charger?", a plain body stays his words.
Off switch: delete the two lines and restart.
