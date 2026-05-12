import type { ChatTurn, StreamTiming, UsageInfo } from './gemini'

const API_BASE = '/openai-api/v1'

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

export type StreamOpenaiOptions = {
  maxOutputTokens?: number
  signal?: AbortSignal
}

export type OpenaiStreamResult = {
  text: string
  usage?: UsageInfo
  timing: StreamTiming
}

type OpenaiTextPart = { type: 'text'; text: string }
type OpenaiImagePart = { type: 'image_url'; image_url: { url: string } }
type OpenaiContentPart = OpenaiTextPart | OpenaiImagePart
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenaiContentPart[] }
  | { role: 'assistant'; content: string }

type StreamChunk = {
  choices?: Array<{ delta?: { content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string }
}

function toOpenAiMessages(systemPrompt: string, history: ChatTurn[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  if (systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt })
  for (const h of history) {
    if (h.role === 'model') {
      msgs.push({ role: 'assistant', content: h.text })
      continue
    }
    const images = h.images ?? []
    if (!images.length) {
      msgs.push({ role: 'user', content: h.text })
      continue
    }
    const content: OpenaiContentPart[] = []
    if (h.text.trim()) content.push({ type: 'text', text: h.text })
    for (const image of images) {
      content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
    }
    if (!content.length) content.push({ type: 'text', text: '(ảnh)' })
    msgs.push({ role: 'user', content })
  }
  return msgs
}

function usageFromChunk(chunk: StreamChunk): UsageInfo | undefined {
  const u = chunk.usage
  if (!u) return undefined
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  return {
    promptTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedTokens: cached,
    totalTokens: u.total_tokens ?? 0,
  }
}

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
      if (!payload || payload === '[DONE]') continue
      try {
        yield JSON.parse(payload) as StreamChunk
      } catch {
        /* bỏ qua dòng không phải JSON */
      }
    }
  }
}

export async function streamOpenaiReply(
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: ChatTurn[],
  onDelta: (delta: string) => void,
  options?: StreamOpenaiOptions,
): Promise<OpenaiStreamResult> {
  const maxOut = options?.maxOutputTokens ?? 256
  const url = `${API_BASE}/chat/completions`
  const body = JSON.stringify({
    model,
    messages: toOpenAiMessages(systemPrompt, history),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxOut,
    temperature: 0.55,
  })

  const t0 = performance.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
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
    const delta = chunk.choices?.[0]?.delta?.content
    if (delta) {
      if (tFirst === null) tFirst = performance.now()
      full += delta
      onDelta(delta)
    }
    const u = usageFromChunk(chunk)
    if (u) lastUsage = u
  }

  const tEnd = performance.now()
  if (!full.trim()) throw new Error('Không có văn bản từ stream')
  if (tFirst === null) throw new Error('Stream: không có token text')

  return {
    text: full,
    usage: lastUsage,
    timing: {
      msToResponseHeaders: tHeaders - t0,
      msAfterHeadersToFirstToken: tFirst - tHeaders,
      msStreamGeneration: tEnd - tFirst,
      msWallClockFetch: tEnd - t0,
    },
  }
}
