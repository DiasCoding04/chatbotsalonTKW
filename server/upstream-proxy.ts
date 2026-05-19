import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getServerGeminiApiKey } from './gemini-api-key.ts'
import { getVertexAccessToken, useVertexGeminiBackend } from './vertex-auth.ts'

const UPSTREAMS: { prefix: string; origin: string; injectGeminiKey?: boolean }[] = [
  {
    prefix: '/gemini-api',
    origin: 'https://generativelanguage.googleapis.com',
    injectGeminiKey: true,
  },
  { prefix: '/openai-api', origin: 'https://api.openai.com' },
]

function upstreamTimingEnabled(): boolean {
  return process.env.DEBUG_UPSTREAM_TIMING === '1'
}

function msSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

const UPSTREAM_ERROR_BODY_LOG_LIMIT_BYTES = 16 * 1024
const UPSTREAM_ERROR_BODY_RESPONSE_LIMIT_BYTES = 256 * 1024

function bufferPreview(buf: Buffer, maxChars = 700): string {
  const raw = buf.toString('utf8')
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw
}

function collectStreamWithLimit(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (truncated) return
      const next = total + buf.length
      if (next <= maxBytes) {
        chunks.push(buf)
        total = next
        return
      }
      const rest = maxBytes - total
      if (rest > 0) {
        chunks.push(buf.subarray(0, rest))
        total = maxBytes
      }
      truncated = true
    })
    stream.on('end', () => resolve({ body: Buffer.concat(chunks, total), truncated }))
    stream.on('error', reject)
  })
}

function vertexLocation(): string {
  return process.env.VERTEX_AI_LOCATION?.trim() || 'global'
}

function vertexOrigin(location = vertexLocation()): string {
  return location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`
}

function rewriteVertexGeminiPath(pathname: string): string {
  const project = process.env.VERTEX_AI_PROJECT_ID?.trim()
  if (!project) throw new Error('Thiếu VERTEX_AI_PROJECT_ID cho Vertex AI.')

  const location = vertexLocation()
  const match = pathname.match(/^\/v1(?:beta)?\/models\/([^:]+)(:.*)$/)
  if (!match) return pathname

  const model = process.env.VERTEX_AI_MODEL?.trim() || decodeURIComponent(match[1])
  return `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}${match[2]}`
}

function rewriteVertexSearch(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  params.delete('key')
  const next = params.toString()
  return next ? `?${next}` : ''
}

function rewriteUpstreamSearch(
  search: string,
  injectGeminiKey: boolean,
): string {
  if (!injectGeminiKey) return search

  const apiKey = getServerGeminiApiKey()
  if (!apiKey) return search

  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  params.set('key', apiKey)
  const next = params.toString()
  return next ? `?${next}` : ''
}

export function tryProxyUpstream(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? ''
  const route = UPSTREAMS.find((item) => url.startsWith(item.prefix))
  if (!route) return false
  const startedAt = process.hrtime.bigint()
  const logTiming = upstreamTimingEnabled()

  const isVertexGeminiRoute = route.prefix === '/gemini-api' && useVertexGeminiBackend()

  if (route.injectGeminiKey && !isVertexGeminiRoute && !getServerGeminiApiKey()) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'Thiếu GEMINI_API_KEY trên server.' }))
    return true
  }

  const upstream = new URL(route.origin)
  const queryIndex = url.indexOf('?')
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
  const search = queryIndex === -1 ? '' : url.slice(queryIndex)
  void (async () => {
    const isVertexGemini = isVertexGeminiRoute
    const target = new URL(isVertexGemini ? vertexOrigin() : route.origin)
    const rawPath = pathname.slice(route.prefix.length) || '/'
    const upstreamPath = isVertexGemini ? rewriteVertexGeminiPath(rawPath) : rawPath
    const upstreamSearch = isVertexGemini
      ? rewriteVertexSearch(search)
      : rewriteUpstreamSearch(search, Boolean(route.injectGeminiKey))

    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: target.host,
      'accept-encoding': 'identity',
    }
    if (isVertexGemini) {
      headers.authorization = `Bearer ${await getVertexAccessToken()}`
      delete headers['x-goog-api-key']
    }

    const proxyReq = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        method: req.method,
        path: `${upstreamPath}${upstreamSearch}`,
        headers,
      },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 502
        if (logTiming) {
          console.log(
            `[upstream] ${req.method ?? 'GET'} ${upstreamPath} status=${statusCode} headers=${msSince(startedAt).toFixed(0)}ms`,
          )
        }
        const isErrorStatus = statusCode >= 400
        if (!isErrorStatus) {
          res.writeHead(statusCode, proxyRes.headers)
          proxyRes.on('end', () => {
            if (logTiming) {
              console.log(
                `[upstream] ${req.method ?? 'GET'} ${upstreamPath} done=${msSince(startedAt).toFixed(0)}ms`,
              )
            }
          })
          proxyRes.pipe(res)
          return
        }

        void collectStreamWithLimit(proxyRes, UPSTREAM_ERROR_BODY_RESPONSE_LIMIT_BYTES)
          .then(({ body, truncated }) => {
            const reqId =
              String(proxyRes.headers['x-request-id'] ?? '') ||
              String(proxyRes.headers['x-goog-request-id'] ?? '') ||
              String(proxyRes.headers['x-cloud-trace-context'] ?? '')
            const preview = bufferPreview(
              body.subarray(0, Math.min(body.length, UPSTREAM_ERROR_BODY_LOG_LIMIT_BYTES)),
            )
            console.error(
              `[upstream] ${req.method ?? 'GET'} ${upstreamPath} failed status=${statusCode} done=${msSince(startedAt).toFixed(0)}ms reqId=${reqId || '-'} truncated=${truncated} body=${preview}`,
            )
            if (!res.headersSent) {
              res.writeHead(statusCode, proxyRes.headers)
            }
            res.end(body)
          })
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(
              `[upstream] ${req.method ?? 'GET'} ${upstreamPath} failed status=${statusCode} body_read_error=${msg}`,
            )
            if (!res.headersSent) {
              res.statusCode = statusCode
            }
            res.end()
          })
      },
    )

    proxyReq.on('error', (e) => {
      const msg = e instanceof Error ? e.message : String(e)
      if (logTiming) {
        console.error(
          `[upstream] ${req.method ?? 'GET'} ${upstreamPath} error=${msSince(startedAt).toFixed(0)}ms ${msg}`,
        )
      }
      if (!res.headersSent) {
        res.statusCode = 502
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
        return
      }
      res.end()
    })

    req.pipe(proxyReq)
  })().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e)
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: msg }))
      return
    }
    res.end()
  })
  return true
}
