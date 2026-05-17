/**
 * Lưu user + page token trên Firestore/file để redeploy không mất token đã refresh.
 * Load lúc khởi động → refresh Graph → ghi lại vault.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clearVertexAccessTokenCache, getVertexAccessToken } from './vertex-auth.ts'
import type { FacebookPageTokenRow } from './facebook-token-refresh.ts'

const DATA_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data')
const VAULT_FILE =
  process.env.FACEBOOK_TOKEN_VAULT_PATH?.trim() ||
  resolve(DATA_DIR, 'facebook-token-vault.json')
const VAULT_BACKEND =
  process.env.FACEBOOK_TOKEN_VAULT_BACKEND?.trim().toLowerCase() ||
  process.env.FACEBOOK_STORE_BACKEND?.trim().toLowerCase() ||
  (process.env.K_SERVICE ? 'firestore' : 'file')
const FIRESTORE_PROJECT_ID =
  process.env.FACEBOOK_TOKEN_VAULT_FIRESTORE_PROJECT_ID?.trim() ||
  process.env.FACEBOOK_STORE_FIRESTORE_PROJECT_ID?.trim() ||
  process.env.VERTEX_AI_PROJECT_ID?.trim() ||
  process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
  ''
const FIRESTORE_DATABASE =
  process.env.FACEBOOK_TOKEN_VAULT_FIRESTORE_DATABASE?.trim() ||
  process.env.FACEBOOK_STORE_FIRESTORE_DATABASE?.trim() ||
  '(default)'
const FIRESTORE_COLLECTION =
  process.env.FACEBOOK_TOKEN_VAULT_FIRESTORE_COLLECTION?.trim() ||
  process.env.FACEBOOK_STORE_FIRESTORE_COLLECTION?.trim() ||
  'salon_chat'
const FIRESTORE_DOC_ID =
  process.env.FACEBOOK_TOKEN_VAULT_FIRESTORE_DOC_ID?.trim() || 'facebook_token_vault'

export type FacebookTokenVault = {
  updatedAt: string
  userAccessToken: string
  /** pageId → page access token */
  pageTokens: Record<string, string>
  pageNames?: Record<string, string>
  lastRefreshOk: boolean
  lastRefreshMessage?: string
}

type FirestoreDoc = {
  fields?: {
    json?: { stringValue?: string }
  }
}

function firestoreDocName(): string {
  return `projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE}/documents/${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`
}

function firestoreDocUrl(): string {
  return `https://firestore.googleapis.com/v1/${firestoreDocName()}`
}

async function fetchFirestoreWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getVertexAccessToken()
  let res = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })
  if (res.status !== 401) return res
  clearVertexAccessTokenCache()
  token = await getVertexAccessToken()
  return fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })
}

export function vaultFromPageRows(
  userToken: string,
  pages: FacebookPageTokenRow[],
  refresh: { ok: boolean; message: string },
): FacebookTokenVault {
  const pageTokens: Record<string, string> = {}
  const pageNames: Record<string, string> = {}
  for (const p of pages) {
    pageTokens[p.id] = p.access_token
    pageNames[p.id] = p.name
  }
  return {
    updatedAt: new Date().toISOString(),
    userAccessToken: userToken,
    pageTokens,
    pageNames,
    lastRefreshOk: refresh.ok,
    lastRefreshMessage: refresh.message,
  }
}

export function applyVaultToProcessEnv(vault: FacebookTokenVault): number {
  const entries = Object.entries(vault.pageTokens).filter(([, t]) => t?.trim())
  if (!entries.length) return 0
  const tokens = entries.map(([, t]) => t.trim())
  process.env.FACEBOOK_PAGE_ACCESS_TOKENS = tokens.join(',')
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = tokens[0]
  if (vault.userAccessToken?.trim()) {
    process.env.FACEBOOK_USER_ACCESS_TOKEN = vault.userAccessToken.trim()
  }
  return entries.length
}

function resolveVaultReadCacheMs(): number {
  const raw = process.env.FACEBOOK_TOKEN_VAULT_CACHE_MS?.trim()
  if (raw === '0') return 0
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return n
  return 30_000
}

let vaultMemCache: { vault: FacebookTokenVault | null; at: number } | null = null

export function invalidateFacebookTokenVaultCache(): void {
  vaultMemCache = null
}

async function loadFacebookTokenVaultUncached(): Promise<FacebookTokenVault | null> {
  if (VAULT_BACKEND === 'file') {
    try {
      const raw = await readFile(VAULT_FILE, 'utf8')
      const parsed = JSON.parse(raw) as Partial<FacebookTokenVault>
      if (!parsed.userAccessToken || !parsed.pageTokens) return null
      return {
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        userAccessToken: parsed.userAccessToken,
        pageTokens: parsed.pageTokens,
        pageNames: parsed.pageNames,
        lastRefreshOk: parsed.lastRefreshOk !== false,
        lastRefreshMessage: parsed.lastRefreshMessage,
      }
    } catch {
      return null
    }
  }

  if (!FIRESTORE_PROJECT_ID) return null
  try {
    const res = await fetchFirestoreWithAuth(firestoreDocUrl())
    if (res.status === 404) return null
    const raw = await res.text()
    if (!res.ok) throw new Error(raw || `Firestore read vault (${res.status})`)
    const doc = JSON.parse(raw) as FirestoreDoc
    const jsonText = doc.fields?.json?.stringValue
    if (!jsonText) return null
    const parsed = JSON.parse(jsonText) as Partial<FacebookTokenVault>
    if (!parsed.userAccessToken || !parsed.pageTokens) return null
    return {
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      userAccessToken: parsed.userAccessToken,
      pageTokens: parsed.pageTokens,
      pageNames: parsed.pageNames,
      lastRefreshOk: parsed.lastRefreshOk !== false,
      lastRefreshMessage: parsed.lastRefreshMessage,
    }
  } catch (e) {
    console.warn('[facebook-token-vault] Firestore read failed:', e)
    return null
  }
}

export async function loadFacebookTokenVault(): Promise<FacebookTokenVault | null> {
  const ttl = resolveVaultReadCacheMs()
  if (ttl > 0 && vaultMemCache && Date.now() - vaultMemCache.at < ttl) {
    return vaultMemCache.vault
  }
  const vault = await loadFacebookTokenVaultUncached()
  vaultMemCache = { vault, at: Date.now() }
  return vault
}

export async function saveFacebookTokenVault(vault: FacebookTokenVault): Promise<void> {
  const payload = JSON.stringify(vault, null, 2)
  if (VAULT_BACKEND === 'file') {
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(VAULT_FILE, payload, 'utf8')
    vaultMemCache = { vault, at: Date.now() }
    return
  }
  if (!FIRESTORE_PROJECT_ID) {
    console.warn('[facebook-token-vault] Không ghi Firestore — thiếu project id')
    return
  }
  const body = {
    name: firestoreDocName(),
    fields: {
      json: { stringValue: payload },
    },
  }
  const res = await fetchFirestoreWithAuth(firestoreDocUrl(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(raw || `Firestore write vault (${res.status})`)
  vaultMemCache = { vault, at: Date.now() }
}
