import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getServerGeminiApiKey } from './gemini-api-key.ts'

const UPSTREAMS: { prefix: string; origin: string; injectGeminiKey?: boolean }[] = [
  {
    prefix: '/gemini-api',
    origin: 'https://generativelanguage.googleapis.com',
    injectGeminiKey: true,
  },
  { prefix: '/openai-api', origin: 'https://api.openai.com' },
]

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

  if (route.injectGeminiKey && !getServerGeminiApiKey()) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'Thiếu GEMINI_API_KEY trên server.' }))
    return true
  }

  const upstream = new URL(route.origin)
  const queryIndex = url.indexOf('?')
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
  const search = queryIndex === -1 ? '' : url.slice(queryIndex)
  const upstreamPath = pathname.slice(route.prefix.length) || '/'
  const upstreamSearch = rewriteUpstreamSearch(search, Boolean(route.injectGeminiKey))

  const headers = { ...req.headers, host: upstream.host, 'accept-encoding': 'identity' }

  const proxyReq = httpsRequest(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 443,
      method: req.method,
      path: `${upstreamPath}${upstreamSearch}`,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )

  proxyReq.on('error', (e) => {
    const msg = e instanceof Error ? e.message : String(e)
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: msg }))
      return
    }
    res.end()
  })

  req.pipe(proxyReq)
  return true
}
