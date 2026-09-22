#!/usr/bin/env node
/** Gemini self-test (owner tool, 2026-09-22).
 *  Run via Actions: "Run workflow" → tick "gemini-test". Calls Google Gemini
 *  with the EXACT prompt + validation the agent uses for Swahili captions, so
 *  a green result here guarantees the posting-time rewrites will work.
 *  Prints only success/validation info — the API key is never logged. */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const POSTS = path.join(ROOT, 'data', 'posts.json')

const key = String(process.env.GEMINI_API_KEY ?? '').trim()
if (!key) {
  console.log('❌ GEMINI_API_KEY is not set on this run.')
  console.log('   → Repo Settings → Secrets and variables → Actions → New repository secret')
  console.log('     Name: GEMINI_API_KEY   Secret: <your key from aistudio.google.com/apikey>')
  process.exit(1)
}
const model = String(process.env.GEMINI_MODEL ?? 'gemini-2.5-flash').trim() || 'gemini-2.5-flash'
const posts = JSON.parse(fs.readFileSync(POSTS, 'utf-8'))
const entry = (posts.posts ?? []).find((p) => p.lang === 'sw')
if (!entry) {
  console.log('❌ no lang:"sw" entry in data/posts.json to test with')
  process.exit(1)
}
const caption = entry.caption
const prompt =
  'Wewe ni mtaalamu wa Kiswahili sanifu na mwandishi mashuhuri wa taarifa za kiroho za kila siku. ' +
  'Andika upya sentensi MBILI za kueleza na kuhamasisha katika machapisho yafuatayo kwa Kiswahili asili, sanifu na laini ' +
  'kama waandishi wazawa wa Tanzania — kila sentensi iwe na maneno 12-24. Mstari wa rejea, nukuu ya maandiko, na hashtags ' +
  'ZIBAKI HAKUNA mabadiliko kabisa. Jibu kwa machapisho yote yaliyokamilika pekee (rejea + nukuu + sentensi mbili mpya + ' +
  'hashtags), bila maelezo mengine yoyote kabla au baada.\n\n' + caption
console.log(`Testing Google Gemini (${model}) with the Swahili caption of "${entry.photo}" …`)
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
if (!res.ok || !text) {
  console.log(`❌ Gemini API error: ${json?.error?.message ?? `HTTP ${res.status}`}`)
  console.log('   → the key may be wrong/expired, or the model name (repo variable GEMINI_MODEL) is invalid')
  process.exit(1)
}
const brand = '#BibliaTafsiriMbalimbali'
const q1 = caption.indexOf('"')
const q2 = q1 >= 0 ? caption.indexOf('"', q1 + 1) : -1
const quote = q1 >= 0 && q2 > q1 ? caption.slice(q1, q2 + 1) : ''
const valid =
  text.includes(brand) && (!quote || text.includes(quote)) && text.length >= 120 && text.length <= 2200
console.log(valid
  ? "✅ GEMINI OK — key valid, output passed the agent's validation"
  : '⚠ key works but output failed validation (agent will fall back to stored captions)')
console.log('--- Gemini output ---')
console.log(text)
console.log('--- end ---')
process.exit(valid ? 0 : 2)
