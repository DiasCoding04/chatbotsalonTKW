import { createServer } from 'node:http'
import { contextEditTokenRequired, verifyContextEditToken } from './context-auth.ts'
import {
  clearSharedContextCacheStore,
  ensureSharedContextCache,
} from './context-cache-store.ts'
import {
  ensureContextFile,
  readContextDocument,
  readImageSamplesDocument,
  writeContextDocument,
} from './context-store.ts'
import { getServerGeminiApiKey } from './gemini-api-key.ts'
import { loadEnvFile } from './load-env.ts'
import { assertProductionEnv } from './production-guards.ts'
import { readJsonBody } from './request-body.ts'
import { applySecurityHeaders } from './security-headers.ts'
import { canServeStaticBuild, tryServeStatic } from './static.ts'
import { tryProxyUpstream } from './upstream-proxy.ts'
import { useVertexGeminiBackend } from './vertex-auth.ts'
import { handleFacebookApi } from './facebook.ts'

loadEnvFile()
assertProductionEnv()

const PORT =
  Number(process.env.PORT) ||
  Number(process.env.CONTEXT_CACHE_SERVER_PORT) ||
  8787
const HOST = process.env.CONTEXT_CACHE_SERVER_HOST?.trim() || '0.0.0.0'
const DEFAULT_TTL_S = Number(process.env.GEMINI_CONTEXT_CACHE_TTL_S) || 3600
const DEFAULT_MODEL = process.env.VITE_GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite'
const PUBLIC_URL = process.env.APP_PUBLIC_URL?.trim() || ''
const MAX_CONTEXT_CHARS = Number(process.env.CONTEXT_MAX_CHARS) || 500_000

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown) {
  applySecurityHeaders(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function contextApiPayload(doc: { content: string; updatedAt: string }) {
  return {
    content: doc.content,
    updatedAt: doc.updatedAt,
    requiresEditToken: contextEditTokenRequired(),
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const url = requestUrl.pathname

    if (req.method === 'GET' && url === '/api/health') {
      const geminiBackend = useVertexGeminiBackend() ? 'vertex' : 'developer'
      sendJson(res, 200, {
        ok: true,
        staticBuild: canServeStaticBuild(),
        contextEditTokenRequired: contextEditTokenRequired(),
        publicUrl: PUBLIC_URL || null,
        geminiBackend,
        geminiServerReady: geminiBackend === 'vertex' || Boolean(getServerGeminiApiKey()),
        geminiProxyKeyInjected: Boolean(getServerGeminiApiKey()),
      })
      return
    }

    if (url === '/api/context' && (req.method === 'GET' || req.method === 'PUT')) {
      if (req.method === 'GET') {
        const doc = await readContextDocument()
        sendJson(res, 200, contextApiPayload(doc))
        return
      }

      if (!verifyContextEditToken(req)) {
        sendJson(res, 401, { error: 'Sai hoặc thiếu mã chỉnh sửa CONTEXT.' })
        return
      }

      const body = (await readJsonBody(req)) as { content?: string }
      if (typeof body.content !== 'string') {
        sendJson(res, 400, { error: 'Thiếu trường content (chuỗi markdown).' })
        return
      }
      if (body.content.length > MAX_CONTEXT_CHARS) {
        sendJson(res, 413, {
          error: `CONTEXT vượt quá ${MAX_CONTEXT_CHARS} ký tự.`,
        })
        return
      }

      const doc = await writeContextDocument(body.content)
      clearSharedContextCacheStore()
      sendJson(res, 200, contextApiPayload(doc))
      return
    }

    if (req.method === 'GET' && url === '/api/image-samples') {
      const doc = await readImageSamplesDocument()
      sendJson(res, 200, {
        content: doc.content,
        updatedAt: doc.updatedAt,
      })
      return
    }

    if (await handleFacebookApi(req, res, requestUrl)) return

    if (req.method === 'POST' && url === '/api/context-cache/ensure') {
      const apiKey = getServerGeminiApiKey()
      if (!useVertexGeminiBackend() && !apiKey) {
        sendJson(res, 500, { error: 'Thiếu GEMINI_API_KEY trên server.' })
        return
      }

      const body = (await readJsonBody(req)) as {
        model?: string
        systemPrompt?: string
        ttlSeconds?: number
      }
      const systemPrompt = body.systemPrompt?.trim()
      if (!systemPrompt) {
        sendJson(res, 400, { error: 'Thiếu systemPrompt.' })
        return
      }

      const model = body.model?.trim() || DEFAULT_MODEL
      const ttlSeconds = Number(body.ttlSeconds) || DEFAULT_TTL_S
      try {
        const result = await ensureSharedContextCache(apiKey, model, systemPrompt, ttlSeconds)
        sendJson(res, 200, result)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        sendJson(res, 502, { error: msg })
      }
      return
    }

    if (tryProxyUpstream(req, res)) return

    if (tryServeStatic(req, res)) return

    sendJson(res, 404, { error: 'Not found' })
  })().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e)
    sendJson(res, 500, { error: msg })
  })
})

void ensureContextFile().then(() => {
  server.listen(PORT, HOST, () => {
    const modes = ['api', 'proxy']
    if (canServeStaticBuild()) modes.push('static')
    const publicLabel = PUBLIC_URL ? ` · ${PUBLIC_URL}` : ''
    console.log(`[context-cache] http://${HOST}:${PORT} (${modes.join(' + ')})${publicLabel}`)
    if (!contextEditTokenRequired()) {
      console.warn(
        '[context-cache] CONTEXT_EDITOR_TOKEN chưa đặt — ai cũng có thể PUT /api/context. Đặt token trước khi mở domain.',
      )
    }
  })
})
