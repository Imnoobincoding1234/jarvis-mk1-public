'use strict';
const profile = require('./profile');   // who the user is — see profile.userRef()/userLabel()
// ---------------------------------------------------------------------------
// JARVIS agent layer — multi-step goals ("at 6pm message mama asking about her
// health", "open notes and write a passage about food").
//
// Three pieces:
//   1. PRIMITIVES  — new macOS app tools (Messages/Notes/Reminders/Calendar/
//                    Contacts) plus `compose`, which writes text with the LLM.
//   2. PLANNER     — turns a goal into an ordered list of whitelisted steps.
//                    Deterministic patterns first (work with Ollama down), LLM
//                    fallback for anything fuzzier — same philosophy as
//                    quickAction/classifyAction in server.js.
//   3. EXECUTOR    — runs the steps, threading each result into the next via
//                    {{n.field}} references, pausing at any step that needs
//                    confirmation.
//
// SAFETY. Every value reaching AppleScript is passed as an *argv item* to a JXA
// script (`function run(argv)`), never interpolated into script source — so a
// message body containing quotes or `" & do shell script "` is inert data. The
// tool list is a closed whitelist; the planner can only name tools in it, and
// its output is re-validated here before anything executes. Outbound actions
// (sending a message) always stop for confirmation unless the user has
// explicitly opted in via JARVIS_AUTOSEND=1 in .env.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const fs = require('fs');           // WhatsApp address-book fallback reads its SQLite file directly
const harness = require('./harness.js');   // run state, budgets, failure policy, verification rules
const intent = require('./intent.js');    // the shared embedding classifier — see intent.js
const grounded = require('./grounded.js'); // checkVerdict: a yes/no read from the answer token's probabilities (composer v2)

let deps = {
  llm: async () => { throw new Error('agent not initialised'); },
  jlog: () => {},
  audit: () => {},
  lean: () => true,
  envVal: () => '',
  runAction: async () => ({ ok: false, say: 'no runAction' }),
};
function init(d) { deps = Object.assign(deps, d || {}); }
// Server-supplied hook so a freshly created Note/Reminder/Event can be offered for undo.
let onCreated = () => {};
function registerUndo(fn) { if (typeof fn === 'function') onCreated = fn; }

// ---------------- osascript plumbing (injection-safe) ----------------
// Values always travel as argv, never inside the script text.
function jxa(script, args, timeoutMs) {
  return new Promise(resolve => {
    const argv = ['-l', 'JavaScript', '-e', script].concat((args || []).map(String));
    execFile('/usr/bin/osascript', argv, { timeout: timeoutMs || 20000, maxBuffer: 8 << 20 }, (err, out, errOut) => {
      const stderr = String(errOut || '');
      if (err) return resolve({ ok: false, err: (stderr || String(err.message || err)).replace(/\s+/g, ' ').trim().slice(0, 300), out: '' });
      resolve({ ok: true, err: '', out: String(out || '').trim() });
    });
  });
}
// Apple's TCC denials are opaque; translate the common ones into something actionable.
function humanizeOsaError(e, appName) {
  const s = String(e || '');
  if (/-1743|not authoriz|not allowed to send Apple events/i.test(s)) {
    return 'macOS is blocking JARVIS from controlling ' + appName + '. Grant it under System Settings → Privacy & Security → Automation (allow "node" to control ' + appName + '), then try again, Sir.';
  }
  if (/-600|isn.t running|not running/i.test(s)) return appName + ' would not start, Sir.';
  if (/-1728/.test(s)) return appName + ' returned nothing for that lookup, Sir.';
  return appName + ' error: ' + s.slice(0, 160);
}
const ok = (say, extra) => Object.assign({ ok: true, say }, extra || {});
const fail = say => ({ ok: false, say });
const needsConfirm = (tool, args, say, preview) => ({ ok: false, needsConfirm: true, confirm: { tool, args }, say, preview });
const autoSend = () => String(deps.envVal('JARVIS_AUTOSEND') || '').trim() === '1';

// ---------------- contacts ----------------
// Fuzzy: exact-ish first, then substring across name/nickname/company, so "mama"
// finds a contact saved as "Mama", "Mom (Mama)", or with that nickname.
// PERF: fetch each property for ALL people in one Apple Event (`people.name()` returns an array)
// rather than touching each person object individually. Per-person access is ~3 round-trips each,
// which on a 200+ card address book blew past a 25s timeout; bulk fetch is 3 events total.
// Only the handful of actual matches are then opened up for phones/emails.
const JXA_FIND_CONTACT = `function run(argv) {
  const q = String(argv[0] || '').toLowerCase().trim();
  const app = Application('Contacts');
  const people = app.people;
  let names = [], nicks = [], orgs = [];
  try { names = people.name(); } catch (e) {}
  try { nicks = people.nickname(); } catch (e) {}
  try { orgs = people.organization(); } catch (e) {}
  const hits = [];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] || '');
    const nick = String((nicks && nicks[i]) || '');
    const org = String((orgs && orgs[i]) || '');
    if (!(name + ' ' + nick + ' ' + org).toLowerCase().includes(q)) continue;
    hits.push({ i: i, name: name, nickname: nick, exact: (name.toLowerCase() === q || nick.toLowerCase() === q) ? 1 : 0 });
    if (hits.length >= 12) break;
  }
  hits.sort(function (a, b) { return b.exact - a.exact; });
  const out = [];
  for (let h = 0; h < hits.length && h < 8; h++) {
    const p = people[hits[h].i];
    const phones = [], emails = [];
    try { const ps = p.phones.value(); for (let k = 0; k < ps.length; k++) phones.push(String(ps[k])); } catch (e) {}
    try { const es = p.emails.value(); for (let k = 0; k < es.length; k++) emails.push(String(es[k])); } catch (e) {}
    out.push({ name: hits[h].name, nickname: hits[h].nickname, phones: phones, emails: emails, exact: hits[h].exact });
  }
  return JSON.stringify(out);
}`;

// A "clarify" outcome is a peer of needsConfirm: instead of pausing to approve an action, it pauses
// to ask a question. The executor (runPlan) treats both as a pause; only the resume path differs.
const needsClarify = (options, say) => ({ ok: false, needsClarify: true, options, say });

// ---------------- WhatsApp address book ----------------
// Plenty of people exist only in WhatsApp and never in Contacts.app — "message Aaditesh" failed
// outright even though the chat was open on screen. WhatsApp keeps its own address book in a
// readable SQLite file inside its group container (no TCC prompt, no scripting dictionary needed —
// verified: 169 contacts with names and WhatsApp ids).
//
// Read-only, and used ONLY as a fallback: Contacts.app stays authoritative because it carries the
// email addresses and the labels the user curated. This just stops a WhatsApp-only person from
// being invisible.
const WA_CONTACTS_DB = () => process.env.HOME +
  '/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ContactsV2.sqlite';

function waLookup(q) {
  return new Promise(resolve => {
    const db = WA_CONTACTS_DB();
    if (!fs.existsSync(db)) return resolve([]);
    // Parameterised via -cmd .param so the query text is never concatenated into SQL.
    const sql = "select ifnull(ZFULLNAME,'')||'\t'||ifnull(ZWHATSAPPID,'')||'\t'||ifnull(ZPHONENUMBER,'') " +
      'from ZWAADDRESSBOOKCONTACT where ZWHATSAPPID is not null and ZWHATSAPPID != \'\' ' +
      "and (lower(ifnull(ZFULLNAME,'')) like lower(:q) or lower(ifnull(ZGIVENNAME,'')) like lower(:q)) limit 12;";
    execFile('/usr/bin/sqlite3', ['-readonly', db, '-cmd', '.param set :q ' + JSON.stringify('%' + q + '%'), sql],
      { timeout: 8000 }, (err, out) => {
        if (err) return resolve([]);
        const rows = String(out || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
          const [name, waid, phone] = l.split('\t');
          // The WhatsApp id is the number without the +; prefer the stored phone when present.
          const digits = String(phone || waid || '').replace(/[^\d]/g, '');
          return { name: name || '(unnamed)', phone: digits ? '+' + digits : '', source: 'whatsapp' };
        }).filter(c => c.phone);
        resolve(rows);
      });
  });
}

async function find_contact(args) {
  const q = String(args.query || args.name || args.target || '').trim();
  if (!q) return fail('Who should I look up, Sir?');
  const r = await jxa(JXA_FIND_CONTACT, [q], 25000);
  if (!r.ok) return fail(humanizeOsaError(r.err, 'Contacts'));
  let list = [];
  try { list = JSON.parse(r.out || '[]'); } catch (e) { list = []; }
  if (!list.length) {
    // Nobody in Contacts.app — try WhatsApp's own address book before giving up.
    const wa = await waLookup(q);
    if (wa.length) {
      const exactWa = wa.filter(c => c.name.toLowerCase() === q.toLowerCase());
      const cands = (exactWa.length === 1 ? exactWa : wa).map(c => ({
        name: c.name, exact: c.name.toLowerCase() === q.toLowerCase(),
        phone: c.phone, email: '', handle: c.phone, source: 'whatsapp',
      }));
      if (cands.length === 1) {
        deps.jlog('Contact › "' + q + '" found in WhatsApp (not in Contacts)');
        return ok('Found ' + cands[0].name + ' in WhatsApp, Sir.', { data: cands[0] });
      }
      return { ok: false, needsClarify: true, options: cands.map(c => c.name),
        candidates: cands, say: 'Several WhatsApp contacts match “' + q + '”, Sir — which one?' };
    }
    return fail('No contact matching “' + q + '”, Sir — not in Contacts or WhatsApp.');
  }
  const shaped = list.map(c => ({
    name: c.name, exact: !!c.exact,
    phone: (c.phones && c.phones[0]) || '', email: (c.emails && c.emails[0]) || '',
    handle: (c.phones && c.phones[0]) || (c.emails && c.emails[0]) || '',
  })).filter(c => c.handle); // a card with no phone or email is unreachable — drop it, don't offer it
  if (!shaped.length) return fail('Found a match for “' + q + '”, Sir, but there is no phone or email saved for them.');

  // Confident only when there is exactly one usable candidate, OR exactly one candidate is an EXACT
  // name/nickname hit with no other equally-exact one — e.g. two contacts both literally saved as
  // "Mama" still stop and ask. Anything looser than that IS the "confused between similar names"
  // failure mode Mihir flagged, so it stops and asks rather than silently picking the first result.
  const exactOnes = shaped.filter(c => c.exact);
  const confident = shaped.length === 1 ? shaped[0] : (exactOnes.length === 1 ? exactOnes[0] : null);

  if (!confident) {
    const opts = shaped.slice(0, 5);
    return needsClarify(opts, 'I found more than one match for “' + q + '”, Sir — ' + opts.map(c => c.name).join(', ') + '. Which one did you mean?');
  }
  return ok('Found ' + confident.name + '.', {
    data: { name: confident.name, handle: confident.handle, phone: confident.phone, email: confident.email, matches: shaped.length },
    // Fields the planner can reference as {{n.handle}} / {{n.phone}} / {{n.name}}.
    handle: confident.handle, phone: confident.phone, email: confident.email, name: confident.name,
    entity: confident.name,
  });
}

// ---------------- Messages (iMessage) + WhatsApp ----------------
// WhatsApp Desktop has NO AppleScript dictionary (verified: it only answers the generic Cocoa
// `name` property every app gets for free; a real command like "send message" is a syntax error,
// not a permission error). The one thing Meta documents and actually supports is the "click to
// chat" URL scheme (`whatsapp://send?phone=&text=`), which opens the app with the chat PRE-FILLED —
// it does not complete the send, by design on Meta's end, not a limitation JARVIS imposes. Placing
// a CALL is not automatable at all: there is no documented deep link or scripting hook for it on
// macOS, so open_whatsapp_chat below gets the user to the right chat instantly and is honest that
// the actual tap is theirs.
const JXA_SEND_IMESSAGE = `function run(argv) {
  const to = String(argv[0] || '');
  const body = String(argv[1] || '');
  const M = Application('Messages');
  const svc = M.services.whose({ serviceType: 'iMessage' })[0];
  const buddy = svc.buddies[to];
  M.send(body, { to: buddy });
  return 'sent';
}`;
// `open` is the same safe, argv-based mechanism server.js already uses for open_url/open_social —
// the URL is one argv item, never shell/AppleScript text, so a body with `&`/quotes in it is inert.
function openUrl(url) {
  return new Promise(resolve => execFile('/usr/bin/open', [url], { timeout: 10000 }, err => resolve(!err)));
}
// WhatsApp's click-to-chat scheme wants digits only (no +, spaces, dashes, parens) but keeps
// whatever country code the stored number carries — silently GUESSING a missing country code would
// be exactly the kind of wrong-recipient mistake this whole feature is meant to avoid, so a number
// that looks too short to include one is rejected rather than assumed.
function waDigits(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  return d.length >= 10 ? d : '';
}
const maskPhone = d => d.length > 4 ? '•'.repeat(d.length - 4) + d.slice(-4) : d;

// ---- WhatsApp send verification -------------------------------------------------------------
//
// DID IT ACTUALLY GO? The lesson from the Swiggy basket: a successful keypress is not a sent
// message, and reporting one as the other is the failure this system exists to avoid.
//
// The check is the compose field. While the message is unsent it sits there as the field's value,
// and the accessibility tree reports a control's value as its label; once sent, the field is empty
// and drops out of the listing entirely (empty labels are not enumerated). So: the message text
// still present in a control == still a draft.
async function waElements() {
  const r = await controlReq('GET', '/elements?app=' + encodeURIComponent('WhatsApp'));
  return (r && r.ok) ? r : null;
}
async function waSent(body) {
  const probe = String(body || '').trim().slice(0, 30).toLowerCase();
  if (!probe) return false;
  const r = await waElements();
  if (!r) return false;                       // cannot see WhatsApp — do not claim anything

  // ASK THE COMPOSE BOX, NOT THE WHOLE WINDOW.
  //
  // The first version searched every label for the message text and treated a hit as "still a
  // draft". It found it — in the SENT bubble. A sent message reads "Your message, <text>" in the
  // thread, so the check said "not sent" about messages that had just gone, three times running.
  //
  // The compose box is an AXTextArea whose label is its VALUE while something is typed and its
  // PLACEHOLDER ("Compose message") once empty. Empty box == sent.
  const box = (r.elements || []).find(e => String(e.role || '') === 'AXTextArea');
  if (box) return !String(box.label || '').toLowerCase().includes(probe);

  // No text area exposed: fall back to the old shape, but only count matches that are NOT a sent
  // bubble, so the thread cannot masquerade as a draft.
  const stillTyped = (r.elements || []).some(e => {
    const l = String(e.label || '');
    if (/^your message[,:]/i.test(l)) return false;      // that is the transcript, not the box
    return l.toLowerCase().includes(probe);
  });
  return !stillTyped;
}
async function waPressSend() {
  const r = await waElements();
  if (!r) return false;
  const btn = (r.elements || []).find(e => /^\s*send\s*$/i.test(String(e.label || '')));
  if (!btn) return false;
  if (!(await uiBegin())) return false;
  try {
    const p = await controlReq('POST', '/press', { i: btn.i, fingerprint: r.fingerprint, app: 'WhatsApp' });
    return !!(p && p.ok);
  } finally { await uiEnd(); }
}

async function send_message(args, ctx) {
  // WhatsApp is the default channel (Mihir's choice — more of his contacts are reachable there
  // than iMessage). "on imessage" / "as a text" / "sms" in the request overrides it — see pickChannel.
  const channel = String(args.channel || 'whatsapp').toLowerCase();
  const body = String(args.body || args.text || args.message || '').trim();
  const who = String(args.name || args.to || '').trim();
  if (!body) return fail('The message is empty, Sir — nothing to send.');

  if (channel === 'whatsapp') {
    const digits = waDigits(args.phone || args.to || args.handle);
    if (!digits) return fail('I don’t have a usable WhatsApp number for ' + (who || 'them') + ', Sir — it needs a phone number with a country code, not an email.');
    if (!ctx.confirmed && !autoSend()) {
      // The masked number lets Mihir actually VERIFY this resolved to the right person before
      // anything opens — the raw digits never reach the browser, only the last 4.
      return needsConfirm('send_message', { channel, phone: digits, body, name: who },
        'Send this to ' + who + ' on WhatsApp, Sir? I will press Send myself once you approve — say no and nothing opens.',
        { to: who, body, channel: 'whatsapp', number: maskPhone(digits) });
    }
    const opened = await openUrl('whatsapp://send?phone=' + encodeURIComponent(digits) + '&text=' + encodeURIComponent(body));
    if (!opened) return fail('Could not open WhatsApp, Sir — is it installed?');

    // FINISH THE SEND, NOW THAT HE HAS ALREADY APPROVED IT.
    //
    // The URL scheme leaves the message typed into the compose field with focus, and the only thing
    // between that and a sent message is one Return. Leaving that tap to him was never a safety
    // feature — the safety is the confirm ABOVE, which shows him the words and the masked number
    // before anything opens. Once he has said yes, stopping one keypress short is just unfinished.
    //
    // realKey refuses if WhatsApp is not the frontmost window, so a mistimed keystroke cannot land
    // in whatever else he happened to be typing in.
    await new Promise(r => setTimeout(r, 1800));            // let the app fill the compose field

    // BRING IT FORWARD AND WAIT UNTIL IT REALLY IS FORWARD.
    //
    // realKey refuses to fire unless the intended app has focus, which is the guard that matters —
    // measured here: the URL scheme opened WhatsApp, focus stayed on the app I was driving from, and
    // the Return was correctly refused rather than landing in someone else's window. But refusing is
    // only half a solution; the app has to be activated first, the same way a real browser press
    // activates Brave before pressing.
    for (let i = 0; i < 6; i++) {
      // Name travels as argv, never inside the script text — the house rule.
      await jxa('function run(a){ Application(a[0]).activate(); return "ok"; }', ['WhatsApp'], 6000);
      await new Promise(r => setTimeout(r, 500));
      const f = await frontmostApp();
      if (f && sameApp(f, 'WhatsApp')) break;
    }

    // FOCUS THE COMPOSE FIELD, THEN PRESS. Activating an app does not guarantee the caret is in the
    // message box — it may sit on the chat list, where Return does nothing at all. The field is in
    // the accessibility tree (its value is the draft), so it can be pressed by index first.
    //
    // FIND IT BY ROLE, THE SAME WAY waSent DOES. This used to look for a label starting "your
    // message" — but that is the label of a SENT bubble in the thread ("Your message, Link, https…"),
    // not of the box. 2026-09-26, Mama's chat: it pressed an old link bubble instead of the box, the
    // Return landed nowhere, and the send was left as a draft. The box is the chat's one AXTextArea
    // (listed there as "Compose message" when empty, the draft text when filled).
    try {
      const wa = await waElements();
      const field = wa && (wa.elements || []).find(e => String(e.role || '') === 'AXTextArea');
      if (field && (await uiBegin())) {
        let fp = null;
        try { fp = await controlReq('POST', '/press', { i: field.i, fingerprint: wa.fingerprint, app: 'WhatsApp' }); }
        finally { await uiEnd(); }
        deps.jlog('WhatsApp send › compose box ' + (fp && fp.ok ? 'focused (' + fp.via + ')' : 'press failed: ' + String((fp && fp.error) || '?').slice(0, 60)));
        await new Promise(r => setTimeout(r, 400));
      } else deps.jlog('WhatsApp send › ' + (field ? 'JarvisControl unreachable — compose box not focused' : 'no compose box in the accessibility tree'));
    } catch (e) {}

    let sent = false, how = '';
    const pressed = await realKey('return', 'WhatsApp');
    // Log WHICH step failed — "could not confirm" alone does not say whether the key was refused,
    // fired and did nothing, or fired and worked while the check misread it.
    deps.jlog('WhatsApp send › keystroke ' + (pressed && pressed.ok ? 'fired' : 'REFUSED: ' + String((pressed && pressed.say) || '?').slice(0, 60)));
    if (pressed && pressed.ok) { how = 'return'; await new Promise(r => setTimeout(r, 1500)); sent = await waSent(body); }

    // Fallback: press the Send control itself, read from the accessibility tree. Some builds put
    // focus somewhere Return does not reach.
    if (!sent) {
      const viaBtn = await waPressSend();
      deps.jlog('WhatsApp send › Send button ' + (viaBtn ? 'pressed' : 'not found or not pressable'));
      if (viaBtn) { how = 'send-button'; await new Promise(r => setTimeout(r, 1500)); sent = await waSent(body); }
    }

    deps.audit('send_message', { channel: 'whatsapp', to: who, chars: body.length }, sent ? 'sent' : 'opened for send');
    if (sent) {
      deps.jlog('WhatsApp SENT › ' + who + ' (' + body.length + ' chars, via ' + how + ')');
      return ok('Sent to ' + who + ' on WhatsApp, Sir.', { data: { to: who, body, channel: 'whatsapp', sent: true, via: how }, entity: who });
    }
    // Never claim a send that was not verified in the thread — the whole point of checking.
    deps.jlog('WhatsApp opened › ' + who + ' (' + body.length + ' chars) — could not confirm the send, left as a draft');
    return ok('WhatsApp is open with the message ready for ' + who + ', Sir — I could not confirm it went, so tap Send there to finish.',
      { data: { to: who, body, channel: 'whatsapp', sent: false }, entity: who });
  }

  // channel === 'imessage'
  const to = String(args.to || args.phone || args.email || args.handle || '').trim();
  if (!to) return fail('I need a phone number or email to send to, Sir.');
  if (!ctx.confirmed && !autoSend()) {
    return needsConfirm('send_message', { channel: 'imessage', to, body, name: who },
      'Send this to ' + who + ' via iMessage, Sir?', { to: who, body, channel: 'imessage' });
  }
  const r = await jxa(JXA_SEND_IMESSAGE, [to, body], 25000);
  if (!r.ok) return fail(humanizeOsaError(r.err, 'Messages'));
  deps.audit('send_message', { channel: 'imessage', to: who, chars: body.length }, 'sent');
  deps.jlog('Message sent › ' + who + ' (' + body.length + ' chars) via iMessage');
  return ok('Message sent to ' + who + ', Sir.', { data: { to: who, body, channel: 'imessage' }, entity: who });
}

// "call mama on whatsapp" — opens the chat so the tap is one click away. Not confirm-gated: it
// sends nothing, exactly like open_url/open_social already aren't.
async function open_whatsapp_chat(args) {
  const who = String(args.name || args.to || '').trim();
  const digits = waDigits(args.phone || args.to || args.handle);
  if (!digits) return fail('I don’t have a usable WhatsApp number for ' + (who || 'them') + ', Sir.');
  const opened = await openUrl('whatsapp://send?phone=' + encodeURIComponent(digits));
  if (!opened) return fail('Could not open WhatsApp, Sir — is it installed?');
  deps.audit('open_whatsapp_chat', { to: who }, 'opened');
  deps.jlog('WhatsApp chat opened › ' + who);
  return ok('Opened WhatsApp with ' + who + ', Sir — tap the call icon there. I can’t place the call myself; WhatsApp doesn’t allow that from outside the app.', { data: { to: who, channel: 'whatsapp' }, entity: who });
}

// ---------------- Notes ----------------
const JXA_CREATE_NOTE = `function run(argv) {
  const title = String(argv[0] || 'JARVIS note');
  const bodyText = String(argv[1] || '');
  const N = Application('Notes');
  N.activate();
  const esc = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const html = '<div><b>' + esc(title) + '</b></div>' +
    bodyText.split(/\\n/).map(function (l) { return '<div>' + (esc(l) || '<br>') + '</div>'; }).join('');
  const acct = N.defaultAccount();
  const note = N.Note({ name: title, body: html });
  acct.notes.push(note);
  return 'created';
}`;

async function create_note(args) {
  const title = String(args.title || args.name || 'JARVIS note').trim().slice(0, 200);
  const body = String(args.body || args.text || args.content || '').trim();
  if (!body) return fail('There is no content for the note, Sir.');
  const r = await jxa(JXA_CREATE_NOTE, [title, body], 30000);
  if (!r.ok) return fail(humanizeOsaError(r.err, 'Notes'));
  deps.audit('create_note', { title, chars: body.length }, 'created');
  deps.jlog('Note created › ' + title + ' (' + body.length + ' chars)');
  onCreated('note', title);
  return ok('Written to Notes as “' + title + '”, Sir.', { data: { title, body }, entity: title });
}

// ---------------- Reminders ----------------
const JXA_ADD_REMINDER = `function run(argv) {
  const name = String(argv[0] || '');
  const iso = String(argv[1] || '');
  const R = Application('Reminders');
  const props = { name: name };
  if (iso) props.dueDate = new Date(iso);
  const rem = R.Reminder(props);
  R.defaultList().reminders.push(rem);
  return 'added';
}`;

async function add_reminder(args) {
  const name = String(args.title || args.text || args.name || '').trim();
  if (!name) return fail('What should the reminder say, Sir?');
  const iso = args.when ? new Date(args.when).toISOString() : '';
  const r = await jxa(JXA_ADD_REMINDER, [name, iso], 25000);
  if (!r.ok) return fail(humanizeOsaError(r.err, 'Reminders'));
  deps.audit('add_reminder', { name, when: iso || null }, 'added');
  deps.jlog('Reminder added › ' + name);
  onCreated('reminder', name);
  return ok('Added “' + name + '” to Reminders, Sir.', { data: { name }, entity: name });
}

// ---------------- Calendar ----------------
const JXA_ADD_EVENT = `function run(argv) {
  const summary = String(argv[0] || '');
  const startISO = String(argv[1] || '');
  const mins = parseInt(String(argv[2] || '60'), 10) || 60;
  const C = Application('Calendar');
  const start = new Date(startISO);
  const end = new Date(start.getTime() + mins * 60000);
  const cal = C.calendars.whose({ writable: true })[0];
  const ev = C.Event({ summary: summary, startDate: start, endDate: end });
  cal.events.push(ev);
  return String(cal.name());
}`;

async function add_calendar_event(args) {
  const summary = String(args.title || args.summary || args.text || '').trim();
  if (!summary) return fail('What is the event called, Sir?');
  if (!args.when) return fail('When is the event, Sir?');
  const startISO = new Date(args.when).toISOString();
  const r = await jxa(JXA_ADD_EVENT, [summary, startISO, String(args.minutes || 60)], 25000);
  if (!r.ok) return fail(humanizeOsaError(r.err, 'Calendar'));
  deps.audit('add_calendar_event', { summary, when: startISO }, 'added');
  deps.jlog('Calendar event › ' + summary + ' @ ' + new Date(startISO).toLocaleString());
  onCreated('event', summary);
  return ok('“' + summary + '” is in your calendar for ' + new Date(startISO).toLocaleString() + ', Sir.', { data: { summary, when: startISO }, entity: summary });
}

// ---------------- Calendar: reading + free-slot reasoning ----------------
// PERF: querying every calendar timed out at 45s — the auto-generated ones (Holidays, Birthdays,
// Siri Suggestions) hold thousands of events and dominate the cost. Skipping those brings a 7-day
// lookup to ~1.7s. They are also exactly the calendars you never want to schedule around.
// Properties are pulled in BULK per calendar (evs.summary() returns an array) for the same reason
// find_contact had to — per-event access is a separate Apple Event each and does not scale.
const SKIP_CALENDARS = /holiday|birthday|siri suggestion|scheduled reminder/i;
const JXA_LIST_EVENTS = `function run(argv) {
  const days = parseInt(String(argv[0] || '7'), 10) || 7;
  const skip = new RegExp(String(argv[1] || 'holiday|birthday|siri suggestion|scheduled reminder'), 'i');
  const C = Application('Calendar');
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  const cals = C.calendars;
  const names = cals.name();
  const out = [];
  for (let i = 0; i < names.length; i++) {
    if (skip.test(names[i])) continue;
    try {
      const evs = cals[i].events.whose({ _and: [{ startDate: { '>': now } }, { startDate: { '<': end } }] });
      const su = evs.summary(), sd = evs.startDate(), ed = evs.endDate();
      for (let k = 0; k < su.length; k++) {
        out.push({ title: String(su[k] || 'Untitled'), start: sd[k].toISOString(), end: ed[k].toISOString(), calendar: names[i] });
      }
    } catch (e) {}
  }
  out.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  return JSON.stringify(out.slice(0, 60));
}`;

async function readEvents(days) {
  const r = await jxa(JXA_LIST_EVENTS, [String(days || 7), SKIP_CALENDARS.source], 60000);
  if (!r.ok) return { ok: false, say: humanizeOsaError(r.err, 'Calendar') };
  try { return { ok: true, events: JSON.parse(r.out || '[]') }; }
  catch (e) { return { ok: true, events: [] }; }
}

const fmtWhen = iso => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTime = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function list_events(args) {
  const days = Math.min(60, Math.max(1, Number(args.days || args.window || 7)));
  const r = await readEvents(days);
  if (!r.ok) return fail(r.say);
  if (!r.events.length) return ok('Nothing on the calendar for the next ' + days + ' day' + (days === 1 ? '' : 's') + ', Sir.', { data: { events: [], days } });
  const lines = r.events.slice(0, 12).map(e => '· ' + fmtWhen(e.start) + ' — ' + e.title);
  const more = r.events.length > 12 ? '\n…and ' + (r.events.length - 12) + ' more.' : '';
  return ok(r.events.length + ' event' + (r.events.length === 1 ? '' : 's') + ' in the next ' + days + ' day' + (days === 1 ? '' : 's') + ', Sir:\n' + lines.join('\n') + more,
    { data: { events: r.events, days }, events: r.events });
}

// Finds the first gap that fits, honouring working hours and skipping weekends by default. Returns
// ISO strings the planner can hand straight to add_calendar_event via {{n.start}}.
async function find_free_slot(args) {
  const mins = Math.min(600, Math.max(15, Number(args.minutes || args.duration || 60)));
  const days = Math.min(30, Math.max(1, Number(args.days || args.within || 7)));
  const dayStart = Math.min(23, Math.max(0, Number(args.from != null ? args.from : 9)));
  const dayEnd = Math.min(24, Math.max(dayStart + 1, Number(args.to != null ? args.to : 18)));
  const includeWeekends = !!args.weekends;

  const r = await readEvents(days);
  if (!r.ok) return fail(r.say);
  const busy = r.events.map(e => [new Date(e.start).getTime(), new Date(e.end).getTime()])
    .filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);

  const need = mins * 60000;
  const now = Date.now();
  for (let d = 0; d < days; d++) {
    const day = new Date(now + d * 86400000);
    if (!includeWeekends && (day.getDay() === 0 || day.getDay() === 6)) continue;
    let cursor = new Date(day); cursor.setHours(dayStart, 0, 0, 0);
    const close = new Date(day); close.setHours(dayEnd, 0, 0, 0);
    let t = Math.max(cursor.getTime(), now + 5 * 60000);   // never propose a slot in the past
    // Walk the day's busy blocks in order, taking the first gap wide enough.
    for (const [bs, be] of busy) {
      if (be <= t || bs >= close.getTime()) continue;      // block is irrelevant to this window
      if (bs - t >= need) break;                            // gap before this block fits
      t = Math.max(t, be);
    }
    if (t + need <= close.getTime()) {
      const start = new Date(t), end = new Date(t + need);
      return ok('Free ' + fmtWhen(start.toISOString()) + '–' + fmtTime(end.toISOString()) + ', Sir.', {
        data: { start: start.toISOString(), end: end.toISOString(), minutes: mins },
        start: start.toISOString(), end: end.toISOString(), when: start.toISOString(),
      });
    }
  }
  return fail('No ' + mins + '-minute gap in the next ' + days + ' days between ' + dayStart + ':00 and ' + dayEnd + ':00, Sir.');
}

// ---------------- local businesses (businessfinder.js) ----------------
// "find businesses in my locality without a website and give me their numbers" — the job businessfinder.js was built for
// on 2026-10-01 and nothing called, so on 2026-10-09 the loop answered it with ONE Safari search and called that done.
// `where` left out = around him: the Mac's saved browser location (up to 30 days old; the IP guess was measured 78 km
// off), a square ~2 km each way — his pick, 2026-10-09. With no saved location: his city, and the reply says so.
const businessfinder = require('./businessfinder.js');
const truthy = v => v === true || v === 'true' || v === 1 || v === 'yes';
async function find_businesses(args, ctx) {
  businessfinder.init({ jlog: deps.jlog, audit: (what, data) => deps.audit('find_businesses', data, { ok: true }) });
  const what = String(args.what || args.kind || '').trim();
  let where = String(args.where || args.place || args.area || '').trim();
  // A PLACE HE NAMED — NOT ONE THE PLANNER WROTE, AND NOT THE MAP'S GUESS AT IT (2026-10-15, his live turn: "find resturants
  // near me without a website" → the 3B wrote where="around me", which Nominatim places on a theatre in Iraq; "near me" lands on
  // a park in Mexico — 0 restaurants either way). Two shape checks, no words: every word of `where` must be in what he said,
  // and the map's own name for its match must carry every word of `where`. Otherwise the search goes around him, and says so.
  const wordsOf = s => String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  let placeNote = '';
  if (where && ctx && ctx.goal) {
    const said = new Set(wordsOf(ctx.goal));
    if (!wordsOf(where).every(w => said.has(w))) {
      if (deps.jlog) deps.jlog('Businesses › "' + where + '" is not in what he said — searching around him');
      where = '';
    }
  }
  if (where) {
    let area = null; try { area = await businessfinder.geocode(where); } catch (e) { area = null; }
    const named = new Set(wordsOf(area && area.name));
    if (!area || !wordsOf(where).every(w => named.has(w))) {
      if (deps.jlog) deps.jlog('Businesses › the map has no place called "' + where + '"' + (area ? ' (its best match: ' + String(area.name).slice(0, 60) + ')' : '') + ' — searching around him');
      placeNote = 'I could not find "' + where + '" on the map, so this is ';
      where = '';
    }
  }
  const withoutWebsite = truthy(args.withoutWebsite) || truthy(args.without_website) || truthy(args.noWebsite);
  const needPhone = truthy(args.needPhone) || truthy(args.need_phone) || truthy(args.withPhone);
  let near = null, scope = '';
  if (!where) {
    const me = deps.whereAmI ? await deps.whereAmI().catch(() => null) : null;
    if (me && me.lat != null) {
      near = { lat: me.lat, lon: me.lon, km: 2, label: me.label || '' };
      scope = placeNote + 'within about 2 km of where this Mac was last located' + (me.label ? ' (' + me.label + ')' : '') +
        (me.ageDays >= 1 ? ', a location saved ' + Math.round(me.ageDays) + ' day' + (Math.round(me.ageDays) === 1 ? '' : 's') + ' ago' : '');
    } else if (me && me.city) { where = me.city; scope = 'in ' + me.city + ' — I have no saved location, so this is the whole city'; }
    else return fail('I do not know where you are, Sir — tell me the area and I will search there.');
  }
  if (!scope) scope = 'in ' + where;
  let r;
  try { r = await businessfinder.find({ what, where, near, withoutWebsite, needPhone, check: 25, limit: 80 }); }
  catch (e) { return fail('The business search failed: ' + e.message + ', Sir.'); }
  if (!r.ok) return fail(r.say);
  const kind = what || 'businesses';
  const places = r.places;
  let file = '';
  if (places.length && deps.outDir) {
    try {
      fs.mkdirSync(deps.outDir, { recursive: true });
      const slug = (kind + (near ? ' near me' : ' ' + where)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      file = require('path').join(deps.outDir, 'businesses-' + slug + '-' + new Date().toISOString().slice(0, 10) + '.csv');
      fs.writeFileSync(file, businessfinder.toCsv(places));
    } catch (e) { file = ''; }
  }
  const withPhone = places.filter(p => p.phones.length).length;
  const sources = r.notes.join('; ');
  if (!places.length) {
    return ok('I found no ' + kind + (withoutWebsite ? ' without a website' : '') + ' ' + scope + ', Sir. Sources: ' + sources + '.',
      { data: { count: 0, sources: r.notes } });
  }
  // "NO WEBSITE" ONLY WHERE IT WAS CHECKED — businessfinder keeps the unchecked ones apart; the reply does too.
  const checked = withoutWebsite ? places.filter(p => p.noSiteChecked).length : 0;
  const head = 'Found ' + r.total + ' ' + kind + ' ' + scope +
    (withoutWebsite ? ' with no website listed — ' + checked + ' confirmed by a web search, ' + r.unchecked + ' not checked' : '') +
    '; ' + withPhone + ' with a phone number.';
  const lines = places.slice(0, 10).map((p, i) => (i + 1) + '. ' + p.name +
    (p.phones.length ? ' — ' + p.phones.map(businessfinder.showPhone).join(' / ') : ' — no number found') +
    (withoutWebsite && !p.noSiteChecked ? ' (website not checked)' : ''));
  const say = head + '\n' + lines.join('\n') + (places.length > 10 ? '\n…and ' + (places.length - 10) + ' more' : '') +
    (file ? '\nThe full list is saved as ' + require('path').basename(file) + ' in JARVIS Outputs.' : '') +
    '\nSources: ' + sources + '.';
  return ok(say, { data: { count: r.total, withPhone, checked, unchecked: r.unchecked, file, sources: r.notes,
    top: places.slice(0, 10).map(p => ({ name: p.name, phones: p.phones.map(businessfinder.showPhone) })) } });
}

// ---------------- compose (the LLM writes the actual content) ----------------
// This is what makes "message mama ASKING ABOUT HER HEALTH" and "write a PASSAGE
// ABOUT FOOD" work: the planner decides *that* text is needed, this produces it.
// STRICT: turn his indirect words into the direct message, adding NOTHING (reader round 3, 2026-09-27).
// The free composer below wrote "tell mama im outside" as "I'm outside having some fresh air" and "text mama
// asking wht time dinner is" as "wondering what time you're free for dinner" — news he never gave. Here the
// model is told to convert only, and its answer is checked by SHAPE against what he said: a word of five or
// more letters that appears nowhere in his words (or the recipient's name) is invention. Two tries; then his
// own words are used as they stand. The confirm card shows the text before anything is sent either way.
function strictComposeSystem(recipient) {
  return 'Rewrite what ' + profile.userRef() + ' wants to ask or tell ' + (recipient || 'someone') + ' as the direct message ' +
    profile.pronouns().subj + ' would send, in the second person. Use ONLY the information given. Add nothing: no greeting, ' +
    'no sign-off, no reason, no feeling, no emoji, no extra question. Keep ' + profile.pronouns().poss + ' casual style and any slang exactly. ' +
    'One short sentence. Reply with the message only.';
}
const cleanDraft = t => String(t || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();

// COMPOSER V3 — CANDIDATE, NOT WIRED (finetune/README "Composer v3", 2026-10-19). The v2 trial found the drafts themselves are
// the bottleneck — and the drafting model was only ever shown the fragment the reader cut ("if he has the charger"), never his
// request ("msg ira asking if he has the charger"), so it could not tell a question to Ira from an order. This
// shows the whole request, the part to pass on and who it goes to, and teaches the conversion by worked examples (names and
// errands invented for this prompt, overlap-checked against every held-out) instead of listing kinds of words to drop.
const DIRECT_EXAMPLES = [
  ['text riya asking if she booked the cab', 'if she booked the cab', 'riya', 'did you book the cab?'],
  ['aman se puch ki usne notes bheje kya', 'usne notes bheje kya', 'aman', 'tune notes bheje kya?'],
  ['tell kabir that his jacket is in my car', 'that his jacket is in my car', 'kabir', 'your jacket is in my car'],
  ['ask dev to bring the extension cord tmrw', 'to bring the extension cord tmrw', 'dev', 'can you bring the extension cord tmrw?'],
  ['meera ko bata ki uska parcel gate pe pada hai', 'uska parcel gate pe pada hai', 'meera', 'tera parcel gate pe pada hai'],
];
function composeDirectMessages(request, said, recipient) {
  const p = profile.pronouns(), who = profile.userRef(), to = recipient || 'them';
  const sys = 'You write the text message ' + who + ' sends to a friend or family member. You get ' + p.poss + ' request to ' +
    p.poss + ' assistant and the part of it to pass on. Write that part the way ' + p.subj + ' would text it: speaking to the ' +
    'person directly, in the same language and mix ' + p.subj + ' used, keeping every fact, name, time, number and slang word, ' +
    'and adding nothing ' + p.subj + ' did not say. Reply with the message only.';
  const turn = (req, part, name) => 'Request: ' + req + '\nPass on: ' + part + '\nMessage to ' + name + ':';
  const msgs = [{ role: 'system', content: sys }];
  for (const [req, part, name, msg] of DIRECT_EXAMPLES) msgs.push({ role: 'user', content: turn(req, part, name) }, { role: 'assistant', content: msg });
  msgs.push({ role: 'user', content: turn(String(request || said), String(said), to) });
  return msgs;
}
// With JARVIS_COMPOSE_V3=1 (OFF until the README bars and the gate pass): ONE draft from deps.draft (server.js composeDraft:
// phi4-mini by default, temperature 0, with token logprobs), sent only when the drafter was sure of every token it wrote — its
// lowest token log-probability at or above COMPOSE_SURE_AT, fixed from the development set. On the dev set qwen's confidence did
// not separate its good drafts from its bad ones and phi4-mini's did. Not sure → a `reported` body becomes a question, a plain
// body stays his words. invented() is not used on this path.
const COMPOSE_SURE_AT = -1.2;
// '1' = candidate C (failed its bars 10-19, kept for the record); 'c2' = C2 (README "Composer C2", 2026-10-22): plain bodies are
// never rewritten, reported Hinglish is asked — phi4-mini cannot convert it and is sure when wrong — and only reported English
// goes to the sure-draft path. An ask is better than a wrong message.
const composeV3Mode = () => { const v = String(deps.envVal('JARVIS_COMPOSE_V3') || '').trim(); return v === '1' || v === 'c2' ? v : ''; };
const composeV3On = () => !!composeV3Mode();
async function composeV3(args, said, recipient) {
  const flat = x => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const ask = 'What should the message' + (recipient ? ' to ' + recipient : '') + ' say, Sir?';
  if (composeV3Mode() === 'c2' && !args.noVerbatim) {
    if (!args.reported) return ok('Drafted.', { data: { text: said, verbatim: true }, text: said });
    // JARVIS's own language check (intent.isHinglish: the macOS dictionary + centroids). No answer counts as Hinglish → ask.
    let hinglish = true;
    try { hinglish = !deps.isHinglish || !!(await deps.isHinglish(said)) || !!(await deps.isHinglish(String(args.message || ''))); } catch (e) { hinglish = true; }
    if (hinglish) {
      if (deps.jlog) deps.jlog('Compose › reported Hinglish body — asking instead of drafting');
      return Object.assign(fail(ask), { data: { asked: true, hinglish: true } });
    }
  }
  let d = null;
  try { d = deps.draft ? await deps.draft(composeDirectMessages(args.message, said, recipient)) : null; } catch (e) { d = null; }
  const text = cleanDraft(d && d.text);
  const lps = ((d && d.logprobs) || []).map(t => t && t.logprob).filter(x => typeof x === 'number');
  const sure = lps.length ? Math.min(...lps) : null;
  // his whole instruction is never the message ("ping bhai asking …" sent to bhai)
  const echoed = !!text && ((!!args.message && flat(text) === flat(args.message)) || (!!args.noVerbatim && flat(text) === flat(said)));
  if (text && !echoed && sure !== null && sure >= COMPOSE_SURE_AT) return ok('Drafted.', { data: { text, sure }, text });
  if (deps.jlog) deps.jlog('Compose › draft not sent — ' + (!text ? 'no draft' : echoed ? 'it echoed his whole instruction'
    : sure === null ? 'no token probabilities' : 'lowest token logprob ' + sure.toFixed(2) + ' < ' + COMPOSE_SURE_AT));
  // Flagged `asked` on both paths, so the agent loop ends on the question instead of retrying it (harness.classify).
  if (args.noVerbatim || args.reported) return Object.assign(fail(ask), { data: { asked: true, sure } });
  return ok('Drafted.', { data: { text: said, verbatim: true, sure }, text: said });
}

// COMPOSER V2 — CANDIDATE, OFF (finetune/README "Composer v2", pre-registered 2026-10-15). On only with
// JARVIS_COMPOSE_JUDGE=1, and only after sweeps/sweep_composer_v2.js passes the bars written there. invented() in
// composeStrict decides "the rewrite failed" by a length check over his words — a keyword trap by his rule 1 — and in the
// two gate baselines it failed both ways: 13 rewrites thrown away for his indirect words, 7 invented drafts let through
// ("Let's grab dinner at 7?" has no new five-letter word). With the flag on, invented() is not used: a draft is accepted
// only when a judge says yes to one fixed question about JARVIS's own decision, read from the answer token's probabilities
// (yes share over 0.5 — fixed, never tuned); when neither draft is accepted and the reader marked the body `reported`,
// JARVIS asks what the message should say and sends nothing. deps.judge(messages) → the logprobs of a one-token answer
// (server.js composeJudge). No judge, or a judge that fails, accepts nothing.
const COMPOSE_JUDGE_AT = 0.5;
const composeJudgeOn = () => String(deps.envVal('JARVIS_COMPOSE_JUDGE') || '').trim() === '1';
function composeJudgeMessages(request, said, recipient, draft) {
  const p = profile.pronouns(), to = recipient || 'them';
  return [{ role: 'user', content: p.poss.toUpperCase() + ' REQUEST: ' + String(request || said) + '\nTHE PART TO PASS ON: ' + said +
    '\nDRAFT TO ' + to + ': ' + draft + '\n\nIf JARVIS sends this DRAFT to ' + to + ', does it pass on what ' + p.subj +
    ' asked — all of it and nothing more, said to ' + to + ' directly? Answer yes or no.' }];
}
async function judgeDraft(request, said, recipient, draft) {
  const t0 = Date.now();
  let share = null;
  try { const v = deps.judge ? grounded.checkVerdict(await deps.judge(composeJudgeMessages(request, said, recipient, draft))) : null; share = v ? v.share : null; }
  catch (e) { share = null; }
  return { text: draft, share, ok: share != null && share > COMPOSE_JUDGE_AT, ms: Date.now() - t0 };
}

async function composeStrict(args) {
  const said = String(args.said || args.purpose || '').trim();
  const recipient = String(args.recipient || args.name || '').trim();
  if (!said) return fail('What should I say, Sir?');
  if (composeV3On()) return composeV3(args, said, recipient);
  const mine = new Set((said + ' ' + recipient + ' ' + String(args.message || '')).toLowerCase().match(/[a-z]+/g) || []);
  const invented = t => (String(t).toLowerCase().match(/[a-z]+/g) || []).filter(w => w.length >= 5 && !mine.has(w));
  const sys = strictComposeSystem(recipient);
  const judgeOn = composeJudgeOn(), judged = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await deps.llm({ system: sys, messages: [{ role: 'user', content: said }], max_tokens: 60, timeoutMs: 60000 });
      const text = cleanDraft(r.text);
      const flat = x => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const echoed = args.noVerbatim && flat(text) === flat(said);
      if (judgeOn) {
        if (!text || echoed) { if (deps.jlog) deps.jlog('Compose › ' + (echoed ? 'the rewrite echoed his whole instruction' : 'empty rewrite') + ' — ' + (attempt ? 'giving up' : 'retrying')); continue; }
        const v = await judgeDraft(args.message, said, recipient, text);
        judged.push(v);
        if (v.ok) return ok('Drafted.', { data: { text, judged }, text });
        if (deps.jlog) deps.jlog('Compose › the judge did not pass the rewrite (yes share ' + v.share + ') — ' + (attempt ? 'giving up' : 'retrying'));
        continue;
      }
      const added = invented(text);
      if (text && !added.length && !echoed) return ok('Drafted.', { data: { text }, text });
      if (echoed) { if (deps.jlog) deps.jlog('Compose › the rewrite echoed his whole instruction — ' + (attempt ? 'giving up' : 'retrying')); continue; }
      if (deps.jlog) deps.jlog('Compose › strict rewrite added "' + added.join(' ') + '" — ' + (attempt ? 'using his words' : 'retrying'));
    } catch (e) { break; }
  }
  // His whole instruction is not a message — ask rather than send "ping X on whatsapp asking …" to X.
  if (args.noVerbatim) return fail('What should the message' + (recipient ? ' to ' + recipient : '') + ' say, Sir?');
  // Composer v2 (flag on): his indirect words are not a message either — ask instead of sending "if he ate dinner" to him.
  if (judgeOn && args.reported) return Object.assign(fail('What should the message' + (recipient ? ' to ' + recipient : '') + ' say, Sir?'), { data: { asked: true, judged } });
  return ok('Drafted.', { data: judgeOn ? { text: said, verbatim: true, judged } : { text: said, verbatim: true }, text: said });
}

async function compose(args) {
  if (args && args.strict) return composeStrict(args);
  const purpose = String(args.purpose || args.about || args.topic || args.text || '').trim();
  if (!purpose) return fail('What should I write, Sir?');
  const kind = String(args.kind || 'text').toLowerCase();
  const recipient = String(args.recipient || args.name || '').trim();
  const L = deps.lean();
  const isMsg = kind === 'message';
  const sys = isMsg
    ? 'You are writing a short personal message that ' + profile.userRef() + ' will send from ' + profile.pronouns().poss + ' own phone' + (recipient ? ' to ' + recipient : '') + '. ' +
      'Write ONLY the message body — no greeting line labels, no quotes around it, no signature, no subject, no commentary. ' +
      'Warm, natural, and in his voice: plain, direct, not flowery or corporate. 1-3 sentences. No emoji unless clearly fitting. No markdown.'
    : 'You are writing content for ' + profile.userRef() + '. Produce ONLY the requested text — no preamble, no title unless asked, no commentary, no markdown formatting characters. ' +
      (L ? 'Keep it to roughly 120-180 words.' : 'Keep it to roughly 150-250 words.');
  try {
    const r = await deps.llm({ system: sys, messages: [{ role: 'user', content: purpose }], max_tokens: isMsg ? 200 : 700, timeoutMs: 120000 });
    let text = String(r.text || '').trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')          // models like to wrap the whole thing in quotes
      .replace(/^(?:here(?:'s| is)[^:]{0,40}:\s*)/i, '')  // ...and to preamble it
      .trim();
    if (!text) return fail('I could not compose that, Sir.');
    return ok('Drafted.', { data: { text }, text });
  } catch (e) {
    return fail('Composing failed, Sir: ' + (e.message || e));
  }
}

// ---------------- UI control (drive any app's interface) ----------------
// Routed through JarvisControl.app on :8765, NOT osascript, for one hard reason: CGEvent input needs
// Accessibility, and that is granted to JarvisControl.app — node/osascript do not have it. This is
// also what makes app control work with NO vision model: instead of screenshot→vision→click, we
// focus the app and drive its documented keyboard interface, which is deterministic and offline.
const CONTROL_BASE = () => 'http://127.0.0.1:' + (Number(deps.envVal('JARVIS_CONTROL_PORT')) || 8765);
function controlToken() {
  try { return require('fs').readFileSync(require('path').join(require('os').homedir(), 'JARVIS MK-1', 'jarvis-control', '.token'), 'utf8').trim(); }
  catch (e) { return ''; }
}
function controlReq(method, pathname, body) {
  return new Promise(resolve => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : '{}';
    let req;
    try {
      const u = new URL(CONTROL_BASE() + pathname);
      // pathname + search: the query is part of the request. With pathname alone, "/elements?app=WhatsApp" reached
      // JarvisControl as "/elements" — the FRONTMOST app's controls — so a WhatsApp send that went out was reported
      // "could not confirm" whenever WhatsApp was not in front, and screen_elements{app} listed the wrong app
      // (measured 2026-10-10: with the query 48 WhatsApp elements incl. the compose box; without it, Claude's 9).
      req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-control-token': controlToken() } },
        res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } }); });
    } catch (e) { return resolve({ ok: false, unreachable: true }); }
    req.setTimeout(6000, () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, unreachable: true }); });
    req.on('error', () => resolve({ ok: false, unreachable: true }));
    req.end(data);
  });
}
// A control session must be armed (/show) before /do is accepted — that is also what raises the blue
// HUD, so screen control is never invisible to the user. Ref-counted so a multi-step plan keeps one
// session open across steps instead of flickering the HUD on and off for each keystroke.
let uiSessionDepth = 0;
async function uiBegin() {
  if (uiSessionDepth++ === 0) { const r = await controlReq('POST', '/show'); if (r && r.unreachable) { uiSessionDepth = 0; return false; } }
  return true;
}
async function uiEnd(force) {
  if (force) uiSessionDepth = 0; else uiSessionDepth = Math.max(0, uiSessionDepth - 1);
  if (uiSessionDepth === 0) await controlReq('POST', '/hide');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A bundle's display name and its RUNNING PROCESS name are frequently different — Roblox.app runs
// as "RobloxPlayer", so an exact compare never matched and focus "failed" for 20s on an app that was
// sitting right there in front. Match loosely in both directions (ignoring case/punctuation) so any
// app with this split works, not just the ones we happen to hardcode.
// Known process→bundle splits that are NOT a prefix of each other. A plain "contains" test would
// cover these but is unsafe here: "gmail".includes("mail") would let a keystroke meant for Mail land
// in another window, and this function gates exactly that.
const PROC_ALIAS = { code: 'visualstudiocode', electron: '', robloxplayer: 'roblox', steamwebhelper: 'steam' };
function sameApp(procName, appName) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(procName), b = norm(appName);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  return !!(PROC_ALIAS[a] && PROC_ALIAS[a] === b);
}

async function frontmostApp() {
  const r = await jxa('function run(){ return Application("System Events").applicationProcesses.whose({frontmost: true})[0].name(); }', [], 8000);
  if (!r.ok) { deps.jlog('UI › frontmost check FAILED: ' + clipStr(r.err, 120)); return ''; }
  return r.out.trim();
}
// Bring an app to the front and CONFIRM it actually got there before anything is typed. Without this
// check a keystroke meant for one app lands in whatever is focused instead — which is how a search
// query ends up typed into the wrong window.
async function focusApp(name) {
  const target = deps.fuzzyApp ? deps.fuzzyApp(name) : { name, score: 1 };
  if (target.score < 0.5) return { ok: false, say: 'Not sure which app you mean by “' + name + '”, Sir.' };
  const appName = target.name;
  await new Promise(r => execFile('/usr/bin/open', ['-a', appName], { timeout: 10000 }, () => r()));
  let last = '';
  // Up to 15s: heavy apps (games, Electron, anything with an updater) take far longer than the old
  // 4.8s cap to put a window up. Returns the instant focus is confirmed, so fast apps pay nothing.
  const deadline = Date.now() + 15000;
  for (let i = 0; Date.now() < deadline; i++) {
    await sleep(400);
    const f = await frontmostApp();
    last = f;
    if (sameApp(f, appName)) { deps.jlog('UI › ' + appName + ' frontmost after ' + ((i + 1) * 400) + 'ms (process "' + f + '")'); return { ok: true, say: appName + ' is up front, Sir.', app: appName }; }
  }
  // HARD FAIL — do NOT proceed unverified. Previously this returned ok:true and let the caller type
  // anyway, which sent a macro's keystrokes into whatever window happened to be focused (they landed
  // in the chat window and were submitted as a message). Typing blind is never acceptable: keystrokes
  // are irreversible and can hit anything, so an unconfirmed focus must stop the step.
  deps.jlog('UI › could NOT confirm ' + appName + ' frontmost (last saw: ' + (last || 'nothing') + ') — refusing to type blind');
  return { ok: false, say: 'I could not bring ' + appName + ' to the front, Sir' + (last ? ' — ' + last + ' still has focus' : '') + ', so I stopped rather than typing into the wrong window.' };
}

async function focus_app(args) {
  const r = await focusApp(String(args.name || args.app || args.target || ''));
  if (r.ok) { lastFocusedApp = r.app; noteEnt(r.app); return ok(r.say, { data: { app: r.app }, app: r.app, entity: r.app }); }
  return fail(r.say);
}
// Apps JARVIS must never type into: its own chat window, and the terminal/editor running it. Text
// aimed at another app landing here is not a cosmetic bug — a stray Return submits it as a command.
const NEVER_TYPE_INTO = /^(Claude|Terminal|iTerm2?|Warp|Code|Visual Studio Code|Cursor|Electron)$/i;
// The app focus_app/search_in_app last brought forward — used as the default expectation for
// subsequent keystrokes so the safety check does not depend on the planner remembering to pass it.
let lastFocusedApp = '';

async function type_text(args) {
  const text = String(args.text || args.query || '');
  if (!text) return fail('Nothing to type, Sir.');
  // Focus can drift between steps (an app finishes launching, a dialog steals it), so the target is
  // re-checked immediately before the keystrokes rather than trusting an earlier focus_app.
  const front = await frontmostApp();
  // FAIL CLOSED. If the frontmost app cannot be read (System Events loses Accessibility, the query
  // times out, anything), we do NOT know where the keystrokes will land — and "don't know" must mean
  // "don't type". This exact hole let a test string get typed into the chat window: the old check was
  // `if (want && front && ...)`, so an empty `front` skipped the guard entirely instead of blocking.
  if (!front) return fail('I cannot tell which window has focus right now, Sir, so I will not type — that is how text ends up in the wrong place. (System Events needs Accessibility.)');
  // Defaults to whatever focus_app/search_in_app last brought forward, so the guard works even when
  // the planner does not think to pass an app — the model should not be what stands between a
  // keystroke and the wrong window.
  const want = String(args.app || args.expect || lastFocusedApp || '').trim();
  if (want && front && !sameApp(front, want)) {
    return fail('I stopped, Sir — ' + front + ' has focus, not ' + want + ', and I will not type into the wrong window.');
  }
  if (!want && front && NEVER_TYPE_INTO.test(front)) {
    return fail('I stopped, Sir — ' + front + ' has focus and typing into it could fire off something unintended. Tell me which app to type into.');
  }
  if (!(await uiBegin())) return fail('Screen control agent is not reachable, Sir — check the JarvisControl agent is running.');
  const r = await controlReq('POST', '/do', { action: 'type', text });
  await uiEnd();
  if (!r || !r.ok) return fail(uiDenied(r));
  return ok('Typed it, Sir.', { data: { typed: text, into: front || null } });
}
async function press_key(args) {
  const spec = String(args.key || args.text || args.spec || '').trim();
  if (!spec) return fail('Which key, Sir?');
  // Same reasoning as type_text: a stray Return or ⌘-something in the wrong window can fire off
  // something irreversible.
  const pkFront = await frontmostApp();
  // Same fail-closed rule as type_text — a stray Return in an unknown window can submit anything.
  if (!pkFront) return fail('I cannot tell which window has focus right now, Sir, so I will not send that keystroke.');
  const pkWant = String(args.app || args.expect || lastFocusedApp || '').trim();
  if (pkWant && pkFront && !sameApp(pkFront, pkWant)) {
    return fail('I stopped, Sir — ' + pkFront + ' has focus, not ' + pkWant + '.');
  }
  if (!pkWant && pkFront && NEVER_TYPE_INTO.test(pkFront)) {
    return fail('I stopped, Sir — ' + pkFront + ' has focus and a stray keystroke there could fire something unintended.');
  }
  if (!(await uiBegin())) return fail('Screen control agent is not reachable, Sir.');
  const r = await controlReq('POST', '/do', { action: 'key', text: spec });
  await uiEnd();
  if (!r || !r.ok) return fail(uiDenied(r));
  return ok('Pressed ' + spec + ', Sir.', { data: { key: spec } });
}
// CGEvents post successfully but do NOTHING when Accessibility is missing, so a silent no-op is the
// expected failure — say so explicitly instead of reporting a hollow success.
function uiDenied(r) {
  if (r && r.trusted === false) return 'I cannot control the keyboard yet, Sir — JarvisControl needs Accessibility. System Settings → Privacy & Security → Accessibility, then switch JarvisControl on (remove and re-add it if it is already listed — a rebuild invalidates the old entry).';
  if (r && r.stopped) return 'Screen control was stopped, Sir — say it again to restart.';
  if (r && r.unreachable) return 'Screen control agent is not reachable, Sir — the JarvisControl agent may not be running.';
  return 'The keystroke did not go through, Sir.';
}

// REAL activation for the browser tools, exported so browser.js can reach it.
//
// WHY THIS HAD TO EXIST: a page-JS `el.click()` carries no user activation —
// navigator.userActivation.hasBeenActive stays false — and every media, clipboard, fullscreen and
// download control on the web is gated on exactly that. Measured on Spotify's web player: clicking
// the correct play button synthetically did nothing at all, and no <audio> element was ever created.
// The click was landing; the browser was refusing to treat it as a gesture. A CGEvent keystroke is a
// genuine one.
//
// WHY A KEYSTROKE AND NOT A COORDINATE CLICK: a real click at x,y works, but it is knocked off target
// by anything that moves the pointer or the page — a hand on the trackpad, a late-loading image, a
// resized window, browser zoom. A keystroke goes to whatever the page has FOCUSED, so there is no
// coordinate to miss. Verified live: focus the play control, press Return, the track changes and the
// playback clock advances.
//
// Focus is verified before anything is pressed, exactly as type_text does — a Return sent to the
// wrong window is not a cosmetic failure.
async function realKey(spec, expectApp) {
  const want = String(expectApp || '').trim();
  const front = await frontmostApp();
  if (!front) return { ok: false, say: 'I cannot tell which window has focus right now, Sir, so I will not send that keystroke.' };
  if (want && !sameApp(front, want)) return { ok: false, say: 'I stopped, Sir — ' + front + ' has focus, not ' + want + '.' };
  if (!(await uiBegin())) return { ok: false, say: 'Screen control agent is not reachable, Sir.' };
  try {
    const r = await controlReq('POST', '/do', { action: 'key', text: String(spec || 'return') });
    if (!r || !r.ok) return { ok: false, say: uiDenied(r) };
    return { ok: true };
  } finally { await uiEnd(); }
}

// Per-app search entry point. Most Mac apps focus their search field with ⌘F, but the ones Mihir
// actually asks for often differ, so the exceptions are listed rather than assumed.
const SEARCH_KEY = {
  // Browsers: ⌘L focuses the address bar, which searches via the default engine.
  'Safari': 'cmd+l', 'Google Chrome': 'cmd+l', 'Firefox': 'cmd+l', 'Arc': 'cmd+l', 'Microsoft Edge': 'cmd+l', 'Brave Browser': 'cmd+l',
  // Apple apps whose ⌘F is a *find-in-page* rather than a search field need ⌥⌘F instead.
  'Mail': 'cmd+alt+f', 'Notes': 'cmd+alt+f',
  // Everything below focuses a real search field with plain ⌘F.
  'App Store': 'cmd+f', 'Finder': 'cmd+f', 'Music': 'cmd+f', 'TV': 'cmd+f', 'Podcasts': 'cmd+f',
  'System Settings': 'cmd+f', 'Maps': 'cmd+f', 'Photos': 'cmd+f', 'Messages': 'cmd+f',
  'Calendar': 'cmd+f', 'Reminders': 'cmd+f', 'Contacts': 'cmd+f', 'Freeform': 'cmd+f',
  'Spotify': 'cmd+k', 'Slack': 'cmd+k', 'Discord': 'cmd+k', 'Notion': 'cmd+p', 'Obsidian': 'cmd+o',
  'Visual Studio Code': 'cmd+shift+f', 'WhatsApp': 'cmd+f',
};
// Apps with NO usable in-app keyboard search. Blind-typing into these is actively harmful: Roblox
// has no ⌘F, so the query went to its sidebar and opened Avatar instead of searching. Its own
// roblox:// deep link opens the app but does NOT run a search (verified), so the reliable route is
// the web catalogue — which finds the game and launches it in the app when clicked anyway.
const APP_SEARCH_WEB = {
  'Roblox': 'https://www.roblox.com/discover?Keyword=',
  'Steam': 'https://store.steampowered.com/search/?term=',
  'Epic Games Launcher': 'https://store.epicgames.com/en-US/browse?q=',
};

// Catalyst / UIKit-on-Mac apps need a longer beat before their search field accepts focus — with a
// short wait the query lands in the sidebar instead (observed: "action games" jumped App Store to
// Arcade). Native AppKit apps settle much faster, so they are not made to wait for no reason.
const CATALYST_APPS = /^(App Store|Messages|Maps|News|Home|Stocks|Voice Memos|Books|Podcasts|TV|Freeform|Weather)$/i;
// Games/Electron/launcher apps put a window up long before it is interactive.
const SLOW_APPS = /^(Roblox|Steam|Discord|Epic Games|Minecraft|Unity|Xcode|Photoshop|Illustrator|Blender|OBS)/i;
const searchSettleMs = app => (SLOW_APPS.test(app) ? 2500 : CATALYST_APPS.test(app) ? 1800 : 700);
// The whole point of the feature: "open the App Store and search for action games" in one step.
async function search_in_app(args) {
  const appQ = String(args.app || args.name || args.target || '').trim();
  const query = String(args.query || args.search || args.text || '').trim();
  if (!appQ) return fail('Which app should I search in, Sir?');
  if (!query) return fail('What should I search for, Sir?');
  // Decide the route BEFORE launching anything. Resolving the name is enough to know whether this
  // app can be driven by keyboard; calling focusApp() first would LAUNCH it, which is why Roblox was
  // opening the app AND the website when only the website was going to be used.
  const resolved = deps.fuzzyApp ? deps.fuzzyApp(appQ.replace(/\s+app$/i, '').trim()) : { name: appQ, score: 1 };
  const appName = (resolved && resolved.score >= 0.5) ? resolved.name : appQ;
  if (!SEARCH_KEY[appName] && APP_SEARCH_WEB[appName]) {
    const url = APP_SEARCH_WEB[appName] + encodeURIComponent(query);
    const opened = await openUrl(url);
    if (!opened) return fail('Could not open the ' + appName + ' search page, Sir.');
    deps.audit('search_in_app', { app: appName, query, via: 'web' }, 'ok');
    deps.jlog('UI › searched "' + query + '" for ' + appName + ' via web catalogue (app not launched)');
    return ok(appName + ' has no in-app search I can drive, Sir, so I searched its catalogue for “' + query + '” in your browser — opening a result launches it in the app.',
      { data: { app: appName, query, via: 'web' }, entity: appName });
  }
  if (!SEARCH_KEY[appName]) {
    return fail('I do not know how to search inside ' + appName + ', Sir — it has no search shortcut I can rely on, and guessing would type into the wrong place.');
  }

  if (!(await uiBegin())) return fail('Screen control agent is not reachable, Sir — is the JarvisControl agent running?');
  try {
    const f = await focusApp(appQ);
    if (!f.ok) return fail(f.say);
    lastFocusedApp = f.app;
    await sleep(1200);                                       // let the window finish coming forward
    const key = SEARCH_KEY[f.app];
    let r = await controlReq('POST', '/do', { action: 'key', text: key });
    if (!r || !r.ok) return fail(uiDenied(r));
    // The search field needs a real beat to take focus — with only ~500ms the query went to App
    // Store's SIDEBAR instead ("a" jumped to Arcade), because the field had not accepted focus yet.
    await sleep(searchSettleMs(f.app));
    await controlReq('POST', '/do', { action: 'key', text: 'cmd+a' });   // replace any existing query
    await sleep(300);
    r = await controlReq('POST', '/do', { action: 'type', text: query });
    if (!r || !r.ok) return fail(uiDenied(r));
    await sleep(500);
    if (args.submit !== false) await controlReq('POST', '/do', { action: 'key', text: 'return' });
    deps.audit('search_in_app', { app: f.app, query }, 'ok');
    deps.jlog('UI › searched "' + query + '" in ' + f.app);
    noteEnt(f.app);
    return ok('Searched ' + f.app + ' for “' + query + '”, Sir.', { data: { app: f.app, query }, entity: f.app });
  } finally { await uiEnd(); }
}

// Raw pointer primitives. JarvisControl has always supported these; the agent simply had no way to
// reach them. Coordinates are screen pixels — the loop should prefer keyboard tools, which are far
// more reliable without vision, and fall back to these only when there is no keyboard route.
async function click_at(args) {
  const x = Number(args.x), y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('I need x and y coordinates to click, Sir.');
  if (!(await uiBegin())) return fail('Screen control agent is not reachable, Sir.');
  const action = args.double ? 'double' : args.right ? 'right' : 'click';
  const r = await controlReq('POST', '/do', { action, x, y });
  await uiEnd();
  if (!r || !r.ok) return fail(uiDenied(r));
  return ok('Clicked at ' + x + ', ' + y + ', Sir.', { data: { x, y, action } });
}
// ---------------- native-app element lane (accessibility) ----------------
//
// The counterpart to browser_elements/browser_click, for apps that are not a web page. Screen
// control used to mean: screenshot, ask a vision model where the button is, click those pixels —
// and the local model cannot place coordinates (asked for a button at 537,667 it answered 370,742
// twelve times running). This lane removes the guessing entirely: macOS publishes the real control
// tree, so JARVIS reads labels and presses one BY INDEX.
//
// The listing's fingerprint is kept and sent back with the press. That is not ceremony: measured
// during development, a list taken while TextEdit was frontmost and a press issued a moment later
// pressed "Window" in a DIFFERENT application, because focus had moved and index 5 meant something
// else there. The fingerprint turns that into a refusal.
let lastAx = { fingerprint: '', app: '', count: 0, at: 0 };
let lastAxApp = '';

async function screen_elements(args) {
  // Pin the app by name when we know it. Frontmost drifts between the list and the press; a named
  // app does not.
  const want = String((args && (args.app || args.name)) || '').trim();
  lastAxApp = want || lastAxApp;
  const r = await controlReq('GET', '/elements' + (want ? '?app=' + encodeURIComponent(want) : ''));
  if (r && r.unreachable) return fail('My control agent is not responding, Sir — is JarvisControl running?');
  if (r && r.trusted === false) return fail('JarvisControl does not have Accessibility permission, Sir — grant it in System Settings › Privacy & Security › Accessibility.');
  if (!r || !r.ok) return fail('Could not read the screen, Sir.');
  const els = r.elements || [];
  if (!els.length) return ok('Nothing actionable is exposed by “' + (r.app || 'that app') + '”, Sir — it may be a web view, which the browser tools handle instead.', { data: { app: r.app, elements: [] } });
  lastAx = { fingerprint: r.fingerprint || '', app: r.app || '', count: els.length, at: Date.now() };
  const lines = els.slice(0, 40).map(e => '[' + e.i + '] ' + e.role.replace(/^AX/, '') + ' — ' + e.label);
  return ok('On “' + r.app + '”, Sir:\n' + lines.join('\n') +
    (els.length > 40 ? '\n(' + (els.length - 40) + ' more)' : ''),
    { listing: true, data: { app: r.app, fingerprint: r.fingerprint, elements: els } });
}

async function screen_press(args) {
  const i = Number(args && (args.i != null ? args.i : args.index));
  if (!Number.isInteger(i) || i < 0) return fail('Which element, Sir? Give me its number from the list.');
  if (!lastAx.fingerprint) return fail('I have not listed that app yet, Sir — let me look at it first.');
  if (!(await uiBegin())) return fail('Screen control agent is not reachable, Sir.');
  const r = await controlReq('POST', '/press', { i, fingerprint: lastAx.fingerprint, app: lastAx.app || lastAxApp });
  await uiEnd();
  if (r && r.stale) {
    lastAx = { fingerprint: '', app: '', count: 0, at: 0 };
    return fail('The screen changed since I listed it, Sir — let me look again before pressing anything.');
  }
  if (!r || !r.ok) return fail(uiDenied(r));
  return ok('Pressed “' + (r.label || ('element ' + i)) + '” in ' + (r.app || 'that app') + ', Sir.', { data: r });
}

// INSTALL AN APP FROM A STORE — the capability that did not exist.
//
//     ◆ open the app store and install among us
//       UI › searched "among us" in App Store
//       Agent › done in 7316ms — ✓ search in app
//
// It searched, stopped, and called that success. There was no install step anywhere in this file to
// reach, and nothing checked that the request had actually been carried out.
//
// WHY ONE TOOL RATHER THAN THREE PLAN STEPS. Which control installs an app is a property of the
// SCREEN — "Get", "Install", a cloud-with-a-down-arrow, "Open" if it is already installed, or a
// price — so the number to press cannot be written into a plan in advance. It has to be chosen from
// what is on screen at the time, which means the choice lives inside the tool.
//
// AND THE CHOICE IS A SELECTION, NOT A WORD LIST. Matching control labels against Get|Install|
// Download would be a keyword trap on an open class — Apple has changed that wording before and
// localises it. The controls are numbered and the model picks one, which is the thing a 3B does
// reliably; factmatch.js measures the same question both ways (yes/no 6/16, selection 15/16).
//
// IT DOES NOT SPEND MONEY. A paid app's control names a price, and the prompt says to answer 0 for
// that — the same rule as BUYING_STOPS_AT_BASKET in playbook.js. Pressing Get on a free app is the
// request he made; authorising a purchase is not, and if macOS asks for a password that dialog is
// his to answer.
// WHERE DOES THIS ACTUALLY COME FROM? — asked of the registries, not assumed.
//
// The first version of install_app hardcoded the App Store, and he was right that this is the same
// mistake in a new place: "install" does not name a source. Among Us is not on the Mac App Store at
// all (the iTunes search for it returns MultiCraft and WhatsApp) and not in Homebrew either, so the
// original request could never have succeeded however well the button-pressing worked. A hardcoded
// destination cannot report that; it can only fail inside it.
//
// So both registries are ASKED. Each is a registry the machine owns or can query directly — the
// permitted kind of list — and neither is a guess about language:
//
//   Homebrew          `brew search --cask/--formula`, the local package index
//   Mac App Store     the public iTunes Search API, entity=macSoftware, which also gives the PRICE
//
// What is deliberately NOT here: fetching a project's web page and executing the shell command
// printed on it. He suggested it and it is the one step I will not automate — a command scraped
// from a page is arbitrary code chosen by whoever controls that page, and `curl … | sh` from a
// source the model picked is the exact shape of a supply-chain compromise. Homebrew covers the same
// ground with a signed, audited index. Where brew does not have it, the honest move is to FETCH the
// documented command, show it, and let him run it — his decision, not a silent one.
const flat = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// IS THIS CANDIDATE ACTUALLY THE THING HE NAMED? — measured, with a floor.
//
// This is the guard whose absence installed the wrong software. From his screen:
//
//     ◆ install istapaper
//       "Installed “taskpaper” with Homebrew, Sir — it is in your Applications folder."
//
// Three of my own mistakes in one line. `brew search istapaper` returns TASKPAPER, because brew
// matches fuzzily. The iTunes search returned INSTAPAPER — the right answer, free, on the store —
// and I discarded it, because identity was a startsWith test and "instapaper" does not start with
// "istapaper". Then, with the correct answer thrown away and one wrong candidate left, a model was
// asked to pick from the list and picked it instead of answering 0. A model handed a list with no
// right answer in it will choose something; the list is the bug, not the choice.
//
// So identity is a NUMBER now, and nothing is installed below the floor. Two ways to score,
// whichever is stronger, and neither is a vocabulary:
//
//   spelling   1 - editDistance/length — tolerates the typo he actually made
//   prefix     the candidate begins with what he said, which is how store titles read
//
// Measured over 22 real pairs, the floor is flat from 0.75 to 0.90 at 22/22 with nothing wrongly
// accepted, so it sits in the middle:
//
//     istapaper  vs taskpaper     0.556   rejected
//     instapaper vs instaloader   0.727   rejected      <- brew's other fuzzy hit
//     istapaper  vs Instapaper    0.900   accepted      <- the typo, recovered
//     slack      vs Slack for Desktop  0.920 accepted
//     telegram   vs telegram      1.000   accepted
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function identityScore(query, cand) {
  const q = flat(query), c = flat(cand);
  if (!q || !c) return 0;
  const spelling = 1 - editDistance(q, c) / Math.max(q.length, c.length);
  // A prefix counts only when the query is most of a word rather than two letters of one.
  const prefix = c.startsWith(q) && q.length >= 4 ? 0.92 : 0;
  return Math.max(spelling, prefix);
}
const IDENT_FLOOR = 0.80;

function brewSearch(slug) {
  return new Promise(resolve => {
    execFile('/opt/homebrew/bin/brew', ['search', slug], { timeout: 25000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err && !out) return resolve([]);
      // One token per line, section headers ("==> Casks") skipped by shape.
      const toks = String(out || '').split('\n').map(s => s.trim())
        .filter(s => s && !s.startsWith('==>') && !/\s/.test(s));
      resolve(toks);
    });
  });
}
function brewIsCask(token) {
  return new Promise(resolve => {
    execFile('/opt/homebrew/bin/brew', ['info', '--cask', token], { timeout: 25000, maxBuffer: 1 << 20 },
      err => resolve(!err));
  });
}
function appStoreLookup(name) {
  return new Promise(resolve => {
    const url = 'https://itunes.apple.com/search?entity=macSoftware&limit=8&term=' + encodeURIComponent(name);
    const req = require('https').get(url, { timeout: 8000 }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try {
          const rs = (JSON.parse(b).results || []).map(r => ({
            name: String(r.trackName || ''), price: String(r.formattedPrice || ''), id: r.trackId,
          }));
          // SCORED, not prefix-tested. The prefix test threw away "Instapaper" for "istapaper".
          const scored = rs.map(r => Object.assign({}, r, { score: identityScore(name, r.name) }))
            .filter(r => r.score >= IDENT_FLOOR)
            .sort((a, b) => b.score - a.score);
          resolve(scored[0] || null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
  });
}

// Which of several candidate tokens is the thing he named? `brew search telegram` offers telegram,
// telegram-a, telegram-desktop and telegram-desktop@beta. Exact identity first — free, certain, and
// right most of the time — and the model picks from the numbered remainder only when it is not.
async function pickToken(query, tokens) {
  if (!tokens.length) return null;
  // THE FLOOR COMES FIRST, AND THAT IS THE WHOLE LESSON. Only candidates that could actually BE the
  // thing he named are eligible; the model is never shown a list it has to reject wholesale,
  // because when it was, it chose the wrong item instead of refusing.
  const eligible = tokens.map(t => ({ t, score: identityScore(query, t) }))
    .filter(x => x.score >= IDENT_FLOOR)
    .sort((a, b) => b.score - a.score);
  if (!eligible.length) return null;
  if (eligible[0].score === 1) return eligible[0].t;            // exact spelling: no model needed
  if (eligible.length === 1) return eligible[0].t;
  // Several plausible spellings ("telegram", "telegram-desktop", "telegram-a"): a selection among
  // candidates that have ALREADY passed identity, so the worst case is the wrong flavour of the
  // right app rather than a different app.
  const shortlist = eligible.slice(0, 10).map(x => x.t);
  const n = await askNumber(
    'A user asked to install "' + query + '" on a Mac. These are the package names available:\n' +
    shortlist.map((t, i) => (i + 1) + '. ' + t).join('\n') + '\n0. none of these is it\n\n' +
    'Which number is the ordinary desktop version of "' + query + '"? Reply with one number.',
    shortlist.length);
  return n ? shortlist[n - 1] : eligible[0].t;
}

async function resolveInstallSource(query) {
  const slug = flat(query);
  const [store, tokens] = await Promise.all([
    appStoreLookup(query),
    slug ? brewSearch(slug) : Promise.resolve([]),
  ]);
  const token = await pickToken(query, tokens);
  const cask = token ? await brewIsCask(token) : false;
  return { store, token, cask,
           storeScore: store ? store.score : 0,
           brewScore: token ? identityScore(query, token) : 0 };
}

function brewInstall(token, cask) {
  return new Promise(resolve => {
    const argv = cask ? ['install', '--cask', token] : ['install', token];
    execFile('/opt/homebrew/bin/brew', argv, { timeout: 600000, maxBuffer: 8 << 20 }, (err, out, errOut) => {
      resolve({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') });
    });
  });
}
function brewInstalled(token, cask) {
  return new Promise(resolve => {
    execFile('/opt/homebrew/bin/brew', cask ? ['list', '--cask', token] : ['list', token],
      { timeout: 30000 }, err => resolve(!err));
  });
}

// Present on disk? fuzzyApp answers "what is this called"; this answers "is it here", which are
// different questions — fuzzyApp hands back the query itself at score 0 when nothing matched.
function appIndexHas(name) {
  const n = flat(name);
  if (!n) return false;
  for (const d of ['/Applications', '/System/Applications', require('os').homedir() + '/Applications']) {
    try {
      for (const f of require('fs').readdirSync(d)) {
        if (f.endsWith('.app') && flat(f.replace(/\.app$/, '')) === n) return true;
      }
    } catch (e) {}
  }
  return false;
}

async function install_app(args) {
  const query = String((args && (args.query || args.name)) || '').trim();
  if (!query) return fail('Install what, Sir?');

  const src = await resolveInstallSource(query);

  // ALREADY INSTALLED IS A FACT, AND IT IS CHECKED BEFORE ANYTHING IS ATTEMPTED.
  //
  // This sat after the Homebrew branch and that ordering was itself a bug: asked to install Claude —
  // which is sitting in /Applications — it ran a real `brew install --cask claude` and reported
  // Homebrew's failure, because brew's own registry has no record of an app installed by hand. The
  // installed-app index knows, costs nothing, and mutates nothing, so it goes first. It also means
  // "it is already there" is never inferred from a store button reading "Open" instead of "Get".
  const wantName = (src.store && src.store.name) || query;
  if (appIndexHas(wantName) || appIndexHas(query)) {
    return ok('“' + wantName + '” is already installed, Sir — it is in your Applications folder. ' +
              'I have opened nothing and installed nothing.', { data: { via: 'already', app: wantName } });
  }

  // NOTHING HAS IT. This is the answer the hardcoded version could never give, and it is the true
  // answer for the request he actually made.
  if (!src.store && !src.token) {
    return fail('I cannot find “' + query + '” in the Mac App Store or in Homebrew, Sir — the two ' +
                'places I can install from safely. If it is a download from its own website, say so ' +
                'and I will open the page; I will not run an install command copied off a web page ' +
                'without showing it to you first.');
  }

  // A PAID APP IS HIS PURCHASE TO MAKE. Same rule as BUYING_STOPS_AT_BASKET.
  if (src.store && /\d/.test(String(src.store.price || ''))) {
    return fail('“' + src.store.name + '” costs ' + src.store.price + ' on the App Store, Sir. ' +
                'I have opened nothing and pressed nothing — buying is yours to do.');
  }

  // WHICHEVER REGISTRY ACTUALLY MATCHES BETTER — not whichever was checked first.
  //
  // Brew used to win merely by having a token, which is how a 0.556 match (taskpaper) beat a 0.900
  // match (Instapaper) for "istapaper". The scores decide now; a tie goes to Homebrew because its
  // result can be verified with `brew list` rather than by reading pixels off a store window.
  const preferBrew = src.token && src.brewScore >= src.storeScore;

  // AN INEXACT MATCH ASKS FIRST. Installing is mutating and hard to take back, and "istapaper" is
  // exactly the case: the best candidate is probably right and is definitely not what he typed. A
  // question here costs one turn; getting it wrong costs an uninstall and his trust.
  const bestName = preferBrew ? src.token : (src.store && src.store.name);
  const bestScore = preferBrew ? src.brewScore : src.storeScore;
  if (bestName && bestScore < 1 && !(args && args.confirmed)) {
    return needsConfirm('install_app', { query: bestName, confirmed: true },
      'You said “' + query + '”, Sir — the closest I can find is “' + bestName + '”' +
      (preferBrew ? ' in Homebrew' : ' on the App Store') + '. Install that?');
  }

  // HOMEBREW WHEN IT MATCHES AT LEAST AS WELL, because it is one command and it can be VERIFIED,
  // against an App Store UI that has to be driven by pressing pixels.
  if (preferBrew) {
    if (await brewInstalled(src.token, src.cask)) {
      return ok('“' + src.token + '” is already installed, Sir — nothing to do.', { data: { via: 'brew', token: src.token, already: true } });
    }
    if (deps.jlog) deps.jlog('Install › ' + query + ' → brew ' + (src.cask ? '--cask ' : '') + src.token);
    const r = await brewInstall(src.token, src.cask);
    const really = await brewInstalled(src.token, src.cask);
    if (deps.audit) deps.audit('install_app', { via: 'brew', token: src.token, cask: src.cask }, really ? 'ok' : 'FAIL');
    // READ IT BACK, ALWAYS. brew exits 0 on plenty of things that did not end with software
    // installed, and "reported success for half a job" is the bug this whole tool exists to fix.
    if (really) {
      return ok('Installed “' + src.token + '” with Homebrew, Sir' + (src.cask ? ' — it is in your Applications folder.' : '.'),
                { data: { via: 'brew', token: src.token, cask: src.cask } });
    }
    const why = (r.err || r.out || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
    return fail('Homebrew did not finish installing “' + src.token + '”, Sir, and it is not on the ' +
                'system' + (why ? ' — ' + why.slice(0, 200) : '') + '. Nothing was left half-done that I can see.');
  }

  // The App Store UI path: it is the only route for what only the store carries.
  const store = 'App Store';
  const s = await search_in_app({ app: store, query: src.store ? src.store.name : query });
  if (!s || s.ok === false) return s || fail('Could not open ' + store + ', Sir.');

  // FOCUS BEFORE READING, OR YOU READ THE WRONG APP.
  //
  // screen_elements takes an `app` argument and the control agent IGNORES it for reads — it returns
  // whatever is frontmost. That is how this failed on his screen with the Get button plainly
  // visible: he asked from the Claude window, so the read came back with nine elements belonging to
  // CLAUDE — its menu bar — and no install control among them, and the picker correctly answered
  // "none of these" about a list that never contained the answer. Measured, same page, same moment:
  //
  //     screen_elements({app:'App Store'})        → app "Claude",    9 elements
  //     focus_app('App Store') then the same call → app "App Store", 37 elements,
  //                                                 [23] Button — "Get, In-App Purchases"
  //
  // So the store is brought forward first, and WHAT CAME BACK IS CHECKED against what was asked
  // for. A read of the wrong app is a different failure from a store with no install button, and
  // conflating them is what produced a reply about prices when the truth was a focus problem.
  await focus_app({ name: store });
  let els = null, listing = null, readApp = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1200));
    listing = await screen_elements({ app: store });
    readApp = String((listing && listing.data && listing.data.app) || '');
    els = (listing && listing.data && listing.data.elements) || [];
    if (els.length && identityScore(store, readApp) >= IDENT_FLOOR) break;
  }
  if (!els || !els.length) {
    return fail('I searched ' + store + ' for “' + query + '” and then could not read any controls at ' +
                'all, Sir — nothing was installed. JarvisControl is either not running or has no ' +
                'Accessibility permission.');
  }
  if (identityScore(store, readApp) < IDENT_FLOOR) {
    return fail('I searched ' + store + ' for “' + query + '”, Sir, but when I went to read the buttons ' +
                'the frontmost window was ' + (readApp || 'something else') + ', not ' + store + ' — so I ' +
                'was looking at the wrong app and pressed nothing. Try again with ' + store + ' in front.');
  }

  const shortlist = els;
  const pick = await pickInstallControl(wantName, shortlist);
  // EVERY FAILURE FROM HERE NAMES ITS OWN REASON. The old message offered three at once — "it names
  // a price, or it is already installed" — which is three guesses wearing one sentence, and all
  // three were wrong: the real reason was that it had read Claude's menu bar.
  const seen = shortlist.filter(e => /button/i.test(String(e.role || '')))
    .map(e => '“' + e.label + '”').slice(0, 6).join(', ');
  if (!pick) {
    return fail('I read ' + els.length + ' controls on ' + store + ' for “' + query + '”, Sir, and could ' +
                'not identify an install button that belongs to “' + wantName + '” — so I pressed ' +
                'nothing. A results page gives every app its own identical “Get”, and pressing the ' +
                'wrong one installs the wrong app. The buttons were ' + (seen || 'none at all') + '. ' +
                'If the page shows “Open” it is already installed.');
  }
  const chosen = pick;

  const pressed = await screen_press({ i: chosen.i });
  if (!pressed || pressed.ok === false) {
    return pressed || fail('I found the “' + chosen.label + '” button for “' + query + '” but could not ' +
                           'press it, Sir. Nothing was installed.');
  }

  // A PRESS IS NOT AN INSTALL, AND THIS IS WHERE IT USED TO LIE.
  //
  // It pressed "Categories" and said "Installing now — it may take a moment", which was a claim
  // about the future standing in for evidence about the present. The app either turns up in
  // /Applications or it does not, and there is no reason to guess: wait for it, and say exactly
  // what is true at the end of the wait.
  let arrived = false, gate = null;
  for (let waited = 0; waited < 90 && !arrived; waited += 3) {
    await new Promise(r => setTimeout(r, 3000));
    arrived = appIndexHas(wantName) || appIndexHas(query);
    // THE STORE ASKS FOR TOUCH ID, AND THAT IS AN ANSWER, NOT A TIMEOUT.
    //
    // Measured: pressing Get put up an authorisation prompt, nothing installed, and the reply was
    // ninety seconds of silence followed by a guess ("either still downloading, or waiting on your
    // Apple ID"). The prompt is a MODAL, and a modal has its own role — Sheet or Dialog, which is
    // AppKit's vocabulary and not mine — so it can be seen rather than inferred.
    //
    // I DO NOT TOUCH IT. Authorising a purchase or install is his fingerprint and his password; no
    // part of this presses anything on that sheet. It is detected so the reason can be stated
    // exactly and he can act on it, which is the whole difference between a report and a shrug.
    if (!arrived && !gate && waited >= 3) {
      try {
        const look = await screen_elements({ app: store });
        const now = (look && look.data && look.data.elements) || [];
        if (now.some(e => /sheet|dialog/i.test(String(e.role || '')))) {
          gate = now.filter(e => String(e.role || '').replace(/^AX/, '') === 'Button'
                                 && String(e.label || '').trim())
                    .map(e => '“' + e.label + '”').slice(0, 6).join(', ');
        }
      } catch (e) {}
    }
  }
  if (deps.audit) deps.audit('install_app', { app: store, query, control: chosen.label }, arrived ? 'ok' : 'FAIL');
  if (arrived) {
    return ok('Installed “' + wantName + '” from the ' + store + ', Sir — I pressed “' + chosen.label +
              '” and it is now in your Applications folder.',
              { data: { store, query, control: chosen.label, verified: true } });
  }
  if (gate) {
    return fail('I pressed “' + chosen.label + '” for “' + wantName + '”, Sir, and the ' + store + ' is ' +
                'now asking you to authorise it — Touch ID or your Apple ID password. That one is ' +
                'yours: I will not put a fingerprint or a password in for you. Confirm it on your Mac ' +
                'and it will install. The prompt is offering ' + (gate || 'no buttons I can read') + '.',
                { data: { store, query, control: chosen.label, awaitingAuth: true } });
  }
  // NO APP, AND NO PROOF EITHER WAY ABOUT WHY — so claim neither.
  //
  // An earlier version of this line said "with no authorisation prompt on screen either", and that
  // was a false negative dressed as an observation. A Mac App Store install asks for TOUCH ID, and
  // that prompt does not live in the App Store's accessibility tree — it belongs to a separate
  // system process, so failing to find a sheet inside the store proves nothing at all. Worse, by
  // the time that read happened the front window had drifted, and it reported the zoom button of
  // whatever was frontmost as though it were the store's controls.
  //
  // What IS certain: the button was pressed, the app is not there, and the one step that always
  // stands between the two is his fingerprint — which I will not and cannot supply. So the reason is
  // stated as the requirement it is, the front window is named as an observation rather than a
  // conclusion, and nothing is asserted about a prompt I cannot see.
  let front = '';
  try {
    const look = await screen_elements({});
    front = String((look && look.data && look.data.app) || '');
  } catch (e) {}
  return fail('I pressed “' + chosen.label + '” on ' + wantName + '\u2019s own row in the ' + store + ', Sir, ' +
              'and ninety seconds later it is still not in your Applications folder. A Mac App Store ' +
              'install needs your Touch ID or Apple ID password, and that prompt is not something I ' +
              'can see or answer — if it is waiting, authorise it and the download will finish on its ' +
              'own.' + (front && identityScore(store, front) < IDENT_FLOOR
                ? ' For what it is worth, the front window just now was ' + front + ', not the ' + store + '.'
                : '') +
              ' I am not going to tell you it is installed when I cannot see it.');
}

// ASK THE LOCAL MODEL FOR ONE NUMBER, with a refusal option, and accept nothing else.
//
// Every model question in this file that used to be a judgement is now a selection, because that is
// what a 3B does reliably — measured twice, in factmatch.js (yes/no 6/16 against selection 15/16)
// and again here. The return is validated against the range, so a hallucinated answer becomes null
// rather than a wrong press: the model can choose among what it was shown, refuse, or be ignored.
function askNumber(prompt, max) {
  // What may share memory is decided first (ollama.makeRoomFor — a heavy model alone).
  return require('./ollama.js').makeRoomFor(deps.llmModel || 'qwen2.5:3b-instruct-q4_K_M').then(() => new Promise(resolve => {
    const body = Buffer.from(JSON.stringify({
      model: deps.llmModel || 'qwen2.5:3b-instruct-q4_K_M', prompt, stream: false, keep_alive: deps.keepAlive,
      options: { temperature: 0, num_ctx: Number(deps.numCtx) || 8192, num_predict: 5, use_mmap: true },   // mmap: see ollama.js USE_MMAP
    }));
    const req = require('http').request({
      host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try {
          const m = String(JSON.parse(b).response || '').match(/-?\d+/);
          if (!m) return resolve(null);
          const n = Number(m[0]);
          resolve(n === 0 ? 0 : (n >= 1 && n <= max ? n : null));
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end(body);
  }));
}

// WHICH CONTROL INSTALLS IT? — buttons only, ranked by meaning, and allowed to refuse.
//
// The 3B picked "Categories" out of a 37-item list and the tool then announced it was installing.
// Two failures, and the numbered-selection prompt was only the second one. The first was the LIST:
// it contained cells, groups, radio buttons, disclosure triangles and the menu bar, and an install
// control is none of those. Asking any model to find one button among thirty-seven mixed elements
// is a question nobody should be asked.
//
//   1. ROLE FIRST, which is the machine's own closed vocabulary and not a guess about language. An
//      install control is a Button. On the Instapaper page that takes 37 elements down to 3.
//   2. THEN MEANING, over the surviving labels, with a margin and the right to abstain — the same
//      machinery as every other classifier here. "Get, In-App Purchases" belongs to one region and
//      "Categories", "Filters", "Mihir Kapoor" belong to another, and no list of words decides
//      it; the labels are embedded and compared.
//   3. AND THE PRESS IS VERIFIED, because a press is not an install. See install_app.
const ACQUIRE_EXEMPLARS = {
  acquire: ['Get', 'Install', 'Download', 'Get, In-App Purchases', 'Install this app',
            'Download this app', 'Get app'],
  // Everything else a store window offers. Navigation, the account, the window furniture.
  other: ['Categories', 'Filters', 'Discover', 'Arcade', 'Updates', 'Search', 'Back', 'Forward',
          'Account', 'Sign In', 'Share', 'Close', 'Minimise', 'Zoom', 'Open', 'Report a Problem',
          'See All', 'More', 'Play', 'Work', 'Create', 'Develop'],
};
const ACQUIRE_MIN_MARGIN = 0.05;
let _acquire = null;
function acquireClassifier() {
  if (!_acquire) {
    const intent = require('./intent.js');
    _acquire = intent.makeClassifier({
      exemplars: ACQUIRE_EXEMPLARS, minMargin: ACQUIRE_MIN_MARGIN, none: 'other',
      label: 'Install control', jlog: () => {},
    });
  }
  return _acquire;
}

// EVERY RESULT ROW HAS ITS OWN "GET", SO THE LABEL CANNOT BE WHAT DECIDES.
//
// A search leaves four apps on screen and four identical buttons, in document order:
//
//     22  Group   "Instapaper, News, four and three quarters stars"
//     23  Button  "Get, In-App Purchases"      <- the one he asked for
//     24  Group   "Cubox: AI Read-It-Later App, Save Once. Know Forever., five stars"
//     25  Button  "Get, In-App Purchases"      <- a competitor's
//     26  Group   "Anybox - Bookmark & Read Later, …"
//     27  Button  "Get, In-App Purchases"
//
// Ranking by label picks one of four indistinguishable strings, which is a one-in-four chance of
// installing somebody else's app — and after "install istapaper" installed TaskPaper, that is not a
// chance worth taking. The row it belongs to is the element BEFORE it, so the button is identified
// by ownership: nearest preceding non-button label, its app name being the part before the first
// comma, scored against what is being installed by the same identity measure used to choose the
// package. Document order and a delimiter are structure; the score is measured; nothing is a list.
//
// Returns { i, label, owner } of the control to press, or null.
async function pickInstallControl(query, els) {
  const isButton = e => String(e.role || '').replace(/^AX/, '') === 'Button';
  const classify = acquireClassifier();
  const out = [];
  for (let k = 0; k < els.length; k++) {
    const e = els[k];
    if (!isButton(e) || !String(e.label || '').trim()) continue;
    let r = null;
    try { r = await classify(String(e.label)); } catch (r2) { r = null; }
    if (!r || r.id !== 'acquire') continue;
    // Whose row is this? The nearest label above it that is not itself a button.
    let owner = '';
    for (let j = k - 1; j >= 0; j--) {
      if (isButton(els[j])) continue;
      const lab = String(els[j].label || '').trim();
      if (lab) { owner = lab; break; }
    }
    const ownerName = owner.split(',')[0].trim();
    out.push({ i: e.i, label: e.label, owner: ownerName, sim: r.sim,
               ownerScore: ownerName ? identityScore(query, ownerName) : 0 });
  }
  if (!out.length) return null;
  // One button and no competition: ownership does not have to be proven.
  if (out.length === 1) return out[0];
  const owned = out.filter(x => x.ownerScore >= IDENT_FLOOR).sort((a, b) => b.ownerScore - a.ownerScore);
  // SEVERAL ACQUIRE BUTTONS AND NONE PROVABLY HIS: refuse. Pressing the best-looking of four
  // identical labels is how the wrong app gets installed.
  return owned.length ? owned[0] : null;
}

// REMOVING SOMETHING — the mirror of install_app, and deliberately more cautious.
//
// Same evidence-based resolution: ask what is actually on the machine rather than assume a source.
// Two places something can have come from, and they are removed differently:
//
//   Homebrew        `brew uninstall` / `--cask`, which also clears the Caskroom. This matters: when
//                   he dragged TaskPaper out of /Applications by hand, brew still had the cask
//                   registered and its app bundle sitting in the Caskroom. Half-removed.
//   /Applications   moved to the TRASH, never deleted. An uninstall he did not mean is one drag back
//                   out of the bin; an `rm -rf` is a restore from backup. Nothing here deletes.
//
// THREE THINGS IT REFUSES. Anything under /System (structural — a path prefix, not a list of app
// names), JARVIS itself, and anything it cannot identify with the same scored identity that install
// uses. "install istapaper" installing TaskPaper was bad; "uninstall istapaper" REMOVING something
// arbitrary would be worse, and the same floor stops it.
//
// AND IT ALWAYS ASKS FIRST, even on an exact match, which install does not. Installing the wrong
// thing wastes a download; removing the wrong thing loses work.
function brewInstalledList(cask) {
  return new Promise(resolve => {
    execFile('/opt/homebrew/bin/brew', cask ? ['list', '--cask'] : ['list', '--formula'],
      { timeout: 30000, maxBuffer: 1 << 20 }, (err, out) => {
        if (err && !out) return resolve([]);
        resolve(String(out || '').split(/\s+/).map(x => x.trim()).filter(Boolean));
      });
  });
}
function appBundlePath(name) {
  const n = flat(name);
  for (const d of ['/Applications', require('os').homedir() + '/Applications']) {
    try {
      for (const f of require('fs').readdirSync(d)) {
        if (f.endsWith('.app') && flat(f.replace(/\.app$/, '')) === n) return d + '/' + f;
      }
    } catch (e) {}
  }
  return null;
}
function trashPath(abs) {
  return new Promise(resolve => {
    // Passed as argv, never interpolated into the script text.
    execFile('/usr/bin/osascript', ['-e', 'on run argv',
      '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      '-e', 'end run', abs], { timeout: 60000 }, err => resolve(!err));
  });
}

// WHICH INSTALLED THING IS THIS SENTENCE NAMING? — asked of what is installed, not carved out of
// the words by deletion.
//
// Every contiguous run of words in the clause is offered to the three things that could be removed —
// brew casks, brew formulae, and the app bundles on disk — longest first, and the best IDENTITY
// score wins. "get rid of discord", "remove slack from my mac" and "uninstall the notion app" all
// land on the same answer as "discord", "slack" and "notion" without anything being stripped,
// because the registry recognises the name wherever it sits in the sentence. A clause that names
// nothing installed scores nothing and is refused, which is the same abstention as everywhere else.
//
// This is appIn()'s method, applied to a different registry. It is the reason there is no regex here.
function installedIndex() {
  const apps = [];
  for (const d of ['/Applications', require('os').homedir() + '/Applications']) {
    try {
      for (const f of require('fs').readdirSync(d)) {
        if (f.endsWith('.app')) apps.push({ kind: 'app', name: f.replace(/\.app$/, ''), path: d + '/' + f });
      }
    } catch (e) {}
  }
  return apps;
}
function bestSpanMatch(clause, candidates) {
  const words = String(clause || '').trim().split(/\s+/).filter(Boolean);
  let best = null;
  for (let len = Math.min(6, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const span = words.slice(i, i + len).join(' ');
      for (const c of candidates) {
        const score = identityScore(span, c.name || c.token);
        if (score >= IDENT_FLOOR && (!best || score > best.score)) best = { c, span, score };
      }
    }
    if (best && best.score === 1) return best;      // an exact name needs no longer span
  }
  return best;
}

async function uninstall_app(args) {
  const query = String((args && (args.query || args.name)) || '').trim();
  if (!query) return fail('Uninstall what, Sir?');

  const [caskList, formulaList] = await Promise.all([brewInstalledList(true), brewInstalledList(false)]);
  const candidates = [
    ...caskList.map(t => ({ kind: 'cask', name: t, token: t })),
    ...formulaList.map(t => ({ kind: 'formula', name: t, token: t })),
    ...installedIndex(),
  ];
  const hit = bestSpanMatch(query, candidates);
  const cask = hit && hit.c.kind === 'cask' ? { t: hit.c.token } : null;
  const formula = hit && hit.c.kind === 'formula' ? { t: hit.c.token } : null;
  const bundle = hit && hit.c.kind === 'app' ? hit.c.path : null;

  if (!hit) {
    return fail('Nothing in “' + query + '” matches anything installed, Sir — I checked Homebrew and ' +
                'your Applications folder. Nothing was removed.');
  }

  // A path under /System is Apple's, not his, and not mine to bin.
  if (bundle && /^\/System\//.test(bundle)) {
    return fail('“' + query + '” is part of macOS, Sir — I will not remove it.');
  }
  // And this system does not uninstall itself. Tested against the RESOLVED name, not the sentence:
  // "uninstall jarvis search" names one thing and "remind me to uninstall something" names none.
  if (/jarvis/i.test(hit.c.name)) {
    return fail('That is me, Sir. If you want JARVIS gone, ~/JARVIS MK-1/security/uninstall.sh and ' +
                'the launchd agents are the honest way, and you should run them yourself.');
  }

  const via = cask ? 'Homebrew (cask “' + cask.t + '”)'
            : formula ? 'Homebrew (“' + formula.t + '”)'
            : 'the Trash';
  const what = hit.c.name;
  if (!(args && args.confirmed)) {
    return needsConfirm('uninstall_app', { query, confirmed: true },
      'Remove “' + what + '” via ' + via + ', Sir?' +
      (bundle && !cask && !formula ? ' It goes to the Trash, so it is recoverable.' : ''));
  }

  if (cask || formula) {
    const token = cask ? cask.t : formula.t;
    const isCask = !!cask;
    if (deps.jlog) deps.jlog('Uninstall › ' + query + ' → brew uninstall ' + (isCask ? '--cask ' : '') + token);
    await new Promise(resolve => {
      execFile('/opt/homebrew/bin/brew', isCask ? ['uninstall', '--cask', token] : ['uninstall', token],
        { timeout: 300000, maxBuffer: 8 << 20 }, () => resolve());
    });
    const stillThere = (await brewInstalledList(isCask)).some(t => t === token);
    if (deps.audit) deps.audit('uninstall_app', { token, cask: isCask }, stillThere ? 'FAIL' : 'ok');
    if (stillThere) {
      return fail('Homebrew still lists “' + token + '”, Sir — it did not come off. Nothing else was ' +
                  'touched.');
    }
    return ok('Removed “' + token + '” with Homebrew, Sir — the Caskroom copy is gone too, not just ' +
              'the one in Applications.', { data: { via: 'brew', token, cask: isCask } });
  }

  // A hand-installed app bundle. To the Trash, and read it back.
  if (deps.jlog) deps.jlog('Uninstall › ' + query + ' → Trash ' + bundle);
  const moved = await trashPath(bundle);
  const gone = !appBundlePath(query);
  if (deps.audit) deps.audit('uninstall_app', { bundle }, gone ? 'ok' : 'FAIL');
  if (!gone) {
    return fail('I could not move “' + query + '” to the Trash, Sir' +
                (moved ? '' : ' — Finder refused') + '. It is still in your Applications folder.');
  }
  return ok('Moved “' + query + '” to the Trash, Sir — it is out of Applications and recoverable ' +
            'from the bin if that was a mistake.', { data: { via: 'trash', bundle } });
}

async function scroll(args) {
  const amount = Number(args.amount != null ? args.amount : (String(args.direction || 'down').toLowerCase() === 'up' ? 300 : -300));
  if (!(await uiBegin())) return fail('Screen control agent is not reachable, Sir.');
  const r = await controlReq('POST', '/do', { action: 'scroll', amount });
  await uiEnd();
  if (!r || !r.ok) return fail(uiDenied(r));
  return ok('Scrolled, Sir.', { data: { amount } });
}

// Last-5 entity memory so a follow-up ("close it") resolves — mirrors server.js's recentEntities.
let recentEnts = [];
function noteEnt(e) { if (e) recentEnts = [e, ...recentEnts.filter(x => x !== e)].slice(0, 5); }

// ---------------- tool registry ----------------
// Closed whitelist. The planner may only emit these names, and every plan is
// re-validated against this table before a single step runs.
const TOOLS = {
  find_contact, send_message, open_whatsapp_chat, create_note, add_reminder, add_calendar_event, compose,
  focus_app, type_text, press_key, search_in_app, install_app, uninstall_app, click_at, scroll, screen_elements, screen_press,
  list_events, find_free_slot, find_businesses,
};
// Steps that reach the outside world / are not trivially undoable.
const CONFIRM_TOOLS = new Set(['send_message']);
const TOOL_HELP = {
  find_contact: 'find_contact{query} → {name,handle,phone,email}. Look someone up in Contacts. If the name is ambiguous this PAUSES and asks which one — never guess.',
  compose: 'compose{purpose, kind:"message"|"text", recipient?} → {text}. Write the actual words.',
  send_message: 'send_message{to or phone, body, name?, channel?:"whatsapp"|"imessage"}. Default channel is WhatsApp (needs a phone number); "imessage" needs to be requested explicitly (phone or email). Always confirmed by the user first.',
  open_whatsapp_chat: 'open_whatsapp_chat{phone or to, name?}. Opens WhatsApp to that person so the user can tap the call icon — there is no way to place the call automatically.',
  create_note: 'create_note{title,body}. Writes a new note in Notes.app.',
  add_reminder: 'add_reminder{title,when?}. Adds to Reminders.',
  add_calendar_event: 'add_calendar_event{title,when,minutes?}. Adds a Calendar event.',
  list_events: 'list_events{days?} → {events}. What is on the calendar in the next N days (default 7).',
  find_free_slot: 'find_free_slot{minutes?,days?,from?,to?,weekends?} → {start,end}. First free gap that fits. Chain into add_calendar_event via {{n.start}}.',
  find_businesses: 'find_businesses{what?,where?,withoutWebsite?,needPhone?} → {count,file}. Local businesses from OpenStreetMap, ' +
    'Google Maps and the web, with phone numbers and whether each has a website of its own; saves the full list as a file. ' +
    'what = the kind he named (leave out if none); where = the place he named (leave out when he means around himself); ' +
    'withoutWebsite true for ones without a website; needPhone true for only ones with a number. Call it once.',
  focus_app: 'focus_app{name}. Open an app and bring it to the front (verified).',
  search_in_app: 'search_in_app{app,query}. Open an app AND search inside it — use this for "open X and search for Y" in one step.',
  install_app: 'install_app{app?,query}. Install an app from a store — searches for it, then presses the control that ' +
    'downloads it. app defaults to "App Store". Stops without pressing anything if the control names a price.',
  uninstall_app: 'uninstall_app{query}. Remove an installed app — Homebrew if it came from there, otherwise to the ' +
    'Trash. Always asks first, never deletes outright, and refuses anything under /System.',
  type_text: 'type_text{text}. Type into whatever is focused right now.',
  press_key: 'press_key{key}. e.g. "return", "escape", "cmd+f", "cmd+t", "down".',
  click_at: 'click_at{x,y,double?,right?}. Click a screen position. Prefer keyboard tools when possible.',
  screen_elements: 'screen_elements{app?}. List the REAL controls of a native app (buttons, menus, fields) ' +
    'with numbers, read from macOS accessibility. Use this instead of guessing coordinates from a screenshot.',
  screen_press: 'screen_press{i}. Press control number i from screen_elements. Refuses if the screen changed since ' +
    'the list was taken — list it again in that case.',
  scroll: 'scroll{direction:"up"|"down"} or {amount}. Scroll the focused window.',
};

// ---------------- system tools bridge ----------------
// system_control.js already owns 24 real tools (files, apps, volume, screenshot, trash…) behind its
// own safety layer. The agent could not reach ANY of them before, which is why it fell over on
// anything outside three hardcoded patterns. They are injected by server.js (which owns the module)
// rather than required here, so the protected-path checks, confirm gates and audit log stay in one place.
let sysTools = {};            // name → async (args, ctx) => result
let sysHelp = {};             // name → one-line description for the planner prompt
function registerSystemTools(map, help) { sysTools = map || {}; sysHelp = help || {}; }
const allTools = () => Object.assign({}, sysTools, TOOLS);   // agent tools win on a name clash
function toolHelpLines(allow, extraHelp) {
  // extraHelp carries the per-goal external tools. They are merged LAST so a server can never
  // shadow the description of a built-in that shares its name.
  const merged = Object.assign({}, sysHelp, TOOL_HELP, extraHelp || {});
  // When a procedure scopes its tools, the help shrinks with the enum. Describing tools the model
  // is not permitted to pick is just a longer prompt with more ways to go wrong.
  return Object.keys(merged).filter(k => !allow || allow.includes(k))
    .map(k => '- ' + merged[k]).join('\n');
}

// Fills what a model-chosen message step left empty from what THIS run produced (see the call site in the loop).
// compose(kind message) → the strict composer on his own sentence; send_message → the body from the last successful compose
// and the recipient from the last successful find_contact, only when the model gave none. Pure: returns new args.
function threadMessageArgs(tool, args, steps, results, goal, reading) {
  const a = Object.assign({}, args || {});
  // The words to rewrite are the body the READER cut out of his sentence (any confidence — this is only a draft he approves).
  // Without one, the whole command goes in but may NOT come back as the message: the 3B echoes it word for word.
  if (tool === 'compose' && String(a.kind || '').toLowerCase() === 'message') {
    return reading && reading.body ? Object.assign(a, { strict: true, said: reading.body, message: String(goal || '') }, reading.reported ? { reported: true } : {})
                                   : Object.assign(a, { strict: true, said: String(goal || ''), message: String(goal || ''), noVerbatim: true });
  }
  if (tool !== 'send_message') return a;
  const lastOk = name => { for (let i = (steps || []).length - 1; i >= 0; i--) if (steps[i] && steps[i].tool === name && results[i] && results[i].ok) return results[i]; return null; };
  if (!String(a.body || '').trim()) {
    const c = lastOk('compose'), t = c && (c.text || (c.data && c.data.text));
    if (t) a.body = t;
  }
  // The recipient: from this run's lookup, when the model gave no number — and only if the name it gave (if any) IS that
  // contact. c12: the 3B put "ira" in `to` after finding Ira; a name is not a WhatsApp number. A different name
  // is left alone, or the card would show one person's name over another person's number.
  const f = lastOk('find_contact'), fv = k => (f ? (f[k] != null ? f[k] : (f.data && f.data[k])) : null);
  const cname = String(fv('name') || '').toLowerCase().trim();
  const named = String((waDigits(a.to) ? '' : a.to) || a.name || '').toLowerCase().trim();
  const same = !named || (!!cname && (cname === named || cname.split(/\s+/).includes(named)));
  if (f && same && !a.phone && !a.handle && !waDigits(a.to)) {
    for (const k of ['phone', 'handle']) { const v = fv(k); if (v != null) a[k] = v; }
    if (fv('name') != null) a.name = fv('name');
  }
  return a;
}

// ---------------- {{n.field}} chaining ----------------
// Lets step 3 use step 1's handle and step 2's composed text.
// Returns {args, missing}. A reference that CANNOT be resolved used to be passed through as the
// literal string "{{1.phone}}", which is the worst of both worlds: the tool receives a placeholder
// as though it were real data — a file named "{{1.missing}}", or a message addressed to one.
//
// It was also a hole in the invented-recipient guard, which trusts a step-reference precisely
// because it is supposed to mean "this value came from a real lookup". Since an unresolved ref
// still LOOKS like a ref, the guard waved it through. Unresolved references are now a hard failure,
// and callers must check `missing`.
function resolveRefs(args, results) {
  const out = {};
  const missing = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    out[k] = v.replace(/\{\{\s*(\d+)\s*\.\s*([a-zA-Z_][\w]*)\s*\}\}/g, (m, n, field) => {
      const r = results[Number(n) - 1];
      const val = r ? ((r[field] != null) ? r[field] : (r.data && r.data[field])) : null;
      if (val == null) { missing.push(m); return m; }
      return String(val);
    });
  }
  return { args: out, missing };
}

// ---------------- deterministic planners ----------------
// These cover the shapes Mihir actually uses and need NO model — so they work
// with Ollama down and never suffer a 3B mis-plan. The LLM planner is the fallback.
// Explicit "on/via/over whatsapp" is required to trigger the CALL feature (as opposed to messaging)
// — a bare "call X" is too easily an ordinary sentence ("call it a day", "call me back") to hijack
// safely, so this only fires when whatsapp is named outright.
// WhatsApp is the default messaging channel (Mihir's choice); saying "imessage"/"text"/"sms"
// explicitly switches it back. Kept as one function so server.js's capability prompt and this file
// agree on exactly the same rule.
const IMESSAGE_OVERRIDE_RE = /\b(?:imessage|i-message|apple\s*text|sms|text\s*message)\b/i;
const pickChannel = t => IMESSAGE_OVERRIDE_RE.test(t) ? 'imessage' : 'whatsapp';

// "open the app store and search for action games" — the exact shape that used to fail, where the
// whole tail got swallowed as an app name. Handled deterministically (no model) because it is both
// common and unambiguous. Only fires when the named target really resolves to an INSTALLED app, so
// "search cats on youtube" (a website, handled by server.js's site registry) is left alone.
// APP_SEARCH_RE AND APP_SEARCH_IN_RE WERE HERE — the last keyword trap in the router.
//
// They listed the ways of opening something — open|launch|start|fire up|boot|bring up|pull up|go to
// — and the ways of looking inside it — search|look|find|browse. "crank up spotify and search ar
// rahman" is in neither list, and the handoff named these two as the last real trap for that reason.
//
// They were harder to remove than CAL_LIST_RE because they were doing TWO jobs: deciding the shape
// AND cutting the app name out of capture group 1 (or 2, in the reversed form) to hand to
// resolvesToApp. Both halves already existed elsewhere and neither needed a pattern:
//
//   the shape  → shapeOf(), which has carried an `appsearch` region since the planning table went
//   the app    → appIn(), which offers every span of the sentence to the app registry, longest
//                first, and lets the REGISTRY say which one is an app
//
// So this is not a new classifier; it is two existing ones asked in the right order.
// "focus TextEdit and type hello" / "open Notes and write ..." — the word after the app is a
// TYPING verb, distinguishing it from the search shapes above.

function resolvesToApp(name, floor) {
  if (!deps.fuzzyApp) return null;
  const m = deps.fuzzyApp(String(name || '').replace(/\s+app$/i, '').trim());
  return (m && m.score >= (typeof floor === 'number' ? floor : 0.6)) ? m.name : null;
}

// CAL_LIST_RE AND FREE_SLOT_RE WERE HERE. They were right about the requirement and wrong about the
// method: calendar questions are common, unambiguous, and must NOT fall through to chat — which
// answered "I don't have direct access to your calendar" with the tools sitting unused. But they met
// that requirement by writing out the phrasings, so "am i busy today" was not a calendar question,
// and neither was "kal koi meeting hai kya".
//
// calintent.js asks instead. Measured on held-out phrasings: every calendar case clears the gate by
// at least 0.132 and the nearest wrong case ("what day is it" — a clock question in calendar
// clothes) reaches only 0.025. The old note's warning still holds and is now carried by an exemplar
// rather than by a pattern: "find me a free hour" must not be routed to FILE search on the strength
// of the bare verb "find", which is why `files` is one of the competing regions over there.
// "this week" / "today" / "next 3 days" → a day count for the calendar tools.
function windowDays(t) {
  const s = String(t || '').toLowerCase();
  const n = s.match(/next\s+(\d+)\s+days?/);
  if (n) return Math.min(60, Math.max(1, parseInt(n[1], 10)));
  if (/\btoday\b|\btonight\b/.test(s)) return 1;
  if (/\btomorrow\b/.test(s)) return 2;
  if (/\bthis month\b|\bnext month\b/.test(s)) return 30;
  if (/\bnext week\b/.test(s)) return 14;
  return 7;
}

// "open notes and calculator" / "open reminders and then open calculator" — TWO apps, one sentence.
//
// The single-action parser has nowhere to put a second app, so the whole tail became one name and
// open_app was handed "notes and open calculator", which fuzzy-matched to nothing useful. Downstream
// the request either died on "no app called…" or, worse, reached the loop and was offered for
// TEACHING — asking to be shown how to open two apps it can already open one at a time.
//
// Two determined steps instead, and only when BOTH halves resolve to applications actually installed
// here. That last condition is what keeps it narrow: "open youtube and search for kitkat" has a site
// on the left and no app on the right, so it never gets here and the site lanes keep it.

// ---------------------------------------------------------------------------
// THE SHAPE OF A COMMAND, ASKED RATHER THAN LISTED — and then read STRUCTURALLY.
//
// deterministicPlan below is a table of regexes, and every one of them enumerates the verbs a
// person might use. Measured on 32 realistic phrasings, sixteen missed:
//
//   "jump to textedit and type all clear"   APP_TYPE_RE lists focus|open|launch|switch to|go to|bring up
//   "knock up a note about food"            NOTE_RE lists write|compose|draft|make|create
//   "am i busy today"                       CAL_LIST_RE spells out whole phrasings
//   "crank up spotify and search ar rahman" APP_SEARCH_RE lists open|launch|start|fire up|boot|…
//
// Each miss falls through to the agentic loop, so nothing goes WRONG — it just takes twenty seconds
// instead of three hundred milliseconds, and the loop is where the flakier failures live.
//
// TWO SEPARATE JOBS, AND THE REGEXES WERE DOING BOTH. A pattern like APP_SEARCH_RE decides "is this
// an app-search?" AND pulls the app and the query out of the capture groups. Only the first is a
// keyword problem: WHICH KIND of request this is comes from the classifier now. The second is
// structure — where the pieces sit relative to the function words — and structure is not a word
// list. "and"/"then"/"for"/"about"/"on" are closed-class function words; the app registry is a
// closed set of things actually installed. Neither can be defeated by a phrasing nobody wrote down,
// which is the whole complaint about the verb lists.
//
// WHAT IS DELIBERATELY NOT DONE HERE. `call` and `message` need a PERSON out of the sentence, and
// there is no structural rule that separates "mama" from "a call" in "give mama a call on whatsapp"
// without either a verb list or a contact lookup, and contacts are async. Those keep their existing
// patterns and keep falling through to the loop when a phrasing misses. Guessing at a name is how
// the wrong person gets messaged; that is worth twenty seconds.
const SHAPE_EXEMPLARS = {
  appsearch: [
    'open spotify and search for ar rahman', 'launch brave and look up rust',
    'crank up spotify and find ar rahman', 'fire up the app store and search action games',
    'go to youtube and search for lofi', 'spotify, search for ar rahman',
    // Article-less and preposition-less: "open app store and search action games" abstained, so the
    // table answered it. People drop "the" and "for" constantly.
    'open app store and search action games', 'open notes and find my recipe',
    // THE REVERSED ORDER, which APP_SEARCH_IN_RE used to own: the app comes last and the query
    // first. Same shape, same destination, and the region had not one example of it — which is why
    // replacing that pattern needed exemplars rather than just deleting it.
    'search for chess in the app store', 'find my recipe in notes',
    'look up rust in brave', 'search ar rahman on spotify',
  ],
  // INSTALLING IS NOT SEARCHING, AND IT USED TO BE FILED AS SEARCHING.
  //
  //     ◆ open the app store and install among us
  //       Shape › read structurally as appsearch
  //       UI › searched "among us" in App Store
  //       Agent › done in 7316ms — ✓ search in app
  //
  // It searched, stopped, and reported SUCCESS for a request it had done half of. Nothing was
  // installed and nothing said so. These sentences look like appsearch — an app plus a thing — and
  // the only thing separating them is what he wants done at the end, which is exactly the sort of
  // distinction a region is for.
  // SEPARATED BY THE ACTION, NOT BY THE STORE. The first draft of this region named the app store in
  // five of its eight examples and promptly stole "search action games in the app store", which
  // abstained at a collapsed margin. Both regions are about the same place; only one of them ends
  // with software on his Mac. So the store is mentioned twice here and the rest carry the install
  // on their own.
  appinstall: [
    'install among us', 'install the notion app', 'install slack', 'install telegram',
    'download telegram', 'download zoom', 'install figma on my mac',
    'open the app store and install among us', 'download and install discord',
  ],
  // AND THE MIRROR OF IT. "uninstall" and "delete" are the same verb family, so this region has to
  // hold its edge against `files` — removing an APP and removing a FOLDER are different jobs with
  // different tools, and the one thing they must never do is swap.
  appuninstall: [
    'uninstall telegram', 'uninstall the notion app', 'remove slack from my mac',
    'get rid of discord', 'delete the zoom app', 'uninstall figma',
    'take spotify off my mac', 'remove that app',
  ],
  // AN ACCOUNT IS NOT AN APPLICATION, and this region exists because adding appuninstall stole
  // "unsubscribe to Mythpat on youtube" — three teach-offer assertions in test_parse went red.
  //
  // Unsubscribing from a channel and uninstalling a program are the same verb family pointed at
  // completely different things, and one of them is not on this machine at all. This is the region
  // the playbook has wanted for a while too: "unsubscribe to Mythpat on youtube" is the goal that
  // replayed a taught procedure at margin 0.026 and is the reason MIN_MARGIN there sits at 0.04.
  //
  // It routes NOWHERE in structuralPlan on purpose. Operating somebody's account on a website is
  // agent work — the loop drives the page, and a goal it has never done offers to be taught, which
  // is exactly what these three assertions check.
  siteaction: [
    'unsubscribe from that channel on youtube', 'unsubscribe from this newsletter',
    'subscribe to this channel', 'follow that account on instagram',
    'unfollow him on twitter', 'sign out of my account on this site',
    'star this repo on github', 'cancel my subscription on that site',
  ],
  // FILE WORK IS NOT AGENT WORK, AND IT HAD NO REGION AT ALL.
  //
  // Everything here is handled by quickAction — instantly, with no loop and no model — so none of
  // these shapes appears above. That absence was invisible until a new region was added next door:
  // "delete my downloads folder" landed on `appinstall` at margin 0.106, because a sentence with no
  // home lands on whichever centroid is generically nearest, and "do something to a thing on my
  // mac" is generically near "install a thing on my mac". Tightening the install exemplars did not
  // fix it — every individual install exemplar scored 0.34-0.49 against that sentence while their
  // AVERAGE scored 0.58, which is the averaging artefact this codebase keeps rediscovering.
  //
  // The repair is a home, not a tighter neighbour. shapeOf returning `files` routes nowhere in
  // structuralPlan and is not one of the shapes compoundAppIntent claims, so these go back to the
  // deterministic parser that already does them well.
  files: [
    'delete my downloads folder', 'tidy up my downloads folder',
    'make a folder called work on my desktop', 'move the screenshots into a folder',
    'rename that file to notes.txt', 'sort the files on my desktop by type',
    'empty the trash', 'find my resume',
  ],
  apptype: [
    'focus textedit and type all clear', 'switch to notes and write hello',
    'jump to textedit and type all clear', 'open textedit and type my name',
    'go to the terminal and type ls',
  ],
  note: [
    'write a passage about food', 'draft a note about the meeting',
    'knock up a note about food', 'jot down a note about the trip',
    'compose a paragraph about rain', 'write me a short essay on tigers',
  ],
  message: [
    'message mama on whatsapp that i am running late', 'text kunal that i am on my way',
    'whatsapp my brother asking about dinner', 'send dad a message saying happy birthday',
    'drop kunal a line about the trip', 'tell mama i will be late on whatsapp',
    // No platform named — the channel is chosen downstream, and this phrasing abstained.
    'message mama asking about her health', 'text kunal saying happy birthday',
    'imessage mama asking about her health',
  ],
  reminder: [
    // SETTING a reminder. Deliberately all "remind me to <do something>" — the app called Reminders
    // is a different request, and "open reminders and then open calculator" landed here because the
    // app's NAME is the region's strongest word. The twoapps region carries that case explicitly.
    'remind me to call the dentist', 'set a reminder to take the bins out',
    'remind me to buy milk tomorrow', 'put a reminder on to water the plants',
    'remind me to email kunal in the morning',
  ],
  twoapps: [
    'open spotify and notes', 'launch textedit and the calculator',
    'open brave and whatsapp', 'fire up notes and spotify',
    'open reminders and then open calculator', 'open notes and open calculator',
    'open safari and then textedit',
  ],
  call: [
    'call mama on whatsapp', 'ring mama on whatsapp', 'phone dad on whatsapp',
    'give mama a call on whatsapp', 'whatsapp call my brother',
    'get mama on the phone', 'ring my sister', 'call kunal',
  ],
  calendar: [
    'what is on my calendar', 'what have i got on today', 'am i busy today',
    'whats my day look like', 'show me my schedule', 'anything on my calendar tomorrow',
  ],
  freeslot: [
    'find me a free hour this week', 'when am i free tomorrow',
    'book me a free slot for two hours', 'do i have a gap this afternoon',
  ],
  none: [
    'what is the weather', 'who is the ceo of nvidia', 'play judas', 'order me a pizza',
    'how are you today', 'what is 17 times 23', 'close spotify', 'remember that i like tea',
    'search the web for the eiffel tower height', 'message mama on whatsapp',
    'buy me a phone charger', 'i am bored',
    // THE CLOCK IS NOT THE DIARY. Measured: shapeOf('what day is it') returned `calendar`, so a
    // question the system answers from its own clock in milliseconds would have been planned as a
    // Calendar query. There was nowhere else for it to go — every other region is a thing to DO, and
    // "what day is it" is nearest to the one region that is also about days.
    //
    // This is the same fault calintent.js hit from the other side, and it was fixed there by giving
    // the clock a region of its own to belong to. Here the answer lives in `none`, which is correct:
    // the deterministic planner has no step to take for it, and abstaining hands it to the lane that
    // already answers it from a number it holds.
    'what day is it', 'what is the date today', 'what time is it',
    'what is the time in london', 'what day of the week is it',
  ],
};

let _shapeClassify = null;
function shapeClassifier() {
  if (!_shapeClassify) {
    _shapeClassify = intent.makeClassifier({
      // 0.035, re-swept for nomic-embed-text (was 0.05 under all-minilm). Leave-one-out accuracy
      // 50/79 -> 58/79, median correct margin 0.145 -> 0.080.
      exemplars: SHAPE_EXEMPLARS, minMargin: 0.035, none: 'none',
      label: 'Shape', jlog: m => deps.jlog && deps.jlog(m),
    });
  }
  return _shapeClassify;
}
// Async, so the two callers that can await (planTask, runGoal) work it out and hand it down.
// deterministicPlan itself stays synchronous — the test helpers call it bare, and a plan builder
// that suddenly needs awaiting everywhere is a change with no upside.
async function shapeOf(goal) {
  try { const r = await shapeClassifier()(String(goal || '')); return r ? r.id : null; }
  catch (e) { return null; }
}

// Function words only. These are closed-class in English and have been for centuries — unlike the
// verbs, the nouns and the song titles that the tables kept failing on.
const CLAUSE_SPLIT_RE = /\s*(?:,|;|—|–|\bthen\b|\band\b)\s+/i;
// Prepositions AND phrasal particles. Both are closed-class: "hunt DOWN rust in brave" leaves
// "down rust" once the verb goes, and the particle belongs to the verb, not the query. This is the
// same argument as the particle handling in context.js — grammar, not vocabulary.
const LEADING_PREP_RE = /^(?:for|up|to|at|in|on|about|into|down|out|over|through|that)\s+/i;
// A REPORTED-SPEECH LEAD-IN, BY SHAPE RATHER THAN BY LIST. "text mama SAYING i am late", "whatsapp
// dad ASKING about dinner", "message kunal TELLING him to wait" — the -ing form introducing the
// message is a morphological fact, so every verb nobody has thought of yet is covered by the same
// line. This is the same trick learned.js already uses for participles.
const GERUND_LEAD_RE = /^\w+ing\s+/i;

// Drop the leading verb (whatever it is — never enumerated) and any preposition glued to it.
function afterVerb(clause) {
  const s = String(clause || '').trim().replace(/^(?:can you|please|jarvis)[,\s]+/i, '');
  const rest = s.replace(/^\S+\s+/, '');
  return rest.replace(LEADING_PREP_RE, '').trim();
}

// The app named ANYWHERE in a clause, found by asking the registry rather than by pattern.
//
// Trailing-only missed "get spotify going and look for ar rahman" — the app sits in the middle and
// "going" is at the end. Every contiguous run of words is offered to the registry, longest first so
// "the app store" beats "store", and the registry is the authority on what is an app.
// A SHORT SPAN MATCHED BY SUBSTRING IS NOISE, AND THE FIRST MATCH IS NOT THE BEST ONE.
//
// Both halves of this were wrong, and against his real registry they produced this:
//
//     "open spotify and notes"    → "and"     → Claude Code URL Handler  (0.75, substring)
//     "find my resume"            → "find"    → FindMy                   (0.90, prefix)
//     "what is the best repo…"    → "what"    → WhatsApp                 (0.90, prefix)
//     "search cats on youtube"    → "on"      → Contacts                 (0.75, c-ON-tacts)
//
// The 0.75 floor above this was added because "calculator" reached "Claude Code URL Handler", and it
// is still the right floor — it simply never addressed the case where the SPAN is two letters long.
// fuzzyApp scores `a.includes(q)` at 0.75 and `a.startsWith(q)` at 0.9 regardless of how little of
// the name the query accounts for, so every function word in the sentence is a candidate app.
//
// Worse, the loop returned the FIRST span at or above the floor rather than the best one. Spotify is
// not installed on this machine, so in "open spotify and notes" the only thing that could win was a
// function word — and the twoapps shape then planned Claude Code URL Handler as the first app. That
// is the exact bug the note above says was fixed, resurfaced on a different word.
//
// TWO RULES, NEITHER OF THEM A WORD LIST:
//   · take the BEST match in the clause, not the first one to clear the bar
//   · a span under 5 characters must match EXACTLY (score 1) — a prefix or substring hit on three
//     letters is evidence of nothing, whereas "notes" or "app store" matching exactly is evidence
//
// This is about the quality of the string evidence, so it says nothing about which words are verbs
// or prepositions and needs no opinion about vocabulary.
const APP_SPAN_EXACT_BELOW = 5;
function appIn(clause) {
  const words = String(clause || '').trim().split(/\s+/).filter(Boolean);
  let best = null;
  for (let len = Math.min(words.length, 4); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const span = words.slice(i, i + len).join(' ').replace(/^(?:the|my|to|up)\s+/i, '');
      if (!span) continue;
      const m = deps.fuzzyApp && deps.fuzzyApp(span.replace(/\s+app$/i, '').trim());
      if (!m || !(m.score >= 0.75)) continue;
      if (span.length < APP_SPAN_EXACT_BELOW && m.score < 1) continue;
      // Longest-first ordering already prefers "the app store" over "store"; among equal scores the
      // longer span still wins, so a later single word cannot displace a good multi-word match.
      if (!best || m.score > best.score || (m.score === best.score && len > best.len)) {
        best = { app: m.name, at: i, len, score: m.score };
      }
    }
  }
  return best ? { app: best.app, at: best.at, len: best.len } : null;
}

// ---------------------------------------------------------------------------
// WHICH SPAN IS A PERSON — asked of his address book, exactly as appIn asks the app registry.
//
// THE PROBLEM THIS SOLVES. The command shapes below read their arguments from structure, and that
// worked for every shape except the ones naming a person. Measured: four phrasings still missed,
// all of them calls —
//
//   "ring mama on whatsapp"          CALL_RE lists `call`, not ring
//   "phone mama on whatsapp"         nor phone
//   "give mama a call on whatsapp"   the name is not simply the word after the verb
//   "whatsapp call mama"             the name is last, not before the platform
//
// There is no structural rule that separates "mama" from "a call" in the third one, and no verb
// list survives the first two. What there IS, is a closed set of people he actually knows. appIn
// solved the identical problem by offering every span of the clause to the app registry and letting
// the REGISTRY say which one is an app. Contacts answers the same question about people.
//
// WHY IT IS CACHED. find_contact runs a JXA query per lookup with a 25-second timeout, which is
// fine as a deliberate step in a plan and unusable on the fast path where the point is to decide in
// milliseconds. The address book is dumped once, kept in memory, and span-matching is then pure
// string work — the same shape as appIndex().
//
// WHY IT IS ALLOWED TO BE WRONG-ISH. Fuzzy, with a threshold, so "mumma" and "mom" reach "Mom" and
// a typo still lands. Two things make that safe here and nowhere else: below the threshold it
// abstains and the request falls through to the loop exactly as it does today, and every outbound
// message is drafted for his approval before it sends. A wrong NAME is caught by him at the draft;
// a wrong grocery item is not caught at all. Different risk, different threshold.
//
// Names are held in memory only, never logged in bulk, and never written to disk.
const JXA_ALL_CONTACTS = `function run() {
  const app = Application('Contacts');
  const people = app.people;
  let names = [], nicks = [];
  try { names = people.name(); } catch (e) {}
  try { nicks = people.nickname(); } catch (e) {}
  const out = [];
  for (let i = 0; i < names.length && out.length < 2000; i++) {
    const n = String(names[i] || '').trim();
    const k = String((nicks && nicks[i]) || '').trim();
    if (n || k) out.push({ name: n, nick: k });
  }
  return JSON.stringify(out);
}`;

// NO FILLER LIST. The first draft of this carried one — a, an, the, my, to, on, via, please, call,
// message, text, whatsapp, saying, asking, tell, ask, say — and it was a keyword trap wearing a
// different hat: half of it was verbs, and the next phrasing would have needed the next verb.
//
// It is not needed. The ADDRESS BOOK is the filter. "a call" is not a contact, "whatsapp" is not a
// contact, "please" is not a contact — they score nothing and are rejected without anybody having
// to write them down. That is the whole point of asking a registry instead of a list, and it is the
// same reason appIn needs no list of non-apps.

let contactList = null, contactAt = 0, contactWarming = null;
const CONTACTS_TTL = 10 * 60 * 1000;

// Loads once and refreshes on a TTL. Never throws and never blocks a request: if it has not warmed
// yet, personIn simply finds nothing and the request falls through to the loop, which is exactly
// what happens today.
async function warmContacts(force) {
  // INJECTABLE, like fuzzyApp. A test cannot assert on his real address book — the names in it are
  // his, and a suite that only passes on one Mac is not a suite. deps.contacts lets a fixture stand
  // in for Contacts.app; production never sets it and reads the real book below.
  if (Array.isArray(deps.contacts)) { contactList = deps.contacts; contactAt = Date.now(); return contactList; }
  if (!force && contactList && Date.now() - contactAt < CONTACTS_TTL) return contactList;
  if (contactWarming) return contactWarming;
  contactWarming = (async () => {
    try {
      const r = await jxa(JXA_ALL_CONTACTS, [], 20000);
      if (r.ok) {
        const list = JSON.parse(r.out || '[]');
        if (Array.isArray(list)) {
          contactList = list; contactAt = Date.now();
          deps.jlog('Contacts › address book cached (' + list.length + ' people)');
        }
      } else if (deps.jlog) {
        deps.jlog('Contacts › could not read the address book — name extraction stays off');
      }
    } catch (e) { /* stays null; personIn finds nothing */ }
    contactWarming = null;
    return contactList;
  })();
  return contactWarming;
}

// Same scoring shape as fuzzyApp: exact, prefix, substring, then per-token overlap.
function fuzzyPerson(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q || !contactList) return null;
  const qt = q.split(/\s+/).filter(t => t.length > 1);
  if (!qt.length) return null;
  let best = null;
  for (const c of contactList) {
    for (const cand of [c.name, c.nick]) {
      if (!cand) continue;
      const a = String(cand).toLowerCase();
      let score = 0;
      if (a === q) score = 1;
      else if (a.startsWith(q)) score = 0.9;
      else if (a.includes(q)) score = 0.75;
      else {
        const words = a.split(/[^a-z0-9]+/).filter(Boolean);
        const hit = qt.filter(t => words.some(w => w === t || w.startsWith(t))).length;
        score = (hit / qt.length) * 0.6;
      }
      if (!best || score > best.score) best = { name: c.name || cand, score };
    }
  }
  return best;
}

// The person named ANYWHERE in the clause, longest span first so "mom in law" beats "mom".
// Returns null rather than a guess — below the threshold this shape simply is not recognised.
function personIn(clause) {
  if (!contactList) return null;
  const words = String(clause || '').trim().split(/\s+/).filter(Boolean);
  for (let len = Math.min(words.length, 3); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const span = words.slice(i, i + len).join(' ').replace(/[^\w' -]/g, '').trim();
      if (!span) continue;
      // 0.75 IS THE FLOOR, NOT 0.6. Below that fuzzyPerson is scoring token OVERLAP — a fraction of
      // the words matching some part of a contact — and that is how "mama that i" scored 0.6 and the
      // span ate three words of the sentence. Exact, prefix and substring are real evidence that a
      // span names somebody; partial overlap is a guess, and a guessed recipient is the one thing
      // this path must never produce.
      const hit = fuzzyPerson(span);
      if (hit && hit.score >= 0.75) return { person: hit.name, at: i, len, score: hit.score };
    }
  }
  return null;
}

// Build a plan from STRUCTURE once the classifier has said which shape this is. Returns null when
// the pieces are not where the shape needs them — a shape without its parts is not that shape, and
// falling through to the loop beats inventing an argument.
function structuralPlan(t, shape) {
  const parts = t.split(CLAUSE_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  if (shape === 'appsearch') {
    // Two clauses: "<open the app> and <search the thing>".
    if (parts.length >= 2) {
      const found = appIn(parts[0]);
      const query = afterVerb(parts.slice(1).join(' and '));
      if (found && query) {
        return { kind: 'appsearch', steps: [{ tool: 'search_in_app', args: { app: found.app, query }, why: 'search ' + found.app }] };
      }
    }
    // One clause: "<verb> <the thing> in|on <the app>". The preposition is the seam.
    // "from" is a seam as much as "in" or "on": "install among us FROM the app store" names the app
    // it should be searched in, and without it that request came back "Not sure which app — did you
    // mean App Store, sir?". Prepositions are closed-class; the thing that could never be listed is
    // what sits either side of them.
    // Up to three words after the seam, not two: "the app store" is three, and at two the request
    // "install among us from the app store" matched nothing and came back "Not sure which app".
    // appIn strips the leading article and asks the registry, so a longer window costs nothing —
    // a span that is not an app is simply not an app.
    const one = t.match(/^(.*?)\s+(?:in|on|from|inside|within)\s+(\S+(?:\s+\S+){0,2})\s*$/i);
    if (one) {
      const found = appIn(one[2]);
      const query = afterVerb(one[1]);
      if (found && query) {
        return { kind: 'appsearch', steps: [{ tool: 'search_in_app', args: { app: found.app, query }, why: 'search ' + found.app }] };
      }
    }
  }
  // INSTALL: search the store for it, then press the control that installs it.
  //
  // Deliberately NOT a single fixed step. Which control installs an app is a property of the screen
  // — "Get", a cloud-with-an-arrow, "Install", or a PRICE — so the plan lists the controls and picks
  // from that list, which is the one judgement a 3B makes reliably (see playbook.js on why
  // procedures are written this way, and factmatch.js for the same finding measured again).
  //
  // IT STOPS AT A PRICE, for the same reason the shopping procedures stop at the basket. A free
  // app's button says Get; anything naming money is his to press, not mine.
  if (shape === 'appinstall') {
    // The store is named or it is the App Store — "install among us" says where by saying what.
    const named = parts.length >= 2 ? appIn(parts[0]) : null;
    const seam = t.match(/^(.*?)\s+(?:in|on|from|inside|within)\s+(\S+(?:\s+\S+){0,2})\s*$/i);
    const store = (named && named.app) || (seam && appIn(seam[2]) && appIn(seam[2]).app) || 'App Store';
    // What to install: the tail of the clause that asks for it, with the store phrase removed.
    const said = seam ? seam[1] : (parts.length >= 2 ? parts.slice(1).join(' and ') : t);
    const query = afterVerb(said);
    if (query) {
      return { kind: 'appinstall', steps: [
        { tool: 'install_app', args: { app: store, query }, why: 'install ' + query + ' from ' + store },
      ] };
    }
  }
  if (shape === 'appuninstall') {
    // THE WHOLE CLAUSE GOES THROUGH, and uninstall_app finds the name in it.
    //
    // The first version stripped scaffolding here — a leading verb phrase, then a trailing "from my
    // mac", then an article — and shipped whatever survived. That is SUBTRACTIVE, and this codebase
    // has already paid for it once today: the search playbook built its query by deleting the words
    // somebody had written down, so a sentence containing none of them became its own search query.
    // Prepositions are a permitted list; building meaning out of what is left after deleting them is
    // not, because the next phrasing is always one nobody stripped.
    //
    // The registries know what is installed. So the NAME is extracted positively from them, exactly
    // as appIn() does for running apps — see removalTarget.
    return { kind: 'appuninstall', steps: [
      { tool: 'uninstall_app', args: { query: t } }, ] };
  }
  if (shape === 'apptype' && parts.length >= 2) {
    const found = appIn(parts[0]);
    const text = afterVerb(parts.slice(1).join(' and '));
    if (found && text) {
      return { kind: 'apptype', steps: [
        { tool: 'focus_app', args: { name: found.app }, why: 'focus ' + found.app },
        { tool: 'type_text', args: { text, app: found.app }, why: 'type it' },
      ] };
    }
  }
  if (shape === 'note') {
    // "about"/"on" is where the topic starts, whatever verb introduced it, and the FORM is the word
    // immediately before that preposition — "write a PASSAGE about food", "knock up a NOTE about
    // food", "write me a short ESSAY on tigers". Position, not a list of nouns.
    //
    // The first version of this returned one compose step carrying the whole goal as its purpose,
    // which is strictly worse than what it replaced: the composer was handed "open notes and write a
    // passage about food" as the thing to write, and nothing was saved to Notes at all.
    const m2 = t.match(/^(.*?)\b(?:about|on|regarding|for)\s+(.+)$/i);
    const topic = m2 ? m2[2].trim() : '';
    if (topic) {
      const before = (m2[1] || '').trim().split(/\s+/).filter(Boolean);
      const form = (before.length ? before[before.length - 1] : 'passage').toLowerCase();
      const title = topic.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60);
      return { kind: 'note', steps: [
        { tool: 'compose', args: { kind: 'text', purpose: 'Write a ' + form + ' about ' + topic }, why: 'write the ' + form },
        { tool: 'create_note', args: { title, body: '{{1.text}}' }, why: 'save it to Notes' },
      ] };
    }
  }
  if (shape === 'message') {
    // Person from the address book, platform from the app registry, and the message is whatever is
    // left once both spans and the lead-in are removed. No verb is enumerated in any of that.
    //
    // THE FIRST VERSION OF THIS PRODUCED WRONG BODIES and was withdrawn before it shipped:
    //   "text mama that i am running late"  ->  "late"
    //   "drop mama a line about the trip"   ->  "line about the trip"
    // The person span was eating three words, because personIn's floor was 0.6 and at 0.6 it scores
    // token OVERLAP — "mama that i" is not a name. Raising that floor to 0.75 (exact, prefix or
    // substring only) fixed the cause; the lead-in strip below is applied ONCE rather than chained,
    // because chaining removed "about" from "asking about dinner" as well.
    const who = personIn(t);
    if (who) {
      const words = t.split(/\s+/);
      const app = appIn(t);
      const rest = words.slice(who.at + who.len).filter((_, k) => {
        const idx = who.at + who.len + k;
        return !app || idx < app.at || idx >= app.at + app.len;
      }).join(' ').trim();
      // Pulling the app span out of the middle leaves the preposition that introduced it stranded:
      // "tell mama i will be late ON whatsapp" -> "i will be late on". Same closed-class cleanup at
      // the other end of the string.
      // THE GERUND IS THE SPEECH VERB, NOT NOISE. Stripping it and hardcoding "saying" produced
      // "A short personal message saying about her health" — ungrammatical, and the composer writes
      // from that sentence. "asking", "telling", "reminding" all carry the intent of the message,
      // so the one that was actually used is the one that goes into the purpose.
      const lead = rest.match(GERUND_LEAD_RE);
      const verb = lead ? lead[0].trim().toLowerCase() : 'saying';
      const gist = (lead ? rest.slice(lead[0].length) : rest.replace(LEADING_PREP_RE, ''))
                     .replace(/\s+(?:on|in|via|over|to|through|at)\s*$/i, '').trim();
      if (gist) {
        const channel = pickChannel(t);
        return { kind: 'message', steps: [
          { tool: 'find_contact', args: { query: who.person }, why: 'look up ' + who.person },
          { tool: 'compose', args: { kind: 'message', recipient: '{{1.name}}',
                                     purpose: 'A short personal message ' + verb + ' ' + gist }, why: 'write the message' },
          { tool: 'send_message', args: { channel, phone: '{{1.phone}}', to: '{{1.handle}}',
                                          name: '{{1.name}}', body: '{{2.text}}' }, why: 'send it' },
        ] };
      }
    }
  }
  if (shape === 'reminder') {
    // "remind me TO call the dentist" — the infinitive marker is where the task starts, whatever
    // verb introduced it.
    const m2 = t.match(/\bto\s+(.+)$/i);
    const title = m2 ? m2[1].trim() : '';
    if (title) return { kind: 'reminder', steps: [{ tool: 'add_reminder', args: { title }, why: 'add reminder' }] };
  }
  if (shape === 'twoapps') {
    // Both names come from the registry, so "open spotify and notes" needs no pattern describing
    // how a person phrases opening two things.
    const first = appIn(t);
    if (first) {
      const rest = t.split(/\s+/).slice(first.at + first.len).join(' ');
      const second = appIn(rest);
      if (second && second.app !== first.app) {
        return { kind: 'twoapps', steps: [
          { tool: 'open_app', args: { name: first.app }, why: 'open ' + first.app },
          { tool: 'open_app', args: { name: second.app }, why: 'open ' + second.app },
        ] };
      }
    }
  }
  if (shape === 'call') {
    // THE ADDRESS BOOK SAYS WHICH SPAN IS THE PERSON. No verb list, no name list: "ring mama on
    // whatsapp", "give mama a call on whatsapp" and "whatsapp call mama" all put the name somewhere
    // different, and in all three the only span that is a contact is "mama".
    //
    // No match means this is not recognised and the request falls through to the loop exactly as it
    // does today — a name is not something to guess at, and the invented-recipient guard downstream
    // exists because guessing one is how a stranger gets messaged.
    const who = personIn(t);
    if (who) {
      return { kind: 'call', steps: [
        { tool: 'find_contact', args: { query: who.person }, why: 'look up ' + who.person },
        { tool: 'open_whatsapp_chat', args: { phone: '{{1.phone}}', name: '{{1.name}}' }, why: 'open the chat to call' },
      ] };
    }
  }
  if (shape === 'calendar') {
    return { kind: 'calendar', steps: [{ tool: 'list_events', args: { days: windowDays(t) }, why: 'read the calendar' }] };
  }
  if (shape === 'freeslot') {
    const hm = t.match(/(\d+)\s*(?:hours?|hrs?)/i);
    const mm = t.match(/(\d+)\s*(?:minutes?|mins?)/i);
    const minutes = hm ? parseInt(hm[1], 10) * 60 : mm ? parseInt(mm[1], 10) : 60;
    return { kind: 'freeslot', steps: [{ tool: 'find_free_slot', args: { minutes, days: windowDays(t) }, why: 'find a gap' }] };
  }
  return null;
}

function deterministicPlan(goal, shape) {
  const t = String(goal || '').trim().replace(/[.?!]+$/, '');
  let m;
  // THE CLASSIFIER'S VERDICT OUTRANKS THE TABLE, BECAUSE OTHERWISE IT IS DECORATION.
  //
  // The structural reader used to be the LAST resort, after every regex below had failed. That left
  // the table free to answer a question the classifier had already answered better:
  //
  //     find me the next holiday in my calendar
  //       shape=calendar        <- correct
  //       plan =appsearch {"app":"Calendar","query":"me the next holiday"}
  //
  // APP_SEARCH_IN_RE matched "<verb> <thing> in <app>" and returned first, so the verdict was
  // computed and discarded one function later — the same shape as the router bug where the goal was
  // resolved and then planned from the unresolved text.
  //
  // When the classifier has named a shape, the structural reader for that shape goes first. When it
  // has not — reminders, two-app opens, messages, everything outside its regions — `shape` is null
  // and the table runs exactly as before.
  if (shape) {
    const sp = structuralPlan(t, shape);
    if (sp) {
      if (deps.jlog) deps.jlog('Shape › "' + t.slice(0, 44) + '" read structurally as ' + shape);
      return sp;
    }
  }
  // THE TABLE THAT USED TO LIVE HERE IS GONE.
  //
  // Nine patterns — MSG_RE, CALL_RE, NOTE_RE, REMIND_RE, APP_SEARCH_RE, APP_TYPE_RE,
  // APP_SEARCH_IN_RE, CAL_LIST_RE, FREE_SLOT_RE — plus twoAppPlan's TWO_APPS_RE. Between them
  // they enumerated the verbs a person might open a request with, and sixteen of thirty-two
  // realistic phrasings missed:
  //
  //   "jump to textedit and type all clear"    APP_TYPE_RE listed focus|open|launch|switch to
  //   "knock up a note about food"             NOTE_RE listed write|compose|draft|make|create
  //   "ring mama on whatsapp"                  CALL_RE listed call
  //   "am i busy today"                        CAL_LIST_RE spelled out whole phrasings
  //
  // Every one of those is answered now by asking what KIND of request this is (shapeOf, an
  // embedding over exemplar regions) and then reading the pieces out of the sentence's
  // structure and the registries — the app index for apps, Contacts for people. 32/32, and
  // the whole suite passes with the table deleted, which is how it earned deletion.
  //
  // THE CALENDAR HALF HAS SINCE GONE TOO. CAL_LIST_RE and FREE_SLOT_RE are deleted; calintent.js
  // asks the embedder, and the router consults it beside agentIntent rather than through it, so this
  // function stayed synchronous. compoundAppIntent still uses APP_SEARCH_RE and APP_SEARCH_IN_RE —
  // that one is not a pure classification: the pattern also CUTS the app name out of the sentence
  // and hands it to resolvesToApp, so replacing it needs appIn() to find the span as well, and it is
  // a separate job from this one.
  // pickChannel keeps IMESSAGE_OVERRIDE_RE, which names PLATFORMS: a closed set.
  //
  // A shape the classifier does not recognise, or one whose pieces are not in the sentence,
  // returns null and goes to the agentic loop — the same place a table miss went, minus the
  // pretence that a list of verbs was ever going to be complete.
  return null;
}

// ---------------- LLM planner (fallback) ----------------
async function llmPlan(goal) {
  const schema = {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: Object.keys(TOOLS) },
            args: { type: 'object' },
            why: { type: 'string' },
          },
          required: ['tool', 'args'],
        },
      },
    },
    required: ['steps'],
  };
  const sys = 'Break ' + (profile.userName() ? profile.userName() + '\'s' : 'the user\'s') + ' request into an ordered list of steps for JARVIS. Tools:\n' +
    Object.values(TOOL_HELP).map(s => '- ' + s).join('\n') +
    '\n\nRules: use ONLY those tools. Reference an earlier step\'s output as {{N.field}} (1-based), e.g. {{1.handle}} or {{2.text}}. ' +
    'Any message or written content must come from a compose step first — never invent the wording inline. ' +
    'Keep it to the fewest steps that genuinely do the job. Respond with ONLY the JSON object.';
  const r = await deps.llm({ system: sys, messages: [{ role: 'user', content: goal }], max_tokens: 500, schema, timeoutMs: 90000 });
  let j = null;
  try {
    const s = String(r.text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
    j = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
  } catch (e) { return null; }
  const steps = Array.isArray(j && j.steps) ? j.steps : [];
  const clean = steps.filter(s => s && TOOLS[s.tool]).slice(0, 6)
    .map(s => ({ tool: s.tool, args: (s.args && typeof s.args === 'object') ? s.args : {}, why: String(s.why || '') }));
  return clean.length ? { kind: 'llm', steps: clean } : null;
}

async function planTask(goal) {
  return deterministicPlan(goal, await shapeOf(goal)) || await llmPlan(goal);
}

// ---------------- agentic loop (observe → decide → act → repeat) ----------------
// The difference from llmPlan: that asked for a WHOLE plan up front and executed it blind. This
// decides ONE step at a time with the real result of the previous step in front of it, so it can
// recover ("that app name was wrong, try the other one"), chain naturally, and stop when actually
// done. A 3B is bad at authoring a 5-step plan in one shot but decent at picking one next action
// from a short list — which is exactly the shape this gives it.
const MAX_STEPS = () => (deps.lean() ? 6 : 10);
// Tools that change the world; repeating one back-to-back is drift, not a plan.
// Filesystem writes and app closing were missing from this list, so the drift guard never applied
// to them. Observed live on a file goal: the loop wrote the same file three times under three
// slightly different names AND closed an unrelated app (Antigravity) that nothing in the request
// mentioned. Anything that changes the machine belongs here.
const SIDE_EFFECT_TOOLS = new Set(['type_text', 'press_key', 'click_at', 'create_note', 'add_reminder', 'add_calendar_event', 'send_message', 'search_in_app', 'open_whatsapp_chat', 'browser_click', 'browser_fill', 'browser_submit', 'browser_go',
  'create_file', 'create_folder', 'append', 'delete', 'rename', 'move', 'copy', 'close_app', 'empty_trash', 'make_app']);

// PURE LOOKS — tools that only observe and change nothing (2026-10-14, the repeat guard in the loop). Listed by name, not
// inferred as "not a side effect": SIDE_EFFECT_TOOLS is not every tool that changes something (volume, brightness, screenshot,
// screen_press, uninstall_app… are not in it), and an unknown tool must never be treated as harmless. Only these may run again
// when the model repeats them, and only so their answer can be compared with the last one.
const LOOK_TOOLS = new Set(['screen_elements', 'list_running', 'list', 'read', 'search', 'system_status', 'read_clipboard',
  'list_events', 'find_free_slot', 'find_contact']);

// Tools that reach OUT to a person. Their recipient must be resolved from a real contact lookup —
// never authored by the model. Observed live: asked only to "Open ad-max.vercel.app", the loop
// failed on the URL and then called open_whatsapp_chat with the invented number +1234567890,
// opening WhatsApp to a stranger's chat. Nothing in the request mentioned messaging anyone.
const CONTACT_OUT_TOOLS = new Set(['send_message', 'open_whatsapp_chat']);
const IDENTIFIER_ARGS = ['phone', 'to', 'handle', 'number', 'recipient'];
// A {{n.field}} reference means the value came from an earlier step's real result.
const isStepRef = v => /^\{\{\d+\.\w+\}\}$/.test(String(v || '').trim());

// Plain-English narration of a step for the live progress feed. Deliberately present-tense and
// short: this is read aloud, so "Looking up Kunal in Contacts" works and a JSON blob does not.
function describeAgentStep(step) {
  const a = step.args || {};
  const v = x => { const s = String(x == null ? '' : x); return /^\{\{\d+\.\w+\}\}$/.test(s) ? '' : s; };
  const M = {
    find_contact: () => 'Looking up ' + (v(a.query) || v(a.name) || 'the contact') + ' in Contacts',
    compose: () => 'Writing the ' + (v(a.kind) || 'message'),
    send_message: () => 'Preparing to send' + (v(a.channel) ? ' on ' + v(a.channel) : ''),
    open_whatsapp_chat: () => 'Opening the WhatsApp chat',
    create_note: () => 'Writing the note',
    add_reminder: () => 'Adding the reminder',
    add_calendar_event: () => 'Adding the calendar event',
    list_events: () => 'Reading your calendar',
    find_free_slot: () => 'Looking for a free slot',
    open_app: () => 'Opening ' + (v(a.name) || 'the app'),
    close_app: () => 'Closing ' + (v(a.name) || 'the app'),
    switch_to: () => 'Switching to ' + (v(a.name) || 'the app'),
    focus_app: () => 'Focusing ' + (v(a.name) || 'the app'),
    search_in_app: () => 'Searching ' + (v(a.app) || 'the app') + ' for ' + (v(a.query) || 'it'),
    find_businesses: () => 'Looking for ' + (v(a.what) || 'businesses') + (v(a.where) ? ' in ' + v(a.where) : ' around you') + ' — maps and the web, this takes a minute or two',
    type_text: () => 'Typing',
    press_key: () => 'Pressing ' + (v(a.key) || 'a key'),
    open_url: () => 'Opening the link',
    ask_library: () => 'Checking your books',
    recall: () => 'Searching our history',
    cloud_search: () => 'Searching the web',
    cloud_email: () => 'Reading your mail',
    system_status: () => 'Checking system status',
    list_running: () => 'Checking what is open',
    screenshot: () => 'Taking a screenshot',
  };
  const f = M[step.tool];
  if (f) return f();
  if (step.why) return String(step.why).charAt(0).toUpperCase() + String(step.why).slice(1);
  return step.tool.replace(/_/g, ' ');
}

function observationLine(i, step, r) {
  const args = Object.entries(step.args || {}).map(([k, v]) => k + '=' + clipStr(String(v), 40)).join(' ');
  return (i + 1) + '. ' + step.tool + (args ? ' ' + args : '') + ' → ' + (r.ok ? 'ok' : 'FAILED') + ': ' + clipStr(r.say || '', 110);
}
const clipStr = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// What the agent has learned NOT to do, across runs. A no-op store by default so agent.js stays
// usable standalone (and every existing test keeps working untouched); server.js registers the
// real one. Same shape as registerMacroStore for the same reason — the loop should not know or
// care whether anything is actually persisting.
let lessonStore = { recall: () => [], learn: () => {}, unlearn: () => {} };
function registerLessonStore(store) { if (store) lessonStore = store; }

// PROCEDURAL MEMORY. Returns the numbered steps for this kind of goal, or an empty list. A no-op by
// default so agent.js stays standalone; server.js registers playbook.js.
//
// This is the difference between asking a 3B "what is the next single step?" — which it cannot
// answer for a five-step browser task — and "carry out step 3 of this plan, here is the page",
// which it can. The plan supplies the structure; the model supplies only the page-dependent parts.
let playbookFor = () => [];
function registerPlaybook(fn) { if (typeof fn === 'function') playbookFor = fn; }

// PER-GOAL TOOLS, which is the only way external tools can be allowed in at all.
//
// sysTools are registered once and always visible; that is fine for 24 of them. MCP servers may
// expose hundreds, and the brief is explicit that dumping a catalogue would break the planner long
// before it helped: the 3B already fails at choosing among 7-8, and 150 tools would eat half the
// 8192 context before any content. So external tools are resolved FOR THIS GOAL, at the moment the
// goal is known, and only the handful that could plausibly serve it is ever named in the prompt.
// mcp.js does the choosing; this is just the seam that lets it.
let dynamicFor = () => ({ tools: {}, help: {} });
function registerDynamicTools(fn) { if (typeof fn === 'function') dynamicFor = fn; }
// Async since 2026-10-09: the MCP tools for a goal are now chosen by meaning (mcp.js embeds the goal).
async function dynamicSafe(goal) {
  try { const d = (await dynamicFor(goal)) || {}; return { tools: d.tools || {}, help: d.help || {} }; }
  catch (e) { return { tools: {}, help: {} }; }
}

// ---------------- the built-ins get the same rule the external ones already had ----------------
//
// The note above says it plainly, about MCP: the 3B already fails at choosing among 7-8, and a
// catalogue would eat half the context before any content. The BUILT-INS were exempt from their own
// rule. Measured on an unscoped goal: 89 tool lines, 8792 characters — 2198 tokens of menu on an
// 8192 context, 27% of it spent listing tools before the goal is even stated.
//
// What that costs is not theoretical. "subscribe to Wifies on youtube" was answered with
// browser_add_dish — Swiggy's ordering tool — three times over, because it was on the menu and its
// description contains the word ADD. The dish it tried to add was called "wifies_subscribe".
//
// WHERE THE SAFETY ACTUALLY COMES FROM — and it is not "we keep everything when unsure".
//
// It would be comfortable to say an unrecognised goal keeps the whole menu, and it would be useless:
// "subscribe to Wifies on youtube" recognises nothing, and it is the goal this exists for. Every
// subtractable family is removed unless the goal invokes it, gibberish included.
//
// The safety is in WHAT IS SUBTRACTABLE, not in when. Only self-contained features are on the list,
// and every one of them has its own lane in server.js that answers "quiz me" or "what did you do
// while I was away" long before the loop is reached — the loop reaching for `quiz_me` mid-task was
// never how those features got used. The working core is not on the list at all and cannot be
// removed by any goal: browser, files, apps, contacts, messaging, notes, calendar, screen control,
// system. That is what a multi-step goal is actually made of.
//
// The residual risk is a family removed from a goal that quietly needed it, so the triggers are
// deliberately over-generous — a family costs ~120 tokens to keep and a silent total failure to drop
// — and the tests below spend half their assertions on tools still being THERE.
const TOOL_FAMILIES = [
  // The one that started this. Pressing the ADD that belongs to a named item is meaningless anywhere
  // but a page with a basket on it. Named for what the tool DOES, not for food: browser.js is
  // explicit that it is not a Swiggy special case — "order burgers from burger king still went back
  // to guessing at a ranked label list… now reachable by any goal" — so the trigger covers shopping
  // as well, and a goal that reaches it through a playbook never gets here at all.
  { name: 'basket', tools: ['browser_add_dish'],
    when: /\b(?:order|reorder|buy|buying|purchase|add|cart|basket|checkout|food|dish|menu|swiggy|zomato|dominos?|ubereats|uber ?eats|blinkit|amazon|flipkart|myntra|pizza|burger|biryani|noodles?|momos?|meal|lunch|dinner|breakfast|snack|dessert|takeaway|deliver(?:y|ed)?|eat|hungry)\b/i },
  { name: 'study', tools: ['learn_topic', 'stop_topic', 'quiz_me', 'answer_quiz', 'study_stats',
                           'ask_library', 'library_index', 'library_list'],
    when: /\b(?:teach|learn|learning|study|studying|quiz|revise|revision|exam|topic|book|books|library|chapter|notes on|read up|flashcard)\b/i },
  { name: 'dream', tools: ['dream_now', 'dream_log', 'dream_set'],
    when: /\b(?:dream|while i was away|overnight|idle|maintenance|housekeeping|tidy up)\b/i },
  { name: 'observe', tools: ['watch_me', 'save_observed', 'observe_status', 'stop_watching'],
    when: /\b(?:watch|watching|observe|record|recording|macro|call that|save that as)\b/i },
  { name: 'proactive', tools: ['proactive_set', 'proactive_status', 'breaks_set'],
    when: /\b(?:proactive|speak first|nudge|remind me to take|break|breaks|be quiet|stop talking|interrupt)\b/i },
  { name: 'profile', tools: ['profile_show', 'profile_set', 'emergency_contacts', 'family_time', 'who_am_i'],
    when: /\b(?:profile|who am i|about me|my (?:name|details|address|birthday|blood)|emergency|next of kin|family)\b/i },
  { name: 'journal', tools: ['recall', 'recall_stats', 'forget_episodes', 'what_was_open',
                             'restore_session', 'session_timeline', 'what_i_learned'],
    when: /\b(?:remember|remembered|recall|forget|forgot|memory|memories|journal|history|yesterday|last (?:week|month|night|time)|earlier|what did|when did|what was open|restore|put everything back|session|learned|lesson)\b/i },
  // THE ONE FAMILY REMOVED ON A POSITIVE SIGNAL RATHER THAN THE ABSENCE OF ONE.
  //
  // Every entry above is kept unless the goal rules it out. This one is the other way round: it is
  // removed only when the goal is unmistakably a SITE ACTION — star, follow, subscribe, archive — and
  // it stays for everything else, including every "open X and search Y" that legitimately drives a
  // Mac app. That asymmetry is deliberate; the tools here are core, and core is not removed on a guess.
  //
  // Operating a page is what the browser tools are FOR. Driving it through the screen instead needs
  // JarvisControl running, moves a real pointer, and acts on whichever window happens to be in front.
  // Measured: "unsubscribe to Mythpat on youtube" chose search_in_app twice — once against an app it
  // called "YouTube", which does not exist and which the tool honestly refused, and once by bringing
  // GOOGLE CHROME to the front, a browser he does not use, where it then died because screen control
  // was stopped. browser_go was on the menu the whole time.
  // Widened from "is this a site ACTION" to "is this about a website that is not an app here",
  // because the first version was still a verb list and it let the same failure straight through.
  // "open GitHub and show me my profile" names no site-action verb, kept search_in_app, and the model
  // invented an app called "GitHub for Mac" to search inside — burning 32 seconds on an app that does
  // not exist while browser_go sat on the menu.
  //
  // The test is evidence, not vocabulary: the goal names something the SITE REGISTRY knows, and that
  // something does not resolve to an app actually installed on this Mac. GitHub is a site here and
  // not an app, so the browser does it. Spotify is BOTH, so "open spotify and search for judas" keeps
  // every screen tool it has always had.
  { name: 'screen', tools: ['search_in_app', 'click_at', 'screen_elements', 'screen_press'],
    notWhen: g => siteActionIntent(g) || webOnlyTarget(g) },
  { name: 'cloud', tools: ['cloud_search', 'cloud_status', 'cloud_connect', 'cloud_action', 'cloud_email'],
    // e-?mails? and not e-?mail: "read me my unread emails" is the commonest phrasing there is, and
    // the trailing \b put the plural outside the pattern. Caught by the test below, not by reading it.
    when: /\b(?:e-?mail(?:s|ing)?|mails?|inbox|gmail|cloud|connect(?:ed|ion)?|integration|slack|notion|drive|sheets?|spreadsheets?|trello|jira)\b/i },
];
// Returns the names a goal may choose from. `allow` (a playbook's own scope) always wins — it is
// narrower than anything here and it was written by a person.
// Does this goal name a site the registry knows, which is NOT an app installed on this Mac? If so
// the job is a web job and belongs to the browser tools. Both halves are looked up rather than
// guessed: deps.knownSite is the same registry the open/search path uses, and resolvesToApp is the
// same fuzzy match the app lanes use, so this cannot disagree with either.
function webOnlyTarget(goal) {
  if (!deps.knownSite) return false;                     // not wired up (tests) — change nothing
  for (const w of String(goal || '').toLowerCase().match(/[a-z0-9.]+/g) || []) {
    if (w.length < 2) continue;
    let site = null;
    try { site = deps.knownSite(w); } catch (e) {}
    if (!site) continue;
    if (resolvesToApp(w) || resolvesToApp(site)) return false;   // it is an app here — leave it alone
    return true;
  }
  return false;
}

function scopeToGoal(goal, names) {
  const g = String(goal || '');
  const drop = new Set();
  for (const fam of TOOL_FAMILIES) {
    // `when` keeps a family the goal invoked; `notWhen` removes one the goal ruled out. A family
    // declares exactly one of them, and the difference is which way the evidence has to point.
    const out = fam.notWhen ? fam.notWhen(g) : !fam.when.test(g);
    if (!out) continue;
    for (const t of fam.tools) drop.add(t);
  }
  return names.filter(n => !drop.has(n));
}

// THE CONVERSATION THE PLANNER NEVER SAW.
//
// Seven call sites in server.js pass `messages: body && body.messages` into runGoal. Grep agent.js
// for `messages` and there are five hits, every one of them a LOCAL array built for a deps.llm()
// call. opts.messages was read exactly nowhere. The whole transcript arrived and was dropped, and
// every multi-step action was planned from one sentence with the conversation sitting unused in
// scope. Measured, from his terminal:
//
//     ◆ who is the ceo of nvidia
//       The CEO of Nvidia is Jensen Huang.
//     ◆ search him up on brave
//       Searched Brave Browser for "him up", Sir.
//
// The antecedent was one line above the goal, inside opts.messages, in the same function call.
//
// WHY HERE AND NOT IN THE ROUTER. The router's resolver (context.js) is a closed pronoun list —
// it|that|this|those|them|these|same|one — so "him" never reaches it, and widening the list is the
// wrong shape twice over: pronouns are closed-class but definite descriptions and ellipsis ("and in
// mumbai?", "the second one") are not, and its entitiesFrom extractor picks "The CEO of Nvidia"
// over "Jensen Huang" and misses "Mary Shelley" in "Mary Shelley wrote Frankenstein" entirely.
// Measured, not assumed. A resolver that guesses confidently is worse than one that never ran.
//
// WHY THIS IS NOT A NEW GENERATIVE RISK. nextStep is ALREADY an LLM call deciding the next action.
// Handing it the conversation does not add a model to the path — it stops the model that is
// already there from deciding blind. There is no new dependency, no word list and no second model.
//
// IT IS BACKGROUND, NOT A QUEUE. Labelled and fenced, because a 3B handed loose transcript will
// happily carry out something he asked for three turns ago. The header says so in as many words.
function convoBlock(messages, refers) {
  if (!Array.isArray(messages) || messages.length < 2) return '';
  // The last user message IS this goal — including it invites the model to redo it as a step.
  const prior = messages.slice(0, -1)
    .filter(m => m && typeof m.content === 'string' && m.content.trim());
  if (!prior.length) return '';
  // Short. A long transcript is the single thing that makes a 3B lose the plot, which is why
  // handleChatInner already slices to -8 on the local model; a planner needs less than a chat does.
  const lines = prior.slice(-6).map(m => {
    const who = m.role === 'assistant' ? 'JARVIS' : profile.userLabel();
    const text = String(m.content).replace(/\s+/g, ' ').trim();
    return who + ': ' + (text.length > 200 ? text.slice(0, 200) + '…' : text);
  });
  // standsFor already worked out the referent and proved it was really said. Stating it outright
  // beats hoping a 3B re-derives it from the transcript underneath.
  const named = refers ? 'The GOAL below refers to: ' + refers + '\n' : '';
  return 'CONVERSATION SO FAR (background only — use it to understand what the GOAL refers to, ' +
         'such as who "him" is or which one "the second one" is. Do NOT carry out anything from ' +
         'it; the GOAL below is the only thing to do):\n' + lines.join('\n') + '\n' + named;
}

// WHAT THE REQUEST IS REFERRING TO — asked extractively, answered verbatim or not at all.
//
// WHY THE AGENT ASKS AT ALL, WHEN THE ROUTER ALREADY DID. Not every goal arrives through the chat
// router: /api/agent, a scheduled task and a resumed run all call runGoal directly, and those never
// pass the door where resolution happens. runTypedGoal — the door — marks what it has already
// resolved with opts.resolved so this does not pay for it twice.
//
// WHAT IT IS USED FOR HERE. Not rewriting the sentence for its own sake. deterministicPlan is a
// table of regexes over the raw string; when the request leans on something said earlier, that table
// is reading the wrong text by definition, and its capture groups produce arguments like "him up".
// Resolving first means the table sees a sentence that says what he meant.
//
// The implementation, the measurements and the reason there is no word list are in context.js.
// ONE IMPLEMENTATION, IN ONE PLACE. This file briefly carried its own copy of the resolver and its
// few-shot examples while the router still had the pronoun list. Two copies of the same prompt is
// the same failure shape as two copies of the same word list — they drift, and the bug is that they
// disagree. context.js owns the question "what is this referring to"; this file asks it.
const cx = require('./context.js');
const standsFor = (goal, messages) => cx.standsFor(goal, messages);
const wordsFor = (goal, refers) => cx.wordsFor(goal, refers);

async function nextStep(goal, transcript, lessons, allow, convo) {
  // A procedure's tool scope is applied HERE, to the enum the model chooses from. Filtering after
  // the fact would only catch the wander; removing the tools means it cannot be expressed.
  const dyn = await dynamicSafe(goal);
  const every = Object.keys(Object.assign({}, allTools(), dyn.tools));
  // A PLAYBOOK'S SCOPE IS FINAL, AND FAMILY SCOPING DOES NOT GET A SECOND OPINION ON IT.
  //
  // The family list is a guess about which tools a sentence implies. A playbook's `tools` is a person
  // stating which tools a job needs, having driven the site. Applying one on top of the other took
  // browser_add_dish off the shop playbook's own list for "buy me airpods on amazon" — no ordering
  // word in the sentence — even though that tool is not food-only at all: it is the generalised
  // "press the ADD belonging to the NAMED item", and the shop procedure lists it deliberately.
  const names = allow ? every.filter(n => allow.includes(n)) : scopeToGoal(goal, every);
  const schema = {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: names.concat(['done', 'fail']) },
      args: { type: 'object' },
      say: { type: 'string' },
      why: { type: 'string' },
    },
    required: ['tool'], additionalProperties: false,
  };
  const sys = 'You are JARVIS carrying out a goal on ' + (profile.userName() ? profile.userName() + '\'s' : 'the user\'s') + ' Mac, ONE step at a time.\n\n' +
    // The HELP is filtered by the SCOPED names, not by `allow`. Describing a tool the enum will not
    // accept is the worst of both: the tokens are spent and the choice is rejected.
    'TOOLS:\n' + toolHelpLines(names, dyn.help) + '\n\n' +
    'Rules:\n' +
    '- Reply with ONLY a JSON object: {"tool":"<name>","args":{...}} for the next single step.\n' +
    '- When the goal is already achieved, reply {"tool":"done","say":"<one short sentence of what you did>"}.\n' +
    '- If it cannot be done with these tools, reply {"tool":"fail","say":"<why>"}.\n' +
    '- Look at what already happened; do NOT repeat a step that already succeeded.\n' +
    // QUALIFIED, because unqualified it was an instruction to get this wrong. A blanket "prefer
    // search_in_app" pointed a 3B at that tool for goals it cannot do: asked to unsubscribe from a
    // YouTube channel it obeyed the rule twice, inventing an app called "YouTube" and then focusing
    // Google Chrome. The advice is sound for a Mac app and actively harmful for a web page.
    '- Prefer the one tool that does the whole job (search_in_app) over several smaller ones — but ' +
    'ONLY for a goal inside a Mac APP. Anything on a website is done with the browser_ tools: ' +
    'browser_go to the page, browser_elements to see it, browser_click_described to press something.\n' +
    '- Never invent tools or arguments.';
  // Lessons go BEFORE the transcript and before the question. A 3B weights the end of a prompt
  // heavily, and a warning buried under the step history is a warning it does not act on — but put
  // after the question it starts answering the warning instead of choosing a step.
  const learned = (lessons && lessons.length) ? lessons.join('\n') + '\n\n' : '';
  // Background first, then the job. Same reasoning as the lessons placement above: the GOAL and the
  // question stay adjacent at the end where a 3B weights hardest, and the conversation sits behind
  // them as reference rather than competing to be answered.
  const user = learned + (convo ? convo + '\n' : '') + 'GOAL: ' + goal + '\n\n' +
    (transcript.length ? 'ALREADY DONE:\n' + transcript.join('\n') + '\n\nWhat is the next single step?' : 'What is the first step?');
  try {
    const r = await deps.llm({ system: sys, messages: [{ role: 'user', content: user }], max_tokens: 220, schema, timeoutMs: 90000 });
    const s = String(r.text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
    const j = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
    if (!j || !j.tool) return null;
    return { tool: String(j.tool), args: (j.args && typeof j.args === 'object') ? j.args : {}, say: j.say, why: j.why };
  } catch (e) { return null; }
}

async function runAgentLoop(goal, opts) {
  opts = opts || {};
  // Rendered ONCE per run, not once per step: the conversation does not change while the loop is
  // running, and rebuilding it inside the step loop would put the same string through the prompt
  // budget on every iteration for nothing.
  const convo = convoBlock(opts.messages, opts.refers);
  // Built in full here, and narrowed further down once the playbook has had its say — the seed
  // replay below must be able to re-record steps from a run that was scoped differently, and a
  // resumed run failing on its own history would be a worse bug than the one being fixed.
  const tools = Object.assign({}, allTools(), (await dynamicSafe(goal)).tools);
  // Run state, budgets and failure policy live in harness.js — pure and unit-testable, because the
  // interesting part of an agent is its policy and policy buried in a loop that needs a live Mac
  // is policy nobody can test. This loop keeps the tools and the guards; the harness decides what
  // the loop should DO about what happens.
  // Budgets scale with the SIZE OF THE REQUEST, not a constant. A flat ten-step ceiling meant a
  // fifteen-part goal could not be completed by any model, however well it behaved — it ran out of
  // steps at two thirds and reported partial, which read as the model failing when it was the
  // budget. A one-part goal still gets the old ten.
  const parts = harness.expectedParts(goal);
  const stepCeiling = deps.lean() ? 18 : 30;
  const run = harness.newRun(goal, {
    parts,
    maxSteps: opts.maxSteps || Math.max(MAX_STEPS(), Math.min(parts * 2 + 4, stepCeiling)),
    // Wall clock scales too, or the step budget is academic: on the local model each decision is
    // the longest pause in the run, so thirty steps inside a six-minute deadline is really a
    // six-minute deadline. Hard-capped at fifteen minutes — a scaling budget must still end.
    budgetMs: opts.budgetMs || Math.min(15 * 60000,
      Math.max(deps.lean() ? 3 * 60000 : 6 * 60000, parts * 45000)),
    maxRetries: opts.maxRetries,
  });
  const steps = run.steps, results = run.results;
  const seen = new Set();
  // What each look (LOOK_TOOLS) returned last time, by call signature — see the loop guard.
  const lookSeen = new Map();
  const lookOf = r => { try { return JSON.stringify({ ok: !!(r && r.ok), say: r && r.say, data: r && r.data }); } catch (e) { return String(Math.random()); } };
  let lastTool = '';
  let sameToolStreak = 0;

  // RESUMING AFTER A CONFIRMATION.
  //
  // A paused loop used to be un-resumable in practice. The pause hands back plan.steps — the steps
  // taken SO FAR — and approving it called runPlan on exactly those, which replayed the approved
  // step and returned. The loop was never re-entered, so it never decided step 2. Every browser
  // step asks for confirmation, so a four-step browser procedure stopped dead at step one and
  // reported "Opening …, Sir." as though that were the whole job.
  //
  // Seeding the run with what already happened lets the loop pick up where it stopped: the
  // transcript, the repeat guard and the drift streak all continue from the real history rather
  // than starting blank, which is what stops a resumed run from redoing its own first step.
  if (opts.seed && Array.isArray(opts.seed.steps)) {
    for (let i = 0; i < opts.seed.steps.length; i++) {
      const st = opts.seed.steps[i];
      if (!st || !st.tool) continue;
      steps.push(st);
      const r = (opts.seed.results || [])[i];
      results[steps.length - 1] = r;
      seen.add(st.tool + ':' + JSON.stringify(st.args || {}));
      if (r) harness.record(run, st, r, harness.classify(r));
      lastTool = st.tool;
      sameToolStreak = SIDE_EFFECT_TOOLS.has(st.tool)
        ? (i > 0 && opts.seed.steps[i - 1] && opts.seed.steps[i - 1].tool === st.tool ? sameToolStreak + 1 : 1)
        : 0;
    }
  }
  // The procedure goes in FRONT of the lessons: the steps are what to do, the lessons are what to
  // avoid while doing them, and a warning is only meaningful once there is a plan to apply it to.
  // A caller may scope the tools itself. Splitting a usual into one goal per item made each leg too
  // short to match a playbook, so the scoping the procedure used to supply vanished and a leg reading
  // "open Dominos on swiggy" reached for open_in_finder. The scope belongs to the JOB, not to whether
  // a phrase happens to match a recipe.
  let procedure = [], allowTools = (opts && opts.allowTools) || null, specs = [], stepsVary = false, onceTools = null;
  try {
    // Awaited: choosing a procedure is a model call now (an embedding), not a table lookup. A plain
    // value still works through await, so a caller that registers a synchronous callback is fine.
    const pbk = (await playbookFor(goal)) || [];
    // Backwards compatible: a plain array is just the lines, an object may also scope the tools.
    if (Array.isArray(pbk)) procedure = pbk;
    else {
      procedure = pbk.lines || []; allowTools = pbk.tools || allowTools; specs = pbk.specs || [];
      stepsVary = !!pbk.stepsVary;
      onceTools = Array.isArray(pbk.once) && pbk.once.length ? pbk.once.slice() : null;
    }
  } catch (e) { procedure = []; allowTools = null; specs = []; stepsVary = false; }
  // A CALLER'S LIST IS A WALL WHEN IT SAYS SO (opts.strictTools, 2026-10-14). The schema enum below is "a strong constraint
  // on a local model and not a guarantee"; the reader-none veto lets a read-only procedure run and must be certain nothing
  // else can. So with strictTools the caller's list wins (narrowed further by the procedure's own, never widened), and
  // every tool outside it is taken out of this run's table — a named tool that is not there is "no tool called …".
  if (opts && opts.strictTools && Array.isArray(opts.allowTools)) {
    allowTools = (allowTools && allowTools !== opts.allowTools) ? allowTools.filter(t => opts.allowTools.includes(t)) : opts.allowTools.slice();
    for (const n of Object.keys(tools)) if (!allowTools.includes(n)) delete tools[n];
  }
  if (allowTools) deps.jlog('Agent › this procedure may use only: ' + allowTools.join(', '));
  // THE EXECUTION TABLE IS NARROWED HERE, not at the top, because only now is it known whether a
  // playbook already scoped this run. A JSON-schema enum is a strong constraint on a local model and
  // not a guarantee, so a tool the enum hides is also made unreachable — otherwise a model that
  // ignores the schema walks straight past the fix. When a playbook supplied its own list, this does
  // nothing: that list is already narrower and a person wrote it.
  if (!allowTools) {
    const inScope = new Set(scopeToGoal(goal, Object.keys(tools)));
    for (const n of Object.keys(tools)) if (!inScope.has(n)) delete tools[n];
  }
  if (procedure.length) deps.jlog('Agent › following the playbook for this goal');

  // A procedure this system worked out for itself before, offered as a SUGGESTION and never as an
  // instruction to replay. The page may have moved, the request may differ in a way the key cannot
  // see, and a stored method followed blindly is exactly how a stale approach survives being wrong.
  //
  // Computed HERE rather than beside the rest of the guidance because the teach offer below depends
  // on it and has to be decided before anything runs. This is a disk read and nothing else, so
  // hoisting it changes no behaviour; the ORDER OF THE GUIDANCE TEXT is unaffected, since that is
  // built further down and still puts a human-written playbook first.
  let priorHint = [];
  if (deps.learned) {
    try {
      const prior = deps.learned.recall(goal);
      if (prior && prior.steps && prior.steps.length) {
        priorHint = ['', 'LAST TIME something like this worked as: ' +
          prior.steps.map(st => st.tool.replace(/_/g, ' ')).join(' → ') +
          (prior.status === 'trusted' ? ' (this has worked more than once).'
                                      : ' (tried once, unconfirmed — check it still fits before following it).')];
        deps.jlog('Agent › recalled a ' + prior.status + ' procedure for "' + prior.key + '"');
      }
    } catch (e) {}
  }
  // DECIDED BEFORE ANYTHING RUNS, BECAUSE ASKING AFTER ACTING IS NOT ASKING.
  //
  // The determined navigation below used to fire unconditionally, so a goal that was about to be
  // handed back with "I have not done this before — shall I work it out, or will you teach me?" had
  // ALREADY opened the site. He asked to subscribe to a channel, got the question, and watched
  // YouTube open behind it for a job the assistant had just admitted it could not do.
  //
  // The navigation was not even useful: approving the offer re-enters this function from the top and
  // navigates again — measured in the eval, two identical browser_go steps either side of the
  // pause. So it is wasted work when he says yes and an unwanted side effect when he says no.
  const isNovel = !procedure.length && !priorHint.length;
  const willOfferTeaching = isNovel && opts.askBeforeExploring && !opts.taught && !opts.exploreApproved;

  // THE DETERMINED PREFIX RUNS WITHOUT A MODEL.
  //
  // A step carrying a `run` spec was fully specified before the run began — "browser_go to
  // https://www.youtube.com/results?search_query=…" is an instruction, not a decision. Handing it to
  // a 3B anyway is how a run opens with browser_elements and enumerates the tab left over from the
  // previous task, which was measured twice on Spotify with an empty lesson store.
  //
  // Only the leading CONSECUTIVE run of specs is executed. The moment a step needs judgement, the
  // model takes over and keeps it for the rest of the run — stepping in and out of automation
  // halfway would leave the transcript describing steps nobody can attribute. Executed steps are
  // pushed through the same seed path a resumed run uses, so the transcript, the repeat guard and
  // the drift counter all see them as real history and the model plans from the first open question.
  // THE SITE NAMED IN THE GOAL IS WHERE THE WORK HAPPENS, and that was never enforced.
  //
  // Asked to "follow the more information link on example.com" the loop called browser_elements on
  // whatever tab was already open — brave.com — clicked a Brave VPN link, and reported success. The
  // goal named a destination and nothing took it there. An outcome check calls that a pass because
  // something was clicked; only the ORDER of the tools shows it was the wrong page all along.
  //
  // Navigating there is not a decision — the goal said where. So it becomes a determined step, the
  // same treatment playbook specs already get: run before the model is asked anything, recorded in
  // the transcript as real history. The model then plans from the right page instead of guessing
  // which page it is on.
  //
  // Narrow on purpose. Only a SITE ACTION qualifies — star, follow, subscribe, archive — which is
  // the same predicate that keeps screen-control tools off web goals, so the two cannot disagree.
  // A playbook that supplied its own specs is left completely alone: it knows better than this does.
  if ((!Array.isArray(specs) || !specs.length) && !(opts && opts.seed) && !(opts && opts.stayOnPage) &&
      !willOfferTeaching && deps.siteUrl && siteActionIntent(goal)) {
    const url = deps.siteUrl(goal);
    if (url) {
      specs = [{ tool: 'browser_go', args: { url } }];
      deps.jlog('Agent › the goal names ' + url + ' — going there before anything else');
    }
  }
  if (Array.isArray(specs) && specs.length && specs[0] && !(opts && opts.seed)) {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (!spec || !spec.tool) break;                       // first undetermined step ends the prefix
      if (allowTools && !allowTools.includes(spec.tool)) break;
      const fn = tools[spec.tool];
      if (!fn) break;                                       // not a tool this run can reach
      const st = { tool: spec.tool, args: spec.args || {} };
      // confirmed:true is the same pre-approval the procedural lane already grants the run as a
      // whole. It does not widen anything: the steps that stop on their own account — buying,
      // messaging, deleting — refuse inside the tool, not at this gate.
      let r;
      try { r = await fn(st.args, { confirmed: true, goal }); } catch (e) { r = null; }
      if (!r) break;
      steps.push(st);
      results[steps.length - 1] = r;
      seen.add(st.tool + ':' + JSON.stringify(st.args || {}));
      harness.record(run, st, r, harness.classify(r));
      lastTool = st.tool;
      deps.jlog('Agent › step ' + (i + 1) + ' ran without a model (' + spec.tool + ')' +
        (r.ok === false ? ' — FAILED: ' + String(r.say || '').slice(0, 60) : ''));
      if (r.ok === false && harness.classify(r) === 'asked') return finishRun('asked');   // it needs his answer, not a retry
      if (r.ok === false) break;                            // a failed determined step is the run's problem
    }
  }
  // Read once, not per step: the store is on disk and the lines cannot change mid-run, so fetching
  // them inside the loop would be the same file read ten times for the same answer.
  //
  // Recalled AFTER the procedure, because the procedure decides which lessons can still apply. A
  // warning about a tool this run is forbidden to call is not guidance, it is ballast: three of the
  // lessons injected into "play bohemian rhapsody on spotify" were about search_in_app, which the
  // Spotify procedure explicitly bans and the tool whitelist would have rejected anyway. On an 8192
  // context that is budget spent to rule out something already impossible.
  let learned = [];
  try { learned = lessonStore.recall(goal, 3, allowTools) || []; } catch (e) { learned = []; }
  if (learned.length) deps.jlog('Agent › ' + learned.length + ' lesson(s) from earlier attempts at this');
  // The numbered lines only — the procedure text also carries a header and a DONE WHEN clause, and
  // neither is a step anyone performs.
  const procedureStepLines = procedure.filter(l => /^\s*\d+\./.test(l));
  let donePushbacks = 0;
  // Recorded on the run so the verdict can report progress against the procedure rather than against
  // the number of clauses in his sentence — unless the procedure says its steps repeat or only
  // sometimes apply, when their number measures nothing (see playbook.js files-make-many).
  run.procedureSteps = stepsVary ? 0 : procedureStepLines.length;
  // (priorHint is computed near the top of this function — the teach offer depends on it and has to
  // be settled before the determined navigation runs. It still enters `guidance` below in the same
  // place, after the curated playbook, so a human-written procedure always leads.)
  // ASK BEFORE EXPLORING SOMETHING GENUINELY NEW.
  //
  // A goal with no curated playbook, no learned procedure and no lesson history is one this system
  // has never done. Working it out alone means clicking around a site it does not understand, and
  // the guards that make that survivable — the buy-label refusal, the checkout and password stops —
  // are the last line rather than the first. He should get the choice, because he is right there and
  // he knows the site.
  //
  // Deliberately NOT asked for anything already known: a request that matches a playbook, a learned
  // procedure or a past lesson is not exploration, and asking every time would make the assistant
  // tiresome in exactly the cases it is most confident.
  // HAVING FAILED AT SOMETHING IS NOT THE SAME AS KNOWING HOW TO DO IT.
  //
  // `learned` here is lessonStore — and lessons.js stores nothing but FAILURES; every entry is a
  // record of a tool that did not work. Counting it as prior knowledge inverted this test exactly:
  // one botched attempt permanently disqualified a goal from ever being offered for teaching, and the
  // botched attempt is the strongest possible evidence that teaching is what it needs.
  //
  // Measured, from his own session: "subscribe to Mythpat on youtube" failed once and left a lesson
  // ("browser_add_dish — subscribe is not on this menu"). "unsubscribe to Mythpat on youtube" then
  // scored against that lesson, so it was no longer novel, so he was never offered the choice — and
  // the loop flailed at search_in_app twice, once against an app called "YouTube" and once by
  // bringing Google Chrome to the front, a browser he does not use.
  //
  // The remaining terms are the ones that mean something was actually SOLVED: a curated playbook, or
  // a procedure that has worked before. Neither is true of a goal that has only ever failed.
  // isNovel and willOfferTeaching are both computed at the top now, for the ordering reason above.
  // WHETHER ANYONE IS LISTENING IS THE CALLER'S FACT, NOT THIS FUNCTION'S.
  //
  // I briefly made asking the default here. The stress suite rejected it within one run, and it was
  // right to: runGoal is also how a scheduled task fires at 6am and how /api/agent answers a script,
  // and a library call whose default is "stop and wait for a human" is wrong in both. The agent
  // cannot know if there is anybody there; the caller always does.
  //
  // So it stays opt-in HERE and is made unforgettable at the boundary instead — server.js routes
  // every live typed request through one helper that sets it, and a test enforces that no chat lane
  // calls runGoal directly. That is what stopped this being whack-a-mole: the rule is checkable,
  // rather than something five lanes each had to remember.
  if (willOfferTeaching) {
    deps.jlog('Agent › novel goal, offering to be taught: "' + String(goal).slice(0, 50) + '"');
    return {
      ok: false, paused: true, clarify: true, novel: true,
      plan: { kind: 'loop', goal, steps: [] }, results: [], transcript: [],
      options: [{ name: 'Work it out yourself' }, { name: 'Let me talk you through it' }],
      say: 'I have not done this before, Sir. I can try to work it out on my own — which means ' +
           'clicking around a site I do not know yet, and I may get it wrong — or you can talk me ' +
           'through it and I will remember how.',
    };
  }
  const guidance = procedure.concat(learned.length ? [''] : [], learned, priorHint);
  let say = '';
  // Steering notes appended after a failure. Without these the model sees a bare "FAILED" and its
  // most likely next move is the identical call, which the repeat guard then kills — converting a
  // recoverable miss into a dead run.
  let hint = '';

  for (;;) {
    // Budgets are checked at the top of every iteration: steps AND wall clock. A step count alone
    // bounds how many tool calls happen, not how long they take, and one hung call could hold a
    // run open indefinitely.
    const spent = harness.exhausted(run);
    if (spent) return finishRun(spent);
    // Checked before deciding AND before acting, so a stop lands within one step rather than
    // running the plan to completion while the user watches.
    if (deps.stopped && deps.stopped()) return finishRun('stopped');
    // Narrate the THINKING, not just the doing. Deciding the next step is an LLM call — on the
    // local model it is the single longest pause in the whole run, and instrumenting only
    // execution left exactly that stretch silent, which is the part the user is staring at.
    if (deps.onStep) {
      try { deps.onStep(!steps.length ? 'Working out how to do this' : 'Deciding what to do next'); } catch (e) {}
    }
    const lines = harness.transcript(run);
    if (hint) lines.push('NOTE: ' + hint);
    const step = await nextStep(goal, lines, guidance, allowTools, convo);
    hint = '';
    if (!step) { say = 'I could not work out the next step, Sir.'; break; }
    if (step.tool === 'done') {
      // Progress is counted in steps that SUCCEEDED, not steps attempted — five failures in a row is
      // not five sixths of a procedure.
      const okSteps = results.filter(x => x && x.ok).length;
      // A NAMED THING THAT DOES NOT EXIST YET IS NOT "DONE", whatever the step count says.
      //
      // This is checked BEFORE the step-count guard because the step count cannot see it. Measured:
      // asked for a.txt, b.txt and c.txt, the loop made the folder, a.txt and c.txt — three
      // successful side-effecting steps against three expected parts — and every count-based guard
      // agreed it had finished. Naming the missing file is also a far better hint than "carry on
      // with the procedure": it tells the model exactly what is outstanding instead of asking it to
      // work that out from a transcript it has already misread once.
      const missing = harness.missingArtifacts(goal, steps, results);
      if (missing.length && donePushbacks < harness.DONE_PUSHBACKS) {
        donePushbacks++;
        hint = 'You are NOT done. These were asked for and do not exist yet: ' + missing.join(', ') +
               '. Create them now, one tool call each, before saying done.';
        deps.jlog('Agent › refused "done" — never created: ' + missing.join(', '));
        continue;
      }
      const early = harness.prematureDone({
        procedureSteps: procedureStepLines.length, completedSteps: okSteps, pushbacks: donePushbacks,
      });
      if (early) {
        donePushbacks++;
        const next = (procedureStepLines[okSteps] || '').trim();
        hint = 'You are not done: ' + early.completed + ' of ' + early.total + ' steps of the procedure ' +
               'have actually run. ' + (next ? 'Do this next — ' + next : 'Carry on with the procedure.');
        deps.jlog('Agent › refused a premature "done" — ' + early.completed + '/' + early.total + ' steps run');
        continue;
      }
      return finishRun('done');
    }
    if (step.tool === 'fail') {
      // WHAT IT TRIED, not just that it failed. "I cannot do that with the tools I have" is true and
      // useless: it does not say whether it got nowhere or got three steps in and lost the thread,
      // and those need completely different help from him. Naming the steps also makes it obvious
      // when the approach was wrong rather than the request impossible.
      const tried = steps.slice(0, -1).map((st, i) => (results[i] && results[i].ok) ? st.tool.replace(/_/g, ' ') : null)
                         .filter(Boolean);
      const base = step.say || 'I have not worked out how to do that yet, Sir.';
      say = tried.length
        ? base + ' I got as far as ' + tried.slice(0, 4).join(', then ') + ' — and then ran out of ideas.'
        : base + ' I could not find a first step that made sense.';
      return finish(false);
    }
    const fn = tools[step.tool];
    if (!fn) {
      // Not a step — the model named something that does not exist. Costs a retry so a model stuck
      // hallucinating tool names cannot spin here forever, and tells it plainly what happened.
      run.retries++;
      hint = 'There is no tool called "' + step.tool + '". Use only the tools listed. Never invent one.';
      continue;
    }

    // Loop guard: a small model will happily retry the identical call forever, and often just never
    // emits "done" after the real work is finished. So a repeat is treated as "it has nothing left
    // to add" — if every step so far succeeded, that is a SUCCESS with the work already done, not a
    // failure. Reporting failure here would have called a completed job broken.
    const sig = step.tool + ':' + JSON.stringify(step.args || {});
    // …EXCEPT A LOOK WHOSE ANSWER CHANGED (2026-10-14). A repeated LOOK (LOOK_TOOLS — tools that only observe) is run again
    // and its result compared with the last time: the same answer is the loop above, a different one is progress (the page
    // scrolled, the app list changed). Before this, any repeat ended the run as a success, so re-reading a page after a
    // scroll reported "done" one step in. OpenHands' stuck detector draws the same line: a repeated action counts only with
    // a repeated observation. Every other tool — side effects, and any tool not listed as a look — is never re-run on
    // suspicion: that rule is unchanged.
    // A TOOL THE PROCEDURE CALLS ONCE (`once` on JARVIS's own playbook entry) has done its job after one success: another call
    // with tweaked arguments is the planner wandering (2026-10-15, his live turn ran find_businesses twice — the second only
    // added needPhone — and the reply carried both answers). The run ends on the first result.
    if (onceTools && onceTools.includes(step.tool) && steps.some((st, i) => st && st.tool === step.tool && results[i] && results[i].ok)) {
      deps.jlog('Agent › ' + step.tool + ' already answered — the procedure calls it once');
      return finishRun('done');
    }
    let repeatedLook = null;
    if (seen.has(sig)) {
      if (!LOOK_TOOLS.has(step.tool) || !lookSeen.has(sig)) return finishRun('repeat');
      repeatedLook = sig;
    }
    seen.add(sig);
    // Drift guard: identical-args repeats are caught above, but a small model also wanders —
    // after typing the requested text it emitted MORE type_text steps with junk ('§', 'Ctrl+A')
    // and wrote them into the document.
    //
    // This USED to be "two consecutive calls to the same side-effecting tool is wandering", full
    // stop. That rule cannot tell wandering from a goal that legitimately needs the same tool more
    // than once, and it resolved every such case as wandering — so "create nine files" created ONE
    // and reported success, and so did every other multi-part request. Measured, not theorised: a
    // perfectly-behaved model given a fifteen-file goal produced one file and "Done, Sir."
    //
    // The allowance now comes from the goal (harness.expectedParts). A one-part request behaves
    // exactly as before; a nine-part request gets nine. Identical targets and junk payloads are
    // still drift at any allowance, so the behaviour this guard was built to stop is untouched.
    if (SIDE_EFFECT_TOOLS.has(step.tool)) {
      sameToolStreak = step.tool === lastTool ? sameToolStreak + 1 : 1;
      if (step.tool === lastTool) {
        const kind = harness.consecutiveKind(step, steps[steps.length - 1], run, sameToolStreak);
        if (kind === 'drift') return finishRun('drift');
      }
    } else {
      sameToolStreak = 0;
    }
    // Redundant re-write: appending the SAME content to the SAME file that was just created with it.
    // A different tool each time, so the drift guard above does not see it, but the effect is a file
    // whose contents are doubled — "hello" written, "hello" appended, "hello hello" on disk. Seen on
    // every compound file goal the local model was given.
    if (step.tool === 'append' && lastTool === 'create_file') {
      const prev = steps[steps.length - 1];
      // Compared as RESOLVED paths, not raw strings: the model wrote "/Users/Mihir/Desktop/ok.txt"
      // on one step and "~/Desktop/ok.txt" on the next, which are the same file but not the same
      // text, so a string comparison missed the duplicate and the content doubled anyway.
      const norm = p => { try { return deps.resolvePath ? deps.resolvePath(String(p || '')) : String(p || ''); } catch (e) { return String(p || ''); } };
      if (prev && prev.args && norm(prev.args.path) === norm((step.args || {}).path) &&
          String(prev.args.content || '') === String((step.args || {}).content || '')) {
        deps.jlog('Agent › skipped a redundant append — that content was just written');
        return finishRun('repeat');
      }
    }
    // Reaching a person requires a recipient the model did not make up. A literal identifier is
    // only allowed if an earlier step actually looked a contact up; otherwise the value can only
    // have been invented, and inventing a phone number means messaging a stranger.
    // References are resolved HERE, before any guard or tool sees them. The loop previously never
    // resolved them at all — only fixed plans did — so a model emitting {{1.phone}} had the literal
    // placeholder handed straight to the tool. Worse, the invented-recipient guard trusts a
    // step-reference precisely BECAUSE it is meant to denote a real lookup, so an unresolved ref
    // sailed through the one check designed to stop a message reaching a stranger.
    const resolvedArgs = resolveRefs(step.args, results);
    if (resolvedArgs.missing.length) {
      run.retries++;
      hint = 'Step ' + step.tool + ' referenced ' + resolvedArgs.missing.join(', ') +
        ', but no earlier step produced that value. Use a real value, or run the step that produces it first.';
      deps.jlog('Agent › refused ' + step.tool + ' — unresolved ' + resolvedArgs.missing.join(', '));
      continue;
    }
    // THE RUN'S OWN RESULTS FILL A MESSAGE THE MODEL LEFT EMPTY (2026-10-10, casual dev m06/c12). The 3B ran find_contact →
    // compose (purpose "message") → send_message with no body and no recipient: "The message is empty, Sir — nothing to send."
    // The fixed plan threads these with {{1.phone}} / {{2.text}}; the loop now does the same from what THIS run produced, never
    // from the model's memory. A message's words come from the strict composer, which rewrites his own sentence and adds
    // nothing. Every send still stops for his yes — send_message asks first.
    let reading = null;
    if (step.tool === 'compose' && typeof deps.messageReading === 'function') { try { reading = deps.messageReading(goal); } catch (e) { reading = null; } }
    resolvedArgs.args = threadMessageArgs(step.tool, resolvedArgs.args, steps, results, goal, reading);
    // A destination that came from the model's memory rather than from the page. Fed back as a hint
    // rather than ending the run: the loop had usually just reached the RIGHT page, so the recovery
    // is "stay where you are", not "give up".
    // ALREADY THERE. When the caller says the page is open in front (screen-control goals rerouted to
    // this lane), any navigation is wrong by definition. Measured: told to click a labelled link on
    // the page in front, the loop navigated to an invented /submit instead — and the general
    // invented-destination guard let it past, because it only inspects path segments of 8+ characters
    // and short made-up words carry no identifier to check.
    if (opts.stayOnPage && step.tool === 'browser_go') {
      // ANY navigation, including a fragment. Comparing with the fragment stripped left a loophole the
      // loop walked straight into: told to click a link, it navigated to an invented #click-test on
      // the same page and counted as "not moving". Nothing on this path needs browser_go at all.
      const to = String((step.args && (step.args.url || step.args.to || step.args.target)) || '').trim();
      if (to) {
        run.retries++;
        hint = 'Do not navigate. The page you need is already open at ' + opts.stayOnPage +
               '. Use browser_elements on the page in front of you and click from that list.';
        deps.jlog('Agent › refused to navigate away from the page in front: ' + to.slice(0, 80));
        continue;
      }
    }
    if (harness.inventsDestination(step, goal + '\n' + guidance.join('\n') + '\n' +
        run.observations.map(o => o.text + ' ' + o.args).join('\n'))) {
      run.retries++;
      hint = 'That address is not on the page and nobody gave it to you — do not navigate to a URL you ' +
             'remembered. Use a link from the list you were shown, or read the page again.';
      deps.jlog('Agent › refused an invented URL: ' + String((step.args || {}).url || '').slice(0, 80));
      continue;
    }
    // Trust is judged on the ORIGINAL args (was it a reference?) while execution uses the RESOLVED
    // ones — so a value is only trusted when it both looked like a lookup and actually was one.
    if (CONTACT_OUT_TOOLS.has(step.tool)) {
      const resolved = steps.some(s => s.tool === 'find_contact');
      const literal = IDENTIFIER_ARGS.some(k => step.args && step.args[k] && !isStepRef(step.args[k]));
      if (literal && !resolved) {
        deps.jlog('Agent › refused ' + step.tool + ' — recipient was not resolved from Contacts');
        return { ok: false, plan: { kind: 'loop', goal, steps }, results, transcript: harness.transcript(run),
          say: 'I stopped short, Sir — that would have messaged a number I invented rather than one from your Contacts.' };
      }
    }
    lastTool = step.tool;

    // Say what is about to happen, before it happens — a step reported only on completion tells
    // the user what they already waited through.
    if (deps.onStep) { try { deps.onStep(describeAgentStep(step)); } catch (e) {} }

    // A run he already approved does not stop at every step. autoApprove is set for MULTI-STEP work
    // (a playbook procedure, a compound request) — the class where four prompts to watch one video
    // made the agent worse than doing it by hand. Money, people and destruction still stop, whatever
    // the run: see harness.needsExplicitApproval.
    const preApproved = !!opts.autoApprove && !harness.needsExplicitApproval(step);
    // `goal` rides along so a tool can check a value against what he ACTUALLY asked for. browser_fill
    // uses it to refuse an address he never gave — the same grounding test as inventsDestination.
    const r = await fn(resolvedArgs.args, { confirmed: preApproved, goal });
    steps.push(step);

    if (r.needsClarify) {
      return { ok: false, paused: true, clarify: true, at: steps.length - 1, plan: { kind: 'loop', goal, steps }, results, transcript: harness.transcript(run), options: r.options, say: r.say };
    }
    if (r.needsConfirm) {
      // Say what already HAPPENED before asking. A bare "Quit TextEdit, sir?" as the whole reply to
      // "make a folder and put a file in it" reads as though nothing else occurred — the work was
      // done, and the pause is about something the model wandered into afterwards.
      const already = results.filter(x => x && x.ok).length;
      const lead = already ? (results.filter(x => x && x.ok).pop().say || '') : '';
      return { ok: false, paused: true, at: steps.length - 1, plan: { kind: 'loop', goal, steps }, results, transcript: harness.transcript(run),
        // Carried through the pause so the REST of the run keeps the approval mode it started with.
        // Without it, a multi-step run that stopped once for a genuinely important step went back to
        // asking about every ordinary step afterwards.
        autoApprove: !!opts.autoApprove,
        confirm: { kind: 'agent_step', at: steps.length - 1, tool: step.tool, args: r.confirm.args },
        say: already ? harness.clip(lead, 160) + ' Before I go on — ' + r.say : r.say, preview: r.preview };
    }
    results[steps.length - 1] = r;
    if (LOOK_TOOLS.has(step.tool)) {
      const saw = lookOf(r);
      if (repeatedLook && lookSeen.get(repeatedLook) === saw) {
        deps.jlog('Agent › ' + step.tool + ' saw the same thing again — nothing new, stopping');
        return finishRun('repeat');
      }
      if (repeatedLook) deps.jlog('Agent › ' + step.tool + ' again, and it saw something new — carrying on');
      lookSeen.set(sig, saw);
    }

    // RECOVERY. A failure is classified and steered around rather than merely recorded. A terminal
    // failure — a permission denial, a safety refusal, a missing key — will never succeed however
    // the arguments are shuffled, so it is never retried: retrying a safety stop is precisely the
    // behaviour that must not exist, and retrying a permission denial just burns the budget.
    const kind = harness.classify(r);
    harness.record(run, step, r, kind);
    if (kind === 'ok') {
      // A tool that WORKS clears any lesson warning against it. Otherwise the store only ever
      // accumulates pessimism, and an agent that has learned nothing but what cannot be done
      // eventually stops trying the thing that would have worked.
      try { lessonStore.unlearn(goal, step.tool); } catch (e) {}
    }
    if (kind === 'asked') return finishRun('asked');      // a question for him ends the run — retrying cannot answer it
    if (kind !== 'ok') {
      run.retries++;
      hint = harness.recoveryHint(step, r, kind);
      deps.jlog('Agent › ' + kind + ' failure on ' + step.tool + ' (retry ' + run.retries + '/' + run.limits.maxRetries + ')');
      // Learning happens at the single exit (see learnFromFailure), not here. Doing both recorded
      // every terminal failure twice — the store deduplicates, so it showed up as a phantom second
      // "hit" rather than a second row, which is the kind of wrong number that quietly corrupts the
      // ranking that decides which lesson gets recalled.
      // A terminal failure on a side-effecting tool ends the run. Carrying on after being refused
      // permission to do the main thing produces a confident report about work that never happened.
      if (kind === 'terminal' && SIDE_EFFECT_TOOLS.has(step.tool)) return finishRun('terminal');
    }
    say = r.say || say;
  }
  return finishRun('exhausted');

  function finish(okFlag) {
    return { ok: okFlag, plan: { kind: 'loop', goal, steps }, results, transcript: harness.transcript(run), say };
  }

  // Single exit. Every path out of the loop routes through here so verification and the honest
  // verdict cannot be skipped by adding a new early return later — which is exactly how the old
  // code ended up with four different notions of what "done" meant.
  // Did the run stop short of what was asked? The repeat and drift guards both mean "the model has
  // nothing useful left to add", which on a one-part request genuinely IS finished — that is why
  // they are treated as success — but on a nine-part request means eight parts never happened, and
  // it was reported as success anyway.
  //
  // Three conditions, each one there to stop a FALSE alarm rather than to catch a true one:
  //   · parts >= 3 — a two-part phrasing ("open Spotify and play X") is routinely satisfied by a
  //     single tool that does the whole job, so counting steps against it would cry wolf constantly.
  //   · fewer side-effecting successes than parts — the actual shortfall.
  //   · the count was either STATED in the goal ("nine files"), or the model had visibly started
  //     working through a list (two or more side-effecting successes) before it stalled. Without
  //     this, "open Spotify, search for X and play it" — three parts by punctuation, one job that
  //     search_in_app does in a single step — would be reported as unfinished every single time.
  //     Verification is deliberately NOT used as the escape hatch here: it only ever reads back ONE
  //     step, so a confirmed last file says nothing about the eight before it.
  function stoppedShort() {
    // A PROCEDURE IS A CONTRACT, and its length measures the job far better than the phrasing of the
    // request does. "order me dominos pizza from swiggy" counts as ONE part, so the parts<3 test below
    // exempted it outright — and a nine-step procedure that ran three steps, typed a query into a
    // search box and stopped was reported as a success. The steps are right there; count them.
    const okSteps = results.filter(x => x && x.ok).length;
    // Named-but-never-created outranks every count below it. A count can be satisfied by the wrong
    // items — the folder plus two of three files scored 3 of 3 — so ask by name first.
    if (harness.missingArtifacts(goal, steps, results).length) return true;
    if (procedureStepLines.length && !stepsVary && okSteps < procedureStepLines.length - 1) return true;
    if (run.parts < 3) return false;
    const did = steps.filter((s, i) => SIDE_EFFECT_TOOLS.has(s.tool) && results[i] && results[i].ok).length;
    if (did >= run.parts) return false;
    return harness.partsAreCounted(goal) || did >= 2;
  }

  // LEARN FROM THE OUTCOME, not only from a classification.
  //
  // Lessons were written only when a STEP failed terminally, and the commonest real failure —
  // "Not sure which app you mean by Spotify" — classifies as retryable. So the store stayed empty
  // through repeated identical failures, and the thing that was supposed to stop JARVIS walking
  // into the same wall never saw the wall. A run that ENDED BADLY is the honest signal: whatever
  // the classifier thought, the attempt did not work.
  function learnFromFailure() {
    try {
      for (let i = steps.length - 1; i >= 0; i--) {
        const st = steps[i], rr = results[i];
        if (!st || !rr || rr.ok) continue;
        if (!harness.worthLearning(rr)) return;     // never write down a safety stop
        lessonStore.learn({ goal, tool: st.tool, target: harness.targetOf(st.args), why: rr.say, kind: 'failed-run' });
        return;                                     // the LAST failure is the one that ended it
      }
    } catch (e) {}
  }

  async function finishRun(reason) {
    // 'asked': a step is waiting on his answer — nothing to verify, nothing failed, nothing to learn either way.
    const waiting = reason === 'stopped' || reason === 'asked';
    if (!waiting && reason !== 'terminal') await verifyRun(run, tools);
    const short = (reason === 'repeat' || reason === 'drift') && stoppedShort();
    const v = harness.verdict(run, short ? 'incomplete'
      : (reason === 'done' || reason === 'repeat' || reason === 'drift' ? null : reason));
    // An explicit "done" from the model still has to survive verification: it is a claim, not proof.
    if (reason === 'done' && run.verified === false) {
      return { ok: false, plan: { kind: 'loop', goal, steps }, results, transcript: harness.transcript(run), say: v.say };
    }
    // THE SUCCESS HALF. lessons.js has always recorded what failed; nothing recorded what worked,
    // so a novel goal solved today was re-derived from scratch tomorrow. Recorded only when the
    // HARNESS verified it — the model's own "done" is a claim, not proof — and stored as a
    // hypothesis that must survive being used again before it is trusted.
    // `noLearn` is set for eval traffic, on the same reasoning the episodic diary already uses: a
    // test suite exercising the loop forty-six times should not be writing procedures into his store,
    // nor moving the ok/bad counters on the ones he actually taught.
    // NOR FROM A WALLED LOOKUP (opts.strictTools): a read-only procedure run under the reader's "nothing to do" is the procedure's
    // job, not a method to learn — his live turn 2026-10-15 recorded "view:resturants-near", two find_businesses calls with empty
    // slots, from a run that found nothing.
    if (v.ok && reason !== 'stopped' && deps.learned && !opts.noLearn && !opts.strictTools) {
      try {
        const done = steps.map((st, i) => ({ tool: st.tool, args: st.args || {}, ok: !!(results[i] && results[i].ok) }))
                          .filter(x => x.ok);
        deps.learned.learn(goal, done, { verified: run.verified !== false });
      } catch (e) {}
    }
    // A learned procedure that did not arrive is demoted and eventually forgotten. A stored method
    // that keeps failing is worse than none: it steers the loop down a path already shown not to work.
    // Gated on noLearn for the SAME reason the success half above is. Only the creation path was
    // guarded, so "an eval run must not teach the store" held for what the suite learned and not for
    // what it blamed — and blame is the more damaging half: failed() bumps bad and uses, and a
    // trusted procedure with bad >= ok is demoted to hypothesis. Forty-six tasks brushing against
    // his four taught lessons could therefore demote work he stood over and performed by hand.
    if (!v.ok && !waiting && deps.learned && !opts.noLearn) {
      try { deps.learned.failed(goal); } catch (e) {}
    }
    // THE OTHER STORE. Gating the learned procedures was only half of "an eval run must not teach
    // the store" — lessons.js is a second store with its own write path, and this line sat directly
    // beneath the gated one without a gate of its own. So every suite run went on filing its own
    // failures as things to avoid in his real lessons: "follow the more information link on
    // example.com" is a test fixture, and it was being recorded as a route not to take again.
    // Claiming that bug fixed while this remained is exactly the kind of half-fix the comment above
    // is meant to prevent.
    if (!v.ok && !waiting && !opts.noLearn) learnFromFailure();
    return Object.assign(
      { plan: { kind: 'loop', goal, steps }, results, transcript: harness.transcript(run) },
      v,
      reason === 'stopped' ? { stopped: true } : {});
  }
}

// ---------------- verification ----------------
// The difference between "the tool returned ok" and "the thing you asked for is true of the world".
// Those diverge constantly — add_calendar_event succeeds against the wrong calendar, open_app
// succeeds having launched nothing — and reporting the first as the second is this system's most
// misleading possible failure, because the user stops checking.
//
// Deliberately NOT an LLM judge. Asking a 3B "did you achieve the goal?" gets you a yes, and a
// confident yes about unverified work is worse than an honest "I could not confirm it".
async function verifyRun(run, tools) {
  // Paths are resolved the same way the tool resolved them before the verifier is built, or the
  // check reads a different location than the one that was written and reports a false alarm.
  if (deps.resolvePath) {
    for (const s of run.steps) {
      if (s && s.args && typeof s.args.path === 'string' && !s._pathResolved) {
        try { s.args.path = deps.resolvePath(s.args.path); s._pathResolved = true; } catch (e) {}
      }
    }
  }
  // Every distinct outcome the run produced, not just the final one. On a single-outcome run this
  // is one check, exactly as before; on a list it is one per item, which is the only way "I
  // confirmed it" can honestly refer to the whole list rather than to whichever part happened to
  // come last.
  const plans = harness.verificationsFor(run);
  if (!plans.length) { run.verified = null; return; }   // nothing independently checkable — say nothing

  let checked = 0, confirmed = 0, failed = 0;
  let how = '';
  for (const plan of plans) {
    const fn = tools[plan.tool];
    if (!fn) continue;
    try {
      const res = await fn(plan.args || {}, { confirmed: true });
      const hit = plan.match(res);
      if (hit === null) continue;               // this one is not checkable after all
      checked++;
      if (hit) confirmed++; else failed++;
      how = how || plan.describe;
      deps.jlog('Agent › verification of ' + plan.of + ' via ' + plan.tool + ' → ' + (hit ? 'confirmed' : 'NOT confirmed'));
    } catch (e) {
      // A broken check proves nothing either way — it is not counted as a failure, because
      // reporting "I could not confirm it" when the VERIFIER is what broke blames the wrong thing.
    }
  }

  if (!checked) { run.verified = null; return; }
  // One unconfirmed part makes the whole claim false. Nine files written and one missing is not
  // "confirmed" — and it is the missing one he needs to hear about.
  run.verified = failed === 0;
  run.verifiedHow = checked === 1 ? how
    : (failed === 0 ? 'checked all ' + checked + ' of them'
                    : 'checked all ' + checked + ' — ' + failed + ' of them did not take');
}

// ---------------- executor ----------------
// Runs steps in order, threading results forward. Stops at the first failure or
// the first step that needs confirmation, returning enough state to resume.
async function runPlan(plan, opts) {
  opts = opts || {};
  const results = Array.isArray(opts.priorResults) ? opts.priorResults.slice() : [];
  const startAt = Number(opts.startAt || 0);
  const transcript = Array.isArray(opts.transcript) ? opts.transcript.slice() : [];
  const steps = plan.steps;
  // allTools(), not TOOLS. TOOLS is only the 16 built-ins; every tool registered by server.js
  // (all of system_control, composio, library, recall, the browser tools) lives in sysTools and is
  // reachable solely through allTools(). runAgentLoop already does this; runPlan did not — so any
  // plan resumed after a confirmation looked its tool up in the wrong table, found nothing, pushed
  // "unknown tool" and broke out. Since a break with no failed step still reports ok:true, the user
  // was told "Done, Sir." while nothing whatsoever had run. That silently broke every confirm-gated
  // system tool — delete, move, close_app, overwrite — not just the browser ones.
  const tools = allTools();

  for (let i = startAt; i < steps.length; i++) {
    if (deps.stopped && deps.stopped()) {
      transcript.push('■ stopped by user');
      return { ok: false, stopped: true, plan, results, transcript,
        say: i > startAt ? 'Stopped, Sir — ' + (i - startAt) + ' step' + (i - startAt === 1 ? '' : 's') + ' in.' : 'Stopped, Sir.' };
    }
    const step = steps[i];
    const fn = tools[step.tool];
    // An unknown tool is a FAILURE, not a quiet stop. Reporting success for a plan that executed
    // nothing is the most misleading outcome available.
    if (!fn) {
      transcript.push('✗ unknown tool ' + step.tool);
      return { ok: false, plan, results, transcript,
        say: 'I could not run “' + step.tool + '”, Sir — I do not have that tool wired up.' };
    }
    const { args, missing } = resolveRefs(step.args, results);
    // An earlier step did not produce the field this one needs. Executing anyway would hand a tool
    // the literal text "{{2.phone}}" and call it a value.
    if (missing.length) {
      transcript.push('✗ ' + step.tool + ' — unresolved ' + missing.join(', '));
      return { ok: false, plan, results, transcript,
        say: 'I could not finish, Sir — ' + missing.join(' and ') + ' never came back from the earlier step.' };
    }
    // Narrate here too, not only in the agentic loop. Most real work goes through a DETERMINISTIC
    // plan (message, note, app-search), so instrumenting only the loop left the common path silent
    // — which is precisely the case the user is watching.
    if (deps.onStep) { try { deps.onStep(describeAgentStep({ tool: step.tool, args, why: step.why })); } catch (e) {} }
    // Confirm gate: the first outbound step pauses the whole plan and hands back
    // everything needed to resume exactly here once the user approves.
    // THE SAME PRE-APPROVAL THE LOOP HAS ALWAYS HAD.
    //
    // runAgentLoop honours autoApprove (behind harness.needsExplicitApproval); runPlan did not, so
    // the two halves of the same run disagreed about whether he had already said yes. A taught
    // procedure — the one kind of plan a person demonstrated step by step — stopped to ask about its
    // own first navigation even in lanes that pre-approve the whole run, while the model-chosen loop
    // running the identical step did not.
    //
    // The guard is the same one and it is not widened by an inch: send_message, the destructive
    // tools, a click whose label spends money and a checkout URL all still stop dead, whatever
    // autoApprove says. This only stops asking twice about the things it never asked about.
    const confirmedThis = opts.confirmedStep === i || opts.confirmedAll ||
                          (!!opts.autoApprove && !harness.needsExplicitApproval(step));
    const r = await fn(args, { confirmed: confirmedThis, goal: (plan && plan.goal) || '' });
    // Two kinds of pause: needsClarify asks a QUESTION (ambiguous contact — server.js resumes by
    // injecting the chosen candidate as this step's result, never by re-running the tool); needsConfirm
    // asks for APPROVAL of an already-decided action (resumes by re-running this same step confirmed).
    if (r.needsClarify) {
      return { ok: false, paused: true, clarify: true, at: i, plan, results, transcript, options: r.options, say: r.say };
    }
    if (r.needsConfirm) {
      return {
        ok: false, paused: true, at: i, plan, results, transcript,
        confirm: { kind: 'agent_step', at: i, plan, results, transcript, tool: step.tool, args: r.confirm.args },
        say: r.say, preview: r.preview,
      };
    }
    results[i] = r;
    transcript.push((r.ok ? '✓ ' : '✗ ') + step.tool.replace(/_/g, ' ') + (r.ok ? '' : ' — ' + r.say));
    if (!r.ok) return { ok: false, at: i, plan, results, transcript, say: r.say };
  }
  const last = results[results.length - 1] || {};
  return { ok: true, plan, results, transcript, say: last.say || 'Done, Sir.' };
}

// Full path: goal → plan → execute.
// ---------------- macros: teach it once, replay for free ----------------
// After the loop solves something, the exact tool sequence it found can be saved under a name and
// replayed WITHOUT the model — instant, deterministic, and it still works with Ollama down. That
// closes the gap where a repeat task paid full LLM planning cost every single time and could come
// out differently on each run.
// Persistence is injected by server.js (which owns STATE_DIR) rather than reading files here.
let macroStore = { load: () => ({}), save: () => {} };
function registerMacroStore(store) { if (store) macroStore = store; }
const macroKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function saveMacro(name, plan, goal) {
  const key = macroKey(name);
  if (!key) return { ok: false, say: 'What should I call it, Sir?' };
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return { ok: false, say: 'There is nothing to save, Sir.' };
  // Confirm-gated steps are stored too, so a replayed macro still stops for approval exactly where
  // the original run did — saving a macro must never silently upgrade its permissions.
  const all = macroStore.load();
  all[key] = { name: String(name).trim(), goal: goal || '', steps: plan.steps, saved: Date.now(), runs: 0 };
  macroStore.save(all);
  deps.jlog('Macro saved › "' + key + '" (' + plan.steps.length + ' step' + (plan.steps.length === 1 ? '' : 's') + ')');
  return { ok: true, say: 'Saved as “' + String(name).trim() + '”, Sir — say “run ' + String(name).trim() + '” any time.', key };
}
function getMacro(name) {
  const all = macroStore.load();
  const key = macroKey(name);
  if (all[key]) return all[key];
  // Tolerate near-misses ("run the morning setup" → "morning setup") without a model.
  const hit = Object.keys(all).find(k => k && (key.includes(k) || k.includes(key)));
  return hit ? all[hit] : null;
}
function listMacros() {
  const all = macroStore.load();
  return Object.keys(all).map(k => all[k]).sort((a, b) => b.saved - a.saved);
}
function deleteMacro(name) {
  const all = macroStore.load();
  const key = macroKey(name);
  const hit = all[key] ? key : Object.keys(all).find(k => k && (key.includes(k) || k.includes(key)));
  if (!hit) return { ok: false, say: 'No macro called “' + name + '”, Sir.' };
  const label = all[hit].name;
  delete all[hit]; macroStore.save(all);
  deps.jlog('Macro deleted › ' + hit);
  return { ok: true, say: 'Deleted “' + label + '”, Sir.' };
}

// The last plan that actually worked, so "save that as X" has something to refer to.
let lastGoodPlan = null;

// "save that as morning setup" / "run morning setup" / "forget morning setup" / "what macros..."
const MACRO_SAVE_RE = /^(?:can you |please )?(?:save|remember|store)\s+(?:that|this|it|those steps?)\s+(?:as|under)\s+(?:a\s+)?(?:macro\s+)?(?:called\s+)?["“]?(.+?)["”]?$/i;
const MACRO_RUN_RE = /^(?:can you |please )?(?:run|replay|do|execute|perform)\s+(?:the\s+|my\s+)?(?:macro\s+)?["“]?(.+?)["”]?(?:\s+macro)?$/i;
const MACRO_DEL_RE = /^(?:can you |please )?(?:forget|delete|remove|drop)\s+(?:the\s+|my\s+)?(?:macro\s+)?["“]?(.+?)["”]?(?:\s+macro)?$/i;
const MACRO_LIST_RE = /^(?:can you |please )?(?:list|show|what(?:'s| is| are)?|which)?\s*(?:are\s+)?(?:my\s+)?macros\b/i;

// Returns a handled result, or null if this is not a macro command. Entirely model-free.
async function macroCommand(text, opts) {
  const t = String(text || '').trim().replace(/[.?!]+$/, '');
  let m;
  if (/^(?:list|show|what are|what'?s in)?\s*(?:my\s+)?macros?$/i.test(t) || MACRO_LIST_RE.test(t)) {
    const list = listMacros();
    if (!list.length) return { ok: true, say: 'No macros saved yet, Sir — finish something and say “save that as <name>”.' };
    return { ok: true, say: 'Saved macros, Sir:\n' + list.map(mm => '· ' + mm.name + ' (' + mm.steps.length + ' step' + (mm.steps.length === 1 ? '' : 's') + (mm.runs ? ', run ' + mm.runs + '×' : '') + ')').join('\n') };
  }
  if ((m = t.match(MACRO_SAVE_RE))) {
    if (!lastGoodPlan) return { ok: false, say: 'Nothing recent to save, Sir — ask me to do something first.' };
    const r = saveMacro(m[1], lastGoodPlan.plan, lastGoodPlan.goal);
    return { ok: r.ok, say: r.say };
  }
  if ((m = t.match(MACRO_DEL_RE)) && getMacro(m[1])) {
    const r = deleteMacro(m[1]);
    return { ok: r.ok, say: r.say };
  }
  if ((m = t.match(MACRO_RUN_RE))) {
    const macro = getMacro(m[1]);
    if (!macro) return null;              // not a macro name — let normal routing handle it
    deps.jlog('Macro run › "' + macro.name + '" (' + macro.steps.length + ' steps, no model)');
    const r = await runPlan({ kind: 'macro', steps: macro.steps }, opts);
    if (!r.paused) {
      const all = macroStore.load();
      const key = macroKey(macro.name);
      if (all[key]) { all[key].runs = (all[key].runs || 0) + 1; all[key].lastRun = Date.now(); macroStore.save(all); }
    }
    r.macro = macro.name;
    return r;
  }
  return null;
}

// One yes/no question to the model: is this request the same JOB as a procedure he demonstrated?
//
// Deliberately the narrowest possible use of a 3B. It is not choosing a tool, not planning, not
// ranking a list — it is answering "same job or not" about two short phrases, which is about the
// most reliable thing a small model does. It is also never the last word: a `true` here only earns
// the right to ASK him. Anything that fails or times out is a no, because silence must not replay.
async function sameJob(goal, entry) {
  if (!deps.llm) return false;
  const what = entry.description || entry.goal || '';
  if (!what) return false;
  try {
    const r = await deps.llm({
      system: 'Answer only with JSON: {"same": true} or {"same": false}. Two short phrases describe ' +
              'tasks on a computer. Say whether they are the SAME job, done the same way, differing ' +
              'only in which thing it is done to. Opposites (subscribe vs unsubscribe, follow vs ' +
              'unfollow, add vs remove) are NOT the same job.',
      messages: [{ role: 'user', content: 'A: ' + what + '\nB: ' + goal + '\nSame job?' }],
      max_tokens: 20, timeoutMs: 20000,
      schema: { type: 'object', properties: { same: { type: 'boolean' } }, required: ['same'],
                additionalProperties: false },
    });
    const s = String(r.text || '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s).same === true;
  } catch (e) { return false; }
}

// Deterministic patterns first (instant, model-free, work with Ollama down), then the agentic loop
// for everything else. The loop is what makes this general instead of a list of memorised phrasings.
async function runGoal(goal, opts) {
  const t0 = Date.now();
  // THE WALL HOLDS ON EVERY PATH (opts.strictTools, 2026-10-14): a taught replay, an offer to reuse a lesson and a fixed
  // plan all run tools before the loop is reached, so under a caller's strict list none of them may run anything outside
  // it — taught procedures are skipped (noReplay), and a fixed plan is used only if every step is inside the list.
  const strictList = opts && opts.strictTools && Array.isArray(opts.allowTools) ? opts.allowTools : null;
  if (strictList) opts = Object.assign({}, opts, { noReplay: true });
  // RESOLVE FIRST — BEFORE ANY STORED PROCEDURE GETS TO CLAIM THIS REQUEST.
  //
  // This block used to sit a hundred lines further down, after the taught-procedure replay, and
  // that ordering cost him the wrong action on his own account:
  //
  //     ◆ who is mrbeast
  //       MrBeast is a popular YouTuber…
  //     ◆ open his youtube channel
  //       Clicked "View your channel", Sir.        ← HIS channel, not MrBeast's
  //
  // The log for that turn has all three facts in order: the resolver worked out "mrbeast", the
  // playbook matcher abstained at margin 0.011, and then a taught procedure keyed on the single
  // word "view" replayed regardless and clicked a label from the original demonstration. Every
  // guard added upstream was bypassed because replay ran before any of them.
  //
  // A stored procedure carries the TARGET it was taught with. Replaying one for a request whose
  // target we have just admitted we cannot read is the most reliable way to act on the wrong
  // thing, which is exactly what happened.
  let refers = null;
  // `opts` is optional here and this function never normalises it — a scheduled task fires
  // runGoal(goal) with nothing at all, and the stress suite calls it bare on purpose.
  if (opts && Array.isArray(opts.messages) && opts.messages.length >= 2 && !opts.seed && !opts.resolved) {
    const sf = await standsFor(goal, opts.messages);
    if (sf.ok) {
      refers = sf.value;
      deps.jlog('Reference › "' + String(goal).slice(0, 50) + '" leans on the conversation → "' +
                refers + '" (extractive, verbatim in the transcript)');
      // PUT IT BACK INTO THE SENTENCE IF WE CAN NAME THE WORDS IT REPLACES.
      //
      // Diverting a resolved request to the loop was worse than the bug: the loop had never seen
      // "search him up on brave" before, so it offered to be TAUGHT and searched nothing at all.
      // The table knew the shape all along — it only had the wrong argument. Repair the argument
      // and the fast path does the job it was always able to do.
      const wf = await wordsFor(goal, refers);
      if (wf) {
        const rebuilt = goal.slice(0, wf.at) + refers + goal.slice(wf.at + wf.words.length);
        deps.jlog('Reference › "' + goal.slice(0, 50) + '" → "' + rebuilt.slice(0, 60) + '"');
        goal = rebuilt;
        refers = null;             // it is named in the sentence now; nothing left to carry
      }
    }
  }
  // A REQUEST WE COULD NOT READ DOES NOT REPLAY A DEMONSTRATION.
  //
  // `refers` still set means the sentence leans on the conversation and the referent could not be
  // put back into it. The loop still gets the goal AND the referent (see convoBlock), so nothing
  // is refused outright — it just is not allowed to reuse a procedure whose arguments belong to a
  // different request.
  const unreadable = !!refers;
  // A PROCEDURE HE DEMONSTRATED IS RUN, NOT HINTED AT.
  //
  // Recall injects one line of prompt text — "last time this worked as browser go → browser click" —
  // which a 3B may follow or quietly ignore, and which does not even carry the arguments. For a
  // procedure a person taught, whose every argument is already known, that wastes the demonstration:
  // it can simply be executed, with no model in the path at all.
  //
  // Falls straight through to the loop if the replay fails. A stored method that no longer fits the
  // page should cost one honest attempt, not the whole request — and that failure is recorded, so a
  // procedure which has stopped working gets demoted and eventually forgotten.
  let replayed = null;
  if (deps.learned && !(opts && opts.noReplay) && !unreadable) {
    try { replayed = deps.learned.replayable(goal); } catch (e) {}
  } else if (unreadable) {
    deps.jlog('Agent › not replaying anything taught — "' + String(goal).slice(0, 40) +
              '" points at "' + refers + '" and a stored procedure carries its own target');
  }
  // WORDS DID NOT DECIDE IT, SO ASK — ONCE, AND REMEMBER THE ANSWER.
  //
  // The store's scorer settles almost everything: eleven of twelve real phrasings of a taught lesson
  // are recognised outright. The twelfth is the interesting one — "follow mrbeast on youtube" against
  // a lesson about subscribing. Those share no letters, so no amount of lexical cleverness gets
  // there, and quietly replaying on a hunch would act on his real account because two sentences
  // rhymed.
  //
  // So the model is asked only in that gap, and it does not get the final say either: it filters, HE
  // decides, and his answer is written into the procedure's vocabulary. The next request phrased that
  // way scores as certain and nobody is asked again. That is the difference between a synonym list
  // somebody wrote and a system that learns how he talks.
  // Same gate as the replay above: offering to reuse a lesson for a request whose target we
  // could not read invites him to approve the wrong thing.
  if (!replayed && !unreadable && deps.learned && deps.learned.candidate &&
      !(opts && (opts.noReplay || opts.sameAsDeclined))) {
    let cand = null;
    try { cand = deps.learned.candidate(goal); } catch (e) {}
    if (cand && cand.taught && cand.steps && cand.steps.length && await sameJob(goal, cand)) {
      const what = cand.description || cand.goal;
      deps.jlog('Agent › "' + String(goal).slice(0, 40) + '" might be the lesson for "' +
                String(what).slice(0, 40) + '" — asking');
      return {
        ok: false, paused: true, clarify: true, sameAs: { key: cand.key, phrasing: goal },
        plan: { kind: 'loop', goal, steps: [] }, results: [], transcript: [],
        options: [{ name: 'Yes, same thing' }, { name: 'No, work it out' }],
        say: 'Is that the same as ' + what + ', Sir? You showed me that one — if it is the same job I ' +
             'will use it, and I will remember that you say it this way.',
      };
    }
  }
  if (replayed) {
    // Fill this request's specific into the template. Null means the procedure needs a target and the
    // request named none — replaying it would act on whoever was named LAST time and report success,
    // so it falls through to working it out instead.
    const filled = deps.learned.fillSlots ? deps.learned.fillSlots(replayed.steps, goal) : replayed.steps;
    if (!filled) {
      deps.jlog('Agent › a taught procedure fits but names nothing to act on — working it out instead');
      replayed = null;
    } else {
    deps.jlog('Agent › "' + String(goal).slice(0, 50) + '" → [taught] ' + filled.map(st => st.tool).join(' → '));
    // A DEMONSTRATION IS THE STRONGEST APPROVAL THIS SYSTEM HAS, AND IT WAS BEING ASKED FOR AGAIN.
    //
    //     ◆ open his youtube channel
    //       Agent › the taught procedure is waiting on approval at step 1 of 3
    //       …13 seconds of him typing "yes"…
    //
    // He stood over these steps and approved every one of them at teach time — that is what teaching
    // IS — and then every replay stopped to ask about the same steps again, one at a time. The note
    // in runPlan already makes this argument for playbooks: "A run he already approved does not stop
    // at every step ... the class where four prompts to watch one video made the agent worse than
    // doing it by hand." A taught procedure is that case in its strongest form, and it was the one
    // lane not getting it.
    //
    // MONEY, PEOPLE AND DESTRUCTION STILL STOP, whatever the run — autoApprove is filtered through
    // harness.needsExplicitApproval, which independently holds back outbound tools, destructive
    // tools, any click or fill whose arguments read as a purchase, and any navigation to a checkout
    // or payment URL. So what this removes is the prompt in front of "open a page" and "press the
    // button he pointed at", not the one in front of sending a message or spending his money.
    const r0 = await runPlan({ kind: 'taught', goal, steps: filled.map(st => ({ tool: st.tool, args: st.args })) },
                             Object.assign({}, opts, { autoApprove: true }));
    // A PAUSE IS NOT A FAILURE — and reading it as one is why nothing he taught ever survived.
    //
    // The first step of every taught browser procedure is browser_go, which stops to ask "Open … in
    // Brave, Sir?". runPlan hands that back as { paused: true, ok: false }, and the `r0.ok` test below
    // read it as "the stored method no longer fits": the procedure was recorded as a failure, its
    // remaining steps thrown away, and the goal re-derived from scratch by the model. Because the
    // agentic loop ALSO records a failure when its own re-derivation misses, one reuse could cost two
    // demotions — so a trusted procedure was demoted on first use and forgotten on second, every time.
    // Measured over the whole log before this change: three taught replays attempted, three
    // "no longer fits", zero completions. The feature had never once worked in production.
    //
    // The pause is handed back untouched. Its plan is kind:'taught' and carries every remaining step,
    // so /api/agent/confirm resumes it with runPlan and finishes the demonstration — no model in the
    // path, which was the entire point of teaching it.
    if (r0 && r0.paused) {
      deps.jlog('Agent › the taught procedure is waiting on approval at step ' + ((r0.at || 0) + 1) +
                ' of ' + filled.length);
      r0.ms = Date.now() - t0; r0.goal = goal; r0.taught = true;
      return r0;
    }
    if (r0 && r0.ok) {
      r0.ms = Date.now() - t0; r0.goal = goal; r0.taught = true;
      deps.jlog('Agent › replayed a taught procedure in ' + r0.ms + 'ms');
      return r0;
    }
    // `r0.at` is the index of the step that actually broke, and it was being discarded — so the
    // store recorded "this failed" when the trace could say "step 4 failed; 1-3 were fine".
    deps.jlog('Agent › the taught procedure stopped at step ' + ((r0 && r0.at != null ? r0.at : -1) + 1) +
              ' — working it out instead');
    // The replay-a-taught-procedure blame path, and the one that actually fired: an eval run reached
    // here, failed() dropped the entry below its threshold, and the procedure was forgotten outright.
    // Gated for the same reason as every other write — the suite exercises his lessons, it does not
    // get to grade them.
    if (!opts.noLearn) { try { deps.learned.failed(goal, r0 && r0.at, r0 && r0.say); } catch (e) {} }
    }
  }
  // RESOLVE BEFORE THE TABLE READS THE STRING.
  //
  // deterministicPlan is regexes over the raw sentence. Given "search him up on brave" its capture
  // group is "him up", and search_in_app ran with that as the query — a plan built confidently on a
  // word that means nothing on its own. The table is right about the SHAPE (this is an app search)
  // and cannot possibly be right about the ARGUMENT, because the argument was said a turn earlier.
  //
  // So a request that leans on the conversation does not go to the table at all. It goes to the
  // loop, which now gets the conversation AND the referent standsFor proved was really said. The
  // fast path is untouched for everything self-contained, which is most things: standsFor answers
  // NONE and the table runs exactly as before.
  const fixed0 = refers ? null : deterministicPlan(goal, await shapeOf(goal));
  const fixed = fixed0 && strictList && !fixed0.steps.every(s => strictList.includes(s.tool)) ? null : fixed0;
  let r;
  if (fixed) {
    deps.jlog('Agent › "' + String(goal).slice(0, 60) + '" → [fixed] ' + fixed.steps.map(s => s.tool).join(' → '));
    r = await runPlan(fixed, opts);
  } else {
    deps.jlog('Agent › "' + String(goal).slice(0, 60) + '" → [loop]' + (refers ? ' (refers to ' + refers + ')' : ''));
    r = await runAgentLoop(goal, refers ? Object.assign({}, opts, { refers }) : opts);
  }
  r.ms = Date.now() - t0;
  r.goal = goal;
  // Remember a plan that actually worked so "save that as <name>" has something real to store.
  // Only successful, non-paused runs qualify — saving a half-finished or aborted sequence would
  // bake a broken macro in for good.
  if (r.ok && !r.paused && r.plan && Array.isArray(r.plan.steps) && r.plan.steps.length) {
    lastGoodPlan = { plan: r.plan, goal };
  }
  if (!r.paused) deps.jlog('Agent › ' + (r.ok ? 'done' : 'stopped') + ' in ' + r.ms + 'ms — ' + (r.transcript || []).join('; '));
  return r;
}

// "do something for me" vs ordinary chat. Deliberately narrow: these are phrasings
// that clearly ask for an ACTION with content, not a question.
const AGENT_RE = new RegExp(
  '^\\s*(?:can you |could you |please |jarvis[,\\s]+)*(?:' +
    'send (?:a )?(?:message|text|msg)\\b|message\\s+\\w|msg\\s+\\w|text\\s+\\w+\\s+(?:saying|asking|about|that)\\b|whatsapp\\s+\\w+\\s+(?:saying|asking|about|that)\\b|imessage\\s+\\w+\\s+(?:saying|asking|about|that)\\b|' +
    '(?:whatsapp\\s*call|video\\s*call|voice\\s*call|call)\\s+\\w+.*\\bwhatsapp\\b|' +
    'remind me\\b|add (?:a )?reminder\\b|' +
    '(?:open (?:up )?(?:the )?notes?\\b.*\\b(?:write|compose|draft)|(?:write|compose|draft)\\b.*\\bin (?:my )?notes?\\b)|' +
    '(?:write|compose|draft)\\s+(?:me\\s+)?(?:a|an)\\s+(?:passage|note|paragraph|essay|piece|poem|haiku|limerick|verse|rhyme|song|lyrics|story|joke|riddle|speech|toast|short\\s+haiku)\\b' +
  ')', 'i');
// A goal is often prefixed by WHEN to do it ("at 6pm message mama…", "tomorrow morning text dad…").
// AGENT_RE is start-anchored to stay tight, so strip a leading time phrase before testing — the
// caller (server.js) separately decides whether that time means "schedule it" or "do it now".
const LEAD_TIME_RE = /^\s*(?:(?:at|by|around)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|in\s+\d+\s*(?:minute|min|hour|hr|second|sec)s?|tomorrow(?:\s+(?:morning|afternoon|evening|night))?|tonight|later(?:\s+today)?|this\s+(?:morning|afternoon|evening)|every\s*day|each\s+day|daily|every\s+(?:morning|evening|night|week)|weekly|next\s+week)\b[,\s]*/i;
const stripLeadTime = t => String(t || '').replace(LEAD_TIME_RE, '').trim();
// A compound app instruction ("open X and search Y", "search Y in X") is agent work, but ONLY when
// the named target is a real installed app — otherwise "search cats on youtube" would be stolen from
// the site-registry path in server.js, which handles websites better than driving a browser UI.
const compoundAppIntent = async t => {
  const s = String(t || '').trim().replace(/[.?!]+$/, '');
  if (!s) return false;
  // The shape first, because it is the cheaper question to be wrong about: a miss here falls through
  // to the loop, which is where an unrecognised shape went before.
  //
  // APPINSTALL BELONGS HERE FOR THE SAME REASON APPSEARCH DOES, and leaving it out cost the whole
  // install feature on its first live run. Measured, from his screen:
  //
  //     ◆ Open app store and install among us
  //       Chat › clause routing, partial: [Open app store] then asking about "install among us"
  //       Chat › install among us  →  prompt › system 4300 chars  →  "Alright, installing Among Us."
  //       routed → clauses:1+ask
  //
  // The sentence was cut in half before the shape was ever consulted. The head opened the App Store,
  // the tail was handed to the 3B as a QUESTION, and the 3B answered it by announcing an
  // installation that never happened. install_app was never called; nothing was searched.
  //
  // "open X and install Y" is one errand with one destination, exactly like "open X and search Y" —
  // splitting it produces a head that is a detour and a tail that has lost the app it belongs to.
  const shape = await shapeOf(s);
  // AN INSTALL NAMES ITS DESTINATION OPTIONALLY, WHICH IS WHY IT DOES NOT GO THROUGH appIn.
  // "install among us" names no app at all and is still one errand; the source is resolved from the
  // thing being installed, not from the sentence. Requiring a named installed app here is what kept
  // this returning false even after the shape was recognised.
  if (shape === 'appinstall') return true;
  if (shape !== 'appsearch') return false;
  // AND A REAL, INSTALLED APP — unchanged, and still the point. Without it "search cats on youtube"
  // would be stolen from the site registry in server.js, which handles websites by URL, instantly,
  // without driving a browser UI. appIn applies the same 0.75 floor that stops "calculator" reaching
  // "Claude Code URL Handler".
  return !!appIn(s);
};
// OPERATING A SITE IS AGENT WORK. MERELY OPENING ONE IS NOT.
//
// The note on compoundAppIntent above is right that site goals belong to the site registry — for OPEN
// and SEARCH, which it does by URL, instantly, without driving a browser. It cannot star a repo,
// follow a channel or archive an email: those need the page operated.
//
// Until now those fell through the statement guard into plain chat, where the model answered
// "Understood, I will star the JARVIS repository on your GitHub." Nothing was starred. A fabricated
// confirmation for work that never happened is the worst thing this system can produce, and it is the
// reason this exists.
//
// Deliberately verb-led and narrow. open/search/find/go-to are ABSENT, so everything the registry
// already handles keeps flowing there — this claims only the goals it would otherwise drop.
const SITE_ACTION_RE = new RegExp('\\b(?:' +
  'star|unstar|upvote|downvote|' +
  'like|unlike|favou?rite|' +
  'follow|unfollow|subscribe|unsubscribe|' +
  'comment|repl(?:y|ies)|retweet|repost|' +
  'post|upload|publish|tweet|' +
  'archive|unarchive|mute|unmute|block|unblock|report|' +
  'label|assign|merge|reopen|' +
  'bookmark|pin|unpin|' +
  'delete|remove' +
  ')\\b', 'i');
// "follow up with X" is a reminder, not a follow. Same word, different act.
const NOT_SITE_ACTION_RE = /\bfollow up\b/i;
// A question about a site is conversation. "should I follow him on twitter" is a musing, and reading
// it as an instruction would act on one.
const SITE_Q_RE = /^\s*(?:what|why|how|who|when|where|which|whose|is|are|was|were|do|does|did|can|could|should|would|will|am)\b|\?\s*$/i;
const siteActionIntent = t => {
  const str = String(t || '').trim();
  if (!str || SITE_Q_RE.test(str)) return false;
  if (NOT_SITE_ACTION_RE.test(str)) return false;
  if (!SITE_ACTION_RE.test(str)) return false;
  // A bare domain counts alone; otherwise the site must be one the registry knows by name — the same
  // registry the open/search path uses, so the two can never disagree about what a site is.
  if (/\b[a-z0-9-]+\.(?:com|org|net|io|dev|co|in|app|gg|tv)\b/i.test(str)) return true;
  return !!(deps.knownSite && deps.knownSite(str));
};

// THE CALENDAR LIMB IS GONE FROM HERE, AND DELIBERATELY DID NOT TAKE THIS FUNCTION ASYNC WITH IT.
//
// calendarIntent() was CAL_LIST_RE and FREE_SLOT_RE — whole phrasings written out, so "am i busy
// today" and "kal koi meeting hai kya" were not calendar work. It is replaced by calintent.js, which
// asks the embedder, and asking is asynchronous.
//
// Making agentIntent async to suit it would have rippled into 25 assertions across two suites,
// several of them in a 1052-assertion file whose top level is synchronous — and an assertion that
// silently stops running because it now returns a Promise is a worse outcome than the trap being
// fixed. So the semantic check sits BESIDE this one at the router (server.js), where the caller is
// already async, and this function keeps answering the synchronous part of the question.
// ASYNC NOW. compoundAppIntent asks shapeOf, and asking an embedder cannot be done synchronously.
// This was deferred once already — the calendar limb was moved out to the router to avoid exactly
// this ripple — but the cheap half is spent: replacing the verb table next needs the same thing, and
// two functions that must agree about "is this agent work" is the disease this codebase keeps
// catching. The synchronous tests that called this now await it; there were 24 of them.
//
// The regex tests run FIRST and short-circuit, so the common case still costs no embedding at all.
const agentIntent = async t => {
  const s = String(t || '');
  if (AGENT_RE.test(s) || AGENT_RE.test(stripLeadTime(s)) || siteActionIntent(s)) return true;
  return (await compoundAppIntent(s)) || (await compoundAppIntent(stripLeadTime(s)));
};

module.exports = {
  _nextStep: nextStep,   // exported for sweeps/sweep_modelcmp.js: the loop's own decision prompt, nothing executed
  init, TOOLS, CONFIRM_TOOLS, TOOL_HELP, registerSystemTools, allTools, registerMacroStore, registerUndo,
  macroCommand, saveMacro, getMacro, listMacros, deleteMacro,
  planTask, deterministicPlan, shapeOf, structuralPlan, warmContacts, personIn, llmPlan, runPlan, runGoal, runAgentLoop, registerLessonStore, registerPlaybook, registerDynamicTools,
  scopeToGoal, TOOL_FAMILIES,
  agentIntent, compoundAppIntent, stripLeadTime, sameApp, resolveRefs, threadMessageArgs, find_contact, compose, pickChannel, waDigits,
  focus_app, type_text, press_key, search_in_app, install_app, uninstall_app, resolveInstallSource, pickInstallControl, click_at, scroll, screen_elements, screen_press, realKey,
  list_events, find_free_slot, find_businesses,
  // composer v2 (README "Composer v2"): the composer's own prompt and cleaning, and the judge's question, for sweeps/sweep_composer_v2.js
  strictComposeSystem, cleanDraft, composeJudgeMessages, COMPOSE_JUDGE_AT, composeDirectMessages, DIRECT_EXAMPLES, COMPOSE_SURE_AT,
};
