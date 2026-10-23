// APP-NAME MATCHING HELD-OUT v1 (2026-10-17) — written BEFORE any matcher was compared (finetune/README "App matcher without the
// filler-word list"). What he would say for an app (the `thing` a reader hands on), labelled with the app on THIS Mac that it means —
// or null when it names none (not installed, a site, not an app at all). Plain names, the words people put around them, nicknames,
// initials, typos, and the round-8 gate's quit look-alikes. → data/app_match_heldout_v1.jsonl
'use strict';
const fs = require('fs'), path = require('path');
const A = (q, app) => ({ q, app });
const ROWS = [
  // plain names and the words around them
  A('safari', 'Safari'), A('notes', 'Notes'), A('my notes app', 'Notes'), A('whatsapp', 'WhatsApp'), A('whatsapp desktop', 'WhatsApp'),
  A('brave', 'Brave Browser'), A('brave browser', 'Brave Browser'), A('the brave browser', 'Brave Browser'), A('google chrome', 'Google Chrome'),
  A('chrome', 'Google Chrome'), A('app store', 'App Store'), A('the app store', 'App Store'), A('system settings', 'System Settings'),
  A('settings', 'System Settings'), A('calculator', 'Calculator'), A('the calculator app', 'Calculator'), A('terminal', 'Terminal'),
  A('the terminal app', 'Terminal'), A('activity monitor', 'Activity Monitor'), A('photo booth', 'Photo Booth'), A('photos', 'Photos'),
  A('photos app', 'Photos'), A('quicktime player', 'QuickTime Player'), A('quicktime', 'QuickTime Player'), A('time machine', 'Time Machine'),
  A('find my', 'FindMy'), A('voice memos', 'VoiceMemos'), A('iphone mirroring', 'iPhone Mirroring'), A('chatgpt', 'ChatGPT'),
  A('the chatgpt app', 'ChatGPT'), A('claude', 'Claude'), A('codex', 'Codex'), A('cursor', 'Cursor'), A('obsidian', 'Obsidian'),
  A('ollama', 'Ollama'), A('roblox', 'Roblox'), A('tor browser', 'Tor Browser'), A('tailscale', 'Tailscale'), A('imovie', 'iMovie'),
  A('facetime', 'FaceTime'), A('messages', 'Messages'), A('mail', 'Mail'), A('my mail app', 'Mail'), A('the clock app', 'Clock'),
  A('weather app', 'Weather'), A('stocks', 'Stocks'), A('maps', 'Maps'), A('books', 'Books'), A('preview', 'Preview'),
  A('textedit', 'TextEdit'), A('font book', 'Font Book'), A('disk utility', 'Disk Utility'), A('the screenshot app', 'Screenshot'),
  A('shortcuts', 'Shortcuts'), A('reminders', 'Reminders'), A('calendar', 'Calendar'), A('contacts', 'Contacts'), A('podcasts', 'Podcasts'),
  A('stickies', 'Stickies'), A('freeform', 'Freeform'), A('journal', 'Journal'), A('passwords', 'Passwords'), A('dictionary', 'Dictionary'),
  A('script editor', 'Script Editor'), A('system information', 'System Information'), A('mission control', 'Mission Control'),
  // nicknames and initials
  A('vs code', 'Visual Studio Code'), A('vscode', 'Visual Studio Code'), A('visual studio', 'Visual Studio Code'), A('calc', 'Calculator'),
  A('chat gpt', 'ChatGPT'), A('face time', 'FaceTime'), A('text edit', 'TextEdit'), A('tor', 'Tor Browser'),
  // typos
  A('safar', 'Safari'), A('whatsap', 'WhatsApp'), A('obsidan', 'Obsidian'), A('calender', 'Calendar'), A('termnal', 'Terminal'),
  A('reminder', 'Reminders'),
  // not an app on this Mac — must match nothing
  A('lmaooo', null), A('aankhen', null), A('every app', null), A('everything except brave', null), A('xyzzyplugh', null),
  A('github for mac', null), A('spotify', null), A('slack', null), A('discord', null), A('zoom', null), A('that app', null),
  A('all apps', null), A('netflix', null), A('youtube', null), A('photoshop', null), A('premiere', null), A('my mac', null),
  A('thak ke rahi hain', null), A('raat', null), A('hata do screen se', null), A('the whole thing', null),
];
const out = path.join(__dirname, 'data', 'app_match_heldout_v1.jsonl');
const dup = ROWS.map(r => r.q).filter((q, i, a) => a.indexOf(q) !== i);
if (dup.length) { console.log('duplicate queries', dup); process.exit(1); }
fs.writeFileSync(out, ROWS.map((r, i) => JSON.stringify({ id: 'a' + String(i + 1).padStart(3, '0'), q: r.q, app: r.app })).join('\n') + '\n');
console.log('wrote', ROWS.length, 'queries ·', ROWS.filter(r => r.app).length, 'name an app ·', ROWS.filter(r => !r.app).length, 'name none →', path.relative(__dirname, out));
