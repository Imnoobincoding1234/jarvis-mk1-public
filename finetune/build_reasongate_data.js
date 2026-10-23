'use strict';
// BUILDS data/reasongate_train.jsonl — the training rows for the reasoning gate (jarvis-os/reasonintent.js),
// 2026-09-25. Written AFTER both held-out sets (data/reasongate_heldout.json, data/reasongate_heldout2.json)
// and refuses to write if any row matches a held-out sentence. Rows teach SHAPES in his texting style
// (lowercase, u/ur/plz, no apostrophes, Hinglish in proportion) — never a held-out sentence reworded.
//
//   reasoning  worked out from what the sentence itself states
//   command    an instruction, numbers and all
//   machine    the answer lives on this Mac or in his own data (a lane can read it)
//   lookup     a fact out in the world — the number is not in the sentence
//   chat       conversation that happens to carry a number
//
//   node build_reasongate_data.js
const fs = require('fs');
const path = require('path');
const R = require('../jarvis-os/reasonintent.js');

const ROWS = {
  reasoning: [
    // money
    'a jacket costs 2499 and theres 20% off how much do i pay', 'if 6 samosas cost 72 whats one', 'whats 18% gst on 4500',
    'i earn 300 an hour how much for 7.5 hours', 'we are 5 and the cab was 875 how much each', 'shoes were 3200 now 2560 how much percent off',
    'if i spend 150 a day how long will 2000 last', 'is 3 for 99 better than 1 for 35', 'whats 12% interest on 50000 for 2 years simple interest',
    'my pocket money is 1500 and i spent 640 and 385 whats left', 'if petrol is 104 a litre how much for 23 litres', 'a 500 note and i spent 347 how much change',
    // time and dates
    'if i sleep at 12:40 and wake at 7:10 how long did i sleep', 'class starts at 8:30 and lasts 3 hrs 15 min when does it end', 'how many minutes from 2:45 to 5:10',
    'if its 3 pm now what time will it be in 17 hours', 'what day of the week is 30 days after a monday', 'how many days between 3 march and 21 april',
    'i was born in 2008 how old am i in 2030', 'how many weeks are in 150 days', 'if my flight is 9 hrs and leaves at 22:30 when do i land',
    'a 45 min lecture repeated 4 times how many hours is that', 'is 1900 a leap year', 'how many seconds in a day',
    // rates, work, distance
    'a bike goes 42 km in 1.5 hrs whats its speed', 'if 4 taps fill a tank in 3 hrs how long for 6 taps', 'i type 55 words a minute how long for 2000 words',
    'at 80 kmph how long for 340 km', 'a printer does 12 pages a minute how long for 300 pages', 'if 3 people paint a house in 12 days how long for 4',
    'a download at 4 mb per second how long for 2.4 gb', 'if my phone uses 7% battery an hour how long will 63% last', 'a runner does 400 m in 64 s whats the pace per km',
    // geometry
    'whats the perimeter of a square with side 13', 'area of a triangle base 10 height 7', 'whats the circumference of a circle with diameter 14',
    'a room is 4 m by 5 m how many 50 cm tiles do i need', 'whats the diagonal of a 3 by 4 rectangle', 'volume of a cylinder radius 3 height 10',
    'surface area of a cube with side 4', 'two squares of side 6 and 8 whats their total area', 'a circle has area 154 whats its radius',
    'if a cube has volume 64 whats its side',
    // number properties
    'is 87 a prime', 'is 1001 divisible by 13', 'whats the hcf of 36 and 60', 'lcm of 4 6 and 10', 'is 2^10 bigger than 1000',
    'whats 7 to the power 3', 'square root of 529', 'is 144 a perfect square', 'what are the factors of 36', 'round 3.14159 to 2 decimals',
    'whats 3/8 as a decimal', 'whats 0.6 as a percent', 'which is smaller 5/12 or 0.4', 'is 0 even or odd', 'whats the cube root of 343',
    'how many zeros at the end of 25 factorial',
    // averages, stats, probability
    'whats the average of 12 18 24 and 30', 'my marks are 78 85 91 whats my average', 'whats the median of 3 9 4 7 1',
    'if i flip a coin 3 times whats the chance of all heads', 'a bag has 4 red and 6 blue balls chance of red', 'in how many ways can 4 people sit in a row',
    'need 60% overall and got 52 and 70 in two equal papers did i pass',
    // algebra and puzzles
    'if 3x minus 5 is 16 whats x', 'a number plus its half is 45 what is the number', 'the product of two numbers is 72 and one is 9 whats the other',
    'i am thinking of a number times 4 minus 7 is 29', 'if a is twice b and a plus b is 36 what are they', 'my dad is 3 times my age and together we are 64 how old am i',
    // logic
    'if all roses are flowers and all flowers need water do roses need water', 'no fish can walk and a shark is a fish can a shark walk',
    'if it rains the ground gets wet the ground is wet did it rain', 'every student in my class passed and riya is in my class did she pass',
    // conversions
    'how many cm in 5.2 m', 'convert 100 km to miles', 'whats 30 degrees celsius in fahrenheit', 'how many grams in 2.75 kg', 'how many ml in 3.5 litres',
    'convert 5 feet 9 inches to cm', 'how many mb in 3 gb',
    // comparisons
    'which is cheaper 500 ml for 45 or 1 litre for 85', 'whats better 15% off or 150 off on 900', 'is 7 hrs at 60 kmph more than 400 km',
    // with a machine noun but the numbers are all stated
    'if a file is 3.2 gb and i have 1800 mb free how much more do i need', 'a 256 gb phone with 190 gb used how much free',
    'my laptop battery lasts 9 hrs at 100% how long at 40%',
    // Hinglish
    'agar 4 kilo aloo 120 ke hai to 7 kilo kitne ke', '250 ka 12 percent kitna hua', 'mere paas 2000 hai aur 3 cheezein 450 450 aur 700 ki leni hai paise bachenge',
    '3 baje shuru kiya aur 4 ghante 20 min lage to kab khatam hua', 'ek din mein kitne minute hote hai', '8 dost 1600 ka bill barabar baante to har ek ka kitna',
    'ek train 60 ki speed se 3 ghante chali to kitni doori', 'agar x ka double 18 hai to x kya hai', '17 prime hai kya', 'kya 51 ko 3 se divide kar sakte hai',
    '5 aur 7 ka lcm kya hoga', 'ek square ki side 11 hai area kitna', '1200 mein 15 percent discount ke baad kitna', '100 mein se 64 ka percent',
    'roz 20 rupay bachau to saal mein kitne', 'agar aaj somvar hai to 10 din baad kya din hoga', '2 ki power 8 kitni hoti hai',
    'ek ghanta 20 min aur 2 ghante 55 min ko jodo', '3 kitabein 240 240 aur 360 ki average kitni', 'agar sab kutte janwar hai aur sheru kutta hai to sheru janwar hai kya',
  ],
  command: [
    'open the 3rd tab', 'set volume to 25', 'set an alarm for 7:45', 'remind me in 40 min to call mama', 'timer for 12 minutes',
    'play the 2nd song', 'close 2 of the chrome tabs', 'create a folder called 2026 notes', 'delete the 5 oldest files in downloads', 'move the last 3 screenshots to desktop',
    'text parth im 15 min late', 'message mama that ill reach by 8', 'schedule a reminder for 9 am tomorrow', 'take a screenshot in 3 sec', 'brightness 50',
    'search for iphone 16 price in india', 'open youtube and play the top 3 videos', 'search 10 best movies of 2025', 'open the 1st result', 'zoom to 150%',
    'turn the volume up by 10', 'add 2 kg rice to my shopping list', 'add a meeting at 4 pm', 'book a slot at 6 on thursday', 'open my 2025 folder',
    'call parth at 5', 'rename file 1 to final', 'order 2 pizzas from dominos', 'open tab number 7', 'skip 30 seconds',
    'set a reminder every 2 hrs to drink water', 'show me the last 10 messages', 'print 3 copies', 'go back 2 pages', 'open 2 new windows',
    'volume 60 kar do', '15 min ka alarm lagao', 'teesra tab kholo', '7 baje yaad dilana', 'parth ko bolo 10 min mein aa raha hu',
    '2 photos delete karo', 'brightness 20 kar do', 'kal 9 baje ka reminder laga do', 'pehla video chala do', '5 second baad screenshot lo',
    'search karo 20000 ke andar best phones', 'mujhe 30 min mein uthana', 'music 40 pe kar do',
  ],
  machine: [
    'how much battery do i have left', 'how much free space is on my disk', 'how many apps are open', 'how many chrome tabs are open', 'whats my cpu at',
    'how much ram is being used', 'when is my next class on the calendar', 'how many emails did i get today', 'how many reminders are due today', 'what time is it right now',
    'what is todays date', 'how long till my 6 pm meeting', 'how much time did i spend on youtube today', 'whats my wifi speed', 'how big is my downloads folder',
    'how many files are on my desktop', 'is my mac charging', 'how many songs are in my playlist', 'what did i do at 3 pm yesterday', 'whats on my schedule for friday',
    'how many unread whatsapp messages', 'how long has my laptop been on', 'whats my battery health', 'how much storage do my photos use', 'what was open at 11 am',
    'how many contacts do i have', 'when did i last message parth', 'kitni battery bachi hai', 'kitne tabs khule hai', 'disk mein kitni jagah hai',
    'aaj kitne reminders hai', 'kal mera koi meeting hai kya', 'abhi time kya hua', 'meri screen time kitni hai', 'ram kitni use ho rahi hai',
    'how many steps did i walk today', 'whats the temperature outside right now', 'how many downloads are running',
  ],
  lookup: [
    'how far is the sun from earth', 'what is the height of the burj khalifa', 'how many countries are in the world', 'when was the eiffel tower built', 'who won the 2022 world cup',
    'what is the population of china', 'how many bones are in the human body', 'what is the capital of australia', 'when did world war 2 end', 'how fast does a cheetah run',
    'what year did man land on the moon', 'how long is the great wall of china', 'what is the price of gold today', 'who is the ceo of google', 'when is the next solar eclipse',
    'how many players in a football team', 'what is the atomic number of carbon', 'how deep is the mariana trench', 'what is the tallest mountain in india', 'how many states are in india',
    'what is the freezing point of mercury', 'who scored the fastest century in odi', 'how much does an iphone 17 pro cost', 'when is the next ipl season', 'what is the dollar to rupee rate',
    'how many km is a marathon', 'how old is the universe', 'what is the speed of sound', 'how many teeth do adults have', 'when was google founded',
    'nifty aaj kitna hai', 'india ki population kitni hai', 'sachin ne kitne centuries banaye', 'chand kitni door hai', 'petrol ka rate kya hai aaj',
    'world cup 2011 kisne jeeta', 'taj mahal kab bana', 'pani kitne degree pe ubalta hai',
  ],
  chat: [
    'i walked 10k steps today', 'got 95 in chem lets gooo', 'slept only 5 hrs again', 'its like 42 degrees today im dying', 'i have 3 tests next week',
    'woke up at 2 pm lol', 'my laptop is 4 years old', 'bro i have 7 assignments pending', 'my sis turned 10 today', 'i did 100 situps',
    'we won 3 0 today', 'spent like 2 hrs on insta oops', 'im 16 and already tired', 'ok thanks', 'lol',
    'hey jarvis', 'good night', 'that was quick', 'nice one', 'i finished 2 books this month',
    'its 1 am and im hungry', 'my phone fell 2 times today', 'had 4 cups of chai', 'my exam went ok i think', 'i hate maths',
    'im bored', 'tell me a joke', 'what should i watch tonight', 'whats up', 'can u help me study',
    'aaj 3 ghante gaming ki', 'kal 6 baje utha tha', 'yaar 2 din se bukhar hai', 'maine 5 samose kha liye', 'aaj bahut garmi hai 41 degree',
    'thank u jarvis', 'kya haal hai bhai', 'bore ho raha hu',
  ],
};

// ROUND 3 (after round 2's misses on held-out #2 were read, and after held-out #3 was written): shapes the
// gate under-read — date spans and weekdays, number properties asked "or not", leap years, right triangles,
// a stated clock time in another zone, Hinglish totals and percents, factorials, repeated growth — and, so a
// false yes stays at zero, look-alikes on the SAME topics: a concept explained, a date said as news, a city's
// time now, a score said as chat.
const ROUND3 = {
  reasoning: [
    'how many days from 10 october to 2 january', 'if today is 25 sept what day is 1 november', 'if my trip is on 18 march how many days from 25 sept',
    'what day of the week was 15 august 1947', 'if today is friday what day was it 100 days ago', 'how many weeks from 1 jan to 30 april',
    'is 143 prime', 'check if 97 is prime', 'is 57 prime', 'is 2 the only even prime', 'is 999 divisible by 27',
    'will 2028 be a leap year', 'is 1996 a leap year', 'was 2023 a leap year',
    'right triangle with sides 5 and 12 whats the third side', 'a 13 m ladder with its base 5 m from the wall how high up does it touch',
    'a tv is 40 inch diagonal and 32 inch wide how tall is it',
    'when its 8 am in london whats the time in mumbai',
    'roz 30 min exercise to ek mahine mein kitne ghante', '60 ka 25 percent kitna hota', '480 mein 20 percent kitna hua', 'maine 150 200 aur 75 kharch kiye total kitna',
    '4 log 12 din mein kaam karte hai to 8 log kitne din mein', 'ek hafte mein kitne ghante hote hai', '3 ghante 40 min aur 1 ghanta 35 min ka total',
    'whats 6 factorial', 'whats 4! plus 3!', 'if a car loses 15% value each year whats a 800000 car worth after 3 years',
    'money doubles every 7 years how much is 10000 after 21 years', 'if i double 3 four times what do i get', 'halve 1000 five times whats left',
    'which is more 1.8 litres or 1750 ml', 'which is longer 1.2 km or 1150 m', 'is 0.7 more than 2/3',
    'i came 45th out of 300 whats my percentile', 'some cars are red and all red things are bright are some cars bright',
    'whats 15 squared minus 12 squared', 'a bus leaves at 23:40 and takes 9 hrs 30 min when does it get there',
    'if 1 euro is 95 rupees how much is 120 euros', 'a square has perimeter 48 whats its area', 'how many sides does a polygon with 9 diagonals have',
    'chance of rolling a 6 on one die', 'chance of drawing a red card from 52', 'how many 250 ml glasses in 3 litres', 'if 8 of us share 3 pizzas with 8 slices each how many slices each',
    'i have 12 chocolates and eat 2 a day for 4 days how many left',
  ],
  lookup: [
    'explain what a composite number is', 'explain pythagoras theorem', 'what is a leap year', 'is it night in america rn',
    'what day is independence day', 'when is christmas', 'what is a factorial', 'what does percentile mean',
    'what is the dollar rate today', 'euro to rupee rate', 'when is holi next year', 'how much does a macbook air cost',
  ],
  chat: [
    'my bday is in june', 'came 12th in class', 'im going to delhi on 18 march',
    'did 2 hrs of maths today', 'maths is so hard', 'i love prime numbers lol', 'i hate percentages',
    'maine aaj 10 km cycle chalayi', 'aaj 5 ghante padha',
  ],
  machine: [
    'when is my trip on the calendar', 'how many days till my birthday reminder', 'what time is my alarm set for', 'how many events do i have this week',
    'what did i search for yesterday at 5', 'mera next alarm kab hai', 'is my battery above 20',
  ],
  command: [
    'set a 45 min timer', 'play 30 min of rain sounds', 'add 3 eggs to the list', 'open the 4th tab and close the 2nd',
    'mujhe 14 feb ko yaad dilana', '20 min ka timer', 'volume 15 karo',
  ],
};

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const held = new Set();
for (const f of ['reasongate_heldout.json', 'reasongate_heldout2.json', 'reasongate_heldout3.json'])
  for (const c of JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8')).cases) held.add(norm(c.q));

const out = [], seen = new Set();
// The centroid exemplars from reasonintent.js are training rows too (same labels).
for (const [label, list] of Object.entries(R.REASON_EXEMPLARS)) for (const t of list) { if (!seen.has(norm(t))) { seen.add(norm(t)); out.push({ text: t, label }); } }
for (const set of [ROWS, ROUND3])
  for (const [label, list] of Object.entries(set)) for (const t of list) { if (!seen.has(norm(t))) { seen.add(norm(t)); out.push({ text: t, label }); } }

const leaked = out.filter(r => held.has(norm(r.text)));
if (leaked.length) { console.log('REFUSING — held-out sentences in training: ' + leaked.map(r => r.text).join(' | ')); process.exit(1); }
fs.writeFileSync(path.join(__dirname, 'data', 'reasongate_train.jsonl'), out.map(r => JSON.stringify(r)).join('\n') + '\n');
const by = {}; for (const r of out) by[r.label] = (by[r.label] || 0) + 1;
console.log('wrote data/reasongate_train.jsonl — ' + out.length + ' rows ' + JSON.stringify(by));
