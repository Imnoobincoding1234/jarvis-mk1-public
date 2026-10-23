'use strict';
// parquet.js — the pieces, offline: the snappy decoder, the RLE/bit-packed hybrid, the Thrift compact reader,
// and a whole (tiny) file written by hand to the spec: an optional UTF-8 column with a null, PLAIN, data
// page v1, uncompressed, plus a dictionary-encoded column. Live checks against real files (IMDB 25,000 rows
// 12,500/12,500; GSM8K test 1,319; MolmoWeb zstd) were run by hand on 2026-10-01 — they need the network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../parquet');

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log('  ok   ' + w); } else { fail++; console.log('  FAIL ' + w); } };

// snappy: a literal "abcd", then a copy of length 8 from offset 4 (overlapping) → "abcdabcdabcd"
const snap = Buffer.from([12, (4 - 1) << 2, 0x61, 0x62, 0x63, 0x64, ((8 - 4) << 2) | 1, 4]);
ok(P.snappy(snap).toString() === 'abcdabcdabcd', 'snappy: literal + overlapping copy');
// RLE run of 5 ones (header 5<<1=10, value 1), then a bit-packed group of 8 one-bit values 0b10110010
const rle = Buffer.from([10, 1, 3, 0b10110010]);
ok(Array.from(P.rleHybrid(rle, 0, rle.length, 1, 13)).join('') === '11111' + '01001101', 'RLE run then bit-packed group (LSB first)');
// thrift compact: struct {1: i32 7, 2: binary "hi", 4: list<i32> [1,2]}
const th = Buffer.from([0x15, 14, 0x18, 2, 0x68, 0x69, 0x29, 0x25, 2, 4, 0]);
const st = new P.Thrift(th).struct();
ok(st[1] === 7 && Buffer.from(st[2]).toString() === 'hi' && st[4].join() === '1,2', 'thrift compact: zigzag i32, binary, short-delta field ids, list');

// ---- a tiny Parquet file, written to the spec by hand ----
// thrift compact writer, just enough
const W = { out: [] };
const vint = n => { n = BigInt(n); const b = []; do { let x = Number(n & 0x7fn); n >>= 7n; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const zz = n => vint((BigInt(n) << 1n) ^ (BigInt(n) >> 63n));
function struct(fields) {      // [[id, type, value]]
  const b = []; let last = 0;
  for (const [id, t, v] of fields) {
    const d = id - last; b.push(d > 0 && d <= 15 ? (d << 4) | t : t); if (!(d > 0 && d <= 15)) b.push(...zz(id)); last = id;
    if (t === 5 || t === 6) b.push(...zz(v));
    else if (t === 8) { const s = Buffer.from(v); b.push(...vint(s.length), ...s); }
    else if (t === 9) { const [et, items] = v; b.push(items.length < 15 ? (items.length << 4) | et : 0xf0 | et); if (items.length >= 15) b.push(...vint(items.length));
      for (const it of items) { if (et === 12) b.push(...it); else if (et === 5) b.push(...zz(it)); else if (et === 8) { const s = Buffer.from(it); b.push(...vint(s.length), ...s); } } }
    else if (t === 12) b.push(...v);
  }
  b.push(0); return b;
}
const vals = ['héllo', null, 'world'];
// column 1: optional string, PLAIN, def levels RLE (4-byte length prefix)
const present = vals.filter(v => v != null);
const defRle = Buffer.from([0b00000011, 0b101]);   // bit-packed: 1 group of 8, values 1,0,1
const plainBody = Buffer.concat(present.map(s => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); }));
const page1 = Buffer.concat([Buffer.from([defRle.length, 0, 0, 0]), defRle, plainBody]);
const ph1 = Buffer.from(struct([[1, 5, 0], [2, 5, page1.length], [3, 5, page1.length], [5, 12, struct([[1, 5, 3], [2, 5, 0], [3, 5, 3], [4, 5, 3]])]]));
// column 2: required string, dictionary page ["a","b"] + RLE_DICTIONARY indices [1,0,1]
const dictBody = Buffer.concat(['a', 'b'].map(s => Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(s)])));
const dph = Buffer.from(struct([[1, 5, 2], [2, 5, dictBody.length], [3, 5, dictBody.length], [7, 12, struct([[1, 5, 2], [2, 5, 0]])]]));
const idxBody = Buffer.from([1, 0b00000011, 0b101]);   // bit width 1; bit-packed 1,0,1
const ph2 = Buffer.from(struct([[1, 5, 0], [2, 5, idxBody.length], [3, 5, idxBody.length], [5, 12, struct([[1, 5, 3], [2, 5, 8], [3, 5, 3], [4, 5, 3]])]]));
const head = Buffer.from('PAR1');
const c1off = 4, c1 = Buffer.concat([ph1, page1]);
const c2off = c1off + c1.length, c2 = Buffer.concat([dph, dictBody, ph2, idxBody]);
const colMeta = (name, off, len, dictOff) => struct([[1, 5, 6], [2, 9, [5, [0]]], [3, 9, [8, [name]]], [4, 5, 0], [5, 6, 3], [6, 6, len], [7, 6, len], [9, 6, dictOff != null ? off + dph.length + dictBody.length : off]].concat(dictOff != null ? [[11, 6, dictOff]] : []));
const meta = Buffer.from(struct([[1, 5, 1],
  [2, 9, [12, [struct([[4, 8, 'schema'], [5, 5, 2]]), struct([[1, 5, 6], [3, 5, 1], [4, 8, 'text'], [6, 5, 0]]), struct([[1, 5, 6], [3, 5, 0], [4, 8, 'kind'], [6, 5, 0]])]]],
  [3, 6, 3],
  [4, 9, [12, [struct([[1, 9, [12, [struct([[2, 6, c1off], [3, 12, colMeta('text', c1off, c1.length)]]), struct([[2, 6, c2off], [3, 12, colMeta('kind', c2off, c2.length, c2off)]])]]], [2, 6, c1.length + c2.length], [3, 6, 3]])]]]]));
const len = Buffer.alloc(4); len.writeUInt32LE(meta.length);
const file = Buffer.concat([head, c1, c2, meta, len, Buffer.from('PAR1')]);
const tmp = path.join(os.tmpdir(), 'jarvis_test_' + process.pid + '.parquet');
fs.writeFileSync(tmp, file);

(async () => {
  const pq = await P.open(tmp);
  ok(pq.rows === 3 && pq.fields.map(f => f.name).join() === 'text,kind', 'footer: rows and top-level fields');
  const got = []; for await (const r of P.rows(pq, ['text', 'kind'])) got.push(r);
  ok(JSON.stringify(got) === JSON.stringify([{ text: 'héllo', kind: 'b' }, { text: null, kind: 'a' }, { text: 'world', kind: 'b' }]), 'optional PLAIN column with a null; dictionary column — ' + JSON.stringify(got));
  ok(P.columnBytes(pq, ['text']) === c1.length, 'columnBytes = only that column\'s chunk');
  let err = ''; try { await pq.readColumn('nope', 0); } catch (e) { err = e.message; }
  ok(/no column "nope" — columns: text, kind/.test(err), 'unknown column names the real ones');
  pq.close(); fs.unlinkSync(tmp);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(1); });
