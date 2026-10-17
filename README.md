# Biblia Tafsiri Mbalimbali — Bible Verse Auto-Poster

Posts **one Bible verse image + caption every day at 12:00 EAT** (owner rule
2026-10-07: TLP 06:00, LOD 09:00, BTM 12:00 — staggered through the day) to **both** the
Facebook page [Biblia Tafsiri Mbalimbali](https://www.facebook.com/biblia_tafsiri_mbalimbali)
(`447560908444853`) **and** its connected Instagram account
[@biblia_tafsiri_mbalimbali](https://www.instagram.com/biblia_tafsiri_mbalimbali)
(IG `17841470180666328`, 114 followers) — fully automated from this repo via
GitHub Actions. No server, no database, no cost. The same verse image + caption
goes to both platforms in one run: Facebook gets a direct photo upload, Instagram
gets the image via a container (hidden-FB-photo → CDN URL → media_publish).

The images come from **three curated sources** in two languages:

- **YouVersion Verse of the Day** graphics (previous days) — English from
  `https://www.bible.com/verse-of-the-day`, **Swahili from
  `https://www.bible.com/sw/verse-of-the-day`** ("Fungu la Siku"),
- **self-made verse cards** (`en-card-*` / `sw-card-*`) on NIV/SUV text with
  designed backgrounds,
- **web-sourced verse graphics** (`web-en-*` / `web-sw-*`, owner request
  2026-10-04) — collected via web image search from **many different sites**
  (Pinterest, bible.com, DailyVerses, Etsy/Scribd verse cards, Tanzanian
  Christian sites, and more — each entry records its source). Every one was
  **machine-vision verified**: the verse text and language on the image were
  read and checked, and each caption quotes what the image actually shows.

Each image is
paired in `data/posts.json` with a caption written **in the same language as
the scripture on that image** (owner rule, 2026-09-22):

- **a short HEADING in capital letters + bold** (owner rule, 2026-09-23) —
  3-6 words, related to the verse on the image or the explanation, in the
  entry's language. FB and IG captions have no native bold formatting, so the
  agent renders it in **Unicode bold capitals** (𝗕𝗢𝗟𝗗 𝗧𝗘𝗫𝗧) — the standard
  bold style on both platforms. Stored per entry as `"heading"` in
  `data/posts.json`; leave it empty/missing to post without a heading,
- the verse **verbatim as written on the image** (Swahili images quote the
  YouVersion Swahili text — BHN/Union wording, verified against bible.com;
  English images quote the English verse),
- **two sentences** of explanation and encouragement in that same language,
- **5 hashtags** related to the verse, always ending with
  `#BibliaTafsiriMbalimbali`,
- **an app promo line below the hashtags** (owner rule, 2026-09-23):
  `Download Our App from PlayStore with this link: https://play.google.com/store/apps/details?id=com.biblia.tafsiri.mbalimbali`
  — identical on English and Kiswahili days (verbatim owner wording), appended
  by the agent after the optional Gemini rewrite so Gemini never touches it.

So a published post reads:

> **𝗚𝗢𝗗'𝗦 𝗠𝗘𝗥𝗖𝗬 𝗡𝗘𝗩𝗘𝗥 𝗥𝗨𝗡𝗦 𝗢𝗨𝗧**
>
> Lamentations 3:22
>
> "The faithful love of the LORD never ends! His mercies never cease."
>
> Every new morning is quiet proof that God's mercy has not run out on you…
>
> #Lamentations #MercyOfGod #FaithfulLove #NewMercies #BibliaTafsiriMbalimbali
>
> Download Our App from PlayStore with this link: https://play.google.com/store/apps/details?id=com.biblia.tafsiri.mbalimbali

**Daily language alternation (owner rule, 2026-09-22):** English one day,
Kiswahili the next — "if today you use english tomorrow use swahili". The
agent tracks the language of the most recent post in `data/state.json` and
always schedules the opposite language for the next slot, with a separate
rotation index per language.

**Google Gemini (optional, owner request 2026-09-22):** if a
`GEMINI_API_KEY` repo secret is configured
(Settings → Secrets and variables → Actions), the agent asks **Google
Gemini** to rewrite the two encouragement sentences of each **Swahili**
caption in fresh, native Kiswahili at posting time — keeping the scripture
quote and hashtags intact. Without the key (or on any Gemini error) the
stored captions in `data/posts.json` are used, so posting never depends on
Gemini being reachable. Create a free key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). Optional
`GEMINI_MODEL` repo **variable** overrides the default `gemini-2.5-flash`.

Sister repo: [Kaka-Doctor/Posting-to-TLP](https://github.com/Kaka-Doctor/Posting-to-TLP)
runs the same engine for the Teacher's Lesson Plan page + Instagram
(3 posts/day). This repo is a trimmed copy of that proven production system,
posting to the Biblia page + Instagram instead.

---

## How it works (the important part)

GitHub **silently drops most scheduled runs** on young accounts — measured live
on the sister repo: only 1 of ~70 cron fires landed on 2026-09-21. An agent
that must fire "at 09:00" would be late or missing most days. So this agent
does not rely on that:

1. A workflow fires every 30 minutes (cron `13,43 * * * *`) — whenever GitHub
   actually lets one through.
2. Every landed run **pre-books the next `scheduleDays` (3) days of FB posts
   with Meta's own scheduled publishing**: FB photos with
   `scheduled_publish_time = 12:00 EAT` — **Meta's servers publish the FB
   post at exactly 12:00** with zero further involvement from GitHub. (IG
   containers cannot be scheduled — the API's `publish_time` is silently
   ignored, verified 2026-09-22 — so the Instagram half is posted directly by
   the first landed run after 12:00, within the 7-hour catch-up window.)
3. Later landed runs **reconcile**: they confirm scheduled posts that went
   live and record their permalinks in `data/state.json`.
4. If a slot somehow has no Meta booking and a run lands within
   `graceMinutes` (420, widened 2026-10-07) of 12:00, it posts directly as a catch-up.
   Anything later is marked `missed` once, and the **force** button
   (Actions → *Bible Verse Agent* → Run workflow → tick `force`) rescues it
   the same day — including a FB-only `partial` slot, where force posts just
   the missing IG half (2026-09-24).
5. **Mutual rescue (2026-09-24).** This page is the reliable anchor of the
   three-page family, so every landed run here ALSO checks the sibling pages
   (Ladies of Destiny, Teacher's Lesson Plan) through the GitHub API and
   dispatches their workflow when a sibling has an IG half due but no landed
   run of its own (API dispatches are 100% reliable, unlike cron). Token:
   `dispatchToken` in `data/config.json` (already configured; a
   `DISPATCH_TOKEN` repo secret would override it). Dispatched runs skip
   their own sibling check (one hop, no ping-pong).

Net effect: **one landed GitHub run every ~2 days is enough** for perfect
09:00 punctuality on Facebook; the IG post follows on the first landed run
after 09:00 (exact-to-minutes-late depending on GitHub, force-button rescue
for the rest) — and this page's reliable run landings now keep the sibling
pages posting on both platforms too.

## One-time setup — ✅ DONE (2026-09-22)

The permanent page token has already been minted (the owner pasted a fresh
Explorer token; it was exchanged to long-lived with the app secret, then used
to mint the **never-expiring page token** now stored in `pageAccessToken` in
`data/config.json`). It covers both `pages_manage_posts` and
`instagram_content_publish` — Facebook **and** Instagram posting.

If the token is ever revoked (password change, app removal, permission
change), redo it — the flow is one paste:

1. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer)
   and select your app.
2. Add the permissions `pages_show_list`, `pages_manage_posts`,
   `pages_read_engagement`.
3. "Generate Access Token" → copy the token string.
4. In this repo, open **`data/meta-token.txt`**, paste the token (one line),
   and commit the file.
5. Within ~30 minutes a scheduled run (or press *Run workflow* yourself) will:
   re-mint the **permanent page token**, save it to `pageAccessToken` in
   `data/config.json`, and clear `meta-token.txt`. From then on everything is
   automatic again. (If you paste a page token instead of a user token, that
   works too — the agent detects and saves it.)

### Instagram publishing requirements (already satisfied)

- The IG account must be **Business or Creator** and linked to the FB page —
  ✓ @biblia_tafsiri_mbalimbali is linked (page → `instagram_business_account`).
- The token needs `instagram_content_publish` — ✓ included in the permanent
  page token.
- IG API publishing is limited to **25 posts per 24 h** and 50 API calls/h —
  at 1 post/day this is nowhere near a concern.

Until the token exists, the workflow runs end-to-end in plan mode; use
*tick `dryRun`* to preview what would be posted.

## Daily rhythm

| Time (EAT)         | What happens                                                  |
| ------------------ | ------------------------------------------------------------- |
| ~09:00             | Meta publishes the verse image + caption on FB **and** IG      |
| every 30 min       | GitHub *tries* to run the agent; landed runs re-book the horizon |
| after 09:00+4h     | a landed run records the live post's permalink in the state   |

## Content rotation

`data/posts.json` lists the pairs in order, each tagged `"lang": "en"` or
`"lang": "sw"`. `data/state.json` tracks one rotation index **per language**
(`rotation.en`, `rotation.sw`) plus the language of every posted slot, and the
agent alternates the slot language daily. After the last pair of a language
the cycle restarts — the library holds **200 images (100 English + 100
Kiswahili)**: YouVersion VOTD graphics from both language pages, verse cards
composed on AI backgrounds (NIV text for English, SUV text for Kiswahili,
fetched from bible.com), and **web-sourced verse graphics from many different
sites** (machine-vision verified, language-matched captions). That is ~400
days of unique
content before any image repeats (each language posts every second day).
To extend a pool:

- **English:** download more previous-days images from
  `https://www.bible.com/verse-of-the-day` (gallery at the bottom), or run a
  web image search for `"<Book Ch:V> bible verse image"` and verify the text.
- **Swahili:** same page in Swahili —
  `https://www.bible.com/sw/verse-of-the-day` — the gallery lists the last
  6 days in Kiswahili; today's designs are also downloadable. Web image
  searches for `"mistari ya biblia picha"` / `"<Kitabu S:M> picha"` also
  yield good Kiswahili verse graphics (verify the language of the text!).

The image URLs are
`https://s3.amazonaws.com/static-youversionapi-com/images/base/{id}/1280x1280.jpg`.
Drop them in `data/photos/`, add entries to `data/posts.json` (read the
verse on each image and write a short matching-language `heading` — bold
capitals, 3-6 words — plus a caption for it), push —
done. New entries can be appended anywhere AFTER the current rotation
pointer of their
language pool without disturbing the rotation pointers (`rotation.en` /
`rotation.sw` in state.json); entries placed BEFORE the current pointer
shift what posts next. (The web-sourced blocks were inserted exactly AT the
pointers so the new images start posting at the next unbooked slot.)

## Repo layout

```
data/
  photos/          200 verse images (100 English + 100 Kiswahili: YouVersion VOTD
                    graphics + verse cards + VLM-verified web-sourced graphics
                    from many different sites)
  posts.json       the content pool: image ↔ heading + caption pairs, lang-tagged, alternate daily
  config.json      the switch file: page, slots (09:00), timezone, grace, tokens
  state.json       per-slot status + language + per-language rotation + event log (auto-committed)
  meta-token.txt   one-time token paste file (auto-cleared after minting)
scripts/
  gh-agent.mjs         the agent (plain Node ≥18, zero npm installs)
  normalize-photos.js  converts/crops any image you drop in data/photos/
  gemini-selftest.mjs  one-click Google Gemini key check (Actions → Run
                       workflow → tick "gemini-test")
  check-live-posts.mjs read-only: compares the live page feed + Meta's
                       scheduled queue against data/state.json
.github/workflows/
  social-agent.yml  the 30-minute heartbeat + manual buttons
```

## Controls (all in `data/config.json`)

- **Pause** — set `"autoPost": false`; the next run also cancels any pending
  Meta-scheduled posts so the pause is immediate and real.
- **Change time** — edit `"slots"` (e.g. `"09:00"` → `"08:30,17:00"` for two
  posts a day); `"timezone"` defaults to `Africa/Dar_es_Salaam`.
- **Post now / rescue a missed slot** — Actions → *Bible Verse Agent* →
  *Run workflow* → tick `force`.
- **Preview** — same dialog, tick `dryRun`.

The repo must stay **private** — `data/config.json` holds the page's access
token (committed on purpose, same model as the sister repo).

## Status of this setup

- Content pool: **100 verse images** — 55 English (previous VOTD days
  2026-09-15…22 including 7 designs of the 09-22 VOTD, clean web verse
  graphics, and 30 verse cards on AI backgrounds with NIV text) and
  **45 Kiswahili** (YouVersion "Fungu la Siku" graphics 2026-09-16…22 plus
  verse cards with SUV text from bible.com) — every image VLM-verified as a
  clean scripture graphic in its language; card verse texts fetched
  verbatim from bible.com (NIV / SUV).
- Language rule live: caption language = image language, alternating daily
  (EN/SW) since 2026-09-22.
- Page confirmed via Graph API: *"Biblia Tafsiri Mbalimbali"*, 100 fans;
  IG @biblia_tafsiri_mbalimbali linked and posting.
- Engine: identical to the sister repo's production code (three-day
  Meta-side scheduling, reconcile, catch-up, force-rescue, state commit-back)
  plus the language-alternation and optional Gemini caption modules.
- Optional: add the `GEMINI_API_KEY` secret to have Google Gemini write the
  Swahili encouragement sentences live (see above).
