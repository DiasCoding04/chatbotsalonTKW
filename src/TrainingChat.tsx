import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { flushSync } from 'react-dom'
import './TrainingChat.css'
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
  clearBrowserSharedContextCache,
  SHARED_CONTEXT_CACHE_STORAGE_KEY,
} from './lib/shared-context-cache'
import { estimateUsd, getTariff } from './lib/gemini-pricing'
import {
  StreamingBubble,
  type StreamingBubbleHandle,
} from './components/StreamingBubble'
import { ContextEditor } from './components/ContextEditor'
import { ModelMessageBubbles } from './components/ModelMessageBubbles'
import { fetchServerContext, fetchServerHealth, fetchServerImageSamples } from './lib/context-api'
import {
  BRANCH_PAGES,
  buildSalonSystemPrompt,
  buildSalonSystemPromptStatic,
  DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY,
  prependRealtimeContextTurns,
  expandModelImageSampleMarkers,
  mergeContextWithImageSampleCatalog,
  parseImageSampleGroups,
  resolveApprovedImageSampleKeys,
} from '../shared/salon-ai-context.ts'

const buildSystemPrompt = buildSalonSystemPrompt

type Msg = ChatTurn & {
  usage?: UsageInfo
  clientId?: string
  replyToClientId?: string
  /** Text hiển thị cho UI. Text gốc vẫn giữ nhẹ để gửi lại API ở lượt sau. */
  displayText?: string
}

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
      {images.map((image, idx) =>
        image.mimeType.startsWith('video/') ? (
          <video key={`${image.mimeType}-${idx}`} src={image.dataUrl} controls playsInline preload="metadata">
            Video {idx + 1}
          </video>
        ) : (
          <img key={`${image.mimeType}-${idx}`} src={image.dataUrl} alt={`Ảnh ${idx + 1}`} />
        ),
      )}
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

export function TrainingChat({ forcedProvider, forcedModel, title }: AppProps = {}) {
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
  const [imageSamplesMd, setImageSamplesMd] = useState('')
  const [imageSamplesBaseUrl, setImageSamplesBaseUrl] = useState('')
  const [contextBanner, setContextBanner] = useState<ContextBanner>(null)
  const [contextFromServer, setContextFromServer] = useState(false)
  const [contextRequiresEditToken, setContextRequiresEditToken] = useState(false)
  const [serverGeminiReady, setServerGeminiReady] = useState(false)
  const [serverGeminiBackend, setServerGeminiBackend] = useState<'vertex' | 'developer' | null>(null)
  const [serverHealthChecked, setServerHealthChecked] = useState(false)
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
  const [lastCachedTokens, setLastCachedTokens] = useState<number | null>(null)
  const [waitModeEnabled, setWaitModeEnabled] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState(1)

  const chatScrollRef = useRef<HTMLDivElement>(null)
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
    const loadImageSamples = async (): Promise<{ content: string; baseUrl: string }> => {
      try {
        const serverDoc = await fetchServerImageSamples()
        if (serverDoc) {
          return { content: serverDoc.content, baseUrl: serverDoc.baseUrl?.trim() ?? '' }
        }
      } catch {
        // Fall back to the static public file below.
      }

      try {
        const res = await fetch('/IMAGE_SAMPLES.md', { cache: 'no-store' })
        if (!res.ok) throw new Error(`${res.status}`)
        return { content: await res.text(), baseUrl: '' }
      } catch {
        try {
          const { default: fallback } = await import('./context/IMAGE_SAMPLES.fallback.md?raw')
          return { content: fallback, baseUrl: '' }
        } catch {
          return { content: '', baseUrl: '' }
        }
      }
    }

    try {
      const serverDoc = await fetchServerContext()
      if (serverDoc) {
        setContextFromServer(true)
        setContextRequiresEditToken(serverDoc.requiresEditToken)
        const imageSamples = await loadImageSamples()
        setImageSamplesMd(imageSamples.content)
        setImageSamplesBaseUrl(imageSamples.baseUrl)
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
      const imageSamples = await loadImageSamples()
      setImageSamplesMd(imageSamples.content)
      setImageSamplesBaseUrl(imageSamples.baseUrl)
      setContextMd(await res.text())
    } catch {
      try {
        const { default: fallback } = await import('./context/CONTEXT.fallback.md?raw')
        const imageSamples = await loadImageSamples()
        setImageSamplesMd(imageSamples.content)
        setImageSamplesBaseUrl(imageSamples.baseUrl)
        setContextMd(fallback)
        setContextBanner({
          level: 'warn',
          message:
            'Không tải được CONTEXT từ server hoặc public/CONTEXT.md — đang dùng bản nhúng trong mã nguồn.',
        })
      } catch {
        setImageSamplesMd('')
        setImageSamplesBaseUrl('')
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

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const health = await fetchServerHealth()
        if (cancelled || !health) return
        setServerGeminiReady(Boolean(health.geminiServerReady))
        setServerGeminiBackend(health.geminiBackend ?? null)
      } finally {
        if (!cancelled) setServerHealthChecked(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedBranch = useMemo(
    () => BRANCH_PAGES.find((branch) => branch.id === selectedBranchId) ?? BRANCH_PAGES[0],
    [selectedBranchId],
  )
  const imageSampleGroups = useMemo(
    () => parseImageSampleGroups(imageSamplesMd),
    [imageSamplesMd],
  )
  const promptContextMd = useMemo(
    () => mergeContextWithImageSampleCatalog(contextMd, imageSampleGroups),
    [contextMd, imageSampleGroups],
  )
  const systemPrompt = useMemo(
    () => buildSystemPrompt(promptContextMd, selectedBranch),
    [promptContextMd, selectedBranch],
  )
  /** Cache API: prompt tĩnh (không đổi theo phút) — tránh tạo hàng chục cache trên Vertex. */
  const cacheSystemPrompt = useMemo(
    () => buildSalonSystemPromptStatic(promptContextMd, selectedBranch),
    [promptContextMd, selectedBranch],
  )
  const contextCacheFingerprint = useMemo(
    () =>
      isGemini && cacheSystemPrompt.trim()
        ? buildContextCacheFingerprint(model, cacheSystemPrompt)
        : null,
    [isGemini, model, cacheSystemPrompt],
  )

  /** OpenAI: ước token CONTEXT cục bộ (không gọi API đếm). */
  useEffect(() => {
    if (isGemini) return
    if (!apiKey.trim() || !promptContextMd.trim()) {
      setCtxMetrics(null)
      return
    }
      const t = window.setTimeout(() => {
        const fileText = promptContextMd.trim()
        setCtxMetrics({
          file: estimateTokensRough(fileText),
          systemFull: estimateTokensRough(buildSystemPrompt(promptContextMd, selectedBranch)),
        })
      }, 200)
    return () => window.clearTimeout(t)
  }, [isGemini, geminiReady, promptContextMd, apiKey, selectedBranch])

  /** Đổi model / systemPrompt → reset chỉ báo cache hit của lượt trước. */
  useEffect(() => {
    setLastCachedTokens(null)
  }, [isGemini, model, cacheSystemPrompt])

  /** Gemini: cache toàn bộ systemPrompt (tiền tố salon + CONTEXT.md) qua Context Cache API. */
  useEffect(() => {
    if (!isGemini) {
      cacheNameRef.current = null
      setCacheStatus({ kind: 'idle' })
      return
    }
    if (!(geminiReady || serverGeminiReady) || !cacheSystemPrompt.trim()) {
      cacheNameRef.current = null
      setCacheStatus({ kind: 'idle' })
      return
    }

    let cancelled = false
    cacheNameRef.current = null
    setCacheStatus({ kind: 'loading' })

    void (async () => {
      try {
        const { name } = await resolveSharedContextCache(apiKey, model, cacheSystemPrompt)
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
  }, [isGemini, apiKey, geminiReady, serverGeminiReady, model, cacheSystemPrompt])

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
    if (!geminiReady || !promptContextMd.trim()) {
      setCtxMetrics(null)
      return
    }

    metricsAbortRef.current?.abort()
    const ac = new AbortController()
    metricsAbortRef.current = ac

    const fileText = promptContextMd.trim()
    const fullSystem = buildSystemPrompt(promptContextMd, selectedBranch)
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
  }, [isGemini, apiKey, geminiReady, promptContextMd, model, systemPrompt, selectedBranch])

  useLayoutEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, loading])

  async function onPickImages(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length) return
    setAttachError(null)
    const room = MAX_CHAT_IMAGES - pendingImages.length
    if (room <= 0) {
      setAttachError(`Tối đa ${MAX_CHAT_IMAGES} ảnh/video mỗi tin.`)
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
    if (cachedContent) return cachedContent

    if (!cacheSystemPrompt.trim()) return undefined

    let lastErr: unknown
    for (let i = 0; i < 6; i++) {
      try {
        const { name } = await resolveSharedContextCache(apiKey, model, cacheSystemPrompt)
        cacheNameRef.current = name
        setCacheStatus({ kind: 'ready', name })
        return name
      } catch (e) {
        lastErr = e
        await sleep(350 * (i + 1))
      }
    }
    setCacheStatus({
      kind: 'error',
      message: lastErr instanceof Error ? lastErr.message : String(lastErr),
    })
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
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

  function finalizeBatchedReply(text: string, usage?: UsageInfo, displayText?: string) {
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
            displayText,
          }
          return copy
        }
      }
      return [...prev, { role: 'model', text, usage, displayText }]
    })
  }

  async function runBatchedReply() {
    setAwaitingCustomer(false)
    if (processingRef.current) return
    if (!hasPendingCustomerMessages(messagesRef.current)) return

    processingRef.current = true
    setLoading(true)

    const historyForApi = prependRealtimeContextTurns(buildChatHistoryForApi(messagesRef.current))
    const streamId = newClientId()
    appendModelPlaceholder(streamId)
    streamingRef.current?.reset()

    const sysTok = ctxMetrics?.systemFull

    try {
      let retryCount = 0
      const maxRetries = 12
      for (; retryCount < maxRetries; retryCount++) {
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
          const recentCustomerText = historyForApi
            .filter((turn) => turn.role === 'user')
            .slice(-4)
            .map((turn) => turn.text)
            .join('\n')
          const approvedImageKeys = resolveApprovedImageSampleKeys(recentCustomerText, imageSampleGroups)
          const imageExpanded = expandModelImageSampleMarkers(
            finalText,
            imageSampleGroups,
            recentCustomerText,
            {
              imageBaseUrl: imageSamplesBaseUrl,
              inferImageKeysFromModelOnly: true,
              enforceCustomerApprovedKeys: approvedImageKeys,
              maxImagesPerGroup: DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY,
            },
          )
          finalizeBatchedReply(imageExpanded.apiText, result.usage, imageExpanded.displayText)

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
            if (isGemini) setLastCachedTokens(u.cachedTokens ?? 0)
          }
          break
        } catch (e) {
          if (retryCount >= maxRetries - 1) {
            throw e instanceof Error ? e : new Error(String(e))
          }
          const delayMs = Math.min(RETRY_BASE_MS * 2 ** retryCount, RETRY_MAX_MS)
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
    if ((!text && !images.length) || (isGemini ? !geminiRuntimeReady : !apiKey.trim())) return

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
    setLastCachedTokens(null)
    setPendingImages([])
    setAttachError(null)
    setLoading(false)
  }

  const geminiRuntimeReady = geminiReady || serverGeminiReady
  const missingKey = isGemini
    ? serverHealthChecked && !geminiRuntimeReady
    : !apiKey.trim()
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

    const hitSuffix =
      lastCachedTokens == null
        ? ''
        : lastCachedTokens > 0
          ? ` · hit ${lastCachedTokens} tok`
          : ' · miss (lượt trước)'

    if (cacheStatus.kind === 'idle') {
      return (
        <span
          className="model-strip-meta"
          title="Chưa khởi tạo cache (đang chờ runtime sẵn sàng hoặc chưa có system prompt)."
        >
          · cache: chưa khởi tạo{hitSuffix}
        </span>
      )
    }
    if (cacheStatus.kind === 'loading') {
      return (
        <span className="model-strip-meta" title="Đang tạo Context Cache cho systemInstruction">
          · cache: đang tạo…{hitSuffix}
        </span>
      )
    }
    if (cacheStatus.kind === 'ready') {
      return (
        <span
          className="model-strip-meta"
          title={`Explicit Context Cache active: ${cacheStatus.name}. Lượt vừa rồi cached ${lastCachedTokens ?? '?'} prompt tokens.`}
        >
          · cache: bật ✓{hitSuffix}
        </span>
      )
    }
    return (
      <span
        className="model-strip-meta"
        title={`Cache fail (fallback inline systemInstruction): ${cacheStatus.message}`}
      >
        · cache: tắt (fallback inline){hitSuffix}
      </span>
    )
  }

  const displayTitle = title?.trim() || 'Salon — chat AI'
  const initials =
    displayTitle
      .replace(/[—–-]/g, ' ')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'AI'

  const headerStatus =
    isGemini && !serverHealthChecked && !geminiReady
      ? { className: 'status-dot idle', label: 'Đang kiểm tra server' }
      : missingKey
        ? { className: 'status-dot warn', label: 'Thiếu API key' }
        : loading
      ? { className: 'status-dot', label: 'Đang phản hồi' }
      : awaitingCustomer
        ? { className: 'status-dot warn', label: 'Chờ 15 giây' }
        : { className: 'status-dot', label: 'Sẵn sàng' }

  return (
    <div className="legacy-chatbot app">
      <header className="header">
        <div className="header-logo" aria-hidden="true">
          {initials}
        </div>
        <div className="header-body">
          <h1>{displayTitle}</h1>
          <p className="header-sub">
            <span className={headerStatus.className}>{headerStatus.label}</span>
            <span>
              Provider <code>{isGemini ? 'gemini' : 'openai'}</code>
              {isGemini && serverGeminiBackend ? (
                <>
                  {' '}
                  · backend <code>{serverGeminiBackend}</code>
                </>
              ) : null}
            </span>
            <span>
              · model <code>{model}</code>
            </span>
            <span>
              · ngữ cảnh <code>CONTEXT.md</code>
            </span>
          </p>
        </div>
      </header>

      {missingKey && (
        <div className="banner error">
          {isGemini ? (
            geminiProxyInjectsKey || serverGeminiBackend === 'vertex' ? (
              <>
                Server chưa sẵn sàng backend Gemini ({serverGeminiBackend ?? 'developer'}). Kiểm tra biến môi trường
                trên Cloud Run rồi deploy lại.
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
          clearBrowserSharedContextCache()
          setContextBanner({
            level: 'ok',
            message: `Đã lưu CONTEXT (data/ + public/CONTEXT.md). Inbox AI & Training dùng chung bản này; cache Gemini server đã làm mới.`,
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

      <div className="chat" ref={chatScrollRef} aria-busy={loading}>
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="28"
                height="28"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12a8 8 0 0 1-11.8 7l-4.7 1 1-4.7A8 8 0 1 1 21 12z" />
              </svg>
            </div>
            <p className="empty-title">
              {missingKey ? 'Cần thêm API key để bắt đầu' : 'Sẵn sàng tư vấn khách salon'}
            </p>
            <p className="empty-sub">
              {missingKey
                ? 'Dán API key vào file .env rồi khởi động lại Vite.'
                : 'Nhập tin nhắn hoặc đính kèm ảnh/video — AI trả lời từng câu, có gửi ảnh mẫu nếu phù hợp.'}
            </p>
          </div>
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
              text={m.displayText ?? m.text}
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
      </div>

      <div className="composer">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
          multiple
          hidden
          onChange={(e) => void onPickImages(e)}
        />
        <button
          type="button"
          className="secondary attach"
          disabled={missingKey || pendingImages.length >= MAX_CHAT_IMAGES}
          onClick={() => imageInputRef.current?.click()}
          aria-label="Đính kèm ảnh hoặc video"
          title="Đính kèm ảnh hoặc video"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <circle cx="8.5" cy="10" r="1.5" />
            <path d="M21 16l-5-5-9 9" />
          </svg>
        </button>
        <textarea
          rows={2}
          placeholder="Nhập tin nhắn hoặc đính kèm ảnh/video (tóc, màu, kiểu mẫu)…  ⏎ để gửi · Shift+⏎ xuống dòng"
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
          <span>{loading ? 'Đang trả lời…' : awaitingCustomer ? 'Chờ 15s…' : 'Gửi'}</span>
          {!loading && !awaitingCustomer && (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14" />
              <path d="m13 6 6 6-6 6" />
            </svg>
          )}
        </button>
      </div>
      {waitModeEnabled && awaitingCustomer && !loading && (
        <p className="composer-hint">Khách im 15 giây thì AI đọc toàn bộ tin và trả lời một lần.</p>
      )}
      {attachError && <p className="attach-error">{attachError}</p>}
      {pendingImages.length > 0 && (
        <div className="pending-images">
          {pendingImages.map((image, idx) => (
            <div key={`pending-${idx}`} className="pending-image">
              {image.mimeType.startsWith('video/') ? (
                <video src={image.dataUrl} controls playsInline preload="metadata">
                  Video đính kèm {idx + 1}
                </video>
              ) : (
                <img src={image.dataUrl} alt={`Ảnh đính kèm ${idx + 1}`} />
              )}
              <button
                type="button"
                className="secondary pending-image-remove"
                onClick={() => removePendingImage(idx)}
                aria-label={`Xóa file ${idx + 1}`}
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
