'use strict';
// ---------------------------------------------------------------------------
// A zero-dependency Parquet COLUMN reader — local files or remote ones over HTTP ranges.
//
// WHY: MolmoWeb's trajectory sets are ~180 GB (human) and ~280 GB (synthetic) because every row carries
// its screenshots. The v4 web model needs only two TEXT columns — the instruction and the trajectory —
// and Parquet stores each column separately, so those can be fetched by byte range without touching a
// single image: the footer (~100 KB) says where each column chunk lives, and only those bytes are read.
// pyarrow would do it; this is the JS rebuild, so JARVIS stays zero-npm and nothing Python is needed.
//
// Scope, on purpose: flat (top-level) columns of BYTE_ARRAY / INT32 / INT64 / BOOLEAN / DOUBLE / FLOAT,
// optional or required; data pages v1 and v2; PLAIN and dictionary (PLAIN_DICTIONARY / RLE_DICTIONARY)
// encodings; codecs UNCOMPRESSED, SNAPPY (decoder below), GZIP, BROTLI, ZSTD (node:zlib). Nested and
// repeated columns are refused with a clear error rather than read wrongly.
// ---------------------------------------------------------------------------

const fs = require('fs');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// ---------------- byte sources ----------------
function fileSource(path) {
  const fd = fs.openSync(path, 'r'), size = fs.fstatSync(fd).size;
  return { size: async () => size, read: async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; }, close: () => fs.closeSync(fd) };
}
function httpGet(url, headers, hops) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers: Object.assign({ 'user-agent': 'JARVIS-parquet/1.0' }, headers || {}), timeout: 60000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); if ((hops || 0) > 6) return reject(new Error('too many redirects'));
        return resolve(httpGet(new URL(res.headers.location, url).toString(), headers, (hops || 0) + 1));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
function httpSource(url) {
  let size = null;
  const read = async (off, len) => {
    for (let t = 0; t < 4; t++) {
      try {
        const r = await httpGet(url, { range: 'bytes=' + off + '-' + (off + len - 1) });
        if (r.status !== 206 && !(r.status === 200 && off === 0 && r.body.length === len)) throw new Error('range not honoured (HTTP ' + r.status + ')');
        if (r.body.length !== len) throw new Error('short read ' + r.body.length + '/' + len);
        if (size == null && r.headers['content-range']) size = Number(String(r.headers['content-range']).split('/')[1]);
        return r.body;
      } catch (e) { if (t === 3) throw e; await new Promise(r => setTimeout(r, 1000 * (t + 1))); }
    }
  };
  return {
    size: async () => { if (size == null) await read(0, 4); return size; },
    read, close: () => {},
  };
}

// ---------------- Thrift compact protocol (what Parquet's footer and page headers are written in) ----------------
class Thrift {
  constructor(buf, pos) { this.b = buf; this.p = pos || 0; }
  byte() { return this.b[this.p++]; }
  varint() { let r = 0n, s = 0n, x; do { x = this.b[this.p++]; r |= BigInt(x & 0x7f) << s; s += 7n; } while (x & 0x80); return r; }
  zz() { const v = this.varint(); return (v >> 1n) ^ -(v & 1n); }
  i32() { return Number(this.zz()); }
  bin() { const n = Number(this.varint()); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  value(t) {
    switch (t) {
      case 1: return true; case 2: return false;           // booleans live in the type nibble
      case 3: return this.b.readInt8(this.p++);
      case 4: case 5: return this.i32();
      case 6: return Number(this.zz());
      case 7: { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
      case 8: return this.bin();
      case 9: case 10: return this.list();
      case 11: throw new Error('thrift map not supported');
      case 12: return this.struct();
      default: throw new Error('thrift type ' + t);
    }
  }
  list() { const h = this.byte(); let n = h >> 4; const t = h & 0x0f; if (n === 15) n = Number(this.varint());
    const out = []; for (let i = 0; i < n; i++) out.push(t === 1 || t === 2 ? this.byte() === 1 : this.value(t)); return out; }
  struct() {
    const o = {}; let last = 0;
    for (;;) {
      const h = this.byte(); if (h === 0) return o;
      const t = h & 0x0f, d = h >> 4;
      const id = d ? last + d : this.i32();
      last = id;
      o[id] = this.value(t);
    }
  }
}
const str = b => (b == null ? null : Buffer.from(b).toString('utf8'));

// ---------------- snappy (raw block format) ----------------
function snappy(src) {
  let p = 0, len = 0, s = 0, x;
  do { x = src[p++]; len |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
  const out = Buffer.allocUnsafe(len); let o = 0;
  while (p < src.length) {
    const tag = src[p++], kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const k = n - 59; n = 0; for (let i = 0; i < k; i++) n |= src[p++] << (8 * i); }
      n += 1; src.copy(out, o, p, p + n); p += n; o += n; continue;
    }
    let n, off;
    if (kind === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
    else if (kind === 2) { n = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
    else { n = (tag >> 2) + 1; off = src.readUInt32LE(p); p += 4; }
    if (!off || off > o) throw new Error('snappy: bad offset');
    for (let i = 0; i < n; i++) out[o + i] = out[o - off + i];       // overlapping copies are the point
    o += n;
  }
  if (o !== len) throw new Error('snappy: length mismatch');
  return out;
}
function decompress(codec, buf, size) {
  switch (codec) {
    case 0: return buf;
    case 1: return snappy(buf);
    case 2: return zlib.gunzipSync(buf);
    case 4: return zlib.brotliDecompressSync(buf);
    case 6: if (!zlib.zstdDecompressSync) throw new Error('this Node has no zstd'); return zlib.zstdDecompressSync(buf);
    case 7: throw new Error('LZ4_RAW codec not supported');
    default: throw new Error('codec ' + codec + ' not supported');
  }
}

// ---------------- RLE / bit-packed hybrid (levels and dictionary indices) ----------------
function rleHybrid(buf, pos, end, bitWidth, count) {
  const out = new Int32Array(count); let n = 0;
  const bytes = Math.ceil(bitWidth / 8);
  while (n < count && pos < end) {
    let h = 0, s = 0, x; do { x = buf[pos++]; h |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
    if (h & 1) {                                   // bit-packed: (h>>1) groups of 8
      const groups = h >>> 1, total = groups * 8;
      let bitPos = 0;
      for (let i = 0; i < total; i++) {
        let v = 0;
        for (let b = 0; b < bitWidth; b++) { const bit = bitPos + b; if (buf[pos + (bit >> 3)] & (1 << (bit & 7))) v |= 1 << b; }
        bitPos += bitWidth;
        if (n < count) out[n++] = v;
      }
      pos += groups * bitWidth;
    } else {                                       // run: value repeated (h>>1) times
      const run = h >>> 1; let v = 0; for (let i = 0; i < bytes; i++) v |= buf[pos++] << (8 * i);
      for (let i = 0; i < run && n < count; i++) out[n++] = v;
    }
  }
  return out;
}
const bitWidthOf = max => max === 0 ? 0 : 32 - Math.clz32(max);

// ---------------- values ----------------
function plain(type, buf, pos, end, count, typeLen) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    if (type === 6) { const n = buf.readUInt32LE(pos); pos += 4; out[i] = buf.subarray(pos, pos + n); pos += n; }      // BYTE_ARRAY
    else if (type === 1) { out[i] = buf.readInt32LE(pos); pos += 4; }
    else if (type === 2) { const v = buf.readBigInt64LE(pos); out[i] = v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v; pos += 8; }
    else if (type === 4) { out[i] = buf.readFloatLE(pos); pos += 4; }
    else if (type === 5) { out[i] = buf.readDoubleLE(pos); pos += 8; }
    else if (type === 0) { out[i] = !!(buf[pos + (i >> 3)] & (1 << (i & 7))); }
    else if (type === 7) { out[i] = buf.subarray(pos, pos + typeLen); pos += typeLen; }
    else throw new Error('physical type ' + type + ' not supported');
  }
  return out;
}

// ---------------- the reader ----------------
async function open(where) {
  const src = /^https?:\/\//.test(where) ? httpSource(where) : fileSource(where);
  const size = await src.size();
  const tail = await src.read(size - 8, 8);
  if (tail.toString('latin1', 4) !== 'PAR1') throw new Error('not a Parquet file');
  const mlen = tail.readUInt32LE(0);
  const meta = new Thrift(await src.read(size - 8 - mlen, mlen)).struct();
  const schema = meta[2].map(s => ({ type: s[1], typeLen: s[2], repetition: s[3], name: str(s[4]), children: s[5] || 0, converted: s[6] }));
  // top-level fields: walk the schema tree once
  const top = []; { let i = 1; const skip = k => { let n = schema[k].children, j = k + 1; for (let c = 0; c < n; c++) j = skip(j); return j; };
    while (i < schema.length) { top.push(schema[i]); i = skip(i); } }
  const rowGroups = meta[4].map(rg => ({ rows: Number(rg[3]), columns: rg[1].map(cc => { const m = cc[3]; return { path: m[3].map(str), type: m[1], codec: m[4], values: Number(m[5]),
    compressed: Number(m[7]), dataOffset: Number(m[9]), dictOffset: m[11] != null ? Number(m[11]) : null }; }) }));
  return { src, size, rows: Number(meta[3]), schema, fields: top, rowGroups, createdBy: str(meta[6]), close: () => src.close(),
    readColumn: (name, rg) => readColumn(src, top, rowGroups[rg], name) };
}

async function readColumn(src, fields, rg, name) {
  const f = fields.find(x => x.name === name);
  if (!f) throw new Error('no column "' + name + '" — columns: ' + fields.map(x => x.name).join(', '));
  if (f.children) throw new Error('"' + name + '" is nested — only flat columns are read');
  if (f.repetition === 2) throw new Error('"' + name + '" is repeated — only flat columns are read');
  const c = rg.columns.find(x => x.path.length === 1 && x.path[0] === name);
  const start = c.dictOffset != null && c.dictOffset > 0 && c.dictOffset < c.dataOffset ? c.dictOffset : c.dataOffset;
  const chunk = await src.read(start, c.compressed);
  const maxDef = f.repetition === 1 ? 1 : 0;
  const out = []; let dict = null, pos = 0;
  while (out.length < rg.rows && pos < chunk.length) {
    const th = new Thrift(chunk, pos); const ph = th.struct(); pos = th.p;
    const ptype = ph[1], usize = ph[2], csize = ph[3];
    const body = chunk.subarray(pos, pos + csize); pos += csize;
    if (ptype === 2) { const d = ph[7]; dict = plain(c.type, decompress(c.codec, body, usize), 0, usize, d[1], f.typeLen); continue; }
    if (ptype !== 0 && ptype !== 3) continue;                      // index pages etc.
    let n, enc, defs = null, data, dp;
    if (ptype === 0) {
      const h = ph[5]; n = h[1]; enc = h[2];
      data = decompress(c.codec, body, usize); dp = 0;
      if (maxDef) { const l = data.readUInt32LE(0); defs = rleHybrid(data, 4, 4 + l, 1, n); dp = 4 + l; }
    } else {
      const h = ph[8]; n = h[1]; enc = h[4];
      const dl = h[5] || 0, rl = h[6] || 0, compressed = h[7] !== false;
      if (maxDef) defs = rleHybrid(body, rl, rl + dl, 1, n);
      const rest = body.subarray(rl + dl);
      data = compressed ? decompress(c.codec, rest, usize - rl - dl) : rest; dp = 0;
    }
    const present = defs ? defs.reduce((s, v) => s + v, 0) : n;
    let vals;
    if (enc === 0) vals = plain(c.type, data, dp, data.length, present, f.typeLen);
    else if (enc === 2 || enc === 8) {
      if (!dict) throw new Error('dictionary page missing');
      const bw = data[dp]; const ix = rleHybrid(data, dp + 1, data.length, bw, present);
      vals = Array.from(ix, i => dict[i]);
    } else throw new Error('encoding ' + enc + ' not supported (column ' + name + ')');
    let k = 0;
    for (let i = 0; i < n; i++) out.push(defs && !defs[i] ? null : vals[k++]);
  }
  // BYTE_ARRAY holding UTF-8 (converted type UTF8=0, or a logical string) → strings
  return c.type === 6 ? out.map(v => v == null ? null : str(v)) : out;
}

// Rows with only the asked-for columns, one row group at a time.
async function* rows(pq, columns) {
  for (let g = 0; g < pq.rowGroups.length; g++) {
    const cols = {}; for (const c of columns) cols[c] = await pq.readColumn(c, g);
    for (let i = 0; i < pq.rowGroups[g].rows; i++) { const r = {}; for (const c of columns) r[c] = cols[c][i]; yield r; }
  }
}
// what fetching only these columns costs, in bytes
function columnBytes(pq, columns) {
  let n = 0; for (const rg of pq.rowGroups) for (const c of rg.columns) if (columns.includes(c.path[0])) n += c.compressed; return n;
}

module.exports = { open, rows, columnBytes, snappy, rleHybrid, Thrift, _plain: plain };
