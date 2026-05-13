import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const publicSamplesPath = resolve(root, 'public', 'IMAGE_SAMPLES.md')
const dataSamplesPath = resolve(root, 'data', 'IMAGE_SAMPLES.md')
const fallbackSamplesPath = resolve(root, 'src', 'context', 'IMAGE_SAMPLES.fallback.md')
const outputDir = resolve(root, 'public', 'images', 'samples')
const relativeDir = 'images/samples'

const keyOverrides = [
  ['moi noi long vu', 'moi_noi_long_vu'],
  ['noi long vu den', 'noi_long_vu_den_chum_den'],
  ['chum toc den', 'noi_long_vu_den_chum_den'],
  ['noi toc', 'noi_toc'],
  ['toc ngan', 'toc_ngan_bob_tem'],
  ['bob', 'toc_ngan_bob_tem'],
  ['tem', 'toc_ngan_bob_tem'],
  ['mai thua', 'mai_thua'],
  ['mai bay', 'mai_bay'],
  ['mai phap', 'mai_phap'],
  ['mai ngang', 'mai_ngang'],
  ['duoi cup duoi thang tu nhien toc ngan', 'duoi_ngan'],
  ['duoi cup duoi thang tu nhien toc dai', 'duoi_dai'],
  ['uon cup', 'uon_cup'],
  ['uon song toc ngan', 'uon_song_ngan'],
  ['uon song toc dai', 'uon_song_dai'],
  ['hippie', 'uon_hippie'],
  ['hippi', 'uon_hippie'],
  ['hippe', 'uon_hippie'],
  ['xu mi', 'uon_hippie'],
  ['xoan tang', 'uon_xoan_tang'],
  ['xoan luoi toc dai', 'uon_xoan_luoi_dai'],
  ['xoan luoi toc ngan', 'uon_xoan_luoi_ngan'],
  ['phu bac mau tram', 'phu_bac_mau_tram'],
  ['nhuom phu bac', 'nhuom_phu_bac'],
  ['toc bac', 'toc_bac'],
  ['mau tram', 'mau_tram'],
  ['mau thoi trang', 'mau_thoi_trang'],
  ['balayage', 'mau_balayage'],
  ['baby light', 'mau_babylight'],
  ['babylight', 'mau_babylight'],
  ['sang khong can tay', 'nhuom_sang_khong_tay'],
]

function normalizeSearchText(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function fallbackKey(label) {
  return (
    normalizeSearchText(label)
      .replace(/\b(url|anh|mau|dung|khi|khach|hoi|xem)\b/g, ' ')
      .trim()
      .replace(/\s+/g, '_') || 'image_sample'
  )
}

function imageSampleKeyForLabel(label) {
  const normalized = normalizeSearchText(label)
  const hit = [...keyOverrides]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([needle]) => normalized.includes(needle))
  return hit?.[1] ?? fallbackKey(label)
}

function extractSourceUrls(text) {
  return Array.from(new Set(text.match(/https?:\/\/[^\s),\]]+/g) ?? []))
}

function extForUrl(sourceUrl) {
  try {
    const ext = extname(new URL(sourceUrl).pathname).toLowerCase()
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext
  } catch {
    // Fall through to jpg.
  }
  return '.jpg'
}

async function fileExistsWithContent(path) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function downloadImage(sourceUrl, outputPath) {
  if (await fileExistsWithContent(outputPath)) return 'skipped'
  const res = await fetch(sourceUrl)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!bytes.length) throw new Error('empty response')
  await writeFile(outputPath, bytes)
  return 'downloaded'
}

const source = await readFile(publicSamplesPath, 'utf8')
const lines = source.split(/\r?\n/)
const updatedLines = []
const downloads = []
const seenKeys = new Set()

for (const line of lines) {
  const match = line.match(/^- URL\s+(.+?)\s+\((.+?)\):\s*(.+)$/)
  if (!match) {
    updatedLines.push(line)
    continue
  }

  const [, rawLabel, rawUsage, urlText] = match
  const sourceUrls = extractSourceUrls(urlText)
  if (!sourceUrls.length) {
    updatedLines.push(line)
    continue
  }

  const label = rawLabel.trim()
  const baseKey = imageSampleKeyForLabel(label)
  let key = baseKey
  let suffix = 2
  while (seenKeys.has(key)) {
    key = `${baseKey}_${suffix}`
    suffix += 1
  }
  seenKeys.add(key)

  const localUrls = sourceUrls.map((sourceUrl, index) => {
    const fileName = `${key}-${String(index + 1).padStart(2, '0')}${extForUrl(sourceUrl)}`
    const relativeUrl = `${relativeDir}/${fileName}`
    downloads.push({
      sourceUrl,
      outputPath: resolve(outputDir, fileName),
      relativeUrl,
    })
    return relativeUrl
  })

  updatedLines.push(`- URL ${rawLabel.trim()} (${rawUsage.trim()}): ${localUrls.join(', ')}`)
}

await mkdir(outputDir, { recursive: true })

let downloaded = 0
let skipped = 0
const failures = []

for (const item of downloads) {
  try {
    const status = await downloadImage(item.sourceUrl, item.outputPath)
    if (status === 'downloaded') downloaded += 1
    else skipped += 1
  } catch (err) {
    failures.push(`${item.sourceUrl} -> ${item.relativeUrl}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

if (failures.length) {
  console.error(`Failed to download ${failures.length} image(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

const updated = updatedLines.join('\n')
await writeFile(publicSamplesPath, updated, 'utf8')
await writeFile(dataSamplesPath, updated, 'utf8')
await writeFile(fallbackSamplesPath, updated, 'utf8')

console.log(`Image samples updated: ${downloads.length} reference(s), ${downloaded} downloaded, ${skipped} already existed.`)
console.log(`Output directory: ${outputDir}`)
