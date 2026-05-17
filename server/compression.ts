/**
 * Nén response theo Accept-Encoding của client để giảm Cloud Run egress.
 * Chỉ nén text/json — bỏ qua binary (image/*, font/*, video/*) vì đã nén sẵn.
 */
import {
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  type BrotliOptions,
  type ZlibOptions,
} from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type SupportedEncoding = 'br' | 'gzip'

/** Ngưỡng nén — body nhỏ hơn thì gửi nguyên (overhead nén > tiết kiệm). */
const MIN_COMPRESS_BYTES = 1024

const BROTLI_OPTIONS: BrotliOptions = {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
  },
}

const GZIP_OPTIONS: ZlibOptions = { level: 6 }

/** Đọc Accept-Encoding, ưu tiên brotli > gzip. */
export function negotiateContentEncoding(req: IncomingMessage): SupportedEncoding | null {
  const raw = req.headers['accept-encoding']
  if (!raw) return null
  const value = Array.isArray(raw) ? raw.join(',') : raw
  const tokens = value
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (tokens.some((t) => t.startsWith('br'))) return 'br'
  if (tokens.some((t) => t.startsWith('gzip'))) return 'gzip'
  return null
}

/** True nếu MIME type thuộc nhóm nên nén (text, JSON, JS, SVG…). */
export function shouldCompressMime(contentType: string | undefined | null): boolean {
  if (!contentType) return false
  const ct = contentType.toLowerCase()
  if (ct.startsWith('text/')) return true
  if (ct.startsWith('application/json')) return true
  if (ct.startsWith('application/javascript')) return true
  if (ct.startsWith('application/xml')) return true
  if (ct.includes('+json') || ct.includes('+xml')) return true
  if (ct.startsWith('image/svg')) return true
  return false
}

function applyEncodingHeaders(res: ServerResponse, encoding: SupportedEncoding): void {
  res.setHeader('Content-Encoding', encoding)
  res.removeHeader('Content-Length')
  const vary = res.getHeader('Vary')
  if (typeof vary === 'string' && vary.length) {
    if (!/\baccept-encoding\b/i.test(vary)) {
      res.setHeader('Vary', `${vary}, Accept-Encoding`)
    }
  } else {
    res.setHeader('Vary', 'Accept-Encoding')
  }
}

/** Gửi buffer/string (đã set Content-Type trước đó) với nén nếu client hỗ trợ. */
export function writeMaybeCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | string,
): void {
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  if (buffer.length < MIN_COMPRESS_BYTES) {
    res.setHeader('Content-Length', buffer.length)
    res.end(buffer)
    return
  }
  const contentType = res.getHeader('Content-Type')
  const ctString = Array.isArray(contentType) ? contentType[0] : (contentType as string | undefined)
  if (!shouldCompressMime(ctString)) {
    res.setHeader('Content-Length', buffer.length)
    res.end(buffer)
    return
  }
  const encoding = negotiateContentEncoding(req)
  if (!encoding) {
    res.setHeader('Content-Length', buffer.length)
    res.end(buffer)
    return
  }
  applyEncodingHeaders(res, encoding)
  const source = Readable.from(buffer)
  const transformer = encoding === 'br' ? createBrotliCompress(BROTLI_OPTIONS) : createGzip(GZIP_OPTIONS)
  pipeline(source, transformer, res).catch((err) => {
    console.warn('[compression] pipeline error:', err)
    try {
      res.end()
    } catch {
      /* ignore */
    }
  })
}

/** Pipe một source stream (vd. createReadStream) qua nén nếu nên nén; ngược lại pipe thẳng. */
export function pipeMaybeCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  source: NodeJS.ReadableStream,
): void {
  if (req.method === 'HEAD') {
    res.end()
    const maybeDestroy = (source as unknown as { destroy?: () => void }).destroy
    if (typeof maybeDestroy === 'function') {
      maybeDestroy.call(source)
    }
    return
  }
  const contentType = res.getHeader('Content-Type')
  const ctString = Array.isArray(contentType) ? contentType[0] : (contentType as string | undefined)
  const encoding = shouldCompressMime(ctString) ? negotiateContentEncoding(req) : null
  if (!encoding) {
    source.pipe(res)
    return
  }
  applyEncodingHeaders(res, encoding)
  const transformer = encoding === 'br' ? createBrotliCompress(BROTLI_OPTIONS) : createGzip(GZIP_OPTIONS)
  pipeline(source, transformer, res).catch((err) => {
    console.warn('[compression] pipeline error:', err)
    try {
      res.end()
    } catch {
      /* ignore */
    }
  })
}
