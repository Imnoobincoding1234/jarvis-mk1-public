#!/usr/bin/env python3
"""
LoRA ON BONSAI 4B, SCORING ONLY THE REPLY. 2026-09-25 — the trainer for the `jarvis` model.

WHY NOT `mlx_lm lora`. Every JARVIS example carries the ~1,000-token system prompt, and Bonsai's vocabulary
is 151,669 words: the stock loss builds logits for EVERY position — 1,100 x 151,669, ~0.7 GB, and as much again
for its gradient — to score the ~20 tokens of the reply. On this 8 GB Mac the 10-step spike was stopped by
guard.py at 17% free before its first step. Here the model runs to its last hidden state and only the reply
positions go through the (tied) output head, so that cost all but vanishes. Not compiled: the reply's length
changes every example, and batch size is 1 anyway.

Base: models/Bonsai-4B-mlx-2bit (repack_bonsai.py — Bonsai's own 1-bit weights, exactly). Data: <dir>/train.jsonl
and valid.jsonl, one {"messages": [...]} per line; the LAST message is the assistant reply that is scored, the
rest is the prompt, rendered with the model's chat template and thinking OFF — the same text generation sees.

  MLX_LIMIT_GB=2.5 ./.venv/bin/python guard.py --min-free 18 --min-battery 30 -- \
    ./.venv/bin/python train_bonsai.py --data data/bonsai_jarvis --adapter-path adapters/bonsai_a --seed 1
"""
import argparse, json, math, os, random, time

import mlx.core as mx

mx.set_memory_limit(int(float(os.environ.get('MLX_LIMIT_GB', '2.5')) * 1024 ** 3))
mx.set_cache_limit(int(float(os.environ.get('MLX_CACHE_GB', '0.5')) * 1024 ** 3))

import mlx.nn as nn                                     # noqa: E402
import mlx.optimizers as optim                          # noqa: E402
from mlx.utils import tree_flatten, tree_unflatten, tree_map  # noqa: E402
from mlx_lm import load                                 # noqa: E402
from mlx_lm.tuner.utils import linear_to_lora_layers    # noqa: E402
from mlx_lm.tuner.trainer import grad_checkpoint        # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--model', default='models/Bonsai-4B-mlx-2bit')
ap.add_argument('--data', required=True)
ap.add_argument('--adapter-path', required=True)
ap.add_argument('--iters', type=int, default=600)
ap.add_argument('--lr', type=float, default=1e-4)
ap.add_argument('--rank', type=int, default=8)
ap.add_argument('--scale', type=float, default=20.0)
ap.add_argument('--dropout', type=float, default=0.0)
ap.add_argument('--num-layers', type=int, default=16)
ap.add_argument('--max-seq', type=int, default=1600)
ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--val-every', type=int, default=100)
ap.add_argument('--save-every', type=int, default=100)
# RESUME after guard.py stops a run (he used the Mac): the last saved <iter>_adapters.safetensors in
# --adapter-path is loaded and training continues from that iteration. The optimiser's memory (Adam's running
# averages and step count) is saved beside every save and loaded back too: a FRESH optimiser after a resume
# took full-size steps and threw the held-back error up (v2: 0.92 -> 1.71 after step 475; v3: 1.00 -> 1.54 after
# step 1175, 2026-10-01). Saves from before this fix have no optimiser file; those still resume fresh, and say so.
ap.add_argument('--resume', action='store_true')
# START FROM another run's adapter (v3.1 from v3's step 1000): its weights are loaded before step 1 — a new run,
# so a new optimiser — and --warmup ramps the learning rate up from 0 over the first N steps, so that fresh
# optimiser cannot take the full-size first steps that threw the held-back error up after v3's resume.
ap.add_argument('--init-from', default=None)
ap.add_argument('--warmup', type=int, default=0)
# v4.2 "masters" (2026-10-05) — every flag below defaults to the old behaviour, so earlier runs resume unchanged.
# GRADIENT ACCUMULATION: one update from N rows instead of one. Batch 1 made every update follow a single row (v4.1's
# training error swung 0.12 <-> 0.9 step to step). --iters, --warmup, --val-every and --save-every count UPDATES.
ap.add_argument('--grad-accum', type=int, default=1)
# COSINE DECAY after warm-up, down to --min-lr-ratio x --lr at the last update: a constant rate never let the end settle
# (v4.1's held-back error rose after step 2100 of 2487).
ap.add_argument('--schedule', choices=['constant', 'cosine'], default='constant')
ap.add_argument('--min-lr-ratio', type=float, default=0.1)
# NEFTUNE (Jain et al. 2023): uniform noise on the input embeddings while training — alpha / sqrt(tokens x width) — so the
# model cannot memorise exact surface strings; published to make chat replies less templated. Off for every evaluation.
ap.add_argument('--neftune', type=float, default=0.0)
# HELD-BACK PER KIND: rows carrying "kind" are scored per kind; the printed val is the MACRO average (each kind counts the
# same), followed by the plain row average and the per-kind numbers. Choosing by the macro average stops the many long web
# rows from outvoting the short chat kinds. --val-max-per-kind caps each kind's rows (seeded) to make the checks faster.
ap.add_argument('--val-max-per-kind', type=int, default=0)
args = ap.parse_args()
random.seed(args.seed); mx.random.seed(args.seed)

model, tok = load(args.model)
model.freeze()
lora_cfg = {'rank': args.rank, 'scale': args.scale, 'dropout': args.dropout}
linear_to_lora_layers(model, args.num_layers, lora_cfg)
grad_checkpoint(model.model.layers[0])
n_train = sum(v.size for _, v in tree_flatten(model.trainable_parameters()))
print('trainable parameters: %.3fM' % (n_train / 1e6), flush=True)

def encode(row):
    msgs = row['messages']
    assert msgs[-1]['role'] == 'assistant'
    prompt = tok.apply_chat_template(msgs[:-1], add_generation_prompt=True, tokenize=False, enable_thinking=False)
    p_ids = tok.encode(prompt, add_special_tokens=False)
    full = tok.encode(prompt + msgs[-1]['content'] + '<|im_end|>', add_special_tokens=False)
    assert full[:len(p_ids)] == p_ids, 'prompt tokens changed when the reply was appended'
    # the reply is at the END: a row longer than --max-seq would train on a cut reply or none — skipped, and counted
    return (full, len(p_ids), row.get('kind', 'all')) if len(full) <= args.max_seq else None

def load_rows(name):
    path = os.path.join(args.data, name)
    rows = [encode(json.loads(l)) for l in open(path) if l.strip()] if os.path.exists(path) else []
    if any(r is None for r in rows): print('%s: skipped %d rows longer than %d tokens' % (name, sum(r is None for r in rows), args.max_seq), flush=True)
    return [r for r in rows if r is not None]

train, valid = load_rows('train.jsonl'), load_rows('valid.jsonl')
if args.val_max_per_kind:
    rv = random.Random(args.seed + 7)
    by_kind = {}
    for r in valid: by_kind.setdefault(r[2], []).append(r)
    valid = [r for k in sorted(by_kind) for r in (rv.sample(by_kind[k], args.val_max_per_kind) if len(by_kind[k]) > args.val_max_per_kind else by_kind[k])]
print('train %d, valid %d, longest %d tokens' % (len(train), len(valid), max(len(t) for t, _, _ in train + valid)), flush=True)
kinds_v = {}
for _, _, k in valid: kinds_v[k] = kinds_v.get(k, 0) + 1
if len(kinds_v) > 1: print('valid kinds: ' + ', '.join('%s %d' % kv for kv in sorted(kinds_v.items())), flush=True)

head = model.model.embed_tokens.as_linear if model.args.tie_word_embeddings else model.lm_head

def loss_fn(model, ids, off, noise=0.0):
    x = mx.array(ids)[None]
    inp = x[:, :-1]
    if noise:                                   # NEFTune: training only (evaluate() passes no noise)
        emb = model.model.embed_tokens(inp)
        scale = noise / math.sqrt(emb.shape[1] * emb.shape[2])
        h = model.model(inp, input_embeddings=emb + mx.random.uniform(-scale, scale, emb.shape).astype(emb.dtype))
    else:
        h = model.model(inp)                    # hidden states for every position
    h = h[:, off - 1:]                          # only the positions that predict the reply
    logits = head(h)
    tgt = x[:, off:]
    return nn.losses.cross_entropy(logits, tgt).astype(mx.float32).mean()

loss_and_grad = nn.value_and_grad(model, loss_fn)
if args.schedule == 'cosine':
    decay = optim.cosine_decay(args.lr, max(1, args.iters - args.warmup), end=args.lr * args.min_lr_ratio)
    lr_sched = optim.join_schedules([optim.linear_schedule(0.0, args.lr, args.warmup), decay], [args.warmup]) if args.warmup else decay
else:
    lr_sched = optim.linear_schedule(0.0, args.lr, args.warmup) if args.warmup else args.lr
opt = optim.Adam(learning_rate=lr_sched)

order_state = []

def evaluate():
    """macro average over kinds (each kind counts the same), the plain row average, and each kind's mean"""
    if not valid:
        return float('nan'), float('nan'), {}
    per = {}
    for ids, off, k in valid:
        per.setdefault(k, []).append(loss_fn(model, ids, off).item())
    means = {k: sum(v) / len(v) for k, v in per.items()}
    rows = sum(sum(v) for v in per.values()) / len(valid)
    return sum(means.values()) / len(means), rows, means

def val_line(it):
    macro, rows, means = evaluate()
    extra = ('  rows %.4f  [%s]' % (rows, ' '.join('%s %.3f' % kv for kv in sorted(means.items())))) if len(means) > 1 else ''
    return 'iter %d: val %.4f%s' % (it, macro, extra)

def save(tag):
    os.makedirs(args.adapter_path, exist_ok=True)
    mx.save_safetensors(os.path.join(args.adapter_path, 'adapters.safetensors'), dict(tree_flatten(model.trainable_parameters())))
    if tag:
        mx.save_safetensors(os.path.join(args.adapter_path, '%s_adapters.safetensors' % tag), dict(tree_flatten(model.trainable_parameters())))
        mx.save_safetensors(os.path.join(args.adapter_path, '%s_optimizer.safetensors' % tag), dict(tree_flatten(opt.state)))
    json.dump({'fine_tune_type': 'lora', 'num_layers': args.num_layers, 'lora_parameters': lora_cfg,
               'model': args.model, 'seed': args.seed, 'lr': args.lr, 'iters': args.iters, 'init_from': args.init_from, 'warmup': args.warmup,
               'grad_accum': args.grad_accum, 'schedule': args.schedule, 'min_lr_ratio': args.min_lr_ratio, 'neftune': args.neftune},
              open(os.path.join(args.adapter_path, 'adapter_config.json'), 'w'), indent=2)

start = 0
if args.init_from:
    model.load_weights(args.init_from, strict=False)
    print('started from %s' % args.init_from, flush=True)
if args.resume:
    ck = sorted(f for f in os.listdir(args.adapter_path) if f.endswith('_adapters.safetensors')) if os.path.isdir(args.adapter_path) else []
    if ck:
        model.load_weights(os.path.join(args.adapter_path, ck[-1]), strict=False)
        start = int(ck[-1].split('_')[0])
        ost = os.path.join(args.adapter_path, '%07d_optimizer.safetensors' % start)
        if os.path.exists(ost):
            opt.state = tree_unflatten(list(mx.load(ost).items()))
            print('optimiser state loaded (step %d)' % opt.state['step'].item(), flush=True)
        else:
            print('no optimiser state saved for iter %d - resuming with a fresh optimiser' % start, flush=True)
        for _ in range(start * args.grad_accum):  # replay the shuffle so the data order continues where it stopped
            if not order_state: order_state.extend(random.sample(range(len(train)), len(train)))
            order_state.pop()
        print('resumed from %s (iter %d)' % (ck[-1], start), flush=True)
model.train()
order, t0, run = order_state, time.monotonic(), 0.0   # monotonic: a closed lid does not count
print(val_line(start), flush=True)
A = max(1, args.grad_accum)
for it in range(start + 1, args.iters + 1):
    acc, upd_loss = None, 0.0
    for _ in range(A):                            # one update from A rows; the gradient is their mean
        if not order:
            order.extend(random.sample(range(len(train)), len(train)))
        ids, off, _k = train[order.pop()]
        loss, grads = loss_and_grad(model, ids, off, args.neftune)
        acc = grads if acc is None else tree_map(lambda a, b: a + b, acc, grads)
        mx.eval(acc, loss)
        upd_loss += loss.item()
    if A > 1:
        acc = tree_map(lambda g: g / A, acc)
    opt.update(model, acc)
    mx.eval(model.parameters(), opt.state)
    run += upd_loss / A
    if it % 10 == 0:
        lr_now = lr_sched(opt.step) if callable(lr_sched) else lr_sched
        print('iter %d: train %.4f  lr %.2e  %.1f s/it  peak %.2f GB' % (it, run / 10, float(lr_now), (time.monotonic() - t0) / (it - start), mx.get_peak_memory() / 1024 ** 3), flush=True)
        run = 0.0
    if it % args.val_every == 0 or it == args.iters:
        print(val_line(it), flush=True)
    if it % args.save_every == 0 or it == args.iters:
        save('%07d' % it)
print('done in %.0f s awake' % (time.monotonic() - t0), flush=True)
