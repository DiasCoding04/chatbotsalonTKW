import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  contextFirestoreDocName,
  contextFirestoreDocUrl,
  fetchFirestoreWithAuth,
  firestoreCommitUrl,
  resolveFirestoreProjectId,
} from './firestore-rest.ts'

export type FirestoreContextRecord = {
  content: string
  updatedAt: string
  contextCacheLastActivityAt: string | null
  sharedContextCache: SharedContextCacheRecord | null
  sharedContextCaches: SharedContextCacheRecord[]
  contextCacheLockOwner: string | null
  contextCacheLockUntilMs: number | null
  updateTime: string | null
}

/** Một cache Vertex dùng chung cho đúng một fingerprint. */
export type SharedContextCacheRecord = {
  name: string
  fingerprint: string
  expireAtMs: number
}

type FirestoreFields = {
  content?: { stringValue?: string }
  updatedAt?: { stringValue?: string }
  contextCacheLastActivityAt?: { stringValue?: string }
  contextCacheName?: { stringValue?: string }
  contextCacheFingerprint?: { stringValue?: string }
  contextCacheExpireAt?: { stringValue?: string }
  contextCachesJson?: { stringValue?: string }
  contextCacheLockOwner?: { stringValue?: string }
  contextCacheLockUntil?: { stringValue?: string }
}

const MAX_SHARED_CONTEXT_CACHE_RECORDS = 32

function parseSharedCache(fields?: FirestoreFields): SharedContextCacheRecord | null {
  const name = fields?.contextCacheName?.stringValue?.trim()
  const fingerprint = fields?.contextCacheFingerprint?.stringValue?.trim()
  const expireRaw = fields?.contextCacheExpireAt?.stringValue?.trim()
  if (!name || !fingerprint || !expireRaw) return null
  const expireAtMs = Date.parse(expireRaw)
  if (!Number.isFinite(expireAtMs)) return null
  return { name, fingerprint, expireAtMs }
}

function parseSharedCaches(fields?: FirestoreFields): SharedContextCacheRecord[] {
  const raw = fields?.contextCachesJson?.stringValue?.trim()
  const records: SharedContextCacheRecord[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue
          const candidate = item as Partial<SharedContextCacheRecord>
          if (
            typeof candidate.name !== 'string' ||
            typeof candidate.fingerprint !== 'string' ||
            typeof candidate.expireAtMs !== 'number' ||
            !Number.isFinite(candidate.expireAtMs)
          ) {
            continue
          }
          const name = candidate.name.trim()
          const fingerprint = candidate.fingerprint.trim()
          if (!name || !fingerprint) continue
          records.push({ name, fingerprint, expireAtMs: candidate.expireAtMs })
        }
      }
    } catch {
      /* Legacy documents simply won't have the JSON registry yet. */
    }
  }

  const legacy = parseSharedCache(fields)
  if (legacy && !records.some((record) => record.fingerprint === legacy.fingerprint)) {
    records.push(legacy)
  }

  return records
    .sort((a, b) => b.expireAtMs - a.expireAtMs)
    .slice(0, MAX_SHARED_CONTEXT_CACHE_RECORDS)
}

function parseFirestoreDoc(
  raw: string,
  status: number,
): (FirestoreContextRecord & { updateTime: string | null }) | null {
  if (status === 404) return null
  const doc = JSON.parse(raw) as {
    fields?: FirestoreFields
    updateTime?: string
    error?: { message?: string }
  }
  if (doc.error?.message) throw new Error(doc.error.message)
  const content = doc.fields?.content?.stringValue ?? ''
  const updatedAt = doc.fields?.updatedAt?.stringValue?.trim() || new Date().toISOString()
  const activity = doc.fields?.contextCacheLastActivityAt?.stringValue?.trim() || null
  const sharedContextCaches = parseSharedCaches(doc.fields)
  const lockUntilRaw = doc.fields?.contextCacheLockUntil?.stringValue?.trim()
  const lockUntilMs = lockUntilRaw ? Date.parse(lockUntilRaw) : NaN
  return {
    content,
    updatedAt,
    contextCacheLastActivityAt: activity,
    sharedContextCache: sharedContextCaches[0] ?? null,
    sharedContextCaches,
    contextCacheLockOwner: doc.fields?.contextCacheLockOwner?.stringValue?.trim() || null,
    contextCacheLockUntilMs: Number.isFinite(lockUntilMs) ? lockUntilMs : null,
    updateTime: doc.updateTime?.trim() || null,
  }
}

export function useFirestoreContextBackend(): boolean {
  const raw = process.env.CONTEXT_BACKEND?.trim().toLowerCase()
  if (raw === 'file') return false
  if (raw === 'firestore') return Boolean(resolveFirestoreProjectId())
  return Boolean(process.env.K_SERVICE && resolveFirestoreProjectId())
}

export async function readContextFromFirestore(): Promise<FirestoreContextRecord | null> {
  if (!resolveFirestoreProjectId()) return null
  const res = await fetchFirestoreWithAuth(contextFirestoreDocUrl())
  const raw = await res.text()
  if (!res.ok && res.status !== 404) {
    throw new Error(raw || `Firestore CONTEXT read failed (${res.status})`)
  }
  return parseFirestoreDoc(raw, res.status)
}

export async function writeContextToFirestore(
  content: string,
  updatedAt: string,
): Promise<FirestoreContextRecord> {
  if (!resolveFirestoreProjectId()) {
    throw new Error('Firestore CONTEXT: thiếu project id.')
  }

  const existing = await readContextFromFirestore()
  const fields: FirestoreFields = {
    content: { stringValue: content },
    updatedAt: { stringValue: updatedAt },
  }
  if (existing?.contextCacheLastActivityAt) {
    fields.contextCacheLastActivityAt = { stringValue: existing.contextCacheLastActivityAt }
  }

  const write: Record<string, unknown> = {
    update: {
      name: contextFirestoreDocName(),
      fields,
    },
    updateMask: { fieldPaths: ['content', 'updatedAt'] },
  }
  if (existing == null) {
    write.currentDocument = { exists: false }
  }

  const res = await fetchFirestoreWithAuth(firestoreCommitUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [write] }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(raw || `Firestore CONTEXT write failed (${res.status})`)

  return {
    content,
    updatedAt,
    contextCacheLastActivityAt: existing?.contextCacheLastActivityAt ?? null,
    sharedContextCache: null,
    sharedContextCaches: [],
    contextCacheLockOwner: null,
    contextCacheLockUntilMs: null,
    updateTime: null,
  }
}

export async function readFirestoreContextDoc(): Promise<FirestoreContextRecord | null> {
  return readContextFromFirestore()
}

export async function writeSharedContextCacheToFirestore(
  record: SharedContextCacheRecord,
): Promise<void> {
  if (!resolveFirestoreProjectId()) return
  const existing = await readContextFromFirestore()
  const now = Date.now()
  const merged = [
    record,
    ...(existing?.sharedContextCaches ?? []).filter(
      (item) =>
        item.fingerprint !== record.fingerprint &&
        item.expireAtMs > now &&
        item.name.trim().length > 0,
    ),
  ]
    .sort((a, b) => b.expireAtMs - a.expireAtMs)
    .slice(0, MAX_SHARED_CONTEXT_CACHE_RECORDS)
  const res = await fetchFirestoreWithAuth(firestoreCommitUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: contextFirestoreDocName(),
            fields: {
              contextCacheName: { stringValue: record.name },
              contextCacheFingerprint: { stringValue: record.fingerprint },
              contextCacheExpireAt: { stringValue: new Date(record.expireAtMs).toISOString() },
              contextCachesJson: { stringValue: JSON.stringify(merged) },
              contextCacheLockOwner: { nullValue: null },
              contextCacheLockUntil: { nullValue: null },
            },
          },
          updateMask: {
            fieldPaths: [
              'contextCacheName',
              'contextCacheFingerprint',
              'contextCacheExpireAt',
              'contextCachesJson',
              'contextCacheLockOwner',
              'contextCacheLockUntil',
            ],
          },
        },
      ],
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(raw || `Firestore shared cache write failed (${res.status})`)
}

export async function deleteSharedContextCacheFromFirestore(fingerprint: string): Promise<void> {
  if (!resolveFirestoreProjectId()) return
  const existing = await readContextFromFirestore()
  if (!existing) return
  const next = existing.sharedContextCaches.filter((record) => record.fingerprint !== fingerprint)
  const latest = next[0] ?? null
  const res = await fetchFirestoreWithAuth(firestoreCommitUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: contextFirestoreDocName(),
            fields: {
              contextCacheName: latest ? { stringValue: latest.name } : { nullValue: null },
              contextCacheFingerprint: latest
                ? { stringValue: latest.fingerprint }
                : { nullValue: null },
              contextCacheExpireAt: latest
                ? { stringValue: new Date(latest.expireAtMs).toISOString() }
                : { nullValue: null },
              contextCachesJson: { stringValue: JSON.stringify(next) },
            },
          },
          updateMask: {
            fieldPaths: [
              'contextCacheName',
              'contextCacheFingerprint',
              'contextCacheExpireAt',
              'contextCachesJson',
            ],
          },
        },
      ],
    }),
  })
  const raw = await res.text()
  if (!res.ok && res.status !== 404) {
    console.warn('[context-firestore] deleteSharedContextCache failed:', raw.slice(0, 300))
  }
}

export async function clearSharedContextCacheInFirestore(): Promise<void> {
  if (!resolveFirestoreProjectId()) return
  const res = await fetchFirestoreWithAuth(firestoreCommitUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: contextFirestoreDocName(),
            fields: {
              contextCacheName: { nullValue: null },
              contextCacheFingerprint: { nullValue: null },
              contextCacheExpireAt: { nullValue: null },
              contextCachesJson: { nullValue: null },
              contextCacheLockOwner: { nullValue: null },
              contextCacheLockUntil: { nullValue: null },
            },
          },
          updateMask: {
            fieldPaths: [
              'contextCacheName',
              'contextCacheFingerprint',
              'contextCacheExpireAt',
              'contextCachesJson',
              'contextCacheLockOwner',
              'contextCacheLockUntil',
            ],
          },
        },
      ],
    }),
  })
  if (!res.ok && res.status !== 404) {
    const raw = await res.text()
    console.warn('[context-firestore] clearSharedContextCache failed:', raw.slice(0, 300))
  }
}

function instanceLockOwnerId(): string {
  const rev = process.env.K_REVISION?.trim() || 'local'
  const host = process.env.HOSTNAME?.trim() || ''
  return `${rev}:${host || process.pid}`
}

/**
 * Chỉ một instance được tạo cache — optimistic lock trên salon_context (updateTime).
 */
export async function tryAcquireContextCacheCreateLock(leaseMs = 90_000): Promise<boolean> {
  if (!resolveFirestoreProjectId()) return true

  const owner = instanceLockOwnerId()
  const untilIso = new Date(Date.now() + leaseMs).toISOString()

  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await readContextFromFirestore()
    if (!doc?.updateTime) {
      await seedFirestoreContextFromPublicIfEmpty().catch(() => undefined)
      continue
    }

    const lockActive =
      doc.contextCacheLockUntilMs != null &&
      doc.contextCacheLockUntilMs > Date.now() &&
      doc.contextCacheLockOwner &&
      doc.contextCacheLockOwner !== owner

    if (lockActive) {
      await new Promise((r) => setTimeout(r, 400 + attempt * 300))
      continue
    }

    const commitRes = await fetchFirestoreWithAuth(firestoreCommitUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: contextFirestoreDocName(),
              fields: {
                contextCacheLockOwner: { stringValue: owner },
                contextCacheLockUntil: { stringValue: untilIso },
              },
            },
            updateMask: { fieldPaths: ['contextCacheLockOwner', 'contextCacheLockUntil'] },
            currentDocument: { updateTime: doc.updateTime },
          },
        ],
      }),
    })
    if (commitRes.ok) return true
    await new Promise((r) => setTimeout(r, 300 + attempt * 200))
  }
  return false
}

export async function releaseContextCacheCreateLock(): Promise<void> {
  if (!resolveFirestoreProjectId()) return
  await fetchFirestoreWithAuth(firestoreCommitUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: contextFirestoreDocName(),
            fields: {
              contextCacheLockOwner: { nullValue: null },
              contextCacheLockUntil: { nullValue: null },
            },
          },
          updateMask: { fieldPaths: ['contextCacheLockOwner', 'contextCacheLockUntil'] },
        },
      ],
    }),
  }).catch(() => undefined)
}

export async function readContextCacheLastActivityMs(): Promise<number | null> {
  const doc = await readContextFromFirestore()
  if (!doc?.contextCacheLastActivityAt) return null
  const parsed = Date.parse(doc.contextCacheLastActivityAt)
  return Number.isFinite(parsed) ? parsed : null
}

export async function touchContextCacheActivityInFirestore(now = Date.now()): Promise<void> {
  if (!resolveFirestoreProjectId()) return
  const iso = new Date(now).toISOString()
  const res = await fetchFirestoreWithAuth(firestoreCommitUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: contextFirestoreDocName(),
            fields: {
              contextCacheLastActivityAt: { stringValue: iso },
            },
          },
          updateMask: { fieldPaths: ['contextCacheLastActivityAt'] },
        },
      ],
    }),
  })
  const raw = await res.text()
  if (!res.ok && res.status !== 404) {
    console.warn('[context-firestore] touchContextCacheLastActivity failed:', raw.slice(0, 300))
  }
}

export async function clearContextCacheActivityInFirestore(): Promise<void> {
  if (!resolveFirestoreProjectId()) return
  const res = await fetchFirestoreWithAuth(firestoreCommitUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: contextFirestoreDocName(),
            fields: {
              contextCacheLastActivityAt: { nullValue: null },
            },
          },
          updateMask: { fieldPaths: ['contextCacheLastActivityAt'] },
        },
      ],
    }),
  })
  if (!res.ok && res.status !== 404) {
    const raw = await res.text()
    console.warn('[context-firestore] clearContextCacheLastActivity failed:', raw.slice(0, 300))
  }
}

const SEED_FILE = resolve(process.cwd(), 'public', 'CONTEXT.md')

export async function seedFirestoreContextFromPublicIfEmpty(): Promise<boolean> {
  const existing = await readContextFromFirestore()
  if (existing && existing.content.trim().length >= 8) return false

  let seed = '# Salon context\n\n'
  try {
    seed = await readFile(SEED_FILE, 'utf8')
  } catch {
    /* use minimal fallback */
  }

  const updatedAt = new Date().toISOString()
  await writeContextToFirestore(seed, updatedAt)
  console.log(
    `[context-firestore] Seeded Firestore CONTEXT (${seed.length} chars) from public/CONTEXT.md`,
  )
  return true
}
