/**
 * Normalizes every image in data/photos/ to Instagram-compliant JPEGs:
 *   - converts .png/.webp → .jpg (Instagram feed images must be JPEG)
 *   - applies EXIF rotation, strips metadata
 *   - center-crops aspect ratios outside 4:5 … 1.91:1
 *   - downscales width > 1440 px to 1440 (IG sweet spot, smaller uploads)
 *   - upscales images with a side < 320 px (IG minimum) — squares go to 1080
 * Idempotent: already-compliant JPEGs are left byte-untouched.
 *
 * Used two ways:
 *   1. locally:  node scripts/normalize-photos.js        (one-time cleanup)
 *   2. the GitHub Actions workflow runs it before posting so ANY file the
 *      user drops into data/photos/ (even a phone PNG) just works.
 * Usage: node scripts/normalize-photos.js   (needs sharp: npm i sharp)
 */
const fs = require('fs')
const path = require('path')

const PHOTOS = path.join(__dirname, '..', 'data', 'photos')

async function main() {
  const sharp = require('sharp')
  const files = fs.readdirSync(PHOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort()
  if (files.length === 0) {
    console.log('normalize: no images found in data/photos/')
    return
  }

  for (const file of files) {
    const full = path.join(PHOTOS, file)
    const isJpeg = /\.jpe?g$/i.test(file)
    let meta
    try {
      meta = await sharp(full).metadata()
    } catch (e) {
      console.log(`✗ ${file}: unreadable (${e.message.slice(0, 60)}) — skipped`)
      continue
    }

    // effective dimensions after EXIF rotation
    let W = meta.width ?? 0
    let H = meta.height ?? 0
    if ([5, 6, 7, 8].includes(meta.orientation)) [W, H] = [H, W]
    const actions = []

    // 1) center-crop to the IG-supported aspect range (4:5 … 1.91:1)
    const ratio = W / H
    let cropW = W
    let cropH = H
    if (ratio > 0 && ratio < 0.8) {
      cropH = Math.round(W / 0.8) // too tall → trim height
      actions.push(`crop 4:5 (${W}x${cropH})`)
    } else if (ratio > 1.91) {
      cropW = Math.round(H * 1.91) // too wide → trim width
      actions.push(`crop 1.91:1 (${cropW}x${H})`)
    }

    // 2) downscale width to 1440 max
    let outW = Math.min(cropW, 1440)
    let outH = Math.round((cropH * outW) / cropW)
    if (cropW > 1440) actions.push('downscale 1440w')

    // 3) upscale sides below the IG minimum of 320 px (squares → 1080)
    if (Math.min(outW, outH) < 320) {
      const nearSquare = Math.abs(outW / outH - 1) < 0.15
      const target = nearSquare ? 1080 : 320
      const scale = target / Math.min(outW, outH)
      outW = Math.round(outW * scale)
      outH = Math.round(outH * scale)
      actions.push(`upscale to ${outW}x${outH}`)
    }

    const needsReencode =
      !isJpeg || actions.length > 0 || (meta.orientation && meta.orientation > 1)

    if (!needsReencode) {
      console.log(`= ${file}: OK (${W}x${H})`)
      continue
    }

    const outName = isJpeg ? file : file.replace(/\.(jpe?g|png|webp)$/i, '') + '.jpg'
    const out = path.join(PHOTOS, outName)
    await sharp(full)
      .rotate() // apply EXIF orientation
      .extract({
        left: Math.floor((W - cropW) / 2),
        top: Math.floor((H - cropH) / 2),
        width: cropW,
        height: cropH,
      })
      .resize({ width: outW, height: outH, fit: 'fill', kernel: 'lanczos3' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(out + '.tmp')
    fs.renameSync(out + '.tmp', out)
    if (out !== full) {
      fs.unlinkSync(full) // remove the png/webp original
      actions.push(`converted → ${outName}`)
    }
    const size = (fs.statSync(out).size / 1048576).toFixed(2)
    console.log(
      `✓ ${file}${outName === file ? '' : ' → ' + outName} ${outW}x${outH} ${size}MB${actions.length ? ' (' + actions.join(', ') + ')' : ''}`
    )
  }
}

main().catch((e) => {
  console.error('normalize failed:', e.message)
  process.exit(1)
})
