import { useEffect, useMemo, useState, type ReactNode } from 'react'

const DEFAULT_PART_GAP_MS = 1000

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|svg|avif|bmp)(?:\?[^\s)]*)?$/i
const IMAGE_URL_RE =
  /(https?:\/\/[^\s)<>"']+\.(?:jpe?g|png|gif|webp|svg|avif|bmp)(?:\?[^\s)<>"']*)?|(?:\.\.?\/)?images\/samples\/[^\s)<>"']+\.(?:jpe?g|png|gif|webp|svg|avif|bmp)(?:\?[^\s)<>"']*)?)/gi
const LABEL_LINE_RE = /^Ảnh mẫu\s+(.+?)\s*[:：]\s*$/i

type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'image-group'; urls: string[]; label?: string }

function isImageUrl(line: string): boolean {
  if (!line) return false
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^https?:\/\//i.test(trimmed) && IMAGE_EXT_RE.test(trimmed)) return true
  if (/^(?:\.\.?\/)?images\/samples\//i.test(trimmed) && IMAGE_EXT_RE.test(trimmed)) return true
  return false
}

function normalizeImageHref(raw: string): string {
  const v = raw.trim()
  if (/^https?:\/\//i.test(v)) return v
  if (v.startsWith('/')) return v
  if (v.startsWith('./')) return `/${v.slice(2)}`
  return `/${v}`
}

/**
 * Tokenize 1 đoạn text từ model thành segments hiển thị:
 *  - mỗi dòng text → 1 bubble text riêng (giữ hành vi cũ),
 *  - chuỗi dòng URL ảnh liên tiếp → gộp thành 1 gallery,
 *  - dòng "Ảnh mẫu xxx:" ngay trước URL → trở thành label gallery.
 *  - URL ảnh nhúng trong câu text vẫn được render thành ảnh kèm dưới câu.
 */
function tokenizeReply(text: string): Segment[] {
  if (text.startsWith('[Lỗi API]')) return [{ kind: 'text', value: text }]

  const rawLines = text.split(/\r?\n/)
  const segments: Segment[] = []
  let buffer: string[] = []
  let pendingLabel: string | undefined

  const flushImages = () => {
    if (buffer.length) {
      segments.push({ kind: 'image-group', urls: buffer, label: pendingLabel })
      buffer = []
      pendingLabel = undefined
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trimEnd()
    if (!line.trim()) continue

    if (isImageUrl(line)) {
      buffer.push(line.trim())
      continue
    }

    const labelMatch = line.match(LABEL_LINE_RE)
    const nextLine = (rawLines[i + 1] ?? '').trim()
    if (labelMatch && isImageUrl(nextLine)) {
      flushImages()
      pendingLabel = labelMatch[1].trim()
      continue
    }

    // Inline-URLs trong cùng 1 dòng text → tách phần text, gallery đi theo sau.
    const inlineUrls = Array.from(new Set(line.match(IMAGE_URL_RE) ?? []))
    if (inlineUrls.length) {
      flushImages()
      let cleanText = line
      for (const url of inlineUrls) cleanText = cleanText.split(url).join('')
      cleanText = cleanText.replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim()
      if (cleanText) segments.push({ kind: 'text', value: cleanText })
      segments.push({ kind: 'image-group', urls: inlineUrls })
      continue
    }

    flushImages()
    segments.push({ kind: 'text', value: line })
  }
  flushImages()

  return segments.length ? segments : [{ kind: 'text', value: text }]
}

function BubbleGallery({ urls, label }: { urls: string[]; label?: string }) {
  const single = urls.length === 1
  return (
    <div>
      {label && <span className="bubble-gallery-label">{label}</span>}
      <div className={`bubble-gallery${single ? ' single' : ''}`}>
        {urls.map((url, idx) => {
          const href = normalizeImageHref(url)
          return (
            <a
              key={`${href}-${idx}`}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="bubble-image"
              title={label ? `${label} ${idx + 1}` : `Ảnh ${idx + 1}`}
            >
              <img
                src={href}
                alt={label ? `${label} ${idx + 1}` : `Ảnh ${idx + 1}`}
                loading="lazy"
                className="bubble-image-img"
                onError={(event) => {
                  const img = event.currentTarget
                  img.style.display = 'none'
                  const fallback = img.nextElementSibling as HTMLElement | null
                  if (fallback) fallback.style.display = 'grid'
                }}
              />
              <span className="bubble-image-fallback" style={{ display: 'none' }}>
                {href}
              </span>
            </a>
          )
        })}
      </div>
    </div>
  )
}

type Props = {
  messageKey: string
  text: string
  partGapMs?: number
  usageLine?: ReactNode
}

export function ModelMessageBubbles({
  messageKey,
  text,
  partGapMs = DEFAULT_PART_GAP_MS,
  usageLine,
}: Props) {
  const segments = useMemo(() => tokenizeReply(text), [text])
  const [visibleCount, setVisibleCount] = useState(0)

  useEffect(() => {
    setVisibleCount(segments.length ? 1 : 0)
    if (segments.length <= 1) return

    const timers: number[] = []
    for (let next = 2; next <= segments.length; next++) {
      timers.push(
        window.setTimeout(() => {
          setVisibleCount(next)
        }, (next - 1) * partGapMs),
      )
    }

    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [messageKey, segments, partGapMs])

  useEffect(() => {
    if (visibleCount <= 0) return
    const el = document.querySelector(`[data-model-part="${messageKey}-${visibleCount - 1}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messageKey, visibleCount])

  return (
    <>
      {segments.slice(0, visibleCount).map((segment, j) => (
        <div
          key={`${messageKey}-${j}`}
          data-model-part={`${messageKey}-${j}`}
          className="msg model"
        >
          {j === 0 && (
            <div className="role">
              AI
              {usageLine}
            </div>
          )}
          {segment.kind === 'text' ? (
            segment.value
          ) : (
            <BubbleGallery urls={segment.urls} label={segment.label} />
          )}
        </div>
      ))}
    </>
  )
}
