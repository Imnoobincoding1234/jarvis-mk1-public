#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// JARVIS — terminal client.
//
// Same JARVIS, no browser. Talks to the running jarvis-os server over its HTTP API exactly as the
// web UI does, so there is ONE brain and ONE set of guards: the confirm gates, the contact
// resolution, the refusals and the agent harness all live server-side and apply identically here.
// This file renders and relays. It decides nothing.
//
// ZERO DEPENDENCIES, like everything else in this tree — node stdlib only. That rules out the
// obvious ways to do a REPL with colour and a spinner, so those are done by hand below.
//
// It also never touches the model directly and never reads .env: the API token is the only secret
// it handles, and it is read from the same state file the server wrote.
// ---------------------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const readline = require('readline');

const HOME = os.homedir();
const ROOT = path.join(HOME, 'JARVIS MK-1', 'jarvis-os');
const TOKEN_FILE = path.join(ROOT, 'state', '.apitoken');
const HOST = process.env.JARVIS_HOST || '127.0.0.1';
const PORT = Number(process.env.JARVIS_PORT || 8787);

// ---------------- colour ----------------
// Disabled when stdout is not a terminal, so `jarvis "..." > file` and `| grep` get clean text
// rather than escape codes. NO_COLOR is honoured because it is the standard and costs one check.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--no-color');
const rgb = (r, g, b) => COLOR ? '\x1b[38;2;' + r + ';' + g + ';' + b + 'm' : '';
const R = COLOR ? '\x1b[0m' : '';
const BOLD = COLOR ? '\x1b[1m' : '';
const DIM = COLOR ? '\x1b[2m' : '';

// The arc-reactor palette: deep hull blue up to the bright cyan of the reactor itself.
const BLUES = [
  rgb(21, 78, 148), rgb(28, 100, 180), rgb(36, 124, 209),
  rgb(46, 150, 233), rgb(79, 181, 246), rgb(126, 209, 255),
];
const SKY = rgb(96, 190, 250);      // JARVIS speaking
const PALE = rgb(150, 214, 255);    // his own words echoed back
const STEEL = rgb(94, 128, 160);    // chrome: labels, rules, timings
const AMBER = rgb(232, 168, 74);    // something needs him
const RED = rgb(226, 96, 96);       // something broke

// ---------------- banner ----------------
// Redrawn 2026-10-14 — he: "looks a bit funky and off … maybe more smoothness or fluidity". What was off, and why:
//   · a glyph only fills the font's own box, so rows of blocks showed seams. A pixel pair is painted with the BOTTOM pixel
//     as the cell's background colour, and a background fills the whole cell, line spacing included — no seams.
//   · the reactor was 16 px with hard edges; it is 20 px and supersampled (4×4 per pixel), so edges and bands blend.
//   · the name, tagline, rules and status sit in ONE column of one width, starting at the prompt's margin.
//   · the reactor powers up: about half a second at start. No motion when colour is off or JARVIS_NO_ANIM is set.
//   · the name keeps its original lettering — a pixel-font redraw tried the same day was worse (his call).
const MARGIN = '  ';
const ANIM = COLOR && !process.env.JARVIS_NO_ANIM;
const RULE = rgb(34, 72, 118);
const W = () => Math.max(48, Math.min(process.stdout.columns || 80, 100));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rmix = (a, b, t) => {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
};
const rfg = c => '\x1b[38;2;' + c[0] + ';' + c[1] + ';' + c[2] + 'm';
const rbg = c => '\x1b[48;2;' + c[0] + ';' + c[1] + ';' + c[2] + 'm';

// Pixels → terminal rows, two pixels per cell (▀ = top in the foreground, bottom as the background). Transparent stays a
// plain space: painting a background where there is no pixel would draw a box on any theme that is not pure black.
function pixelRows(w, h, px) {
  const rows = [];
  for (let y = 0; y < h; y += 2) {
    let line = '';
    for (let x = 0; x < w; x++) {
      const t = px(x, y), b = y + 1 < h ? px(x, y + 1) : null;
      if (!t && !b) line += R + ' ';
      // Two shades this close are one colour to the eye — paint one solid cell (no glyph edge, so no hairline).
      else if (t && b && Math.max(Math.abs(t[0] - b[0]), Math.abs(t[1] - b[1]), Math.abs(t[2] - b[2])) <= 14) line += rbg(rmix(t, b, 0.5)) + ' ';
      else if (t && b) line += rfg(t) + rbg(b) + '▀';
      else if (t) line += '\x1b[49m' + rfg(t) + '▀';
      else line += '\x1b[49m' + rfg(b) + '▄';
    }
    rows.push(line + R);
  }
  return rows;
}

// ---- the arc reactor ----
// Radii, drawn on a 16-pixel grid and scaled to RPX. Every gap between these bands is load-bearing: without the dark
// recess the coils merge into the housing, and without the gap inside them they merge into the core.
const RPX = 20;
const RS = RPX / 16;
const R_OUTER = 7.8, R_RECESS = 6.3, R_COIL_OUT = 5.5, R_COIL_IN = 3.3, R_CORE_RING = 2.3, R_CORE = 1.4;
const R_SEGMENTS = 8, R_SPOKE = 0.13;   // eight windings; each spoke takes this fraction of a segment's arc
// White-hot centre falling away to a cold navy casing, so it reads as lit from within.
const C_CORE_HOT = [245, 253, 255], C_CORE = [168, 230, 255], C_RING_IN = [96, 194, 250];
const C_COIL_HOT = [150, 220, 255], C_COIL = [52, 140, 220];
const C_INNER_DK = [14, 40, 74], C_SPILL = [40, 104, 165];
const C_HOUSING = [30, 84, 140], C_HOUSING_E = [15, 42, 78];
// One point of the reactor in 16-grid units, or null outside it. `k` is power, 0..1: the inner parts brighten with it.
// The windings are ONE ring cut into arcs by thin spokes — eight round discs at this size read as a disco ball.
function reactorSample(u, v, k) {
  const dx = u - 8, dy = v - 8;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > R_OUTER) return null;
  if (r > R_RECESS) return rmix(C_HOUSING, C_HOUSING_E, (r - R_RECESS) / (R_OUTER - R_RECESS));
  let c;
  if (r > R_COIL_OUT) c = C_INNER_DK;
  else if (r >= R_COIL_IN) {
    const f = (((Math.atan2(dy, dx) + Math.PI / 2) / (2 * Math.PI / R_SEGMENTS)) % 1 + 1) % 1;
    const mid = (R_COIL_IN + R_COIL_OUT) / 2, half = (R_COIL_OUT - R_COIL_IN) / 2;
    c = (f < R_SPOKE / 2 || f > 1 - R_SPOKE / 2) ? rmix(C_INNER_DK, C_SPILL, 0.35)
      : rmix(C_COIL, C_COIL_HOT, 0.85 * (1 - Math.abs(r - mid) / half));
  }
  else if (r > R_CORE_RING) c = rmix(C_INNER_DK, C_SPILL, (1 - (r - R_CORE_RING) / (R_COIL_IN - R_CORE_RING)) * 0.6);
  else if (r > R_CORE) c = rmix(C_CORE, C_RING_IN, (r - R_CORE) / (R_CORE_RING - R_CORE));
  else c = rmix(C_CORE_HOT, C_CORE, r / R_CORE);
  return rmix(C_INNER_DK, c, k);
}
// 4×4 samples per pixel, averaged: blended edges and bands instead of stair-steps. Under half covered = transparent.
function reactorPixel(x, y, k) {
  let n = 0, s = [0, 0, 0];
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const c = reactorSample((x + (sx + 0.5) / 4) / RS, (y + (sy + 0.5) / 4) / RS, k);
    if (c) { n++; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
  }
  return n < 8 ? null : [Math.round(s[0] / n), Math.round(s[1] / n), Math.round(s[2] / n)];
}

// ---- the name ----
// The original lettering, coloured row by row exactly as before (a pixel-font redraw on 2026-10-14 was worse — his
// call — and was taken out the same day).
const LOGO = [
  '      ██╗   █████╗   ██████╗  ██╗   ██╗  ██╗  ███████╗',
  '      ██║  ██╔══██╗  ██╔══██╗ ██║   ██║  ██║  ██╔════╝',
  '      ██║  ███████║  ██████╔╝ ██║   ██║  ██║  ███████╗',
  ' ██   ██║  ██╔══██║  ██╔══██╗ ╚██╗ ██╔╝  ██║  ╚════██║',
  ' ╚█████╔╝  ██║  ██║  ██║  ██║  ╚████╔╝   ██║  ███████║',
  '  ╚════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝   ╚═══╝    ╚═╝  ╚══════╝',
];
const NAME_W = Math.max.apply(null, LOGO.map(l => l.length));

const TAG = 'J U S T   A   R A T H E R   V E R Y   I N T E L L I G E N T   S Y S T E M';
const TAG_SHORT = 'just a rather very intelligent system';
const GAP = '   ';
const centre = (s, w) => ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;

// The art at one moment of the power-up: reactor power k (0..1).
function artRows(withReactor, k) {
  const name = LOGO.map((row, i) => BLUES[i] + row.padEnd(NAME_W) + R);
  if (!withReactor) return name.map(r => MARGIN + r);
  const reactor = pixelRows(RPX, RPX, (x, y) => reactorPixel(x, y, k));
  const pad = Math.floor((reactor.length - name.length) / 2);   // the name is centred against the taller reactor
  return reactor.map((r, i) => { const li = i - pad; return MARGIN + r + GAP + (li >= 0 && li < name.length ? name[li] : ''); });
}

async function showBanner(st, rl) {
  const out = s => process.stdout.write(s);
  const cols = process.stdout.columns || 80;
  // Measured against the REAL column count: a reactor that wraps into the letters makes both unreadable.
  const withName = cols >= MARGIN.length + NAME_W + 1;
  const withReactor = COLOR && withName && cols >= MARGIN.length + RPX + GAP.length + NAME_W + 1;
  out('\n');
  if (!withName) {
    // Pixel art is pure colour; without it (or room for it) the plain name is the honest fallback.
    out(MARGIN + BOLD + 'J A R V I S' + R + '\n' + MARGIN + STEEL + TAG_SHORT + R + '\n' + MARGIN + RULE + '─'.repeat(Math.max(1, cols - MARGIN.length - 1)) + R + '\n' + st.line + '\n\n');
    return;
  }
  const CW = withReactor ? RPX + GAP.length + NAME_W : NAME_W;
  if (ANIM) {
    if (rl) rl.pause();                     // nothing typed during the sweep is echoed into the middle of it
    out('\x1b[?25l');
    const N = 14;
    let rows = artRows(withReactor, 0.08);
    out(rows.join('\n') + '\n');
    for (let f = 1; f <= N + 1; f++) {
      await sleep(38);
      const t = Math.min(1, f / N), ease = 1 - Math.pow(1 - t, 3);
      rows = artRows(withReactor, 0.08 + 0.92 * ease);
      out('\x1b[' + rows.length + 'A' + rows.map(r => '\r' + r + '\x1b[K').join('\n') + '\n');
    }
    out('\x1b[?25h');
    if (rl) rl.resume();
  } else {
    out(artRows(withReactor, 1).join('\n') + '\n');
  }
  const tag = TAG.length <= CW ? TAG : TAG_SHORT;
  out('\n' + MARGIN + STEEL + centre(tag, CW) + R + '\n');
  // The rules run from the margin to the terminal's right edge (his ask), one column short so they never wrap.
  const rule = MARGIN + RULE + '─'.repeat(Math.max(CW, cols - MARGIN.length - 1)) + R;
  out(rule + '\n' + st.line + '\n' + rule + '\n\n');
}
if (ANIM) process.on('exit', () => process.stdout.write('\x1b[?25h'));   // never leave his cursor hidden

// ---------------- http ----------------
function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

function api(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: HOST, port: PORT, path: p, method,
      headers: Object.assign(
        { 'x-jarvis-token': token() },
        data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')); }
        // A non-JSON body is a real answer about what went wrong (an HTML error page, a proxy) —
        // surfacing it beats "Unexpected token <".
        catch (e) { resolve({ error: buf.slice(0, 400) || 'empty response' }); }
      });
    });
    // The local 3B genuinely takes minutes on an agentic goal, so the default here is generous.
    // A deep goal can legitimately run to the harness's own fifteen-minute ceiling.
    req.setTimeout(timeoutMs || 16 * 60 * 1000, () => { req.destroy(new Error('timed out waiting for JARVIS')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------- spinner + live step narration ----------------
// The server already narrates what it is doing to /api/progress for the web UI. Polling the same
// feed means the terminal shows the SAME steps rather than a spinner over silence — which matters
// most here, because on the local model the pause between "thinking" and an answer is minutes.
// The spinner's glyph breathes through the reactor blues instead of sitting on one shade.
const PULSE = [BLUES[2], BLUES[3], BLUES[4], BLUES[5], BLUES[4], BLUES[3]];
function thinking() {
  if (!COLOR) return { stop: () => {} };            // piped output gets no animation at all
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0, line = 'thinking', after = 0, alive = true;
  const t0 = Date.now();

  const paint = () => {
    if (!alive) return;
    const secs = Math.round((Date.now() - t0) / 1000);
    const txt = MARGIN + PULSE[Math.floor(i / 2) % PULSE.length] + frames[i++ % frames.length] + R + '  ' + STEEL + line +
      DIM + '  ' + secs + 's' + R;
    process.stdout.write('\r\x1b[2K' + txt.slice(0, (process.stdout.columns || 80) + 40));
  };
  const spin = setInterval(paint, 90);

  // Polled rather than streamed because /api/progress is a polling endpoint; 600ms is under the
  // threshold where a step feels stale and well above anything that would load the server.
  const poll = setInterval(async () => {
    try {
      const j = await api('GET', '/api/progress?after=' + after, null, 5000);
      if (j && Array.isArray(j.steps) && j.steps.length) {
        after += j.steps.length;
        const last = j.steps[j.steps.length - 1];
        if (last && last.t) line = String(last.t).replace(/\s+/g, ' ').trim().slice(0, 70);
      }
    } catch (e) { /* the answer matters, the narration does not */ }
  }, 600);

  return {
    stop() {
      alive = false;
      clearInterval(spin); clearInterval(poll);
      process.stdout.write('\r\x1b[2K');
    },
  };
}

// ---------------- rendering ----------------
// Width is measured in VISIBLE characters: the colour codes pretty() puts round **bold** have no width on screen, and
// counting them wrapped a line early whenever an answer had bold in it.
const visLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
function wrap(text, width, indent) {
  const out = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line.length) line = word;
      else if (visLen(line + ' ' + word) <= width) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out.map(l => indent + l).join('\n');
}

// Light markdown only: **bold** and bullets. A full renderer in a file that must stay
// dependency-free is a lot of code to make a local model's asterisks look tidier.
function pretty(s) {
  let t = String(s == null ? '' : s);
  if (COLOR) t = t.replace(/\*\*(.+?)\*\*/g, BOLD + '$1' + R + SKY);
  else t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  return t.replace(/^[-*]\s+/gm, '· ');
}

// A thin bar marks his lines, and the text flows in rather than landing as one block: under half a second for a long
// answer, less for a short one — fast enough never to be waited on, slow enough to read as speech. Escape codes are
// written whole, so colour never breaks mid-sequence. No motion when ANIM is off (piped, NO_COLOR, JARVIS_NO_ANIM).
const BAR = BLUES[2] + '▎' + R + ' ';
async function jarvisSays(text) {
  const w = Math.max(40, W() - 4);
  const lines = wrap(pretty(text), w - 6, '').split('\n').map(l => MARGIN + BAR + SKY + l + R);
  process.stdout.write('\n');
  if (!ANIM) { process.stdout.write(lines.join('\n') + '\n\n'); return; }
  const atoms = lines.join('\n').split(/(\x1b\[[0-9;?]*[A-Za-z])/).flatMap(p => p.startsWith('\x1b[') ? [p] : Array.from(p));
  const visible = atoms.filter(a => !a.startsWith('\x1b[')).length;
  const per = Math.max(2, Math.ceil(visible / 40));
  for (let i = 0; i < atoms.length;) {
    let chunk = '', n = 0;
    while (i < atoms.length && n < per) { const a = atoms[i++]; chunk += a; if (!a.startsWith('\x1b[')) n++; }
    process.stdout.write(chunk);
    await sleep(11);
  }
  process.stdout.write(R + '\n\n');
}
const note = t => process.stdout.write(STEEL + MARGIN + '  ' + t + R + '\n');

// Renders whatever the server put in confirm.preview. It is a string for simple confirmations, a
// plan ({steps:[{tool,label}]}) for a previewed run, and a draft object for an outbound message —
// and String() turned the last two into "[object Object]", which is what he saw immediately before
// approving a step whose contents were therefore invisible. Never print that again: a preview whose
// shape is unrecognised is still shown, as compact JSON, because unreadable beats absent.
function previewText(p) {
  const flat = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (p == null) return '';
  if (typeof p === 'string') return flat(p).slice(0, 200);
  if (Array.isArray(p)) return p.map(flat).filter(Boolean).join(' → ').slice(0, 200);
  if (Array.isArray(p.steps) && p.steps.length) {
    return p.steps.map((s, i) => (i + 1) + '. ' + flat(s.label || s.tool)).join('  ').slice(0, 240);
  }
  try {
    const j = JSON.stringify(p);
    return (j === '{}' ? '(nothing to show)' : flat(j)).slice(0, 200);
  } catch (e) { return '(unshowable)'; }
}
const warn = t => process.stdout.write(AMBER + MARGIN + '  ' + t + R + '\n');
const bad = t => process.stdout.write(RED + MARGIN + '  ' + t + R + '\n');

// ---------------- one exchange ----------------
// Convo is kept client-side and posted whole, matching what the web UI does — the server's chat
// endpoint is stateless about history on purpose, so two clients cannot corrupt each other's thread.
const convo = [];
const MAX_TURNS = 24;   // bounded: the local model's context is not large and this is the cheapest place to respect that

let inFlight = false;
let thinkNext = false;   // armed by a bare "/think", spent on the next question — the app's Think hard button

// `extra` carries the same fields the web UI's buttons add to a chat request: images, brief, thinkHard.
async function ask(text, rl, extra) {
  extra = Object.assign({}, extra);
  if (thinkNext && !extra.brief) { extra.thinkHard = true; thinkNext = false; }
  if (extra.thinkHard) note('thinking this through carefully — this can take a few minutes.');
  convo.push({ role: 'user', content: text });
  while (convo.length > MAX_TURNS) convo.shift();

  inFlight = true;
  const spin = thinking();
  let j;
  try {
    j = await api('POST', '/api/chat', Object.assign({ messages: convo.slice(), via: 'typed' }, extra));
  } catch (e) {
    spin.stop(); inFlight = false;
    return bad(reachError(e));
  }
  spin.stop();
  inFlight = false;

  await present(j, rl);
}

// Renders one server response, and handles the two shapes that need him to answer something before
// anything happens. Both are resumed through the SAME endpoints the web UI uses, so a pause here
// gets the identical treatment — in particular the plan being resumed is the server's copy, never
// one this client could have edited.
async function present(j, rl) {
  if (!j || j.error) return bad('That did not work — ' + ((j && j.error) || 'no response'));

  const reply = j.reply || j.say || '';
  if (reply) { await jarvisSays(reply); convo.push({ role: 'assistant', content: reply }); }

  // TWO confirm shapes reach a client, and they resume through different endpoints.
  //
  //   · the AGENT shape carries an id — a whole paused plan is held server-side, and approving it
  //     resumes that plan at exactly the step that stopped;
  //   · the ACTION shape carries a tool and its args and no id — a single decided action, replayed
  //     with confirmed:true.
  //
  // Handling only the first is why "close textedit" asked in the terminal and then did nothing at
  // all: a plain quit comes back in the second shape, fell past this branch, and was rendered as a
  // question nobody could answer.
  if (j.confirm && j.confirm.id) {
    // A PREVIEW IS NOT ALWAYS A STRING, and String() on the other shapes printed the least useful
    // sentence a terminal can show: "preview: [object Object]". Seen live, right before he approved
    // a step he could not see. The plan shape carries {steps:[{tool,label}]} and a message draft
    // carries its own fields; anything else is shown as compact JSON rather than as nothing.
    if (j.confirm.preview) note('preview: ' + previewText(j.confirm.preview));
    const yes = await askYesNo('   ' + AMBER + 'go ahead?' + R + STEEL + ' [y/N] ' + R, rl);
    const r = await api('POST', '/api/agent/confirm', { id: j.confirm.id, approve: yes });
    return present(r, rl);
  }
  if (j.confirm && (j.confirm.tool || j.confirm.type)) {
    const yes = await askYesNo('   ' + AMBER + 'go ahead?' + R + STEEL + ' [y/N] ' + R, rl);
    if (!yes) return note('left it alone.');
    // Exactly what the web UI posts, so one action cannot behave differently depending on which
    // client approved it.
    const r = j.confirm.tool
      ? await api('POST', '/api/tool', { tool: j.confirm.tool, args: j.confirm.args, confirmed: true })
      : await api('POST', '/api/action', { type: j.confirm.type, target: j.confirm.target, confirmed: true });
    return present(r, rl);
  }

  if (j.agentClarify && j.agentClarify.id) {
    const opts = j.agentClarify.options || [];
    opts.forEach((o, i) => note('  ' + (i + 1) + ') ' + o));
    const pick = await askLine('   ' + AMBER + 'which one?' + R + STEEL + ' [1-' + opts.length + ', or blank to cancel] ' + R, rl);
    const n = Number(pick) - 1;
    if (!(n >= 0 && n < opts.length)) return note('cancelled.');
    const r = await api('POST', '/api/agent/clarify', { id: j.agentClarify.id, choice: n });
    return present(r, rl);
  }

  if (j.undo) note('(say “undo” to reverse that)');
}

// A question asked mid-answer, using the SAME readline instance — a second one stealing stdin is
// how a terminal ends up echoing every keystroke twice.
function askLine(prompt, rl) {
  return new Promise(resolve => {
    if (!rl) return resolve('');
    rl.question(prompt, a => resolve(String(a || '').trim()));
  });
}
async function askYesNo(prompt, rl) {
  const a = (await askLine(prompt, rl)).toLowerCase();
  return a === 'y' || a === 'yes';
}

function reachError(e) {
  const m = String((e && e.message) || e);
  if (/ECONNREFUSED/.test(m)) {
    return 'JARVIS is not answering on ' + HOST + ':' + PORT + '.\n   Start him with:  launchctl kickstart -k gui/$(id -u)/com.atharv.jarvisos';
  }
  if (/timed out/i.test(m)) return 'That took longer than I was willing to wait. He may still be working — try “/steps”.';
  return m;
}

// ---------------- status line ----------------
// The same numbers the ambient dashboard shows, because /api/overview already gathers them and a
// status bar that only says "online" is a status bar not worth the row it occupies.
async function status() {
  const t = token();
  if (!t) return { line: RED + MARGIN + '✗ no API token at ' + TOKEN_FILE + R };
  try {
    const j = await api('GET', '/api/overview', null, 4000);
    if (j && j.error) throw new Error(j.error);
    const s = (j && j.stats) || {};
    const agents = (j && j.agents) || [];
    const up = agents.filter(a => a.running).length;
    const bits = [BLUES[5] + '● online' + R];
    if (agents.length) bits.push(tint(up === agents.length ? 'ok' : 'warn', up + '/' + agents.length + ' agents'));
    if (s.cpu != null) bits.push(tint(s.cpu > 85 ? 'warn' : 'ok', 'cpu ' + Math.round(s.cpu) + '%'));
    if (s.ramPct != null) bits.push(tint(s.ramPct > 90 ? 'warn' : 'ok', 'ram ' + Math.round(s.ramPct) + '%'));
    if (s.batteryPct != null) {
      bits.push(tint(s.batteryPct <= 20 && !s.charging ? 'warn' : 'ok',
        (s.charging ? '⚡' : '') + 'batt ' + Math.round(s.batteryPct) + '%'));
    }
    const w = j && j.weather;
    if (w && w.temp != null) bits.push(STEEL + Math.round(w.temp) + '°' + (w.unit || '') + R);
    return { line: MARGIN + bits.join(STEEL + ' · ' + R) };
  } catch (e) {
    return { line: RED + MARGIN + '○ offline' + R + STEEL + '  —  launchctl kickstart -k gui/$(id -u)/com.atharv.jarvisos' + R };
  }
}
const tint = (k, s) => (k === 'warn' ? AMBER : STEEL) + s + R;

// ---------------- commands ----------------
// Clearing the client-side thread is the whole of it: the server keeps no history between calls
// (each request posts the transcript), so there is nothing on the other end to reset.
function newChat() {
  convo.length = 0;
  note('new conversation — nothing from before this line is in his context.');
}

const HELP = [
  ['/help', 'this'],
  ['/think', 'Think hard on the next question (or: /think <question>) — slow, careful'],
  ['/brief', 'the briefing: calendar, schedule, battery, disk, weather'],
  ['/capture', 'screenshot → he looks at it  (/capture [--display N] [question])'],
  ['/attach', 'send an image  (/attach <path> [question])'],
  ['/focus', 'Do Not Disturb  (/focus on | /focus off)'],
  ['/schedule', 'create an automation  (/schedule <what and when>)'],
  ['/new', 'start a fresh conversation  (or ctrl-n)'],
  ['/stop', 'stop whatever he is doing'],
  ['/steps', 'what he did on the last run'],
  ['/clear', 'clear the screen'],
  ['/quit', 'leave (or ctrl-D)'],
];

// THE APP'S BUTTONS, AS COMMANDS (2026-10-14). Each posts exactly what the web UI's button posts — Think hard and
// Briefing are flags on the chat request (thinkHard, brief), Capture and Attach send images the same way, Focus is
// /api/dnd and /schedule is /api/automations — so the server cannot tell which client asked, and nothing is
// decided here. The command word is the CLI's own syntax; nothing he types in a sentence is read by this.
const BRIEF_TEXT = 'Give me my briefing: system health, what’s scheduled, anything that needs me.';
const MAX_SIDE = 1100;   // the web UI shrinks an attached image to 1100 px on its longer side (shrinkImage); same here
function imageDataUrl(file) {
  // sips ships with macOS: resize and re-encode without a dependency. It refuses a file that is not an image.
  const tmp = path.join(os.tmpdir(), 'jarvis-attach-' + process.pid + '-' + Date.now() + '.jpg');
  try {
    execFileSync('/usr/bin/sips', ['-Z', String(MAX_SIDE), '-s', 'format', 'jpeg', file, '--out', tmp], { stdio: 'ignore' });
    return 'data:image/jpeg;base64,' + fs.readFileSync(tmp).toString('base64');
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}
// "/attach <path> [question]" — a path with spaces goes in quotes, or is dragged in (the terminal escapes spaces).
function splitPathArg(arg) {
  let p, rest;
  if (arg[0] === '"' || arg[0] === "'") { const e = arg.indexOf(arg[0], 1); p = arg.slice(1, e < 0 ? undefined : e); rest = e < 0 ? '' : arg.slice(e + 1); }
  else { const m = arg.match(/^((?:\\ |\S)+)\s*([\s\S]*)$/); p = m ? m[1].replace(/\\ /g, ' ') : arg; rest = m ? m[2] : ''; }
  if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
  return { file: p, question: rest.trim() };
}

async function command(line, rl) {
  const raw = line.trim();
  const sp = raw.search(/\s/);
  const c = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase();
  const arg = sp < 0 ? '' : raw.slice(sp + 1).trim();
  if (c === '/think') {
    if (!arg) { thinkNext = !thinkNext; note(thinkNext ? 'Think hard is on for your next question — it can take a few minutes.' : 'Think hard is off.'); return true; }
    await ask(arg, rl, { thinkHard: true });
    return true;
  }
  if (c === '/brief') { await ask(BRIEF_TEXT, rl, { brief: true }); return true; }
  if (c === '/capture') {
    let rest = arg, display = null;
    const m = rest.match(/^--display\s+(\d+)\s*([\s\S]*)$/);   // the CLI's own flag, like any command-line option
    if (m) { display = Number(m[1]); rest = m[2]; }
    note('capturing screen…');
    let r;
    try { r = await api('POST', '/api/capture', display ? { display } : {}, 30000); } catch (e) { bad(reachError(e)); return true; }
    if (!r || !r.dataUrl) { bad('could not capture the screen — ' + ((r && r.error) || 'no image came back') + ' (Screen Recording permission?)'); return true; }
    await ask(rest || 'Here is my screen. What am I looking at? Anything notable?', rl,
      { images: [{ dataUrl: r.dataUrl, label: 'Screenshot of the user’s screen (' + (display ? 'display ' + display : 'Main Display') + ')' }] });
    return true;
  }
  if (c === '/attach') {
    if (!arg) { note('usage: /attach <path to an image> [question]'); return true; }
    const { file, question } = splitPathArg(arg);
    if (!fs.existsSync(file)) { bad('no such file: ' + file); return true; }
    let dataUrl;
    try { dataUrl = imageDataUrl(file); } catch (e) { bad('that is not an image macOS can read: ' + path.basename(file)); return true; }
    await ask(question || 'What is in this image?', rl, { images: [{ dataUrl, label: path.basename(file) }] });
    return true;
  }
  if (c === '/focus') {
    const a = arg.toLowerCase();
    if (a !== 'on' && a !== 'off') { note('usage: /focus on  or  /focus off'); return true; }
    try {
      const r = await api('POST', '/api/dnd', { on: a === 'on' }, 15000);
      if (r && r.ok) note(a === 'on' ? 'Focus mode engaged — Do Not Disturb on.' : 'Focus mode off.');
      else bad((r && r.error) || 'Focus toggle failed.');
    } catch (e) { bad(reachError(e)); }
    return true;
  }
  if (c === '/schedule') {
    if (!arg) { note('usage: /schedule standup reminder tomorrow at 9am'); return true; }
    try {
      const r = await api('POST', '/api/automations', { text: arg }, 30000);
      if (r && r.error) bad(r.error); else await jarvisSays((r && r.say) || 'Could not schedule that.');
    } catch (e) { bad(reachError(e)); }
    return true;
  }
  if (c === '/help' || c === '/?') {
    process.stdout.write('\n');
    for (const [k, v] of HELP) note(BLUES[4] + k.padEnd(10) + R + STEEL + v + R);
    process.stdout.write('\n');
    return true;
  }
  if (c === '/new') { newChat(); return true; }
  if (c === '/clear') { process.stdout.write('\x1b[2J\x1b[H'); return true; }
  if (c === '/stop') {
    try { await api('POST', '/api/stop', {}, 5000); note('told him to stop.'); }
    catch (e) { bad(reachError(e)); }
    return true;
  }
  if (c === '/steps') {
    try {
      const j = await api('GET', '/api/progress?after=0', null, 5000);
      const steps = (j && j.steps) || [];
      if (!steps.length) note('nothing on the last run.');
      else steps.forEach((s, i) => note((i + 1) + '. ' + s.t));
    } catch (e) { bad(reachError(e)); }
    return true;
  }
  if (c === '/quit' || c === '/exit' || c === '/q') { process.exit(0); }
  return false;
}

// ---------------- main ----------------
async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--no-color');

  // One-shot: `jarvis "open textedit"`. Prints the answer and exits, so it composes with other
  // shell tools instead of demanding a session.
  if (args.length) {
    const j = await api('POST', '/api/chat', { messages: [{ role: 'user', content: args.join(' ') }], via: 'typed' })
      .catch(e => ({ error: reachError(e) }));
    // No readline in one-shot mode: a confirm would have nothing to read an answer from, so it is
    // reported rather than silently approved. Approving on his behalf is the one thing this must
    // never do.
    if (j && j.confirm) {
      await jarvisSays(j.reply || '');
      warn('that needs approval — run `jarvis` and ask again to confirm it.');
      process.exit(1);
    }
    if (j && j.error) { bad(String(j.error)); process.exit(1); }
    await jarvisSays((j && (j.reply || j.say)) || '(no answer)');
    process.exit(0);
  }

  // Piped input: `echo "what is on my calendar" | jarvis`
  if (!process.stdin.isTTY) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    for await (const c of process.stdin) buf += c;
    if (buf.trim()) {
      const j = await api('POST', '/api/chat', { messages: [{ role: 'user', content: buf.trim() }], via: 'typed' })
        .catch(e => ({ error: reachError(e) }));
      if (j && j.error) { bad(String(j.error)); process.exit(1); }
      process.stdout.write(((j && (j.reply || j.say)) || '') + '\n');
    }
    process.exit(0);
  }

  // readline is attached BEFORE the status fetch, and anything typed during it is queued rather
  // than dropped. Fetching first and attaching second loses whatever was typed or pasted in that
  // window — a small window on a fast reply, and a long one when the server is the thing that is
  // slow, which is exactly when he is most likely to be impatiently typing.
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: BLUES[4] + '  ◆ ' + R,
    historySize: 200,
  });
  let booting = true;
  const queued = [];

  // Ctrl-C cancels the RUN, it does not quit. Killing the client while the server is halfway
  // through an agentic goal leaves the goal running with nobody watching it — so the first press
  // stops the work, and only a second one on an idle prompt leaves.
  let armed = false;
  rl.on('SIGINT', async () => {
    if (inFlight) {
      process.stdout.write('\r\x1b[2K');
      note('stopping…');
      try { await api('POST', '/api/stop', {}, 5000); } catch (e) {}
      return;
    }
    if (armed) { process.stdout.write('\n'); process.exit(0); }
    armed = true;
    process.stdout.write('\r\x1b[2K' + STEEL + '   (ctrl-c again to leave)' + R + '\n');
    rl.prompt();
    setTimeout(() => { armed = false; }, 2000);
  });

  async function handle(text) {
    armed = false;
    if (text.startsWith('/')) {
      if (await command(text, rl)) return;
    }
    try { await ask(text, rl); }
    catch (e) { bad(String((e && e.message) || e)); }
  }

  // ctrl-n starts a fresh conversation without breaking off to type a command. readline binds
  // ctrl-n to next-history by default, so the line buffer is cleared explicitly afterwards —
  // otherwise the keypress ALSO pulls a history entry in behind the new prompt.
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (ch, key) => {
    if (!key || !key.ctrl || key.name !== 'n') return;
    if (inFlight) { note('busy — ctrl-c first if you want to stop that.'); return; }
    process.stdout.write('\r\x1b[2K');
    newChat();
    rl.line = ''; rl.cursor = 0;
    rl.prompt();
  });

  rl.on('line', async line => {
    const text = line.trim();
    if (!text) return booting ? undefined : rl.prompt();
    if (booting) { queued.push(text); return; }
    await handle(text);
    rl.prompt();
  });
  // Leaving during boot must still run what was already typed. Exiting the instant stdin closes
  // discards the queue — which is what happens to anything piped in, and to a fast ctrl-D.
  let closed = false;
  const goodbye = () => { process.stdout.write(STEEL + '\n   Goodbye, Sir.\n\n' + R); process.exit(0); };
  rl.on('close', () => { if (booting) { closed = true; return; } goodbye(); });

  // Only NOW is the status fetched — with the handlers already live, so anything typed or pasted
  // while it is in flight lands in `queued` instead of on the floor.
  await showBanner(await status(), rl);
  booting = false;
  for (const q of queued.splice(0)) await handle(q);
  if (closed) return goodbye();
  rl.prompt();
}

main().catch(e => { bad(String((e && e.stack) || e)); process.exit(1); });
