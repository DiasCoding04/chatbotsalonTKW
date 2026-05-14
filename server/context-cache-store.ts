import { buildContextCacheFingerprint } from '../shared/context-cache-key.ts'
import { createCachedContentWithRetry } from './gemini-cache.ts'

const EXPIRE_BUFFER_MS = 30_000

type CacheEntry = {
  fingerprint: string
  name: string
  expireAt: number
}

const entries = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CacheEntry>>()

function isValid(entry: CacheEntry, fingerprint: string, now = Date.now()): boolean {
  return entry.fingerprint === fingerprint && entry.expireAt > now + EXPIRE_BUFFER_MS
}

export function clearSharedContextCacheStore(): void {
  entries.clear()
  inflight.clear()
}

/** Xoá cache theo đúng model + systemPrompt (vd. cache hết hạn trên Google nhưng entry local còn). */
export function evictSharedContextCache(model: string, systemPrompt: string): void {
  const fingerprint = buildContextCacheFingerprint(model, systemPrompt)
  entries.delete(fingerprint)
}

export async function ensureSharedContextCache(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds: number,
): Promise<{ name: string; reused: boolean; expireAt: number }> {
  const fingerprint = buildContextCacheFingerprint(model, systemPrompt)
  const now = Date.now()
  const existing = entries.get(fingerprint)
  if (existing && isValid(existing, fingerprint, now)) {
    return { name: existing.name, reused: true, expireAt: existing.expireAt }
  }

  let pending = inflight.get(fingerprint)
  if (!pending) {
    pending = (async () => {
      const again = entries.get(fingerprint)
      if (again && isValid(again, fingerprint, now)) return again

      const info = await createCachedContentWithRetry(apiKey, model, systemPrompt, ttlSeconds)
      let expireAt = now + ttlSeconds * 1000
      if (info.expireTime) {
        const parsed = Date.parse(info.expireTime)
        if (Number.isFinite(parsed)) expireAt = parsed
      }
      const entry: CacheEntry = { fingerprint, name: info.name, expireAt }
      entries.set(fingerprint, entry)
      return entry
    })().finally(() => {
      inflight.delete(fingerprint)
    })
    inflight.set(fingerprint, pending)
  }

  const entry = await pending
  return {
    name: entry.name,
    reused: existing?.name === entry.name,
    expireAt: entry.expireAt,
  }
}
