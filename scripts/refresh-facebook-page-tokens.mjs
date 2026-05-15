/**
 * Đổi user access token → long-lived, lấy page token tất cả fanpage, cập nhật deploy/env/server.env
 *
 * Cách chạy:
 *   set FACEBOOK_USER_ACCESS_TOKEN=<token>
 *   node scripts/refresh-facebook-page-tokens.mjs
 *
 * Hoặc:
 *   node scripts/refresh-facebook-page-tokens.mjs --user-token <token> --env deploy/env/server.env
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GRAPH = 'https://graph.facebook.com/v20.0'

function parseArgs(argv) {
  const out = { envFile: resolve(root, 'deploy/env/server.env') }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--env' && argv[i + 1]) {
      out.envFile = resolve(argv[++i])
    } else if (argv[i] === '--user-token' && argv[i + 1]) {
      out.userToken = argv[++i]
    }
  }
  return out
}

function parseEnvFile(text) {
  const map = new Map()
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    map.set(t.slice(0, i).trim(), t.slice(i + 1))
  }
  return map
}

function serializeEnvFile(map, originalText) {
  const lines = originalText.split(/\r?\n/)
  const seen = new Set()
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) {
      out.push(line)
      continue
    }
    const i = t.indexOf('=')
    if (i < 1) {
      out.push(line)
      continue
    }
    const key = t.slice(0, i).trim()
    if (map.has(key)) {
      out.push(`${key}=${map.get(key)}`)
      seen.add(key)
    } else {
      out.push(line)
    }
  }
  for (const [key, value] of map) {
    if (!seen.has(key)) out.push(`${key}=${value}`)
  }
  return `${out.join('\n').replace(/\n*$/, '')}\n`
}

async function graphGet(path, params) {
  const url = new URL(`${GRAPH}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = body?.error?.message || `${res.status} ${res.statusText}`
    throw new Error(msg)
  }
  return body
}

async function exchangeLongLivedUserToken(shortToken, appId, appSecret) {
  const url = new URL(`${GRAPH}/oauth/access_token`)
  url.searchParams.set('grant_type', 'fb_exchange_token')
  url.searchParams.set('client_id', appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('fb_exchange_token', shortToken)
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.error?.message || `Exchange token failed: ${res.status}`)
  }
  if (!body.access_token) throw new Error('Exchange token: không có access_token')
  return body.access_token
}

async function fetchAllPages(userToken) {
  const pages = []
  let next = `/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`
  while (next) {
    const url = next.startsWith('http') ? next : `${GRAPH}${next}`
    const res = await fetch(url)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(body?.error?.message || `accounts failed: ${res.status}`)
    }
    for (const row of body.data ?? []) {
      if (row.id && row.access_token) {
        pages.push({ id: row.id, name: row.name || row.id, access_token: row.access_token })
      }
    }
    next = body.paging?.next || ''
  }
  return pages
}

async function validatePageToken(pageId, token) {
  try {
    await graphGet(`/${pageId}`, { fields: 'id', access_token: token })
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const envPath = args.envFile
  const envText = readFileSync(envPath, 'utf8')
  const env = parseEnvFile(envText)

  const userToken =
    args.userToken?.trim() ||
    process.env.FACEBOOK_USER_ACCESS_TOKEN?.trim() ||
    env.get('FACEBOOK_USER_ACCESS_TOKEN')?.trim()
  const appId = env.get('FACEBOOK_APP_ID')?.trim() || process.env.FACEBOOK_APP_ID?.trim()
  const appSecret =
    env.get('FACEBOOK_APP_SECRET')?.trim() || process.env.FACEBOOK_APP_SECRET?.trim()

  if (!userToken) {
    console.error('Thiếu FACEBOOK_USER_ACCESS_TOKEN (env hoặc --user-token)')
    process.exit(1)
  }
  if (!appId || !appSecret) {
    console.error('Thiếu FACEBOOK_APP_ID / FACEBOOK_APP_SECRET trong server.env')
    process.exit(1)
  }

  console.log('Đổi user token → long-lived…')
  const longLivedUser = await exchangeLongLivedUserToken(userToken, appId, appSecret)
  console.log('Lấy danh sách fanpage…')
  const pages = await fetchAllPages(longLivedUser)
  if (!pages.length) {
    console.error('Không lấy được fanpage nào — kiểm tra quyền pages_show_list, pages_messaging.')
    process.exit(1)
  }

  const valid = []
  for (const p of pages) {
    const ok = await validatePageToken(p.id, p.access_token)
    if (ok) valid.push(p)
    else console.warn(`Bỏ qua page ${p.id} (${p.name}): token không hợp lệ`)
  }

  const tokens = valid.map((p) => p.access_token)
  const registryPath = resolve(root, 'deploy/env/facebook-pages.registry.json')
  mkdirSync(dirname(registryPath), { recursive: true })
  writeFileSync(
    registryPath,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        pageCount: valid.length,
        pages: valid.map((p) => ({ id: p.id, name: p.name })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  env.set('FACEBOOK_USER_ACCESS_TOKEN', longLivedUser)
  env.set('FACEBOOK_PAGE_ACCESS_TOKENS', tokens.join(','))
  env.set('FACEBOOK_PAGE_ACCESS_TOKEN', tokens[0] ?? '')
  if (!env.has('FACEBOOK_TOKEN_REFRESH_ON_STARTUP')) {
    env.set('FACEBOOK_TOKEN_REFRESH_ON_STARTUP', '1')
  }

  writeFileSync(envPath, serializeEnvFile(env, envText), 'utf8')

  console.log(`OK: ${valid.length} page token → ${envPath}`)
  console.log(`Registry (không token): ${registryPath}`)
  for (const p of valid) console.log(`  - ${p.id}  ${p.name}`)
  console.log('\nChạy deploy: powershell -File deploy/cloud-run-deploy.ps1')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
