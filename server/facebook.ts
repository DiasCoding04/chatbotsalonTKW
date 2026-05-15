import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { readJsonBody, readRawBody } from './request-body.ts'
import { scheduleFacebookAiReplies } from './facebook-ai-reply.ts'
import {
  appendOutboundFacebookMessage,
  enrichFacebookConversationProfiles,
  type FacebookCustomerProfile,
  ingestFacebookWebhookPayload,
  listFacebookConversations,
  patchFacebookConversation,
  patchFacebookPage,
  saveFacebookPages,
} from './facebook-store.ts'

type FacebookStatus = {
  configured: boolean
  appId: boolean
  appSecret: boolean
  pageAccessToken: boolean
  pageTokenCount: number
  verifyToken: boolean
  webhookUrl: string
  /** true khi FACEBOOK_WEBHOOK_LOG_RAW_BODY — log JSON ra stdout của process Node. */
  webhookLogRawBody: boolean
  /** true trừ khi FACEBOOK_WEBHOOK_NO_DEBUG_FILE — luôn ghi data/facebook-webhook-last.json. */
  webhookDebugFile: boolean
  /** false khi FACEBOOK_DISABLE_GRAPH_ATTACHMENTS — không gọi Graph bổ sung file_url. */
  graphAttachmentsFallback: boolean
}

type FacebookGraphPage = {
  id?: string
  name?: string
  picture?: {
    data?: {
      url?: string
    }
  }
}

type FacebookGraphCustomerProfile = {
  first_name?: string
  last_name?: string
  name?: string
  profile_pic?: string
}

const pageTokenCache = new Map<string, string>()
const customerProfileCache = new Map<string, FacebookCustomerProfile>()

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Chỉ cho phép tải ảnh/video từ host Meta (tránh proxy mở). */
function parseAllowedFacebookMediaUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    const h = u.hostname.toLowerCase()
    const allowed =
      h.endsWith('fbcdn.net') ||
      h === 'facebook.com' ||
      h.endsWith('.facebook.com') ||
      h.endsWith('fb.com') ||
      h.endsWith('fbsbx.com')
    return allowed ? u : null
  } catch {
    return null
  }
}

async function handleFacebookCdnMediaProxy(res: ServerResponse, target: string): Promise<void> {
  const parsed = parseAllowedFacebookMediaUrl(target)
  if (!parsed || target.length > 8000) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('URL không hợp lệ hoặc không được phép.')
    return
  }

  const upstream = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: {
      Accept: 'image/*,video/*,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (compatible; SalonInbox/1.0; +https://developers.facebook.com/)',
    },
  }).catch(() => null)

  if (!upstream?.ok) {
    res.statusCode = upstream?.status === 403 ? 403 : 502
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Không tải được nội dung từ Facebook CDN.')
    return
  }

  const ct = upstream.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  const buf = Buffer.from(await upstream.arrayBuffer())
  res.statusCode = 200
  res.setHeader('Content-Type', ct)
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.end(buf)
}

function envFlag(name: string): boolean {
  return Boolean(process.env[name]?.trim())
}

/** Ghi data/facebook-webhook-last.json mỗi webhook (tắt: FACEBOOK_WEBHOOK_NO_DEBUG_FILE=1). Không phụ thuộc NODE_ENV. */
function shouldWriteWebhookDebugFile(): boolean {
  if (envFlag('FACEBOOK_WEBHOOK_NO_DEBUG_FILE')) return false
  return true
}

const WEBHOOK_DEBUG_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data')

async function dumpFacebookWebhookDebug(body: unknown): Promise<void> {
  await mkdir(WEBHOOK_DEBUG_DIR, { recursive: true })
  const filePath = resolve(WEBHOOK_DEBUG_DIR, 'facebook-webhook-last.json')
  await writeFile(
    filePath,
    `${JSON.stringify({ receivedAt: new Date().toISOString(), body }, null, 2)}\n`,
    'utf8',
  )
}

function verifyFacebookSignature(req: IncomingMessage, rawBody: Buffer): boolean {
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim()
  if (!appSecret) return true
  const signature = req.headers['x-hub-signature-256']
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false
  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const receivedHex = signature.slice('sha256='.length)
  const expected = Buffer.from(expectedHex, 'hex')
  const received = Buffer.from(receivedHex, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export function readFacebookPageTokens(): string[] {
  const single = process.env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim()
  const many = process.env.FACEBOOK_PAGE_ACCESS_TOKENS?.trim()
  return Array.from(
    new Set(
      [
        ...(single ? [single] : []),
        ...(many ? many.split(/[,\s]+/) : []),
      ].filter(Boolean),
    ),
  )
}

async function fetchFacebookPagesFromTokens(): Promise<FacebookGraphPage[]> {
  const pages: FacebookGraphPage[] = []
  for (const token of readFacebookPageTokens()) {
    const url = new URL('https://graph.facebook.com/v20.0/me')
    url.searchParams.set('fields', 'id,name,picture.type(large)')
    url.searchParams.set('access_token', token)
    const res = await fetch(url).catch(() => null)
    if (!res?.ok) continue
    const page = (await res.json()) as FacebookGraphPage
    if (page.id) {
      pageTokenCache.set(page.id, token)
      pages.push(page)
    }
  }
  return Array.from(new Map(pages.map((page) => [page.id, page])).values())
}

async function getPageTokenForPage(pageId: string): Promise<string | null> {
  const cached = pageTokenCache.get(pageId)
  if (cached) return cached
  await fetchFacebookPagesFromTokens()
  return pageTokenCache.get(pageId) ?? null
}

type GraphAttachmentRow = { file_url?: string; mime_type?: string }

function partitionAttachmentUrls(rows: GraphAttachmentRow[] | undefined): {
  images: string[]
  videos: string[]
  audios: string[]
} {
  const images: string[] = []
  const videos: string[] = []
  const audios: string[] = []
  for (const row of rows ?? []) {
    const url = typeof row.file_url === 'string' ? row.file_url.trim() : ''
    if (!url.startsWith('http')) continue
    const mt = (row.mime_type || '').toLowerCase()
    if (mt.startsWith('video/')) videos.push(url)
    else if (mt.startsWith('audio/')) audios.push(url)
    else images.push(url)
  }
  return { images, videos, audios }
}

/**
 * Webhook đôi khi chỉ gửi sticker_id / thiếu URL; Graph trả `file_url` theo message id.
 * Thử cả edge /attachments và object gốc ?fields=attachments{…} (shape khác nhau tùng API).
 * @see https://developers.facebook.com/docs/graph-api/reference/message/attachments/
 */
async function fetchMessageAttachmentsFromGraph(
  pageId: string,
  messageMid: string,
): Promise<{ images: string[]; videos: string[]; audios: string[] }> {
  const token = await getPageTokenForPage(pageId)
  if (!token || !messageMid.trim()) return { images: [], videos: [], audios: [] }

  const midEnc = encodeURIComponent(messageMid)
  const base = `https://graph.facebook.com/v20.0/${midEnc}`

  const fetchRows = async (
    pathAndQuery: string,
  ): Promise<{ ok: boolean; status: number; rows?: GraphAttachmentRow[] }> => {
    const graphUrl = new URL(`${base}${pathAndQuery}`)
    graphUrl.searchParams.set('access_token', token)
    const res = await fetch(graphUrl).catch(() => null)
    if (!res) return { ok: false, status: 0 }
    if (!res.ok) {
      const errBody = envFlag('FACEBOOK_WEBHOOK_DEBUG_GRAPH')
        ? await res.text().catch(() => '')
        : ''
      console.warn(
        `[facebook] Graph ${pathAndQuery.split('?')[0] || pathAndQuery} → ${res.status} ${errBody.slice(0, 400)}`,
      )
      return { ok: false, status: res.status }
    }
    const parsed = (await res.json()) as
      | { data?: GraphAttachmentRow[] }
      | { attachments?: { data?: GraphAttachmentRow[] } }
    if (Array.isArray((parsed as { data?: unknown }).data)) {
      return { ok: true, status: res.status, rows: (parsed as { data: GraphAttachmentRow[] }).data }
    }
    const nested = (parsed as { attachments?: { data?: GraphAttachmentRow[] } }).attachments?.data
    if (Array.isArray(nested)) return { ok: true, status: res.status, rows: nested }
    return { ok: true, status: res.status, rows: [] }
  }

  let rows: GraphAttachmentRow[] | undefined
  const edge = await fetchRows(`/attachments?fields=${encodeURIComponent('file_url,mime_type')}`)
  if (edge.rows?.length) rows = edge.rows
  if (!rows?.length) {
    const root = await fetchRows(`?fields=${encodeURIComponent('attachments{file_url,mime_type}')}`)
    if (root.rows?.length) rows = root.rows
  }

  const { images, videos, audios } = partitionAttachmentUrls(rows)
  return {
    images: [...new Set(images)],
    videos: [...new Set(videos)],
    audios: [...new Set(audios)],
  }
}

async function fetchCustomerProfile(
  pageId: string,
  customerPsid: string,
): Promise<FacebookCustomerProfile | null> {
  const cacheKey = `${pageId}:${customerPsid}`
  const cached = customerProfileCache.get(cacheKey)
  if (cached) return cached

  const token = await getPageTokenForPage(pageId)
  if (!token) return null

  const url = new URL(`https://graph.facebook.com/v20.0/${customerPsid}`)
  url.searchParams.set('fields', 'first_name,last_name,name,profile_pic')
  url.searchParams.set('access_token', token)
  const res = await fetch(url).catch(() => null)
  if (!res?.ok) return null

  const profile = (await res.json()) as FacebookGraphCustomerProfile
  const name =
    profile.name?.trim() ||
    [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
    undefined
  const normalized = {
    name,
    avatarUrl: profile.profile_pic,
  }
  customerProfileCache.set(cacheKey, normalized)
  return normalized
}

export function getFacebookStatus(): FacebookStatus {
  const appId = envFlag('FACEBOOK_APP_ID')
  const appSecret = envFlag('FACEBOOK_APP_SECRET')
  const pageTokenCount = readFacebookPageTokens().length
  const pageAccessToken = pageTokenCount > 0
  const verifyToken = envFlag('FACEBOOK_VERIFY_TOKEN')
  const publicUrl =
    process.env.FACEBOOK_WEBHOOK_PUBLIC_URL?.trim() || process.env.APP_PUBLIC_URL?.trim()
  return {
    configured: appId && appSecret && pageAccessToken && verifyToken,
    appId,
    appSecret,
    pageAccessToken,
    pageTokenCount,
    verifyToken,
    webhookUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/api/facebook/webhook` : '/api/facebook/webhook',
    webhookLogRawBody: envFlag('FACEBOOK_WEBHOOK_LOG_RAW_BODY'),
    webhookDebugFile: shouldWriteWebhookDebugFile(),
    graphAttachmentsFallback: !envFlag('FACEBOOK_DISABLE_GRAPH_ATTACHMENTS'),
  }
}

type GraphSendApiResponse = {
  recipient_id?: string
  message_id?: string
  error?: { message: string; type?: string; code?: number }
}

function parseDataUrlImage(dataUrl: string): { buffer: Buffer; mime: string } | null {
  const compact = dataUrl.replace(/\s/g, '')
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(compact)
  if (!m) return null
  try {
    const buffer = Buffer.from(m[2], 'base64')
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null
    return { buffer, mime: m[1].toLowerCase() }
  } catch {
    return null
  }
}

async function graphSendMessengerJson(
  token: string,
  recipientPsid: string,
  text: string,
): Promise<GraphSendApiResponse> {
  const url = new URL('https://graph.facebook.com/v20.0/me/messages')
  url.searchParams.set('access_token', token)
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      messaging_type: 'RESPONSE',
      message: { text },
    }),
  }).catch(() => null)
  if (!res) return { error: { message: 'Lỗi mạng khi gọi Graph.' } }
  return (await res.json()) as GraphSendApiResponse
}

async function graphSendMessengerImage(
  token: string,
  recipientPsid: string,
  buffer: Buffer,
  mime: string,
): Promise<GraphSendApiResponse> {
  const form = new FormData()
  form.append('recipient', JSON.stringify({ id: recipientPsid }))
  form.append(
    'message',
    JSON.stringify({
      attachment: { type: 'image', payload: { is_reusable: false } },
    }),
  )
  const ext = mime.includes('png') ? 'upload.png' : mime.includes('webp') ? 'upload.webp' : 'upload.jpg'
  form.append('filedata', new Blob([buffer], { type: mime }), ext)
  const url = new URL('https://graph.facebook.com/v20.0/me/messages')
  url.searchParams.set('access_token', token)
  const res = await fetch(url.toString(), { method: 'POST', body: form }).catch(() => null)
  if (!res) return { error: { message: 'Lỗi mạng khi gửi ảnh (multipart).' } }
  return (await res.json()) as GraphSendApiResponse
}

const MESSENGER_IMAGE_MAX_BYTES = 8 * 1024 * 1024

function mimeFromImagePath(p: string): string {
  const e = extname(p).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.webp') return 'image/webp'
  if (e === '.gif') return 'image/gif'
  return 'image/jpeg'
}

function absoluteFileUnderPublicOrDist(rawPath: string): string | null {
  const rel = rawPath.trim().replace(/^\/+/, '').replace(/\\/g, '/')
  if (!rel || rel.includes('..')) return null
  const cwd = resolve(process.cwd())
  for (const rootName of ['public', 'dist'] as const) {
    const root = resolve(cwd, rootName)
    const abs = resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + sep)) continue
    if (existsSync(abs)) return abs
  }
  return null
}

async function loadImageBytesForMessengerSend(
  rawUrl: string,
): Promise<{ ok: true; buffer: Buffer; mime: string } | { ok: false; message: string }> {
  const t = rawUrl.trim()
  if (!t) return { ok: false, message: 'URL ảnh rỗng.' }

  if (!/^https?:\/\//i.test(t)) {
    const abs = absoluteFileUnderPublicOrDist(t)
    if (abs) {
      try {
        const buffer = await readFile(abs)
        if (!buffer.length || buffer.length > MESSENGER_IMAGE_MAX_BYTES) {
          return { ok: false, message: 'Ảnh quá lớn hoặc rỗng.' }
        }
        return { ok: true, buffer, mime: mimeFromImagePath(abs) }
      } catch {
        /* fall through to HTTP */
      }
    }
  }

  let fetchUrl = t
  if (!/^https?:\/\//i.test(t)) {
    const port = Number(process.env.CONTEXT_CACHE_SERVER_PORT) || 8787
    const pub = process.env.APP_PUBLIC_URL?.trim()
    let origin: string
    if (pub && /^https?:\/\//i.test(pub)) {
      try {
        origin = new URL(pub).origin
      } catch {
        origin = `http://127.0.0.1:${port}`
      }
    } else {
      origin = `http://127.0.0.1:${port}`
    }
    fetchUrl = new URL(t.startsWith('/') ? t : `/${t}`, `${origin}/`).toString()
  }

  const res = await fetch(fetchUrl, { redirect: 'follow' }).catch(() => null)
  if (!res?.ok) {
    return { ok: false, message: `Không tải được ảnh (${fetchUrl.length > 140 ? `${fetchUrl.slice(0, 140)}…` : fetchUrl}).` }
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (!buffer.length || buffer.length > MESSENGER_IMAGE_MAX_BYTES) {
    return { ok: false, message: 'Ảnh quá lớn hoặc rỗng.' }
  }
  const ct = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || ''
  const pathGuess = fetchUrl.split(/[?#]/)[0] ?? fetchUrl
  const mime = ct.startsWith('image/') ? ct : mimeFromImagePath(pathGuess)
  if (!mime.startsWith('image/')) return { ok: false, message: 'URL không phải ảnh.' }
  return { ok: true, buffer, mime }
}

/** Ảnh mẫu catalog (đường dẫn tương đối hoặc URL tuyệt đối) → tải bytes → multipart Graph. */
async function graphSendMessengerImageFromUrl(
  token: string,
  recipientPsid: string,
  imageUrlOrPath: string,
): Promise<GraphSendApiResponse> {
  const loaded = await loadImageBytesForMessengerSend(imageUrlOrPath)
  if (!loaded.ok) return { error: { message: loaded.message } }
  return graphSendMessengerImage(token, recipientPsid, loaded.buffer, loaded.mime)
}

async function handleFacebookSendMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = getFacebookStatus()
  if (!cfg.configured) {
    json(res, 400, { ok: false, error: 'Thiếu cấu hình Facebook (App ID, Secret, Page token, Verify token).' })
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    json(res, 400, { ok: false, error: 'JSON không hợp lệ hoặc quá lớn.' })
    return
  }
  const parsed = body as {
    pageId?: string
    recipientPsid?: string
    text?: string
    imageDataUrl?: string
  }
  const pageId = typeof parsed.pageId === 'string' ? parsed.pageId.trim() : ''
  const recipientPsid = typeof parsed.recipientPsid === 'string' ? parsed.recipientPsid.trim() : ''
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
  const imageDataUrl = typeof parsed.imageDataUrl === 'string' ? parsed.imageDataUrl.trim() : ''
  if (!pageId || !recipientPsid) {
    json(res, 400, { ok: false, error: 'Thiếu pageId hoặc recipientPsid.' })
    return
  }
  if (!text && !imageDataUrl) {
    json(res, 400, { ok: false, error: 'Cần nội dung text hoặc ảnh (data URL).' })
    return
  }

  const token = await getPageTokenForPage(pageId)
  if (!token) {
    json(res, 400, {
      ok: false,
      error:
        'Không có page access token cho fanpage này. Đặt FACEBOOK_PAGE_ACCESS_TOKEN (hoặc danh sách token) và gọi POST /api/facebook/sync.',
    })
    return
  }

  const append = async (messageId: string, msgText: string) => {
    await appendOutboundFacebookMessage({
      pageId,
      customerPsid: recipientPsid,
      message: {
        id: messageId,
        author: 'page',
        text: msgText,
        timestamp: new Date().toISOString(),
        isEcho: true,
      },
    })
  }

  if (text) {
    const r = await graphSendMessengerJson(token, recipientPsid, text)
    if (r.error?.message || !r.message_id) {
      json(res, 502, {
        ok: false,
        error: r.error?.message || 'Graph API không trả message_id cho tin text.',
      })
      return
    }
    await append(r.message_id, text)
  }

  if (imageDataUrl) {
    const img = parseDataUrlImage(imageDataUrl)
    if (!img) {
      json(res, 400, { ok: false, error: 'Ảnh phải là data URL dạng data:image/...;base64,...' })
      return
    }
    const r = await graphSendMessengerImage(token, recipientPsid, img.buffer, img.mime)
    if (r.error?.message || !r.message_id) {
      json(res, 502, {
        ok: false,
        error: r.error?.message || 'Graph API không trả message_id cho ảnh.',
      })
      return
    }
    await append(r.message_id, '')
  }

  json(res, 200, { ok: true })
}

export async function handleFacebookApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/facebook')) return false

  if (req.method === 'GET' && url.pathname === '/api/facebook/status') {
    json(res, 200, getFacebookStatus())
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/facebook/conversations') {
    await enrichFacebookConversationProfiles(fetchCustomerProfile)
    json(res, 200, await listFacebookConversations())
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/facebook/cdn-media') {
    const target = url.searchParams.get('u')?.trim() ?? ''
    try {
      await handleFacebookCdnMediaProxy(res, target)
    } catch {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('Lỗi proxy media.')
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/facebook/sync') {
    const status = getFacebookStatus()
    if (!status.configured) {
      json(res, 200, {
        ok: false,
        configured: false,
        error: 'Thiếu Facebook app/page token. Endpoint đã sẵn sàng nhưng chưa thể gọi Graph API thật.',
      })
      return true
    }

    const graphPages = await fetchFacebookPagesFromTokens()
    const pages = await saveFacebookPages(
      graphPages
        .filter((page) => page.id && page.name)
        .map((page) => ({
          id: page.id as string,
          name: page.name as string,
          avatarUrl: page.picture?.data?.url,
          connected: true,
        })),
    )

    json(res, 200, {
      ok: true,
      configured: true,
      pages,
      syncedAt: new Date().toISOString(),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/facebook/send') {
    try {
      await handleFacebookSendMessage(req, res)
    } catch (e) {
      json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/facebook/webhook') {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && token && token === process.env.FACEBOOK_VERIFY_TOKEN) {
      res.statusCode = 200
      res.end(challenge ?? '')
      return true
    }
    json(res, 403, { error: 'Facebook webhook verify token không hợp lệ.' })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/facebook/webhook') {
    const rawBody = await readRawBody(req).catch(() => Buffer.from('{}'))
    if (!verifyFacebookSignature(req, rawBody)) {
      json(res, 403, { error: 'Facebook webhook signature không hợp lệ.' })
      return true
    }
    const body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) as unknown : {}

    if (shouldWriteWebhookDebugFile()) {
      await dumpFacebookWebhookDebug(body).catch((err) => {
        console.warn('[facebook webhook] could not write data/facebook-webhook-last.json:', err)
      })
    }

    if (envFlag('FACEBOOK_WEBHOOK_LOG_RAW_BODY')) {
      try {
        console.log('[facebook webhook] raw body:\n', JSON.stringify(body, null, 2))
      } catch {
        console.log('[facebook webhook] raw body: <unserializable>')
      }
    }

    const stored = await ingestFacebookWebhookPayload(body, {
      resolveCustomerProfile: fetchCustomerProfile,
      fetchAttachmentMediaFromGraph: envFlag('FACEBOOK_DISABLE_GRAPH_ATTACHMENTS')
        ? undefined
        : fetchMessageAttachmentsFromGraph,
    })
    json(res, 200, {
      ok: true,
      receivedAt: new Date().toISOString(),
      stored,
    })
    if (stored.pendingAiReplies.length) {
      void scheduleFacebookAiReplies(stored.pendingAiReplies, {
        getPageToken: getPageTokenForPage,
        graphSendText: graphSendMessengerJson,
        graphSendImageFromUrl: graphSendMessengerImageFromUrl,
      }).catch((e) => console.warn('[facebook-ai]', e))
    }
    return true
  }

  if (req.method === 'PATCH' && url.pathname === '/api/facebook/conversation') {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      json(res, 400, { ok: false, error: 'JSON không hợp lệ hoặc quá lớn.' })
      return true
    }
    const parsed = body as {
      conversationId?: string
      aiEnabled?: unknown
      branchPageId?: unknown
    }
    const conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId.trim() : ''
    if (!conversationId) {
      json(res, 400, { ok: false, error: 'Thiếu conversationId.' })
      return true
    }
    const hasAi = typeof parsed.aiEnabled === 'boolean'
    const hasBranch = 'branchPageId' in parsed
    if (!hasAi && !hasBranch) {
      json(res, 400, { ok: false, error: 'Cần aiEnabled (boolean) hoặc branchPageId (số hoặc null).' })
      return true
    }
    const patch: { aiEnabled?: boolean; branchPageId?: number | null } = {}
    if (hasAi) patch.aiEnabled = parsed.aiEnabled as boolean
    if (hasBranch) {
      if (parsed.branchPageId === null) {
        patch.branchPageId = null
      } else if (typeof parsed.branchPageId === 'number' && Number.isFinite(parsed.branchPageId)) {
        patch.branchPageId = parsed.branchPageId
      } else {
        json(res, 400, { ok: false, error: 'branchPageId phải là số chi nhánh hợp lệ hoặc null.' })
        return true
      }
    }
    const ok = await patchFacebookConversation(conversationId, patch)
    if (!ok) {
      json(res, 404, { ok: false, error: 'Không tìm thấy hội thoại.' })
      return true
    }
    json(res, 200, { ok: true })
    return true
  }

  if (req.method === 'PATCH' && url.pathname === '/api/facebook/page') {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      json(res, 400, { ok: false, error: 'JSON không hợp lệ hoặc quá lớn.' })
      return true
    }
    const parsed = body as {
      pageId?: string
      aiMasterEnabled?: unknown
      defaultBranchPageId?: unknown
    }
    const pageId = typeof parsed.pageId === 'string' ? parsed.pageId.trim() : ''
    if (!pageId) {
      json(res, 400, { ok: false, error: 'Thiếu pageId.' })
      return true
    }
    const hasMaster = typeof parsed.aiMasterEnabled === 'boolean'
    const hasBranch = 'defaultBranchPageId' in parsed
    if (!hasMaster && !hasBranch) {
      json(res, 400, {
        ok: false,
        error: 'Cần aiMasterEnabled (boolean) hoặc defaultBranchPageId (số hoặc null).',
      })
      return true
    }
    const patch: { defaultBranchPageId?: number | null; aiMasterEnabled?: boolean } = {}
    if (hasMaster) patch.aiMasterEnabled = parsed.aiMasterEnabled as boolean
    if (hasBranch) {
      if (parsed.defaultBranchPageId === null) {
        patch.defaultBranchPageId = null
      } else if (typeof parsed.defaultBranchPageId === 'number' && Number.isFinite(parsed.defaultBranchPageId)) {
        patch.defaultBranchPageId = parsed.defaultBranchPageId
      } else {
        json(res, 400, { ok: false, error: 'defaultBranchPageId phải là số chi nhánh hợp lệ hoặc null.' })
        return true
      }
    }
    const page = await patchFacebookPage(pageId, patch)
    if (!page) {
      json(res, 404, { ok: false, error: 'Không tìm thấy fanpage hoặc chi nhánh không hợp lệ.' })
      return true
    }
    json(res, 200, { ok: true, page })
    return true
  }

  return false
}
