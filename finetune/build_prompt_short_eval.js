'use strict';
// THE SHORT SYSTEM PROMPT CANDIDATES (2026-10-09), rendered from the live prompts so the ONLY difference is the text swapped.
// His complaint: 20 s for "hey sir". Measured: jarvis reads the ~960-token system prompt cold on every message (the reader
// pushes it out), 13.5 s at 71 tok/s with Low Power Mode on, 4.9 s at 196 tok/s with it off. Fewer tokens = less to read.
//
// Input: data/bonsai_eval_prompts_ps_long.jsonl (build_bonsai_eval.js on data/prompt_heldout_v1.json = the live prompt).
// Output: data/bonsai_eval_prompts_ps_A.jsonl and _B.jsonl. Candidates (pre-registered in README "Short system prompt"):
//   A — his preference lines reworded shorter (same settings, same meaning) + the short capability text   
//   B — his preference lines unchanged                                    + the short capability text   
// The capability text describes JARVIS's OWN abilities (machine-owned); nothing here names kinds of user message.
//
//   node build_prompt_short_eval.js            (also prints token counts with the Bonsai tokenizer)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PREFS_A = [
  'Address him naturally and vary it — "Sir", "Boss", or his name (Atharv).',
  'Manner: dry and quick, like the JARVIS of the films; light banter only when it fits, never when he is in a hurry or something failed.',
  'Length: one line for actions that worked; fuller for questions and failures, with a brief why.',
  'When unsure: go ahead for anything reversible; ask first before changing state, sending, or leaving the machine.',
  'His hours vary daily; never assume a timetable.',
  'He mixes in Hindi/Punjabi and Hinglish; always answer in English.',
  'Use he/him when writing about him to others.',
  'On an unfamiliar name, ask which contact he means; never guess a recipient.',
  'Never sugar-coat; push back where his reasoning is weak.',
  'Explain at 9th-10th grade unless asked otherwise.',
].map(l => '- ' + l).join('\n');

const CAPS_SHORT = 'You really can: open/close apps and sites, search the web, research by reading real pages (with sources), control ' +
  'the screen on request, see the screen and camera, drive app UIs (type, click, search inside an app), run Shortcuts, workflows ' +
  'and saved macros, schedule, watch conditions, brief on demand or on a schedule, quiz the user from their own books, preview a ' +
  'plan before running it, recall past chats with real dates and apps open in the last 48h, read the calendar and find free ' +
  'slots, write Notes, add reminders and calendar events, and message people (WhatsApp by default). These execute automatically ' +
  '— just acknowledge. Messages are shown as a draft and go out only after the user approves — never claim one went out unless ' +
  'it did. You speak up unprompted for meetings and low battery, silent overnight. Cloud lane: live news, stock prices, places, ' +
  'and Gmail/Slack/Notion once connected. You cannot: run shell commands, place WhatsApp calls (only the chat opens), read ' +
  'notifications or Focus state, see follower counts, or set a real alarm (a reminder keeps the time in its title and does not ' +
  'alert at that time).';

const D = p => path.join(__dirname, 'data', p);
const rows = fs.readFileSync(D('bonsai_eval_prompts_ps_long.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
// The live prompt is: identity line + "\n" + preference lines, "\n\n", capability text, "\n\n", memory, "\n\n", clock/attention.
function swap(sys, cand) {
  const parts = sys.split('\n\n');
  if (parts.length !== 4 || !parts[1].startsWith('You really can:') || !parts[2].startsWith('Known about the user')) throw new Error('unexpected prompt shape');
  const nl = parts[0].indexOf('\n');
  const identity = parts[0].slice(0, nl);
  parts[0] = cand === 'A' ? identity + '\n' + PREFS_A : parts[0];
  parts[1] = CAPS_SHORT;
  return parts.join('\n\n');
}
for (const cand of ['A', 'B']) {
  const out = rows.map(r => Object.assign({}, r, { messages: [{ role: 'system', content: swap(r.messages[0].content, cand) }, r.messages[1]] }));
  fs.writeFileSync(D('bonsai_eval_prompts_ps_' + cand + '.jsonl'), out.map(r => JSON.stringify(r)).join('\n') + '\n');
}
// Token counts of one greeting's system prompt, through the model's own tokenizer.
const one = rows[0].messages[0].content;
const py = 'import sys,json\nfrom tokenizers import Tokenizer\nt=Tokenizer.from_file(sys.argv[1])\nfor s in json.load(sys.stdin): print(len(t.encode(s).ids))';
const r = spawnSync(path.join(__dirname, '.venv', 'bin', 'python'), ['-I', '-c', py, path.join(__dirname, 'models', 'Bonsai-4B-mlx-1bit', 'tokenizer.json')],
  { input: JSON.stringify([one, swap(one, 'A'), swap(one, 'B')]), encoding: 'utf8' });
const [l, a, b] = r.stdout.trim().split('\n');
console.log('wrote data/bonsai_eval_prompts_ps_{A,B}.jsonl (' + rows.length + ' prompts each)\nsystem prompt tokens: long ' + l + ', A ' + a + ', B ' + b + (r.stderr ? '\n' + r.stderr : ''));
module.exports = { PREFS_A, CAPS_SHORT, swap };
