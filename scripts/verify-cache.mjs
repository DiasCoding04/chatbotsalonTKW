import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.trim().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=')
      return [line.slice(0, i), line.slice(i + 1)]
    }),
)

const apiKey = env.VITE_GEMINI_API_KEY?.trim()
const model = env.VITE_GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite'
if (!apiKey) {
  console.error('Thiếu VITE_GEMINI_API_KEY trong .env')
  process.exit(1)
}

const SALON_SYSTEM =
  'Bạn là trợ lý ảo của một salon tóc. Trả lời ngắn gọn, lịch sự, tiếng Việt. ' +
  'Giúp khách đặt lịch, tư vấn dịch vụ và giá theo ngữ cảnh được cung cấp bên dưới.'

const IMAGE_SAMPLE_KEY_OVERRIDES = [
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

function imageSampleKeyForLabel(label) {
  const normalized = normalizeSearchText(label)
  const hit = [...IMAGE_SAMPLE_KEY_OVERRIDES]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([needle]) => normalized.includes(needle))
  if (hit) return hit[1]
  return normalized.replace(/\b(url|anh|mau|dung|khi|khach|hoi|xem)\b/g, ' ').trim().replace(/\s+/g, '_')
}

function buildImageSampleCatalogPrompt(markdown) {
  const groups = []
  const seen = new Set()
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^- URL\s+(.+?)\s+\((.+?)\):\s*(.+)$/)
    if (!match) continue
    const [, rawLabel, rawUsage, urlText] = match
    if (!/(https?:\/\/|(?:\.?\/)?images\/samples\/)/.test(urlText)) continue
    const label = rawLabel.trim().replace(/^ảnh mẫu\s+/i, '')
    const baseKey = imageSampleKeyForLabel(label)
    let key = baseKey
    let suffix = 2
    while (seen.has(key)) {
      key = `${baseKey}_${suffix}`
      suffix += 1
    }
    seen.add(key)
    groups.push({ key, label, usage: rawUsage.trim() })
  }
  if (!groups.length) return ''
  return [
    '--- IMAGE SAMPLE ROUTER (không chứa URL) ---',
    'App có database URL ảnh mẫu riêng, URL không nằm trong prompt để tiết kiệm chi phí.',
    'Khi tư vấn dịch vụ/kiểu tóc có nhóm ảnh phù hợp, chủ động thêm marker đúng nhóm ở một dòng riêng: [[SEND_IMAGE:key]].',
    'Không tự viết URL, không giải thích marker cho khách. App sẽ ẩn marker và thay bằng link ảnh thật.',
    'Dùng tối đa 1-2 marker/lượt; chọn nhóm sát nhất với nhu cầu khách.',
    'Các key ảnh mẫu:',
    ...groups.map((group) => `- ${group.key}: ${group.label} (${group.usage})`),
  ].join('\n')
}

const contextMd = readFileSync(resolve(root, 'public/CONTEXT.md'), 'utf8').trim()
const imageSamplesMd = readFileSync(resolve(root, 'public/IMAGE_SAMPLES.md'), 'utf8').trim()
const imageSampleCatalog = buildImageSampleCatalogPrompt(imageSamplesMd)
const promptContextMd = `${contextMd}\n\n${imageSampleCatalog}`.trim()
const systemPrompt = `${SALON_SYSTEM}\n\n--- Ngữ cảnh salon (CONTEXT.md) ---\n\n${promptContextMd}`
const fullModel = model.startsWith('models/') ? model : `models/${model}`
const base = 'https://generativelanguage.googleapis.com/v1beta'

async function createCache() {
  const res = await fetch(`${base}/cachedContents?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: fullModel,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      ttl: '3600s',
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    const err = new Error(`createCachedContent ${res.status}: ${raw}`)
    err.status = res.status
    err.raw = raw
    throw err
  }
  const data = JSON.parse(raw)
  if (!data.name) throw new Error('createCachedContent: thiếu name')
  return data.name
}

async function deleteCache(name) {
  await fetch(`${base}/${name}?key=${encodeURIComponent(apiKey)}`, { method: 'DELETE' })
}

function usageFromChunk(chunk) {
  const m = chunk.usageMetadata
  if (!m) return null
  return {
    prompt: m.promptTokenCount ?? 0,
    cached: m.cachedContentTokenCount ?? 0,
    output: m.candidatesTokenCount ?? 0,
  }
}

async function streamOnce({ cachedContent, label }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Xin chào' }] }],
    generationConfig: {
      maxOutputTokens: 32,
      temperature: 0.55,
      thinkingConfig: { thinkingBudget: 0 },
    },
  }
  if (cachedContent) body.cachedContent = cachedContent
  else body.systemInstruction = { parts: [{ text: systemPrompt }] }

  const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`)
  if (!res.body) throw new Error(`${label}: không có body`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload)
        const u = usageFromChunk(chunk)
        if (u) usage = u
      } catch {
        /* ignore */
      }
    }
  }
  return usage
}

let cacheName = null
try {
  try {
    cacheName = await createCache()
  } catch (e) {
    const raw = e.raw ?? e.message
    if (e.status === 429 && raw.includes('TotalCachedContentStorageTokensPerModelFreeTier')) {
      console.error('createCachedContent: 429 — free tier không có quota Context Cache cho model này (limit=0).')
      console.error('App sẽ fallback gửi systemInstruction inline mỗi tin; cachedContentTokenCount = 0.')
      process.exit(3)
    }
    throw e
  }
  console.log('createCachedContent: OK')
  console.log(`cache name: ${cacheName}`)

  const inline = await streamOnce({ label: 'inline' })
  const cached = await streamOnce({ cachedContent: cacheName, label: 'cached' })

  console.log('\nusage inline (systemInstruction trong body):')
  console.log(inline ?? '(không có usageMetadata)')
  console.log('\nusage cached (cachedContent trong body):')
  console.log(cached ?? '(không có usageMetadata)')

  const ok = Boolean(cached && cached.cached > 0)
  console.log(`\nKết luận: cache ${ok ? 'CÓ' : 'KHÔNG'} được dùng (cachedContentTokenCount > 0)`)
  if (inline && cached) {
    console.log(
      `So sánh prompt: inline=${inline.prompt}, cached=${cached.prompt}, cachedTokens=${cached.cached}`,
    )
  }
  process.exit(ok ? 0 : 2)
} finally {
  if (cacheName) await deleteCache(cacheName)
}
