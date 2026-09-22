#!/usr/bin/env node
/**
 * Read-only live check: what is actually on the "Biblia Tafsiri Mbalimbali"
 * Facebook page + Instagram account vs. what data/state.json claims. Posts nothing.
 * Usage: node scripts/check-live-posts.mjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const GRAPH = 'https://graph.facebook.com/v21.0'

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'config.json'), 'utf-8'))
const state = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'state.json'), 'utf-8'))

const token = String(cfg.pageAccessToken || cfg.metaUserToken || '').trim()
if (!token) {
  console.log('No token in data/config.json yet (pageAccessToken / metaUserToken) — nothing to check.')
  process.exit(0)
}

async function g(p, params) {
  const url = new URL(`${GRAPH}/${p}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url)
  return res.json().catch(() => ({}))
}

const page = await g(cfg.pageId, { fields: 'name,fan_count,link', access_token: token })
if (page.error) {
  console.log('Page check FAILED:', page.error.message)
  process.exit(1)
}
console.log(`PAGE: "${page.name}" (${page.fan_count} fans) ${page.link}\n`)

const feed = await g(`${cfg.pageId}/posts`, {
  fields: 'id,message,created_time,permalink_url,is_published',
  limit: '10',
  access_token: token,
})
console.log('LIVE FEED (latest 10):')
for (const p of feed.data ?? []) {
  const stamp = p.created_time ? new Date(p.created_time).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '????'
  const first = String(p.message ?? '').split('\n')[0].slice(0, 60)
  console.log(`  ${stamp} | ${first}`)
  console.log(`             ${p.permalink_url ?? p.id}`)
}
if (!feed.data?.length) console.log('  (empty — nothing posted yet)')

const scheduled = await g(`${cfg.pageId}/scheduled_posts`, {
  fields: 'id,message,scheduled_publish_time',
  limit: '25',
  access_token: token,
})
if (scheduled.data?.length) {
  console.log(`\nSCHEDULED ON META (${scheduled.data.length}):`)
  for (const p of scheduled.data) {
    const when = p.scheduled_publish_time
      ? new Date(p.scheduled_publish_time * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : '????'
    console.log(`  ${when} | ${String(p.message ?? '').split('\n')[0].slice(0, 60)}`)
  }
} else {
  console.log('\nSCHEDULED ON META: none (horizon not booked yet — next landed run books it)')
}

console.log('\nSTATE (data/state.json):')
for (const [dk, day] of Object.entries(state.days ?? {})) {
  for (const [label, rec] of Object.entries(day ?? {})) {
    console.log(`  ${dk} ${label} → ${rec?.status}${rec?.publishTime ? ' (publishes ' + rec.publishTime + ')' : ''}`)
  }
}

// ── Instagram ──────────────────────────────────────────────────────────────
if (cfg.igUserId) {
  const ig = await g(cfg.igUserId, { fields: 'username,followers_count,media_count', access_token: token })
  if (ig.error) {
    console.log(`\nIG CHECK FAILED: ${ig.error.message}`)
  } else {
    console.log(`\nINSTAGRAM: @${ig.username} (${ig.followers_count} followers, ${ig.media_count} posts)`) 
    const media = await g(`${cfg.igUserId}/media`, {
      fields: 'id,caption,timestamp,permalink,media_type',
      limit: '10',
      access_token: token,
    })
    console.log('LIVE IG MEDIA (latest 10):')
    for (const m of media.data ?? []) {
      const stamp = m.timestamp ? new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '????'
      const first = String(m.caption ?? '').split('\n')[0].slice(0, 60)
      console.log(`  ${stamp} | ${first}`)
      console.log(`             ${m.permalink ?? m.id}`)
    }
    if (!media.data?.length) console.log('  (empty — nothing posted yet)')
    // Note: IG posts scheduled on Meta's side (publish_time containers) appear in
    // the media list only after they go live; upcoming ones are visible in
    // state.json (status "scheduled") and reconcile into permalinks later.
  }
}

