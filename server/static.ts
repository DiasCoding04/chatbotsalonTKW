import { createReadStream, existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { applySecurityHeaders } from './security-headers.ts'

const DIST_DIR = resolve(process.cwd(), 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function canServeStaticBuild(): boolean {
  return existsSync(join(DIST_DIR, 'index.html'))
}

function safeDistPath(urlPath: string): string | null {
  const normalized = urlPath.split('?')[0] || '/'
  const relative = normalized === '/' ? 'index.html' : normalized.replace(/^\/+/, '')
  const absolute = resolve(DIST_DIR, relative)
  if (!absolute.startsWith(DIST_DIR)) return null
  return absolute
}

/** True cho file Vite-hash hoặc nằm trong dist/assets — an toàn set immutable long-cache. */
function isImmutableHashedAsset(pathname: string, filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.html') return false
  if (pathname.startsWith('/assets/')) return true
  const base = filePath.split(/[\\/]/).pop() || ''
  return /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|webp|svg|gif|ico|map)$/i.test(base)
}

export function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!canServeStaticBuild()) return false

  const pathname = (req.url ?? '/').split('?')[0] || '/'
  let filePath = safeDistPath(pathname)
  let servedFromFallback = false
  if (!filePath || !existsSync(filePath)) {
    filePath = safeDistPath('/index.html')
    servedFromFallback = true
  }
  if (!filePath || !existsSync(filePath)) return false

  const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
  applySecurityHeaders(res)
  res.statusCode = 200
  res.setHeader('Content-Type', mime)

  if (!servedFromFallback && isImmutableHashedAsset(pathname, filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  } else {
    res.setHeader('Cache-Control', 'no-cache')
  }

  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(filePath).pipe(res)
  return true
}
