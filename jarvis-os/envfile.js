'use strict';
// envfile.js — the ONE place that writes the .env file (2026-10-09, for Settings → Connections).
//
// The .env holds his keys, so this is deliberately small and strict:
//   - a variable is set or removed in place; every other line, comment and blank stays exactly as it was;
//   - the write is atomic (a temp file beside it, then rename) and the file stays owner-only (0600);
//   - names are SHOUTING_SNAKE_CASE, values are one token (no spaces/quotes) — anything else is refused, never "cleaned";
//   - nothing here ever returns, logs or prints a value. `has` says whether one is set; `masked` shows its last
//     four characters at most, for the panel's "connected as …abcd".
// server.js reads the file on every call (envVal), so a change here takes effect on the next message.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;   // machine format: an environment variable name

function lines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (e) { return []; }
}
// Which line holds NAME (ignoring comments and an optional `export `), or -1.
function indexOf(ls, name) {
  for (let i = 0; i < ls.length; i++) {
    let l = ls[i].trim();
    if (!l || l.startsWith('#')) continue;
    if (l.startsWith('export ')) l = l.slice(7);
    const eq = l.indexOf('=');
    if (eq > 0 && l.slice(0, eq).trim() === name) return i;
  }
  return -1;
}
function valueAt(line) {
  let l = line.trim();
  if (l.startsWith('export ')) l = l.slice(7);
  let v = l.slice(l.indexOf('=') + 1).trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
  return v;
}
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
// → { ok } | { ok:false, error }
function set(file, name, value) {
  if (!NAME_RE.test(String(name || ''))) return { ok: false, error: 'bad variable name' };
  const v = String(value == null ? '' : value);
  // Keys and tokens are single tokens. A space, quote, backslash or # would need quoting that server.js's reader
  // does not undo, so such a value is refused rather than stored altered.
  if (!v || !/^[^\s"'#\\]+$/.test(v) || v.length > 4096) return { ok: false, error: 'the value must be one token with no spaces or quotes' };
  const ls = lines(file);
  const at = indexOf(ls, name);
  const line = name + '=' + v;
  if (at >= 0) ls[at] = line;
  else {
    while (ls.length && ls[ls.length - 1] === '') ls.pop();
    ls.push(line, '');
  }
  writeAtomic(file, ls.join('\n'));
  return { ok: true };
}
function unset(file, name) {
  if (!NAME_RE.test(String(name || ''))) return { ok: false, error: 'bad variable name' };
  const ls = lines(file);
  const at = indexOf(ls, name);
  if (at < 0) return { ok: true, removed: false };
  ls.splice(at, 1);
  writeAtomic(file, ls.join('\n'));
  return { ok: true, removed: true };
}
function has(file, name) {
  const ls = lines(file);
  const at = indexOf(ls, name);
  return at >= 0 && valueAt(ls[at]).length > 0;
}
// "…abcd" (last four), or '' when not set. Short values show nothing at all.
function masked(file, name) {
  const ls = lines(file);
  const at = indexOf(ls, name);
  if (at < 0) return '';
  const v = valueAt(ls[at]);
  return v.length >= 12 ? '…' + v.slice(-4) : (v ? '(set)' : '');
}

module.exports = { set, unset, has, masked, NAME_RE };
