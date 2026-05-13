import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const EARLY_REFRESH_MS = 60_000

type ServiceAccountKey = {
  client_email?: string
  private_key?: string
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null

function base64Url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function readServiceAccount(): ServiceAccountKey {
  const inline = process.env.VERTEX_SERVICE_ACCOUNT_JSON?.trim()
  if (inline) return JSON.parse(inline) as ServiceAccountKey

  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  if (!file) {
    throw new Error('Thiếu GOOGLE_APPLICATION_CREDENTIALS hoặc VERTEX_SERVICE_ACCOUNT_JSON cho Vertex AI.')
  }
  return JSON.parse(readFileSync(file, 'utf8')) as ServiceAccountKey
}

function createJwt(sa: ServiceAccountKey): string {
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON thiếu client_email hoặc private_key.')
  }

  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  )
  const unsigned = `${header}.${claim}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64')
  return `${unsigned}.${signature.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`
}

export function useVertexGeminiBackend(): boolean {
  return process.env.GEMINI_BACKEND?.trim().toLowerCase() === 'vertex'
}

export async function getVertexAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + EARLY_REFRESH_MS) {
    return cachedToken.accessToken
  }

  const assertion = createJwt(readServiceAccount())
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(raw || `${res.status} ${res.statusText}`)

  const data = JSON.parse(raw) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('OAuth token response thiếu access_token.')

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  }
  return cachedToken.accessToken
}
