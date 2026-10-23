'use strict';
// WHAT NEEDS HIM, decided from the machine's own numbers — never from anything he typed.
//
// His rule (2026-09-25): "when greeting ONLY report battery when (<20%) or anything else when it needs
// attention". The chat model used to be handed CPU, RAM, battery and disk on every turn, and a model
// handed numbers talks about them: Bonsai 4B opened greetings with the time and the battery. So the chat
// reply now sees only what needs attention (server.js systemPrompt); the numbers themselves stay out.
//
// Thresholds: battery under 20% and not charging (his number; proactive.js speaks up unprompted at 15%),
// disk at 92% (proactive.js's own line), and any fleet agent that is down.
const ATTENTION_BATTERY = 20;
const ATTENTION_DISK = 92;

// s: getStats() shape {batteryPct, charging, diskPct, …}; down: names of fleet agents not running.
function attentionItems(s, down) {
  const out = [];
  if (s && s.batteryPct != null && !s.charging && s.batteryPct < ATTENTION_BATTERY) out.push('battery ' + s.batteryPct + '% and not charging');
  if (s && s.diskPct != null && s.diskPct >= ATTENTION_DISK) out.push('disk ' + s.diskPct + '% full');
  if (down && down.length) out.push('DOWN: ' + down.join(', '));
  return out;
}

module.exports = { attentionItems, ATTENTION_BATTERY, ATTENTION_DISK };
