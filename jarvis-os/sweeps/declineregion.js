'use strict';
// declineregion.js — FOR MEASURING ONLY. Round 1 of the answer check (2026-10-08) shipped this as step 2: the reply,
// embedded with nomic-embed-text, against "the source does not answer that" vs "an answer" (intent.makeClassifier;
// exemplars from jarvis's training declines and the 27 v4.2 replies). Round 2 removed it from grounded.js — the
// thresholded judge alone did better on both held-outs, with no model swap — and it read Hinglish declines as answers.
// Kept here so sweep_answercheck.js and sweep_answercheck_r2.js can still reproduce their numbers (same exemplars → the
// same cached centroids).
const intent = require('../intent.js');

const DECLINE_EXEMPLARS = {
  decline: [
    'The source does not answer the question about who discovered Uranus.',
    'The capital of Norway is not mentioned in the provided source.',
    'The source does not provide the height of the Eiffel Tower.',
    'The source does not provide information about who was the first woman to climb Everest.',
    'The page I found does not say. Want me to search again?',
    'Nothing in the source answers that, Sir. Want me to try another search?',
    'That source is about something else and does not answer it. Should I look elsewhere?',
    'I only have this page, and it does not answer that. Another search?',
    'The source I have does not say, so I will not guess.',
    'The source does not provide a specific amount of sleep needed by teenagers.',
    'Source mein yeh nahi hai, Boss — guess nahi karunga. Phir se search karun?',
    'Jo page mila usme yeh nahi likha. Dobara search karun?',
  ],
  answer: [
    'The Nutcracker was composed by Pyotr Ilyich Tchaikovsky.',
    'The capital of Bhutan is Thimphu.',
    'The currency of Thailand is the Thai baht.',
    'The Golconda fort is a fortified citadel on the western outskirts of Hyderabad, Telangana, India.',
    'Sunlight takes about 8.3 minutes to reach Earth from the surface of the Sun.',
    'Kinetic energy is the form of energy that an object possesses due to its motion.',
    'The Mughal Empire was founded by Babur.',
    'A. P. J. Abdul Kalam is called the Missile Man of India.',
    'The Hawa Mahal was built by Sawai Pratap Singh in 1799.',
    'Bharatanatyam is an Indian classical dance form that comes from Tamil Nadu.',
    'Charminar Hyderabad ke purane sheher ke beech mein hai, Boss.',
    'Nepal ki currency Nepalese rupee hai, jo Nepal Rastra Bank jaari karta hai.',
  ],
};
const DECLINE_MODEL = 'nomic-embed-text';
const DECLINE_AT = -0.035;   // round 1's margin (the mean of the two halves' choices, −0.030 and −0.040)
let _region = null;
// → signed margin (+ toward "does not answer"), or null when the embedder is unavailable
async function declineMargin(reply) {
  if (!_region) _region = intent.makeClassifier({ exemplars: DECLINE_EXEMPLARS, minMargin: 0, none: '__unused__',
    model: DECLINE_MODEL, label: 'Grounded decline' });
  const r = await _region(String(reply || ''));
  if (!r) return null;
  return r.id === 'decline' ? r.margin : -r.margin;
}
async function declines(reply) { const m = await declineMargin(reply); return m === null ? null : m > DECLINE_AT; }

module.exports = { DECLINE_EXEMPLARS, DECLINE_MODEL, DECLINE_AT, declineMargin, declines };
