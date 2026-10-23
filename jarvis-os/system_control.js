'use strict';
/* JARVIS MK-1 — system_control: the offline agent's hands on macOS.
   Zero-dependency. Every tool runs a fixed program with values passed as argv (no shell string),
   validates paths against a hard protected-path block, gates destructive ops behind confirmation,
   and appends a structured line to logs/actions.log. A dry-run flag makes tools report-only. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const HOME = os.homedir();
const ROOT = path.join(HOME, 'JARVIS MK-1');
const APPS_DIR = path.join(ROOT, 'apps');
const ACTIONS_LOG = path.join(ROOT, 'logs', 'actions.log');
for (const d of [APPS_DIR, path.dirname(ACTIONS_LOG)]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

const dryRun = () => process.env.JARVIS_DRYRUN === '1';

// ---------------- audit log ----------------
function logAction(tool, args, result) {
  try {
    // Readable + tail-able by the ⌘L console (leading [ISO]); still carries tool, args, result.
    const a = Object.entries(args || {}).map(([k, v]) => k + '=' + String(v)).join(' ').slice(0, 160);
    fs.appendFileSync(ACTIONS_LOG, '[' + new Date().toISOString() + '] ' + tool + (a ? ' ' + a : '') + ' → ' + String(result).slice(0, 120) + '\n');
  } catch (e) {}
}

// ---------------- path resolution ----------------
const KNOWN = {
  desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', docs: 'Documents',
  pictures: 'Pictures', photos: 'Pictures', movies: 'Movies', music: 'Music',
  applications: 'Applications', apps: 'Applications', home: '', desktop_folder: 'Desktop',
};
// Turn "test-lab on my desktop" / "~/Desktop/x" / "downloads/foo" into an absolute path under HOME.
function resolvePath(input) {
  let s = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return HOME;
  // A LEADING location phrase ("on my desktop/report.pdf") — the shape the LLM classifier tends to
  // emit. Without this it became a literal folder called "on my desktop", which is how the stray
  // ~/on my desktop/New Folder directories got created.
  s = s.replace(/^(?:on|in|from|at|inside|under|to)\s+(?:my\s+|the\s+)?(desktop|downloads|documents|docs|pictures|photos|movies|music|home)\b[\/ ]*/i,
    (m, k) => (KNOWN[k.toLowerCase()] ? KNOWN[k.toLowerCase()] + '/' : ''));
  // "<name> on (my) desktop|downloads|documents..."
  // "from" was missing here, so "delete report.pdf from my desktop" resolved to the nonsense path
  // ~/report.pdf from my desktop and failed — safely, but for the wrong reason.
  const on = s.match(/^(.*?)\s+(?:on|in|to|inside|under|from|within)\s+(?:my\s+|the\s+)?(desktop|downloads|documents|docs|pictures|photos|movies|music|home)\b/i);
  if (on) { const base = KNOWN[on[2].toLowerCase()]; s = path.join(base, on[1].trim()); }
  // leading "my desktop/" etc.
  s = s.replace(/^(?:my\s+|the\s+)?(desktop|downloads|documents|docs|pictures|photos|movies|music)\b[\/ ]?/i, (m, k) => KNOWN[k.toLowerCase()] + '/');
  s = s.replace(/^~(?=\/|$)/, HOME);
  // A TILDE THAT IS NOT A HOME REFERENCE IS A MANGLED PATH, NOT A FOLDER NAME.
  //
  // The rule above only expands "~" when a slash or the end follows, which is correct — but it left
  // everything else starting with a tilde to be treated as an ordinary relative name. Measured in a
  // live eval: the 3B degraded across a long run and emitted "~ es/desktop/jarvis_eval/c.txt", which
  // resolved to /Users/atharv/~ es/desktop/... and cheerfully created a directory literally called
  // "~ es" in his home folder. The write succeeded, so nothing downstream had any reason to complain.
  //
  // Repaired rather than refused: "~ es/desktop/x" plainly means "~/Desktop/x" with characters lost,
  // and the rest of this function already knows how to resolve that. If it cannot be repaired into a
  // known folder the leading junk is simply dropped, which lands it in HOME — visible and harmless —
  // instead of inside a directory whose name is a typo.
  const tildeJunk = s.match(/^~\s*\S*?[\/ ]+(desktop|downloads|documents|docs|pictures|photos|movies|music)\b(.*)$/i);
  if (tildeJunk) {
    s = path.join(HOME, KNOWN[tildeJunk[1].toLowerCase()] || '', (tildeJunk[2] || '').replace(/^[\/ ]+/, ''));
  } else if (/^~[^\/]/.test(s)) {
    s = path.join(HOME, s.replace(/^~\s*\S*[\/ ]+/, ''));
  }
  // "/Desktop/x" — a leading slash on a HOME folder. The model emits this shape often, and
  // path.isAbsolute() duly accepted it, producing mkdir '/Desktop/final_check' at the volume root
  // (ENOENT, and it would be the wrong place even if it worked). Only the known HOME folders are
  // remapped, so /tmp, /Volumes and a real absolute path are untouched.
  s = s.replace(/^\/(Desktop|Downloads|Documents|Pictures|Movies|Music)(?=\/|$)/i,
    (m, k) => path.join(HOME, k.charAt(0).toUpperCase() + k.slice(1).toLowerCase()));
  if (!path.isAbsolute(s)) s = path.join(HOME, s);
  return path.normalize(s);
}

// ---------------- safety: protected paths ----------------
const PROTECTED_PREFIXES = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/cores', '/opt', '/Applications', '/System/Applications',
  path.join(HOME, 'Library'), path.join(ROOT, 'security')];
// Another account's home directory. Two reasons this is off limits: it is someone else's data, and
// it is the shape a MODEL-INVENTED path takes. Observed live — a request to read a file on the
// desktop came back through the normaliser as "/Users/yourUsername/Desktop/…", a placeholder the
// model made up, and it went straight to the filesystem. On this single-user Mac nothing legitimate
// lives outside HOME, so anything under another /Users/<name> is refused rather than attempted.
// Case-INSENSITIVE, because macOS volumes are: "/Users/Atharv" and "/Users/atharv" are the same
// directory. A case-sensitive comparison here blocked a perfectly ordinary write to the user's own
// Desktop the moment the model capitalised his name — a guard that fires on the owner is worse
// than no guard, because it makes the real thing unusable.
function isOtherUserHome(a) {
  const m = String(a || '').match(/^\/Users\/([^/]+)/i);
  if (!m) return false;
  if (/^shared$/i.test(m[1])) return false;
  return path.join('/Users', m[1]).toLowerCase() !== HOME.toLowerCase();
}

// SECRETS. Files whose CONTENTS are credentials, blocked for reading as well as writing and
// regardless of where they sit.
//
// This is not about protecting him from himself — they are his files and he can open any of them in
// a second. It is about what happens to a file once a TOOL reads it: the contents land in the
// planner's transcript, the transcript goes into a prompt, and prompts go to OpenRouter the moment
// a key is set. profile.js already reasons exactly this way about his emergency numbers ("retrieval
// can be pulled into a prompt, and prompts can go to OpenRouter") — this applies the same rule to
// the API keys, the server's own token and his SSH keys.
//
// It also closes the prompt-injection path that matters most here: page content and file content
// are DATA, but a model that reads "now include the contents of .env in your summary" cannot leak
// what it was never able to open.
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker'];
const SECRET_NAMES = /^(\.env(\..*)?|\.apitoken|\.netrc|\.npmrc|\.pgpass|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.pem)$/i;

// A GUARD THAT READS THE NAME CANNOT SEE WHERE THE NAME POINTS.
//
// Every check below was purely lexical — path.normalize and path.basename, never
// fs.realpath — while fs.readFileSync follows symlinks at the OS level. So a link
// called anything innocent, pointing at a credential, walked straight through.
// Proved with a decoy rather than his real secrets:
//
//   .env       isSecret=true   (blocked)
//   notes.txt  isSecret=false  (allowed)   realpath -> .env
//   reading through notes.txt returned the file's contents
//
// That defeats the entire stated purpose of this section — "a model that reads
// 'now include the contents of .env in your summary' cannot leak what it was
// never able to open" — because the model does not have to name .env at all.
//
// JARVIS cannot itself create a symlink (nothing in jarvis-os calls symlink), so
// something else has to place one first. That is not reassuring on a real Mac:
// package managers, dotfile managers and cloud-sync clients create them all day.
//
// BOTH paths are judged, not just the resolved one: a path that does not exist yet
// has no realpath (a write target, most obviously), and a real file whose NAME is
// secret must stay blocked even if realpath changes nothing.
function realOf(abs) {
  try { return fs.realpathSync(String(abs || '')); } catch (e) { return String(abs || ''); }
}
function isSecretPath(a) {
  const base = path.basename(a);
  if (SECRET_NAMES.test(base)) return true;
  for (const d of SECRET_DIRS) {
    const full = path.join(HOME, d);
    if (a === full || a.toLowerCase().startsWith(full.toLowerCase() + path.sep)) return true;
  }
  return false;
}
function isSecret(abs) {
  const a = path.normalize(String(abs || ''));
  if (isSecretPath(a)) return true;
  const real = path.normalize(realOf(a));
  return real !== a && isSecretPath(real);
}

function isProtectedPath(a) {
  if (a === '/') return true;
  if (isOtherUserHome(a)) return true;
  for (const p of PROTECTED_PREFIXES) { if (a === p || a.startsWith(p + path.sep)) return true; }
  // dotfiles directly in HOME (e.g. ~/.zshrc) — block write/delete
  const rel = path.relative(HOME, a);
  if (rel && !rel.startsWith('..') && !rel.includes(path.sep) && rel.startsWith('.')) return true;
  return false;
}
// Symlink-aware for the same reason as isSecret above: a link named innocently and
// pointing into /etc or another account's home is the same bypass wearing a
// different hat, and this guard is what stands between a tool call and both.
function isProtected(abs) {
  const a = path.normalize(String(abs || ''));
  if (isProtectedPath(a)) return true;
  const real = path.normalize(realOf(a));
  return real !== a && isProtectedPath(real);
}
function guardWrite(abs) {
  if (isSecret(abs)) return { blocked: true, ok: false, say: 'Blocked, sir. ' + short(abs) + ' holds credentials — I won’t write to it. Edit that one yourself.' };
  if (isProtected(abs)) return { blocked: true, say: 'Blocked, sir. ' + abs + ' is a protected path — I won’t touch it.' };
  return null;
}

// ---------------- helpers ----------------
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = (say) => ({ ok: false, say });
const confirm = (tool, args, say) => ({ ok: false, needsConfirm: true, confirm: { tool, args }, say });
const sh = (cmd, args, timeout) => new Promise(r => { try { execFile(cmd, args, { timeout: timeout || 8000, maxBuffer: 8 << 20 }, (e, out) => r({ err: e, out: String(out || '') })); } catch (e) { r({ err: e, out: '' }); } });
const short = p => p.replace(HOME, '~');

// ---------------- file & folder tools ----------------
async function create_folder(a) {
  const abs = resolvePath(a.path); const g = guardWrite(abs); if (g) return g;
  if (dryRun()) return ok('[dry-run] would create folder ' + short(abs));
  try { fs.mkdirSync(abs, { recursive: true }); logAction('create_folder', { path: abs }, 'ok'); return ok('Folder ready: ' + short(abs) + '.', { entity: abs }); }
  catch (e) { return fail('Couldn’t create that folder, sir: ' + e.message); }
}
async function create_file(a, ctx) {
  const abs = resolvePath(a.path); const g = guardWrite(abs); if (g) return g;
  if (fs.existsSync(abs) && !(ctx && ctx.confirmed)) return confirm('create_file', a, 'That file exists — overwrite ' + short(abs) + ', sir?');
  if (dryRun()) return ok('[dry-run] would write ' + short(abs));
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, a.content || ''); logAction('create_file', { path: abs }, 'ok'); return ok('Created ' + short(abs) + '.', { entity: abs }); }
  catch (e) { return fail('Couldn’t write that file, sir: ' + e.message); }
}
async function append_file(a) {
  const abs = resolvePath(a.path); const g = guardWrite(abs); if (g) return g;
  if (dryRun()) return ok('[dry-run] would append to ' + short(abs));
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.appendFileSync(abs, a.content || ''); logAction('append', { path: abs }, 'ok'); return ok('Appended to ' + short(abs) + '.'); }
  catch (e) { return fail('Couldn’t append, sir: ' + e.message); }
}
// Reads are guarded too, not just writes. guardWrite covers create/delete; without this a request
// to READ another account's file (or a model-invented /Users/<placeholder>/… path) was simply
// attempted, and would have succeeded on any path that happened to exist.
//
// THE READ GUARD NOW MATCHES THE WRITE GUARD. It used to check only isOtherUserHome, so every path
// the write guard refused to touch could still be read out in full. Measured against the running
// server: `read` returned ~/JARVIS MK-1/.env (his API keys), state/.apitoken (the token gating this
// whole API) and ~/.zsh_history — and ~/Library was equally open, which is where Messages, Safari
// history and the Keychains live. A guard that stops the agent WRITING to a place it can freely
// read is not a guard, it is a rule about the wrong verb.
function guardRead(abs) {
  if (isSecret(abs)) {
    return { blocked: true, ok: false,
      say: 'Blocked, sir. ' + short(abs) + ' holds credentials — I won\u2019t read that back into a prompt. Open it yourself if you need it.' };
  }
  if (isOtherUserHome(abs)) return { blocked: true, ok: false, say: 'Blocked, sir. ' + abs + ' is not in your home folder — I won\u2019t read another account\u2019s files.' };
  if (isProtected(abs)) return { blocked: true, ok: false, say: 'Blocked, sir. ' + abs + ' is a protected path — I won\u2019t read it.' };
  return null;
}
async function read_file(a) {
  const abs = resolvePath(a.path);
  const gr = guardRead(abs); if (gr) return gr;
  try { const t = fs.readFileSync(abs, 'utf8'); return ok(short(abs) + ':\n' + t.slice(0, 4000), { data: t.slice(0, 8000) }); }
  catch (e) { return fail('Couldn’t read that, sir: ' + e.message); }
}
// THE CLIPBOARD IS AN INPUT HE ALREADY HAS.
//
// Everything JARVIS can be handed today has to be typed, spoken, or already on disk — so the single
// most common thing on a Mac at any moment, the thing just copied, was unreachable. "summarise what
// I copied", "turn this into a reminder", "put that in a file" all needed the text pasted in by hand,
// which is the one step a personal assistant should remove.
//
// Read-only and read-once: it never WRITES the clipboard, so nothing he has copied can be clobbered
// by a misunderstanding, and the content is treated as untrusted page-style data rather than as
// instructions — the same rule browser.js applies to page text, and for the same reason: whatever is
// on the clipboard may have come from a web page.
async function read_clipboard() {
  try {
    const t = execFileSync('/usr/bin/pbpaste', [], { timeout: 4000, maxBuffer: 1 << 22 }).toString();
    if (!t.trim()) return ok('The clipboard is empty, sir.', { data: { text: '', chars: 0 } });
    const clipped = t.slice(0, 8000);
    logAction('read_clipboard', { chars: t.length }, 'ok');       // length only — never the content
    return ok('Clipboard (' + t.length + ' characters):\n' + clipped.slice(0, 4000),
      { data: { text: clipped, chars: t.length } });
  } catch (e) { return fail('Couldn’t read the clipboard, sir: ' + e.message); }
}

async function list_dir(a) {
  const abs = resolvePath(a.path || '~');
  const gr = guardRead(abs); if (gr) return gr;
  try {
    const items = fs.readdirSync(abs).filter(n => n !== '.DS_Store').slice(0, 200).map(n => {
      let dir = false; try { dir = fs.statSync(path.join(abs, n)).isDirectory(); } catch (e) {}
      return (dir ? '📁 ' : '📄 ') + n;
    });
    return ok(short(abs) + ' (' + items.length + '):\n' + items.join('\n'), { data: items });
  } catch (e) { return fail('Couldn’t list that, sir: ' + e.message); }
}
async function search_files(a) {
  const q = String(a.name || a.query || '').trim();
  if (!q) return fail('Search for what, sir?');
  const root = resolvePath(a.root || '~');
  const r = await sh('/usr/bin/find', [root, '-iname', q.includes('*') ? q : '*' + q + '*', '-not', '-path', '*/.*', '-maxdepth', '6'], 12000);
  const hits = r.out.split('\n').filter(Boolean).slice(0, 40).map(short);
  logAction('search', { q, root }, hits.length + ' hits');
  return ok(hits.length ? 'Found ' + hits.length + ', sir:\n' + hits.join('\n') : 'Nothing matching "' + q + '", sir.', { data: hits });
}
async function delete_path(a, ctx) {
  const abs = resolvePath(a.path); const g = guardWrite(abs); if (g) return g;
  if (!fs.existsSync(abs)) return fail('Nothing at ' + short(abs) + ', sir.');
  if (!(ctx && ctx.confirmed)) {
    let n = 1; try { if (fs.statSync(abs).isDirectory()) n = fs.readdirSync(abs).length; } catch (e) {}
    return confirm('delete', a, 'This will move ' + short(abs) + (n > 1 ? ' (' + n + ' items)' : '') + ' to the Trash — confirm, sir?');
  }
  if (dryRun()) return ok('[dry-run] would trash ' + short(abs));
  // Recoverable trash — NEVER rm -rf. Primary: macOS NSFileManager.trashItemAtURL via JXA — the
  // only method that correctly handles ~/.Trash from a non-Finder process (a plain rename into
  // ~/.Trash returns -11). Needs the JARVIS OS node to have Full Disk Access.
  const jxa = 'ObjC.import("Foundation"); var e=Ref(); var ok=$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(' + JSON.stringify(abs) + '), null, e); ok ? "OK" : "ERR:"+e[0].localizedDescription';
  const r = await sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], 12000);
  if (/^OK/.test(String(r.out).trim()) && !fs.existsSync(abs)) { logAction('delete', { path: abs }, 'trashed'); return ok('Trashed ' + short(abs) + ', sir.'); }
  // Fallback: plain rename into ~/.Trash (works on volumes where the above is unavailable).
  try {
    let dest = path.join(HOME, '.Trash', path.basename(abs)); let k = 1;
    while (fs.existsSync(dest)) dest = path.join(HOME, '.Trash', path.basename(abs).replace(/(\.[^.]+)?$/, ' ' + (k++) + '$1'));
    fs.renameSync(abs, dest); logAction('delete', { path: abs }, 'trashed (rename)');
    return ok('Trashed ' + short(abs) + ', sir.');
  } catch (e) {
    logAction('delete', { path: abs }, 'FAIL ' + (String(r.out).trim() || e.message));
    return fail('Couldn’t trash ' + short(abs) + ', sir — grant the JARVIS OS node Full Disk Access, then retry.');
  }
}
async function rename_path(a) {
  const abs = resolvePath(a.path); const g = guardWrite(abs); if (g) return g;
  const dest = path.join(path.dirname(abs), String(a.new_name || '').replace(/[\/]/g, '_'));
  const g2 = guardWrite(dest); if (g2) return g2;
  if (dryRun()) return ok('[dry-run] would rename to ' + short(dest));
  try { fs.renameSync(abs, dest); logAction('rename', { from: abs, to: dest }, 'ok'); return ok('Renamed to ' + path.basename(dest) + ', sir.'); }
  catch (e) { return fail('Rename failed, sir: ' + e.message); }
}
async function move_path(a, ctx) {
  const src = resolvePath(a.src || a.path); const dest = resolvePath(a.dest);
  const g = guardWrite(src) || guardWrite(dest); if (g) return g;
  const finalDest = fs.existsSync(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, path.basename(src)) : dest;
  if (fs.existsSync(finalDest) && !(ctx && ctx.confirmed)) return confirm('move', a, 'That overwrites ' + short(finalDest) + ' — confirm, sir?');
  if (dryRun()) return ok('[dry-run] would move to ' + short(finalDest));
  try { fs.mkdirSync(path.dirname(finalDest), { recursive: true }); fs.renameSync(src, finalDest); logAction('move', { src, dest: finalDest }, 'ok'); return ok('Moved to ' + short(finalDest) + ', sir.'); }
  catch (e) { return fail('Move failed, sir: ' + e.message); }
}
async function copy_path(a) {
  const src = resolvePath(a.src || a.path); const dest = resolvePath(a.dest);
  // The SOURCE is guarded as a read, because that is what a copy does to it. Guarding only the
  // destination left the read guard trivially launderable: copy ~/JARVIS MK-1/.env to the Desktop,
  // then read the copy, and every credential the read guard exists to protect is in the transcript
  // anyway. Found by asking the running system to do exactly that.
  const g = guardRead(src) || guardWrite(dest); if (g) return g;
  const finalDest = fs.existsSync(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, path.basename(src)) : dest;
  if (dryRun()) return ok('[dry-run] would copy to ' + short(finalDest));
  try { fs.cpSync(src, finalDest, { recursive: true }); logAction('copy', { src, dest: finalDest }, 'ok'); return ok('Copied to ' + short(finalDest) + ', sir.'); }
  catch (e) { return fail('Copy failed, sir: ' + e.message); }
}

// ---------------- app control ----------------
let _appCache = { at: 0, list: [] };
function appIndex() {
  if (Date.now() - _appCache.at < 60000 && _appCache.list.length) return _appCache.list;
  const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(HOME, 'Applications')];
  const set = new Set();
  for (const d of dirs) { try { for (const n of fs.readdirSync(d)) if (n.endsWith('.app')) set.add(n.replace(/\.app$/, '')); } catch (e) {} }
  _appCache = { at: Date.now(), list: [...set] };
  return _appCache.list;
}
// "music" and "browser" are the two aliases that depend on the USER, not on macOS. Hardcoding
// music → Apple Music is why "play some music" opened Music.app when his stated player is Spotify,
// and browser → Safari when his browser is Brave. Overridable via setPreferredApps(), which
// server.js populates from profile.json; the hardcoded values remain the fallback.
let PREF = { music: 'Music', browser: 'Safari' };
function setPreferredApps(p) {
  if (p && p.music) PREF.music = String(p.music);
  if (p && p.browser) PREF.browser = String(p.browser);
}
const ALIAS_BASE = { chrome: 'Google Chrome', code: 'Visual Studio Code', vscode: 'Visual Studio Code', vs: 'Visual Studio Code', calc: 'Calculator', ff: 'Firefox', settings: 'System Settings', prefs: 'System Settings', terminal: 'Terminal', finder: 'Finder' };
const aliasFor = q => (q === 'music' || q === 'browser') ? PREF[q] : ALIAS_BASE[q];
// Rank apps by similarity to the query. Returns { name, score }.
//
// NO MATCH MUST LOOK LIKE NO MATCH. `best` started as null and was replaced on `score > best.score`,
// so when NOTHING scored above zero the winner was whichever app the index happened to list first.
// Measured: "github", "spotify" and "xyzzyplugh" all returned **Antigravity, score 0** — and the
// callers below then acted on it. open_app said "did you mean Antigravity, sir?" about GitHub, which
// reads as a near miss and is nothing of the kind; switch_to and hide_app did not look at the score
// at all and would have run `open -a Antigravity` and reported success.
//
// The token fallback was also matching SUBSTRINGS anywhere in the name, which is how "GitHub for
// Mac" scored against "Freeform" — both contain the letters "for". Query words now have to match a
// WHOLE WORD of the app name (or its start), and filler that belongs to how a person names an app
// rather than to the app itself is dropped first. That also fixes "the app store", which used to
// score 0.4 and fall UNDER open_app's own 0.5 gate.
const APP_FILLER = new Set(['the', 'a', 'an', 'app', 'apps', 'application', 'for', 'mac', 'macos',
                            'os', 'on', 'my', 'please', 'open']);
function fuzzyApp(query) {
  const q = String(query || '').toLowerCase().trim();
  const al = aliasFor(q); if (al) return { name: al, score: 1 };
  const apps = appIndex();
  const qt = q.split(/\s+/).filter(t => t.length > 1 && !APP_FILLER.has(t));
  let best = null;
  for (const app of apps) {
    const a = app.toLowerCase();
    let score = 0;
    if (a === q) score = 1;
    else if (a.startsWith(q)) score = 0.9;
    else if (a.includes(q)) score = 0.75;
    else if (qt.length) {
      const words = a.split(/[^a-z0-9]+/).filter(Boolean);
      // INITIALS ARE A WORD TOO — shape only: a query word that spells the first letters of two or more
      // consecutive words of the name. "launch vs code" (casual dev run 2026-09-29) scored Visual Studio Code
      // 1 of 2 and Codex 1 of 2 ("codex" starts with "code"), and asked "did you mean Codex?" with VS Code
      // installed. "vs" is v-isual s-tudio.
      const spells = t => t.length >= 2 && words.some((w, i) => i + t.length <= words.length &&
        words.slice(i, i + t.length).every((x, k) => x[0] === t[k]));
      const hit = qt.filter(t => words.some(w => w === t || w.startsWith(t)) || spells(t)).length;
      score = (hit / qt.length) * 0.6;
    }
    if (!best || score > best.score) best = { name: app, score };
  }
  // Nothing resembled it. Hand back the QUERY, so a caller cannot mistake "I have no idea" for a
  // suggestion — and so a score of 0 can never name a real app it might then go and open.
  if (!best || best.score <= 0) return { name: query, score: 0 };
  return best;
}
async function open_app(a) {
  const m = fuzzyApp(a.name || a.target);
  // A near miss and a total miss are different answers, and saying the first when you mean the
  // second is how "open GitHub" became "did you mean Antigravity, sir?".
  if (m.score < 0.5) {
    const asked = String(a.name || a.target || '').trim();
    return m.score > 0
      ? fail('Not sure which app — did you mean ' + m.name + ', sir? Say the full name.')
      : fail('There is no app called “' + asked + '” on this Mac, sir. If it is a website, say so and ' +
             'I will open it in the browser.');
  }
  if (dryRun()) return ok('[dry-run] would open ' + m.name);
  const r = await sh('/usr/bin/open', ['-a', m.name]);
  if (r.err) return fail('Couldn’t open ' + m.name + ', sir.');
  logAction('open_app', { name: m.name }, 'ok');
  return ok('Booting ' + m.name + ', sir.', { entity: m.name });
}
async function close_app(a, ctx) {
  const m = fuzzyApp(a.name || a.target);
  const name = m.score >= 0.5 ? m.name : (a.name || a.target);
  // NO APP BY THAT NAME, NO QUIT CARD (2026-10-17, the round-8 gate): a name no installed app answers to was still put to him as
  // "Quit lmaooo, sir? Please confirm." ("lmaooo stop", "aankhen band ho rahi hain", "every app", "everything except brave").
  // open, switch_to and hide already refuse below 0.5; close now does too — unless something by that name IS running (an app
  // outside the folders appIndex reads), in which case it is still offered. (The check failing counts as not running.) A name
  // the reader's registry recognised (`known`: an app, a browser, a site with a Mac app — "close spotify") keeps its card as before. The same registry, the same bar; no word of his tested.
  if (m.score < 0.5 && !a.known && (await appRunning(name)) !== true) {
    return fail('There is no app called “' + String(name || '').trim() + '” on this Mac, sir.');
  }
  if (a.force) {
    if (!(ctx && ctx.confirmed)) return confirm('close_app', a, 'Force-quit ' + name + ' (unsaved work may be lost) — confirm, sir?');
    if (dryRun()) return ok('[dry-run] would force-quit ' + name);
    await sh('/usr/bin/pkill', ['-f', name]);
    const killed = await appGone(name, 2500);
    logAction('close_app', { name, force: true }, killed ? 'ok' : 'FAIL');
    if (!killed) return fail('I sent ' + name + ' a kill and it is STILL running, sir — it may be relaunching itself.');
    return ok('Force-quit ' + name + ', sir.', { entity: name });
  }
  // A plain quit asks too. Its own help says "asks first" and runAction() has always gated it, but
  // the AGENTIC LOOP calls this function directly and so bypassed that gate entirely — observed
  // live, a file-management goal wandered into closing an unrelated app with no prompt, which can
  // lose unsaved work. Two execution paths, one of them ungated, is how a documented promise
  // quietly stops being true.
  if (!(ctx && ctx.confirmed)) return confirm('close_app', a, 'Quit ' + name + ', sir? Please confirm.');
  if (dryRun()) return ok('[dry-run] would quit ' + name);
  // Nothing to close is not a close. Asked to quit an app that was never running, this used to
  // answer "Closed Chess, sir." — a confident report of work that did not happen, about an app he
  // may well have been wrong about in the first place. Worth saying so: if he thought it was open,
  // that is the useful half of the answer.
  const isUp = await appRunning(name);
  if (isUp === false) return ok(name + ' was not running, sir — nothing to close.', { entity: name, noop: true });
  // null means the check itself failed. Saying "it was not running" there is a claim about the
  // machine made from no evidence, and it is the exact sentence that made a full eval report a
  // close of an app still sitting on screen. Try the quit anyway — it is harmless if the app really
  // is gone — and let the read-back below decide what actually happened.
  if (isUp === null) logAction('close_app', { name, check: 'unknown' }, 'warn');
  const r = await sh('/usr/bin/osascript', ['-e', 'quit app "' + name.replace(/"/g, '\\"') + '"']);
  // READ IT BACK. Two separate ways this used to report a close that never happened:
  //
  //   · the ok() below ran unconditionally — r.err was written to the action log as FAIL and then
  //     "Closed X, sir." was returned anyway, so a quit that errored still read as success;
  //   · `quit app` returns when the request is DELIVERED, not when the app exits. An app holding
  //     unsaved work puts up a save sheet and stays running, and this cheerfully announced it had
  //     closed TextEdit while TextEdit sat there asking what to do about the file.
  //
  // Neither is detectable from the osascript result, so the only honest answer comes from asking
  // the machine whether the process is still there.
  const gone = await appGone(name, 3000);
  logAction('close_app', { name }, gone ? 'ok' : 'FAIL');
  if (gone) return ok('Closed ' + name + ', sir.', { entity: name });
  if (r.err) return fail('I could not quit ' + name + ', sir — ' + String(r.err.message || r.err).split('\n')[0]);
  return fail('I asked ' + name + ' to quit, sir, but it is still running — it most likely has unsaved work and is waiting on you. ' +
              'Say “force quit ' + name + '” if you want it gone regardless.');
}
// Is this app actually still there? Asked of System Events rather than inferred from a tool's exit
// code, because the exit code is the one thing that does not know.
// A QUERY THAT FAILED IS NOT AN ANSWER OF "NO".
//
// This used to be `/true/i.test(out)`, so a timeout, an error, or a busy System Events all produced
// the empty string and were read as "the app is not running". Measured in a full eval at RAM 99%
// and load 19.6: app-open confirmed TextEdit was up, and eight seconds later close_app answered
// "TextEdit was not running, sir — nothing to close" while TextEdit was still on screen. Three
// runs at load 10 with the app genuinely running all closed it correctly, which is the signature
// of a query giving up rather than a bug in the logic.
//
// So it now has three answers, not two: true, false, and null for "I could not tell" — and the
// callers are required to treat null as unknown. This is the same discipline as verifying a send
// against the compose box: not seeing a thing is not evidence that it is absent.
//
// The name also goes in as ARGV rather than being spliced into the script source, per the standing
// rule in this project. The old escaping worked, but an app name is a value and values are passed.
async function appRunning(name) {
  const r = await sh('/usr/bin/osascript', ['-e',
    'on run argv\ntell application "System Events" to return ((name of processes) contains (item 1 of argv))\nend run',
    String(name)], 6000);
  const out = String((r && r.out) || '').trim();
  if (/^true$/i.test(out)) return true;
  if (/^false$/i.test(out)) return false;
  return null;                       // timed out, errored, or said something unrecognisable
}
// Polled rather than checked once: quitting is not instantaneous, and a single immediate check
// would call every successful quit a failure.
async function appGone(name, ms) {
  const t0 = Date.now();
  for (;;) {
    // Only a definite false means gone. A null here is the check failing, and treating that as
    // "quit succeeded" would turn an unreadable machine into a confident success report.
    if ((await appRunning(name)) === false) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 250));
  }
}

async function list_running() {
  const r = await sh('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of (every process whose background only is false)']);
  const apps = r.out.split(', ').map(s => s.trim()).filter(Boolean);
  return ok('Running (' + apps.length + '): ' + apps.join(', '), { data: apps });
}
async function switch_to(a) {
  const m = fuzzyApp(a.name || a.target);
  // NEITHER OF THESE LOOKED AT THE SCORE, and fuzzyApp used to answer every unknown name with
  // whichever app the index listed first. So "switch to github" ran `open -a Antigravity` and
  // reported "Switched to Antigravity, sir." — a wrong action reported as a success, which is the
  // one outcome this system must never produce. open_app had the gate all along; these two did not.
  if (m.score < 0.5) return fail('There is no app called “' + String(a.name || a.target || '').trim() + '” on this Mac, sir.');
  await sh('/usr/bin/open', ['-a', m.name]);
  return ok('Switched to ' + m.name + ', sir.', { entity: m.name });
}
async function hide_app(a) {
  const m = fuzzyApp(a.name || a.target);
  if (m.score < 0.5) return fail('There is no app called “' + String(a.name || a.target || '').trim() + '” on this Mac, sir.');
  await sh('/usr/bin/osascript', ['-e', 'tell application "System Events" to set visible of process "' + m.name.replace(/"/g, '\\"') + '" to false']);
  return ok('Hid ' + m.name + ', sir.', { entity: m.name });
}
async function open_url(a) {
  // `let`, not `const` — the scheme fill-in below reassigns it. As a const this threw
  // "Assignment to constant variable" on exactly the bare-domain case it was written for. It hid
  // because quickAction pre-normalises URLs, so only the agentic loop ever reached the throw.
  let u = String(a.url || a.target || '');
  // Fill in a missing scheme for a plain host[/path] — "ad-max.vercel.app" is a link a person
  // typed, and refusing it reads as a failure. Narrow on purpose: prose never becomes a URL.
  if (!/^https?:\/\//.test(u) && /^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?::\d{2,5})?(?:\/\S*)?$/i.test(u)) u = 'https://' + u;
  if (!/^https?:\/\//.test(u)) return fail('Only http/https links, sir.');
  await sh('/usr/bin/open', [u]); logAction('open_url', { u }, 'ok');
  return ok('Opening the link, sir.');
}
async function open_in_finder(a) {
  const abs = resolvePath(a.path);
  await sh('/usr/bin/open', ['-R', abs]);
  return ok('Revealed ' + short(abs) + ' in Finder, sir.');
}

// OPEN A FOLDER — a Finder window on it, not a reveal in its parent (open_in_finder). Directories only: the
// reader's open falls back to his real folders ("open downloads", casual dev run 2026-09-29), and nothing
// that is not a folder is opened this way.
async function open_folder(a) {
  const abs = resolvePath(a.path);
  let st = null;
  try { st = fs.statSync(abs); } catch (e) {}
  if (!st) return fail('There is no folder at ' + short(abs) + ', sir.');
  if (!st.isDirectory()) return fail(short(abs) + ' is not a folder, sir.');
  const r = await sh('/usr/bin/open', [abs]);
  if (r.err) return fail('I could not open ' + short(abs) + ', sir.');
  logAction('open_folder', { abs }, 'ok');
  return ok('Opened ' + short(abs) + ' in Finder, sir.');
}

// ---------------- system info & misc ----------------
async function system_status() {
  const d = {};
  try { const df = execFileSync('/bin/df', ['-H', HOME]).toString().split('\n')[1].split(/\s+/); d.disk = df[3] + ' free'; } catch (e) {}
  try { const bat = execFileSync('/usr/bin/pmset', ['-g', 'batt']).toString(); const m = bat.match(/(\d+)%/); const ac = /AC Power/.test(bat); d.battery = m ? m[1] + '%' + (ac ? ' (AC)' : '') : 'n/a'; } catch (e) {}
  try { const load = execFileSync('/usr/bin/uptime').toString().match(/load averages?: ([\d.]+)/); d.cpu = load ? 'load ' + load[1] : 'n/a'; } catch (e) {}
  try { const totGB = os.totalmem() / 1e9; const usedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100); d.ram = usedPct + '% of ' + Math.round(totGB) + 'GB'; } catch (e) {}
  // WI-FI: "OFF" WAS A LIE, EVERY TIME.
  //
  // networksetup -getairportnetwork answers "You are not associated with an AirPort network" on
  // macOS 15+ regardless of the truth — Apple retired that call along with the `airport` binary.
  // Measured here on macOS 26.5 while en0 held 192.168.18.37 and was actively carrying an 18 GB
  // download: every status line this session read "Wi-Fi off". Reporting a live connection as off
  // is the same failure as reporting a running app as absent — a tool that cannot see something
  // saying it is not there.
  //
  // Connectivity and the NETWORK NAME are now separate questions, because they have separate
  // answers. Whether the link is up is knowable for certain (ipconfig/ifconfig). The SSID is not:
  // macOS redacts it unless the caller holds Location permission, which this process does not, so
  // it comes back literally as "<redacted>". Unknown name, known connection — say "on", never "off".
  try {
    let summary = '';
    try { summary = execFileSync('/usr/sbin/ipconfig', ['getsummary', 'en0'], { timeout: 4000 }).toString(); } catch (e) {}
    const linkUp = /LinkStatusActive\s*:\s*TRUE/i.test(summary) || /\binet \d/.test((() => {
      try { return execFileSync('/sbin/ifconfig', ['en0'], { timeout: 4000 }).toString(); } catch (e) { return ''; }
    })());
    const m = summary.match(/\bSSID\s*:\s*(.+)/);
    const ssid = m ? m[1].trim() : '';
    const namedSsid = ssid && !/^<.*>$/.test(ssid) ? ssid : '';   // "<redacted>" is not a name
    d.wifi = namedSsid || (linkUp ? 'on' : 'off');
  } catch (e) {}
  const say = 'Battery ' + (d.battery || '?') + ' · Disk ' + (d.disk || '?') + ' · RAM ' + (d.ram || '?') + ' · CPU ' + (d.cpu || '?') + ' · Wi-Fi ' + (d.wifi || '?') + '.';
  return ok(say, { data: d });
}
async function set_volume(a) {
  const lvl = Math.max(0, Math.min(100, Number(a.level)));
  await sh('/usr/bin/osascript', ['-e', 'set volume output volume ' + lvl]);
  return ok('Volume ' + lvl + '%, sir.');
}
async function set_brightness(a) {
  // best-effort via key events isn't reliable; try `brightness` CLI if present, else report.
  const r = await sh('/usr/bin/which', ['brightness']);
  if (!r.err && r.out.trim()) { await sh(r.out.trim(), [String(Math.max(0, Math.min(1, Number(a.level) / 100)))]); return ok('Brightness set, sir.'); }
  return fail('No brightness CLI installed, sir (brew install brightness).');
}
async function screenshot(a) {
  const dest = a.path ? resolvePath(a.path) : path.join(HOME, 'Desktop', 'jarvis-shot-' + Date.now() + '.png');
  const g = guardWrite(dest); if (g) return g;
  await sh('/usr/sbin/screencapture', ['-x', dest], 10000);
  logAction('screenshot', { dest }, 'ok');
  return ok('Screenshot saved to ' + short(dest) + ', sir.');
}
async function sleep_display() { await sh('/usr/bin/pmset', ['displaysleepnow']); return ok('Display asleep, sir.'); }
async function empty_trash(a, ctx) {
  if (!(ctx && ctx.confirmed)) return confirm('empty_trash', a, 'Empty the Trash permanently — confirm, sir?');
  if (dryRun()) return ok('[dry-run] would empty Trash');
  const r = await sh('/usr/bin/osascript', ['-e', 'tell application "Finder" to empty trash']);
  logAction('empty_trash', {}, r.err ? 'FAIL' : 'ok');
  return r.err ? fail('Couldn’t empty Trash, sir.') : ok('Trash emptied, sir.');
}

// ---------------- custom app builder ----------------
// Scaffolds apps/<name>/ with a script + a double-clickable .app wrapper (osacompile).
async function make_app(a) {
  const name = String(a.name || 'JarvisApp').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'JarvisApp';
  const srcDir = path.join(APPS_DIR, name);
  if (dryRun()) return ok('[dry-run] would scaffold app "' + name + '"');
  try {
    fs.mkdirSync(srcDir, { recursive: true });
    const script = a.script || ('#!/bin/bash\n# ' + (a.description || name) + '\necho "' + name + ' — built by JARVIS"\n');
    const scriptPath = path.join(srcDir, 'run.sh');
    fs.writeFileSync(scriptPath, script); fs.chmodSync(scriptPath, 0o755);
    fs.writeFileSync(path.join(srcDir, 'README.md'), '# ' + name + '\n\n' + (a.description || '') + '\n\nEdit run.sh then re-run make_app to rebuild.\n');
    // Wrap as a .app that runs the script in Terminal (osacompile).
    const appPath = path.join(srcDir, name + '.app');
    try { fs.rmSync(appPath, { recursive: true, force: true }); } catch (e) {}
    const ascript = 'do shell script "bash " & quoted form of "' + scriptPath.replace(/"/g, '\\"') + '"';
    const r = await sh('/usr/bin/osacompile', ['-o', appPath, '-e', ascript], 12000);
    if (r.err) return fail('Scaffolded source but couldn’t build .app, sir: ' + (r.err.message || ''));
    logAction('make_app', { name, dir: srcDir }, 'ok');
    return ok('Forged "' + name + '" — source in apps/' + name + '/, double-click ' + name + '.app to run, sir.', { data: { dir: srcDir, app: appPath } });
  } catch (e) { return fail('Couldn’t build the app, sir: ' + e.message); }
}

// ---------------- dispatch ----------------
const TOOLS = {
  create_file, create_folder, append: append_file, read: read_file, list: list_dir, search: search_files,
  delete: delete_path, rename: rename_path, move: move_path, copy: copy_path,
  open_app, close_app, list_running, switch_to, hide_app, open_url, open_in_finder, open_folder,
  read_clipboard,
  system_status, volume: set_volume, brightness: set_brightness, screenshot, sleep_display, empty_trash, make_app,
};
const DESTRUCTIVE = new Set(['delete', 'empty_trash', 'move']);

async function runTool(name, args, ctx) {
  const fn = TOOLS[name];
  if (!fn) return fail('Unknown tool: ' + name);
  try { return await fn(args || {}, ctx || {}); }
  catch (e) { logAction(name, args, 'ERROR ' + e.message); return fail('That failed, sir: ' + e.message); }
}

module.exports = { runTool, TOOLS, DESTRUCTIVE, resolvePath, fuzzyApp, isProtected, dryRun, ACTIONS_LOG, logAction, setPreferredApps };
