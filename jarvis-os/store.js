'use strict';
// ---------------------------------------------------------------------------
// store.js — the two things every state file in this project got wrong.
//
// There are 25 JSON files under state/ and, before this, every one of them was
// loaded with the same three lines:
//
//     try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
//     catch (e) { data = <empty>; }
//
// and saved with a bare writeFileSync. That pairing destroys data, and it did:
// state/learned.json.bak-corrupt-subscribe-* is what one of these looks like
// afterwards. A write interrupted by a crash, a power cut, or an OOM kill leaves
// a truncated file; the next load parses it, fails, and returns EMPTY; the next
// save writes that emptiness over the remains. Every taught procedure, every
// episode, gone, with nothing in the log to say so.
//
// Two fixes, and neither is clever:
//
//   WRITE beside the target and rename over it. rename(2) inside one directory
//   is atomic, so a reader sees the whole old file or the whole new one, never
//   the half-written middle.
//
//   A FILE THAT WILL NOT PARSE IS DAMAGE, NOT EMPTINESS. An empty file is a
//   first run and reads as empty. A file with bytes in it that will not parse is
//   moved aside under a name that says what it was, so the data is still there
//   to recover, and the loss is ANNOUNCED rather than inferred months later.
//
// MIGRATIONS, because a schema change is the same data loss arriving politely.
// Versions live in ONE sidecar, state/.schema.json, rather than as a `_v` key
// inside each file — several of these stores are top-level ARRAYS (learned,
// episodes, timemachine) and there is nowhere to put a key without changing the
// shape every reader expects. A central manifest touches no existing file, so
// adopting this costs nothing on first run: an unversioned file is treated as
// version 0 and walked forward.
//
// Zero dependencies, per this project's standing rule.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let deps = { jlog: () => {}, stateDir: null };
function init(d) { deps = Object.assign(deps, d || {}); }

const DIR = () => deps.stateDir || path.join(__dirname, 'state');
const SCHEMA_FILE = () => path.join(DIR(), '.schema.json');

// ---- the migration registry ----------------------------------------------
// MIGRATIONS[name] is an ordered list. Index i takes the data from version i to
// version i+1, so the list length IS the current schema version. A file with no
// entry here is unversioned and never migrated — which is the right default,
// because most of these stores are append-only logs whose shape has not moved.
//
// A migration MUST be a pure function of the data and MUST tolerate being handed
// something it does not recognise: it runs against files written by every past
// version of this program, including ones written by a half-finished feature.
// Return the input unchanged rather than throwing when the shape is unexpected.
const MIGRATIONS = Object.create(null);
function register(name, fns) { MIGRATIONS[name] = fns || []; }
const latestVersion = name => (MIGRATIONS[name] || []).length;

function readSchema() {
  try { return JSON.parse(fs.readFileSync(SCHEMA_FILE(), 'utf8')) || {}; }
  catch (e) { return {}; }
}
function writeSchema(obj) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    const tmp = SCHEMA_FILE() + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, SCHEMA_FILE());
  } catch (e) { deps.jlog('Store › could not record schema versions: ' + e.message); }
}
function versionOf(name) {
  const v = readSchema()[name];
  return typeof v === 'number' && v >= 0 ? v : 0;
}
function setVersion(name, v) {
  const s = readSchema();
  s[name] = v;
  writeSchema(s);
}

// A file that will not parse is preserved under a name that says so, and the
// loss is logged. Returns true if something was set aside.
function quarantine(file, raw) {
  if (!String(raw).trim()) return false;              // empty file is a first run, not damage
  const aside = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(file, aside);
    deps.jlog('Store › ' + path.basename(file) + ' WAS DAMAGED and could not be read. Kept as ' +
              path.basename(aside) + ' — the data is in that file, not lost. Starting from empty.');
    return true;
  } catch (e) {
    deps.jlog('Store › ' + path.basename(file) + ' is damaged and could not be set aside: ' + e.message);
    return false;
  }
}

// Read state/<name>, migrate it forward, hand it back. `fallback` is what a
// first run gets — and what a quarantined file gets, because the alternative is
// throwing on boot over a file the user has never heard of.
function read(name, fallback) {
  const file = path.join(DIR(), name);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return fallback; }                      // no file yet — first run
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { quarantine(file, raw); return fallback; }
  if (data === null || data === undefined) return fallback;
  return migrate(name, data, file);
}

// Walk the data from whatever version it is at to the current one. A migration
// that throws stops the walk and leaves the file at the last good version —
// better a store one version behind than a store mangled halfway.
function migrate(name, data, file) {
  const fns = MIGRATIONS[name];
  if (!fns || !fns.length) return data;
  let v = versionOf(name);
  if (v >= fns.length) return data;
  let out = data;
  const from = v;
  for (; v < fns.length; v++) {
    try { out = fns[v](out); }
    catch (e) {
      deps.jlog('Store › migration ' + name + ' v' + v + '→v' + (v + 1) + ' failed: ' + e.message +
                ' — left at v' + v);
      break;
    }
  }
  if (v > from) {
    // The migrated data is written back BEFORE the version is recorded. The other
    // order loses the data if the process dies between the two: the manifest would
    // claim a version the file on disk had never reached.
    if (file) writeRaw(file, out);
    setVersion(name, v);
    deps.jlog('Store › ' + name + ' migrated v' + from + ' → v' + v);
  }
  return out;
}

function writeRaw(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);                            // atomic within one directory
}

// Write state/<name>. Records the current schema version at the same time, so a
// file written by this build is never later re-migrated from zero.
function write(name, data) {
  const file = path.join(DIR(), name);
  try {
    writeRaw(file, data);
    const want = latestVersion(name);
    if (want && versionOf(name) !== want) setVersion(name, want);
    return true;
  } catch (e) {
    deps.jlog('Store › could not save ' + name + ': ' + e.message);
    return false;
  }
}

module.exports = { init, read, write, register, versionOf, setVersion, latestVersion, MIGRATIONS };
