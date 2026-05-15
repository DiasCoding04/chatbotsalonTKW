export type ContextApiDocument = {
  content: string
  updatedAt: string
  requiresEditToken: boolean
}

export type ImageSamplesApiDocument = {
  content: string
  updatedAt: string
  baseUrl?: string
}

export type HealthApiPayload = {
  ok: boolean
  staticBuild?: boolean
  contextEditTokenRequired?: boolean
  publicUrl?: string | null
  geminiProxyKeyInjected?: boolean
  geminiBackend?: 'vertex' | 'developer'
  geminiServerReady?: boolean
}

const TOKEN_STORAGE_KEY = 'salon-context-editor-token'

export function readStoredContextEditToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function storeContextEditToken(token: string): void {
  try {
    const trimmed = token.trim()
    if (!trimmed) {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY)
      return
    }
    sessionStorage.setItem(TOKEN_STORAGE_KEY, trimmed)
  } catch {
    // Ignore storage failures in private mode.
  }
}

export async function fetchServerContext(): Promise<ContextApiDocument | null> {
  const res = await fetch('/api/context', { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Không tải được CONTEXT từ server (${res.status}).`)
  }
  return (await res.json()) as ContextApiDocument
}

export async function fetchServerImageSamples(): Promise<ImageSamplesApiDocument | null> {
  const res = await fetch('/api/image-samples', { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Không tải được IMAGE_SAMPLES từ server (${res.status}).`)
  }
  return (await res.json()) as ImageSamplesApiDocument
}

export async function saveServerContext(
  content: string,
  editToken?: string,
): Promise<ContextApiDocument> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = editToken?.trim()
  if (token) headers['X-Context-Edit-Token'] = token

  const res = await fetch('/api/context', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ content }),
  })

  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(body.error || `Không lưu được CONTEXT (${res.status}).`)
  }
  return body as ContextApiDocument
}

export async function fetchServerHealth(): Promise<HealthApiPayload | null> {
  const res = await fetch('/api/health', { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) return null
  return (await res.json()) as HealthApiPayload
}
