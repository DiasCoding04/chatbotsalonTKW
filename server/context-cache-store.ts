import { buildContextCacheFingerprint } from '../shared/context-cache-key.ts'
import {
  estimateContextCacheTokens,
  GEMINI_CONTEXT_CACHE_MIN_TOKENS,
  isContextCacheEligible,
} from '../shared/context-cache-eligibility.ts'
import {
  clearContextCacheActivityInFirestore,
  clearSharedContextCacheInFirestore,
  deleteSharedContextCacheFromFirestore,
  readContextCacheLastActivityMs,
  readContextFromFirestore,
  releaseContextCacheCreateLock,
  tryAcquireContextCacheCreateLock,
  touchContextCacheActivityInFirestore,
  useFirestoreContextBackend,
  writeSharedContextCacheToFirestore,
} from './context-firestore.ts'
import {
  ContextCacheIneligibleError,
  createCachedContentWithRetry,
  deleteCachedContent,
  listAllCachedContentNames,
} from './gemini-cache.ts'

const DEFAULT_CACHE_IDLE_MS = 30 * 60 * 1000
const DEFAULT_ACTIVITY_TOUCH_INTERVAL_MS = 5 * 60 * 1000

export function resolveContextCacheIdleMs(): number {
  const raw = process.env.GEMINI_CONTEXT_CACHE_IDLE_MS?.trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 60_000) return Math.floor(n)
  }
  return DEFAULT_CACHE_IDLE_MS
}

function resolveContextCacheActivityTouchIntervalMs(): number {
  const raw = process.env.GEMINI_CONTEXT_CACHE_ACTIVITY_TOUCH_INTERVAL_MS?.trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 1_000) return Math.floor(n)
  }
  return DEFAULT_ACTIVITY_TOUCH_INTERVAL_MS
}

let lastActivityTouchAt = 0

/** Tin AI mới — gia hạn idle window, nhưng không ghi Firestore cho từng request. */
export async function touchContextCacheActivity(): Promise<void> {
  if (!useFirestoreContextBackend()) return
  const now = Date.now()
  if (now - lastActivityTouchAt < resolveContextCacheActivityTouchIntervalMs()) return
  await touchContextCacheActivityInFirestore(now)
  lastActivityTouchAt = now
}

export type SharedContextCacheResult =
  | {
      mode: 'cached'
      name: string
      reused: boolean
      expireAt: number
      estimatedTokens: number
    }
  | {
      mode: 'inline'
      name: null
      reused: false
      expireAt: number
      estimatedTokens: number
      reason: 'below_min_tokens'
    }

const EXPIRE_BUFFER_MS = 30_000

type CacheEntry = {
  fingerprint: string
  name: string
  expireAt: number
}

const entries = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CacheEntry | null>>()
let ensureCacheSerial: Promise<void> = Promise.resolve()

/** TTL giữa các lần list+reconcile Vertex (file backend; Firestore dùng registry). */
const RECONCILE_MIN_INTERVAL_MS = 30 * 60 * 1000
let lastReconcileAt = 0

const EXPIRE_BUFFER_MS_FIRESTORE = 30_000

async function finishCachedResult(
  result: SharedContextCacheResult,
): Promise<SharedContextCacheResult> {
  if (result.mode === 'cached') {
    await touchContextCacheActivity()
  }
  return result
}

/** File backend cũ: giữ tối đa 1 cache remote để tránh rác local-dev. */
async function enforceRemoteSingletonKeepOnly(apiKey: string, keepName: string): Promise<number> {
  const keep = keepName.trim()
  if (!keep) return 0
  let remoteNames: string[] = []
  try {
    remoteNames = await listAllCachedContentNames(apiKey)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[context-cache] enforce singleton list failed:', msg)
    return 0
  }
  let n = 0
  for (const name of remoteNames) {
    if (name.trim() === keep) continue
    await deleteCachedContent(apiKey, name)
    n += 1
  }
  if (n > 0) {
    console.log(`[context-cache] singleton: deleted ${n} extra remote cache(s)`)
  }
  return n
}

async function adoptFirestoreSharedCache(
  apiKey: string,
  fingerprint: string,
  estimatedTokens: number,
): Promise<SharedContextCacheResult | null> {
  const doc = await readContextFromFirestore()
  const shared = doc?.sharedContextCaches.find((record) => record.fingerprint === fingerprint)
  if (!shared) return null
  if (shared.expireAtMs <= Date.now() + EXPIRE_BUFFER_MS_FIRESTORE) return null

  entries.set(fingerprint, {
    fingerprint,
    name: shared.name,
    expireAt: shared.expireAtMs,
  })

  return finishCachedResult({
    mode: 'cached',
    name: shared.name,
    reused: true,
    expireAt: shared.expireAtMs,
    estimatedTokens,
  })
}

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

/** Bỏ entry local và xoá bản ghi cache trên Google (dừng billing storage sớm). */
export async function evictSharedContextCacheAndDeleteRemote(
  apiKey: string,
  model: string,
  systemPrompt: string,
): Promise<void> {
  const fingerprint = buildContextCacheFingerprint(model, systemPrompt)
  const entry = entries.get(fingerprint)
  entries.delete(fingerprint)
  if (entry) {
    await deleteCachedContent(apiKey, entry.name)
  }
  if (useFirestoreContextBackend()) {
    await deleteSharedContextCacheFromFirestore(fingerprint)
    return
  }
  await reconcileSingletonRemoteContextCache(apiKey, fingerprint)
}

/**
 * Đảm bảo trên Vertex/Google chỉ còn tối đa 1 cachedContent (hoặc 0 trước khi tạo mới).
 * Trả về số bản ghi đã xóa.
 */
export async function reconcileSingletonRemoteContextCache(
  apiKey: string,
  fingerprint: string,
): Promise<number> {
  let remoteNames: string[] = []
  try {
    remoteNames = await listAllCachedContentNames(apiKey)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[context-cache] list failed during reconcile:', msg)
    return 0
  }

  const local = entries.get(fingerprint)
  const localName = local?.name?.trim()

  if (remoteNames.length === 0) {
    if (local) entries.delete(fingerprint)
    lastReconcileAt = Date.now()
    return 0
  }

  if (remoteNames.length === 1) {
    const only = remoteNames[0]!.trim()
    if (local && localName === only && isValid(local, fingerprint)) {
      lastReconcileAt = Date.now()
      return 0
    }
    let expireAt = local?.expireAt ?? Date.now() + 3_600_000
    if (!local || localName !== only) {
      entries.set(fingerprint, { fingerprint, name: only, expireAt })
      console.log('[context-cache] singleton: adopted remote cache', only.slice(-24))
    }
    lastReconcileAt = Date.now()
    return 0
  }

  const keep =
    localName && remoteNames.some((n) => n.trim() === localName) ? localName : remoteNames[0]!.trim()
  let n = 0
  for (const name of remoteNames) {
    const trimmed = name.trim()
    if (trimmed === keep) continue
    await deleteCachedContent(apiKey, trimmed)
    n += 1
  }
  entries.set(fingerprint, {
    fingerprint,
    name: keep,
    expireAt: local?.expireAt ?? Date.now() + 3_600_000,
  })
  if (n > 0) {
    console.log(`[context-cache] singleton reconcile: deleted ${n} duplicate remote cache(s)`)
  }
  lastReconcileAt = Date.now()
  return n
}

/** Không có tin mới trong cửa sổ idle → xóa cache Vertex (tiết kiệm storage). */
export async function evictContextCacheIfIdle(apiKey: string): Promise<boolean> {
  if (!useFirestoreContextBackend()) return false

  const lastMs = await readContextCacheLastActivityMs()
  if (lastMs == null) return false

  const idleMs = resolveContextCacheIdleMs()
  if (Date.now() - lastMs < idleMs) return false

  const deleted = await purgeAllSharedContextCachesRemote(apiKey)
  await clearContextCacheActivityInFirestore()
  console.log(
    `[context-cache] Idle ${Math.round(idleMs / 60_000)} phút — đã xóa ${deleted} cache remote`,
  )
  return true
}

/**
 * Xoá 100% cachedContent trên Google/Vertex (list API + entry local) và làm sạch store.
 * Dùng khi deploy, sửa CONTEXT — tránh cache cũ treo phí storage.
 */
export async function purgeAllSharedContextCachesRemote(apiKey: string): Promise<number> {
  await Promise.allSettled([...inflight.values()])
  inflight.clear()

  let remoteNames: string[] = []
  try {
    remoteNames = await listAllCachedContentNames(apiKey)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[context-cache] listAllCachedContentNames failed — purge local only:', msg)
  }

  const seen = new Set<string>()
  const toDelete: string[] = []
  for (const name of [...remoteNames, ...[...entries.values()].map((e) => e.name)]) {
    const trimmed = name.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    toDelete.push(trimmed)
  }

  let n = 0
  for (const name of toDelete) {
    await deleteCachedContent(apiKey, name)
    n += 1
  }
  entries.clear()
  lastReconcileAt = Date.now()
  lastActivityTouchAt = 0
  await clearContextCacheActivityInFirestore().catch(() => undefined)
  await clearSharedContextCacheInFirestore().catch(() => undefined)
  return n
}

export async function ensureSharedContextCache(
  apiKey: string,
  model: string,
  systemPrompt: string,
  ttlSeconds: number,
): Promise<SharedContextCacheResult> {
  await evictContextCacheIfIdle(apiKey)

  const fingerprint = buildContextCacheFingerprint(model, systemPrompt)
  const estimatedTokens = estimateContextCacheTokens(systemPrompt)
  const now = Date.now()

  if (!isContextCacheEligible(systemPrompt)) {
    console.warn(
      `[context-cache] Bỏ qua tạo cache — ước tính ${estimatedTokens} token (< ${GEMINI_CONTEXT_CACHE_MIN_TOKENS}). Dùng inline systemInstruction.`,
    )
    return {
      mode: 'inline',
      name: null,
      reused: false,
      expireAt: now,
      estimatedTokens,
      reason: 'below_min_tokens',
    }
  }

  if (useFirestoreContextBackend()) {
    const fromRegistry = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens)
    if (fromRegistry) return fromRegistry
  }

  const existing = entries.get(fingerprint)

  if (existing && isValid(existing, fingerprint, now)) {
    if (useFirestoreContextBackend() || now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
      return finishCachedResult({
        mode: 'cached',
        name: existing.name,
        reused: true,
        expireAt: existing.expireAt,
        estimatedTokens,
      })
    }
    const deleted = await reconcileSingletonRemoteContextCache(apiKey, fingerprint)
    if (deleted === 0) {
      return finishCachedResult({
        mode: 'cached',
        name: existing.name,
        reused: true,
        expireAt: existing.expireAt,
        estimatedTokens,
      })
    }
  }

  let pending = inflight.get(fingerprint)
  if (!pending) {
    pending = ensureCacheSerial
      .then(async () => {
        const again = entries.get(fingerprint)
        if (again && isValid(again, fingerprint, now)) {
          if (useFirestoreContextBackend() || now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
            return again
          }
          const deleted = await reconcileSingletonRemoteContextCache(apiKey, fingerprint)
          if (deleted === 0) return again
        }

        if (useFirestoreContextBackend()) {
          const raced = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens)
          if (raced) return entries.get(fingerprint) ?? null

          const gotLock = await tryAcquireContextCacheCreateLock()
          if (!gotLock) {
            for (let w = 0; w < 12; w++) {
              await new Promise((r) => setTimeout(r, 500))
              const waited = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens)
              if (waited) return entries.get(fingerprint) ?? null
            }
            console.warn('[context-cache] Không lấy được lock tạo cache — dùng inline.')
            return null
          }

          try {
            const again = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens)
            if (again) return entries.get(fingerprint) ?? null

            const info = await createCachedContentWithRetry(apiKey, model, systemPrompt, ttlSeconds)
            let expireAt = now + ttlSeconds * 1000
            if (info.expireTime) {
              const parsed = Date.parse(info.expireTime)
              if (Number.isFinite(parsed)) expireAt = parsed
            }
            await writeSharedContextCacheToFirestore({
              name: info.name,
              fingerprint,
              expireAtMs: expireAt,
            })
            const entry: CacheEntry = { fingerprint, name: info.name, expireAt }
            entries.set(fingerprint, entry)
            console.log(
              '[context-cache] registry: created cache',
              `fp=${fingerprint}`,
              info.name.slice(-24),
            )
            return entry
          } finally {
            await releaseContextCacheCreateLock()
          }
        }

        await reconcileSingletonRemoteContextCache(apiKey, fingerprint)

        try {
          const info = await createCachedContentWithRetry(apiKey, model, systemPrompt, ttlSeconds)
          let expireAt = now + ttlSeconds * 1000
          if (info.expireTime) {
            const parsed = Date.parse(info.expireTime)
            if (Number.isFinite(parsed)) expireAt = parsed
          }
          const entry: CacheEntry = { fingerprint, name: info.name, expireAt }
          entries.set(fingerprint, entry)
          console.log('[context-cache] singleton: created 1 cache', info.name.slice(-24))
          return entry
        } catch (e) {
          if (e instanceof ContextCacheIneligibleError) {
            console.warn('[context-cache]', e.message)
            return null
          }
          throw e
        }
      })
      .finally(() => {
        inflight.delete(fingerprint)
      })
    inflight.set(fingerprint, pending)
    ensureCacheSerial = pending.then(() => undefined).catch(() => undefined)
  }

  const entry = await pending
  if (!entry) {
    return {
      mode: 'inline',
      name: null,
      reused: false,
      expireAt: now,
      estimatedTokens,
      reason: 'below_min_tokens',
    }
  }
  return finishCachedResult({
    mode: 'cached',
    name: entry.name,
    reused: existing?.name === entry.name,
    expireAt: entry.expireAt,
    estimatedTokens,
  })
}
