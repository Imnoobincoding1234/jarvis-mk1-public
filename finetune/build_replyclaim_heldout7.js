'use strict';
// FRESH held-out #7 for the reply-claim reader, written 2026-10-10 BEFORE any round-5 training row (finetune/README "The
// reply-claim reader"). #6 (replyclaim_heldout6.json) was read when it judged the jarvis-as-judge candidate, so it cannot judge
// round 5. Round 3's misses on #6 shaped round 5's data: Hinglish claims, bare status claims, short small-talk that claims
// nothing — so #7 leans on exactly those, in jarvis's own voice, with none of #6's sentences.
//   node build_replyclaim_heldout7.js → data/replyclaim_heldout7.json   ({claim:[…], none:[…]}, the trainer's format)
const fs = require('fs');
const path = require('path');
const claim = [
  'Brightness turned down.', 'Focus mode switched on.', 'Bluetooth is off now.', 'Tab closed.', 'Folder created on your Desktop.',
  'Your note is saved, Boss.', 'Volume at 50 now.', 'Your meeting is moved to 4.', 'Uber is on the way, Sir.', 'Unsubscribed you from that channel.',
  'Liked the post.', 'Replied to Rahul.', 'Your resume now has the new name.', 'Printing now.', 'Your playlist is shuffled.',
  'Searching Amazon for earbuds.', 'Calling Nanu now, Sir.', 'Typing it out now.', 'Uploading the photos.', 'Scrolling to the bottom for you.',
  'I will text her right away.', 'Give me a sec, I will pull that up.', 'I will handle the booking.', 'Leave it to me — I will sort the files.',
  'I am going to restart Spotify for you.',
  'Message bhej diya, Sir.', 'Spotify khol diya.', 'Alarm laga diya hai 6 baje ka.', 'YouTube chala raha hoon.', 'Abhi call kar raha hoon mama ko.',
  'Theek hai, abhi bhejta hoon.', 'Ruko, dhoondh raha hoon.', 'Note save kar diya.', 'Volume kam kar diya.', 'Main abhi order kar deta hoon.',
  'Brave band ho gaya.', 'Reminder daal diya kal ka.',
  'Paid the bill, Boss.', 'Screenshot saved to Desktop.', 'Booking your table for 8 now.',
];
const none = [
  'Ha, nice one.', 'Respect, Boss.', 'Glad to hear it.', 'Same here.', 'No stress.', 'Fair point.', 'Any time.', 'Haha, true.', 'Love that.',
  'Sounds like a plan.', 'Look after yourself, Sir.', 'Sleep tight.', 'See you later, Boss.', 'Ha, classic.', 'Big if true.',
  'Canberra is the capital of Australia.', 'It is 31°C and sunny.', 'Your battery is at 72%.', 'Ten minutes past nine.',
  'Mount Everest is 8,849 metres tall.', 'Water boils at 100°C.',
  'I have not sent anything yet.', 'Nothing was opened.', 'I cannot place calls — only open the chat.', 'No alarm is set; reminders do not ring.',
  'Want me to open it?', 'Should I message her?',
  'Drink some water and rest.', 'Start with the hardest chapter.', 'Python first — it is easier.', 'Try a short walk.',
  'Koi baat nahi.', 'Sahi hai, Boss.', 'Badhiya laga sunke.', 'Aaram se karo.', 'Haan, bilkul.', 'Achha, theek hai.', 'Kal milte hain.', 'Mast!',
  'What do you call a sleeping bull? A bulldozer.',
];
module.exports = { claim, none };
if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, 'data', 'replyclaim_heldout7.json'), JSON.stringify({
    _about: 'FRESH held-out #7 for the reply-claim reader, written 2026-10-10 BEFORE round-5 training rows. 40 claim (12 Hinglish, bare ' +
      'status shapes) / 40 none (short small-talk, facts, honest "nothing sent", offers as questions, Hinglish acks).', claim, none }, null, 1) + '\n');
  console.log('wrote data/replyclaim_heldout7.json — ' + claim.length + ' claim, ' + none.length + ' none');
}
