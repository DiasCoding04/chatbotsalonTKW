import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { flushSync } from 'react-dom'
import './App.css'
import {
  type ChatImage,
  type ChatTurn,
  type UsageInfo,
  type StreamTiming,
  DEFAULT_MODEL,
  countTextTokens,
  streamGeminiReply,
} from './lib/gemini'
import { DEFAULT_OPENAI_MODEL, streamOpenaiReply } from './lib/openai'
import {
  MAX_CHAT_IMAGES,
  readImageAttachment,
} from './lib/image-attachments'
import {
  buildContextCacheFingerprint,
  isSharedContextCacheValid,
  readSharedContextCacheRecord,
  resolveSharedContextCache,
  SHARED_CONTEXT_CACHE_STORAGE_KEY,
} from './lib/shared-context-cache'
import { estimateUsd, getTariff } from './lib/gemini-pricing'
import {
  StreamingBubble,
  type StreamingBubbleHandle,
} from './components/StreamingBubble'
import { ContextEditor } from './components/ContextEditor'
import { ModelMessageBubbles } from './components/ModelMessageBubbles'
import { fetchServerContext } from './lib/context-api'

type Msg = ChatTurn & { usage?: UsageInfo; clientId?: string; replyToClientId?: string }

const CUSTOMER_QUIET_MS = 15_000
const RETRY_BASE_MS = 1_500
const RETRY_MAX_MS = 15_000

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function buildChatHistoryForApi(msgs: Msg[]): ChatTurn[] {
  return msgs
    .filter((m) => m.role === 'user' || (m.role === 'model' && m.text.trim().length > 0))
    .map(({ role, text, images }) => ({ role, text, images }))
}

function hasPendingCustomerMessages(msgs: Msg[]): boolean {
  const history = buildChatHistoryForApi(msgs)
  return history.length > 0 && history[history.length - 1]?.role === 'user'
}

type Stats = {
  totalPrompt: number
  totalCached: number
  totalOutput: number
  totalChatInput: number
  calls: number
}

const EMPTY_STATS: Stats = {
  totalPrompt: 0,
  totalCached: 0,
  totalOutput: 0,
  totalChatInput: 0,
  calls: 0,
}

const SALON_SYSTEM =
  'Bạn là trợ lý ảo của một salon tóc. Trả lời ngắn gọn, lịch sự, tiếng Việt. ' +
  'Giúp khách đặt lịch, tư vấn dịch vụ và giá theo ngữ cảnh được cung cấp bên dưới.'

type BranchPage = {
  id: number
  name: string
  address: string
  hotline: string
}

const BRANCH_PAGES: BranchPage[] = [
  { id: 1, name: 'CN 1 - Quận 1', address: '55 Phạm Viết Chánh, Cầu Ông Lãnh, Quận 1', hotline: '0935311111' },
  { id: 2, name: 'CN 2 - Bình Tân', address: '202-204 Vành Đai Trong, Bình Trị Đông B, Bình Tân', hotline: '0935311111' },
  { id: 3, name: 'CN 3 - Hóc Môn', address: '2/98A Lê Thị Hà, Hóc Môn', hotline: '0935311111' },
  { id: 4, name: 'CN 4 - Quận 12', address: '1078 Nguyễn Ảnh Thủ, Quận 12', hotline: '0935311111' },
  { id: 5, name: 'CN 5 - Gò Vấp', address: '397 Quang Trung, Phường 10, Gò Vấp', hotline: '0935311111' },
  { id: 6, name: 'CN 6 - Thủ Đức', address: '734A Kha Vạn Cân, Linh Đông, Thủ Đức', hotline: '0935311111' },
  { id: 7, name: 'CN 7 - Tân Phú', address: '109 Tân Sơn Nhì, Tân Sơn Nhì, Tân Phú', hotline: '0935311111' },
  { id: 8, name: 'CN 8 - Quận 9', address: '427 Man Thiện, Phường Tăng Nhơn Phú, Quận 9', hotline: '0935311111' },
  { id: 9, name: 'CN 9 - Thủ Dầu Một', address: '238 Đại Lộ Bình Dương, Thủ Dầu Một', hotline: '0935311111' },
  { id: 10, name: 'CN 10 - Bến Cát', address: 'KDC Golden Centercity, Bến Cát', hotline: '0935311111' },
  { id: 11, name: 'CN 11 - Thuận An', address: 'Ô94, DC30, Đường D1, KDC Vietsing, Thuận An', hotline: '0935311111' },
  { id: 12, name: 'CN 12 - Tây Ninh', address: '24 Lãnh Binh Tòng, Trảng Bàng, Tây Ninh', hotline: '0935311111' },
  { id: 13, name: 'CN 13 - Biên Hòa', address: '1118 Nguyễn Ái Quốc, Tân Phong, Biên Hòa', hotline: '0935311111' },
  { id: 14, name: 'CN 14 - Phú Quốc', address: '120 Đường 30/4, TT Dương Đông, Phú Quốc', hotline: '0935311111' },
  { id: 15, name: 'CN 15 - Đà Lạt', address: '33 Phan Bội Châu, Phường 1, TP Đà Lạt', hotline: '0935311111' },
  { id: 16, name: 'CN 16 - Bình Phước', address: '483 Quốc Lộ 14, TX Đồng Xoài, Bình Phước', hotline: '0935311111' },
  { id: 17, name: 'CN 17 - Tây Ninh', address: '953 Cách Mạng Tháng 8, TP Tây Ninh', hotline: '0935311111' },
  { id: 18, name: 'CN 18 - Vũng Tàu', address: '496 Trương Công Định, Phường Vũng Tàu, TP.HCM', hotline: '0935311111' },
  { id: 19, name: 'CN 19 - Nha Trang', address: '150 Nguyễn Thị Minh Khai, Phường Nha Trang, Khánh Hòa', hotline: '0935311111' },
  { id: 20, name: 'CN 20 - An Giang', address: '125 Trần Quang Khải, Phường Rạch Giá, An Giang', hotline: '0935311111' },
]

function buildFanpagePrompt(branch: BranchPage): string {
  return [
    '--- Fanpage/chi nhánh đang nhắn ---',
    `Khách đang nhắn fanpage ${branch.name}.`,
    `Địa chỉ mặc định của fanpage này: ${branch.address}.`,
    `Hotline/Zalo của fanpage này: ${branch.hotline}. Khi khách cần hotline/Zalo, ưu tiên gửi số này.`,
    'Chỉ gửi địa chỉ chi nhánh mặc định khi khách hỏi địa chỉ/chi nhánh, hỏi salon ở đâu, cần đến salon kiểm tra, hoặc đã rõ dịch vụ + thời gian và cần xác nhận nơi ghé.',
    'Khách chỉ nói "ghé", "chiều ghé", "tối ghé" là tín hiệu đặt lịch, không phải tín hiệu hỏi địa chỉ; khi chưa rõ dịch vụ/kiểu thì chỉ hỏi dịch vụ/kiểu còn thiếu, không tự đưa địa chỉ.',
    'Khi gửi địa chỉ mặc định, phải hỏi khách có tiện qua địa chỉ đó không.',
    'Nếu khách nói xa quá: nêu lý do xứng đáng để khách cân nhắc bỏ thời gian ghé (kỹ thuật xử lý, tư vấn trực tiếp, sản phẩm tốt, bảo hành/ưu đãi phù hợp).',
    'Nếu khách vẫn không tiện: hỏi khu vực/địa chỉ của khách và tư vấn chi nhánh gần nhất theo danh sách chi nhánh trong CONTEXT.md.',
  ].join('\n')
}

function buildSystemPrompt(contextMd: string, branch: BranchPage): string {
  const trimmed = contextMd.trim()
  const fanpagePrompt = buildFanpagePrompt(branch)
  if (!trimmed) return `${SALON_SYSTEM}\n\n${fanpagePrompt}`
  return `${SALON_SYSTEM}\n\n${fanpagePrompt}\n\n--- Ngữ cảnh salon (CONTEXT.md) ---\n\n${trimmed}`
}

const GEMINI_CONTEXT_CACHE_TTL_S = 3600

/** Chờ Context Cache Gemini sẵn sàng (tránh lượt đầu gửi inline full CONTEXT). */
function waitForContextCache(
  getName: () => string | null | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      const name = getName()
      if (name) {
        resolve(name)
        return
      }
      if (Date.now() >= deadline) {
        resolve(undefined)
        return
      }
      window.setTimeout(tick, 80)
    }
    tick()
  })
}

/** Ước token khi không gọi API đếm (OpenAI). */
function estimateTokensRough(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** Hiển thị: mỗi dòng non-empty = 1 bong bóng. Giữ nguyên 1 tin trong state để API chuẩn. */
function MessageImages({ images }: { images: ChatImage[] }) {
  if (!images.length) return null
  return (
    <div className="msg-images">
      {images.map((image, idx) => (
        <img key={`${image.mimeType}-${idx}`} src={image.dataUrl} alt={`Ảnh ${idx + 1}`} />
      ))}
    </div>
  )
}

type CtxTokenMetrics = { file: number; systemFull: number }

function chatHistoryTokens(promptTotal: number, systemFull: number | null): number | null {
  if (systemFull == null) return null
  return Math.max(0, promptTotal - systemFull)
}

function UsageLine({
  u,
  metrics,
  contextMetricsApprox,
}: {
  u: UsageInfo
  metrics: CtxTokenMetrics | null
  contextMetricsApprox?: boolean
}) {
  const chatT = chatHistoryTokens(u.promptTokens, metrics?.systemFull ?? null)
  return (
    <span className="usage">
      {' '}
      · in {u.promptTokens}
      {metrics != null && chatT != null && (
        <>
          {' '}
          (
          <span
            title={
              contextMetricsApprox
                ? 'Ước token CONTEXT.md (chars/4) — không gọi API đếm'
                : 'Chỉ nội dung public/CONTEXT.md (đếm countTokens riêng)'
            }
          >
            CONTEXT.md {metrics.file}
          </span>
          {' · '}
          <span title="Tổng input API trừ cả khối systemInstruction (tiền tố salon + CONTEXT.md). = tin nhắn hội thoại">
            hội thoại {chatT}
          </span>
          )
        </>
      )}
      {u.cachedTokens > 0 && <> (cached {u.cachedTokens})</>}
      {' '}
      / out {u.outputTokens}
    </span>
  )
}

type ContextBanner = { level: 'ok' | 'warn' | 'error'; message: string } | null
type CacheStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; name: string }
  | { kind: 'error'; message: string }

type LastPerf = {
  timing: StreamTiming
  /** performance.now() từ đầu send() → sau await stream (gồm React nhẹ). */
  msClientRoundTrip: number
}

function fmtMs(ms: number) {
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

type AppProps = {
  forcedProvider?: 'gemini' | 'openai'
  forcedModel?: string
  title?: string
}

export default function App({ forcedProvider, forcedModel, title }: AppProps = {}) {
  const aiProvider = (forcedProvider ?? import.meta.env.VITE_AI_PROVIDER ?? 'gemini')
    .toLowerCase()
    .trim()
  const isGemini = aiProvider === 'gemini'

  const apiKey = isGemini
    ? (import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()
    : (import.meta.env.VITE_OPENAI_API_KEY ?? '').trim()
  const geminiProxyInjectsKey =
    isGemini && import.meta.env.VITE_GEMINI_PROXY_INJECTS_KEY === 'true'
  const geminiReady = Boolean(apiKey.trim() || geminiProxyInjectsKey)
  const model = (
    forcedModel?.trim() ||
    (isGemini
      ? (import.meta.env.VITE_GEMINI_MODEL as string | undefined)?.trim() || DEFAULT_MODEL
      : (import.meta.env.VITE_OPENAI_MODEL as string | undefined)?.trim() || DEFAULT_OPENAI_MODEL)
  )
  /**
   * Salon: câu ngắn — max nhỏ → model dừng sớm, stream kết thúc nhanh hơn.
   * Có thể tăng qua VITE_MAX_OUTPUT_TOKENS (vd 512 / 768).
   */
  const maxOutputTokens = Number(import.meta.env.VITE_MAX_OUTPUT_TOKENS) || 256

  const [contextMd, setContextMd] = useState('')
  const [contextBanner, setContextBanner] = useState<ContextBanner>(null)
  const [contextFromServer, setContextFromServer] = useState(false)
  const [contextRequiresEditToken, setContextRequiresEditToken] = useState(false)
  const [contextEditorOpen, setContextEditorOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [awaitingCustomer, setAwaitingCustomer] = useState(false)
  const [streamingUserClientId, setStreamingUserClientId] = useState<string | null>(null)
  const [ctxMetrics, setCtxMetrics] = useState<CtxTokenMetrics | null>(null)
  const [lastPerf, setLastPerf] = useState<LastPerf | null>(null)
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>({ kind: 'idle' })
  const [waitModeEnabled, setWaitModeEnabled] = useState(true)
  const [selectedBranchId, setSelectedBranchId] = useState(1)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const streamingRef = useRef<StreamingBubbleHandle>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  /** Hủy countTokens nền khi user gửi chat — không hủy createCachedContent. */
  const metricsAbortRef = useRef<AbortController | null>(null)
  const bgMetricsTimerRef = useRef<number>(0)
  const cacheNameRef = useRef<string | null>(null)
  const processingRef = useRef(false)
  const messagesRef = useRef<Msg[]>([])
  const debounceTimerRef = useRef<number>(0)
  const debounceGenerationRef = useRef(0)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    return () => {
      window.clearTimeout(debounceTimerRef.current)
    }
  }, [])

  const commitMessages = useCallback((updater: (prev: Msg[]) => Msg[]) => {
    flushSync(() => {
      setMessages((prev) => {
        const next = updater(prev)
        messagesRef.current = next
        return next
      })
    })
  }, [])

  const loadContext = useCallback(async () => {
    setContextBanner(null)
    try {
      const serverDoc = await fetchServerContext()
      if (serverDoc) {
        setContextFromServer(true)
        setContextRequiresEditToken(serverDoc.requiresEditToken)
        setContextMd(serverDoc.content)
        return
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setContextBanner({
        level: 'warn',
        message: `${msg} Đang thử tải bản tĩnh public/CONTEXT.md.`,
      })
    }

    setContextFromServer(false)
    setContextRequiresEditToken(false)
    try {
      const res = await fetch('/CONTEXT.md', { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      setContextMd(await res.text())
    } catch {
      try {
        const { default: fallback } = await import('./context/CONTEXT.fallback.md?raw')
        setContextMd(fallback)
        setContextBanner({
          level: 'warn',
          message:
            'Không tải được CONTEXT từ server hoặc public/CONTEXT.md — đang dùng bản nhúng trong mã nguồn.',
        })
      } catch {
        setContextMd('')
        setContextBanner({
          level: 'error',
          message:
            'Không đọc được ngữ cảnh. Kiểm tra server /api/context, public/CONTEXT.md và CONTEXT.fallback.md.',
        })
      }
    }
  }, [])

  useEffect(() => {
    void loadContext()
  }, [loadContext])

  const selectedBranch = useMemo(
    () => BRANCH_PAGES.find((branch) => branch.id === selectedBranchId) ?? BRANCH_PAGES[0],
    [selectedBranchId],
  )
  const systemPrompt = useMemo(
    () => buildSystemPrompt(contextMd, selectedBranch),
    [contextMd, selectedBranch],
  )
  const contextCacheFingerprint = useMemo(
    () =>
      isGemini && systemPrompt.trim() ? buildContextCacheFingerprint(model, systemPrompt) : null,
    [isGemini, model, systemPrompt],
  )

  /** OpenAI: ước token CONTEXT cục bộ (không gọi API đếm). */
  useEffect(() => {
    if (isGemini) return
    if (!apiKey.trim() || !contextMd.trim()) {
      setCtxMetrics(null)
      return
    }
      const t = window.setTimeout(() => {
        const fileText = contextMd.trim()
        setCtxMetrics({
          file: estimateTokensRough(fileText),
          systemFull: estimateTokensRough(buildSystemPrompt(contextMd, selectedBranch)),
        })
      }, 200)
    return () => window.clearTimeout(t)
  }, [isGemini, geminiReady, contextMd, apiKey, selectedBranch])

  /** Gemini: cache toàn bộ systemPrompt (tiền tố salon + CONTEXT.md) qua Context Cache API. */
  useEffect(() => {
    if (!isGemini) {
      cacheNameRef.current = null
      setCacheStatus({ kind: 'idle' })
      return
    }
    if (!geminiReady || !systemPrompt.trim()) {
      cacheNameRef.current = null
      setCacheStatus({ kind: 'idle' })
      return
    }

    let cancelled = false
    cacheNameRef.current = null
    setCacheStatus({ kind: 'loading' })

    void (async () => {
      try {
        const { name } = await resolveSharedContextCache(
          apiKey,
          model,
          systemPrompt,
          GEMINI_CONTEXT_CACHE_TTL_S,
        )
        if (cancelled) return
        cacheNameRef.current = name
        setCacheStatus({ kind: 'ready', name })
      } catch (e) {
        if (cancelled) return
        cacheNameRef.current = null
        const msg = e instanceof Error ? e.message : String(e)
        setCacheStatus({ kind: 'error', message: msg })
      }
    })()

    return () => {
      cancelled = true
      cacheNameRef.current = null
    }
  }, [isGemini, apiKey, geminiReady, model, systemPrompt])

  useEffect(() => {
    if (!isGemini || !contextCacheFingerprint) return
    const syncFromStorage = () => {
      const record = readSharedContextCacheRecord()
      if (!record || !isSharedContextCacheValid(record, contextCacheFingerprint)) return
      cacheNameRef.current = record.name
      setCacheStatus({ kind: 'ready', name: record.name })
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SHARED_CONTEXT_CACHE_STORAGE_KEY) return
      syncFromStorage()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [isGemini, contextCacheFingerprint])

  /** Gemini: đếm token CONTEXT (UI chi phí) — chạy nền, có thể hủy khi user gửi chat. */
  useEffect(() => {
    if (!isGemini) return
    if (!geminiReady || !contextMd.trim()) {
      setCtxMetrics(null)
      return
    }

    metricsAbortRef.current?.abort()
    const ac = new AbortController()
    metricsAbortRef.current = ac

    const fileText = contextMd.trim()
    const fullSystem = buildSystemPrompt(contextMd, selectedBranch)
    const METRICS_DELAY_MS = 3000

    window.clearTimeout(bgMetricsTimerRef.current)
    bgMetricsTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const [fp, sp] = await Promise.all([
            countTextTokens(apiKey, model, fileText, ac.signal),
            countTextTokens(apiKey, model, fullSystem, ac.signal),
          ])
          if (!ac.signal.aborted) setCtxMetrics({ file: fp, systemFull: sp })
        } catch (e) {
          if (ac.signal.aborted || (e instanceof Error && e.name === 'AbortError')) return
          setCtxMetrics(null)
        }
      })()
    }, METRICS_DELAY_MS)

    return () => {
      window.clearTimeout(bgMetricsTimerRef.current)
      ac.abort()
    }
  }, [isGemini, apiKey, geminiReady, contextMd, model, systemPrompt, selectedBranch])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function onPickImages(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length) return
    setAttachError(null)
    const room = MAX_CHAT_IMAGES - pendingImages.length
    if (room <= 0) {
      setAttachError(`Tối đa ${MAX_CHAT_IMAGES} ảnh mỗi tin.`)
      return
    }
    const picked = files.slice(0, room)
    try {
      const next = await Promise.all(picked.map((file) => readImageAttachment(file)))
      setPendingImages((prev) => [...prev, ...next])
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err))
    }
  }

  function removePendingImage(index: number) {
    setPendingImages((prev) => prev.filter((_, i) => i !== index))
    setAttachError(null)
  }

  async function resolveCachedContentForSend(): Promise<string | undefined> {
    if (!isGemini) return undefined

    let cachedContent = cacheNameRef.current ?? undefined
    if (!cachedContent) {
      cachedContent = await waitForContextCache(() => cacheNameRef.current, 20_000)
    }
    if (!cachedContent && systemPrompt.trim()) {
      try {
        const { name } = await resolveSharedContextCache(
          apiKey,
          model,
          systemPrompt,
          GEMINI_CONTEXT_CACHE_TTL_S,
        )
        cacheNameRef.current = name
        cachedContent = name
        setCacheStatus({ kind: 'ready', name })
      } catch {
        /* stream inline systemInstruction */
      }
    }
    return cachedContent
  }

  function scheduleBatchedReply() {
    window.clearTimeout(debounceTimerRef.current)
    const generation = ++debounceGenerationRef.current
    setAwaitingCustomer(true)

    debounceTimerRef.current = window.setTimeout(() => {
      if (generation !== debounceGenerationRef.current) return
      void runBatchedReply()
    }, CUSTOMER_QUIET_MS)
  }

  function triggerReplyNow() {
    window.clearTimeout(debounceTimerRef.current)
    debounceGenerationRef.current += 1
    setAwaitingCustomer(false)
    void runBatchedReply()
  }

  function appendModelPlaceholder(streamId: string) {
    setStreamingUserClientId(streamId)
    commitMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'model' && !last.text.trim()) return prev
      return [...prev, { role: 'model', text: '', replyToClientId: streamId }]
    })
  }

  function finalizeBatchedReply(text: string, usage?: UsageInfo) {
    commitMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const msg = prev[i]
        if (msg.role === 'model' && !msg.text.trim()) {
          const copy = [...prev]
          copy[i] = {
            role: 'model',
            text,
            usage,
            replyToClientId: msg.replyToClientId,
          }
          return copy
        }
      }
      return [...prev, { role: 'model', text, usage }]
    })
  }

  async function runBatchedReply() {
    setAwaitingCustomer(false)
    if (processingRef.current) return
    if (!hasPendingCustomerMessages(messagesRef.current)) return

    processingRef.current = true
    setLoading(true)

    const historyForApi = buildChatHistoryForApi(messagesRef.current)
    const streamId = newClientId()
    appendModelPlaceholder(streamId)
    streamingRef.current?.reset()

    const sysTok = ctxMetrics?.systemFull

    try {
      let retryCount = 0
      for (;;) {
        try {
          streamingRef.current?.reset()
          const cachedContent = await resolveCachedContentForSend()
          const tSend = performance.now()
          const result = isGemini
            ? await streamGeminiReply(
                apiKey,
                model,
                systemPrompt,
                historyForApi,
                (delta) => {
                  streamingRef.current?.append(delta)
                },
                { maxOutputTokens, cachedContent },
              )
            : await streamOpenaiReply(
                apiKey,
                model,
                systemPrompt,
                historyForApi,
                (delta) => {
                  streamingRef.current?.append(delta)
                },
                { maxOutputTokens },
              )

          const tAfter = performance.now()
          setLastPerf({
            timing: result.timing,
            msClientRoundTrip: tAfter - tSend,
          })

          const finalText =
            result.text.trim() || streamingRef.current?.getText().trim() || result.text
          finalizeBatchedReply(finalText, result.usage)

          if (result.usage) {
            const u = result.usage
            const chatIn = sysTok != null ? Math.max(0, u.promptTokens - sysTok) : 0
            setStats((s) => ({
              totalPrompt: s.totalPrompt + u.promptTokens,
              totalCached: s.totalCached + u.cachedTokens,
              totalOutput: s.totalOutput + u.outputTokens,
              totalChatInput: s.totalChatInput + (sysTok != null ? chatIn : 0),
              calls: s.calls + 1,
            }))
          }
          break
        } catch {
          retryCount += 1
          const delayMs = Math.min(RETRY_BASE_MS * 2 ** (retryCount - 1), RETRY_MAX_MS)
          await sleep(delayMs)
        }
      }
    } finally {
      processingRef.current = false
      setLoading(false)
      setStreamingUserClientId(null)
      if (hasPendingCustomerMessages(messagesRef.current)) {
        if (waitModeEnabled) scheduleBatchedReply()
        else triggerReplyNow()
      }
    }
  }

  function send() {
    const text = input.trim()
    const images = pendingImages
    if ((!text && !images.length) || (isGemini ? !geminiReady : !apiKey)) return

    if (isGemini) {
      window.clearTimeout(bgMetricsTimerRef.current)
      metricsAbortRef.current?.abort()
    }

    const clientId = newClientId()
    const userTurn: Msg = {
      role: 'user',
      text,
      images: images.length ? images : undefined,
      clientId,
    }

    commitMessages((prev) => [...prev, userTurn])
    setInput('')
    setPendingImages([])
    setAttachError(null)
    if (waitModeEnabled) scheduleBatchedReply()
    else triggerReplyNow()
  }

  function clearChat() {
    window.clearTimeout(debounceTimerRef.current)
    debounceGenerationRef.current += 1
    processingRef.current = false
    setAwaitingCustomer(false)
    setStreamingUserClientId(null)
    messagesRef.current = []
    setMessages([])
    setStats(EMPTY_STATS)
    setLastPerf(null)
    setPendingImages([])
    setAttachError(null)
    setLoading(false)
  }

  const missingKey = isGemini ? !geminiReady : !apiKey.trim()
  const canSend = Boolean(input.trim() || pendingImages.length)
  const usdVndRate = Number(import.meta.env.VITE_USD_VND) || 26_000

  const sessionCost = useMemo(() => {
    if (stats.calls === 0) return null
    const tariff = getTariff(model)
    const sys = ctxMetrics
    if (!tariff) return { ok: false as const, reason: 'no-tariff' as const, model }
    if (stats.totalPrompt <= 0)
      return { ok: false as const, reason: 'no-metrics' as const, model }

    const bill = estimateUsd(tariff, stats.totalPrompt, stats.totalCached, stats.totalOutput)
    const p = stats.totalPrompt
    const fileTokLuyKe = sys ? sys.file * stats.calls : 0
    const usdMessages = sys ? (stats.totalChatInput / p) * bill.inputUsd : 0
    const usdContextFile = sys ? (fileTokLuyKe / p) * bill.inputUsd : 0
    const usdPrefix = Math.max(0, bill.inputUsd - usdMessages - usdContextFile)

    return {
      ok: true as const,
      model,
      tariffLabel: tariff.label,
      hasContextBreakdown: Boolean(sys),
      usdMessages,
      usdContextFile,
      usdPrefix,
      usdOutput: bill.outputUsd,
      usdTotal: bill.totalUsd,
      inputUsd: bill.inputUsd,
    }
  }, [stats, model, ctxMetrics])

  const fmtVnd = (usd: number) => Math.round(usd * usdVndRate).toLocaleString('vi-VN')
  const fmtUsd = (usd: number) => usd.toFixed(6)

  /** Hiển thị chi phí: VND chính, USD nhỏ trong ngoặc (giá API tính USD). */
  function CostAmountCells({ usd, strong }: { usd: number; strong?: boolean }) {
    const inner = (
      <>
        <span className="cost-vnd-main">{fmtVnd(usd)} đ</span>
        <span className="cost-usd-sub"> ({fmtUsd(usd)} USD)</span>
      </>
    )
    return (
      <td className="cost-amount">
        {strong ? <strong>{inner}</strong> : inner}
      </td>
    )
  }

  function CacheChip() {
    if (!isGemini) return null
    if (cacheStatus.kind === 'idle') return null
    if (cacheStatus.kind === 'loading') {
      return (
        <span className="model-strip-meta" title="Đang tạo Context Cache cho systemInstruction">
          · cache: đang tạo…
        </span>
      )
    }
    if (cacheStatus.kind === 'ready') {
      return (
        <span
          className="model-strip-meta"
          title={`Đang dùng Context Cache dùng chung (server): ${cacheStatus.name}. Mỗi tin chỉ gửi message mới, không gửi lại CONTEXT.md.`}
        >
          · cache: bật ✓
        </span>
      )
    }
    return (
      <span
        className="model-strip-meta"
        title={`Cache fail (fallback gửi CONTEXT.md inline mỗi tin): ${cacheStatus.message}`}
      >
        · cache: tắt (fallback inline)
      </span>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1>{title?.trim() || 'Salon — chat AI'}</h1>
        <p>
          Provider: <code>{isGemini ? 'gemini' : 'openai'}</code> · model <code>{model}</code>. Ngữ cảnh từ{' '}
          <code>CONTEXT.md</code>.
        </p>
      </header>

      {missingKey && (
        <div className="banner error">
          {isGemini ? (
            geminiProxyInjectsKey ? (
              <>
                Server chưa cấu hình <code>GEMINI_API_KEY</code> (proxy Gemini). Kiểm tra file env trên máy chủ và
                khởi động lại dịch vụ.
              </>
            ) : (
              <>
                Thiếu <code>VITE_GEMINI_API_KEY</code>. Sao chép <code>.env.example</code> thành <code>.env</code> và
                dán API key từ Google AI Studio.
              </>
            )
          ) : (
            <>
              Thiếu <code>VITE_OPENAI_API_KEY</code>. Sao chép <code>.env.example</code> thành <code>.env</code> và dán
              API key từ OpenAI.
            </>
          )}
        </div>
      )}

      {contextBanner && (
        <div
          className={`banner ${
            contextBanner.level === 'error'
              ? 'error'
              : contextBanner.level === 'ok'
                ? 'ok'
                : 'warn'
          }`}
        >
          {contextBanner.message}
        </div>
      )}

      <div className="model-strip">
        Model: <code>{model}</code>
        <span className="model-strip-meta">
          · stream · max out {maxOutputTokens} tok
          {isGemini && /gemini-3|\/3\./i.test(model) ? ' · thinking off (3.x)' : ''}
        </span>
        <CacheChip />
      </div>

      <div className="toolbar">
        <label className="branch-picker">
          <span>Fanpage</span>
          <select
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(Number(e.target.value))}
          >
            {BRANCH_PAGES.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        {contextFromServer && (
          <button type="button" onClick={() => setContextEditorOpen(true)}>
            Sửa CONTEXT (server)
          </button>
        )}
        <button type="button" className="secondary" onClick={() => void loadContext()}>
          Tải lại CONTEXT
        </button>
        <button type="button" className="secondary" onClick={clearChat}>
          Xóa hội thoại
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            window.clearTimeout(debounceTimerRef.current)
            debounceGenerationRef.current += 1
            setAwaitingCustomer(false)
            setWaitModeEnabled((v) => !v)
          }}
        >
          Chờ 15s: {waitModeEnabled ? 'Bật' : 'Tắt'}
        </button>
        <span className="context-hint">
          {contextFromServer
            ? 'Ngữ cảnh lưu trên server (data/CONTEXT.md). Lưu xong cache Gemini được làm mới.'
            : 'Chạy server API hoặc sửa public/CONTEXT.md rồi bấm tải lại.'}
        </span>
      </div>

      <ContextEditor
        open={contextEditorOpen}
        initialContent={contextMd}
        requiresEditToken={contextRequiresEditToken}
        onClose={() => setContextEditorOpen(false)}
        onSaved={(doc) => {
          setContextMd(doc.content)
          setContextRequiresEditToken(doc.requiresEditToken)
          setContextBanner({
            level: 'ok',
            message: `Đã lưu CONTEXT trên server (${new Date(doc.updatedAt).toLocaleString('vi-VN')}).`,
          })
        }}
      />

      {lastPerf && (
        <div className="timing-strip">
          <div className="timing-strip-title">Đo thời gian (tin gửi cuối)</div>
          <div className="timing-breakdown">
            <span className="timing-chip timing-chip-total" title="Bấm Gửi → stream xong">
              <strong>Tổng</strong> {fmtMs(lastPerf.msClientRoundTrip)}
            </span>
            <span className="timing-chip" title="fetch → có HTTP response (mạng + TLS + Google nhận request)">
              HTTP {fmtMs(lastPerf.timing.msToResponseHeaders)}
            </span>
            <span
              className="timing-chip timing-chip-warn"
              title="Từ có response đến ký tự đầu — thường là bottleneck (model / xếp hàng)"
            >
              Chờ chữ đầu {fmtMs(lastPerf.timing.msAfterHeadersToFirstToken)}
            </span>
            <span className="timing-chip" title="Chữ đầu → hết stream (model sinh tiếp + chunk)">
              Stream {fmtMs(lastPerf.timing.msStreamGeneration)}
            </span>
            <span className="timing-chip timing-chip-muted" title="Chỉ phần fetch stream → đọc hết SSE">
              API {fmtMs(lastPerf.timing.msWallClockFetch)}
            </span>
          </div>
          <p className="timing-note timing-note-inline">
            Đo <code>performance.now()</code> trên trình duyệt. Nếu <strong>Chờ chữ đầu</strong> chiếm gần hết
            tổng → thường do nhà cung cấp API / mạng hoặc prompt lớn, không phải React.
          </p>
        </div>
      )}

      <div className="chat" aria-busy={loading}>
        {messages.length === 0 && (
          <p className="empty">
            {missingKey
              ? 'Thêm API key để bắt đầu.'
              : 'Nhập tin nhắn cho khách salon — chữ sẽ hiện dần (stream).'}
          </p>
        )}
        {messages.flatMap((m, i) => {
          const isErr = m.role === 'model' && m.text.startsWith('[Lỗi API]')
          const isStreamingBubble =
            loading &&
            m.role === 'model' &&
            !m.text.trim() &&
            !isErr &&
            m.replyToClientId === streamingUserClientId

          if (m.role === 'model' && !m.text.trim() && !isStreamingBubble && !isErr) {
            return []
          }

          if (m.role === 'user' || isErr) {
            return [
              <div
                key={`${m.role}-${i}`}
                className={`msg ${m.role} ${isErr ? 'err' : ''}`}
              >
                <div className="role">
                  {m.role === 'user' ? 'Khách / Bạn' : 'AI'}
                  {m.usage && (
                    <UsageLine
                      u={m.usage}
                      metrics={ctxMetrics}
                      contextMetricsApprox={!isGemini}
                    />
                  )}
                </div>
                {m.images?.length ? <MessageImages images={m.images} /> : null}
                {m.text}
              </div>,
            ]
          }

          if (isStreamingBubble) {
            // Render component cô lập — App KHÔNG re-render mỗi delta.
            return [
              <StreamingBubble
                key={`model-stream-${m.replyToClientId ?? i}`}
                ref={streamingRef}
              />,
            ]
          }

          return [
            <ModelMessageBubbles
              key={`model-${i}`}
              messageKey={`model-${i}`}
              text={m.text}
              usageLine={
                m.usage ? (
                  <UsageLine
                    u={m.usage}
                    metrics={ctxMetrics}
                    contextMetricsApprox={!isGemini}
                  />
                ) : null
              }
            />,
          ]
        })}
        <div ref={chatEndRef} />
      </div>

      <div className="composer">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => void onPickImages(e)}
        />
        <button
          type="button"
          className="secondary attach"
          disabled={missingKey || pendingImages.length >= MAX_CHAT_IMAGES}
          onClick={() => imageInputRef.current?.click()}
        >
          Ảnh
        </button>
        <textarea
          rows={2}
          placeholder="Nhập tin nhắn hoặc đính kèm ảnh (tóc, màu, kiểu mẫu)..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          disabled={missingKey}
        />
        <button
          type="button"
          className="send"
          disabled={missingKey || !canSend}
          onClick={() => send()}
        >
          {loading ? 'Đang trả lời…' : awaitingCustomer ? 'Chờ 15s…' : 'Gửi'}
        </button>
      </div>
      {waitModeEnabled && awaitingCustomer && !loading && (
        <p className="context-hint">Khách im 15 giây thì AI đọc toàn bộ tin và trả lời một lần.</p>
      )}
      {attachError && <p className="attach-error">{attachError}</p>}
      {pendingImages.length > 0 && (
        <div className="pending-images">
          {pendingImages.map((image, idx) => (
            <div key={`pending-${idx}`} className="pending-image">
              <img src={image.dataUrl} alt={`Ảnh đính kèm ${idx + 1}`} />
              <button
                type="button"
                className="secondary pending-image-remove"
                onClick={() => removePendingImage(idx)}
                aria-label={`Xóa ảnh ${idx + 1}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {stats.calls > 0 && (
        <details className="cost-details">
          <summary className="cost-summary">
            Chi phí (ước tính){' '}
            {sessionCost?.ok && (
              <span className="cost-summary-total">
                · tổng ~{fmtVnd(sessionCost.usdTotal)} đ
                <span className="cost-usd-sub"> (~{fmtUsd(sessionCost.usdTotal)} USD)</span>
              </span>
            )}
          </summary>
          <div className="cost-panel">
            {sessionCost?.ok ? (
              <>
                <p className="cost-model">
                  {sessionCost.tariffLabel} · <code>{sessionCost.model}</code>
                </p>
                <table className="cost-simple">
                  <tbody>
                    {sessionCost.hasContextBreakdown ? (
                      <>
                        <tr>
                          <td>
                            1) Input <strong>tin nhắn</strong> (hội thoại, không gồm nội dung{' '}
                            <code>CONTEXT.md</code>)
                          </td>
                          <CostAmountCells usd={sessionCost.usdMessages} />
                        </tr>
                        <tr>
                          <td>
                            2) Input <strong>tổng CONTEXT.md</strong> (ước{' '}
                            <code>
                              {((ctxMetrics?.file ?? 0) * stats.calls).toLocaleString('vi-VN')}
                            </code>{' '}
                            tok file × {stats.calls} lần gọi)
                          </td>
                          <CostAmountCells usd={sessionCost.usdContextFile} />
                        </tr>
                      </>
                    ) : (
                      <tr>
                        <td>
                          1) Input <strong>tổng</strong> (Google usage, chưa tách hội thoại /{' '}
                          <code>CONTEXT.md</code>)
                        </td>
                        <CostAmountCells usd={sessionCost.inputUsd} />
                      </tr>
                    )}
                    <tr>
                      <td>{sessionCost.hasContextBreakdown ? '3' : '2'}) Output (trả lời model)</td>
                      <CostAmountCells usd={sessionCost.usdOutput} />
                    </tr>
                    <tr className="cost-total">
                      <td>
                        <strong>{sessionCost.hasContextBreakdown ? '4' : '3'}) Tổng cuộc hội thoại (API)</strong>
                      </td>
                      <CostAmountCells usd={sessionCost.usdTotal} strong />
                    </tr>
                  </tbody>
                </table>
                <p className="cost-how">
                  <strong>Cách tính:</strong>{' '}
                  {isGemini ? (
                    <>
                      Google trả <code>promptTokenCount</code> + <code>cachedContentTokenCount</code> + output. Tiền{' '}
                      <strong>input</strong> = (token chưa cache × giá input) + (token cache × giá đọc cache) theo{' '}
                      <code>src/lib/gemini-pricing.ts</code> (
                      <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">
                        bảng giá Gemini
                      </a>
                      ). (1)(2) chia theo <code>countTokens</code> cho CONTEXT vs hội thoại; chưa gồm tiền tố salon (~
                      {fmtVnd(sessionCost.usdPrefix)} đ).
                    </>
                  ) : (
                    <>
                      OpenAI trả <code>usage</code> (prompt / completion). Ước chi phí theo{' '}
                      <code>src/lib/gemini-pricing.ts</code> (
                      <a href="https://openai.com/api/pricing" target="_blank" rel="noreferrer">
                        bảng giá OpenAI
                      </a>
                      ). (1)(2) <em>chia ước</em> CONTEXT / hội thoại (CONTEXT ước chars/4).
                    </>
                  )}{' '}
                  (4) = input + output. <code>VITE_USD_VND</code> = {usdVndRate.toLocaleString('vi-VN')} đ/USD.
                </p>
              </>
            ) : sessionCost?.reason === 'no-tariff' ? (
              <p className="cost-how">
                Chưa có giá cho <code>{model}</code> — thêm vào{' '}
                <code>src/lib/gemini-pricing.ts</code>.
              </p>
            ) : (
              <p className="cost-how">
                Chưa đếm xong token CONTEXT — mở lại sau hoặc bấm Tải lại CONTEXT.md (không ảnh hưởng
                chat).
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  )
}
