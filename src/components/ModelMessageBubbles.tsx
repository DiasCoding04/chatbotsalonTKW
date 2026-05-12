import { useEffect, useMemo, useState, type ReactNode } from 'react'

const DEFAULT_PART_GAP_MS = 1000

function splitAiReplyForDisplay(text: string): string[] {
  if (text.startsWith('[Lỗi API]')) return [text]
  const lines = text.split(/\r?\n/).map((s) => s.trimEnd())
  const chunks = lines.filter((s) => s.length > 0)
  return chunks.length ? chunks : [text]
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
  const parts = useMemo(() => splitAiReplyForDisplay(text), [text])
  const [visibleCount, setVisibleCount] = useState(0)

  useEffect(() => {
    setVisibleCount(parts.length ? 1 : 0)
    if (parts.length <= 1) return

    const timers: number[] = []
    for (let next = 2; next <= parts.length; next++) {
      timers.push(
        window.setTimeout(() => {
          setVisibleCount(next)
        }, (next - 1) * partGapMs),
      )
    }

    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [messageKey, parts, partGapMs])

  useEffect(() => {
    if (visibleCount <= 0) return
    const el = document.querySelector(`[data-model-part="${messageKey}-${visibleCount - 1}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messageKey, visibleCount])

  return parts.slice(0, visibleCount).map((part, j) => (
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
      {part}
    </div>
  ))
}
