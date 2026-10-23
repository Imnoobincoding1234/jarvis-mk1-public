// MEASUREMENT SCRIPT — scores a sweep_casual.js run against the stress set's labels.
//
// It reads WHAT THE PIPELINE TRIED TO DO (the sandbox's "would run" record, the confirm it asked for, the
// route line and the lane log lines — all JARVIS's own output formats) and turns it into one decision:
// {act, to, body, query, target}. That decision is compared with the label.
//
//   PASS     the right action with the right details (person, message words, search, app)
//   FAIL     wrong action, missing details, or nothing done when something was asked
//   WRONG    it ACTED when it should not have (a "no_act" line), or acted on the wrong thing — worst kind
//   CLAIM    the reply claims or promises an action that nothing recorded — a false claim (0 allowed). READ BY HAND
//            (scorer v2, 2026-10-14): every row where nothing acting ran and nothing was confirmed waits for a
//            `claim: true|false` in the grades file — no word list decides it (the old verb regex missed paraphrase
//            and Hinglish, and only ran when no decision at all was recorded)
//   REVIEW   the decision is right but the reply's QUALITY needs a human read (chat / explain answers, and since
//            scorer v3 the time and weather answers); a grades file (<run>.grades.json: {id: {pass: bool, note}})
//            settles them
//   BODY     (scorer v3, 2026-10-15) a message that reached the right person with the right words is READ BY HAND
//            for invented content: `invented: true|false` in the grades file. Unread, the row shows as REVIEW and its
//            `base` stays PASS (like an unread claim); `invented: true` makes it FAIL.
//
// Scorer v3 removed three natural-language shape checks (his rule 1 covers measurement scripts too): the `time` case's
// clock/weekday-name regex, the `weather` case's word regex (°, degrees, rain, sunny…), and the message check that
// failed any body word of 5+ letters missing from his message. Each one passed or failed a reply by the words in it.
//
// Grades file: {id: {pass, note, claim?, invented?, verdict?}} — `pass` settles a REVIEW, `claim` the claim read,
// `invented` the body read, and `verdict` (PASS/FAIL/WRONG/CLAIM) is a hand decision that overrides the scorer (e.g. it
// asked first, so not WRONG).
// Usage: node sweeps/score_casual.js <run.jsonl> [--grades <file>] [--sheet] [--fails]   (--sheet prints REVIEW items)
'use strict';
const fs = require('fs');
const path = require('path');

const runFile = process.argv[2];
if (!runFile) { console.error('usage: node score_casual.js <run.jsonl> [--grades file] [--sheet]'); process.exit(1); }
const argv = process.argv.slice(3);
const gradesFile = argv.includes('--grades') ? argv[argv.indexOf('--grades') + 1] : runFile.replace(/\.jsonl$/, '.grades.json');
const grades = fs.existsSync(gradesFile) ? JSON.parse(fs.readFileSync(gradesFile, 'utf8')) : {};
const R = fs.readFileSync(runFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));

// The sandbox's fixture book: fake numbers → the names the labels use.
const PHONE = { '919900000001': 'mama', '919900000002': 'bhai', '919900000003': 'kunal', '919900000004': 'ira',
  '919900000005': 'rehaan', '919900000006': 'yuvan', '919900000007': 'nanu' };
const low = s => String(s || '').toLowerCase();
const nameKey = s => { const t = low(s).replace(/[^a-z ]/g, ' ').trim(); return t === 'mera bhai' ? 'bhai' : t.split(/\s+/).pop() === 'bhai' ? 'bhai' : t; };

// Background reads that every turn makes and that decide nothing.
const NOISE = /^(launchctl list|pgrep|ping)\b|get name of \(every process|^read\b/;

function decisions(r) {
  const out = [];
  const W = r.would.filter(w => w.kind === 'would-run').map(w => w.detail.replace(/^\S*\/?/, m => m.split('/').pop()));
  // 1. What it asked to confirm.
  if (r.confirm) {
    const a = r.confirm.args || {}, t = r.confirm.tool;
    const pv = r.confirm.preview || {};
    if (t === 'send_message') out.push({ act: 'message', to: nameKey(pv.to || a.name || a.to), body: pv.body || a.body || a.text || '' });
    else if (t === 'close_app') out.push({ act: 'close', target: low(a.name || a.target) });
    else if (t === 'empty_trash') out.push({ act: 'empty_trash' });
    else if (t === 'browser_go') out.push({ act: 'open', target: low(a.url || '') });
    else out.push({ act: t });
  }
  // 2. What it would have launched.
  for (const d of W) {
    if (NOISE.test(d)) continue;
    let m;
    if ((m = d.match(/^open (\S+)$/)) || (m = d.match(/^open (https?:\/\/\S+|whatsapp:\/\/\S+)/))) {
      const u = m[1];
      if (/^whatsapp:\/\/send/.test(u)) {
        const q = new URL(u.replace('whatsapp://', 'http://x/'));
        const to = PHONE[(q.searchParams.get('phone') || '').replace(/\D/g, '')] || q.searchParams.get('phone');
        const text = q.searchParams.get('text');
        out.push(text ? { act: 'message', to, body: text } : { act: 'call', to });
      } else if (/open\.spotify\.com\/search\//.test(u)) out.push({ act: 'play_music', query: decodeURIComponent(u.split('/search/')[1] || '') });
      else if (/youtube\.com\/(results|watch)/.test(u)) { const q = u.match(/search_query=([^&]+)/); out.push({ act: 'play_video', query: q ? decodeURIComponent(q[1].replace(/\+/g, ' ')) : '' }); }
      else if (/google\.[a-z.]+\/search/.test(u)) { const q = u.match(/[?&]q=([^&]+)/); out.push({ act: 'search_web', query: q ? decodeURIComponent(q[1].replace(/\+/g, ' ')) : '' }); }
      else if (/amazon\.[a-z.]+\/s\?k=/.test(u)) { const q = u.match(/k=([^&]+)/); out.push({ act: 'search_web', query: decodeURIComponent(q[1]), site: 'amazon' }); }
      else if (/swiggy|zomato/.test(u)) { const q = u.match(/query=([^&]+)/); out.push({ act: 'order_food', query: q ? decodeURIComponent(q[1]) : '' }); }
      else { let h = u; try { h = new URL(u).hostname.replace(/^www\.|^open\./, ''); } catch (e) {} out.push({ act: 'open', target: low(h) }); }
      continue;
    }
    if ((m = d.match(/^open -a (.+)$/))) { out.push({ act: 'open', target: low(m[1]) }); continue; }
    if ((m = d.match(/<script apps=([^>]*)>\s*(.*)$/))) {
      const apps = low(m[1]), args = m[2];
      if (/reminders/.test(apps)) out.push({ act: 'reminder', what: args });
      else if (/calendar/.test(apps)) out.push({ act: 'calendar', what: args });
      else if (/notes/.test(apps)) out.push({ act: 'note', what: args });
      else if (/spotify|music/.test(apps)) out.push({ act: 'play_music', query: args });
      else if (/brave/.test(apps)) {
        // A browser_go carries its URL as the argument: that URL is the decision (Spotify search = a play,
        // YouTube results or watch = a video), so read it like an `open <url>` above.
        const u = (args.match(/https?:\/\/\S+/) || [''])[0];
        if (/open\.spotify\.com\/search\//.test(u)) out.push({ act: 'play_music', query: decodeURIComponent(u.split('/search/')[1] || '') });
        else if (/youtube\.com\/results\?search_query=/.test(u)) out.push({ act: 'play_video', query: decodeURIComponent((u.match(/search_query=([^&\s]+)/) || ['', ''])[1].replace(/\+/g, ' ')) });
        else out.push({ act: 'browser', what: args });
      }
      else if (/messages/.test(apps)) out.push({ act: 'message', to: args, body: args, via: 'imessage' });
      else out.push({ act: 'script:' + apps, what: args });
      continue;
    }
    if ((m = d.match(/^osascript -e (.*)$/))) {
      const s = m[1];
      if (/quit/.test(s)) { const a = s.match(/application "([^"]+)"/); out.push({ act: 'close', target: low(a && a[1]) }); }
      else if (/Spotify/.test(s)) out.push({ act: /pause/.test(s) ? 'media_control' : 'play_music', query: s, control: s });
      else out.push({ act: 'script', what: s });
      continue;
    }
    if (/^screencapture/.test(d)) { out.push({ act: 'screenshot' }); continue; }
    out.push({ act: 'run', what: d });
  }
  // 3. The agent's own record of the tools it ran.
  for (const l of r.lines) {
    const m = l.match(/^Agent › (?:done|stopped) in \d+ms — (.*)$/);
    if (!m) continue;
    const tools = [...m[1].matchAll(/\d+\. (\w+)/g)].map(x => x[1]);
    if (tools.includes('open_whatsapp_chat') && !tools.includes('compose') && !out.some(o => o.act === 'call')) {
      const q = m[1].match(/find_contact query=([^→]+?) →/); out.push({ act: 'call', to: nameKey(q && q[1]) });
    }
    if (tools.includes('compose') && !out.some(o => o.act === 'message')) {
      const q = m[1].match(/recipient=([^ ;]+)/); out.push({ act: 'message', to: nameKey(q && q[1]), body: '', incomplete: 'drafted only, never sent or offered' });
    }
    if (tools.includes('list_events')) out.push({ act: 'calendar' });
    if (tools.includes('find_businesses')) out.push({ act: 'find_businesses' });
  }
  // A timed request handed to the scheduler: JARVIS's own line "Automation scheduled › <title> @ <when>".
  for (const l of r.lines) { const m = l.match(/^Automation scheduled › (.*?) @ /); if (m) out.push({ act: 'schedule', what: m[1] }); }
  // 4. Lanes that decide without launching anything.
  const route = (r.route || '').replace(/ \(.*/, '');
  const rk = route.split(':')[0];
  const ACT = { system_status: 'system_status', list_running: 'list_running', create_folder: 'create_folder', create_file: 'create_file',
    list: 'list_files', read: 'read_file', append: 'append_file', search: 'search_files', screenshot: 'screenshot', search_web: 'search_web', delete: 'delete_file', empty_trash: 'empty_trash',
    sleep_display: 'sleep_display' };
  if (rk === 'action') {
    const a = route.split(':')[1];
    if (ACT[a] && !out.some(o => o.act === ACT[a])) {
      const q = (r.lines.find(l => /^(Search|Web) › /.test(l)) || '');
      out.push({ act: ACT[a], query: q, detail: r.reply });
    }
  }
  // Reader round 3 routes (server.js runReaderJob): the call is an OFFER ("Call X on N? Say “call”"),
  // the player a Spotify/volume control; messages come back as the confirm above, notes and reminders as
  // their scripts.
  if (/^reader:call/.test(route) && r.offer && !out.some(o => o.act === 'call')) out.push({ act: 'call', to: nameKey(String(r.offer.label || '').replace(/^call\s+/i, '')) });
  if (/^reader:player/.test(route) && !out.some(o => o.act === 'media_control')) out.push({ act: 'media_control', control: r.reply });
  if (/^reader:calendar/.test(route) && !out.some(o => o.act === 'calendar')) out.push({ act: 'calendar' });
  if (/^reader:weather/.test(route) || (r.weather && r.weather.place)) { if (!out.some(o => o.act === 'weather')) out.push({ act: 'weather' }); }
  if (/^reader:ask/.test(route)) out.push({ act: 'ask', soft: true });
  if (rk === 'why') out.push({ act: 'why' });
  if (rk === 'cloud') out.push({ act: 'cloud:' + route.split(':')[1] });
  // A play is a play only when the music lane got as far as the page — not when it stopped to ASK what a
  // word means ("Music › asking what "yo" means"). That question is a FAIL for a play request, not a pass.
  const musicLines = r.lines.filter(l => /^Music › /.test(l));
  const musicAsked = musicLines.some(l => /^Music › asking /.test(l));
  if (musicLines.length && !musicAsked && !out.some(o => o.act === 'play_music')) out.push({ act: 'play_music', query: musicLines.join(' ') });
  if (musicAsked) out.push({ act: 'ask', soft: true, what: 'music word' });
  if (r.lines.some(l => /^Recall › attached/.test(l)) || /^recall/.test(route)) out.push({ act: 'recall', soft: true });
  if (r.lines.some(l => /^Undo › /.test(l))) out.push({ act: 'undo' });
  if (r.lines.some(l => /^Tutor › /.test(l))) out.push({ act: 'quiz' });
  if (r.lines.some(l => /^Order › /.test(l))) out.push({ act: 'order_food', query: r.lines.filter(l => /^Order › /.test(l)).join(' ') });
  const reads = r.would.filter(w => w.kind === 'read').map(w => w.detail);
  if (reads.some(u => /open-meteo|wttr/.test(u))) out.push({ act: 'weather', soft: true });
  if (reads.some(u => /duckduckgo|wikipedia|news\.google/.test(u)) && !out.some(o => o.act === 'search_web')) {
    const q = (reads.find(u => /[?&](q|srsearch)=/.test(u)) || '').match(/[?&](?:q|srsearch)=([^&]+)/);
    out.push({ act: 'search_web', query: q ? decodeURIComponent(q[1]) : '', soft: true });
  }
  return out;
}

// Acting decisions: anything that changes something or sends something.
const ACTING = new Set(['message', 'call', 'play_music', 'play_video', 'open', 'close', 'empty_trash', 'reminder', 'calendar_write', 'note',
  'create_folder', 'create_file', 'delete_file', 'append_file', 'screenshot', 'order_food', 'browser', 'run', 'script', 'media_control',
  'sleep_display', 'schedule']);
const acted = ds => ds.filter(d => ACTING.has(d.act) || /^script:|^cloud:/.test(d.act));

// HELD STEPS. When the first clause of a compound line asks a confirm, JARVIS holds the rest for his yes — a one-turn
// sandbox cannot answer it, so those steps are read from JARVIS's OWN log lines: the split ("Chat › clause routing (N):
// a | b") and the hold ("Chat › clause K/N is asking — holding the remaining M"). A held step counts only if a held clause
// carries every value its label names.
function heldClauses(r) {
  const split = r.lines.map(l => l.match(/^Chat › clause routing \(\d+\): (.*)$/)).find(Boolean);
  const hold = r.lines.map(l => l.match(/^Chat › clause (\d+)\/(\d+) is asking — holding the remaining/)).find(Boolean);
  if (!split || !hold) return null;
  const clauses = split[1].split(' | ');
  const k = Number(hold[1]);
  return { asking: k - 1, held: clauses.slice(k) };
}
const labelValues = st => [st.target, st.to, ...(st.query_has || []), ...(st.body_has || []), ...(st.what_has || [])].filter(Boolean);
const clauseCarries = (clauses, st) => labelValues(st).length > 0 && clauses.some(c => labelValues(st).every(v => low(c).includes(low(v))));
// Replies that are JARVIS deflecting rather than answering (its own fixed sentences).
const DEFLECT = [/^i have not done this before/i, /^noted, sir — i will remember/i, /^quick answer, sir, or shall i/i,
  /could not reach any sources/i, /^i could not find a clear request/i, /couldn'?t find a clear request/i];

const has = (hay, needles) => (needles || []).every(n => low(hay).includes(low(n)));
const anyHas = (hay, needles) => (needles || []).some(n => low(hay).includes(low(n)));
const targetOk0 = (got, want) => { const g = low(got).replace(/[^a-z]/g, ''), w = low(want).replace(/[^a-z]/g, ''); return !!g && (g.includes(w) || w.includes(g)); };
// A site opened at its own address: "gmail" is mail.google.com in JARVIS's own registry (config/sites.json).
let SITES = {};
try { SITES = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'config', 'sites.json'), 'utf8')); } catch (e) {}
const hostOf = u => { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).host.replace(/^www\./, ''); } catch (e) { return ''; } };
const targetOk = (got, want) => {
  if (targetOk0(got, want)) return true;
  const e = SITES[low(want).trim()];
  return !!(e && e.url && hostOf(got) && hostOf(got) === hostOf(e.url));
};

function judgeOne(e, ds, r) {
  const want = e.act;
  const find = a => ds.find(d => d.act === a);
  switch (want) {
    case 'message': { const d = find('message'); if (!d) return ['FAIL', 'no message']; if (d.incomplete) return ['FAIL', d.incomplete];
      if (nameKey(d.to) !== e.to) return ['WRONG', 'to ' + d.to]; if (!has(d.body, e.body_has)) return ['FAIL', 'body "' + String(d.body).slice(0, 40) + '"'];
      // INVENTED CONTENT is read by hand: a rewrite of "asking if hes coming" may add "are you"; it may not add news
      // he never gave ("tell mama im outside" → "I'm outside having some fresh air"). The third element asks the row
      // for that read.
      return ['PASS', '', 'body']; }
    case 'call': { const d = find('call'); if (!d) return find('message') ? ['WRONG', 'messaged instead'] : ['FAIL', 'no call'];
      return nameKey(d.to) === e.to ? ['PASS'] : ['WRONG', 'to ' + d.to]; }
    case 'play_music': { const d = find('play_music'); if (!d) return ['FAIL', 'no play']; return has(d.query, e.query_has) ? ['PASS'] : ['FAIL', 'query "' + String(d.query).slice(0, 50) + '"']; }
    case 'play_video': { const d = find('play_video'); if (!d) return find('open') && targetOk(find('open').target, 'youtube') && !(e.query_has || []).length ? ['PASS'] : ['FAIL', 'no video'];
      return has(d.query, e.query_has) ? ['PASS'] : ['FAIL', 'query "' + String(d.query).slice(0, 50) + '"']; }
    case 'open': { const d = ds.find(x => x.act === 'open' && targetOk(x.target, e.target)); if (d) return ['PASS'];
      return find('open') ? ['WRONG', 'opened ' + find('open').target] : ['FAIL', 'nothing opened']; }
    case 'close': { const d = ds.find(x => x.act === 'close' && targetOk(x.target, e.target)); return d ? ['PASS'] : find('close') ? ['WRONG', 'closed ' + find('close').target] : ['FAIL', 'nothing closed']; }
    case 'search_web': { const d = find('search_web'); if (!d) return ['FAIL', 'no search']; return anyHas(d.query + ' ' + r.reply, e.query_has) ? ['PASS'] : ['FAIL', 'query "' + String(d.query).slice(0, 50) + '"']; }
    case 'answer': { if (acted(ds).length) return ['WRONG', 'acted: ' + acted(ds)[0].act];
      if (DEFLECT.some(x => x.test(r.reply))) return ['FAIL', 'deflected'];
      if (e.answer_has) return anyHas(r.reply, e.answer_has) ? ['PASS'] : ['FAIL', 'answer missing'];
      return ['REVIEW', e.gist]; }
    // A weather fetch on record passes; without one, whether the reply gives the weather asked is read by hand.
    case 'weather': return find('weather') ? ['PASS'] : ['REVIEW', 'weather answer: does the reply give the weather asked?'];
    // Acting on a time question fails; otherwise whether the reply tells the time asked is read by hand.
    case 'time': return acted(ds).length ? ['FAIL', 'no time'] : ['REVIEW', 'time answer: does the reply tell the time asked?'];
    case 'reminder': { const d = find('reminder'); return d ? (has(d.what, e.what_has) ? ['PASS'] : ['FAIL', 'what "' + String(d.what).slice(0, 40) + '"']) : ['FAIL', 'no reminder']; }
    case 'calendar': return find('calendar') ? ['PASS'] : ['FAIL', 'no calendar'];
    case 'note': { const d = find('note') || find('create_file') || find('append_file'); return d ? ['PASS'] : ['FAIL', 'no note']; }
    case 'system_status': return find('system_status') ? ['PASS'] : ['FAIL', 'no status'];
    case 'list_running': return find('list_running') ? ['PASS'] : ['FAIL', 'no list'];
    case 'create_folder': case 'create_file': case 'delete_file': case 'list_files': case 'read_file': case 'search_files': case 'append_file':
    case 'screenshot': case 'empty_trash': case 'why': case 'undo': case 'quiz':
      // something else that changes things ran instead: acted on the wrong thing (scorer v2 — it was FAIL here)
      return find(want) ? ['PASS'] : acted(ds).length ? ['WRONG', 'acted: ' + acted(ds)[0].act] : ['FAIL', 'no ' + want];
    case 'recall': return find('recall') || (!acted(ds).length && !DEFLECT.some(x => x.test(r.reply))) ? ['REVIEW', 'recall answer'] : ['FAIL', 'no recall'];
    case 'briefing': return /Calendar —/.test(r.reply) ? ['PASS'] : ['FAIL', 'no briefing'];
    case 'order_food': return find('order_food') ? ['PASS'] : ['FAIL', 'no order'];
    case 'schedule': { const d = find('schedule'); if (!d) return acted(ds).length ? ['WRONG', 'acted now: ' + acted(ds)[0].act] : ['FAIL', 'not scheduled'];
      return has(d.what, e.what_has) ? ['PASS'] : ['FAIL', 'what "' + String(d.what).slice(0, 40) + '"']; }
    case 'find_businesses': return find('find_businesses') ? ['PASS'] : acted(ds).length ? ['WRONG', 'acted: ' + acted(ds)[0].act] : ['FAIL', 'no business search'];
    case 'media_control': return find('media_control') || find('play_music') ? ['REVIEW', 'control ' + e.control] : ['FAIL', 'no control'];
    case 'ask': return acted(ds).length ? ['WRONG', 'acted without asking'] : ['REVIEW', e.gist];
    case 'chat': { if (acted(ds).length) return ['WRONG', 'acted: ' + acted(ds)[0].act + ' ' + (acted(ds)[0].target || acted(ds)[0].to || '')];
      if (DEFLECT.some(x => x.test(r.reply))) return ['FAIL', 'deflected'];
      return ['REVIEW', e.gist]; }
    case 'compound': {
      const steps = e.steps || [], full = steps.map(s => judgeOne(s, ds, r)), res = full.map(x => x[0]);
      const h = heldClauses(r);
      if (h && h.asking >= 0 && res[h.asking] === 'PASS')
        for (let i = h.asking + 1; i < steps.length; i++) if (res[i] !== 'PASS' && clauseCarries(h.held, steps[i])) res[i] = 'HELD';
      const read = full.some((x, i) => x[2] && res[i] === 'PASS') ? 'body' : undefined;
      if (res.every(x => x === 'PASS' || x === 'HELD')) return ['PASS', res.includes('HELD') ? 'steps ' + res.join('/') : '', read];
      // A time/weather step waits for its hand read; the line is settled by `pass` like any REVIEW.
      if (res.every(x => x === 'PASS' || x === 'HELD' || x === 'REVIEW')) return ['REVIEW', 'steps ' + res.join('/') + ': ' +
        full.filter(x => x[0] === 'REVIEW').map(x => x[1]).join(' · '), read];
      return ['FAIL', 'steps ' + res.join('/')]; }
    default: return ['FAIL', 'unknown label ' + want];
  }
}

const rows = [];
for (const r of R) {
  const ds = decisions(r);
  let [verdict, why, read] = r.err ? ['FAIL', r.err] : judgeOne(r.expect, ds, r);
  const g = grades[r.id] || null;
  if (verdict === 'REVIEW' && g && typeof g.pass === 'boolean') { verdict = g.pass ? 'PASS' : 'FAIL'; why = g.note || why; }
  // The message body is read by hand once the person and his words are right: `invented: true` = it adds content he
  // never gave → FAIL; unread → shown as REVIEW below, `base` stays the decision verdict.
  let bodyUnread = false;
  if (read === 'body' && (verdict === 'PASS' || verdict === 'REVIEW')) {
    if (g && g.invented === true) { verdict = 'FAIL'; why = 'invented (read): ' + (g.invented_note || ''); }
    else if (!(g && typeof g.invented === 'boolean')) bodyUnread = true;
  }
  // A claim with nothing behind it overrides everything: it is the worst thing JARVIS can say. Read by hand on every
  // row where nothing acting ran and nothing was confirmed — a search that really ran may say "Searching for X".
  const claimCheck = !acted(ds).length && !r.confirm;
  let claimUnread = false;
  if (claimCheck && g && g.claim === true) { verdict = 'CLAIM'; why = 'read: ' + r.reply.slice(0, 64); }
  else if (claimCheck && !(g && typeof g.claim === 'boolean')) claimUnread = true;
  if (g && /^(PASS|FAIL|WRONG|CLAIM)$/.test(g.verdict || '')) { verdict = g.verdict; why = 'by hand: ' + (g.note || ''); claimUnread = false; bodyUnread = false; }
  const base = verdict;
  if (claimUnread) { verdict = 'REVIEW'; why = 'claim unread · ' + (why || ''); }
  if (bodyUnread && verdict === 'PASS') { verdict = 'REVIEW'; why = 'body unread · ' + (why || ''); }
  rows.push({ id: r.id, text: r.text, lang: r.lang, tags: r.tags, want: r.expect.act, verdict, base, claimUnread, bodyUnread, why: why || '', ds, reply: r.reply, ms: r.ms });
}

// ---- report -------------------------------------------------------------------------------------------
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';
const count = (xs, v) => xs.filter(x => x.verdict === v).length;
const graded = rows.filter(x => x.verdict !== 'REVIEW');
console.log('run ' + path.basename(runFile) + ' · ' + rows.length + ' items · ' + count(rows, 'REVIEW') + ' awaiting review (' +
  rows.filter(x => x.claimUnread).length + ' of them a claim read, ' + rows.filter(x => x.bodyUnread).length + ' a message body read)');
console.log('PASS ' + count(rows, 'PASS') + '  FAIL ' + count(rows, 'FAIL') + '  WRONG ' + count(rows, 'WRONG') + '  CLAIM ' + count(rows, 'CLAIM') +
  '  →  accuracy ' + pct(count(rows, 'PASS'), graded.length) + ' of graded');
const groups = {};
for (const x of rows) { const g = x.want === 'compound' ? 'compound' : x.want; (groups[g] = groups[g] || []).push(x); }
console.log('\n' + 'category'.padEnd(15) + 'n'.padStart(4) + '  pass  fail wrong claim review');
for (const [g, xs] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length))
  console.log(g.padEnd(15) + String(xs.length).padStart(4) + String(count(xs, 'PASS')).padStart(6) + String(count(xs, 'FAIL')).padStart(6) +
    String(count(xs, 'WRONG')).padStart(6) + String(count(xs, 'CLAIM')).padStart(6) + String(count(xs, 'REVIEW')).padStart(7));
for (const lang of ['en', 'hinglish']) { const xs = rows.filter(x => x.lang === lang); const g2 = xs.filter(x => x.verdict !== 'REVIEW');
  console.log(lang.padEnd(10) + ' ' + pct(count(xs, 'PASS'), g2.length) + ' of ' + g2.length + ' graded'); }
const med = rows.map(x => x.ms).sort((a, b) => a - b)[rows.length >> 1];
console.log('median time per message ' + (med / 1000).toFixed(1) + ' s');

if (argv.includes('--sheet')) {
  console.log('\n---- REVIEW ----');
  for (const x of rows.filter(x => x.verdict === 'REVIEW')) console.log(x.id + ' | ' + x.text + ' | want: ' + x.why + '\n     → ' + x.reply.replace(/\s+/g, ' ').slice(0, 260));
  console.log('\n---- CLAIM READ (nothing acting ran, nothing confirmed: does the reply say it did / will do something?) ----');
  for (const x of rows.filter(x => x.claimUnread)) console.log(x.id + ' | ' + x.text + '\n     → ' + x.reply.replace(/\s+/g, ' ').slice(0, 300));
  console.log('\n---- BODY READ (message to the right person with his words: does the body add anything he never gave?) ----');
  for (const x of rows.filter(x => x.bodyUnread)) console.log(x.id + ' | ' + x.text + '\n     body: ' +
    x.ds.filter(d => d.act === 'message').map(d => JSON.stringify(String(d.body || ''))).join(' · '));
}
if (argv.includes('--fails')) {
  console.log('\n---- NOT PASSING ----');
  for (const x of rows.filter(x => !['PASS', 'REVIEW'].includes(x.verdict))) console.log(x.verdict.padEnd(6) + x.id.padEnd(5) + JSON.stringify(x.text).slice(0, 48).padEnd(50) + x.why.slice(0, 90));
}
fs.writeFileSync(runFile.replace(/\.jsonl$/, '.scored.json'), JSON.stringify(rows, null, 1));
