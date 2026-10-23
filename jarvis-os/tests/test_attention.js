'use strict';
// attention.js — what the chat reply is allowed to bring up unasked. Pure: no model, no state, no server.
const assert = require('assert');
const { attentionItems, ATTENTION_BATTERY, ATTENTION_DISK } = require('../attention.js');

let n = 0;
const eq = (got, want, what) => { assert.deepStrictEqual(got, want, what); n++; };
const normal = { batteryPct: 64, charging: false, diskPct: 61 };

eq(attentionItems(normal, []), [], 'normal machine needs nothing');
eq(attentionItems({ ...normal, batteryPct: 19 }, []), ['battery 19% and not charging'], 'under 20 and discharging');
eq(attentionItems({ ...normal, batteryPct: ATTENTION_BATTERY }, []), [], 'exactly 20 is not under 20');
eq(attentionItems({ ...normal, batteryPct: 21 }, []), [], 'just above the line');
eq(attentionItems({ ...normal, batteryPct: 5, charging: true }, []), [], 'low but charging: nothing he must do');
eq(attentionItems({ ...normal, batteryPct: null }, []), [], 'no battery (desktop Mac)');
eq(attentionItems({ ...normal, diskPct: ATTENTION_DISK }, []), ['disk 92% full'], 'disk at the proactive line');
eq(attentionItems({ ...normal, diskPct: 91 }, []), [], 'disk just under');
eq(attentionItems(normal, ['Clap Listener']), ['DOWN: Clap Listener'], 'an agent down');
eq(attentionItems({ batteryPct: 9, charging: false, diskPct: 97 }, ['A', 'B']),
  ['battery 9% and not charging', 'disk 97% full', 'DOWN: A, B'], 'everything at once, stable order');
eq(attentionItems(null, null), [], 'no readings at all');

console.log('\n' + n + ' passed, 0 failed');   // a failed assert throws first and exits non-zero
