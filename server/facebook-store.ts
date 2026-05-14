import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  BRANCH_PAGES,
  isSalonPlaceholderMessageText,
  PLACEHOLDER_NO_TEXT,
} from '../shared/salon-ai-context.ts'

const DATA_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data')
const FACEBOOK_STORE_FILE =
  process.env.FACEBOOK_STORE_PATH?.trim() || resolve(DATA_DIR, 'facebook-conversations.json')

export type FacebookAdAttribution = {
  source?: string
  type?: string
  adId?: string
  ref?: string
  refererUri?: string
  title?: string
  sourceUrl?: string
  /** Creative preview from ads_context_data */
  photoUrl?: string
  videoUrl?: string
  raw?: unknown
}

export type FacebookPageRecord = {
  id: string
  name: string
  avatarUrl?: string
  connected: boolean
  /** Ngữ cảnh chi nhánh mặc định (khi hội thoại không ghi đè branchPageId). */
  defaultBranchPageId?: number
  /** false = tắt AI tự động cho toàn page; hội thoại vẫn có thể bật/tắt riêng nhưng không chạy cho đến khi bật lại ở đây. */
  aiMasterEnabled?: boolean
}

export type FacebookStoredMessage = {
  id: string
  author: 'customer' | 'page' | 'system'
  text: string
  timestamp: string
  isEcho?: boolean
  referral?: FacebookAdAttribution
  /** Image URLs from message.attachments (image, sticker, …) */
  images?: string[]
  /** Video URLs from message.attachments */
  videos?: string[]
  /** Voice / audio (type audio hoặc mime audio/* từ Graph) */
  audios?: string[]
}

export type FacebookStoredConversation = {
  id: string
  pageId: string
  customerPsid: string
  customerName?: string
  avatarUrl?: string
  title: string
  updatedAt: string
  lastMessageAt: string
  ad?: FacebookAdAttribution
  messages: FacebookStoredMessage[]
  customerReadAt?: string
  pageDeliveredAt?: string
  /** Mặc định true — false: tắt trả lời AI tự động cho hội thoại này. */
  aiEnabled?: boolean
  /** id trong BRANCH_PAGES — khi set, AI dùng ngữ cảnh chi nhánh này thay vì suy ra từ tên fanpage. */
  branchPageId?: number
  /** Ước tính tổng chi phí Gemini (USD) cho các lần AI tự trả lời trong hội thoại. */
  aiEstimatedTotalUsd?: number
  /** Lần gọi AI gần nhất: response có đọc token từ Context Cache không. */
  aiLastContextCacheHit?: boolean
  aiLastRunAt?: string
}

export type FacebookStore = {
  pages: FacebookPageRecord[]
  conversations: FacebookStoredConversation[]
  updatedAt: string
}

type WebhookReferral = {
  source?: string
  type?: string
  ad_id?: string
  ref?: string
  referer_uri?: string
  source_url?: string
  ads_context_data?: {
    ad_title?: string
    photo_url?: string
    video_url?: string
    post_id?: string
  }
}

type WebhookAttachment = {
  type?: string
  payload?: Record<string, unknown>
}

type WebhookMessaging = {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    referral?: WebhookReferral
    attachments?: WebhookAttachment[]
  }
  postback?: {
    mid?: string
    title?: string
    payload?: string
    referral?: WebhookReferral
  }
  referral?: WebhookReferral
  read?: {
    watermark?: number
  }
  delivery?: {
    watermark?: number
    mids?: string[]
  }
}

type WebhookEntry = {
  id?: string
  messaging?: WebhookMessaging[]
}

type FacebookWebhookPayload = {
  object?: string
  entry?: WebhookEntry[]
}

export type FacebookCustomerProfile = {
  name?: string
  avatarUrl?: string
}

function emptyStore(): FacebookStore {
  return { pages: [], conversations: [], updatedAt: new Date().toISOString() }
}

async function readStore(): Promise<FacebookStore> {
  try {
    const raw = await readFile(FACEBOOK_STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<FacebookStore>
    return {
      pages: Array.isArray(parsed.pages) ? parsed.pages : [],
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return emptyStore()
  }
}

async function writeStore(store: FacebookStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(FACEBOOK_STORE_FILE, JSON.stringify(store, null, 2), 'utf8')
}

function isoFromMetaTimestamp(timestamp?: number): string {
  if (!timestamp) return new Date().toISOString()
  return new Date(timestamp).toISOString()
}

function normalizeReferral(referral?: WebhookReferral): FacebookAdAttribution | undefined {
  if (!referral) return undefined
  const ctx = referral.ads_context_data
  const ad: FacebookAdAttribution = {
    source: referral.source,
    type: referral.type,
    adId: referral.ad_id,
    ref: referral.ref,
    refererUri: referral.referer_uri,
    sourceUrl: referral.source_url,
    title: ctx?.ad_title,
    photoUrl: ctx?.photo_url,
    videoUrl: ctx?.video_url,
    raw: referral,
  }
  return Object.values(ad).some(Boolean) ? ad : undefined
}

function mergeAd(
  current: FacebookAdAttribution | undefined,
  incoming: FacebookAdAttribution | undefined,
): FacebookAdAttribution | undefined {
  if (!incoming) return current
  return { ...current, ...incoming, raw: incoming.raw ?? current?.raw }
}

function isLikelyVideoUrl(url: string): boolean {
  return /\.(mp4|mov|webm)(\?|$)/i.test(url)
}

function isLikelyAudioUrl(url: string): boolean {
  return /\.(mp3|aac|m4a|oga|ogg|opus|wav|weba|amr|3gp|caf)($|\?)/i.test(url.split(/[?#]/)[0])
}

function isFacebookHostedMediaUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'https:') return false
    const h = u.hostname.toLowerCase()
    return (
      h.endsWith('fbcdn.net') ||
      h.includes('.fbcdn.') ||
      h === 'facebook.com' ||
      h.endsWith('.facebook.com') ||
      h.endsWith('fb.com') ||
      h.endsWith('fbsbx.com')
    )
  } catch {
    return false
  }
}

/** Quét payload đính kèm (giới hạn độ sâu) để bắt URL fbcdn lồng trong object Meta không chuẩn hóa. */
function deepCollectFacebookMediaUrls(node: unknown, depth: number, out: Set<string>): void {
  if (depth > 12 || out.size >= 32) return
  if (node == null) return
  if (typeof node === 'string') {
    const s = node.trim()
    if (s.startsWith('https://') && isFacebookHostedMediaUrl(s)) out.add(s)
    return
  }
  if (Array.isArray(node)) {
    for (const x of node) deepCollectFacebookMediaUrls(x, depth + 1, out)
    return
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      deepCollectFacebookMediaUrls(v, depth + 1, out)
    }
  }
}

/** Lấy mọi URL media phổ biến trong từng phần tử attachments[].payload (Meta không chỉ dùng payload.url). */
function mediaUrlsFromAttachmentPayload(payload: unknown): string[] {
  const urls: string[] = []
  const add = (s?: unknown) => {
    if (typeof s === 'string' && s.trim().startsWith('http')) urls.push(s.trim())
  }
  if (!payload || typeof payload !== 'object') return urls
  const p = payload as Record<string, unknown>
  add(p.url)
  add(p.media_url)
  if (Array.isArray(p.elements)) {
    for (const el of p.elements) {
      if (!el || typeof el !== 'object') continue
      const e = el as Record<string, unknown>
      add(e.image_url)
      add(e.item_url)
      const da = e.default_action
      if (da && typeof da === 'object') add((da as { url?: string }).url)
    }
  }
  const nested = p.attachment
  if (nested && typeof nested === 'object') {
    const inner = (nested as { payload?: unknown }).payload
    if (inner && typeof inner === 'object') {
      const ip = inner as Record<string, unknown>
      add(ip.url)
    }
  }
  const deep = new Set<string>()
  deepCollectFacebookMediaUrls(payload, 0, deep)
  for (const u of deep) urls.push(u)
  return [...new Set(urls)]
}

function extractAttachmentMedia(message?: WebhookMessaging['message']): {
  images: string[]
  videos: string[]
  audios: string[]
} {
  const images: string[] = []
  const videos: string[] = []
  const audios: string[] = []
  const list = message?.attachments
  if (!Array.isArray(list)) return { images, videos, audios }
  for (const att of list) {
    const kind = (att.type || '').toLowerCase()
    const urls = mediaUrlsFromAttachmentPayload(att.payload)
    if (urls.length) {
      for (const url of urls) {
        const videoish =
          kind === 'video' ||
          kind === 'video_inline' ||
          (kind === 'file' && isLikelyVideoUrl(url)) ||
          isLikelyVideoUrl(url)
        const audioish =
          kind === 'audio' || kind === 'voice' || (isLikelyAudioUrl(url) && !videoish)
        if (videoish) videos.push(url)
        else if (audioish) audios.push(url)
        else images.push(url)
      }
      continue
    }
    const legacyUrl =
      typeof att.payload?.url === 'string' ? (att.payload.url as string).trim() : ''
    if (!legacyUrl) continue
    if (kind === 'audio' || kind === 'voice') {
      audios.push(legacyUrl)
      continue
    }
    if (kind === 'video' || kind === 'video_inline' || (kind === 'file' && isLikelyVideoUrl(legacyUrl)))
      videos.push(legacyUrl)
    else if (kind === 'image' || kind === 'sticker' || kind === 'fallback') images.push(legacyUrl)
    else if (kind === 'file' && isLikelyAudioUrl(legacyUrl)) audios.push(legacyUrl)
    else if (kind === 'file') videos.push(legacyUrl)
    else images.push(legacyUrl)
  }
  return {
    images: [...new Set(images)],
    videos: [...new Set(videos)],
    audios: [...new Set(audios)],
  }
}

/** Chỉ bỏ qua Graph cho loại không có file tải được; mọi type khác (kể cả rỗng/unknown) vẫn thử. */
const GRAPH_SKIP_ATTACHMENT_TYPES = new Set(['location', 'contact'])

function shouldTryGraphAttachmentFallback(attachments: WebhookAttachment[]): boolean {
  return attachments.some((att) => !GRAPH_SKIP_ATTACHMENT_TYPES.has((att.type || '').toLowerCase()))
}

function conversationTitle(
  psid: string,
  text: string,
  opts?: { imageCount?: number; videoCount?: number; audioCount?: number; adTitle?: string },
): string {
  const cleanText = text.trim()
  if (cleanText && !isSalonPlaceholderMessageText(cleanText)) return cleanText.slice(0, 80)
  const adTitle = opts?.adTitle?.trim()
  if (adTitle) return adTitle.slice(0, 80)
  const nImg = opts?.imageCount ?? 0
  const nVid = opts?.videoCount ?? 0
  const nAud = opts?.audioCount ?? 0
  if (nImg + nVid + nAud > 0) return `Ảnh / file · ${psid.slice(-6)}`
  if (cleanText) return cleanText.slice(0, 80)
  return `Khách ${psid.slice(-6)}`
}

function upsertConversation(
  store: FacebookStore,
  pageId: string,
  customerPsid: string,
  timestamp: string,
  customerProfile?: FacebookCustomerProfile | null,
): FacebookStoredConversation {
  const id = `${pageId}:${customerPsid}`
  let conversation = store.conversations.find((item) => item.id === id)
  if (!conversation) {
    conversation = {
      id,
      pageId,
      customerPsid,
      title: `Khách ${customerPsid.slice(-6)}`,
      updatedAt: timestamp,
      lastMessageAt: timestamp,
      messages: [],
    }
    store.conversations.unshift(conversation)
  }
  if (customerProfile?.name) conversation.customerName = customerProfile.name
  if (customerProfile?.avatarUrl) conversation.avatarUrl = customerProfile.avatarUrl
  conversation.updatedAt = timestamp
  conversation.lastMessageAt = timestamp
  return conversation
}

export async function listFacebookConversations(): Promise<FacebookStore> {
  const store = await readStore()
  return {
    ...store,
    conversations: [...store.conversations].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
  }
}

/** Đọc store thô (cho AI inbox — không sort). */
export async function readFacebookStoreSnapshot(): Promise<FacebookStore> {
  return readStore()
}

const BRANCH_IDS = new Set(BRANCH_PAGES.map((b) => b.id))

export async function patchFacebookConversation(
  conversationId: string,
  patch: { aiEnabled?: boolean; branchPageId?: number | null },
): Promise<boolean> {
  const store = await readStore()
  const conv = store.conversations.find((c) => c.id === conversationId)
  if (!conv) return false
  if (typeof patch.aiEnabled === 'boolean') {
    conv.aiEnabled = patch.aiEnabled
  }
  if ('branchPageId' in patch) {
    if (patch.branchPageId == null) {
      delete conv.branchPageId
    } else if (typeof patch.branchPageId === 'number' && BRANCH_IDS.has(patch.branchPageId)) {
      conv.branchPageId = patch.branchPageId
    } else {
      return false
    }
  }
  store.updatedAt = new Date().toISOString()
  await writeStore(store)
  return true
}

export async function patchFacebookPage(
  pageId: string,
  patch: { defaultBranchPageId?: number | null; aiMasterEnabled?: boolean },
): Promise<boolean> {
  const store = await readStore()
  const page = store.pages.find((p) => p.id === pageId)
  if (!page) return false
  if (typeof patch.aiMasterEnabled === 'boolean') {
    page.aiMasterEnabled = patch.aiMasterEnabled
  }
  if ('defaultBranchPageId' in patch) {
    if (patch.defaultBranchPageId == null) {
      delete page.defaultBranchPageId
    } else if (typeof patch.defaultBranchPageId === 'number' && BRANCH_IDS.has(patch.defaultBranchPageId)) {
      page.defaultBranchPageId = patch.defaultBranchPageId
    } else {
      return false
    }
  }
  store.updatedAt = new Date().toISOString()
  await writeStore(store)
  return true
}

/** Cộng dồn chi phí ước tính và ghi nhận cache hit cho lần gọi Gemini gần nhất. */
export async function applyFacebookConversationAiUsage(input: {
  conversationId: string
  addUsd: number
  contextCacheHit: boolean
}): Promise<void> {
  const store = await readStore()
  const conv = store.conversations.find((c) => c.id === input.conversationId)
  if (!conv) return
  const prev = conv.aiEstimatedTotalUsd ?? 0
  conv.aiEstimatedTotalUsd = prev + Math.max(0, input.addUsd)
  conv.aiLastContextCacheHit = input.contextCacheHit
  conv.aiLastRunAt = new Date().toISOString()
  store.updatedAt = new Date().toISOString()
  await writeStore(store)
}

export async function saveFacebookPages(pages: FacebookPageRecord[]): Promise<FacebookPageRecord[]> {
  const store = await readStore()
  const merged = new Map(store.pages.map((page) => [page.id, page]))
  for (const page of pages) {
    const prev = merged.get(page.id)
    merged.set(page.id, { ...(prev ?? {}), ...page, connected: true })
  }
  store.pages = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'vi'))
  store.updatedAt = new Date().toISOString()
  await writeStore(store)
  return store.pages
}

export async function enrichFacebookConversationProfiles(
  resolveCustomerProfile: (
    pageId: string,
    customerPsid: string,
  ) => Promise<FacebookCustomerProfile | null>,
): Promise<number> {
  const store = await readStore()
  let updated = 0
  for (const conversation of store.conversations) {
    if (conversation.customerName && conversation.avatarUrl) continue
    const profile = await resolveCustomerProfile(conversation.pageId, conversation.customerPsid).catch(() => null)
    if (!profile?.name && !profile?.avatarUrl) continue
    if (profile.name && profile.name !== conversation.customerName) {
      conversation.customerName = profile.name
      updated += 1
    }
    if (profile.avatarUrl && profile.avatarUrl !== conversation.avatarUrl) {
      conversation.avatarUrl = profile.avatarUrl
      updated += 1
    }
  }
  if (updated) {
    store.updatedAt = new Date().toISOString()
    await writeStore(store)
  }
  return updated
}

export type IngestFacebookWebhookOptions = {
  resolveCustomerProfile?: (
    pageId: string,
    customerPsid: string,
  ) => Promise<FacebookCustomerProfile | null>
  /**
   * Khi webhook không trích được URL (vd. chỉ sticker_id): gọi Graph `GET /{message-id}/attachments?fields=file_url`.
   */
  fetchAttachmentMediaFromGraph?: (
    pageId: string,
    messageMid: string,
  ) => Promise<{ images: string[]; videos: string[]; audios: string[] }>
}

export async function ingestFacebookWebhookPayload(
  payload: unknown,
  options?: IngestFacebookWebhookOptions,
): Promise<{
  conversationsTouched: number
  messagesStored: number
  pendingAiReplies: { conversationId: string; pageId: string; customerPsid: string }[]
}> {
  const body = payload as FacebookWebhookPayload
  const entries = Array.isArray(body.entry) ? body.entry : []
  const store = await readStore()
  let conversationsTouched = 0
  let messagesStored = 0
  const pendingAiReplies: { conversationId: string; pageId: string; customerPsid: string }[] = []

  for (const entry of entries) {
    const pageId = entry.id
    if (!pageId || !Array.isArray(entry.messaging)) continue
    if (!store.pages.some((page) => page.id === pageId)) {
      store.pages.push({ id: pageId, name: `Fanpage ${pageId}`, connected: true })
    }

    for (const event of entry.messaging) {
      const senderId = event.sender?.id
      const recipientId = event.recipient?.id
      const timestamp = isoFromMetaTimestamp(event.timestamp)
      if (!senderId || !recipientId) continue

      if (event.read || event.delivery) {
        const customerPsid = senderId === pageId ? recipientId : senderId
        const profile = await options?.resolveCustomerProfile?.(pageId, customerPsid).catch(() => null)
        const conversation = upsertConversation(store, pageId, customerPsid, timestamp, profile)
        if (event.read?.watermark) conversation.customerReadAt = isoFromMetaTimestamp(event.read.watermark)
        if (event.delivery?.watermark) conversation.pageDeliveredAt = isoFromMetaTimestamp(event.delivery.watermark)
        conversationsTouched += 1
        continue
      }

      const message = event.message
      const postback = event.postback
      if (!message && !postback && !event.referral) continue

      const isEcho = Boolean(message?.is_echo)
      const customerPsid = senderId === pageId ? recipientId : senderId
      const author: FacebookStoredMessage['author'] = senderId === pageId || isEcho ? 'page' : 'customer'
      let { images: attImages, videos: attVideos, audios: attAudios } = extractAttachmentMedia(message)
      const mid = message?.mid?.trim()
      const attList = message?.attachments
      if (
        options?.fetchAttachmentMediaFromGraph &&
        mid &&
        Array.isArray(attList) &&
        attList.length > 0 &&
        attImages.length === 0 &&
        attVideos.length === 0 &&
        attAudios.length === 0 &&
        shouldTryGraphAttachmentFallback(attList)
      ) {
        const fromGraph = await options.fetchAttachmentMediaFromGraph(pageId, mid).catch(() => ({
          images: [] as string[],
          videos: [] as string[],
          audios: [] as string[],
        }))
        attImages = [...new Set([...attImages, ...fromGraph.images])]
        attVideos = [...new Set([...attVideos, ...fromGraph.videos])]
        attAudios = [...new Set([...attAudios, ...fromGraph.audios])]
      }
      const referral = normalizeReferral(message?.referral ?? postback?.referral ?? event.referral)

      let text =
        message?.text?.trim() ||
        postback?.title?.trim() ||
        postback?.payload?.trim() ||
        ''
      if (!text) {
        if (referral?.title || referral?.photoUrl || referral?.videoUrl || referral?.adId) text = ''
        else if (attImages.length || attVideos.length || attAudios.length) text = ''
        else if (event.referral) text = ''
        else text = PLACEHOLDER_NO_TEXT
      }

      const profile = await options?.resolveCustomerProfile?.(pageId, customerPsid).catch(() => null)
      const conversation = upsertConversation(store, pageId, customerPsid, timestamp, profile)
      const id =
        message?.mid ||
        postback?.mid ||
        `${pageId}-${customerPsid}-${event.timestamp ?? Date.now()}-${conversation.messages.length}`

      conversation.ad = mergeAd(conversation.ad, referral)
      conversation.title = conversationTitle(customerPsid, text, {
        imageCount: attImages.length,
        videoCount: attVideos.length,
        audioCount: attAudios.length,
        adTitle: conversation.ad?.title,
      })
      if (!conversation.messages.some((item) => item.id === id)) {
        conversation.messages.push({
          id,
          author,
          text,
          timestamp,
          isEcho,
          referral,
          ...(attImages.length ? { images: attImages } : {}),
          ...(attVideos.length ? { videos: attVideos } : {}),
          ...(attAudios.length ? { audios: attAudios } : {}),
        })
        messagesStored += 1
        if (author === 'customer' && !isEcho) {
          pendingAiReplies.push({
            conversationId: conversation.id,
            pageId,
            customerPsid,
          })
        }
      }
      conversationsTouched += 1
    }
  }

  if (conversationsTouched || messagesStored) {
    store.updatedAt = new Date().toISOString()
    await writeStore(store)
  }

  const dedupedPending = [...new Map(pendingAiReplies.map((p) => [p.conversationId, p])).values()]

  return { conversationsTouched, messagesStored, pendingAiReplies: dedupedPending }
}

/** Ghi tin page gửi đi sau Graph thành công; echo webhook trùng `id` sẽ không thêm bản sao. */
export async function appendOutboundFacebookMessage(input: {
  pageId: string
  customerPsid: string
  message: FacebookStoredMessage
}): Promise<void> {
  const store = await readStore()
  const convId = `${input.pageId}:${input.customerPsid}`
  let conv = store.conversations.find((c) => c.id === convId)
  if (!conv) {
    conv = {
      id: convId,
      pageId: input.pageId,
      customerPsid: input.customerPsid,
      title: `Khách ${input.customerPsid.slice(-6)}`,
      updatedAt: input.message.timestamp,
      lastMessageAt: input.message.timestamp,
      messages: [],
    }
    store.conversations.unshift(conv)
  }
  if (!conv.messages.some((m) => m.id === input.message.id)) {
    conv.messages.push(input.message)
  }
  conv.lastMessageAt = input.message.timestamp
  conv.updatedAt = input.message.timestamp
  store.updatedAt = new Date().toISOString()
  await writeStore(store)
}
