import { buildContextCacheFingerprint } from '../../shared/context-cache-key.ts'
import { createCachedContentWithRetry } from './gemini'

export const SHARED_CONTEXT_CACHE_STORAGE_KEY = 'salon-chat.shared-context-cache'
const LOCK_NAME = 'salon-chat-gemini-context-cache'
const EXPIRE_BUFFER_MS = 30_000

export type SharedContextCacheRecord = {
  fingerprint: string
  name: string
  expireAt: number
}

export type ContextCacheScope = 'server' | 'browser'

export function getContextCacheScope(): ContextCacheScope {
  const raw = (import.meta.env.VITE_CONTEXT_CACHE_SCOPE ?? 'server').toLowerCase().trim()
  return raw === 'browser' ? 'browser' : 'server'
}

export { buildContextCacheFingerprint }

export function readSharedContextCacheRecord(): SharedContextCacheRecord | null {
  try {
    const raw = localStorage.getItem(SHARED_CONTEXT_CACHE_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as SharedContextCacheRecord
    if (!data?.fingerprint || !data?.name || !Number.isFinite(data.expireAt)) return null
    return data
  } catch {
    return null
  }
}

export function writeSharedContextCacheRecord(record: SharedContextCacheRecord): void {
  localStorage.setItem(SHARED_CONTEXT_CACHE_STORAGE_KEY, JSON.stringify(record))
}

/** Sau khi PUT /api/context — fingerprint đổi; xóa cache cũ trên trình duyệt. */
export function clearBrowserSharedContextCache(): void {
  try {
    localStorage.removeItem(SHARED_CONTEXT_CACHE_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

function defaultBrowserContextCacheTtlSeconds(): number {
  const v = Number(import.meta.env.VITE_GEMINI_CONTEXT_CACHE_TTL_S)
  if (Number.isFinite(v) && v > 0) return Math.floor(v)
  return import.meta.env.DEV ? 900 : 3600
}

export function isSharedContextCacheValid(
  record: SharedContextCacheRecord,
  fingerprint: string,
  now = Date.now(),
): boolean {
  return record.fingerprint === fingerprint && record.expireAt > now + EXPIRE_BUFFER_MS
}

async function withBrowserCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(LOCK_NAME, fn)
  }
  return fn()
}

async function resolveBrowserSharedContextCache(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds?: number,
): Promise<{ name: string; reused: boolean }> {
  const ttl = ttlSeconds ?? defaultBrowserContextCacheTtlSeconds()
  const fingerprint = buildContextCacheFingerprint(model, systemPrompt)
  const now = Date.now()
  const existing = readSharedContextCacheRecord()
  if (existing && isSharedContextCacheValid(existing, fingerprint, now)) {
    return { name: existing.name, reused: true }
  }

  return withBrowserCacheLock(async () => {
    const again = readSharedContextCacheRecord()
    if (again && isSharedContextCacheValid(again, fingerprint, now)) {
      return { name: again.name, reused: true }
    }

    const info = await createCachedContentWithRetry(apiKey, model, systemPrompt, ttl)
    let expireAt = now + ttl * 1000
    if (info.expireTime) {
      const parsed = Date.parse(info.expireTime)
      if (Number.isFinite(parsed)) expireAt = parsed
    }
    writeSharedContextCacheRecord({ fingerprint, name: info.name, expireAt })
    return { name: info.name, reused: false }
  })
}

async function resolveServerSharedContextCache(
  model: string,
  systemPrompt: string,
  ttlSeconds?: number,
): Promise<{ name: string; reused: boolean }> {
  const payload: Record<string, unknown> = { model, systemPrompt }
  if (ttlSeconds != null && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    payload.ttlSeconds = ttlSeconds
  }
  const res = await fetch('/api/context-cache/ensure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(raw || `${res.status} ${res.statusText}`)
  }
  const data = JSON.parse(raw) as {
    mode?: string
    name?: string | null
    reused?: boolean
    error?: string
    estimatedTokens?: number
    reason?: string
  }
  if (data.error) throw new Error(data.error)
  if (data.mode === 'inline' || !data.name) {
    return { name: '', reused: false }
  }
  return { name: data.name, reused: Boolean(data.reused) }
}

export async function resolveSharedContextCache(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds?: number,
): Promise<{ name: string; reused: boolean }> {
  if (getContextCacheScope() === 'browser') {
    return resolveBrowserSharedContextCache(apiKey, model, systemPrompt, ttlSeconds)
  }
  return resolveServerSharedContextCache(model, systemPrompt, ttlSeconds)
}
