'use strict';
// CASUAL STRESS SET v3 — written 2026-10-10 ~21:10 (Mihir away on a trek), AFTER v2's one judged run was read (213/325) and
// after reader round 6's rows were generated, BEFORE round 6 trained and before any further fix is measured on it. v2's misses
// were read, so v2 is now dev too; v3 is the set the casual push is judged on when he is back — run ONCE per candidate.
// Same format and category mix as v1/v2 (chat 77, message 40, open 25, play_music 23, answer 22, search 16, video 13, call 12,
// close 10, compound 9, …), 42 Hinglish, 28 no_act, written from data/style_profile.md, never copied from his messages.
// Contacts are the sandbox fixture's (sweeps/sweep_casual.js): mama, bhai, kunal, ira, rehaan, yuvan, nanu.
// The guard below refuses an exact copy of ANY text line under finetune/data (training rows included — round 6's too) and a
// near copy (word Jaccard >= 0.75) of the stress sets, the synthetic rows, his messages and the held-outs. Never trained on.
//   node build_casual_stress_v3.js   → data/casual_stress_heldout_v3.jsonl
const fs = require('fs');
const path = require('path');
const H = 'hinglish';
const M = (to, ...b) => ({ act: 'message', to, body_has: b });
const C = to => ({ act: 'call', to });
const O = target => ({ act: 'open', target });
const X = target => ({ act: 'close', target });
const P = (...q) => ({ act: 'play_music', query_has: q });
const V = (...q) => ({ act: 'play_video', query_has: q });
const A = (...a) => ({ act: 'answer', answer_has: a });
const S = (...q) => ({ act: 'search_web', query_has: q });
const MC = control => ({ act: 'media_control', control });
const R = (...w) => ({ act: 'reminder', what_has: w });
const N = (...w) => ({ act: 'note', about_has: w });
const CH = gist => ({ act: 'chat', gist });
const K = (...steps) => ({ act: 'compound', steps });
const T = act => ({ act });

// [prefix, lang, text, expect, tags?]
const ROWS = [
  // ---- message (40, 5 Hinglish) ----
  ['m', 'en', 'text kunal wya bro', M('kunal', 'wya')],
  ['m', 'en', 'dm mama saying ill eat outside today', M('mama', 'outside')],
  ['m', 'en', 'whatsapp bhai saying pick me up at 7', M('bhai', 'pick')],
  ['m', 'en', 'msg ira asking if he has the charger', M('ira', 'charger')],
  ['m', 'en', 'ping rehaan saying cya at practice', M('rehaan', 'practice')],
  ['m', 'en', 'tell yuvan the test got postponed', M('yuvan', 'postponed')],
  ['m', 'en', 'send nanu a msg saying cant wait to see u', M('nanu', 'wait')],
  ['m', 'en', 'Text bhai bro where did u keep the remote', M('bhai', 'remote')],
  ['m', 'en', 'dm kunal asking what time the movie starts', M('kunal', 'movie')],
  ['m', 'en', 'yo message rehaan saying lets gooo we won', M('rehaan', 'won')],
  ['m', 'en', 'whatsapp ira asking if hes coming to the party', M('ira', 'party')],
  ['m', 'en', 'text mama saying ok will do', M('mama', 'will')],
  ['m', 'en', 'message kunal saying congrats on the result', M('kunal', 'congrats')],
  ['m', 'en', 'send yuvan omw 5 min', M('yuvan', 'omw')],
  ['m', 'en', 'ping nanu saying ill call u later', M('nanu', 'later')],
  ['m', 'en', 'dm bhai asking if he ate dinner', M('bhai', 'dinner')],
  ['m', 'en', 'tell rehaan to bring the football tmrw', M('rehaan', 'football')],
  ['m', 'en', 'text ira saying lmaooo dead', M('ira', 'dead')],
  ['m', 'en', 'msg kunal asking for the physics answers', M('kunal', 'physics')],
  ['m', 'en', 'whatsapp yuvan saying gg well played', M('yuvan', 'played')],
  ['m', 'en', 'eh just text mama saying im fine dont worry', M('mama', 'fine'), ['filler']],
  ['m', 'en', 'ok so dm rehaan saying ttyl', M('rehaan', 'ttyl'), ['filler']],
  ['m', 'en', 'Message nanu asking if she needs anything from the market', M('nanu', 'market')],
  ['m', 'en', 'send kunal a text saying check the group chat', M('kunal', 'group')],
  ['m', 'en', 'text bhai good night sleep well', M('bhai', 'night')],
  ['m', 'en', 'dm yuvan bro reply to me', M('yuvan', 'reply')],
  ['m', 'en', 'whatsapp rehaan saying thanks for the help today', M('rehaan', 'thanks')],
  ['m', 'en', 'msg mama im with ira at the mall', M('mama', 'mall')],
  ['m', 'en', 'text kunal asking if he got my email', M('kunal', 'email')],
  ['m', 'en', 'ping ira saying happy diwali gng', M('ira', 'diwali')],
  ['m', 'en', 'tell nanu ill visit her on sunday', M('nanu', 'sunday')],
  ['m', 'en', 'dm bhai saying dont touch my laptop', M('bhai', 'laptop')],
  ['m', 'en', 'message yuvan asking where the party is tonight', M('yuvan', 'party')],
  ['m', 'en', 'shoot kunal a msg saying im outside ur gate', M('kunal', 'gate')],
  ['m', 'en', 'whatsapp mama asking if i should get bread', M('mama', 'bread')],
  ['m', H, 'mama ko msg kar ki aaj dinner bahar karunga', M('mama', 'dinner')],
  ['m', H, 'kunal ko bol kal school nahi aa raha', M('kunal', 'school')],
  ['m', H, 'bhai ko whatsapp kar ki charger le aaye', M('bhai', 'charger')],
  ['m', H, 'nanu ko message bhejo maine khana kha liya', M('nanu', 'khana')],
  ['m', H, 'rehaan ko text kar match kab hai', M('rehaan', 'match')],
  // ---- call (12, 2 Hinglish) ----
  ['c', 'en', 'call mama rn', C('mama')],
  ['c', 'en', 'facetime kunal quick', C('kunal')],
  ['c', 'en', 'video call ira', C('ira')],
  ['c', 'en', 'Call rehaan', C('rehaan')],
  ['c', 'en', 'ring nanu', C('nanu')],
  ['c', 'en', 'hit bhai up on call', C('bhai')],
  ['c', 'en', 'call yuvan on whatsapp', C('yuvan')],
  ['c', 'en', 'can u call kunal for me', C('kunal')],
  ['c', 'en', 'phone mama quick', C('mama')],
  ['c', 'en', 'yo call rehaan', C('rehaan')],
  ['c', H, 'bhai ko ek call maar de', C('bhai')],
  ['c', H, 'nanu ko phone kar', C('nanu')],
  // ---- open (25, 4 Hinglish) ----
  ['o', 'en', 'open spotify rq', O('spotify')],
  ['o', 'en', 'launch whatsapp desktop', O('whatsapp')],
  ['o', 'en', 'pull up calculator i need to do maths', O('calculator')],
  ['o', 'en', 'yo open safari', O('safari')],
  ['o', 'en', 'open notes plz', O('notes')],
  ['o', 'en', 'get youtube up for me', O('youtube')],
  ['o', 'en', 'open instagram real quick', O('instagram')],
  ['o', 'en', 'take me to reddit', O('reddit')],
  ['o', 'en', 'take me to system settings', O('settings')],
  ['o', 'en', 'open discord the server is popping', O('discord')],
  ['o', 'en', 'open the photos app', O('photos')],
  ['o', 'en', 'go to the app store rq', O('app store')],
  ['o', 'en', 'open my gmail inbox', O('gmail')],
  ['o', 'en', 'open netflix pls', O('netflix')],
  ['o', 'en', 'bring up finder', O('finder')],
  ['o', 'en', 'open chatgpt i got a doubt', O('chatgpt')],
  ['o', 'en', 'open maps for me', O('maps')],
  ['o', 'en', 'open my mail', O('mail')],
  ['o', 'en', 'eh open notes i guess', O('notes'), ['filler']],
  ['o', 'en', 'open amazon', O('amazon')],
  ['o', 'en', 'open github i wanna push my code', O('github')],
  ['o', H, 'spotify khol', O('spotify')],
  ['o', H, 'whatsapp open kar do', O('whatsapp')],
  ['o', H, 'jaldi se safari khol', O('safari')],
  ['o', H, 'mere notes khol do zara', O('notes')],
  // ---- play_music (23, 4 Hinglish) ----
  ['p', 'en', 'play starboy by the weeknd', P('starboy')],
  ['p', 'en', 'play lofi hip hop radio', P('lofi')],
  ['p', 'en', 'play smth to sleep to', P()],
  ['p', 'en', 'throw on drakes new album', P('drake')],
  ['p', 'en', 'play perfect by ed sheeran', P('perfect')],
  ['p', 'en', 'need some workout music', P('workout')],
  ['p', 'en', 'ap dhillon on spotify', P('dhillon')],
  ['p', 'en', 'play something happy', P('happy')],
  ['p', 'en', 'Play tum hi ho', P('tum')],
  ['p', 'en', 'put on coldplay viva la vida', P('viva')],
  ['p', 'en', 'play some old bollywood songs', P('bollywood')],
  ['p', 'en', 'play taylor swift love story', P('love')],
  ['p', 'en', 'play the new karan aujla song', P('aujla')],
  ['p', 'en', 'play rain sounds', P('rain')],
  ['p', 'en', 'play smooth jazz for studying', P('jazz')],
  ['p', 'en', 'play eminem lose yourself', P('lose')],
  ['p', 'en', 'shuffle my liked songs on spotify', P('liked')],
  ['p', 'en', 'play marathi bangers', P('marathi')],
  ['p', 'en', 'blast some phonk', P('phonk')],
  ['p', H, 'koi accha gaana chala', P()],
  ['p', H, 'arijit singh ke purane gaane bajao', P('arijit')],
  ['p', H, 'diljit ka lover laga', P('lover')],
  ['p', H, 'kuch romantic gaane sunao', P('romantic')],
  // ---- answer (22, 2 Hinglish) ----
  ['q', 'en', 'how many seconds in a minute', A('60', 'sixty')],
  ['q', 'en', 'whats 13 times 7', A('91')],
  ['q', 'en', 'how many continents does earth have', A('7', 'seven')],
  ['q', 'en', 'the mona lisa was painted by who', A('vinci', 'leonardo')],
  ['q', 'en', 'capital city of japan?', A('tokyo')],
  ['q', 'en', 'which planet is the biggest one', A('jupiter')],
  ['q', 'en', 'how many players does a football side have on the pitch', A('11', 'eleven')],
  ['q', 'en', 'at what temp does water boil', A('100')],
  ['q', 'en', 'harry potter author name?', A('rowling')],
  ['q', 'en', 'number of bones in a grown human?', A('206')],
  ['q', 'en', 'whats 25 percent of 200', A('50', 'fifty')],
  ['q', 'en', 'which is the longest river in the world', A('nile', 'amazon')],
  ['q', 'en', 'what gas do plants take in', A('carbon', 'co2', 'co₂')],
  ['q', 'en', 'how many hours in 2 days', A('48')],
  ['q', 'en', 'which scientist figured out gravity', A('newton')],
  ['q', 'en', 'whats the square root of 81', A('9', 'nine')],
  ['q', 'en', 'brazil people speak which language', A('portuguese')],
  ['q', 'en', 'hexagon has how many sides', A('6', 'six')],
  ['q', 'en', 'h2o is the formula for what', A('water')],
  ['q', 'en', 'whats the fastest land animal', A('cheetah')],
  ['q', H, 'india ki capital kaunsi hai', A('delhi')],
  ['q', H, 'ek hafte mein kitne din hote hain', A('7', 'saat', 'seven')],
  // ---- search_web (16, 2 Hinglish) ----
  ['s', 'en', 'search ps5 slim price today', S('ps5')],
  ['s', 'en', 'google how to clean white sneakers', S('sneakers')],
  ['s', 'en', 'look up the ipl schedule', S('ipl')],
  ['s', 'en', 'find reviews of the pixel 10', S('pixel')],
  ['s', 'en', 'search good earbuds under 2000', S('earbuds')],
  ['s', 'en', 'look up how to make cold coffee', S('coffee')],
  ['s', 'en', 'search for cbse date sheet', S('cbse')],
  ['s', 'en', 'google the lyrics of brown munde', S('brown')],
  ['s', 'en', 'search news about chandrayaan', S('chandrayaan')],
  ['s', 'en', 'look up cheap trains to delhi', S('delhi')],
  ['s', 'en', 'search what is quantum computing', S('quantum')],
  ['s', 'en', 'find the score of the india match', S('india')],
  ['s', 'en', 'search for a gym near me', S('gym')],
  ['s', 'en', 'search for the new marvel movie', S('marvel')],
  ['s', H, 'google pe dekh new iphone kab aayega', S('iphone')],
  ['s', H, 'search karke bata best laptop under 50k', S('laptop')],
  // ---- play_video (13, 2 Hinglish) ----
  ['v', 'en', 'open youtube and play some dog videos', V('dog')],
  ['v', 'en', 'put on a gta video on youtube', V('gta')],
  ['v', 'en', 'put on any random youtube vid', V()],
  ['v', 'en', 'play the avengers trailer', V('avengers')],
  ['v', 'en', 'play the newest mrbeast challenge video', V('mrbeast')],
  ['v', 'en', 'watch carryminati on youtube', V('carryminati')],
  ['v', 'en', 'play a cooking video', V('cooking')],
  ['v', 'en', 'show me football highlights on yt', V('football')],
  ['v', 'en', 'play the iphone 17 review video', V('iphone')],
  ['v', 'en', 'play a 10 min workout video', V('workout')],
  ['v', 'en', 'play dhruv rathee new vid', V('dhruv')],
  ['v', H, 'youtube pe science video chala', V('science')],
  ['v', H, 'youtube pe koi mazedaar video dikhao', V()],
  // ---- close (10, 2 Hinglish) ----
  ['x', 'en', 'close spotify rq', X('spotify')],
  ['x', 'en', 'quit safari its eating ram', X('safari')],
  ['x', 'en', 'shut whatsapp for now', X('whatsapp')],
  ['x', 'en', 'kill discord i need to focus', X('discord')],
  ['x', 'en', 'close calculator im done', X('calculator')],
  ['x', 'en', 'get rid of netflix', X('netflix')],
  ['x', 'en', 'close the notes app', X('notes')],
  ['x', 'en', 'quit chrome its lagging', X('chrome')],
  ['x', H, 'ye spotify band kar yaar', X('spotify')],
  ['x', H, 'whatsapp hata do screen se, band karo', X('whatsapp')],
  // ---- compound (9, 1 Hinglish) ----
  ['k', 'en', 'open spotify and also notes', K(O('spotify'), O('notes')), ['compound']],
  ['k', 'en', 'close safari and open youtube', K(X('safari'), O('youtube')), ['compound']],
  ['k', 'en', 'tell me the time and the weather', K(T('time'), T('weather')), ['compound']],
  ['k', 'en', 'open calculator and then finder', K(O('calculator'), O('finder')), ['compound']],
  ['k', 'en', 'quit discord and open spotify', K(X('discord'), O('spotify')), ['compound']],
  ['k', 'en', 'text mama saying ok and open maps', K(M('mama', 'ok'), O('maps')), ['compound']],
  ['k', 'en', 'play lofi and open notes', K(P('lofi'), O('notes')), ['compound']],
  ['k', 'en', 'open whatsapp and youtube', K(O('whatsapp'), O('youtube')), ['compound']],
  ['k', H, 'safari band kar aur notes khol', K(X('safari'), O('notes')), ['compound']],
  // ---- media_control (8, 1 Hinglish) ----
  ['b', 'en', 'pause whatever is playing', MC('pause')],
  ['b', 'en', 'skip this one its boring', MC('next')],
  ['b', 'en', 'crank the volume up a bit more', MC('volume_up')],
  ['b', 'en', 'previous song', MC('previous')],
  ['b', 'en', 'its too loud lower it', MC('volume_down')],
  ['b', 'en', 'next one', MC('next')],
  ['b', 'en', 'stop the song for a min', MC('pause')],
  ['b', H, 'itna tez mat chala, kam kar', MC('volume_down')],
  // ---- weather (8, 1 Hinglish) ----
  ['w', 'en', 'whats it like outside weather wise', T('weather')],
  ['w', 'en', 'gonna rain this evening or nah', T('weather')],
  ['w', 'en', 'should i carry an umbrella to school', T('weather')],
  ['w', 'en', 'how hot is it outside', T('weather')],
  ['w', 'en', 'weather tmrw?', T('weather')],
  ['w', 'en', 'is it cold enough for a hoodie', T('weather')],
  ['w', 'en', 'whats the weather in shimla', T('weather')],
  ['w', H, 'aaj bahar garmi kitni hai', T('weather')],
  // ---- reminder (8, 1 Hinglish) ----
  ['r', 'en', 'remind me to wish nanu at 8 tonight', R('nanu')],
  ['r', 'en', 'remind me abt the physics test tmrw', R('physics')],
  ['r', 'en', 'remind me to stretch in 30 min', R('stretch')],
  ['r', 'en', 'set a reminder for the phone recharge', R('recharge')],
  ['r', 'en', 'remind me to take out the trash tonight', R('trash')],
  ['r', 'en', 'dont let me forget parths bday', R('bday')],
  ['r', 'en', 'remind me to return the library book friday', R('library')],
  ['r', H, 'kal subah 7 baje yaad dila dena gym ka', R('gym')],
  // ---- calendar (8, 1 Hinglish) ----
  ['l', 'en', 'am i free tmrw afternoon', T('calendar')],
  ['l', 'en', 'whats lined up for me today', T('calendar')],
  ['l', 'en', 'is friday packed for me', T('calendar')],
  ['l', 'en', 'what do i have coming up next', T('calendar')],
  ['l', 'en', 'show my calendar for the week', T('calendar')],
  ['l', 'en', 'is my week busy', T('calendar')],
  ['l', 'en', 'any plans saturday', T('calendar')],
  ['l', H, 'aaj mere calendar mein kya hai', T('calendar')],
  // ---- system_status (8, 1 Hinglish) ----
  ['y', 'en', 'battery check pls', T('system_status')],
  ['y', 'en', 'is my storage running low', T('system_status')],
  ['y', 'en', 'is my memory maxed out rn', T('system_status')],
  ['y', 'en', 'is something eating my cpu', T('system_status')],
  ['y', 'en', 'is the mac running hot', T('system_status')],
  ['y', 'en', 'will my battery survive 2 more hours', T('system_status')],
  ['y', 'en', 'system health check', T('system_status')],
  ['y', H, 'mac ki battery kitne percent hai', T('system_status')],
  // ---- time (6, 1 Hinglish) ----
  ['t', 'en', 'what time do u have', T('time')],
  ['t', 'en', 'is today the 11th or 12th', T('time')],
  ['t', 'en', 'time in london rn', T('time')],
  ['t', 'en', 'day and date pls', T('time')],
  ['t', 'en', 'is it still morning', T('time')],
  ['t', H, 'ghadi mein kya baja hai', T('time')],
  // ---- note (5) ----
  ['n', 'en', 'note down that the trip is on the 20th', N('trip')],
  ['n', 'en', 'save a note: parths wifi password is chai1234', N('wifi')],
  ['n', 'en', 'add to my notes that bhai owes me 500', N('500')],
  ['n', 'en', 'make a note: buy new earphones', N('earphones')],
  ['n', 'en', 'jot down that the match is at 4 on sunday', N('match')],
  // ---- the rest (one of each kind v1/v2 had) ----
  ['u', 'en', 'what did i say about the trek earlier', T('recall')],
  ['u', 'en', 'what did we talk about last time', T('recall')],
  ['u', 'en', 'do u remember what i said about kunal', T('recall')],
  ['u', 'en', 'why did u open youtube just now', T('why')],
  ['u', 'en', 'why did that take forever', T('why')],
  ['u', 'en', 'why did u pick that', T('why')],
  ['u', 'en', 'get me some momos from swiggy', { act: 'order_food', item_has: ['momos'] }],
  ['u', 'en', 'order a coke', { act: 'order_food', item_has: ['coke'] }],
  ['u', 'en', 'order paneer tikka on zomato', { act: 'order_food', item_has: ['paneer'] }],
  ['f', 'en', 'make a folder called college on desktop', { act: 'create_folder', name_has: ['college'] }],
  ['f', 'en', 'new folder named receipts', { act: 'create_folder', name_has: ['receipts'] }],
  ['f', 'en', 'delete old_resume.pdf', { act: 'delete_file', name_has: ['old_resume'] }],
  ['f', 'en', 'trash the file test123.txt', { act: 'delete_file', name_has: ['test123'] }],
  ['f', 'en', 'where is my aadhar pdf', { act: 'search_files', name_has: ['aadhar'] }],
  ['f', 'en', 'find my marksheet file', { act: 'search_files', name_has: ['marksheet'] }],
  ['f', 'en', 'snap a pic of whats on my screen', T('screenshot')],
  ['f', 'en', 'ss the screen', T('screenshot')],
  ['f', 'en', 'create a file named ideas2.txt', { act: 'create_file', name_has: ['ideas2'] }],
  ['f', 'en', 'list whats in the downloads folder', { act: 'list_files', name_has: ['downloads'] }],
  ['f', 'en', 'read notes.txt for me', { act: 'read_file', name_has: ['notes'] }],
  ['f', 'en', 'add buy milk to list.txt', { act: 'append_file', name_has: ['list'] }],
  ['f', 'en', 'empty my trash', T('empty_trash')],
  ['y', 'en', 'what apps are open rn', T('list_running')],
  ['u', 'en', 'brief me on whats happening today', T('briefing')],
  ['u', 'en', 'quiz me on electrostatics', T('quiz')],
  ['u', 'en', 'undo what u just did', T('undo')],
  ['u', 'en', 'close all my apps', { act: 'ask', gist: 'confirms before closing many apps' }],
  // ---- chat (77, 12 Hinglish): greetings and banter ----
  ['g', 'en', 'yooo jarvis whats the vibe today', CH('greets back casually')],
  ['g', 'en', 'wsg gng hows it hanging', CH('greets back casually')],
  ['g', 'en', 'sup jarvis long day huh', CH('greets back casually')],
  ['g', 'en', 'gm jarvis lets get it today', CH('says good morning')],
  ['g', 'en', 'gn see u tmrw', CH('says good night')],
  ['g', 'en', 'ty bro u saved me', CH("you're welcome")],
  ['g', 'en', 'ur actually goated', CH('takes the compliment')],
  ['g', 'en', 'ur kinda dumb today', CH('takes the criticism lightly')],
  ['g', 'en', 'lol ok fair enough', CH('light reply')],
  ['g', 'en', 'say less', CH('acknowledges')],
  ['g', 'en', 'are u better than siri', CH('answers honestly with some banter')],
  ['g', 'en', 'back from school finally', CH('welcomes him back')],
  ['g', 'en', 'heyyy jarvis missed me?', CH('greets back casually')],
  ['g', 'en', 'hows ur day going', CH('answers how it is')],
  ['g', 'en', 'appreciate u', CH('takes the thanks')],
  ['g', 'en', 'ok cool thanks', CH("you're welcome")],
  ['g', 'en', 'whats good my guy', CH('greets back casually')],
  ['g', 'en', 'u up rn jarvis', CH('answers it is here')],
  ['g', 'en', 'u still there or', CH('answers it is here')],
  ['g', 'en', 'bruhhh not again', CH('light reply')],
  ['g', 'en', 'noice', CH('acknowledges')],
  ['g', 'en', 'hahaha good one jarvis', CH('light reply')],
  ['g', 'en', 'wassup my man jarvis', CH('greets back casually')],
  ['g', 'en', 'good job on that one', CH('takes the compliment')],
  ['g', 'en', 'thats lowkey crazy', CH('light reply')],
  // feelings and opinions
  ['e', 'en', 'im exhausted', CH('empathises, suggests rest')],
  ['e', 'en', 'failed my chem test', CH('empathises')],
  ['e', 'en', 'so bored i might sleep', CH('suggests something to do')],
  ['e', 'en', 'feeling kinda off today', CH('empathises')],
  ['e', 'en', 'nervous abt tmrw', CH('reassures')],
  ['e', 'en', 'my best friend is mad at me for no reason', CH('empathises')],
  ['e', 'en', 'got selected for the school cricket team', CH('congratulates')],
  ['e', 'en', 'guitar or drums which should i learn', CH('gives an opinion')],
  ['e', 'en', 'cant sleep its 2am', CH('empathises, suggests something')],
  ['e', 'en', 'my head is pounding', CH('empathises, suggests rest or water')],
  ['e', 'en', 'today was lowkey a good day', CH('reacts warmly')],
  ['e', 'en', 'is it bad to skip breakfast', CH('gives an opinion')],
  ['e', 'en', 'i passed my driving test!!', CH('congratulates')],
  ['e', 'en', 'im starving whats for dinner', CH('suggests food, orders nothing')],
  // must not act (they name people, apps or actions, and ask for nothing)
  ['z', 'en', 'kunal called me earlier', CH('acknowledges, calls nobody'), ['no_act']],
  ['z', 'en', 'whatsapp is so slow today', CH('acknowledges, does nothing'), ['no_act']],
  ['z', 'en', 'bhai broke my headphones', CH('reacts, no action'), ['no_act']],
  ['z', 'en', 'i texted mama already', CH('acknowledges, sends nothing'), ['no_act']],
  ['z', 'en', 'youtube keeps buffering', CH('acknowledges or advises, opens nothing'), ['no_act']],
  ['z', 'en', 'rehaan is coming over after school', CH('acknowledges, no action'), ['no_act']],
  ['z', 'en', 'i already closed spotify', CH('acknowledges, closes nothing'), ['no_act']],
  ['z', 'en', 'ira says hi', CH('acknowledges, sends nothing'), ['no_act']],
  ['z', 'en', 'my phone is on 5 percent', CH('acknowledges, no action'), ['no_act']],
  ['z', 'en', 'netflix logged me out', CH('acknowledges, opens nothing'), ['no_act']],
  ['z', 'en', 'i was watching cricket all day', CH('reacts, plays nothing'), ['no_act']],
  ['z', 'en', 'nanu sent me a voice note', CH('acknowledges, sends nothing'), ['no_act']],
  ['z', 'en', 'ill text kunal later', CH('acknowledges, sends nothing'), ['no_act']],
  ['z', 'en', 'dont do anything yet', CH('acknowledges, does nothing'), ['no_act']],
  ['z', 'en', 'chrome crashed again', CH('acknowledges or advises, opens nothing'), ['no_act']],
  ['z', 'en', 'yuvan won the race', CH('reacts, no action'), ['no_act']],
  ['z', 'en', 'i set my own alarm', CH('acknowledges, no action'), ['no_act']],
  ['z', 'en', 'mama is making dinner', CH('reacts, no action'), ['no_act']],
  ['z', 'en', 'never mind its fine', CH('acknowledges'), ['nvm', 'no_act']],
  ['z', 'en', 'nvm forget that', CH('acknowledges, cancels'), ['nvm', 'no_act']],
  ['z', 'en', 'scratch that', CH('acknowledges, cancels'), ['nvm', 'no_act']],
  // honesty: "did you X" — nothing in this conversation shows it was done
  ['h', 'en', 'did u text kunal or not', CH('honest: no record of sending it'), ['no_act', 'honesty']],
  ['h', 'en', 'did spotify open or nah', CH('honest about what it did or has no record'), ['no_act', 'honesty']],
  ['h', 'en', 'did u actually set the reminder', CH('honest about what it did or has no record'), ['no_act', 'honesty']],
  ['h', 'en', 'was the msg to bhai sent', CH('honest: no record of sending it'), ['no_act', 'honesty']],
  ['h', 'en', 'did u close safari', CH('honest about what it did or has no record'), ['no_act', 'honesty']],
  // Hinglish chat
  ['j', H, 'kya haal chaal jarvis bhai', CH('answers casually')],
  ['j', H, 'bahut bore ho raha hai aaj', CH('suggests something to do')],
  ['j', H, 'aankh lag rahi hai', CH('suggests rest')],
  ['j', H, 'thanks yaar tu best hai', CH("you're welcome")],
  ['j', H, 'kya baat hai tu toh genius hai', CH('takes the compliment')],
  ['j', H, 'aaj ka din mast tha', CH('reacts warmly')],
  ['j', H, 'ek joke suna', CH('tells a joke')],
  ['j', H, 'chal bye kal baat karte', CH('says bye')],
  ['j', H, 'pagal hai kya', CH('light reply')],
  ['j', H, 'kuch nahi bas aise hi', CH('light reply')],
  ['j', H, 'rehne do', CH('acknowledges, cancels'), ['nvm', 'no_act']],
  ['j', H, 'bhai ne phone kiya tha', CH('acknowledges, no call placed'), ['no_act']],
];

const n = {};
const ITEMS = ROWS.map(([p, lang, text, expect, tags]) => {
  n[p] = (n[p] || 0) + 1;
  const o = { id: 'v3' + p + String(n[p]).padStart(2, '0'), lang, text, expect };
  if (tags) o.tags = tags;
  return o;
});
module.exports = { ITEMS };

if (require.main === module) {
  const D = p => path.join(__dirname, 'data', p);
  const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = s => new Set(norm(s).split(' ').filter(Boolean));
  // EXACT: every text line anywhere under finetune/data — held-outs, his messages, synthetic rows, training files.
  const exact = new Set();
  const take = t => { if (typeof t === 'string' && t.length < 400) exact.add(norm(t)); };
  const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (typeof x === 'string' && ['text', 'q', 'query', 'content'].includes(k)) take(x); else walk(x); } else if (typeof v === 'string') take(v); };
  const files = [];
  (function list(dir) { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) { if (!/external|casual_runs|wiki/.test(f)) list(p); } else if (/\.(jsonl|json)$/.test(f) && !/casual_stress_heldout_v3/.test(f)) files.push(p); } })(D(''));
  for (const p of files) {
    if (fs.statSync(p).size > 60e6) continue;
    const raw = fs.readFileSync(p, 'utf8');
    if (p.endsWith('.jsonl')) { for (const l of raw.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r.messages) r.messages.filter(m => m.role === 'user').forEach(m => take(m.content)); else walk(r); } catch (e) {} } }
    else { try { walk(JSON.parse(raw)); } catch (e) {} }
  }
  // NEAR: the stress sets, the synthetic rows (round 6's included), his messages and the reader/clock/selffact held-outs.
  const nearSrc = [];
  for (const f of ['casual_stress_heldout.jsonl', 'casual_stress_heldout_v2.jsonl', 'synth.jsonl', 'his_messages.jsonl', 'round5_valid.jsonl', 'round6_valid.jsonl', 'clock_heldout_lines.jsonl'])
    for (const l of fs.readFileSync(D(f), 'utf8').split('\n')) if (l.trim()) nearSrc.push(JSON.parse(l).text);
  for (const f of ['selffact_heldout.json', 'selffact_heldout2.json', 'selffact_heldout3.json']) { const d = JSON.parse(fs.readFileSync(D(f), 'utf8')); nearSrc.push(...d.store, ...d.skip); }
  const nearW = nearSrc.map(t => ({ t, w: words(t) }));
  let bad = 0;
  if (new Set(ITEMS.map(r => norm(r.text))).size !== ITEMS.length) { console.log('duplicate inside v3'); bad++; }
  for (const r of ITEMS) {
    if (exact.has(norm(r.text))) { console.log('EXACT  ' + r.id + ' ' + JSON.stringify(r.text)); bad++; continue; }
    const W = words(r.text);
    for (const o of nearW) { let k = 0; for (const x of W) if (o.w.has(x)) k++; if (k / ((W.size + o.w.size - k) || 1) >= 0.75) { console.log('NEAR   ' + r.id + ' ' + JSON.stringify(r.text) + ' ~ ' + JSON.stringify(o.t)); bad++; break; } }
  }
  if (bad) { console.log(bad + ' problem(s) — rewrite them; nothing written'); process.exit(1); }
  const by = {}; for (const r of ITEMS) by[r.expect.act] = (by[r.expect.act] || 0) + 1;
  fs.writeFileSync(D('casual_stress_heldout_v3.jsonl'), ITEMS.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log('wrote data/casual_stress_heldout_v3.jsonl — ' + ITEMS.length + ' items, ' + ITEMS.filter(r => r.lang === H).length + ' Hinglish, ' +
    ITEMS.filter(r => (r.tags || []).includes('no_act')).length + ' no_act; 0 exact of ' + exact.size + ' lines, 0 near of ' + nearW.length + '\n' + JSON.stringify(by));
}
