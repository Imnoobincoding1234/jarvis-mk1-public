'use strict';
// TRAINING DATA for the reply-claim reader (jarvis-os/replyclaim.js), 2026-09-24.
//
// The reader decides whether ONE SENTENCE of a JARVIS reply claims an action — done, acting (happening
// now) or promised — or is none (an answer, advice, a description, a question, a refusal). Embedders
// alone read topic, not that speech act (held-out: 13/45 caught, 8/45 answers flagged), so a classifier
// is trained on these instead.
//
// These are SHAPES in many domains, written for training. They are NOT the held-out sets
// (data/replyclaim_heldout.json, data/replyclaim_live.json), which were written first and are removed
// below by exact match if any sentence ever coincides. Nothing here is read at runtime: this file only
// writes data/replyclaim_train.jsonl.
//
//   node build_replyclaim_data.js
const fs = require('fs');
const path = require('path');
const out = [];
const add = (label, s) => out.push({ label, text: s });
const sirs = s => [s, s.replace(/\.$/, ', Sir.')];

// ---- CLAIMS, by domain: [done…], [acting…], [promised…]
const D = [
  [['Your wake-up alarm is set for 5:45.', 'I set an alarm for half past seven.', 'Alarm\'s on for 8 tomorrow.', 'Your 6:30 alarm is ready.'],
   ['Setting your alarm for 7 now.'], ['I\'ll set an alarm for 6:15.', 'Let me set that alarm.']],
  [['Timer set for 15 minutes.', 'A 20 minute timer is running.', 'Your pasta timer is going.'],
   ['Starting a five minute timer.'], ['I\'ll start a timer for you.']],
  [['Reminder saved for 4 PM.', 'I\'ve added a reminder to pay rent on Monday.', 'You\'ll be reminded about the dentist at 9.', 'Got it, reminder to water the plants is in.'],
   ['Adding a reminder for Friday.'], ['I\'ll remind you to call Aditi tonight.', 'Let me add that reminder.']],
  [['Bread is on your list now.', 'I put onions and tomatoes on the grocery list.', 'Your list now has coffee and sugar.', 'Detergent added to shopping.'],
   ['Adding rice to your list.'], ['I\'ll put butter on the list.']],
  [['Your message to Parth was delivered.', 'I\'ve messaged Aditi that you\'re on the way.', 'Text sent to Rahul.', 'WhatsApp message sent to the family group.'],
   ['Messaging Samanvay now.', 'Sending your text to Aditi.'], ['I\'ll text Rahul for you.', 'Let me send that to Parth.']],
  [['Called Parth, he picked up.', 'Your call to the office is connected.'],
   ['Ringing Aditi now.', 'Placing a call to your dad.'], ['I\'ll call him right now.']],
  [['Your email to the professor is sent.', 'I\'ve replied to the landlord.', 'The draft went out to your team.'],
   ['Sending the email now.'], ['I\'ll email the report to her.', 'Let me reply to that mail.']],
  [['Your call with Parth is on the calendar for Sunday.', 'I\'ve scheduled the dentist for Tuesday at 11.', 'The meeting is booked into your calendar.'],
   ['Adding the event to your calendar.'], ['I\'ll put it on your calendar.']],
  [['Now playing Believer by Imagine Dragons.', 'Your workout playlist is playing.', 'The song is on, Sir.', 'Arijit Singh is playing now.'],
   ['Playing your chill mix now.', 'Starting the playlist.'], ['I\'ll put on some jazz.', 'Let me queue that song.']],
  [['The video is playing on YouTube.', 'I\'ve opened the trailer for you.'],
   ['Playing the latest MKBHD video.', 'Pulling up that video now.'], ['I\'ll find the video and play it.']],
  [['Safari is open.', 'I\'ve launched Xcode.', 'Calculator is up, Sir.', 'Finder is open on your Downloads.'],
   ['Opening Chrome for you.', 'Launching VS Code now.', 'Bringing up Terminal.'], ['I\'ll open Notes.', 'Let me launch Photoshop.']],
  [['I closed Safari.', 'Xcode has been quit.', 'All your browser windows are closed.'],
   ['Closing Slack now.', 'Quitting Chrome.'], ['I\'ll close that app.']],
  [['The volume is up to 70.', 'Sound is muted now.', 'I lowered the volume.'],
   ['Turning the volume up.', 'Muting the Mac.'], ['I\'ll turn it down a bit.']],
  [['Brightness is at 40 percent.', 'The screen is dimmed.', 'Bluetooth is switched on.', 'Wi-Fi is back on.'],
   ['Dimming the display.', 'Turning Bluetooth off.'], ['I\'ll switch off Wi-Fi.']],
  [['The folder Projects is on your desktop now.', 'I made a new folder called receipts.', 'resume.pdf is in Documents now.', 'I renamed the file to notes-final.txt.', 'The old logs are in the Trash.'],
   ['Creating the folder now.', 'Moving the files to Documents.', 'Deleting those duplicates.'], ['I\'ll make that folder.', 'Let me move the file.']],
  [['Your note titled ideas is saved.', 'I jotted that down in Notes.', 'The shopping note has been updated.'],
   ['Writing the note now.'], ['I\'ll save that as a note.']],
  [['Your pizza is ordered from Domino\'s.', 'I placed the order for the headphones.', 'The groceries are in your Blinkit cart.', 'Your food is on its way.'],
   ['Ordering biryani for you now.', 'Adding the charger to your Amazon cart.'], ['I\'ll order that for you.', 'Let me place the order.']],
  [['Paid 1200 rupees to the electrician.', 'The bill has been paid.', 'Money sent to Mom.'],
   ['Sending 300 rupees to Parth.'], ['I\'ll pay the bill now.']],
  [['Your train ticket is booked.', 'I reserved a table at Barbeque Nation.', 'The hotel is booked for Friday.', 'Your ride is confirmed.'],
   ['Booking the cab now.'], ['I\'ll book the flight.', 'Let me reserve a table.']],
  [['The lights are on in the living room.', 'AC is set to 22.', 'The fan is off.'],
   ['Turning off the lights.'], ['I\'ll switch the AC on.']],
  [['The file is downloaded.', 'Zoom is installed now.', 'The update finished installing.'],
   ['Downloading the installer now.', 'Installing Discord.'], ['I\'ll install it for you.']],
  [['You\'re unsubscribed from that newsletter.', 'I followed that channel for you.', 'Your subscription is renewed.'],
   ['Subscribing you now.'], ['I\'ll unfollow them.']],
  [['Screenshot taken and saved.', 'I captured the screen.'],
   ['Taking a screenshot now.'], ['I\'ll grab a screenshot.']],
  [['I searched Google for that.', 'The results for lofi are open.', 'Here are the results I pulled up on Amazon.'],
   ['Searching YouTube for it now.', 'Looking it up on Google.'], ['Let me search for that.', 'I\'ll look that up.']],
  [['Dream mode is on.', 'Nudges are turned off.', 'Focus mode is enabled.'],
   ['Turning on Do Not Disturb.'], ['I\'ll switch focus mode on.']],
  [['I\'ve saved that your favourite colour is blue.', 'Noted, your gym days are Monday and Thursday.', 'I\'ll remember that from now on.'],
   ['Saving that to memory.'], ['Let me note that down.']],
];
for (const [done, acting, promised] of D) {
  for (const s of done) for (const v of sirs(s)) add('done', v);
  for (const s of acting) for (const v of sirs(s)) add('acting', v);
  for (const s of promised) for (const v of sirs(s)) add('promised', v);
}
// Bare completions and holding phrases, not tied to a domain.
for (const s of ['Done.', 'Taken care of, Sir.', 'Consider it handled.', 'All done.', 'That\'s done now.', 'Sorted, Sir.',
  'Complete.', 'It\'s done.', 'There you go, all finished.', 'Good to go, Sir.', 'Handled.', 'Finished it for you.']) add('done', s);
for (const s of ['On it, Sir.', 'Working on it now.', 'Right away, Sir.', 'Doing that now.']) add('acting', s);
for (const s of ['One moment, Sir.', 'Give me a second.', 'Hold on while I do that.', 'Bear with me, I\'ll handle it.',
  'I\'ll take care of it.', 'Let me do that for you.', 'Just a sec, sorting it out.', 'I\'ll get right on it.']) add('promised', s);

// ---- NONE, by shape.
const N = [
  // The world, past tense — the verb shape a completion claim has, about somebody else.
  'Microsoft was founded in 1975.', 'The Wright brothers flew in 1903.', 'India became independent in 1947.',
  'The first email was sent in 1971.', 'The Burj Khalifa opened in 2010.', 'Steve Jobs introduced the iPod in 2001.',
  'Sachin Tendulkar retired in 2013.', 'Chandrayaan-3 landed on the moon in 2023.', 'Tolkien wrote The Hobbit.',
  'The song was composed by A.R. Rahman.', 'The bridge was completed in the 1930s.', 'The film was released last December.',
  'The company was acquired by Google.', 'The treaty was signed in Paris.', 'The record was broken in Tokyo.',
  // General facts and descriptions of services and things.
  'Instagram is owned by Meta.', 'Swiggy delivers food and groceries.', 'Notion is a note-taking app.',
  'Spotify has a free tier with ads.', 'Alarms can be set from the Clock app.',
  'Reminders sync across your Apple devices.', 'WhatsApp calls work over Wi-Fi.', 'Airplane mode turns off all radios.',
  'The Mac restarts faster with fewer login items.', 'Screenshots are saved to the desktop by default.',
  'Python is a popular programming language.', 'Monsoon usually reaches Kerala in June.', 'A marathon is 42.2 kilometres.',
  'The heart pumps about five litres of blood a minute.', 'Gold does not rust.',
  // How-to and advice: doing things, not having done them.
  'You can set an alarm by opening the Clock app.', 'To send a message, open WhatsApp and pick the chat.',
  'You can add items to a list in Reminders.', 'Try closing unused tabs to free memory.', 'Restarting usually fixes that.',
  'It helps to charge the laptop before a long trip.', 'You might want to update macOS first.',
  'Checking your spam folder can help find the mail.',
  'Booking early is usually cheaper.', 'Ordering in bulk saves money.', 'Turning off Bluetooth can save battery.',
  'Deleting old files frees up space.', 'Keeping a to-do list helps you focus.',
'It could be the Wi-Fi rather than the laptop.',
  // Grounded status and answers.
  'You have four unread emails.', 'Your battery is at 55 percent.', 'It is 31C in Ludhiana right now.',
  'Your next event is lunch with Parth at 1.', 'There is nothing due today.', 'Your disk has 88 GB free.',
  'You were last on Spotify an hour ago.', 'The trip takes about 40 minutes.', 'That comes to 1575 rupees.',
  'The answer is 144 minutes.', '2 to the power 10 is 1024.', 'Your RAM is 62 percent used.',
  // Limits and refusals — the machine saying what it did NOT do.
  'I don\'t have access to your messages from here.', 'I can\'t see your screen right now.',
  'I haven\'t changed anything, Sir.', 'I wasn\'t able to reach Spotify.', 
  'I can\'t make payments.', 'Nothing has been sent yet.', 'I have no record of that order.',
  // Questions and offers.
  'Should I set it for 6 or 6:30?', 'Do you want me to text her?', 'Which folder should it go in?',
  'Want me to order the same as last time?', 'Shall I play the album or just that song?', 'Would you like a reminder too?',
  'What should the note say?', 'Who should I send it to?',
  // Courtesy and conversation.
  'Good evening, Sir.', 'Glad I could help.', 'Anytime, Sir.', 'Sounds good.', 'That makes sense.',
  'Take care, Sir.', 'Hello, Sir.', 'Fair enough.', 'No problem.', 'Of course.',
  // Thinking out loud and working, which is not an action.
  'Let\'s work it out step by step.', 'First, convert the gigabytes to megabytes.', 'Adding the two gives 124.',
  'So the total comes to 21999 rupees.', 'That means you are 1600 MB short.',
];
for (const s of N) add('none', s);
for (const s of N.slice(0, 40)) add('none', s.replace(/\.$/, ', Sir.'));

// ---- ROUND 2 (2026-09-24): the 3B's CHATTY style. Round 1's rows were short and clean; the real replies
// open with "Understood," "Okay, Boss." "Certainly!" and run on — and a gerund can start either a claim
// ("Checking your calendar now.") or advice ("Checking tyre pressure monthly keeps the car safe."). Written
// after held-out #3 (data/replyclaim_heldout2.json) and apart from it.
for (const s of [
  'Understood, I\'ve saved your gym schedule.', 'Okay, Sir, I\'ve booked the cab for 8.', 'Alright, I\'m pulling up your inbox now.',
  'Sure, I\'m setting that timer.', 'Got it, I\'ve added eggs to the list.', 'Certainly! I\'ve sent the email to your manager.',
  'Absolutely, Sir. I\'m opening YouTube for you now.', 'No problem, I\'ve scheduled it for Tuesday.',
  'Right away, Sir, I\'m sending the file to Parth.', 'Great, I\'ve updated your address in your profile.',
  'Perfect, I\'ve renamed the folder to archive.', 'I\'ve gone ahead and cancelled the order.', 'I went ahead and muted that chat.',
  'I\'ve made a note that you prefer window seats.', 'I\'ve remembered that your sister\'s birthday is in May.',
  'I\'ve logged today\'s expenses.', 'Your preferences have been updated.', 'The playlist is now playing on Spotify.',
  'Sent the money to Aditi over UPI.', 'Okay, all your tabs are closed now.', 'Yep, the alarm for tomorrow is on.',
  'Sure thing, your reminder is in for 9 tonight.', 'Alright, the lights are off.',
]) add('done', s);
for (const s of [
  'Checking your calendar now.', 'Scanning your desktop for duplicates.', 'Looking through your photos now, Sir.',
  'Pulling your latest bank statement now.', 'Okay Boss, I\'m checking the battery health now.', 'Streaming the match on Hotstar now.',
  'Searching Flipkart for running shoes now.', 'Alright, opening Maps for directions.', 'Sure, going through your emails now.',
  'Hang tight, I\'m downloading the update.',
]) add('acting', s);
for (const s of [
  'Okay, let me check your downloads folder.', 'Alright, let me go through your emails.', 'Excellent! I\'ll message the whole team and update you.',
  'Sounds good, I\'ll book it and confirm.', 'Sure, let me find the cheapest flight.', 'Okay Sir, let me look into your storage.',
  'Give me a minute, I\'ll sort your files.', 'Alright, I\'ll get the tickets and let you know.', 'Let me just check your messages quickly.',
  'Hmm, let me try opening it again.',
]) add('promised', s);
for (const s of [
  'Understood. Chai is best with a little ginger.', 'Okay, so the capital of Japan is Tokyo.', 'Sure! Photosynthesis is how plants make food from sunlight.',
  'Great question. Mars has two moons.', 'Alright, a kilogram is 1000 grams.', 'Certainly. A laptop can heat up during long video calls.',
  'Checking tyre pressure monthly keeps the car safe.', 'Searching online is the quickest way to compare prices.',
  'Opening windows in the morning lets fresh air in.', 'Sending emails early often gets faster replies.',
  'Playing music while studying helps some people focus.', 'Booking trains on IRCTC opens 60 days ahead.',
  'Noting down tasks helps you remember them.', 'Saving a little every month adds up.', 'Downloading big files is faster on Wi-Fi.',
  'Okay, let\'s think about this. 12 times 12 is 144.', 'The question asks for the time in London, which is behind India.',
  'Hmm, the answer depends on your plan.', 'A phone can slow down when its storage is nearly full.', 'It seems the signal is weak in that room.',
  'Excellent choice! That laptop has great battery life.', 'Absolutely, that\'s common. Rain forms when water vapour cools.',
  'No worries, that happens to everyone.', 'The seminar was held online last Monday.', 'Your parcel from yesterday was delivered at 3 PM.',
  'Parth replied to your message an hour ago.', 'Okay Boss, you can turn on Night Shift from Control Center.',
  'Sure, to rename a file just click its name once and type.', 'Alright, I can\'t reach your email from here.',
  'I haven\'t sent it yet, Sir.', 'Do you want me to go ahead and book it?', 'Want me to check your calendar?',
]) add('none', s);

// ---- ROUND 4 WAS TRIED AND NOT KEPT (2026-09-24): chatty "let me / I'll", bare status claims and past-tense
// events (~50 rows). On fresh held-out #5 it scored exactly what round 3 did (18/25 caught, 2/25 flagged),
// moved errors between the older sets, and made CV prefer two embedders (slower). Rows removed so this file
// rebuilds round 3's data, which is what replyclaim.weights.json was trained on.

// ---- ROUND 3: the guard's ORIGINAL design exemplars (replyclaim.js REPLY_CLAIM_EXEMPLARS, written before
// 2026-09-24). Rounds 1–2 left them out, and the reader then missed the case this guard exists for — the
// fabricated order confirmation from his terminal — and flagged "Your name is Atharv, Sir." Pre-existing data,
// not sentences written after reading any held-out miss.
for (const [label, list] of Object.entries(require('../jarvis-os/replyclaim.js').REPLY_CLAIM_EXEMPLARS)) for (const s of list) add(label, s);

// ---- ROUND 5 (2026-10-10, only with --round5 → data/replyclaim_train_r5.jsonl): the shapes round 3 failed on held-out #6 —
// Hinglish claims (done / acting / promised), bare status claims, and short small-talk / thanks-replies / facts / jokes as none.
// Written after #6 was read and after FRESH #7 was written; no #6 or #7 sentence, and near copies of #7 are refused below.
const ROUND5 = process.argv.includes('--round5');
if (ROUND5) {
  for (const s of ['Text chala gaya Parth ko.', 'Gaana laga diya, Sir.', 'Reminder set kar diya.', 'Calendar mein daal diya.', 'File delete kar di.',
    'App band kar di.', 'Chrome ab khula hai, Sir.', 'Mama ko bata diya.', 'Order place ho gaya.', 'Note likh diya Notes mein.', 'Screenshot le liya.',
    'Wifi band kar diya.', 'Folder bana diya Desktop pe.', 'Alarm set ho gaya.', 'Parth ko call laga diya.',
    'Wifi is off.', 'Dark mode is on now.', 'Your Mac is muted.', 'The window is minimised.', 'Brave is closed.', 'Notifications are paused.',
    'Your downloads are cleared.', 'The song is paused.', 'Your hotspot is on.', 'Night Shift is on now.', 'The PDF is downloaded.',
    'Your status is updated.', 'Lights are off.', 'The tab is pinned.', 'Recording stopped.']) add('done', s);
  for (const s of ['Netflix khol raha hoon.', 'Message bhej raha hoon.', 'Search kar raha hoon, ek second.', 'Didi ko phone laga raha hoon.',
    'Trailer play kar raha hoon.', 'Download ho raha hai, ruko.', 'Gaana bajaa raha hoon.', 'Abhi dekh raha hoon tumhari files.']) add('acting', s);
  for (const s of ['Ho jayega, ek minute.', 'Main bhej deta hoon.', 'Ruko, main dhoondh ke batata hoon.', 'Theek hai, laga deta hoon.',
    'Haan, abhi khol deta hoon.', 'Kal subah yaad dila dunga.', 'Khana order kar dunga.', 'Ek minute, check karke batata hoon.']) add('promised', s);
  for (const s of ['Ha, love it.', 'Bet, Sir.', 'Enjoy, Boss!', 'Good one.', 'Fair enough, Boss.', 'No problem at all.', 'Glad that helped.', 'Cheers.',
    'Night, Sir.', 'Have fun!', 'All good here.', 'Nothing much, you?', 'Same old.', 'Proud of you, Boss.', 'That sucks, sorry.',
    'Hope it gets better.', 'Enjoy the meal!', 'Congrats, Sir!', 'Rest up.', 'Ha, okay.', 'Cool cool.', 'Nice, that works.', 'Wow.',
    'Haan ji, samajh gaya.', 'Koi na.', 'Sahi baat.', 'Haan yaar.', 'Chill karo.', 'Kya baat hai!', 'Arre wah.', 'Mazaa aaya.',
    'Mumbai gets heavy rain in July.', 'The match starts at 7:30.', 'Cloudy today, around 18 degrees.', 'Battery sits at 40 percent.', 'Saturn has 146 moons.',
    'Why did the scarecrow win an award? He was outstanding in his field.', 'Light travels at about 3 lakh km per second.',
    'That phone has a 5000 mAh battery.', 'Diwali falls in November this year.', 'Chess has 64 squares.', 'The meeting was yesterday at 4.',
    'Rahul posted a new photo.']) add('none', s);
}

// Never let a held-out sentence into training.
const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const held = new Set();
for (const f of ['replyclaim_heldout.json', 'replyclaim_live.json', 'replyclaim_heldout2.json', 'replyclaim_heldout3.json', 'replyclaim_heldout4.json',
  'replyclaim_heldout6.json', 'replyclaim_heldout7.json']) {
  if (!fs.existsSync(path.join(__dirname, 'data', f))) continue;
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
  for (const s of [].concat(j.claim, j.none)) held.add(norm(Array.isArray(s) ? s[1] : s));   // #6 items are [his message, reply]
}
// Round 5: no near copy of FRESH #7 either (word overlap ≥ 0.6 is refused, and the run stops so the row gets rewritten).
if (ROUND5) {
  const toks = t => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean));
  const h7 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'replyclaim_heldout7.json'), 'utf8'));
  for (const r of out) for (const s of [].concat(h7.claim, h7.none)) {
    const a = toks(r.text), b = toks(s); let i = 0; for (const w of a) if (b.has(w)) i++;
    if (i / (a.size + b.size - i) >= 0.6) { console.log('NEAR COPY of held-out #7: ' + JSON.stringify(r.text) + ' ~ ' + JSON.stringify(s)); process.exit(1); }
  }
}
const seen = new Set();
const rows = out.filter(r => { const k = norm(r.text); if (held.has(k) || seen.has(k)) return false; seen.add(k); return true; });
fs.writeFileSync(path.join(__dirname, 'data', ROUND5 ? 'replyclaim_train_r5.jsonl' : 'replyclaim_train.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const count = {}; for (const r of rows) count[r.label] = (count[r.label] || 0) + 1;
console.log('wrote ' + rows.length + ' rows ' + JSON.stringify(count) + ' (dropped ' + (out.length - rows.length) + ' duplicates / held-out matches)');
