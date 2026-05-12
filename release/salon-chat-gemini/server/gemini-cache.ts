const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export type CachedContentInfo = {
  name: string
  expireTime?: string
  model: string
}

export async function createCachedContent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds: number,
): Promise<CachedContentInfo> {
  const url = `${GEMINI_API_BASE}/cachedContents?key=${encodeURIComponent(apiKey)}`
  const fullModel = model.startsWith('models/') ? model : `models/${model}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: fullModel,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      ttl: `${ttlSeconds}s`,
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(raw || `${res.status} ${res.statusText}`)
  const data = JSON.parse(raw) as {
    name?: string
    expireTime?: string
    error?: { message?: string }
  }
  if (data.error?.message) throw new Error(data.error.message)
  if (!data.name) throw new Error('cachedContents: thiếu name')
  return { name: data.name, expireTime: data.expireTime, model: fullModel }
}

export async function createCachedContentWithRetry(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds: number,
  attempts = 3,
): Promise<CachedContentInfo> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await createCachedContent(apiKey, model, systemPrompt, ttlSeconds)
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
