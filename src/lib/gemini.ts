/**
 * Đi qua Vite dev proxy (`/gemini-api` → generativelanguage.googleapis.com).
 * Lợi ích:
 *  - Same-origin → KHÔNG có CORS preflight OPTIONS mỗi request.
 *  - Có thể đổi target trong vite.config.ts hoặc thay bằng backend prod.
 */
const API_BASE = '/gemini-api/v1beta'
const PROXY_INJECTS_KEY = import.meta.env.VITE_GEMINI_PROXY_INJECTS_KEY === 'true'

function geminiUrl(path: string, apiKey: string): string {
  const base = `${API_BASE}${path}`
  if (PROXY_INJECTS_KEY) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}key=${encodeURIComponent(apiKey)}`
}

/**
 * Model mặc định — đồng bộ với App / .env.example.
 * Mặc định salon: `gemini-3.1-flash-lite` (Gemini 3.1 Flash-Lite trên Developer API).
 */
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite'

/**
 * TẮT thinking mode. Gemini 3.x mặc định "suy nghĩ" trước khi sinh token đầu
 * → đẩy time-to-first-token lên 1–4s. Với salon chat (câu ngắn, tone fixed)
 * không cần reasoning sâu, set 0 để Google AI Studio-fast.
 */
const THINKING_CONFIG = { thinkingBudget: 0 } as const

type CountTokensResponse = {
  totalTokens?: number
  error?: { message?: string }
}

export async function countTextTokens(
  apiKey: string,
  model: string,
  text: string,
  signal?: AbortSignal,
): Promise<number> {
  const url = geminiUrl(`/models/${encodeURIComponent(model)}:countTokens`, apiKey)
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text }] }],
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(raw || `${res.status} ${res.statusText}`)
  const data = JSON.parse(raw) as CountTokensResponse
  if (data.error?.message) throw new Error(data.error.message)
  const n = data.totalTokens
  if (n == null) throw new Error('countTokens: thiếu totalTokens')
  return n
}

export type ChatImage = { mimeType: string; dataUrl: string }

export type ChatTurn = { role: 'user' | 'model'; text: string; images?: ChatImage[] }

export type UsageInfo = {
  promptTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
}

export type GeminiResult = {
  text: string
  usage?: UsageInfo
}

/** Đo segment (performance.now(), ms). */
export type StreamTiming = {
  /** fetch() → có HTTP response (header). Gồm DNS/TLS/lần đầu + Google nhận request. */
  msToResponseHeaders: number
  /** Có header → token chữ đầu tiên: chờ model/SSE thực sự bắt đầu trả text. */
  msAfterHeadersToFirstToken: number
  /** Token đầu → hết stream: model sinh tiếp + truyền chunk. */
  msStreamGeneration: number
  /** fetch() → stream đọc xong (wall-clock một vòng gọi API). */
  msWallClockFetch: number
}

export type GeminiStreamResult = GeminiResult & { timing: StreamTiming }

type UsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  totalTokenCount?: number
}

type StreamChunk = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  error?: { message?: string }
  usageMetadata?: UsageMetadata
}

type GenerationConfig = {
  maxOutputTokens: number
  temperature: number
  /** Chỉ gửi với model Gemini 3.x (mặc định thinking bật trên API). */
  thinkingConfig?: { thinkingBudget: number }
}

type ContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

type ContentsBody = {
  systemInstruction?: { parts: Array<{ text: string }> }
  cachedContent?: string
  contents: Array<{ role: string; parts: ContentPart[] }>
  generationConfig: GenerationConfig
}

/**
 * Build body cho :generateContent / :streamGenerateContent.
 * - Khi có `cachedContent` → KHÔNG kèm systemInstruction nữa (đã nằm trong cache).
 * - Khi không cache → kèm systemInstruction inline (fallback).
 */
function modelNeedsExplicitThinkingOff(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('gemini-3') || m.includes('/3.')
}

function imageToInlineData(image: ChatImage): { inlineData: { mimeType: string; data: string } } {
  const comma = image.dataUrl.indexOf(',')
  const data = comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl
  return { inlineData: { mimeType: image.mimeType, data } }
}

function turnToParts(turn: ChatTurn): ContentPart[] {
  const parts: ContentPart[] = []
  if (turn.text.trim()) parts.push({ text: turn.text })
  for (const image of turn.images ?? []) {
    parts.push(imageToInlineData(image))
  }
  if (!parts.length) parts.push({ text: '(ảnh)' })
  return parts
}

function buildContents(
  systemPrompt: string,
  history: ChatTurn[],
  model: string,
  cachedContent?: string,
): ContentsBody {
  const gen: GenerationConfig = {
    maxOutputTokens: 768,
    temperature: 0.55,
  }
  if (modelNeedsExplicitThinkingOff(model)) {
    gen.thinkingConfig = { ...THINKING_CONFIG }
  }
  const body: ContentsBody = {
    contents: history.map((h) => ({
      role: h.role,
      parts: turnToParts(h),
    })),
    generationConfig: gen,
  }
  if (cachedContent) {
    body.cachedContent = cachedContent
  } else if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] }
  }
  return body
}

function usageFromMeta(m?: UsageMetadata): UsageInfo | undefined {
  if (!m) return undefined
  return {
    promptTokens: m.promptTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    cachedTokens: m.cachedContentTokenCount ?? 0,
    totalTokens: m.totalTokenCount ?? 0,
  }
}

function textDeltaFromChunk(chunk: StreamChunk): string {
  const parts = chunk.candidates?.[0]?.content?.parts
  if (!parts?.length) return ''
  return parts.map((p) => p.text ?? '').join('')
}

/** Đọc SSE (alt=sse): mỗi dòng data: {json} */
async function* iterateSSE(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ''
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
      if (payload === '[DONE]') continue
      try {
        yield JSON.parse(payload) as StreamChunk
      } catch {
        /* bỏ qua dòng không phải JSON */
      }
    }
  }
}

export type StreamGeminiOptions = {
  /** Giới hạn độ dài trả lời — càng nhỏ càng sớm xong (phù hợp tin salon ngắn). */
  maxOutputTokens?: number
  /**
   * Tên cached content (vd: "cachedContents/abc123"). Khi có → server dùng
   * systemInstruction đã cache → bỏ qua việc gửi/tokenize lại CONTEXT.md
   * mỗi lượt → giảm latency + chi phí input.
   */
  cachedContent?: string
  /** Hủy request (đóng tab / user bấm dừng — nếu sau này có nút dừng). */
  signal?: AbortSignal
}

/**
 * Stream token — chữ hiện ngay, không chờ hết response như generateContent.
 * Endpoint: streamGenerateContent + alt=sse
 */
export async function streamGeminiReply(
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: ChatTurn[],
  onDelta: (delta: string) => void,
  options?: StreamGeminiOptions,
): Promise<GeminiStreamResult> {
  const maxOut = options?.maxOutputTokens ?? 768
  const cachedContent = options?.cachedContent
  const url = geminiUrl(
    `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    apiKey,
  )
  const base = buildContents(systemPrompt, history, model, cachedContent)
  const body = JSON.stringify({
    ...base,
    generationConfig: {
      ...base.generationConfig,
      maxOutputTokens: maxOut,
    },
  })
  const t0 = performance.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: options?.signal,
  })
  const tHeaders = performance.now()
  if (!res.ok) {
    const raw = await res.text()
    throw new Error(raw || `${res.status} ${res.statusText}`)
  }
  if (!res.body) throw new Error('Stream: không có body')

  let full = ''
  let lastUsage: UsageInfo | undefined
  let tFirst: number | null = null

  for await (const chunk of iterateSSE(res.body.getReader())) {
    if (chunk.error?.message) throw new Error(chunk.error.message)
    const delta = textDeltaFromChunk(chunk)
    if (delta) {
      if (tFirst === null) tFirst = performance.now()
      full += delta
      onDelta(delta)
    }
    const u = usageFromMeta(chunk.usageMetadata)
    if (u) lastUsage = u
  }

  const tEnd = performance.now()

  if (!full.trim()) {
    throw new Error('Không có văn bản từ stream')
  }
  if (tFirst === null) {
    throw new Error('Stream: không có token text')
  }

  const timing: StreamTiming = {
    msToResponseHeaders: tHeaders - t0,
    msAfterHeadersToFirstToken: tFirst - tHeaders,
    msStreamGeneration: tEnd - tFirst,
    msWallClockFetch: tEnd - t0,
  }

  return { text: full, usage: lastUsage, timing }
}

/** Không stream — chỉ dùng khi cần so sánh / fallback. */
export async function generateGeminiReply(
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: ChatTurn[],
  options?: StreamGeminiOptions,
): Promise<GeminiResult> {
  const maxOut = options?.maxOutputTokens ?? 768
  const cachedContent = options?.cachedContent
  const url = geminiUrl(`/models/${encodeURIComponent(model)}:generateContent`, apiKey)
  const base = buildContents(systemPrompt, history, model, cachedContent)
  const body = JSON.stringify({
    ...base,
    generationConfig: {
      ...base.generationConfig,
      maxOutputTokens: maxOut,
    },
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: options?.signal,
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(raw || `${res.status} ${res.statusText}`)
  }
  let data: StreamChunk
  try {
    data = JSON.parse(raw) as StreamChunk
  } catch {
    throw new Error(raw.slice(0, 500))
  }
  if (data.error?.message) throw new Error(data.error.message)
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason
    throw new Error(reason ? `Không có văn bản (${reason})` : 'Không có phản hồi từ model')
  }
  return { text, usage: usageFromMeta(data.usageMetadata) }
}

/* -------------------------------------------------------------------------- */
/* Context Caching                                                             */
/* -------------------------------------------------------------------------- */

export type CachedContentInfo = {
  /** Dạng "cachedContents/abc123" — truyền vào StreamGeminiOptions.cachedContent */
  name: string
  expireTime?: string
  model: string
}

/**
 * Tạo cached content cho toàn bộ systemInstruction (tiền tố salon + CONTEXT.md).
 * KHÔNG cache history hội thoại. Mỗi tin chỉ gửi phần chat mới; phần tĩnh đọc từ cache.
 *
 * Lưu ý:
 *  - Yêu cầu min token của context cache thường thấp hơn CONTEXT.md đầy đủ
 *    của salon (~3k token), nên đủ điều kiện.
 *  - Có TTL — sau TTL cache tự xoá. App tạo lại khi cần.
 *  - Nếu model không hỗ trợ cache → throw → caller fallback sang inline.
 */
export async function createCachedContentWithRetry(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds = 3600,
  attempts = 3,
): Promise<CachedContentInfo> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await createCachedContent(apiKey, model, systemPrompt, ttlSeconds)
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 800 * (i + 1)))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function createCachedContent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds = 3600,
  signal?: AbortSignal,
): Promise<CachedContentInfo> {
  const url = geminiUrl('/cachedContents', apiKey)
  const fullModel = model.startsWith('models/') ? model : `models/${model}`
  const body = JSON.stringify({
    model: fullModel,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    ttl: `${ttlSeconds}s`,
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(raw || `${res.status} ${res.statusText}`)
  const data = JSON.parse(raw) as {
    name?: string
    expireTime?: string
    error?: { message?: string }
  }
  if (data.error?.message) throw new Error(data.error.message)
  if (!data.name) throw new Error('cachedContents: thiếu name trong response')
  return { name: data.name, expireTime: data.expireTime, model: fullModel }
}

/** Xoá cache (best-effort — bỏ qua lỗi để không chặn cleanup). */
export async function deleteCachedContent(apiKey: string, name: string): Promise<void> {
  const url = geminiUrl(`/${name}`, apiKey)
  try {
    await fetch(url, { method: 'DELETE' })
  } catch {
    /* ignore */
  }
}
