'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// JARVIS local e-book library — answers from books ON THIS MACHINE.
//
// Zero dependencies, like the rest of jarvis-os: EPUBs are unzipped with
// /usr/bin/unzip and de-tagged; PDFs go through PDFKit via the JXA ObjC bridge
// (verified: 2300 chars off a real PDF, no pdftotext/mutool needed).
//
// Retrieval is keyword scoring, NOT embeddings — deliberately. It needs no
// model to build the index, works offline, and the index is a plain JSON file
// you can inspect. Good enough to find the right passage, and the LLM only ever
// sees a handful of retrieved chunks rather than the whole book.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let deps = { jlog: () => {}, audit: () => {}, llm: null, stateDir: null };
function init(d) { deps = Object.assign(deps, d || {}); }

const LIB_DIR = path.join(process.env.HOME, 'JARVIS MK-1', 'library');
const INDEX_FILE = () => path.join(deps.stateDir || '/tmp', 'library.json');

const sh = (cmd, args, timeout) => new Promise(resolve => {
  execFile(cmd, args, { timeout: timeout || 60000, maxBuffer: 64 << 20 }, (e, out) => resolve(String(out || '')));
});

// ---------------- extraction ----------------
const detag = h => String(h)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#\d+;/g, ' ').replace(/&\w+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

async function extractEpub(file) {
  // An EPUB is a zip of XHTML. Listing then reading each entry keeps memory sane on big books.
  const list = await sh('/usr/bin/unzip', ['-Z1', file], 30000);
  const parts = list.split('\n').filter(n => /\.(x?html?|xml)$/i.test(n) && !/container|toc|nav/i.test(n));
  const out = [];
  for (const entry of parts) {
    const raw = await sh('/usr/bin/unzip', ['-p', file, entry], 30000);
    const txt = detag(raw);
    if (txt.length > 200) out.push(txt);
  }
  return out;                       // one string per chapter-ish file
}

const JXA_PDF = `function run(argv){
  ObjC.import('Quartz');
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc.js) return '';
  const n = doc.pageCount;
  const pages = [];
  for (let i = 0; i < n; i++) {
    const p = doc.pageAtIndex(i);
    if (!p.js) continue;
    const s = ObjC.unwrap(p.string) || '';
    if (s.trim().length) pages.push(JSON.stringify({ page: i + 1, text: s }));
  }
  return pages.join('\\n');
}`;

async function extractPdf(file) {
  const out = await sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_PDF, file], 180000);
  const pages = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); pages.push({ page: o.page, text: String(o.text).replace(/\s+/g, ' ').trim() }); } catch (e) {}
  }
  return pages;
}

// ---------------- indexing ----------------
// Chunks are ~1200 chars so a retrieved passage is big enough to answer from but
// small enough that several fit in a 3B's context.
function chunk(text, size) {
  const s = String(text || '');
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.filter(c => c.trim().length > 120);
}

const STOP = new Set('the a an and or of to in is it for on with as at by from that this be are was were i you he she they we not but if then than so what which who how why when where all can will'.split(' '));
const tokenize = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));

async function buildIndex(onProgress) {
  const docs = [];
  if (!fs.existsSync(LIB_DIR)) return { ok: false, say: 'No library folder at ' + LIB_DIR + ', Sir.' };
  const folders = fs.readdirSync(LIB_DIR).filter(f => fs.statSync(path.join(LIB_DIR, f)).isDirectory());
  for (const folder of folders) {
    const dir = path.join(LIB_DIR, folder);
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const title = name.replace(/\.(epub|pdf)$/i, '').replace(/_/g, ' ');
      try {
        if (/\.epub$/i.test(name)) {
          const parts = await extractEpub(file);
          parts.forEach((p, ci) => chunk(p, 1200).forEach(c => docs.push({ book: title, folder, loc: 'part ' + (ci + 1), text: c })));
        } else if (/\.pdf$/i.test(name)) {
          const pages = await extractPdf(file);
          pages.forEach(p => chunk(p.text, 1200).forEach(c => docs.push({ book: title, folder, loc: 'p.' + p.page, text: c })));
        } else continue;
        if (onProgress) onProgress(title, docs.length);
      } catch (e) { deps.jlog('Library › failed to read ' + name + ': ' + e.message); }
    }
  }
  // Document frequency for IDF — rare words should dominate the score.
  const df = Object.create(null);
  for (const d of docs) for (const w of new Set(tokenize(d.text))) df[w] = (df[w] || 0) + 1;
  const index = { at: Date.now(), n: docs.length, df, docs };
  try { fs.writeFileSync(INDEX_FILE(), JSON.stringify(index)); } catch (e) { return { ok: false, say: 'Could not save the index, Sir: ' + e.message }; }
  const books = new Set(docs.map(d => d.book)).size;
  deps.jlog('Library › indexed ' + books + ' books, ' + docs.length + ' passages');
  // Filename-vs-content check. Five of these books were once the WRONG BOOK ENTIRELY —
  // Einstein_Relativity.epub held Galileo, Verne_Twenty_Thousand_Leagues.epub held Candide —
  // which is far worse than a missing book, because answers still get cited confidently to an
  // author who never wrote them. Silent for a clean library; names the suspects otherwise.
  const bad = mismatchedBooks(docs);
  if (bad.length) {
    deps.jlog('Library › WARNING: ' + bad.length + ' book(s) do not match their filename: ' +
      bad.map(b => b.file + ' contains "' + b.actual + '"').join('; '));
  }
  return { ok: true, books, passages: docs.length, mismatched: bad };
}

// Compares each book's FILENAME against the title printed inside its own text. Gutenberg files
// announce themselves ("The Project Gutenberg eBook of X"); for anything else the opening words
// are used. A book is flagged only when NO significant word of the filename appears in the
// content's own title — deliberately loose, since a false alarm here is worse than a near miss.
function mismatchedBooks(docs) {
  const first = Object.create(null);
  for (const d of docs) if (!first[d.book]) first[d.book] = d.text.slice(0, 200);
  const norm = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const out = [];
  for (const book of Object.keys(first)) {
    const m = first[book].match(/Project Gutenberg eBook of ([^,]{3,70})/i);
    const actual = (m ? m[1] : first[book].slice(0, 70)).trim();
    const words = book.toLowerCase().split(/[\s_]+/).filter(w => w.length > 3);
    if (!words.length) continue;
    if (!words.some(w => norm(actual).includes(norm(w)))) out.push({ file: book, actual });
  }
  return out;
}

let cache = null;
function loadIndex() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8')); } catch (e) { cache = null; }
  return cache;
}
function indexStatus() {
  const ix = loadIndex();
  if (!ix) return null;
  return { books: new Set(ix.docs.map(d => d.book)).size, passages: ix.n, at: ix.at };
}

// ---------------- retrieval ----------------
// tf-idf over the query terms, with a small bonus when the book TITLE matches —
// so "what does Herodotus say about Egypt" prefers the right book.
function retrieve(query, k, bookHint) {
  const ix = loadIndex();
  if (!ix || !ix.docs.length) return [];
  const qs = tokenize(query);
  if (!qs.length) return [];
  const N = ix.n || 1;
  const hint = String(bookHint || '').toLowerCase();
  const scored = [];
  for (const d of ix.docs) {
    const tf = Object.create(null);
    for (const w of tokenize(d.text)) tf[w] = (tf[w] || 0) + 1;
    let s = 0;
    for (const q of qs) {
      if (!tf[q]) continue;
      const idf = Math.log(1 + N / (1 + (ix.df[q] || 0)));
      s += (1 + Math.log(tf[q])) * idf;
    }
    if (!s) continue;
    if (hint && d.book.toLowerCase().includes(hint)) s *= 2.5;
    scored.push({ s, d });
  }
  scored.sort((a, b) => b.s - a.s);
  // At most 2 passages per book so one verbose book cannot crowd out the rest.
  const perBook = Object.create(null), out = [];
  for (const { d } of scored) {
    perBook[d.book] = (perBook[d.book] || 0) + 1;
    if (perBook[d.book] > 2) continue;
    out.push(d);
    if (out.length >= (k || 5)) break;
  }
  return out;
}

// ---------------- the tool ----------------
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = say => ({ ok: false, say });

async function ask_library(args) {
  const q = String(args.query || args.question || args.text || '').trim();
  if (!q) return fail('What should I look up in your books, Sir?');
  const st = indexStatus();
  if (!st) return fail('Your library is not indexed yet, Sir — say “index my library”.');
  const hits = retrieve(q, 5, args.book);
  if (!hits.length) return fail('Nothing in your books matches that, Sir.');
  const ctx = hits.map((h, i) => '[' + (i + 1) + '] ' + h.book + ' (' + h.loc + '):\n' + h.text).join('\n\n');
  const cites = hits.map((h, i) => '[' + (i + 1) + '] ' + h.book + ' · ' + h.loc);
  if (!deps.llm) return ok('Found these passages, Sir:\n' + ctx.slice(0, 1200));
  try {
    const r = await deps.llm({
      system: 'Answer ' + (profile.userName() ? profile.userName() + '\'s' : 'the user\'s') + ' question ONLY from the book passages given. Cite the passage numbers you use like [1]. ' +
        'If the passages do not answer it, say so plainly rather than filling the gap from memory. Address him as Sir. Keep it to a few sentences.',
      messages: [{ role: 'user', content: 'PASSAGES:\n' + ctx + '\n\nQUESTION: ' + q }],
      max_tokens: 400, timeoutMs: 90000,
    });
    const answer = String(r.text || '').trim() || 'I could not summarise that, Sir.';
    deps.audit('ask_library', { q: q.slice(0, 60), hits: hits.length }, 'ok');
    return ok(answer + '\n\nFrom your library:\n' + cites.join('\n'), { data: { sources: hits.map(h => ({ book: h.book, loc: h.loc })) } });
  } catch (e) { return ok('From your books, Sir:\n' + ctx.slice(0, 1000)); }
}

async function library_index() {
  const r = await buildIndex();
  cache = null;
  if (!r.ok) return fail(r.say);
  const warn = (r.mismatched && r.mismatched.length)
    ? '\n\nBut ' + r.mismatched.length + ' file' + (r.mismatched.length === 1 ? ' does' : 's do') + ' not match their names, Sir:\n' +
      r.mismatched.map(b => '· ' + b.file + ' actually contains “' + b.actual + '”').join('\n') +
      '\nI would be citing the wrong author for those.'
    : '';
  return ok('Library indexed, Sir — ' + r.books + ' books, ' + r.passages + ' passages, searchable offline.' + warn);
}

function library_list() {
  const st = indexStatus();
  if (!fs.existsSync(LIB_DIR)) return fail('No library folder yet, Sir.');
  const lines = [];
  for (const f of fs.readdirSync(LIB_DIR)) {
    const dir = path.join(LIB_DIR, f);
    if (!fs.statSync(dir).isDirectory()) continue;
    const books = fs.readdirSync(dir).filter(n => /\.(epub|pdf)$/i.test(n));
    if (books.length) lines.push('· ' + f.replace(/_/g, ' ') + ' (' + books.length + ')');
  }
  return ok('Your library, Sir:\n' + lines.join('\n') + (st ? '\n\nIndexed: ' + st.books + ' books · ' + st.passages + ' passages.' : '\n\nNot indexed yet — say “index my library”.'));
}

const TOOLS = { ask_library, library_index, library_list };
const TOOL_HELP = {
  ask_library: 'ask_library{query, book?}. Answer from the user\'s OWN e-books on this Mac, with citations. Use for questions about anything in their library.',
  library_index: 'library_index{}. Re-read and index the e-book folder.',
  library_list: 'library_list{}. What books are installed.',
};

module.exports = { init, TOOLS, TOOL_HELP, buildIndex, retrieve, indexStatus, mismatchedBooks, LIB_DIR };
