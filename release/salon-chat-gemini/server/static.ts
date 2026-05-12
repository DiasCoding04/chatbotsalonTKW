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

export function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!canServeStaticBuild()) return false

  const pathname = (req.url ?? '/').split('?')[0] || '/'
  let filePath = safeDistPath(pathname)
  if (!filePath || !existsSync(filePath)) {
    filePath = safeDistPath('/index.html')
  }
  if (!filePath || !existsSync(filePath)) return false

  const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
  applySecurityHeaders(res)
  res.statusCode = 200
  res.setHeader('Content-Type', mime)
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(filePath).pipe(res)
  return true
}
