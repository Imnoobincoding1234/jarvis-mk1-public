#!/usr/bin/env python3
"""Fused reader weights -> the two GGUF files Ollama runs as jarvis-reader, with no converter (2026-10-19).

WHY. Ollama 0.40.3 only quantizes safetensors to its MLX formats (int4/int8/nvfp4/mxfp4/mxfp8); its int8 build ran on
the MLX engine at ~3 GB (rejected 10-16). The q8_0 GGUF the live reader is came from Ollama 0.33.3's converter, run by
hand from a zip in backups/ that a fresh Mac does not have — so install.sh could not rebuild the reader.

WHAT. Every reader round has the SAME header — settings, tokenizer, tensor table, offsets (r5 and r8 compared byte for
byte) — because a LoRA changes weights, never shapes. So the header is stored once (reader_gguf/*.header.gz, cut from
the live files) and a round is written by filling each tensor in at its recorded offset. The tensor each GGUF name
comes from, and its transform, were found by VALUE against r8 and the base model (all 335 + 154 matched):

  text   rename · +1 on the RMS norms (Qwen3.5 stores them zero-centred) · ssm_a = -exp(A_log) in float64 · q8_0
  proj   rename · the patch embedding split into its two frames · copied as stored (BF16 / F32)

q8_0 is written the way Ollama 0.33.3's Go quantizer wrote it, including its one oddity: a block whose values are so
small that d = amax/127 underflows float32's normal range gets 1/d = +inf, and Go turns ±inf into int32 max/min, whose
low byte is 0xFF / 0x00. Those blocks decode to exactly 0 either way (their fp16 scale is 0), but matching them is what
makes the file byte-identical — and byte-identical is the proof: same sha256 as the live blob = the same model.

  ./.venv/bin/python reader_gguf.py text  <fused hf dir> <out.gguf>     the language model, q8_0
  ./.venv/bin/python reader_gguf.py proj  <base dir>     <out.gguf>     the vision projector (identical every round)
  ./.venv/bin/python reader_gguf.py check <a.gguf> <b.gguf>             sha256 + first differing tensor
  ./.venv/bin/python reader_gguf.py header <live text gguf> <live proj gguf>   re-cut the two stored headers
"""
import gzip, hashlib, json, os, struct, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
HEADERS = {'text': os.path.join(HERE, 'reader_gguf', 'qwen35-text.header.gz'),
           'proj': os.path.join(HERE, 'reader_gguf', 'qwen35-proj.header.gz')}
ALIGN = 32                                    # GGUF default; neither file sets general.alignment

# ---- reading: GGUF header (tensor table) and safetensors (numpy has no bfloat16, so BF16 is widened by hand) ----
SCALAR = {0: '<B', 1: '<b', 2: '<H', 3: '<h', 4: '<I', 5: '<i', 6: '<f', 7: '<?', 10: '<Q', 11: '<q', 12: '<d'}
TYPES = {0: ('F32', 4, 1), 1: ('F16', 2, 1), 8: ('Q8_0', 34, 32), 30: ('BF16', 2, 1)}   # ggml type: name, bytes per block, block size


def parse_header(buf):
    """-> (kv dict of scalars/strings, tensors [(name, type, shape in ggml order, offset)], data start)."""
    pos = 0
    def take(fmt):
        nonlocal pos
        v = struct.unpack_from(fmt, buf, pos); pos += struct.calcsize(fmt); return v[0]
    def string():
        nonlocal pos
        n = take('<Q'); s = bytes(buf[pos:pos + n]).decode('utf-8', 'replace'); pos += n; return s
    def value(t):
        if t == 8: return string()
        if t == 9:
            et, n = take('<I'), take('<Q')
            for _ in range(n): value(et)
            return None                       # arrays (tokenizer) are carried as bytes, never needed here
        return take(SCALAR[t])
    assert bytes(buf[:4]) == b'GGUF', 'not a GGUF header'
    pos = 4; take('<I'); n_t, n_kv = take('<Q'), take('<Q')
    kv = {}
    for _ in range(n_kv):
        k = string(); kv[k] = value(take('<I'))
    tensors = []
    for _ in range(n_t):
        name = string(); nd = take('<I'); shape = [take('<Q') for _ in range(nd)]
        tensors.append((name, take('<I'), shape, take('<Q')))
    return kv, tensors, -(-pos // ALIGN) * ALIGN


class Safetensors:
    def __init__(self, folder_or_file):
        files = [folder_or_file] if os.path.isfile(folder_or_file) else sorted(
            os.path.join(folder_or_file, f) for f in os.listdir(folder_or_file) if f.endswith('.safetensors'))
        self.where = {}
        for p in files:
            with open(p, 'rb') as f:
                n = struct.unpack('<Q', f.read(8))[0]; h = json.loads(f.read(n))
            mm = np.memmap(p, dtype=np.uint8, mode='r')
            for k, e in h.items():
                if k != '__metadata__': self.where[k] = (mm, 8 + n, e)
        if not self.where: raise SystemExit('no .safetensors in ' + folder_or_file)

    def raw(self, k):
        mm, base, e = self.where[k]; a, b = e['data_offsets']
        return mm[base + a:base + b], e['dtype'], e['shape']

    def f32(self, k):
        r, dt, shape = self.raw(k)
        if dt == 'BF16': x = (r.view(np.uint16).astype(np.uint32) << 16).view(np.float32)
        elif dt == 'F32': x = np.array(r.view(np.float32))
        elif dt == 'F16': x = r.view(np.float16).astype(np.float32)
        else: raise SystemExit(k + ': unexpected dtype ' + dt)
        return x.reshape(shape)


# ---- which source tensor each GGUF tensor is (llama.cpp's qwen35 / clip names = the machine's own registry) ----
NORM, NEG_EXP = '+1', '-exp'
TEXT_BLOCK = {
    'attn_norm.weight': ('input_layernorm.weight', NORM), 'post_attention_norm.weight': ('post_attention_layernorm.weight', NORM),
    'ffn_gate.weight': ('mlp.gate_proj.weight', None), 'ffn_up.weight': ('mlp.up_proj.weight', None), 'ffn_down.weight': ('mlp.down_proj.weight', None),
    'attn_qkv.weight': ('linear_attn.in_proj_qkv.weight', None), 'attn_gate.weight': ('linear_attn.in_proj_z.weight', None),
    'ssm_alpha.weight': ('linear_attn.in_proj_a.weight', None), 'ssm_beta.weight': ('linear_attn.in_proj_b.weight', None),
    'ssm_a': ('linear_attn.A_log', NEG_EXP), 'ssm_dt.bias': ('linear_attn.dt_bias', None),
    'ssm_conv1d.weight': ('linear_attn.conv1d.weight', None), 'ssm_norm.weight': ('linear_attn.norm.weight', None),
    'ssm_out.weight': ('linear_attn.out_proj.weight', None),
    'attn_q.weight': ('self_attn.q_proj.weight', None), 'attn_k.weight': ('self_attn.k_proj.weight', None),
    'attn_v.weight': ('self_attn.v_proj.weight', None), 'attn_output.weight': ('self_attn.o_proj.weight', None),
    'attn_q_norm.weight': ('self_attn.q_norm.weight', NORM), 'attn_k_norm.weight': ('self_attn.k_norm.weight', NORM),
}
TEXT_NEXTN = {  # the multi-token-prediction layer, written as the last block
    'nextn.eh_proj.weight': ('mtp.fc.weight', None), 'nextn.enorm.weight': ('mtp.pre_fc_norm_embedding.weight', NORM),
    'nextn.hnorm.weight': ('mtp.pre_fc_norm_hidden.weight', NORM), 'nextn.shared_head_norm.weight': ('mtp.norm.weight', NORM),
}
TEXT_TOP = {'token_embd.weight': ('model.language_model.embed_tokens.weight', None),
            'output_norm.weight': ('model.language_model.norm.weight', NORM)}
PROJ_BLOCK = {
    'attn_qkv': 'attn.qkv', 'attn_out': 'attn.proj', 'ffn_up': 'mlp.linear_fc1', 'ffn_down': 'mlp.linear_fc2', 'ln1': 'norm1', 'ln2': 'norm2'}
PROJ_TOP = {'mm.0': 'model.visual.merger.linear_fc1', 'mm.2': 'model.visual.merger.linear_fc2', 'v.post_ln': 'model.visual.merger.norm',
            'v.position_embd': 'model.visual.pos_embed', 'v.patch_embd': 'model.visual.patch_embed.proj'}


def text_source(name, kv):
    if name in TEXT_TOP: return TEXT_TOP[name] + (None,)
    _, n, rest = name.split('.', 2)
    n, nextn = int(n), kv['qwen35.block_count'] - kv['qwen35.nextn_predict_layers']
    if n >= nextn and rest in TEXT_NEXTN: return TEXT_NEXTN[rest] + (None,)
    hf, tf = TEXT_BLOCK[rest]
    return ('mtp.layers.%d.' % (n - nextn) if n >= nextn else 'model.language_model.layers.%d.' % n) + hf, tf, None


def proj_source(name, kv):
    if name.startswith('v.blk.'):
        _, _, n, mod, leaf = name.split('.')
        return 'model.visual.blocks.%s.%s.%s' % (n, PROJ_BLOCK[mod], leaf), None, None
    if name.startswith('v.patch_embd.weight'):            # Conv3d (out, in, frames, h, w) -> one 2D kernel per frame
        return 'model.visual.patch_embed.proj.weight', None, int(name.endswith('.1'))
    stem, leaf = name.rsplit('.', 1)
    return PROJ_TOP[stem] + '.' + leaf, None, None


# ---- encoding --------------------------------------------------------------------------------------------------
def roundf(x):                                           # C roundf: half away from zero, exact (gguf-py's np_roundf)
    a = np.abs(x); f = np.floor(a); return np.sign(x) * (f + np.floor(2 * (a - f)))


def q8_0(x):
    b = np.ascontiguousarray(x, dtype=np.float32).reshape(-1, 32)
    d = (np.abs(b).max(axis=1, keepdims=True) / np.float32(127)).astype(np.float32)
    with np.errstate(divide='ignore', over='ignore', invalid='ignore'):
        inv = np.where(d != 0, np.float32(1) / d, np.float32(0)).astype(np.float32)
        v = (b * inv).astype(np.float32)
        r = np.where(np.isfinite(v), roundf(v), v)
    r = np.nan_to_num(r.astype(np.float64), nan=0.0, posinf=2147483647.0, neginf=-2147483648.0)   # Go: int32(±inf) saturates
    qs = (r.astype(np.int64) & 0xFF).astype(np.uint8)                                             # then int8() keeps the low byte
    return np.concatenate([d.astype(np.float16).view(np.uint8).reshape(-1, 2), qs], axis=1).tobytes()


def bf16(x):                                             # float32 -> bfloat16, round to nearest even
    u = np.ascontiguousarray(x, dtype=np.float32).view(np.uint32)
    return ((u + 0x7FFF + ((u >> 16) & 1)) >> 16).astype(np.uint16).tobytes()


ROWS = 8192                                              # token_embd is 248,320 x 1,024: ~1 GB as float32 at once


def encode(st, src, transform, frame, gtype, shape):
    """Yields the tensor's bytes. q8_0 blocks run along the last axis, so a plain 2D weight is encoded a slice of rows
    at a time (identical bytes, a fraction of the memory — the whole-table version pushed this Mac into swap)."""
    raw, dt, src_shape = st.raw(src)
    if gtype == 30 and dt == 'BF16' and transform is None and frame is None:
        yield bytes(raw); return                         # already what the file stores
    if gtype == 8 and transform is None and frame is None and dt == 'BF16' and len(src_shape) == 2 \
            and list(src_shape) == [int(s) for s in reversed(shape)]:
        rows = raw.view(np.uint16).reshape(src_shape)
        for i in range(0, src_shape[0], ROWS):
            yield q8_0((rows[i:i + ROWS].astype(np.uint32) << 16).view(np.float32))
        return
    yield encode_whole(st, src, transform, frame, gtype, shape)


def encode_whole(st, src, transform, frame, gtype, shape):
    x = st.f32(src)
    if frame is not None: x = x[:, :, frame]
    if transform == NORM: x = x + np.float32(1)
    elif transform == NEG_EXP: x = (-np.exp(x.astype(np.float64))).astype(np.float32)
    x = x.reshape(tuple(int(s) for s in reversed(shape)))
    if gtype == 8: return q8_0(x)
    if gtype == 0: return x.astype(np.float32).tobytes()
    if gtype == 30: return bf16(x)
    if gtype == 1: return x.astype(np.float16).tobytes()
    raise SystemExit('unsupported tensor type %d' % gtype)


def write(kind, src_dir, out):
    head = gzip.open(HEADERS[kind]).read()
    kv, tensors, start = parse_header(head)
    st = Safetensors(src_dir)
    source = text_source if kind == 'text' else proj_source
    tmp = out + '.part'
    with open(tmp, 'wb') as f:
        f.write(head); f.write(b'\0' * (start - len(head)))
        for name, gtype, shape, off in tensors:
            here = f.tell() - start
            if here > off: raise SystemExit(name + ': layout overrun')
            f.write(b'\0' * (off - here))
            src, tf, frame = source(name, kv)
            n = 0
            for part in encode(st, src, tf, frame, gtype, shape): f.write(part); n += len(part)
            bt, per = TYPES[gtype][1], TYPES[gtype][2]
            if n != int(np.prod(shape)) // per * bt: raise SystemExit(name + ': wrong size from ' + src)
    os.replace(tmp, out)
    print('%s: %d tensors -> %s (%.1f MB) sha256 %s' % (kind, len(tensors), out, os.path.getsize(out) / 1e6, sha256(out)[:16]))


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 24), b''): h.update(c)
    return h.hexdigest()


def check(a, b):
    sa, sb = sha256(a), sha256(b)
    if sa == sb: print('IDENTICAL sha256 ' + sa); return 0
    ha, hb = (open(p, 'rb').read(64 << 20) for p in (a, b))
    _, ta, start = parse_header(ha)
    if ha[:start] != hb[:start]: print('DIFFER in the header'); return 1
    with open(a, 'rb') as fa, open(b, 'rb') as fb:
        for name, gtype, shape, off in ta:
            n = int(np.prod(shape)) // TYPES[gtype][2] * TYPES[gtype][1]
            fa.seek(start + off); fb.seek(start + off)
            if fa.read(n) != fb.read(n): print('DIFFER first at tensor ' + name); return 1
    print('DIFFER outside the tensors (padding / length)'); return 1


def cut_headers(text_gguf, proj_gguf):
    os.makedirs(os.path.dirname(HEADERS['text']), exist_ok=True)
    for kind, p in (('text', text_gguf), ('proj', proj_gguf)):
        buf = open(p, 'rb').read(64 << 20)
        _, tensors, start = parse_header(buf)
        hdr = buf[:start]                             # up to where tensor data begins, alignment padding included
        with gzip.GzipFile(HEADERS[kind], 'wb', 9, mtime=0) as g: g.write(hdr)
        print('%s header: %d tensors, %d bytes -> %s' % (kind, len(tensors), len(hdr), HEADERS[kind]))


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 3 and a[0] in ('text', 'proj'): write(a[0], a[1], a[2])
    elif len(a) == 3 and a[0] == 'check': sys.exit(check(a[1], a[2]))
    elif len(a) == 3 and a[0] == 'header': cut_headers(a[1], a[2])
    else: print(__doc__); sys.exit(2)
