# Biblia Tafsiri Mbalimbali — Bible Verse Auto-Poster

Posts **one Bible verse image + caption every day at 09:00 EAT** to the Facebook
page [Biblia Tafsiri Mbalimbali](https://www.facebook.com/biblia_tafsiri_mbalimbali)
(`447560908444853`, @biblia_tafsiri_mbalimbali) — fully automated from this repo
via GitHub Actions. No server, no database, no cost.

The images are **YouVersion Verse of the Day** graphics (previous days),
collected into `data/photos/`. Each image is paired in `data/posts.json` with a
caption written for **the exact scripture on that image**:

- the verse in the **SUV** (Swahili Union Version / Biblia ya Kiswahili),
- **two sentences** of explanation and encouragement in Swahili,
- **5 hashtags** related to the verse, always ending with
  `#BibliaTafsiriMbalimbali`.

Sister repo: [Kaka-Doctor/Posting-to-social-medias](https://github.com/Kaka-Doctor/Posting-to-social-medias)
runs the same engine for the Teacher's Lesson Plan page + Instagram
(3 posts/day). This repo is a trimmed, Facebook-only copy of that proven
production system.

---

## How it works (the important part)

GitHub **silently drops most scheduled runs** on young accounts — measured live
on the sister repo: only 1 of ~70 cron fires landed on 2026-09-21. An agent
that must fire "at 09:00" would be late or missing most days. So this agent
does not rely on that:

1. A workflow fires every 30 minutes (cron `13,43 * * * *`) — whenever GitHub
   actually lets one through.
2. Every landed run **pre-books the next `scheduleDays` (3) days with Meta's
   own scheduled publishing**: the photo is uploaded now with
   `scheduled_publish_time = 09:00 EAT`, and **Meta's servers publish it at
   exactly 09:00** — with zero further involvement from GitHub.
3. Later landed runs **reconcile**: they confirm scheduled posts that went
   live and record their permalinks in `data/state.json`.
4. If a slot somehow has no Meta booking and a run lands within
   `graceMinutes` (240) of 09:00, it posts directly as a catch-up.
   Anything later is marked `missed` once, and the **force** button
   (Actions → *Bible Verse Agent* → Run workflow → tick `force`) rescues it
   the same day.

Net effect: **one landed GitHub run every ~2 days is enough** for perfect
09:00 punctuality. This is the same reliability model the sister repo has
running in production since 2026-09-21.

## One-time setup (the only manual step)

The page's posting token cannot be generated from code — Facebook requires
your login for it. One paste and you are done forever (page tokens never
expire):

1. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer)
   and select your app.
2. Add the permissions `pages_show_list`, `pages_manage_posts`,
   `pages_read_engagement`.
3. "Generate Access Token" → copy the token string.
4. In this repo, open **`data/meta-token.txt`**, paste the token (one line),
   and commit the file.
5. Within ~30 minutes a scheduled run (or press *Run workflow* yourself) will:
   mint the **permanent page token**, save it to `pageAccessToken` in
   `data/config.json`, and clear `meta-token.txt`. From then on everything is
   automatic. (If you paste a page token instead of a user token, that works
   too — the agent detects and saves it.)

Until the token exists, the workflow runs end-to-end in plan mode; use
*tick `dryRun`* to preview what would be posted.

## Daily rhythm

| Time (EAT)         | What happens                                                  |
| ------------------ | ------------------------------------------------------------- |
| ~09:00             | Meta publishes the day's verse image + caption on the page    |
| every 30 min       | GitHub *tries* to run the agent; landed runs re-book the horizon |
| after 09:00+4h     | a landed run records the live post's permalink in the state   |

## Content rotation

`data/posts.json` lists the pairs in order; `data/state.json` tracks
`rotation.photoIndex` (and `captionIndex`, always in lockstep). After the last
pair the cycle restarts — with 18 collected images that is ~18 days per cycle.
To extend the pool: download more previous-days images from
`https://www.bible.com/verse-of-the-day` (the gallery at the bottom lists the
last 6 days; the image URLs are
`https://s3.amazonaws.com/static-youversionapi-com/images/base/{id}/1280x1280.jpg`),
drop them in `data/photos/`, and append entries to `data/posts.json` — the
verse on each image must be read and its caption written for it.

## Repo layout

```
data/
  photos/          18 YouVersion Verse-of-the-Day images (JPEG)
  posts.json       the content pool: image ↔ caption pairs (SUV + 2 sentences + 5 hashtags)
  config.json      the switch file: page, slots (09:00), timezone, grace, tokens
  state.json       which slot is done/scheduled per day + rotation + event log (auto-committed)
  meta-token.txt   one-time token paste file (auto-cleared after minting)
scripts/
  gh-agent.mjs         the agent (plain Node ≥18, zero npm installs)
  normalize-photos.js  converts/crops any image you drop in data/photos/
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

- Content pool: **18 verse images** collected (6 previous VOTD days
  2026-09-15…20, 6 designs of the 2026-09-21 VOTD, plus 6 clean
  YouVersion-style verse graphics from the web) — each VLM-verified as a clean
  scripture graphic and paired with its own SUV caption.
- Page confirmed via Graph API: *"Biblia Tafsiri Mbalimbali"*, 100 fans.
- Engine: identical to the sister repo's production code (three-day
  Meta-side scheduling, reconcile, catch-up, force-rescue, state commit-back).
- Pending: the one-time token paste described above.
