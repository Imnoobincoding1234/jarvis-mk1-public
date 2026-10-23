# How a message is labelled for the reader model

The reader turns ONE message into ONE reading. It never routes and never acts: the machine builds
the action from the reading, resolves every name against its registries, and refuses any value that
is not in the message. So a label says what the message *says*, copied from its own words.

Labels are written by hand. They are never taken from what the regex parser or the normaliser did,
because that would teach the model the traps they are being replaced for.

## Output

Compact JSON, keys in this order when present:

    {"act": …, "thing": …, "query": …, "to": …, "body": …, "what": …, "when": …, "where": …, "browser": …, "name": …, "content": …, "topic": …, "as": …, "business": true, "force": true, "reported": true, "video": true}

Every string value is an exact, case-insensitive substring of the message. Nothing is normalised,
corrected or invented — "vs code" stays "vs code", a misspelling stays misspelt, "it" stays "it".

## Acts

| act | fields | meaning |
|---|---|---|
| `open` | thing, browser?, as?, business? | open an app, site, URL or workflow |
| `close` | thing, force? | quit an app |
| `search_web` | query, where?, browser? | search the web, or the named site/app/browser |
| `play` | query, where?, browser?, video? | play or watch or listen to something (`video: true` when he asks for a video) |
| `search_files` | query | find a file or folder on the Mac |
| `create_folder` | name, where? | make a folder |
| `create_file` | name, where?, content? | make a file, optionally with text in it |
| `delete` | thing, where? | delete / trash a file or folder |
| `read` | thing, where? | show what a file says |
| `append` | thing, content, where? | add text to the end of a file |
| `list` | thing, where? | what is in a folder |
| `system_status` | – | overall health of the machine (not one named stat) |
| `screenshot` | – | capture the screen |
| `list_running` | – | which apps are running / open |
| `empty_trash` | – | empty the Trash |
| `sleep_display` | – | turn the display off |
| `dream_log` | – | what JARVIS did in dream mode while he was away ("what did you do while I was away", "dream log") |
| `dream_now` | – | run dream mode's idle work now ("dream now", "run your maintenance now") |
| `dream_on` / `dream_off` | – | turn dream mode on / off — a polarity pair, like open/close |
| `quiz_me` | topic? | ask him a study question now ("quiz me", "test me on biology") |
| `study_stats` | – | how his studying is going — topics, cards due, scores |
| `learn_topic` | topic | put a subject on his study list ("teach me about entropy", "i'm learning spanish") |
| `stop_topic` | topic | take a subject off his study list ("stop studying entropy") |
| `message` | to, body?, where?, reported? | send someone a message (WhatsApp by default; "on imessage" etc. is `where`) |
| `call` | to, where?, video? | call someone ("facetime", "video call" → video) |
| `remind` | what?, when? | set a reminder for him ("remind me to…", "lmk at 6 to…", "yaad dila dena…") |
| `calendar` | when? | what is on his calendar / is he free ("am i free tmrw", "hows my day looking") |
| `note` | content, write? | write something into Notes ("jot down…", "note down…", "write a passage about X in notes") |
| `weather` | where?, when? | the weather ("do i need a jacket", "aaj baarish hogi kya") |
| `time` | where? | what the clock says, here or in a named place ("whats the time", "aaj kya date hai", "time in tokyo") — round 6 |
| `pause` / `resume` / `next_track` / `volume_up` / `volume_down` | – | the music player (each its own act, like open/close) |
| `multi` | steps | 2–4 independent requests in one message (round 4) |
| `none` | – | anything else |

## Rules

- `where` is the words naming the place: "on youtube" → `youtube`; "on my desktop" → `my desktop`.
- "open X and search/look up/find Y" is ONE reading: `search_web`, query Y, where X. Same with play.
- `browser` is set only when a browser AND a site are both named: "open safari and search lofi on
  youtube" → where `youtube`, browser `safari`. A browser named alone is the `where`.
- A `query` is what would be typed into the search box. It does not start with words addressed to
  JARVIS — "find me some pizzas" → `pizzas`, "find my resume" → `resume` — and it does not end with
  them ("for me please"). Articles that belong to the phrase stay: "the eiffel tower height".
- "search X", "google X", "look X up" with no place: `search_web` with no `where`.
- A bare "play X" is `play` with no `where`; the machine decides whether X is music, a video or a game.
- `as` is `site` or `app` only when he says which ("the youtube website", "the slack app").
- `business` is true only when the message means the business's / company's / brand's account.
- `force` is true only for force-quitting.
- "move X to the bin/trash" is `delete` X.
- Dream mode is JARVIS's own idle work. "what did YOU do while I was away" is `dream_log`; "what did I do
  today" is `none` (recall). "run a virus scan", "do my homework now", "turn off focus mode", "tidy up
  my desktop" are `none` — the same shapes about something else. "play dreams by fleetwood mac" is `play`.
- The tutor studies HIS subjects from his own books. `topic` is the words naming the subject, copied:
  "teach me about entropy" → `entropy`, "add organic chemistry to my study topics" → `organic
  chemistry`. A quiz with no subject named has no topic ("quiz me", "quiz me on something"). A question
  about a subject is `none` — it is answered now, not studied: "what is entropy", "explain photosynthesis".
  "teach me about X" is `learn_topic` — that is what he uses it for. Looking a subject up, playing a
  lecture or opening a learning app keeps its own act ("search for spanish lessons" is `search_web`).
- One named statistic is `none`, however it is asked: "is my battery okay", "how's my cpu", "ram kitni
  free hai" — the stats lane answers those. The machine as a whole is `system_status`, in any language:
  "why is my mac so slow", "mera laptop slow chal raha hai kyun", "is everything alright with my computer".
- A greeting is `none` ("hi how is everything doing?", "kaise ho") — it asks after him or JARVIS, not the
  machine.
- A name introduced by "called / named / titled / label it as" is the name, without those words.
- A referent stays a referent: "get rid of the folder" → `delete`, thing `the folder`.
- A pronoun stays a pronoun: "search it up on youtube" → query `it`.

### Round 3 (2026-09-27): messages, calls, reminders, calendar, notes, weather, the player

- `to` is the words naming the person, copied — "mama", "mera bhai", "bhai", "parth", "him", "usko", even a
  number. Never normalised; the machine resolves it against Contacts and WhatsApp.
- `body` is the words to convey, without the word that introduces them: "saying wsg" → `wsg`; "that im late"
  → `im late`; "asking if hes coming tonight" → `if hes coming tonight` with `reported: true`. `reported` is
  set when the body is indirect (asking / if / whether / about / how he is / Hindi "ki…" questions), so the
  machine rewrites it as a direct message and adds NOTHING he did not say. Slang in a body is kept exactly
  ("saying wsg gng" → `wsg gng`). No body at all ("message mama") is fine — JARVIS asks what to say.
- `where` for a message or call is the channel words: "on whatsapp" → `whatsapp`, "on imessage", "facetime"
  (then `video: true` too).
- A filler lead-in is not part of any value: "eh let it be, just text parth saying hi" → to `parth`, body `hi`.
  "nvm" followed by a new request is that request; "nvm" alone is `none`.
- Scheduled sends ("at 6pm message mama…") are `none` — they cannot be sent now.
- `when` is the time words, copied: "tmrw", "at 6", "in an hour", "every hour", "kal subah".
- A reminder whose content is missing keeps what it has ("set a reminder for 9pm" → when `9pm`).
- `calendar` is READING the calendar. Creating an event or meeting is `none` (not supported yet).
- `note` content is what goes into the note or what it is about, copied: "jot down buy eggs" → `buy eggs`,
  "write a passage about tea in notes" → `a passage about tea`.
- One named statistic stays `none`; the weather is now its own act. A question ABOUT weather in general
  ("whats the difference between weather and climate") is `none`.
- `play` with `video: true` when he asks for a video, named or not: "find me a vid on how to tie a tie" →
  query `how to tie a tie`, video; "open youtube and play a random video" → query `a random video`, where
  `youtube`, video. The query never carries the lead-in ("eh let it be, just…").
- The player: "pause the song", "gaana band kar" → `pause`; "skip this", "next song" → `next_track`; "turn it
  up" → `volume_up`. Setting an exact level ("volume to 40") is `none`.
- STILL `none`, however casual: greetings and slang greetings ("wsg", "hyd", "sup", "kaisa hai"), thanks,
  feelings, complaints that name an app or a person ("whatsapp keeps crashing wtf", "parth is so annoying"),
  statements and plans ("calling mama later", "i texted bhai already", "mama said dinner is ready"), questions
  about what JARVIS did ("did u send that msg to mama", "did u open spotify") — those are never acts, and
  how-to questions ("how do i message someone on whatsapp"). Emergencies ("call an ambulance") are `none` too:
  the SOS lane owns them.

### Round 4 (2026-09-27): several requests in one message, and notes to write

- `multi` holds 2–4 independent requests from one message, in HIS order, each shaped exactly like its own
  reading: `{"act":"multi","steps":[{"act":"message","to":"mama","body":"omw"},{"act":"open","thing":"maps"}]}`.
  Every value is still his words. A step is never `none` or `multi`, and `refers` goes on the whole reading.
- Still ONE reading, not `multi`: "open X and search/play Y" (one search/play with `where` X); "and" inside a
  body ("text mama saying im at the mall and ill be late"); "play drake and kendrick" (one query); a request
  and its own detail ("remind me to call the dentist and book a slot" is one reminder).
- Words that are not requests are not steps: "yo wsg, open spotify" is ONE `open`. If only one act is left, it
  is that act, not `multi`.
- Still `none`: a step that works on another step's result ("find my resume and send it to rahul", "take a
  screenshot and send it to parth"), a scheduled step, more than four requests, or any step that would be
  `none` on its own (a question in the middle of commands makes the whole message `none`).
- Joiners in his style all count: "and", "and then", "then", "+", ",", "after that", "also", "aur", "phir".
- `note` takes `write: true` when he asks for text to be WRITTEN — "write a passage about tea in notes", "write a
  short poem about rain", "open notes and write something about my trip" — and not when he gives the words
  to keep ("jot down buy eggs", "note down the test is on the 14th", "open notes and write buy milk").
  `content` is copied either way.

### Round 6 (2026-10-10): the clock

- `time` is the time, the date or the day, here — or the time in a place he names (`where`, his words: "in new york" →
  `new york`, "dubai mein" → `dubai`). "is it past 10", "aaj monday hai na", "is it the weekend yet" are `time`.
- NOT `time`: an alarm or a timer ("wake me at 6", "timer for 10 min") is `none` — reminders do not ring and there is no
  alarm; "remind me at 8 to …" is `remind`. His own schedule ("what time is my tuition", "am i free at 4") is `calendar`.
  When an event happens in the world ("what time does the final start", "when is diwali") is `none` (the web lane answers
  questions). A duration ("how long till 5", "how long does maggi take") is `none`. Someone else's time ("what time is it
  for my mom") is `none` — it has its own lane. A song or show called Time is `play`.

## `refers` — does the message lean on the conversation?

`"refers": true` goes on ANY act, `none` included, when the message has words standing in for something
named EARLIER in the conversation rather than in the message itself. It is what lets JARVIS skip the 3B
reference resolver (context.resolveInText, 10–17 s cold) on every turn that cannot need it. Set with
`label_refers.py`, which touches nothing but this key.

- a pronoun or demonstrative pointing back: "search him up on brave", "close it", "order that", "send
  them the message", "play his latest video"
- a description only the conversation can fill: "the second one", "the same thing again", "that song",
  "their website", "the one you just mentioned"
- a place or time named earlier: "book me a flight there", "remind me about that tonight"
- ellipsis: "and in mumbai?", "and my email?"
- in any language: "usko call karo"

Not `refers`:
- the referent is in the same message: "create a new folder and label it as JARVIS MK two", "message
  mama asking about her health", "ok install among us" ("us" is a game)
- a dummy "it" that points at nothing: "it's raining", "how is it going"
- a bare reply with no stand-in word: "yes", "no", "summary" — a reply that DOES have one ("the first
  one", "do that again") is `refers`

When unsure, mark it. A false `refers` only costs the check JARVIS runs today; a missed one makes JARVIS
act on the bare word — that is how Brave was once told to search for "him up".

`none` covers, among others:
- questions and how-tos, even about actions ("how do I create a folder", "what should I delete")
- statements and past tense ("i watch a lot of youtube", "that play was amazing")
- idioms whose object is not a thing on the machine ("open up about something", "close that chapter")
- negated requests ("don't open youtube"), and postponed ones with NO time ("delete it later, not now"). A request with an
  explicit time is the act with `when` (round 7) — see "Round 7" below
- one named statistic (battery, RAM, CPU, disk) — those have their own lane
- orders, research, memory, teaching (messages, calls, reminders, the calendar, notes and the weather are
  acts since round 3)
- looking a person up ("look up parth in contacts", "open contacts and search for nanu") — that is
  the contacts lane's job, which resolves against Contacts AND his WhatsApp contacts; a search typed
  into Contacts.app would miss WhatsApp (his call, 2026-09-16). Opening the app itself
  ("boot up contacts") is still `open`.
- a task INSIDE a site or app ("open my youtube subscriptions", "follow lady gaga on spotify",
  "click the more information link") — those belong to the lanes that can be taught
  (but a site's or app's own front page is `open` — "open my mail", "open my gmail inbox" → open `mail` / `gmail`)
- several instructions where one works on another's result (independent ones are `multi` since round 4)
- replies to JARVIS ("yes", "the first one", "that worked")


## Round 7 (2026-10-15) — `when`, front pages, reasons, `as` on close

- `when` is the words saying WHEN to do the act, copied — "open notes in 2 minutes" → open `notes`, when `in 2 minutes`; "play lofi
  at 9 tonight" → play `lofi`, when `at 9 tonight`; "10 minute baad spotify band kar dena" → close `spotify`, when `10 minute baad`;
  "text bhai at 6 saying dinner is ready" → message `bhai`, body `dinner is ready`, when `at 6`. Allowed on open, close, play, message,
  call, search_web, screenshot and the player acts. The machine schedules the act for that time instead of doing it now.
- NOT `when`: a time inside the message ("text mama saying im on my way in half an hour" → body `im on my way in half an hour`); a
  length in a query ("play a 10 minute meditation"); a reminder (remind keeps its own `when`); a statement ("class starts at 9");
  "later" or "not now" with no time (→ `none`, as before).
- A site's or app's own front page is `open`: "open my mail" → `mail`, "open my gmail inbox" → `gmail`. A section inside it is
  still `none` ("open my youtube subscriptions").
- A reason after the request is not part of the thing: "open github i wanna push my code" → open `github`; "open chatgpt i got a
  doubt" → open `chatgpt`.
- `as` (site / app) goes on close too: "close the notes app" → close `notes`, as `app`.
- Talking ABOUT music is not a request to play it: "lol that song slaps", "tum gaana gaate ho kya", "kya tum gaana gaa sakte ho" →
  `none`. "itna tez mat chala, kam kar" (too loud, turn it down) → `volume_down`.
- Someone's news is not a message to send: "harsimran says hi", "chal bye kal baat karte" → `none`.
- "ss the screen", "snap a pic of my screen" → `screenshot` (never sleep_display).

## Play — the words that name the thing, and `video` (2026-10-16, his OK: "keep the front words, video whenever he asks for a video
## or names a video site")

Round 7's training rows disagreed with each other here ("throw on some coldplay" → `coldplay` in one row, "some drake" kept in another;
27 YouTube rows without `video`), and the model learned to hesitate on exactly those lines. One rule from now on:

- `query` is EVERY word he used to name the thing, copied in his order — the words in front included: "play some drake" → `some
  drake`; "koi bhajan bajao" → `koi bhajan`; "kuch purane gaane chala do" → `kuch purane gaane`; "play a cooking video" → `a cooking
  video`; "play a 15 minute yoga video" → `a 15 minute yoga video`; "play a random song lol" → `a random song`.
- NOT in `query`: the lead-in and filler around the request ("eh nvm just", "yo", "lol", "rn", "idk"); the platform, which is `where`
  ("on spotify" → `spotify`, "youtube pe" → `youtube`); and the framing of a topic — "find me a vid on how to tie a tie" → `how to
  tie a tie` (as above).
- `video: true` whenever he asks for a video, in whatever words he uses — read for meaning, like every label — or names a video site as
  `where`. A reading with `where` YouTube therefore always has `video: true`; music on Spotify never does.
- Hold files written before this rule were relabeled to it on 2026-10-16, each changed row keeping its old label as `label_was`.
