// Mind2Web's files are one JSON array each, ~600 MB — over V8's string limit, so they cannot be read whole.
// This yields the array's elements one at a time from a byte stream (a file, or `unzip -p` for the test set),
// tracking strings and escapes so braces inside text never confuse it. 2026-10-02, for v4.
const fs = require('fs');
const { spawn } = require('child_process');

async function* elements(stream) {
  let depth = 0, inStr = false, esc = false, buf = [], start = -1;
  const dec = new (require('string_decoder').StringDecoder)('utf8');
  for await (const chunk of stream) {
    const s = dec.write(chunk);
    let from = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
      if (c === 34) { inStr = true; continue; }
      if (c === 123 || c === 91) { if (depth === 1 && c === 123) { start = i; from = i; buf = []; } depth++; continue; }
      if (c === 125 || c === 93) {
        depth--;
        if (depth === 1 && c === 125 && start !== -1) { buf.push(s.slice(from, i + 1)); yield JSON.parse(buf.join('')); buf = []; start = -1; from = i + 1; }
      }
    }
    if (start !== -1) { buf.push(s.slice(from)); }
  }
}
const fromFile = p => elements(fs.createReadStream(p, { highWaterMark: 1 << 20 }));
const fromZip = (zip, member, password) => {
  const p = spawn('unzip', ['-p'].concat(password ? ['-P', password] : [], [zip, member]), { stdio: ['ignore', 'pipe', 'ignore'] });
  return elements(p.stdout);
};
module.exports = { elements, fromFile, fromZip };
