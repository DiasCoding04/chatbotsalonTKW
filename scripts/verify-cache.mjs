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

const contextMd = readFileSync(resolve(root, 'public/CONTEXT.md'), 'utf8').trim()
const systemPrompt = `${SALON_SYSTEM}\n\n--- Ngữ cảnh salon (CONTEXT.md) ---\n\n${contextMd}`
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
