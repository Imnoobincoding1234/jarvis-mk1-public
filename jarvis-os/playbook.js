'use strict';
// ---------------------------------------------------------------------------
// JARVIS playbook — procedural memory. HOW to do a kind of task, not just what tools exist.
//
// WHAT WAS MISSING, and why this shape.
//
// The router is a ladder of keyword lanes ending in an agentic loop. That works for one-shot
// commands and fails for anything with structure: "play the latest yessmartypie video" matched a
// site lane and merely opened youtube.com, and "open youtube and search X and click the first
// result" was claimed by the click-by-label lane and answered "I cannot see anything like that on
// the page". Neither ever reached the loop. Measured, both of them, before this file existed.
//
// Reaching the loop alone would not have saved them. The loop asks a 3B "what is the next single
// step?", and a 3B cannot author a five-step browser procedure — that is the documented ceiling in
// this project, and elaborating the prompt was measured to make it WORSE, not better.
//
// So this converts the hard question into an easy one. Instead of "invent a plan", the model is
// asked "carry out step 3 of this plan, here is the page". Choosing an element from a numbered list
// is comfortably inside what a 3B does reliably; inventing the list is not. That is the whole idea:
// the intelligence lives in the procedure, the model supplies only the page-dependent parts.
//
// WHY NOT FINE-TUNING. He asked to be "trained on 20-50 scenarios". Written procedures are that,
// with three advantages that matter here: they take effect immediately with no training run, they
// are auditable (he can read what JARVIS thinks the steps are and tell me where I am wrong), and a
// wrong one is a one-line edit rather than a retrain. They also survive swapping the model, which a
// fine-tune of a 3B would not.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never completes a purchase. The shopping procedures stop
// at the basket with the total on screen and hand back — placing an order is his to do, not
// something an assistant should ever do on a 3B's judgement. See BUYING_STOPS_AT_BASKET.
// ---------------------------------------------------------------------------

const H = require('./harness.js');

let deps = { jlog: () => {} };
function init(d) { deps = Object.assign(deps, d || {}); }

// TOOL SCOPING. A procedure may declare the only tools its run is allowed to touch.
//
// Telling a 3B "follow these steps" is a request it can decline. Measured: handed the food
// procedure, it called open_whatsapp_chat — nothing in the goal or the steps mentions messaging
// anyone, and the invented-recipient guard was the only thing between that and a stranger's phone.
// A procedure that names its tools makes the wander IMPOSSIBLE rather than discouraged: the others
// are not offered, so they cannot be chosen.
const BROWSER_TOOLS = ['browser_go', 'browser_page', 'browser_elements', 'browser_click', 'browser_fill', 'browser_submit', 'browser_tabs', 'browser_extract',
  // The two that make an order actually complete: bind an ADD to its dish, and press a control
  // that is not an enumerable element (modal buttons, option rows).
  'browser_add_dish', 'browser_click_label'];

// A procedure that reaches checkout stops there, every time, in every playbook below. Written once
// as a constant so it cannot be softened in one recipe and not another.
const BUYING_STOPS_AT_BASKET =
  'STOP once the basket and total are on screen. Report what is in it and what it costs, and say he must place the order himself. Do NOT click Buy, Place order, Pay, or Confirm order.';

// ---------------------------------------------------------------------------
// The procedures.
//
// A procedure is chosen by MEANING, not by keywords — see EXEMPLARS and semanticMatch below. Each
// entry declares what it does, the steps to do it, which slots it needs and which tools it may
// touch. It does not declare the words a person might use, because that was the old mechanism and
// it failed on every phrasing nobody wrote down: "play judas" scored zero against a `must` listing
// spotify|song|track|album|playlist|music, and a song title is not a thing that can be listed.
//
// `must` and `when` regexes used to live on every procedure and decided the match. Twenty-five of
// them were deleted the day the matcher went semantic — nothing read them any more, and a dead word
// list sitting beside a live classifier is an invitation to wire it back up. One survives, on
// order-food, and it is an EXTRACTOR rather than a gate: foodWordIn() uses it to report which food
// word appeared so the item classifier can tell a dish from a category.
//
// `not` survives too, and is a different animal: it lists SITES, which are a genuinely closed set,
// and it only ever REMOVES a candidate the request itself ruled out — "order hiking boots from
// amazon" must not reach the food procedure however the sentence happens to embed.
// ---------------------------------------------------------------------------
const PLAYBOOKS = [
  // ---- video ----
  {
    id: 'youtube-latest-from-channel',
    title: 'play the newest video from a channel',
    // WITHOUT A CHANNEL THIS PROCEDURE HAS NOTHING TO OPEN. "play his latest video" strips to ""
    // — every word in it is scaffolding — and the empty slot was pasted into the URL as
    // youtube.com/@/videos. Declaring the requirement is what makes match() refuse it.
    requires: ['query'],
    // THE SENTENCE IS NOT THE CHANNEL NAME.
    //
    // "Open YouTube and search for not your type and play his latest video" left the whole tail in the
    // slot — "and search for not your type and his" — and step 1 built
    // youtube.com/@and search for not your type and his/videos, which YouTube resolved to a real
    // channel called AND. The scaffolding people actually say ("open X and", "search for", "and play
    // his latest video") has to come off before what remains can be treated as a name.
    // EXTRACT, DO NOT SUBTRACT.
    //
    // Stripping noise words left debris: "search youtube for lofi beats and play the latest one" came
    // out as "for lofi beats one", because "search for" only matches when the words are adjacent and
    // "one" is not noise anywhere else. Reading the query out POSITIVELY — the words between "search
    // for" and "and play …" — is what people actually type, and it degrades to the old strip when the
    // sentence has no search phrasing at all ("play the latest yessmartypie video").
    slots: (() => {
      const TAIL = /\s+(?:and|then)\s+(?:play|watch|open)\b.*$/i;
      const NOISE = /\bopen\b|\bgo\s+to\b|\b(?:and|then)\s+(?:play|watch|open)\b|\b(?:his|her|their|its)\b|\b(?:the\s+)?(?:latest|newest|new|recent|last)\b|\bvideo(?:s)?\b|\bon\s+you\s?tube\b|\byou\s?tube\b|\b(?:play|watch|open|put on)\b|\bone\b/gi;
      const pull = g => {
        const t = String(g || '');
        const m = t.match(/\b(?:search|look\s+up|find)\b\s*(?:on\s+)?(?:you\s?tube\s*)?(?:for\s+)?(.+)$/i);
        const core = m ? m[1].replace(TAIL, '') : t;
        // A POSSESSIVE IS NOT PART OF THE NAME. The channel is "yessmartypie"; "yessmartypie's" is
        // him saying whose video it is. Left in, the handle lookup flattens to "yessmartypies",
        // matches nothing, and the lane falls back to playing whatever the search returned first.
        return stripNoise(core, NOISE).replace(/['\u2019]s\b/gi, '').replace(/\s+/g, ' ').trim();
      };
      return {
        query: pull,
        // A HANDLE OR A SEARCH? "yessmartypie" is a channel; "not your type" is a phrase. Decided here,
        // deterministically, rather than asking a 3B which URL shape to build.
        start_url: g => {
          const q = pull(g);
          return /\s/.test(q)
            ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
            : 'https://www.youtube.com/@' + q + '/videos';
        },
      };
    })(),
    steps: [
      'browser_go to {start_url} — copy that URL exactly. A channel page is newest-first, so its first entry IS the latest; a results page needs the right video picked from the list.',
      'If that page does not exist, browser_go to https://www.youtube.com/results?search_query={query_url} instead and take the first video.',
      'browser_elements with q "{query}" — passing q ranks the page so video titles come first and the navigation furniture sinks. You get a short list, not the whole page.',
      'browser_click that element using the number in its brackets — [29] means i=29, NOT i=1. Pick the first entry that reads like a VIDEO TITLE; skip channel names, filter chips, Shorts and adverts.',
      'If none of them is a video, call browser_elements again with more:true (and the same q) for the next batch. The earlier list is discarded, so work only from the newest one.',
      'browser_page to confirm a watch page actually loaded (the URL contains /watch).',
    ],
    done: 'a YouTube watch page is open and playing',
    tools: BROWSER_TOOLS,
  },
  {
    id: 'youtube-search-and-open',
    title: 'search YouTube and open a result',
    // Nothing to search for means this is not this procedure. "open youtube" embeds nearest to it
    // (margin 0.110) and is a one-call site open, not a six-step search-and-click.
    requires: ['query'],
    // Same leak as search-and-open-result, plus one this lane had on its own: the tail clause was
    // stripped only for "and click", never "and open". So "search youtube for lofi beats and open the
    // first result" searched YouTube for "for lofi beats and open" — the preposition AND the
    // instruction. The web lane already handled both verbs; this one was never brought level.
    slots: { query: g => stripNoise(g, /\b(?:open|go to|on)?\s*you\s?tube\b(?:\s+for)?|\b(?:and\s+)?search(?:\s+for)?\b|\band\s+(?:click|open).*$|\bthe\s+first\s+result\b|\bfirst\b/gi) },
    steps: [
      { do: 'browser_go to https://www.youtube.com/results?search_query={query_url} — going straight to the results URL avoids typing into the search box, which is where this used to go wrong.',
        run: { tool: 'browser_go', args: { url: 'https://www.youtube.com/results?search_query={query_url}' } } },
      'browser_elements with q "{query}" to get a ranked shortlist rather than the whole page.',
      'browser_click the first VIDEO TITLE link in it, using the number in its brackets (i=29 for [29], not i=1) — not a channel, filter or advert.',
      'If none fits, browser_elements again with more:true and the same q for the next batch; the old list is dropped.',
      'browser_page to confirm the URL contains /watch.',
    ],
    done: 'the chosen video is open',
    tools: BROWSER_TOOLS,
  },
  // ---- music ----
  {
    id: 'spotify-play',
    title: 'play something on Spotify (web player)',
    // "PLAY <TITLE> BY <ARTIST>" IS A MUSIC REQUEST, and it named none of the words below.
    //
    // Reported live: "play judas by lady gaga" scored 0 here — no "spotify", no "song", no "music" —
    // so this playbook was never even considered, the request fell through to the 3B classifier, and
    // it answered by opening SAFARI. Twice: once the agent loop burned 40s trying search_in_app
    // against a Music app that does not exist, once it booted a browser and called that success.
    //
    // The eval said 42/42 through all of it, because both media tasks embed a trigger word —
    // "play bohemian rhapsody ON SPOTIFY" and "play lady gaga's latest SONG". They tested the
    // phrasings the suite happened to choose, not the phrasing a person uses. A green suite over a
    // broken feature is the exact failure this project keeps rediscovering.
    //
    // "<verb> ... by <artist>" is the safe shape to add, but only when the artist ENDS the sentence.
    // A plain "play ... by ..." was too greedy and claimed "play the game by the rules tomorrow
    // morning at work" — caught by its own refusal test. An artist name is short and terminal, so
    // requiring at most three trailing words after "by" separates "by lady gaga" from "by the rules
    // tomorrow morning at work" without needing a list of non-musical idioms.
    //
    // A bare "play judas" is not matched HERE, and the fix for that is not another verb in this
    // regex. "play|put on" is already a two-word list that misses "throw on judas", "blast judas",
    // "stick on judas" — widening it just moves the edge. Bare requests are claimed semantically
    // instead; see semanticMatch() below.
    slots: { query: g => stripNoise(g, /\bon\s+spotify\b|\bspotify\b|\b(?:play|put on|start)\b|\b(?:the\s+)?(?:song|track|album|playlist)s?\b|\bsome\s+music\b/gi) },
    steps: [
      // The Spotify APP cannot be installed on this Mac, so search_in_app can never resolve it —
      // it answered "Not sure which app you mean by Spotify" every time, which is a dead end
      // dressed as a question. The web player is the real client here, not a fallback.
      'browser_go to https://open.spotify.com/search/{query_url} — the WEB player. Do not use search_in_app for Spotify: the desktop app is not installed on this Mac and never will be.',
      // kind:"button" ON PURPOSE. Listing everything hands back a page of track LINKS that outrank the
      // play controls on every text signal there is, and clicking a track link opens its page and
      // plays nothing — verified. Asking for buttons alone puts "Play {query}" at number one, which is
      // the only position a 3B reliably picks.
      'browser_elements with kind "button" and q "{query}" — these are the play controls on the page.',
      // THE BRACKET NUMBER IS AN ID, NOT A POSITION. Measured on a live run: the ranking put eight
      // "Play Dead Dance" buttons at the top of the list, exactly as intended, and the 3B then called
      // browser_click i=1 because it was the first one shown. The list starts at [149]. The YouTube
      // procedures already spell this out and pass; this one only said "the number in its brackets"
      // and lost the run to the same mistake. Any of the matching buttons will do - take the first.
      'browser_click the button labelled "Play {query}", using the number in its brackets — [149] means i=149, NOT i=1. The bracketed number is an id, never a position in the list. If several match, take the first.',
      'browser_page to confirm something is actually playing rather than just being displayed.',
    ],
    done: 'the track is playing in the Spotify web player',
    always: true,
    tools: BROWSER_TOOLS,
  },
  // ---- shopping: always stops at the basket ----
  {
    id: 'order-food',
    title: 'build a food order (stops at the basket)',
    // "ORDER" IS A VERB, NOT A CUISINE. It used to sit in this `must`, which made every "order X" a
    // food request whatever X was — hiking boots included. Food is identified by FOOD, so the verb
    // moved to `when` (where it still corroborates) and the dish vocabulary moved in, mirroring
    // FOOD_CATEGORY_RE in server.js so "order me momos" keeps working without "order" alone
    // claiming the request.
    // SAMOSA WAS MISSING FROM BOTH COPIES OF THIS LIST, on a machine in Maharashtra.
    // "what are samosas?" then "okay order that for me" resolved the pronoun
    // correctly and still went to AMAZON, because nothing here recognised the word
    // as food and shop-add-to-cart's `must` (which includes the bare verb "order")
    // claimed it instead. The vocabulary was written India-aware — momos, biryani,
    // dosa, thali, maggi — and then stopped short of the commonest snack in the
    // country. Kept deliberately in step with FOOD_CATEGORY_RE in server.js, per
    // the note above; they are two lists that have to agree, which is a hazard
    // worth knowing about rather than a design to copy.
    // READ, but never as a gate: foodWordIn() matches against this to report WHICH food word
    // appeared, which the item classifier needs to tell a dish from a category. The other
    // procedures' `must` regexes were deleted — nothing consulted them once matching went
    // semantic, and a dead word list beside a live classifier is an invitation to re-wire it.
    must: /\bpizza\b|\bfood\b|\bswiggy\b|\bzomato\b|\bdominos?\b|\buber\s?eats\b|\bburger\b|\bbiryani\b|\bcoffee\b|\bmomos?\b|\bnoodles?\b|\bsandwich(?:es)?\b|\bpastas?\b|\brolls?\b|\bshawarmas?\b|\bcakes?\b|\bice\s?creams?\b|\bteas?\b|\bfries\b|\bthalis?\b|\bdosas?\b|\bmaggi\b|\bsamosas?\b|\bpakoras?\b|\bkachoris?\b|\bchaat\b|\bparathas?\b|\bnaan\b|\brotis?\b|\bchole\b|\brajma\b|\bidlis?\b|\bvadas?\b|\bpoha\b|\bupma\b|\bjalebis?\b|\bpaneer\b|\btikkas?\b|\bkebabs?\b|\bkababs?\b|\bcurr(?:y|ies)\b|\bdaal\b|\bchowmein\b|\bmanchurian\b|\bpav\s?bhaji\b|\bvada\s?pav\b|\bbhel\b|\btandoori\b|\bkorma\b|\blassi\b|\bsushi\b|\bramen\b|\btacos?\b|\bburritos?\b|\bmeals?\b|\bdinner\b|\blunch\b|\bbreakfast\b|\bsnacks?\b|\bdesserts?\b|\bchickens?\b|\bmutton\b|\bgulab\s?jamuns?\b|\brasmalai\b|\bkheer\b|\bhalwa\b|\bbarfi\b|\bladoos?\b|\bmithai\b|\bpuris?\b|\bbhature?\b|\bchana\b|\bkulchas?\b|\bpulao\b|\bnuggets?\b|\bwings?\b|\bfalafel\b|\bhummus\b|\bshakes?\b|\bsmoothies?\b|\btakeaway\b|\bdelivery\b/i,
    // Naming a general retailer means this is not a food order, whatever else the sentence contains.
    not: /\b(?:amazon|flipkart|myntra|ajio|meesho|nykaa|ebay|etsy|croma|reliance\s?digital)\b/i,
    slots: {
      item: g => stripNoise(g, /\b(?:order|buy|get)\s+me\b|\b(?:order|buy|get)\b|\bfrom\s+(?:swiggy|zomato|dominos?|uber\s?eats)\b/gi),
      // /search, NOT the bare domain. swiggy.com serves a promotional landing page whose only input
      // is the address field; swiggy.com/search serves the one with the actual search box. Verified
      // by driving both.
      search_url: g => /zomato/i.test(g) ? 'https://www.zomato.com' : 'https://www.swiggy.com/search',
      service: g => /zomato/i.test(g) ? 'https://www.zomato.com' : 'https://www.swiggy.com',
      // THE DISH SEARCH, AS A URL. The four steps this replaces were: list the input fields, fill
      // the box, list again because typing creates new elements, then click "See all results" —
      // four model turns to reach a page the site will serve directly. Measured, that sequence
      // stalled at "2 of 9 done and then stopped making progress" on a plain "order oranges". The
      // template comes from config/ordering.json through a resolver, so the URLs still live in one
      // place.
      dish_url: g => {
        const dish = stripNoise(g, /\b(?:order|buy|get)\s+me\b|\b(?:order|buy|get)\b|\bfrom\s+(?:swiggy|zomato|dominos?|uber\s?eats)\b/gi);
        const site = /zomato/i.test(g) ? 'zomato' : 'swiggy';
        try { return deps.orderSearchUrl ? deps.orderSearchUrl(dish, site) : ''; } catch (e) { return ''; }
      },
    },
    steps: [
      // Discovered by driving the real site: swiggy.com/search lands on the home page, which DOES
      // carry the search box. Landing there and merely listing the page — which is what this used to
      // do — shows a wall of nearby restaurants and never searches for anything.
      // Determined the instant the site is known, so it RUNS rather than being described to a 3B.
      // This is the busiest procedure in the file and its first step was the one most often skipped.
      // TWO DETERMINED STEPS, THEN HIS CHOICE — the same shape the shop lane needed, for the same
      // reason. Nine described steps is nine chances for a 3B to stop proposing, and it took two:
      // "Opening swiggy.com/search … [8] text — Search for restaurants and food. That is only part
      // of it, Sir — I got 2 of 9 done." It had reached the search box and could not use it.
      //
      // The site serves the results directly, so the form fill and the three element listings around
      // it are not work the model needs to do at all. What is left that genuinely needs judgment —
      // which restaurant, which dish — is his to pick, and picking is one turn, not four.
      { do: 'browser_go to {dish_url} — the dish search on the delivery site itself. He is already signed in and his address is set; do not touch either.',
        run: { tool: 'browser_go', args: { url: '{dish_url}' } } },
      { do: 'browser_page to read the results back.',
        run: { tool: 'browser_page', args: {} } },
      'Tell him the restaurants and dishes you can actually see, with prices where they are shown, and ask WHICH ONE to order. Do not choose for him and do not add anything yet — the add is one step once he has named it.',
      BUYING_STOPS_AT_BASKET,
    ],
    done: 'the item is in the basket and he has been told what it costs',
    stopsAtBasket: true, always: true, tools: BROWSER_TOOLS,
  },
  {
    id: 'shop-add-to-cart',
    title: 'add something to a shopping basket (stops at the basket)',
    // The mirror of order-food's: a food platform means this is not a general shopping trip.
    not: /\b(?:swiggy|zomato|uber\s?eats)\b/i,
    // "from amazon" has to go as a PHRASE. Stripping the retailer name alone left "hiking boots
    // from" and that trailing preposition was searched verbatim — the same class of bug as "actually
    // lets that". Prepositions are only noise when the thing they point at is also noise.
    slots: {
      item: g => stripNoise(g, /\b(?:buy|order|add)\s+me\b|\b(?:buy|order|add)\b|\bto\s+(?:my\s+)?(?:cart|basket)\b|\b(?:from|on|at)\s+(?:amazon|flipkart|myntra|ajio|meesho|nykaa|ebay|etsy|croma)\b|\bamazon\b|\bflipkart\b/gi),
      // THE SHOP'S OWN SEARCH URL, COMPUTED — not described to a model and hoped for.
      //
      // Step one used to read "browser_go to the shop he named (Amazon unless he said otherwise)",
      // which lands on the HOMEPAGE. The 3B then reached for browser_elements, enumerated the
      // navigation, and stopped: measured as "Opening https://www.amazon.com — [14] a Hello, sign in
      // … I got 2 of 5 done and then stopped making progress", and identically on Myntra at 1 of 5.
      // Nothing was ever searched, on either site.
      //
      // The sibling lane already learned this. search-and-open-result carries the note "Determined
      // the moment the query is known — so it RUNS, rather than being described to a 3B that opens
      // with browser_elements and enumerates the previous tab", and order-food goes straight to a
      // results URL for the same reason. This lane was left behind.
      //
      // The templates are already in config/sites.json and reached through the same searchUrl() the
      // rest of the system uses, so this adds no second table to keep in step: amazon becomes
      // /s?k=<item>, flipkart /search?q=<item>, myntra /<item>.
      shop_url: g => {
        const item = stripNoise(g, /\b(?:buy|order|add)\s+me\b|\b(?:buy|order|add)\b|\bto\s+(?:my\s+)?(?:cart|basket)\b|\b(?:from|on|at)\s+(?:amazon|flipkart|myntra|ajio|meesho|nykaa|ebay|etsy|croma)\b|\bamazon\b|\bflipkart\b/gi);
        const named = (g.match(/\b(?:from|on|at)\s+([a-z]+)\b/i) || [])[1] || 'amazon';
        const key = (deps.siteKey && deps.siteKey(named)) || 'amazon';
        try { return deps.searchUrl ? deps.searchUrl(item, key) : ''; } catch (e) { return ''; }
      },
    },
    steps: [
      // TWO DETERMINED STEPS, THEN HIS CHOICE — because three attempts at letting the model drive
      // this failed three different ways on the same request:
      //
      //   kind "link"    -> the add control is <input type=submit>, so the list was prices and
      //                     navigation and it clicked "₹549 ₹549 M.R.P…"
      //   kind "button"  -> the right controls appeared ([61] submit — Add to cart) and the model
      //                     then proposed nothing further; the run ended having found the button
      //   free rein      -> three browser_elements calls in a row on the same query, no click at all
      //
      // Every one of them reported "I got N of 5 done". The pattern is not which words the step
      // uses: it is that picking a product and pressing its control takes several model turns, and a
      // 3B does not reliably carry an index or a plan across them. That is the constraint this
      // entire file is written around, and the honest response is to do the part that IS
      // deterministic and hand him the part that is not.
      //
      // So: go to the shop's own search results (never fails — a computed URL), read the page back,
      // and ASK which one. Naming an item afterwards is a single labelled click, which is one turn
      // and cannot drift. A reliable "here is what it found, say which" beats an unreliable attempt
      // that ends with a price clicked and a basket untouched.
      { do: 'browser_go to {shop_url} — the shop\u2019s own SEARCH results for the item, not its home page. Computed here, so it runs rather than being described.',
        run: { tool: 'browser_go', args: { url: '{shop_url}' } } },
      { do: 'browser_page to read the results back so he can see what is actually there.',
        run: { tool: 'browser_page', args: {} } },
      'Tell him the top few products you can see with their prices, and ask WHICH ONE to add. Do not pick for him and do not click anything yet: naming the item is his, and the add is one labelled click once he has said which.',
      BUYING_STOPS_AT_BASKET,
    ],
    done: 'the item is in the basket and he has seen the total',
    stopsAtBasket: true, always: true, tools: BROWSER_TOOLS,
  },
  // ---- groceries ----
  //
  // ORANGES ARE A FRUIT. THEY ARE NOT A RESTAURANT ORDER AND THEY ARE NOT AN AMAZON PARCEL.
  //
  // This lane did not exist, and its absence produced the worst answer in the whole ordering story:
  // "buy me oranges" was asked whether it meant food or a product, and "food" sent it to Swiggy to
  // look for restaurants. Before that it went to Amazon. Before that it was told, by me, that
  // groceries could not be ordered at all — while config/ordering.json has carried a complete
  // Blinkit recipe the entire time: a search URL, a cart selector, a dialog shape. The capability
  // was there and nothing routed to it.
  //
  // Same two determined steps as the food and shop lanes, for the same measured reason: a described
  // multi-step browser run stalls partway and reports "N of 9 done". The site serves its results by
  // URL, so the search is a computed address, the page is read back, and choosing among what is
  // actually on the shelf is his.
  {
    id: 'grocery-add-to-cart',
    title: 'get groceries from a quick-commerce service (stops at the basket)',
    // The services by name, and the staples people ask for by name. The open-ended half — every
    // fruit, spice and brand nobody thought of — is answered by the item classifier in server.js,
    // which embeds the word instead of matching it, so this list does not have to be complete and
    // is not the thing that decides.
    // NO FRUIT LIST. The first version of this named oranges, apples and bananas and was beaten by
    // the first fruit nobody thought of: "buy me a watermelon" scored nothing here, so
    // shop-add-to-cart took it on the bare verb and opened AMAZON — while the item classifier,
    // sitting right there, answered "grocery" for watermelon, grapes and mangoes alike. I built an
    // embedder precisely so this file would not need a list of every edible thing, then wrote the
    // list anyway and disconnected the thing that made it unnecessary.
    //
    // So the `must` is the VERB, exactly like shop-add-to-cart's, and WHICH consumable lane a
    // request belongs to is decided upstream by the classifier — which generalises to words no list
    // contains. This lane is declared after shop, so with no arbitration to guide it a tie still
    // falls to shop exactly as it did before this lane existed.
    // A restaurant platform or a general retailer in the sentence means he named where he wants it
    // from, and it is not this.
    not: /\b(?:swiggy(?!\s*instamart)|zomato|uber\s?eats|dominos?|amazon|flipkart|myntra|ajio|nykaa|croma)\b/i,
    slots: {
      item: g => stripNoise(g, /\b(?:order|buy|get|add)\s+me\b|\b(?:order|buy|get|add)\b|\bto\s+(?:my\s+)?(?:cart|basket)\b|\b(?:from|on|at)\s+(?:instamart|blinkit|zepto|big\s?basket|jiomart|dunzo)\b/gi),
      grocery_url: g => {
        let item = stripNoise(g, /\b(?:order|buy|get|add)\s+me\b|\b(?:order|buy|get|add)\b|\bto\s+(?:my\s+)?(?:cart|basket)\b|\b(?:from|on|at)\s+(?:instamart|blinkit|zepto|big\s?basket|jiomart|dunzo)\b/gi);
        // "some mangoes" is not a product name — a quantifier left on the front goes into the query
        // and searches the shelf for it.
        item = String(item).replace(/^(?:some|a|an|the|any|few|couple\s+of)\s+/i, '').trim();
        try { return deps.orderSearchUrl ? deps.orderSearchUrl(item, 'blinkit') : ''; } catch (e) { return ''; }
      },
    },
    steps: [
      { do: 'browser_go to {grocery_url} — the quick-commerce search for the item. He is already signed in and his address is set; do not touch either.',
        run: { tool: 'browser_go', args: { url: '{grocery_url}' } } },
      { do: 'browser_page to read the shelf back.',
        run: { tool: 'browser_page', args: {} } },
      'Tell him the products you can actually see with their sizes and prices, and ask WHICH ONE to add. Do not choose for him: a kilo and a single piece are different orders, and so are two brands at the same price.',
      BUYING_STOPS_AT_BASKET,
    ],
    done: 'he has seen what is on the shelf and said which one',
    stopsAtBasket: true, always: true, tools: BROWSER_TOOLS,
  },
  // ---- web ----
  {
    id: 'search-and-open-result',
    title: 'search the web and open a result',
    // THE TARGET BETWEEN THE VERB AND "FOR" USED TO SURVIVE INTO THE QUERY.
    //
    // `search(?:\s+for)?` only strips "for" when it sits directly after "search". In "search the web
    // for X" it does not, so "search" went and "the web for" stayed — and after the article strip the
    // query was "web for X". That went into the DuckDuckGo URL *and* into the browser_elements
    // ranking terms, on the single most natural phrasing of the request.
    //
    // Measured on the 2026-09-05 eval: "search the web for the eiffel tower height and open the first
    // result" searched for "web for eiffel tower height". The sibling wikipedia task already asserts
    // this exact bug class ("no leftover 'it for' from the sentence"); this lane leaked it untested.
    // AND THE STRIP LEFT THE REST OF THE SENTENCE IN THE QUERY. Reported live, twice on one run:
    //
    //   ◆ open wikipedia and search it for the eiffel tower
    //     → duckduckgo.com/?q=open wikipedia and it for eiffel tower
    //   ◆ follow the iana link on example.com
    //     → duckduckgo.com/?q=follow iana link on example.com     (then 15 minutes on that page)
    //
    // Both are the same defect. The query was built SUBTRACTIVELY — delete the words somebody wrote
    // down, ship whatever survives — so a sentence containing none of those words became its own
    // search query in full, and one containing some of them became a mangled fragment. That is a
    // keyword trap with the polarity reversed: instead of failing to match, it matches everything
    // and quietly keeps the parts nobody anticipated.
    //
    // The parser already extracts search targets properly, so it is ASKED instead. `searchTarget`
    // returns the target and the site for a request that is a search, and null for one that is not
    // — and null is what stops this lane claiming "follow the iana link on example.com" at all.
    // Measured over this region's own exemplars: all 13 search goals yield a target, all 4 of the
    // page-manipulation goals yield null.
    slots: {
      query: g => webSearchQuery(g),
      // The site the request named, so "open wikipedia and search it for X" searches Wikipedia
      // rather than DuckDuckGo. Falls back to DuckDuckGo when no site was named, which is every
      // goal this lane handled before.
      search_url: g => webSearchUrl(g),
    },
    // A SEARCH LANE WITH NOTHING TO SEARCH FOR MUST NOT CLAIM THE GOAL. The invariant already
    // existed in match(); this lane simply never declared its contract, and an empty query was
    // impossible anyway while the slot was a subtractive strip.
    requires: ['query'],
    steps: [
      // Determined the moment the query is known — so it RUNS, rather than being described to a 3B
      // that opens with browser_elements and enumerates the previous tab.
      { do: 'browser_go to {search_url}',
        run: { tool: 'browser_go', args: { url: '{search_url}' } } },
      'browser_elements with q "{query}" to rank the results above the page furniture.',
      'browser_click the first real RESULT link — skip adverts, "sponsored" rows and the site\'s own navigation.',
      'If none of the shortlist is a result, browser_elements again with more:true and the same q.',
      'browser_page to confirm where it landed.',
    ],
    done: 'the first genuine result is open',
    tools: BROWSER_TOOLS,
  },
  {
    id: 'fill-a-form',
    title: 'fill in a form on the current page',
    slots: {},
    steps: [
      'browser_elements FIRST — browser_fill takes the number from that list, and guessing a number types into the wrong field.',
      'browser_fill each field in turn.',
      'browser_page to read the form back before submitting.',
      'browser_submit only after he has confirmed. Never enter passwords, card numbers or one-time codes — refuse those and say why.',
    ],
    done: 'the form holds the right values',
  },
  // ---- files ----
  {
    id: 'files-make-many',
    title: 'create several files or folders',
    // THESE STEPS ARE NOT A COUNT OF THE JOB. One applies only sometimes and the others repeat per
    // file, so "done 1 of 3" is not a measure of anything: a finished one-folder run was reported as
    // "I got 1 of 3 done and then stopped making progress". What he named is checked by name instead
    // (harness.missingArtifacts).
    stepsVary: true,
    slots: {},
    steps: [
      'create_folder first if the goal names a folder to put things in.',
      'create_file once PER FILE, with its own path and its own content. Do not stop after the first one.',
      'read each file back to confirm it landed.',
    ],
    done: 'every file the goal named exists with the right contents',
  },
  {
    id: 'files-organise',
    title: 'tidy or sort files',
    stepsVary: true,             // per category and per file — see files-make-many
    slots: {},
    steps: [
      'list the folder first — never move anything you have not looked at.',
      'create_folder for each category you are going to use.',
      'move files one at a time into them.',
      'list again at the end to show what changed.',
    ],
    done: 'the folder is sorted and he has been shown the result',
    always: true,
  },
  // ---- comms: drafts only ----
  {
    id: 'message-someone',
    title: 'message a person',
    // A one-call lane already does this. The procedure is the fallback for when that lane
    // cannot (an unusual phrasing, an app that will not quit), so it must not claim the loop
    // for the ordinary case — see isProcedural.
    fallbackOnly: true,
    slots: {},
    steps: [
      'find_contact FIRST. A recipient that did not come from Contacts is an invented one, and messaging a stranger is the failure that matters here.',
      // 2026-10-10 casual dev run: "ping yuvan on whatsapp asking about the maths hw" ran find_contact → compose and STOPPED
      // ("Found Yuvan. Drafted.") — the old lines said "show him the draft" without naming the tool that does it, so the draft
      // was never shown or offered. send_message is that tool: it asks first (needsConfirm) and sends only after his yes.
      'compose the message (kind "message", the contact as recipient) — never write the words inline.',
      'send_message with the composed text. It does NOT send by itself: it shows him the draft and who it is going to, and waits for his yes. Stopping after compose leaves a draft he never sees.',
    ],
    done: 'the draft was shown and he approved it',
  },
  // ---- system ----
  {
    id: 'close-an-app',
    title: 'quit an application',
    // A one-call lane already does this. The procedure is the fallback for when that lane
    // cannot (an unusual phrasing, an app that will not quit), so it must not claim the loop
    // for the ordinary case — see isProcedural.
    fallbackOnly: true,
    slots: {},
    steps: [
      'list_running first if you are not certain of the exact name.',
      'close_app, and confirm when asked.',
      'list_running again — an app with unsaved work stays open behind a save sheet, and reporting a close that did not happen is worse than failing.',
    ],
    done: 'the app is genuinely gone from the running list',
  },
  {
    id: 'research-a-topic',
    title: 'research something and report back',
    slots: { topic: g => stripNoise(g, /\b(?:do\s+some\s+)?research\b|\bfind\s+out\b|\bread\s+up\b|\blook\s+into\b|\babout\b/gi) },
    steps: [
      'Use the research tool rather than the browser — it reads several sources and cites them.',
      'Report what it found with the sources, and say plainly if the sources disagree or are thin.',
    ],
    done: 'he has an answer with sources',
  },
  // ---- local businesses (businessfinder.js) ----
  // 2026-10-09, his live turn: "Okay find businesses in my locality without a website and provide me their phone
  // numbers" had no procedure, so the loop offered to be taught, then ran ONE Safari search and called it done — while
  // businessfinder.js (OpenStreetMap + Google Maps in his Brave + a web search per place) sat unwired since 10-01.
  {
    id: 'find-businesses',
    title: 'find local businesses (their numbers, or the ones without a website)',
    slots: {},
    // READ-ONLY (2026-10-14): it reads maps and the web and writes only its own results file — nothing is sent,
    // opened, closed or bought. These are the tools it may use when the reader read "nothing to do" (server.js):
    // the veto lets such a procedure through, walled to exactly this list.
    readOnly: ['find_businesses'],
    // ONCE (2026-10-15): one call answers the request; the loop ends on its result rather than let the planner call it again.
    once: ['find_businesses'],
    steps: [
      'Call find_businesses ONCE. what = the kind of business he named, or leave it out if he named none. where = the ' +
        'place he named, or leave it out when he means around himself. withoutWebsite = true if he wants the ones without ' +
        'a website. needPhone = true if he wants only ones with a number.',
      'Reply with what it returned — the names, the numbers, which were checked, and the file it saved. Never add a ' +
        'business or a number it did not return.',
    ],
    done: 'find_businesses has returned and its list is in front of him',
  },
];

// Strip the instruction words out of a goal, leaving the thing it is ABOUT. Deliberately crude: the
// slot only has to be good enough for a search box, and over-clever extraction that silently drops
// half a title is worse than a slightly noisy query.
function stripNoise(goal, re) {
  return String(goal || '')
    // Curly apostrophes first. The character class below keeps a STRAIGHT apostrophe and discards
    // everything else it does not name, so a typographic one — which is what macOS substitutes as
    // you type, and what arrives from a phone — was turned into a SPACE. "yessmartypie's latest
    // video" became the query "yessmartypie s", which matches no channel, and the lane went on to
    // play the top result for it and say so. The same word, typed with the same key, resolved or
    // did not depending on which quote character the keyboard produced.
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(re, ' ')
    .replace(/\b(?:please|for me|can you|could you|jarvis|the|a|an|my)\b/gi, ' ')
    .replace(/[^\w\s'&.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// THE FOLLOW-UP CLAUSE IS NOT PART OF THE QUERY. "search X and open the first result" asks for one
// thing, and this lane's own steps ALWAYS open the first result — so the tail is redundant by
// construction rather than by vocabulary. Anchored to a trailing coordinate clause, and what it
// costs when it misses one is a couple of extra words in a query, never a wrong action.
const FOLLOWUP_TAIL_RE = /\s+and\s+(?:then\s+)?\w+\s+(?:on\s+)?(?:the\s+)?(?:first|top|1st)\b.*$/i;

// WHAT IS BEING SEARCHED FOR — asked of the parser, not left over from deleting words.
//
// Returns '' when the request is not a search, which combined with `requires: ['query']` is what
// makes this lane decline a goal it cannot serve rather than searching the sentence itself.
function webSearchQuery(goal) {
  const g = String(goal || '');
  // Without the parser injected (a suite that inits playbook bare) this falls back to the old
  // behaviour rather than declining everything — a missing dependency must not silently disable a
  // lane.
  if (typeof deps.searchTarget !== 'function') return legacyQuery(g);
  let a = null;
  try { a = deps.searchTarget(g); } catch (e) { return ''; }
  if (!a) return '';                               // not a search — do not claim it
  // The extracted target still goes through the SAME tidying the old query did — curly apostrophes,
  // articles, politeness, stray punctuation — so what reaches DuckDuckGo is shaped exactly as
  // before. Only the way the words are CHOSEN changed: taken out of the request rather than left
  // behind by it. `/(?!)/` is a regex that matches nothing, so no lane-specific deletion happens.
  const target = stripNoise(String(a.target || '').replace(FOLLOWUP_TAIL_RE, ''), /(?!)/);
  // The parser recognises the SHAPE of some searches without isolating the term ("find a recipe for
  // butter chicken and open the first result" comes back as a search with an empty target). The
  // request is still a search, so the lane still owns it — the old strip fills in the query.
  return target || legacyQuery(g);
}
const legacyQuery = g => stripNoise(g, /\b(?:google|search|look\s+up)(?:\s+(?:the\s+)?(?:web|internet|online))?(?:\s+for)?\b|\band\s+(?:click|open).*$|\bthe\s+first\s+result\b/gi);

// Where to run it. A named site searches that site; everything else goes to DuckDuckGo, which is
// where every goal this lane served went before.
function webSearchUrl(goal) {
  const q = webSearchQuery(goal);
  if (!q) return '';
  let site = null;
  try { const a = deps.searchTarget && deps.searchTarget(goal); site = a && a.site; } catch (e) {}
  if (site && typeof deps.searchUrl === 'function') {
    try { const u = deps.searchUrl(q, site); if (u) return u; } catch (e) {}
  }
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
// Scored rather than first-match: several procedures legitimately overlap ("search youtube" is both
// a YouTube job and a search job), and the one with the most corroborating signals should win.
// A procedure whose `must` is absent scores nothing at all — that hard gate is what keeps the
// pizza recipe away from "order my thoughts" and the YouTube one away from "play some music".
// ---------------------------------------------------------------------------
// WHICH PROCEDURE IS THIS? — asked of an embedding model, not of a keyword table.
//
// WHAT WAS HERE BEFORE. Every playbook carried a `must` regex and a list of `when` regexes, and the
// score was "must matched" plus one per `when`. That is a keyword table, and it failed the way
// keyword tables always fail here — on the phrasing nobody wrote down:
//
//   "play judas"                          scored 0. No spotify, no song, no music, no "by <artist>".
//                                         Reported live: it opened a Spotify search page and sat there.
//   "crank up spotify and search ar rahman"  no match: `open|launch|fire up` did not include "crank up".
//   "ring mama on whatsapp"               no match: CALL_RE lists `call`, not `ring`.
//
// Every one of those was patched at some point by adding another word, and the next phrasing broke
// it again. The object of a request is an open class — song titles, channel names, dish names — and
// so, in practice, is the verb: play / put on / throw on / blast / stick on all mean the same thing.
//
// WHY EXEMPLARS ARE NOT A WORD LIST. Nothing below is ever matched literally. Each list stands in
// for a REGION of intent space; the goal is embedded and compared to the centroid of each region.
// "blast judas" is nowhere in the spotify list and lands next to it anyway, which is the entire
// point and the exact thing a regex cannot do. This is the pattern itemclass.js already uses to
// decide grocery-vs-marketplace at 94.9%, applied one level up — to the intent instead of the item.
//
// THE `none` CLASS IS LOAD-BEARING. With thirteen procedures and no null option, every sentence
// lands nearest to SOMETHING, and "what is the weather" would be routed as a shopping trip. `none`
// is a region too: chat, questions, statements, and the small talk this system spends most of its
// day on. A goal whose nearest region is `none` is not procedural.
//
// IT ABSTAINS. Below MIN_MARGIN the two nearest regions are close enough that the answer is a coin
// flip, and the request goes to the agent loop to be worked out rather than to a confidently wrong
// procedure. Same reasoning, same threshold shape, as itemclass.
const EXEMPLARS = {
  'youtube-latest-from-channel': [
    'play the latest video from mrbeast', 'watch yessmartypie newest upload',
    'put on the most recent video from that channel', 'open the newest linus tech tips video',
    'play his latest video on youtube', 'show me the last thing veritasium posted',
  ],
  'youtube-search-and-open': [
    'search youtube for lofi beats and play one', 'find a video about sourdough on youtube',
    'look up a tutorial for react hooks on youtube', 'open a youtube video about the eiffel tower',
    'watch something about black holes on youtube',
    // "search X and click the first result" is this procedure, not the channel one. Without these it
    // sat 0.052 from youtube-latest-from-channel, which is a coin flip between two adjacent regions.
    'open youtube and search yessmartypie and click on the first result',
    'go to youtube, search for mrbeast and open the top result',
    'search youtube for lofi beats and open the first one',
    'find react hooks on youtube and click the first video',
    // A CHANNEL NAME IN THE QUERY DOES NOT MAKE IT THE CHANNEL PROCEDURE. "search youtube for
    // mrbeast and click the first result" sat 0.045 between the two — the creator's name pulled
    // toward latest-from-channel while the sentence plainly says search-then-click. What separates
    // them is "search … and click/open the first result", whatever the query happens to name.
    'search youtube for mrbeast and click the first result',
    'search youtube for veritasium and open the first video',
  ],
  'spotify-play': [
    'play judas', 'blast some lady gaga', 'put on bohemian rhapsody',
    'throw on my discover weekly', 'play some music', 'stick on an album by radiohead',
    'play the song judas by lady gaga', 'start my liked songs', 'play ar rahman',
  ],
  'order-food': [
    'order me a pizza', 'get samosas from swiggy', 'i want biryani delivered',
    'order dinner from dominos', 'get me some butter chicken', 'order food',
  ],
  'shop-add-to-cart': [
    'buy me a phone charger', 'add hiking boots to my amazon cart', 'order a keyboard from amazon',
    'get me a new mouse', 'buy airpods', 'add a desk lamp to the basket',
  ],
  'grocery-add-to-cart': [
    'order a watermelon', 'get milk and eggs from blinkit', 'buy bananas',
    'add cat food to the basket', 'get me some coffee beans', 'order groceries',
  ],
  // ONE PROCEDURE, TWO REGIONS. See GROUPS below — both of these answer `search-and-open-result`.
  //
  // They used to be one list, and it had become a junk drawer: rust, the weather, tigers, pizza,
  // flights, a playstation, a laptop and a recipe averaged into a centroid that meant nothing in
  // particular and therefore pulled weakly. What that cost was measured, and it was not subtle —
  // this region lost its OWN exemplar:
  //
  //     "find a recipe for butter chicken and open the first result"
  //         → order-food   sim 0.485, margin 0.056        (a recipe search became a food order)
  //
  // Six tight food exemplars beat eleven scattered search ones on a sentence copied verbatim out of
  // the search list. Adding a twelfth would have made the drawer worse, not better: the repair for a
  // weak centroid is never more variety poured into it.
  'search-a-fact': [
    'search the web for the eiffel tower height', 'look up rust on brave',
    'google the weather in delhi', 'find me the wikipedia page for tigers',
    'search him up on brave', 'look up jensen huang',
  ],
  // THE OBJECT MUST NOT OUTVOTE THE ACTION. Measured: "google the best pizza in nagpur and open
  // the first one" landed on order-food, and "search online for cheap flights and click the first
  // result" on shop-add-to-cart — the content words (pizza, flights) pulled harder than the thing
  // actually being asked for, which is a web search whose first result gets opened. These belong
  // together because they share an ACTION, and keeping them apart from the plain lookups above is
  // what lets each centroid stand for one thing.
  'search-then-open': [
    'google the best pizza in nagpur and open the first one',
    'search online for cheap flights and click the first result',
    'look up the price of a playstation and open the top link',
    'search for the best laptop under 50000 and open the first article',
    'find a recipe for butter chicken and open the first result',
  ],
  'fill-a-form': [
    'fill in this form', 'complete the signup form on this page',
    'enter my details in the form', 'fill out the contact form',
  ],
  'files-make-many': [
    'create three folders on my desktop', 'make five text files in documents',
    'create a folder called work and a file inside it', 'make me some empty files',
  ],
  'files-organise': [
    'tidy up my downloads folder', 'sort the files on my desktop by type',
    'organise my documents', 'clean up the screenshots folder',
  ],
  'message-someone': [
    'message mama on whatsapp', 'text kunal that i am running late',
    'send a whatsapp to dad asking about dinner', 'ring mama on whatsapp',
    'whatsapp my brother saying happy birthday',
  ],
  'close-an-app': [
    'close spotify', 'quit textedit', 'shut down the calculator',
    'close it', 'kill safari',
  ],
  'research-a-topic': [
    'research the history of the printing press', 'find out everything about lithium batteries',
    'read up on the ottoman empire and tell me', 'do some digging on quantum computing',
  ],
  // Written AFTER sweeps/sweep_playbook_business.js's held-out goals (2026-10-09), none copied from it. English and
  // Hinglish both, so Hindi does not pile up in one region (see the note on languages in feedback).
  'find-businesses': [
    'find shops near me that do not have a website', 'list cafes in sector 70 with their phone numbers',
    'get me the numbers of salons around here', 'which restaurants in wakad have no website',
    'businesses near my house without a website', 'find potential clients nearby who need a website',
    'mere area ki dukaanon ke phone number nikaal do', 'bina website wale local business dhoondo',
  ],
  // NOT a procedure — FOUR regions, all grouped as `none`. Same reasoning as the search split above,
  // and the same measurement behind it. As one list this was the biggest junk drawer in the file:
  // the weather, arithmetic, a favourite colour, nine bare app opens, the battery and "thanks" all
  // averaged into a single centroid, and a sentence belonging to no procedure at all had nothing
  // coherent to land on. It lost to whichever real region happened to share a turn of phrase:
  //
  //     "archive the oldest thread on example.com"  → youtube-latest-from-channel  (his screenshot)
  //     "follow the iana link on example.com"       → search-and-open-result
  //     "launch the calculator"                     → close-an-app
  //
  // Every exemplar that was in `none` is still here, redistributed, not rewritten.
  // TALK ABOUT BUSINESSES IS NOT FINDING THEM. Added 2026-10-09 with find-businesses: on its held-out set 1 that region
  // took "make a website for my business" (0.153) and "how many shops are there in india" (0.132) — the nouns business /
  // website / shop pulled harder than the action, and nothing on the `none` side covered business talk at all. A missing
  // region, not a threshold: no margin separated them (the lowest right take was 0.083). Confirmed on a fresh set 2.
  'none-business-talk': [
    'how do i get more customers for my shop', 'design a logo for my cafe', 'write a business plan for a bakery',
    'is a clothing store a good business', 'tips to market a small business on instagram', 'how big is the restaurant market',
  ],
  'none-chat': [
    'what is the weather', 'who is the ceo of nvidia', 'how are you today',
    'what is 17 times 23', 'tell me a joke', 'what is rust', 'i am bored', 'thanks',
  ],
  // BARE "open <thing>" IS A ONE-CALL ACTION, NOT A PROCEDURE. "open spotify" landed on
  // spotify-play at margin 0.059 and the loop duly played a random track instead of opening the
  // app. Opening something and doing something inside it are different requests.
  'none-open-app': [
    'open spotify', 'launch spotify', 'open youtube', 'open netflix', 'open brave',
    'open the calculator', 'launch textedit', 'go to twitter', 'open my email',
  ],
  'none-personal': [
    'my favourite colour is teal', 'what did i decide about the trip',
    'remember that i like mountains', 'what is on my calendar',
    'how much battery do i have', 'what time is it in tokyo', 'who is yessmartypie',
  ],
  // ACTING ON ONE ITEM OF A PAGE IS NOT A PROCEDURE THIS FILE HAS — it is exactly what the agent
  // loop is for, so the honest answer is `none` and the loop works it out with the page in front of
  // it. This region did not exist, and that absence is what sent "archive the oldest thread on
  // example.com" to the YouTube channel procedure: both sentences are "<verb> the <superlative>
  // <thing> on <name>", and only one of them had a region.
  //
  // Both shapes are listed on purpose — the item named on THIS page, and the item named on a site
  // said out loud. Half the region was the bug: the named-site form had nowhere to land.
  'none-page-action': [
    'delete the top comment on this page', 'mark the first email as read',
    'expand the third comment', 'collapse the left sidebar',
    'star the newest message in the list', 'hide the second row of the table',
    'bookmark the last item on hackernews', 'report the first review on yelp',
  ],
};

// WHICH REGIONS MEAN THE SAME THING TO THIS CALLER. A region is a shape of sentence; a group is a
// decision. Splitting a weak centroid into coherent ones would be self-defeating without this —
// the two halves would sit next to each other and silence one another through the margin, which is
// a margin about nothing. `groups` makes the runner-up the best region OUTSIDE the winner's group,
// so the margin still measures the thing that matters: is this a search, or is it a food order?
//
// Every region not named here is its own group, which is the behaviour that existed before.
const GROUPS = {
  'search-a-fact': 'search-and-open-result',
  'search-then-open': 'search-and-open-result',
  'none-chat': 'none',
  'none-open-app': 'none',
  'none-personal': 'none',
  'none-page-action': 'none',
  'none-business-talk': 'none',
};

// The classifier itself lives in intent.js — shared with the deterministic-plan shapes in agent.js
// and, in the same shape, with itemclass.js. Only the exemplars and the threshold belong here.
const intent = require('./intent.js');

// CHOSEN BY SWEEP, not guessed. Across 38 goals — the phrasings the old keyword table got wrong,
// the ones it got right, and things that must not be procedures at all:
//
//   0.02   36/38   2 wrong        <- itemclass's threshold, too permissive one level up
//   0.05   37/38   1 wrong  0 missed   <- flat from 0.04 to 0.06
//   0.10   34/38   1 wrong  3 missed   <- now costing real matches
//
// The lowest margin among CORRECT matches is 0.070 and the highest among wrong ones is 0.026
// ("unsubscribe to Mythpat on youtube", which is not a procedure this system has at all). 0.05 sits
// between them with room on both sides. Intent is a harder call than grocery-vs-marketplace, so it
// needs more daylight than itemclass does — measured, not assumed.
//
// RE-SWEPT when the regions were split, on 81 held-out goals written for the purpose (47 designed
// against, 34 more written before the page-action region existed and never tuned against):
//
//   margin   correct  wrong  missed          before the split, same 81 goals
//     0.03     67       10     4                 64 / 14 / 3
//     0.05     68        7     6                 64 / 12 / 5      <- peak, both layouts
//     0.07     66        4    11                 63 /  8 / 10
//
// The threshold did not move for the split, and that was the point of re-sweeping rather than
// assuming: the split was supposed to fix the regions, not to be paid for with a threshold change.
// A `missed` reaches the agent loop; a `wrong` opens Swiggy — so the trade above the peak is not as
// good as the raw counts make it look.
//
// IT MOVED FOR THE EMBEDDER. all-minilm was replaced by nomic-embed-text on 2026-09-12, and a
// threshold is a property of the EMBEDDING SPACE, not of the task — nomic's margins are about half
// as wide (median correct margin 0.099 -> 0.058 under leave-one-out), so 0.05 in the new space is
// roughly 0.09 in the old one and would have silenced the classifier. Re-swept the same way, margin
// chosen on the 47-goal dev half and reported on the 34 never tuned against:
//
//              dev margin   confirm(34)   wrong   missed        all 81
//   all-minilm    0.050        28/34        3       3        68/81, 7 wrong
//   nomic         0.035        31/34        0       3        74/81, 0 wrong
//
// Leave-one-out over the exemplars agrees independently, suggesting 0.040 — and 0.040 is what
// shipped, because two goals sit INVERTED across 0.035 and the suite is right about both:
//
//     "crank up spotify and search for ar rahman"   spotify-play  margin 0.0347   should fire
//     "unsubscribe to Mythpat on youtube"           yt-search     margin 0.0370   should NOT
//
// No threshold separates them: the one that must be refused scores HIGHER than the one that must
// fire. So the choice is which error to take, and it is not close. Claiming "unsubscribe" is a
// wrong action on a procedure this system does not have — it is the goal that replayed a taught
// procedure at 0.02 and the one the teach-offer path exists for. Losing "crank up spotify" is a
// MISS: it goes to the agent loop, which opens Spotify and searches. One costs him an explanation,
// the other costs him a wrong action.
//
// KNOWN AND UNFIXED, rather than tuned away: the honest repair is a region that covers account
// actions on a site ("unsubscribe", "unfollow"), not an exemplar bolted onto spotify-play to lift
// one sentence over the bar. That would be fitting the test set, and it is what §0 of the brief
// forbids.
const MIN_MARGIN = 0.04;

// Built lazily so it picks up deps.jlog from init() rather than the no-op default.
let _classify = null;
function classifier() {
  if (!_classify) {
    _classify = intent.makeClassifier({
      exemplars: EXEMPLARS, minMargin: MIN_MARGIN, none: 'none', groups: GROUPS,
      label: 'Playbook', jlog: m => deps.jlog(m),
    });
  }
  return _classify;
}

// Returns { id, sim, margin } for a real procedure, or null for "not one of these / too close to say".
async function semanticMatch(goal) { return classifier()(String(goal || '')); }

// `score()` USED TO LIVE HERE. It tested a goal against each playbook's `must` and `when`
// regexes and returned must+1-per-when. semanticMatch replaced it outright — nothing calls it
// any more, and a dead scorer beside a live one is exactly the "two places deciding the same
// question" trap this file warns about elsewhere. Deleted rather than left to rot.
//
// The `must` and `when` fields remain on the procedures above, and are no longer consulted for
// MATCHING. One of them is still read: foodWordIn() uses order-food's `must` as an EXTRACTOR to
// report which food word appeared, which the item classifier needs. `when` is now documentation
// of what a procedure is for — kept because it reads as intent, not because anything tests it.


// The procedures that arbitration governs. When the router has already weighed the whole request
// and decided which of these owns it, the others are not candidates — a tie between food and
// shopping must never again be settled by which one is declared first in this file.
// EVERY VERDICT THE ARBITER CAN RETURN NEEDS A ROW HERE, or the verdict is decorative.
//
// `grocery` was added to the arbiter's candidates and not added to this map. ARBITRATED['grocery']
// is then undefined, `want` is undefined, the filter below is skipped entirely — and with no
// arbitration filtering at all the highest raw score wins. Measured: "order bananas" scored grocery,
// reached here, and opened AMAZON, because shop-add-to-cart out-scored everything else on a bare
// noun. A category the scorer can produce and this map cannot name is worse than no category: it
// looks like a decision and behaves like an absence.
//
// It maps to order-food because that is the only executor for consumables that exists. There is no
// grocery playbook and nothing in this codebase drives Instamart, so pointing groceries at the
// Swiggy flow is the honest limit of what is built — not a claim that groceries are solved.
const ARBITRATED = { food: 'order-food', grocery: 'grocery-add-to-cart', shop: 'shop-add-to-cart', music: 'spotify-play' };
const ARBITRATED_IDS = new Set(Object.values(ARBITRATED));
// ASYNC, because deciding which procedure a request is now involves asking a model rather than
// testing it against a table. Every caller already sat in an async context; the one exception was
// registerPlaybook's callback, whose only consumer is the agent loop and which now awaits.
async function match(goal, opts) {
  // `force` is a playbook ID he picked when asked which procedure he meant — an answer, so it
  // outranks the embedder outright. `prefer` is the arbiter's kind, which only outranks it among the
  // procedures the arbiter decides between.
  const forced = opts && opts.force ? PLAYBOOKS.find(p => p.id === opts.force) : null;
  const want = forced ? forced.id : (opts && opts.prefer ? ARBITRATED[opts.prefer] : null);
  const sem = forced ? { id: forced.id } : await semanticMatch(goal);
  if (!sem) return null;
  // THE GROUP IS THE VERDICT, THE REGION IS ONLY HOW IT WAS RECOGNISED. `search-a-fact` and
  // `search-then-open` are two shapes of one procedure, and with no `groups` configured the
  // classifier reports group === id, so this is the same lookup it always was for every region that
  // is its own group.
  let best = PLAYBOOKS.find(p => p.id === (sem.group || sem.id)) || null;
  if (!best) return null;
  // ARBITRATION STILL OUTRANKS THE EMBEDDER. When the router has already weighed the whole request
  // and named which procedure owns it, that verdict is not up for a second opinion here — this is
  // the "two places deciding the same question" bug the file warns about, and the embedder is not
  // exempt from it.
  if (want && ARBITRATED_IDS.has(best.id) && best.id !== want) {
    const wanted = PLAYBOOKS.find(p => p.id === want);
    if (!wanted) return null;
    if (deps.jlog) deps.jlog('Playbook › embedder said ' + best.id + ', arbitration says ' + want + ' — arbitration wins');
    best = wanted;
  }
  // A NAMED DESTINATION STILL DISQUALIFIES. `not` is not a keyword trap in the sense that matters:
  // it lists SITES, which are a genuinely closed set (the ones this system knows how to drive), and
  // it only ever removes a candidate the request itself ruled out. "order hiking boots from amazon"
  // must not reach the food procedure however the sentence embeds.
  if (best.not && best.not.test(String(goal || ''))) {
    if (deps.jlog) deps.jlog('Playbook › "' + String(goal).slice(0, 40) + '" names a destination ' + best.id + ' does not serve');
    return null;
  }
  // The match now carries the classifier's own numbers rather than a keyword tally. Nothing reads
  // `score` any more — isProcedural asks the procedure (always / fallbackOnly) instead of guessing
  // complexity from how many regexes fired — but it is reported because a routing decision the log
  // cannot explain is a routing decision nobody can debug.
  const slots = {};
  for (const [k, fn] of Object.entries(best.slots || {})) {
    try { slots[k] = fn(goal); } catch (e) { slots[k] = ''; }
  }
  // A PROCEDURE WITH AN UNFILLED SLOT DOES NOT RUN. THIS IS THE INVARIANT, NOT A PATCH.
  //
  // Measured, from his terminal:
  //
  //     ◆ who is youtube
  //     ◆ play his latest video
  //       Opening https://www.youtube.com/@/videos, Sir.        → 404
  //
  // The channel slot is extracted by stripping scaffolding words, and "play his latest video" is
  // ENTIRELY scaffolding — play, his, latest, video all come off, leaving "". The slot function
  // then treated "" as a handle (no whitespace in it, so it "looks like" one) and built
  // youtube.com/@/videos. Every check downstream passed: the URL was well-formed, browser_go
  // succeeded, verification confirmed a page had loaded. Nothing anywhere asked whether the slot
  // had actually filled.
  //
  // Placed in match() rather than in that one playbook on purpose. His words: with three playbooks
  // this is an embarrassing 404, with a hundred it is a hundred confident wrong actions. A slot
  // that came out empty means the request did not contain what the procedure needs, and the honest
  // outcome is to not claim the goal — the loop can still work it out, or ask.
  // TWO RULES, AND THE FIRST DRAFT OF THIS WAS ONE RULE AND WRONG.
  //
  // "any empty slot means do not claim" is too strict, and test_parse said so within a minute:
  // "play some music" fits spotify-play with an empty `query` and is a perfectly good request —
  // no track was named because none was meant. An optional slot is not a broken one.
  //
  // (1) A slot the playbook DECLARES it needs. `requires` is a contract, not a word list: each
  //     procedure states what the request must actually contain for it to be the right procedure.
  //     With a hundred playbooks this is the line that stops a hundred wrong claims, and it is
  //     reviewable per playbook rather than guessed centrally.
  const required = Array.isArray(best.requires) ? best.requires : [];
  const missing = required.filter(k => !String(slots[k] == null ? '' : slots[k]).trim());
  if (missing.length) {
    if (deps.jlog) deps.jlog('Playbook › "' + String(goal).slice(0, 44) + '" fits ' + best.id +
      ' but ' + missing.join(', ') + ' came out empty — not claiming it');
    return null;
  }
  // (2) A URL BUILT AROUND A HOLE. This one needs no declaration and catches the whole class.
  //
  //     ◆ play his latest video   →   https://www.youtube.com/@/videos      → 404
  //
  // Every word in that request was scaffolding, the channel slot came out "", and the slot function
  // pasted it into a URL. The result is well-formed enough that browser_go succeeded and
  // verification confirmed a page loaded — the run reported progress while fetching a 404. Any URL
  // with an empty path segment was assembled around a value that was not there, whichever playbook
  // built it and whichever slot was missing.
  for (const [k, v] of Object.entries(slots)) {
    const s = String(v == null ? '' : v);
    if (!/^https?:\/\//i.test(s)) continue;
    let path = '';
    try { path = new URL(s).pathname; } catch (e) { continue; }
    // An empty path segment ("//"), or a handle prefix with nothing after it ("/@/" or a trailing
    // "/@"). A plain trailing slash is normal and is NOT a hole.
    if (/\/\/|\/@\/|\/@$/.test(path)) {
      if (deps.jlog) deps.jlog('Playbook › "' + String(goal).slice(0, 44) + '" fits ' + best.id +
        ' but ' + k + ' built a URL with an empty segment (' + s.slice(0, 60) + ') — not claiming it');
      return null;
    }
  }
  return { pb: best, slots, sim: sem.sim, margin: sem.margin };
}

// The procedure as the planner should see it: numbered, imperative, with slots filled in.
// The tools a matched procedure permits, or null for "no restriction".
function toolsFor(m) { return (m && m.pb && Array.isArray(m.pb.tools) && m.pb.tools.length) ? m.pb.tools.slice() : null; }
// A procedure that only reads the world declares the tools it reads with (`readOnly`); null for every other one.
function readOnlyTools(m) { return (m && m.pb && Array.isArray(m.pb.readOnly) && m.pb.readOnly.length) ? m.pb.readOnly.slice() : null; }

// Slot filling, shared by the text a model reads and the arguments a step actually runs with. They
// have to come from the same place: a procedure whose words and whose actions could drift apart is
// two procedures.
function slotFiller(m) {
  const slots = Object.assign({}, m.slots);
  for (const [k, v] of Object.entries(m.slots || {})) {
    slots[k + '_url'] = encodeURIComponent(String(v || '').trim());
  }
  return s => String(s).replace(/\{(\w+)\}/g, (_, k) => (slots[k] || '').trim() || ('the ' + k.replace(/_url$/, '')));
}

// THE STEPS THAT DO NOT NEED A MODEL.
//
// A procedure step like "browser_go to https://www.swiggy.com/search" is not a decision — it is an
// instruction, fully specified before the run began. Every step was nonetheless being handed to a 3B
// to guess at, nine times over, and it stopped guessing correctly after three. Measured: the same
// request completed 2 or 3 of 9 steps and then declared itself finished.
//
// A step may now carry `run: {tool, args}`. Those execute directly, in order, with no model call at
// all. The model is consulted only for steps that have no spec — the genuinely ambiguous ones, like
// WHICH restaurant in a list is the right one. Deterministic where the answer is already known,
// judgement only where judgement is required.
function runSpecs(m) {
  if (!m) return [];
  const fill = slotFiller(m);
  const deep = v => typeof v === 'string' ? fill(v)
    : Array.isArray(v) ? v.map(deep)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
    : v;
  return (m.pb.steps || []).map(st => (st && typeof st === 'object' && st.run) ? deep(st.run) : null);
}

function lines(m) {
  if (!m) return [];
  // Every slot also gets a `<name>_url` form, percent-encoded. A raw slot dropped into a URL leaves
  // a space in it — "https://open.spotify.com/search/golden brown" — and the local model does not
  // reliably encode one; asked to, it produced %253D where %3D was wanted. Encoding here means the
  // model only ever copies a string that is already correct.
  const slots = Object.assign({}, m.slots);
  for (const [k, v] of Object.entries(m.slots || {})) {
    slots[k + '_url'] = encodeURIComponent(String(v || '').trim());
  }
  const fill = s => String(s).replace(/\{(\w+)\}/g, (_, k) => (slots[k] || '').trim() || ('the ' + k.replace(/_url$/, '')));
  const out = ['PROCEDURE — this is how this kind of task is done. Follow it in order, one step per reply:'];
  m.pb.steps.forEach((s, i) => out.push('  ' + (i + 1) + '. ' + fill(s && typeof s === 'object' ? s.do : s)));
  out.push('DONE WHEN: ' + fill(m.pb.done) + '.');
  return out;
}

// Does this goal have a procedure worth taking to the agentic loop? Used by the router to overrule
// the single-action keyword lanes, which is the whole reason these goals failed: a lane claimed
// them long before the loop could try.
async function isProcedural(goal, opts) {
  const m = await match(goal, opts);
  if (!m) return false;
  // `always` marks procedures that are multi-step whatever words he used. "order me pizza" is three
  // words and at least five steps; scoring it on phrasing put it in the same bucket as "open
  // youtube", which is one word and one action. Phrasing is a decent proxy for the rest, but not
  // for these.
  if (m.pb.always) return true;
  // A PROCEDURE THAT ALSO HAS A ONE-CALL LANE DOES NOT TAKE THE LOOP.
  //
  // The keyword scorer encoded this by accident and it mattered: "close textedit" and "text mama
  // that I am running late" scored exactly MIN_SCORE — their `must` matched and almost no `when`
  // did — so isProcedural said false and the fast single-action lane kept them. Routing them
  // through the agentic loop turns a 300ms action into twenty seconds.
  //
  // The embedder has no opinion about that, and should not: semantically "close textedit" IS
  // close-an-app, at margin 0.402. Whether a cheaper path exists is a fact about this system's
  // lanes, not about the sentence, so the playbook states it rather than the matcher inferring it.
  if (m.pb.fallbackOnly) return false;
  return true;
}

// WHICH food word matched, not merely whether one did.
//
// order-food's `must` mixes real dish names (biryani, momos, dosa) with generic words that are not
// dishes at all — food, meal, dinner, chicken, mutton. Asking only "does it match" therefore called
// CAT FOOD and CHICKEN BREAST prepared restaurant orders and sent both to Swiggy. The caller needs
// the token so it can tell a dish from a category.
function foodWordIn(text) {
  const pbf = PLAYBOOKS.find(p => p.id === 'order-food');
  if (!pbf || !pbf.must) return '';
  const m = String(text || '').match(pbf.must);
  return m ? String(m[0]).toLowerCase().trim() : '';
}

module.exports = { foodWordIn,
  runSpecs,
  init, PLAYBOOKS, match, lines, isProcedural, stripNoise, toolsFor, readOnlyTools, BROWSER_TOOLS,
  BUYING_STOPS_AT_BASKET, semanticMatch, EXEMPLARS, GROUPS, MIN_MARGIN, ARBITRATED,
};
