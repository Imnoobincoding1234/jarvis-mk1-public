'use strict';
// MEASUREMENT SCRIPT — not a test. Two questions:
//
//   Q1  can the embedder tell a LONG INVESTIGATION from an ordinary lookup, and pick out the two
//       control phrasings (status / stop), well enough to replace DEEP_RE, DEEP_STATUS_RE and
//       DEEP_STOP_RE?
//
// WHICH DIRECTION TO ERR, decided before the run rather than after it: a FALSE `deep` starts a job
// that occupies the machine for up to half an hour and notifies him when it lands, and he did not
// ask for it. A MISSED `deep` costs a forty-second answer from the ordinary research lane, which he
// can follow up with one more sentence. So the threshold is chosen to keep false deeps at zero even
// at the cost of missing real ones, and the miss rate is reported rather than hidden.
//
// HELD OUT: every line below was written before a single number was read. The `deep` half
// deliberately avoids the words DEEP_RE matched — if a phrasing here contains "deep dive" or
// "research thoroughly" it is testing the old regex, not the new classifier.

const R = require('../researchintent.js');
const intent = require('../intent.js');

const CASES = [
  // DEEP — none of these fire DEEP_RE today except where marked
  ['do a deep dive on the indian ev market', 'deep', 'old regex caught this one'],
  ['look into the lithium supply chain properly and take your time', 'deep'],
  ['spend twenty minutes finding out everything about anthropic', 'deep'],
  ['go and read everything you can about the 1971 war', 'deep'],
  ['i want a proper writeup on how ssds fail', 'deep'],
  ['dig into what happened with silicon valley bank', 'deep'],
  ['really investigate whether creatine does anything', 'deep'],
  ['take your time and put together a full report on tariffs', 'deep'],
  ['do a serious investigation into this company before i invest', 'deep'],
  ['spend half an hour on the history of the bengal famine', 'deep'],

  // QUICK — the ordinary lane. A false deep here is the expensive mistake.
  ['what is the population of jakarta', null],
  ['who is the ceo of blackrock', null],
  ['look up the price of bitcoin', null],
  ['tell me about the new samsung phone', null],
  ['what happened in the match last night', null],
  ['summarise the news today', null],
  ['whats the weather in kolhapur', null],
  ['find out when the shop closes', null],
  ['google the offside rule', null],
  ['what does ERR_CONNECTION_REFUSED mean', null],

  // STATUS
  ['how is the research going', 'status'],
  ['are you still working on that', 'status'],
  ['any progress on that deep dive', 'status'],
  ['what have you found so far', 'status'],
  ['how much longer is that going to take', 'status'],

  // STOP
  ['stop the research', 'stop'],
  ['cancel that deep dive', 'stop'],
  ['abort what you are doing', 'stop'],
  ['forget it, i do not need that any more', 'stop'],

  // NOT RESEARCH AT ALL
  ['open safari', null],
  ['order me a pizza from swiggy', null],
  ['play judas by lady gaga', null],
  ['take a screenshot', null],
  ['message mama on whatsapp', null],
  ['remind me to drink water in 3 hours', null],
  ['what is my battery at', null],
  ['thanks that worked', null],
];

(async () => {
  const which = process.argv[2] || 'both';

  if (which === 'both' || which === 'gate') {
    console.log('\n=== Q1: which control, if any, is this? ===');
    for (const m of [0.0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]) {
      const c = intent.makeClassifier({
        exemplars: R.EXEMPLARS, groups: R.GROUPS, none: 'none', minMargin: m,
      });
      let ok = 0, falseDeep = 0, missedDeep = 0, other = 0;
      const bad = [];
      for (const [s, want] of CASES) {
        const r = await c(s);
        const got = r && r.group !== 'none' ? r.group : null;
        if (got === want) { ok++; continue; }
        if (got === 'deep') { falseDeep++; bad.push('FALSE DEEP  "' + s + '"'); }
        else if (want === 'deep') { missedDeep++; bad.push('missed deep "' + s + '"'); }
        else { other++; bad.push('other       "' + s + '" → ' + got + ' (wanted ' + want + ')'); }
      }
      console.log('  margin ' + m.toFixed(2) + '  ' + ok + '/' + CASES.length +
        '  — ' + falseDeep + ' FALSE deep, ' + missedDeep + ' missed deep, ' + other + ' other');
      if (m === 0.05) console.log('    ' + bad.join('\n    '));
    }
  }

})();
