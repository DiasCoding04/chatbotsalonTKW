import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import './App.css'
import { BRANCH_PAGES } from '../shared/salon-ai-context.ts'
import { TrainingChat } from './TrainingChat'

type TabKey = 'inbox' | 'training'
type ConversationStatus = 'new' | 'ai' | 'human' | 'closed'
type SyncState = 'idle' | 'syncing' | 'live' | 'needs-keys' | 'error'

type Page = {
  id: string
  name: string
  avatarUrl?: string
  unread: number
  connected: boolean
  defaultBranchPageId?: number
  /** false = tắt AI tự động cho toàn fanpage (hội thoại vẫn có thể bật/tắt riêng). */
  aiMasterEnabled?: boolean
}

type MessageReferral = {
  adId?: string
  title?: string
  source?: string
  type?: string
  ref?: string
  sourceUrl?: string
  refererUri?: string
  photoUrl?: string
  videoUrl?: string
}

type Message = {
  id: string
  author: 'customer' | 'ai' | 'staff'
  text: string
  time: string
  referralAdId?: string
  imageUrl?: string
  imageUrls?: string[]
  videoUrls?: string[]
  audioUrls?: string[]
  referral?: MessageReferral
}

type Conversation = {
  id: string
  pageId: string
  customerPsid: string
  customer: string
  avatar: string
  avatarUrl?: string
  title: string
  status: ConversationStatus
  aiEnabled: boolean
  lastMessageAt: string
  tags: string[]
  messages: Message[]
  sourceAd?: {
    adId?: string
    title?: string
    source?: string
    type?: string
    ref?: string
    refererUri?: string
    sourceUrl?: string
    photoUrl?: string
    videoUrl?: string
  }
  customerReadAt?: string
  pageDeliveredAt?: string
  /** id BRANCH_PAGES — khi có, AI inbox dùng chi nhánh này. */
  branchPageId?: number
  aiEstimatedTotalUsd?: number
  aiLastContextCacheHit?: boolean
  aiLastRunAt?: string
  /** Mốc sort theo `lastMessageAt` gốc (server); dùng khi xem “Tất cả fanpage”. */
  lastMessageSortTs?: number
}

type FacebookStatus = {
  configured: boolean
  appId: boolean
  appSecret: boolean
  pageAccessToken: boolean
  pageTokenCount?: number
  verifyToken: boolean
  webhookUrl: string
  /** Server: log JSON webhook ra stdout khi bật FACEBOOK_WEBHOOK_LOG_RAW_BODY */
  webhookLogRawBody?: boolean
  /** Server: ghi data/facebook-webhook-last.json mỗi webhook (tắt: FACEBOOK_WEBHOOK_NO_DEBUG_FILE=1). */
  webhookDebugFile?: boolean
  graphAttachmentsFallback?: boolean
}

type FacebookStoreMessage = {
  id: string
  author: 'customer' | 'page' | 'system'
  text: string
  timestamp: string
  images?: string[]
  videos?: string[]
  audios?: string[]
  referral?: {
    adId?: string
    title?: string
    source?: string
    type?: string
    ref?: string
    sourceUrl?: string
    photoUrl?: string
    videoUrl?: string
    raw?: {
      ads_context_data?: {
        ad_title?: string
        photo_url?: string
        video_url?: string
      }
    }
  }
}

type FacebookStoreConversation = {
  id: string
  pageId: string
  customerPsid: string
  customerName?: string
  avatarUrl?: string
  title: string
  lastMessageAt: string
  ad?: FacebookStoreMessage['referral'] & { refererUri?: string }
  messages: FacebookStoreMessage[]
  customerReadAt?: string
  pageDeliveredAt?: string
  /** false = tắt AI tự động (lưu trên server). */
  aiEnabled?: boolean
  branchPageId?: number
  aiEstimatedTotalUsd?: number
  aiLastContextCacheHit?: boolean
  aiLastRunAt?: string
}

type FacebookStorePage = {
  id: string
  name: string
  avatarUrl?: string
  connected: boolean
  defaultBranchPageId?: number
  aiMasterEnabled?: boolean
}

const STATUS_LABEL: Record<ConversationStatus, string> = {
  new: 'Tin mới',
  ai: 'AI đang xử lý',
  human: 'Nhân viên',
  closed: 'Đã xong',
}

/** Chế độ inbox: gộp hội thoại của mọi fanpage (không trùng id page Facebook thật). */
const ALL_FANPAGES_ID = '__all_fanpages__'

function nowTime() {
  return new Date().toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDateTime(value?: string): string {
  if (!value) return 'Chưa có'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  })
}

/** Quy đổi hiển thị chi phí AI inbox (USD ước tính → VND). */
const INBOX_AI_USD_TO_VND = 26_000

function formatInboxAiCostVnd(usd: number | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '—'
  const vnd = Math.round(usd * INBOX_AI_USD_TO_VND)
  return `≈ ${vnd.toLocaleString('vi-VN')} ₫`
}

const PLACEHOLDER_NO_TEXT = '[Tin nhắn không có nội dung text]'
const PLACEHOLDER_REFERRAL = '[Khách mở hội thoại từ nguồn referral]'

function isPlaceholderInboxText(text?: string): boolean {
  const t = text?.trim() ?? ''
  return t === PLACEHOLDER_NO_TEXT || t === PLACEHOLDER_REFERRAL
}

function adContextFromRaw(raw: unknown): { title?: string; photoUrl?: string; videoUrl?: string } {
  if (!raw || typeof raw !== 'object') return {}
  const top = raw as Record<string, unknown>
  const ads = top.ads_context_data
  if (ads && typeof ads === 'object') {
    const a = ads as { ad_title?: string; photo_url?: string; video_url?: string }
    return {
      title: typeof a.ad_title === 'string' ? a.ad_title : undefined,
      photoUrl: typeof a.photo_url === 'string' ? a.photo_url : undefined,
      videoUrl: typeof a.video_url === 'string' ? a.video_url : undefined,
    }
  }
  return {}
}

/** Meta đôi khi lồng referral / ads_context_data sâu hơn một tầng */
function deepFindAdsContextData(
  node: unknown,
  depth = 0,
): { ad_title?: string; photo_url?: string; video_url?: string } | undefined {
  if (depth > 8 || !node || typeof node !== 'object') return undefined
  const n = node as Record<string, unknown>
  const direct = n.ads_context_data
  if (direct && typeof direct === 'object') return direct as { ad_title?: string; photo_url?: string; video_url?: string }
  for (const key of Object.keys(n)) {
    const found = deepFindAdsContextData(n[key], depth + 1)
    if (found) return found
  }
  return undefined
}

function extractAdsContext(
  ad?: MessageReferral | FacebookStoreMessage['referral'] | Conversation['sourceAd'] | null,
): { title?: string; photoUrl?: string; videoUrl?: string } {
  if (!ad || typeof ad !== 'object') return {}
  const bag = ad as { raw?: unknown; ads_context_data?: unknown }
  const fromTop = bag.ads_context_data
  if (fromTop && typeof fromTop === 'object') {
    const a = fromTop as { ad_title?: string; photo_url?: string; video_url?: string }
    const t = typeof a.ad_title === 'string' ? a.ad_title : undefined
    const p = typeof a.photo_url === 'string' ? a.photo_url : undefined
    const v = typeof a.video_url === 'string' ? a.video_url : undefined
    if (t || p || v) return { title: t, photoUrl: p, videoUrl: v }
  }
  let raw = bag.raw
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown
    } catch {
      raw = undefined
    }
  }
  const shallow = adContextFromRaw(raw)
  if (shallow.title || shallow.photoUrl || shallow.videoUrl) return shallow
  const deepRaw = deepFindAdsContextData(raw)
  if (deepRaw) {
    return {
      title: typeof deepRaw.ad_title === 'string' ? deepRaw.ad_title : undefined,
      photoUrl: typeof deepRaw.photo_url === 'string' ? deepRaw.photo_url : undefined,
      videoUrl: typeof deepRaw.video_url === 'string' ? deepRaw.video_url : undefined,
    }
  }
  const deepAd = deepFindAdsContextData(ad)
  if (deepAd) {
    return {
      title: typeof deepAd.ad_title === 'string' ? deepAd.ad_title : undefined,
      photoUrl: typeof deepAd.photo_url === 'string' ? deepAd.photo_url : undefined,
      videoUrl: typeof deepAd.video_url === 'string' ? deepAd.video_url : undefined,
    }
  }
  return {}
}

function enrichAdLike(
  ad?: MessageReferral | FacebookStoreMessage['referral'] | Conversation['sourceAd'] | null,
): MessageReferral | undefined {
  if (!ad) return undefined
  const ctx = extractAdsContext(ad)
  const ext = ad as { refererUri?: string; type?: string }
  const out: MessageReferral = {
    adId: ad.adId,
    title: ad.title ?? ctx.title,
    source: ad.source,
    type: ext.type,
    ref: ad.ref,
    sourceUrl: ad.sourceUrl,
    refererUri: ext.refererUri,
    photoUrl: ad.photoUrl ?? ctx.photoUrl,
    videoUrl: ad.videoUrl ?? ctx.videoUrl,
  }
  if (!out.adId && !out.title && !out.photoUrl && !out.videoUrl && !out.ref && !out.source && !out.sourceUrl)
    return undefined
  return out
}

function deriveConversationTitle(item: FacebookStoreConversation): string {
  for (let i = item.messages.length - 1; i >= 0; i--) {
    const t = item.messages[i]?.text?.trim()
    if (t && !isPlaceholderInboxText(t)) return t.slice(0, 80)
  }
  const convAd = enrichAdLike(item.ad ?? undefined)
  if (convAd?.title) return convAd.title.slice(0, 80)
  if (convAd?.adId) return `Quảng cáo · ${convAd.adId.slice(0, 24)}`
  for (let i = item.messages.length - 1; i >= 0; i--) {
    const m = item.messages[i]
    if (m?.images?.length || m?.videos?.length || m?.audios?.length) return `Ảnh / file · ${item.customerPsid.slice(-6)}`
    const r = enrichAdLike(m?.referral ?? undefined)
    if (r?.title) return r.title.slice(0, 80)
  }
  return item.title
}

function listTitleFromStored(item: FacebookStoreConversation): string {
  if (!isPlaceholderInboxText(item.title)) return item.title
  return deriveConversationTitle(item)
}

function urlLooksLikeStaticImage(url: string): boolean {
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return true
  // Meta hay đặt preview dạng ảnh JPG dưới key video_url (đường dẫn t15.*)
  if (/fbcdn\.net\/v\/t15\./i.test(url) && /\.(jpe?g|png|webp)/i.test(url)) return true
  return false
}

function urlLooksLikeAudioFile(url: string): boolean {
  return /\.(mp3|aac|m4a|oga|ogg|opus|wav|weba|amr|3gp|caf)($|\?)/i.test(url.split(/[?#]/)[0])
}

function creativePreviewUrl(ad?: MessageReferral | null): string | undefined {
  if (!ad) return undefined
  if (ad.photoUrl) return ad.photoUrl
  if (ad.videoUrl && urlLooksLikeStaticImage(ad.videoUrl)) return ad.videoUrl
  return undefined
}

/** fbcdn thường chặn hotlink từ web app — tải qua proxy server. */
function metaHostedMediaSrc(original: string): string {
  if (!original.startsWith('http')) return original
  try {
    const h = new URL(original).hostname.toLowerCase()
    if (
      h.endsWith('fbcdn.net') ||
      h === 'facebook.com' ||
      h.endsWith('.facebook.com') ||
      h.endsWith('fb.com') ||
      h.endsWith('fbsbx.com')
    ) {
      return `/api/facebook/cdn-media?u=${encodeURIComponent(original)}`
    }
  } catch {
    /* ignore */
  }
  return original
}

function AdCreativeMedia({ referral }: { referral: MessageReferral }) {
  const original = creativePreviewUrl(referral)
  if (original) {
    const proxied = metaHostedMediaSrc(original)
    return (
      <img
        className="bubble-ad-creative"
        src={proxied}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(ev) => {
          const el = ev.currentTarget
          if (el.dataset.fallback === '1') return
          el.dataset.fallback = '1'
          el.src = original
        }}
      />
    )
  }
  if (referral.videoUrl)
    return (
      <video className="bubble-ad-video" src={referral.videoUrl} controls playsInline preload="metadata" />
    )
  return null
}

/** Voice thường là MP4 chỉ có track âm thanh — <video> tạo khung đen; chuyển sang <audio> khi không có khung hình. */
function BubbleMessengerVideoOrAudio({ url, index }: { url: string; index: number }) {
  const proxied = metaHostedMediaSrc(url)
  const [asAudio, setAsAudio] = useState(() => urlLooksLikeAudioFile(url))

  if (urlLooksLikeStaticImage(url)) {
    return (
      <img
        key={`vimg-${index}`}
        className="bubble-image"
        src={proxied}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(ev) => {
          const el = ev.currentTarget
          if (el.dataset.fallback === '1') return
          el.dataset.fallback = '1'
          el.src = url
        }}
      />
    )
  }

  if (asAudio) {
    return (
      <audio
        key={`fb-aud-${index}`}
        className="bubble-audio"
        src={proxied}
        controls
        preload="metadata"
      />
    )
  }

  return (
    <video
      key={`fb-vid-${index}`}
      className="bubble-video"
      src={proxied}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={(e) => {
        const el = e.currentTarget
        if (el.videoWidth === 0 && el.videoHeight === 0) setAsAudio(true)
      }}
    />
  )
}

function MessageMediaGallery({
  imageUrls,
  videoUrls,
  audioUrls,
}: {
  imageUrls?: string[]
  videoUrls?: string[]
  audioUrls?: string[]
}) {
  const imgs = imageUrls ?? []
  const vids = videoUrls ?? []
  const auds = audioUrls ?? []
  if (!imgs.length && !vids.length && !auds.length) return null
  return (
    <div className="bubble-media-gallery">
      {imgs.map((url, i) => {
        const proxied = metaHostedMediaSrc(url)
        if (urlLooksLikeAudioFile(url)) {
          return (
            <audio
              key={`img-aud-${i}`}
              className="bubble-audio"
              src={proxied}
              controls
              preload="metadata"
            />
          )
        }
        return (
          <img
            key={`img-${i}`}
            className="bubble-image"
            src={proxied}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(ev) => {
              const el = ev.currentTarget
              if (el.dataset.fallback === '1') return
              el.dataset.fallback = '1'
              el.src = url
            }}
          />
        )
      })}
      {auds.map((url, i) => (
        <audio
          key={`aud-${i}`}
          className="bubble-audio"
          src={metaHostedMediaSrc(url)}
          controls
          preload="metadata"
        />
      ))}
      {vids.map((url, i) => (
        <BubbleMessengerVideoOrAudio key={`vid-wrap-${i}`} url={url} index={i} />
      ))}
    </div>
  )
}

function mapStoredConversation(item: FacebookStoreConversation): Conversation {
  const fallbackName = `Khách ${item.customerPsid.slice(-6)}`
  const customer = item.customerName?.trim() || fallbackName
  const sortTs = new Date(item.lastMessageAt).getTime()
  return {
    id: item.id,
    pageId: item.pageId,
    customerPsid: item.customerPsid,
    customer,
    avatar:
      customer
        .split(/\s+/)
        .filter(Boolean)
        .slice(-2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('') || item.customerPsid.slice(-2).toUpperCase(),
    avatarUrl: item.avatarUrl,
    title: listTitleFromStored(item),
    status: item.aiEnabled === false ? 'human' : 'ai',
    aiEnabled: item.aiEnabled !== false,
    lastMessageAt: formatMessageTime(item.lastMessageAt),
    tags: [
      item.ad?.adId ? 'Từ quảng cáo' : 'Facebook',
      item.customerReadAt ? 'Khách đã đọc' : 'Tin mới',
    ],
    messages: item.messages.map((message) => {
      const referral = enrichAdLike(message.referral ?? undefined)
      return {
        id: message.id,
        author: message.author === 'page' ? 'staff' : message.author === 'system' ? 'ai' : 'customer',
        text: message.text,
        time: formatMessageTime(message.timestamp),
        referralAdId: referral?.adId ?? message.referral?.adId,
        referral,
        imageUrls: message.images,
        videoUrls: message.videos,
        audioUrls: message.audios,
      }
    }),
    sourceAd: enrichAdLike(item.ad ?? undefined),
    customerReadAt: item.customerReadAt,
    pageDeliveredAt: item.pageDeliveredAt,
    branchPageId: item.branchPageId,
    aiEstimatedTotalUsd: item.aiEstimatedTotalUsd,
    aiLastContextCacheHit: item.aiLastContextCacheHit,
    aiLastRunAt: item.aiLastRunAt,
    lastMessageSortTs: Number.isFinite(sortTs) ? sortTs : 0,
  }
}

function Avatar({ conversation, large = false }: { conversation: Conversation; large?: boolean }) {
  return (
    <span className={large ? 'avatar large' : 'avatar'}>
      {conversation.avatarUrl ? (
        <img src={conversation.avatarUrl} alt={conversation.customer} />
      ) : (
        conversation.avatar
      )}
    </span>
  )
}

function PageAvatar({ page }: { page: Page }) {
  return (
    <span className="page-icon">
      {page.avatarUrl ? <img src={page.avatarUrl} alt={page.name} /> : page.name.slice(0, 1)}
    </span>
  )
}

function facebookSetupMessage(status: FacebookStatus | null): string {
  if (!status) return 'Đang kiểm tra kết nối fanpage...'
  const missing = [
    !status.appId ? 'App ID' : '',
    !status.appSecret ? 'App Secret' : '',
    !status.pageAccessToken ? 'Page Access Token' : '',
    !status.verifyToken ? 'Verify Token' : '',
  ].filter(Boolean)
  if (!missing.length) {
    return 'Tin nhắn từ khách qua fanpage sẽ hiện ở đây và được cập nhật liên tục.'
  }
  if (status.pageTokenCount) {
    return 'Kết nối Facebook chưa hoàn tất. Vui lòng liên hệ người phụ trách hệ thống.'
  }
  return 'Chưa kết nối được Facebook. Liên hệ người phụ trách để bật kết nối.'
}

function syncCardTitle(state: SyncState): string {
  switch (state) {
    case 'live':
      return 'Đã kết nối fanpage'
    case 'syncing':
      return 'Đang đồng bộ'
    case 'needs-keys':
      return 'Chưa kết nối đủ'
    case 'error':
      return 'Không kết nối được'
    default:
      return 'Fanpage'
  }
}

async function fetchFacebookStatus(): Promise<FacebookStatus | null> {
  const res = await fetch('/api/facebook/status', { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Không kiểm tra được kết nối Facebook (${res.status}).`)
  return (await res.json()) as FacebookStatus
}

async function patchFacebookConversationApi(
  conversationId: string,
  patch: { aiEnabled?: boolean; branchPageId?: number | null },
): Promise<void> {
  const res = await fetch('/api/facebook/conversation', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, ...patch }),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!res.ok || body.ok === false) throw new Error(body.error || `Không cập nhật được hội thoại (${res.status}).`)
}

async function patchFacebookPageApi(
  pageId: string,
  patch: { defaultBranchPageId?: number | null; aiMasterEnabled?: boolean },
): Promise<FacebookStorePage | null> {
  const res = await fetch('/api/facebook/page', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId, ...patch }),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; page?: FacebookStorePage }
  if (!res.ok || body.ok === false) throw new Error(body.error || `Không cập nhật được fanpage (${res.status}).`)
  return body.page ?? null
}

async function fetchFacebookInboxData(): Promise<{ pages: Page[]; conversations: Conversation[] }> {
  const res = await fetch('/api/facebook/conversations', { cache: 'no-store' })
  if (res.status === 404) return { pages: [], conversations: [] }
  if (!res.ok) throw new Error(`Không tải được hội thoại Facebook (${res.status}).`)
  const body = (await res.json()) as {
    pages?: FacebookStorePage[]
    conversations?: FacebookStoreConversation[]
  }
  const conversations = (body.conversations ?? []).map(mapStoredConversation)
  const unreadByPage = new Map<string, number>()
  for (const conversation of conversations) {
    if (conversation.status === 'new') {
      unreadByPage.set(conversation.pageId, (unreadByPage.get(conversation.pageId) ?? 0) + 1)
    }
  }
  return {
    pages: (body.pages ?? []).map((page) => ({
      id: page.id,
      name: page.name,
      avatarUrl: page.avatarUrl,
      unread: unreadByPage.get(page.id) ?? 0,
      connected: page.connected,
      defaultBranchPageId: page.defaultBranchPageId,
      aiMasterEnabled: page.aiMasterEnabled,
    })),
    conversations,
  }
}
async function triggerFacebookSync() {
  const res = await fetch('/api/facebook/sync', { method: 'POST' })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
    pages?: FacebookStorePage[]
  }
  if (!res.ok) throw new Error(body.error || `Không đồng bộ được Facebook (${res.status}).`)
  return body
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const current = document.documentElement.getAttribute('data-theme')
    return current === 'dark' ? 'dark' : 'light'
  })
  const [activeTab, setActiveTab] = useState<TabKey>('inbox')
  const [pages, setPages] = useState<Page[]>([])
  const [selectedPageId, setSelectedPageId] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState('')
  const [draft, setDraft] = useState('')
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const composerFileRef = useRef<HTMLInputElement>(null)
  const messageFeedRef = useRef<HTMLDivElement>(null)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [syncMessage, setSyncMessage] = useState('Đang kiểm tra kết nối fanpage...')
  const [facebookStatus, setFacebookStatus] = useState<FacebookStatus | null>(null)
  const [facebookConversationError, setFacebookConversationError] = useState<string | null>(null)
  const [facebookSendBusy, setFacebookSendBusy] = useState(false)
  const [pageSettingsPageId, setPageSettingsPageId] = useState<string | null>(null)
  const [pageModalBranch, setPageModalBranch] = useState('')
  const [pageModalMasterAi, setPageModalMasterAi] = useState(true)
  const [isMobileInbox, setIsMobileInbox] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 940px)').matches : false,
  )
  const [mobileInboxPane, setMobileInboxPane] = useState<'pages' | 'conversations' | 'chat'>('pages')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('salon-theme', theme)
    } catch {
      // ignore
    }
  }, [theme])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 940px)')
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobileInbox(event.matches)
      if (!event.matches) setMobileInboxPane('pages')
    }
    setIsMobileInbox(mq.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        const status = await fetchFacebookStatus()
        if (!alive) return
        setFacebookStatus(status)
        if (status?.configured) {
          setSyncState('live')
          setSyncMessage(facebookSetupMessage(status))
        } else {
          setSyncState('needs-keys')
          setSyncMessage(facebookSetupMessage(status))
        }
      } catch (e) {
        if (!alive) return
        setSyncState('error')
        setSyncMessage(e instanceof Error ? e.message : String(e))
      }
    }

    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        const inboxData = await fetchFacebookInboxData()
        if (!alive) return
        setPages(inboxData.pages)
        setConversations(inboxData.conversations)
        setSelectedPageId((current) => {
          if (!inboxData.pages.length) return ''
          if (current === ALL_FANPAGES_ID) return ALL_FANPAGES_ID
          if (current && inboxData.pages.some((page) => page.id === current)) return current
          return inboxData.pages[0].id
        })
        setSelectedConversationId((current) => {
          if (!inboxData.conversations.length) return ''
          if (current && inboxData.conversations.some((item) => item.id === current)) return current
          return inboxData.conversations[0].id
        })
        setFacebookConversationError(null)
      } catch (e) {
        if (!alive) return
        setFacebookConversationError(e instanceof Error ? e.message : String(e))
      }
    }

    void load()
    const timer = window.setInterval(() => void load(), 4_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    setPendingImage(null)
  }, [selectedConversationId])

  useEffect(() => {
    if (!pageSettingsPageId) return
    const p = pages.find((x) => x.id === pageSettingsPageId)
    if (!p) {
      setPageSettingsPageId(null)
      return
    }
    setPageModalBranch(p.defaultBranchPageId != null ? String(p.defaultBranchPageId) : '')
    setPageModalMasterAi(p.aiMasterEnabled !== false)
  }, [pageSettingsPageId, pages])

  useEffect(() => {
    if (!pageSettingsPageId) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setPageSettingsPageId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pageSettingsPageId])

  const filteredConversations = useMemo(() => {
    if (selectedPageId === ALL_FANPAGES_ID) {
      return [...conversations].sort((a, b) => (b.lastMessageSortTs ?? 0) - (a.lastMessageSortTs ?? 0))
    }
    return conversations.filter((item) => item.pageId === selectedPageId)
  }, [conversations, selectedPageId])

  const selectedConversation =
    filteredConversations.find((item) => item.id === selectedConversationId) ?? filteredConversations[0]

  useEffect(() => {
    if (!selectedPageId) return
    const currentInPage = filteredConversations.find((item) => item.id === selectedConversationId)
    if (!currentInPage) {
      setSelectedConversationId(filteredConversations[0]?.id ?? '')
    }
  }, [selectedPageId, filteredConversations, selectedConversationId])

  useEffect(() => {
    if (!isMobileInbox) return
    if (mobileInboxPane === 'chat' && !selectedConversation) {
      setMobileInboxPane('conversations')
    }
  }, [isMobileInbox, mobileInboxPane, selectedConversation])

  const inboxMessagesScrollKey = useMemo(() => {
    if (!selectedConversation) return ''
    const msgs = selectedConversation.messages
    const last = msgs[msgs.length - 1]
    return `${selectedConversation.id}|${msgs.length}|${last?.id ?? ''}|${last?.time ?? ''}`
  }, [selectedConversation])

  useLayoutEffect(() => {
    const el = messageFeedRef.current
    if (!el || !inboxMessagesScrollKey) return
    el.scrollTop = el.scrollHeight
  }, [inboxMessagesScrollKey])

  const selectedPage = pages.find((page) => page.id === selectedConversation?.pageId)

  const pageSettingsTotalUsd = useMemo(() => {
    if (!pageSettingsPageId) return 0
    return conversations.reduce(
      (sum, c) => (c.pageId === pageSettingsPageId ? sum + (c.aiEstimatedTotalUsd ?? 0) : sum),
      0,
    )
  }, [pageSettingsPageId, conversations])

  const totalUnread = pages.reduce((sum, page) => sum + page.unread, 0)
  const aiActive = conversations.filter((item) => item.aiEnabled).length
  const needsHuman = conversations.filter((item) => item.status === 'human').length

  const updateConversation = (id: string, updater: (conversation: Conversation) => Conversation) => {
    setConversations((items) => items.map((item) => (item.id === id ? updater(item) : item)))
  }

  const handleSync = async () => {
    setSyncState('syncing')
    setSyncMessage('Đang đồng bộ dữ liệu fanpage...')
    try {
      const result = await triggerFacebookSync()
      if (Array.isArray(result.pages)) {
        setPages(
          result.pages.map((page) => ({
            id: page.id,
            name: page.name,
            avatarUrl: page.avatarUrl,
            unread: 0,
            connected: page.connected,
            defaultBranchPageId: page.defaultBranchPageId,
            aiMasterEnabled: page.aiMasterEnabled,
          })),
        )
      }
      setSyncState(facebookStatus?.configured ? 'live' : 'needs-keys')
      setSyncMessage(
        facebookStatus?.configured ? 'Danh sách fanpage đã được cập nhật.' : facebookSetupMessage(facebookStatus),
      )
    } catch (e) {
      setSyncState('error')
      setSyncMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleAi = (id: string) => {
    const current = conversations.find((c) => c.id === id)
    if (!current) return
    const nextAi = !current.aiEnabled
    updateConversation(id, (conversation) => ({
      ...conversation,
      aiEnabled: nextAi,
      status: nextAi ? 'ai' : 'human',
    }))
    void patchFacebookConversationApi(id, { aiEnabled: nextAi }).catch((err) => {
      setFacebookConversationError(err instanceof Error ? err.message : String(err))
      updateConversation(id, (conversation) => ({
        ...conversation,
        aiEnabled: current.aiEnabled,
        status: current.aiEnabled ? 'ai' : 'human',
      }))
    })
  }

  const savePageSettingsModal = () => {
    if (!pageSettingsPageId) return
    void (async () => {
      try {
        const branchVal = pageModalBranch === '' ? null : Number(pageModalBranch)
        const savedPage = await patchFacebookPageApi(pageSettingsPageId, {
          defaultBranchPageId: branchVal,
          aiMasterEnabled: pageModalMasterAi,
        })
        setPages((prev) =>
          prev.map((p) => {
            if (p.id !== pageSettingsPageId) return p
            return {
              ...p,
              avatarUrl: savedPage?.avatarUrl ?? p.avatarUrl,
              connected: savedPage?.connected ?? p.connected,
              name: savedPage?.name ?? p.name,
              aiMasterEnabled: savedPage?.aiMasterEnabled,
              defaultBranchPageId: savedPage?.defaultBranchPageId,
            }
          }),
        )
        setFacebookConversationError(null)
        setPageSettingsPageId(null)
      } catch (err) {
        setFacebookConversationError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  const sendStaffMessage = async () => {
    if (!selectedConversation) return
    const text = draft.trim()
    const imageUrl = pendingImage?.dataUrl
    if (!text && !imageUrl) return

    if (facebookStatus?.configured) {
      setFacebookSendBusy(true)
      try {
        const res = await fetch('/api/facebook/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageId: selectedConversation.pageId,
            recipientPsid: selectedConversation.customerPsid,
            ...(text ? { text } : {}),
            ...(imageUrl ? { imageDataUrl: imageUrl } : {}),
          }),
        })
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !body.ok) {
          window.alert(body.error || `Gửi Messenger thất bại (${res.status}).`)
          return
        }
        setDraft('')
        setPendingImage(null)
        const inboxData = await fetchFacebookInboxData()
        setPages(inboxData.pages)
        setConversations(inboxData.conversations)
      } finally {
        setFacebookSendBusy(false)
      }
      return
    }

    updateConversation(selectedConversation.id, (conversation) => ({
      ...conversation,
      status: 'human',
      lastMessageAt: nowTime(),
      lastMessageSortTs: Date.now(),
      messages: [
        ...conversation.messages,
        {
          id: `staff-${Date.now()}`,
          author: 'staff',
          text,
          time: nowTime(),
          ...(imageUrl ? { imageUrl } : {}),
        },
      ],
    }))
    setDraft('')
    setPendingImage(null)
  }

  const onComposerImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !file.type.startsWith('image/')) return
    const maxBytes = 4 * 1024 * 1024
    if (file.size > maxBytes) {
      window.alert('Ảnh quá lớn (tối đa 4MB).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setPendingImage({ dataUrl: reader.result, name: file.name })
      }
    }
    reader.readAsDataURL(file)
  }

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    sendStaffMessage()
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">TKW</div>
          <div>
            <h1>Salon Tú Ka Wa</h1>
            <p>Fanpage inbox + training AI</p>
          </div>
        </div>
        <button
          type="button"
          className="ghost-button theme-toggle"
          onClick={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>

        <nav className="inbox-tabs" aria-label="Khu vực làm việc">
          <button
            type="button"
            className={activeTab === 'inbox' ? 'inbox-tab active' : 'inbox-tab'}
            onClick={() => setActiveTab('inbox')}
          >
            Inbox
          </button>
          <button
            type="button"
            className={activeTab === 'training' ? 'inbox-tab active' : 'inbox-tab'}
            onClick={() => setActiveTab('training')}
          >
            Training
          </button>
        </nav>

        <div className="metric-stack">
          <div className="metric">
            <span>Tin chưa đọc</span>
            <strong>{totalUnread}</strong>
          </div>
          <div className="metric">
            <span>AI đang bật</span>
            <strong>{aiActive}</strong>
          </div>
          <div className="metric">
            <span>Cần nhân viên</span>
            <strong>{needsHuman}</strong>
          </div>
        </div>

        <div className="sync-card">
          <div className={`sync-dot ${syncState}`} />
          <div>
            <strong>{syncCardTitle(syncState)}</strong>
            <p>{syncMessage}</p>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <section
          className="workspace-section workspace-section-inbox"
          aria-hidden={activeTab !== 'inbox'}
          style={{ display: activeTab === 'inbox' ? undefined : 'none' }}
        >
          <div className="inbox-section-shell">
            <section className="topbar">
              <div>
                <p className="eyebrow">Developer: Nguyễn Việt Sơn</p>
                <p className="topbar-contact">Contact: 0978478240</p>
              </div>
              <div className="topbar-actions">
                <button type="button" className="ghost-button" onClick={() => void handleSync()}>
                  {syncState === 'syncing' ? 'Đang đồng bộ...' : 'Đồng bộ Facebook'}
                </button>
              </div>
            </section>

            {facebookConversationError && <div className="notice error">{facebookConversationError}</div>}

            <section
              className={`inbox-layout${isMobileInbox ? ' mobile' : ''}${isMobileInbox ? ` show-${mobileInboxPane}` : ''}`}
            >
              <div className="inbox-list-pane">
              <div className="page-panel">
                <div className="field-label">Fanpage</div>

                <div className="page-list">
                  {pages.length > 0 && (
                    <div
                      className={
                        selectedPageId === ALL_FANPAGES_ID ? 'page-row page-row-all-fanpages active' : 'page-row page-row-all-fanpages'
                      }
                    >
                      <button
                        type="button"
                        className="page-row-main"
                        onClick={() => {
                          setSelectedPageId(ALL_FANPAGES_ID)
                          const sorted = [...conversations].sort(
                            (a, b) => (b.lastMessageSortTs ?? 0) - (a.lastMessageSortTs ?? 0),
                          )
                          const first = sorted[0]
                          if (first) setSelectedConversationId(first.id)
                          if (isMobileInbox) setMobileInboxPane('conversations')
                        }}
                      >
                        <span className="page-icon" aria-hidden>
                          ⧉
                        </span>
                        <span>
                          <strong>Tất cả fanpage</strong>
                          <small>Xem tin nhắn gộp mọi trang</small>
                        </span>
                        {totalUnread > 0 ? <b>{totalUnread}</b> : null}
                      </button>
                    </div>
                  )}
                  {pages.map((page) => (
                    <div
                      key={page.id}
                      className={selectedPageId === page.id ? 'page-row active' : 'page-row'}
                    >
                      <button
                        type="button"
                        className="page-row-main"
                        onClick={() => {
                          setSelectedPageId(page.id)
                          const forPage = conversations
                            .filter((item) => item.pageId === page.id)
                            .sort((a, b) => (b.lastMessageSortTs ?? 0) - (a.lastMessageSortTs ?? 0))
                          const next = forPage[0]
                          if (next) setSelectedConversationId(next.id)
                          if (isMobileInbox) setMobileInboxPane('conversations')
                        }}
                      >
                        <PageAvatar page={page} />
                        <span>
                          <strong>{page.name}</strong>
                          <small>{page.connected ? 'Đã kết nối' : 'Chưa kết nối fanpage'}</small>
                        </span>
                        {page.unread > 0 && <b>{page.unread}</b>}
                      </button>
                      <button
                        type="button"
                        className="page-row-settings"
                        aria-label={`Cài đặt ${page.name}`}
                        title="Cài đặt fanpage"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPageSettingsPageId(page.id)
                        }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
                          <path
                            d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M16.34 6.66l1.41-1.41"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>

                {!pages.length && (
                  <div className="empty-panel">
                    <strong>Chưa có fanpage thật</strong>
                    <span>Bấm nút Đồng bộ Facebook ở thanh trên để tải danh sách fanpage.</span>
                  </div>
                )}
              </div>

              <div className="conversation-list" aria-label="Danh sách hội thoại">
                {isMobileInbox && (
                  <div className="mobile-subhead">
                    <button type="button" className="mobile-back-btn" onClick={() => setMobileInboxPane('pages')}>
                      ← Trang
                    </button>
                    <strong>
                      {selectedPageId === ALL_FANPAGES_ID
                        ? 'Tất cả fanpage'
                        : (pages.find((p) => p.id === selectedPageId)?.name ?? 'Hội thoại')}
                    </strong>
                  </div>
                )}
                {!filteredConversations.length && (
                  <div className="empty-panel">
                    <strong>Chưa có hội thoại thật</strong>
                    <span>Nhắn thử vào fanpage — tin mới sẽ hiện ở đây.</span>
                  </div>
                )}
                {filteredConversations.map((conversation) => (
                  <button
                    type="button"
                    key={conversation.id}
                    className={
                      conversation.id === selectedConversation?.id
                        ? 'conversation-row active'
                        : 'conversation-row'
                    }
                    onClick={() => {
                      setSelectedConversationId(conversation.id)
                      if (isMobileInbox) setMobileInboxPane('chat')
                    }}
                  >
                    <Avatar conversation={conversation} />
                    <span className="conversation-main">
                      <span className="conversation-head">
                        <strong>{conversation.customer}</strong>
                        <time>{conversation.lastMessageAt}</time>
                      </span>
                      <span className="conversation-title">{conversation.title}</span>
                      <span className="conversation-ai-cost">
                        Chi phí AI (ước tính): {formatInboxAiCostVnd(conversation.aiEstimatedTotalUsd)}
                      </span>
                      <span className="tag-line">
                        {conversation.tags.slice(0, 2).map((tag) => (
                          <em key={tag}>{tag}</em>
                        ))}
                      </span>
                      {conversation.sourceAd?.adId && (
                        <span className="ad-source-mini">Ad {conversation.sourceAd.adId}</span>
                      )}
                    </span>
                    <span className={`status-pill ${conversation.status}`}>
                      {STATUS_LABEL[conversation.status]}
                    </span>
                  </button>
                ))}
              </div>
              </div>

              {selectedConversation && (
                <section className="chat-panel">
                  <header className="chat-head">
                    <div className="customer-title">
                      {isMobileInbox && (
                        <button
                          type="button"
                          className="chat-back"
                          onClick={() => setMobileInboxPane('conversations')}
                          aria-label="Quay lại danh sách"
                        >
                          ← Tin nhắn
                        </button>
                      )}
                      <Avatar conversation={selectedConversation} large />
                      <div>
                        <h3>{selectedConversation.customer}</h3>
                        <p className="chat-head-sub">{selectedPage?.name ?? 'Fanpage'}</p>
                        <p className="chat-head-cost">
                          Chi phí AI (ước tính) hội thoại này:{' '}
                          <strong>{formatInboxAiCostVnd(selectedConversation.aiEstimatedTotalUsd)}</strong>
                        </p>
                      </div>
                    </div>

                    <label className="ai-switch">
                      <span>
                        <strong>AI trả lời</strong>
                        <small>
                          {selectedConversation.aiEnabled ? 'Tự động phản hồi tin mới' : 'Tạm dừng cho hội thoại này'}
                          {selectedPage?.aiMasterEnabled === false
                            ? ' · Fanpage đang tắt AI toàn page (bật trong ⚙ fanpage để chạy).'
                            : ''}
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        checked={selectedConversation.aiEnabled}
                        onChange={() => toggleAi(selectedConversation.id)}
                      />
                      <i aria-hidden="true" />
                    </label>
                  </header>

                  <div className="message-feed" ref={messageFeedRef}>
                    <div className="conversation-intel">
                      <div>
                        <span>Nguồn quảng cáo</span>
                        {(() => {
                          const ad = selectedConversation.sourceAd as MessageReferral | undefined
                          const thumb = creativePreviewUrl(ad)
                          if (thumb) {
                            const proxied = metaHostedMediaSrc(thumb)
                            return (
                              <img
                                className="intel-ad-thumb"
                                src={proxied}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                onError={(ev) => {
                                  const el = ev.currentTarget
                                  if (el.dataset.fallback === '1') return
                                  el.dataset.fallback = '1'
                                  el.src = thumb
                                }}
                              />
                            )
                          }
                          if (ad?.videoUrl)
                            return (
                              <video
                                className="intel-ad-thumb intel-ad-video"
                                src={metaHostedMediaSrc(ad.videoUrl)}
                                controls
                                playsInline
                                preload="metadata"
                              />
                            )
                          return null
                        })()}
                        <strong>
                          {selectedConversation.sourceAd?.title ||
                            selectedConversation.sourceAd?.adId ||
                            'Chưa có referral quảng cáo'}
                        </strong>
                        {selectedConversation.sourceAd?.adId && (
                          <small>Ad ID: {selectedConversation.sourceAd.adId}</small>
                        )}
                        {selectedConversation.sourceAd?.ref && (
                          <small>Ref: {selectedConversation.sourceAd.ref}</small>
                        )}
                      </div>
                      <div>
                        <span>Trạng thái Messenger</span>
                        <strong>Đọc / giao tin</strong>
                        <small>
                          Khách đọc: {formatDateTime(selectedConversation.customerReadAt)} · Giao tin:{' '}
                          {formatDateTime(selectedConversation.pageDeliveredAt)}
                        </small>
                      </div>
                    </div>
                    {selectedConversation.messages.map((message) => {
                      const referralBlock =
                        Boolean(message.referral) &&
                        Boolean(
                          message.referral!.adId ||
                            message.referral!.title ||
                            message.referral!.photoUrl ||
                            message.referral!.videoUrl ||
                            message.referral!.ref ||
                            message.referral!.source,
                        )
                      const hasGallery =
                        (message.imageUrls?.length ?? 0) > 0 ||
                        (message.videoUrls?.length ?? 0) > 0 ||
                        (message.audioUrls?.length ?? 0) > 0
                      const hasStaffImg = Boolean(message.imageUrl)
                      const hasText =
                        Boolean(message.text.trim()) && !isPlaceholderInboxText(message.text)
                      const hasAny = referralBlock || hasGallery || hasStaffImg || hasText

                      return (
                      <article key={message.id} className={`bubble ${message.author}`}>
                        <span className="bubble-meta">
                          {message.author === 'customer'
                            ? selectedConversation.customer
                            : message.author === 'ai'
                              ? 'AI'
                              : 'Nhân viên'}
                          {' · '}
                          {message.time}
                        </span>
                        {referralBlock ? (
                          <div className="bubble-ad-card">
                            {message.referral!.title ? (
                              <strong className="bubble-ad-title">{message.referral!.title}</strong>
                            ) : null}
                            <AdCreativeMedia referral={message.referral!} />
                            <div className="bubble-ad-meta">
                              {message.referral!.source ? <span>{message.referral!.source}</span> : null}
                              {message.referral!.type ? <span>{message.referral!.type}</span> : null}
                              {message.referral!.adId ? <span>Ad ID: {message.referral!.adId}</span> : null}
                              {message.referral!.ref ? <span>Ref: {message.referral!.ref}</span> : null}
                              {message.referral!.sourceUrl ? (
                                <a
                                  className="bubble-ad-link"
                                  href={message.referral!.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Mở liên kết
                                </a>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        <MessageMediaGallery
                          imageUrls={message.imageUrls}
                          videoUrls={message.videoUrls}
                          audioUrls={message.audioUrls}
                        />
                        {message.imageUrl ? (
                          <img
                            className="bubble-image"
                            src={message.imageUrl}
                            alt=""
                            referrerPolicy="no-referrer"
                          />
                        ) : null}
                        {hasText ? <p>{message.text}</p> : null}
                        {!hasAny ? (
                          <p className="bubble-empty-hint">
                            Tin này không có nội dung hiển thị được (ví dụ chỉ sticker hoặc loại file chưa hỗ trợ).
                          </p>
                        ) : null}
                      </article>
                      )
                    })}
                  </div>

                  <footer className="inbox-composer">
                    <input
                      ref={composerFileRef}
                      type="file"
                      accept="image/*"
                      className="composer-file-input"
                      onChange={onComposerImageChange}
                    />
                    {pendingImage ? (
                      <div className="composer-preview">
                        <img src={pendingImage.dataUrl} alt={pendingImage.name} />
                        <button
                          type="button"
                          className="composer-preview-remove"
                          aria-label="Bỏ ảnh"
                          onClick={() => setPendingImage(null)}
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                    <div className="composer-pill">
                      <button
                        type="button"
                        className="composer-pill-add"
                        aria-label="Thêm ảnh"
                        title="Thêm ảnh"
                        onClick={() => composerFileRef.current?.click()}
                      >
                        <span aria-hidden>+</span>
                      </button>
                      <textarea
                        className="composer-pill-input"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={onComposerKeyDown}
                        placeholder="Nhập phản hồi…"
                        rows={1}
                      />
                      <button
                        type="button"
                        className="composer-pill-send"
                        disabled={(!draft.trim() && !pendingImage) || facebookSendBusy}
                        aria-label="Gửi"
                        title="Gửi"
                        onClick={sendStaffMessage}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M12 19V5M12 5l-6 6M12 5l6 6"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </footer>
                </section>
              )}
            </section>

            {pageSettingsPageId ? (
              <div
                className="page-settings-overlay"
                role="presentation"
                onClick={() => setPageSettingsPageId(null)}
              >
                <div
                  className="page-settings-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="page-settings-title"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h2 id="page-settings-title">
                    Cài đặt · {pages.find((p) => p.id === pageSettingsPageId)?.name ?? 'Fanpage'}
                  </h2>
                  <label className="page-settings-label" htmlFor="page-modal-branch">
                    Ngữ cảnh chi nhánh (mặc định cho fanpage)
                  </label>
                  <select
                    id="page-modal-branch"
                    className="chat-branch-select"
                    value={pageModalBranch}
                    onChange={(e) => setPageModalBranch(e.target.value)}
                  >
                    <option value="">Tự động (theo tên fanpage)</option>
                    {BRANCH_PAGES.map((b) => (
                      <option key={b.id} value={String(b.id)}>
                        {b.name} - {b.address}
                      </option>
                    ))}
                  </select>
                  <label className="page-settings-toggle-row">
                    <span>
                      <strong>AI tự trả lời toàn fanpage</strong>
                      <small>
                        Khi tắt: không hội thoại nào nhận AI tự động. Bật lại để chạy theo từng hội thoại (nút AI
                        trong chat).
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={pageModalMasterAi}
                      onChange={(e) => setPageModalMasterAi(e.target.checked)}
                    />
                  </label>
                  <p className="page-settings-cost">
                    Tổng chi phí AI (ước tính) trên fanpage:{' '}
                    <strong>{formatInboxAiCostVnd(pageSettingsTotalUsd)}</strong>
                  </p>
                  <div className="page-settings-actions">
                    <button type="button" className="ghost-button" onClick={() => setPageSettingsPageId(null)}>
                      Đóng
                    </button>
                    <button type="button" className="primary-button" onClick={savePageSettingsModal}>
                      Lưu
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>
        <section
          className="workspace-section workspace-section-training"
          aria-hidden={activeTab !== 'training'}
          style={{ display: activeTab === 'training' ? undefined : 'none' }}
        >
          <TrainingChat title="Training & cập nhật kiến thức" />
        </section>
      </main>

    </div>
  )
}

export default App
