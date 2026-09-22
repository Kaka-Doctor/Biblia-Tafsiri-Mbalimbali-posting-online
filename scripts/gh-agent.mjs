#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Biblia Tafsiri Mbalimbali — Bible Verse Auto-Posting Agent (GitHub Actions)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Posts ONE verse image + Swahili SUV caption to the Facebook page
 *  "Biblia Tafsiri Mbalimbali" every day at 09:00 EAT. Runs on GitHub's servers
 *  (`.github/workflows/social-agent.yml`), triggered by GitHub's cron.
 *  No web server, no database, no npm installs — plain Node (>= 18).
 *
 *  CONTENT: data/posts.json pairs each verse image (collected in data/photos/)
 *  with a caption written IN THE SAME LANGUAGE as the scripture on the image
 *  (owner rule 2026-09-22): English image → English caption, Swahili image →
 *  Swahili caption ("lang": "en"|"sw" on every entry). Posts alternate daily:
 *  English one day, Kiswahili the next ("if today you use english tomorrow
 *  use swahili"). Each caption = the scripture (verbatim as written on the
 *  image) + two sentences of explanation/encouragement + 5 hashtags ending
 *  with #BibliaTafsiriMbalimbali. With the GEMINI_API_KEY secret set, the
 *  Swahili encouragement sentences are rewritten by Google Gemini at posting
 *  time (stored caption = the fallback). The agent rotates through each
 *  language's pairs in manifest order, then cycles.
 *
 *  RELIABILITY MODEL: GitHub silently drops most scheduled runs on young
 *  accounts (observed live on the sister repo: 1 run per 5-11 hours, regardless
 *  of cron density). The agent therefore does NOT rely on firing at slot time.
 *  Every landed run PRE-SCHEDULES the next `scheduleDays` days of slots with
 *  Meta's own scheduled publishing (FB photos with scheduled_publish_time) —
 *  Meta then publishes them exactly at 09:00 EAT from Meta's servers. One
 *  landed run every ~2 days is enough. Landed runs also reconcile state once
 *  scheduled posts go live; late direct posting remains as the catch-up
 *  fallback.
 *
 *  Everything configurable lives in data/config.json (the switch file):
 *    pageId              → which page to post to (Biblia Tafsiri Mbalimbali)
 *    slots / timezone    → when to post (cron here just checks often)
 *    pageAccessToken     → permanent page token (preferred, minted once)
 *    metaUserToken       → user token (fallback rotation path)
 *    platforms           → "facebook" here (Instagram support exists but is off)
 *
 *  FIRST-RUN TOKEN SETUP (one paste, no JSON editing): drop a fresh Graph API
 *  Explorer user token into data/meta-token.txt and push — the next landed run
 *  mints the page's PERMANENT token, saves it to pageAccessToken in
 *  data/config.json, and clears the file. --dry-run works even before any
 *  token exists (it prints the content plan only).
 *
 *  State lives in data/state.json and is committed back to the repo by the
 *  workflow (which slots are done per day + rotation counters + event log).
 *
 *  Flags:  --dry-run   pick content, print the plan, publish nothing
 *          --force     post the most recent unposted slot right now (manual)
 *  Exit:   0 = ok / nothing to do, 1 = failure (red run in the Actions tab)
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json')
const STATE_FILE = path.join(ROOT, 'data', 'state.json')
const PHOTOS_DIR = path.join(ROOT, 'data', 'photos')
const POSTS_FILE = path.join(ROOT, 'data', 'posts.json')
const TOKEN_FILE = path.join(ROOT, 'data', 'meta-token.txt')

const GRAPH = 'https://graph.facebook.com/v21.0'

const ARG_DRY = process.argv.includes('--dry-run')
const ARG_FORCE = process.argv.includes('--force')

const log = (msg) => console.log(msg)

// ── Graph API helpers (mirrors src/lib/meta.ts) ─────────────────────────────
async function graphGet(pathname, params) {
  const url = new URL(`${GRAPH}/${pathname}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method: 'GET' })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

async function graphPost(pathname, params) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) body.set(k, String(v))
  const res = await fetch(`${GRAPH}/${pathname}`, { method: 'POST', body })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

async function graphDelete(pathname, params) {
  const url = new URL(`${GRAPH}/${pathname}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method: 'DELETE' })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

/** POST /{page}/photos with a binary file (multipart "source" field) */
async function fbUploadPhoto(pageId, pageToken, filePath, { caption = '', published = true } = {}) {
  const buf = await fs.readFile(filePath)
  const form = new FormData()
  if (caption) form.append('caption', caption)
  form.append('published', published ? 'true' : 'false')
  form.append('access_token', pageToken)
  form.append('source', new Blob([buf], { type: 'image/jpeg' }), path.basename(filePath))
  const res = await fetch(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: form })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

// ── Connect (page-token first, user-token exchange as fallback) ─────────────
async function connect(cfg) {
  const enableIG = String(cfg.platforms ?? 'facebook,instagram').toLowerCase().includes('instagram')
  // 1) permanent page token from config
  if (cfg.pageAccessToken && cfg.pageId) {
    try {
      const me = await graphGet(cfg.pageId, {
        fields: enableIG ? 'name,instagram_business_account{id,username}' : 'name',
        access_token: cfg.pageAccessToken,
      })
      const ig = me.instagram_business_account ?? {}
      log(`[connect] page token (permanent): valid → ${me.name}${enableIG ? ` | IG: @${ig.username ?? 'none'}` : ' | FB-only'}`)
      return {
        via: 'page-token',
        page: {
          pageId: cfg.pageId,
          pageName: String(me.name ?? ''),
          pageToken: cfg.pageAccessToken,
          igUserId: enableIG ? String(ig.id ?? cfg.igUserId ?? '') : '',
          igUsername: enableIG ? String(ig.username ?? '') : '',
        },
      }
    } catch (e) {
      log(`[connect] permanent page token failed (${e.message}) — trying user-token exchange`)
    }
  }
  // 2) rotation path: exchange user token → pages → page token.
  //    The user token may live in data/meta-token.txt (paste-and-push, no JSON
  //    editing) or in metaUserToken. When minted, the permanent page token is
  //    saved to data/config.json and the txt file is cleared (one-shot).
  let token = String(cfg.metaUserToken || '').trim()
  let tokenFromFile = false
  if (!token) {
    token = (await fs.readFile(TOKEN_FILE, 'utf-8').catch(() => '')).trim()
    if (token) {
      tokenFromFile = true
      log('[connect] found user token in data/meta-token.txt — minting the permanent page token')
    }
  }
  if (!token) {
    throw new Error('No working token yet: paste a fresh Graph API Explorer token into data/meta-token.txt and push (the agent mints the permanent page token on its next run) — or put it in metaUserToken in data/config.json')
  }
  if (cfg.appId && cfg.appSecret) {
    try {
      const ex = await graphGet('oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        fb_exchange_token: token,
      })
      if (ex.access_token) token = String(ex.access_token)
    } catch { /* keep raw token */ }
  }
  try {
    const pages = await graphGet('me/accounts', {
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      access_token: token,
      limit: '50',
    })
    const list = (pages.data ?? []).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      accessToken: String(p.access_token),
      igUserId: p.instagram_business_account ? String(p.instagram_business_account.id) : '',
      igUsername: p.instagram_business_account ? String(p.instagram_business_account.username) : '',
    }))
    const page =
      list.find((p) => cfg.pageId && p.id === cfg.pageId) ??
      list.find((p) => cfg.igUsername && p.igUsername === cfg.igUsername) ??
      list.find((p) => p.igUserId) ??
      list[0]
    if (!page) throw new Error('Token exchange OK but no pages visible to this token')
    log(`[connect] user-token path → ${page.name} (${page.id})`)
    return {
      via: 'exchange',
      tokenFromFile,
      userToken: true,
      sourceToken: token,
      page: { pageId: page.id, pageName: page.name, pageToken: page.accessToken, igUserId: enableIG ? page.igUserId : '', igUsername: enableIG ? page.igUsername : '' },
    }
  } catch (e) {
    // 3) the pasted token might already BE a page token (not a user token)
    if (cfg.pageId) {
      const me = await graphGet(cfg.pageId, { fields: 'name', access_token: token }).catch(() => null)
      if (me && me.name) {
        log(`[connect] token works directly as the page token → ${me.name}`)
        return {
          via: 'exchange',
          tokenFromFile,
          userToken: false,
          sourceToken: token,
          page: { pageId: cfg.pageId, pageName: String(me.name), pageToken: token, igUserId: '', igUsername: '' },
        }
      }
    }
    throw new Error(`${e.message} — and the token does not work as a page token either. Generate a fresh token in the Graph API Explorer (with pages_show_list + pages_manage_posts + pages_read_engagement) and paste it into data/meta-token.txt`)
  }
}

// ── Time / slots (mirrors src/lib/settings.ts + scheduler.ts) ───────────────
function localNow(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '0'
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: hour * 60 + minute,
  }
}

function parseSlots(str) {
  return String(str || '09:00')
    .split(',')
    .map((s) => s.trim().match(/^(\d{1,2}):(\d{2})$/))
    .filter(Boolean)
    .map((m) => ({
      minutes: Number(m[1]) * 60 + Number(m[2]),
      label: `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`,
    }))
    .sort((a, b) => a.minutes - b.minutes)
}

// ── Content: photo+caption pairs from data/posts.json ───────────────────────
// Each manifest entry pairs a verse image with a caption IN THE SAME LANGUAGE
// as the scripture on that image ("lang": "en"|"sw"). The owner's rule
// (2026-09-22): alternate daily — English one day, Kiswahili the next. Each
// language has its own rotation index; pools are walked in manifest order.
async function loadLibrary() {
  let manifest = { posts: [] }
  try {
    manifest = JSON.parse(await fs.readFile(POSTS_FILE, 'utf-8'))
  } catch {
    throw new Error('data/posts.json is missing or unreadable — the content pool lives there')
  }
  const entries = []
  const seenPhotos = []
  for (const p of (manifest.posts ?? [])) {
    if (!p || !p.photo || !p.caption) continue
    const exists = await fs.stat(path.join(PHOTOS_DIR, p.photo)).then(() => true).catch(() => false)
    if (exists) {
      entries.push({
        photo: p.photo,
        caption: String(p.caption),
        lang: String(p.lang ?? 'en').toLowerCase() === 'sw' ? 'sw' : 'en',
        reference: String(p.reference ?? ''),
      })
      seenPhotos.push(p.photo)
    } else {
      log(`[library] note: manifest entry "${p.id ?? p.photo}" has no photo file in data/photos/ — skipped`)
    }
  }
  const inDir = (await fs.readdir(PHOTOS_DIR).catch(() => [])).filter((f) => /\.jpe?g$/i.test(f))
  const orphans = inDir.filter((f) => !seenPhotos.includes(f))
  if (orphans.length > 0) {
    log(`[library] note: ${orphans.length} photo(s) in data/photos/ are not in data/posts.json — not posted (${orphans.join(', ')})`)
  }
  const nonJpg = (await fs.readdir(PHOTOS_DIR).catch(() => [])).filter((f) => /\.(png|webp)$/i.test(f))
  if (nonJpg.length > 0) {
    log(`[library] note: ${nonJpg.length} non-JPEG file(s) present (${nonJpg.join(', ')}) — the workflow's normalize step converts them to JPEG before posting`)
  }
  return { entries }
}

// ── Language alternation (owner rule: English today, Kiswahili tomorrow) ────
/** Most recent slot's language ('en'|'sw'), scanning state newest-first.
 *  Legacy records without a lang field infer it from the photo filename
 *  (Swahili images are named votd-sw-*). Returns null when no history. */
function lastPostedLang(state) {
  const dayKeys = Object.keys(state.days ?? {}).sort().reverse()
  for (const dk of dayKeys) {
    const slots = Object.entries(state.days[dk]).sort((a, b) => b[0].localeCompare(a[0]))
    for (const [, rec] of slots) {
      if (rec?.lang === 'en' || rec?.lang === 'sw') return rec.lang
      if (rec?.photo) return /^votd-sw-/i.test(rec.photo) ? 'sw' : 'en'
    }
  }
  return null
}
function oppositeLang(lang) { return lang === 'sw' ? 'en' : 'sw' }

/** Next slot's language: opposite of the most recent slot's language.
 *  A fresh repo starts with English. */
function nextSlotLang(state) {
  return oppositeLang(lastPostedLang(state) ?? 'sw')
}

/** Peek the photo+caption entry for the given language WITHOUT advancing the
 *  rotation (rotation advances only on successful post/schedule). Falls back
 *  to the other language pool when the requested one is empty. */
function peekEntry(state, entriesByLang, lang) {
  let pool = entriesByLang[lang] ?? []
  if (pool.length === 0) {
    const fb = oppositeLang(lang)
    log(`[pick] no ${lang === 'sw' ? 'Swahili' : 'English'} entries in data/posts.json — falling back to ${fb === 'sw' ? 'Swahili' : 'English'} entries (add more "lang": "${lang}" entries to keep the alternation)`)
    lang = fb
    pool = entriesByLang[lang] ?? []
  }
  const idx = Number(state.rotation[lang] ?? 0) % Math.max(1, pool.length)
  return { entry: pool[idx], lang, index: idx, poolSize: pool.length }
}

/** Advance the per-language rotation after a successful post/schedule. */
function advanceRotation(state, entriesByLang, lang) {
  const pool = entriesByLang[lang] ?? []
  if (pool.length === 0) return
  state.rotation[lang] = (Number(state.rotation[lang] ?? 0) + 1) % pool.length
}

// ── Google Gemini (optional) — Swahili caption quality ─────────────────────
/** When the GEMINI_API_KEY secret is configured, ask Google Gemini to rewrite
 *  the two encouragement sentences of a Swahili caption in fresh, native
 *  Kiswahili — keeping the reference line, the scripture quote, and the
 *  hashtags intact. Any failure returns null → the stored caption is used, so
 *  posting never depends on Gemini being reachable. (Owner request 2026-09-22:
 *  "use google ai (gemini) to create caption of swahili images".) */
async function geminiRewriteSwCaption(caption) {
  const key = String(process.env.GEMINI_API_KEY ?? '').trim()
  if (!key) return null
  const model = String(process.env.GEMINI_MODEL ?? 'gemini-2.5-flash').trim() || 'gemini-2.5-flash'
  const prompt =
    'Wewe ni mtaalamu wa Kiswahili sanifu na mwandishi mashuhuri wa taarifa za kiroho za kila siku. ' +
    'Andika upya sentensi MBILI za kueleza na kuhamasisha katika machapisho yafuatayo kwa Kiswahili asili, sanifu na laini ' +
    'kama waandishi wazawa wa Tanzania — kila sentensi iwe na maneno 12-24. Mstari wa rejea, nukuu ya maandiko, na hashtags ' +
    'ZIBAKI HAKUNA mabadiliko kabisa. Jibu kwa machapisho yote yaliyokamilika pekee (rejea + nukuu + sentensi mbili mpya + ' +
    'hashtags), bila maelezo mengine yoyote kabla au baada.\n\n' + caption
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(45000),
      }
    )
    const json = await res.json().catch(() => ({}))
    const text = String(json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim()
    if (!res.ok || !text) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
    // validation: the verse quote, the brand hashtag and a sane size must survive
    const brand = '#BibliaTafsiriMbalimbali'
    const q1 = caption.indexOf('"')
    const q2 = q1 >= 0 ? caption.indexOf('"', q1 + 1) : -1
    const quote = q1 >= 0 && q2 > q1 ? caption.slice(q1, q2 + 1) : ''
    if (!text.includes(brand) || (quote && !text.includes(quote)) || text.length < 120 || text.length > 2200) {
      throw new Error('output failed validation (quote/hashtag/length)')
    }
    log(`[gemini] Swahili caption rewritten with Google Gemini (${model})`)
    return text
  } catch (e) {
    log(`[gemini] rewrite failed (${e.message}) — using the stored caption`)
    return null
  }
}

/** Final caption for a slot: Gemini-refreshed when enabled + Swahili, else the
 *  stored library caption. */
async function captionForSlot(entry) {
  if (entry.lang === 'sw') {
    const rewritten = await geminiRewriteSwCaption(entry.caption)
    if (rewritten) return rewritten
  }
  return entry.caption
}

// ── State (data/state.json, committed back by the workflow) ─────────────────
// rotation: one index per language pool ({ en: n, sw: n }); a legacy flat
// rotation { photoIndex, captionIndex } from before the alternation is reset.
const EMPTY_STATE = { version: 1, days: {}, rotation: { en: 0, sw: 0 }, events: [] }
async function readState() {
  try {
    const s = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'))
    const rotation = { ...EMPTY_STATE.rotation }
    if (s.rotation && typeof s.rotation.photoIndex !== 'number') {
      for (const k of ['en', 'sw']) {
        const v = Number(s.rotation[k])
        if (Number.isFinite(v) && v >= 0) rotation[k] = Math.floor(v)
      }
    }
    return { ...EMPTY_STATE, ...s, rotation }
  } catch {
    return JSON.parse(JSON.stringify(EMPTY_STATE))
  }
}
async function writeState(state) {
  state.events = state.events.slice(-100)
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}
function recordEvent(state, ev) {
  state.events.push({ ts: new Date().toISOString(), ...ev })
}

// ── Duplicate guard (mirrors src/lib/meta.ts minutesSinceLastPost) ──────────
// ⚠ IG /media lists SCHEDULED-but-unpublished containers too, with timestamp =
// CREATION time — the guard would misread our own horizon booking as "a post
// just went out" and skip the current slot (observed live 2026-09-22: run at
// 08:54 booked 09-23/09-24 → run at 09:02 skipped the 09:00 slot "8 min ago").
// Fix: ignore IG media ids that state.json itself recorded as scheduled.
async function minutesSinceLastPost(page, state) {
  const cutoff = Date.now() - 7 * 86400000
  const future = Date.now() + 60000 // ignore future timestamps (scheduled posts)
  const scheduledIgIds = new Set()
  for (const day of Object.values(state?.days ?? {})) {
    for (const rec of Object.values(day ?? {})) {
      if (rec?.status === 'scheduled' && rec?.ig?.id) scheduledIgIds.add(String(rec.ig.id))
    }
  }
  try {
    if (page.igUserId) {
      const json = await graphGet(`${page.igUserId}/media`, { fields: 'id,timestamp', limit: '10', access_token: page.pageToken })
      const ts = (json.data ?? [])
        .filter((m) => !scheduledIgIds.has(String(m.id)))
        .map((m) => (m.timestamp ? new Date(m.timestamp).getTime() : 0)).filter(Boolean).filter((t) => t < future)
      const latest = Math.max(...ts, 0)
      if (latest > cutoff) return Math.max(0, Math.round((Date.now() - latest) / 60000))
      return null
    }
  } catch { /* fall through */ }
  try {
    const json = await graphGet(`${page.pageId}/posts`, { fields: 'created_time', limit: '3', access_token: page.pageToken })
    const ts = (json.data ?? []).map((p) => (p.created_time ? new Date(p.created_time).getTime() : 0)).filter(Boolean).filter((t) => t < future)
    const latest = Math.max(...ts, 0)
    if (latest > cutoff) return Math.max(0, Math.round((Date.now() - latest) / 60000))
  } catch { /* unknown — do not block */ }
  return null
}

/** IG-only guard variant: used when posting ONLY the Instagram half of a
 *  Meta-scheduled slot. The FB twin publishes at slot time via Meta and would
 *  false-positive a whole-page guard check — so only IG's own recent posts
 *  count here. State-recorded IG ids are excluded (already accounted slots). */
async function minutesSinceLastIgPost(page, state) {
  const cutoff = Date.now() - 7 * 86400000
  const future = Date.now() + 60000
  const knownIgIds = new Set()
  for (const day of Object.values(state?.days ?? {})) {
    for (const rec of Object.values(day ?? {})) {
      if (rec?.ig?.id) knownIgIds.add(String(rec.ig.id))
    }
  }
  try {
    const json = await graphGet(`${page.igUserId}/media`, { fields: 'id,timestamp', limit: '10', access_token: page.pageToken })
    const ts = (json.data ?? [])
      .filter((m) => !knownIgIds.has(String(m.id)))
      .map((m) => (m.timestamp ? new Date(m.timestamp).getTime() : 0)).filter(Boolean).filter((t) => t < future)
    const latest = Math.max(...ts, 0)
    if (latest > cutoff) return Math.max(0, Math.round((Date.now() - latest) / 60000))
  } catch { /* unknown — do not block */ }
  return null
}

// ── Publish (IG via Meta CDN, FB via binary upload) ─────────────────────────
async function publishInstagram(page, photoPath, caption) {
  const steps = []
  let helperPhotoId = ''
  try {
    // 1) hidden FB photo → public CDN URL
    const up = await fbUploadPhoto(page.pageId, page.pageToken, photoPath, { published: false })
    helperPhotoId = String(up.id ?? '')
    steps.push(`helper photo ${helperPhotoId} uploaded (unpublished)`)
    const info = await graphGet(helperPhotoId, { fields: 'images', access_token: page.pageToken })
    const images = (info.images ?? []).slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    const cdnUrl = String(images[0]?.source ?? '')
    if (!cdnUrl) throw new Error('no CDN URL on the helper photo')
    steps.push(`CDN url ok (${images[0].width}px)`)

    // 2) IG container → poll → publish (mirrors src/lib/meta.ts)
    const container = await graphPost(`${page.igUserId}/media`, {
      image_url: cdnUrl,
      caption: caption.slice(0, 2200),
      access_token: page.pageToken,
    })
    const creationId = String(container.id ?? '')
    if (!creationId) throw new Error('no container id returned')
    steps.push(`container ${creationId}`)
    let ready = false
    for (let i = 0; i < 10; i++) {
      const status = await graphGet(creationId, { fields: 'status_code', access_token: page.pageToken })
      const code = String(status.status_code ?? '')
      if (code === 'FINISHED') { ready = true; break }
      if (code === 'ERROR') throw new Error('Instagram could not process the image')
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (!ready) throw new Error('image processing timed out (try a smaller JPEG)')
    steps.push('container FINISHED')

    const published = await graphPost(`${page.igUserId}/media_publish`, { creation_id: creationId, access_token: page.pageToken })
    const postId = String(published.id ?? '')
    let permalink = ''
    try {
      const info2 = await graphGet(postId, { fields: 'permalink', access_token: page.pageToken })
      permalink = String(info2.permalink ?? '')
    } catch { /* best-effort */ }
    steps.push(`published ${postId}`)
    return { ok: true, postId, permalink, error: '', steps }
  } catch (e) {
    return { ok: false, postId: '', permalink: '', error: e.message, steps }
  } finally {
    if (helperPhotoId) {
      try { await graphDelete(helperPhotoId, { access_token: page.pageToken }) } catch { /* best-effort cleanup */ }
    }
  }
}

async function publishFacebook(page, photoPath, caption) {
  try {
    const json = await fbUploadPhoto(page.pageId, page.pageToken, photoPath, {
      caption: caption.slice(0, 5000),
      published: true,
    })
    const postId = String(json.post_id ?? json.id ?? '')
    let permalink = ''
    try {
      const info = await graphGet(postId, { fields: 'permalink_url', access_token: page.pageToken })
      permalink = String(info.permalink_url ?? '')
    } catch { /* best-effort */ }
    return { ok: true, postId, permalink, error: '' }
  } catch (e) {
    return { ok: false, postId: '', permalink: '', error: e.message }
  }
}

// ── Meta-scheduled publishing (the reliability core) ────────────────────────
// FB ONLY: photo upload with published=false + scheduled_publish_time — Meta
// publishes exactly at 09:00 EAT; GitHub's schedule drops become irrelevant
// for FB. IG has NO API scheduling (publish_time is SILENTLY IGNORED —
// media_publish posts immediately, verified live with a controlled experiment
// 2026-09-22; scheduled_publish_time is whitelist-gated). IG halves are posted
// directly by landed runs in each slot's catch-up window instead.

async function scheduleFacebookPost(page, photoPath, caption, publishTimeUnixSec) {
  try {
    const buf = await fs.readFile(photoPath)
    const form = new FormData()
    if (caption) form.append('caption', caption.slice(0, 5000))
    form.append('published', 'false')
    form.append('scheduled_publish_time', String(publishTimeUnixSec))
    form.append('access_token', page.pageToken)
    form.append('source', new Blob([buf], { type: 'image/jpeg' }), path.basename(photoPath))
    const res = await fetch(`${GRAPH}/${page.pageId}/photos`, { method: 'POST', body: form })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
    return { ok: true, postId: String(json.id ?? ''), error: '' }
  } catch (e) {
    return { ok: false, postId: '', error: e.message }
  }
}

/** Confirm Meta-scheduled FB posts that went live → record permalinks.
 *  IG is never pre-scheduled (API dead), so a scheduled slot's IG half is
 *  completed by the catch-up logic in main(); reconcile only (a) fills the FB
 *  permalink once Meta flips the scheduled photo to a live feed post, and
 *  (b) closes slots as 'partial' (FB-only) when the IG catch-up window lapsed
 *  without a landed run. */
async function reconcileScheduled(page, state, graceMinutes) {
  let changed = false
  for (const [dk, day] of Object.entries(state.days ?? {})) {
    for (const [label, rec] of Object.entries(day ?? {})) {
      if (rec?.status !== 'scheduled' || !rec.publishTime) continue
      const due = new Date(rec.publishTime).getTime()
      if (Date.now() < due + 5 * 60000) continue // not due yet
      // (a) FB confirmation: scheduled photo flips to a feed post with a permalink
      if (rec.fb?.id && !rec.fb.permalink) {
        for (const cid of [String(rec.fb.id), `${page.pageId}_${String(rec.fb.id)}`]) {
          try {
            const p = await graphGet(cid, { fields: 'permalink_url,created_time', access_token: page.pageToken })
            if (p.permalink_url && p.created_time && new Date(p.created_time).getTime() <= Date.now() + 60000) {
              rec.fb = { id: cid, permalink: String(p.permalink_url) }
              changed = true
              break
            }
          } catch { /* not confirmable via this id yet */ }
        }
      }
      const igDone = Boolean(rec.ig?.id)
      if (igDone) {
        rec.status = 'published'
        rec.at = rec.publishTime
        recordEvent(state, { level: 'success', date: dk, slot: label, message: `${label} completed — FB (Meta) + IG (catch-up) both live` })
        changed = true
      } else if (Date.now() > due + graceMinutes * 60000) {
        rec.status = 'partial'
        rec.at = rec.publishTime
        recordEvent(state, { level: 'error', date: dk, slot: label, message: `${label} partial — FB published by Meta on time, but no landed run caught up the IG half within ${graceMinutes} min` })
        changed = true
      }
    }
  }
  return changed
}

/** Pause switch: delete pending scheduled posts from Meta so "autoPost": false really stops everything. */
async function cancelPendingScheduled(page, state) {
  let cancelled = 0
  for (const [dk, day] of Object.entries(state.days ?? {})) {
    for (const [label, rec] of Object.entries(day ?? {})) {
      if (rec?.status !== 'scheduled' || !rec.publishTime) continue
      if (new Date(rec.publishTime).getTime() < Date.now()) continue
      const removed = []
      if (rec.ig?.id) { try { await graphDelete(String(rec.ig.id), { access_token: page.pageToken }); removed.push('IG') } catch { /* already gone */ } }
      if (rec.fb?.id) { try { await graphDelete(String(rec.fb.id), { access_token: page.pageToken }); removed.push('FB') } catch { /* already gone */ } }
      if (removed.length > 0) {
        rec.status = 'cancelled'
        rec.at = new Date().toISOString()
        recordEvent(state, { level: 'info', date: dk, slot: label, message: `${label} cancelled (autoPost=false) — removed from Meta: ${removed.join(' + ')}` })
        cancelled++
      }
    }
  }
  return cancelled
}

/** Wall-clock (dateKey + minutesOfDay) in `timeZone` → UTC epoch ms. 2-pass Intl convergence. */
function zonedToUtc(dateKey, minutesOfDay, timeZone) {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const wallMs = Date.UTC(y, mo - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  let ts = wallMs
  for (let i = 0; i < 3; i++) {
    const parts = fmt.formatToParts(new Date(ts))
    const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'))
    if (asUTC === wallMs) break
    ts += wallMs - asUTC
  }
  return ts
}

/** Upcoming slots across `scheduleDays` days that have no state entry yet. */
function buildHorizon(state, slots, now, tz, scheduleDays) {
  const plan = []
  const minUnix = Date.now() + 20 * 60000 // Meta needs ≥ 10 min lead; use 20 for safety
  for (let d = 0; d < scheduleDays; d++) {
    const dk = d === 0 ? now.date : addDaysKey(now.date, d)
    for (const s of slots) {
      if (state.days[dk]?.[s.label]) continue
      const slotUnix = zonedToUtc(dk, s.minutes, tz)
      if (slotUnix < minUnix) continue
      plan.push({ dk, slot: s, slotUnix })
    }
  }
  return plan
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))

  // Connect to the page. In dry-run mode a missing token is not fatal — the
  // plan (slots, photos, captions, horizon) is still printed so the repo can
  // be previewed before the one-time token paste.
  let page = { pageId: String(cfg.pageId ?? ''), pageName: String(cfg.pageName ?? ''), pageToken: '', igUserId: '', igUsername: '' }
  let via = 'none'
  let tokenFromFile = false
  let userToken = false
  let sourceToken = ''
  try {
    ;({ page, via, tokenFromFile, userToken, sourceToken } = await connect(cfg))
  } catch (e) {
    if (!ARG_DRY) throw e
    log(`[connect] ${e.message}`)
    log('[dry-run] no Meta token yet — printing the content plan only (posting needs the one-time token paste)')
  }

  // If we minted a page token through the user-token path, persist it back
  // into data/config.json — future runs (and page switches) then work from the
  // permanent token. A pasted data/meta-token.txt is cleared after use (and
  // kept in metaUserToken as the fallback if it was a real user token).
  if (via === 'exchange') {
    let changed = false
    if (cfg.pageAccessToken !== page.pageToken) { cfg.pageAccessToken = page.pageToken; changed = true }
    if (cfg.pageName !== page.pageName) { cfg.pageName = page.pageName; changed = true }
    if (cfg.pageId !== page.pageId) { cfg.pageId = page.pageId; changed = true }
    if (userToken && sourceToken && cfg.metaUserToken !== sourceToken) { cfg.metaUserToken = sourceToken; changed = true }
    if (tokenFromFile) {
      await fs.writeFile(TOKEN_FILE, '')
      log('[connect] data/meta-token.txt cleared (permanent page token saved to data/config.json)')
      changed = true
    }
    if (changed) {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
      log('[connect] minted page token saved → data/config.json (committed back with the state)')
    }
  }

  const state = await readState()
  const tz = cfg.timezone || 'Africa/Dar_es_Salaam'
  const slots = parseSlots(cfg.slots)
  const grace = Number(cfg.graceMinutes ?? 60)
  const scheduleDays = Math.max(1, Math.min(7, Number(cfg.scheduleDays ?? 3)))
  const now = localNow(tz)
  const nowClock = `${String(Math.floor(now.minutesOfDay / 60)).padStart(2, '0')}:${String(now.minutesOfDay % 60).padStart(2, '0')}`

  log(`[clock] ${now.date} ${nowClock} (${tz}) | slots: ${slots.map((s) => s.label).join(', ')} | grace ${grace}m | horizon ${scheduleDays}d | mode: ${ARG_DRY ? 'DRY-RUN' : ARG_FORCE ? 'FORCED' : 'auto'}`)

  // Emergency pause switch — set "autoPost": false in data/config.json.
  // Pending Meta-scheduled posts are deleted so the pause really stops everything.
  if (cfg.autoPost === false && !ARG_FORCE && !ARG_DRY) {
    log('[paused] autoPost is false in data/config.json — automatic posting paused (manual force still works)')
    const n = await cancelPendingScheduled(page, state)
    if (n > 0) { await writeState(state); log(`[paused] cancelled ${n} pending Meta-scheduled post(s)`) }
    return
  }

  const library = await loadLibrary()
  if (library.entries.length === 0) {
    const why = 'no usable photo+caption pairs in data/posts.json (each entry needs photo + caption, and the photo must exist in data/photos/)'
    recordEvent(state, { level: 'error', date: now.date, slot: '', message: `Nothing to post: ${why}` })
    await writeState(state)
    throw new Error(`Nothing to post: ${why}`)
  }
  const entriesByLang = {
    en: library.entries.filter((e) => e.lang === 'en'),
    sw: library.entries.filter((e) => e.lang === 'sw'),
  }
  log(`[library] ${library.entries.length} verse-image pair(s) from data/posts.json — ${entriesByLang.en.length} English, ${entriesByLang.sw.length} Swahili; next slot language: ${nextSlotLang(state) === 'sw' ? 'Kiswahili' : 'English'} (daily alternation)`)
  if (entriesByLang.en.length === 0 || entriesByLang.sw.length === 0) {
    log('[library] note: one language pool is empty — the alternation will fall back to the available pool until more images are added')
  }

  // ---- reconcile: confirm Meta-scheduled slots that have gone live ----
  if (!ARG_DRY) {
    const changed = await reconcileScheduled(page, state, grace)
    if (changed) { await writeState(state); log('[reconcile] recorded live permalinks for scheduled slots') }
  }

  // ---- slot decision (mirrors src/lib/scheduler.ts) ----
  if (slots.length === 0) throw new Error('No valid slots in data/config.json ("slots" field)')
  let target = null
  let missed = []
  const doneToday = state.days[now.date] ?? {}

  if (ARG_FORCE || ARG_DRY) {
    // manual runs: first rescue the slot that is due RIGHT NOW — the most
    // recent past slot without BOTH halves done. A 'scheduled' slot (FB booked
    // on Meta) whose IG half is missing IS rescuable: force posts just the IG
    // half right now (FB is already in Meta's hands).
    for (const s of [...slots].reverse()) {
      if (s.minutes > now.minutesOfDay) continue
      const done = state.days[now.date]?.[s.label]
      if (done && ['published', 'partial', 'guarded', 'missed', 'cancelled'].includes(done.status)) continue
      if (done && done.status === 'scheduled' && done.ig?.id) continue // both halves done
      target = { ...s, date: now.date, igOnly: Boolean(done && done.status === 'scheduled' && !done.ig?.id) }
      break
    }
    // otherwise the next future slot (today, else tomorrow)
    if (!target) {
      for (const dayOffset of [0, 1]) {
        const dk = dayOffset === 0 ? now.date : addDaysKey(now.date, 1)
        for (const s of slots) {
          if (dayOffset === 0 && s.minutes <= now.minutesOfDay) continue
          const done = state.days[dk]?.[s.label]
          if (done && ['published', 'partial', 'scheduled'].includes(done.status)) continue
          target = { ...s, date: dk }
          break
        }
        if (target) break
      }
    }
  } else {
    for (const s of slots) {
      const rec = doneToday[s.label]
      const since = now.minutesOfDay - s.minutes
      if (rec && rec.status === 'scheduled') {
        // FB is booked on Meta and will publish on time; the IG half is ours.
        // Post it the moment a landed run sees the slot time arrive.
        if (!rec.ig?.id && since >= 0 && since <= grace) target = { ...s, igOnly: true }
        continue
      }
      if (rec) continue
      if (since >= 0 && since <= grace) target = s
      else if (since > grace) missed.push(s)
    }
    // mark permanently-missed slots once (so they are not retried)
    for (const s of missed) {
      doneToday[s.label] = { status: 'missed', at: new Date().toISOString() }
      recordEvent(state, { level: 'info', date: now.date, slot: s.label, message: `Slot ${s.label} missed (outside ${grace}-min catch-up window)` })
    }
    if (missed.length > 0) state.days[now.date] = doneToday
  }

  if (!target && missed.length > 0) await writeState(state)

  // ---- horizon: upcoming slots to pre-schedule with Meta's own scheduler ----
  const horizon = scheduleDays >= 2 ? buildHorizon(state, slots, now, tz, scheduleDays) : []

  if (ARG_DRY) {
    if (target) {
      const rec = state.days[target.date ?? now.date]?.[target.label]
      if (target.igOnly) {
        log(`[pick] slot ${target.label} on ${target.date ?? now.date} → IG half only (FB already booked on Meta, photo "${rec?.photo ?? '?'}", lang ${rec?.lang ?? '?'})`)
        if (page.igUserId) log('[dry-run] would publish Instagram only right now:')
        if (page.igUserId) log(`  Instagram (@${page.igUsername}): hidden FB photo → CDN url → container → media_publish`)
      } else {
        const pick = peekEntry(state, entriesByLang, nextSlotLang(state))
        log(`[pick] slot ${target.label} on ${target.date ?? now.date} → language: ${pick.lang === 'sw' ? 'Kiswahili' : 'English'} → photo: ${pick.entry.photo} (rotation index ${pick.index} of ${pick.poolSize})`)
        log('[dry-run] would publish now:')
        log(`  Facebook (${page.pageName || 'Biblia Tafsiri Mbalimbali'}): binary upload with caption`)
        if (page.igUserId) log(`  Instagram (@${page.igUsername}): hidden FB photo → CDN url → container → media_publish`)
      }
    }
    if (horizon.length > 0) {
      log(`[dry-run] would pre-schedule ${horizon.length} slot(s) — FB via Meta exactly on time; IG posted later by landed catch-up runs:`
        + (String(process.env.GEMINI_API_KEY ?? '').trim() ? ' (Swahili slots: caption re-written with Google Gemini)' : ''))
      let dryLang = nextSlotLang(state)
      for (const h of horizon) {
        const pick = peekEntry(state, entriesByLang, dryLang)
        dryLang = oppositeLang(dryLang)
        log(`  ${h.dk} ${h.slot.label} → ${pick.lang === 'sw' ? 'Kiswahili' : 'English'} → "${pick.entry.photo}" → FB at ${new Date(h.slotUnix).toISOString()} + IG on the next landed run after that`)
      }
    }
    log('[dry-run] nothing published or scheduled, state unchanged')
    return
  }

  if (target) {
    const dateKey = target.date ?? now.date
    const slotLabel = `${target.label} Auto`
    const existing = state.days[dateKey]?.[target.label] // set when this slot was pre-booked on Meta

    // ---- pick content ----
    // IG-catch-up (slot was pre-booked on Meta): reuse the slot's OWN photo and
    // caption recorded at booking time — the FB half is already live/live-soon
    // with exactly this content; IG must match it, not advance the rotation.
    // Fresh catch-up: language-alternated rotation picks, both platforms.
    let photoFile, captionText, postLang
    if (target.igOnly && existing?.photo && existing?.caption) {
      photoFile = existing.photo
      captionText = existing.caption
      postLang = existing?.lang ?? (/^votd-sw-/i.test(photoFile) ? 'sw' : 'en')
      log(`[pick] slot ${slotLabel} on ${dateKey} → IG half of pre-booked slot (photo "${photoFile}", lang ${postLang} — pinned at booking time)`)
    } else {
      const pick = peekEntry(state, entriesByLang, nextSlotLang(state))
      postLang = pick.lang
      photoFile = pick.entry.photo
      captionText = await captionForSlot(pick.entry)
      log(`[pick] slot ${slotLabel} on ${dateKey} → language: ${postLang === 'sw' ? 'Kiswahili' : 'English'} (daily alternation) → photo: ${photoFile} (rotation index ${pick.index} of ${pick.poolSize})`)
    }
    const photoPath = path.join(PHOTOS_DIR, photoFile)
    log(`[pick] caption: "${captionText.slice(0, 70).replace(/\n/g, ' ')}…" (${captionText.length} chars)`)

    // ---- duplicate guard (cross-runtime safety net) ----
    // IG-only catch-ups check IG only — the FB twin publishes via Meta at slot
    // time and would false-positive the FB side of the guard.
    const guardMinutes = ARG_FORCE ? 3 : 30
    const lastAgo = target.igOnly
      ? await minutesSinceLastIgPost(page, state)
      : await minutesSinceLastPost(page, state)
    if (lastAgo !== null && lastAgo < guardMinutes) {
      log(`[guard] a post went out ${lastAgo} min ago (< ${guardMinutes} min guard) — skipping to avoid double-posting`)
      const gday = state.days[dateKey] ?? {}
      gday[target.label] = target.igOnly
        ? { ...existing, guard: new Date().toISOString() } // keep the booking; a later run retries the IG half
        : { status: 'guarded', at: new Date().toISOString() }
      state.days[dateKey] = gday
      recordEvent(state, { level: 'info', date: dateKey, slot: target.label, message: `Skipped by duplicate guard — last post ${lastAgo} min ago` })
      await writeState(state)
      target = null
    } else {
      // ---- publish ----
      log(`[post] publishing slot ${slotLabel} ${target.igOnly ? '(Instagram half; Facebook is in Meta\u2019s hands)' : ''} …`)
      const igResult = page.igUserId
        ? await publishInstagram(page, photoPath, captionText)
        : { ok: true, postId: '', permalink: '', error: '', steps: ['IG not configured'] }
      igResult.steps?.forEach((s) => log(`  IG: ${s}`))
      const fbResult = target.igOnly
        ? { ok: true, postId: existing?.fb?.id ?? '', permalink: existing?.fb?.permalink ?? '', error: '', steps: ['FB: pre-booked on Meta'] }
        : await publishFacebook(page, photoPath, captionText)
      if (target.igOnly) log('  FB: pre-booked on Meta (publishes/published at slot time — no action)')

      const igOk = igResult.ok
      const fbOk = fbResult.ok
      const status = igOk && fbOk ? 'published' : igOk || fbOk ? 'partial' : 'failed'
      log(`[post] IG: ${igOk ? `✓ ${igResult.permalink || igResult.postId}` : `✗ ${igResult.error}`}`)
      if (!target.igOnly) log(`[post] FB: ${fbOk ? `✓ ${fbResult.permalink || fbResult.postId}` : `✗ ${fbResult.error}`}`)

      // ---- state update ----
      const day = state.days[dateKey] ?? {}
      day[target.label] = {
        status,
        at: new Date().toISOString(),
        publishTime: existing?.publishTime,
        photo: photoFile,
        caption: captionText,
        lang: postLang,
        ig: igOk ? { id: igResult.postId, permalink: igResult.permalink } : { error: igResult.error },
        fb: target.igOnly
          ? (existing?.fb ?? { error: 'booking lost' })
          : fbOk ? { id: fbResult.postId, permalink: fbResult.permalink } : { error: fbResult.error },
      }
      state.days[dateKey] = day
      if (status !== 'failed') {
        // rotation advanced at booking time for pre-booked slots — not here
        if (!target.igOnly) advanceRotation(state, entriesByLang, postLang)
      }
      recordEvent(state, {
        level: status === 'published' ? 'success' : 'error',
        date: dateKey,
        slot: target.label,
        message: `${slotLabel}: ${status} — "${photoFile}" | IG ${igOk ? '✓' : `✗ ${igResult.error}`} | FB ${fbOk ? '✓' : `✗ ${fbResult.error}`}`,
      })
      await writeState(state)
      log(`[state] saved — ${dateKey} ${target.label} = ${status}`)

      if (status !== 'published') {
        throw new Error(`Slot ${slotLabel} ended as "${status}" — IG: ${igResult.error || 'ok'} | FB: ${fbResult.error || 'ok'}`)
      }
    }
  } else {
    log(`[done] no slot due right now — today: ${Object.keys(doneToday).map((k) => `${k}=${doneToday[k].status}`).join(', ') || 'nothing posted yet'}`)
  }

  // ---- pre-schedule the horizon: FB only, Meta publishes exactly on time ----
  // (IG cannot be pre-scheduled — API dead. Landed runs post the IG half of
  // each slot in its catch-up window; see the igOnly logic above.)
  if (horizon.length > 0) log(`[schedule] pre-scheduling ${horizon.length} upcoming slot(s) on Facebook via Meta …`)
  let scheduledCount = 0
  for (const h of horizon) {
    const pick = peekEntry(state, entriesByLang, nextSlotLang(state))
    const hPhoto = pick.entry.photo
    const hLang = pick.lang
    const hCaption = await captionForSlot(pick.entry)
    const hPhotoPath = path.join(PHOTOS_DIR, hPhoto)
    const hISO = new Date(h.slotUnix).toISOString()
    log(`[schedule] ${h.dk} ${h.slot.label} → language: ${hLang === 'sw' ? 'Kiswahili' : 'English'} → "${hPhoto}" → FB publishes at ${hISO}; IG half on the next landed run after that`)
    const fbS = await scheduleFacebookPost(page, hPhotoPath, hCaption, Math.floor(h.slotUnix / 1000))
    if (fbS.ok) {
      const day = state.days[h.dk] ?? {}
      day[h.slot.label] = {
        status: 'scheduled',
        publishTime: hISO,
        at: new Date().toISOString(),
        photo: hPhoto,
        caption: hCaption,
        lang: hLang,
        fb: { id: fbS.postId },
      }
      state.days[h.dk] = day
      advanceRotation(state, entriesByLang, hLang)
      recordEvent(state, { level: 'info', date: h.dk, slot: h.slot.label, message: `${h.slot.label} FB half pre-scheduled via Meta (publishes ${hISO}, ${hLang === 'sw' ? 'Kiswahili' : 'English'}) — "${hPhoto}"; IG half to be posted by a landed run in the catch-up window` })
      scheduledCount++
    } else {
      recordEvent(state, { level: 'error', date: h.dk, slot: h.slot.label, message: `${h.slot.label} FB scheduling FAILED — ${fbS.error} (next run retries)` })
      log(`  ✗ FB scheduling failed: ${fbS.error} — next run retries`)
    }
  }
  if (scheduledCount > 0) {
    await writeState(state)
    log(`[state] saved — ${scheduledCount} upcoming slot(s): FB pre-scheduled with Meta`)
  }
}

function addDaysKey(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

main()
  .catch((e) => { console.error(`[agent] FAILED: ${e.message}`); process.exit(1) })
